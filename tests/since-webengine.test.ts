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
import { pubmedBackend } from "../src/backends/pubmed.js";
import { europepmcBackend } from "../src/backends/europepmc.js";
import { semanticscholarBackend } from "../src/backends/semanticscholar.js";
import { arxivBackend } from "../src/backends/arxiv.js";
import { dblpBackend } from "../src/backends/dblp.js";
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
    // calls[0] is the availability probe; the search request is the next one.
    const query = spy.mock.calls.find((c) => String(c[0]).includes("format=json"))!;
    expect(String(query[0])).toContain("language=de");
    expect(headerOf(query)["accept-language"]).toContain("de");
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
  it("host drops both discovery backends (the agent drives its own web search)", () => {
    expect(resolveBackends(ctx("host"), topic)).toEqual(["wikipedia", "standards"]);
  });
  it("firecrawl is pinnable but never part of auto (it is not in DISCOVERY)", () => {
    expect(resolveBackends(ctx("firecrawl"), topic)).toEqual(["wikipedia", "standards", "firecrawl"]);
    expect(resolveBackends(ctx("auto"), topic)).not.toContain("firecrawl");
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

  const today = new Date().toISOString().slice(0, 10);
  const json = (o: unknown) => ({ body: JSON.stringify(o), contentType: "application/json" });

  it("pubmed asks esearch for a publication-date window, both ends given", async () => {
    const spy = installFetchMock(() => json({ esearchresult: { idlist: [] } }));
    await pubmedBackend(makeCtx("cataract", { since }));
    const url = String(spy.mock.calls[0]![0]);
    // Open-ended: an issue dated ahead of today is still recent.
    expect(url).toContain("&datetype=pdat&mindate=2023/01/01&maxdate=3000");
  });

  it("europepmc ANDs a first-publication range onto the query", async () => {
    const spy = installFetchMock(() => json({ resultList: { result: [] } }));
    await europepmcBackend(makeCtx("cataract surgery", { since }));
    expect(decodeURIComponent(String(spy.mock.calls[0]![0]))).toContain("query=(cataract surgery) AND FIRST_PDATE:[2023-01-01 TO 3000-12-31]");
  });

  it("semanticscholar adds an open-ended publication range", async () => {
    const spy = installFetchMock(() => json({ data: [] }));
    await semanticscholarBackend(makeCtx("transformer", { since }));
    expect(String(spy.mock.calls[0]![0])).toContain("&publicationDateOrYear=2023-01-01:");
  });

  it("arxiv ANDs a submission-date range onto every query it tries", async () => {
    const spy = installFetchMock(() => ({ body: "<feed></feed>", contentType: "application/atom+xml" }));
    await arxivBackend(makeCtx("early exit transformer reinforcement", { since }));
    const urls = spy.mock.calls.map((c) => decodeURIComponent(String(c[0])));
    expect(urls.length).toBeGreaterThan(1);
    for (const u of urls) expect(u).toContain(`) AND submittedDate:[202301010000 TO ${today.replace(/-/g, "")}2359]`);
  });

  it("dblp keeps the records from the --since year on, and says so when none are", async () => {
    const hit = (year: string, title: string) => ({ info: { title, year, ee: `https://x.test/${title}` } });
    installFetchMock(() =>
      json({ result: { hits: { hit: [hit("2019", "old"), hit("2024", "new"), { info: { title: "undated", ee: "https://x.test/u" } }] } } }),
    );
    const r = await dblpBackend(makeCtx("transformer", { since }));
    expect(r.items.map((i) => i.title)).toEqual(["new", "undated"]);
    installFetchMock(() => json({ result: { hits: { hit: [hit("2019", "old")] } } }));
    const none = await dblpBackend(makeCtx("transformer", { since }));
    expect(none.items).toEqual([]);
    expect(none.notes[0]).toBe('dblp search returned 1 publication(s) for "transformer", none from 2023 on (--since).');
  });

  it("leaves the scholarly requests alone without --since", async () => {
    const spy = installFetchMock(() => json({ esearchresult: { idlist: [] }, resultList: { result: [] }, data: [] }));
    await pubmedBackend(makeCtx("cataract"));
    await europepmcBackend(makeCtx("cataract"));
    await semanticscholarBackend(makeCtx("cataract"));
    for (const c of spy.mock.calls) expect(String(c[0])).not.toMatch(/mindate|FIRST_PDATE|publicationDateOrYear/);
  });

  it("hackernews adds a created_at numeric filter", async () => {
    const spy = installFetchMock(() => ({ body: JSON.stringify({ hits: [] }), contentType: "application/json" }));
    await hackernewsBackend(makeCtx("rate limiter", { since }));
    expect(String(spy.mock.calls[0]![0])).toContain("created_at_i>1672531200");
  });
});
