#!/usr/bin/env bash
# ==============================================================================
# Put the credentials a phase container needs into podman's secret store
# ------------------------------------------------------------------------------
# WHY A PODMAN SECRET AND NOT AN ENVIRONMENT VARIABLE ON A UNIT. A phase runner
# needs the model credential inside the container, and there are three ways to
# get it there. Two of them leak it somewhere a person or a process can read it
# without meaning to:
#
#   Environment= on a quadlet   `systemctl --user show -p Environment` prints it
#                               in full, to anyone who can read the user manager.
#   --secret from a FILE        needs the plaintext at a second path on disk,
#                               which is one more thing to chmod and to forget.
#   --secret over STDIN         the value never appears in argv, in another
#                               process's environment, or in a second file.
#
# So the value goes from .env - which render-env.sh wrote from sops, at 600 -
# straight down a pipe. It still ends up in /proc/1/environ INSIDE the container,
# readable by anything the phase runs including a lockfile postinstall, and that
# is an accepted risk recorded in docs/agents.md. It is why the runner's token is
# a DIFFERENT token from the one conduct reads the quota with: revoking one after
# an exfiltration must not blind the other.
#
# IDEMPOTENT, SO IT IS SAFE AT EVERY BOOT AND AFTER EVERY RENDER. `--replace`
# needs podman >= 4.7; this host is 5.8.4, measured. Without it the sequence is
# rm-then-create, which has a window where the secret does not exist - and a
# `podman run --secret` naming a missing secret fails immediately and loudly,
# before the container starts, so even that failure lands in the right direction.
#
# PODMAN SECRETS ALREADY SURVIVE A REBOOT. They live under
# ~/.local/share/containers/storage/secrets, so this script is NOT what makes
# them persist. It is what makes a fresh host and a rotated .env self-healing
# within one boot, and what stops "the secret exists" being a fact recorded only
# in somebody's shell history.
# ==============================================================================

set -euo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
env_file="$root/.env"

# (secret name, variable in .env). One row per credential a container needs.
# conduct's own token is deliberately NOT here: it is read host-side, from .env,
# by a process that is not in a container.
SECRETS="
conduct-claude-token CLAUDE_RUNNER_OAUTH_TOKEN
"

[ -f "$env_file" ] || { echo "sync-podman-secrets: no $env_file - run ./bin/render-env.sh" >&2; exit 1; }
command -v podman >/dev/null || { echo "sync-podman-secrets: podman not found" >&2; exit 1; }

while read -r name var; do
	[ -n "$name" ] || continue

	# Read the value without ever echoing it. `sed -n s///p` rather than sourcing
	# the file, because sourcing runs whatever is in it and .env is generated.
	value=$(sed -n "s/^${var}=//p" "$env_file" | tail -1)

	# AN EMPTY SECRET IS WORSE THAN A MISSING ONE. A container started with it
	# authenticates as nobody, and the failure surfaces twenty minutes later as a
	# model outage rather than immediately as a configuration error. A missing
	# secret fails `podman run` before the container starts.
	if [ -z "$value" ]; then
		echo "sync-podman-secrets: $var is empty in .env - refusing to create an empty $name" >&2
		echo "  a phase would then authenticate as nobody, which reads as a model outage" >&2
		exit 1
	fi

	printf '%s' "$value" | podman secret create --replace "$name" - >/dev/null
	# The timestamp, never the value. agents.model_credential compares it against
	# .env's mtime: a secret OLDER than the file it came from means the phases
	# authenticate with the previous token while conduct paces with the new one,
	# and nothing else on this host would say so.
	echo "sync-podman-secrets: $name <- $var (updated $(
		podman secret inspect "$name" --format '{{.UpdatedAt}}' 2>/dev/null || echo unknown))"
done <<< "$SECRETS"
