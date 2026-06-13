import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { CheckResult, Source } from "./types.js";

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
function codeMask(lines: string[]): boolean[] {
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
function hintMask(lines: string[]): { mask: boolean[]; regions: number } {
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

// Is this line ineligible to be a factual claim (heading, table, rule, bare
// list/blockquote scaffold)?
function isStructural(line: string): boolean {
  const t = line.trim();
  if (!t) return true;
  if (/^#{1,6}\s/.test(t)) return true; // heading
  if (/^([-*_])\1{2,}$/.test(t)) return true; // hr ---/***
  if (/^\|/.test(t) || /^[:\-\s|]+$/.test(t)) return true; // table row/separator
  if (/^([-*+]|\d+\.)\s*$/.test(t)) return true; // empty list bullet
  return false;
}

function isListItem(line: string): boolean {
  return /^\s*([-*+]|\d+\.)\s+\S/.test(line);
}

function analyzeFile(file: string, text: string): FileAnalysis {
  const lines = text.split("\n");
  const code = codeMask(lines);
  const { mask: hint, regions } = hintMask(lines);

  const sourceTokens: string[] = [];
  const unknownTokens: string[] = [];
  let mMarkers = 0;

  // Tokenize over non-code lines.
  for (let i = 0; i < lines.length; i++) {
    if (code[i]) continue;
    TOKEN_RE.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = TOKEN_RE.exec(lines[i]!))) {
      const tok = m[1]!.trim();
      if (SOURCE_RE.test(tok)) sourceTokens.push(tok);
      else if (tok === "M") mMarkers++;
      else if (/^model-hint$/i.test(tok)) continue; // the hint-region label, not a citation
      else unknownTokens.push(tok);
    }
  }

  // Claim-coverage: build blocks from non-code, non-hint lines. A list block is
  // checked item by item; a prose block is checked as one unit.
  const unsourcedClaims: string[] = [];
  let block: string[] = [];
  const flush = () => {
    if (!block.length) return;
    const isList = block.some(isListItem);
    const units = isList ? block.filter(isListItem) : [block.join(" ")];
    for (const unit of units) {
      if (claimWordCount(unit) < MIN_CLAIM_WORDS) continue;
      if (hasSourceToken(unit) || hasHintMarker(unit)) continue;
      unsourcedClaims.push(unit.trim().slice(0, 120));
    }
    block = [];
  };
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    if (code[i] || hint[i] || /^\s*>/.test(line) || isStructural(line)) {
      flush();
      continue;
    }
    if (line.trim() === "") {
      flush();
      continue;
    }
    block.push(line);
  }
  flush();

  return { file, sourceTokens, modelHints: mMarkers + regions, unknownTokens, unsourcedClaims };
}

// Validate that the report tiers are grounded in the dossier's sources. Fails
// on a dangling [S#], on an unmarked unsourced claim in REPORT/FULL, or when no
// source is cited at all. Flagged model-hints are tolerated.
export function runCheck(dir: string): CheckResult {
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

  // Dangling citations (any file) and global source usage.
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
    // Per-claim coverage only enforced on the hard files.
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
      `${unmarkedUnsourced.length} unsourced claim(s) in REPORT/FULL with no [S#] and no model-hint flag. ` +
        `Cite a source or flag as [M] / > [model-hint].`,
    );
  }
  if (unknown.size) {
    warnings.push(`${unknown.size} bracketed non-citation token(s) ignored: ${[...unknown].slice(0, 5).join(", ")}.`);
  }
  if (uncitedSources.length) {
    warnings.push(`${uncitedSources.length} source(s) were never cited (informational).`);
  }

  return {
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
  lines.push(
    `  citations: ${r.sourceCitations} · model-hints: ${r.modelHints} · dangling: ${r.dangling.length} · unsourced: ${r.unmarkedUnsourced.length}`,
  );
  for (const u of r.unmarkedUnsourced.slice(0, 8)) lines.push(`  ✗ [${u.file}] unsourced: "${u.text}…"`);
  for (const e of r.errors) lines.push(`  ✗ ${e}`);
  for (const w of r.warnings) lines.push(`  ⚠ ${w}`);
  lines.push(r.ok ? `  ✓ report is grounded — every claim cites a source or is a flagged hint` : `  ✗ report is NOT grounded`);
  return lines.join("\n");
}
