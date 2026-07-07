import { afterEach, describe, expect, it, vi } from "vitest";
import { wikipediaBackend } from "../src/backends/wikipedia.js";
import { installFetchMock } from "./fetchmock.js";
import { makeCtx } from "./ctx.js";

afterEach(() => vi.unstubAllGlobals());

// Edge-case coverage for wikipedia.ts: the branches the happy-path test doesn't
// reach — locale fallbacks, a page with no key, a failed summary hydrate, and a
// page that yields no text at all.
describe("wikipediaBackend — edge cases", () => {
  it("uses the language host from --lang and strips a region subtag (fr-FR → fr)", async () => {
    const spy = installFetchMock((url) => {
      if (url.includes("/search/page")) return { body: JSON.stringify({ pages: [] }), contentType: "application/json" };
      return undefined;
    });
    await wikipediaBackend(makeCtx("débit", { lang: "fr-FR" }));
    const searchUrl = spy.mock.calls.map((c) => String(c[0])).find((u) => u.includes("/search/page"))!;
    expect(searchUrl).toContain("https://fr.wikipedia.org/");
  });

  it("falls back to the en host when --lang is empty", async () => {
    const spy = installFetchMock((url) => {
      if (url.includes("/search/page")) return { body: JSON.stringify({ pages: [] }), contentType: "application/json" };
      return undefined;
    });
    await wikipediaBackend(makeCtx("x", { lang: "" }));
    const searchUrl = spy.mock.calls.map((c) => String(c[0])).find((u) => u.includes("/search/page"))!;
    expect(searchUrl).toContain("https://en.wikipedia.org/");
  });

  it("notes a search that returns 200 but no pages array", async () => {
    installFetchMock((url) => (url.includes("/search/page") ? { body: JSON.stringify({ ok: true }), contentType: "application/json" } : undefined));
    const r = await wikipediaBackend(makeCtx("x"));
    expect(r.items).toHaveLength(0);
    expect(r.notes.join(" ")).toMatch(/search failed/i);
  });

  it("skips a search hit that has no page key", async () => {
    const search = JSON.stringify({
      pages: [
        { title: "No key here", excerpt: "orphan" },
        { key: "Real", title: "Real", excerpt: "kept" },
      ],
    });
    const summary = JSON.stringify({ extract: "Real page text.", content_urls: { desktop: { page: "https://en.wikipedia.org/wiki/Real" } } });
    installFetchMock((url) => {
      if (url.includes("/search/page")) return { body: search, contentType: "application/json" };
      if (url.includes("/summary/Real")) return { body: summary, contentType: "application/json" };
      return undefined;
    });
    const r = await wikipediaBackend(makeCtx("x"));
    expect(r.items).toHaveLength(1);
    expect(r.items[0]!.title).toBe("Real");
  });

  it("falls back to the excerpt + a derived wiki url when the summary hydrate fails", async () => {
    const search = JSON.stringify({ pages: [{ key: "Token_bucket", title: "Token bucket", excerpt: "a rate algorithm" }] });
    installFetchMock((url) => {
      if (url.includes("/search/page")) return { body: search, contentType: "application/json" };
      if (url.includes("/summary/")) return { status: 500, body: "" }; // hydrate fails
      return undefined;
    });
    const r = await wikipediaBackend(makeCtx("x"));
    expect(r.items).toHaveLength(1);
    const it = r.items[0]!;
    expect(it.text).toBe("a rate algorithm"); // excerpt used as the source text
    expect(it.url).toBe("https://en.wikipedia.org/wiki/Token_bucket"); // derived fallback url
  });

  it("drops a page with neither an extract nor an excerpt", async () => {
    const search = JSON.stringify({ pages: [{ key: "Empty", title: "Empty" }] }); // no excerpt
    installFetchMock((url) => {
      if (url.includes("/search/page")) return { body: search, contentType: "application/json" };
      if (url.includes("/summary/")) return { status: 500, body: "" }; // no extract either
      return undefined;
    });
    const r = await wikipediaBackend(makeCtx("x"));
    expect(r.items).toHaveLength(0);
    expect(r.notes.join(" ")).toMatch(/no usable pages/i);
  });
});
