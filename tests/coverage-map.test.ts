import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { runGather, termCoverage, underCovered, ignoredByExplicitBackends } from "../src/gather.js";
import { runCheck } from "../src/check.js";
import { UNDER_COVERED_MIN } from "../src/types.js";
import type { GatherOptions, Manifest, RawSource } from "../src/types.js";

afterEach(() => vi.unstubAllGlobals());

function scratch(): string {
  return mkdtempSync(join(tmpdir(), "us-cov-"));
}
function opts(over: Partial<GatherOptions>): GatherOptions {
  return {
    question: "what is rate limiting",
    mode: "topic",
    depth: "standard",
    maxSources: 25,
    perSource: 6,
    lang: "en",
    webEngine: "auto",
    excludeDomains: [],
    json: false,
    ...over,
  };
}
function src(url: string, text: string): RawSource {
  return { url, title: url, snippet: "", text, backend: "fixture", score: 1 } as RawSource;
}

describe("termCoverage / underCovered", () => {
  it("counts, per term, how many of the top sources mention it", () => {
    const items = [src("https://a.test", "token bucket"), src("https://b.test", "token only"), src("https://c.test", "unrelated prose")];
    const cov = termCoverage(items, ["token", "bucket"]);
    expect(cov).toEqual([
      { term: "token", sources: 2 },
      { term: "bucket", sources: 1 },
    ]);
  });

  it("preserves queryTerms order so the report reads like the question", () => {
    const cov = termCoverage([src("https://a.test", "beta")], ["zulu", "alpha", "beta"]);
    expect(cov.map((c) => c.term)).toEqual(["zulu", "alpha", "beta"]);
  });

  it("only looks at the top N sources — an 11th mention does not rescue a term", () => {
    const items = [...Array(10)].map((_, i) => src(`https://x${i}.test`, "filler")).concat(src("https://late.test", "quota"));
    expect(termCoverage(items, ["quota"], 10)).toEqual([{ term: "quota", sources: 0 }]);
    expect(termCoverage(items, ["quota"], 11)).toEqual([{ term: "quota", sources: 1 }]);
  });

  it("flags exactly the terms under the floor", () => {
    const under = underCovered([
      { term: "covered", sources: UNDER_COVERED_MIN },
      { term: "weak", sources: UNDER_COVERED_MIN - 1 },
    ]);
    expect(under).toEqual(["weak"]);
  });

  it("is deterministic — same inputs, same map", () => {
    const items = [src("https://a.test", "token bucket quota")];
    expect(termCoverage(items, ["token", "quota"])).toEqual(termCoverage(items, ["token", "quota"]));
  });
});

describe("ignoredByExplicitBackends", () => {
  it("returns nothing when --backends was not passed", () => {
    expect(ignoredByExplicitBackends(opts({ seedDomains: ["a.test"], rounds: 2, webEngine: "mojeek" }))).toEqual([]);
  });

  it("names each flag --backends silently voids", () => {
    expect(ignoredByExplicitBackends(opts({ backends: ["fixture"], seedDomains: ["a.test"] }))).toEqual(["--seed-domains"]);
    expect(ignoredByExplicitBackends(opts({ backends: ["fixture"], rounds: 2 }))).toEqual(["--rounds"]);
    expect(ignoredByExplicitBackends(opts({ backends: ["fixture"], webEngine: "mojeek" }))).toEqual(["--web-engine"]);
  });

  it("names all three at once, and stays quiet when none were passed", () => {
    expect(ignoredByExplicitBackends(opts({ backends: ["fixture"], seedDomains: ["a.test"], rounds: 2, webEngine: "ddg" }))).toEqual([
      "--seed-domains",
      "--rounds",
      "--web-engine",
    ]);
    expect(ignoredByExplicitBackends(opts({ backends: ["fixture"] }))).toEqual([]);
  });
});

describe("the coverage map reaches the agent", () => {
  it("records coverage on the manifest and warns about under-covered terms", async () => {
    const dir = scratch();
    // The fixture dossier is about rate limiting; "kubernetes" appears nowhere.
    const r = await runGather(opts({ question: "rate limiting on kubernetes", backends: ["fixture"], out: dir }));
    const manifest = JSON.parse(readFileSync(join(dir, "manifest.json"), "utf8")) as Manifest;

    expect(manifest.coverage).toBeDefined();
    // Terms are BM25-stemmed ("kubernetes" → "kubernete"), so match the stem.
    expect(manifest.coverage!.under.join(" ")).toMatch(/kubernete/);
    expect(manifest.notes.join(" ")).toMatch(/Under-covered term\(s\).*kubernete/);
    expect(readFileSync(join(dir, "DOSSIER.md"), "utf8")).toMatch(/Under-covered/);
    expect(r.manifest.coverage!.terms.some((t) => /^kubernete/.test(t.term) && t.sources === 0)).toBe(true);
    rmSync(dir, { recursive: true, force: true });
  });

  it("surfaces the same gap as a check warning", async () => {
    const dir = scratch();
    await runGather(opts({ question: "rate limiting on kubernetes", backends: ["fixture"], out: dir }));
    const { writeFileSync } = await import("node:fs");
    writeFileSync(join(dir, "REPORT.md"), "# R\n## A\nRate limiting caps request rates [S1].\n");
    const res = runCheck(dir, {});
    expect(res.warnings.join(" ")).toMatch(/Under-covered question term\(s\).*kubernete/);
    rmSync(dir, { recursive: true, force: true });
  });

  it("says so on the manifest when --backends pinned retrieval", async () => {
    const dir = scratch();
    await runGather(opts({ backends: ["fixture"], seedDomains: ["docs.example.com"], rounds: 2, out: dir }));
    const manifest = JSON.parse(readFileSync(join(dir, "manifest.json"), "utf8")) as Manifest;
    const notes = manifest.notes.join(" ");
    expect(notes).toMatch(/--backends pinned retrieval/);
    expect(notes).toMatch(/--seed-domains \/ --rounds were ignored/);
    rmSync(dir, { recursive: true, force: true });
  });

  it("records cache state on every run", async () => {
    const dir = scratch();
    const r = await runGather(opts({ backends: ["fixture"], out: dir }));
    expect(r.manifest.cache).toEqual({ enabled: false, hits: 0 });
    rmSync(dir, { recursive: true, force: true });
  });
});
