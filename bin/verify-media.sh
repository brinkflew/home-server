#!/usr/bin/env bash
# ==============================================================================
# Does this file's keyframe grid survive Jellyfin's HLS stream-copy path?
# ------------------------------------------------------------------------------
# RUNS ON THE SERVER, as core, from /var/home-server. It probes through the
# jellyfin container because that is where jellyfin-ffmpeg lives; nothing here
# needs the host to have ffmpeg installed, which on an immutable /usr it does
# not.
#
# WHAT IT ASSERTS, and why it is not a theoretical concern.
#
# When a browser plays an MKV, Jellyfin does not transcode the video - it copies
# it into fMP4 HLS segments. On that path two grids have to agree:
#
#   - Jellyfin advertises ONE SEGMENT PER KEYFRAME, from the KeyframeData index
#     it builds for mkv (AllowOnDemandMetadataBasedKeyframeExtractionForExtensions).
#   - ffmpeg is told -hls_time 6 and, unable to cut anywhere but a keyframe,
#     MERGES consecutive shorter GOPs until it has 6 seconds.
#
# So a file whose keyframes are closer together than the segment length makes
# ffmpeg's segment N hold different media than playlist entry N, from the second
# segment of every session onward, and the error ACCUMULATES. Measured on
# Backrooms (2026), whose keyframes ran 0.375s to 10.427s apart: +3.838s after
# one segment, +22.397s after twenty-five. What that looks like to someone
# watching is the picture jumping forward a few seconds, and then subtitles that
# no longer match the audio - because Jellyfin strips text subtitles out of the
# stream (-map -0:s) and times them against the player's currentTime, which is
# now the thing that is wrong. Reloading the page fixes it until the next
# segment, which is what makes it read like a network problem.
#
# The fix is in apps/tdarr/plugins/Tdarr_Plugin_avs1_MediaStackStreamPolicy.js,
# which now pins the NVENC keyframe interval just above the segment length. This
# script is how you tell whether a given file predates that, or slipped past it.
#
# IT SAMPLES BY DEFAULT, AND THAT IS DELIBERATE. /mnt/media is one 7200rpm
# spindle whose throughput FALLS with concurrency, and reading every library
# file end to end is the operation that took the whole host down once already.
# Three 120-second windows characterise a GOP pattern perfectly well; --full is
# there for when a single file is genuinely in question.
#
# Usage:
#   bin/verify-media.sh <file>...          host paths under /mnt/media/library
#   bin/verify-media.sh --library          sweep library/transcoded (samples)
#   bin/verify-media.sh --library movies   one type only
#   bin/verify-media.sh --full <file>      every keyframe, not three windows
#   bin/verify-media.sh --min-gap 6 ...    the segment length to check against
#   bin/verify-media.sh --marker <path>    write a machine-readable record
#   bin/verify-media.sh --gate             exit 1 if somebody is watching
#
# --marker EXISTS BECAUSE THIS IS ON A TIMER NOW, and a timer needs a durable
# record of its last success rather than a unit that exits 0. That is CLAUDE.md's
# rule in general terms, and here it has a second job: THE EXIT CODE OF THIS
# SCRIPT IS OVERLOADED. `exit 1` is both "one or more files will drift" and
# "die() - there is no podman, or no jellyfin container, or DOCKER_VOLUME_MEDIA
# is unreadable", which are opposite findings. A reader with only the exit code
# cannot tell "the library is bad" from "the check could not run", and reading
# green when the check never ran is the failure mode most of
# docs/known-state.md is about.
#
# So the marker carries media_error, which is set on the die() path and empty on
# every other, and media.keyframe_drift in bin/verify-host.sh grades the two
# separately. The exit codes are deliberately UNCHANGED: this script has hand
# callers and a timer, and moving the codes under the hand callers to help the
# timer would be paying the wrong party.
# ==============================================================================

set -uo pipefail

MIN_GAP=6
WINDOW=120
SAMPLES=3
FULL=""
SWEEP=""
SWEEP_TYPE=""
LIMIT=0
MARKER=""
GATE=""

usage() { sed -n '2,/^# ===/p' "$0" | sed 's/^# \{0,1\}//'; exit "${1:-0}"; }

while [ $# -gt 0 ]; do
	case "${1:-}" in
		--min-gap)   MIN_GAP="${2:-}"; shift 2 ;;
		--min-gap=*) MIN_GAP="${1#*=}"; shift ;;
		--window)    WINDOW="${2:-}"; shift 2 ;;
		--window=*)  WINDOW="${1#*=}"; shift ;;
		--samples)   SAMPLES="${2:-}"; shift 2 ;;
		--samples=*) SAMPLES="${1#*=}"; shift ;;
		--limit)     LIMIT="${2:-}"; shift 2 ;;
		--limit=*)   LIMIT="${1#*=}"; shift ;;
		--gate)      GATE=1; shift ;;
		--marker)    MARKER="${2:-}"; shift 2 ;;
		--marker=*)  MARKER="${1#*=}"; shift ;;
		--full)      FULL=1; shift ;;
		--library)   SWEEP=1; shift
		             case "${1:-}" in -*|'') ;; *) SWEEP_TYPE="$1"; shift ;; esac ;;
		-h|--help)   usage 0 ;;
		--)          shift; break ;;
		-*)          echo "verify-media: unknown argument: $1" >&2; exit 2 ;;
		*)           break ;;
	esac
done

# ------------------------------------------------------------------------------
# --gate: is anybody watching?
# ------------------------------------------------------------------------------
# THE SPINDLE IS THE REASON, NOT THE CPU. /mnt/media is one 7200rpm disk whose
# throughput FALLS with concurrency - two readers cost 45% of total, and the
# penalty is head travel - so a sweep and a stream are the worst pair of jobs
# this host can run at once. Nice and IOWeight on the unit reduce the priority
# of the reads; they cannot stop the head moving.
#
# EXIT 1 MEANS SKIP, which inverts bin/reboot-when-staged.sh's refuse() and
# matches bin/update-when-idle.sh exactly, for the same reason: this is an
# `ExecCondition=`, and systemd reads a non-zero exit there as "skip quietly"
# and leaves the unit NOT failed. An `ExecStartPre=` would make an ordinary
# deferral look like a fault.
#
# UNKNOWN PROCEEDS, which is the opposite of the reboot gate and the same as the
# nightly container update. The asymmetry is priced by what the interruption
# costs: a reboot cuts a stream dead, and this competes for disk with one. Being
# unable to ask whether anyone is watching is not a reason to stop verifying the
# library for a week.
#
# AND A DEFERRAL IS WHY media.verify_run GRADES THE MARKER RATHER THAN THE UNIT.
# A skipped run CLEARS ExecMainExitTimestamp rather than leaving it stale, so
# check_timer_run would report "has never run" and FAIL from the first
# deferral - on a host that swept the library perfectly seven days earlier.
# bin/verify-host.sh paid for that lesson on update.podman_run.
if [ -n "$GATE" ]; then
	watching=$("$(dirname "${BASH_SOURCE[0]}")/jellyfin-watching.sh" 2>/dev/null) || watching=""
	case "${watching:-}" in
		''|*[!0-9]*)
			echo "verify-media: cannot tell whether anyone is watching - proceeding"
			exit 0 ;;
		0)  exit 0 ;;
		*)  echo "verify-media: $watching session(s) in flight - deferring the sweep"
		    exit 1 ;;
	esac
fi

fails=0
warns=0
checked=0
say()  { printf '\n\033[1m==> %s\033[0m\n' "$*"; }
ok()   { printf '  \033[32mPASS\033[0m  %s\n' "$*"; }
warn() { printf '  \033[33mWARN\033[0m  %s\n' "$*"; warns=$((warns + 1)); }
bad()  { printf '  \033[31mFAIL\033[0m  %s\n' "$*"; fails=$((fails + 1)); }

# ------------------------------------------------------------------------------
# The durable record, and the one thing the exit code cannot say
# ------------------------------------------------------------------------------
# ONE WRITER, ONE FILE, NO CARRY-FORWARD. The shape bin/ci-artifacts-sweep.sh
# uses, and deliberately not a key in the shared backup-state, which five
# programs merge into and where a too-narrow `grep -vE` once nearly destroyed
# another job's marker.
#
# THE NAMES ARE CAPPED AT TEN AND THAT IS NOT COSMETIC. media_files_bad carries
# the count and this carries enough to start with; a sweep that found four
# hundred drifting files would otherwise put four hundred paths into
# status.json, which is read whole by the dashboard and by every consumer of
# --json. A cap on what a check can emit is the same rule the collector applies
# to labels.
#
# SPACES, NOT NEWLINES, because this is a key=value file read with `sed -n
# 's/^k=//p'` and a value spanning lines would be silently truncated to its
# first one.
bad_names=""
write_marker() {  # <error-or-empty>
	[ -n "$MARKER" ] || return 0
	mkdir -p "$(dirname "$MARKER")" 2>/dev/null
	{
		printf 'media_verified_at=%s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)"
		printf 'media_files_checked=%s\n' "$checked"
		printf 'media_files_bad=%s\n' "$fails"
		printf 'media_files_skipped=%s\n' "$warns"
		printf 'media_min_gap=%s\n' "$MIN_GAP"
		printf 'media_scope=%s\n' "${SWEEP_TYPE:-${SWEEP:+all}}"
		printf 'media_bad_names=%s\n' "$(printf '%s' "$bad_names" | tr '\n' ' ' | cut -c1-400)"
		printf 'media_error=%s\n' "${1:-}"
	} > "$MARKER.tmp" 2>/dev/null && mv "$MARKER.tmp" "$MARKER"
}

# die() WRITES THE MARKER FIRST, and that is the whole point of having one. Every
# path through here exits 1 - and so does a run that completed and found drift.
# A reader with only the exit code cannot separate "the library is bad" from
# "the check could not run at all", and the second one reading as the first is
# how a check that has silently stopped working looks exactly like a check that
# is working and finding nothing.
die()  {
	write_marker "$*"
	printf '\033[31mverify-media: %s\033[0m\n' "$*" >&2
	exit 1
}

case "$MIN_GAP" in ''|*[!0-9.]*) die "--min-gap takes a number of seconds, not '$MIN_GAP'" ;; esac
case "$WINDOW"  in ''|*[!0-9]*)  die "--window takes whole seconds, not '$WINDOW'" ;; esac
case "$SAMPLES" in ''|*[!0-9]*)  die "--samples takes a whole number, not '$SAMPLES'" ;; esac
case "$LIMIT"   in ''|*[!0-9]*)  die "--limit takes a whole number, not '$LIMIT'" ;; esac
[ "$SAMPLES" -gt 0 ] || die "--samples must be at least 1"

command -v podman >/dev/null || die "podman is not on PATH - this runs on the server, as core"
podman container exists jellyfin 2>/dev/null || die "the jellyfin container is not running; it is what carries ffprobe"

# The media root is derived, never hardcoded: sibling scripts that hardcoded it
# had to be fixed once already. jellyfin mounts <media>/library at /data/media,
# so a host path is translated by stripping that prefix.
MEDIA_ROOT="${DOCKER_VOLUME_MEDIA:-}"
if [ -z "$MEDIA_ROOT" ]; then
	REPO_DIR=$(cd -- "$(dirname -- "$0")/.." && pwd)
	[ -r "$REPO_DIR/.env" ] || die "no .env at $REPO_DIR - run ./bin/render-env.sh first"
	MEDIA_ROOT=$(sed -n 's/^DOCKER_VOLUME_MEDIA=//p' "$REPO_DIR/.env" | tail -1)
	MEDIA_ROOT="${MEDIA_ROOT%\"}"; MEDIA_ROOT="${MEDIA_ROOT#\"}"
	[ -n "$MEDIA_ROOT" ] || die "DOCKER_VOLUME_MEDIA is not set in $REPO_DIR/.env"
fi
LIBRARY_ROOT="$MEDIA_ROOT/library"

probe() { podman exec jellyfin /usr/lib/jellyfin-ffmpeg/ffprobe "$@"; }

# Host path -> the path jellyfin sees. Accept a container path unchanged so the
# output of a podman-side command can be pasted straight back in.
to_container_path() {
	case "$1" in
		/data/media/*)      printf '%s' "$1" ;;
		"$LIBRARY_ROOT"/*)  printf '/data/media/%s' "${1#"$LIBRARY_ROOT"/}" ;;
		*) return 1 ;;
	esac
}

# Keyframe timestamps in one interval. PACKETS, not frames: a packet flagged K is
# a keyframe and reading them is pure demux, while -skip_frame nokey decodes. On
# a spindle that difference is the whole cost of this script.
keyframes_in() {
	local cpath="$1" interval="$2"
	if [ -n "$interval" ]; then
		probe -v error -select_streams v:0 -show_entries packet=pts_time,flags \
			-of csv=p=0 -read_intervals "$interval" "$cpath" 2>/dev/null
	else
		probe -v error -select_streams v:0 -show_entries packet=pts_time,flags \
			-of csv=p=0 "$cpath" 2>/dev/null
	fi | awk -F, '$2 ~ /^K/ {print $1}'
}

check_file() {
	local host="$1" cpath duration gaps stats
	cpath=$(to_container_path "$host") || {
		warn "$(basename -- "$host"): not under $LIBRARY_ROOT, skipped"
		return
	}
	checked=$((checked + 1))

	duration=$(probe -v error -show_entries format=duration -of csv=p=0 "$cpath" 2>/dev/null)
	case "$duration" in
		''|*[!0-9.]*) bad "$(basename -- "$host"): cannot read a duration - is the path right?"; return ;;
	esac

	if [ -n "$FULL" ]; then
		gaps=$(keyframes_in "$cpath" "")
	else
		# Spread the windows over the body of the file rather than the head: the
		# first minute of a film is titles, which are not representative of
		# anything, and the last is credits.
		gaps=$(
			awk -v d="$duration" -v n="$SAMPLES" 'BEGIN {
				for (i = 1; i <= n; i++) printf "%.3f\n", d * i / (n + 1)
			}' | while read -r start; do
				keyframes_in "$cpath" "${start}%+${WINDOW}"
			done
		)
	fi

	# Deltas within each window only. Concatenated windows have a huge artificial
	# jump between them, and counting that as a gap would mask a real one by
	# dominating the maximum. The reset is a drop back in time OR a jump larger
	# than the window, both of which mean a new window started.
	stats=$(printf '%s\n' "$gaps" | awk -v w="$WINDOW" -v lim="$MIN_GAP" '
		$1 == "" { next }
		{
			t = $1 + 0
			if (prev != "" && t > prev && (t - prev) <= w) {
				g = t - prev
				n++; sum += g
				if (min == "" || g < min) min = g
				if (max == "" || g > max) max = g
				if (g < lim) short++
			}
			prev = t
		}
		END {
			if (n == 0) { print "none"; exit }
			printf "%d %.3f %.3f %.3f %d", n, min, sum / n, max, short
		}')

	local name; name=$(basename -- "$host")
	if [ "$stats" = "none" ] || [ -z "$stats" ]; then
		warn "$name: no keyframe intervals measured - too short, or not a video"
		return
	fi

	# shellcheck disable=SC2086  # deliberate word splitting of the awk record
	set -- $stats
	local n="$1" min="$2" mean="$3" max="$4" short="$5"
	local detail="min ${min}s / mean ${mean}s / max ${max}s over $n intervals"

	if [ "$short" -gt 0 ]; then
		# Ten, matching write_marker's own cap - accumulating four hundred and
		# truncating at the end would build the whole string first.
		[ "$fails" -lt 10 ] && bad_names="$bad_names $name"
		bad "$name: $short of $n keyframe intervals below ${MIN_GAP}s - $detail
          Jellyfin will merge segments for this file and browser playback will drift."
	else
		ok "$name: $detail"
	fi
}

if [ -n "$SWEEP" ]; then
	root="$LIBRARY_ROOT/transcoded"
	[ -n "$SWEEP_TYPE" ] && root="$root/$SWEEP_TYPE"
	[ -d "$root" ] || die "no such library path: $root"
	say "Keyframe grid: $root (sampled, ${SAMPLES}x${WINDOW}s per file)"
	files=$(find "$root" -type f \( -name '*.mkv' -o -name '*.mp4' \) | sort)
	[ "$LIMIT" -gt 0 ] && files=$(printf '%s\n' "$files" | head -n "$LIMIT")
	[ -n "$files" ] || die "no media files under $root"
	while IFS= read -r f; do
		[ -n "$f" ] && check_file "$f"
	done <<-EOF
		$files
	EOF
else
	[ $# -gt 0 ] || usage 2
	say "Keyframe grid$([ -n "$FULL" ] && echo ' (full scan)' || echo " (sampled, ${SAMPLES}x${WINDOW}s)")"
	for f in "$@"; do
		check_file "$f"
	done
fi

printf '\n'
write_marker ""
if [ "$fails" -gt 0 ]; then
	printf '\033[31m%d of %d file(s) will drift in a browser.\033[0m ' "$fails" "$checked"
	printf 'Re-transcode them, or watch those in a native client, which direct-plays.\n'
	exit 1
fi
printf '\033[32m%d file(s) checked, none below %ss.\033[0m' "$checked" "$MIN_GAP"
[ "$warns" -gt 0 ] && printf ' %d skipped.' "$warns"
printf '\n'
exit 0
