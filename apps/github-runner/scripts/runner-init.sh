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

if [ "$(id -u)" = 0 ]; then
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
# exist - but XDG_RUNTIME_DIR is on the container's own tmpfs and does not.
# podman needs it present and 0700; absent, podman picks a fallback and warns on
# every single invocation, which is thousands of lines in a job log.
sock="${DOCKER_HOST#unix://}"
mkdir -p "${XDG_RUNTIME_DIR:?}" "$(dirname "$sock")"
chmod 0700 "$XDG_RUNTIME_DIR"

# $HOME IS AN EMPTY BIND MOUNT ON A FRESH LANE, and podman stats $HOME/.config
# before it does anything else. Absent, it exits with
#   stat /home/runner/.config: no such file or directory
# and the socket below never binds - an error naming a directory nobody deleted.
# The engine's actual configuration lives in /etc, which nothing can mask; this
# is only the directory it expects to find.
mkdir -p "$HOME/.config" "$HOME/.local/share"

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
