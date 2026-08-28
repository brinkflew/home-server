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
export type ControlAction = "intake_on" | "intake_off" | "hold" | "release" | "restart";

export interface ControlRequest {
  action: ControlAction;
  project?: string;
  /** The worktree `hold`, `release` and `restart` apply to. */
  target?: string;
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
  if (request.note) body.note = request.note;
  // `fetchText` AND NOT `fetchJson`, WHICH IS THE WHOLE BUG THIS ONCE HAD. This
  // spot carried a comment reading "Windmill answers the run endpoint with a
  // bare job-id string, not an object", immediately above a call that handed
  // that string to a JSON parser. A comment naming a hazard is not a guard.
  return await fetchText(ENDPOINT, { method: "POST", json: body });
}
