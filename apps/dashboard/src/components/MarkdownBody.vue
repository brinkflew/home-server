<script setup lang="ts">
/**
 * The markdown token tree, drawn.
 *
 * NO `v-html` ANYWHERE IN THIS PATH, which is the whole reason src/markdown.ts
 * returns a tree rather than a string. The card is model output; a renderer that
 * built HTML would need a sanitiser beside it and would still be one mistake
 * away from executing whatever a phase wrote, on a page behind the household's
 * passkey. Every node below is an ordinary element with text interpolated into
 * it, so there is nothing to escape and nothing to get wrong.
 *
 * THE TYPE SCALE IS THE PAGE'S. A card's `##` is not a page heading - the panel
 * label above it already says what this is - so the levels map into the body
 * range rather than starting at `--t-page`. Three levels are all `card.py`
 * writes and the fourth to sixth collapse onto the third.
 */
import { computed } from "vue";
import { parseMarkdown } from "@/markdown";

const props = defineProps<{ source: string }>();

const blocks = computed(() => parseMarkdown(props.source));
</script>

<template>
  <div class="md">
    <template v-for="(block, i) in blocks" :key="i">
      <h3 v-if="block.kind === 'heading' && block.level <= 2" class="h2">
        <template v-for="(span, j) in block.inline" :key="j">
          <code v-if="span.kind === 'code'" class="mono">{{ span.text }}</code>
          <a
            v-else-if="span.kind === 'link'"
            :href="span.href"
            target="_blank"
            rel="noopener noreferrer"
            >{{ span.text }}</a
          >
          <b v-else-if="span.kind === 'strong'">{{ span.text }}</b>
          <i v-else-if="span.kind === 'em'">{{ span.text }}</i>
          <template v-else>{{ span.text }}</template>
        </template>
      </h3>

      <h4 v-else-if="block.kind === 'heading'" class="h3">
        <template v-for="(span, j) in block.inline" :key="j">
          <code v-if="span.kind === 'code'" class="mono">{{ span.text }}</code>
          <a
            v-else-if="span.kind === 'link'"
            :href="span.href"
            target="_blank"
            rel="noopener noreferrer"
            >{{ span.text }}</a
          >
          <b v-else-if="span.kind === 'strong'">{{ span.text }}</b>
          <i v-else-if="span.kind === 'em'">{{ span.text }}</i>
          <template v-else>{{ span.text }}</template>
        </template>
      </h4>

      <pre v-else-if="block.kind === 'code'" class="code mono">{{ block.text }}</pre>

      <hr v-else-if="block.kind === 'rule'" />

      <blockquote v-else-if="block.kind === 'quote'">
        <template v-for="(span, j) in block.inline" :key="j">
          <code v-if="span.kind === 'code'" class="mono">{{ span.text }}</code>
          <a
            v-else-if="span.kind === 'link'"
            :href="span.href"
            target="_blank"
            rel="noopener noreferrer"
            >{{ span.text }}</a
          >
          <b v-else-if="span.kind === 'strong'">{{ span.text }}</b>
          <i v-else-if="span.kind === 'em'">{{ span.text }}</i>
          <template v-else>{{ span.text }}</template>
        </template>
      </blockquote>

      <component :is="block.ordered ? 'ol' : 'ul'" v-else-if="block.kind === 'list'">
        <li v-for="(item, j) in block.items" :key="j">
          <template v-for="(span, k) in item" :key="k">
            <code v-if="span.kind === 'code'" class="mono">{{ span.text }}</code>
            <a
              v-else-if="span.kind === 'link'"
              :href="span.href"
              target="_blank"
              rel="noopener noreferrer"
              >{{ span.text }}</a
            >
            <b v-else-if="span.kind === 'strong'">{{ span.text }}</b>
            <i v-else-if="span.kind === 'em'">{{ span.text }}</i>
            <template v-else>{{ span.text }}</template>
          </template>
        </li>
      </component>

      <p v-else>
        <template v-for="(span, j) in block.inline" :key="j">
          <code v-if="span.kind === 'code'" class="mono">{{ span.text }}</code>
          <a
            v-else-if="span.kind === 'link'"
            :href="span.href"
            target="_blank"
            rel="noopener noreferrer"
            >{{ span.text }}</a
          >
          <b v-else-if="span.kind === 'strong'">{{ span.text }}</b>
          <i v-else-if="span.kind === 'em'">{{ span.text }}</i>
          <template v-else>{{ span.text }}</template>
        </template>
      </p>
    </template>
  </div>
</template>

<style scoped>
.md {
  font: var(--t-ui-sm);
  color: var(--fg-3);
  overflow-wrap: anywhere;
}

.md > :first-child {
  margin-top: 0;
}

.md > :last-child {
  margin-bottom: 0;
}

.md p,
.md blockquote {
  margin: 0 0 10px;
  line-height: 1.55;
}

/* A CARD'S HEADINGS SIT INSIDE A PANEL THAT IS ALREADY LABELLED, so they are
   the body scale with weight and colour doing the work rather than size. The
   design's one-headline-per-view rule is spent on the band above the board. */
.h2 {
  margin: 18px 0 8px;
  font: var(--t-ui-lg);
  color: var(--fg);
}

.h3 {
  margin: 14px 0 6px;
  font: var(--t-ui-md);
  color: var(--fg-2);
}

/* THE GLOBAL RESET STRIPS THE MARKER and this is the one place that wants it
   back. base.css sets `list-style: none` on every ul and ol, correctly - every
   other list in this application is a rack or a strip - so a card's bullets
   rendered as an indent with nothing in front of them and read as a code block
   somebody had forgotten to fence. */
.md ul {
  margin: 0 0 10px;
  padding-left: 20px;
  line-height: 1.55;
  list-style: disc;
}

.md ol {
  margin: 0 0 10px;
  padding-left: 22px;
  line-height: 1.55;
  list-style: decimal;
}

.md li {
  margin-bottom: 3px;
}

.md li::marker {
  color: var(--fg-5);
}

.md code {
  padding: 1px 4px;
  font: var(--t-mono-sm);
  color: var(--fg-2);
  background: var(--surface-chip);
  border-radius: var(--r-xs);
}

/* THE ONE PLACE WRAPPING IS WRONG. A fenced block is column-aligned output and
   re-flowing it destroys the alignment that makes it readable - the same reason
   the gate tail is `white-space: pre`. */
.code {
  margin: 0 0 10px;
  padding: 9px 11px;
  overflow-x: auto;
  font: var(--t-mono-sm);
  color: var(--fg-3);
  white-space: pre;
  background: var(--surface-sunken);
  border-radius: var(--r-sm);
}

.md blockquote {
  padding-left: 11px;
  color: var(--fg-4);
  border-left: 2px solid var(--line);
}

.md hr {
  margin: 16px 0;
  border: 0;
  border-top: 1px solid var(--border-divider);
}

.md a {
  color: var(--accent);
}
</style>
