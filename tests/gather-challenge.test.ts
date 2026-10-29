import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { runGather } from "../src/gather.js";
import { makeCtx } from "./ctx.js";

// A research run stored fda.gov's abuse-detection apology (a 404 its browser-like
// UA was redirected to) and Apple's /forums/verify-human/ page as sources, under
// those challenge URLs, flagged only off-topic — while `ingest` refused the same
// fda.gov read. The engine is stubbed at the one seam every page read goes
// through (src/cache.js), so each case is the engine's answer as it came back.

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

const PAGE = "https://developer.apple.com/forums/thread/731403";
const VERIFY = "https://developer.apple.com/forums/verify-human/verify.html?next=/forums/thread/731403";
const APPLE_TEXT =
  "# Security verification in progress. Please wait while we verify your browser to protect against automated access.\n" +
  "## Verifying connection...\nVerification Successful. Redirecting...\n## Invalid connection";

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "us-gather-challenge-"));
  fetchPage.mockReset();
  scrape.mockReset();
  scrape.mockResolvedValue({ why: "Firecrawl is not running" });
  wayback.mockReset();
  wayback.mockResolvedValue(undefined);
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const lane = (url: string) =>
  makeCtx("rate limiting", {
    backends: ["host"],
    webResults: [{ url, title: "Rate limiting on the forums", snippet: "Rate limiting, in short." }],
    out: dir,
    browser: "off",
  }).options;

describe("gather — a read parked on an anti-bot challenge", () => {
  it("keeps the page's own URL, records a wall, and never cites the challenge's text", async () => {
    // What an engine without challenge handling hands back: Apple's 200 and its text.
    fetchPage.mockImplementation(async () => ({ text: APPLE_TEXT, title: "Security Verification", finalUrl: VERIFY, status: 200 }));
    const r = await runGather(lane(PAGE));
    const s = r.sources[0]!;
    expect(s.url).toBe(PAGE);
    expect(s.wall).toBe(true);
    expect(s.fullText).toBe(false);
    expect(r.manifest.notes.join("\n")).toMatch(/redirected to an anti-bot challenge/);
  });

  it("treats the engine's empty challenge answer the same way", async () => {
    fetchPage.mockImplementation(async (url: string) => ({
      text: "",
      finalUrl: VERIFY,
      status: 200,
      note: `Could not read ${url}: it was redirected to an anti-bot challenge (${VERIFY}).`,
    }));
    const r = await runGather(lane(PAGE));
    expect(r.sources[0]!.url).toBe(PAGE);
    expect(r.sources[0]!.wall).toBe(true);
  });

  it("asks the archive for the page, not for the challenge, and refuses an archived wall", async () => {
    const apology = "https://www.fda.gov/apology_objects/abuse-detection-apology.html";
    const page = "https://www.fda.gov/food/food-labeling-nutrition";
    fetchPage.mockImplementation(async () => ({ text: "", finalUrl: apology, status: 404 }));
    wayback.mockResolvedValue({ text: "Sorry. Your request was flagged by our abuse detection.", snapshotUrl: "https://web.archive.org/x", timestamp: "2024" });
    const r = await runGather(lane(page));
    expect(wayback).toHaveBeenCalledWith(page, expect.anything());
    expect(r.sources[0]!.url).toBe(page);
    expect(r.sources[0]!.fullText).toBe(false);
    expect(r.sources[0]!.meta?.waybackSnapshot).toBeUndefined();
  });
});

describe("gather — a failed read's last hop is not the document's address", () => {
  it("keeps the URL it asked for when the redirect ended on a 404", async () => {
    fetchPage.mockImplementation(async () => ({ text: "", finalUrl: "https://site.test/errors/missing", status: 404 }));
    const r = await runGather(lane("https://site.test/guide/rate-limits"));
    expect(r.sources[0]!.url).toBe("https://site.test/guide/rate-limits");
    expect(wayback).toHaveBeenCalledWith("https://site.test/guide/rate-limits", expect.anything());
  });

  it("still follows a redirect that answered", async () => {
    const article = "Rate limiting caps how many requests a client may make in a window, with token buckets and leaky buckets. ".repeat(12);
    fetchPage.mockImplementation(async () => ({ text: article, finalUrl: "https://site.test/v2/guide/rate-limits", status: 200 }));
    const r = await runGather(lane("https://site.test/guide/rate-limits"));
    expect(r.sources[0]!.url).toBe("https://site.test/v2/guide/rate-limits");
    expect(r.sources[0]!.fullText).not.toBe(false);
  });
});
