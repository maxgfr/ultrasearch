import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { isWordedWall, looksLikeWall, MIN_USEFUL_CHARS, readPastCachedWall, usefulChars, wallPattern } from "../src/walls.js";
import { cacheMode } from "../src/engine.js";
import { installFetchMock } from "./fetchmock.js";

const PUBMED_WALL = "# Cookies must be enabled.\nEnable cookies for pubmed.ncbi.nlm.nih.gov and reload this page to continue.";
const ARTICLE = `# Scleral fixation\n\n${"Scleral fixation of an intraocular lens restores vision when the capsule cannot support it. ".repeat(5)}`;

describe("wallPattern", () => {
  it("catches PubMed's cookie wall, which the engine rates weak and lets through", () => {
    expect(wallPattern(PUBMED_WALL)).toBe("cookie wall");
  });

  it("keeps the engine's verdict first", () => {
    expect(wallPattern("Checking your browser before accessing example.test.")).toBe("anti-bot interstitial");
  });

  it("catches short consent walls and JavaScript shells", () => {
    expect(wallPattern("We value your privacy. We and our partners store data. Accept to continue, or manage your choices.")).toBe("cookie/consent wall");
    expect(wallPattern("Please enable JavaScript in your browser to continue.")).toMatch(/JavaScript-required shell/);
    expect(wallPattern("You need to enable JavaScript to run this app.")).toBe("JavaScript-required shell");
    expect(wallPattern("Les cookies doivent être activés pour accéder à ce site.")).toBe("cookie wall (fr)");
  });

  it("never fires on a long article that merely discusses cookie walls", () => {
    const essay = `${"Many sites show a banner saying cookies must be enabled before reading; this essay studies them. ".repeat(25)}`;
    expect(essay.length).toBeGreaterThan(2000);
    expect(wallPattern(essay)).toBeUndefined();
  });

  it("is silent on empty text and on real prose", () => {
    expect(wallPattern("   ")).toBeUndefined();
    expect(wallPattern(ARTICLE)).toBeUndefined();
  });
});

describe("looksLikeWall", () => {
  it("adds the near-empty floor under the wording rules", () => {
    expect(looksLikeWall(ARTICLE)).toBeUndefined();
    expect(looksLikeWall("# A title\nOne short line.")).toBe("near-empty page (15 useful characters)");
    expect(looksLikeWall(PUBMED_WALL)).toBe("cookie wall");
  });

  it("does not count headings as prose", () => {
    const headings = Array.from({ length: 30 }, (_, i) => `## Heading number ${i}`).join("\n");
    expect(usefulChars(headings)).toBe(0);
    expect(usefulChars("a  b\n\n c")).toBe(5);
    expect(looksLikeWall(`${headings}\n${"x".repeat(MIN_USEFUL_CHARS)}`)).toBeUndefined();
  });

  it("tells a worded wall from a thin page", () => {
    expect(isWordedWall(looksLikeWall(PUBMED_WALL))).toBe(true);
    expect(isWordedWall(looksLikeWall("tiny"))).toBe(false);
    expect(isWordedWall(undefined)).toBe(false);
  });
});

describe("readPastCachedWall", () => {
  const SETUP_CACHE_DIR = process.env.ULTRASEARCH_CACHE_DIR;
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "us-walls-cache-"));
    process.env.ULTRASEARCH_CACHE_DIR = dir;
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    if (SETUP_CACHE_DIR === undefined) delete process.env.ULTRASEARCH_CACHE_DIR;
    else process.env.ULTRASEARCH_CACHE_DIR = SETUP_CACHE_DIR;
    rmSync(dir, { recursive: true, force: true });
  });

  it("re-reads live when the cache serves a wall, and overwrites the cached copy", async () => {
    let walled = true;
    const spy = installFetchMock(() =>
      walled
        ? { body: "<h1>Cookies must be enabled.</h1><p>Enable cookies for pubmed.ncbi.nlm.nih.gov and reload this page to continue.</p>" }
        : { body: `<article><p>${"The abstract finally came through, every sentence of it. ".repeat(8)}</p></article>` },
    );
    const url = "https://pubmed.ncbi.nlm.nih.gov/34397876/";
    const first = await readPastCachedWall(url, {}, true);
    expect(wallPattern(first.text)).toBe("cookie wall");
    walled = false; // the host stopped throttling
    const second = await readPastCachedWall(url, {}, true);
    expect(second.text).toMatch(/abstract finally came through/);
    expect(cacheMode().refresh).toBe(false); // the bypass never outlives the read
    const third = await readPastCachedWall(url, {}, true);
    expect(third.cached).toBe(true); // the good copy replaced the wall on disk
    expect(spy).toHaveBeenCalledTimes(2); // the first read and the live re-read — never the third
  });

  it("keeps the bypass on until the LAST concurrent read is done", async () => {
    installFetchMock(() => ({ body: "<p>Enable cookies for example.test and reload this page to continue.</p>", delayMs: 5 }));
    const urls = ["https://a.test/1", "https://b.test/2", "https://c.test/3"];
    for (const u of urls) await readPastCachedWall(u, {}, true); // warm the cache with walls
    await Promise.all(urls.map((u) => readPastCachedWall(u, {}, true)));
    expect(cacheMode().refresh).toBe(false);
  });

  it("serves a good cached copy without a second read", async () => {
    const spy = installFetchMock(() => ({ body: `<article><p>${ARTICLE}</p></article>` }));
    await readPastCachedWall("https://ok.test/a", {}, true);
    const again = await readPastCachedWall("https://ok.test/a", {}, true);
    expect(again.cached).toBe(true);
    expect(spy).toHaveBeenCalledTimes(1);
  });
});
