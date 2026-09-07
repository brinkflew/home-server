// =============================================================================
// A phase's turns, as a conversation rather than a labelled dump
// -----------------------------------------------------------------------------
// WHAT ARRIVES IS AN ALLOWLIST, NOT A LOG. bin/collect-metrics.py keeps four
// shapes out of the raw container stdout and drops everything else - in
// particular every tool RESULT, which is where file contents and command output
// land - and then replaces every .env value of twelve characters or more. So
// nothing here re-redacts and nothing here should start: the host renders, this
// draws, and a guard in a browser is one an attacker has already got past.
//
// THE PANEL RENDERED `kind` AS A WORD AND THE PAYLOAD AS ITSELF. A tool call
// showed `Read {"file_path":"bin/lint-repo.sh","offset":40}`, a permission
// refusal showed the whole system event as JSON, and the prompt - which is
// thousands of bytes - sat in the same column as a one-line answer. All the
// information was there and none of it was legible.
//
// `input` IS `json.dumps` OF THE TOOL'S OWN INPUT, so it parses. What it parses
// INTO is the CLI's tool schema, which lives in another program entirely: every
// reader below is defensive, every unknown tool falls back to naming its own
// keys, and nothing throws on a shape that has moved. A transcript that failed
// to render would be worse than one that renders plainly.
//
// PURE, SO fixtures/smoke.mjs CAN EXERCISE IT. Same rule as src/fleet.ts.
// =============================================================================

import type { RoundTurn } from "@/types";

/** At most this many diff lines before the rest becomes a count. */
export const DIFF_LINES = 5;

/** One line of an edit, as the two sides differ. */
export interface DiffLine {
  sign: "-" | "+";
  text: string;
}

/** What one turn says, once it has been read rather than dumped. */
export interface TurnView {
  /** `you` the prompt, `agent` an assistant turn, `tool`, `denied`, `note`. */
  who: "you" | "agent" | "tool" | "denied" | "note";
  /** The tool's name, or null. Drawn as a chip. */
  tool: string | null;
  /** The one line that says what happened. Never null for a tool. */
  headline: string;
  /** Prose, rendered as markdown for an assistant turn. */
  body: string | null;
  /** A short diff for an edit, or null. */
  diff: DiffLine[] | null;
  /** How many diff lines were not shown. */
  diffMore: number;
  /** The whole input, behind a disclosure. Null when the headline IS all of it. */
  detail: string | null;
}

function clip(text: string, limit: number): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > limit ? `${flat.slice(0, limit - 1)}...` : flat;
}

function readInput(raw: string | undefined): Record<string, unknown> | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

function str(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value : null;
}

/**
 * The two sides of an edit, as at most five lines.
 *
 * NO DEPENDENCY AND NO LCS. `Edit` hands over the whole `old_string` and
 * `new_string`, so the useful reduction is trimming the lines the two have in
 * common at each end - which is what makes a one-word change show as one line
 * rather than as forty - and then printing removals and additions. A real diff
 * algorithm would interleave them better and would be a library on a page whose
 * whole argument is that it does not need one.
 *
 * THE CAP IS A CAP, NOT A SUMMARY. What is left over is counted and said, so a
 * reader knows the shown lines are the beginning of something rather than the
 * whole of it. Opening the disclosure has the input verbatim either way.
 */
export function shortDiff(
  before: string,
  after: string,
  limit = DIFF_LINES,
): { lines: DiffLine[]; more: number } {
  const oldLines = before.split("\n");
  const newLines = after.split("\n");

  let head = 0;
  while (head < oldLines.length && head < newLines.length && oldLines[head] === newLines[head]) {
    head += 1;
  }
  let tail = 0;
  while (
    tail < oldLines.length - head &&
    tail < newLines.length - head &&
    oldLines[oldLines.length - 1 - tail] === newLines[newLines.length - 1 - tail]
  ) {
    tail += 1;
  }

  const removed = oldLines.slice(head, oldLines.length - tail);
  const added = newLines.slice(head, newLines.length - tail);
  const all: DiffLine[] = [
    ...removed.map((text) => ({ sign: "-" as const, text })),
    ...added.map((text) => ({ sign: "+" as const, text })),
  ];
  return { lines: all.slice(0, limit), more: Math.max(0, all.length - limit) };
}

/** The last segment of a path, with enough of its parent to place it. */
function shortPath(path: string): string {
  const parts = path.split("/").filter(Boolean);
  return parts.length <= 2 ? path : `.../${parts.slice(-2).join("/")}`;
}

/** A tool nobody here has heard of, named by its own keys. */
function generic(input: Record<string, unknown>): string {
  const parts: string[] = [];
  for (const [key, value] of Object.entries(input)) {
    if (typeof value === "object" && value !== null) continue;
    parts.push(`${key} ${clip(String(value), 60)}`);
    if (parts.length === 3) break;
  }
  return parts.join(", ") || "no input";
}

/** One tool call, read. */
function describeTool(name: string, raw: string | undefined): TurnView {
  const input = readInput(raw);
  const view: TurnView = {
    who: "tool",
    tool: name,
    headline: "",
    body: null,
    diff: null,
    diffMore: 0,
    detail: raw && raw.length > 2 ? raw : null,
  };
  if (!input) {
    // NOT AN ERROR AND NOT AN EMPTY CALL. The collector clips a very long input
    // at 20,000 bytes, which leaves valid JSON truncated into invalid JSON.
    view.headline = raw ? clip(raw, 160) : "no input recorded";
    return view;
  }

  const path = str(input.file_path) ?? str(input.path) ?? str(input.notebook_path);
  switch (name) {
    case "Read":
    case "NotebookEdit":
      view.headline = path ? shortPath(path) : generic(input);
      view.detail = null;
      break;
    case "Glob":
    case "Grep": {
      const pattern = str(input.pattern) ?? "";
      const where = str(input.path);
      view.headline = where ? `${pattern} in ${shortPath(where)}` : pattern || generic(input);
      break;
    }
    case "Bash": {
      const command = str(input.command) ?? "";
      const first = command.split("\n")[0];
      const said = str(input.description);
      view.headline = said ? `${said} - ${clip(first, 100)}` : clip(first, 140);
      // THE WHOLE COMMAND ONLY WHEN IT IS MORE THAN THE HEADLINE. A one-line
      // command with no description is entirely visible already, and a
      // disclosure onto the same text is a control that does nothing.
      view.detail = command.includes("\n") || command.length > 140 ? command : null;
      break;
    }
    case "Write": {
      const content = str(input.content) ?? "";
      const lines = content.split("\n");
      view.headline = `${path ? shortPath(path) : "a file"} - ${lines.length} line(s)`;
      view.diff = lines.slice(0, DIFF_LINES).map((text) => ({ sign: "+" as const, text }));
      view.diffMore = Math.max(0, lines.length - DIFF_LINES);
      break;
    }
    case "Edit": {
      const before = str(input.old_string) ?? "";
      const after = str(input.new_string) ?? "";
      const { lines, more } = shortDiff(before, after);
      view.headline = path ? shortPath(path) : "an edit";
      view.diff = lines;
      view.diffMore = more;
      break;
    }
    case "MultiEdit": {
      const edits = Array.isArray(input.edits) ? input.edits : [];
      const first = (edits[0] ?? {}) as Record<string, unknown>;
      const { lines, more } = shortDiff(str(first.old_string) ?? "", str(first.new_string) ?? "");
      view.headline =
        `${path ? shortPath(path) : "a file"} - ${edits.length} edit(s)` +
        (edits.length > 1 ? `, showing the first` : "");
      view.diff = lines;
      view.diffMore = more;
      break;
    }
    case "Task": {
      const kind = str(input.subagent_type);
      const said = str(input.description);
      view.headline = [kind, said].filter(Boolean).join(" - ") || generic(input);
      break;
    }
    case "TodoWrite": {
      const todos = Array.isArray(input.todos) ? input.todos : [];
      view.headline = `${todos.length} item(s)`;
      break;
    }
    case "WebFetch":
    case "WebSearch":
      view.headline = str(input.url) ?? str(input.query) ?? generic(input);
      break;
    default:
      view.headline = generic(input);
  }
  if (!view.headline) view.headline = generic(input);
  return view;
}

/**
 * A refused permission, named.
 *
 * `text` IS `json.dumps` OF THE WHOLE SYSTEM EVENT, which is how the collector
 * keeps a shape it does not model. It is the fleet's own record of a boundary
 * holding - the one shape in a transcript that is a finding rather than chatter
 * - so it earns a colour, and burying which tool was refused inside a JSON blob
 * is the opposite of earning it.
 */
function describeDenied(text: string | undefined): TurnView {
  const view: TurnView = {
    who: "denied",
    tool: null,
    headline: "a tool call was refused",
    body: null,
    diff: null,
    diffMore: 0,
    detail: text ?? null,
  };
  const event = readInput(text);
  if (!event) return view;
  const tool = str(event.tool) ?? str(event.tool_name);
  const why = str(event.reason) ?? str(event.message) ?? str(event.permission_suggestions);
  view.tool = tool;
  view.headline = why ? clip(why, 200) : tool ? `${tool} was refused` : view.headline;
  return view;
}

/** One turn, as the page draws it. */
export function describeTurn(turn: RoundTurn): TurnView {
  switch (turn.kind) {
    case "tool":
      return describeTool(turn.name ?? "?", turn.input);
    case "denied":
      return describeDenied(turn.text);
    case "ask":
      return {
        who: "you",
        tool: null,
        headline: "prompt",
        body: turn.text ?? "",
        diff: null,
        diffMore: 0,
        detail: null,
      };
    case "note":
      // THE RENDERER SPEAKING ABOUT ITS OWN LIMITS, and it must not look like
      // the model. "log truncated at 12000000 bytes" drawn as an assistant turn
      // is the collector's sentence attributed to the phase.
      return {
        who: "note",
        tool: null,
        headline: turn.text ?? "",
        body: null,
        diff: null,
        diffMore: 0,
        detail: null,
      };
    default:
      return {
        who: "agent",
        tool: null,
        headline: "",
        body: turn.text ?? "",
        diff: null,
        diffMore: 0,
        detail: null,
      };
  }
}
