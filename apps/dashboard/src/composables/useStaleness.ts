// =============================================================================
// The two staleness reasons every page hands to its panels
// -----------------------------------------------------------------------------
// These were duplicated VERBATIM in SystemPage.vue (now pages/system/) and
// ServicesPage.vue. Home
// and Library need them too, and four copies of a sentence that has to stay
// consistent is how a panel ends up claiming the collector is fine while the
// banner above it says otherwise. The strings are moved unchanged, so the diff
// that introduced this file is provably a move rather than a rewrite.
//
// They are REASONS, not booleans. PanelBox takes `stale` as a string and prints
// it, because "these numbers are frozen" is the useful half - a dimmed panel
// with no explanation is just a broken-looking panel.
//
// The page decides and passes down, rather than each panel asking the store,
// for the reason PanelBox's own comment gives: a panel does not know which of
// its numbers came from where, and a component that dims itself will eventually
// dim for the wrong reason.
// =============================================================================

import { computed, type ComputedRef } from "vue";

import * as fmt from "@/format";
import { useHostStore } from "@/stores/host";

/** Prometheus, and the collector that feeds it. */
export function useMetricsStale(): ComputedRef<string | null> {
  const host = useHostStore();
  return computed(() => {
    if (host.prometheusDown) return "prometheus is unreachable; this is the last answer it gave";
    // The DECISION is host.collectorState, shared with StalenessBanner; only
    // the phrasing differs, because this returns one line for PanelBox and the
    // banner has a title and a detail. Two copies of the decision is how a
    // panel ends up saying the collector is fine under a banner saying it is
    // not - which is the defect this file's own header was written about.
    switch (host.collectorState) {
      case "never":
        return "the collector has never reported";
      case "frozen":
        return `the collector last ran ${fmt.duration(host.collectorRunFreshness.age)} ago; these numbers are frozen`;
      case "starting":
        return "the collector has not yet completed a full pass";
      case "degraded":
        // Deliberately NOT "these numbers are frozen": most of them are not.
        return host.failedSources.length
          ? `the collector is degraded; ${host.failedSources.join(", ")} not reporting`
          : "the collector is degraded; part of this is not reporting";
    }
    return null;
  });
}

/** bin/verify-host.sh, whose findings are the prose half of the dashboard. */
export function useBatteryStale(): ComputedRef<string | null> {
  const host = useHostStore();
  return computed(() => {
    if (host.statusNeverRun) return "the check battery has never run on this host";
    const f = host.statusFreshness;
    if (f.missing) return "status.json could not be read";
    if (f.stale) return `the battery last ran ${fmt.duration(f.age)} ago`;
    return null;
  });
}
