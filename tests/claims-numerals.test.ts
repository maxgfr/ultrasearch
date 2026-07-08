import { describe, expect, it } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { extractNumerals, normalizeNumeralText } from "../src/claims.js";
import { runCheck } from "../src/check.js";
import { runVerify } from "../src/verify.js";
import { writeFixtureDossier } from "./dossierfix.js";

function scratch(): string {
  return mkdtempSync(join(tmpdir(), "us-numerals-"));
}
function report(dir: string, body: string) {
  writeFileSync(join(dir, "REPORT.md"), body);
}
function extract(dir: string, id: string, text: string) {
  writeFileSync(join(dir, "sources", `${id}.md`), text);
}

describe("extractNumerals", () => {
  it("extracts thousand-separated figures in normalized form", () => {
    expect(extractNumerals("AWS defaults to 10,000 rps with a 5,000-request burst")).toEqual(["10000", "5000"]);
  });

  it("keeps decimals and percentages (numeric part)", () => {
    expect(extractNumerals("availability of 99.9% across regions")).toEqual(["99.9"]);
  });

  it("keeps years", () => {
    expect(extractNumerals("the canonical post dates from 2017 and was never updated")).toEqual(["2017"]);
  });

  it("drops single digits (even with %) — too weak a signal", () => {
    expect(extractNumerals("a single 5 or a 5% share of it")).toEqual([]);
  });

  it("ignores digits inside [S#] citations, inline code, and link URLs", () => {
    expect(extractNumerals("as documented [S12] in `limit=10000` per [docs](https://x.test/2024/10)")).toEqual([]);
  });

  it("reads a version prefix out of dotted versions", () => {
    expect(extractNumerals("since version 1.7.1 of the engine")).toContain("1.7");
  });

  it("dedupes and caps at 8", () => {
    const text = "11 22 33 44 55 66 77 88 99 1010 plus 11 again";
    expect(extractNumerals(text).length).toBe(8);
  });
});

describe("normalizeNumeralText", () => {
  it("strips comma, space, and apostrophe group separators between digits", () => {
    expect(normalizeNumeralText("10,000 and 10 000 and 1'000")).toContain("10000");
    expect(normalizeNumeralText("1'000 events")).toContain("1000");
  });

  it("leaves plain words untouched", () => {
    expect(normalizeNumeralText("don't stop")).toBe("don't stop");
  });
});

describe("check — numerals-absent-from-source heuristic", () => {
  it("no warning when the claim's numeral appears in the cited extract", () => {
    const dir = scratch();
    writeFixtureDossier(dir, 1);
    extract(dir, "S1", "# S1\nThe default limit is 10,000 requests per second steady-state.\n");
    report(dir, "# X\nThe account default is 10,000 requests per second steady-state [S1].");
    const r = runCheck(dir);
    expect(r.ok).toBe(true);
    expect(r.numeralIssues ?? []).toEqual([]);
    rmSync(dir, { recursive: true, force: true });
  });

  it("warns (advisory) when a cited claim's numeral is absent from every cited extract", () => {
    const dir = scratch();
    writeFixtureDossier(dir, 1);
    report(dir, "# X\nThe account default is 10,000 requests per second steady-state [S1].");
    const r = runCheck(dir);
    expect(r.ok).toBe(true); // advisory by default
    expect(r.numeralIssues?.length).toBe(1);
    expect(r.numeralIssues?.[0]?.numeral).toBe("10000");
    expect(r.warnings.join(" ")).toMatch(/numeral/i);
    rmSync(dir, { recursive: true, force: true });
  });

  it("fails the gate under strictNumerals", () => {
    const dir = scratch();
    writeFixtureDossier(dir, 1);
    report(dir, "# X\nThe account default is 10,000 requests per second steady-state [S1].");
    const r = runCheck(dir, { strictNumerals: true });
    expect(r.ok).toBe(false);
    expect(r.errors.join(" ")).toMatch(/numeral/i);
    rmSync(dir, { recursive: true, force: true });
  });

  it("no issue when ANY cited source of the claim carries the numeral", () => {
    const dir = scratch();
    writeFixtureDossier(dir, 2);
    extract(dir, "S2", "# S2\nBurst capacity is 5,000 requests by default.\n");
    report(dir, "# X\nThe burst bucket is 5,000 requests across the account [S1][S2].");
    const r = runCheck(dir);
    expect(r.numeralIssues ?? []).toEqual([]);
    rmSync(dir, { recursive: true, force: true });
  });

  it("thousand-separator variants match across claim and source", () => {
    const dir = scratch();
    writeFixtureDossier(dir, 1);
    extract(dir, "S1", "# S1\nThe quota is 10 000 requests per second.\n");
    report(dir, "# X\nThe quota defaults to 10,000 requests per second here [S1].");
    const r = runCheck(dir);
    expect(r.numeralIssues ?? []).toEqual([]);
    rmSync(dir, { recursive: true, force: true });
  });

  it("skips numerals when the cited extract file is missing (unknown, not absent)", () => {
    const dir = scratch();
    writeFixtureDossier(dir, 1);
    rmSync(join(dir, "sources", "S1.md"));
    report(dir, "# X\nThe account default is 10,000 requests per second steady-state [S1].");
    const r = runCheck(dir);
    expect(r.numeralIssues ?? []).toEqual([]);
    rmSync(dir, { recursive: true, force: true });
  });

  it("uncited units and appendix lines carry no numeral issues", () => {
    const dir = scratch();
    writeFixtureDossier(dir, 1);
    extract(dir, "S1", "# S1\nA plain extract about rate limiting without figures.\n");
    report(dir, "# X\nA grounded claim about buckets and steady windows here [S1].\n\n## Sources\n- [S1] Source one from 2017 with 10,000 mentions");
    const r = runCheck(dir);
    expect(r.numeralIssues ?? []).toEqual([]);
    rmSync(dir, { recursive: true, force: true });
  });
});

describe("verify — numeralsAbsent on claim↔source pairs", () => {
  it("flags the pair whose source extract lacks the claim's numeral", () => {
    const dir = scratch();
    writeFixtureDossier(dir, 2);
    extract(dir, "S2", "# S2\nBurst capacity is 5,000 requests by default.\n");
    report(dir, "# X\nThe burst bucket is 5,000 requests across the account [S1][S2].");
    const wl = runVerify(dir);
    const s1 = wl.pairs.find((p) => p.sourceId === "S1");
    const s2 = wl.pairs.find((p) => p.sourceId === "S2");
    expect(s1?.numeralsAbsent).toEqual(["5000"]);
    expect(s2?.numeralsAbsent).toBeUndefined();
    const md = readFileSync(join(dir, "VERIFY.md"), "utf8");
    expect(md).toMatch(/not found in this source/i);
    rmSync(dir, { recursive: true, force: true });
  });

  it("flows into VERIFY.todo.json", () => {
    const dir = scratch();
    writeFixtureDossier(dir, 1);
    report(dir, "# X\nThe account default is 10,000 requests per second steady-state [S1].");
    runVerify(dir);
    const todo = JSON.parse(readFileSync(join(dir, "VERIFY.todo.json"), "utf8"));
    expect(todo.pairs[0].numeralsAbsent).toEqual(["10000"]);
    rmSync(dir, { recursive: true, force: true });
  });
});
