#!/usr/bin/env bash
# ==============================================================================
# Put drifting library files back through Tdarr, without ever moving one
# ------------------------------------------------------------------------------
# RUNS ON THE SERVER, as core, from /var/home-server. It reads the list
# bin/verify-media.sh --bad-list writes and copies files into the rework siding,
# where a Tdarr library picks them up. It is the person-shaped half of
# media.keyframe_drift, the way bin/clear-stalled.py is of a stalled download:
# the check names the backlog and is deliberately unalerted, and nothing was able
# to act on it at all.
#
# WHAT THE BACKLOG IS. 690 of 725 files on the first sweep the timer ever ran.
# Every one was produced by this stack's own Tdarr flow BEFORE `-no-scenecut 1`
# reached it, so their keyframes sit anywhere from 0.2s to 10.4s apart and
# Jellyfin's HLS stream-copy path cannot segment them consistently. A native
# client direct-plays and is unaffected; a browser drifts, accumulating, and the
# subtitles detach. docs/media-pipeline.md has the mechanism.
#
# ------------------------------------------------------------------------------
# IT COPIES. IT NEVER MOVES. THAT IS THE WHOLE DESIGN.
# ------------------------------------------------------------------------------
# The obvious implementation moves the file into the siding and lets Tdarr put
# the output back. Do not do that. Radarr and Sonarr hold a record pointing at
# the path in transcoded/, and between the move and the output landing - tens of
# minutes of NVENC - any rescan sees the file MISSING. That marks the episode
# missing, which is an invitation to re-download it. docs/media-pipeline.md:62
# states the rule this respects rather than works around: "Do not add a step that
# moves media directly."
#
# So transcoded/ keeps the old, drifting, perfectly playable file for the entire
# transcode. Tdarr's own move node replaces it at the end, and its first method
# is fs.promises.rename() - verified by reading the plugin in the container - so
# the replacement is atomic within the one filesystem and the *arr apps never see
# the file absent even for an instant. No promote step, nothing to reconcile.
#
# THE COPY IS USUALLY FREE. --reflink=auto on XFS shares the extents, so a 4 GB
# film costs metadata rather than 4 GB, and Tdarr deleting the siding copy at the
# end just drops a reference. It falls back to a real copy where reflink is
# unavailable, which is why the free-space refusal below is sized on real copies.
#
# ------------------------------------------------------------------------------
# WHY A SIDING AND A SECOND LIBRARY, RATHER THAN queued/
# ------------------------------------------------------------------------------
# Dropping these files in queued/<type> would do nothing, twice over. The
# libraries that watch it run the ordinary policy, where skipIfHevcBelowBitrate
# is 8000000 - and the backlog is already HEVC at about 4.5 Mbps, so every file
# would be stream-copied and MOVED, arriving in transcoded/ with the identical
# broken grid and a green job. Then it would look fixed.
#
# library/rework/<type> is therefore its own siding, a sibling of queued/ and
# transcoded/ and outside every Jellyfin library path, exactly as review/ and
# .recycle already are. The plugin recognises it BY PATH - reworkPathMarker - and
# ignores the bitrate gate for anything under it. That is why there is no flow
# edit and no new library user variable: inputsDB lives in the flow, the flow
# lives in Tdarr's database and is edited in its UI, and checkout.tdarr_flows
# compares the two - so a variable would cost a UI edit plus a re-export and be
# wrong in git until both had happened.
#
# keepRelativePath IS WHAT MAKES THE ROUND TRIP LAND IN THE RIGHT PLACE. All
# three move nodes set it, so the path is kept relative to the library's own
# watch folder: rework/series/Show/Season 01/ep.mkv has relative path
# Show/Season 01/ep.mkv, and output_dir_done of /media/library/transcoded/series
# puts it back exactly where it came from. A flat destination would have
# collapsed every series into one directory.
#
# THE ONE-TIME TDARR SETUP IS NOT IN THIS SCRIPT and cannot be: a library is a
# row in Tdarr's own database, created in its UI. docs/media-pipeline.md carries
# the fields. This script refuses rather than guesses if the siding is absent.
#
# ------------------------------------------------------------------------------
# --limit IS NOT OPTIONAL, AND THE DEFAULT IS DELIBERATELY TINY
# ------------------------------------------------------------------------------
# Queueing 470 health checks once wedged this whole host while it still answered
# ICMP and completed TCP handshakes. Two NVENC sessions already pin the encoder
# block at 100%, so a bigger batch buys no throughput - it only makes the siding
# a place work piles up, and a sustained encoder load is a veto in
# bin/reboot-when-staged.sh and defers the nightly container update. Three is
# enough to prove the path; the backlog is a decision to be taken in daylight,
# deliberately, and not by a default.
#
# See: bin/verify-media.sh, docs/media-pipeline.md, docs/known-state.md
# ==============================================================================
set -uo pipefail

LIMIT=3
DRY_RUN=0
BAD_LIST="${HOME_SERVER_MEDIA_BAD_LIST:-${HOME:-/var/home/core}/.cache/home-server/media-bad-list}"
MEDIA_STATE="${HOME_SERVER_MEDIA_STATE:-${HOME:-/var/home/core}/.cache/home-server/media-state}"
MARKER="${HOME_SERVER_REWORK_STATE:-${HOME:-/var/home/core}/.cache/home-server/rework-state}"
# Seventeen, the same number media.verify_run grades staleness on, and for the
# same reason: the timer is weekly and the playback gate can defer it a week, so
# two missed sweeps is the first honestly abnormal age. A list older than that
# may name files that have since been replaced or upgraded.
MAX_LIST_AGE_D=17
# A real copy of the largest thing in this library, times the batch, plus Tdarr's
# own scratch. Only reached when reflink is unavailable; cheap insurance either
# way, against a volume that is the one thing here with no redundancy.
#
# OVERRIDABLE SO THE GATE STAYS REACHABLE, the way HOME_SERVER_ENCODER_PCT and
# HOME_SERVER_WATCHING make bin/reboot-when-staged.sh's gates reachable. A refusal
# that can only be exercised by filling a 7.3 TB volume is a refusal nobody has
# ever seen fire, and this repository has shipped more than one of those.
MIN_FREE_GB="${HOME_SERVER_REWORK_MIN_FREE_GB:-50}"

usage() { sed -n '2,/^# ===/p' "$0" | sed 's/^# \{0,1\}//'; exit "${1:-0}"; }

while [ $# -gt 0 ]; do
	case "${1:-}" in
		--limit)     LIMIT="${2:-}"; shift 2 ;;
		--limit=*)   LIMIT="${1#*=}"; shift ;;
		--list)      BAD_LIST="${2:-}"; shift 2 ;;
		--list=*)    BAD_LIST="${1#*=}"; shift ;;
		--dry-run)   DRY_RUN=1; shift ;;
		-h|--help)   usage 0 ;;
		*)           echo "requeue-drifting: unknown argument: $1" >&2; exit 2 ;;
	esac
done

say()  { printf '\n\033[1m==> %s\033[0m\n' "$*"; }
ok()   { printf '  \033[32mOK\033[0m    %s\n' "$*"; }
note() { printf '  \033[33mNOTE\033[0m  %s\n' "$*"; }
die()  { printf '\033[31mrequeue-drifting: %s\033[0m\n' "$*" >&2; exit 1; }

case "$LIMIT" in ''|*[!0-9]*) die "--limit takes a whole number, not '$LIMIT'" ;; esac
case "$MIN_FREE_GB" in ''|*[!0-9]*) die "HOME_SERVER_REWORK_MIN_FREE_GB is '$MIN_FREE_GB', which is not a number of GB" ;; esac
[ "$LIMIT" -gt 0 ] || die "--limit must be at least 1"

# ------------------------------------------------------------------------------
# The refusals, and they come first because everything after them writes
# ------------------------------------------------------------------------------
# A LIST THAT IS STALE, PARTIAL OR FROM A FAILED SWEEP IS WORSE THAN NONE,
# because this script copies files from it. verify-media.sh already refuses to
# publish a partial one - it writes the list only after a run that finished - so
# what is left to check here is whether the run that wrote it could MEASURE
# anything, and how long ago.
[ -s "$BAD_LIST" ] || die "no drifting-file list at $BAD_LIST.
  Write one:  ./bin/verify-media.sh --library --marker $MEDIA_STATE --bad-list $BAD_LIST"

media_err=$(sed -n 's/^media_error=//p' "$MEDIA_STATE" 2>/dev/null | tail -1)
[ -z "$media_err" ] ||
	die "the last library sweep could not run ($media_err), so $BAD_LIST says nothing about the library now - fix that first; media.verify_run carries it"

media_at=$(sed -n 's/^media_verified_at=//p' "$MEDIA_STATE" 2>/dev/null | tail -1)
[ -n "$media_at" ] || die "$MEDIA_STATE records no sweep, so the age of $BAD_LIST cannot be established"
media_e=$(date -d "$media_at" +%s 2>/dev/null) || media_e=""
[ -n "$media_e" ] || die "could not parse media_verified_at='$media_at'"
list_age_d=$(( ( $(date +%s) - media_e ) / 86400 ))
[ "$list_age_d" -le "$MAX_LIST_AGE_D" ] ||
	die "the list was written ${list_age_d}d ago (max ${MAX_LIST_AGE_D}) - re-sweep before acting on it, or it may name files that have since been replaced"

# The media root is derived, never hardcoded - the same translation
# bin/verify-media.sh does, and for the reason it gives: sibling scripts that
# hardcoded it had to be fixed once already.
MEDIA_ROOT="${DOCKER_VOLUME_MEDIA:-}"
if [ -z "$MEDIA_ROOT" ]; then
	REPO_DIR=$(cd -- "$(dirname -- "$0")/.." && pwd)
	[ -r "$REPO_DIR/.env" ] || die "no .env at $REPO_DIR - run ./bin/render-env.sh first"
	MEDIA_ROOT=$(sed -n 's/^DOCKER_VOLUME_MEDIA=//p' "$REPO_DIR/.env" | tail -1)
	MEDIA_ROOT="${MEDIA_ROOT%\"}"; MEDIA_ROOT="${MEDIA_ROOT#\"}"
	[ -n "$MEDIA_ROOT" ] || die "DOCKER_VOLUME_MEDIA is not set in $REPO_DIR/.env"
fi
TRANSCODED="$MEDIA_ROOT/library/transcoded"
REWORK="$MEDIA_ROOT/library/rework"

[ -d "$TRANSCODED" ] || die "no transcoded library at $TRANSCODED"
[ -d "$REWORK" ] ||
	die "the rework siding $REWORK does not exist.
  It is created once, with the Tdarr library that watches it - docs/media-pipeline.md has the fields.
  Creating the directory alone would make this script copy files somewhere nothing is watching."

# A SIDING THAT STILL HOLDS WORK IS THE REFUSAL THAT MATTERS MOST. Tdarr's queue
# is not this script's to see, so the only honest signal that the last batch
# finished is an empty siding - the flow's last node deletes each file as it
# promotes it. Piling a second batch on top is how the encoder ends up with a
# queue nobody chose and how a failed job gets buried under later ones.
held=$(find "$REWORK" -type f ! -name '.*' 2>/dev/null | wc -l)
[ "$held" -eq 0 ] ||
	die "$REWORK already holds $held file(s) - let Tdarr finish, or work out why it has not.
  A file that fails the flow stays there, which is what media.rework_stuck grades:
    find $REWORK -type f -printf '%T+ %p\n' | sort | head"

free_gb=$(df -PBG "$MEDIA_ROOT" 2>/dev/null | awk 'NR==2 {gsub(/G/,"",$4); print $4}')
case "${free_gb:-}" in
	''|*[!0-9]*) die "free space on $MEDIA_ROOT could not be read ('${free_gb:-}') - and unknown is not room" ;;
esac
[ "$free_gb" -ge "$MIN_FREE_GB" ] ||
	die "$MEDIA_ROOT has only ${free_gb}G free (want ${MIN_FREE_GB}G) - this volume has no redundancy and is not backed up"

# ------------------------------------------------------------------------------
# Select, then copy
# ------------------------------------------------------------------------------
say "Re-queueing drifting files (limit $LIMIT)"
note "list $BAD_LIST, written ${list_age_d}d ago"
[ "$DRY_RUN" = 1 ] && note "dry run - nothing will be copied"

copied=0
skipped=0
while IFS= read -r src; do
	[ -n "$src" ] || continue
	[ "$copied" -lt "$LIMIT" ] || break

	# EVERY PATH IS RE-ANCHORED UNDER transcoded/ RATHER THAN TRUSTED. The list
	# is a file on disk that something else wrote; this loop copies from it.
	case "$src" in
		"$TRANSCODED"/*) ;;
		*) note "not under $TRANSCODED, skipped: $src"; skipped=$((skipped + 1)); continue ;;
	esac
	if [ ! -f "$src" ]; then
		note "gone since the sweep, skipped: $src"
		skipped=$((skipped + 1))
		continue
	fi

	rel="${src#"$TRANSCODED"/}"
	dst="$REWORK/$rel"
	case "$rel" in
		*/*) ;;
		*) note "no <type>/ component, skipped: $src"; skipped=$((skipped + 1)); continue ;;
	esac

	if [ "$DRY_RUN" = 1 ]; then
		printf '  would copy  %s\n            -> %s\n' "$src" "$dst"
	else
		mkdir -p "$(dirname "$dst")" || die "could not create $(dirname "$dst")"
		# --reflink=auto, never plain cp: free on XFS, correct everywhere.
		cp --reflink=auto -- "$src" "$dst" || die "could not copy $src"
		ok "$rel"
	fi
	copied=$((copied + 1))
done < "$BAD_LIST"

total=$(grep -c . "$BAD_LIST" 2>/dev/null || echo 0)
printf '\n'
if [ "$DRY_RUN" = 1 ]; then
	printf 'would copy %d of %d drifting file(s)%s. Nothing was changed.\n' \
		"$copied" "$total" "${skipped:+, $skipped skipped}"
	exit 0
fi

# ITS OWN TIMESTAMP, which is CLAUDE.md's rule in general terms: a job needs a
# durable record of its last success rather than an exit code a reboot outlives.
# One writer, one file - deliberately not a key in the shared backup-state, where
# a too-narrow `grep -vE` once nearly destroyed another job's marker.
mkdir -p "$(dirname "$MARKER")" 2>/dev/null
{
	printf 'rework_queued_at=%s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)"
	printf 'rework_queued=%s\n' "$copied"
	printf 'rework_skipped=%s\n' "$skipped"
	printf 'rework_list_total=%s\n' "$total"
	printf 'rework_list_age_d=%s\n' "$list_age_d"
} > "$MARKER.tmp" 2>/dev/null && mv "$MARKER.tmp" "$MARKER"

printf 'copied %d of %d drifting file(s)%s into %s\n' \
	"$copied" "$total" "${skipped:+, $skipped skipped}" "$REWORK"
printf 'Tdarr picks them up on its next scan. Watch it, then prove the result:\n'
printf '  journalctl --user -u tdarr-node-01 -f\n'
printf '  ./bin/verify-media.sh --full <the file, at its transcoded/ path>\n'
printf 'A flat 6.047s grid is the pass; the siding empties itself as each one lands.\n'
