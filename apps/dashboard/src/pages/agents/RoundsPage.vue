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
import { quotaSub, useQuotaHold } from "@/composables/useQuotaHold";
import { useHostStore } from "@/stores/host";
import { useFleetStore } from "@/stores/fleet";
import { instant, value } from "@/api/prometheus";
import { AGENTS } from "@/queries";
import { heartbeatTone, quotaTone } from "@/health";
import { roundKey } from "@/api/round";
import { byUrgency } from "@/fleet";
import { boardRow } from "@/roundboard";
import type { FleetRound, InstantSeries, Tone } from "@/types";
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

/**
 * WHETHER THE WARNING STILL STOPS THE FLEET, which is a threshold and not a
 * switch - see src/control.ts's quotaHold. conduct holds at `allowed_warning` by
 * default so that what is left is left for this person's own sessions; lifting
 * it says there are none to leave it for, and moves the level to `rejected` and
 * no further.
 */
const spend = useQuotaHold();

/** True while the API itself is refusing, which no override lifts. */
const rejected = computed(() => quota.value.state === "rejected");

/**
 * The line under the headline reading, and it is three different sentences.
 *
 * `idle` USED TO DRAW A BARE PROGRESS TRACK AND A DASH, which is the encoding
 * this whole store reserves for "in progress, ratio unknown". Nothing is
 * running, which is a different claim - so the bar is not rendered at all and
 * this says which nothing it is. ProgressBar's contract was never wrong; the
 * call site was.
 */
const leadSub = computed(() => {
  const { state, age } = phase.value;
  if (state === "in flight") {
    return Number.isFinite(age)
      ? `${fmt.duration(age)} of ${fmt.duration(PHASE_MAX_S)}`
      : "started at a time nothing recorded";
  }
  if (state === "idle") return "no phase running";
  return "no phase has started on this host";
});

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
    .map((r, i) => {
      const key = roundKey(r.worktree_id, r.started_at);
      // THE WORKTREE ID IS NOT A ROUND ID. It names the LANE, and a worktree is
      // reused between changes by design - so on this host it is the identical
      // string on ten open rounds out of eleven, and it was the v-for key and
      // the per-row tooltip id. Vue does not warn about a duplicate key and a
      // list that never reorders renders correctly anyway, which is why nothing
      // caught it; a keyed diff over a list that DOES reorder may reuse the
      // wrong node. `key` is the document name, which carries the start time.
      //
      // EVERY FIXTURE ROUND HAS A DISTINCT WORKTREE ID, so no screenshot and no
      // shoot.mjs run could have shown this. The live board is the mirror of
      // the fixture: one worktree, ten rounds.
      return { ...boardRow(r, ctx), key, uid: key ?? `${r.worktree_id}-${i}` };
    });
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
    spend.state.value.spending
      ? "the warning hold is lifted for this window"
      : "holding at the warning, which is the default",
    m.value?.quotaRead ? `read ${fmt.since(m.value.quotaRead)}` : "never read",
  ],
  caveat:
    "A status, not a percentage - the account-wide numbers answer 403 to the only credential a headless host can hold. conduct holds at the warning BY DEFAULT, so what is left is left for your own sessions and a rejection normally means something else spent it. `spend` lifts that for the life of this window only and cannot be left on; a rejection still holds either way, and stopping the fleet never gives a spent window back.",
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

/**
 * The one line that names this round.
 *
 * THE WORKTREE ID IS THE LAST FALLBACK AND IT USED TO BE THE FIRST THING IN THE
 * CELL. The tracker chip read `#<task>` when the collector had a task id and the
 * worktree id when it did not - and ten of the eleven live rounds have no task
 * id, so the board opened every row with the same grey chip reading
 * `upskald-ship`, above the summary that was the only line telling them apart.
 * A fallback that is identical on every row is not an identifier.
 */
function taskName(r: FleetRound): string {
  return r.summary ?? r.ref ?? r.worktree_id;
}

/** The rail, off the same tone the dot reads, so the two cannot drift. */
function rail(tone: Tone): string {
  return `var(--${tone === "fail" ? "fail" : tone === "warn" ? "warn" : tone === "ok" ? "ok" : "off"})`;
}
</script>

<template>
  <!-- THE HEADER LEADS WITH ONE READING, and it did not used to. This was five
       equal columns - conduct, phase, quota, worktrees, intake - each given a
       fifth of 1360 to hold about 150px of content, so the band read as a
       sparse row of unrelated numbers with no primary and a great deal of air.
       Every fact it carried is still here; what changed is that they stopped
       being peers.

       AND IT IS NOT LABELLED `Fleet` ANY MORE. That label sat directly under a
       sub-nav whose other segment is also `Fleet`, so the page announced itself
       with the name of the view beside it.

       ONE PANEL WITH INTERNAL HIERARCHY IS NOT A BENTO. The band rule governs
       panels within a band - full width or N equal columns - and this is a
       single full-width panel. -->
  <Band label="Right now">
    <template #aside>
      <!-- THE PROVENANCE OF EVERYTHING BELOW IT, rather than a sixth fact. If
           conduct has stopped polling then no reading in this panel is a
           current claim, so it qualifies them rather than sitting among them.
           It keeps its own tone: stale is still amber, never run still grey. -->
      <span class="beat">
        <StatusDot :tone="conduct.tone" :size="6" />
        <span class="mono">conduct
          {{ Number.isFinite(conduct.age) ? `${fmt.coarse(conduct.age)} ago` : "never run" }}
        </span>
      </span>
    </template>

    <PanelBox :stale="metricsStale">
      <div class="lead">
        <StatusDot :tone="phase.tone" :live="midPhase" :size="9" />
        <span class="reading mono">{{ phase.state }}</span>
      </div>

      <!-- ONLY WHILE SOMETHING IS RUNNING. See leadSub. -->
      <ProgressBar
        v-if="midPhase"
        class="lead-bar"
        :ratio="Number.isFinite(phase.age) ? phase.age / PHASE_MAX_S : null"
        :tone="phase.tone"
        live
      />

      <p class="lead-sub mono">{{ leadSub }}</p>

      <!-- The conditions: what governs whether that reading changes. Packed
           left at content width and wrapping, so a narrow screen reflows them
           and a wide one does not stretch three facts across 1300px. -->
      <div class="conds">
        <!-- THE ONE CONTROL THAT DECIDES WHETHER ANY OF THE REST HAPPENS, and
             it is first for that reason. It lived only in the Intake panel, six
             panels down, where it was correct, enabled and missed. This is
             still the header half of the deliberate duplication: it answers
             "is the fleet armed" and carries no provenance sentence, which
             belongs to the panel on /agents/fleet. -->
        <div class="cond">
          <span class="label">intake</span>
          <span class="cvalue">
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

        <!-- THE PILL STILL REPORTS WHAT THE API SAID, because that is the
             reading and an override does not change it. What the chip changes is
             whether the fleet STOPS on it, and the line underneath is where that
             difference is stated - `clears in 2d` on its own read as a countdown
             to when the fleet resumes, which is exactly what it meant until this
             existed. -->
        <div class="cond" v-bind="tip.hover('ag-quota', quotaTip)">
          <span class="label">quota</span>
          <span class="cvalue">
            <StatePill :label="quota.state" :tone="quota.tone" size="sm" />
            <ChipButton
              :label="spend.state.value.label"
              :disabled="spend.disabled.value"
              :act="() => spend.toggle()"
              :title="spend.state.value.title"
              :pending="spend.askedFor.value !== null"
            />
          </span>
          <span class="mono sub" :class="{ warnish: spend.state.value.spending }">{{
            quotaSub(spend.state.value, quota.clears, rejected,
                     spend.askedFor.value, midPhase)
          }}</span>
        </div>

        <div class="cond" v-bind="tip.hover('ag-worktrees', worktreeTip)">
          <span class="label">worktrees</span>
          <span class="mono cvalue">
            {{ fmt.number(m?.worktreesLeased ?? Number.NaN) }} leased /
            {{ fmt.number(m?.worktreesOnDisk ?? Number.NaN) }} on disk
          </span>
          <span class="mono sub">leases in the database, directories on disk</span>
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
            <th class="c-state p2">State</th>
            <th>Task</th>
            <th class="c-phase p2">Phase</th>
            <th class="c-time p3" v-bind="tip.hover('ag-eta', etaTip)">Time</th>
            <th class="c-cost r p4" v-bind="tip.hover('ag-cost', costTip)">Cost</th>
            <th class="c-out p4">Outcome</th>
          </tr>
        </thead>
        <tbody>
          <tr
            v-for="row in board"
            :key="row.uid"
            class="hov"
            :class="row.tone"
            :style="{ '--rail': rail(row.tone) }"
          >
            <!-- THE WHOLE ROW LEADS TO THE ROUND. It used to open a full-width
                 sibling row carrying the approval card, the events and every
                 phase transcript - 7,500 bytes of prose inside a table. It is a
                 page now, and a page has a URL somebody can send themselves. -->
            <td class="rail p2">
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

            <!-- THE CELL LEADS WITH THE TASK, WHICH IT DID NOT. It opened
                 with the tracker chip, and that chip falls back to the worktree
                 id - see taskName. The title is the line that distinguishes one
                 row from another, so it goes first and the chip joins the meta
                 line under it. -->
            <td class="task">
              <!-- THE STATE, ONCE ITS OWN COLUMN HAS GONE. Below 640 a 156px
                   column holding one word was 48% of a 328px table and left the
                   task itself 158px - about twenty characters of a sentence,
                   with 70px of the state column empty beside it. The column
                   drops at the phone rung and the pill folds in here, at the
                   same left edge it had, so scanning down for `waiting on you`
                   is unchanged and the title gets the width back. The rail is
                   set on the row rather than the cell so it can move with it. -->
              <div class="fold2 tstate">
                <RouterLink v-if="row.key" :to="`/agents/rounds/${row.key}`" class="state">
                  <StatusDot :tone="row.tone" :live="row.waiting" :size="7" />
                  <StatePill :label="row.state" :tone="row.tone" size="sm" />
                </RouterLink>
                <span v-else class="state" title="this round has no start time, so it has no document">
                  <StatusDot :tone="row.tone" :live="row.waiting" :size="7" />
                  <StatePill :label="row.state" :tone="row.tone" size="sm" />
                </span>
              </div>

              <div class="tsummary" :title="taskName(row.r)">{{ taskName(row.r) }}</div>

              <!-- ONE META LINE, AND COLUMN PRIORITY FEEDS IT. Below 900 the
                   cost and outcome columns go; below 640 the phase and time
                   columns go with them, and what each carried arrives here as
                   another item on this row. So a narrow board loses columns and
                   never facts, and the row still leads to the round page, which
                   holds all of it either way.

                   AN ABSENT VALUE ARRIVES AS NOTHING, NOT AS A DASH. In a
                   column under a header, `-` reads as "no cost recorded"; on an
                   unlabelled line it is a dash between two chips, which is how
                   a round with no pull request rendered `- $2.47`. `opened
                   none` stays, because that is a claim rather than an absence.

                   The items are separated by a gap and not by punctuation:
                   every one of them is self-labelling (`ship 4/5`, `took 2h`,
                   `$8.28`), and a separator that has to hide with its own
                   neighbour is how the dash got there in the first place. -->
              <div class="meta">
                <ChipLink
                  v-if="row.r.odoo_task !== null"
                  :label="`#${row.r.odoo_task}`"
                  :href="row.r.odoo_url"
                  title="open this task in the tracker"
                />
                <!-- WRAPPED, BECAUSE A CLASS ON A COMPONENT LANDS ON ITS ROOT.
                     `class="fold3"` on a ChipLink is `.fold3` against ChipLink's
                     own scoped `.chip { display: inline-flex }`, which is one
                     class more specific - so the chip stayed visible at every
                     width and the wide board printed the branch twice, once
                     here and once in the Outcome column it had not dropped. -->
                <span class="fold4 fwrap">
                  <ChipLink
                    v-if="row.r.pr_url"
                    :label="row.r.pr_number === null ? 'pr' : `#${row.r.pr_number}`"
                    :href="row.r.pr_url"
                    :title="`the pull request this round opened (${row.r.pr_state})`"
                  />
                  <ChipLink
                    v-else-if="row.branch"
                    :label="row.branch"
                    :href="row.r.branch_url"
                    title="the branch this round pushed, before any pull request"
                  />
                  <span
                    v-else-if="row.r.published && row.r.pr_state !== 'unknown'"
                    class="mono mline"
                  >
                    opened none
                  </span>
                </span>
                <span class="fold2 mono mline">{{ row.phase }}</span>
                <span class="fold3 mono mline">{{ row.elapsed }}</span>
                <span v-if="row.r.cost_usd !== null" class="fold4 mono mline">
                  ${{ row.r.cost_usd.toFixed(2) }}
                </span>
              </div>
            </td>

            <td class="p2">
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
            <td class="mono p3" v-bind="tip.hover(`ag-eta-${row.uid}`, etaTip)">
              {{ row.elapsed }}
              <div v-if="row.phaseClock" class="sub truncate">{{ row.phaseClock }}</div>
              <div v-else-if="row.eta !== fmt.NO_DATA" class="sub">{{ row.eta }} left</div>
            </td>

            <!-- What this attempt cost, which the totals panel cannot show:
                 today's five rounds span $2.47 to $17.94 and an expensive
                 failure is invisible in a daily sum. Display only, never a
                 series. -->
            <td class="r mono p4">
              {{ row.r.cost_usd === null ? fmt.NO_DATA : `$${row.r.cost_usd.toFixed(2)}` }}
            </td>

            <td class="out p4">
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

/* --t-mono-xl, which tokens.css describes as "the one headline reading" and
   which nothing consumed until now. One per view is the whole point of it. */
.reading {
  font: var(--t-mono-xl);
  color: var(--fg);
}

/* CAPPED, because a 4px track drawn across 1280px of panel stops reading as a
   measure and starts reading as the hairline rule two elements below it. 460px
   is about where the fill's proportion is still legible at a glance. */
.lead-bar {
  margin-top: 11px;
  max-width: 460px;
}

.lead-sub {
  margin-top: 7px;
  font: var(--t-mono-sm);
  color: var(--fg-5);
}

/* PACKED LEFT AT CONTENT WIDTH, NOT STRETCHED. Three facts across a 1300px
   panel as equal columns is what made the old header read as five unrelated
   readings; wrapping is also the whole of its phone layout. */
.conds {
  display: flex;
  flex-wrap: wrap;
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

/* --- the board ----------------------------------------------------------- */

/* The title leads the cell, so it is the cell's own voice rather than a
   caption under a chip: --fg-2 rather than --fg-4, at the body size. */
.tsummary {
  font: var(--t-ui-sm);
  color: var(--fg-2);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

/* ONE WRAPPING LINE THAT GAINS ITEMS AS COLUMNS LEAVE. 12px between items and
   nothing drawn: the items are self-labelling and a drawn separator would have
   to know which of its neighbours is currently displayed. */
.meta {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 5px 12px;
  margin-top: 6px;
}

.mline {
  font: var(--t-mono-xs);
  color: var(--fg-5);
}

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

/* --- the wrapper that must not cost a gap when it is empty -----------------
   The pr/branch chip has to be wrapped in an element - a class on a ChipLink
   loses to that component's own scoped `.chip` - but an empty wrapper is still
   a flex item of .meta, and it opened 12px between two visible things on every
   row whose round has no branch yet. `display: contents` makes the chip itself
   the flex item and leaves nothing behind when there is no chip.

   INSIDE THE RUNG ONLY. Above it, base.css's `.fold4 { display: none }` is
   what has to win, and this selector is three classes to its one. */
@media (max-width: 1180px) {
  .meta .fwrap {
    display: contents;
  }
}

/* --- the tablet: the fixed columns have to give the task room --------------
   DROPPING TWO COLUMNS AT 900 IS NOT ENOUGH ON ITS OWN. Four remained - 168 +
   282 + 140 of FIXED width against one flexible one - so an 834px tablet left
   the task column 162px, which is the same twenty characters of a sentence the
   phone had, at more than twice the width. And it got worse below 834, with
   nothing on the ladder between here and 640 to catch it.

   SO TIME LEAVES AT THIS RUNG TOO, AND IT IS THE RIGHT ONE TO LOSE. It is the
   narrowest column and the one most often empty - the ETA half is withheld
   entirely below five samples of any remaining phase - and its other half,
   elapsed, is one more item on the meta line. Phase stays: the progress bar is
   the round's only picture of itself. 168 + 200 leaves the task 384px at 834
   and 272px at 700, where it had 138.

   The phase cell's own sub line truncates at 200px where it did not at 282.
   That is the trade, and it carries a title attribute. */
@media (max-width: 900px) {
  .c-phase {
    width: 200px;
  }

}

/* --- the phone: the state column folds into the task cell -------------------
   IT USED TO BE 156px OF A 328px TABLE - 48% for one word, with about 70px of
   it empty, while the task itself had 158px. That width was measured twice and
   both measurements were right about the pill; what neither asked was whether
   the COLUMN was worth its width once only two of them were left.

   The pill folds into the task cell rather than shrinking, so nothing is lost:
   it keeps its left edge, its dot, its tone and its link to the round. What
   goes is the column, and the task takes all 328px.

   (The lesson that sized it at 156 stands and is recorded in docs/known-state:
   a pill is a flex item with the default flex-shrink, so it ellipses on the
   fraction two integer readings have already rounded away.) */
@media (max-width: 640px) {
  /* The rail comes with it. --rail is set on the row, so both cells can read
     it and only the one that is first draws it. */
  .tbl td.task {
    box-shadow: inset 2px 0 0 var(--rail, transparent);
    padding-left: 12px;
  }

  .tstate {
    margin-bottom: 7px;
  }

  /* A HEADER ROW OVER ONE COLUMN NAMES NOTHING. Five of the six columns are
     gone by here and the sixth no longer holds only the task - the state pill
     folded into it - so `TASK` is a label that has stopped being true as well
     as a row of height nothing reads. */
  .tbl thead {
    display: none;
  }

  /* TWO LINES, NOT ONE. At 158px a title was ellipsed at about twenty
     characters; at 300px it is ellipsed at forty, and a round's title is a
     sentence. The clamp is FindingsPanel's, which is the only other place here
     that has to fit prose into a table cell. */
  .tsummary {
    white-space: normal;
    display: -webkit-box;
    -webkit-line-clamp: 2;
    line-clamp: 2;
    -webkit-box-orient: vertical;
  }
}

/* --- the conditions, on a phone -------------------------------------------
   PACKED-LEFT WRAPPING IS RIGHT DOWN TO ABOUT 660px AND WRONG BELOW IT.
   Measured across eight widths: the three sit on one line from 1360 all the
   way to 760, and at 640 they break 2 + 1 - intake and quota side by side,
   worktrees alone underneath. That is not a layout, it is where the row
   happened to run out: the two columns are different widths, the three labels
   stop aligning, and there is no column left to read down.

   SO ON A PHONE THE LABEL MOVES TO THE LEFT OF ITS VALUE. Three rows, one
   condition each, labels in a column of their own - which is what makes it
   scannable at the width where scanning is hardest. It costs about 16px of
   height against the ragged version and reads like a readout instead.

   The caption stays INDENTED UNDER ITS VALUE rather than spanning back under
   the label. Full width would save the worktrees caption a line, and it would
   also put a caption where the eye is looking for the next label. */
@media (max-width: 640px) {
  .conds {
    display: grid;
    grid-template-columns: max-content 1fr;
    column-gap: var(--gap);
    row-gap: 14px;
  }

  .cond {
    display: grid;
    /* The fallback is a literal because a media query cannot read a token, and
       82px is measured: WORKTREES, the longest of the three, is 73px at
       --t-label. All three rows share it, so they align on it even where
       subgrid is unavailable - subgrid is what keeps that true if the type
       scale moves, which is the failure mode a lone literal has here. */
    grid-template-columns: 82px 1fr;
    grid-template-columns: subgrid;
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
