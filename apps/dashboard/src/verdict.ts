// =============================================================================
// The phase's own account, read rather than dumped
// -----------------------------------------------------------------------------
// `report.verdict` IS A JSON STRING AND THE PANEL SHOWED IT AS ONE. It is what
// the phase answered under `--json-schema` against one of four shapes in
// conduct/policy.py - VERDICT_SCHEMA for dev, PLAN_SCHEMA, REVIEW_SCHEMA,
// SHIP_SCHEMA - and the round page rendered it as `{"status": "done", "title":
// ...}` in a monospaced box under the heading "What the phase said it did".
//
// conduct ALREADY RENDERS THIS, IN card._verdict, AND THIS MIRRORS IT. The card
// on the same page has a "What the phase says it did" section built from the
// same string; the difference is that a phase with no card - anything before the
// ship stage - had only the raw dump. Mirroring rather than inventing keeps the
// two readings of one string from disagreeing.
//
// THREE OUTCOMES, NONE OF THEM SILENT, which is card._verdict's own rule: an
// absent verdict gets a sentence saying it is absent, because hiding a missing
// signal hides that it is missing. An answer that did not parse is shown
// VERBATIM - the pinned CLI can retract structured output through a model
// fallback, so a plain-text answer is a thing that happens and dropping it would
// lose the phase's only account of a run somebody is about to approve.
//
// types.ts SAYS "DO NOT PARSE IT" AND THAT STILL STANDS FOR WHAT IT MEANT. It
// forbids branching FLEET STATE on this string - the outcome is structural, from
// `published` and `pr_state` - not reading it for display. Nothing here decides
// anything; the fallback is the raw text, exactly as conduct's own renderer.
//
// PURE, SO fixtures/smoke.mjs CAN EXERCISE IT. Same rule as src/fleet.ts.
// =============================================================================

/** A value rendered under a label. Lists stay lists; nothing is joined. */
export type VerdictField =
  | { kind: "text"; label: string; text: string }
  | { kind: "list"; label: string; items: string[] }
  | { kind: "findings"; label: string; items: VerdictFinding[] };

/** A review finding, which is the one list shape carrying a severity. */
export interface VerdictFinding {
  title: string;
  detail: string | null;
  where: string | null;
  severity: string | null;
}

export interface VerdictView {
  /** `absent` nothing was recorded, `raw` it did not parse, `parsed` it did. */
  kind: "absent" | "raw" | "parsed";
  /** The sentence for `absent`, or the phase's own text for `raw`. */
  text: string | null;
  /** The one word the phase graded itself with, when it gave one. */
  status: string | null;
  summary: string | null;
  fields: VerdictField[];
}

/** The keys the four schemas name, with the label each is drawn under. */
const KNOWN: Array<[string, string]> = [
  ["blocked_reason", "blocked because"],
  ["reasoning", "why"],
  ["at_a_glance", "at a glance"],
  ["approach", "approach"],
  ["steps", "steps"],
  ["out_of_scope", "out of scope"],
  ["change_type", "change type"],
  ["slug", "branch slug"],
  ["title", "title"],
  ["changes", "changes"],
  ["notes", "notes"],
  ["verification", "verification"],
  ["concerns", "the phase raised these itself"],
  ["commits_before", "commits before"],
  ["commits_after", "commits after"],
];

/** Keys drawn elsewhere on the row, or by a shape of their own below. */
const HANDLED = new Set(["status", "summary", "findings", "follow_ups"]);

function asText(value: unknown): string | null {
  if (typeof value === "string") return value.trim() || null;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  return null;
}

function asList(value: unknown): string[] | null {
  if (!Array.isArray(value) || !value.length) return null;
  const items = value.map(asText).filter((s): s is string => Boolean(s));
  return items.length ? items : null;
}

function field(label: string, value: unknown): VerdictField | null {
  const list = asList(value);
  if (list) return { kind: "list", label, items: list };
  const text = asText(value);
  return text ? { kind: "text", label, text } : null;
}

/**
 * The findings a review phase produced, or null.
 *
 * THE ONE LIST WITH A SEVERITY. `dispatch.blocking()` selects error and warning
 * out of exactly this shape, so the severity is what decides whether a round
 * goes back for another attempt - it is worth a colour and the others are not.
 */
function findings(value: unknown): VerdictFinding[] | null {
  if (!Array.isArray(value) || !value.length) return null;
  const out: VerdictFinding[] = [];
  for (const item of value) {
    if (!item || typeof item !== "object") continue;
    const row = item as Record<string, unknown>;
    const title = asText(row.title);
    if (!title) continue;
    const file = asText(row.file);
    const line = asText(row.line);
    out.push({
      title,
      detail: asText(row.detail),
      where: file ? (line ? `${file}:${line}` : file) : null,
      severity: asText(row.severity),
    });
  }
  return out.length ? out : null;
}

/** The follow-ups, which are the one part of a verdict that does something. */
function followUps(value: unknown): string[] | null {
  if (!Array.isArray(value) || !value.length) return null;
  const out: string[] = [];
  for (const item of value) {
    if (typeof item === "string") {
      out.push(item);
      continue;
    }
    if (!item || typeof item !== "object") continue;
    const row = item as Record<string, unknown>;
    const title = asText(row.title);
    if (!title) continue;
    const why = asText(row.why);
    out.push(why ? `${title} - ${why}` : title);
  }
  return out.length ? out : null;
}

export function parseVerdict(raw: string | null | undefined): VerdictView {
  const empty: VerdictView = { kind: "absent", text: null, status: null, summary: null, fields: [] };
  if (!raw || !raw.trim()) {
    return {
      ...empty,
      text:
        "Nothing. A deterministic phase says nothing by construction; a model phase that says " +
        "nothing here either never reached its final message or answered outside the schema it " +
        "was given.",
    };
  }

  let answer: unknown;
  try {
    answer = JSON.parse(raw);
  } catch {
    answer = null;
  }
  if (!answer || typeof answer !== "object" || Array.isArray(answer)) {
    // VERBATIM, NOT SUMMARISED. This is the phase's only account of the run.
    return { ...empty, kind: "raw", text: raw };
  }

  const row = answer as Record<string, unknown>;
  const fields: VerdictField[] = [];

  const found = findings(row.findings);
  if (found) fields.push({ kind: "findings", label: "findings", items: found });

  for (const [key, label] of KNOWN) {
    const one = field(label, row[key]);
    if (one) fields.push(one);
  }

  // SHOWN BECAUSE APPROVING THIS FILES THEM. Everything else here is the phase
  // talking about work that is already done; these become tasks in somebody's
  // backlog the moment the pull request opens, so a person should see what they
  // are agreeing to put there. card._verdict makes the same argument.
  const later = followUps(row.follow_ups);
  if (later) fields.push({ kind: "list", label: "filed as tasks if this is published", items: later });

  // ANYTHING THE SCHEMAS GAIN IS STILL DRAWN. They move in another repository
  // and this bundle deploys separately, so a key nobody here has heard of must
  // appear under its own name rather than vanish - the alternative is a panel
  // that silently stops showing part of what a phase answered.
  const named = new Set([...KNOWN.map(([key]) => key), ...HANDLED]);
  for (const key of Object.keys(row)) {
    if (named.has(key)) continue;
    const one = field(key.replace(/_/g, " "), row[key]);
    if (one) fields.push(one);
  }

  return {
    kind: "parsed",
    text: null,
    status: asText(row.status),
    summary: asText(row.summary),
    fields,
  };
}
