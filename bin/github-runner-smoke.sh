#!/usr/bin/env bash
# ==============================================================================
# Prove a candidate CI image before a job can be stranded on it
# ------------------------------------------------------------------------------
# stacks/infra/github-runner.build tags :next. This is what decides whether
# :next becomes :latest, and the indirection exists for the reason
# bin/conduct-runner-smoke.sh states: a `curl | tar` and an `apt-get install`
# both succeed against something that does not work, so the build is not a gate
# and a gate had to be written.
#
# THE STAKES HERE ARE HIGHER THAN FOR THE PHASE RUNNER, and that is worth being
# explicit about. A broken phase runner fails a phase, loudly, in twenty minutes.
# A broken CI image HANGS A LANE: GitHub's runner waits on a service container's
# health status in a loop with NO RETRY CAP, and upskald sets `timeout-minutes:`
# on none of its jobs, so the default 360 applies. Six hours, with the container
# running, the service serving, and nothing on this host reporting anything
# wrong. Three of the legs below exist for exactly that failure.
#
# TOOLING     every binary a workflow shells out to answers; the runner tree is
#             the version it claims; the four writable mounts are really
#             required, really writable, and NOT tmpfs; the nested engine pulls;
#             a service container reaches `healthy`; and a published port
#             answers on localhost, which is what a workflow's DATABASE_URL
#             actually does.
#
# CONTAINMENT the forbidden edges, BY IP from a container shaped exactly like a
#             lane, on a throwaway isolate=true network. The house rule in
#             docs/networking.md is that an edge is proven by address and never
#             by name resolution, and that a REFUSAL is not a blocked edge - the
#             packet arrived and only the port was shut. 124 from `timeout` is
#             the pass; 1 is a different finding entirely.
#
# ITS CONTAINMENT LEGS ARE NOT bin/conduct-runner-smoke.sh's, AND COPYING THOSE
# WOULD HAVE BEEN WORSE THAN WRITING NONE. Two of them - "the root filesystem
# rejects a write" and "no container socket is visible" - are things this image
# deliberately half-violates: the lane's runner tree IS writable, because the
# runner writes its own credentials into it and updates itself there, and there
# IS a container socket, because that is the whole point. Deleting those legs
# from a copied script would leave a gate whose name promises more than it
# checks, which is this repository's named failure. They are REPLACED below by
# the negatives that are actually true here: the socket a job can reach is the
# NESTED one, the graph root is the lane's, and the host's fleet state is
# unreachable.
#
# Run it by hand against a candidate with
#   GITHUB_RUNNER_IMAGE=localhost/home-server/github-runner:next bin/github-runner-smoke.sh
#
# It does NOT measure cgroup peaks. Those belong to a real job, and until one has
# run the numbers in host/systemd/app-ci.slice are a starting point that file
# says out loud.
# ==============================================================================
set -euo pipefail

ROOT=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)
IMAGE="${GITHUB_RUNNER_IMAGE:-localhost/home-server/github-runner:next}"
FLEET_ROOT="${GITHUB_RUNNER_ROOT:-/var/home-server/cache/github-runner}"
NET="net-ci-smoke"
LANE="$FLEET_ROOT/lanes/.smoke"

# Defined BEFORE cleanup() rather than beside runner(), because the EXIT trap can
# fire on the image-exists check above it and `set -u` would then abort inside
# the trap - which is how a cleanup stops cleaning up.
SMOKE_TAG="ci-smoke-$$"

fails=0
ok()   { printf '  ok    %s\n' "$*"; }
bad()  { printf '  FAIL  %s\n' "$*"; fails=$((fails + 1)); }
note() { printf '  note  %s\n' "$*"; }
say()  { printf '\n%s\n' "$*"; }

# The network is named under the net-ci-* prefix on purpose: that is the prefix
# ci.runner_isolation reads, so a leak from a killed run is visible to the same
# check that watches the real lanes.
# shellcheck disable=SC2317  # reached through the EXIT trap, which shellcheck
# cannot follow.
cleanup() {
	for c in $(podman ps -aq --filter "label=io.home-server.ci-smoke=$SMOKE_TAG" 2>/dev/null); do
		podman rm -f "$c" >/dev/null 2>&1 || true
	done
	podman network rm -f "$NET" >/dev/null 2>&1 || true
	# `podman unshare rm`, NOT a plain rm. Everything under the lane belongs to
	# the subuid container-uid-1000 maps to, so `core` cannot remove it from
	# outside the namespace - measured, as a wall of `rm: cannot remove ...:
	# Permission denied` at the end of an otherwise clean run, which leaves the
	# next run's lane half-populated by a previous image.
	podman unshare rm -rf "$LANE" >/dev/null 2>&1 || true
}
trap cleanup EXIT INT TERM

podman image exists "$IMAGE" || { echo "no such image: $IMAGE" >&2; exit 1; }

mkdir -p "$LANE"/{home,toolcache,storage,runner,tmp}

# THE SAME chown bin/github-runner.sh DOES, and for the same reason - see its
# preflight. Without it the nested engine cannot write $HOME and dies with a
# permission error naming a path nobody chose. It is here rather than assumed
# because a smoke test that prepares its lane differently from the driver proves
# the image under conditions that never occur.
podman unshare chown -R 1000:1000 "$LANE"

podman network exists "$NET" >/dev/null 2>&1 ||
	podman network create --opt isolate=true "$NET" >/dev/null

# THE INVOCATION IS THE LANE'S, MINUS THE SCOPE. Every flag here is one
# bin/github-runner.sh passes, in the same order, for the same reason - because a
# smoke test that runs the image under a different profile proves the image and
# not the design. The scope, the cpuset and RuntimeMaxSec are the only omissions:
# they bound a job, and this script runs none.
# NO FIXED --name, AND THAT IS A MEASUREMENT RATHER THAN A STYLE CHOICE. With
# one, a container still terminating from the previous leg collides with the next
# and podman exits **125** - which the probe() below correctly refuses to read as
# either "dropped" or "refused", and which would otherwise have been reported as
# a containment failure in four separate legs. A unique name per invocation and a
# label for the cleanup removes the class.
#
# THE FLAGS ARE AN ARRAY BECAUSE TWO CALLERS NEED THEM. probe() below has to put
# a `timeout` in FRONT of podman, which cannot be done to a shell function - and
# a second copy of twenty flags is a second thing to forget when one changes.
RUNNER_ARGS=(
	--rm -i
	--label io.home-server.ephemeral
	--label "io.home-server.ci-smoke=$SMOKE_TAG"
	--network "$NET"
	--dns 1.1.1.1 --dns 1.0.0.1
	--cap-add=SYS_ADMIN
	--security-opt label=type:container_engine_t
	--security-opt unmask=ALL
	--device /dev/fuse --device /dev/net/tun
	--read-only --read-only-tmpfs
	--tmpfs "/tmp:rw,exec,size=512m"
	--tmpfs "/run:rw,nosuid,nodev,size=128m,tmpcopyup"
	--shm-size=512m
	--pids-limit=1024 --log-driver=none --no-healthcheck
	-v "$LANE/home:/home/runner:rw"
	-v "$LANE/toolcache:/opt/hostedtoolcache:rw"
	-v "$LANE/storage:/var/lib/nested-storage:rw"
	-v "$LANE/runner:/opt/actions-runner:rw"
	-v "$LANE/tmp:/scratch:rw"
)

runner() {
	podman run --name "$SMOKE_TAG-$RANDOM" "${RUNNER_ARGS[@]}" "$IMAGE" "$@"
}

# ------------------------------------------------------------------------------
say "Tooling"
# ------------------------------------------------------------------------------
# EVERY BINARY IN ONE CONTAINER START, because twenty starts is twenty times the
# setup and this is the cheap half of the script.
#
# Each of these is on the list because something upskald's CI does needs it and
# because its absence is quiet: @actions/tool-cache shells out to `unzip` for a
# zip archive, which is how oven-sh/setup-bun@v2 unpacks; actions/cache@v5 uses
# zstd and SILENTLY falls back to gzip without it; actions/checkout falls back to
# a REST tarball with no .git at all if git is missing or too old, and upskald's
# web-checks then runs the FULL suite instead of the changed one - slower, and
# green, and wrong.
missing=""
# node/npm/npx were NOT on this list and the image did not have them, which is
# how a green smoke test shipped a lane that could not run prek's root-lint hook.
# Hosted ubuntu-latest carries node at /usr/local/bin/node, so no workflow
# installs it and no workflow declares it - the dependency is invisible until it
# is absent, and then the error names the HOOK rather than the interpreter.
for b in bash sh git git-lfs curl wget tar unzip zip zstd xz jq make gcc \
         pkgconf python3 node npm npx sudo docker podman crun fuse-overlayfs \
         newuidmap newgidmap pasta ssh rsync; do
	runner sh -c "command -v $b >/dev/null 2>&1" || missing="$missing $b"
done
if [ -z "$missing" ]; then
	ok "every binary a workflow shells out to answers"
else
	bad "missing from the image:$missing"
fi

if runner sh -c 'ldconfig -p | grep -q libicu && ldconfig -p | grep -q liblttng'; then
	ok "libicu and liblttng are present, so the runner's bundled .NET can start"
else
	bad "libicu or liblttng is missing - the runner will not start and the error names neither"
fi

# NODE'S LOCALE DATA, ASSERTED BY ASKING IT TO NAME A COUNTRY.
#
# THE BINARY ANSWERING IS NOT THE BINARY WORKING, and this is the leg that says
# so. `node` was added to the list above after prek could not spawn it - and the
# very next run still failed, because Fedora builds node `small-icu`: Intl exists,
# every call succeeds, and DisplayNames answers with the input it was given. NL
# comes back as "NL" rather than "Netherlands". Nothing throws and nothing warns;
# a sort by display name simply comes out in a different order, which is how
# upskald's "orders countries by English display name, not ISO code" failed ONE
# test of 4,460 and read as flake.
#
# DELIBERATELY NOT `process.config.variables.icu_small`. That reads the build flag,
# and a future base could bundle the data some other way and fail this check while
# working perfectly - or pass it while shipping data too old to matter. The display
# name is the thing a workflow actually depends on, so the display name is the
# assertion.
icu=$(runner node -e 'process.stdout.write(new Intl.DisplayNames(["en"],{type:"region"}).of("NL"))' 2>/dev/null | tr -d '\r')
case "$icu" in
	Netherlands)
		ok "node has full locale data - Intl.DisplayNames names a country rather than echoing its code" ;;
	NL)
		bad "node is small-icu: Intl.DisplayNames('NL') returned 'NL', not 'Netherlands'. Every Intl call SUCCEEDS and answers with the input, so the only symptom is a wrong sort order in someone's test suite. Install nodejs24-full-i18n" ;;
	*)
		bad "the ICU probe returned '${icu:-nothing}', which is neither the name nor the code - node did not run, or Intl.DisplayNames is unavailable entirely" ;;
esac

# THE TAP DEVICE, ASSERTED BY OPENING IT RATHER THAN BY LISTING IT.
# It arrives `crw-rw---- 65534 0`, group 0 only, and the nested engine's pasta
# cannot give a DETACHED container a network without it - which is every
# `services:` block. This leg exists because the first attempt to solve that
# chmod-ed the node with `|| true`, which could not work and failed INVISIBLY:
# the only symptom was pasta refusing, two layers away, in a leg that takes a
# minute to reach. `test -r` and `test -w` are the whole check and they run in
# the same second as the rest of this section.
if runner sh -c 'test -r /dev/net/tun && test -w /dev/net/tun'; then
	ok "/dev/net/tun is openable by the runner user, so pasta can build a network for a service container"
else
	bad "/dev/net/tun is NOT openable by the runner user - every 'services:' block fails with 'pasta failed: Failed to open() /dev/net/tun', two layers from here. Check the 'usermod -aG 0 runner' in the Dockerfile and that --device /dev/net/tun is passed"
fi

if runner sh -c 'ldconfig -p | grep -q libmagic'; then
	ok "libmagic is present, for api/pyproject.toml's python-magic"
else
	bad "libmagic is missing - Fedora calls it file-libs, and Debian calls it libmagic1t64; the name is the trap either way"
fi

# GIT'S VERSION IS THE ONE THAT DEGRADES RATHER THAN FAILS. actions/checkout
# needs 2.18 or newer to use git at all; below that it silently takes the tarball
# path and the checkout has no .git.
gitver=$(runner git --version 2>/dev/null | awk '{print $3}')
gitmaj=${gitver%%.*}
gitmin=$(printf '%s' "$gitver" | cut -d. -f2)
if [ -n "$gitmaj" ] && { [ "$gitmaj" -gt 2 ] || { [ "$gitmaj" -eq 2 ] && [ "$gitmin" -ge 18 ]; }; }; then
	ok "git is $gitver, so actions/checkout uses git rather than the tarball fallback"
else
	bad "git is '${gitver:-absent}' - actions/checkout would fall back to a REST tarball with no .git, and upskald's changed-file logic then runs everything"
fi

# THE SEEDED TREE IS THE VERSION THE Dockerfile CLAIMS, read out of the Dockerfile
# rather than repeated here. A second literal is a second thing to forget - the
# argument bin/conduct-runner-smoke.sh makes for CLAUDE_CODE_VERSION.
want=$(sed -n 's/^ARG GITHUB_RUNNER_VERSION=//p' "$ROOT/apps/github-runner/Dockerfile" | tail -1)
seed=$(runner cat /opt/actions-runner-seed/.seed-version 2>/dev/null | tr -d '\r\n')
if [ -n "$want" ] && [ "$want" = "$seed" ]; then
	ok "the seeded runner tree is $seed, matching the Dockerfile's ARG"
else
	bad "the seeded runner tree is '${seed:-absent}' but the Dockerfile asks for '${want:-absent}' - this image did not build from this checkout"
fi

if runner test -x /opt/actions-runner-seed/run.sh; then
	ok "run.sh is present and executable in the seed"
else
	bad "no executable run.sh in /opt/actions-runner-seed"
fi

# THE BAKED PYTHON, WHICH IS WHAT LETS THE BASE BE FEDORA AT ALL.
# actions/setup-python resolves prebuilt CPython from actions/python-versions,
# whose assets are published per UBUNTU release; on this base it would find no
# manifest entry and fail naming the manifest rather than the image. It checks
# RUNNER_TOOL_CACHE FIRST, so a version placed there is used and the network is
# never consulted - which is why upskald's workflows need no change.
#
# BOTH HALVES ARE ASSERTED, because the marker is the half that is easy to miss:
# without `<version>/x64.complete` the directory reads as a partial extraction,
# is ignored, and setup-python goes to the network anyway. A check on the
# interpreter alone would pass while the mechanism did nothing.
pyv=$(runner sh -c 'ls /opt/hostedtoolcache/Python 2>/dev/null | head -1' | tr -d '\r\n')
case "$pyv" in
	3.13.*)
		if runner sh -c "test -f /opt/hostedtoolcache/Python/$pyv/x64.complete" &&
		   runner sh -c "/opt/hostedtoolcache/Python/$pyv/x64/bin/python3 -V >/dev/null 2>&1"; then
			ok "Python $pyv is in the tool cache with its .complete marker, so actions/setup-python resolves 3.13 without the network"
		else
			bad "Python $pyv is in the tool cache but either the .complete marker is missing or the interpreter does not run - setup-python will go to the network and fail, because actions/python-versions publishes Ubuntu assets and this base is Fedora"
		fi ;;
	'')
		bad "nothing is in /opt/hostedtoolcache/Python - actions/setup-python would try to download an Ubuntu asset on a Fedora base, and upskald asks for 3.13 in four jobs" ;;
	*)
		bad "the tool cache holds Python '$pyv', not a 3.13 - upskald's setup-toolchains asks for 3.13 and would go to the network for it" ;;
esac

# THE VERSION AGAINST UPSTREAM, WRITTEN DOWN RATHER THAN ACTED ON. GitHub
# enforces a minimum runner version and a runner too far below it stops being
# given jobs - a job that queues for ever while the runner shows online and idle.
# The lane's tree updates itself, so this is not a gate; it is the number
# ci.runner_version grades, recorded here because this is the one moment a week
# when an outbound call to api.github.com is already warranted.
#
# A FAILED LOOKUP IS A note, NEVER A FAIL. An upstream outage must not stop a
# promotion, and this is unauthenticated so it is rate limited at 60/hour.
latest=$(curl -fsS --max-time 20 https://api.github.com/repos/actions/runner/releases/latest 2>/dev/null |
	jq -r '.tag_name // empty' 2>/dev/null | sed 's/^v//')
if [ -z "$latest" ]; then
	note "could not read actions/runner's latest release - ci.runner_version will grade on the age of its last successful check"
elif [ "$latest" = "$want" ]; then
	ok "the pin $want is upstream's latest"
else
	note "the pin is $want and upstream is $latest - the SEED is behind, which is harmless because a lane's tree self-updates; ci.runner_version grades the tree"
fi
mkdir -p "$(dirname "${GITHUB_RUNNER_VERSION_STAMP:-$FLEET_ROOT/.runner-version-latest}")" 2>/dev/null || true
printf 'runner_version_latest=%s\nrunner_version_checked_at=%s\n' \
	"${latest:-}" "$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
	> "${GITHUB_RUNNER_VERSION_STAMP:-$FLEET_ROOT/.runner-version-latest}" 2>/dev/null || true

# ------------------------------------------------------------------------------
say "Mounts"
# ------------------------------------------------------------------------------
# EACH ASSERTED BY FILESYSTEM TYPE, NOT BY PATH, and that is the whole point of
# this section. docs/known-state.md records what a tmpfs $TMPDIR did: Chromium
# put 1,925 MB across 969 UNLINKED files in it, which pinned the cgroup at
# MemoryHigh with oom_kill at 0, nothing failed, nothing paged, and `du` reported
# 49 MB because an unlinked file has no directory entry. A later "simplification"
# back to a tmpfs would keep the path and lose the point, and a check on the path
# would not notice.
for pair in "/home/runner:HOME" "/opt/hostedtoolcache:RUNNER_TOOL_CACHE" \
            "/scratch:TMPDIR" "/opt/actions-runner:the runner tree" \
            "/var/lib/nested-storage:the nested graph root"; do
	path=${pair%%:*}
	what=${pair#*:}
	fstype=$(runner stat -f -c %T "$path" 2>/dev/null | tr -d '\r\n')
	if [ -z "$fstype" ]; then
		bad "$what ($path) does not exist in the image - a read-only rootfs cannot create a mount point at run time"
	elif [ "$fstype" = tmpfs ]; then
		bad "$what ($path) is tmpfs - a tmpfs inside a container is charged to its MEMORY budget and is unreclaimable; see docs/known-state.md"
	elif ! runner sh -c "touch $path/.smoke-write && rm -f $path/.smoke-write"; then
		bad "$what ($path) is not writable by the runner user - the lane directories need 'podman unshare chown -R 1000:1000'"
	else
		ok "$what is $fstype and writable"
	fi
done

# /tmp IS tmpfs AND MUST BE, and it must also be exec: noexec there breaks uv's
# managed interpreters and node's temporary binaries, and the failure names
# neither.
if runner sh -c 'printf "#!/bin/sh\necho x\n" > /tmp/x && chmod +x /tmp/x && /tmp/x' >/dev/null 2>&1; then
	ok "/tmp is writable and executable"
else
	bad "/tmp rejected an exec - uv's managed interpreters and node's temporary binaries both break, and neither error says so"
fi

if runner sh -c 'touch /usr/local/bin/smoke 2>/dev/null && exit 1; exit 0'; then
	ok "the root filesystem rejects a write, so --read-only is in force"
else
	bad "the root filesystem accepted a write - --read-only is not in force"
fi

# ------------------------------------------------------------------------------
say "The nested engine"
# ------------------------------------------------------------------------------
# THIS SECTION IS WHY THIS FILE IS LONGER THAN ITS SIBLING. Everything above
# proves the image contains things. These four legs prove it can do the one thing
# the whole design rests on, and every one of them fails as a hung job rather
# than as an error.

if runner podman info >/dev/null 2>&1; then
	ok "the nested rootless podman starts"
else
	bad "the nested podman will not start - run 'podman info' in this image by hand with 'semodule -DB' first, because a dontaudit rule means an SELinux denial here arrives with NO AVC logged"
fi

# THE DRIVER, ASSERTED RATHER THAN HOPED FOR. Native overlay cannot stack on the
# outer container's own overlay rootfs, so a graph root on the container
# filesystem silently falls back to vfs - which copies every layer in full at
# every pull. It works; it is just eight times slower to start a service, for
# ever, with nothing saying why. The lane's graph root is a host bind mount on
# XFS with ftype=1 (measured) precisely so this reads `overlay`.
driver=$(runner podman info --format '{{.Store.GraphDriverName}}' 2>/dev/null | tr -d '\r\n')
case "$driver" in
	overlay) ok "the nested graph driver is overlay" ;;
	vfs)     bad "the nested graph driver is vfs - every layer is a full copy at every pull. The graph root is meant to be the lane's bind mount on XFS; see apps/github-runner/storage.conf" ;;
	'')      bad "could not read the nested graph driver at all" ;;
	*)       bad "the nested graph driver is '$driver', which is neither overlay nor vfs - this proves nothing either way" ;;
esac

# A PULL, WHICH IS THE FIRST THING A `services:` JOB DOES. It also proves
# apps/github-runner/registries.conf, because `alpine` here is unqualified in
# exactly the way a workflow writes `postgres:16-alpine` - podman refuses a short
# name with no search list, and the job log calls that a bad image reference.
if runner podman pull -q alpine >/dev/null 2>&1; then
	ok "the nested engine resolves and pulls an UNQUALIFIED short name, so registries.conf is in force"
else
	bad "the nested engine could not pull 'alpine' - either the engine is broken or registries.conf is not being read, and a workflow's 'image: postgres:16-alpine' fails the same way"
fi

# THE LEG THIS WHOLE FILE EXISTS FOR.
#
# Podman drives healthchecks with transient systemd timers - visible on the host,
# where `systemctl --user list-timers` shows one per healthchecked container.
# There is no systemd in here, so `--health-cmd` only warns and the status stays
# `starting` for ever. GitHub's runner polls exactly that field in an uncapped
# loop before it will run a job's steps.
#
# apps/github-runner/scripts/podman-healthcheck-loop.sh is what closes it, and this is the
# assertion that it does. It is deliberately run through the REAL entrypoint
# rather than by calling the loop directly, because the loop being present and
# the loop being STARTED are different facts and only the second one matters.
# THIS LEG USED TO TEST A DIFFERENT SHAPE FROM THE ONE THAT FAILS. It ran
# `podman run -d ... alpine sleep 120` against an image already in the store, and
# passed on every build of an image whose `services:` jobs have never once
# worked. The runner does none of those things: it `pull`s, then `create`s, then
# `start`s, and its image is postgres:16-alpine at eleven layers rather than
# alpine at one. So the sequence and the image now match what upskald's
# api-checks actually issues.
#
# IT IS STILL SHELL-DRIVEN AND THEREFORE STILL BLIND to whatever Runner.Worker
# does differently - which is the open question, since the identical sequence
# fails in fifteen seconds under the real runner and has never once failed here.
# This leg proves the engine CAN do it; it cannot prove a job will.
#
# AND IT IS BLIND A SECOND WAY, WHICH IS THE ONE THAT MATTERS MORE. `runner()`
# builds a FRESH lane every run. The failure this leg is shaped after went away
# when both live lanes were wiped by hand and returned on lanes carrying ~2.5 GB
# of state from twenty-odd jobs, so a fresh store is the one condition under
# which it has never been seen. That is not a flaw in this leg, it is a property
# of a smoke test: it grades an IMAGE, and the defect is in a lane. Two separate
# failures have now hidden here for exactly that reason - the db.sql runroot
# split, which this file records at the runtime-directory leg, and this one.
#
# WHAT CAN SEE IT is bin/verify-host.sh, which reads live lanes: `ci.runtime_dir`
# for the first and `ci.lane_store` for this one, the latter reporting a lane
# that has healed itself after the docker shim exhausted its retries. Do not add
# an assertion here that appears to cover it - a green tick on a fresh lane is
# how both of these got through.
say "  (pulling and starting a real service container - this takes about a minute)"
# shellcheck disable=SC2016  # this script runs in the CONTAINER, so nothing in it may expand here
hc=$(runner bash -c '
	podman pull -q postgres:16-alpine >/dev/null 2>&1
	cid=$(podman create --name hc -p 5432:5432 \
		--health-cmd "pg_isready -U u -d d" --health-interval 10s \
		--health-timeout 5s --health-retries 5 \
		-e POSTGRES_USER=u -e POSTGRES_PASSWORD=p -e POSTGRES_DB=d \
		postgres:16-alpine 2>&1) || {
		echo "START-FAILED: create: $(printf "%s" "$cid" | tr "\n" " " | cut -c1-140)"; exit 0; }
	out=$(podman start "$cid" 2>&1) || {
		echo "START-FAILED: $(printf "%s" "$out" | tr "\n" " " | cut -c1-150)"; exit 0; }
	# NINETY, NOT FORTY. The old leg watched alpine with a `true` healthcheck on a
	# 3s interval, which goes healthy almost at once. postgres declares a 10s
	# interval and 5 retries, so the FIRST verdict cannot arrive before 10s and a
	# slow start legitimately takes several of them. Forty seconds would fail a
	# healthy database and block a promotion for it - the exact direction
	# podman-healthcheck-loop.sh argues against.
	for _ in $(seq 1 90); do
		s=$(podman inspect --format "{{if .Config.Healthcheck}}{{print .State.Health.Status}}{{end}}" hc 2>/dev/null)
		case "$s" in healthy) echo healthy; exit 0 ;; unhealthy) echo unhealthy; exit 0 ;; esac
		sleep 1
	done
	echo "stuck:${s:-empty}"
' 2>/dev/null | tail -1 | tr -d '\r')
case "$hc" in
	healthy)
		ok "a service container reached 'healthy' - the healthcheck loop is running and the runner's wait will terminate" ;;
	stuck:starting)
		bad "health status is STILL 'starting' after 90s. This is the six-hour hang: apps/github-runner/scripts/podman-healthcheck-loop.sh is not running, or podman is not recording the healthcheck at all. Do NOT promote this image." ;;
	unhealthy)
		bad "a container whose healthcheck is 'true' came back UNHEALTHY - the loop is running the check far more often than the declared interval, which is how a slow-starting postgres gets failed before it is up" ;;
	START-FAILED*)
		bad "could not start a nested container with a healthcheck at all - ${hc#START-FAILED: }" ;;
	*)
		bad "health status ended as '${hc:-nothing}', which is none of the states this leg knows - the probe itself did not run" ;;
esac

# THE INTERACTION, NOT THE PARTS. Everything above can pass and a `services:` job
# still fail, because what a workflow actually does is reach a published port on
# localhost: upskald's api-checks connects to
# postgresql+asyncpg://...@localhost:5432/... and nothing else. The runner
# publishes a service container's port into its own namespace with `-p`, so this
# is that, end to end.
say "  (publishing a service port the way a workflow reaches it)"
# shellcheck disable=SC2016  # this script runs in the CONTAINER, so nothing in it may expand here
# REDIS RATHER THAN A HAND-ROLLED LISTENER, and that is not laziness. A busybox
# `nc -l -e` is not portable between alpine builds, so a listener written here
# could fail for a reason that is not the image's fault and block a promotion -
# a gate that fails on its own scaffolding is worse than no gate. redis:7-alpine
# is one of the three images upskald's own `services:` blocks name, so this leg
# is the real thing rather than an imitation of it.
pub=$(runner bash -c '
	out=$(podman run -d --replace --name svc -p 16379:6379 redis:7-alpine 2>&1) || {
		echo "START-FAILED: $(printf "%s" "$out" | tr "\n" " " | cut -c1-150)"; exit 0; }
	for _ in $(seq 1 30); do
		if timeout 2 bash -c "exec 3<>/dev/tcp/localhost/16379" 2>/dev/null; then
			echo reachable; exit 0
		fi
		sleep 1
	done
	echo unreachable
' 2>/dev/null | tail -1 | tr -d '\r')
case "$pub" in
	reachable)   ok "a published service port answers on localhost, which is what a workflow's DATABASE_URL does" ;;
	unreachable) bad "a nested container published a port and localhost could not reach it - every services: job would fail to connect" ;;
	*)           bad "the published-port probe did not run: '$pub'" ;;
esac

# THE SHIM'S STDOUT IS LOAD-BEARING, AND THIS IS WHAT MAKES IT SAFE TO INSTRUMENT.
#
# /usr/bin/docker is no longer podman-docker's two-liner - it is
# apps/github-runner/scripts/docker-shim.sh, which adds a post-mortem to a failing
# `start`. DockerCommandManager.cs reads container ids straight off stdout, so a
# single stray byte there - a banner, a diagnostic, a trailing blank line - breaks
# EVERY job that uses a service container, not just the failing ones. That is a
# far worse outcome than the bug the instrumentation exists to catch.
#
# So the assertion is on the SHAPE of stdout: `docker create` must emit a bare
# 64-character hex id and nothing else. The banner podman-docker prints is
# silenced by /etc/containers/nodocker in the image, and this leg is what would
# notice if that stopped working.
# shellcheck disable=SC2016  # this runs in the CONTAINER, so nothing may expand here
shim=$(runner sh -c '
	id=$(docker create --name shimprobe alpine true 2>/dev/null)
	docker rm -f shimprobe >/dev/null 2>&1
	case "$id" in
		*[!0-9a-f]*) echo "DIRTY:$(printf %s "$id" | tr "\n" " " | cut -c1-70)" ;;
		"")          echo EMPTY ;;
		*)           if [ ${#id} -ge 64 ]; then echo CLEAN; else echo "SHORT:${#id}"; fi ;;
	esac
' 2>/dev/null | tail -1 | tr -d '\r')
case "$shim" in
	CLEAN)
		ok "the docker shim returns a bare container id on stdout, so the runner can still parse one" ;;
	DIRTY*)
		bad "the docker shim put something other than a container id on stdout (${shim#DIRTY:}). DockerCommandManager.cs parses this - every services: job breaks. Check apps/github-runner/scripts/docker-shim.sh writes ONLY to stderr, and that /etc/containers/nodocker exists" ;;
	EMPTY)
		bad "docker create produced NO stdout at all - the shim is swallowing it, and the runner would see an empty container id" ;;
	*)
		bad "the docker shim probe returned '${shim:-nothing}' - it did not run" ;;
esac

# THE RETRY IS THE ONE THING IN THIS IMAGE THAT CAN TURN A FAILURE INTO A PASS,
# so it is the one thing asserted from both directions.
#
# The shim retries a failing `docker start` twice, 2s then 5s apart, because
# upskald's api-checks fails there reliably and nine reproductions have not
# explained why. Three things have to remain true or the cure is worse:
#
#   it must still FAIL       - a service that is genuinely broken has to end the
#                              job, not be retried into a green tick
#   it must not touch STDOUT - the leg above covers the success path; this covers
#                              the failure path, where a retry could plausibly
#                              print an id twice
#   it must actually RUN     - a retry that silently does not happen is the same
#                              class as a check that cannot fire, so the elapsed
#                              time is measured rather than the intent trusted
#
# A container that does not exist is the cheapest reliable failure there is: it
# cannot half-succeed, and it costs the seven seconds the backoff declares.
# shellcheck disable=SC2016  # this runs in the CONTAINER, so nothing may expand here
rt=$(runner sh -c '
	t0=$(date +%s)
	out=$(docker start no-such-container-shimprobe 2>/tmp/shimerr); rc=$?
	el=$(( $(date +%s) - t0 ))
	n=$(grep -c "retry . of " /tmp/shimerr 2>/dev/null)
	# And the SECOND one by name. Counting alone passed a shim whose retry
	# counter was clobbered by the loop variable inside the post-mortem, so both
	# announcements read "retry 1 of 2" - and on a store with layers in it the
	# guard then broke the loop early and the second retry never ran at all. A
	# fresh lane hid that completely, which is why this asks for the number.
	n2=$(grep -c "retry 2 of " /tmp/shimerr 2>/dev/null)
	# And the attach guard: `docker start -a` returns the exit code OF THE
	# CONTAINER, so retrying one would run the container twice. Never retried.
	t1=$(date +%s)
	docker start -a no-such-container-shimprobe >/dev/null 2>&1
	ael=$(( $(date +%s) - t1 ))
	echo "rc=$rc len=${#out} el=$el n=$n n2=$n2 ael=$ael"
' 2>/dev/null | tail -1 | tr -d '\r')

eval "$(printf %s "$rt" | tr ' ' '\n' | grep -E '^(rc|len|el|n|n2|ael)=[0-9]+$' | sed 's/^/shim_/')"
if [ -z "${shim_rc:-}" ]; then
	bad "the docker shim retry probe returned '${rt:-nothing}' - it did not run, so nothing here is asserted"
elif [ "$shim_rc" = 0 ]; then
	bad "'docker start' on a container that does not exist EXITED 0 - the shim is converting a failure into a success, which would let a broken service container pass a job. See apps/github-runner/scripts/docker-shim.sh"
elif [ "${shim_len:-1}" != 0 ]; then
	bad "a failing 'docker start' put $shim_len bytes on stdout - the retry is echoing something DockerCommandManager.cs would parse as a container id"
elif [ "${shim_n:-0}" -lt 2 ]; then
	bad "the shim announced ${shim_n:-0} retries and should announce 2 - the retry path did not run, so this leg proves nothing about it"
elif [ "${shim_n2:-0}" != 1 ]; then
	bad "the shim never announced 'retry 2 of 2' - its retry counter is being overwritten, which in a POSIX shell means some function it calls shares the variable. Both announcements reading 'retry 1' also means the loop guard is comparing the wrong number"
elif [ "${shim_el:-0}" -lt 6 ]; then
	bad "a failing 'docker start' took ${shim_el}s and the declared backoff is 2s+5s - the retries were not actually attempted"
elif [ "${shim_ael:-9}" -ge 2 ]; then
	bad "'docker start -a' took ${shim_ael}s, so it WAS retried - an attached start returns the container's own exit code and retrying runs the container a second time"
else
	ok "the shim retries a failing 'docker start' twice (${shim_el}s), still fails, keeps stdout empty, and does not retry an attached start"
fi

# THE OTHER HALF OF THE SHIM'S CONTRACT, AND IT IS NOT ABOUT THIS SCRIPT AT ALL.
# When the retries are exhausted the shim leaves two files in $HOME - a
# breadcrumb and its own post-mortem - because $HOME is a bind mount and is the
# only part of an ephemeral lane that outlives it. bin/github-runner.sh reads the
# breadcrumb at the top of its next cycle, folds the post-mortem into a forensic
# capture and resets the lane. Nothing else in that chain can be tested from
# here, but its FIRST link can, and it is the link that fails silently: a
# `>` into an unwritable $HOME writes nothing and, correctly, changes no exit
# code, so a lane would simply stop healing itself with every other leg green.
#
# The leg above has just failed a `docker start` on purpose, so both files exist
# by now or they never will.
shim_flag="$LANE/home/.docker-shim-start-failed"
shim_pm="$LANE/home/.docker-shim-postmortem.log"
if ! podman unshare test -f "$shim_flag" 2>/dev/null; then
	bad "the shim exhausted its retries and left no .docker-shim-start-failed in \$HOME - bin/github-runner.sh has no other way to learn a lane needs healing, so the lane would stay broken with nothing failed and nothing unhealthy"
elif ! podman unshare test -s "$shim_pm" 2>/dev/null; then
	bad "the shim left its breadcrumb but no .docker-shim-postmortem.log - the forensic capture would then hold only post-cleanup store metadata, which was MEASURED to be byte-for-byte the shape of a healthy store"
else
	# THE `wc` GOES THROUGH THE NAMESPACE TOO. Writing `wc -l <"$shim_pm"` looks
	# equivalent and is not: the redirection is performed by THIS shell, as
	# `core`, against a file owned by the subuid container uid 1000 maps to. It
	# happens to work today because the file is 0644 and `core` reads it as
	# other - so the day the shim's umask changes, the count silently becomes an
	# empty string inside a PASSING message. Same class as the `du` that read
	# half a lane.
	ok "a lane that cannot start a container says so in \$HOME, with the post-mortem beside it ($(podman unshare wc -l "$shim_pm" 2>/dev/null | awk '{print $1}') lines) - the driver heals on both"
fi

# ------------------------------------------------------------------------------
say "Containment"
# ------------------------------------------------------------------------------
# A forbidden edge is proven BY IP from a throwaway container, never by name
# resolution: a container has one address per network it joins, a name proves
# only one of them, and the unit files look identical either way.
#
# THE EXIT CODE IS THE FINDING, NOT MERELY ITS SIGN. bash's /dev/tcp returns 1
# immediately on ECONNREFUSED - the packet arrived and the port was shut - and
# `timeout` returns 124 when the connection is silently dropped. Only 124 is a
# blocked edge. Reporting "nonzero" would call a refusal a success.
# THE STDERR IS KEPT, AND THAT IS NOT TIDINESS. The "neither 124 nor 1" arm is
# the one that says the probe proved nothing - and without podman's own message
# it cannot say WHY, which leaves whoever reads it to reproduce the whole run by
# hand. An early version of this file did exactly that, four times in one report,
# for a single cause.
probe() {
	local label="$1" host="$2" port="$3" want="$4"
	local rc=0 err=""
	# THE TIMEOUT IS ON THE HOST SIDE, WRAPPING PODMAN, AND THAT IS THE FIX FOR A
	# CLASS RATHER THAN A SYMPTOM. `timeout` INSIDE the container becomes pid 1,
	# because the entrypoint execs its arguments - and GNU timeout puts its child
	# in a new process group so it can signal the whole group, which as pid 1
	# fails. It then returns **125**, its own "timeout itself failed" code, with
	# nothing on stderr. Every containment leg reported that, and this function
	# correctly refused to read it as either dropped or refused: it said four
	# times that it had proved nothing, and it was right - the cause was in the
	# probe.
	#
	# TWO ATTEMPTS TO FIX IT IN THE CONTAINER BOTH FAILED, AND FOR THE SAME
	# REASON THE MEASUREMENTS DISAGREED. `sh -c 'timeout ...'` with a SINGLE
	# command execs it, so timeout is pid 1 again; and `--foreground` was measured
	# as working only in a probe written `timeout ... ; echo rc=$?`, where the
	# second command suppresses that exec. One stray semicolon in a throwaway test
	# is the whole difference, and it pointed the fix the wrong way twice.
	#
	# Out here timeout is an ordinary process, and 124 still means what it has to
	# mean: podman was killed because the connect never came back. Verified
	# end to end against all three outcomes, run exactly as this function runs
	# them: windmill-db 124, the host publish 124, the host's own ssh 1, and
	# api.github.com 0.
	#
	# 30 SECONDS, NOT 6, because the container has to start first - runner-init
	# waits for the nested engine's socket before it execs anything, so a few
	# seconds are gone before the connect is even attempted.
	#
	# A DROPPED PROBE COSTS 135 SECONDS, NOT 30, AND THAT IS NOT A HANG. Measured
	# off the journal on 2026-08-26 - 12:28:13, 12:30:28, 12:32:43, 12:34:58,
	# 12:37:13, exactly 2m15s apart. GNU timeout sends SIGTERM at 30s and then
	# WAITS for the child; podman has to stop a container whose only process is
	# blocked in connect() and then honour `--rm`, and that teardown is the other
	# hundred seconds. The verdict is still correct - 124 means podman was killed
	# because the connect never came back - but four dropped edges are nine
	# minutes of a ten-minute smoke run, and somebody watching the journal will
	# think it has stopped.
	#
	# `timeout -k` IS NOT THE FIX, and it is the obvious one. SIGKILL during
	# teardown leaves a container `--rm` never removed, which agents.runners_leaked
	# then reports - trading seven minutes on a WEEKLY job for a leak that needs a
	# person. Recorded rather than optimised.
	err=$(timeout 30 podman run --name "$SMOKE_TAG-$RANDOM" "${RUNNER_ARGS[@]}" \
		"$IMAGE" bash -c "exec 3<>/dev/tcp/$host/$port" 2>&1 >/dev/null) || rc=$?
	err=$(printf '%s' "$err" | tr '\n' ' ' | cut -c1-160)
	case "$want:$rc" in
		dropped:124)   ok "$label is dropped (rc 124)" ;;
		dropped:1)     bad "$label is REFUSED, not dropped - the packet arrived and only the port was shut, which is not a blocked edge" ;;
		dropped:*)     bad "$label returned rc $rc, which is neither 124 (dropped) nor 1 (refused) - the probe itself did not run, so this proves nothing either way. podman said: ${err:-nothing}" ;;
		open:0)        ok "$label is reachable (rc 0)" ;;
		open:*)        bad "$label returned rc $rc, expected 0" ;;
		record:0)      note "$label is REACHABLE (rc 0) - recorded rather than graded; see docs/ci.md's accepted risks" ;;
		record:124)    ok "$label is dropped (rc 124)" ;;
		record:*)      note "$label returned rc $rc - recorded rather than graded. podman said: ${err:-nothing}" ;;
	esac
}

lan=$(ip route get 1.1.1.1 2>/dev/null | awk '{for (i = 1; i < NF; i++) if ($i == "src") print $(i + 1)}')
gw=$(ip route get 1.1.1.1 2>/dev/null | awk '{for (i = 1; i < NF; i++) if ($i == "via") print $(i + 1)}')

if podman ps --format '{{.Names}}' | grep -qx windmill-db; then
	dbip=$(podman inspect windmill-db --format '{{range .NetworkSettings.Networks}}{{.IPAddress}}{{end}}')
	probe "windmill-db at $dbip:5432" "$dbip" 5432 dropped
else
	note "windmill-db is not running, so the control plane edge cannot be probed"
fi

if podman ps --format '{{.Names}}' | grep -qx prometheus; then
	pmip=$(podman inspect prometheus --format '{{range .NetworkSettings.Networks}}{{.IPAddress}}{{end}}')
	probe "prometheus at $pmip:9090" "$pmip" 9090 dropped
else
	note "prometheus is not running, so that segment edge cannot be probed"
fi

if [ -n "$lan" ]; then
	probe "caddy via the host publish $lan:443" "$lan" 443 dropped
	probe "jellyfin via the host publish $lan:8096" "$lan" 8096 dropped
else
	note "the host's LAN address could not be derived, so the publish edges were not probed"
fi

# THE EDGE NOBODY HAD PROBED, AND IT IS RECORDED RATHER THAN GRADED.
# bin/conduct-runner-smoke.sh probes the host's published ports and the host
# itself, and nothing on this machine has ever probed another device on the LAN.
# isolate=true constrains bridge-to-bridge traffic, not egress, so this very
# likely ANSWERS - which means a workflow can reach the router's admin interface.
# That is an accepted risk in docs/ci.md rather than a surprise to find later,
# and it is graded as a note precisely so that the honest answer, whichever it
# is, does not block a promotion. If it ever comes back dropped, that is a
# change worth knowing about too.
if [ -n "$gw" ]; then
	probe "the router at $gw:80" "$gw" 80 record
else
	note "the default gateway could not be derived, so the LAN edge was not probed"
fi

# EGRESS MUST WORK, and it is the cheapest proof that a runner can be a runner.
if runner curl -fsS --max-time 20 https://api.github.com/zen >/dev/null 2>&1; then
	ok "api.github.com is reachable from an isolate=true network"
else
	bad "api.github.com is unreachable - a lane could not register, let alone run a job"
fi

# ------------------------------------------------------------------------------
# The negatives that are actually true here, replacing the two this image
# deliberately does not satisfy.
# ------------------------------------------------------------------------------
# THE SOCKET CHECK IS THE ONE THAT MATTERS AND IT IS TWO ASSERTIONS, NOT ONE.
# Testing only that the host's socket paths are absent would still pass if
# somebody later bind-mounted the host socket at a different path - so the second
# half asks the endpoint a job actually talks to which store it is using, and
# requires the lane's own.
if runner sh -c 'test ! -e /run/user/1000/podman/podman.sock && test ! -e /var/run/docker.sock'; then
	ok "neither of the host's container sockets is visible at its usual path"
else
	bad "a host container socket is visible inside the lane - that is root-equivalent for 'core' and the whole three-tier design rests on it being unreachable"
fi

# THIS LEG USED TO PROVE SOMETHING ELSE THAN IT CLAIMED. It ran
# `docker info` and reported "the endpoint DOCKER_HOST points at" - but `docker`
# is apps/github-runner/scripts/docker-shim.sh, which execs the LOCAL podman;
# podman honours CONTAINER_HOST, not DOCKER_HOST, and the shim passes neither
# --remote nor --url. So it measured the local engine's graph root and asserted
# nothing whatsoever about the socket. Both are worth knowing, so both are asked
# - the local engine by the shim, and the socket by an explicit --remote.
root=$(runner docker info --format '{{.Store.GraphRoot}}' 2>/dev/null | tr -d '\r\n')
if [ "$root" = /var/lib/nested-storage ]; then
	ok "the engine a job's 'docker' calls reach is the nested one, on the lane's own store"
else
	bad "docker info reports graph root '${root:-nothing}', not /var/lib/nested-storage - a job's containers are not going where this design says they go"
fi

# shellcheck disable=SC2016  # $DOCKER_HOST is the CONTAINER's, not this shell's
sockroot=$(runner sh -c 'podman --remote --url "$DOCKER_HOST" info --format "{{.Store.GraphRoot}}"' 2>/dev/null | tr -d '\r\n')
if [ "$sockroot" = /var/lib/nested-storage ]; then
	ok "the socket DOCKER_HOST names answers, and serves the same store"
else
	bad "nothing usable answered on DOCKER_HOST (got '${sockroot:-nothing}') - runner-init starts 'podman system service' on it and an action using the Docker API rather than the CLI would find no daemon"
fi

# THE ENGINE'S RUNTIME STATE MUST NOT SHARE A FILESYSTEM WITH THE JOB'S SCRATCH.
# It did: XDG_RUNTIME_DIR was /tmp/podman-run, so podman's locks, exit files,
# rootless network state and the pause pid file that owns the user namespace
# every nested layer is mounted into sat on the 1777, 512 MB tmpfs a job's steps
# write to. A step that fills it or sweeps it takes the engine with it.
#
# THE SECOND HALF ASKS THE ENGINE RATHER THAN THE FILE. storage.conf names a
# runroot and podman may ignore it - silently, the way graphroot loses to
# rootless_storage_path - so reading the file back would pass whatever happens.
#
# WHAT THIS LEG CANNOT SEE, AND IT IS THE FAILURE THAT ACTUALLY HAPPENED.
# `runner()` builds a FRESH lane every run, and the defect needs a lane that has
# already run work: libpod records its runroot in `db.sql` at the root of the
# graph root, that file outlives an image upgrade, and podman then uses the
# recorded value over both the environment and this file. A fresh lane has no
# db.sql to be stale, so this leg passed on an image whose live lanes were
# running two engines over one store. `ci.runtime_dir` in bin/verify-host.sh is
# the assertion that can see it, because it reads a RUNNING lane.
#
# It is kept because it still catches the configuration-level case - an image
# that ships its runtime directory on the job's own /tmp, or an uncapped /run -
# and those are real. It is not evidence about a split.
#
# THE CLASS, NOT THE INSTANCE: a fresh lane is this whole script's blind spot,
# and the service-container leg above carries the second example of it. Anything
# that needs a lane with history behind it belongs in bin/verify-host.sh, which
# reads the running ones.
# shellcheck disable=SC2016  # this runs in the CONTAINER, so nothing may expand here
rr=$(runner sh -c 'printf "%s|%s|%s" "$XDG_RUNTIME_DIR" "$(podman info --format "{{.Store.RunRoot}}" 2>/dev/null)" "$(df -m /run 2>/dev/null | tail -1 | awk "{print \$2}")"' 2>/dev/null | tail -1 | tr -d '\r\n')
xdg=${rr%%|*}
rest=${rr#*|}
runroot=${rest%%|*}
runmb=${rest##*|}
if [ -z "$xdg" ] || [ -z "$runroot" ] || [ -z "$runmb" ]; then
	bad "the runtime-directory probe returned '${rr:-nothing}' - it did not run, so nothing here is asserted"
elif [ "${xdg#/tmp}" != "$xdg" ]; then
	bad "XDG_RUNTIME_DIR is '$xdg' - the engine's runtime state is back on the tmpfs a job's own steps write to and can delete"
elif [ "${runroot#"$xdg"}" = "$runroot" ]; then
	bad "podman resolved its run root to '$runroot', which is not under XDG_RUNTIME_DIR '$xdg' - storage.conf and the environment disagree, and the environment is the one that wins"
elif [ -n "${runmb##*[!0-9]*}" ] && [ "$runmb" -gt 512 ]; then
	bad "/run inside the lane is ${runmb} MB - an unsized tmpfs is charged to the container's MEMORY budget, and this one is meant to be capped at 128 MB by bin/github-runner.sh"
else
	ok "the engine's runtime state is at $runroot, off the job's /tmp, on a ${runmb} MB capped tmpfs"
fi

# THE RUNNER TREE IS THE ONE MOUNT NOTHING EVER CLEANS, and two files in it can
# rewrite the environment of every job step. `Runner.Listener` reads `.env` at
# start-up and applies each KEY=VALUE to itself; `.path` replaces PATH the same
# way. Both are GitHub's documented mechanism for proxy settings on a self-hosted
# runner, and both are inherited by every `docker` call a workflow makes.
#
# `bin/github-runner.sh` seeds that tree once - `[ ! -x run.sh ]` - and its
# garbage collection clears `home/work`, `tmp` and `storage` and deliberately
# leaves `runner` alone, because the runner self-updates into it and must run
# ahead of the image's ARG. So a file written there under one image is read by
# every image after it, for ever, and nothing else on this host would notice.
#
# The seed is a verbatim extraction of GitHub's tarball plus `.seed-version`, and
# the tarball ships neither file - so their presence means something wrote them.
if runner sh -c 'test ! -e /opt/actions-runner/.env && test ! -e /opt/actions-runner/.path'; then
	ok "the runner tree carries no .env or .path, so nothing rewrites a job step's environment"
else
	bad "/opt/actions-runner/.env or .path exists - Runner.Listener applies both to every job step, and that tree is never re-seeded or garbage collected, so whatever they set outlives every image built after them. Read them before deleting: they are the only place a stale XDG_RUNTIME_DIR or DOCKER_HOST could survive an image upgrade"
fi

if runner sh -c 'test ! -d /var/home-server/config && test ! -d /mnt/media && test ! -d /var/home-server/cache/conduct'; then
	ok "no config/, no /mnt/media and no agent-fleet cache is reachable"
else
	bad "host state is mounted into the lane - sharing the fleet's caches would let a workflow poison the gate, and the mirror is worse because git clone --local hardlinks its object store"
fi

# ONE LINE THAT MAKES THE WHOLE CREDENTIAL DESIGN CHECKABLE. bin/github-runner.sh
# exists in the shape it does so that the token which can mint runners never
# enters a container. An assertion is cheap; the assumption is how a credential
# ends up in /proc/1/environ where a lockfile postinstall can read it.
if runner sh -c 'tr "\0" "\n" < /proc/1/environ | grep -qc GITHUB_RUNNER_PAT' >/dev/null 2>&1; then
	bad "GITHUB_RUNNER_PAT is present in the container's environment - it must never leave the host"
else
	ok "the organisation PAT is not in the container's environment"
fi

# ------------------------------------------------------------------------------
say "Result"
# ------------------------------------------------------------------------------
if [ "$fails" -eq 0 ]; then
	echo "  all checks passed - $IMAGE may be promoted"
	exit 0
fi
echo "  $fails check(s) FAILED - $IMAGE must not be promoted"
exit 1
