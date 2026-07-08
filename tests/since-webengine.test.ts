import { afterEach, describe, expect, it, vi } from "vitest";
import { resolveBackends } from "../src/gather.js";
import { getMode } from "../src/modes/registry.js";
import { crossrefBackend } from "../src/backends/crossref.js";
import { githubBackend } from "../src/backends/github.js";
import { stackexchangeBackend } from "../src/backends/stackexchange.js";
import { hackernewsBackend } from "../src/backends/hackernews.js";
import { duckduckgoBackend } from "../src/backends/duckduckgo.js";
import { ddgliteBackend } from "../src/backends/ddglite.js";
import { searxngBackend } from "../src/backends/searxng.js";
import { wikipediaBackend } from "../src/backends/wikipedia.js";
import { installFetchMock } from "./fetchmock.js";
import { makeCtx } from "./ctx.js";

afterEach(() => vi.unstubAllGlobals());

describe("lang/region is wired into the web backends", () => {
  const headerOf = (call: any[]): Record<string, string> => (call[1] as RequestInit).headers as Record<string, string>;

  it("DuckDuckGo adds kl=de-de + Accept-Language", async () => {
    const spy = installFetchMock(() => ({ body: "" }));
    await duckduckgoBackend(makeCtx("startup idee", { lang: "de" }));
    expect(String(spy.mock.calls[0]![0])).toContain("kl=de-de");
    expect(headerOf(spy.mock.calls[0]!)["accept-language"]).toContain("de");
  });

  it("DuckDuckGo Lite adds kl with an explicit region override", async () => {
    const spy = installFetchMock(() => ({ body: "" }));
    await ddgliteBackend(makeCtx("startup idea", { lang: "en", region: "de" }));
    expect(String(spy.mock.calls[0]![0])).toContain("kl=de-en");
  });

  it("SearXNG adds &language=de", async () => {
    const spy = installFetchMock(() => ({ body: JSON.stringify({ results: [] }), contentType: "application/json" }));
    await searxngBackend(makeCtx("startup", { lang: "de", searxng: "http://localhost:8888" }));
    expect(String(spy.mock.calls[0]![0])).toContain("language=de");
    expect(headerOf(spy.mock.calls[0]!)["accept-language"]).toContain("de");
  });

  it("Wikipedia uses the de.wikipedia.org subdomain", async () => {
    const spy = installFetchMock(() => ({ body: JSON.stringify({ pages: [] }), contentType: "application/json" }));
    await wikipediaBackend(makeCtx("Startup", { lang: "de" }));
    expect(String(spy.mock.calls[0]![0])).toContain("https://de.wikipedia.org");
  });
});

describe("R6: --web-engine filters the discovery backends", () => {
  const topic = getMode("topic"); // [wikipedia, searxng, duckduckgo, standards]
  const ctx = (engine: any) => makeCtx("x", { webEngine: engine }).options;
  it("auto keeps both searxng and duckduckgo", () => {
    expect(resolveBackends(ctx("auto"), topic)).toEqual(["wikipedia", "searxng", "duckduckgo", "standards"]);
  });
  it("ddg keeps only duckduckgo among discovery", () => {
    expect(resolveBackends(ctx("ddg"), topic)).toEqual(["wikipedia", "duckduckgo", "standards"]);
  });
  it("searxng keeps only searxng among discovery", () => {
    expect(resolveBackends(ctx("searxng"), topic)).toEqual(["wikipedia", "searxng", "standards"]);
  });
  it("claude drops both discovery backends (agent drives WebSearch)", () => {
    expect(resolveBackends(ctx("claude"), topic)).toEqual(["wikipedia", "standards"]);
  });
});

describe("E5: --since is wired into date-capable backends", () => {
  // 2023-01-01T00:00:00Z = epoch 1672531200
  const since = "2023-01-01";

  it("crossref adds from-pub-date", async () => {
    const spy = installFetchMock(() => ({ body: JSON.stringify({ message: { items: [] } }), contentType: "application/json" }));
    await crossrefBackend(makeCtx("rag", { since }));
    expect(String(spy.mock.calls[0]![0])).toContain("from-pub-date:2023-01-01");
  });

  it("github adds created:>= to the query", async () => {
    const spy = installFetchMock(() => ({ body: JSON.stringify({ items: [] }), contentType: "application/json" }));
    await githubBackend(makeCtx("crash", { since }));
    const url = String(spy.mock.calls[0]![0]);
    expect(url).toContain("created");
    expect(url).toContain("2023-01-01");
  });

  it("stackexchange adds fromdate epoch", async () => {
    const spy = installFetchMock(() => ({ body: JSON.stringify({ items: [] }), contentType: "application/json" }));
    await stackexchangeBackend(makeCtx("error", { since }));
    expect(String(spy.mock.calls[0]![0])).toContain("fromdate=1672531200");
  });

  it("hackernews adds a created_at numeric filter", async () => {
    const spy = installFetchMock(() => ({ body: JSON.stringify({ hits: [] }), contentType: "application/json" }));
    await hackernewsBackend(makeCtx("rate limiter", { since }));
    expect(String(spy.mock.calls[0]![0])).toContain("created_at_i>1672531200");
  });
});
