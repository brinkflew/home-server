// =============================================================================
// control.json - the switch alone, thirty seconds old instead of ten minutes
// -----------------------------------------------------------------------------
// A SECOND DOCUMENT FOR ONE OBJECT, AND CADENCE IS THE ONLY REASON. `fleet.json`
// carries `control` too and always will; it is written on the collector's
// five-minute slow tier and polled every five minutes, so the board could be ten
// minutes behind a command. That is fine for a round's progress and wrong for
// the one thing on the page a person measures against their own hand: they press
// disarm, watch the tile go on saying `armed`, and press it again.
//
// THIS IS A PRECEDENCE, NOT A SECOND DRAWING. The store prefers this file when
// it exists and its conduct_db source answered, and falls back to fleet.json
// otherwise - so exactly one value reaches `intakeSwitch()`, as before. The
// fallback is not defensive habit: the collector and this bundle deploy
// separately, and a board that required control.json would blank the control it
// exists to show for as long as the two halves disagreed.
// =============================================================================

import { fetchDocument } from "./document";
import type { ControlDocument } from "@/types";

const CONTROL_PATH = "/data/control.json";

export function fetchControl(signal?: AbortSignal): Promise<ControlDocument> {
  return fetchDocument<ControlDocument>(CONTROL_PATH, "control.json", signal);
}
