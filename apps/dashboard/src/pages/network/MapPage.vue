<script setup lang="ts">
/**
 * /network/map: how is it wired?
 *
 * ONE BAND AND ONE DRAWING, WHICH IS THE WHOLE POINT OF THE SPLIT. The graph is
 * the tallest thing in this application and it was band four of five on a page
 * whose first question is "is anything wrong"; here it is the view, and nothing
 * it pushes down matters because there is nothing below it.
 *
 * CLICKING A NODE LEAVES THIS VIEW. It used to filter the two tables underneath
 * it, and those are on /network/overview now - so a click carries ?focus= there
 * instead, with a hash aimed at the Segments band so the reader lands on the
 * thing they just filtered rather than at the top of the page. The selection was
 * in the URL before the split for a different reason (it is a state somebody can
 * send to somebody else), and that is what makes this a two-line change rather
 * than a new mechanism.
 *
 * THIS VIEW HOLDS NO FOCUS OF ITS OWN. Nothing here is filtered, so `focus` is
 * null: lighting one box on a drawing where the filter has no visible effect
 * would be a control that does nothing. The graph still emits null for the
 * clear paths - clicking the lit node, and Escape - and those are ignored.
 *
 * NO LEAD, DELIBERATELY. The drawing IS the reading: box colour is the measured
 * liveness verdict, the group edge is whether the segmentation holds, and the
 * elbows are measured bytes. A headline over it would be a second reading of the
 * same array, which is the defect docs/dashboard.md records for the System page.
 * The lead stays on /network/overview, where the conditions are.
 */
import { useRouter } from "vue-router";

import Band from "@/components/Band.vue";
import NetworkGraph from "@/components/NetworkGraph.vue";
import PanelBox from "@/components/PanelBox.vue";

import { useMetricsStale } from "@/composables/useStaleness";
import { useNetworkReadings } from "@/composables/useNetworkReadings";

const router = useRouter();
const metricsStale = useMetricsStale();
const { segments, tally, model, flowing } = useNetworkReadings();

/** A click is a question about one segment or one service, and the answer is
 *  two tables away. `replace` would be wrong: going back to the drawing after
 *  following one of these is the obvious next move. */
function open(id: string | null): void {
  if (!id) return;
  void router.push({ path: "/network/overview", query: { focus: id }, hash: "#segments" });
}
</script>

<template>
  <Band label="The segmentation">
    <template #aside>
      <span class="mono">
        {{ tally.segments }} segments, {{ tally.attachments }} attachments - click one to see what
        is on it
      </span>
    </template>
    <PanelBox :stale="metricsStale">
      <NetworkGraph
        :model="model"
        :segments="segments"
        :flowing="flowing"
        :focus="null"
        @update:focus="open"
      />
    </PanelBox>
  </Band>
</template>
