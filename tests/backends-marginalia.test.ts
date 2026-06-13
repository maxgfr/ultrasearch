import { afterEach, describe, expect, it, vi } from "vitest";
import { marginaliaBackend } from "../src/backends/marginalia.js";
import { installFetchMock } from "./fetchmock.js";
import { makeCtx } from "./ctx.js";

afterEach(() => vi.unstubAllGlobals());

describe("marginaliaBackend", () => {
  it("maps the public JSON API results to sources", async () => {
    const body = JSON.stringify({
      results: [
        { url: "https://real.test/a", title: "Alpha", description: "about alpha and token buckets" },
        { url: "https://real.test/b", title: "Beta", description: "about beta" },
      ],
    });
    const spy = installFetchMock(() => ({ body, contentType: "application/json" }));
    const r = await marginaliaBackend(makeCtx("alpha beta"));
    expect(String(spy.mock.calls[0]![0])).toContain("api.marginalia-search.com/public/search/");
    expect(r.items.map((i) => i.url)).toEqual(["https://real.test/a", "https://real.test/b"]);
    expect(r.items[0]!.title).toBe("Alpha");
    expect(r.items[0]!.snippet).toContain("alpha");
  });

  it("notes when rate-limited and never throws", async () => {
    installFetchMock(() => ({ status: 503, body: "" }));
    const r = await marginaliaBackend(makeCtx("x"));
    expect(r.items).toHaveLength(0);
    expect(r.notes.join(" ")).toMatch(/rate-limited/i);
  });
});
