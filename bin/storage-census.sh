#!/usr/bin/env bash
# ==============================================================================
# Break /var down by consumer, once an hour, into a marker three readers share
# ------------------------------------------------------------------------------
# /var is one 233 GB partition carrying the OS, this checkout, config/,
# /var/backups, the podman graph root and the CI and agent-fleet caches. Until
# this file existed, the only thing measuring it was node_filesystem_avail_bytes
# - a single number that says /var went from 47.4 GiB used on 2026-08-15 to
# 146.4 GiB on 2026-09-09 and CANNOT SAY WHY. Answering "why" took an ssh
# session and six du's, which is the gap this closes.
#
# WHAT IT IS FOR IS NOT "X IS BIG". Every consumer here was individually sized
# against the free space on the day it was written, and no two of them were ever
# added together: the artifact store's 30-day window, three CI lanes at 20 GB
# each, the TSDB's 16 GB and the journal's 16 GB commit more than the 86 GiB
# that is left. That sum is the finding, and it needs a per-consumer series
# before it can be computed at all.
#
# ONE TRAVERSAL PER ROOT, AND THE PARTS COME FROM `-d` RATHER THAN A SECOND du.
# The walk happens anyway; depth only changes what is printed. So conduct's
# three caches cost nothing on top of the cache root, and every intermediate
# consumer here is derived by SUBTRACTION from an output already in hand. Total
# cost measured on the host: 7.0 s warm, which is why this is an hourly timer
# and not a source in bin/collect-metrics.py, whose whole run is budgeted at 25s
# against a 30-second tick.
#
# `podman unshare du -x`, AND THE `-x` IS NOT TIDINESS.
#
#   THE LESSON THIS REPOSITORY ALREADY RECORDS IS HALF THE LESSON.
#   bin/github-runner.sh records that a plain `du` UNDER-reads a subuid-owned
#   tree without erroring - `core` cannot traverse most of it, so du skips what
#   it cannot read and reports the remainder silently. True, and measured again
#   on 2026-09-09: the lane tree reads 19,539 MB plain against 32,846 unshared.
#
#   APPLIED TO THE PODMAN GRAPH ROOT THE SAME REFLEX IS A 78% OVER-READ. Inside
#   the namespace `du` descends into every running container's
#   overlay/<id>/merged - a mounted overlay presenting that container's whole
#   root filesystem - and counts it ON TOP OF the layers it is composed from.
#   Measured the same day, same tree, three ways, MB:
#
#       cache/github-runner/lanes          19,539 plain  32,846 unshare  32,846 sudo
#       cache/github-runner/artifacts      38,142 plain  38,142 unshare  38,142 sudo
#       ~/.local/share/containers/storage  31,921 plain  74,166 unshare  41,610 sudo
#
#   `-x` stops at a filesystem boundary and `merged` is a different filesystem.
#   61 overlay mounts were visible inside the namespace against 1 outside.
#   Measured to agree with sudo to within 2 MB, as does --exclude=merged; `-x`
#   is preferred because it needs no name and so cannot drift.
#
# IT SUMS TO `df` BY CONSTRUCTION, WHICH IS WHAT MAKES IT SELF-PROVING. The
# unaccounted remainder is published as its own key rather than dropped, so a
# consumer nobody added shows up as `other_unaccounted_mb` growing instead of
# silently making every share wrong. Measured today: 2,172 MB of 150,595, 1.4%.
# A census that cannot be contradicted by its own filesystem is decoration.
#
# AND IT WRITES ITS OWN TIMESTAMP, which is the rule CLAUDE.md states in general
# terms: an automated job needs a durable record of its last success, not just a
# unit that exits 0. ExecMainExitTimestamp is runtime state a reboot wipes.
#
# See: bin/verify-host.sh (capacity.*), bin/collect-metrics.py (source_storage),
#      host/systemd/home-server-storage-census.service, docs/observability.md
# ==============================================================================
set -euo pipefail

CACHE_ROOT="${DOCKER_VOLUME_CACHE:-/var/home-server/cache}"
CONFIG_ROOT="${DOCKER_VOLUME_CONFIG:-/var/home-server/config}"
REPO_ROOT="${HOME_SERVER_REPO:-/var/home-server}"
BACKUP_ROOT="${HOME_SERVER_BACKUP_ROOT:-/var/backups}"
LOG_ROOT="${HOME_SERVER_LOG_ROOT:-/var/log}"
GRAPH_ROOT="${HOME_SERVER_GRAPH_ROOT:-${HOME:-/var/home/core}/.local/share/containers/storage}"
MARKER="${HOME_SERVER_STORAGE_STATE:-${HOME:-/var/home/core}/.cache/home-server/storage-census}"

DRY_RUN=0
[ "${1:-}" = --dry-run ] && DRY_RUN=1

log() { printf 'storage-census: %s\n' "$*"; }
die() { printf 'storage-census: %s\n' "$*" >&2; exit 1; }

# THE FILESYSTEM IS THE ONE THING THIS CANNOT DERIVE, so its absence is fatal
# rather than a zero. Everything else degrades to an empty value, which reaches
# status.json as null and the collector drops rather than publishing as 0 -
# absence read as health is a defect this repository has recorded four times.
# NOT `-P` HERE. --output and --portability are mutually exclusive in GNU df,
# and the refusal goes to stderr - so with the 2>/dev/null below, the whole
# census died in 7 ms with no output at all the first time this was run.
df_line=$(df -BM --output=size,used /var 2>/dev/null | awk 'NR==2 {print $1" "$2}' | tr -d M)
[ -n "$df_line" ] || die "df could not read /var - nothing here is meaningful without it"
df_total_mb=${df_line% *}
df_used_mb=${df_line#* }

# ------------------------------------------------------------------------------
# The traversals. Four, and every part below comes out of one of them.
# ------------------------------------------------------------------------------
# A tree that cannot be read is EMPTY here, never 0: `sum_of` returns "" and
# every consumer derived from it inherits that. The unaccounted remainder is
# what then grows, which is the honest reading - "this much of /var is in
# something this census did not measure" - rather than a share that silently
# understates.
declare -A T=()

walk() {
	# walk <root> <depth>; fills T[path]=mb for every line the walk prints.
	local root=$1 depth=$2 line size path
	[ -d "$root" ] || return 0
	while read -r line; do
		size=${line%%[[:space:]]*}
		path=${line#*[[:space:]]}
		case "$size" in ''|*[!0-9]*) continue ;; esac
		T["$path"]=$size
	done <<-EOF
		$(podman unshare du -xm -d"$depth" "$root" 2>/dev/null || true)
	EOF
}

walk "$CACHE_ROOT" 2
walk "$GRAPH_ROOT" 1
walk "$CONFIG_ROOT" 0
walk "$BACKUP_ROOT" 1
walk "$LOG_ROOT" 1
walk "$REPO_ROOT" 0

get() { printf '%s' "${T[$1]:-}"; }

# sub <total-key> <part-key>...  -> total minus every part, or "" if total absent
sub() {
	local total rest=0 k v
	total=$(get "$1"); shift
	[ -n "$total" ] || { printf ''; return 0; }
	for k in "$@"; do
		v=$(get "$k")
		[ -n "$v" ] && rest=$(( rest + v ))
	done
	# A negative remainder means a part was counted that is not under the total.
	# Report 0 rather than a negative: the census's own check grades the
	# unaccounted total, and a negative here would net it back out and hide it.
	if [ "$total" -lt "$rest" ]; then printf '0'; else printf '%s' $(( total - rest )); fi
}

ci_root="$CACHE_ROOT/github-runner"
cd_root="$CACHE_ROOT/conduct"

ci_artifacts=$(get "$ci_root/artifacts")
ci_lanes=$(get "$ci_root/lanes")
ci_other=$(sub "$ci_root" "$ci_root/artifacts" "$ci_root/lanes")
conduct_uv=$(get "$cd_root/uv-cache")
conduct_bun=$(get "$cd_root/bun-cache")
conduct_logs=$(get "$cd_root/logs")
conduct_other=$(sub "$cd_root" "$cd_root/uv-cache" "$cd_root/bun-cache" "$cd_root/logs")
cache_other=$(sub "$CACHE_ROOT" "$ci_root" "$cd_root")
podman_overlay=$(get "$GRAPH_ROOT/overlay")
podman_volumes=$(get "$GRAPH_ROOT/volumes")
podman_other=$(sub "$GRAPH_ROOT" "$GRAPH_ROOT/overlay" "$GRAPH_ROOT/volumes")
config_mb=$(get "$CONFIG_ROOT")
backups_repo=$(get "$BACKUP_ROOT/home-server")
backups_staging=$(get "$BACKUP_ROOT/staging")
backups_other=$(sub "$BACKUP_ROOT" "$BACKUP_ROOT/home-server" "$BACKUP_ROOT/staging")
log_journal=$(get "$LOG_ROOT/journal")
log_other=$(sub "$LOG_ROOT" "$LOG_ROOT/journal")
# The checkout itself, with the two big trees that merely live under it removed.
checkout_mb=$(sub "$REPO_ROOT" "$CACHE_ROOT" "$CONFIG_ROOT")

CONSUMERS=(
	ci_artifacts ci_lanes ci_other
	conduct_uv conduct_bun conduct_logs conduct_other
	cache_other
	podman_overlay podman_volumes podman_other
	config checkout
	backups_repo backups_staging backups_other
	log_journal log_other
)

declare -A V=(
	[ci_artifacts]="$ci_artifacts" [ci_lanes]="$ci_lanes" [ci_other]="$ci_other"
	[conduct_uv]="$conduct_uv" [conduct_bun]="$conduct_bun"
	[conduct_logs]="$conduct_logs" [conduct_other]="$conduct_other"
	[cache_other]="$cache_other"
	[podman_overlay]="$podman_overlay" [podman_volumes]="$podman_volumes"
	[podman_other]="$podman_other"
	[config]="$config_mb" [checkout]="$checkout_mb"
	[backups_repo]="$backups_repo" [backups_staging]="$backups_staging"
	[backups_other]="$backups_other"
	[log_journal]="$log_journal" [log_other]="$log_other"
)

named=0
unmeasured=""
for c in "${CONSUMERS[@]}"; do
	if [ -n "${V[$c]}" ]; then
		named=$(( named + ${V[$c]} ))
	else
		unmeasured="$unmeasured $c"
	fi
done
unaccounted=$(( df_used_mb - named ))
[ "$unaccounted" -lt 0 ] && unaccounted=0

# ------------------------------------------------------------------------------
# Podman's own accounting, which no du can supply
# ------------------------------------------------------------------------------
# ORPHANED VOLUMES ARE A SEPARATE QUESTION FROM "how big is volumes/", and only
# podman can answer it: an anonymous volume no container references is
# reclaimable, one that is referenced is live data, and they sit side by side in
# the same directory. Measured 2026-09-09: 332 of 340 orphaned, 9,350 MB.
#
# THE IMAGE "RECLAIMABLE" FIGURE IS DELIBERATELY NOT READ. `podman system df`
# reports 18.67 GB of images as reclaimable and that is NOT free space: it is
# largely the previous image of each service, which is exactly what
# podman-auto-update's rollback restores. The standing rule in CLAUDE.md is
# never to run `prune -a`, and a number published under the word "reclaimable"
# is an invitation to. Nothing here reads that column.
# The orphaned BYTES come from `podman system df`'s Local Volumes row and not
# from a du: 332 separate tree walks for a number podman already holds exactly.
# RawReclaimable is read rather than Reclaimable because the latter is a human
# string ("9.676GB (100%)"). ONLY the Local Volumes row is read - see above for
# why the Images row's reclaimable figure must never leave this file.
volumes_orphaned_mb=$(podman system df --format json 2>/dev/null | python3 -c '
import json, sys
try:
    doc = json.load(sys.stdin)
except Exception:
    sys.exit(0)
for row in (doc if isinstance(doc, list) else [doc]):
    if row.get("Type") == "Local Volumes":
        raw = row.get("RawReclaimable")
        if isinstance(raw, (int, float)):
            print(int(raw) // (1 << 20))
' 2>/dev/null || true)
case "$volumes_orphaned_mb" in ''|*[!0-9]*) volumes_orphaned_mb="" ;; esac

volumes_total=$(podman volume ls -q 2>/dev/null | grep -c . || true)
volumes_orphaned=$(podman volume ls -q -f dangling=true 2>/dev/null | grep -c . || true)
volume_oldest=$(podman volume ls -f dangling=true --format '{{.CreatedAt}}' 2>/dev/null |
	sort | head -1 | awk '{print $1"T"$2"Z"}' || true)
case "$volumes_total" in ''|*[!0-9]*) volumes_total="" ;; esac
case "$volumes_orphaned" in ''|*[!0-9]*) volumes_orphaned="" ;; esac
[ "${volume_oldest:-}" = "TZ" ] && volume_oldest=""

log "$(printf '%s used of %s MB, %s consumers named, %s MB unaccounted (%s%%)' \
	"$df_used_mb" "$df_total_mb" "${#CONSUMERS[@]}" "$unaccounted" \
	"$(( unaccounted * 100 / (df_used_mb > 0 ? df_used_mb : 1) ))")"
[ -n "$unmeasured" ] && log "not measured:$unmeasured"
[ -n "$volumes_orphaned" ] &&
	log "$volumes_orphaned of ${volumes_total:-?} podman volume(s) orphaned, ${volumes_orphaned_mb:-?}MB"

if [ "$DRY_RUN" = 1 ]; then
	for c in "${CONSUMERS[@]}"; do
		printf '  %-18s %s\n' "$c" "${V[$c]:-(not measured)}"
	done
	printf '  %-18s %s\n' other_unaccounted "$unaccounted"
	log "dry run - nothing written"
	exit 0
fi

mkdir -p "$(dirname "$MARKER")" 2>/dev/null || true
{
	printf 'census_at=%s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)"
	printf 'df_total_mb=%s\n' "$df_total_mb"
	printf 'df_used_mb=%s\n' "$df_used_mb"
	for c in "${CONSUMERS[@]}"; do
		printf '%s_mb=%s\n' "$c" "${V[$c]}"
	done
	printf 'other_unaccounted_mb=%s\n' "$unaccounted"
	printf 'volumes_total=%s\n' "${volumes_total:-}"
	printf 'volumes_orphaned=%s\n' "${volumes_orphaned:-}"
	printf 'volumes_orphaned_mb=%s\n' "${volumes_orphaned_mb:-}"
	printf 'volume_orphan_oldest_at=%s\n' "${volume_oldest:-}"
} > "$MARKER"
