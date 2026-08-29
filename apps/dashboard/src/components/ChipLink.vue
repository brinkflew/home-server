<script setup lang="ts">
/**
 * THE ONE PLACE THE READ-ONLY DECISION SHOWS UP IN THE UI.
 *
 * The design gives both media pages write affordances - Terminate a stream,
 * Approve a request, Fix path, Force recheck, Retry, Start now, Scan library -
 * and no container here can have any of them. `container_t -> unconfined_t :
 * unix_stream_socket connectto` is DENY, `systemd --user` for uid 1000 runs as
 * unconfined_t, and that is not fixable by relabelling. Actions would need a
 * privileged host-side surface reachable from a browser, which is a decision to
 * take on its own merits rather than a checkbox to add behind a dashboard.
 *
 * So every one of those chips becomes a link that opens the owning application.
 * The design's layout slot and column widths are unchanged; only the semantics
 * are, and its own fallback chip already said "Open".
 *
 * ChipButton.vue IS THE EXCEPTION AND IT IS NOT ONE OF THESE. It sends a command
 * to the control plane conduct polls; it still reaches nothing itself, and it
 * still cannot restart a unit or pull an image. This component stays the rule.
 *
 * A NULL href RENDERS A DISABLED BOX, NOT A LINK. That is the `npm run dev` case,
 * where the hostname is localhost and there is no sibling to reach - and a chip
 * that silently pointed at `sonarr.localhost` would be worse than one that says
 * it cannot go there. Same treatment for a row nothing owns.
 */
import type { Tone } from "@/types";

withDefaults(
  defineProps<{
    label: string;
    /** null disables the chip. */
    href: string | null;
    title?: string;
    tone?: Tone;
  }>(),
  { title: "", tone: "off" },
);
</script>

<template>
  <a
    v-if="href"
    class="chip mono"
    :class="tone"
    :href="href"
    :title="title"
    target="_blank"
    rel="noopener noreferrer"
  >
    <!-- For a leading status dot. The service strip needs one; the action chips
         in the Library table do not. -->
    <slot name="lead" />
    <span class="ctext">{{ label }}</span>
    <!-- Inline SVG, not a unicode arrow: the ASCII lint covers every .vue file. -->
    <svg class="out" width="7" height="7" viewBox="0 0 10 10" fill="none" stroke="currentColor" aria-hidden="true">
      <path d="M3.5 1.5h5v5" stroke-width="1.3" />
      <path d="M8.5 1.5 4 6" stroke-width="1.3" />
      <path d="M6.5 8.5h-5v-5" stroke-width="1.3" opacity="0.5" />
    </svg>
  </a>

  <span v-else class="chip mono disabled" :title="title || 'not reachable from here'" aria-disabled="true">
    <slot name="lead" />
    <span class="ctext">{{ label }}</span>
  </span>
</template>

<style scoped>
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

/* A CHIP THAT LEADS SOMEWHERE PICKS UP THE ACCENT ON HOVER, whatever the row's
   health is. It used to go teal when `tone` was `ok`, which said "healthy" and
   "you can click this" in one colour - the exact conflation the accent split
   exists to end. The lead dot still carries the reading. */
a.chip:hover {
  color: var(--accent);
  background: var(--fill-hover);
  border-color: var(--accent-edge);
}

/* THE LABEL IS THE PART THAT MAY SHRINK. A branch name is arbitrarily long
   and lands in a 132px column; without this the chip refuses to narrow, the
   fixed table layout has nothing to clip, and the whole page grows a
   horizontal scrollbar. The arrow keeps its size - a truncated chip must still
   read as a link. */
.ctext {
  overflow: hidden;
  text-overflow: ellipsis;
  min-width: 0;
}

.out {
  flex: none;
  opacity: 0.6;
}

.disabled {
  color: var(--fg-dim);
  border-color: var(--line-faint);
  cursor: not-allowed;
}
</style>
