import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { ClaimEvidencePair, Source, Verdict, VerdictKind, VerifyResult } from "./types.js";
import { DEEP_CAPS } from "./types.js";
import { unitsOfFile, unitSourceTokens } from "./check.js";
import { readSourceText } from "./dossier.js";
import { focusedSnippet } from "./backends/fetch.js";

const HARD_FILES = ["REPORT.md", "FULL.md"];
const VALID_VERDICTS: VerdictKind[] = ["supported", "partial", "refuted", "unsupported"];

export interface VerifyWorklist {
  run: string;
  pairs: ClaimEvidencePair[];
}

// Flatten a hard file's claim units into individual claim strings: a text unit
// is one claim; each list item is its own claim — the same granularity `check`
// evaluates coverage at, so the worklist and the gate agree on what a claim is.
function claimStrings(text: string): string[] {
  const out: string[] = [];
  for (const u of unitsOfFile(text)) {
    if (u.kind === "text") out.push(u.text);
    else for (const it of u.items) out.push(it);
  }
  return out;
}

// Phase A — build the claim↔source verification worklist. For every claim in
// REPORT/FULL that cites a real [S#], emit one pair per cited source with a
// claim-focused digest of that source's extract, so a skeptic agent reads the
// relevant passage rather than the whole page. Deterministic; the JUDGEMENT is
// the agent's. Capped at maxVerify (highest-trust sources first) to bound the
// loop. Writes VERIFY.todo.json (machine worklist) + VERIFY.md (human checklist).
export function runVerify(dir: string, opts: { maxVerify?: number } = {}): VerifyWorklist {
  const sources: Source[] = JSON.parse(readFileSync(join(dir, "sources.json"), "utf8"));
  const byId = new Map(sources.map((s) => [s.id, s] as const));
  const textCache = new Map<string, string>();
  const textOf = (s: Source): string => {
    let t = textCache.get(s.id);
    if (t === undefined) {
      t = readSourceText(dir, s);
      textCache.set(s.id, t);
    }
    return t;
  };

  const pairs: (ClaimEvidencePair & { trust: number })[] = [];
  let claimNo = 0;
  for (const file of HARD_FILES) {
    const p = join(dir, file);
    if (!existsSync(p)) continue;
    const text = readFileSync(p, "utf8");
    for (const claim of claimStrings(text)) {
      const ids = unitSourceTokens(claim).filter((id) => byId.has(id));
      if (!ids.length) continue;
      claimNo++;
      const claimId = `C${claimNo}`;
      for (const id of ids) {
        const s = byId.get(id)!;
        pairs.push({
          claimId,
          file,
          sourceId: id,
          claim: claim.trim().slice(0, 400),
          extractPath: s.extract,
          extractDigest: focusedSnippet(textOf(s), claim, { maxChars: 600, maxSentences: 4 }),
          trust: s.trust,
        });
      }
    }
  }

  // Cap deterministically: highest-trust sources first, stable by claim/source id.
  const max = Math.max(1, Math.floor(opts.maxVerify ?? DEEP_CAPS.maxVerify));
  const kept =
    pairs.length > max
      ? pairs
          .slice()
          .sort(
            (a, b) =>
              b.trust - a.trust || a.claimId.localeCompare(b.claimId) || a.sourceId.localeCompare(b.sourceId),
          )
          .slice(0, max)
      : pairs;
  const worklist: VerifyWorklist = { run: dir, pairs: kept.map(({ trust, ...rest }) => rest) };

  const todo = {
    run: dir,
    pairs: worklist.pairs.map((p) => ({ ...p, verdict: null as VerdictKind | null, note: "" })),
  };
  writeFileSync(join(dir, "VERIFY.todo.json"), JSON.stringify(todo, null, 2));
  writeFileSync(join(dir, "VERIFY.md"), renderWorklistMd(worklist, pairs.length, kept.length));
  return worklist;
}

function renderWorklistMd(wl: VerifyWorklist, total: number, kept: number): string {
  const out: string[] = [];
  out.push(`# Verification worklist`);
  out.push("");
  out.push(
    `For each pair below, open the cited extract and judge whether it **supports** the claim. ` +
      `In \`VERIFY.todo.json\`, set each \`verdict\` to one of supported · partial · refuted · unsupported, ` +
      `add a short \`note\`, save it (e.g. as \`verdicts.json\`), then run ` +
      `\`ultrasearch verify --apply verdicts.json --run <dir>\`.`,
  );
  if (kept < total) out.push(`\n_Showing ${kept} of ${total} pair(s) — capped at the highest-trust sources._`);
  out.push("");
  for (const p of wl.pairs) {
    out.push(`## ${p.claimId} · ${p.sourceId}`);
    out.push(`**Claim:** ${p.claim}`);
    out.push(`**Cited source (\`${p.extractPath}\`):** ${p.extractDigest}`);
    out.push(`**Verdict:** _____ · **Note:** _____`);
    out.push("");
  }
  return out.join("\n");
}

// Phase B — read an agent-filled verdicts file (a `{ pairs: Verdict[] }` object
// or a bare `Verdict[]` array), validate it, reduce it to a VerifyResult, and
// persist the resolved record to VERIFY.json (which `check --semantic` and
// `render` then read).
export function applyVerdicts(dir: string, verdictsPath: string): VerifyResult {
  const raw = JSON.parse(readFileSync(verdictsPath, "utf8"));
  const list: any[] = Array.isArray(raw) ? raw : Array.isArray(raw?.pairs) ? raw.pairs : [];
  const verdicts: Verdict[] = [];
  for (const v of list) {
    if (!v || typeof v.claimId !== "string" || typeof v.sourceId !== "string") continue;
    const verdict = VALID_VERDICTS.includes(v.verdict) ? (v.verdict as VerdictKind) : (undefined as unknown as VerdictKind);
    verdicts.push({
      claimId: v.claimId,
      file: typeof v.file === "string" ? v.file : "",
      sourceId: v.sourceId,
      claim: typeof v.claim === "string" ? v.claim : "",
      extractPath: typeof v.extractPath === "string" ? v.extractPath : "",
      extractDigest: typeof v.extractDigest === "string" ? v.extractDigest : "",
      verdict,
      note: typeof v.note === "string" ? v.note : "",
    });
  }
  const result = reduceVerdicts(verdicts);
  // Persist the gate result + the full adjudicated list (the latter only for
  // `render`'s per-claim verdict table / badges; `check --semantic` ignores it).
  writeFileSync(join(dir, "VERIFY.json"), JSON.stringify({ ...result, verdicts }, null, 2));
  return result;
}

// Fold per-pair verdicts into a pass/fail. A claim FAILS if a cited source
// REFUTES it, or if every one of its fully-adjudicated cited sources is
// `unsupported` (nothing actually backs the claim). Pairs still missing a
// verdict are reported as unadjudicated (a warning, not a failure).
export function reduceVerdicts(verdicts: Verdict[]): VerifyResult {
  const counts: Record<VerdictKind, number> = { supported: 0, partial: 0, refuted: 0, unsupported: 0 };
  for (const v of verdicts) if (v.verdict && counts[v.verdict] !== undefined) counts[v.verdict]++;

  const byClaim = new Map<string, Verdict[]>();
  for (const v of verdicts) {
    const group = byClaim.get(v.claimId) ?? [];
    group.push(v);
    byClaim.set(v.claimId, group);
  }

  const failures: VerifyResult["failures"] = [];
  const unadjudicated: string[] = [];
  for (const [claimId, group] of byClaim) {
    const adjudicated = group.filter((g) => !!g.verdict);
    if (adjudicated.length < group.length) unadjudicated.push(claimId);
    const refuted = adjudicated.find((g) => g.verdict === "refuted");
    const hasSupport = adjudicated.some((g) => g.verdict === "supported" || g.verdict === "partial");
    if (refuted) {
      failures.push({ claimId, sourceId: refuted.sourceId, verdict: "refuted", note: refuted.note });
    } else if (adjudicated.length === group.length && adjudicated.length > 0 && !hasSupport) {
      const u = adjudicated.find((g) => g.verdict === "unsupported") ?? adjudicated[0]!;
      failures.push({ claimId, sourceId: u.sourceId, verdict: u.verdict, note: u.note });
    }
  }

  return {
    ok: failures.length === 0,
    pairs: verdicts.length,
    adjudicated: verdicts.filter((v) => !!v.verdict).length,
    supported: counts.supported,
    partial: counts.partial,
    refuted: counts.refuted,
    unsupported: counts.unsupported,
    failures,
    unadjudicated,
  };
}

export function formatVerifyReport(r: VerifyResult): string {
  const lines: string[] = [];
  lines.push(`ultrasearch verify: ${r.adjudicated}/${r.pairs} pair(s) adjudicated`);
  lines.push(`  supported: ${r.supported} · partial: ${r.partial} · refuted: ${r.refuted} · unsupported: ${r.unsupported}`);
  for (const f of r.failures.slice(0, 12)) {
    lines.push(`  ✗ ${f.claimId} (${f.sourceId}): ${f.verdict}${f.note ? " — " + f.note : ""}`);
  }
  if (r.unadjudicated.length) {
    lines.push(`  ⚠ ${r.unadjudicated.length} claim(s) not fully adjudicated: ${r.unadjudicated.join(", ")}`);
  }
  lines.push(r.ok ? `  ✓ every claim is backed by a cited source` : `  ✗ some claims are refuted or unsupported`);
  return lines.join("\n");
}
