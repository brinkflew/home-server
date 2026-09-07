// =============================================================================
// Markdown, as much of it as conduct writes and no more
// -----------------------------------------------------------------------------
// THE CARD IS MARKDOWN AND WAS RENDERED IN A `<pre>`. `conduct/card.py` builds
// around 7,500 bytes of headings, bullets, links and inline code - the text
// somebody is actually approving - and the round page showed it as monospaced
// source with the syntax still in it. That is the one panel on this page whose
// whole job is to be read.
//
// HAND-ROLLED, AND THE SECOND REASON IS THE ONE THAT DECIDES IT. The first is
// this repository's own precedent: no chart library, because matching the design
// exactly costs less than bending a library into it. The second is that the card
// is MODEL OUTPUT. `marked` returns an HTML string, which means `v-html`, which
// means a sanitiser beside it and a page behind the household's passkey that is
// one mistake away from executing whatever a phase wrote. A parser that returns
// a token tree Vue renders through ordinary elements cannot inject anything at
// all - there is no HTML string anywhere in this path.
//
// SO THIS IS A SUBSET, DELIBERATELY, AND UNKNOWN SYNTAX DEGRADES TO TEXT. It
// never throws and it never drops a line: anything it does not recognise is
// still shown, as the characters that were written. A renderer that swallowed a
// construct would be hiding part of the text somebody is approving, which is
// worse than showing them a stray asterisk.
//
// PURE, SO fixtures/smoke.mjs CAN EXERCISE IT. Same rule as src/fleet.ts.
// =============================================================================

/** A run of inline content. `code` is a span, never a block. */
export type Inline =
  | { kind: "text"; text: string }
  | { kind: "code"; text: string }
  | { kind: "strong"; text: string }
  | { kind: "em"; text: string }
  | { kind: "link"; text: string; href: string };

export type Block =
  | { kind: "heading"; level: number; inline: Inline[] }
  | { kind: "paragraph"; inline: Inline[] }
  | { kind: "list"; ordered: boolean; items: Inline[][] }
  | { kind: "code"; lang: string | null; text: string }
  | { kind: "quote"; inline: Inline[] }
  | { kind: "rule" };

/**
 * Schemes a rendered link may carry.
 *
 * AN ALLOWLIST, NOT A `javascript:` DENYLIST. `JaVaScRiPt:`, a tab inside the
 * scheme and `data:text/html` are three ways past a denylist, and the set of
 * things a card legitimately links to is two entries long - `conduct/card.py`
 * writes a GitHub compare URL and nothing else. Anything else renders as its own
 * text, so the destination is still visible and is not clickable.
 */
const SCHEMES = ["http://", "https://"];

export function safeHref(raw: string): string | null {
  const href = raw.trim();
  const lower = href.toLowerCase();
  return SCHEMES.some((scheme) => lower.startsWith(scheme)) ? href : null;
}

// ORDER MATTERS AND CODE IS FIRST. A backtick span may contain asterisks,
// brackets and underscores - `**/*.ts` is a real path and appears in these cards
// - and emphasis found inside one would split a literal the author quoted
// precisely so it would not be interpreted.
const INLINE_RE =
  /(`[^`]+`)|(\[[^\]\n]*\]\([^)\s]+\))|(\*\*[^*\n]+\*\*)|(\*[^*\n]+\*)|(_[^_\n]+_)/;

/** One line of text as a run of inline nodes. Never empty for a non-empty line. */
export function parseInline(line: string): Inline[] {
  const out: Inline[] = [];
  let rest = line;
  const push = (text: string) => {
    if (text) out.push({ kind: "text", text });
  };

  for (;;) {
    const found = INLINE_RE.exec(rest);
    if (!found || found.index === undefined) break;
    push(rest.slice(0, found.index));
    const token = found[0];
    if (token.startsWith("`")) {
      out.push({ kind: "code", text: token.slice(1, -1) });
    } else if (token.startsWith("[")) {
      const split = token.indexOf("](");
      const text = token.slice(1, split);
      const href = safeHref(token.slice(split + 2, -1));
      // A REFUSED SCHEME KEEPS ITS TEXT AND LOSES ITS HREF. Dropping the node
      // would hide a destination somebody is being asked to trust.
      if (href) out.push({ kind: "link", text: text || href, href });
      else push(token);
    } else if (token.startsWith("**")) {
      out.push({ kind: "strong", text: token.slice(2, -2) });
    } else {
      out.push({ kind: "em", text: token.slice(1, -1) });
    }
    rest = rest.slice(found.index + token.length);
  }
  push(rest);
  return out.length ? out : [{ kind: "text", text: "" }];
}

const HEADING_RE = /^(#{1,6})\s+(.*)$/;
const BULLET_RE = /^\s*[-*+]\s+(.*)$/;
const ORDERED_RE = /^\s*\d+[.)]\s+(.*)$/;
const RULE_RE = /^\s*([-*_])\s*\1\s*\1[\s\-*_]*$/;
const FENCE_RE = /^\s*```\s*(\S*)\s*$/;
const QUOTE_RE = /^\s*>\s?(.*)$/;

/**
 * The card, as blocks.
 *
 * LINE-ORIENTED, WHICH IS WHAT THE INPUT IS. conduct builds these by joining
 * lines; there is no nesting, no table, no reference link and no inline HTML in
 * anything `card.py` writes. Adding a construct here means the card gained one,
 * and the fixture should gain it in the same change.
 */
export function parseMarkdown(source: string): Block[] {
  const blocks: Block[] = [];
  const lines = (source ?? "").replace(/\r\n?/g, "\n").split("\n");
  let paragraph: string[] = [];

  const flush = () => {
    if (!paragraph.length) return;
    blocks.push({ kind: "paragraph", inline: parseInline(paragraph.join(" ")) });
    paragraph = [];
  };

  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];

    const fence = FENCE_RE.exec(line);
    if (fence) {
      flush();
      // AN UNCLOSED FENCE TAKES THE REST OF THE DOCUMENT rather than being
      // abandoned. A truncated card ends mid-block by construction - the
      // collector clips at 40,000 bytes - and losing everything after the last
      // backticks would be the renderer deciding a clipped card is empty.
      const body: string[] = [];
      i += 1;
      while (i < lines.length && !FENCE_RE.test(lines[i])) {
        body.push(lines[i]);
        i += 1;
      }
      blocks.push({ kind: "code", lang: fence[1] || null, text: body.join("\n") });
      continue;
    }

    if (!line.trim()) {
      flush();
      continue;
    }

    if (RULE_RE.test(line)) {
      flush();
      blocks.push({ kind: "rule" });
      continue;
    }

    const heading = HEADING_RE.exec(line);
    if (heading) {
      flush();
      blocks.push({
        kind: "heading",
        level: heading[1].length,
        inline: parseInline(heading[2]),
      });
      continue;
    }

    const quote = QUOTE_RE.exec(line);
    if (quote) {
      flush();
      // CONSECUTIVE `>` LINES ARE ONE QUOTE. card._verdict prints an
      // unparseable answer as a blockquote, and a model's final message is
      // several lines of it.
      const body = [quote[1]];
      while (i + 1 < lines.length && QUOTE_RE.test(lines[i + 1])) {
        i += 1;
        body.push((QUOTE_RE.exec(lines[i]) as RegExpExecArray)[1]);
      }
      blocks.push({ kind: "quote", inline: parseInline(body.join(" ")) });
      continue;
    }

    const ordered = ORDERED_RE.exec(line);
    const bullet = ordered ? null : BULLET_RE.exec(line);
    if (ordered || bullet) {
      flush();
      const isOrdered = Boolean(ordered);
      const items: Inline[][] = [parseInline((ordered ?? bullet!)[1])];
      while (i + 1 < lines.length) {
        const next = isOrdered ? ORDERED_RE.exec(lines[i + 1]) : BULLET_RE.exec(lines[i + 1]);
        if (!next) break;
        i += 1;
        items.push(parseInline(next[1]));
      }
      blocks.push({ kind: "list", ordered: isOrdered, items });
      continue;
    }

    paragraph.push(line.trim());
  }
  flush();
  return blocks;
}
