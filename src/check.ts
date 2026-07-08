import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { CheckResult, Manifest, Source, VerifyResult } from "./types.js";
import { extractUnits, codeMask, hintMask, appendixMask, stripInlineCode, TOKEN_RE, SOURCE_RE } from "./claims.js";

// The claim parser lives in claims.ts (shared with verify/render); re-export
// the historical surface so existing importers keep working unchanged.
export { codeMask, hintMask, appendixMask, extractUnits, unitsOfFile, unitSourceTokens } from "./claims.js";
export type { Unit } from "./claims.js";

// Tiers + extra docs that may carry citations. REPORT is hard-checked for
// per-claim coverage; SUMMARY/glossary are warn-only (a digest needn't repeat a
// source on every line), but a dangling [S#] in ANY file fails.
const HARD_FILES = ["REPORT.md"];
const SOFT_FILES = ["SUMMARY.md", "glossary.md"];

const MIN_CLAIM_WORDS = 6;

interface FileAnalysis {
  file: string;
  sourceTokens: string[]; // every [S#] occurrence (with duplicates)
  appendixSourceTokens: string[]; // [S#] inside a Sources/References appendix — dangling-checked only
  modelHints: number; // [M] markers + model-hint blockquote regions
  unknownTokens: string[];
  unsourcedClaims: string[]; // claim units lacking a source and not flagged
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

function analyzeFile(file: string, text: string): FileAnalysis {
  // Strip HTML comments first (blanking their characters but preserving line
  // breaks) so a citation hidden in `<!-- [S1] -->` cannot ground a claim — the
  // renderer escapes comments to literal text, so they must not count here
  // either. Mirrors htmlToText's comment handling.
  const lines = text.replace(/<!--[\s\S]*?-->/g, (m) => m.replace(/[^\n]/g, " ")).split("\n");
  const code = codeMask(lines);
  const { mask: hint, regions } = hintMask(lines);
  const appendix = appendixMask(lines);

  const sourceTokens: string[] = [];
  const appendixSourceTokens: string[] = [];
  const unknownTokens: string[] = [];
  let mMarkers = 0;

  // Tokenize over non-code lines (inline code stripped), excluding model-hint
  // regions from the [M]/source accounting is unnecessary — but a [S#] inside
  // backticks must not count (C1), hence stripInlineCode. A [S#] inside the
  // Sources/References appendix is the rendered listing, not a citation: it is
  // kept ONLY for dangling detection (the gate never relaxes), never for
  // coverage/cited-set accounting.
  for (let i = 0; i < lines.length; i++) {
    if (code[i]) continue;
    const masked = stripInlineCode(lines[i]!);
    TOKEN_RE.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = TOKEN_RE.exec(masked))) {
      const tok = m[1]!.trim();
      if (SOURCE_RE.test(tok)) (appendix[i] ? appendixSourceTokens : sourceTokens).push(tok);
      else if (appendix[i])
        continue; // appendix boilerplate carries no [M]/unknown accounting
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

  for (const u of extractUnits(
    lines,
    code,
    hint.map((h, i) => h || appendix[i]!),
  )) {
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

  return { file, sourceTokens, appendixSourceTokens, modelHints: mMarkers + regions, unknownTokens, unsourcedClaims };
}

// Fold the resolved semantic-verification record (VERIFY.json) into a check
// result when `--semantic` is requested. Strictly additive: it can only ADD a
// failure (a refuted/unsupported claim) on top of the mechanical gate, never
// relax it. Missing VERIFY.json warns (run `verify` first) but never fails —
// UNLESS `requireVerify`, which turns a missing/empty verdict record into a hard
// failure so the deep-tier exit gate can't silently pass without adjudication.
function applySemantic(dir: string, result: CheckResult, requireVerify: boolean): void {
  const p = join(dir, "VERIFY.json");
  if (!existsSync(p)) {
    if (requireVerify) {
      result.ok = false;
      result.errors.push("--require-verify: no VERIFY.json — run `verify` then `verify --apply <verdicts.json>` before the semantic gate.");
    } else {
      result.warnings.push("--semantic: no VERIFY.json — run `verify` then `verify --apply <verdicts.json>` first; semantic gate skipped.");
    }
    return;
  }
  try {
    const sem = JSON.parse(readFileSync(p, "utf8")) as VerifyResult;
    result.semantic = sem;
    if (!sem.ok) {
      result.ok = false;
      result.errors.push(`Semantic verification failed: ${sem.failures.length} claim(s) refuted or unsupported by their cited source (see VERIFY.json).`);
    }
    // A VERIFY.json with nothing adjudicated hasn't verified anything: under
    // --require-verify that must fail, not quietly pass on an empty record.
    if (requireVerify && !sem.adjudicated) {
      result.ok = false;
      result.errors.push("--require-verify: VERIFY.json has 0 adjudicated claim(s) — fill the verdicts and `verify --apply` before the gate.");
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
// on a dangling [S#], on an unmarked unsourced claim in REPORT, or when no
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

export function runCheck(dir: string, opts: { semantic?: boolean; requireVerify?: boolean; minSources?: number } = {}): CheckResult {
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
  // Valid JSON is not enough — a `{}`/`null`/scalar sources.json parses fine but
  // isn't the Source[] the rest of check assumes; guard before `.map` throws.
  if (!Array.isArray(sources)) {
    return blank(false, [`sources.json in ${dir} is not a JSON array — re-run \`ultrasearch gather\`.`]);
  }
  const ids = new Set(sources.map((s) => s.id));

  const present = [...HARD_FILES, ...SOFT_FILES].filter((f) => existsSync(join(dir, f)));
  if (!present.some((f) => HARD_FILES.includes(f))) {
    return blank(false, [`No REPORT.md in ${dir} — write the report tier, then re-run check.`]);
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
    for (const tok of a.appendixSourceTokens) {
      if (!ids.has(tok)) danglingSet.add(tok);
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
      `${unmarkedUnsourced.length} unsourced claim(s) in REPORT with no [S#] and no model-hint flag. ` + `Cite a source or flag as [M] / > [model-hint].`,
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
  if (opts.semantic || opts.requireVerify) applySemantic(dir, result, opts.requireVerify === true);
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
