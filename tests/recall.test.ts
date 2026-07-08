import { afterEach, describe, expect, it, vi } from "vitest";
import { rmSync, mkdtempSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { planVariants, identityKey, extractIdentifiers, contentCoverage, buildMatcher, arxivIdFromUrl, doiFromUrl } from "../src/util.js";
import { fuse, runGather } from "../src/gather.js";
import type { GatherOptions, RawSource, Source } from "../src/types.js";
import { installFetchMock } from "./fetchmock.js";

afterEach(() => vi.unstubAllGlobals());

function raw(over: Partial<RawSource>): RawSource {
  return { url: "https://x.test/a", title: "t", backend: "duckduckgo", score: 1, snippet: "", ...over };
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

describe("planVariants", () => {
  it("returns 1 variant for summary, 2 for standard (adds a keyword query)", () => {
    expect(planVariants("how does HTTP rate limiting work", "summary")).toHaveLength(1);
    const std = planVariants("how does HTTP rate limiting work", "standard");
    expect(std).toHaveLength(2);
    expect(std[0]).toBe("how does HTTP rate limiting work");
    expect(std[1]).not.toContain("how"); // keyword variant drops stopwords
  });
  it("adds an identifier variant at deep when identifiers are present", () => {
    const deep = planVariants("error 429 in retryBackoff v1.2.3", "deep");
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

  it("collapses arXiv abs/pdf/html URL variants (no backend meta) to one key", () => {
    const abs = identityKey(raw({ url: "https://arxiv.org/abs/2405.12345v2" }));
    expect(abs).toBe("arxiv:2405.12345");
    expect(identityKey(raw({ url: "https://arxiv.org/pdf/2405.12345.pdf" }))).toBe(abs);
    expect(identityKey(raw({ url: "https://arxiv.org/html/2405.12345" }))).toBe(abs);
    expect(identityKey(raw({ url: "https://export.arxiv.org/abs/2405.12345" }))).toBe(abs);
    expect(identityKey(raw({ meta: { arxivId: "2405.12345" } }))).toBe(abs);
  });

  it("collapses a DOI-in-path URL to the DOI key even without backend meta", () => {
    const canonical = identityKey(raw({ meta: { doi: "10.1145/3576915" } }));
    expect(identityKey(raw({ url: "https://doi.org/10.1145/3576915" }))).toBe(canonical);
    expect(identityKey(raw({ url: "https://dl.acm.org/doi/10.1145/3576915" }))).toBe(canonical);
    expect(identityKey(raw({ url: "https://dl.acm.org/doi/full/10.1145/3576915" }))).toBe(canonical);
  });

  it("does NOT collapse a non-arXiv host that merely has an /abs/ path", () => {
    const k = identityKey(raw({ url: "https://example.com/abs/2405.12345" }));
    expect(k).not.toMatch(/^arxiv:/);
  });
});

describe("arxivIdFromUrl / doiFromUrl", () => {
  it("extracts the modern arXiv id, stripping version and .pdf", () => {
    expect(arxivIdFromUrl("https://arxiv.org/abs/2405.12345v3")).toBe("2405.12345");
    expect(arxivIdFromUrl("https://arxiv.org/pdf/2405.12345.pdf")).toBe("2405.12345");
    expect(arxivIdFromUrl("https://example.com/x")).toBeUndefined();
  });

  it("extracts a DOI from doi.org and publisher /doi/ paths", () => {
    expect(doiFromUrl("https://doi.org/10.1145/3576915")).toBe("10.1145/3576915");
    expect(doiFromUrl("https://dl.acm.org/doi/full/10.1145/3576915")).toBe("10.1145/3576915");
    expect(doiFromUrl("https://example.com/no/doi/here")).toBeUndefined();
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
    const SUMMARY = JSON.stringify({
      extract: "Rate limiting controls request rate.",
      content_urls: { desktop: { page: "https://en.wikipedia.org/wiki/Rate_limiting" } },
    });
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
    await runGather(opts({ backends: ["generic"], urls: ["https://t.test/page-a", "https://t.test/page-b"], out: dir }));
    const sources = JSON.parse(readFileSync(join(dir, "sources.json"), "utf8")) as Source[];
    expect(sources[0]!.url).toContain("page-b"); // content relevance wins
    rmSync(dir, { recursive: true, force: true });
  });
});

describe("E3: BM25 re-rank resists keyword stuffing", () => {
  it("a page covering many distinct query terms beats one repeating a single keyword", async () => {
    const stuff = "rate ".repeat(50);
    installFetchMock((url) => {
      if (url.includes("page-stuff")) return { body: `<p>${stuff}</p>` };
      if (url.includes("page-cover")) return { body: "<p>the token bucket and leaky bucket algorithms control the request rate for limiting traffic</p>" };
      return undefined;
    });
    const dir = mkdtempSync(join(tmpdir(), "us-bm25-"));
    // generic preserves --url order, so page-stuff starts ranked above page-cover;
    // BM25 must promote the page that covers more distinct query terms.
    await runGather(
      opts({
        question: "token bucket leaky bucket rate limiting requests",
        backends: ["generic"],
        urls: ["https://t.test/page-stuff", "https://t.test/page-cover"],
        out: dir,
      }),
    );
    const sources = JSON.parse(readFileSync(join(dir, "sources.json"), "utf8")) as Source[];
    expect(sources[0]!.url).toContain("page-cover");
    rmSync(dir, { recursive: true, force: true });
  });
});

describe("E5: --queries overrides the planner and drives the multi-query fan-out", () => {
  it("issues the agent-supplied queries instead of the planned variants", async () => {
    const SEARCH = JSON.stringify({ pages: [{ key: "X", title: "X", excerpt: "x" }] });
    const SUMMARY = JSON.stringify({ extract: "Some text.", content_urls: { desktop: { page: "https://en.wikipedia.org/wiki/X" } } });
    const spy = installFetchMock((url) => {
      if (url.includes("/search/page")) return { body: SEARCH, contentType: "application/json" };
      if (url.includes("/summary/")) return { body: SUMMARY, contentType: "application/json" };
      return undefined;
    });
    const dir = mkdtempSync(join(tmpdir(), "us-queries-"));
    await runGather(
      opts({
        backends: ["wikipedia"],
        depth: "standard",
        queries: ["leaky bucket smoothing", "sliding window counter"],
        out: dir,
      }),
    );
    const searchUrls = spy.mock.calls.map((c) => String(c[0])).filter((u) => u.includes("/search/page"));
    expect(searchUrls.some((u) => u.includes("leaky%20bucket%20smoothing"))).toBe(true);
    expect(searchUrls.some((u) => u.includes("sliding%20window%20counter"))).toBe(true);
    expect(searchUrls.some((u) => u.includes("rate%20limiting"))).toBe(false); // planner NOT used
    rmSync(dir, { recursive: true, force: true });
  });
});

describe("E6: --rounds 2 issues a gap-driven follow-up web search", () => {
  it("searches once more for under-covered terms and records a gap note", async () => {
    const DDG_ONE = `
<a class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Freal.test%2Fpage-a">Token bucket</a>
<a class="result__snippet">token bucket only</a>`;
    const mock = () =>
      installFetchMock((url) => {
        if (url.includes("/search/page")) return { body: JSON.stringify({ pages: [] }), contentType: "application/json" };
        if (url.includes("html.duckduckgo.com")) return { body: DDG_ONE };
        if (url.includes("real.test")) return { body: "<p>token bucket token bucket token bucket</p>" }; // misses sliding/window/rate/counter
        return undefined;
      });
    const ddgCalls = (spy: any) => spy.mock.calls.map((c: any[]) => String(c[0])).filter((u: string) => u.includes("html.duckduckgo.com")).length;
    const q = "token bucket sliding window rate counter";

    const d1 = mkdtempSync(join(tmpdir(), "us-r1-"));
    let spy = mock();
    await runGather(opts({ question: q, webEngine: "ddg", rounds: 1, out: d1 }));
    const c1 = ddgCalls(spy);
    vi.unstubAllGlobals();

    const d2 = mkdtempSync(join(tmpdir(), "us-r2-"));
    spy = mock();
    const r2 = await runGather(opts({ question: q, webEngine: "ddg", rounds: 2, out: d2 }));
    const c2 = ddgCalls(spy);

    expect(c2).toBeGreaterThan(c1); // the gap round issued an extra search
    expect(r2.manifest.notes.join(" ")).toMatch(/Gap round/);
    rmSync(d1, { recursive: true, force: true });
    rmSync(d2, { recursive: true, force: true });
  });
});

describe("E7: web cascade fuses multiple engines at standard/deep, short-circuits at summary", () => {
  const DDG = `
<a class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Freal.test%2Fddg1">D1</a><a class="result__snippet">rate limiting d1</a>
<a class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Freal.test%2Fddg2">D2</a><a class="result__snippet">rate limiting d2</a>`;
  const LITE = `
<table>
<tr><td><a class="result-link" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Freal.test%2Flite1">L1</a></td></tr><tr><td class="result-snippet">rate limiting l1</td></tr>
<tr><td><a class="result-link" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Freal.test%2Flite2">L2</a></td></tr><tr><td class="result-snippet">rate limiting l2</td></tr>
</table>`;
  const mock = () =>
    installFetchMock((url) => {
      if (url.includes("/search/page")) return { body: JSON.stringify({ pages: [] }), contentType: "application/json" };
      if (url.includes("html.duckduckgo.com")) return { body: DDG };
      if (url.includes("lite.duckduckgo.com")) return { body: LITE };
      if (url.includes("real.test")) return { body: "<p>rate limiting content about token buckets and leaky buckets</p>" };
      return undefined; // searxng unconfigured (skipped); mojeek/marginalia → 404
    });

  it("standard depth fuses DuckDuckGo + DDG Lite (breadth 2) and records enginesFused", async () => {
    mock();
    const dir = mkdtempSync(join(tmpdir(), "us-fuse-"));
    const r = await runGather(opts({ depth: "standard", perSource: 2, out: dir }));
    const sources = JSON.parse(readFileSync(join(dir, "sources.json"), "utf8")) as Source[];
    const engines = new Set(sources.map((s) => s.backend));
    expect(engines.size).toBeGreaterThan(1); // sources span more than one engine
    expect(r.manifest.enginesFused!.length).toBeGreaterThan(1);
    expect(r.manifest.notes.join(" ")).toMatch(/fused/i);
    rmSync(dir, { recursive: true, force: true });
  });

  it("summary depth short-circuits at the first engine (breadth 1) — backward compatible", async () => {
    mock();
    const dir = mkdtempSync(join(tmpdir(), "us-summary-"));
    const r = await runGather(opts({ depth: "summary", perSource: 2, out: dir }));
    const sources = JSON.parse(readFileSync(join(dir, "sources.json"), "utf8")) as Source[];
    expect(new Set(sources.map((s) => s.backend))).toEqual(new Set(["duckduckgo"]));
    expect(r.manifest.enginesFused).toEqual(["duckduckgo"]);
    rmSync(dir, { recursive: true, force: true });
  });
});

describe("E4: web cascade falls through a blocked engine to a working fallback", () => {
  it("uses DuckDuckGo Lite when DuckDuckGo is blocked, and records provenance", async () => {
    const LITE_HTML = `
<table>
<tr><td><a class="result-link" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Freal.test%2Fone">One</a></td></tr>
<tr><td class="result-snippet">rate limiting one</td></tr>
<tr><td><a class="result-link" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Freal.test%2Ftwo">Two</a></td></tr>
<tr><td class="result-snippet">rate limiting two</td></tr>
</table>`;
    installFetchMock((url) => {
      if (url.includes("/search/page")) return { body: JSON.stringify({ pages: [] }), contentType: "application/json" };
      if (url.includes("html.duckduckgo.com")) return { status: 503, body: "" }; // primary blocked
      if (url.includes("lite.duckduckgo.com")) return { body: LITE_HTML }; // fallback works
      if (url.includes("real.test")) return { body: "<p>rate limiting content about token buckets</p>" };
      return undefined;
    });
    const dir = mkdtempSync(join(tmpdir(), "us-cascade-"));
    // mode topic + auto cascade; perSource 2 so the Lite results short-circuit
    // before mojeek/marginalia are queried. searxng is unconfigured (skipped).
    const r = await runGather(opts({ depth: "standard", perSource: 2, out: dir }));
    const sources = JSON.parse(readFileSync(join(dir, "sources.json"), "utf8")) as Source[];
    expect(sources.length).toBeGreaterThan(0);
    expect(sources.every((s) => s.url.includes("real.test"))).toBe(true);
    expect(sources.some((s) => s.backend === "ddglite")).toBe(true);
    expect(r.manifest.notes.join(" ")).toMatch(/cascade.*ddglite/i);
    rmSync(dir, { recursive: true, force: true });
  });
});
