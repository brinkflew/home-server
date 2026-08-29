<script setup lang="ts">
/**
 * The 1h / 6h / 24h / 7d picker.
 *
 * Extracted because SystemPage and ServicesPage carried byte-identical copies of
 * this markup AND of its three CSS rules. It takes no props and emits nothing:
 * useTimeWindow() is a module-level singleton, so every instance is already
 * looking at and setting the same choice, which is what makes the selection
 * survive a route change.
 *
 * Belongs inside a `<Teleport defer to="#toolbar">` in the page that uses it.
 */
import { useTimeWindow } from "@/composables/useTimeWindow";

const { windows, active, setWindow } = useTimeWindow();
</script>

<template>
  <div class="picker">
    <button
      v-for="w in windows"
      :key="w.id"
      class="pick mono"
      :class="{ on: active === w.id }"
      @click="setWindow(w.id)"
    >
      {{ w.label }}
    </button>
  </div>
</template>

<style scoped>
/* Lifted from the copies this replaced in SystemPage.vue and ServicesPage.vue,
   which were themselves byte-identical to each other. */
.picker {
  display: flex;
  gap: 2px;
  padding: 2px;
  border-radius: var(--r-sm);
  background: var(--field);
  border: 1px solid var(--line);
}

.pick {
  padding: 5px 11px;
  border-radius: var(--r-xs);
  font: var(--t-mono-sm);
  color: var(--fg-5);
  transition: background var(--dur-fast) var(--ease-standard),
    color var(--dur-fast) var(--ease-standard);
}

.pick:hover {
  background: var(--fill);
  color: var(--fg);
}

/* The pick is a choice a PERSON made, which is the accent's one job. A wash
   plus a weight step, so the selected state is never colour alone. */
.pick.on {
  background: var(--accent-tint);
  color: var(--accent);
  font: var(--t-mono-md);
}
</style>
