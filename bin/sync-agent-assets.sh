#!/usr/bin/env bash
# ==============================================================================
# Ship the two things a phase needs that are not in any repository
# ------------------------------------------------------------------------------
# RUN FROM THE WORKSTATION, like bin/verify-restore.sh and bin/backup-config.sh,
# and for the same kind of reason: both of these live on the workstation and
# neither can be fetched from the server side.
#
#   memory   ~/.claude/projects/<slug>/memory - 148 files and about a megabyte
#            of what a workstation session has learned about upskald, most of it
#            paid for by getting something wrong once. Written continuously by
#            every session and in no git repository at all.
#
#   rtk      a static-pie binary in ~/.local/bin. The container mounts it over
#            its read-only rootfs, so there is no image rebuild and the phase
#            runs byte-for-byte the same rtk the workstation does.
#
# WHY NOT COMMIT THE MEMORY. It is a cache of knowledge rather than
# configuration - regenerable, already backed up on the workstation, and rewritten
# by every session - so the argument in CLAUDE.md against unversioned state on
# the server does not reach it: nothing here has to be restored from git to bring
# the machine back. What that costs is freshness, because this is a script
# somebody runs rather than a timer. So the failure mode is silence, not an
# error: the mount stays, the files stay, and they quietly describe a codebase
# from a month ago. `agents.memory_age` is the check that makes that loud, and
# conduct puts the age on the approval card.
#
# READ-ONLY ON THE OTHER SIDE, and that is not tidiness. A phase that could write
# to the memory would be writing the NEXT phase's instructions, which is the one
# way an agent in this design could reach past the end of its own run. The mount
# is :ro in conduct/phase.py; this script is the only writer.
#
# --delete IS DELIBERATE AND IS WHY THERE IS A --dry-run. The destination is a
# mirror of a directory this script owns entirely, so a file the workstation
# removed must go; without it a memory the user deleted for being wrong would
# outlive the correction, which is the worst kind of stale.
# ==============================================================================

set -euo pipefail

REMOTE="${AGENTS_REMOTE:-home.local}"
FLEET_ROOT="${AGENTS_FLEET_ROOT:-/var/home-server/cache/conduct}"

# (project, workstation memory directory). One row per project conduct knows.
# The slug is Claude Code's own encoding of the project path, so it is copied
# rather than derived: deriving it would be this repository guessing at another
# tool's naming scheme, which is how a sync starts silently shipping nothing.
PROJECTS="
upskald ${HOME}/.claude/projects/-home-avs-repos-avanserv-upskald/memory
"

RTK="${RTK_BINARY:-${HOME}/.local/bin/rtk}"

dry=""
while [ $# -gt 0 ]; do
	case "$1" in
	--dry-run) dry="--dry-run" ;;
	*)
		printf 'usage: %s [--dry-run]\n' "$0" >&2
		exit 2
		;;
	esac
	shift
done

fails=0
ok() { printf '  ok    %s\n' "$*"; }
bad() {
	printf '  FAIL  %s\n' "$*"
	fails=$((fails + 1))
}
say() { printf '\n%s\n' "$*"; }

[ -n "$dry" ] && printf 'DRY RUN - nothing is written\n'

say "Memory"
# A HERE-STRING RATHER THAN A PIPE. `printf ... | while` runs the loop body in a
# subshell, so every bad() inside it would increment a copy of $fails and this
# script would exit 0 with FAIL lines on the screen - which is worse than not
# checking, because it looks checked.
while read -r project source; do
	[ -n "$project" ] || continue
	if [ ! -d "$source" ]; then
		bad "$project: no memory directory at $source"
		continue
	fi
	# MEASURED BEFORE IT IS SENT, so the line that prints is about what the
	# server will have rather than about what rsync happened to transfer.
	count=$(find "$source" -type f | wc -l)
	if [ ! -f "$source/MEMORY.md" ]; then
		# The index is what a session actually loads, and what conduct inlines
		# into the prompt. Without it the mount is 147 files nothing points at.
		bad "$project: $source has no MEMORY.md - the index is the half that is read"
		continue
	fi
	# rsync CREATES THE LAST COMPONENT AND NOT THE CHAIN, so a first run against
	# a host that has never had this directory fails with "No such file or
	# directory" naming the path it was about to create.
	if [ -z "$dry" ]; then
		# shellcheck disable=SC2029  # $FLEET_ROOT is a remote path set here
		ssh "$REMOTE" "mkdir -p '$FLEET_ROOT/memory/$project'"
	fi
	# shellcheck disable=SC2086  # $dry is one optional flag or empty
	if rsync -a --delete $dry \
		"$source/" "$REMOTE:$FLEET_ROOT/memory/$project/"; then
		ok "$project: $count file(s) to $FLEET_ROOT/memory/$project"
	else
		bad "$project: rsync failed"
	fi
done <<<"$PROJECTS"

say "rtk"
if [ ! -x "$RTK" ]; then
	bad "no rtk at $RTK"
else
	# STATIC OR IT DOES NOT TRAVEL. The workstation is WSL2 and the runner is
	# Debian trixie; a dynamically linked binary would find a different libc
	# and fail with a message about an interpreter rather than about this.
	if ! file "$RTK" | grep -q 'static-pie\|statically linked'; then
		bad "$RTK is not statically linked, so it will not run in the runner"
	else
		version=$("$RTK" --version 2>/dev/null | head -1)
		if [ -z "$dry" ]; then
			# Client-side expansion is the intent: $FLEET_ROOT names a path
			# on the far side and is set here, not there.
			# shellcheck disable=SC2029
			ssh "$REMOTE" "mkdir -p '$FLEET_ROOT/bin'"
			rsync -a "$RTK" "$REMOTE:$FLEET_ROOT/bin/rtk" || bad "rtk: rsync failed"
			# shellcheck disable=SC2029
			ssh "$REMOTE" "chmod 0755 '$FLEET_ROOT/bin/rtk'"
		fi
		ok "${version:-rtk} to $FLEET_ROOT/bin/rtk"
	fi
fi

say "Summary"
if [ "$fails" -gt 0 ]; then
	printf '  %d problem(s)\n' "$fails"
	exit 1
fi
printf '  everything a phase needs is on %s\n' "$REMOTE"
