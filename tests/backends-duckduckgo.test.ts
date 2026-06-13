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

  it("notes when unreachable", async () => {
    installFetchMock(() => ({ status: 0, body: "" }));
    const r = await duckduckgoBackend(makeCtx("x"));
    expect(r.items).toHaveLength(0);
    expect(r.notes.join(" ")).toMatch(/unreachable/i);
  });
});
