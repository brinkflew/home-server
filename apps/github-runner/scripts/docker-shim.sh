#!/bin/sh
# ==============================================================================
# /usr/bin/docker - podman, plus a post-mortem on the one failure that matters
# ------------------------------------------------------------------------------
# podman-docker ships this path as a two-line script that execs podman. This
# replaces it with the same exec plus diagnostics on ONE case: a `start` that
# fails. That case is upskald's api-checks, reliably, twice in two runs:
#
#   docker create  -> ok
#   docker start   -> crun: open `<graphroot>/overlay/<id>/merged/run/.containerenv`:
#                     No such file or directory
#
# and it has resisted six synthetic reproductions - both service images, `run -d`
# against `create`+`start`, the full flag set, a store reused across recycles,
# the faithful systemd scope with --cgroups=split, and 1,662 verified MemoryHigh
# breaches of deliberate pressure. All of them started postgres cleanly.
#
# THE EVIDENCE KEEPS BEING DESTROYED BEFORE ANYONE LOOKS. The runner tears the
# job down within seconds, so a host-side snapshot - even one polling every 8
# seconds - arrives to find the layer deleted, containers.json back to `[]` and a
# store that looks perfectly healthy. That is what a cleaned store looks like,
# not what a broken one looks like, and the two are indistinguishable after the
# fact. The only place with the answer is inside the container at the instant
# start returns non-zero, which is here.
#
# STDOUT IS NEVER TOUCHED. DockerCommandManager.cs parses container ids off
# stdout, so every byte of it has to pass through unaltered - podman inherits
# this process's stdout and writes to it directly. Everything below goes to
# STDERR, where it lands in the job log as an annotation and changes nothing.
#
# The exit code is podman's own, unchanged. This wrapper must never convert a
# failure into a success or a success into a failure: it is a witness, not a
# gate. If it is ever given a retry, that is a separate decision recorded
# separately - see docs/ci.md.
# ==============================================================================

/usr/bin/podman "$@"
rc=$?

# Only a failing `start`, and only when the store is where we expect it. Any
# other non-zero exit is the workflow's business and is left alone.
[ "$rc" -eq 0 ] && exit 0
[ "${1:-}" = start ] || exit "$rc"

S=/var/lib/nested-storage
[ -d "$S" ] || exit "$rc"

{
	echo "::group::home-server lane: post-mortem for a failed 'docker start'"
	echo "rc=$rc  argv=$*"
	echo "date=$(date -u +%Y-%m-%dT%H:%M:%SZ)"

	echo "--- store ---"
	/usr/bin/podman info --format '{{.Store.GraphDriverName}} root={{.Store.GraphRoot}} run={{.Store.RunRoot}}' 2>&1
	n=0
	for d in "$S"/overlay/*/; do
		b=$(basename "$d")
		case "$b" in l | tempdirs) continue ;; esac
		n=$((n + 1))
		[ -d "$d/merged" ] || echo "  NO merged/: $b"
		# An overlay dir whose merged/ exists but is EMPTY is the shape the error
		# implies - a mount that did not take, so the rootfs has no /run for
		# .containerenv to land in. `merged` missing and `merged` empty are
		# different failures and the message cannot tell them apart.
		if [ -d "$d/merged" ] && [ -z "$(ls -A "$d/merged" 2>/dev/null)" ]; then
			echo "  EMPTY merged/: $b"
		fi
	done
	echo "  layers=$n  overlay-mounts=$(grep -c ' overlay ' /proc/self/mountinfo 2>/dev/null)"

	echo "--- containers podman still knows about ---"
	/usr/bin/podman ps -a --format '  {{.ID}} {{.Status}} {{.Image}}' 2>&1 | head -10

	echo "--- resources ---"
	echo "  df:   $(df -h "$S" 2>/dev/null | tail -1)"
	echo "  inodes: $(df -i "$S" 2>/dev/null | tail -1)"
	echo "  pids: $(cat /sys/fs/cgroup/pids.current 2>/dev/null) of $(cat /sys/fs/cgroup/pids.max 2>/dev/null)"
	echo "  mem:  current=$(cat /sys/fs/cgroup/memory.current 2>/dev/null) max=$(cat /sys/fs/cgroup/memory.max 2>/dev/null)"
	echo "  memory.events:"
	sed 's/^/    /' /sys/fs/cgroup/memory.events 2>/dev/null
	echo "  pressure(io):  $(head -1 /sys/fs/cgroup/io.pressure 2>/dev/null)"
	echo "  pressure(mem): $(head -1 /sys/fs/cgroup/memory.pressure 2>/dev/null)"
	echo "  pressure(cpu): $(head -1 /sys/fs/cgroup/cpu.pressure 2>/dev/null)"

	echo "--- dmesg tail, if readable ---"
	dmesg 2>/dev/null | tail -5 | sed 's/^/  /' || echo "  (not readable from here)"
	echo "::endgroup::"
} >&2

exit "$rc"
