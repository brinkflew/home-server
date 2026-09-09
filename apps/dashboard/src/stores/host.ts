// =============================================================================
// The shared state: what is true now, and how old "now" is
// -----------------------------------------------------------------------------
// One store, because both halves of the page need both halves of the answer:
// the findings and the freshness. Splitting them is how a dashboard ends up
// rendering an hour-old verdict in a panel that looks live.
//
// FOUR INDEPENDENT FRESHNESS PRIMITIVES, and they are independent on purpose -
// each fails in a way the others cannot see:
//
//   status.json generated_at   the hourly battery. Read from the FILE, not from
//                              its Prometheus mirror, so a dead collector does
//                              not make a healthy battery look stale (or the
//                              reverse).
//   collector textfile mtime   did the 30s metrics run happen AT ALL. Dated by
//                              node-exporter from outside the collector,
//                              because a thing cannot grade its own liveness.
//   collector last success     did that run COMPLETE every source. If this
//                              stops, part of the System page freezes while
//                              continuing to render, which is the failure mode
//                              with no other symptom.
//   up                         Prometheus' own view of its targets. Covers the
//                              case where the collector is fine and the scrape
//                              is not.
//
// THE MIDDLE TWO WERE ONE UNTIL 2026-09-09, and conflating them is what let the
// banner say "the metrics collector has never reported" about a collector that
// had run two seconds earlier: the success stamp was OMITTED rather than held
// whenever any source failed, and an absent series is not an old one. Running
// and degraded is a third state, and it needed a third clock to be seen.
//
// This is the same argument CLAUDE.md makes for the first Prometheus rule
// group: "a rule whose expression matches nothing does not fire - so if the
// collector or the scrape stops, the whole battery goes silent, and silence is
// exactly what healthy looks like".
// =============================================================================

import { computed, ref } from "vue";
import { defineStore } from "pinia";

import { fetchStatus, StatusNeverWritten } from "@/api/status";
import { instant, value } from "@/api/prometheus";
import { usePoll } from "@/composables/usePoll";
import { SignedOutError } from "@/api/http";
import { isoToUnix } from "@/format";
import { collectorState as deriveCollectorState, type CollectorState } from "@/health";
import { freshness, type Freshness } from "@/freshness";
import { PULSE_QUERY } from "@/queries";
import type { Check, CheckStatus, StatusDocument } from "@/types";

// Re-exported so existing importers of `Freshness` from this store keep working;
// @/freshness is where it is defined.
export type { Freshness };

/** Re-exported so importers of the store keep working; @/health defines it. */
export type { CollectorState };

/** The battery runs hourly; the alert rule calls it stale at two hours. Same
 *  number here, so the dashboard and the phone never disagree. */
const STATUS_STALE_S = 7200;
/** The collector runs every 30s; MetricsCollectorStale fires at ten minutes. */
const COLLECTOR_STALE_S = 600;

const STATUS_POLL_MS = 60_000;
const PULSE_POLL_MS = 30_000;

export const useHostStore = defineStore("host", () => {
  // --- status.json ---------------------------------------------------------
  const status = usePoll<StatusDocument>((signal) => fetchStatus(signal), STATUS_POLL_MS);

  // --- the pulse: one instant query covering all four primitives -----------
  // A single regex query rather than four round trips. The response also
  // carries Prometheus' own evaluation timestamp, which is what "now" should
  // be measured against - a browser with a skewed clock must not be able to
  // report a healthy collector as stale.
  //
  // PULSE_QUERY lives in @/queries so the dev fixtures cover it; see the
  // docblock there for why a private copy was a trap.
  //
  // AN EXPLICIT SWITCH ON __name__, NOT `if up ... else`. That `else` was
  // written when the query named exactly two metrics and it silently means
  // "everything that is not `up` is the collector timestamp" - so the moment a
  // third name joined the regex, source_up values would have been assigned to
  // collectorAt and the freshness of the whole page would have been whatever
  // the last source in the response happened to report.
  const pulse = usePoll(async (signal) => {
    const series = await instant(PULSE_QUERY, signal);

    let collectorAt = Number.NaN;
    let collectorRanAt = Number.NaN;
    let serverNow = Number.NaN;
    let targetsUp = 0;
    let targetsTotal = 0;
    const failedSources: string[] = [];

    for (const s of series) {
      if (Number.isNaN(serverNow)) serverNow = s.value[0];
      switch (s.metric.__name__) {
        case "up":
          targetsTotal += 1;
          if (value(s.value) === 1) targetsUp += 1;
          break;
        case "home_server_collector_last_success_timestamp_seconds":
          collectorAt = value(s.value);
          break;
        case "home_server_collector_source_up":
          if (value(s.value) === 0 && s.metric.source) failedSources.push(s.metric.source);
          break;
        case "node_textfile_mtime_seconds":
          // THE FAST FILE ONLY. The slow one is deliberately left in place on
          // nine ticks in ten, so its mtime says nothing about liveness.
          if (s.metric.file?.endsWith("home-server.prom")) collectorRanAt = value(s.value);
          break;
      }
    }

    failedSources.sort();
    return { collectorAt, collectorRanAt, serverNow, targetsUp, targetsTotal, failedSources };
  }, PULSE_POLL_MS);

  // A local clock that ticks, so ages advance between polls instead of
  // freezing at whatever they were when the request landed.
  const tick = ref(Date.now() / 1000);
  window.setInterval(() => {
    tick.value = Date.now() / 1000;
  }, 1000);

  /** Prometheus' clock where we have it, ours where we do not. */
  const now = computed(() => {
    const server = pulse.data.value?.serverNow;
    if (!Number.isFinite(server as number) || !Number.isFinite(pulse.lastOk.value)) return tick.value;
    return (server as number) + (tick.value - pulse.lastOk.value);
  });

  const doc = computed(() => status.data.value);

  const signedOut = computed(
    () => status.error.value instanceof SignedOutError || pulse.error.value instanceof SignedOutError,
  );

  /** The battery has never been written - a fresh host, not a broken one. */
  const statusNeverRun = computed(() => status.error.value instanceof StatusNeverWritten);

  /** True when Prometheus itself cannot be reached. Everything numeric on the
   *  page comes from it, so this is the one failure that greys the whole UI. */
  const prometheusDown = computed(() => pulse.error.value !== null && !signedOut.value);

  const statusFreshness = computed<Freshness>(() =>
    freshness("battery", isoToUnix(doc.value?.generated_at), now.value, STATUS_STALE_S),
  );

  const collectorFreshness = computed<Freshness>(() =>
    freshness("collector", pulse.data.value?.collectorAt ?? Number.NaN, now.value, COLLECTOR_STALE_S),
  );

  /** Did the collector RUN, as dated by node-exporter rather than by itself. */
  const collectorRunFreshness = computed<Freshness>(() =>
    freshness("collector run", pulse.data.value?.collectorRanAt ?? Number.NaN, now.value, COLLECTOR_STALE_S),
  );

  /** The sources reporting source_up 0, sorted. Empty is the normal case. */
  const failedSources = computed<string[]>(() => pulse.data.value?.failedSources ?? []);

  /**
   * ONE MAPPING, READ BY BOTH THE BANNER AND useStaleness. The phrasing
   * legitimately differs between them - the banner has a title and a detail,
   * the composable returns one line for PanelBox - but the DECISION must not,
   * or a panel ends up claiming the collector is fine under a banner saying it
   * is not. Same argument as checkTone() and seriesStyle().
   *
   * The order matters: each state's sentence has to be true in its own case,
   * and a frozen collector must not be described as merely degraded.
   */
  /** ONE MAPPING, READ BY BOTH THE BANNER AND useStaleness. The phrasing
   *  legitimately differs between them - the banner has a title and a detail,
   *  the composable returns one line for PanelBox - but the DECISION must not,
   *  or a panel ends up claiming the collector is fine under a banner saying it
   *  is not. Same argument as checkTone() and seriesStyle(). */
  const collectorState = computed<CollectorState>(() =>
    deriveCollectorState(collectorRunFreshness.value, collectorFreshness.value),
  );

  const targets = computed(() => ({
    up: pulse.data.value?.targetsUp ?? 0,
    total: pulse.data.value?.targetsTotal ?? 0,
  }));

  /**
   * The one thing the shell colours on. `unknown` is a real state and is NOT
   * folded into `fail`: "the battery says everything passed" and "nobody has
   * asked the battery" must not look the same.
   */
  const verdict = computed<"pass" | "warn" | "fail" | "unknown">(() => {
    if (prometheusDown.value || signedOut.value) return "unknown";
    if (statusFreshness.value.stale || collectorFreshness.value.stale) return "unknown";
    if (targets.value.total > 0 && targets.value.up < targets.value.total) return "fail";
    return doc.value?.summary.status ?? "unknown";
  });

  /** Everything that is not passing, worst first, in section order within a
   *  rank. This is the actionable strip and the findings list. */
  const problems = computed<Check[]>(() => {
    const checks = doc.value?.checks ?? [];
    const rank: Record<CheckStatus, number> = { fail: 0, warn: 1, note: 2, pass: 3 };
    return checks.filter((c) => c.status !== "pass").sort((a, b) => rank[a.status] - rank[b.status]);
  });

  /** Findings by id, for joining a Prometheus series back to its prose. */
  const byId = computed(() => {
    const map = new Map<string, Check>();
    for (const c of doc.value?.checks ?? []) map.set(c.id, c);
    return map;
  });

  function fact(key: string): string | number | boolean | null {
    return doc.value?.facts[key] ?? null;
  }

  function numericFact(key: string): number {
    const raw = fact(key);
    return typeof raw === "number" ? raw : Number.NaN;
  }

  /** Age in seconds of an ISO timestamp held in facts, e.g. backup_local_at. */
  function factAge(key: string): number {
    const raw = fact(key);
    if (typeof raw !== "string") return Number.NaN;
    return now.value - isoToUnix(raw);
  }

  return {
    doc,
    problems,
    byId,
    fact,
    numericFact,
    factAge,
    now,
    verdict,
    signedOut,
    statusNeverRun,
    prometheusDown,
    statusFreshness,
    collectorFreshness,
    collectorRunFreshness,
    collectorState,
    failedSources,
    targets,
    pending: computed(() => status.pending.value || pulse.pending.value),
    refresh: async () => {
      await Promise.all([status.refresh(), pulse.refresh()]);
    },
  };
});
