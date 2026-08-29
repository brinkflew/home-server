<script setup lang="ts">
/**
 * One round: what it did, and the one question it stops to ask.
 *
 * IT WAS AN EXPANDER INSIDE A TABLE ROW. The approval card alone is around
 * 7,500 bytes of prose - the text somebody is actually approving - and it sat
 * in a full-width sibling row under the board, above the phase transcripts and
 * the event log, all of it scrolling inside boxes inside a row. A round is a
 * page, and being a page gives it the thing an expander could never have: a URL
 * a person can send themselves before they answer a gate.
 *
 * SO THE HOST RENDERS AND THIS DRAWS. Everything below arrives already
 * redacted; nothing here is responsible for hiding anything, and nothing here
 * should start trying to, because a guard in a browser is one an attacker has
 * already got past.
 *
 * FETCHED ON ARRIVAL, NEVER POLLED. See src/api/round.ts - these are ~400 KB
 * each and there are forty of them.
 *
 * FOUR ABSENCES, AND THEY ARE FOUR DIFFERENT SENTENCES. A deep link makes three
 * of them reachable that the expander never could:
 *   - fleet.json has not been read yet: "reading", not "absent".
 *   - the round is not on the board at all: aged out, or a merged round the
 *     board hides. The document still renders; the row's own fields do not.
 *   - the document 404s: "not yet". The collector renders a few phase logs a
 *     pass so a cold start converges.
 *   - a phase with `rendered: false`: its own reason, because a phase waiting
 *     its turn must not read as a phase that said nothing.
 */
import { computed, ref, watch } from "vue";
import { useRoute } from "vue-router";

import Band from "@/components/Band.vue";
import PanelBox from "@/components/PanelBox.vue";
import StatusDot from "@/components/StatusDot.vue";
import StatePill from "@/components/StatePill.vue";
import ChipLink from "@/components/ChipLink.vue";
import ChipButton from "@/components/ChipButton.vue";
import ProgressBar from "@/components/ProgressBar.vue";

import { DocumentNeverWritten } from "@/api/document";
import { fetchRound, roundKey } from "@/api/round";
import { approve as sendApprove } from "@/api/approve";
import type { ApproveDecision } from "@/api/approve";
import { control } from "@/api/control";
import { useHostStore } from "@/stores/host";
import { useFleetStore } from "@/stores/fleet";
import { boardRow } from "@/roundboard";
import type { RoundDocument, RoundPhase, Tone } from "@/types";
import * as fmt from "@/format";

const route = useRoute();
const host = useHostStore();
const fleet = useFleetStore();

const key = computed(() => String(route.params.key ?? ""));

/** The board's own row for this round, or null if the board does not carry it. */
const row = computed(() => {
  const found = fleet.rounds.find((r) => roundKey(r.worktree_id, r.started_at) === key.value);
  if (!found) return null;
  return boardRow(found, {
    now: host.now,
    generatedAt: fleet.generatedAt,
    phaseStats: fleet.phaseStats,
    runs: fleet.doc?.runs ?? [],
    control: fleet.control,
  });
});

/** fleet.json has not answered yet, which is not the same as "not on the board". */
const fleetUnread = computed(() => fleet.doc === null && !fleet.neverRun);

// --- the document ------------------------------------------------------------

const doc = ref<RoundDocument | null>(null);
const missing = ref(false);
const error = ref<string | null>(null);
const loading = ref(false);
let inflight: AbortController | null = null;

async function load(id: string): Promise<void> {
  inflight?.abort();
  inflight = new AbortController();
  loading.value = true;
  missing.value = false;
  error.value = null;
  try {
    doc.value = await fetchRound(id, inflight.signal);
  } catch (caught) {
    if (caught instanceof DocumentNeverWritten) {
      // NOT AN ERROR. The collector renders a few logs per pass so a cold start
      // converges; a round can be on the board before its turn comes round.
      missing.value = true;
    } else if ((caught as Error)?.name !== "AbortError") {
      error.value = (caught as Error)?.message ?? "the round document could not be read";
    }
  } finally {
    loading.value = false;
  }
}

watch(key, (id) => { if (id) void load(id); }, { immediate: true });

// --- answering the gate ------------------------------------------------------

const answered = ref<ApproveDecision | null>(null);

const waiting = computed(() => row.value?.waiting ?? false);

/** The flow job to answer. Null is why Approve is not offered, not a bug. */
const jobId = computed(() => doc.value?.round.flow_job_id ?? row.value?.r.flow_job_id ?? null);

const cannot = computed<string | null>(() => {
  if (!fleet.control.approve_available) {
    return "the approve route has no token - see WINDMILL_APPROVE_TOKEN";
  }
  if (!jobId.value) return "no flow job is recorded for this round, so there is nothing to answer";
  return null;
});

function act(decision: ApproveDecision): () => Promise<unknown> {
  return async () => {
    const id = jobId.value;
    if (!id) throw new Error("no flow job to answer");
    await sendApprove(id, decision);
    answered.value = decision;
  };
}

async function send(action: "hold" | "release" | "restart", target: string): Promise<void> {
  await control({ action, target });
  await fleet.refresh();
}

// --- phases ------------------------------------------------------------------

const phases = computed<RoundPhase[]>(() => doc.value?.phases ?? []);

/**
 * Which phase's transcript is open.
 *
 * ONE AT A TIME, AND THE LAST ONE BY DEFAULT. Every phase used to render
 * expanded and stacked - five transcripts, one of them a gate log clipped at
 * 64 KB - which is the packing this whole split exists to undo. The index is
 * the table; the transcript is one panel under it.
 */
const openPhase = ref<number | null>(null);

watch(phases, (list) => {
  if (!list.length) {
    openPhase.value = null;
    return;
  }
  if (openPhase.value !== null && list.some((p) => p.run_id === openPhase.value)) return;
  openPhase.value = list[list.length - 1].run_id;
});

const shown = computed(() => phases.value.find((p) => p.run_id === openPhase.value) ?? null);

function phaseTone(phase: RoundPhase): Tone {
  if (phase.result === null) return "off";
  return phase.result === "ok" ? "ok" : "fail";
}

function took(phase: RoundPhase): string {
  const from = fmt.isoToUnix(phase.started_at);
  const to = fmt.isoToUnix(phase.ended_at);
  if (!Number.isFinite(from) || !Number.isFinite(to)) return fmt.NO_DATA;
  return fmt.coarse(to - from);
}

function at(iso: string | null): string {
  const unix = fmt.isoToUnix(iso);
  return Number.isFinite(unix) ? fmt.stamp(unix) : fmt.NO_DATA;
}

/** How much of a phase there is to read, without opening it. */
function weight(phase: RoundPhase): string {
  if (!phase.rendered) return "not rendered";
  if (phase.gate) return fmt.bytes(phase.gate.text.length);
  if (phase.turns.length) return `${phase.turns.length} turns`;
  return "no transcript";
}
</script>

<template>
  <p class="back">
    <RouterLink to="/agents/rounds">back to the board</RouterLink>
  </p>

  <!-- THE ROUND, as the board knows it. Absent for three different reasons and
       each says which. -->
  <PanelBox label="Round" :stale="fleet.stale">
    <template #aside>
      <span class="mono">{{ key }}</span>
    </template>

    <p v-if="fleetUnread" class="empty mono">reading the fleet document...</p>

    <p v-else-if="!row" class="empty mono">
      This round is not on the board. It has either been swept - the board keeps
      the working set, not a history - or it is a merged round the board hides.
      Its own document is below and is unaffected.
    </p>

    <template v-else>
      <div class="head">
        <StatusDot :tone="row.tone" :live="row.waiting" :size="8" />
        <StatePill :label="row.state" :tone="row.tone" />
        <ChipLink
          :label="row.r.odoo_task ? `#${row.r.odoo_task}` : row.r.worktree_id"
          :href="row.r.odoo_url"
          title="open this task in the tracker"
        />
        <span class="summary">{{ row.r.summary ?? row.r.ref ?? "no branch recorded" }}</span>

        <span class="acts">
          <!-- THE CONTROLS, AND ONLY ON A ROUND THAT IS STILL RUNNING. Holding
               a finished round stops nothing and restarting one has no chain
               for conduct to close - roundControls returns an empty list rather
               than a disabled pair, because a control that could never apply is
               noise on every closed round. -->
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

      <ProgressBar :ratio="row.progress" :tone="row.tone" :live="row.moving" />

      <dl class="facts">
        <div class="fact">
          <dt class="label">phase</dt>
          <dd class="mono">
            {{ row.phase }}
            <span v-if="row.attempt !== null" class="sub">
              attempt {{ row.attempt }} of {{ row.r.max_attempts }}
            </span>
          </dd>
        </div>
        <div class="fact">
          <dt class="label">elapsed</dt>
          <dd class="mono">
            {{ row.elapsed }}
            <span v-if="row.phaseClock" class="sub">{{ row.phaseClock }}</span>
            <span v-else-if="row.eta !== fmt.NO_DATA" class="sub">{{ row.eta }} left</span>
          </dd>
        </div>
        <div class="fact">
          <dt class="label">opened</dt>
          <dd class="mono">
            {{ fmt.sinceIso(row.r.opened_at) }}
            <span v-if="row.r.held" class="sub warnish">
              held {{ fmt.sinceIso(row.r.held_at) }} -
              {{
                row.holdLeft === null || row.holdLeft <= 0
                  ? "past the timeout"
                  : `${fmt.coarse(row.holdLeft)} left`
              }}
            </span>
          </dd>
        </div>
        <div class="fact">
          <dt class="label">cost</dt>
          <dd class="mono">
            {{ row.r.cost_usd === null ? fmt.NO_DATA : `$${row.r.cost_usd.toFixed(2)}` }}
            <span class="sub">this attempt only</span>
          </dd>
        </div>
        <div class="fact">
          <dt class="label">outcome</dt>
          <dd>
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
            <span v-else-if="row.r.published && row.r.pr_state !== 'unknown'" class="mono nolink">
              opened none
            </span>
            <span v-else class="mono nolink">{{ fmt.NO_DATA }}</span>
          </dd>
        </div>
      </dl>

      <!-- conduct's own sentences, displayed and never parsed. Sometimes with a
           list of file names in them, and a reader needs all of it. -->
      <div v-if="row.error.length" class="why">
        <p v-for="(line, i) in row.error" :key="i" class="mono reason">{{ line }}</p>
      </div>
    </template>
  </PanelBox>

  <p v-if="loading && !doc" class="empty mono">reading this round...</p>

  <!-- NOT YET, AND NOT AN ERROR. Said plainly, because a person who opened a
       round and saw "failed" would go looking for a fault that is not there. -->
  <PanelBox v-else-if="missing" label="Transcript">
    <p class="empty mono">
      no document for this round yet - the collector renders a few phase logs
      each pass so a cold start converges rather than timing out. It appears
      within a few minutes, or not at all for a round old enough to have been
      swept.
    </p>
  </PanelBox>

  <PanelBox v-else-if="error" label="Transcript">
    <p class="empty mono bad">{{ error }}</p>
  </PanelBox>

  <template v-else-if="doc">
    <!-- THE CARD, AND IT IS THE POINT OF THE PAGE. The board has only ever
         shown 240 characters of the PHONE copy, which is a different and
         earlier rendering. This is the text the approval is actually of. -->
    <PanelBox v-if="doc.report && doc.report.card" label="The card">
      <template #aside>
        <span v-if="waiting" class="acts">
          <ChipButton
            label="approve"
            tone="ok"
            :disabled="cannot"
            :pending="answered === 'approve'"
            title="open the draft pull request this round is asking for"
            :act="act('approve')"
          />
          <ChipButton
            label="decline"
            :disabled="cannot"
            :pending="answered === 'decline'"
            title="cancel the flow - nothing is opened, and the branch stays on GitHub as evidence"
            :act="act('decline')"
          />
        </span>
      </template>

      <pre class="body card">{{ doc.report.card }}</pre>

      <p v-if="waiting && !cannot" class="foot mono">
        Approving opens a DRAFT pull request. Declining cancels the flow and
        opens nothing. Windmill's own run page still works and is unchanged.
      </p>
      <ChipLink
        v-if="waiting"
        label="answer in Windmill"
        :href="row?.r.link ?? null"
        title="the same gate on Windmill's own page, behind the same sign-on"
      />
    </PanelBox>

    <PanelBox v-if="doc.report && doc.report.verdict" label="What the phase said it did">
      <pre class="body">{{ doc.report.verdict }}</pre>
    </PanelBox>

    <Band label="Phases">
      <template #aside>
        <span class="count">{{ phases.length }}</span> recorded
      </template>

      <PanelBox v-if="phases.length">
        <table class="tbl">
          <thead>
            <tr>
              <th class="c-rail" />
              <th>Phase</th>
              <th class="c-res">Result</th>
              <th class="c-took r">Took</th>
              <th class="c-cost r">Cost</th>
              <th class="c-size">Transcript</th>
            </tr>
          </thead>
          <tbody>
            <tr
              v-for="p in phases"
              :key="p.run_id"
              class="hov phase-row"
              :class="{ on: p.run_id === openPhase }"
              @click="openPhase = p.run_id"
            >
              <td class="rail" :style="{ '--rail': `var(--${phaseTone(p)})` }">
                <StatusDot :tone="phaseTone(p)" :size="6" />
              </td>
              <td>
                <div class="mono pname">{{ p.phase ?? "unnamed" }}</div>
                <!-- NAMED AND NEVER LINKED. It is ten megabytes of 0600 file on
                     the host, outside anything this container can serve, so a
                     link would be an offer the page cannot keep. -->
                <div class="mono sub truncate">{{ p.log ?? "no log named" }}</div>
              </td>
              <td><StatePill :label="p.result ?? 'running'" :tone="phaseTone(p)" size="sm" /></td>
              <td class="r mono">{{ took(p) }}</td>
              <td class="r mono">
                {{ p.cost_usd === null ? fmt.NO_DATA : `$${p.cost_usd.toFixed(2)}` }}
              </td>
              <td class="mono sub">{{ weight(p) }}</td>
            </tr>
          </tbody>
        </table>
      </PanelBox>
      <PanelBox v-else>
        <p class="empty mono">no phase runs recorded for this round</p>
      </PanelBox>

      <PanelBox v-if="shown" :label="shown.phase ?? 'unnamed phase'">
        <template #aside>
          <span class="mono">{{ shown.log ?? "no log named" }}</span>
        </template>

        <p v-if="!shown.rendered" class="empty mono">
          {{ shown.short ?? "no log was identified for this run" }}
        </p>

        <!-- A GATE PHASE RUNS NO MODEL, so it has a tail and never a
             conversation. 197,160 lines on this host, of which 38 are JSON. -->
        <template v-else-if="shown.gate">
          <pre class="body gate">{{ shown.gate.text }}</pre>
          <p v-if="shown.gate.truncated" class="foot mono">
            the last {{ fmt.bytes(shown.gate.text.length) }} of
            {{ fmt.bytes(shown.gate.bytes) }}
          </p>
        </template>

        <div v-else-if="shown.turns.length" class="body turns">
          <div v-for="(turn, i) in shown.turns" :key="i" class="turn" :class="turn.kind">
            <span class="who mono">{{ turn.kind }}</span>
            <span v-if="turn.kind === 'tool'" class="said mono">
              <b>{{ turn.name }}</b>
              <span class="input">{{ turn.input }}</span>
            </span>
            <span v-else class="said">{{ turn.text }}</span>
          </div>
        </div>

        <p v-else class="empty mono">this phase produced no transcript</p>
      </PanelBox>
    </Band>

    <PanelBox label="Events">
      <div class="body events">
        <p v-for="(event, i) in doc.events" :key="i" class="event mono">
          <span class="when">{{ at(event.at) }}</span>
          <span class="what">{{ event.kind }}</span>
          <span class="rest">
            {{ event.phase ?? event.module ?? event.notice ?? "" }}
            <template v-if="event.result">{{ event.result }}</template>
            <template v-if="event.pr_number">#{{ event.pr_number }}</template>
            <template v-if="event.error"> - {{ event.error }}</template>
          </span>
        </p>
        <p v-if="!doc.events.length" class="empty mono">nothing recorded</p>
      </div>

      <p v-if="doc.clipped" class="foot mono">{{ doc.clipped }}</p>
      <p v-if="doc.report && doc.report.refused.length" class="foot mono bad">
        refused: {{ doc.report.refused.join("; ") }}
      </p>
    </PanelBox>
  </template>
</template>

<style scoped>
.back {
  font: var(--t-ui-sm);
}

.head {
  display: flex;
  align-items: center;
  gap: var(--gap-sm);
  margin-bottom: var(--gap);
  flex-wrap: wrap;
}

.summary {
  font: var(--t-ui-md);
  color: var(--fg-2);
  min-width: 0;
}

.acts {
  display: flex;
  gap: var(--gap-sm);
  margin-left: auto;
}

/* Five readings, five equal columns. A definition list because that is what
   this is - a label and the value it names. */
.facts {
  display: grid;
  grid-template-columns: repeat(5, minmax(0, 1fr));
  gap: var(--gap-lg);
  margin: var(--gap) 0 0;
}

.fact {
  min-width: 0;
}

.fact dd {
  margin: 5px 0 0;
  font: var(--t-mono-md);
  color: var(--fg-2);
}

.sub {
  display: block;
  margin-top: 3px;
  font: var(--t-mono-xs);
  color: var(--fg-5);
}

.warnish {
  color: var(--warn);
}

.why {
  margin-top: var(--gap);
  padding-top: var(--gap);
  border-top: 1px solid var(--border-divider);
  color: var(--fg-4);
  overflow-wrap: anywhere;
}

.why .reason {
  font: var(--t-mono-sm);
}

/* --- phases --------------------------------------------------------------- */

.c-rail {
  width: 30px;
}

.c-res {
  width: 116px;
}

.c-took,
.c-cost {
  width: 88px;
}

.c-size {
  width: 132px;
}

.phase-row {
  cursor: pointer;
}

.phase-row.on td {
  background: var(--fill);
}

.pname {
  font: var(--t-mono-md);
  color: var(--fg-2);
}

td.sub {
  display: table-cell;
  margin: 0;
}

/* --- transcripts ---------------------------------------------------------- */

/* SCROLLED RATHER THAN WRAPPED. A failure sentence is three lines and must be
   read whole; a transcript is a thousand and must not push the next panel off
   the page. */
.body {
  max-height: 420px;
  overflow-y: auto;
  overflow-x: auto;
  background: var(--surface-card-inset);
  border-radius: var(--r-sm);
  padding: 11px 13px;
  font: var(--t-mono-sm);
  color: var(--fg-3);
  margin: 0;
}

pre.body {
  white-space: pre-wrap;
  overflow-wrap: anywhere;
}

pre.card {
  max-height: none;
  color: var(--fg-2);
}

pre.gate {
  /* The one place wrapping is wrong: build output is column-aligned, and
     re-flowing it destroys the alignment that makes it readable. */
  white-space: pre;
  color: var(--fg-4);
}

.events {
  max-height: 320px;
}

.event {
  display: grid;
  grid-template-columns: 132px 148px minmax(0, 1fr);
  gap: var(--gap-sm);
  margin: 0 0 3px;
  color: var(--fg-4);
}

.event .what {
  color: var(--fg-3);
}

.turns {
  display: flex;
  flex-direction: column;
  gap: 9px;
}

.turn {
  display: grid;
  grid-template-columns: 68px minmax(0, 1fr);
  gap: var(--gap-sm);
  align-items: start;
}

.turn .who {
  font: var(--t-mono-xs);
  color: var(--fg-5);
  text-transform: uppercase;
  letter-spacing: 0.04em;
}

.turn .said {
  white-space: pre-wrap;
  overflow-wrap: anywhere;
}

.turn.say .said {
  color: var(--fg-2);
}

.turn.ask .said {
  color: var(--fg-4);
}

.turn.tool .input {
  display: block;
  color: var(--fg-5);
  overflow-wrap: anywhere;
}

/* A REFUSED PERMISSION IS A FINDING, not chatter: it is the fleet's own record
   of a boundary holding, and the one shape here worth a colour. */
.turn.denied .said {
  color: var(--warn);
}

.foot {
  margin-top: 10px;
  font: var(--t-mono-xs);
  color: var(--fg-5);
}

.empty {
  font: var(--t-mono-sm);
  color: var(--fg-dim);
  padding: 8px 4px;
}

.nolink {
  color: var(--fg-5);
}

.bad {
  color: var(--fail-text);
}

@media (max-width: 1180px) {
  .facts {
    grid-template-columns: repeat(2, minmax(0, 1fr));
  }
}
</style>
