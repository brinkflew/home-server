<script setup lang="ts">
/**
 * System: the shell for the three views behind one nav tab.
 *
 * IT WAS ONE PAGE OF 1,553 LINES, which made it the largest file in this
 * application - longer than the AgentsPage that was split for exactly this
 * reason one week earlier. Seven bands and nine panels, and they answered three
 * different questions: somebody opening it because their phone had buzzed
 * scrolled past four bands of machinery to reach the alert that sent them.
 *
 * SO IT IS THREE VIEWS, EACH ANSWERING ONE THING:
 *
 *   /system/health    is anything wrong?
 *   /system/load      what is it working on?
 *   /system/storage   will the disks hold?
 *
 * THE ALERTS ARE SECOND ON THE VIEW /system LANDS ON, under a lead that is one
 * line and three conditions. They were band six of seven. The lead keeps its
 * place because it is what tones the page and it costs about 90px; everything
 * with detail in it comes after.
 *
 * THE STORES ARE STILL INSTANTIATED IN App.vue AND THAT IS LOAD-BEARING HERE,
 * for the reason AgentsLayout gives: usePoll resets lastOk on unmount, so a
 * host-document poll owned by a view would restart the clock its own staleness
 * is measured against every time somebody moved between these three. The
 * Prometheus polls ARE per view, deliberately - useMetricsStale() reads the
 * host store rather than those polls, so splitting them costs no freshness.
 * The single page fetched sixteen range queries and eighteen instants on every
 * pass; health now asks for nine instants and no ranges at all, load for
 * sixteen ranges, storage for ten instants.
 *
 * THE WINDOW PICKER IS NOT HERE. Only /system/load draws a time axis, so only
 * it teleports one - a picker that changes nothing on screen is a lie about a
 * control, which is why /agents/fleet owns the other one.
 */
import SubNav from "@/components/SubNav.vue";

const views = [
  { to: "/system/health", label: "Health" },
  { to: "/system/load", label: "Load" },
  { to: "/system/storage", label: "Storage" },
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
/* Two rhythms, not one. --gap-lg between bands and --gap inside them is what
   makes this read as bands rather than as one stack of panels. Band owns the
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
