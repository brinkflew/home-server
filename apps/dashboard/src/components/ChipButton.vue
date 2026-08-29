<script setup lang="ts">
/**
 * THE ONE CHIP ON THIS PAGE THAT DOES SOMETHING, AND THE LIMITS OF THAT.
 *
 * ChipLink beside it is still the rule: no container here may reach the podman
 * socket, so nothing restarts a unit, pulls an image or terminates a stream, and
 * every one of those affordances is a link into the owning application. What
 * this adds is narrower than it looks - it POSTs a command to the control plane
 * conduct already polls, and conduct decides what to do with it on the host.
 *
 * SO IT REPORTS "ASKED", NEVER "DONE". Windmill accepts the run and returns a
 * job id immediately; conduct applies it within its next 60-second cycle, and
 * what actually happened arrives in the next `fleet.json`. A button that went
 * green on the POST would be reporting the message rather than the outcome, and
 * on a page whose whole argument is that absent must never read as zero, that is
 * the wrong lie to tell.
 *
 * A DISABLED CHIP CARRIES ITS REASON. Same rule the link version follows: a chip
 * that lands somewhere it cannot act is worse than one that says less, so the
 * caller passes a sentence rather than a boolean.
 */
import { computed, ref, watch } from "vue";
import type { Tone } from "@/types";

const props = withDefaults(
  defineProps<{
    label: string;
    /** Null when it can be pressed; a sentence explaining why not otherwise. */
    disabled?: string | null;
    title?: string;
    tone?: Tone;
    /** Asks the fleet. Rejecting is expected and is rendered, not thrown. */
    act: () => Promise<unknown>;
    /**
     * An outstanding ask the CALLER knows about, which outlives this component.
     *
     * `asked` below is set by a press and dies with the mount, so a reload used
     * to drop it and offer the command again as though it had never been sent.
     * The caller remembers it and, crucially, works out whether it still stands
     * by comparing it with what the chip would send now - see `askAge`. Passing
     * a boolean in rather than storing it here keeps that derivation in the one
     * module fixtures/smoke.mjs can exercise.
     */
    pending?: boolean;
  }>(),
  { title: "", tone: "off", disabled: null, pending: false },
);

const busy = ref(false);
const failed = ref<string | null>(null);
const pressed = ref(false);

/** Asked in this mount, or asked in a previous one and still outstanding. */
const asked = computed(() => pressed.value || props.pending);

// WHAT THIS CHIP KNOWS EXPIRES, AND THE LABEL IS WHAT SAYS SO. `asked` used to
// be set once and never cleared, so a chip that had worked read `asked` for the
// rest of the page's life - including after the next `fleet.json` flipped its
// label from `arm` to `disarm`, at which point the button no longer named what
// pressing it would do. That is the defect `intakeSwitch()` exists to prevent,
// reappearing one component further down.
//
// THE LABEL IS THE TRIGGER AND A TIMER WOULD BE THE WRONG ONE. The label changes
// exactly when the fleet has been observed doing the thing, so `asked` stands
// for precisely as long as it is the most that is known. If conduct refused, the
// label never changes and the chip goes on saying `asked`, which is still true.
watch(
  () => props.label,
  () => {
    pressed.value = false;
    failed.value = null;
  },
);

/**
 * WHAT IT SAYS WHILE WAITING, AND WHY IT NO LONGER PROMISES A MINUTE.
 *
 * Sixty seconds is `POLL_SEC`, the sleep BETWEEN conduct's cycles - not the
 * length of one. A cycle that dispatches a phase blocks for as long as the
 * phase, which is a median of 26 minutes for dev and a 90-minute ceiling. This
 * chip told people a minute; a disarm on 2026-08-28 took 33m 47s.
 *
 * conduct now answers intake and holds from inside the phase wait, so the
 * ordinary case really is seconds. `restart` is the one that still waits for a
 * phase boundary, deliberately, and it is the one this sentence must not
 * over-promise for.
 */
const askedTitle =
  "asked - conduct answers intake and holds within about fifteen seconds. A restart waits " +
  "for the phase in flight to end, because it cancels a flow";

async function press(): Promise<void> {
  if (busy.value || props.disabled) return;
  busy.value = true;
  failed.value = null;
  try {
    await props.act();
    pressed.value = true;
  } catch (error) {
    // SHOWN ON THE CHIP RATHER THAN THROWN. An unauthorised route, an
    // unreachable control plane and a refusal all arrive here, and a page that
    // swallowed them would leave a person pressing a button that does nothing.
    failed.value = error instanceof Error ? error.message : "it did not go through";
  } finally {
    busy.value = false;
  }
}
</script>

<template>
  <button
    v-if="!disabled"
    type="button"
    class="chip mono"
    :class="[tone, { busy, failed, asked }]"
    :title="failed ?? (asked ? askedTitle : title)"
    :disabled="busy"
    @click="press"
  >
    {{ failed ? "failed" : asked ? "asked" : label }}
  </button>

  <span v-else class="chip mono disabled" :title="disabled" aria-disabled="true">
    {{ label }}
  </span>
</template>

<style scoped>
/* THE SAME BOX AS ChipLink, deliberately: a button's own display, padding,
   border and font would shift the column it shares with one. */
.chip {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  padding: var(--pad-chip);
  font: var(--t-mono-sm);
  color: var(--fg-4);
  background: var(--surface-chip);
  border: 1px solid var(--line);
  border-radius: var(--r-xs);
  white-space: nowrap;
  max-width: 100%;
  transition: color var(--dur-fast) var(--ease-standard),
    background var(--dur-fast) var(--ease-standard),
    border-color var(--dur-fast) var(--ease-standard);
}

button.chip {
  cursor: pointer;
  appearance: none;
}

button.chip:hover:not(:disabled) {
  color: var(--accent);
  background: var(--fill-hover);
  border-color: var(--accent-edge);
}

button.chip:active:not(:disabled) {
  background: var(--fill-active);
}

button.chip.busy {
  cursor: progress;
  opacity: 0.6;
}

button.chip.asked {
  color: var(--ok);
  border-color: var(--ok-edge);
}

button.chip.failed {
  color: var(--fail);
  border-color: var(--fail-edge);
}

.disabled {
  color: var(--fg-dim);
  border-color: var(--line-faint);
  cursor: not-allowed;
}
</style>
