import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { writeArtifact } from "./no-write.js";
import { join } from "node:path";
import type { ClaimEvidencePair, Source, Verdict, VerdictKind, VerifyResult } from "./types.js";
import { DEEP_CAPS } from "./types.js";
import { extractNumerals, normalizeNumeralText, unitSourceTokens, unitsOfFile } from "./claims.js";
import { readJson, readSourceText } from "./dossier.js";
import { focusedSnippet } from "./backends/fetch.js";
import { sourceTextWithoutPassageLabels } from "./passages.js";

const HARD_FILES = ["REPORT.md"];
const VALID_VERDICTS: VerdictKind[] = ["supported", "partial", "refuted", "unsupported"];

export interface VerifyWorklist {
  run: string;
  pairs: ClaimEvidencePair[];
}

// CONTENT BINDING — the identity of what an agent actually adjudicated: the
// claim's FULL text plus the FULL cited extract. Deliberately not the 600-char
// `extractDigest`: an edit past the digest window (or past the claim's 400-char
// display cap) would leave the stored snippet byte-identical while changing the
// evidence the verdict rests on. Computed once, at worklist GENERATION time, and
// carried by the verdict from `VERIFY.todo.json` through `VERIFY.json`.
export function pairFingerprint(claim: string, extract: string): string {
  return createHash("sha256").update(String(claim.length)).update("|").update(claim).update(extract).digest("hex").slice(0, 32);
}

export interface BuiltWorklist {
  worklist: VerifyWorklist;
  total: number; // pairs derivable from REPORT before the cap
  kept: number; // pairs in this (possibly capped/sharded) worklist
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
// REPORT that cites a real [S#], emit one pair per cited source with a
// claim-focused digest of that source's extract, so a skeptic agent reads the
// relevant passage rather than the whole page. Deterministic; the JUDGEMENT is
// the agent's. Capped at maxVerify (highest-trust sources first) to bound the
// loop. With { shards, shard } it keeps only this shard's stripe of the worklist,
// so N skeptic subagents can adjudicate disjoint slices in parallel and
// `verify --apply` reassembles them. The default (no-shard) path is unchanged.
//
// PURE (no file writes): `runVerify` persists the result; the `check
// --require-verify` coverage gate re-derives it to detect dropped verdicts. Same
// claim granularity + cap + optional shard as before, so the re-derived pairs
// line up with what `verify --run` emitted.
//
// The digests are DEFERRED: pairs are derived with their identity keys only,
// the cap and the shard stripe are applied to those light pairs, and
// `extractDigest`/`numeralsAbsent` are computed in one final pass over the
// survivors. `cmp` reads only trust/claimId/sourceId, so neither the kept set
// nor its order depends on the deferred fields — the emitted pairs (and their
// key order, which is `VERIFY.todo.json`'s bytes) are unchanged; a capped or
// sharded run simply stops digesting the pairs it then throws away.
//
// With { keysOnly: true } that final pass is skipped entirely and NO extract is
// read: each pair carries its identity keys (claimId, file, sourceId, claim,
// extractPath) with an empty `extractDigest` and no `numeralsAbsent`. It exists
// for `check --require-verify`, whose coverage gate matches pairs on
// (claimId, sourceId) alone — never for a worklist an agent will adjudicate.
export function buildWorklist(dir: string, opts: { maxVerify?: number; shards?: number; shard?: number; keysOnly?: boolean } = {}): BuiltWorklist {
  const sources = readJson<Source[]>(join(dir, "sources.json"), "sources.json");
  if (!Array.isArray(sources)) {
    throw new Error(`sources.json in ${dir} is not a JSON array — re-run \`ultrasearch gather\`.`);
  }
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
  // Numeral containment is tested against the FULL extract (not the 600-char
  // digest, which may legitimately omit the figure), normalized once per source.
  const normCache = new Map<string, string>();
  const normOf = (s: Source): string => {
    let t = normCache.get(s.id);
    if (t === undefined) {
      t = normalizeNumeralText(sourceTextWithoutPassageLabels(textOf(s)));
      normCache.set(s.id, t);
    }
    return t;
  };

  // A derived pair BEFORE its digest: identity keys plus what the cap and the
  // deferred digest pass need (trust, the source record, the claim's numerals).
  type LightPair = {
    claimId: string;
    file: string;
    sourceId: string;
    claim: string;
    extractPath: string;
    trust: number;
    source: Source;
    rawClaim: string;
    nums: string[];
  };

  const pairs: LightPair[] = [];
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
      const nums = extractNumerals(claim);
      for (const id of ids) {
        const s = byId.get(id)!;
        pairs.push({
          claimId,
          file,
          sourceId: id,
          claim: claim.trim().slice(0, 400),
          extractPath: s.extract,
          trust: s.trust,
          source: s,
          rawClaim: claim,
          nums,
        });
      }
    }
  }

  // Cap deterministically: highest-trust sources first, stable by claim/source id.
  const cmp = (a: { trust: number; claimId: string; sourceId: string }, b: typeof a): number =>
    b.trust - a.trust || a.claimId.localeCompare(b.claimId) || a.sourceId.localeCompare(b.sourceId);
  const max = Math.max(1, Math.floor(opts.maxVerify ?? DEEP_CAPS.maxVerify));
  const kept = pairs.length > max ? pairs.slice().sort(cmp).slice(0, max) : pairs;

  // Optional sharding for parallel skeptics: impose ONE canonical order on the
  // kept set (independent of whether the cap branch ran), then keep only this
  // shard's stripe (i % shards === shard) so N shards partition the worklist with
  // no overlap or loss. Disabled (default) ⇒ the original document-order worklist.
  const shards = opts.shards !== undefined ? Math.max(1, Math.floor(opts.shards)) : undefined;
  const shard = shards !== undefined ? Math.min(Math.max(0, Math.floor(opts.shard ?? 0)), shards - 1) : 0;
  const shaped =
    shards !== undefined
      ? kept
          .slice()
          .sort(cmp)
          .filter((_, i) => i % shards === shard)
      : kept;
  // Only NOW read the extracts — one focused digest per SURVIVING pair. The key
  // order below is the artifact's byte order; do not reshuffle it.
  const emit = (p: LightPair): ClaimEvidencePair => {
    if (opts.keysOnly) {
      // No extract is read here, so there is no `fingerprint` either: a
      // keys-only derivation can answer "which pairs exist", never "is this
      // verdict still bound to the text it judged".
      return { claimId: p.claimId, file: p.file, sourceId: p.sourceId, claim: p.claim, extractPath: p.extractPath, extractDigest: "" };
    }
    // Precompute which claim numerals this source's extract does NOT contain,
    // so the adjudicating skeptic cannot miss a specific figure that its cited
    // source never states (verdict caps at `partial`).
    const norm = p.nums.length ? normOf(p.source) : "";
    const numeralsAbsent = p.nums.filter((n) => !norm.includes(n));
    return {
      claimId: p.claimId,
      file: p.file,
      sourceId: p.sourceId,
      claim: p.claim,
      extractPath: p.extractPath,
      extractDigest: focusedSnippet(textOf(p.source), p.rawClaim, { maxChars: 600, maxSentences: 4 }),
      // Bound to the FULL claim + the FULL extract as they are RIGHT NOW.
      fingerprint: pairFingerprint(p.rawClaim, textOf(p.source)),
      ...(numeralsAbsent.length ? { numeralsAbsent } : {}),
    };
  };
  const worklist: VerifyWorklist = { run: dir, pairs: shaped.map(emit) };
  return { worklist, total: pairs.length, kept: shaped.length };
}

// Phase A — build the claim↔source verification worklist AND persist it
// (VERIFY.todo.json machine worklist + VERIFY.md human checklist). Thin wrapper
// over `buildWorklist`; see its comment for the derivation + sharding contract.
export function runVerify(dir: string, opts: { maxVerify?: number; shards?: number; shard?: number } = {}): VerifyWorklist {
  const { worklist, total, kept } = buildWorklist(dir, opts);
  const shards = opts.shards !== undefined ? Math.max(1, Math.floor(opts.shards)) : undefined;
  const shard = shards !== undefined ? Math.min(Math.max(0, Math.floor(opts.shard ?? 0)), shards - 1) : 0;

  const todo = {
    run: dir,
    pairs: worklist.pairs.map((p) => ({ ...p, verdict: null as VerdictKind | null, note: "" })),
  };
  const todoName = shards !== undefined ? `VERIFY.todo.${shard}.json` : "VERIFY.todo.json";
  const mdName = shards !== undefined ? `VERIFY.${shard}.md` : "VERIFY.md";
  writeArtifact(join(dir, todoName), JSON.stringify(todo, null, 2));
  writeArtifact(join(dir, mdName), renderWorklistMd(worklist, total, kept));
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
      `\`ultrasearch verify --apply verdicts.json --run <dir>\`. ` +
      `A specific numeral/date/quantity asserted by the claim but absent from the cited extract caps the ` +
      `verdict at **partial** — never \`supported\` (flagged pairs carry a precomputed warning).`,
  );
  if (kept < total) out.push(`\n_Showing ${kept} of ${total} pair(s) — capped at the highest-trust sources._`);
  out.push("");
  for (const p of wl.pairs) {
    out.push(`## ${p.claimId} · ${p.sourceId}`);
    out.push(`**Claim:** ${p.claim}`);
    out.push(`**Cited source (\`${p.extractPath}\`):** ${p.extractDigest}`);
    if (p.numeralsAbsent?.length) {
      out.push(
        `**⚠ Numerals not found in this source's extract:** ${p.numeralsAbsent.join(", ")} — verdict caps at *partial* unless you locate them in the full extract.`,
      );
    }
    out.push(`**Verdict:** _____ · **Note:** _____`);
    out.push("");
  }
  return out.join("\n");
}

// Parse + validate one agent-filled verdicts file (a `{ pairs: Verdict[] }`
// object, a `{ verdicts: Verdict[] }` object — the shape the orchestrate-emitted
// skeptic fragments return — or a bare `Verdict[]` array) into normalized
// Verdict records. FAIL-CLOSED: a file that yields no rows means the fold never
// engaged — folding it into a green "0/0 adjudicated ✓" would silently discard
// the whole adjudication, so it throws instead.
function parseVerdictFile(verdictsPath: string): Verdict[] {
  const raw = readJson<any>(verdictsPath, `verdicts file`);
  const list: any[] = Array.isArray(raw) ? raw : Array.isArray(raw?.pairs) ? raw.pairs : Array.isArray(raw?.verdicts) ? raw.verdicts : [];
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
      ...(typeof v.fingerprint === "string" && v.fingerprint ? { fingerprint: v.fingerprint } : {}),
      verdict,
      note: typeof v.note === "string" ? v.note : "",
    });
  }
  if (verdicts.length === 0) {
    throw new Error(
      `${verdictsPath}: no verdict rows found — expected a bare array, { pairs: [...] } or { verdicts: [...] } ` +
        `with at least one { claimId, sourceId, verdict, note } row (fail-closed: an empty fold would pass a 0/0 gate).`,
    );
  }
  return verdicts;
}

export const pairKey = (p: { claimId: string; sourceId: string }): string => `${p.claimId}/${p.sourceId}`;

export interface BindingReport {
  derivable: boolean; // could the CURRENT worklist be re-derived at all?
  stale: string[]; // keys whose stored content contradicts the current worklist
  unbound: string[]; // adjudicated keys carrying no fingerprint (strict mode only)
  bound: Verdict[]; // the rows, with a confirmed/stamped `fingerprint` where earned
  expected: ClaimEvidencePair[]; // the current worklist the rows were bound against
}

// Bind a set of verdicts to the CURRENT worklist — the one rule that makes a
// verdict about TEXT rather than about a (claimId, sourceId) key pair.
//
// A row is STALE when anything it carries from generation time contradicts what
// the worklist says today: its `fingerprint` (claim + full extract), or, for a
// row that predates fingerprints, the claim text / extract path / digest it
// recorded. Staleness is fatal to the caller — a verdict that judged other text
// must never be re-stamped as fresh.
//
// Minimal/legacy rows borrow a fingerprint only from the saved generation-time
// worklist (including shards), after comparing it with the full current text.
// Display snippets cannot prove identity: both claim and extract are truncated.
//
// Rows naming a pair outside the current worklist (e.g. a capped-out or foreign
// pair) are left untouched: the coverage gate, not the binding, decides whether
// the worklist is fully adjudicated.
//
// `{ strict: true }` is the GATE's reading, used by `check --require-verify`:
// there, fold time is long past, so an adjudicated row for a current pair must
// already CARRY a matching fingerprint — a record that never went through
// `verify --apply` (hand-written, or written before binding existed) is reported
// as `unbound` instead of being stamped on the spot.
export function bindToWorklist(dir: string, verdicts: Verdict[], opts: { strict?: boolean } = {}): BindingReport {
  let expected: ClaimEvidencePair[];
  try {
    expected = buildWorklist(dir).worklist.pairs;
  } catch {
    // No derivable worklist (no sources.json / unreadable extract): nothing can
    // be vouched for here. Callers fail closed on `derivable === false` where a
    // green result would otherwise mean "verified".
    return { derivable: false, stale: [], unbound: [], bound: verdicts, expected: [] };
  }
  const byKey = new Map(expected.map((p) => [pairKey(p), p] as const));
  const saved = new Map<string, Set<string>>();
  if (!opts.strict) {
    for (const name of readdirSync(dir).filter((name) => /^VERIFY\.todo(?:\.\d+)?\.json$/.test(name))) {
      try {
        const todo = JSON.parse(readFileSync(join(dir, name), "utf8"));
        if (!Array.isArray(todo?.pairs)) continue;
        for (const p of todo.pairs) {
          if (!p || typeof p.claimId !== "string" || typeof p.sourceId !== "string" || !/^[a-f0-9]{32}$/.test(p.fingerprint ?? "")) continue;
          const key = pairKey(p);
          const fingerprints = saved.get(key) ?? new Set<string>();
          fingerprints.add(p.fingerprint);
          saved.set(key, fingerprints);
        }
      } catch {
        // An unreadable generation record cannot bind any verdict.
      }
    }
  }
  const stale: string[] = [];
  const unbound: string[] = [];
  const bound: Verdict[] = [];
  for (const v of verdicts) {
    const key = pairKey(v);
    const exp = byKey.get(key);
    if (!exp) {
      bound.push(v);
      continue;
    }
    if (v.fingerprint) {
      if (v.fingerprint !== exp.fingerprint) stale.push(key);
      bound.push(v);
      continue;
    }
    const contradicts =
      (!!v.claim && v.claim.trim() !== exp.claim.trim()) ||
      (!!v.extractPath && v.extractPath !== exp.extractPath) ||
      (!!v.extractDigest && v.extractDigest !== exp.extractDigest);
    const fingerprints = saved.get(key);
    // Older sharded/unsharded worklists may coexist after regeneration. A
    // current saved fingerprint can bind a compact verdict; an older sibling
    // must not veto it. Stale-only records still fail, and explicit verdict
    // fingerprints were checked above without borrowing from any worklist.
    if (contradicts || (!opts.strict && fingerprints && !fingerprints.has(exp.fingerprint!))) stale.push(key);
    else if (opts.strict || !fingerprints) {
      if (v.verdict) unbound.push(key);
      bound.push(v);
      continue;
    }
    bound.push(stale.includes(key) ? v : { ...v, fingerprint: exp.fingerprint });
  }
  return { derivable: true, stale, unbound, bound, expected };
}

// Phase B — read one OR several agent-filled verdicts files (e.g. one per
// shard), validate them, reduce to a VerifyResult, and persist the resolved
// record to VERIFY.json (which `check --semantic` and `render` then read). When
// several files are given they are merged by (claimId, sourceId), last-wins, so
// disjoint shards reassemble cleanly and a re-run of the same pair is counted
// once. The key omits `file` deliberately — claimId is globally unique across
// the hard files, so (claimId, sourceId) already identifies a pair, and a
// partial agent file that drops `file` still dedups. A single file is
// byte-identical to the old behaviour.
export function applyVerdicts(dir: string, verdictsPath: string | string[]): VerifyResult {
  const paths = Array.isArray(verdictsPath) ? verdictsPath : [verdictsPath];
  const merged = new Map<string, Verdict>();
  for (const p of paths) {
    for (const v of parseVerdictFile(p)) {
      merged.set(`${v.claimId} ${v.sourceId}`, v);
    }
  }
  // BIND before folding: a verdict may only enter the ledger if the claim and
  // the extract it judged are still the ones on disk. Fail closed — throwing
  // BEFORE `writeArtifact` is what stops a stale adjudication from acquiring a
  // fresh fingerprint by being re-applied over edited text.
  const binding = bindToWorklist(dir, [...merged.values()]);
  if (binding.stale.length) {
    throw new Error(
      `${binding.stale.length} verdict(s) judged text that has changed since the worklist was generated ` +
        `(${binding.stale.slice(0, 6).join(", ")}${binding.stale.length > 6 ? ", …" : ""}): REPORT.md and/or the cited ` +
        `extract were edited after \`verify\`. Re-run \`verify\` and re-adjudicate the regenerated worklist, then ` +
        `\`verify --apply\` — a verdict cannot be transferred to text nobody judged (nothing was written).`,
    );
  }
  if (binding.unbound.length) {
    throw new Error(
      `Unbound verdict(s) (${binding.unbound.join(", ")}): missing a valid generation-time fingerprint. Re-run \`verify\`, re-adjudicate the saved worklist, then \`verify --apply\` (nothing was written).`,
    );
  }
  const verdicts = binding.bound;
  const result = reduceVerdicts(verdicts);
  // Persist the gate result + the full adjudicated list (the latter only for
  // `render`'s per-claim verdict table / badges; `check --semantic` ignores it).
  writeArtifact(join(dir, "VERIFY.json"), JSON.stringify({ ...result, verdicts }, null, 2));
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
  const contradictions: NonNullable<VerifyResult["contradictions"]> = [];
  const uniqSorted = (ids: string[]): string[] => [...new Set(ids)].sort((a, b) => a.localeCompare(b));
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

    // Source-level contradiction: within this ONE claim, some cited source
    // SUPPORTS it (supported/partial) while another REFUTES it. Detectable with
    // zero semantics from the verdicts; additive — independent of the pass/fail
    // gate above (a claim can be "supported overall" yet still surface a
    // conflict worth showing). `unsupported` (the source simply doesn't address
    // the claim) is not a disagreement, so it does not count here.
    const supporting = adjudicated.filter((g) => g.verdict === "supported" || g.verdict === "partial");
    const refuting = adjudicated.filter((g) => g.verdict === "refuted");
    if (supporting.length && refuting.length) {
      const note = refuting.find((g) => g.note)?.note ?? supporting.find((g) => g.note)?.note ?? "";
      contradictions.push({
        claimId,
        supporting: uniqSorted(supporting.map((g) => g.sourceId)),
        refuting: uniqSorted(refuting.map((g) => g.sourceId)),
        note,
      });
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
    ...(contradictions.length ? { contradictions } : {}),
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
