// =============================================================================
// The quota hold's override, and this browser's memory of asking for it
// -----------------------------------------------------------------------------
// THE SAME SHAPE AS useIntake AND FOR THE SAME TWO REASONS. The state word, the
// chip's label, the command it sends and whether an ask is still outstanding
// come off ONE derivation - src/control.ts's quotaHold() - so a chip reading
// `spend` cannot send `quota_pace`. And a command leaves no trace anywhere the
// collector can read, so the fact that this browser asked is remembered here.
//
// WHAT IT IS NOT IS A SWITCH. conduct holds the fleet at the API's
// `allowed_warning` by default so that what is left is left for the person's own
// sessions; this says there are no sessions to leave it for. It moves the level
// to `rejected` and no further, so a refusal still stops the fleet whatever
// anybody asked - which is the floor that makes lifting the warning safe.
//
// AND IT EXPIRES BY ITSELF. The row's value is the API's own `resetsAt` for the
// window it was granted against, so an override cannot outlive that window and
// there is nothing anybody has to remember to undo. Every other hold in this
// fleet has that property; one that did not would be the first.
// =============================================================================

import { computed, ref, watch, type ComputedRef } from "vue";

import * as fmt from "@/format";
import { control } from "@/api/control";
import { askAge, quotaHold, type QuotaHold, type RememberedAsk } from "@/control";
import { useFleetStore } from "@/stores/fleet";
import { useHostStore } from "@/stores/host";

/**
 * THE SUBJECT IS THE ACCOUNT AND SO THERE IS NO PROJECT IN THE KEY. conduct's
 * `state.quota_name()` takes no argument for the same reason its `last_quota` is
 * global: the quota is the account's, and a per-project answer would be two
 * projects disagreeing about a window neither of them owns.
 */
const ASK_KEY = "home-server.ask.quota";

function readAsk(): RememberedAsk | null {
  try {
    const raw = sessionStorage.getItem(ASK_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<RememberedAsk>;
    // Shape-checked, because this outlives a deploy: a value written by an older
    // bundle must read as no memory rather than throw here.
    return typeof parsed?.at === "number" && typeof parsed?.action === "string"
      ? { action: parsed.action, at: parsed.at }
      : null;
  } catch {
    return null;
  }
}

export interface QuotaControl {
  /** The one derivation the chip and its sentence both read. */
  state: ComputedRef<QuotaHold>;
  /** Seconds an ask has stood, or null once the fleet has been seen carrying it out. */
  askedFor: ComputedRef<number | null>;
  /** Why the chip cannot be pressed, as a sentence, or null. */
  disabled: ComputedRef<string | null>;
  toggle: () => Promise<void>;
}

/**
 * IT TAKES NO `midPhase`, WHERE useIntake DOES, and the asymmetry is on purpose:
 * that half of the sentence belongs to quotaSub below, which the page composes.
 * Both quota actions are in conduct's `MIDPHASE_ACTIONS`, so a command sent
 * while a phase is running is answered from inside it - latency, never loss.
 */
export function useQuotaHold(): QuotaControl {
  const host = useHostStore();
  const fleet = useFleetStore();

  // host.now RATHER THAN Date.now(), which is what makes this tick: the store's
  // clock is corrected against the document's own, so a browser an hour out
  // cannot read a live override as an expired one.
  const state = computed(() => quotaHold(fleet.control, host.now));

  const remembered = ref<RememberedAsk | null>(readAsk());
  const askedFor = computed(() => askAge(remembered.value, state.value.action, host.now));

  // Forget it the moment it stops standing, so a later mount does not re-read a
  // memory askAge has already retired.
  watch(askedFor, (age) => {
    if (age !== null || remembered.value === null) return;
    remembered.value = null;
    try {
      sessionStorage.removeItem(ASK_KEY);
    } catch {
      // Nothing to clear, which is the same outcome.
    }
  });

  const disabled = computed(() =>
    fleet.control.available
      ? null
      : "the control route has no token - see WINDMILL_DASHBOARD_TOKEN",
  );

  async function toggle(): Promise<void> {
    // The action the chip is LABELLED with, read rather than re-derived. Two
    // ternaries over one boolean agree only for as long as somebody keeps them
    // agreeing, and the failure is a button that does the opposite of what it
    // reads.
    const asked = state.value.action;
    await control({ action: asked });
    // After the POST and only on success: a command that never reached Windmill
    // is not outstanding, it failed, and the chip says so itself.
    remembered.value = { action: asked, at: Math.floor(Date.now() / 1000) };
    try {
      sessionStorage.setItem(ASK_KEY, JSON.stringify(remembered.value));
    } catch {
      // A private window. The in-memory ref still carries it for this mount.
    }
    // ASKED, NOT DONE. conduct applies it on its next cycle, and it can refuse -
    // there is nothing to override when no phase has reported a reading - so the
    // honest way to learn what happened is the next document rather than an
    // optimistic local flip.
    await fleet.refresh();
  }

  return { state, askedFor, disabled, toggle };
}

/**
 * The window's own sentence: when it comes back, or when it came back.
 *
 * PURE, AND OUT HERE RATHER THAN IN THE PAGE, for the reason src/fleet.ts opens
 * with: this lived inline in RoundsPage.vue as a four-line computed, which
 * fixtures/smoke.mjs cannot reach, so neither direction had ever been asserted.
 *
 * BOTH DIRECTIONS, AND THE SECOND ONE IS WHY THIS EXISTS. It used to be
 * `clears in 2d` or null, so a window that had ROLLED OVER produced null and
 * quotaSub's fallback captioned the fleet's most recent reading "no window
 * recorded" - while the reset time it needed was in the marker, in the store,
 * and rendered in the tooltip one line down. A window that has ended is the best
 * news a hold can get; it was being reported as an absence of evidence.
 *
 * NO ABSOLUTE STAMP, and that is not a style choice. The host runs UTC and the
 * household does not, so a rendered `2026-08-31T14:00:00Z` is a number a person
 * has to convert before it means anything. Every other clock on this page is a
 * duration for the same reason.
 */
export function quotaWindow(resetsAt: number | undefined, nowUnix: number): string | null {
  if (resetsAt === undefined || !Number.isFinite(resetsAt) || !Number.isFinite(nowUnix)) {
    return null;
  }
  return resetsAt > nowUnix
    ? `clears in ${fmt.coarse(resetsAt - nowUnix)}`
    : `rolled over ${fmt.coarse(nowUnix - resetsAt)} ago`;
}

/**
 * The line under the quota reading, composed here because it is this page's
 * sentence rather than the derivation's.
 *
 * `clears in 2d` WAS THE WHOLE LINE AND IT READ AS A COUNTDOWN TO RESUMPTION,
 * which is exactly what it meant until an override could exist. It is still the
 * right countdown - the window comes back when it comes back - so it is kept and
 * prefixed rather than replaced.
 *
 * THE PARAMETER IS THE WINDOW AND NOT THE COUNTDOWN. It was named `clears` while
 * it could only ever say "clears in ...", and quotaWindow above now answers in
 * both directions; a name that describes one of the two branches is how the
 * fallback below came to speak for a window that exists.
 */
export function quotaSub(
  hold: QuotaHold,
  windowLine: string | null,
  rejected: boolean,
  askedFor: number | null,
  midPhase: boolean,
): string {
  if (askedFor !== null) {
    const waiting = midPhase ? " - conduct is mid-phase, and answers this from inside it" : "";
    return `${hold.label} asked ${fmt.coarse(askedFor)} ago${waiting}`;
  }
  if (!hold.spending) return windowLine ?? "no window recorded";
  // THE COMBINATION THAT SURPRISES PEOPLE, and the one worth the longer
  // sentence: the warning hold is lifted and the fleet is stopped anyway,
  // because lifting it moves the level to a rejection and no further.
  const head = rejected ? "spending, but the API is refusing" : "spending the headroom";
  return windowLine ? `${head} - ${windowLine}` : head;
}
