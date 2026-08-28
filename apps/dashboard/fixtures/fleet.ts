// =============================================================================
// The synthetic fleet document
// -----------------------------------------------------------------------------
// Typed against src/types.ts, which tsconfig.node.json includes - so a fixture
// that drifts from the contract bin/collect-metrics.py writes is a COMPILE
// ERROR rather than a panel that quietly renders nothing.
//
// DELIBERATELY UNHEALTHY, and four of these rows exist to exercise a rule rather
// than a layout. Deleting them would make the page prettier and blinder:
//
//   1. A round WAITING ON A PERSON, because that is the loudest thing the page
//      can say and the only state with a link on it.
//   2. A round with `waiting_on: null` - mid-flight, matching no notice, which
//      must render grey and say "in flight" rather than borrowing either side's
//      colour. chain.flow_job_id names the job that STOPPED, so this is an
//      ordinary state and not an error.
//   3. An ORPHAN NOTICE: a person has been asked, and no open round accounts for
//      it. If the board ever drops these, an unanswered approval disappears.
//   4. A run with `result: null` and no ended_at - still going. conduct counts a
//      failure as `result IS NOT NULL AND result != 'ok'`, and the first version
//      of the collector's SQL got this backwards and drew every running phase as
//      a failed one.
// =============================================================================

import type { FleetDocument } from "../src/types";

const iso = (secondsAgo: number): string =>
  new Date(Date.now() - secondsAgo * 1000).toISOString().replace(/\.\d{3}Z$/, "Z");

export function fleetDocument(): FleetDocument {
  return {
    schema: 1,
    generated_at: iso(74),
    rounds: [
      {
        worktree_id: "wt-9f21c4",
        project: "upskald",
        odoo_task: 1572,
        ref: "agents/task-1572",
        phase: "ship",
        opened_at: iso(11 * 3600),
        attempts: 2,
        max_attempts: 2,
        flow_job_id: "job-aaa",
        head: "3c8c616",
        resumed_at: null,
        waiting_on: "person",
        // The approval page behind sign-on. NEVER a resume URL - see
        // src/api/fleet.ts, and note that a fixture is exactly where a bad
        // example would get copied from.
        link: "https://agents.avanserv.com/run/job-aaa",
        summary: "Open the pull request for task 1572",
      },
      {
        worktree_id: "wt-4ab810",
        project: "upskald",
        odoo_task: 1601,
        ref: "agents/task-1601",
        phase: "dev",
        opened_at: iso(52 * 60),
        attempts: 1,
        max_attempts: 2,
        flow_job_id: "job-bbb",
        head: null,
        resumed_at: null,
        waiting_on: "conduct",
        link: null,
        summary: null,
      },
      {
        worktree_id: "wt-77d3e0",
        project: "upskald",
        odoo_task: 1610,
        ref: "agents/task-1610",
        phase: "plan",
        opened_at: iso(9 * 60),
        attempts: 0,
        max_attempts: 2,
        flow_job_id: "job-ccc",
        head: null,
        resumed_at: null,
        waiting_on: null,
        link: null,
        summary: null,
      },
    ],
    publications: [
      {
        job_id: "job-aaa",
        project: "upskald",
        worktree_id: "wt-9f21c4",
        odoo_task: 1572,
        branch: "agents/task-1572",
        opened_at: iso(11 * 3600 + 900),
      },
    ],
    notices: [
      {
        flow_job_id: "job-aaa",
        module_id: "publish_pr",
        project: "upskald",
        kind: "approval",
        summary: "Open the pull request for task 1572",
        link: "https://agents.avanserv.com/run/job-aaa",
        first_at: iso(10 * 3600),
        last_at: iso(2 * 3600),
        sends: 4,
        waiting_on: "person",
      },
      {
        flow_job_id: "job-eee",
        module_id: "publish_pr",
        project: "upskald",
        kind: "approval",
        summary: "Approve the squash for task 1544",
        link: "https://agents.avanserv.com/run/job-eee",
        first_at: iso(38 * 3600),
        last_at: iso(3 * 3600),
        sends: 7,
        waiting_on: "person",
      },
    ],
    runs: [
      {
        phase: "review",
        project: "upskald",
        worktree_id: "wt-9f21c4",
        started_at: iso(1870),
        ended_at: null,
        result: null,
        exit_code: null,
        tokens_in: 90_000,
        tokens_out: 4_000,
        cost_usd: 1.02,
        task: "Review the change for task 1572",
        verdict: null,
      },
      {
        phase: "dev",
        project: "upskald",
        worktree_id: "wt-9f21c4",
        started_at: iso(4 * 3600),
        ended_at: iso(3 * 3600),
        result: "ok",
        exit_code: 0,
        tokens_in: 412_000,
        tokens_out: 18_000,
        cost_usd: 4.13,
        task: "Implement the intake stop-detection for task 1572",
        verdict: '{"status":"done","concerns":[]}',
      },
      {
        phase: "plan",
        project: "upskald",
        worktree_id: "wt-4ab810",
        started_at: iso(9 * 3600),
        ended_at: iso(8 * 3600),
        result: "killed",
        exit_code: 1,
        tokens_in: 61_000,
        tokens_out: 2_400,
        cost_usd: 0.71,
        task: "Plan the worker-lane change",
        verdict: null,
      },
    ],
    intake: [
      {
        project: "upskald",
        odoo_task: null,
        flow_job_id: null,
        opened_at: null,
        closed_at: null,
        last_looked_at: iso(260),
        last_why: "three rounds already open, which is REVIEW_CAP",
      },
    ],
    totals: {
      runs_today: 6,
      runs_failed_today: 1,
      tokens_today: 2_140_000,
      tokens_week: 11_900_000,
      cost_today: 18.44,
      cost_week: 96.2,
      rounds_open: 3,
      publications_pending: 1,
    },
    sources: { conduct_db: { ok: true, at: iso(74), error: null } },
  };
}

/**
 * The state that must never look like an idle fleet: the document was written,
 * and conduct's database could not be read. Reached with
 * `HS_FIX_BROKEN=conduct_db npm run dev`.
 */
export function fleetUnreadable(): FleetDocument {
  const doc = fleetDocument();
  return {
    ...doc,
    rounds: [],
    publications: [],
    notices: [],
    runs: [],
    intake: [],
    totals: {
      runs_today: null,
      runs_failed_today: null,
      tokens_today: null,
      tokens_week: null,
      cost_today: null,
      cost_week: null,
      rounds_open: null,
      publications_pending: null,
    },
    sources: { conduct_db: { ok: false, at: null, error: "database is locked" } },
  };
}
