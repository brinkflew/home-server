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
   * NULL MEANS IN FLIGHT, NOT "conduct". chain.flow_job_id is the job that
   * STOPPED rather than the one running, so a round mid-flight legitimately
   * matches no notice. Rendering null as "waiting on conduct" would claim the
   * fleet owns a step nobody has looked at.
   */
  waiting_on: FleetWaiting | null;
  link: string | null;
  summary: string | null;
  /** The notice's own kind - "approval" or "refused" - or null when nobody has
   *  been asked. It is what decides WHICH action a waiting row offers. */
  kind: string | null;

  /** Null while the round is open. Set means it will not run again. */
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
  branch: string | null;
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
  totals: FleetTotals;
  /** `conduct_db`, and `github` once a pull request has been asked about. Not
   *  optional: a locked database and an idle fleet are the same empty list
   *  without it. `github` is ABSENT when nothing needed asking, which is not
   *  the same as a run where the token failed. */
  sources: Record<string, SourceHealth>;
}
