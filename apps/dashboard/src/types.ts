// =============================================================================
// The five wire formats this dashboard reads
// -----------------------------------------------------------------------------
// Every one of them is somebody else's contract, so these types are a
// transcription rather than a design. bin/verify-host.sh owns status.json,
// Prometheus owns its own API, and bin/collect-metrics.py owns activity.json,
// library.json and fleet.json.
//
// THE ONE RULE THAT MATTERS, from CLAUDE.md: "Every finding is keyed by a
// STABLE ID, and the prose is not stable." Key on `id`. Never parse `message`,
// never switch on it, never assume its wording - it gets reworded whenever it
// turns out to be wrong, and that must cost nothing.
//
// THE THREE DOCUMENTS ARE NOT SERIES AND MUST NEVER BECOME THEM. They carry
// titles, users and devices, which cannot be Prometheus labels - the collector
// refuses to label a session that way because a 400-day record of who watched
// what is surveillance of the household rather than monitoring of a machine. A
// document is rewritten whole every run and keeps no history, which is the whole
// difference. Do not build anything here that retains one.
//
// fixtures/media.ts is typed against these interfaces, and tsconfig.node.json
// includes this file - so a fixture that drifts from the contract is a compile
// error rather than a panel that quietly renders nothing.
// =============================================================================

/**
 * The only four colours anything here may be, from the design brief: "Status has
 * three colors only: teal healthy, amber degraded, red failing. Everything else
 * is grey." `off` IS that grey and it is not a fourth status - it means nobody
 * measured, which must never be rendered as healthy.
 *
 * Declared here rather than per-page because five modules now need it.
 * StatusDot and MetricChart keep their own inline prop unions: those are
 * component contracts, and churning them buys nothing.
 */
export type Tone = "ok" | "warn" | "fail" | "off";

/** Ordered worst-last, so `Math.max` over the numeric rank is the verdict. */
export type CheckStatus = "pass" | "note" | "warn" | "fail";

/** Matches home_server_check_status: 0 pass, 1 note, 2 warn, 3 fail. */
export const STATUS_RANK: Record<CheckStatus, number> = {
  pass: 0,
  note: 1,
  warn: 2,
  fail: 3,
};

export const RANK_STATUS: CheckStatus[] = ["pass", "note", "warn", "fail"];

export interface Check {
  /** Section id, e.g. "backup". Matches Section.id. */
  section: string;
  /** Dotted and stable, e.g. "cdi.driver_match". The only thing to key on. */
  id: string;
  status: CheckStatus;
  /** Human prose. Display it; never depend on it. */
  message: string;
}

export interface Section {
  id: string;
  title: string;
  pass: number;
  fail: number;
  warn: number;
  note: number;
}

export interface StatusSummary {
  /** Precomputed with fail > warn > pass precedence. Colour on this. */
  status: "pass" | "warn" | "fail";
  pass: number;
  fail: number;
  warn: number;
  note: number;
  total: number;
}

/**
 * Flat snake_case, always present, `null` when not measured - so a key never
 * appears and disappears. Values are string, number, boolean or null; the
 * `*_at` ones are ISO 8601 UTC.
 */
export type Facts = Record<string, string | number | boolean | null>;

export interface StatusDocument {
  schema: number;
  /** ISO 8601 UTC. Authoritative: this is how old the whole document is. */
  generated_at: string;
  host: string;
  /**
   * Which optional batteries ran. `routes: false` means the route battery was
   * NOT walked - which must never be rendered as "every route passed".
   */
  mode: { routes: boolean };
  summary: StatusSummary;
  /** A section that did not run is ABSENT here, not zero-filled. */
  sections: Section[];
  checks: Check[];
  facts: Facts;
}

// -----------------------------------------------------------------------------
// Prometheus HTTP API
// -----------------------------------------------------------------------------

/** [unix seconds, value as a string]. The string is not a mistake - it is how
 *  Prometheus preserves NaN, +Inf and full float64 precision over JSON. */
export type Sample = [number, string];

export interface InstantSeries {
  metric: Record<string, string>;
  value: Sample;
}

export interface RangeSeries {
  metric: Record<string, string>;
  values: Sample[];
}

export interface PromResponse<T> {
  status: "success" | "error";
  data: { resultType: string; result: T };
  errorType?: string;
  error?: string;
}

// -----------------------------------------------------------------------------
// Alertmanager v2
// -----------------------------------------------------------------------------

export interface AmAlert {
  labels: Record<string, string>;
  annotations: Record<string, string>;
  startsAt: string;
  endsAt: string;
  updatedAt: string;
  status: { state: "active" | "suppressed" | "unprocessed"; silencedBy: string[]; inhibitedBy: string[] };
  generatorURL?: string;
  fingerprint?: string;
}

// -----------------------------------------------------------------------------
// activity.json and library.json, written by bin/collect-metrics.py
// -----------------------------------------------------------------------------

/** Every nullable field is PRESENT and null, never absent - same contract as
 *  `Facts`, so a key cannot appear and disappear between runs. */
export type MediaKind = "movie" | "series";

/**
 * The one vocabulary both documents and both pages speak. Wire values are
 * identifiers; the words a person reads live in STATE_LABEL, because a label
 * that is also a wire value gets parsed by somebody eventually.
 */
export const FILE_STATES = [
  "downloading",
  "transcoding",
  "importing",
  "seeding",
  "queued",
  "done",
  "stalled",
  "no_subtitles",
  "error",
] as const;
export type FileState = (typeof FILE_STATES)[number];

export type PlaybackMethod = "directplay" | "directstream" | "transcode";

/**
 * Per-upstream record of whether it answered THIS run. NOT OPTIONAL, and the
 * reason is the whole point: without it, "jellyseerr timed out" and "there are
 * no pending requests" are the same empty list, and a page rendering that as
 * "nothing to approve" is the failure this repository is written around. It is
 * `mode.routes: false` applied to applications.
 */
export interface SourceHealth {
  ok: boolean;
  /** ISO 8601 UTC when it answered, null when it did not. */
  at: string | null;
  error: string | null;
}

export interface PlaybackSession {
  id: string;
  item_id: string | null;
  title: string;
  series: string | null;
  /** "S02E05" for an episode, the year for a film. */
  sub: string | null;
  kind: MediaKind;
  user: string | null;
  client: string | null;
  device: string | null;
  method: PlaybackMethod | null;
  /**
   * Whether the transcode is hardware accelerated. null means UNMEASURED, not
   * false - the collector reports null when it cannot tell, because "software
   * transcode" is a much stronger claim than "transcoding" and must not be made
   * by accident. Renders as a plain TRANSCODE badge.
   *
   * UNVERIFIED: nothing was transcoding when this was written, so the shape of
   * Jellyfin's TranscodingInfo is an assumption. Confirm by forcing a browser
   * transcode and re-polling /Sessions before relying on the false branch.
   */
  hardware: boolean | null;
  paused: boolean;
  /** SECONDS, already divided down from Jellyfin's 100ns ticks by the collector. */
  position_s: number | null;
  runtime_s: number | null;
  width: number | null;
  height: number | null;
  /** Bare path for the image proxy, with no query string. */
  poster: string | null;
  /** Content hash of that image. Its presence is what makes the URL cacheable. */
  poster_tag: string | null;
}

/** One row of the Library table, from whichever source knows about it. */
export interface Transfer {
  id: string;
  title: string;
  sub: string | null;
  kind: MediaKind | null;
  state: FileState;
  /** 0..1, or null when the source does not know. null and 0 are different
   *  facts: a queued item really is at 0%. */
  progress: number | null;
  size: number | null;
  rate_bps: number | null;
  /** The alternative to a rate: "ratio 1.42", "hardlink", an ETA. */
  rate_note: string | null;
  note: string | null;
  source: string;
  quality: string | null;
  poster: string | null;
  poster_tag: string | null;
  /** Which application owns this, for the deep link. */
  app: string | null;
  /** That application's own URL slug. Carried rather than reconstructed. */
  app_slug: string | null;
  path: string | null;
  /** Present on rows that came from the library document. */
  added_at?: string | null;
  item_id?: string | null;
}

export interface RequestItem {
  id: string;
  title: string;
  year: string | null;
  kind: MediaKind;
  /** Derived from the two integers below; display this, never parse it. */
  status: string;
  status_code: number | null;
  media_status_code: number | null;
  requested_by: string | null;
  requested_at: string | null;
  /** null until the item actually lands in Jellyfin, which is the NORMAL case
   *  for a pending request - the panel's placeholder is a designed state. */
  poster: string | null;
  poster_tag: string | null;
  jellyfin_id: string | null;
}

export interface ActivityDocument {
  schema: number;
  generated_at: string;
  sessions: PlaybackSession[];
  transfers: Transfer[];
  sources: Record<string, SourceHealth>;
}

export interface LibraryTotals {
  no_subtitle_episodes: number | null;
  no_subtitle_movies: number | null;
}

export interface LibraryDocument {
  schema: number;
  generated_at: string;
  /** The newest handful, for Home's grid. */
  recently_added: Transfer[];
  /** How many landed in the last seven days, which is NOT recently_added.length. */
  recently_added_total: number;
  /** Recent completions, which is what gives the Library table a body. */
  done: Transfer[];
  /** Queued and stalled files, from the filesystem and Tdarr. */
  attention: Transfer[];
  requests: RequestItem[];
  request_counts: Record<string, number | null>;
  totals: LibraryTotals;
  sources: Record<string, SourceHealth>;
}

// -----------------------------------------------------------------------------
// fleet.json, written by bin/collect-metrics.py's source_fleet
// -----------------------------------------------------------------------------
// Read out of conduct.db, which is the only place that knows which task is in
// flight and what a round has cost. The refusals that travel with this document
// are stated in full in src/api/fleet.ts: no resume URL, and cost is reported
// but never retained.

/**
 * Who owes a step an answer.
 *
 * THE DISCRIMINATOR IS THE MODULE ID PREFIX, not the kind or the wording. A
 * module id starting `conduct_` is one conduct answers; `publish_pr` is
 * deliberately unprefixed because a PERSON answers it, and conduct refuses to
 * answer a step it does not own - conduct approving its own gate is the single
 * outcome that whole design exists to prevent.
 */
export type FleetWaiting = "conduct" | "person";

/** A notification sent to a person and not yet answered. */
export interface FleetNotice {
  flow_job_id: string | null;
  module_id: string;
  project: string;
  kind: string;
  summary: string | null;
  /**
   * conduct's own link to the approval page, behind sign-on, or null. NEVER
   * construct one - see src/api/fleet.ts.
   */
  link: string | null;
  first_at: string;
  last_at: string | null;
  /** Repeat sends. ntfy caches for 12h and the gate waits seven days, so a
   *  once-ever notification is lost for ever; this is what repeats. */
  sends: number;
  waiting_on: FleetWaiting;
}

/** How long a phase actually takes on this host, and what that rests on. */
export interface FleetPhaseStat {
  /** Median of completed, successful runs in the last 30 days. Null with none. */
  median_seconds: number | null;
  /** Below FLEET_ETA_MIN_SAMPLES the collector withholds every ETA that would
   *  have used this phase. Carried so the page can say what it is refusing on. */
  samples: number;
}

/**
 * One review round: one attempt at a task, carried through the phases.
 *
 * DERIVED FROM THE RUN LOG, NOT READ OUT OF `chain`. conduct's chain table is
 * current state: `worktree_id` is its PRIMARY KEY, `chain_open` does INSERT OR
 * REPLACE, and the worktree is REUSED for every change - so each round
 * overwrites the last one's row and the table holds exactly one however much
 * the fleet has done. Measured: 1 row in chain against eleven rounds in the run
 * log. `chain` still supplies `waiting_on`, `link` and the tracker id, but only
 * for the round in flight, which is the one thing it describes accurately.
 *
 * ONE ROW PER ATTEMPT. A `plan` run starts a round, which is conduct's own
 * definition - chain.attempts counts plan phases.
 */
export interface FleetRound {
  worktree_id: string;
  project: string;
  odoo_task: number | null;
  ref: string | null;
  phase: string | null;
  opened_at: string;
  /** When the first phase of this round started, and when the last one ended.
   *  `ended_at` is null while one is still running. */
  started_at: string;
  ended_at: string | null;
  /**
   * Which attempt at this task this round is, or null.
   *
   * NULL IS NOT ZERO AND NOT ONE. It is counted among rounds sharing an
   * `odoo_task`, so a round whose runs predate `run.odoo_task` cannot have one
   * - and "attempt 1 of 2" about a round whose task is unknown is a claim
   * rather than a count. The row hides the line instead.
   */
  attempts: number | null;
  /** conduct's MAX_ATTEMPTS, carried so the board can say "2 of 2" - the number
   *  that says whether the fleet is about to give up. */
  max_attempts: number;
  flow_job_id: string | null;
  head: string | null;
  resumed_at: string | null;
  /**
   * NULL MEANS IN FLIGHT, NOT "conduct". A round mid-flight legitimately matches
   * no notice, and rendering null as "waiting on conduct" would claim the fleet
   * owns a step nobody has looked at.
   *
   * "person" IS INDEPENDENT OF `closed_at` AND THE OTHER TWO ARE NOT. conduct
   * closes a round the moment it reaches the publish path, while the flow is
   * still suspended on the human gate - so the round a person owes an answer on
   * is, normally, a CLOSED one. "conduct" is only ever set on an open round,
   * because a closed round conduct owns is history rather than work.
   */
  waiting_on: FleetWaiting | null;
  link: string | null;
  summary: string | null;
  /** The notice's own kind - "approval" or "refused" - or null when nobody has
   *  been asked. It is what decides WHICH action a waiting row offers. */
  kind: string | null;

  /** Null while the round is open. Set means CONDUCT will not run it again -
   *  which is not the same as nothing being owed: a round that reached the
   *  publish path closes here and then waits on a person. See `waiting_on`. */
  closed_at: string | null;
  /**
   * conduct's sentence for why it closed. DISPLAYED AND NEVER PARSED - the
   * outcome is derived from `published` and `pr_state`, which are structural.
   */
  closed_why: string | null;
  /** The phases this round has finished. Cleared wholesale when a round starts
   *  again, so it is progress through the CURRENT attempt - which is why the
   *  row must keep printing "attempt N of 2" beside it. */
  done: string[];
  /** The full sequence, so the denominator travels with the numerator. */
  phases: string[];

  /** conduct's tracker page for `odoo_task`, built host-side from ODOO_URL.
   *  Null when unset, which ChipLink renders as a disabled box. */
  odoo_url: string | null;
  /**
   * The branch this round pushed, or null before it pushed one.
   *
   * FROM THE RUN LOG FIRST AND `publication.branch` ONLY AS A FALLBACK. That
   * row opens when the pull request does, which made this null for every round
   * that was refused or is still in flight - so the board fell back to the
   * worktree id and drew `upskald-ship` on every row ever rendered.
   */
  branch: string | null;
  /** The branch's page on GitHub, built host-side, or null when
   *  AGENTS_REPO_SLUG is unset or disagrees with a pull request's own owner. */
  branch_url: string | null;
  pr_url: string | null;
  pr_number: number | null;
  /**
   * "open" | "merged" | "closed" | "unknown", or null when there is no pull
   * request. UNKNOWN IS THE FAIL-OPEN VALUE: an unreachable GitHub or a missing
   * token must leave a round visible, never hide it.
   */
  pr_state: string | null;
  /**
   * True once a publication row for this round has CLOSED WITH a pull request.
   * A closed publication carrying none is a flow that ended without opening one
   * - a declined approval, a seven-day timeout - and must not read as a round
   * still waiting to publish.
   */
  published: boolean;
  /**
   * True when a LATER round for the same task exists and this one opened no
   * pull request - so its work is not what a reviewer is looking at.
   *
   * A THIRD OUTCOME, AND IT USED TO BE DRAWN AS A FAULT. "not published" is
   * amber and says a person should look; the ordinary way a round ends without
   * a pull request is that the review found something blocking, `retry` stopped
   * the flow, and the next round carried the same work through. Task 1271 drew
   * both rows on 2026-08-30 - one in review, one asking for attention it did
   * not need.
   *
   * MAY BE `undefined` ON A DOCUMENT WRITTEN BY AN OLDER COLLECTOR, because the
   * bundle and the collector deploy separately. Every reader must treat absence
   * as false rather than test it against null.
   */
  superseded?: boolean;

  /** Seconds until the round is expected to finish, or null. Measured from the
   *  document's `generated_at`, not from now. */
  eta_seconds: number | null;
  /** The weakest sample count in that sum. Null whenever eta_seconds is. */
  eta_samples: number | null;

  /** Summed over the round's phase runs. DISPLAY ONLY - mirroring this into a
   *  series would reverse the refusal docs/observability.md states. */
  cost_usd: number | null;
  tokens_in: number | null;
  tokens_out: number | null;

  /**
   * Why the round's last failing run failed, in conduct's own sentences, or
   * null. DISPLAYED AND NEVER PARSED, the same contract as `closed_why`.
   *
   * ON THE RUN ROW BECAUSE NOTHING ELSE IN conduct IS A LOG. `report` and
   * `chain` are both keyed on a REUSED worktree and hold exactly one row, so
   * either would answer about the newest round whichever round was asked
   * about. Null also covers a refusal that happened before conduct opened a run
   * row at all - so absent means "not recorded", never "nothing went wrong".
   */
  error: string | null;

  /**
   * True while a person has stopped dispatch for this round's worktree.
   *
   * ON THE ROUND IN FLIGHT AND NO OTHER. A control row outlives the round it
   * was set for, because the worktree is reused - so attaching it to every
   * round on that tree would draw a finished one as though somebody were still
   * holding it.
   */
  held: boolean;
  /** When the hold was set, or null. What the board counts the 24h suspend
   *  timeout down from. */
  held_at: string | null;
  /** The note that came with it, or null. Displayed, never parsed. */
  held_why: string | null;
}

/** One switch a person has set, as `fleet.json` carries it. */
export interface FleetControlEntry {
  /** The project for an intake switch, the worktree for a hold. */
  subject: string;
  /** "on" or "off". A value that is neither means conduct deferred to the
   *  descriptor, and the board must not claim to know which way. */
  value: string;
  at: string;
  note: string | null;
}

/**
 * What a person has asked the fleet to do, and whether they can ask at all.
 *
 * `available` IS NOT A GUESS ABOUT CADDY. The collector reads the same `.env`
 * Caddy is given the token from. Unset means the route answers 401, so every
 * control renders disabled with a reason rather than as a button that fails -
 * absent and broken are different findings.
 */
export interface FleetControl {
  available: boolean;
  /** Whether `/api/approve/*` has a token. SEPARATE FROM `available`: the two
   *  routes are scoped to one flow each, so one being minted says nothing about
   *  the other, and inferring the approve chips from `available` would offer a
   *  button that answers 401 at the moment it is most needed. */
  approve_available: boolean;
  /** conduct's CONTROL_RESTART_MIN_SEC, so the board can disable a restart it
   *  knows will be refused rather than sending one. */
  restart_floor_sec: number;
  intake: FleetControlEntry[];
  holds: FleetControlEntry[];
  /**
   * The quota hold's override, or null when nobody has lifted it.
   *
   * ONE ENTRY AND NOT A LIST, because the row it comes from takes no subject:
   * the quota is the ACCOUNT'S, and conduct's `last_quota` is global for the
   * same reason. Its `value` is an ISO STAMP rather than "on"/"off" - the moment
   * the fleet goes back to pacing itself at the warning - so a stamp in the past
   * is an override that has ENDED and must not be drawn as one in force.
   */
  quota: FleetControlEntry | null;
}

/** A branch conduct pushed whose pull request has not opened yet. */
export interface FleetPublication {
  job_id: string;
  project: string;
  worktree_id: string;
  odoo_task: number | null;
  branch: string | null;
  opened_at: string;
}

/** One phase run. `cost_usd` is display only - see src/api/fleet.ts. */
export interface FleetRun {
  phase: string;
  project: string;
  worktree_id: string;
  started_at: string;
  /** Null while the run is still going. NOT a failure. */
  ended_at: string | null;
  /** "ok", "killed", or null while in flight. conduct counts a failure as
   *  `result IS NOT NULL AND result != 'ok'`, and so must anything here. */
  result: string | null;
  exit_code: number | null;
  tokens_in: number | null;
  tokens_out: number | null;
  cost_usd: number | null;
  task: string | null;
  /** Stored raw by conduct because a model fallback can retract structured
   *  output. Truncated for display; do not parse it. */
  verdict: string | null;
}

/** What the fleet last chose for itself, and why it declined. */
export interface FleetIntake {
  project: string;
  odoo_task: number | null;
  flow_job_id: string | null;
  opened_at: string | null;
  closed_at: string | null;
  last_looked_at: string | null;
  /**
   * The reason the fleet picked nothing. AN INTAKE THAT HAS STOPPED LOOKS
   * EXACTLY LIKE AN EMPTY BACKLOG, and only the age of last_looked_at tells
   * them apart - never this string.
   */
  last_why: string | null;
}

export interface FleetTotals {
  runs_today: number | null;
  runs_failed_today: number | null;
  tokens_today: number | null;
  tokens_week: number | null;
  /** Display only, and deliberately absent from Prometheus. */
  cost_today: number | null;
  cost_week: number | null;
  rounds_open: number | null;
  publications_pending: number | null;
}

/**
 * `control.json`, the fast-tier document carrying the switch and nothing else.
 *
 * The same `control` object `FleetDocument` carries, written every 30s instead
 * of every 5 minutes - see src/api/control-doc.ts for why there are two.
 */
export interface ControlDocument {
  schema: number;
  generated_at: string;
  control: FleetControl;
  sources: Record<string, SourceHealth>;
}

/**
 * One turn of a phase's conversation, as the host renders it.
 *
 * AN ALLOWLIST, NOT A TRANSFORM OF THE LOG. bin/collect-metrics.py keeps four
 * shapes and drops everything else - in particular it drops tool RESULTS, which
 * is where file contents and command output land. The phase log itself is 0600
 * on the host and is never served; what arrives here has been through a
 * redaction pass that replaces every .env value with `${ITS_NAME}`, and
 * `agents.round_detail` measures that hourly on the real files rather than
 * trusting the code.
 */
export interface RoundTurn {
  /** `ask` the prompt, `say` an assistant turn, `tool` a call, `denied` a
   *  refused permission, `note` the renderer speaking about its own limits. */
  kind: "ask" | "say" | "tool" | "denied" | "note";
  text?: string;
  /** Present on `tool` only: the tool's name, and its input verbatim. */
  name?: string;
  input?: string;
}

/** The `result` event's scalars. Absent when the stream carried none. */
export interface RoundResultEvent {
  subtype: string | null;
  is_error: boolean;
  num_turns: number | null;
  duration_ms: number | null;
  total_cost_usd: number | null;
  stop_reason: string | null;
  usage: Record<string, unknown> | null;
}

/** A gate log's tail. `check` phases run no model, so they have no turns. */
export interface RoundGate {
  bytes: number;
  truncated: boolean;
  text: string;
}

export interface RoundPhase {
  run_id: number;
  phase: string | null;
  worktree_id: string | null;
  started_at: string | null;
  ended_at: string | null;
  result: string | null;
  exit_code: number | null;
  cost_usd: number | null;
  tokens_in: number | null;
  tokens_out: number | null;
  /** The log's basename, or null when none could be identified. Never a path:
   *  nothing in the browser can open it and offering one would be a lie. */
  log: string | null;
  turns: RoundTurn[];
  result_event: RoundResultEvent | null;
  gate: RoundGate | null;
  /** FALSE IS "NOT YET", NOT "IT SAID NOTHING". The collector renders a few
   *  logs per pass so a cold start converges instead of blowing its 25-second
   *  timeout; a phase waiting its turn must not read as a silent one. */
  rendered: boolean;
  short?: string;
  clipped?: boolean;
}

/** One entry in the round's timeline. `kind` is the key; never parse the rest. */
export interface RoundEvent {
  at: string | null;
  kind: string;
  phase?: string | null;
  run_id?: number;
  module?: string | null;
  result?: string | null;
  exit_code?: number | null;
  error?: string | null;
  notice?: string | null;
  sends?: number | null;
  summary?: string | null;
  branch?: string | null;
  pr_url?: string | null;
  pr_number?: number | null;
}

/**
 * The approval card and what it was built from.
 *
 * THIS IS THE TEXT A PERSON IS ACTUALLY BEING ASKED TO APPROVE, ~7.5 KB of it.
 * `FleetNotice.summary` is a DIFFERENT thing and always was: the phone copy,
 * rendered one phase earlier, hard-bounded at 3500 bytes and then truncated to
 * 240 characters on its way into fleet.json.
 */
export interface RoundReport {
  card: string;
  verdict: string;
  body: string;
  title: string;
  autopublish: boolean | null;
  autopublish_why: string[];
  notes: string[];
  refused: string[];
  gate_ok: boolean | null;
  base_sha: string | null;
  head_sha: string | null;
  seconds: number | null;
}

export interface RoundSummary {
  key: string;
  worktree_id: string;
  project: string | null;
  odoo_task: number | null;
  started_at: string | null;
  ended_at: string | null;
  closed_at: string | null;
  closed_why: string | null;
  attempts: number | null;
  max_attempts: number | null;
  branch: string | null;
  phase: string | null;
  waiting_on: FleetWaiting | null;
  /** What `f/agents/approve` is handed. Null when no flow job could be named,
   *  which is what makes Approve unofferable rather than merely unpressed. */
  flow_job_id: string | null;
  settled: boolean;
}

/**
 * One round's own document, fetched when its row is opened and never polled.
 *
 * A 404 IS THE ORDINARY STATE, not a failure: the collector renders on its
 * five-minute tier under a per-run budget, so a round can be on the board before
 * its document exists. `fetchDocument` turns that into DocumentNeverWritten and
 * the panel says "not yet".
 */
export interface RoundDocument {
  schema: number;
  generated_at: string;
  round: RoundSummary;
  events: RoundEvent[];
  report: RoundReport | null;
  phases: RoundPhase[];
  clipped?: string;
  sources: Record<string, SourceHealth>;
}

export interface FleetDocument {
  schema: number;
  generated_at: string;
  rounds: FleetRound[];
  publications: FleetPublication[];
  notices: FleetNotice[];
  runs: FleetRun[];
  intake: FleetIntake[];
  /** Keyed by phase name. Every phase is present, with nulls where there is no
   *  evidence - a key that came and went would force a reader to guess. */
  phase_stats: Record<string, FleetPhaseStat>;
  control: FleetControl;
  totals: FleetTotals;
  /** `conduct_db`, and `github` once a pull request has been asked about. Not
   *  optional: a locked database and an idle fleet are the same empty list
   *  without it. `github` is ABSENT when nothing needed asking, which is not
   *  the same as a run where the token failed. */
  sources: Record<string, SourceHealth>;
}
