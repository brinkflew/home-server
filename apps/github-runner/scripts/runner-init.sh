#!/bin/sh
# ==============================================================================
# Everything that has to be true before the runner takes pid 1
# ------------------------------------------------------------------------------
# Longer than apps/conduct-runner/runner-init's three lines, and every addition
# is something that otherwise fails in a way naming neither this file nor its
# cause.
#
# IT STARTS AS CONTAINER ROOT ONLY TO DROP, AND THE THING IT USED TO DO FIRST
# COULD NOT WORK. Measured inside a rootless container on this host:
#
#   crw-rw-rw-  65534 65534  /dev/fuse       <- any uid inside can open it
#   crw-rw----  65534     0  /dev/net/tun    <- group 0 only
#
# and pasta needs the tap device to give a DETACHED inner container a network -
# `pasta failed: Failed to open() /dev/net/tun` - which is every `services:`
# block. An interactive `podman run alpine echo ok` takes a different path and
# succeeds without it, which is how this was nearly concluded the other way.
#
# THE OBVIOUS FIX - chmod the node as container root - IS SILENTLY IMPOSSIBLE.
# The node is owned by 65534, an uid that is NOT MAPPED into this container's
# user namespace, so container root is not its owner and CAP_FOWNER does not
# reach it either. `chmod` returns EPERM. Worse, the first version of this file
# wrote it as `chmod ... || true`, so it failed INVISIBLY and the symptom
# arrived two layers away as pasta refusing to open a device that was plainly
# present. Group membership is what actually works, and it is granted in the
# Dockerfile where the trade can be read - see the `usermod -aG 0` there.
#
# THE SOCKET IS WAITED FOR, NOT SLEPT ON. `podman system service` binds in tens
# of milliseconds on an idle host and in rather more on one mid-transcode, so a
# fixed sleep is a race that passes on the machine it was written on. A job that
# loses it sees DOCKER_HOST pointing at nothing, which surfaces as
# `Cannot connect to the Docker daemon` - the error every guide on the internet
# answers with "start the daemon", and the daemon is starting.
#
# IT FAILS RATHER THAN CONTINUING. A runner that comes up without a container
# endpoint takes a job and fails it at the first `services:` block, and then
# takes the next one. Ten seconds of patience against a job that cannot possibly
# succeed is the right trade, and bin/github-runner.sh reads a non-zero exit here
# as a fault rather than as a completed job.
#
# THE HEALTHCHECK LOOP IS NOT OPTIONAL AND IS NOT A FALLBACK - see
# apps/github-runner/scripts/podman-healthcheck-loop.sh for why a `services:` job
# hangs for six hours without it. Started before the runner rather than after,
# because the runner can be handed a job the instant it registers.
#
# EXEC, so the runner keeps pid 1 and its signals. bin/github-runner.sh stops a
# lane with SIGTERM to pid 1, and the runner's own handler is what deregisters an
# ephemeral registration cleanly instead of leaking it for a day.
#
# See: apps/github-runner/Dockerfile, bin/github-runner.sh
# ==============================================================================

set -eu

# THE RUNTIME DIRECTORIES ARE MADE HERE OR THEY CANNOT BE MADE AT ALL, and that
# is the whole reason this branch still does something before it drops. They live
# under /run now rather than /tmp - see the Dockerfile's note on why - and /run
# arrives as a tmpfs at 0755 root:root, so uid 1000 cannot mkdir in it. Measured
# inside a lane: `mkdir: cannot create directory '/run/probe-dir': Permission
# denied`, with `runner` in group 0 and everything else about the container
# correct. Baking them into the image would not survive either: the tmpfs is
# mounted OVER /run, and while podman's tmpcopyup carries the image's content
# through, relying on it to carry ownership as well is a guess this does not need
# to make.
#
# 0700 because podman requires it and warns on every single invocation otherwise
# - thousands of lines in a job log - and because the socket's parent should not
# be readable by anything that is not the runner.
if [ "$(id -u)" = 0 ]; then
	mkdir -p "${XDG_RUNTIME_DIR:?}" "$(dirname "${DOCKER_HOST#unix://}")"
	chown 1000:0 "$XDG_RUNTIME_DIR" "$(dirname "${DOCKER_HOST#unix://}")"
	chmod 0700 "$XDG_RUNTIME_DIR"
	exec setpriv --reuid=1000 --regid=0 --init-groups -- "$0" "$@"
fi

# THE TOOL CACHE IS SEEDED, NOT BAKED, because the lane mounts its own over the
# image's path and would mask anything left there. Copied only when the lane has
# no copy of its own, so a cache that a previous job filled is left alone - and
# the Python that actions/setup-python resolves without touching the network is
# in there. See the Dockerfile's note on /opt/hostedtoolcache-seed.
# `cp -rp`, NEVER `cp -a`, AND THE DIFFERENCE IS ONE SELINUX FIELD.
# `-a` implies --preserve=all, which includes the CONTEXT - and the source is
# this container's own image layer, labelled with the MCS categories podman
# assigns per container. Copying that onto the lane's mount stamps the categories
# of whichever container happened to seed it, and the NEXT container - with a
# different pair - cannot read its own tool cache:
#
#   ls: cannot open directory '/opt/hostedtoolcache/Python': Permission denied
#
# with the directory plainly present and owned by the right uid. Measured:
# `container_file_t:s0:c676,c800` on the copy against `container_file_t:s0` on
# the mount around it. Without --preserve=context the copy inherits the parent
# directory's label, which is what every other file in the lane already has.
if [ -d /opt/hostedtoolcache-seed ] && [ ! -d "$RUNNER_TOOL_CACHE/Python" ]; then
	cp -rp /opt/hostedtoolcache-seed/. "$RUNNER_TOOL_CACHE/" 2>/dev/null || true
fi

# $HOME, $TMPDIR and the runner tree are bind mounts from the lane, so they
# exist. XDG_RUNTIME_DIR and the socket directory are on the container's own /run
# tmpfs and were created by the root branch above.
#
# ASSERTED RATHER THAN CREATED, because at this point creating them is not
# possible and pretending otherwise is how this fails quietly. Under /tmp the
# mkdir here always succeeded, so an entrypoint entered some other way still
# worked; under /run it would fail, and `mkdir -p ... || true` would turn that
# into podman silently choosing a fallback runtime directory and warning on every
# invocation for the rest of the job.
sock="${DOCKER_HOST#unix://}"
if [ ! -w "${XDG_RUNTIME_DIR:?}" ] || [ ! -w "$(dirname "$sock")" ]; then
	echo "runner-init: $XDG_RUNTIME_DIR or $(dirname "$sock") is not writable by" >&2
	echo "  uid $(id -u). Both live on the container's /run tmpfs and are created" >&2
	echo "  by this script's root branch - so this entrypoint was entered without" >&2
	echo "  ever being root, or /run was mounted after it ran." >&2
	exit 1
fi

# $HOME IS AN EMPTY BIND MOUNT ON A FRESH LANE, and podman stats $HOME/.config
# before it does anything else. Absent, it exits with
#   stat /home/runner/.config: no such file or directory
# and the socket below never binds - an error naming a directory nobody deleted.
# The engine's actual configuration lives in /etc, which nothing can mask; this
# is only the directory it expects to find.
mkdir -p "$HOME/.config" "$HOME/.local/share"

# THE STORE REMEMBERS WHERE THE ENGINE'S RUNTIME STATE USED TO LIVE, AND IT WINS.
# libpod keeps its state in `db.sql` at the root of the graph root, and that
# database records the runroot and tmpdir it was CREATED with. The graph root is
# a lane bind mount that survives every image upgrade, so changing
# XDG_RUNTIME_DIR leaves a database naming the old one - and podman does not
# error on the mismatch. It reads the recorded value and uses it.
#
# WHAT THAT PRODUCES IS A SPLIT ENGINE, reproduced synthetically three times:
#
#   /run/podman-run/libpod/tmp/   pause.pid ONLY   <- from XDG_RUNTIME_DIR
#   /tmp/podman-run/libpod/tmp/   alive, events, exits, persist  <- from db.sql
#
# with `podman info` reporting the database's runroot while the process holding
# the user namespace is registered under the environment's. containers/storage
# keeps overlay mount refcounts under the runroot, so two engines disagreeing
# about it can each believe the other mounted a layer - which is `docker create`
# succeeding and `docker start` opening `.containerenv` in an empty rootfs.
#
# ONLY db.sql IS REMOVED, NOT THE STORE. The images below it are the reason the
# store is a mount of its own, and re-pulling postgres on every path change would
# be a self-inflicted cost. libpod rebuilds the database on the next start; at
# this point in a lane's life no container exists for it to forget.
#
# THE TEST IS A STRING IN A FILE, NOT A PODMAN INVOCATION, because asking podman
# would start the very engine whose configuration is in question - and it would
# answer with the stale value it is being asked to detect.
#
# THIS IS THE BACKSTOP, NOT THE VISIBLE ONE. bin/github-runner.sh runs the lane
# with `--log-driver=none`, so everything this script writes to stderr is
# discarded - the message below included, and the socket and writability failures
# above it too. Those at least exit non-zero, which the driver reads as a fault;
# a silent repair would leave nothing at all. So the driver does the same test
# host-side before the container starts, where it reaches the journal, and this
# copy covers a lane started some other way. Two implementations of one rule is a
# drift risk, and it is taken deliberately: the alternative is a repair nobody
# can see.
store_db=/var/lib/nested-storage/db.sql
if [ -f "$store_db" ] && ! grep -qF "$XDG_RUNTIME_DIR/containers" "$store_db" 2>/dev/null; then
	echo "runner-init: the nested store's libpod database was created against a" >&2
	echo "  different runtime directory than $XDG_RUNTIME_DIR, and podman would" >&2
	echo "  silently use the recorded one - splitting the engine in two. Removing" >&2
	echo "  $store_db; the image cache below it is kept. See docs/ci.md." >&2
	rm -f "$store_db" || {
		echo "runner-init: could not remove $store_db - refusing to start an engine" >&2
		echo "  whose runtime directory this script cannot make consistent." >&2
		exit 1
	}
fi

podman system service --time=0 "$DOCKER_HOST" &

# Ten seconds in tenths: two orders of magnitude more than a bind takes, and
# still short enough that a broken image is obvious rather than a hang.
i=0
while [ ! -S "$sock" ] && [ "$i" -lt 100 ]; do
	i=$((i + 1))
	sleep 0.1
done

if [ ! -S "$sock" ]; then
	echo "runner-init: podman never bound $DOCKER_HOST after 10s - refusing to" >&2
	echo "  start a runner that would take a job and fail it at the first" >&2
	echo "  services: block. Run 'podman info' inside this image." >&2
	exit 1
fi

/usr/local/bin/podman-healthcheck-loop &

exec "$@"
