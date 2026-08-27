#!/usr/bin/env bash
# ==============================================================================
# Back up the server's config/ into a restic repository
# ------------------------------------------------------------------------------
# RUNS ON THE WORKSTATION and pulls, rather than running on the server and
# pushing. The server needs no credentials for the backup destination and no
# route to it, so compromising the server does not get you the backups.
#
# config/ is the only part of this system that is not reproducible from git.
# /mnt/media is 7.3TB of re-downloadable media on a disk with no redundancy and
# is deliberately not backed up; config/ holds the things that cannot be
# recreated - Pocket ID's passkey records, Caddy's certificates and ACME
# account, the *arr databases, Jellyfin's users and watch state, qBittorrent's
# torrent state.
#
# SINCE 2026-08-14 THIS IS NO LONGER THE PRIMARY BACKUP. bin/backup-server.sh
# runs on the server nightly and covers both the local and the off-site copy,
# because a backup that only runs when someone is at home is not a schedule. This
# script is the THIRD copy: a different machine, a different repository, a
# different password, which is what survives the server being compromised
# outright. Run it when you are home; nothing depends on it being frequent.
#
# THREE THINGS THIS DOES THAT A PLAIN rsync DOES NOT, each of which otherwise
# produces a backup that looks complete and is not:
#
#   1. Caddy's certificates are asserted present, not assumed. Under Docker its
#      /data was root-owned inside the container and rsync skipped it with a
#      permission error easy to miss in the noise; rootless Podman maps container
#      root to the service user, so it copies normally now. The count is still
#      checked every run, because it is 192KB containing every TLS private key
#      and the ACME account key - without it a restore silently re-issues
#      certificates, or hits Let's Encrypt rate limits and does not.
#
#   2. Live SQLite databases are snapshotted through SQLite's backup API rather
#      than copied. See bin/snapshot-databases.sh.
#
#   3. -wal and -shm files are excluded. They belong to the file copy, not to
#      the consistent snapshot that overwrites it, and restoring a stale -wal
#      next to a newer .db is worse than having neither.
#
#   4. Lock files are excluded, for the same reason and with a nastier symptom.
#      This backup is taken with the stack RUNNING, so it captures live locks.
#      qBittorrent's Qt lockfile records the pid, the hostname and a machine id;
#      restored onto a machine where the hostname does not match, Qt cannot tell
#      whether the owning process is alive and conservatively assumes the lock is
#      held. qBittorrent then exits one second after starting, logging only
#      "termination initiated" - no error, no warning, nothing naming the lock.
#      It cost an hour after the migration.
#
# Usage:  bin/backup-config.sh [--dry-run]
# ==============================================================================

set -euo pipefail

export PATH="$HOME/.local/bin:$PATH"

# home.local, not home: `home` resolves to the WAN address and hairpins back
# through the router, which is both slower for a 5GB mirror and a dependency
# this script does not need. The LAN route is direct.
REMOTE="${HOME_SERVER_HOST:-home.local}"
REMOTE_CONFIG="/var/home-server/config"
REPO="${RESTIC_REPOSITORY:-$HOME/backups/home-server}"
PWFILE="${RESTIC_PASSWORD_FILE:-$HOME/.config/restic/home-server.pw}"
STAGING="${HOME_SERVER_STAGING:-$HOME/.cache/home-server/staging}"
DRY=""
[ "${1:-}" = "--dry-run" ] && DRY="--dry-run"

command -v restic >/dev/null || { echo "backup: restic not on PATH" >&2; exit 1; }
[ -f "$PWFILE" ]            || { echo "backup: no repository password at $PWFILE" >&2; exit 1; }
export RESTIC_REPOSITORY="$REPO" RESTIC_PASSWORD_FILE="$PWFILE"

# ------------------------------------------------------------------------------
# 1. Mirror the readable tree
# ------------------------------------------------------------------------------
# Excludes are only for things that are regenerated on their own. Anything
# merely LARGE is kept: Tdarr's DB2 is 3.8GB, but "regenerable" there means
# rescanning a 7.3TB library, and restic deduplicates it across snapshots.
#
# /prometheus/ is excluded and re-added in step 3b - see the long note in
# bin/backup-server.sh. It matters more here: this script runs under `set -e`
# with no handler on the rsync at all, so rsync's exit 24 when Prometheus
# deletes a WAL segment mid-transfer would kill the run outright. The `protect`
# filter stops --delete-excluded removing last night's staged copy.
#
# /windmill-db/ is the same trap and is excluded for the same reason - Postgres
# checkpoints delete WAL segments exactly as Prometheus compactions do. THE TWO
# EXCLUSION LISTS HAVE TO STAY IDENTICAL: bin/verify-restore.sh asserts against
# both repositories, so a pattern added to one and not the other makes the
# off-site copy differ from the local one in a way only a restore would show.
mkdir -p "$STAGING/config"
echo "==> mirroring $REMOTE:$REMOTE_CONFIG"
rsync -a --delete --delete-excluded --info=stats1 \
  --exclude='*-wal' --exclude='*-shm' --exclude='*-journal' \
  --exclude='*.log' --exclude='*.log.[0-9]*' --exclude='*.txt.[0-9]*' \
  --exclude='jellyfin/cache/' --exclude='jellyfin/log/' --exclude='jellyfin/transcodes/' \
  --exclude='tdarr/logs/' --exclude='tdarr/server/Tdarr/Backups/' \
  --exclude='*/logs/' \
  --exclude='lockfile' --exclude='*.lock' --exclude='*.pid' \
  --filter='protect /prometheus/' --exclude='/prometheus/' \
  --filter='protect /windmill-db/' --exclude='/windmill-db/' \
  "$REMOTE:$REMOTE_CONFIG/" "$STAGING/config/"
# caddy/ used to be excluded here and re-extracted with `docker exec caddy tar`,
# because under Docker its subdirectories were root-owned and unreadable to this
# user - rsync exited 23 on every run. Rootless Podman maps container root to the
# service user, so /data is now plainly owned by `core` and rsync just copies it.
# The special case is gone; the assertion below is not.

# ------------------------------------------------------------------------------
# 2. Verify Caddy's state came through
# ------------------------------------------------------------------------------
# This is the one part of config/ that cannot be regenerated without hitting
# Let's Encrypt rate limits, and the one most likely to be silently skipped by a
# permission change. Count it every run rather than assume the rsync covered it.
certs=$(find "$STAGING/config/caddy" -name '*.crt' | wc -l)
keys=$(find "$STAGING/config/caddy" -name '*.key' | wc -l)
echo "    $certs certificates, $keys private keys"
# A backup missing these restores into a server that cannot serve TLS. Fail
# loudly rather than record a snapshot that looks fine.
if [ "$certs" -eq 0 ] || [ "$keys" -eq 0 ]; then
	echo "backup: no Caddy certificates captured" >&2
	exit 1
fi

# ------------------------------------------------------------------------------
# 3. Consistent database snapshots, laid over the file copy
# ------------------------------------------------------------------------------
echo "==> snapshotting live databases"
ssh "$REMOTE" 'bash -s' < "$(dirname "${BASH_SOURCE[0]}")/snapshot-databases.sh"
rsync -a "$REMOTE:.cache/home-server/db-snapshot/" "$STAGING/config/"

# ------------------------------------------------------------------------------
# 3b. A consistent copy of the metrics store
# ------------------------------------------------------------------------------
# The same hardlink snapshot bin/backup-server.sh takes, driven over ssh. Both
# repositories have to agree about what a good snapshot contains, because
# bin/verify-restore.sh asserts against both - so this is not optional polish.
#
# Non-fatal despite `set -e` on this script: losing metrics history is not
# losing config/, and this copy is the one taken when someone is home rather
# than the one that runs every night.
echo "==> snapshotting the metrics store"
tsdb_name=$(ssh "$REMOTE" 'podman exec prometheus wget -q -O - --post-data="" \
	http://127.0.0.1:9090/api/v1/admin/tsdb/snapshot 2>/dev/null \
	| jq -r ".data.name // empty" 2>/dev/null' || true)
if [ -z "$tsdb_name" ]; then
	echo "    could not snapshot - the metrics store is absent from this backup"
else
	rsync -a --delete \
		"$REMOTE:$REMOTE_CONFIG/prometheus/snapshots/$tsdb_name/" \
		"$STAGING/config/prometheus/" || true
	# shellcheck disable=SC2029  # expanding locally is the point: the snapshot
	# name came back from the API call above and the remote must be told which
	# one to remove. Single-quoted on the remote side so a name with a space
	# cannot split into two arguments.
	ssh "$REMOTE" "rm -rf '$REMOTE_CONFIG/prometheus/snapshots/$tsdb_name'" || true
	echo "    $(find "$STAGING/config/prometheus" -name meta.json 2>/dev/null | wc -l) blocks staged"
fi

# ------------------------------------------------------------------------------
# 3c. The CI coverage baseline
# ------------------------------------------------------------------------------
# The twin of step 3c in bin/backup-server.sh, driven over ssh. Both
# repositories have to agree about what a good snapshot contains, for the reason
# stated one step up: bin/verify-restore.sh asserts against both.
#
# WHAT IT IS: a few hundred bytes under cache/github-runner/artifacts/state/,
# holding the percentage each of upskald's surfaces may not regress below. It
# moved off an orphan git branch on GitHub onto this disk on 2026-08-27, and
# nothing under cache/ is backed up by anything else.
#
# FATAL HERE, UNLIKE THE METRICS STORE ABOVE, and the asymmetry is the point.
# Losing metrics history costs history. Losing this costs a gate: upskald's
# scripts/check_coverage.py reads a missing baseline as "absent" and PASSES with
# a warning, on every surface at once - so the loss is invisible from both sides
# and the thing it was protecting is gone until somebody notices a coverage
# number that only ever goes down.
#
# `podman unshare` on the REMOTE side, because the store belongs to the subuid
# container uid 1000 maps to and `core` cannot traverse it - so a plain rsync of
# that path succeeds having copied nothing. tar over the pipe rather than rsync
# for the same reason: rsync would need the unshare on both ends of a protocol
# that has only one.
#
# THE PATH IS RESOLVED ON THE REMOTE AND SENT BACK, rather than assembled here
# with escaped ${...} that survives one round of expansion. The defaults belong
# to the server's environment - GITHUB_RUNNER_ARTIFACTS and DOCKER_VOLUME_CACHE
# are read from its .env by bin/github-runner.sh - and a literal built locally
# to be expanded remotely is a thing that has to be re-read every time anybody
# touches the quoting.
echo "==> staging the CI coverage baseline"
ci_state=$(ssh "$REMOTE" 'set -a; . /var/home-server/.env 2>/dev/null; set +a
	printf "%s" "${GITHUB_RUNNER_ARTIFACTS:-${DOCKER_VOLUME_CACHE:-/var/home-server/cache}/github-runner/artifacts}/state"' || true)
if [ -z "$ci_state" ]; then
	echo "could not resolve the CI artifact store path on $REMOTE" >&2
	exit 1
fi
mkdir -p "$STAGING/config/ci-artifact-state"
# shellcheck disable=SC2029  # $ci_state is expanded locally on purpose: it came
# back from the remote in the call above and names a path on that same host.
if ! ssh "$REMOTE" "podman unshare test -d '$ci_state'" 2>/dev/null; then
	echo "    no CI artifact store on $REMOTE yet - the lanes have not created one"
	rmdir "$STAGING/config/ci-artifact-state" 2>/dev/null || true
else
	# shellcheck disable=SC2029
	ssh "$REMOTE" "podman unshare tar -C '$ci_state' -cf - ." |
		tar -C "$STAGING/config/ci-artifact-state" -xf - ||
		{ echo "could not stage the CI coverage baseline from $REMOTE - a lost baseline makes upskald's gate PASS rather than fail" >&2; exit 1; }
	ci_files=$(find "$STAGING/config/ci-artifact-state" -type f 2>/dev/null | wc -l)
	if [ "$ci_files" -eq 0 ]; then
		echo "the CI artifact store exists on $REMOTE but staged 0 files - a silently empty capture looks exactly like a working one" >&2
		exit 1
	fi
	echo "    $ci_files file(s) staged"
fi

# ------------------------------------------------------------------------------
# 4. Into restic
# ------------------------------------------------------------------------------
restic snapshots >/dev/null 2>&1 || { echo "==> initialising repository at $REPO"; restic init; }

echo "==> backing up"
# A FIXED host tag, not $REMOTE. `restic forget` groups by host, so tagging
# snapshots with whichever ssh alias was used splits one machine's history into
# separate retention groups - each pruned independently, and neither holding the
# full chain. The alias is a route; this is an identity.
restic backup $DRY --tag home-server --tag config \
  --host home-server "$STAGING/config"

if [ -z "$DRY" ]; then
  # Keeps a year of history for a few GB. The daily tier matters most: the
  # damage this protects against is usually noticed within a week.
  echo "==> pruning old snapshots"
  restic forget --tag home-server --prune \
    --keep-daily 7 --keep-weekly 4 --keep-monthly 12
fi

echo
restic snapshots --compact | tail -5
