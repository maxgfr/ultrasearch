import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { runGather } from "../src/gather.js";
import { addSource, addSources } from "../src/enrich.js";
import { makeCtx } from "./ctx.js";

// The wall rescue through the browser rung, with the engine stubbed at the one
// seam every page read goes through (src/cache.js). No browser ever starts: a
// call with `browser: "always"` is answered as the rendered page would be.

const { fetchPage, scrape } = vi.hoisted(() => ({ fetchPage: vi.fn(), scrape: vi.fn() }));
vi.mock("../src/cache.js", async (original) => ({
  ...(await original<typeof import("../src/cache.js")>()),
  cachedFetchAndExtract: fetchPage,
}));
vi.mock("../src/backends/firecrawl.js", async (original) => ({
  ...(await original<typeof import("../src/backends/firecrawl.js")>()),
  scrapeViaFirecrawl: scrape,
}));

const WALL = "Nous utilisons des cookies pour améliorer votre expérience. Accepter tous les cookies. Paramétrer les cookies.";
const ARTICLE = "Rate limiting caps how many requests a client may make in a window, with token buckets and leaky buckets. ".repeat(12);

type Opts = { browser?: string };
function page(rendered: string | undefined, plain = WALL) {
  return async (url: string, opts: Opts = {}) =>
    opts.browser === "always"
      ? rendered === undefined
        ? { text: plain, finalUrl: url, status: 200, note: `The browser could not read ${url} (no browser); read without it.` }
        : { text: rendered, title: "Rendered", finalUrl: url, status: 200, extractor: "browser" }
      : { text: plain, title: "Cookies", finalUrl: url, status: 200 };
}

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "us-browser-rescue-"));
  fetchPage.mockReset();
  scrape.mockReset();
  scrape.mockResolvedValue({ why: "Firecrawl is not running" });
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const lane = (browser: "fallback" | "always" | "off") =>
  makeCtx("rate limiting", {
    backends: ["claude"],
    webResults: [{ url: "https://news.test/article", title: "Rate limiting explained", snippet: "Rate limiting, in short." }],
    out: dir,
    browser,
  }).options;

describe("gather — the browser wall rescue", () => {
  it("re-reads a consent wall in a real browser when Firecrawl cannot, and folds it in", async () => {
    fetchPage.mockImplementation(page(ARTICLE));
    const r = await runGather(lane("fallback"));
    expect(r.sources).toHaveLength(1);
    expect(r.sources[0]!.fullText).not.toBe(false);
    // The first read carries the resolved mode explicitly; the rescue asks for the browser.
    expect(fetchPage.mock.calls[0]![1]).toMatchObject({ browser: "fallback" });
    expect(fetchPage.mock.calls.some((c) => c[1]?.browser === "always")).toBe(true);
    expect(r.manifest.services?.browser).toEqual({ mode: "fallback", pages: 1 });
    const notes = r.manifest.notes.join("\n");
    expect(notes).toContain("Recovered https://news.test/article in a real browser");
    expect(notes).toContain("Rendered 1 page(s) in a real browser");
    expect(notes).toContain("browser ✓ 1 page(s)");
  });

  it("keeps only the snippet when the browser read is still a wall", async () => {
    fetchPage.mockImplementation(page(WALL));
    const r = await runGather(lane("fallback"));
    expect(r.sources[0]?.fullText).toBe(false);
    expect(r.manifest.services?.browser).toEqual({ mode: "fallback", pages: 0 });
    expect(r.manifest.notes.join("\n")).toContain("kept as snippet only");
  });

  it("never launches a browser when the rung is off", async () => {
    fetchPage.mockImplementation(page(ARTICLE));
    const r = await runGather(lane("off"));
    expect(fetchPage.mock.calls.every((c) => c[1]?.browser === "off")).toBe(true);
    expect(r.manifest.services?.browser).toBeUndefined();
    expect(r.sources[0]?.fullText).toBe(false);
  });

  it("does not ask the browser again when Firecrawl already got past the wall", async () => {
    fetchPage.mockImplementation(page(ARTICLE));
    scrape.mockResolvedValue({ data: { markdown: ARTICLE, title: "FC", statusCode: 200 } });
    const r = await runGather(lane("fallback"));
    expect(fetchPage.mock.calls.some((c) => c[1]?.browser === "always")).toBe(false);
    expect(r.manifest.services?.firecrawl.pages).toBe(1);
  });

  it("does not re-render a page the browser already read", async () => {
    fetchPage.mockImplementation(async (url: string) => ({ text: WALL, finalUrl: url, status: 200, extractor: "browser" }));
    await runGather(lane("always"));
    expect(fetchPage.mock.calls.some((c) => c[1]?.browser === "always")).toBe(true); // the read itself
    expect(fetchPage).toHaveBeenCalledTimes(1); // …and no second, rescue read
  });

  it("renders an EMPTY page the engine's own fallback skips (a 402 paywall gate)", async () => {
    fetchPage.mockImplementation(async (url: string, opts: Opts = {}) =>
      opts.browser === "always"
        ? { text: ARTICLE, title: "Rendered", finalUrl: url, status: 200, extractor: "browser" }
        : { text: "", finalUrl: url, status: 402, note: `Could not fetch ${url} (status 402).` },
    );
    const r = await runGather(lane("fallback"));
    expect(r.sources[0]?.fullText).not.toBe(false);
    expect(r.manifest.services?.browser?.pages).toBe(1);
    expect(r.manifest.notes.join("\n")).toContain("Recovered https://news.test/article in a real browser");
  });

  it.each([404, 410, 403, 503])("does not re-render an empty %i (gone, or already rendered by the engine)", async (status) => {
    fetchPage.mockImplementation(async (url: string) => ({ text: "", finalUrl: url, status }));
    vi.stubEnv("ULTRASEARCH_NO_WAYBACK", "1");
    await runGather(lane("fallback"));
    vi.unstubAllEnvs();
    expect(fetchPage.mock.calls.some((c) => c[1]?.browser === "always")).toBe(false);
  });

  it("names the browser rung as the keyless alternative when max ran without the stack", async () => {
    fetchPage.mockImplementation(page(ARTICLE));
    // Pinned to the lane, so `max` reaches no network backend in a test.
    const r = await runGather({ ...lane("off"), search: "max" });
    const notes = r.manifest.notes.join("\n");
    expect(notes).toMatch(/max-minus-the-stack/);
    expect(notes).toMatch(/browser rung/i);
  });
});

describe("ingest / fetch — the browser wall rescue", () => {
  async function dossier(): Promise<void> {
    await runGather(makeCtx("rate limiting", { backends: ["fixture"], out: dir, browser: "off" }).options);
    fetchPage.mockReset();
  }

  it("adds a walled page once the browser reads past the wall, and says so", async () => {
    await dossier();
    fetchPage.mockImplementation(page(ARTICLE));
    const r = await addSource(dir, "https://walled.test/article", { browser: "fallback" });
    expect(r.added).toBe(true);
    expect(r.note).toContain("Recovered https://walled.test/article in a real browser");
    expect(fetchPage.mock.calls[0]![1]).toMatchObject({ browser: "fallback" });
    expect(fetchPage.mock.calls.some((c) => c[1]?.browser === "always")).toBe(true);
  });

  it("still refuses the wall when the rung is off", async () => {
    await dossier();
    fetchPage.mockImplementation(page(ARTICLE));
    const r = await addSources(dir, ["https://walled.test/article"], { browser: "off" });
    expect(r.added).toBe(0);
    expect(r.results[0]!.note).toMatch(/wall/);
    expect(fetchPage.mock.calls.every((c) => c[1]?.browser === "off")).toBe(true);
  });

  it("adds an empty 402 page once the browser renders it", async () => {
    await dossier();
    fetchPage.mockImplementation(async (url: string, opts: Opts = {}) =>
      opts.browser === "always"
        ? { text: ARTICLE, title: "Rendered", finalUrl: url, status: 200, extractor: "browser" }
        : { text: "", finalUrl: url, status: 402, note: `Could not fetch ${url} (status 402).` },
    );
    const r = await addSource(dir, "https://paywall.test/article", { browser: "fallback" });
    expect(r.added).toBe(true);
    expect(r.note).toContain("in a real browser");
  });

  it("refuses when the browser cannot be had either", async () => {
    await dossier();
    fetchPage.mockImplementation(page(undefined));
    const r = await addSource(dir, "https://walled.test/article", { browser: "fallback" });
    expect(r.added).toBe(false);
    expect(r.note).toMatch(/wall/);
  });
});
