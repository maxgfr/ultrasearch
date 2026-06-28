import { describe, expect, it } from "vitest";
import {
  slugify,
  runId,
  canonicalizeUrl,
  domainOf,
  dedupeByUrl,
  trustScore,
  keywords,
  rankedKeywords,
  buildMatcher,
  rrf,
  simhash,
  hammingDistance,
  dedupeNearDuplicates,
} from "../src/util.js";
import type { RawSource } from "../src/types.js";

function src(url: string, score: number): RawSource {
  return { url, title: url, backend: "duckduckgo", score, snippet: "" };
}

describe("slugify", () => {
  it("lowercases, hyphenates and trims", () => {
    expect(slugify("How does HTTP rate limiting work?")).toBe("how-does-http-rate-limiting-work");
  });
  it("strips protocol and never returns empty", () => {
    expect(slugify("https://example.com")).toBe("example.com");
    expect(slugify("???")).toBe("run");
  });
});

describe("runId", () => {
  it("formats run-YYYYMMDD-HHMMSS", () => {
    const id = runId(new Date(2026, 5, 13, 9, 4, 7));
    expect(id).toBe("run-20260613-090407");
  });
});

describe("canonicalizeUrl", () => {
  it("drops fragment, tracking params, www and trailing slash; lowercases host but preserves path case", () => {
    const a = canonicalizeUrl("https://www.Example.com/Page/?utm_source=x&q=1#frag");
    expect(a).toBe("https://example.com/Page?q=1");
  });
  it("preserves case-sensitive paths (distinct GitHub repos are not collapsed)", () => {
    expect(canonicalizeUrl("https://github.com/Microsoft/TypeScript")).not.toBe(canonicalizeUrl("https://github.com/microsoft/typescript"));
  });
  it("re-encodes a query value so an encoded '&' stays part of the value", () => {
    expect(canonicalizeUrl("https://x.com/a?q=a%26b")).toBe("https://x.com/a?q=a%26b");
  });
  it("treats www/non-www and trailing slash as the same resource", () => {
    expect(canonicalizeUrl("https://en.wikipedia.org/wiki/Rate_limiting/")).toBe(canonicalizeUrl("https://en.wikipedia.org/wiki/Rate_limiting"));
  });
  it("sorts query params for a stable key", () => {
    expect(canonicalizeUrl("https://x.com/a?b=2&a=1")).toBe(canonicalizeUrl("https://x.com/a?a=1&b=2"));
  });
  it("falls back gracefully on a non-URL", () => {
    expect(canonicalizeUrl("not a url")).toBe("not a url");
  });
});

describe("domainOf", () => {
  it("returns the bare host without www", () => {
    expect(domainOf("https://www.example.com/x")).toBe("example.com");
    expect(domainOf("garbage")).toBe("");
  });
});

describe("dedupeByUrl", () => {
  it("keeps the best-scored copy of a duplicate url", () => {
    const { items, dropped } = dedupeByUrl([
      src("https://x.com/a", 1),
      src("https://x.com/a/", 5), // same canonical
      src("https://y.com/b", 2),
    ]);
    expect(dropped).toBe(1);
    expect(items).toHaveLength(2);
    expect(items.find((i) => i.url.includes("x.com"))!.score).toBe(5);
  });
});

describe("trustScore", () => {
  it("scores authoritative domains and scholarly backends high", () => {
    expect(trustScore("https://nist.gov/x", "duckduckgo")).toBeGreaterThanOrEqual(0.9);
    expect(trustScore("https://example.com/p", "arxiv")).toBeGreaterThanOrEqual(0.9);
    expect(trustScore("https://en.wikipedia.org/wiki/X", "wikipedia")).toBeGreaterThanOrEqual(0.85);
  });
  it("scores SEO/aggregator domains low", () => {
    expect(trustScore("https://www.w3schools.com/x", "duckduckgo")).toBeLessThan(0.5);
  });
});

describe("keywords", () => {
  it("drops stopwords (EN + FR) and keeps identifiers", () => {
    const k = keywords("how does the retryBackoff work in français");
    expect(k).toContain("retryBackoff");
    expect(k).not.toContain("how");
    expect(k).not.toContain("the");
  });
  it("ranks distinctive tokens first", () => {
    const r = rankedKeywords("what is error 429 rate limiting");
    expect(r[0]).toBe("429");
  });
});

describe("buildMatcher", () => {
  it("matches a line containing a question keyword, accent-insensitively", () => {
    const m = buildMatcher("quelle stratégie de réessai");
    expect(m.matchLine("the retry strategie is documented").size).toBeGreaterThan(0);
  });
});

describe("rrf", () => {
  it("ranks an item appearing high in multiple lists best", () => {
    const a = ["x", "y", "z"];
    const b = ["y", "x", "w"];
    const fused = rrf([a, b], (s) => s);
    const ranked = [...fused.entries()].sort((p, q) => q[1] - p[1]).map(([k]) => k);
    expect(ranked[0]).toBe("x");
  });
});

describe("simhash / near-duplicate dedup", () => {
  const base =
    "token bucket rate limiting controls the request rate by adding tokens to a bucket at a fixed rate and rejecting requests when the bucket is empty leaky bucket is a related smoothing algorithm used by api gateways ".repeat(
      4,
    );

  it("scores near-identical text closer than unrelated text", () => {
    const a = simhash(base);
    const b = simhash(base + " a small trailing clause about retry budgets");
    const c = simhash("gardening tips for growing tomatoes in cold climates with proper soil moisture and sunlight ".repeat(4));
    expect(hammingDistance(a, b)).toBeLessThan(hammingDistance(a, c));
  });

  it("is deterministic", () => {
    expect(simhash(base)).toBe(simhash(base));
  });

  it("collapses syndicated copies across domains, keeping the higher-scored", () => {
    const mk = (url: string, score: number, text: string): RawSource => ({
      url,
      title: url,
      backend: "duckduckgo",
      score,
      snippet: "",
      text,
    });
    const { items, dropped } = dedupeNearDuplicates([
      mk("https://a.test/x", 0.9, base),
      mk("https://b.test/y", 0.5, base + " trivially different tail"),
      mk("https://c.test/z", 0.4, "completely unrelated gardening prose about tomatoes and soil ".repeat(12)),
    ]);
    expect(dropped).toBe(1);
    expect(items).toHaveLength(2);
    expect(items.some((i) => i.url.includes("a.test"))).toBe(true); // higher-scored survivor
    expect(items.some((i) => i.url.includes("b.test"))).toBe(false);
  });
});
