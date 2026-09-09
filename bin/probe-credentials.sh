#!/usr/bin/env bash
# ==============================================================================
# The three credentials nothing here proves still authenticate
# ------------------------------------------------------------------------------
# RUNS ON THE SERVER, as `core`, daily from home-server-credential-probe.timer.
#
#   bin/probe-credentials.sh            probe all three, write the marker
#   bin/probe-credentials.sh --dry-run  probe all three, write nothing
#   bin/probe-credentials.sh --only gandi|model|publish   one leg
#
# THREE CHECKS ALREADY SAY THIS IS UNMEASURED, IN THEIR OWN PASS MESSAGES.
# agents.model_credential ends "neither of which proves the token still
# authenticates" and agents.publish_configured ends "neither of which proves
# either one still authenticates" - both deliberately, because presence and
# freshness are all a read of the filesystem can establish. And the ingress
# family grades certificates that have never once been renewed: every one on
# disk is its first issuance, so GANDI_BEARER_TOKEN has never been exercised by
# the path that will need it.
#
# WHAT THAT COSTS, PER CREDENTIAL, WHEN IT IS WRONG:
#
#   gandi    Every public hostname goes dark within hours of the others - ten
#            of the fifteen certificates were issued together on 2026-08-11 and
#            expire together. The first renewal Caddy scheduled is
#            2026-10-10T01:46Z. ingress.renewal_due catches a FAILED renewal
#            about thirty days before that, which is a backstop and not a proof.
#   model    Every phase fails twenty minutes in, and the fleet keeps taking
#            work because nothing upstream knows.
#   publish  A round plans, changes, gates and then cannot open the pull
#            request - the most expensive place in the pipeline to discover it.
#
# A DAILY TIMER RATHER THAN THE HOURLY BATTERY, AND THE NUMBER IS THE WHOLE
# ARGUMENT. bin/verify-host.sh:3372 already rejected a live publish probe, on
# the explicit grounds of "~8,760 GitHub auths a year for a credential that
# almost never changes". That objection is to the CADENCE and it is right. This
# is 365, and the battery grades the marker rather than making the call itself -
# the same shape the backups, the restore verifications and the CI sweep already
# use. External calls in the battery live behind --routes, which is manual.
#
# EVERY LEG IS INDEPENDENT, so one broken credential cannot hide another. There
# is no `set -e` here for that reason: a leg that fails records that it failed
# and the next one still runs.
#
# See: docs/networking.md, docs/agents.md, bin/verify-host.sh (ingress, agents)
# ==============================================================================

set -uo pipefail

export PATH="${HOME:-/var/home/core}/.local/bin:$PATH"

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ENV_FILE="${HOME_SERVER_ENV:-$REPO/.env}"
MARKER="${HOME_SERVER_CREDENTIAL_STATE:-${HOME:-/var/home/core}/.cache/home-server/credential-state}"

# The probe record's name under the zone. It resolves to nothing, is created and
# destroyed inside one run, and is deliberately NOT `_acme-challenge` - Caddy
# owns that name for every hostname it holds, and a probe that shared it could
# destroy a challenge mid-issuance.
GANDI_PROBE_NAME="${HOME_SERVER_GANDI_PROBE_NAME:-_acme-challenge-probe}"
GANDI_API="${HOME_SERVER_GANDI_API:-https://api.gandi.net/v5}"
MODEL_API="${HOME_SERVER_MODEL_API:-https://api.anthropic.com/v1/messages}"
GITHUB_API="${HOME_SERVER_GITHUB_API:-https://api.github.com}"

DRY=""
ONLY=""
while [ $# -gt 0 ]; do
	case "${1:-}" in
		--dry-run) DRY=1 ;;
		--only)    shift; ONLY="${1:-}" ;;
		*) echo "probe-credentials: unknown argument: $1" >&2; exit 2 ;;
	esac
	shift
done
case "$ONLY" in
	""|gandi|model|publish) ;;
	*) echo "probe-credentials: --only takes gandi, model or publish" >&2; exit 2 ;;
esac

log() { printf 'probe-credentials: %s\n' "$*"; }

# THE VALUE EXACTLY AS WRITTEN, AND NEVER BY SOURCING. `.env` carries three
# bcrypt hashes, so `set -a; . .env` under `set -u` dies on `$2: unbound
# variable` - a line number in a generated file and no variable name.
# bin/backup-server.sh names the trap at length and reads the same way.
env_get() {  # <name>
	[ -f "$ENV_FILE" ] || return 0
	sed -n "s/^$1=//p" "$ENV_FILE" | tail -1
}

# The same read against this script's own marker, for the --only case below.
# shellcheck disable=SC2317  # reached only through the eval in the --only
# carry-forward, which shellcheck's flow analysis cannot follow
prev_get() {  # <key>
	sed -n "s/^$1=//p" "$MARKER" 2>/dev/null | tail -1
}

# ------------------------------------------------------------------------------
# The results, and the three words they may be
# ------------------------------------------------------------------------------
# ok       the credential was accepted
# failed   the credential was REJECTED - this is the finding
# skipped  it is not configured, or the probe could not be made at all
#
# SKIPPED IS NOT A QUIET FAILURE, IT IS A DIFFERENT SENTENCE. A missing token is
# already reported by agents.model_credential and agents.publish_configured, and
# a network that could not be reached says nothing about the credential. Both
# would be actively wrong to record as a rejection: the whole value of this file
# is that `failed` means one thing.
res_gandi=skipped   det_gandi="not attempted"
res_model=skipped   det_model="not attempted"
res_publish=skipped det_publish="not attempted"

want() { [ -z "$ONLY" ] || [ "$ONLY" = "$1" ]; }

# ------------------------------------------------------------------------------
# Gandi: can the token still WRITE a TXT record?
# ------------------------------------------------------------------------------
# A READ WOULD PROVE THE WRONG HALF. A Gandi Personal Access Token carries
# scopes, and DNS-01 needs write: a token that can list the zone and not change
# it authenticates perfectly and renews nothing. So this creates a record and
# removes it, which is precisely what caddy-dns/gandi does for every challenge.
#
# THE DELETE IS ON A TRAP, because a probe record left in the live zone is this
# leg's own failure mode. It resolves to nothing and collides with nothing, but
# an accumulating pile of them is litter in the one zone every public hostname
# depends on.
#
# THE TOKEN GOES ON STDIN THROUGH `curl -K -`, never argv, so it is absent from
# the host's process list. The config LINE is quoted and the token inside it
# must carry no quote character: curl does not unescape `\"` there and sends a
# quoted value truncated. bin/jellyfin-watching.sh carries that measurement.
#
# ONE TRAP AND TWO VARIABLES, rather than a function redefined around the call.
# The trap fires unconditionally and does nothing until the create has been
# attempted, so there is exactly one deletion path whether this leg returns
# normally, is killed by the timer's TimeoutStartSec, or dies on an unset
# variable three lines later.
gandi_rm_url=""
gandi_rm_token=""
gandi_cleanup() {
	[ -n "$gandi_rm_url" ] || return 0
	curl -K - <<-EOF >/dev/null 2>&1
		url = "$gandi_rm_url"
		header = "Authorization: Bearer $gandi_rm_token"
		request = "DELETE"
		silent
		max-time = 20
	EOF
	gandi_rm_url=""
}
trap gandi_cleanup EXIT

probe_gandi() {
	local token domain code url body
	token=$(env_get GANDI_BEARER_TOKEN)
	domain=$(env_get DOMAIN)
	if [ -z "$token" ]; then
		det_gandi="GANDI_BEARER_TOKEN is not set in $ENV_FILE"; return
	fi
	if [ -z "$domain" ]; then
		det_gandi="DOMAIN is not set in $ENV_FILE"; return
	fi
	url="$GANDI_API/livedns/domains/$domain/records/$GANDI_PROBE_NAME/TXT"

	# 300 is Gandi's floor for a TTL and the record lives for about a second.
	body="{\"rrset_values\":[\"home-server-probe-$(date -u +%s)\"],\"rrset_ttl\":300}"

	if [ -n "$DRY" ]; then
		det_gandi="would PUT and DELETE $GANDI_PROBE_NAME.$domain TXT"
		res_gandi=skipped
		return
	fi

	# ARMED BEFORE THE CREATE, so a request that half-succeeded, timed out after
	# the server had already written, or was killed mid-flight is still cleaned
	# up. Deleting a record that does not exist answers 404 and is harmless.
	gandi_rm_url="$url"
	gandi_rm_token="$token"

	code=$(curl -K - <<-EOF 2>/dev/null
		url = "$url"
		header = "Authorization: Bearer $token"
		header = "Content-Type: application/json"
		request = "PUT"
		data = "$body"
		silent
		output = /dev/null
		write-out = "%{http_code}"
		max-time = 20
	EOF
	)

	case "${code:-000}" in
		2*)
			res_gandi=ok
			det_gandi="wrote and removed $GANDI_PROBE_NAME.$domain TXT (HTTP $code)"
			;;
		401|403)
			res_gandi=failed
			det_gandi="Gandi refused the token with HTTP $code - DNS-01 cannot answer a challenge, and every certificate renews through it"
			;;
		000|"")
			res_gandi=skipped
			det_gandi="the Gandi API could not be reached - this says nothing about the token"
			;;
		*)
			res_gandi=failed
			det_gandi="Gandi answered HTTP $code to a TXT write - not a refusal of the token, but not a write either"
			;;
	esac

	# Removed here rather than only at exit, so the record's life is the second
	# it takes to answer rather than the length of the two legs that follow.
	gandi_cleanup
}

# ------------------------------------------------------------------------------
# Model: is the OAuth token still accepted?
# ------------------------------------------------------------------------------
# ONLY 401 IS A FINDING, AND THAT IS DELIBERATE RATHER THAN LAZY. This is a
# `claude setup-token` OAuth credential with scopes, and this repository has
# already measured one of them answering 403 `user:profile` to an endpoint it
# was not entitled to - a scope refusal, from a token that authenticates
# perfectly. A check that read 403 as "revoked" would warn for ever about a
# working fleet, which is the shape docs/known-state.md has a whole entry about.
#
# So: 401 is the credential being rejected. Every other answer - 200, 400, 403,
# 429 - means the request got PAST authentication, which is the only question
# being asked. A transport failure is `skipped`.
#
# max_tokens 1 AND THE CHEAPEST MODEL, because this runs 365 times a year and a
# probe that costs anything measurable would be an argument against having it.
probe_model() {
	local token code
	token=$(env_get CLAUDE_RUNNER_OAUTH_TOKEN)
	if [ -z "$token" ]; then
		det_model="CLAUDE_RUNNER_OAUTH_TOKEN is not set in $ENV_FILE - agents.model_credential already says so"
		return
	fi
	if [ -n "$DRY" ]; then
		det_model="would POST a 1-token request to $MODEL_API"
		return
	fi

	code=$(curl -K - <<-EOF 2>/dev/null
		url = "$MODEL_API"
		header = "Authorization: Bearer $token"
		header = "anthropic-version: 2023-06-01"
		header = "Content-Type: application/json"
		request = "POST"
		data = "{\"model\":\"claude-haiku-4-5-20251001\",\"max_tokens\":1,\"messages\":[{\"role\":\"user\",\"content\":\"hi\"}]}"
		silent
		output = /dev/null
		write-out = "%{http_code}"
		max-time = 30
	EOF
	)

	case "${code:-000}" in
		401)
			res_model=failed
			det_model="the model API rejected the token with HTTP 401 - every phase will fail at its first model call"
			;;
		000|"")
			res_model=skipped
			det_model="the model API could not be reached - this says nothing about the token"
			;;
		*)
			res_model=ok
			det_model="the model API accepted the token (HTTP $code)"
			;;
	esac
}

# ------------------------------------------------------------------------------
# Publish: the push key, and the pull-request token
# ------------------------------------------------------------------------------
# TWO CREDENTIALS, ONE VERDICT, AND THEY FAIL AT THE SAME PLACE. The deploy key
# pushes the branch and the PAT opens the pull request; a round that gets past
# the gate needs both, and losing either one costs the same twenty minutes of
# model time. agents.publish_configured already reports their presence.
#
# `git ls-remote` IS FREE AND UNAMBIGUOUS - it authenticates and lists refs
# without fetching an object. `-F /dev/null` because a second deploy key added
# to the existing `Host github.com` block loses to IdentitiesOnly, and GitHub
# answers a valid key for the wrong repository with "repository not found",
# which reads as a bad URL. docs/agents.md carries that measurement.
probe_publish() {
	local key slug code out rc token
	key="${HOME_SERVER_PUSH_KEY:-${HOME}/.ssh/upskald_push}"
	slug=$(env_get AGENTS_REPO_SLUG)
	if [ ! -f "$key" ]; then
		det_publish="no push key at $key - agents.publish_configured already says so"
		return
	fi
	if [ -z "$slug" ]; then
		det_publish="AGENTS_REPO_SLUG is not set in $ENV_FILE"
		return
	fi
	if [ -n "$DRY" ]; then
		det_publish="would ls-remote git@github.com:$slug and ask $GITHUB_API/user"
		return
	fi

	out=$(GIT_SSH_COMMAND="ssh -F /dev/null -i $key -o IdentitiesOnly=yes -o StrictHostKeyChecking=accept-new -o ConnectTimeout=15" \
		timeout 45 git ls-remote "git@github.com:$slug" HEAD 2>&1)
	rc=$?
	if [ "$rc" -ne 0 ]; then
		case "$out" in
			*"Permission denied"*|*"repository not found"*|*"Repository not found"*)
				res_publish=failed
				det_publish="the push key was refused for $slug - a round would gate green and then fail to publish"
				return
				;;
			*)
				res_publish=skipped
				det_publish="git ls-remote could not complete (exit $rc) - this says nothing about the key"
				return
				;;
		esac
	fi

	# THE PAT IS THE SECOND HALF AND IT LIVES IN WINDMILL, not in .env - the
	# workspace variable f/agents/github_pr_token, which agents.publish_configured
	# reads the PRESENCE of through windmill-db. Reading its VALUE needs the same
	# hop, and if windmill-db is not running there is nothing to ask.
	token=$(podman exec windmill-db sh -c \
		'psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -Atc "select value from variable where path = '"'"'f/agents/github_pr_token'"'"'"' \
		2>/dev/null)
	if [ -z "$token" ] || [ "${token:0:3}" != "ghp" ] && [ "${token:0:11}" != "github_pat_" ]; then
		# Windmill stores a secret variable ENCRYPTED, so what comes back here
		# is not usable as a bearer token and must not be sent as one. The push
		# key half stands on its own; say so rather than implying both were
		# proven.
		res_publish=ok
		det_publish="the push key authenticates against $slug; the pull-request token is not readable from here, so only half of this is proven"
		return
	fi

	code=$(curl -K - <<-EOF 2>/dev/null
		url = "$GITHUB_API/user"
		header = "Authorization: Bearer $token"
		header = "Accept: application/vnd.github+json"
		silent
		output = /dev/null
		write-out = "%{http_code}"
		max-time = 20
	EOF
	)
	case "${code:-000}" in
		2*)      res_publish=ok;      det_publish="the push key authenticates against $slug and the pull-request token is accepted (HTTP $code)" ;;
		401|403) res_publish=failed;  det_publish="the push key works but GitHub refused the pull-request token with HTTP $code - a round would gate green and then fail to open the pull request" ;;
		000|"")  res_publish=ok;      det_publish="the push key authenticates against $slug; GitHub could not be reached for the token, so only half of this is proven" ;;
		*)       res_publish=ok;      det_publish="the push key authenticates against $slug; GitHub answered HTTP $code to the token check" ;;
	esac
}

want gandi   && probe_gandi
want model   && probe_model
want publish && probe_publish

log "gandi=$res_gandi ($det_gandi)"
log "model=$res_model ($det_model)"
log "publish=$res_publish ($det_publish)"

# ------------------------------------------------------------------------------
# The durable record
# ------------------------------------------------------------------------------
# ONE FILE THIS SCRIPT OWNS ENTIRELY, so there is no carry-forward to get wrong -
# the shape bin/ci-artifacts-sweep.sh uses, and deliberately not the shared
# ~/.cache/home-server/backup-state, which five writers merge into and where a
# too-narrow `grep -vE` once nearly destroyed another job's marker.
#
# UNDER --only, THE LEGS THAT DID NOT RUN KEEP THEIR PREVIOUS VALUES. A hand run
# of one leg must not blank the other two and make the battery report them as
# never probed.
if [ -z "$DRY" ]; then
	mkdir -p "$(dirname "$MARKER")"
	for leg in gandi model publish; do
		want "$leg" && continue
		eval "res_$leg=\$(prev_get ${leg}_probe_result)"
		eval "det_$leg=\$(prev_get ${leg}_probe_detail)"
		eval "at_$leg=\$(prev_get ${leg}_probe_at)"
	done
	now=$(date -u +%Y-%m-%dT%H:%M:%SZ)
	{
		for leg in gandi model publish; do
			if want "$leg"; then
				printf '%s_probe_at=%s\n' "$leg" "$now"
			else
				eval "printf '%s_probe_at=%s\\n' \"\$leg\" \"\${at_$leg:-}\""
			fi
			eval "printf '%s_probe_result=%s\\n' \"\$leg\" \"\${res_$leg:-}\""
			eval "printf '%s_probe_detail=%s\\n' \"\$leg\" \"\${det_$leg:-}\""
		done
	} > "$MARKER.tmp"
	mv "$MARKER.tmp" "$MARKER"
fi

# EXIT 0 ON A REJECTED CREDENTIAL, and that is the same choice
# bin/reboot-when-staged.sh and bin/reclaim-boot-slot.sh make. The finding is in
# the marker, which bin/verify-host.sh grades into ingress.dns_credential,
# agents.model_credential_valid and agents.publish_credential_valid. A unit that
# goes red here would say "the probe failed" for a condition where the probe
# worked perfectly and the answer was bad news.
exit 0
