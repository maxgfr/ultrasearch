import { afterEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { duckduckgoBackend } from "../src/backends/duckduckgo.js";
import { ddgliteBackend } from "../src/backends/ddglite.js";
import { mojeekBackend } from "../src/backends/mojeek.js";
import { searxngBackend } from "../src/backends/searxng.js";
import type { RawSource } from "../src/types.js";
import { installFetchMock } from "./fetchmock.js";
import { makeCtx } from "./ctx.js";

// Canary tests: each backend is run against a SAVED real-shape response. When a
// provider changes its markup and a parser regex stops matching, these go red —
// before users silently lose a whole web engine. Update the fixture + parser
// together when that happens.
const here = dirname(fileURLToPath(import.meta.url));
const fixture = (name: string) => readFileSync(join(here, "fixtures", "pages", name), "utf8");

afterEach(() => vi.unstubAllGlobals());

function assertWeb(items: RawSource[], min = 2) {
  expect(items.length).toBeGreaterThanOrEqual(min);
  for (const it of items) {
    expect(it.url).toMatch(/^https?:\/\//);
    expect(it.title.length).toBeGreaterThan(0);
  }
}

describe("parser drift canaries (saved fixtures)", () => {
  it("duckduckgo HTML still parses", async () => {
    installFetchMock(() => ({ body: fixture("ddg.html") }));
    const r = await duckduckgoBackend(makeCtx("rate limiting"));
    assertWeb(r.items);
    expect(r.items[0]!.url).toBe("https://en.wikipedia.org/wiki/Rate_limiting");
    expect(r.items[0]!.snippet).toContain("rate limiting");
  });

  it("duckduckgo lite still parses", async () => {
    installFetchMock(() => ({ body: fixture("ddglite.html") }));
    const r = await ddgliteBackend(makeCtx("rate limiting"));
    assertWeb(r.items, 3);
    expect(r.items[0]!.url).toBe("https://en.wikipedia.org/wiki/Rate_limiting");
  });

  it("mojeek still parses", async () => {
    installFetchMock(() => ({ body: fixture("mojeek.html") }));
    const r = await mojeekBackend(makeCtx("rate limiting"));
    assertWeb(r.items, 3);
    expect(r.items[1]!.url).toBe("https://stripe.com/blog/rate-limiters");
  });

  it("searxng JSON still parses", async () => {
    installFetchMock(() => ({ body: fixture("searxng.json"), contentType: "application/json" }));
    const r = await searxngBackend(makeCtx("rate limiting", { searxng: "http://localhost:8888" }));
    assertWeb(r.items, 3);
  });
});
