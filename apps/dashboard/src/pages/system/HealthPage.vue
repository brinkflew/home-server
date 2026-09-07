<script setup lang="ts">
/**
 * /system/health: is anything wrong?
 *
 * THE ALERTS ARE SECOND, AND THEY WERE BAND SIX OF SEVEN. They are the thing a
 * person opens this section to find - the phone buzzed and this is where the
 * sentence explaining it lives - and everything they used to sit under is now
 * one view along. What stays above them is the lead, because it is what tones
 * the page, and three conditions, because they are the summary the alert is an
 * exception to.
 *
 * NO RANGE QUERIES AND THEREFORE NO CURSOR. The conditions were sampled off the
 * shared crosshair, which was worth having while the four charts were on the
 * same page; they are one view away now, so this asks for nine instants instead
 * of sixteen ranges and reads "now" without qualification. src/system.ts is
 * unchanged by that - conditionRows takes a SystemMetrics struct and does not
 * care whether the numbers came from a range or an instant, which is the whole
 * return on having extracted it.
 *
 * THE FULLEST MOUNT IS DRAWN HERE AND ON /system/storage ON PURPOSE - the
 * condition here, the table there. One derivation feeds both: sys.mountReading
 * and sys.fullestMount, the way useIntake() keeps the two intake chips one
 * answer. A second copy of that arithmetic is how the two would start
 * disagreeing about which mount is full.
 */
import { computed } from "vue";

import Band from "@/components/Band.vue";
import FindingsPanel from "@/components/FindingsPanel.vue";
import PanelBox from "@/components/PanelBox.vue";
import StatusDot from "@/components/StatusDot.vue";
import UptimeBars from "@/components/UptimeBars.vue";

import { usePoll } from "@/composables/usePoll";
import { useMetricsStale } from "@/composables/useStaleness";
import { useHostStore } from "@/stores/host";
import { instant, instantBy, range, value } from "@/api/prometheus";
import { bySeverityThenTime, fetchAlerts, isHeartbeat } from "@/api/alerts";
import { AVAILABILITY, SYSTEM } from "@/queries";
import { toPoints } from "@/charts";
import { dailyRatios, ratioSummary } from "@/uptime";
import * as sys from "@/system";
import * as fmt from "@/format";
import type { Tone } from "@/types";

const host = useHostStore();
const metricsStale = useMetricsStale();

// ---------------------------------------------------------------------------
// The three conditions, as instants
// ---------------------------------------------------------------------------
const now = usePoll(async (signal) => {
  const [cpu, stalled, load1, memUsed, memTotal, swapUsed, swapTotal, size, avail] =
    await Promise.all([
      instant(SYSTEM.cpuBusy, signal).then((r) => value(r[0]?.value)),
      instant(SYSTEM.cpuPressure, signal).then((r) => value(r[0]?.value)),
      instant(SYSTEM.load1, signal).then((r) => value(r[0]?.value)),
      instant(SYSTEM.memoryUsed, signal).then((r) => value(r[0]?.value)),
      instant(SYSTEM.memoryTotal, signal).then((r) => value(r[0]?.value)),
      instant(SYSTEM.swapUsed, signal).then((r) => value(r[0]?.value)),
      instant(SYSTEM.swapTotal, signal).then((r) => value(r[0]?.value)),
      instant(SYSTEM.filesystems, signal),
      instantBy(SYSTEM.filesystemAvail, "mountpoint", signal),
    ]);

  const mounts = size.map((s) => {
    const mountpoint = s.metric.mountpoint ?? "?";
    return sys.mountReading(mountpoint, value(s.value), avail.get(mountpoint) ?? Number.NaN);
  });

  return { cpu, stalled, load1, memUsed, memTotal, swapUsed, swapTotal, mounts };
}, 30_000);

const metrics = computed<sys.SystemMetrics | null>(() => {
  const d = now.data.value;
  if (!d) return null;

  const full = sys.fullestMount(d.mounts);
  return {
    cpuBusy: d.cpu,
    cpuStalled: d.stalled,
    load1: d.load1,
    memUsed: d.memUsed,
    memTotal: d.memTotal,
    swapUsed: d.swapUsed,
    swapTotal: d.swapTotal,
    fullest: full ? { mountpoint: full.mountpoint, ratio: full.ratio, free: full.free } : null,
    mounts: d.mounts.length,
  };
});

/**
 * `next_version`, NOT `staged_version`. The battery renamed the key and said in
 * a comment which reader it meant; this page was that reader and was never
 * updated, so the amber "staged" chip was dead on the live host and perfect in
 * every screenshot. See FACT_KEYS in src/system.ts.
 */
const reading = computed<sys.HostReading>(() => ({
  uptimeS: host.numericFact("uptime_s"),
  booted: (host.fact("booted_version") as string | null) ?? null,
  next: (host.fact("next_version") as string | null) ?? null,
  nextFinalized: (host.fact("next_finalized") as string | null) ?? null,
}));

const conds = computed(() => sys.conditionRows(metrics.value));
const osLine = computed(() => sys.osLine(host.doc ? reading.value : null));
const lead = computed(() => sys.hostLead(host.doc ? reading.value : null, conds.value));

/** A tone on a value, without a fourth colour: fail and warn speak, ok is the
 *  ordinary body colour and off is the dim one. */
function toneClass(tone: Tone): Record<string, boolean> {
  return { bad: tone === "fail", warnish: tone === "warn", dim: tone === "off" };
}

// ---------------------------------------------------------------------------
// Alerts. See src/api/alerts.ts.
// ---------------------------------------------------------------------------
const alerts = usePoll((signal) => fetchAlerts(signal), 30_000);

/** The heartbeat is NOT one of these. It always fires, so listing it puts a
 *  permanent amber row above every real alert and makes "4 firing" mean three. */
const sortedAlerts = computed(() =>
  [...(alerts.data.value ?? [])].filter((a) => !isHeartbeat(a)).sort(bySeverityThenTime),
);

/**
 * HIDING IT MUST NOT HIDE ITS ABSENCE, which is the only thing it ever had to
 * say. `expr: vector(1)` cannot stop firing while Prometheus evaluates rules
 * and Alertmanager holds them, so a response that does not contain it is the
 * chain being broken - the finding the rule exists to produce.
 *
 * Guarded on there being a response at all: Alertmanager unreachable already
 * dims this panel with its own sentence, and must not additionally be reported
 * as a dead heartbeat.
 */
const heartbeatLost = computed(
  () =>
    alerts.error.value === null &&
    alerts.data.value !== null &&
    !alerts.data.value.some(isHeartbeat),
);

// ---------------------------------------------------------------------------
// Thirty days of availability
// ---------------------------------------------------------------------------
const AVAILABILITY_ROWS = 5;

const availability = usePoll(async (signal) => {
  // An HOURLY step, deliberately: dailyRatios buckets into local days and needs
  // samples inside them to do it. See the comment on the query itself.
  const matrix = await range(AVAILABILITY.containerHourly, { window: 30 * 86400, step: 3600, signal });

  return matrix
    .map((s) => {
      const days = dailyRatios(toPoints(s.values), 30);
      const known = days.filter(Number.isFinite);
      const worst = known.length ? Math.min(...known) : 1;
      return { name: s.metric.container ?? "?", days, worst, summary: ratioSummary(days) };
    })
    // Worst first: a strip of five perfect rows tells you nothing, and the
    // one that dipped is the only reason to look.
    .sort((a, b) => a.worst - b.worst)
    .slice(0, AVAILABILITY_ROWS);
}, 300_000);
</script>

<template>
  <!-- THE HEADLINE LEADS. --t-mono-xl is "the one headline reading" and this
       section consumed it nowhere until the last pass; the uptime it carries
       was in the shell toolbar, in a span capped at 210px, so the live string
       clipped to "uCore 44.2026..." and the number was never on screen. -->
  <Band label="Right now">
    <template #aside><span class="mono">{{ osLine }}</span></template>

    <PanelBox :stale="metricsStale">
      <div class="lead">
        <StatusDot :tone="lead.tone" :live="lead.live" :size="9" />
        <span class="reading mono">{{ lead.text }}</span>
      </div>

      <!-- NO PROGRESS BAR. There is no denominator for uptime, and a bare track
           is the encoding this store reserves for "in progress, ratio unknown".
           What is staged goes here because it is the thing the reading is
           about: 41 days up with an image waiting is a different sentence from
           41 days up with nothing to apply. -->
      <p class="lead-sub mono">{{ lead.sub }}</p>

      <div class="conds">
        <div v-for="c in conds" :key="c.id" class="cond">
          <span class="label">{{ c.label }}</span>
          <span class="mono cvalue" :class="toneClass(c.tone)">{{ c.value }}</span>
          <span class="mono sub">{{ c.sub }}</span>
        </div>
      </div>
    </PanelBox>
  </Band>

  <!-- SECOND, AND FULL WIDTH BECAUSE THE PROSE IS THE PANEL. At a third of the
       page every description truncated mid-sentence - "Last e...", "in ab..." -
       which is the half of an alert that says what to do about it. -->
  <Band label="Alerts">
    <template #aside>
      <span class="mono"><span class="count">{{ sortedAlerts.length }}</span> firing</span>
    </template>

    <PanelBox sunken :stale="alerts.error.value ? 'alertmanager could not be reached' : null">
      <ul v-if="sortedAlerts.length" class="alerts">
        <li v-for="a in sortedAlerts" :key="a.fingerprint ?? a.labels.alertname" class="alert">
          <div class="alert-head">
            <StatusDot :tone="a.labels.severity === 'critical' ? 'fail' : 'warn'" :size="5" />
            <span class="alert-name mono">{{ a.labels.alertname }}</span>
            <span class="alert-age mono">{{ fmt.sinceIso(a.startsAt, host.now) }}</span>
          </div>
          <div class="alert-summary">{{ a.annotations.summary ?? "" }}</div>
          <div class="alert-detail mono">{{ a.annotations.description ?? "" }}</div>
        </li>
      </ul>
      <p v-else class="empty mono">nothing firing</p>

      <!-- The heartbeat is hidden while it is alive, because firing IS the
           healthy state. Its absence is the finding, and it is the only thing
           this rule was ever able to say. -->
      <p v-if="heartbeatLost" class="note lost mono">
        The alerting heartbeat is not firing, so the notification chain is unproven. Check
        alertmanager, then ntfy-alertmanager, then ntfy, in that order.
      </p>
    </PanelBox>
  </Band>

  <Band label="Uptime, 30 days">
    <template #aside><span>worst five</span></template>

    <PanelBox :stale="metricsStale">
      <div class="uptime">
        <div v-for="row in availability.data.value ?? []" :key="row.name" class="uprow">
          <div class="uphead mono">
            <span>{{ row.name }}</span>
            <span :style="{ color: row.worst < 0.999 ? 'var(--warn)' : 'var(--ok)' }">{{ row.summary }}</span>
          </div>
          <UptimeBars :days="row.days" />
        </div>
      </div>
    </PanelBox>
  </Band>

  <!-- THE EVIDENCE IS LAST, which is the reading order the other pages settled
       on: the reading, the history, then the evidence. It was FIRST here, as a
       fixed-height scroller clipping a row mid-height.

       Unfiltered, deliberately: this is the one place all of them live, and it
       stays on the view whose question it answers. The tables on the other two
       carry the value, this carries the prose. -->
  <FindingsPanel />
</template>

<style scoped>
/* --- the header ----------------------------------------------------------- */

.lead {
  display: flex;
  align-items: center;
  gap: 10px;
  min-width: 0;
}

/* --t-mono-xl, which tokens.css describes as "the one headline reading". One
   per view is the whole point of it. */
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
   below 640 - the round board's recipe, unchanged through four pages. */
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

/* Three states and no fourth colour: fail and warn speak for themselves, ok is
   the ordinary body colour, and off is the dim one - never green. */
.bad {
  color: var(--fail-text);
}

.warnish {
  color: var(--warn);
}

.dim {
  color: var(--fg-5);
}

/* --- alerts and uptime ---------------------------------------------------- */

/* NO max-height NOW THAT IT IS BAND TWO. It was a 320px scroller because it sat
   sixth and everything below it had to stay reachable; a list that is the
   reason the view exists must not hide its own tail behind an inner scrollbar,
   and there are four bands here rather than seven. */
.alerts {
  display: flex;
  flex-direction: column;
  gap: 10px;
}

.alert-head {
  display: flex;
  align-items: center;
  gap: 8px;
}

.alert-name {
  font: var(--t-mono-md);
  color: var(--fg-2);
}

.alert-age {
  margin-left: auto;
  font: var(--t-mono-xs);
  color: var(--fg-5);
}

.alert-summary {
  font: var(--t-ui-sm);
  color: var(--fg-3);
  margin-top: 3px;
}

/* NOT TRUNCATED. This is the sentence that says what to do, and in a third of
   the page it was clipped to "Retention runs from the workstation:
   bin/backup-offsite.sh. I..." with the rest on a title nobody hovers. */
.alert-detail {
  font: var(--t-mono-xs);
  color: var(--fg-5);
  margin-top: 2px;
}

.uptime {
  display: flex;
  flex-direction: column;
  gap: 9px;
}

.uphead {
  display: flex;
  justify-content: space-between;
  font: var(--t-mono-sm);
  color: var(--fg-3);
  margin-bottom: 5px;
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

.note.lost {
  color: var(--fail-text);
}

/* --- the tablet ----------------------------------------------------------- */

@media (max-width: 900px) {
  .conds {
    display: flex;
    flex-wrap: wrap;
  }
}

/* The conditions, on a phone: the label moves left of its value, three rows, one
   condition each, labels in a column of their own. The 92px fallback is the
   width of MEMORY at --t-label, measured, and is what the browser uses where
   subgrid is unavailable. */
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
