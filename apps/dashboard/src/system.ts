// =============================================================================
// The host, as /system draws it
// -----------------------------------------------------------------------------
// THE FIFTH TIME THIS EXTRACTION HAS BEEN MADE, and /system is the last page
// that had none of it. roundboard.ts, control.ts, machine.ts and lanes.ts all
// exist for one reason: a computed in a .vue file is code fixtures/smoke.mjs
// structurally cannot call, and every one of them turned up a decision that had
// a wrong answer rendering perfectly. This page had seventeen computeds and
// eight functions in the SFC, and it turned up FOUR.
//
//   1. `fsTone` returned "ok" for a ratio that is not a number, so a mount
//      whose size or avail series is missing drew a TEAL bar at an unreadable
//      fill. tokens.css states the rule in capitals - "GREY IS NEVER GREEN: no
//      health check defined, no history, a check that did not run" - and this
//      was the exact case it names.
//   2. `smartLine` read `healthy: health.get(device) === 1`, so a drive present
//      in home_server_disk_info but absent from home_server_disk_health_ok
//      collapsed into `false` and fired the first branch: "SMART reports the
//      drive as failing", in RED, at the loudest tone on the page. Absence read
//      as a fault in one function four lines after it read as health in the
//      other, and `backupTone` between them had the right answer all along.
//   3. `LANES` hardcoded `tone: "warn"` on both pressure lanes, so they were
//      drawn amber at every value on a perfectly healthy host. That is
//      LANE_TONES on /ci - fixed one page over in 7c75382 the day before this -
//      and CLAUDE.md's own entry on it says why it survived: "Fixing one
//      instance of a call-site defect is not evidence about the others."
//   4. `staged_version` is not a fact this host emits. See FACT_KEYS.
//
// PURE, AND EVERY READING IS AN ARGUMENT. Nothing here touches a store, a clock
// or a poll; the page hands in what it has and gets back what to draw.
//
// ABSENCE IS `off` AND IT IS NEVER A NUMBER. NaN for a number and null for a
// string throughout, so nothing here can report an unmeasured host as an idle
// one - which is the shape of all four defects above.
// =============================================================================

import * as fmt from "@/format";
import type { AmAlert, Tone } from "@/types";
import type { ChartSeries, Point } from "@/charts";

/** NaN rather than 0 for an absent gauge, everywhere below. */
const n = (v: number | undefined): number => (v === undefined ? Number.NaN : v);

// -----------------------------------------------------------------------------
// The facts, and the one that was not being read
// -----------------------------------------------------------------------------

export interface BackupSpec {
  label: string;
  key: string;
  /** Seconds after which the copy is stale enough to fail. */
  limit: number;
}

/**
 * The four copies, in the order the backup story is told rather than by age.
 * Emitted by bin/verify-host.sh's `check_backup_age`, which builds the key as
 * `fact "backup_$key"` - see the note on FACT_KEYS.
 */
export const BACKUPS: BackupSpec[] = [
  { label: "local", key: "backup_local_at", limit: 48 * 3600 },
  { label: "off-site", key: "backup_offsite_at", limit: 72 * 3600 },
  { label: "policy proof", key: "backup_offsite_policy_ok_at", limit: 48 * 3600 },
  { label: "off-site prune", key: "backup_offsite_pruned_at", limit: 30 * 86400 },
];

/**
 * EVERY status.json FACT KEY THIS PAGE READS, SO A TEST CAN ASSERT THEM AGAINST
 * THE BATTERY THAT WRITES THEM.
 *
 * This exists because one of them had drifted and nothing could see it. The page
 * read `staged_version`; bin/verify-host.sh emits `next_version`, and its own
 * comment at the rename says which reader it was talking to - "the old name was
 * only ever right for half of the states it was read in. A consumer keying on
 * staged_version wants this." Nobody updated the consumer.
 *
 * IT RENDERED PERFECTLY IN DEV FOR THE WHOLE TIME. fixtures/model.ts emitted
 * `staged_version`, because the fixture was written from the consumer rather
 * than from the producer - so a fixture cannot contradict the code it was
 * copied from, and the amber "staged" chip appeared in every screenshot ever
 * taken while never once appearing on the machine it describes. On the live
 * host, on the day this was written: next_version 44.20260817.3.2, and
 * staged_version null.
 *
 * `next_version`, NOT `staged_version`, AND THE KEY NAMES WHY: it is the
 * deployment that boots next, which is true whether it was staged, pinned or
 * rolled back to.
 */
export const FACT_KEYS: string[] = [
  "booted_version",
  "next_version",
  "next_finalized",
  "uptime_s",
  ...BACKUPS.map((b) => b.key),
];

export interface HostReading {
  /** NaN when the battery has not written one. */
  uptimeS: number;
  booted: string | null;
  /** The deployment that boots next, or null when this one does. */
  next: string | null;
  nextFinalized: string | null;
}

/**
 * The provenance line, in the band's aside rather than the shell toolbar.
 *
 * It was `uCore <booted> / up <duration>` in a span capped at 210px, so the live
 * string clipped to "uCore 44.2026..." and the uptime was never on screen at
 * all. The uptime is the headline now, so this says only what is running.
 */
export function osLine(r: HostReading | null): string {
  const booted = r?.booted;
  return booted ? `uCore ${booted}` : "host unknown";
}

// -----------------------------------------------------------------------------
// The three conditions
// -----------------------------------------------------------------------------

export interface SystemMetrics {
  /** 0..1, the busy fraction across all cores. */
  cpuBusy: number;
  /** 0..1, the share of time at least one task was stalled waiting for a core. */
  cpuStalled: number;
  /** Runnable plus uninterruptible, one-minute average. */
  load1: number;
  memUsed: number;
  memTotal: number;
  swapUsed: number;
  swapTotal: number;
  /** The fullest mount, which is the only one a headline can be about. */
  fullest: { mountpoint: string; ratio: number; free: number } | null;
  mounts: number;
}

export interface ConditionRow {
  id: "cpu" | "memory" | "storage";
  label: string;
  value: string;
  sub: string;
  tone: Tone;
}

/** The set, so a test asserts membership rather than order. */
export const CONDITION_IDS: ConditionRow["id"][] = ["cpu", "memory", "storage"];

/**
 * PRESSURE, NOT UTILISATION, IS THE CPU FAULT ON THIS HOST, and the sub-line
 * names it so the tone has a visible source.
 *
 * queries.ts says why: pressure "is the number that was pinned when the host
 * wedged under 470 queued health checks while still answering ICMP - utilisation
 * looked survivable and pressure did not". And a single pinned core is NOT a
 * fault here - CLAUDE.md records that both long jobs on the CI critical path are
 * single-threaded - so grading on the busiest thread would draw amber on a
 * machine doing exactly what it is for.
 */
export function pressureTone(ratio: number): Tone {
  if (!Number.isFinite(ratio)) return "off";
  if (ratio >= 0.3) return "fail";
  if (ratio >= 0.1) return "warn";
  return "ok";
}

/**
 * A FILESYSTEM THAT COULD NOT BE MEASURED IS GREY, NOT GREEN.
 *
 * This returned "ok" for a non-finite ratio, which is a mount whose
 * node_filesystem_size_bytes or _avail_bytes did not come back: it drew a teal
 * bar at a NaN width, so an unreadable mount was a healthy empty one.
 */
export function fsTone(ratio: number): Tone {
  if (!Number.isFinite(ratio)) return "off";
  if (ratio >= 0.95) return "fail";
  if (ratio >= 0.85) return "warn";
  return "ok";
}

/** 85% of MemAvailable-based usage, which is genuinely tight - this is not
 *  MemTotal - MemFree, which reads 88% on a healthy Linux host. */
export function memoryTone(used: number, total: number): Tone {
  if (!Number.isFinite(used) || !Number.isFinite(total) || total <= 0) return "off";
  const ratio = used / total;
  if (ratio >= 0.95) return "fail";
  if (ratio >= 0.85) return "warn";
  return "ok";
}

export function conditionRows(m: SystemMetrics | null): ConditionRow[] {
  const cpuStalled = n(m?.cpuStalled);
  const memUsed = n(m?.memUsed);
  const memTotal = n(m?.memTotal);
  const swapTotal = n(m?.swapTotal);
  const fullest = m?.fullest ?? null;

  const swapSub =
    Number.isFinite(swapTotal) && swapTotal > 0
      ? `swap ${fmt.bytes(n(m?.swapUsed))} of ${fmt.bytes(swapTotal)}`
      : "no swap device";

  return [
    {
      id: "cpu",
      label: "cpu",
      value: `${fmt.percent(n(m?.cpuBusy), 1)} busy`,
      sub: `load ${fmt.number(n(m?.load1), 2)}, ${fmt.percent(cpuStalled, 1)} stalled`,
      tone: pressureTone(cpuStalled),
    },
    {
      id: "memory",
      label: "memory",
      value: `${fmt.bytes(memUsed)} of ${fmt.bytes(memTotal)}`,
      sub: swapSub,
      tone: memoryTone(memUsed, memTotal),
    },
    {
      id: "storage",
      // `disk`, NOT `storage`, AND THE ID DOES NOT MOVE WITH IT. This sits one
      // rung under a sub-nav whose third segment is Storage, and a column that
      // announces itself with the name of the view beside it reads as a link to
      // it - the rule docs/dashboard.md states for the Fleet band. The id is the
      // stable half and the label is the presentation one.
      label: "disk",
      // The mountpoint is in the value rather than the label, because WHICH
      // mount is full is half the reading and the label is a fixed word.
      value: fullest ? `${fmt.percent(fullest.ratio, 0)} ${fullest.mountpoint}` : fmt.NO_DATA,
      sub: fullest
        ? `${fmt.bytes(fullest.free)} free, ${m?.mounts ?? 0} mounts`
        : "no filesystem reported",
      tone: fsTone(fullest ? fullest.ratio : Number.NaN),
    },
  ];
}

// -----------------------------------------------------------------------------
// The headline
// -----------------------------------------------------------------------------

export interface LeadReading {
  /** The headline, in --t-mono-xl. One per view. */
  text: string;
  tone: Tone;
  live: boolean;
  sub: string;
}

/**
 * WORST CONDITION FIRST, AND amber OUTRANKS grey HERE - which is the opposite
 * of /ci and for a stated reason. There, absence IS the finding: a lane that
 * stopped writing its marker is invisible to every other reader on the host. A
 * condition that did not resolve here means Prometheus did not answer, and
 * StalenessBanner already says so across the whole application at a size this
 * cannot compete with. A real warning is the more useful headline.
 */
const RANK: Record<Tone, number> = { fail: 3, warn: 2, off: 1, ok: 0 };

function worst(rows: ConditionRow[]): Tone {
  let out: Tone = "ok";
  for (const r of rows) if (RANK[r.tone] > RANK[out]) out = r.tone;
  return out;
}

/**
 * FOUR STATES, AND THE LAST TWO ARE WHY THIS IS A FUNCTION.
 *
 * `fmt.duration(NaN)` is "-", so the obvious spelling renders "up -" at the
 * largest type on the page: a headline claiming a dash was measured. Absence
 * gets its own sentence, and the two kinds of absence are different facts - a
 * host whose battery has never run has no facts at all, where one whose uptime
 * fact is missing has the rest of them.
 *
 * THE TONE IS THE WORST CONDITION'S, NEVER THE NUMBER'S. A count of days is not
 * itself a fault and a full disk is - /ci's rule, and the reason its headline
 * takes the worst lane's tone rather than the counter's.
 *
 * NO ProgressBar AND NO `live`. There is no denominator for uptime, and a bare
 * track is what this store reserves for "in progress, ratio unknown".
 */
export function hostLead(r: HostReading | null, conds: ConditionRow[]): LeadReading {
  if (r === null) {
    return {
      text: "host unknown",
      tone: "off",
      live: false,
      sub: "status.json carries no facts for this machine",
    };
  }

  if (!Number.isFinite(r.uptimeS)) {
    return {
      text: "uptime not measured",
      tone: "off",
      live: false,
      sub: r.booted ? `running uCore ${r.booted}` : "and no booted version either",
    };
  }

  // `next_finalized` is the discriminator the old key could not express: a
  // deployment that is staged but not finalized has not written its loader
  // entry yet, so it is queued rather than armed.
  const staged = r.next
    ? r.nextFinalized
      ? `${r.next} staged and finalized, the Sunday window applies it`
      : `${r.next} staged, not finalized yet`
    : r.booted
      ? `${r.booted}, nothing staged`
      : "nothing staged";

  return { text: `up ${fmt.duration(r.uptimeS)}`, tone: worst(conds), live: false, sub: staged };
}

// -----------------------------------------------------------------------------
// The pressure lanes
// -----------------------------------------------------------------------------

export interface LaneSpec {
  key: string;
  label: string;
  sub: string;
  format: (v: number) => string;
  /** Pin the frame. All three are a fraction of wall-clock time. */
  yMax: number;
  grade: (v: number) => Tone;
}

/**
 * HUE IS STATUS HERE TOO, AND THESE THREE USED TO CARRY IT AS IDENTITY.
 *
 * Both pressure lanes were `tone: "warn"` as a literal, so they were drawn amber
 * at every value including zero, and their readings were coloured amber with
 * them. That is LANE_TONES on /ci, fixed one page over the day before this one,
 * and it survived here because fixing one instance of a call-site defect is not
 * evidence about the others.
 *
 * A SATURATED ENCODER IS NOT A FAULT AND A STALLED CPU IS, which is why the GPU
 * lane grades differently from the two beside it. CLAUDE.md: two NVENC sessions
 * already pin the encoder block at 100% by design, so amber there would fire on
 * the machine doing exactly the job it exists for. Absence is grey in all three.
 */
export const LANES: LaneSpec[] = [
  {
    key: "gpu",
    label: "GPU encoder",
    sub: "NVENC block, per card",
    format: (v) => fmt.percent(v, 0),
    yMax: 1,
    grade: (v) => (Number.isFinite(v) ? "ok" : "off"),
  },
  {
    key: "iopsi",
    label: "IO pressure",
    sub: "time fully stalled on IO",
    format: (v) => fmt.percent(v, 1),
    yMax: 1,
    grade: pressureTone,
  },
  {
    key: "cpupsi",
    label: "CPU pressure",
    sub: "time waiting for a core",
    format: (v) => fmt.percent(v, 1),
    yMax: 1,
    grade: pressureTone,
  },
];

/** Every card, joined - the GPU lane is two lines and one of them is always 0%
 *  on this host, so collapsing to the first would answer for the idle card. */
export function laneReading(lane: LaneSpec, values: number[]): string {
  if (!values.length) return fmt.NO_DATA;
  return values.map((v) => lane.format(v)).join(" / ");
}

/** The worst card's tone, so one saturated GPU is not averaged away by the
 *  dead one beside it. */
export function laneTone(lane: LaneSpec, values: number[]): Tone {
  if (!values.length) return "off";
  let out: Tone = "ok";
  for (const v of values) {
    const t = lane.grade(v);
    if (RANK[t] > RANK[out]) out = t;
  }
  return out;
}

/** The busiest single thread. The whole reason to draw twelve lines: one core at
 *  100% is 8% of the aggregate and looks like an idle machine. */
export function busiestCore(values: number[]): number {
  const finite = values.filter(Number.isFinite);
  return finite.length ? Math.max(...finite) : Number.NaN;
}

/**
 * /system/load's headline: how hard the machine is working.
 *
 * THE READING IS THE AGGREGATE AND THE TONE IS NOT. CPU busy is the number a
 * person means by "how hard is it working", but it is the wrong thing to grade:
 * the encoder can sit at 100% while the aggregate reads 12%, and IO pressure -
 * the number that was actually pinned when this host wedged - moves
 * independently of both. So the reading comes from one series and the tone from
 * the worst of everything the view draws, which is hostLead's rule one page
 * over: a count is not itself a fault.
 *
 * `fmt.percent(NaN)` is "-", so an unanswered window would otherwise headline
 * "- busy" - the same trap `up -` was.
 */
export function loadLead(
  m: SystemMetrics | null,
  coreCount: number,
  busiest: number,
  laneTones: Tone[],
): LeadReading {
  const busy = n(m?.cpuBusy);
  if (m === null || !Number.isFinite(busy)) {
    return {
      text: "load not measured",
      tone: "off",
      live: false,
      sub: "prometheus returned no CPU series for this window",
    };
  }

  let tone = conditionRows(m).find((c) => c.id === "cpu")?.tone ?? "ok";
  for (const t of laneTones) if (RANK[t] > RANK[tone]) tone = t;

  const threads = coreCount > 0 ? `${coreCount} threads` : "thread count unknown";
  const peak = Number.isFinite(busiest) ? `busiest ${fmt.percent(busiest, 0)}` : "busiest thread unknown";
  const load = Number.isFinite(n(m.load1)) ? `load ${fmt.number(m.load1, 2)}` : "load unknown";

  return { text: `${fmt.percent(busy, 1)} busy`, tone, live: false, sub: `${threads}, ${peak}, ${load}` };
}

// -----------------------------------------------------------------------------
// Alerts on the shared axis
// -----------------------------------------------------------------------------

export interface EventMark {
  key: string;
  left: string;
  tone: Tone;
  before: boolean;
}

/**
 * Where each active alert began, as a percentage across the same window every
 * chart on the page is drawn on.
 *
 * PINNED TO THE LEFT EDGE RATHER THAN DROPPED when it started before the window:
 * "has been firing since before this view" is worth seeing, and a mark that
 * disappears when you widen the window would say the opposite.
 */
export function eventMarks(alerts: AmAlert[], start: number, end: number): EventMark[] {
  if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) return [];
  return alerts.map((a) => {
    const t = Date.parse(a.startsAt) / 1000;
    const ratio = Math.min(1, Math.max(0, (t - start) / (end - start)));
    return {
      key: a.fingerprint ?? a.labels.alertname,
      left: `${(ratio * 100).toFixed(2)}%`,
      tone: a.labels.severity === "critical" ? "fail" : "warn",
      before: t < start,
    };
  });
}

// -----------------------------------------------------------------------------
// Drives, mounts and backups
// -----------------------------------------------------------------------------

export interface Drive {
  device: string;
  model: string;
  /** null when no home_server_disk_health_ok series came back for this device,
   *  which is NOT the same fact as the drive reporting itself unhealthy. */
  healthy: boolean | null;
  temp: number;
  hours: number;
  wear: number;
  realloc: number;
  pending: number;
  mediaErrors: number;
}

/**
 * SMART in one line per drive: the thing that changed, or that nothing has.
 *
 * THE FIRST BRANCH IS NEW AND IT IS THE BUG. `healthy` was a boolean built as
 * `health.get(device) === 1`, so a drive enumerated by home_server_disk_info but
 * carrying no home_server_disk_health_ok series read `false` and fell into "SMART
 * reports the drive as failing" - absence drawn as a failure, in red, at the
 * loudest tone on the page. It is reachable: smartctl can name a model without
 * returning a health verdict.
 *
 * MEDIA ERRORS ARE THE NVMe COUNTER AND WERE NEVER READ. Reallocated and pending
 * sectors are ATA concepts, so the old fallback sentence - "no reallocated or
 * pending sectors" - was true and silent about the one number that matters on
 * an NVMe. home_server_disk_media_errors_total was collected and drawn nowhere.
 */
export function smartLine(d: Drive): { text: string; tone: Tone } {
  if (d.healthy === null) {
    return { text: "no SMART health reported for this device", tone: "off" };
  }
  if (!d.healthy) return { text: "SMART reports the drive as failing", tone: "fail" };
  if (Number.isFinite(d.pending) && d.pending > 0) {
    return { text: `${d.pending} pending sector(s)`, tone: "fail" };
  }
  if (Number.isFinite(d.mediaErrors) && d.mediaErrors > 0) {
    return { text: `${d.mediaErrors} media error(s)`, tone: "fail" };
  }
  if (Number.isFinite(d.realloc) && d.realloc > 0) {
    return { text: `${d.realloc} reallocated sector(s)`, tone: "warn" };
  }
  if (Number.isFinite(d.wear)) {
    return { text: `${fmt.percent(d.wear, 0)} of rated write endurance used`, tone: "ok" };
  }
  return { text: "no reallocated, pending or media errors", tone: "ok" };
}

/** Grey when the fact has never been written, which is a host that has not run
 *  the job rather than one whose copy is old. */
export function backupTone(age: number, limit: number): Tone {
  if (!Number.isFinite(age)) return "off";
  return age > limit ? "fail" : age > limit * 0.75 ? "warn" : "ok";
}

// -----------------------------------------------------------------------------
// /system/storage's headline
// -----------------------------------------------------------------------------

export interface MountReading {
  mountpoint: string;
  total: number;
  free: number;
  /** Used share, 0..1. Not a number where either half of it did not come back. */
  ratio: number;
}

/**
 * One mount's arithmetic, in one place because two views now do it.
 *
 * `ratio` MUST STAY NON-FINITE WHERE EITHER HALF IS. `1 - NaN/x` is NaN and
 * `1 - x/0` is -Infinity, and both must reach `fsTone` as "not a number" rather
 * than as 0 - an unreadable mount drawn as an empty one is the defect that
 * function was rewritten for.
 */
export function mountReading(mountpoint: string, total: number, free: number): MountReading {
  return { mountpoint, total, free, ratio: total > 0 ? 1 - free / total : Number.NaN };
}

/**
 * The fullest mount, which is the only one a single reading can be about.
 *
 * A NON-FINITE RATIO MUST NOT WIN THE COMPARISON and then be reported as full:
 * `NaN > x` is false, so a plain reduce happens to survive it, but only by
 * accident of which operand lands on the left. The filter states it instead.
 */
export function fullestMount(mounts: MountReading[]): MountReading | null {
  const rated = mounts.filter((m) => Number.isFinite(m.ratio));
  return rated.length ? rated.reduce((a, b) => (b.ratio > a.ratio ? b : a)) : null;
}

/**
 * THE ORDER OF THE /var STACK, DECLARED ONCE.
 *
 * FIXED, NEVER QUERY ORDER, and that is the whole reason this exists.
 * MetricChart keys its brightness ramp on the BAND index - its own docblock says
 * so - so a stack ordered by whatever Prometheus happened to return reshuffles
 * every colour on the day a group appears or vanishes. A group with no data is
 * simply absent from the drawing; the order of the ones that remain does not
 * move.
 *
 * Largest first, so the big committed consumers sit at the bottom of the stack
 * where a reader looks for them, and the small ones do not vanish into a hairline
 * between two giants.
 */
export const VAR_GROUPS: { key: string; label: string }[] = [
  { key: "ci", label: "CI" },
  { key: "podman", label: "images" },
  { key: "backups", label: "backups" },
  { key: "config", label: "config" },
  { key: "conduct", label: "fleet" },
  { key: "log", label: "logs" },
  { key: "cache", label: "cache" },
  { key: "checkout", label: "checkout" },
  { key: "other", label: "other" },
];

/**
 * The /var breakdown as stack bands, in declared order.
 *
 * A GROUP THE SPEC DOES NOT KNOW IS NOT DROPPED - it is folded into `other`.
 * A stack pinned to the filesystem's size claims its bands add up to the whole
 * disk, so silently discarding one would make every share on the chart wrong
 * while it still looked right. The census already guarantees the sum: its named
 * consumers add to df's used figure by construction, and whatever no consumer
 * claims is published as other_unaccounted rather than left out.
 *
 * `free` is appended last so the bands sum to the VOLUME rather than to what is
 * used - the same property LoadPage's memory stack has against MemTotal, and the
 * only thing that makes pinning yMax honest.
 */
export function varStack(
  byGroup: Map<string, Point[]>,
  free: Point[],
): ChartSeries[] {
  const known = new Set(VAR_GROUPS.map((g) => g.key));
  const out: ChartSeries[] = [];
  for (const g of VAR_GROUPS) {
    const points = byGroup.get(g.key);
    if (points && points.length) out.push({ points, label: g.label, tone: "ok" });
  }
  // Anything the spec has not heard of, summed into one band rather than lost.
  const strays: Point[][] = [];
  for (const [key, points] of byGroup) if (!known.has(key)) strays.push(points);
  if (strays.length) {
    const merged: Point[] = strays[0].map((p, i) => [
      p[0],
      strays.reduce((sum, s) => sum + (s[i]?.[1] ?? 0), 0),
    ]);
    out.push({ points: merged, label: "unnamed", tone: "ok" });
  }
  if (free.length) out.push({ points: free, label: "free", tone: "ok" });
  return out;
}

/**
 * One row of the commitment table: what a consumer holds against what it is
 * entitled to take.
 *
 * AN UNCAPPED CONSUMER IS GREY, NOT GREEN. It has no ceiling to be inside of, so
 * reporting it as healthy is the same defect as `fsTone` drawing an unmeasurable
 * mount teal - which is the rule one screen up in this file, written before this
 * function existed. The tone is decided here and never in a .vue file: a
 * hardcoded ternary at a call site is a defect this repository has now recorded
 * three separate times.
 */
export function commitmentRow(
  now: number,
  ceiling: number,
): { headroom: number; ratio: number; tone: Tone } {
  if (!Number.isFinite(ceiling) || ceiling <= 0) {
    return { headroom: Number.NaN, ratio: Number.NaN, tone: "off" };
  }
  const ratio = now / ceiling;
  return {
    headroom: ceiling - now,
    ratio,
    tone: ratio >= 0.95 ? "fail" : ratio >= 0.85 ? "warn" : "ok",
  };
}

/**
 * THE READING IS THE FULLEST MOUNT AND THE TONE IS EVERYTHING ON THE VIEW.
 *
 * A half-empty disk whose SMART says it is failing must not headline teal, and
 * a backup that stopped running three days ago is the same kind of fact about
 * the same data - so all three grade the one headline. This is hostLead's rule
 * and loadLead's: the reading names one number, the tone answers for the view.
 *
 * Two absences, and they are different facts. No mount came back at all means
 * Prometheus did not answer; mounts that came back with no readable ratio means
 * it did and the numbers were unusable. Neither is an empty disk.
 */
export function storageLead(
  mounts: MountReading[],
  drives: Drive[],
  backupTones: Tone[],
): LeadReading {
  const full = fullestMount(mounts);

  let tone: Tone = full ? fsTone(full.ratio) : "off";
  for (const d of drives) {
    const t = smartLine(d).tone;
    if (RANK[t] > RANK[tone]) tone = t;
  }
  for (const t of backupTones) if (RANK[t] > RANK[tone]) tone = t;

  if (full === null) {
    return {
      text: mounts.length ? "storage not measured" : "no filesystem reported",
      tone: "off",
      live: false,
      sub: mounts.length
        ? `${mounts.length} mount${mounts.length === 1 ? "" : "s"} answered, none with a readable size and free pair`
        : "prometheus returned no node_filesystem_size_bytes series",
    };
  }

  // "3 drive(s)" in a headline sub-line is a placeholder that shipped. The two
  // words are cheap and one of them is always right.
  const drivesSub =
    drives.length === 0
      ? "no drive reported"
      : `${drives.length} drive${drives.length === 1 ? "" : "s"}`;

  return {
    text: `${fmt.percent(full.ratio, 0)} ${full.mountpoint}`,
    tone,
    live: false,
    sub: `${fmt.bytes(full.free)} free of ${fmt.bytes(full.total)}, ${mounts.length} mounts, ${drivesSub}`,
  };
}
