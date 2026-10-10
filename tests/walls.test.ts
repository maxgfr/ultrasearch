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

  // Audit: a banner or a Disqus line above real paragraphs threw the page away.
  const PARAS = [
    "Scleral fixation restores useful vision when the capsular bag can no longer hold a posterior chamber lens.",
    "Forty-one eyes were followed for four years after Carlevale implantation with two scleral pockets.",
    "Exteriorised haptics remained covered by conjunctiva in most eyes, and no endophthalmitis was recorded.",
  ].join("\n");
  it("lets real prose outweigh a banner, a JavaScript line or a cookie notice above it", () => {
    expect(wallPattern(`We value your privacy. Accept all cookies or manage your settings.\n${PARAS}`)).toBeUndefined();
    expect(wallPattern(`Please enable JavaScript to view the comments powered by Disqus.\n${PARAS}`)).toBeUndefined();
    expect(wallPattern(`Cookies must be enabled to post a comment.\n${PARAS}`)).toBeUndefined();
    expect(looksLikeWall(`Please enable JavaScript to view the comments powered by Disqus.\n${PARAS}`)).toBeUndefined();
  });

  it("does not take an article about cookie walls for one", () => {
    const article = [
      "Publishers across Europe now greet readers with a banner that says we use cookies and offers to accept all cookies.",
      "Regulators in France ruled that such banners must make refusing as easy as accepting, with a reject button on the first layer.",
      "A 2023 survey of 1,000 news sites found that most banners still nudged readers towards the accept button by colour and size.",
      "Researchers measured consent rates falling from 90 % to 50 % once the reject option was shown with equal weight beside it.",
      "The study concludes that design, not reader preference, drove the high consent rates recorded before the ruling took effect.",
    ].join("\n\n");
    expect(article.length).toBeLessThan(2000);
    expect(looksLikeWall(article)).toBeUndefined();
  });

  it("still catches walls whose long lines address the reader", () => {
    const tcf = [
      "We value your privacy",
      "We and our 842 partners store and access information on your device, such as cookies, and process personal data such as unique identifiers.",
      "With your permission we and our partners may use precise geolocation data and identification through device scanning.",
      "You can click to consent to our processing as described above, or access more detailed information and change your preferences.",
      "Accept all",
      "Manage options",
    ].join("\n");
    expect(wallPattern(tcf)).toBe("cookie/consent wall");
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
