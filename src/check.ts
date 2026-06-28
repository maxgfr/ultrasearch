import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { CheckResult, Manifest, Source, VerifyResult } from "./types.js";

// Tiers + extra docs that may carry citations. REPORT/FULL are hard-checked for
// per-claim coverage; SUMMARY/glossary are warn-only (a digest needn't repeat a
// source on every line), but a dangling [S#] in ANY file fails.
const HARD_FILES = ["REPORT.md", "FULL.md"];
const SOFT_FILES = ["SUMMARY.md", "glossary.md"];

// A bracketed token is a citation candidate when it is NOT a markdown link
// ("](" after it). [S12] is a source citation; [M] is a model-hint marker;
// anything else is an unknown token (warning only).
const TOKEN_RE = /\[([^\]\n]+)\](?!\()/g;
const SOURCE_RE = /^S\d+$/;

const MIN_CLAIM_WORDS = 6;

interface FileAnalysis {
  file: string;
  sourceTokens: string[]; // every [S#] occurrence (with duplicates)
  modelHints: number; // [M] markers + model-hint blockquote regions
  unknownTokens: string[];
  unsourcedClaims: string[]; // claim units lacking a source and not flagged
}

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
function stripInlineCode(line: string): string {
  return line.replace(/`[^`\n]*`/g, " ");
}

// Count substantive words in a unit, ignoring citation/hint tokens, markdown
// link URLs, and pure punctuation — so a short heading-ish or link-only line
// isn't treated as a factual claim.
function claimWordCount(unit: string): number {
  const stripped = unit
    .replace(/\[[^\]\n]+\](?!\()/g, " ") // [S#] / [M] / [unknown]
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1") // markdown link → its text
    .replace(/[#>*`_~|]/g, " ");
  const words = stripped.split(/\s+/).filter((w) => /[\p{L}\p{N}]{2,}/u.test(w));
  return words.length;
}

function hasSourceToken(unit: string): boolean {
  TOKEN_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = TOKEN_RE.exec(unit))) if (SOURCE_RE.test(m[1]!.trim())) return true;
  return false;
}

function hasHintMarker(unit: string): boolean {
  TOKEN_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = TOKEN_RE.exec(unit))) if (m[1]!.trim() === "M") return true;
  return false;
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
      // Plain (non-hint) blockquote → treat the quoted text as prose.
      const dequoted = line.replace(/^\s*>\s?/, "").trim();
      if (dequoted) prose.push(dequoted);
      i++;
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
function stripHtmlComments(text: string): string {
  return text.replace(/<!--[\s\S]*?-->/g, (m) => m.replace(/[^\n]/g, " "));
}

// Split a hard-checked report file's raw text into claim units, applying the
// SAME masking `runCheck` uses (HTML comments blanked, code fences and
// model-hint regions excluded). Exposed so `verify` extracts exactly the claims
// the grounding gate scores — the two can never disagree on what a claim is.
export function unitsOfFile(text: string): Unit[] {
  const lines = stripHtmlComments(text).split("\n");
  const code = codeMask(lines);
  const { mask: hint } = hintMask(lines);
  return extractUnits(lines, code, hint);
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

function analyzeFile(file: string, text: string): FileAnalysis {
  // Strip HTML comments first (blanking their characters but preserving line
  // breaks) so a citation hidden in `<!-- [S1] -->` cannot ground a claim — the
  // renderer escapes comments to literal text, so they must not count here
  // either. Mirrors htmlToText's comment handling.
  const lines = text.replace(/<!--[\s\S]*?-->/g, (m) => m.replace(/[^\n]/g, " ")).split("\n");
  const code = codeMask(lines);
  const { mask: hint, regions } = hintMask(lines);

  const sourceTokens: string[] = [];
  const unknownTokens: string[] = [];
  let mMarkers = 0;

  // Tokenize over non-code lines (inline code stripped), excluding model-hint
  // regions from the [M]/source accounting is unnecessary — but a [S#] inside
  // backticks must not count (C1), hence stripInlineCode.
  for (let i = 0; i < lines.length; i++) {
    if (code[i]) continue;
    const masked = stripInlineCode(lines[i]!);
    TOKEN_RE.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = TOKEN_RE.exec(masked))) {
      const tok = m[1]!.trim();
      if (SOURCE_RE.test(tok)) sourceTokens.push(tok);
      else if (tok === "M") mMarkers++;
      else if (/^model-hint$/i.test(tok))
        continue; // the hint-region label, not a citation
      else unknownTokens.push(tok);
    }
  }

  const unsourcedClaims: string[] = [];
  const flag = (unit: string) => {
    if (claimWordCount(unit) < MIN_CLAIM_WORDS) return false;
    if (hasSourceToken(unit) || hasHintMarker(unit)) return false;
    unsourcedClaims.push(unit.trim().slice(0, 120));
    return true;
  };

  for (const u of extractUnits(lines, code, hint)) {
    if (u.kind === "text") {
      flag(u.text);
    } else {
      // Each item is a claim unit; if none of them tripped (e.g. a claim
      // fragmented across sub-threshold bullets), check the joined group (C4).
      let any = false;
      for (const it of u.items) any = flag(it) || any;
      if (!any) {
        const joined = u.items.join(" ");
        const grouped = u.items.join("\n");
        if (claimWordCount(joined) >= MIN_CLAIM_WORDS && !hasSourceToken(grouped) && !hasHintMarker(grouped)) {
          unsourcedClaims.push(joined.trim().slice(0, 120));
        }
      }
    }
  }

  return { file, sourceTokens, modelHints: mMarkers + regions, unknownTokens, unsourcedClaims };
}

// Fold the resolved semantic-verification record (VERIFY.json) into a check
// result when `--semantic` is requested. Strictly additive: it can only ADD a
// failure (a refuted/unsupported claim) on top of the mechanical gate, never
// relax it. Missing VERIFY.json warns (run `verify` first) but never fails.
function applySemantic(dir: string, result: CheckResult): void {
  const p = join(dir, "VERIFY.json");
  if (!existsSync(p)) {
    result.warnings.push("--semantic: no VERIFY.json — run `verify` then `verify --apply <verdicts.json>` first; semantic gate skipped.");
    return;
  }
  try {
    const sem = JSON.parse(readFileSync(p, "utf8")) as VerifyResult;
    result.semantic = sem;
    if (!sem.ok) {
      result.ok = false;
      result.errors.push(`Semantic verification failed: ${sem.failures.length} claim(s) refuted or unsupported by their cited source (see VERIFY.json).`);
    }
    if (sem.unadjudicated?.length) {
      result.warnings.push(`${sem.unadjudicated.length} claim(s) not fully adjudicated by verify.`);
    }
    if (sem.contradictions?.length) {
      result.warnings.push(
        `${sem.contradictions.length} claim(s) have contradicting cited sources: ` +
          `${sem.contradictions.map((c) => c.claimId).join(", ")} (see VERIFY.json).`,
      );
    }
  } catch (e) {
    result.warnings.push(`--semantic: VERIFY.json is unreadable (${(e as Error).message}).`);
  }
}

// Validate that the report tiers are grounded in the dossier's sources. Fails
// on a dangling [S#], on an unmarked unsourced claim in REPORT/FULL, or when no
// source is cited at all. Flagged model-hints are tolerated; uncited sources
// and unknown tokens only warn. With `opts.semantic`, ALSO folds in the
// VERIFY.json verdicts (fails on a refuted/unsupported claim) — additive: plain
// `check` (no opts) is byte-for-byte unchanged.
function readManifestSafe(dir: string): Manifest | undefined {
  try {
    return JSON.parse(readFileSync(join(dir, "manifest.json"), "utf8")) as Manifest;
  } catch {
    return undefined;
  }
}

export function runCheck(dir: string, opts: { semantic?: boolean; minSources?: number } = {}): CheckResult {
  const errors: string[] = [];
  const warnings: string[] = [];

  const sourcesPath = join(dir, "sources.json");
  if (!existsSync(sourcesPath)) {
    return blank(false, [`No sources.json in ${dir} — run \`ultrasearch gather\` first.`]);
  }
  let sources: Source[];
  try {
    sources = JSON.parse(readFileSync(sourcesPath, "utf8")) as Source[];
  } catch (e) {
    return blank(false, [`sources.json is unreadable: ${(e as Error).message}`]);
  }
  const ids = new Set(sources.map((s) => s.id));

  const present = [...HARD_FILES, ...SOFT_FILES].filter((f) => existsSync(join(dir, f)));
  if (!present.some((f) => HARD_FILES.includes(f))) {
    return blank(false, [`No REPORT.md or FULL.md in ${dir} — write the report tiers, then re-run check.`]);
  }

  const analyses = present.map((f) => analyzeFile(f, readFileSync(join(dir, f), "utf8")));

  const danglingSet = new Set<string>();
  const citedIds = new Set<string>();
  let sourceCitations = 0;
  let modelHints = 0;
  const unknown = new Set<string>();
  const unmarkedUnsourced: { file: string; text: string }[] = [];

  for (const a of analyses) {
    modelHints += a.modelHints;
    for (const tok of a.sourceTokens) {
      if (ids.has(tok)) {
        sourceCitations++;
        citedIds.add(tok);
      } else {
        danglingSet.add(tok);
      }
    }
    for (const u of a.unknownTokens) unknown.add(u);
    if (HARD_FILES.includes(a.file)) {
      for (const c of a.unsourcedClaims) unmarkedUnsourced.push({ file: a.file, text: c });
    }
  }

  const dangling = [...danglingSet];
  const uncitedSources = sources.map((s) => s.id).filter((id) => !citedIds.has(id));

  if (sourceCitations === 0) {
    errors.push("No source citations found — a grounded report must cite sources like [S1].");
  }
  if (dangling.length) {
    errors.push(`Dangling citation(s) not in sources.json: ${dangling.join(", ")}`);
  }
  if (unmarkedUnsourced.length) {
    errors.push(
      `${unmarkedUnsourced.length} unsourced claim(s) in REPORT/FULL with no [S#] and no model-hint flag. ` + `Cite a source or flag as [M] / > [model-hint].`,
    );
  }
  if (unknown.size) {
    warnings.push(`${unknown.size} bracketed non-citation token(s) ignored: ${[...unknown].slice(0, 5).join(", ")}.`);
  }
  if (uncitedSources.length) {
    warnings.push(`${uncitedSources.length} source(s) were never cited (informational).`);
  }

  // Recall: a thin dossier (flagged by `gather`) warns; `--min-sources N` makes
  // a hard floor that fails the gate, so a high-stakes run can require coverage.
  const manifest = readManifestSafe(dir);
  if (manifest?.recallFloor) {
    warnings.push(
      `Thin dossier: ${manifest.recallFloor.count} source(s) retrieved (recall floor ${manifest.recallFloor.floor}) — ` +
        `consider enriching with \`fetch --url\` before relying on it.`,
    );
  }
  if (opts.minSources !== undefined && sources.length < opts.minSources) {
    errors.push(
      `Only ${sources.length} source(s) in the dossier (--min-sources ${opts.minSources}). ` +
        `Enrich with \`fetch --url\` or broaden the gather before relying on this report.`,
    );
  }

  const result: CheckResult = {
    ok: errors.length === 0,
    filesChecked: present,
    sourceCitations,
    modelHints,
    dangling,
    unmarkedUnsourced,
    uncitedSources,
    unknownTokens: [...unknown],
    errors,
    warnings,
  };
  if (opts.semantic) applySemantic(dir, result);
  return result;
}

function blank(ok: boolean, errors: string[]): CheckResult {
  return {
    ok,
    filesChecked: [],
    sourceCitations: 0,
    modelHints: 0,
    dangling: [],
    unmarkedUnsourced: [],
    uncitedSources: [],
    unknownTokens: [],
    errors,
    warnings: [],
  };
}

export function formatCheckReport(r: CheckResult, dir: string): string {
  const lines: string[] = [];
  lines.push(`ultrasearch check: ${dir}`);
  lines.push(`  files: ${r.filesChecked.join(", ") || "none"}`);
  lines.push(`  citations: ${r.sourceCitations} · model-hints: ${r.modelHints} · dangling: ${r.dangling.length} · unsourced: ${r.unmarkedUnsourced.length}`);
  for (const u of r.unmarkedUnsourced.slice(0, 8)) lines.push(`  ✗ [${u.file}] unsourced: "${u.text}…"`);
  if (r.semantic) {
    const s = r.semantic;
    lines.push(`  semantic: supported ${s.supported} · partial ${s.partial} · refuted ${s.refuted} · unsupported ${s.unsupported}`);
    for (const f of s.failures.slice(0, 8)) lines.push(`  ✗ semantic ${f.claimId} (${f.sourceId}): ${f.verdict}`);
  }
  for (const e of r.errors) lines.push(`  ✗ ${e}`);
  for (const w of r.warnings) lines.push(`  ⚠ ${w}`);
  lines.push(r.ok ? `  ✓ report is grounded — every claim cites a source or is a flagged hint` : `  ✗ report is NOT grounded`);
  return lines.join("\n");
}
