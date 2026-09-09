#!/usr/bin/env bash
# ==============================================================================
# Are the forbidden edges still forbidden?
# ------------------------------------------------------------------------------
# RUNS ON THE SERVER, as `core`, weekly from home-server-verify-segmentation.timer.
#
#   bin/verify-segmentation.sh            probe every edge, write the marker
#   bin/verify-segmentation.sh --dry-run  print the edges, start no container
#
# THE SPLIT IS THE SECURITY MODEL AND NOTHING PROVED IT ON A SCHEDULE. Ten
# networks, one per trust boundary, and until 2026-09-09 the only evidence any
# forbidden edge was still forbidden was a person running `podman run --rm
# --network net-solver busybox` by hand. net.segment_isolation reads the option
# hourly - that is "do the networks still carry it?" - and this is the other
# half: "is it enforced by the kernel?". bin/verify-host.sh draws exactly that
# distinction for the agent fleet and points at bin/conduct-runner-smoke.sh for
# the packet; this is the same shape for the stack.
#
# BY IP, NEVER BY NAME. A container has one address per network it joins, so a
# name proves only one of them - and the unit files look identical either way.
# docs/networking.md has said so since the migration.
#
# THE EXIT CODE IS THE FINDING, NOT MERELY ITS SIGN. `timeout` returns 124 when
# the connection is silently dropped, which is a blocked edge. A refused
# connection returns fast and non-zero for a completely different reason: the
# packet ARRIVED and only the port was shut. Reporting "nonzero" would call a
# refusal a success, and a refusal is not isolation - it is the absence of a
# listener, which comes back the moment somebody publishes a port.
#
# AND THERE IS A POSITIVE CONTROL, WITHOUT WHICH THIS PROVES NOTHING. Every
# refusal here looks identical to a probe that never ran: a typo in an image
# name, a missing container, a podman that cannot start anything at all would
# make every edge read "dropped" and this script report perfect isolation. So
# one edge that MUST connect is probed alongside them, and if it does not, every
# other result on the run is discarded. docs/known-state.md has an entry about
# an instrument with no control; this is that lesson applied in advance.
#
# EVERY CONTAINER CARRIES io.home-server.ephemeral. Without it the collector
# counts these as services: one throwaway `podman run --rm` once made
# identity_unresolved read 1, inflated two counts, and minted network series
# under an unbounded label.
#
# See: docs/networking.md, bin/conduct-runner-smoke.sh, bin/github-runner-smoke.sh
# ==============================================================================

set -uo pipefail

export PATH="${HOME:-/var/home/core}/.local/bin:$PATH"

MARKER="${HOME_SERVER_SEGMENT_STATE:-${HOME:-/var/home/core}/.cache/home-server/segment-state}"

# BUSYBOX BECAUSE IT IS ALREADY ON THIS HOST and it is the image
# docs/networking.md's own example uses. `nc` WITHOUT -w, deliberately: busybox
# returns 1 for both a refused connection and its own timeout, which collapses
# the distinction this whole script exists to draw. Left to hang, a dropped
# packet reaches the OUTER `timeout` and returns 124, and a refused one still
# returns 1 immediately.
PROBE_IMAGE="${HOME_SERVER_PROBE_IMAGE:-docker.io/library/busybox:latest}"
PROBE_WAIT="${HOME_SERVER_PROBE_WAIT:-6}"

DRY=""
case "${1:-}" in
	"")        ;;
	--dry-run) DRY=1 ;;
	*)         echo "verify-segmentation: unknown argument: $1" >&2; exit 2 ;;
esac

log()  { printf 'verify-segmentation: %s\n' "$*"; }
ok()   { printf '  \033[32mPASS\033[0m  %s\n' "$*"; }
bad()  { printf '  \033[31mFAIL\033[0m  %s\n' "$*"; }
skip() { printf '  \033[33mSKIP\033[0m  %s\n' "$*"; }

blocked=0 open=0 skipped=0 control=unproven
findings=""

# ------------------------------------------------------------------------------
# The edges
# ------------------------------------------------------------------------------
# FROM docs/networking.md's MEMBERSHIP TABLE, and each one is here because
# something specific goes wrong if it opens:
#
#   net-solver -> net-arr    FlareSolverr runs headless Chrome against
#                            attacker-controlled indexer pages, so it is the
#                            likeliest container here to be compromised;
#                            Prowlarr is meant to be all it can see.
#   net-media -> net-arr     Jellyfin is the most exposed service, LAN and
#                            public, and initiates no internal connection at
#                            all - so it should reach nothing.
#   net-dashboard -> metrics The dashboard queries Prometheus THROUGH Caddy, past
#                            the /api/v1/admin/* refusal. Prometheus runs with
#                            --web.enable-admin-api, which carries delete_series,
#                            so a direct route would step around that guard.
#                            docs/networking.md calls this the mistake the whole
#                            segment exists to avoid.
#   net-egress -> net-arr    duckdns should reach the internet and nothing here.
#
# THE LONG WAY ROUND IS AN EDGE TOO, and it was measured rather than assumed -
# an earlier plan asserted the opposite. Reaching Caddy at the HOST's LAN
# address DNATs into net-ingress, so it is a bridge-to-bridge flow and
# isolate=true drops it.
#
# <source network>|<target container>|<target network>|<port>|<want>|<why>
EDGES="
net-solver|sonarr|net-arr|8989|dropped|FlareSolverr must not reach the *arr apps
net-media|sonarr|net-arr|8989|dropped|Jellyfin initiates nothing and must reach nothing
net-dashboard|prometheus|net-metrics|9090|dropped|the dashboard must go through Caddy, past the admin-API refusal
net-egress|sonarr|net-arr|8989|dropped|duckdns must reach the internet and nothing here
net-arr|sonarr|net-arr|8989|open|THE CONTROL - same network, so this MUST connect
"

# THE LONG WAY ROUND, APPENDED SEPARATELY BECAUSE ITS ADDRESS IS NOT A
# CONTAINER'S. Caddy publishes 443 on the host, and reaching it at the host's
# LAN address DNATs into net-ingress - so it is a bridge-to-bridge flow and
# isolate=true drops it. That was MEASURED rather than assumed; an earlier plan
# asserted the opposite. What is NOT blocked is the host itself: port 22 from a
# segment is REFUSED rather than dropped, so the isolation is about where the
# packet ends up and not about the address it is aimed at.
#
# A PSEUDO-CONTAINER NAME, and the loop below knows it: `-` means "the address
# is in the target-network field already", which keeps one loop rather than two.
lan=$(ip route get 1.1.1.1 2>/dev/null | awk '{for (i = 1; i < NF; i++) if ($i == "src") print $(i + 1)}')
if [ -n "$lan" ]; then
	EDGES="$EDGES
net-solver|-|$lan|443|dropped|Caddy's host publish must not be a way back into net-ingress"
fi

# ------------------------------------------------------------------------------
# One probe
# ------------------------------------------------------------------------------
# --rm AND A LABEL, so nothing survives the run and no collector counts it.
# --network puts it on the SOURCE segment; the address it dials is the target's
# own on the target segment, which is what makes this a bridge-to-bridge test
# rather than a question about DNS.
probe() {  # <source network> <ip> <port> -> 124 dropped, 1 refused, 0 open
	timeout "$PROBE_WAIT" podman run --rm \
		--label io.home-server.ephemeral \
		--network "$1" \
		"$PROBE_IMAGE" \
		nc "$2" "$3" </dev/null >/dev/null 2>&1
}

container_ip() {  # <container> <network>
	podman inspect "$1" \
		--format "{{(index .NetworkSettings.Networks \"$2\").IPAddress}}" 2>/dev/null
}

while IFS='|' read -r src tgt tnet port want why; do
	[ -n "${src:-}" ] || continue
	if [ "$tgt" = - ]; then label="$src -> the host publish at $tnet:$port"
	else                    label="$src -> $tgt:$port on $tnet"
	fi

	if [ -n "$DRY" ]; then
		log "would probe $label (want $want) - $why"
		continue
	fi

	if ! podman network exists "$src" 2>/dev/null; then
		skip "$label - $src does not exist, so the stack is not started"
		skipped=$(( skipped + 1 )); continue
	fi
	if [ "$tgt" = - ]; then
		ip="$tnet"
	else
		ip=$(container_ip "$tgt" "$tnet")
	fi
	if [ -z "$ip" ]; then
		skip "$label - $tgt has no address on $tnet, so there is nothing to dial"
		skipped=$(( skipped + 1 )); continue
	fi

	probe "$src" "$ip" "$port"; rc=$?
	case "$want:$rc" in
		dropped:124)
			ok "$label is dropped (rc 124) - $why"
			blocked=$(( blocked + 1 )) ;;
		dropped:0)
			bad "$label is OPEN - $why"
			findings="$findings $src>$tgt:$port(open)"
			open=$(( open + 1 )) ;;
		dropped:1)
			# NOT ISOLATION. The packet arrived and the port was shut, so this
			# edge opens the moment anything listens there.
			bad "$label is REFUSED, not dropped - the packet arrived and only the port was shut, which is not a blocked edge"
			findings="$findings $src>$tgt:$port(refused)"
			open=$(( open + 1 )) ;;
		dropped:*)
			skip "$label returned rc $rc, which is neither 124 nor 1 - the probe did not run, so this proves nothing either way"
			skipped=$(( skipped + 1 )) ;;
		open:0)
			ok "$label is reachable (rc 0) - $why"
			control=proven ;;
		open:*)
			bad "$label returned rc $rc and should have connected - $why"
			control=broken ;;
	esac
done <<-EOF
	$EDGES
EOF

[ -n "$DRY" ] && exit 0

# ------------------------------------------------------------------------------
# The control decides whether any of the above is evidence
# ------------------------------------------------------------------------------
# A BROKEN CONTROL DISCARDS THE RUN RATHER THAN REPORTING IT. Every failure mode
# of this script - a missing image, a podman that will not start a container, a
# renamed network - makes every forbidden edge read "dropped", which is the
# answer it is hoping for. So when the edge that must connect does not, the
# blocked count is thrown away and the marker says the run proved nothing.
if [ "$control" != proven ]; then
	log "the control edge did not connect ($control) - discarding $blocked blocked result(s), because every one of them is what a probe that never ran also reports"
	blocked=0
fi

printf '\n'
log "blocked=$blocked open=$open skipped=$skipped control=$control"

mkdir -p "$(dirname "$MARKER")"
{
	printf 'segments_verified_at=%s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)"
	printf 'segments_edges_blocked=%s\n' "$blocked"
	printf 'segments_edges_open=%s\n' "$open"
	printf 'segments_edges_skipped=%s\n' "$skipped"
	printf 'segments_control=%s\n' "$control"
	printf 'segments_open_edges=%s\n' "$(printf '%s' "$findings" | cut -c1-400)"
} > "$MARKER.tmp"
mv "$MARKER.tmp" "$MARKER"

# EXIT 0 EVEN ON AN OPEN EDGE, and for once that is not the usual argument about
# quiet weeks. net.containment in bin/verify-host.sh grades this marker and
# SegmentContainmentLost pages critical on it, which is a louder path than a
# failed user unit nobody is watching. A red unit here would add nothing and
# would make `systemctl --user list-units --failed` - the fastest health check
# on this host - stay dirty until somebody cleared it.
exit 0
