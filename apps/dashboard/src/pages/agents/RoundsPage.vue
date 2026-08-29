<script setup lang="ts">
/**
 * The board: is the fleet working, and does it need me?
 *
 * TWO PANELS AND NOTHING ELSE. Everything about the machinery - what it costs,
 * what it is allowed to reach, whether Windmill is healthy - is one click away
 * at /agents/fleet, because none of it answers the question this view exists
 * for. A person opens this page because a gate might be waiting.
 *
 * THE FLEET STRIP IS THE HEADER HALF OF A DELIBERATE DUPLICATION. It answers
 * "is the fleet armed"; the Intake panel on /agents/fleet answers "who said so,
 * and why", and only that one carries the provenance sentence. Both read
 * useIntake(), so the state word, the chip's label and the command it sends
 * come off one derivation and cannot disagree.
 */
import { computed, ref } from "vue";

import Band from "@/components/Band.vue";
import PanelBox from "@/components/PanelBox.vue";
import StatusDot from "@/components/StatusDot.vue";
import StatePill from "@/components/StatePill.vue";
import ChipLink from "@/components/ChipLink.vue";
import ChipButton from "@/components/ChipButton.vue";
import ProgressBar from "@/components/ProgressBar.vue";
import StaleNote from "@/components/StaleNote.vue";

import { usePoll } from "@/composables/usePoll";
import { useMetricsStale } from "@/composables/useStaleness";
import { useTooltip } from "@/composables/useTooltip";
import { useIntake } from "@/composables/useIntake";
import { useHostStore } from "@/stores/host";
import { useFleetStore } from "@/stores/fleet";
import { instant, value } from "@/api/prometheus";
import { AGENTS } from "@/queries";
import { heartbeatTone, quotaTone } from "@/health";
import { roundKey } from "@/api/round";
import { byUrgency } from "@/fleet";
import { boardRow } from "@/roundboard";
import type { InstantSeries, Tone } from "@/types";
import * as fmt from "@/format";

const tip = useTooltip();
const host = useHostStore();
const fleet = useFleetStore();
const metricsStale = useMetricsStale();

// The thresholds the battery grades on, so the page and the MOTD agree.
const CONDUCT_STALE_S = 600; // agents.conduct_fresh
const PHASE_MAX_S = 5400; // RuntimeMaxSec on the phase scope
const PHASE_STUCK_S = 10800; // agents.phase_stuck, and AgentPhaseStuck

// --- the numbers this view actually draws ------------------------------------
// EIGHT, NOT TWENTY-FOUR. The single page asked for every agent series on every
// poll and drew a third of them here; the rest belong to /agents/fleet and are
// fetched there. markerPresent, lastOk and slicePids were fetched by the old
// page and drawn nowhere at all - they are not carried over.

const metrics = usePoll(async (signal) => {
  const one = (r: InstantSeries[]) => value(r[0]?.value);
  const [
    heartbeat, phaseInFlight, phaseStarted, quotaStatus, quotaResets, quotaRead,
    worktreesLeased, worktreesOnDisk,
  ] = await Promise.all([
    instant(AGENTS.heartbeat, signal),
    instant(AGENTS.phaseInFlight, signal),
    instant(AGENTS.phaseStarted, signal),
    instant(AGENTS.quotaStatus, signal),
    instant(AGENTS.quotaResets, signal),
    instant(AGENTS.quotaRead, signal),
    instant(AGENTS.worktreesLeased, signal),
    instant(AGENTS.worktreesOnDisk, signal),
  ]);

  // ABSENT IS undefined, NOT NaN, for the three where absence is a distinct
  // finding rather than a missing reading: a phase that has never run and a
  // quota nobody has read must both render grey.
  const first = (r: InstantSeries[]) => (r.length ? value(r[0].value) : undefined);

  return {
    heartbeat: one(heartbeat),
    phaseInFlight: first(phaseInFlight),
    phaseStarted: one(phaseStarted),
    quotaStatus: first(quotaStatus),
    quotaResets: one(quotaResets),
    quotaRead: one(quotaRead),
    worktreesLeased: first(worktreesLeased),
    worktreesOnDisk: first(worktreesOnDisk),
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

const midPhase = computed(() => phase.value.state === "in flight");
const intake = useIntake(midPhase);

// --- the board ---------------------------------------------------------------

/**
 * Whether the board is showing merged rounds too.
 *
 * A FILTER NOBODY CAN SEE IS A FILTER THAT LIES, so the count it is holding
 * back is printed beside the toggle whether or not it is on. Default off: a
 * merged round is finished work and the page exists to show what is not.
 */
const showAll = ref(false);

const board = computed(() => {
  const ctx = {
    now: host.now,
    generatedAt: fleet.generatedAt,
    phaseStats: fleet.phaseStats,
    runs: fleet.doc?.runs ?? [],
    control: fleet.control,
  };
  return [...(showAll.value ? fleet.rounds : fleet.openRounds)]
    .sort(byUrgency)
    .map((r) => ({ ...boardRow(r, ctx), key: roundKey(r.worktree_id, r.started_at) }));
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

const etaTip = computed(() => ({
  title: "ETA",
  lines: Object.entries(fleet.phaseStats).map(
    ([name, stat]) =>
      `${name}: ${
        stat.median_seconds === null ? "no completed runs" : fmt.duration(stat.median_seconds)
      } (${stat.samples} samples)`,
  ),
  caveat:
    "A median of this host's own completed runs of each REMAINING phase, over 30 days - conduct records no expectation anywhere, so this is derived rather than declared. It is a prediction, it has been wrong, and it is withheld entirely below five samples rather than guessed.",
}));

const costTip = computed(() => ({
  title: "cost",
  lines: [
    "summed over this attempt's own phase runs",
    `${fmt.number(fleet.totals?.cost_today ?? Number.NaN, 2)} USD today across every round`,
  ],
  caveat:
    "conduct's own tally from the CLI's result event, not a price anybody invented - and it is reported, never retained. There is deliberately no dollar metric and no spend ceiling: the quota status is what paces the fleet, so this can be read and cannot become a second currency.",
}));

/** The rail, off the same tone the dot reads, so the two cannot drift. */
function rail(tone: Tone): string {
  return `var(--${tone === "fail" ? "fail" : tone === "warn" ? "warn" : tone === "ok" ? "ok" : "off"})`;
}
</script>

<template>
  <Band label="Fleet">
    <PanelBox :stale="metricsStale">
      <div class="tiles">
        <div class="tile">
          <span class="tlabel label">conduct</span>
          <span class="tvalue">
            <StatusDot :tone="conduct.tone" :size="6" />
            <span class="mono">{{
              Number.isFinite(conduct.age) ? `${fmt.coarse(conduct.age)} ago` : "never run"
            }}</span>
          </span>
        </div>

        <div class="tile">
          <span class="tlabel label">phase</span>
          <span class="tvalue">
            <StatusDot :tone="phase.tone" :live="midPhase" :size="6" />
            <span class="mono">{{ phase.state }}</span>
          </span>
          <ProgressBar
            :ratio="Number.isFinite(phase.age) ? phase.age / PHASE_MAX_S : null"
            :tone="phase.tone"
            :live="midPhase"
          />
          <span class="mono sub">{{
            Number.isFinite(phase.age) ? fmt.duration(phase.age) : fmt.NO_DATA
          }}</span>
        </div>

        <div class="tile" v-bind="tip.hover('ag-quota', quotaTip)">
          <span class="tlabel label">quota</span>
          <span class="tvalue">
            <StatePill :label="quota.state" :tone="quota.tone" size="sm" />
          </span>
          <span class="mono sub">{{ quota.clears ?? "no window recorded" }}</span>
        </div>

        <div class="tile" v-bind="tip.hover('ag-worktrees', worktreeTip)">
          <span class="tlabel label">worktrees</span>
          <span class="mono tvalue">
            {{ fmt.number(m?.worktreesLeased ?? Number.NaN) }} leased /
            {{ fmt.number(m?.worktreesOnDisk ?? Number.NaN) }} on disk
          </span>
          <span class="mono sub">leases in the database, directories on disk</span>
        </div>

        <!-- THE ONE CONTROL THAT DECIDES WHETHER ANY OF THE REST HAPPENS, and
             it is here for that reason. It lived only in the Intake panel, six
             panels down, where it was correct, enabled and missed. -->
        <div class="tile">
          <span class="tlabel label">intake</span>
          <span class="tvalue">
            <StatePill :label="intake.state.value.state" :tone="intake.state.value.tone" size="sm" />
            <ChipButton
              :label="intake.state.value.label"
              :disabled="intake.disabled.value"
              :act="() => intake.toggle()"
              :title="intake.state.value.title"
              :pending="intake.askedFor.value !== null"
            />
          </span>
          <span class="mono sub" :class="{ warnish: intake.askedFor.value !== null }">{{
            intake.sub.value
          }}</span>
        </div>
      </div>
    </PanelBox>
  </Band>

  <Band label="Rounds">
    <template #aside>
      <span class="count">{{ fleet.openRounds.length }}</span> open,
      <span class="count">{{ fleet.waitingOnPerson.length }}</span> waiting on you
      <!-- THE COUNT IS SHOWN WHETHER OR NOT THE TOGGLE IS ON, because a filter
           a reader cannot see is a filter that lies to them. -->
      <button
        v-if="fleet.settledCount > 0 || showAll"
        type="button"
        class="toggle"
        @click="showAll = !showAll"
      >
        {{ showAll ? "hide merged" : `show ${fleet.settledCount} merged` }}
      </button>
    </template>

    <PanelBox :stale="fleet.stale">
      <!-- A LOCKED DATABASE IS NOT AN IDLE FLEET, and the empty list looks the
           same either way. This is what `sources` is for. -->
      <p v-if="fleet.dbUnreadable" class="empty mono bad">
        conduct's database could not be read in the last run. These rows are absent, not zero.
      </p>

      <table v-else-if="board.length" class="tbl">
        <thead>
          <tr>
            <th class="c-state">State</th>
            <th>Task</th>
            <th class="c-phase">Phase</th>
            <th class="c-time" v-bind="tip.hover('ag-eta', etaTip)">Time</th>
            <th class="c-cost r" v-bind="tip.hover('ag-cost', costTip)">Cost</th>
            <th class="c-out">Outcome</th>
          </tr>
        </thead>
        <tbody>
          <tr
            v-for="row in board"
            :key="row.r.worktree_id"
            class="hov"
            :class="row.tone"
          >
            <!-- THE WHOLE ROW LEADS TO THE ROUND. It used to open a full-width
                 sibling row carrying the approval card, the events and every
                 phase transcript - 7,500 bytes of prose inside a table. It is a
                 page now, and a page has a URL somebody can send themselves. -->
            <td class="rail" :style="{ '--rail': rail(row.tone) }">
              <RouterLink v-if="row.key" :to="`/agents/rounds/${row.key}`" class="state">
                <StatusDot :tone="row.tone" :live="row.waiting" :size="7" />
                <StatePill :label="row.state" :tone="row.tone" size="sm" />
              </RouterLink>
              <!-- NO START TIME MEANS NO DOCUMENT NAME. Said rather than
                   linked to a page that could only report the same thing. -->
              <span v-else class="state" :title="'this round has no start time, so it has no document'">
                <StatusDot :tone="row.tone" :live="row.waiting" :size="7" />
                <StatePill :label="row.state" :tone="row.tone" size="sm" />
              </span>
            </td>

            <td>
              <!-- The tracker task this round is carrying. A disabled chip when
                   ODOO_URL is unset, which is also the `npm run dev` case. -->
              <ChipLink
                :label="row.r.odoo_task ? `#${row.r.odoo_task}` : row.r.worktree_id"
                :href="row.r.odoo_url"
                title="open this task in the tracker"
              />
              <div class="tsummary truncate" :title="row.r.summary ?? row.r.ref ?? ''">
                {{ row.r.summary ?? row.r.ref ?? "no branch recorded" }}
              </div>
            </td>

            <td>
              <div class="mono pname">{{ row.phase }}</div>
              <ProgressBar
                :ratio="row.progress"
                :tone="row.tone"
                :live="row.moving"
              />
              <!-- A HOLD IS BOUNDED BY SOMETHING THE PERSON SETTING IT DOES NOT
                   CONTROL. conduct does not answer a held step, and the step's
                   own suspend timeout is 24h - so a hold left long enough does
                   not pause a round, it fails one. The countdown is the only
                   thing that says so before it happens. -->
              <div
                v-if="row.r.held"
                class="mono sub warnish truncate"
                :title="`Held ${fmt.sinceIso(row.r.held_at)}${row.r.held_why ? ` - ${row.r.held_why}` : ''}. conduct does not answer a held step, and the step's own suspend timeout is 24h - past that this stops being a pause and fails the flow.`"
              >
                held {{ fmt.sinceIso(row.r.held_at) }} -
                {{
                  row.holdLeft === null || row.holdLeft <= 0
                    ? "past the timeout"
                    : `${fmt.coarse(row.holdLeft)} left`
                }}
              </div>
              <!-- ATTEMPT BESIDE `opened`, AND ONLY WHEN IT IS NOT THE FIRST.
                   Each row IS one attempt, so this says which - but "attempt 1
                   of 3" is on every round that went through once, which is a
                   line on every row saying nothing. The same guard is what
                   stops a document written by an older collector rendering
                   "attempt  of 3". -->
              <div v-else class="mono sub truncate">
                opened {{ fmt.sinceIso(row.r.opened_at) }}
                <template v-if="row.attempt !== null">
                  - attempt {{ row.attempt }} of {{ row.r.max_attempts }}
                </template>
              </div>
            </td>

            <!-- TWO CLOCKS, AND THE ESTIMATE IS THE ONE THAT IS OFTEN ABSENT.
                 This column used to hold the ETA alone and so read `-` on most
                 rows: the collector withholds an estimate below five samples of
                 any remaining phase. Elapsed is always knowable, so it leads. -->
            <td class="mono" v-bind="tip.hover(`ag-eta-${row.r.worktree_id}`, etaTip)">
              {{ row.elapsed }}
              <div v-if="row.phaseClock" class="sub truncate">{{ row.phaseClock }}</div>
              <div v-else-if="row.eta !== fmt.NO_DATA" class="sub">{{ row.eta }} left</div>
            </td>

            <!-- What this attempt cost, which the totals panel cannot show:
                 today's five rounds span $2.47 to $17.94 and an expensive
                 failure is invisible in a daily sum. Display only, never a
                 series. -->
            <td class="r mono">
              {{ row.r.cost_usd === null ? fmt.NO_DATA : `$${row.r.cost_usd.toFixed(2)}` }}
            </td>

            <td class="out">
              <ChipLink
                v-if="row.r.pr_url"
                :label="row.r.pr_number === null ? 'pr' : `#${row.r.pr_number}`"
                :href="row.r.pr_url"
                :title="`the pull request this round opened (${row.r.pr_state})`"
              />
              <!-- NO PULL REQUEST YET, BUT THERE IS CODE TO READ. conduct
                   pushes the branch at the end of dev, minutes before a gate
                   that runs for fifteen to thirty - so for most of a round's
                   life this column would otherwise be empty at exactly the
                   moment somebody wants to look. The `agents/` prefix is
                   dropped because it is on every branch. -->
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
                   column at all, and "opened none" beside a state of
                   "published" is the row contradicting itself. -->
              <span v-else-if="row.r.published && row.r.pr_state !== 'unknown'" class="nolink">
                opened none
              </span>
              <span v-else class="nolink">{{ fmt.NO_DATA }}</span>
            </td>
          </tr>
        </tbody>
      </table>

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
        <p class="label">Unanswered, with no open round</p>
        <p v-for="n in fleet.orphanNotices" :key="n.module_id + n.flow_job_id" class="mono orow">
          {{ n.summary ?? n.kind }} - asked {{ fmt.sinceIso(n.first_at) }}, {{ n.sends }} sends
        </p>
      </div>

      <div v-if="fleet.publications.length" class="orphans">
        <p class="label">Pushed, pull request not open yet</p>
        <p v-for="p in fleet.publications" :key="p.job_id" class="mono orow">
          {{ p.branch ?? p.worktree_id }} - {{ fmt.sinceIso(p.opened_at) }}
        </p>
      </div>

      <StaleNote v-for="note in fleet.sourceNotes" :key="note" :reason="note" />
    </PanelBox>
  </Band>
</template>

<style scoped>
.tiles {
  display: grid;
  grid-template-columns: repeat(5, minmax(0, 1fr));
  gap: var(--gap-lg);
}

.tile {
  display: flex;
  flex-direction: column;
  gap: 5px;
  min-width: 0;
}

.tvalue {
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

/* --- the board ----------------------------------------------------------- */

/* The task column takes what is left, which at 1360 is around 430px - enough
   for the tracker chip and a one-line summary, and no more. It had 570 while
   the phase cell was clipping "opened 11h 00m ago - attempt 2 of 3" mid-word. */
.c-state {
  width: 168px;
}

.c-phase {
  width: 282px;
}

.c-time {
  width: 140px;
}

.c-cost {
  width: 84px;
}

.c-out {
  width: 140px;
}

/* NO ROW TINT. The rail is the whole severity language here, which is the
   table recipe's own rule: a 2px inside edge on the first cell so the colour
   reads down the left WITHOUT a wash on every row. Three red rows and an amber
   one is a wall, and the pill in the first cell already says which is which. */

.state {
  display: flex;
  align-items: center;
  gap: 6px;
  color: inherit;
}

a.state:hover {
  color: inherit;
}

.pname {
  font: var(--t-mono-md);
  color: var(--fg-2);
  margin-bottom: 4px;
}

.tsummary {
  margin-top: 3px;
  font: var(--t-ui-sm);
  color: var(--fg-4);
}

td .sub {
  margin-top: 3px;
}

.toggle {
  margin-left: 10px;
  padding: 2px 9px;
  font: var(--t-ui-sm);
  color: var(--fg-4);
  background: var(--fill);
  border: 1px solid var(--line);
  border-radius: var(--r-sm);
  transition: color var(--dur-fast) var(--ease-standard),
    border-color var(--dur-fast) var(--ease-standard);
}

.toggle:hover {
  color: var(--accent);
  border-color: var(--accent-edge);
}

.nolink {
  font: var(--t-mono-sm);
  color: var(--fg-5);
}

/* overflow-wrap cannot break a chip, so the cell clips instead. Without this
   one long branch name widens the fixed table and the page grows a horizontal
   scrollbar - which on a full-width board is the whole viewport. */
td.out {
  overflow: hidden;
}

.orphans {
  margin-top: 14px;
  padding-top: 12px;
  border-top: 1px solid var(--border-divider);
}

.orphans .label {
  margin-bottom: 6px;
}

.orow {
  font: var(--t-mono-sm);
  color: var(--fg-3);
}

.empty {
  font: var(--t-mono-sm);
  color: var(--fg-dim);
  padding: 8px 4px;
}

.bad {
  color: var(--fail-text);
}

@media (max-width: 1180px) {
  .tiles {
    grid-template-columns: repeat(2, minmax(0, 1fr));
  }
}
</style>
