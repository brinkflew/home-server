<script setup lang="ts">
/**
 * One turn of a phase's conversation.
 *
 * A CONVERSATION HAS SIDES AND THIS ONE DID NOT. Every turn was a 68px label in
 * the left column and its payload in the right, whatever it was: the prompt, an
 * assistant's prose, a tool call's JSON and a refused permission all in one
 * ladder. What is actually there is a person's instruction, the phase answering,
 * and the phase's working - three different things that read best when they do
 * not look alike.
 *
 * THE PROMPT IS COLLAPSED AND NOTHING ELSE IS. A plan prompt is thousands of
 * bytes of task description and repository rules; it is the one turn a reader
 * scrolls past to reach the answer, and also the one they occasionally need in
 * full. Six lines and a toggle.
 *
 * THE DISCLOSURE IS THE INPUT VERBATIM. `describeTurn` reduces a tool call to a
 * line, and a reduction that could not be checked against what was actually sent
 * would be this page asserting something about a run rather than showing it.
 */
import { computed, ref } from "vue";

import MarkdownBody from "@/components/MarkdownBody.vue";
import { describeTurn } from "@/transcript";
import type { RoundTurn } from "@/types";

const props = defineProps<{ turn: RoundTurn }>();

const view = computed(() => describeTurn(props.turn));

const open = ref(false);
const expanded = ref(false);

/** Roughly six lines. Cheap, and the clamp does the exact work in CSS. */
const LONG = 400;
const long = computed(() => (view.value.body?.length ?? 0) > LONG);
</script>

<template>
  <div class="turn" :class="view.who">
    <!-- THE PROMPT, ON THE OTHER SIDE. It is the only turn here somebody else
         wrote, and giving it its own ground is what makes the ladder read as a
         conversation rather than as a log with a label column. -->
    <template v-if="view.who === 'you'">
      <p class="who mono">prompt</p>
      <div class="said ask" :class="{ clamped: long && !expanded }">{{ view.body }}</div>
      <button v-if="long" type="button" class="more mono" @click="expanded = !expanded">
        {{ expanded ? "show less" : "show all" }}
      </button>
    </template>

    <!-- THE PHASE'S OWN PROSE, through the same renderer as the card: it is
         markdown, and it was being shown with its syntax in it. -->
    <MarkdownBody v-else-if="view.who === 'agent'" :source="view.body ?? ''" class="said" />

    <p v-else-if="view.who === 'note'" class="note mono">{{ view.headline }}</p>

    <!-- A TOOL CALL OR A REFUSAL: one line, and everything else behind a
         disclosure. Both are the phase's working rather than its answer, so
         they are quieter than the prose above them - but a refusal keeps its
         colour, because it is the fleet's own record of a boundary holding. -->
    <template v-else>
      <div class="call">
        <span v-if="view.tool" class="tool mono">{{ view.tool }}</span>
        <span class="headline mono">{{ view.headline }}</span>
        <button
          v-if="view.detail"
          type="button"
          class="more mono"
          :aria-expanded="open"
          @click="open = !open"
        >
          {{ open ? "less" : "more" }}
        </button>
      </div>

      <pre v-if="view.diff && view.diff.length" class="diff mono"><span
        v-for="(line, i) in view.diff"
        :key="i"
        class="dline"
        :class="line.sign === '+' ? 'add' : 'del'"
      >{{ line.sign }} {{ line.text }}
</span><span v-if="view.diffMore" class="dmore">... {{ view.diffMore }} more line(s)</span></pre>

      <pre v-if="open && view.detail" class="detail mono">{{ view.detail }}</pre>
    </template>
  </div>
</template>

<style scoped>
.turn {
  min-width: 0;
}

.who {
  margin: 0 0 4px;
  font: var(--t-mono-xs);
  color: var(--fg-5);
  text-transform: uppercase;
  letter-spacing: var(--track-label);
}

.said {
  min-width: 0;
  overflow-wrap: anywhere;
}

/* THE PROMPT'S OWN GROUND, inset from the right so the two sides of the
   conversation are told apart by position as well as by colour - which is what
   a reader scanning for "where did the phase start answering" is looking for. */
.ask {
  padding: 9px 11px;
  box-sizing: content-box;
  font: var(--t-ui-sm);
  color: var(--fg-4);
  white-space: pre-wrap;
  line-height: 1.5;
  background: var(--surface-sunken);
  border-radius: var(--r-sm);
}

/* A HEIGHT, NOT `line-clamp`. The prompt is `white-space: pre-wrap` and carries
   blank lines, and the two together left the clamp's ellipsis on one line and
   the NEXT line bleeding out under the toggle - which reads as a rendering
   fault rather than as a fold. Six lines of the declared line-height cuts at a
   line boundary whatever the content does, and the fade says there is more
   above the button that says so. */
.clamped {
  position: relative;
  max-height: calc(6 * 1.5em);
  overflow: hidden;
}

.clamped::after {
  content: "";
  position: absolute;
  inset: auto 0 0;
  height: 1.5em;
  background: linear-gradient(transparent, var(--surface-sunken));
  pointer-events: none;
}

.more {
  margin-top: 5px;
  padding: 0;
  font: var(--t-mono-xs);
  color: var(--accent);
  background: none;
  border: 0;
  cursor: pointer;
}

.more:hover {
  color: var(--accent-hover);
}

/* --- the working --------------------------------------------------------- */

.call {
  display: flex;
  align-items: baseline;
  gap: var(--gap-sm);
  min-width: 0;
}

.tool {
  flex: none;
  padding: 1px 6px;
  font: var(--t-mono-xs);
  color: var(--fg-4);
  background: var(--surface-chip);
  border-radius: var(--r-xs);
}

.headline {
  min-width: 0;
  overflow: hidden;
  font: var(--t-mono-sm);
  color: var(--fg-4);
  text-overflow: ellipsis;
  white-space: nowrap;
}

.denied .headline,
.denied .tool {
  color: var(--warn);
}

.note {
  margin: 0;
  font: var(--t-mono-xs);
  color: var(--fg-5);
  font-style: italic;
}

/* --- the diff ------------------------------------------------------------ */

/* SCROLLED RATHER THAN WRAPPED, like the gate tail: code is column-aligned and
   re-flowing it destroys the alignment that makes a change readable. */
.diff {
  margin: 6px 0 0;
  padding: 7px 9px;
  overflow-x: auto;
  font: var(--t-mono-xs);
  white-space: pre;
  background: var(--surface-sunken);
  border-radius: var(--r-sm);
}

.dline {
  display: block;
}

/* THE TINTS ALREADY IN tokens.css, not diff colours of this page's own. Two
   greens and two reds in one application is how a status vocabulary stops
   meaning anything. */
.add {
  color: var(--ok);
  background: var(--ok-tint);
}

.del {
  color: var(--fail-text);
  background: var(--fail-tint);
}

.dmore {
  display: block;
  color: var(--fg-5);
}

.detail {
  margin: 6px 0 0;
  padding: 7px 9px;
  max-height: 240px;
  overflow: auto;
  font: var(--t-mono-xs);
  color: var(--fg-5);
  white-space: pre-wrap;
  overflow-wrap: anywhere;
  background: var(--surface-sunken);
  border-radius: var(--r-sm);
}
</style>
