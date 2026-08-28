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

import type { FleetControl, FleetRound } from "./types";
import type { ControlAction } from "./api/control";

/** A control as the board renders it: what it does, and why it may not. */
export interface ControlOffer {
  label: string;
  action: ControlAction;
  /** The worktree it applies to, or null for the intake switch. */
  target: string | null;
  /** Null when it can be pressed. A sentence when it cannot. */
  disabled: string | null;
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
 * The controls this round offers.
 *
 * NOTHING IS OFFERED ON A ROUND THAT IS OVER. Holding a finished round stops
 * nothing, and restarting one has no chain for conduct to close - it would be a
 * second, less careful way to start a round, which is exactly what `conduct
 * intake` refuses to grow a `--start` flag for.
 */
export function roundControls(
  round: FleetRound,
  control: FleetControl,
  nowUnix: number,
): ControlOffer[] {
  if (round.closed_at !== null) return [];

  const unavailable = control.available
    ? null
    : "the control route has no token - see WINDMILL_DASHBOARD_TOKEN";
  const offers: ControlOffer[] = [
    round.held
      ? { label: "release", action: "release", target: round.worktree_id,
          disabled: unavailable }
      : { label: "hold", action: "hold", target: round.worktree_id,
          disabled: unavailable },
  ];

  // THE FLOOR IS conduct's, AND THE BOARD HONOURS IT RATHER THAN DISCOVERING
  // IT. Two restarts close together put two flows on one worktree and the next
  // prepare_worktree deletes the first one's commits - so conduct refuses
  // inside the floor, and offering a button that will be refused teaches a
  // reader to distrust the others.
  let restart = unavailable;
  if (!restart && round.started_at) {
    const since = nowUnix - Date.parse(round.started_at) / 1000;
    if (Number.isFinite(since) && since < control.restart_floor_sec) {
      restart = `started ${Math.round(since)}s ago; conduct refuses a restart inside ${control.restart_floor_sec}s`;
    }
  }
  offers.push({ label: "restart", action: "restart", target: round.worktree_id,
                disabled: restart });
  return offers;
}
