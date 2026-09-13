<script setup lang="ts">
/**
 * /network/map: how is it wired?
 *
 * HUMAN-SCANABLE TOPOLOGY MAP AND NETWORK CARDS VIEW.
 *
 * Provides two complementary representations:
 * 1. Structured Cards View (Default): A human-scannable card grid grouped by segment,
 *    clearly displaying attached containers, roles, subnet ranges, isolation state,
 *    and multi-network bridge tags (+ net-media, + net-arr) to easily identify cross-network routing.
 * 2. Visual Graph View: Refreshed interactive SVG topology graph with high-contrast font
 *    styling, status dots, and crisp line highlights.
 *
 * Includes an instant filter to search across segments, containers, roles, and subnets.
 */
import { computed, ref } from "vue";
import { useRouter } from "vue-router";

import Band from "@/components/Band.vue";
import NetworkGraph from "@/components/NetworkGraph.vue";
import PanelBox from "@/components/PanelBox.vue";
import StatusDot from "@/components/StatusDot.vue";

import { useMetricsStale } from "@/composables/useStaleness";
import { useNetworkReadings } from "@/composables/useNetworkReadings";
import * as fmt from "@/format";
import type { MemberRef, SegmentRow } from "@/network";
import type { Tone } from "@/types";

const router = useRouter();
const metricsStale = useMetricsStale();
const { segments, tally, model, flowing } = useNetworkReadings();

const filterText = ref("");
const viewMode = ref<"cards" | "graph">("cards");

/** Filtered list of segment rows for easy scanning. */
const filteredSegments = computed(() => {
  const q = filterText.value.trim().toLowerCase();
  if (!q) return segments.value;

  return segments.value.filter((s) => {
    const matchId = s.id.toLowerCase().includes(q);
    const matchSubnet = (s.subnet || "").toLowerCase().includes(q);
    const matchPurpose = (s.purpose || "").toLowerCase().includes(q);
    const matchIsolate = q === "isolate" && s.isolate === "true";
    const matchMember = s.members.some(
      (m) =>
        m.name.toLowerCase().includes(q) ||
        m.role.toLowerCase().includes(q) ||
        m.networks.some((n) => n.toLowerCase().includes(q)),
    );
    return matchId || matchSubnet || matchPurpose || matchIsolate || matchMember;
  });
});

/** Return other networks a multi-homed member connects to besides currentSegId. */
function otherNetworks(m: MemberRef, currentSegId: string): string[] {
  return m.networks.filter((n) => n !== currentSegId);
}

function toneClass(tone: Tone): Record<string, boolean> {
  return { bad: tone === "fail", warnish: tone === "warn", dull: tone === "off" };
}

function isolateTone(s: SegmentRow): Tone {
  if (s.kind === "tunnel") return "off";
  if (s.isolate === undefined) return "off";
  return s.isolate === "true" ? "ok" : s.declared ? "fail" : "off";
}

function isolateLabel(s: SegmentRow): string {
  if (s.kind === "tunnel") return "tunnel";
  if (s.isolate === undefined) return "isolate unknown";
  return s.isolate === "true" ? "isolate=true" : "NO isolate";
}

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
        {{ tally.segments }} segments, {{ tally.attachments }} attachments
      </span>
    </template>

    <PanelBox :stale="metricsStale">
      <!-- Toolbar: Instant Search and View Switcher -->
      <div class="ctrl-bar">
        <div class="search-box">
          <input
            v-model="filterText"
            type="text"
            placeholder="Search segments, services, subnets (e.g. caddy, media, isolate)..."
            class="search-input mono"
          />
          <button v-if="filterText" class="clear-btn mono" @click="filterText = ''">x</button>
        </div>

        <div class="mode-switch mono">
          <button
            class="mode-btn"
            :class="{ active: viewMode === 'cards' }"
            @click="viewMode = 'cards'"
          >
            Cards View
          </button>
          <button
            class="mode-btn"
            :class="{ active: viewMode === 'graph' }"
            @click="viewMode = 'graph'"
          >
            Graph View
          </button>
        </div>
      </div>

      <!-- CARDS VIEW (Human Scannable Grid) -->
      <div v-if="viewMode === 'cards'" class="cards-container">
        <p v-if="!filteredSegments.length" class="empty mono">
          No matching network segments found for "{{ filterText }}"
        </p>

        <div v-else class="seg-grid">
          <div
            v-for="s in filteredSegments"
            :key="s.id"
            class="seg-card"
            @click="open(s.id)"
          >
            <div class="seg-card-head">
              <div class="seg-card-title">
                <StatusDot :tone="s.tone" :live="s.tone === 'ok'" :size="7" />
                <span class="seg-name mono">{{ s.id }}</span>
              </div>
              <div class="seg-card-badges">
                <span v-if="s.subnet" class="pill mono">{{ s.subnet }}</span>
                <span class="pill mono" :class="toneClass(isolateTone(s))">{{ isolateLabel(s) }}</span>
              </div>
            </div>

            <p class="seg-purpose mono">{{ s.purpose }}</p>

            <div class="seg-card-meta mono">
              <span>{{ s.members.length }} container(s)</span>
              <span v-if="s.measured && s.bytes > 0" class="seg-flow">{{ fmt.rate(s.bytes) }}</span>
            </div>

            <!-- Member list -->
            <div class="member-list">
              <div
                v-for="m in s.members"
                :key="m.name"
                class="member-row"
                @click.stop="open(m.name)"
              >
                <div class="member-row-head">
                  <StatusDot :tone="m.tone" :size="6" />
                  <span class="member-name mono" :class="toneClass(m.tone)">{{ m.name }}</span>
                  <span v-if="!m.attached" class="unattached-tag mono">unattached</span>
                </div>

                <div class="member-role mono">{{ m.role }}</div>

                <!-- Multi-homed bridge tags -->
                <div v-if="otherNetworks(m, s.id).length" class="bridge-tags mono">
                  <span class="bridge-label">bridges to:</span>
                  <span
                    v-for="otherNet in otherNetworks(m, s.id)"
                    :key="otherNet"
                    class="bridge-tag"
                    @click.stop="open(otherNet)"
                  >
                    + {{ otherNet }}
                  </span>
                </div>

                <!-- Rates -->
                <div v-if="Number.isFinite(m.rx) || Number.isFinite(m.tx)" class="member-rate mono">
                  <span v-if="Number.isFinite(m.rx) && m.rx > 0">rx {{ fmt.rate(m.rx) }}</span>
                  <span v-if="Number.isFinite(m.tx) && m.tx > 0">tx {{ fmt.rate(m.tx) }}</span>
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>

      <!-- GRAPH VIEW (SVG Visual Topology Map) -->
      <div v-else class="graph-container">
        <NetworkGraph
          :model="model"
          :segments="filteredSegments"
          :flowing="flowing"
          :focus="null"
          @update:focus="open"
        />
      </div>
    </PanelBox>
  </Band>
</template>

<style scoped>
.ctrl-bar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--gap);
  margin-bottom: 16px;
  flex-wrap: wrap;
}

.search-box {
  position: relative;
  flex: 1;
  min-width: 260px;
}

.search-input {
  width: 100%;
  padding: 7px 28px 7px 10px;
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
  font-size: 16px;
  cursor: pointer;
  padding: 0 4px;
}

.clear-btn:hover {
  color: var(--fg);
}

.mode-switch {
  display: flex;
  background: var(--surface-high);
  border: 1px solid var(--line);
  border-radius: var(--r-xs);
  padding: 2px;
}

.mode-btn {
  padding: 5px 12px;
  border: none;
  background: transparent;
  color: var(--fg-5);
  font: var(--t-mono-xs);
  border-radius: var(--r-xs);
  cursor: pointer;
  transition: all 120ms ease;
}

.mode-btn.active {
  background: var(--fill);
  color: var(--fg);
  font-weight: 600;
}

.cards-container {
  min-width: 0;
}

.seg-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(320px, 1fr));
  gap: 14px;
}

.seg-card {
  background: var(--surface-sunken);
  border: 1px solid var(--line);
  border-radius: var(--r-md);
  padding: 12px 14px;
  display: flex;
  flex-direction: column;
  gap: 8px;
  cursor: pointer;
  transition: border-color 150ms ease;
}

.seg-card:hover {
  border-color: var(--line-strong);
}

.seg-card-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
}

.seg-card-title {
  display: flex;
  align-items: center;
  gap: 8px;
}

.seg-name {
  font: var(--t-mono-md);
  font-weight: 700;
  color: var(--fg);
}

.seg-card-badges {
  display: flex;
  align-items: center;
  gap: 6px;
}

.pill {
  padding: 2px 6px;
  border-radius: var(--r-xs);
  background: var(--fill);
  font: var(--t-mono-xs);
  color: var(--fg-3);
}

.seg-purpose {
  font: var(--t-mono-xs);
  color: var(--fg-4);
  line-height: 1.35;
}

.seg-card-meta {
  display: flex;
  justify-content: space-between;
  font: var(--t-mono-xs);
  color: var(--fg-5);
  padding-bottom: 4px;
  border-bottom: 1px solid var(--border-divider);
}

.seg-flow {
  color: var(--ok);
  font-weight: 600;
}

.member-list {
  display: flex;
  flex-direction: column;
  gap: 6px;
  margin-top: 2px;
}

.member-row {
  background: var(--surface-high);
  border: 1px solid var(--line);
  border-radius: var(--r-xs);
  padding: 8px 10px;
  display: flex;
  flex-direction: column;
  gap: 3px;
  transition: background 120ms ease;
}

.member-row:hover {
  background: var(--fill);
}

.member-row-head {
  display: flex;
  align-items: center;
  gap: 6px;
}

.member-name {
  font: var(--t-mono-sm);
  font-weight: 600;
  color: var(--fg-2);
}

.unattached-tag {
  margin-left: auto;
  font: var(--t-mono-xs);
  color: var(--warn);
}

.member-role {
  font: var(--t-mono-xs);
  color: var(--fg-5);
}

.bridge-tags {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 4px;
  margin-top: 2px;
}

.bridge-label {
  font: var(--t-mono-xs);
  color: var(--fg-5);
}

.bridge-tag {
  padding: 1px 5px;
  border-radius: var(--r-xs);
  background: var(--fill);
  color: var(--fg-3);
  font: var(--t-mono-xs);
}

.bridge-tag:hover {
  color: var(--accent);
  background: var(--surface-high);
}

.member-rate {
  display: flex;
  gap: 8px;
  font: var(--t-mono-xs);
  color: var(--ok);
  margin-top: 2px;
}

.bad {
  color: var(--fail-text);
}

.warnish {
  color: var(--warn);
}

.dull {
  color: var(--fg-5);
}

.empty {
  font: var(--t-mono-sm);
  color: var(--fg-dim);
  padding: 16px 4px;
}
</style>
