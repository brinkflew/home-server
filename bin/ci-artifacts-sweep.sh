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
# THIRTY DAYS, AND THE NUMBER IS NOT ARBITRARY. One of their consumers runs when
# a pull request merges and reads the artifacts of that pull request's LAST CI
# run, which may be weeks old if the branch sat - so a 7-day sweep would break
# exactly the slow-moving pull requests and nothing else, which is the worst
# possible distribution of a failure. Thirty is what they asked for. Sizing at
# the time of writing: about 2.5 MB per run, against 153 GB free on /var.
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
KEEP_DAYS="${CI_ARTIFACT_KEEP_DAYS:-30}"
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
