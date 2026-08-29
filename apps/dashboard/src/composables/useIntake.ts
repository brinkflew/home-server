// =============================================================================
// The intake switch, and this browser's memory of asking for it
// -----------------------------------------------------------------------------
// THE SWITCH IS DRAWN TWICE ON PURPOSE and that is exactly why this exists. The
// board answers "is the fleet armed"; the fleet page answers "who said so, and
// why". They are different questions and both are worth a place - but the state
// word, the tone, the chip's label, the command it sends and whether an ask is
// still outstanding must be ONE derivation, or a chip reading `arm` on one page
// can send `intake_off` from the other.
//
// src/control.ts's intakeSwitch() is the half that decides. This is the half
// that remembers, because a command leaves no trace anywhere the collector can
// read: nothing on the host records that a browser asked, and the collector
// deliberately does not grow a Windmill dependency to find out.
// =============================================================================

import { computed, ref, watch, type ComputedRef, type Ref } from "vue";

import * as fmt from "@/format";
import { control } from "@/api/control";
import { askAge, intakeSwitch, type IntakeSwitch, type RememberedAsk } from "@/control";
import { useFleetStore } from "@/stores/fleet";
import { useHostStore } from "@/stores/host";

const PROJECT = "upskald";

/**
 * What this browser last asked for, across a reload.
 *
 * sessionStorage IS THE RIGHT SIZE FOR IT: one person's own click, not a fact
 * about the fleet. The same store api/http.ts already uses for its reauth
 * rate-limit, and every access is wrapped for the same reason - a private
 * window or disabled storage must degrade to "no memory", never to a broken
 * page.
 */
const ASK_KEY = `home-server.ask.intake:${PROJECT}`;

function readAsk(): RememberedAsk | null {
  try {
    const raw = sessionStorage.getItem(ASK_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<RememberedAsk>;
    // SHAPE-CHECKED, because this outlives a deploy: a value written by an
    // older bundle must read as no memory rather than throw here.
    return typeof parsed?.at === "number" && typeof parsed?.action === "string"
      ? { action: parsed.action, at: parsed.at }
      : null;
  } catch {
    return null;
  }
}

export interface IntakeControl {
  /** The one derivation both drawings read. */
  state: ComputedRef<IntakeSwitch>;
  /** Seconds an ask has stood, or null once the fleet has been seen doing it. */
  askedFor: ComputedRef<number | null>;
  /** Why the chip cannot be pressed, as a sentence, or null. */
  disabled: ComputedRef<string | null>;
  /** The line under the switch: the ask if one stands, else who set it. */
  sub: ComputedRef<string>;
  toggle: () => Promise<void>;
}

/**
 * @param midPhase whether conduct is inside a phase right now. It answers a
 *   command from within its own 15s tick, so this is latency rather than loss -
 *   but a person who has waited two minutes deserves to be told which it is.
 */
export function useIntake(midPhase: Ref<boolean>): IntakeControl {
  const host = useHostStore();
  const fleet = useFleetStore();

  // ONE VALUE, FROM WHICHEVER DOCUMENT CAN SPEAK FOR IT. The store decides
  // between control.json (30s) and fleet.json (up to 10 minutes) and hands back
  // a single object, so nothing here has to know there are two.
  const state = computed(() => intakeSwitch(fleet.control, PROJECT));

  const remembered = ref<RememberedAsk | null>(readAsk());
  const askedFor = computed(() => askAge(remembered.value, state.value.action, host.now));

  // FORGET IT THE MOMENT IT STOPS STANDING, so a later mount does not re-read a
  // memory `askAge` has already retired. The derivation decides; this only
  // records what it decided.
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

  const sub = computed(() => {
    if (askedFor.value !== null) {
      const waiting = midPhase.value
        ? " - conduct is mid-phase, and answers this from inside it"
        : "";
      return `${state.value.label} asked ${fmt.coarse(askedFor.value)} ago${waiting}`;
    }
    return state.value.source === "set"
      ? `set by hand ${fmt.sinceIso(state.value.at)}`
      : "conduct's own default";
  });

  async function toggle(): Promise<void> {
    // THE ACTION IS THE ONE THE CHIP IS LABELLED WITH, read rather than
    // re-derived. Two ternaries over one boolean agree only for as long as
    // somebody keeps them agreeing, and the failure is a button that does the
    // opposite of what it reads.
    const asked = state.value.action;
    await control({ action: asked, project: PROJECT });
    // AFTER THE POST AND ONLY ON SUCCESS. A command that never reached Windmill
    // is not outstanding, it failed, and the chip says so itself.
    remembered.value = { action: asked, at: Math.floor(Date.now() / 1000) };
    try {
      sessionStorage.setItem(ASK_KEY, JSON.stringify(remembered.value));
    } catch {
      // A private window. The in-memory ref still carries it for this mount.
    }
    // ASKED, NOT DONE. conduct applies it on its next cycle, so the honest way
    // to learn what happened is the next document rather than an optimistic
    // local flip - which would show `armed` over a fleet that had refused.
    await fleet.refresh();
  }

  return { state, askedFor, disabled, sub, toggle };
}
