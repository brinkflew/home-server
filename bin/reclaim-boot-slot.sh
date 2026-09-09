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
LOCK="${HOME_SERVER_RECLAIM_LOCK:-${XDG_RUNTIME_DIR:-/run/user/$(id -u)}/home-server-boot-reclaim.lock}"
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

# ------------------------------------------------------------------------------
# A refusal that leaves no record is a refusal no check can see
# ------------------------------------------------------------------------------
# EVERY REFUSAL IN THIS FILE WAS INVISIBLE UNTIL 2026-09-09, AND THE COST WAS A
# WHOLE REBOOT WINDOW. write_state() below was the only writer and it always
# sets boot_reclaim_at, so deploy.boot_reclaim read the ABSENCE of that key as
# "the reclaim has not had to do anything yet" - which is true on a quiet week
# and false in exactly the state this script exists for.
#
# Measured, and this is why the sentence above is not hypothetical: on
# 2026-09-06 bin/reboot-when-staged.sh refused five times for "/boot has only
# 26M free (want 160M) and 44.20260817.3.2 is STAGED". This script ran every
# thirty minutes throughout, and on 2026-09-07 at 23:01:21 it was dying at its
# own lock with "Permission denied". deploy.boot_reclaim reported `pass` for all
# of it, and the host spent 21 days behind a CRITICAL advisory.
#
# THE TAG IS A BARE WORD AND NOT THE MESSAGE, for the reason a check id is: the
# prose is written for a person reading the journal and gets reworded freely,
# and a reader keying on it is a check that stops firing the first time somebody
# improves a sentence. Lifted from bin/reboot-when-staged.sh, which paid for
# this lesson first and whose refusals have been on the record since.
#
# NO EXCLUSION LIST, AND THAT IS THE ONE WAY THIS DIFFERS FROM THAT FILE. Its
# refuse() must skip `nothing_staged`, because the absence of work reaches it as
# a refusal and recording that would overwrite the last real refusal on every
# quiet night. Here the absence of work is the `note` at the df gate below,
# which exits without ever calling this - so every call that DOES reach here had
# work in front of it. The flock loser exits 0 on its own path for the same
# reason.
#
# WHAT CLEARS A RECORD IS THEREFORE TWO THINGS, NOT ONE: write_state() below,
# when the reclaim actually happens, and that same df gate, when /boot turns out
# to have room. Most refusals here are transient - a backup running, a
# transaction in progress - and without the second clause one of those would
# leave a tag standing until the next real reclaim, which may be never. The gate
# says why it is sound evidence.
#
# ITS OWN TEMP NAME, NOT THE BARE "$STATE.tmp". This file has five other writers
# and bin/reboot-when-staged.sh is one of them, refusing on Sunday mornings
# between 05:00 and 09:00 - which is when a reclaim refusing for want of a slot
# is at its most likely, and its timer fires at :04 and :34 through exactly that
# window. Two writers sharing one temp path can truncate each other's work;
# bin/verify-restore.sh records that in as many words and takes the same way
# out. Losing a refusal record to a race would be this change failing at the one
# moment it was written for.
#
# NOT under --dry-run, which must change nothing.
refuse() {  # <tag> <message>
	local tag="$1" tmp="$STATE.reclaim.$$"
	if [ -z "$DRY" ]; then
		priv mkdir -p "$(dirname "$STATE")" 2>/dev/null
		{
			grep -vE '^boot_reclaim_refused_(at|tag)=' "$STATE" 2>/dev/null
			echo "boot_reclaim_refused_at=$(date -u +%Y-%m-%dT%H:%M:%SZ)"
			echo "boot_reclaim_refused_tag=$tag"
		} | priv tee "$tmp" >/dev/null
		priv mv "$tmp" "$STATE"
	fi
	printf 'reclaim-boot-slot: NOT reclaiming - %s\n' "$2"
	exit 0
}
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
# assumed.
#
# IT LIVES IN THE RUNTIME DIRECTORY, AND THE FIRST DEPLOYED RUN IS WHY.
# /var/lib/home-server is root-owned - every writer there, this script's own
# state included, goes through `priv tee` - and a flock fd cannot be opened
# through sudo. So the first real run said "Permission denied", and the version
# that shipped it wrote `2>/dev/null || true` and carried on: a lock that FAILS
# OPEN, on the one path that runs `rpm-ostree cleanup -r`, with the mutual
# exclusion silently absent and the unit still exiting 0.
#
# Being unable to take it is therefore a refusal and not a shrug. A lock in
# /var would also have to survive a reboot, which is the opposite of what a lock
# wants.
mkdir -p "$(dirname "$LOCK")" 2>/dev/null || true
if ! touch "$LOCK" 2>/dev/null; then
	refuse lock_unavailable "could not create the lock at $LOCK - refusing rather than running 'rpm-ostree cleanup -r' unguarded"
fi
exec 9>"$LOCK"
# Exit 0 and silently when somebody else holds it: a second copy of a no-op is
# not a fault.
if ! flock -n 9; then
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
	''|*[!0-9]*) refuse boot_free_unknown "/boot free space could not be read ('${boot_free:-}') - and unknown is not room" ;;
esac

if [ "$boot_free" -ge "$BOOT_MIN_MB" ]; then
	# AND THIS IS WHERE A REFUSAL STOPS BEING TRUE, which is the half that makes
	# recording them usable rather than a permanent amber light. Only a
	# successful reclaim clears the record in write_state(), and most refusals
	# here are transient - the backup is running, rpm-ostreed has a transaction,
	# the nightly update check is awake. Any of those leaves a tag standing, and
	# if nothing ever needs reclaiming again nothing ever clears it, so
	# deploy.boot_reclaim would warn for weeks about a condition that resolved
	# itself in half an hour.
	#
	# /boot having room is exactly the statement "whatever that refusal was
	# about, it is not costing a slot now" - the same evidence a successful
	# reclaim provides, arriving by a different route. So it clears the same
	# keys, and nothing else.
	#
	# GUARDED ON THE RECORD EXISTING, so the ordinary path still writes nothing.
	# This runs 48 times a day and does nothing on 47 of them; a whole-file
	# rewrite on each would be this script's own contribution to the write
	# volume it is meant to be cheap about. One grep of a file measured in
	# hundreds of bytes is the price instead, and the write happens once per
	# resolution.
	if [ -z "$DRY" ] && grep -q '^boot_reclaim_refused_at=' "$STATE" 2>/dev/null; then
		tmp="$STATE.reclaim.$$"
		grep -vE '^boot_reclaim_refused_(at|tag)=' "$STATE" 2>/dev/null \
			| priv tee "$tmp" >/dev/null
		priv mv "$tmp" "$STATE"
		note "cleared a standing refusal - /boot has room, so whatever it named is no longer costing a slot"
	fi
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
[ -n "$status_json" ] || refuse status_unreadable "rpm-ostree status returned nothing - it may be mid-transaction, or the daemon may be unwell"

txn=$(jq -r '.transaction // empty' <<<"$status_json" 2>/dev/null)
[ -z "$txn" ] || refuse transaction_in_progress "rpm-ostree has a transaction in progress ($txn)"

# NEVER ASSUME INDEX 0 IS THE BOOTED ONE. It is not, whenever anything is staged
# or pending - which is precisely when this script has work to do. The same
# derivation bin/reboot-host.sh uses before it pins.
booted_idx=$(jq '[.deployments[]] | map(.booted) | index(true)' <<<"$status_json" 2>/dev/null)
depl_count=$(jq '.deployments | length' <<<"$status_json" 2>/dev/null)
case "${booted_idx:-null}" in
	''|null|*[!0-9]*) refuse booted_unknown "could not determine which deployment is booted" ;;
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
[ "${pinned:-0}" -eq 0 ] || refuse deployment_pinned "${pinned} deployment(s) pinned - a pin is a deliberate human act and dropping what it protects is not this script's call"

# GRUB IS ARMED TO TAKE THE FALLBACK, so the rollback is the escape hatch and
# this is the worst possible moment to remove it. Read directly rather than
# inferred from the verdict below: it is the sharper test and it costs one
# grub2-editenv. Same source bin/reboot-when-staged.sh reads.
grub_counter=$(priv grub2-editenv "$GRUBENV" list 2>/dev/null | sed -n 's/^boot_counter=//p' | tail -1)
[ -z "$grub_counter" ] || refuse grub_fallback_armed "GRUB is armed to boot the FALLBACK (boot_counter=$grub_counter) - the rollback is the only thing that would catch it.
  Understand why, then:  sudo $REPO/bin/clear-red-boot.sh"

red_at=$(sed -n 's/^red_boot_at=//p' "$STATE" 2>/dev/null | tail -1)
[ -z "$red_at" ] || refuse red_boot_uncleared "a deployment was rejected at $red_at and nobody has cleared it - the rollback stays until somebody knows why"

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
[ "${gb_result:-}" = green ] || refuse greenboot_not_green "greenboot's verdict for this host is '${gb_result:-none recorded}' - only a green boot gives up its rollback"

now_epoch=$(date +%s)
uptime_s=$(cut -d. -f1 /proc/uptime)
boot_epoch=$(( now_epoch - uptime_s ))
gb_epoch=$(date -d "${gb_at:-}" +%s 2>/dev/null || echo 0)
[ "${gb_epoch:-0}" -ge "$boot_epoch" ] || refuse greenboot_stale "the green verdict is from ${gb_at:-an unknown time}, before this boot began - greenboot has not judged the deployment that is running now"

# THE OTHER WRITERS OF THIS HOST'S STATE, allowlisted rather than denylisted.
# `is-active` is the wrong question for a oneshot - home-server-backup is
# `activating` for the whole time restic runs and never `active` - so a state
# this does not recognise reads as busy, which is the direction that fails safe.
# bin/reboot-when-staged.sh found that one by starting a real backup and
# watching the obvious spelling pass.
# THE TAG IS THE FIRST FIELD RATHER THAN DERIVED FROM THE UNIT NAME, because a
# tag built by mangling "home-server-reboot.service" is a name nothing greps for
# and one nobody can predict from reading deploy.boot_reclaim's message. Three
# refusals share this loop and they are three different situations: the second
# is a refusal the next run clears, the third is one that clears itself in
# minutes, and the first means the reboot window and this script are both awake
# and neither can proceed.
for pair in "busy_reboot_window:--user:home-server-reboot.service:the unattended reboot window is running" \
            "busy_backup:--user:home-server-backup.service:the backup is running" \
            "busy_os_update::rpm-ostreed-automatic.service:the nightly OS update check is running"; do
	tag="${pair%%:*}"; rest="${pair#*:}"
	scope="${rest%%:*}"; rest="${rest#*:}"
	unit="${rest%%:*}"; why="${rest#*:}"
	# shellcheck disable=SC2086  # $scope is deliberately an unquoted empty-or---user
	st=$(systemctl $scope show "$unit" -p ActiveState --value 2>/dev/null)
	case "$st" in
		inactive|failed|"") ;;
		*) refuse "$tag" "$why ($unit is $st)" ;;
	esac
done

# ------------------------------------------------------------------------------
# Which shape, exactly
# ------------------------------------------------------------------------------
# THE SHAPE IS ASSERTED, NEVER INFERRED FROM ONE FIELD. `rpm-ostree cleanup -r`
# retains [booted] plus pins, so on four deployments it removes three - the "-2"
# in docs/known-state.md is a measurement of one case, not a law. A shape this
# does not enumerate is a shape it must not run a destructive command in.
mode="" out_idx=""
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
	refuse space_unmodelled "there is ${boot_entries:-0} /boot entry and only ${boot_free}M free - no deployment is holding a second slot, so the space is held by something this script does not model. Start with 'sudo du -sh /boot/*'."
elif [ "$booted_idx" -eq 0 ] && [ "$depl_count" -eq 2 ]; then
	# [booted, rollback]. The ordinary case, and the one the timer exists for:
	# this is what every applied deployment leaves behind.
	mode=preventive out_idx=1
elif [ "$booted_idx" -eq 1 ] && [ "$depl_count" -eq 3 ] && [ -n "$top_staged" ]; then
	# [staged, booted, rollback] - the wedged shape, and the one that took three
	# days and six Critical advisories in September 2026. It is only reachable
	# when the preventive arm did not run, or could not.
	mode=repair out_idx=2
elif [ -z "$top_booted" ] && [ -z "$top_staged" ]; then
	# PENDING: finalized, entered in /boot, holding a slot, and not booted.
	# `cleanup -r` cannot reclaim this - it exits 0 saying "Deployments
	# unchanged", because a pending deployment is not a rollback. Booting it is
	# the remedy, and it is the reboot that a free-space gate would refuse.
	pending_ver=$(jq -r '.deployments[0].version // "?"' <<<"$status_json" 2>/dev/null)
	refuse pending_deployment "$pending_ver is PENDING - finalized, holding a /boot slot, and not booted. 'cleanup -r' cannot reclaim that slot; booting it is what turns it into a rollback.
  The window applies it on Sunday, or:  sudo systemctl reboot"
else
	refuse shape_unrecognised "an unrecognised shape: booted at index ${booted_idx} of ${depl_count} deployment(s), index 0 $( [ -n "$top_staged" ] && echo staged || echo finalized). Nothing destructive runs in a shape this script cannot name."
fi

# ------------------------------------------------------------------------------
# The reclaim
# ------------------------------------------------------------------------------
out_csum=$(jq -r --argjson i "$out_idx" '.deployments[$i].checksum // empty' <<<"$status_json" 2>/dev/null)
out_ver=$(jq -r --argjson i "$out_idx" '.deployments[$i].version // "unknown"' <<<"$status_json" 2>/dev/null)
out_dig=$(jq -r --argjson i "$out_idx" '.deployments[$i]["container-image-reference-digest"] // empty' <<<"$status_json" 2>/dev/null)
[ -n "$out_csum" ] || refuse checksum_unreadable "could not read the outgoing deployment's checksum"

pin_ref="$PIN_PREFIX/${out_ver}-$(printf '%s' "$out_csum" | cut -c1-12)"

# ONE MERGE, SO A KEY THIS SCRIPT DOES NOT OWN IS NEVER LOST. Same contract as
# host/greenboot/40-home-server.sh's record(), which did the opposite until
# 2026-09-08 and silently killed two checks by it.
#
# AND IT CLEARS THE REFUSAL KEYS, which is what makes a success and a refusal
# tell one story rather than two. Without this a reclaim that refused at 04:34
# and succeeded at 05:04 would leave both records standing, and
# deploy.boot_reclaim compares their timestamps - so the stale refusal would
# outrank the success for as long as nothing refused again. The refusal is
# history the moment the thing it refused has been done.
write_state() {  # <action> <freed_mb> <rollback_ref> <destroyed_digest> <restaged_digest> <error>
	local tmp="$STATE.reclaim.$$"
	{
		grep -vE '^boot_reclaim_(at|action|freed_mb|rollback_ref|destroyed_digest|restaged_digest|error|refused_at|refused_tag)=' "$STATE" 2>/dev/null
		echo "boot_reclaim_at=$(date -u +%Y-%m-%dT%H:%M:%SZ)"
		echo "boot_reclaim_action=$1"
		echo "boot_reclaim_freed_mb=$2"
		echo "boot_reclaim_rollback_ref=$3"
		echo "boot_reclaim_destroyed_digest=$4"
		echo "boot_reclaim_restaged_digest=$5"
		echo "boot_reclaim_error=$6"
	} | priv tee "$tmp" >/dev/null
	priv mv "$tmp" "$STATE"
}

# THE OBJECT CHECKSUMS OF A DEPLOYMENT'S KERNEL AND INITRAMFS, read out of the
# repo's metadata rather than by hashing 150 MB twice. This is the only honest
# way to ask whether two deployments need separate /boot slots: a package diff
# cannot answer it - uCore rebuilds the initramfs on every image build, and
# 2026-08-24's staged deployment differed by one perl package, carried an
# IDENTICAL kernel version, reported regenerate-initramfs false, and still
# produced an initramfs one byte different and a different bootcsum.
kern_id() {  # <commit checksum>
	local c="$1" kv
	kv=$(priv ostree ls --repo="$OSTREE_REPO" "$c" /usr/lib/modules 2>/dev/null \
		| awk '$1 ~ /^d/ && $NF != "/usr/lib/modules" {print $NF}' | head -1)
	[ -n "$kv" ] || return 1
	priv ostree ls -C --repo="$OSTREE_REPO" "$c" "$kv/vmlinuz" "$kv/initramfs.img" 2>/dev/null \
		| awk '{print $5}' | paste -sd- -
}

staged_dig=""
if [ "$mode" = repair ]; then
	# ------------------------------------------------------------------------
	# The repair arm is destructive in a way the preventive one is not
	# ------------------------------------------------------------------------
	# It gives up the staged update to get the slot, because nothing keeps one.
	# `rpm-ostree cleanup -r` takes the pending deployment along with the
	# rollback - deployment count change: -2 - and so does
	# `ostree admin undeploy` on the rollback index alone, measured on this host
	# on 2026-09-08 in the hope that it would not. Any write_deployments on a
	# sysroot with a staged deployment unstages it, so there is no single-slot
	# spelling of this and the update has to be put back afterwards.
	#
	# AND IT DOES NOT COME BACK ON ITS OWN. After 2026-08-16 the next two
	# automatic runs staged nothing while a newer manifest sat on the registry,
	# because `rpm-ostree upgrade --check` can be wrong and the nightly updater
	# believes it. So the re-stage is this script's job, not the timer's.
	staged_csum=$(jq -r '.deployments[0].checksum // empty' <<<"$status_json" 2>/dev/null)
	staged_dig=$(jq -r '.deployments[0]["container-image-reference-digest"] // empty' <<<"$status_json" 2>/dev/null)
	booted_csum=$(jq -r --argjson i "$booted_idx" '.deployments[$i].checksum // empty' <<<"$status_json" 2>/dev/null)

	# ONCE PER IMAGE, NOT ONCE PER HALF HOUR. Without this a shape that survives
	# the repair would destroy and re-pull the same image every cycle - and each
	# re-stage rewrites /run/ostree/staged-deployment's mtime, which is the clock
	# bin/reboot-when-staged.sh reads for staged_age_d. That would silently
	# starve the 14-day encoder escalation, leaving only the uptime backstop,
	# which is the clause that exists BECAUSE the other one can be starved.
	#
	# Keyed on the container digest and never on .checksum: a re-stage of the
	# same image produces a DIFFERENT layered commit checksum - measured,
	# 5858c3b7b9d0 became 84120b9db526 for one digest f7b6e02b1a5b.
	prev_gone=$(sed -n 's/^boot_reclaim_destroyed_digest=//p' "$STATE" 2>/dev/null | tail -1)
	prev_at=$(sed -n 's/^boot_reclaim_at=//p' "$STATE" 2>/dev/null | tail -1)
	if [ -n "$prev_gone" ] && [ "$prev_gone" = "$staged_dig" ]; then
		prev_epoch=$(date -d "${prev_at:-}" +%s 2>/dev/null || echo 0)
		if [ "$(( now_epoch - prev_epoch ))" -lt 604800 ]; then
			refuse restage_repeat "this same image was already destroyed and re-staged at ${prev_at:-an unknown time} and /boot is short again - something other than the rollback is taking the space, and re-pulling it weekly will not find out what"
		fi
	fi
	# DOES IT ACTUALLY NEED A SLOT? If the staged deployment carries the same
	# kernel and initramfs as the booted one it needs no new bootcsum directory,
	# and destroying an update to make room it does not want is the worst
	# outcome available here. Both sides must be readable: an unanswerable
	# comparison refuses, rather than defaulting to the destructive branch.
	sk=$(kern_id "$staged_csum") bk=$(kern_id "$booted_csum")
	if [ -z "$sk" ] || [ -z "$bk" ]; then
		refuse kernel_compare_failed "could not compare the staged and booted kernels - this arm must not destroy an update it cannot prove needs the space"
	fi
	if [ "$sk" = "$bk" ]; then
		refuse kernel_identical "the staged $(jq -r '.deployments[0].version' <<<"$status_json") carries the same kernel and initramfs as the booted deployment, so it needs no new /boot slot - whatever is short here, it is not that"
	fi

	# IS THE REGISTRY REACHABLE RIGHT NOW? Ordering matters more than the check:
	# destroying a staged update and THEN discovering the pull cannot be redone
	# leaves the host with no rollback, nothing staged, 190M free and a green
	# battery - a loud condition converted into a quiet one. The re-stage below
	# usually resolves from the local repo in about twenty seconds, but nothing
	# guarantees it will.
	probe_ref=$(jq -r --argjson i "$booted_idx" '.deployments[$i]["container-image-reference"] // empty' <<<"$status_json" 2>/dev/null)
	probe_ref=${probe_ref#*:}; probe_ref=${probe_ref#docker://}
	if [ -n "$probe_ref" ]; then
		timeout 20 skopeo inspect --raw "docker://$probe_ref" >/dev/null 2>&1 \
			|| refuse registry_unreachable "cannot reach the registry for $probe_ref - refusing to destroy a staged update that might not come back"
	fi

fi

if [ -n "$DRY" ]; then
	note "mode: $mode"
	note "would pin $out_ver ($(printf '%s' "$out_csum" | cut -c1-12)) as $pin_ref"
	note "would run 'rpm-ostree cleanup -r', freeing about 145M of the ${boot_free}M-free /boot"
	[ "$mode" = repair ] && note "would then run 'rpm-ostree upgrade' to put back the staged ${staged_dig:0:19} it takes"
	exit 0
fi

# PIN BEFORE DROPPING, in that order, because the ref is the only thing that
# stops the prune taking the objects with the deployment. Created first and the
# older pins deleted afterwards: the reverse has a window in which neither
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

# THE DESTRUCTION IS RECORDED BEFORE IT HAPPENS. If this process dies between
# the cleanup and the re-stage - a reboot, an OOM, a SIGTERM - the record
# already says an update was destroyed and none put back, which is the one
# state deploy.boot_reclaim FAILs on. Writing it afterwards would make the
# crash indistinguishable from a run that never started.
[ "$mode" = repair ] && write_state repair "" "${pin_ref:-${out_dig:-}}" "$staged_dig" "" "in progress"

note "reclaiming the slot held by $out_ver ($(printf '%s' "$out_csum" | cut -c1-12))"
err=""
priv rpm-ostree cleanup -r 2>&1 || err="rpm-ostree cleanup -r failed"

restaged=""
if [ "$mode" = repair ] && [ -z "$err" ]; then
	note "re-staging the update that cleanup took"
	# Ten minutes rather than the ro() sixty seconds: this one can be a cold
	# pull. Measured warm at 21.9s, resolving entirely from the local repo.
	if timeout 600 priv rpm-ostree upgrade 2>&1; then
		restaged=$(rpm-ostree status --json 2>/dev/null \
			| jq -r '.deployments[0] | select(.booted | not) | .["container-image-reference-digest"] // empty' 2>/dev/null)
		[ -n "$restaged" ] || err="rpm-ostree upgrade reported success but nothing is staged"
	else
		err="rpm-ostree upgrade failed - a staged update was destroyed and not put back"
	fi
fi

boot_after=$(df -Pm /boot 2>/dev/null | awk 'NR==2 {print $4}')
case "${boot_after:-}" in ''|*[!0-9]*) boot_after="$boot_free" ;; esac
freed=$(( boot_after - boot_free ))

# FREEING NOTHING IS A FINDING, not a quiet success. It means the slot was held
# by something other than the deployment that was just dropped, which is the same
# blind spot the one-entry refusal above names.
[ "$freed" -gt 0 ] || err="${err:-cleanup reported success but freed nothing (${boot_free}M before, ${boot_after}M after)}"

write_state "${mode}" "$freed" "${pin_ref:-${out_dig:-}}" "${staged_dig}" "${restaged}" "$err"

if [ -n "$err" ]; then
	printf 'reclaim-boot-slot: %s\n' "$err" >&2
	exit 1
fi

note "/boot ${boot_after}M free (was ${boot_free}M); rollback recoverable as ${pin_ref:-the published digest ${out_dig:-unknown}}"
[ "$mode" = repair ] && note "re-staged ${restaged:0:19}"

# REPUBLISH THE FINDING RATHER THAN WAITING UP TO AN HOUR FOR IT. status.json is
# rewritten hourly, and deploy.boot_free FAILs at two slots - so without this the
# battery that ran at boot+10min would keep saying `fail` until boot+70min, and
# CheckFailing (== 3, for: 10m, critical) would page the phone about a condition
# that was fixed five minutes into the boot. bin/reboot-host.sh already records
# that status.json can be an hour stale; this is the same fact, acted on.
systemctl --user start --no-block home-server-verify.service 2>/dev/null || true
