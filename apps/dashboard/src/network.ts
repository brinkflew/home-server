// =============================================================================
// The segmentation, as /network draws it
// -----------------------------------------------------------------------------
// PURE, AND EVERY READING IS AN ARGUMENT. Nothing here touches a store, a clock
// or a poll; the page hands in what it has and gets back what to draw. The
// reason is the one machine.ts, lanes.ts, system.ts and services.ts each give:
// a computed inside a .vue file is code fixtures/smoke.mjs structurally cannot
// call, and every decision below has a wrong answer that renders perfectly.
//
// THE PAGE HAD FOUR OF THEM, AND NONE WAS VISIBLE AT ANY VIEWPORT:
//
//   - A STOPPED CONTAINER DREW GREY. home_server_container_running is ABSENT
//     rather than 0 for a container that is not running, so it never entered
//     the tone map and every box fell back to `off`. containerTone's !running
//     branch was unreachable from this page - the same defect fixed on
//     /services on 2026-09-08, one page over, in the page whose entire job is
//     "what can reach what". Fixed here by asking the UNIT, through
//     services.ts's own liveness(), which is called and never reimplemented.
//
//   - THE torrent BOX WAS DEAD ON THE LIVE HOST. topology.ts calls the node
//     `torrent`; podman labels the metric `torrent-infra`. The graph joined on
//     the node name, so on the real host that box read "not measured" on every
//     rail - and the fixture built its pairs from the node name too, so dev
//     showed it working. A fixture derived from its consumer cannot contradict
//     the consumer, for the third time. metricNameFor() is the one copy of the
//     bridge now, and podMembers() - dead code until today - is what decides it.
//
//   - MEMBERSHIP WAS INFERRED FROM TRAFFIC. Which containers are on a segment
//     came from whichever rate(...[5m]) pairs happened to come back, so a
//     container restarted inside the window returned no series and dropped out
//     of its own segment, and a failed subnet join looked exactly like a
//     detachment. home_server_container_attached is podman's own answer.
//
//   - "ALL isolate=true" WAS A SENTENCE. The page printed it as static text
//     compiled into the bundle while nothing on the host measured isolate on a
//     stack segment at all. It is a series now, and a segment that lost it is
//     a finding rather than a paragraph.
//
// DECLARED AND LIVE ARE TWO DIFFERENT CLAIMS AND THIS FILE KEEPS THEM APART.
// topology.ts is git: what stacks/ says ought to be attached, checked against
// stacks/ by bin/lint-repo.sh. The series are the host: what podman has
// actually done. Neither outranks the other - where they DIFFER is the finding,
// and that difference is the one thing no previous version of this page could
// express, because it only ever had one of the two.
//
// AN UNDECLARED NETWORK IS NOT A FINDING. net-ci-* and net-conduct-* are
// created and destroyed by the CI and phase drivers, deliberately outside
// stacks/ - known-state records that keeping them out of topology.ts is what
// keeps the whole change out of agents.runner_isolation's stack list. podman's
// own default bridge is a third case and carries no isolate option at all. All
// three are reported and none is judged: a check that fires every time CI runs
// is a check somebody turns off.
// =============================================================================

import * as fmt from "@/format";
import type { GraphGroup, GraphModel, GraphSpine } from "@/graph";
import { PATHS, PSEUDO_NODES, isPseudo } from "@/paths";
import { liveness, type UnitReading } from "@/services";
import { NETWORKS, NODES, podMembers, type Node } from "@/topology";
import type { Tone } from "@/types";

/** fail beats warn beats off beats ok, which is /system's ranking. */
const RANK: Record<Tone, number> = { fail: 3, warn: 2, off: 1, ok: 0 };

function worst(a: Tone, b: Tone): Tone {
  return RANK[b] > RANK[a] ? b : a;
}

/**
 * The pod's egress, which is not a podman network.
 *
 * gluetun steers traffic onto tun0 with firewall marks and policy routing, so
 * it has no on-link route and matches no subnet; the collector classifies it on
 * the kernel's own tun and wg device naming and labels it `tunnel`. It is the
 * biggest number on the host - and until today it appeared on the drawing
 * nowhere at all, because it is not a member of NETWORKS and so had no rail.
 */
export const TUNNEL = "tunnel";

/** Networks the drivers create and destroy, outside stacks/ by design. */
const EPHEMERAL_NETWORK = /^net-(ci|conduct)-/;

// -----------------------------------------------------------------------------
// The name bridge
// -----------------------------------------------------------------------------

/**
 * A topology node's name as the metrics label it.
 *
 * ONE COPY, AND THE RULE IS DERIVED RATHER THAN LISTED. A pod's infra container
 * is `<pod>-infra` to podman while topology.ts names the node after the pod, so
 * anything joining a node to a series has to bridge it. services.ts does the
 * same crossing in the other direction, through the unit label, because that is
 * what it has; here the node list is in hand, so "is this node a pod" is simply
 * "does anything declare it as its pod" - which is what podMembers() answers.
 *
 * A hardcoded `torrent -> torrent-infra` would work today and would be silently
 * wrong the day a second pod is added.
 */
export function metricNameFor(node: string): string {
  return podMembers(node).length > 0 ? `${node}-infra` : node;
}

/** The inverse, for reading a series label back to a node. */
export function nodeNameFor(metric: string): string {
  const stem = metric.replace(/-infra$/, "");
  return stem !== metric && podMembers(stem).length > 0 ? stem : metric;
}

// -----------------------------------------------------------------------------
// What the page hands in
// -----------------------------------------------------------------------------

/** One podman network, from home_server_network_info. */
export interface NetworkReading {
  id: string;
  driver: string;
  subnet: string;
  /** "true", or EMPTY when the option is absent. Never the string "false". */
  isolate: string;
}

/** One published host port, from home_server_container_published_port. */
export interface PortReading {
  container: string;
  /** Empty means every address - the case firewalld governs. */
  hostIp: string;
  hostPort: string;
  containerPort: number;
  protocol: string;
}

/** Re-exported so a page can shape its poll against this module alone. The
 *  reading itself belongs to services.ts, which is where the unit encoding and
 *  the liveness arms live. */
export type { UnitReading };

/** The container half of the liveness join. */
export interface ContainerReading {
  name: string;
  unit: string;
  running: boolean;
  /** undefined when the container defines no health check at all. */
  health: number | undefined;
}

/** container|network -> bytes per second. An ABSENT key is not measured. */
export type PairMap = ReadonlyMap<string, number>;

export interface Verdict {
  tone: Tone;
  state: string;
}

// -----------------------------------------------------------------------------
// Liveness, borrowed whole from /services
// -----------------------------------------------------------------------------

/**
 * Every container's verdict, keyed by the name the METRICS use.
 *
 * THE UNIT IS ASKED, NOT ONLY THE CONTAINER, and that is the whole fix for a
 * stopped service drawing grey. `podman ps` lists running containers, so a
 * container that stopped has no `running` series to be 0 - it has no series at
 * all. Enumerating from home_server_unit_state is what makes absence visible,
 * and it is the same source, and the same liveness() call, that /services was
 * rebuilt on.
 *
 * A unit with no container still produces a verdict here: that is the state the
 * page most needs to draw and the one it structurally could not.
 */
export function memberVerdicts(
  units: UnitReading[],
  containers: ContainerReading[],
): Map<string, Verdict> {
  const byUnit = new Map<string, ContainerReading[]>();
  for (const c of containers) {
    if (!c.unit) continue;
    const list = byUnit.get(c.unit) ?? [];
    list.push(c);
    byUnit.set(c.unit, list);
  }

  const out = new Map<string, Verdict>();

  for (const u of units) {
    const members = byUnit.get(u.unit) ?? [];
    if (members.length === 0) {
      // A unit with nothing under it. The name is the only thing to call it by,
      // and it is what a container would have been called.
      const v = liveness(false, false, undefined, u.state, u.restarts, u.unit);
      out.set(fmt.unitName(u.unit), { tone: v.tone, state: v.state });
      continue;
    }
    for (const c of members) {
      const v = liveness(true, c.running, c.health, u.state, u.restarts, u.unit);
      out.set(c.name, { tone: v.tone, state: v.state });
    }
  }

  // A container whose unit did not answer. Rare, and it must not vanish: the
  // unit series is the enumeration, but a container podman reports and systemd
  // does not is exactly the anomaly worth drawing.
  for (const c of containers) {
    if (out.has(c.name)) continue;
    const v = liveness(true, c.running, c.health, Number.NaN, Number.NaN, c.unit);
    out.set(c.name, { tone: v.tone, state: v.state });
  }

  return out;
}

// -----------------------------------------------------------------------------
// The rows
// -----------------------------------------------------------------------------

export type SegmentKind = "declared" | "ephemeral" | "other" | "tunnel";

export interface MemberRef {
  /** The topology node name, which is what a reader recognises. */
  name: string;
  /** The name the series use. Differs for a pod - see metricNameFor(). */
  metric: string;
  role: string;
  /** In stacks/, per topology.ts. */
  declared: boolean;
  /** podman says it is on this bridge, right now. */
  attached: boolean;
  /** On more than one segment: these go on the spine rather than in a group. */
  multi: boolean;
  /** Its own networks, in declaration order. */
  networks: string[];
  /** Pod members, which have no stack of their own and are drawn nested. */
  pod: Node[];
  tone: Tone;
  state: string;
  /** Bytes per second on THIS segment. NaN is not measured, and is not zero. */
  rx: number;
  tx: number;
  /** Set when declared and live disagree. */
  issue: string | null;
  /**
   * The drift, as a word, and NOT the container's liveness.
   *
   * The two are different questions and the attention table conflated them:
   * bazarr on a segment nobody declared it on read STATE "unhealthy", which is
   * true about bazarr and says nothing about the row it was on. The state
   * column has to name the fault the row is reporting.
   */
  drift: string | null;
}

export interface SegmentRow {
  id: string;
  purpose: string;
  kind: SegmentKind;
  /** In topology.ts, so in stacks/. */
  declared: boolean;
  /** podman reports the bridge exists. */
  present: boolean;
  driver: string;
  subnet: string;
  /** undefined when no info series came back at all. */
  isolate: string | undefined;
  members: MemberRef[];
  /** Both directions of every member, added up. Double-counts by design. */
  bytes: number;
  measured: boolean;
  tone: Tone;
  state: string;
  issue: string | null;
  /**
   * Whose fault the issue is.
   *
   * A SEGMENT INHERITS ITS MEMBERS' TROUBLE FOR THE TABLE AND MUST NOT REPEAT
   * IT IN THE LIST. net-egress drew "membership drift - not running, so it
   * holds no address on this segment" one row above duckdns drawing the
   * identical sentence: one finding, printed twice, which is the defect
   * docs/dashboard.md records about the System page's findings strip. The rail
   * still carries the tone, because a reader scanning the segment table needs
   * to see that something under it is wrong.
   */
  fault: "segment" | "member" | null;
}

function kindOf(id: string, declared: boolean): SegmentKind {
  if (id === TUNNEL) return "tunnel";
  if (declared) return "declared";
  return EPHEMERAL_NETWORK.test(id) ? "ephemeral" : "other";
}

/**
 * The segments, with their members joined on.
 *
 * ENUMERATED FROM BOTH SIDES. Every segment topology.ts declares appears, live
 * or not - a bridge that has gone is the state most worth seeing and it would
 * be absent from a list built only from the series. Every network the host
 * reports appears too, so a segment nobody declared cannot hide.
 */
export function segmentRows(
  networks: NetworkReading[],
  attached: ReadonlyMap<string, Set<string>>,
  rx: PairMap,
  tx: PairMap,
  verdicts: ReadonlyMap<string, Verdict>,
): SegmentRow[] {
  const live = new Map(networks.map((n) => [n.id, n]));
  const measuredNetworks = networks.length > 0;

  // Every id either side knows about, declared ones first and in their own
  // order - NETWORKS is sequenced as the design reads it, ingress outwards.
  const ids: string[] = NETWORKS.map((n) => n.id);
  for (const n of networks) if (!ids.includes(n.id)) ids.push(n.id);

  // The tunnel is last and always drawn: it is the pod's only way out, so
  // "no series for it" is a finding rather than a row to omit.
  const hasTunnelTraffic = [...rx.keys(), ...tx.keys()].some((k) => k.endsWith(`|${TUNNEL}`));
  if (hasTunnelTraffic || NODES.some((n) => podMembers(n.name).length > 0)) ids.push(TUNNEL);

  const rows: SegmentRow[] = [];

  for (const id of ids) {
    const spec = NETWORKS.find((n) => n.id === id);
    const declared = spec !== undefined;
    const info = live.get(id);
    const kind = kindOf(id, declared);

    const members = membersFor(id, kind, attached, rx, tx, verdicts);

    let bytes = 0;
    let measured = false;
    for (const m of members) {
      // MEASURED IS rx OR tx, NOT rx ALONE. The previous version set the flag
      // in the receive loop only, so a pair with transmit data and no receive
      // data printed a byte figure AND the words "not measured".
      if (Number.isFinite(m.rx)) {
        bytes += m.rx;
        measured = true;
      }
      if (Number.isFinite(m.tx)) {
        bytes += m.tx;
        measured = true;
      }
    }

    rows.push({
      id,
      purpose: spec?.purpose ?? purposeOf(kind),
      kind,
      declared,
      present: kind === "tunnel" ? measured : info !== undefined,
      driver: info?.driver ?? "",
      subnet: info?.subnet ?? "",
      isolate: measuredNetworks || info ? (info?.isolate ?? "") : undefined,
      members,
      bytes,
      measured,
      ...segmentVerdict(id, kind, declared, info, measuredNetworks, members),
    });
  }

  return rows;
}

function purposeOf(kind: SegmentKind): string {
  if (kind === "tunnel") return "the VPN pod's only way out";
  if (kind === "ephemeral") return "created by a driver, outside stacks/";
  return "on the host, not in stacks/";
}

function membersFor(
  id: string,
  kind: SegmentKind,
  attached: ReadonlyMap<string, Set<string>>,
  rx: PairMap,
  tx: PairMap,
  verdicts: ReadonlyMap<string, Verdict>,
): MemberRef[] {
  const out: MemberRef[] = [];
  const seen = new Set<string>();

  const push = (node: Node | undefined, metric: string, isDeclared: boolean): void => {
    if (seen.has(metric)) return;
    seen.add(metric);
    const key = `${metric}|${id}`;
    const v = verdicts.get(metric);
    const isAttached = attached.get(metric)?.has(id) ?? false;

    // WHERE THIS CONTAINER LIVES, FROM BOTH SIDES. Declared membership unioned
    // with what podman actually reports - and the union is what decides whether
    // it is drawn inside one group or out on the spine.
    //
    // COMPUTING IT FROM topology.ts ALONE WAS WRONG IN THE ONE CASE THE SPINE
    // EXISTS FOR. A container that has drifted onto a second segment IS
    // multi-homed - it holds an address on two bridges - and reading only the
    // declared list drew it inside two group boxes instead, which says "these
    // are two different things" about one container. The stray is precisely the
    // crossing somebody needs to see.
    const homes = new Set([...(node?.networks ?? []), ...(attached.get(metric) ?? [])]);

    out.push({
      name: node?.name ?? nodeNameFor(metric),
      metric,
      role: node?.role ?? "",
      declared: isDeclared,
      attached: isAttached,
      // The tunnel is not a segment, so a pod is not a spine node by virtue of
      // also having an egress.
      multi: homes.size > 1,
      networks: [...homes],
      pod: node ? podMembers(node.name) : [],
      tone: v?.tone ?? "off",
      state: v?.state ?? "not measured",
      rx: rx.get(key) ?? Number.NaN,
      tx: tx.get(key) ?? Number.NaN,
      ...memberIssue(kind, isDeclared, isAttached, v),
    });
  };

  // Declared members first, in topology order, so a segment reads the way
  // stacks/ writes it.
  for (const n of NODES) {
    if (!n.networks.includes(id)) continue;
    push(n, metricNameFor(n.name), true);
  }

  // Then anything podman has attached that nobody declared.
  for (const [metric, nets] of attached) {
    if (!nets.has(id)) continue;
    push(NODES.find((n) => metricNameFor(n.name) === metric), metric, false);
  }

  // The tunnel has no attachment series - it is not a podman network - so its
  // membership comes from the traffic alone.
  if (kind === "tunnel") {
    for (const key of [...rx.keys(), ...tx.keys()]) {
      if (!key.endsWith(`|${id}`)) continue;
      const metric = key.slice(0, -(id.length + 1));
      push(NODES.find((n) => metricNameFor(n.name) === metric), metric, true);
    }
  }

  return out;
}

function memberIssue(
  kind: SegmentKind,
  declared: boolean,
  attached: boolean,
  v: Verdict | undefined,
): { issue: string | null; drift: string | null } {
  const none = { issue: null, drift: null };
  if (kind !== "declared") return none;
  if (declared && !attached) {
    // A SERVICE THAT IS DOWN AND ONE THAT LOST ITS BRIDGE ARE DIFFERENT
    // FAULTS. Both leave the attachment series absent, and only the unit can
    // tell them apart - which is the whole reason this page now asks it.
    if (v && v.tone === "fail") {
      return { issue: `${v.state}, so it holds no address on this segment`, drift: v.state };
    }
    // GREY IS NOT A FINDING. A member nothing reported a verdict for could be
    // detached or could simply be unmeasured, and claiming the first is how a
    // dead collector turns into a page full of red.
    if (!v || v.tone === "off") return none;
    return {
      issue: "stacks/ declares this attachment and podman does not report it",
      drift: "not attached",
    };
  }
  if (!declared && attached) {
    return {
      issue: "podman has this container on the segment and stacks/ does not declare it",
      drift: "undeclared",
    };
  }
  return none;
}

function segmentVerdict(
  id: string,
  kind: SegmentKind,
  declared: boolean,
  info: NetworkReading | undefined,
  measuredNetworks: boolean,
  members: MemberRef[],
): { tone: Tone; state: string; issue: string | null; fault: "segment" | "member" | null } {
  if (kind === "tunnel") {
    const up = members.some((m) => Number.isFinite(m.rx) || Number.isFinite(m.tx));
    return up
      ? { tone: "ok", state: "carrying", issue: null, fault: null }
      : {
          tone: "off",
          state: "not measured",
          issue: "no tunnel device reported inside the pod - the only view of its egress there is",
          fault: "segment",
        };
  }

  if (!measuredNetworks) {
    return { tone: "off", state: "not measured", issue: null, fault: null };
  }

  if (declared && !info) {
    return {
      tone: "fail",
      state: "absent",
      issue: `stacks/ declares ${id} and podman does not have it - every container on it is unreachable by name`,
      fault: "segment",
    };
  }

  // ONLY A DECLARED SEGMENT IS JUDGED ON isolate. net-ci-* and net-conduct-*
  // belong to the drivers and podman's own bridge carries no such option, so
  // grading them would fire on every CI run and on every host, for ever.
  if (declared && info && info.isolate !== "true") {
    return {
      tone: "fail",
      state: "not isolated",
      issue:
        "Options=isolate=true is missing, so this bridge is routable to every other one - " +
        "which is the flat network the segmentation exists to prevent",
      fault: "segment",
    };
  }

  const drifting = members.filter((m) => m.issue !== null);
  if (drifting.length) {
    return {
      tone: declared ? "fail" : "warn",
      state: "membership drift",
      // The sentence is a SUMMARY and the member rows carry the detail. Copying
      // the first member's issue up here is what printed one finding twice.
      issue: `${drifting.length} member(s) here disagree with stacks/`,
      fault: "member",
    };
  }

  if (!declared) {
    return {
      tone: "ok",
      state: kind === "ephemeral" ? "driver-owned" : "not in stacks/",
      issue: null,
      fault: null,
    };
  }

  return { tone: "ok", state: "isolated", issue: null, fault: null };
}

// -----------------------------------------------------------------------------
// Ports
// -----------------------------------------------------------------------------

export interface PortRow {
  key: string;
  container: string;
  /** What a reader sees: "127.0.0.1:8300 -> 8000". */
  mapping: string;
  hostIp: string;
  hostPort: string;
  containerPort: number;
  protocol: string;
  /** Bound to loopback, so firewalld never sees it. */
  loopback: boolean;
  /** topology.ts, and therefore stacks/, declares it. */
  declared: boolean;
  /** podman is publishing it right now. */
  live: boolean;
  tone: Tone;
  state: string;
  issue: string | null;
}

/**
 * The host's port surface, from both sides.
 *
 * WHAT THIS ANSWERS THAT topology.ts COULD NOT. bin/lint-repo.sh compares only
 * the text after the last ":" of a PublishPort=, because the host side is a
 * ${VAR} and the bind address is another - so the host-side numbers in
 * topology.ts are resolved BY HAND and nothing checks them. A publish that
 * moved, or one that quietly stopped happening, was invisible to git and to the
 * page alike. Both halves are here now and disagreement is the finding.
 */
export function portRows(live: PortReading[], declared: { node: string; mapping: string }[]): PortRow[] {
  const rows = new Map<string, PortRow>();

  for (const p of live) {
    const loopback = p.hostIp !== "" && p.hostIp !== "0.0.0.0";
    const bind = loopback ? `${p.hostIp}:${p.hostPort}` : p.hostPort;
    const mapping = `${bind} -> ${p.containerPort}`;
    rows.set(`${p.container}|${mapping}`, {
      key: `${p.container}|${mapping}`,
      container: p.container,
      mapping,
      hostIp: p.hostIp,
      hostPort: p.hostPort,
      containerPort: p.containerPort,
      protocol: p.protocol,
      loopback,
      declared: false,
      live: true,
      tone: "ok",
      state: loopback ? "loopback only" : "faces the LAN",
      issue: null,
    });
  }

  for (const d of declared) {
    const key = `${metricNameFor(d.node)}|${d.mapping}`;
    const hit = rows.get(key);
    if (hit) {
      hit.declared = true;
      continue;
    }
    const loopback = d.mapping.startsWith("127.0.0.1:");
    rows.set(key, {
      key,
      container: metricNameFor(d.node),
      mapping: d.mapping,
      hostIp: loopback ? "127.0.0.1" : "",
      hostPort: d.mapping.split("->")[0]?.trim() ?? "",
      containerPort: Number.NaN,
      protocol: "",
      loopback,
      declared: true,
      live: false,
      tone: "fail",
      state: "not published",
      issue:
        "stacks/ declares this publish and podman is not making it - the port is closed " +
        "on a container that looks perfectly healthy",
    });
  }

  for (const row of rows.values()) {
    if (row.live && !row.declared) {
      row.tone = "warn";
      row.state = "undeclared";
      row.issue = "podman is publishing this and stacks/ does not declare it";
    }
  }

  return [...rows.values()].sort(
    (a, b) => RANK[b.tone] - RANK[a.tone] || a.container.localeCompare(b.container) || a.mapping.localeCompare(b.mapping),
  );
}

// -----------------------------------------------------------------------------
// The readings
// -----------------------------------------------------------------------------

export interface AttentionRow {
  key: string;
  /** What it is: a segment id, or a container plus a port. */
  subject: string;
  where: string;
  tone: Tone;
  state: string;
  issue: string;
}

/**
 * A FILTER OVER WHAT IS ALREADY DRAWN, never a second reading. Two derivations
 * of "what is wrong" drift, and the one nobody scrolls to is the one that goes
 * stale - which is how /system came to draw the same finding amber in one place
 * and grey in another.
 */
export function attentionRows(segments: SegmentRow[], ports: PortRow[], unmapped: number): AttentionRow[] {
  const out: AttentionRow[] = [];

  for (const s of segments) {
    // ONLY A SEGMENT-LEVEL FAULT GETS A SEGMENT ROW. A drift belongs to the
    // member that drifted, and the member row names it precisely; emitting both
    // put "not running, so it holds no address" on screen twice, once under the
    // segment and once under the container, one line apart.
    if (s.issue && s.fault === "segment") {
      out.push({
        key: `seg-${s.id}`,
        subject: s.id,
        where: "segment",
        tone: s.tone,
        state: s.state,
        issue: s.issue,
      });
    }
    for (const m of s.members) {
      if (!m.issue) continue;
      out.push({
        key: `mem-${s.id}-${m.metric}`,
        subject: m.name,
        where: `on ${s.id}`,
        tone: m.declared ? "fail" : "warn",
        // The DRIFT, not the liveness: "unhealthy" is true about bazarr and
        // says nothing about the row, which is reporting an undeclared
        // attachment.
        state: m.drift ?? m.state,
        issue: m.issue,
      });
    }
  }

  for (const p of ports) {
    if (!p.issue) continue;
    out.push({
      key: `port-${p.key}`,
      subject: p.mapping,
      where: p.container,
      tone: p.tone,
      state: p.state,
      issue: p.issue,
    });
  }

  if (Number.isFinite(unmapped) && unmapped > 0) {
    out.push({
      key: "unmapped",
      subject: `${fmt.number(unmapped)} interface(s)`,
      where: "unmapped",
      tone: "warn",
      state: "dropped on the floor",
      issue:
        "these matched no podman subnet and are not a tunnel, so their traffic is absent " +
        "from every number on this page",
    });
  }

  return out.sort((a, b) => RANK[b.tone] - RANK[a.tone] || a.subject.localeCompare(b.subject));
}

export interface Tally {
  segments: number;
  declared: number;
  isolated: number;
  attachments: number;
  strays: number;
  missing: number;
  ports: number;
  fail: number;
  warn: number;
}

export function networkTally(segments: SegmentRow[], ports: PortRow[]): Tally {
  const declared = segments.filter((s) => s.kind === "declared");
  let attachments = 0;
  let strays = 0;
  let missing = 0;

  for (const s of segments) {
    for (const m of s.members) {
      if (m.attached) attachments += 1;
      if (m.attached && !m.declared) strays += 1;
      if (m.declared && !m.attached && s.kind === "declared") missing += 1;
    }
  }

  const bad = [...segments, ...ports];
  return {
    segments: segments.filter((s) => s.kind !== "tunnel").length,
    declared: declared.length,
    isolated: declared.filter((s) => s.isolate === "true").length,
    attachments,
    strays,
    missing,
    ports: ports.length,
    fail: bad.filter((r) => r.tone === "fail").length,
    warn: bad.filter((r) => r.tone === "warn").length,
  };
}

/**
 * The battery's checks that are about this page's subject.
 *
 * DECLARED HERE SO SOMETHING CAN CHECK IT, which is the same move machine.ts
 * makes with PRECONDITION_IDS and lanes.ts with HOST_IDS. CLAUDE.md's objection
 * to a hand-maintained watchlist - "a check that stops firing the moment a name
 * drifts" - is exactly right, and the answer is that fixtures/smoke.mjs asserts
 * every one of these against the ids bin/verify-host.sh actually emits, so a
 * rename fails the build instead of quietly emptying a panel.
 *
 * FIVE SECTIONS AND THIS PAGE OWNS NONE OF THEM. `net` is one check about the
 * LAN address; the segmentation is graded by the two runner_isolation checks,
 * the port surface by host.firewalld, and the collector's own view of both by
 * two metrics checks. Naming the sections instead would put eighteen unrelated
 * collector checks and the CDI spec on a page about bridges.
 */
export const FINDING_IDS = [
  "net.lan_address",
  "host.firewalld",
  "host.container_use_devices",
  "agents.runner_isolation",
  "ci.runner_isolation",
  "metrics.container_network",
  "metrics.node_netns_scope",
  // The ingress chain, added 2026-09-09. Same rule as the seven above: the ids
  // are named rather than the section, and `ingress` is a section this page
  // DOES own end to end - all five of its checks are about reaching this host
  // from outside, which is what the page is for.
  "ingress.cert_expiry",
  "ingress.renewal_due",
  "ingress.cert_coverage",
  "ingress.ddns_fresh",
  "ingress.public_dns",
];

export interface LeadReading {
  text: string;
  tone: Tone;
  live: boolean;
  sub: string;
}

/**
 * THE HEADLINE IS THE COUNT THAT NEEDS SOMETHING DOING. "10 bridges, all
 * isolate=true" was the old line and it was not a reading at all - it was a
 * constant, printed whether or not anything had been measured, on a page whose
 * whole subject is whether the segmentation still holds.
 */
export function networkLead(
  segments: SegmentRow[],
  ports: PortRow[],
  attention: AttentionRow[],
): LeadReading {
  const t = networkTally(segments, ports);

  if (t.declared === 0 || segments.every((s) => s.isolate === undefined)) {
    return {
      text: "the segmentation is not measured",
      tone: "off",
      live: false,
      sub: "prometheus returned no home_server_network_info - the drawing below is git's copy alone",
    };
  }

  // THE HEADLINE COUNTS THE LIST UNDERNEATH IT, and it did not: the tally
  // counts segment and port rows while the table also lists the member that
  // drifted, so the page read "5 things need attention" over seven of them.
  // Two derivations of one question, which is the defect this file's own
  // attentionRows() comment refuses.
  const bad = attention.length;
  if (bad === 0) {
    return {
      text: `${t.isolated} of ${t.declared} segments isolated`,
      tone: "ok",
      live: false,
      sub: `${t.attachments} attachments measured, ${t.ports} port(s) published, nothing undeclared`,
    };
  }

  const parts: string[] = [];
  if (t.isolated < t.declared) parts.push(`${t.declared - t.isolated} without isolate=true`);
  if (t.missing) parts.push(`${t.missing} declared attachment(s) absent`);
  if (t.strays) parts.push(`${t.strays} undeclared attachment(s)`);
  const portIssues = ports.filter((p) => p.issue).length;
  if (portIssues) parts.push(`${portIssues} port(s) disagreeing with stacks/`);

  const failing = attention.filter((a) => a.tone === "fail").length;
  return {
    text: bad === 1 ? "one thing needs attention" : `${bad} things need attention`,
    tone: failing ? "fail" : "warn",
    live: failing > 0,
    sub: parts.length ? parts.join(", ") : `${failing} failing, ${bad - failing} degraded`,
  };
}

export interface ConditionRow {
  id: string;
  label: string;
  value: string;
  sub: string;
  tone: Tone;
}

/**
 * The three questions the drawing is an answer to: are the bridges still
 * separate, is everything on the one it should be, and what is open to the host.
 */
export function conditionRows(segments: SegmentRow[], ports: PortRow[]): ConditionRow[] {
  const t = networkTally(segments, ports);
  const measured = segments.some((s) => s.isolate !== undefined);

  const undeclaredSegments = segments.filter((s) => s.kind === "ephemeral" || s.kind === "other").length;
  const lan = ports.filter((p) => p.live && !p.loopback).length;
  const loopback = ports.filter((p) => p.live && p.loopback).length;

  return [
    {
      id: "segments",
      label: "Segments",
      value: measured ? `${t.isolated} of ${t.declared} isolated` : fmt.NO_DATA,
      sub: !measured
        ? "no network info reported"
        : undeclaredSegments
          ? `${undeclaredSegments} more on the host, driver-owned`
          : "every bridge blocks the others",
      tone: !measured ? "off" : t.isolated < t.declared ? "fail" : "ok",
    },
    {
      id: "attachments",
      label: "Attachments",
      value: t.attachments === 0 ? fmt.NO_DATA : `${t.attachments} measured`,
      // Absent and stray are named separately and never added: they are
      // opposite faults and a single "3 wrong" would hide which.
      sub:
        t.attachments === 0
          ? "podman reported no membership at all"
          : t.missing || t.strays
            ? `${t.missing} declared and absent, ${t.strays} undeclared`
            : "every one matches stacks/",
      tone: t.attachments === 0 ? "off" : t.missing ? "fail" : t.strays ? "warn" : "ok",
    },
    {
      id: "ports",
      label: "Published ports",
      value: t.ports === 0 ? fmt.NO_DATA : `${t.ports} in the stack`,
      sub:
        t.ports === 0
          ? "no publish reported"
          : `${lan} facing the LAN, ${loopback} on loopback`,
      tone: t.ports === 0 ? "off" : ports.some((p) => p.tone === "fail") ? "fail" : ports.some((p) => p.tone === "warn") ? "warn" : "ok",
    },
  ];
}

/**
 * The worst tone on a segment, members included, for the drawing's group box.
 *
 * The table can show a segment's own state next to its members'; a group box on
 * the graph has one edge and one colour, so it has to carry both.
 */
export function segmentTone(s: SegmentRow): Tone {
  return s.members.reduce((t, m) => worst(t, m.tone), s.tone);
}

// -----------------------------------------------------------------------------
// The drawing's model
// -----------------------------------------------------------------------------

/**
 * What the graph draws, derived from the rows rather than from topology.ts.
 *
 * THE OLD layout() IMPORTED NODES DIRECTLY, so the drawing could only ever be
 * git's copy: a container podman had put on a segment nobody declared had
 * nowhere to appear, and a segment that had gone kept its rail. Going through
 * the rows means the picture is the declared topology UNIONED with what the
 * host reports - which is the only way the difference between them can be seen
 * rather than described.
 *
 * SINGLE-HOMED GOES INSIDE, MULTI-HOMED GOES ON THE SPINE. graph.ts states the
 * case at length; the split is made here because "how many segments is this on"
 * is a fact about the data and not about the arithmetic.
 */
export function graphModel(segments: SegmentRow[]): GraphModel {
  const groups: GraphGroup[] = [];
  const spineBy = new Map<string, GraphSpine>();

  for (const s of segments) {
    if (s.kind === "tunnel") continue;
    groups.push({
      id: s.id,
      purpose: s.purpose,
      subnet: s.subnet,
      members: s.members
        .filter((m) => !m.multi)
        .map((m) => ({
          name: m.name,
          role: m.role,
          networks: m.networks,
          pod: m.pod.map((p) => p.name),
        })),
    });

    for (const m of s.members) {
      if (!m.multi || spineBy.has(m.name)) continue;
      spineBy.set(m.name, {
        name: m.name,
        role: m.role,
        kind: "service",
        networks: m.networks,
        pod: m.pod.map((p) => p.name),
        links: [],
      });
    }
  }

  const ids = new Set(groups.map((g) => g.id));

  // THE TUNNEL GETS A BOX, WHICH IT HAS NEVER HAD. It is a network label the
  // collector emits and not a member of NETWORKS, so the rail-per-segment
  // drawing had nowhere to put the biggest number on the host - it lived in a
  // hard-coded one-row side panel instead.
  const tunnelRow = segments.find((s) => s.kind === "tunnel");
  if (tunnelRow) {
    const pod = tunnelRow.members[0];
    spineBy.set(TUNNEL, {
      name: TUNNEL,
      role: "the pod's only way out",
      kind: "tunnel",
      networks: pod && ids.has(pod.networks[0] ?? "") ? [pod.networks[0] as string] : [],
      pod: [],
      links: [],
    });
  }

  // THE TWO TERMINALS, WHICH THE OLD DRAWING DROPPED ON THE FLOOR. Its route
  // layer looked both endpoints up in the box list and returned null when
  // either was a pseudo-node, so `wan -> caddy` - the most important edge on
  // the page - could not be drawn at all. They stay two rather than one for the
  // reason paths.ts gives: with a single shared node a walk splices
  // `duckdns -> wan -> caddy -> sonarr` out of two routes that do not join.
  if (spineBy.has("caddy")) {
    spineBy.set("wan", {
      name: "wan",
      role: PSEUDO_NODES.wan ?? "",
      kind: "terminal",
      networks: [],
      pod: [],
      links: ["caddy"],
    });
  }

  const outbound = new Set<string>();
  for (const p of PATHS) {
    if (p.to !== "internet" || isPseudo(p.from)) continue;
    for (const net of NODES.find((n) => n.name === p.from)?.networks ?? []) {
      if (ids.has(net)) outbound.add(net);
    }
  }
  if (outbound.size) {
    spineBy.set("internet", {
      name: "internet",
      role: PSEUDO_NODES.internet ?? "",
      kind: "terminal",
      networks: [...outbound],
      pod: [],
      links: [],
    });
  }

  // Busiest first, terminals and the tunnel last: the spine reads as "these are
  // the things that are not inside one segment", worst offender leading.
  const rank = (s: GraphSpine): number => (s.kind === "service" ? 0 : 1);
  const spine = [...spineBy.values()].sort(
    (a, b) => rank(a) - rank(b) || b.networks.length - a.networks.length || a.name.localeCompare(b.name),
  );

  return { groups, spine };
}

// =============================================================================
// The ingress chain
// -----------------------------------------------------------------------------
// FIFTEEN CERTIFICATES THAT EXPIRE TOGETHER, which is the whole reason this is
// a band rather than a number. They were issued in one afternoon at the
// migration, so ten of them share an expiry date: the failure is not one
// hostname degrading, it is every public name going dark within hours of each
// other, and a single "soonest: 61 days" hides that they are all 61 days.
//
// THE TONE COMES FROM CADDY'S PLAN, NOT FROM THE CLOCK. `overdue` is the
// collector's answer to "is Caddy past the renewal time it chose for this
// certificate, with the old one still on disk" - true about thirty days before
// the expiry matters, and the only signal here that names the fault rather than
// its consequence. A row is amber because the renewal is late, not because the
// date is near; the date only takes over once the metadata is unreadable, which
// is what `days` is for.
//
// ABSENCE IS NOT HEALTH, IN EITHER DIRECTION. A certificate with no expiry
// series is grey and says so, rather than borrowing the colour of a measured
// one - the rule checkTone() states and /system got wrong in three functions at
// once. And an unreadable STORE is a different finding from an empty one, which
// is why the caller passes `storeReadable` rather than inferring it from a row
// count of zero.
// =============================================================================

export interface CertRow {
  key: string;
  host: string;
  /** Whole days until expiry, or null when nothing measured it. */
  days: number | null;
  /** Caddy is past the renewal time it chose and the certificate has not moved. */
  overdue: boolean;
  /** Whether Caddy has published a renewal time for this one at all. */
  planned: boolean;
  tone: Tone;
  state: string;
}

/** The thresholds are bin/verify-host.sh's own, so the band and the check that
 *  alerts on it cannot disagree about what "soon" means. 30 is Caddy's renewal
 *  point and 21 is nine days past it. */
export const CERT_RENEW_DAYS = 30;
export const CERT_LATE_DAYS = 21;

const DAY = 86_400;

export function certRows(
  expiry: Map<string, number>,
  renewal: Map<string, number>,
  overdue: Map<string, number>,
  nowMs: number = Date.now(),
): CertRow[] {
  const now = nowMs / 1000;
  return [...expiry.keys()]
    .sort()
    .map((host) => {
      const at = expiry.get(host);
      const days = at === undefined ? null : Math.floor((at - now) / DAY);
      const late = overdue.get(host) === 1;
      const planned = renewal.get(host) !== undefined;

      let tone: Tone = "ok";
      let state = days === null ? "not measured" : `${days}d left`;
      if (days === null) {
        tone = "off";
      } else if (days < 0) {
        tone = "fail";
        state = "expired";
      } else if (late) {
        // THE RENEWAL IS THE FINDING AND THE DATE IS THE CONSEQUENCE, so this
        // outranks the day count: a certificate 40 days out whose renewal has
        // already been missed is the case worth acting on, and grading it on
        // its comfortable date would say nothing until three weeks later.
        tone = "warn";
        state = `renewal overdue, ${days}d left`;
      } else if (days <= CERT_LATE_DAYS) {
        tone = "warn";
      } else if (days <= CERT_RENEW_DAYS) {
        // Inside Caddy's own window is where a healthy certificate spends a few
        // days a quarter, so it is a remark rather than a fault - grey, for the
        // same reason a `note` is.
        tone = "off";
        state = `${days}d left, renewing`;
      }
      return { key: host, host, days, overdue: late, planned, tone, state };
    });
}

export interface IngressReading {
  text: string;
  tone: Tone;
  live: boolean;
  sub: string;
}

/**
 * THE HEADLINE IS THE COUNT THAT NEEDS SOMETHING DOING, which is the rule
 * networkLead() already states one band up - and the reason it cannot simply be
 * "15 certificates" is that a constant printed whether or not anything was
 * measured is what this page had before 2026-09-08.
 */
export function ingressLead(
  rows: CertRow[],
  storeReadable: boolean | undefined,
  ddnsAgeSeconds: number | null,
): IngressReading {
  if (storeReadable === undefined) {
    return {
      text: "the certificates are not measured",
      tone: "off",
      live: false,
      sub: "prometheus returned no home_server_ingress_store_readable - the collector's ingress source has not reported",
    };
  }
  if (!storeReadable) {
    return {
      text: "no certificate store",
      tone: "fail",
      live: true,
      sub: "Caddy's data volume is not a directory the collector can walk, so nothing here is known",
    };
  }

  const expired = rows.filter((r) => r.tone === "fail").length;
  const late = rows.filter((r) => r.overdue).length;
  const soon = rows.filter((r) => r.tone === "warn" && !r.overdue).length;
  // The DuckDNS half is one number and belongs in the sub-line: it is the same
  // chain, and a second headline would make the band answer two questions.
  const ddns =
    ddnsAgeSeconds === null
      ? "the DuckDNS updater is not measured"
      : `DuckDNS updated ${Math.floor(ddnsAgeSeconds / 60)}m ago`;

  if (expired) {
    return { text: `${expired} expired`, tone: "fail", live: true, sub: ddns };
  }
  if (late) {
    return {
      text: `${late} renewal${late === 1 ? "" : "s"} overdue`,
      tone: "warn",
      live: true,
      sub: `Caddy is past the time it chose and the certificate has not moved - ${ddns}`,
    };
  }
  if (soon) {
    return {
      text: `${soon} inside three weeks`,
      tone: "warn",
      live: true,
      sub: ddns,
    };
  }
  if (!rows.length) {
    // THE DUCKDNS READING SURVIVES AN EMPTY STORE. This sub-line is the only
    // place on the page that number appears, so letting the certificate branch
    // own the whole sentence would make a readable-but-empty store hide a
    // wedged updater - two independent halves of one chain, and the quieter
    // one silently dropped.
    return {
      text: "no certificates issued",
      tone: "off",
      live: false,
      sub: `the store is readable and empty - ingress.cert_coverage is what says whether that is wrong; ${ddns}`,
    };
  }
  const soonest = rows.reduce(
    (acc, r) => (r.days !== null && (acc === null || r.days < acc) ? r.days : acc),
    null as number | null,
  );
  return {
    text: `${rows.length} certificates, soonest ${soonest ?? "?"}d`,
    tone: "ok",
    live: true,
    sub: ddns,
  };
}
