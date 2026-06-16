import { describe, expect, it } from "vitest";
import { writeFileSync, rmSync, mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { runCheck } from "../src/check.js";
import { writeFixtureDossier } from "./dossierfix.js";

function scratch(): string {
  return mkdtempSync(join(tmpdir(), "us-check-"));
}
function report(dir: string, body: string) {
  writeFileSync(join(dir, "REPORT.md"), body);
}

const GROUNDED = `# Rate limiting
## TL;DR
Rate limiting caps how many requests a client may make in a window [S1].
## How it works
A token bucket refills tokens at a steady rate and allows controlled bursts [S2].`;

describe("runCheck", () => {
  it("passes a fully grounded report", () => {
    const dir = scratch();
    writeFixtureDossier(dir, 2);
    report(dir, GROUNDED);
    const r = runCheck(dir);
    expect(r.ok).toBe(true);
    expect(r.dangling).toEqual([]);
    expect(r.unmarkedUnsourced).toEqual([]);
    expect(r.sourceCitations).toBe(2);
    rmSync(dir, { recursive: true, force: true });
  });

  it("fails on a dangling citation", () => {
    const dir = scratch();
    writeFixtureDossier(dir, 2);
    report(dir, `# X\nA claim that points nowhere real and is quite long indeed [S9].`);
    const r = runCheck(dir);
    expect(r.ok).toBe(false);
    expect(r.dangling).toContain("S9");
    rmSync(dir, { recursive: true, force: true });
  });

  it("fails on an unmarked unsourced claim", () => {
    const dir = scratch();
    writeFixtureDossier(dir, 2);
    report(dir, `# X\nThis is a substantive factual claim with no citation whatsoever here [S1].\n\nThis other substantive factual claim has absolutely no source attached to it.`);
    const r = runCheck(dir);
    expect(r.ok).toBe(false);
    expect(r.unmarkedUnsourced.length).toBeGreaterThan(0);
    rmSync(dir, { recursive: true, force: true });
  });

  it("tolerates a claim flagged with a trailing [M]", () => {
    const dir = scratch();
    writeFixtureDossier(dir, 2);
    report(dir, `# X\nA grounded claim about buckets and windows and tokens here [S1].\n\nMost gateways default to token buckets in my experience across many systems [M].`);
    const r = runCheck(dir);
    expect(r.ok).toBe(true);
    expect(r.modelHints).toBeGreaterThanOrEqual(1);
    rmSync(dir, { recursive: true, force: true });
  });

  it("tolerates a claim inside a > [model-hint] blockquote", () => {
    const dir = scratch();
    writeFixtureDossier(dir, 2);
    report(dir, `# X\nA grounded claim about buckets and windows and tokens here [S1].\n\n> [model-hint] Token buckets are common in production gateways, though no fetched source here confirms it.`);
    const r = runCheck(dir);
    expect(r.ok).toBe(true);
    expect(r.modelHints).toBeGreaterThanOrEqual(1);
    expect(r.unknownTokens).not.toContain("model-hint");
    rmSync(dir, { recursive: true, force: true });
  });

  it("ignores markdown links (not citations)", () => {
    const dir = scratch();
    writeFixtureDossier(dir, 2);
    report(dir, `# X\nA grounded factual claim about request windows and buckets here [S1].\n\nSee [docs](https://example.com).`);
    const r = runCheck(dir);
    expect(r.ok).toBe(true);
    expect(r.unknownTokens).toEqual([]);
    rmSync(dir, { recursive: true, force: true });
  });

  it("fails when there are no citations at all", () => {
    const dir = scratch();
    writeFixtureDossier(dir, 2);
    report(dir, `# X\nThis report makes a long substantive claim but never cites any source at all here.`);
    const r = runCheck(dir);
    expect(r.ok).toBe(false);
    expect(r.errors.join(" ")).toMatch(/no source citations/i);
    rmSync(dir, { recursive: true, force: true });
  });

  it("warns (does not fail) on an uncited source", () => {
    const dir = scratch();
    writeFixtureDossier(dir, 3);
    report(dir, GROUNDED); // cites S1, S2 only
    const r = runCheck(dir);
    expect(r.ok).toBe(true);
    expect(r.uncitedSources).toContain("S3");
    rmSync(dir, { recursive: true, force: true });
  });

  it("treats SUMMARY.md as warn-only for per-claim coverage", () => {
    const dir = scratch();
    writeFixtureDossier(dir, 2);
    report(dir, GROUNDED); // REPORT grounded
    writeFileSync(join(dir, "SUMMARY.md"), `# TL;DR\nAn unsourced but acceptable digest sentence that makes a claim without any citation.`);
    const r = runCheck(dir);
    expect(r.ok).toBe(true);
    rmSync(dir, { recursive: true, force: true });
  });

  // --- Grounding-gate hardening (audit C1–C5) ---

  it("C1: a [S#] hidden in an inline-code span does NOT count as a citation", () => {
    const dir = scratch();
    writeFixtureDossier(dir, 2);
    report(dir, "# X\nA fabricated substantive claim about token buckets and request windows here `[S1]`.");
    const r = runCheck(dir);
    expect(r.ok).toBe(false);
    rmSync(dir, { recursive: true, force: true });
  });

  it("C2: a fabricated claim inside a plain (non-hint) blockquote is coverage-checked", () => {
    const dir = scratch();
    writeFixtureDossier(dir, 2);
    report(dir, "# X\nA grounded claim about buckets and windows here [S1].\n\n> A fabricated substantive claim about rate limiting with absolutely no citation here.");
    const r = runCheck(dir);
    expect(r.ok).toBe(false);
    rmSync(dir, { recursive: true, force: true });
  });

  it("C3: a fabricated claim in a table cell is coverage-checked", () => {
    const dir = scratch();
    writeFixtureDossier(dir, 2);
    report(dir, "# X\nA grounded claim about buckets and windows here [S1].\n\n| Approach | Detail |\n|---|---|\n| Token bucket | refills at a steady rate and allows controlled request bursts |");
    const r = runCheck(dir);
    expect(r.ok).toBe(false);
    rmSync(dir, { recursive: true, force: true });
  });

  it("C4: a claim fragmented across short bullets is caught at the group level", () => {
    const dir = scratch();
    writeFixtureDossier(dir, 2);
    report(dir, "# X\nA grounded claim about buckets and windows here [S1].\n\n- token buckets\n- refill at\n- a steady rate\n- allowing controlled bursts");
    const r = runCheck(dir);
    expect(r.ok).toBe(false);
    rmSync(dir, { recursive: true, force: true });
  });

  it("C6: a citation hidden in an HTML comment does NOT ground a claim (injection guard)", () => {
    const dir = scratch();
    writeFixtureDossier(dir, 2);
    report(dir, "# X\nThe leaky bucket was banned by the IETF and is now illegal in the EU.\n<!-- [S1] -->\n");
    const r = runCheck(dir);
    expect(r.ok).toBe(false); // the visible claim is unsourced; the commented [S1] must not count
    rmSync(dir, { recursive: true, force: true });
  });

  it("C5: a cited bullet whose [S#] is on a continuation line is NOT a false fail", () => {
    const dir = scratch();
    writeFixtureDossier(dir, 2);
    report(dir, "# X\n- A grounded claim about token buckets and controlled request bursts\n  that the source documents in detail [S1].");
    const r = runCheck(dir);
    expect(r.ok).toBe(true);
    rmSync(dir, { recursive: true, force: true });
  });

  it("C2/C3 control: grounded blockquote and table row (with [S#]) pass", () => {
    const dir = scratch();
    writeFixtureDossier(dir, 2);
    report(dir, "# X\n> A grounded quoted claim about request windows and buckets here [S1].\n\n| Approach | Detail |\n|---|---|\n| Token bucket | refills at a steady rate and allows controlled bursts [S2] |");
    const r = runCheck(dir);
    expect(r.ok).toBe(true);
    rmSync(dir, { recursive: true, force: true });
  });

  it("warns (does not fail) when the manifest flags a thin dossier", () => {
    const dir = scratch();
    writeFixtureDossier(dir, 2, { recallFloor: { count: 2, floor: 6 } });
    report(dir, GROUNDED);
    const r = runCheck(dir);
    expect(r.ok).toBe(true);
    expect(r.warnings.join(" ").toLowerCase()).toContain("thin dossier");
    rmSync(dir, { recursive: true, force: true });
  });

  it("--min-sources fails a too-thin dossier and passes at/above the floor", () => {
    const dir = scratch();
    writeFixtureDossier(dir, 3);
    report(dir, GROUNDED);
    expect(runCheck(dir, { minSources: 5 }).ok).toBe(false);
    expect(runCheck(dir, { minSources: 3 }).ok).toBe(true);
    rmSync(dir, { recursive: true, force: true });
  });

  it("fails clearly when no report tier exists", () => {
    const dir = scratch();
    writeFixtureDossier(dir, 2);
    const r = runCheck(dir);
    expect(r.ok).toBe(false);
    expect(r.errors.join(" ")).toMatch(/No REPORT.md or FULL.md/i);
    rmSync(dir, { recursive: true, force: true });
  });
});
