#!/usr/bin/env bash
# ==============================================================================
# Self-healing remediation for transient status findings
# ------------------------------------------------------------------------------
# Reads /var/lib/home-server/status.json and performs targeted recovery
# actions for known transient failure states.
# ==============================================================================

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
STATUS_FILE="${HOME_SERVER_STATUS_FILE:-/var/lib/home-server/status.json}"
STATE="${HOME_SERVER_REMEDIATE_STATE:-$HOME/.cache/home-server/remediate-state}"

[ -f "$STATUS_FILE" ] || exit 0

remediated=0

# 1. Flaresolverr unresponsive check
if jq -e '.checks[] | select(.id=="solver.flaresolverr" and (.status=="fail" or .status=="warn"))' "$STATUS_FILE" >/dev/null 2>&1; then
	echo "remediate: Flaresolverr is failing/warning - restarting flaresolverr.service..."
	systemctl --user restart flaresolverr.service 2>/dev/null || true
	remediated=$((remediated + 1))
fi

# 2. Torrent port forward check
if jq -e '.checks[] | select(.id=="torrent.port_forward" and .status=="warn")' "$STATUS_FILE" >/dev/null 2>&1; then
	echo "remediate: Torrent port forward warning - executing push-gluetun-port.sh..."
	"$ROOT/bin/push-gluetun-port.sh" 2>/dev/null || true
	remediated=$((remediated + 1))
fi

# 3. Stalled downloads check
if jq -e '.checks[] | select(.id=="torrent.stalled" and .status=="warn")' "$STATUS_FILE" >/dev/null 2>&1; then
	echo "remediate: Stalled downloads detected - executing clear-stalled.py..."
	python3 "$ROOT/bin/clear-stalled.py" 2>/dev/null || true
	remediated=$((remediated + 1))
fi

# Record completion timestamp
mkdir -p "$(dirname "$STATE")" 2>/dev/null
tmp="$STATE.tmp.$$"
if {
	echo "remediate_at=$(date -u +%Y-%m-%dT%H:%M:%SZ)"
	echo "remediated_count=$remediated"
} >"$tmp" 2>/dev/null && mv "$tmp" "$STATE" 2>/dev/null; then
	:
else
	rm -f "$tmp" 2>/dev/null
fi

echo "remediate: finished ($remediated action(s) taken)"
