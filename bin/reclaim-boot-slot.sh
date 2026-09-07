#!/usr/bin/env bash
# ==============================================================================
# Give /boot its second slot back, so the next update can write a kernel
# ------------------------------------------------------------------------------
# RUNS ON THE SERVER, as `core`, from home-server-boot-reclaim.timer.
#
#   bin/reclaim-boot-slot.sh --dry-run   say what it would do, change nothing
#   bin/reclaim-boot-slot.sh             reclaim, if every gate below passes
#
# THE ARITHMETIC IS THE WHOLE REASON THIS EXISTS. /boot is 350 MB usable and a
# deployment slot is 145.3 MiB - a 127.3 MiB initramfs and an 18 MiB kernel -
# with 11 MiB of grub2 underneath. Two slots fit and three do not, and an update
# needs a third TRANSIENTLY: ostree-finalize-staged writes the new kernel at
# shutdown before the old one is dropped, and it says so in the journal, asking
# for 152.3 MB free before it will start.
#
# /boot CANNOT BE GROWN. sgdisk reports "Total free space is 0 sectors", p4 (root)
# starts on the sector after p3 ends, and p4 is XFS, which no tool can shrink.
# See docs/known-state.md; this was settled by measurement, not by argument.
#
# SO THE INVARIANT IS: AT THE MOMENT ostree-finalize-staged RUNS, AT MOST ONE
# SLOT IS OCCUPIED. bin/reboot-host.sh has always established it by hand - it
# ends in `rpm-ostree cleanup -r` after the reboot it performed.
# bin/reboot-when-staged.sh has no "after": it reboots, and the process that
# would clean up is gone with it. That asymmetry is the whole bug. Every
# unattended reboot left two slots occupied, the next image staged, the Sunday
# window refused for want of a slot - correctly - and a person ran two commands
# by hand. Every week since the host was built, and from 2026-09-06 to
# 2026-09-08 with six Critical advisories waiting.
#
# THIS IS THE MISSING "AFTER", ON A TIMER RATHER THAN IN A PROCESS THAT IS ABOUT
# TO BE KILLED. It fires five minutes after a boot and every thirty thereafter,
# does nothing at all while /boot has room, and is a refusal in every shape it
# does not recognise.
#
# WHAT IT GIVES UP, AND WHAT IT DOES NOT. Dropping the rollback deployment means
# there is no second /boot entry until the next deployment boots - which is the
# state an attended reboot has always left behind, and the state greenboot.armed
# now reports as a note rather than a fault. The cover arrives with the risk it
# covers: the next boot that can go bad is a boot into a NEW deployment, and at
# that moment the one running now is the fallback.
#
# The deployment is UNMATERIALISED, NOT DESTROYED. What costs 145.3 MiB is the
# kernel in /boot, not the content, so an ostree ref is taken on the outgoing
# commit before it goes. Measured on 2026-09-08: the ref survives both the
# undeploy and the prune that follows, and `ostree ls -R` still reads the tree
# including the 133 MB initramfs. What is NOT yet measured is whether
# `ostree admin deploy` on that ref yields a bootable deployment with a correct
# origin for a container-native system - so deploy.boot_reclaim names the ref and
# claims no more than that.
# ==============================================================================

set -uo pipefail

export PATH="${HOME:-/var/home/core}/.local/bin:$PATH"

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
STATE="${HOME_SERVER_BOOT_STATE:-/var/lib/home-server/boot-state}"
GRUBENV="${HOME_SERVER_GRUBENV:-/boot/grub2/grubenv}"
LOCK="${HOME_SERVER_RECLAIM_LOCK:-/var/lib/home-server/.boot-reclaim.lock}"
OSTREE_REPO=/ostree/repo
PIN_PREFIX=home-server/rollback

# The same floor bin/reboot-host.sh and bin/reboot-when-staged.sh use, and it is
# not arbitrary: ostree asks for 152.3 MB and this is the next round number above
# it. There are now four copies of this number and nothing links them.
BOOT_MIN_MB=160

DRY=""
case "${1:-}" in
	"")        ;;
	--dry-run) DRY=1 ;;
	*)         echo "reclaim-boot-slot: unknown argument: $1" >&2; exit 2 ;;
esac

if [ "$(id -u)" = 0 ]; then priv() { "$@"; }; else priv() { sudo -n "$@"; }; fi

refuse() { printf 'reclaim-boot-slot: NOT reclaiming - %s\n' "$1"; exit 0; }
note()   { printf 'reclaim-boot-slot: %s\n' "$1"; }

# EVERY rpm-ostree CALL IS TIMEOUT-WRAPPED, because none of them is a local
# question. `rpm-ostree status --json` is a D-Bus round trip that BLOCKS while
# rpm-ostreed is staging - host/greenboot/40-home-server.sh says so in as many
# words, and bounds itself for the same reason. A Type=oneshot unit that blocks
# on it sits in `activating` indefinitely, which host.failed_units cannot see:
# it is neither failed nor a container.
ro() { timeout 60 rpm-ostree "$@"; }

# ------------------------------------------------------------------------------
# One at a time
# ------------------------------------------------------------------------------
# rpm-ostree serialises the MUTATION, so nothing here can corrupt anything. What
# it does not do is make the loser behave sensibly: a second caller gets
# "Transaction in progress" and a non-zero exit, and the caller that matters is
# bin/reboot-host.sh, whose final step is an unpin followed by `cleanup -r` with
# `|| die "cleanup failed"`. Between those two lines the pin gate below is open.
# Losing there tells a person that something failed when nothing did, on the one
# path where somebody is reading the output.
#
# First flock in this repository, which is why it is explained here rather than
# assumed. Exit 0 and silently: a second copy of a no-op is not a fault.
mkdir -p "$(dirname "$LOCK")" 2>/dev/null || true
exec 9>"$LOCK" 2>/dev/null || true
if ! flock -n 9 2>/dev/null; then
	exit 0
fi

# ------------------------------------------------------------------------------
# Is there anything to do?  df first, deliberately
# ------------------------------------------------------------------------------
# ONE SYSCALL BEFORE ANY D-BUS CALL. This runs every thirty minutes and does
# nothing on all but a handful of them, so the no-op path must not wake
# rpm-ostreed - asking rpm-ostree a question starts the daemon you were asking
# about, which docs/known-state.md records for a different check.
# SET-BUT-EMPTY IS THE POINT, hence ${VAR+set} rather than ${VAR:-}. The guard
# below is the one thing standing between an unreadable df and `cleanup -r`, and
# with the obvious spelling it could not be reached through the override at all:
# an empty value fell through to the real df and the test measured this machine.
# That is the same shape as a refusal that cannot fire, which this script's own
# header argues against.
if [ -n "${HOME_SERVER_BOOT_FREE_MB+set}" ]; then
	boot_free="$HOME_SERVER_BOOT_FREE_MB"
else
	boot_free=$(df -Pm /boot 2>/dev/null | awk 'NR==2 {print $4}')
fi

# GUARDED BECAUSE EVERY COMPARISON BELOW IS A BARE -ge ON THIS VALUE. An
# unreadable df leaves it empty, `[` errors on the missing operand, and the
# script walks on into a branch that runs `rpm-ostree cleanup -r`.
# bin/verify-host.sh has the same guard on the same number and says why.
case "${boot_free:-}" in
	''|*[!0-9]*) refuse "/boot free space could not be read ('${boot_free:-}') - and unknown is not room" ;;
esac

if [ "$boot_free" -ge "$BOOT_MIN_MB" ]; then
	note "/boot has ${boot_free}M free (want ${BOOT_MIN_MB}M) - nothing to reclaim"
	exit 0
fi

# ------------------------------------------------------------------------------
# What shape is the host in?
# ------------------------------------------------------------------------------
if [ -n "${HOME_SERVER_STATUS_JSON:-}" ]; then
	status_json=$(cat "$HOME_SERVER_STATUS_JSON" 2>/dev/null)
else
	status_json=$(ro status --json 2>/dev/null)
fi
[ -n "$status_json" ] || refuse "rpm-ostree status returned nothing - it may be mid-transaction, or the daemon may be unwell"

txn=$(jq -r '.transaction // empty' <<<"$status_json" 2>/dev/null)
[ -z "$txn" ] || refuse "rpm-ostree has a transaction in progress ($txn)"

# NEVER ASSUME INDEX 0 IS THE BOOTED ONE. It is not, whenever anything is staged
# or pending - which is precisely when this script has work to do. The same
# derivation bin/reboot-host.sh uses before it pins.
booted_idx=$(jq '[.deployments[]] | map(.booted) | index(true)' <<<"$status_json" 2>/dev/null)
depl_count=$(jq '.deployments | length' <<<"$status_json" 2>/dev/null)
case "${booted_idx:-null}" in
	''|null|*[!0-9]*) refuse "could not determine which deployment is booted" ;;
esac

# `.staged` CAN BE null, NOT false, so it is tested the way bin/verify-host.sh
# tests it rather than compared to a literal.
top_staged=$(jq -r '.deployments[0] | if .staged then "yes" else "" end' <<<"$status_json" 2>/dev/null)
top_booted=$(jq -r '.deployments[0] | if .booted then "yes" else "" end' <<<"$status_json" 2>/dev/null)

# HOW MANY SLOTS ARE ACTUALLY SPENT. A staged deployment holds none - finalization
# writes the entry, at shutdown - so this is the only count that maps onto the
# 145.3 MiB this script is trying to recover. bin/verify-host.sh derives the same
# number for greenboot.armed and for the same reason.
boot_entries=$(jq '[.deployments[] | select(.staged | not)] | length' <<<"$status_json" 2>/dev/null)

# ------------------------------------------------------------------------------
# The refusals
# ------------------------------------------------------------------------------
pinned=$(jq '[.deployments[] | select(.pinned)] | length' <<<"$status_json" 2>/dev/null)
[ "${pinned:-0}" -eq 0 ] || refuse "${pinned} deployment(s) pinned - a pin is a deliberate human act and dropping what it protects is not this script's call"

# GRUB IS ARMED TO TAKE THE FALLBACK, so the rollback is the escape hatch and
# this is the worst possible moment to remove it. Read directly rather than
# inferred from the verdict below: it is the sharper test and it costs one
# grub2-editenv. Same source bin/reboot-when-staged.sh reads.
grub_counter=$(priv grub2-editenv "$GRUBENV" list 2>/dev/null | sed -n 's/^boot_counter=//p' | tail -1)
[ -z "$grub_counter" ] || refuse "GRUB is armed to boot the FALLBACK (boot_counter=$grub_counter) - the rollback is the only thing that would catch it.
  Understand why, then:  sudo $REPO/bin/clear-red-boot.sh"

red_at=$(sed -n 's/^red_boot_at=//p' "$STATE" 2>/dev/null | tail -1)
[ -z "$red_at" ] || refuse "a deployment was rejected at $red_at and nobody has cleared it - the rollback stays until somebody knows why"

# THE VERDICT MUST BE THIS BOOT'S. greenboot writes it about two minutes in;
# this timer first fires at five. A verdict from a PREVIOUS boot would let the
# rollback go on the word of a machine that has since restarted for reasons
# nobody has looked at - and the marker is durable precisely so that it outlives
# a reboot, so "there is a green verdict" is not the same question as "this boot
# was judged green".
#
# Compared against /proc/uptime rather than against the timer's own clock:
# OnBootSec= in a USER manager is relative to the user manager's start, not to
# the boot, and the gap is not always small.
gb_result=$(sed -n 's/^greenboot_result=//p' "$STATE" 2>/dev/null | tail -1)
gb_at=$(sed -n 's/^greenboot_checked_at=//p' "$STATE" 2>/dev/null | tail -1)
[ "${gb_result:-}" = green ] || refuse "greenboot's verdict for this host is '${gb_result:-none recorded}' - only a green boot gives up its rollback"

now_epoch=$(date +%s)
uptime_s=$(cut -d. -f1 /proc/uptime)
boot_epoch=$(( now_epoch - uptime_s ))
gb_epoch=$(date -d "${gb_at:-}" +%s 2>/dev/null || echo 0)
[ "${gb_epoch:-0}" -ge "$boot_epoch" ] || refuse "the green verdict is from ${gb_at:-an unknown time}, before this boot began - greenboot has not judged the deployment that is running now"

# THE OTHER WRITERS OF THIS HOST'S STATE, allowlisted rather than denylisted.
# `is-active` is the wrong question for a oneshot - home-server-backup is
# `activating` for the whole time restic runs and never `active` - so a state
# this does not recognise reads as busy, which is the direction that fails safe.
# bin/reboot-when-staged.sh found that one by starting a real backup and
# watching the obvious spelling pass.
for pair in "--user:home-server-reboot.service:the unattended reboot window is running" \
            "--user:home-server-backup.service:the backup is running" \
            ":rpm-ostreed-automatic.service:the nightly OS update check is running"; do
	scope="${pair%%:*}"; rest="${pair#*:}"
	unit="${rest%%:*}"; why="${rest#*:}"
	# shellcheck disable=SC2086  # $scope is deliberately an unquoted empty-or---user
	st=$(systemctl $scope show "$unit" -p ActiveState --value 2>/dev/null)
	case "$st" in
		inactive|failed|"") ;;
		*) refuse "$why ($unit is $st)" ;;
	esac
done

# ------------------------------------------------------------------------------
# Which shape, exactly
# ------------------------------------------------------------------------------
# THE SHAPE IS ASSERTED, NEVER INFERRED FROM ONE FIELD. `rpm-ostree cleanup -r`
# retains [booted] plus pins, so on four deployments it removes three - the "-2"
# in docs/known-state.md is a measurement of one case, not a law. A shape this
# does not enumerate is a shape it must not run a destructive command in.
if [ "${boot_entries:-0}" -lt 2 ]; then
	# ONE /boot ENTRY AND STILL SHORT, which is not a shape with a slot to
	# reclaim - it is a shape whose shortage this script cannot explain. It
	# covers [booted] alone and [staged, booted], and the second is the ordinary
	# state here for six days of every week: a staged deployment writes no entry,
	# so it should be sitting at ~190M and something else has the space.
	#
	# ENTRIES, NOT DEPLOYMENTS. Counting deployments here would have called
	# [staged, booted] a two-slot shape and gone looking for a rollback to drop
	# that does not exist - the same error greenboot.armed was making one file
	# over.
	refuse "there is ${boot_entries:-0} /boot entry and only ${boot_free}M free - no deployment is holding a second slot, so the space is held by something this script does not model. Start with 'sudo du -sh /boot/*'."
elif [ "$booted_idx" -eq 0 ] && [ "$depl_count" -eq 2 ]; then
	:  # [booted, rollback] - the preventive case, below
elif [ -z "$top_booted" ] && [ -z "$top_staged" ]; then
	# PENDING: finalized, entered in /boot, holding a slot, and not booted.
	# `cleanup -r` cannot reclaim this - it exits 0 saying "Deployments
	# unchanged", because a pending deployment is not a rollback. Booting it is
	# the remedy, and it is the reboot that a free-space gate would refuse.
	pending_ver=$(jq -r '.deployments[0].version // "?"' <<<"$status_json" 2>/dev/null)
	refuse "$pending_ver is PENDING - finalized, holding a /boot slot, and not booted. 'cleanup -r' cannot reclaim that slot; booting it is what turns it into a rollback.
  The window applies it on Sunday, or:  sudo systemctl reboot"
else
	refuse "an unrecognised shape: booted at index ${booted_idx} of ${depl_count} deployment(s), index 0 $( [ -n "$top_staged" ] && echo staged || echo finalized). Nothing destructive runs in a shape this script cannot name."
fi

# ------------------------------------------------------------------------------
# The preventive reclaim
# ------------------------------------------------------------------------------
out_csum=$(jq -r '.deployments[1].checksum // empty' <<<"$status_json" 2>/dev/null)
out_ver=$(jq -r '.deployments[1].version // "unknown"' <<<"$status_json" 2>/dev/null)
out_dig=$(jq -r '.deployments[1]["container-image-reference-digest"] // empty' <<<"$status_json" 2>/dev/null)
[ -n "$out_csum" ] || refuse "could not read the rollback deployment's checksum"

pin_ref="$PIN_PREFIX/${out_ver}-$(printf '%s' "$out_csum" | cut -c1-12)"

if [ -n "$DRY" ]; then
	note "would pin $out_ver ($(printf '%s' "$out_csum" | cut -c1-12)) as $pin_ref"
	note "would run 'rpm-ostree cleanup -r', freeing about 145M of the ${boot_free}M-free /boot"
	exit 0
fi

# PIN BEFORE DROPPING, in that order, because the ref is the only thing that
# stops the prune taking the objects with the deployment. Created first and the
# older pins deleted afterwards: the reverse order has a window in which neither
# exists, and there is no --force to make the create idempotent.
if ! priv ostree refs --repo="$OSTREE_REPO" --create="$pin_ref" "$out_csum" 2>/dev/null; then
	note "could not pin $out_ver as $pin_ref - continuing, and recording that the rollback is registry-only"
	pin_ref=""
fi
if [ -n "$pin_ref" ]; then
	# EXACTLY ONE PIN IS KEPT. Older ones name deployments nothing will ever go
	# back to and hold a full tree each on /sysroot.
	priv ostree refs --repo="$OSTREE_REPO" 2>/dev/null | grep "^$PIN_PREFIX/" | grep -vxF "$pin_ref" | while read -r old; do
		priv ostree refs --repo="$OSTREE_REPO" --delete "$old" 2>/dev/null || true
	done
fi

note "reclaiming the slot held by $out_ver ($(printf '%s' "$out_csum" | cut -c1-12))"
if ! priv rpm-ostree cleanup -r 2>&1; then
	err="rpm-ostree cleanup -r failed"
else
	err=""
fi

boot_after=$(df -Pm /boot 2>/dev/null | awk 'NR==2 {print $4}')
case "${boot_after:-}" in ''|*[!0-9]*) boot_after="$boot_free" ;; esac
freed=$(( boot_after - boot_free ))

# FREEING NOTHING IS A FINDING, not a quiet success. It means the slot was held
# by something other than the deployment that was just dropped, which is the same
# blind spot the one-deployment refusal above names.
[ "$freed" -gt 0 ] || err="${err:-cleanup reported success but freed nothing (${boot_free}M before, ${boot_after}M after)}"

now=$(date -u +%Y-%m-%dT%H:%M:%SZ)
{
	grep -vE '^boot_reclaim_(at|action|freed_mb|rollback_ref|destroyed_digest|restaged_digest|error)=' "$STATE" 2>/dev/null
	echo "boot_reclaim_at=$now"
	echo "boot_reclaim_action=rollback"
	echo "boot_reclaim_freed_mb=$freed"
	echo "boot_reclaim_rollback_ref=${pin_ref:-${out_dig:-}}"
	echo "boot_reclaim_error=$err"
} | priv tee "$STATE.tmp" >/dev/null
priv mv "$STATE.tmp" "$STATE"

if [ -n "$err" ]; then
	printf 'reclaim-boot-slot: %s\n' "$err" >&2
	exit 1
fi

note "/boot ${boot_after}M free (was ${boot_free}M); rollback recoverable as ${pin_ref:-the published digest ${out_dig:-unknown}}"

# REPUBLISH THE FINDING RATHER THAN WAITING UP TO AN HOUR FOR IT. status.json is
# rewritten hourly, and deploy.boot_free FAILs at two slots - so without this the
# battery that ran at boot+10min would keep saying `fail` until boot+70min, and
# CheckFailing (== 3, for: 10m, critical) would page the phone about a condition
# that was fixed five minutes into the boot. bin/reboot-host.sh already records
# that status.json can be an hour stale; this is the same fact, acted on.
systemctl --user start --no-block home-server-verify.service 2>/dev/null || true
