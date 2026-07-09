import { describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { main } from "../src/cli.js";
import { runVerify, applyVerdicts, reduceVerdicts } from "../src/verify.js";
import { runCheck } from "../src/check.js";
import { writeFixtureDossier } from "./dossierfix.js";
import type { Verdict } from "../src/types.js";

function scratch(): string {
  return mkdtempSync(join(tmpdir(), "us-verify-"));
}
function report(dir: string, body: string) {
  writeFileSync(join(dir, "REPORT.md"), body);
}

// claim 1 cites S1 only, claim 2 cites S2 only.
const GROUNDED = `# R
## TL;DR
A token bucket caps requests per window and allows controlled bursts [S1].
## More
Leaky buckets smooth traffic into a steady output rate over time [S2].`;

// Build a verdicts.json from the written worklist, mapping sourceId → verdict.
function writeVerdicts(dir: string, map: Record<string, string>): string {
  const todo = JSON.parse(readFileSync(join(dir, "VERIFY.todo.json"), "utf8"));
  const pairs = todo.pairs.map((p: any) => ({ ...p, verdict: map[p.sourceId] ?? "supported", note: "" }));
  const f = join(dir, "verdicts.json");
  writeFileSync(f, JSON.stringify({ pairs }));
  return f;
}

// Build a per-shard verdicts file from VERIFY.todo.<shard>.json.
function writeShardVerdicts(dir: string, shard: number, map: Record<string, string>): string {
  const todo = JSON.parse(readFileSync(join(dir, `VERIFY.todo.${shard}.json`), "utf8"));
  const pairs = todo.pairs.map((p: any) => ({ ...p, verdict: map[p.sourceId] ?? "supported", note: "" }));
  const f = join(dir, `verdicts.${shard}.json`);
  writeFileSync(f, JSON.stringify({ pairs }));
  return f;
}

const BIG_REPORT = `# X
## A
Claim one about the subject matter at hand here [S1].
## B
Claim two about the subject matter at hand here [S2].
## C
Claim three about the subject matter at hand here [S3].
## D
Claim four about the subject matter at hand here [S4].`;

describe("runVerify (worklist)", () => {
  it("extracts one claim↔source pair per cited [S#] and writes the worklist", () => {
    const dir = scratch();
    writeFixtureDossier(dir, 2);
    report(dir, GROUNDED);
    const r = runVerify(dir);
    expect(r.pairs.length).toBe(2);
    expect(r.pairs.map((p) => p.sourceId).sort()).toEqual(["S1", "S2"]);
    expect(r.pairs[0]!.extractPath).toMatch(/sources\/S\d\.md/);
    expect(r.pairs.map((p) => p.claimId)).toEqual(["C1", "C2"]);
    expect(existsSync(join(dir, "VERIFY.todo.json"))).toBe(true);
    expect(existsSync(join(dir, "VERIFY.md"))).toBe(true);
    rmSync(dir, { recursive: true, force: true });
  });

  it("emits no pairs from the Sources appendix (boilerplate is not a claim)", () => {
    const dir = scratch();
    writeFixtureDossier(dir, 2);
    report(
      dir,
      `${GROUNDED}\n\n## Sources\nSee the appendix rendered from the dossier [S1] [S2].\n- [S1] Rate limiting algorithms\n- [S2] Token bucket overview`,
    );
    const r = runVerify(dir);
    expect(r.pairs.length).toBe(2);
    expect(r.pairs.map((p) => p.claimId)).toEqual(["C1", "C2"]);
    rmSync(dir, { recursive: true, force: true });
  });

  it("pairs a claim whose [S#] is on a continuation line (parser parity with check)", () => {
    const dir = scratch();
    writeFixtureDossier(dir, 2);
    report(dir, "# X\n- A grounded claim about token buckets and controlled bursts\n  that the source documents in detail [S1].");
    const r = runVerify(dir);
    expect(r.pairs.length).toBe(1);
    expect(r.pairs[0]!.sourceId).toBe("S1");
    rmSync(dir, { recursive: true, force: true });
  });

  it("ignores a [S#] hidden in inline code (parser parity, audit C1)", () => {
    const dir = scratch();
    writeFixtureDossier(dir, 2);
    report(dir, "# X\nA grounded claim about request windows and token buckets here [S1].\n\nAnother line mentioning `[S2]` only in code.");
    const r = runVerify(dir);
    expect(r.pairs.map((p) => p.sourceId)).toEqual(["S1"]);
    rmSync(dir, { recursive: true, force: true });
  });

  it("caps the worklist at maxVerify", () => {
    const dir = scratch();
    writeFixtureDossier(dir, 3);
    report(
      dir,
      "# X\n## A\nClaim one about the subject matter at hand here [S1].\n## B\nClaim two about the subject matter at hand here [S2].\n## C\nClaim three about the subject matter at hand here [S3].",
    );
    const r = runVerify(dir, { maxVerify: 2 });
    expect(r.pairs.length).toBe(2);
    rmSync(dir, { recursive: true, force: true });
  });
});

describe("applyVerdicts (semantic gate)", () => {
  function setup(): string {
    const dir = scratch();
    writeFixtureDossier(dir, 2);
    report(dir, GROUNDED);
    runVerify(dir);
    return dir;
  }

  it("passes when every claim has a supporting source", () => {
    const dir = setup();
    const r = applyVerdicts(dir, writeVerdicts(dir, { S1: "supported", S2: "partial" }));
    expect(r.ok).toBe(true);
    expect(r.supported).toBe(1);
    expect(r.partial).toBe(1);
    expect(existsSync(join(dir, "VERIFY.json"))).toBe(true);
    rmSync(dir, { recursive: true, force: true });
  });

  it("fails when a cited source refutes the claim", () => {
    const dir = setup();
    const r = applyVerdicts(dir, writeVerdicts(dir, { S1: "refuted", S2: "supported" }));
    expect(r.ok).toBe(false);
    expect(r.failures.some((f) => f.verdict === "refuted")).toBe(true);
    rmSync(dir, { recursive: true, force: true });
  });

  it("fails when a claim's only cited source is unsupported", () => {
    const dir = setup();
    const r = applyVerdicts(dir, writeVerdicts(dir, { S1: "unsupported", S2: "supported" }));
    expect(r.ok).toBe(false);
    expect(r.failures.some((f) => f.verdict === "unsupported")).toBe(true);
    rmSync(dir, { recursive: true, force: true });
  });
});

describe("verify sharding + multi-file apply", () => {
  it("partitions the worklist across shards with no overlap or loss", () => {
    const dir = scratch();
    writeFixtureDossier(dir, 4);
    report(dir, BIG_REPORT);
    const full = runVerify(dir); // unsharded → VERIFY.todo.json
    const N = 3;
    const seen: string[] = [];
    for (let i = 0; i < N; i++) {
      const wl = runVerify(dir, { shards: N, shard: i });
      for (const p of wl.pairs) seen.push(`${p.claimId}|${p.sourceId}`);
    }
    const fullKeys = full.pairs.map((p) => `${p.claimId}|${p.sourceId}`).sort();
    expect(seen.slice().sort()).toEqual(fullKeys); // union == full set
    expect(new Set(seen).size).toBe(seen.length); // shards are disjoint
    rmSync(dir, { recursive: true, force: true });
  });

  it("a shard slice is stable across runs", () => {
    const dir = scratch();
    writeFixtureDossier(dir, 4);
    report(dir, BIG_REPORT);
    const a = runVerify(dir, { shards: 2, shard: 1 });
    const b = runVerify(dir, { shards: 2, shard: 1 });
    expect(a.pairs).toEqual(b.pairs);
    rmSync(dir, { recursive: true, force: true });
  });

  it("multi-file apply reassembles to the same gate result as a single-file apply", () => {
    const dir = scratch();
    writeFixtureDossier(dir, 4);
    report(dir, BIG_REPORT);
    runVerify(dir);
    const single = applyVerdicts(dir, writeVerdicts(dir, {})); // all supported
    const N = 2;
    const files: string[] = [];
    for (let i = 0; i < N; i++) {
      runVerify(dir, { shards: N, shard: i });
      files.push(writeShardVerdicts(dir, i, {}));
    }
    const multi = applyVerdicts(dir, files);
    expect(multi.ok).toBe(single.ok);
    expect(multi.pairs).toBe(single.pairs);
    expect(multi.supported).toBe(single.supported);
    rmSync(dir, { recursive: true, force: true });
  });

  it("counts a duplicate pair across files once (last-wins)", () => {
    const dir = scratch();
    writeFixtureDossier(dir, 2);
    report(dir, GROUNDED);
    runVerify(dir);
    const f1 = writeVerdicts(dir, { S1: "supported", S2: "supported" });
    // a second file repeats the same pairs — must not double-count
    const f2 = join(dir, "verdicts.dup.json");
    writeFileSync(f2, readFileSync(f1, "utf8"));
    const r = applyVerdicts(dir, [f1, f2]);
    expect(r.pairs).toBe(2);
    rmSync(dir, { recursive: true, force: true });
  });

  it("last-wins: a later file's verdict overrides an earlier file's for the same pair", () => {
    const dir = scratch();
    writeFixtureDossier(dir, 2);
    report(dir, GROUNDED); // C1→S1, C2→S2
    runVerify(dir);
    // capture each into its own file (writeVerdicts reuses verdicts.json)
    const refute = join(dir, "verdicts.refute.json");
    writeFileSync(refute, readFileSync(writeVerdicts(dir, { S1: "refuted", S2: "supported" }), "utf8"));
    const f2 = join(dir, "verdicts.fix.json");
    writeFileSync(f2, readFileSync(writeVerdicts(dir, { S1: "supported", S2: "supported" }), "utf8"));
    // later file (f2, all supported) wins → gate passes
    expect(applyVerdicts(dir, [refute, f2]).ok).toBe(true);
    // reverse order → the refuting file wins → gate fails
    expect(applyVerdicts(dir, [f2, refute]).ok).toBe(false);
    // either way the pair is counted once
    expect(applyVerdicts(dir, [refute, f2]).pairs).toBe(2);
    rmSync(dir, { recursive: true, force: true });
  });

  it("detects a contradiction that spans two shards after multi-apply", () => {
    const dir = scratch();
    writeFixtureDossier(dir, 2);
    report(dir, "# R\n## A\nA token bucket caps requests per window and allows controlled bursts [S1][S2].");
    const N = 2;
    runVerify(dir, { shards: N, shard: 0 });
    runVerify(dir, { shards: N, shard: 1 });
    // same map applied to whichever source landed in each shard
    const files = [writeShardVerdicts(dir, 0, { S1: "supported", S2: "refuted" }), writeShardVerdicts(dir, 1, { S1: "supported", S2: "refuted" })];
    const r = applyVerdicts(dir, files);
    expect(r.contradictions?.length).toBe(1);
    expect(r.contradictions![0]!.claimId).toBe("C1");
    rmSync(dir, { recursive: true, force: true });
  });
});

describe("contradiction surfacing", () => {
  // one claim cites BOTH S1 and S2, so its sources can disagree.
  const MULTICITE = `# R
## A
A token bucket caps requests per window and allows controlled bursts [S1][S2].`;

  function setup(body: string): string {
    const dir = scratch();
    writeFixtureDossier(dir, 2);
    report(dir, body);
    runVerify(dir);
    return dir;
  }

  it("flags a contradiction when one cited source supports and another refutes the same claim", () => {
    const dir = setup(MULTICITE);
    const r = applyVerdicts(dir, writeVerdicts(dir, { S1: "supported", S2: "refuted" }));
    expect(r.contradictions?.length).toBe(1);
    const c = r.contradictions![0]!;
    expect(c.claimId).toBe("C1");
    expect(c.supporting).toEqual(["S1"]);
    expect(c.refuting).toEqual(["S2"]);
    expect(r.ok).toBe(false); // additive: gate still fails on the refuted source
    rmSync(dir, { recursive: true, force: true });
  });

  it("emits no contradictions when all cited sources agree", () => {
    const dir = setup(MULTICITE);
    const r = applyVerdicts(dir, writeVerdicts(dir, { S1: "supported", S2: "partial" }));
    expect(r.contradictions ?? []).toEqual([]);
    expect(r.ok).toBe(true);
    rmSync(dir, { recursive: true, force: true });
  });

  it("does not flag disagreement ACROSS different claims (one source per claim)", () => {
    const dir = setup(GROUNDED);
    const r = applyVerdicts(dir, writeVerdicts(dir, { S1: "supported", S2: "refuted" }));
    expect(r.contradictions ?? []).toEqual([]);
    rmSync(dir, { recursive: true, force: true });
  });

  it("flags partial+refuted as a contradiction (partial counts as support)", () => {
    const dir = setup(MULTICITE);
    const r = applyVerdicts(dir, writeVerdicts(dir, { S1: "partial", S2: "refuted" }));
    expect(r.contradictions?.length).toBe(1);
    expect(r.contradictions![0]!.supporting).toEqual(["S1"]);
    expect(r.contradictions![0]!.refuting).toEqual(["S2"]);
    rmSync(dir, { recursive: true, force: true });
  });
});

describe("check --semantic composition", () => {
  it("folds VERIFY.json into the gate: plain check passes, semantic fails", () => {
    const dir = scratch();
    writeFixtureDossier(dir, 2);
    report(dir, GROUNDED);
    runVerify(dir);
    expect(runCheck(dir).ok).toBe(true); // mechanical passes
    applyVerdicts(dir, writeVerdicts(dir, { S1: "unsupported", S2: "supported" }));
    const sem = runCheck(dir, { semantic: true });
    expect(sem.ok).toBe(false);
    expect(sem.semantic?.ok).toBe(false);
    expect(runCheck(dir).ok).toBe(true); // plain check still unchanged
    rmSync(dir, { recursive: true, force: true });
  });

  it("surfaces a contradiction warning under --semantic", () => {
    const dir = scratch();
    writeFixtureDossier(dir, 2);
    report(dir, "# R\n## A\nA token bucket caps requests per window and allows controlled bursts [S1][S2].");
    runVerify(dir);
    // one cited source supports the claim, another refutes it → a contradiction
    // is recorded and surfaced as a warning by `check --semantic`.
    applyVerdicts(dir, writeVerdicts(dir, { S1: "supported", S2: "refuted" }));
    const sem = runCheck(dir, { semantic: true });
    expect(sem.warnings.join(" ").toLowerCase()).toContain("contradict");
    rmSync(dir, { recursive: true, force: true });
  });

  it("fails closed when --semantic is set but no VERIFY.json exists", () => {
    const dir = scratch();
    writeFixtureDossier(dir, 2);
    report(dir, GROUNDED);
    const r = runCheck(dir, { semantic: true });
    expect(r.ok).toBe(false);
    expect(r.errors.join(" ")).toMatch(/VERIFY\.json/);
    // the mechanical gate alone is still green — the escape hatch is dropping --semantic
    expect(runCheck(dir).ok).toBe(true);
    rmSync(dir, { recursive: true, force: true });
  });

  it("re-reduces the gate from verdicts[] — a tampered ok:true cannot false-pass", () => {
    const dir = scratch();
    writeFixtureDossier(dir, 2);
    report(dir, GROUNDED);
    runVerify(dir);
    applyVerdicts(dir, writeVerdicts(dir, { S1: "refuted", S2: "supported" }));
    // doctor the persisted summary: flip ok to true and empty the failures,
    // keeping the refuted verdict in verdicts[] — the gate must still fail.
    const p = join(dir, "VERIFY.json");
    const stored = JSON.parse(readFileSync(p, "utf8"));
    stored.ok = true;
    stored.failures = [];
    writeFileSync(p, JSON.stringify(stored, null, 2));
    const r = runCheck(dir, { semantic: true });
    expect(r.ok).toBe(false);
    expect(r.warnings.join(" ").toLowerCase()).toContain("re-reduced");
    rmSync(dir, { recursive: true, force: true });
  });

  it("re-reduces a stale ok:false whose verdicts[] all support — passes with a warning", () => {
    const dir = scratch();
    writeFixtureDossier(dir, 2);
    report(dir, GROUNDED);
    runVerify(dir);
    applyVerdicts(dir, writeVerdicts(dir, { S1: "supported", S2: "supported" }));
    const p = join(dir, "VERIFY.json");
    const stored = JSON.parse(readFileSync(p, "utf8"));
    stored.ok = false; // stale summary; verdicts[] is the source of truth
    writeFileSync(p, JSON.stringify(stored, null, 2));
    const r = runCheck(dir, { semantic: true });
    expect(r.ok).toBe(true);
    expect(r.warnings.join(" ").toLowerCase()).toContain("re-reduced");
    rmSync(dir, { recursive: true, force: true });
  });

  it("fails closed when VERIFY.json carries no verdicts[] (summary alone is not adjudication)", () => {
    const dir = scratch();
    writeFixtureDossier(dir, 2);
    report(dir, GROUNDED);
    writeFileSync(
      join(dir, "VERIFY.json"),
      JSON.stringify({ ok: true, pairs: 2, adjudicated: 2, supported: 2, partial: 0, refuted: 0, unsupported: 0, failures: [], unadjudicated: [] }),
    );
    const r = runCheck(dir, { semantic: true });
    expect(r.ok).toBe(false);
    expect(r.errors.join(" ")).toMatch(/0 adjudicated|verdicts/i);
    rmSync(dir, { recursive: true, force: true });
  });

  it("fails closed when VERIFY.json is unreadable", () => {
    const dir = scratch();
    writeFixtureDossier(dir, 2);
    report(dir, GROUNDED);
    writeFileSync(join(dir, "VERIFY.json"), "{not json");
    const r = runCheck(dir, { semantic: true });
    expect(r.ok).toBe(false);
    expect(r.errors.join(" ").toLowerCase()).toContain("unreadable");
    rmSync(dir, { recursive: true, force: true });
  });
});

describe("check --require-verify (deep exit gate)", () => {
  it("RED: fails when there is no VERIFY.json to gate on", () => {
    const dir = scratch();
    writeFixtureDossier(dir, 2);
    report(dir, GROUNDED);
    const r = runCheck(dir, { semantic: true, requireVerify: true });
    expect(r.ok).toBe(false);
    expect(r.errors.join(" ")).toMatch(/require-verify/);
    // plain check (mechanical) is still green — the gate is additive
    expect(runCheck(dir).ok).toBe(true);
    rmSync(dir, { recursive: true, force: true });
  });

  it("RED: fails when VERIFY.json has 0 adjudicated claims", () => {
    const dir = scratch();
    writeFixtureDossier(dir, 2);
    report(dir, GROUNDED);
    runVerify(dir);
    // apply a worklist echoed back with every verdict still null → VERIFY.json
    // exists but adjudicated === 0 (an empty/0-row file now fails closed instead)
    const todo = JSON.parse(readFileSync(join(dir, "VERIFY.todo.json"), "utf8"));
    const unadjudicated = join(dir, "verdicts.null.json");
    writeFileSync(unadjudicated, JSON.stringify({ pairs: todo.pairs }));
    applyVerdicts(dir, unadjudicated);
    const r = runCheck(dir, { semantic: true, requireVerify: true });
    expect(r.ok).toBe(false);
    expect(r.errors.join(" ")).toMatch(/0 adjudicated/);
    rmSync(dir, { recursive: true, force: true });
  });

  it("GREEN: passes when every claim is adjudicated and supported", () => {
    const dir = scratch();
    writeFixtureDossier(dir, 2);
    report(dir, GROUNDED);
    runVerify(dir);
    applyVerdicts(dir, writeVerdicts(dir, { S1: "supported", S2: "supported" }));
    const r = runCheck(dir, { semantic: true, requireVerify: true });
    expect(r.ok).toBe(true);
    rmSync(dir, { recursive: true, force: true });
  });

  it("plain check (no --semantic) never requires VERIFY.json", () => {
    const dir = scratch();
    writeFixtureDossier(dir, 2);
    report(dir, GROUNDED);
    expect(runCheck(dir).ok).toBe(true);
    rmSync(dir, { recursive: true, force: true });
  });
});

// A helper to fabricate a verdict with only the fields under test set.
function vd(over: Partial<Verdict>): Verdict {
  return { claimId: "C1", file: "REPORT.md", sourceId: "S1", claim: "", extractPath: "", extractDigest: "", verdict: "supported", note: "", ...over };
}

describe("reduceVerdicts — gate folding", () => {
  it("fails a claim whose every adjudicated source is unsupported (picks the unsupported representative)", () => {
    const r = reduceVerdicts([vd({ claimId: "C1", sourceId: "S1", verdict: "unsupported", note: "off-topic" })]);
    expect(r.ok).toBe(false);
    expect(r.failures[0]).toMatchObject({ claimId: "C1", verdict: "unsupported", note: "off-topic" });
  });

  it("passes when at least one source supports the claim, even if another is unsupported", () => {
    const r = reduceVerdicts([vd({ claimId: "C1", sourceId: "S1", verdict: "supported" }), vd({ claimId: "C1", sourceId: "S2", verdict: "unsupported" })]);
    expect(r.ok).toBe(true);
  });

  it("reports a partially-adjudicated claim as unadjudicated (a warning, not a failure)", () => {
    const r = reduceVerdicts([vd({ claimId: "C1", sourceId: "S1", verdict: "supported" }), vd({ claimId: "C1", sourceId: "S2", verdict: undefined as any })]);
    expect(r.ok).toBe(true);
    expect(r.unadjudicated).toContain("C1");
  });
});

// Drive main() in-process, capturing stdout/stderr and the process.exit code
// (cli-main.test.ts pattern) — for the fold-integration tests below.
async function cli(argv: string[]): Promise<{ out: string; err: string; exit?: number }> {
  const out: string[] = [];
  const err: string[] = [];
  const o = vi.spyOn(process.stdout, "write").mockImplementation(((c: unknown) => {
    out.push(String(c));
    return true;
  }) as never);
  const e = vi.spyOn(process.stderr, "write").mockImplementation(((c: unknown) => {
    err.push(String(c));
    return true;
  }) as never);
  const x = vi.spyOn(process, "exit").mockImplementation(((code?: number) => {
    throw new Error(`exit:${code ?? 0}`);
  }) as never);
  let exit: number | undefined;
  try {
    await main(argv);
  } catch (er) {
    const m = /^exit:(\d+)$/.exec((er as Error).message);
    if (!m) {
      o.mockRestore();
      e.mockRestore();
      x.mockRestore();
      throw er;
    }
    exit = Number(m[1]);
  }
  o.mockRestore();
  e.mockRestore();
  x.mockRestore();
  return { out: out.join(""), err: err.join(""), exit };
}

describe("applyVerdicts — orchestrate fragment shape + fail-closed fold (US-1)", () => {
  function setup(): string {
    const dir = scratch();
    writeFixtureDossier(dir, 2);
    report(dir, GROUNDED);
    runVerify(dir);
    return dir;
  }

  // The skeptic fragments the emitted workflow's VERIFY_SCHEMA returns.
  function writeFragment(dir: string, name: string, map: Record<string, string>): string {
    const todo = JSON.parse(readFileSync(join(dir, "VERIFY.todo.json"), "utf8"));
    const verdicts = todo.pairs.map((p: any) => ({
      claimId: p.claimId,
      sourceId: p.sourceId,
      verdict: map[p.sourceId] ?? "supported",
      note: "grounded note",
    }));
    const f = join(dir, name);
    writeFileSync(f, JSON.stringify({ verdicts }));
    return f;
  }

  it("accepts a { verdicts: [...] } fragment (the shape the emitted skeptic schema returns)", () => {
    const dir = setup();
    const r = applyVerdicts(dir, writeFragment(dir, "verdicts.0.json", { S1: "supported", S2: "partial" }));
    expect(r.pairs).toBe(2);
    expect(r.adjudicated).toBe(2);
    expect(r.supported).toBe(1);
    expect(r.partial).toBe(1);
    expect(r.ok).toBe(true);
    rmSync(dir, { recursive: true, force: true });
  });

  it("fold integration: a schema-shaped fragment saved as verdicts.0.json folds through the REAL `verify --apply <dir>`", async () => {
    const dir = setup();
    writeFragment(dir, "verdicts.0.json", { S1: "supported", S2: "supported" });
    const ok = await cli(["verify", "--apply", dir, "--run", dir]);
    expect(ok.exit).toBeUndefined();
    expect(ok.out).toContain("2/2 pair(s) adjudicated");
    expect(ok.out).not.toContain("0/0");
    // ...and a refuting fragment has a NON-ZERO effect: the gate fails (exit ≠ 0).
    writeFragment(dir, "verdicts.0.json", { S1: "refuted", S2: "supported" });
    const bad = await cli(["verify", "--apply", dir, "--run", dir]);
    expect(bad.exit).toBe(1);
    expect(bad.out).toContain("refuted");
    rmSync(dir, { recursive: true, force: true });
  });

  it("fails closed when a file parses to 0 verdict rows (empty pairs / unrecognized shape)", () => {
    const dir = setup();
    const empty = join(dir, "verdicts.empty.json");
    writeFileSync(empty, JSON.stringify({ pairs: [] }));
    expect(() => applyVerdicts(dir, empty)).toThrow(/no verdict rows/i);
    const alien = join(dir, "verdicts.alien.json");
    writeFileSync(alien, JSON.stringify({ adjudications: [{ claimId: "C1", sourceId: "S1", verdict: "supported" }] }));
    expect(() => applyVerdicts(dir, alien)).toThrow(/no verdict rows/i);
    // the fold must not have written a VERIFY.json on the failed applies
    expect(existsSync(join(dir, "VERIFY.json"))).toBe(false);
    rmSync(dir, { recursive: true, force: true });
  });

  it("fails closed on a 0-row file even when OTHER files in the batch have rows", () => {
    const dir = setup();
    const good = writeFragment(dir, "verdicts.0.json", {});
    const empty = join(dir, "verdicts.1.json");
    writeFileSync(empty, JSON.stringify({ verdicts: [] }));
    expect(() => applyVerdicts(dir, [good, empty])).toThrow(/no verdict rows/i);
    rmSync(dir, { recursive: true, force: true });
  });

  it("the REAL CLI exits non-zero on a 0-row verdicts file (no silent 0/0 ✓ pass)", async () => {
    const dir = setup();
    writeFileSync(join(dir, "verdicts.0.json"), JSON.stringify({ pairs: [] }));
    await expect(cli(["verify", "--apply", dir, "--run", dir])).rejects.toThrow(/no verdict rows/i);
    rmSync(dir, { recursive: true, force: true });
  });
});

describe("applyVerdicts / parseVerdictFile — robustness", () => {
  it("accepts a bare Verdict[] array (not wrapped in {pairs})", () => {
    const dir = scratch();
    writeFixtureDossier(dir, 1);
    const f = join(dir, "bare.json");
    writeFileSync(f, JSON.stringify([{ claimId: "C1", sourceId: "S1", verdict: "supported" }]));
    const r = applyVerdicts(dir, f);
    expect(r.pairs).toBe(1);
    expect(r.supported).toBe(1);
    rmSync(dir, { recursive: true, force: true });
  });

  it("skips entries missing claimId/sourceId and coerces an invalid verdict to unadjudicated", () => {
    const dir = scratch();
    writeFixtureDossier(dir, 1);
    const f = join(dir, "mixed.json");
    writeFileSync(
      f,
      JSON.stringify({
        pairs: [
          { sourceId: "S1", verdict: "supported" }, // no claimId → skipped
          { claimId: "C2", sourceId: "S1", verdict: "banana" }, // invalid verdict → undefined
        ],
      }),
    );
    const r = applyVerdicts(dir, f);
    expect(r.pairs).toBe(1); // only the second survived parsing
    expect(r.adjudicated).toBe(0); // its verdict was coerced away
    rmSync(dir, { recursive: true, force: true });
  });
});

describe("runVerify — dangling citation", () => {
  it("ignores a claim that cites a source id which does not exist", () => {
    const dir = scratch();
    writeFixtureDossier(dir, 2);
    report(dir, "# R\nA claim citing a real source [S1] and a dangling one [S99].");
    const wl = runVerify(dir);
    // S99 is filtered by byId.has → only the real S1 pair is emitted.
    expect(wl.pairs.some((p) => p.sourceId === "S99")).toBe(false);
    expect(wl.pairs.some((p) => p.sourceId === "S1")).toBe(true);
    rmSync(dir, { recursive: true, force: true });
  });
});
