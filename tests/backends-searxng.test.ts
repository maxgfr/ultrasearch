import { afterEach, describe, expect, it, vi } from "vitest";
import { searxngBackend } from "../src/backends/searxng.js";
import { installFetchMock, routes } from "./fetchmock.js";
import { makeCtx } from "./ctx.js";

afterEach(() => vi.unstubAllGlobals());

const SEARX_JSON = JSON.stringify({
  results: [
    { url: "https://a.test/1", title: "First", content: "first snippet" },
    { url: "https://b.test/2", title: "Second", content: "second snippet" },
  ],
});

describe("searxngBackend", () => {
  it("parses the JSON results into ranked sources", async () => {
    installFetchMock(routes([["format=json", { body: SEARX_JSON, contentType: "application/json" }]]));
    const r = await searxngBackend(makeCtx("rate limiting", { searxng: "http://localhost:8888" }));
    expect(r.items).toHaveLength(2);
    expect(r.items[0]!.url).toBe("https://a.test/1");
    expect(r.items[0]!.snippet).toBe("first snippet");
    expect(r.items[0]!.score).toBeGreaterThan(r.items[1]!.score);
  });

  it("is opt-in: skips without calling fetch when no instance is configured", async () => {
    const spy = installFetchMock(() => ({ status: 200, body: "{}" }));
    const r = await searxngBackend(makeCtx("x")); // no --searxng, no env
    expect(r.items).toHaveLength(0);
    expect(r.notes.join(" ")).toMatch(/not configured/i);
    expect(spy).not.toHaveBeenCalled();
  });

  it("falls through with a note when a configured instance is unreachable", async () => {
    installFetchMock(() => ({ status: 0, body: "" }));
    const r = await searxngBackend(makeCtx("x", { searxng: "http://localhost:8888" }));
    expect(r.items).toHaveLength(0);
    expect(r.notes.join(" ")).toMatch(/unreachable/i);
  });

  it("notes when the instance returns non-JSON (json disabled)", async () => {
    installFetchMock(() => ({ status: 200, body: "<html>blocked</html>", contentType: "text/html" }));
    const r = await searxngBackend(makeCtx("x", { searxng: "http://localhost:8888" }));
    expect(r.items).toHaveLength(0);
    expect(r.notes.join(" ")).toMatch(/did not return JSON/i);
  });
});
