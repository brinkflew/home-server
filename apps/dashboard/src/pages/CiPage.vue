<script setup lang="ts">
/**
 * CI: the three self-hosted GitHub Actions lanes.
 *
 * THIS PAGE IS THE ONLY PLACE THIS FLEET IS VISIBLE, and that is not a boast
 * about the design - it is the constraint the whole page is built around. A lane
 * container carries io.home-server.ephemeral, so source_containers and
 * source_container_network both skip it; it runs `podman run --rm`, so nothing
 * is left in `failed`; and it defines no health check, so it can never read
 * unhealthy. docs/ci.md puts the consequence plainly: "a wedged lane leaves no
 * failed unit and no unhealthy container". Every other page here would show a
 * perfectly quiet host.
 *
 * So the marker file is the only witness, and ABSENCE IS THE FINDING. A lane
 * with no heartbeat is grey and says "never started" - never green, never
 * "idle". The collector's own help text for job_in_flight is written in those
 * words: absent "is not the same as 0 and must not be drawn as idle".
 *
 * There is deliberately nothing here from GitHub's own API - no queue depth, no
 * runner online status. GITHUB_RUNNER_PAT must never enter a container, and
 * bin/verify-host.sh already argues against hourly api.github.com polling. The
 * page says that slot is not measured rather than leaving a reader to assume
 * these three lanes are the whole picture.
 *
 * IT GOT /agents/fleet's PASS ON 2026-09-07, AND IT HAD HAD NEITHER OF THAT
 * PAGE'S TWO. What that page opened on - three equal panels with no primary,
 * six records as a grid of cards, a Containment panel reproducing
 * FindingsPanel's markup directly above a FindingsPanel - was all here too, in a
 * slightly different arrangement, and had been longer. The lead reading, the
 * band rule, the .tbl recipe and the sentence-case register all arrive from
 * there rather than being invented here.
 *
 * THE RACK BECAME A TABLE, WHICH ITS OWN COMMENT ASKED FOR. Eleven columns and
 * 622px of fixed tracks meant a 748px floor and a horizontal pan on anything
 * smaller, with the column labels living only in tooltips - "a real limitation
 * on a phone", the old comment said, naming the conversion as "its own
 * follow-up". The shared recipe brings a header row, the p4/p3/p2 priority
 * ladder and a phone rung that folds rather than scrolls.
 *
 * AND THE HEADLINE WAS ALREADY IN THE PAGE, IN COLUMN FIVE. 108 jobs today read
 * as three `.num mono` cells you had to add up, on a host where that is the one
 * number saying the fleet is doing its job.
 *
 * TWO LIVE BUGS CAME OUT OF IT, AND BOTH HAD ALREADY BEEN FOUND SOMEWHERE ELSE.
 * The containment tone was a hand-rolled `status === 'pass' ? 'ok' : 'warn'`, so
 * a FAILING containment check drew amber on the page somebody opens after
 * CiContainmentLost has paged them - fixed on /agents/fleet hours earlier the
 * same day, with checkTone() named as the answer, and found here only because
 * that page's treatment was applied to this one. And an idle
 * lane drew a bare ProgressBar track, which is the encoding this store reserves
 * for "in progress, ratio unknown" - the same call-site defect `idle` cost the
 * round board. Finding one instance of either was never evidence about the rest.
 *
 * src/lanes.ts OWNS THE DECISIONS, for the reason src/machine.ts states: a
 * computed in a .vue file is code fixtures/smoke.mjs cannot call, and the
 * containment tone is exactly what that blind spot hides.
 */
import { computed, watch } from "vue";

import Band from "@/components/Band.vue";
import PanelBox from "@/components/PanelBox.vue";
import StatusDot from "@/components/StatusDot.vue";
import StatePill from "@/components/StatePill.vue";
import ProgressBar from "@/components/ProgressBar.vue";
import MetricChart from "@/components/MetricChart.vue";
import FindingsPanel from "@/components/FindingsPanel.vue";
import WindowPicker from "@/components/WindowPicker.vue";

import { usePoll } from "@/composables/usePoll";
import { useMetricsStale } from "@/composables/useStaleness";
import { useTimeWindow } from "@/composables/useTimeWindow";
import { useTooltip } from "@/composables/useTooltip";
import { useHostStore } from "@/stores/host";
import { instant, instantBy, range, value } from "@/api/prometheus";
import { CI } from "@/queries";
import { heartbeatTone, laneTone } from "@/health";
import { latest, peak, toPoints, type ChartSeries } from "@/charts";
import { hostRows, hostTally, laneLead, laneTally, silentLanes, type HostRow } from "@/lanes";
import type { InstantSeries, RangeSeries, Tone } from "@/types";
import * as fmt from "@/format";

const { window: win } = useTimeWindow();
const tip = useTooltip();
const host = useHostStore();
const metricsStale = useMetricsStale();

// The three budgets the driver actually enforces, from docs/ci.md. Named here
// rather than inlined, because a bar drawn against a number nobody can find is
// decoration.
const LANE_DISK_MAX = 20480 * 1024 * 1024; // GITHUB_RUNNER_LANE_MAX_MB
const STORE_MAX_JOBS = 50; // GITHUB_RUNNER_STORE_MAX_JOBS
const RUNTIME_MAX_S = 5400; // RuntimeMaxSec on the lane scope
const JOB_STUCK_S = 10800; // what ci.job_stuck grades on: 2x the above
const HEARTBEAT_STALE_S = 300; // what ci.heartbeat grades on: ten missed polls

const LANE_TONES: NonNullable<ChartSeries["tone"]>[] = ["ok", "warn", "fail"];

interface Lane {
  lane: string;
  tone: Tone;
  state: string;
  /** NaN when the lane has never written a heartbeat. */
  heartbeatAge: number;
  /** undefined when the series is absent, which is NOT idle. */
  inFlight: number | undefined;
  /** Seconds the current job has been running, NaN when none is. */
  jobAge: number;
  lastJobAge: number;
  lastJobSeconds: number;
  jobsToday: number;
  jobsTotal: number;
  failures: number;
  disk: number;
  storeJobs: number;
  resets: number;
  memPeak: number;
  pidsPeak: number;
  memMaxEvents: number;
  oomKills: number;
}

const rack = usePoll(async (signal) => {
  const [
    markerPresent, heartbeat, inFlight, jobStarted, lastJob, jobsToday, jobsTotal,
    lastJobSeconds, failures, disk, storeJobs, resets, memPeak, pidsPeak,
    memMaxEvents, oomKills,
  ] = await Promise.all([
    instant(CI.markerPresent, signal),
    instantBy(CI.heartbeat, "lane", signal),
    instantBy(CI.inFlight, "lane", signal),
    instantBy(CI.jobStarted, "lane", signal),
    instantBy(CI.lastJob, "lane", signal),
    instantBy(CI.jobsToday, "lane", signal),
    instantBy(CI.jobsTotal, "lane", signal),
    instantBy(CI.lastJobSeconds, "lane", signal),
    instantBy(CI.failures, "lane", signal),
    instantBy(CI.laneDisk, "lane", signal),
    instantBy(CI.storeJobs, "lane", signal),
    instantBy(CI.storeResets, "lane", signal),
    instantBy(CI.laneMemPeak, "lane", signal),
    instantBy(CI.lanePidsPeak, "lane", signal),
    instantBy(CI.laneMemMaxEvents, "lane", signal),
    instantBy(CI.laneOomKills, "lane", signal),
  ]);

  const now = host.now;

  // THE LANE LIST IS THE UNION OF EVERY SERIES, NOT ONE OF THEM. Keying on any
  // single map would drop a lane whose marker exists but whose heartbeat has
  // gone - which is precisely the lane worth looking at. The set is closed at
  // three by CI_LANES in the collector and by app-ci.slice's cpuset arithmetic,
  // so this cannot grow unbounded.
  const names = new Set<string>();
  for (const m of [heartbeat, inFlight, jobsTotal, disk, storeJobs]) {
    for (const key of m.keys()) names.add(key);
  }

  const lanes: Lane[] = [...names]
    .sort((a, b) => Number(a) - Number(b))
    .map((lane) => {
      const beat = heartbeat.get(lane);
      const heartbeatAge = beat === undefined ? Number.NaN : now - beat;
      // `undefined`, not `?? 0`. See the header, and the collector's own help.
      const running = inFlight.get(lane);
      const failed = failures.get(lane) ?? Number.NaN;
      const started = jobStarted.get(lane);
      const last = lastJob.get(lane);

      const { tone, state } = laneTone(heartbeatAge, running, failed);

      return {
        lane,
        tone,
        state,
        heartbeatAge,
        inFlight: running,
        // Absent while idle by design, so this is NaN rather than 0.
        jobAge: started === undefined ? Number.NaN : now - started,
        lastJobAge: last === undefined ? Number.NaN : now - last,
        lastJobSeconds: lastJobSeconds.get(lane) ?? Number.NaN,
        jobsToday: jobsToday.get(lane) ?? Number.NaN,
        jobsTotal: jobsTotal.get(lane) ?? Number.NaN,
        failures: failed,
        disk: disk.get(lane) ?? Number.NaN,
        storeJobs: storeJobs.get(lane) ?? Number.NaN,
        resets: resets.get(lane) ?? Number.NaN,
        memPeak: memPeak.get(lane) ?? Number.NaN,
        pidsPeak: pidsPeak.get(lane) ?? Number.NaN,
        memMaxEvents: memMaxEvents.get(lane) ?? Number.NaN,
        oomKills: oomKills.get(lane) ?? Number.NaN,
      };
    });

  return { lanes, markerPresent: value(markerPresent[0]?.value) };
}, 30_000);

const lanes = computed(() => rack.data.value?.lanes ?? []);

// --- the lead ----------------------------------------------------------------

/** THE HEADLINE WAS ALREADY ON THIS PAGE, spread across three cells of column
 *  five. See src/lanes.ts for the four states, two of which needed writing. */
const lead = computed(() =>
  laneLead(lanes.value, rack.data.value?.markerPresent ?? Number.NaN),
);

const tally = computed(() => laneTally(lanes.value));

/**
 * THE PROVENANCE OF EVERY READING BELOW IT, rather than a fourth condition.
 * These series are the collector's reading of the lanes' own markers, so if the
 * drivers have stopped writing then nothing on this page is a current claim -
 * the same argument the conduct heartbeat makes at the top of /agents/fleet.
 *
 * The STALEST lane, because one driver having stopped is what this must catch,
 * and 300s is ci.heartbeat's own threshold against a 30s poll.
 */
const beat = computed(() => {
  const ages = lanes.value.map((l) => l.heartbeatAge).filter((a) => Number.isFinite(a));
  const age = ages.length ? Math.max(...ages) : Number.NaN;
  return { age, ...heartbeatTone(age, HEARTBEAT_STALE_S) };
});

// --- charts ------------------------------------------------------------------
// FOUR RANGES ON ONE `options`, AND THAT IS LOAD-BEARING RATHER THAN TIDY.
// useCrosshair holds a TIME, and every plot resolves it against its own
// from/to - so a plot fetched on a different window would draw its cursor at a
// different instant while looking exactly as correct. Hover the disk chart and
// the same second is marked on jobs, memory and processes.

function laneSeries(rows: RangeSeries[]): ChartSeries[] {
  return rows
    .slice()
    .sort((a, b) => Number(a.metric.lane) - Number(b.metric.lane))
    .map((s, i) => ({
      points: toPoints(s.values),
      label: `lane ${s.metric.lane}`,
      tone: LANE_TONES[i % LANE_TONES.length],
    }));
}

const charts = usePoll(async (signal) => {
  const options = { window: win.value.seconds, step: win.value.step, signal };
  const [
    disk, jobs, sliceMem, slicePids, slicePresent, sliceHigh, sliceMax, slicePeak, slicePidsMax,
  ] = await Promise.all([
    range(CI.laneDisk, options),
    range(CI.jobsPerHour, options),
    range(CI.sliceMemory, options),
    // FETCHED SINCE THE PAGE WAS WRITTEN AND DRAWN NOWHERE until 2026-09-07 - a
    // range query made twice a minute whose result was assigned and never read.
    range(CI.slicePids, options),
    instant(CI.slicePresent, signal),
    instant(CI.sliceMemoryHigh, signal),
    instant(CI.sliceMemoryMax, signal),
    instant(CI.sliceMemoryPeak, signal),
    instant(CI.slicePidsMax, signal),
  ]);

  return {
    disk: laneSeries(disk),
    jobs: laneSeries(jobs),
    sliceMem: sliceMem[0] ? toPoints(sliceMem[0].values) : [],
    slicePids: slicePids[0] ? toPoints(slicePids[0].values) : [],
    // ABSENT WHEN UNLIMITED rather than zero, which is exactly what
    // ci.slice_limits exists to catch - so NaN here leaves MetricChart to fall
    // back on the data's own extent instead of collapsing the frame.
    slicePresent: value(slicePresent[0]?.value),
    sliceHigh: value(sliceHigh[0]?.value),
    sliceMax: value(sliceMax[0]?.value),
    slicePeak: value(slicePeak[0]?.value),
    slicePidsMax: value(slicePidsMax[0]?.value),
  };
}, 30_000);

watch(win, () => {
  void charts.refresh();
});

const c = computed(() => charts.data.value);
const from = computed(() => host.now - win.value.seconds);

/** The band's aside. DERIVED FROM THE PICKER, which is the only place the span
 *  can be stated without being able to drift. */
const windowLabel = computed(() => `last ${win.value.label}`);

/**
 * "unlimited" and "the slice is empty" are different facts and look identical.
 *
 * Every slice gauge is absent in both cases, and slicePresent is the only thing
 * that tells them apart - which is what its own HELP text says and what this
 * page could not do at all until it started reading it. An unlimited control is
 * the silent failure ci.slice_limits exists to catch; an empty slice is a host
 * with no CI running, which is not a fault.
 */
function ceilingNote(ceiling: number | undefined, name: string): string {
  if (Number.isFinite(ceiling)) return "";
  if (c.value?.slicePresent === 1) {
    return `${name} is unlimited on this slice, which is what ci.slice_limits exists to catch.`;
  }
  if (c.value?.slicePresent === 0) return "The slice has no live cgroup, so nothing is running in it.";
  return `${name} was not read in the last scrape.`;
}

// --- the numbers that are not per-lane ---------------------------------------

const fleet = usePoll(async (signal) => {
  const [
    lanesActive, lanesFailed, imageAge, versionAge, toolcache, baselines,
    stateBytes, runsBytes, unlimited, networks, strays, sliceOom,
  ] = await Promise.all([
    instant(CI.lanesActive, signal),
    instant(CI.lanesFailed, signal),
    instant(CI.imageAgeDays, signal),
    instant(CI.versionCheckAgeDays, signal),
    instant(CI.toolcacheStale, signal),
    instant(CI.artifactBaselines, signal),
    instant(CI.artifactStateBytes, signal),
    instant(CI.artifactRunsBytes, signal),
    instant(CI.sliceUnlimited, signal),
    instant(CI.networks, signal),
    instant(CI.strays, signal),
    instant(CI.sliceOom, signal),
  ]);
  const one = (r: InstantSeries[]) => value(r[0]?.value);
  return {
    lanesActive: one(lanesActive),
    lanesFailed: one(lanesFailed),
    imageAge: one(imageAge),
    versionAge: one(versionAge),
    toolcache: one(toolcache),
    baselines: one(baselines),
    stateBytes: one(stateBytes),
    runsBytes: one(runsBytes),
    unlimited: one(unlimited),
    networks: one(networks),
    strays: one(strays),
    sliceOom: one(sliceOom),
    // THE TWO FACTS WITH NO METRIC ANYWHERE. source_status mints a series from a
    // string only when the key ends _at, so these fall through every branch and
    // exist in status.json alone - which is why this page shows passing checks
    // rather than only failing ones.
    runtimeSplit: host.fact("github_runner_runtime_split") as string | null,
    rootLabel: host.fact("github_runner_root_label") as string | null,
  };
}, 60_000);

const f = computed(() => fleet.data.value);

/** LANES THE BATTERY COUNTS THAT THE TABLE CANNOT DRAW. See src/lanes.ts: a lane
 *  whose driver never got far enough to write a marker appears nowhere, and it
 *  is the lane most worth seeing. */
const silent = computed(() =>
  silentLanes(lanes.value.length, f.value?.lanesActive ?? Number.NaN, f.value?.lanesFailed ?? Number.NaN),
);

const rows = computed(() => hostRows(f.value ?? null, host.byId));
const hostCount = computed(() => hostTally(rows.value));

const rail = (tone: Tone) => `var(--${tone})`;

// --- the conditions ----------------------------------------------------------

/** The worst lane's disk, which is what ci.lane_disk grades on too. */
const worstDisk = computed(() => {
  const all = lanes.value.map((l) => l.disk).filter((d) => Number.isFinite(d));
  return all.length ? Math.max(...all) : Number.NaN;
});

const sliceNow = computed(() => latest(c.value?.sliceMem ?? []));
const oomKilled = computed(() => (f.value?.sliceOom ?? 0) > 0);
const memoryTone = computed<"ok" | "fail">(() => (oomKilled.value ? "fail" : "ok"));

const memorySub = computed(() => {
  const oom = f.value?.sliceOom ?? Number.NaN;
  // ABSENT IS NOT ZERO, and this is the line that has to say so - the chart's
  // tone cannot, because MetricChart has only three.
  if (!Number.isFinite(oom)) return "OOM kills not measured";
  return oom > 0 ? `${fmt.number(oom)} OOM kills` : "no OOM kills";
});

const noBaselines = computed(() => f.value?.baselines === 0);

/** BUILT HERE RATHER THAN PLURALISED IN THE TEMPLATE. A `<span v-if>` carrying
 *  the "s" renders "0 baseline s": the newline before it is a text node, and
 *  Vue keeps it. */
const baselineCount = computed(() => {
  const b = f.value?.baselines ?? Number.NaN;
  return `${fmt.number(b)} baseline${b === 1 ? "" : "s"}`;
});

// --- tooltips ----------------------------------------------------------------

function ledTip(l: Lane) {
  const lines = [l.state, `home-server-github-runner@${l.lane}`];
  if (Number.isFinite(l.failures) && l.failures > 0) {
    lines.push(`${fmt.number(l.failures)} failed attempt(s) to mint an identity`);
  }
  return {
    title: `lane ${l.lane}`,
    lines,
    caveat:
      l.tone === "off"
        ? "Grey is not green. A lane is invisible to every other page here - no container row, no health status, no failed unit - so this means nothing is reporting, not that nothing is wrong."
        : undefined,
  };
}

function jobTip(l: Lane) {
  if (l.inFlight === 1) {
    return {
      title: "running a job",
      lines: [`${fmt.duration(l.jobAge)} elapsed`, `RuntimeMaxSec is ${fmt.duration(RUNTIME_MAX_S)}`],
      caveat:
        l.jobAge > JOB_STUCK_S
          ? "Past the threshold ci.job_stuck grades on, which is twice RuntimeMaxSec. The scope should already have killed this."
          : undefined,
    };
  }
  return {
    title: "idle",
    lines: [
      Number.isFinite(l.lastJobAge) ? `last job ${fmt.since(host.now - l.lastJobAge)}` : "no job recorded",
      Number.isFinite(l.lastJobSeconds) ? `it took ${fmt.duration(l.lastJobSeconds)}` : "duration unknown",
    ],
    caveat:
      l.inFlight === undefined
        ? "There is no in-flight series for this lane at all, which means it has never started - not that it is idle."
        : undefined,
  };
}

const diskTip = (l: Lane) => ({
  title: "lane disk",
  lines: [`${fmt.bytes(l.disk)} of ${fmt.bytes(LANE_DISK_MAX)}`, "home, tool cache, nested image store, runner tree"],
  caveat:
    "A sawtooth here is the design working: the driver clears the regenerable parts when a lane passes its budget.",
});

const storeTip = (l: Lane) => ({
  title: "store window",
  lines: [
    `${fmt.number(l.storeJobs)} of ${STORE_MAX_JOBS} jobs since the last reset`,
    `${fmt.number(l.resets)} resets in total`,
  ],
  caveat:
    "The reset counter sums all three reasons - heal, budget and window. Only ci.lane_store's message names which one fired last.",
});

const memTip = (l: Lane) => ({
  title: "lane peaks",
  lines: [
    `memory ${fmt.bytes(l.memPeak)}, pids ${fmt.number(l.pidsPeak)}`,
    `${fmt.number(l.memMaxEvents)} refused at MemoryMax, ${fmt.number(l.oomKills)} killed`,
  ],
  caveat:
    "The memory peak includes page cache, so a lane at its ceiling after a dependency install is reclaim working. The refusal count, not the peak, is what justifies raising a ceiling.",
});

const leadTip = computed(() => ({
  title: "jobs today",
  lines: [
    lanes.value.map((l) => `lane ${l.lane}: ${fmt.number(l.jobsToday)}`).join(", ") || "no lane reporting",
    "a gauge the driver resets at midnight",
  ],
  caveat:
    "Nothing here comes from GitHub. A job queued and never picked up is invisible: the runner PAT must never enter a container, and an hourly poll of api.github.com was argued against rather than forgotten.",
}));

const diskCondTip = computed(() => ({
  title: "lane disk",
  lines: [
    `worst lane ${fmt.bytes(worstDisk.value)} of ${fmt.bytes(LANE_DISK_MAX)}`,
    "what ci.lane_disk grades on, and what triggers a budget reset",
  ],
  caveat:
    "Disk was never the constraint here - a lane holds about 4.7 GB in normal use and /var has over 150 GB free. The budget exists to bound a store that grows, not to protect the volume.",
}));

const memoryTip = computed(() => ({
  title: "slice memory",
  lines: [
    `${fmt.bytes(sliceNow.value)} of app-ci.slice`,
    `MemoryHigh ${fmt.bytes(c.value?.sliceHigh ?? Number.NaN)}, MemoryMax ${fmt.bytes(c.value?.sliceMax ?? Number.NaN)}`,
  ],
  caveat:
    "A ceiling is not usage. These are what the slice may take, not what it does - reading one as the other nearly cost a second slice. The per-lane limits bind first: three lanes at 3,584M is 10,752M against the slice's 9,984M.",
}));

const baselineTip = computed(() => ({
  title: "coverage baselines",
  lines: [
    `${fmt.number(f.value?.baselines ?? Number.NaN)} baselines.json under state/`,
    `${fmt.bytes(f.value?.stateBytes ?? Number.NaN)} state, ${fmt.bytes(f.value?.runsBytes ?? Number.NaN)} run scratch`,
  ],
  caveat:
    "Zero is the loud case. upskald's gate passes on an absent baseline and fails only on an unavailable one, so an empty store is a green pipeline enforcing nothing at all.",
}));

const CAVEATS: Record<string, string> = {
  "ci.lanes_alive":
    "This is systemctl's count, not the markers'. A lane whose driver never got far enough to write one is enabled and active here and appears in no series at all, which is the difference the sentence under the table names.",
  "ci.runner_version":
    "A lane self-updates when GitHub requires it, so running a version behind upstream is a note. The stamp going stale means nothing has asked upstream in a fortnight, which is the finding.",
  "ci.toolcache_seed":
    "The seed guard once keyed on existence rather than a version, so a lane was seeded once ever and work that shipped in the image reached neither deployed lane with every signal green.",
  "ci.artifact_store":
    "state/ is swept by nothing and backed up; runs/ is swept at 30 days. The store is a sibling of lanes/ and not a child, or a self-heal would take the coverage ratchet with it.",
  "ci.runtime_dir":
    "libpod records its runroot in db.sql at the root of the graph root and uses that over both XDG_RUNTIME_DIR and storage.conf, silently - so this asks the running engine rather than reading the file back.",
  "ci.slice_limits":
    "Six controls, and a cpuset is not exclusive: app-ci.slice's 4-9 is shared with the rest of the host rather than taken from it. Throttling at MemoryHigh is not the signal that the sizing is wrong.",
  "ci.runner_isolation":
    "A lane's network is created by the driver rather than declared in stacks/, which is what keeps net-ci-* out of the agent fleet's own isolation check and this whole change out of topology.ts.",
  "ci.fleet_root_label":
    "container_file_t is what lets a lane read the tree it was given, and any restorecon undoes it silently. Type inheritance is what carries it to every file created afterwards.",
};

function rowTip(r: HostRow) {
  const check = host.byId.get(r.id);
  return {
    title: r.name,
    lines: [
      `${r.value} - ${r.id}`,
      check ? `${check.status}: ${check.message}` : "not measured in the last run",
    ],
    caveat: CAVEATS[r.id],
  };
}

/** The readings the priority ladder drops by 640, folded into the cell that
 *  survives. Built here rather than in the template so the empty case is a
 *  single dash and not four separators around nothing. */
function foldLine(l: Lane): string {
  const parts = [
    Number.isFinite(l.jobsToday) ? `${fmt.number(l.jobsToday)} today` : null,
    Number.isFinite(l.jobsTotal) ? `${fmt.number(l.jobsTotal)} total` : null,
    Number.isFinite(l.disk) ? fmt.bytes(l.disk) : null,
    Number.isFinite(l.storeJobs) ? `${fmt.number(l.storeJobs)}/${STORE_MAX_JOBS}` : null,
  ].filter(Boolean);
  return parts.length ? parts.join(" - ") : "nothing reported";
}
</script>

<template>
  <div class="page">
    <Teleport defer to="#toolbar">
      <span class="mono tnote">read only</span>
      <WindowPicker />
    </Teleport>

    <!-- THE HEADLINE LEADS, AND IT DID NOT USED TO. This page opened on a bare
         label and an eleven-column rack, with the one reading that says the
         fleet is working spread across three cells of column five. -->
    <Band label="Today">
      <template #aside>
        <span class="beat">
          <StatusDot :tone="beat.tone" :size="6" />
          <span class="mono">markers
            {{ Number.isFinite(beat.age) ? `${fmt.coarse(beat.age)} old` : "never written" }}
          </span>
        </span>
      </template>

      <PanelBox :stale="metricsStale">
        <div class="lead" v-bind="tip.hover('ci-lead', leadTip)">
          <StatusDot :tone="lead.tone" :live="lead.live" :size="9" />
          <span class="reading mono">{{ lead.text }}</span>
        </div>

        <!-- NO PROGRESS BAR. There is no denominator for "jobs today", and a
             bare track is the encoding this store reserves for "in progress,
             ratio unknown" - which is the defect being removed one band down. -->
        <p class="lead-sub mono">{{ lead.sub }}</p>

        <div class="conds">
          <div class="cond" v-bind="tip.hover('ci-disk-cond', diskCondTip)">
            <span class="label">lane disk</span>
            <span class="mono cvalue">
              {{ fmt.bytes(worstDisk) }} of {{ fmt.bytes(LANE_DISK_MAX) }}
            </span>
            <span class="mono sub">largest of {{ lanes.length || "no" }} lanes</span>
          </div>

          <div class="cond" v-bind="tip.hover('ci-mem-cond', memoryTip)">
            <span class="label">slice memory</span>
            <span class="mono cvalue">
              {{ fmt.bytes(sliceNow) }} / {{ fmt.bytes(c?.sliceMax ?? Number.NaN) }}
            </span>
            <span class="mono sub" :class="{ bad: oomKilled }">{{ memorySub }}</span>
          </div>

          <div class="cond" v-bind="tip.hover('ci-baselines', baselineTip)">
            <span class="label">artifact store</span>
            <span class="mono cvalue" :class="{ bad: noBaselines }">{{ baselineCount }}</span>
            <span class="mono sub">
              {{ fmt.bytes(f?.stateBytes ?? Number.NaN) }} state,
              {{ fmt.bytes(f?.runsBytes ?? Number.NaN) }} runs
            </span>
          </div>
        </div>
      </PanelBox>
    </Band>

    <!-- THE RACK IS A TABLE NOW, which its own comment asked for: eleven
         columns at a 748px floor, panned sideways below that, with the column
         labels living only in tooltips. The shared recipe brings a header row,
         the p4/p3/p2 ladder and a phone rung that folds rather than scrolls.

         THE ELEVENTH COLUMN IS GONE. `mint fail` was empty on every healthy
         lane, and laneTone already renders `mint failing` in the state pill -
         the count moved into the row's own tooltip. -->
    <Band label="Lanes">
      <template #aside><span class="mono">{{ tally }}</span></template>

      <PanelBox :stale="metricsStale">
        <p v-if="lead.tone === 'off' && !lanes.length" class="empty mono">
          No lane has ever written a marker on this host. That is a host with CI disabled, not a
          broken one - every ci check reports it as a note.
        </p>

        <table v-else class="tbl">
          <thead>
            <tr>
              <th class="c-rail" />
              <th class="c-lane">Lane</th>
              <th class="c-state">State</th>
              <th class="c-job p2">Job</th>
              <th class="c-today r p2">Today</th>
              <th class="c-total r p3">Total</th>
              <th class="c-last r p3">Last</th>
              <th class="p2">Disk</th>
              <th class="c-store p4">Store</th>
              <th class="c-peak r p4">Peak</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="l in lanes" :key="l.lane" class="hov" :style="{ '--rail': rail(l.tone) }">
              <td class="rail" v-bind="tip.hover(`ci-led-${l.lane}`, ledTip(l))">
                <StatusDot :tone="l.tone" :live="l.inFlight === 1" :size="6" glow />
              </td>

              <td class="lname mono">
                lane {{ l.lane }}
                <!-- The readings the ladder has dropped by 640, in the cell that
                     survives. Its own class, never `.sub`: a scoped rule
                     compiles to class-plus-attribute and would outrank
                     base.css's `.fold2 { display: none }`, which is the trap
                     the agents table paid for on `.msg`. -->
                <span class="fold2 lfold">{{ foldLine(l) }}</span>
              </td>

              <td><StatePill :label="l.state" :tone="l.tone" size="sm" /></td>

              <td class="p2">
                <!-- ONLY IN FLIGHT. `ratio: null` draws a bare track, which is
                     this store's encoding for "in progress, ratio unknown" - so
                     an idle lane was announcing an unmeasurable job. The
                     contract was right and the call site was wrong, exactly as
                     it was on the round board. -->
                <div v-if="l.inFlight === 1" class="meter" v-bind="tip.hover(`ci-job-${l.lane}`, jobTip(l))">
                  <ProgressBar
                    :ratio="Number.isFinite(l.jobAge) ? l.jobAge / RUNTIME_MAX_S : null"
                    :tone="l.jobAge > JOB_STUCK_S ? 'warn' : 'ok'"
                    live
                  />
                  <span class="mono sub">{{ fmt.duration(l.jobAge) }}</span>
                </div>
                <span v-else class="mono dim" v-bind="tip.hover(`ci-job-${l.lane}`, jobTip(l))">
                  {{ fmt.NO_DATA }}
                </span>
              </td>

              <td class="mono num r p2">{{ fmt.number(l.jobsToday) }}</td>
              <td class="mono num dim r p3">{{ fmt.number(l.jobsTotal) }}</td>
              <td class="mono num dim r p3">{{ fmt.duration(l.lastJobSeconds) }}</td>

              <td class="p2">
                <div class="meter" v-bind="tip.hover(`ci-disk-${l.lane}`, diskTip(l))">
                  <ProgressBar
                    :ratio="Number.isFinite(l.disk) ? l.disk / LANE_DISK_MAX : null"
                    :tone="l.disk / LANE_DISK_MAX > 0.9 ? 'warn' : 'ok'"
                  />
                  <span class="mono sub">{{ fmt.bytes(l.disk) }}</span>
                </div>
              </td>

              <td class="p4">
                <div class="meter" v-bind="tip.hover(`ci-store-${l.lane}`, storeTip(l))">
                  <ProgressBar
                    :ratio="Number.isFinite(l.storeJobs) ? l.storeJobs / STORE_MAX_JOBS : null"
                    tone="ok"
                  />
                  <span class="mono sub">{{ fmt.number(l.storeJobs) }}/{{ STORE_MAX_JOBS }}</span>
                </div>
              </td>

              <td class="mono num r p4" v-bind="tip.hover(`ci-peak-${l.lane}`, memTip(l))">
                <span :class="{ bad: l.memMaxEvents > 0 || l.oomKills > 0 }">
                  {{ fmt.bytes(l.memPeak) }}
                </span>
              </td>
            </tr>
          </tbody>
        </table>

        <!-- Amber, not grey: a lane the battery can see and this table cannot is
             a finding rather than a footnote. -->
        <p v-if="silent > 0" class="silent mono">
          {{ silent }} enabled lane(s) have written no marker at all, so they appear nowhere above -
          the driver never got far enough. ci.lanes_alive names the exit code.
        </p>

        <p class="note">
          The marker file is the only witness this fleet has. A lane carries an ephemeral label so
          both container sources skip it, it runs with --rm so nothing is left failed, and it
          declares no health check - so a wedged lane leaves no failed unit and no unhealthy
          container anywhere else on this dashboard.
        </p>
      </PanelBox>
    </Band>

    <!-- THE BAND NAMES THE AXIS AND NOT THE SPAN, so the picker cannot make its
         label false; the span is in the aside, derived from the picker itself.
         Four plots on one window and therefore on one cursor: hover the disk
         chart and the same second is marked on the other three. -->
    <Band label="Over time" :cols="2" stretch>
      <template #aside><span class="mono">{{ windowLabel }}</span></template>

      <PanelBox label="Lane disk" :stale="metricsStale">
        <template #aside><span class="mono">budget {{ fmt.bytes(LANE_DISK_MAX) }}</span></template>
        <MetricChart
          :series="c?.disk ?? []"
          :from="from"
          :to="host.now"
          :height="132"
          :grid="3"
          y-axis
          x-axis
          legend
          :tick-base="1024"
          :format="fmt.bytes"
          :y-max="LANE_DISK_MAX"
        />
        <p class="note">
          The vertical drops are resets. A sawtooth is the driver clearing a lane that passed its
          budget, which is the design working rather than a fault.
        </p>
      </PanelBox>

      <PanelBox label="Jobs per hour" :stale="metricsStale">
        <template #aside><span class="mono">per lane</span></template>
        <MetricChart
          :series="c?.jobs ?? []"
          :from="from"
          :to="host.now"
          :height="132"
          :grid="3"
          y-axis
          x-axis
          legend
          :format="(v: number) => fmt.number(v, 0)"
        />
        <p class="note">
          increase() over the jobs counter, not a rate over jobs_today - that one is a gauge which
          resets at midnight, and a rate over it would report a spike every night at 00:00.
        </p>
      </PanelBox>

      <PanelBox label="Slice memory" :stale="metricsStale">
        <template #aside><span class="mono">app-ci.slice</span></template>
        <MetricChart
          :points="c?.sliceMem ?? []"
          :from="from"
          :to="host.now"
          :height="132"
          :grid="3"
          y-axis
          x-axis
          :tick-base="1024"
          :format="fmt.bytes"
          :y-max="c?.sliceMax"
          :tone="memoryTone"
        />
        <p class="note">
          A ceiling is not usage: the frame is what the slice may take, not what it needs. The
          high-water mark since it was created is
          {{ fmt.bytes(c?.slicePeak ?? Number.NaN) }}, which is the number app-ci.slice's own
          comment asks to be re-derived from.
          {{ ceilingNote(c?.sliceMax, "MemoryMax") }}
        </p>
      </PanelBox>

      <!-- COLLECTED, FETCHED TWICE A MINUTE AND DRAWN NOWHERE until now: the
           range was assigned into the poll's result and never read by the
           template. TasksMax is what binds first when it binds, and the symptom
           is "fork: Resource temporarily unavailable" raised by something with
           no apparent connection to it. -->
      <PanelBox label="Slice processes" :stale="metricsStale">
        <template #aside><span class="mono">app-ci.slice</span></template>
        <MetricChart
          :points="c?.slicePids ?? []"
          :from="from"
          :to="host.now"
          :height="132"
          :grid="3"
          y-axis
          x-axis
          :format="(v: number) => fmt.number(v, 0)"
          :y-max="c?.slicePidsMax"
        />
        <p class="note">
          Tasks in the slice against TasksMax, peaking at
          {{ fmt.number(peak(c?.slicePids ?? [])) }} in this window. This is what binds first when
          it binds, and the symptom is a fork failure raised by something unrelated.
          {{ ceilingNote(c?.slicePidsMax, "TasksMax") }}
        </p>
      </PanelBox>
    </Band>

    <!-- SIX TILES, A CONTAINMENT PANEL AND A FACTS STRIP BECAME ONE TABLE. The
         tiles were a grid of cards, which the design system names as the thing a
         list of records must never be; Containment reproduced FindingsPanel's
         markup directly above a FindingsPanel already carrying those same three
         ids, and its own note admitted it.

         FIVE ci CHECKS ARE DELIBERATELY NOT HERE. heartbeat, job_stuck,
         lane_disk, lane_headroom and lane_store are cross-lane summaries of the
         table two bands up, where the same numbers are drawn per lane with a bar
         behind them. The battery's verdict on all fourteen is one panel down. -->
    <Band label="Host side">
      <template #aside>
        <span class="count">{{ hostCount.total }}</span> facts,
        <span class="count">{{ hostCount.notPassing }}</span> not passing
      </template>

      <PanelBox :stale="metricsStale">
        <table class="tbl">
          <thead>
            <tr>
              <th class="c-rail" />
              <th class="c-name">Fact</th>
              <th class="c-val p2">Reading</th>
              <th class="p2">Finding</th>
            </tr>
          </thead>
          <tbody>
            <tr
              v-for="r in rows"
              :key="r.id"
              class="hov"
              :style="{ '--rail': rail(r.tone) }"
              v-bind="tip.hover(`tip-${r.id}`, rowTip(r))"
            >
              <td class="rail"><StatusDot :tone="r.tone" :size="6" /></td>
              <td class="name">
                {{ r.name }}
                <span class="fold2 mono val">{{ r.value }}</span>
                <span class="fold2 ffind">{{ r.finding }}</span>
              </td>
              <td class="mono val p2">{{ r.value }}</td>
              <!-- The clamp is on an inner div, never on the cell: `display:
                   -webkit-box` on a <td> replaces `display: table-cell` and the
                   column stops lining up. -->
              <td class="p2"><div class="msg">{{ r.finding }}</div></td>
            </tr>
          </tbody>
        </table>
        <p class="note">
          Nothing here comes from GitHub. Queue depth and runner online status are not measured on
          this host: the runner PAT must never enter a container, and an hourly poll of
          api.github.com was argued against rather than forgotten. These lanes are what is
          observable, not the whole picture.
        </p>
      </PanelBox>
    </Band>

    <FindingsPanel label="CI checks" section="ci" all />
  </div>
</template>

<style scoped>
.page {
  padding: 16px var(--pad-page) var(--pad-page);
  display: flex;
  flex-direction: column;
  gap: var(--gap-lg);
}

/* --- the header ----------------------------------------------------------- */

/* The stalest marker, in the band's own head row. Quiet on purpose: it is only
   interesting when it is not fresh, and its tone says that without size. */
.beat {
  display: inline-flex;
  align-items: center;
  gap: 7px;
  font: var(--t-mono-sm);
  color: var(--fg-5);
}

.lead {
  display: flex;
  align-items: center;
  gap: 10px;
  min-width: 0;
}

/* --t-mono-xl, which tokens.css describes as "the one headline reading". One
   per view is the whole point of it, and this view had none. */
.reading {
  font: var(--t-mono-xl);
  color: var(--fg);
}

.lead-sub {
  margin-top: 7px;
  font: var(--t-mono-sm);
  color: var(--fg-5);
}

/* Three equal columns above 900, packed left below it, and a label-left readout
   below 640 - the round board's recipe, unchanged. */
.conds {
  display: grid;
  grid-template-columns: repeat(3, minmax(0, 1fr));
  gap: var(--gap) var(--gap-lg);
  margin-top: 15px;
  padding-top: 14px;
  border-top: 1px solid var(--border-divider);
}

.cond {
  display: flex;
  flex-direction: column;
  gap: 5px;
  min-width: 0;
}

.label {
  font: var(--t-label);
  letter-spacing: var(--track-label);
  text-transform: uppercase;
  color: var(--fg-5);
}

.cvalue {
  display: flex;
  align-items: center;
  gap: 7px;
  font: var(--t-mono-md);
  color: var(--fg-2);
}

.sub {
  font: var(--t-mono-xs);
  color: var(--fg-5);
}

.bad {
  color: var(--fail-text);
}

.dim {
  color: var(--fg-5);
}

/* --- the lane table ------------------------------------------------------- */

.c-rail {
  width: 30px;
}

.c-lane {
  width: 78px;
}

/* MEASURED IN THE BROWSER, NOT CHOSEN. "heartbeat stale" is the widest label
   laneTone can return and needs 119px at the pill's own --t-mono-xs plus its
   padding, on top of 24px of cell padding. The first draft was 104 and
   truncated "running a job" and "mint failing" at every width - and a pill is
   the one chip-shaped element here whose whole job is a word. */
.c-state {
  width: 143px;
}

.c-job {
  width: 130px;
}

.c-today {
  width: 66px;
}

.c-total {
  width: 72px;
}

.c-last {
  width: 76px;
}

/* NO WIDTH ON EITHER METER, AND THAT IS WHAT MAKES THEM COMPARABLE. Under
   `table-layout: fixed` the unwidened columns share what is left equally, so
   disk and store get the same track and their bars can be read against each
   other. Given a width, store took 104px while disk took 526 - two readings of
   the same kind, one of them five times the other, for no reason a reader could
   see. */

.c-peak {
  width: 92px;
}

.lname {
  font: var(--t-mono-sm);
  color: var(--fg-2);
}

.num {
  font: var(--t-mono-xs);
  color: var(--fg-3);
}

/* A bar over its own reading, which is the shape the rack used and the one part
   of it worth keeping: the number says what, the bar says how far through. */
.meter {
  display: flex;
  flex-direction: column;
  gap: 4px;
  min-width: 0;
}

/* THE FOLDED READINGS ARE NOT `.sub`, AND THAT IS THE WHOLE REASON THEY HAVE A
   CLASS OF THEIR OWN. A scoped rule compiles to `.sub[data-v-x]` - class plus
   attribute - which outranks base.css's `.fold2 { display: none }`, so the
   folded copy would render at every width and every lane would carry its
   readings twice. The agents table paid for exactly this on `.msg`. Nothing in
   .lfold sets `display`, so the fold governs it. */
.lfold {
  margin-top: 4px;
  font: var(--t-mono-xs);
  color: var(--fg-5);
}

/* --- the host table ------------------------------------------------------- */

.c-name {
  width: 150px;
}

/* MEASURED, LIKE THE STATE PILL ABOVE IT. "3 networks, 0 stray" is the widest
   reading at --t-mono-md and needs 176px with the cell's own padding; the first
   draft was 136 and wrapped that one, "2 active, 1 failed" and
   "container_file_t". The finding column takes the difference and still fits
   every one of its sentences on one line at 1360. */
.c-val {
  width: 176px;
}

.name {
  font: var(--t-ui-sm);
  color: var(--fg-3);
}

.val {
  font: var(--t-mono-md);
  color: var(--fg-2);
}

/* Two lines, which is FindingsPanel's clamp - the only other place here that has
   to fit a check's prose into a table cell. */
.msg {
  font: var(--t-ui-sm);
  color: var(--fg-2);
  display: -webkit-box;
  -webkit-line-clamp: 2;
  line-clamp: 2;
  -webkit-box-orient: vertical;
  overflow: hidden;
}

/* Not clamped: at 640 this cell is the whole table and the finding is the only
   prose in it, so two lines there would hide what the wide layout shows whole. */
.ffind {
  font: var(--t-ui-sm);
  color: var(--fg-2);
}

.name .fold2 {
  margin-top: 4px;
}

/* --- shared --------------------------------------------------------------- */

.note {
  margin-top: 12px;
  padding-top: 11px;
  border-top: 1px solid var(--border-divider);
  font: var(--t-ui-xs);
  color: var(--fg-5);
}

/* THE TOOLBAR LINE IS NOT A PANEL FOOTNOTE, and it borrowed `.note` from one -
   so "read only" was teleported into the shell header carrying a top border
   and 10px of margin, which drew a stray rule above it and made this page's
   header a pixel taller than every other. */
.tnote {
  font: var(--t-mono-sm);
  color: var(--fg-5);
}

.empty {
  font: var(--t-mono-sm);
  color: var(--fg-dim);
  padding: 8px 4px;
}

.silent {
  margin-top: 11px;
  padding-top: 10px;
  border-top: 1px solid var(--line);
  font: var(--t-mono-xs);
  color: var(--warn);
}

/* --- the tablet ----------------------------------------------------------- */

@media (max-width: 900px) {
  .conds {
    display: flex;
    flex-wrap: wrap;
  }
}

/* --- the phone ------------------------------------------------------------ */

@media (max-width: 640px) {
  /* THE READINGS ARE IN THE LANE CELL NOW, so it stops being a 78px column and
     becomes the flexible one. THE STATE PILL IS WHAT `today` MAKES ROOM FOR:
     rail, lane and state is 173px of a 330px table, leaving the lane 157px for
     its name and its folded line; keeping the count as a fourth column left 91,
     which is not "lane 1". On a phone the health verdict outranks the
     throughput, and the headline at the top of the page carries the sum. */
  .c-lane,
  .c-name {
    width: auto;
  }

  /* THE RAIL NEEDS ITS WIDTH BACK ON THE CELL ONCE THE HEADER IS GONE. Under
     `table-layout: fixed` the column widths come from the first row, and
     `display: none` on the thead makes that the first BODY row - which carries
     no widths, so the surviving columns split evenly and every finding wraps
     inside half a phone. The th hints still govern above this rung. */
  .tbl td.rail {
    width: 30px;
  }

  /* A header row over two columns names very little, and neither survivor holds
     only what its label says - the lane cell has taken the disk and the store.
     The agents table and the round board both drop their thead here. */
  .tbl thead {
    display: none;
  }
}

/* The conditions, on a phone: the label moves left of its value, three rows, one
   condition each, labels in a column of their own. The 82px fallback is measured
   on the board, where WORKTREES is the longest label at --t-label; ARTIFACT
   STORE is longer, so it takes its own line where subgrid is unavailable. */
@media (max-width: 640px) {
  .conds {
    display: grid;
    grid-template-columns: max-content 1fr;
    column-gap: var(--gap);
    row-gap: 14px;
  }

  .cond {
    grid-template-columns: 92px 1fr;
    grid-template-columns: subgrid;
    display: grid;
    grid-column: 1 / -1;
    align-items: center;
    column-gap: var(--gap);
    row-gap: 4px;
  }

  .cond .label {
    grid-area: 1 / 1;
  }

  .cond .cvalue {
    grid-area: 1 / 2;
  }

  .cond .sub {
    grid-area: 2 / 2;
  }
}
</style>
