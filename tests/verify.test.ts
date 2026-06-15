import { describe, expect, it } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { runVerify, applyVerdicts } from "../src/verify.js";
import { runCheck } from "../src/check.js";
import { writeFixtureDossier } from "./dossierfix.js";

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
    report(dir, "# X\n## A\nClaim one about the subject matter at hand here [S1].\n## B\nClaim two about the subject matter at hand here [S2].\n## C\nClaim three about the subject matter at hand here [S3].");
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

  it("warns (does not fail) when --semantic is set but no VERIFY.json exists", () => {
    const dir = scratch();
    writeFixtureDossier(dir, 2);
    report(dir, GROUNDED);
    const r = runCheck(dir, { semantic: true });
    expect(r.ok).toBe(true);
    expect(r.warnings.join(" ").toLowerCase()).toContain("verify");
    rmSync(dir, { recursive: true, force: true });
  });
});
