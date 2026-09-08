// Drives the media page logic in node against the dev fixtures, because this
// environment has no browser. Not a test suite - there is none in this repo -
// but it exercises the real modules rather than asserting on types.
//
//   node fixtures/smoke.mjs
import { readFile } from "node:fs/promises";

import { createServer } from "vite";

const server = await createServer({ server: { middlewareMode: true }, appType: "custom" });
const load = (p) => server.ssrLoadModule(p);

const { activityDocument, libraryDocument } = await load("/fixtures/media.ts");
const { sortRows, actionFor, badgeFor, whoLine, stateClass, STATE_LABEL, STATE_TONE } =
  await load("/src/media.ts");
const { posterHeight, posterUrl } = await load("/src/images.ts");
const { containerTone, laneTone, quotaTone, heartbeatTone } = await load("/src/health.ts");
const { seriesStyle, bandOpacity, ceilingTick, yTicks, symmetricExtent } = await load("/src/charts.ts");
const { fleetDocument, fleetUnreadable } = await load("/fixtures/fleet.ts");
const {
  roundState,
  roundAction,
  roundBranch,
  roundError,
  roundSteps,
  MERGE_STEP,
  PHASE_SEQUENCE,
  roundEtaAt,
  isSettled,
  byUrgency,
  roundOutcome,
} = await load("/src/fleet.ts");
// LOADED FOR THE FIRST TIME ON 2026-08-31. `boardRow` is where the approve
// button's gate lives, and it had never been exercised here - so `waiting`
// carrying a `closed_at` clause it should not have was invisible to every test
// this application has.
const { boardRow, phaseLabel } = await load("/src/roundboard.ts");
const {
  askAge,
  holdExpiresIn,
  intakeState,
  intakeSwitch,
  quotaHold,
  roundControls,
  lastStartedAgo,
  offerStands,
  ASK_CEILING_S,
  HOLD_TIMEOUT_S,
} = await load("/src/control.ts");
// LOADED FOR THE FIRST TIME ON 2026-09-07. Three renderers that turn what the
// host recorded into something a person can read - the card, the phase's own
// verdict and its conversation - and all three are pure modules rather than
// logic in a .vue precisely so this file can reach them.
const { parseMarkdown, parseInline, safeHref } = await load("/src/markdown.ts");
const { parseVerdict } = await load("/src/verdict.ts");
const { describeTurn, shortDiff, DIFF_LINES } = await load("/src/transcript.ts");
const fmt = await load("/src/format.ts");
// LOADED FOR THE FIRST TIME ON 2026-08-31, for the reason boardRow was: the
// quota sub-line is a pure function living in a composable, and nothing had
// ever called it outside a browser.
const { quotaSub, quotaWindow } = await load("/src/composables/useQuotaHold.ts");
const { control } = await load("/src/api/control.ts");
// LOADED FOR THE FIRST TIME ON 2026-09-07. The fleet page's two decisions - what
// its headline says and what its ten precondition rows read - were logic in a
// .vue file until the redesign, so neither had ever been called outside a
// browser. See the block near the foot of this file for the one that was wrong.
const { leadReading, preconditionRows, preconditionTally, PRECONDITION_IDS } =
  await load("/src/machine.ts");
// LOADED FOR THE FIRST TIME ON 2026-09-07, in the same pass and for the same
// reason. /ci had NO logic under test at all: every decision on the only page
// this fleet is visible from was a computed in a .vue file, and one of them had
// been wrong for as long as the page existed.
const { laneLead, laneTally, silentLanes, hostRows, hostTally, HOST_IDS } =
  await load("/src/lanes.ts");
// LOADED FOR THE FIRST TIME ON 2026-09-07, and /system was the last page with no
// logic under test at all - seventeen computeds and eight functions in the SFC,
// on the largest page in the application. FOUR of them were wrong. See the block
// at the foot of this file, and the banner in src/system.ts.
const sys = await load("/src/system.ts");
const { statusDocument } = await load("/fixtures/model.ts");

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

// fmt.compact, which the fleet page's tokens lane, its reading, its peak and
// the tokens condition in its header all render through. fmt.number(289113220)
// is 289113220, which is nine digits nobody reads and what that condition
// printed until 2026-09-07.
//
// BASE 1000, NOT 1024, and this is the assertion that says so: a thousand is a
// clean "1.0k" and would be "1000" under fmt.bytes' divisor. The two live four
// lines apart in format.ts and draw on the same page.
check("compact is base 1000", fmt.compact(1000), "1.0k");
check("compact keeps one decimal under a hundred", fmt.compact(41_231_004), "41.2M");
check("compact drops it at three digits", fmt.compact(289_113_220), "289M");
check("compact leaves a bare count alone", fmt.compact(940), "940");
check("compact of zero is zero, not the dash", fmt.compact(0), "0");
// The rule the whole of format.ts exists to keep: absence is a dash, never 0.
check("compact of NaN is the dash", fmt.compact(Number.NaN), fmt.NO_DATA);
check("compact carries a sign", fmt.compact(-2_600_000), "-2.6M");

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

// A WINDOW THAT HAS ROLLED OVER IS NOT A HOLD, AND THIS IS THE THIRD READER OF
// THAT RULE RATHER THAN THE FIRST. bin/verify-host.sh's agents.quota_headroom
// clears on `now >= resets_at` and says "the fleet is dispatching again";
// AgentQuotaRejected only fires while
// home_server_agent_quota_resets_timestamp_seconds > time(), so it never pages
// about a window that came back. This reader had no such clause, so a status the
// API set at 13:38Z on 2026-08-30 drew amber here for the whole of the following
// day - against a marker whose OWN resets_at said 14:00Z, and a fleet that was
// dispatching. The status is a reading of one model call and the window it
// described either has rolled over or has not; nothing here is a staleness rule.
check("a rolled-over warning is green", quotaTone(1, 1000, 2000).tone, "ok");
check("...and says the window cleared", quotaTone(1, 1000, 2000).state, "cleared");
// A REJECTION CLEARS TOO, which is the arm that looks wrong and is not: the
// refusal was the API's answer to one call inside a window that has since ended,
// and both of the other two readers grade it exactly this way.
check("a rolled-over rejection clears too", quotaTone(2, 1000, 2000).tone, "ok");
check("the boundary counts as cleared", quotaTone(1, 2000, 2000).state, "cleared");
// THE NEGATIVE CONTROLS, which are what make the four above mean anything. The
// last two are the honest default: with no reset stamp to compare against, a
// reading cannot be talked out of by this function.
check("a live window still holds", quotaTone(1, 3000, 2000).tone, "warn");
check("a live rejection still fails", quotaTone(2, 3000, 2000).tone, "fail");
check("no reset stamp claims nothing", quotaTone(1, undefined, 2000).tone, "warn");
check("an unreadable reset claims nothing", quotaTone(1, Number.NaN, 2000).tone, "warn");
check("allowed is allowed, cleared or not", quotaTone(0, 1000, 2000).state, "allowed");

// --- the quota hold, which is a THRESHOLD and not a switch -------------------
//
// THE CHIP'S LABEL AND THE COMMAND IT SENDS COME OFF ONE BRANCH, which is what
// this asserts: a chip reading `spend` that sends `quota_pace` is the same class
// of defect as one reading `arm` that disarms, with the added cost that nobody
// would notice for two days.
//
// A PAST STAMP IS NOT AN OVERRIDE. `quota_pace` sets the value to the moment it
// happened rather than deleting the row, so the board can still say when the
// pacing came back - which means "is one live" is a comparison and never a
// presence test. Getting that backwards would draw a fleet as spending its
// headroom for ever after one override had ended.
console.log("\n-- the quota hold --");
const NOW = 1787_000_000;
const held = (value) => ({
  available: true, approve_available: true, restart_floor_sec: 600,
  intake: [], holds: [],
  quota: value === null ? null : { subject: "account", value, at: "x", note: null },
});
const stamp = (delta) =>
  new Date((NOW + delta) * 1000).toISOString().replace(/\.\d{3}Z$/, "Z");

check("nobody has lifted it", quotaHold(held(null), NOW).spending, false);
check("and the chip offers to", quotaHold(held(null), NOW).action, "quota_spend");
check("a future stamp is live", quotaHold(held(stamp(3600)), NOW).spending, true);
check("and the chip offers the other way",
      quotaHold(held(stamp(3600)), NOW).action, "quota_pace");
check("a stamp that has passed is not an override",
      quotaHold(held(stamp(-60)), NOW).spending, false);
check("nor is a value nothing can parse",
      quotaHold(held("whenever"), NOW).spending, false);
// The label and the action are one branch, so they can never disagree.
for (const value of [null, stamp(3600), stamp(-60)]) {
  const hold = quotaHold(held(value), NOW);
  check(`label and action agree for ${value ?? "no row"}`,
        hold.action, hold.label === "pace" ? "quota_pace" : "quota_spend");
}

// THE SENTENCE UNDER THE PILL HAD THE SAME HOLE AND A WORSE WORDING. With no
// override live, quotaSub falls through to the window line - and the page passed
// null for a window that had rolled over, so the fleet's most recent reading was
// captioned "no window recorded" about a window whose reset time is in the
// marker, in the store and in the tooltip beside it.
check("a rolled-over window is not an absent one",
      quotaSub(quotaHold(held(null), NOW), "rolled over 4h ago", false, null, false),
      "rolled over 4h ago");
check("a window nothing recorded still says so",
      quotaSub(quotaHold(held(null), NOW), null, false, null, false),
      "no window recorded");

// AND THE LINE ITSELF, WHICH THE PAGE USED TO BUILD INLINE. The null branch is
// the one that mattered: it was every window that had already come back.
check("a live window counts down", quotaWindow(NOW + 7200, NOW), "clears in 2h");
check("a window that ended says when",
      quotaWindow(NOW - 7200, NOW), "rolled over 2h ago");
check("the boundary has rolled over", quotaWindow(NOW, NOW), "rolled over 0s ago");
check("no reset stamp is still null", quotaWindow(undefined, NOW), null);
check("an unreadable stamp is null", quotaWindow(Number.NaN, NOW), null);

check("a heartbeat nobody wrote is grey", heartbeatTone(Number.NaN, 600).tone, "off");
check("a stale heartbeat is amber", heartbeatTone(900, 600).tone, "warn");

// --- the fleet document ------------------------------------------------------
console.log("\n-- the fleet document --");
const fleet = fleetDocument();

// conduct_db IS MANDATORY and github is not: the GitHub leg is absent entirely
// on a run where no round had a pull request to ask about, which is different
// from a run where the token failed. Asserting the exact key set would have
// made that legitimate absence a test failure.
check("the document names its database", "conduct_db" in fleet.sources, true);
check("...and every source says whether it answered",
  Object.values(fleet.sources).every((h) => typeof h.ok === "boolean"), true);

// waiting_on null is IN FLIGHT, not "conduct". Rendering it as conduct's would
// claim the fleet owns a step nobody has looked at.
//
// OVER THE OPEN ROUNDS ONLY, since the board grew a history: a closed round has
// nobody waiting on it by definition, so including them would let the three
// live states disappear one by one without this noticing.
const byWaiting = new Set(
  fleet.rounds.filter((r) => r.closed_at === null).map((r) => r.waiting_on),
);
check("all three waiting states are present",
  ["person", "conduct", null].map((w) => byWaiting.has(w)), [true, true, true]);

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

// --- the run board -----------------------------------------------------------
//
// THE OUTCOME IS DERIVED FROM THE PUBLICATION JOIN AND NEVER FROM closed_why.
// conduct closes a round with a sentence, and every one of these rows carries
// one - so an assertion that passed by reading them would look identical to
// this and be wrong the first time somebody reworded a message.
console.log("\n-- what a round's state is derived from --");

// A WORKTREE ID IS NOT A ROUND ID - it names the LANE, and the fixture now
// carries two rounds on `wt-lane01` because the live host has ten on one. The
// task id is the second half of a round's identity, which is the same pair
// conduct is sent and the same one chain_open compares.
const by = (id, task) =>
  fleet.rounds.find(
    (r) => r.worktree_id === id && (task === undefined || r.odoo_task === task),
  );

check("a person owing an answer outranks everything",
  roundState(by("wt-9f21c4")), { tone: "warn", state: "waiting on you" });
check("waiting_on null is running, not conduct's",
  roundState(by("wt-77d3e0")), { tone: "off", state: "running" });
check("an open pull request is in review",
  roundState(by("wt-2c44b1")), { tone: "ok", state: "in review" });
check("a merged one says so",
  roundState(by("wt-3311cd")), { tone: "ok", state: "merged" });

// THE TWO CLOSED OUTCOMES THAT LOOK ALIKE. Both closed, both carry a sentence,
// and only the publication join separates "the flow declined to open one" from
// "it never reached the publish path".
check("published but opened nothing is not a failure",
  roundState(by("wt-55ee02")), { tone: "warn", state: "not published" });
check("no publication row at all is",
  roundState(by("wt-88fa10")), { tone: "fail", state: "stopped" });

// THE THIRD OUTCOME, AND IT WAS DRAWN AS THE FIRST. A round whose review found
// something blocking ends at `retry` with no pull request, and the NEXT round
// carries the same work through - so the amber row above asked for attention
// nobody owed. Task 1271 drew both on 2026-08-30: one in review as #272, one
// accusing a round whose work is inside it.
// A ROUND CONDUCT HAS FINISHED AND A PERSON HAS NOT. It closes when it reaches
// the publish path, with the flow still suspended on the human gate - so this is
// the ordinary shape of an approval, and it drew "stopped" in red for 26 hours
// while the phone reminded about it twice. The three checks below it are the
// negative controls: without them, hoisting waiting_on could have swallowed
// every other closed verdict on the board.
check("a closed round a person still owes an answer on says so",
  roundState(by("wt-1254aa")), { tone: "warn", state: "waiting on you" });
check("...and it is the same row, so the same round still ends stopped",
  roundState({ ...by("wt-1254aa"), waiting_on: null }),
  { tone: "fail", state: "stopped" });
check("...a closed publication with no pull request is still not published",
  roundState({ ...by("wt-1254aa"), waiting_on: null, published: true }).state,
  "not published");
check("...and the open round that always worked is untouched",
  roundState(by("wt-9f21c4")), { tone: "warn", state: "waiting on you" });
// THE ACTION AND THE SORT MOVED WITH IT, because a row that says "waiting on
// you" and then offers "task" is worse than one that says nothing: the approve
// link is on the notice, and it was being thrown away with the state.
check("a closed round owing an answer offers the approval, not the tracker",
  roundAction(by("wt-1254aa")).label, "approve");
check("...at conduct's own link, which is never a resume url",
  roundAction(by("wt-1254aa")).href, by("wt-1254aa").link);
// boardRow.waiting IS WHAT RoundPage GATES ITS APPROVE AND DECLINE CHIPS ON, so
// with a closed_at clause the one round that could be answered was the one
// showing no way to answer it. `moving` keeps its clause: that one asks whether
// the MACHINE is working, which a closed round never is.
const row1254 = boardRow(by("wt-1254aa"), { control: fleet.control, now: NOW });
check("the approve chips are offered on a closed round owing an answer",
  [row1254.waiting, row1254.moving], [true, false]);

check("a round a later one carried is superseded, not accused",
  roundState(by("wt-1271aa")), { tone: "off", state: "superseded" });
check("...and it outranks both closed verdicts it used to be confused with",
  roundState({ ...by("wt-1271aa"), published: false }).state, "superseded");
// ABSENCE IS FALSE, NEVER null. The collector and this bundle deploy
// separately, so a document written by the older one carries no such field and
// must still grade as it did.
check("a document with no superseded field grades as it always did",
  roundState({ ...by("wt-1271aa"), superseded: undefined }).state,
  "not published");
// An unreadable pr_state is a shrug, and superseding is a claim. The collector
// refuses to make it; this asserts the row it emits reads that way.
check("unknown outranks superseded, because it is not a claim",
  roundState({ ...by("wt-1271aa"), pr_state: "unknown" }).state, "published");

// THE ROW THAT PREDATES THE PR COLUMNS. A migration is a moment in time, so
// every round this fleet published before the feature shipped holds a NULL
// pr_url whether or not it opened one - and the real database had exactly one
// of these, for a pull request that was merged. Falling through to "not
// published" would put a permanent, confident lie on it.
check("a round that published before the columns existed is not accused",
  roundState(by("wt-0044ab")), { tone: "ok", state: "published" });
check("...and only a readable NULL means opened none",
  roundState({ ...by("wt-0044ab"), pr_state: null }).state, "not published");

// Both of those rows carry a closed_why, so an implementation that read the
// sentence could pass every check above. This is the one that would catch it.
const reworded = { ...by("wt-88fa10"), closed_why: "reached the publish path" };
check("rewording closed_why changes nothing", roundState(reworded).state, "stopped");

console.log("\n-- hiding a round requires positive evidence --");

// An unreachable GitHub leaves "unknown", and an unknown round MUST stay
// visible. A row disappearing because a token expired is the same class of
// error as an empty list reading as an idle fleet.
check("a merged round is settled", isSettled(by("wt-3311cd")), true);
check("an unknown one is not", isSettled(by("wt-1188aa")), false);
check("...and reads as published rather than merged",
  roundState(by("wt-1188aa")).state, "published");
check("an open round is never settled", isSettled(by("wt-9f21c4")), false);
check("an unreadable column is not evidence of a merge either",
  isSettled(by("wt-0044ab")), false);
check("exactly one round is hidden by default",
  fleet.rounds.length - fleet.rounds.filter((r) => !isSettled(r)).length, 1);

console.log("\n-- the action answers what is actually being waited for --");

check("an approval offers conduct's own page",
  roundAction(by("wt-9f21c4")).href, "https://agents.avanserv.com/run/job-aaa");
check("an open pull request offers itself",
  roundAction(by("wt-2c44b1")).label, "review #249");
check("a merged one no longer asks for a review",
  roundAction(by("wt-3311cd")).label, "task");
check("a round mid-flight offers nothing",
  roundAction(by("wt-77d3e0")).href, null);

// A REFUSAL IS NOT AN APPROVAL. conduct will not publish it and there is
// nothing to approve, so the chip must not say "approve" whatever link exists.
const refused = { ...by("wt-9f21c4"), kind: "refused" };
check("a refusal is not offered an approve button", roundAction(refused).label, "look");
check("...and goes to the task instead", roundAction(refused).href, by("wt-9f21c4").odoo_url);

// THE BRANCH IS WHERE THE CODE IS, AND THIS COLUMN IS NOT ABOUT THAT. It is a
// link in the pull-request column, which stays empty until a pull request
// exists precisely so it can hold one - and the same destination twice on one
// row is the row saying it does not know which of them matters.
check("a round mid-gate is not asked to act on its own branch",
  roundAction(by("wt-4ab810")).label, "-");
check("...and the branch is a link in the column that holds it",
  by("wt-4ab810").branch_url,
  "https://github.com/avanserv/upskald/tree/feat/1601-intake-form");
check("a merged round goes to its task", roundAction(by("wt-3311cd")).label, "task");

// NO ACTION MAY EVER BE A RESUME URL. The board is a new place for one to
// appear, so the assertion is repeated against every href it can produce.
// THE BRANCH LINK IS A NEW HREF ON A ROW, which is exactly why this loop reads
// every action rather than a list somebody maintains.
const hrefs = fleet.rounds.map((r) => roundAction(r).href).filter(Boolean);
check("no action is a resume URL", hrefs.some((h) => h.includes("/resume/")), false);
check("no action leaks a signature", hrefs.some((h) => h.includes("resume_id")), false);

console.log("\n-- why a round stopped, in conduct's own words --");

// THE EXPANDER EXISTS ONLY WHERE THERE IS SOMETHING BEHIND IT. A round that
// ended well has neither a run error nor a chain sentence, and an affordance
// that opens onto nothing would be on every row.
check("a healthy round has nothing to expand", roundError(by("wt-2c44b1")).length, 0);
// conduct WRITES closed_why ON EVERY ROUND IT CLOSES, "reached the publish
// path" included - so keying the expander on the sentence would put one on
// every finished row, opening onto a reason nothing went wrong.
check("...even though conduct wrote it a sentence",
  by("wt-2c44b1").closed_why, "reached the publish path");
check("a round that hit the cap shows conduct's sentence",
  roundError(by("wt-88fa10")),
  ["the gate failed on `e2e-test`", "the rounds are used up"]);

// TWO SOURCES, AND THEY OFTEN SAY THE SAME THING. conduct builds closed_why as
// "the flow failed: <the refusal>", so on a refused round the run's own reason
// is repeated with a prefix - and printing both is the row saying it twice.
check("a repeated reason is printed once",
  roundError(by("wt-4ab810-r1")),
  ["the gate failed in the pristine tree (exit 2, e2e-test)"]);

// DISPLAYED AND NEVER PARSED, the same contract closed_why already had. The
// outcome is derived from `published` and `pr_state`, which are structural.
const rewritten = {
  ...by("wt-88fa10"),
  error: "something else entirely",
  closed_why: "and a different sentence",
};
check("rewording a reason does not change the state",
  roundState(rewritten).state, roundState(by("wt-88fa10")).state);
check("...nor how many lines are shown", roundError(rewritten).length, 2);

console.log("\n-- the branch has a name a person can read --");

// THE `agents/` PREFIX IS ON EVERY BRANCH conduct PUSHES - publish.branch_name
// refuses a name outside it, which is the whole boundary keeping a phase off
// main - so printing it costs characters on every row and distinguishes none.
check("the prefix is dropped for display",
  roundBranch(by("wt-4ab810")), "feat/1601-intake-form");
check("a round that has pushed nothing has no branch",
  roundBranch(by("wt-77d3e0")), null);
// AND ONLY THAT PREFIX. A branch that does not carry it is shown whole rather
// than trimmed by guesswork.
check("an unprefixed branch is left alone",
  roundBranch({ ...by("wt-4ab810"), branch: "some/other-branch" }), "some/other-branch");

console.log("\n-- progress, and the ETA that is usually a dash --");

check("progress is done over the round's own phases",
  roundSteps(by("wt-9f21c4")).done.length, 4);

// A CHANGE TAKES SIX STEPS AND conduct RUNS FIVE. The fifth ends with a pull
// request; what settles the change is somebody merging it, and until the rail
// carried that a round whose work was sitting on a branch read `done 5/5` -
// the same reading as one that had landed.
check("the sequence is conduct's five and the merge",
  roundSteps(by("wt-9f21c4")).phases, [...PHASE_SEQUENCE, MERGE_STEP]);
check("a round that has finished nothing is at zero of six",
  [roundSteps(by("wt-77d3e0")).done.length, roundSteps(by("wt-77d3e0")).phases.length], [0, 6]);
check("a merged round has all six", roundSteps(by("wt-3311cd")).done.length, 6);

// THE MERGE IS DONE ONLY ON POSITIVE EVIDENCE. `pr_state` is "unknown" whenever
// GitHub could not be asked, and an unknown merge must draw as not-yet rather
// than as landed - the rule isSettled states for hiding a round, pointing the
// same way. A round that will never merge leaves it hollow, which is what
// happened to it.
check("a round under review has five of six", roundSteps(by("wt-2c44b1")).done.length, 5);
check("...and the merge is not among them",
  roundSteps(by("wt-2c44b1")).done.includes(MERGE_STEP), false);
check("a publication nobody could confirm does not claim a merge",
  roundSteps(by("wt-0044ab")).done.includes(MERGE_STEP), false);

// THE WORD IS DROPPED ONCE conduct'S FIVE ARE BEHIND IT, because no phase is
// running: `r.phase` is the last one that ran, and `ship 5/6` reads as a ship
// phase in flight. "awaiting merge" would be a claim, and false on every round
// that was declined, timed out or stopped after publishing.
check("a running round names its phase", phaseLabel(by("wt-77d3e0")), "plan 0/6");
check("a round waiting to merge names no phase", phaseLabel(by("wt-2c44b1")), "5/6");
check("a merged round is done", phaseLabel(by("wt-3311cd")), "done 6/6");

// THIN EVIDENCE IS A DASH, NOT A GUESS. The collector withholds the whole sum
// when any remaining phase has fewer than five completed runs behind it.
check("a withheld ETA stays null", roundEtaAt(by("wt-77d3e0"), 1787000000), null);

// A ROUND WAITING ON A PERSON HAS NO ETA THE MACHINE CAN GIVE. The remaining
// phases sum to a couple of minutes of `ship`; the actual wait is however long
// somebody takes to look, bounded only by the seven-day human timeout. The
// collector withholds it, and this asserts the contract rather than recomputing
// it - "~1m" over a gate that has been waiting since last night would be the
// most confidently wrong number on the page.
check("a human gate carries no ETA", by("wt-9f21c4").eta_seconds, null);
check("...nor a sample count to justify one", by("wt-9f21c4").eta_samples, null);
check("an ETA is measured from the document, not from now",
  roundEtaAt(by("wt-4ab810"), 1787000000), 1787000000 + 3080);

console.log("\n-- a round whose task is unknown claims nothing --");

// EVERY ROUND THIS FLEET RAN BEFORE run.odoo_task IS IN THIS POSITION. The
// collector cannot know which task it was for: run.task holds the phase's whole
// prompt, and reading an id out of a paragraph is the parse this codebase
// refuses. So the chip must be disabled - never a guessed link.
//
// ITS ATTEMPT IS NULL FOR A SEPARATE REASON, and the two used to be one. The
// number is conduct's own count off the plan step's dispatch payload, so it
// does not depend on the task id at all; a round this old is null because its
// plan predates the key, and a task-less round conduct DID number would show
// one.
check("a round with no task id has no tracker link", by("wt-hist01").odoo_url, null);
check("...and no attempt number", by("wt-hist01").attempts, null);
check("...and still renders a state", roundState(by("wt-hist01")).state, "stopped");
check("...whose action falls back to nothing clickable",
  roundAction(by("wt-hist01")).href, null);

// ONE ROW PER ATTEMPT is the whole point: a failed first attempt keeps its own
// cost and its own failure instead of collapsing into one row.
//
// AND 1 AND 2 COME FROM TWO DIFFERENT PLACES, which is the shape worth having
// here. The number is conduct's count within a CHAIN, and a chain is keyed on
// the worktree - so these two rounds, on two lanes, are two chains and a bare
// count of rounds would give each of them 1. The closed one does read 1, off
// its own plan dispatch. The OPEN one reads 2 because source_fleet takes the
// live chain.attempts for the round in flight, and that counter also counts a
// REPAIR - dev and the gate re-run on the tree as it stands, which opens no
// round and leaves no plan run to read a number off. So the second attempt is
// visible here and has no row, which is exactly the gap a closed round shows
// as 1 then 3.
const attempts1601 = fleet.rounds
  .filter((r) => r.odoo_task === 1601)
  .map((r) => r.attempts)
  .sort();
check("two attempts at one task are two rows", attempts1601, [1, 2]);
check("...and each carries its own cost",
  new Set(fleet.rounds.filter((r) => r.odoo_task === 1601).map((r) => r.cost_usd)).size, 2);

console.log("\n-- which rounds the board keeps --");

// THE ONLY FILTER USED TO BE `isSettled` - closed AND merged - which is far too
// weak to be the only one: `stopped`, `superseded`, `not published` and
// `in review` all stayed for ever, eleven rounds on one worktree with the live
// one somewhere in the list.
{
  const classOf = (id, task) => roundOutcome(by(id, task));
  check("a round owing a person an answer is owed, closed or not",
    classOf("wt-9f21c4"), "owed");
  check("a round in flight is live", classOf("wt-4ab810"), "live");
  check("a stopped round nobody has replaced is recoverable",
    classOf("wt-lane01", 1503), "recoverable");
  check("a merged round is finished", classOf("wt-3311cd"), "finished");

  // AND A CLOSED PULL REQUEST IS THE SECOND ANSWER. No fixture carried
  // `pr_state: "closed"` until 2026-09-07 - roundState had the state and
  // nothing had ever rendered it - which matters because _control_cancel ends
  // by PATCHing the pull request shut, so from the day the board grew a cancel
  // button every cancelled round sat in `unmerged` for ever with nothing on it.
  check("a round whose pull request was closed is finished too",
    classOf("wt-c105ed"), "finished");

  // MERGED IS THE ONLY THING THAT FINISHES A ROUND ON ITS OWN ACCOUNT, and the
  // first version of this called every closed state but `stopped` finished.
  // That is wrong in the direction that empties a board: measured on the live
  // host the day it shipped, 19 rounds of which the ONLY one on the current
  // lane was in review - so the board drew nothing and offered
  // `show 19 finished`. An open pull request is the one thing the round
  // produced, and it is waiting on a person.
  check("a round under review is NOT hidden", classOf("wt-2c44b1"), "unmerged");
  // HIDING REQUIRES POSITIVE EVIDENCE, which is isSettled's own contract:
  // `pr_state` is "unknown" whenever GitHub could not be asked, so a round
  // nobody could confirm merged stays on the board.
  check("a publication nobody could confirm is not hidden",
    classOf("wt-0044ab"), "unmerged");
  // AND THE ASYMMETRY WITH `pr closed` IS DELIBERATE, asserted here so it
  // cannot be tidied into consistency later. That state is GitHub answering;
  // this one is either a person declining or conduct's seven-day HUMAN_TIMEOUT
  // and nothing can tell which - so hiding it would hide an approval nobody
  // ever answered, on the one surface still showing it.
  check("a round that opened none is not hidden", classOf("wt-55ee02"), "unmerged");

  // THE TWO EXCEPTIONS, AND NEITHER CONTRADICTS THE RULE. A superseded round's
  // work is on the board under the round that carried it, and a stopped round
  // on a lane that has moved on is history nothing can reach.
  check("a superseded round is finished", classOf("wt-1271aa"), "finished");
  check("the older round on a reused lane is finished",
    classOf("wt-lane01", 1499), "finished");

  // ABSENCE IS FALSE, NOT UNKNOWN. `undefined !== null` is true - the trap that
  // once rendered `attempt  of 3` - and a document from an older collector
  // cannot say which round on a lane is current.
  const older = { ...by("wt-lane01", 1503) };
  delete older.latest_on_worktree;
  check("a round from an older collector is finished rather than guessed at",
    roundOutcome(older), "finished");

  // THE FILTER AND THE OFFER MUST NOT DRIFT. "finished" is defined as the class
  // roundControls offers nothing on; a button on a row nobody can see is the
  // failure this pairing exists to prevent.
  const wrong = fleet.rounds.filter(
    (r) => roundOutcome(r) === "finished" && roundControls(r, fleet.control, Date.now() / 1000).length,
  );
  check("nothing hidden by default has a button on it", wrong.length, 0);

  // AND EVERY STATE THE BOARD CAN DRAW MAPS TO A CLASS. roundOutcome asks
  // roundState rather than re-testing its conditions, so a state added there
  // without a thought here lands in `finished` - which is the safe direction
  // and is asserted rather than assumed.
  const seen = new Set(fleet.rounds.map((r) => roundState(r).state));
  check("the fixture exercises most of the state vocabulary", seen.size >= 6, true);
  check("...and every round has a class",
    fleet.rounds.every((r) =>
      ["owed", "live", "recoverable", "unmerged", "finished"].includes(roundOutcome(r))),
    true);

  // AND A BOARD THAT HIDES EVERYTHING IS THE FAILURE THIS FILTER SHIPPED WITH.
  // The live host had one round on its current lane and it was in review, so
  // the first version drew an empty table under a fleet with an open pull
  // request waiting on somebody.
  const shown = fleet.rounds.filter((r) => roundOutcome(r) !== "finished");
  check("the default view is not empty on a fleet with unmerged work",
    shown.length > 0, true);
  check("...and every unmerged outcome is in it",
    fleet.rounds.filter((r) => roundOutcome(r) === "unmerged").length >= 3, true);
}

console.log("\n-- what a person may ask the fleet to do --");

const ctl = fleet.control;
const nowUnix = Date.now() / 1000;
const open = by("wt-4ab810");
const closed = by("wt-2c44b1");

// A CONTROL THAT COULD NEVER APPLY IS NOISE ON EVERY ROW THAT HAS ONE.
// `wt-2c44b1` has an open pull request, so what is owed on it is a person's
// review on GitHub rather than anything conduct can be asked for - and a
// restart would force-push over the branch that pull request points at.
check("a round under review offers nothing", roundControls(closed, ctl, nowUnix).length, 0);
check("...even though it is still on the board", roundOutcome(closed), "unmerged");
check("a merged round offers nothing either",
  roundControls(by("wt-3311cd"), ctl, nowUnix).length, 0);
check("a round in flight offers four things",
  roundControls(open, ctl, nowUnix).map((c) => c.action),
  ["hold", "restart", "cancel", "cancel_requeue"]);

// THE ROW EVERY NEW CHIP EXISTS FOR. A stopped round used to be a permanent red
// line with nothing to press: roundControls returned [] for anything closed, and
// recovery was moving the task in Odoo by hand and running conduct over ssh.
const stopped = by("wt-lane01", 1503);
check("a stopped round can be resumed, restarted or cancelled",
  roundControls(stopped, ctl, nowUnix).map((c) => c.action),
  ["resume", "restart", "cancel", "cancel_requeue"]);
check("...and resume leads, because it is the cheaper answer",
  roundControls(stopped, ctl, nowUnix)[0].label, "resume");

// A ROUND WITH NOTHING FINISHED CANNOT BE RESUMED, and the sentence says so
// rather than the chip simply being absent: conduct refuses one in exactly
// these terms, because a resume that skips nothing is a restart under a name
// promising it would be cheap.
const nothingDone = { ...stopped, done: [] };
const noResume = roundControls(nothingDone, ctl, nowUnix).find((c) => c.action === "resume");
check("a resume with nothing to skip is refused, with a reason",
  noResume.disabled.includes("nothing to skip"), true);

// THE LANE IS NOT THE ROUND. conduct keeps ONE chain row per worktree and a
// worktree is reused, so the older round on a lane must be offered nothing at
// all - a restart aimed at it would land on its successor. wt-lane01 carries
// two rounds, which is what the live host looks like and what no fixture had.
const superseded = by("wt-lane01", 1499);
check("the older round on a reused lane offers nothing",
  roundControls(superseded, ctl, nowUnix).length, 0);
check("...and it is the SAME worktree as the one that does",
  superseded.worktree_id === stopped.worktree_id, true);

// AN OLDER COLLECTOR CANNOT SAY WHICH ROUND IS CURRENT, and `undefined !== null`
// is true - the trap that once rendered `attempt  of 3`. Absence must read as
// "not the latest" rather than as "probably this one", in front of a chip that
// closes a pull request.
const noFlag = { ...stopped };
delete noFlag.latest_on_worktree;
check("a document from an older collector offers nothing on a closed round",
  roundControls(noFlag, ctl, nowUnix).length, 0);

// WITHOUT A TASK ID THERE IS NO ROUND, ONLY A LANE. conduct refuses rather than
// guessing, so the board says why instead of offering a button that answers
// with a paragraph.
const noTask = { ...stopped, odoo_task: null };
check("a round with no task id has every chip disabled",
  roundControls(noTask, ctl, nowUnix).every((c) => c.disabled !== null), true);
check("...and each says it cannot be told from a later round",
  roundControls(noTask, ctl, nowUnix).every((c) => c.disabled.includes("later round")), true);

// THE LABEL AND THE ACTION COME OFF ONE BRANCH, which is intakeSwitch's rule
// applied where the consequence is worse than a colour: a chip reading `cancel`
// that sent `restart` would close a round somebody meant to start again.
const LABELS = { hold: "hold", release: "release", restart: "restart",
                 resume: "resume", cancel: "cancel", cancel_requeue: "cancel+requeue" };
const everyOffer = [
  ...roundControls(open, ctl, nowUnix),
  ...roundControls(stopped, ctl, nowUnix),
  ...roundControls(by("wt-77d3e0"), ctl, nowUnix),
];
check("no chip can send its neighbour's command",
  everyOffer.every((c) => LABELS[c.action] === c.label), true);

// EXACTLY THREE PRIMARY CHIPS ON EVERY ACTIONABLE ROW, which is what makes the
// board's column one line rather than four. At 132px the four wrapped and made
// every row 130px tall, which is a list nobody can scan.
for (const r of fleet.rounds) {
  const all = roundControls(r, ctl, nowUnix);
  if (!all.length) continue;
  check(`${r.worktree_id}/${r.odoo_task} offers three primary chips`,
    all.filter((c) => c.primary).length, 3);
}
// AND ONLY `cancel+requeue` IS HELD BACK, because everything it does `cancel`
// does too except the one tracker write - so a compact drawing loses no
// capability a reader cannot reach one click away, on the page they went to in
// order to decide.
check("the round page is where the rarer half of the pair lives",
  roundControls(open, ctl, nowUnix).filter((c) => !c.primary).map((c) => c.action),
  ["cancel_requeue"]);

// A ROUND WAITING FOR AN ANSWER IS NOT STUCK, IT IS WAITING FOR YOU. conduct
// would accept a restart, which is exactly why the board must not offer it as
// though it were the obvious move: it cancels the flow holding the question.
const owedRound = by("wt-1254aa");
check("the fixture has a round owing a person an answer", owedRound.waiting_on, "person");
const owedOffers = roundControls(owedRound, ctl, nowUnix);
check("a round waiting on you will not be restarted by one click",
  owedOffers.find((c) => c.action === "restart").disabled !== null, true);
check("...nor resumed", owedOffers.find((c) => c.action === "resume").disabled !== null, true);
check("...and the reason points at the answer that is owed",
  owedOffers.find((c) => c.action === "restart").disabled.includes("approve or decline"), true);
// CANCEL IS STILL OFFERED, because it is a decline that also cleans up - and
// declining is the one thing a person looking at this row may well want.
check("...but cancelling it is still one click",
  owedOffers.find((c) => c.action === "cancel").disabled, null);

// THE HELD ROUND OFFERS THE INVERSE, so the chip never lies about what pressing
// it will do.
check("a held round offers release rather than hold",
  roundControls(by("wt-77d3e0"), ctl, nowUnix)[0].action, "release");
// AND THE FIXTURE AGREES WITH ITSELF, which is not decoration: the collector
// derives a round's `held` from the same rows the control block carries, so a
// fixture where the two disagreed would pass whatever the derivation did.
check("...and the document says the same thing twice",
  ctl.holds.some((h) => h.subject === "wt-77d3e0" && h.value === "on")
    && by("wt-77d3e0").held, true);

// NO TOKEN IS NOT NO BUTTON, IT IS A BUTTON THAT SAYS WHY. Absent and broken
// are different findings, and a chip that lands somewhere it cannot act is
// worse than one that says less.
const noToken = { ...ctl, available: false };
const offers = roundControls(open, noToken, nowUnix);
check("without a token every control is disabled", offers.every((c) => c.disabled !== null), true);
check("...and each says why", offers.every((c) => c.disabled.includes("WINDMILL_DASHBOARD_TOKEN")), true);

// conduct REFUSES A RESTART INSIDE ITS FLOOR, so offering one teaches a reader
// to distrust the other chips. Two starts close together are two flows on one
// worktree, which is the hazard the floor exists for.
//
// THE FLOOR IS MEASURED AGAINST conduct's OWN STAMP AND WAS MEASURED AGAINST THE
// ROUND'S START. Those are different clocks: conduct debounces on the
// `restart:<worktree>` control row, so a round started three hours ago and
// restarted sixty seconds ago offered an ENABLED chip that conduct then refused.
// The row did not reach fleet.json at all until 2026-09-07 - the collector
// dropped it under a comment saying nothing on the board drew it - so the board
// was answering a different question rather than getting this one wrong.
const stampedLane = by("wt-77d3e0");
check("the floor reads conduct's stamp, not the round's start",
  Math.round(lastStartedAgo(stampedLane, ctl, nowUnix)) < 120, true);
const stampedRestart = roundControls(stampedLane, ctl, nowUnix).find((c) => c.action === "restart");
check("a restart inside conduct's floor is not offered",
  stampedRestart.disabled !== null, true);
check("...and it says which floor", stampedRestart.disabled.includes("600"), true);
check("...and the hold beside it still is",
  roundControls(stampedLane, ctl, nowUnix)[0].disabled, null);

// A ROUND THAT ONLY *LOOKS* FRESH IS NOT REFUSED. This is the half the old test
// asserted backwards: `started_at` is not what conduct measures, so a round that
// began thirty seconds ago on a lane nobody has restarted may be restarted.
const fresh = { ...open, started_at: new Date(Date.now() - 30_000).toISOString() };
check("a young round on an unstamped lane may still be restarted",
  roundControls(fresh, ctl, nowUnix).find((c) => c.action === "restart").disabled, null);

// AN OLDER COLLECTOR SENDS NO STAMPS AT ALL, and "no stamp" must read as
// "nothing to debounce against" rather than as "started just now". conduct
// refuses again on the host, so the safe direction here is to offer the button.
const noStamps = { ...ctl };
delete noStamps.stamps;
check("no stamps at all is not a floor", lastStartedAgo(stampedLane, noStamps, nowUnix), null);
check("...so the restart is offered and conduct decides",
  roundControls(stampedLane, noStamps, nowUnix).find((c) => c.action === "restart").disabled, null);

// AN ASK WITH NO OPPOSITE RETIRES WHEN ITS OFFER GOES. `askAge` clears by the
// chip's action FLIPPING, which works for hold/release and for nothing here: a
// restart chip says `restart` before and after. conduct carrying out a cancel
// closes the round, which empties this list.
const asked = { action: "cancel", at: nowUnix - 30 };
check("an outstanding ask stands while its offer does",
  Math.round(offerStands(asked, roundControls(open, ctl, nowUnix), nowUnix)), 30);
check("...and retires when the fleet is seen doing it",
  offerStands(asked, roundControls(closed, ctl, nowUnix), nowUnix), null);
check("...with the same ceiling the intake switch has",
  offerStands({ action: "cancel", at: nowUnix - ASK_CEILING_S - 1 },
    roundControls(open, ctl, nowUnix), nowUnix), null);

// A HOLD IS BOUNDED BY SOMETHING THE PERSON SETTING IT DOES NOT CONTROL: conduct
// does not answer a held step and the step's own timeout is 24h, so a hold left
// long enough does not pause a round, it fails one.
check("a round nobody held has no countdown", holdExpiresIn(open, nowUnix), null);
const old = { ...open, held: true,
  held_at: new Date(Date.now() - 23 * 3600 * 1000).toISOString() };
const left = holdExpiresIn(old, nowUnix);
check("a hold counts down to the step's timeout", left > 0 && left < 3700, true);
check("...from 24 hours", HOLD_TIMEOUT_S, 86400);

// THE SWITCH HAS TWO SOURCES AND THE BOARD MUST SAY WHICH IS IN FORCE. The
// collector cannot read a Python literal in another repository, so "default"
// deliberately does not claim to know which default.
check("a row that set it says so", intakeState(ctl, "upskald").source, "set");
check("...and which way", intakeState(ctl, "upskald").on, true);
check("a project nobody set defers", intakeState(ctl, "other").source, "default");
check("...without claiming to know the default", intakeState(ctl, "other").on, null);
// conduct defers to the descriptor on a value it does not define, and so must
// this - reading it as `off` would invent a state nothing chose.
const odd = { ...ctl, intake: [{ subject: "upskald", value: "maybe", at: null, note: null }] };
check("a value neither on nor off defers too", intakeState(odd, "upskald").on, null);

// THE LABEL AND THE COMMAND COME OFF ONE BRANCH, and this is what holds them
// there. The board draws this switch TWICE now - once in the fleet header,
// where it is the first thing the page says, and once in the Intake panel - and
// the last time this application drew one fact in two places, the two drawings
// disagreed about a tone no fixture carried and nothing could see it. Here the
// same defect would be a chip reading `arm` that sends `intake_off`: a button
// doing the exact opposite of what it says.
const armed = intakeSwitch(ctl, "upskald");
const disarmed = intakeSwitch(
  { ...ctl, intake: [{ subject: "upskald", value: "off", at: null, note: null }] }, "upskald");
const shipped = intakeSwitch(ctl, "other");

check("armed offers to disarm",
  [armed.state, armed.tone, armed.label, armed.action],
  ["armed", "ok", "disarm", "intake_off"]);
check("disarmed offers to arm",
  [disarmed.state, disarmed.tone, disarmed.label, disarmed.action],
  ["disarmed", "off", "arm", "intake_on"]);
// THE THIRD STATE, WHICH NO FIXTURE CARRIES and which is exactly why it is
// asserted here rather than left to a document. Nobody has overridden conduct's
// descriptor, so the board may not claim the fleet is running: it takes the off
// tone and offers to arm.
check("nobody having said reads as shipped",
  [shipped.state, shipped.tone, shipped.label, shipped.action],
  ["as shipped", "off", "arm", "intake_on"]);
check("the chip and the command never disagree",
  [armed, disarmed, shipped].every((sw) => (sw.label === "disarm") === (sw.action === "intake_off")),
  true);

console.log("\n-- an ask this browser made, and when it stops standing --");

// THE SECOND HALF OF 2026-08-28. conduct could not answer for 33 minutes, and
// the board forgot the ask on every reload - so a person who refreshed saw the
// command offered again as though they had never sent it.
//
// CLEARED BY DERIVATION AND NEVER BY A TIMER ALONE, which is the property that
// makes remembering it safe: `offers` is what the chip would send NOW, so the
// moment the fleet does the thing the two stop matching and the memory retires
// itself. A memory that could outlive its own truth would be worse than none.
const ASKED_AT = 1_700_000_000;
const stands = { action: "intake_off", at: ASKED_AT };
check("an ask nobody has acted on yet still stands",
  askAge(stands, "intake_off", ASKED_AT + 180), 180);
check("the fleet doing it retires the ask",
  askAge(stands, "intake_on", ASKED_AT + 180), null);
check("nothing remembered is not an outstanding ask", askAge(null, "intake_off", ASKED_AT), null);
// THE BACKSTOP, NOT THE MECHANISM. A flow that timed out unanswered never moves
// the state, so without a ceiling the chip would say `asked` for ever.
check("an ask older than the flow's own timeout is dropped",
  askAge(stands, "intake_off", ASKED_AT + ASK_CEILING_S + 1), null);
// A CLOCK THAT WENT BACKWARDS is a browser waking from sleep, not an ask from
// the future - and a negative age would render as "asked -3m ago".
check("an ask from the future is dropped", askAge(stands, "intake_off", ASKED_AT - 60), null);

console.log("\n-- the board puts what needs acting on at the top --");

const ordered = [...fleet.rounds].sort(byUrgency).map((r) => r.worktree_id);
// EVERY ROUND OWING A PERSON AN ANSWER, AND NOTHING ELSE, IS AT THE TOP - open
// or closed. This asserted `closed_at === null` for the top three until
// 2026-08-31, which was true only because no fixture had the shape that matters
// most: conduct finishes a round and THEN a person owes an answer on it, so
// ranking on closed_at sank the one row that needed acting on.
const owed = fleet.rounds.filter((r) => r.waiting_on === "person").length;
check("two rounds owe a person an answer", owed, 2);
check("both come first, whether or not conduct has finished with them",
  ordered.slice(0, owed).every((id) => by(id).waiting_on === "person"), true);
check("no finished round that owes nothing outranks a live one",
  ordered.slice(owed).findIndex((id) => by(id).closed_at === null)
    < ordered.slice(owed).findIndex((id) => by(id).closed_at !== null), true);

// A LOCKED DATABASE IS NOT AN IDLE FLEET, and both produce the same empty list.
const broken = fleetUnreadable();
check("the unreadable document has no rounds", broken.rounds.length, 0);
check("...and says why", broken.sources.conduct_db.ok, false);
check("...with a reason", typeof broken.sources.conduct_db.error, "string");


console.log("\n-- the one route that acts, and the receipt it answers with --");

// THE FIRST ASSERTIONS IN THIS FILE THAT REACH src/api/, AND A LIVE DEFECT IS
// WHY. `control()` posted a command, Windmill carried it out, conduct wrote the
// row and a round started - and the board printed `failed`, because the run
// endpoint answers `201 text/plain` with a bare job id and `fetchJson` handed
// that to `JSON.parse`. Every measurement ever recorded for this route was made
// with curl from the host, so the client half had never once run.
//
// NO DOM IS NEEDED FOR ANY BRANCH BELOW. `looksLikeSignIn` reads `window` only
// when `res.redirected`, which a constructed Response never is, and
// `reauthenticate` catches its own missing `sessionStorage`. So a stubbed
// `fetch` reaches all three outcomes in plain node.
const JOB_ID = "01a04a31-dbc7-7fdf-0e59-afcce643d0e6";
const realFetch = globalThis.fetch;
let sent = null;
const answers = (body, status, type) => {
  globalThis.fetch = async (url, options) => {
    sent = { url, options };
    return new Response(body, { status, headers: { "content-type": type } });
  };
};
const attempt = async () => {
  try {
    return { got: await control({ action: "intake_on", project: "upskald" }) };
  } catch (error) {
    return { got: `threw ${error.name}: ${error.message}`, error };
  }
};

// WINDMILL'S OWN ANSWER, measured off Caddy's access log on 2026-08-28:
// 201, text/plain; charset=utf-8, 36 bytes. Point `control()` back at
// `fetchJson` and this row fails with a SyntaxError - which is how it was
// proved to fire before it was trusted.
answers(JOB_ID, 201, "text/plain; charset=utf-8");
const receipt = await attempt();
check("a plain-text job id is a receipt, not a failure", receipt.got, JOB_ID);
check("it posts the command to the one fixed path",
  [sent.url, sent.options.method, sent.options.credentials, JSON.parse(sent.options.body)],
  ["/api/control/run", "POST", "same-origin", { action: "intake_on", project: "upskald" }]);
// A STANDING INVARIANT OF src/api/control.ts, asserted rather than trusted: the
// token lives in Caddy and this bundle never sees it. If the browser ever sends
// a credential of its own, the reason this dashboard is cheap to expose is gone.
check("the browser sends no credential of its own",
  Object.keys(sent.options.headers).filter((h) => /^(authorization|cookie)$/i.test(h)),
  []);

// CADDY REFUSES A NON-POST ITSELF, with a plain-text body. The status line is
// all there is to report, and reporting it is not the same as parsing it.
answers("post only", 405, "text/plain; charset=utf-8");
const notPost = await attempt();
check("a refusal carries its status, not a parse error",
  [notPost.error?.name, notPost.error?.status], ["HttpError", 405]);

// THE TRAP src/api/http.ts EXISTS FOR, now that this route reads text: an
// expired session is a 302 that fetch FOLLOWS, so the body is a sign-in page
// with res.ok true. It must never be handed back as a job id.
answers("<!doctype html><title>sign in</title>", 200, "text/html; charset=utf-8");
const signedOut = await attempt();
check("a sign-in page is never mistaken for a job id", signedOut.error?.name, "SignedOutError");

// --- the approve route, and the round key both halves have to agree on -------
console.log("\n-- answering the human gate --");

const { approve } = await load("/src/api/approve.ts");
const { roundKey } = await load("/src/api/round.ts");

// THE KEY IS BUILT IN TWO PLACES and they are a pair that can disagree: this
// one, and `_round_key` in bin/collect-metrics.py, which names the file. The
// board asking for a name the collector never wrote is a 404 the panel reports
// as "not yet" for ever, which looks exactly like a collector that has stopped.
check("a round key is the worktree and its start, punctuation stripped",
  roundKey("upskald-ship", "2026-08-28T21:10:34Z"),
  "upskald-ship-20260828T211034Z");
check("a round with no start has no key rather than a malformed one",
  [roundKey("upskald-ship", null), roundKey("", "2026-08-28T21:10:34Z")], [null, null]);

const askApprove = async (decision) => {
  try {
    return { got: await approve(JOB_ID, decision, "looks right") };
  } catch (error) {
    return { got: `threw ${error.name}: ${error.message}`, error };
  }
};

answers(JOB_ID, 201, "text/plain; charset=utf-8");
const approved = await askApprove("approve");
check("an approval receipt is a job id, not a parse error", approved.got, JOB_ID);
check("it posts to its own fixed path, with the job id in the BODY",
  [sent.url, sent.options.method, JSON.parse(sent.options.body)],
  ["/api/approve/run", "POST",
    { job_id: JOB_ID, decision: "approve", note: "looks right" }]);
// THE URL CARRIES NO JOB ID, and that is the whole reason the id is in the
// body: Caddy's guard is that the client's path is DISCARDED, and a path with
// an id in it is that guard given away for a convenience.
check("the job id never appears in the url", sent.url.includes(JOB_ID), false);
check("the browser sends no credential of its own here either",
  Object.keys(sent.options.headers).filter((h) => /^(authorization|cookie)$/i.test(h)),
  []);

answers(JOB_ID, 201, "text/plain; charset=utf-8");
await askApprove("decline");
check("a decline is the same route with a different decision",
  JSON.parse(sent.options.body).decision, "decline");

// AN UNSET TOKEN IS A ROLLOUT, NOT A FAULT - Caddy answers 401 and the board
// disables the chips. It must arrive as a status, never as a job id.
answers("unauthorized", 401, "text/plain; charset=utf-8");
const noApproveToken = await askApprove("approve");
check("a missing approve token is a status, not a receipt",
  [noApproveToken.error?.name, noApproveToken.error?.status], ["HttpError", 401]);

globalThis.fetch = realFetch;

// --- the round document a fixture serves ------------------------------------
console.log("\n-- what a round document promises --");

const { roundDocument, MISSING_ROUNDS } = await load("/fixtures/round.ts");
const round = roundDocument("upskald-ship-20260828T211034Z");

// `rendered: false` IS "NOT YET", NOT "IT SAID NOTHING". The collector renders
// a few logs per pass so a cold start converges instead of blowing its
// 25-second timeout, and a phase waiting its turn must carry a reason rather
// than an empty transcript that reads as a silent phase.
const deferred = round.phases.filter((p) => !p.rendered);
check("a deferred phase says why rather than showing an empty transcript",
  deferred.map((p) => [p.turns.length, Boolean(p.short)]), [[0, true]]);

// A GATE PHASE RUNS NO MODEL. 197,160 lines on the live host, 38 of them JSON
// and none of them a conversation - so a tail, never turns.
const gate = round.phases.find((p) => p.gate);
check("the gate phase carries a tail and no conversation",
  [gate.phase, gate.turns.length, gate.gate.truncated], ["verify", 0, true]);

// THE CARD IS THE PANEL'S REASON TO EXIST, and it is a different text from the
// notice summary the board has always shown - that one is the phone copy,
// rendered a phase earlier and cut to 240 characters on its way into
// fleet.json.
check("the card is present and is not the phone summary",
  [round.report.card.length > 240, round.report.card.startsWith("## upskald")],
  [true, true]);

// NO RESUME URL, ANYWHERE, EVER. Windmill's jobs_u/resume carries an HMAC in
// the path and needs no session, so anything holding one can approve an agent's
// merge. Asserted over the whole document rather than over a field, because the
// next field to carry one has not been written yet.
const asText = JSON.stringify(round);
check("no round document can carry a resume url",
  [asText.includes("/resume/"), asText.includes("resume_id")], [false, false]);

check("a round the collector has not written yet is offered as absent",
  MISSING_ROUNDS.length > 0, true);

console.log("\n-- reading what the host recorded --");

// THE CARD IS MARKDOWN AND WAS RENDERED IN A `<pre>`, syntax and all, in the one
// panel on this page whose whole job is to be read.
{
  const blocks = parseMarkdown(round.report.card);
  check("the card parses into blocks", blocks.length > 3, true);
  check("...beginning with its heading",
    [blocks[0].kind, blocks[0].level], ["heading", 2]);
  check("...and carrying its bullets as a list",
    blocks.some((b) => b.kind === "list" && b.items.length > 1), true);

  // NO `v-html` ON A PATH MODEL OUTPUT TAKES, which is why this returns a tree
  // rather than an HTML string - and the one hole a tree could still leave is a
  // scheme. An ALLOWLIST, not a `javascript:` denylist: `JaVaScRiPt:`, a tab
  // inside the scheme and `data:text/html` are three ways past a denylist.
  check("only http and https make a link",
    [safeHref("https://example.com"), safeHref("http://example.com")],
    ["https://example.com", "http://example.com"]);
  for (const bad of ["javascript:alert(1)", "JaVaScRiPt:alert(1)", "data:text/html,<script>",
                     " javascript:alert(1)", "vbscript:x"]) {
    check(`a ${bad.slice(0, 12)} href is refused`, safeHref(bad), null);
  }
  // THE TEXT SURVIVES ITS REFUSED HREF. Dropping the node would hide a
  // destination somebody is being asked to trust.
  const refused = parseInline("see [this](javascript:alert(1)) please");
  check("a refused link keeps its text and loses its href",
    [refused.some((s) => s.kind === "link"),
     refused.map((s) => s.text).join("").includes("javascript:alert(1)")],
    [false, true]);

  // A BACKTICK SPAN MAY CONTAIN ASTERISKS. `**/*.ts` is a real path and appears
  // in these cards; emphasis found inside one would split a literal the author
  // quoted precisely so it would not be interpreted.
  const code = parseInline("run `make check **/*.ts` now");
  check("code spans are found before emphasis",
    code.find((s) => s.kind === "code").text, "make check **/*.ts");

  // AN UNCLOSED FENCE TAKES THE REST rather than being abandoned: the collector
  // clips a card at 40,000 bytes, so ending mid-block is ordinary.
  const clipped = parseMarkdown("intro\n\n```sh\nmake check\nmake install");
  check("a clipped fence keeps what is left of it",
    clipped[clipped.length - 1].text, "make check\nmake install");
}

// `report.verdict` IS A JSON STRING AND THE PANEL SHOWED IT AS ONE, under a
// heading promising an account of the run.
{
  const parsed = parseVerdict(round.report.verdict);
  check("a verdict in its schema is read", [parsed.kind, parsed.status], ["parsed", "done"]);
  check("...with its summary lifted out", parsed.summary !== null, true);
  const labels = parsed.fields.map((f) => f.label);
  check("...its concerns kept as a list",
    parsed.fields.find((f) => f.label.includes("raised these")).kind, "list");
  // SHOWN BECAUSE APPROVING THIS FILES THEM. Everything else in a verdict is the
  // phase talking about work already done; these become tasks in somebody's
  // backlog the moment the pull request opens.
  check("...and the follow-ups named as what they will become",
    labels.some((l) => l.includes("filed as tasks")), true);

  // THREE OUTCOMES, NONE OF THEM SILENT - conduct/card.py's own rule, mirrored.
  check("an absent verdict says it is absent",
    [parseVerdict(null).kind, parseVerdict(null).text !== null], ["absent", true]);
  check("...and so does an empty one", parseVerdict("   ").kind, "absent");
  // UNPARSED IS A RENDERING, NOT AN ERROR: the pinned CLI can retract structured
  // output, so a plain-text answer is a thing that happens and dropping it would
  // lose the phase's only account of a run somebody is about to approve.
  const raw = parseVerdict("I could not finish - the gate was already red.");
  check("an answer outside the schema is kept verbatim",
    [raw.kind, raw.text], ["raw", "I could not finish - the gate was already red."]);
  check("...and so is a JSON array, which is not a verdict either",
    parseVerdict('["a"]').kind, "raw");

  // THE SCHEMAS MOVE IN ANOTHER REPOSITORY AND THIS BUNDLE DEPLOYS SEPARATELY,
  // so a key nobody here has heard of must appear under its own name rather
  // than vanish.
  const unknown = parseVerdict('{"status":"done","something_new":"a value"}');
  check("a key this bundle has never heard of is still drawn",
    unknown.fields.some((f) => f.label === "something new"), true);
}

// THE TRANSCRIPT WAS A `kind` LABEL AND ITS PAYLOAD AS ITSELF - a tool call read
// `Read {"file_path":"bin/lint-repo.sh","offset":40}`.
{
  const turns = round.phases[0].turns.map(describeTurn);
  const sides = turns.map((t) => t.who);
  check("the prompt is the other side of the conversation", sides[0], "you");
  check("...and every shape is read", new Set(sides).size >= 4, true);

  const read = turns.find((t) => t.tool === "Read");
  check("a Read names its file and needs no disclosure",
    [read.headline, read.detail], ["bin/lint-repo.sh", null]);

  const bash = turns.find((t) => t.tool === "Bash");
  check("a Bash leads with what it was for",
    bash.headline.startsWith("Find the prose leg"), true);

  // THE CAP IS A CAP, NOT A SUMMARY. What is left over is counted and said, so a
  // reader knows the shown lines begin something rather than being all of it.
  const edit = turns.find((t) => t.tool === "Edit");
  check("an edit shows a diff", edit.diff.length, DIFF_LINES);
  check("...capped, and says how much it did not show", edit.diffMore > 0, true);
  check("...and keeps the whole input behind a disclosure", edit.detail !== null, true);

  // A REFUSED PERMISSION IS A FINDING, not chatter - the fleet's own record of a
  // boundary holding - and burying which tool inside a JSON blob is the opposite
  // of treating it as one.
  const denied = turns.find((t) => t.who === "denied");
  check("a refusal names the tool and the reason",
    [denied.tool, denied.headline.includes("planning phase")], ["WebFetch", true]);

  // THE RENDERER SPEAKING ABOUT ITS OWN LIMITS MUST NOT LOOK LIKE THE MODEL.
  check("the collector's own note is not an assistant turn",
    turns.find((t) => t.who === "note").headline.includes("truncated"), true);

  // TRIMMED AT BOTH ENDS, which is what makes a one-word change show as one line
  // rather than as forty.
  const trimmed = shortDiff("a\nb\nc\nd", "a\nB\nc\nd");
  check("a diff trims the lines the two sides share",
    [trimmed.lines.length, trimmed.more, trimmed.lines[0].text], [2, 0, "b"]);

  // NOTHING HERE THROWS ON A SHAPE THAT HAS MOVED. The tool schema lives in
  // another program entirely, and a transcript that failed to render would be
  // worse than one that renders plainly.
  check("a truncated input renders rather than throwing",
    describeTurn({ kind: "tool", name: "Edit", input: '{"file_path":"a.ts","old_' })
      .headline.length > 0, true);
  check("a tool nobody here has heard of names its own keys",
    describeTurn({ kind: "tool", name: "Sorcery", input: '{"spell":"x","level":3}' })
      .headline, "spell x, level 3");
}

// --- the machinery, as /agents/fleet draws it --------------------------------
//
// LOADED FOR THE FIRST TIME ON 2026-09-07, and the reason is the reason
// roundboard.ts and quotaWindow were: both of these were logic in a .vue file,
// which this script structurally cannot reach. One of them had been WRONG the
// whole time - the containment tone mapped a `fail` check to amber, so the one
// finding on that page which pages a phone drew as a warning, and no fixture
// could see it because the agents section has never carried a `fail`.

console.log("\n-- the fleet page's own derivations --");

const M = {
  runsToday: 6, runsFailedToday: 1, phaseInFlight: 1,
  approvals: 2, workerLanes: 2, windmillDb: 1290 * 1024 * 1024,
  mirrorAge: 2400, checkoutDirty: 0, publishConfigured: 1, leaked: 0,
};

const checksById = new Map(statusDocument().checks.map((c) => [c.id, c]));

// THE FOUR STATES OF THE HEADLINE, and the fourth is the one that matters.
// fmt.number(NaN) is "-", so the obvious spelling of this renders
// `- phase runs today` on a host the store has no sample for: a headline
// claiming a dash ran. Absence gets its own sentence.
check("a running phase leads with the count", leadReading(M).text, "6 phase runs today");
check("...and breathes", leadReading(M).live, true);
check("...and says a phase is running", leadReading(M).sub, "1 failed - a phase is running now");
check("idle is not running", leadReading({ ...M, phaseInFlight: 0 }).live, false);
check("...and says which nothing it is",
  leadReading({ ...M, phaseInFlight: 0 }).sub, "1 failed - nothing running");
check("never-run is grey, not idle",
  [leadReading({ ...M, phaseInFlight: undefined }).tone,
   leadReading({ ...M, phaseInFlight: undefined }).sub],
  ["off", "no phase has ever run on this host"]);
check("an absent counter is a sentence, never a dash",
  leadReading({ ...M, runsToday: Number.NaN }).text, "not measured");
check("...and it is grey", leadReading({ ...M, runsToday: Number.NaN }).tone, "off");
check("no lead reading is ever the bare NO_DATA string",
  [M, { ...M, phaseInFlight: 0 }, { ...M, phaseInFlight: undefined }, { ...M, runsToday: Number.NaN }]
    .some((x) => leadReading(x).text.trim() === fmt.NO_DATA), false);

// "none failed" rather than "0 failed", and NOTHING rather than "0 failed" when
// the counter is absent - the same rule one line down from the headline.
check("zero failures says so in words",
  leadReading({ ...M, runsFailedToday: 0, phaseInFlight: 0 }).sub, "none failed - nothing running");
check("an absent failure count is omitted, not zero",
  leadReading({ ...M, runsFailedToday: Number.NaN, phaseInFlight: 0 }).sub, "nothing running");
check("one run is singular", leadReading({ ...M, runsToday: 1 }).text, "1 phase run today");

// THE TEN ROWS.
const pre = preconditionRows(M, checksById);
check("ten preconditions", pre.length, 10);
check("the ids are the exported set", pre.map((r) => r.id), PRECONDITION_IDS);

const rowFor = (id) => pre.find((r) => r.id === id);
check("a count row carries its number", rowFor("agents.approvals_pending").value, "2");
check("a byte row carries its unit", rowFor("agents.windmill_db_size").value, "1.3 GB");
check("a clean checkout says clean", rowFor("agents.checkout_drift").value, "clean");
check("a dirty one counts",
  preconditionRows({ ...M, checkoutDirty: 3 }, checksById)
    .find((r) => r.id === "agents.checkout_drift").value, "3 dirty");

// IT NAMES /var/agents. The tile this replaced said `/var/home-server against
// git`, and the metric behind it is written by agents.checkout_drift, which
// measures conduct's OWN checkout - "the same failure one directory over", in
// bin/verify-host.sh's own words. No fixture could ever have caught it: the
// number is right either way, and only the caption was wrong.
check("the checkout row names the tree it actually measures",
  rowFor("agents.checkout_drift").finding.includes("/var/agents"), true);
check("...and not this one",
  rowFor("agents.checkout_drift").finding.includes("/var/home-server"), false);

// A check with no number of its own contributes its verdict and never a word
// this application made up.
check("a verdict-only row shows the verdict", rowFor("agents.slice_limits").value, "pass");

// THE TONE BUG, PLANTED. checkTone maps fail to fail; the version that lived in
// FleetPage.vue mapped it to warn.
const failing = new Map(checksById);
failing.set("agents.slice_limits", {
  section: "agents", id: "agents.slice_limits", status: "fail",
  message: "app-agents.slice reads UNLIMITED for: MemoryMax",
});
check("a failing containment check is red, not amber",
  preconditionRows(M, failing).find((r) => r.id === "agents.slice_limits").tone, "fail");

// GREY IS NEVER GREEN. A check the battery did not run must not borrow the
// colour of one that ran and passed.
const empty = preconditionRows(M, new Map());
check("an unmeasured row is grey", [...new Set(empty.map((r) => r.tone))], ["off"]);
check("...and says it was not measured",
  empty.every((r) => r.finding.length > 0), true);
check("no unmeasured row is green", empty.some((r) => r.tone === "ok"), false);

// AN ABSENT METRIC IS NO_DATA, NEVER 0. Six of the ten carry a number and every
// one of them has to render the absence rather than a plausible zero.
const blank = preconditionRows(
  { runsToday: Number.NaN, runsFailedToday: Number.NaN, phaseInFlight: undefined,
    approvals: Number.NaN, workerLanes: Number.NaN, windmillDb: Number.NaN,
    mirrorAge: Number.NaN, checkoutDirty: Number.NaN, publishConfigured: Number.NaN,
    leaked: Number.NaN },
  checksById,
);
check("absent numbers render as absent, not as zero",
  ["agents.approvals_pending", "agents.worker_lanes", "agents.windmill_db_size",
   "agents.mirror_fresh", "agents.checkout_drift", "agents.publish_configured",
   "agents.runners_leaked"]
    .map((id) => blank.find((r) => r.id === id).value),
  [fmt.NO_DATA, fmt.NO_DATA, fmt.NO_DATA, fmt.NO_DATA, fmt.NO_DATA, fmt.NO_DATA, fmt.NO_DATA]);

// THE TALLY IS OFF THE ROW'S OWN TONE, so the sentence in the band head cannot
// disagree with the rail the reader is looking at. `note` and unmeasured both
// count as not passing, which is FindingsPanel's rule and the right one:
// absence is not a pass.
check("the tally counts the rows", preconditionTally(pre).total, 10);
check("a note is not a pass",
  preconditionTally(preconditionRows(M, checksById)).notPassing,
  pre.filter((r) => r.tone !== "ok").length);
check("nothing measured is nothing passing", preconditionTally(empty).notPassing, 10);
check("...and the total is unchanged", preconditionTally(empty).total, 10);

// EVERY ID IS ONE bin/verify-host.sh ACTUALLY EMITS, asserted against the
// battery rather than against a second list here. An id that does not resolve
// renders grey and "not measured" for ever, silently - which is the failure
// this repository names most often, and the one a fixture cannot catch because
// the fixture would be the thing that had drifted.
const battery = await readFile(new URL("../../../bin/verify-host.sh", import.meta.url), "utf8")
  .catch(() => null);
if (battery === null) {
  console.log("SKIP  bin/verify-host.sh is not readable from here");
} else {
  const emitted = new Set(
    [...battery.matchAll(/\b(?:ok|warn|fail|note) (agents\.[a-z_]+)/g)].map((mm) => mm[1]),
  );
  check("every precondition id is a check the battery emits",
    PRECONDITION_IDS.filter((id) => !emitted.has(id)), []);
}


// --- the CI lanes, as /ci draws them -----------------------------------------
//
// THE FIRST CI LOGIC THIS SCRIPT HAS EVER CALLED. /ci is the only page the CI
// fleet is visible from - a lane leaves no failed unit, no unhealthy container
// and no container series anywhere - and every decision on it was a computed in
// a .vue file until 2026-09-07. One of them had been wrong the whole time, and
// it is the same one that was wrong on /agents/fleet: the containment tone was
// hand-rolled as `status === 'pass' ? 'ok' : 'warn'`, so a FAILING containment
// check drew amber on the page somebody opens after CiContainmentLost has gone
// off. No fixture could catch it, because the ci section's own charter is warn
// or note and it has never carried a `fail` - which is why the assertion below
// builds one by hand.

console.log("\n-- the CI page's own derivations --");

const laneRow = (over = {}) => ({
  lane: "1", tone: "ok", state: "idle", inFlight: 0, jobsToday: 4, ...over,
});

// THE FOUR STATES OF THE HEADLINE, and the last two are the ones that needed
// writing. fmt.number(NaN) is "-", so the obvious spelling renders "- jobs
// today": a headline claiming a dash ran.
{
  const busy = laneRow({ lane: "1", inFlight: 1, jobsToday: 7 });
  const warn = laneRow({ lane: "2", tone: "warn", state: "mint failing", jobsToday: 4 });

  check("the lead sums the lanes", laneLead([busy, warn], 1).text, "11 jobs today");
  check("...and breathes while one is running", laneLead([busy, warn], 1).live, true);
  check("...naming which", laneLead([busy, warn], 1).sub,
    "1 healthy / 1 degraded - lane 1 running a job");
  check("nothing running says so", laneLead([warn], 1).sub, "1 degraded - nothing running");
  check("one job is singular", laneLead([laneRow({ jobsToday: 1 })], 1).text, "1 job today");

  // A HOST WITH CI SWITCHED OFF IS NOT A BROKEN ONE, and every ci check reports
  // it as a note rather than a finding.
  check("no marker anywhere is its own sentence", laneLead([], 0).text, "CI is not enabled here");
  check("...and it is grey", laneLead([], 0).tone, "off");

  // DIFFERENT FACT: a marker exists and the counter behind it does not.
  const unread = laneRow({ jobsToday: Number.NaN });
  check("a marker with no counter is not measured", laneLead([unread], 1).text, "not measured");
  check("...which is not the same sentence", laneLead([unread], 1).sub,
    "no lane reported a job count in the last scrape");

  // ONE LANE NOT REPORTING MUST NOT ZERO THE SUM, and must not be counted as a
  // lane that ran nothing.
  check("an absent counter is skipped, not added as zero",
    laneLead([laneRow({ jobsToday: 9 }), unread], 1).text, "9 jobs today");

  // THE TONE IS THE WORST LANE'S, NOT THE COUNTER'S. A number of jobs is never
  // itself a fault; a lane that has stopped reporting is.
  check("a healthy fleet is green", laneLead([busy], 1).tone, "ok");
  check("a lane that never started drags it grey",
    laneLead([busy, laneRow({ lane: "3", tone: "off", inFlight: undefined })], 1).tone, "off");
  check("...and a failing one drags it red",
    laneLead([busy, laneRow({ lane: "3", tone: "fail" })], 1).tone, "fail");
  check("grey outranks amber, because nobody is looking",
    laneLead([laneRow({ tone: "warn" }), laneRow({ lane: "2", tone: "off" })], 1).tone, "off");
}

// THE TALLY IS THE BAND'S ASIDE, and an aside that renders nothing looks like a
// band that forgot to say anything.
check("an empty rack still says something", laneTally([]), "no lanes");
check("the tally ends on the worst", laneTally([
  laneRow({ tone: "off" }), laneRow({ tone: "ok" }), laneRow({ tone: "warn" }),
]), "1 healthy / 1 degraded / 1 never started");

// A LANE THE BATTERY COUNTS THAT THE TABLE CANNOT DRAW. The rack is the union of
// the marker series, so a driver that never got far enough to write one appears
// nowhere - and it is the lane most worth seeing.
check("an enabled lane with no marker is counted", silentLanes(2, 3, 0), 1);
check("...a failed one too", silentLanes(2, 2, 1), 1);
check("a full rack is silent about nothing", silentLanes(3, 3, 0), 0);
// NEITHER HALF MAY DEFAULT TO ZERO: both facts are written as "" on a host with
// no lanes, which becomes null and is dropped, so an absent count read as 0
// would turn every drawn lane into a phantom surplus.
check("an unread count claims nothing", silentLanes(3, Number.NaN, 0), 0);
check("...in either half", silentLanes(3, 3, Number.NaN), 0);
check("more markers than units is not negative", silentLanes(4, 3, 0), 0);

// --- the host-side table -----------------------------------------------------

const ciChecks = new Map(statusDocument().checks.map((c) => [c.id, c]));

const F = {
  lanesActive: 2, lanesFailed: 1, versionAge: 3, imageAge: 19, toolcache: 1,
  baselines: 0, runsBytes: 3400 * 1024 * 1024, unlimited: 0, networks: 3, strays: 0,
  runtimeSplit: "0", rootLabel: "container_file_t",
};

const hrows = hostRows(F, ciChecks);

check("the ids are the exported set", hrows.map((r) => r.id), HOST_IDS);
check("nine rows", hrows.length, 9);

// THE FIVE PER-LANE CHECKS ARE DELIBERATELY ABSENT. They are cross-lane
// summaries of the table two bands up, where the same numbers are drawn per lane
// with a bar behind them, and a second table restating them is the duplication
// this whole page was rewritten to remove.
check("the per-lane checks are not restated here",
  ["ci.heartbeat", "ci.job_stuck", "ci.lane_disk", "ci.lane_headroom", "ci.lane_store"]
    .filter((id) => HOST_IDS.includes(id)), []);

// A MISSING ROW MUST BE A NAMED FAILURE, NOT A TypeError. An id that drifts
// used to throw here and take the battery assertion below - the one that would
// have named the drift - with it, so the run reported a crash rather than the
// finding.
const hostRow = (id) => hrows.find((r) => r.id === id) ?? { value: null, tone: null };

check("a string fact is readable", hostRow("ci.fleet_root_label").value, "container_file_t");
check("...and 0 means one directory, not none", hostRow("ci.runtime_dir").value, "one directory");
check("a bounded slice says so", hostRow("ci.slice_limits").value, "bounded");
check("networks and strays read together", hostRow("ci.runner_isolation").value, "3 networks, 0 stray");
check("a failed lane is named beside the active count",
  hostRow("ci.lanes_alive").value, "2 active, 1 failed");
check("zero baselines is a reading, not a blank", hostRow("ci.artifact_store").value, "0 baselines");

// GREY IS NEVER GREEN. Every value absent, every tone off, and not one zero.
{
  const empty = hostRows(null, new Map());
  check("nothing measured is nothing readable",
    [...new Set(empty.map((r) => r.value))], [fmt.NO_DATA]);
  check("...and nothing green", [...new Set(empty.map((r) => r.tone))], ["off"]);
  check("nothing measured is nothing passing", hostTally(empty).notPassing, 9);
  check("...and the total is unchanged", hostTally(empty).total, 9);
}

// THE ASSERTION THIS FILE EXISTS FOR. The old page mapped every non-pass to
// amber, so `fail` - which ci.lane_headroom and ci.runtime_dir both reach - drew
// as a warning on the page CiContainmentLost sends somebody to, and `note`,
// which means the check could not run, borrowed the colour of a measured one.
{
  const graded = (status) =>
    hostRows(F, new Map([["ci.slice_limits", { id: "ci.slice_limits", status, message: "x" }]]))
      .find((r) => r.id === "ci.slice_limits").tone;
  check("a failing containment check is red, not amber", graded("fail"), "fail");
  check("a warning is amber", graded("warn"), "warn");
  check("a note is grey, not amber", graded("note"), "off");
  check("a pass is green", graded("pass"), "ok");
}

// EVERY ID IS ONE bin/verify-host.sh ACTUALLY EMITS, on the same argument as the
// agents block above. `bad` is included where that one does not need it: it is
// the battery's fail emitter, and two ci checks reach it.
if (battery === null) {
  console.log("SKIP  bin/verify-host.sh is not readable from here");
} else {
  const emittedCi = new Set(
    [...battery.matchAll(/\b(?:ok|warn|fail|bad|note) (ci\.[a-z_]+)/g)].map((mm) => mm[1]),
  );
  check("every host-side id is a check the battery emits",
    HOST_IDS.filter((id) => !emittedCi.has(id)), []);
}

// --- how a series is drawn, and what the legend copies ----------------------
// charts.ts had never been loaded here: the drawing is a computed in a .vue
// file, which this harness structurally cannot reach, so the legend disagreed
// with the lines for as long as it existed on a chart that was not a stack.
// seriesStyle is the one derivation both now call, and it is a plain module.
{
  const chart = { tone: "warn" };

  check("a series' own tone beats the chart's",
    seriesStyle({ points: [], tone: "fail" }, 0, chart).fill, "var(--fail)");
  check("...and the chart's is the fallback",
    seriesStyle({ points: [] }, 0, chart).fill, "var(--warn)");
  check("no tone anywhere is ok, not a crash",
    seriesStyle(undefined, 0, {}).fill, "var(--ok)");

  const ramp = [0, 1, 2, 3, 4].map((i) => seriesStyle({ points: [] }, i, {}).opacity);
  check("the line ramp separates without ranking", ramp.slice(0, 3), [1, 0.7, 0.5]);
  check("...and floors, so a fourth line needs the legend", ramp.slice(3), [0.5, 0.5]);

  // A per-series tone is NOT drawn on a stack - bands are one tone at five
  // brightnesses - so the key must not invent one either.
  const band = seriesStyle({ points: [], tone: "fail" }, 1, { ...chart, stacked: true });
  check("a stack ignores the series tone, as the drawing does", band.fill, "var(--warn)");
  check("...and takes the band ramp", band.opacity, bandOpacity(1));

  check("a mirrored pair is separated by position, not brightness",
    seriesStyle({ points: [] }, 1, { mirror: true }).opacity, 1);
  check("an explicit opacity outranks the ramp",
    seriesStyle({ points: [], opacity: 0.25 }, 1, {}).opacity, 0.25);
  check("...and the mirror",
    seriesStyle({ points: [], opacity: 0.25 }, 1, { mirror: true }).opacity, 0.25);

  // --- the ceiling nothing labelled ----------------------------------------
  //
  // A PINNED CHART WHOSE CEILING IS NOT ON THE LADDER HAD NO TOP LABEL, and its
  // data was welded to that unnamed edge. This host reports MemTotal as
  // 15.46 GiB, the binary ladder resolves to a 4 GiB step, so the gutter said
  // 0/4/8/12 and the stack filled to a number the axis never named. Invisible in
  // every screenshot because the fixture's MemTotal was a round 16 GiB - the
  // numeric spelling of a fixture that cannot contradict its consumer.
  {
    const GiB = 2 ** 30;
    const frameFor = (max) => ({ width: 900, height: 132, extent: { min: 0, max } });

    const real = frameFor(15.46 * GiB);
    const plain = yTicks(real, 4, 1024);
    check("the ladder stops below a ceiling it cannot reach",
      Math.max(...plain.map((t) => t.value)) < real.extent.max, true);

    const withTop = ceilingTick(plain, real, real.extent.max);
    check("the ceiling gets a label of its own", withTop.length, plain.length + 1);
    check("...at the value the frame is actually pinned to", withTop.at(-1).value, real.extent.max);
    check("...on the top edge, where .y-tick.top shifts it inward", withTop.at(-1).edge, "top");

    // A ROUND CEILING IS ALREADY ON THE LADDER and must not be labelled twice.
    const round = frameFor(16 * GiB);
    const roundTicks = yTicks(round, 4, 1024);
    check("a ceiling the ladder already reached gains nothing",
      ceilingTick(roundTicks, round, round.extent.max).length, roundTicks.length);
    check("...which is why the 16 GiB fixture could not show this",
      Math.max(...roundTicks.map((t) => t.value)), round.extent.max);

    // Two rungs cannot share a label slot.
    const near = frameFor(12.4 * GiB);
    check("a ceiling just above the top tick is left alone",
      ceilingTick(yTicks(near, 4, 1024), near, near.extent.max).length, yTicks(near, 4, 1024).length);

    // A PADDED EXTENT'S TOP IS HEADROOM, NOT A CEILING. Naming it would label
    // the 8% pad as if it were a fact about the machine.
    check("no fixed max, no ceiling label",
      ceilingTick(plain, real, undefined).length, plain.length);
    check("...and a non-finite one is absent, not a ceiling of NaN",
      ceilingTick(plain, real, Number.NaN).length, plain.length);
  }

  // --- the mirror's zero ----------------------------------------------------
  //
  // symmetricExtent GIVES EVERY TICK A TWIN AND tickLabel STRIPS THE SIGN, so a
  // mirrored gutter printed "4.0 MB/s" at the top and "4.0 MB/s" at the bottom
  // with nothing between them - two identical strings and no anchor, on an axis
  // whose whole claim is that it runs in two directions. The zero tick used to
  // be filtered out on the grounds that "the zero rule labels itself"; a rule is
  // not a label.
  {
    const ext = symmetricExtent([{ points: [[0, 8e6]], direction: "up" }], {});
    const frame = { width: 900, height: 132, extent: ext };
    const ticks = yTicks(frame, 4, 1024);
    check("a mirrored axis really is symmetric about zero",
      Math.round(ext.min + ext.max), 0);
    check("...so its labels come in identical pairs",
      ticks.filter((t) => t.value > 0).length, ticks.filter((t) => t.value < 0).length);
    check("...and the zero that anchors them is a tick the axis has",
      ticks.some((t) => t.value === 0), true);
  }
}

// --- two things about MetricChart that only its source can answer ------------
// Neither is reachable through a module: one is a template's paint order and the
// other is a media query. Both were wrong, and both were invisible at the width
// every screenshot was taken at.
{
  const chart = await readFile(new URL("../src/components/MetricChart.vue", import.meta.url), "utf8");

  // A 5%-WHITE HAIRLINE UNDER FOUR FILLS IS NOT A GRIDLINE. The rules were
  // emitted before the stack, so the memory chart drew four y labels pointing at
  // nothing while the CPU chart beside it was fine - a line cannot cover a
  // hairline the way a fill does.
  const stackOpen = chart.indexOf('<g v-if="stacked">');
  const stackClose = chart.indexOf("</g>", stackOpen);
  const stackBlock = chart.slice(stackOpen, stackClose);
  check("the stack draws its bands before the rules that cross them",
    stackBlock.indexOf("bandDraw") < stackBlock.indexOf("v-for=\"y in rules\""), true);
  check("...and the line charts still draw theirs underneath",
    chart.indexOf('<g v-if="!stacked">') < stackOpen, true);

  // THE MIRROR'S ZERO LABEL IS KEPT NOW. The filter that removed it is gone.
  check("nothing filters the zero tick out of a mirrored gutter",
    /filter\(\(t\) => t\.value !== 0\)/.test(chart), false);
  check("...though its duplicate RULE is still suppressed",
    /props\.mirror && t\.value === 0/.test(chart), true);
}


// --- the host, as /system draws it -------------------------------------------
//
// THE FIFTH AND LAST PAGE TO HAVE ITS DECISIONS EXTRACTED, on 2026-09-07. Four
// of them had a wrong answer that rendered perfectly, and three could not be
// seen from a screenshot at any width:
//
//   - fsTone answered "ok" for a ratio that is not a number
//   - smartLine answered "the drive is failing", in red, for a drive with no
//     health series at all
//   - both pressure lanes carried tone: "warn" as a literal, so they were amber
//     at every value - LANE_TONES on /ci, one page over, fixed the day before
//   - the page read a fact key the battery stopped emitting
{
  console.log("\n-- the system page's own derivations --");

  const M = {
    cpuBusy: 0.304,
    cpuStalled: 0.068,
    load1: 4.2,
    // BASE 1024, because fmt.bytes is: 10.3e9 renders "9.6 GB", which is the
    // rounding artefact charts.ts already refuses on a byte axis.
    memUsed: 10.3 * 2 ** 30,
    memTotal: 15.8 * 2 ** 30,
    swapUsed: 1.4 * 2 ** 30,
    swapTotal: 4 * 2 ** 30,
    fullest: { mountpoint: "/var/mnt/media", ratio: 0.91, free: 3.2 * 2 ** 40 },
    mounts: 3,
  };

  const condFor = (id, m = M) =>
    sys.conditionRows(m).find((c) => c.id === id) ?? { value: null, sub: null, tone: null };

  check("the conditions are the exported set", sys.conditionRows(M).map((c) => c.id), sys.CONDITION_IDS);

  // LOAD IS DRAWN NOW. It was one of four SYSTEM queries with no consumer at all,
  // and it is the one that catches what cpuBusy cannot: a host stalled on IO has
  // every core idle waiting, so utilisation reads low while load climbs.
  check("the cpu condition reads busy", condFor("cpu").value, "30.4% busy");
  check("...and names load and the stall it is graded on", condFor("cpu").sub, "load 4.20, 6.8% stalled");
  check("the memory condition is bytes, not a ratio", condFor("memory").value, "10.3 GB of 15.8 GB");
  check("the storage condition names WHICH mount", condFor("storage").value, "91% /var/mnt/media");

  // PRESSURE, NOT UTILISATION. queries.ts: pressure is what was pinned when the
  // host wedged while still answering ICMP, and a single pinned core is ordinary
  // here - both long CI jobs are single-threaded.
  check("an idle host's cpu condition is green", condFor("cpu", { ...M, cpuStalled: 0.01 }).tone, "ok");
  check("a stalled one is amber", condFor("cpu", { ...M, cpuStalled: 0.15 }).tone, "warn");
  check("a badly stalled one is red", condFor("cpu", { ...M, cpuStalled: 0.4 }).tone, "fail");
  check("a 91% media disk is amber", condFor("storage").tone, "warn");

  // A HOST WITH NO SWAP DEVICE GETS A SENTENCE, not "swap - of -". Same rule as
  // the headline's fourth state one block down.
  check("no swap device says so", condFor("memory", { ...M, swapTotal: 0 }).sub, "no swap device");

  // GREY IS NEVER GREEN. Every condition off a null reading must be grey, and
  // none of them may report a zero.
  {
    const none = sys.conditionRows(null);
    check("every condition off nothing is grey", [...new Set(none.map((c) => c.tone))], ["off"]);
    check("...and none of them reports a number", none.filter((c) => /\d/.test(c.value)).map((c) => c.id), []);
  }

  // --- the headline, and its four states ---------------------------------------
  const R = {
    uptimeS: 41 * 86400 + 6 * 3600,
    booted: "44.20260810.3.0",
    next: null,
    nextFinalized: null,
  };
  const conds = sys.conditionRows(M);

  check("the headline is the uptime", sys.hostLead(R, conds).text, "up 41d 06h");
  // THE TONE IS THE WORST CONDITION'S, NEVER THE NUMBER'S. A count of days is not
  // itself a fault and a full disk is - /ci's rule, verbatim.
  check("...and takes the worst condition's tone", sys.hostLead(R, conds).tone, "warn");
  check("...never the counter's", sys.hostLead(R, sys.conditionRows({ ...M, fullest: null, cpuStalled: 0 })).tone, "off");
  check("...and never breathes: there is no denominator for uptime", sys.hostLead(R, conds).live, false);
  check("nothing staged says so", sys.hostLead(R, conds).sub, "44.20260810.3.0, nothing staged");

  // `next_finalized` IS THE DISCRIMINATOR THE OLD KEY COULD NOT EXPRESS: a
  // deployment that is staged but not finalized has not written its loader entry.
  check("a staged deployment is named",
    sys.hostLead({ ...R, next: "44.20260817.3.2" }, conds).sub,
    "44.20260817.3.2 staged, not finalized yet");
  check("...and a finalized one says the window applies it",
    sys.hostLead({ ...R, next: "44.20260817.3.2", nextFinalized: "2026-09-07T01:00:00Z" }, conds).sub,
    "44.20260817.3.2 staged and finalized, the Sunday window applies it");

  // THE FOURTH STATE IS THE ONE THAT NEEDED WRITING. fmt.duration(NaN) is "-", so
  // the obvious spelling renders "up -" at the largest type on the page: a
  // headline claiming a dash was measured.
  check("an unmeasured uptime is a sentence, not a dash",
    sys.hostLead({ ...R, uptimeS: Number.NaN }, conds).text, "uptime not measured");
  check("...and it is grey", sys.hostLead({ ...R, uptimeS: Number.NaN }, conds).tone, "off");
  check("no facts at all is a different fact", sys.hostLead(null, conds).text, "host unknown");
  check("...and neither reading is ever `up -`",
    [sys.hostLead(null, conds), sys.hostLead({ ...R, uptimeS: Number.NaN }, conds)]
      .filter((l) => l.text.includes("-")).length, 0);

  // --- absence is grey, in both directions -------------------------------------
  //
  // TWO FUNCTIONS FOUR LINES APART DISAGREED ABOUT WHAT ABSENCE MEANS, and
  // backupTone between them had the right answer the whole time.
  check("a mount that could not be measured is grey", sys.fsTone(Number.NaN), "off");
  check("...and is not green", sys.fsTone(Number.NaN) === "ok", false);
  check("a full mount is still red", sys.fsTone(0.96), "fail");
  check("a healthy one is still green", sys.fsTone(0.4), "ok");

  const drive = { device: "sdb", model: "x", healthy: true, temp: 36, hours: 10,
    wear: Number.NaN, realloc: 0, pending: 0, mediaErrors: 0 };
  check("a drive with no SMART verdict is grey", sys.smartLine({ ...drive, healthy: null }).tone, "off");
  check("...and does not claim it is failing",
    sys.smartLine({ ...drive, healthy: null }).text.includes("failing"), false);
  check("a drive that IS failing still says so", sys.smartLine({ ...drive, healthy: false }).tone, "fail");

  // MEDIA ERRORS ARE THE NVMe COUNTER AND WERE NEVER READ. Reallocated and
  // pending sectors are ATA concepts, so the old fallback sentence was true and
  // silent about the one number that matters on an NVMe.
  check("media errors are read", sys.smartLine({ ...drive, mediaErrors: 3 }).text, "3 media error(s)");
  check("...and the clean sentence now covers them",
    sys.smartLine(drive).text, "no reallocated, pending or media errors");
  check("a backup nobody has ever run is grey", sys.backupTone(Number.NaN, 100), "off");

  // --- the lanes, and the hue that was identity --------------------------------
  const [gpuLane, ioLane] = sys.LANES;
  check("a saturated encoder is not a fault", sys.laneTone(gpuLane, [1, 0]), "ok");
  check("a stalled disk is", sys.laneTone(ioLane, [0.16]), "warn");
  check("...and an idle one is not", sys.laneTone(ioLane, [0.01]), "ok");
  check("a lane with no series is grey, not idle", sys.laneTone(ioLane, []), "off");
  // THE WORST CARD, not the first: this host's gpu0 has dead video engines and
  // reads 0% for ever, so taking the first would answer for the idle card - the
  // same failure splitBy exists to prevent.
  check("the worst card decides", sys.laneTone(ioLane, [0.01, 0.4]), "fail");
  check("both cards are read", sys.laneReading(gpuLane, [0, 0.97]), "0% / 97%");
  check("no card at all is a dash", sys.laneReading(gpuLane, []), "-");
  check("the busiest thread is the max, not the mean", sys.busiestCore([0.08, 0.93, 0.11]), 0.93);
  check("...and no thread at all is not zero", Number.isNaN(sys.busiestCore([])), true);

  // An alert that began before the window is pinned to the left edge rather than
  // dropped: "has been firing since before this view" is worth seeing.
  {
    const mk = (startsAt) => ({ labels: { alertname: "X", severity: "warning" }, startsAt });
    const marks = sys.eventMarks([mk("2026-09-07T00:00:00Z")], Date.parse("2026-09-07T06:00:00Z") / 1000,
      Date.parse("2026-09-07T12:00:00Z") / 1000);
    check("an alert older than the window pins to the edge", marks[0].left, "0.00%");
    check("...and says so", marks[0].before, true);
    check("a window with no extent draws nothing", sys.eventMarks([mk("2026-09-07T00:00:00Z")], Number.NaN, 1), []);
  }

  // --- the fact keys, against the battery that writes them ---------------------
  //
  // THIS ASSERTION FAILED THE MOMENT IT WAS WRITTEN, which is why it exists. The
  // page read `staged_version`; bin/verify-host.sh renamed that key to
  // `next_version` and its own comment says which reader it meant - "A consumer
  // keying on staged_version wants this." Nobody updated the consumer, so the
  // amber staged chip was dead on the live host and perfect in every screenshot:
  // fixtures/model.ts emitted the old key, because a fixture written from its
  // consumer cannot contradict the consumer.
  //
  // THE BACKUP KEYS ARE BUILT BY CONCATENATION - `fact "backup_$key"` - so a grep
  // for a literal cannot see them. That is the trap lint-repo.sh leg 9 already
  // paid for, and the answer is the same: match the prefix from the call that
  // mints it, never a literal list maintained here.
  if (battery === null) {
    console.log("SKIP  bin/verify-host.sh is not readable from here");
  } else {
    const facts = new Set([...battery.matchAll(/^\s*fact\s+([a-z_0-9]+)/gm)].map((mm) => mm[1]));
    for (const mm of battery.matchAll(/check_backup_age\s+\S+\s+"[^"]*"\s+([a-z_0-9]+)/g)) {
      facts.add(`backup_${mm[1]}`);
    }
    check("the battery extraction found the dynamic backup keys too", facts.has("backup_local_at"), true);
    check("every fact key this page reads is one the battery emits",
      sys.FACT_KEYS.filter((k) => !facts.has(k)), []);
  }

  // --- the two leads the split added ---------------------------------------
  //
  // /system BECAME THREE VIEWS, AND SIBLING VIEWS LEAD WITH ONE READING EACH.
  // hostLead already had four states and a test for each; these two are new and
  // can make the identical mistake it was written for - fmt.percent(NaN) is "-",
  // so the obvious spelling headlines "- busy" the way the first draft of the
  // uptime one headlined "up -".

  const LANE_OK = ["ok", "ok", "ok"];

  check("the load lead reads the aggregate", sys.loadLead(M, 12, 0.93, LANE_OK).text, "30.4% busy");
  check("...and names the thread the aggregate hides",
    sys.loadLead(M, 12, 0.93, LANE_OK).sub, "12 threads, busiest 93%, load 4.20");

  // THE READING IS ONE SERIES AND THE TONE IS THE WHOLE VIEW. A saturated
  // encoder beside a 12%-busy aggregate is the case: grading the headline on its
  // own number would draw teal over a machine that cannot take more work.
  check("a quiet host with quiet lanes is green", sys.loadLead(M, 12, 0.93, LANE_OK).tone, "ok");
  check("...and one bad lane outranks the number beside it",
    sys.loadLead({ ...M, cpuStalled: 0.01 }, 12, 0.93, ["ok", "fail", "ok"]).tone, "fail");
  check("...as does the cpu condition, with no lane saying anything",
    sys.loadLead({ ...M, cpuStalled: 0.4 }, 12, 0.93, LANE_OK).tone, "fail");

  // ABSENCE IS A SENTENCE, NEVER A DASH AT --t-mono-xl.
  check("no window at all is not a dash", sys.loadLead(null, 0, Number.NaN, []).text, "load not measured");
  check("...and it is grey", sys.loadLead(null, 0, Number.NaN, []).tone, "off");
  check("an unanswered cpu series is the same",
    sys.loadLead({ ...M, cpuBusy: Number.NaN }, 12, 0.93, LANE_OK).text, "load not measured");
  check("a host whose threads did not resolve still leads",
    sys.loadLead(M, 0, Number.NaN, LANE_OK).sub,
    "thread count unknown, busiest thread unknown, load 4.20");

  const MOUNTS = [
    sys.mountReading("/boot", 350 * 2 ** 20, 171 * 2 ** 20),
    sys.mountReading("/var/mnt/media", 36 * 2 ** 40, 3.2 * 2 ** 40),
  ];
  const DRIVE_OK = { device: "nvme0", model: "", healthy: true, temp: 45, hours: 1,
                     wear: 0.04, realloc: 0, pending: 0, mediaErrors: 0 };

  check("the storage lead is the fullest mount",
    sys.storageLead(MOUNTS, [DRIVE_OK], ["ok"]).text, "91% /var/mnt/media");
  check("...and its sub counts what it is speaking for",
    sys.storageLead(MOUNTS, [DRIVE_OK], ["ok"]).sub,
    "3.2 TB free of 36.0 TB, 2 mounts, 1 drive");

  // A HALF-EMPTY DISK THAT IS DYING MUST NOT READ TEAL. Three sources of the one
  // tone, and the headline takes the worst of all three.
  check("a fullest mount at 91% is amber", sys.storageLead(MOUNTS, [DRIVE_OK], ["ok"]).tone, "warn");
  check("a failing drive outranks a roomy disk",
    sys.storageLead([sys.mountReading("/", 100, 90)], [{ ...DRIVE_OK, healthy: false }], ["ok"]).tone,
    "fail");
  check("...and so does a backup that stopped running",
    sys.storageLead([sys.mountReading("/", 100, 90)], [DRIVE_OK], ["ok", "fail"]).tone, "fail");
  check("an empty roomy host is green", sys.storageLead([sys.mountReading("/", 100, 90)], [DRIVE_OK], ["ok"]).tone, "ok");

  check("no filesystem at all says so", sys.storageLead([], [], []).text, "no filesystem reported");
  check("...and is grey", sys.storageLead([], [], []).tone, "off");

  // MOUNTS THAT ANSWERED WITH UNUSABLE NUMBERS ARE A DIFFERENT FACT from none
  // answering, and neither is an empty disk.
  const UNREADABLE = [sys.mountReading("/var/lib/containers", 233 * 2 ** 30, Number.NaN)];
  check("a mount with no free figure is not a full one", sys.storageLead(UNREADABLE, [], []).text,
    "storage not measured");
  check("...and it does not win the fullest comparison", sys.fullestMount(UNREADABLE), null);
  check("...nor is its ratio a number", Number.isFinite(UNREADABLE[0].ratio), false);
  check("a mount of size zero is unreadable, not empty",
    Number.isFinite(sys.mountReading("/x", 0, 0).ratio), false);

  // --- the axis every chart in the application shares -----------------------
  //
  // MetricChart hides `.x-tick:nth-child(even)` below 640px, under a comment
  // promising it "leaves first and last - the two that anchor the axis - in
  // place". THAT HELD ONLY FOR AN ODD COUNT: with four ticks it hides the 2nd
  // and the 4th, and the 4th is the last. The CSS carries :not(.last) now, and
  // this asserts the property that made an even count a trap so a future call
  // site cannot reintroduce it silently.
  {
    const chart = await readFile(new URL("../src/components/MetricChart.vue", import.meta.url), "utf8");
    check("the phone rule spares the last tick whatever the count",
      /\.x-tick:nth-child\(even\):not\(\.last\)/.test(chart), true);

    const kept = (count) =>
      Array.from({ length: count }, (_, i) => i + 1).filter((nth) => nth % 2 !== 0 || nth === count);
    check("an odd count keeps first, middle and last", kept(5), [1, 3, 5]);
    check("an even count keeps its last one too", kept(4), [1, 3, 4]);
    check("...which the old rule did not", Array.from({ length: 4 }, (_, i) => i + 1).filter((nth) => nth % 2 !== 0),
      [1, 3]);
  }
}

await server.close();
console.log(`\n${failures === 0 ? "all checks passed" : `${failures} FAILED`}`);

process.exit(failures === 0 ? 0 : 1);
