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
import { computed, ref, watch } from "vue";

import PanelBox from "@/components/PanelBox.vue";
import StatusDot from "@/components/StatusDot.vue";
import StatePill from "@/components/StatePill.vue";
import ChipLink from "@/components/ChipLink.vue";
import ChipButton from "@/components/ChipButton.vue";
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
import { control } from "@/api/control";
import { askAge, holdExpiresIn, intakeSwitch, roundControls } from "@/control";
import type { RememberedAsk } from "@/control";
import {
  byUrgency,
  roundAction,
  roundBranch,
  roundError,
  roundEtaAt,
  roundProgress,
  roundState,
} from "@/fleet";
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

const totals = computed(() => fleet.totals);

/**
 * Whether the board is showing merged rounds too.
 *
 * A FILTER NOBODY CAN SEE IS A FILTER THAT LIES, so the count it is holding
 * back is printed beside the toggle whether or not it is on. Default off: a
 * merged round is finished work and the page exists to show what is not.
 */
const showAll = ref(false);

/**
 * The rows, with everything derived ONCE.
 *
 * The template asked roundState() four times per row - for the tint, the dot,
 * the pill and the bar's tone - and each call is a fresh object, so `v-if` on
 * one of them could not even be compared against another. Deriving here also
 * means the template never contains the state machine, which is the whole point
 * of src/fleet.ts being a module.
 */
/**
 * Which row has its failure open, by worktree id, or null.
 *
 * ONE AT A TIME, which is useTooltip's rule and for its reason: two open
 * failures on a board whose job is to say what needs acting on is two answers
 * to a question nobody asked twice. Clicking the open row closes it.
 */
const opened = ref<string | null>(null);

function toggle(id: string): void {
  opened.value = opened.value === id ? null : id;
}

/**
 * What a person has asked for, and whether they can ask at all.
 *
 * `available` IS READ AND NOT ASSUMED. The collector reads the same .env Caddy
 * takes the token from, so an unset one disables every control with a reason
 * rather than offering a button that 401s - absent and broken are different
 * findings, which is the rule the whole document is written around.
 */
// ONE VALUE, FROM WHICHEVER DOCUMENT CAN SPEAK FOR IT. The store decides between
// control.json (30s) and fleet.json (up to 10 minutes) and hands back a single
// object, so nothing on this page has to know there are two.
const controlState = computed(() => fleet.control);
const intake = computed(() => intakeSwitch(controlState.value, "upskald"));

/**
 * What this browser last asked of the intake switch, across a reload.
 *
 * sessionStorage IS THE RIGHT SIZE FOR IT. It is one person's own click, not a
 * fact about the fleet: nothing on the host records that a command was sent,
 * and the collector deliberately does not grow a Windmill dependency to find
 * out. The same store api/http.ts already uses for its reauth rate-limit, and
 * every access is wrapped for the same reason - a private window or disabled
 * storage must degrade to "no memory", never to a broken page.
 */
const ASK_KEY = "home-server.ask.intake:upskald";

function readAsk(): RememberedAsk | null {
  try {
    const raw = sessionStorage.getItem(ASK_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<RememberedAsk>;
    // SHAPE-CHECKED, because this outlives a deploy: a value written by an
    // older bundle must read as no memory rather than throw here.
    return typeof parsed?.at === "number" && typeof parsed?.action === "string"
      ? { action: parsed.action, at: parsed.at }
      : null;
  } catch {
    return null;
  }
}

const remembered = ref<RememberedAsk | null>(readAsk());

/** Seconds the ask has stood, or null once the fleet has been seen doing it. */
const askedFor = computed(() => askAge(remembered.value, intake.value.action, host.now));

// FORGET IT THE MOMENT IT STOPS STANDING, so a later mount does not re-read a
// memory `askAge` has already retired. The derivation decides; this only
// records what it decided.
watch(askedFor, (age) => {
  if (age !== null || remembered.value === null) return;
  remembered.value = null;
  try {
    sessionStorage.removeItem(ASK_KEY);
  } catch {
    // Nothing to clear, which is the same outcome.
  }
});

/** What the switch says under it: the ask if one is outstanding, else who set it. */
const intakeSub = computed(() => {
  if (askedFor.value !== null) {
    const waiting =
      phase.value.state === "in flight"
        ? " - conduct is mid-phase, and answers this from inside it"
        : "";
    return `${intake.value.label} asked ${fmt.coarse(askedFor.value)} ago${waiting}`;
  }
  return intake.value.source === "set"
    ? `set by hand ${fmt.sinceIso(intake.value.at)}`
    : "conduct's own default";
});
const controlDisabled = computed(() =>
  controlState.value.available ? null : "the control route has no token - see WINDMILL_DASHBOARD_TOKEN",
);

async function toggleIntake(): Promise<void> {
  // THE ACTION IS THE ONE THE CHIP IS LABELLED WITH, read rather than
  // re-derived. Two ternaries over one boolean agree only for as long as
  // somebody keeps them agreeing, and the failure is a button that does the
  // opposite of what it reads.
  const asked = intake.value.action;
  await control({ action: asked, project: "upskald" });
  // AFTER THE POST AND ONLY ON SUCCESS. A command that never reached Windmill
  // is not outstanding, it failed, and the chip says so itself.
  remembered.value = { action: asked, at: Math.floor(Date.now() / 1000) };
  try {
    sessionStorage.setItem(ASK_KEY, JSON.stringify(remembered.value));
  } catch {
    // A private window. The in-memory ref still carries it for this mount.
  }
  // ASKED, NOT DONE. conduct applies it on its next cycle, so the honest way to
  // learn what happened is the next document rather than an optimistic local
  // flip - which would show `armed` over a fleet that had refused.
  await fleet.refresh();
}

const board = computed(() =>
  [...(showAll.value ? fleet.rounds : fleet.openRounds)].sort(byUrgency).map((r) => ({
    r,
    ...roundState(r),
    action: roundAction(r),
    progress: roundProgress(r),
    eta: etaLabel(r),
    elapsed: elapsedLabel(r),
    phaseClock: phaseClock(r),
    branch: roundBranch(r),
    error: roundError(r),
    // THE NUMBER IS ONLY WORTH THE LINE WHEN IT IS NOT ONE. Every round that
    // went through once reads "attempt 1 of 3", which is on every row and
    // distinguishes none of them - and `> 1` also happens to be exactly the
    // guard `!== null` was reaching for, without the hole: the collector and
    // this bundle deploy separately, so a document written by an older one has
    // no `attempts` key at all, and `undefined !== null` is true.
    attempt: typeof r.attempts === "number" && r.attempts > 1 ? r.attempts : null,
    controls: roundControls(r, controlState.value, host.now),
    holdLeft: holdExpiresIn(r, host.now),
  })),
);

async function send(action: "hold" | "release" | "restart", target: string): Promise<void> {
  await control({ action, target });
  await fleet.refresh();
}

/** The phase in flight, and its position in the round's own sequence. Reads
 *  "dev 2/5" while running and "done 5/5" once every phase has finished. */
function phaseLabel(r: FleetRound): string {
  const total = r.phases.length || 0;
  const at = r.done.length;
  if (!total) return r.phase ?? "no phase";
  if (at >= total) return `done ${at}/${total}`;
  return `${r.phase ?? "no phase"} ${at}/${total}`;
}

/**
 * The ETA cell, which says "-" far more often than it says a number.
 *
 * THREE OUTCOMES, AND TWO OF THEM ARE NOT A TIME. The collector withholds the
 * estimate entirely when any remaining phase has fewer than five completed runs
 * behind it, and a round past its own median has an unknown remainder rather
 * than a negative one - so that reads "overdue", which is the estimate
 * admitting it was wrong instead of freezing at zero.
 */
function etaLabel(r: FleetRound): string {
  const at = roundEtaAt(r, fleet.generatedAt);
  if (at === null) return fmt.NO_DATA;
  const remaining = at - host.now;
  return remaining <= 0 ? `overdue ${fmt.coarse(-remaining)}` : `~${fmt.coarse(remaining)}`;
}

/**
 * How long the round has been going, or how long it took.
 *
 * ELAPSED IS ALWAYS KNOWABLE AND THE ESTIMATE USUALLY IS NOT - the collector
 * withholds an ETA entirely when any remaining phase has fewer than five
 * completed runs, so this column read `-` on most rows most of the time while a
 * round had visibly been running for half an hour. `opened N ago` under the
 * progress bar answers WHEN; this answers HOW LONG, and on a finished round
 * they are different numbers.
 */
function elapsedLabel(r: FleetRound): string {
  const from = fmt.isoToUnix(r.started_at ?? r.opened_at);
  if (!Number.isFinite(from)) return fmt.NO_DATA;
  if (r.closed_at !== null) {
    const to = fmt.isoToUnix(r.closed_at);
    return Number.isFinite(to) ? `took ${fmt.coarse(to - from)}` : fmt.NO_DATA;
  }
  return fmt.coarse(host.now - from);
}

/**
 * The second clock: the phase in flight, against this host's own median for it.
 *
 * FROM THE ROUND'S OWN PHASE AND THE FLEET-WIDE MEDIAN, which are two different
 * sources and deliberately so - `phase_stats` is thirty days of completed runs
 * of that phase across every round, and there is no per-round expectation
 * anywhere to compare against instead. Below five samples the collector
 * withholds the median, and so does this: `dev 26m` rather than a made-up
 * fraction of a number nobody measured.
 */
function phaseClock(r: FleetRound): string | null {
  if (r.closed_at !== null) return null;
  const name = r.phase;
  const started = fmt.isoToUnix(fleet.doc?.runs?.find((run) => run.ended_at === null)?.started_at);
  if (!name || !Number.isFinite(started)) return null;
  const elapsed = fmt.coarse(host.now - started);
  const stat = fleet.phaseStats[name];
  const median = stat && stat.samples >= 5 ? stat.median_seconds : null;
  return median === null ? `${name} ${elapsed}` : `${name} ${elapsed} of ~${fmt.coarse(median)}`;
}

const rowCostTip = computed(() => ({
  title: "cost",
  lines: [
    "summed over this attempt's own phase runs",
    `${fmt.number(totals.value?.cost_today ?? Number.NaN, 2)} USD today across every round`,
  ],
  caveat:
    "conduct's own tally from the CLI's result event, not a price anybody invented - and it is reported, never retained. There is deliberately no dollar metric and no spend ceiling: the quota status is what paces the fleet, so this can be read and cannot become a second currency.",
}));

const etaTip = computed(() => ({
  title: "ETA",
  lines: Object.entries(fleet.phaseStats).map(
    ([phase, stat]) =>
      `${phase}: ${
        stat.median_seconds === null ? "no completed runs" : fmt.duration(stat.median_seconds)
      } (${stat.samples} samples)`,
  ),
  caveat:
    "A median of this host's own completed runs of each REMAINING phase, over 30 days - conduct records no expectation anywhere, so this is derived rather than declared. It is a prediction, it has been wrong, and it is withheld entirely below five samples rather than guessed.",
}));

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
      <!-- NOT "read only" ANY MORE, and this page is the only one of the five
           where that is so: intake, hold, release and restart all act. What is
           still true is the weaker claim the chips themselves make - conduct
           applies them on its next cycle, so the board asks and never does. -->
      <span class="mono note">asks the fleet</span>
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

        <!-- THE ONE CONTROL THAT DECIDES WHETHER ANY OF THE REST HAPPENS, and
             it is in the header for that reason. It was only in the Intake
             panel at the foot of the page, six panels down, where it was
             correct, enabled, and missed. The panel keeps it too: this tile
             answers "is the fleet armed", that one answers "who said so". -->
        <div class="tile">
          <span class="mono tlabel">intake</span>
          <span class="tvalue">
            <StatePill :label="intake.state" :tone="intake.tone" size="sm" />
            <ChipButton
              :label="intake.label"
              :disabled="controlDisabled"
              :act="() => toggleIntake()"
              :title="intake.title"
              :pending="askedFor !== null"
            />
          </span>
          <span class="mono sub" :class="{ warnish: askedFor !== null }">{{ intakeSub }}</span>
        </div>
      </div>
    </PanelBox>

    <!-- The run board -------------------------------------------------------->
    <PanelBox label="Runs" :stale="fleet.stale">
      <template #aside>
        <span class="mono">
          {{ fleet.openRounds.length }} shown / {{ fleet.waitingOnPerson.length }} waiting on you
        </span>
        <!-- THE COUNT IS SHOWN WHETHER OR NOT THE TOGGLE IS ON, because a
             filter a reader cannot see is a filter that lies to them. -->
        <button
          v-if="fleet.settledCount > 0 || showAll"
          type="button"
          class="mono toggle"
          @click="showAll = !showAll"
        >
          {{ showAll ? "hide merged" : `show ${fleet.settledCount} merged` }}
        </button>
      </template>

      <!-- A LOCKED DATABASE IS NOT AN IDLE FLEET, and the empty list looks the
           same either way. This is what `sources` is for. -->
      <p v-if="fleet.dbUnreadable" class="empty mono bad">
        conduct's database could not be read in the last run. These rows are absent, not zero.
      </p>

      <!-- --cols is defined ONCE, in the stylesheet, so the header and the
           rows cannot drift apart. Same convention as LibraryPage's table. -->
      <div v-else-if="board.length" class="table">
        <div class="row head mono">
          <span>state</span>
          <span>task</span>
          <span>phase</span>
          <span>progress</span>
          <span v-bind="tip.hover('ag-eta', etaTip)">eta</span>
          <span v-bind="tip.hover('ag-cost', rowCostTip)">cost</span>
          <span>pull request</span>
          <span></span>
        </div>

        <template v-for="row in board" :key="row.r.worktree_id">
        <div class="row" :class="[row.tone, { open: opened === row.r.worktree_id }]">
          <!-- THE STATE CELL IS THE CONTROL, and only when there is something
               behind it. A round that ended well has no error and no sentence,
               so it gets no affordance at all rather than an expander that
               opens onto nothing - which is what would put one on every row. -->
          <component
            :is="row.error.length ? 'button' : 'span'"
            class="cell state"
            :class="{ expander: row.error.length }"
            :type="row.error.length ? 'button' : undefined"
            :aria-expanded="row.error.length ? opened === row.r.worktree_id : undefined"
            :title="row.error.length ? 'why this round stopped' : undefined"
            @click="row.error.length && toggle(row.r.worktree_id)"
          >
            <StatusDot
              :tone="row.tone"
              :live="row.r.closed_at === null && row.r.waiting_on === 'person'"
              :size="7"
            />
            <StatePill :label="row.state" :tone="row.tone" size="sm" />
            <span v-if="row.error.length" class="caret" aria-hidden="true">{{
              opened === row.r.worktree_id ? "-" : "+"
            }}</span>
          </component>

          <!-- The tracker task this round is carrying. A disabled chip when
               ODOO_URL is unset, which is also the `npm run dev` case. -->
          <span class="cell task">
            <ChipLink
              :label="row.r.odoo_task ? `#${row.r.odoo_task}` : row.r.worktree_id"
              :href="row.r.odoo_url"
              title="open this task in the tracker"
            />
            <span class="tsummary" :title="row.r.summary ?? row.r.ref ?? ''">{{
              row.r.summary ?? row.r.ref ?? "no branch recorded"
            }}</span>
          </span>

          <span class="cell mono phase">
            {{ phaseLabel(row.r) }}
            <!-- ATTEMPT BESIDE PROGRESS, NOT INSTEAD OF IT, AND ONLY WHEN IT
                 IS NOT THE FIRST. Each row IS one attempt, so this says which -
                 but "attempt 1 of 3" is on every round that went through once,
                 which is a line on every row saying nothing. See `attempt` in
                 the script: the same guard is what stops a document written by
                 an older collector rendering "attempt  of 3". -->
            <span v-if="row.attempt !== null" class="sub"
              >attempt {{ row.attempt }} of {{ row.r.max_attempts }}</span
            >
          </span>

          <span class="cell progress">
            <ProgressBar
              :ratio="row.progress"
              :tone="row.tone"
              :live="row.r.closed_at === null && row.r.waiting_on === null"
            />
            <!-- A HOLD IS BOUNDED BY SOMETHING THE PERSON SETTING IT DOES NOT
                 CONTROL. conduct does not answer a held step, and the step's own
                 suspend timeout is 24h - so a hold left long enough does not
                 pause a round, it fails one. The countdown is the only thing
                 that says so before it happens. -->
            <span
              v-if="row.r.held"
              class="mono sub warnish"
              :title="`Held ${fmt.sinceIso(row.r.held_at)}${row.r.held_why ? ` - ${row.r.held_why}` : ''}. conduct does not answer a held step, and the step's own suspend timeout is 24h - past that this stops being a pause and fails the flow.`"
              >held {{ fmt.sinceIso(row.r.held_at) }} -
              {{
                row.holdLeft === null || row.holdLeft <= 0
                  ? "past the timeout"
                  : `${fmt.coarse(row.holdLeft)} left`
              }}</span
            >
            <span v-else class="mono sub">opened {{ fmt.sinceIso(row.r.opened_at) }}</span>
          </span>

          <!-- TWO CLOCKS, AND THE ESTIMATE IS THE ONE THAT IS OFTEN ABSENT.
               This column used to hold the ETA alone and so read `-` on most
               rows: the collector withholds an estimate below five samples of
               any remaining phase. Elapsed is always knowable, so it leads. -->
          <span class="cell mono eta" v-bind="tip.hover(`ag-eta-${row.r.worktree_id}`, etaTip)">
            {{ row.elapsed }}
            <span v-if="row.phaseClock" class="sub">{{ row.phaseClock }}</span>
            <span v-else-if="row.eta !== fmt.NO_DATA" class="sub">{{ row.eta }} left</span>
          </span>

          <!-- What this attempt cost, which the totals panel below cannot show:
               today's five rounds span $2.47 to $17.94 and an expensive failure
               is invisible in a daily sum. Display only - never a series. -->
          <span class="cell mono cost">{{
            row.r.cost_usd === null ? fmt.NO_DATA : `$${row.r.cost_usd.toFixed(2)}`
          }}</span>

          <span class="cell mono pr">
            <ChipLink
              v-if="row.r.pr_url"
              :label="row.r.pr_number === null ? 'pr' : `#${row.r.pr_number}`"
              :href="row.r.pr_url"
              :title="`the pull request this round opened (${row.r.pr_state})`"
            />
            <!-- NO PULL REQUEST YET, BUT THERE IS CODE TO READ. conduct
                 pushes the branch at the end of dev, minutes before a gate that
                 runs for fifteen to thirty - so for most of a round's life this
                 column would otherwise be empty at exactly the moment somebody
                 wants to look. The `agents/` prefix is dropped because it is on
                 every branch and distinguishes none of them. -->
            <ChipLink
              v-else-if="row.branch"
              :label="row.branch"
              :href="row.r.branch_url"
              title="the branch this round pushed, before any pull request"
            />
            <!-- A ROUND THAT CLOSED WITHOUT ONE IS NOT A ROUND STILL WAITING.
                 A declined approval and a seven-day timeout both land here.
                 ONLY WHEN A URL WOULD HAVE BEEN VISIBLE HAD THERE BEEN ONE:
                 pr_state "unknown" means the collector could not read the
                 column at all, and "opened none" beside a state of "published"
                 is the row contradicting itself. -->
            <span v-else-if="row.r.published && row.r.pr_state !== 'unknown'" class="nolink"
              >opened none</span
            >
            <span v-else class="nolink">-</span>
          </span>

          <span class="cell r">
            <ChipLink :label="row.action.label" :href="row.action.href" :title="row.action.title" />
            <!-- THE CONTROLS, AND ONLY ON A ROUND THAT IS STILL RUNNING.
                 Holding a finished round stops nothing and restarting one has no
                 chain for conduct to close - roundControls returns an empty list
                 rather than a disabled pair, because a control that could never
                 apply is noise on every closed row. -->
            <ChipButton
              v-for="c in row.controls"
              :key="c.action"
              :label="c.label"
              :disabled="c.disabled"
              :act="() => send(c.action as 'hold' | 'release' | 'restart', c.target ?? '')"
              :title="
                c.action === 'restart'
                  ? 'close this round, cancel its flow, and start it again with the same task'
                  : c.action === 'hold'
                    ? 'stop dispatching this round - the phase running now finishes first'
                    : 'start dispatching this round again'
              "
            />
          </span>
        </div>

        <!-- WHY IT STOPPED, IN conduct'S OWN WORDS. A SIBLING ROW spanning
             every column, not a child: `.row` is the grid, so anything inside
             it becomes an eighth cell and shifts the seven beside it.
             THE GATE LOG IS NAMED AND NEVER LINKED. It is ten megabytes on the
             host, outside anything this container can serve, so a link would be
             an offer the page cannot keep. -->
        <div v-if="opened === row.r.worktree_id" class="row detail" :class="row.tone">
          <div class="why mono">
            <p v-for="(line, i) in row.error" :key="i">{{ line }}</p>
          </div>
        </div>
        </template>
      </div>

      <p v-else-if="fleet.settledCount > 0" class="empty mono">
        Nothing in flight. {{ fleet.settledCount }} merged round(s) are hidden - press
        "show merged" above.
      </p>

      <p v-else class="empty mono">
        No rounds open. That is the fleet idle, which is its ordinary resting state.
      </p>

      <!-- The GitHub leg fails OPEN, so this is the sentence that explains why
           a merged round is still on the board rather than a silent filter. -->
      <StaleNote
        v-if="fleet.doc?.sources.github && !fleet.doc.sources.github.ok"
        :reason="`GitHub did not answer (${fleet.doc.sources.github.error}), so no round could be confirmed merged - none is hidden`"
      />

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
      <!-- A DIFFERENT UNIT FROM THE BOARD ABOVE, and the label has to say so.
           A round is one task through five phases, so `runs_today = 6` is six
           PHASE executions and could be one round or three. -->
      <PanelBox label="Phase runs" :stale="metricsStale">
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

        <!-- THE SWITCH IN FRONT OF THE PASS THAT CHOOSES, and it says which of
             the two sources is in force. conduct's descriptor is the shipped
             default and a control row overrides it without a restart, so "is
             intake armed" now has an answer and a plausible wrong one. The
             collector cannot read a Python literal in another repository, so
             "default" does not claim to know WHICH default. -->
        <div class="switch">
          <span class="mono sname">choose its own work</span>
          <span class="mono" :class="intake.tone === 'ok' ? 'onish' : 'offish'">{{
            intake.state
          }}</span>
          <!-- THE SENTENCE IS THIS DRAWING'S OWN, and the header's is not. This
               one carries the note, because the panel is the record of who set
               it and why; the header carries only the age, because it answers a
               different question. The state, the chip and the command are the
               parts that must not differ, and those come from one function. -->
          <span class="mono sub">{{
            askedFor !== null
              ? intakeSub
              : intake.source === "set"
                ? `set by hand ${fmt.sinceIso(intake.at)}${intake.note ? ` - ${intake.note}` : ""}`
                : "conduct's own default, unchanged"
          }}</span>
          <ChipButton
            :label="intake.label"
            :disabled="controlDisabled"
            :act="() => toggleIntake()"
            :title="intake.title"
            :pending="askedFor !== null"
          />
        </div>

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

/* --cols DEFINED ONCE, so the header row and every body row are laid out by
   the same declaration and cannot drift apart. LibraryPage's convention. */
.table {
  /* The last column carries the action chip AND the round's controls, so it is
     wider than the 108px it was when it held one link. */
  --cols: 128px 1.5fr 124px 1fr 78px 76px 96px 190px;
  background: var(--surface);
  border: 1px solid var(--line);
  border-radius: var(--r-md);
  overflow: hidden;
}

.row {
  display: grid;
  grid-template-columns: var(--cols);
  gap: 12px;
  align-items: center;
  padding: 7px 13px;
  border-bottom: 1px solid var(--line-faint);
}

.row:last-child {
  border-bottom: none;
}

.row.head {
  font: var(--t-label);
  text-transform: uppercase;
  letter-spacing: var(--track-label);
  color: var(--fg-5);
  background: var(--surface-sunken);
}

/* A tint rather than a border, so a red row does not shift the grid by a pixel
   against the ones above and below it. */
.row.warn {
  background: color-mix(in srgb, var(--warn) 6%, transparent);
}

.row.fail {
  background: color-mix(in srgb, var(--fail) 6%, transparent);
}

.cell {
  display: flex;
  align-items: center;
  gap: 6px;
  min-width: 0;
}

.cell.state {
  gap: 5px;
}

/* The intake switch: a label, its state, where the answer came from, and the
   one control that moves it. */
.switch {
  display: grid;
  grid-template-columns: minmax(0, auto) auto minmax(0, 1fr) auto;
  align-items: center;
  gap: 10px;
  padding: 9px 0 3px;
  border-top: 1px solid var(--line-faint);
  margin-top: 8px;
}

.switch .sname {
  font: var(--t-mono-sm);
  color: var(--fg-3);
}

.switch .onish {
  color: var(--ok);
}

.switch .offish {
  color: var(--fg-5);
}

.switch .sub {
  font: var(--t-mono-xs);
  color: var(--fg-5);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.cell .sub.warnish {
  color: var(--warn);
  /* The progress cell stacks, so a wrapping sub-line makes the whole row two
     lines tall and shifts every one beside it. The full sentence is on the
     title. */
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

/* THE STATE CELL BECOMES A BUTTON when there is a failure behind it, and it has
   to keep the grid it was a `span` in - a button's own display, padding, border
   and font would all move the column. */
.expander {
  appearance: none;
  background: none;
  border: 0;
  padding: 0;
  margin: 0;
  font: inherit;
  color: inherit;
  text-align: left;
  cursor: pointer;
}

.expander:hover .caret,
.expander:focus-visible .caret {
  color: var(--fg-2);
}

.caret {
  margin-left: auto;
  font: var(--t-mono-xs);
  color: var(--fg-5);
}

/* THE FAILURE, SPANNING EVERY COLUMN. A sibling row rather than a child of the
   one above it: `.row` IS the grid, so anything inside it becomes another cell
   and shifts the seven beside it. It keeps the row's tint so the two read as
   one block, and drops the border between them for the same reason. */
.row.open {
  border-bottom: none;
}

.row.detail {
  /* THE FIRST COLUMN AGAIN, so the reason starts under the row's subject rather
     than under its state pill - it belongs to the change, not to the badge. */
  grid-template-columns: var(--cols);
  padding-top: 0;
}

.row.detail .why {
  grid-column: 2 / -1;
}

.why {
  font: var(--t-mono-xs);
  color: var(--fg-4);
  /* Wraps rather than scrolls: these are conduct's sentences, sometimes with a
     list of file names in them, and a reader needs all of it. */
  overflow-wrap: anywhere;
}

.why p {
  margin: 0 0 3px;
}

.why p:last-child {
  margin-bottom: 0;
}

.cell.phase .sub,
.cell.eta .sub {
  white-space: nowrap;
}

.cell.phase,
.cell.eta {
  flex-direction: column;
  align-items: flex-start;
  gap: 1px;
}

.cell.r {
  justify-content: flex-end;
}

.tsummary {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  color: var(--fg-4);
}

.cell .sub {
  font: var(--t-mono-xs);
  color: var(--fg-5);
}

/* The whole progress cell stacks, so the bar keeps its full width. BY CLASS AND
   NOT BY POSITION: this was :nth-child(4), which is correct only while nobody
   adds a cell, and silently restyles its neighbour the moment somebody does. */
.cell.progress {
  flex-direction: column;
  align-items: stretch;
  gap: 3px;
}

.toggle {
  margin-left: 10px;
  padding: 1px 7px;
  font: inherit;
  color: var(--fg-4);
  background: var(--surface-sunken);
  border: 1px solid var(--line);
  border-radius: var(--r-sm);
  cursor: pointer;
}

.toggle:hover {
  color: var(--fg-2);
  border-color: var(--line-strong);
}

.nolink {
  color: var(--fg-5);
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
