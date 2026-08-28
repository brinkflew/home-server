// =============================================================================
// fleet.json, its freshness, and what is waiting on a person
// -----------------------------------------------------------------------------
// A STORE RATHER THAN usePoll IN THE PAGE, for the reason stores/media.ts
// already gives and which matters more here: usePoll resets `lastOk` on
// unmount, and `lastOk` is the clock staleness is measured against. A
// page-level poll would restart that clock on every visit to /agents, so a
// document that stopped being written three hours ago would read as fresh the
// moment somebody opened the page - which is the exact failure this repository
// is written around, in the one place a reader goes to find out whether the
// fleet is stuck.
//
// So App.vue instantiates it at the shell, like useHostStore and useMediaStore.
// The cost is one static-file fetch every five minutes while sitting on another
// page, and usePoll stops entirely when the tab is hidden.
// =============================================================================

import { computed } from "vue";
import { defineStore } from "pinia";

import { usePoll } from "@/composables/usePoll";
import { DocumentNeverWritten } from "@/api/document";
import { fetchFleet } from "@/api/fleet";
import { SignedOutError } from "@/api/http";
import { freshness, type Freshness } from "@/freshness";
import { coarse, isoToUnix } from "@/format";
import { useHostStore } from "@/stores/host";
import type { FleetDocument, FleetNotice, FleetRound } from "@/types";

/** The collector's slow tier. */
const FLEET_POLL_MS = 300_000;

/** Four missed writes, the same principle stores/media.ts derives its two
 *  thresholds from rather than guessing them. */
const FLEET_STALE_S = 1200;

export const useFleetStore = defineStore("fleet", () => {
  const host = useHostStore();

  const poll = usePoll<FleetDocument>((signal) => fetchFleet(signal), FLEET_POLL_MS);

  const doc = computed(() => poll.data.value);
  const signedOut = computed(() => poll.error.value instanceof SignedOutError);

  /** A fresh host, or a collector whose fleet source has never run. Not broken. */
  const neverRun = computed(() => poll.error.value instanceof DocumentNeverWritten);

  /** From the document's own generated_at, NOT from a Prometheus mirror of it,
   *  so a dead collector and a dead scrape stay distinguishable. */
  const fleetFreshness = computed<Freshness>(() =>
    freshness("fleet", isoToUnix(doc.value?.generated_at), host.now, FLEET_STALE_S),
  );

  const stale = computed(() => {
    if (neverRun.value) return "the fleet document has not been written on this host";
    const f = fleetFreshness.value;
    if (f.missing) return "fleet.json could not be read";
    if (f.stale) return `the fleet was last read ${coarse(f.age)} ago`;
    return null;
  });

  /**
   * "conduct.db could not be read; rounds are absent, not zero."
   *
   * THE WHOLE REASON `sources` IS MANDATORY. A locked or missing database and a
   * fleet with nothing open produce the identical empty list, and a page
   * rendering that as "nothing in flight" would be confidently wrong about the
   * one question it exists to answer.
   */
  const sourceNotes = computed(() => {
    const notes: string[] = [];
    for (const [name, health] of Object.entries(doc.value?.sources ?? {})) {
      if (!health.ok) {
        notes.push(`${name} did not answer in this run; its rows are absent, not zero`);
      }
    }
    return notes;
  });

  /** True when the document was written but conduct's database was unreadable -
   *  which must never render as an idle fleet. */
  const dbUnreadable = computed(() => doc.value !== null && !(doc.value.sources.conduct_db?.ok ?? false));

  const rounds = computed<FleetRound[]>(() => doc.value?.rounds ?? []);
  const publications = computed(() => doc.value?.publications ?? []);
  const notices = computed<FleetNotice[]>(() => doc.value?.notices ?? []);
  const runs = computed(() => doc.value?.runs ?? []);
  const intake = computed(() => doc.value?.intake ?? []);
  const totals = computed(() => doc.value?.totals ?? null);

  /**
   * The rounds a PERSON owes an answer to, which is the loudest thing the page
   * can say. Keyed on `waiting_on`, which the collector derived from the module
   * id prefix - never on the notice's wording.
   */
  const waitingOnPerson = computed(() => rounds.value.filter((r) => r.waiting_on === "person"));

  /**
   * Notices a person owes an answer to that no open round accounts for.
   *
   * NOT A TIDINESS FILTER. chain.flow_job_id is the job that stopped rather than
   * the one running, so a notice can legitimately fail to match any round - and
   * dropping it would hide an unanswered approval, which is the one thing on
   * this page that must never be hidden.
   */
  const orphanNotices = computed(() => {
    const claimed = new Set(waitingOnPerson.value.map((r) => r.flow_job_id));
    return notices.value.filter((n) => n.waiting_on === "person" && !claimed.has(n.flow_job_id));
  });

  const pending = computed(() => poll.pending.value);

  return {
    doc,
    fleetFreshness,
    stale,
    neverRun,
    signedOut,
    sourceNotes,
    dbUnreadable,
    rounds,
    publications,
    notices,
    runs,
    intake,
    totals,
    waitingOnPerson,
    orphanNotices,
    pending,
    refresh: poll.refresh,
  };
});
