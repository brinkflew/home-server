<script setup lang="ts">
/**
 * Services: the shell for the three views behind one nav tab.
 *
 * THE RACK WAS THE PAGE. ServicesPage.vue was 957 lines, and the band in the
 * middle of it - nineteen units by eight columns, each with a 24-bar CPU strip,
 * a three-line memory cell and a restart caption - was taller than the other
 * three put together. So the sentence that says what to type, and the panel
 * that says what the hourly battery found, sat above and below an inventory
 * nobody opens this page to read.
 *
 * SO IT IS THREE VIEWS, EACH ANSWERING ONE THING:
 *
 *   /services/health   is anything wrong with the stack, and what do I type?
 *   /services/list     what is each service doing?
 *   /services/apps     what do the applications report about themselves?
 *
 * THE THIRD ONE IS A DIFFERENT QUESTION FROM THE OTHER TWO, which is why it is
 * not a band on either. An *arr with a dead indexer has an active unit and a
 * passing probe: every container-level signal on this section says it is fine,
 * and the only symptom is that nothing is found. It has its own poll at 60s and
 * shares no series with the rack.
 *
 * THE STORES ARE STILL INSTANTIATED IN App.vue AND THAT IS LOAD-BEARING HERE,
 * for the reason AgentsLayout gives: usePoll resets lastOk on unmount, so a
 * host-document poll owned by a view would restart the clock its own staleness
 * is measured against every time somebody moved between these three.
 *
 * THE RACK POLL IS SHARED BY TWO OF THEM, in composables/useServiceRack.ts,
 * because "Needs attention" is a FILTER over the array the rack draws and never
 * a second reading of it. That file carries the argument; it is the one thing
 * this split could not simply cut in three.
 *
 * THE WINDOW PICKER IS NOT HERE. Only /services/list draws the activity strip,
 * so only it teleports one - a picker that changes nothing on screen is a lie
 * about a control, which is why /system/load and /agents/fleet own the others.
 */
import SubNav from "@/components/SubNav.vue";

const views = [
  { to: "/services/health", label: "Health" },
  { to: "/services/list", label: "Services" },
  { to: "/services/apps", label: "Applications" },
];
</script>

<template>
  <div class="page">
    <Teleport defer to="#toolbar">
      <span class="mono note">read only</span>
    </Teleport>

    <SubNav :items="views" />

    <RouterView v-slot="{ Component }">
      <component :is="Component" />
    </RouterView>
  </div>
</template>

<style scoped>
/* Two rhythms, not one: --gap-lg between bands and --gap inside them is what
   makes a page read as bands rather than as one stack of panels. Band owns the
   second; the layout owns this one, so the three views are bare fragments. */
.page {
  padding: 16px var(--pad-page) var(--pad-page);
  display: flex;
  flex-direction: column;
  gap: var(--gap-lg);
  min-width: 0;
}

.note {
  font: var(--t-mono-sm);
  color: var(--fg-5);
}
</style>
