<script setup lang="ts">
/**
 * Agents: what the fleet is doing, and whether it is waiting on you.
 *
 * THE PROBLEM HERE IS THE OPPOSITE OF THE CI PAGE'S. There is no shortage of
 * measurement - 41 series and 19 checks - and not one of them can say WHICH task
 * is in flight, which round it is on, or that a pull request has been sitting on
 * a person's approval since last night. `runs_today = 3` is true and useless. A
 * task title and a Windmill job id are exactly the label family the collector
 * refuses to mint, and rightly.
 *
 * So this page has two halves that must not be confused. fleet.json carries the
 * prose - rounds, attempts, branches, what a run cost - rewritten whole every
 * five minutes with no history anywhere. Prometheus carries the numbers with a
 * time axis. Where the two overlap they are shown together and where they
 * disagree that IS the finding, which is why the worktree tile prints both
 * counts rather than picking one.
 *
 * TWO THINGS THIS PAGE MUST NEVER DO, both restated from src/api/fleet.ts
 * because this is where the temptation lives: it must never render a resume URL
 * (an HMAC in a path that needs no session, so publishing one makes a reader
 * able to approve an agent's merge), and it must never present cost as the thing
 * that paces the fleet. The quota status does that, and it is a status rather
 * than a number on purpose.
 */
import { computed, watch } from "vue";

import PanelBox from "@/components/PanelBox.vue";
import StatusDot from "@/components/StatusDot.vue";
import StatePill from "@/components/StatePill.vue";
import ChipLink from "@/components/ChipLink.vue";
import ProgressBar from "@/components/ProgressBar.vue";
import MetricChart from "@/components/MetricChart.vue";
import ActivityBars from "@/components/ActivityBars.vue";
import FindingsPanel from "@/components/FindingsPanel.vue";
import StaleNote from "@/components/StaleNote.vue";
import WindowPicker from "@/components/WindowPicker.vue";

import { usePoll } from "@/composables/usePoll";
import { useMetricsStale } from "@/composables/useStaleness";
import { useTimeWindow } from "@/composables/useTimeWindow";
import { useTooltip } from "@/composables/useTooltip";
import { useHostStore } from "@/stores/host";
import { useFleetStore } from "@/stores/fleet";
import { instant, range, value } from "@/api/prometheus";
import { AGENTS } from "@/queries";
import { heartbeatTone, quotaTone } from "@/health";
import { toPoints } from "@/charts";
import { dailyPeaks, utcDayStarts } from "@/uptime";
import type { FleetRound, InstantSeries, Tone } from "@/types";
import * as fmt from "@/format";

const { window: win } = useTimeWindow();
const tip = useTooltip();
const host = useHostStore();
const fleet = useFleetStore();
const metricsStale = useMetricsStale();

// The thresholds the battery grades on, so the page and the MOTD agree.
const CONDUCT_STALE_S = 600; // agents.conduct_fresh
const PHASE_MAX_S = 5400; // RuntimeMaxSec on the phase scope
const PHASE_STUCK_S = 10800; // agents.phase_stuck, and AgentPhaseStuck
const INTAKE_STALE_S = 3600; // agents.intake
const WINDMILL_DB_MAX = 2048 * 1024 * 1024; // agents.windmill_db_size
const STRIP_DAYS = 14;

// --- the numbers -------------------------------------------------------------

const metrics = usePoll(async (signal) => {
  const one = (r: InstantSeries[]) => value(r[0]?.value);
  const [
    markerPresent, heartbeat, lastOk, phaseInFlight, phaseStarted, quotaStatus,
    quotaResets, quotaRead, intakeLast, tokensToday, tokensWeek, runsToday,
    runsFailedToday, worktreesLeased, worktreesOnDisk, approvals, leaked,
    windmillDb, workerLanes, mirrorAge, checkoutDirty, publishConfigured,
    sliceOom, sliceMemMax,
  ] = await Promise.all([
    instant(AGENTS.markerPresent, signal),
    instant(AGENTS.heartbeat, signal),
    instant(AGENTS.lastOk, signal),
    instant(AGENTS.phaseInFlight, signal),
    instant(AGENTS.phaseStarted, signal),
    instant(AGENTS.quotaStatus, signal),
    instant(AGENTS.quotaResets, signal),
    instant(AGENTS.quotaRead, signal),
    instant(AGENTS.intakeLast, signal),
    instant(AGENTS.tokensToday, signal),
    instant(AGENTS.tokensWeek, signal),
    instant(AGENTS.runsToday, signal),
    instant(AGENTS.runsFailedToday, signal),
    instant(AGENTS.worktreesLeased, signal),
    instant(AGENTS.worktreesOnDisk, signal),
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

  // ABSENT IS undefined, NOT NaN, for the three where absence is a distinct
  // finding rather than a missing reading: a phase that has never run and a
  // quota nobody has read must both render grey.
  const first = (r: InstantSeries[]) => (r.length ? value(r[0].value) : undefined);

  return {
    markerPresent: one(markerPresent),
    heartbeat: one(heartbeat),
    lastOk: one(lastOk),
    phaseInFlight: first(phaseInFlight),
    phaseStarted: one(phaseStarted),
    quotaStatus: first(quotaStatus),
    quotaResets: one(quotaResets),
    quotaRead: one(quotaRead),
    intakeLast: one(intakeLast),
    tokensToday: one(tokensToday),
    tokensWeek: one(tokensWeek),
    runsToday: one(runsToday),
    runsFailedToday: one(runsFailedToday),
    worktreesLeased: first(worktreesLeased),
    worktreesOnDisk: first(worktreesOnDisk),
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

const conduct = computed(() => {
  const beat = m.value?.heartbeat;
  const age = beat === undefined || !Number.isFinite(beat) ? Number.NaN : host.now - beat;
  return { age, ...heartbeatTone(age, CONDUCT_STALE_S) };
});

const phase = computed(() => {
  const running = m.value?.phaseInFlight;
  const started = m.value?.phaseStarted;
  const age = started === undefined || !Number.isFinite(started) ? Number.NaN : host.now - started;
  if (running === undefined) return { tone: "off" as Tone, state: "never run", age: Number.NaN };
  if (running !== 1) return { tone: "ok" as Tone, state: "idle", age: Number.NaN };
  return { tone: age > PHASE_STUCK_S ? ("warn" as Tone) : ("ok" as Tone), state: "in flight", age };
});

const quota = computed(() => {
  const q = quotaTone(m.value?.quotaStatus);
  const resets = m.value?.quotaResets;
  const clears =
    resets !== undefined && Number.isFinite(resets) && resets > host.now
      ? `clears in ${fmt.coarse(resets - host.now)}`
      : null;
  return { ...q, clears };
});

// --- charts and strips -------------------------------------------------------

const charts = usePoll(async (signal) => {
  const options = { window: win.value.seconds, step: win.value.step, signal };
  const dayOptions = { window: STRIP_DAYS * 86400, step: 3600, signal };

  const [sliceMem, slicePids, runsHourly, failedHourly, tokensHourly] = await Promise.all([
    range(AGENTS.sliceMemory, options),
    range(AGENTS.slicePids, options),
    range(AGENTS.runsHourly, dayOptions),
    range(AGENTS.runsFailedHourly, dayOptions),
    range(AGENTS.tokensHourly, dayOptions),
  ]);

  const peaks = (rows: typeof runsHourly) =>
    rows[0] ? dailyPeaks(toPoints(rows[0].values), STRIP_DAYS, host.now) : [];

  return {
    sliceMem: sliceMem[0] ? toPoints(sliceMem[0].values) : [],
    slicePids: slicePids[0] ? toPoints(slicePids[0].values) : [],
    runs: peaks(runsHourly),
    failed: peaks(failedHourly),
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

// --- the document ------------------------------------------------------------

const rounds = computed(() => fleet.rounds);
const totals = computed(() => fleet.totals);

/** Waiting on a person first, then oldest. The board's whole job is to put the
 *  card somebody has to act on at the top. */
const board = computed(() => {
  const rank = (r: FleetRound) => (r.waiting_on === "person" ? 0 : r.waiting_on === null ? 1 : 2);
  return [...rounds.value].sort(
    (a, b) => rank(a) - rank(b) || a.opened_at.localeCompare(b.opened_at),
  );
});

function roundTone(r: FleetRound): Tone {
  if (r.waiting_on === "person") return "warn";
  // NULL IS NOT "conduct". chain.flow_job_id names the job that stopped, so a
  // round mid-flight matches no notice - and grey says "in flight, nobody has
  // been asked" rather than claiming the fleet owns a step.
  if (r.waiting_on === null) return "off";
  return "ok";
}

function roundState(r: FleetRound): string {
  if (r.waiting_on === "person") return "waiting on you";
  if (r.waiting_on === null) return "in flight";
  return "with conduct";
}

const CONTAINMENT = ["agents.slice_limits", "agents.runner_isolation", "agents.fleet_root_label"];

const containment = computed(() =>
  CONTAINMENT.map((id) => ({ id, check: host.byId.get(id) ?? null })),
);

const intakeAge = computed(() => {
  const at = m.value?.intakeLast;
  return at === undefined || !Number.isFinite(at) ? Number.NaN : host.now - at;
});

// --- tooltips ----------------------------------------------------------------

const worktreeTip = computed(() => ({
  title: "worktrees",
  lines: [
    `${fmt.number(m.value?.worktreesLeased ?? Number.NaN)} leased in conduct's database`,
    `${fmt.number(m.value?.worktreesOnDisk ?? Number.NaN)} directories on disk`,
  ],
  caveat:
    "Both, because they are different measurements and their disagreement is the finding: agents.worktree_orphans grades exactly that gap. Showing one number would hide it.",
}));

const quotaTip = computed(() => ({
  title: "quota",
  lines: [
    quota.value.state,
    quota.value.clears ?? "no reset time recorded",
    m.value?.quotaRead ? `read ${fmt.since(m.value.quotaRead)}` : "never read",
  ],
  caveat:
    "A status, not a percentage - the account-wide numbers answer 403 to the only credential a headless host can hold. conduct holds the fleet at the warning, so a rejection means something else spent the window, and stopping the fleet does not give it back.",
}));

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
    "An UPPER BOUND. This counts conduct's own suspended steps as well as a person's, and the SQL behind it cannot separate them - both are suspend > 0. The round board above is what actually distinguishes them.",
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
    `${fmt.number(totals.value?.cost_today ?? Number.NaN, 2)} USD today`,
    `${fmt.number(totals.value?.cost_week ?? Number.NaN, 2)} USD over seven days`,
  ],
  caveat:
    "Reported, never retained: this comes from fleet.json, which keeps no history. Cost is not what paces the fleet - the quota status is, and there is deliberately no dollar ceiling anywhere.",
}));
</script>

<template>
  <div class="page">
    <Teleport defer to="#toolbar">
      <span class="mono note">read only</span>
      <WindowPicker />
    </Teleport>

    <!-- Fleet header -------------------------------------------------------->
    <PanelBox :stale="metricsStale">
      <div class="tiles">
        <div class="tile">
          <span class="mono tlabel">conduct</span>
          <span class="tvalue">
            <StatusDot :tone="conduct.tone" :size="6" />
            <span class="mono">{{
              Number.isFinite(conduct.age) ? `${fmt.coarse(conduct.age)} ago` : "never run"
            }}</span>
          </span>
        </div>

        <div class="tile">
          <span class="mono tlabel">phase</span>
          <span class="tvalue">
            <StatusDot :tone="phase.tone" :live="phase.state === 'in flight'" :size="6" />
            <span class="mono">{{ phase.state }}</span>
          </span>
          <ProgressBar
            :ratio="Number.isFinite(phase.age) ? phase.age / PHASE_MAX_S : null"
            :tone="phase.tone === 'off' ? 'off' : phase.tone"
            :live="phase.state === 'in flight'"
          />
          <span class="mono sub">{{
            Number.isFinite(phase.age) ? fmt.duration(phase.age) : fmt.NO_DATA
          }}</span>
        </div>

        <div class="tile" v-bind="tip.hover('ag-quota', quotaTip)">
          <span class="mono tlabel">quota</span>
          <span class="tvalue">
            <StatePill :label="quota.state" :tone="quota.tone" size="sm" />
          </span>
          <span class="mono sub">{{ quota.clears ?? "no window recorded" }}</span>
        </div>

        <div class="tile" v-bind="tip.hover('ag-worktrees', worktreeTip)">
          <span class="mono tlabel">worktrees</span>
          <span class="mono tvalue">
            {{ fmt.number(m?.worktreesLeased ?? Number.NaN) }} leased /
            {{ fmt.number(m?.worktreesOnDisk ?? Number.NaN) }} on disk
          </span>
          <span class="mono sub">leases in the database, directories on disk</span>
        </div>
      </div>
    </PanelBox>

    <!-- The round board ----------------------------------------------------->
    <PanelBox label="Rounds" :stale="fleet.stale">
      <template #aside>
        <span class="mono">
          {{ rounds.length }} open / {{ fleet.waitingOnPerson.length }} waiting on you
        </span>
      </template>

      <!-- A LOCKED DATABASE IS NOT AN IDLE FLEET, and the empty list looks the
           same either way. This is what `sources` is for. -->
      <p v-if="fleet.dbUnreadable" class="empty mono bad">
        conduct's database could not be read in the last run. These rows are absent, not zero.
      </p>

      <ul v-else-if="board.length" class="board">
        <li v-for="r in board" :key="r.worktree_id" class="round" :class="roundTone(r)">
          <StatusDot :tone="roundTone(r)" :live="r.waiting_on === 'person'" :size="7" />
          <div class="rbody">
            <p class="rtitle">
              <span class="mono task">{{ r.odoo_task ? `#${r.odoo_task}` : r.worktree_id }}</span>
              <span class="rsummary">{{ r.summary ?? r.ref ?? "no branch recorded" }}</span>
            </p>
            <p class="rmeta mono">
              {{ r.project }} / {{ r.phase ?? "no phase" }} / attempt {{ r.attempts }} of
              {{ r.max_attempts }} / opened {{ fmt.sinceIso(r.opened_at) }}
            </p>
          </div>
          <StatePill :label="roundState(r)" :tone="roundTone(r)" size="sm" />
          <!-- conduct's own link to the approval page, behind sign-on. NEVER a
               resume URL - see src/api/fleet.ts. -->
          <ChipLink v-if="r.link" label="approve" :href="r.link" title="Windmill approval page" />
          <span v-else class="mono nolink">-</span>
        </li>
      </ul>

      <p v-else class="empty mono">
        No rounds open. That is the fleet idle, which is its ordinary resting state.
      </p>

      <!-- A notice with no matching round is still an unanswered approval, and
           it must not be dropped just because chain.flow_job_id names the job
           that stopped rather than the one running. -->
      <div v-if="fleet.orphanNotices.length" class="orphans">
        <p class="mono olabel">Unanswered, with no open round</p>
        <p v-for="n in fleet.orphanNotices" :key="n.module_id + n.flow_job_id" class="mono orow">
          {{ n.summary ?? n.kind }} - asked {{ fmt.sinceIso(n.first_at) }}, {{ n.sends }} sends
        </p>
      </div>

      <div v-if="fleet.publications.length" class="orphans">
        <p class="mono olabel">Pushed, pull request not open yet</p>
        <p v-for="p in fleet.publications" :key="p.job_id" class="mono orow">
          {{ p.branch ?? p.worktree_id }} - {{ fmt.sinceIso(p.opened_at) }}
        </p>
      </div>

      <StaleNote v-for="note in fleet.sourceNotes" :key="note" :reason="note" />
    </PanelBox>

    <!-- Runs, tokens, cost --------------------------------------------------->
    <section class="grid-2">
      <PanelBox label="Runs" :stale="metricsStale">
        <template #aside>
          <span class="mono">
            {{ fmt.number(m?.runsToday ?? Number.NaN) }} today,
            {{ fmt.number(m?.runsFailedToday ?? Number.NaN) }} failed
          </span>
        </template>
        <div v-bind="tip.hover('ag-runs', runsTip)">
          <ActivityBars :values="c?.runs ?? []" :height="34" stretch />
        </div>
        <p class="mono axis">
          <span>{{ fmt.dayMonth(stripDays[0]) }}</span>
          <span>{{ STRIP_DAYS }} UTC days</span>
          <span>{{ fmt.dayMonth(stripDays[stripDays.length - 1]) }}</span>
        </p>
        <p class="note mono">
          Bucketed on UTC, because these are gauges conduct resets at midnight and the host runs
          UTC. A grey bar is a day the store has no sample for, not a day nothing ran.
        </p>
      </PanelBox>

      <PanelBox label="Tokens and cost" :stale="metricsStale">
        <template #aside>
          <span class="mono" v-bind="tip.hover('ag-cost', costTip)">
            {{ fmt.number(totals?.cost_today ?? Number.NaN, 2) }} USD today
          </span>
        </template>
        <ActivityBars :values="c?.tokens ?? []" :height="34" stretch />
        <div class="pairs">
          <span class="mono">{{ fmt.number(m?.tokensToday ?? Number.NaN) }} tokens today</span>
          <span class="mono dim">{{ fmt.number(m?.tokensWeek ?? Number.NaN) }} this week</span>
          <span class="mono dim">{{ fmt.number(totals?.cost_week ?? Number.NaN, 2) }} USD week</span>
        </div>
        <p class="note mono">
          conduct's own tally of its runs, not the account window - that is the quota status above,
          which is a status and deliberately not a number. Cost comes from fleet.json and is kept
          nowhere.
        </p>
      </PanelBox>
    </section>

    <!-- Slice and containment ------------------------------------------------>
    <section class="grid-2">
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
        <p class="note mono">
          A ceiling is not usage. The frame is what the slice may take: this one reserves 4,608M
          against a 30-day median nearer 957 MB, with a phase in flight about 7% of the time.
        </p>
      </PanelBox>

      <PanelBox label="Containment" :stale="metricsStale">
        <ul class="checks">
          <li v-for="ch in containment" :key="ch.id" class="check">
            <StatusDot
              :tone="ch.check ? (ch.check.status === 'pass' ? 'ok' : 'warn') : 'off'"
              :size="6"
            />
            <span class="mono cid">{{ ch.id }}</span>
            <span class="msg">{{ ch.check?.message ?? "not measured in the last run" }}</span>
          </li>
          <li class="check" v-bind="tip.hover('ag-leaked', leakedTip)">
            <StatusDot :tone="(m?.leaked ?? 0) > 0 ? 'warn' : 'ok'" :size="6" />
            <span class="mono cid">runners leaked</span>
            <span class="msg">
              {{ fmt.number(m?.leaked ?? Number.NaN) }} past the ceiling, across both fleets
            </span>
          </li>
        </ul>
        <p class="note mono">
          The first three are what AgentContainmentLost pages on, matched by the same ids.
        </p>
      </PanelBox>
    </section>

    <!-- Control plane and intake --------------------------------------------->
    <section class="grid-2">
      <PanelBox label="Control plane" :stale="metricsStale">
        <div class="tiles">
          <div class="tile" v-bind="tip.hover('ag-approvals', approvalTip)">
            <span class="mono tlabel">suspended steps</span>
            <span class="mono tvalue">{{ fmt.number(m?.approvals ?? Number.NaN) }}</span>
            <span class="mono sub">{{ approvalsCheck?.message ?? "an upper bound, see the tooltip" }}</span>
          </div>
          <div class="tile" v-bind="tip.hover('ag-workers', workerTip)">
            <span class="mono tlabel">worker lanes</span>
            <span class="mono tvalue">{{ fmt.number(m?.workerLanes ?? Number.NaN) }}</span>
          </div>
          <div class="tile">
            <span class="mono tlabel">windmill db</span>
            <span
              class="mono tvalue"
              :class="{ warnish: (m?.windmillDb ?? 0) > WINDMILL_DB_MAX * 0.9 }"
            >
              {{ fmt.bytes(m?.windmillDb ?? Number.NaN) }}
            </span>
            <ProgressBar
              :ratio="Number.isFinite(m?.windmillDb ?? Number.NaN) ? (m!.windmillDb) / WINDMILL_DB_MAX : null"
              tone="ok"
            />
          </div>
          <div class="tile" v-bind="tip.hover('ag-mirror', mirrorTip)">
            <span class="mono tlabel">mirror fetch</span>
            <span class="mono tvalue">{{ fmt.coarse(m?.mirrorAge ?? Number.NaN) }} ago</span>
          </div>
          <div class="tile">
            <span class="mono tlabel">checkout</span>
            <span class="mono tvalue" :class="{ warnish: (m?.checkoutDirty ?? 0) > 0 }">
              {{ (m?.checkoutDirty ?? 0) > 0 ? `${fmt.number(m!.checkoutDirty)} dirty` : "clean" }}
            </span>
          </div>
          <div class="tile" v-bind="tip.hover('ag-publish', publishTip)">
            <span class="mono tlabel">publish key</span>
            <span class="mono tvalue">
              {{ (m?.publishConfigured ?? 0) === 1 ? "configured" : "not configured" }}
            </span>
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
        <p class="note mono">
          AN INTAKE THAT HAS STOPPED LOOKS EXACTLY LIKE AN EMPTY BACKLOG. Both leave every unit
          active and every container healthy, and only the AGE of that last look tells them apart -
          never the sentence.
        </p>
      </PanelBox>
    </section>

    <FindingsPanel label="Agent checks" section="agents" all />
  </div>
</template>

<style scoped>
.page {
  padding: 16px var(--pad-page) var(--pad-page);
  display: flex;
  flex-direction: column;
  gap: 10px;
}

.tiles {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(170px, 1fr));
  gap: 14px;
}

.tile {
  display: flex;
  flex-direction: column;
  gap: 4px;
  min-width: 0;
}

.tlabel {
  font: var(--t-label);
  letter-spacing: var(--track-label);
  text-transform: uppercase;
  color: var(--fg-5);
}

.tvalue {
  display: flex;
  align-items: center;
  gap: 6px;
  font: var(--t-mono-md);
  color: var(--fg-2);
}

.sub {
  font: var(--t-mono-xs);
  color: var(--fg-5);
}

.board {
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.round {
  display: grid;
  grid-template-columns: 14px minmax(0, 1fr) 108px 92px;
  align-items: center;
  gap: 10px;
  padding: 9px 11px;
  border-radius: var(--r-xs);
  border-left: 2px solid var(--off);
  background: var(--fill);
}

.round.warn {
  border-left-color: var(--warn);
  background: var(--warn-tint);
}

.round.ok {
  border-left-color: var(--ok);
}

.rbody {
  min-width: 0;
}

.rtitle {
  display: flex;
  align-items: baseline;
  gap: 8px;
  min-width: 0;
}

.task {
  font: var(--t-mono-sm);
  color: var(--fg-3);
  flex: none;
}

.rsummary {
  font: var(--t-ui-md);
  color: var(--fg-2);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.rmeta {
  font: var(--t-mono-xs);
  color: var(--fg-5);
  margin-top: 2px;
}

.nolink {
  font: var(--t-mono-xs);
  color: var(--fg-dim);
  text-align: center;
}

.orphans {
  margin-top: 11px;
  padding-top: 10px;
  border-top: 1px solid var(--line);
}

.olabel {
  font: var(--t-label);
  letter-spacing: var(--track-label);
  text-transform: uppercase;
  color: var(--fg-5);
  margin-bottom: 5px;
}

.orow {
  font: var(--t-mono-xs);
  color: var(--fg-3);
}

.grid-2 {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 10px;
}

.axis {
  display: flex;
  justify-content: space-between;
  font: var(--t-mono-xs);
  color: var(--fg-5);
  margin-top: 6px;
}

.pairs {
  display: flex;
  flex-wrap: wrap;
  gap: 14px;
  margin-top: 9px;
  font: var(--t-mono-sm);
  color: var(--fg-2);
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

.checks {
  display: flex;
  flex-direction: column;
  gap: 7px;
}

.check {
  display: grid;
  grid-template-columns: 12px 168px minmax(0, 1fr);
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

.intake {
  display: flex;
  flex-direction: column;
  gap: 7px;
}

.irow {
  display: grid;
  grid-template-columns: 100px minmax(0, 1fr);
  gap: 10px;
  align-items: baseline;
}

.iproject {
  font: var(--t-mono-sm);
  color: var(--fg-3);
}

.iwhy {
  font: var(--t-ui-md);
  color: var(--fg-2);
}

.note {
  margin-top: 10px;
  padding-top: 9px;
  border-top: 1px solid var(--line);
  font: var(--t-mono-xs);
  color: var(--fg-5);
}

.empty {
  font: var(--t-mono-sm);
  color: var(--fg-dim);
  padding: 8px 4px;
}

@media (max-width: 1100px) {
  .grid-2 {
    grid-template-columns: minmax(0, 1fr);
  }
}
</style>
