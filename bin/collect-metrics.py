#!/usr/bin/env python3
# ==============================================================================
# The numbers no container can honestly measure about this host
# ------------------------------------------------------------------------------
# RUNS ON THE SERVER, from a systemd user timer. See host/systemd/.
#
# Prometheus PULLS and has no push endpoint, so this writes Prometheus exposition
# format into node-exporter's textfile directory and node-exporter serves it as
# part of its own scrape. That is the standard mechanism for exactly this, and it
# pays for itself twice: node_textfile_mtime_seconds dates the file, so a stopped
# collector is visible from OUTSIDE the collector, and node_textfile_scrape_error
# flags a malformed one. Neither is something this script could honestly assert
# about itself - see bin/verify-host.sh's note on why a check cannot grade its
# own liveness.
#
# WHY ANY OF THIS IS HERE RATHER THAN IN AN EXPORTER. Three separate reasons,
# each measured rather than assumed:
#
#   node_filesystem_*   NO ROOTLESS CONTAINER CAN PRODUCE IT. node-exporter reads
#                       /proc/1/mountinfo for the host mount table, and reading
#                       another user's /proc entry must pass ptrace_may_access:
#                       host PID 1 is real root, and rootless podman maps
#                       container uid 0 to core. It failed EACCES on every
#                       scrape. On the host a plain statvfs answers.
#   node_network_*      /proc/net is a symlink to self/net, so it resolves in the
#                       READER's network namespace. A bridge-networked
#                       node-exporter reports its own container's interfaces
#                       while looking exactly like it reports the host's.
#                       Network=host would fix it and cost more - it reaches the
#                       host through pasta at 169.254.1.2, which bypasses
#                       firewalld, so every container could then read host
#                       telemetry.
#   home_server_container_memory_*
#                       cAdvisor exports memory.current and stops. CLAUDE.md
#                       spends twenty lines establishing that memory.current and
#                       memory.events high are MISLEADING here - Jellyfin sits at
#                       its 3G MemoryHigh with 0.385G anon, 2.338G cold page
#                       cache and zero stall - and names the five numbers that
#                       settle it. Four of them have no cAdvisor metric at all.
#
# THE NAMING RULE, because half of what follows is somebody else's name and half
# is ours. An upstream name is adopted ONLY where the semantics match exactly -
# same quantity, same unit, same reset behaviour - so that this implementation
# can be replaced without touching a dashboard. Where they only almost match, a
# home_server_* name is minted instead: a wrong number under a right name is
# undetectable from a dashboard, while a right number under an unfamiliar name
# is merely inconvenient. The sharpest case is memory.high, which cAdvisor would
# have called container_spec_memory_reservation_limit_bytes and which means
# memory.low there - see the note at that metric.
#
# A DIAGNOSTIC MUST NEVER BREAK THE THING IT ANNOTATES. Every source is called
# inside its own try/except with a subprocess timeout; one that fails drops its
# own series, records itself in home_server_collector_source_up, and changes
# nothing else. The file is written atomically, so a reader never sees half of
# one. This script writes nowhere except that file and its own marker.
#
# Usage:
#   bin/collect-metrics.py            collect and write   (what the timer runs)
#   bin/collect-metrics.py --print    collect, print to stdout, write nothing
#   bin/collect-metrics.py --slow     force the 5-minute tier this run
#   bin/collect-metrics.py --source smart        one source only, tier ignored
# ==============================================================================

import calendar
import glob
import json
import os
import re
import sqlite3
import subprocess
import sys
import time
import urllib.request
from urllib.parse import urlparse

CACHE = os.environ.get("DOCKER_VOLUME_CACHE", "/var/home-server/cache")
TEXTFILE = os.path.join(CACHE, "textfile", "home-server.prom")
TEXTFILE_SLOW = os.path.join(CACHE, "textfile", "home-server-slow.prom")
MARKER = os.path.expanduser("~/.cache/home-server/metrics-state")

# THE TWO DOCUMENTS, AND WHY THEY ARE NOT SERIES.
#
# The dashboard's Home and Library pages need titles: what is playing, who
# asked for what, which file is stuck. None of that can be a Prometheus label.
# Cardinality is the obvious reason and it is the lesser one - the real one is
# that source_playback below deliberately refuses to label a session with the
# user, the device or the item, because a 400-day series of who watched what is
# surveillance of the household rather than monitoring of a machine.
#
# A document is a different object from a series and that difference is the
# whole argument: it is rewritten whole on every run, nothing accumulates, and
# there is no history to mine. It answers "what is happening" and cannot answer
# "what happened in March". Keep it that way - the moment any of this grows a
# retention window, the refusal above has been reversed by accident.
#
# Split by CADENCE, not by page, for the reason TEXTFILE_SLOW already records: a
# five-minute slice living in a thirty-second file would blink out nine ticks in
# ten. So the split follows rate of change - a progress bar goes in the fast
# one, a request queue in the slow one - and each carries its own generated_at
# so the two go stale independently and the UI can say which one did.
DOC_DIR = os.path.join(CACHE, "dashboard")
DOC_ACTIVITY = os.path.join(DOC_DIR, "activity.json")
DOC_LIBRARY = os.path.join(DOC_DIR, "library.json")

# THE THIRD DOCUMENT, AND IT IS HERE FOR THE SAME REASON AS THE OTHER TWO.
#
# The agent fleet has 41 series and not one of them can say WHICH task is in
# flight, which round it is on, or whether a pull request has been sitting on a
# person's approval since last night. A task title, a branch name and a
# Windmill job id are exactly the forbidden label family - unbounded, and
# retained for 400 days by a store that has no business keeping them.
#
# So it travels as a document: rewritten whole every five minutes, no history
# anywhere, and the numbers worth keeping stay as the counts the agent source
# already emits. COST TRAVELS HERE AND NOWHERE ELSE - docs/observability.md
# records "there is no dollar metric and no daily spend ceiling, deliberately",
# and that refusal is unchanged: home_server_agent_quota_status is still the
# pacing signal, and a document reporting what a round cost cannot become a
# second currency because it cannot be graphed over time.
DOC_FLEET = os.path.join(DOC_DIR, "fleet.json")
# The control switch alone, rewritten every 30s - see source_control.
DOC_CONTROL = os.path.join(DOC_DIR, "control.json")
DOC_SCHEMA = 1

# conduct's own state, read-only. The default matches conduct/config.py's
# STATE_DB, which derives it from DOCKER_VOLUME_CONFIG the same way.
CONFIG_ROOT = os.environ.get("DOCKER_VOLUME_CONFIG", "/var/home-server/config")
CONDUCT_DB = os.environ.get("CONDUCT_STATE_DB",
                            os.path.join(CONFIG_ROOT, "conduct", "conduct.db"))

# How many not-yet-available requests get a title resolved per slow run. Each
# one costs a separate call to jellyseerr's TMDB proxy, and the Requests panel
# shows a handful - so the cap is the panel's depth plus headroom, NOT the 104
# requests this host has. Named and logged rather than silent, because a cap
# nobody can see reads as "that is all there is".
REQUEST_TITLE_BUDGET = 12

# The library tree, at the three prefixes three different processes see it
# under. bin/promote-transcoded.py documents this at length; the collector needs
# the same mapping to join a Tdarr row to an *arr record to a path on disk.
MEDIA_HOST = "/mnt/media/library"
MEDIA_ARR = "/data/library"
MEDIA_TDARR = "/media/library"
MEDIA_TYPES = ("movies", "documentaries", "series", "anime")

# The cgroup root the user manager delegates. `io` is NOT delegated by default -
# `cpu memory pids` are - and an undelegated controller is accepted silently and
# does nothing, which is why host/butane/ucore.bu ships the drop-in. If this path
# is wrong every container source returns nothing rather than wrong numbers.
#
# This is the ROOT, no longer the whole answer: a unit carrying `Slice=` lands in
# a child of it. _unit_cgroup below is what resolves that, and host/systemd/
# app-agents.slice is the one that exists today.
CGROUP = ("/sys/fs/cgroup/user.slice/user-%d.slice/user@%d.service/app.slice"
          % (os.getuid(), os.getuid()))

# An ALLOWLIST, not an exclusion regex, and that is the whole point: rootless
# podman creates dozens of overlay mounts under ~/.local/share/containers, and a
# regex fails OPEN when something new appears. This fails closed. /mnt and /home
# are symlinks into /var on CoreOS, so the canonical kernel paths are used - the
# same reason the mount unit is var-mnt-media.mount.
#
# `/` IS DELIBERATELY ABSENT. It is the read-only composefs: 8 MB, 0 bytes free,
# 100% full by design and for ever. A panel showing the root filesystem full
# would read as an emergency and mean nothing, which is worse than showing
# nothing - and statvfs on it returns -1 for the inode counts, so it emits
# negative gauges as well. The three filesystems below are the ones that can
# actually fill up.
FILESYSTEMS = ("/boot", "/var", "/var/mnt/media")


def now():
    return time.time()


def read_text(path):
    with open(path, "r", encoding="utf-8", errors="replace") as fh:
        return fh.read()


def read_kv(path):
    """A cgroup 'key value' file as a dict of ints. Missing file -> {}."""
    out = {}
    try:
        for line in read_text(path).splitlines():
            parts = line.split()
            if len(parts) == 2:
                try:
                    out[parts[0]] = int(parts[1])
                except ValueError:
                    pass
    except OSError:
        pass
    return out


def read_int(path):
    """A single-value cgroup file. 'max' and a missing file both -> None."""
    try:
        raw = read_text(path).strip()
    except OSError:
        return None
    if raw in ("", "max"):
        return None
    try:
        return int(raw)
    except ValueError:
        return None


def read_pressure(path):
    """PSI totals in seconds, as {'some': float, 'full': float}.

    The total= field is a monotonic microsecond counter and is the only part
    worth exporting. avg10/avg60/avg300 are already averaged over a window the
    query cannot change, so exporting them would bake that window into the
    schema for ever - rate() over the counter is strictly more useful.
    """
    out = {}
    try:
        for line in read_text(path).splitlines():
            parts = line.split()
            if not parts:
                continue
            for field in parts[1:]:
                if field.startswith("total="):
                    try:
                        out[parts[0]] = int(field[6:]) / 1e6
                    except ValueError:
                        pass
    except OSError:
        pass
    return out


def run(argv, timeout=10):
    """Capture stdout, or None. Never raises, never blocks for ever."""
    try:
        res = subprocess.run(argv, capture_output=True, text=True,
                             timeout=timeout, check=False)
    except (OSError, subprocess.SubprocessError):
        return None
    if res.returncode != 0:
        return None
    return res.stdout


class Metrics:
    """An exposition-format accumulator.

    HELP and TYPE are emitted once per metric name, on first use, so the file
    stays valid for anything that consumes it - including a future exporter that
    serves it verbatim rather than through the textfile collector.
    """

    def __init__(self):
        self.lines = []
        self.declared = set()
        self.count = 0

    def add(self, name, value, labels=None, help_text="", kind="gauge"):
        if value is None:
            return
        if name not in self.declared:
            self.declared.add(name)
            if help_text:
                self.lines.append("# HELP %s %s" % (name, help_text))
            self.lines.append("# TYPE %s %s" % (name, kind))
        if labels:
            rendered = ",".join(
                '%s="%s"' % (k, str(v).replace("\\", "\\\\")
                             .replace('"', '\\"').replace("\n", " "))
                for k, v in sorted(labels.items()))
            self.lines.append("%s{%s} %s" % (name, rendered, value))
        else:
            self.lines.append("%s %s" % (name, value))
        self.count += 1

    def render(self):
        return "\n".join(self.lines) + "\n"


class Document:
    """A JSON document accumulator, with a per-upstream answered/did-not record.

    `sources` IS NOT OPTIONAL and it is the only reason this class exists rather
    than a plain dict. Without it, "jellyseerr timed out" and "there are no
    pending requests" are the same bytes - an empty list either way - and a page
    rendering that as "nothing to approve" is the exact failure this repository
    is written around. It is `mode.routes: false` applied to applications:
    absent must never read as zero.

    Nullable values are written as null and never omitted, so a key cannot
    appear and disappear between runs and force a reader to guess which case it
    is in. Same contract as verify-host.sh's `facts`.
    """

    def __init__(self):
        self.body = {}
        self.sources = {}

    def note(self, name, ok, error=None):
        """Record that an upstream did or did not answer this run."""
        self.sources[name] = {
            "ok": bool(ok),
            "at": iso(now()) if ok else None,
            "error": None if ok else (error or "did not answer"),
        }

    def set(self, key, value):
        self.body[key] = value

    def append(self, key, value):
        self.body.setdefault(key, []).append(value)

    def render(self, started):
        doc = {"schema": DOC_SCHEMA, "generated_at": iso(started)}
        doc.update(self.body)
        doc["sources"] = self.sources
        # sort_keys for a stable diff; ensure_ascii because a title can hold
        # anything and this repository is ASCII end to end - a \uXXXX escape is
        # still ASCII on the wire and decodes correctly in the browser.
        return json.dumps(doc, sort_keys=True, ensure_ascii=True,
                          separators=(",", ":")) + "\n"


def iso(when):
    return time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime(when))


# ------------------------------------------------------------------------------
# Host filesystems
# ------------------------------------------------------------------------------
# node_exporter's names and label set exactly, because the semantics are
# identical - statfs is statfs. That is what makes this replaceable: if a future
# host ever CAN run the filesystem collector, swapping it in is a deployment
# change and not a dashboard rewrite.

def source_filesystems(m):
    mounts = {}
    for line in read_text("/proc/self/mountinfo").splitlines():
        parts = line.split()
        try:
            sep = parts.index("-")
        except ValueError:
            continue
        mountpoint = parts[4].replace("\\040", " ")
        if mountpoint in FILESYSTEMS and mountpoint not in mounts:
            mounts[mountpoint] = (parts[sep + 1], parts[sep + 2])

    for mountpoint in FILESYSTEMS:
        if mountpoint not in mounts:
            # Absent, not zero. A mountpoint that is not mounted must not read
            # as a full disk - and statvfs on the path would cheerfully report
            # the filesystem UNDERNEATH it, which is how /var/mnt/media would
            # come to show 186G free off the NVMe.
            m.add("home_server_filesystem_mounted", 0,
                  {"mountpoint": mountpoint},
                  "1 when the expected mountpoint is actually mounted.")
            continue
        fstype, device = mounts[mountpoint]
        labels = {"device": device, "fstype": fstype, "mountpoint": mountpoint}
        m.add("home_server_filesystem_mounted", 1, {"mountpoint": mountpoint})
        try:
            st = os.statvfs(mountpoint)
        except OSError:
            m.add("node_filesystem_device_error", 1, labels,
                  "1 if an error occurred while getting statistics.")
            continue
        m.add("node_filesystem_device_error", 0, labels)
        m.add("node_filesystem_size_bytes", st.f_blocks * st.f_frsize, labels,
              "Filesystem size in bytes.")
        m.add("node_filesystem_free_bytes", st.f_bfree * st.f_frsize, labels,
              "Filesystem free space in bytes.")
        m.add("node_filesystem_avail_bytes", st.f_bavail * st.f_frsize, labels,
              "Filesystem space available to non-root users in bytes.")
        m.add("node_filesystem_files", st.f_files, labels,
              "Filesystem total file nodes.")
        m.add("node_filesystem_files_free", st.f_ffree, labels,
              "Filesystem total free file nodes.")
        m.add("node_filesystem_readonly", 1 if st.f_flag & os.ST_RDONLY else 0,
              labels, "Filesystem read-only status.")


# ------------------------------------------------------------------------------
# Host network
# ------------------------------------------------------------------------------
# The host has only lo and nic0: every podman bridge lives inside the rootless
# network namespace, not here. veth* is excluded anyway, because netavark
# recreates one per container per network on every restart and
# podman-auto-update restarts everything nightly - a device label would mint
# thousands of dead series a year.

def source_network(m):
    for line in read_text("/proc/net/dev").splitlines()[2:]:
        if ":" not in line:
            continue
        name, rest = line.split(":", 1)
        name = name.strip()
        if name.startswith("veth"):
            continue
        f = rest.split()
        if len(f) < 16:
            continue
        labels = {"device": name}
        for metric, idx, help_text in (
                ("receive_bytes_total", 0, "Network device statistic receive_bytes."),
                ("receive_packets_total", 1, "Network device statistic receive_packets."),
                ("receive_errs_total", 2, "Network device statistic receive_errs."),
                ("receive_drop_total", 3, "Network device statistic receive_drop."),
                ("transmit_bytes_total", 8, "Network device statistic transmit_bytes."),
                ("transmit_packets_total", 9, "Network device statistic transmit_packets."),
                ("transmit_errs_total", 10, "Network device statistic transmit_errs."),
                ("transmit_drop_total", 11, "Network device statistic transmit_drop.")):
            m.add("node_network_" + metric, int(f[idx]), labels, help_text,
                  "counter")
        try:
            state = read_text("/sys/class/net/%s/operstate" % name).strip()
            m.add("node_network_up", 1 if state == "up" else 0, labels,
                  "Value is 1 if operstate is 'up', 0 otherwise.")
        except OSError:
            pass


# ------------------------------------------------------------------------------
# Container network, per segment
# ------------------------------------------------------------------------------
# THE ONE THING HERE THAT CAN BE MEASURED, AND THE ONE THAT CANNOT.
#
# Per-FLOW accounting - how many bytes container A sent container B - is not
# available on this host at all. `nsenter -n` into a rootless netns is EPERM as
# core, and /proc/net/nf_conntrack is root-only, so there is no conntrack view
# of a netavark bridge from here. Nothing in this repository can produce an
# A->B number, and anything that appears to is inferring one.
#
# Per-CONTAINER, per-SEGMENT accounting is available, and cheaply. Rootless
# podman maps container uid 0 to core, so ptrace_may_access passes and every
# container's /proc/<pid>/net/dev is an ordinary file read from the host. That
# is the exact INVERSE of node-exporter's filesystem collector, which cannot
# read /proc/1/mountinfo precisely BECAUSE host PID 1 is real root.
#
# What a reader may conclude depends on how many members the segment has, and
# the dashboard states it rather than leaving it implied: net-egress has one
# member and net-dashboard and net-solver have two, so on those three the
# number IS the edge, direction included. On the other six it is the node's
# total on that segment and the per-peer split is not measured.
#
# The labels are {container, network} and deliberately NOT the interface.
# source_network above explains why: netavark recreates a veth per container
# per network on every restart and auto-update restarts everything nightly, so
# a device label would mint thousands of dead series a year. Container and
# network names change only when stacks/ does.

def _route_subnets(pid):
    """iface -> "a.b.c.d/len" for every directly-connected route in
    /proc/<pid>/net/route.

    THE ADDRESS AND MASK ARE LITTLE-ENDIAN HEX. 000A15AC is 172.21.10.0, not
    0.10.21.172 - reading them big-endian yields a plausible-looking address
    that simply never matches a podman subnet, so the join would come back
    empty and the whole source would look like it had nothing to report.
    """
    out = {}
    try:
        lines = read_text("/proc/%d/net/route" % pid).splitlines()[1:]
    except OSError:
        return out
    for line in lines:
        f = line.split()
        if len(f) < 8:
            continue
        iface, dest, gateway, mask = f[0], f[1], f[2], f[7]
        # A default route names the gateway, not a segment this container is
        # on. Only the on-link routes identify a bridge.
        if gateway != "00000000":
            continue
        try:
            net = int(dest, 16)
            bits = bin(int(mask, 16)).count("1")
        except ValueError:
            continue
        out[iface] = "%d.%d.%d.%d/%d" % (net & 255, (net >> 8) & 255,
                                         (net >> 16) & 255, (net >> 24) & 255,
                                         bits)
    return out


def source_container_network(m):
    raw = run(["podman", "ps", "--format", "json"], timeout=20)
    if raw is None:
        raise RuntimeError("podman ps failed")
    containers = json.loads(raw)

    raw_nets = run(["podman", "network", "ls", "--format", "json"], timeout=20)
    if raw_nets is None:
        raise RuntimeError("podman network ls failed")
    by_subnet = {}
    for net in json.loads(raw_nets):
        for sub in net.get("subnets") or []:
            cidr = sub.get("subnet")
            if cidr:
                by_subnet[cidr] = net.get("name", "")

    pairs = 0
    unmapped = 0
    for c in containers:
        # THE CARDINALITY HALF, and a different bug from the one in
        # source_containers even though the fix looks identical. This source has
        # no unit check at all, so it measures a phase runner and mints two
        # counter series labelled with its name - and that name carries a
        # worktree id. The header above already argues the case against itself:
        # "Container and network names change only when stacks/ does" stops
        # being true the moment conduct runs. Retention is 400 days and
        # metrics.series_count grades HEAD series only, so the churn would
        # accumulate on disk entirely unobserved.
        if _is_ephemeral(c):
            continue
        # A container reporting no networks of its own is a pod member: it
        # shares the infra container's namespace, so its /proc/<pid>/net/dev is
        # literally the SAME counter. Reading all four members would report the
        # pod's traffic four times. podman's own answer is the filter here - no
        # rule in this script decides which containers are in a pod.
        if not (c.get("Networks") or []):
            continue
        pid = c.get("Pid") or 0
        if not pid:
            continue
        container = (c.get("Names") or ["?"])[0]

        subnets = _route_subnets(pid)
        try:
            dev = read_text("/proc/%d/net/dev" % pid)
        except OSError:
            # The container went away between `podman ps` and this read.
            # Emitting nothing is the right answer: a zero here is
            # indistinguishable from an idle link.
            continue

        for line in dev.splitlines()[2:]:
            if ":" not in line:
                continue
            iface, rest = line.split(":", 1)
            iface = iface.strip()
            if iface == "lo":
                continue
            # Join on the subnet, NEVER on the interface index: the names are
            # not in declaration order. caddy is eth0=net-transcode,
            # eth3=net-ingress, eth6=net-media.
            network = by_subnet.get(subnets.get(iface, ""), "")
            if not network:
                # A TUNNEL IS NOT DRIFT, AND DROPPING IT LOSES THE BIGGEST
                # NUMBER ON THE HOST. gluetun's tun0 sits in the torrent pod's
                # namespace carrying 221 MB in and 3.57 GB out - every byte
                # qBittorrent has moved - and it matches no declared subnet
                # because it has no on-link route at all: gluetun steers
                # traffic onto it with firewall marks and policy routing, so
                # the main table's default stays on eth0.
                #
                # tun*/wg* is the kernel's own naming for a tunnel device, not
                # a table of this stack's services, so classifying on it adds
                # no drift surface. It is also the ONLY place the pod's egress
                # is measurable: nothing here can see inside the namespace from
                # the outside.
                if iface.startswith("tun") or iface.startswith("wg"):
                    network = "tunnel"
                else:
                    unmapped += 1
                    continue
            f = rest.split()
            if len(f) < 16:
                continue
            labels = {"container": container, "network": network}
            m.add("home_server_container_network_receive_bytes_total",
                  int(f[0]), labels,
                  "Bytes RECEIVED by this container on this segment. Read from "
                  "inside the container's own namespace, so the direction is "
                  "the container's - reading the host-side veth instead would "
                  "report every one of these inverted while looking identical.",
                  "counter")
            m.add("home_server_container_network_transmit_bytes_total",
                  int(f[8]), labels,
                  "Bytes SENT by this container on this segment. Every "
                  "intra-segment byte therefore appears twice - here and as "
                  "its peer's receive - so halve any sum over a whole segment.",
                  "counter")
            pairs += 1

    # The self-check. A container/network pair that stops being measured is
    # otherwise silent - the series simply stops, which on a counter looks the
    # same as a quiet link until you go looking for it.
    m.add("home_server_container_network_pairs", pairs, None,
          "Container/network pairs measured. Compare against the membership "
          "declared in stacks/: a drop means a container lost an interface or "
          "its /proc entry became unreadable.")
    m.add("home_server_container_network_unmapped_interfaces", unmapped, None,
          "Interfaces whose on-link subnet matched no podman network and which "
          "are not a tunnel. Non-zero means traffic is being dropped on the "
          "floor here - written as an explicit 0 so it can be alerted on, "
          "rather than a series that only exists when something is wrong.")

# ------------------------------------------------------------------------------
# Containers
# ------------------------------------------------------------------------------
# THE JOIN KEY IS PODMAN'S OWN PODMAN_SYSTEMD_UNIT LABEL, never a name derived
# from the container. It is what makes torrent-infra resolve to
# torrent-pod.service without a hand-maintained lookup table - and a table
# maintained in a script is the most driftable thing this repository could own.
# home_server_container_identity_unresolved counts what did not map, because the
# failure would otherwise be silent: a container simply missing from every panel.

# THE ONE CONTAINER CLASS THAT IS NOT A QUADLET. conduct starts its phase
# runners and their datastores with `podman run --rm`, so they carry no
# PODMAN_SYSTEMD_UNIT, they live for minutes, and their names contain a worktree
# id. Every reader in this file was written when a container meant a quadlet.
#
# PRESENCE, NEVER THE VALUE. `--label io.home-server.ephemeral` with no `=1`
# yields "", which a truthiness test reads as "not ephemeral" - so a typo in the
# runner invocation would silently restore both failures below. `podman ps
# --filter label=<key>` matches on presence too, so bin/verify-host.sh and this
# file agree without either restating the rule.
EPHEMERAL_LABEL = "io.home-server.ephemeral"


def _is_ephemeral(c):
    return EPHEMERAL_LABEL in (c.get("Labels") or {})


HEALTH_STATES = {"healthy": 0, "starting": 1, "unhealthy": 2}

# The kernel's PSI vocabulary mapped onto cAdvisor's. They mean the same thing:
# `some` is "at least one task was delayed", `full` is "every runnable task
# was". Anything the kernel adds later is skipped rather than guessed at.
PSI_LEVELS = {"some": "waiting", "full": "stalled"}


# systemd's own view of the quadlet units. UNIT_STATES maps ActiveState onto a
# number the same way HEALTH_STATES does for container health: 0 is the good
# case, and everything else is ordered roughly by how much it wants attention.
UNIT_STATES = {"active": 0, "activating": 1, "failed": 2, "deactivating": 3,
               "inactive": 4, "reloading": 5}

GENERATOR = "/run/user/%d/systemd/generator" % os.getuid()


def source_units(m):
    """Unit-level state, which is the half podman cannot see.

    THIS EXISTS BECAUSE home_server_container_restarts_total IS ALWAYS ZERO.
    That series reads podman's per-container Restarts field, which is reset
    whenever the container is RECREATED - and a quadlet recreates on every
    restart, so the number can only ever climb inside a single container's life
    and a restart loop resets it to 0 each time round. Pocket ID restarted 6,224
    times between 00:20 and 09:55 on 2026-08-19 and that gauge read 0 for the
    whole outage, which made ContainerRestartLoop - the one rule named for
    exactly this failure - unable to fire even in principle.

    systemd's NRestarts is the counter that survives, because the unit outlives
    the containers it creates. It resets on a clean start, which is wanted: the
    question is "is this looping now", not "has it ever looped".

    ENUMERATED FROM THE GENERATOR DIRECTORY, NOT FROM `podman ps`. A container
    that is gone has no podman row, and a container that is gone is precisely
    the case worth reporting - deriving the unit list from running containers
    would make this source blindest at the moment it matters most.
    """
    try:
        names = sorted(f for f in os.listdir(GENERATOR) if f.endswith(".service"))
    except OSError:
        raise RuntimeError("no quadlet generator directory at %s" % GENERATOR)
    if not names:
        raise RuntimeError("no quadlet units in %s" % GENERATOR)

    raw = run(["systemctl", "--user", "show"] + names
              + ["-p", "Id", "-p", "NRestarts", "-p", "ActiveState",
                 "-p", "SubState", "-p", "SourcePath"], timeout=20)
    if raw is None:
        raise RuntimeError("systemctl show failed")

    unhealthy = 0
    for chunk in raw.split("\n\n"):
        rec = dict(line.split("=", 1) for line in chunk.splitlines() if "=" in line)
        unit = rec.get("Id")
        if not unit:
            continue
        # .container and .pod units stay up; .build and .network units are
        # oneshot and are INACTIVE when all is well, so the kind label is what
        # stops a rule reading a healthy network unit as a dead service.
        kind = os.path.splitext(rec.get("SourcePath", ""))[1].lstrip(".") or "unknown"
        labels = {"unit": unit, "kind": kind}
        state = rec.get("ActiveState", "")
        m.add("home_server_unit_restarts_total",
              int(rec.get("NRestarts") or 0), labels,
              "systemd's NRestarts for a quadlet unit. Unlike the container "
              "counter this survives the container being recreated, so a "
              "restart loop is visible here and nowhere else.", "counter")
        m.add("home_server_unit_state", UNIT_STATES.get(state, 9), labels,
              "0 active, 1 activating, 2 failed, 3 deactivating, 4 inactive, "
              "5 reloading, 9 unrecognised.")
        if kind in ("container", "pod") and state != "active":
            unhealthy += 1

    m.add("home_server_units_not_active", unhealthy, None,
          "Long-running quadlet units (.container and .pod) that are not "
          "active. Oneshot .build and .network units are excluded, because "
          "inactive is their correct resting state.")


def _unit_cgroup(unit):
    """The cgroup directory for `unit`, whichever slice under app.slice holds it.

    THE JOIN WAS A SINGLE os.path.join FOR AS LONG AS EVERY QUADLET SAT DIRECTLY
    IN app.slice. `Slice=app-agents.slice` puts one a level deeper, and the flat
    join then misses - which is not a wrong number but no number at all: 32 of
    windmill-db's 43 series are read out of this directory, and the 11 that
    survive are the ones podman ps and systemctl answer, so the container looks
    entirely normal while every memory, cpu, io and PSI series for it is gone.
    Only home_server_container_identity_unresolved says so.

    The flat path is tried FIRST so nothing that resolves today can move, and
    the listing below runs only on a miss - which today is never.

    ONE LEVEL, NOT A WALK, and both halves of that are deliberate. systemd
    derives the hierarchy from the dashes in the name, so app-agents.slice
    sitting under app.slice is knowable rather than guessed. And a recursive
    search would also match the libpod-payload-<id> cgroup nested INSIDE the
    directory being looked for - a different set of numbers that would look
    entirely plausible. If a slice ever nests deeper than this, the signal is
    identity_unresolved, which is exported - though no rule fires on it, so
    the Services page banner is the surface that would actually be seen.

    Not /proc/<pid>/cgroup, which is the obvious authoritative answer and is
    wrong here: torrent-infra reports the POD's cgroup
    (user@1000.service/user.slice/user-libpod_pod_<id>/...), which contains the
    unit name nowhere, where the join below resolves it to torrent-pod.service,
    the unit's own cgroup. Switching would silently change what the four pod
    members' numbers mean while every one of them kept reporting.
    """
    base = os.path.join(CGROUP, unit)
    if os.path.isdir(base):
        return base
    try:
        entries = os.listdir(CGROUP)
    except OSError:
        return None
    for entry in entries:
        if entry.endswith(".slice"):
            nested = os.path.join(CGROUP, entry, unit)
            if os.path.isdir(nested):
                return nested
    return None


def source_containers(m):
    raw = run(["podman", "ps", "--format", "json"], timeout=20)
    if raw is None:
        raise RuntimeError("podman ps failed")
    containers = json.loads(raw)

    unresolved = 0
    ephemeral = 0
    for c in containers:
        # SKIPPED BEFORE unresolved, NOT AFTER, and the order is the whole
        # point. An ephemeral container emits no series either way - the `not
        # unit` branch below already returns before any m.add - so the damage
        # was never a wrong number, it was a counter documented as "the join has
        # broken" reading non-zero as a matter of routine, and a banner on the
        # Services page saying containers are missing from the table whenever a
        # phase runs. Measured: one throwaway container took it from 0 to 1.
        if _is_ephemeral(c):
            ephemeral += 1
            continue
        name = (c.get("Names") or ["?"])[0]
        unit = (c.get("Labels") or {}).get("PODMAN_SYSTEMD_UNIT", "")
        if not unit:
            unresolved += 1
            continue
        base = _unit_cgroup(unit)
        if base is None:
            unresolved += 1
            continue

        labels = {"container": name}
        m.add("home_server_container_info", 1,
              {"container": name, "unit": unit,
               "image": c.get("Image", ""), "pod": c.get("PodName", "")},
              "Container identity. Everything that changes at deploy time "
              "rather than sample time lives here and is joined, so a nightly "
              "image update costs one series per container and not one per "
              "series.")
        m.add("home_server_container_running",
              1 if c.get("State") == "running" else 0, labels,
              "1 when the container is running.")
        # KEPT, AND NOT THE ONE TO ALERT ON - see source_units above. A quadlet
        # recreates the container on every restart, so this resets each time
        # round a restart loop and reads 0 throughout the exact event it looks
        # like it would catch. home_server_unit_restarts_total is the counter
        # that survives. This one still says something the other cannot: a
        # container restarting WITHOUT its unit restarting, which is podman's
        # own doing rather than systemd's.
        m.add("home_server_container_restarts_total", c.get("Restarts", 0),
              labels, "Restarts as podman reports them, for THIS container "
              "object only - reset whenever the container is recreated, which "
              "a quadlet does on every unit restart. Always 0 during a restart "
              "loop; use home_server_unit_restarts_total for that.",
              "counter")
        m.add("container_start_time_seconds", _started_at(c), labels,
              "Unix timestamp the container started.")

        # duckdns, unpackerr and the pod's infra container define no
        # healthcheck. The health gauge is ABSENT for them rather than zero,
        # and the _defined gauge says which case a reader is in - a check that
        # assumes every container reports health marks those three broken for
        # ever.
        status = c.get("Status", "")
        state = next((s for s in HEALTH_STATES if "(%s)" % s in status), None)
        m.add("home_server_container_healthcheck_defined",
              1 if state else 0, labels,
              "1 when the container defines a healthcheck at all.")
        if state:
            m.add("home_server_container_health", HEALTH_STATES[state], labels,
                  "0 healthy, 1 starting, 2 unhealthy. Absent when the "
                  "container defines no healthcheck.")

        _container_cgroup(m, labels, base)

    m.add("home_server_container_identity_unresolved", unresolved, None,
          "Containers that could not be mapped to a cgroup. Non-zero means the "
          "PODMAN_SYSTEMD_UNIT join has broken and some containers are missing "
          "from every panel.")
    # MANAGED CONTAINERS, which is a change of meaning under an existing name -
    # a no-op today, because the two numbers are identical until a fleet
    # container runs, and named here rather than discovered in a graph later.
    m.add("home_server_containers", len(containers) - ephemeral, None,
          "Containers podman reports, EXCLUDING the ephemeral ones conduct "
          "starts. Those are counted by home_server_containers_ephemeral.")
    # A SKIP THAT COUNTS NOTHING IS THE SILENT FAILURE THIS FILE IS WRITTEN
    # AGAINST. identity_unresolved exists for exactly that reason, so taking
    # runners out of it without putting them anywhere would trade one blind spot
    # for another. It is also what agents.runners_leaked reads: a leaked runner
    # is a container with this label that outlived its transient scope.
    m.add("home_server_containers_ephemeral", ephemeral, None,
          "Containers carrying io.home-server.ephemeral - conduct's phase "
          "runners and their datastores. Deliberately absent from every other "
          "container series: they live for minutes and their names carry a "
          "worktree id, so a label would be unbounded.")


def _started_at(c):
    value = c.get("StartedAt")
    return value if isinstance(value, (int, float)) else None


def _container_cgroup(m, labels, base):
    """The memory numbers that distinguish a full cache from a starved cgroup.

    THIS IS THE WHOLE REASON THIS SCRIPT TOUCHES CONTAINERS AT ALL. Jellyfin
    sits at its MemoryHigh with a fast-climbing `high` counter and is perfectly
    healthy: anon 0.385G against 2.338G of cold, clean page cache, pgsteal
    tracking pgscan to five digits, and zero total stall. Reading memory.current
    alone reproduces exactly the misdiagnosis CLAUDE.md already records.
    """
    stat = read_kv(os.path.join(base, "memory.stat"))
    current = read_int(os.path.join(base, "memory.current"))
    inactive_file = stat.get("inactive_file")

    # THE NUMBER THAT WOULD HAVE PREVENTED THE MISDIAGNOSIS, under the name the
    # rest of the world already uses for it. Working set is what is genuinely
    # resident: memory.current minus the cold, clean page cache the kernel can
    # drop for nothing. Jellyfin reads ~0.66G here against a memory.current of
    # 3.00G at a 3G ceiling - the same cgroup, the same instant, and the only
    # one of the two numbers worth alerting on.
    if current is not None and inactive_file is not None:
        m.add("container_memory_working_set_bytes",
              max(current - inactive_file, 0), labels,
              "Memory usage minus inactive file cache - what is actually "
              "resident and not free to reclaim. Alert on THIS, never on "
              "container_memory_usage_bytes.")

    # cAdvisor's names, adopted verbatim: same cgroup fields, same units, same
    # meaning, so this implementation can be swapped out without touching a
    # dashboard. The missing _bytes suffix on rss and cache is cAdvisor's wart
    # rather than ours, and reproducing it faithfully is the whole point - a
    # name that is ALMOST the upstream one is worse than either, because it
    # breaks silently on the day something else serves it.
    m.add("container_memory_rss", stat.get("anon"), labels,
          "Anonymous memory - the actual working set.")
    m.add("container_memory_cache", stat.get("file"), labels,
          "Page cache charged to this cgroup.")

    # No upstream equivalent, and load-bearing: the split between cold and warm
    # cache is the difference between 'at its ceiling' and 'in trouble'.
    m.add("home_server_container_memory_inactive_file_bytes", inactive_file,
          labels,
          "Cold, clean page cache. Reclaimable at essentially no cost.")
    m.add("home_server_container_memory_active_file_bytes",
          stat.get("active_file"), labels, "Recently used page cache.")
    for key, metric, help_text in (
            ("pgscan", "pgscan_total", "Pages scanned for reclaim."),
            ("pgsteal", "pgsteal_total",
             "Pages successfully reclaimed. Tracking pgscan means reclaim is "
             "free; falling short of it means it is not."),
            ("workingset_refault_file", "workingset_refault_file_total",
             "Pages reclaimed and then immediately needed again - real thrash, "
             "as opposed to a cgroup simply holding cache.")):
        m.add("home_server_container_memory_" + metric, stat.get(key), labels,
              help_text, "counter")

    m.add("container_memory_usage_bytes", current, labels,
          "memory.current. MISLEADING ON ITS OWN - a cgroup doing file I/O sits "
          "at its ceiling by design. Read container_memory_working_set_bytes.")
    m.add("container_memory_max_usage_bytes",
          read_int(os.path.join(base, "memory.peak")), labels,
          "High-water mark since the cgroup was created.")
    m.add("container_spec_memory_limit_bytes",
          read_int(os.path.join(base, "memory.max")), labels,
          "The MemoryMax= hard limit.")

    # MINTED DELIBERATELY, and this is the sharpest case for the naming rule.
    # cAdvisor's container_spec_memory_reservation_limit_bytes reads like the
    # name for this and is NOT: it maps to memory.low, a reservation, where this
    # is memory.high, a throttle watermark. Publishing MemoryHigh under that
    # name would show a container pressed against a limit it is not at - the
    # exact misdiagnosis container_memory_working_set_bytes exists to prevent,
    # reintroduced through the label instead of the number.
    m.add("home_server_container_memory_high_bytes",
          read_int(os.path.join(base, "memory.high")), labels,
          "The MemoryHigh= throttle watermark, NOT memory.low.")

    events = read_kv(os.path.join(base, "memory.events"))
    for key in ("high", "max", "oom", "oom_kill"):
        if key in events:
            ev = dict(labels)
            ev["event"] = key
            m.add("home_server_container_memory_events_total", events[key], ev,
                  "memory.events. `high` on its own proves NOTHING - a cgroup "
                  "doing file I/O always accumulates it. `oom_kill` is the one "
                  "that is unambiguous.", "counter")

    # cAdvisor's PSI names, adopted verbatim. Note the vocabulary differs from
    # the kernel's and means the same thing: PSI writes some/full, cAdvisor says
    # waiting/stalled - some is "at least one task was delayed", full is "every
    # runnable task was". The level therefore lives in the metric NAME here
    # rather than in a label, which is what upstream does.
    for controller in ("cpu", "memory", "io"):
        for level, seconds in read_pressure(
                os.path.join(base, "%s.pressure" % controller)).items():
            if level not in PSI_LEVELS:
                continue
            m.add("container_pressure_%s_%s_seconds_total"
                  % (controller, PSI_LEVELS[level]), "%.6f" % seconds, labels,
                  "PSI total stall. The arbiter: real starvation shows here, "
                  "and a cgroup merely holding cache does not.", "counter")

    cpu = read_kv(os.path.join(base, "cpu.stat"))
    for key, metric in (("usage_usec", "container_cpu_usage_seconds_total"),
                        ("user_usec", "container_cpu_user_seconds_total"),
                        ("system_usec", "container_cpu_system_seconds_total")):
        if key in cpu:
            m.add(metric, "%.6f" % (cpu[key] / 1e6), labels,
                  "CPU time from cpu.stat.", "counter")
    m.add("container_cpu_cfs_throttled_seconds_total",
          "%.6f" % (cpu["throttled_usec"] / 1e6) if "throttled_usec" in cpu
          else None, labels, "Time throttled against the CPU limit.", "counter")
    # No upstream equivalent, and it is the one that explains this host: 92.5%
    # of Jellyfin's CPU was nice_usec, which is why `podman stats` showing it
    # near the top is trickplay extraction rather than anybody watching.
    m.add("home_server_container_cpu_nice_seconds_total",
          "%.6f" % (cpu["nice_usec"] / 1e6) if "nice_usec" in cpu else None,
          labels, "CPU time spent at positive nice.", "counter")

    io = read_kv_io(os.path.join(base, "io.stat"))
    for device, counters in io.items():
        il = dict(labels)
        il["device"] = device
        for key, metric, help_text in (
                ("rbytes", "container_fs_reads_bytes_total",
                 "Bytes read from this device."),
                ("wbytes", "container_fs_writes_bytes_total",
                 "Bytes written to this device."),
                ("rios", "container_fs_reads_total", "Read operations."),
                ("wios", "container_fs_writes_total", "Write operations.")):
            m.add(metric, counters.get(key), il, help_text, "counter")

    m.add("home_server_container_pids", read_int(os.path.join(base,
          "pids.current")), labels, "Processes in the cgroup.")
    m.add("home_server_container_pids_max", read_int(os.path.join(base,
          "pids.max")), labels, "Process limit, absent when unlimited.")


def read_kv_io(path):
    """io.stat: '<major>:<minor> rbytes=N wbytes=N rios=N wios=N ...'.

    Keyed by device number rather than name, because that is what the kernel
    gives and resolving it needs /sys - and the join to node_disk_* is by name.
    The resolution is done here so the label is the same one node-exporter uses.
    """
    out = {}
    try:
        for line in read_text(path).splitlines():
            parts = line.split()
            if len(parts) < 2:
                continue
            device = _devname(parts[0])
            counters = {}
            for field in parts[1:]:
                if "=" in field:
                    key, _, value = field.partition("=")
                    try:
                        counters[key] = int(value)
                    except ValueError:
                        pass
            if counters:
                out[device] = counters
    except OSError:
        pass
    return out


def _devname(devno):
    try:
        return os.path.basename(os.readlink("/sys/dev/block/%s" % devno))
    except OSError:
        return devno


# ------------------------------------------------------------------------------
# GPU
# ------------------------------------------------------------------------------
# Minted names, deliberately. There is no upstream standard for the field that
# matters most on this host - utilization.encoder - so there is nothing to be
# portable TO, and DCGM's names (SCREAMING_CASE, no unit suffix, framebuffer in
# MiB) would import a contradictory convention permanently.
#
# THE ENGINE IS A LABEL, NOT FOUR METRICS, and that is the point: two NVENC
# sessions pin the encoder block at 100% while the SM sits at 10%, so anyone
# reading utilization.gpu alone sees an idle GPU mid-transcode. Putting them on
# one metric makes reading them side by side the easy query.
#
# NEVER AGGREGATE ACROSS CARDS. GPU 0's video engines are dead hardware - every
# NVENC session on it fails with "unsupported device", which jellyfin.container
# documents - so a sum over both cards reads 50% during a full-rate encode.

GPU_FIELDS = ("index", "uuid", "name", "utilization.gpu", "utilization.memory",
              "utilization.encoder", "utilization.decoder", "memory.total",
              "memory.used", "temperature.gpu", "power.draw", "power.limit",
              "clocks.current.sm", "clocks.current.memory", "fan.speed",
              "encoder.stats.sessionCount", "encoder.stats.averageFps",
              "encoder.stats.averageLatency", "driver_version")


def _num(raw):
    """A CSV cell as a float, or None. nvidia-smi writes [N/A] for a field a
    card does not support, and one unsupported field must drop its own series
    rather than the whole row."""
    try:
        return float(raw.strip())
    except (ValueError, AttributeError):
        return None


def source_gpu(m):
    out = run(["nvidia-smi", "--query-gpu=" + ",".join(GPU_FIELDS),
               "--format=csv,noheader,nounits"], timeout=8)
    if out is None:
        # NOTHING is emitted, never a fabricated zero. A zero here would read as
        # "no transcode running" on a host whose driver has just gone, which is
        # the opposite of the truth and worse than a blank panel. Same doctrine
        # as bin/reboot-when-staged.sh: unknown is not idle.
        raise RuntimeError("nvidia-smi failed")

    for line in out.strip().splitlines():
        f = [c.strip() for c in line.split(",")]
        if len(f) != len(GPU_FIELDS):
            continue
        row = dict(zip(GPU_FIELDS, f))
        labels = {"gpu": row["index"], "uuid": row["uuid"]}

        m.add("home_server_gpu_info", 1,
              {"gpu": row["index"], "uuid": row["uuid"], "name": row["name"],
               "driver_version": row["driver_version"]},
              "GPU identity. The driver version lives here and nowhere else.")

        for field, engine in (("utilization.gpu", "sm"),
                              ("utilization.encoder", "encoder"),
                              ("utilization.decoder", "decoder"),
                              ("utilization.memory", "memory_bandwidth")):
            value = _num(row[field])
            if value is not None:
                el = dict(labels)
                el["engine"] = engine
                m.add("home_server_gpu_utilization_ratio", value / 100.0, el,
                      "Engine utilisation, 0-1. engine=encoder is the one this "
                      "host runs on; engine=sm is near-idle during a transcode "
                      "and reading it alone is misleading. memory_bandwidth is "
                      "time spent moving memory, NOT memory used.")

        for field, metric, scale, help_text in (
                ("memory.used", "home_server_gpu_memory_used_bytes", 1 << 20,
                 "Framebuffer in use, in bytes rather than MiB."),
                ("memory.total", "home_server_gpu_memory_total_bytes", 1 << 20,
                 "Framebuffer size."),
                ("temperature.gpu", "home_server_gpu_temperature_celsius", 1,
                 "Core temperature."),
                ("power.draw", "home_server_gpu_power_watts", 1,
                 "Current board power draw."),
                ("power.limit", "home_server_gpu_power_limit_watts", 1,
                 "Board power cap."),
                ("fan.speed", "home_server_gpu_fan_speed_ratio", 0.01,
                 "Fan speed, 0-1."),
                ("encoder.stats.sessionCount",
                 "home_server_gpu_encoder_sessions", 1,
                 "Active NVENC sessions. The consumer ceiling is 8, but two "
                 "already pin the encoder block at 100%."),
                ("encoder.stats.averageFps", "home_server_gpu_encoder_fps", 1,
                 "Average frames per second across encoder sessions."),
                ("encoder.stats.averageLatency",
                 "home_server_gpu_encoder_latency_seconds", 1e-6,
                 "Average encoder latency, converted from microseconds.")):
            value = _num(row[field])
            if value is not None:
                m.add(metric, value * scale, labels, help_text)

        for field, domain in (("clocks.current.sm", "sm"),
                              ("clocks.current.memory", "memory")):
            value = _num(row[field])
            if value is not None:
                cl = dict(labels)
                cl["domain"] = domain
                m.add("home_server_gpu_clock_hertz", value * 1e6, cl,
                      "Current clock, converted from MHz.")


# ------------------------------------------------------------------------------
# Temperatures
# ------------------------------------------------------------------------------
# Read straight out of sysfs rather than by shelling out to `sensors -j`: no
# fork, and no dependence on lm_sensors' JSON schema staying put.
#
# Minted rather than taking node_exporter's node_hwmon_temp_celsius, because
# that one uses a SLUGIFIED SYSFS PATH as its chip label rather than the chip
# name, and we would not reproduce that faithfully. A name that is almost the
# upstream one is the failure this whole naming rule exists to avoid.

def source_sensors(m):
    found = 0
    for hwmon in sorted(glob.glob("/sys/class/hwmon/hwmon*")):
        try:
            chip = read_text(os.path.join(hwmon, "name")).strip()
        except OSError:
            continue
        for path in sorted(glob.glob(os.path.join(hwmon, "temp*_input"))):
            sensor = os.path.basename(path)[:-len("_input")]
            millidegrees = read_int(path)
            if millidegrees is None:
                continue
            labels = {"chip": chip, "sensor": sensor}
            try:
                labels["label"] = read_text(
                    os.path.join(hwmon, sensor + "_label")).strip()
            except OSError:
                labels["label"] = sensor
            m.add("home_server_hwmon_temp_celsius", millidegrees / 1000.0,
                  labels, "Temperature from /sys/class/hwmon.")
            found += 1
    if not found:
        raise RuntimeError("no hwmon temperatures found")


# ------------------------------------------------------------------------------
# Disk health - the SLOW tier
# ------------------------------------------------------------------------------
# -n standby is what stops a monitoring job waking a sleeping spindle every five
# minutes. smartctl exits 2 in that case, which means "asleep" and not "broken";
# run() already returns None on a non-zero exit, so it degrades to no series.

def source_smart(m):
    devices = [d for d in ("/dev/sda", "/dev/nvme0") if os.path.exists(d)]
    if not devices:
        raise RuntimeError("no SMART-capable devices")
    for dev in devices:
        # -i as well as -A -H: without it the JSON carries no model_name or
        # firmware_version and home_server_disk_info comes out with empty
        # labels, which is worse than no info series at all.
        out = run(["sudo", "-n", "smartctl", "-j", "-n", "standby", "-i", "-A",
                   "-H", dev], timeout=20)
        if out is None:
            continue
        try:
            data = json.loads(out)
        except json.JSONDecodeError:
            continue
        name = os.path.basename(dev)
        labels = {"device": name}
        m.add("home_server_disk_info", 1,
              {"device": name, "model": data.get("model_name", ""),
               "firmware": data.get("firmware_version", "")},
              "Disk identity. The serial is deliberately not carried.")
        passed = data.get("smart_status", {}).get("passed")
        if passed is not None:
            m.add("home_server_disk_health_ok", 1 if passed else 0, labels,
                  "SMART overall-health self-assessment.")
        temp = data.get("temperature", {}).get("current")
        if temp is not None:
            m.add("home_server_disk_temperature_celsius", temp, labels,
                  "Drive temperature.")
        hours = data.get("power_on_time", {}).get("hours")
        if hours is not None:
            m.add("home_server_disk_power_on_hours", hours, labels,
                  "Powered-on hours.", "counter")
        nvme = data.get("nvme_smart_health_information_log")
        if nvme:
            for key, metric, help_text in (
                    ("percentage_used", "home_server_disk_nvme_wear_ratio",
                     "Endurance consumed, 0-1 where 1 is the rated life."),
                    ("media_errors", "home_server_disk_media_errors_total",
                     "Unrecovered data integrity errors."),
                    ("unsafe_shutdowns", "home_server_disk_unsafe_shutdowns_total",
                     "Power lost without a clean shutdown.")):
                value = nvme.get(key)
                if value is not None:
                    m.add(metric, value / 100.0 if key == "percentage_used"
                          else value, labels, help_text,
                          "gauge" if key == "percentage_used" else "counter")
        for attr in (data.get("ata_smart_attributes", {}).get("table") or []):
            table = {5: ("home_server_disk_reallocated_sectors",
                         "Sectors the drive has remapped."),
                     197: ("home_server_disk_pending_sectors",
                           "Sectors waiting to be remapped - the leading "
                           "indicator of a failing spindle."),
                     199: ("home_server_disk_crc_errors_total",
                           "Interface CRC errors, usually a cable.")}
            entry = table.get(attr.get("id"))
            if entry:
                m.add(entry[0], attr.get("raw", {}).get("value"), labels,
                      entry[1])


# ------------------------------------------------------------------------------
# status.json as series
# ------------------------------------------------------------------------------
# The hourly battery already keys every finding by a stable id. This turns those
# into time series so "when did that start failing" becomes answerable, without
# duplicating the document badly.
#
# THE ORDERED SEVERITY ORDINAL IS THE WHOLE DESIGN. max(home_server_check_status)
# is the entire system's verdict, because the ordering IS the precedence - which
# is the time-series translation of status.json's own guarantee that summary
# .status is one field to colour on and nobody re-derives precedence.
#
# THE MESSAGE IS NEVER EMITTED. Prose is unstable by charter here, and a label
# carrying it would mint a fresh series on every reword and leave the old one
# lingering for the whole retention period. The dashboard fetches the sentence
# from status.json at render time, keyed by the same id it queried with. That is
# the id/prose split, drawn along the boundary between the two stores.

STATUS_FILE = "/var/lib/home-server/status.json"
CHECK_STATUS = {"pass": 0, "note": 1, "warn": 2, "fail": 3}
GREENBOOT_STATES = {"green": 0, "red": 1}
# Facts whose value is a version or a word rather than a number. They become
# labels on one info series, so a new OS version costs one series a month
# instead of one per sample.
FACT_INFO_KEYS = ("booted_version", "staged_version", "driver_version")
# FACTS THIS FILE ALREADY PUBLISHES ITSELF, and the bridge below must not
# republish. `home_server_` + the fact key is the metric name, so a fact named
# after an existing series is a DUPLICATE SAMPLE in one exposition file - and
# the two writers here disagree by construction, because the battery is hourly
# and source_containers runs every 30 seconds. Prometheus tolerates a duplicate
# whose value matches and rejects THE WHOLE SCRAPE when it does not, so the
# failure waits for the first phase that starts and ends between two batteries
# and then takes every metric on the host down with it. Found by reading the
# exposition rather than by the check, which stayed green throughout.
FACT_OWNED_ELSEWHERE = ("containers_ephemeral",)


def _epoch(stamp):
    try:
        return calendar.timegm(time.strptime(stamp, "%Y-%m-%dT%H:%M:%SZ"))
    except (ValueError, TypeError):
        return None


def source_status(m):
    doc = json.loads(read_text(STATUS_FILE))

    for check in doc.get("checks", []):
        value = CHECK_STATUS.get(check.get("status"))
        if value is None:
            continue
        m.add("home_server_check_status", value,
              {"id": check.get("id", ""), "section": check.get("section", "")},
              "0 pass, 1 note, 2 warn, 3 fail. Ordered by severity, so "
              "max() over it is the whole system's verdict and no consumer "
              "re-derives precedence. A check that did not run is ABSENT.")

    m.add("home_server_status_generated_timestamp_seconds",
          _epoch(doc.get("generated_at")), None,
          "When the battery last ran. A TIMESTAMP, not an age: the consumer "
          "subtracts from time(), so a stopped timer shows as staleness rather "
          "than freezing at its last value.")
    m.add("home_server_status_schema", doc.get("schema"), None,
          "status.json's own schema version.")
    for mode, on in (doc.get("mode") or {}).items():
        m.add("home_server_status_mode", 1 if on else 0, {"mode": mode},
              "Which optional sections ran. Absence of a section and a section "
              "that passed must not look alike.")

    facts = doc.get("facts") or {}
    info = {k: str(facts.get(k) or "") for k in FACT_INFO_KEYS}
    m.add("home_server_status_info", 1, info,
          "Version strings from the battery's facts, joined rather than "
          "repeated per sample.")
    m.add("home_server_greenboot_result",
          GREENBOOT_STATES.get(facts.get("greenboot_result")), None,
          "0 green, 1 red. Absent when no verdict has been recorded.")

    for key, value in facts.items():
        if key in FACT_INFO_KEYS or key == "greenboot_result":
            continue
        if key in FACT_OWNED_ELSEWHERE:
            continue
        if value is None:
            # A null fact is ABSENT, never zero. The substrates fail in opposite
            # directions - a JSON key that vanishes makes a reader guess, while
            # a zero in a TSDB reads as a measurement - so the same goal
            # produces opposite encodings, and this is the TSDB's.
            continue
        if isinstance(value, bool):
            m.add("home_server_" + key, 1 if value else 0, None,
                  "From status.json facts.")
        elif isinstance(value, (int, float)):
            # status.json's keys carry their unit in the name - boot_free_mb,
            # uptime_s - which is fine for a JSON document whose keys are the
            # stable interface, and a permanent wart in a metric name. Convert
            # to base units here rather than forking the fact keys, because
            # those are the contract the battery publishes.
            if key.endswith("_mb"):
                m.add("home_server_%s_bytes" % key[:-3], value * (1 << 20),
                      None, "From status.json facts, converted to bytes.")
            elif key.endswith("_s"):
                m.add("home_server_%s_seconds" % key[:-2], value, None,
                      "From status.json facts.")
            else:
                m.add("home_server_" + key, value, None,
                      "From status.json facts.")
        elif key.endswith("_at"):
            m.add("home_server_%s_timestamp_seconds" % key[:-3], _epoch(value),
                  None, "From status.json facts, as a unix timestamp.")


# ------------------------------------------------------------------------------
# The agent fleet
# ------------------------------------------------------------------------------
# FAST TIER, and it earns the place: one flat file and one cgroup directory, no
# subprocess at all. The numbers it carries are spend against a quota, and a
# spend counter five minutes out of date is not stale, it is wrong - by then the
# fleet has dispatched again on a figure that was already gone.
#
# MIND THE PREFIX. These are home_server_agent_*, SINGULAR. bin/verify-host.sh's
# facts are agents_*, plural, and source_status above turns each into
# home_server_agents_*. The two families are one letter apart, and a collision is
# not a wrong number: FACT_OWNED_ELSEWHERE records that Prometheus rejects the
# WHOLE SCRAPE when two samples of one name disagree, so a careless key here
# takes every metric on the host down until somebody reads the exposition by
# hand. bin/lint-repo.sh leg 9 asserts the two families stay disjoint.
#
# IT MUST NEVER RAISE ON AN ABSENT MARKER OR AN ABSENT SLICE, and that is not
# politeness. A source that raises stops last_ok_at advancing for EVERY source at
# once, so metrics.collector_fresh would WARN about a collector doing its job -
# and absent is the normal state on this host until conduct ships.
AGENT_SLICE = os.path.join(CGROUP, "app-agents.slice")
CONDUCT_MARKER = os.path.expanduser("~/.cache/home-server/conduct-state")

# THE KEY SET IS A LITERAL LIST, which is the whole cardinality argument. conduct
# writes the marker and conduct does not exist yet; a loop over whatever keys it
# happens to contain would let a component nobody has written mint series in a
# store that keeps 400 days. A key not named here is read by nothing.
#
# (marker key, metric suffix, help)
AGENT_NUMBERS = (
    ("phase_in_flight", "phase_in_flight",
     "1 while a phase runner is executing. ABSENT when conduct is not installed, "
     "which is not the same as 0 and must not be drawn as idle."),
    ("tokens_today", "tokens_today",
     "Tokens spent since midnight. A gauge, not a counter: it resets daily by "
     "design, and rate() over a resetting counter is a lie."),
    ("tokens_week", "tokens_week",
     "Tokens the fleet spent in a rolling seven days. NOT the account's weekly "
     "window, which resets at a time only the API knows: this is conduct's own "
     "runs, and the gap between it and the account's status is your own "
     "sessions."),
    ("runs_today", "runs_today", "Phase runs started since midnight."),
    ("runs_failed_today", "runs_failed_today",
     "Phase runs that ended in a failure since midnight."),
    ("worktrees", "worktrees",
     "Worktrees conduct currently holds a lease on. agents.worktree_orphans "
     "compares it against what is on disk."),
)

# A STATUS, NOT A RATIO, AND THE CHANGE IS FORCED RATHER THAN PREFERRED. This was
# two windows as fractions, read from GET /api/oauth/usage - which returns exactly
# that and answers 403 to the only long-lived credential a headless server can
# hold, measured on 2026-08-23 before anything was built on it. What is available
# is the API's own unified rate-limit status on the phase's own model call.
#
# GRADED 0/1/2 THE WAY home_server_check_status IS, so an alert reads `>= 1` and
# a panel can colour it without knowing the words. An unrecognised status ranks
# WORST: the enum came out of a binary rather than a contract, and a fourth value
# reading as "fine" is the one direction that spends the cap.
#
# quota_window is deliberately NOT a label. It is the forbidden-label family by
# the phase_label precedent - worth a sentence in the battery's message, not worth
# a dimension in a store that keeps 400 days.
AGENT_STATUS_RANK = {"allowed": 0, "allowed_warning": 1, "rejected": 2}

# (marker key, metric infix)
AGENT_STAMPS = (("last_ok_at", "last_ok"), ("heartbeat_at", "heartbeat"),
                ("phase_started_at", "phase_started"),
                ("quota_read_at", "quota_read"),
                # WHEN THE HOLD ENDS, which is the whole reason the status needs
                # no staleness rule: the window either has rolled over or has not,
                # and the API said when rather than leaving it to be estimated.
                ("quota_resets_at", "quota_resets"),
                # WHEN THE FLEET LAST LOOKED FOR WORK TO DO, and it is a stamp
                # rather than a number for the reason every other one here is:
                # what matters is that it keeps advancing. An intake that has
                # stopped is indistinguishable from an empty backlog by every
                # other signal on this host - no failed unit, no unhealthy
                # container, no run - so this series going flat IS the fault.
                #
                # intake_last_why IS DELIBERATELY NOT HERE. It is a sentence
                # about a task, unbounded and sometimes carrying a title, so a
                # label dimensioned on it would mint a new series for every task
                # the fleet declined, in a store that keeps 400 days. It is read
                # by agents.intake into a message and nowhere else - the
                # phase_label family, by that precedent.
                ("intake_last_at", "intake_last"))


def _marker(path):
    """A key=value marker file as a dict of strings. Missing file -> {}."""
    out = {}
    try:
        for line in read_text(path).splitlines():
            if "=" in line:
                key, _, value = line.partition("=")
                out[key.strip()] = value.strip()
    except OSError:
        pass
    return out


def _marker_number(raw, scale=None):
    """A marker value as a number, or None when it is absent or not one.

    None is the point rather than a fallback: Metrics.add drops it, so a key
    conduct has not written is ABSENT from the exposition instead of arriving as
    a zero somebody would read as a measurement.
    """
    if not raw:
        return None
    try:
        value = float(raw)
    except ValueError:
        return None
    if scale is not None:
        return "%.4f" % (value * scale)
    return int(value) if value == int(value) else value


def source_agents(m):
    # THE PRESENCE GAUGE IS NOT DECORATION. read_int returns None for the literal
    # `max` and Metrics.add then drops the sample, so an UNBOUNDED control does
    # not read as zero - it vanishes. The failure this whole tier exists for is
    # systemd instantiating the slice with defaults, where all five controls read
    # unlimited and therefore all five gauges disappear together, which from a
    # dashboard is indistinguishable from a slice that is not running. Same
    # reason home_server_filesystem_mounted exists beside the size gauges.
    present = os.path.isdir(AGENT_SLICE)
    m.add("home_server_agent_slice_present", 1 if present else 0, None,
          "1 when app-agents.slice has a live cgroup. Every gauge below is "
          "ABSENT both when the slice is empty and when a control is unlimited, "
          "so this is what tells those two apart.")

    if present:
        for metric, filename, help_text in (
                ("memory_bytes", "memory.current",
                 "memory.current for the whole slice - every Windmill container, "
                 "conduct, and any phase scope, summed by the kernel."),
                ("memory_peak_bytes", "memory.peak",
                 "High-water mark since the slice was created. What the runner's "
                 "own MemoryMax was sized against."),
                ("memory_max_bytes", "memory.max",
                 "The MemoryMax= ceiling. ABSENT when unlimited, which is the "
                 "silent failure agents.slice_limits exists to catch."),
                ("memory_high_bytes", "memory.high",
                 "The MemoryHigh= throttle watermark, NOT memory.low."),
                ("pids", "pids.current", "Tasks in the slice."),
                ("pids_max", "pids.max",
                 "The TasksMax= limit. ABSENT when unlimited.")):
            m.add("home_server_agent_slice_" + metric,
                  read_int(os.path.join(AGENT_SLICE, filename)), None, help_text)

        # THE ONE NUMBER THAT SAYS THE SIZING IS WRONG rather than that the tests
        # are flaky. A cgroup OOM picks its victim by badness across the whole
        # subtree, and rootless podman refuses to lower a Windmill worker's
        # oom_score_adj - so a kill here may land on the control plane rather
        # than on the phase that caused it. `high` is deliberately not exported:
        # a slice doing file I/O accumulates it forever and it proves nothing.
        events = read_kv(os.path.join(AGENT_SLICE, "memory.events"))
        m.add("home_server_agent_slice_oom_total", events.get("oom_kill"), None,
              "Processes killed by the kernel for breaching the slice's memory "
              "ceiling. Non-zero means the sizing is wrong, not that a test is "
              "flaky.", "counter")

    state = _marker(CONDUCT_MARKER)
    m.add("home_server_agent_marker_present", 1 if state else 0, None,
          "1 when conduct has written its marker. Reads 0 on a host where the "
          "orchestrator is not installed, which is what every agents check "
          "reports as a NOTE rather than a finding.")

    for key, infix in AGENT_STAMPS:
        m.add("home_server_agent_%s_timestamp_seconds" % infix,
              _epoch(state.get(key)), None,
              "From conduct's marker. A TIMESTAMP, not an age: the consumer "
              "subtracts from time(), so a stopped orchestrator shows as "
              "staleness rather than freezing at its last value.")

    status = state.get("quota_status")
    m.add("home_server_agent_quota_status",
          None if not status else AGENT_STATUS_RANK.get(status, 2), None,
          "The API's own unified rate-limit status on the last model call: "
          "0 allowed, 1 allowed_warning, 2 rejected. ABSENT until a model phase "
          "has run, which is not the same as 0 and must not be drawn as healthy. "
          "conduct holds the fleet at 1 or above until the window it named "
          "clears, so a 2 here means something other than the fleet spent it.")

    for key, suffix, help_text in AGENT_NUMBERS:
        m.add("home_server_agent_" + suffix, _marker_number(state.get(key)),
              None, help_text)


# ------------------------------------------------------------------------------
# The CI lanes
# ------------------------------------------------------------------------------
# THE LANES ARE INVISIBLE TO EVERY OTHER SOURCE IN THIS FILE, and that is the
# whole reason this one exists. A lane container carries io.home-server.ephemeral
# so source_containers and source_container_network both skip it - correct,
# because its name carries a timestamp that never repeats and the network series
# would accumulate under an unbounded label in a store that keeps 400 days. The
# cost is that a WEDGED LANE produces no container series, no failed unit and no
# unhealthy container. That is the Windmill-worker shape exactly: nothing is
# broken anywhere a reader can see, and work just queues.
#
# So the lane's own marker is the signal, and this reads it.
#
# MIND THE PREFIX, for the reason the agent family above documents at length.
# bin/verify-host.sh's CI facts are github_runner_*, which source_status turns
# into home_server_github_runner_*. These are home_server_ci_*. The two are
# deliberately not one letter apart the way agents_* and agent_* are, because a
# collision does not produce a wrong number - Prometheus rejects the WHOLE SCRAPE
# when two samples of one name disagree, and the battery is hourly while this
# runs every 30 seconds, so the two disagree by construction. bin/lint-repo.sh
# leg 9 asserts the families stay disjoint.
#
# IT MUST NEVER RAISE ON AN ABSENT MARKER OR AN ABSENT SLICE. A source that
# raises stops last_ok_at advancing for EVERY source at once, so
# metrics.collector_fresh would WARN about a collector doing its job - and absent
# is the normal state on a host where no lane is enabled.
CI_SLICE = os.path.join(CGROUP, "app-ci.slice")

# `lane` IS A LEGITIMATE LABEL AND THE FORBIDDEN FAMILY IS WHY THAT NEEDS SAYING.
# The banned dimensions are worktree path, branch, pull-request number, job id and
# session id - values that never repeat, in a store that keeps 400 days. This one
# is a closed set, fixed by host/systemd/app-ci.slice's cpuset arithmetic - six
# cores, one pair per lane - and a lane beyond it is refused by
# bin/github-runner.sh rather than silently minting a further series.
#
# IT WENT FROM TWO TO THREE ON 2026-08-27 AND THAT IS THE POINT OF WRITING IT
# DOWN: the set is closed, not fixed, and widening it is an edit here as well as
# in the slice. A lane whose marker exists and is not in this tuple produces no
# series at all, which is the Windmill-worker shape - nothing failed, nothing
# unhealthy, and work simply unobserved.
CI_LANES = (1, 2, 3)


def _ci_marker(lane):
    return os.path.expanduser("~/.cache/home-server/ci-state-%d" % lane)


# (marker key, metric suffix, help)
CI_NUMBERS = (
    ("job_in_flight", "job_in_flight",
     "1 while this lane is running a GitHub Actions job. ABSENT when the lane "
     "has never started, which is not the same as 0 and must not be drawn as "
     "idle."),
    ("jobs_today", "jobs_today",
     "Jobs this lane has completed since midnight. A gauge, not a counter: it "
     "resets daily by design, and rate() over a resetting counter is a lie."),
    ("consecutive_failures", "consecutive_failures",
     "Failed attempts to mint a runner identity since the last success. Non-zero "
     "means GitHub is answering something transient; a permanent rejection stops "
     "the lane instead, which shows up as the unit being failed."),
    ("lane_disk_mb", "lane_disk_megabytes",
     "What this lane holds on disk - its home, tool cache, nested image store "
     "and runner tree. The driver clears the regenerable parts when it passes "
     "its budget, so a sawtooth here is the design working."),
    ("lane_mem_peak_mb", "lane_memory_peak_megabytes",
     "The highest memory.peak any job on this lane has reached, off the "
     "transient scope - which is --collect, so nothing but the driver's own "
     "poll can ever read it. INCLUDES PAGE CACHE: a lane at its ceiling after "
     "`uv sync` and `bun install` is reclaim working, not pressure. Grade on "
     "lane_memory_max_events, never on this."),
    ("lane_pids_peak", "lane_pids_peak",
     "The highest pids.peak any job on this lane has reached. What binds first "
     "when it binds is TasksMax on the scope, and the symptom is 'fork: "
     "Resource temporarily unavailable' raised by something unrelated."),
    ("lane_mem_max_events", "lane_memory_max_events_total",
     "Times an allocation in this lane was refused at MemoryMax rather than "
     "throttled at MemoryHigh. This, not the peak, is the reading that "
     "justifies raising a ceiling."),
    ("lane_oom_kills", "lane_oom_kills_total",
     "Processes the kernel killed in this lane for breaching MemoryMax. "
     "Non-zero means a job died for a reason its own log cannot explain."),
    ("store_jobs", "store_jobs",
     "Jobs this lane's nested image store has served since it was last reset. "
     "Bounded by GITHUB_RUNNER_STORE_MAX_JOBS, because something in an aging "
     "store correlates with a `services:` block failing to start and nobody "
     "has identified what."),
    ("store_resets", "store_resets_total",
     "Times this lane's nested image store has been reset, for any of the "
     "three reasons. A rise faster than one per store window is the lane "
     "healing itself, which means the `services:` failure has come back."),
)

# (marker key, metric infix)
#
# job_started_at IS ABSENT WHILE A LANE IS IDLE, and that is the point. The
# driver clears it at teardown, so _epoch returns None and Metrics.add drops the
# sample - which is what lets a consumer compute an in-flight job's age without
# also having to ask whether a job is running. The cross-lane worst case already
# reached status.json as github_runner_job_age_s; this is the per-lane series
# that fact could never be, because a fact is one number for the whole host.
CI_STAMPS = (("heartbeat_at", "heartbeat"), ("last_job_at", "last_job"),
             ("job_started_at", "job_started"))


def source_ci(m):
    # THE PRESENCE GAUGE IS NOT DECORATION - the same argument
    # home_server_agent_slice_present makes. read_int returns None for the
    # literal `max` and Metrics.add then drops the sample, so an UNBOUNDED
    # control does not read as zero, it vanishes. Systemd instantiating this
    # slice with defaults - because nobody symlinked the unit file - makes all
    # five controls read unlimited and all five gauges disappear together, which
    # from a dashboard is indistinguishable from a slice that is not running.
    present = os.path.isdir(CI_SLICE)
    m.add("home_server_ci_slice_present", 1 if present else 0, None,
          "1 when app-ci.slice has a live cgroup. Every gauge below is ABSENT "
          "both when the slice is empty and when a control is unlimited, so this "
          "is what tells those two apart.")

    if present:
        for metric, filename, help_text in (
                ("memory_bytes", "memory.current",
                 "memory.current for every CI lane and its driver, summed by "
                 "the kernel."),
                ("memory_peak_bytes", "memory.peak",
                 "High-water mark since the slice was created. This is the "
                 "number host/systemd/app-ci.slice's comment asks to be "
                 "re-derived from after the first real job."),
                ("memory_max_bytes", "memory.max",
                 "The MemoryMax= ceiling. ABSENT when unlimited, which is the "
                 "silent failure ci.slice_limits exists to catch."),
                ("memory_high_bytes", "memory.high",
                 "The MemoryHigh= throttle watermark, NOT memory.low."),
                ("pids", "pids.current", "Tasks in the slice."),
                ("pids_max", "pids.max",
                 "The TasksMax= limit. ABSENT when unlimited.")):
            m.add("home_server_ci_slice_" + metric,
                  read_int(os.path.join(CI_SLICE, filename)), None, help_text)

        # A KILL HERE MEANS THE SIZING IS WRONG, NOT THAT A TEST IS FLAKY, and
        # the distinction matters more for CI than for the agent fleet: a job
        # killed by the kernel reports itself to GitHub as a failed step with no
        # useful message, and the obvious reading is that the code broke. `high`
        # is deliberately not exported - a slice doing file I/O accumulates it
        # for ever and it proves nothing.
        events = read_kv(os.path.join(CI_SLICE, "memory.events"))
        m.add("home_server_ci_slice_oom_total", events.get("oom_kill"), None,
              "Processes killed by the kernel for breaching the CI slice's "
              "memory ceiling. Non-zero means the per-lane limits are not "
              "binding before the slice does, which is what they are sized to "
              "do.", "counter")

    any_marker = False
    for lane in CI_LANES:
        state = _marker(_ci_marker(lane))
        if not state:
            continue
        any_marker = True
        labels = {"lane": str(lane)}

        for key, infix in CI_STAMPS:
            m.add("home_server_ci_%s_timestamp_seconds" % infix,
                  _epoch(state.get(key)), labels,
                  "From the lane's marker. A TIMESTAMP, not an age: the consumer "
                  "subtracts from time(), so a stopped driver shows as staleness "
                  "rather than freezing at its last value.")

        for key, suffix, help_text in CI_NUMBERS:
            value = _marker_number(state.get(key))
            if suffix == "lane_disk_megabytes" and value is not None:
                m.add("home_server_ci_lane_disk_bytes", value * (1 << 20),
                      labels, help_text)
                continue
            m.add("home_server_ci_" + suffix, value, labels, help_text)

        # A COUNTER, UNLIKE jobs_today, so rate() over it is meaningful. The
        # driver carries it across a unit restart by reading its own marker back,
        # which is what keeps it monotonic through the restarts that are this
        # design's normal operation.
        m.add("home_server_ci_jobs_total", _marker_number(state.get("jobs_total")),
              labels,
              "Jobs this lane has completed since the marker was first written. "
              "Monotonic across unit restarts, because the driver seeds it from "
              "the marker it wrote last.", "counter")

        m.add("home_server_ci_last_job_seconds",
              _marker_number(state.get("last_job_seconds")), labels,
              "How long this lane's last job took, wall clock, container start "
              "to container exit. Includes the runner picking the job up, so it "
              "is longer than the duration GitHub reports.")

    m.add("home_server_ci_marker_present", 1 if any_marker else 0, None,
          "1 when at least one CI lane has written its marker. Reads 0 on a host "
          "where no lane is enabled, which is what every ci check reports as a "
          "NOTE rather than a finding.")


# ------------------------------------------------------------------------------
# The applications - the SLOW tier
# ------------------------------------------------------------------------------
# Every one of these is reached with `podman exec`, which works whatever the
# network topology says and grants NO container any reachability it does not
# already have. That is the established house pattern here, and it is why
# net-arr, net-download, net-media and net-transcode stay sealed from each other
# while all of them can still be measured.
#
# It is also the one place where the diagnostic touches the patient: a poll
# forks a process INSIDE the container being measured. Bounded by the slow tier,
# by curl's own max-time and by a subprocess timeout, in that order.

REPO = os.path.dirname(os.path.dirname(os.path.realpath(__file__)))
ENV_FILE = os.path.join(REPO, ".env")


def load_env():
    """The .env, read directly rather than through the unit's EnvironmentFile=
    so that --print works from an interactive shell.

    Unlike bin/promote-transcoded.py's loader this DEGRADES rather than dying.
    There is a window during bin/render-env.sh when the file is absent or half
    written, and it must cost the application sources and nothing else - a
    reconciler that stops is safe, a monitor that stops is blind.
    """
    env = {}
    try:
        for line in read_text(ENV_FILE).splitlines():
            line = line.strip()
            if line and not line.startswith("#") and "=" in line:
                key, _, value = line.partition("=")
                env[key.strip()] = value.strip().strip('"').strip("'")
    except OSError:
        pass
    return env


# NOT EVERY IMAGE SHIPS curl, AND THE ONES THAT DO NOT FAILED SILENTLY FOR
# MONTHS. gluetun and jellyseerr carry wget and no curl, so every api_get
# against them returned None - and because each caller guards with
# `if isinstance(x, dict)`, that read as "the endpoint had nothing to say"
# rather than as an error. home_server_vpn_info was therefore NEVER ONCE
# EMITTED since the day it was written: absent from the TSDB, absent from the
# dashboard's VPN row, and reported by nothing, because the source still
# completed and still wrote home_server_collector_source_up 1.
#
# Same shape as the shellcheck leg that printed `all checks passed` over 2,224
# lines it had never read. A client that is missing is not a body that is empty.
CLIENT_UNAVAILABLE = object()

# Containers that answered neither curl nor wget on this run. Emitted as a
# series by main(), because the whole lesson above is that this failure has to
# be visible from outside: a source can lose an endpoint entirely and still
# report source_up 1, since one absent optional call is indistinguishable from
# one that legitimately had nothing to say.
MISSING_CLIENT = set()


def api_get(container, url, headers=None, timeout=12):
    """A GET inside a container, with the credential passed on STDIN not argv.

    `curl -K -` reads its entire configuration from stdin, so an API key never
    appears in the process list - which `podman exec ... -H "X-Api-Key: ..."`
    cannot avoid, and which matters more here than in a job that runs twice an
    hour, because this one runs 288 times a day.

    The wget fallback keeps that property rather than trading it away. wget has
    no config-file equivalent of -K, so the header cannot go in a file - but it
    can be read from stdin by a shell INSIDE the container and expanded there,
    which keeps it out of the host's process list just the same. What it does
    reach is that container's own `ps`, which is the same trust boundary the
    credential is already inside.

    Returns the decoded body, or None. Callers keep their existing
    `if isinstance(x, dict)` guards - what changes is that "this image has no
    HTTP client" now lands in MISSING_CLIENT and on stderr instead of vanishing.
    """
    headers = list(headers or [])
    config = ['url = "%s"' % url, "silent", "max-time = 8"]
    for header in headers:
        config.append('header = "%s"' % header)
    body = _exec_json(container, ["curl", "-K", "-"],
                      "\n".join(config) + "\n", timeout)
    if body is not CLIENT_UNAVAILABLE:
        return body

    # One header is all any caller here passes, and wget's --header can only be
    # given a literal - so the shell reads it and expands it, never argv.
    script = 'read -r h 2>/dev/null; exec wget -q -T 8 -O - --header="$h" "%s"' % url
    body = _exec_json(container, ["sh", "-c", script],
                      (headers[0] if headers else "") + "\n", timeout)
    if body is CLIENT_UNAVAILABLE:
        MISSING_CLIENT.add(container)
        print("collect-metrics: %s has neither curl nor wget; cannot poll %s"
              % (container, url), file=sys.stderr)
        return None
    return body


def _exec_json(container, argv, stdin, timeout):
    """Run argv in a container, decode JSON, and tell the two failures apart.

    A missing executable is exit 127 from the runtime, which is what separates
    "this image has no curl" from "the API refused". Conflating them is the bug
    this function exists to make impossible.
    """
    try:
        res = subprocess.run(["podman", "exec", "-i", container] + argv,
                             input=stdin, capture_output=True,
                             text=True, timeout=timeout, check=False)
    except (OSError, subprocess.SubprocessError):
        return CLIENT_UNAVAILABLE
    if res.returncode == 127 or "executable file" in (res.stderr or ""):
        return CLIENT_UNAVAILABLE
    if res.returncode != 0:
        return None
    try:
        return json.loads(res.stdout)
    except json.JSONDecodeError:
        return None


def source_arr(m):
    env = load_env()
    answered = 0

    for name, port in (("sonarr", 8989), ("radarr", 7878)):
        key = env.get("%s_API_KEY" % name.upper(), "")
        if not key:
            continue
        base = "http://localhost:%d/api/v3" % port
        hdr = ["X-Api-Key: " + key]

        status = api_get(name, base + "/queue/status", hdr)
        if isinstance(status, dict):
            answered += 1
            for field, state in (("totalCount", "total"),
                                 ("unknownCount", "unknown")):
                m.add("home_server_arr_queue_items", status.get(field),
                      {"service": name, "state": state},
                      "Items in the download queue.")
            m.add("home_server_arr_queue_errors",
                  1 if status.get("errors") else 0, {"service": name},
                  "The queue is reporting errors.")

        # HOW MANY INDEXERS REACHED THIS APPLICATION, which is a different
        # number from how many Prowlarr has, and the gap is the thing that was
        # invisible. Prowlarr pushes every indexer to every application and
        # retries the ones an application refuses, for ever, six-hourly, at
        # WARN - so a mismatch never surfaces anywhere a person looks. It cost
        # nine months of `Nyaa Trusted - Live Action` returning results in a
        # category neither Sonarr nor Radarr accepts.
        #
        # SOME GAP IS CORRECT and this metric deliberately does not judge:
        # a movies-only indexer belongs in Radarr and not Sonarr. Compare the
        # three series and read the log; do not alert on equality.
        indexers = api_get(name, base + "/indexer", hdr)
        if isinstance(indexers, list):
            m.add("home_server_arr_indexers", len(indexers), {"service": name},
                  "Indexers configured in this application.")

        health = api_get(name, base + "/health", hdr)
        _arr_health(m, name, health)
        if isinstance(health, list):
            answered += 1

    # Prowlarr. THE ONE THAT EARNS ITS KEEP: nothing else in the stack reports
    # that searching has quietly stopped working. Every container stays healthy,
    # every unit stays active, and the only symptom is that nothing is found.
    key = env.get("PROWLARR_API_KEY", "")
    if key:
        hdr = ["X-Api-Key: " + key]
        indexers = api_get("prowlarr", "http://localhost:9696/api/v1/indexer", hdr)
        statuses = api_get("prowlarr",
                           "http://localhost:9696/api/v1/indexerstatus", hdr)
        if isinstance(indexers, list):
            answered += 1
            failing = set()
            if isinstance(statuses, list):
                failing = {s.get("indexerId") for s in statuses
                           if s.get("disabledTill")}
            enabled = 0
            for indexer in indexers:
                if not indexer.get("enable"):
                    continue
                enabled += 1
                m.add("home_server_indexer_up",
                      0 if indexer.get("id") in failing else 1,
                      {"indexer": str(indexer.get("name", "?"))},
                      "0 while Prowlarr is backing off this indexer after "
                      "repeated failures. IT DOES NOT SAY WHY, and the causes "
                      "are not mostly local: measured on 2026-08-15, six zeros "
                      "were a dead mirror, its duplicate, two entries sharing "
                      "one refusing API host, a 502 and a 403. Read the "
                      "Prowlarr log before changing anything here.")
            m.add("home_server_arr_indexers", enabled, {"service": "prowlarr"},
                  "Indexers configured in this application.")
        _arr_health(m, "prowlarr",
                    api_get("prowlarr", "http://localhost:9696/api/v1/health", hdr))

    # Bazarr is NOT a Servarr application: different header, different API.
    key = env.get("BAZARR_API_KEY", "")
    if key:
        hdr = ["X-API-KEY: " + key]
        badges = api_get("bazarr", "http://localhost:6767/api/badges", hdr)
        if isinstance(badges, dict):
            answered += 1
            for field, kind in (("episodes", "episodes"), ("movies", "movies")):
                m.add("home_server_subtitles_missing", badges.get(field),
                      {"kind": kind}, "Items with subtitles still wanted.")

        # NOT `badges.providers`, WHICH COUNTS THE BROKEN ONES. This read
        # `home_server_subtitle_providers` from that field under the help text
        # "providers currently usable", and it was exactly inverted: with one
        # provider enabled and throttled it reported 1, and enabling five more
        # working ones moved it to 2. A wrong number under a right name cannot
        # be spotted from a dashboard, so the field is not used at all now.
        #
        # /api/providers is per-provider and says which. "Good" is Bazarr's own
        # word for usable; every other status - DownloadLimitExceeded, offline,
        # a login failure - is a provider that will not answer.
        providers = api_get("bazarr", "http://localhost:6767/api/providers", hdr)
        rows = providers.get("data") if isinstance(providers, dict) else None
        if isinstance(rows, list):
            answered += 1
            for row in rows:
                m.add("home_server_subtitle_provider_up",
                      1 if str(row.get("status", "")) == "Good" else 0,
                      {"provider": str(row.get("name", "?"))},
                      "0 while this subtitle provider is unusable - most often "
                      "a daily download quota, which is why ONE provider is a "
                      "single point of failure rather than a thin margin.")
            m.add("home_server_subtitle_providers_enabled", len(rows), None,
                  "Subtitle providers enabled, working or not.")

    if not answered:
        raise RuntimeError("no *arr application answered")


def _arr_health(m, service, health):
    """Health issues as a COUNT per severity, never as the message.

    The text is unstable by charter - these are the applications' own strings
    and they get reworded upstream - so a label carrying it would mint a fresh
    series on every release and leave the old one for the whole retention
    period. The count says something is wrong; the UI says what.
    """
    if not isinstance(health, list):
        return
    counts = {}
    for issue in health:
        counts[str(issue.get("type", "unknown")).lower()] = \
            counts.get(str(issue.get("type", "unknown")).lower(), 0) + 1
    for severity in ("error", "warning", "notice"):
        m.add("home_server_arr_health_issues", counts.get(severity, 0),
              {"service": service, "severity": severity},
              "Health issues the application reports, counted by severity.")


def source_jellyfin(m):
    """Jellyfin's CONFIGURATION, which changes rarely and belongs in the slow
    tier. The sessions moved to source_playback: a progress bar needs thirty
    seconds, not five minutes, and a metric name may appear in only one of the
    two .prom files - node-exporter concatenates them and a duplicate sample
    fails the whole scrape.
    """
    env = load_env()
    key = env.get("JELLYFIN_API_KEY", "")
    if not key:
        raise RuntimeError("JELLYFIN_API_KEY is not set")

    # THE FOUR SWITCHES THAT COST 87 HOURS OF CPU DECODE. Trickplay has its OWN
    # hardware-acceleration settings, independent of playback's, and all three
    # of them shipped off - so every frame of every file was decoded on the CPU
    # while playback acceleration looked perfectly healthy. They are on now;
    # this is what notices if any of them goes off again, which a UI toggle or a
    # config restore can do silently.
    encoding = api_get("jellyfin",
                       "http://localhost:8096/System/Configuration/encoding",
                       ["X-Emby-Token: " + key])
    system = api_get("jellyfin", "http://localhost:8096/System/Configuration",
                     ["X-Emby-Token: " + key])
    trickplay = (system or {}).get("TrickplayOptions") or {}
    for feature, value in (
            ("playback_encode", (encoding or {}).get("EnableHardwareEncoding")),
            ("trickplay_decode", trickplay.get("EnableHwAcceleration")),
            ("trickplay_encode", trickplay.get("EnableHwEncoding")),
            ("trickplay_keyframe_only",
             trickplay.get("EnableKeyFrameOnlyExtraction"))):
        if value is not None:
            m.add("home_server_jellyfin_hwaccel_enabled", 1 if value else 0,
                  {"feature": feature},
                  "Hardware acceleration switches. trickplay_* are independent "
                  "of playback's and all three once shipped off, which is what "
                  "made Jellyfin the largest CPU consumer on the host while "
                  "serving nobody. keyframe_only is the big lever.")
    if isinstance(encoding, dict):
        m.add("home_server_jellyfin_hwaccel_info", 1,
              {"type": str(encoding.get("HardwareAccelerationType", ""))},
              "Which hardware acceleration backend is selected.")
        codecs = encoding.get("HardwareDecodingCodecs")
        if isinstance(codecs, list):
            # A COUNT, not a label per codec. Reading this through a
            # line-matching grep is what made it look empty once: the opening
            # and closing tags sit on adjacent lines and hide the children.
            m.add("home_server_jellyfin_hwdecode_codecs", len(codecs), None,
                  "Codecs enabled for hardware decoding.")


def source_torrent(m):
    """qBittorrent needs NO credential from here, and that is not an oversight.

    WebUI\\LocalHostAuth is false, and `podman exec` lands inside the pod's
    network namespace where "localhost" means gluetun, qBittorrent and JOAL and
    nothing else. Proven twice over by things already in this repository: the
    unit's own healthcheck, and gluetun's port-forward push command, both
    unauthenticated. A request arriving over net-download as torrent:8200 is a
    different matter and would need a login.
    """
    env = load_env()
    port = env.get("PORT_QBITTORRENT_WEB", "8200")
    info = api_get("qbittorrent",
                   "http://localhost:%s/api/v2/transfer/info" % port)
    if not isinstance(info, dict):
        raise RuntimeError("qBittorrent did not answer")

    for field, direction in (("dl_info_data", "download"),
                             ("up_info_data", "upload")):
        m.add("home_server_torrent_bytes_total", info.get(field),
              {"direction": direction},
              "Session traffic. Resets when the client restarts, which is what "
              "a counter reset means and Prometheus already handles.", "counter")
    for field, direction in (("dl_info_speed", "download"),
                             ("up_info_speed", "upload")):
        m.add("home_server_torrent_rate_bytes_per_second", info.get(field),
              {"direction": direction}, "Current transfer rate.")
    m.add("home_server_torrent_dht_nodes", info.get("dht_nodes"), None,
          "DHT nodes known.")
    m.add("home_server_torrent_connection_state",
          {"connected": 0, "firewalled": 1}.get(
              str(info.get("connection_status")), 2), None,
          "0 connected, 1 firewalled, 2 disconnected. Firewalled means the "
          "forwarded port and the listen port have drifted apart, which is "
          "silent from every other angle.")

    # THE PORT NUMBER IS THE VALUE, not a label. As a label it would be
    # unbounded - ProtonVPN hands out a different one on every reconnect - and
    # as a value the check that matters is one subtraction.
    prefs = api_get("qbittorrent",
                    "http://localhost:%s/api/v2/app/preferences" % port)
    if isinstance(prefs, dict):
        m.add("home_server_torrent_listen_port", prefs.get("listen_port"), None,
              "The port qBittorrent is listening on. Compare with the port the "
              "VPN is forwarding: if they differ, the client is unconnectable "
              "and nothing else says so.")

    # THE FORWARDED PORT HAS NO READABLE SOURCE HERE, and it is worth writing
    # down why rather than rediscovering it. gluetun writes no port file unless
    # VPN_PORT_FORWARDING_STATUS_FILE is set, which the quadlet does not set,
    # and since v3.40 its control server answers 401 on everything except
    # /v1/publicip/ip - the auth config would be a new secret for one number.
    #
    # What is NOT lost: gluetun pushes the forwarded port into qBittorrent on
    # every reconnect, so home_server_torrent_listen_port above already carries
    # the value that push produced, and home_server_torrent_connection_state
    # reports `firewalled` when the two have drifted - which is the consequence
    # the port number was only ever a proxy for.
    location = api_get("gluetun", "http://127.0.0.1:8000/v1/publicip/ip")
    if isinstance(location, dict):
        # The exit IP is deliberately NOT a label: it changes on every
        # reconnect, so it would mint a new series a day for ever. The region
        # does not, and answers the question actually being asked - is the
        # tunnel up, and is it landing where it should.
        m.add("home_server_vpn_info", 1,
              {"country": str(location.get("country", "")),
               "city": str(location.get("city", "")),
               "organization": str(location.get("organization", ""))},
              "Where the VPN is currently exiting. The tunnel being up at all "
              "is home_server_container_health{container=\"gluetun\"}, which "
              "has a 5s interval because it is the kill-switch.")


def source_tdarr(m):
    """Tdarr's file table is the QUEUE, not a history.

    filejsondb drains to zero by design: every library watches
    library/queued/<type> only, and the flow moves output to transcoded/<type>,
    outside every watched folder - so the folder watcher reaps each file as it
    is promoted. A short table means the queue is empty, which is the goal, and
    that is why this is a GAUGE. The durable history lives in jobsjsondb and is
    deliberately not pulled here: getAll over thousands of rows every five
    minutes would cost more than it tells anyone.
    """
    body = json.dumps({"data": {"collection": "FileJSONDB", "mode": "getAll"}})
    try:
        res = subprocess.run(
            ["podman", "exec", "-i", "tdarr-server", "curl", "-s",
             "--max-time", "10", "-X", "POST",
             "-H", "Content-Type: application/json", "--data-binary", "@-",
             "http://localhost:8266/api/v2/cruddb"],
            input=body, capture_output=True, text=True, timeout=20, check=False)
    except (OSError, subprocess.SubprocessError):
        raise RuntimeError("tdarr did not answer")
    if res.returncode != 0:
        raise RuntimeError("tdarr returned %d" % res.returncode)
    rows = json.loads(res.stdout)
    if not isinstance(rows, list):
        raise RuntimeError("unexpected cruddb response")

    verdicts = {}
    for row in rows:
        if not isinstance(row, dict):
            continue
        verdict = str(row.get("TranscodeDecisionMaker") or "unknown").lower()
        verdicts[verdict.replace(" ", "_")] = \
            verdicts.get(verdict.replace(" ", "_"), 0) + 1
    for verdict, count in sorted(verdicts.items()):
        m.add("home_server_tdarr_queue_files", count, {"verdict": verdict},
              "Files in Tdarr's library table, by its verdict. A GAUGE, and it "
              "drains to zero by design - a file still here carrying a finished "
              "verdict is one the flow abandoned.")
    m.add("home_server_tdarr_queue_files_total", len(rows), None,
          "Files Tdarr currently has in its library table.")


# ------------------------------------------------------------------------------
# The documents: what is playing, what is in flight, what the library holds
# ------------------------------------------------------------------------------
# Everything below writes a JSON document as well as, or instead of, series.
# Read the DOC_* comment at the top of this file before adding to any of them -
# particularly the part about why a session is not labelled.

TICKS_PER_SECOND = 10_000_000


def _seconds(ticks):
    """Jellyfin counts in 100ns units. The division belongs here, not in the
    browser: a client holding someone else's unit is how a number ends up out by
    a factor of ten million with nothing to catch it."""
    if not isinstance(ticks, (int, float)):
        return None
    return round(ticks / TICKS_PER_SECOND, 3)


def _poster(item):
    """(path, tag) for the dashboard's image proxy, or (None, None).

    The path is bare and the tag is separate so the client can append its own
    maxHeight without having to know whether a `?` is already there. An episode
    borrows its series' poster, because a per-episode image is usually a
    screenshot and reads as noise at 22x32.
    """
    if not isinstance(item, dict):
        return None, None
    tags = item.get("ImageTags") or {}
    if tags.get("Primary") and item.get("Id"):
        return "Items/%s/Images/Primary" % item["Id"], str(tags["Primary"])
    if item.get("SeriesPrimaryImageTag") and item.get("SeriesId"):
        return ("Items/%s/Images/Primary" % item["SeriesId"],
                str(item["SeriesPrimaryImageTag"]))
    return None, None


def _episode_label(item):
    """"S02E05", or the year for a film, or None."""
    if not isinstance(item, dict):
        return None
    if item.get("Type") == "Episode":
        season, number = item.get("ParentIndexNumber"), item.get("IndexNumber")
        if isinstance(season, int) and isinstance(number, int):
            return "S%02dE%02d" % (season, number)
        return str(item.get("SeasonName") or "") or None
    year = item.get("ProductionYear")
    return str(year) if year else None


def source_playback(m, doc):
    """Who is watching what, at thirty-second resolution.

    THE COUNTS CARRY NO IDENTITY AND THE DOCUMENT DOES. That is the whole
    distinction this file is built on: home_server_jellyfin_sessions is a
    400-day series and is therefore labelled by playback method only, because a
    retained record of who watched what is surveillance of the household. The
    document below names titles and devices and is overwritten every thirty
    seconds with no history anywhere. Do not move a field from one to the other
    without re-reading that sentence.
    """
    env = load_env()
    key = env.get("JELLYFIN_API_KEY", "")
    if not key:
        # Note BEFORE raising. `sources` is the contract that keeps "did not
        # answer" distinguishable from "nothing to report", and a source that
        # raises its way out without recording anything breaks exactly that -
        # the key would be absent, which is the one thing the document promises
        # never happens.
        doc.note("jellyfin", False, "JELLYFIN_API_KEY is not set")
        doc.set("sessions", [])
        raise RuntimeError("JELLYFIN_API_KEY is not set")
    sessions = api_get("jellyfin", "http://localhost:8096/Sessions",
                       ["X-Emby-Token: " + key])
    if not isinstance(sessions, list):
        doc.note("jellyfin", False, "sessions did not answer")
        doc.set("sessions", [])
        raise RuntimeError("unexpected /Sessions response")

    methods = {"directplay": 0, "directstream": 0, "transcode": 0}
    playing = []
    for session in sessions:
        item = session.get("NowPlayingItem")
        state = session.get("PlayState") or {}
        if not item:
            continue
        method = str(state.get("PlayMethod") or "").lower()
        methods[method] = methods.get(method, 0) + 1

        # TranscodingInfo is ABSENT ENTIRELY on a direct play, not an empty
        # object - so its presence is the signal and `.get` on a None would
        # raise. UNVERIFIED BRANCH: nothing was transcoding when this was
        # written, so the hardware field below is read defensively and reports
        # null rather than false when it cannot tell. null renders as a plain
        # TRANSCODE badge; false renders as SW TRANSCODE, which is a much
        # stronger claim and must not be made by accident.
        transcoding = session.get("TranscodingInfo")
        hardware = None
        if isinstance(transcoding, dict):
            accel = transcoding.get("HardwareAccelerationType")
            if accel not in (None, ""):
                hardware = str(accel).lower() not in ("none",)
        poster, tag = _poster(item)
        playing.append({
            "id": str(session.get("Id") or item.get("Id") or ""),
            "item_id": str(item.get("Id") or "") or None,
            "title": str(item.get("Name") or "?"),
            "series": str(item.get("SeriesName") or "") or None,
            "sub": _episode_label(item),
            "kind": "series" if item.get("Type") == "Episode" else "movie",
            "user": str(session.get("UserName") or "") or None,
            "client": str(session.get("Client") or "") or None,
            "device": str(session.get("DeviceName") or "") or None,
            # RemoteEndPoint is DELIBERATELY NOT CARRIED. Every session reports
            # Caddy's own net-media address, because everything reaches Jellyfin
            # through the proxy - so a local/remote badge built on it would be
            # confidently wrong for every row, which cannot be spotted from a
            # dashboard. DeviceName and Client are what actually distinguish.
            "method": method or None,
            "hardware": hardware,
            "paused": bool(state.get("IsPaused")),
            "position_s": _seconds(state.get("PositionTicks")),
            "runtime_s": _seconds(item.get("RunTimeTicks")),
            "width": item.get("Width"),
            "height": item.get("Height"),
            "poster": poster,
            "poster_tag": tag,
        })

    for method, count in sorted(methods.items()):
        m.add("home_server_jellyfin_sessions", count,
              {"playback_method": method},
              "Sessions actively playing something. A transcode is the "
              "expensive case and the one worth watching.")
    m.add("home_server_jellyfin_sessions_total", len(sessions), None,
          "Connected sessions, playing or not.")
    doc.set("sessions", playing)
    doc.note("jellyfin", True)


# How an *arr tracked-download state and a qBittorrent state become the one
# vocabulary the dashboard renders. Both maps are exhaustive on purpose: an
# unrecognised value falls through to a named state rather than to nothing, so a
# new upstream string shows up as a row somebody can see instead of a row that
# silently disappears.
ARR_STATES = {
    "downloading": "downloading",
    "importpending": "importing",
    "importing": "importing",
    "importblocked": "error",
    "failedpending": "error",
    "failed": "error",
    "ignored": "queued",
}
QBT_STATES = {
    "downloading": "downloading", "metadl": "downloading",
    "forceddl": "downloading", "alloc": "downloading",
    "stalleddl": "stalled",
    "uploading": "seeding", "forcedup": "seeding",
    "stalledup": "seeding", "queuedup": "seeding",
    "checkingdl": "importing", "checkingup": "importing",
    "checkingresumedata": "importing", "moving": "importing",
    "pauseddl": "queued", "queueddl": "queued", "stoppeddl": "queued",
    "pausedup": "seeding", "stoppedup": "seeding",
    "error": "error", "missingfiles": "error",
}


def source_transfers(m, doc):
    """What is in flight, with a progress bar attached.

    Everything here changes by the second, which is why it is in the fast tier
    while the *arr counts and the Tdarr verdicts stay in the slow one.

    THE *arr QUEUE OWNS AN IN-FLIGHT ITEM AND qBITTORRENT OWNS A SEEDING ONE,
    joined on downloadId, which IS the torrent hash. Without that join the same
    film is two rows - one from each side - for the whole of its download, and
    the design's table is one row per file. The *arr side wins while it is
    tracking, because it is the side that knows the title and why an import
    failed; qBittorrent's row appears once the queue has let go of it.
    """
    env = load_env()
    rows = []
    tracked = set()

    for name, port in (("sonarr", 8989), ("radarr", 7878)):
        key = env.get("%s_API_KEY" % name.upper(), "")
        if not key:
            doc.note(name, False, "no API key")
            continue
        queue = api_get(name, "http://localhost:%d/api/v3/queue"
                        "?pageSize=100&includeMovie=true&includeEpisode=true"
                        % port, ["X-Api-Key: " + key])
        records = queue.get("records") if isinstance(queue, dict) else None
        if not isinstance(records, list):
            doc.note(name, False, "queue did not answer")
            continue
        doc.note(name, True)
        for rec in records:
            if not isinstance(rec, dict):
                continue
            if rec.get("downloadId"):
                tracked.add(str(rec["downloadId"]).lower())
            rows.append(_arr_row(name, rec))

    # Tdarr's WORKERS, not its file table: the table says what a file's verdict
    # was, and only a live worker knows a transcode is running and how far in.
    nodes = api_get("tdarr-server", "http://localhost:8266/api/v2/get-nodes")
    if isinstance(nodes, dict):
        doc.note("tdarr", True)
        for node in nodes.values():
            if not isinstance(node, dict):
                continue
            for worker in (node.get("workers") or {}).values():
                if isinstance(worker, dict):
                    rows.append(_tdarr_row(node, worker))
    else:
        doc.note("tdarr", False, "get-nodes did not answer")

    port = env.get("PORT_QBITTORRENT_WEB", "8200")
    torrents = api_get("qbittorrent",
                       "http://localhost:%s/api/v2/torrents/info" % port)
    if isinstance(torrents, list):
        doc.note("qbittorrent", True)
        states = {}
        for tor in torrents:
            if not isinstance(tor, dict):
                continue
            state = QBT_STATES.get(str(tor.get("state") or "").lower(), "queued")
            states[state] = states.get(state, 0) + 1
            if str(tor.get("hash") or "").lower() in tracked:
                continue
            rows.append(_qbt_row(tor, state))
        for state, count in sorted(states.items()):
            m.add("home_server_torrent_count", count, {"state": state},
                  "Torrents by the state the dashboard groups them under. A "
                  "COUNT, so it is safe to retain - the names are in the "
                  "document, which is not.")
    else:
        doc.note("qbittorrent", False, "torrents did not answer")

    doc.set("transfers", rows)
    counts = {}
    for row in rows:
        counts[row["state"]] = counts.get(row["state"], 0) + 1
    for state, count in sorted(counts.items()):
        m.add("home_server_pipeline_items", count, {"state": state},
              "Items in flight, by pipeline state. The titles are in "
              "activity.json; only the counts are retained.")


def _arr_row(service, rec):
    movie = rec.get("movie") if isinstance(rec.get("movie"), dict) else None
    episode = rec.get("episode") if isinstance(rec.get("episode"), dict) else None
    size = rec.get("size")
    left = rec.get("sizeleft")
    progress = None
    if isinstance(size, (int, float)) and size > 0 and isinstance(left, (int, float)):
        progress = round(max(0.0, min(1.0, 1.0 - left / size)), 4)

    state = ARR_STATES.get(str(rec.get("trackedDownloadState") or "").lower(),
                           "downloading")
    # A warning or error on the tracked status outranks the state: "downloading"
    # with a statusMessage is what a stalled or unimportable item looks like,
    # and reporting it as an ordinary download is how it stays invisible.
    status = str(rec.get("trackedDownloadStatus") or "").lower()
    messages = []
    for entry in (rec.get("statusMessages") or []):
        if isinstance(entry, dict):
            messages.extend(str(x) for x in (entry.get("messages") or []))
    if status == "error":
        state = "error"
    elif status == "warning" and state == "downloading":
        state = "stalled"

    title = None
    if movie:
        title = movie.get("title")
    elif episode:
        title = rec.get("title")
    quality = ((rec.get("quality") or {}).get("quality") or {}).get("name")
    return {
        "id": "%s:queue:%s" % (service, rec.get("id")),
        "title": str(title or rec.get("title") or "?"),
        "sub": (str(movie.get("year")) if movie and movie.get("year")
                else _arr_episode_label(episode)),
        "kind": "movie" if service == "radarr" else "series",
        "state": state,
        "progress": progress,
        "size": size if isinstance(size, (int, float)) else None,
        "rate_bps": None,
        "rate_note": str(rec.get("timeleft") or "") or None,
        "note": (messages[0] if messages else None),
        "source": service,
        "quality": str(quality) if quality else None,
        "poster": None,
        "poster_tag": None,
        "app": service,
        "app_slug": _arr_slug(movie, rec),
        "path": None,
    }


def _arr_episode_label(episode):
    if not isinstance(episode, dict):
        return None
    season, number = episode.get("seasonNumber"), episode.get("episodeNumber")
    if isinstance(season, int) and isinstance(number, int):
        return "S%02dE%02d" % (season, number)
    return None


def _arr_slug(movie, rec):
    """Radarr's titleSlug is the tmdbId as a string; Sonarr's is a real slug.
    Either way it is what the application's own URL takes, so it travels rather
    than being reconstructed in the browser from a guess."""
    if isinstance(movie, dict) and movie.get("titleSlug"):
        return str(movie["titleSlug"])
    series = rec.get("series")
    if isinstance(series, dict) and series.get("titleSlug"):
        return str(series["titleSlug"])
    return None


def _tdarr_row(node, worker):
    path = str(worker.get("file") or "")
    pct = worker.get("percentage")
    fps = worker.get("fps")
    return {
        "id": "tdarr:%s" % (path or worker.get("_id") or "?"),
        "title": os.path.splitext(os.path.basename(path))[0] or "?",
        "sub": None,
        "kind": None,
        "state": "transcoding",
        "progress": (round(max(0.0, min(1.0, float(pct) / 100.0)), 4)
                     if isinstance(pct, (int, float)) else None),
        "size": None,
        "rate_bps": None,
        "rate_note": ("%.0f fps" % fps if isinstance(fps, (int, float)) and fps
                      else str(worker.get("ETA") or "") or None),
        "note": str(node.get("nodeName") or "") or None,
        "source": "tdarr",
        "quality": str(worker.get("outputFileSizeInGbytes") or "") or None,
        "poster": None,
        "poster_tag": None,
        "app": "tdarr",
        "app_slug": None,
        "path": path or None,
    }


def _qbt_row(tor, state):
    progress = tor.get("progress")
    ratio = tor.get("ratio")
    up = tor.get("upspeed")
    down = tor.get("dlspeed")
    rate = down if state in ("downloading", "stalled") else up
    return {
        "id": "qbt:%s" % str(tor.get("hash") or "?"),
        "title": str(tor.get("name") or "?"),
        "sub": None,
        "kind": {"radarr": "movie", "sonarr": "series"}.get(
            str(tor.get("category") or "")),
        "state": state,
        "progress": (round(max(0.0, min(1.0, float(progress))), 4)
                     if isinstance(progress, (int, float)) else None),
        "size": tor.get("size") if isinstance(tor.get("size"), int) else None,
        # ZERO IS A FACT HERE, NOT A MISSING VALUE. A seeding torrent with no
        # peers really is transferring 0 B/s, and collapsing that to null would
        # make it indistinguishable from a rate nobody measured - which is the
        # same distinction format.ts draws by returning "-" for NaN and never
        # for 0. The UI decides whether to show the rate or the ratio; the
        # document just says what is true.
        "rate_bps": rate if isinstance(rate, (int, float)) else None,
        "rate_note": ("ratio %.2f" % ratio
                      if isinstance(ratio, (int, float)) else None),
        "note": str(tor.get("category") or "") or None,
        "source": "qbittorrent",
        "quality": None,
        "poster": None,
        "poster_tag": None,
        "app": "qbittorrent",
        "app_slug": None,
        "path": str(tor.get("content_path") or "") or None,
    }


def source_requests(m, doc):
    """Jellyseerr: the one thing here somebody else is waiting on.

    THE KEY IS READ FROM JELLYSEERR'S OWN CONFIG rather than copied into sops.
    Prowlarr's and Bazarr's keys were read out of their config files once and
    then stored, which is fine for a value nothing regenerates - but Jellyseerr
    writes this one itself, so a stored copy is a second truth that goes stale
    silently the first time it is rotated. config/ is backed up, so nothing is
    lost by reading it where it lives.

    A REQUEST CARRIES NO TITLE, which is the awkward part of this API: only a
    tmdbId. An available request can borrow Jellyfin's copy through
    jellyfinMediaId, but a pending one - exactly the case this panel exists for
    - has no Jellyfin item at all, so its title costs one call to Jellyseerr's
    own TMDB proxy. That is why REQUEST_TITLE_BUDGET exists and why it is
    logged: the panel shows a handful, not all 104.
    """
    settings = os.path.join(REPO, "config", "jellyseerr", "settings.json")
    try:
        key = (json.loads(read_text(settings)).get("main") or {}).get("apiKey")
    except (OSError, ValueError, AttributeError):
        key = None
    if not key:
        doc.note("jellyseerr", False, "no API key in settings.json")
        doc.set("requests", [])
        raise RuntimeError("jellyseerr apiKey unreadable")

    hdr = ["X-Api-Key: " + str(key)]
    base = "http://127.0.0.1:5055/api/v1"
    counts = api_get("jellyseerr", base + "/request/count", hdr)
    if not isinstance(counts, dict):
        doc.note("jellyseerr", False, "request/count did not answer")
        doc.set("requests", [])
        raise RuntimeError("jellyseerr did not answer")

    for field in ("total", "pending", "approved", "processing", "available",
                  "declined"):
        m.add("home_server_requests", counts.get(field), {"status": field},
              "Jellyseerr requests by status. Counts only - the titles live in "
              "library.json, which is not retained.")

    listing = api_get("jellyseerr", base + "/request?take=%d&sort=added"
                      % REQUEST_TITLE_BUDGET, hdr)
    results = listing.get("results") if isinstance(listing, dict) else None
    rows = []
    resolved = 0
    if isinstance(results, list):
        for req in results:
            if not isinstance(req, dict):
                continue
            media = req.get("media") or {}
            kind = "series" if str(req.get("type")) == "tv" else "movie"
            title, year, poster, tag = None, None, None, None

            # An available request has a Jellyfin item, so its poster comes from
            # the same image proxy as everything else. A pending one does not,
            # and Jellyseerr's own /imageproxy answers 400 for every path tried
            # - through its public route too - so there is no second proxy to
            # build. poster stays null and the UI owns the placeholder.
            if media.get("jellyfinMediaId"):
                # No tag, because getting one costs a Jellyfin call per request
                # for three mini-posters. The URL still resolves; it just does
                # not get the long immutable cache a tagged one does, which is
                # the documented behaviour of the proxy rather than a hole in it.
                poster = "Items/%s/Images/Primary" % media["jellyfinMediaId"]

            tmdb = media.get("tmdbId")
            if tmdb and resolved < REQUEST_TITLE_BUDGET:
                path = "/movie/%s" % tmdb if kind == "movie" else "/tv/%s" % tmdb
                detail = api_get("jellyseerr", base + path, hdr)
                resolved += 1
                if isinstance(detail, dict):
                    title = detail.get("title") or detail.get("name")
                    date = str(detail.get("releaseDate")
                               or detail.get("firstAirDate") or "")
                    year = date[:4] or None
            rows.append({
                "id": "jellyseerr:%s" % req.get("id"),
                "title": str(title or "request %s" % req.get("id")),
                "year": year,
                "kind": kind,
                "status": _request_status(req, media),
                "status_code": req.get("status"),
                "media_status_code": media.get("status"),
                "requested_by": str((req.get("requestedBy") or {})
                                    .get("displayName") or "") or None,
                "requested_at": str(req.get("createdAt") or "") or None,
                "poster": poster,
                "poster_tag": tag,
                "jellyfin_id": str(media.get("jellyfinMediaId") or "") or None,
            })
    if isinstance(results, list) and len(results) >= REQUEST_TITLE_BUDGET:
        print("collect-metrics: request list capped at %d of %s"
              % (REQUEST_TITLE_BUDGET, counts.get("total")), file=sys.stderr)

    doc.set("requests", rows)
    doc.set("request_counts", {k: counts.get(k) for k in
                               ("total", "pending", "approved", "processing",
                                "available", "declined")})
    doc.note("jellyseerr", True)


# Jellyseerr's MediaStatus, from its own server/constants/media.ts. Carried as
# BOTH the integer and a derived string: the integer because it is the wire
# value and this mapping is somebody else's to change, the string because a
# dashboard must not hard-code a foreign enum. If they ever disagree, the
# integer is authoritative and this table is the bug.
MEDIA_STATUS = {1: "unknown", 2: "pending", 3: "processing",
                4: "partial", 5: "available"}


def _request_status(req, media):
    if req.get("status") == 1:
        return "pending"
    if req.get("status") == 3:
        return "declined"
    return MEDIA_STATUS.get(media.get("status"), "unknown")


# The two rules below are DUPLICATED FROM bin/promote-transcoded.py, which is
# authoritative and carries the reasoning at length. They are copied rather than
# imported because that script's filename is not importable and its load_env
# deliberately DIES where this one degrades - "a reconciler that stops is safe,
# a monitor that stops is blind" - so a shared module would have to flatten the
# one difference that matters. CHANGE THEM TOGETHER: if the reconciler and the
# dashboard disagree about which files are stuck, the dashboard is wrong.
VIDEO_EXTENSIONS = (".mkv", ".mp4", ".m4v", ".avi", ".mov", ".ts", ".m2ts",
                    ".wmv", ".flv", ".webm", ".mpg", ".mpeg", ".vob", ".evo")
TDARR_DONE_VERDICTS = ("Not required", "Transcode success")


def _has_video(directory):
    """True if the directory holds a video file, at any depth.

    IT MUST NOT TEST FOR THE DIRECTORY. Tdarr deletes the video with
    deleteParentFolderIfEmpty, but Radarr and Sonarr leave fanart.jpg,
    poster.jpg and a .nfo behind - so the folder is never empty, never removed,
    and a directory test reports every promoted film as still queued. That
    mistake silently disabled promote-transcoded.py for nine months.
    """
    try:
        for _root, _dirs, files in os.walk(directory):
            for name in files:
                if name.lower().endswith(VIDEO_EXTENSIONS):
                    return True
    except OSError:
        pass
    return False


def source_catalogue(m, doc):
    """What the library holds, what landed recently, and what is stuck.

    The walk over queued/ is metadata only - 70 directories and no file reads -
    which matters because CLAUDE.md measures this spindle losing 45% of its
    throughput to a second concurrent reader. Measured at 0.001 s.
    """
    env = load_env()
    key = env.get("JELLYFIN_API_KEY", "")
    if key:
        hdr = ["X-Emby-Token: " + key]
        counts = api_get("jellyfin", "http://localhost:8096/Items/Counts", hdr)
        if isinstance(counts, dict):
            for field, kind in (("MovieCount", "movies"),
                                ("SeriesCount", "series"),
                                ("EpisodeCount", "episodes")):
                m.add("home_server_library_items", counts.get(field),
                      {"kind": kind}, "Items Jellyfin can see, by kind.")
        latest = api_get("jellyfin",
                         "http://localhost:8096/Items?SortBy=DateCreated"
                         "&SortOrder=Descending&Recursive=true"
                         "&IncludeItemTypes=Movie,Episode&Limit=200"
                         "&Fields=DateCreated,SeriesName,ProductionYear", hdr)
        items = latest.get("Items") if isinstance(latest, dict) else None
        if isinstance(items, list):
            doc.note("jellyfin", True)
            week = now() - 7 * 86400
            recent, done = [], []
            for item in items:
                row = _library_row(item)
                if len(recent) < 12:
                    recent.append(row)
                added = _epoch(str(item.get("DateCreated") or "")[:19] + "Z")
                if added and added >= week:
                    done.append(row)
            doc.set("recently_added", recent)
            doc.set("recently_added_total", len(done))
            doc.set("done", done[:120])
            m.add("home_server_library_added_7d", len(done), None,
                  "Items Jellyfin first saw in the last seven days.")
        else:
            doc.note("jellyfin", False, "item list did not answer")
    else:
        doc.note("jellyfin", False, "JELLYFIN_API_KEY is not set")

    _library_sizes(m, env, doc)
    doc.set("attention", _attention_rows(m, doc))
    doc.set("totals", _subtitle_totals(m, env, doc))


def _subtitle_totals(m, env, doc):
    """The subtitle backlog, per ITEM - which is not the number already on the
    dashboard, and the difference is not a bug in either.

    home_server_subtitles_missing comes from Bazarr's badges and counts missing
    subtitle FILES: 1,038. This counts EPISODES with at least one missing
    subtitle: 543. Most episodes here want both English and French, so
    543 x ~2 ~= 1,038. Two different questions, so two different names - a
    second series called subtitles_missing_something would be indistinguishable
    from the first on a dashboard, which is the mistake
    home_server_container_memory_high_bytes exists to avoid.
    """
    totals = {"no_subtitle_episodes": None, "no_subtitle_movies": None}
    key = env.get("BAZARR_API_KEY", "")
    if not key:
        doc.note("bazarr", False, "no API key")
        return totals
    hdr = ["X-API-KEY: " + key]
    answered = False
    for path, field, kind in (("episodes", "no_subtitle_episodes", "episodes"),
                              ("movies", "no_subtitle_movies", "movies")):
        wanted = api_get("bazarr",
                         "http://localhost:6767/api/%s/wanted?length=1" % path,
                         hdr)
        if isinstance(wanted, dict) and isinstance(wanted.get("total"), int):
            answered = True
            totals[field] = wanted["total"]
            m.add("home_server_subtitles_wanted_items", wanted["total"],
                  {"kind": kind},
                  "Items with at least one missing subtitle. NOT the same as "
                  "home_server_subtitles_missing, which counts missing subtitle "
                  "FILES - most episodes here want two languages, so that "
                  "number is roughly twice this one.")
    doc.note("bazarr", answered, None if answered else "wanted did not answer")
    return totals


def _library_row(item):
    poster, tag = _poster(item)
    return {
        "id": "jf:%s" % item.get("Id"),
        "item_id": str(item.get("Id") or "") or None,
        "title": str(item.get("SeriesName") or item.get("Name") or "?"),
        "sub": _episode_label(item),
        "kind": "series" if item.get("Type") == "Episode" else "movie",
        "state": "done",
        "progress": 1.0,
        "size": None,
        "rate_bps": None,
        "rate_note": None,
        "note": None,
        "source": "jellyfin",
        "quality": None,
        "poster": poster,
        "poster_tag": tag,
        "app": "jellyfin",
        "app_slug": None,
        "added_at": str(item.get("DateCreated") or "") or None,
        "path": None,
    }


def _library_sizes(m, env, doc):
    """Bytes and items per library, from the *arr records rather than from du.

    A `du` over 7.3 TB on a 7200rpm spindle is minutes of head travel for a
    number both applications already hold exactly. The root folder is what
    distinguishes the four libraries, and queued/ against transcoded/ is what
    distinguishes "waiting" from "served".
    """
    for name, port, path in (("radarr", 7878, "/api/v3/movie"),
                             ("sonarr", 8989, "/api/v3/series")):
        key = env.get("%s_API_KEY" % name.upper(), "")
        if not key:
            doc.note(name, False, "no API key")
            continue
        records = api_get(name, "http://localhost:%d%s" % (port, path),
                          ["X-Api-Key: " + key])
        if not isinstance(records, list):
            doc.note(name, False, "library list did not answer")
            continue
        doc.note(name, True)
        items, sizes, files = {}, {}, {}
        for rec in records:
            if not isinstance(rec, dict):
                continue
            root = str(rec.get("rootFolderPath") or "").rstrip("/")
            label = root.rsplit("/", 1)[-1] or "?"
            stage = "transcoded" if "/transcoded/" in root + "/" else "queued"
            bucket = (label, stage)
            items[bucket] = items.get(bucket, 0) + 1
            stats = rec.get("statistics") or {}
            sizes[bucket] = sizes.get(bucket, 0) + (
                stats.get("sizeOnDisk") or rec.get("sizeOnDisk") or 0)
            files[bucket] = files.get(bucket, 0) + (
                stats.get("episodeFileCount")
                or (1 if rec.get("hasFile") else 0))
        for (label, stage), count in sorted(items.items()):
            labels = {"library": label, "stage": stage}
            m.add("home_server_library_records", count, labels,
                  "Records the *arr application holds for this library and "
                  "stage. A record with no file is a wanted item, not a file.")
            m.add("home_server_library_files", files.get((label, stage), 0),
                  labels, "Media files present for this library and stage.")
            m.add("home_server_library_bytes", sizes.get((label, stage), 0),
                  labels, "Bytes on disk, as the *arr application accounts for "
                  "them. Not a du - see _library_sizes.")


def _attention_rows(m, doc):
    """Files that are stuck, and the difference between stuck and patient.

    `gone=False, arrived=False` is what a live transcode looks like AND what an
    abandoned one looks like, which is why promote-transcoded.py used to report
    an abandoned file as "waiting on Tdarr" for ever. A file still sitting in
    queued/ with its video intact, against which Tdarr has already recorded a
    finished verdict, is one the flow gave up on - and that is the one finding
    on this page that nothing else in the stack surfaces.
    """
    finished = set()
    body = json.dumps({"data": {"collection": "FileJSONDB", "mode": "getAll"}})
    try:
        res = subprocess.run(
            ["podman", "exec", "-i", "tdarr-server", "curl", "-s",
             "--max-time", "10", "-X", "POST",
             "-H", "Content-Type: application/json", "--data-binary", "@-",
             "http://localhost:8266/api/v2/cruddb"],
            input=body, capture_output=True, text=True, timeout=20, check=False)
        rows = json.loads(res.stdout) if res.returncode == 0 else None
        if isinstance(rows, list):
            for row in rows:
                if (isinstance(row, dict)
                        and str(row.get("TranscodeDecisionMaker") or "")
                        in TDARR_DONE_VERDICTS):
                    finished.add(str(row.get("file") or ""))
    except (OSError, subprocess.SubprocessError, ValueError):
        pass

    out = []
    stalled = queued = 0
    for kind in MEDIA_TYPES:
        root = os.path.join(MEDIA_HOST, "queued", kind)
        try:
            entries = sorted(os.scandir(root), key=lambda e: e.name)
        except OSError:
            continue
        for entry in entries:
            if not entry.is_dir() or not _has_video(entry.path):
                continue
            tdarr_path = entry.path.replace(MEDIA_HOST, MEDIA_TDARR, 1)
            abandoned = any(p.startswith(tdarr_path) for p in finished)
            stalled += 1 if abandoned else 0
            queued += 0 if abandoned else 1
            out.append({
                "id": "queued:%s" % entry.path,
                "title": entry.name,
                "sub": None,
                "kind": "movie" if kind in ("movies", "documentaries") else "series",
                "state": "stalled" if abandoned else "queued",
                "progress": None,
                "size": None,
                "rate_bps": None,
                "rate_note": None,
                "note": ("Tdarr recorded a finished verdict and the file is "
                         "still here" if abandoned else None),
                "source": "tdarr" if abandoned else "filesystem",
                "quality": None,
                "poster": None,
                "poster_tag": None,
                "app": "tdarr" if abandoned else None,
                "app_slug": None,
                "path": entry.path,
            })
    m.add("home_server_pipeline_stalled", stalled, None,
          "Files in queued/ against which Tdarr has recorded a finished "
          "verdict - i.e. the flow abandoned them. Derived the same way "
          "bin/promote-transcoded.py derives STUCK; if the two disagree, this "
          "one is wrong.")
    m.add("home_server_pipeline_queued", queued, None,
          "Files in queued/ still waiting for Tdarr. Zero is the healthy "
          "steady state, not a fault.")
    doc.note("filesystem", True)
    return out


# ------------------------------------------------------------------------------
# The agent fleet, from conduct's own database
# ------------------------------------------------------------------------------
# READ-ONLY, FAIL SOFT, AND NEVER A LINK THIS SOURCE BUILT ITSELF.
#
# conduct.db is the only place that knows which task is in flight, which round
# it is on and what a round has cost. None of that can be a series - a task
# title and a Windmill job id are the forbidden label family - so it travels as
# a document, on the slow tier, rewritten whole.
#
# THE RESUME URL IS THE ONE THING THAT MUST NOT TRAVEL. docs/agents.md and
# conduct/notify.py are both explicit: Windmill's
# jobs_u/resume/{id}/{resume_id}/{signature} carries an HMAC in the path and
# needs no session, so anything holding one can approve an agent's merge. ntfy
# is refused it for that reason, and the same reasoning reaches further than the
# transport: a link that appears on a page is a link that gets followed. So this
# source constructs no link at all - it carries notice.link, which conduct built
# pointing at the approval page behind sign-on, and _fleet_link drops anything
# resembling a resume URL regardless. Both, because the cheap guard is the half
# that survives somebody changing the other end.
CONDUCT_MODULE_PREFIX = "conduct_"

# conduct/config.py's MAX_ATTEMPTS. Duplicated rather than imported, because the
# collector is stdlib-only and must run on a host where /var/agents is absent -
# and a round board that cannot say "attempt 2 of 3" has lost the number that
# says whether the fleet is about to give up.
#
# IT WENT TO 3 ON 2026-08-28 AND THIS DID NOT FOLLOW, which is the whole cost of
# duplicating a constant: nothing failed, no test noticed, and the board would
# have drawn "attempt 3 of 2" the first time a change used its third. A second
# copy of a fact is a thing to check when the first one moves.
FLEET_MAX_ATTEMPTS = 3

# conduct/config.py's CONTROL_RESTART_MIN_SEC, duplicated for the same reason and
# with the same warning attached. The board disables a restart inside the floor
# rather than offering one conduct will refuse.
FLEET_RESTART_FLOOR_SEC = 600

# How many recent runs the document carries. A run row holds a task body and a
# raw verdict, both unbounded, and this file is fetched by a browser every five
# minutes - so the cap is the panel's depth plus headroom, named rather than
# implied, the way the requests source already caps its title lookups.
FLEET_RUNS = 20

# How many rounds. OPEN ONES ARE NEVER DROPPED - the cap applies to the closed
# tail, because the board hides a merged round by default and the toggle needs
# something to reveal. A count rather than a time window: a busy week must not
# grow this file without bound and a quiet one must not empty the history.
FLEET_ROUNDS = 40

# The five conduct_* handlers in conduct/poll.py, in flow order. Duplicated for
# the same reason FLEET_MAX_ATTEMPTS is - the collector cannot import conduct -
# and it is the denominator of every progress bar on the Agents page.
#
# chain.done is APPEND-ONLY WITHIN A ROUND and chain_restart clears it wholesale,
# so progress is progress through the CURRENT attempt. The board prints
# "attempt N of 2" beside it; without that a second attempt reads as lost work.
FLEET_PHASES = ("plan", "dev", "verify", "review", "ship")

# The window and the floor for the ETA. A median needs enough runs behind it to
# mean anything, and below the floor the answer is NULL - a grey dash rather
# than a number nobody should act on. Thirty days because a phase's duration
# tracks the project it is working on, and a year-old plan phase is evidence
# about a different codebase.
FLEET_ETA_WINDOW_S = 30 * 86400
FLEET_ETA_MIN_SAMPLES = 5

# How many pull requests may be asked about in one run. Only rounds this
# document carries whose state is not already terminal are asked, so in practice
# this is a handful; the cap is what stops a backlog of never-merged branches
# turning a monitor into a crawler.
FLEET_PR_MAX = 10

# GitHub's API, and the only host-side network call this collector makes.
FLEET_GITHUB_API = "https://api.github.com"
FLEET_GITHUB_TIMEOUT = 8

# WHEN publication.pr_url STARTED BEING WRITTEN ON THIS HOST - the moment
# conduct was restarted onto the migration, measured rather than assumed.
#
# A DATE IN CODE, AND THE ALTERNATIVE WAS A LIE. A migration is a moment in
# time: every publication row closed before it holds NULL whether or not it
# opened a pull request, and this host had two - one of which is
# avanserv/upskald#249, which demonstrably did. Without this cutover both read
# "not published" for ever, which is the confident, permanent, never-corrected
# mis-statement this whole repository is organised against.
#
# So a NULL means "the flow opened none" only ON THE FAR SIDE OF THIS STAMP.
# Before it the answer is "unknown", which the board renders as "published" -
# a true statement about a publication row that closed, and no claim at all
# about a pull request.
#
# It expires by itself: the board carries FLEET_ROUNDS rounds and these two age
# out of that window, after which this constant stops matching anything. Do not
# "tidy" it away before then - it is doing work until it isn't.
FLEET_PR_RECORDED_FROM = "2026-08-28T14:00:00Z"


def _fleet_link(raw):
    """conduct's own link, or nothing. Never a resume URL, never constructed."""
    link = str(raw or "").strip()
    if not link:
        return None
    lowered = link.lower()
    if "/resume/" in lowered or "resume_id" in lowered:
        return None
    if not (lowered.startswith("https://") or lowered.startswith("http://")):
        return None
    return link


def _fleet_text(raw, limit):
    """Bounded display text. A task body and a raw verdict are both unbounded."""
    if raw is None:
        return None
    text = " ".join(str(raw).split())
    if not text:
        return None
    return text if len(text) <= limit else text[:limit - 3] + "..."


def _fleet_rows(conn, sql, params=()):
    cur = conn.execute(sql, params)
    names = [c[0] for c in cur.description]
    return [dict(zip(names, row)) for row in cur.fetchall()]


def _fleet_seconds(started_at, ended_at):
    """Elapsed seconds between two of conduct's stamps, or None.

    Both are `%Y-%m-%dT%H:%M:%SZ` written by conduct's own utcnow(). A row that
    does not parse is dropped rather than defaulted: a zero-length phase would
    drag a median down and nothing would say why.
    """
    try:
        start = calendar.timegm(time.strptime(started_at, "%Y-%m-%dT%H:%M:%SZ"))
        end = calendar.timegm(time.strptime(ended_at, "%Y-%m-%dT%H:%M:%SZ"))
    except (TypeError, ValueError):
        return None
    return end - start if end >= start else None


def _fleet_median(values):
    """The median of a non-empty list. Mean of the middle two when even."""
    ordered = sorted(values)
    middle = len(ordered) // 2
    if len(ordered) % 2:
        return float(ordered[middle])
    return (ordered[middle - 1] + ordered[middle]) / 2.0


def _fleet_phase_stats(conn):
    """How long each phase actually takes on THIS host, with its sample count.

    THE ONLY DURATION EVIDENCE THAT EXISTS. conduct records no expectation
    anywhere - flows/ship.py has prose in its module summaries ("dev 10-25
    minutes") and nothing machine-readable - so an ETA is either derived from
    what this host has done or it is invented.

    SUCCESSFUL RUNS ONLY. A killed phase stopped early and a failed one may have
    stopped anywhere, so including them would predict a shorter round the worse
    things are going. The sample count travels with the median because the page
    has to be able to say what the number rests on, and to refuse to draw one
    below FLEET_ETA_MIN_SAMPLES.
    """
    cutoff = iso(now() - FLEET_ETA_WINDOW_S)
    durations = {}
    for row in _fleet_rows(conn, """
        SELECT phase, started_at, ended_at FROM run
         WHERE ended_at IS NOT NULL AND result = 'ok' AND started_at >= ?
    """, (cutoff,)):
        if row["phase"] not in FLEET_PHASES:
            continue
        seconds = _fleet_seconds(row["started_at"], row["ended_at"])
        if seconds is not None:
            durations.setdefault(row["phase"], []).append(seconds)

    # EVERY PHASE IS PRESENT, with nulls where there is no evidence. A key that
    # appears and disappears between runs forces a reader to guess which case it
    # is in - the same contract Document's docstring states for its values.
    stats = {}
    for phase in FLEET_PHASES:
        samples = durations.get(phase) or []
        stats[phase] = {
            "median_seconds": round(_fleet_median(samples)) if samples else None,
            "samples": len(samples),
        }
    return stats


def _fleet_eta(stats, done, phase, phase_elapsed):
    """Seconds until this round is expected to finish, or None.

    NULL IS THE ANSWER MORE OFTEN THAN A NUMBER IS, and that is the point. If
    any remaining phase has fewer than FLEET_ETA_MIN_SAMPLES behind it, the sum
    would be a guess wearing a median's clothes - so the whole estimate is
    withheld rather than quietly computed from two runs.

    Returns (seconds, samples) where samples is the WEAKEST evidence in the sum,
    which is what the page's tooltip has to name. The current phase's median is
    reduced by however long it has already been running, floored at zero: a
    phase past its median has an unknown remainder, not a negative one.
    """
    remaining = [p for p in FLEET_PHASES if p not in done]
    if not remaining:
        return None, None
    total = 0.0
    weakest = None
    for name in remaining:
        stat = stats.get(name) or {}
        median = stat.get("median_seconds")
        samples = stat.get("samples") or 0
        if median is None or samples < FLEET_ETA_MIN_SAMPLES:
            return None, None
        weakest = samples if weakest is None else min(weakest, samples)
        if name == phase and phase_elapsed is not None:
            total += max(0.0, median - phase_elapsed)
        else:
            total += median
    return int(round(total)), weakest


# How many run rows are read to reconstruct rounds. A round is at most a handful
# of runs, so this comfortably covers FLEET_ROUNDS of them; the oldest group in
# the window may be truncated, and it is dropped by that cap before anybody sees
# it. A count rather than a date, for the reason FLEET_ROUNDS already gives.
FLEET_RUN_WINDOW = 400

# The suffix a verification's own worktree carries. dispatch.run_verify claims
# `<id>-verify` under a lease of its own, so a round's gate runs on a DIFFERENT
# worktree id from the rest of it - fold it back or every round loses its verify
# phase and reads 3/5 for ever.
FLEET_VERIFY_SUFFIX = "-verify"


def _fleet_parent(worktree_id):
    """The worktree a run belongs to, with a verification folded back."""
    text = str(worktree_id or "")
    if text.endswith(FLEET_VERIFY_SUFFIX):
        return text[:-len(FLEET_VERIFY_SUFFIX)]
    return text


def _fleet_derive_rounds(conn):
    """Reconstruct rounds from the run log, newest first.

    `chain` CANNOT DO THIS AND NEVER COULD. Its worktree_id is a PRIMARY KEY,
    chain_open does INSERT OR REPLACE, and the worktree is REUSED for every
    change - so each round overwrites the last one's row and the table holds
    one. Measured on the live host: 1 row in chain against 67 in run, covering
    eleven rounds over six days. Reading a history out of chain is not a thing
    that can be made to work; the run log is the only durable record.

    A `plan` RUN STARTS A ROUND, which is conduct's own definition of an attempt
    - chain.attempts counts plan phases. Runs on a worktree before any plan form
    one leading group: that is hand-driven work from before the fleet chose its
    own, it carries no task, and it ages out of the cap.
    """
    rounds = []
    open_group = {}
    # EVERY COLUMN conduct HAS ADDED SINCE THIS SHIPPED IS OPTIONAL HERE. The
    # two halves deploy separately - the collector arrives with `git pull` and
    # the column with a conduct restart - so a SELECT naming one before the
    # other side has migrated reads as an unreadable database and BLANKS THE
    # WHOLE BOARD. That is not hypothetical; it happened on 2026-08-28.
    optional = [name for name in ("odoo_task", "error", "branch")
                if _fleet_has(conn, "run", name)]
    rows = _fleet_rows(conn, """
        SELECT id, project, phase, worktree_id, started_at, ended_at, result,
               exit_code, cost_usd, tokens_in, tokens_out, task%s
          FROM run ORDER BY id DESC LIMIT ?
    """ % ("".join(", " + name for name in optional)), (FLEET_RUN_WINDOW,))

    for row in reversed(rows):
        if row["phase"] not in FLEET_PHASES:
            # select is the fleet CHOOSING work - the Intake panel reports it -
            # and check/probe/hello are hand-run diagnostics. Neither is a step
            # in a task's journey, and drawing them as rounds would say the
            # fleet had done work it had not.
            continue
        worktree = _fleet_parent(row["worktree_id"])
        group = open_group.get(worktree)
        if group is None or row["phase"] == "plan":
            group = {
                "worktree_id": worktree,
                "project": row["project"],
                # BOTH, AND THEY ARE NOT THE SAME QUESTION. `started_at` is when
                # the round's first phase began; `opened_at` is what the board
                # renders as "opened N ago" and what byUrgency breaks ties on.
                # They coincide for a derived round and the key has to be here
                # anyway - it used to come from chain.opened_at, and deleting
                # that query without replacing it left every row reading
                # "opened never".
                "opened_at": row["started_at"],
                "started_at": row["started_at"],
                "ended_at": row["ended_at"],
                "done": [],
                "phase": row["phase"],
                "odoo_task": row.get("odoo_task"),
                "task": row["task"],
                "branch": row.get("branch"),
                "error": None,
                "cost_usd": 0.0,
                "tokens_in": 0,
                "tokens_out": 0,
                "running": False,
                "failed": False,
            }
            rounds.append(group)
            open_group[worktree] = group

        group["phase"] = row["phase"]
        if row["phase"] not in group["done"]:
            group["done"].append(row["phase"])
        group["ended_at"] = row["ended_at"]
        group["cost_usd"] += row["cost_usd"] or 0.0
        group["tokens_in"] += row["tokens_in"] or 0
        group["tokens_out"] += row["tokens_out"] or 0
        # ONLY A GROUP THAT OPENED WITH A PLAN MAY ADOPT A LATER RUN'S TASK.
        # The fallback exists for the transition, where a round's plan predates
        # run.odoo_task and its later phases carry it. The leading no-plan group
        # runs until the first plan, so without this guard it would adopt the id
        # of the round that ENDED it and claim hand-driven work for a task that
        # had nothing to do with it.
        if group["odoo_task"] is None and "plan" in group["done"]:
            group["odoo_task"] = row.get("odoo_task")
        if group["task"] is None:
            group["task"] = row["task"]
        # THE LAST RUN THAT FAILED IS THE ONE THAT STOPPED THE ROUND, so a later
        # reason replaces an earlier one rather than the other way round - a
        # repair's second dev failure is what a reader is looking at, not the
        # first one it already worked past.
        if row.get("error"):
            group["error"] = row["error"]
        # AND ANY RUN THAT PUSHED ONE NAMES THE BRANCH. dev pushes it now and
        # verify pushes it again, so the newest is the one that is on the
        # remote; a round where neither ran keeps None and the row says so.
        if row.get("branch"):
            group["branch"] = row["branch"]
        # conduct's own predicate, and the one an earlier version of this file
        # got backwards: a NULL result is a run still going, not a failure.
        group["running"] = row["result"] is None
        group["failed"] = row["result"] not in (None, "ok")

    # ATTEMPT N OF THE SAME TASK, which is the number chain.attempts used to
    # carry. Null without a task id, because "attempt 1" about a round whose
    # task is unknown is a claim rather than a count - every row that predates
    # run.odoo_task is in that position.
    seen = {}
    for group in rounds:
        task_id = group["odoo_task"]
        if task_id is None:
            group["attempts"] = None
            continue
        seen[task_id] = seen.get(task_id, 0) + 1
        group["attempts"] = seen[task_id]

    # A GROUP WITH NEITHER A PLAN NOR A TASK IS NOT A TASK'S JOURNEY. It is a
    # phase somebody ran by hand against a scratch worktree - `upskald-probe`
    # running a lone verify is the live example - and drawing it as a round says
    # the fleet attempted work it never attempted. A group with a task but no
    # plan IS kept: that is hand-driven work from before the fleet chose its
    # own, and it really did happen.
    rounds = [g for g in rounds if "plan" in g["done"] or g["task"]]

    rounds.reverse()
    return rounds


def _fleet_has(conn, table, column):
    """Whether a column exists - the discriminator conduct's _migrate uses.

    CREATE TABLE IF NOT EXISTS does not add a column to an existing table, and
    this file and conduct deploy independently, so every column added on the
    conduct side has a window where naming it raises `no such column` and takes
    the whole board down with it.
    """
    return column in {row[1] for row in
                      conn.execute("SELECT * FROM pragma_table_info(?)", (table,))}


def _fleet_phase_started(conn, worktree_id, phase):
    """When the phase now in flight on this worktree started, or None.

    THE `run` ROW, NOT THE `lease`. A lease is taken and released around a
    phase, so a round between phases holds none - and reading the lease would
    make the ETA jump to the full remaining sum every time one closed. The run
    row survives, which is what lets a phase's elapsed time be subtracted from
    its own median.

    result IS NULL is in flight rather than failed - conduct's own predicate,
    and the one the first version of this file got backwards.
    """
    row = conn.execute(
        "SELECT started_at FROM run WHERE worktree_id = ? AND phase = ?"
        " AND result IS NULL ORDER BY id DESC LIMIT 1",
        (worktree_id, phase),
    ).fetchone()
    if row is None:
        return None
    try:
        return calendar.timegm(time.strptime(row[0], "%Y-%m-%dT%H:%M:%SZ"))
    except (TypeError, ValueError):
        return None


def _fleet_control(conn, env):
    """What a person has asked the fleet to do, and whether they can ask at all.

    THE SWITCH HAS TWO SOURCES AND THE BOARD HAS TO SAY WHICH IS IN FORCE.
    conduct's descriptor is the shipped default and a `control` row overrides it
    without a restart, so "is intake armed" now has an answer and a plausible
    wrong one. The row is what this can read; the descriptor is a Python literal
    in another repository and is not readable from here at all - so `source` says
    `set` or `default`, and `default` deliberately does not claim to know WHICH
    default. `conduct status` is where both are printed side by side.

    `available` IS NOT A GUESS ABOUT CADDY. It reads the same .env Caddy is given
    the token from, which is the only place either of them can agree. Unset means
    the route answers 401, and the board must render its controls disabled and
    say why rather than offering a button that fails - absent and broken are
    different findings, which is the rule this whole document is written around.
    """
    block = {
        "available": bool(str(env.get("WINDMILL_DASHBOARD_TOKEN") or "").strip()),
        # A SECOND TOKEN AND SO A SECOND FLAG. The two routes are scoped to one
        # flow each, so one being minted says nothing about the other - and a
        # board that inferred the approve chips from `available` would offer a
        # button that answers 401 the first time a person needs it most.
        "approve_available":
            bool(str(env.get("WINDMILL_APPROVE_TOKEN") or "").strip()),
        "restart_floor_sec": FLEET_RESTART_FLOOR_SEC,
        "intake": [],
        "holds": [],
    }
    if not _fleet_has(conn, "control", "name"):
        # conduct and this file deploy separately, and the table arrives with a
        # conduct restart. Absent is the ordinary state for a minute, not a fault.
        return block
    for row in _fleet_rows(conn, "SELECT name, value, at, note FROM control"
                                 " ORDER BY at"):
        name, _, subject = str(row["name"]).partition(":")
        if not subject:
            continue
        entry = {"subject": subject, "value": row["value"], "at": row["at"],
                 "note": _fleet_text(row.get("note"), 200)}
        if name == "intake":
            block["intake"].append(entry)
        elif name == "hold":
            block["holds"].append(entry)
    return block


def _fleet_odoo_url(env, odoo_task):
    """The tracker's own page for a task, or None.

    BUILT HERE BECAUSE IT CANNOT BE BUILT IN THE BROWSER. src/links.ts derives
    every sibling application from window.location.hostname and refuses a
    build-time variable; ODOO_URL is an encrypted secret and is not a sibling of
    home.{$DOMAIN} at all. Absent config yields None, which ChipLink already
    renders as a disabled box - the same answer it gives under `npm run dev`.
    """
    base = str(env.get("ODOO_URL") or "").strip().rstrip("/")
    if not base or not odoo_task:
        return None
    if not (base.startswith("https://") or base.startswith("http://")):
        return None
    # `/odoo/<model>/<id>`, WHICH IS THE ONLY FORM THIS INSTANCE ANSWERS. The
    # legacy `/web#id=N&model=project.task` hash was what shipped here first and
    # it puts the record behind a client-side route Odoo 17 dropped. conduct
    # talks to this instance over POST /json/2/<model>/<method>, which is the
    # Odoo 19 API - so the version is not in doubt.
    return "%s/odoo/project.task/%s" % (base, int(odoo_task))


def _fleet_branch_url(env, branch, pr_url):
    """The branch's own page on GitHub, or None.

    BUILT HERE FOR THE REASON _fleet_odoo_url IS: src/links.ts derives every
    sibling application from window.location.hostname and refuses a build-time
    variable, and github.com is nobody's sibling.

    THE SLUG IS CONFIGURATION THIS PROCESS CANNOT READ. It lives in conduct's
    config.py, which is a Python module in another repository on the same host -
    so it is named again in .env, and a second copy of a fact is drift waiting
    to happen. CLOSED BY MEASUREMENT RATHER THAN BY A COMMENT: whenever the same
    round also carries a pull request, that URL contains the real slug, so the
    two can be compared. A disagreement WITHHOLDS THE LINK rather than following
    it, which surfaces as a branch name that is not clickable - and says so on
    stderr, where the collector's journal keeps it.

    NOT A `sources` ENTRY. That vocabulary means "this upstream did not answer,
    so its rows are absent rather than zero", and the store prints exactly that
    sentence. Nothing here failed to answer; one string in .env is wrong.
    """
    slug = str(env.get("AGENTS_REPO_SLUG") or "").strip().strip("/")
    if not branch or not slug or slug.count("/") != 1:
        return None
    if pr_url:
        parsed = urlparse(str(pr_url))
        parts = [p for p in parsed.path.split("/") if p]
        if parsed.netloc == "github.com" and len(parts) >= 2:
            actual = "%s/%s" % (parts[0], parts[1])
            if actual != slug:
                print("fleet: AGENTS_REPO_SLUG is %s but this fleet's pull "
                      "requests are on %s - withholding branch links"
                      % (slug, actual), file=sys.stderr)
                return None
    return _fleet_link("https://github.com/%s/tree/%s" % (slug, branch))


def _fleet_pr_api(pr_url):
    """The REST endpoint for a pull request html_url, or None.

    PARSED FROM THE STORED URL RATHER THAN BUILT FROM A CONFIGURED SLUG.
    conduct/config.py's slug cannot be imported here and copying it into .env
    would be a second hand-maintained duplicate of a value that already exists -
    so the repository comes from the url GitHub itself minted.

    The host check is what stops a rewritten pr_url pointing this at anything
    else: only github.com produces an api.github.com call.
    """
    parts = urlparse(str(pr_url or ""))
    if parts.scheme != "https" or parts.hostname != "github.com":
        return None
    segments = [seg for seg in parts.path.split("/") if seg]
    if len(segments) != 4 or segments[2] != "pull" or not segments[3].isdigit():
        return None
    return "%s/repos/%s/%s/pulls/%s" % (FLEET_GITHUB_API, segments[0],
                                        segments[1], segments[3])


def _fleet_pr_state(api_url, token):
    """`open`, `merged`, `closed`, or None when it could not be asked.

    THE ONLY HOST-SIDE NETWORK CALL IN THIS FILE. Every other outbound request
    goes through `podman exec <container> curl`, and this one cannot: the token
    must not enter a container, which is the same rule docs/ci.md states for the
    credential that never enters a lane.

    It lives on the monitor rather than in conduct because a reconciler that
    stops is safe and a monitor that stops is blind - and because one dead flow
    job has already stopped that fleet for two hours.
    """
    request = urllib.request.Request(api_url, headers={
        "Authorization": "Bearer %s" % token,
        "Accept": "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
        "User-Agent": "home-server-collector",
    })
    with urllib.request.urlopen(request,
                                timeout=FLEET_GITHUB_TIMEOUT) as response:
        body = json.loads(response.read().decode("utf-8", "replace"))
    if not isinstance(body, dict):
        return None
    # merged_at RATHER THAN `merged`. The boolean is present on this endpoint
    # but absent from the list endpoint, and a closed-unmerged pull request is
    # not a merged one - conflating them would hide a branch somebody abandoned.
    if body.get("merged_at"):
        return "merged"
    state = body.get("state")
    return state if state in ("open", "closed") else None


def _fleet_pull_requests(doc, rounds, env):
    """Fill in pr_state on every round that has a pull request.

    IT FAILS OPEN, AND THAT IS THE WHOLE DESIGN. The board hides a round once
    its pull request is merged, so an unreachable GitHub or an expired token
    must leave `unknown` and keep every row visible. A round disappearing
    because a credential lapsed is the same class of error as an empty list
    reading as an idle fleet, and this file exists to prevent that one.
    """
    wanted = [r for r in rounds if r.get("pr_url")][:FLEET_PR_MAX]
    if not wanted:
        # NOT A FAILURE AND NOT A SUCCESS EITHER. Nothing was asked, so nothing
        # can be reported; recording ok here would claim a credential works on a
        # run that never used it.
        return
    token = str(env.get("GITHUB_PR_READ_TOKEN") or "").strip()
    if not token:
        doc.note("github", False, "GITHUB_PR_READ_TOKEN is not set")
        return
    failure = None
    for row in wanted:
        api_url = _fleet_pr_api(row.get("pr_url"))
        if api_url is None:
            continue
        try:
            row["pr_state"] = _fleet_pr_state(api_url, token) or "unknown"
        except Exception as exc:  # noqa: BLE001 - a monitor may not raise
            failure = failure or ("%s" % exc)
    doc.note("github", failure is None, failure)


def _fleet_waiting(module_id):
    """Who owes this step an answer.

    A module id WITHOUT the prefix is one a PERSON answers - `publish_pr` is
    deliberately unprefixed for exactly that reason, and conduct refuses to
    answer a step it does not own. That single distinction is the most useful
    thing on the Agents page.
    """
    return ("conduct" if str(module_id or "").startswith(CONDUCT_MODULE_PREFIX)
            else "person")


def source_control(m, doc):
    """The control switch alone, on the fast tier.

    A SECOND DOCUMENT FOR ONE QUERY, AND THE CADENCE IS THE WHOLE REASON.
    `source_fleet` is slow and rightly so - it walks git, derives rounds, takes
    phase medians and makes a GitHub call - but the control block is one SELECT
    against a table with a handful of rows, and putting it behind all of that
    made the board up to ten minutes behind a click: five for the slow tier and
    five more for the browser's poll of a document that size. A person pressed
    disarm, watched nothing happen, and pressed it again.

    conduct NOW APPLIES A COMMAND IN ABOUT FIFTEEN SECONDS, so the board being
    the slow half would be the whole remaining delay.

    `fleet.json` STILL CARRIES `control` AND THAT IS NOT A DUPLICATE DRAWING.
    The collector and the bundle deploy separately, so a board reading this file
    before the collector writes one would blank the control it exists to show -
    the split-deploy failure docs/known-state.md already records for `pr_url`.
    The store treats this as a PRECEDENCE: one value reaches the switch.

    IT MUST NEVER RAISE, for the reason source_fleet gives at length.
    """
    doc.set("control", {"available": False,
                        "restart_floor_sec": FLEET_RESTART_FLOOR_SEC,
                        "intake": [], "holds": []})

    if not os.path.exists(CONDUCT_DB):
        doc.note("conduct_db", False, "conduct has never run here")
        return

    conn = None
    try:
        conn = sqlite3.connect("file:%s?mode=ro" % CONDUCT_DB, uri=True,
                               timeout=2.0)
        conn.execute("PRAGMA busy_timeout = 2000")
        doc.set("control", _fleet_control(conn, load_env()))
        doc.note("conduct_db", True)
    except sqlite3.Error as exc:
        doc.note("conduct_db", False, "conduct.db could not be read: %s" % exc)
    finally:
        if conn is not None:
            try:
                conn.close()
            except sqlite3.Error:
                pass


def source_fleet(m, doc):
    """What the fleet is doing, for the Agents page.

    IT MUST NEVER RAISE, for the reason source_agents already documents at
    length: one source raising stops last_ok_at advancing for every source at
    once. An absent database is the normal state on a host where conduct has
    never run, and a locked one is a live writer doing its job.
    """
    doc.set("rounds", [])
    doc.set("publications", [])
    doc.set("notices", [])
    doc.set("runs", [])
    doc.set("intake", [])
    doc.set("control", {"available": False,
                        "restart_floor_sec": FLEET_RESTART_FLOOR_SEC,
                        "intake": [], "holds": []})
    doc.set("phase_stats", {p: {"median_seconds": None, "samples": 0}
                            for p in FLEET_PHASES})
    doc.set("totals", {"runs_today": None, "runs_failed_today": None,
                       "tokens_today": None, "tokens_week": None,
                       "cost_today": None, "cost_week": None,
                       "rounds_open": None, "publications_pending": None})

    if not os.path.exists(CONDUCT_DB):
        # A NOTE, NOT AN ERROR. Every conduct-dependent check reported exactly
        # this for months before the orchestrator shipped, and a finding nobody
        # can act on is how a reader learns to skip a whole section.
        doc.note("conduct_db", False, "conduct has never run here")
        return

    conn = None
    try:
        # mode=ro rather than immutable=1: there is a live writer, and immutable
        # would let us read a torn WAL and call it the truth.
        conn = sqlite3.connect("file:%s?mode=ro" % CONDUCT_DB, uri=True,
                               timeout=2.0)
        conn.execute("PRAGMA busy_timeout = 2000")

        midnight = time.strftime("%Y-%m-%dT00:00:00Z", time.gmtime(now()))
        week_ago = iso(now() - 7 * 86400)
        # ONCE PER RUN, not once per row. load_env degrades to {} rather than
        # raising - there is a window during render-env.sh when the file is half
        # written, and it must cost the links and nothing else.
        env = load_env()

        notices = _fleet_rows(conn, """
            SELECT flow_job_id, module_id, project, kind, summary, link,
                   first_at, last_at, sends
              FROM notice WHERE closed_at IS NULL ORDER BY first_at
        """)
        by_job = {}
        for row in notices:
            row["waiting_on"] = _fleet_waiting(row.get("module_id"))
            row["link"] = _fleet_link(row.get("link"))
            row["summary"] = _fleet_text(row.get("summary"), 240)
            by_job.setdefault(row.get("flow_job_id"), []).append(row)

        # OPEN ROUNDS FIRST, THEN THE CLOSED TAIL, and the cap applies only to
        # the tail. Reading `closed_at IS NULL` - which this did until the board
        # grew a history - meant a round vanished the moment it closed, so
        # "published" and "stopped" were states the page could never draw.
        #
        # The ORDER BY sorts open rows (closed_at NULL) ahead of closed ones and
        # then puts the most recent first within each group, so the LIMIT can
        # only ever discard old closed rounds.
        # THE ROWS COME FROM THE RUN LOG, NOT FROM `chain`. See
        # _fleet_derive_rounds: chain is a current-state table on a REUSED
        # worktree, so it holds one row however much the fleet has done.
        rounds = _fleet_derive_rounds(conn)
        stats = _fleet_phase_stats(conn)
        control = _fleet_control(conn, env)
        doc.set("control", control)
        # KEYED FOR THE ROW LOOP BELOW, because a hold belongs to a WORKTREE and
        # rounds are what the board draws - several rounds share one worktree and
        # only the newest of them is the one a hold is about.
        holds = {entry["subject"]: entry for entry in control["holds"]}

        # `chain` IS STILL READ, FOR THE TWO THINGS IT IS ACCURATE ABOUT: the
        # round in flight, and the sentence conduct wrote when the newest round
        # ended. waiting_on, the approval link and the tracker id for the round
        # in flight are all here and nowhere in the run log. It cannot speak for
        # any round before the newest one on its worktree.
        #
        # AND `closed_at IS NULL` WAS THE WRONG FILTER. It made the whole row
        # absent the moment a round ended, so `closed_why` - the one field whose
        # entire purpose is saying why something stopped - was null on every
        # round that had stopped and populated only on rounds that had not. The
        # row is read whatever its state now; `is_open` below is what decides
        # which of its fields may be believed.
        live = {}
        for row in _fleet_rows(conn, """
            SELECT worktree_id, project, odoo_task, ref, phase, opened_at,
                   attempts, flow_job_id, closed_at, closed_why
              FROM chain
        """):
            live[row["worktree_id"]] = row

        # THE PR COLUMNS ARE ASKED FOR ONLY IF THEY EXIST, and that is a
        # deployment-ordering fix rather than defensiveness. This file and
        # conduct deploy independently, and naming a column before conduct has
        # migrated raises `no such column`, which this function catches and
        # reports as an unreadable database - so the whole board would read
        # "absent, not zero" over a perfectly healthy fleet. MEASURED against
        # the live database before the migration had run.
        has_pr = (_fleet_has(conn, "publication", "pr_url")
                  and _fleet_has(conn, "publication", "pr_number"))
        pubs = _fleet_rows(conn, """
            SELECT worktree_id, branch, closed_at, opened_at%s
              FROM publication ORDER BY opened_at
        """ % (", pr_url, pr_number" if has_pr else ""))

        # A PUBLICATION BELONGS TO THE ROUND THAT WAS RUNNING WHEN IT OPENED,
        # and the join has to say so. Matching on worktree alone was invisible
        # while chain held one row and is wrong the moment history appears:
        # every round ever run on `upskald-ship` would carry the same pull
        # request. The verification push is what opens the row, so the owner is
        # the latest round on that worktree that had already started.
        for pub in pubs:
            owner = None
            for group in rounds:
                if (group["worktree_id"] == pub["worktree_id"]
                        and group["started_at"] <= (pub["opened_at"] or "")):
                    if owner is None or group["started_at"] > owner["started_at"]:
                        owner = group
            if owner is not None and "publication" not in owner:
                owner["publication"] = pub

        # THE LATEST ROUND ON A WORKTREE IS THE ONE THE CHAIN DESCRIBES, and
        # `rounds` is newest-first, so the first occurrence of each worktree is
        # it. An earlier round on the same worktree finished long ago; letting
        # it inherit a live chain row would draw a finished round as though
        # somebody were still waiting on it.
        latest = {}
        for index, group in enumerate(rounds):
            latest.setdefault(group["worktree_id"], index)

        for index, row in enumerate(rounds):
            chain = live.get(row["worktree_id"])
            newest = latest[row["worktree_id"]] == index
            # OPEN MEANS BOTH: the chain row says nobody closed it, AND this is
            # the round it describes. Either alone draws a finished round as
            # though somebody were still waiting on it.
            is_open = (chain is not None and newest
                       and chain["closed_at"] is None)

            row["max_attempts"] = FLEET_MAX_ATTEMPTS
            # HELD IS ABOUT THE ROUND IN FLIGHT AND NO OTHER. A control row
            # outlives the round it was set for - the worktree is reused - so
            # attaching it to every round on that tree would draw a finished one
            # as though somebody were still holding it.
            entry = holds.get(row["worktree_id"]) if is_open else None
            row["held"] = bool(entry and entry["value"] == "on")
            row["held_at"] = entry["at"] if row["held"] else None
            row["held_why"] = entry["note"] if row["held"] else None
            row["phases"] = list(FLEET_PHASES)
            row["ref"] = chain["ref"] if chain and is_open else None
            row["flow_job_id"] = chain["flow_job_id"] if chain and is_open else None
            row["head"] = None
            row["resumed_at"] = None
            # `chain` SPEAKS FOR ONE ROUND, AND THIS IS THE ONE IT SPEAKS FOR.
            # It holds a single row per worktree, so its sentence belongs to the
            # LATEST round on that worktree - open or closed. Reading it only
            # while the row was open made it null on every closed round, which
            # is the only place a stop reason is worth having; and reading it on
            # every round would put the newest round's reason on all ten.
            row["closed_why"] = _fleet_text(
                chain["closed_why"], 200) if chain and newest else None

            if chain and is_open:
                # The chain knows the task even when the run rows predate
                # run.odoo_task, so prefer it for the round in flight.
                row["odoo_task"] = chain["odoo_task"] or row["odoo_task"]
                row["phase"] = chain["phase"] or row["phase"]
                row["attempts"] = chain["attempts"] or row["attempts"]
                row["closed_at"] = None
            else:
                # Not the round in flight, so it is finished. `closed_at` is
                # what every reader keys "open" on, and a derived round has no
                # sentence conduct wrote for it.
                row["closed_at"] = row["ended_at"] or row["started_at"]

            # BEST EFFORT, AND NULL WHERE IT CANNOT BE KNOWN. chain.flow_job_id
            # is the job that STOPPED, not the one running - state.py says so -
            # so a round mid-flight legitimately matches no notice. Null means
            # "in flight"; defaulting to "conduct" would claim the fleet owns a
            # step nobody has looked at.
            matched = by_job.get(row["flow_job_id"]) or [] if row["flow_job_id"] else []
            person = [n for n in matched if n["waiting_on"] == "person"]
            if row["closed_at"] is None:
                row["waiting_on"] = ("person" if person
                                     else "conduct" if matched else None)
            else:
                row["waiting_on"] = None
            row["link"] = person[0]["link"] if person else None
            row["kind"] = person[0]["kind"] if person else (
                matched[0]["kind"] if matched else None)
            # THE TASK TITLE IS THE ROW'S SUBJECT. run.task holds the phase's
            # whole prompt, so the first line is the title and the rest is the
            # brief - and the id is read from odoo_task, never parsed out of
            # this. An approval notice's summary is better still, when there is
            # one, because it says what is being ASKED.
            title = (row.pop("task", None) or "").split("\n")[0]
            row["summary"] = (person[0]["summary"] if person
                              else _fleet_text(title, 160))
            row["odoo_url"] = _fleet_odoo_url(env, row["odoo_task"])

            published = row.pop("publication", None) or {}
            # THE RUN LOG FIRST, AND publication.branch AS THE FALLBACK. That
            # row opens when the pull request does, so it is the only source for
            # rounds that predate run.branch and the wrong one for every round
            # since: dev pushes the branch now, minutes before the gate, so a
            # round that was refused has one and no publication at all.
            row["branch"] = row.get("branch") or published.get("branch")
            row["branch_url"] = _fleet_branch_url(env, row["branch"],
                                                  published.get("pr_url"))
            row["pr_url"] = _fleet_link(published.get("pr_url"))
            row["pr_number"] = published.get("pr_number")
            # PUBLISHED AT ALL, which is a different question from "merged". A
            # closed publication with no pr_url is a flow that ended without
            # opening one - a declined approval, a seven-day timeout - and must
            # not read as a round still waiting to publish.
            row["published"] = bool(published) and published.get(
                "closed_at") is not None

            # "unknown" IS NOT ONLY GITHUB BEING DOWN. It also covers a
            # publication row this collector could not read a pull request off
            # at all: the column absent, or the row closed before conduct began
            # writing it. Without it the one round this fleet has actually
            # merged reads "not published" for ever. A null pr_url means "opened
            # none" only when a url would have been visible had there been one.
            if row["pr_url"]:
                row["pr_state"] = "unknown"
            elif row["published"] and (
                    not has_pr
                    or (published.get("closed_at") or "") < FLEET_PR_RECORDED_FROM):
                row["pr_state"] = "unknown"
            else:
                row["pr_state"] = None

            # NULL WHENEVER THE EVIDENCE IS THIN, which is most of the time on a
            # young fleet - _fleet_eta withholds the whole sum rather than
            # computing one from two runs. And NO ETA WHILE A PERSON OWES AN
            # ANSWER: the remaining phases are the machine's work, while the
            # real wait is however long somebody takes to look, bounded only by
            # conduct's seven-day HUMAN_TIMEOUT.
            elapsed = None
            if row["closed_at"] is None and row["phase"]:
                started = _fleet_phase_started(conn, row["worktree_id"],
                                               row["phase"])
                if started is not None:
                    elapsed = max(0, now() - started)
            waiting = row["waiting_on"] == "person"
            eta, samples = (None, None) if row["closed_at"] or waiting else _fleet_eta(
                stats, set(row["done"]), row["phase"], elapsed)
            row["eta_seconds"] = eta
            row["eta_samples"] = samples
            row["cost_usd"] = round(row["cost_usd"], 4) or None
            row.pop("running", None)
            row.pop("failed", None)

        rounds = rounds[:FLEET_ROUNDS]


        publications = _fleet_rows(conn, """
            SELECT job_id, project, worktree_id, odoo_task, branch, opened_at
              FROM publication WHERE closed_at IS NULL ORDER BY opened_at
        """)

        runs = _fleet_rows(conn, """
            SELECT phase, project, worktree_id, started_at, ended_at, result,
                   exit_code, tokens_in, tokens_out, cost_usd, task, verdict
              FROM run ORDER BY started_at DESC, id DESC LIMIT ?
        """, (FLEET_RUNS,))
        for row in runs:
            row["task"] = _fleet_text(row.get("task"), 200)
            # The verdict is stored RAW because a model fallback can retract
            # structured output - state.py says so, and parsing it on the way in
            # would turn a rendering problem into a lost record. Rendering it is
            # card.py's job; all this needs is enough to show that one exists.
            row["verdict"] = _fleet_text(row.get("verdict"), 160)

        intake = _fleet_rows(conn, """
            SELECT project, odoo_task, flow_job_id, opened_at, closed_at,
                   last_looked_at, last_why FROM intake ORDER BY project
        """)
        for row in intake:
            row["last_why"] = _fleet_text(row.get("last_why"), 200)

        # ONE STATEMENT RATHER THAN SIX ROUND TRIPS.
        #
        # THE FAILURE PREDICATE IS conduct's OWN, COPIED FROM state.counts_today:
        # `result IS NOT NULL AND result != 'ok'`. A NULL result is a run still
        # in flight, NOT a failure - the first version of this counted it as one,
        # which drew every running phase as a failed one. It matters beyond being
        # wrong: home_server_agent_runs_failed_today comes from the marker, which
        # serve.snapshot derives from that same function, so a different
        # predicate here would put two numbers on one page that disagree with
        # each other and give a reader no way to tell which lied.
        totals = _fleet_rows(conn, """
            SELECT
              (SELECT COUNT(*) FROM run WHERE started_at >= ?) AS runs_today,
              (SELECT COUNT(*) FROM run WHERE started_at >= ?
                 AND result IS NOT NULL AND result != 'ok') AS runs_failed_today,
              (SELECT COALESCE(SUM(COALESCE(tokens_in,0)+COALESCE(tokens_out,0)),0)
                 FROM run WHERE started_at >= ?) AS tokens_today,
              (SELECT COALESCE(SUM(COALESCE(tokens_in,0)+COALESCE(tokens_out,0)),0)
                 FROM run WHERE started_at >= ?) AS tokens_week,
              (SELECT COALESCE(SUM(cost_usd),0)
                 FROM run WHERE started_at >= ?) AS cost_today,
              (SELECT COALESCE(SUM(cost_usd),0)
                 FROM run WHERE started_at >= ?) AS cost_week
        """, (midnight, midnight, midnight, week_ago, midnight, week_ago))[0]
        totals["rounds_open"] = len(rounds)
        totals["publications_pending"] = len(publications)

        # LAST, AND OUTSIDE THE ROW LOOP. It is the only network call in this
        # file and it must not sit between two database reads holding a
        # read-only connection open across eight seconds of someone else's
        # latency. It fails open: every row stays visible and pr_state stays
        # "unknown", because a round must never disappear because a token
        # expired.
        _fleet_pull_requests(doc, rounds, env)

        doc.set("phase_stats", stats)
        doc.set("rounds", rounds)
        doc.set("publications", publications)
        doc.set("notices", notices)
        doc.set("runs", runs)
        doc.set("intake", intake)
        doc.set("totals", totals)
        doc.note("conduct_db", True)

        # THE COUNTS ARE RETAINED AND THE NAMES ARE NOT, which is the rule
        # source_transfers already states for the pipeline. A round count has a
        # useful history; the branch it is on does not, and could not be kept
        # safely if it did. NO COST METRIC - see DOC_FLEET's comment.
        m.add("home_server_agent_rounds_open", len(rounds), None,
              "Review rounds conduct has open. Each is one task being carried "
              "through plan, dev, verify and review; agents.rounds_open warns "
              "when one has been open longer than six hours.")
        m.add("home_server_agent_publications_pending", len(publications), None,
              "Branches conduct has pushed whose pull request has not opened "
              "yet. NOT the REVIEW_CAP headroom, which is counted from the "
              "tracker's Review stage and is not measured on this host at all.")
        m.add("home_server_agent_notices_open", len(notices), None,
              "Notifications sent to a person and not yet answered. Counts "
              "conduct's own steps too; fleet.json's waiting_on separates them "
              "and agents.approvals_pending's SQL cannot.")
    except (sqlite3.Error, OSError, IndexError) as exc:
        # A LOCKED DATABASE IS NOT AN EMPTY FLEET. Without this note the page
        # would render "no rounds open" over a database it could not read, which
        # is the failure `sources` exists to make impossible.
        doc.note("conduct_db", False, "%s" % exc)
    finally:
        if conn is not None:
            try:
                conn.close()
            except sqlite3.Error:
                pass


# ------------------------------------------------------------------------------
# What a round actually did: one document each, rendered host-side
# ------------------------------------------------------------------------------
# WHY THIS IS NOT A LINK TO THE LOG. apps/dashboard refused to link a phase log
# at all and the refusal was right: a gate log is ten megabytes, it is 0600 on
# the host because "if a run ever prints its environment, the runner's token
# lands here durably", and no redaction pass existed anywhere. The container
# that serves the board can reach none of it, and should not.
#
# So the host renders instead, and what it renders is an ALLOWLIST of shapes.
# Anything the parser does not recognise is dropped rather than passed through,
# which is what makes the output safe to serve even though its input is not.
#
# MEASURED BEFORE IT WAS DESIGNED, on 73 logs and 374 MB: the conversation
# surface of the WHOLE history is 450 KB, a gate log carries 197,160 lines and
# 38 JSON events - none of them a conversation - and `thinking` blocks are all
# zero-length, so there is nothing there to render. Dropping tool RESULTS is
# what makes the redaction affordable: DOCKER_VOLUME_CACHE appears 3,920 times
# in the raw logs and 17 times in what survives.
#
# A FILE FAMILY RATHER THAN A DOCUMENT. _DOC_PATHS is one key to one file and
# main() writes one path per key, so this source manages its own writes - and,
# uniquely here, its own SWEEP. Nothing else in this file deletes anything; a
# directory whose contract is "rewritten whole, nothing accumulates" needs one
# once the filenames stop being fixed.
ROUND_PREFIX = "round-"

# The board draws FLEET_ROUNDS, so rendering more would be work nothing can ask
# for. Kept equal deliberately: two caps that can differ is a round that is on
# the board with no document behind it.
ROUND_KEEP = FLEET_ROUNDS

# Per-run ceilings, because a cold start faces 374 MB inside a unit with
# TimeoutStartSec=25s and MemoryHigh=256M. Oldest-missing first, so it converges
# over several passes rather than failing every one of them.
ROUND_LOG_FILES_PER_RUN = 6
ROUND_LOG_BYTES_PER_RUN = 48 * 1024 * 1024

# The most of one model log that is ever parsed, and the tail kept from a gate
# log. The gate tail is SEEKED, never read forward: the largest on this host is
# 10.9 MB and the interesting end of it is the last few pages.
ROUND_LOG_MAX_BYTES = 12 * 1024 * 1024
ROUND_GATE_TAIL_BYTES = 64 * 1024

# A whole document's ceiling. ~400 KB is what a real round measures; this is
# headroom, not a target, and a document that hits it says so rather than
# silently ending mid-conversation.
ROUND_DOC_MAX_BYTES = 3 * 1024 * 1024

# Shorter than this and a value is not a secret, it is a coincidence: `022` and
# `on` would otherwise redact half the English in the file.
ROUND_REDACT_MIN = 12

# conduct's log directory, derived the way conduct/config.py derives it.
CONDUCT_LOGS = os.environ.get(
    "CONDUCT_FLEET_ROOT", os.path.join(CACHE, "conduct"))
CONDUCT_LOGS = os.path.join(CONDUCT_LOGS, "logs")

# The phase name that appears in a verification's FILENAME. Its run row says
# `verify` on worktree `<id>-verify`, but phase.start was called with "check" -
# so the file is `<id>-verify-check-<stamp>.log` and a naive match finds nothing.
ROUND_FILENAME_PHASE = {"verify": "check"}

_ANSI = re.compile(r"\x1b\[[0-9;?]*[ -/]*[@-~]|\x1b[@-_]")


def _round_redaction(env):
    """(value, placeholder) pairs, longest value first - or None.

    NONE MEANS "DO NOT RENDER", AND THAT IS THE POINT. load_env() degrades to {}
    during bin/render-env.sh's write window, and a redactor built from an empty
    env redacts nothing while looking exactly like one that found nothing to
    redact. Failing closed costs one skipped pass every few weeks; failing open
    writes an unredacted transcript into a directory a browser can read.

    THE PLACEHOLDER NAMES THE VARIABLE rather than saying [redacted], because
    every one of these names is already public in .env.sample and `${DOMAIN}`
    tells a reader what they are looking at where a row of asterisks does not.

    LONGEST FIRST so a short value that is a substring of a longer one cannot
    corrupt it - replacing DOMAIN before ODOO_URL would leave a mangled tail
    that no later pass can recognise.
    """
    if not env:
        return None
    pairs = []
    for name, value in env.items():
        text = str(value or "")
        if len(text) >= ROUND_REDACT_MIN:
            pairs.append((text, "${%s}" % name))
    pairs.sort(key=lambda pair: len(pair[0]), reverse=True)
    return pairs


def _round_clean(text, pairs, limit=None):
    """One string, ANSI stripped, redacted, and optionally clipped."""
    if not text:
        return ""
    out = _ANSI.sub("", str(text))
    for value, placeholder in pairs:
        if value in out:
            out = out.replace(value, placeholder)
    if limit and len(out) > limit:
        out = out[:limit] + "\n... clipped at %d characters" % limit
    return out


def _round_log_index():
    """Every phase log on disk, as {(worktree, phase): [(stamp, path, size)]}.

    PARSED FROM THE RIGHT, because a worktree id contains hyphens of its own -
    `upskald-ship-verify-check-20260828T221500Z.log` is worktree
    `upskald-ship-verify`, phase `check`. Splitting from the left gets every
    round on this host wrong.
    """
    index = {}
    try:
        names = os.listdir(CONDUCT_LOGS)
    except OSError:
        return index
    for name in names:
        if not name.endswith(".log"):
            continue
        stem = name[:-4]
        parts = stem.rsplit("-", 2)
        if len(parts) != 3:
            continue
        worktree, phase, stamp = parts
        path = os.path.join(CONDUCT_LOGS, name)
        try:
            size = os.path.getsize(path)
        except OSError:
            continue
        index.setdefault((worktree, phase), []).append((stamp, path, size))
    for entries in index.values():
        entries.sort()
    return index


def _round_stamp(iso_text):
    """An ISO timestamp in the shape phase.start puts in a filename."""
    return str(iso_text or "").replace("-", "").replace(":", "")


def _round_log_for(run, index, spoken_for, claimed, ceiling):
    """The log a run wrote, from its own column or by matching the filename.

    THE COLUMN IS conduct's ANSWER AND IT ONLY COVERS RUNS FROM ITS DEPLOY. Logs
    are kept thirty days and the board draws forty rounds, so without a fallback
    the browser would show nothing at all for weeks. The fallback is the one that
    has to be careful, and the first draft of it was wrong in two ways that both
    showed a reader SOMEBODY ELSE'S TRANSCRIPT - which is worse than showing
    none, because it is confidently wrong:

    - THE MATCH NEEDS A CEILING, not just a floor. A run whose own log has aged
      out of LOG_RETAIN_SEC otherwise matches the next log on that worktree,
      which belongs to a later round. `ceiling` is the next run's start, because
      phase.start for run N+1 cannot precede the log of run N.
    - A LOG CAN ONLY BE CLAIMED ONCE. Without `claimed`, three dev runs in one
      round all matched the same file - observed on the live host, 2026-08-29.

    Two older traps that the first draft did get right: the stamp is at or AFTER
    started_at and never equal to it, because prepare_worktree sits between
    state.start_run and phase.start; and the phase in the name is not always the
    phase on the row, because the verification's row says `verify` while
    phase.start was called with "check". `spoken_for` carries base_gate.log, so
    a red round's TWO `-verify-check-` logs against ONE run row are separated by
    identity rather than by guessing which timestamp meant which.
    """
    recorded = (run.get("log") or "").strip()
    if recorded:
        return recorded
    worktree = str(run.get("worktree_id") or "")
    phase = str(run.get("phase") or "")
    entries = index.get((worktree, ROUND_FILENAME_PHASE.get(phase, phase)))
    if not entries:
        return None
    floor = _round_stamp(run.get("started_at"))
    for stamp, path, _size in entries:
        if stamp < floor or path in spoken_for or path in claimed:
            continue
        if ceiling is not None and stamp >= ceiling:
            break
        return path
    return None


def _round_conversation(path, pairs):
    """One model phase's transcript, as an allowlist of shapes.

    THE FILE IS NOT JSONL. It is the raw stdout of the container, so setup and
    build output is interleaved with the stream - 203 of 947 lines in a measured
    dev run, all at the head. `jq` over the whole file yields nothing, and the
    only workable rule is the one conduct's own quota.scan uses: a line that does
    not start with `{` is not an event.

    WHAT IS KEPT: the prompt, assistant text, tool CALLS with their input, the
    permission denials, and the result event's scalars. WHAT IS DROPPED: tool
    RESULTS, which is where file contents and command output land, and every
    shape not named here.
    """
    turns = []
    result = None
    try:
        size = os.path.getsize(path)
    except OSError:
        return None, None
    read = 0
    try:
        with open(path, "r", encoding="utf-8", errors="replace") as handle:
            for line in handle:
                read += len(line)
                if read > ROUND_LOG_MAX_BYTES:
                    turns.append({"kind": "note", "text":
                                  "log truncated at %d bytes of %d"
                                  % (ROUND_LOG_MAX_BYTES, size)})
                    break
                if not line.startswith("{"):
                    continue
                try:
                    event = json.loads(line)
                except ValueError:
                    continue
                if not isinstance(event, dict):
                    continue
                kind = event.get("type")
                if kind == "assistant":
                    for block in _round_blocks(event):
                        if block.get("type") == "text":
                            turns.append({"kind": "say", "text": _round_clean(
                                block.get("text"), pairs, 20000)})
                        elif block.get("type") == "tool_use":
                            turns.append({
                                "kind": "tool",
                                "name": str(block.get("name") or "?"),
                                "input": _round_clean(
                                    json.dumps(block.get("input"),
                                               sort_keys=True, default=str),
                                    pairs, 20000),
                            })
                elif kind == "user":
                    for block in _round_blocks(event):
                        # THE ONE text BLOCK IS THE PROMPT. The other 139 in a
                        # measured dev run are tool_result, which is exactly
                        # what must not be here.
                        if block.get("type") == "text":
                            turns.append({"kind": "ask", "text": _round_clean(
                                block.get("text"), pairs, 40000)})
                elif kind == "system" and event.get("subtype") == "permission_denied":
                    turns.append({"kind": "denied", "text": _round_clean(
                        json.dumps(event, sort_keys=True, default=str),
                        pairs, 2000)})
                elif kind == "result":
                    usage = event.get("usage")
                    result = {
                        "subtype": event.get("subtype"),
                        "is_error": bool(event.get("is_error")),
                        "num_turns": event.get("num_turns"),
                        "duration_ms": event.get("duration_ms"),
                        "total_cost_usd": event.get("total_cost_usd"),
                        "stop_reason": event.get("stop_reason"),
                        "usage": usage if isinstance(usage, dict) else None,
                    }
    except OSError:
        return None, None
    return turns, result


def _round_blocks(event):
    """The content blocks of a message event, defensively."""
    message = event.get("message")
    content = (message or {}).get("content") if isinstance(message, dict) else None
    if not isinstance(content, list):
        return []
    return [block for block in content if isinstance(block, dict)]


def _round_gate_tail(path, pairs):
    """The last pages of a gate log, ANSI stripped and redacted.

    SEEKED, NOT READ FORWARD. The largest of these on this host is 10.9 MB and
    the unit's MemoryHigh is 256M, so reading one to keep 64 KB of it would be a
    ceiling breach for nothing. A gate log carries no conversation at all - 38
    JSON events in 197,160 lines, and those are the application's structlog - so
    the tail is the whole of what is worth showing.
    """
    try:
        size = os.path.getsize(path)
        with open(path, "rb") as handle:
            if size > ROUND_GATE_TAIL_BYTES:
                handle.seek(size - ROUND_GATE_TAIL_BYTES)
                handle.readline()  # discard the partial line the seek landed in
            raw = handle.read().decode("utf-8", "replace")
    except OSError:
        return None
    return {"bytes": size, "truncated": size > ROUND_GATE_TAIL_BYTES,
            "text": _round_clean(raw, pairs)}


def _round_key(row):
    """worktree + start, which is already the board's own answer.

    THERE IS NO ROUND ID ANYWHERE. `chain` cannot supply one - its worktree_id
    is a PRIMARY KEY under INSERT OR REPLACE, so it holds one row against 72
    runs - and the worktree is REUSED between changes. _fleet_derive_rounds
    groups the run log on `plan` and the publication join keys on started_at, so
    the pair is what every other consumer already treats as identifying.
    """
    stamp = str(row.get("started_at") or "").replace("-", "").replace(":", "")
    return "%s-%s" % (row.get("worktree_id") or "unknown", stamp)


def _round_path(key):
    return os.path.join(DOC_DIR, "%s%s.json" % (ROUND_PREFIX, key))


# --print IS A DRY RUN AND HAS TO REACH THIS SOURCE. Every other source here is
# read-only by nature, so `--print` costing nothing was a property rather than a
# decision; this one writes AND deletes, and a person running --print to see
# what a round renders must not have the directory swept underneath them.
_ROUND_DRY_RUN = ["--print" in sys.argv]


def _round_windows(rounds):
    """{key: (worktree, start, end_exclusive)} - each round's slice of the log.

    A ROUND ENDS WHERE THE NEXT ONE ON THE SAME WORKTREE BEGINS, not at its own
    ended_at: a phase that outlived the round's last recorded end still belongs
    to it, and the alternative - a gap - would silently drop rows.
    """
    by_tree = {}
    for row in rounds:
        by_tree.setdefault(row["worktree_id"], []).append(row)
    windows = {}
    for worktree, group in by_tree.items():
        group = sorted(group, key=lambda r: str(r.get("started_at") or ""))
        for index, row in enumerate(group):
            nxt = group[index + 1] if index + 1 < len(group) else None
            windows[_round_key(row)] = (
                worktree, str(row.get("started_at") or ""),
                str(nxt.get("started_at")) if nxt else None)
    return windows


def _round_within(started_at, window):
    _worktree, start, end = window
    text = str(started_at or "")
    if text < start:
        return False
    return end is None or text < end


def _round_settled(conn, window):
    """Is there anything left that could still change this round's record?

    IT READS THE WINDOW AND THE JOB, NOT THE ROUND ROW, and the first draft got
    that wrong in a way nothing caught. It asked `row.get("closed_at")` and
    `row.get("waiting_on")` - but those keys are added by `source_fleet`'s own
    loop, not by `_fleet_derive_rounds`, which is what this source calls. So
    they were absent on every row, every round read unsettled, nothing was ever
    fresh, and the per-run budget was re-spent on the NEWEST rounds every pass
    while the older ones were never reached. Measured: five consecutive passes
    with `pending` frozen at 35.

    A LATER ROUND ON THE SAME WORKTREE CLOSES THE WINDOW, so no further phase
    can join this one - that is what `window[2]` being set means. Until then the
    round is still collecting. And an open notice or publication means the
    record is still moving even though the phases have stopped: `pr_url` and
    `closed_at` land later, and a document rendered before they did would say
    "not published" permanently, which known-state records as the claim that has
    to be outranked.
    """
    if window[2] is None:
        return False
    job = _round_job(conn, window)
    if not job:
        return True
    if _fleet_rows(conn, "SELECT 1 FROM notice WHERE flow_job_id = ?"
                         " AND closed_at IS NULL LIMIT 1", (job,)):
        return False
    return not _fleet_rows(conn, "SELECT 1 FROM publication WHERE job_id = ?"
                                 " AND closed_at IS NULL LIMIT 1", (job,))


def source_round_detail(m):
    """One document per round: what it did, and what it said while doing it.

    IT WRITES ITS OWN FILES. main() maps one document key to one path, so a
    family has no representation there - and this is also the only source that
    DELETES, which a directory contracted to "nothing accumulates" needs once
    the filenames stop being fixed.

    EVERY METRIC IS EMITTED EXACTLY ONCE, AT THE END. `Metrics.add` APPENDS a
    sample line; it does not replace one. Declaring a metric early and filling
    it in later - which reads perfectly and is what the first draft did - puts
    TWO sample lines for one name in the exposition file, and a duplicate sample
    rejects the WHOLE scrape, not just that series. Same family as the fact-key
    collision bin/lint-repo.sh leg 9 exists for.

    IT MUST NEVER RAISE for the reason source_fleet gives: the fleet page is one
    of six, and an unreadable conduct.db must cost this source and nothing else.
    """
    documents = 0
    total = 0
    pending = 0
    redacted = 0
    written = set()
    conn = None

    if os.path.exists(CONDUCT_DB):
        pairs = _round_redaction(load_env())
        if pairs is None:
            # FAIL CLOSED. See _round_redaction: this is the render-env.sh
            # window, and writing an unredacted transcript is not a recoverable
            # mistake. The sweep is skipped too - deleting what is there would
            # take the browser's only copy on the way past.
            print("collect-metrics: round detail skipped - .env unreadable, so "
                  "no redaction pass could be built", file=sys.stderr)
        else:
            redacted = 1
            try:
                conn = sqlite3.connect("file:%s?mode=ro" % CONDUCT_DB, uri=True,
                                       timeout=2.0)
                conn.execute("PRAGMA busy_timeout = 2000")
                rounds = _fleet_derive_rounds(conn)[:ROUND_KEEP]
                windows = _round_windows(rounds)
                index = _round_log_index()
                spoken_for = {row["log"] for row in _fleet_rows(
                    conn, "SELECT log FROM base_gate WHERE log IS NOT NULL")
                    if row.get("log")}
                budget = {"files": ROUND_LOG_FILES_PER_RUN,
                          "bytes": ROUND_LOG_BYTES_PER_RUN}
                for row in rounds:
                    key = _round_key(row)
                    path = _round_path(key)
                    # KEPT WHETHER OR NOT IT IS REWRITTEN THIS PASS. The sweep
                    # deletes what is not in this set, and a round that was
                    # already current would otherwise be swept for being fresh.
                    written.add(path)
                    body, short = _round_document(conn, row, windows[key], index,
                                                  spoken_for, pairs, budget)
                    pending += short
                    if body is None:
                        continue
                    if _ROUND_DRY_RUN[0]:
                        sys.stdout.write("# %s\n%s"
                                         % (os.path.basename(path), body))
                    else:
                        write_document(path, body)
            except (sqlite3.Error, OSError, IndexError, ValueError) as exc:
                print("collect-metrics: round detail: %s" % exc, file=sys.stderr)
            finally:
                if conn is not None:
                    conn.close()
            documents, total = _round_sweep(written)

    m.add("home_server_agent_round_documents", documents, None,
          "Round documents on disk after this run. Each is one round's events, "
          "its approval card and its rendered phase conversations.")
    m.add("home_server_agent_round_bytes", total, None,
          "Total size of those documents.")
    m.add("home_server_agent_round_pending", pending, None,
          "Phases whose logs have not been rendered yet. Non-zero is ordinary "
          "on a cold start - the per-run budget makes it converge over several "
          "passes rather than blow the unit's 25-second timeout.")
    m.add("home_server_agent_round_redacted", redacted, None,
          "1 when the redaction pass was built from .env and the render ran. 0 "
          "means .env could not be read and NOTHING was rendered - the pass "
          "fails closed, because a redactor built from an empty environment "
          "looks exactly like one that found nothing to redact.")


def _round_sweep(keep):
    """`keep` IS A SET OF FULL PATHS, not keys - the first draft passed
    `set(written)` over a dict and got its keys, so no path ever matched and
    every document was deleted immediately after being written. The symptom was
    a metric reading 0 documents beside another reading 35 phases pending.

    Delete round documents for rounds that have aged off the board.

    THE FIRST RECONCILIATION THIS FILE PERFORMS, and it is what keeps the
    directory's own contract - "rewritten whole on every run, nothing
    accumulates, and there is no history to mine" - true now that the filenames
    are derived from data rather than fixed.

    THE .tmp FILES GO TOO. write_document stages beside its target so the file
    inherits container_file_t, and Caddy's `/data/*` is a glob - so a crash
    between write and rename leaves something served. verify-host.sh already
    does exactly this for status.json.tmp.
    """
    kept = 0
    total = 0
    try:
        names = os.listdir(DOC_DIR)
    except OSError:
        return 0, 0
    if _ROUND_DRY_RUN[0]:
        # Count what is there; delete nothing.
        for name in names:
            if name.startswith(ROUND_PREFIX) and not name.endswith(".tmp"):
                try:
                    total += os.path.getsize(os.path.join(DOC_DIR, name))
                    kept += 1
                except OSError:
                    pass
        return kept, total
    for name in names:
        if not name.startswith(ROUND_PREFIX):
            continue
        path = os.path.join(DOC_DIR, name)
        if name.endswith(".tmp") or path not in keep:
            try:
                os.remove(path)
            except OSError:
                pass
            continue
        try:
            total += os.path.getsize(path)
            kept += 1
        except OSError:
            pass
    return kept, total


def _round_document(conn, row, window, index, spoken_for, pairs, budget):
    """(rendered body, rounds still short of their logs) for one round.

    TWO PASSES, AND THE SPLIT IS LOAD-BEARING. Everything from the database -
    the events, the approval card, the verdict - is rendered on EVERY run,
    because a round waiting on a person must never wait on a 10 MB log read to
    show the card they are being asked to approve. The logs are rendered under a
    per-run budget, and a round that did not get its turn says so rather than
    rendering a conversation with holes in it.
    """
    key = _round_key(row)
    path = _round_path(key)
    settled = _round_settled(conn, window)
    runs = [r for r in _fleet_rows(conn, """
        SELECT %s FROM run WHERE worktree_id IN (?, ?) ORDER BY id
    """ % _round_run_columns(conn), (window[0], window[0] + FLEET_VERIFY_SUFFIX))
        if _round_within(r.get("started_at"), window)]

    logs = {}
    claimed = set()
    for position, run in enumerate(runs):
        # THE CEILING IS THE NEXT RUN ON THE SAME WORKTREE, or the round's own
        # end. Runs on `<id>-verify` interleave with runs on `<id>`, and their
        # logs live under different keys, so the sequence has to be per tree.
        ceiling = None
        for later in runs[position + 1:]:
            if later.get("worktree_id") == run.get("worktree_id"):
                ceiling = _round_stamp(later.get("started_at"))
                break
        if ceiling is None and window[2] is not None:
            ceiling = _round_stamp(window[2])
        found = _round_log_for(run, index, spoken_for, claimed, ceiling)
        if found:
            logs[run["id"]] = found
            claimed.add(found)

    if _ROUND_DRY_RUN[0] or not _round_fresh(path, logs.values(), settled):
        phases, short = _round_phases(runs, logs, pairs, budget)
        doc = Document()
        doc.set("round", _round_summary(conn, row, window, settled))
        doc.set("events", _round_events(conn, row, window, runs))
        doc.set("report", _round_report(conn, row, window, pairs, settled))
        doc.set("phases", phases)
        doc.note("conduct_db", True)
        body = doc.render(now())
        if len(body) > ROUND_DOC_MAX_BYTES:
            doc.set("phases", [dict(p, turns=[], clipped=True) for p in phases])
            doc.set("clipped", "the conversation was dropped: %d bytes over the "
                               "%d-byte ceiling" % (len(body), ROUND_DOC_MAX_BYTES))
            body = doc.render(now())
        return body, short
    return None, 0


def _round_run_columns(conn):
    """The run columns to select, skipping any conduct has not migrated yet.

    THE TWO HALVES DEPLOY SEPARATELY - the collector arrives with `git pull` and
    a column with a conduct restart - and a SELECT naming one too early reads as
    an unreadable database. _fleet_derive_rounds learned this on 2026-08-28.
    """
    always = ["id", "project", "phase", "worktree_id", "started_at", "ended_at",
              "result", "exit_code", "cost_usd", "tokens_in", "tokens_out"]
    optional = [name for name in ("odoo_task", "error", "branch", "verdict",
                                  "task", "base_sha", "log", "quota_status")
                if _fleet_has(conn, "run", name)]
    return ", ".join(always + optional)


def _round_fresh(path, log_paths, settled):
    """Is the document on disk already current for this round?

    A SETTLED ROUND RENDERS ONCE. An unsettled one renders every pass, because
    its rows are still moving - and there is at most one or two of those. Beyond
    that the only thing that can change a finished round is a log arriving late,
    so the document's own mtime against its inputs answers it.

    EXCEPT THAT A DEFERRED PHASE MUST COME BACK, and the first draft of this
    made sure it never did. The per-run budget writes a document with some
    phases unrendered; this then called that document current, so those phases
    stayed unrendered for ever and the whole "a cold start converges over
    several passes" claim was false. Measured on the live host: three
    consecutive passes with `pending` frozen at 35 and `bytes` unchanged.

    So a document carrying a budget-deferred phase is NOT fresh. `short` is the
    discriminator rather than `rendered`, because a phase whose log has aged out
    of LOG_RETAIN_SEC is also unrendered and will never become renderable - and
    keying on that would re-render every old round on every pass for ever, which
    is the same defect pointing the other way.
    """
    if not settled:
        return False
    try:
        stamp = os.path.getmtime(path)
        with open(path, "r", encoding="utf-8") as handle:
            existing = json.load(handle)
    except (OSError, ValueError):
        return False
    for phase in existing.get("phases") or []:
        if isinstance(phase, dict) and phase.get("short"):
            return False
    for log_path in log_paths:
        try:
            if os.path.getmtime(log_path) > stamp:
                return False
        except OSError:
            continue
    return True


def _round_phases(runs, logs, pairs, budget):
    """One entry per run, with its conversation if the budget reached it."""
    phases = []
    short = 0
    for run in runs:
        entry = {
            "run_id": run["id"],
            "phase": run.get("phase"),
            "worktree_id": run.get("worktree_id"),
            "started_at": run.get("started_at"),
            "ended_at": run.get("ended_at"),
            "result": run.get("result"),
            "exit_code": run.get("exit_code"),
            "cost_usd": run.get("cost_usd"),
            "tokens_in": run.get("tokens_in"),
            "tokens_out": run.get("tokens_out"),
            "log": os.path.basename(logs[run["id"]]) if run["id"] in logs else None,
            "turns": [],
            "result_event": None,
            "gate": None,
            "rendered": False,
        }
        path = logs.get(run["id"])
        if path:
            size = 0
            try:
                size = os.path.getsize(path)
            except OSError:
                pass
            if budget["files"] <= 0 or size > budget["bytes"]:
                # NOT AN ERROR AND NOT AN EMPTY CONVERSATION. `rendered` false
                # is what lets the browser say "not yet" instead of drawing a
                # phase that said nothing.
                entry["short"] = "not rendered yet - this run's budget was spent"
                short += 1
            else:
                budget["files"] -= 1
                budget["bytes"] -= size
                if run.get("phase") == "verify":
                    entry["gate"] = _round_gate_tail(path, pairs)
                else:
                    turns, result_event = _round_conversation(path, pairs)
                    entry["turns"] = turns or []
                    entry["result_event"] = result_event
                entry["rendered"] = True
        phases.append(entry)
    return phases, short


def _round_summary(conn, row, window, settled):
    """Who this round is, so the panel need not be handed a fleet row too."""
    return {
        "key": _round_key(row),
        "worktree_id": row.get("worktree_id"),
        "project": row.get("project"),
        "odoo_task": row.get("odoo_task"),
        "started_at": row.get("started_at"),
        "ended_at": row.get("ended_at"),
        "closed_at": row.get("closed_at"),
        "closed_why": row.get("closed_why"),
        "attempts": row.get("attempts"),
        "max_attempts": row.get("max_attempts"),
        "branch": row.get("branch"),
        "phase": row.get("phase"),
        "waiting_on": row.get("waiting_on"),
        "flow_job_id": _round_job(conn, window),
        "settled": settled,
    }


def _round_job(conn, window):
    """The flow job this round ran under, from its own dispatch rows.

    `chain.flow_job_id` ONLY ANSWERS FOR THE ROUND IN FLIGHT - one row per
    worktree, overwritten - and `publication` only exists once a round reaches
    the publish path. `dispatch` carries worktree_id, flow_job_id AND
    started_at, so it is the one table that can name the job of a round that is
    finished, refused, or still running.
    """
    for row in _fleet_rows(conn, """
        SELECT flow_job_id, started_at FROM dispatch
         WHERE worktree_id = ? ORDER BY started_at
    """, (window[0],)):
        if _round_within(row.get("started_at"), window):
            return row.get("flow_job_id")
    return None


def _round_events(conn, row, window, runs):
    """The round as a timeline, from the three append-only tables.

    RETRIES ARE VISIBLE AND NOT LABELLED. Nothing in conduct's schema records
    that an attempt was a repair rather than a fresh round - only
    chain.attempts, a counter on a row the next round overwrites - so the
    timeline shows the phases that ran and does not claim to know which kind of
    attempt produced them. Saying less is the only honest option available.
    """
    events = []
    for run in runs:
        events.append({"at": run.get("started_at"), "kind": "phase_started",
                       "phase": run.get("phase"), "run_id": run["id"]})
        if run.get("ended_at"):
            events.append({
                "at": run.get("ended_at"), "kind": "phase_ended",
                "phase": run.get("phase"), "run_id": run["id"],
                "result": run.get("result"), "exit_code": run.get("exit_code"),
                "error": _fleet_text(run.get("error"), 400),
            })
    for step in _fleet_rows(conn, """
        SELECT module_id, worktree_id, started_at, resumed_at%s
          FROM dispatch WHERE worktree_id = ? ORDER BY started_at
    """ % (", undeliverable_at"
           if _fleet_has(conn, "dispatch", "undeliverable_at") else ""),
            (window[0],)):
        if not _round_within(step.get("started_at"), window):
            continue
        events.append({"at": step.get("started_at"), "kind": "step_dispatched",
                       "module": step.get("module_id")})
        if step.get("resumed_at"):
            events.append({"at": step.get("resumed_at"), "kind": "step_answered",
                           "module": step.get("module_id")})
        if step.get("undeliverable_at"):
            events.append({"at": step.get("undeliverable_at"),
                           "kind": "step_undeliverable",
                           "module": step.get("module_id")})

    job_id = _round_job(conn, window)
    if job_id:
        for notice in _fleet_rows(conn, """
            SELECT kind, summary, first_at, last_at, sends, closed_at
              FROM notice WHERE flow_job_id = ? ORDER BY first_at
        """, (job_id,)):
            events.append({"at": notice.get("first_at"), "kind": "notified",
                           "notice": notice.get("kind"),
                           "sends": notice.get("sends"),
                           "summary": _fleet_text(notice.get("summary"), 400)})
            if notice.get("closed_at"):
                events.append({"at": notice.get("closed_at"),
                               "kind": "notice_closed",
                               "notice": notice.get("kind")})
        pub_columns = ("opened_at, closed_at, branch, pr_url, pr_number"
                       if _fleet_has(conn, "publication", "pr_url")
                       else "opened_at, closed_at, branch")
        for pub in _fleet_rows(conn, "SELECT %s FROM publication"
                                     " WHERE job_id = ?" % pub_columns, (job_id,)):
            events.append({"at": pub.get("opened_at"), "kind": "publication_opened",
                           "branch": pub.get("branch")})
            if pub.get("closed_at"):
                events.append({
                    "at": pub.get("closed_at"), "kind": "publication_closed",
                    # A CLOSED PUBLICATION WITH NO PULL REQUEST IS A THIRD
                    # STATE, not either neighbour: it is a decline or a timeout.
                    "pr_url": _fleet_link(pub.get("pr_url")),
                    "pr_number": pub.get("pr_number")})
    events.sort(key=lambda event: (str(event.get("at") or ""), event["kind"]))
    return events


def _round_report(conn, row, window, pairs, settled):
    """The approval card and what it was built from.

    THE CARD IS ALREADY IN THE DATABASE, TWICE, and neither copy is the one the
    board has been showing. `notice.summary` is the PHONE copy - rendered at the
    verify stage, hard-bounded at 3500 bytes and then truncated to 240
    characters on its way here - while the card a person actually approves is
    the ship-stage rendering, ~7.5 KB, and it lives in `report.body["card"]` and
    in `dispatch.payload` for conduct_ship.

    THE dispatch COPY IS PREFERRED because it is keyed per FLOW JOB, so it
    survives the next round on the same worktree overwriting `report` - which is
    keyed on worktree_id alone and holds exactly one row.
    """
    payload = None
    job_id = _round_job(conn, window)
    if job_id:
        rows = _fleet_rows(conn, "SELECT payload FROM dispatch WHERE"
                                 " flow_job_id = ? AND module_id = ?",
                           (job_id, "conduct_ship"))
        if rows and rows[0].get("payload"):
            try:
                payload = json.loads(rows[0]["payload"])
            except ValueError:
                payload = None
    if payload is None and not settled:
        rows = _fleet_rows(conn, "SELECT body FROM report WHERE worktree_id = ?",
                           (window[0],))
        if rows and rows[0].get("body"):
            try:
                payload = json.loads(rows[0]["body"])
            except ValueError:
                payload = None
    if not isinstance(payload, dict):
        return None
    return {
        "card": _round_clean(payload.get("card"), pairs, 40000),
        "verdict": _round_clean(payload.get("verdict"), pairs, 40000),
        "body": _round_clean(payload.get("body"), pairs, 20000),
        "title": _round_clean(payload.get("title"), pairs, 400),
        "autopublish": payload.get("autopublish"),
        "autopublish_why": [_round_clean(x, pairs, 400)
                            for x in (payload.get("autopublish_why") or [])],
        "notes": [_round_clean(x, pairs, 400)
                  for x in (payload.get("notes") or [])],
        "refused": [_round_clean(x, pairs, 400)
                    for x in (payload.get("refused") or [])],
        "gate_ok": payload.get("gate_ok"),
        "base_sha": payload.get("base_sha"),
        "head_sha": payload.get("head_sha"),
        "seconds": payload.get("seconds"),
    }

# ------------------------------------------------------------------------------
# The collector's own record
# ------------------------------------------------------------------------------
# There is deliberately no home_server_collector_up 1. A sample asserting
# liveness can only be written by something that is alive, so it is a tautology
# that reads green for ever after this stops running. The timestamp below is
# written INTO the file this run produces: if the run fails the file is not
# replaced, so the last value present is by construction the last success - and
# node_textfile_mtime_seconds says the same thing from outside.

# (name, function, slow). A slow source runs every 5 minutes rather than every
# tick, because its cost is real: smartctl talks to the drive, and the
# application sources fork a process inside the container being measured.
#
# Tier selection is `int(time.time()) % 300 < 30` - wall-clock modulo, so it is
# stateless, cannot drift, and cannot get stuck. A slow round lost to a skipped
# tick is picked up five minutes later.
#
# SLOW SOURCES WRITE THEIR OWN FILE, and that is not tidiness. The textfile is
# rewritten whole on every run, so if the slow series were in it they would
# vanish for nine ticks out of ten and reappear on the tenth - a sawtooth of
# gaps that looks exactly like a flapping disk. node-exporter globs *.prom, so a
# second file is simply served unchanged in between.
# (name, function, slow, document). The fourth field is which document the
# source writes into, and a source that writes one is called with (m, doc)
# instead of (m) - the two call shapes are worth the little ugliness in main()
# because the alternative is threading an unused argument through the seven
# sources that produce no document at all.
#
# THE FAST TIER GAINED TWO APPLICATION SOURCES, WHICH BREAKS THE OLD RULE THAT
# APPLICATION POLLS ARE SLOW, and the reason is worth stating: the slow tier is
# five minutes, and a progress bar five minutes out of date is not stale, it is
# wrong. Both new sources are progress - a playback position and a download
# percentage - so they go where the resolution is. Measured cost: one
# `podman exec ... curl` is about 0.12 s, these add five, and the whole fast
# tier was 0.114 s against a 30 s budget.
SOURCES = (
    ("filesystems", source_filesystems, False, None),
    ("network", source_network, False, None),
    ("units", source_units, False, None),
    ("containers", source_containers, False, None),
    ("container_network", source_container_network, False, None),
    ("gpu", source_gpu, False, None),
    ("sensors", source_sensors, False, None),
    ("status", source_status, False, None),
    ("agents", source_agents, False, None),
    ("ci", source_ci, False, None),
    ("playback", source_playback, False, "activity"),
    ("transfers", source_transfers, False, "activity"),
    ("smart", source_smart, True, None),
    ("arr", source_arr, True, None),
    ("jellyfin", source_jellyfin, True, None),
    ("torrent", source_torrent, True, None),
    ("tdarr", source_tdarr, True, None),
    ("requests", source_requests, True, "library"),
    ("catalogue", source_catalogue, True, "library"),
    ("fleet", source_fleet, True, "fleet"),
    # FAST, AND THE ONLY DOCUMENT SOURCE THAT IS. A command a person just
    # sent is the one thing on the Agents page whose staleness they can
    # measure against their own hand.
    ("control", source_control, False, "control"),
    # SLOW, AND IT WRITES A FAMILY RATHER THAN A DOCUMENT. The fourth field is
    # None because _DOC_PATHS is one key to one path and this source writes one
    # file per round - see source_round_detail, which also owns the sweep.
    ("round_detail", source_round_detail, True, None),
)


def _name_the_non_ascii(body, exc):
    """The offending line, so the series names itself rather than a byte offset.

    A UnicodeEncodeError reports a position in a file thousands of characters
    long, which is true and useless. What is wanted is the metric.
    """
    try:
        line = body.count("\n", 0, exc.start)
        return body.splitlines()[line][:160]
    except Exception:  # noqa: BLE001 - a diagnostic must never raise
        return "<could not locate the line>"


def write_textfile(path, body):
    """Atomic replace. os.replace cannot be interrupted halfway within one
    filesystem, and node-exporter globs *.prom - so the .tmp is never read and a
    reader never sees a partial file.

    ASCII IS A GUARD RATHER THAN A LIMITATION, and it caught a real violation on
    2026-08-20: a slow-tier render carried a 'u umlaut', which can only have come
    from a media title reaching a LABEL. This repository's rule is that titles
    live in the documents below and never in a series - cardinality is the lesser
    reason, and a 400-day history of who watched what being surveillance of the
    household rather than monitoring of a machine is the greater one. Prometheus
    would accept the UTF-8 happily, which is exactly why nothing else would have
    noticed.

    BUT IT WAS FATAL, AND THAT WAS THE BUG. UnicodeEncodeError is not an
    OSError, so the handler below did not catch it and the exception took the
    WHOLE collection run down - twice an hour, silently, with the fast tier
    losing its cycle for a fault in the slow one. It is caught now and the
    offending line is named, so the violation is reported rather than either
    crashing or being quietly re-encoded.
    """
    try:
        os.makedirs(os.path.dirname(path), exist_ok=True)
        tmp = path + ".tmp"
        with open(tmp, "w", encoding="ascii") as fh:
            fh.write(body)
        os.replace(tmp, path)
        return True
    except UnicodeEncodeError as exc:
        print("collect-metrics: %s carries a non-ASCII character (%r), which "
              "means a title has reached a label - the series is: %s"
              % (path, exc.object[exc.start:exc.end], _name_the_non_ascii(body, exc)),
              file=sys.stderr)
        return False
    except OSError as exc:
        print("collect-metrics: cannot write %s: %s" % (path, exc),
              file=sys.stderr)
        return False


def write_document(path, body):
    """Atomic replace, with the .tmp INSIDE the served directory.

    THAT IS NOT A DETAIL. The dashboard container reads this over a rootless
    bind mount, so the file has to be container_file_t - which it gets by being
    CREATED in a directory that already is. A file written to /tmp and renamed
    in keeps tmp_t, and the container gets permission denied on something that
    looks perfectly ordinary from the host. Same trap status.json's second copy
    documents, from the other direction.
    """
    try:
        os.makedirs(os.path.dirname(path), exist_ok=True)
        tmp = path + ".tmp"
        with open(tmp, "w", encoding="ascii") as fh:
            fh.write(body)
        os.replace(tmp, path)
        return True
    except OSError as exc:
        print("collect-metrics: cannot write %s: %s" % (path, exc),
              file=sys.stderr)
        return False


def write_marker(ok, started, duration, failed, series):
    """key=value, ISO-8601 UTC, tmp+mv - the backup-state convention exactly.

    last_ok_at only advances on a successful run, so "failing since Tuesday" and
    "has never once run" do not look alike.
    """
    previous = {}
    try:
        for line in read_text(MARKER).splitlines():
            if "=" in line:
                key, _, value = line.partition("=")
                previous[key] = value
    except OSError:
        pass
    stamp = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime(started))
    state = {
        "last_run_at": stamp,
        "last_ok_at": stamp if ok else previous.get("last_ok_at", ""),
        "sources_failed": ",".join(failed),
        "series": str(series),
        "collect_seconds": "%.3f" % duration,
    }
    body = "".join("%s=%s\n" % kv for kv in sorted(state.items()))
    try:
        os.makedirs(os.path.dirname(MARKER), exist_ok=True)
        tmp = MARKER + ".tmp"
        with open(tmp, "w", encoding="ascii") as fh:
            fh.write(body)
        os.replace(tmp, MARKER)
    except OSError as exc:
        print("collect-metrics: cannot write %s: %s" % (MARKER, exc),
              file=sys.stderr)


# A DICT RATHER THAN A TERNARY, which it was while there were two. A third
# document would have silently been written to library.json - same bytes, same
# permissions, no error anywhere, and the Library page rendering a fleet.
_DOC_PATHS = {"activity": DOC_ACTIVITY, "library": DOC_LIBRARY,
              "fleet": DOC_FLEET, "control": DOC_CONTROL}


def _doc_path(key):
    return _DOC_PATHS[key]


def main():
    only = None
    to_stdout = "--print" in sys.argv
    if "--source" in sys.argv:
        idx = sys.argv.index("--source")
        if idx + 1 < len(sys.argv):
            only = sys.argv[idx + 1]

    started = now()
    # Forced with --slow or --source, so a slow source is testable by hand
    # without waiting up to five minutes for its turn to come round.
    slow_due = ("--slow" in sys.argv or only is not None
                or int(started) % 300 < 30)

    m = Metrics()
    slow = Metrics()
    docs = {key: Document() for key in _DOC_PATHS}
    wrote_doc = set()
    failed = []
    for name, fn, is_slow, doc_key in SOURCES:
        if only and name != only:
            continue
        if is_slow and not slow_due:
            continue
        target = slow if is_slow else m
        t0 = now()
        try:
            if doc_key:
                fn(target, docs[doc_key])
                wrote_doc.add(doc_key)
            else:
                fn(target)
            up = 1
        except Exception as exc:  # noqa: BLE001 - one source must not stop the rest
            up = 0
            failed.append(name)
            print("collect-metrics: source %s failed: %s" % (name, exc),
                  file=sys.stderr)
            # A DOCUMENT SOURCE THAT RAISED STILL COUNTS AS HAVING WRITTEN.
            # It has already called doc.note(..., False) on its way down, so the
            # document goes out saying which upstream did not answer - which is
            # the entire reason `sources` exists. Skipping the write here would
            # leave the previous file in place and the page would render a dead
            # application as fresh data.
            if doc_key:
                wrote_doc.add(doc_key)
        target.add("home_server_collector_source_up", up, {"source": name},
                   "1 when this source produced its series on the last run.")
        target.add("home_server_collector_source_duration_seconds",
                   "%.4f" % (now() - t0), {"source": name},
                   "Wall time for this source.")

    duration = now() - started
    m.add("home_server_collector_last_success_timestamp_seconds",
          "%.3f" % started if not failed else None, None,
          "When this collector last completed every source. A TIMESTAMP, not "
          "an age: an age gauge freezes at its last value and reads '30 seconds "
          "old' for ever after the collector dies.")
    m.add("home_server_collector_duration_seconds", "%.4f" % duration, None,
          "Wall time for the whole run.")
    # Zero is written explicitly rather than omitted, because this series exists
    # precisely to catch a silent absence and a series that is only present when
    # something is wrong cannot be alerted on with `== 0` or graphed as healthy.
    m.add("home_server_collector_client_unavailable", len(MISSING_CLIENT), None,
          "Containers that answered neither curl nor wget, so an application "
          "endpoint could not be polled at all. This is NOT the same as an "
          "endpoint with nothing to report, and conflating them hid "
          "home_server_vpn_info's total absence for months.")
    m.add("home_server_collector_series", m.count + slow.count + 1, None,
          "Series written last run. A source that silently stops emitting a "
          "sub-family looks identical to one emitting legitimate absence; a "
          "count catches it.")

    if to_stdout:
        sys.stdout.write(m.render())
        if slow.count:
            sys.stdout.write(slow.render())
        for key in sorted(wrote_doc):
            sys.stdout.write("# %s\n%s" % (os.path.basename(_doc_path(key)),
                                           docs[key].render(started)))
    else:
        if not write_textfile(TEXTFILE, m.render()):
            failed.append("write")
        # Only rewritten when the slow tier actually ran. Left alone otherwise,
        # so node-exporter keeps serving the previous values instead of the
        # series blinking out for nine ticks in ten.
        if slow.count and not write_textfile(TEXTFILE_SLOW, slow.render()):
            failed.append("write_slow")
            failed.append("write")
        # Same rule for the documents, and for the same reason: the slow one is
        # left alone on a fast-only tick rather than rewritten empty. Its own
        # generated_at is what tells the page how old it is, so a carried-forward
        # file cannot read as current.
        for key in sorted(wrote_doc):
            if not write_document(_doc_path(key), docs[key].render(started)):
                failed.append("write_%s" % key)

    write_marker(not failed, started, duration, failed, m.count)
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main())
