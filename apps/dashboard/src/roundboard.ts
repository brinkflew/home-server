// =============================================================================
// One round, as the board draws it
// -----------------------------------------------------------------------------
// THESE WERE PAGE-LOCAL FUNCTIONS AND THERE IS NOW MORE THAN ONE PAGE. The board
// at /agents/rounds and the round at /agents/rounds/<key> both have to say how
// far a round has got, how long it has been going and what it is likely to
// cost - and two copies of "elapsed leads, the estimate is usually absent"
// would be two copies of a rule that has already been got wrong once.
//
// PURE, AND EVERY CLOCK IS AN ARGUMENT. `now` comes from the host store, which
// is the CORRECTED clock rather than Date.now() - a browser whose clock is off
// by an hour must not make a fresh round read as overdue. Passing it in is what
// keeps that decision in one place and keeps this module testable from node.
//
// src/fleet.ts IS STILL WHERE THE STATE MACHINE LIVES. This is presentation
// over it: labels, two clocks and a row object. Nothing here decides what a
// round IS.
// =============================================================================

import * as fmt from "@/format";
import {
  roundAction,
  roundBranch,
  roundError,
  roundEtaAt,
  roundProgress,
  roundState,
} from "@/fleet";
import { holdExpiresIn, roundControls } from "@/control";
import type { ControlOffer } from "@/control";
import type { FleetControl, FleetPhaseStat, FleetRound, FleetRun, Tone } from "@/types";

/** Everything the two views read off a round, derived once. */
export interface BoardContext {
  now: number;
  /** fleet.json's own `generated_at`, which is what an ETA is measured from. */
  generatedAt: number;
  phaseStats: Record<string, FleetPhaseStat>;
  runs: FleetRun[];
  control: FleetControl;
}

export interface BoardRow {
  r: FleetRound;
  state: string;
  tone: Tone;
  action: ReturnType<typeof roundAction>;
  progress: number | null;
  eta: string;
  elapsed: string;
  phaseClock: string | null;
  phase: string;
  branch: string | null;
  error: string[];
  attempt: number | null;
  controls: ControlOffer[];
  holdLeft: number | null;
  /** Live only while the round is genuinely moving. Motion is a measurement. */
  moving: boolean;
  /** Waiting on a PERSON, which is the one state the page exists to surface. */
  waiting: boolean;
}

/** The phase in flight, and its position in the round's own sequence. Reads
 *  "dev 2/5" while running and "done 5/5" once every phase has finished. */
export function phaseLabel(r: FleetRound): string {
  const total = r.phases.length || 0;
  const at = r.done.length;
  if (!total) return r.phase ?? "no phase";
  if (at >= total) return `done ${at}/${total}`;
  return `${r.phase ?? "no phase"} ${at}/${total}`;
}

/**
 * The ETA, which says "-" far more often than it says a number.
 *
 * THREE OUTCOMES, AND TWO OF THEM ARE NOT A TIME. The collector withholds the
 * estimate entirely when any remaining phase has fewer than five completed runs
 * behind it, and a round past its own median has an unknown remainder rather
 * than a negative one - so that reads "overdue", which is the estimate
 * admitting it was wrong instead of freezing at zero.
 */
export function etaLabel(r: FleetRound, generatedAt: number, now: number): string {
  const at = roundEtaAt(r, generatedAt);
  if (at === null) return fmt.NO_DATA;
  const remaining = at - now;
  return remaining <= 0 ? `overdue ${fmt.coarse(-remaining)}` : `~${fmt.coarse(remaining)}`;
}

/**
 * How long the round has been going, or how long it took.
 *
 * ELAPSED IS ALWAYS KNOWABLE AND THE ESTIMATE USUALLY IS NOT - the collector
 * withholds an ETA entirely when any remaining phase has fewer than five
 * completed runs, so this column read `-` on most rows most of the time while a
 * round had visibly been running for half an hour. `opened N ago` answers WHEN;
 * this answers HOW LONG, and on a finished round they are different numbers.
 */
export function elapsedLabel(r: FleetRound, now: number): string {
  const from = fmt.isoToUnix(r.started_at ?? r.opened_at);
  if (!Number.isFinite(from)) return fmt.NO_DATA;
  if (r.closed_at !== null) {
    const to = fmt.isoToUnix(r.closed_at);
    return Number.isFinite(to) ? `took ${fmt.coarse(to - from)}` : fmt.NO_DATA;
  }
  return fmt.coarse(now - from);
}

/**
 * The second clock: the phase in flight, against this host's own median for it.
 *
 * FROM THE ROUND'S OWN PHASE AND THE FLEET-WIDE MEDIAN, which are two different
 * sources and deliberately so - `phase_stats` is thirty days of completed runs
 * of that phase across every round, and there is no per-round expectation
 * anywhere to compare against instead. Below five samples the collector
 * withholds the median, and so does this: `dev 26m` rather than a made-up
 * fraction of a number nobody measured.
 */
export function phaseClock(
  r: FleetRound,
  runs: FleetRun[],
  phaseStats: Record<string, FleetPhaseStat>,
  now: number,
): string | null {
  if (r.closed_at !== null) return null;
  const name = r.phase;
  // THIS ROW'S RUN, NOT THE FIRST RUNNING ONE IN THE DOCUMENT. `.find()` with
  // no worktree test gave every row the same clock the moment two rounds were
  // in flight - and this fleet runs one at a time, so it read correctly for as
  // long as nothing could contradict it. The verification claims its own
  // worktree, `<id>-verify`, so that has to be folded back here exactly as the
  // collector folds it.
  const mine = runs.find(
    (run) =>
      run.ended_at === null &&
      (run.worktree_id === r.worktree_id || run.worktree_id === `${r.worktree_id}-verify`),
  );
  const started = fmt.isoToUnix(mine?.started_at);
  if (!name || !Number.isFinite(started)) return null;
  const elapsed = fmt.coarse(now - started);
  const stat = phaseStats[name];
  const median = stat && stat.samples >= 5 ? stat.median_seconds : null;
  return median === null ? `${name} ${elapsed}` : `${name} ${elapsed} of ~${fmt.coarse(median)}`;
}

/** One row, with everything derived once. */
export function boardRow(r: FleetRound, ctx: BoardContext): BoardRow {
  return {
    r,
    ...roundState(r),
    action: roundAction(r),
    progress: roundProgress(r),
    eta: etaLabel(r, ctx.generatedAt, ctx.now),
    elapsed: elapsedLabel(r, ctx.now),
    phaseClock: phaseClock(r, ctx.runs, ctx.phaseStats, ctx.now),
    phase: phaseLabel(r),
    branch: roundBranch(r),
    error: roundError(r),
    // THE NUMBER IS ONLY WORTH THE LINE WHEN IT IS NOT ONE. Every round that
    // went through once reads "attempt 1 of 3", which is on every row and
    // distinguishes none of them - and `> 1` also happens to be exactly the
    // guard `!== null` was reaching for, without the hole: the collector and
    // this bundle deploy separately, so a document written by an older one has
    // no `attempts` key at all, and `undefined !== null` is true.
    attempt: typeof r.attempts === "number" && r.attempts > 1 ? r.attempts : null,
    controls: roundControls(r, ctx.control, ctx.now),
    holdLeft: holdExpiresIn(r, ctx.now),
    moving: r.closed_at === null && r.waiting_on === null,
    // `waiting_on` ALONE, AND `moving` DELIBERATELY NOT. The two look
    // symmetrical and are not: `moving` asks whether the machine is working, so
    // a closed round is never it; this asks whether a PERSON owes an answer,
    // which conduct closing the round does not change. RoundPage gates the
    // approve and decline chips on this, so with the `closed_at` clause the one
    // round that could be answered was the one showing no way to answer it.
    waiting: r.waiting_on === "person",
  };
}
