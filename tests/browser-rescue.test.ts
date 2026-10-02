import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { runGather } from "../src/gather.js";
import { addSource, addSources } from "../src/enrich.js";
import { BROWSER_RESCUE_CAP } from "../src/browser.js";
import { makeCtx } from "./ctx.js";

// The browser rung's rescue, with the engine stubbed at the one seam every page
// read goes through (src/cache.js). No browser ever starts: a call with
// `browser: "always"` is answered as the rendered page would be.
//
// The contract: a WALLED page is the engine's own fallback's job — it renders it
// during the read — so ultrasearch never renders it a second time. What the
// engine skips is an EMPTY 402 (a paywall gate, Le Monde's answer to a plain
// fetch); that is the one read the rescue renders, once per page per run, capped.

const { fetchPage, scrape, wayback } = vi.hoisted(() => ({ fetchPage: vi.fn(), scrape: vi.fn(), wayback: vi.fn() }));
vi.mock("../src/cache.js", async (original) => ({
  ...(await original<typeof import("../src/cache.js")>()),
  cachedFetchAndExtract: fetchPage,
}));
vi.mock("../src/backends/firecrawl.js", async (original) => ({
  ...(await original<typeof import("../src/backends/firecrawl.js")>()),
  scrapeViaFirecrawl: scrape,
}));
vi.mock("../src/backends/fetch.js", async (original) => ({
  ...(await original<typeof import("../src/backends/fetch.js")>()),
  rescueViaWayback: wayback,
}));

const WALL = "Nous utilisons des cookies pour améliorer votre expérience. Accepter tous les cookies. Paramétrer les cookies.";
const ARTICLE = "Rate limiting caps how many requests a client may make in a window, with token buckets and leaky buckets. ".repeat(12);

type Opts = { browser?: string };
/** A host that walls the plain read; `rendered` is what the browser would read. */
function walled(rendered: string) {
  return async (url: string, opts: Opts = {}) =>
    opts.browser === "always"
      ? { text: rendered, title: "Rendered", finalUrl: url, status: 200, extractor: "browser" }
      : { text: WALL, title: "Cookies", finalUrl: url, status: 200 };
}
/** A host that answers a plain read with an empty `status`; the browser gets the article, or fails. */
function empty(status: number, browserOk = true) {
  return async (url: string, opts: Opts = {}) =>
    opts.browser === "always"
      ? browserOk
        ? { text: ARTICLE, title: "Rendered", finalUrl: url, status: 200, extractor: "browser" }
        : {
            text: "",
            finalUrl: url,
            status,
            note: `The browser got HTTP 403 for ${url}; read without it. cloudflare challenge — let the human solve it Could not fetch ${url} (status ${status}).`,
          }
      : { text: "", finalUrl: url, status, note: `Could not fetch ${url} (status ${status}).` };
}
const renders = () => fetchPage.mock.calls.filter((c) => c[1]?.browser === "always").length;

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "us-browser-rescue-"));
  fetchPage.mockReset();
  scrape.mockReset();
  scrape.mockResolvedValue({ why: "Firecrawl is not running" });
  wayback.mockReset();
  wayback.mockResolvedValue(undefined);
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const lane = (browser: "fallback" | "always" | "off", urls = ["https://news.test/article"]) =>
  makeCtx("rate limiting", {
    backends: ["claude"],
    webResults: urls.map((url) => ({ url, title: "Rate limiting explained", snippet: "Rate limiting, in short." })),
    out: dir,
    browser,
  }).options;

describe("gather — walls are the engine's fallback's job", () => {
  it("passes the resolved mode to the read, and never renders a walled page a second time", async () => {
    fetchPage.mockImplementation(walled(ARTICLE));
    const r = await runGather(lane("fallback"));
    expect(fetchPage.mock.calls[0]![1]).toMatchObject({ browser: "fallback" });
    expect(renders()).toBe(0);
    expect(r.sources[0]?.fullText).toBe(false);
    expect(r.manifest.services?.browser).toEqual({ mode: "fallback", pages: 0 });
  });

  it("counts a page the engine's fallback rendered", async () => {
    fetchPage.mockImplementation(async (url: string) => ({ text: ARTICLE, finalUrl: url, status: 200, extractor: "browser" }));
    const r = await runGather(lane("fallback"));
    expect(r.manifest.services?.browser).toEqual({ mode: "fallback", pages: 1 });
    expect(r.manifest.notes.join("\n")).toContain("Rendered 1 page(s) in a real browser");
    expect(r.manifest.notes.join("\n")).toContain("browser ✓ 1 page(s)");
  });

  it("never launches a browser when the rung is off", async () => {
    fetchPage.mockImplementation(empty(402));
    const r = await runGather(lane("off"));
    expect(fetchPage.mock.calls.every((c) => c[1]?.browser === "off")).toBe(true);
    expect(r.manifest.services?.browser).toBeUndefined();
  });

  it("names the browser rung as the keyless alternative when max ran without the stack", async () => {
    fetchPage.mockImplementation(walled(ARTICLE));
    // Pinned to the lane, so `max` reaches no network backend in a test.
    const r = await runGather({ ...lane("off"), search: "max" });
    const notes = r.manifest.notes.join("\n");
    expect(notes).toMatch(/max-minus-the-stack/);
    expect(notes).toMatch(/browser rung/i);
  });
});

describe("gather — the empty-read rescue", () => {
  it("renders an EMPTY 402 the engine's fallback skips, and folds it in", async () => {
    fetchPage.mockImplementation(empty(402));
    const r = await runGather(lane("fallback"));
    expect(renders()).toBe(1);
    expect(r.sources[0]?.fullText).not.toBe(false);
    expect(r.manifest.services?.browser?.pages).toBe(1);
    expect(r.manifest.notes.join("\n")).toContain("Recovered https://news.test/article in a real browser");
  });

  it.each([404, 410, 403, 503, 500, 400])("does not render an empty %i", async (status) => {
    fetchPage.mockImplementation(empty(status));
    await runGather(lane("fallback"));
    expect(renders()).toBe(0);
  });

  it("does not render in `always` — the engine already did, first", async () => {
    fetchPage.mockImplementation(empty(402));
    await runGather(lane("always"));
    expect(fetchPage).toHaveBeenCalledTimes(1);
  });

  it(`caps the renders at ${BROWSER_RESCUE_CAP} per run`, async () => {
    fetchPage.mockImplementation(empty(402, false));
    const urls = Array.from({ length: BROWSER_RESCUE_CAP + 4 }, (_, i) => `https://paywall${i}.test/a`);
    await runGather(lane("fallback", urls));
    expect(renders()).toBe(BROWSER_RESCUE_CAP);
  });

  it("does not repeat the read's own note when the browser fails too", async () => {
    fetchPage.mockImplementation(empty(402, false));
    const r = await runGather(lane("fallback"));
    const notes = r.manifest.notes.join("\n");
    expect(notes.split("Could not fetch https://news.test/article").length - 1).toBe(1);
    expect(notes).toContain("challenge");
  });
});

describe("ingest / fetch", () => {
  async function dossier(): Promise<void> {
    await runGather(makeCtx("rate limiting", { backends: ["fixture"], out: dir, browser: "off" }).options);
    fetchPage.mockReset();
  }

  it("refuses a walled page without rendering it a second time", async () => {
    await dossier();
    fetchPage.mockImplementation(walled(ARTICLE));
    const r = await addSource(dir, "https://walled.test/article", { browser: "fallback" });
    expect(r.added).toBe(false);
    expect(r.note).toMatch(/wall/);
    expect(renders()).toBe(0);
  });

  it("still refuses with the rung off, and every read says off", async () => {
    await dossier();
    fetchPage.mockImplementation(empty(402));
    const r = await addSources(dir, ["https://walled.test/article"], { browser: "off" });
    expect(r.added).toBe(0);
    expect(fetchPage.mock.calls.every((c) => c[1]?.browser === "off")).toBe(true);
  });

  it("adds an empty 402 page once the browser renders it, and says so", async () => {
    await dossier();
    fetchPage.mockImplementation(empty(402));
    const r = await addSource(dir, "https://paywall.test/article", { browser: "fallback" });
    expect(r.added).toBe(true);
    expect(r.note).toContain("Recovered https://paywall.test/article in a real browser");
  });

  it("hands the resolved mode to the Wayback rescue too", async () => {
    await dossier();
    fetchPage.mockImplementation(empty(404));
    await addSource(dir, "https://gone.test/article", { browser: "fallback" });
    expect(wayback).toHaveBeenCalledWith("https://gone.test/article", expect.objectContaining({ browser: "fallback" }));
  });
});
