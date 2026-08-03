import { afterEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { firecrawlBackend, firecrawlBase, mapScrapeResponse, mapSearchResponse, probeFirecrawl, scrapeViaFirecrawl } from "../src/backends/firecrawl.js";
import { fetchAndExtract } from "../src/backends/fetch.js";
import { installFetchMock, routes } from "./fetchmock.js";
import { makeCtx } from "./ctx.js";

const here = dirname(fileURLToPath(import.meta.url));
const SCRAPE_FIXTURE = JSON.parse(readFileSync(join(here, "fixtures", "pages", "firecrawl-scrape.json"), "utf8"));

// The availability probe and the /v2→/v1 prefix fallback are memoised PER BASE
// for the process, so every case that needs a different verdict uses its own
// base URL. (tests/setup.ts sets ULTRASEARCH_FIRECRAWL=off globally; passing an
// explicit base overrides it.)
let n = 0;
const nextBase = () => `http://fc${++n}.test`;

afterEach(() => vi.unstubAllGlobals());

describe("firecrawlBase", () => {
  it("prefers the flag, then the env var, then the localhost default", () => {
    expect(firecrawlBase({ firecrawl: "http://flag.test:3002/" })).toBe("http://flag.test:3002");
    process.env.ULTRASEARCH_FIRECRAWL = "http://env.test:3002";
    expect(firecrawlBase()).toBe("http://env.test:3002");
    delete process.env.ULTRASEARCH_FIRECRAWL;
    expect(firecrawlBase()).toBe("http://localhost:3002");
    process.env.ULTRASEARCH_FIRECRAWL = "off"; // restore the suite-wide default
  });

  it('treats the literal "off" as disabled, from either source', () => {
    expect(firecrawlBase({ firecrawl: "off" })).toBeNull();
    expect(firecrawlBase({ firecrawl: "OFF" })).toBeNull();
    expect(firecrawlBase()).toBeNull(); // ULTRASEARCH_FIRECRAWL=off from tests/setup.ts
  });
});

describe("mapScrapeResponse", () => {
  it("maps a real /scrape response to markdown + provenance", () => {
    const r = mapScrapeResponse(SCRAPE_FIXTURE);
    expect(r).not.toBeNull();
    expect(r!.markdown).toContain("# Upgrade to Express v5");
    expect(r!.title).toBe("Upgrade to Express v5");
    expect(r!.sourceURL).toBe("https://expressjs.com/en/guide/migrating-5.html");
    expect(r!.statusCode).toBe(200);
  });

  it("falls back to metadata.url when sourceURL is absent", () => {
    const r = mapScrapeResponse({ success: true, data: { markdown: "# x", metadata: { url: "https://u.test/p" } } });
    expect(r!.sourceURL).toBe("https://u.test/p");
    expect(r!.title).toBeUndefined();
    expect(r!.statusCode).toBeUndefined();
  });

  it("returns null on success:false, missing data, or empty markdown", () => {
    expect(mapScrapeResponse({ success: false, data: { markdown: "# x" } })).toBeNull();
    expect(mapScrapeResponse({ success: true })).toBeNull();
    expect(mapScrapeResponse({ success: true, data: { markdown: "   " } })).toBeNull();
    expect(mapScrapeResponse({ success: true, data: { markdown: 42 } })).toBeNull();
    expect(mapScrapeResponse(undefined)).toBeNull();
    expect(mapScrapeResponse("not json")).toBeNull();
  });
});

describe("mapSearchResponse", () => {
  const BODY = {
    success: true,
    data: {
      web: [
        { url: "https://a.test/1", title: "First", description: "first snippet" },
        { url: "https://b.test/2", title: "", description: "second", markdown: "# Second\n\nbody" },
        { title: "no url — dropped", description: "x" },
      ],
    },
  };

  it("maps the web hits, degrading an empty title to the URL", () => {
    const hits = mapSearchResponse(BODY);
    expect(hits).toHaveLength(2);
    expect(hits[0]).toEqual({ url: "https://a.test/1", title: "First", description: "first snippet" });
    expect(hits[1]!.title).toBe("https://b.test/2");
    expect(hits[1]!.markdown).toContain("# Second");
  });

  it("returns [] on success:false or an unusable body", () => {
    expect(mapSearchResponse({ success: false, data: { web: [{ url: "https://a.test" }] } })).toEqual([]);
    expect(mapSearchResponse({ success: true, data: {} })).toEqual([]);
    expect(mapSearchResponse(null)).toEqual([]);
  });
});

describe("probeFirecrawl", () => {
  it("counts any HTTP response as up, and memoises the verdict per base", async () => {
    const base = nextBase();
    const spy = installFetchMock(() => ({ status: 200, body: '{"message":"Firecrawl API"}', contentType: "application/json" }));
    expect(await probeFirecrawl(base)).toBe(true);
    expect(await probeFirecrawl(base)).toBe(true);
    expect(spy).toHaveBeenCalledTimes(1); // memoised: one probe per process
  });

  it("is down (never throws) when the connection is refused", async () => {
    const base = nextBase();
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new Error("ECONNREFUSED");
      }),
    );
    expect(await probeFirecrawl(base)).toBe(false);
  });
});

describe("scrapeViaFirecrawl", () => {
  it("POSTs /v2/scrape with the markdown contract and returns the cleaned page", async () => {
    const base = nextBase();
    const spy = installFetchMock(
      routes([
        ["/scrape", { body: JSON.stringify(SCRAPE_FIXTURE), contentType: "application/json" }],
        ["", { body: "ok" }], // the probe
      ]),
    );
    const r = await scrapeViaFirecrawl("https://expressjs.com/en/guide/migrating-5.html", { firecrawl: base });
    expect(r.data!.markdown).toContain("Express 5 removes");
    const call = spy.mock.calls.find((c) => String(c[0]).includes("/scrape"))!;
    expect(String(call[0])).toBe(`${base}/v2/scrape`);
    const body = JSON.parse((call[1] as RequestInit).body as string);
    expect(body).toMatchObject({ formats: ["markdown"], onlyMainContent: true, blockAds: true, removeBase64Images: true });
    expect(body.maxAge).toBeGreaterThan(0);
    // never the async job API
    expect(spy.mock.calls.some((c) => String(c[0]).includes("/batch/"))).toBe(false);
  });

  it("falls back to /v1 when /v2 404s, and remembers it", async () => {
    const base = nextBase();
    const spy = installFetchMock((url) => {
      if (url.includes("/v2/scrape")) return { status: 404, body: "not found" };
      if (url.includes("/v1/scrape")) return { body: JSON.stringify(SCRAPE_FIXTURE), contentType: "application/json" };
      return { body: "ok" };
    });
    expect((await scrapeViaFirecrawl("https://x.test/a", { firecrawl: base })).data).toBeTruthy();
    const before = spy.mock.calls.length;
    expect((await scrapeViaFirecrawl("https://x.test/b", { firecrawl: base })).data).toBeTruthy();
    const after = spy.mock.calls.slice(before).map((c) => String(c[0]));
    expect(after).toEqual([`${base}/v1/scrape`]); // no second /v2 attempt
  });

  it("is silent when the DEFAULT base is unreachable, but notes an EXPLICIT one", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new Error("ECONNREFUSED");
      }),
    );
    const explicit = await scrapeViaFirecrawl("https://x.test/a", { firecrawl: nextBase() });
    expect(explicit.data).toBeUndefined();
    expect(explicit.why).toMatch(/not reachable/i);

    process.env.ULTRASEARCH_FIRECRAWL = ""; // unset ⇒ the localhost default
    const dflt = await scrapeViaFirecrawl("https://x.test/a");
    process.env.ULTRASEARCH_FIRECRAWL = "off";
    expect(dflt).toEqual({}); // no data AND no note — a missing default is normal
  });

  it("returns nothing (and never throws) when Firecrawl is disabled", async () => {
    const spy = installFetchMock(() => ({ body: "{}" }));
    expect(await scrapeViaFirecrawl("https://x.test/a", { firecrawl: "off" })).toEqual({});
    expect(spy).not.toHaveBeenCalled();
  });

  it("reports the reason when a reachable instance errors or returns no markdown", async () => {
    const bad = nextBase();
    installFetchMock((url) => (url.includes("/scrape") ? { status: 500, body: "boom" } : { body: "ok" }));
    expect((await scrapeViaFirecrawl("https://x.test/a", { firecrawl: bad })).why).toMatch(/status 500/);

    const empty = nextBase();
    installFetchMock((url) =>
      url.includes("/scrape") ? { body: JSON.stringify({ success: true, data: { markdown: "" } }), contentType: "application/json" } : { body: "ok" },
    );
    expect((await scrapeViaFirecrawl("https://x.test/a", { firecrawl: empty })).why).toMatch(/no markdown/i);
  });

  it("sends a bearer only when ULTRASEARCH_FIRECRAWL_KEY is set", async () => {
    const base = nextBase();
    const spy = installFetchMock((url) =>
      url.includes("/scrape") ? { body: JSON.stringify(SCRAPE_FIXTURE), contentType: "application/json" } : { body: "ok" },
    );
    await scrapeViaFirecrawl("https://x.test/a", { firecrawl: base });
    const noKey = spy.mock.calls.find((c) => String(c[0]).includes("/scrape"))!;
    expect((noKey[1] as RequestInit).headers).not.toHaveProperty("authorization");

    process.env.ULTRASEARCH_FIRECRAWL_KEY = "sk-test";
    try {
      await scrapeViaFirecrawl("https://x.test/b", { firecrawl: base });
      const withKey = spy.mock.calls.filter((c) => String(c[0]).includes("/scrape")).pop()!;
      expect((withKey[1] as RequestInit).headers).toMatchObject({ authorization: "Bearer sk-test" });
    } finally {
      delete process.env.ULTRASEARCH_FIRECRAWL_KEY;
    }
  });
});

describe("fetchAndExtract — the extraction seam", () => {
  const PAGE = `<html><head><title>Native</title></head><body><article><p>${"Built-in reader prose about token buckets. ".repeat(6)}</p></article></body></html>`;

  it("prefers Firecrawl for HTML and marks the extractor", async () => {
    const base = nextBase();
    installFetchMock((url) => {
      if (url.includes("/scrape")) return { body: JSON.stringify(SCRAPE_FIXTURE), contentType: "application/json" };
      if (url.includes("expressjs.com")) return { body: PAGE };
      return { body: "ok" };
    });
    const r = await fetchAndExtract("https://expressjs.com/en/guide/migrating-5.html", { firecrawl: base });
    expect(r.extractor).toBe("firecrawl");
    expect(r.text).toContain("Express 5 removes");
    expect(r.title).toBe("Upgrade to Express v5");
    expect(r.status).toBe(200);
  });

  it("falls back to the built-in reader when Firecrawl is down — same result as before", async () => {
    const base = nextBase();
    installFetchMock((url) => {
      if (url === `${base}/`) throw new Error("ECONNREFUSED");
      return { body: PAGE };
    });
    const r = await fetchAndExtract("https://ex.test/page", { firecrawl: base });
    expect(r.extractor).toBeUndefined();
    expect(r.text).toContain("Built-in reader prose");
    expect(r.title).toBe("Native");
    expect(r.note).toMatch(/not reachable/i); // explicit base ⇒ one honest note
  });

  it("falls back to the built-in reader when a reachable Firecrawl fails the page", async () => {
    const base = nextBase();
    installFetchMock((url) => (url.includes("/scrape") ? { status: 502, body: "bad gateway" } : { body: PAGE }));
    const r = await fetchAndExtract("https://ex.test/page", { firecrawl: base });
    expect(r.extractor).toBeUndefined();
    expect(r.text).toContain("Built-in reader prose");
    expect(r.note).toMatch(/fell back to the built-in extractor/i);
  });

  it("refuses a Firecrawl 'success' that is really an error page, so the dead-link rescue still fires", async () => {
    const base = nextBase();
    const dead = JSON.stringify({ success: true, data: { markdown: "# 404 Not Found\n\nnothing here", metadata: { statusCode: 404 } } });
    installFetchMock((url) => {
      if (url.includes("/scrape")) return { body: dead, contentType: "application/json" };
      if (url === `${base}/`) return { status: 200, body: "{}" };
      return { status: 404, body: "gone" };
    });
    const r = await fetchAndExtract("https://ex.test/gone", { firecrawl: base });
    expect(r.extractor).toBeUndefined();
    expect(r.status).toBe(404); // the REAL status, so gather can try the Wayback Machine
    expect(r.text).toBe("");
  });

  // A PDF must not take the HTML path (browser-render the URL, then treat the
  // markdown as the page). It reaches Firecrawl only as a rung of the PDF
  // ladder, after the bytes have been fetched and a stronger extractor failed.
  it("never sends a PDF down the HTML Firecrawl path", async () => {
    const base = nextBase();
    const spy = installFetchMock(() => ({ body: "%PDF-1.4", contentType: "application/pdf" }));
    await fetchAndExtract("https://ex.test/paper.pdf", { firecrawl: base });
    expect(spy.mock.calls.some((c) => String(c[0]).includes("/scrape"))).toBe(false);
  });

  it("uses Firecrawl as a PDF ladder rung when it is the enabled extractor", async () => {
    const base = nextBase();
    vi.stubEnv("ULTRASEARCH_PDF_ENGINE", "firecrawl"); // tests/setup.ts pins it to "native"
    const markdown = "# Paper\n\nA clean paragraph of extracted prose from the PDF.";
    const spy = installFetchMock((url) =>
      url.includes("/scrape")
        ? {
            body: JSON.stringify({ success: true, data: { markdown, metadata: { statusCode: 200, sourceURL: "https://ex.test/paper.pdf" } } }),
            contentType: "application/json",
          }
        : { body: "%PDF-1.4 no text operators here", contentType: "application/pdf" },
    );
    const r = await fetchAndExtract("https://ex.test/paper.pdf", { firecrawl: base });
    expect(spy.mock.calls.some((c) => String(c[0]).includes("/scrape"))).toBe(true);
    expect(r.text).toContain("clean paragraph");
    expect(r.extractor).toBe("firecrawl");
  });
});

describe("firecrawlBackend", () => {
  it("maps /search hits into ranked sources", async () => {
    const base = nextBase();
    const body = JSON.stringify({
      success: true,
      data: {
        web: [
          { url: "https://a.test/1", title: "First", description: "first snippet" },
          { url: "https://b.test/2", title: "Second", description: "second snippet" },
        ],
      },
    });
    const spy = installFetchMock((url) => (url.includes("/search") ? { body, contentType: "application/json" } : { body: "ok" }));
    const r = await firecrawlBackend(makeCtx("rate limiting", { firecrawl: base }));
    expect(r.items).toHaveLength(2);
    expect(r.items[0]!.url).toBe("https://a.test/1");
    expect(r.items[0]!.backend).toBe("firecrawl");
    expect(r.items[0]!.score).toBeGreaterThan(r.items[1]!.score);
    expect(r.notes.join(" ")).toMatch(/returned 2 result/);
    const call = spy.mock.calls.find((c) => String(c[0]).includes("/search"))!;
    expect(JSON.parse((call[1] as RequestInit).body as string)).toMatchObject({ query: "rate limiting", sources: ["web"] });
  });

  it("skips with a note when the instance is unreachable", async () => {
    const base = nextBase();
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new Error("ECONNREFUSED");
      }),
    );
    const r = await firecrawlBackend(makeCtx("x", { firecrawl: base }));
    expect(r.items).toHaveLength(0);
    expect(r.notes.join(" ")).toMatch(/not reachable/i);
  });

  it("skips without calling fetch when disabled", async () => {
    const spy = installFetchMock(() => ({ body: "{}" }));
    const r = await firecrawlBackend(makeCtx("x", { firecrawl: "off" }));
    expect(r.items).toHaveLength(0);
    expect(r.notes.join(" ")).toMatch(/disabled/i);
    expect(spy).not.toHaveBeenCalled();
  });
});
