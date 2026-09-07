<script setup lang="ts">
/**
 * The fleet: what the machinery is doing, and what it costs.
 *
 * EVERYTHING HERE IS ABOUT THE MACHINE RATHER THAN THE WORK. A person watching
 * for a gate to answer never needs any of it, which is why it is no longer four
 * panels below the board: the round board asks "does this need me", and this
 * asks "is the thing that runs it healthy, contained and affordable".
 *
 * IT IS THE ROUND BOARD'S SHAPE NOW, AND IT WAS THE SHAPE THAT BOARD WAS FIXED
 * FOR. This page opened on three equal panels about three unrelated things -
 * "a sparse row of unrelated numbers with no primary and a great deal of air",
 * which is the complaint that produced the Rounds headline in the first place -
 * and it consumed --t-mono-xl, "the one headline reading", nowhere at all. The
 * two views sit one sub-nav tab apart and read as two applications. So: a lead
 * reading over three conditions, then history, then the facts as a table.
 *
 * THE BAND IS `Today` AND NOT `Right now`, which is the Rounds band one tab
 * over. Three of the four readings in it are gauges conduct resets at UTC
 * midnight; the memory condition is the exception and says its own scope.
 *
 * THE SIX TILES BECAME A TABLE, because the design system says a list of
 * records is a table and never a grid of cards - and the Containment panel that
 * reproduced FindingsPanel's markup directly above a FindingsPanel is gone into
 * the same one. Ten rows, one surface. src/machine.ts owns the two decisions.
 *
 * THIS IS THE ONLY AGENTS VIEW WITH A TIME AXIS, so it is the only one that
 * teleports a window picker. A picker that changes nothing on screen is a lie
 * about a control - AND HALF THIS BAND WAS THAT LIE UNTIL 2026-09-07. Runs and
 * tokens were fourteen hardcoded UTC days of ActivityBars beside a memory chart
 * that did answer the picker, so moving it moved one card of two.
 *
 * SO THE STRIPS BECAME TWO CHART LANES, on the shared-timeline idiom that now
 * lives in pages/system/LoadPage.vue.
 * Three things came with that and the third is the point: a crosshair readout,
 * which the strips could not have because ActivityBars is documented as "not
 * meant to be read as a number"; the window; and useCrosshair being
 * module-level, so hovering the runs lane marks the same instant on tokens AND
 * on slice memory in the card beside it. A memory spike can finally be read
 * against the run that caused it.
 *
 * NOTHING IS REDUCED OR DERIVED. These are gauges conduct resets at UTC
 * midnight with no cumulative counter behind them anywhere, so the sawtooth IS
 * the metric - and a per-bucket "increment" at any rung of the picker would be
 * client-side reset arithmetic reported as a measurement.
 *
 * THE INTAKE PANEL IS THE PROVENANCE HALF OF A DELIBERATE DUPLICATION, AND IT
 * IS SECOND ON THE PAGE. The board's tile answers "is the fleet armed"; this
 * answers "who said so, and why", and only this one carries the note. Both read
 * useIntake(), so the state word, the chip's label and the command it sends come
 * off one derivation. It sat fifth, under a ten-row table and above a findings
 * panel - the page's one action, buried in a stack of records.
 */
import { computed, watch } from "vue";

import Band from "@/components/Band.vue";
import PanelBox from "@/components/PanelBox.vue";
import StatusDot from "@/components/StatusDot.vue";
import StatePill from "@/components/StatePill.vue";
import ChipButton from "@/components/ChipButton.vue";
import MetricChart from "@/components/MetricChart.vue";
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
import { latest, peak, toPoints, type ChartSeries } from "@/charts";
import { heartbeatTone } from "@/health";
import { leadReading, preconditionRows, preconditionTally, type PreconditionRow } from "@/machine";
import type { InstantSeries, Tone } from "@/types";
import * as fmt from "@/format";

const { window: win } = useTimeWindow();
const tip = useTooltip();
const host = useHostStore();
const fleet = useFleetStore();
const metricsStale = useMetricsStale();

const CONDUCT_STALE_S = 600; // agents.conduct_fresh
const INTAKE_STALE_S = 3600; // agents.intake

/* THE PLOT'S HEIGHT, AND THE NAME AND READING BESIDE IT ARE CENTRED ON IT.
   Bound into the grid as a custom property rather than repeated as a literal in
   the stylesheet: the tokens lane carries an x-axis and the runs lane does not,
   so a block centred on the whole CELL would sit 13px lower on one than the
   other. This repository has already paid for a constant in one file that only
   means anything because of a constant in another. */
const LANE_H = 50;

// --- the numbers -------------------------------------------------------------

const metrics = usePoll(async (signal) => {
  const one = (r: InstantSeries[]) => value(r[0]?.value);
  const [
    heartbeat, phaseInFlight, intakeLast, tokensToday, tokensWeek, runsToday, runsFailedToday,
    approvals, leaked, windmillDb, workerLanes, mirrorAge, checkoutDirty,
    publishConfigured, sliceMem, sliceOom, sliceMemMax,
  ] = await Promise.all([
    instant(AGENTS.heartbeat, signal),
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
    instant(AGENTS.sliceMemory, signal),
    instant(AGENTS.sliceOom, signal),
    instant(AGENTS.sliceMemoryMax, signal),
  ]);

  return {
    heartbeat: one(heartbeat),
    // ABSENT IS undefined, NOT NaN: a phase that has never run must render grey
    // rather than as one that is not running. leadReading reads this branch and
    // nothing else on this page could tell the two apart.
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
    sliceMem: one(sliceMem),
    sliceOom: one(sliceOom),
    sliceMemMax: one(sliceMemMax),
  };
}, 30_000);

const m = computed(() => metrics.data.value);

// --- the charts --------------------------------------------------------------
// FOUR RANGES, ALL ON ONE WINDOW. They were three on two: the memory chart took
// the picker's and the two strips took a hardcoded fourteen days, which is what
// made the picker a control over half a band.
//
// ONE `options` FOR ALL FOUR IS LOAD-BEARING, not tidiness. useCrosshair holds a
// TIME, and every plot resolves it against its own from/to - so a lane fetched
// on a different window would draw its cursor at a different instant while
// looking exactly as correct.

const charts = usePoll(async (signal) => {
  const options = { window: win.value.seconds, step: win.value.step, signal };

  const [sliceMem, runs, runsFailed, tokens] = await Promise.all([
    range(AGENTS.sliceMemory, options),
    range(AGENTS.runsToday, options),
    range(AGENTS.runsFailedToday, options),
    range(AGENTS.tokensToday, options),
  ]);

  const points = (rows: typeof runs) => (rows[0] ? toPoints(rows[0].values) : []);

  return {
    sliceMem: points(sliceMem),
    runs: points(runs),
    runsFailed: points(runsFailed),
    tokens: points(tokens),
  };
}, 60_000);

watch(win, () => {
  void charts.refresh();
});

const c = computed(() => charts.data.value);
const from = computed(() => host.now - win.value.seconds);

// --- the two lanes -----------------------------------------------------------

interface Lane {
  key: string;
  label: string;
  sub: string;
  format: (v: number) => string;
  /** ONE AXIS PER CARD, under the last lane. Rendering it from MetricChart
   *  rather than by hand is what makes it the same axis as the memory chart
   *  beside it, phone rung included - that component already hides alternate
   *  ticks below 640, and a hand-rolled row would need its own copy. */
  axis: boolean;
  /** The one the reading and the peak are taken from. */
  series: ChartSeries[];
}

const lanes = computed<Lane[]>(() => {
  const d = c.value;
  return [
    {
      key: "runs",
      label: "runs",
      sub: "resets at UTC",
      format: (v: number) => fmt.number(v),
      axis: false,
      series: [
        { points: d?.runs ?? [], label: "runs", tone: "ok" },
        // OPACITY 1, AGAINST THE BRIGHTNESS RAMP. A second series is drawn at
        // 0.7 by default, which separates two readings of the same thing and is
        // wrong for this one: dimming the failures says they matter less than
        // the runs they are a subset of. This is the first time the page can
        // say WHEN a run failed rather than that one did.
        { points: d?.runsFailed ?? [], label: "failed", tone: "fail", opacity: 1 },
      ],
    },
    {
      key: "tokens",
      label: "tokens",
      sub: "its own tally",
      format: fmt.compact,
      axis: true,
      series: [{ points: d?.tokens ?? [], label: "tokens", tone: "ok" }],
    },
  ];
});

/** The window's last reading and its high-water mark, off the PRIMARY series.
 *  Both are NaN on an empty range and both render through format(), so absence
 *  is a dash - never a zero, which on a counter is a claim. */
const laneReading = (l: Lane) => l.format(latest(l.series[0].points));
const lanePeak = (l: Lane) => l.format(peak(l.series[0].points));

/** The band's aside. DERIVED FROM THE PICKER, which is the only place the span
 *  can be stated without being able to drift - the band was labelled
 *  `Fourteen days` and named a timeframe the picker was supposed to own. */
const windowLabel = computed(() => `last ${win.value.label}`);

// --- the lead ----------------------------------------------------------------

/**
 * THE PROVENANCE OF EVERY READING BELOW IT, rather than a fifth fact among
 * them. These metrics are the collector's reading of conduct's own marker, so
 * if conduct has stopped writing it nothing in this panel is a current claim.
 * It keeps its own tone: stale is amber, never-run is grey.
 */
const conduct = computed(() => {
  const beat = m.value?.heartbeat;
  const age = beat === undefined || !Number.isFinite(beat) ? Number.NaN : host.now - beat;
  return { age, ...heartbeatTone(age, CONDUCT_STALE_S) };
});

const lead = computed(() => leadReading(m.value));

/**
 * ONE BOOLEAN FOR THE CONDITION AND THE CHART, so the two cannot disagree about
 * whether this slice has been OOM-killed. They were two copies of the same
 * ternary in the first draft, which is how a page ends up drawing one fact two
 * ways - the defect the findings strip and the findings panel already cost.
 */
const oomKilled = computed(() => (m.value?.sliceOom ?? 0) > 0);
const memoryTone = computed<"ok" | "fail">(() => (oomKilled.value ? "fail" : "ok"));

const memory = computed(() => {
  const oom = m.value?.sliceOom ?? Number.NaN;
  return {
    value: `${fmt.bytes(m.value?.sliceMem ?? Number.NaN)} / ${fmt.bytes(m.value?.sliceMemMax ?? Number.NaN)}`,
    // ABSENT IS NOT ZERO, and this is the line that has to say so - the tone
    // above cannot, because MetricChart has only three.
    sub: !Number.isFinite(oom)
      ? "OOM kills not measured"
      : oom > 0
        ? `${fmt.number(oom)} OOM kills`
        : "no OOM kills",
  };
});

// --- intake ------------------------------------------------------------------

const midPhase = computed(() => m.value?.phaseInFlight === 1);
const intake = useIntake(midPhase);

const intakeAge = computed(() => {
  const at = m.value?.intakeLast;
  return at === undefined || !Number.isFinite(at) ? Number.NaN : host.now - at;
});

// --- the preconditions -------------------------------------------------------

const rows = computed(() => preconditionRows(m.value, host.byId));
const tally = computed(() => preconditionTally(rows.value));

const rail = (tone: Tone) => `var(--${tone})`;

/**
 * The caveats, keyed by the same id the row is. A caveat is one sentence saying
 * "this number is not what it looks like", and Tooltip has a slot styled amber
 * for exactly that - which is why the unit caveat below is not in a sub-line.
 *
 * SENTENCE CASE, AND THAT IS A RULE RATHER THAN A PREFERENCE. Full caps is the
 * voice of the comments in this repository, where it is an author arguing with
 * the next one; on screen it is shouting at a reader who asked a question. Only
 * acronyms and identifiers keep it - UTC, SQL, PAT, UI, FETCH_HEAD, WORKER_TAGS.
 * The argument each sentence makes is unchanged; only the register is.
 */
const CAVEATS: Record<string, string> = {
  "agents.approvals_pending":
    "An upper bound. This counts conduct's own suspended steps as well as a person's, and the SQL behind it cannot separate them - both are suspend > 0. The round board is what actually distinguishes them.",
  "agents.worker_lanes":
    "Read back out of Postgres, not from the quadlet. A worker's tags hot-reload from a row the UI can edit, so WORKER_TAGS= is a bootstrap that leaves no trace in git when it is overridden.",
  "agents.mirror_fresh":
    "FETCH_HEAD's mtime dates the attempt, not the change - which is the only reason a mirror that stopped fetching can be told from one nobody pushed to.",
  "agents.checkout_drift":
    "This is /var/agents, not this checkout. It is conduct's own code, deployed the same way and drifting for the same reason; nothing else on this host looks at it.",
  "agents.publish_configured":
    "Proves a key file and a workspace row exist, not that the token is unexpired - a fine-grained PAT expires, and the check is named for what it can prove. The live proof is the push itself.",
  "agents.runners_leaked":
    "This watches two fleets. conduct-* and ci-* both carry io.home-server.ephemeral, so a CI lane running long shows up here too.",
};

function rowTip(r: PreconditionRow) {
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

// --- the rest of the tooltips ------------------------------------------------

const leadTip = computed(() => ({
  title: "phase runs today",
  lines: [
    `${fmt.number(m.value?.runsToday ?? Number.NaN)} run(s), ${fmt.number(m.value?.runsFailedToday ?? Number.NaN)} failed`,
    "a gauge conduct resets at UTC midnight",
  ],
  caveat:
    "A different unit from the board. A round is one task through five phases, so six runs could be one round or three - the board counts rounds and this counts phase executions.",
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

// THE EXACT FIGURES LIVE HERE, because the condition above them is rendered
// through fmt.compact now: "289M" is what a person reads and 289,113,220 is what
// they would quote. A tooltip is where the second one belongs.
const tokensTip = computed(() => ({
  title: "tokens",
  lines: [
    `${fmt.number(m.value?.tokensToday ?? Number.NaN)} today`,
    `${fmt.number(m.value?.tokensWeek ?? Number.NaN)} over seven days`,
  ],
  caveat:
    "conduct's own tally of its runs, not the account window - that is the quota status on the board, which is a status and deliberately not a number.",
}));

const memoryTip = computed(() => ({
  title: "slice memory",
  lines: [
    `${fmt.bytes(m.value?.sliceMem ?? Number.NaN)} of app-agents.slice`,
    `MemoryMax ${fmt.bytes(m.value?.sliceMemMax ?? Number.NaN)}`,
  ],
  caveat:
    "A ceiling is not usage. The frame is what the slice may take: it reserves 4,608M against a 30-day median nearer 957 MB, with a phase in flight about 7% of the time.",
}));

const lanesTip = computed(() => ({
  title: `runs and tokens, ${windowLabel.value}`,
  lines: [
    "the counters themselves, on the window the picker names",
    "hover any plot: the cursor marks the same instant on all three",
  ],
  caveat:
    "A running total for the UTC day, not activity in the window. The line climbs through the day and drops to zero at midnight, so a fall to nothing is the reset - and at 7d each tooth's peak is that day's total.",
}));
</script>

<template>
  <Teleport defer to="#toolbar">
    <WindowPicker />
  </Teleport>

  <!-- THE HEADLINE LEADS, AND IT DID NOT USED TO. This was three equal panels
       in a `:cols="3"` band - phase runs, tokens and cost, slice memory - each
       given a third of 1360 with no primary among them, which is the shape the
       round board's header was rebuilt out of one tab over. Every fact is still
       here; what changed is that they stopped being peers.

       ONE PANEL WITH INTERNAL HIERARCHY IS NOT A BENTO. The band rule governs
       panels within a band, and this is a single full-width panel. -->
  <Band label="Today">
    <template #aside>
      <span class="beat">
        <StatusDot :tone="conduct.tone" :size="6" />
        <span class="mono">conduct
          {{ Number.isFinite(conduct.age) ? `${fmt.coarse(conduct.age)} ago` : "never run" }}
        </span>
      </span>
    </template>

    <PanelBox :stale="metricsStale">
      <div class="lead" v-bind="tip.hover('ag-lead', leadTip)">
        <StatusDot :tone="lead.tone" :live="lead.live" :size="9" />
        <span class="reading mono">{{ lead.text }}</span>
      </div>

      <!-- NO PROGRESS BAR. There is no denominator for "runs today", and a bare
           track is the encoding this store reserves for "in progress, ratio
           unknown" - the exact defect `idle` cost the board. -->
      <p class="lead-sub mono">{{ lead.sub }}</p>

      <!-- The conditions: what that reading costs and what contains it. Three
           equal columns at and above 900, packed left below it, and a
           label-left readout below 640. -->
      <div class="conds">
        <div class="cond" v-bind="tip.hover('ag-cost', costTip)">
          <span class="label">cost</span>
          <span class="mono cvalue">
            {{ fmt.number(fleet.totals?.cost_today ?? Number.NaN, 2) }} USD today
          </span>
          <span class="mono sub">
            {{ fmt.number(fleet.totals?.cost_week ?? Number.NaN, 2) }} USD over seven days
          </span>
        </div>

        <!-- COMPACT, NOT THE DIGITS. This printed 289113220 for a week, which
             is nine characters nobody reads and the widest thing in the row.
             The exact figures are one hover away, in tokensTip. -->
        <div class="cond" v-bind="tip.hover('ag-tokens', tokensTip)">
          <span class="label">tokens</span>
          <span class="mono cvalue">{{ fmt.compact(m?.tokensToday ?? Number.NaN) }} today</span>
          <span class="mono sub">{{ fmt.compact(m?.tokensWeek ?? Number.NaN) }} this week</span>
        </div>

        <div class="cond" v-bind="tip.hover('ag-memory', memoryTip)">
          <span class="label">memory</span>
          <span class="mono cvalue">{{ memory.value }}</span>
          <span class="mono sub" :class="{ bad: oomKilled }">{{ memory.sub }}</span>
        </div>
      </div>
    </PanelBox>
  </Band>

  <!-- SECOND ON THE PAGE SINCE 2026-09-07, and it was fifth. This is the one
       thing on this view a person can act on, and it sat under a ten-row table
       of preconditions and above a findings panel - buried in a stack of
       records. The order is now the reading, the control that decides whether
       there will be another one, the history, then the evidence.

       THE AGE IS THE BAND'S ASIDE, not a fact in the panel. An intake that has
       stopped looks exactly like an empty backlog, so the age is what qualifies
       every sentence below it - the same argument the conduct heartbeat makes at
       the top of this page. -->
  <Band label="Intake">
    <template #aside>
      <span class="mono" :class="{ warnish: intakeAge > INTAKE_STALE_S }">
        last looked {{ Number.isFinite(intakeAge) ? `${fmt.coarse(intakeAge)} ago` : "never" }}
      </span>
    </template>

    <PanelBox :stale="fleet.stale">
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
        <!-- THE SAME PILL THE BOARD DRAWS, off the same derivation. It was a
             bare span with two colour classes of its own, so one value had two
             renderings a tab apart. -->
        <StatePill
          class="spill"
          :label="intake.state.value.state"
          :tone="intake.state.value.tone"
          size="sm"
        />
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
        <span class="sact">
          <ChipButton
            :label="intake.state.value.label"
            :disabled="intake.disabled.value"
            :act="() => intake.toggle()"
            :title="intake.state.value.title"
            :pending="intake.askedFor.value !== null"
          />
        </span>
      </div>

      <p class="note">
        An intake that has stopped looks exactly like an empty backlog. Both leave every unit
        active and every container healthy, and only the age of that last look tells them apart -
        never the sentence.
      </p>
    </PanelBox>
  </Band>

  <!-- THE BAND NAMES THE AXIS AND NOT THE SPAN, so the picker cannot make its
       label false; it was `Fourteen days` while half of it ignored the picker
       entirely. The span goes in the aside, derived from the picker itself,
       which is the one place it can be stated without being able to drift.

       AND IT STRETCHES. Two cards of the same shape ending on different lines
       read as one of them having failed to finish drawing - see Band.vue for
       why that is a prop and not the default. It is closing about 25px here;
       the content is sized to match, and a stretch absorbing more than that
       would mean the band was wrong rather than the alignment. -->
  <Band label="Over time" :cols="2" stretch>
    <template #aside>
      <span class="mono">{{ windowLabel }}</span>
    </template>

    <!-- TWO LANES, NOT TWO STRIPS. ActivityBars says of itself that it is
         "deliberately not a chart: it has no axis and no scale, and it is not
         meant to be read as a number" - right for sixteen rows of a pod rack,
         wrong for the only history panel on this page, where there was nothing
         to hover and nothing to read.

         THE LANE IS /system/load's, unchanged: a name, a plot, and a reading with
         the window's peak. What it buys beyond the readout is that all three
         plots on this band are now on one axis, so the cursor is shared - a
         memory spike can be read against the run that caused it. -->
    <!-- THE ASIDE NAMES THE SOURCE, the way `app-agents.slice` does on the card
         beside it - and it is also what puts the two labels on one baseline.
         Without it PanelBox's head has no --t-mono-sm child, so its line box is
         3px shorter and two titles side by side sat 3px apart. -->
    <PanelBox label="Runs and tokens" :stale="metricsStale">
      <template #aside><span class="mono">conduct's marker</span></template>
      <div
        class="lanes"
        :style="{ '--lane-h': `${LANE_H}px` }"
        v-bind="tip.hover('ag-lanes', lanesTip)"
      >
        <div v-for="l in lanes" :key="l.key" class="lane">
          <div class="lname">
            <div class="ltitle">{{ l.label }}</div>
            <div class="lsub mono">{{ l.sub }}</div>
          </div>
          <!-- NO GRID AND NO Y AXIS. At 50px a gridline is noise, and the
               reading column plus the cursor carry every number the panel has.
               `x-axis` on the LAST lane only: one axis per card, drawn by the
               same component as the memory chart beside it so the two agree at
               every rung without a second implementation. -->
          <!-- WRAPPED, BECAUSE A CLASS ON A COMPONENT LANDS ON ITS ROOT, and
               MetricChart's root already carries `.frame` with rules of its own.
               The phone rung has to move the plot onto a row of its own, and
               doing that through the component's own class name is the
               specificity trap this page paid for on `.msg` a week ago. -->
          <div class="lplot">
            <MetricChart
              :series="l.series"
              :height="LANE_H"
              :from="from"
              :to="host.now"
              :format="l.format"
              :x-axis="l.axis"
              :x-ticks="4"
            />
          </div>
          <div class="lread">
            <div class="mono lnow">{{ laneReading(l) }}</div>
            <div class="mono lpeak">peak {{ lanePeak(l) }}</div>
          </div>
        </div>
      </div>
      <p class="note">
        Both counters are gauges conduct resets at UTC midnight, so a line climbing through the day
        and dropping to nothing is the reset rather than a fault. The tokens are conduct's own tally
        of its runs and not the account window - that is the quota status on the board, which is a
        status and deliberately not a number. The runs lane draws failures as a second line in red,
        and the cursor names both.
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
        :tone="memoryTone"
      />
      <p class="note">
        A ceiling is not usage. The frame is what the slice may take: this one reserves 4,608M
        against a 30-day median nearer 957 MB, with a phase in flight about 7% of the time.
      </p>
    </PanelBox>
  </Band>

  <!-- SIX TILES AND A CONTAINMENT TABLE BECAME ONE TABLE. The tiles were a grid
       of cards, which the design system names as the thing a list of records
       must never be; the Containment panel reproduced FindingsPanel's markup
       directly above a FindingsPanel that already carried those same three
       checks, and its own note admitted it.

       IT IS NOT SORTED WORST-FIRST, and that is what keeps it a different object
       from the findings below. See src/machine.ts.

       AND IT HAS A BAND TO ITSELF, WHICH IS THE BAND RULE RATHER THAN A
       PREFERENCE. Beside Intake in a two-column band it was the taller panel by
       about 450px - a dense ten-row table clamped to two lines a cell in half the
       page, with the other half empty below a short one. Band.vue states the
       remedy: if a panel needs more width than its siblings, give it its own
       band. Every finding fits one line at 1360 now. -->
  <Band label="Control plane">
    <template #aside>
      <span class="count">{{ tally.total }}</span> facts,
      <span class="count">{{ tally.notPassing }}</span> not passing
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
              <!-- COLUMN PRIORITY, AND IT DROPS THE FINDING RATHER THAN THE ID.
                   The mirror image of FindingsPanel one panel down, and correct
                   for the same reason: that panel's job is the prose, this
                   one's is the values. Both fold into the cell that survives. -->
              <span class="fold2 mono val">{{ r.value }}</span>
              <span class="fold2 ffind">{{ r.finding }}</span>
            </td>
            <td class="mono val p2">{{ r.value }}</td>
            <!-- THE CLAMP IS ON AN INNER DIV, NEVER ON THE CELL. `display:
                 -webkit-box` on a <td> replaces `display: table-cell`, so the
                 browser lifts the cell out of the row and wraps it in an
                 anonymous one - the column stops lining up and the clamp does
                 not hold. FindingsPanel nests it for the same reason. -->
            <td class="p2"><div class="msg">{{ r.finding }}</div></td>
          </tr>
        </tbody>
      </table>
      <p class="note">
        The reading, keyed by check id; the finding beside it is that check's own sentence. The
        battery's full verdict on all of them is the panel below - this is the same ids with
        their numbers, which the metric carries and the message deliberately does not.
      </p>
    </PanelBox>

  </Band>

  <FindingsPanel label="Agent checks" section="agents" all />
</template>

<style scoped>
/* --- the header ---------------------------------------------------------- */

/* The heartbeat, in the band's own head row. Quiet on purpose: it is only
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

/* THREE EQUAL COLUMNS, the round board's recipe unchanged - see its own comment
   for why equal thirds rather than packed left once a headline leads. Below 900
   it packs; below 640 the block at the foot of this file takes over. */
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

.warnish {
  color: var(--warn);
}

.bad {
  color: var(--fail-text);
}

/* --- the lanes ------------------------------------------------------------ */

/* TWO INDEPENDENT GRIDS WITH IDENTICAL TRACKS, not one grid of six cells. Both
   resolve `minmax(0, 1fr)` against the same container width, so the plots align
   exactly - and a lane stays one element, which is what lets `.lane + .lane`
   carry the rule between them and the phone rung reshape one at a time. */
/* 110/76, AND BOTH NUMBERS WERE MEASURED IN THE BROWSER RATHER THAN CHOSEN.
   The first draft's subs were "resets at UTC midnight" and "conduct's own
   tally" - 154px of text at --t-mono-xs, which wrapped to two lines and broke
   both phrases mid-clause. THE FIX WAS THE TEXT, NOT THE TRACK: the note under
   the card already says both facts in full, so the sub is the short form of
   something stated below rather than the only place it appears, and the plot
   keeps 396px instead of paying 50px for a caption.

   76 on the reading, where "peak 2.1M" is the widest string at 63px. The whole
   row folds to two lines at 640 anyway - see the phone rung. */
.lane {
  display: grid;
  grid-template-columns: 110px minmax(0, 1fr) 76px;
  align-items: start;
  column-gap: var(--gap);
  padding: 7px 0;
}

.lane + .lane {
  border-top: 1px solid var(--line-faint);
}

/* CENTRED ON THE PLOT, NEVER ON THE CELL. --lane-h is the chart's own height,
   handed down from the script; the tokens lane's cell is 26px taller because it
   carries the axis for both, and centring on that would drop its name and
   reading below the line its plot sits on. */
.lname,
.lread {
  display: flex;
  flex-direction: column;
  justify-content: center;
  gap: 3px;
  min-height: var(--lane-h);
  min-width: 0;
}

.ltitle {
  font: var(--t-ui-md);
  color: var(--fg-2);
}

.lsub {
  font: var(--t-mono-xs);
  color: var(--fg-5);
}

.lread {
  text-align: right;
}

.lnow {
  font: var(--t-mono-lg);
  color: var(--fg);
}

.lpeak {
  font: var(--t-mono-xs);
  color: var(--fg-5);
}

.lplot {
  min-width: 0;
}

/* --- the preconditions ---------------------------------------------------- */

.c-rail {
  width: 30px;
}

.c-name {
  width: 150px;
}

/* "not configured" is the widest reading here at --t-mono-md. */
.c-val {
  width: 112px;
}

.name {
  font: var(--t-ui-sm);
  color: var(--fg-3);
}

.val {
  font: var(--t-mono-md);
  color: var(--fg-2);
}

/* Two lines, which is FindingsPanel's clamp - the only other place here that
   has to fit a check's prose into a table cell. */
.msg {
  font: var(--t-ui-sm);
  color: var(--fg-2);
  display: -webkit-box;
  -webkit-line-clamp: 2;
  line-clamp: 2;
  -webkit-box-orient: vertical;
  overflow: hidden;
}

/* THE FOLDED FINDING IS NOT .msg, AND THAT IS THE WHOLE REASON IT HAS A CLASS
   OF ITS OWN. A scoped rule compiles to `.msg[data-v-x]` - class plus attribute
   - which outranks base.css's `.fold2 { display: none }`, so the folded copy
   rendered at every width and every row of this table carried its finding
   twice. The same specificity trap the round board pays for on a ChipLink, one
   layer in: there it is a component's own scoped class, here it is this file's.
   Nothing in .ffind sets `display`, so the fold governs it.

   AND IT IS NOT CLAMPED. At 640 this cell is the whole table and the finding is
   the only prose in it; two lines there would hide what the wide layout shows
   in full. The board widens its clamp at that rung for the same reason. */
.ffind {
  font: var(--t-ui-sm);
  color: var(--fg-2);
}

/* The folded pair, once their own columns have gone. Blocks, so they stack
   under the name rather than running into the end of it. */
.name .fold2 {
  margin-top: 4px;
}

/* --- intake --------------------------------------------------------------- */

/* A label, its state, where the answer came from, and the one control that
   moves it. */
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

/* --- shared --------------------------------------------------------------- */

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

/* --- the tablet ----------------------------------------------------------- */

/* THE SWITCH STOPS BEING A GRID HERE RATHER THAN AT 640. Its two `auto` tracks
   are sized by max-content, so between 900 and 640 the sentence between them was
   squeezed toward nothing with 540px of ladder to fall through before anything
   caught it. Dropping one track was the first fix and was worse: the chip wrapped
   to a row of its own at the left margin, orphaned from the control it belongs
   to. As a wrapping row the control line stays whole - name, state, action - and
   the provenance sentence takes the line under it.

   AND FLEX RATHER THAN A ONE-COLUMN GRID IS WHAT STOPS THE PILL STRETCHING.
   Grid items default to `justify-items: stretch`, so on a phone the pill and the
   chip drew as full-width boxes; the old code had the same rule and got away with
   it only because both were bare spans with no border to show it.

   The conditions pack left at the same rung, which is the board's own rule. */
@media (max-width: 900px) {
  .conds {
    display: flex;
    flex-wrap: wrap;
  }

  .switch {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 9px;
  }

  .sact {
    margin-left: auto;
  }

  /* THE SENTENCE TAKES ITS OWN LINE AND GOES LAST. In DOM order it sits between
     the state and the control, which is right for the four-track grid above and
     wrong here: `flex-basis: 100%` alone broke the line before the chip, so the
     control ended up two rows below the state it changes with a sentence
     wedged between them. Only the chip is focusable, so visual order and tab
     order still agree. */
  .switch .sub {
    order: 1;
    flex-basis: 100%;
  }
}

/* --- the phone ------------------------------------------------------------ */

@media (max-width: 640px) {
  .irow {
    grid-template-columns: minmax(0, 1fr);
    gap: 2px;
  }

  /* THE LANE BECOMES TWO ROWS RATHER THAN A SCROLLER. 110 + 90 of fixed width
     plus two gaps leaves a 390px phone about 130px of plot, which is a stub;
     /system/load's lanes carry 288px of chrome and pan inside .hscroll instead.
     Name and reading take one line, the plot takes the width under them, and
     nothing is lost or panned to. */
  .lane {
    grid-template-columns: minmax(0, 1fr) max-content;
    row-gap: 7px;
  }

  /* min-height goes with the columns: a block centred on the plot's height is
     right beside it and is 50px of air above it. */
  .lname,
  .lread {
    min-height: 0;
    grid-row: 1;
  }

  .lplot {
    grid-column: 1 / -1;
    grid-row: 2;
  }

  /* THE READING AND THE FINDING ARE IN THE NAME CELL NOW, so it is the whole
     table and the name stops being a 150px column. */
  .c-name {
    width: auto;
  }

  /* THE RAIL NEEDS ITS WIDTH BACK ON THE CELL ONCE THE HEADER IS GONE. Under
     `table-layout: fixed` the column widths are taken from the first row, and
     `display: none` on the thead means that is now the first BODY row - which
     carries no widths, so the two surviving columns split 50/50 and every
     finding wrapped inside half a phone. The th hints are still what govern
     above this rung. */
  .tbl td.rail {
    width: 30px;
  }

  /* A HEADER ROW OVER ONE COLUMN NAMES NOTHING. Two of the three are gone by
     here and the survivor no longer holds only the fact - the reading and the
     finding folded into it - so `FACT` is a label that has stopped being true as
     well as a row of height nothing reads. The round board drops its thead at
     this rung for the same reason. */
  .tbl thead {
    display: none;
  }
}

/* THE CONDITIONS, ON A PHONE. The label moves to the left of its value: three
   rows, one condition each, labels in a column of their own, which is what
   makes it scannable at the width where scanning is hardest. Packed-left
   wrapping is right down to about 660px and is where the row runs out below it.

   The 82px fallback is measured on the board, where WORKTREES is the longest
   label at --t-label; MEMORY is shorter, so all three still align on it where
   subgrid is unavailable. */
@media (max-width: 640px) {
  .conds {
    display: grid;
    grid-template-columns: max-content 1fr;
    column-gap: var(--gap);
    row-gap: 14px;
  }

  .cond {
    grid-template-columns: 82px 1fr;
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
