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

  /* IT DOES NOT WRAP, AND IT NEVER DID. This carried `flex-wrap: wrap` under a
     comment saying it wrapped "rather than losing 7d off the end" - but
     flex: none, one line below it, sets flex-shrink to 0, so the box is its
     max-content width at every width and the wrap could not fire. Measured on
     /system/load: 165x34.19 at 1360, 1180, 1150, 1100, 1000, 950 and 901
     alike.

     WHAT ACTUALLY HAPPENS IS THE THING THE COMMENT SAID IT AVOIDED. The header
     gives this element its full width and clips the toolbar around it, so "7d"
     is off the edge from about 1130 down and at 901 the toolbar is 0px wide.
     That is a separate defect from the one this file was touched for - it is
     about what the 900-1180 band should DO, and a scroller there is ruled out
     because base.css gives one a 9px bar, which would put the header's height
     back under the control of what a page teleported.

     The dead declaration is gone rather than left to be believed. Below 640 the
     picker rides the toolbar's own scrollable row, where it needs neither. */
  flex: none;
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
