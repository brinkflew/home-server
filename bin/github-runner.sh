#!/usr/bin/env bash
# ==============================================================================
# One CI lane: mint an identity, run exactly one job in a container, repeat
# ------------------------------------------------------------------------------
# Started by host/systemd/home-server-github-runner@<lane>.service, one process
# per lane, for as long as the lane is enabled. Everything a job can see is
# inside apps/github-runner/Dockerfile; everything it cannot is decided here.
#
# THE PAT NEVER ENTERS THE CONTAINER, and that is the point of the whole shape.
# This script holds a fine-grained token that can register runners on the
# organisation. It uses it to mint a JUST-IN-TIME configuration - single use,
# one job, that organisation - and hands the container only that. A workflow step
# can read its own JIT credential off disk, which is true of every self-hosted
# runner in existence and is bounded by what the credential can do; it cannot
# read the thing that mints more of them.
#
# EVEN THE HEADER STAYS OUT OF argv. `-H "Authorization: Bearer $PAT"` puts the
# token in /proc/<pid>/cmdline, readable by anything on this host running as
# `core`. It goes to curl over STDIN instead, the same idiom
# bin/sync-podman-secrets.sh uses for the model credential and for the same
# reason.
#
# THE LOOP IS HERE RATHER THAN IN Restart=, AND THAT IS DELIBERATE. A finished
# job is a process exit, so letting systemd do the cycling would make a completed
# job and a crash indistinguishable - StartLimitBurst would count successful work
# and a busy afternoon would put the lane in `failed` for having done its job.
# With the loop here, a non-zero exit from this script means something a restart
# cannot fix, and the unit comes to rest in `failed` where ci.lanes_alive reports
# it. See host/systemd/home-server-github-runner@.service.
#
# SO FAILURES ARE CLASSIFIED RATHER THAN RETRIED UNIFORMLY:
#
#   exit 2  the lane argument is not a lane
#   exit 3  configuration is missing or empty
#   exit 4  the image does not exist
#   exit 5  GitHub rejected the credential (401/403) - a rollout or a revocation
#   exit 6  GitHub rejected the request (422) - a bad group id or bad labels
#   loop    429, 5xx, DNS, a timeout - anything a later attempt could survive
#
# The middle four are states, not events: retrying them is how a lane spins for
# ever minting registrations against a rate limit. An unset token must not look
# like a fault and a revoked one must not look like health - docs/agents.md makes
# the same distinction for conduct's own token.
#
# See: docs/ci.md, apps/github-runner/Dockerfile, bin/github-runner-smoke.sh
# ==============================================================================

# NO `set -e`. A loop that exits on any failure is a crash loop wearing a
# different hat, and every failure worth exiting on is classified above.
set -uo pipefail

readonly API="https://api.github.com"
readonly IMAGE="localhost/home-server/github-runner:latest"

log() { printf 'github-runner[%s]: %s\n' "${LANE:-?}" "$1"; }
die() { log "$2"; exit "$1"; }

# ------------------------------------------------------------------------------
# The lane, and the two numbers derived from it
# ------------------------------------------------------------------------------
LANE="${1:-}"
case "$LANE" in
	1|2) ;;
	'') die 2 "no lane number given - this unit is a template, start it as home-server-github-runner@1.service" ;;
	*)  die 2 "lane '$LANE' is not 1 or 2. host/systemd/app-ci.slice owns CPUs 4-7 and each lane takes half of them, so a third lane would have no cores of its own and would silently share another lane's pair - which is the nproc defect that slice's comment exists to prevent." ;;
esac

# HALF THE SLICE'S CPUSET, PER LANE, AND THIS IS NOT A TUNING KNOB.
# app-agents.slice records the measurement: a container is not CPU-namespaced, so
# `nproc` reads the host's 12 whatever the quota delivers, and vitest, esbuild,
# tsc and any `make -j$(nproc)` size their worker pools from it. Same suite, five
# runs: 340-364s with one SPURIOUS FAILURE at nproc=12, against 69-71s and green
# at nproc=4. Setting only the slice's 4-7 would give BOTH lanes nproc=4 and put
# eight workers on four cores - the same defect at half the magnitude. Pinned
# here, a job sees 2, which is what it will actually get.
#
# VERIFIED ON THIS HOST rather than assumed, because a scope property is a
# different question from a slice property:
#   systemd-run --user --scope -p AllowedCPUs=4-5 --quiet -- nproc   ->  2
LANE_CPUS="$(( 4 + (LANE - 1) * 2 ))-$(( 5 + (LANE - 1) * 2 ))"

# ------------------------------------------------------------------------------
# Configuration
# ------------------------------------------------------------------------------
CACHE_ROOT="${DOCKER_VOLUME_CACHE:-/var/home-server/cache}"
FLEET_ROOT="${GITHUB_RUNNER_ROOT:-$CACHE_ROOT/github-runner}"
LANE_ROOT="$FLEET_ROOT/lanes/$LANE"
NET="net-ci-$LANE"
MARKER="${HOME_SERVER_CI_STATE:-${HOME:-/var/home/core}/.cache/home-server/ci-state-$LANE}"
CONDUCT_STATE="${HOME_SERVER_CONDUCT_STATE:-${HOME:-/var/home/core}/.cache/home-server/conduct-state}"

LABELS="${GITHUB_RUNNER_LABELS:-self-hosted,Linux,X64,home-server}"
IDLE_SEC="${GITHUB_RUNNER_IDLE_SEC:-1800}"
LANE_MAX_MB="${GITHUB_RUNNER_LANE_MAX_MB:-20480}"

# HOW MANY JOBS A NESTED IMAGE STORE MAY LIVE FOR. Not a tuning knob and not a
# performance number - see the block above gc_lane for what it is bounding and
# why the honest word for it is "bound" rather than "fix". Zero disables it.
STORE_MAX_JOBS="${GITHUB_RUNNER_STORE_MAX_JOBS:-50}"

# Written by the docker shim inside the lane when a `docker start` has exhausted
# its retries, read here at the top of the next cycle. It is the only channel
# there is: the shim runs in an ephemeral container whose stdout belongs to a
# job log this process never sees.
HEAL_FLAG="home/.docker-shim-start-failed"

# THE ONLY EVIDENCE TAKEN AT THE INSTANT OF FAILURE. The shim tees its
# post-mortem here as well as to the job log, because the job log is on GitHub,
# expires, and cannot be read against the next occurrence - while the capture
# this driver takes 21 seconds later is POST-CLEANUP by construction and was
# measured to be byte-for-byte the shape of a healthy store.
HEAL_LOG="home/.docker-shim-postmortem.log"

# The transient scope's cgroup lives here. Same path bin/verify-host.sh builds
# for ci.slice_limits, and it is derived rather than written out because the
# `app-` prefix is what nests it under app.slice.
SCOPE_CG="/sys/fs/cgroup/user.slice/user-$(id -u).slice/user@$(id -u).service/app.slice/app-ci.slice"
RUNTIME_MAX_SEC="${GITHUB_RUNNER_RUNTIME_MAX_SEC:-5400}"
POLL_SEC="${GITHUB_RUNNER_POLL_SEC:-30}"

# ------------------------------------------------------------------------------
# State carried across cycles, seeded from the marker so a unit restart does not
# reset the day's counters
# ------------------------------------------------------------------------------
jobs_today=0
jobs_total=0
jobs_day=""
consecutive_failures=0
deregister_orphans=0
last_job_at=""
last_job_seconds=""
last_error=""
last_error_at=""
runner_version=""
lane_disk_mb=""
store_jobs=0
store_resets=0
last_reset_at=""
last_reset_reason=""

# WHAT A JOB ACTUALLY COST, kept as a high-water mark across every job this lane
# has ever run. host/systemd/app-ci.slice asks for exactly these numbers in its
# own comment, and names its failure mode as silence: a ceiling nothing measures
# is a ceiling nobody can tell is wrong.
lane_mem_peak_mb=""
lane_pids_peak=""
lane_mem_max_events=0
lane_oom_kills=0

# Per-cycle, and cleared by the trap
cname=""
scope=""
runner_id=""
job_mem_max_ev=0
job_oom_kills=0
jitfile="$LANE_ROOT/runner/.jitconfig"
stopping=0

marker_read() {
	local k v
	[ -f "$MARKER" ] || return 0
	while IFS='=' read -r k v; do
		case "$k" in
			jobs_today)           jobs_today="$v" ;;
			jobs_total)           jobs_total="$v" ;;
			jobs_day)             jobs_day="$v" ;;
			deregister_orphans)   deregister_orphans="$v" ;;
			last_job_at)          last_job_at="$v" ;;
			last_job_seconds)     last_job_seconds="$v" ;;
			store_jobs)           store_jobs="$v" ;;
			store_resets)         store_resets="$v" ;;
			last_reset_at)        last_reset_at="$v" ;;
			last_reset_reason)    last_reset_reason="$v" ;;
			lane_mem_peak_mb)     lane_mem_peak_mb="$v" ;;
			lane_pids_peak)       lane_pids_peak="$v" ;;
			lane_mem_max_events)  lane_mem_max_events="$v" ;;
			lane_oom_kills)       lane_oom_kills="$v" ;;
		esac
	done < "$MARKER"
	case "$jobs_today" in ''|*[!0-9]*) jobs_today=0 ;; esac
	case "$jobs_total" in ''|*[!0-9]*) jobs_total=0 ;; esac
	case "$deregister_orphans" in ''|*[!0-9]*) deregister_orphans=0 ;; esac
	case "$store_jobs" in ''|*[!0-9]*) store_jobs=0 ;; esac
	case "$store_resets" in ''|*[!0-9]*) store_resets=0 ;; esac
	case "$lane_mem_peak_mb" in *[!0-9]*) lane_mem_peak_mb="" ;; esac
	case "$lane_pids_peak" in *[!0-9]*) lane_pids_peak="" ;; esac
	case "$lane_mem_max_events" in ''|*[!0-9]*) lane_mem_max_events=0 ;; esac
	case "$lane_oom_kills" in ''|*[!0-9]*) lane_oom_kills=0 ;; esac
}

# OMITTED IS NOT ZERO. A key with no value is left out entirely rather than
# written empty, because bin/collect-metrics.py drops a sample that does not
# parse and an empty one reads as a measured zero. Same contract as conduct's
# marker; see docs/agents.md.
#
# Written whole, tmp + rename, because the collector reads this every 30 seconds
# and the battery hourly, and a half-written file is a parse error in both.
marker_write() {
	local job_in_flight="$1" job_started_at="${2:-}"
	local tmp="$MARKER.tmp.$$"
	mkdir -p "$(dirname "$MARKER")" 2>/dev/null
	{
		printf 'consecutive_failures=%s\n' "$consecutive_failures"
		[ -n "$deregister_orphans" ] && printf 'deregister_orphans=%s\n' "$deregister_orphans"
		printf 'heartbeat_at=%s\n' "$(now_iso)"
		printf 'job_in_flight=%s\n' "$job_in_flight"
		[ -n "$job_started_at" ] && printf 'job_started_at=%s\n' "$job_started_at"
		[ -n "$jobs_day" ] && printf 'jobs_day=%s\n' "$jobs_day"
		printf 'jobs_today=%s\n' "$jobs_today"
		printf 'jobs_total=%s\n' "$jobs_total"
		printf 'lane=%s\n' "$LANE"
		[ -n "$lane_disk_mb" ] && printf 'lane_disk_mb=%s\n' "$lane_disk_mb"
		printf 'lane_mem_max_events=%s\n' "$lane_mem_max_events"
		[ -n "$lane_mem_peak_mb" ] && printf 'lane_mem_peak_mb=%s\n' "$lane_mem_peak_mb"
		printf 'lane_oom_kills=%s\n' "$lane_oom_kills"
		[ -n "$lane_pids_peak" ] && printf 'lane_pids_peak=%s\n' "$lane_pids_peak"
		[ -n "$last_error" ] && printf 'last_error=%s\n' "$last_error"
		[ -n "$last_error_at" ] && printf 'last_error_at=%s\n' "$last_error_at"
		[ -n "$last_job_at" ] && printf 'last_job_at=%s\n' "$last_job_at"
		[ -n "$last_job_seconds" ] && printf 'last_job_seconds=%s\n' "$last_job_seconds"
		[ -n "$last_reset_at" ] && printf 'last_reset_at=%s\n' "$last_reset_at"
		[ -n "$last_reset_reason" ] && printf 'last_reset_reason=%s\n' "$last_reset_reason"
		[ -n "$runner_version" ] && printf 'runner_version=%s\n' "$runner_version"
		printf 'store_jobs=%s\n' "$store_jobs"
		printf 'store_resets=%s\n' "$store_resets"
	} > "$tmp" 2>/dev/null
	sync "$tmp" 2>/dev/null
	mv -f "$tmp" "$MARKER" 2>/dev/null
}

now_iso() { date -u +%Y-%m-%dT%H:%M:%SZ; }

# A marker value may not contain a newline, so an error is flattened and
# truncated rather than trusted. `last_error` exists so that a lane's problem is
# visible without reading the journal, not to reproduce the journal.
set_error() {
	last_error=$(printf '%s' "$1" | tr '\n\r' '  ' | cut -c1-160)
	last_error_at=$(now_iso)
}

# ------------------------------------------------------------------------------
# GitHub
# ------------------------------------------------------------------------------
# Emits the response body, then a final line holding the HTTP status. The token
# reaches curl on stdin and appears in no argument vector.
api() {
	local method="$1" path="$2" body="${3:-}"
	local -a args=(
		-sS -X "$method"
		-H "Accept: application/vnd.github+json"
		-H "X-GitHub-Api-Version: 2022-11-28"
		--max-time 30
		-w $'\n%{http_code}'
	)
	[ -n "$body" ] && args+=(-H "Content-Type: application/json" --data-binary "@$body")
	printf 'header = "Authorization: Bearer %s"\n' "$GITHUB_RUNNER_PAT" |
		curl "${args[@]}" --config - "$API$path" 2>/dev/null
}

http_status() { printf '%s' "$1" | tail -n1; }
http_body()   { printf '%s' "$1" | sed '$d'; }

# ------------------------------------------------------------------------------
# Preflight: everything that is a state rather than an event
# ------------------------------------------------------------------------------
preflight() {
	[ -n "${GITHUB_RUNNER_ORG:-}" ] ||
		die 3 "GITHUB_RUNNER_ORG is unset - add it to secrets/env.sops.env and run ./bin/render-env.sh"
	[ -n "${GITHUB_RUNNER_PAT:-}" ] ||
		die 3 "GITHUB_RUNNER_PAT is empty - a lane cannot mint an identity without it. See .env.sample; it is a fine-grained token on the organisation with Self-hosted runners: read and write, and nothing else."

	# REQUIRED, WITH NO DEFAULT, AND THAT IS A SECURITY DECISION RATHER THAN
	# PEDANTRY. Group 1 is the organisation's Default group, which every
	# repository can see - INCLUDING the three public ones. A self-hosted runner
	# reachable from a public repository executes fork pull-request code on this
	# host. Defaulting to 1 would make the safe configuration the one somebody
	# has to remember; refusing makes it the only one that starts.
	[ -n "${GITHUB_RUNNER_GROUP_ID:-}" ] ||
		die 3 "GITHUB_RUNNER_GROUP_ID is unset. There is deliberately no default: group 1 is the organisation's Default group, visible to every repository including the public ones, and a runner there runs fork pull-request code. Make a runner group scoped to selected private repositories and set its id. See docs/ci.md."

	podman image exists "$IMAGE" ||
		die 4 "$IMAGE does not exist. Nothing builds it on demand - no .container references it - so run 'systemctl --user start home-server-github-runner-build.service' once. See host/systemd/README.md."

	mkdir -p "$LANE_ROOT"/{home,toolcache,storage,runner,tmp} 2>/dev/null ||
		die 3 "cannot create $LANE_ROOT - check it exists and is owned by core"

	# THE OWNERSHIP IS NOT COSMETIC AND THE FAILURE NAMES NOTHING USEFUL.
	# These directories are created by `core`, so they are container uid 0 - and
	# the runner inside is uid 1000, deliberately, because a rootless nested
	# engine is what lets the outer container keep a read-only rootfs and a
	# narrow capability set. `podman unshare` enters the same user namespace
	# podman maps the container with, so chowning to 1000 there sets the
	# host-side owner to the subuid that container uid 1000 resolves to.
	#
	# MEASURED, on the first run of bin/github-runner-smoke.sh against a real
	# image, where its absence produced:
	#
	#   Error: creating runtime static files directory
	#   ".../containers/storage/libpod": mkdir /home/runner/.local: permission denied
	#
	# - which names a path nobody chose, in a component nobody edited, and reads
	# as a broken image rather than as a missing chown.
	#
	# IT RUNS EVERY PREFLIGHT RATHER THAN ONCE. It is idempotent, it costs a
	# fraction of a second against a tree the lane already owns, and the state it
	# repairs is exactly the state a hand-run `mkdir` or a restored backup
	# leaves behind.
	# THE SUBDIRECTORIES, NOT THE ROOT, AND THAT DISTINCTION IS THE WHOLE OF IT.
	# Chowning $LANE_ROOT itself hands the directory to the container's mapped
	# subuid - and takes it away from `core`, which is this script. The mint body
	# and the just-in-time configuration are both written by THIS process, so the
	# lane root has to stay ours. Measured on the first live lane: every mint
	# failed with "no response", because `jq > $LANE_ROOT/.mint.json` had been
	# refused and curl was posting a file that did not exist.
	# 1000:0 AND NOT 1000:1000, BECAUSE 0 IS WHAT THE CONTAINER ACTUALLY WRITES.
	# The runner's primary gid is 0 - `usermod -g 0` in the Dockerfile, so that
	# nested pasta can open a group-0 /dev/net/tun - so every file the lane
	# creates lands gid 0. Chowning to 1000 therefore does not restore a state
	# the container produces; it invents one. Measured on the host 2026-08-27:
	# `$LANE_ROOT/storage` was 100999:100999 while EVERY child of it was
	# 100999:core, which is lane-side `runner:runner` sitting on top of a tree of
	# `runner:root`. Harmless in itself - the runner owns them by uid - and
	# corrected here because the one asymmetry this failure has ever shown is an
	# ownership one, and a chown that writes a gid nothing else writes is not
	# something to leave in the frame while that is being investigated.
	#
	# AND `-R` ONLY ON A TREE THAT IS NOT ALREADY A STORE. This loop runs on
	# every driver start, and on `storage` that is a full recursive rewrite of
	# ownership across twenty-odd overlay layers whose files belong to a
	# NESTED namespace's ids - the only code in this repository that rewrites
	# gids inside a live nested store. It did not cause the failures of
	# 2026-08-26 (both lane drivers held their pids across the whole window), so
	# this is a hazard being removed rather than a fix. The non-recursive form
	# still repairs the case the loop exists for, which is a bind-mount source
	# `mkdir`ed by `core`.
	#
	# THE DISCRIMINATOR IS `overlay/`, NOT `db.sql`. The guard sixty lines below
	# DELETES db.sql when it records a stale runroot, and the overlay tree
	# survives that - so keying on db.sql would put a repaired lane through the
	# full recursive rewrite on its very next start, which is the one case this
	# is trying to avoid. `overlay/` exists exactly when containers/storage has
	# initialised the store.
	for d in home toolcache storage runner tmp; do
		if [ "$d" = storage ] && [ -d "$LANE_ROOT/storage/overlay" ]; then
			podman unshare chown 1000:0 "$LANE_ROOT/$d" 2>/dev/null ||
				die 3 "cannot chown $LANE_ROOT/$d into the container's user namespace - a lane cannot write its own store without it"
			continue
		fi
		podman unshare chown -R 1000:0 "$LANE_ROOT/$d" 2>/dev/null ||
			die 3 "cannot chown $LANE_ROOT/$d into the container's user namespace - a lane cannot write its own home without it"
	done

	# THE LANE'S NETWORK IS CREATED ONCE AND KEPT, unlike conduct's per-phase
	# ones. There is nothing per-job about it, and agents.runner_isolation's own
	# comment records that create-and-destroy at scale is a leak risk against a
	# subnet pool. isolate=true because netavark does NOT inherit Docker's
	# inter-bridge isolation - without it this bridge is fully routable to every
	# other one, which is the single edge this tier exists to prevent.
	if ! podman network exists "$NET" 2>/dev/null; then
		podman network create --opt isolate=true "$NET" >/dev/null 2>&1 ||
			die 3 "could not create the $NET network"
		log "created $NET (isolate=true)"
	fi

	# Seeded ONCE, not per image build. The runner updates itself - a
	# just-in-time configuration carries no disableUpdate and GitHub pushes the
	# new version the moment its minimum moves - so this tree legitimately runs
	# AHEAD of the image's seed, and re-seeding on every image bump would throw
	# that away and re-download it. ci.runner_version grades what is here, never
	# the image's ARG.
	# `cp -rp` AND NOT `cp -a`, which would carry the SELinux MCS categories of
	# whichever container did the seeding onto the lane's mount - after which the
	# NEXT container, with a different pair, cannot read the tree it was given.
	# Measured on the tool cache, where the symptom was `Permission denied` on a
	# directory plainly present and owned by the right uid. See
	# apps/github-runner/scripts/runner-init.sh.
	if [ ! -x "$LANE_ROOT/runner/run.sh" ]; then
		log "seeding the runner tree from $IMAGE"
		podman run --rm --label io.home-server.ephemeral \
			--network none --log-driver=none --no-healthcheck \
			--entrypoint /bin/sh \
			-v "$LANE_ROOT/runner:/seed:rw" \
			"$IMAGE" -c 'cp -rp /opt/actions-runner-seed/. /seed/' ||
			die 4 "could not seed the runner tree into $LANE_ROOT/runner"
	fi

	# THE STORE REMEMBERS A RUNTIME DIRECTORY THE IMAGE MAY NO LONGER USE.
	# libpod writes its runroot and tmpdir into `db.sql` at the root of the graph
	# root, and that graph root is a lane mount which outlives every image
	# upgrade. Podman does not error on the mismatch - it reads the recorded value
	# and uses it, over the environment AND over storage.conf - so the lane ends up
	# running two engines over one store: `pause.pid` under the environment's
	# directory and `alive`/`events`/`exits` under the database's. Reproduced on
	# demand; see docs/ci.md.
	#
	# THIS IS DONE HERE RATHER THAN ONLY IN runner-init BECAUSE OF `--log-driver=none`.
	# The lane container's stdout and stderr are discarded, so a repair announced
	# from inside it is a repair nobody can read - and this file's whole argument
	# for `die` over silence is that an invisible failure is the expensive kind.
	# runner-init keeps its own copy of the test as the backstop for a lane started
	# some other way; this is the one that reaches the journal.
	#
	# THE EXPECTED VALUE COMES FROM THE IMAGE, not from a constant here, so the two
	# cannot drift: whatever ENV the image ships is what its store must agree with.
	local store_db lane_xdg
	store_db="$LANE_ROOT/storage/db.sql"
	if [ -f "$store_db" ]; then
		lane_xdg=$(podman image inspect "$IMAGE" \
			--format '{{range .Config.Env}}{{println .}}{{end}}' 2>/dev/null |
			sed -n 's/^XDG_RUNTIME_DIR=//p' | head -1)
		if [ -z "$lane_xdg" ]; then
			log "WARNING: $IMAGE declares no XDG_RUNTIME_DIR, so the nested store's recorded runroot cannot be checked"
		elif ! grep -qF "$lane_xdg/containers" "$store_db" 2>/dev/null; then
			log "the nested store's libpod database predates $lane_xdg - removing it so podman cannot run two engines over one store (the image cache below it is kept)"
			podman unshare rm -f "$store_db" ||
				die 4 "could not remove the stale $store_db"
		fi
	fi

	runner_version=$(cat "$LANE_ROOT/runner/.seed-version" 2>/dev/null)
	[ -n "$runner_version" ] || runner_version="unknown"
}

# ------------------------------------------------------------------------------
# Holding the second lane while the agent fleet is working
# ------------------------------------------------------------------------------
# BUSY ONLY WHEN THE MARKER SAYS BUSY *AND* ITS HEARTBEAT IS FRESH. conduct
# killed mid-phase leaves phase_in_flight=1 behind for ever, and a stale flag
# that holds a lane indefinitely is a lane that silently stops taking work - the
# same reasoning, and the same 600-second window, bin/reboot-when-staged.sh uses.
#
# LANE 1 IS NEVER HELD. The point is to stop two CI lanes and a phase peaking
# together on a 15.8 GB host, not to stop CI. At a measured 6.9% phase duty cycle
# this costs almost nothing and CI never drops to zero.
phase_in_flight() {
	[ "$LANE" = 1 ] && return 1

	local flag hb hb_epoch age
	flag=$(sed -n 's/^phase_in_flight=//p' "$CONDUCT_STATE" 2>/dev/null | tail -1)
	[ "${flag:-0}" = 1 ] || return 1

	hb=$(sed -n 's/^heartbeat_at=//p' "$CONDUCT_STATE" 2>/dev/null | tail -1)
	[ -n "$hb" ] || return 1
	hb_epoch=$(date -d "$hb" +%s 2>/dev/null) || return 1
	age=$(( $(date +%s) - hb_epoch ))
	[ "$age" -le 600 ]
}

# ------------------------------------------------------------------------------
# The lane store: what resets it, and the evidence that outlives the reset
# ------------------------------------------------------------------------------
# THREE TRIGGERS, ONE BODY. Disk over budget, the shim asking to be healed, and
# a job counter. Only the first of those is about disk at all.
#
# WHAT THE OTHER TWO ARE FOR, STATED PLAINLY BECAUSE NEITHER IS A FIX. A
# `services:` block failed on this host for weeks: `docker create` fine,
# `docker start` returning 125, and crun unable to open anything under a rootfs
# podman's own debug had just reported mounting. It stopped when both lanes were
# wiped BY HAND and has not come back across the 39 and 40 jobs since. Nobody
# has identified what accumulates. It is not simply size or job count - it
# failed at 2.4 GB after 21 jobs and passes at 2.5 GB after 39 - so the window
# in which anything CAN accumulate is bounded instead, and the lane heals itself
# when the shim reports the failure is back. Neither of those explains it.
#
# THE EVIDENCE COMES FIRST AND THE ORDERING IS THE WHOLE OF IT. The last time
# this failure was in front of somebody the lanes were wiped without preserving
# them, and twelve reproductions have since failed to recreate the state that
# was thrown away. A reset firing on a job counter would do that again, on a
# timer, silently. So a reset that fires for a REASON captures the store's
# metadata before it removes anything.
#
# METADATA, NOT THE STORE. db.sql and the layer, container and image json -
# kilobytes, against the 2.5 GB a tar of the whole store would cost every time.
# Those are the files that would carry a stale runroot, an orphaned mount
# refcount or a container the store still believes in, which is the entire space
# of theories anyone has had.
#
# A ROUTINE WINDOW RESET CAPTURES NOTHING, deliberately: there is no anomaly to
# preserve, and keeping fifty of them would evict the two or three captures that
# would actually matter.
#
# `rm -rf` on the nested store rather than a prune against it: pruning from the
# host would take host-side locks and leave host-labelled files inside a tree
# the container owns, and a fresh graph root costs one re-pull of three small
# images. The caches are NOT in what is removed - home/.cache and home/.bun
# survive, and actions/cache lives on GitHub in any case.
FORENSIC_KEEP=5

lane_forensics() {
	local reason="$1" dest n stale
	dest="$FLEET_ROOT/forensics/lane$LANE-$(date -u +%Y%m%dT%H%M%SZ)-$reason"
	mkdir -p "$dest" 2>/dev/null || return 0

	# THROUGH `podman unshare`, because the store belongs to the subuid container
	# uid 1000 maps to and `core` cannot traverse it - the same reason the rm
	# below is unshared and the du above it had to be corrected. Inside the
	# namespace this runs as uid 0, which maps back to `core` outside, so what it
	# writes is readable afterwards without a second chown.
	# `cp`, NOT `cp -a`, AND THAT IS THE WHOLE OF WHY THIS CAPTURE IS READABLE.
	# Inside the namespace this runs as uid 0, which maps to `core` outside - but
	# `-a` preserves the SOURCE's owner and mode, so the copy lands outside the
	# namespace owned by the mapped subuid rather than by `core`. Measured on
	# lane 1: db.sql is 0644, and layers.json, containers.json and images.json
	# are all 0600 - so THREE OF THE FIVE would have been unreadable by the
	# person the capture exists for. That is the shape docs/known-state.md
	# records under "podman unshare writes as container root, and 0600 then locks
	# out the runner", and a forensic capture nobody can open is not a capture.
	#
	# mountpoints.json IS NOT IN THIS LIST, AND THE REASON IT USED TO BE WAS
	# WRONG. The comment here said it was "absent on an idle lane", and that its
	# absence was itself a reading. It is absent because containers/storage does
	# not keep it in the graph root at all: it lives in the RUNROOT, at
	# $XDG_RUNTIME_DIR/containers/overlay-layers/mountpoints.json, which is the
	# lane's own 128 MB tmpfs. Verified on a live lane 2026-08-27 - the runroot
	# holds its `mountpoints.lock`, the graph root holds neither file - so this
	# copy could never have succeeded on any lane in any state, and four captures
	# recorded a meaningful-looking absence that was a wrong path.
	#
	# IT CANNOT BE FIXED BY POINTING AT THE RUNROOT EITHER. That filesystem dies
	# with the lane container, and this capture is taken from the host at the top
	# of the next cycle. The replacement is the docker shim's sampler, which
	# reads the same file from INSIDE the lane while `docker start` is running -
	# see apps/github-runner/scripts/docker-shim.sh - and arrives here inside
	# postmortem.log.
	for n in db.sql overlay-layers/layers.json \
	         overlay-containers/containers.json overlay-images/images.json; do
		podman unshare cp "$LANE_ROOT/storage/$n" \
			"$dest/$(printf '%s' "$n" | tr / -)" 2>/dev/null || true
	done
	cp "$MARKER" "$dest/marker" 2>/dev/null || true
	podman unshare cp "$LANE_ROOT/$HEAL_LOG" "$dest/postmortem.log" 2>/dev/null || true
	{
		printf 'reason=%s\n' "$reason"
		printf 'lane=%s\n' "$LANE"
		printf 'jobs_total=%s\n' "$jobs_total"
		printf 'store_jobs=%s\n' "$store_jobs"
		printf 'lane_disk_mb=%s\n' "${lane_disk_mb:-unmeasured}"
		printf 'image=%s\n' "$IMAGE"
	} > "$dest/context" 2>/dev/null

	# Newest FORENSIC_KEEP kept. The directory names sort by their own timestamp,
	# so the ordering is the name and no mtime is consulted - a copied file's
	# mtime is the source's, which would sort these by when the store was
	# written rather than by when it was captured.
	stale=$(find "$FLEET_ROOT/forensics" -maxdepth 1 -name "lane$LANE-*" -type d 2>/dev/null |
		sort | head -n -"$FORENSIC_KEEP")
	[ -n "$stale" ] && printf '%s\n' "$stale" | while read -r old; do
		[ -n "$old" ] && rm -rf "${old:?}"
	done
	log "kept the store's metadata in $dest before resetting"
}

lane_reset() {
	local reason="$1" d targets
	case "$reason" in heal|budget) lane_forensics "$reason" ;; esac

	# THE WORKSPACE IS `runner/_work`, AND THE RECLAIM THIS REPLACES NAMED
	# `home/work`, WHICH HAS NEVER EXISTED. The just-in-time configuration sets
	# `work_folder:"_work"`, and the runner resolves that against its OWN
	# directory - so every checkout, every node_modules and every uv venv has
	# always been somewhere the garbage collector was not looking. `home/` holds
	# only `.bun`, `.cache`, `.config` and `.local`, which is why the removal
	# reported nothing and reclaimed nothing.
	targets="runner/_work tmp storage"

	# A BUDGET RECLAIM TAKES THE CACHES TOO, AND THE OTHER TWO REASONS MUST NOT.
	# Measured on lane 1: home 1,789 MB, runner 799 MB (of which _work is 81),
	# storage 660 MB. So the caches are the largest thing here by a factor of
	# two, and a reclaim that spared them could not get back under the budget -
	# which would leave gc_lane firing on every single cycle, re-pulling three
	# images each time, and never converging. A heal and a window reset are
	# targeted at the store and keep the caches, because their cost is a re-pull
	# of three small images rather than every dependency in the repository.
	[ "$reason" = budget ] && targets="$targets home/.cache home/.bun"

	# `podman unshare rm`, NOT a plain rm. Everything under the lane belongs to
	# the subuid that container uid 1000 maps to, so `core` cannot remove it from
	# outside the namespace - a plain rm produces a wall of `Permission denied`
	# and leaves the budget un-reclaimed while reporting nothing, which is a disk
	# that fills with a garbage collector running.
	for d in $targets; do
		podman unshare rm -rf "${LANE_ROOT:?}/$d"
	done

	# ONLY THESE TWO ARE RECREATED, because podman does not create a missing
	# bind-mount source - it fails the container, and `Restart=always` turns that
	# into a silent five-second retry loop. `runner/_work` and the cache
	# directories are made by the processes that use them, inside trees that are
	# already theirs.
	mkdir -p "$LANE_ROOT/tmp" "$LANE_ROOT/storage"

	# AND CHOWN THEM BACK, WHICH THE RECLAIM THIS REPLACES DID NOT DO. `mkdir` as
	# `core` makes a directory the container sees as owned by uid 0, and the
	# runner inside is uid 1000 - the exact state preflight's chown loop exists
	# to repair, and whose absence produced "mkdir /home/runner/.local:
	# permission denied" on the first live lane. It was never noticed because
	# that reclaim had never once fired: the budget gating it was being read by a
	# du that reported half the truth. Two defects, and the second hid the first.
	# 1000:0, matching preflight and matching what the container writes: the
	# runner's primary gid is 0. This tree was just recreated empty, so `-R` here
	# is two directories and not a live store.
	for d in tmp storage; do
		podman unshare chown -R 1000:0 "$LANE_ROOT/$d" 2>/dev/null ||
			log "WARNING: could not chown $LANE_ROOT/$d back into the container's namespace - the next lane will not be able to write its own store"
	done
	# BOTH, and the log with the flag rather than kept: it is appended to, so
	# leaving it would put every previous failure into the next capture and make
	# the one that caused this reset impossible to pick out. The copy above is
	# what preserves it.
	podman unshare rm -f "${LANE_ROOT:?}/$HEAL_FLAG" "${LANE_ROOT:?}/$HEAL_LOG" 2>/dev/null

	store_jobs=0
	store_resets=$(( store_resets + 1 ))
	last_reset_at=$(now_iso)
	last_reset_reason="$reason"
	lane_disk_mb=$(lane_du_mb "$LANE_ROOT")
	log "lane store reset ($reason); it now holds ${lane_disk_mb:-?}MB"
}

# At the top of a cycle, which is the only moment this lane knows no job is
# running. lane_disk_mb is in the marker either way, so ci.lane_disk can warn
# before this has to act.
# `podman unshare du`, FOR THE SAME REASON THE rm BELOW IS UNSHARED, and this
# half was wrong for as long as the other half was right. Everything under the
# lane belongs to the subuid container uid 1000 maps to, so `core` cannot
# traverse most of it: `du` skips what it cannot read and reports the remainder
# WITHOUT AN ERROR. Measured on lane 1 on 2026-08-26: 1,383 MB reported against
# 2,500 MB actual, and the same understatement reaches ci.lane_disk, which is
# therefore grading a fiction. A garbage collector reading a number that is
# systematically low is one that never fires.
lane_du_mb() {
	podman unshare du -sm "$1" 2>/dev/null | cut -f1
}

gc_lane() {
	lane_disk_mb=$(lane_du_mb "$LANE_ROOT")
	case "$lane_disk_mb" in ''|*[!0-9]*) lane_disk_mb="" ;; esac

	# THE HEAL FLAG IS READ FIRST, so a lane that has actually failed is recorded
	# as a heal rather than swallowed by whichever other trigger happened to be
	# true in the same cycle - which decides both whether the evidence is kept
	# and what ci.lane_store reports. `podman unshare test`, because
	# $LANE_ROOT/home belongs to a subuid `core` cannot stat inside.
	if podman unshare test -f "$LANE_ROOT/$HEAL_FLAG" 2>/dev/null; then
		log "the docker shim reported a start it could not retry into working - healing this lane"
		lane_reset heal
		return 0
	fi

	if [ -n "$lane_disk_mb" ] && [ "$lane_disk_mb" -gt "$LANE_MAX_MB" ]; then
		log "lane is ${lane_disk_mb}MB over the ${LANE_MAX_MB}MB budget"
		lane_reset budget
		return 0
	fi

	if [ "$STORE_MAX_JOBS" -gt 0 ] && [ "$store_jobs" -ge "$STORE_MAX_JOBS" ]; then
		log "this store has served $store_jobs jobs against a ${STORE_MAX_JOBS}-job window"
		lane_reset window
		return 0
	fi
}

# ------------------------------------------------------------------------------
# What a job actually cost
# ------------------------------------------------------------------------------
# READ WHILE THE JOB IS STILL RUNNING, because the scope is transient and
# --collect: the instant the container exits systemd removes it and every number
# in it goes too. That is the whole reason this is sampled on the poll rather
# than read once at the end, where it would find nothing.
#
# THE SAMPLE RATE DOES NOT DECIDE THE ANSWER. memory.peak and pids.peak are
# kernel high-water marks, so a read at any moment is the maximum over
# everything before it. What a 30-second poll can miss is a peak reached in the
# last interval before exit, which is teardown rather than test. Said plainly
# rather than left implied: this is a floor on the true peak, and it is the
# floor host/systemd/app-ci.slice asked for.
#
# WHY IT IS HERE AT ALL. That file sizes two lanes against a 15.8 GB host from
# numbers it calls starting points, and names its own failure mode as silence: a
# `Slice=` pointing at nothing still starts every member, healthy and fully
# observed and contained by nothing. Peaks in the marker are what turn the next
# sizing argument into a measurement.
sample_scope() {
	local d="$SCOPE_CG/$scope.scope" v
	[ -n "$scope" ] || return 0
	[ -d "$d" ] || return 0

	v=$(cat "$d/memory.peak" 2>/dev/null)
	case "$v" in ''|*[!0-9]*) ;; *)
		v=$(( v / 1048576 ))
		if [ "$v" -gt "${lane_mem_peak_mb:-0}" ]; then lane_mem_peak_mb="$v"; fi ;;
	esac

	v=$(cat "$d/pids.peak" 2>/dev/null)
	case "$v" in ''|*[!0-9]*) ;; *)
		if [ "$v" -gt "${lane_pids_peak:-0}" ]; then lane_pids_peak="$v"; fi ;;
	esac

	# THESE TWO ARE PER-JOB, AND THE LIFETIME TOTAL IS ADDED ONCE AT THE END.
	# memory.events counts within one cgroup and the cgroup is new every job, so
	# folding them into the lifetime counter here would add this job's events
	# again on every single poll.
	v=$(awk '$1=="max"{print $2}' "$d/memory.events" 2>/dev/null)
	case "$v" in ''|*[!0-9]*) ;; *) job_mem_max_ev="$v" ;; esac
	v=$(awk '$1=="oom_kill"{print $2}' "$d/memory.events" 2>/dev/null)
	case "$v" in ''|*[!0-9]*) ;; *) job_oom_kills="$v" ;; esac
}

# ------------------------------------------------------------------------------
# Registrations
# ------------------------------------------------------------------------------
# `./config remove` does not work on a just-in-time runner, so a registration is
# removed by id through the API or not at all.
delete_runner() {
	local id="$1" resp code
	[ -n "$id" ] || return 0
	resp=$(api DELETE "/orgs/$GITHUB_RUNNER_ORG/actions/runners/$id")
	code=$(http_status "$resp")
	case "$code" in
		204) return 0 ;;
		404) return 0 ;;   # already gone, which is the normal case
		*)   return 1 ;;
	esac
}

# A runner this lane minted, offline, that the ephemeral teardown did not take
# with it. GitHub reaps these after a day on its own, so this is not a leak that
# grows without bound - but a day of them plus a restart loop is thousands of
# rows, and the count is what says the teardown has stopped working.
reap_offline() {
	local resp code ids id
	resp=$(api GET "/orgs/$GITHUB_RUNNER_ORG/actions/runners?per_page=100")
	code=$(http_status "$resp")
	[ "$code" = 200 ] || return 0

	ids=$(http_body "$resp" | jq -r --arg p "home-server-$LANE-" \
		'.runners[]? | select(.name | startswith($p)) | select(.status == "offline") | .id' 2>/dev/null)
	[ -n "$ids" ] || return 0

	for id in $ids; do
		if delete_runner "$id"; then
			deregister_orphans=$(( deregister_orphans + 1 ))
			log "reaped offline registration $id"
		fi
	done
}

# ------------------------------------------------------------------------------
# The cycle
# ------------------------------------------------------------------------------
cleanup() {
	stopping=1
	log "stopping"
	[ -n "$cname" ] && podman rm -f "$cname" >/dev/null 2>&1
	[ -n "$runner_id" ] && delete_runner "$runner_id"
	podman unshare rm -f "$jitfile" 2>/dev/null
	marker_write 0
	exit 0
}

# A sleep that a SIGTERM does not have to outwait. bash runs a trap only after
# the current command returns, so one `sleep 60` would delay a stop by up to a
# minute - inside a TimeoutStopSec that also has to cover killing a container and
# a network round trip to GitHub.
nap() {
	local left="$1"
	while [ "$left" -gt 0 ] && [ "$stopping" = 0 ]; do
		sleep 2
		left=$(( left - 2 ))
		# EVERY TWO SECONDS, NOT EVERY THIRTY, AND THE DIFFERENCE WAS MEASURED
		# RATHER THAN ARGUED. Sampling once per poll left the marker up to
		# POLL_SEC behind: caught mid-e2e-shard, the driver held 2,266 MB
		# against an independent sampler's 2,817 MB - 551 MB, or 15% of
		# MemoryMax, of a ceiling this is supposed to be grading. pids.peak
		# agreed exactly at 120, which is what said the gap was staleness and
		# not the reader.
		#
		# It costs three small reads of an already-open cgroup every two seconds
		# per lane, and it only narrows the window - it does not close it. A peak
		# reached in the last two seconds before the container exits is still
		# missed, so this remains a floor on the true peak. Said here as well as
		# at sample_scope, because this is the line that decides how good a floor.
		sample_scope
	done
}

trap cleanup TERM INT

marker_read
preflight
log "lane $LANE ready: cpus $LANE_CPUS, org $GITHUB_RUNNER_ORG, group $GITHUB_RUNNER_GROUP_ID"

while [ "$stopping" = 0 ]; do
	marker_write 0

	while phase_in_flight && [ "$stopping" = 0 ]; do
		log "a conduct phase is in flight - holding this lane (lane 1 keeps taking jobs)"
		nap 60
	done
	[ "$stopping" = 0 ] || break

	gc_lane
	reap_offline

	stamp=$(date +%s)
	name="home-server-$LANE-$stamp"
	cname="ci-$LANE-$stamp"
	scope="ci-lane-$LANE-$stamp"

	# A UNIQUE NAME EVERY TIME, because ephemeral deregistration lags the
	# process exit: reusing a fixed name gets 409 Conflict on the next mint, for
	# a runner that is on its way out. The epoch is enough - a lane cannot mint
	# twice in one second.
	body="$LANE_ROOT/.mint.json"
	jq -cn --arg n "$name" \
	       --argjson g "$GITHUB_RUNNER_GROUP_ID" \
	       --arg l "$LABELS" \
	       '{name:$n, runner_group_id:$g, labels:($l|split(",")), work_folder:"_work"}' \
	       > "$body" 2>/dev/null

	resp=$(api POST "/orgs/$GITHUB_RUNNER_ORG/actions/runners/generate-jitconfig" "$body")
	rm -f "$body"
	code=$(http_status "$resp")

	case "$code" in
		201)
			consecutive_failures=0
			last_error=""
			last_error_at=""
			;;
		401|403)
			set_error "generate-jitconfig returned $code"
			marker_write 0
			die 5 "GitHub rejected the credential with $code. A retry cannot fix a revoked, expired or unapproved token, so this lane stops rather than spinning: an unset token must not look like a fault and a revoked one must not look like health. Check GITHUB_RUNNER_PAT in .env, and that the fine-grained token is still approved by the organisation."
			;;
		422)
			set_error "generate-jitconfig returned 422"
			marker_write 0
			die 6 "GitHub rejected the request with 422 - almost always GITHUB_RUNNER_GROUP_ID naming a group that does not exist, or a label the organisation refuses. Body: $(http_body "$resp" | tr '\n' ' ' | cut -c1-200)"
			;;
		*)
			consecutive_failures=$(( consecutive_failures + 1 ))
			set_error "generate-jitconfig returned ${code:-no response}"
			marker_write 0
			# 30, 60, 120, 300 and then 300 for ever. Transient by definition,
			# so it never exits - exiting here would burn the unit's start limit
			# on something a later attempt survives.
			backoff=$(( 30 * (1 << (consecutive_failures > 4 ? 4 : consecutive_failures - 1)) ))
			[ "$backoff" -gt 300 ] && backoff=300
			log "mint failed (${code:-no response}), retrying in ${backoff}s"
			nap "$backoff"
			continue
			;;
	esac

	runner_id=$(http_body "$resp" | jq -r '.runner.id // empty' 2>/dev/null)
	# WRITTEN THROUGH `podman unshare`, because the runner tree belongs to the
	# container's mapped subuid and this process does not. `tee` rather than a
	# redirect for the same reason a redirect cannot work: the shell opens the
	# target BEFORE unshare runs, as `core`, and is refused. The value travels on
	# stdin either way, so it is in no argument vector.
	# THE CHOWN IS NOT OPTIONAL AND 0600 IS WHY. `podman unshare` maps `core` to
	# container uid 0, so `tee` creates this file owned by container ROOT - and
	# the runner is uid 1000. At 0600 it is then unreadable by the only process
	# that needs it, and the failure arrives inside the container as
	#   cat: .jitconfig: Permission denied
	#   An error occurred: Not configured. Run config.(sh/cmd) to configure...
	# which reads as a runner that was never configured rather than as a file
	# mode. Measured by hand, because --log-driver=none means a lane never shows
	# it. Group 0 because that is the runner's primary group - see the Dockerfile.
	http_body "$resp" | jq -r '.encoded_jit_config // empty' |
		podman unshare tee "$jitfile" >/dev/null 2>&1
	podman unshare chown 1000:0 "$jitfile" 2>/dev/null
	podman unshare chmod 0600 "$jitfile" 2>/dev/null

	if [ ! -s "$jitfile" ]; then
		consecutive_failures=$(( consecutive_failures + 1 ))
		set_error "generate-jitconfig returned 201 with no encoded_jit_config"
		marker_write 0
		nap 60
		continue
	fi

	log "minted $name (runner $runner_id)"

	# A JOB IS COUNTED FROM THE RUNNER'S OWN RECORD, NOT FROM THE POLL. The
	# busy/idle poll below cannot see a job that starts and finishes between two
	# of its ticks, and plenty of upskald's jobs are shorter than that - so
	# jobs_today would undercount, silently, in the direction that makes a busy
	# lane look idle. The runner writes one _diag/Worker_*.log per job it runs,
	# on disk, in the lane's own tree, so counting those before and after costs
	# nothing and cannot miss.
	workers_before=$(find "$LANE_ROOT/runner/_diag" -maxdepth 1 -name 'Worker_*.log' 2>/dev/null | wc -l)

	# THE CONFIG IS READ INSIDE THE CONTAINER, NOT PASSED ON THE HOST'S COMMAND
	# LINE. `./run.sh --jitconfig <base64>` would put a live credential in this
	# host's process list, where `core` can read it and where systemd records it
	# in the scope's properties. Inside, it is no more exposed than the
	# .credentials file the runner writes from it a moment later.
	#
	# THE TWO SECURITY OPTIONS ARE THE WHOLE OF WHAT A NESTED ENGINE COSTS, and
	# both were arrived at by bisection on this host rather than copied from a
	# guide. Neither is `--privileged` and neither is `label=disable`, which is
	# what podman's own documentation reaches for and which would run a lane as
	# unconfined_t - SELinux containment not weakened but GONE, since `core` is
	# unconfined_u:unconfined_r:unconfined_t. The capability set is podman's
	# DEFAULT: nothing added, which is the same posture every other container on
	# this host runs under except the phase runner.
	#
	#   label=type:container_engine_t  container-selinux's purpose-built type for
	#     running an engine inside a container. SELinux stays enforcing. Without
	#     it: `crun: mount `devpts` to `dev/pts`: Permission denied`.
	#
	#   unmask=ALL  the outer container's own /proc masking is LOCKED against a
	#     nested mount namespace, so an inner container cannot lay its own tmpfs
	#     over /proc/acpi and crun refuses. Without it:
	#     `crun: mount `tmpfs` to `proc/acpi`: Permission denied`.
	#     The cost is that a lane sees /proc/kcore, /proc/acpi and /sys/firmware.
	#     Reading kcore needs CAP_SYS_RAWIO, which is not added below, so the
	#     exposure is bounded - and it is recorded in docs/ci.md, not left implicit.
	#
	#   --cap-add=SYS_ADMIN  the THIRD concession and the largest, arrived at
	#     last. A DETACHED inner container - every `services:` block - needs to
	#     set its own hostname in its own UTS namespace, and capabilities in a
	#     NESTED user namespace are bounded by the outer set, so the nested root
	#     cannot have what the lane does not. Without it:
	#     `crun: sethostname: Operation not permitted`.
	#
	#     WHAT IT COSTS, plainly: `--read-only` below stops being a boundary and
	#     becomes hygiene, since a process with CAP_SYS_ADMIN can
	#     `mount -o remount,rw /`. What that reaches is this job's own ephemeral
	#     overlay, which the job can already write through $HOME, /tmp and the
	#     runner tree - so the loss is smaller than the flag sounds. It is still
	#     the widest capability there is, and it is here because the alternative
	#     is that `services:` does not work at all.
	#
	# NOT `--privileged`, and the distance matters: SELinux stays enforcing under
	# container_engine_t, the seccomp profile is podman's default, no host path is
	# mounted, and no container socket of the host's is reachable.
	#
	# BOTH DEVICES, AND THE SECOND ONE WAS NEARLY LEFT OUT ON A BAD MEASUREMENT.
	# An interactive `podman run --rm alpine echo ok` inside a lane succeeds with
	# no tap device at all, which looked like proof podman 5 needed none. A
	# DETACHED container - which is what every `services:` block is - takes a
	# different path and does not:
	#
	#   Error: pasta failed with exit code 1:
	#   Failed to open() /dev/net/tun: No such file or directory
	#
	# The cheap probe and the real workload were not the same test.
	#
	# EVERY TMPFS IN HERE IS SIZED, AND /run WAS THE ONE THAT WAS NOT. A tmpfs
	# inside a container is charged to its MEMORY budget and is unreclaimable
	# without swap - the measurement that taught this host so is in
	# docs/known-state.md - so an unbounded one inside a 3,584M MemoryMax is a way
	# to reach the hard limit with every process behaving. `--read-only-tmpfs`
	# mounts /run, /tmp and /var/tmp; /tmp is capped explicitly below and always
	# was, but /run inherited podman's default and measured `7.8G` inside a lane,
	# which is half the HOST's memory, because a container is not memory-
	# namespaced. 128m is two orders of magnitude more than the engine's runtime
	# state needs and is a ceiling rather than a reservation.
	#
	# `tmpcopyup` IS THE HALF THAT IS EASY TO DROP. An explicit --tmpfs replaces
	# the read-only-tmpfs mount rather than adjusting it, and without tmpcopyup
	# the image's own /run content - console, lock, log, secrets, sudo and the
	# rest - is hidden behind an empty filesystem. Measured with it: all fifteen
	# entries present at 64M, so the flag does what it says here.
	#
	# shellcheck disable=SC2016  # the $(cat) is for the container's shell, not this one
	systemd-run --user --scope --collect \
		--slice=app-ci.slice --unit "$scope" --quiet \
		-p MemoryHigh=2816M -p MemoryMax=3584M \
		-p CPUWeight=20 -p IOWeight=20 -p TasksMax=1024 \
		-p AllowedCPUs="$LANE_CPUS" \
		-p RuntimeMaxSec="$RUNTIME_MAX_SEC" \
		-- nice -n 10 \
		podman run --rm --cgroups=split \
			--name "$cname" \
			--label io.home-server.ephemeral \
			--network "$NET" \
			--dns 1.1.1.1 --dns 1.0.0.1 \
			--cap-add=SYS_ADMIN \
			--security-opt label=type:container_engine_t \
			--security-opt unmask=ALL \
			--device /dev/fuse --device /dev/net/tun \
			--read-only --read-only-tmpfs \
			--tmpfs /tmp:rw,exec,size=512m \
			--tmpfs /run:rw,nosuid,nodev,size=128m,tmpcopyup \
			--shm-size=512m \
			--pids-limit=1024 \
			--log-driver=none \
			--no-healthcheck \
			-v "$LANE_ROOT/home:/home/runner:rw" \
			-v "$LANE_ROOT/toolcache:/opt/hostedtoolcache:rw" \
			-v "$LANE_ROOT/storage:/var/lib/nested-storage:rw" \
			-v "$LANE_ROOT/runner:/opt/actions-runner:rw" \
			-v "$LANE_ROOT/tmp:/scratch:rw" \
			-w /opt/actions-runner \
			"$IMAGE" \
			sh -c 'exec ./run.sh --jitconfig "$(cat .jitconfig)"' &

	run_pid=$!
	busy=0
	job_started_at=""
	idle_since=$stamp
	job_mem_max_ev=0
	job_oom_kills=0
	marker_write 0

	while kill -0 "$run_pid" 2>/dev/null && [ "$stopping" = 0 ]; do
		nap "$POLL_SEC"
		[ "$stopping" = 0 ] || break
		kill -0 "$run_pid" 2>/dev/null || break

		r=$(api GET "/orgs/$GITHUB_RUNNER_ORG/actions/runners/$runner_id")
		rc=$(http_status "$r")
		[ "$rc" = 200 ] || continue

		is_busy=$(http_body "$r" | jq -r '.busy // false' 2>/dev/null)

		if [ "$is_busy" = true ]; then
			if [ "$busy" = 0 ]; then
				busy=1
				job_started_at=$(now_iso)
				log "job started"
			fi
			marker_write 1 "$job_started_at"
			continue
		fi

		# NOT BUSY. Either it has not been given a job yet, or it has finished
		# one and is about to exit. The idle ceiling is what bounds both.
		#
		# THE HEARTBEAT IS WRITTEN HERE OR IT IS NOT WRITTEN AT ALL, and leaving
		# it out was a real defect rather than an omission. An idle lane is the
		# NORMAL state - it is what a lane does between jobs, which is most of
		# the time - and without this the marker only moved when something
		# happened. ci.heartbeat grades at 300s against a 30s poll and warned
		# with the lane perfectly healthy and its registration online: measured
		# at 465 seconds stale on the first live lane. A check that fires on the
		# normal case is a check somebody learns to ignore.
		marker_write 0

		[ "$busy" = 1 ] && continue

		if [ "$(( $(date +%s) - idle_since ))" -ge "$IDLE_SEC" ]; then
			# THE IDLE TEARDOWN IS NOT AN OPTIMISATION. It bounds how long a
			# registration lives and how long this container lives, and the
			# second of those is what keeps a lane under the 7200s ceiling
			# agents.runners_leaked applies to EVERY container carrying
			# io.home-server.ephemeral - which a CI lane necessarily does. It is
			# also what lets an idle lane pick up a newly promoted :latest.
			log "idle for ${IDLE_SEC}s - recycling this registration"
			podman stop -t 30 "$cname" >/dev/null 2>&1
			break
		fi
	done

	# One more attempt before waiting, on the chance the scope has outlived the
	# container by a few milliseconds. It usually has not, which is why the poll
	# above is the measurement and this is only an opportunity.
	sample_scope

	wait "$run_pid" 2>/dev/null
	run_rc=$?
	scope=""

	lane_mem_max_events=$(( lane_mem_max_events + job_mem_max_ev ))
	lane_oom_kills=$(( lane_oom_kills + job_oom_kills ))

	workers_after=$(find "$LANE_ROOT/runner/_diag" -maxdepth 1 -name 'Worker_*.log' 2>/dev/null | wc -l)
	[ "$workers_after" -gt "$workers_before" ] && busy=1

	if [ "$busy" = 1 ]; then
		today=$(date -u +%Y-%m-%d)
		[ "$jobs_day" = "$today" ] || { jobs_day="$today"; jobs_today=0; }
		jobs_today=$(( jobs_today + 1 ))
		jobs_total=$(( jobs_total + 1 ))
		store_jobs=$(( store_jobs + 1 ))
		last_job_at=$(now_iso)
		last_job_seconds=$(( $(date +%s) - stamp ))
		log "job finished after ${last_job_seconds}s (container rc $run_rc)"
	fi

	# An ephemeral runner deregisters itself on the way out, so 404 is the
	# expected answer here and a successful 204 means it did NOT - which is
	# counted rather than ignored, because it is the first sign the teardown has
	# stopped working.
	if delete_runner "$runner_id"; then
		:
	else
		log "could not remove registration $runner_id"
	fi
	podman unshare rm -f "$jitfile" 2>/dev/null
	cname=""
	runner_id=""

	# The runner's own version, re-read every cycle, because it updates itself
	# and the image's ARG is only ever the seed.
	v=$(sed -n 's/^.*"agentVersion" *: *"\([^"]*\)".*$/\1/p' "$LANE_ROOT/runner/.runner" 2>/dev/null | tail -1)
	[ -n "$v" ] && runner_version="$v"

	marker_write 0
done

cleanup
