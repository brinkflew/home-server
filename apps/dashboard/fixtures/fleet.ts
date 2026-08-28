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

/** conduct's five phases, so every fixture round shares one denominator. */
const PHASES = ["plan", "dev", "verify", "review", "ship"];

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
        kind: "approval",
        closed_at: null,
        closed_why: null,
        done: ["plan", "dev", "verify", "review"],
        phases: PHASES,
        odoo_url: "https://avanserv.com/web#id=1572&model=project.task",
        branch: "agents/task-1572",
        pr_url: null,
        pr_number: null,
        pr_state: null,
        published: false,
        eta_seconds: null,
        eta_samples: null,
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
        kind: null,
        closed_at: null,
        closed_why: null,
        done: ["plan"],
        phases: PHASES,
        odoo_url: "https://avanserv.com/web#id=1601&model=project.task",
        branch: null,
        pr_url: null,
        pr_number: null,
        pr_state: null,
        published: false,
        eta_seconds: 3080,
        eta_samples: 6,
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
        kind: null,
        closed_at: null,
        closed_why: null,
        done: [],
        phases: PHASES,
        odoo_url: "https://avanserv.com/web#id=1610&model=project.task",
        branch: null,
        pr_url: null,
        pr_number: null,
        pr_state: null,
        published: false,
        eta_seconds: null,
        eta_samples: null,
      },
      // PUBLISHED, AND GITHUB COULD NOT BE ASKED. It must STAY on the board:
      // hiding requires positive evidence of a merge, never its absence.
      {
        worktree_id: "wt-1188aa",
        project: "upskald",
        odoo_task: 1588,
        ref: "agents/task-1588",
        phase: "ship",
        opened_at: iso(30 * 3600),
        attempts: 1,
        max_attempts: 2,
        flow_job_id: "job-fff",
        head: "9a0b1c2",
        resumed_at: null,
        waiting_on: null,
        link: null,
        summary: "Bound the lane store on three triggers",
        kind: null,
        closed_at: iso(26 * 3600),
        closed_why: "reached the publish path",
        done: PHASES,
        phases: PHASES,
        odoo_url: "https://avanserv.com/web#id=1588&model=project.task",
        branch: "agents/task-1588",
        pr_url: "https://github.com/avanserv/upskald/pull/251",
        pr_number: 251,
        pr_state: "unknown",
        published: true,
        eta_seconds: null,
        eta_samples: null,
      },
      // Closed and its pull request is OPEN - somebody owes it a review, which
      // is the third and last thing a person is ever waiting on here.
      {
        worktree_id: "wt-2c44b1",
        project: "upskald",
        odoo_task: 1544,
        ref: "agents/task-1544",
        phase: "ship",
        opened_at: iso(40 * 3600),
        attempts: 1,
        max_attempts: 2,
        flow_job_id: "job-eee",
        head: "77aa31d",
        resumed_at: null,
        waiting_on: null,
        link: null,
        summary: "Squash the round and open the pull request",
        kind: null,
        closed_at: iso(36 * 3600),
        closed_why: "reached the publish path",
        done: PHASES,
        phases: PHASES,
        odoo_url: "https://avanserv.com/web#id=1544&model=project.task",
        branch: "agents/task-1544",
        pr_url: "https://github.com/avanserv/upskald/pull/249",
        pr_number: 249,
        pr_state: "open",
        published: true,
        eta_seconds: null,
        eta_samples: null,
      },
      // A publication that closed carrying NO pull request: the flow ended
      // without opening one - a declined approval, or a seven-day timeout.
      // Not the same outcome as the row below, and only this join says so.
      {
        worktree_id: "wt-55ee02",
        project: "upskald",
        odoo_task: 1566,
        ref: "agents/task-1566",
        phase: "ship",
        opened_at: iso(60 * 3600),
        attempts: 1,
        max_attempts: 2,
        flow_job_id: "job-ggg",
        head: "1d2e3f4",
        resumed_at: null,
        waiting_on: null,
        link: null,
        summary: "Widen the cpuset for a third lane",
        kind: null,
        closed_at: iso(55 * 3600),
        closed_why: "reached the publish path",
        done: PHASES,
        phases: PHASES,
        odoo_url: "https://avanserv.com/web#id=1566&model=project.task",
        branch: "agents/task-1566",
        pr_url: null,
        pr_number: null,
        pr_state: null,
        published: true,
        eta_seconds: null,
        eta_samples: null,
      },
      // Never reached the publish path at all - no publication row exists.
      // `closed_why` is shown to a reader and parsed by nothing.
      {
        worktree_id: "wt-88fa10",
        project: "upskald",
        odoo_task: 1530,
        ref: "agents/task-1530",
        phase: "review",
        opened_at: iso(80 * 3600),
        attempts: 2,
        max_attempts: 2,
        flow_job_id: "job-hhh",
        head: null,
        resumed_at: null,
        waiting_on: null,
        link: null,
        summary: null,
        kind: null,
        closed_at: iso(72 * 3600),
        closed_why: "the rounds are used up",
        done: ["plan", "dev", "verify"],
        phases: PHASES,
        odoo_url: "https://avanserv.com/web#id=1530&model=project.task",
        branch: null,
        pr_url: null,
        pr_number: null,
        pr_state: null,
        published: false,
        eta_seconds: null,
        eta_samples: null,
      },
      // THE ONLY ROW THE DEFAULT BOARD HIDES. Without it the toggle reveals
      // nothing and its own count reads zero, so the filter would be
      // untestable by eye and a regression in it invisible.
      {
        worktree_id: "wt-3311cd",
        project: "upskald",
        odoo_task: 1501,
        ref: "agents/task-1501",
        phase: "ship",
        opened_at: iso(120 * 3600),
        attempts: 1,
        max_attempts: 2,
        flow_job_id: "job-iii",
        head: "5b6c7d8",
        resumed_at: null,
        waiting_on: null,
        link: null,
        summary: "Read the runroot off the engine rather than the file",
        kind: null,
        closed_at: iso(115 * 3600),
        closed_why: "reached the publish path",
        done: PHASES,
        phases: PHASES,
        odoo_url: "https://avanserv.com/web#id=1501&model=project.task",
        branch: "agents/task-1501",
        pr_url: "https://github.com/avanserv/upskald/pull/244",
        pr_number: 244,
        pr_state: "merged",
        published: true,
        eta_seconds: null,
        eta_samples: null,
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
    phase_stats: {
      plan: { median_seconds: 320, samples: 11 },
      dev: { median_seconds: 1240, samples: 9 },
      verify: { median_seconds: 1510, samples: 9 },
      review: { median_seconds: 640, samples: 8 },
      ship: { median_seconds: 190, samples: 8 },
    },
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
    sources: {
      conduct_db: { ok: true, at: iso(74), error: null },
      // DELIBERATELY UNHEALTHY. The board must say why nothing could be
      // confirmed merged rather than silently showing everything.
      github: { ok: false, at: null, error: "HTTP Error 401: Unauthorized" },
    },
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
    phase_stats: {},
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
