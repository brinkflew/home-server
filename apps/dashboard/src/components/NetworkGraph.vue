<script setup lang="ts">
/**
 * The segmentation, grouped by network.
 *
 * A GROUP IS A BOX AND ITS MEMBERS ARE INSIDE IT, which is the change. The
 * drawing this replaces was ten horizontal rails with boxes packed along each,
 * and it answered "which rail is this on" perfectly while answering "what is on
 * net-solver" only by tracing a line. graph.ts carries the argument for the
 * arrangement and for the spine; this file draws it.
 *
 * THREE VISUAL LANGUAGES, AND THEY MAY NOT BORROW EACH OTHER'S CREDIBILITY.
 * A box's colour is a measured liveness verdict. A group's edge is whether the
 * segmentation still holds - isolate, and whether membership matches stacks/.
 * An elbow is a container's measured bytes on a segment, and it is the only
 * thing here that moves. Reachability is asserted by git; motion is asserted by
 * measurement.
 *
 * THE FLOW ANIMATION HAD NEVER RUN, AND NO SCREENSHOT COULD SHOW IT. The old
 * component set `animationDuration` inline and tokens.css defined @keyframes
 * flow, but nothing anywhere set `animation-name` - the only `.flow` selector
 * in the application was inside the prefers-reduced-motion block that turns it
 * OFF. So the 90-second staleness gate, flowDuration(), and three paragraphs of
 * docs/dashboard.md about the eye reading movement before it reads opacity all
 * drove an animation that never played. Only the magnitude tick was ever
 * visible, which is exactly why fixtures/shoot.mjs - whose stills the tick
 * exists for - could not see it. The rule is in this file's stylesheet now,
 * where the class it applies to lives.
 *
 * ONE TAB STOP, THEN ARROWS, AND THIS TIME IT IS TRUE. The old component said
 * so in a comment and then bound `tip.bind` to every box, which sets
 * `tabindex: 0` - so it reintroduced twenty-nine tab stops the comment says
 * were avoided. `tip.hover` is the pointer-only half and exists for precisely
 * this case.
 *
 * ASPECT IS NOT PRESERVED BY SHRINKING. It reflows: fewer columns and a taller
 * drawing, never smaller type. `min-width` on the SVG is the floor, and below
 * it the panel scrolls rather than scaling 13px names down to 2.6px.
 */
import { computed, onBeforeUnmount, onMounted, ref } from "vue";

import { useTooltip } from "@/composables/useTooltip";
import * as fmt from "@/format";
import {
  columnsFor,
  fitName,
  fitRole,
  flowDuration,
  intensity,
  layout,
  routesTouching,
  type GraphModel,
} from "@/graph";
import type { MemberRef, SegmentRow } from "@/network";
import type { Tone } from "@/types";

const props = defineProps<{
  model: GraphModel;
  segments: SegmentRow[];
  /** False freezes every elbow. Motion is the claim "this is happening now". */
  flowing: boolean;
  /** The selected group id or node name, owned by the page and by the URL. */
  focus: string | null;
}>();

const emit = defineEmits<{ (e: "update:focus", value: string | null): void }>();

const tip = useTooltip();

// --- reflow -------------------------------------------------------------------
// MEASURED, NOT GUESSED FROM window.innerWidth. The panel is narrower than the
// window by the page gutter and the panel's own padding, and on /network it is
// the full page width today and might not be tomorrow. A ResizeObserver on the
// element that actually holds the drawing cannot be wrong about either.
const wrap = ref<HTMLElement | null>(null);
const panelW = ref(0);
let ro: ResizeObserver | undefined;

onMounted(() => {
  if (!wrap.value) return;
  panelW.value = wrap.value.clientWidth;
  ro = new ResizeObserver((entries) => {
    const w = entries[0]?.contentRect.width ?? 0;
    if (w > 0) panelW.value = w;
  });
  ro.observe(wrap.value);
});
onBeforeUnmount(() => ro?.disconnect());

const L = computed(() => layout(props.model, columnsFor(panelW.value)));

// --- what the boxes know ------------------------------------------------------
const segById = computed(() => new Map(props.segments.map((s) => [s.id, s])));

/** Keyed on segment and member, which is how a rate is identified. */
const pairs = computed(() => {
  const out = new Map<string, MemberRef>();
  for (const s of props.segments) for (const m of s.members) out.set(`${m.name}|${s.id}`, m);
  return out;
});

/** A member's verdict wherever it appears; a container has one, not one each. */
const verdicts = computed(() => {
  const out = new Map<string, MemberRef>();
  for (const s of props.segments) for (const m of s.members) if (!out.has(m.name)) out.set(m.name, m);
  return out;
});

function tone(name: string): Tone {
  return verdicts.value.get(name)?.tone ?? "off";
}

function state(name: string): string {
  return verdicts.value.get(name)?.state ?? "not measured";
}

/** Both directions on one segment. NaN throughout is NOT measured, not idle. */
function total(name: string, network: string): number {
  const m = pairs.value.get(`${name}|${network}`);
  if (!m) return Number.NaN;
  if (!Number.isFinite(m.rx) && !Number.isFinite(m.tx)) return Number.NaN;
  return (Number.isFinite(m.rx) ? m.rx : 0) + (Number.isFinite(m.tx) ? m.tx : 0);
}

function groupTone(id: string): Tone {
  return segById.value.get(id)?.tone ?? "off";
}

function edgeFor(id: string): string {
  const t = groupTone(id);
  return t === "ok" ? "var(--line-strong)" : `var(--${t})`;
}

// --- selection ----------------------------------------------------------------
// HOVER AND SELECTION ARE THE SAME HIGHLIGHT AND DIFFERENT STATE. Hover is
// transient and belongs here; selection outlives the pointer, filters the
// tables below and lives in the URL, so it belongs to the page. A selection
// wins over a hover, or moving the pointer across the drawing would silently
// undo the thing somebody clicked.
const hover = ref<string | null>(null);
const active = computed(() => props.focus ?? hover.value);

const lit = computed(() => {
  const groups = new Set<string>();
  const nodes = new Set<string>();
  const elbows = new Set<string>();
  const a = active.value;
  if (!a) return { on: false, groups, nodes, elbows };

  const g = L.value.groups.find((x) => x.id === a);
  if (g) {
    groups.add(g.id);
    for (const m of g.members) nodes.add(m.name);
    for (const e of L.value.elbows) {
      if (e.target !== g.id) continue;
      elbows.add(e.key);
      nodes.add(e.node);
    }
  } else {
    nodes.add(a);
    for (const gg of L.value.groups) {
      if (gg.members.some((m) => m.name === a || m.pod.includes(a))) groups.add(gg.id);
    }
    for (const e of L.value.elbows) {
      if (e.node !== a && e.target !== a) continue;
      elbows.add(e.key);
      nodes.add(e.node);
      if (L.value.groups.some((x) => x.id === e.target)) groups.add(e.target);
      else nodes.add(e.target);
    }
  }
  return { on: true, groups, nodes, elbows };
});

function dimGroup(id: string): boolean {
  return lit.value.on && !lit.value.groups.has(id);
}
function dimNode(name: string): boolean {
  return lit.value.on && !lit.value.nodes.has(name);
}
function dimElbow(key: string): boolean {
  return lit.value.on && !lit.value.elbows.has(key);
}

function select(id: string): void {
  emit("update:focus", props.focus === id ? null : id);
}

// --- keyboard -----------------------------------------------------------------
// ONE tab stop on the svg, then arrows. Twenty-five boxes plus eighteen elbows
// as individual stops would put forty-three between this panel and the next,
// which is worse for a keyboard user than no keyboard access at all.
const order = computed(() => [
  ...L.value.groups.map((g) => g.id),
  ...L.value.spine.map((s) => s.name),
]);

function move(delta: number): void {
  const list = order.value;
  if (list.length === 0) return;
  const i = hover.value ? list.indexOf(hover.value) : props.focus ? list.indexOf(props.focus) : -1;
  hover.value = list[(i + delta + list.length) % list.length] ?? list[0] ?? null;
}

function onKey(e: KeyboardEvent): void {
  if (e.key === "ArrowRight" || e.key === "ArrowDown") {
    move(1);
    e.preventDefault();
  } else if (e.key === "ArrowLeft" || e.key === "ArrowUp") {
    move(-1);
    e.preventDefault();
  } else if (e.key === "Enter" || e.key === " ") {
    if (hover.value) select(hover.value);
    e.preventDefault();
  } else if (e.key === "Escape") {
    if (props.focus) emit("update:focus", null);
    else hover.value = null;
    tip.closeAll();
  }
}

// --- tooltips -----------------------------------------------------------------
function groupTip(id: string) {
  const s = segById.value.get(id);
  if (!s) return { title: id, lines: [] };
  const lines = [s.purpose];
  if (s.subnet) lines.push(s.subnet);
  lines.push(`${s.members.length} member(s), ${s.members.filter((m) => m.attached).length} attached`);
  lines.push(s.isolate === undefined ? "isolate not measured" : s.isolate === "true" ? "Options=isolate=true" : "NO isolate option");
  lines.push(s.measured ? `${fmt.rate(s.bytes)} seen on it` : "no traffic measured");
  return {
    title: id,
    lines,
    caveat:
      s.issue ??
      (s.members.length > 2
        ? "That rate is both directions of every member added up, so an intra-segment byte is counted twice. Which peer any of it went to is not measured."
        : undefined),
  };
}

function nodeTip(name: string) {
  const m = verdicts.value.get(name);
  const routes = routesTouching(name);
  const lines: string[] = [];
  if (m?.role) lines.push(m.role);
  lines.push(state(name));
  for (const net of m?.networks ?? []) {
    const t = total(name, net);
    lines.push(Number.isFinite(t) ? `${net}  ${fmt.rate(t)}` : `${net}  not measured`);
  }
  // WHERE paths.ts's `why` FINALLY SURFACES. Forty-eight hand-written
  // one-line explanations of why an edge exists, rendered nowhere in this
  // application until today: the old route layer kept from/to/source and
  // dropped the sentence.
  for (const r of routes.slice(0, 4)) {
    lines.push(`${r.from} -> ${r.to}: ${r.why}${r.runtime ? " (runtime)" : ""}`);
  }
  return {
    title: name,
    lines,
    caveat: m?.issue ?? (routes.length > 4 ? `${routes.length - 4} more declared route(s) not shown` : undefined),
  };
}

function elbowTip(node: string, network: string) {
  const m = pairs.value.get(`${node}|${network}`);
  const lines = m
    ? [
        Number.isFinite(m.rx) ? `received ${fmt.rate(m.rx)}` : "received: not measured",
        Number.isFinite(m.tx) ? `sent ${fmt.rate(m.tx)}` : "sent: not measured",
        m.attached ? "podman reports it attached" : "podman does not report this attachment",
      ]
    : ["not measured"];
  return {
    title: `${node} on ${network}`,
    lines,
    caveat:
      m?.issue ??
      "This is the container's total on the segment, not traffic to any one peer. Per-flow accounting is not available on this host.",
  };
}

const summary = computed(() => {
  const groups = L.value.groups.length;
  const spine = L.value.spine.filter((s) => s.kind === "service").length;
  return `${groups} segment(s), ${spine} service(s) on more than one`;
});
</script>

<template>
  <div ref="wrap" class="wrap">
    <div class="hscroll">
      <svg
        class="graph"
        :viewBox="`0 0 ${L.width} ${L.height}`"
        :style="{ minWidth: `${L.width}px` }"
        preserveAspectRatio="xMidYMin meet"
        tabindex="0"
        role="img"
        :aria-label="`network topology, grouped by segment: ${summary}`"
        @keydown="onKey"
      >
        <!-- The elbows, under everything: a line that crosses a box has to pass
             beneath it, and by construction none of them crosses one at all. -->
        <g class="elbows">
          <g v-for="e in L.elbows" :key="e.key">
            <path
              :d="e.d"
              fill="none"
              :stroke="total(e.node, e.target) > 0 ? 'var(--ok)' : 'var(--fg-dim)'"
              :stroke-width="Number.isFinite(total(e.node, e.target)) ? 1.4 : 1.6"
              :stroke-dasharray="Number.isFinite(total(e.node, e.target)) ? '6 10' : '2 4'"
              :class="{ flow: flowing && intensity(total(e.node, e.target)) > 0 }"
              :style="{
                animationDuration: `${flowDuration(total(e.node, e.target))}s`,
                /* A LINE NOBODY MEASURED IS QUIETER THAN AN IDLE ONE. Eighteen
                   elbows at one weight is a hatch pattern; the ones carrying a
                   reading have to come forward, and grey at 0.4 was competing
                   with teal at 0.4. */
                opacity: dimElbow(e.key)
                  ? 0.1
                  : Number.isFinite(total(e.node, e.target))
                    ? 0.38 + intensity(total(e.node, e.target)) * 0.5
                    : 0.2,
              }"
              vector-effect="non-scaling-stroke"
              v-bind="tip.hover(`elbow-${e.key}`, elbowTip(e.node, e.target))"
            />
            <!-- The magnitude tick, drawn in BOTH motion modes. Under
                 prefers-reduced-motion the dashes go entirely, and shoot.mjs
                 takes stills - so an animation-only encoding would be invisible
                 to the only visual review this repository has. -->
            <rect
              v-if="intensity(total(e.node, e.target)) > 0"
              :x="e.tickX - 1"
              :y="e.tickY - 1.5"
              :width="2 + intensity(total(e.node, e.target)) * 10"
              height="3"
              rx="1.5"
              fill="var(--ok)"
              :opacity="dimElbow(e.key) ? 0.15 : 0.85"
            />
          </g>
        </g>

        <!-- The groups. -->
        <g
          v-for="g in L.groups"
          :key="g.id"
          class="group"
          :class="{ dull: dimGroup(g.id), on: focus === g.id }"
          @click="select(g.id)"
          @pointerenter="hover = g.id"
          @pointerleave="hover = null"
        >
          <rect
            :x="g.x"
            :y="g.y"
            :width="g.w"
            :height="g.h"
            rx="10"
            fill="var(--surface-sunken)"
            :stroke="edgeFor(g.id)"
            :stroke-width="focus === g.id ? 1.8 : 1"
            vector-effect="non-scaling-stroke"
            v-bind="tip.hover(`grp-${g.id}`, groupTip(g.id))"
          />
          <circle :cx="g.x + 14" :cy="g.y + 17" r="3.5" :fill="`var(--${groupTone(g.id)})`" />
          <text :x="g.x + 24" :y="g.y + 21" class="g-name">{{ g.id }}</text>
          <text :x="g.x + 12" :y="g.y + 34" class="g-sub">
            {{ fitRole(segById.get(g.id)?.subnet || g.purpose, g.w) }}
          </text>
          <!-- THE SEGMENT'S MEMBERSHIP, NOT THE COUNT OF BOXES INSIDE THIS
               ONE. net-arr holds seven containers and draws two, because the
               other five are multi-homed and out on the spine - so a badge
               reading "2" beside a table row reading seven members is two
               answers to one question. -->
          <text :x="g.x + g.w - 12" :y="g.y + 21" class="g-count" text-anchor="end">
            {{ segById.get(g.id)?.members.length ?? g.members.length }}
          </text>

          <!-- Members. -->
          <g v-for="m in g.members" :key="m.name" :class="{ dull: dimNode(m.name) }">
            <rect
              :x="m.x"
              :y="m.y"
              :width="m.w"
              :height="m.h"
              rx="6"
              fill="var(--surface-high)"
              stroke="var(--line)"
              vector-effect="non-scaling-stroke"
              v-bind="tip.hover(`node-${m.name}`, nodeTip(m.name))"
            />
            <circle :cx="m.x + 11" :cy="m.y + 13" r="3" :fill="`var(--${tone(m.name)})`" />
            <text :x="m.x + 20" :y="m.y + 16" class="n-name">{{ fitName(m.name, m.w) }}</text>
            <text :x="m.x + 9" :y="m.y + 27" class="n-role">{{ fitRole(m.role, m.w) }}</text>

            <!-- The pod: three containers with no stack of their own. -->
            <g v-if="m.pod.length">
              <rect
                :x="m.x + 6"
                :y="m.y + 32"
                :width="m.w - 12"
                :height="m.pod.length * 13 + 4"
                rx="4"
                fill="oklch(0 0 0 / 0.25)"
                stroke="var(--line)"
                stroke-dasharray="2 3"
                vector-effect="non-scaling-stroke"
              />
              <g v-for="(pm, i) in m.pod" :key="pm">
                <circle :cx="m.x + 15" :cy="m.y + 41 + i * 13" r="2.5" :fill="`var(--${tone(pm)})`" />
                <text :x="m.x + 22" :y="m.y + 44 + i * 13" class="p-name">{{ pm }}</text>
              </g>
            </g>
          </g>
        </g>

        <!-- The spine. -->
        <g
          v-for="s in L.spine"
          :key="s.name"
          class="spinenode"
          :class="{ dull: dimNode(s.name), on: focus === s.name, terminal: s.kind !== 'service' }"
          @click="select(s.name)"
          @pointerenter="hover = s.name"
          @pointerleave="hover = null"
        >
          <rect
            :x="s.x"
            :y="s.y"
            :width="s.w"
            :height="s.h"
            rx="8"
            fill="var(--surface-high)"
            :stroke="focus === s.name ? 'var(--accent)' : 'var(--line-strong)'"
            :stroke-width="focus === s.name ? 1.8 : 1"
            :stroke-dasharray="s.kind === 'service' ? '' : '3 3'"
            vector-effect="non-scaling-stroke"
            v-bind="tip.hover(`node-${s.name}`, nodeTip(s.name))"
          />
          <circle
            v-if="s.kind === 'service'"
            :cx="s.x + 11"
            :cy="s.y + 15"
            r="3"
            :fill="`var(--${tone(s.name)})`"
          />
          <text :x="s.kind === 'service' ? s.x + 20 : s.x + 10" :y="s.y + 18" class="n-name">
            {{ fitName(s.name, s.w) }}
          </text>
          <text :x="s.x + 10" :y="s.y + 32" class="n-role">
            {{ fitRole(s.networks.length ? `${s.networks.length} segments` : s.role, s.w) }}
          </text>
        </g>
      </svg>
    </div>

    <p class="legend mono">
      Boxes are segments and what is wholly inside them; the row underneath is the
      {{ L.spine.filter((s) => s.kind === "service").length }} services that are on more than one,
      which is where a trust boundary is actually crossed. A line carries a container's measured
      bytes on a segment - never traffic to one peer, which is not measurable here. {{ summary }}.
      <span v-if="!flowing" class="frozen"> Motion is stopped: these rates are not current.</span>
    </p>
  </div>
</template>

<style scoped>
.wrap {
  min-width: 0;
}

/* THE FLOOR IS 1:1, AND BELOW IT THE PANEL SCROLLS. The drawing reflows to
   fewer columns as the panel narrows, so it reaches a phone at its natural
   size; min-width stops the last rung being scaled DOWN, which is what put
   13px names at 2.6px in the version this replaces. Scaling UP is safe and
   deliberate: the type floor is a floor. */
.graph {
  width: 100%;
  height: auto;
  display: block;
}

.graph:focus-visible {
  outline: 2px solid var(--accent);
  outline-offset: 3px;
  border-radius: var(--r-sm);
}

/* THE ANIMATION THAT HAD NO animation-name FOR AS LONG AS IT EXISTED. The
   keyframe is global, in tokens.css, next to the argument for animating by the
   dash period rather than the path length; the rule that runs it belongs with
   the element it applies to. */
.flow {
  animation-name: flow;
  animation-timing-function: linear;
  animation-iteration-count: infinite;
}

.group,
.spinenode {
  cursor: pointer;
  transition: opacity 120ms linear;
}

.group.dull,
.spinenode.dull,
.elbows .dull {
  opacity: 0.22;
}

.g-name {
  font: var(--t-mono-md);
  fill: var(--fg-2);
}

.g-sub,
.g-count {
  font: var(--t-mono-xs);
  fill: var(--fg-dim);
}

.n-name {
  font: var(--t-mono-md);
  fill: var(--fg-2);
}

.n-role {
  font: var(--t-mono-xs);
  fill: var(--fg-dim);
}

.p-name {
  font: var(--t-mono-xs);
  fill: var(--fg-4);
}

.legend {
  margin-top: 12px;
  padding-top: 10px;
  border-top: 1px solid var(--line);
  font: var(--t-mono-sm);
  color: var(--fg-5);
}

.frozen {
  color: var(--warn);
}
</style>
