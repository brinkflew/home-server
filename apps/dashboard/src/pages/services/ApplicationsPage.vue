<script setup lang="ts">
/**
 * /services/apps: what do the applications report about themselves?
 *
 * THIS IS A DIFFERENT QUESTION FROM THE OTHER TWO VIEWS, which is why it is a
 * view and not a band on either. An *arr with a dead indexer has an active
 * unit, a passing probe and a flat CPU strip: every container-level signal on
 * this section says it is fine, and the only symptom is that nothing is found.
 * home_server_arr_health_issues had been collected since the collector existed
 * with no consumer at all until this table read it.
 *
 * IT SHARES NO SERIES WITH THE RACK, so it shares no poll either - ten queries
 * at 60s against the rack's sixteen at 30s. That is the ordinary rule for a
 * split section; useServiceRack.ts is the exception, and it says why.
 *
 * NO LEAD, DELIBERATELY. Every row carries its own tone and its own sentence,
 * so a headline over four of them would be a second reading of the same array -
 * the defect docs/dashboard.md records for the System page. The one headline
 * reading for this section is on /services/health.
 */
import { computed } from "vue";

import Band from "@/components/Band.vue";
import ChipLink from "@/components/ChipLink.vue";
import PanelBox from "@/components/PanelBox.vue";

import { usePoll } from "@/composables/usePoll";
import { useMetricsStale } from "@/composables/useStaleness";
import { instant, instantBy, labelsBy, value } from "@/api/prometheus";
import { appHome } from "@/links";
import { SERVICES } from "@/queries";
import * as svc from "@/services";
import type { Tone } from "@/types";

const metricsStale = useMetricsStale();

const apps = usePoll(async (signal) => {
  const [indexers, indexerUp, queue, queueErrors, health, sessions, tdarr, torrent, rate, vpn] =
    await Promise.all([
      instantBy(SERVICES.arrIndexers, "service", signal),
      instantBy(SERVICES.indexerUp, "indexer", signal),
      instantBy(SERVICES.arrQueue, "service", signal),
      instantBy(SERVICES.arrQueueErrors, "service", signal),
      instant(SERVICES.arrHealth, signal),
      instant(SERVICES.jellyfinSessions, signal),
      instant(SERVICES.tdarrQueue, signal),
      instant(SERVICES.torrentState, signal),
      instantBy(SERVICES.torrentRate, "direction", signal),
      labelsBy(SERVICES.vpnInfo, "__name__", signal),
    ]);

  // Two labels, so neither instantBy nor labelsBy fits: the key is the pair.
  const byServiceSeverity = new Map<string, number>();
  for (const s of health) {
    const k = `${s.metric.service ?? "?"}|${s.metric.severity ?? "?"}`;
    byServiceSeverity.set(k, value(s.value));
  }

  const vpnLabels = [...vpn.values()][0];

  return svc.appRows({
    indexers,
    indexerUp,
    queue,
    queueErrors,
    health: byServiceSeverity,
    sessions: value(sessions[0]?.value),
    tdarr: value(tdarr[0]?.value),
    torrentState: value(torrent[0]?.value),
    down: rate.get("download") ?? Number.NaN,
    up: rate.get("upload") ?? Number.NaN,
    vpn: vpnLabels ? `${vpnLabels.city ?? ""} ${vpnLabels.country ?? ""}`.trim() : "",
  });
}, 60_000);

/** The poll's answer, or nothing before the first one lands. */
const appRows = computed(() => apps.data.value ?? []);

/** A tone on a value, without a fourth colour: fail and warn speak, ok is the
 *  ordinary body colour and off is the dim one. The System views' rule. */
function toneClass(tone: Tone): Record<string, boolean> {
  return { bad: tone === "fail", warnish: tone === "warn", dull: tone === "off" };
}

/** ok DRAWS NO RAIL. A teal edge down every healthy row is a wall of colour
 *  that makes the two rows with a rail harder to find, not easier. */
function rail(tone: Tone): string {
  return tone === "ok" ? "transparent" : `var(--${tone})`;
}
</script>

<template>
  <!-- "What they report", not "Applications": the sub-nav segment above it
       already says Applications, and a band that repeats its own tab names
       nothing. The same correction docs/dashboard.md records for the Fleet
       band. -->
  <Band label="What they report">
    <template #aside><span>their own health, not their containers'</span></template>

    <PanelBox :stale="metricsStale">
      <table class="tbl">
        <thead>
          <tr>
            <th class="c-rail" />
            <th class="c-app p2">Application</th>
            <th>Reading</th>
            <th class="c-open" />
          </tr>
        </thead>
        <tbody>
          <tr v-for="a in appRows" :key="a.id" :style="{ '--rail': rail(a.tone) }">
            <td class="rail" />
            <td class="c-app p2"><span class="mono aname">{{ a.label }}</span></td>
            <td>
              <!-- THE NAME RELOCATES RATHER THAN SHRINKING. Its own column is
                   132px and a phone has about 300 for the whole table, so
                   keeping it left of the reading spent half the row on one
                   word and broke "connected, 6.2 MB/s down" into nine lines. -->
              <div class="fold2 mono aname">{{ a.label }}</div>
              <div class="mono areading" :class="toneClass(a.tone)">{{ a.reading }}</div>
              <p v-if="a.issue" class="issue">{{ a.issue }}</p>
            </td>
            <td class="c-open">
              <ChipLink v-if="a.app" label="open" :href="appHome(a.app)" :title="`open ${a.label}`" />
            </td>
          </tr>
        </tbody>
      </table>
    </PanelBox>
  </Band></template>

<style scoped>
.c-rail {
  width: 30px;
}

.c-app {
  width: 132px;
}

.c-open {
  width: 84px;
}

.aname {
  font: var(--t-mono-md);
  color: var(--fg-2);
}

.areading {
  font: var(--t-mono-sm);
  color: var(--fg-3);
}

/* NOT CLAMPED. The sentence is the reason the row is amber, and FindingsPanel's
   two-line clamp is for a column 232px wide beside an id; this one has the
   width of the table. */
.issue {
  margin-top: 6px;
  font: var(--t-ui-sm);
  color: var(--fg-3);
}

/* --- the tone classes, LAST ---------------------------------------------
   AND LAST IS NOT TIDINESS. These are single classes and so is `.areading` -
   equal specificity, so the later rule in the file wins. Written above the
   table, `.areading` beat `.bad` and Prowlarr's two errors read as an ordinary
   sentence beside a red rail. */
.bad {
  color: var(--fail-text);
}

.warnish {
  color: var(--warn);
}

.dull {
  color: var(--fg-5);
}

/* --- the phone ------------------------------------------------------------ */

@media (max-width: 640px) {
  /* THE RAIL NEEDS ITS WIDTH BACK ON THE CELL ONCE THE HEADER IS GONE. Under
     table-layout: fixed the column widths come from the first row, and
     display: none on the thead makes that the first BODY row - which carries no
     widths, so the surviving columns split evenly. */
  .tbl td.rail {
    width: 30px;
  }

  .tbl thead {
    display: none;
  }

  /* The open chip is the only fixed column left once the name has folded, and
     it still needs its width back by hand, for the same reason. */
  .tbl td.c-open {
    width: 74px;
  }

  .aname.fold2 {
    margin-bottom: 5px;
  }
}
</style>
