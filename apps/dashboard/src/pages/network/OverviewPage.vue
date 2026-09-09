<script setup lang="ts">
/**
 * /network/overview: is the segmentation intact, and what is open to the host?
 *
 * WHAT THE PAGE USED TO OPEN WITH WAS NOT A READING. "10 bridges, all
 * isolate=true / 46 declared routes / 3 published ports" - three constants
 * compiled into the bundle, printed identically on a healthy host and on one
 * whose collector had been dead for a week. The first of them was worse than
 * decorative: nothing on this host checked isolate on a stack segment at all,
 * so it was a security property asserted on screen and measured nowhere.
 *
 * All three are measured now. src/network.ts carries the arguments and the
 * arms; composables/useNetworkReadings.ts polls, and this file draws what comes
 * back.
 *
 * SELECTION IS IN THE URL, AND THE SPLIT IS WHY THAT MATTERS TWICE OVER.
 * ?focus= was already here because it makes a filtered view a thing somebody
 * can send to somebody else - the same reason every round on the fleet board
 * has its own address. It is now also the whole of the handoff from
 * /network/map, which pushes a focus and #segments rather than filtering
 * anything itself.
 *
 * THE CHIP MOVED WITH THE FILTER. "showing X / clear" used to sit on the
 * drawing's band, which is one view over; it is on the Segments band now,
 * beside the first table it filters, and Published ports says so too rather
 * than silently shortening.
 */
import { computed, watch } from "vue";
import { useRoute, useRouter } from "vue-router";

import Band from "@/components/Band.vue";
import FindingsPanel from "@/components/FindingsPanel.vue";
import PanelBox from "@/components/PanelBox.vue";
import StatusDot from "@/components/StatusDot.vue";

import { useMetricsStale } from "@/composables/useStaleness";
import { useNetworkReadings } from "@/composables/useNetworkReadings";
import { useTooltip } from "@/composables/useTooltip";
import * as fmt from "@/format";
import * as net from "@/network";
import type { Tone } from "@/types";

const tip = useTooltip();
const metricsStale = useMetricsStale();
const route = useRoute();
const router = useRouter();

const { segments, ports, attention, lead, conds, tally } = useNetworkReadings();

// --- selection ----------------------------------------------------------------
const focus = computed<string | null>(() => {
  const q = route.query.focus;
  return typeof q === "string" && q.length ? q : null;
});

function setFocus(value: string | null): void {
  const query = { ...route.query };
  if (value) query.focus = value;
  else delete query.focus;
  void router.replace({ query });
}

/** A focus naming nothing on this page is a dead filter, and a dead filter
 *  renders as an empty table with no explanation. Cleared rather than kept. */
watch([focus, segments], () => {
  if (!focus.value || segments.value.length === 0) return;
  const known =
    segments.value.some((s) => s.id === focus.value) ||
    segments.value.some((s) => s.members.some((m) => m.name === focus.value));
  if (!known) setFocus(null);
});

const shownSegments = computed(() => {
  if (!focus.value) return segments.value;
  return segments.value.filter(
    (s) => s.id === focus.value || s.members.some((m) => m.name === focus.value),
  );
});

const shownPorts = computed(() => {
  if (!focus.value) return ports.value;
  const names = new Set(
    segments.value
      .filter((s) => s.id === focus.value)
      .flatMap((s) => s.members.map((m) => m.metric)),
  );
  return ports.value.filter((p) => p.container === focus.value || names.has(p.container));
});

// --- Presentation -------------------------------------------------------------

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

function isolateText(s: net.SegmentRow): string {
  if (s.kind === "tunnel") return "n/a";
  if (s.isolate === undefined) return fmt.NO_DATA;
  return s.isolate === "true" ? "yes" : "NO";
}

function isolateTone(s: net.SegmentRow): Tone {
  if (s.kind === "tunnel") return "off";
  if (s.isolate === undefined) return "off";
  if (s.isolate === "true") return "ok";
  return s.declared ? "fail" : "off";
}

function memberTip(s: net.SegmentRow, m: net.MemberRef) {
  return {
    title: `${m.name} on ${s.id}`,
    lines: [
      m.state,
      m.declared ? "declared in stacks/" : "not declared in stacks/",
      m.attached ? "podman reports it attached" : "podman does not report this attachment",
      Number.isFinite(m.rx) ? `received ${fmt.rate(m.rx)}` : "received: not measured",
      Number.isFinite(m.tx) ? `sent ${fmt.rate(m.tx)}` : "sent: not measured",
    ],
    caveat: m.issue ?? undefined,
  };
}

function portTip(p: net.PortRow) {
  return {
    title: p.mapping,
    lines: [
      p.container,
      p.loopback
        ? "bound to 127.0.0.1, so it is not a way in at all - only a process on the host can reach it"
        : "the only way in that does not go through a bridge",
      p.declared ? "declared in stacks/" : "not declared in stacks/",
      p.live ? "podman is publishing it" : "podman is not publishing it",
    ],
    caveat:
      p.issue ??
      (p.loopback
        ? "firewalld does NOT govern this one. A loopback publish never reaches the INPUT chain, which is why it needs no rule and gets no protection from one either."
        : "firewalld governs this separately, and host.firewalld below is the check that grades it. A publish with no matching rule is a closed port on a container that looks perfectly healthy."),
  };
}
</script>

<template>
  <Band label="Right now">
    <template #aside>
      <span class="mono">{{ tally.segments }} segments, {{ tally.attachments }} attachments</span>
    </template>
    <PanelBox :stale="metricsStale">
      <div class="lead">
        <StatusDot :tone="lead.tone" :live="lead.live" glow :size="8" />
        <span class="reading" :class="toneClass(lead.tone)">{{ lead.text }}</span>
      </div>
      <p class="lead-sub mono">{{ lead.sub }}</p>

      <div class="conds">
        <div v-for="c in conds" :key="c.id" class="cond">
          <span class="label">{{ c.label }}</span>
          <span class="cvalue mono" :class="toneClass(c.tone)">{{ c.value }}</span>
          <span class="sub mono">{{ c.sub }}</span>
        </div>
      </div>
    </PanelBox>
  </Band>

  <Band label="Needs attention">
    <template #aside>
      <span class="mono">{{ attention.length }} of {{ tally.segments + tally.attachments + tally.ports }}</span>
    </template>
    <PanelBox :stale="metricsStale">
      <p v-if="!attention.length" class="empty mono">
        Nothing here disagrees with stacks/. Every declared segment exists and carries
        isolate=true, every declared attachment is one podman reports, and no interface
        failed to map.
      </p>
      <table v-else class="tbl">
        <thead>
          <tr>
            <th class="c-rail" />
            <th>What</th>
            <th class="c-state p3">State</th>
            <th class="c-issue p2">Look here first</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="a in attention" :key="a.key" class="hov" :style="{ '--rail': rail(a.tone) }">
            <td class="rail">
              <StatusDot :tone="a.tone" :live="a.tone === 'fail'" glow :size="6" />
            </td>
            <td>
              <div class="ident">
                <span class="sname mono">{{ a.subject }}</span>
                <span class="role mono">{{ a.where }}</span>
              </div>
              <div class="smeta mono">
                <span class="fold3" :class="toneClass(a.tone)">{{ a.state }}</span>
                <span class="fold2">{{ a.issue }}</span>
              </div>
            </td>
            <td class="c-state p3 mono" :class="toneClass(a.tone)">{{ a.state }}</td>
            <td class="c-issue p2 issue">{{ a.issue }}</td>
          </tr>
        </tbody>
      </table>
    </PanelBox>
  </Band>

  <FindingsPanel
    label="What the hourly battery found"
    :ids="net.FINDING_IDS"
  />

  <!-- id="segments", because /network/map pushes #segments with the focus it
       just set. Band's root is a single <section>, so the attribute falls
       through to it. -->
  <Band id="segments" label="Segments">
    <template #aside>
      <span v-if="focus" class="mono">
        showing {{ focus }}
        <button type="button" class="clear" @click="setFocus(null)">clear</button>
      </span>
      <span v-else class="mono">declared first, then what the host has that stacks/ does not</span>
    </template>
    <PanelBox :stale="metricsStale">
      <table class="tbl">
        <thead>
          <tr>
            <th class="c-rail" />
            <th class="c-seg">Segment</th>
            <th class="c-purpose p4">Purpose</th>
            <th class="p2">Members</th>
            <th class="c-subnet p3">Subnet</th>
            <th class="c-seen r p2">Seen on it</th>
            <th class="c-iso r p2">Isolated</th>
          </tr>
        </thead>
        <tbody>
          <tr
            v-for="s in shownSegments"
            :key="s.id"
            class="hov"
            :style="{ '--rail': rail(s.tone) }"
          >
            <td class="rail">
              <StatusDot :tone="s.tone" :live="s.tone === 'fail'" glow :size="6" />
            </td>
            <td class="c-seg">
              <div class="ident">
                <span class="sname mono">{{ s.id }}</span>
                <span class="sstate mono" :class="toneClass(s.tone)">{{ s.state }}</span>
              </div>
              <div class="smeta mono">
                <span class="fold4">{{ s.purpose }}</span>
                <span v-if="s.subnet" class="fold3">{{ s.subnet }}</span>
                <span class="fold2">{{ s.measured ? fmt.rate(s.bytes) : "not measured" }}</span>
                <span class="fold2" :class="toneClass(isolateTone(s))">
                  isolate {{ isolateText(s) }}
                </span>
                <!-- NAMES RATHER THAN THE CHIPS THEMSELVES. Seven chips in
                     the 124px the members column has left at 390 is one per
                     line and a row eight lines tall; the same seven names on
                     the meta line wrap across the whole cell and read. The
                     chips are a control, and a control nobody can hit is not
                     one worth keeping the column for. -->
                <span v-if="s.members.length" class="fold2">
                  {{ s.members.map((m) => m.name).join(" ") }}
                </span>
              </div>
            </td>
            <td class="c-purpose p4 role">{{ s.purpose }}</td>
            <td class="p2">
              <div class="chips">
                <button
                  v-for="m in s.members"
                  :key="m.metric"
                  type="button"
                  class="mchip mono"
                  :class="[toneClass(m.tone), { ghost: !m.attached }]"
                  v-bind="tip.hover(`m-${s.id}-${m.metric}`, memberTip(s, m))"
                  @click="setFocus(m.name)"
                >
                  <StatusDot :tone="m.tone" :size="5" />
                  {{ m.name }}
                </button>
                <span v-if="!s.members.length" class="role mono">no member</span>
              </div>
            </td>
            <td class="c-subnet p3 mono role">{{ s.subnet || fmt.NO_DATA }}</td>
            <td class="c-seen r p2 num" :class="{ dull: !s.measured }">
              {{ s.measured ? fmt.rate(s.bytes) : fmt.NO_DATA }}
            </td>
            <td class="c-iso r p2 num" :class="toneClass(isolateTone(s))">
              {{ isolateText(s) }}
            </td>
          </tr>
        </tbody>
      </table>
      <p class="hint mono">
        A rate is both directions of every member added up, so an intra-segment byte is counted
        twice - once as a send and once as the matching receive. It measures how busy a bridge is,
        not throughput across it, and which peer any of it reached is not measurable on this host.
      </p>
    </PanelBox>
  </Band>

  <Band label="Published ports">
    <template #aside>
      <span v-if="focus" class="mono">filtered to {{ focus }}</span>
      <span v-else class="mono">{{ tally.ports }} in the whole stack</span>
    </template>
    <PanelBox :stale="metricsStale">
      <p v-if="!shownPorts.length" class="empty mono">
        No publish here. Everything else is reached by container name over its own bridge.
      </p>
      <table v-else class="tbl">
        <thead>
          <tr>
            <th class="c-rail" />
            <th class="c-port">Port</th>
            <th>Container</th>
            <th class="c-bind p3">Bind</th>
            <th class="c-what p2">What it is</th>
          </tr>
        </thead>
        <tbody>
          <tr
            v-for="p in shownPorts"
            :key="p.key"
            class="hov"
            :style="{ '--rail': rail(p.tone) }"
            v-bind="tip.hover(`port-${p.key}`, portTip(p))"
          >
            <td class="rail">
              <StatusDot :tone="p.tone" :live="p.tone === 'fail'" glow :size="6" />
            </td>
            <td class="c-port mono">{{ p.mapping }}</td>
            <td>
              <div class="ident">
                <span class="sname mono">{{ p.container }}</span>
                <span class="sstate mono" :class="toneClass(p.tone)">{{ p.state }}</span>
              </div>
              <div class="smeta mono">
                <span class="fold3">{{ p.loopback ? "127.0.0.1" : "every address" }}</span>
                <span class="fold2">{{
                  p.loopback ? "firewalld never sees it" : "firewalld governs it"
                }}</span>
              </div>
            </td>
            <td class="c-bind p3 mono role">{{ p.loopback ? "127.0.0.1" : "every address" }}</td>
            <td class="c-what p2 issue">
              {{
                p.issue ??
                (p.loopback
                  ? "loopback only - firewalld never sees this one"
                  : "faces the LAN, and firewalld governs it separately")
              }}
            </td>
          </tr>
        </tbody>
      </table>
    </PanelBox>
  </Band>
</template>

<style scoped>
/* --- the header ----------------------------------------------------------
   THE SHARED RECIPE, WHICH THIS PAGE NEVER GOT. Seven lead panels - Home,
   Library, CI, system/Health, services/Health, the round board and the fleet
   view - are byte-identical on five values, and this one differed on all five:
   a 5px lead-sub, a flat 10px conds gap, 14/12 rather than 15/14, and a 3px
   cond gap. The panel was about 5px shorter than the same panel everywhere
   else and its conditions about 2px tighter per row, which is a difference
   nobody chose and nobody could see beside its siblings. */
.lead {
  display: flex;
  align-items: center;
  gap: 10px;
  min-width: 0;
}

/* --fg, NOT --fg-1. This read var(--fg-1), which is defined in no stylesheet
   here - tokens.css has --fg and --fg-2..--fg-5 and --fg-dim, and this was the
   name's only appearance in the app. It is invalid at computed-value time,
   so `color` fell back to `inherit` and landed on --fg from body: the right
   colour, by accident, and a declaration that would have become the wrong one
   the moment any ancestor set a colour. bin/lint-repo.sh grades it now. */
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
   below 640 - the round board's recipe, on all eight pages that carry it. */
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

.cvalue {
  font: var(--t-mono-md);
  color: var(--fg-2);
}

.sub {
  font: var(--t-mono-xs);
  color: var(--fg-5);
}

/* --- the tables --- */
.c-rail {
  width: 30px;
}

.c-seg {
  width: 224px; /* "net-transcode" beside "membership drift" */
}

.c-purpose {
  width: 190px;
}

.c-subnet {
  width: 128px; /* "172.21.19.0/24" */
}

.c-seen {
  width: 96px; /* "16.0 MB/s" */
}

.c-iso {
  width: 78px;
}

.c-state {
  width: 152px; /* "membership drift" */
}

.c-issue {
  width: 380px;
}

.c-port {
  width: 168px; /* "127.0.0.1:8300 -> 8000" */
}

.c-bind {
  width: 118px;
}

.c-what {
  width: 320px;
}

.ident {
  display: flex;
  align-items: baseline;
  gap: 8px;
  min-width: 0;
}

.sname {
  font: var(--t-mono-md);
  color: var(--fg-2);
}

.sstate {
  font: var(--t-mono-xs);
  color: var(--fg-5);
}

.role {
  font: var(--t-mono-xs);
  color: var(--fg-5);
}

/* The meta line, and everything a dropped column handed over. Each fold
   appears only once its own column has gone. */
.smeta {
  display: flex;
  flex-wrap: wrap;
  gap: 4px 10px;
  margin-top: 3px;
  font: var(--t-mono-xs);
  color: var(--fg-5);
}

/* The folds are flex items in the meta line, so they lay out inline rather
   than as the blocks base.css makes them. */
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

.chips {
  display: flex;
  flex-wrap: wrap;
  gap: 4px 6px;
}

.mchip {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  padding: var(--pad-chip);
  border: 1px solid var(--line);
  border-radius: var(--r-xs);
  background: var(--surface-chip);
  color: var(--fg-3);
  font: var(--t-mono-xs);
  cursor: pointer;
}

.mchip:hover {
  border-color: var(--accent);
  color: var(--fg-2);
}

/* DECLARED AND NOT ATTACHED IS AN OUTLINE, NOT A DIMMED CHIP. base.css owns a
   global .dim that means STALE, and a member podman does not report is not a
   stale reading - it is a present one saying something is missing. */
.ghost {
  border-style: dashed;
  background: none;
}

.num {
  font: var(--t-mono-sm);
  color: var(--fg-2);
  font-variant-numeric: tabular-nums;
}

.issue {
  font: var(--t-mono-xs);
  color: var(--fg-4);
}

.empty {
  font: var(--t-mono-sm);
  color: var(--fg-5);
}

.hint {
  margin-top: 10px;
  padding-top: 9px;
  border-top: 1px solid var(--line);
  font: var(--t-mono-xs);
  color: var(--fg-5);
}

.clear {
  margin-left: 6px;
  padding: 0;
  border: 0;
  background: none;
  color: var(--accent);
  font: inherit;
  cursor: pointer;
  text-decoration: underline;
}

/* --- the tone classes, LAST ---
   AND LAST IS NOT TIDINESS. Every one of these is a single class, and so are
   .num, .issue and .cvalue - equal specificity, so the later rule in the file
   wins. Written above the tables, .num beat .warnish and a segment without
   isolate printed its NO in the ordinary body colour, beside a red rail.
   Found on /services on 2026-09-08 and true here for the same reason.

   .dull, NOT .dim: base.css owns a global .dim that means STALE, so a scoped
   .dim { color: var(--fg-5) } does not replace it, it ADDS 42% opacity and a
   saturation cut to a row whose only fault is that nobody is checking it. */
.bad {
  color: var(--fail-text);
}

.warnish {
  color: var(--warn);
}

.dull {
  color: var(--fg-5);
}

/* --- the tablet --- */
@media (max-width: 900px) {
  .conds {
    display: flex;
    flex-wrap: wrap;
  }
}

/* The conditions, on a phone: the label moves left of its value, three rows, one
   condition each, labels in a column of their own. The 92px fallback is the
   width of MEMORY at --t-label, measured, and is what the browser uses where
   subgrid is unavailable. */
@media (max-width: 640px) {
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

  /* THE RAIL NEEDS ITS WIDTH BACK ON THE CELL ONCE THE HEADER IS GONE. Under
     table-layout: fixed the column widths come from the first row, and
     display: none on the thead makes that the first BODY row - which carries
     no widths, so the surviving columns split evenly. */
  .tbl td.rail {
    width: 30px;
  }

  .tbl thead {
    display: none;
  }

  /* The segment cell is the only one left, so it takes the table. Its measured
     width is what the header used to set, and the header has gone. */
  .tbl td.c-seg {
    width: auto;
  }
}
</style>
