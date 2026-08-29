#!/usr/bin/env python3
# ==============================================================================
# Clear a stalled download, because leaving it is worse than deleting it
# ------------------------------------------------------------------------------
# RUN BY HAND, from the workstation or the server. Deliberately NOT on a timer -
# see the refusal below.
#
# THE THING IT FIXES IS SILENT AND BLOCKING. A queue item that has stopped
# moving still reads `downloading`, so every signal stays green - and every
# alternative release for that item is refused with "Quality for release in
# queue already meets cutoff". The symptom is "this cannot be found", arriving
# from the one place that already has it. bin/search-missing.py names them
# (`STALLED ...`) and agents of that check warn hourly; nothing acted.
#
# Measured on 2026-08-29: ten Sex and the City S03 episodes, one release group,
# all "stalled with no connections", all between 225 and 243 hours old. Ten
# episodes that could not be found for ten days because they had already been
# found.
#
# --------------------------------------------------------------------------
# THREE THINGS IT DOES, AND EACH ONE IS A SEPARATE DECISION
# --------------------------------------------------------------------------
#
#   1. REMOVE FROM THE CLIENT, which deletes a partial download. That is why
#      bin/search-missing.py reports and never acts, and why this refuses
#      without --commit: the bytes are gone and no undo exists. It is a cheap
#      loss - a stalled torrent has no seeders, so the partial is not going to
#      finish and is not seeding anything either - but it is still a deletion,
#      and this repository does not do deletions on a timer.
#
#   2. BLOCKLIST THE RELEASE, which is the half that stops it coming back. A
#      removal on its own leaves the same dead release as the best candidate,
#      so the next search grabs it again and the queue is stalled by morning.
#      With the release blocklisted, the *arr picks the next candidate instead.
#      This is the one flag whose absence turns the whole job into a loop.
#
#   3. LET IT SEARCH AGAIN, which is `skipRedownload=false` - the API's own
#      default, restated here because it is the difference between "the queue
#      is clean" and "the episode is on its way". Nothing is passed to a search
#      endpoint; the *arr does it as part of the removal.
#
# --------------------------------------------------------------------------
# WHY IT IS NOT AUTOMATIC
# --------------------------------------------------------------------------
# STALL_HOURS IS A HEURISTIC AND DELETION IS NOT REVERSIBLE. A 30 GB remux on a
# slow swarm can sit for a day looking exactly like a dead one, and the API's
# own `trackedDownloadStatus` is what separates them - which is a judgement the
# *arr made, not a measurement. Getting that wrong on a timer deletes a download
# that would have finished. Getting it wrong by hand costs one re-grab.
#
# The same argument as bin/reboot-host.sh: the dangerous operation gets a script
# so it is done the same way every time, not so it is done unattended.
#
# stdlib only, and the credential goes in on stdin - both for the reasons
# bin/search-missing.py records, which this is a sibling of rather than a
# rewrite. Its `api()` is POST-or-GET; a queue removal is a DELETE with query
# parameters, which is why the call below is its own.
# ==============================================================================

import argparse
import calendar
import json
import os
import subprocess
import sys
import time

REPO = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
ENV_FILE = os.path.join(REPO, ".env")

# (container, port, key variable, the queue query), so one loop covers both.
#
# THE QUERY IS PER APP BECAUSE THE EXPANSIONS ARE. `includeEpisode` is what puts
# S03E04 on the line, and it is the only thing that tells ten queue entries for
# one series apart - the first version of this asked for `includeSeries` on both
# and printed "Sex and the City" ten times, which is a list nobody can act on.
APPS = (
    ("radarr", 7878, "RADARR_API_KEY", "queue?pageSize=200&includeMovie=true"),
    ("sonarr", 8989, "SONARR_API_KEY",
     "queue?pageSize=200&includeSeries=true&includeEpisode=true"),
)

# How long an item may sit before it is called stalled rather than slow. The
# same number bin/search-missing.py grades on, restated rather than imported:
# these are stdlib-only scripts with no shared module between them, which is the
# convention every other bin/*.py here already follows.
STALL_HOURS = 24


class ArrError(RuntimeError):
    """The application could not be reached or refused. Never a verdict."""


def load_env():
    """The .env, read directly so this works from an interactive shell too."""
    env = {}
    try:
        with open(ENV_FILE, encoding="utf-8") as fh:
            for line in fh:
                line = line.strip()
                if line and not line.startswith("#") and "=" in line:
                    key, _, value = line.partition("=")
                    env[key.strip()] = value.strip().strip('"').strip("'")
    except OSError:
        pass
    return env


def api(container, port, key, path, method=None, timeout=90):
    """A call to an *arr API from inside its own container.

    THE CREDENTIAL GOES IN ON STDIN, NOT ARGV. `curl -K -` reads its whole
    configuration from stdin, so the API key never reaches the host's process
    list - which `podman exec ... -H "X-Api-Key: ..."` cannot avoid.

    AN EMPTY BODY IS NOT AN ERROR HERE, unlike in search-missing.py. A DELETE on
    the queue answers 200 with no content, so "did not return JSON" would be the
    reported outcome of every successful removal.
    """
    config = ['url = "http://localhost:%d/api/v3/%s"' % (port, path),
              'header = "X-Api-Key: %s"' % key,
              "silent", "show-error", "fail", "max-time = 60"]
    if method:
        config.append('request = "%s"' % method)
    try:
        res = subprocess.run(
            ["podman", "exec", "-i", container, "curl", "-K", "-"],
            input="\n".join(config) + "\n", capture_output=True,
            text=True, timeout=timeout, check=False)
    except (OSError, subprocess.SubprocessError) as exc:
        raise ArrError("could not exec into %s: %s" % (container, exc))
    if res.returncode != 0:
        raise ArrError("%s %s failed (exit %d) %s"
                       % (container, path, res.returncode,
                          (res.stderr or "").strip()))
    body = (res.stdout or "").strip()
    if not body:
        return None
    try:
        return json.loads(body)
    except json.JSONDecodeError:
        raise ArrError("%s %s did not return JSON" % (container, path))


def epoch(stamp):
    """An ISO-8601 timestamp from an *arr API, as epoch seconds, or None.

    calendar.timegm, NOT time.mktime, for the reason search-missing.py records:
    mktime reads the struct as LOCAL time and applies a DST correction, which is
    an hour out for half the year.
    """
    if not stamp or not isinstance(stamp, str) or len(stamp) < 19:
        return None
    try:
        return calendar.timegm(time.strptime(stamp[:19], "%Y-%m-%dT%H:%M:%S"))
    except (ValueError, OverflowError):
        return None


def stalled(queue, now, hours):
    """Queue entries that have stopped moving, as dicts this script can act on.

    THE SAME PREDICATE bin/search-missing.py REPORTS ON, so what this clears is
    exactly what that names and what search.stalled_queue counts. Two rules for
    "stopped" rather than one: the *arr's own `trackedDownloadStatus`, which is
    its judgement, or the word `stall` in a message, which is the download
    client's. Either alone misses cases the other catches.
    """
    found = []
    for row in queue:
        added = epoch(row.get("added"))
        if added is None or now - added < hours * 3600:
            continue
        messages = [row.get("errorMessage") or ""]
        for block in row.get("statusMessages") or []:
            messages.extend(block.get("messages") or [])
        reason = next((m for m in messages if m), "")
        warned = row.get("trackedDownloadStatus") in ("warning", "error")
        if not warned and "stall" not in reason.lower():
            continue
        # WHAT IDENTIFIES A QUEUE ENTRY IS THE RELEASE, NOT THE SERIES. Ten
        # entries can share one series and one movie can be queued twice; the
        # release name is the only field unique to the row, and it is also what
        # `blocklist=true` is about to act on. The series or film is prefixed
        # only when the API expanded it, because that is the half a person
        # recognises.
        owner = (row.get("movie") or {}).get("title") \
            or (row.get("series") or {}).get("title") or ""
        ep = row.get("episode") or {}
        if ep.get("seasonNumber") is not None:
            owner = "%s S%02dE%02d" % (owner, ep.get("seasonNumber") or 0,
                                       ep.get("episodeNumber") or 0)
        release = row.get("title") or ""
        found.append({
            "id": row.get("id"),
            "title": (owner.strip() or release or "?"),
            "release": release,
            "hours": (now - added) / 3600.0,
            "reason": reason or row.get("trackedDownloadStatus", ""),
            "size": row.get("size") or 0,
            "left": row.get("sizeleft") or 0,
        })
    return found


def clear(container, port, key, item):
    """Remove one stalled item, blocklist its release, and let it search again.

    THE THREE PARAMETERS ARE THE THREE DECISIONS at the top of this file, and
    they are passed explicitly rather than left to the API's defaults - the
    defaults are right today and this is not the file to discover it if they
    change.
    """
    api(container, port, key,
        "queue/%d?removeFromClient=true&blocklist=true&skipRedownload=false"
        % int(item["id"]),
        method="DELETE")


def main():
    parser = argparse.ArgumentParser(
        description="Remove downloads that have stopped moving, blocklist the "
                    "release so the same dead one is not grabbed again, and "
                    "let the application search for a replacement.")
    # NO --dry-run FLAG, BECAUSE REPORTING IS THE DEFAULT. A destructive script
    # whose safe mode is a flag is one typo from a deletion; this one needs a
    # word typed to do anything at all, which is bin/reboot-host.sh's shape.
    parser.add_argument("--commit", action="store_true",
                        help="actually remove them. Without this, nothing is "
                             "changed and the queue is only reported")
    parser.add_argument("--hours", type=float, default=STALL_HOURS,
                        help="how long an item may sit before it counts as "
                             "stalled (default %d)" % STALL_HOURS)
    parser.add_argument("--yes", action="store_true",
                        help="skip the typed confirmation. For a caller that "
                             "has already shown a person the list")
    args = parser.parse_args()

    now = int(time.time())
    env = load_env()

    plan = []
    for container, port, var, _kind in APPS:
        key = env.get(var, "")
        if not key:
            print("clear-stalled: %s is not set in %s" % (var, ENV_FILE),
                  file=sys.stderr)
            return 1
        try:
            queue = api(container, port, key, "queue?pageSize=200"
                        "&includeMovie=true&includeSeries=true")
        except ArrError as exc:
            print("clear-stalled: %s" % exc, file=sys.stderr)
            return 1
        records = (queue or {}).get("records") or []
        for item in stalled(records, now, args.hours):
            plan.append((container, port, key, item))

    if not plan:
        print("nothing stalled past %gh" % args.hours)
        return 0

    for container, _port, _key, item in plan:
        done = item["size"] - item["left"]
        pct = (100.0 * done / item["size"]) if item["size"] else 0.0
        # ONE DECIMAL, AND IT NEVER ROUNDS UP TO 100. `%.0f` printed a download
        # stalled at 99.8% as "100%", which reads as a COMPLETED file waiting on
        # import rather than a dead swarm one piece short - and those want
        # opposite decisions. A percentage that rounds across the one boundary
        # that changes the answer is worse than no percentage.
        if pct >= 99.95 and item["left"] > 0:
            pct = 99.9
        print("%-7s %-7s %-26s %5.0fh %5.1f%% of %5.1f GB  %s"
              % ("WOULD" if not args.commit else "clear", container,
                 item["title"][:26], item["hours"], pct,
                 item["size"] / 1e9, item["reason"][:44]))
        print("        %s" % item["release"][:100])

    if not args.commit:
        print("\n%d stalled item(s). Nothing was changed - pass --commit to "
              "remove them.\nEach removal DELETES the partial download and "
              "blocklists that release." % len(plan))
        return 0

    # THE TYPED CONFIRMATION, and it names the count so a stale terminal cannot
    # be answered from muscle memory. The same reason bin/reboot-host.sh asks.
    if not args.yes and sys.stdin.isatty():
        want = "clear %d" % len(plan)
        got = input("\nThis deletes %d partial download(s). Type %r to go "
                    "ahead: " % (len(plan), want))
        if got.strip() != want:
            print("nothing was changed")
            return 1

    failed = 0
    for container, port, key, item in plan:
        try:
            clear(container, port, key, item)
            print("cleared %s: %s" % (container, item["title"][:64]))
        except ArrError as exc:
            failed += 1
            print("FAILED  %s: %s - %s" % (container, item["title"][:48], exc),
                  file=sys.stderr)

    # SEARCHING IS THE APPLICATION'S JOB AND IT HAS ALREADY BEEN ASKED.
    # skipRedownload=false makes the removal itself trigger the search, so a
    # second command here would be a duplicate query against every indexer -
    # which is the load bin/search-missing.py's whole fourth refusal exists to
    # avoid.
    print("\n%d cleared, %d failed. Each one blocklisted its release and the "
          "application is searching for a replacement." % (len(plan) - failed, failed))
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main())
