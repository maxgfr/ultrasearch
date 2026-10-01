import "./_polite0.js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { redditBackend, redditWindow } from "../src/backends/reddit.js";
import { resetHostSchedule } from "../src/engine.js";
import { installFetchMock } from "./fetchmock.js";
import { makeCtx } from "./ctx.js";

const here = dirname(fileURLToPath(import.meta.url));
const SEARCH = readFileSync(join(here, "fixtures", "api", "reddit-search.atom"), "utf8");
const ATOM = "application/atom+xml; charset=UTF-8";

// A comment feed: the post itself first, then its comments.
function commentsFeed(threadUrl: string, comments: string[]): string {
  const entry = (url: string, id: string, body: string) =>
    `<entry><content type="html">&lt;div class=&quot;md&quot;&gt;&lt;p&gt;${body}&lt;/p&gt;&lt;/div&gt;</content><id>${id}</id><link href="${url}" /><title>t</title></entry>`;
  return (
    `<?xml version="1.0" encoding="UTF-8"?><feed xmlns="http://www.w3.org/2005/Atom"><title>thread</title>` +
    entry(threadUrl, "t3_x", "the post") +
    comments.map((c, i) => entry(`${threadUrl}c${i}/`, `t1_${i}`, c)).join("") +
    `</feed>`
  );
}

beforeEach(() => resetHostSchedule());
afterEach(() => vi.unstubAllGlobals());

describe("redditWindow", () => {
  const now = Date.parse("2026-10-01T00:00:00Z");
  it("maps --since onto the smallest reddit window covering it", () => {
    expect(redditWindow(undefined, now)).toBe("all");
    expect(redditWindow("2026-09-30T12:00:00Z", now)).toBe("day");
    expect(redditWindow("2026-09-26", now)).toBe("week");
    expect(redditWindow("2026-09-05", now)).toBe("month");
    expect(redditWindow("2026", now)).toBe("year");
    expect(redditWindow("2020", now)).toBe("all");
    expect(redditWindow("not a date", now)).toBe("all");
  });
});

describe("reddit backend", () => {
  it("parses the search feed into threads, skipping communities, with recency metadata", async () => {
    const spy = installFetchMock((url) => (url.includes("search.rss") ? { body: SEARCH, contentType: ATOM } : undefined));
    const r = await redditBackend(makeCtx("decathlon promo code", { since: "2026" }));
    expect(spy).toHaveBeenCalledTimes(1);
    expect(String(spy.mock.calls[0]![0])).toContain("t=year");
    expect(r.items.map((i) => i.url)).toEqual([
      "https://www.reddit.com/r/france/comments/1umagvr/code_promo_decathlon_rentree/",
      "https://www.reddit.com/r/running/comments/1uhj0ts/decathlon_discount_code/",
      "https://www.reddit.com/r/velo/comments/1rw2bgl/soldes_decathlon/",
    ]);
    const first = r.items[0]!;
    expect(first.backend).toBe("reddit");
    expect(first.meta).toMatchObject({ subreddit: "france", published: "2026-09-03T10:12:55.000Z", year: 2026 });
    expect(first.text).toContain("le code promo RENTREE10 marche encore");
    expect(first.text).not.toContain("submitted by");
    expect(r.notes[0]).toBe("Reddit returned 3 thread(s).");
  });

  it.each([
    [429, "rate-limited (HTTP 429)"],
    [403, "blocked this client as automated traffic (HTTP 403)"],
  ])("turns HTTP %i into a note pointing at the WebSearch lane", async (status, why) => {
    installFetchMock(() => ({ status, body: "" }));
    const r = await redditBackend(makeCtx("decathlon promo code"));
    expect(r.items).toEqual([]);
    expect(r.notes[0]).toContain(why);
    expect(r.notes[0]).toContain("site:reddit.com decathlon promo code");
  });

  it("says so when reddit answers with a page that is not a feed", async () => {
    installFetchMock(() => ({ body: "<html><title>Log in</title></html>", contentType: "text/html" }));
    const r = await redditBackend(makeCtx("q"));
    expect(r.items).toEqual([]);
    expect(r.notes[0]).toMatch(/not a feed/);
  });

  it("never retries the search", async () => {
    const spy = installFetchMock(() => ({ status: 503, body: "" }));
    await redditBackend(makeCtx("q"));
    expect(spy).toHaveBeenCalledTimes(1);
  });

  it("deep: reads the top three threads' comments one at a time", async () => {
    const order: string[] = [];
    installFetchMock((url) => {
      order.push(url);
      if (url.includes("search.rss")) return { body: SEARCH, contentType: ATOM };
      const thread = url.replace(/\.rss$/, "");
      return { body: commentsFeed(thread, ["APP5 a marché pour moi hier", "expiré chez moi"]), contentType: ATOM };
    });
    const r = await redditBackend(makeCtx("decathlon promo code", { depth: "deep" }));
    expect(order).toHaveLength(4); // 1 search + 3 comment feeds, never more
    expect(order.slice(1).every((u) => u.endsWith("/.rss"))).toBe(true);
    expect(r.items[0]!.text).toContain("Top comments:\n- APP5 a marché pour moi hier");
    expect(r.items[0]!.text).not.toContain("the post");
    expect(r.notes.at(-1)).toBe("Reddit comments: read the top comments of 3 thread(s).");
  });

  it("deep: stops at the first refused comment feed", async () => {
    const order: string[] = [];
    installFetchMock((url) => {
      order.push(url);
      if (url.includes("search.rss")) return { body: SEARCH, contentType: ATOM };
      return { status: 429, body: "" };
    });
    const r = await redditBackend(makeCtx("decathlon promo code", { depth: "deep" }));
    expect(order).toHaveLength(2); // the search, then ONE refused comment feed
    expect(r.items).toHaveLength(3); // the threads themselves are kept
    expect(r.notes.at(-1)).toMatch(/read 0 of 3 thread\(s\), then the feed rate-limited \(HTTP 429\) — stopped there/);
  });

  it("standard depth reads no comments", async () => {
    const spy = installFetchMock(() => ({ body: SEARCH, contentType: ATOM }));
    await redditBackend(makeCtx("q"));
    expect(spy).toHaveBeenCalledTimes(1);
  });
});
