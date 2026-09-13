#!/usr/bin/env sh
# ==============================================================================
# Authenticated Gluetun -> qBittorrent port forwarding push script
# ------------------------------------------------------------------------------
# Pushes the WireGuard/NAT-PMP forwarded port into qBittorrent WebUI.
# Authenticates with qBittorrent first if credentials are provided, so that
# qBittorrent WebUI\LocalHostAuth remains enabled.
# ==============================================================================

set -e

PORT="${1:-}"
WEB_PORT="${PORT_QBITTORRENT_WEB:-8200}"
USER="${QBITTORRENT_USER:-admin}"
PASS="${QBITTORRENT_PASS:-}"

if [ -z "$PORT" ]; then
	echo "Usage: $0 <forwarded-port>" >&2
	exit 1
fi

COOKIE=""
if [ -n "$PASS" ]; then
	COOKIE_HEADER=$(wget -S --retry-connrefused -O /dev/null --post-data="username=${USER}&password=${PASS}" "http://127.0.0.1:${WEB_PORT}/api/v2/auth/login" 2>&1 | grep -i "Set-Cookie:" | head -n 1 || true)
	COOKIE=$(echo "$COOKIE_HEADER" | sed -n 's/.*SID=\([^;]*\).*/\1/p')
fi

if [ -n "$COOKIE" ]; then
	wget -qO- --header="Cookie: SID=$COOKIE" --post-data="json={\"listen_port\":${PORT}}" "http://127.0.0.1:${WEB_PORT}/api/v2/app/setPreferences"
else
	wget -qO- --retry-connrefused --post-data="json={\"listen_port\":${PORT}}" "http://127.0.0.1:${WEB_PORT}/api/v2/app/setPreferences"
fi

echo "Pushed forwarded port ${PORT} to qBittorrent"
