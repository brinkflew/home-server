<script setup lang="ts">
/**
 * /services/list: what is each service doing?
 *
 * THE RACK WAS THE PAGE, and this view is the whole reason /services was split.
 * Nineteen units by eight columns, each row carrying a 24-bar CPU strip, a
 * three-line memory cell and a restart caption, is the tallest thing this
 * application draws after the network map - and it sat between the sentence
 * that says what to type and the panel that says what the battery found.
 *
 * IT IS ENUMERATED FROM home_server_unit_state, NOT FROM THE CONTAINERS.
 * `podman ps` lists RUNNING containers, so a service that stopped did not go
 * red here, it VANISHED - and the rack was at its emptiest exactly when it
 * mattered most. A container is joined ONTO a unit rather than the other way
 * round; src/services.ts carries the argument.
 *
 * THREE THINGS THAT WERE ON SCREEN AND MEANT NOTHING, all fixed before the
 * split and worth keeping written down here because this is where they were:
 *
 *   - The RESTARTS column read podman's counter, which is reset when a quadlet
 *     recreates the container - so it is 0 throughout a restart loop and read 0
 *     through all 6,224 of Pocket ID's. systemd's NRestarts is the one that
 *     survives, and it was on no page in this application.
 *   - `pod {{ row.pod }}` was dead code. podman fills `Pod` with an id and not
 *     `PodName`, so home_server_container_info{pod} is "" for every container on
 *     this host - perfect in the fixtures, absent on the server. Pod membership
 *     comes from topology now.
 *   - THREE LEDS WITH NO LEGEND ANYWHERE, whose leftmost had a state nobody can
 *     guess: grey meant "no health check is defined", which is not the same as
 *     one that passed. There is one dot now and the state is a WORD beside it.
 *
 * THE WINDOW PICKER IS HERE AND NOWHERE ELSE ON THIS SECTION. The activity
 * strip is the only thing in /services that reads the time window, so its two
 * siblings teleport none - a picker that changes nothing on screen is a lie
 * about a control.
 *
 * NO LEAD, DELIBERATELY. The rack is sorted worst-first and every row carries
 * its own tone, so a headline over it would be a second reading of the same
 * array - the defect docs/dashboard.md records for the System page. The one
 * headline reading is on /services/health, over the filter of this same array.
 */
import { computed, watch } from "vue";

import ActivityBars from "@/components/ActivityBars.vue";
import Band from "@/components/Band.vue";
import ChipLink from "@/components/ChipLink.vue";
import PanelBox from "@/components/PanelBox.vue";
import StatusDot from "@/components/StatusDot.vue";
import WindowPicker from "@/components/WindowPicker.vue";

import { useMetricsStale } from "@/composables/useStaleness";
import { ACTIVITY_BARS, useServiceRack } from "@/composables/useServiceRack";
import { useTimeWindow } from "@/composables/useTimeWindow";
import { useTooltip } from "@/composables/useTooltip";
import { appHome } from "@/links";
import * as fmt from "@/format";
import * as svc from "@/services";
import type { Tone } from "@/types";

const { window: win } = useTimeWindow();
const tip = useTooltip();
const metricsStale = useMetricsStale();
const { rows, refresh } = useServiceRack({ activity: true });

watch(win, () => {
  void refresh();
});

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

/**
 * The one caveat that cannot be inferred from the word beside it: grey is not
 * green. home_server_container_health is ABSENT for duckdns, unpackerr and the
 * pod's infra container, so "unchecked" means nobody is looking - which is a
 * different thing from passing, and the only place it would otherwise be
 * written down is a source file.
 */
function stateTip(row: svc.ServiceRow) {
  return {
    title: row.name,
    lines: [row.state, row.image || row.unit],
    caveat:
      row.tone === "off" && row.present
        ? "Grey is not green. This container defines no health check, so nobody is checking it - which is a different thing from passing."
        : undefined,
  };
}

/** The same for every row, so it is computed once rather than rebuilt
 *  twenty-eight times on each render. */
const activityTip = computed(() => ({
  title: `CPU, last ${win.value.label}`,
  lines: [
    `${ACTIVITY_BARS} bars, one per ${fmt.duration(Math.round(win.value.seconds / ACTIVITY_BARS))}`,
    "scaled to this row's own peak, not to the rack",
  ],
  caveat: "A grey bar is a missing sample, not an idle one.",
}));

/**
 * WHICH GREY IT IS. `off` on the memory tone has two causes and the caption
 * cannot show both: no MemoryHigh declared at all - the pod's infra container -
 * or a ceiling with no pressure series behind it. The second is the one worth
 * saying out loud, because it means the reading that decides this row is
 * missing rather than reassuring.
 */
function memoryTip(row: svc.ServiceRow) {
  const lines = [
    `${fmt.bytes(row.memory)} working set, MemoryHigh ${fmt.bytes(row.memoryHigh)}, MemoryMax ${fmt.bytes(row.memoryLimit)}`,
    "working set is memory.current minus cold page cache - not usage_bytes",
    // THE COMMAND THE REMEDY COLUMN CANNOT HOLD. 101 characters, which wraps
    // mid-flag at .c-remedy's 380px; nothing here is that narrow.
    `cat /sys/fs/cgroup$(systemctl --user show ${row.unit} -p ControlGroup --value)/memory.pressure`,
  ];
  if (!Number.isFinite(row.stallSome)) {
    return {
      title: "pressure not measured",
      lines,
      caveat:
        "No memory PSI series for this container, so nothing here can say whether it is stalling. Grey is not green.",
    };
  }
  return {
    title: `stalled ${fmt.percent(row.stallSome, 2)} of the time`,
    lines: [
      ...lines,
      `PSI full ${fmt.percent(row.stallFull, 2)} - every runnable task delayed`,
      "sitting at MemoryHigh is not news; stalling on it is",
    ],
  };
}

function restartTip(row: svc.ServiceRow) {
  return {
    title: `${fmt.number(row.unitRestarts)} restart(s)`,
    lines: [
      "systemd's NRestarts, which survives the container being recreated",
      "it resets on a clean start, so this is about now rather than ever",
    ],
    caveat:
      Number.isFinite(row.podmanRestarts) && row.podmanRestarts > 0
        ? `podman separately counts ${fmt.number(row.podmanRestarts)} for this container, which is a restart systemd did not order.`
        : undefined,
  };
}

/** The application's own page, where it has one. */
function open(row: svc.ServiceRow): string | null {
  return row.app ? appHome(row.app) : null;
}
</script>

<template>
  <Teleport defer to="#toolbar">
    <WindowPicker />
  </Teleport>

  <!-- "Every service", not "Services": the sub-nav segment above it already
       says Services, and a band that repeats its own tab names nothing. The
       same correction this document records for the Fleet band. -->
  <Band label="Every service">
    <template #aside><span>{{ rows.length }} rows, worst first then busiest</span></template>

    <PanelBox :stale="metricsStale">
      <p v-if="!rows.length" class="empty mono">no unit and no container reported</p>

      <table v-else class="tbl">
        <thead>
          <tr>
            <th class="c-rail" />
            <th>Service</th>
            <th class="c-image p4">Image</th>
            <th class="c-act p3">Activity</th>
            <th class="c-cpu r p2">CPU</th>
            <th class="c-mem r p2">Memory</th>
            <th class="c-rst r p3">Restarts</th>
            <th class="c-up r p2">Uptime</th>
          </tr>
        </thead>
        <tbody>
          <tr
            v-for="row in rows"
            :key="row.unit || row.name"
            class="hov"
            :style="{ '--rail': rail(row.tone) }"
          >
            <td class="rail">
              <StatusDot :tone="row.tone" :live="row.tone === 'fail'" glow :size="6" />
            </td>

            <td>
              <div class="ident">
                <span class="sname">{{ row.name }}</span>
                <ChipLink
                  v-if="row.app"
                  label="open"
                  :href="open(row)"
                  :title="`open ${row.name}'s own interface`"
                />
              </div>

              <div class="sstate mono" :class="toneClass(row.tone)" v-bind="tip.hover(`st-${row.name}`, stateTip(row))">
                {{ row.state }}<span v-if="row.role" class="role"> . {{ row.role }}</span>
              </div>

              <!-- The meta line, and everything a dropped column handed over.
                   Each fold appears only once its own column has gone. -->
              <div class="smeta mono">
                <span>{{ fmt.unitName(row.unit) }}</span>
                <span v-if="row.pod">pod {{ row.pod }}</span>
                <span v-else-if="row.networks.length">{{ row.networks.join(" ") }}</span>
                <span v-if="row.image" class="fold4 truncate">{{ fmt.shortImage(row.image) }}</span>
                <span v-if="row.unitRestarts > 0" class="fold3 warnish">
                  {{ fmt.number(row.unitRestarts) }} restart(s)
                </span>
                <span class="fold2">cpu {{ fmt.percent(row.cpu, 1) }}</span>
                <span class="fold2">mem {{ fmt.bytes(row.memory) }}</span>
                <span class="fold2">up {{ fmt.duration(row.uptime) }}</span>
              </div>
            </td>

            <td class="c-image p4">
              <span class="mono image truncate" :title="row.image">{{ fmt.shortImage(row.image) }}</span>
            </td>

            <td class="c-act p3">
              <span v-bind="tip.hover(`act-${row.name}`, activityTip)">
                <ActivityBars :values="row.activity" :tone="row.tone === 'off' ? 'off' : row.tone" :height="20" />
              </span>
            </td>

            <td class="c-cpu r p2"><span class="mono num">{{ fmt.percent(row.cpu, 1) }}</span></td>

            <td class="c-mem r p2">
              <div class="mono num">{{ fmt.bytes(row.memory) }}</div>
              <!-- A CONTAINER AT ITS MemoryHigh IS NOT NEWS, and colouring one
                   amber is the likeliest way this page would cry wolf. The
                   tone is the memory PSI and the OOM counter; see
                   memoryTone(). It was the refault rate with a floor of zero
                   until 2026-09-08, which drew a mean of nine of these
                   twenty-seven rows amber on a quiet host.

                   SUPPRESSED RATHER THAN DASHED. With no container there is no
                   ratio, and "- of high" is a sentence about a ceiling that is
                   not being approached by anything. One dash above it already
                   says the row has no reading.

                   A SECOND CAPTION LINE, NEVER A SUFFIX ON THE FIRST - see
                   memorySubline(), which owns the choice between the hard
                   limit and "stall not measured". Drawing MemoryMax at all is
                   the point: every unit here has another 33-50% of headroom
                   above the watermark the first ratio is taken against, so
                   "58% of high" on its own reads worse than it is. -->
              <div
                v-if="Number.isFinite(svc.memoryRatio(row))"
                class="mono cap"
                :class="toneClass(row.memoryTone)"
                v-bind="tip.hover(`mem-${row.name}`, memoryTip(row))"
              >
                {{ fmt.percent(svc.memoryRatio(row), 0) }} of high
              </div>
              <div v-if="svc.memorySubline(row)" class="mono cap dull">
                {{ svc.memorySubline(row) }}
              </div>
            </td>

            <td class="c-rst r p3">
              <span
                class="mono num"
                :class="{ warnish: row.unitRestarts > 0 }"
                v-bind="tip.hover(`rst-${row.name}`, restartTip(row))"
              >
                {{ fmt.number(row.unitRestarts) }}
              </span>
              <div v-if="svc.restartLine(row)" class="mono cap dull">{{ svc.restartLine(row) }}</div>
            </td>

            <td class="c-up r p2"><span class="mono num dull">{{ fmt.duration(row.uptime) }}</span></td>
          </tr>
        </tbody>
      </table>
    </PanelBox>
  </Band></template>

<style scoped>
/* --- the columns ---------------------------------------------------------- */

.c-rail {
  width: 30px;
}

/* "lscr.io/linuxserver/qbittorrent:libtorrentv1" shortens to 36 characters,
   which is 216px at --t-mono-sm; anything longer truncates and keeps the full
   reference on its title. */
.c-image {
  width: 200px;
}

/* 118px OF BARS PLUS 24px OF CELL PADDING, AND THE FIRST NUMBER IS ARITHMETIC
   RATHER THAN AN ESTIMATE: 24 bars at 3px with a 2px gap between them is
   24*3 + 23*2. At 96px the strip overflowed its own cell and drew straight
   through the CPU reading beside it - a fixed table column clips nothing, and
   ActivityBars keeps its bars 3px wide on purpose so that every row's strip is
   comparable. */
.c-act {
  width: 146px;
}

/* "390.0%" - a rate, so a container using four cores reads above 100. */
.c-cpu {
  width: 76px;
}

/* THREE lines now: "2.99 GB" over "100% of high" over "67% of max". The third
   arrived on 2026-09-08 and needed no width - "100% of high" is the longest
   string this cell can produce and 132px was already measured for it, so the
   max line fits inside a bound that was set for the line above it. It is a
   third ROW rather than a suffix on the second deliberately: `58% of high -
   39% of max` is ~150px, and a fixed table column clips rather than wraps. */
.c-mem {
  width: 132px;
}

/* "2 by podman" is 73px at --t-mono-xs, and it is a second line under the
   count rather than beside it. */
.c-rst {
  width: 104px;
}

/* "41d 06h". */
.c-up {
  width: 88px;
}

/* --- the identity cell ---------------------------------------------------- */

.ident {
  display: flex;
  align-items: center;
  gap: 8px;
  min-width: 0;
}

.sname {
  font: var(--t-ui-md);
  color: var(--fg);
}

.sstate {
  margin-top: 2px;
  font: var(--t-mono-xs);
}

/* The role is what a reader of twenty-eight infrastructure containers most
   needs and never had: "reverse proxy, the only multi-homed thing here". It
   takes the dim tier so the state word still reads as the state. */
.role {
  color: var(--fg-5);
}

.smeta {
  display: flex;
  flex-wrap: wrap;
  gap: 4px 10px;
  margin-top: 4px;
  font: var(--t-mono-xs);
  color: var(--fg-5);
  min-width: 0;
}

/* The folds are flex items in the meta line, so they lay out inline rather than
   as the blocks base.css makes them. */
.smeta .fold4,
.smeta .fold3,
.smeta .fold2 {
  display: none;
}

@media (max-width: 1180px) {
  .smeta .fold4 {
    display: inline;
  }
}

@media (max-width: 900px) {
  .smeta .fold3 {
    display: inline;
  }
}

@media (max-width: 640px) {
  .smeta .fold2 {
    display: inline;
  }
}

/* --- the readings --------------------------------------------------------- */

.image {
  font: var(--t-mono-sm);
  color: var(--fg-4);
  display: block;
}

.num {
  font: var(--t-mono-md);
  color: var(--fg-2);
}

.cap {
  display: block;
  margin-top: 3px;
  font: var(--t-mono-xs);
}

.empty {
  font: var(--t-mono-sm);
  color: var(--fg-dim);
  padding: 6px 4px;
}

/* --- the tone classes, LAST ---------------------------------------------
   AND LAST IS NOT TIDINESS. Every one of these is a single class, and so is
   `.num` - equal specificity, so the later rule in the file wins. Written
   above the table, `.num` beat `.warnish` and a unit with nine restarts
   printed its nine in the ordinary body colour, beside a red rail. The rail
   was right and the value was not.

   `.dull`, NOT `.dim`: base.css owns a global `.dim` that means STALE -
   "opacity 0.42, and desaturating as well as dimming is load-bearing" - so a
   scoped `.dim { color: var(--fg-5) }` does not replace it, it ADDS to it. The
   two rows with no health check rendered at 42% opacity under a saturation
   filter, which is this application's one visual claim that a reading is out of
   date. An unmeasured thing must not borrow the appearance of an unrefreshed
   one, in either direction. */
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
}
</style>
