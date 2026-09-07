<script setup lang="ts">
/**
 * What the phase said it did, read rather than dumped.
 *
 * IT WAS A JSON STRING IN A `<pre>`. `report.verdict` is what the phase answered
 * under `--json-schema`, and the panel showed `{"status": "done", "title": ...}`
 * under a heading promising an account of the run.
 *
 * THE THREE OUTCOMES ARE src/verdict.ts's AND ARE conduct's OWN. Absent gets a
 * sentence saying it is absent, because hiding a missing signal hides that it is
 * missing; an answer that did not parse is shown verbatim, because the pinned
 * CLI can retract structured output and that text is then the phase's only
 * account; a parsed one is labelled sections.
 *
 * NOTHING HERE IS EVIDENCE AND THE PANEL SAYS SO, which is the sentence
 * conduct/card.py puts above the same reading: the verification read none of it,
 * and a verdict rendered beside a commit count will be taken to have the same
 * standing unless the difference is stated where it is read.
 */
import { computed } from "vue";

import StatePill from "@/components/StatePill.vue";
import { parseVerdict } from "@/verdict";
import type { Tone } from "@/types";

const props = defineProps<{ raw: string | null }>();

const view = computed(() => parseVerdict(props.raw));

/** The four schemas grade themselves with one word. `blocked` is the only one
 *  that stops a round, so it is the only one that is not neutral. */
function statusTone(status: string | null): Tone {
  if (status === "blocked") return "fail";
  if (status === "findings" || status === "partial") return "warn";
  if (status === "done" || status === "clean") return "ok";
  return "off";
}

/** error / warning / note, which is the one list carrying a severity. */
function findingTone(severity: string | null): Tone {
  if (severity === "error") return "fail";
  if (severity === "warning") return "warn";
  return "off";
}
</script>

<template>
  <div class="verdict">
    <p class="caveat">
      Its own account. Nothing here was verified, and the gate read none of it.
    </p>

    <p v-if="view.kind === 'absent'" class="empty mono">{{ view.text }}</p>

    <template v-else-if="view.kind === 'raw'">
      <p class="empty mono">
        The phase did not answer in the schema it was given, so this is its final
        message verbatim.
      </p>
      <pre class="raw mono">{{ view.text }}</pre>
    </template>

    <template v-else>
      <p class="lead">
        <StatePill
          :label="view.status ?? 'no status'"
          :tone="statusTone(view.status)"
          size="sm"
        />
        <span class="summary">{{ view.summary ?? "no summary" }}</span>
      </p>

      <dl v-if="view.fields.length" class="fields">
        <template v-for="(f, i) in view.fields" :key="i">
          <dt class="label">{{ f.label }}</dt>
          <dd>
            <span v-if="f.kind === 'text'" class="val">{{ f.text }}</span>

            <ul v-else-if="f.kind === 'list'" class="items">
              <li v-for="(item, j) in f.items" :key="j" class="val">{{ item }}</li>
            </ul>

            <!-- THE ONE LIST WITH A SEVERITY, and it decides something:
                 dispatch.blocking() selects error and warning out of exactly
                 this shape, so it is what sends a round back for another
                 attempt. Worth a colour; the other lists are not. -->
            <ul v-else class="items">
              <li v-for="(item, j) in f.items" :key="j" class="finding">
                <StatePill
                  :label="item.severity ?? 'note'"
                  :tone="findingTone(item.severity)"
                  size="sm"
                />
                <span class="val">
                  {{ item.title }}
                  <span v-if="item.where" class="where mono">{{ item.where }}</span>
                  <span v-if="item.detail" class="detail">{{ item.detail }}</span>
                </span>
              </li>
            </ul>
          </dd>
        </template>
      </dl>
    </template>
  </div>
</template>

<style scoped>
.caveat {
  margin: 0 0 12px;
  font: var(--t-ui-sm);
  color: var(--fg-5);
  font-style: italic;
}

.lead {
  display: flex;
  align-items: baseline;
  gap: var(--gap-sm);
  margin: 0 0 12px;
  flex-wrap: wrap;
}

.summary {
  font: var(--t-ui-md);
  color: var(--fg-2);
  min-width: 0;
}

/* A label and the value it names, which is what this is. Two columns above the
   fold and stacked below it, like the round's own facts. */
.fields {
  display: grid;
  grid-template-columns: 168px minmax(0, 1fr);
  gap: 10px var(--gap-lg);
  margin: 0;
  padding-top: 12px;
  border-top: 1px solid var(--border-divider);
}

.fields dt {
  font: var(--t-label);
  color: var(--fg-5);
  letter-spacing: var(--track-label);
  text-transform: uppercase;
}

.fields dd {
  margin: 0;
  min-width: 0;
}

.val {
  font: var(--t-ui-sm);
  color: var(--fg-3);
  line-height: 1.5;
  overflow-wrap: anywhere;
}

/* THE GLOBAL RESET STRIPS THE MARKER, and these are real lists: base.css sets
   `list-style: none` on every ul, correctly, because every other list in this
   application is a rack or a strip. Concerns and follow-ups are prose items and
   read as an unexplained indent without one. Same trap as MarkdownBody's. */
.items {
  margin: 0;
  padding-left: 18px;
  list-style: disc;
}

.items li::marker {
  color: var(--fg-5);
}

/* Except the findings, which lead with their own severity pill - a bullet in
   front of that is two markers for one item. */
.items li.finding {
  list-style: none;
}

.items li {
  margin-bottom: 5px;
}

.finding {
  display: flex;
  align-items: baseline;
  gap: var(--gap-sm);
  list-style: none;
  margin-left: -18px;
}

.where {
  display: block;
  font: var(--t-mono-xs);
  color: var(--fg-5);
}

.detail {
  display: block;
  margin-top: 2px;
  color: var(--fg-4);
}

.raw {
  margin: 0;
  padding: 11px 13px;
  max-height: 420px;
  overflow: auto;
  font: var(--t-mono-sm);
  color: var(--fg-3);
  white-space: pre-wrap;
  overflow-wrap: anywhere;
  background: var(--surface-card-inset);
  border-radius: var(--r-sm);
}

.empty {
  font: var(--t-mono-sm);
  color: var(--fg-dim);
  padding: 4px 0 8px;
}

@media (max-width: 640px) {
  .fields {
    grid-template-columns: minmax(0, 1fr);
    gap: 4px;
  }

  .fields dt {
    margin-top: 8px;
  }
}
</style>
