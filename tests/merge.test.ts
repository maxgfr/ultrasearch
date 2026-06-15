import { describe, expect, it } from "vitest";
import { mkdtempSync, rmSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { writeDossier } from "../src/dossier.js";
import { runMerge } from "../src/merge.js";
import { runCheck } from "../src/check.js";
import type { Manifest, RawSource } from "../src/types.js";

function scratch(): string {
  return mkdtempSync(join(tmpdir(), "us-merge-"));
}

// A real sub-dossier (proper 3-line extract headers) for one sub-question.
function subDossier(dir: string, question: string, raws: RawSource[]): void {
  const manifest: Manifest = {
    version: "1.2.0",
    question,
    mode: "topic",
    depth: "deep",
    lang: "en",
    backends: ["duckduckgo"],
    backendsUsed: ["duckduckgo"],
    sourceCount: raws.length,
    maxSources: 60,
    builtAt: "2026-06-14T10:00:00.000Z",
    slug: "sub",
    tiers: ["SUMMARY.md", "REPORT.md", "FULL.md"],
    extras: [],
    notes: [],
    timings: {},
  };
  writeDossier(dir, raws, manifest, "## TL;DR\n## Sources");
}

// > 500 chars so SimHash near-duplicate detection engages.
function longText(seed: string): string {
  return (seed + " ").repeat(120);
}

describe("runMerge", () => {
  it("produces stable S# ids: merging the same inputs twice is byte-identical", () => {
    const root = scratch();
    const d1 = join(root, "r1");
    const d2 = join(root, "r2");
    subDossier(d1, "facet one", [
      { url: "https://a.test/x", title: "X", backend: "duckduckgo", score: 1, snippet: "x", text: longText("alpha unique one") },
      { url: "https://b.test/y", title: "Y", backend: "duckduckgo", score: 0.5, snippet: "y", text: longText("beta unique two") },
    ]);
    subDossier(d2, "facet two", [
      { url: "https://c.test/z", title: "Z", backend: "wikipedia", score: 1, snippet: "z", text: longText("gamma unique three") },
    ]);
    const m1 = join(root, "m1");
    const m2 = join(root, "m2");
    runMerge({ runs: [d1, d2], master: m1, question: "Q" });
    runMerge({ runs: [d1, d2], master: m2, question: "Q" });
    expect(readFileSync(join(m1, "sources.json"), "utf8")).toBe(readFileSync(join(m2, "sources.json"), "utf8"));
    rmSync(root, { recursive: true, force: true });
  });

  it("collapses a URL surfaced by two sub-questions and records both in provenance", () => {
    const root = scratch();
    const d1 = join(root, "r1");
    const d2 = join(root, "r2");
    const shared: RawSource = { url: "https://shared.test/page", title: "Shared", backend: "duckduckgo", score: 1, snippet: "s", text: longText("shared content here") };
    subDossier(d1, "first sub-question", [shared, { url: "https://a.test/1", title: "A", backend: "duckduckgo", score: 0.5, snippet: "a", text: longText("alpha distinct apple orchard meadow") }]);
    subDossier(d2, "second sub-question", [shared, { url: "https://b.test/2", title: "B", backend: "duckduckgo", score: 0.5, snippet: "b", text: longText("beta separate zebra mountain river") }]);
    const m = join(root, "m");
    runMerge({ runs: [d1, d2], master: m, question: "Q" });
    const sources = JSON.parse(readFileSync(join(m, "sources.json"), "utf8"));
    expect(sources.length).toBe(3); // shared collapses 4 → 3
    const sharedSrc = sources.find((s: any) => s.url === "https://shared.test/page");
    expect(sharedSrc.meta.provenance.map((p: any) => p.subQuestion).sort()).toEqual([
      "first sub-question",
      "second sub-question",
    ]);
    rmSync(root, { recursive: true, force: true });
  });

  it("collapses two URLs that share a DOI via identityKey", () => {
    const root = scratch();
    const d1 = join(root, "r1");
    const d2 = join(root, "r2");
    subDossier(d1, "q1", [{ url: "https://arxiv.org/abs/1234.5678", title: "Paper", backend: "arxiv", score: 1, snippet: "p", text: longText("paper text alpha"), meta: { doi: "10.1000/xyz" } }]);
    subDossier(d2, "q2", [{ url: "https://doi.org/10.1000/xyz", title: "Landing", backend: "crossref", score: 1, snippet: "p", text: longText("paper text beta"), meta: { doi: "10.1000/xyz" } }]);
    const m = join(root, "m");
    runMerge({ runs: [d1, d2], master: m, question: "Q" });
    const sources = JSON.parse(readFileSync(join(m, "sources.json"), "utf8"));
    expect(sources.length).toBe(1);
    rmSync(root, { recursive: true, force: true });
  });

  it("collapses near-duplicate (syndicated) content across different URLs", () => {
    const root = scratch();
    const d1 = join(root, "r1");
    const d2 = join(root, "r2");
    const body = longText("the leaky bucket algorithm smooths bursty traffic into a steady rate");
    subDossier(d1, "q1", [{ url: "https://site1.test/article", title: "Orig", backend: "duckduckgo", score: 1, snippet: "o", text: body }]);
    subDossier(d2, "q2", [{ url: "https://site2.test/mirror", title: "Mirror", backend: "duckduckgo", score: 1, snippet: "m", text: body }]);
    const m = join(root, "m");
    runMerge({ runs: [d1, d2], master: m, question: "Q" });
    const sources = JSON.parse(readFileSync(join(m, "sources.json"), "utf8"));
    expect(sources.length).toBe(1);
    rmSync(root, { recursive: true, force: true });
  });

  it("round-trips extract text through the master dossier", () => {
    const root = scratch();
    const d1 = join(root, "r1");
    subDossier(d1, "q1", [{ url: "https://rt.test/p", title: "RT", backend: "duckduckgo", score: 1, snippet: "rt", text: longText("round trip body content alpha") }]);
    const m = join(root, "m");
    runMerge({ runs: [d1], master: m, question: "Q" });
    const masterExtract = readFileSync(join(m, "sources", "S1.md"), "utf8");
    expect(masterExtract).toContain("round trip body content alpha");
    rmSync(root, { recursive: true, force: true });
  });

  it("yields a master dossier a grounded report passes check against", () => {
    const root = scratch();
    const d1 = join(root, "r1");
    subDossier(d1, "q1", [
      { url: "https://x.test/1", title: "One", backend: "duckduckgo", score: 1, snippet: "one", text: longText("one body content") },
      { url: "https://x.test/2", title: "Two", backend: "duckduckgo", score: 0.5, snippet: "two", text: longText("two body content") },
    ]);
    const m = join(root, "m");
    const r = runMerge({ runs: [d1], master: m, question: "Q" });
    expect(r.sources.length).toBe(2);
    writeFileSync(
      join(m, "REPORT.md"),
      "# R\n## TL;DR\nA substantive grounded claim about the first matter here [S1].\n## More\nAnother substantive grounded claim about the second matter here [S2].",
    );
    expect(runCheck(m).ok).toBe(true);
    rmSync(root, { recursive: true, force: true });
  });

  it("carries mergedFrom + subQuestions in the master manifest", () => {
    const root = scratch();
    const d1 = join(root, "r1");
    const d2 = join(root, "r2");
    subDossier(d1, "alpha facet", [{ url: "https://a.test/1", title: "A", backend: "duckduckgo", score: 1, snippet: "a", text: longText("a content") }]);
    subDossier(d2, "beta facet", [{ url: "https://b.test/1", title: "B", backend: "duckduckgo", score: 1, snippet: "b", text: longText("b content") }]);
    const m = join(root, "m");
    runMerge({ runs: [d1, d2], master: m, question: "Q" });
    const manifest = JSON.parse(readFileSync(join(m, "manifest.json"), "utf8"));
    expect(manifest.mergedFrom).toEqual([d1, d2]);
    expect(manifest.subQuestions.map((s: any) => s.question)).toEqual(["alpha facet", "beta facet"]);
    rmSync(root, { recursive: true, force: true });
  });
});
