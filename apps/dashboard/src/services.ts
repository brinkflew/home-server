// =============================================================================
// The services, as /services draws them
// -----------------------------------------------------------------------------
// THE PAGE WAS STRUCTURALLY UNABLE TO SHOW A SERVICE THAT WAS DOWN, and that is
// what this module was extracted to fix rather than to tidy.
//
// Every row came from home_server_container_info, which the collector builds
// from `podman ps` - and `podman ps` lists RUNNING containers. So
// home_server_container_running is 1 for all 28 rows on this host and can be
// nothing else, containerTone's `stopped` branch was unreachable in production,
// and a service that stopped did not turn red on the rack: it disappeared from
// it. CLAUDE.md has the outage in those words - "Caddy was down for 35 minutes
// and three checks looked straight at it: a dependency failure is `inactive`,
// not `failed`, and a container that never started is absent rather than
// unhealthy."
//
// source_units already knew. It enumerates the quadlet generator directory
// precisely so that "deriving the unit list from running containers would make
// this source blindest at the moment it matters most" - and no page in this
// application had ever read home_server_unit_state at all. THE RACK IS BUILT
// FROM THE UNITS NOW, and a container is joined onto one. A unit with no
// container is a row that says so.
//
// PURE, AND EVERY READING IS AN ARGUMENT. Nothing here touches a store, a clock
// or a poll; the page hands in what it has and gets back what to draw. That is
// src/machine.ts' and src/lanes.ts' rule, for the reason both of them state: a
// computed inside a .vue file is code fixtures/smoke.mjs structurally cannot
// call, and every decision below has a wrong answer that renders perfectly.
//
// src/health.ts IS STILL WHERE A HEALTH READING BECOMES A COLOUR. containerTone
// is CALLED here and nowhere reimplemented - it owns the subtlest rule in the
// application ("absent is not zero", so an unchecked container is grey and never
// green) and the Home page's strip reads the identical mapping.
//
// EVERY REMEDY IS A READ. This dashboard cannot restart a unit - the podman
// socket is SELinux-denied from container_t - and that is not the only reason:
// a command that changes the host is a decision for the person holding the
// keyboard, not a string a panel prints. So `remedy` is always a `status` or a
// `journalctl`, which is what CLAUDE.md's own command list opens with.
// =============================================================================

import * as fmt from "@/format";
import { containerTone } from "@/health";
import type { AppKey } from "@/links";
import { STRIP_SERVICES } from "@/media";
import { nodeByName } from "@/topology";
import type { Tone } from "@/types";

/** fail beats warn beats off beats ok, which is /system's ranking. */
const RANK: Record<Tone, number> = { fail: 3, warn: 2, off: 1, ok: 0 };

function worst(a: Tone, b: Tone): Tone {
  return RANK[b] > RANK[a] ? b : a;
}

/**
 * systemd's ActiveState, as source_units encodes it. 9 is the collector's
 * "unrecognised", which is a real anomaly rather than an absence: systemd
 * answered with a word the collector's map does not know.
 */
export const UNIT_STATE: Record<number, string> = {
  0: "active",
  1: "activating",
  2: "failed",
  3: "deactivating",
  4: "inactive",
  5: "reloading",
  9: "unrecognised",
};

export interface UnitReading {
  /** e.g. "sonarr.service". The identity everything here joins on. */
  unit: string;
  /** "container" or "pod". The query filters the oneshots out. */
  kind: string;
  state: number;
  /** systemd's NRestarts - the counter that survives a restart loop. */
  restarts: number;
}

export interface ContainerReading {
  name: string;
  unit: string;
  image: string;
  running: boolean;
  /** undefined when the container defines no health check at all. */
  health: number | undefined;
  /** podman's own count, which is a DIFFERENT question - see restartLine(). */
  podmanRestarts: number;
  cpu: number;
  memory: number;
  memoryHigh: number;
  /** MemoryMax, the hard limit - a different number from the watermark above,
   *  and the one nothing on this page read until 2026-09-08. */
  memoryLimit: number;
  /** Pages faulted back in after being reclaimed. CORROBORATION, NOT A SIGNAL:
   *  it counts re-reads of file pages evicted at ANY time, global reclaim
   *  included, so on a 15.8 GB host serving a 7.3 TB library it is ordinary
   *  file I/O and is non-zero on cgroups doing no reclaim of their own. */
  refault: number;
  /** PSI `some`: the fraction of wall time at least one task in this cgroup was
   *  delayed on memory. THE ARBITER - see memoryTone(). */
  stallSome: number;
  /** PSI `full`: the fraction of wall time EVERY runnable task was delayed. */
  stallFull: number;
  oomKills: number;
  uptime: number;
  activity: number[];
}

export interface ServiceRow {
  /** The container's name where there is one, the unit's stem otherwise. A row
   *  with no container still needs something to call itself. */
  name: string;
  unit: string;
  kind: string;
  /** Whether a container exists at all. False is the case the rack could not
   *  previously draw. */
  present: boolean;
  image: string;
  role: string;
  networks: string[];
  /** The pod this container belongs to, from topology - NOT from the metric.
   *  See topologyFor(). */
  pod: string;
  /** The application this container serves, where it has a web UI to open. */
  app: AppKey | null;
  running: boolean;
  health: number | undefined;
  unitState: number;
  unitRestarts: number;
  podmanRestarts: number;
  cpu: number;
  memory: number;
  memoryHigh: number;
  /** MemoryMax, the hard limit. Every unit here sits 33-50% below its watermark
   *  again at the ceiling, and the page could not say so until 2026-09-08. */
  memoryLimit: number;
  refault: number;
  stallSome: number;
  stallFull: number;
  oomKills: number;
  uptime: number;
  activity: number[];
  /** The row's LED: the worst of its liveness and its memory. */
  tone: Tone;
  /** The state word, e.g. "healthy", "unit failed", "no container". */
  state: string;
  /** One sentence, or null when nothing is wrong. */
  issue: string | null;
  /** A command to run on the server. Always a read. */
  remedy: string | null;
  /** Memory has its own tone because being AT MemoryHigh is not news. */
  memoryTone: Tone;
}

/**
 * THE POD'S CONTAINER IS NOT CALLED WHAT THE TOPOLOGY CALLS IT, and joining on
 * the name alone silently loses the row's role, its segment and its pod.
 *
 * podman names a pod's infra container `<pod>-infra`, so this host's is
 * `torrent-infra` while src/topology.ts declares the node as `torrent` - which
 * is right, because bin/lint-repo.sh compares that file against `PodName=` in
 * stacks/. docs/dashboard.md records the same asymmetry from the network
 * collector's side and the bridge it found: the `unit` label. `torrent-infra`
 * carries `torrent-pod.service`, so the pod's name is in the unit and nowhere
 * else.
 *
 * IT IS NOT IN THE `pod` LABEL, WHICH IS EMPTY FOR EVERY CONTAINER ON THIS
 * HOST. The collector reads podman's `PodName` field and this podman fills
 * `Pod` (an id) instead, so `home_server_container_info{pod}` has always been
 * "" in production - which made the rack's `pod {{ row.pod }}` branch dead
 * code for as long as it existed, perfect in the fixtures and absent on the
 * server. Every consumer here takes the pod from topology instead.
 */
export function topologyFor(container: string, unit: string) {
  const direct = nodeByName(container);
  if (direct) return direct;
  const pod = /^(.+)-pod\.service$/.exec(unit);
  return pod ? nodeByName(pod[1]) : undefined;
}

/** The container's own application, where it has a UI worth opening. Read off
 *  STRIP_SERVICES rather than restated: a second hand-maintained list is the
 *  shape CLAUDE.md calls the most driftable thing here, and the Home strip
 *  already checks that one against topology at startup in dev. */
export function appFor(container: string): AppKey | null {
  return STRIP_SERVICES.find((s) => s.container === container)?.app ?? null;
}

interface Verdict {
  tone: Tone;
  state: string;
  issue: string | null;
  remedy: string | null;
}

/**
 * THE LIVENESS VERDICT, WHICH IS TWO SOURCES AND NOT ONE.
 *
 * The unit answers "does this service exist and is systemd happy with it"; the
 * container answers "is the thing it started passing its own probe". Either can
 * be wrong while the other reads perfectly, and the page had only ever asked the
 * second one.
 *
 * ORDERED WORST FIRST, and the first three arms are the ones no previous version
 * of this page could reach at all.
 */
export function liveness(
  present: boolean,
  running: boolean,
  health: number | undefined,
  unitState: number,
  unitRestarts: number,
  unit: string,
): Verdict {
  const status = `systemctl --user status ${unit}`;
  const journal = `journalctl --user -u ${unit} -n 100`;

  // Nothing answered for either half. Not a healthy service and not a failed
  // one - the collector did not report, and StalenessBanner says why.
  if (!Number.isFinite(unitState) && !present) {
    return { tone: "off", state: "not measured", issue: null, remedy: null };
  }

  if (unitState === 2) {
    return {
      tone: "fail",
      state: "unit failed",
      issue: "systemd has given up on this unit - it is not being retried.",
      remedy: status,
    };
  }

  if (!present) {
    // A UNIT THAT IS STARTING HAS NO CONTAINER YET, and for a few seconds that
    // is the correct state rather than a fault.
    if (unitState === 1) {
      return { tone: "warn", state: "starting", issue: "the unit is starting; no container yet.", remedy: null };
    }
    if (unitState === 3 || unitState === 5) {
      return {
        tone: "warn",
        state: UNIT_STATE[unitState],
        issue: `the unit is ${UNIT_STATE[unitState]}, so no container is running.`,
        remedy: status,
      };
    }
    return {
      tone: "fail",
      state: unitState === 4 ? "not running" : "no container",
      issue:
        unitState === 4
          ? "the unit is inactive and no container exists. A dependency that failed to start reads exactly like this - it is inactive, not failed."
          : "no container answered for a unit that should have one.",
      remedy: status,
    };
  }

  // @/health owns the container half, including the rule that an absent health
  // series is grey rather than green. Reimplementing it here is how the two
  // pages that read it would come to disagree.
  const base = containerTone(running, health);

  if (base.tone === "fail") {
    return {
      tone: "fail",
      state: base.state,
      issue:
        base.state === "unhealthy"
          ? "the container is running and failing its own health check."
          : "the container exists but is not running.",
      remedy: journal,
    };
  }

  // A RESTART IS THE FINDING, AND IT OUTRANKS "starting". NRestarts resets on a
  // clean start, so any non-zero value means systemd restarted this unit after
  // a failure since then - and at Restart=always with RestartSec=5 it can never
  // reach systemd's give-up limit, so the unit stays green while looping. This
  // number climbing IS the only end state the host has.
  if (Number.isFinite(unitRestarts) && unitRestarts > 0) {
    return {
      tone: "warn",
      state: "restarting",
      issue: `systemd has restarted this unit ${fmt.number(unitRestarts)} time(s) since it last started cleanly. Read the journal rather than watching it - the real error scrolls past between restarts.`,
      remedy: journal,
    };
  }

  if (unitState === 1) {
    return { tone: "warn", state: "starting", issue: "the unit is still starting.", remedy: null };
  }

  if (unitState === 9) {
    return {
      tone: "warn",
      state: "unit state unknown",
      issue: "systemd reported a state the collector does not recognise.",
      remedy: status,
    };
  }

  if (base.tone === "warn") {
    return { tone: "warn", state: base.state, issue: "the container has not passed its health check yet.", remedy: null };
  }

  // Grey, and grey is not green: nobody is checking this one.
  if (base.tone === "off") {
    return { tone: "off", state: base.state, issue: null, remedy: null };
  }

  return { tone: "ok", state: base.state, issue: null, remedy: null };
}

export function memoryRatio(row: Pick<ServiceRow, "memory" | "memoryHigh">): number {
  return Number.isFinite(row.memoryHigh) && row.memoryHigh > 0 ? row.memory / row.memoryHigh : Number.NaN;
}

/**
 * A CONTAINER AT ITS MemoryHigh IS NOT NEWS, and colouring it amber is the
 * single most likely way this page would cry wolf.
 *
 * CLAUDE.md spends a section on it: Jellyfin sits at exactly 3.00G against a 3G
 * watermark with 6,398 `high` events seven minutes after a restart, and it is
 * fine - 0.385G of that is its working set and the rest is cold streaming page
 * cache the kernel reclaims for free. "A cgroup doing file I/O will always sit
 * at its MemoryHigh and always accumulate high events, because that is what the
 * watermark is for."
 *
 * THE FIRST VERSION OF THIS FUNCTION MADE THAT ARGUMENT AND THEN LOST IT ONE
 * LEVEL DOWN. It ended `if (thrashing) return "warn"`, where thrashing was
 * `refault > 0` - a floor of zero on a rate. Measured on the live host on
 * 2026-09-08: a mean of NINE OF TWENTY-SEVEN containers flagged at any instant
 * over six hours, peaking at TWENTY-FIVE, while the worst working set on the
 * host was 58% of its watermark, the worst in six hours was 91%, and there had
 * been zero OOM kills and zero `max` events host-wide. tdarr-node-01 was drawn
 * "memory starved" at a refault rate of 0.0037 pages per second - one page
 * every four and a half minutes.
 *
 * `workingset_refault_file` counts re-reads of file pages evicted at ANY time,
 * global reclaim included, so on a 15.8 GB host serving a 7.3 TB library it
 * fires on ordinary file I/O: eight of the nine containers it selected in one
 * sample had a pgscan rate of zero, having reclaimed nothing at all.
 *
 * AND IT IS BLIND TO THE ONE MEMORY INCIDENT THIS HOST HAS ACTUALLY RECORDED,
 * which is the half that makes it wrong rather than merely noisy. A cgroup
 * pinned by tmpfs has NO file cache to evict, so it refaults nothing: those
 * pages are charged to it and, with no swap, cannot be reclaimed at all.
 * docs/known-state.md's "A filesystem that counts against the memory ceiling"
 * is exactly that shape, and records what it cost - "`memory.events max` and
 * `oom_kill` both stayed 0 for the whole run - MemoryHigh throttles, it does
 * not kill - so no unit failed, no container went unhealthy, no check fired and
 * no alert reached the phone." Pressure is the only witness that shape has.
 *
 * SO PSI IS THE GATE, WHICH IS WHAT THE COLLECTOR ALREADY CALLED IT.
 * bin/collect-metrics.py publishes container_pressure_memory_* under the words
 * "The arbiter: real starvation shows here, and a cgroup merely holding cache
 * does not", and this page read neither series. docs/known-state.md names four
 * signals for real starvation - a large `anon`, `pgsteal` falling short of
 * `pgscan`, a climbing `workingset_refault_file`, AND nonzero pressure - and
 * the rule implemented one of the four with no floor.
 *
 * Refault keeps a place, on the watermark arm only: at the ceiling it is what
 * separates a cgroup there because of reclaim thrash from one holding anon. It
 * speaks nowhere on its own.
 *
 * THE RESTART CLAUSE READS THE UNIT'S COUNTER, AND USED TO READ PODMAN'S. That
 * made this arm dead code: podman's field is reset when the container is
 * recreated, which a quadlet does on every restart, so `restarts > 0` was never
 * true here on the live host.
 */

/**
 * PSI `some` above anything thirty days of healthy operation produced.
 *
 * The per-container maxima over that window, sampled every ten minutes:
 * qbittorrent 0.0122, bazarr 0.0103, flaresolverr 0.0023, jellyfin 0.0015,
 * tdarr-node-01 0.0007. So 0.05 is four times the worst reading this host has
 * ever taken, and well below the ten percent the kernel's own pressure-stall
 * documentation treats as meaningful. A genuinely thrashing cgroup does not sit
 * near this floor - it sits in the tens of percent.
 *
 * Measured the other way round on 2026-09-08: this expression selected NOTHING
 * at every ten-minute sample across the whole thirty-day window, where the
 * refault expression it replaces was selecting nine at that moment.
 */
export const STALL_WARN = 0.05;

/**
 * PSI `full`: EVERY runnable task in the cgroup delayed, not merely one.
 *
 * NOT A SCALED READING OF THE SAME NUMBER. The two levels diverged in 1,707 of
 * the thirty-day samples, by up to 2,837x, so this is a second signal. A cgroup
 * making no progress at all a tenth of the time is starved by definition, and
 * the thirty-day ceiling for `full` on this host is the same 0.0122 - one
 * momentary sample on a single-task cgroup, where `some` and `full` coincide.
 */
export const STALL_FAIL = 0.1;

export function memoryTone(
  row: Pick<
    ServiceRow,
    "memory" | "memoryHigh" | "refault" | "oomKills" | "unitRestarts" | "stallSome" | "stallFull"
  >,
): Tone {
  // AN OOM KILL IS UNAMBIGUOUS AND IS CHECKED BEFORE EVERYTHING ELSE. The
  // kernel killed something in this cgroup; no reading of the watermark or of
  // the pressure makes that benign, and the counter resets with the container
  // so it is about now.
  if (Number.isFinite(row.oomKills) && row.oomKills > 0) return "fail";

  const ratio = memoryRatio(row);
  if (!Number.isFinite(ratio)) return "off";

  // ABSENCE IS NOT HEALTH, and the reachable case is not exotic: memoryHigh is a
  // gauge and these two are rates, so a container in its first minute - or the
  // window after a collector gap - has a ceiling and no pressure reading at all.
  // Answering `ok` there is the same mistake useServiceRack.ts already refuses
  // for `health`, where `?? 0` would report three containers as verified healthy
  // on the strength of no evidence. docs/known-state.md files it under "Absence
  // read as health in one function and as a failure in the next".
  //
  // BOTH LEVELS COME OUT OF ONE memory.pressure READ, so they arrive together or
  // not at all and partial absence is a corner. Where it happens, the level that
  // DID answer is a measurement and is graded: treating a real reading as no
  // reading would be this defect's mirror.
  const waiting = row.stallSome;
  const stalled = row.stallFull;
  if (!Number.isFinite(waiting) && !Number.isFinite(stalled)) return "off";

  // NOTHING RUNNABLE IN THE CGROUP COULD RUN, whatever the cause. This arm needs
  // no corroboration and takes none.
  if (Number.isFinite(stalled) && stalled >= STALL_FAIL) return "fail";

  // THE ARBITER. Nothing below is reached without a stall, which is the whole
  // correction: the refault rate no longer speaks on its own.
  if (Number.isFinite(waiting) && waiting >= STALL_WARN) {
    // CORROBORATION ESCALATES AND NEVER TRIGGERS. Pressed against the watermark
    // AND faulting reclaimed pages back in is starvation before `full` has
    // climbed - the shape the old rule was reaching for with `ratio >= 0.98 &&
    // thrashing`, which is kept here behind the gate rather than in front of it.
    // Refault is not required: the tmpfs case above produces none.
    const thrashing = Number.isFinite(row.refault) && row.refault > 0;
    if (ratio >= 0.98 && (thrashing || row.unitRestarts > 0)) return "fail";
    return "warn";
  }

  return "ok";
}

/**
 * The memory cell's SECOND caption line, and THE ONLY SURFACE AN UNMEASURABLE
 * MEMORY READING HAS.
 *
 * The decision lives here rather than in the template because serviceRows()
 * ignores memoryTone's `off` on purpose - memory only ever makes a row worse,
 * never grey - so the LED is the row's liveness, the state word is its liveness,
 * and nothing else on the row can report that the arbiter did not answer. A grey
 * "70% of high" on its own reads as "nobody is checking the ratio", when what is
 * unchecked is the stall.
 *
 * ONE SHORT LINE, NEVER A SUFFIX ON THE ONE ABOVE IT. `.c-mem` is 132px, sized
 * for "100% of high"; "70% of high, stall not read" is twice that, and a fixed
 * table column clips rather than wraps.
 *
 * AND THE STRING IS MEASURED RATHER THAN CHOSEN. The caption has 108px of the
 * 132 after padding; "100% of high" is 84px there, "stall not measured" is 126
 * and WRAPPED - which cost that row 14px of height against every other row on
 * the rack, the only visible difference between them. "stall not read" is 98px
 * and is the longest wording that fits. Anything longer goes to the tooltip,
 * which is where the reason it was not read already lives.
 *
 * NULL WITH NO CEILING, which suppresses the whole caption block: "- of high"
 * over "- of max" is two sentences about limits nothing declared, and the dash
 * above them already says the row has no reading.
 */
export function memorySubline(
  row: Pick<
    ServiceRow,
    | "memory"
    | "memoryHigh"
    | "memoryLimit"
    | "refault"
    | "oomKills"
    | "unitRestarts"
    | "stallSome"
    | "stallFull"
  >,
): string | null {
  if (!Number.isFinite(memoryRatio(row))) return null;
  if (memoryTone(row) === "off") return "stall not read";
  const limit = memoryLimitRatio(row);
  return Number.isFinite(limit) ? `${fmt.percent(limit, 0)} of max` : null;
}

/** The second line: the same working set against the HARD limit. Every unit here
 *  sits 33-50% lower again against MemoryMax than against the watermark, and
 *  the page could not say so until 2026-09-08 - so "58% of high" read worse than
 *  it is. Absent for the pod's infra container, which declares neither. */
export function memoryLimitRatio(row: Pick<ServiceRow, "memory" | "memoryLimit">): number {
  return Number.isFinite(row.memoryLimit) && row.memoryLimit > 0 ? row.memory / row.memoryLimit : Number.NaN;
}

/**
 * The memory sentence, for a row whose memory is what is wrong with it.
 *
 * IT LEADS WITH THE STALL, because that is the number that is actually high.
 * The old sentence led with the byte count and the watermark, so a container at
 * 14% of its ceiling was told it was "starved rather than merely holding cache"
 * directly beside two numbers saying it was doing neither.
 */
function memoryIssue(row: ServiceRow): string {
  if (Number.isFinite(row.oomKills) && row.oomKills > 0) {
    return `the kernel has OOM-killed something in this cgroup ${fmt.number(row.oomKills)} time(s) since the container started.`;
  }
  const at = `${fmt.bytes(row.memory)} of ${fmt.bytes(row.memoryHigh)}`;
  // "of the time" rather than "in the last five minutes": a rate over a PSI
  // total is a fraction of wall time whatever RATE in queries.ts is set to, and
  // a second spelling of that window here would start lying the day it moved.
  if (Number.isFinite(row.stallFull) && row.stallFull >= STALL_FAIL) {
    return `${at}, and EVERY runnable task in it was stalled on memory ${fmt.percent(row.stallFull, 1)} of the time - this one is starved rather than merely holding cache.`;
  }
  return `${at}, and something in it was delayed on memory ${fmt.percent(row.stallSome, 1)} of the time. Sitting at the watermark is not a finding; waiting on memory is.`;
}

/**
 * ONE ROW PER UNIT, WITH A CONTAINER JOINED ON.
 *
 * The units are the enumeration and the containers are the join, which is the
 * inversion this module exists for. A container whose unit did not answer is
 * still drawn - it is a real container and dropping it would trade one blind
 * spot for another - and it keeps whatever the container half can say.
 */
export function serviceRows(units: UnitReading[], containers: ContainerReading[]): ServiceRow[] {
  // A LIST PER UNIT, NOT ONE CONTAINER. It is 1:1 on this host - every pod
  // member carries its own .container quadlet, measured - but a `.pod` unit
  // whose members had none would legitimately hold several, and a Map of one
  // would then keep the last and drop the rest with nothing to say so. Silently
  // losing rows is the failure this whole module exists to remove.
  const byUnit = new Map<string, ContainerReading[]>();
  for (const c of containers) {
    const list = byUnit.get(c.unit);
    if (list) list.push(c);
    else byUnit.set(c.unit, [c]);
  }

  const seen = new Set<string>();
  const rows: ServiceRow[] = [];

  const build = (u: UnitReading | undefined, c: ContainerReading | undefined): ServiceRow => {
    const unit = u?.unit ?? c?.unit ?? "";
    const name = c?.name ?? fmt.unitName(unit).replace(/-pod$/, "");
    const declared = topologyFor(name, unit);
    const unitState = u ? u.state : Number.NaN;
    const unitRestarts = u ? u.restarts : Number.NaN;

    const row: ServiceRow = {
      name,
      unit,
      kind: u?.kind ?? "container",
      present: c !== undefined,
      image: c?.image ?? "",
      role: declared?.role ?? "",
      networks: declared?.networks ?? [],
      pod: declared?.pod ?? "",
      app: appFor(name),
      running: c?.running ?? false,
      health: c?.health,
      unitState,
      unitRestarts,
      podmanRestarts: c?.podmanRestarts ?? Number.NaN,
      cpu: c?.cpu ?? Number.NaN,
      memory: c?.memory ?? Number.NaN,
      memoryHigh: c?.memoryHigh ?? Number.NaN,
      memoryLimit: c?.memoryLimit ?? Number.NaN,
      refault: c?.refault ?? Number.NaN,
      stallSome: c?.stallSome ?? Number.NaN,
      stallFull: c?.stallFull ?? Number.NaN,
      oomKills: c?.oomKills ?? Number.NaN,
      uptime: c?.uptime ?? Number.NaN,
      activity: c?.activity ?? [],
      tone: "off",
      state: "",
      issue: null,
      remedy: null,
      memoryTone: "off",
    };

    const live = liveness(row.present, row.running, row.health, unitState, unitRestarts, unit);
    row.memoryTone = memoryTone(row);
    row.state = live.state;
    row.issue = live.issue;
    row.remedy = live.remedy;
    row.tone = live.tone;

    // MEMORY ONLY EVER MAKES A ROW WORSE, NEVER GREY. memoryTone answers `off`
    // for anything with no MemoryHigh - the pod's infra container among them -
    // and `off` outranks `ok`, so taking the plain worst of the two would draw
    // a perfectly healthy service as unmeasured on the strength of a ceiling it
    // was never given.
    if (row.memoryTone === "warn" || row.memoryTone === "fail") {
      const before = row.tone;
      row.tone = worst(row.tone, row.memoryTone);
      if (!row.issue) {
        row.issue = memoryIssue(row);
        // THE CEILINGS, NOT THE ARBITER, and that is a width decision rather than
      // a judgement about which is more useful. The pressure file is reached by
      // `cat /sys/fs/cgroup$(systemctl --user show <unit> -p ControlGroup
      // --value)/memory.pressure`, which is 101 characters and wraps mid-flag in
      // .c-remedy - measured, it split `--value` across two lines, which is the
      // one thing that column's own comment forbids. That command lives on the
      // memory cell's tooltip instead, where nothing is 380px wide. What a
      // reader needs next from a starved container is its limits, and the stall
      // itself is already the first clause of the sentence beside this.
      row.remedy = `systemctl --user show ${unit} -p MemoryHigh -p MemoryMax`;
      }
      // THE WORD HAS TO AGREE WITH THE LED. Memory escalated the row, so the
      // state cannot still read "healthy" beside a red dot and a sentence about
      // an OOM kill - which is exactly what the first version of this drew.
      // TWO WORDS, NOT ONE. Memory can now escalate a row to `warn` as well as to
      // `fail`, and "memory starved" beside an AMBER dot overstates what a `some`
      // reading says - something in the cgroup was delayed, not that it stopped.
      // Deliberately not "memory stalled" for the amber: `stalled` is the name of
      // the OTHER PSI level in the collector's PSI_LEVELS, and borrowing it for a
      // `waiting`-driven verdict would collide with that vocabulary.
      if (RANK[row.tone] > RANK[before]) {
        row.state =
          row.oomKills > 0 ? "oom-killed" : row.memoryTone === "fail" ? "memory starved" : "memory pressure";
      }
    }

    return row;
  };

  for (const u of units) {
    seen.add(u.unit);
    const own = byUnit.get(u.unit) ?? [];
    if (!own.length) rows.push(build(u, undefined));
    else for (const c of own) rows.push(build(u, c));
  }
  // A CONTAINER WHOSE UNIT DID NOT ANSWER IS STILL DRAWN. It is a real container
  // and dropping it would trade one blind spot for another; it keeps whatever
  // the container half can say and reads NaN for the unit half.
  for (const c of containers) {
    if (!seen.has(c.unit)) rows.push(build(undefined, c));
  }

  // Worst first, then busiest. A rack sorted alphabetically buries the one row
  // worth looking at somewhere in the middle.
  //
  // `off` AND `ok` DELIBERATELY TIE. duckdns, unpackerr and the pod's infra
  // container have no health check to fail, so ranking "unchecked" above
  // "healthy" would pin the same three rows to the top for ever - which is how
  // a sort order stops being read. They sort in by activity like everything
  // else, and the tally is where their number is stated.
  //
  // ABSENT SORTS ABOVE PRESENT WITHIN A TONE, and it has to be said explicitly:
  // a service with no container has no CPU either, so the busyness tiebreak
  // alone puts the one thing that is completely down at the BOTTOM of the
  // failures. Down is worse than degraded-but-running.
  const sortRank: Record<Tone, number> = { fail: 0, warn: 1, off: 2, ok: 2 };
  const busy = (r: ServiceRow) => (Number.isFinite(r.cpu) ? r.cpu : -1);
  rows.sort(
    (a, b) =>
      sortRank[a.tone] - sortRank[b.tone] ||
      Number(a.present) - Number(b.present) ||
      busy(b) - busy(a) ||
      a.name.localeCompare(b.name),
  );
  return rows;
}

/** The rows worth acting on. ONE DERIVATION, TWO VIEWS: this is a filter over
 *  the same array the rack draws, never a second reading of the same series -
 *  which is how the System page came to draw one finding two ways and disagree
 *  with itself about what `note` meant. */
export function needsAttention(rows: ServiceRow[]): ServiceRow[] {
  return rows.filter((r) => r.tone === "fail" || r.tone === "warn");
}

export interface Tally {
  total: number;
  ok: number;
  warn: number;
  fail: number;
  off: number;
  /** Units with no container at all - the state that was invisible. */
  absent: number;
}

export function serviceTally(rows: ServiceRow[]): Tally {
  const t: Tally = { total: rows.length, ok: 0, warn: 0, fail: 0, off: 0, absent: 0 };
  for (const r of rows) {
    t[r.tone] += 1;
    if (!r.present) t.absent += 1;
  }
  return t;
}

export interface LeadReading {
  /** The headline, in --t-mono-xl. One per view. */
  text: string;
  tone: Tone;
  live: boolean;
  sub: string;
}

/**
 * THE HEADLINE IS THE COUNT THAT NEEDS SOMETHING DOING, not the count that is
 * fine. "26 of 28 healthy" reads as a pass mark; the two are the reason to be
 * here.
 *
 * The grey term is stated in the sub-line and never folded into the green one -
 * "nobody is checking these three" is not evidence that they are well, and this
 * application's whole health vocabulary is built on refusing that fold.
 */
export function servicesLead(rows: ServiceRow[]): LeadReading {
  const t = serviceTally(rows);

  if (t.total === 0) {
    return {
      text: "no service reported",
      tone: "off",
      live: false,
      sub: "prometheus returned no home_server_unit_state and no home_server_container_info",
    };
  }

  const unchecked = t.off ? `, ${t.off} with no health check` : "";
  const bad = t.fail + t.warn;

  if (bad === 0) {
    return {
      text: `${t.total} services up`,
      tone: "ok",
      live: false,
      sub: `nothing failing, nothing restarting${unchecked}`,
    };
  }

  const absent = t.absent ? `, ${t.absent} with no container at all` : "";
  return {
    text: `${bad} of ${t.total} need attention`,
    tone: t.fail ? "fail" : "warn",
    live: t.fail > 0,
    sub: `${t.fail} failing, ${t.warn} degraded${absent}${unchecked}`,
  };
}

export interface ConditionRow {
  id: string;
  label: string;
  value: string;
  sub: string;
  tone: Tone;
}

/**
 * The three conditions the rack is an exception to: are the units up, are the
 * containers passing, and is anything looping.
 *
 * RESTARTS IS ITS OWN CONDITION BECAUSE IT IS THE ONE NOTHING ELSE SAYS. A unit
 * restarting every five seconds is `active` to systemd and healthy to podman;
 * the counter is the only witness, and it was on no page in this application.
 */
export function conditionRows(rows: ServiceRow[]): ConditionRow[] {
  const t = serviceTally(rows);

  // COUNTED PER UNIT AND NOT PER ROW. A `.pod` unit with several containers
  // under it is one unit that restarted, not three - and its NRestarts would be
  // added three times by a plain reduce over the rows, which is a number nothing
  // on the host reports.
  const units = new Map<string, ServiceRow>();
  for (const r of rows) if (r.unit && !units.has(r.unit)) units.set(r.unit, r);
  const perUnit = [...units.values()];

  const active = perUnit.filter((r) => r.unitState === 0).length;
  const measured = perUnit.filter((r) => Number.isFinite(r.unitState)).length;

  const looping = perUnit.filter((r) => Number.isFinite(r.unitRestarts) && r.unitRestarts > 0);
  const totalRestarts = looping.reduce((n, r) => n + r.unitRestarts, 0);

  return [
    {
      id: "units",
      label: "Units",
      value: measured === 0 ? fmt.NO_DATA : `${active} of ${measured} active`,
      sub: measured === 0 ? "no unit state reported" : t.absent ? `${t.absent} with no container` : "every quadlet up",
      tone: measured === 0 ? "off" : active < measured ? "fail" : "ok",
    },
    {
      id: "health",
      label: "Health",
      value: `${t.ok} healthy`,
      // The grey term is named, never merged: absent is not zero.
      sub: `${t.fail} failing, ${t.warn} degraded, ${t.off} unchecked`,
      tone: t.fail ? "fail" : t.warn ? "warn" : "ok",
    },
    {
      id: "restarts",
      label: "Restarts",
      value: looping.length === 0 ? "none" : `${fmt.number(totalRestarts)} on ${looping.length}`,
      sub:
        looping.length === 0
          ? "systemd has restarted nothing since it last started clean"
          : looping.map((r) => r.name).join(" "),
      tone: looping.length ? "warn" : "ok",
    },
  ];
}

/**
 * The restart cell, which has to carry two numbers that answer two questions.
 *
 * systemd's is the one that matters and the one drawn; podman's is kept because
 * it says something the other cannot - a container restarting WITHOUT its unit
 * restarting, which is podman's own doing rather than systemd's. It is stated
 * only when the two disagree, or the column would print "0 / 0" on 28 rows.
 */
export function restartLine(row: ServiceRow): string | null {
  if (!Number.isFinite(row.podmanRestarts) || row.podmanRestarts === 0) return null;
  return `${fmt.number(row.podmanRestarts)} by podman`;
}

// =============================================================================
// The applications, which are a different question from their containers
// -----------------------------------------------------------------------------
// AN *ARR WITH A BROKEN INDEXER IS HEALTHY BY EVERY SIGNAL ON THE RACK. The unit
// is active, the container passes its probe, and the fault exists only in the
// application's own /health endpoint - which the collector has read since it
// existed and this page had never drawn. CLAUDE.md: Prowlarr "is the one that
// earns its keep: nothing else in the stack reports that searching has quietly
// stopped working. Every container stays healthy, every unit stays active, and
// the only symptom is that nothing is found."
// =============================================================================

export interface AppMetrics {
  /** service -> configured indexers. */
  indexers: Map<string, number>;
  /** indexer name -> 1 up, 0 while Prowlarr is backing off. */
  indexerUp: Map<string, number>;
  /** service -> items in the download queue. */
  queue: Map<string, number>;
  /** service -> 1 while the queue is reporting errors. */
  queueErrors: Map<string, number>;
  /** "<service>|<severity>" -> count. */
  health: Map<string, number>;
  sessions: number;
  tdarr: number;
  torrentState: number;
  down: number;
  up: number;
  vpn: string;
}

export interface AppRow {
  id: string;
  label: string;
  app: AppKey | null;
  /** What it is doing, when it is doing it well. */
  reading: string;
  /** What is wrong, or null. */
  issue: string | null;
  tone: Tone;
}

export const TORRENT_STATE = ["connected", "firewalled", "disconnected"];

/** "2 errors, 1 warning", or null. Notices are deliberately not counted: they
 *  are the applications' own FYI tier and a permanent amber row is a row nobody
 *  reads. */
function healthIssues(m: AppMetrics, service: string): { text: string | null; tone: Tone } {
  const errors = m.health.get(`${service}|error`);
  const warnings = m.health.get(`${service}|warning`);

  if (errors === undefined && warnings === undefined) {
    return { text: null, tone: "off" };
  }

  const parts: string[] = [];
  if (errors) parts.push(`${fmt.number(errors)} error(s)`);
  if (warnings) parts.push(`${fmt.number(warnings)} warning(s)`);
  if (!parts.length) return { text: null, tone: "ok" };

  return { text: `${parts.join(", ")} on its own health page`, tone: errors ? "fail" : "warn" };
}

function arrRow(m: AppMetrics, id: string, label: string, app: AppKey): AppRow {
  const issues = healthIssues(m, id);
  const queued = m.queue.get(id);
  const indexers = m.indexers.get(id);

  const reading = [
    queued === undefined ? null : `${fmt.number(queued)} queued`,
    indexers === undefined ? null : `${fmt.number(indexers)} indexers`,
  ]
    .filter(Boolean)
    .join(", ");

  // A QUEUE ERROR IS ITS OWN FINDING. CLAUDE.md: a stalled download blocks every
  // alternative release and reports itself as `downloading`, so the queue's own
  // error flag is the earliest thing here that can say so.
  const stalled = (m.queueErrors.get(id) ?? 0) === 1;
  const issue = stalled
    ? `the download queue is reporting errors${issues.text ? `, and ${issues.text}` : ""}`
    : issues.text;

  return {
    id,
    label,
    app,
    reading: reading || "did not answer",
    issue,
    tone: reading === "" ? "off" : worst(stalled ? "warn" : "ok", issues.tone === "off" ? "ok" : issues.tone),
  };
}

/**
 * ONE ROW PER APPLICATION, AND THE DOWN INDEXERS ARE NAMED.
 *
 * "13 of 15 up" was the whole of what this page could say, and the two that are
 * down is the only part anybody can act on. CLAUDE.md is emphatic that the
 * causes are mostly NOT local - measured once, six zeros were a dead mirror, its
 * duplicate, two entries sharing one refusing API host, a 502 and a 403 - so the
 * row names them and sends the reader to Prowlarr's log rather than suggesting a
 * fix.
 */
export function appRows(m: AppMetrics): AppRow[] {
  const rows: AppRow[] = [
    arrRow(m, "sonarr", "sonarr", "sonarr"),
    arrRow(m, "radarr", "radarr", "radarr"),
  ];

  const down = [...m.indexerUp.entries()].filter(([, v]) => v === 0).map(([k]) => k);
  const upCount = m.indexerUp.size - down.length;
  const prowlarrIssues = healthIssues(m, "prowlarr");

  rows.push({
    id: "prowlarr",
    label: "prowlarr",
    app: "prowlarr",
    reading: m.indexerUp.size === 0 ? "did not answer" : `${upCount} of ${m.indexerUp.size} indexers up`,
    issue: down.length
      ? `backing off ${down.join(", ")} - read Prowlarr's log before changing anything, the cause is usually not local${prowlarrIssues.text ? `. Also ${prowlarrIssues.text}` : ""}`
      : prowlarrIssues.text,
    tone:
      m.indexerUp.size === 0
        ? "off"
        : worst(down.length ? "warn" : "ok", prowlarrIssues.tone === "off" ? "ok" : prowlarrIssues.tone),
  });

  rows.push({
    id: "jellyfin",
    label: "jellyfin",
    app: "jellyfin",
    reading: Number.isFinite(m.sessions) ? `${fmt.number(m.sessions)} session(s)` : "did not answer",
    issue: null,
    tone: Number.isFinite(m.sessions) ? "ok" : "off",
  });

  rows.push({
    id: "tdarr",
    label: "tdarr",
    app: "tdarr",
    reading: Number.isFinite(m.tdarr) ? `${fmt.number(m.tdarr)} file(s) queued` : "did not answer",
    issue: null,
    tone: Number.isFinite(m.tdarr) ? "ok" : "off",
  });

  // THE VPN IS PART OF THE TORRENT ROW, not a fact on its own. A disconnected
  // client and an exit node are one question - can this thing move bytes, and
  // through where - and eight loose label/value pairs is how they were two.
  const state = m.torrentState;
  const stateText = Number.isFinite(state) ? (TORRENT_STATE[state] ?? "unknown") : "did not answer";
  rows.push({
    id: "qbittorrent",
    label: "qbittorrent",
    app: "qbittorrent",
    reading: `${stateText}, ${fmt.rate(m.down)} down / ${fmt.rate(m.up)} up${m.vpn ? `, via ${m.vpn}` : ""}`,
    issue: state === 1 ? "the client is firewalled - no incoming connections" : state === 2 ? "the client is disconnected" : null,
    tone: !Number.isFinite(state) ? "off" : state === 0 ? "ok" : "warn",
  });

  return rows;
}
