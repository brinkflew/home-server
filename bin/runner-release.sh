#!/usr/bin/env bash
# Resolve the GitHub Actions runner version the CI lane image is built from
#
# Writes GITHUB_RUNNER_VERSION, GITHUB_RUNNER_SHA256 and GITHUB_RUNNER_PUBLISHED_AT
# to $GITHUB_RUNNER_ROOT/.runner-release.env, which stacks/infra/github-runner.build
# reads as BuildArg= values. Run by home-server-github-runner-build.service before
# the build.
#
# THE IMAGE IS WHAT A LANE RUNS. A just-in-time runner polls with
# `disableUpdate=true` and never updates itself, so a version that falls below
# GitHub's minimum stops receiving jobs - measured 2026-11-05, four days without a
# job. Tracking upstream here is what keeps the weekly build ahead of that.
#
# A FAILED LOOKUP NEVER BREAKS THE BUILD. It keeps the last resolved file, or,
# with none, writes the Dockerfile's ARG defaults. The Dockerfile's version is
# also a floor: upstream is never taken below it.

set -euo pipefail

ROOT=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)
FLEET_ROOT="${GITHUB_RUNNER_ROOT:-/var/home-server/cache/github-runner}"
OUT="$FLEET_ROOT/.runner-release.env"
API="${GITHUB_RUNNER_RELEASE_API:-https://api.github.com/repos/actions/runner/releases/latest}"
DOCKERFILE="$ROOT/apps/github-runner/Dockerfile"

log() { printf 'runner-release: %s\n' "$*"; }

floor_version=$(sed -n 's/^ARG GITHUB_RUNNER_VERSION=//p' "$DOCKERFILE" | tail -1)
floor_sha=$(sed -n 's/^ARG GITHUB_RUNNER_SHA256=//p' "$DOCKERFILE" | tail -1)
if [ -z "$floor_version" ] || [ -z "$floor_sha" ]; then
	log "the Dockerfile carries no GITHUB_RUNNER_VERSION/SHA256 ARG"
	exit 1
fi

write() {
	local tmp="$OUT.tmp.$$"
	mkdir -p "$FLEET_ROOT"
	printf 'GITHUB_RUNNER_VERSION=%s\nGITHUB_RUNNER_SHA256=%s\nGITHUB_RUNNER_PUBLISHED_AT=%s\n' \
		"$1" "$2" "$3" > "$tmp"
	mv -f "$tmp" "$OUT"
	log "building $1 ($4)"
}

fallback() {
	log "$1"
	if [ -s "$OUT" ] && grep -q '^GITHUB_RUNNER_VERSION=[0-9]' "$OUT"; then
		prev=$(sed -n 's/^GITHUB_RUNNER_VERSION=//p' "$OUT")
		if [ "$(printf '%s\n%s\n' "$floor_version" "$prev" | sort -V | head -1)" = "$floor_version" ]; then
			log "keeping the last resolved release, $prev"
			exit 0
		fi
	fi
	write "$floor_version" "$floor_sha" "" "the Dockerfile's floor"
	exit 0
}

# Unauthenticated, so 60 requests an hour; this runs once a week.
release=$(curl -fsS --max-time 20 "$API" 2>/dev/null) ||
	fallback "could not read $API"

version=$(printf '%s' "$release" | jq -r '.tag_name // empty' 2>/dev/null | sed 's/^v//')
published=$(printf '%s' "$release" | jq -r '.published_at // empty' 2>/dev/null)
sha=$(printf '%s' "$release" | jq -r '.body // empty' 2>/dev/null |
	sed -n 's/.*<!-- BEGIN SHA linux-x64 -->\([0-9a-f]*\)<!-- END SHA linux-x64 -->.*/\1/p' | head -1)

printf '%s' "$version" | grep -Eq '^[0-9]+\.[0-9]+\.[0-9]+$' ||
	fallback "upstream's tag '${version:-absent}' is not a version"
printf '%s' "$sha" | grep -Eq '^[0-9a-f]{64}$' ||
	fallback "upstream's release $version carries no linux-x64 sha256 in its notes"

if [ "$(printf '%s\n%s\n' "$floor_version" "$version" | sort -V | head -1)" != "$floor_version" ]; then
	fallback "upstream's $version is below the Dockerfile's floor $floor_version"
fi

write "$version" "$sha" "$published" "upstream's latest"
