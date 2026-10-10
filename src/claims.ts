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
function cellsOf(line: string): string[] {
  return line
    .trim()
    .replace(/^\|/, "")
    .replace(/\|$/, "")
    .split("|")
    .map((c) => c.trim());
}
function tableCells(line: string, dropFirst = false): string {
  return (dropFirst ? cellsOf(line).slice(1) : cellsOf(line)).join(" ");
}

// A header that names an index column: "#", "N°", "No.", "Ref", "Réf.", "ID"…
const INDEX_HEADER = /^(#|n[°ºo]\.?|no\.|num(ber|éro|ero)?\.?|r[ée]f(s|\.|érence|erence)?\.?|id|item)$/i;
// A cell that is only a short running number: "15", "[18]", "19.".
const INDEX_CELL = /^\[?\d{1,3}\]?\.?$/;

/**
 * Data rows of a table whose FIRST column is an index — the row numbers of a
 * reference table, not figures anybody asserts. A column counts as an index when
 * its header says so, or when every data row (two at least) holds a short
 * integer there. Four-digit values (years) never qualify on their own: a year
 * column carries claims.
 *
 * Measured on a real thesis review: 16 "numeral not in S#" warnings, every one of
 * them on the reference-number column of a single table.
 */
export function indexColumnRows(lines: string[], code: boolean[]): boolean[] {
  const out = lines.map(() => false);
  for (let i = 0; i + 1 < lines.length; i++) {
    if (code[i] || code[i + 1] || !isTableRow(lines[i]!) || !isTableSeparator(lines[i + 1]!)) continue;
    const rows: number[] = [];
    for (let j = i + 2; j < lines.length && !code[j] && isTableRow(lines[j]!); j++) rows.push(j);
    if (cellsOf(lines[i]!).length < 2) continue;
    const header = cellsOf(lines[i]!)[0]!.replace(/[*_`]/g, "").trim();
    const firsts = rows.map((j) => cellsOf(lines[j]!)[0]!.replace(/[*_`]/g, "").trim());
    const index = INDEX_HEADER.test(header) || (rows.length >= 2 && firsts.every((c) => INDEX_CELL.test(c)));
    if (index) for (const j of rows) out[j] = true;
    i = rows.length ? rows[rows.length - 1]! : i + 1;
  }
  return out;
}

/** The annotation that exempts the next block from the numeral check. */
export const NO_NUMERALS_RE = /<!--\s*ultrasearch:no-numerals\s*-->/i;

/**
 * Lines covered by `<!-- ultrasearch:no-numerals -->`: the block (paragraph,
 * list or table — a run of non-blank lines) right after the comment, or the
 * block the comment sits in when it shares a line with text. Read from the RAW
 * text: comments are blanked before anything else sees the file.
 */
export function noNumeralsMask(rawLines: string[]): boolean[] {
  const out = rawLines.map(() => false);
  for (let i = 0; i < rawLines.length; i++) {
    const line = rawLines[i]!;
    if (!NO_NUMERALS_RE.test(line)) continue;
    let start = i;
    if (!line.replace(NO_NUMERALS_RE, "").trim()) {
      start = i + 1;
      while (start < rawLines.length && !rawLines[start]!.trim()) start++;
    } else {
      while (start > 0 && rawLines[start - 1]!.trim()) start--;
    }
    for (let j = start; j < rawLines.length && rawLines[j]!.trim(); j++) out[j] = true;
  }
  return out;
}
function isListItem(line: string): boolean {
  return /^\s*([-*+]|\d+\.)\s+\S/.test(line);
}

// A claim unit is either a single block of prose/table-row text, or a list
// group (its items, evaluated individually and as an aggregate).
// `noNumerals` marks a unit under `<!-- ultrasearch:no-numerals -->`: still a
// claim for citation coverage, exempt from the numeral-grounding pass.
export type Unit = { kind: "text"; text: string; noNumerals?: true } | { kind: "list"; items: string[]; noNumerals?: true };

// Split a hard-checked file into claim units. Headings, rules, code, table
// separators and model-hint regions are excluded; plain blockquotes are
// de-quoted into prose (audit C2); table data rows become units (C3); list
// items fold in their continuation lines (C5) and also get a group aggregate
// (C4). Inline code is stripped throughout (C1).
// A table whose first column is an index (see indexColumnRows) loses that cell:
// the row is still a claim, its running number is not.
export function extractUnits(lines: string[], code: boolean[], hint: boolean[], noNumerals: boolean[] = []): Unit[] {
  const units: Unit[] = [];
  const indexRows = indexColumnRows(lines, code);
  let prose: string[] = [];
  let proseExempt = false;
  const flag = <U extends Unit>(u: U, exempt: boolean): U => (exempt ? { ...u, noNumerals: true } : u);
  const flush = () => {
    if (prose.length) units.push(flag({ kind: "text", text: prose.join(" ") }, proseExempt));
    prose = [];
    proseExempt = false;
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
      if (!isTableSeparator(next)) units.push(flag({ kind: "text", text: tableCells(line, indexRows[i]) }, !!noNumerals[i]));
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
      const exempt = !!noNumerals[i];
      while (i < lines.length && !code[i] && !hint[i]) {
        const ql = stripInlineCode(lines[i]!);
        if (!/^\s*>/.test(ql)) break;
        const dq = ql.replace(/^\s*>\s?/, "").trim();
        if (dq) quoted.push(dq);
        i++;
      }
      if (quoted.length) units.push(flag({ kind: "text", text: quoted.join(" ") }, exempt));
      continue;
    }
    if (isListItem(line)) {
      flush();
      const items: string[] = [];
      const exempt = !!noNumerals[i];
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
      units.push(flag({ kind: "list", items }, exempt));
      continue;
    }
    prose.push(line);
    if (noNumerals[i]) proseExempt = true;
    i++;
  }
  flush();
  return units;
}

// A trailing "## Sources" / "## References" section is the rendered appendix
// pointer, not research prose: its boilerplate must not count as a factual
// claim and its [S#] listing must not count as citation coverage (it would
// otherwise mark every source "cited" and pad verify's supported count).
//
// The engine's `appendixMask` knows the bare titles ("References",
// "Bibliographie", …) and only those. The heading the research and clinical
// templates actually ship is "References (see refs.bib)", which it did not
// recognise — the pointer line under it was scored as an unsourced claim and
// its listing as citations. This regex was meant to cover it and was never
// wired in; it now extends the engine's list with a parenthetical tail.
const APPENDIX_HEADING = /^(?:sources?|references?|r[ée]f[ée]rences(?:\s+bibliographiques)?|bibliograph(?:y|ie)|works cited)\s*\(.*\)$/i;

/** The Sources/References appendix lines of a report, the engine's titles plus "References (see refs.bib)". */
export function reportAppendixMask(lines: string[]): boolean[] {
  return appendixMask(lines, { headings: APPENDIX_HEADING });
}

/** A report file's lines plus every mask `check`'s accounting reads them through. */
export interface MaskedFile {
  /** Lines with HTML comments blanked (line breaks preserved). */
  lines: string[];
  /** Lines inside a code fence. */
  code: boolean[];
  /** How many `[model-hint]` blockquote regions there are — a flagged passage counts as one hint. */
  regions: number;
  /** Lines inside a trailing Sources/References appendix. */
  appendix: boolean[];
  /** `hint || appendix` — the lines a claim unit must NOT be extracted from. */
  unclaimable: boolean[];
  /** Lines under `<!-- ultrasearch:no-numerals -->` — exempt from the numeral pass. */
  noNumerals: boolean[];
}

// The single masking of a report file: HTML comments blanked, code fences,
// model-hint regions and the Sources/References appendix located. `check`'s
// token accounting, `check`'s claim units and `unitsOfFile` (verify/render) all
// go through here, so the three can never drift into disagreeing about which
// line is prose — the failure mode independent copies of this always produce.
// One deliberate exception stays outside: `citedSourceIds` below runs its own
// pass because it must NOT apply `hintMask` — a [S#] inside a model-hint region
// is still a citation for "which sources did the report cite?".
export function maskedFile(text: string): MaskedFile {
  // The annotation is read BEFORE comments are blanked — it is one. Blanking
  // keeps every line break, so the two line arrays index the same lines.
  const noNumerals = noNumeralsMask(text.split("\n"));
  const lines = stripHtmlComments(text).split("\n");
  const code = codeMask(lines);
  const { mask: hint, regions } = hintMask(lines);
  const appendix = reportAppendixMask(lines);
  return { lines, code, regions, appendix, unclaimable: hint.map((h, i) => h || appendix[i]!), noNumerals };
}

// Split an already-masked report file into claim units.
export function unitsOfMasked(m: MaskedFile): Unit[] {
  return extractUnits(m.lines, m.code, m.unclaimable, m.noNumerals);
}

// Split a hard-checked report file's raw text into claim units, applying the
// SAME masking `runCheck` uses (HTML comments blanked, code fences and
// model-hint regions excluded). Exposed so `verify` extracts exactly the claims
// the grounding gate scores — the two can never disagree on what a claim is.
export function unitsOfFile(text: string): Unit[] {
  return unitsOfMasked(maskedFile(text));
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
  const appendix = reportAppendixMask(lines);
  const out = new Set<string>();
  for (let i = 0; i < lines.length; i++) {
    if (code[i] || appendix[i]) continue;
    for (const tok of unitSourceTokens(lines[i]!)) out.add(tok);
  }
  return out;
}
