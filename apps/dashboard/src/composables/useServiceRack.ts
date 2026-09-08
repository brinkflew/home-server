// =============================================================================
// The rack, derived once for the two views that read it
// -----------------------------------------------------------------------------
// /services BECAME THREE VIEWS ON 2026-09-08, and this is the half the split
// could not be allowed to duplicate. ServicesPage.vue said it in its own
// docblock, before there was anywhere else to put it:
//
//   ONE DERIVATION, TWO VIEWS. "Needs attention" is a FILTER over the same
//   array the rack draws - never a second reading of the same series, which is
//   how the System page came to draw one finding two ways and disagree with
//   itself about what `note` meant.
//
// Putting the filter on /services/health and the rack on /services/list is
// exactly the pressure that produces that second reading, so the derivation
// became one function two views call rather than two copies of ninety lines.
//
// `activity` IS THE ONE THING THEY DO NOT SHARE. The 24-bar CPU strip is the
// only range query on this section and only the rack draws it, so /services/
// health passes false and fires sixteen instants and no range at all - and,
// with it, does not depend on the time window, which is why the WindowPicker
// teleports from the rack view alone.
// =============================================================================

import { computed, type ComputedRef } from "vue";

import { instant, instantBy, labelsBy, range, value } from "@/api/prometheus";
import { usePoll } from "@/composables/usePoll";
import { useTimeWindow } from "@/composables/useTimeWindow";
import { SERVICES } from "@/queries";
import { toPoints } from "@/charts";
import * as svc from "@/services";

/** 24 bars, one per window/24. Sized in ServicesPage's .c-act comment: 24 bars
 *  at 3px with a 2px gap is 118px, which is why the column is 146px. */
export const ACTIVITY_BARS = 24;

export interface ServiceRack {
  rows: ComputedRef<svc.ServiceRow[]>;
  /** Containers with no systemd unit, so absent from every table. */
  unresolved: ComputedRef<number>;
  refresh: () => Promise<void>;
}

export function useServiceRack(opts: { activity: boolean }): ServiceRack {
  const { window: win } = useTimeWindow();

  const poll = usePoll(async (signal) => {
    const end = Math.floor(Date.now() / 1000);
    const step = Math.max(60, Math.round(win.value.seconds / ACTIVITY_BARS));

    const [
      unitState,
      unitRestarts,
      info,
      running,
      health,
      restarts,
      startTime,
      cpu,
      memory,
      memHigh,
      memLimit,
      refault,
      stallSome,
      stallFull,
      oom,
      unresolved,
      activity,
    ] = await Promise.all([
      // instant(), not instantBy(): this one needs the VALUE and two labels, and
      // `kind` is what keeps a healthy oneshot .network unit out of the rack.
      instant(SERVICES.unitState, signal),
      instantBy(SERVICES.unitRestarts, "unit", signal),
      labelsBy(SERVICES.info, "container", signal),
      instantBy(SERVICES.running, "container", signal),
      instantBy(SERVICES.health, "container", signal),
      instantBy(SERVICES.restarts, "container", signal),
      instantBy(SERVICES.startTime, "container", signal),
      instantBy(SERVICES.cpu, "container", signal),
      instantBy(SERVICES.memory, "container", signal),
      instantBy(SERVICES.memoryHigh, "container", signal),
      instantBy(SERVICES.memoryLimit, "container", signal),
      instantBy(SERVICES.memoryRefault, "container", signal),
      // THE ARBITER, read here for the first time on 2026-09-08. Until then the
      // rack decided "memory starved" on the refault rate alone, with a floor of
      // zero, and drew a mean of nine of twenty-seven rows amber on a host whose
      // worst container was at 58% of its watermark. See memoryTone().
      instantBy(SERVICES.memoryStallSome, "container", signal),
      instantBy(SERVICES.memoryStallFull, "container", signal),
      instantBy(SERVICES.oomKills, "container", signal),
      instant(SERVICES.identityUnresolved, signal),
      opts.activity
        ? range(SERVICES.cpu, { window: step * ACTIVITY_BARS, step, signal })
        : Promise.resolve([]),
    ]);

    const bars = new Map<string, number[]>();
    for (const s of activity) {
      const key = s.metric.container;
      if (key) bars.set(key, toPoints(s.values).map(([, v]) => v));
    }

    const units: svc.UnitReading[] = unitState
      .filter((s) => s.metric.unit)
      .map((s) => ({
        unit: s.metric.unit,
        kind: s.metric.kind ?? "container",
        state: value(s.value),
        restarts: unitRestarts.get(s.metric.unit) ?? Number.NaN,
      }));

    const containers: svc.ContainerReading[] = [...info.entries()].map(([name, labels]) => ({
      name,
      unit: labels.unit ?? "",
      image: labels.image ?? "",
      running: (running.get(name) ?? 0) === 1,
      // `undefined` means the series is absent, which @/health reads as
      // "unchecked". `?? 0` here would report three containers as verified healthy
      // on the strength of no evidence at all.
      health: health.get(name),
      podmanRestarts: restarts.get(name) ?? Number.NaN,
      cpu: cpu.get(name) ?? Number.NaN,
      memory: memory.get(name) ?? Number.NaN,
      memoryHigh: memHigh.get(name) ?? Number.NaN,
      memoryLimit: memLimit.get(name) ?? Number.NaN,
      refault: refault.get(name) ?? Number.NaN,
      // NaN RATHER THAN 0, for the reason stated above `health`: memoryTone reads
      // a missing pressure series as unmeasured and answers `off`. `?? 0` here
      // would say every container is verified not to be stalling, on no evidence.
      stallSome: stallSome.get(name) ?? Number.NaN,
      stallFull: stallFull.get(name) ?? Number.NaN,
      oomKills: oom.get(name) ?? Number.NaN,
      uptime: end - (startTime.get(name) ?? Number.NaN),
      activity: bars.get(name) ?? [],
    }));

    return { rows: svc.serviceRows(units, containers), unresolved: value(unresolved[0]?.value) };
  }, 30_000);

  return {
    rows: computed(() => poll.data.value?.rows ?? []),
    unresolved: computed(() => poll.data.value?.unresolved ?? Number.NaN),
    refresh: poll.refresh,
  };
}
