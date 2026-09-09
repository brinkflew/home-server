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
# THIRTEEN DAYS, AND IT IS THE BUDGET THAT PICKED THE NUMBER RATHER THAN A
# PREFERENCE. One of their consumers runs when a pull request merges and reads
# the artifacts of that pull request's LAST CI run, which may be weeks old if
# the branch sat - so a short sweep breaks exactly the slow-moving pull requests
# and nothing else, which is the worst possible distribution of a failure.
# Thirty is what they asked for, and thirty does not fit on this filesystem:
#
#   40960 MB budget / 506 MB per run = 80.9 runs
#   80.9 runs / 6.07 runs per day    = 13.3 days
#
# Measured 2026-09-09 over the 85 runs in the store, spanning 2026-08-27 to that
# morning. ci.artifact_store's own comment in bin/verify-host.sh derives the
# 40960 from what /var can afford and ends by naming this window as the number
# that has to move; this is that sentence carried out.
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
# NINETY-NINE PER CENT OF A RUN IS ONE ARTIFACT CLASS, and this is the deeper
# lever, deliberately NOT pulled here. Of a 536 MB run measured that day, 325 MB
# and 212 MB were the two e2e-shard-N-nyc directories - raw per-context
# Playwright coverage JSON, about 130 files of 4 MB - while -blob and -apicov
# were 1 MB each. Keeping nyc for a week and the rest for thirty would put the
# store near 11 GB. It is not done because it would break the whole-run
# granularity the next paragraph argues for, on an unverified assumption about
# what in upskald reads raw nyc output. Answer that question first.
#
# THE GRANULARITY IS A WHOLE RUN. A run's artifacts are written by several jobs
# at several times, so sweeping individual files would leave a run half-present -
# which reads to a consumer as "this artifact was never uploaded" rather than
# "this run has expired". The mtime that decides is the run directory's own.
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
KEEP_DAYS="${CI_ARTIFACT_KEEP_DAYS:-13}"
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
swept=0
kept=0
while IFS= read -r d; do
	[ -n "$d" ] || continue
	kept=$((kept + 1))
done <<< "$(podman unshare find "$SWEEP_ROOT" -mindepth 4 -maxdepth 4 -type d 2>/dev/null || true)"

while IFS= read -r d; do
	[ -n "$d" ] || continue
	case "$d" in
		"$SWEEP_ROOT"/*) ;;
		*) log "WARNING: skipping '$d', which is not under $SWEEP_ROOT"; continue ;;
	esac
	if [ "$DRY_RUN" = 1 ]; then
		log "would remove $d"
	else
		podman unshare rm -rf "$d" 2>/dev/null || log "WARNING: could not remove $d"
	fi
	swept=$((swept + 1))
done <<< "$(podman unshare find "$SWEEP_ROOT" -mindepth 4 -maxdepth 4 -type d -mtime "+$KEEP_DAYS" 2>/dev/null || true)"

# EMPTY <owner>/<repo>/<run_id> DIRECTORIES ARE TIDIED, NEVER THEIR PARENTS
# BEYOND DEPTH 1. `-depth` makes find process children first, so a run_id
# emptied by the loop above is removed in the same pass. -empty means nothing
# with an attempt still in it is touched.
if [ "$DRY_RUN" = 0 ]; then
	podman unshare find "$SWEEP_ROOT" -mindepth 2 -maxdepth 3 -type d -empty -depth -delete 2>/dev/null || true
fi

sweep_after=$(podman unshare du -sm "$SWEEP_ROOT" 2>/dev/null | cut -f1 || true)
state_bytes=$(podman unshare du -sb "$ARTIFACTS/state" 2>/dev/null | cut -f1 || true)

log "swept $swept run(s) older than ${KEEP_DAYS}d of $kept, ${sweep_before:-?}MB -> ${sweep_after:-?}MB, state/ ${state_bytes:-?} bytes"

# THE MARKER IS WRITTEN ONLY ON A REAL RUN. A --dry-run that stamped it would
# make ci.artifact_store report a sweep that removed nothing as a sweep that
# happened.
if [ "$DRY_RUN" = 0 ]; then
	mkdir -p "$(dirname "$MARKER")" 2>/dev/null || true
	{
		printf 'swept_at=%s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)"
		printf 'keep_days=%s\n' "$KEEP_DAYS"
		printf 'runs_swept=%s\n' "$swept"
		printf 'runs_total=%s\n' "$kept"
		printf 'runs_mb=%s\n' "${sweep_after:-}"
		printf 'state_bytes=%s\n' "${state_bytes:-}"
	} > "$MARKER"
fi
