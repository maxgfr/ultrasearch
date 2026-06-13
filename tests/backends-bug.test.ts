import { afterEach, describe, expect, it, vi } from "vitest";
import { stackexchangeBackend } from "../src/backends/stackexchange.js";
import { hackernewsBackend } from "../src/backends/hackernews.js";
import { githubBackend } from "../src/backends/github.js";
import { installFetchMock, routes } from "./fetchmock.js";
import { makeCtx } from "./ctx.js";

afterEach(() => vi.unstubAllGlobals());

const SE = JSON.stringify({
  items: [
    {
      title: "Why do I get a 429 &#39;Too Many Requests&#39;?",
      link: "https://stackoverflow.com/q/123",
      score: 42,
      is_answered: true,
      question_id: 123,
      body: "<p>The server is <b>rate limiting</b> you.</p>",
    },
  ],
});

const HN = JSON.stringify({
  hits: [
    { title: "Show HN: A rate limiter", url: "https://example.com/rl", points: 210, objectID: "999", num_comments: 30 },
    { title: "Ask HN: limits?", story_text: "<p>how to limit</p>", points: 5, objectID: "1000" },
  ],
});

const GH = JSON.stringify({
  items: [
    {
      title: "Crash on 429 retry",
      html_url: "https://github.com/org/repo/issues/7",
      body: "Stacktrace here",
      state: "open",
      comments: 3,
      repository_url: "https://api.github.com/repos/org/repo",
    },
  ],
});

describe("bug backends", () => {
  it("stackexchange decodes title entities and strips body html", async () => {
    installFetchMock(routes([["api.stackexchange.com", { body: SE, contentType: "application/json" }]]));
    const r = await stackexchangeBackend(makeCtx("429 too many requests"));
    expect(r.items[0]!.title).toContain("'Too Many Requests'");
    expect(r.items[0]!.text).toContain("rate limiting");
    expect(r.items[0]!.meta?.answerScore).toBe(42);
  });

  it("stackexchange fans out across multiple network sites", async () => {
    const spy = installFetchMock(routes([["api.stackexchange.com", { body: SE, contentType: "application/json" }]]));
    await stackexchangeBackend(makeCtx("429 too many requests"));
    const sites = spy.mock.calls.map((c) => String(c[0])).map((u) => /site=([^&]+)/.exec(u)?.[1]);
    expect(sites).toEqual(expect.arrayContaining(["stackoverflow", "serverfault", "superuser"]));
    expect(new Set(sites).size).toBeGreaterThanOrEqual(4); // distinct sites queried
  });

  it("hackernews falls back to the discussion url for Ask HN posts", async () => {
    installFetchMock(routes([["hn.algolia.com", { body: HN, contentType: "application/json" }]]));
    const r = await hackernewsBackend(makeCtx("rate limiter"));
    expect(r.items).toHaveLength(2);
    expect(r.items[0]!.url).toBe("https://example.com/rl");
    expect(r.items[1]!.url).toContain("news.ycombinator.com/item?id=1000");
    expect(r.items[0]!.meta?.points).toBe(210);
  });

  it("github labels issues vs PRs and strips the body", async () => {
    installFetchMock(routes([["api.github.com/search/issues", { body: GH, contentType: "application/json" }]]));
    const r = await githubBackend(makeCtx("crash on retry"));
    expect(r.items[0]!.title).toContain("Issue:");
    expect(r.items[0]!.title).toContain("org/repo");
    expect(r.items[0]!.url).toBe("https://github.com/org/repo/issues/7");
  });
});
