#!/bin/sh
# ==============================================================================
# /usr/bin/docker - podman, a post-mortem, and exactly one thing that is not one
# ------------------------------------------------------------------------------
# podman-docker ships this path as a two-line script that execs podman. This
# replaces it with the same exec plus two behaviours on ONE case: a `start` that
# fails. That case is upskald's api-checks, reliably, on both lanes and on three
# different images:
#
#   docker create  -> ok
#   docker start   -> crun: open `<graphroot>/overlay/<id>/merged/run/.containerenv`:
#                     No such file or directory
#
# NINE SYNTHETIC REPRODUCTIONS HAVE NOW FAILED TO FIRE. Both service images;
# `run -d` against `create`+`start`; the driver's full flag set; a store reused
# across six container recycles; the faithful hosting with the systemd scope,
# --cgroups=split and the 3,584M cap; 1,662 VERIFIED MemoryHigh breaches of
# deliberate slice pressure; /tmp filled to 90%; and finally the user-namespace
# hypothesis taken apart three ways in one run - the pause pid file deleted, the
# pause process killed, and the whole runtime directory wiped, each between
# `create` and `start`. All of them started postgres cleanly.
#
# THE POST-MORTEM IS HERE BECAUSE THE EVIDENCE IS DESTROYED EVERY TIME ANYONE
# LOOKS. Teardown runs within seconds, so a host-side snapshot polling every 8
# seconds still arrived to find the layer deleted, containers.json back to `[]`
# and a store that looked perfectly healthy - which is what a CLEANED store looks
# like, not a broken one, and after the fact the two are indistinguishable.
# Inside the container at the instant start fails is the only place with the
# answer.
#
# THE RETRY IS A GATE, AND THIS FILE USED TO SAY IT WOULD NEVER BE ONE. That
# sentence was written when the alternative was still "find the cause", and nine
# reproductions later it is not. So it is stated rather than quietly reversed: a
# failing `docker start` is now attempted up to three times, and a job that would
# have failed can now pass. The trade is that a service which is genuinely broken
# costs seven extra seconds before it says so, against a whole class of job that
# is otherwise unavailable on this runner. It treats a symptom nobody has
# explained - which is why the post-mortem above stays armed, and why every
# retry is announced in the job log rather than swallowed.
#
# WHAT IT MUST NEVER DO, and the second one nearly happened:
#
#   1. TOUCH STDOUT. DockerCommandManager.cs parses container ids off stdout, so
#      one stray byte breaks EVERY services: job rather than only the failing
#      ones. podman inherits this process's stdout and writes to it directly; all
#      diagnostics go to stderr. The retry is safe for the same reason, measured
#      rather than assumed: a FAILING `podman start` writes nothing at all to
#      stdout (rc=125, zero bytes), so a second attempt that succeeds prints the
#      id exactly once - the same output a first-attempt success would give.
#      bin/github-runner-smoke.sh asserts both halves of that.
#
#   2. RETRY AN ATTACHED START. `docker start -a` returns the CONTAINER'S exit
#      code, so a non-zero result there is an ordinary outcome and not a failure
#      - and re-running it would execute the container a second time and
#      duplicate its output onto stdout. Any `-a`/`--attach`/`-i`/`--interactive`
#      therefore disables the retry and leaves this a witness, as before.
#
# See: apps/github-runner/Dockerfile, bin/github-runner-smoke.sh, docs/ci.md
# ==============================================================================

# Number of EXTRA attempts, and the pause before each. Two, because a third has
# nothing left to be transient about: if the cause persists past seven seconds it
# is not the race this is aimed at, and the job should be told so promptly.
RETRIES=2
BACKOFF="2 5"

S=/var/lib/nested-storage
U=$(id -u)

# ONE LINE PER `create` AND `start`, AND IT COSTS NO PODMAN INVOCATION.
# A job makes roughly twenty `docker` calls; starting an engine to ask `podman
# info` on each of them would be twenty engine starts and would perturb the very
# thing being measured. Everything below is `[ -e ]` tests and one read of
# /proc/1/environ.
#
# WHAT IT IS LOOKING FOR is two engines in one lane disagreeing about where the
# runtime state lives. libpod's `db.sql` records the runroot it was created with,
# and that beats both the environment and storage.conf; the rootless pause
# process is registered from the environment instead. When those differ, `alive`
# and `pause.pid` land in different directories - and since containers/storage
# keeps overlay mount refcounts under the runroot, one engine can believe a layer
# is mounted that the other never mounted. runner-init repairs the known cause at
# start-up; this is what would show a second one.
#
# PID 1 IS Runner.Listener IN A LANE, and its environment is what every job step
# inherits, so a difference between it and this process is the actions runner
# rewriting the runtime directory - a cause runner-init cannot see. It is
# readable because runner-init drops to this uid BEFORE it execs.
#
# Printed on the SUCCESS path too, deliberately: a failing job's line means
# nothing without a passing one beside it.
fingerprint() {
	fp_a=
	fp_p=
	fp_n=0
	for fp_d in "${XDG_RUNTIME_DIR:-}" /tmp/podman-run "/tmp/podman-run-$U" \
		"/run/user/$U" "${TMPDIR:-/tmp}/podman-run-$U"; do
		[ -n "$fp_d" ] || continue
		if [ -e "$fp_d/libpod/tmp/alive" ]; then
			fp_a="$fp_a$fp_d,"
			fp_n=$((fp_n + 1))
		fi
		[ -e "$fp_d/libpod/tmp/pause.pid" ] && fp_p="$fp_p$fp_d,"
	done
	fp_1=$(tr '\0' '\n' < /proc/1/environ 2>/dev/null | sed -n 's/^XDG_RUNTIME_DIR=//p')
	fp_t=ok
	[ "$fp_n" = 1 ] || fp_t=SPLIT
	[ "$fp_a" = "$fp_p" ] || fp_t=SPLIT
	[ "${fp_1:-${XDG_RUNTIME_DIR:-}}" = "${XDG_RUNTIME_DIR:-}" ] || fp_t=SPLIT
	printf '%s x=%s p1=%s alive=%s pause=%s' "$fp_t" \
		"${XDG_RUNTIME_DIR:-unset}" "${fp_1:-unset}" "${fp_a:-none}" "${fp_p:-none}"
}

# EVERY VARIABLE IN HERE IS PREFIXED, AND THE FIRST VERSION WAS NOT. A POSIX
# shell function has no locals, so this function's own loop counter and the retry
# loop's counter were both `n` - and calling the post-mortem from inside the retry
# loop reset it. The visible symptom was two announcements both reading
# "retry 1 of 2"; the invisible one was that the loop's own `-le "$RETRIES"` guard
# was reading a layer count, so a longer backoff list would have retried more
# times than the constant says. Caught by bin/github-runner-smoke.sh's new leg on
# its first run, which is the entire reason that leg counts the announcements
# instead of trusting them.
postmortem() {
	pm_rc=$1
	shift
	[ -d "$S" ] || return 0
	{
		echo "::group::home-server lane: post-mortem for a failed 'docker start'"
		echo "rc=$pm_rc  argv=$*"
		echo "date=$(date -u +%Y-%m-%dT%H:%M:%SZ)"

		echo "--- store ---"
		/usr/bin/podman info --format '{{.Store.GraphDriverName}} root={{.Store.GraphRoot}} run={{.Store.RunRoot}} conf={{.Store.ConfigFile}}' 2>&1

		# HERE THE EXTRA ENGINE STARTS ARE AFFORDABLE - this runs once, on a job
		# that has already failed. The debug lines name all four directories at
		# once, and `mountpoints.json` is the file containers/storage uses to
		# decide a layer is already mounted. Twelve layers listed there beside the
		# `overlay-mounts=1` printed below is the two-engine mechanism, caught in
		# the act rather than inferred.
		echo "--- runtime dirs ---"
		echo "  $(fingerprint)"
		/usr/bin/podman --log-level=debug info 2>&1 |
			grep -E 'Using (run root|graph root|static dir|tmp dir)' | sed 's/^/  /'
		for pm_r in "${XDG_RUNTIME_DIR:-}" /tmp/podman-run "/run/user/$U"; do
			[ -n "$pm_r" ] || continue
			[ -d "$pm_r" ] || continue
			echo "  $pm_r/libpod/tmp: $(find "$pm_r/libpod/tmp" -maxdepth 1 -mindepth 1 -printf '%f ' 2>/dev/null)"
			pm_mp="$pm_r/containers/overlay-layers/mountpoints.json"
			if [ -f "$pm_mp" ]; then
				echo "    mountpoints.json: $(wc -c <"$pm_mp") bytes"
			fi
		done
		pm_n=0
		for pm_d in "$S"/overlay/*/; do
			pm_b=$(basename "$pm_d")
			case "$pm_b" in l | tempdirs) continue ;; esac
			pm_n=$((pm_n + 1))
			[ -d "$pm_d/merged" ] || echo "  NO merged/: $pm_b"
			# An overlay dir whose merged/ exists but is EMPTY is the shape the error
			# implies - a mount that did not take, so the rootfs has no /run for
			# .containerenv to land in. `merged` missing and `merged` empty are
			# different failures and the message cannot tell them apart.
			if [ -d "$pm_d/merged" ] && [ -z "$(ls -A "$pm_d/merged" 2>/dev/null)" ]; then
				echo "  EMPTY merged/: $pm_b"
			fi
		done
		echo "  layers=$pm_n  overlay-mounts=$(grep -c ' overlay ' /proc/self/mountinfo 2>/dev/null)"

		echo "--- containers podman still knows about ---"
		/usr/bin/podman ps -a --format '  {{.ID}} {{.Status}} {{.Image}}' 2>&1 | head -10

		echo "--- resources ---"
		echo "  df:   $(df -h "$S" 2>/dev/null | tail -1)"
		echo "  inodes: $(df -i "$S" 2>/dev/null | tail -1)"
		echo "  runtime dir: $(df -h "${XDG_RUNTIME_DIR:-/run}" 2>/dev/null | tail -1)"
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
}

# BEFORE the call, so it cannot disturb $?, and only for the two verbs that
# create and mount a rootfs. stderr only - stdout is the runner's.
case "${1:-}" in
create | start) echo "home-server lane: engine-fp $1 $(fingerprint)" >&2 ;;
esac

/usr/bin/podman "$@"
rc=$?

# Only a failing `start`. Any other non-zero exit is the workflow's business and
# is passed through untouched.
[ "$rc" -eq 0 ] && exit 0
[ "${1:-}" = start ] || exit "$rc"

postmortem "$rc" "$@"

# The attach guard - see the header. A combined short flag such as `-ai` has to
# match too, which is why this looks at the letters rather than the whole word.
for a in "$@"; do
	case "$a" in
	--attach | --interactive) attach=1 ;;
	--*) ;;
	-*) case "$a" in *a* | *i*) attach=1 ;; esac ;;
	esac
done
if [ "${attach:-0}" = 1 ]; then
	echo "home-server lane: 'docker start' was attached, so its exit code is the" >&2
	echo "  container's own and retrying would run it twice. Not retried." >&2
	exit "$rc"
fi

try=0
for pause in $BACKOFF; do
	try=$((try + 1))
	[ "$try" -le "$RETRIES" ] || break
	echo "home-server lane: 'docker start' failed with $rc; retry $try of $RETRIES in ${pause}s." >&2
	echo "  This is apps/github-runner/scripts/docker-shim.sh, not the workflow." >&2
	sleep "$pause"

	/usr/bin/podman "$@"
	rc=$?
	if [ "$rc" -eq 0 ]; then
		echo "home-server lane: retry $try succeeded. The first attempt's post-mortem is" >&2
		echo "  above and is worth reading - this path exists because the cause is" >&2
		echo "  still unknown. See docs/ci.md." >&2
		exit 0
	fi
	postmortem "$rc" "$@"
done

echo "home-server lane: 'docker start' still failing after $RETRIES retries; giving" >&2
echo "  the job podman's own exit code, $rc." >&2
exit "$rc"
