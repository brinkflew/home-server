<script setup lang="ts">
/**
 * The panel: a label, an optional right-hand aside, and a body.
 *
 * `stale` is not decoration. When the data behind a panel has stopped being
 * refreshed the panel dims and says so, rather than continuing to render a
 * confident number that is an hour old. Every page is expected to pass it.
 */
withDefaults(
  defineProps<{
    label?: string;
    /** Dim the body and show why. Pass the reason, not just a boolean. */
    stale?: string | null;
    /** Sunken surface, for the panels the design draws darker. */
    sunken?: boolean;
    padding?: string;
  }>(),
  { label: "", stale: null, sunken: false, padding: "var(--pad-panel)" },
);
</script>

<template>
  <section class="panel" :class="{ sunken }" :style="{ padding }">
    <header v-if="label || $slots.aside" class="head">
      <span class="label">{{ label }}</span>
      <span class="aside"><slot name="aside" /></span>
    </header>

    <div class="body" :class="{ dim: !!stale }">
      <slot />
    </div>

    <p v-if="stale" class="stale mono">{{ stale }}</p>
  </section>
</template>

<style scoped>
/* NO BORDER, and that is the design rather than an omission: the surface
   steps are ~0.03 L apart, which is wide enough for a panel to separate from
   the page on its own. A lifted fill plus a hairline is belt and braces, and
   twenty bordered boxes on a near-black ground read as a wireframe. Only a
   FLOATING surface - the tooltip, a graph node - draws an edge. */
.panel {
  background: var(--surface-card);
  border: 1px solid var(--border-card);
  border-radius: var(--r-md);
  min-width: 0;
}

.sunken {
  background: var(--surface-card-inset);
}

.head {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: 12px;
  margin-bottom: 12px;
}

.aside {
  font: var(--t-mono-sm);
  color: var(--fg-5);
}

.body {
  min-width: 0;
}

.stale {
  margin-top: 12px;
  padding-top: 11px;
  border-top: 1px solid var(--border-divider);
  font: var(--t-mono-sm);
  color: var(--warn);
}
</style>
