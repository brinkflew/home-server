// =============================================================================
// Which controls a round offers, and which it withholds
// -----------------------------------------------------------------------------
// A MODULE RATHER THAN THE PAGE, for the reason src/fleet.ts already gives: a
// decision written inline in a .vue file cannot be exercised by
// fixtures/smoke.mjs, which is the only logic test this application has. What is
// decided here is entirely about what to OFFER - conduct decides what to do, and
// refuses again on the host, where the guard counts.
//
// A CHIP THAT LANDS SOMEWHERE IT CANNOT ACT IS WORSE THAN ONE THAT SAYS LESS.
// That is this application's own rule, written when the design's `Terminate`
// became `open`, and it is why every disabled state below carries a reason
// rather than simply greying out. A button conduct will refuse is a button that
// should not have been offered.
// =============================================================================

import { isoToUnix } from "./format";
import { roundOutcome, roundState } from "./fleet";
import type { FleetControl, FleetRound, Tone } from "./types";
import type { ControlAction } from "./api/control";

/** A control as the board renders it: what it does, and why it may not. */
export interface ControlOffer {
  label: string;
  action: ControlAction;
  /** The worktree it applies to, or null for the intake switch. */
  target: string | null;
  /** Null when it can be pressed. A sentence when it cannot. */
  disabled: string | null;
  /**
   * Whether a compact drawing carries this one.
   *
   * A DECLARED PROPERTY RATHER THAN TWO LISTS. The board's row and the round's
   * own page both draw these, and the last time this application derived one
   * control two ways the two drawings disagreed. So there is still exactly one
   * list and one branch pairing each label with its action; what a narrow
   * drawing does is drop the ones marked non-primary.
   *
   * ONLY `cancel+requeue` IS NON-PRIMARY, and it is the rarer half of a pair
   * whose other half is right beside it: everything it does, `cancel` does too,
   * except the one tracker write. Somebody deciding to put work back in the
   * ready pile has gone to read the round first, and that page carries it.
   */
  primary: boolean;
}

/**
 * conduct's own CONDUCT_TIMEOUT. A held step is not answered, and Windmill
 * gives every conduct step a day before it fails the flow - so a hold is
 * bounded by something the person setting it does not control, and the board
 * has to say so rather than let them find out.
 */
export const HOLD_TIMEOUT_S = 24 * 3600;

/** Seconds until a held round's suspended step times out, or null. */
export function holdExpiresIn(round: FleetRound, nowUnix: number): number | null {
  if (!round.held || !round.held_at) return null;
  const set = Date.parse(round.held_at);
  if (!Number.isFinite(set)) return null;
  return HOLD_TIMEOUT_S - (nowUnix - set / 1000);
}

/**
 * Is the intake switch on, and did a row say so or is it the shipped default?
 *
 * THE COLLECTOR CANNOT READ conduct's DESCRIPTOR - it is a Python literal in
 * another repository - so "default" deliberately does not claim to know WHICH
 * default. `conduct status` prints both side by side; this says only whether
 * somebody has overridden it.
 */
export function intakeState(
  control: FleetControl,
  project: string,
): { on: boolean | null; source: "set" | "default"; at: string | null; note: string | null } {
  const entry = control.intake.find((e) => e.subject === project);
  if (!entry) return { on: null, source: "default", at: null, note: null };
  if (entry.value !== "on" && entry.value !== "off") {
    // conduct defers to the descriptor on a value it does not define, so this
    // must read as "nobody has said" rather than as a state.
    return { on: null, source: "default", at: entry.at, note: entry.note };
  }
  return { on: entry.value === "on", source: "set", at: entry.at, note: entry.note };
}

/**
 * The intake switch as a control: what it reads, and the one command that moves
 * it.
 *
 * THE LABEL AND THE ACTION COME OFF ONE BRANCH, which is the entire reason this
 * exists rather than staying two ternaries in the template. The board draws this
 * switch TWICE now - in the fleet header, where it is the first thing the page
 * says, and in the Intake panel, which is the record of who set it and why. The
 * last time this application drew one fact in two places the two drawings
 * disagreed about a tone no fixture carried, and nothing could see it. A chip
 * reading `arm` that sends `intake_off` is that same defect with a far worse
 * consequence: a button that does the opposite of what it says.
 *
 * WHAT IT DELIBERATELY DOES NOT CARRY is the sentence printed under each
 * drawing. The header answers "is the fleet armed"; the panel answers "who said
 * so, and why". Those are different sentences on purpose, so they are composed
 * at each site rather than shared and forced to become one.
 */
export interface IntakeSwitch {
  /** True armed, false disarmed, null when nobody has overridden the descriptor. */
  on: boolean | null;
  /** The word the board prints for that state. */
  state: string;
  /** `null` takes the off tone, exactly as the panel has always coloured it:
   *  nobody has said, so the board must not claim the fleet is running. */
  tone: Tone;
  /** The chip: what pressing it will do, never what is true now. */
  label: string;
  action: ControlAction;
  title: string;
  source: "set" | "default";
  at: string | null;
  note: string | null;
}

/** The switch for one project, from the same row `intakeState` reads. */
export function intakeSwitch(control: FleetControl, project: string): IntakeSwitch {
  const now = intakeState(control, project);
  return {
    ...now,
    state: now.on === null ? "as shipped" : now.on ? "armed" : "disarmed",
    tone: now.on ? "ok" : "off",
    label: now.on ? "disarm" : "arm",
    action: now.on ? "intake_off" : "intake_on",
    title: now.on
      ? "stop the fleet choosing its own work - a round already open still runs to its gate"
      : "let the fleet choose its own work",
  };
}

/**
 * The quota hold, as a control: whether the warning still stops the fleet, and
 * the one command that changes it.
 *
 * IT IS A THRESHOLD AND NOT A SWITCH, which is the whole reason it cannot borrow
 * `intakeSwitch`. conduct holds at `allowed_warning` by default; lifting it
 * moves the level to `rejected` and no further, so a refusal is still a hold
 * whatever anybody asked for. There is no "off".
 *
 * THE VALUE IS A DEADLINE AND A PAST ONE MEANS NOTHING IS IN FORCE. `quota_pace`
 * writes the moment it happened rather than deleting the row - for the reason
 * `release` is set rather than deleted, so the board can still say when the
 * pacing came back - so "is an override live" is a comparison and never a
 * presence test.
 */
export interface QuotaHold {
  /** True while the warning hold is lifted. */
  spending: boolean;
  /** When it ends, or null when nothing is in force. */
  until: string | null;
  /** The chip: what pressing it will do, never what is true now. */
  label: string;
  action: ControlAction;
  title: string;
  /** When the row was last written, and why - null when there has never been one. */
  at: string | null;
  note: string | null;
}

export function quotaHold(control: FleetControl, nowUnix: number): QuotaHold {
  const entry = control.quota ?? null;
  const until = entry ? isoToUnix(entry.value) : Number.NaN;
  // NaN FAILS THIS AND THAT IS THE SAFE DIRECTION. A value the browser cannot
  // parse must read as "the default is in force", exactly as conduct's own
  // override_until answers None to one - a page claiming the fleet is spending
  // when it is holding sends somebody to lift a hold that is already lifted.
  const spending = Number.isFinite(until) && until > nowUnix;
  return {
    spending,
    until: spending && entry ? entry.value : null,
    label: spending ? "pace" : "spend",
    action: spending ? "quota_pace" : "quota_spend",
    title: spending
      ? "hold the fleet at the API's warning again, so what is left is left for your own sessions"
      : "let the fleet run until the API refuses, for the life of this window only",
    at: entry ? entry.at : null,
    note: entry ? entry.note : null,
  };
}

/**
 * An ask a person made that the fleet has not yet been observed carrying out.
 *
 * WHY THIS EXISTS AT ALL: `ChipButton`'s `asked` is component state, so a
 * reload drops it and the board goes back to offering the command as though it
 * had never been sent. On 2026-08-28 that was the second half of the
 * complaint - the first being that conduct could not answer for 33 minutes.
 * conduct is fixed; this is the half where the page forgets.
 *
 * IT IS CLEARED BY DERIVATION AND NEVER BY A TIMER ALONE. `action` is what the
 * chip would send NOW: while the remembered ask still matches it, the command
 * has not taken effect and the ask stands. The moment the fleet moves, the
 * chip's action flips to its opposite, they stop matching, and the memory is
 * dropped. So this cannot go on claiming an outstanding ask after the thing has
 * happened - which is the failure mode that would make it worse than nothing.
 *
 * THE CEILING IS A BACKSTOP, NOT THE MECHANISM. A flow that hit CONDUCT_TIMEOUT
 * without being answered will never move the state, so without one the chip
 * would say `asked` for ever.
 */
export const ASK_CEILING_S = HOLD_TIMEOUT_S;

export interface RememberedAsk {
  action: ControlAction;
  /** Unix seconds, from the browser's clock - this is one person's own ask. */
  at: number;
}

/** Seconds the ask has been outstanding, or null if it no longer stands. */
export function askAge(
  remembered: RememberedAsk | null,
  offers: ControlAction,
  nowUnix: number,
): number | null {
  if (!remembered) return null;
  // THE FLEET MOVED. The chip now offers the opposite command, so what was
  // asked for has been done and the memory has served its purpose.
  if (remembered.action !== offers) return null;
  const age = nowUnix - remembered.at;
  if (!Number.isFinite(age) || age < 0 || age > ASK_CEILING_S) return null;
  return age;
}

/**
 * Seconds since a round on this lane was last started BY HAND, or null.
 *
 * conduct's OWN CLOCK, WHICH IS NOT THE ROUND'S. This read `round.started_at`
 * until 2026-09-07 and conduct debounces on the `restart:<worktree>` control
 * row, so a round started three hours ago and restarted sixty seconds ago
 * offered an enabled chip that conduct then refused. The stamp did not reach
 * `fleet.json` at all - the collector dropped it under a comment saying nothing
 * on the board drew it - which is why the board was computing a different
 * question rather than the wrong answer to this one.
 *
 * ABSENT IS null AND NOT ZERO. An older collector sends no `stamps` at all, and
 * "no stamp" must read as "nothing to debounce against" rather than as "started
 * just now": conduct refuses again on the host, so the safe direction here is to
 * offer the button.
 */
export function lastStartedAgo(
  round: FleetRound,
  control: FleetControl,
  nowUnix: number,
): number | null {
  const entry = (control.stamps ?? []).find((e) => e.subject === round.worktree_id);
  if (!entry) return null;
  const at = isoToUnix(entry.at);
  if (!Number.isFinite(at)) return null;
  const since = nowUnix - at;
  return Number.isFinite(since) && since >= 0 ? since : null;
}

/**
 * The controls this round offers.
 *
 * IT USED TO OFFER NOTHING ON A ROUND THAT WAS OVER, and that was the gap this
 * whole change exists to close. The argument was sound as far as it went -
 * holding a finished round stops nothing, and restarting one had no chain for
 * conduct to close - but the consequence was that a stopped round had no way
 * back at all: it was recovered by moving its task in Odoo by hand and running
 * `conduct ship` over ssh, which five tasks needed after one bad day.
 *
 * WHAT REPLACES IT IS NARROWER RATHER THAN ABSENT. conduct now accepts a closed
 * round for `restart`, `resume` and the two cancels, and refuses on the task id,
 * on a round already open, on an empty `done` and on its own floor. Every one of
 * those refusals is mirrored here as a SENTENCE on a disabled chip, because a
 * chip that lands somewhere it cannot act is worse than one that says less.
 *
 * THIS AND `roundOutcome` MUST NOT DRIFT. The board hides a finished round, and
 * "finished" is defined as the round this function offers nothing on. If a new
 * offer appears here for a class `roundOutcome` calls finished, the button
 * exists on a row nobody can see.
 *
 * AND ONE OFFER IS NOT AIMED AT A WORKTREE AT ALL. Every chip below reaches
 * conduct's `chain`, which holds one row per lane and moves to whichever change
 * ran last - so all of them are bounded by `notCurrent` and can only act on the
 * newest round of a lane. `settle` reaches the `publication` row instead, keyed
 * per flow job and never reused, which is why it is the only thing a round the
 * lane has left behind can still be offered.
 */
export function roundControls(
  round: FleetRound,
  control: FleetControl,
  nowUnix: number,
): ControlOffer[] {
  // NOTHING IS OFFERED ON A ROUND THAT OPENED A PULL REQUEST. `unmerged` is on
  // the board - that pull request is the thing a person acts on, and hiding it
  // would hide the round's only output - but it is not a round the fleet can
  // take up again. A restart would force-push over a branch an open pull
  // request is pointing at, which is the hazard `publish.branch_name`'s stable
  // task-shaped name already carries: a pull request changing under an
  // approval. What to do about one of these is on GitHub, and the row links
  // straight there.
  //
  // THAT ARGUMENT USED TO COVER `not published` TOO AND NEVER APPLIED TO IT.
  // The class was one word answering two questions - "keep this row" and
  // "nothing can be done" - and a round that opened NO pull request has no
  // branch under review to force-push over. It is `recoverable` now; see
  // roundOutcome, where the split is made.
  const klass = roundOutcome(round);
  if (klass === "finished" || klass === "unmerged") return [];

  const unavailable = control.available
    ? null
    : "the control route has no token - see WINDMILL_DASHBOARD_TOKEN";

  // WITHOUT A TASK ID THERE IS NO ROUND, ONLY A LANE. conduct refuses the four
  // destructive or expensive actions rather than guessing, so the board says
  // why instead of offering a button that answers with a paragraph. `hold` and
  // `release` are exempt: they stop dispatch for the lane and mean exactly that.
  const unidentified =
    round.odoo_task === null
      ? "this round predates conduct's task column, so nothing can tell it from a later round on the same worktree"
      : null;

  // THE LANE HAS MOVED ON, WHICH USED TO BE `roundOutcome`'s JOB AND NOW HAS TO
  // BE THIS ONE'S TOO. Every action aimed at a worktree reaches conduct's
  // `chain`, which holds one row and moves to whichever change ran last - so
  // conduct refuses them with almost exactly this sentence, and a chip that
  // lands somewhere it cannot act teaches a reader to distrust the others.
  //
  // IT WAS FREE UNTIL `settle` EXISTED. `roundOutcome` folded a non-current
  // round into `finished`, so this function never saw one; now a `not published`
  // round stays actionable whatever its lane has done since, because settle
  // names a flow job rather than a worktree. So the test moves here, where it
  // can disable four chips and leave the fifth alone.
  //
  // ABSENCE IS "NOT THE LATEST", NOT "PROBABLY THIS ONE". `undefined !== null`
  // is true - the trap that once rendered `attempt  of 3` - and a document from
  // an older collector cannot say which round on a lane is current. Guessing in
  // front of a button that closes a pull request is what this refuses.
  const notCurrent =
    round.latest_on_worktree === true
      ? null
      : "this lane now holds a later round - conduct keeps one row per worktree, so this would act on that one";

  // THE FLOOR IS conduct's, AND THE BOARD HONOURS IT RATHER THAN DISCOVERING
  // IT. Two starts close together put two flows on one worktree and the next
  // prepare_worktree deletes the first one's commits - so conduct refuses
  // inside the floor, and offering a button that will be refused teaches a
  // reader to distrust the others.
  const since = lastStartedAgo(round, control, nowUnix);
  const tooSoon =
    since !== null && since < control.restart_floor_sec
      ? `a round was started here ${Math.round(since)}s ago; conduct refuses another inside ${control.restart_floor_sec}s`
      : null;

  // A ROUND WAITING FOR AN ANSWER IS NOT STUCK, IT IS WAITING FOR YOU. Starting
  // it again would cancel the flow that is holding the question - conduct would
  // accept it, which is exactly why the board must not offer it as though it
  // were the obvious move. The answer is approve or decline on the round's own
  // page, or cancel, which is a decline that also cleans up. Offered DISABLED
  // rather than dropped: a control that vanishes teaches nothing, and somebody
  // really may want to restart a round whose card they do not like.
  const owed =
    round.waiting_on === "person"
      ? "this round is waiting for your answer - approve or decline it first, or cancel it"
      : null;

  const open = round.closed_at === null;
  const offers: ControlOffer[] = [];

  // ONE READING OF THE STATE, SHARED. Whether `settle` is offered turns on it,
  // and so does which three chips a compact row carries - and deriving the same
  // answer twice is how this application last drew one fact two ways and
  // disagreed with itself about a tone no fixture carried.
  //
  // ASKED OF `roundState` RATHER THAN RE-DERIVED FROM `published` AND `pr_url`.
  // Those two conditions ARE that state, and restating them here would be the
  // drift this module's header warns about: a subset of roundState's conditions,
  // in a second place, with nothing able to see them disagree.
  const unpublished = roundState(round).state === "not published";

  // SETTLE COMES FIRST BECAUSE IT IS THE ONE THAT COSTS NOTHING, and the order
  // chips are read in is the order they are tried in - the same argument that
  // puts `resume` ahead of `restart` below. It starts no phase, cancels no flow
  // and touches no worktree; it records that a round which ended without a pull
  // request needs nothing more.
  //
  // AND ON `not published` ALONE, because that state is precisely "a publication
  // row closed carrying no pull request" - which is the row conduct writes on. A
  // `stopped` round has no publication at all and a null `flow_job_id`, so a
  // chip there would answer "conduct has no publication for job ..."; a live
  // round's answer is approve, decline or cancel.
  if (unpublished) {
    offers.push({
      label: "settle",
      action: "settle",
      target: round.worktree_id,
      // NOT `unidentified` AND NOT `notCurrent`. Neither applies: conduct
      // identifies this round by its flow job, which is a publication's primary
      // key and is never reused, so a lane that has moved on and a round with no
      // task id are both still reachable. That is the whole reason this action
      // exists - task 1640's round was declined, its lane then ran three other
      // tasks, and nothing on the board could touch it.
      disabled:
        unavailable ??
        (round.flow_job_id
          ? null
          : "this round records no flow job, so nothing can name it to conduct"),
      primary: true,
    });
  }

  // A HOLD IS THE ONLY OFFER ON A LIVE ROUND THAT IS NOT ABOUT ENDING IT, and
  // it is meaningless once the round is over: conduct does not dispatch a
  // closed round, so holding one stops nothing.
  if (open) {
    offers.push(
      round.held
        ? { label: "release", action: "release", target: round.worktree_id,
            disabled: unavailable, primary: true }
        : { label: "hold", action: "hold", target: round.worktree_id,
            disabled: unavailable, primary: true },
    );
  }

  // RESUME COMES BEFORE RESTART BECAUSE IT IS THE CHEAPER ANSWER, and the order
  // chips are read in is the order they are tried in. It is offered only on a
  // closed round that finished something: a resume with nothing to skip is a
  // restart under a name promising it would be cheap, and conduct refuses it in
  // exactly those words.
  if (!open) {
    const nothingDone =
      (round.done?.length ?? 0) === 0
        ? "this round finished no phase, so there is nothing to skip - restart it instead"
        : null;
    offers.push({
      label: "resume",
      action: "resume",
      target: round.worktree_id,
      disabled: unavailable ?? unidentified ?? notCurrent ?? owed ?? nothingDone ?? tooSoon,
      // THREE PRIMARY CHIPS IS A LAYOUT CONSTRAINT AND NOT A PREFERENCE: at
      // 132px a fourth wraps and every row on the board becomes 130px tall,
      // which is a list nobody can scan. `settle` is a fourth on the one state
      // that offers it, so something has to give way there.
      //
      // AND IT IS THIS ONE, BECAUSE OF WHAT `resume` MEANS ON THIS STATE. A
      // round that reached the publish path finished EVERY phase, so a resume
      // skips all five and re-runs only the gate and the squash - it asks the
      // same question about the same commits again, which is the rare intent
      // after a decline. `restart` is beside it for the common one, and the
      // round's own page carries this in full. On a `stopped` round it is
      // primary exactly as it was: half the phases are unfinished and skipping
      // them is the whole point.
      primary: !unpublished,
    });
  }

  offers.push({
    label: "restart",
    action: "restart",
    target: round.worktree_id,
    // A RESTART OF AN OPEN ROUND CLOSES IT FIRST; of a closed one it simply
    // starts another. Both are refused inside the floor and both need the id.
    disabled: unavailable ?? unidentified ?? notCurrent ?? owed ?? tooSoon,
    primary: true,
  });

  // CANCEL IS OFFERED ON A CLOSED ROUND TOO, AND THAT IS WHERE MOST OF WHAT IT
  // DOES IS OWED. It reads as being about the flow, and on an open round it is;
  // on a stopped one the flow has already ended and what is left is a worktree
  // on disk, a task parked in a stage intake cannot reach, and possibly a pull
  // request. Somebody deciding not to retry a round has exactly that to do, and
  // the alternative was a second verb differing from this one only in which
  // steps it skipped. conduct guards the two steps that need an open round and
  // reports what it actually did.
  //
  // `cancel+requeue` IS A SEPARATE CHIP RATHER THAN A DEFAULT. It carries the
  // one tracker write conduct is otherwise forbidden - Pending is a person's
  // stage - so putting work back in the ready pile is a decision, and a decision
  // taken as a side effect of pressing "cancel" is not one.
  offers.push({
    label: "cancel",
    action: "cancel",
    target: round.worktree_id,
    disabled: unavailable ?? unidentified ?? notCurrent,
    primary: true,
  });
  offers.push({
    label: "cancel+requeue",
    action: "cancel_requeue",
    target: round.worktree_id,
    disabled: unavailable ?? unidentified ?? notCurrent,
    primary: false,
  });
  return offers;
}

/**
 * Is this remembered ask still outstanding, for a command with no opposite?
 *
 * `askAge` CLEARS BY DERIVATION and that works because `hold`/`release` and
 * `quota_spend`/`quota_pace` FLIP: the moment the fleet is seen doing the thing,
 * the chip would send the other one and the memory retires itself. `resume`,
 * `restart` and the two cancels never flip - a restart chip says `restart`
 * before and after - so the same trick has to key on something else.
 *
 * THE OFFER DISAPPEARING IS THE EVIDENCE. conduct carrying out a cancel closes
 * the round, which makes it finished, which makes `roundControls` return an
 * empty list; a resume re-opens the round, which drops `resume` from the offers.
 * So "is my ask still outstanding" is "is that action still on the table", which
 * is the same shape as the flip and needs no timer.
 */
export function offerStands(
  remembered: RememberedAsk | null,
  offers: ControlOffer[],
  nowUnix: number,
): number | null {
  if (!remembered) return null;
  if (!offers.some((o) => o.action === remembered.action)) return null;
  const age = nowUnix - remembered.at;
  if (!Number.isFinite(age) || age < 0 || age > ASK_CEILING_S) return null;
  return age;
}
