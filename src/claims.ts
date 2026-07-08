// The shared claim parser: how a report file is split into claim units and how
// [S#] citations are read out of them. `check` (the grounding gate), `verify`
// (the claim↔source worklist) and `render` all import THIS module, so they can
// never disagree on what a claim is or which sources it cites. Extracted from
// check.ts verbatim — keep it dependency-free (no fs) so it stays pure.

// A bracketed token is a citation candidate when it is NOT a markdown link
// ("](" after it). [S12] is a source citation; [M] is a model-hint marker;
// anything else is an unknown token (warning only).
export const TOKEN_RE = /\[([^\]\n]+)\](?!\()/g;
export const SOURCE_RE = /^S\d+$/;

// Lines inside ``` / ~~~ fences are code — exclude from citation and claim
// analysis so example snippets don't trip the checker.
export function codeMask(lines: string[]): boolean[] {
  const mask = new Array(lines.length).fill(false);
  let inFence = false;
  for (let i = 0; i < lines.length; i++) {
    if (/^\s*(```|~~~)/.test(lines[i]!)) {
      mask[i] = true; // the fence line itself
      inFence = !inFence;
      continue;
    }
    mask[i] = inFence;
  }
  return mask;
}

// Mark each line that belongs to a model-hint blockquote region: a maximal run
// of consecutive blockquote lines (^\s*>) in which any line contains
// "[model-hint]". Returns the per-line mask plus the region count.
export function hintMask(lines: string[]): { mask: boolean[]; regions: number } {
  const mask = new Array(lines.length).fill(false);
  let regions = 0;
  let i = 0;
  while (i < lines.length) {
    if (/^\s*>/.test(lines[i]!)) {
      let j = i;
      let isHint = false;
      while (j < lines.length && /^\s*>/.test(lines[j]!)) {
        if (/\[model-hint\]/i.test(lines[j]!)) isHint = true;
        j++;
      }
      if (isHint) {
        regions++;
        for (let k = i; k < j; k++) mask[k] = true;
      }
      i = j;
    } else {
      i++;
    }
  }
  return { mask, regions };
}

// Remove inline-code spans so a [S#] (or a whole claim) hidden in backticks is
// not treated as a citation or as covered prose (audit C1).
export function stripInlineCode(line: string): string {
  return line.replace(/`[^`\n]*`/g, " ");
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
      units.push({ kind: "text", text: tableCells(line) });
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

// Blank HTML comments (preserving line breaks) the way analyzeFile does, so a
// citation hidden in `<!-- [S1] -->` can't ground a claim downstream either.
export function stripHtmlComments(text: string): string {
  return text.replace(/<!--[\s\S]*?-->/g, (m) => m.replace(/[^\n]/g, " "));
}

// A trailing "## Sources" / "## References" section is the rendered appendix
// pointer, not research prose: its boilerplate must not count as a factual
// claim and its [S#] listing must not count as citation coverage (it would
// otherwise mark every source "cited" and pad verify's supported count).
const APPENDIX_HEADING = /^\s*(#{2,6})\s+(sources|references)\b/i;

// Mark every line of each appendix section: from its heading (inclusive) to
// the next heading of the same or shallower level (exclusive), or EOF.
export function appendixMask(lines: string[]): boolean[] {
  const mask = new Array(lines.length).fill(false);
  let level = 0; // 0 = not inside an appendix section
  for (let i = 0; i < lines.length; i++) {
    const h = /^\s*(#{1,6})\s/.exec(lines[i]!);
    if (level && h && h[1]!.length <= level) level = 0;
    if (!level) {
      const a = APPENDIX_HEADING.exec(lines[i]!);
      if (a) level = a[1]!.length;
    }
    mask[i] = level > 0;
  }
  return mask;
}

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
