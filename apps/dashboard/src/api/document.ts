// =============================================================================
// How a collector document is fetched, in one place
// -----------------------------------------------------------------------------
// Lifted out of api/media.ts unchanged when fleet.json became the third
// document. There is nothing new here - it is the same two rules media.ts has
// always carried - but there are now three callers, and both rules are the kind
// that fail silently when one caller gets them slightly differently:
//
//   1. THE CACHE BUST IS NOT BELT AND BRACES. Every document is served with
//      `Cache-Control: no-store` by the dashboard's own Caddyfile, and a 304
//      from anything in between would still let a frozen document read as
//      current. status.ts makes the identical argument for status.json.
//
//   2. A 404 IS NOT A FAILURE. It means the collector has never written this
//      file here - a fresh host, or a source that has not run - which is a
//      different finding from "the fetch broke", and the page says so in
//      different words. Folding the two together is the shape of mistake this
//      whole application is written around.
// =============================================================================

import { fetchJson, HttpError } from "./http";

/**
 * Distinguishable from a fetch failure: the collector has not written this here.
 * On a fresh host that means the timer has not run yet, which is a different
 * thing from broken - the same distinction StatusNeverWritten draws.
 */
export class DocumentNeverWritten extends Error {
  readonly doc: string;

  constructor(doc: string) {
    super(`${doc} has not been written yet`);
    this.name = "DocumentNeverWritten";
    this.doc = doc;
  }
}

export async function fetchDocument<T>(
  path: string,
  name: string,
  signal?: AbortSignal,
): Promise<T> {
  try {
    return await fetchJson<T>(`${path}?t=${Date.now()}`, { signal });
  } catch (error) {
    if (error instanceof HttpError && error.status === 404) throw new DocumentNeverWritten(name);
    throw error;
  }
}
