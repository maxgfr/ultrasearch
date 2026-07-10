import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { CheckResult, Manifest, Source, VerifyResult } from "./types.js";
import {
  extractUnits,
  codeMask,
  hintMask,
  appendixMask,
  stripInlineCode,
  unitsOfFile,
  unitSourceTokens,
  extractNumerals,
  normalizeNumeralText,
  TOKEN_RE,
  SOURCE_RE,
} from "./claims.js";
import { readSourceText } from "./dossier.js";
import { buildWorklist, reduceVerdicts } from "./verify.js";

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

// Fold the semantic-verification record (VERIFY.json) into a check result when
// `--semantic` is requested. Strictly additive: it can only ADD failures on top
// of the mechanical gate, never relax it. Two integrity rules:
//   1. FAIL-CLOSED — a missing/unreadable/empty VERIFY.json is an error, not a
//      warning: a green `--semantic` exit must always mean the gate engaged.
//      The escape hatch is simply not passing `--semantic`.
//   2. NEVER TRUST THE STORED SUMMARY — the gate verdict is re-reduced from
//      `verdicts[]` at check time, so a hand-edited or stale `ok` flag cannot
//      flip the outcome (in either direction).
// `requireVerify` keeps its extra meaning for the deep exit gate (also fails on
// an unadjudicated record); its messages name the flag that tripped.
function applySemantic(dir: string, result: CheckResult, requireVerify: boolean): void {
  const flag = requireVerify ? "--require-verify" : "--semantic";
  const p = join(dir, "VERIFY.json");
  if (!existsSync(p)) {
    result.ok = false;
    result.errors.push(`${flag}: no VERIFY.json — run \`verify\` then \`verify --apply <verdicts.json>\` before the semantic gate.`);
    return;
  }
  let stored: VerifyResult;
  try {
    stored = JSON.parse(readFileSync(p, "utf8")) as VerifyResult;
  } catch (e) {
    result.ok = false;
    result.errors.push(`${flag}: VERIFY.json is unreadable (${(e as Error).message}) — re-run \`verify --apply <verdicts.json>\`.`);
    return;
  }
  const verdicts = Array.isArray(stored.verdicts) ? stored.verdicts : [];
  const reduced = reduceVerdicts(verdicts);
  result.semantic = { ...reduced, verdicts };
  // A record with nothing actually adjudicated hasn't verified anything — a
  // bare summary (no verdicts[]) or all-null verdicts must not quietly pass.
  if (!reduced.adjudicated) {
    result.ok = false;
    result.errors.push(`${flag}: VERIFY.json has 0 adjudicated claim(s) — fill the verdicts and \`verify --apply\` before the gate.`);
    return;
  }
  if (stored.ok !== reduced.ok) {
    result.warnings.push("VERIFY.json's stored gate disagrees with its verdicts[] — re-reduced from the verdicts at check time.");
  }
  if (!reduced.ok) {
    result.ok = false;
    result.errors.push(`Semantic verification failed: ${reduced.failures.length} claim(s) refuted or unsupported by their cited source (see VERIFY.json).`);
  }
  // Deep exit-gate COVERAGE (requireVerify only): `reduceVerdicts` sees ONLY the
  // pairs present in verdicts[], so a wholly-dropped verdict row — e.g. an agent
  // deleting the refuted claims before `verify --apply` — is invisible to the
  // fold and would let the gate pass on an unverified claim. Re-derive REPORT's
  // claim↔source pairs (same deterministic derivation `verify --run` used) and
  // fail closed on any pair without an adjudicated verdict. This also catches a
  // REPORT edited after verification (claim ids shift ⇒ re-verify).
  if (requireVerify) {
    let expected: ReturnType<typeof buildWorklist>["worklist"]["pairs"] = [];
    try {
      expected = buildWorklist(dir).worklist.pairs;
    } catch {
      expected = [];
    }
    const adjudicatedKeys = new Set(verdicts.filter((v) => !!v.verdict).map((v) => `${v.claimId} ${v.sourceId}`));
    const uncovered = expected.filter((p) => !adjudicatedKeys.has(`${p.claimId} ${p.sourceId}`));
    if (uncovered.length) {
      result.ok = false;
      const claims = [...new Set(uncovered.map((p) => p.claimId))];
      result.errors.push(
        `${flag}: ${uncovered.length} claim↔source pair(s) in REPORT have no verdict in VERIFY.json ` +
          `(${claims.slice(0, 6).join(", ")}${claims.length > 6 ? ", …" : ""}) — re-run \`verify\` + \`verify --apply\` so ` +
          `every cited claim is adjudicated (the exit gate must not pass on dropped verdicts).`,
      );
    }
  }
  if (reduced.unadjudicated?.length) {
    result.warnings.push(`${reduced.unadjudicated.length} claim(s) not fully adjudicated by verify.`);
  }
  if (reduced.contradictions?.length) {
    result.warnings.push(
      `${reduced.contradictions.length} claim(s) have contradicting cited sources: ` +
        `${reduced.contradictions.map((c) => c.claimId).join(", ")} (see VERIFY.json).`,
    );
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

export function runCheck(dir: string, opts: { semantic?: boolean; requireVerify?: boolean; minSources?: number; strictNumerals?: boolean } = {}): CheckResult {
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

  // Numeral grounding (advisory; `--strict-numerals` fails): a specific figure
  // asserted by a cited claim should appear in at least ONE of its cited
  // extracts — the "correct number, wrong source" class that mechanical
  // citation-presence can't see. Containment is tested on normalized text
  // (group separators stripped) and is deliberately fail-open: an unreadable
  // extract means UNKNOWN, not absent. Extracts are read + normalized lazily
  // and at most once each, so an 80-source dossier stays cheap.
  const numeralIssues: NonNullable<CheckResult["numeralIssues"]> = [];
  const bySourceId = new Map(sources.map((s) => [s.id, s] as const));
  const normCache = new Map<string, string | null>();
  const normOf = (id: string): string | null => {
    let t = normCache.get(id);
    if (t === undefined) {
      // A missing extract file means UNKNOWN, not absent — readSourceText's
      // snippet fallback is too thin to prove a figure is unattributed.
      const s = bySourceId.get(id);
      try {
        t = s && existsSync(join(dir, s.extract)) ? normalizeNumeralText(readSourceText(dir, s)) : null;
      } catch {
        t = null;
      }
      normCache.set(id, t);
    }
    return t;
  };
  for (const f of present) {
    if (!HARD_FILES.includes(f)) continue;
    for (const u of unitsOfFile(readFileSync(join(dir, f), "utf8"))) {
      for (const claim of u.kind === "text" ? [u.text] : u.items) {
        const cited = unitSourceTokens(claim).filter((id) => ids.has(id));
        if (!cited.length) continue;
        const nums = extractNumerals(claim);
        if (!nums.length) continue;
        const texts = cited.map(normOf).filter((t): t is string => t !== null);
        if (!texts.length) continue;
        for (const n of nums) {
          if (!texts.some((t) => t.includes(n))) {
            numeralIssues.push({ file: f, claim: claim.trim().slice(0, 120), numeral: n, sourceIds: cited });
          }
        }
      }
    }
  }
  if (numeralIssues.length) {
    const eg = numeralIssues[0]!;
    const msg =
      `${numeralIssues.length} numeral(s) in cited claim(s) not found in any cited source extract ` +
      `(e.g. "${eg.numeral}" cited to ${eg.sourceIds.join(", ")}). ` +
      `Verify the attribution, \`fetch --url\` the page that carries the figure, or flag it [M].`;
    if (opts.strictNumerals) errors.push(`--strict-numerals: ${msg}`);
    else warnings.push(msg);
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
    ...(numeralIssues.length ? { numeralIssues } : {}),
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
  for (const n of (r.numeralIssues ?? []).slice(0, 5))
    lines.push(`  ⚠ [${n.file}] numeral "${n.numeral}" not in ${n.sourceIds.join("/")}: "${n.claim.slice(0, 80)}…"`);
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
