// =============================================================================
// The presentation vocabulary both media pages share
// -----------------------------------------------------------------------------
// A wire value is never rendered and a label is never parsed. That is the same
// split status.json makes between a stable `id` and disposable `message` prose,
// and it is why STATE_LABEL exists rather than a `.replace("_", " ")` at each
// call site.
// =============================================================================

import type { FileState, MediaKind, PlaybackSession, RequestItem, Tone, Transfer } from "@/types";
import * as links from "@/links";
import type { AppKey } from "@/links";
import * as fmt from "@/format";
import { fsTone, mountReading, type MountReading } from "@/system";

/** Three status colours and grey, per the brief. `queued` and `done` are grey
 *  because neither is a problem and neither is an achievement. */
export const STATE_TONE: Record<FileState, Tone> = {
  downloading: "ok",
  transcoding: "ok",
  importing: "ok",
  seeding: "ok",
  queued: "off",
  done: "off",
  stalled: "warn",
  no_subtitles: "warn",
  error: "fail",
};

export const STATE_LABEL: Record<FileState, string> = {
  downloading: "downloading",
  transcoding: "transcoding",
  importing: "importing",
  seeding: "seeding",
  queued: "queued",
  done: "done",
  stalled: "stalled",
  no_subtitles: "no subtitles",
  error: "error",
};

/**
 * Which of three groups a state belongs to. `live` is the only one whose
 * progress bar animates: motion has to carry data, so a bar that moves on a
 * finished row is decoration and a bar that moves on a stalled one is a lie.
 */
export function stateClass(state: FileState): "attention" | "live" | "steady" {
  if (state === "error" || state === "stalled" || state === "no_subtitles") return "attention";
  if (state === "downloading" || state === "transcoding" || state === "importing") return "live";
  return "steady";
}

/**
 * ATTENTION FIRST, THEN ACTIVITY - which is a deliberate deviation from the
 * design's footer text, and the footer is corrected to match rather than the
 * sort being bent to it.
 *
 * The design says "sorted by activity". On the real host that buries the one row
 * worth looking at: there are 145 completions in a week against a single
 * download, so an activity sort puts the error row somewhere past the fold. Both
 * built pages already sort worst-first and both say why - ServicesPage's is "a
 * rack sorted alphabetically buries the one row worth looking at somewhere in
 * the middle". A footer naming a sort the table does not perform would be worse
 * than either choice.
 *
 * It is also what makes the design's filter chips survive the real, lopsided
 * counts: `all` is dominated by `done` in population but not in what you see.
 */
const RANK: Record<FileState, number> = {
  error: 0,
  stalled: 1,
  no_subtitles: 2,
  downloading: 3,
  transcoding: 3,
  importing: 3,
  queued: 4,
  seeding: 5,
  done: 6,
};

export function sortRows(a: Transfer, b: Transfer): number {
  const byRank = RANK[a.state] - RANK[b.state];
  if (byRank !== 0) return byRank;
  // Within a rank: busiest first, then newest, then a stable tie-break so the
  // table does not shuffle between polls.
  const rate = (b.rate_bps ?? -1) - (a.rate_bps ?? -1);
  if (rate !== 0) return rate;
  const added = (b.added_at ?? "").localeCompare(a.added_at ?? "");
  if (added !== 0) return added;
  return a.id.localeCompare(b.id);
}

/**
 * DIRECT / HW TRANSCODE / SW TRANSCODE / TRANSCODE.
 *
 * Four labels for three colours: unmeasured hardware gets the same amber as a
 * measured software transcode but a shorter word, because "SW TRANSCODE" on a
 * host with a dedicated NVENC card is a real finding and must not be claimed on
 * the strength of a null. See PlaybackSession.hardware.
 */
export function badgeFor(session: PlaybackSession): { label: string; tone: Tone } {
  if (session.method === "transcode") {
    if (session.hardware === true) return { label: "HW TRANSCODE", tone: "warn" };
    if (session.hardware === false) return { label: "SW TRANSCODE", tone: "warn" };
    return { label: "TRANSCODE", tone: "warn" };
  }
  if (session.method === "directstream") return { label: "DIRECT STREAM", tone: "ok" };
  return { label: "DIRECT", tone: "ok" };
}

/**
 * "Pixel 8 Pro / Jellyfin for Android / 1920x800".
 *
 * NO LOCAL-VERSUS-REMOTE TOKEN, and the design's "remote via tailscale" is
 * dropped for a measured reason: every session reports Caddy's own net-media
 * address as its RemoteEndPoint, because everything reaches Jellyfin through the
 * proxy. A badge built on that field would be confidently wrong for every row,
 * which cannot be spotted from a dashboard. The collector does not even carry it.
 */
export function whoLine(session: PlaybackSession): string {
  const parts = [session.device, session.client].filter((p): p is string => !!p);
  if (session.width && session.height) parts.push(`${session.width}x${session.height}`);
  return parts.join(" / ");
}

export interface Action {
  label: string;
  href: string | null;
  title: string;
}

/**
 * The design's action chip, as a link. Every label is lowercase to match the
 * design's chips, and every one of them opens something rather than doing
 * something - see @/links for why that is structural.
 */
export function actionFor(row: Transfer): Action {
  const app = row.app as AppKey | null;
  if (app === "sonarr" && row.app_slug) {
    return { label: "sonarr", href: links.sonarrSeries(row.app_slug), title: "open this series in Sonarr" };
  }
  if (app === "radarr" && row.app_slug) {
    return { label: "radarr", href: links.radarrMovie(row.app_slug), title: "open this film in Radarr" };
  }
  if (app === "jellyfin" && row.item_id) {
    return { label: "watch", href: links.jellyfinItem(row.item_id), title: "open this item in Jellyfin" };
  }
  if (app === "qbittorrent") {
    return {
      label: "torrent",
      href: links.qbittorrent(),
      // Said out loud because the chip sits on a specific row and cannot reach it.
      title: "open qBittorrent - it has no per-torrent address, so this opens the client",
    };
  }
  if (app === "tdarr") {
    return { label: "tdarr", href: links.tdarr(), title: "open Tdarr" };
  }
  if (app) {
    return { label: app, href: links.appHome(app), title: `open ${app}` };
  }
  return { label: "-", href: null, title: "nothing here owns this row" };
}

/**
 * The media stack, for Home's service strip - ten containers rather than all
 * twenty-three. `app` is null where the container has no web interface to open.
 *
 * A SECOND HAND-MAINTAINED LIST, which CLAUDE.md calls the most driftable shape
 * this repository has a name for. It is checked against @/topology at startup in
 * dev, which is the `uncovered()` idea applied to this list: a container renamed
 * in stacks/ shows up as a console warning rather than as a chip that silently
 * stops appearing.
 */
export interface StripService {
  container: string;
  label: string;
  app: AppKey | null;
}

export const STRIP_SERVICES: readonly StripService[] = [
  { container: "jellyfin", label: "jellyfin", app: "jellyfin" },
  { container: "jellyseerr", label: "jellyseerr", app: "jellyseerr" },
  { container: "sonarr", label: "sonarr", app: "sonarr" },
  { container: "radarr", label: "radarr", app: "radarr" },
  { container: "prowlarr", label: "prowlarr", app: "prowlarr" },
  { container: "bazarr", label: "bazarr", app: "bazarr" },
  { container: "tdarr-server", label: "tdarr", app: "tdarr" },
  { container: "tdarr-node-01", label: "tdarr node", app: null },
  { container: "qbittorrent", label: "qbittorrent", app: "qbittorrent" },
  { container: "unpackerr", label: "unpackerr", app: null },
];

// =============================================================================
// The readings both media pages lead with
// -----------------------------------------------------------------------------
// THE SIXTH OF THESE EXTRACTIONS, and Home and Library were the last pages with
// none. A decision that lives in a .vue file is code fixtures/smoke.mjs cannot
// call, and of the five pages this was done to, every one was found to be
// carrying at least one answer that was wrong and rendered perfectly.
//
// ONE MODULE FOR TWO PAGES, DELIBERATELY. Home's IN FLIGHT condition, Library's
// headline and Library's `in flight` chip are three readings of one array, and
// the recorded way that goes wrong is networkLead counting five while
// attentionRows listed seven. There is one filter here and all three call it.
// =============================================================================

/**
 * A row as the store hands it over.
 *
 * DECLARED HERE RATHER THAN IN THE STORE, because every function below takes
 * one and a type that lives with its consumers cannot drift from them. The
 * store re-exports it, so the existing import path still resolves.
 */
export interface MediaRow extends Transfer {
  /** Which document this came from, so the two can dim independently. */
  origin: "activity" | "library";
  /** Lowercased title and path, precomputed per document change rather than per
   *  keystroke. */
  searchKey: string;
}

/**
 * IN FLIGHT IS WORK THE PIPELINE STILL OWES: the three live states plus
 * `queued`.
 *
 * `queued` is `steady` to stateClass because nothing about it animates - a
 * queued file is not moving - but it has not landed either, and a headline
 * counting only what moves would read `nothing in flight` over a table with a
 * hundred queued rows in it.
 *
 * `seeding` and `done` are excluded because both HAVE landed. Seeding is a
 * policy this host runs deliberately rather than an outstanding transfer, and
 * with eight permanent seeds on the live host including it would make this
 * number a constant.
 */
export function inFlightRows(rows: MediaRow[]): MediaRow[] {
  return rows.filter((r) => stateClass(r.state) === "live" || r.state === "queued");
}

/** The rows the table already draws amber or red. A FILTER over the same array,
 *  never a second count of it. */
export function attentionRows(rows: MediaRow[]): MediaRow[] {
  return rows.filter((r) => stateClass(r.state) === "attention");
}

/**
 * Whether a document may be believed, in three states rather than two.
 *
 * ABSENT AND STALE ARE DIFFERENT FACTS and the headline treats them
 * differently: a document that never answered has no number to show, where one
 * that answered eight minutes ago has a number that was true then. hostLead
 * makes the same split for the same reason.
 */
export type DocState = "fresh" | "stale" | "absent";

export function docState(present: boolean, stale: string | null): DocState {
  if (!present) return "absent";
  return stale ? "stale" : "fresh";
}

/**
 * Everything either page's header needs, from one pass over the store.
 *
 * The two documents keep their own state because they go stale at different
 * rates: activity.json is rewritten every thirty seconds and library.json every
 * five minutes, so a single "is the media data fresh" flag would report the slow
 * one as broken nine ticks in ten.
 */
export interface MediaActivity {
  playback: DocState;
  library: DocState;
  /** Playback, from activity.json. */
  sessions: number;
  transcodes: number;
  /** The pipeline, split so a sub-line can name it. */
  downloading: number;
  transcoding: number;
  importing: number;
  queued: number;
  /** What is stuck. */
  stalled: number;
  errored: number;
  noSubtitles: number;
  /** The two totals every reading here is built from. */
  inFlight: number;
  attention: number;
  /** Requests, from library.json. */
  pendingRequests: number;
  requestTotal: number;
}

export function mediaActivity(input: {
  sessions: PlaybackSession[];
  rows: MediaRow[];
  requestCounts: Record<string, number | null> | null | undefined;
  playback: DocState;
  library: DocState;
}): MediaActivity {
  const byState = (s: FileState) => input.rows.filter((r) => r.state === s).length;
  const flight = inFlightRows(input.rows);
  const stuck = attentionRows(input.rows);

  return {
    playback: input.playback,
    library: input.library,
    sessions: input.sessions.length,
    transcodes: input.sessions.filter((s) => s.method === "transcode").length,
    downloading: byState("downloading"),
    transcoding: byState("transcoding"),
    importing: byState("importing"),
    queued: byState("queued"),
    stalled: byState("stalled"),
    errored: byState("error"),
    noSubtitles: byState("no_subtitles"),
    inFlight: flight.length,
    attention: stuck.length,
    pendingRequests: input.requestCounts?.pending ?? 0,
    requestTotal: input.requestCounts?.total ?? 0,
  };
}

// -----------------------------------------------------------------------------
// The vocabulary
// -----------------------------------------------------------------------------

/** The headline, in --t-mono-xl. One per view. */
export interface LeadReading {
  text: string;
  tone: Tone;
  live: boolean;
  sub: string;
}

export interface ConditionRow {
  id: string;
  label: string;
  value: string;
  sub: string;
  tone: Tone;
}

/** amber outranks grey, as on /system and for the same reason: a condition that
 *  did not resolve is already reported by StalenessBanner at a size this cannot
 *  compete with, and a real warning is the more useful headline. */
const TONE_RANK: Record<Tone, number> = { fail: 3, warn: 2, off: 1, ok: 0 };

function worst(rows: ConditionRow[]): Tone {
  let out: Tone = "ok";
  for (const r of rows) if (TONE_RANK[r.tone] > TONE_RANK[out]) out = r.tone;
  return out;
}

/**
 * ERROR AND STALLED TONE A HEADLINE; `no_subtitles` DOES NOT.
 *
 * A missing subtitle is a backlog and a backlog is not a fault - this host's is
 * 1,109 episodes deep and has been for as long as it has been measured, so
 * grading on it would paint both pages amber permanently. That is the rule that
 * cried wolf, which memoryTone paid for one page over: a floor of zero on a
 * quantity that is never zero is not a threshold.
 */
function stuckTone(a: MediaActivity): Tone {
  if (a.errored > 0) return "fail";
  if (a.stalled > 0) return "warn";
  return "ok";
}

/** "1 error, 2 stalled", or nothing when neither. */
function stuckSub(a: MediaActivity): string {
  const parts: string[] = [];
  if (a.errored) parts.push(`${a.errored} error${a.errored === 1 ? "" : "s"}`);
  if (a.stalled) parts.push(`${a.stalled} stalled`);
  if (a.noSubtitles) parts.push(`${a.noSubtitles} without subtitles`);
  return parts.join(", ");
}

function plural(n: number, one: string, many: string): string {
  return n === 1 ? one : many;
}

// -----------------------------------------------------------------------------
// Home
// -----------------------------------------------------------------------------

/**
 * WATCHING, IN FLIGHT, REQUESTS.
 *
 * Two of the three come from activity.json and one from library.json, so each
 * says which document failed rather than all three reading `-` with no reason.
 *
 * GREY MEANS NOT MEASURED, NEVER MEASURED-AND-ZERO, and the first draft of this
 * had it backwards: every condition answered `off` for a zero, so a host with
 * nobody watching and nothing in flight - which is its ORDINARY state - drew a
 * grey headline saying "nothing happening", the encoding this application
 * reserves for "nobody asked". That is the recorded defect family inverted.
 * Absence read as health is what fsTone and smartLine were rewritten for; this
 * was health read as absence, and it is the same mistake facing the other way.
 * `ok` is the ordinary body colour here rather than green, which is exactly
 * what a fact that was measured and is fine should render as.
 *
 * REQUESTS IS NEVER AMBER. A pending request is somebody waiting on a person in
 * another application; it is not a fault on this host, and toning it would put
 * the headline amber for as long as anybody had asked for anything. `ok` is the
 * ordinary body colour here, not green, which is exactly what a fact that is
 * merely present should render as.
 */
export function homeConditions(a: MediaActivity): ConditionRow[] {
  const watchSub =
    a.playback === "absent"
      ? "activity.json has not answered"
      : a.sessions === 0
        ? "nothing playing"
        : a.transcodes
          ? `${a.transcodes} transcoding`
          : "all direct";

  // A COUNT, NOT A BREAKDOWN. This read `2 errors, 2 stalled` under a value of
  // `3 files`, which invites the arithmetic - the stuck rows are a DIFFERENT
  // set from the in-flight ones, and none of the four was among the three. The
  // split belongs on /library's own attention condition, where the value it
  // qualifies is the one it is about.
  const flightSub =
    a.playback === "absent"
      ? "activity.json has not answered"
      : a.attention
        ? `${a.attention} ${plural(a.attention, "needs", "need")} attention`
        : a.inFlight
          ? "all moving"
          : "the queue is empty";

  return [
    {
      id: "watching",
      label: "watching",
      value:
        a.playback === "absent"
          ? fmt.NO_DATA
          : a.sessions
            ? `${a.sessions} ${plural(a.sessions, "session", "sessions")}`
            : "nobody",
      sub: watchSub,
      tone: a.playback === "absent" ? "off" : "ok",
    },
    {
      // The tone is the pipeline's, not the count's: three files moving is not a
      // fault and one stalled is, so the sub always names what the colour is
      // about. Same shape as /system's disk condition.
      id: "flight",
      label: "in flight",
      value:
        a.playback === "absent"
          ? fmt.NO_DATA
          : a.inFlight
            ? `${a.inFlight} ${plural(a.inFlight, "file", "files")}`
            : "nothing",
      sub: flightSub,
      tone: a.playback === "absent" ? "off" : a.attention ? stuckTone(a) : "ok",
    },
    {
      id: "requests",
      label: "requests",
      value:
        a.library === "absent"
          ? fmt.NO_DATA
          : a.pendingRequests
            ? `${a.pendingRequests} pending`
            : "none pending",
      sub:
        a.library === "absent"
          ? "library.json has not answered"
          : a.requestTotal
            ? `of ${a.requestTotal} requested`
            : "nothing requested yet",
      tone: a.library === "absent" ? "off" : "ok",
    },
  ];
}

/**
 * "5 things happening" - watching plus in flight, and nothing else.
 *
 * IT SUMS TWO OF THE THREE CONDITIONS ON PURPOSE. A pending request is waiting,
 * not happening, so REQUESTS is a condition and not an addend; the sub-line
 * exists to make that arithmetic visible rather than leaving a reader to guess
 * which numbers went into the headline.
 *
 * THREE STATES BEFORE THE NUMBER, and the last two are why this is a function.
 * Both halves come from activity.json, so when that document has never answered
 * there is no total to show and `${NaN} things happening` would be a headline
 * claiming a dash was measured - the defect every lead in this application has
 * had written out of it. When the document answered but has gone stale the
 * number stands and goes grey, because it was true then and saying so is more
 * use than refusing to say anything.
 *
 * ZERO IS AN ANSWER, NOT AN ABSENCE. Nothing playing and nothing in flight is
 * the ordinary state of this host - fixtures/media.ts documents HS_FIX_EMPTY as
 * the common production rendering - so it reads as calm and takes no live dot.
 */
export function homeLead(a: MediaActivity, conds: ConditionRow[]): LeadReading {
  if (a.playback === "absent") {
    return {
      text: "activity not known",
      tone: "off",
      live: false,
      sub: "watching and in flight both come from activity.json, which has not answered",
    };
  }

  const total = a.sessions + a.inFlight;
  const text = total ? `${total} ${plural(total, "thing", "things")} happening` : "nothing happening";

  if (a.playback === "stale") {
    return { text, tone: "off", live: false, sub: "as of the last activity report, which is not now" };
  }

  const parts: string[] = [];
  if (a.sessions) parts.push(`${a.sessions} watching`);
  if (a.inFlight) parts.push(`${a.inFlight} in flight`);

  return {
    text,
    tone: worst(conds),
    live: total > 0,
    sub: parts.length ? parts.join(", ") : "nobody watching, nothing in flight",
  };
}

// -----------------------------------------------------------------------------
// Library
// -----------------------------------------------------------------------------

export const MEDIA_MOUNT = "/var/mnt/media";

/**
 * The media disk, through system.ts rather than beside it.
 *
 * THIS PAGE USED TO DO ITS OWN ARITHMETIC - `{ total, used: total - free }`,
 * with no ratio and therefore no tone, so a media disk at 95 percent rendered
 * exactly like one at 20. system/HealthPage.vue's docblock states the rule it
 * broke: "a second copy of that arithmetic is how the two would start
 * disagreeing about which mount is full". mountReady() is that one copy, and
 * fsTone already answers `off` rather than `ok` for a mount it could not read.
 *
 * The mountpoint is the metric's own label and not the design's /mnt/media: on
 * CoreOS /mnt is a symlink into /var, so the canonical path is what the
 * collector reports and what the filesystem series are keyed on.
 */
export function mediaDisk(size: Map<string, number>, avail: Map<string, number>): MountReading {
  return mountReading(
    MEDIA_MOUNT,
    size.get(MEDIA_MOUNT) ?? Number.NaN,
    avail.get(MEDIA_MOUNT) ?? Number.NaN,
  );
}

/**
 * ATTENTION, SUBTITLES, MEDIA DISK - the three things that decide whether the
 * pipeline is healthy, and the only one of them that can page anybody is the
 * disk.
 *
 * SUBTITLES IS NEVER AMBER, for the reason stuckTone gives: it is Bazarr's
 * backlog and not a queue this host is failing to drain. It is here because it
 * is the largest real number on the page and hiding it would be worse than
 * drawing it grey.
 *
 * The attention VALUE counts all three attention states because that is what
 * the chip under it counts, and the TONE grades two of them. The sub names the
 * split, so the colour never has an invisible source.
 */
export function libraryConditions(
  a: MediaActivity,
  totals: { no_subtitle_episodes: number | null; no_subtitle_movies: number | null } | null,
  disk: MountReading | null,
): ConditionRow[] {
  const episodes = totals?.no_subtitle_episodes ?? null;
  const movies = totals?.no_subtitle_movies ?? null;
  const ratio = disk ? disk.ratio : Number.NaN;

  return [
    {
      id: "attention",
      label: "attention",
      value:
        a.playback === "absent"
          ? fmt.NO_DATA
          : a.attention
            ? `${a.attention} ${plural(a.attention, "file", "files")}`
            : "nothing",
      sub:
        a.playback === "absent"
          ? "activity.json has not answered"
          : a.attention
            ? stuckSub(a)
            : "nothing stalled, errored or unsubtitled",
      tone: a.playback === "absent" ? "off" : a.attention ? stuckTone(a) : "ok",
    },
    {
      id: "subtitles",
      label: "subtitles",
      value:
        episodes === null
          ? fmt.NO_DATA
          : `${fmt.number(episodes)} ${plural(episodes, "episode", "episodes")}`,
      sub:
        episodes === null
          ? "bazarr did not report a backlog"
          : movies
            ? `and ${fmt.number(movies)} ${plural(movies, "film", "films")}`
            : "no films waiting",
      tone: episodes === null ? "off" : "ok",
    },
    {
      id: "disk",
      label: "media disk",
      value: Number.isFinite(ratio) ? `${fmt.percent(ratio, 0)} used` : fmt.NO_DATA,
      sub: disk && Number.isFinite(ratio)
        ? `${fmt.bytes(disk.free)} free of ${fmt.bytes(disk.total)}`
        : `${MEDIA_MOUNT} did not report a size`,
      tone: fsTone(ratio),
    },
  ];
}

/**
 * "3 in flight", over what those three are doing.
 *
 * The tone is the worst condition's and never the number's: files moving is
 * what this pipeline is for, and a count of them is not a fault. A stalled one
 * and a full disk are, and both are conditions.
 *
 * The absence and staleness branches are homeLead's, for the same reason - the
 * rows come from the same document.
 */
export function libraryLead(a: MediaActivity, conds: ConditionRow[]): LeadReading {
  if (a.playback === "absent") {
    return {
      text: "nothing known to be in flight",
      tone: "off",
      live: false,
      sub: "activity.json has not answered, so this is an absence and not a measurement",
    };
  }

  const text = a.inFlight ? `${a.inFlight} in flight` : "nothing in flight";

  if (a.playback === "stale") {
    return { text, tone: "off", live: false, sub: "as of the last activity report, which is not now" };
  }

  const parts: string[] = [];
  if (a.downloading) parts.push(`${a.downloading} downloading`);
  if (a.transcoding) parts.push(`${a.transcoding} transcoding`);
  if (a.importing) parts.push(`${a.importing} importing`);
  if (a.queued) parts.push(`${a.queued} queued`);

  return {
    text,
    tone: worst(conds),
    live: a.inFlight > 0,
    sub: parts.length ? parts.join(", ") : "the queue drains to zero by design",
  };
}

// -----------------------------------------------------------------------------
// The table's controls
// -----------------------------------------------------------------------------

export type View = "all" | "flight" | "attention" | "series" | "movie";

/** Shown in the filtered-empty sentence when no text filter is set. */
export const VIEW_HINT = "this view";

/**
 * THE `in flight` CHIP AND THE HEADLINE COUNT THE SAME ROWS, which is the whole
 * reason inFlightRows exists. It was `active` over a hand-written list of three
 * states while the header counted something else; two groupings of one question
 * is the drift roundOutcome was written to close, and this file already had
 * stateClass answering it.
 */
export function inView(row: MediaRow, v: View): boolean {
  if (v === "flight") return stateClass(row.state) === "live" || row.state === "queued";
  if (v === "attention") return stateClass(row.state) === "attention";
  if (v === "series" || v === "movie") return row.kind === v;
  return true;
}

export interface Chip {
  id: View;
  label: string;
  n: number;
  tone: Tone;
}

/**
 * Counts over the WHOLE row set and never over the current view - that is the
 * entire point of a count on a filter control. A zero chip stays clickable:
 * clicking "attention 0" should show the filtered-empty state, and a disabled
 * chip is indistinguishable from one that has quietly stopped being offered.
 */
export function chipCounts(rows: MediaRow[]): Chip[] {
  const count = (v: View) => rows.filter((r) => inView(r, v)).length;
  return [
    { id: "all", label: "all", n: rows.length, tone: "off" },
    { id: "flight", label: "in flight", n: count("flight"), tone: "ok" },
    { id: "attention", label: "needs attention", n: count("attention"), tone: "warn" },
    { id: "series", label: "tv", n: count("series"), tone: "off" },
    { id: "movie", label: "movies", n: count("movie"), tone: "off" },
  ];
}

/** No debounce. A few hundred string comparisons per keystroke is free, and a
 *  debounce on a local filter only adds lag. */
export function filterRows(rows: MediaRow[], view: View, filter: string): MediaRow[] {
  const needle = filter.trim().toLowerCase();
  return rows.filter((r) => inView(r, view) && (!needle || r.searchKey.includes(needle)));
}

export type Emptiness = "none" | "filtered" | "stale" | "fresh";

/**
 * Which empty state applies. Three strings, not one.
 *
 * Stale-and-empty must NEVER read as "nothing in flight": at eight minutes old
 * that is an assertion we are not entitled to make. This is the sharpest
 * expression of the freshness rule on either page.
 */
export function emptiness(visible: number, total: number, stale: string | null): Emptiness {
  if (visible) return "none";
  if (total) return "filtered";
  if (stale) return "stale";
  return "fresh";
}

// -----------------------------------------------------------------------------
// Requests
// -----------------------------------------------------------------------------

export interface RequestRow {
  id: string;
  title: string;
  kind: MediaKind;
  status: string;
  asked: string;
  poster: string | null;
  posterTag: string | null;
  href: string | null;
}

/**
 * coarse, NOT sinceIso: "asked 2h ago" rather than "asked 2h 03m ago", which
 * reads as false precision for something somebody asked for yesterday.
 *
 * `now` is passed in rather than read, so this stays pure and the page can hand
 * it the Prometheus-corrected clock every other age on the page runs off.
 */
export function requestRows(requests: RequestItem[], now: number): RequestRow[] {
  return requests.map((r) => {
    const at = fmt.isoToUnix(r.requested_at);
    return {
      id: r.id,
      title: r.title,
      kind: r.kind === "series" ? "series" : "movie",
      status: r.status,
      asked: Number.isFinite(at) ? `${fmt.coarse(now - at)} ago` : fmt.NO_DATA,
      poster: r.poster,
      posterTag: r.poster_tag,
      href: links.jellyseerrRequests(),
    };
  });
}
