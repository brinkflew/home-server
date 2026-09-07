#!/usr/bin/env bash
# ==============================================================================
# greenboot's health check: did THIS DEPLOYMENT come up correctly?
# ------------------------------------------------------------------------------
# RUNS ON THE SERVER, as root, from greenboot-healthcheck.service, during the
# multi-user transaction. Symlinked into /etc/greenboot/check/{wanted,required}.d/
# - see host/greenboot/README.md for which, and why that distinction is the whole
# safety model.
#
# This is a wrapper, not a check. Every assertion lives in verify-host.sh
# --greenboot, which already draws the only line that matters: host-level state
# only, never the eighteen containers. greenboot has NO ordering against the user
# manager, so the stack is still starting when the verdict is rendered - a check
# that looked at containers would roll back a good deployment because Tdarr is
# slow.
#
# What the wrapper adds is the three things a check cannot do for itself:
#
#   a durable verdict   ExecMainExitTimestamp is runtime state and a reboot wipes
#                       it, which is a problem when the subject IS the reboot.
#                       Without a record on disk, "the last boot was healthy" and
#                       "nothing has ever checked" look identical.
#   a bounded runtime   nothing in verify-host.sh is timeout-wrapped, and two of
#                       its checks are rpm-ostree D-Bus round trips that block
#                       while rpm-ostreed is staging.
#   a refusal to guess  only an explicit FAIL is allowed to mean "bad
#                       deployment". See below - this is the important part.
#
# ONLY A CONFIRMED FAILURE COUNTS, which is the same rule the off-site policy
# probe follows and for the same reason. A rollback is expensive and, on a
# machine with no console, effectively irreversible if it loops. So a timeout, or
# a checkout that is not there, is recorded as inconclusive and exits 0: those
# are conditions a rollback cannot fix, and a health check that reverts the OS
# because /var/home-server was missing would be doing harm confidently. The
# hourly battery still surfaces both, via the MOTD, at a moment someone can read
# it.
# ==============================================================================

set -uo pipefail

# systemd gives a system service LANG and PATH and nothing else. verify-host.sh
# now defaults HOME itself, but this runs before it and must not rely on that.
export HOME="${HOME:-/root}"
export PATH="/usr/local/bin:/usr/bin:/usr/sbin:/usr/local/sbin"

CHECK="${HOME_SERVER_CHECK:-/var/home-server/bin/verify-host.sh}"
STATE="${HOME_SERVER_BOOT_STATE:-/var/lib/home-server/boot-state}"
LIMIT="${HOME_SERVER_GREENBOOT_TIMEOUT:-120}"

# ------------------------------------------------------------------------------
# The durable verdict
# ------------------------------------------------------------------------------
# Same shape as the backup state file: key=value, ISO-8601 UTC, written to a
# temporary and moved into place so a reader never sees a half-written file.
#
# THIS REPLACES THE FOUR KEYS IT OWNS AND PRESERVES EVERY OTHER, and until
# 2026-09-08 it did the opposite: it wrote a fresh file carrying only
# `red_boot_at`, so every other key was destroyed on every boot. The comment
# here named red_boot_at and stopped, which is how a whitelist of one came to
# read as deliberate.
#
# TWO CHECKS HAD BEEN DEAD FOR AS LONG AS THIS FILE HAS EXISTED, and both
# reported green the whole time:
#
#   unattended_reboot_at  bin/reboot-when-staged.sh writes it immediately before
#                         `systemctl reboot`, because afterwards there is no
#                         process left to write anything. greenboot runs on the
#                         way back up, BEFORE the hourly battery, so it was
#                         always gone by the time bin/verify-host.sh looked.
#                         reboot.last_applied could never reach its "this boot
#                         was applied by the unattended window" branch, and said
#                         "has not applied a deployment yet" after every window
#                         that has ever run - measured on 2026-09-07, eight days
#                         after one applied a deployment.
#   red_boot_csum         written by 50-record-red-boot.sh to say WHICH
#                         deployment greenboot rejected. Dropping it while
#                         keeping red_boot_at is exactly the "a marker with no
#                         checksum" case, which bin/reboot-when-staged.sh treats
#                         as blocking EVERY deployment for ever. The identity
#                         added to stop that hold becoming permanent survived
#                         zero boots.
#
# The merge is the idiom 50-record-red-boot.sh was already using one file over:
# grep out the keys this writer owns, then append them. A writer that rewrites
# the whole file has to know every other writer's keys, and this one did not
# and could not - reboot-when-staged.sh's three refusal counters are also in
# here now and were not when this was written.
record() {  # <green|red|timeout|missing>
	local now booted_ver booted_sum status_json
	now=$(date -u +%Y-%m-%dT%H:%M:%SZ)
	status_json=$(rpm-ostree status --json 2>/dev/null)
	booted_ver=$(jq -r '.deployments[] | select(.booted) | .version // "?"' \
		<<<"$status_json" 2>/dev/null)
	booted_sum=$(jq -r '.deployments[] | select(.booted) | .checksum // "?"' \
		<<<"$status_json" 2>/dev/null | cut -c1-12)

	mkdir -p "$(dirname "$STATE")"
	{
		grep -vE '^(greenboot_result|greenboot_checked_at|booted_version|booted_checksum)=' \
			"$STATE" 2>/dev/null
		echo "greenboot_result=$1"
		echo "greenboot_checked_at=$now"
		echo "booted_version=${booted_ver:-?}"
		echo "booted_checksum=${booted_sum:-?}"
	} >"$STATE.tmp"
	mv "$STATE.tmp" "$STATE"
}

# ------------------------------------------------------------------------------
# Run it
# ------------------------------------------------------------------------------
# A missing or non-executable checkout is not a bad deployment. Rolling the OS
# back would not restore /var/home-server, and would cost a reboot to prove it.
if [ ! -x "$CHECK" ]; then
	echo "greenboot/home-server: $CHECK is not executable - nothing checked" >&2
	record missing
	exit 0
fi

# Output is left to stream rather than captured: verify-host.sh --greenboot is
# silent on success and prints its FAILs to stderr, and greenboot puts both into
# the journal, which is where the reason for a rollback needs to be.
timeout "$LIMIT" "$CHECK" --greenboot
rc=$?

case "$rc" in
	0)
		record green
		exit 0
		;;
	124)
		# INCONCLUSIVE, NOT RED. rpm-ostreed can block for tens of seconds
		# while it stages, and a slow boot must not be able to revert the OS.
		echo "greenboot/home-server: verify-host.sh exceeded ${LIMIT}s - inconclusive" >&2
		record timeout
		exit 0
		;;
	*)
		record red
		exit "$rc"
		;;
esac
