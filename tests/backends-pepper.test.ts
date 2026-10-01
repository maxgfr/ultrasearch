import "./_polite0.js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { PEPPER_SITES, parsePepperThreads, parsePepperVouchers, pepperBackend, pepperSiteFor, sliceJsonObject } from "../src/backends/pepper.js";
import { resetHostSchedule } from "../src/engine.js";
import { installFetchMock } from "./fetchmock.js";
import { makeCtx } from "./ctx.js";

const here = dirname(fileURLToPath(import.meta.url));
const page = (name: string) => readFileSync(join(here, "fixtures", "pages", name), "utf8");
const SEARCH = page("dealabs-search.html");
const VOUCHERS = page("dealabs-vouchers.html");

beforeEach(() => resetHostSchedule());
afterEach(() => vi.unstubAllGlobals());

describe("pepperSiteFor", () => {
  it("resolves the country from --region, then the language's region subtag, then the language", () => {
    expect(pepperSiteFor("fr")?.site.host).toBe("www.dealabs.com");
    expect(pepperSiteFor("en-GB")?.site.host).toBe("www.hotukdeals.com");
    expect(pepperSiteFor("en", "uk")?.site.host).toBe("www.hotukdeals.com");
    expect(pepperSiteFor("de", "AT")?.site.host).toBe("www.preisjaeger.at");
  });
  it("has no site for a country outside the network", () => {
    expect(pepperSiteFor("en", "us")).toBeUndefined();
    expect(pepperSiteFor("en")).toBeUndefined();
    expect(pepperSiteFor("it")).toBeUndefined(); // pepper.it closed in 2025
  });
  it("only lists https hosts and paths with their placeholder", () => {
    for (const s of Object.values(PEPPER_SITES)) {
      expect(s.search).toContain("{q}");
      if (s.vouchers) expect(s.vouchers).toContain("{slug}");
    }
  });
});

describe("parsePepperThreads (saved Dealabs capture)", () => {
  const threads = parsePepperThreads(SEARCH, "www.dealabs.com");

  it("reads every thread card's JSON", () => {
    expect(threads.length).toBe(3);
    const app5 = threads.find((t) => t.code === "APP5")!;
    expect(app5).toMatchObject({ id: "3422668", merchant: "Decathlon", merchantSlug: "decathlon", expired: false, freeShipping: true });
    expect(app5.published).toMatch(/^2026-/);
  });

  it("cites each thread's own page — never an affiliate /visit/ link", () => {
    for (const t of threads) {
      expect(t.url).toMatch(/^https:\/\/www\.dealabs\.com\/bons-plans\/.+-\d+$/);
      expect(t.url).not.toContain("/visit/");
    }
    expect(SEARCH).toContain("/visit/"); // the fixture does carry them
  });

  it("carries the card's description as text", () => {
    expect(threads.some((t) => (t.description ?? "").length > 40)).toBe(true);
  });

  it("falls back to a regex window when no blob parses", () => {
    // Break every attribute's JSON (truncate it) — the field text survives.
    const broken = SEARCH.replace(/data-vue3='\{/g, "data-vue3='{,");
    const got = parsePepperThreads(broken, "www.dealabs.com");
    expect(got.map((t) => t.id).sort()).toEqual(threads.map((t) => t.id).sort());
    expect(got.find((t) => t.id === "3422668")?.code).toBe("APP5");
  });

  it("reads a thread from a JSON <script> block and __INITIAL_STATE__ too", () => {
    const thread = { threadId: 42, title: "Code &amp; promo", voucherCode: "SCRIPT10", isExpired: true, endDate: { timestamp: 1790000000 } };
    const viaScript = parsePepperThreads(`<script type="application/json">${JSON.stringify({ a: [{ thread }] })}</script>`, "x.test");
    expect(viaScript[0]).toMatchObject({ id: "42", code: "SCRIPT10", expired: true, url: "https://x.test/share-deal/42", title: "Code & promo" });
    expect(viaScript[0]!.expires).toMatch(/^2026-09-/);
    const viaState = parsePepperThreads(`<script>window.__INITIAL_STATE__ = ${JSON.stringify({ t: thread })};</script>`, "x.test");
    expect(viaState[0]!.code).toBe("SCRIPT10");
  });
});

describe("parsePepperVouchers (saved Dealabs voucher page)", () => {
  it("reads active and expired offers from the Next.js payload", () => {
    const v = parsePepperVouchers(VOUCHERS);
    expect(v.map((x) => [x.code, x.expired])).toEqual([
      ["APP5", false],
      ["HIVER", true],
    ]);
    expect(v[0]).toMatchObject({ expires: "2026-10-21", discount: "5%" });
    expect(v[0]!.terms).toContain("Dépense minimale de 100€");
  });

  it("sliceJsonObject respects braces inside strings", () => {
    const s = 'x {"a":"}{","b":{"c":1}} y';
    expect(sliceJsonObject(s, 2)).toBe('{"a":"}{","b":{"c":1}}');
    expect(sliceJsonObject("{unterminated", 0)).toBeUndefined();
  });
});

describe("pepper backend", () => {
  it("fr: searches Dealabs by merchant and returns structured codes", async () => {
    const spy = installFetchMock((url) => (url.includes("dealabs.com/search") ? { body: SEARCH } : undefined));
    const r = await pepperBackend(makeCtx("code promo decathlon.fr", { lang: "fr", region: "fr" }));
    expect(spy).toHaveBeenCalledTimes(1);
    expect(String(spy.mock.calls[0]![0])).toBe("https://www.dealabs.com/search?q=decathlon");
    expect(r.items).toHaveLength(3);
    const app5 = r.items.find((i) => i.meta?.codes?.length)!;
    expect(app5.backend).toBe("pepper");
    expect(app5.meta!.codes![0]).toMatchObject({ code: "APP5", via: "structured", strength: "strong" });
    expect(app5.text).toContain("Code: APP5");
    expect(r.items.every((i) => !i.url.includes("/visit/"))).toBe(true);
    expect(r.notes[0]).toMatch(/www\.dealabs\.com: 3 thread\(s\) about "decathlon", 1 carrying a voucher code/);
  });

  it("drops threads about another merchant", async () => {
    installFetchMock(() => ({ body: SEARCH }));
    const r = await pepperBackend(makeCtx("code promo nike", { lang: "fr", region: "fr" }));
    expect(r.items).toEqual([]);
    expect(r.notes[0]).toContain("3 about other merchants dropped");
  });

  it.each([
    ["en-GB", undefined, "www.hotukdeals.com"],
    ["en", "uk", "www.hotukdeals.com"],
  ])("lang %s / region %s → %s", async (lang, region, host) => {
    const spy = installFetchMock(() => ({ body: SEARCH }));
    await pepperBackend(makeCtx("argos voucher code", { lang, region }));
    expect(String(spy.mock.calls[0]![0])).toBe(`https://${host}/search?q=argos`);
  });

  it("us: makes no request and says which countries are covered", async () => {
    const spy = installFetchMock(() => ({ body: SEARCH }));
    const r = await pepperBackend(makeCtx("target promo code", { lang: "en", region: "us" }));
    expect(spy).not.toHaveBeenCalled();
    expect(r.items).toEqual([]);
    expect(r.notes[0]).toMatch(/no deal community for region "us"/);
  });

  it("deep: adds the merchant's voucher page, by Pepper's own slug, ahead of the threads", async () => {
    const urls: string[] = [];
    installFetchMock((url) => {
      urls.push(url);
      if (url.includes("/search")) return { body: SEARCH };
      if (url.includes("/codes-promo/")) return { body: VOUCHERS };
      return undefined;
    });
    const r = await pepperBackend(makeCtx("code promo decathlon.fr", { lang: "fr", region: "fr", depth: "deep" }));
    expect(urls).toEqual(["https://www.dealabs.com/search?q=decathlon", "https://www.dealabs.com/codes-promo/decathlon"]);
    const vp = r.items[0]!;
    expect(vp.url).toBe("https://www.dealabs.com/codes-promo/decathlon");
    expect(vp.meta!.codes!.map((c) => [c.code, !!c.expired])).toEqual([
      ["APP5", false],
      ["HIVER", true],
    ]);
    expect(vp.text).toContain("Terms: Bénéficiez de 5€ de remise");
    expect(r.notes.at(-1)).toBe("www.dealabs.com voucher page: 2 code(s) (1 expired).");
  });

  it("a throttled search becomes a note with the WebSearch fallback", async () => {
    installFetchMock(() => ({ status: 429, body: "" }));
    const r = await pepperBackend(makeCtx("decathlon", { lang: "fr" }));
    expect(r.items).toEqual([]);
    expect(r.notes[0]).toBe("www.dealabs.com search rate-limited (HTTP 429). Search it with your own WebSearch instead — `site:dealabs.com decathlon`.");
  });

  it("names a challenge page for what it is", async () => {
    installFetchMock(() => ({
      body: "<html><head><title>Just a moment...</title></head><body>Checking your browser before accessing. Please enable JavaScript and cookies to continue.</body></html>",
    }));
    const r = await pepperBackend(makeCtx("decathlon", { lang: "fr" }));
    expect(r.items).toEqual([]);
    expect(r.notes[0]).toMatch(/served a .+ instead of results/);
  });

  it("flags markup drift when a real page yields no thread", async () => {
    installFetchMock(() => ({
      body: `<html><body><main>${"<p>Bons plans du jour, mais sous une forme que le parseur ne connaît pas.</p>".repeat(30)}</main></body></html>`,
    }));
    const r = await pepperBackend(makeCtx("decathlon", { lang: "fr" }));
    expect(r.notes[0]).toMatch(/0 parsable threads — markup changed\?/);
  });
});
