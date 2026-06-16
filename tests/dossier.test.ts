import { describe, expect, it } from "vitest";
import { existsSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { writeDossier, readDossier, buildSource, nextSourceId } from "../src/dossier.js";
import { getMode } from "../src/modes/registry.js";
import type { Manifest, RawSource, Source } from "../src/types.js";

function rawSources(): RawSource[] {
  return [
    { url: "https://en.wikipedia.org/wiki/Rate_limiting", title: "Rate limiting", backend: "wikipedia", score: 2, snippet: "controls request rate", text: "Rate limiting controls how many requests a client may make." },
    { url: "https://nist.gov/x", title: "Gov doc", backend: "duckduckgo", score: 1, snippet: "", text: "An authoritative government explanation of limits." },
  ];
}

function manifest(over: Partial<Manifest> = {}): Manifest {
  return {
    version: "0.1.0",
    question: "what is rate limiting",
    mode: "topic",
    depth: "standard",
    lang: "en",
    backends: ["wikipedia", "duckduckgo"],
    backendsUsed: ["wikipedia", "duckduckgo"],
    sourceCount: 2,
    maxSources: 25,
    builtAt: "2026-06-13T10:00:00.000Z",
    slug: "topic-what-is-rate-limiting",
    tiers: ["SUMMARY.md", "REPORT.md", "FULL.md"],
    extras: [],
    notes: ["a note"],
    timings: { total: 5 },
    ...over,
  };
}

describe("buildSource", () => {
  it("computes id, canonical url, domain, trust and extract path", () => {
    const s = buildSource(rawSources()[0]!, "S1", "2026-06-13T10:00:00.000Z", "rate limiting");
    expect(s.id).toBe("S1");
    expect(s.extract).toBe("sources/S1.md");
    expect(s.domain).toBe("en.wikipedia.org");
    expect(s.canonicalUrl).toContain("wikipedia.org");
    expect(s.trust).toBeGreaterThanOrEqual(0.85);
  });
});

describe("buildSource — source-quality flag", () => {
  it("leaves fullText absent (full text) when the RawSource doesn't mark a failed fetch", () => {
    const s = buildSource(rawSources()[0]!, "S1", "2026-06-13T10:00:00.000Z", "rate limiting");
    expect(s.fullText).toBeUndefined();
  });
  it("carries fullText:false through from a snippet-only RawSource", () => {
    const rs: RawSource = { ...rawSources()[0]!, fullText: false };
    const s = buildSource(rs, "S1", "2026-06-13T10:00:00.000Z", "rate limiting");
    expect(s.fullText).toBe(false);
  });
});

describe("renderDossierMarkdown — snippet-only marker", () => {
  const dir = join(tmpdir(), "us-dossier-snippet");
  it("marks a snippet-only source and leaves full-text sources unmarked", () => {
    rmSync(dir, { recursive: true, force: true });
    const raws: RawSource[] = [
      { url: "https://a.test/full", title: "Full", backend: "duckduckgo", score: 2, snippet: "s", text: "real full text here", fullText: true },
      { url: "https://b.test/thin", title: "Thin", backend: "duckduckgo", score: 1, snippet: "only a snippet", text: "only a snippet", fullText: false },
    ];
    writeDossier(dir, raws, manifest(), getMode("topic").template);
    const dossier = readFileSync(join(dir, "DOSSIER.md"), "utf8");
    expect(dossier).toMatch(/snippet only/i);
    // exactly one source marked (the thin one)
    expect(dossier.match(/snippet only/gi)!.length).toBe(1);
    rmSync(dir, { recursive: true, force: true });
  });
});

describe("nextSourceId", () => {
  it("returns S(max+1)", () => {
    const sources = [{ id: "S1" }, { id: "S3" }] as Source[];
    expect(nextSourceId(sources)).toBe("S4");
    expect(nextSourceId([])).toBe("S1");
  });
});

describe("writeDossier / readDossier", () => {
  const dir = join(tmpdir(), "us-dossier-test");
  it("writes manifest, sources.json, DOSSIER.md and per-source extracts", () => {
    rmSync(dir, { recursive: true, force: true });
    const { sources } = writeDossier(dir, rawSources(), manifest(), getMode("topic").template);
    expect(sources).toHaveLength(2);
    expect(existsSync(join(dir, "sources.json"))).toBe(true);
    expect(existsSync(join(dir, "manifest.json"))).toBe(true);
    expect(existsSync(join(dir, "DOSSIER.md"))).toBe(true);
    expect(existsSync(join(dir, "sources/S1.md"))).toBe(true);

    const s1 = readFileSync(join(dir, "sources/S1.md"), "utf8");
    expect(s1).toContain("# S1 — Rate limiting");
    expect(s1).toContain("client may make");

    const dossier = readFileSync(join(dir, "DOSSIER.md"), "utf8");
    expect(dossier).toContain("## Grounding rules");
    expect(dossier).toContain("[S1]");
    expect(dossier).toContain("## Report template (topic)");

    const back = readDossier(dir);
    expect(back.sources).toHaveLength(2);
    expect(back.manifest.question).toBe("what is rate limiting");
    rmSync(dir, { recursive: true, force: true });
  });
});
