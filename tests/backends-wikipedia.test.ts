import { afterEach, describe, expect, it, vi } from "vitest";
import { wikipediaBackend } from "../src/backends/wikipedia.js";
import { installFetchMock } from "./fetchmock.js";
import { makeCtx } from "./ctx.js";

afterEach(() => vi.unstubAllGlobals());

const SEARCH = JSON.stringify({
  pages: [
    { key: "Rate_limiting", title: "Rate limiting", excerpt: "<span>controls request rate</span>" },
    { key: "Token_bucket", title: "Token bucket", excerpt: "an algorithm" },
  ],
});
const SUMMARY_RL = JSON.stringify({
  extract: "Rate limiting is a strategy for limiting network traffic.",
  content_urls: { desktop: { page: "https://en.wikipedia.org/wiki/Rate_limiting" } },
});
const SUMMARY_TB = JSON.stringify({
  extract: "The token bucket is an algorithm used in packet-switched networks.",
  content_urls: { desktop: { page: "https://en.wikipedia.org/wiki/Token_bucket" } },
});

describe("wikipediaBackend", () => {
  it("searches then hydrates each page summary into source text", async () => {
    installFetchMock((url) => {
      if (url.includes("/search/page")) return { body: SEARCH, contentType: "application/json" };
      if (url.includes("/summary/Rate_limiting")) return { body: SUMMARY_RL, contentType: "application/json" };
      if (url.includes("/summary/Token_bucket")) return { body: SUMMARY_TB, contentType: "application/json" };
      return undefined;
    });
    const r = await wikipediaBackend(makeCtx("what is rate limiting"));
    expect(r.items).toHaveLength(2);
    const rl = r.items.find((i) => i.title === "Rate limiting")!;
    expect(rl.url).toBe("https://en.wikipedia.org/wiki/Rate_limiting");
    expect(rl.text).toContain("limiting network traffic");
    expect(rl.snippet).toContain("controls request rate");
  });

  it("notes a failed search", async () => {
    installFetchMock(() => ({ status: 500, body: "" }));
    const r = await wikipediaBackend(makeCtx("x"));
    expect(r.items).toHaveLength(0);
    expect(r.notes.join(" ")).toMatch(/search failed/i);
  });
});
