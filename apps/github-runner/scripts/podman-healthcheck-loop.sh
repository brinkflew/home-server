#!/bin/sh
# ==============================================================================
# The timer podman cannot create in here, written out by hand
# ------------------------------------------------------------------------------
# PODMAN DRIVES HEALTHCHECKS WITH TRANSIENT SYSTEMD TIMERS. On the host that is
# visible: `systemctl --user list-timers` shows one hash-named timer per
# healthchecked container, twenty-five of them, firing at the intervals their
# quadlets declare. There is no systemd session inside this container, so
# `podman create --health-cmd` only WARNS, the service starts and genuinely
# serves, and .State.Health.Status stays `starting` for ever.
#
# THAT IS NOT A COSMETIC DEFECT, because of what reads it. GitHub's runner waits
# on exactly that field before it will run a job's steps, in a loop with NO RETRY
# CAP - it exits only when the status changes. upskald sets `timeout-minutes:` on
# none of its jobs, so the default 360 minutes applies: one pull request would
# hold a lane for six hours while every signal on this host read green, because
# the container IS running and the service IS serving.
#
# So this loop does what the timer would: `podman healthcheck run` per container,
# at the interval that container declared. podman's own retry, start-period and
# failing-streak logic all live inside that subcommand, so this file decides WHEN
# and nothing else.
#
# THE INTERVAL IS HONOURED RATHER THAN GUESSED, and the direction of the guess is
# the whole reason. A workflow's `--health-retries 5 --health-interval 10s` means
# postgres has fifty seconds to come up. Polling every second instead would spend
# those five retries in five seconds and mark a perfectly healthy database
# `unhealthy` before it had finished starting - and the runner FAILS a job on
# unhealthy. So an interval that cannot be parsed falls back to THIRTY seconds,
# not to one: too long merely makes a job wait, too short fails it.
#
# See: apps/github-runner/scripts/runner-init.sh, bin/github-runner-smoke.sh
# ==============================================================================

set -u

STATE="${HC_LOOP_STATE:-/tmp/hc-state}"
SWEEP="${HC_LOOP_SWEEP:-2}"
FALLBACK=30

mkdir -p "$STATE" 2>/dev/null || exit 1

# A Go time.Duration renders as "10s" or "1m30s" through a template, and as a
# bare nanosecond count if the field is ever a plain integer. Both spellings are
# handled here rather than assumed, because getting it wrong in the short
# direction is the failure this whole file exists to avoid.
parse_interval() {
	awk -v raw="$1" -v fb="$FALLBACK" '
		BEGIN {
			if (raw ~ /^[0-9]+$/) {
				# A bare number is nanoseconds. Anything under a million of
				# them is not an interval anybody wrote, so treat it as junk.
				n = raw + 0
				if (n >= 1000000) { printf "%d\n", int(n / 1000000000); exit }
				print fb; exit
			}
			total = 0; seen = 0; s = raw
			while (match(s, /^[0-9]+(\.[0-9]+)?[a-z]+/)) {
				chunk = substr(s, RSTART, RLENGTH)
				num = chunk + 0
				unit = chunk
				sub(/^[0-9]+(\.[0-9]+)?/, "", unit)
				if      (unit == "h")  { total += num * 3600; seen = 1 }
				else if (unit == "m")  { total += num * 60;   seen = 1 }
				else if (unit == "s")  { total += num;        seen = 1 }
				else if (unit == "ms") { total += num / 1000; seen = 1 }
				else if (unit == "us" || unit == "ns") { seen = 1 }
				s = substr(s, RSTART + RLENGTH)
			}
			if (!seen || total < 1) { print fb; exit }
			printf "%d\n", int(total)
		}'
}

while :; do
	now=$(date +%s)

	for c in $(podman ps -q 2>/dev/null); do
		ivf="$STATE/$c.iv"

		# The interval cannot change while the container lives, so it is read
		# once. Two podman invocations per container per sweep would be the
		# expensive half of this loop, inside a cgroup that gets two cores.
		if [ ! -f "$ivf" ]; then
			raw=$(podman inspect --format \
				'{{if .Config.Healthcheck}}{{.Config.Healthcheck.Interval}}{{end}}' \
				"$c" 2>/dev/null)
			if [ -z "$raw" ]; then
				# No healthcheck. Record the fact so it is not asked again.
				echo none > "$ivf"
			else
				parse_interval "$raw" > "$ivf"
			fi
		fi

		iv=$(cat "$ivf" 2>/dev/null)
		[ "$iv" = none ] && continue
		case "$iv" in ''|*[!0-9]*) iv=$FALLBACK ;; esac

		last=0
		[ -f "$STATE/$c.at" ] && last=$(cat "$STATE/$c.at" 2>/dev/null)
		case "$last" in ''|*[!0-9]*) last=0 ;; esac

		if [ "$(( now - last ))" -ge "$iv" ]; then
			podman healthcheck run "$c" >/dev/null 2>&1 || :
			echo "$now" > "$STATE/$c.at"
		fi
	done

	# A container that is gone leaves two files behind. They are tiny and the
	# lane is thrown away after one job, so they are swept only to keep a long
	# job's state directory from growing an entry per service restart.
	for f in "$STATE"/*.at; do
		[ -e "$f" ] || continue
		id=$(basename "$f" .at)
		podman container exists "$id" 2>/dev/null || rm -f "$STATE/$id.at" "$STATE/$id.iv"
	done

	sleep "$SWEEP"
done
