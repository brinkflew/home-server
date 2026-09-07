<script setup lang="ts">
/**
 * The chips that act on one round, and the memory of what was asked.
 *
 * A COMPONENT BECAUSE IT IS DRAWN TWICE. The board's row and the round's own
 * page both offer these, and the last time this application drew one control in
 * two places the two drawings disagreed about a tone that no fixture carried.
 * Here the disagreement would be worse than a colour: a chip reading `cancel`
 * that sent `restart`.
 *
 * NOTHING IS DECIDED HERE. `roundControls` in src/control.ts decides what is
 * offered and why each disabled one is disabled, because `fixtures/smoke.mjs`
 * cannot reach a single-file component and that decision is the one worth
 * testing. This draws the list and posts the action the offer names - never one
 * re-derived from a label.
 *
 * THE ASK IS REMEMBERED THE WAY THE INTAKE SWITCH'S IS, WITH A DIFFERENT CLOCK.
 * `askAge` retires a memory when the chip's action FLIPS, which works for
 * hold/release and spend/pace and for nothing here: a restart chip says
 * `restart` before and after. `offerStands` keys on the offer disappearing
 * instead - conduct carrying out a cancel closes the round, which empties this
 * list; a resume re-opens it, which drops `resume` - so the evidence is still
 * the fleet being SEEN to do the thing, never a timer.
 */
import { computed, ref, watch } from "vue";

import ChipButton from "@/components/ChipButton.vue";
import { control } from "@/api/control";
import type { ControlAction } from "@/api/control";
import { offerStands, type ControlOffer, type RememberedAsk } from "@/control";
import { useFleetStore } from "@/stores/fleet";
import { useHostStore } from "@/stores/host";
import type { FleetRound } from "@/types";

const props = defineProps<{
  round: FleetRound;
  offers: ControlOffer[];
  /**
   * Draw only the primary offers.
   *
   * WHAT IT DROPS IS DECLARED ON THE OFFER, not decided here - see
   * `ControlOffer.primary`. Three chips fit one line of the board's column;
   * four wrapped onto a second and made every row of the table 130px tall,
   * which is a list nobody can scan.
   */
  compact?: boolean;
}>();

const shown = computed(() => (props.compact ? props.offers.filter((o) => o.primary) : props.offers));

const fleet = useFleetStore();
const host = useHostStore();

/**
 * What this browser last asked for THIS ROUND, across a reload.
 *
 * KEYED ON THE ROUND AND NOT THE LANE, because a worktree is reused: a restart
 * asked for on the round that has since been replaced must not read as an
 * outstanding ask on its successor. The key is the same pair conduct is sent.
 */
const askKey = computed(
  () => `home-server.ask.round:${props.round.worktree_id}:${props.round.odoo_task ?? "none"}`,
);

function readAsk(key: string): RememberedAsk | null {
  try {
    const raw = sessionStorage.getItem(key);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<RememberedAsk>;
    // SHAPE-CHECKED, because this outlives a deploy: a value written by an
    // older bundle must read as no memory rather than throw here.
    return typeof parsed?.at === "number" && typeof parsed?.action === "string"
      ? { action: parsed.action as ControlAction, at: parsed.at }
      : null;
  } catch {
    return null;
  }
}

const remembered = ref<RememberedAsk | null>(readAsk(askKey.value));
watch(askKey, (key) => {
  remembered.value = readAsk(key);
});

/** Seconds the ask has stood, or null once the offer it named has gone. */
const askedFor = computed(() => offerStands(remembered.value, props.offers, host.now));

function pending(action: ControlAction): boolean {
  return askedFor.value !== null && remembered.value?.action === action;
}

/** What each chip promises, in the order conduct does it. */
const TITLES: Record<string, string> = {
  hold: "stop dispatching this round - the phase running now finishes first",
  release: "start dispatching this round again",
  restart:
    "close this round, cancel its flow, and start it again from the beginning with the same task",
  resume:
    "start this round again, skipping the phases it already finished. The gate and the squash always run",
  cancel:
    "cancel the flow, close the round, close the pull request it opened, and release its worktree. The task keeps its stage and gets a note",
  cancel_requeue:
    "everything cancel does, and move the task back to Pending so the fleet can choose it again",
};

/** Red on the two that destroy something, and on nothing else. */
function tone(action: ControlAction): "warn" | "off" {
  return action === "cancel" || action === "cancel_requeue" ? "warn" : "off";
}

function act(offer: ControlOffer): () => Promise<void> {
  return async () => {
    // THE ACTION COMES OFF THE OFFER, never off the label. src/control.ts pairs
    // them in one branch precisely so a chip cannot send its neighbour's
    // command, and re-deriving one from the other here would undo that.
    await control({
      action: offer.action,
      target: offer.target ?? undefined,
      // BOTH HALVES OF THE ROUND'S IDENTITY. conduct refuses the four
      // destructive actions without the task id rather than guessing which
      // round on a reused lane was meant.
      odoo_task: props.round.odoo_task,
    });
    // AFTER THE POST AND ONLY ON SUCCESS. A command that never reached Windmill
    // is not outstanding, it failed, and the chip says so itself.
    remembered.value = { action: offer.action, at: Math.floor(Date.now() / 1000) };
    try {
      sessionStorage.setItem(askKey.value, JSON.stringify(remembered.value));
    } catch {
      // A private window. The in-memory ref still carries it for this mount.
    }
    // ASKED, NOT DONE. conduct applies it on its next cycle - and a restart or
    // a cancel waits for the phase in flight to end, because both cancel a
    // flow. The next document is the honest way to learn what happened.
    await fleet.refresh();
  };
}
</script>

<template>
  <!-- `data-noclick` IS READ BY THE ROW, which navigates on any click that did
       not land on a control. A chip that is DISABLED renders as a span rather
       than a button, so it would otherwise fall through to the row and open the
       round - a disabled control that quietly does something else. -->
  <span v-if="shown.length" class="acts" :class="{ compact }" data-noclick>
    <ChipButton
      v-for="offer in shown"
      :key="offer.action"
      :label="offer.label"
      :tone="tone(offer.action)"
      :disabled="offer.disabled"
      :pending="pending(offer.action)"
      :title="TITLES[offer.action] ?? offer.label"
      :act="act(offer)"
    />
  </span>
</template>

<style scoped>
.acts {
  display: flex;
  flex-wrap: wrap;
  gap: var(--gap-sm);
  min-width: 0;
}

/* Inside a table cell the chips wrap into the column's own width rather than
   widening it - `.tbl` is table-layout: fixed, and one nowrap row of six chips
   is exactly what that layout cannot absorb. */
.acts.compact {
  gap: 5px;
}
</style>
