// =============================================================================
// fleet.json - what the agent fleet is doing, and the two things it must not say
// -----------------------------------------------------------------------------
// The third document, on the same contract as the two media ones: written by
// bin/collect-metrics.py's source_fleet on the slow tier, rewritten whole, no
// history anywhere. It exists because the fleet's 41 Prometheus series are all
// scalars - `runs_today = 3` cannot say WHICH task, which round, or whether a
// pull request has been waiting on a person since last night. A task title, a
// branch and a Windmill job id are exactly the label family the collector
// refuses to mint.
//
// TWO REFUSALS TRAVEL WITH THIS FILE, and both are enforced at the writing end
// rather than here - a guard in a browser is a guard an attacker already got
// past. They are restated because a reader arriving at this module needs to
// know what NOT to add:
//
//   1. NO RESUME URL, EVER. Windmill's jobs_u/resume/{id}/{resume_id}/{sig}
//      carries an HMAC in the path and needs no session, so anything holding one
//      can approve an agent's merge. docs/agents.md refuses it to ntfy for that
//      reason, and conduct/notify.py's own docstring says nothing in it can
//      construct one. `link` here is conduct's link to the approval page behind
//      sign-on, carried verbatim; source_fleet drops anything resembling a
//      resume URL regardless. Do not "helpfully" build a deeper link from
//      flow_job_id.
//
//   2. COST IS REPORTED, NEVER RETAINED. docs/observability.md records "there is
//      no dollar metric and no daily spend ceiling, deliberately - percentages
//      are the currency", and that stands: home_server_agent_quota_status is
//      still what paces the fleet. cost_usd is here because a document keeps no
//      history and so cannot become a second currency. It must not be mirrored
//      into a series.
// =============================================================================

import { fetchDocument } from "./document";
import type { FleetDocument } from "@/types";

const FLEET_PATH = "/data/fleet.json";

export function fetchFleet(signal?: AbortSignal): Promise<FleetDocument> {
  return fetchDocument<FleetDocument>(FLEET_PATH, "fleet.json", signal);
}
