import { afterEach, describe, expect, it, vi } from "vitest";
import { searxngBackend, resetSearxngProbeCache, SEARXNG_DEFAULT_BASE } from "../src/backends/searxng.js";
import { installFetchMock, routes } from "./fetchmock.js";
import { makeCtx } from "./ctx.js";

// The availability probe is memoised per base for the whole process, so without
// this every test after the first would be served the first one's verdict.
afterEach(() => {
  vi.unstubAllGlobals();
  resetSearxngProbeCache();
});

const SEARX_JSON = JSON.stringify({
  results: [
    { url: "https://a.test/1", title: "First", content: "first snippet" },
    { url: "https://b.test/2", title: "Second", content: "second snippet" },
  ],
});

describe("searxngBackend", () => {
  it("parses the JSON results into ranked sources", async () => {
    installFetchMock(routes([["format=json", { body: SEARX_JSON, contentType: "application/json" }]]));
    const r = await searxngBackend(makeCtx("rate limiting", { searxng: "http://localhost:8888" }));
    expect(r.items).toHaveLength(2);
    expect(r.items[0]!.url).toBe("https://a.test/1");
    expect(r.items[0]!.snippet).toBe("first snippet");
    expect(r.items[0]!.score).toBeGreaterThan(r.items[1]!.score);
  });

  // SearXNG used to be opt-in: with no flag and no env it skipped outright, so
  // `ultrasearch searxng up` brought the container up and nothing
  // ever queried it. It now defaults to localhost, gated by a probe.
  it("defaults to localhost:8888 when nothing is configured", async () => {
    vi.stubEnv("ULTRASEARCH_SEARXNG", undefined); // tests/setup.ts pins it to "off"
    const spy = installFetchMock(routes([["format=json", { body: SEARX_JSON, contentType: "application/json" }]]));
    const r = await searxngBackend(makeCtx("rate limiting"));
    expect(r.items).toHaveLength(2);
    expect(spy.mock.calls.some((c) => String(c[0]).startsWith(SEARXNG_DEFAULT_BASE))).toBe(true);
  });

  it("skips with a start-it hint when nothing is configured and no instance answers", async () => {
    vi.stubEnv("ULTRASEARCH_SEARXNG", undefined);
    // The router can't model a refused connection, so throw like the real thing.
    const spy = vi.fn(async (_url: string) => {
      throw new Error("ECONNREFUSED");
    });
    vi.stubGlobal("fetch", spy);
    const r = await searxngBackend(makeCtx("x"));
    expect(r.items).toHaveLength(0);
    expect(r.notes.join(" ")).toMatch(/not running/i);
    // Only the probe ran — the paginated query never started.
    expect(spy).toHaveBeenCalledTimes(1);
    expect(String(spy.mock.calls[0]![0])).toContain("/healthz");
  });

  it("is disabled by `off` without touching the network", async () => {
    const spy = installFetchMock(() => ({ status: 200, body: "{}" }));
    const r = await searxngBackend(makeCtx("x", { searxng: "off" }));
    expect(r.items).toHaveLength(0);
    expect(r.notes.join(" ")).toMatch(/disabled/i);
    expect(spy).not.toHaveBeenCalled();
  });

  it("falls through with a note when a configured instance is unreachable", async () => {
    installFetchMock(() => ({ status: 0, body: "" }));
    const r = await searxngBackend(makeCtx("x", { searxng: "http://localhost:8888" }));
    expect(r.items).toHaveLength(0);
    expect(r.notes.join(" ")).toMatch(/unreachable/i);
  });

  it("notes when the instance returns non-JSON (json disabled)", async () => {
    installFetchMock(() => ({ status: 200, body: "<html>blocked</html>", contentType: "text/html" }));
    const r = await searxngBackend(makeCtx("x", { searxng: "http://localhost:8888" }));
    expect(r.items).toHaveLength(0);
    expect(r.notes.join(" ")).toMatch(/did not return JSON/i);
  });

  it("paginates via &pageno= and concatenates deduped pages", async () => {
    const PG2 = JSON.stringify({
      results: [
        { url: "https://c.test/3", title: "Third", content: "third" },
        { url: "https://d.test/4", title: "Fourth", content: "fourth" },
      ],
    });
    const spy = installFetchMock((url) => ({
      body: url.includes("pageno=2") ? PG2 : SEARX_JSON,
      contentType: "application/json",
    }));
    const r = await searxngBackend(makeCtx("x", { searxng: "http://localhost:8888", pages: 2 }));
    // Count the SEARCH calls only — the availability probe also goes through fetch.
    const queries = spy.mock.calls.map((c) => String(c[0])).filter((u) => u.includes("format=json"));
    expect(queries).toHaveLength(2);
    expect(queries[1]).toContain("pageno=2");
    expect(r.items.map((i) => i.url)).toEqual(["https://a.test/1", "https://b.test/2", "https://c.test/3", "https://d.test/4"]);
  });

  // SearXNG answers 200 with an EMPTY result list when its own upstreams have
  // throttled it, reporting them in `unresponsive_engines`. Reading that field is
  // what separates "this query has no hits" from "come back in five minutes".
  it("names the throttled upstream engines instead of reporting an empty query", async () => {
    installFetchMock(
      routes([
        [
          "format=json",
          {
            body: JSON.stringify({
              results: [],
              unresponsive_engines: [
                ["brave", "Suspended: too many requests"],
                ["duckduckgo", "CAPTCHA"],
              ],
            }),
            contentType: "application/json",
          },
        ],
      ]),
    );
    const r = await searxngBackend(makeCtx("x", { searxng: "http://localhost:8888" }));
    expect(r.items).toHaveLength(0);
    const note = r.notes.join(" ");
    expect(note).toMatch(/throttling this instance/i);
    expect(note).toMatch(/transient/i);
    expect(note).toContain("brave (Suspended: too many requests)");
    expect(note).toContain("duckduckgo (CAPTCHA)");
  });

  it("still says plainly when a query simply has no hits", async () => {
    installFetchMock(routes([["format=json", { body: JSON.stringify({ results: [] }), contentType: "application/json" }]]));
    const r = await searxngBackend(makeCtx("x", { searxng: "http://localhost:8888" }));
    expect(r.notes.join(" ")).toBe("SearXNG returned no results.");
  });
});
