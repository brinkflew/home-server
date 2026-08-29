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
 */
import { computed, watch } from "vue";

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
import { laneTone } from "@/health";
import { toPoints, type ChartSeries } from "@/charts";
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
        // Absent while idle by design, so this is NaN rather than 0 - which is
        // what makes ProgressBar draw a bare track instead of an empty fill.
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

/** 0 is a real answer here: no lane on this host has ever written a marker. */
const noMarker = computed(() => rack.data.value?.markerPresent === 0);

/**
 * LANES THE BATTERY COUNTS THAT THE RACK CANNOT DRAW.
 *
 * The rack is built from the union of the marker series, which means a lane that
 * has written NO marker at all appears nowhere - and that is the worst possible
 * outcome on the one page this fleet is visible from. It is not hypothetical: a
 * lane whose driver never got far enough to write a marker (a bad credential, a
 * missing image - exit 4 and exit 5 in bin/github-runner.sh) is exactly that
 * shape, and it is the lane most worth seeing.
 *
 * `lanes_active + lanes_failed` is bin/verify-host.sh's own count from
 * `systemctl is-enabled`, so it sees a unit the collector's marker loop cannot.
 * The difference is drawn as a sentence rather than as invented grey rows: the
 * lane NUMBERS are not in any fact, and a compiled-in list of them would be the
 * driftable duplicate this repository has a name for - with no lint leg to catch
 * it, unlike topology.ts.
 */
const silentLanes = computed(() => {
  const active = f.value?.lanesActive ?? Number.NaN;
  const failed = f.value?.lanesFailed ?? Number.NaN;
  if (!Number.isFinite(active) || !Number.isFinite(failed)) return 0;
  return Math.max(0, active + failed - lanes.value.length);
});

const tally = computed(() => {
  const counts: Record<Tone, number> = { ok: 0, warn: 0, fail: 0, off: 0 };
  for (const l of lanes.value) counts[l.tone] += 1;
  const parts: string[] = [];
  if (counts.ok) parts.push(`${counts.ok} healthy`);
  if (counts.warn) parts.push(`${counts.warn} degraded`);
  if (counts.fail) parts.push(`${counts.fail} failing`);
  if (counts.off) parts.push(`${counts.off} never started`);
  return parts.join(" / ") || "no lanes";
});

// --- charts -----------------------------------------------------------------

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
  const [disk, jobs, sliceMem, sliceHigh, sliceMax, slicePids] = await Promise.all([
    range(CI.laneDisk, options),
    range(CI.jobsPerHour, options),
    range(CI.sliceMemory, options),
    instant(CI.sliceMemoryHigh, signal),
    instant(CI.sliceMemoryMax, signal),
    range(CI.slicePids, options),
  ]);

  return {
    disk: laneSeries(disk),
    jobs: laneSeries(jobs),
    sliceMem: sliceMem[0] ? toPoints(sliceMem[0].values) : [],
    slicePids: slicePids[0] ? toPoints(slicePids[0].values) : [],
    // ABSENT WHEN UNLIMITED rather than zero, which is exactly what
    // ci.slice_limits exists to catch - so NaN here leaves MetricChart to fall
    // back on the data's own extent instead of collapsing the frame.
    sliceHigh: value(sliceHigh[0]?.value),
    sliceMax: value(sliceMax[0]?.value),
  };
}, 30_000);

watch(win, () => {
  void charts.refresh();
});

const c = computed(() => charts.data.value);
const from = computed(() => host.now - win.value.seconds);

// --- the numbers that are not per-lane --------------------------------------

// Declared before the rack's derived state, which reads lanesActive/lanesFailed
// to notice a lane that has written no marker at all.
const fleet = usePoll(async (signal) => {
  const [
    lanesActive, lanesFailed, imageAge, versionAge, toolcache, baselines,
    stateBytes, runsBytes, unlimited, strays, sliceOom,
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
    strays: one(strays),
    sliceOom: one(sliceOom),
  };
}, 60_000);

const f = computed(() => fleet.data.value);

/**
 * The three ids CiContainmentLost pages on, as a regex written once.
 *
 * IT MATCHES THE ALERT RULE DELIBERATELY. A page and a pager disagreeing about
 * what counts as containment is worse than either being wrong on its own,
 * because the page is where somebody checks after the phone has gone off.
 */
const CONTAINMENT = ["ci.slice_limits", "ci.runner_isolation", "ci.fleet_root_label"];

const containment = computed(() =>
  CONTAINMENT.map((id) => ({ id, check: host.byId.get(id) ?? null })),
);

/**
 * The two facts with no metric anywhere.
 *
 * github_runner_runtime_split and github_runner_root_label are STRINGS, and
 * source_status only mints series from numeric, boolean and `*_at` facts - so
 * they fall through every branch and exist nowhere but status.json. The check's
 * own status is the only other route, which is why this page shows passing
 * checks rather than only failing ones.
 */
const stringFacts = computed(() => [
  { label: "runtime dir", value: host.fact("github_runner_runtime_split") },
  { label: "fleet root label", value: host.fact("github_runner_root_label") },
]);

// --- tooltips ----------------------------------------------------------------

function ledTip(l: Lane) {
  return {
    title: `lane ${l.lane}`,
    lines: [l.state, `home-server-github-runner@${l.lane}`],
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
    "The memory peak INCLUDES page cache, so a lane at its ceiling after a dependency install is reclaim working. The refusal count, not the peak, is what justifies raising a ceiling.",
});

const baselineTip = computed(() => ({
  title: "coverage baselines",
  lines: [`${fmt.number(f.value?.baselines ?? Number.NaN)} baselines.json in the artifact store`],
  caveat:
    "Zero is the loud case. upskald's gate PASSES on an absent baseline and fails only on an unavailable one, so an empty store is a green pipeline enforcing nothing at all.",
}));

const sliceTip = computed(() => ({
  title: "app-ci.slice",
  lines: [
    `MemoryHigh ${fmt.bytes(charts.data.value?.sliceHigh ?? Number.NaN)}`,
    `MemoryMax ${fmt.bytes(charts.data.value?.sliceMax ?? Number.NaN)}`,
  ],
  caveat:
    "A ceiling is not usage. These are what the slice may take, not what it does - reading one as the other nearly cost a second slice.",
}));
</script>

<template>
  <div class="page">
    <Teleport defer to="#toolbar">
      <span class="mono tnote">read only</span>
      <WindowPicker />
    </Teleport>

    <!-- The lane rack ------------------------------------------------------->
    <section class="rack-head">
      <span class="label">CI lanes</span>
      <span class="mono counts">{{ tally }}</span>
    </section>

    <PanelBox :stale="metricsStale" padding="0">
      <p v-if="noMarker" class="empty mono">
        No lane has ever written a marker on this host. That is a host with CI disabled, not a broken
        one - every ci check reports it as a note.
      </p>

      <div v-else class="rack">
        <div v-for="l in lanes" :key="l.lane" class="row">
          <span class="led" v-bind="tip.hover(`ci-led-${l.lane}`, ledTip(l))">
            <StatusDot :tone="l.tone" :live="l.inFlight === 1" :size="7" glow />
          </span>

          <span class="name mono">lane {{ l.lane }}</span>
          <StatePill :label="l.state" :tone="l.tone" size="sm" />

          <div class="job" v-bind="tip.hover(`ci-job-${l.lane}`, jobTip(l))">
            <ProgressBar
              :ratio="l.inFlight === 1 && Number.isFinite(l.jobAge) ? l.jobAge / RUNTIME_MAX_S : null"
              :tone="l.jobAge > JOB_STUCK_S ? 'warn' : 'ok'"
              :live="l.inFlight === 1"
            />
            <span class="mono sub">{{ l.inFlight === 1 ? fmt.duration(l.jobAge) : fmt.NO_DATA }}</span>
          </div>

          <span class="num mono">{{ fmt.number(l.jobsToday) }} today</span>
          <span class="num mono dim">{{ fmt.number(l.jobsTotal) }} total</span>
          <span class="num mono dim">{{ fmt.duration(l.lastJobSeconds) }}</span>

          <div class="meter" v-bind="tip.hover(`ci-disk-${l.lane}`, diskTip(l))">
            <ProgressBar
              :ratio="Number.isFinite(l.disk) ? l.disk / LANE_DISK_MAX : null"
              :tone="l.disk / LANE_DISK_MAX > 0.9 ? 'warn' : 'ok'"
            />
            <span class="mono sub">{{ fmt.bytes(l.disk) }}</span>
          </div>

          <div class="meter" v-bind="tip.hover(`ci-store-${l.lane}`, storeTip(l))">
            <ProgressBar
              :ratio="Number.isFinite(l.storeJobs) ? l.storeJobs / STORE_MAX_JOBS : null"
              :tone="'ok'"
            />
            <span class="mono sub">{{ fmt.number(l.storeJobs) }}/{{ STORE_MAX_JOBS }}</span>
          </div>

          <span class="num mono" v-bind="tip.hover(`ci-mem-${l.lane}`, memTip(l))">
            <span :class="{ bad: l.memMaxEvents > 0 || l.oomKills > 0 }">
              {{ fmt.bytes(l.memPeak) }}
            </span>
          </span>

          <span class="num mono" :class="{ bad: l.failures > 0 }">
            {{ l.failures > 0 ? `${fmt.number(l.failures)} mint fail` : "" }}
          </span>
        </div>
      </div>

      <p v-if="silentLanes > 0" class="silent mono">
        {{ silentLanes }} enabled lane(s) have written no marker at all, so they appear nowhere
        above - the driver never got far enough. ci.lanes_alive names the exit code.
      </p>
    </PanelBox>

    <!-- Charts -------------------------------------------------------------->
    <section class="grid-2">
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
        <p class="note mono">
          The vertical drops are resets. A sawtooth is the driver clearing a lane that passed its
          budget, which is the design working rather than a fault.
        </p>
      </PanelBox>

      <PanelBox label="Jobs per hour" :stale="metricsStale">
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
        <p class="note mono">
          increase() over the jobs counter, not a rate over jobs_today - that one is a gauge which
          resets at midnight, and a rate over it would report a spike every night at 00:00.
        </p>
      </PanelBox>
    </section>

    <section class="grid-2">
      <PanelBox label="Slice memory" :stale="metricsStale">
        <template #aside>
          <span class="mono" v-bind="tip.hover('ci-slice', sliceTip)">app-ci.slice</span>
        </template>
        <MetricChart
          :points="c?.sliceMem ?? []"
          :from="from"
          :to="host.now"
          :height="120"
          :grid="3"
          y-axis
          x-axis
          :tick-base="1024"
          :format="fmt.bytes"
          :y-max="c?.sliceMax"
          :tone="(f?.sliceOom ?? 0) > 0 ? 'fail' : 'ok'"
        />
        <p class="note mono">
          {{ fmt.number(f?.sliceOom ?? Number.NaN) }} processes killed at the ceiling. A ceiling is
          not usage: this frame is what the slice may take, not what it needs.
        </p>
      </PanelBox>

      <PanelBox label="Containment" :stale="metricsStale">
        <ul class="checks">
          <li v-for="c in containment" :key="c.id" class="check">
            <StatusDot :tone="c.check ? (c.check.status === 'pass' ? 'ok' : 'warn') : 'off'" :size="6" />
            <span class="mono cid">{{ c.id }}</span>
            <span class="msg">{{ c.check?.message ?? "not measured in the last run" }}</span>
          </li>
        </ul>
        <div class="facts">
          <div v-for="s in stringFacts" :key="s.label" class="fact">
            <span class="mono flabel">{{ s.label }}</span>
            <span class="mono fvalue">{{ s.value ?? fmt.NO_DATA }}</span>
          </div>
        </div>
        <p class="note mono">
          These three are what CiContainmentLost pages on, matched by the same ids. The two facts
          below them are strings, so they exist in status.json and in no series anywhere.
        </p>
      </PanelBox>
    </section>

    <!-- Freshness ----------------------------------------------------------->
    <PanelBox label="Image, tools and artifacts" :stale="metricsStale">
      <div class="tiles">
        <div class="tile">
          <span class="mono tlabel">lanes</span>
          <span class="mono tvalue">
            {{ fmt.number(f?.lanesActive ?? Number.NaN) }} active
            <span v-if="(f?.lanesFailed ?? 0) > 0" class="bad">
              / {{ fmt.number(f?.lanesFailed ?? Number.NaN) }} failed</span
            >
          </span>
        </div>
        <div class="tile">
          <span class="mono tlabel">runner image</span>
          <span class="mono tvalue" :class="{ warnish: (f?.imageAge ?? 0) > 14 }">
            {{ fmt.number(f?.imageAge ?? Number.NaN) }}d old
          </span>
        </div>
        <div class="tile">
          <span class="mono tlabel">version stamp</span>
          <span class="mono tvalue" :class="{ warnish: (f?.versionAge ?? 0) > 14 }">
            {{ fmt.number(f?.versionAge ?? Number.NaN) }}d old
          </span>
        </div>
        <div class="tile">
          <span class="mono tlabel">tool cache</span>
          <span class="mono tvalue" :class="{ warnish: (f?.toolcache ?? 0) > 0 }">
            {{ fmt.number(f?.toolcache ?? Number.NaN) }} stale
          </span>
        </div>
        <div class="tile" v-bind="tip.hover('ci-baselines', baselineTip)">
          <span class="mono tlabel">coverage baselines</span>
          <span class="mono tvalue" :class="{ bad: f?.baselines === 0 }">
            {{ fmt.number(f?.baselines ?? Number.NaN) }}
          </span>
        </div>
        <div class="tile">
          <span class="mono tlabel">artifact store</span>
          <span class="mono tvalue">
            {{ fmt.bytes(f?.stateBytes ?? Number.NaN) }} state /
            {{ fmt.bytes(f?.runsBytes ?? Number.NaN) }} runs
          </span>
        </div>
      </div>

      <p class="note mono">
        Nothing here comes from GitHub. Queue depth and runner online status are NOT MEASURED on this
        host: the runner PAT must never enter a container, and an hourly poll of api.github.com was
        argued against rather than forgotten. These three lanes are what is observable, not the whole
        picture.
      </p>
    </PanelBox>

    <FindingsPanel label="CI checks" section="ci" all />
  </div>
</template>

<style scoped>
.page {
  padding: 16px var(--pad-page) var(--pad-page);
  display: flex;
  flex-direction: column;
  gap: 10px;
}

.rack-head {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: 12px;
}

.label {
  font: var(--t-label);
  letter-spacing: var(--track-label);
  text-transform: uppercase;
  color: var(--fg-5);
}

.counts {
  font: var(--t-mono-xs);
  color: var(--fg-5);
}

.rack {
  display: flex;
  flex-direction: column;
}

/* Explicit columns with minmax(0, ...) throughout: a bare 1fr lets a long
   value push the column wider instead of truncating. */
.row {
  display: grid;
  grid-template-columns: 34px 68px 104px minmax(0, 1.1fr) 76px 78px 74px minmax(0, 1fr) minmax(0, 0.8fr) 96px 92px;
  align-items: center;
  gap: 10px;
  padding: 9px 13px;
  border-bottom: 1px solid var(--line);
}

.row:last-child {
  border-bottom: none;
}

.led {
  display: inline-flex;
  justify-content: center;
}

.name {
  font: var(--t-mono-sm);
  color: var(--fg-2);
}

.job,
.meter {
  display: flex;
  flex-direction: column;
  gap: 4px;
  min-width: 0;
}

.sub {
  font: var(--t-mono-xs);
  color: var(--fg-5);
}

.num {
  font: var(--t-mono-xs);
  color: var(--fg-3);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.dim {
  color: var(--fg-5);
}

.bad {
  color: var(--fail-text);
}

.warnish {
  color: var(--warn);
}

.grid-2 {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 10px;
}

.checks {
  display: flex;
  flex-direction: column;
  gap: 7px;
}

.check {
  display: grid;
  grid-template-columns: 12px 150px minmax(0, 1fr);
  align-items: baseline;
  gap: 8px;
}

.cid {
  font: var(--t-mono-xs);
  color: var(--fg-5);
}

.msg {
  font: var(--t-ui-md);
  color: var(--fg-2);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.facts {
  display: flex;
  gap: 18px;
  margin-top: 11px;
  padding-top: 10px;
  border-top: 1px solid var(--line);
}

.fact {
  display: flex;
  flex-direction: column;
  gap: 2px;
}

.flabel,
.tlabel {
  font: var(--t-mono-xs);
  color: var(--fg-5);
}

.fvalue,
.tvalue {
  font: var(--t-mono-sm);
  color: var(--fg-2);
}

.tiles {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(150px, 1fr));
  gap: 12px;
}

.tile {
  display: flex;
  flex-direction: column;
  gap: 3px;
  min-width: 0;
}

.note {
  margin-top: 10px;
  padding-top: 9px;
  border-top: 1px solid var(--line);
  font: var(--t-mono-xs);
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
  padding: 14px;
}

/* Amber, not grey: a lane the battery can see and this rack cannot is a finding
   rather than a footnote. */
.silent {
  margin: 0 13px 11px;
  padding-top: 10px;
  border-top: 1px solid var(--line);
  font: var(--t-mono-xs);
  color: var(--warn);
}

@media (max-width: 1100px) {
  .grid-2 {
    grid-template-columns: minmax(0, 1fr);
  }
}
</style>
