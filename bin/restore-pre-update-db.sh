#!/usr/bin/env bash
# ==============================================================================
# Restore database snapshot taken prior to a container auto-update
# ------------------------------------------------------------------------------
# Usage:
#   bin/restore-pre-update-db.sh <app-name>
#   bin/restore-pre-update-db.sh --all
#   bin/restore-pre-update-db.sh --list
#
# Supported apps:
#   pocket-id, sonarr, radarr, prowlarr, bazarr, jellyfin, jellyseerr, tdarr, ntfy, windmill-db
# ==============================================================================

set -euo pipefail

ROOT=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)

CONFIG="${HOME_SERVER_CONFIG:-$ROOT/config}"
SHADOW="${HOME_SERVER_PRE_UPDATE_DB:-$HOME/.cache/home-server/pre-update-db}"
STATE="${HOME_SERVER_BACKUP_STATE:-$HOME/.cache/home-server/backup-state}"

usage() {
	echo "Usage: $0 <app-name|--all|--list>"
	echo "Restores pre-update database snapshot(s) from $SHADOW into $CONFIG"
	exit 1
}

if [ $# -lt 1 ]; then
	usage
fi

TARGET="$1"

if [ ! -d "$SHADOW" ]; then
	echo "ERROR: Shadow directory does not exist: $SHADOW" >&2
	exit 1
fi

if [ "$TARGET" = "--list" ]; then
	echo "Available pre-update database snapshots in $SHADOW:"
	ls -la "$SHADOW"
	exit 0
fi

restore_app() {
	local app="$1"
	local src_dir="$SHADOW/$app"
	local dst_dir="$CONFIG/$app"

	if [ ! -d "$src_dir" ]; then
		echo "WARN: No pre-update snapshot found for '$app' at $src_dir" >&2
		return 0
	fi

	echo "Restoring database snapshot for $app..."

	# If systemctl is available and service unit exists, stop service during restore
	if command -v systemctl >/dev/null 2>&1; then
		systemctl --user stop "$app.service" 2>/dev/null || true
	fi

	mkdir -p "$dst_dir"
	cp -a "$src_dir"/* "$dst_dir"/

	if command -v systemctl >/dev/null 2>&1; then
		systemctl --user start "$app.service" 2>/dev/null || true
	fi

	echo "Successfully restored snapshot for $app"
}

if [ "$TARGET" = "--all" ]; then
	for app_dir in "$SHADOW"/*; do
		if [ -d "$app_dir" ]; then
			app=$(basename "$app_dir")
			restore_app "$app"
		fi
	done
else
    restore_app "$TARGET"
fi

now=$(date -u +%Y-%m-%dT%H:%M:%SZ)
mkdir -p "$(dirname "$STATE")"
{
	grep -vE '^pre_update_db_restored_at=' "$STATE" 2>/dev/null || true
	echo "pre_update_db_restored_at=$now"
} >"$STATE.tmp"
mv "$STATE.tmp" "$STATE"

echo "Database restoration complete."
