// =============================================================================
// The segmentation, read once for both views of it
// -----------------------------------------------------------------------------
// /network BECAME TWO VIEWS ON 2026-09-08 and this is the half that could not
// be duplicated. The drawing is graphModel(segmentRows(...)) and the Segments
// table is segmentRows(...) - the SAME array, drawn two ways - so nine of the
// eleven queries below are wanted by both views, and a second copy of the
// shaping is how the map and the table would come to disagree about which
// segment is up. That is not hypothetical: docs/dashboard.md records the System
// page drawing one finding two ways and disagreeing with itself about what
// `note` meant, and ServicesPage's own docblock names the same rule.
//
// SO BOTH VIEWS ASK FOR ALL ELEVEN. /network/map draws nothing from `ports` or
// `unmapped`, and trimming them would buy two instant queries at the price of a
// second return shape; only one child is mounted at a time, so nothing is
// fetched twice. The rule the layouts state - each view asks for the numbers it
// draws - is about the sixteen RANGE queries /system/load owns, not about two
// instants.
// =============================================================================

import { computed, type ComputedRef } from "vue";

import { instant, instantBy, labelsBy, value } from "@/api/prometheus";
import { usePoll } from "@/composables/usePoll";
import { useMetricsStale } from "@/composables/useStaleness";
import type { GraphModel } from "@/graph";
import * as net from "@/network";
import { NETWORK, SERVICES } from "@/queries";
import { PUBLISHED } from "@/topology";

export interface NetworkReadings {
  segments: ComputedRef<net.SegmentRow[]>;
  ports: ComputedRef<net.PortRow[]>;
  attention: ComputedRef<net.AttentionRow[]>;
  lead: ComputedRef<net.LeadReading>;
  conds: ComputedRef<net.ConditionRow[]>;
  tally: ComputedRef<net.Tally>;
  model: ComputedRef<GraphModel>;
  /** Whether the drawing may animate. See the comment on it below. */
  flowing: ComputedRef<boolean>;
}

export function useNetworkReadings(): NetworkReadings {
  const metricsStale = useMetricsStale();

  /**
   * THE UNIT SERIES IS HERE BECAUSE A STOPPED CONTAINER MUST BE RED.
   *
   * `podman ps` lists running containers, so home_server_container_running is
   * ABSENT rather than 0 for one that stopped - it never entered the tone map
   * and every box fell back to grey. Enumerating from home_server_unit_state is
   * the same fix, from the same source, that /services was rebuilt on, and
   * network.ts calls that page's own liveness() rather than restating it.
   */
  const poll = usePoll(async (signal) => {
    const [unitState, unitRestarts, info, running, health, netInfo, attached, ports, rx, tx, unmapped] =
      await Promise.all([
        instantBy(SERVICES.unitState, "unit", signal),
        instantBy(SERVICES.unitRestarts, "unit", signal),
        labelsBy(SERVICES.info, "container", signal),
        instantBy(SERVICES.running, "container", signal),
        instantBy(SERVICES.health, "container", signal),
        instant(NETWORK.info, signal),
        instant(NETWORK.attached, signal),
        instant(NETWORK.ports, signal),
        instant(NETWORK.rx, signal),
        instant(NETWORK.tx, signal),
        instant(NETWORK.unmapped, signal),
      ]);

    const units: net.UnitReading[] = [...unitState].map(([unit, state]) => ({
      unit,
      kind: "",
      state,
      restarts: unitRestarts.get(unit) ?? Number.NaN,
    }));

    const containers: net.ContainerReading[] = [...info].map(([name, labels]) => ({
      name,
      unit: labels.unit ?? "",
      running: running.get(name) === 1,
      health: health.get(name),
    }));

    const networks: net.NetworkReading[] = netInfo.map((s) => ({
      id: s.metric.network ?? "",
      driver: s.metric.driver ?? "",
      subnet: s.metric.subnet ?? "",
      isolate: s.metric.isolate ?? "",
    }));

    const membership = new Map<string, Set<string>>();
    for (const s of attached) {
      const c = s.metric.container;
      const n = s.metric.network;
      if (!c || !n) continue;
      const set = membership.get(c) ?? new Set<string>();
      set.add(n);
      membership.set(c, set);
    }

    const published: net.PortReading[] = ports.map((s) => ({
      container: s.metric.container ?? "",
      hostIp: s.metric.host_ip ?? "",
      hostPort: s.metric.host_port ?? "",
      containerPort: value(s.value),
      protocol: s.metric.protocol ?? "",
    }));

    // Keyed on the PAIR, because neither instantBy nor a single label can
    // express it. Neither a container name nor a network name may contain "|".
    const pair = (series: typeof rx): Map<string, number> => {
      const out = new Map<string, number>();
      for (const s of series) {
        const c = s.metric.container;
        const n = s.metric.network;
        if (c && n) out.set(`${c}|${n}`, value(s.value));
      }
      return out;
    };

    return {
      units,
      containers,
      networks,
      membership,
      published,
      rx: pair(rx),
      tx: pair(tx),
      unmapped: value(unmapped[0]?.value),
    };
  }, 30_000);

  const verdicts = computed(() =>
    net.memberVerdicts(poll.data.value?.units ?? [], poll.data.value?.containers ?? []),
  );

  const segments = computed(() =>
    net.segmentRows(
      poll.data.value?.networks ?? [],
      poll.data.value?.membership ?? new Map(),
      poll.data.value?.rx ?? new Map(),
      poll.data.value?.tx ?? new Map(),
      verdicts.value,
    ),
  );

  const ports = computed(() =>
    net.portRows(
      poll.data.value?.published ?? [],
      PUBLISHED.map((p) => ({ node: p.node, mapping: p.mapping })),
    ),
  );

  const attention = computed(() =>
    net.attentionRows(segments.value, ports.value, poll.data.value?.unmapped ?? Number.NaN),
  );
  const lead = computed(() => net.networkLead(segments.value, ports.value, attention.value));
  const conds = computed(() => net.conditionRows(segments.value, ports.value));
  const tally = computed(() => net.networkTally(segments.value, ports.value));
  const model = computed(() => net.graphModel(segments.value));

  /**
   * MOTION IS THE CLAIM "THIS IS HAPPENING NOW", so a stale reading must stop
   * it. Dimming alone is not enough: the eye reads movement long before it
   * reads opacity, so a dimmed animation still asserts liveness. Three poll
   * intervals of slack, measured against usePoll's own lastOk - which it
   * deliberately does not advance on a failed poll, and which is already stale
   * when a hidden tab comes back, so the frozen state is reached before the
   * first frame renders.
   *
   * IT LIVES HERE RATHER THAN ON /network/map because it reads poll.lastOk, and
   * the poll is the one thing the two views share. Exposing the handle to let a
   * view rebuild this would be a second copy of the 90-second slack.
   */
  const flowing = computed(() => {
    if (metricsStale.value) return false;
    const at = poll.lastOk.value;
    if (!Number.isFinite(at)) return false;
    return Date.now() / 1000 - at < 90;
  });

  return { segments, ports, attention, lead, conds, tally, model, flowing };
}
