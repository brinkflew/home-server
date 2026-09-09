<script setup lang="ts">
/**
 * /system/storage: will the disks hold?
 *
 * THREE THINGS ABOUT THE SAME DATA, which is why they are one view. A mount
 * filling up, a drive reporting itself sick and a backup that stopped running
 * are three ways of losing the same bytes, and they were spread across two
 * bands two thirds of a page apart with the machinery in between.
 *
 * THE HEADLINE IS THE FULLEST MOUNT AND ITS TONE IS ALL THREE. A half-empty
 * disk whose SMART says it is failing must not read teal, so storageLead grades
 * the mounts, every drive and every backup age and takes the worst - hostLead's
 * rule, applied to what this view actually shows. See src/system.ts.
 *
 * THE MOUNT ARITHMETIC IS SHARED WITH /system/health, which draws the fullest
 * mount as one of its three conditions. sys.mountReading and sys.fullestMount
 * are the one derivation; a second copy is how the two views would come to
 * disagree about which mount is full.
 */
import { computed, onUnmounted, watch } from "vue";

import Band from "@/components/Band.vue";
import PanelBox from "@/components/PanelBox.vue";
import MetricChart from "@/components/MetricChart.vue";
import StatusDot from "@/components/StatusDot.vue";
import WindowPicker from "@/components/WindowPicker.vue";

import { usePoll } from "@/composables/usePoll";
import { useMetricsStale } from "@/composables/useStaleness";
import { useTimeWindow } from "@/composables/useTimeWindow";
import { useCrosshair } from "@/composables/useCrosshair";
import { useHostStore } from "@/stores/host";
import { instant, instantBy, labelsBy, range, value } from "@/api/prometheus";
import { onGrid, toPoints } from "@/charts";
import type { Point } from "@/charts";
import { SYSTEM } from "@/queries";
import * as sys from "@/system";
import { checkTone } from "@/health";
import * as fmt from "@/format";
import type { Tone } from "@/types";

const host = useHostStore();
const metricsStale = useMetricsStale();

// ---------------------------------------------------------------------------
// Drives, filesystems and SMART
// ---------------------------------------------------------------------------
const storage = usePoll(async (signal) => {
  const [info, health, temp, hours, wear, realloc, pending, media, size, avail] = await Promise.all([
    labelsBy(SYSTEM.disksInfo, "device", signal),
    instantBy(SYSTEM.diskHealth, "device", signal),
    instantBy(SYSTEM.diskTemp, "device", signal),
    instantBy(SYSTEM.diskHours, "device", signal),
    instantBy(SYSTEM.diskWear, "device", signal),
    instantBy(SYSTEM.diskReallocated, "device", signal),
    instantBy(SYSTEM.diskPending, "device", signal),
    instantBy(SYSTEM.diskMediaErrors, "device", signal),
    instant(SYSTEM.filesystems, signal),
    instantBy(SYSTEM.filesystemAvail, "mountpoint", signal),
  ]);

  const filesystems = size.map((s) => {
    const mountpoint = s.metric.mountpoint ?? "?";
    return {
      ...sys.mountReading(mountpoint, value(s.value), avail.get(mountpoint) ?? Number.NaN),
      device: s.metric.device ?? "",
    };
  });

  // `healthy` IS THREE-VALUED AND USED TO BE TWO. `health.get(device) === 1`
  // collapsed "this drive reports itself unhealthy" into "no health series came
  // back for this drive", and smartLine's first branch then drew the second one
  // in red as the first. See src/system.ts.
  const drives: sys.Drive[] = [...info.entries()].map(([device, labels]) => {
    const h = health.get(device);
    return {
      device,
      model: labels.model ?? "",
      healthy: h === undefined ? null : h === 1,
      temp: temp.get(device) ?? Number.NaN,
      hours: hours.get(device) ?? Number.NaN,
      wear: wear.get(device) ?? Number.NaN,
      realloc: realloc.get(device) ?? Number.NaN,
      pending: pending.get(device) ?? Number.NaN,
      mediaErrors: media.get(device) ?? Number.NaN,
    };
  });

  return { drives, filesystems };
}, 60_000);

const mounts = computed(() => storage.data.value?.filesystems ?? []);
const drives = computed(() => storage.data.value?.drives ?? []);

const backupRows = computed(() =>
  sys.BACKUPS.map((b) => ({
    ...b,
    age: host.factAge(b.key),
    at: fmt.sinceIso(host.fact(b.key) as string, host.now),
    tone: sys.backupTone(host.factAge(b.key), b.limit),
  })),
);

const lead = computed(() =>
  sys.storageLead(
    mounts.value,
    drives.value,
    backupRows.value.map((b) => b.tone),
  ),
);

function toneClass(tone: Tone): Record<string, boolean> {
  return { bad: tone === "fail", warnish: tone === "warn", dim: tone === "off" };
}

function rail(tone: Tone): string {
  return tone === "ok" ? "transparent" : `var(--${tone})`;
}
// ---------------------------------------------------------------------------
// What fills /var, over time
// ---------------------------------------------------------------------------
/**
 * THE QUESTION THE MOUNT TABLE ABOVE CANNOT ANSWER. It says /var is 64% full;
 * it cannot say what put it there, and until bin/storage-census.sh existed
 * nothing on this host could - finding out took an ssh session and six du's.
 *
 * THE BANDS SUM TO THE VOLUME, WHICH IS WHAT MAKES yMax HONEST. The census's
 * named consumers add to df's used figure by construction and publish whatever
 * no consumer claims as other_unaccounted, so used + free is the whole disk.
 * MetricChart's own docblock says a stack is only honest with a yMax naming the
 * total its bands add up to - see LoadPage's memory stack against MemTotal.
 *
 * HOURLY DATA ON A CHART THAT CAN SHOW AN HOUR. The census walks once an hour,
 * so a 1h window is two points and a flat line means "low resolution", not "a
 * still machine". The aside says so rather than leaving it to be inferred.
 */
const { window: win } = useTimeWindow();
const cross = useCrosshair();
onUnmounted(() => cross.clear());

const growth = usePoll(
  async (signal) => {
    const end = Math.floor(Date.now() / 1000);
    const start = end - win.value.seconds;
    const step = win.value.step;
    const opts = { window: win.value.seconds, step, signal };

    const [groups, free, committed, capacity] = await Promise.all([
      range(SYSTEM.varByGroup, opts),
      range(SYSTEM.filesystemAvail + '{mountpoint="/var"}', opts),
      instant(SYSTEM.varCommitted, signal),
      instant(SYSTEM.varCapacity, signal),
    ]);

    // ONE SORT, NOT TWO: the label and its line come out of the same map, which
    // is the pairing LoadPage's splitBy comment exists to protect.
    const byGroup = new Map<string, Point[]>();
    for (const m of groups) {
      const key = m.metric.group;
      if (key) byGroup.set(key, onGrid(toPoints(m.values), start, end, step));
    }
    return {
      byGroup,
      free: free.length ? onGrid(toPoints(free[0].values), start, end, step) : [],
      committed: value(committed[0]?.value),
      capacity: value(capacity[0]?.value),
      // FROM THE SAME PASS THAT BUILT THE POINTS. Deriving the axis from
      // Date.now() at render time instead lets the frame and the data describe
      // different spans on a slow poll.
      start,
      end,
    };
  },
  60_000,
);

// The window is read inside the loader, so a change to it would otherwise not
// show until the next tick - which reads as a dead button. LoadPage carries the
// identical watch for the identical reason.
watch(win, () => {
  void growth.refresh();
});

const from = computed(() => growth.data.value?.start);
const to = computed(() => growth.data.value?.end);

const varSeries = computed(() =>
  sys.varStack(growth.data.value?.byGroup ?? new Map(), growth.data.value?.free ?? []),
);

/** The one finding this band exists for: every ceiling on the volume, added up.
 *  Its tone comes from the check rather than a ratio recomputed here - a second
 *  opinion about one fact is how a rail comes to disagree with the sentence
 *  beside it, which is why checkTone() is the single mapping. */
const commitment = computed(() => {
  const committed = growth.data.value?.committed ?? Number.NaN;
  const capacity = growth.data.value?.capacity ?? Number.NaN;
  const check = host.byId.get("capacity.var_commitment");
  if (!Number.isFinite(committed) || !Number.isFinite(capacity) || capacity <= 0) {
    return { text: fmt.NO_DATA, sub: "the census has not reported a commitment", tone: "off" as Tone };
  }
  return {
    text: `${fmt.percent(committed / capacity, 0)} committed`,
    sub: `${fmt.bytes(committed)} of ${fmt.bytes(capacity)} if every capped consumer reached its ceiling`,
    // A check that is not in the document is GREY, not green. The battery may
    // not have run since the census landed, and reporting an unmeasured
    // commitment as healthy is the absence-read-as-health defect this
    // repository has recorded four times.
    tone: check ? checkTone(check.status) : ("off" as Tone),
  };
});
</script>

<template>
  <Teleport defer to="#toolbar">
    <WindowPicker />
  </Teleport>

  <!-- "Headroom", not "Right now": that is the Health band one tab over, and
       this word is also what the fullest mount actually reports. -->
  <Band label="Headroom">
    <template #aside>
      <span class="mono">
        <span class="count">{{ mounts.length }}</span> mounts,
        <span class="count">{{ drives.length }}</span> drives
      </span>
    </template>

    <PanelBox :stale="metricsStale">
      <div class="lead">
        <StatusDot :tone="lead.tone" :live="lead.live" :size="9" />
        <span class="reading mono">{{ lead.text }}</span>
      </div>
      <p class="lead-sub mono">{{ lead.sub }}</p>
    </PanelBox>
  </Band>

  <!-- BETWEEN "how full" AND "what hardware", because that is the causal order:
       the mount table says /var is filling, this says what is filling it, and
       the drives below are what it all sits on. -->
  <Band label="Growth" :cols="2">
    <PanelBox label="What fills /var" :stale="metricsStale">
      <template #aside>
        <span class="mono cap">hourly census</span>
      </template>
      <MetricChart
        :series="varSeries"
        :height="120"
        :y-max="growth.data.value?.capacity"
        stacked
        legend
        y-axis
        x-axis
        :tick-base="1024"
        :format="(v: number) => fmt.bytes(v, 0)"
        :from="from"
        :to="to"
      />
    </PanelBox>

    <PanelBox label="Commitment" :stale="metricsStale">
      <template #aside>
        <span class="mono cap">every ceiling, added up</span>
      </template>
      <div class="lead">
        <StatusDot :tone="commitment.tone" :size="9" />
        <span class="reading mono">{{ commitment.text }}</span>
      </div>
      <p class="lead-sub mono">{{ commitment.sub }}</p>
      <!-- THE NUMBER NOTHING WAS COMPUTING. Every consumer of /var was sized
           against the free space on the day it was written and no two were ever
           added together, so on 2026-09-09 four ceilings between them committed
           more than the disk had left while every check read green. -->
      <p class="lead-sub mono">
        Uncapped consumers contribute only what they hold today, so this is a
        floor. Raising a ceiling raises it.
      </p>
    </PanelBox>
  </Band>

  <!-- Two tables of the same shape, which is what a band of equal columns is
       for. They were a 1fr 1fr 340px row whose third column held two more
       panels stacked inside it, and that inner column flipped to a ROW at 1280
       and stayed one at 375 - the fold with no floor docs/dashboard.md names.
       Band's own 1180 rung replaces the whole arrangement. -->
  <Band label="Hardware" :cols="2">
    <PanelBox label="Mounts" :stale="metricsStale">
      <p v-if="!mounts.length" class="empty mono">no filesystem reported</p>
      <table v-else class="tbl">
        <thead>
          <tr>
            <th class="c-rail" />
            <th class="c-mount p2">Mount</th>
            <th class="c-used">Used</th>
          </tr>
        </thead>
        <tbody>
          <tr
            v-for="f in mounts"
            :key="f.mountpoint"
            class="tight"
            :style="{ '--rail': rail(sys.fsTone(f.ratio)) }"
          >
            <td class="rail" />
            <td class="c-mount p2"><span class="mono">{{ f.mountpoint }}</span></td>
            <!-- THE METER COLUMN IS DELIBERATELY UNWIDENED so the bars are
                 comparable: under table-layout: fixed a specified width would
                 make one mount's bar a different scale from the next one's. -->
            <td>
              <!-- THE PATH RELOCATES RATHER THAN WRAPPING. Its own column is
                   176px and a phone has about 330 for the whole table, so
                   "/var/lib/containers" broke as "/var/lib/contai / ners" -
                   the exact failure .c-mount's width exists to prevent, one
                   rung down. Folded here it has the full row. -->
              <div class="fold2 mpath mono">{{ f.mountpoint }}</div>
              <div class="meter">
                <div class="bar">
                  <span
                    class="fill"
                    :style="{
                      width: `${Math.min(100, (f.ratio || 0) * 100).toFixed(1)}%`,
                      background: `var(--${sys.fsTone(f.ratio)})`,
                    }"
                  />
                </div>
                <div class="mono mread">
                  <span :class="toneClass(sys.fsTone(f.ratio))">{{ fmt.percent(f.ratio, 0) }}</span>
                  of {{ fmt.bytes(f.total) }}, {{ fmt.bytes(f.free) }} free
                </div>
              </div>
            </td>
          </tr>
        </tbody>
      </table>
    </PanelBox>

    <PanelBox label="Drives and SMART" :stale="metricsStale">
      <p v-if="!drives.length" class="empty mono">no drive reported</p>
      <table v-else class="tbl">
        <thead>
          <tr>
            <th class="c-rail" />
            <th class="c-dev">Drive</th>
            <th class="c-temp r">Temp</th>
            <th class="c-hours r p3">Powered</th>
          </tr>
        </thead>
        <tbody>
          <tr
            v-for="d in drives"
            :key="d.device"
            class="tight"
            :style="{ '--rail': rail(sys.smartLine(d).tone) }"
          >
            <td class="rail" />
            <td>
              <div class="dev mono">{{ d.device }}</div>
              <div class="model mono truncate" :title="d.model">{{ d.model }}</div>
              <!-- Not clamped: this sentence is the reason the row exists. -->
              <div class="smart mono" :class="toneClass(sys.smartLine(d).tone)">
                {{ sys.smartLine(d).text }}
              </div>
              <span class="fold3 subline mono">{{ fmt.powerOnHours(d.hours) }}</span>
            </td>
            <td class="r c-temp"><span class="mono">{{ fmt.celsius(d.temp) }}</span></td>
            <td class="r p3 c-hours"><span class="mono dim">{{ fmt.powerOnHours(d.hours) }}</span></td>
          </tr>
        </tbody>
      </table>
    </PanelBox>
  </Band>

  <!-- A BACKUP IS A STORAGE FACT, which is why it is on this view rather than
       beside the uptime strip it used to sit next to: the question it answers
       is "will I get these bytes back", not "was the machine up". -->
  <Band label="Backups">
    <template #aside><span>three copies and a proof</span></template>

    <PanelBox :stale="metricsStale">
      <table class="tbl">
        <thead>
          <tr>
            <th class="c-rail" />
            <th class="c-bname">Copy</th>
            <th class="c-bage r">Last</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="b in backupRows" :key="b.key" class="tight" :style="{ '--rail': rail(b.tone) }">
            <td class="rail" />
            <td><span class="mono">{{ b.label }}</span></td>
            <td class="r"><span class="mono" :class="toneClass(b.tone)">{{ b.at }}</span></td>
          </tr>
        </tbody>
      </table>
    </PanelBox>
  </Band>
</template>

<style scoped>
/* --- the header ----------------------------------------------------------- */

.lead {
  display: flex;
  align-items: center;
  gap: 10px;
  min-width: 0;
}

.reading {
  font: var(--t-mono-xl);
  color: var(--fg);
}

.lead-sub {
  margin-top: 7px;
  font: var(--t-mono-sm);
  color: var(--fg-5);
}

.bad {
  color: var(--fail-text);
}

.warnish {
  color: var(--warn);
}

.dim {
  color: var(--fg-5);
}

/* A CAPTION, WHICH IS NOT THE SAME THING AS `.dim` even though it looks like
   it. base.css's global `.dim` means STALE - 0.42 opacity and desaturated - and
   it ADDS to the scoped colour rule above rather than replacing it, so a label
   that merely wants to be quiet would render as though its panel had stopped
   updating. The distinction is one docs/dashboard.md already records. */
.cap {
  color: var(--fg-5);
}

/* --- the tables ----------------------------------------------------------- */

.c-rail {
  width: 30px;
}

/* A MOUNTPOINT IS THE ROW'S IDENTITY AND MUST NOT WRAP MID-PATH.
   "/var/lib/containers" is 152px at --t-mono-sm; this host's own longest is
   "/var/mnt/media" at 112, and sizing to the shorter one is how a perfectly
   ordinary podman-storage mount would have rendered as "/var/lib/c ontainers". */
.c-mount {
  width: 176px;
}

/* THE USED COLUMN IS UNWIDENED, and that is what makes the bars comparable:
   a specified width would give one mount's meter a different scale from the
   next one's, which is the trap /ci paid for with a 104px store column beside
   a 526px disk one.

   AND THERE IS NO `Free` COLUMN. It was a third column of six characters that
   pushed the mountpoint into wrapping, so it reads inside the meter's own line
   instead - which is also where the reader is already looking. */

.c-dev {
  width: auto;
}

.c-temp {
  width: 64px;
}

/* "4.7y powered" is 96px at --t-mono-sm. */
.c-hours {
  width: 120px;
}

.c-bname {
  width: auto;
}

/* "33d 00h ago" is 88px, and the off-site prune is the row that reaches it. */
.c-bage {
  width: 116px;
}

.meter {
  display: flex;
  flex-direction: column;
  gap: 4px;
  min-width: 0;
}

.mread {
  font: var(--t-mono-xs);
  color: var(--fg-5);
}

.mpath {
  font: var(--t-mono-sm);
  color: var(--fg-2);
  margin-bottom: 7px;
}

.bar {
  height: 6px;
  border-radius: 3px;
  background: var(--track);
  overflow: hidden;
}

.fill {
  display: block;
  height: 100%;
  background: var(--ok);
}

.subline {
  margin-top: 4px;
  font: var(--t-mono-xs);
  color: var(--fg-5);
}

.dev {
  font: var(--t-mono-md);
  color: var(--fg-2);
}

.model {
  font: var(--t-mono-xs);
  color: var(--fg-5);
  margin-top: 2px;
}

/* INLINE-BLOCK, so the box hugs its sentence. Stretched to the width of the
   cell it read as an empty input rather than as a reading, and the three
   sentences it can hold differ in length by a factor of two. */
.smart {
  display: inline-block;
  margin-top: 7px;
  padding: 6px 8px;
  border-radius: var(--r-xs);
  font: var(--t-mono-xs);
  background: var(--fill);
  color: var(--fg-3);
}

.smart.warnish {
  background: var(--warn-tint);
}

.smart.bad {
  background: var(--fail-tint);
}

.empty {
  font: var(--t-mono-sm);
  color: var(--fg-dim);
  padding: 6px 4px;
}

/* --- the phone ------------------------------------------------------------ */

@media (max-width: 640px) {
  /* THE RAIL NEEDS ITS WIDTH BACK ON THE CELL ONCE THE HEADER IS GONE. Under
     table-layout: fixed the column widths come from the first row, and
     `display: none` on the thead makes that the first BODY row - which carries
     no widths, so the surviving columns split evenly. */
  .tbl td.rail {
    width: 30px;
  }

  .tbl thead {
    display: none;
  }

  .c-bage,
  .c-dev {
    width: auto;
  }
}
</style>
