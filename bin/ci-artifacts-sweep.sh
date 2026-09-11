#!/usr/bin/env bash
# ==============================================================================
# Sweep the CI lanes' shared artifact store, and only ever half of it
# ------------------------------------------------------------------------------
# upskald's CI hands work between jobs through a directory mounted into every
# lane at /opt/ci-artifacts, exported to a job as $CI_ARTIFACT_STORE. It has two
# subtrees and they want opposite treatment, which is the entire reason this
# script exists rather than a `find -delete` in a timer:
#
#   runs/   <owner>/<repo>/<run_id>/<run_attempt>/<name>/   sweep this
#   state/  <owner>/<repo>/baselines.json                   NEVER sweep this
#
# state/ IS THE COVERAGE RATCHET'S MEMORY - the percentage each surface may not
# regress below - and its loss mode is silent by upskald's own account: their
# gate reads "no baseline recorded" and PASSES, for every surface at once. It is
# a few hundred bytes. It is backed up by bin/backup-server.sh, and this script
# must never be the reason it needs to be restored.
#
# TWO WINDOWS, AND THE CLASS THAT GETS THE SHORT ONE IS 99.96% OF THE STORE.
#
#   *-nyc            CI_ARTIFACT_NYC_KEEP_DAYS    3 days,  floor 2
#   everything else  CI_ARTIFACT_KEEP_DAYS       30 days,  floor 7
#
# Measured 2026-09-11 over the 106 run-attempts then in the store, spanning
# 2026-08-27 to 09-10:
#
#   e2e-shard-N-nyc      53638 MB    99.96%
#   e2e-shard-N-blob       270 MB
#   e2e-shard-N-apicov     202 MB
#   total                53659 MB    against a 40960 MB budget
#
# So the entire store MINUS nyc is 472 MB for fifteen days of CI. Thirty days of
# everything-but-nyc is about 1 GB; three days of nyc is about 11 GB at the
# measured 7.07 runs a day, and about 26 GB at the 17 a day this store has
# actually been seen to do. Seven days of nyc would be 25 GB at the mean and
# would breach again on the very next burst, which is why it is three and not
# the seven that would have matched upskald's own retention-days on everything
# else. The floor is two: the fan-in reads nyc minutes after it is written, so
# two days is already a re-run over a weekend.
#
# THIRTY CAME BACK FOR EVERYTHING ELSE, which is what upskald asked for in the
# first place and what this file spent two revisions unable to afford. It costs
# about 1 GB. The thirteen-day compromise below is history now, and it is kept
# because the arithmetic that produced it is what proves the split was the only
# lever left: no window on a single class could have fitted this store.
#
# THE HONEST LIMITATION, BECAUSE IT WILL FIRE AGAIN. 6.07 a day is the mean over
# fourteen days and the arrival rate is NOT flat - 2026-09-02 to 09-06 saw none
# at all, and the three days to 09-09 ran at fifteen. At fifteen a day thirteen
# days is 98 GB and ci.artifact_store warns again, which would be the check
# working rather than this number being wrong. What changes the shape rather
# than the threshold is what is IN a run, and that is recorded below.
#
# THE SIZING ABOVE USED TO READ "about 2.5 MB per run, against 153 GB free on
# /var" AND IT WAS NEVER RIGHT. Measured 2026-09-09 over the 75 runs then in the
# store: a mean of 506 MB, and stable at 400-530 MB on every one of the 13 days
# the store had existed - so this was not drift, the figure was wrong from the
# start. The bulk is e2e-shard-N-nyc raw coverage at 220-311 MB a shard. At the
# measured 5.8 runs a day, thirty days is about 86 GB, against 86 GiB free.
#
# THE STORE HAD NEVER REACHED STEADY STATE WHEN THAT WAS DISCOVERED, which is
# why nothing looked wrong: it began on 2026-08-27, so at day 13 of a 30-day
# window NOTHING had been evicted yet and the first eviction was 2026-09-26.
# A sweep reporting "swept 0 runs" was correct and told nobody anything.
#
# SO THE WINDOW MOVED ON 2026-09-09, ONE CONDITION SHORT OF WHAT THIS COMMENT
# USED TO ASK FOR. It said to decide "with those two numbers in hand and the
# first real eviction observed" - and the first eviction was not due until
# 2026-09-26, because the store began on 08-27. That condition assumed the store
# would still fit when it arrived. It did not: at day fourteen, with nothing yet
# evicted, the store was 42976 MB against a 40960 MB budget, and thirty days at
# the measured rate is about 92 GB on a volume with 88 GB free. Waiting for the
# eviction meant watching it double first.
#
# THE QUESTION THIS FILE USED TO ASK HAS BEEN ANSWERED, AND THE ANSWER IS WHAT
# PERMITS THE SPLIT. It read: "on an unverified assumption about what in upskald
# reads raw nyc output. Answer that question first." Answered 2026-09-11, by
# reading upskald's workflows rather than reasoning about them:
#
#   - -nyc is stored by e2e-tests in ci.yml and fetched by EXACTLY ONE consumer,
#     e2e-and-coverage-report - the same run's fan-in, minutes later.
#   - .github/actions/artifact-fetch defaults run-id to github.run_id and NO
#     workflow passes a foreign one. Six store/fetch call sites exist in that
#     repository and all six are in ci.yml.
#   - The outputs a PERSON opens - coverage-report-e2e, playwright-report - go
#     to GitHub at retention-days: 7, never to this store.
#
# AND THE SEVEN-DAY FLOOR'S OWN JUSTIFICATION TURNED OUT NOT TO APPLY HERE. The
# merge-time consumer that reads a pull request's LAST run - the one case a
# short retention hits, and the whole reason the floor is hard - is
# coverage-baseline.yml, and it reads actions/download-artifact against GITHUB
# artifacts at retention-days: 30. It never opens $CI_ARTIFACT_STORE at all.
# The floor stays anyway on everything but nyc, because upskald's own runbook
# says "we will move the rest as their consuming workflows move onto the lanes"
# - so the next cross-run artifact to arrive lands in the 30-day class by
# default and is covered without anybody having to remember this paragraph.
#
# THE GRANULARITY IS STILL A WHOLE RUN FOR EVERY CLASS BUT ONE, and that
# exception is the price, said out loud rather than left to be discovered. A
# run's artifacts are written by several jobs at several times, so sweeping
# individual directories leaves a run half-present - which reads to a consumer
# as "this artifact was never uploaded" rather than "this run has expired".
# That is exactly what nyc now gets. It is affordable ONLY because of the
# measurement above: nyc has no reader outside its own run, and inside that run
# it is read minutes after it is written, where no window this script can set
# will ever reach it. Nothing else is swept by class, and adding a second class
# means answering the same question again for that one.
#
# WHAT CHANGES THE SHAPE RATHER THAN THE THRESHOLD IS STILL NOT THIS. 506 MB a
# run is raw per-context Istanbul JSON - about 130 files of 4 MB a shard - which
# compresses roughly 10-20x, so compressing .nyc_output in upskald's own
# scripts/local_artifacts.py would make this window academic. Recorded so it is
# not rediscovered as a new idea: it is another repository, and not this
# script's to take.
#
# -mtime +N TRUNCATES, so `+3` means "past four full days" and `+30` means "past
# thirty-one". find divides the age by 86400 and drops the remainder before
# comparing. Left uncorrected rather than fixed, because both numbers above were
# sized on the generous reading and a correction would silently shorten them.
#
# AND IT WRITES ITS OWN TIMESTAMP, which is the rule CLAUDE.md states in general
# terms: an automated job needs a durable record of its last success, not just a
# unit that exits 0. ExecMainExitTimestamp is runtime state a reboot wipes, and
# a job that has never run and one that has not run since boot look identical
# through it. ci.artifact_store in bin/verify-host.sh reads the marker.
#
# See: docs/ci.md, bin/github-runner.sh, host/systemd/home-server-ci-artifacts-sweep.service
# ==============================================================================
set -euo pipefail

CACHE_ROOT="${DOCKER_VOLUME_CACHE:-/var/home-server/cache}"
FLEET_ROOT="${GITHUB_RUNNER_ROOT:-$CACHE_ROOT/github-runner}"
ARTIFACTS="${GITHUB_RUNNER_ARTIFACTS:-$FLEET_ROOT/artifacts}"
KEEP_DAYS="${CI_ARTIFACT_KEEP_DAYS:-30}"
NYC_KEEP_DAYS="${CI_ARTIFACT_NYC_KEEP_DAYS:-3}"
# THE GLOB THAT DECIDES WHICH CLASS AN ARTIFACT IS IN, spelled once. It matches
# an artifact directory's own name at depth 5 - e2e-shard-1-nyc, e2e-shard-2-nyc
# - and nothing else in the store ends in -nyc. Widening it is how the whole-run
# rule gets lost by accident, so it is a literal and not a list.
NYC_GLOB='*-nyc'
MARKER="${HOME_SERVER_CI_ARTIFACT_STATE:-${HOME:-/var/home/core}/.cache/home-server/ci-artifacts-state}"

DRY_RUN=0
[ "${1:-}" = --dry-run ] && DRY_RUN=1

log() { printf 'ci-artifacts-sweep: %s\n' "$*"; }
die() { printf 'ci-artifacts-sweep: %s\n' "$*" >&2; exit 1; }

# THE REFUSALS COME FIRST AND THEY ARE THE POINT OF THE FILE. Everything below
# runs `rm -rf` in a loop; everything here is what stops it running it somewhere
# else. A store that is absent is not an error - the lanes create it in their
# preflight and this timer may simply have fired before either lane ever started.
[ -d "$ARTIFACTS" ] || { log "no store at $ARTIFACTS yet - nothing to sweep"; exit 0; }
[ -d "$ARTIFACTS/runs" ] || { log "no runs/ under $ARTIFACTS yet - nothing to sweep"; exit 0; }

# `runs` IS SPELLED OUT HERE AND NOWHERE ELSE, so there is exactly one line in
# this repository that decides which subtree is disposable.
SWEEP_ROOT="$ARTIFACTS/runs"
case "$SWEEP_ROOT" in
	*/runs) ;;
	*) die "refusing to sweep '$SWEEP_ROOT', which does not end in /runs" ;;
esac
[ -d "$ARTIFACTS/state" ] ||
	log "WARNING: $ARTIFACTS/state does not exist - the coverage baseline has not been seeded yet"

case "$KEEP_DAYS" in
	''|*[!0-9]*) die "CI_ARTIFACT_KEEP_DAYS is '$KEEP_DAYS', which is not a number of days" ;;
esac
[ "$KEEP_DAYS" -ge 7 ] ||
	die "CI_ARTIFACT_KEEP_DAYS is $KEEP_DAYS - below 7 days this breaks the merge-time consumer that reads a pull request's last CI run, which is the one case a short retention hits and nothing else"

# TWO FLOORS, AND THEY DEFEND DIFFERENT THINGS. Seven above is the cross-run
# consumer. Two here is the only thing nyc has to survive: its reader is the
# same run's fan-in, so the floor is a re-run of that job rather than a
# consumer weeks later.
case "$NYC_KEEP_DAYS" in
	''|*[!0-9]*) die "CI_ARTIFACT_NYC_KEEP_DAYS is '$NYC_KEEP_DAYS', which is not a number of days" ;;
esac
[ "$NYC_KEEP_DAYS" -ge 2 ] ||
	die "CI_ARTIFACT_NYC_KEEP_DAYS is $NYC_KEEP_DAYS - below 2 days a re-run of e2e-and-coverage-report over a weekend would find no coverage data, and if-missing: ignore means it would PASS having reported none"

# AND THE SHORT WINDOW MAY NOT OUTLIVE THE LONG ONE, which would be a class
# swept later than the run containing it - not harmful, just a configuration
# that means something other than what whoever wrote it thought.
[ "$NYC_KEEP_DAYS" -le "$KEEP_DAYS" ] ||
	die "CI_ARTIFACT_NYC_KEEP_DAYS ($NYC_KEEP_DAYS) is longer than CI_ARTIFACT_KEEP_DAYS ($KEEP_DAYS) - the whole run is swept first, so the nyc window would never be reached"

# EVERYTHING UNDER THE STORE BELONGS TO THE SUBUID CONTAINER UID 1000 MAPS TO,
# so `core` cannot traverse or remove it from outside the namespace: a plain
# `find` reports a wall of "Permission denied" and a plain `rm` refuses. The
# same `podman unshare` form bin/github-runner.sh uses for the lane trees, and
# for the same reason - and the du that grades it must be unshared too, which is
# a lesson this repository paid for once already by reading 1,383 MB against
# 2,500 MB actual.
sweep_before=$(podman unshare du -sm "$SWEEP_ROOT" 2>/dev/null | cut -f1 || true)

# A RUN DIRECTORY IS AT DEPTH 4 - <owner>/<repo>/<run_id>/<run_attempt> - and
# that depth is asserted with -mindepth as well as -maxdepth, or a stale
# <owner>/ would be swept as though it were a run and take every attempt under
# it, including today's.
kept=0
while IFS= read -r d; do
	[ -n "$d" ] || continue
	kept=$((kept + 1))
done <<< "$(podman unshare find "$SWEEP_ROOT" -mindepth 4 -maxdepth 4 -type d 2>/dev/null || true)"

# ONE REMOVAL LOOP FOR BOTH PASSES, because two copies of `rm -rf` in a loop is
# two places for the prefix guard to be forgotten, and only one of them would be
# the one somebody reads. It reads paths on stdin and reports through a global
# rather than through stdout: `log` writes to stdout, so a function whose count
# the caller captured with $( ) would fold every warning line into the number.
# Called as `sweep_paths <<< "..."`, which runs it in the CURRENT shell, so the
# assignment survives.
sweep_n=0
sweep_paths() {
	local d
	sweep_n=0
	while IFS= read -r d; do
		[ -n "$d" ] || continue
		# RE-ASSERTED PER ENTRY and not only on SWEEP_ROOT, because this is the
		# line that runs rm -rf.
		case "$d" in
			"$SWEEP_ROOT"/*) ;;
			*) log "WARNING: skipping '$d', which is not under $SWEEP_ROOT"; continue ;;
		esac
		if [ "$DRY_RUN" = 1 ]; then
			log "would remove $d"
		else
			podman unshare rm -rf "$d" 2>/dev/null || log "WARNING: could not remove $d"
		fi
		sweep_n=$((sweep_n + 1))
	done
}

# A RUN DIRECTORY IS AT DEPTH 4 - <owner>/<repo>/<run_id>/<run_attempt> - and
# that depth is asserted with -mindepth as well as -maxdepth, or a stale
# <owner>/ would be swept as though it were a run and take every attempt under
# it, including today's.
#
# THE WHOLE-RUN PASS GOES FIRST, and the order is the only reason nyc_swept
# means anything: a run past KEEP_DAYS is necessarily past NYC_KEEP_DAYS too, so
# running the class pass first would count nyc directories it was about to
# delete wholesale anyway. This way nyc_swept counts only what was taken out of
# runs that are still INSIDE the long window, which is the number that says
# whether the split is doing any work.
sweep_paths <<< "$(podman unshare find "$SWEEP_ROOT" -mindepth 4 -maxdepth 4 -type d -mtime "+$KEEP_DAYS" 2>/dev/null || true)"
swept=$sweep_n

# AN ARTIFACT DIRECTORY IS AT DEPTH 5, one below the run, and is matched on its
# OWN name. -mindepth 5 -maxdepth 5 is what stops `-name '*-nyc'` ever matching
# a run_id or an owner that happens to be spelled that way.
sweep_paths <<< "$(podman unshare find "$SWEEP_ROOT" -mindepth 5 -maxdepth 5 -type d -name "$NYC_GLOB" -mtime "+$NYC_KEEP_DAYS" 2>/dev/null || true)"
nyc_swept=$sweep_n

# EMPTY DIRECTORIES ARE TIDIED TO DEPTH 4 NOW, NEVER THEIR PARENTS BEYOND DEPTH
# 1. `-depth` makes find process children first, so a run_attempt emptied by the
# nyc pass and the run_id that emptying leaves behind are both removed in the
# same pass. -empty means nothing with an artifact still in it is touched.
#
# DEPTH 4 IS THE NEW PART AND THE NYC PASS IS WHY: a run whose only stored
# artifact was nyc becomes an empty run_attempt, and an empty attempt tells a
# consumer nothing that a missing one does not.
#
# AND IT DOES NOT RACE A JOB THAT IS UPLOADING RIGHT NOW, which is the thing to
# check before believing that - CI here runs at all hours and 254 jobs in a day.
# upskald's scripts/local_artifacts.py store() calls dest.mkdir(parents=True) on
# the FULL <run_id>/<attempt>/<name> path in one call and then copies, so an
# attempt directory never exists empty except one this script just emptied.
if [ "$DRY_RUN" = 0 ]; then
	podman unshare find "$SWEEP_ROOT" -mindepth 2 -maxdepth 4 -type d -empty -depth -delete 2>/dev/null || true
fi

sweep_after=$(podman unshare du -sm "$SWEEP_ROOT" 2>/dev/null | cut -f1 || true)
state_bytes=$(podman unshare du -sb "$ARTIFACTS/state" 2>/dev/null | cut -f1 || true)

log "swept $swept run(s) older than ${KEEP_DAYS}d and $nyc_swept nyc artifact(s) older than ${NYC_KEEP_DAYS}d, of $kept run(s), ${sweep_before:-?}MB -> ${sweep_after:-?}MB, state/ ${state_bytes:-?} bytes"

# THE MARKER IS WRITTEN ONLY ON A REAL RUN. A --dry-run that stamped it would
# make ci.artifact_store report a sweep that removed nothing as a sweep that
# happened.
if [ "$DRY_RUN" = 0 ]; then
	mkdir -p "$(dirname "$MARKER")" 2>/dev/null || true
	{
		printf 'swept_at=%s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)"
		printf 'keep_days=%s\n' "$KEEP_DAYS"
		printf 'nyc_keep_days=%s\n' "$NYC_KEEP_DAYS"
		printf 'runs_swept=%s\n' "$swept"
		printf 'nyc_swept=%s\n' "$nyc_swept"
		printf 'runs_total=%s\n' "$kept"
		printf 'runs_mb=%s\n' "${sweep_after:-}"
		printf 'state_bytes=%s\n' "${state_bytes:-}"
	} > "$MARKER"
fi
