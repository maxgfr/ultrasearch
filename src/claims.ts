// The shared claim parser: how a report file is split into claim units and how
// [S#] citations are read out of them. `check` (the grounding gate), `verify`
// (the claim<->source worklist) and `render` all import THIS module, so they can
// never disagree on what a claim is or which sources it cites.
//
// Since webindex v1.15.0 the READING is the engine's: which bracketed tokens are
// citations and which are markdown links, that a [S#] inside backticks or a code
// fence or an HTML comment grounds nothing, which figures a claim asserts. Six
// skills in this family each had their own regex for that, and the subtle cases
// are exactly where independent copies disagree.
//
// What stays here is the POLICY, which the engine deliberately refuses to hold:
// what counts as a source token for THIS tool ([S#]), what a model-hint region
// means, and how a report file is masked before its claims are counted. The
// engine exports no verdict at all -- no runCheck, no ok:boolean -- so `check`
// still owns every decision it ever owned.
import { appendixMask, codeMask, markedQuoteMask, stripHtmlComments, stripInlineCode, TOKEN_RE } from "./engine.js";

export { TOKEN_RE, codeMask, stripInlineCode, stripHtmlComments, normalizeNumeralText, extractNumerals, appendixMask } from "./engine.js";

/** A source citation for THIS tool. The engine has no opinion on the shape. */
export const SOURCE_RE = /^S\d+$/;

/**
 * Model-hint regions: a run of blockquote lines carrying `[model-hint]`.
 *
 * The engine's `markedQuoteMask` finds a marked run; what the marker MEANS -- a
 * passage the author has flagged as unsourced and exempt from the grounding
 * count -- is this tool's, so the marker stays here.
 */
export function hintMask(lines: string[]): { mask: boolean[]; regions: number } {
  return markedQuoteMask(lines, /\[model-hint\]/i);
}

function isHeadingOrRule(t: string): boolean {
  return /^#{1,6}\s/.test(t) || /^([-*_])\1{2,}$/.test(t);
}
function isTableSeparator(line: string): boolean {
  return /\|/.test(line) && /^[\s:|-]+$/.test(line.trim()) && /-/.test(line);
}
function isTableRow(line: string): boolean {
  return /\|/.test(line.trim()) && !isTableSeparator(line);
}
function tableCells(line: string): string {
  return line
    .trim()
    .replace(/^\|/, "")
    .replace(/\|$/, "")
    .split("|")
    .map((c) => c.trim())
    .join(" ");
}
function isListItem(line: string): boolean {
  return /^\s*([-*+]|\d+\.)\s+\S/.test(line);
}

// A claim unit is either a single block of prose/table-row text, or a list
// group (its items, evaluated individually and as an aggregate).
export type Unit = { kind: "text"; text: string } | { kind: "list"; items: string[] };

// Split a hard-checked file into claim units. Headings, rules, code, table
// separators and model-hint regions are excluded; plain blockquotes are
// de-quoted into prose (audit C2); table data rows become units (C3); list
// items fold in their continuation lines (C5) and also get a group aggregate
// (C4). Inline code is stripped throughout (C1).
export function extractUnits(lines: string[], code: boolean[], hint: boolean[]): Unit[] {
  const units: Unit[] = [];
  let prose: string[] = [];
  const flush = () => {
    if (prose.length) units.push({ kind: "text", text: prose.join(" ") });
    prose = [];
  };

  let i = 0;
  while (i < lines.length) {
    if (code[i] || hint[i]) {
      flush();
      i++;
      continue;
    }
    const line = stripInlineCode(lines[i]!);
    const t = line.trim();
    if (t === "" || isHeadingOrRule(t) || isTableSeparator(line)) {
      flush();
      i++;
      continue;
    }
    if (isTableRow(line)) {
      flush();
      // A header row — the row immediately followed by the |---| separator —
      // is table structure, not a factual claim: never coverage-check it.
      const next = i + 1 < lines.length && !code[i + 1] ? stripInlineCode(lines[i + 1]!) : "";
      if (!isTableSeparator(next)) units.push({ kind: "text", text: tableCells(line) });
      i++;
      continue;
    }
    if (/^\s*>/.test(line)) {
      // A (non-hint) blockquote is its own block. FLUSH the pending prose first,
      // otherwise the quoted text is folded into the preceding sourced line and
      // a fabricated blockquote inherits its `[S#]` — silently passing check.
      // Fold consecutive quote lines into a single unit so a claim spanning two
      // `>` lines still counts the citation on either line.
      flush();
      const quoted: string[] = [];
      while (i < lines.length && !code[i] && !hint[i]) {
        const ql = stripInlineCode(lines[i]!);
        if (!/^\s*>/.test(ql)) break;
        const dq = ql.replace(/^\s*>\s?/, "").trim();
        if (dq) quoted.push(dq);
        i++;
      }
      if (quoted.length) units.push({ kind: "text", text: quoted.join(" ") });
      continue;
    }
    if (isListItem(line)) {
      flush();
      const items: string[] = [];
      while (i < lines.length && !code[i] && !hint[i]) {
        const l = stripInlineCode(lines[i]!);
        const tt = l.trim();
        if (tt === "" || isHeadingOrRule(tt) || isTableSeparator(l) || isTableRow(l)) break;
        if (isListItem(l)) {
          items.push(l.replace(/^\s*([-*+]|\d+\.)\s+/, "").trim());
        } else if (items.length) {
          items[items.length - 1] += " " + tt; // continuation line folded in (C5)
        } else {
          items.push(tt);
        }
        i++;
      }
      units.push({ kind: "list", items });
      continue;
    }
    prose.push(line);
    i++;
  }
  flush();
  return units;
}

// A trailing "## Sources" / "## References" section is the rendered appendix
// pointer, not research prose: its boilerplate must not count as a factual
// claim and its [S#] listing must not count as citation coverage (it would
// otherwise mark every source "cited" and pad verify's supported count).
const APPENDIX_HEADING = /^\s*(#{2,6})\s+(sources|references)\b/i;

// Split a hard-checked report file's raw text into claim units, applying the
// SAME masking `runCheck` uses (HTML comments blanked, code fences and
// model-hint regions excluded). Exposed so `verify` extracts exactly the claims
// the grounding gate scores — the two can never disagree on what a claim is.
export function unitsOfFile(text: string): Unit[] {
  const lines = stripHtmlComments(text).split("\n");
  const code = codeMask(lines);
  const { mask: hint } = hintMask(lines);
  const appendix = appendixMask(lines);
  return extractUnits(
    lines,
    code,
    hint.map((h, i) => h || appendix[i]!),
  );
}

// The distinct [S#] source ids cited within a piece of claim text, in order.
// Inline code is stripped first (a [S#] in backticks is not a citation, audit
// C1), mirroring runCheck's accounting.
export function unitSourceTokens(text: string): string[] {
  const masked = stripInlineCode(text);
  const out: string[] = [];
  TOKEN_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = TOKEN_RE.exec(masked))) {
    const tok = m[1]!.trim();
    if (SOURCE_RE.test(tok) && !out.includes(tok)) out.push(tok);
  }
  return out;
}

// The set of source ids CITED by a report file's body, applying the same masks
// as `check`'s accounting: code fences, HTML comments and the Sources/References
// appendix are excluded (a [S#] in the appendix listing is not a citation).
// Shared so `render` and `check` can never disagree on what counts as cited.
export function citedSourceIds(text: string): Set<string> {
  const lines = stripHtmlComments(text).split("\n");
  const code = codeMask(lines);
  const appendix = appendixMask(lines);
  const out = new Set<string>();
  for (let i = 0; i < lines.length; i++) {
    if (code[i] || appendix[i]) continue;
    for (const tok of unitSourceTokens(lines[i]!)) out.add(tok);
  }
  return out;
}
