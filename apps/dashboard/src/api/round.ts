// =============================================================================
// One round's own document, fetched when somebody opens it
// -----------------------------------------------------------------------------
// THE FIRST NON-POLLED READ IN THIS APPLICATION, and deliberately so. Every
// other document here is on a `usePoll` because every other document is on the
// page whether or not anybody looks at it. A round's detail is ~400 KB and there
// are forty of them: polling would be sixteen megabytes a tick to render one
// panel that is usually closed.
//
// `usePoll` COULD NOT DO IT ANYWAY - it fires immediately on construction, so a
// handle built per row would fetch every round the moment the board rendered,
// which is the thing being avoided.
//
// A 404 IS NOT A FAILURE AND MUST NOT RENDER AS ONE. The collector writes these
// on its five-minute tier under a per-run log budget, so a round can be on the
// board minutes before its document exists, and a round older than the sweep's
// horizon has had its document removed on purpose. `fetchDocument` already
// distinguishes that case as `DocumentNeverWritten`; the panel says "not yet".
// =============================================================================

import { fetchDocument } from "./document";
import type { RoundDocument } from "@/types";

/**
 * The key the collector names a file by: worktree id, then the round's start
 * with its punctuation stripped.
 *
 * BUILT HERE FROM THE BOARD'S OWN ROW rather than carried in `fleet.json`,
 * because the two would then be a pair that can disagree - and the pair that
 * disagreed last time cost a blank board. `_round_key` in
 * bin/collect-metrics.py is the other half of this and the two are asserted
 * against each other in fixtures/smoke.mjs.
 */
export function roundKey(worktreeId: string, startedAt: string | null): string | null {
  if (!worktreeId || !startedAt) return null;
  return `${worktreeId}-${startedAt.replace(/[-:]/g, "")}`;
}

export function fetchRound(key: string, signal?: AbortSignal): Promise<RoundDocument> {
  return fetchDocument<RoundDocument>(`/data/round-${key}.json`, `round-${key}.json`, signal);
}
