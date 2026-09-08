<script setup lang="ts">
/**
 * /services: is anything wrong with the stack, and what do I type?
 *
 * THE PAGE COULD NOT SHOW A SERVICE THAT WAS DOWN, which is what this redesign
 * is for. Every row was built from home_server_container_info, the collector
 * builds that from `podman ps`, and `podman ps` lists RUNNING containers - so a
 * service that stopped did not go red here, it VANISHED, and the rack was at its
 * emptiest exactly when it mattered most. src/services.ts carries the argument
 * and the fix: the rack is enumerated from home_server_unit_state now, which
 * source_units reads from the quadlet generator directory for this very reason,
 * and a container is joined onto a unit rather than the other way round.
 *
 * THREE MORE THINGS THAT WERE ON SCREEN AND MEANT NOTHING:
 *
 *   - The RESTARTS column read podman's counter, which is reset when a quadlet
 *     recreates the container - so it is 0 throughout a restart loop and read 0
 *     through all 6,224 of Pocket ID's. systemd's NRestarts is the one that
 *     survives, and it was on no page in this application.
 *   - `pod {{ row.pod }}` was dead code. podman fills `Pod` with an id and not
 *     `PodName`, so home_server_container_info{pod} is "" for every container on
 *     this host - perfect in the fixtures, absent on the server, and recorded in
 *     docs/dashboard.md two sections before nobody acted on it. Pod membership
 *     comes from topology now.
 *   - THREE LEDS WITH NO LEGEND ANYWHERE, whose leftmost had a state nobody can
 *     guess: grey meant "no health check is defined", which is not the same as
 *     one that passed. The page's own comment said so. There is one dot now and
 *     the state is a WORD beside it, in the row, at every width.
 *
 * AND THE APPLICATIONS' OWN HEALTH IS FINALLY DRAWN. An *arr with a dead indexer
 * is healthy by every container-level signal here - active unit, passing probe -
 * and home_server_arr_health_issues has been collected since the collector
 * existed with no consumer at all. The Applications band reads it, and names the
 * indexers Prowlarr is backing off rather than counting them.
 *
 * ONE DERIVATION, TWO VIEWS. "Needs attention" is a FILTER over the same array
 * the rack draws - never a second reading of the same series, which is how the
 * System page came to draw one finding two ways and disagree with itself about
 * what `note` meant.
 */
import { computed, watch } from "vue";

import Band from "@/components/Band.vue";
import ChipLink from "@/components/ChipLink.vue";
import FindingsPanel from "@/components/FindingsPanel.vue";
import PanelBox from "@/components/PanelBox.vue";
import StatusDot from "@/components/StatusDot.vue";
import ActivityBars from "@/components/ActivityBars.vue";
import WindowPicker from "@/components/WindowPicker.vue";

import { usePoll } from "@/composables/usePoll";
import { useMetricsStale } from "@/composables/useStaleness";
import { useTimeWindow } from "@/composables/useTimeWindow";
import { useTooltip } from "@/composables/useTooltip";
import { instant, instantBy, labelsBy, range, value } from "@/api/prometheus";
import { SERVICES } from "@/queries";
import { toPoints } from "@/charts";
import { appHome } from "@/links";
import * as svc from "@/services";
import * as fmt from "@/format";
import type { Tone } from "@/types";

const { window: win } = useTimeWindow();
const tip = useTooltip();
const metricsStale = useMetricsStale();

const ACTIVITY_BARS = 24;

// ---------------------------------------------------------------------------
// The rack: the units, with a container joined onto each
// ---------------------------------------------------------------------------
const rack = usePoll(async (signal) => {
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
    range(SERVICES.cpu, { window: step * ACTIVITY_BARS, step, signal }),
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

watch(win, () => {
  void rack.refresh();
});

const rows = computed(() => rack.data.value?.rows ?? []);
const attention = computed(() => svc.needsAttention(rows.value));
const tally = computed(() => svc.serviceTally(rows.value));
const lead = computed(() => svc.servicesLead(rows.value));
const conds = computed(() => svc.conditionRows(rows.value));

// ---------------------------------------------------------------------------
// The applications
// ---------------------------------------------------------------------------
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

// ---------------------------------------------------------------------------
// Presentation
// ---------------------------------------------------------------------------

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
  <div class="page">
    <Teleport defer to="#toolbar">
      <span class="mono note">read only</span>
      <WindowPicker />
    </Teleport>

    <!-- THE HEADLINE IS THE COUNT THAT NEEDS SOMETHING DOING. "26 of 28 healthy"
         reads as a pass mark; the two are the reason to be here. -->
    <Band label="Right now">
      <template #aside>
        <span class="mono">
          <span class="count">{{ tally.total }}</span> services
        </span>
      </template>

      <PanelBox :stale="metricsStale">
        <div class="lead">
          <StatusDot :tone="lead.tone" :live="lead.live" :size="9" />
          <span class="reading mono">{{ lead.text }}</span>
        </div>
        <p class="lead-sub mono">{{ lead.sub }}</p>

        <div class="conds">
          <div v-for="c in conds" :key="c.id" class="cond">
            <span class="label">{{ c.label }}</span>
            <span class="mono cvalue" :class="toneClass(c.tone)">{{ c.value }}</span>
            <span class="mono sub">{{ c.sub }}</span>
          </div>
        </div>
      </PanelBox>
    </Band>

    <!-- SECOND, AND IT IS THE POINT OF THE PAGE. Everything below is evidence;
         this is the list, the sentence and the command. -->
    <Band label="Needs attention">
      <template #aside>
        <span class="mono">
          <span class="count">{{ attention.length }}</span> of
          <span class="count">{{ tally.total }}</span>
        </span>
      </template>

      <PanelBox :stale="metricsStale">
        <table v-if="attention.length" class="tbl">
          <thead>
            <tr>
              <th class="c-rail" />
              <th>Service</th>
              <!-- EVERY REMEDY IS A READ. This dashboard cannot restart anything -
                   the podman socket is SELinux-denied from container_t - and that
                   is not the only reason: a command that changes the host is a
                   decision for the person, not a string a panel prints. -->
              <th class="c-remedy p2">Look here first</th>
              <th class="c-open" />
            </tr>
          </thead>
          <tbody>
            <tr v-for="row in attention" :key="row.unit || row.name" :style="{ '--rail': rail(row.tone) }">
              <td class="rail">
                <StatusDot :tone="row.tone" :live="row.tone === 'fail'" :size="6" />
              </td>
              <td>
                <div class="sname">{{ row.name }}</div>
                <div class="sstate mono" :class="toneClass(row.tone)">{{ row.state }}</div>
                <!-- NOT CLAMPED. This sentence is the reason the row is here. -->
                <p class="issue">{{ row.issue }}</p>
                <code v-if="row.remedy" class="fold2 cmd mono">{{ row.remedy }}</code>
              </td>
              <td class="c-remedy p2">
                <code v-if="row.remedy" class="cmd mono">{{ row.remedy }}</code>
                <span v-else class="mono dull">nothing to run - wait for it</span>
              </td>
              <td class="c-open">
                <ChipLink
                  v-if="row.app"
                  label="open"
                  :href="open(row)"
                  :title="`open ${row.name}'s own interface`"
                />
              </td>
            </tr>
          </tbody>
        </table>

        <!-- A CALM EMPTY STATE THAT STILL COUNTS THE GREY ONES. "All good" would
             fold "nobody is checking three of these" into the same sentence as
             "these passed", which is the one fold this application never makes. -->
        <p v-else class="empty mono">
          nothing needs attention - {{ tally.ok }} healthy, {{ tally.off }} with no health check,
          nothing failing or restarting
        </p>

        <p v-if="(rack.data.value?.unresolved ?? 0) > 0" class="note unresolved mono">
          {{ rack.data.value?.unresolved }} container(s) could not be mapped to a systemd unit, so
          they are absent from every table here. That is what
          home_server_container_identity_unresolved counts.
        </p>
      </PanelBox>
    </Band>

    <!-- THE BATTERY'S OWN PROSE, over the two sections this page is about.
         `containers` grades the units and the probes; `update` grades the nightly
         image roll that recreates every container on the host, which is the answer
         to "why did this restart last night" and belongs beside the restart. -->
    <FindingsPanel label="What the hourly battery found" :section="['containers', 'update']" />

    <Band label="Services">
      <template #aside><span>worst first, then busiest</span></template>

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
    </Band>

    <!-- WHAT THE APPLICATIONS SAY ABOUT THEMSELVES, which is a different question
         from whether their containers are healthy - and one nothing on this page
         asked until now. An *arr with a dead indexer has an active unit and a
         passing probe; the only symptom is that nothing is found. -->
    <Band label="Applications">
      <template #aside><span>what they report about themselves</span></template>

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
            <tr v-for="a in apps.data.value ?? []" :key="a.id" :style="{ '--rail': rail(a.tone) }">
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
    </Band>
  </div>
</template>

<style scoped>
/* Two rhythms, not one: --gap-lg between bands and --gap inside them is what
   makes a page read as bands rather than as one stack of panels. Band owns the
   second, the page owns this one - SystemLayout's rule, and this page had
   neither because it had no bands. */
.page {
  padding: 16px var(--pad-page) var(--pad-page);
  display: flex;
  flex-direction: column;
  gap: var(--gap-lg);
  min-width: 0;
}

.note {
  font: var(--t-mono-sm);
  color: var(--fg-dim);
}

/* --- the header ----------------------------------------------------------- */

.lead {
  display: flex;
  align-items: center;
  gap: 10px;
  min-width: 0;
}

/* --t-mono-xl, "the one headline reading". One per view. */
.reading {
  font: var(--t-mono-xl);
  color: var(--fg);
}

.lead-sub {
  margin-top: 7px;
  font: var(--t-mono-sm);
  color: var(--fg-5);
}

/* Three equal columns above 900, packed left below it, and a label-left readout
   below 640 - the recipe /system/health and the round board already use. */
.conds {
  display: grid;
  grid-template-columns: repeat(3, minmax(0, 1fr));
  gap: var(--gap) var(--gap-lg);
  margin-top: 15px;
  padding-top: 14px;
  border-top: 1px solid var(--border-divider);
}

.cond {
  display: flex;
  flex-direction: column;
  gap: 5px;
  min-width: 0;
}

.label {
  font: var(--t-label);
  letter-spacing: var(--track-label);
  text-transform: uppercase;
  color: var(--fg-5);
}

.cvalue {
  font: var(--t-mono-md);
  color: var(--fg-2);
}

.sub {
  font: var(--t-mono-xs);
  color: var(--fg-5);
}

/* --- the tables ----------------------------------------------------------- */

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

/* The remedy is a command line and must not wrap mid-flag. The longest one
   here is `systemctl --user show windmill-worker-verify.service -p MemoryHigh
   -p MemoryMax`, which does not fit any column - so it wraps on whitespace and
   the column is sized for the common `journalctl` case. */
.c-remedy {
  width: 380px;
}

.c-open {
  width: 84px;
}

.c-app {
  width: 132px;
}

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

/* NOT CLAMPED, on either table. The sentence is the reason the row is there,
   and FindingsPanel's two-line clamp is for a column 232px wide beside an id;
   this one has the width of the table. */
.issue {
  margin-top: 6px;
  font: var(--t-ui-sm);
  color: var(--fg-3);
}

/* A command, not a label: it is meant to be selected and pasted into an ssh
   session, so it takes a surface of its own and wraps on whitespace rather than
   truncating - half a command line is worse than none. */
.cmd {
  display: inline-block;
  padding: 5px 8px;
  border-radius: var(--r-xs);
  background: var(--fill);
  color: var(--fg-2);
  font: var(--t-mono-xs);
  overflow-wrap: anywhere;
}

/* TWO CLASSES, TWO SPECIFICITIES, AND base.css LOSES WITHOUT THIS. Its
   `.fold2 { display: none }` and this file's `.cmd { display: inline-block }`
   are both one class, so the later one - the scoped rule - wins and the folded
   copy rendered at every width. The command was on screen twice, side by side,
   in the panel whose whole job is to say what to type. */
.cmd.fold2 {
  display: none;
}

@media (max-width: 640px) {
  .cmd.fold2 {
    display: inline-block;
    margin-top: 7px;
  }
}

.aname {
  font: var(--t-mono-md);
  color: var(--fg-2);
}

.areading {
  font: var(--t-mono-sm);
  color: var(--fg-3);
}

.empty {
  font: var(--t-mono-sm);
  color: var(--fg-dim);
  padding: 6px 4px;
}

.unresolved {
  margin-top: 12px;
  padding-top: 11px;
  border-top: 1px solid var(--border-divider);
  color: var(--warn);
}

/* --- the tone classes, LAST ---------------------------------------------
   AND LAST IS NOT TIDINESS. Every one of these is a single class, and so are
   `.num`, `.areading` and `.cvalue` - equal specificity, so the later rule in
   the file wins. Written where they used to be, above the tables, `.num` beat
   `.warnish` and a unit with nine restarts printed its nine in the ordinary
   body colour; `.areading` beat `.bad` and Prowlarr's two errors read as an
   ordinary sentence beside a red rail. The rail was right and the value was
   not, on the one page whose job is to make a fault easy to find.

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

/* --- the tablet ----------------------------------------------------------- */

@media (max-width: 900px) {
  .conds {
    display: flex;
    flex-wrap: wrap;
  }
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

  /* The open chip is the only fixed column left on the applications table
     once the name has folded, and it still needs its width back by hand: with
     the header gone the widths come from the first body row. */
  .tbl td.c-open {
    width: 74px;
  }

  .aname.fold2 {
    margin-bottom: 5px;
  }

  /* The label moves left of its value: three rows, one condition each, labels in
     a column of their own. The 92px fallback is the width of RESTARTS at
     --t-label, measured, and is what a browser without subgrid uses. */
  .conds {
    display: grid;
    grid-template-columns: max-content 1fr;
    column-gap: var(--gap);
    row-gap: 14px;
  }

  .cond {
    grid-template-columns: 92px 1fr;
    grid-template-columns: subgrid;
    display: grid;
    grid-column: 1 / -1;
    align-items: center;
    column-gap: var(--gap);
    row-gap: 4px;
  }

  .cond .label {
    grid-area: 1 / 1;
  }

  .cond .cvalue {
    grid-area: 1 / 2;
  }

  .cond .sub {
    grid-area: 2 / 2;
  }
}
</style>
