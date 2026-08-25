# ==============================================================================
# The CI lane: a GitHub Actions runner that can start containers of its own
# ------------------------------------------------------------------------------
# The fourth image built here rather than pulled, and the second that is not a
# service. Nothing starts it at boot: bin/github-runner.sh runs it as
# `podman run --rm` per job, under a transient systemd scope in app-ci.slice,
# with a just-in-time runner configuration minted on the host. See docs/ci.md.
#
# THE BASE IS A CONTAINER ENGINE, AND THAT IS THE WHOLE ARCHITECTURE OF THIS
# FILE. It was Ubuntu 24.04 first, chosen so actions/setup-python could resolve
# its Ubuntu-specific assets, and that image could not run a container at all.
# Measured on this host, as `runner` inside a rootless outer container:
#
#   running `/usr/bin/newuidmap 15 0 1000 1 1 2000 60000`:
#   newuidmap: write to uid_map failed: Operation not permitted
#
# with the requested ranges entirely inside the outer namespace's own map, with
# CAP_SETUID present, with newuidmap setuid-root on a rootfs mounted `rw`, and -
# checked with `semodule -DB` so dontaudit could not hide it - with NO AVC
# logged. Running the inner engine as container-root instead walked a chain of
# refusals (setns, then a read-only /proc/sys, then cgroup.subtree_control, then
# a proc mount) that ends at `--privileged`, which is not a posture for code that
# arrives in a pull request.
#
# podman 5.8.4 does it with podman's DEFAULT capabilities and SELinux still
# enforcing. Ubuntu 24.04 ships 4.9.3 and there is no maintained source of 5.x
# for it, so the base is the engine's own image - Fedora 44, which is also what
# uCore is built from, so this is the same podman the host runs rather than a
# second opinion about containers.
#
# WHAT THAT COSTS, and it is one thing: actions/setup-python resolves prebuilt
# CPython from actions/python-versions, whose assets are published per UBUNTU
# release, and on Fedora it would find no manifest entry. That is closed below by
# baking Python into RUNNER_TOOL_CACHE, which setup-python checks BEFORE it
# downloads anything - so upskald's workflows need no change at all.
#
# WHAT THIS IMAGE DOES NOT SHIP, and it is the interesting half. No Anthropic
# credential and no model CLI - that reaches exactly one container on this host
# and it is not this one. No host podman socket, no docker socket, no path into
# config/, /mnt/media or cache/conduct/. The nested engine is the ONLY container
# runtime a job can reach, and it dies with the job.
#
# Image: quay.io/podman/stable, github.com/actions/runner
# See:   stacks/infra/github-runner.build, bin/github-runner-smoke.sh, docs/ci.md
# ==============================================================================

FROM quay.io/podman/stable

# THE USER IS RENAMED RATHER THAN CREATED, and the reason is /etc/subuid.
# This base already has `podman` at uid 1000 with ranges that FIT INSIDE a
# rootless outer container - `podman:1:999` and `podman:1001:64535`, which stay
# under 65536 and step over uid 1000 itself. That is not an accident and it is
# exactly what a hand-written `runner:100000:65536` gets wrong: rootless podman
# maps this container's uids 1..65536 to core's subuid range, so anything above
# is outside the map and newuidmap refuses with `Invalid argument`, an error
# naming neither the file nor the reason.
#
# So the uid and its ranges are kept and only the name and home move, to the
# `runner` every GitHub Actions convention expects.
#
# SUDO IS PARITY, NOT CONVENIENCE. GitHub's hosted runners give `runner`
# passwordless sudo and a great many actions assume it. It gives away nothing
# this container did not already have: sudo cannot exceed the capability
# BOUNDING set, which is podman's default and no wider.
#
# `usermod -aG 0` IS FOR ONE DEVICE NODE, AND THE ALTERNATIVE DOES NOT WORK.
# Measured inside a rootless container here: `/dev/net/tun` arrives as
# `crw-rw---- 65534 0` - group 0 only - and the nested engine's pasta cannot give
# a DETACHED container a network without it, which is every `services:` block.
# The obvious answer, chmod-ing the node as container root in the entrypoint,
# returns EPERM: uid 65534 is not mapped into this namespace, so container root
# is not the owner and CAP_FOWNER does not reach it.
#
# WHAT IT COSTS, stated rather than waved past: `runner` gains group-0
# permissions inside this container. On this base that is close to nothing extra -
# root-owned files are 0644 and directories 0755, so "group" already grants what
# "other" does - and it buys nothing outside the container, where uid 1000 maps
# to a subuid that owns only the lane's own mounts.
RUN usermod -l runner -d /home/runner -m podman \
 && groupmod -n runner podman \
 && usermod -g 0 -aG 0 runner \
 && sed -i 's/^podman:/runner:/' /etc/subuid /etc/subgid \
 && printf 'runner ALL=(ALL) NOPASSWD:ALL\n' > /etc/sudoers.d/runner \
 && chmod 0440 /etc/sudoers.d/runner

# ONE DNF LAYER. Every name here was read out of the Fedora 44 repositories in a
# throwaway container rather than remembered, because three of them are not what
# they are called on the distribution this file used to be written against:
#
#   libmagic1t64        -> file-libs
#   liblttng-ust1t64    -> lttng-ust
#   liberation-fonts    -> liberation-sans-fonts  (the bare name does not exist)
#
# WHY THE LESS OBVIOUS ONES ARE HERE:
#   libicu, lttng-ust, krb5-libs, openssl-libs  the runner's bundled .NET will
#                                               not start without them and the
#                                               error names none of them
#   unzip        @actions/tool-cache shells out to it for a zip archive, which
#                is how oven-sh/setup-bun@v2 unpacks
#   zstd         actions/cache@v5 uses it and SILENTLY falls back to gzip when
#                it is absent, so every restore is slower and nothing says why
#   file-libs    api/pyproject.toml depends on python-magic, and pytest imports
#                the app
#   python3.13   see the tool cache below - Fedora 44's default python3 is
#                3.14.7 and upskald asks for 3.13
#   nodejs24     `node` ON PATH, WHICH HOSTED RUNNERS HAVE AND THIS DID NOT.
#                ubuntu-latest ships it at /usr/local/bin/node, so a workflow
#                never installs it and never declares it. prek's root-lint hook
#                spawns `node .../eslint` directly and the failure names the
#                HOOK, not the missing interpreter: "Failed to run hook
#                `root-lint` ... No such file or directory (os error 2)".
#                Deliberately NOT the runner's own externals/node24: that is an
#                implementation detail the runner replaces on self-update, and
#                putting it on PATH would tie every job to the runner version.
#   nodejs24-npm `npm` and `npx`, which the nodejs24 package does NOT carry -
#                it ships `node` alone. Hosted runners have both, and an action
#                shelling out to npx would fail the same quiet way.
#   nodejs24-full-i18n
#                LOCALE DATA. Fedora builds node `small-icu`, so Intl works and
#                answers with the input: Intl.DisplayNames(['en'],{type:'region'})
#                returns "NL" for NL rather than "Netherlands". Nothing throws and
#                nothing warns - a sort by display name simply comes out in a
#                different order, which is how upskald's
#                "orders countries by English display name, not ISO code" failed
#                ONE test of 4,460 and looked like flake. Hosted node is full-ICU,
#                so again no workflow declares what it depends on. The package is
#                version-locked to nodejs24 (1:24.18.0-1.fc44) and is data only.
#
# THE BROWSER LIBRARIES ARE NAMED RATHER THAN INSTALLED BY PLAYWRIGHT, which is
# the one place this image cannot follow apps/conduct-runner/Dockerfile.
# `playwright install-deps` supports Debian and Ubuntu only; on Fedora it exits
# without installing anything. So the chromium set is spelled out. It is a
# maintained list rather than a generated one, which is a real cost, and the
# thing that would catch it going stale is an e2e job actually running - which
# docs/ci.md says is the last wave and unproven until measured.
RUN dnf install -y --setopt=install_weak_deps=False \
      git git-lfs jq make gcc pkgconf rsync zip unzip zstd xz tar gzip wget \
      openssh-clients sudo findutils procps-ng which hostname podman-docker \
      python3.13 python3-devel nodejs24 nodejs24-npm nodejs24-full-i18n \
      libicu lttng-ust krb5-libs openssl-libs file-libs \
      alsa-lib atk at-spi2-atk cups-libs libdrm mesa-libgbm nspr nss pango \
      cairo libX11 libXcomposite libXdamage libXext libXfixes libXrandr \
      libxkbcommon libxshmfence liberation-sans-fonts \
 && dnf clean all

# THE TOOL CACHE, WHICH IS WHAT LETS THE BASE CHANGE WITHOUT TOUCHING upskald.
# actions/setup-python checks RUNNER_TOOL_CACHE first and only downloads when it
# finds nothing - so a version placed here is used, and the Ubuntu-only manifest
# is never consulted. GitHub's own images use exactly this path, which is why it
# is not somewhere tidier.
#
# THE `.complete` MARKER IS THE HALF THAT IS EASY TO MISS. Without it the
# directory is treated as a partial extraction and ignored, and setup-python goes
# to the network anyway - failing on Fedora for a reason that names the manifest
# rather than this file.
#
# 3.13 BECAUSE THAT IS WHAT upskald ASKS FOR. Fedora 44's default python3 is
# 3.14.7; `python3.13` is a parallel-installable 3.13.15. A workflow asking for
# any other minor gets the download path and fails, which is stated in docs/ci.md
# rather than left to be discovered - the alternative is baking every minor
# anybody might name.
# IT IS BAKED INTO A SEED PATH, NOT INTO THE MOUNT, and that is not tidiness.
# A lane bind-mounts its own directory over /opt/hostedtoolcache so downloads
# survive between jobs - which MASKS anything baked at that path, exactly as an
# empty $HOME masked the base image's own engine configuration. Measured: the
# smoke test reported `nothing is in /opt/hostedtoolcache/Python` against an
# image that demonstrably had it. runner-init copies the seed in when the lane's
# cache does not already have it.
RUN PYV=$(python3.13 -c 'import sys; print("%d.%d.%d" % sys.version_info[:3])') \
 && D="/opt/hostedtoolcache-seed/Python/${PYV}/x64" \
 && mkdir -p "$D/bin" \
 && ln -sf /usr/bin/python3.13 "$D/bin/python3" \
 && ln -sf /usr/bin/python3.13 "$D/bin/python" \
 && touch "/opt/hostedtoolcache-seed/Python/${PYV}/x64.complete" \
 && "$D/bin/python3" -V \
 && chown -R runner:runner /opt/hostedtoolcache-seed

# THE NESTED ENGINE'S CONFIGURATION. Deliberately only two files: this image's
# base already runs containers correctly, and the measured-working invocation
# needed no engine tuning at all, so every override here has to earn itself.
#
# registries.conf   the base searches three registries under `enforcing` short
#                   names, and a workflow's `image: postgres:16-alpine` is
#                   ambiguous across them. See that file.
# storage.conf      puts the nested image store on the lane's own bind mount
#                   rather than under $HOME, so bin/github-runner.sh can reclaim
#                   it without touching the caches beside it.
# containers.conf   the base's OWN podman-in-podman settings, moved out of the
#                   user's home because a lane bind-mounts over it. See that file.
COPY registries.conf /etc/containers/registries.conf.d/00-home-server.conf
COPY storage.conf /etc/containers/storage.conf
COPY containers.conf /etc/containers/containers.conf

# THE RUNNER TARBALL, WITH A CHECKSUM, which is what answers
# apps/conduct-runner/Dockerfile's own objection to this shape - it prefers an
# apt package precisely because a `curl | tar` normally has nothing verifying it.
# GitHub publishes the sha256 in the release notes and it is asserted before a
# single byte is extracted.
#
# THIS ARG IS A SEED, NOT THE RUNNING VERSION, and that distinction is the whole
# of how this image survives GitHub's minimum-version enforcement. A just-in-time
# configuration carries no `disableUpdate`, so the runner WILL update itself; the
# lane's runner tree is writable so that it can. What is on disk therefore runs
# ahead of this number, and ci.runner_version grades the tree rather than the
# ARG. Left read-only instead, the update fails, the runner exits, the lane mints
# a fresh registration and repeats - thousands of them against a 5,000/hour limit.
ARG GITHUB_RUNNER_VERSION=2.336.0
ARG GITHUB_RUNNER_SHA256=04cf0be1aff4c3ec3554466c39124ca250e3effd8873bb7e8d68535aa9505d5d
RUN set -eu \
 && url="https://github.com/actions/runner/releases/download/v${GITHUB_RUNNER_VERSION}/actions-runner-linux-x64-${GITHUB_RUNNER_VERSION}.tar.gz" \
 && curl -fsSL -o /tmp/runner.tar.gz "$url" \
 && echo "${GITHUB_RUNNER_SHA256}  /tmp/runner.tar.gz" | sha256sum -c - \
 && mkdir -p /opt/actions-runner-seed \
 && tar -xzf /tmp/runner.tar.gz -C /opt/actions-runner-seed \
 && rm -f /tmp/runner.tar.gz \
 && printf '%s\n' "$GITHUB_RUNNER_VERSION" > /opt/actions-runner-seed/.seed-version \
 && chown -R runner:runner /opt/actions-runner-seed

COPY scripts/runner-init.sh /usr/local/bin/runner-init
COPY scripts/podman-healthcheck-loop.sh /usr/local/bin/podman-healthcheck-loop

# THE DOCKER SHIM IS REPLACED, NOT WRAPPED AROUND. podman-docker owns
# /usr/bin/docker and ships it as two lines that exec podman; this is the same
# exec plus a post-mortem on a failing `start`, which is upskald's api-checks
# failure and has survived six synthetic reproductions. It writes to STDERR only
# - DockerCommandManager.cs parses container ids off stdout - and returns
# podman's own exit code untouched. A witness, not a gate.
#
# `nodocker` silences podman-docker's "Emulate Docker CLI" banner, which would
# otherwise appear on stderr before every diagnostic and once per docker call in
# every job log.
COPY scripts/docker-shim.sh /usr/bin/docker
RUN chmod 0755 /usr/local/bin/runner-init /usr/local/bin/podman-healthcheck-loop /usr/bin/docker \
 && touch /etc/containers/nodocker

# EVERY ONE OF THESE PATHS IS A REQUIRED MOUNT, and the failure when one is
# missing names neither the variable nor the path - the class
# apps/conduct-runner/Dockerfile documents for /opt/bun-cache. They are created
# HERE because a read-only rootfs cannot have a mount point created under it at
# run time, and bin/github-runner-smoke.sh asserts each one by filesystem type
# rather than by path.
#
# TMPDIR IS DISK-BACKED AND MUST STAY THAT WAY. A tmpfs inside a container is
# charged to its memory budget and is unreclaimable without swap, and the
# measurement is on record in docs/known-state.md: Chromium put 1,925 MB across
# 969 UNLINKED files in $TMPDIR, which pinned the cgroup at MemoryHigh with
# oom_kill at 0, nothing failed, nothing paged, and `du` reported 49 MB because
# an unlinked file has no directory entry. A later "simplification" back to a
# tmpfs would keep the path and lose the point, which is why the smoke test
# checks `stat -f` and not the mount table.
ENV HOME=/home/runner \
    XDG_RUNTIME_DIR=/tmp/podman-run \
    DOCKER_HOST=unix:///tmp/podman/podman.sock \
    RUNNER_TOOL_CACHE=/opt/hostedtoolcache \
    AGENT_TOOLSDIRECTORY=/opt/hostedtoolcache \
    TMPDIR=/scratch \
    LANG=C.UTF-8 \
    NPM_CONFIG_UPDATE_NOTIFIER=false \
    NPM_CONFIG_FUND=false \
    PIP_DISABLE_PIP_VERSION_CHECK=1
RUN mkdir -p /home/runner /opt/hostedtoolcache /opt/actions-runner \
             /var/lib/nested-storage /scratch \
 && chown runner:runner /home/runner /opt/hostedtoolcache /opt/actions-runner \
                        /var/lib/nested-storage /scratch

# NO `USER runner`, AND THE ENTRYPOINT IS WHY - it starts as container root for
# exactly two operations and then drops with `setpriv`, for good, before the
# runner is exec'd.
#
# THIS WAS NEARLY GOT WRONG ON A ONE-COMMAND MEASUREMENT. An interactive
# `podman run --rm alpine echo ok` inside a lane succeeds with no tap device at
# all, which looked like proof that podman 5 needed none. A DETACHED container -
# which is what every `services:` block is - does not:
#
#   Error: pasta failed with exit code 1:
#   Failed to open() /dev/net/tun: No such file or directory
#
# and `/dev/net/tun` arrives in a rootless container as `crw-rw---- 65534 0`,
# group 0 only, where uid 1000 cannot open it. So the device is passed in and the
# entrypoint opens it up inside this container's own /dev tmpfs, which reaches
# nothing outside it. Putting `runner` in group 0 instead would have granted
# group-0 access to every root-owned file in the image to buy one device.
#
# The general lesson is worth more than the fix: the cheap probe and the real
# workload took different code paths, and only the second one is the design.
WORKDIR /home/runner

# runner-init starts the nested engine and the healthcheck loop, waits for the
# socket to actually bind, and execs - so the runner keeps pid 1 and its
# signals, which is what makes a SIGTERM deregister an ephemeral runner cleanly
# rather than leaking the registration for a day.
ENTRYPOINT ["/usr/local/bin/runner-init"]
CMD ["bash"]
