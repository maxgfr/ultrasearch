import { afterEach, describe, expect, it, vi } from "vitest";
import { genericBackend } from "../src/backends/generic.js";
import { acceptLanguageHeader } from "../src/locale.js";
import { type Router, installFetchMock, routes } from "./fetchmock.js";
import { makeCtx } from "./ctx.js";

afterEach(() => vi.unstubAllGlobals());

const page = (body: string) => `<html><head><title>Doc</title></head><body><main>${body}</main></body></html>`;
const LONG = "Rate limiting is a technique for controlling request throughput. ".repeat(20);

// Wrap the fetch mock in an in-flight counter. A mocked response's `delayMs`
// holds the request open, so `peak` is a deterministic statement about how many
// URLs the backend has in the air at once — no wall clock in the assertion, and
// no dependence on how long anything actually took.
function countingFetchMock(router: Router) {
  const inner = installFetchMock(router);
  const state = { inFlight: 0, peak: 0 };
  const spy = vi.fn(async (input: any, init?: RequestInit) => {
    state.inFlight++;
    state.peak = Math.max(state.peak, state.inFlight);
    try {
      return await inner(input, init);
    } finally {
      state.inFlight--;
    }
  });
  vi.stubGlobal("fetch", spy);
  return { spy, state };
}

// generic.ts fetches an explicit --url set into full-text sources. Covers the
// no-url guard, a fetch that fails (note, no item), and rank-ordered scoring.
describe("genericBackend", () => {
  it("notes when no --url was supplied", async () => {
    const r = await genericBackend(makeCtx("q"));
    expect(r.items).toHaveLength(0);
    expect(r.notes.join(" ")).toMatch(/needs --url/i);
  });

  it("fetches each url, records a note for a failed one, and skips it", async () => {
    installFetchMock((url) => {
      if (url.includes("good.test")) return { body: page(LONG), contentType: "text/html" };
      if (url.includes("bad.test")) return { status: 403, body: "" };
      return undefined;
    });
    const r = await genericBackend(makeCtx("rate limiting", { urls: ["https://good.test/a", "https://bad.test/b"] }));
    expect(r.items).toHaveLength(1);
    expect(r.items[0]!.url).toBe("https://good.test/a");
    expect(r.items[0]!.text).toMatch(/rate limiting/i);
    expect(r.notes.join(" ")).toMatch(/could not fetch .*bad\.test/i);
  });

  it("scores urls by their position in the list (first is highest)", async () => {
    installFetchMock((url) => ({ body: page(LONG + url), contentType: "text/html" }));
    const r = await genericBackend(makeCtx("q", { urls: ["https://a.test/1", "https://b.test/2", "https://c.test/3"] }));
    expect(r.items).toHaveLength(3);
    expect(r.items[0]!.score).toBe(3); // urls.length - 0
    expect(r.items[2]!.score).toBe(1); // urls.length - 2
  });

  // The URLs are fetched in parallel, so they finish in whatever order the
  // network hands them back. Everything the caller sees must still be in --url
  // order: these are the regression oracle for that (they passed on the old
  // sequential loop too — that is the point).
  it("keeps items in --url order and scores by original index when fetches finish out of order", async () => {
    const { state } = countingFetchMock(
      routes([
        ["slow.test", { body: page(LONG + " slow"), delayMs: 60 }],
        ["mid.test", { body: page(LONG + " mid"), delayMs: 30 }],
        ["fast.test", { body: page(LONG + " fast"), delayMs: 10 }],
      ]),
    );
    const urls = ["https://slow.test/1", "https://mid.test/2", "https://fast.test/3"];
    const r = await genericBackend(makeCtx("rate limiting", { urls }));
    expect(r.items.map((i) => i.url)).toEqual(urls); // completion order was 3, 2, 1
    expect(r.items.map((i) => i.score)).toEqual([3, 2, 1]);
    expect(state.peak).toBe(3); // …and all three were in flight at once
  });

  it("keeps notes in --url order when a later url fails first", async () => {
    countingFetchMock(
      routes([
        ["bad-a.test", { status: 404, body: "", delayMs: 60 }],
        ["good.test", { body: page(LONG), delayMs: 30 }],
        ["bad-b.test", { status: 404, body: "", delayMs: 10 }],
      ]),
    );
    const urls = ["https://bad-a.test/1", "https://good.test/2", "https://bad-b.test/3"];
    const r = await genericBackend(makeCtx("rate limiting", { urls }));
    expect(r.notes).toHaveLength(2);
    expect(r.notes[0]).toMatch(/bad-a\.test/); // bad-b answered first; the note order is the URL order
    expect(r.notes[1]).toMatch(/bad-b\.test/);
    expect(r.items).toHaveLength(1);
    expect(r.items[0]!.score).toBe(2); // urls.length - 1: the ORIGINAL index, not the kept-item index
  });

  it("honours --concurrency", async () => {
    const { state } = countingFetchMock(() => ({ body: page(LONG), delayMs: 20 }));
    const urls = ["https://a.test/1", "https://b.test/2", "https://c.test/3", "https://d.test/4"];
    const r = await genericBackend(makeCtx("rate limiting", { urls, concurrency: 2 }));
    expect(state.peak).toBe(2);
    expect(r.items.map((i) => i.score)).toEqual([4, 3, 2, 1]);
  });

  it("sends the run's Accept-Language on every fetch", async () => {
    const { spy } = countingFetchMock(() => ({ body: page(LONG) }));
    await genericBackend(makeCtx("rate limiting", { urls: ["https://a.test/1"], lang: "fr" }));
    const headers = (spy.mock.calls[0]![1] as RequestInit).headers as Record<string, string>;
    expect(headers["accept-language"]).toBe(acceptLanguageHeader("fr", undefined));
    expect(headers["accept-language"]).toBe("fr-FR,fr;q=0.9,en;q=0.5");
  });

  it("folds --region into the Accept-Language it sends", async () => {
    const { spy } = countingFetchMock(() => ({ body: page(LONG) }));
    await genericBackend(makeCtx("rate limiting", { urls: ["https://a.test/1"], lang: "fr", region: "be" }));
    const headers = (spy.mock.calls[0]![1] as RequestInit).headers as Record<string, string>;
    expect(headers["accept-language"]).toBe(acceptLanguageHeader("fr", "be"));
    expect(headers["accept-language"]).toBe("fr-BE,fr;q=0.9,en;q=0.5");
  });

  it("reuses the on-disk fetch cache when --cache is set", async () => {
    const { spy } = countingFetchMock(() => ({ body: page(LONG) }));
    const urls = ["https://cached.test/x"];
    const a = await genericBackend(makeCtx("rate limiting", { urls, cache: true }));
    const b = await genericBackend(makeCtx("rate limiting", { urls, cache: true }));
    expect(spy).toHaveBeenCalledTimes(1); // second run served from disk
    expect(b.items[0]!.text).toBe(a.items[0]!.text);
  });
});
