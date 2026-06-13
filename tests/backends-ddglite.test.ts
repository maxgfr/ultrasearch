import { afterEach, describe, expect, it, vi } from "vitest";
import { ddgliteBackend } from "../src/backends/ddglite.js";
import { installFetchMock, routes } from "./fetchmock.js";
import { makeCtx } from "./ctx.js";

afterEach(() => vi.unstubAllGlobals());

// DDG Lite: a flat results table. result-link anchors carry the uddg redirector;
// snippets ride in a following result-snippet cell. Includes a skipped ad whose
// snippet must not shift onto the wrong result.
const LITE_HTML = `
<table>
<tr><td><a rel="nofollow" class="result-link" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Freal.test%2Fone">First &amp; Best</a></td></tr>
<tr><td class="result-snippet">snippet one about token bucket</td></tr>
<tr><td><a class="result-link" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fduckduckgo.com%2Fads">Ad</a></td></tr>
<tr><td class="result-snippet">snippet for the AD</td></tr>
<tr><td><a class="result-link" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Freal.test%2Ftwo">Second</a></td></tr>
<tr><td class="result-snippet">snippet two</td></tr>
</table>`;

describe("ddgliteBackend", () => {
  it("decodes uddg links/titles/snippets, drops DDG's own domain, no index shift", async () => {
    installFetchMock(routes([["lite.duckduckgo.com", { body: LITE_HTML }]]));
    const r = await ddgliteBackend(makeCtx("token bucket"));
    expect(r.items.map((i) => i.url)).toEqual(["https://real.test/one", "https://real.test/two"]);
    expect(r.items[0]!.title).toBe("First & Best");
    expect(r.items[0]!.snippet).toContain("token bucket");
    expect(r.items[1]!.snippet).toBe("snippet two"); // NOT the ad's snippet
  });

  it("notes when rate-limited", async () => {
    installFetchMock(() => ({ status: 429, body: "" }));
    const r = await ddgliteBackend(makeCtx("x"));
    expect(r.items).toHaveLength(0);
    expect(r.notes.join(" ")).toMatch(/rate-limited/i);
  });
});
