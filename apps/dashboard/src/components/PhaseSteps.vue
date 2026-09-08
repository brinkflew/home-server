<script setup lang="ts">
/**
 * A round's phases as a rail of steps, rather than a 4px fill.
 *
 * WHAT THE BAR COULD NOT SAY. `ProgressBar` drew `done.length / phases.length`
 * as a proportion, which is a number the `done 5/5` line above it already gave
 * in full - so the picture added a shape and no information. A round has five
 * NAMED steps in a fixed order, and which one it is on is the thing a reader is
 * actually looking for.
 *
 * `ProgressBar` STAYS AND IS NOT WRAPPED. It has four other call sites - a
 * playback position, a download percentage, a phase's age against its ceiling,
 * a database against its budget - and every one of them is a genuine ratio with
 * no steps in it. Its null-versus-zero contract is right and this borrows none
 * of it: here there is no such thing as "in progress, ratio unknown", because
 * the sequence is declared.
 *
 * THE SEQUENCE TRAVELS WITH THE ROUND. `phases` is what conduct declared for
 * that flow and `done` is what it finished THIS ATTEMPT - cleared wholesale when
 * a round starts again, which is why the row prints "attempt N of 3" beside
 * this. A round carrying no sequence draws nothing rather than inventing five.
 *
 * THE NAMES ARE DROPPED BEFORE THE NODES ARE. Below the 900 rung the phase cell
 * is 200px, which is 40px a step - not enough for `verify` - so the labels go
 * and the `title` on each node keeps them reachable. Dropping the rail instead
 * would leave the cell holding a sentence it already prints one line up.
 */
import { computed } from "vue";
import type { Tone } from "@/types";

const props = withDefaults(
  defineProps<{
    /** The full sequence, in flow order. Empty draws nothing. */
    phases: string[];
    /** What this attempt has finished. Order is not read; membership is. */
    done: string[];
    /** The phase in flight, or null. Only meaningful while `live`. */
    current?: string | null;
    /** `done 5/5`, built by roundboard.phaseLabel so the two cannot disagree. */
    label?: string | null;
    tone?: Tone;
    live?: boolean;
    /** Print the phase names under the rail. Off inside a narrow table cell. */
    names?: boolean;
  }>(),
  { current: null, label: null, tone: "off", live: false, names: true },
);

interface Step {
  name: string;
  /** `done` a finished phase, `at` the one in flight, `todo` the rest. */
  state: "done" | "at" | "todo";
}

const steps = computed<Step[]>(() => {
  const finished = new Set(props.done ?? []);
  return (props.phases ?? []).map((name) => {
    if (finished.has(name)) return { name, state: "done" as const };
    // AT, NOT MERELY UNFINISHED. `current` is the round's own phase and it is
    // trusted only while something is actually running: a closed round names
    // the phase it stopped in, and drawing that as in-flight would say the
    // fleet is still working on a round that ended.
    if (props.live && name === props.current) return { name, state: "at" as const };
    return { name, state: "todo" as const };
  });
});
</script>

<template>
  <div v-if="steps.length" class="steps" :class="[tone, { named: names }]">
    <p v-if="label" class="head mono">{{ label }}</p>
    <ol class="rail" :aria-label="label ?? 'phases'">
      <li v-for="(step, i) in steps" :key="step.name" class="step" :class="step.state">
        <!-- THE SEGMENT BEFORE THE NODE, so the first step has none and the
             rail cannot end in a line going nowhere. It is filled when the step
             it leads INTO has been reached, which is what makes the rail read
             left to right rather than as a row of unrelated dots. -->
        <span v-if="i > 0" class="seg" aria-hidden="true" />
        <span class="node" :title="step.name" />
        <span v-if="names" class="name mono">{{ step.name }}</span>
      </li>
    </ol>
  </div>
</template>

<style scoped>
.steps {
  min-width: 0;
}

.head {
  margin: 0 0 6px;
  font: var(--t-mono-sm);
  color: var(--fg-3);
}

/* EQUAL SEGMENTS, WHICH IS NOT THE SAME AS EQUAL COLUMNS - and equal columns is
   what the first version drew. Every step is a segment then its node, so an
   equal share for all five puts node 1 at the LEFT of its share and node 2 at
   the RIGHT of the next: the first gap is nearly two shares wide and the rest
   are one. It read as a dot that had come loose from the rail.
   
   The first step carries no segment, so it takes only the width of its own node
   and the four segments after it divide what is left. */
.rail {
  display: flex;
  align-items: flex-start;
  margin: 0;
  padding: 0;
  list-style: none;
}

.step {
  display: grid;
  grid-template-columns: minmax(0, 1fr) auto;
  align-items: center;
  flex: 1 1 0;
  min-width: 0;
}

/* THE FIRST STEP IS ITS NODE AND NOTHING ELSE, which is what makes the four
   gaps equal: it carries no segment, so giving it an equal share would put node
   1 at the left of that share and node 2 at the right of the next, making the
   first gap nearly two shares wide. */
.step:first-child {
  flex: none;
  position: relative;
}

/* AND ITS NAME HANGS OUT OF THAT BOX. The step is nine pixels wide, so a name
   laid out inside it would ellipse to nothing; taking it out of flow lets it
   read left-to-right from the node while the four segments still divide the
   rest of the rail evenly. It cannot collide with the second name, which is
   right-aligned at the far end of its own share. */
.step:first-child .name {
  position: absolute;
  top: 100%;
  left: 0;
  justify-self: start;
  text-align: left;
  /* AND IT MUST NOT INHERIT THE 100% CEILING the other names carry, which is
     100% of a nine-pixel box: `plan` rendered as `p.`. Taking it out of flow was
     only half the fix. */
  max-width: none;
}

.seg {
  height: 2px;
  background: var(--track);
  border-radius: 999px;
}

.node {
  width: 9px;
  height: 9px;
  border-radius: 50%;
  background: var(--bg);
  box-shadow: inset 0 0 0 2px var(--track);
}

/* THE NAME HANGS UNDER ITS OWN NODE, right-aligned to it, so a label always
   sits with the step it names rather than drifting toward the next one. */
.name {
  grid-column: 1 / -1;
  justify-self: end;
  margin-top: 5px;
  max-width: 100%;
  overflow: hidden;
  font: var(--t-mono-xs);
  color: var(--fg-5);
  text-align: right;
  text-overflow: ellipsis;
  white-space: nowrap;
}

/* --- reached ------------------------------------------------------------- */

/* THE TONE IS THE ROUND'S, not a colour of this component's own. A stopped
   round's finished steps are red because the round is red: they are the steps
   it got through before it stopped, and drawing them green would be the picture
   disagreeing with the pill beside it. */
.done .node,
.at .node {
  background: var(--tone);
  box-shadow: none;
}

.done .seg,
.at .seg {
  background: var(--tone);
}

.done .name,
.at .name {
  color: var(--fg-3);
}

/* THE ONE IN FLIGHT IS A RING RATHER THAN A DISC, and it breathes. A filled
   node means finished; this one has been reached and is not done, which is a
   third state and needs a third shape - colour alone would not carry it for a
   reader who cannot see the difference. */
.at .node {
  background: var(--bg);
  box-shadow: inset 0 0 0 3px var(--tone);
  animation: pulse var(--loop-pulse) var(--ease-standard) infinite;
}

.at .name {
  color: var(--fg-2);
}

.ok {
  --tone: var(--ok);
}

.warn {
  --tone: var(--warn);
}

.fail {
  --tone: var(--fail);
}

.off {
  --tone: var(--off);
}
</style>
