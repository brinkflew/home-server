<script setup lang="ts">
import NavBar from "@/components/NavBar.vue";
import StalenessBanner from "@/components/StalenessBanner.vue";
import Tooltip from "@/components/Tooltip.vue";
import { useHostStore } from "@/stores/host";
import { useMediaStore } from "@/stores/media";
import { useFleetStore } from "@/stores/fleet";

// Instantiated here rather than per page, so the polls are shared and a route
// change does not restart them.
useHostStore();

// Same reason, and for the media documents it is load-bearing rather than
// merely tidy: usePoll resets lastOk on unmount, so per-page polling would clear
// the very clock the staleness of these two documents is measured against every
// time somebody moved between Home and Library.
useMediaStore();
// AT THE SHELL FOR THE REASON ABOVE, and it bites harder here: usePoll resets
// lastOk on unmount, so a page-level fleet poll would restart the clock its own
// staleness is measured against every time somebody opened /agents - and a
// document that stopped being written three hours ago would read as fresh, on
// the one page whose job is to say whether the fleet is stuck.
useFleetStore();
</script>

<template>
  <div class="shell">
    <NavBar />
    <StalenessBanner />

    <main class="page">
      <RouterView v-slot="{ Component }">
        <component :is="Component" />
      </RouterView>
    </main>

    <!-- Mounted once, outside every panel: position:fixed inside a clipping
         ancestor would be clipped, and one element is what makes "only one
         tooltip at a time" structural rather than a rule everyone remembers. -->
    <Tooltip />
  </div>
</template>

<style scoped>
.shell {
  display: flex;
  flex-direction: column;
  min-height: 100%;
}

.page {
  flex: 1;
  min-width: 0;
}
</style>
