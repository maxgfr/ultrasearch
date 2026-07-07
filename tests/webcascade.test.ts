import { afterEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { runWebCascade } from "../src/gather.js";
import type { BackendKind } from "../src/types.js";
import { makeCtx } from "./ctx.js";

// P0.1 — the web discovery cascade walks engines in preference order and, at
// breadth ≥ 2, runs each wave CONCURRENTLY (the old loop was strictly serial).
// At breadth 1 it must still short-circuit on the first engine that satisfies
// perSource, querying no others.
const here = dirname(fileURLToPath(import.meta.url));
const fixture = (name: string) => readFileSync(join(here, "fixtures", "pages", name), "utf8");

afterEach(() => vi.unstubAllGlobals());

// Route each discovery engine's host to its saved fixture, tracking in-flight
// requests so a test can prove concurrency. perSource is kept low (2) so each
// engine "satisfies". `hit` records which hosts were fetched.
function installCascadeMock() {
  const hit: string[] = [];
  let inFlight = 0;
  let peak = 0;
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: any) => {
      const url = typeof input === "string" ? input : String(input?.url ?? input);
      let body = "";
      if (url.includes("html.duckduckgo.com")) body = fixture("ddg.html");
      else if (url.includes("lite.duckduckgo.com")) body = fixture("ddglite.html");
      else if (url.includes("mojeek.com")) body = fixture("mojeek.html");
      hit.push(url);
      inFlight++;
      peak = Math.max(peak, inFlight);
      await new Promise((r) => setTimeout(r, 8));
      inFlight--;
      return {
        ok: true,
        status: 200,
        url,
        headers: { get: (k: string) => (k.toLowerCase() === "content-type" ? "text/html" : null) },
        async arrayBuffer() {
          return new TextEncoder().encode(body).buffer;
        },
        async text() {
          return body;
        },
      } as unknown as Response;
    }),
  );
  return {
    get peak() {
      return peak;
    },
    hostsHit: () => hit.map((u) => new URL(u).host),
  };
}

const ENGINES: BackendKind[] = ["duckduckgo", "ddglite", "mojeek"];
const ctx = () => makeCtx("rate limiting", { perSource: 2, pages: 1 });

describe("runWebCascade", () => {
  it("breadth 1: short-circuits on the first satisfying engine (queries no others)", async () => {
    const m = installCascadeMock();
    const out = await runWebCascade(ENGINES, ctx(), 1);
    // only duckduckgo was queried; ddglite/mojeek untouched
    expect(m.hostsHit()).toEqual(["html.duckduckgo.com"]);
    expect(out.map((r) => r.backend)).toEqual(["duckduckgo"]);
    expect(out[0]!.items.length).toBeGreaterThanOrEqual(2);
  });

  it("breadth 3: launches the whole wave concurrently and fuses every engine", async () => {
    const m = installCascadeMock();
    const out = await runWebCascade(ENGINES, ctx(), 3);
    const hosts = new Set(m.hostsHit());
    expect(hosts).toEqual(new Set(["html.duckduckgo.com", "lite.duckduckgo.com", "www.mojeek.com"]));
    // genuinely overlapping — impossible under the old serial loop
    expect(m.peak).toBeGreaterThanOrEqual(2);
    expect(out.map((r) => r.backend).sort()).toEqual(["ddglite", "duckduckgo", "mojeek"]);
    // provenance note records the fusion
    const notes = out.flatMap((r) => r.notes).join(" ");
    expect(notes).toMatch(/fused 3 engines/i);
  });

  it("breadth 2 with the first engine blocked still fuses the next two", async () => {
    const hit: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: any) => {
        const url = typeof input === "string" ? input : String(input?.url ?? input);
        hit.push(new URL(url).host);
        const blocked = url.includes("html.duckduckgo.com");
        const body = url.includes("lite.duckduckgo.com") ? fixture("ddglite.html") : url.includes("mojeek.com") ? fixture("mojeek.html") : "";
        return {
          ok: !blocked,
          status: blocked ? 503 : 200,
          url,
          headers: { get: (k: string) => (k.toLowerCase() === "content-type" ? "text/html" : null) },
          async arrayBuffer() {
            return new TextEncoder().encode(body).buffer;
          },
          async text() {
            return body;
          },
        } as unknown as Response;
      }),
    );
    const out = await runWebCascade(ENGINES, ctx(), 2);
    const producers = out.filter((r) => r.items.length > 0).map((r) => r.backend);
    expect(producers).toEqual(expect.arrayContaining(["ddglite", "mojeek"]));
    expect(hit).toContain("html.duckduckgo.com"); // the blocked engine was still tried
  });

  it("is deterministic: same responses → same fused engine order", async () => {
    installCascadeMock();
    const a = await runWebCascade(ENGINES, ctx(), 3);
    vi.unstubAllGlobals();
    installCascadeMock();
    const b = await runWebCascade(ENGINES, ctx(), 3);
    expect(a.map((r) => r.backend)).toEqual(b.map((r) => r.backend));
    expect(a.flatMap((r) => r.items.map((i) => i.url))).toEqual(b.flatMap((r) => r.items.map((i) => i.url)));
  });
});
