// =============================================================================
// What a fleet round IS, and what it is waiting for
// -----------------------------------------------------------------------------
// A MODULE RATHER THAN THE PAGE, for the reason health.ts already demonstrates
// with laneTone and quotaTone: a state machine written inline in a .vue file
// cannot be exercised by fixtures/smoke.mjs, which is the only logic test this
// application has. Everything here is pure - no DOM, no store, no fetch - so
// every branch below is asserted in node.
//
// THE OUTCOME IS STRUCTURAL AND `closed_why` IS NEVER PARSED. conduct closes a
// round with a sentence - "reached the publish path", "the rounds are used up",
// "the flow failed: ..." - and keying a state on those words is the habit this
// repository names as a defect everywhere else it appears. Whether a round
// reached the publish path is the existence of a publication row; whether it
// published is a column on it. Both arrive as `published` and `pr_state`, and
// the sentence is shown to a reader rather than read by this code.
//
// AND NO LINK IS BUILT HERE. Every href below comes out of fleet.json, which
// the collector built host-side and passed through _fleet_link - the guard that
// drops anything resembling a Windmill resume URL. See src/api/fleet.ts for why
// that matters more than it looks: a signed resume URL carries an HMAC in its
// path and needs no session, so anything holding one can approve an agent's
// merge. Do not "helpfully" construct one from flow_job_id, pr_url or anything
// else on the row.
// =============================================================================

import type { FleetRound, Tone } from "@/types";

/** The five conduct_* handlers, in flow order. Mirrors FLEET_PHASES in
 *  bin/collect-metrics.py, which is itself a copy of conduct/poll.py's. The
 *  round carries its own `phases`, so this is only the fallback. */
export const PHASE_SEQUENCE = ["plan", "dev", "verify", "review", "ship"];

/** conduct's `branch_prefix`, and every branch it pushes starts with it -
 *  publish.branch_name refuses a name that does not, which is the whole thing
 *  keeping a phase off `main`. Stripped for display only; never for a link. */
export const BRANCH_PREFIX = "agents/";

/** A state a round is in, and how it should read. */
export interface RoundState {
  tone: Tone;
  state: string;
}

/** The action chip for one row. Same shape as media.ts's, deliberately: a null
 *  href is what makes ChipLink render a disabled box rather than a dead link. */
export interface RoundAction {
  label: string;
  href: string | null;
  title: string;
}

/**
 * True once a round is finished AND its pull request is merged.
 *
 * THE HIDING RULE, AND IT REQUIRES POSITIVE EVIDENCE. `pr_state` is "unknown"
 * whenever GitHub could not be asked - no token, a timeout, an expired
 * credential - and an unknown round stays on the board. A row disappearing
 * because a token lapsed is the same class of error as an empty list reading as
 * an idle fleet, which is the failure this whole document exists to prevent.
 */
export function isSettled(r: FleetRound): boolean {
  return r.closed_at !== null && r.pr_state === "merged";
}

/**
 * What this round is doing, or what became of it.
 *
 * OPEN ROUNDS ARE GRADED ON `waiting_on` and closed ones on the publication
 * join, and the order below is the priority: a person owing an answer outranks
 * everything, because it is the only state a reader can act on.
 */
export function roundState(r: FleetRound): RoundState {
  if (r.closed_at === null) {
    if (r.waiting_on === "person") return { tone: "warn", state: "waiting on you" };
    // NULL IS NOT "conduct". chain.flow_job_id names the job that STOPPED, so a
    // round mid-flight matches no notice - grey says "nobody has been asked"
    // rather than claiming the fleet owns a step.
    if (r.waiting_on === null) return { tone: "off", state: "running" };
    return { tone: "ok", state: "with conduct" };
  }
  if (r.pr_state === "merged") return { tone: "ok", state: "merged" };
  if (r.pr_url) {
    // An open pull request is the one closed state still owing a person work,
    // and "unknown" must not be drawn as though GitHub had confirmed anything.
    if (r.pr_state === "closed") return { tone: "warn", state: "pr closed" };
    if (r.pr_state === "unknown") return { tone: "ok", state: "published" };
    return { tone: "ok", state: "in review" };
  }
  // NO URL AND "unknown" IS NOT THE SAME AS NO URL. The collector cannot read a
  // pull request off a publication row written before the two columns existed,
  // and a migration is a moment in time - so every round that published before
  // this feature shipped holds NULL whether or not it opened one. Falling
  // through to "not published" would put a permanent, confident lie on the one
  // round this fleet has actually merged.
  if (r.pr_state === "unknown") return { tone: "ok", state: "published" };
  // A LATER ROUND ON THIS TASK CARRIED THE WORK, so nothing is owed here. This
  // is checked BEFORE the two below because both of them are claims about a
  // round that ended on its own account, and a superseded one did not: the
  // review found something blocking, `retry` stopped the flow, and the next
  // round published. Grey rather than amber - it is history, not a fault - and
  // absence is false, because an older collector emits no such field.
  if (r.superseded) return { tone: "off", state: "superseded" };
  // A publication row that closed carrying no pull request, on a database this
  // code COULD have read one from: the flow ended without opening one, which is
  // a declined approval or a seven-day timeout.
  if (r.published) return { tone: "warn", state: "not published" };
  // No publication row at all - it never reached the publish path.
  return { tone: "fail", state: "stopped" };
}

/**
 * The one thing to click on this row.
 *
 * "Agent questions" is not a state conduct has - a phase either answers or it
 * does not. What a person is actually ever waiting on is one of three things,
 * and they are told apart by `kind` and by the publication join, never by the
 * wording of a summary.
 */
export function roundAction(r: FleetRound): RoundAction {
  if (r.closed_at === null && r.waiting_on === "person") {
    // conduct's own link to the approval page, behind sign-on. Carried
    // verbatim; the collector already refused anything resembling a resume URL.
    if (r.kind === "refused" || !r.link) {
      return {
        label: "look",
        href: r.odoo_url,
        title:
          "conduct will not publish this and there is nothing to approve - open the task",
      };
    }
    return { label: "approve", href: r.link, title: "conduct's approval page, behind sign-on" };
  }
  if (r.pr_url && r.pr_state !== "merged") {
    return {
      label: r.pr_number === null ? "review" : `review #${r.pr_number}`,
      href: r.pr_url,
      title: "the pull request this round opened",
    };
  }
  // THE BRANCH IS DELIBERATELY NOT HERE, though it is the thing to read while
  // the gate runs. It is already a link in the pull-request column, which is
  // empty until a pull request exists precisely so that it can hold one - and
  // the same destination twice on one row is the row saying it does not know
  // which of them matters. This column answers "what is owed to a person";
  // that one answers "where is the code".
  if (r.closed_at !== null && r.odoo_url) {
    return { label: "task", href: r.odoo_url, title: "open this task in the tracker" };
  }
  // Nothing owes anybody anything yet. A disabled chip keeps the column's width
  // and says so, which is what the media pages already do for an unownable row.
  return { label: "-", href: null, title: "nothing is waiting on a person here" };
}

/** 0..1, or null when the round declares no phases. `done` is per ATTEMPT - the
 *  row prints "attempt N of 2" beside this for exactly that reason. */
export function roundProgress(r: FleetRound): number | null {
  const total = (r.phases?.length ?? 0) || PHASE_SEQUENCE.length;
  if (!total) return null;
  return Math.min(1, (r.done?.length ?? 0) / total);
}

/**
 * When this round is expected to finish, as a unix time, or null.
 *
 * MEASURED FROM THE DOCUMENT'S OWN `generated_at`, never from now. The estimate
 * was computed against the database as it stood when the file was written, and
 * a document is up to five minutes old - anchoring it to the read is what lets
 * the page count down between writes and then say "overdue" rather than
 * freezing at zero when the prediction turns out to be wrong.
 */
export function roundEtaAt(r: FleetRound, generatedAtUnix: number): number | null {
  if (r.eta_seconds === null || !Number.isFinite(generatedAtUnix)) return null;
  return generatedAtUnix + r.eta_seconds;
}

/**
 * Waiting on a person first, then running, then finished by recency.
 *
 * The board's whole job is to put the row somebody has to act on at the top,
 * and to keep a finished round from ever outranking a live one.
 */
export function byUrgency(a: FleetRound, b: FleetRound): number {
  const rank = (r: FleetRound) => {
    if (r.closed_at !== null) return 3;
    if (r.waiting_on === "person") return 0;
    if (r.waiting_on === null) return 1;
    return 2;
  };
  const difference = rank(a) - rank(b);
  if (difference !== 0) return difference;
  // Closed rounds newest first; open ones oldest first, because an open round
  // that has been going longest is the one most likely to be stuck.
  if (a.closed_at !== null && b.closed_at !== null) {
    return b.closed_at.localeCompare(a.closed_at);
  }
  return (a.opened_at ?? "").localeCompare(b.opened_at ?? "");
}

/**
 * The short branch name for the pull-request column, or null.
 *
 * THE `agents/` PREFIX IS DROPPED AND ONLY THAT ONE. It is on every branch
 * conduct pushes - publish.branch_name refuses a name outside it, which is the
 * whole boundary that keeps a phase off `main` - so printing it costs eight
 * characters on every row and distinguishes none of them. What is left is the
 * part a person recognises: `feat/1247-intake-form`.
 */
export function roundBranch(r: FleetRound): string | null {
  if (!r.branch) return null;
  return r.branch.startsWith(BRANCH_PREFIX) ? r.branch.slice(BRANCH_PREFIX.length) : r.branch;
}

/**
 * The failure to show under a row. Empty when the round did not fail.
 *
 * TWO SOURCES AND THEY ARE NOT REDUNDANT. `error` is what a run recorded when
 * it failed - one row per execution, so it is right for every round on the
 * board. `closed_why` is conduct's sentence for the round as a whole, and it
 * exists only for the newest round on a worktree, because `chain` holds one row.
 * Both are DISPLAYED AND NEVER PARSED: nothing here or in roundState branches
 * on their wording.
 *
 * THE TRIGGER IS THE OUTCOME, NOT THE PRESENCE OF A SENTENCE. conduct writes
 * `closed_why` on every round it closes, including "reached the publish path" -
 * which is a round that worked. Keying on it would put an expander on every
 * finished row, most of them opening onto a sentence that says nothing went
 * wrong. `tone` is the structural answer roundState already derived, so this
 * asks that instead of reading the words.
 */
export function roundError(r: FleetRound): string[] {
  if (roundState(r).tone === "ok") return [];
  const lines: string[] = [];
  if (r.error) lines.push(r.error);
  // NOT WHEN IT REPEATS THE RUN'S OWN REASON. conduct builds closed_why as "the
  // flow failed: <the refusal>", so on a refused round the two say the same
  // thing twice and the second one is the one with the prefix.
  if (r.closed_why && !(r.error && r.closed_why.includes(r.error.split("\n")[0]))) {
    lines.push(r.closed_why);
  }
  return lines;
}
