import { afterEach, describe, expect, it, vi } from "vitest";
import { duckduckgoBackend } from "../src/backends/duckduckgo.js";
import { installFetchMock, routes } from "./fetchmock.js";
import { makeCtx } from "./ctx.js";

afterEach(() => vi.unstubAllGlobals());

// Realistic-ish DDG HTML: redirector href carrying the real URL in `uddg`,
// arbitrary attribute order, and a parallel result__snippet anchor.
const DDG_HTML = `
<div class="result results_links">
  <a rel="nofollow" class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Freal.test%2Fpage-one&rut=abc">First &amp; Best</a>
  <a class="result__snippet" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Freal.test%2Fpage-one">snippet one about token bucket</a>
</div>
<div class="result results_links">
  <a href="//duckduckgo.com/l/?uddg=https%3A%2F%2Freal.test%2Fpage-two" class="result__a">Second</a>
  <a class="result__snippet">snippet two</a>
</div>
<div class="result results_links">
  <a class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fduckduckgo.com%2Fads">Ad (own domain)</a>
</div>`;

describe("duckduckgoBackend", () => {
  it("decodes uddg redirector links, titles and snippets; drops DDG's own domain", async () => {
    installFetchMock(routes([["duckduckgo.com/html", { body: DDG_HTML }]]));
    const r = await duckduckgoBackend(makeCtx("token bucket"));
    expect(r.items.map((i) => i.url)).toEqual([
      "https://real.test/page-one",
      "https://real.test/page-two",
    ]);
    expect(r.items[0]!.title).toBe("First & Best");
    expect(r.items[0]!.snippet).toContain("token bucket");
  });

  it("keeps each result's own snippet even when a skipped ad has a snippet (no index shift)", async () => {
    const html = `
<div class="result"><a class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Freal.test%2Fa">Result A</a>
<a class="result__snippet">snippet for A</a></div>
<div class="result"><a class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fduckduckgo.com%2Fy.com%2Fad">Ad</a>
<a class="result__snippet">snippet for the AD</a></div>
<div class="result"><a class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Freal.test%2Fb">Result B</a>
<a class="result__snippet">snippet for B</a></div>`;
    installFetchMock(routes([["duckduckgo.com/html", { body: html }]]));
    const r = await duckduckgoBackend(makeCtx("x"));
    expect(r.items.map((i) => i.url)).toEqual(["https://real.test/a", "https://real.test/b"]);
    expect(r.items[1]!.snippet).toBe("snippet for B"); // NOT "snippet for the AD"
  });

  it("notes when unreachable", async () => {
    installFetchMock(() => ({ status: 0, body: "" }));
    const r = await duckduckgoBackend(makeCtx("x"));
    expect(r.items).toHaveLength(0);
    expect(r.notes.join(" ")).toMatch(/unreachable/i);
  });

  const PAGE1 = `
<a class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Freal.test%2Fa">A</a><a class="result__snippet">sa</a>
<a class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Freal.test%2Fb">B</a><a class="result__snippet">sb</a>`;
  const PAGE2 = `
<a class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Freal.test%2Fc">C</a><a class="result__snippet">sc</a>
<a class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Freal.test%2Fd">D</a><a class="result__snippet">sd</a>`;

  it("paginates via &s= and concatenates deduped results across pages", async () => {
    const spy = installFetchMock((url) => ({ body: url.includes("s=30") ? PAGE2 : PAGE1 }));
    const r = await duckduckgoBackend(makeCtx("x", { pages: 2 }));
    expect(spy.mock.calls).toHaveLength(2);
    expect(String(spy.mock.calls[1]![0])).toContain("s=30");
    expect(r.items.map((i) => i.url)).toEqual([
      "https://real.test/a",
      "https://real.test/b",
      "https://real.test/c",
      "https://real.test/d",
    ]);
    expect(r.items[0]!.score).toBeGreaterThan(r.items[3]!.score); // page-1 outranks page-2
  });

  it("stops early when a page adds no new URLs (engine ignores the offset)", async () => {
    const spy = installFetchMock(() => ({ body: PAGE1 })); // same page for every offset
    const r = await duckduckgoBackend(makeCtx("x", { pages: 3 }));
    expect(spy.mock.calls).toHaveLength(2); // page 0 + 1 probe; page 2 never fetched
    expect(r.items.map((i) => i.url)).toEqual(["https://real.test/a", "https://real.test/b"]);
  });
});
