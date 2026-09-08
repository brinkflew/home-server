// =============================================================================
// The topology, as coordinates
// -----------------------------------------------------------------------------
// Pure arithmetic, no Vue and no DOM, the same shape as src/charts.ts - and for
// the same reason: this is the part that has to be checkable in node, and
// fixtures/smoke.mjs checks it.
//
// LAYOUT IS COMPUTED, NOT HAND-PLACED. That sentence is inherited from the two
// drawings this replaces, and it is the constraint the whole file exists to
// keep: "a diagram that is expensive to update is a diagram that stops being
// true". Adding a network is one entry in topology.ts and adding a service is
// one entry plus its edges - never a coordinate.
//
// IT GROUPS BY NETWORK NOW, AND THE OLD ARRANGEMENT WAS A LINE PER SEGMENT.
// Ten horizontal rails with boxes packed along them read as ten unrelated lists
// that happened to share a canvas: 1498x856 with six of sixty grid cells
// occupied, nine of ten rails holding five boxes or fewer, and five of them
// holding exactly one. What a reader wants from this page is "what is on
// net-solver, and what else can that thing reach" - which is a set, drawn as a
// box, not a row.
//
// THE DRAWING IS STILL BIPARTITE BECAUSE THE MEASUREMENT STILL IS. The
// collector produces (container, network) pairs: a container's bytes on a
// segment. It cannot produce container-to-container, because per-flow
// accounting is unavailable on this host - conntrack is unreadable and nsenter
// is EPERM. So a group is a vertex and the only line carrying a measured rate
// is the elbow from a multi-homed service to a group. A point-to-point arrow
// with a number on it would be a claim nothing supports.
//
// WHY A SPINE, AND WHY NOT THE TWO OBVIOUS ALTERNATIVES. Twenty of the
// twenty-five containers are on exactly one segment and belong inside its box.
// The other five are the interesting ones - caddy on eight, prowlarr on three,
// sonarr, radarr and jellyseerr on two - and straddling a trust boundary is the
// security-relevant fact about them, so it has to be a line and not a list.
// Drawing a copy of caddy inside all eight groups says the opposite of what is
// true; assigning it a "primary" group makes its home an artefact of which
// Network= line comes first in its quadlet. A spine says what is actually the
// case: these five are not inside any one segment.
//
// AND ELBOWS ROUTE IN RESERVED BANDS, WHICH IS NOT DECORATION. caddy alone
// needs eight lines reaching most of the canvas, so any routing that goes
// "straight at the target" draws through the group boxes it passes. Each grid
// row therefore has a clear band above it, each spine node owns one lane in
// every band it uses and one vertical lane in the left margin, and a line is
// margin -> band -> down into the group's top edge. No segment of any elbow
// ever crosses a group, and no two elbows share a lane. smoke.mjs asserts both.
// =============================================================================

import { PATHS, isPseudo } from "@/paths";

// --- the group grid -----------------------------------------------------------
export const GROUP_W = 292;
export const GROUP_GAP_X = 26;
/** The group header: id, then purpose and subnet on a second line. */
export const GROUP_HEAD = 42;
export const GROUP_PAD = 9;
/** A member row inside a group. */
export const MEMBER_H = 34;
export const MEMBER_GAP = 5;
/** A pod member, nested under the container that holds the namespace. */
export const POD_H = 13;

// --- the spine ----------------------------------------------------------------
export const SPINE_W = 168;
export const SPINE_H = 42;
export const SPINE_GAP = 14;

// --- routing ------------------------------------------------------------------
/** One vertical lane per spine node, in the left margin. */
export const LANE_X = 13;
/** One horizontal lane per spine node routing through a given band. */
export const LANE_Y = 13;
export const LANE_PAD = 10;
/** Clear space above the first row even when nothing routes through it. */
export const BAND_MIN = 16;
export const TOP_PAD = 6;
export const BOTTOM_PAD = 10;
/** The corner radius on every elbow. */
export const CORNER_R = 9;

// -----------------------------------------------------------------------------
// What the page hands in
// -----------------------------------------------------------------------------
// THE MODEL IS DATA, NOT topology.ts. The old layout() imported NODES directly,
// which is why the drawing could only ever show what git declares - a container
// podman had attached to a segment nobody wrote down had nowhere to appear.
// network.ts builds this from the declared topology unioned with what the host
// reports, so a stray is drawn where it actually is.

export interface GraphMember {
  name: string;
  role: string;
  /** Every segment it is on. More than one puts it on the spine. */
  networks: string[];
  /** Pod members, which have no stack of their own and are drawn nested. */
  pod: string[];
}

export interface GraphGroup {
  id: string;
  purpose: string;
  subnet: string;
  /** The single-homed members, in the order they should read. */
  members: GraphMember[];
}

/** A spine entry: a multi-homed service, the tunnel, or a terminal. */
export interface GraphSpine extends GraphMember {
  kind: "service" | "tunnel" | "terminal";
  /** Spine-to-spine links, for `wan -> caddy`. Routed under the spine row. */
  links: string[];
}

export interface GraphModel {
  groups: GraphGroup[];
  spine: GraphSpine[];
}

// -----------------------------------------------------------------------------
// What it gets back
// -----------------------------------------------------------------------------

export interface PlacedMember {
  name: string;
  role: string;
  x: number;
  y: number;
  w: number;
  h: number;
  pod: string[];
}

export interface PlacedGroup {
  id: string;
  purpose: string;
  subnet: string;
  x: number;
  y: number;
  w: number;
  h: number;
  row: number;
  col: number;
  members: PlacedMember[];
}

export interface PlacedSpine {
  name: string;
  role: string;
  kind: "service" | "tunnel" | "terminal";
  x: number;
  y: number;
  w: number;
  h: number;
  networks: string[];
  pod: string[];
}

export interface Elbow {
  key: string;
  /** The spine node this line belongs to. */
  node: string;
  /** The group it reaches, or the spine node for a spine-to-spine link. */
  target: string;
  d: string;
  /** Where to hang a magnitude tick: the midpoint of the horizontal run. */
  tickX: number;
  tickY: number;
}

export interface Layout {
  width: number;
  height: number;
  columns: number;
  groups: PlacedGroup[];
  spine: PlacedSpine[];
  elbows: Elbow[];
  /** The top of the spine band, for the component's own chrome. */
  spineY: number;
}

// -----------------------------------------------------------------------------
// Rounded orthogonal paths
// -----------------------------------------------------------------------------

type Pt = readonly [number, number];

function same(a: Pt, b: Pt): boolean {
  return Math.abs(a[0] - b[0]) < 0.01 && Math.abs(a[1] - b[1]) < 0.01;
}

function len(a: Pt, b: Pt): number {
  return Math.hypot(b[0] - a[0], b[1] - a[1]);
}

/** `d` units from `from` towards `to`. */
function towards(from: Pt, to: Pt, d: number): Pt {
  const l = len(from, to);
  if (l === 0) return from;
  return [from[0] + ((to[0] - from[0]) * d) / l, from[1] + ((to[1] - from[1]) * d) / l];
}

function n(v: number): string {
  return (Math.round(v * 100) / 100).toString();
}

/**
 * An orthogonal path with rounded corners.
 *
 * THE RADIUS IS CLAMPED TO HALF THE SHORTER ADJACENT LEG, and that is the whole
 * correctness of this function. A fixed radius on a leg shorter than 2r pulls
 * the curve's start point PAST the previous corner, so the line doubles back on
 * itself - a visible hook, at whichever corner happens to be tight, appearing
 * only at one viewport because the leg lengths move with the column count.
 *
 * A COLLINEAR VERTEX EMITS NO CURVE. Three points on one line have no corner to
 * round, and a quadratic through them is a no-op that still costs a segment;
 * more to the point the clamp above would compute a radius for a bend that does
 * not exist. Duplicate points are dropped first for the same reason - a
 * zero-length leg makes the direction undefined rather than merely small.
 */
export function roundedPath(points: readonly Pt[], r = CORNER_R): string {
  const pts: Pt[] = [];
  for (const p of points) {
    if (!Number.isFinite(p[0]) || !Number.isFinite(p[1])) continue;
    if (pts.length === 0 || !same(pts[pts.length - 1] as Pt, p)) pts.push(p);
  }
  if (pts.length === 0) return "";
  const first = pts[0] as Pt;
  if (pts.length === 1) return `M ${n(first[0])} ${n(first[1])}`;

  let d = `M ${n(first[0])} ${n(first[1])}`;
  for (let i = 1; i < pts.length - 1; i += 1) {
    const prev = pts[i - 1] as Pt;
    const cur = pts[i] as Pt;
    const next = pts[i + 1] as Pt;

    const cross = (cur[0] - prev[0]) * (next[1] - cur[1]) - (cur[1] - prev[1]) * (next[0] - cur[0]);
    if (Math.abs(cross) < 0.01) continue;

    const rr = Math.min(r, len(prev, cur) / 2, len(cur, next) / 2);
    const a = towards(cur, prev, rr);
    const b = towards(cur, next, rr);
    d += ` L ${n(a[0])} ${n(a[1])} Q ${n(cur[0])} ${n(cur[1])} ${n(b[0])} ${n(b[1])}`;
  }
  const last = pts[pts.length - 1] as Pt;
  return `${d} L ${n(last[0])} ${n(last[1])}`;
}

// -----------------------------------------------------------------------------
// The layout
// -----------------------------------------------------------------------------

function memberHeight(m: GraphMember): number {
  return MEMBER_H + (m.pod.length ? m.pod.length * POD_H + 6 : 0);
}

function groupHeight(g: GraphGroup): number {
  if (g.members.length === 0) return GROUP_HEAD + GROUP_PAD + 22;
  const rows = g.members.reduce((h, m) => h + memberHeight(m) + MEMBER_GAP, 0) - MEMBER_GAP;
  return GROUP_HEAD + rows + GROUP_PAD;
}

/**
 * The whole drawing, for a given column count.
 *
 * COLUMNS ARE AN ARGUMENT, WHICH IS WHAT MAKES THIS REFLOW RATHER THAN SHRINK.
 * The old drawing was a fixed 1498x856 with an aspect-preserving viewBox, so a
 * 390px panel rendered it at a factor of 0.197 - 13px node names at 2.6px, and
 * the hairlines surviving intact because they carry non-scaling-stroke. A grey
 * smear of rules connecting things nobody can read. The repair at the time was
 * to pan it at a 900px floor, which still renders those names at 7.8px, under a
 * type floor this application states as 11px at every width.
 *
 * Nothing shrinks to fit here. Fewer columns, a taller drawing, same type.
 */
export function layout(model: GraphModel, columns = 3): Layout {
  const cols = Math.max(1, Math.floor(columns));

  // --- place the groups on a grid ---------------------------------------------
  const heights = model.groups.map(groupHeight);
  const rowCount = Math.ceil(model.groups.length / cols) || 1;
  const rowH: number[] = [];
  for (let r = 0; r < rowCount; r += 1) {
    let h = 0;
    for (let i = r * cols; i < Math.min((r + 1) * cols, model.groups.length); i += 1) {
      h = Math.max(h, heights[i] ?? 0);
    }
    rowH.push(h);
  }

  const rowOf = new Map<string, number>();
  model.groups.forEach((g, i) => rowOf.set(g.id, Math.floor(i / cols)));

  // --- work out how many lanes each band needs --------------------------------
  // A BAND IS SIZED BY WHAT ACTUALLY ROUTES THROUGH IT, not by the spine's
  // length. Reserving six lanes above every row would add ~78px of white space
  // four times over for the two rows that carry one line each.
  const routing = model.spine.filter((s) => s.networks.length > 0);
  const laneIndex = new Map<string, number>();
  routing.forEach((s, i) => laneIndex.set(s.name, i));

  const bandLanes: Map<number, string[]> = new Map();
  for (let r = 0; r < rowCount; r += 1) bandLanes.set(r, []);
  for (const s of routing) {
    const rows = new Set<number>();
    for (const net of s.networks) {
      const r = rowOf.get(net);
      if (r !== undefined) rows.add(r);
    }
    for (const r of rows) bandLanes.get(r)?.push(s.name);
  }

  const bandH: number[] = [];
  for (let r = 0; r < rowCount; r += 1) {
    bandH.push(Math.max(BAND_MIN, (bandLanes.get(r)?.length ?? 0) * LANE_Y + 8));
  }

  // --- the left margin, one vertical lane per routing spine node --------------
  const marginL = routing.length ? LANE_PAD + routing.length * LANE_X + 6 : LANE_PAD;

  const rowY: number[] = [];
  let y = TOP_PAD;
  for (let r = 0; r < rowCount; r += 1) {
    y += bandH[r] ?? BAND_MIN;
    rowY.push(y);
    y += rowH[r] ?? 0;
  }

  const groups: PlacedGroup[] = model.groups.map((g, i) => {
    const col = i % cols;
    const row = Math.floor(i / cols);
    const gx = marginL + col * (GROUP_W + GROUP_GAP_X);
    const gy = rowY[row] ?? TOP_PAD;

    let my = gy + GROUP_HEAD;
    const members: PlacedMember[] = g.members.map((m) => {
      const h = memberHeight(m);
      const placed: PlacedMember = {
        name: m.name,
        role: m.role,
        x: gx + GROUP_PAD,
        y: my,
        w: GROUP_W - GROUP_PAD * 2,
        h,
        pod: m.pod,
      };
      my += h + MEMBER_GAP;
      return placed;
    });

    return {
      id: g.id,
      purpose: g.purpose,
      subnet: g.subnet,
      x: gx,
      y: gy,
      w: GROUP_W,
      h: heights[i] ?? GROUP_HEAD,
      row,
      col,
      members,
    };
  });

  const gridW = marginL + cols * GROUP_W + (cols - 1) * GROUP_GAP_X + LANE_PAD;

  // --- the spine --------------------------------------------------------------
  const spineTop = y + BAND_MIN;
  const perRow = Math.max(1, Math.floor((gridW - marginL) / (SPINE_W + SPINE_GAP)));
  const spine: PlacedSpine[] = model.spine.map((s, i) => ({
    name: s.name,
    role: s.role,
    kind: s.kind,
    x: marginL + (i % perRow) * (SPINE_W + SPINE_GAP),
    y: spineTop + Math.floor(i / perRow) * (SPINE_H + SPINE_GAP),
    w: SPINE_W,
    h: SPINE_H,
    networks: s.networks,
    pod: s.pod,
  }));
  const spineRows = Math.ceil(model.spine.length / perRow) || 1;
  const spineBottom = spineTop + spineRows * SPINE_H + (spineRows - 1) * SPINE_GAP;

  const byName = new Map(spine.map((s) => [s.name, s]));
  const byId = new Map(groups.map((g) => [g.id, g]));

  // --- the elbows -------------------------------------------------------------
  // Anchors are shared out along a group's top edge so two lines never enter it
  // at the same point, which would read as one line.
  const incoming = new Map<string, string[]>();
  for (const s of routing) {
    for (const net of s.networks) {
      if (!byId.has(net)) continue;
      const list = incoming.get(net) ?? [];
      list.push(s.name);
      incoming.set(net, list);
    }
  }

  const elbows: Elbow[] = [];
  for (const s of routing) {
    const node = byName.get(s.name);
    if (!node) continue;
    const laneX = LANE_PAD + (laneIndex.get(s.name) ?? 0) * LANE_X;
    const cy = node.y + node.h / 2;

    for (const net of s.networks) {
      const g = byId.get(net);
      if (!g) continue;

      const lanes = bandLanes.get(g.row) ?? [];
      const slot = lanes.indexOf(s.name);
      const bandTop = (rowY[g.row] ?? TOP_PAD) - (bandH[g.row] ?? BAND_MIN);
      const laneY = bandTop + 5 + Math.max(0, slot) * LANE_Y;

      const peers = incoming.get(net) ?? [];
      const at = Math.max(0, peers.indexOf(s.name));
      const anchorX = g.x + (GROUP_W * (at + 1)) / (peers.length + 1);

      elbows.push({
        key: `${s.name}|${net}`,
        node: s.name,
        target: net,
        d: roundedPath([
          [node.x, cy],
          [laneX, cy],
          [laneX, laneY],
          [anchorX, laneY],
          [anchorX, g.y],
        ]),
        tickX: (laneX + anchorX) / 2,
        tickY: laneY,
      });
    }
  }

  // Spine-to-spine, routed UNDER the spine row so it cannot cross a node box.
  const underY = spineBottom + 9;
  for (const s of model.spine) {
    const from = byName.get(s.name);
    if (!from) continue;
    for (const link of s.links) {
      const to = byName.get(link);
      if (!to) continue;
      elbows.push({
        key: `${s.name}>${link}`,
        node: s.name,
        target: link,
        d: roundedPath([
          [from.x + from.w / 2, from.y + from.h],
          [from.x + from.w / 2, underY],
          [to.x + to.w / 2, underY],
          [to.x + to.w / 2, to.y + to.h],
        ]),
        tickX: (from.x + to.x + from.w) / 2,
        tickY: underY,
      });
    }
  }

  const hasUnder = model.spine.some((s) => s.links.length > 0);

  return {
    width: gridW,
    height: (hasUnder ? underY + 6 : spineBottom) + BOTTOM_PAD,
    columns: cols,
    groups,
    spine,
    elbows,
    spineY: spineTop,
  };
}

/**
 * The widest grid that fits a measured panel, for a given number of columns.
 *
 * Derived from the constants above rather than written as a literal, which is
 * the fix docs/dashboard.md records twice under a different name: fitRole's
 * hardcoded 5.9 and Y_GUTTER's 46 were both measurements that stopped being
 * true when something else moved, silently.
 */
export function gridWidth(columns: number, lanes = 6): number {
  const marginL = LANE_PAD + lanes * LANE_X + 6;
  return marginL + columns * GROUP_W + (columns - 1) * GROUP_GAP_X + LANE_PAD;
}

/** The widest layout for a panel, 3 columns down to 1. */
export const MAX_COLUMNS = 3;

/**
 * The column count for a measured panel width.
 *
 * IT FOLDS WHEN THE NEXT COLUMN NO LONGER FITS, not on the table ladder.
 * base.css puts that ladder at 1180 / 900 / 640 and every table sheds a column
 * at each, which is right for a table: its columns are priorities and the
 * lowest one goes. A drawing has no lowest-priority group - all ten have to be
 * on screen - so the only question it can answer is how many boxes fit side by
 * side, and using 900 here would leave an 834px tablet showing ONE column with
 * 448px of empty canvas beside it.
 *
 * The drawing then scales to fill, which is safe in this direction only: the
 * type floor is a floor, so rendering 11px type at 13 is fine and rendering it
 * at 7.8 - which the panned version did at its own 900px floor - is not.
 */
export function columnsFor(width: number): number {
  if (!Number.isFinite(width) || width <= 0) return MAX_COLUMNS;
  for (let c = MAX_COLUMNS; c > 1; c -= 1) {
    if (width >= gridWidth(c)) return c;
  }
  return 1;
}

// -----------------------------------------------------------------------------
// Traffic
// -----------------------------------------------------------------------------

/**
 * Rate to a 0..1 intensity.
 *
 * LOGARITHMIC, because the quantity spans five orders of magnitude here: ntfy
 * moves bytes a second and the torrent tunnel moves megabytes. On a linear
 * scale 1 MB/s lands at 0.01 and every real reading sits in the bottom one
 * percent, so every edge would look identical to idle. Log puts 1 MB/s near
 * 0.6, and it matches how format.ts already thinks - in binary decades.
 *
 * Below the floor the answer is 0 rather than a small number: a link carrying
 * a keepalive is idle, and drawing it as moving spends the reader's attention
 * on nothing.
 */
export const RATE_FLOOR = 1024;
export const RATE_CEIL = 100 * 1024 ** 2;

export function intensity(rate: number): number {
  if (!Number.isFinite(rate) || rate < RATE_FLOOR) return 0;
  const t = Math.log(rate / RATE_FLOOR) / Math.log(RATE_CEIL / RATE_FLOOR);
  return Math.min(1, Math.max(0, t));
}

/** Seconds per dash cycle. Faster is busier; the range is deliberately narrow
 *  so that "moving" and "moving fast" stay distinguishable from "still". */
export function flowDuration(rate: number): number {
  return 6 - intensity(rate) * 5;
}

// -----------------------------------------------------------------------------
// Text
// -----------------------------------------------------------------------------

/**
 * Fit a line of mono text to a box, by measuring rather than guessing.
 *
 * THE ADVANCE IS TIED TO A TYPE ROLE AND MOVES WITH IT. This was one hardcoded
 * 5.9, for Azeret Mono at 9.5px, and it was silently wrong the moment the type
 * scale moved to Spline Sans Mono with an 11px floor: the role kept truncating
 * at the old CHARACTER count while each of those characters had grown, so the
 * text ran to within 4px of a 150px box. A label that overflows its box reads
 * as a rendering bug rather than as a truncation, which is the whole reason
 * this function exists.
 *
 * Both numbers are measured in the browser at the sizes tokens.css sets:
 * --t-mono-xs is 11px and --t-mono-md is 13px, and Spline Sans Mono advances
 * 0.6em, so 6.6 and 7.8.
 */
const ADV_ROLE = 6.6; // --t-mono-xs, 11px
const ADV_NAME = 7.8; // --t-mono-md, 13px

function fit(text: string, budget: number, advance: number): string {
  const max = Math.floor(budget / advance);
  if (max < 1) return "";
  return text.length <= max ? text : `${text.slice(0, Math.max(1, max - 1))}.`;
}

/** The role line, inset 9px on both sides of the box. */
export function fitRole(role: string, width = GROUP_W - GROUP_PAD * 2): string {
  return fit(role, width - 18, ADV_ROLE);
}

/** The name, inset 20px on the left for the status dot and 9px right. */
export function fitName(name: string, width = GROUP_W - GROUP_PAD * 2): string {
  return fit(name, width - 29, ADV_NAME);
}

// -----------------------------------------------------------------------------
// Declared routes
// -----------------------------------------------------------------------------

/**
 * Every declared route touching a node, as endpoint names.
 *
 * Reachability comes from git and motion comes from measurement; the two are
 * drawn in different visual languages and must never be able to borrow each
 * other's credibility. This is the git half, and it is shown on demand only.
 */
export function routesTouching(node: string): { from: string; to: string; why: string; runtime: boolean }[] {
  return PATHS.filter((p) => p.from === node || p.to === node).map((p) => ({
    from: p.from,
    to: p.to,
    why: p.why,
    runtime: p.source === "runtime",
  }));
}

export { isPseudo };
