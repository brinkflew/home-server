<script setup lang="ts">
/**
 * Agents: the shell for the three views behind one nav tab.
 *
 * IT WAS ONE PAGE AND IT ANSWERED THREE QUESTIONS. AgentsPage.vue reached 1,476
 * lines and nine panels: the board, the round's own transcript in an expander
 * under it, the daily strips, the slice chart, the containment checks, the
 * control plane, intake and the battery's findings. Everything on it was worth
 * showing and none of it belonged beside the rest - a person watching for a
 * gate to answer had to scroll past four panels about the machinery, and a
 * person reading a round's transcript read it inside a table row.
 *
 * SO IT IS THREE VIEWS, EACH ANSWERING ONE THING:
 *
 *   /agents/rounds        is the fleet working, and does it need me?
 *   /agents/rounds/<key>  what did this round do?
 *   /agents/fleet         what is the machinery doing, and what does it cost?
 *
 * THE STORES ARE STILL INSTANTIATED IN App.vue AND THAT IS LOAD-BEARING HERE.
 * usePoll resets lastOk on unmount, so a fleet poll owned by a page would
 * restart the very clock its own staleness is measured against every time
 * somebody moved between these three views - and a document that stopped being
 * written three hours ago would read as fresh on exactly the views whose job is
 * to say the fleet is stuck. Prometheus polls ARE per view, deliberately:
 * useMetricsStale() reads the host store, not those polls, so splitting them
 * costs no freshness and each view asks for only the numbers it draws.
 *
 * THE WINDOW PICKER IS NOT HERE. Only /agents/fleet has a chart with a time
 * axis, so only it teleports one - a picker that changes nothing on screen is a
 * lie about a control.
 */
import SubNav from "@/components/SubNav.vue";

const views = [
  { to: "/agents/rounds", label: "Rounds" },
  { to: "/agents/fleet", label: "Fleet" },
];
</script>

<template>
  <div class="page">
    <Teleport defer to="#toolbar">
      <!-- NOT "read only", and this section is the only one where that is so:
           intake, hold, release, restart and the approval all act. What is
           still true is the weaker claim the chips themselves make - conduct
           applies them on its next cycle, so the page asks and never does. -->
      <span class="mono note">asks the fleet</span>
    </Teleport>

    <SubNav :items="views" />

    <RouterView v-slot="{ Component }">
      <component :is="Component" />
    </RouterView>
  </div>
</template>

<style scoped>
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
