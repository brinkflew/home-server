// =============================================================================
// One round's detail document, for the page at /agents/rounds/<key>
// -----------------------------------------------------------------------------
// TYPED AGAINST src/types.ts, so a fixture that drifts from the contract
// bin/collect-metrics.py writes is a COMPILE ERROR rather than a panel that
// quietly renders nothing.
//
// THE ABSENT CASES ARE THE ONES WORTH HAVING, and there are two now that the
// round is a route rather than an expander.
//
//   1. THE DOCUMENT IS NOT WRITTEN YET. A round can be on the board before its
//      document exists - the collector renders a few phase logs per pass so a
//      cold start converges - so `MISSING_ROUNDS` gives the dev server rounds
//      that answer 404. Same trick MISSING_POSTERS plays for the poster tile.
//
//   2. THE ROUND IS NOT ON THE BOARD. Only a deep link can reach this: a round
//      that has been swept, or a merged one the board hides. The server answers
//      a document for ANY key it is asked for, so browsing to
//      /agents/rounds/swept-round-20260101T000000Z puts that state on screen -
//      the document renders and the header says why the row is absent.
// =============================================================================

import type { RoundDocument } from "../src/types";

const iso = (secondsAgo: number): string =>
  new Date(Date.now() - secondsAgo * 1000).toISOString().replace(/\.\d{3}Z$/, "Z");

/** Round keys the fixture server answers 404 for. */
export const MISSING_ROUNDS = ["nothing-rendered-yet"];

const CARD = `## upskald ship on upskald-ship

3 commit(s), 7 file(s) changed. Base \`4c1d9a2\`, head \`91f0b3e\`.
Branch \`agents/feat/1260-prose-length-and-tense-gate\`.

### What the gate could not check
- \`bin/lint-repo.sh\` is a flagged path and was touched.

### The gate
Passed on the head tree in 968s. The base was measured green on the same target.

### Evidence
- 4,460 tests, 0 failed
- coverage 91.2% against a floor of 90.0%
`;

export function roundDocument(key: string): RoundDocument {
  return {
    schema: 1,
    generated_at: iso(60),
    round: {
      key,
      worktree_id: "upskald-ship",
      project: "upskald",
      odoo_task: 1260,
      started_at: iso(7200),
      ended_at: iso(400),
      closed_at: null,
      closed_why: null,
      attempts: 1,
      max_attempts: 3,
      branch: "agents/feat/1260-prose-length-and-tense-gate",
      phase: "ship",
      waiting_on: "person",
      flow_job_id: "01a04a34-dbc7-7fdf-0e59-afcce643d0e6",
      settled: false,
    },
    events: [
      { at: iso(7200), kind: "phase_started", phase: "plan", run_id: 1 },
      { at: iso(6800), kind: "phase_ended", phase: "plan", run_id: 1, result: "ok", exit_code: 0 },
      { at: iso(6790), kind: "step_answered", module: "conduct_plan" },
      { at: iso(6700), kind: "phase_started", phase: "dev", run_id: 2 },
      { at: iso(4300), kind: "phase_ended", phase: "dev", run_id: 2, result: "ok", exit_code: 0 },
      { at: iso(4200), kind: "phase_started", phase: "verify", run_id: 3 },
      { at: iso(3200), kind: "phase_ended", phase: "verify", run_id: 3, result: "ok", exit_code: 0 },
      { at: iso(500), kind: "notified", notice: "approval", sends: 1,
        summary: "upskald verify on upskald-ship" },
      { at: iso(400), kind: "publication_opened",
        branch: "agents/feat/1260-prose-length-and-tense-gate" },
    ],
    report: {
      card: CARD,
      verdict: '{"status": "done", "title": "feat: gate prose length and tense"}',
      body: "Adds a prose gate.\n\nCloses #1260.",
      title: "feat: gate prose length and tense",
      autopublish: false,
      autopublish_why: ["a flagged path was touched, so a person decides"],
      notes: [],
      refused: [],
      gate_ok: true,
      base_sha: "4c1d9a2f00000000000000000000000000000000",
      head_sha: "91f0b3e00000000000000000000000000000000a",
      seconds: 968,
    },
    phases: [
      {
        run_id: 1, phase: "plan", worktree_id: "upskald-ship",
        started_at: iso(7200), ended_at: iso(6800), result: "ok", exit_code: 0,
        cost_usd: 2.16, tokens_in: 988154, tokens_out: 27748,
        log: "upskald-ship-plan-20260829T081000Z.log",
        rendered: true,
        result_event: {
          subtype: "success", is_error: false, num_turns: 23,
          duration_ms: 376824, total_cost_usd: 2.155849, stop_reason: null,
          usage: { output_tokens: 27748 },
        },
        gate: null,
        turns: [
          { kind: "ask", text: "Plan the change for task 1260." },
          { kind: "say", text: "Reading the gate's existing prose rules first." },
          { kind: "tool", name: "Read", input: '{"file_path":"bin/lint-repo.sh"}' },
          { kind: "denied", text: '{"subtype":"permission_denied","tool":"WebFetch"}' },
          { kind: "say", text: "The floor is in lint-repo.sh leg 4. Plan written." },
        ],
      },
      {
        run_id: 3, phase: "verify", worktree_id: "upskald-ship-verify",
        started_at: iso(4200), ended_at: iso(3200), result: "ok", exit_code: 0,
        cost_usd: null, tokens_in: null, tokens_out: null,
        log: "upskald-ship-verify-check-20260829T090000Z.log",
        rendered: true, result_event: null, turns: [],
        gate: {
          bytes: 10805389, truncated: true,
          text: "  PASS  bin/lint-repo.sh\n  Tests  4460 passed\n  make: check complete\n",
        },
      },
      {
        run_id: 4, phase: "ship", worktree_id: "upskald-ship",
        started_at: iso(600), ended_at: null, result: null, exit_code: null,
        cost_usd: null, tokens_in: null, tokens_out: null,
        log: "upskald-ship-ship-20260829T093000Z.log",
        // THE BUDGET DEFERRED THIS ONE, which is the state a cold start spends
        // several passes in and the one a reader must not mistake for silence.
        rendered: false,
        short: "not rendered yet - this run's budget was spent",
        result_event: null, gate: null, turns: [],
      },
    ],
    sources: { conduct_db: { ok: true, at: iso(60), error: null } },
  };
}
