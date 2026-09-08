<script setup lang="ts">
/**
 * Network: the shell for the two views behind one nav tab.
 *
 * THE DRAWING WAS THE PAGE. NetworkPage.vue was 803 lines and five bands, and
 * NetworkGraph - ten segment boxes, a spine of the five multi-homed containers,
 * and an elbow for every attachment - was taller than everything else on it put
 * together. So a page whose first question is "is the segmentation intact"
 * opened with a lead, one table, and then a diagram that pushed the two tables
 * carrying the actual readings below the fold at every width.
 *
 * SO IT IS TWO VIEWS:
 *
 *   /network/overview   is the segmentation intact, and what is open?
 *   /network/map        how is it wired?
 *
 * THE DRAWING IS STILL A CONTROL, and that is what the split had to preserve.
 * Clicking a segment or a service used to filter the two tables under it; the
 * tables are one view over now, so a click NAVIGATES - to /network/overview
 * with ?focus= set and the hash pointing at the Segments band. The state was
 * already in the URL for exactly this reason, so nothing had to be invented to
 * carry it across.
 *
 * THE STORES ARE STILL INSTANTIATED IN App.vue AND THAT IS LOAD-BEARING HERE,
 * for the reason AgentsLayout gives: usePoll resets lastOk on unmount, so a
 * host-document poll owned by a view would restart the clock its own staleness
 * is measured against every time somebody moved between the two.
 *
 * THE PROMETHEUS POLL IS SHARED, AND IT IS THE ONE SECTION WHERE IT IS. The
 * other two splits gave each view its own because they draw different numbers;
 * these two draw the SAME array two ways, so it lives in
 * composables/useNetworkReadings.ts and that file carries the argument.
 *
 * THERE IS NO WindowPicker HERE, deliberately, and the reason is unchanged.
 * Every number on this section is an instant query over rate(...[5m]); the
 * 1h/6h/24h/7d control would change nothing on screen, and a control that does
 * nothing is a lie about a control. It comes back the day this section grows a
 * traffic-over-time lane.
 */
import SubNav from "@/components/SubNav.vue";

const views = [
  { to: "/network/overview", label: "Overview" },
  { to: "/network/map", label: "Map" },
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
   second; the layout owns this one, so the two views are bare fragments. */
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
