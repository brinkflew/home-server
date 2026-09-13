<script setup lang="ts">
/**
 * /network/map: how is it wired?
 *
 * Visual topology graph map with instant search filter.
 */
import { computed, ref } from "vue";
import { useRouter } from "vue-router";

import Band from "@/components/Band.vue";
import NetworkGraph from "@/components/NetworkGraph.vue";
import PanelBox from "@/components/PanelBox.vue";

import { useMetricsStale } from "@/composables/useStaleness";
import { useNetworkReadings } from "@/composables/useNetworkReadings";

const router = useRouter();
const metricsStale = useMetricsStale();
const { segments, tally, model, flowing } = useNetworkReadings();

const filterText = ref("");

/** Filtered list of segment rows for search. */
const filteredSegments = computed(() => {
  const q = filterText.value.trim().toLowerCase();
  if (!q) return segments.value;

  return segments.value.filter((s) => {
    const matchId = s.id.toLowerCase().includes(q);
    const matchSubnet = (s.subnet || "").toLowerCase().includes(q);
    const matchPurpose = (s.purpose || "").toLowerCase().includes(q);
    const matchMember = s.members.some(
      (m) =>
        m.name.toLowerCase().includes(q) ||
        m.role.toLowerCase().includes(q) ||
        m.networks.some((n) => n.toLowerCase().includes(q)),
    );
    return matchId || matchSubnet || matchPurpose || matchMember;
  });
});

/** Clicking a container or segment opens the detailed view in /network/overview. */
function open(id: string | null): void {
  if (!id) return;
  void router.push({ path: "/network/overview", query: { focus: id }, hash: "#segments" });
}
</script>

<template>
  <Band label="The segmentation">
    <template #aside>
      <span class="mono">
        {{ tally.segments }} segments, {{ tally.attachments }} attachments - hover or click to highlight connections
      </span>
    </template>

    <PanelBox :stale="metricsStale">
      <!-- Search Filter Bar -->
      <div class="ctrl-bar">
        <div class="search-box">
          <input
            v-model="filterText"
            type="text"
            placeholder="Filter map by segment, container, subnet (e.g. caddy, media, 10.88)..."
            class="search-input mono"
          />
          <button v-if="filterText" class="clear-btn mono" @click="filterText = ''">x</button>
        </div>
      </div>

      <!-- Topology Map View -->
      <NetworkGraph
        :model="model"
        :segments="filteredSegments"
        :flowing="flowing"
        :focus="null"
        @update:focus="open"
      />
    </PanelBox>
  </Band>
</template>

<style scoped>
.ctrl-bar {
  display: flex;
  align-items: center;
  gap: var(--gap);
  margin-bottom: 14px;
}

.search-box {
  position: relative;
  flex: 1;
  max-width: 480px;
}

.search-input {
  width: 100%;
  padding: 6px 28px 6px 10px;
  border-radius: var(--r-xs);
  border: 1px solid var(--line);
  background: var(--surface-high);
  color: var(--fg);
  font: var(--t-mono-sm);
  outline: none;
}

.search-input:focus {
  border-color: var(--accent);
}

.clear-btn {
  position: absolute;
  right: 8px;
  top: 50%;
  transform: translateY(-50%);
  background: none;
  border: none;
  color: var(--fg-5);
  font-size: 15px;
  cursor: pointer;
  padding: 0 4px;
}

.clear-btn:hover {
  color: var(--fg);
}
</style>
