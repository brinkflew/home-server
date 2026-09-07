// =============================================================================
// The CI lanes, as /ci draws them
// -----------------------------------------------------------------------------
// THE FOURTH TIME THIS EXTRACTION HAS BEEN MADE, and the reason has not changed
// since quotaWindow: a computed in a .vue file is code fixtures/smoke.mjs
// structurally cannot call, and every decision below has a wrong answer that
// renders perfectly. src/machine.ts is the same repair for /agents/fleet, made
// hours earlier the same day, and one of the two decisions it lifted WAS wrong - the
// containment tone was hand-rolled and mapped a `fail` check to amber.
//
// THAT SAME TERNARY WAS ON THIS PAGE THE WHOLE TIME. CiPage.vue drew
// `c.check.status === 'pass' ? 'ok' : 'warn'` above a FindingsPanel carrying the
// identical three ids, so a containment FAILURE drew as a warning on the page
// somebody opens after CiContainmentLost has gone off - and ci.lane_headroom
// calls `bad` on an OOM kill, so it is reachable. checkTone() is called here and
// nowhere reimplemented.
//
// PURE, AND EVERY READING IS AN ARGUMENT. Nothing here touches a store, a clock
// or a poll; the page hands in what it has and gets back what to draw.
//
// ABSENCE IS THE FINDING, WHICH IS THIS PAGE'S WHOLE PREMISE. A lane carries
// io.home-server.ephemeral so both container sources skip it, it is
// `podman run --rm` so no unit fails, and it declares no health check so nothing
// reads unhealthy - docs/ci.md: "a wedged lane leaves no failed unit and no
// unhealthy container". The marker is the only witness, so `?? 0` anywhere in
// this file would report a lane nobody has ever run as a healthy idle one, on
// the only page it could be seen from.
// =============================================================================

import * as fmt from "@/format";
import { checkTone } from "@/health";
import type { Check, Tone } from "@/types";

/**
 * One lane as the rack has already derived it. Only the fields the decisions
 * below actually read - the table draws a dozen more.
 */
export interface LaneRow {
  lane: string;
  tone: Tone;
  state: string;
  /** undefined when the series is absent, which is NOT idle. */
  inFlight: number | undefined;
  /** NaN when the lane has never reported. */
  jobsToday: number;
}

export interface LeadReading {
  /** The headline, in --t-mono-xl. One per view. */
  text: string;
  tone: Tone;
  /** Motion is a measurement: it breathes only while a job genuinely runs. */
  live: boolean;
  sub: string;
}

/**
 * The tally, and it is the band's aside rather than a fourth condition.
 *
 * WORST LAST, so the sentence ends on the thing worth reading. Empty is "no
 * lanes" rather than "", because a band aside that renders nothing looks like a
 * band that forgot to say anything.
 */
export function laneTally(rows: LaneRow[]): string {
  const counts: Record<Tone, number> = { ok: 0, warn: 0, fail: 0, off: 0 };
  for (const l of rows) counts[l.tone] += 1;

  const parts: string[] = [];
  if (counts.ok) parts.push(`${counts.ok} healthy`);
  if (counts.warn) parts.push(`${counts.warn} degraded`);
  if (counts.fail) parts.push(`${counts.fail} failing`);
  if (counts.off) parts.push(`${counts.off} never started`);
  return parts.join(" / ") || "no lanes";
}

/**
 * Lanes the battery counts that the rack cannot draw.
 *
 * The rack is the union of the marker series, so a lane that has written NO
 * marker at all appears nowhere - and that is the worst outcome on the one page
 * this fleet is visible from. It is not hypothetical: a driver that never got
 * far enough to write one (a bad credential, a missing image - exit 4 and exit 5
 * in bin/github-runner.sh) is exactly that shape, and it is the lane most worth
 * seeing.
 *
 * `lanes_active + lanes_failed` is bin/verify-host.sh's own count from
 * `systemctl is-enabled`, so it sees a unit the collector's marker loop cannot.
 * NEITHER HALF MAY DEFAULT TO ZERO: both facts are written as "" on a host with
 * no lanes, which becomes null in status.json and is then dropped, so an absent
 * count read as 0 would turn every drawn lane into a phantom surplus.
 */
export function silentLanes(drawn: number, active: number, failed: number): number {
  if (!Number.isFinite(active) || !Number.isFinite(failed)) return 0;
  return Math.max(0, active + failed - drawn);
}

/**
 * The headline, and it is four sentences rather than one with a number in it.
 *
 * fmt.number(NaN) is "-", so the obvious spelling renders `- jobs today` on a
 * host the store has no sample for - a headline claiming a dash ran. Absence
 * gets its own sentence at the largest type on the page, which is this page's
 * organising rule applied where it costs most.
 *
 * THE THIRD AND FOURTH STATES ARE DIFFERENT FACTS. markerPresent === 0 is a host
 * with CI switched off, which every ci check reports as a NOTE rather than a
 * finding; a marker present with no counter behind it is a measurement that did
 * not happen. Collapsing them would tell somebody their lanes are fine when
 * nothing is looking, or that their host is broken when it simply has no CI.
 *
 * @param markerPresent 1, 0, or NaN when the series itself is absent
 */
export function laneLead(rows: LaneRow[], markerPresent: number): LeadReading {
  if (markerPresent === 0) {
    return {
      text: "CI is not enabled here",
      tone: "off",
      live: false,
      sub: "no lane has ever written a marker on this host",
    };
  }

  const counted = rows.filter((l) => Number.isFinite(l.jobsToday));
  const jobs = counted.reduce((sum, l) => sum + l.jobsToday, 0);

  if (!counted.length) {
    return {
      text: "not measured",
      tone: "off",
      live: false,
      sub: "no lane reported a job count in the last scrape",
    };
  }

  const text = `${fmt.number(jobs)} job${jobs === 1 ? "" : "s"} today`;
  const running = rows.filter((l) => l.inFlight === 1);
  const tail = running.length
    ? `${running.map((l) => `lane ${l.lane}`).join(", ")} running a job`
    : "nothing running";

  // THE TONE IS THE WORST LANE'S, not the counter's. A number of jobs is never
  // itself a fault; what makes this headline red is a lane that has stopped
  // saying anything, and the tally beside it says which.
  const worst: Tone = rows.some((l) => l.tone === "fail")
    ? "fail"
    : rows.some((l) => l.tone === "off")
      ? "off"
      : rows.some((l) => l.tone === "warn")
        ? "warn"
        : "ok";

  return { text, tone: worst, live: running.length > 0, sub: `${laneTally(rows)} - ${tail}` };
}

// --- the host side -----------------------------------------------------------

/**
 * The facts that are not per-lane, in the shape CiPage's fleet poll returns.
 *
 * NaN THROUGHOUT FOR THE NUMBERS, and `null` for the two strings. Every one of
 * these is written as "" by bin/verify-host.sh on a host with no lanes, which
 * becomes null in status.json; source_status then drops a null outright, so the
 * series is ABSENT rather than zero. `?? 0` on any of them is the same bug the
 * collector's own help text for job_in_flight spells out.
 */
export interface HostFacts {
  lanesActive: number;
  lanesFailed: number;
  versionAge: number;
  imageAge: number;
  toolcache: number;
  baselines: number;
  runsBytes: number;
  unlimited: number;
  networks: number;
  strays: number;
  /** github_runner_runtime_split. A STRING fact, so it mints no series at all. */
  runtimeSplit: string | null;
  /** github_runner_root_label. Likewise. */
  rootLabel: string | null;
}

export interface HostRow {
  /** The check id. The join, and the only thing to key on. */
  id: string;
  name: string;
  value: string;
  tone: Tone;
  finding: string;
}

interface RowSpec {
  id: string;
  name: string;
  value: (f: HostFacts | null) => string;
  /** null means the check's own message is the finding. */
  finding: string | null;
}

const n = (v: number | undefined): number => (v === undefined ? Number.NaN : v);

/**
 * NINE ROWS, AND THE FIVE THAT ARE MISSING ARE THE POINT.
 *
 * ci.heartbeat, ci.job_stuck, ci.lane_disk, ci.lane_headroom and ci.lane_store
 * are all cross-lane summaries of the table two bands up, where the same numbers
 * are drawn per lane with a bar behind them. Restating them here would be the
 * duplication this page was rewritten to remove - Containment reproducing
 * FindingsPanel's markup directly above a FindingsPanel - committed a second
 * time in a different shape. The battery's verdict on all fourteen is still one
 * panel down.
 *
 * NOT SORTED WORST-FIRST, which is what keeps this a different object from that
 * panel rather than the same table drawn twice: sorted by kind, the two split
 * the way Prometheus and status.json already do - THIS ONE CARRIES THE VALUE,
 * THAT ONE CARRIES THE PROSE - and the id is the join.
 *
 * EVERY ID IS A CHECK bin/verify-host.sh ACTUALLY EMITS. An id that does not
 * resolve renders grey and "not measured" silently and for ever, which is how
 * the agents page came to caption the wrong repository - so smoke.mjs asserts
 * this set against the battery itself rather than against a second list.
 */
const SPECS: RowSpec[] = [
  {
    id: "ci.lanes_alive",
    name: "lanes enabled",
    value: (f) => {
      const active = n(f?.lanesActive);
      const failed = n(f?.lanesFailed);
      if (!Number.isFinite(active)) return fmt.NO_DATA;
      const tail = Number.isFinite(failed) && failed > 0 ? `, ${fmt.number(failed)} failed` : "";
      return `${fmt.number(active)} active${tail}`;
    },
    finding: null,
  },
  {
    id: "ci.runner_version",
    name: "runner version",
    value: (f) => {
      const age = n(f?.versionAge);
      return Number.isFinite(age) ? `checked ${fmt.number(age)}d ago` : fmt.NO_DATA;
    },
    finding: "the stamp going stale is the finding, not a version behind upstream",
  },
  {
    id: "ci.image_fresh",
    name: "runner image",
    value: (f) => {
      const age = n(f?.imageAge);
      return Number.isFinite(age) ? `${fmt.number(age)}d old` : fmt.NO_DATA;
    },
    finding: null,
  },
  {
    id: "ci.toolcache_seed",
    name: "tool cache",
    value: (f) => {
      const stale = n(f?.toolcache);
      return Number.isFinite(stale) ? `${fmt.number(stale)} stale` : fmt.NO_DATA;
    },
    finding: null,
  },
  {
    id: "ci.artifact_store",
    name: "artifact store",
    value: (f) => {
      const b = n(f?.baselines);
      if (!Number.isFinite(b)) return fmt.NO_DATA;
      return `${fmt.number(b)} baseline${b === 1 ? "" : "s"}`;
    },
    finding: "zero baselines is a green pipeline enforcing nothing at all",
  },
  {
    // A STRING FACT, SO IT MINTS NO SERIES. source_status turns a string into a
    // metric only when the key ends _at, so this and the root label exist in
    // status.json and nowhere else - which is why this page renders its passing
    // checks rather than only its failing ones.
    id: "ci.runtime_dir",
    name: "runtime dir",
    value: (f) => (f?.runtimeSplit ? (f.runtimeSplit === "0" ? "one directory" : "split") : fmt.NO_DATA),
    finding: "the engine is asked, never the config file read back",
  },
  {
    id: "ci.slice_limits",
    name: "slice limits",
    value: (f) => {
      const u = n(f?.unlimited);
      if (!Number.isFinite(u)) return fmt.NO_DATA;
      return u > 0 ? `${fmt.number(u)} unlimited` : "bounded";
    },
    finding: null,
  },
  {
    id: "ci.runner_isolation",
    name: "runner isolation",
    value: (f) => {
      const nets = n(f?.networks);
      const strays = n(f?.strays);
      if (!Number.isFinite(nets)) return fmt.NO_DATA;
      const tail = Number.isFinite(strays) ? `, ${fmt.number(strays)} stray` : "";
      return `${fmt.number(nets)} network${nets === 1 ? "" : "s"}${tail}`;
    },
    finding: null,
  },
  {
    id: "ci.fleet_root_label",
    name: "fleet root label",
    value: (f) => f?.rootLabel ?? fmt.NO_DATA,
    finding: "what lets a lane read the tree it was given, and any restorecon undoes it",
  },
];

/** The nine ids, exported so a test can assert the set rather than the order. */
export const HOST_IDS: string[] = SPECS.map((s) => s.id);

/**
 * "9 facts, 3 not passing", off the SAME tone the rail is drawn from.
 *
 * DERIVED FROM THE ROW RATHER THAN RE-ASKED OF THE CHECKS, so the tally cannot
 * disagree with the rail beside it. checkTone maps pass to `ok` and nothing else
 * does, so `tone !== "ok"` counts an unmeasured row as not passing - which it
 * is: absence is not a pass.
 */
export function hostTally(rows: HostRow[]): { total: number; notPassing: number } {
  return { total: rows.length, notPassing: rows.filter((r) => r.tone !== "ok").length };
}

export function hostRows(f: HostFacts | null, byId: ReadonlyMap<string, Check>): HostRow[] {
  return SPECS.map((spec) => {
    const check = byId.get(spec.id) ?? null;
    return {
      id: spec.id,
      name: spec.name,
      value: spec.value(f),
      // GREY IS NEVER GREEN, and this is the call that was hand-rolled on this
      // page too. checkTone is the one mapping: `note` is grey, not
      // amber, and `fail` is red rather than the warning the old ternary drew.
      tone: check ? checkTone(check.status) : ("off" as Tone),
      finding: spec.finding ?? check?.message ?? "not measured in the last run",
    };
  });
}
