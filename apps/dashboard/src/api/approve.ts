// =============================================================================
// Answering the one step conduct is forbidden to answer
// -----------------------------------------------------------------------------
// THE SHAPE IS `control.ts`'s AND SO IS THE REASONING: the POST reaches Caddy,
// which DISCARDS the path it was given, substitutes one literal Windmill path
// and adds a token this bundle never sees. Nothing new reaches the host, and
// `paths.ts` still carries conduct as outbound-only - conduct is not involved in
// this at all.
//
// WHY THE JOB ID IS IN THE BODY. Caddy's guard is that the client's path is
// thrown away; putting an id in the URL would mean rewriting to a path the
// client partly chose, which is that guard given away for a convenience.
//
// AND NO RESUME URL, EVER, in either direction. Windmill's
// `jobs_u/resume/{id}/{resume_id}/{signature}` carries an HMAC in the path and
// needs no session, so anything holding one can approve an agent's merge. This
// file must never construct, receive or store one - `_fleet_link` on the host
// drops any link that looks like one, and fixtures/smoke.mjs asserts it over
// every href the board renders.
//
// WHAT STOPS THIS ANSWERING A GATE OF CONDUCT'S OWN is not in this file and
// cannot be: `f/agents/approve` reads the target job and refuses unless the step
// waiting is `publish_pr`. A browser-side check would be a guard an attacker has
// already got past.
// =============================================================================

import { fetchText } from "./http";

export type ApproveDecision = "approve" | "decline";

// The trailing segment is load-bearing for the same measured reason
// `/api/control/run` has one: Caddy matches `handle_path /api/approve/*`, so a
// bare `/api/approve` falls through to the catch-all and is served the bundle.
const ENDPOINT = "/api/approve/run";

/**
 * Approve or decline one round's pull request. Resolves with the job id.
 *
 * A JOB ID IS A RECEIPT, NOT AN OUTCOME. Windmill accepts the run and answers
 * immediately; what it did shows up when the board re-reads. So a caller says
 * "asked", never "done" - the same contract `control()` has, and for the same
 * reason: the last time this application read a `201 text/plain` receipt as JSON
 * it told a person their command had failed after it had been carried out.
 */
export async function approve(
  jobId: string,
  decision: ApproveDecision,
  note?: string,
): Promise<string> {
  const body: Record<string, unknown> = { job_id: jobId, decision };
  if (note) body.note = note;
  return await fetchText(ENDPOINT, { method: "POST", json: body });
}
