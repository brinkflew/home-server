<script setup lang="ts">
/**
 * /system/load: what is the machine working on?
 *
 * ONE TIME AXIS ACROSS EVERYTHING, which is the point of the view and is why
 * every series is fetched in one pass with identical start/end/step: two charts
 * on slightly different windows cannot be read against each other, and the whole
 * reason to share an axis is to see that the disk spike and the pressure spike
 * are the same event.
 *
 * AND THEY DID NOT SHARE ONE. Every axis parameter was a hand-picked literal per
 * call site - heights 104/104/88/88 and tick counts 5/4/3/3 - so four charts on
 * one window and one cursor drew four different axes, and "10:58" under the CPU
 * chart was above nothing at all on the memory chart beside it. /ci draws the
 * identical 2x2 band at one height with no tick override and reads even because
 * of it. The overrides are gone: MetricChart's default is five, which is odd and
 * therefore survives the phone rule that hides every second tick.
 *
 * `useCrosshair` is a module-level ref holding a unix TIME, not a pixel, so
 * hovering the disk chart marks the same instant on the IO pressure row below it
 * even though they are different components at different sizes - and the lead
 * and the three lane readings follow it too.
 *
 * IT IS CLEARED ON UNMOUNT HERE, WHICH IT NEVER WAS ANYWHERE, and the split is
 * what made that reachable. The only thing that clears the cursor is
 * `pointerleave` on the plot, so a MOUSE user can never strand it: reaching the
 * sub-nav moves the pointer off the chart on the way. A KEYBOARD user does not.
 * Measured both ways - focus the Health segment, press Enter, come back, and
 * without this line the band aside reads "7 Sep 19:48" instead of "last 6h",
 * with every value slot on the view reporting that instant rather than now.
 * Same family as the drawer that opened for a mouse and not for a keyboard.
 */
import { computed, onUnmounted, watch } from "vue";

import Band from "@/components/Band.vue";
import PanelBox from "@/components/PanelBox.vue";
import MetricChart from "@/components/MetricChart.vue";
import StatusDot from "@/components/StatusDot.vue";
import WindowPicker from "@/components/WindowPicker.vue";

import { usePoll } from "@/composables/usePoll";
import { useMetricsStale } from "@/composables/useStaleness";
import { instant, instantBy, range, value } from "@/api/prometheus";
import { bySeverityThenTime, fetchAlerts, isHeartbeat } from "@/api/alerts";
import { SERVICES, SYSTEM } from "@/queries";
import { latest, onGrid, peak, sampleAt, toPoints, type ChartSeries, type Point } from "@/charts";
import * as sys from "@/system";
import * as fmt from "@/format";
import type { Tone } from "@/types";
import { useTimeWindow } from "@/composables/useTimeWindow";
import { useCrosshair } from "@/composables/useCrosshair";

const { window: win } = useTimeWindow();
const cross = useCrosshair();
const metricsStale = useMetricsStale();

/**
 * ONE PLOT HEIGHT FOR THE WHOLE BAND, and it is /ci's number for the identical
 * 2x2 arrangement at the same width. There is no reason for two pages drawing
 * the same shape to differ, and the two heights this band used to carry were
 * the visible half of four charts that agreed about nothing.
 */
const PLOT_H = 132;

// ---------------------------------------------------------------------------
// Every range query this view draws, in one fetch on one grid.
// ---------------------------------------------------------------------------
interface Source {
  key: string;
  query: string;
  /**
   * Draw every series the query returns, one line each, keyed by this label.
   * Set only where the multiplicity is REAL and must not be collapsed: this
   * host has two GPUs, one of them with dead video engines, and taking whichever
   * series sorted first is what made the encoder read 0% for ever. The twelve
   * CPU threads are the second case, for the opposite reason - the aggregate is
   * what hides one pinned core.
   */
  splitBy?: string;
}

const SOURCES: Source[] = [
  { key: "cpuCores", query: SYSTEM.cpuPerCore, splitBy: "cpu" },
  { key: "cpuMean", query: SYSTEM.cpuBusy },
  { key: "load1", query: SYSTEM.load1 },
  { key: "memInUse", query: SYSTEM.memoryUsed },
  { key: "memUsed", query: SYSTEM.memoryUsedParts },
  { key: "memBuffers", query: SYSTEM.memoryBuffers },
  { key: "memCache", query: SYSTEM.memoryCache },
  { key: "memFree", query: SYSTEM.memoryFree },
  { key: "swapUsed", query: SYSTEM.swapUsed },
  { key: "netRx", query: SYSTEM.netRx },
  { key: "netTx", query: SYSTEM.netTx },
  { key: "diskRead", query: SYSTEM.diskRead },
  { key: "diskWrite", query: SYSTEM.diskWritten },
  { key: "gpu", query: SYSTEM.gpuEncoder, splitBy: "gpu" },
  { key: "iopsi", query: SYSTEM.ioPressure },
  { key: "cpupsi", query: SYSTEM.cpuPressure },
];

const series = usePoll(async (signal) => {
  const end = Math.floor(Date.now() / 1000);
  const start = end - win.value.seconds;
  const step = win.value.step;

  // THE CEILINGS ARE RESOLVED IN THE SAME PASS, deliberately. MemTotal is its
  // own instant query, and fetching it separately means the memory card scales
  // to its data on the first paint and then visibly rescales when the ceiling
  // lands - a jump on every mount, for nothing.
  const [results, memTotal, swapTotal] = await Promise.all([
    Promise.all(
      SOURCES.map(async (source) => {
        const matrix = await range(source.query, { window: win.value.seconds, step, signal });
        const split = source.splitBy;

        // ONE SORT, NOT TWO. The label and its line used to be produced by two
        // independent sorts over the same matrix and then zipped by index, so
        // the pairing held only while both stayed in agreement - which is the
        // shape of the encoder-read-0% incident this splitBy exists to prevent.
        const ordered = split
          ? matrix
              .map((s) => ({
                label: s.metric[split] ?? "?",
                points: onGrid(toPoints(s.values), start, end, step),
              }))
              .sort((a, b) => a.label.localeCompare(b.label, "en", { numeric: true }))
          : // Without splitBy the query aggregates in PromQL and returns exactly
            // one series, so taking the first is not a choice being made.
            [
              {
                label: "",
                points: onGrid(matrix.length ? toPoints(matrix[0].values) : [], start, end, step),
              },
            ];

        return [
          source.key,
          { lines: ordered.map((o) => o.points), labels: split ? ordered.map((o) => o.label) : [] },
        ] as const;
      }),
    ),
    instant(SYSTEM.memoryTotal, signal).then((r) => value(r[0]?.value)),
    instant(SYSTEM.swapTotal, signal).then((r) => value(r[0]?.value)),
  ]);

  return {
    start,
    end,
    step,
    memTotal,
    swapTotal,
    by: new Map<string, { lines: Point[][]; labels: string[] }>(results),
  };
}, 30_000);

// The window is read inside the loader, so a change to it would otherwise not
// show until the next 30s tick - which reads as a dead button.
watch(win, () => {
  void series.refresh();
});

/** See the banner: pointerleave is the only thing that clears this, so a
 *  keyboard navigation away from the charts used to leave the whole view frozen
 *  at an instant nobody chose. */
onUnmounted(() => cross.clear());

function pointsOf(key: string): Point[] {
  return series.data.value?.by.get(key)?.lines[0] ?? [];
}

function allOf(key: string): Point[][] {
  return series.data.value?.by.get(key)?.lines ?? [];
}

function labelsOf(key: string): string[] {
  return series.data.value?.by.get(key)?.labels ?? [];
}

/**
 * One number from a series: under the cursor while one is set, and the latest
 * sample otherwise - so the same slot answers "what is it now" and "what was it
 * then" without a second place to look.
 *
 * A hole reads as the no-data dash rather than as the last real value: the
 * cursor sitting in a gap must not be answered with a number from elsewhere.
 */
function at(points: Point[]): number {
  const t = cross.at.value;
  return t === null ? latest(points) : (sampleAt(points, t)?.[1] ?? Number.NaN);
}

const from = computed(() => series.data.value?.start);
const to = computed(() => series.data.value?.end);

/** What the value slots are currently reporting, named in the band's aside. */
const cursorStamp = computed(() => (cross.at.value === null ? null : fmt.stamp(cross.at.value)));

function toneClass(tone: Tone): Record<string, boolean> {
  return { bad: tone === "fail", warnish: tone === "warn", dim: tone === "off" };
}

function rail(tone: Tone): string {
  return tone === "ok" ? "transparent" : `var(--${tone})`;
}

// ---------------------------------------------------------------------------
// The four charts
// ---------------------------------------------------------------------------

/**
 * Twelve threads at one flat opacity plus the mean at full weight.
 *
 * NOT THE BRIGHTNESS RAMP: the cores are interchangeable, and drawing core 11
 * at a third of core 0 would say something about core 11 that is not true. The
 * ramp is for series that differ; these differ only in which one is busy.
 */
const cpuSeries = computed<ChartSeries[]>(() => {
  const cores = allOf("cpuCores").map((points, i) => ({
    points,
    label: `cpu${labelsOf("cpuCores")[i] ?? i}`,
    tone: "ok" as const,
    opacity: 0.3,
  }));
  const mean = pointsOf("cpuMean");
  return mean.length ? [...cores, { points: mean, label: "mean", tone: "ok" as const, opacity: 1, width: 2 }] : cores;
});

const busiestCore = computed(() => sys.busiestCore(allOf("cpuCores").map((p) => at(p))));

const coreCount = computed(() => allOf("cpuCores").length);

/**
 * Bottom band first. They sum to MemTotal by construction - see queries.ts -
 * which is the only thing that makes pinning the frame to MemTotal honest.
 */
const memorySeries = computed<ChartSeries[]>(() => [
  { points: pointsOf("memUsed"), label: "used", tone: "ok" },
  { points: pointsOf("memBuffers"), label: "buffers", tone: "ok" },
  { points: pointsOf("memCache"), label: "cache", tone: "ok" },
  { points: pointsOf("memFree"), label: "free", tone: "ok" },
]);

/** MemAvailable-based, and the aside rather than a band, because it is the
 *  number a human means by "memory in use". Reporting MemTotal - MemFree there
 *  instead would say 88% on a perfectly healthy host - the exact misreading
 *  queries.ts warns about for the same reason. */
const memoryInUse = computed(() => at(pointsOf("memInUse")));

const swap = computed(() => {
  const total = series.data.value?.swapTotal ?? Number.NaN;
  if (!Number.isFinite(total) || total <= 0) return null;
  const used = at(pointsOf("swapUsed"));
  return { used, total, ratio: used / total };
});

/** In above the zero rule, out below it. Positive magnitudes in both halves -
 *  only the drawing is signed, see charts.ts. */
const netSeries = computed<ChartSeries[]>(() => [
  { points: pointsOf("netRx"), label: "in", tone: "ok", direction: "up" },
  { points: pointsOf("netTx"), label: "out", tone: "ok", direction: "down" },
]);

const diskSeries = computed<ChartSeries[]>(() => [
  { points: pointsOf("diskRead"), label: "read", tone: "ok", direction: "up" },
  { points: pointsOf("diskWrite"), label: "write", tone: "ok", direction: "down" },
]);

// ---------------------------------------------------------------------------
// The pressure rows, which the charts above do not draw
// ---------------------------------------------------------------------------

/**
 * One resolved row per lane. Derived once rather than four times in the
 * template, and it is what keeps the rail, the chart's hue and the reading's
 * colour reading off ONE tone - three call sites deriving the same answer is
 * how the /ci legend came to disagree with the lines it named.
 *
 * `plotTone` is the tone MINUS grey, because MetricChart has only three: a lane
 * with no series draws no line anyway, so what it would be drawn in does not
 * arise. The rail and the reading keep the real answer.
 */
const laneRows = computed(() =>
  sys.LANES.map((lane) => {
    const entry = series.data.value?.by.get(lane.key);
    const lines = entry?.lines ?? [];
    const values = lines.map((p) => at(p));
    const tone = sys.laneTone(lane, values);
    const plotTone: "ok" | "warn" | "fail" = tone === "off" ? "ok" : tone;

    return {
      lane,
      tone,
      plotTone,
      reading: sys.laneReading(lane, values),
      peak: sys.laneReading(lane, lines.map((p) => peak(p))),
      series: lines.map((points, i) => ({
        points,
        label: entry?.labels[i],
        tone: plotTone,
      })) as ChartSeries[],
    };
  }),
);

/** Seven ticks across the window, each carrying the date only where it changes -
 *  without which every tick on the 7d window is a bare HH:MM naming no day. */
const axis = computed(() => {
  const s = series.data.value;
  if (!s) return [];
  return fmt.axisTicks(s.start, s.end, 7);
});

// ---------------------------------------------------------------------------
// Alerts, for the event row only. The prose lives on /system/health.
// ---------------------------------------------------------------------------
const alerts = usePoll((signal) => fetchAlerts(signal), 30_000);

const sortedAlerts = computed(() =>
  [...(alerts.data.value ?? [])].filter((a) => !isHeartbeat(a)).sort(bySeverityThenTime),
);

const eventMarks = computed(() =>
  sys.eventMarks(sortedAlerts.value, series.data.value?.start ?? Number.NaN, series.data.value?.end ?? Number.NaN),
);

// ---------------------------------------------------------------------------
// The GPU, and who is watching
// ---------------------------------------------------------------------------
// The GPU is worth a panel of its own: two NVENC sessions already pin the
// encoder block at 100% while the SM sits at 10%, so "the GPU is busy" and
// "the GPU is saturated" are different questions here.
//
// A ROW PER CARD, because this host has two and they are not interchangeable:
// GPU 0's video engines are dead hardware, which the quadlets work around by
// pinning both consumers to nvidia.com/gpu=1. Reading `[0]` off each of these
// answered for the idle card - and instant-vector order is not guaranteed by the
// API anyway, so the four rows could each have described a different one.
const gpu = usePoll(async (signal) => {
  const [encoder, sm, temp, power, sessions] = await Promise.all([
    instantBy(SYSTEM.gpuEncoder, "gpu", signal),
    instantBy(SYSTEM.gpuSm, "gpu", signal),
    instantBy(SYSTEM.gpuTemp, "gpu", signal),
    instantBy(SYSTEM.gpuPower, "gpu", signal),
    instantBy(SYSTEM.gpuSessions, "gpu", signal),
  ]);

  const cards = [...new Set([...encoder.keys(), ...temp.keys(), ...power.keys()])].sort((a, b) =>
    a.localeCompare(b, "en", { numeric: true }),
  );

  return cards.map((id) => ({
    id,
    encoder: encoder.get(id) ?? Number.NaN,
    sm: sm.get(id) ?? Number.NaN,
    temp: temp.get(id) ?? Number.NaN,
    power: power.get(id) ?? Number.NaN,
    sessions: sessions.get(id) ?? Number.NaN,
  }));
}, 30_000);

const jellyfinSessions = usePoll(
  async (signal) => value((await instant(SERVICES.jellyfinSessions, signal))[0]?.value),
  30_000,
);

// ---------------------------------------------------------------------------
// The headline
// ---------------------------------------------------------------------------

/**
 * THE READING IS CPU BUSY AND THE TONE IS THE WORST LANE'S. The encoder can sit
 * at 100% while the aggregate reads 12%, so grading the headline on its own
 * number would draw teal over a saturated machine. See src/system.ts.
 */
const metrics = computed<sys.SystemMetrics | null>(() => {
  const s = series.data.value;
  if (!s) return null;
  return {
    cpuBusy: at(pointsOf("cpuMean")),
    cpuStalled: at(pointsOf("cpupsi")),
    load1: at(pointsOf("load1")),
    memUsed: at(pointsOf("memInUse")),
    memTotal: s.memTotal,
    swapUsed: at(pointsOf("swapUsed")),
    swapTotal: s.swapTotal,
    fullest: null,
    mounts: 0,
  };
});

const lead = computed(() =>
  sys.loadLead(
    metrics.value,
    coreCount.value,
    busiestCore.value,
    laneRows.value.map((r) => r.tone),
  ),
);
</script>

<template>
  <Teleport defer to="#toolbar">
    <WindowPicker />
  </Teleport>

  <!-- NOT "Right now", WHICH IS THE HEALTH BAND ONE TAB OVER. docs/dashboard.md
       records the same correction for the Fleet page: a band that announces
       itself with the name of the view beside it reads as a link to it. Three
       sibling views cannot all open on the same word. -->
  <Band label="Working">
    <template #aside>
      <span class="mono" :class="{ at: cursorStamp }">{{ cursorStamp ?? `last ${win.label}` }}</span>
    </template>

    <PanelBox :stale="metricsStale">
      <div class="lead">
        <StatusDot :tone="lead.tone" :live="lead.live" :size="9" />
        <span class="reading mono">{{ lead.text }}</span>
      </div>
      <p class="lead-sub mono">{{ lead.sub }}</p>
    </PanelBox>
  </Band>

  <!-- FOUR CHARTS ON ONE WINDOW AND THEREFORE ONE AXIS, WHICH THEY DID NOT
       HAVE. Every parameter was a literal per call site - heights 104/104/88/88
       and tick counts 5/4/3/3 - so "10:58" under the CPU chart was above nothing
       at all on the memory chart beside it, and the two rows were different
       depths. One height, no tick override, and the band reads as a grid.

       `stretch` IS ONLY DEFENSIBLE NOW THAT THE HEIGHTS MATCH. Band's docblock
       sets the test: "it absorbs a few tens of pixels, not a few hundred - if it
       is closing a large gap, the band is wrong." With four different plot
       heights it was hiding about 70px of mismatch, which is the failure that
       sentence describes. What is left is the memory panel's legend and swap
       meter, about 45, and absorbing that is what the prop is for. -->
  <Band label="Over time" :cols="2" stretch>
    <PanelBox label="CPU" :stale="metricsStale">
      <template #aside>
        <span class="value mono" :class="{ hovered: cross.active.value }">
          {{ fmt.percent(at(pointsOf("cpuMean")), 1) }}
        </span>
      </template>
      <MetricChart
        :series="cpuSeries"
        :height="PLOT_H"
        :grid="4"
        :y-max="1"
        y-axis
        x-axis
        :format="(v: number) => fmt.percent(v, 0)"
        :from="from"
        :to="to"
      />
      <div class="foot mono">
        <span><span class="count">{{ coreCount || "-" }}</span> threads, busy fraction of each</span>
        <span>busiest thread {{ fmt.percent(busiestCore, 0) }}</span>
      </div>
    </PanelBox>

    <PanelBox label="Memory" :stale="metricsStale">
      <template #aside>
        <span class="value mono" :class="{ hovered: cross.active.value }">
          {{ fmt.bytes(memoryInUse) }}
        </span>
      </template>
      <MetricChart
        :series="memorySeries"
        :height="PLOT_H"
        :grid="4"
        :y-max="series.data.value?.memTotal"
        stacked
        legend
        y-axis
        x-axis
        :tick-base="1024"
        :format="(v: number) => fmt.bytes(v, 0)"
        :from="from"
        :to="to"
      />
      <!-- SWAP IS NOT A FIFTH BAND. The stack is pinned to MemTotal and
           adding four gigabytes to it would draw a machine with twenty. -->
      <div v-if="swap" class="swap">
        <div class="swap-head mono">
          <span>swap</span>
          <span>{{ fmt.bytes(swap.used) }} of {{ fmt.bytes(swap.total) }}</span>
        </div>
        <div class="bar">
          <span class="fill" :style="{ width: `${Math.min(100, swap.ratio * 100).toFixed(1)}%` }" />
        </div>
      </div>
    </PanelBox>

    <PanelBox label="Network" :stale="metricsStale">
      <template #aside>
        <span class="value mono" :class="{ hovered: cross.active.value }">
          {{ fmt.rate(at(pointsOf("netRx"))) }}
        </span>
      </template>
      <MetricChart
        :series="netSeries"
        :height="PLOT_H"
        :grid="4"
        mirror
        y-axis
        x-axis
        :tick-base="1024"
        :format="(v: number) => fmt.rate(v)"
        :from="from"
        :to="to"
      />
      <div class="foot mono">
        <span>in, above / out, below</span>
        <span>out {{ fmt.rate(at(pointsOf("netTx"))) }}</span>
      </div>
    </PanelBox>

    <PanelBox label="Disk I/O" :stale="metricsStale">
      <template #aside>
        <span class="value mono" :class="{ hovered: cross.active.value }">
          {{ fmt.rate(at(pointsOf("diskRead"))) }}
        </span>
      </template>
      <MetricChart
        :series="diskSeries"
        :height="PLOT_H"
        :grid="4"
        mirror
        y-axis
        x-axis
        :tick-base="1024"
        :format="(v: number) => fmt.rate(v)"
        :from="from"
        :to="to"
      />
      <div class="foot mono">
        <span>read, above / write, below</span>
        <span>write {{ fmt.rate(at(pointsOf("diskWrite"))) }}</span>
      </div>
    </PanelBox>
  </Band>

  <!-- THE RACK IS A TABLE. It was `160px 1fr 128px` with a 320px floor, panned
       sideways from 900 at a 620px min-width - so on a phone the Reading
       column, which is the entire point of this band, was simply off screen.

       THE ALERTS ROW IS NOT THE ALERTS PANEL DRAWN TWICE, and now that the
       panel is a view away it is the only alert on screen here. It carries WHEN
       each one started, against the cursor every chart above shares, so a spike
       and the alert it produced can be read together; /system/health carries
       the prose. Same split as a value table against FindingsPanel. -->
  <Band label="Pressure">
    <PanelBox :stale="metricsStale">
      <table class="tbl">
        <thead>
          <tr>
            <th class="c-rail" />
            <th class="c-lane">Lane</th>
            <!-- The axis lives over the plot column, which under
                 table-layout: fixed is the only place it can be and stay
                 aligned to it. -->
            <th class="c-plot">
              <div class="tl-axis mono">
                <!-- The day slot is always rendered, empty where the date has
                     not changed, so the times stay on one baseline. -->
                <span v-for="(t, i) in axis" :key="i" class="tick">
                  <span class="tick-day">{{ t.day ?? "" }}</span>
                  <span>{{ i === axis.length - 1 ? "now" : t.time }}</span>
                </span>
              </div>
            </th>
            <th class="c-read r">Reading</th>
            <th class="c-peak r p3">Peak</th>
          </tr>
        </thead>

        <tbody>
          <!-- Dimmed on the same signal as the charts above, which are
               fetched in the same pass. The Alerts row below is NOT dimmed:
               it comes from Alertmanager, a different source with a different
               pulse. -->
          <tr
            v-for="row in laneRows"
            :key="row.lane.key"
            class="tight"
            :class="{ stalerow: !!metricsStale }"
            :style="{ '--rail': rail(row.tone) }"
          >
            <td class="rail" />
            <td class="c-lane">
              <div class="lname">{{ row.lane.label }}</div>
              <div class="lsub mono">{{ row.lane.sub }}</div>
            </td>
            <td class="plot">
              <MetricChart
                :series="row.series"
                :tone="row.plotTone"
                :height="30"
                :y-max="row.lane.yMax"
                :format="row.lane.format"
                :from="from"
                :to="to"
              />
            </td>
            <td class="r c-read">
              <span class="mono now" :class="toneClass(row.tone)">{{ row.reading }}</span>
              <div class="fold3 lpeak mono">peak {{ row.peak }}</div>
            </td>
            <td class="r p3 c-peak"><span class="lpeak mono">{{ row.peak }}</span></td>
          </tr>

          <tr class="tight">
            <td class="rail" />
            <td class="c-lane">
              <div class="lname">Alerts</div>
              <div class="lsub mono">when each one started</div>
            </td>
            <td class="plot">
              <div class="events">
                <span
                  v-for="m in eventMarks"
                  :key="m.key"
                  class="mark"
                  :class="{ before: m.before }"
                  :style="{ left: m.left }"
                >
                  <span class="stem" :style="{ background: `var(--${m.tone})` }" />
                  <StatusDot :tone="m.tone" glow :size="7" />
                </span>
                <span class="sweep" />
              </div>
            </td>
            <td class="r c-read">
              <span class="count now">{{ eventMarks.length }}</span>
              <div class="fold3 lpeak mono">firing</div>
            </td>
            <td class="r p3 c-peak"><span class="lpeak mono">firing</span></td>
          </tr>
        </tbody>
      </table>
    </PanelBox>
  </Band>

  <!-- ONE ROW PER CARD, NOT ONE ROW PER METRIC. It was a metric-per-row grid
       with a column per card, which is a table drawn sideways: the RECORD here
       is a card, and reading it the other way is what made "Jellyfin sessions"
       a row spanning columns it has nothing to do with. It is the band's aside
       now, where a fact belonging to no card belongs. -->
  <Band label="GPU and playback">
    <template #aside>
      <span class="mono">
        <span class="count">{{ fmt.number(jellyfinSessions.data.value ?? Number.NaN) }}</span>
        Jellyfin sessions
      </span>
    </template>

    <PanelBox :stale="metricsStale">
      <p v-if="!gpu.data.value?.length" class="empty mono">no GPU reported</p>
      <table v-else class="tbl">
        <thead>
          <tr>
            <th class="c-card">Card</th>
            <th class="c-genc r">Encoder</th>
            <th class="c-gsm r p3">SM</th>
            <th class="c-gsess r">NVENC sessions</th>
            <th class="c-gtemp r p3">Temperature</th>
            <th class="c-gpow r p3">Board power</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="c in gpu.data.value" :key="c.id" class="tight">
            <td>
              <span class="mono">gpu{{ c.id }}</span>
              <span class="fold3 subline mono">
                SM {{ fmt.percent(c.sm, 0) }}, {{ fmt.celsius(c.temp) }}, {{ fmt.watts(c.power) }}
              </span>
            </td>
            <td class="r"><span class="mono">{{ fmt.percent(c.encoder, 0) }}</span></td>
            <td class="r p3"><span class="mono">{{ fmt.percent(c.sm, 0) }}</span></td>
            <td class="r"><span class="mono">{{ fmt.number(c.sessions) }} of 8</span></td>
            <td class="r p3"><span class="mono">{{ fmt.celsius(c.temp) }}</span></td>
            <td class="r p3"><span class="mono">{{ fmt.watts(c.power) }}</span></td>
          </tr>
        </tbody>
      </table>
      <p class="note mono">
        Two NVENC sessions already pin the encoder block at 100% while the SM sits near 10%, so a
        third GPU worker cannot encode faster. gpu0's video engines are dead hardware, so both
        consumers are pinned to gpu1 and gpu0 encodes nothing by design.
      </p>
    </PanelBox>
  </Band>
</template>

<style scoped>
/* --- the header ----------------------------------------------------------- */

.lead {
  display: flex;
  align-items: center;
  gap: 10px;
  min-width: 0;
}

.reading {
  font: var(--t-mono-xl);
  color: var(--fg);
}

.lead-sub {
  margin-top: 7px;
  font: var(--t-mono-sm);
  color: var(--fg-5);
}

.bad {
  color: var(--fail-text);
}

.warnish {
  color: var(--warn);
}

.dim {
  color: var(--fg-5);
}

/* --- the charts ----------------------------------------------------------- */

.value {
  font: var(--t-mono-lg);
  color: var(--fg);
}

/* Says the number is a reading from the cursor rather than the live one, so a
   frozen-looking figure is never mistaken for the current value. */
.value.hovered {
  color: var(--ok);
}

/* A timestamp is not a heading: it keeps its own case and its own figures. */
.at {
  color: var(--ok);
  text-transform: none;
  white-space: nowrap;
}

.foot {
  display: flex;
  justify-content: space-between;
  gap: 10px;
  margin-top: 8px;
  font: var(--t-mono-sm);
  color: var(--fg-5);
}

.swap {
  margin-top: 10px;
  padding-top: 9px;
  border-top: 1px solid var(--line);
}

.swap-head {
  display: flex;
  justify-content: space-between;
  font: var(--t-mono-sm);
  color: var(--fg-5);
}

.bar {
  height: 6px;
  border-radius: 3px;
  background: var(--track);
  overflow: hidden;
}

.fill {
  display: block;
  height: 100%;
  background: var(--ok);
}

/* --- the pressure table --------------------------------------------------- */

.c-rail {
  width: 30px;
}

/* MEASURED IN THE BROWSER, NOT CHOSEN. "time fully stalled on IO" is the widest
   sub at --t-mono-xs and needs 168px on top of 24px of cell padding; the first
   draft was 150 and wrapped two of the three rows, which made every row a
   different height. The sub is the half that goes at 640. */
.c-lane {
  width: 192px;
}

/* THE PLOT COLUMN CARRIES NO WIDTH, deliberately: under table-layout: fixed the
   unwidened columns split what is left, so it takes the whole remainder and the
   axis in its header lines up with it by construction. */
/* "0% / 89%" at --t-mono-lg is 80px and the GPU lane always prints both cards,
   so 96 wrapped the one reading on this page that is two numbers. */
.c-read {
  width: 104px;
}

.c-peak {
  width: 84px;
}

.tl-axis {
  display: flex;
  justify-content: space-between;
  font: var(--t-mono-xs);
  color: var(--fg-dim);
  text-transform: none;
  letter-spacing: normal;
  font-weight: 400;
}

.tick {
  display: flex;
  flex-direction: column;
  align-items: center;
  line-height: 1.35;
}

/* Brighter than the time it sits above: the date is the rarer, more orienting
   half. Empty on most ticks, where it only holds the baseline. */
.tick-day {
  color: var(--fg-4);
  min-height: 1.35em;
}

.lname {
  font: var(--t-ui-md);
  color: var(--fg-2);
}

.lsub {
  font: var(--t-mono-xs);
  color: var(--fg-5);
  margin-top: 3px;
}

.now {
  font: var(--t-mono-lg);
}

.lpeak {
  font: var(--t-mono-xs);
  color: var(--fg-5);
}

.fold3.lpeak {
  margin-top: 3px;
}

/* The charts above are fetched in the same pass and PanelBox dims them by its
   own `stale`; these rows are inside a panel that also holds the Alerts row,
   which comes from Alertmanager and must not be dimmed with them. */
tr.stalerow {
  opacity: 0.4;
  filter: saturate(0.5);
}

/* The chart and the event strip both fill their cell, and the cell's own
   padding is what keeps them off the reading beside them. */
.plot {
  padding-left: 4px;
  padding-right: 12px;
}

.events {
  position: relative;
  height: 30px;
  border-radius: var(--r-sm);
  background: var(--surface);
  border: 1px solid var(--line);
  overflow: hidden;
}

.mark {
  position: absolute;
  top: 0;
  bottom: 0;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 3px;
  transform: translateX(-50%);
}

.mark.before {
  opacity: 0.5;
}

.stem {
  width: 2px;
  height: 11px;
}

/* FULL WIDTH, with the band painted inside it as a background. It used to be a
   60px element translated by percentages of ITSELF, so it crossed 252px of a
   1200px lane and looped there. Now translateX(100%) is one whole lane. */
.sweep {
  position: absolute;
  inset: 0;
  background: linear-gradient(90deg, transparent, var(--ok-tint), transparent);
  background-size: var(--sweep-band) 100%;
  background-repeat: no-repeat;
  animation: sweep 6s linear infinite;
  pointer-events: none;
}

/* --- the GPU table -------------------------------------------------------- */

/* The card cell absorbs the slack: everything else is a fixed reading and a
   two-row table has no reason to stretch its numbers. */
.c-card {
  width: auto;
}

.c-genc,
.c-gtemp,
.c-gpow {
  width: 116px;
}

.c-gsm {
  width: 84px;
}

/* "NVENC sessions" is the longest header on the view at --t-label. */
.c-gsess {
  width: 148px;
}

.subline {
  margin-top: 4px;
  font: var(--t-mono-xs);
  color: var(--fg-5);
}

/* --- shared --------------------------------------------------------------- */

.empty {
  font: var(--t-mono-sm);
  color: var(--fg-dim);
  padding: 6px 4px;
}

.note {
  margin-top: 10px;
  padding-top: 9px;
  border-top: 1px solid var(--line);
  font: var(--t-mono-xs);
  color: var(--fg-5);
}

/* --- the phone ------------------------------------------------------------ */

@media (max-width: 640px) {
  /* THE RAIL NEEDS ITS WIDTH BACK ON THE CELL ONCE THE HEADER IS GONE. Under
     table-layout: fixed the column widths come from the first row, and
     `display: none` on the thead makes that the first BODY row - which carries
     no widths, so the surviving columns split evenly. */
  .tbl td.rail {
    width: 30px;
  }

  /* THE AXIS GOES WITH THE HEADER, AND THAT IS THE TRADE. Seven ticks in the
     ~130px this column has left at 390 is a grey smear below the 11px floor,
     and the four charts one band up carry their own x-axis - so the window is
     still legible, from the place it is readable. The reading is what must
     not leave, and it is the column this rack used to lose entirely: it was
     panned from 900 at a 620px min-width, so on a phone it was off screen. */
  .tbl thead {
    display: none;
  }

  /* "CPU pressure" at --t-ui-md is 84px, and the reading drops to --t-mono-md
     below - so 104 and 88 leave the plot about 110px of a 330px table. The
     reading is what must survive; the plot narrows around it. */
  .c-lane {
    width: 116px;
  }

  .c-read {
    width: 88px;
  }

  .lsub {
    display: none;
  }

  .plot {
    padding-right: 8px;
  }

  .now {
    font: var(--t-mono-md);
  }
}
</style>
