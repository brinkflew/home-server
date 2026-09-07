// =============================================================================
// The machinery, as /agents/fleet draws it
// -----------------------------------------------------------------------------
// TWO DECISIONS THAT BOTH HAVE A WRONG ANSWER THAT RENDERS PERFECTLY, which is
// the whole reason they are here rather than in FleetPage.vue. This application
// has paid for that twice already: quotaWindow was a four-line computed inside
// RoundsPage.vue, which fixtures/smoke.mjs structurally cannot reach, so neither
// direction of it had ever been asserted - and roundboard.ts was the same repair
// the day before. A computed in a .vue file is code no test in this repository
// can call.
//
// PURE, AND EVERY READING IS AN ARGUMENT. Nothing here touches a store, a clock
// or a poll; the page hands in what it has and gets back what to draw.
//
// src/health.ts IS STILL WHERE A STATUS BECOMES A COLOUR. checkTone() is called
// rather than reimplemented, because the version that WAS reimplemented here
// mapped a `fail` check to amber - so a containment failure, the one thing on
// this page that pages a phone, drew as a warning. No fixture could see it: the
// agents section has never carried a `fail`.
// =============================================================================

import * as fmt from "@/format";
import { checkTone } from "@/health";
import type { Check, Tone } from "@/types";

/** agents.windmill_db_size grades against this same figure. */
const WINDMILL_DB_MAX = 2048 * 1024 * 1024;

/**
 * What the page has measured, in the shape FleetPage's poll returns.
 *
 * ABSENT IS NaN THROUGHOUT, EXCEPT phaseInFlight, WHICH IS undefined. That
 * asymmetry is deliberate and predates this module: a phase that has never run
 * must render grey rather than as one that is not running, and only a value
 * outside the number line can carry "the series does not exist".
 */
export interface MachineMetrics {
  runsToday: number;
  runsFailedToday: number;
  phaseInFlight: number | undefined;
  approvals: number;
  workerLanes: number;
  windmillDb: number;
  mirrorAge: number;
  checkoutDirty: number;
  publishConfigured: number;
  leaked: number;
}

export interface LeadReading {
  /** The headline, in --t-mono-xl. One per view. */
  text: string;
  tone: Tone;
  /** Motion is a measurement: it breathes only while a phase genuinely runs. */
  live: boolean;
  sub: string;
}

export interface PreconditionRow {
  /** The check id. The join, and the only thing to key on. */
  id: string;
  name: string;
  value: string;
  tone: Tone;
  finding: string;
}

const n = (v: number | undefined): number => (v === undefined ? Number.NaN : v);

/**
 * "none failed", "1 failed", "4 failed" - or nothing at all when the counter is
 * absent, because a failure count nobody measured must not read as zero.
 */
function failedWord(failed: number): string {
  if (!Number.isFinite(failed)) return "";
  if (failed === 0) return "none failed";
  return `${fmt.number(failed)} failed`;
}

/**
 * The headline, and it is four sentences rather than one with a number in it.
 *
 * fmt.number(NaN) is "-", so the obvious spelling of this renders
 * `- phase runs today` on a host the store has no sample for - a headline
 * claiming a dash ran. Absence gets its own sentence, which is this page's
 * organising rule applied at the largest type on it.
 *
 * THE UNIT CAVEAT IS NOT IN HERE. "A phase run is not a round" is a caveat, and
 * a caveat belongs in the tooltip that has a slot styled for one; putting it in
 * the sub-line would cost the line that says which nothing is happening.
 */
export function leadReading(m: MachineMetrics | null): LeadReading {
  const runs = n(m?.runsToday);

  if (!Number.isFinite(runs)) {
    return {
      text: "not measured",
      tone: "off",
      live: false,
      sub: "the store has no sample for today's counter",
    };
  }

  const text = `${fmt.number(runs)} phase run${runs === 1 ? "" : "s"} today`;
  const failed = failedWord(n(m?.runsFailedToday));
  const running = m?.phaseInFlight;

  // NEVER RUN IS NOT IDLE, and the counter above cannot tell them apart - it is
  // 0 in both. This is the one branch that reads phaseInFlight's undefined.
  if (running === undefined || !Number.isFinite(running)) {
    return { text, tone: "off", live: false, sub: "no phase has ever run on this host" };
  }

  const tail = running === 1 ? "a phase is running now" : "nothing running";
  return {
    text,
    tone: "ok",
    live: running === 1,
    sub: failed ? `${failed} - ${tail}` : tail,
  };
}

interface RowSpec {
  id: string;
  name: string;
  value: (m: MachineMetrics | null, check: Check | null) => string;
  /** null means the check's own message is the finding. */
  finding: ((m: MachineMetrics | null) => string) | null;
}

/**
 * The value cell for a check that publishes no number of its own.
 *
 * THREE OF THE TEN, AND THE ASYMMETRY IS DELIBERATE. agents.slice_limits,
 * agents.runner_isolation and agents.fleet_root_label emit a verdict and no
 * fact, so there is nothing to put here but the verdict. Minting a word -
 * "bounded", "isolated" - would be this application asserting something the
 * battery never said, which is the habit docs/dashboard.md refuses about
 * closed_why one page over.
 */
const statusWord = (_m: MachineMetrics | null, check: Check | null): string =>
  check ? check.status : fmt.NO_DATA;

/**
 * TEN ROWS IN A FIXED ORDER, control plane first and containment second.
 *
 * NOT WORST-FIRST, and that is what makes this a different object from the
 * FindingsPanel below it. That panel already sorts this very section by
 * STATUS_RANK; a second table sorted the same way would be the same table drawn
 * twice. Sorted by kind instead, the two split the way Prometheus and
 * status.json already do - THIS ONE CARRIES THE VALUE, THAT ONE CARRIES THE
 * PROSE, and the id is the join. A fixed order is also what lets a reader learn
 * where a row lives, and the rail still finds a bad one at a glance.
 *
 * EVERY ID IS A CHECK bin/verify-host.sh ACTUALLY EMITS. An id that does not
 * resolve renders grey and "not measured" silently and for ever, which is the
 * failure this repository names most often - so smoke.mjs asserts the set.
 */
const SPECS: RowSpec[] = [
  {
    // THE MESSAGE IS THE ONLY ROUTE TO THE OLDEST STEP'S AGE. bin/verify-host.sh
    // measures max(now - created_at) over the suspended jobs and puts the hours
    // in this sentence while recording only the COUNT as a fact, so the age
    // exists nowhere else in this application. Displayed, never parsed.
    id: "agents.approvals_pending",
    name: "suspended steps",
    value: (m) => fmt.number(n(m?.approvals)),
    finding: null,
  },
  {
    id: "agents.worker_lanes",
    name: "worker lanes",
    value: (m) => fmt.number(n(m?.workerLanes)),
    finding: null,
  },
  {
    id: "agents.windmill_db_size",
    name: "windmill db",
    value: (m) => fmt.bytes(n(m?.windmillDb)),
    finding: (m) => {
      const b = n(m?.windmillDb);
      return Number.isFinite(b)
        ? `${fmt.percent(b / WINDMILL_DB_MAX)} of the ${fmt.bytes(WINDMILL_DB_MAX, 0)} budget`
        : "the database size was not read in the last run";
    },
  },
  {
    id: "agents.mirror_fresh",
    name: "mirror fetch",
    value: (m) => {
      const age = n(m?.mirrorAge);
      return Number.isFinite(age) ? `${fmt.coarse(age)} ago` : fmt.NO_DATA;
    },
    finding: () => "FETCH_HEAD's mtime dates the attempt, not the change",
  },
  {
    // IT NAMES /var/agents, AND THE TILE THIS REPLACED SAID /var/home-server.
    // agents.checkout_drift measures conduct's OWN checkout - its comment in
    // bin/verify-host.sh says "the same failure one directory over" - so the old
    // caption sent a reader to the wrong tree, and no fixture could see it
    // because the number is right either way.
    id: "agents.checkout_drift",
    name: "checkout",
    value: (m) => {
      const dirty = n(m?.checkoutDirty);
      if (!Number.isFinite(dirty)) return fmt.NO_DATA;
      return dirty > 0 ? `${fmt.number(dirty)} dirty` : "clean";
    },
    finding: () => "/var/agents, which is conduct's own code and not this checkout",
  },
  {
    id: "agents.publish_configured",
    name: "publish key",
    value: (m) => {
      const p = n(m?.publishConfigured);
      if (!Number.isFinite(p)) return fmt.NO_DATA;
      return p === 1 ? "configured" : "not configured";
    },
    finding: () => "a key file and a workspace row exist, which is not the same as unexpired",
  },
  {
    id: "agents.runners_leaked",
    name: "runners leaked",
    value: (m) => fmt.number(n(m?.leaked)),
    finding: () => "ephemeral containers past their ceiling, across both fleets",
  },
  { id: "agents.slice_limits", name: "slice limits", value: statusWord, finding: null },
  { id: "agents.runner_isolation", name: "runner isolation", value: statusWord, finding: null },
  { id: "agents.fleet_root_label", name: "fleet root label", value: statusWord, finding: null },
];

/** The ten ids, exported so a test can assert the set rather than the order. */
export const PRECONDITION_IDS: string[] = SPECS.map((s) => s.id);

/**
 * "10 facts, 3 not passing", off the SAME tone the dots are drawn from.
 *
 * DERIVED FROM THE ROW RATHER THAN RE-ASKED OF THE CHECKS, so the tally cannot
 * disagree with the rail beside it. checkTone maps pass to `ok` and nothing else
 * does, so `tone !== "ok"` is exactly FindingsPanel's `status !== "pass"` - with
 * an unmeasured row counted as not passing, which it is: absence is not a pass.
 */
export function preconditionTally(rows: PreconditionRow[]): {
  total: number;
  notPassing: number;
} {
  return { total: rows.length, notPassing: rows.filter((r) => r.tone !== "ok").length };
}

export function preconditionRows(
  m: MachineMetrics | null,
  byId: ReadonlyMap<string, Check>,
): PreconditionRow[] {
  return SPECS.map((spec) => {
    const check = byId.get(spec.id) ?? null;
    return {
      id: spec.id,
      name: spec.name,
      value: spec.value(m, check),
      // GREY IS NEVER GREEN. A check the battery did not run must not borrow the
      // colour of one that ran and passed, so absence is `off` and never `ok`.
      tone: check ? checkTone(check.status) : ("off" as Tone),
      finding: spec.finding
        ? spec.finding(m)
        : (check?.message ?? "not measured in the last run"),
    };
  });
}
