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

  it("decodes HTML entities in titles, excerpts and extracts (real-API regression)", async () => {
    // The live REST API returns &amp; &quot; &#039; in titles/excerpts/extracts.
    const search = JSON.stringify({
      pages: [{ key: "AT&T", title: "AT&amp;T", excerpt: `the <span>client&#039;s</span> &quot;rate&quot;` }],
    });
    const summary = JSON.stringify({
      extract: `It reduces the client&#039;s request rate &amp; backs off.`,
      content_urls: { desktop: { page: "https://en.wikipedia.org/wiki/AT%26T" } },
    });
    installFetchMock((url) => {
      if (url.includes("/search/page")) return { body: search, contentType: "application/json" };
      if (url.includes("/summary/")) return { body: summary, contentType: "application/json" };
      return undefined;
    });
    const r = await wikipediaBackend(makeCtx("att"));
    const it = r.items[0]!;
    expect(it.title).toBe("AT&T");
    expect(it.snippet).toContain("client's");
    expect(it.snippet).toContain('"rate"');
    expect(it.text).toContain("client's request rate & backs off");
    // no raw entities leak through anywhere
    expect(`${it.title} ${it.snippet} ${it.text}`).not.toMatch(/&(amp|quot|#0?39);/);
  });

  it("notes a failed search", async () => {
    installFetchMock(() => ({ status: 500, body: "" }));
    const r = await wikipediaBackend(makeCtx("x"));
    expect(r.items).toHaveLength(0);
    expect(r.notes.join(" ")).toMatch(/search failed/i);
  });
});
