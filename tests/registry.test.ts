// Force the polite-delay knob to 0 BEFORE any module that reads it at load
// (src/backends/fetch.ts) is imported. ES modules evaluate dependencies in
// import order, and vitest isolates modules per test file, so this leading
// side-effecting import wins. Keeps the serialization test fast (no real sleep).
import "./_polite0.js";

import { afterEach, describe, expect, it, vi } from "vitest";
import { runBackends } from "../src/backends/registry.js";
import { makeCtx } from "./ctx.js";

afterEach(() => vi.unstubAllGlobals());

// A fetch stub that tracks the peak number of simultaneously in-flight requests
// per host, so a test can tell serialized fan-out (peak 1) from concurrent (≥2).
function installConcurrencyMock(bodyFor: (url: string) => { body: string; json?: boolean }) {
  const peakByHost: Record<string, number> = {};
  const inFlight: Record<string, number> = {};
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: any) => {
      const url = typeof input === "string" ? input : String(input?.url ?? input);
      const host = new URL(url).host;
      inFlight[host] = (inFlight[host] ?? 0) + 1;
      peakByHost[host] = Math.max(peakByHost[host] ?? 0, inFlight[host]!);
      await new Promise((r) => setTimeout(r, 10));
      inFlight[host] = inFlight[host]! - 1;
      const { body, json } = bodyFor(url);
      return {
        ok: true,
        status: 200,
        url,
        headers: { get: (k: string) => (k.toLowerCase() === "content-type" ? (json ? "application/json" : "text/html") : null) },
        async arrayBuffer() {
          return new TextEncoder().encode(body).buffer;
        },
        async text() {
          return body;
        },
      } as unknown as Response;
    }),
  );
  return peakByHost;
}

const CROSSREF_JSON = JSON.stringify({
  message: { items: [{ title: ["A work"], URL: "https://doi.org/10.1/x", DOI: "10.1/x", author: [], issued: { "date-parts": [[2020]] } }] },
});
const DDG_HTML = `<div class="result"><a class="result__a" href="https://ex.test/a">A</a><a class="result__snippet">snippet a</a></div>
<div class="result"><a class="result__a" href="https://ex.test/b">B</a><a class="result__snippet">snippet b</a></div>`;

const THREE = ["query one", "query two", "query three"];

describe("runBackends variant fan-out politeness", () => {
  it("serializes a polite scholarly API's per-variant calls (Crossref: peak 1)", async () => {
    const peak = installConcurrencyMock((url) => (url.includes("crossref") ? { body: CROSSREF_JSON, json: true } : { body: "" }));
    const ctx = { ...makeCtx("q"), variants: THREE };
    await runBackends(["crossref"], ctx);
    expect(peak["api.crossref.org"]).toBe(1); // never two concurrent requests to the rate-limited host
  });

  it("still fans out a non-polite web engine concurrently (DuckDuckGo: peak ≥ 2)", async () => {
    const peak = installConcurrencyMock(() => ({ body: DDG_HTML }));
    const ctx = { ...makeCtx("q", { pages: 1 }), variants: THREE };
    await runBackends(["duckduckgo"], ctx);
    expect(peak["html.duckduckgo.com"]).toBeGreaterThanOrEqual(2);
  });

  it("both together: crossref serial, duckduckgo parallel, in one run", async () => {
    const peak = installConcurrencyMock((url) => (url.includes("crossref") ? { body: CROSSREF_JSON, json: true } : { body: DDG_HTML }));
    const ctx = { ...makeCtx("q", { pages: 1 }), variants: THREE };
    await runBackends(["crossref", "duckduckgo"], ctx);
    expect(peak["api.crossref.org"]).toBe(1);
    expect(peak["html.duckduckgo.com"]).toBeGreaterThanOrEqual(2);
  });
});

describe("runBackends — unknown backend", () => {
  it("returns an empty result + a note for a kind with no handler (e.g. the 'claude' provenance label)", async () => {
    const [res] = await runBackends(["claude"], makeCtx("q"));
    expect(res!.items).toHaveLength(0);
    expect(res!.notes.join(" ")).toMatch(/no handler for backend "claude"/i);
  });
});
