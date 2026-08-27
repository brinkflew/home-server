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
# IT IS NOT ABOUT ONE JOB. Exactly two of upskald's eleven jobs declare a
# service container and they are exactly the two that fail; the other nine pass.
# A `services:` block has never once succeeded here under the real runner.
#
# TWELVE SYNTHETIC REPRODUCTIONS HAVE FAILED TO FIRE. Both service images;
# `run -d` against `create`+`start`; the driver's full flag set; a store reused
# across six container recycles; the faithful hosting with the systemd scope,
# --cgroups=split and the 3,584M cap; 1,662 VERIFIED MemoryHigh breaches of
# deliberate slice pressure; /tmp filled to 90%; and the user-namespace
# hypothesis taken apart three ways in one run - the pause pid file deleted, the
# pause process killed, and the whole runtime directory wiped, each between
# `create` and `start`. All of them started postgres cleanly.
#
# EVERY ONE OF THEM DROVE PODMAN FROM A SHELL, and that is now the leading
# suspect rather than a footnote: the same sequence driven by Runner.Worker
# fails in fifteen seconds, every time. `.github/workflows/lane-probe.yml` in
# avanserv/upskald is the one-minute trigger that finally made that cheap to
# test.
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

# PODMAN'S OWN STDERR IS KEPT, because the layer id that matters is only in it.
# The error names a LAYER, not the container - `overlay/<layerid>/merged/...` -
# and that id is what makes it possible to look at the one directory that failed
# instead of listing all twelve. Captured to a file and re-emitted rather than
# tee'd, because this is /bin/sh and process substitution is not available.
#
# It lives on $XDG_RUNTIME_DIR, the 128 MB private tmpfs, NOT on /tmp: /tmp is
# 1777 and shared with the job's own steps.
ERRF="${XDG_RUNTIME_DIR:-/tmp}/.docker-shim-err.$$"

# THE SAMPLES, AND WHY A SECOND FILE HAS TO EXIST. Everything the post-mortem
# reads is read AFTER podman has returned, and libpod unmounts the rootfs when
# the OCI runtime fails at start - so an empty `merged/`, one overlay mount in
# the pause namespace and a two-byte `mountpoints.json` are EXACTLY what a
# container that mounted perfectly and was then torn down looks like. Three of
# the five rows in the comparison table in docs/ci.md are that shape and none of
# them can discriminate; only the two gid rows survive the teardown. This file
# holds the same numbers taken WHILE the start is in flight, which is the one
# moment in this whole failure nobody has ever measured.
SAMPF="${XDG_RUNTIME_DIR:-/tmp}/.docker-shim-samples.$$"
trap 'rm -f "$ERRF" "$SAMPF"' EXIT

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

# THE LAYER, RESOLVED WITHOUT STARTING AN ENGINE. `podman inspect` would answer
# this in one call and would also be a twenty-first engine start, on the hot path
# of every job rather than after a failure. containers.json is one compact JSON
# array, so splitting it on `{` puts each record on its own line and a
# container's id and its layer are then on the SAME line - one `tr`, one `grep`,
# one `sed`, no lock taken and nothing written.
#
# It can legitimately come back empty: the runner passes a full 64-character id,
# but a `docker start` by NAME would not match. The sampler then says
# `layer=unresolved` and keeps the two namespace-wide counters, which are the
# two that carry the argument anyway.
sample_layer() {
	[ -n "${1:-}" ] || return 0
	tr '{' '\n' 2>/dev/null < "$S/overlay-containers/containers.json" |
		grep -F "\"id\":\"$1\"" |
		sed -n 's/.*"layer":"\([0-9a-f]\{64\}\)".*/\1/p' | head -1
}

# ONE SAMPLE EVERY ~100ms FOR AS LONG AS `podman start` RUNS, AND NOTHING ELSE.
#
# WHAT IT IS FOR. podman logs `Mounted container ... at .../merged` and `Created
# root filesystem`, and then crun cannot open a file underneath that path. Either
# the mount was real and something tore it down, or containers/storage returned a
# mountpoint it never made - and after libpod's cleanup those two are
# indistinguishable, which is why twelve reproductions and four forensic captures
# have not separated them. `mounts` going 1 -> 2 and `mp` growing says the mount
# happened; neither of them ever moving says it did not.
#
# IT IS READ-ONLY AND STARTS NO ENGINE: two file reads, one readdir, and the
# clock taken from /proc/uptime with the shell's own `read`, which costs no fork.
# The one line that touches the layer at all is the readdir of `merged/`, so if
# this ever appears to change how often the failure fires, that is the first line
# to drop.
sample_one() {
	read -r sm_up _ < /proc/uptime 2>/dev/null || sm_up=0
	sm_f=${sm_up#*.}
	sm_f=${sm_f#0}
	printf 't=%sms mounts=%s mp=%s merged=%s\n' \
		"$((($((${sm_up%.*} * 100 + ${sm_f:-0})) - sm_t0) * 10))" \
		"$(grep -c ' overlay ' "$sm_mi" 2>/dev/null || echo '?')" \
		"$(if [ -f "$sm_mp" ]; then wc -c < "$sm_mp"; else echo absent; fi)" \
		"$(if [ -n "$sm_merged" ]; then find "$sm_merged" -maxdepth 1 -mindepth 1 2>/dev/null | wc -l; else echo -; fi)" \
		2>/dev/null >> "$SAMPF"
}

# THE 600-SAMPLE CEILING IS A MINUTE. A `docker start` that has not returned by
# then is a different bug, and this must not grow a file on a 128 MB tmpfs for
# ever while it happens.
sample_loop() {
	sm_i=0
	while [ "$sm_i" -lt 600 ]; do
		sleep 0.1
		sample_one
		sm_i=$((sm_i + 1))
	done
}

# THE SETUP RUNS IN THE FOREGROUND, AND THE FIRST VERSION DID IT IN THE
# BACKGROUND AND THEREFORE MEASURED NOTHING. Resolving the pause pid and the
# layer is four forks; a failing `docker start` returns in about 230ms and the
# stub this was tested against returns in five, so a sampler that resolves its
# own paths only after being backgrounded loses the race and is killed before it
# writes a single line. Doing it here costs every `docker start` those four forks
# - against a call that takes hundreds of milliseconds - and buys two things: the
# sampler starts sampling the instant it is backgrounded, and the `t=0` line is a
# reading taken BEFORE podman was invoked at all, which is the baseline every
# later sample is read against.
#
# THE SUBSHELL IS EXPLICIT, AND `trap - EXIT` INSIDE IT IS THE POINT. The EXIT
# trap at the top of this file deletes $SAMPF; a backgrounded subshell that
# inherited it would delete the samples the moment sample_end kills it, which is
# the one file this whole change exists to produce.
sample_begin() {
	sm_pause=$(cat "${XDG_RUNTIME_DIR:-/run/podman-run}/libpod/tmp/pause.pid" 2>/dev/null)
	sm_mi="/proc/${sm_pause:-self}/mountinfo"
	sm_mp="${XDG_RUNTIME_DIR:-/run/podman-run}/containers/overlay-layers/mountpoints.json"
	sm_layer=$(sample_layer "${1:-}")
	sm_merged=
	[ -n "$sm_layer" ] &&
		sm_merged="/proc/${sm_pause:-self}/root$S/overlay/$sm_layer/merged"

	# CENTISECONDS BY STRING SURGERY, because `$((08))` is an ERROR in this
	# shell - "value too great for base" - and a hundredth of a second spelled
	# `.08` arrives here twice a second. Stripping one leading zero is the whole
	# fix, and `${x:-0}` covers `.00`.
	read -r sm_up _ < /proc/uptime 2>/dev/null || sm_up=0
	sm_f=${sm_up#*.}
	sm_f=${sm_f#0}
	sm_t0=$((${sm_up%.*} * 100 + ${sm_f:-0}))

	# TRUNCATING, NOT APPENDING: every attempt gets its own file, so the
	# post-mortem printed after retry 2 shows retry 2 and not all three at once.
	#
	# `2>/dev/null` BEFORE the redirect, not after, and it is the same lesson as
	# the tee at the bottom of this file: redirections apply LEFT TO RIGHT, so
	# stderr has to be sent away before the failing `>` is attempted or the
	# shell prints "No such file or directory" into a job log. Measured on a
	# container started without runner-init, where $XDG_RUNTIME_DIR does not
	# exist: two lines per attempt, six per failure. The post-mortem already
	# reports the absence of samples in words, so this is quiet by design and
	# not silent by accident.
	echo "#pause=${sm_pause:-none} layer=${sm_layer:-unresolved}" 2>/dev/null > "$SAMPF"
	sample_one
	(
		trap - EXIT
		sample_loop
	) &
	sm_pid=$!
}

# CALLED ONLY AFTER `rc=$?` HAS BEEN CAPTURED, so it cannot reach podman's exit
# code - and it returns 0 explicitly, because `wait` on a process this function
# has just killed reports 128+SIGTERM and that must not become the shim's answer.
sample_end() {
	[ -n "${sm_pid:-}" ] || return 0
	kill "$sm_pid" 2>/dev/null
	wait "$sm_pid" 2>/dev/null
	sm_pid=
	return 0
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
		# READ THROUGH THE PAUSE PROCESS, AND THE FIRST VERSION OF THIS DID NOT.
		# Rootless podman performs every storage operation inside the PAUSE
		# process's mount namespace - that is what the pause process is for, since
		# a mount made in a transient namespace would vanish when the CLI exited
		# and a detached container's rootfs would go with it. This block used to
		# read /proc/self/mountinfo and `ls -A merged` from the shim's own shell,
		# which is NOT that namespace.
		#
		# MEASURED ON A HEALTHY, RUNNING POSTGRES: `overlay mounts shim-ns=1
		# pause-ns=2`, `merged entries shim-ns=0 pause-ns=18`. So the readings
		# this file reported as "the mount never happened" - overlay-mounts=1 and
		# every merged/ empty - are exactly what a container that is working
		# perfectly looks like from here. That conclusion was an artefact and is
		# corrected in docs/ci.md rather than quietly dropped.
		#
		# BOTH NUMBERS ARE PRINTED, LABELLED, for the same reason: the old reading
		# is in the record and a reader has to be able to see why it said 1.
		# /proc/<pid>/root resolves a path in that process's mount namespace and
		# needs no privilege beyond the same uid.
		pm_pause=$(cat "${XDG_RUNTIME_DIR:-/run/podman-run}/libpod/tmp/pause.pid" 2>/dev/null)
		pm_ns="/proc/${pm_pause:-self}/root"
		[ -n "$pm_pause" ] && [ -d "/proc/$pm_pause" ] || pm_ns=""
		echo "  pause pid=${pm_pause:-none} alive=$([ -n "$pm_pause" ] && [ -d "/proc/$pm_pause" ] && echo yes || echo NO)"

		# THE ONLY READING IN THIS WHOLE BLOCK NOT TAKEN AFTER THE TEARDOWN.
		# Everything above and below runs once podman has already returned and
		# libpod has already unmounted, so it describes a cleaned store rather
		# than a broken one. These lines were taken every ~100ms while the start
		# was in flight. See sample_one() for what each field is.
		#
		# HOW TO READ IT. `mounts` is overlay mounts in the PAUSE namespace, and
		# a healthy start takes it from 1 to 2. `mp` is the size of the file
		# containers/storage uses to decide a layer is already mounted, and a
		# healthy start takes it from `absent` or 2 bytes to about 198. If both
		# move and the start still fails, the mount was real and something tore
		# it down; if neither ever moves, containers/storage returned a
		# mountpoint it never made. Those are different bugs, and until this
		# block existed nothing here could tell them apart.
		#
		# TRANSITIONS ONLY. A 200ms start is four identical samples and what a
		# reader needs is the changes, not the polling rate - but the runs are
		# counted rather than dropped, because "it sat at 1 for 40 samples" and
		# "it was only ever sampled once" are not the same measurement.
		echo "--- taken DURING the start, one sample per ~100ms ---"
		if [ -s "$SAMPF" ]; then
			pm_prev=
			pm_dup=0
			pm_last=
			while read -r pm_line; do
				case "$pm_line" in
				\#*)
					echo "  ${pm_line#\#}"
					continue
					;;
				esac
				pm_key=${pm_line#* }
				if [ "$pm_key" = "$pm_prev" ]; then
					pm_dup=$((pm_dup + 1))
					pm_last=${pm_line%% *}
					continue
				fi
				if [ "$pm_dup" -gt 0 ]; then
					echo "    ... $pm_dup more identical, through $pm_last"
				fi
				echo "  $pm_line"
				pm_prev=$pm_key
				pm_dup=0
			done < "$SAMPF"
			if [ "$pm_dup" -gt 0 ]; then
				echo "    ... $pm_dup more identical, through $pm_last"
			fi
		else
			echo "  (no samples - this start was not sampled, or the sampler wrote nothing)"
		fi

		pm_n=0
		pm_empty=0
		for pm_d in "$S"/overlay/*/; do
			pm_b=$(basename "$pm_d")
			case "$pm_b" in l | tempdirs) continue ;; esac
			pm_n=$((pm_n + 1))
			[ -d "$pm_d/merged" ] || echo "  NO merged/: $pm_b"
			# Counted rather than listed now. Twelve lines saying "empty" was the
			# bulk of this block and, read from the wrong namespace, all twelve
			# were meaningless.
			if [ -n "$pm_ns" ] && [ -d "$pm_ns$pm_d/merged" ] &&
				[ -z "$(ls -A "$pm_ns$pm_d/merged" 2>/dev/null)" ]; then
				pm_empty=$((pm_empty + 1))
			fi
		done
		echo "  layers=$pm_n  empty merged/ in the pause ns=$pm_empty"
		echo "  overlay mounts: shim-ns=$(grep -c ' overlay ' /proc/self/mountinfo 2>/dev/null) pause-ns=$(grep -c ' overlay ' "/proc/${pm_pause:-self}/mountinfo" 2>/dev/null)"
		echo "  (a HEALTHY container reads shim-ns=1 pause-ns=2 - only the second number means anything)"

		# THE ONE LAYER THAT MATTERS, named by podman's own error rather than
		# guessed. `merged/` being empty says the rootfs is not there; what this
		# distinguishes is WHY - a layer that was never assembled has no `diff`
		# or `link` either, while a layer that was assembled and simply never
		# mounted has all of them and an empty `merged/`. Those are different
		# bugs and the error message cannot tell them apart.
		pm_layer=$(sed -n 's#.*/overlay/\([0-9a-f]\{64\}\)/merged.*#\1#p' "$ERRF" 2>/dev/null | head -1)
		# HAS CLEANUP ALREADY RUN? libpod unmounts the rootfs when the OCI runtime
		# fails at start, so everything above is read AFTER the teardown and
		# cannot by itself distinguish "never mounted" from "mounted, failed,
		# unmounted". This is the line that says which, and it is why the
		# conclusion is no longer stated as fact.
		echo "  container state: $(/usr/bin/podman inspect "${2:-}" --format 'status={{.State.Status}} exit={{.State.ExitCode}} err={{.State.Error}}' 2>&1 | cut -c1-120)"

		if [ -n "$pm_layer" ]; then
			echo "--- the layer the error names: $pm_layer ---"
			echo "  merged in the pause ns: $(find "$pm_ns$S/overlay/$pm_layer/merged" -maxdepth 1 -mindepth 1 2>/dev/null | wc -l) entries"
			# shellcheck disable=SC2012  # the point is the mode and size columns, which `find` does not give as legibly
			ls -la "$S/overlay/$pm_layer" 2>&1 | sed 's/^/  /' | head -12
			# THE ONE ASYMMETRY ANYBODY HAS EVER MEASURED BETWEEN A FAILING
			# START AND A WORKING ONE, and the only row in the docs/ci.md table
			# that survives libpod's teardown and is therefore a fair
			# comparison at all. Measured on 2026-08-26, a failing start and a
			# control started by hand on a healthy lane thirty seconds apart:
			#
			#   failing   merged gid=65535  work gid=65535
			#   healthy   merged gid=0      work gid=0
			#
			# and every one of the eleven other layers in that healthy store
			# read gid 0 as well.
			#
			# THE READING BELOW WAS RIGHT AND THE INTERPRETATION UNDER IT WAS
			# WRONG, because it quoted the wrong namespace's map. It said the
			# nested engine's gid map is `0 1000 1` / `1 100000 65536`, so
			# 65535 is "inside the mapped range and a real gid that something
			# chose". Those two lines are the LANE's own map - /proc/self/gid_map
			# in a lane reads exactly that, measured 2026-08-27. The nested
			# engine runs as `runner`, uid 1000 with PRIMARY GID 0, and
			# /etc/subgid gives it `runner:1:999` and `runner:1001:64535`, so
			# its map - read off the pause process, which is what holds that
			# namespace - is:
			#
			#   0     0     1
			#   1     1     999
			#   1000  1001  64535      nested 1000..65534 -> lane 1001..65535
			#
			# SO LANE GID 65535 IS THE CEILING OF THAT MAP, and it is what
			# nested gid 65534 maps onto - which is the nested namespace's own
			# overflowgid. The line below prints the LANE's overflowgid, 65534,
			# and ruling overflow out on that basis is one namespace too high.
			# The question is not what chose 65535; it is which chown targeted
			# a gid the nested map does not contain.
			#
			# BOTH MAPS ARE PRINTED, LABELLED, for the same reason the two
			# mount-namespace numbers are: the old reading is in the record and
			# a reader has to be able to see why it said what it said.
			echo "  merged gid=$(stat -c %g "$S/overlay/$pm_layer/merged" 2>/dev/null || echo '?') work gid=$(stat -c %g "$S/overlay/$pm_layer/work" 2>/dev/null || echo '?')"
			echo "  (a HEALTHY layer reads gid=0 for both; the LANE's overflowgid is $(cat /proc/sys/kernel/overflowgid 2>/dev/null || echo '?'))"
			echo "  nested gid map, off the pause process that holds that namespace:"
			sed 's/^/    /' "/proc/${pm_pause:-self}/gid_map" 2>/dev/null ||
				echo "    (unreadable)"
			echo "  this shell's own map, which is the LANE's and is NOT the one above:"
			sed 's/^/    /' /proc/self/gid_map 2>/dev/null || echo "    (unreadable)"
			echo "  subgid: $(grep -E "^($(id -un 2>/dev/null)|$(id -u)):" /etc/subgid 2>/dev/null | tr '\n' ' ')"
			echo "  lower: $(cut -c1-120 "$S/overlay/$pm_layer/lower" 2>/dev/null || echo '(no lower file)')"
			echo "  link:  $(cat "$S/overlay/$pm_layer/link" 2>/dev/null || echo '(no link file)')"
			echo "  in layers.json: $(grep -c "$pm_layer" "$S/overlay-layers/layers.json" 2>/dev/null)"
			echo "  in containers.json: $(grep -c "$pm_layer" "$S/overlay-containers/containers.json" 2>/dev/null)"
			echo "  GraphDriver for the container being started:"
			/usr/bin/podman inspect "${2:-}" \
				--format '    Lower={{.GraphDriver.Data.LowerDir}}{{println}}    Upper={{.GraphDriver.Data.UpperDir}}{{println}}    Merged={{.GraphDriver.Data.MergedDir}}' 2>&1 |
				cut -c1-200
		else
			echo "  (podman's stderr named no layer id, so nothing layer-specific was read)"
		fi

		# WHO ELSE WAS TOUCHING THE STORE. A lane runs three libpod consumers over
		# one store - the long-lived `podman system service`, the healthcheck
		# loop's CLI every two seconds, and this shim - and no reproduction has
		# ever varied that. If a second engine is mid-call at the instant a mount
		# does not happen, this is where it shows.
		echo "--- other podman processes at this instant ---"
		# shellcheck disable=SC2009  # pgrep cannot give ppid, elapsed time and argv in one pass, which is the whole point
		ps -eo pid,ppid,etimes,args 2>/dev/null |
			grep -E 'podman|conmon|catatonit|healthcheck' | grep -v grep |
			cut -c1-140 | sed 's/^/  /' | head -8

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
	# TO STDERR *AND* TO A FILE UNDER $HOME, AND THE FILE IS THE HALF THAT LASTS.
	# stderr goes to a job log on GitHub, which is where every previous
	# post-mortem went and where none of them can be read against the next one -
	# they expire, and nothing on this host has them at all. $HOME is a bind
	# mount of the lane's persistent tree, so a copy there outlives the container
	# by design, and bin/github-runner.sh folds it into the forensic capture it
	# takes before healing the lane.
	#
	# THAT IS THE POINT: the capture is taken 21 seconds later and is
	# POST-CLEANUP by construction - libpod unmounts on a failed start and the
	# runner then `docker rm --force`s the container, so the store metadata in it
	# is byte-for-byte the shape of a healthy one, measured. This block is the
	# only evidence taken at the instant of failure, and until now it was the
	# only one not in the capture.
	#
	# `|| true` on the tee's target and no test of its result: an unwritable
	# $HOME must not change what this script returns, and the contract at the top
	# of the file is that podman's exit code arrives untouched.
	#
	# THE ORDER OF THESE TWO REDIRECTIONS IS THE WHOLE THING, and it was wrong
	# from the moment the tee was added. Redirections are applied LEFT TO RIGHT,
	# so `2>/dev/null >&2` points tee's stderr at /dev/null and then points its
	# stdout at whatever fd 2 now is - which is /dev/null. The post-mortem
	# therefore reached the persistent file and NOTHING ELSE: measured
	# 2026-08-27 against the two lane failures of 2026-08-26, which carry three
	# post-mortem groups each in
	# cache/github-runner/forensics/lane2-.../postmortem.log and ZERO in the job
	# logs GitHub kept. The `--log-level=debug` block, which is echoed directly,
	# was there both times - which is exactly why nobody noticed the other one
	# was missing.
	#
	# `>&2 2>/dev/null` is the same two redirections in the order that means
	# what the comment above says: tee's stdout to the real stderr, tee's own
	# complaints to /dev/null. Third defect in this one line; see the two
	# commits that precede it.
	} 2>&1 | tee -a "${HOME:-/tmp}/.docker-shim-postmortem.log" >&2 2>/dev/null || true
}

# BEFORE the call, so it cannot disturb $?, and only for the two verbs that
# create and mount a rootfs. stderr only - stdout is the runner's.
case "${1:-}" in
create | start) echo "home-server lane: engine-fp $1 $(fingerprint)" >&2 ;;
esac

# STDOUT IS INHERITED IN BOTH BRANCHES - only stderr is diverted, and only for
# `start`. Every other verb keeps the original two-line behaviour exactly.
if [ "${1:-}" = start ]; then
	sample_begin "${2:-}"
	/usr/bin/podman "$@" 2>"$ERRF"
	rc=$?
	sample_end
	cat "$ERRF" >&2
else
	/usr/bin/podman "$@"
	rc=$?
fi

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

	# THE FIRST RETRY IS THE LOUD ONE, and only the first. Everything above
	# describes the aftermath of a mount that did not happen; this is podman
	# saying what it decided to do, which no post-mortem can reconstruct. Debug
	# output goes to STDERR only, so stdout stays inherited and unpolluted -
	# safe for the same measured reason the retry itself is safe: a failing
	# `podman start` writes zero bytes to stdout.
	#
	# Retries two and three stay quiet. One verbose block per genuine failure,
	# none at all on a healthy job.
	if [ "$try" = 1 ]; then
		echo "::group::home-server lane: podman --log-level=debug, retry 1" >&2
		sample_begin "${2:-}"
		/usr/bin/podman --log-level=debug "$@" 2>"$ERRF"
		rc=$?
		sample_end
		cat "$ERRF" >&2
		echo "::endgroup::" >&2
	else
		sample_begin "${2:-}"
		/usr/bin/podman "$@" 2>"$ERRF"
		rc=$?
		sample_end
		cat "$ERRF" >&2
	fi
	if [ "$rc" -eq 0 ]; then
		echo "home-server lane: retry $try succeeded. The first attempt's post-mortem is" >&2
		echo "  above and is worth reading - this path exists because the cause is" >&2
		echo "  still unknown. See docs/ci.md." >&2
		exit 0
	fi
	postmortem "$rc" "$@"
done

# THE ONLY CHANNEL OUT OF HERE THAT OUTLIVES THE CONTAINER. This process runs
# inside an ephemeral lane whose stdout belongs to a job log the driver never
# reads and whose filesystem is gone seconds from now - except for $HOME, which
# is a bind mount of the lane's persistent tree. So a lane that has failed the
# way this whole file exists to witness says so by leaving a file behind, and
# bin/github-runner.sh reads it at the top of the next cycle, keeps the store's
# metadata, and resets the lane.
#
# WHY THE DRIVER AND NOT HERE. A reset has to happen when no job is running, and
# the only process that knows that is the one that starts them. This one is
# inside a container that is mid-job by definition.
#
# IT MUST NOT BE ABLE TO CHANGE ANYTHING THIS SCRIPT RETURNS. `>&2` on the
# failure note, `|| true` so an unwritable $HOME cannot alter the exit status,
# and `exit "$rc"` reading a value captured before any of this - the contract at
# the top of this file is that podman's exit code arrives untouched and that
# stdout is never written to, because DockerCommandManager.cs parses container
# ids off it.
if [ -n "${HOME:-}" ] && [ -d "$HOME" ]; then
	: > "$HOME/.docker-shim-start-failed" 2>/dev/null || true
	echo "home-server lane: left .docker-shim-start-failed in \$HOME - the driver will" >&2
	echo "  capture this store's metadata and reset the lane before its next job." >&2
fi

echo "home-server lane: 'docker start' still failing after $RETRIES retries; giving" >&2
echo "  the job podman's own exit code, $rc." >&2
exit "$rc"
