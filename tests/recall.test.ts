import { afterEach, describe, expect, it, vi } from "vitest";
import { rmSync, mkdtempSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { planVariants, identityKey, extractIdentifiers, contentCoverage, buildMatcher } from "../src/util.js";
import { fuse, runGather } from "../src/gather.js";
import type { GatherOptions, RawSource, Source } from "../src/types.js";
import { installFetchMock } from "./fetchmock.js";

afterEach(() => vi.unstubAllGlobals());

function raw(over: Partial<RawSource>): RawSource {
  return { url: "https://x.test/a", title: "t", backend: "duckduckgo", score: 1, snippet: "", ...over };
}
function opts(over: Partial<GatherOptions>): GatherOptions {
  return {
    question: "what is rate limiting", mode: "topic", depth: "standard",
    maxSources: 25, perSource: 6, lang: "en", webEngine: "auto",
    excludeDomains: [], json: false, fresh: false, ...over,
  };
}

describe("planVariants", () => {
  it("returns 1 variant for summary, 2 for standard (adds a keyword query)", () => {
    expect(planVariants("how does HTTP rate limiting work", "summary")).toHaveLength(1);
    const std = planVariants("how does HTTP rate limiting work", "standard");
    expect(std).toHaveLength(2);
    expect(std[0]).toBe("how does HTTP rate limiting work");
    expect(std[1]).not.toContain("how"); // keyword variant drops stopwords
  });
  it("adds an identifier variant at deep when identifiers are present", () => {
    const deep = planVariants('error 429 in retryBackoff v1.2.3', "deep");
    expect(deep.length).toBeGreaterThanOrEqual(2);
    expect(deep.join(" ")).toMatch(/429/);
  });
});

describe("extractIdentifiers", () => {
  it("pulls versions, codes, camelCase and snake_case", () => {
    const ids = extractIdentifiers("crash 429 in retryBackoff and max_retries v2.0.1");
    expect(ids).toEqual(expect.arrayContaining(["429", "retryBackoff", "max_retries", "v2.0.1"]));
  });
});

describe("identityKey", () => {
  it("keys by normalized DOI, then arXiv id, then URL", () => {
    expect(identityKey(raw({ meta: { doi: "https://doi.org/10.1/ABC" } }))).toBe("doi:10.1/abc");
    expect(identityKey(raw({ meta: { arxivId: "1706.03762v5" } }))).toBe("arxiv:1706.03762");
    expect(identityKey(raw({ url: "https://x.test/a/" }))).toBe("https://x.test/a");
  });
});

describe("fuse (identity dedup + meta merge)", () => {
  it("collapses the same DOI across two backends into one entry, preferring text and merging meta", () => {
    const a = raw({ url: "https://arxiv.org/abs/1", backend: "arxiv", score: 3, text: "the abstract", meta: { doi: "10.1/x" } });
    const b = raw({ url: "https://doi.org/10.1/X", backend: "crossref", score: 2, meta: { doi: "https://doi.org/10.1/x", year: 2020 } });
    const out = fuse([[a], [b]]);
    expect(out).toHaveLength(1);
    expect(out[0]!.text).toBe("the abstract"); // text-bearing copy preferred
    expect(out[0]!.meta?.year).toBe(2020); // metadata merged from the other copy
  });
});

describe("contentCoverage", () => {
  it("is higher for text that covers more of the question's keywords", () => {
    const m = buildMatcher("token bucket rate limiting algorithm");
    const rich = contentCoverage(m, "the token bucket algorithm is a rate limiting strategy");
    const poor = contentCoverage(m, "an unrelated paragraph about cats");
    expect(rich).toBeGreaterThan(poor);
  });
});

describe("E1: multi-query fan-out (runGather)", () => {
  it("issues each planned variant to a multi-query backend", async () => {
    const SEARCH = JSON.stringify({ pages: [{ key: "Rate_limiting", title: "Rate limiting", excerpt: "x" }] });
    const SUMMARY = JSON.stringify({ extract: "Rate limiting controls request rate.", content_urls: { desktop: { page: "https://en.wikipedia.org/wiki/Rate_limiting" } } });
    const spy = installFetchMock((url) => {
      if (url.includes("/search/page")) return { body: SEARCH, contentType: "application/json" };
      if (url.includes("/summary/")) return { body: SUMMARY, contentType: "application/json" };
      return undefined;
    });
    const dir = mkdtempSync(join(tmpdir(), "us-recall-"));
    await runGather(opts({ backends: ["wikipedia"], depth: "standard", out: dir }));
    const searchUrls = spy.mock.calls.map((c) => String(c[0])).filter((u) => u.includes("/search/page"));
    expect(searchUrls.some((u) => u.includes("what%20is%20rate%20limiting"))).toBe(true); // full question
    expect(searchUrls.some((u) => /q=[^&]*limiting/.test(u) && !u.includes("what"))).toBe(true); // stopword-free keyword variant
    rmSync(dir, { recursive: true, force: true });
  });
});

describe("E2: content-aware re-rank promotes the on-topic page over backend rank", () => {
  it("ranks the keyword-rich page first even when the backend ranked it lower", async () => {
    installFetchMock((url) => {
      if (url.includes("page-a")) return { body: "<p>completely unrelated text about gardening and weather</p>" };
      if (url.includes("page-b")) return { body: "<p>rate limiting caps requests; the token bucket and leaky bucket control the request rate</p>" };
      return undefined;
    });
    const dir = mkdtempSync(join(tmpdir(), "us-rerank-"));
    // generic preserves --url order, so page-a starts ranked above page-b.
    const r = await runGather(opts({ backends: ["generic"], urls: ["https://t.test/page-a", "https://t.test/page-b"], out: dir }));
    const sources = JSON.parse(readFileSync(join(dir, "sources.json"), "utf8")) as Source[];
    expect(sources[0]!.url).toContain("page-b"); // content relevance wins
    rmSync(dir, { recursive: true, force: true });
  });
});
