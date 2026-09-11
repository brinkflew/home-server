#!/usr/bin/env bash
# ==============================================================================
# Apply a staged deployment, unattended, but only when it is safe to
# ------------------------------------------------------------------------------
# RUNS ON THE SERVER, as `core`, from home-server-reboot.timer. This is the other
# half of greenboot: greenboot decides whether a deployment was good AFTER the
# reboot, and this decides whether to reboot at all.
#
#   bin/reboot-when-staged.sh --dry-run   say what it would do, change nothing
#   bin/reboot-when-staged.sh             reboot, if every gate below passes
#
# IT IS ALL REFUSALS, WITH ONE NAMED EXCEPTION. Every check here is a reason NOT
# to reboot, and the default is to do nothing - because nobody is watching, the
# machine has no console, and a morning where it declines to reboot costs nothing
# while a morning where it should not have costs a car journey.
# bin/reboot-host.sh is the attended equivalent and is deliberately more
# permissive: a person is reading its output and can decide, so it warns where
# this refuses.
#
# THERE ARE TWO WINDOWS. Sunday 05:00-09:00 applies anything staged; Mon..Sat
# 06:00-09:00 applies only a staged deployment carrying a CRITICAL advisory, and
# the gate for that is the first thing past nothing_staged below. A weekday
# morning with no critical is a note and an exit 0, never a recorded refusal.
#
# THE NAMED EXCEPTIONS ARE THE THREE MID-FLIGHT GATES, and they exist because a
# gate that is correct every time can still be wrong in aggregate. The window is
# five attempts on one Sunday morning; a Tdarr queue spanning all five costs the
# deployment a week, and a queue that does so repeatedly costs it indefinitely.
#
#   the encoder   past 14 days staged or 30 days of uptime the script kills the
#                 transcode and applies, because at that point one hour of GPU
#                 time is cheaper than another month on a superseded image.
#   a phase       gives way after the second refusal of a morning - a killed
#                 phase costs one re-run against a worktree still on disk.
#   playback      gives way after the second refusal of a morning - a dropped
#                 stream costs about fifteen seconds and Jellyfin has already
#                 saved the position.
#
# The two cheap ones are counted per morning and the expensive one is measured
# in days, which is the whole of how the three are priced apart. Every other
# gate here refuses without limit.
#
# THE ONE GATE THAT IS NOT ABOUT THIS REBOOT is the red_boot_at marker. FCOS's
# own documentation names the trap: nothing tells the updater that an image was
# bad, so it re-stages the same digest within the day. Without this gate, an
# armed greenboot plus this timer is a host that reverts and re-applies a broken
# deployment every single night, healing nothing and telling nobody. The marker
# is written by the red.d hook and cleared by a person, which is the point - the
# question it asks is "do you know why that deployment was rejected".
# ==============================================================================

set -uo pipefail

export PATH="${HOME:-/var/home/core}/.local/bin:$PATH"

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
STATE="${HOME_SERVER_BOOT_STATE:-/var/lib/home-server/boot-state}"
GRUBENV="${HOME_SERVER_GRUBENV:-/boot/grub2/grubenv}"
BOOT_MIN_MB=160

DRY=""
case "${1:-}" in
	"")        ;;
	--dry-run) DRY=1 ;;
	*)         echo "reboot-when-staged: unknown argument: $1" >&2; exit 2 ;;
esac

if [ "$(id -u)" = 0 ]; then priv() { "$@"; }; else priv() { sudo -n "$@"; }; fi

# EVERY REFUSAL NOW LEAVES A RECORD, because the five that fired on 2026-09-06
# left none. All five refused for /boot space, the whole window was spent, the
# host stayed three weeks behind a CRITICAL advisory - and the only trace was in
# the journal, which nothing grades and which rotates. `reboot.window_run` said
# the unit ran and exited 0, which was true and told nobody anything: this
# script exits 0 on every refusal by design, so success and refusal are the same
# exit code by construction.
#
# THE TAG IS A BARE WORD AND NOT THE MESSAGE, for the reason a check id is: the
# prose is written for a person reading the journal and gets reworded freely,
# and a reader keying on it is a check that stops firing the first time somebody
# improves a sentence.
#
# NOT under --dry-run, which must change nothing - and NOT for nothing_staged,
# which is the absence of work rather than a refusal to do it. Recording that
# would overwrite the last real refusal on every quiet night of the week, which
# is most of them, and the record would always say "nothing was staged".
refuse() {  # <tag> <message>
	local tag="$1"
	if [ -z "$DRY" ] && [ "$tag" != nothing_staged ]; then
		# The whole-file rewrite that keeps every key it does not own - the
		# shape the phase, CI and playback counters below already use, and the
		# one record() got wrong once by rewriting the file and destroying
		# twelve keys that belonged to other writers.
		priv mkdir -p "$(dirname "$STATE")" 2>/dev/null
		{
			grep -vE '^window_refused_(at|tag)=' "$STATE" 2>/dev/null
			echo "window_refused_at=$(date -u +%Y-%m-%dT%H:%M:%SZ)"
			echo "window_refused_tag=$tag"
		} | priv tee "$STATE.tmp" >/dev/null
		priv mv "$STATE.tmp" "$STATE"
	fi
	printf 'reboot-when-staged: NOT rebooting - %s\n' "$2"
	exit 0
}
note()   { printf 'reboot-when-staged: %s\n' "$1"; }

# ------------------------------------------------------------------------------
# Is there anything to apply?
# ------------------------------------------------------------------------------
# Exit 0 rather than 1: "nothing staged" is the normal state on most nights and
# a timer that goes red on a quiet week is a timer people stop reading.
# HOME_SERVER_STATUS_JSON exists so the refusals below can be exercised without
# waiting for a real deployment to stage. This script is nothing BUT refusals,
# and every gate past the first is unreachable on a host with nothing staged -
# which is most nights. An untestable refusal is the same shape as a check that
# cannot fail, and this repository has found enough of those.
if [ -n "${HOME_SERVER_STATUS_JSON:-}" ]; then
	status_json=$(cat "$HOME_SERVER_STATUS_JSON" 2>/dev/null)
else
	status_json=$(rpm-ostree status --json 2>/dev/null)
fi
[ -n "$status_json" ] || refuse status_unreadable "rpm-ostree status returned nothing"

# INDEX 0 IS WHAT BOOTS NEXT, AND `select(.staged)` IS NOT - see the long note at
# next_dep in bin/verify-host.sh. Written the obvious way this gate was blind to
# a FINALIZED pending deployment (.staged=false, /boot entry already written),
# and refused "nothing is staged" about a deployment sitting ready at index 0.
# That is not a missed opportunity, it is a permanent one: nothing else applies
# it, so the deployment stays unbooted and its /boot slot stays spent, every
# Sunday, for ever, with no human in the loop. Found on 2026-08-18.
staged=$(jq -r '.deployments[0] | select(.booted | not) | .version // empty' <<<"$status_json")
[ -n "$staged" ] || refuse nothing_staged "nothing is waiting to boot"

# ------------------------------------------------------------------------------
# Is this morning's window mine to use?
# ------------------------------------------------------------------------------
# THE TIMER FIRES SIX MORNINGS MORE THAN IT USED TO, AND ONLY A CRITICAL ADVISORY
# EARNS ONE. home-server-reboot.timer gained `Mon..Sat 06..09:00` because
# deploy.image_age gives a staged critical a THREE-DAY deadline while the only
# unattended path to apply one was weekly - so a critical landing on a Monday
# warned for three of the six days before Sunday and the remedy was always a
# person. A timer cannot be conditional, so the calendar widened and this gate is
# the condition.
#
# note() AND exit 0, NEVER refuse(). An ordinary weekday morning is the ABSENCE OF
# WORK, not a refusal to do it - exactly the category refuse() already exempts
# nothing_staged for, and for the same reason it gives: four attempts a morning,
# six mornings a week, would overwrite the last real refusal before anybody read
# it, and reboot.window_refused would permanently report "not my window".
#
# AND IT IS PLACED HERE ON PURPOSE: after nothing_staged, so a quiet night still
# answers the way it always did, and BEFORE the red-boot, health and /boot gates,
# which cost a full verify-host.sh --greenboot run. Six extra mornings of that for
# nothing is the kind of cost that gets a gate removed later by somebody who never
# learns why it was cheap to keep.
#
# THE ADVISORY COMES FROM THE TEXT FORM, because there is none in the JSON -
# bin/verify-host.sh records that it checked. That is a second rpm-ostree call, but
# the --json call above has already started the daemon, so it costs a round trip
# rather than a daemon start. HOME_SERVER_RPM_OSTREE_TEXT is spelled exactly as
# verify-host.sh spells it, or the two drift and only one of them is testable.
#
# NOT the escalation, deliberately. ESCALATE_STAGED_D below lets an old deployment
# outrank a running transcode; a critical advisory buys a WINDOW and nothing more.
# Compounding them would mean a critical advisory could also kill a transcode on a
# Tuesday, which is a second decision wearing the first one's clothes.
#
# HOME_SERVER_DOW EXISTS FOR THE SAME REASON HOME_SERVER_STATUS_JSON DOES. Without
# it the Sunday branch - which is the MAIN path, the one that applies an ordinary
# deployment - is unreachable six days a week and the weekday branch is
# unreachable on the seventh, so whichever day somebody tests on, half of this
# gate is a branch nobody has ever seen run. That is the shape of a check that
# cannot fail, and the header above already says this repository has found enough
# of those.
dow="${HOME_SERVER_DOW:-$(date +%u)}"   # 1..7, Monday..Sunday
case "$dow" in
	[1-7]) ;;
	*) refuse dow_unreadable "the day of the week read as '$dow', and a gate that cannot tell Sunday from Tuesday must not choose either" ;;
esac

# AND THE HOUR, BECAUSE THE TIMER IS NOT THE ONLY THING THAT CAN START THIS UNIT.
# Learned on 2026-09-11 and the hard way: `git pull && systemctl --user
# daemon-reload` is THE deploy command for this repository, and one second after a
# reload that added the weekday calendar below, this service started and rebooted
# the host at 00:46. Every gate it passed it passed correctly - a critical
# advisory was staged, the host was healthy, nothing was mid-transcode - so the
# outcome was the right one, taken at the wrong time by nobody's decision.
#
# THE MECHANISM IS UNEXPLAINED AND THIS GATE DOES NOT DEPEND ON KNOWING IT.
# Persistent=no, no clock step in the journal, nothing Wants= or Requires= this
# service, and the timer is its only declared activator - yet a throwaway timer
# built to the same shape (two OnCalendars added by a reload, Persistent=false,
# RandomizedDelaySec=10min, already triggered once this boot) did NOT fire, twice.
# So what is written here is what was measured, not a cause.
#
# A WINDOW IS A WINDOW, WHATEVER STARTED THE UNIT. 00:46 is outside every window
# this timer declares, so the honest answer at 00:46 is no - and that is true of a
# person running `systemctl --user start` by hand at the wrong moment too, which
# is the same hole and was always open. --dry-run is how you exercise it out of
# hours; bin/reboot-host.sh is how you reboot deliberately.
#
# RECORDED AS A REFUSAL, unlike the weekday skip below. This one is not the
# absence of work - something asked for a reboot at a time nothing should have -
# and reboot.window_refused naming `outside_window` is how that reaches a reader
# rather than scrolling past in the journal.
hour="${HOME_SERVER_HOUR:-$(date +%H)}"
case "$hour" in
	0[0-9]|1[0-9]|2[0-3]) ;;
	*) refuse hour_unreadable "the hour read as '$hour', and a window gate that cannot tell 06 from 00 must not choose either" ;;
esac
# Strip the leading zero before comparing, or `08` and `09` are invalid octal.
hour_n=$((10#$hour))
if [ "$dow" = 7 ]; then win_from=05; else win_from=06; fi
if [ "$hour_n" -lt "$win_from" ] || [ "$hour_n" -gt 9 ]; then
	refuse outside_window "it is ${hour}:xx, and this morning's window is ${win_from}:00-09:59 - something started this unit outside it. The timer is the only thing that should, so check what did: journalctl --user -u home-server-reboot.service"
fi
if [ "$dow" != 7 ]; then
	if [ -n "${HOME_SERVER_RPM_OSTREE_TEXT:-}" ]; then
		status_text=$(cat "$HOME_SERVER_RPM_OSTREE_TEXT" 2>/dev/null)
	else
		status_text=$(rpm-ostree status 2>/dev/null)
	fi
	# "SecAdvisories: 4 moderate, 2 important, 1 critical" - the count immediately
	# before the word, and absent entirely when there are none.
	adv_critical=$(sed -n 's/.*SecAdvisories:.*[^0-9]\([0-9]\+\) critical.*/\1/p' \
		<<<"$status_text" | tail -1)
	# GUARDED ON THE VARIABLE, NOT ON AN EXPANSION OF IT, and the first version of
	# this was written the wrong way: `case "${adv_critical:-0}"` defaults inside
	# the case EXPRESSION and assigns nothing, so an absent SecAdvisories line left
	# adv_critical empty, `[ "$adv_critical" -eq 0 ]` failed with "integer
	# expected", and - there being no `set -e` here - the gate fell through and
	# PROCEEDED. That is the unsafe direction, and it is the same shape as the
	# boot_free guard further down, which this file already carries a note about
	# for the same reason: a bare -lt on an unreadable df once let this gate pass
	# as if there were room. Caught by driving both directions through
	# HOME_SERVER_RPM_OSTREE_TEXT; it reads as a pass on the no-critical case,
	# which is exactly what it would have done at 06:00 unattended.
	case "$adv_critical" in
		''|*[!0-9]*) adv_critical=0 ;;
	esac
	if [ "$adv_critical" -eq 0 ]; then
		note "$staged is waiting but carries no critical advisory, and today is not Sunday - the weekday window exists for a critical advisory only. The Sunday window will apply it."
		exit 0
	fi
	note "today is not Sunday, but $staged carries $adv_critical CRITICAL advisory(s) - this window is for exactly that"
fi

# WOULD THIS REBOOT APPLY IT, OR ROLL BACK? custom.cfg selects the PREVIOUS
# deployment whenever boot_counter is set and boot_success is 0, and boot_success
# is set to 1 only by a green greenboot run - so a red boot leaves GRUB armed
# until the machine boots green once. Rebooting into that unattended does the
# exact damage this whole script exists to prevent: it rolls back silently, and
# the deployment it declined to boot stays finalized and unbooted, holding a
# /boot slot on a partition that has two. Exactly what happened on 2026-08-18,
# attended, where at least someone was reading the output.
#
# This does NOT deadlock, which is the trap this repo has hit three times: the
# marker is clearable without a reboot, and the refusal names how.
grub_counter=$(priv grub2-editenv "$GRUBENV" list 2>/dev/null | sed -n 's/^boot_counter=//p' | tail -1)
[ -z "$grub_counter" ] || refuse grub_fallback_armed "GRUB is armed to boot the FALLBACK (boot_counter=$grub_counter);
  this reboot would roll back rather than apply $staged.
  Understand why, then:  sudo $REPO/bin/clear-red-boot.sh"

depl_count=$(jq '.deployments | length' <<<"$status_json")

# HOW LONG THIS ONE HAS BEEN WAITING, which is what decides below whether a
# transcode still outranks an OS update. /run/ostree/staged-deployment is the
# same source bin/verify-host.sh uses for its MOTD line.
#
# THIS COMMENT USED TO SAY "a staged deployment cannot outlive a reboot", AND
# THAT IS FALSE. ostree-finalize-staged FINALIZES it at shutdown; it does not
# make GRUB boot it. If GRUB takes the fallback, the deployment outlives the
# reboot as a pending one - finalized, entered in /boot, unbooted - and
# /run/ostree/staged-deployment is gone, because staging really did end. So the
# `else 0` below reported a fortnight-old deployment as brand new, which is the
# direction that silently disables the escalation: the transcode gate would
# outrank it for ever. Fall back to the boot entry's own mtime, which is written
# at finalization and is exactly "since this became ready to boot".
#
# The override exists for the same reason HOME_SERVER_STATUS_JSON does, and the
# reason is stronger: the escalation below is unreachable for a fortnight, and a
# branch nobody can reach is the same shape as one that cannot fire.
if [ -n "${HOME_SERVER_STAGED_AGE_DAYS:-}" ]; then
	staged_age_d="$HOME_SERVER_STAGED_AGE_DAYS"
elif [ -e /run/ostree/staged-deployment ]; then
	staged_age_d=$(( ( $(date +%s) - $(stat -c %Y /run/ostree/staged-deployment) ) / 86400 ))
else
	# Newest boot entry, which for a pending deployment is its own. `stat` on a
	# glob that matches nothing yields no output, so the arithmetic is guarded
	# rather than assumed - `set -u` is on and this runs unattended.
	newest=$(priv stat -c %Y /boot/ostree/*/ 2>/dev/null | sort -n | tail -1)
	if [ -n "${newest:-}" ]; then
		staged_age_d=$(( ( $(date +%s) - newest ) / 86400 ))
	else
		staged_age_d=0
	fi
fi
uptime_d=$(( $(cut -d. -f1 /proc/uptime) / 86400 ))

# HOW LONG THE HOST HAS BEEN BEHIND, which is the only one of the three clocks
# below that nothing local can reset - and the one that was missing.
#
# The comment at the escalation predicted staged_age_d resetting "when a new
# image supersedes it" and called that right. It is worse than that: MEASURED on
# 2026-09-09, rpm-ostreed re-stamped /run/ostree/staged-deployment at 08:21 for
# an UNCHANGED digest, the same 44.20260817.3.2 that had been staged for days.
# So the clock resets nightly whether or not anything moved, staged_age_d is
# pinned near zero for ever, and ESCALATE_STAGED_D=14 was unreachable rather
# than merely slow. Only the uptime backstop could ever fire.
#
# base-timestamp is the commit's own build time. It moves when the CONTENT
# moves, so nothing on this host can touch it. Same derivation as
# deploy.image_age in bin/verify-host.sh, deliberately - two readers, one
# definition of "behind".
booted_base_ts=$(jq -r '(.deployments[] | select(.booted)
	| .["base-timestamp"]) // empty' <<<"$status_json" 2>/dev/null)
if [ -n "${HOME_SERVER_IMAGE_LAG_DAYS:-}" ]; then
	image_lag_d="$HOME_SERVER_IMAGE_LAG_DAYS"
elif [ -n "${booted_base_ts:-}" ]; then
	image_lag_d=$(( ( $(date +%s) - booted_base_ts ) / 86400 ))
else
	# Unknown is not "fresh". Zero disables only the escalation, never a
	# refusal, so the safe direction here is the one that keeps refusing.
	image_lag_d=0
fi

note "staged $staged (${staged_age_d}d ago), booted image ${image_lag_d}d old, $depl_count deployment(s) on disk, up ${uptime_d}d"

# ------------------------------------------------------------------------------
# Would greenboot be able to undo this?
# ------------------------------------------------------------------------------
# Rebooting into a new deployment with no safety net is exactly the attended
# procedure, and this is not attended. Both halves have to be there: the check in
# required.d, and the GRUB counter - either alone is inert, silently.
[ -x /usr/libexec/greenboot/greenboot ] || refuse greenboot_missing "greenboot is not installed - a bad deployment could not roll itself back"
[ -e /etc/greenboot/check/required.d/40-home-server.sh ] || refuse greenboot_not_required "the health check is not in required.d - greenboot would only log"
[ -f /boot/grub2/custom.cfg ] || refuse greenboot_no_counter "no GRUB boot counter - greenboot could not roll back"
[ "$depl_count" -ge 2 ] || refuse no_rollback "only $depl_count deployment - there would be nothing to roll back to"

# ------------------------------------------------------------------------------
# Did the last attempt end badly?
# ------------------------------------------------------------------------------
# WHICH deployment was rejected, not merely that one was. Refusing on the
# timestamp alone was right for the image that failed and wrong for its fix: once
# ublue publishes a corrected image nothing could tell the two apart, so this
# gate went on declining every Sunday until a human cleared the marker by hand -
# the "host silently stops taking OS security updates" failure from a third
# direction. It held from 11:55 on 2026-08-18 and was cleared manually.
#
# A MARKER WITH NO CHECKSUM STILL BLOCKS EVERYTHING. Markers written before this
# change carry no identity, and treating "no checksum" as "no match" would
# quietly un-hold every one of them - turning a safety change into a silent
# release of exactly the brake it is about. Absent means block, which is also
# what happens when the wrapper could not read the checksum at all.
red=$(sed -n 's/^red_boot_at=//p' "$STATE" 2>/dev/null | tail -1)
red_csum=$(sed -n 's/^red_boot_csum=//p' "$STATE" 2>/dev/null | tail -1)
if [ -n "$red" ]; then
	next_csum=$(jq -r '.deployments[0].checksum // empty' <<<"$status_json")
	if [ -z "$red_csum" ]; then
		refuse red_boot_uncleared "a deployment was rejected at $red and nobody has cleared it.
  Understand why, then:  sudo $REPO/bin/clear-red-boot.sh"
	elif [ "$red_csum" = "$next_csum" ]; then
		refuse red_boot_same_deployment "this is the SAME deployment greenboot rejected at $red (${red_csum:0:12}).
  Rebooting would repeat it. Understand why, then:  sudo $REPO/bin/clear-red-boot.sh"
	else
		note "a deployment was rejected at $red (${red_csum:0:12}), but ${next_csum:0:12} is a different one - proceeding"
	fi
fi

# ------------------------------------------------------------------------------
# Is the host healthy RIGHT NOW?
# ------------------------------------------------------------------------------
# The same argument bin/reboot-host.sh makes: rebooting an unhealthy host turns
# one problem into two and leaves nobody able to say which caused which. Only the
# host-level battery, for the same reason greenboot uses it - a slow Tdarr start
# is not a reason to postpone an OS update for ever.
"$REPO/bin/verify-host.sh" --greenboot >/dev/null 2>&1 \
	|| refuse battery_unhealthy "verify-host.sh --greenboot fails now - fix that before applying a new deployment"

# THE SLOT IS ONLY NEEDED IF A KERNEL HAS TO BE WRITTEN, and only a STAGED
# deployment writes one - ostree-finalize-staged does it at shutdown. A PENDING
# deployment already has its entry, so this reboot writes nothing.
#
# GATING BOTH ON FREE SPACE DEADLOCKS, and unattended that means for ever. A
# pending deployment is holding the second /boot slot, which is what puts /boot
# below the threshold; booting it is what turns it into a rollback that
# `rpm-ostree cleanup -r` can then free. So the refusal was blocking the only
# thing that resolves its own condition - the same shape as host.failed_units
# counting greenboot-healthcheck.service, and as greenboot.verdict before it.
# Verified against the live host on 2026-08-18, where this refused at 26M free
# with a pending deployment and would have gone on refusing every Sunday.
#
# AND THIS REFUSAL SHOULD NOW BE UNREACHABLE, which is what makes it useful.
# home-server-boot-reclaim.timer drops the rollback's slot five minutes after
# every green boot, so /boot sits at ~190M with a staged deployment waiting.
# Reaching this line means the reclaim is not running or could not act, and
# deploy.boot_reclaim_run and deploy.boot_reclaim say which. Before it existed
# this was the whole deadlock: every unattended reboot left two slots spent and
# every Sunday after it refused here, correctly, for ever.
boot_free=$(df -Pm /boot 2>/dev/null | awk 'NR==2 {print $4}')
# GUARDED, because the comparison below is a bare -lt on this value. An
# unreadable df left it empty, `[` errored on the missing operand, and a gate
# that decides whether this host reboots unattended fell through as if there
# were room. bin/verify-host.sh carries the same guard on the same number and
# says the same thing; this copy did not have it.
case "${boot_free:-}" in
	''|*[!0-9]*) refuse boot_space_unknown "/boot free space could not be read ('${boot_free:-}') - and unknown is not room" ;;
esac
next_staged=$(jq -r '.deployments[0] | select(.booted | not) | select(.staged) | .version // empty' <<<"$status_json")
if [ "$boot_free" -lt "$BOOT_MIN_MB" ] && [ -n "$next_staged" ]; then
	refuse boot_space "/boot has only ${boot_free}M free (want ${BOOT_MIN_MB}M) and $next_staged is STAGED - finalizing it needs a slot.
  home-server-boot-reclaim.timer exists to stop this happening; check it:
    systemctl --user status home-server-boot-reclaim.service
    $REPO/bin/reclaim-boot-slot.sh --dry-run"
fi

pinned=$(jq '[.deployments[] | select(.pinned)] | length' <<<"$status_json")
[ "$pinned" -eq 0 ] || refuse pinned "$pinned deployment(s) pinned - unpin and 'rpm-ostree cleanup -r' first"

# THE BACKUP GATE BELONGS HERE, NOT IN THE UNIT. home-server-reboot.service
# carries After=home-server-backup.service and that does NOT do what it looks
# like: systemd ordering applies to units in the same job transaction, and a
# backup already running at 05:08 was started by its own timer hours earlier, so
# it is not in this transaction and nothing waits for it. Rebooting through
# restic leaves a partial snapshot and a lock in the off-site repository.
#
# The schedule makes this unlikely rather than impossible - 03:00 plus a 45
# minute timeout against a window that opens at 05:00 - which is exactly the
# kind of margin that quietly disappears when someone widens a timeout.
# AND `is-active` IS THE WRONG QUESTION FOR A ONESHOT. home-server-backup is
# Type=oneshot with RemainAfterExit=no, so for the entire time restic is running
# its ActiveState is `activating` - never `active`. Written the obvious way,
# `[ "$(systemctl --user is-active ...)" = active ]`, this gate could not fire at
# any point in the unit's life. It read correctly, it deployed cleanly, and it
# was dead. Found only by starting a real backup and watching it pass.
#
# So the safe states are allowlisted rather than the busy ones denylisted: a
# state this does not recognise is treated as busy, which is the direction that
# fails safe. RemainAfterExit=no is what makes `inactive` mean finished rather
# than never-started, and is worth re-checking if that unit is ever changed.
backup_state=$(systemctl --user show home-server-backup.service -p ActiveState --value 2>/dev/null)
case "$backup_state" in
	inactive|failed|"") ;;
	*) refuse backup_running "the backup is $backup_state - rebooting through restic leaves a partial snapshot and a lock in the off-site repository" ;;
esac

# AND THE RECLAIM, RECIPROCALLY. bin/reclaim-boot-slot.sh refuses while this
# unit is anything but idle; without the other half, a reclaim that started at
# 04:59 could still be inside `rpm-ostree cleanup -r` when the window fires at
# 05:00, and rebooting through that is exactly the transaction nobody wants
# interrupted. The same allowlist, for the same reason: a state this does not
# recognise reads as busy.
reclaim_state=$(systemctl --user show home-server-boot-reclaim.service -p ActiveState --value 2>/dev/null)
case "$reclaim_state" in
	inactive|failed|"") ;;
	*) refuse reclaim_running "the /boot slot reclaim is $reclaim_state - it may be inside 'rpm-ostree cleanup -r'" ;;
esac

# A PHASE IS MID-FLIGHT, AND ONLY A MARKER CAN SAY SO. conduct is a long-running
# unit, so its ActiveState reads `active` from boot to shutdown whether it is
# driving a phase or sitting idle - the exact mirror of the backup gate above,
# where a oneshot is `activating` for its entire working life and never `active`.
# Both are the obvious question, both read correctly, and both are dead. So this
# reads a marker the process writes about itself.
#
# BUSY ONLY WHEN THE MARKER SAYS BUSY *AND* ITS HEARTBEAT IS FRESH. A conduct
# killed mid-phase leaves phase_in_flight=1 behind for ever, and a stale flag
# that vetoes reboots indefinitely is the "host silently stops taking OS security
# updates" failure arriving from a fourth direction. Fresh is 600s, which is the
# same window agents.conduct_fresh grades.
conduct_state="${HOME_SERVER_CONDUCT_STATE:-${HOME:-/var/home/core}/.cache/home-server/conduct-state}"
phase_flag=$(sed -n 's/^phase_in_flight=//p' "$conduct_state" 2>/dev/null | tail -1)
phase_hb=$(sed -n 's/^heartbeat_at=//p' "$conduct_state" 2>/dev/null | tail -1)
phase_hb_age=""
if [ -n "$phase_hb" ]; then
	hb_epoch=$(date -d "$phase_hb" +%s 2>/dev/null)
	[ -z "${hb_epoch:-}" ] || phase_hb_age=$(( $(date +%s) - hb_epoch ))
fi
if [ "${phase_flag:-0}" = 1 ] && [ -n "$phase_hb_age" ] && [ "$phase_hb_age" -le 600 ]; then
	# THE ESCALATION IS EASIER THAN THE ENCODER'S BELOW, and naming the trade is
	# what makes it defensible rather than arbitrary. A killed phase costs one
	# re-run of minutes against a worktree that is still on disk; a killed
	# transcode costs an hour of GPU time. So this gives way after the second
	# refusal of a morning where the encoder holds out for a fortnight.
	#
	# IT ALSO MAKES A REQUIREMENT NON-NEGOTIABLE RATHER THAN ASPIRATIONAL:
	# conduct must survive being killed mid-phase, with durable state and a
	# boot-time pass that reclaims leases and reaps orphaned worktrees,
	# containers and networks. A design note saying so would be a wish. This
	# guarantees it gets exercised, on a schedule, without anybody deciding to.
	#
	# Date-keyed so it resets between windows. The counter cannot be starved the
	# way the encoder's staged_age_d can, because the day advances regardless of
	# what conduct is doing.
	today=$(date -u +%Y-%m-%d)
	prev_day=$(sed -n 's/^phase_refused_on=//p' "$STATE" 2>/dev/null | tail -1)
	prev_n=$(sed -n 's/^phase_refusals=//p' "$STATE" 2>/dev/null | tail -1)
	case "$prev_n" in ''|*[!0-9]*) prev_n=0 ;; esac
	[ "$prev_day" = "$today" ] || prev_n=0
	if [ "$prev_n" -ge 2 ]; then
		note "a phase has been in flight at $prev_n earlier attempts this morning - applying anyway. The phase dies with the reboot; conduct's reconciler reclaims its lease and its worktree on the way back up, which is the property this escalation exists to keep honest."
	else
		# RECORDED BEFORE REFUSING, because refuse() exits immediately - and not
		# at all under --dry-run, which must change nothing. The block rewrites
		# the file whole and keeps every key it does not own, the same shape the
		# unattended_reboot_at write at the end of this script uses.
		if [ -z "$DRY" ]; then
			{
				grep -vE '^phase_refus(als|ed_on)=' "$STATE" 2>/dev/null
				echo "phase_refused_on=$today"
				echo "phase_refusals=$((prev_n + 1))"
			} | priv tee "$STATE.tmp" >/dev/null
			priv mv "$STATE.tmp" "$STATE"
		fi
		refuse phase_in_flight "conduct has a phase in flight (heartbeat ${phase_hb_age}s ago) - a reboot would kill it mid-run.
  Refusal $((prev_n + 1)) of 2 this morning; the next attempt applies anyway."
	fi
fi

# ------------------------------------------------------------------------------
# Is a CI job mid-flight?
# ------------------------------------------------------------------------------
# THE SAME SHAPE AS THE PHASE GATE ABOVE, AND FOR THE SAME TWO REASONS. A lane's
# marker is the only thing on this host that knows a job is running - the
# container carries io.home-server.ephemeral, so the collector skips it, no unit
# goes inactive and nothing reads unhealthy. And a driver killed mid-job leaves
# job_in_flight=1 behind for ever, so the flag is believed only while the
# heartbeat is fresh; a stale flag that vetoes reboots indefinitely is "the host
# silently stops taking OS security updates" arriving from a third direction.
#
# 300 SECONDS RATHER THAN THE PHASE GATE'S 600, because the driver polls every
# thirty. Ten missed rounds is a wedged driver; the same window ci.heartbeat
# grades.
#
# THE ESCALATION IS THE COUNT IDIOM, NOT THE ENCODER'S AGE IDIOM, and naming the
# trade is what makes it defensible rather than arbitrary. A killed CI job costs
# one `gh run rerun` against a branch GitHub still holds - minutes of compute,
# nothing lost but somebody pressing a button. A killed transcode costs an hour
# of GPU time against a source that is hardlinked and untouched. So this gives
# way after the second refusal of a morning, exactly as the phase gate does,
# where the encoder holds out for a fortnight.
#
# IT IS SLIGHTLY WORSE THAN A KILLED PHASE AND THE COMMENT SHOULD SAY SO RATHER
# THAN ROUND IT OFF: GitHub does NOT re-queue a job whose ephemeral runner
# disappeared. conduct's reconciler reclaims a phase on the way back up with
# nobody involved; a CI job needs a person. Still minutes, still far cheaper than
# another week on an unapplied image, but it is not free.
#
# AND IT MAKES A REQUIREMENT NON-NEGOTIABLE RATHER THAN ASPIRATIONAL, the way the
# phase gate does for conduct: bin/github-runner.sh must survive being killed
# mid-job, deregister its runner on the way back up and reap its own container
# and .jitconfig. A design note saying so would be a wish. This guarantees it
# gets exercised, on a schedule, without anybody deciding to.
ci_busy_lane=""
ci_busy_age=""
for ci_lane in 1 2 3; do
	ci_state="${HOME_SERVER_CI_STATE_DIR:-${HOME:-/var/home/core}/.cache/home-server}/ci-state-$ci_lane"
	[ -f "$ci_state" ] || continue
	[ "$(sed -n 's/^job_in_flight=//p' "$ci_state" 2>/dev/null | tail -1)" = 1 ] || continue

	ci_hb=$(sed -n 's/^heartbeat_at=//p' "$ci_state" 2>/dev/null | tail -1)
	[ -n "$ci_hb" ] || continue
	ci_hb_epoch=$(date -d "$ci_hb" +%s 2>/dev/null) || continue
	[ -n "${ci_hb_epoch:-}" ] || continue
	ci_hb_age=$(( $(date +%s) - ci_hb_epoch ))
	[ "$ci_hb_age" -le 300 ] || continue

	ci_busy_lane="$ci_lane"
	ci_busy_age="$ci_hb_age"
	break
done

if [ -n "$ci_busy_lane" ]; then
	ci_today=$(date -u +%Y-%m-%d)
	ci_prev_day=$(sed -n 's/^ci_refused_on=//p' "$STATE" 2>/dev/null | tail -1)
	ci_prev_n=$(sed -n 's/^ci_refusals=//p' "$STATE" 2>/dev/null | tail -1)
	case "$ci_prev_n" in ''|*[!0-9]*) ci_prev_n=0 ;; esac
	[ "$ci_prev_day" = "$ci_today" ] || ci_prev_n=0

	if [ "$ci_prev_n" -ge 2 ]; then
		note "a CI job has been in flight at $ci_prev_n earlier attempts this morning - applying anyway. The job dies with the reboot and GitHub records it as cancelled rather than re-queueing it, so somebody re-runs it with 'gh run rerun --failed'. bin/github-runner.sh reclaims its own container and registration on the way back up, which is the property this escalation exists to keep honest."
	else
		# RECORDED BEFORE REFUSING, because refuse() exits immediately - and not
		# at all under --dry-run, which must change nothing. The block rewrites
		# the file whole and keeps every key it does not own, the same shape the
		# phase gate above and the unattended_reboot_at write at the end of this
		# script both use.
		if [ -z "$DRY" ]; then
			{
				grep -vE '^ci_refus(als|ed_on)=' "$STATE" 2>/dev/null
				echo "ci_refused_on=$ci_today"
				echo "ci_refusals=$((ci_prev_n + 1))"
			} | priv tee "$STATE.tmp" >/dev/null
			priv mv "$STATE.tmp" "$STATE"
		fi
		refuse ci_in_flight "CI lane $ci_busy_lane has a job in flight (heartbeat ${ci_busy_age}s ago) - a reboot would kill it, and GitHub does not re-queue a job whose runner disappeared.
  Refusal $((ci_prev_n + 1)) of 2 this morning; the next attempt applies anyway."
	fi
fi

# ------------------------------------------------------------------------------
# Is anything mid-flight that a reboot would destroy?
# ------------------------------------------------------------------------------
# SOMEBODY IS WATCHING, AND THE ENCODER GATE BELOW CANNOT SEE THEM. That is not
# a shortcoming of nvidia-smi: a DirectPlay session hands the file to the client
# untouched and opens no encode session at all, so the only measurement this
# section used to have reads 0% while a film is playing. Measured on this host -
# a live DirectPlay session with utilization.encoder at 0. For as long as this
# section was one gate, the Sunday window could cut a stream with every check
# passing and nothing anywhere saying otherwise.
#
# UNKNOWN REFUSES HERE, and the same script proceeds on unknown in
# bin/update-when-idle.sh. The asymmetry is the one this whole file is built on
# and bin/reboot-host.sh restates: a container update costs an interrupted
# stream, a reboot costs a car journey, so they are allowed to price the same
# missing answer differently. Note that bin/jellyfin-watching.sh reports a
# STOPPED Jellyfin as 0 rather than unknown, so this cannot refuse merely
# because the media server is down.
watching=$("$REPO/bin/jellyfin-watching.sh") ||
	refuse playback_unknown "jellyfin is running and could not be asked whether anyone is watching - unknown is not idle"
if [ "${watching:-0}" -gt 0 ]; then
	# THE COUNT IDIOM, NOT THE ENCODER'S AGE IDIOM, and for the reason the phase
	# gate above gives: this costs what a killed phase costs, not what a killed
	# transcode costs. A viewer loses about fifteen seconds and resumes, because
	# Jellyfin saves the position - so it gives way after the second refusal of a
	# morning where the encoder holds out for a fortnight.
	#
	# Date-keyed so it resets between windows, and it cannot be starved: the day
	# advances regardless of what anyone is watching.
	today=$(date -u +%Y-%m-%d)
	prev_day=$(sed -n 's/^playback_refused_on=//p' "$STATE" 2>/dev/null | tail -1)
	prev_n=$(sed -n 's/^playback_refusals=//p' "$STATE" 2>/dev/null | tail -1)
	case "$prev_n" in ''|*[!0-9]*) prev_n=0 ;; esac
	[ "$prev_day" = "$today" ] || prev_n=0
	if [ "$prev_n" -ge 2 ]; then
		note "$watching session(s) playing, refused at $prev_n earlier attempts this morning - applying anyway. The stream drops; Jellyfin has the position saved and the client resumes on the way back up."
	else
		# Recorded BEFORE refusing, because refuse() exits immediately - and not
		# at all under --dry-run. Same shape as the phase counter above.
		if [ -z "$DRY" ]; then
			{
				grep -vE '^playback_refus(als|ed_on)=' "$STATE" 2>/dev/null
				echo "playback_refused_on=$today"
				echo "playback_refusals=$((prev_n + 1))"
			} | priv tee "$STATE.tmp" >/dev/null
			priv mv "$STATE.tmp" "$STATE"
		fi
		refuse playback_active "$watching Jellyfin session(s) are playing - a reboot would cut the stream.
  Refusal $((prev_n + 1)) of 2 this morning; the next attempt applies anyway."
	fi
fi

# A killed transcode is not fatal - the source is hardlinked in downloads/ and
# untouched, and Tdarr re-queues the job - but it wastes an hour of GPU time and
# leaves a partial file in the cache, and this reboot can simply happen an hour
# later instead. Attended, this is a warning; unattended, it is a refusal.
#
# UNKNOWN IS NOT IDLE. Summing an empty answer through awk yields 0, so a driver
# that has stopped answering used to pass this gate looking exactly like an idle
# card - a check that cannot fail, on the one question it exists to ask.
# verify-host.sh --greenboot has already asserted the driver and the CDI spec by
# the time we get here, so an empty answer is anomalous rather than routine.
#
# The override is the same argument again, and it is not hypothetical: this
# branch was unprovable the first time it was tried, because the transcode that
# had been running while the code was written finished before the test ran. A
# gate that can only be exercised when something else happens to be busy is a
# gate nobody exercises.
enc_raw="${HOME_SERVER_ENCODER_PCT:-}"
if [ -z "$enc_raw" ]; then
	enc_raw=$(nvidia-smi --query-gpu=utilization.encoder --format=csv,noheader,nounits 2>/dev/null)
	[ -n "$enc_raw" ] || refuse encoder_unknown "nvidia-smi answered nothing - cannot tell whether a transcode is running, and unknown is not idle"
fi
enc=$(awk '{s+=$1} END {print s+0}' <<<"$enc_raw")

# THE ESCALATION, AND WHY IT IS NOT A CONTRADICTION. Each individual refusal
# above is correct and the aggregate can still be wrong: the window is five
# attempts on one morning, and a Tdarr queue that spans them costs the
# deployment a whole week. Repeat that and a correct-every-time gate leaves the
# host on a superseded image indefinitely.
#
# So the trade is named rather than implied. A killed transcode is a COST - one
# hour of GPU time against a source that still exists - while running an
# unapplied security update for a month is a RISK. Past the thresholds the cost
# is the cheaper of the two and the encoder stops being a veto.
#
# THREE clauses, because they fail differently - and the third was added on
# 2026-09-09 when the first turned out to be inert rather than slow:
#
#   staged_age_d  how long THIS deployment has waited. Kept, because it is still
#                 the right thing to say to a person reading the journal - but
#                 it is NOT load-bearing any more. rpm-ostreed re-stages
#                 nightly, measurably for an unchanged digest, so it is pinned
#                 near zero and this clause has never once fired.
#   image_lag_d   how long the host has been BEHIND, from the booted commit's
#                 own base-timestamp. Nothing local resets it, so it is what
#                 the first clause was always meant to be.
#   uptime_d      the backstop for both. Nothing resets it except the reboot
#                 this script exists to perform, so it cannot be starved.
#
# The threshold is shared between the first two on purpose: 14 days is the point
# this file already judged a killed transcode cheaper than more delay, and that
# judgement was never about which clock measured it.
ESCALATE_STAGED_D=14
ESCALATE_UPTIME_D=30
if [ "$enc" -ne 0 ]; then
	if [ "$staged_age_d" -ge "$ESCALATE_STAGED_D" ] \
		|| [ "$image_lag_d" -ge "$ESCALATE_STAGED_D" ] \
		|| [ "$uptime_d" -ge "$ESCALATE_UPTIME_D" ]; then
		note "the encoder is busy (${enc}%) but this deployment has waited ${staged_age_d}d, the booted image is ${image_lag_d}d old and the host has been up ${uptime_d}d - applying anyway. A transcode will be killed; Tdarr re-queues it and the source is hardlinked."
	else
		refuse encoder_busy "the encoder is busy (${enc}%) - a transcode would be killed (waited ${staged_age_d}d of ${ESCALATE_STAGED_D}, image ${image_lag_d}d of ${ESCALATE_STAGED_D}, up ${uptime_d}d of ${ESCALATE_UPTIME_D}; past any of the three it applies anyway)"
	fi
fi

# ------------------------------------------------------------------------------
# Go
# ------------------------------------------------------------------------------
if [ -n "$DRY" ]; then
	note "every gate passed - a real run would reboot into $staged now"
	exit 0
fi

# Record the attempt BEFORE rebooting, because afterwards there is no process
# left to write anything. Without this, "the timer applied an update at 05:00"
# and "the timer has not fired since March" look identical from the far side.
now=$(date -u +%Y-%m-%dT%H:%M:%SZ)
priv mkdir -p "$(dirname "$STATE")"
{
	grep -v '^unattended_reboot_at=' "$STATE" 2>/dev/null
	echo "unattended_reboot_at=$now"
} | priv tee "$STATE.tmp" >/dev/null
priv mv "$STATE.tmp" "$STATE"

note "rebooting into $staged"
priv systemctl reboot
