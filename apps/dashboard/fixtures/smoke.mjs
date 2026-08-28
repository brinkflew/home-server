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
const {
  roundState,
  roundAction,
  roundBranch,
  roundError,
  roundProgress,
  roundEtaAt,
  isSettled,
  byUrgency,
} = await load("/src/fleet.ts");
const { holdExpiresIn, intakeState, intakeSwitch, roundControls, HOLD_TIMEOUT_S } =
  await load("/src/control.ts");
const fmt = await load("/src/format.ts");
const { control } = await load("/src/api/control.ts");

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

const by = (id) => fleet.rounds.find((r) => r.worktree_id === id);

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
  roundProgress(by("wt-9f21c4")), 0.8);
check("a round that has finished nothing is zero", roundProgress(by("wt-77d3e0")), 0);
check("every phase done is one", roundProgress(by("wt-3311cd")), 1);

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
// refuses. So the chip must be disabled and the attempt line hidden - never a
// guessed link, and never "attempt 1 of 2" about something unknown.
check("a round with no task id has no tracker link", by("wt-hist01").odoo_url, null);
check("...and no attempt number", by("wt-hist01").attempts, null);
check("...and still renders a state", roundState(by("wt-hist01")).state, "stopped");
check("...whose action falls back to nothing clickable",
  roundAction(by("wt-hist01")).href, null);

// ONE ROW PER ATTEMPT is the whole point: a failed first attempt keeps its own
// cost and its own failure instead of collapsing into "attempt 2 of 2".
const attempts1601 = fleet.rounds
  .filter((r) => r.odoo_task === 1601)
  .map((r) => r.attempts)
  .sort();
check("two attempts at one task are two rows", attempts1601, [1, 2]);
check("...and each carries its own cost",
  new Set(fleet.rounds.filter((r) => r.odoo_task === 1601).map((r) => r.cost_usd)).size, 2);

console.log("\n-- what a person may ask the fleet to do --");

const ctl = fleet.control;
const nowUnix = Date.now() / 1000;
const open = by("wt-4ab810");
const closed = by("wt-2c44b1");

// A CONTROL THAT COULD NEVER APPLY IS NOISE ON EVERY CLOSED ROW. Holding a
// finished round stops nothing, and restarting one has no chain for conduct to
// close - it would be a second, less careful way to start a round.
check("a finished round offers nothing", roundControls(closed, ctl, nowUnix).length, 0);
check("a round in flight offers two things",
  roundControls(open, ctl, nowUnix).map((c) => c.action), ["hold", "restart"]);

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
// to distrust the other chips. Two restarts close together are two flows on one
// worktree, which is the hazard the floor exists for.
const fresh = { ...open, started_at: new Date(Date.now() - 30_000).toISOString() };
const restart = roundControls(fresh, ctl, nowUnix).find((c) => c.action === "restart");
check("a restart inside conduct's floor is not offered", restart.disabled !== null, true);
check("...and the hold beside it still is",
  roundControls(fresh, ctl, nowUnix)[0].disabled, null);

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

console.log("\n-- the board puts what needs acting on at the top --");

const ordered = [...fleet.rounds].sort(byUrgency).map((r) => r.worktree_id);
check("a person's answer comes first", ordered[0], "wt-9f21c4");
check("no finished round outranks a live one",
  ordered.slice(0, 3).every((id) => by(id).closed_at === null), true);

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

globalThis.fetch = realFetch;

await server.close();
console.log(`\n${failures === 0 ? "all checks passed" : `${failures} FAILED`}`);

process.exit(failures === 0 ? 0 : 1);
