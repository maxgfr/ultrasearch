import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { buildWorklist, runVerify, applyVerdicts } from "../src/verify.js";
import { readSourceText, writeSourceExtract } from "../src/dossier.js";
import { runCheck } from "../src/check.js";
import { autoRelink, relink } from "../src/relink.js";
import { writeFixtureDossier } from "./dossierfix.js";

const scratch: string[] = [];
const fixture = () => {
  const dir = mkdtempSync(join(tmpdir(), "us-counter-review-"));
  scratch.push(dir);
  const sources = writeFixtureDossier(dir, 1);
  writeFileSync(join(dir, "REPORT.md"), "Rate limiting restricts requests to protect the server. [S1]");
  writeFileSync(join(dir, sources[0]!.extract), "Rate limiting restricts requests to protect the server.");
  return { dir, source: sources[0]! };
};
afterEach(() => {
  for (const dir of scratch.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("counter-review: generation overlap", () => {
  it.each([true, false])("binds a fresh compact verdict despite an older overlapping worklist (old unsharded: %s)", (oldUnsharded) => {
    const { dir } = fixture();
    const old = runVerify(dir, oldUnsharded ? {} : { shards: 2, shard: 0 });
    writeFileSync(join(dir, "REPORT.md"), "Rate limiting protects the server by restricting requests. [S1]");
    const current = runVerify(dir, oldUnsharded ? { shards: 2, shard: 0 } : {});
    const file = join(dir, "current-verdicts.json");
    writeFileSync(file, JSON.stringify(current.pairs.map(({ claimId, sourceId }) => ({ claimId, sourceId, verdict: "supported" }))));
    expect(applyVerdicts(dir, file).ok).toBe(true);
    expect(runCheck(dir, { semantic: true, requireVerify: true }).ok).toBe(true);
    // A self-contained verdict about the old text remains stale even though a
    // new worklist exists. Never replace the fingerprint it actually carries.
    writeFileSync(file, JSON.stringify(old.pairs.map((p) => ({ ...p, verdict: "supported" }))));
    expect(() => applyVerdicts(dir, file)).toThrow(/changed since/);
  });
});

describe("counter-review: source annotations are not numeric evidence", () => {
  it.each(["summary", "standard"] as const)("does not use a %s passage's source-length label to ground a claim", (depth) => {
    const { dir, source } = fixture();
    const text = "Administrative background. ".repeat(330).padEnd(8750, " ") + "The ceiling is described qualitatively.";
    const full = text.padEnd(9000, " ");
    writeSourceExtract(dir, source, full, depth, "ceiling");
    expect(readFileSync(join(dir, source.extract), "utf8")).toContain("of 9000]");
    writeFileSync(join(dir, "REPORT.md"), "The service imposes a ceiling of 9000 requests over 16 seconds. [S1]");
    expect(buildWorklist(dir).worklist.pairs[0]!.numeralsAbsent).toEqual(expect.arrayContaining(["9000", "16"]));
    expect(runCheck(dir, { strictNumerals: true }).numeralIssues?.some((i) => i.numeral === "9000")).toBe(true);
    expect(runCheck(dir, { strictNumerals: true }).ok).toBe(false);
    writeSourceExtract(dir, source, "The service imposes a ceiling of 9000 requests over 16 seconds.", depth, "ceiling");
    expect(buildWorklist(dir).worklist.pairs[0]!.numeralsAbsent).toBeUndefined();
    expect(runCheck(dir, { strictNumerals: true }).ok).toBe(true);
  });
});

describe("counter-review: relink preserves already selected source evidence", () => {
  it.each(["summary", "standard"] as const)("keeps late-answer passages and offsets through manual and automatic relink at %s depth", (depth) => {
    const dir = mkdtempSync(join(tmpdir(), "us-relink-passages-"));
    scratch.push(dir);
    const question = "What does HTTP 429 mean and how does Retry-After work?";
    const [source] = writeFixtureDossier(dir, 1, { depth, question });
    source!.url = "https://eutils.ncbi.nlm.nih.gov/entrez/eutils/efetch.fcgi?db=pubmed&id=34397876";
    source!.canonicalUrl = source!.url;
    writeFileSync(join(dir, "sources.json"), JSON.stringify([source]));
    const answer = "HTTP 429 means Too Many Requests. Retry-After indicates how long to wait. doi: 10.1000/ceiling";
    const original = "Unrelated administrative background.\n".repeat(700) + answer;
    writeSourceExtract(dir, source!, original, depth, question);
    writeFileSync(join(dir, "REPORT.md"), "HTTP 429 means Too Many Requests. [S1]");
    const before = readSourceText(dir, source!);
    const fingerprint = buildWorklist(dir).worklist.pairs[0]!.fingerprint;
    expect(before).toContain(answer);
    expect(before).toContain("[Source passage:");
    expect(autoRelink(dir).repaired).toHaveLength(1);
    expect(readSourceText(dir, source!)).toBe(before);
    expect(relink(dir, "S1", "https://example.org/relinked-source").relinked).toBe(true);
    expect(readSourceText(dir, source!)).toBe(before);
    expect(buildWorklist(dir).worklist.pairs[0]!.fingerprint).toBe(fingerprint);
  });
});
