// Drives the media page logic in node against the dev fixtures, because this
// environment has no browser. Not a test suite - there is none in this repo -
// but it exercises the real modules rather than asserting on types.
//
//   node fixtures/smoke.mjs
import { createServer } from "vite";

const server = await createServer({ server: { middlewareMode: true }, appType: "custom" });
const load = (p) => server.ssrLoadModule(p);

const { activityDocument, libraryDocument } = await load("/fixtures/media.ts");
const { sortRows, actionFor, badgeFor, whoLine, stateClass, STATE_LABEL, STATE_TONE } =
  await load("/src/media.ts");
const { posterHeight, posterUrl } = await load("/src/images.ts");
const { containerTone, laneTone, quotaTone, heartbeatTone } = await load("/src/health.ts");
const { dailyPeaks, utcDayStarts } = await load("/src/uptime.ts");
const { fleetDocument, fleetUnreadable } = await load("/fixtures/fleet.ts");
const fmt = await load("/src/format.ts");

let failures = 0;
const check = (name, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (!ok) failures += 1;
  console.log(`${ok ? "ok  " : "FAIL"}  ${name}${ok ? "" : `\n        got  ${JSON.stringify(got)}\n        want ${JSON.stringify(want)}`}`);
};

const activity = activityDocument();
const library = libraryDocument();

// --- the merged, sorted row set, the way the store builds it -----------------
const merged = new Map();
for (const r of library.done) merged.set(r.id, r);
for (const r of library.attention) merged.set(r.id, r);
for (const r of activity.transfers) merged.set(r.id, r);
const rows = [...merged.values()].sort(sortRows);

console.log(`\n-- ${rows.length} rows, attention first --`);
for (const r of rows.slice(0, 8)) {
  const a = actionFor(r);
  console.log(
    `   ${STATE_LABEL[r.state].padEnd(13)} ${String(STATE_TONE[r.state]).padEnd(5)}` +
      ` ${stateClass(r.state).padEnd(9)} ${(a.label + (a.href ? "" : " (disabled)")).padEnd(20)} ${r.title.slice(0, 34)}`,
  );
}

check("first row is the most severe", rows[0].state, "error");
check("no completion above an error", rows.findIndex((r) => r.state === "done") > 0, true);
check("every state has a label", rows.every((r) => !!STATE_LABEL[r.state]), true);
check("every state has a tone", rows.every((r) => !!STATE_TONE[r.state]), true);
check("only live states animate", stateClass("stalled"), "attention");
check("done does not animate", stateClass("done"), "steady");

// --- null progress must not become 0 ----------------------------------------
const queued = rows.find((r) => r.state === "queued");
check("queued row keeps null progress", queued.progress, null);

// --- posters ----------------------------------------------------------------
check("22x32 thumb snaps to 80", posterHeight(32), 80);
check("76x110 card snaps to 240", posterHeight(110), 240);
check("150-wide grid cell snaps to 480", posterHeight(225), 480);
check(
  "tagged url is cacheable",
  posterUrl("Items/abc/Images/Primary", "t1", 240),
  "/api/images/Items/abc/Images/Primary?tag=t1&maxHeight=240",
);
check(
  "untagged url omits the tag",
  posterUrl("Items/abc/Images/Primary", null, 80),
  "/api/images/Items/abc/Images/Primary?maxHeight=80",
);

// --- sessions ---------------------------------------------------------------
console.log("\n-- sessions --");
for (const s of activity.sessions) {
  const b = badgeFor(s);
  console.log(`   ${b.label.padEnd(14)} ${b.tone.padEnd(5)} ${s.paused ? "paused " : "playing"}  ${whoLine(s)}`);
}
check("direct play badge", badgeFor(activity.sessions[0]).label, "DIRECT");
check("hw transcode badge", badgeFor(activity.sessions[1]).label, "HW TRANSCODE");
check("unmeasured hardware is not called software", badgeFor({ method: "transcode", hardware: null }).label, "TRANSCODE");
check("unmeasured hardware never reads healthy", badgeFor({ method: "transcode", hardware: null }).tone, "warn");
check("who line carries no local/remote token", /local|remote/i.test(whoLine(activity.sessions[0])), false);

// --- health: absent is not zero --------------------------------------------
check("no health check is grey", containerTone(true, undefined), { tone: "off", state: "running, unchecked" });
check("healthy is teal", containerTone(true, 0), { tone: "ok", state: "healthy" });
check("stopped is red", containerTone(false, undefined), { tone: "fail", state: "stopped" });

// --- format -----------------------------------------------------------------
check("elapsed keeps every field past an hour", fmt.elapsed(3661), "01:01:01");
check("elapsed of NaN is the dash", fmt.elapsed(Number.NaN), fmt.NO_DATA);
check("percent of 0 is not the dash", fmt.percent(0, 0), "0%");

// --- the contract that must never be optional -------------------------------
check("activity names every upstream", Object.keys(activity.sources).sort(), [
  "jellyfin",
  "qbittorrent",
  "radarr",
  "sonarr",
  "tdarr",
]);
check("library names every upstream", Object.keys(library.sources).length, 6);
check(
  "a pending request has no poster",
  library.requests.find((r) => r.status === "pending").poster,
  null,
);


// --- the network graph -------------------------------------------------------
// The topology and the edge list are compiled-in git data, so every claim below
// is checkable without a browser - which is the whole reason graph.ts holds no
// Vue and no DOM.
const T = await load("/src/topology.ts");
const NODE_NAMES = new Set(T.NODES.map((n) => n.name));
const P = await load("/src/paths.ts");
const G = await load("/src/graph.ts");

console.log(`\n-- ${P.PATHS.length} declared routes --`);

const impossible = P.PATHS.filter(
  (p) => P.edgeKind(p) === "segment" && P.segmentsFor(p).length === 0,
);
check("every declared route crosses a shared segment", impossible.map((p) => `${p.from}->${p.to}`), []);

const orphan = P.PATHS.filter(
  (p) => ![p.from, p.to].every((n) => P.isPseudo(n) || NODE_NAMES.has(n)),
);
check("every endpoint is a container or a terminal", orphan.map((p) => `${p.from}->${p.to}`), []);

// A terminal absorbs, so no chain may pass THROUGH one. Without this, the
// inbound and outbound ends of the world join up and the walk reports
// "duckdns -> wan -> caddy -> sonarr", which is two real routes spliced at a
// place no packet crosses.
const through = [];
for (const name of ["sonarr", "caddy", "prowlarr", "jellyfin"]) {
  for (const chain of P.tracePaths(name)) {
    for (let i = 1; i < chain.length - 1; i += 1) {
      if (P.isPseudo(chain[i])) through.push(chain.join(" -> "));
    }
  }
}
check("no route passes through a terminal", through, []);

const L = G.layout();
check("every box has a finite position", L.nodes.every((n) => Number.isFinite(n.x) && Number.isFinite(n.y)), true);
check("the hub spans more than one rail", (L.hub?.rails.length ?? 0) > 1, true);
check("no two boxes overlap", (() => {
  const ext = L.nodes.map((n) => ({ ...n, bot: n.y + n.h + (n.members.length ? n.members.length * 12 + 10 : 0) }));
  for (let i = 0; i < ext.length; i++)
    for (let j = i + 1; j < ext.length; j++) {
      const a = ext[i], b = ext[j];
      if (a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.bot && b.y < a.bot) return `${a.name}/${b.name}`;
    }
  return null;
})(), null);

// Rate to motion. Zero must be still: a link carrying a keepalive is idle, and
// animating it spends the reader's attention on nothing.
check("below the floor is still", G.intensity(512), 0);
check("absent is still", G.intensity(Number.NaN), 0);
check("the scale is logarithmic", G.intensity(1024 ** 2) > 0.5 && G.intensity(1024 ** 2) < 0.7, true);
check("the ceiling clamps", G.intensity(1024 ** 4), 1);
check("busier is faster", G.flowDuration(10e6) < G.flowDuration(10e3), true);


// --- the two fleets ----------------------------------------------------------
//
// EVERY ASSERTION HERE IS ABOUT ABSENCE, because that is what both pages exist
// to render and what no screenshot can prove. A lane with no marker, a phase
// that has never run and a quota nobody has read all have to come out GREY, and
// the failure mode if they do not is silent: a green row for a fleet nothing is
// reporting on.

console.log("\n-- absence, on both fleet pages --");

// A lane whose heartbeat and in-flight series are both absent has never started.
check("a lane with no marker is grey", laneTone(Number.NaN, undefined, Number.NaN).tone, "off");
check("...and says so", laneTone(Number.NaN, undefined, Number.NaN).state, "never started");

// THE ONE THAT MATTERS. inFlight === undefined must outrank a fresh heartbeat:
// `?? 0` at a call site would produce a healthy idle lane out of no evidence.
check("absent in-flight beats a fresh heartbeat", laneTone(12, undefined, 0).tone, "off");
check("in-flight 0 really is idle", laneTone(12, 0, 0).state, "idle");
check("in-flight 1 is running", laneTone(12, 1, 0).state, "running a job");
check("a stale heartbeat fails", laneTone(400, 0, 0).tone, "fail");
check("a stale heartbeat outranks mint failures", laneTone(400, 0, 3).state, "heartbeat stale");
check("mint failures are amber", laneTone(12, 0, 3).tone, "warn");

// The quota is a status, and unknown ranks worst - except absent, which is grey.
check("an unread quota is grey", quotaTone(undefined).tone, "off");
check("allowed is green", quotaTone(0).tone, "ok");
check("the warning is amber", quotaTone(1).tone, "warn");
check("rejected is red", quotaTone(2).tone, "fail");
check("an unrecognised status is not green", quotaTone(7).tone, "fail");

check("a heartbeat nobody wrote is grey", heartbeatTone(Number.NaN, 600).tone, "off");
check("a stale heartbeat is amber", heartbeatTone(900, 600).tone, "warn");

// --- the UTC daily strip -----------------------------------------------------
//
// The trap this exists for: these are gauges conduct resets at UTC midnight, and
// bucketing them into LOCAL days would take each bar's maximum from the tail of
// the previous UTC day. Anchor on a known instant rather than "now" so the
// assertion does not depend on the machine's zone or on the hour it runs at.
const DAY = 86400;
const anchor = 1787_000_000 - (1787_000_000 % DAY) + 3600; // 01:00 UTC, some day

console.log("\n-- the daily strip buckets on UTC --");
const starts = utcDayStarts(3, anchor);
check("day starts are UTC midnights", starts.map((t) => t % DAY), [0, 0, 0]);
check("the last bar is today", starts[2], anchor - 3600);

// A resetting counter: 8 late yesterday, then 1 early today. The max reducer
// must report 8 for yesterday and 1 for today - never 8 for today.
const peaks = dailyPeaks(
  [
    [anchor - DAY - 7200, 5],
    [anchor - DAY - 3600, 8],
    [anchor - 1800, 1],
  ],
  3,
  anchor,
);
check("yesterday keeps its own peak", peaks[1], 8);
check("today does not inherit it", peaks[2], 1);
check("a day with no sample is NaN, not zero", Number.isNaN(peaks[0]), true);

// --- the fleet document ------------------------------------------------------
console.log("\n-- the fleet document --");
const fleet = fleetDocument();

check("the document names its upstream", Object.keys(fleet.sources), ["conduct_db"]);

// waiting_on null is IN FLIGHT, not "conduct". Rendering it as conduct's would
// claim the fleet owns a step nobody has looked at.
const byWaiting = fleet.rounds.map((r) => r.waiting_on);
check("all three waiting states are present", byWaiting, ["person", "conduct", null]);

// NO RESUME URL, EVER. A link carrying one would make a reader of this page able
// to approve an agent's merge, which is the outcome the whole design prevents.
const links = [
  ...fleet.rounds.map((r) => r.link),
  ...fleet.notices.map((n) => n.link),
].filter(Boolean);
check("no link is a resume URL", links.some((l) => l.includes("/resume/")), false);
check("the approval links survive", links.length > 0, true);

// An orphan notice: asked, unanswered, and matching no open round. The board has
// to keep showing it or an approval silently disappears.
const jobs = new Set(fleet.rounds.filter((r) => r.waiting_on === "person").map((r) => r.flow_job_id));
const orphans = fleet.notices.filter((n) => n.waiting_on === "person" && !jobs.has(n.flow_job_id));
check("the fixture has an orphan notice", orphans.length, 1);

// A run still going: result null, no ended_at. conduct counts a failure as
// `result IS NOT NULL AND result != 'ok'`, and the collector's first SQL had it
// backwards - drawing every running phase as a failed one.
const running = fleet.runs.filter((r) => r.result === null);
check("the fixture has a run in flight", running.length, 1);
check("an in-flight run is not a failure", fleet.totals.runs_failed_today < fleet.totals.runs_today, true);

// A LOCKED DATABASE IS NOT AN IDLE FLEET, and both produce the same empty list.
const broken = fleetUnreadable();
check("the unreadable document has no rounds", broken.rounds.length, 0);
check("...and says why", broken.sources.conduct_db.ok, false);
check("...with a reason", typeof broken.sources.conduct_db.error, "string");


await server.close();
console.log(`\n${failures === 0 ? "all checks passed" : `${failures} FAILED`}`);

process.exit(failures === 0 ? 0 : 1);
