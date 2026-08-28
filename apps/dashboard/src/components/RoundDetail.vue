<script setup lang="ts">
// =============================================================================
// What a round did, and the one question it stops to ask
// -----------------------------------------------------------------------------
// THE BOARD SAYS WHAT A ROUND IS; THIS SAYS WHAT IT DID. Until this existed the
// row's expander showed conduct's failure sentences and nothing else, and
// docs/dashboard.md refused to link the phase log at all - correctly, since it
// is ten megabytes of 0600 file outside anything this container can reach.
//
// SO THE HOST RENDERS AND THIS DRAWS. Everything below arrives already
// redacted; nothing here is responsible for hiding anything, and nothing here
// should start trying to, because a guard in a browser is one an attacker has
// already got past.
//
// FETCHED ON OPEN, NEVER POLLED. See src/api/round.ts.
// =============================================================================
import { computed, ref, watch } from "vue";
import ChipButton from "./ChipButton.vue";
import ChipLink from "./ChipLink.vue";
import StatePill from "./StatePill.vue";
import { DocumentNeverWritten } from "@/api/document";
import { fetchRound, roundKey } from "@/api/round";
import { approve as sendApprove } from "@/api/approve";
import type { ApproveDecision } from "@/api/approve";
import * as fmt from "@/format";
import type { FleetRound, RoundDocument, RoundPhase, Tone } from "@/types";

const props = defineProps<{
  round: FleetRound;
  /** Whether the approve route has a token. A chip that cannot act must say so
   *  rather than be drawn and then fail - this application's own rule. */
  canAct: boolean;
}>();

const doc = ref<RoundDocument | null>(null);
const missing = ref(false);
const error = ref<string | null>(null);
const loading = ref(false);
const answered = ref<ApproveDecision | null>(null);
let inflight: AbortController | null = null;

const key = computed(() => roundKey(props.round.worktree_id, props.round.started_at));

async function load(): Promise<void> {
  const id = key.value;
  if (!id) {
    error.value = "this round has no start time, so its document cannot be named";
    return;
  }
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

// Load once per key. A round that is still moving is re-read when the board
// re-reads, which is what `settled` on the document is for.
watch(key, (id) => { if (id) void load(); }, { immediate: true });

const waiting = computed(() => props.round.waiting_on === "person"
  && props.round.closed_at === null);

/** The flow job to answer. Null is why Approve is not offered, not a bug. */
const jobId = computed(() => doc.value?.round.flow_job_id ?? props.round.flow_job_id ?? null);

const cannot = computed<string | null>(() => {
  if (!props.canAct) return "the approve route has no token - see WINDMILL_APPROVE_TOKEN";
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

const phases = computed<RoundPhase[]>(() => doc.value?.phases ?? []);

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
</script>

<template>
  <div class="detail">
    <p v-if="loading && !doc" class="dim mono">reading this round...</p>

    <!-- NOT YET, AND NOT AN ERROR. Said plainly, because a person who opened a
         round and saw "failed" would go looking for a fault that is not there. -->
    <p v-else-if="missing" class="dim mono">
      no document for this round yet - the collector renders a few phase logs
      each pass so a cold start converges rather than timing out. It appears
      within a few minutes, or not at all for a round old enough to have been
      swept.
    </p>

    <p v-else-if="error" class="bad mono">{{ error }}</p>

    <template v-else-if="doc">
      <!-- THE CARD, AND IT IS THE POINT OF THE PANEL. The board has only ever
           shown 240 characters of the PHONE copy, which is a different and
           earlier rendering. This is the text the approval is actually of. -->
      <section v-if="doc.report && doc.report.card" class="block">
        <div class="head">
          <span class="label">the card</span>
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
        </div>
        <pre class="body card">{{ doc.report.card }}</pre>
        <p v-if="waiting && !cannot" class="dim mono foot">
          Approving opens a DRAFT pull request. Declining cancels the flow and
          opens nothing. Windmill's own run page still works and is unchanged.
        </p>
      </section>

      <section v-if="doc.report && doc.report.verdict" class="block">
        <span class="label">what the phase said it did</span>
        <pre class="body">{{ doc.report.verdict }}</pre>
      </section>

      <section class="block">
        <span class="label">events</span>
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
          <p v-if="!doc.events.length" class="dim mono">nothing recorded</p>
        </div>
      </section>

      <section v-for="phase in phases" :key="phase.run_id" class="block">
        <div class="head">
          <span class="label">{{ phase.phase }}</span>
          <StatePill :label="phase.result ?? 'running'" :tone="phaseTone(phase)" size="sm" />
          <span class="dim mono meta">
            {{ took(phase) }}
            <template v-if="phase.cost_usd !== null"> - ${{ phase.cost_usd.toFixed(2) }}</template>
            <template v-if="phase.log"> - {{ phase.log }}</template>
          </span>
        </div>

        <p v-if="!phase.rendered" class="dim mono">
          {{ phase.short ?? "no log was identified for this run" }}
        </p>

        <!-- A GATE PHASE RUNS NO MODEL, so it has a tail and never a
             conversation. 197,160 lines on this host, of which 38 are JSON. -->
        <pre v-else-if="phase.gate" class="body gate">{{ phase.gate.text }}</pre>
        <p v-if="phase.gate && phase.gate.truncated" class="dim mono foot">
          the last {{ fmt.bytes(phase.gate.text.length) }} of
          {{ fmt.bytes(phase.gate.bytes) }}
        </p>

        <div v-else-if="phase.turns.length" class="body turns">
          <div v-for="(turn, i) in phase.turns" :key="i" class="turn" :class="turn.kind">
            <span class="who mono">{{ turn.kind }}</span>
            <span v-if="turn.kind === 'tool'" class="said mono">
              <b>{{ turn.name }}</b>
              <span class="input">{{ turn.input }}</span>
            </span>
            <span v-else class="said">{{ turn.text }}</span>
          </div>
        </div>
        <p v-else-if="phase.rendered" class="dim mono">this phase produced no transcript</p>
      </section>

      <p v-if="doc.clipped" class="dim mono">{{ doc.clipped }}</p>
      <p v-if="doc.report && doc.report.refused.length" class="bad mono">
        refused: {{ doc.report.refused.join("; ") }}
      </p>

      <ChipLink
        v-if="waiting"
        label="answer in Windmill"
        :href="round.link"
        title="the same gate on Windmill's own page, behind the same sign-on"
      />
    </template>
  </div>
</template>

<style scoped>
.detail {
  display: flex;
  flex-direction: column;
  gap: var(--gap);
}

.block {
  display: flex;
  flex-direction: column;
  gap: 5px;
}

.head {
  display: flex;
  align-items: center;
  gap: var(--gap-sm);
}

.acts {
  display: flex;
  gap: var(--gap-sm);
  margin-left: auto;
}

.meta {
  margin-left: auto;
}

/* SCROLLED RATHER THAN WRAPPED, which is the opposite of `.why` one component
   over - and deliberately. A failure sentence is three lines and must be read
   whole; a transcript is a thousand and must not push the next round off the
   page. Same idiom as FindingsPanel's body. */
.body {
  max-height: 320px;
  overflow-y: auto;
  overflow-x: auto;
  background: var(--surface-sunken);
  border: 1px solid var(--line-faint);
  border-radius: var(--r-sm);
  padding: 9px 11px;
  font: var(--t-mono-xs);
  color: var(--fg-3);
  margin: 0;
}

pre.body {
  white-space: pre-wrap;
  overflow-wrap: anywhere;
}

pre.gate {
  /* The one place wrapping is wrong: build output is column-aligned, and
     re-flowing it destroys the alignment that makes it readable. */
  white-space: pre;
  color: var(--fg-4);
}

.events {
  max-height: 260px;
}

.event {
  display: grid;
  grid-template-columns: 108px 132px 1fr;
  gap: var(--gap-sm);
  margin: 0 0 2px;
  color: var(--fg-4);
}

.event .what {
  color: var(--fg-3);
}

.turns {
  display: flex;
  flex-direction: column;
  gap: 7px;
  max-height: 420px;
}

.turn {
  display: grid;
  grid-template-columns: 62px 1fr;
  gap: var(--gap-sm);
  align-items: start;
}

.turn .who {
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
  margin: 0;
}

.dim {
  color: var(--fg-5);
}

.bad {
  color: var(--fail-text);
}
</style>
