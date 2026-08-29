<script setup lang="ts">
/**
 * A coloured pill stating a fact. The Library table's STATE column and the
 * now-playing card's DIRECT / HW TRANSCODE badge are the same object.
 *
 * It is not a control and never will be - that is what ChipLink is for. Merging
 * the two would make both worse: a pill that looks clickable and is not is the
 * same class of lie as an action button that cannot act.
 */
import type { Tone } from "@/types";

withDefaults(defineProps<{ label: string; tone: Tone; size?: "sm" | "md" }>(), { size: "md" });
</script>

<template>
  <span class="pill mono" :class="[tone, size]">{{ label }}</span>
</template>

<style scoped>
/* NOWRAP NEEDS A CAP OR IT PUSHES ITS COLUMN OPEN. Every other chip-shaped
   element here caps itself - ChipLink and ChipButton both carry max-width with
   a shrinkable label - and this one did not, so a long state word was enough to
   widen a fixed-layout table past its container. */
.pill {
  display: inline-block;
  vertical-align: middle;
  border-radius: var(--r-xs);
  white-space: nowrap;
  max-width: 100%;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
}

/* THE FLOOR IS 11px. `sm` used to be 9px, which is below what a screen
   carries; the two sizes are now the two bottom mono roles rather than one
   role and an override. */
.md {
  padding: var(--pad-chip);
  font: var(--t-mono-sm);
}

.sm {
  padding: 2px 6px;
  font: var(--t-mono-xs);
}

/* The tint/edge pairs exist in tokens.css precisely so a coloured chip does not
   have to invent an opacity - `off` included, since 2026-08-29. */
.ok {
  color: var(--ok);
  background: var(--ok-tint);
  border: 1px solid var(--ok-edge);
}

.warn {
  color: var(--warn);
  background: var(--warn-tint);
  border: 1px solid var(--warn-edge);
}

.fail {
  color: var(--fail-text);
  background: var(--fail-tint);
  border: 1px solid var(--fail-edge);
}

.off {
  color: var(--fg-5);
  background: var(--off-tint);
  border: 1px solid var(--off-edge);
}
</style>
