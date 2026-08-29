<script setup lang="ts">
/**
 * The fleet: what the machinery is doing, and what it costs.
 *
 * EVERYTHING HERE IS ABOUT THE MACHINE RATHER THAN THE WORK. A person watching
 * for a gate to answer never needs any of it, which is why it is no longer
 * four panels below the board: the round board asks "does this need me", and
 * this asks "is the thing that runs it healthy, contained and affordable".
 *
 * THIS IS THE ONLY AGENTS VIEW WITH A TIME AXIS, so it is the only one that
 * teleports a window picker. A picker that changes nothing on screen is a lie
 * about a control, and on the single page it sat above five panels that ignored
 * it.
 *
 * THE INTAKE PANEL IS THE PROVENANCE HALF OF A DELIBERATE DUPLICATION. The
 * board's tile answers "is the fleet armed"; this answers "who said so, and
 * why", and only this one carries the note. Both read useIntake(), so the state
 * word, the chip's label and the command it sends come off one derivation.
 */
import { computed, watch } from "vue";

import Band from "@/components/Band.vue";
import PanelBox from "@/components/PanelBox.vue";
import StatusDot from "@/components/StatusDot.vue";
import ChipButton from "@/components/ChipButton.vue";
import ProgressBar from "@/components/ProgressBar.vue";
import MetricChart from "@/components/MetricChart.vue";
import ActivityBars from "@/components/ActivityBars.vue";
import FindingsPanel from "@/components/FindingsPanel.vue";
import WindowPicker from "@/components/WindowPicker.vue";

import { usePoll } from "@/composables/usePoll";
import { useMetricsStale } from "@/composables/useStaleness";
import { useTimeWindow } from "@/composables/useTimeWindow";
import { useTooltip } from "@/composables/useTooltip";
import { useIntake } from "@/composables/useIntake";
import { useHostStore } from "@/stores/host";
import { useFleetStore } from "@/stores/fleet";
import { instant, range, value } from "@/api/prometheus";
import { AGENTS } from "@/queries";
import { toPoints } from "@/charts";
import { dailyPeaks, utcDayStarts } from "@/uptime";
import type { InstantSeries, Tone } from "@/types";
import * as fmt from "@/format";

const { window: win } = useTimeWindow();
const tip = useTooltip();
const host = useHostStore();
const fleet = useFleetStore();
const metricsStale = useMetricsStale();

const INTAKE_STALE_S = 3600; // agents.intake
const WINDMILL_DB_MAX = 2048 * 1024 * 1024; // agents.windmill_db_size
const STRIP_DAYS = 14;

// --- the numbers -------------------------------------------------------------

const metrics = usePoll(async (signal) => {
  const one = (r: InstantSeries[]) => value(r[0]?.value);
  const [
    phaseInFlight, intakeLast, tokensToday, tokensWeek, runsToday, runsFailedToday,
    approvals, leaked, windmillDb, workerLanes, mirrorAge, checkoutDirty,
    publishConfigured, sliceOom, sliceMemMax,
  ] = await Promise.all([
    instant(AGENTS.phaseInFlight, signal),
    instant(AGENTS.intakeLast, signal),
    instant(AGENTS.tokensToday, signal),
    instant(AGENTS.tokensWeek, signal),
    instant(AGENTS.runsToday, signal),
    instant(AGENTS.runsFailedToday, signal),
    instant(AGENTS.approvalsPending, signal),
    instant(AGENTS.runnersLeaked, signal),
    instant(AGENTS.windmillDbBytes, signal),
    instant(AGENTS.workerLanes, signal),
    instant(AGENTS.mirrorAge, signal),
    instant(AGENTS.checkoutDirty, signal),
    instant(AGENTS.publishConfigured, signal),
    instant(AGENTS.sliceOom, signal),
    instant(AGENTS.sliceMemoryMax, signal),
  ]);

  return {
    // ABSENT IS undefined, NOT NaN: a phase that has never run must render grey
    // rather than as one that is not running.
    phaseInFlight: phaseInFlight.length ? value(phaseInFlight[0].value) : undefined,
    intakeLast: one(intakeLast),
    tokensToday: one(tokensToday),
    tokensWeek: one(tokensWeek),
    runsToday: one(runsToday),
    runsFailedToday: one(runsFailedToday),
    approvals: one(approvals),
    leaked: one(leaked),
    windmillDb: one(windmillDb),
    workerLanes: one(workerLanes),
    mirrorAge: one(mirrorAge),
    checkoutDirty: one(checkoutDirty),
    publishConfigured: one(publishConfigured),
    sliceOom: one(sliceOom),
    sliceMemMax: one(sliceMemMax),
  };
}, 30_000);

const m = computed(() => metrics.data.value);

// --- charts and strips -------------------------------------------------------
// THREE RANGES, NOT FIVE. The single page also fetched slicePids and the hourly
// FAILED counter and drew neither.

const charts = usePoll(async (signal) => {
  const options = { window: win.value.seconds, step: win.value.step, signal };
  const dayOptions = { window: STRIP_DAYS * 86400, step: 3600, signal };

  const [sliceMem, runsHourly, tokensHourly] = await Promise.all([
    range(AGENTS.sliceMemory, options),
    range(AGENTS.runsHourly, dayOptions),
    range(AGENTS.tokensHourly, dayOptions),
  ]);

  const peaks = (rows: typeof runsHourly) =>
    rows[0] ? dailyPeaks(toPoints(rows[0].values), STRIP_DAYS, host.now) : [];

  return {
    sliceMem: sliceMem[0] ? toPoints(sliceMem[0].values) : [],
    runs: peaks(runsHourly),
    tokens: peaks(tokensHourly),
  };
}, 60_000);

watch(win, () => {
  void charts.refresh();
});

const c = computed(() => charts.data.value);
const from = computed(() => host.now - win.value.seconds);

/** Oldest first, matching dailyPeaks' own indexing so the two cannot drift. */
const stripDays = computed(() => utcDayStarts(STRIP_DAYS, host.now));

// --- intake ------------------------------------------------------------------

const midPhase = computed(() => m.value?.phaseInFlight === 1);
const intake = useIntake(midPhase);

const intakeAge = computed(() => {
  const at = m.value?.intakeLast;
  return at === undefined || !Number.isFinite(at) ? Number.NaN : host.now - at;
});

// --- containment -------------------------------------------------------------

const CONTAINMENT = ["agents.slice_limits", "agents.runner_isolation", "agents.fleet_root_label"];

const containment = computed(() =>
  CONTAINMENT.map((id) => {
    const check = host.byId.get(id) ?? null;
    const tone: Tone = check ? (check.status === "pass" ? "ok" : "warn") : "off";
    return { id, tone, message: check?.message ?? "not measured in the last run" };
  }),
);

// --- tooltips ----------------------------------------------------------------

/**
 * The check's own prose, which is the ONLY route to the oldest step's age.
 *
 * bin/verify-host.sh measures it - `max(now - created_at)` over the suspended
 * jobs - and puts the hours in this message while recording only the COUNT as a
 * fact. So the age exists nowhere else in this application, and displaying the
 * sentence is not laziness: it is the one thing that can say a gate has been
 * waiting since yesterday. Keyed on the stable id, displayed and never parsed.
 */
const approvalsCheck = computed(() => host.byId.get("agents.approvals_pending") ?? null);

const approvalTip = computed(() => ({
  title: "suspended steps",
  lines: [
    `${fmt.number(m.value?.approvals ?? Number.NaN)} waiting in Windmill`,
    approvalsCheck.value?.message ?? "the battery has not graded this",
  ],
  caveat:
    "An UPPER BOUND. This counts conduct's own suspended steps as well as a person's, and the SQL behind it cannot separate them - both are suspend > 0. The round board is what actually distinguishes them.",
}));

const leakedTip = computed(() => ({
  title: "leaked runners",
  lines: [`${fmt.number(m.value?.leaked ?? Number.NaN)} ephemeral containers past their ceiling`],
  caveat:
    "This watches TWO fleets. conduct-* and ci-* both carry io.home-server.ephemeral, so a CI lane running long shows up here too.",
}));

const publishTip = computed(() => ({
  title: "publish credential",
  lines: [(m.value?.publishConfigured ?? 0) === 1 ? "configured" : "not configured"],
  caveat:
    "Proves a key file and a workspace row EXIST, not that the token is unexpired - a fine-grained PAT expires, and the check is named for what it can prove. The live proof is the push itself.",
}));

const workerTip = computed(() => ({
  title: "worker lanes",
  lines: [`${fmt.number(m.value?.workerLanes ?? Number.NaN)} distinct tag sets answering`],
  caveat:
    "Read back out of Postgres, not from the quadlet. A worker's tags hot-reload from a row the UI can edit, so WORKER_TAGS= is a bootstrap that leaves no trace in git when it is overridden.",
}));

const mirrorTip = computed(() => ({
  title: "mirror",
  lines: [`last fetch ${fmt.since(host.now - (m.value?.mirrorAge ?? Number.NaN))}`],
  caveat:
    "FETCH_HEAD's mtime dates the ATTEMPT, not the change - which is the only reason a mirror that stopped fetching can be told from one nobody pushed to.",
}));

const runsTip = computed(() => ({
  title: `runs, last ${STRIP_DAYS} days`,
  lines: ["one bar per UTC day, peak of the day's counter"],
  caveat:
    "UTC, not local. These are gauges conduct resets at midnight and the host runs UTC - bucketing them into local days would take each bar's maximum from the tail of the previous day.",
}));

const costTip = computed(() => ({
  title: "cost",
  lines: [
    `${fmt.number(fleet.totals?.cost_today ?? Number.NaN, 2)} USD today`,
    `${fmt.number(fleet.totals?.cost_week ?? Number.NaN, 2)} USD over seven days`,
  ],
  caveat:
    "Reported, never retained: this comes from fleet.json, which keeps no history. Cost is not what paces the fleet - the quota status is, and there is deliberately no dollar ceiling anywhere.",
}));
</script>

<template>
  <Teleport defer to="#toolbar">
    <WindowPicker />
  </Teleport>

  <Band label="Capacity and cost" :cols="3">
    <!-- A DIFFERENT UNIT FROM THE BOARD, and the label has to say so. A round
         is one task through five phases, so `runs_today = 6` is six PHASE
         executions and could be one round or three. -->
    <PanelBox label="Phase runs" :stale="metricsStale">
      <template #aside>
        <span class="count">{{ fmt.number(m?.runsToday ?? Number.NaN) }}</span> today,
        <span class="count">{{ fmt.number(m?.runsFailedToday ?? Number.NaN) }}</span> failed
      </template>
      <div v-bind="tip.hover('ag-runs', runsTip)">
        <ActivityBars :values="c?.runs ?? []" :height="34" stretch />
      </div>
      <p class="axis mono">
        <span>{{ fmt.dayMonth(stripDays[0]) }}</span>
        <span>{{ STRIP_DAYS }} UTC days</span>
        <span>{{ fmt.dayMonth(stripDays[stripDays.length - 1]) }}</span>
      </p>
      <p class="note">
        Bucketed on UTC, because these are gauges conduct resets at midnight and the host runs
        UTC. A grey bar is a day the store has no sample for, not a day nothing ran.
      </p>
    </PanelBox>

    <PanelBox label="Tokens and cost" :stale="metricsStale">
      <template #aside>
        <span class="mono" v-bind="tip.hover('ag-cost', costTip)">
          {{ fmt.number(fleet.totals?.cost_today ?? Number.NaN, 2) }} USD today
        </span>
      </template>
      <ActivityBars :values="c?.tokens ?? []" :height="34" stretch />
      <div class="pairs">
        <span class="mono">{{ fmt.number(m?.tokensToday ?? Number.NaN) }} tokens today</span>
        <span class="mono faint">{{ fmt.number(m?.tokensWeek ?? Number.NaN) }} this week</span>
        <span class="mono faint">
          {{ fmt.number(fleet.totals?.cost_week ?? Number.NaN, 2) }} USD week
        </span>
      </div>
      <p class="note">
        conduct's own tally of its runs, not the account window - that is the quota status on the
        board, which is a status and deliberately not a number. Cost comes from fleet.json and is
        kept nowhere.
      </p>
    </PanelBox>

    <PanelBox label="Slice memory" :stale="metricsStale">
      <template #aside><span class="mono">app-agents.slice</span></template>
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
        :y-max="m?.sliceMemMax"
        :tone="(m?.sliceOom ?? 0) > 0 ? 'fail' : 'ok'"
      />
      <p class="note">
        A ceiling is not usage. The frame is what the slice may take: this one reserves 4,608M
        against a 30-day median nearer 957 MB, with a phase in flight about 7% of the time.
      </p>
    </PanelBox>
  </Band>

  <Band label="Control plane" :cols="2">
    <PanelBox label="Windmill and git" :stale="metricsStale">
      <div class="tiles">
        <div class="tile" v-bind="tip.hover('ag-approvals', approvalTip)">
          <span class="label">suspended steps</span>
          <span class="count tvalue">{{ fmt.number(m?.approvals ?? Number.NaN) }}</span>
          <span class="sub truncate">
            {{ approvalsCheck?.message ?? "an upper bound, see the tooltip" }}
          </span>
        </div>
        <div class="tile" v-bind="tip.hover('ag-workers', workerTip)">
          <span class="label">worker lanes</span>
          <span class="count tvalue">{{ fmt.number(m?.workerLanes ?? Number.NaN) }}</span>
          <span class="sub">distinct tag sets answering</span>
        </div>
        <div class="tile">
          <span class="label">windmill db</span>
          <span
            class="mono tvalue"
            :class="{ warnish: (m?.windmillDb ?? 0) > WINDMILL_DB_MAX * 0.9 }"
          >
            {{ fmt.bytes(m?.windmillDb ?? Number.NaN) }}
          </span>
          <ProgressBar
            :ratio="
              Number.isFinite(m?.windmillDb ?? Number.NaN) ? m!.windmillDb / WINDMILL_DB_MAX : null
            "
            tone="ok"
          />
        </div>
        <div class="tile" v-bind="tip.hover('ag-mirror', mirrorTip)">
          <span class="label">mirror fetch</span>
          <span class="mono tvalue">{{ fmt.coarse(m?.mirrorAge ?? Number.NaN) }} ago</span>
          <span class="sub">the attempt, not the change</span>
        </div>
        <div class="tile">
          <span class="label">checkout</span>
          <span class="mono tvalue" :class="{ warnish: (m?.checkoutDirty ?? 0) > 0 }">
            {{ (m?.checkoutDirty ?? 0) > 0 ? `${fmt.number(m!.checkoutDirty)} dirty` : "clean" }}
          </span>
          <span class="sub">/var/home-server against git</span>
        </div>
        <div class="tile" v-bind="tip.hover('ag-publish', publishTip)">
          <span class="label">publish key</span>
          <span class="mono tvalue">
            {{ (m?.publishConfigured ?? 0) === 1 ? "configured" : "not configured" }}
          </span>
          <span class="sub">exists, which is not the same as unexpired</span>
        </div>
      </div>
    </PanelBox>

    <PanelBox label="Intake" :stale="fleet.stale">
      <template #aside>
        <span class="mono" :class="{ warnish: intakeAge > INTAKE_STALE_S }">
          last looked {{ Number.isFinite(intakeAge) ? `${fmt.coarse(intakeAge)} ago` : "never" }}
        </span>
      </template>

      <div v-if="fleet.intake.length" class="intake">
        <div v-for="i in fleet.intake" :key="i.project" class="irow">
          <span class="mono iproject">{{ i.project }}</span>
          <span class="iwhy">{{ i.last_why ?? "no reason recorded" }}</span>
        </div>
      </div>
      <p v-else class="empty mono">The fleet has not looked for work on this host yet.</p>

      <!-- THE SWITCH IN FRONT OF THE PASS THAT CHOOSES, and it says which of
           the two sources is in force. conduct's descriptor is the shipped
           default and a control row overrides it without a restart, so "is
           intake armed" now has an answer and a plausible wrong one. The
           collector cannot read a Python literal in another repository, so
           "default" does not claim to know WHICH default. -->
      <div class="switch">
        <span class="sname">choose its own work</span>
        <span class="mono" :class="intake.state.value.tone === 'ok' ? 'onish' : 'offish'">
          {{ intake.state.value.state }}
        </span>
        <!-- THE SENTENCE IS THIS DRAWING'S OWN, and the board's is not. This one
             carries the note, because the panel is the record of who set it and
             why; the board carries only the age, because it answers a different
             question. The state, the chip and the command are the parts that
             must not differ, and those come from one function. -->
        <span class="sub truncate">{{
          intake.askedFor.value !== null
            ? intake.sub.value
            : intake.state.value.source === "set"
              ? `set by hand ${fmt.sinceIso(intake.state.value.at)}${
                  intake.state.value.note ? ` - ${intake.state.value.note}` : ""
                }`
              : "conduct's own default, unchanged"
        }}</span>
        <ChipButton
          :label="intake.state.value.label"
          :disabled="intake.disabled.value"
          :act="() => intake.toggle()"
          :title="intake.state.value.title"
          :pending="intake.askedFor.value !== null"
        />
      </div>

      <p class="note">
        AN INTAKE THAT HAS STOPPED LOOKS EXACTLY LIKE AN EMPTY BACKLOG. Both leave every unit
        active and every container healthy, and only the AGE of that last look tells them apart -
        never the sentence.
      </p>
    </PanelBox>
  </Band>

  <PanelBox label="Containment" :stale="metricsStale">
    <table class="tbl">
      <thead>
        <tr>
          <th class="c-rail" />
          <th class="c-id">Check</th>
          <th>Finding</th>
        </tr>
      </thead>
      <tbody>
        <tr v-for="ch in containment" :key="ch.id">
          <td class="rail" :style="{ '--rail': `var(--${ch.tone})` }">
            <StatusDot :tone="ch.tone" :size="6" />
          </td>
          <td class="mono cid">{{ ch.id }}</td>
          <td class="msg">{{ ch.message }}</td>
        </tr>
        <tr v-bind="tip.hover('ag-leaked', leakedTip)">
          <td class="rail" :style="{ '--rail': (m?.leaked ?? 0) > 0 ? 'var(--warn)' : 'var(--ok)' }">
            <StatusDot :tone="(m?.leaked ?? 0) > 0 ? 'warn' : 'ok'" :size="6" />
          </td>
          <td class="mono cid">runners leaked</td>
          <td class="msg">
            {{ fmt.number(m?.leaked ?? Number.NaN) }} past the ceiling, across both fleets
          </td>
        </tr>
      </tbody>
    </table>
    <p class="note">
      The first three are what AgentContainmentLost pages on, matched by the same ids. They appear
      again in the battery's own findings below - this panel is not a second reading of them, it is
      the three that page said in one place.
    </p>
  </PanelBox>

  <FindingsPanel label="Agent checks" section="agents" all />
</template>

<style scoped>
.tiles {
  display: grid;
  grid-template-columns: repeat(3, minmax(0, 1fr));
  gap: var(--gap-lg);
}

.tile {
  display: flex;
  flex-direction: column;
  gap: 5px;
  min-width: 0;
}

.tvalue {
  font: var(--t-mono-md);
  color: var(--fg-2);
}

.count.tvalue {
  font: var(--t-count);
}

.sub {
  font: var(--t-mono-xs);
  color: var(--fg-5);
}

.warnish {
  color: var(--warn);
}

.faint {
  color: var(--fg-5);
}

.axis {
  display: flex;
  justify-content: space-between;
  font: var(--t-mono-xs);
  color: var(--fg-5);
  margin-top: 7px;
}

.pairs {
  display: flex;
  flex-wrap: wrap;
  gap: 16px;
  margin-top: 11px;
  font: var(--t-mono-sm);
  color: var(--fg-2);
}

/* The intake switch: a label, its state, where the answer came from, and the
   one control that moves it. */
.switch {
  display: grid;
  grid-template-columns: minmax(0, auto) auto minmax(0, 1fr) auto;
  align-items: center;
  gap: var(--gap);
  padding: 12px 0 3px;
  border-top: 1px solid var(--border-divider);
  margin-top: 12px;
}

.sname {
  font: var(--t-ui-md);
  color: var(--fg-3);
}

.onish {
  font: var(--t-mono-md);
  color: var(--ok);
}

.offish {
  font: var(--t-mono-md);
  color: var(--fg-5);
}

.intake {
  display: flex;
  flex-direction: column;
  gap: 9px;
}

.irow {
  display: grid;
  grid-template-columns: 110px minmax(0, 1fr);
  gap: var(--gap);
  align-items: baseline;
}

.iproject {
  font: var(--t-mono-sm);
  color: var(--fg-3);
}

.iwhy {
  font: var(--t-ui-sm);
  color: var(--fg-2);
}

.c-rail {
  width: 30px;
}

.c-id {
  width: 232px;
}

.cid {
  font: var(--t-mono-sm);
  color: var(--fg-4);
}

.msg {
  font: var(--t-ui-sm);
  color: var(--fg-2);
}

.note {
  margin-top: 12px;
  padding-top: 11px;
  border-top: 1px solid var(--border-divider);
  font: var(--t-ui-xs);
  color: var(--fg-5);
}

.empty {
  font: var(--t-mono-sm);
  color: var(--fg-dim);
  padding: 8px 4px;
}

@media (max-width: 1180px) {
  .tiles {
    grid-template-columns: repeat(2, minmax(0, 1fr));
  }
}
</style>
