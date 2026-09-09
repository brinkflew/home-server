// =============================================================================
// The one thing this application can do rather than open
// -----------------------------------------------------------------------------
// EVERYTHING ELSE HERE IS A READ, AND THAT IS STILL STRUCTURAL. No container in
// this stack may reach the podman socket - `container_t -> unconfined_t :
// unix_stream_socket connectto` is DENY under enforcing SELinux and is not
// fixable by relabelling - so nothing on this page restarts a unit, pulls an
// image or terminates a stream, and the chips that would have are still links.
//
// WHAT THIS IS INSTEAD IS A MESSAGE TO THE CONTROL PLANE conduct ALREADY POLLS.
// The POST below reaches Caddy, which REWRITES it to one literal Windmill path
// and adds a token this bundle never sees, and Windmill records it as a
// suspended flow step. conduct answers it on its next 60-second cycle. So the
// arrow is unchanged - a host-side listener was refused in five places, and
// nothing here creates one - and `paths.ts` still carries conduct as
// outbound-only.
//
// THE BODY IS NOT THE GUARD. It is checked by the flow's schema and then by
// conduct on the host, which is the half that counts: a guard in a browser is a
// guard an attacker has already got past. What is written here is the shape of
// a well-formed request, not a boundary.
//
// AND NO TOKEN, STILL. `credentials: "same-origin"` carries the sign-on cookie
// and nothing else. If this file ever grows a credential, the reason the
// dashboard is cheap to expose has gone.
// =============================================================================

import { fetchText } from "./http";

/** The actions `f/agents/control`'s schema declares. Kept in the same order. */
export type ControlAction =
  | "intake_on"
  | "intake_off"
  | "hold"
  | "release"
  | "restart"
  | "resume"
  | "cancel"
  | "cancel_requeue"
  | "settle"
  | "quota_spend"
  | "quota_pace";

export interface ControlRequest {
  action: ControlAction;
  project?: string;
  /** The worktree every action but the two pairs applies to. It names a LANE,
   *  not a round - see `odoo_task`. */
  target?: string;
  /**
   * Which round on that lane.
   *
   * A WORKTREE IS REUSED AND conduct KEEPS ONE ROW PER WORKTREE, so a target
   * alone names whichever change ran there last. `restart`, `resume` and the two
   * cancels are refused without this and refused again when it names a different
   * task from the one the lane now holds. `hold` and `release` ignore it: they
   * stop dispatch for the lane, whatever is on it.
   */
  odoo_task?: number | null;
  /**
   * Which round, for `settle` and nothing else, as the flow job that ran it.
   *
   * THE ONE IDENTITY A ROUND HAS THAT OUTLIVES ITS LANE. Every other action
   * reaches conduct's `chain`, which holds one row per worktree and moves to
   * whichever change ran last - so they name a lane and a task, and only the
   * newest round on a lane can be acted on at all. A `publication` row is keyed
   * per flow job and is never reused, so this names one round exactly however
   * long ago it ran, which is what lets a round the lane left behind be settled.
   */
  job_id?: string | null;
  /** Why, in a few words. It lands on the row and beside the switch. */
  note?: string;
}

// ONE FIXED PATH, AND THE TRAILING SEGMENT IS LOAD-BEARING. Caddy's matcher is
// `handle_path /api/control/*`, so a bare `/api/control` falls through to the
// catch-all and is served the bundle - measured, not assumed. The segment
// itself is discarded by the rewrite on the other side.
const ENDPOINT = "/api/control/run";

/**
 * Ask the fleet to do something. Resolves with Windmill's job id.
 *
 * A JOB ID IS THE RECEIPT AND NOT THE OUTCOME. Windmill accepts the run and
 * returns immediately; conduct applies it within a minute, and what it did shows
 * up in the next `fleet.json`. So a caller must not report success as "done" -
 * it is "asked", and the page re-reads to find out.
 *
 * AND THE RECEIPT IS `201 text/plain`, not JSON. `fixtures/smoke.mjs` asserts
 * that against a stubbed `fetch`, which is the only place in this repository
 * that exercises the client half of this route: every measurement recorded in
 * `docs/agents.md` was made with `curl` from the host, and curl proving a route
 * proves nothing whatever about the browser reading its answer.
 */
export async function control(request: ControlRequest): Promise<string> {
  const body: Record<string, unknown> = { action: request.action };
  if (request.project) body.project = request.project;
  if (request.target) body.target = request.target;
  // SENT ONLY WHEN THERE IS ONE, because Windmill's schema types it as an
  // integer and a null would be a validation error on the two pairs that have
  // no round at all. conduct reads absence as "the caller named none" and
  // refuses the four actions that need it.
  if (typeof request.odoo_task === "number") body.odoo_task = request.odoo_task;
  // SAME RULE AS `odoo_task` ONE LINE UP: sent only when there is one, because
  // Windmill's schema types it as a string and a null would fail validation on
  // the nine actions that name a lane rather than a job.
  if (request.job_id) body.job_id = request.job_id;
  if (request.note) body.note = request.note;
  // `fetchText` AND NOT `fetchJson`, WHICH IS THE WHOLE BUG THIS ONCE HAD. This
  // spot carried a comment reading "Windmill answers the run endpoint with a
  // bare job-id string, not an object", immediately above a call that handed
  // that string to a JSON parser. A comment naming a hazard is not a guard.
  return await fetchText(ENDPOINT, { method: "POST", json: body });
}
