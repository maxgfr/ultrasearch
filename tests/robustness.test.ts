import { afterEach, describe, expect, it, vi } from "vitest";
import { rmSync, mkdtempSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { httpGet, httpJson } from "../src/backends/fetch.js";
import { mapLimit } from "../src/util.js";
import { runGather } from "../src/gather.js";
import type { GatherOptions, Source } from "../src/types.js";
import { installFetchMock } from "./fetchmock.js";

afterEach(() => vi.unstubAllGlobals());

function opts(over: Partial<GatherOptions>): GatherOptions {
  return {
    question: "rate limiting", mode: "topic", depth: "standard",
    maxSources: 25, perSource: 6, lang: "en", webEngine: "auto",
    excludeDomains: [], json: false, fresh: false, ...over,
  };
}

describe("R1: bounded retry on transient status", () => {
  it("httpGet retries once on 429 (honoring retry-after) then succeeds", async () => {
    let n = 0;
    const spy = installFetchMock(() => {
      n++;
      return n === 1
        ? { status: 429, body: "slow down", headers: { "retry-after": "0" } }
        : { status: 200, body: "<p>ok</p>" };
    });
    const r = await httpGet("https://x.test/a");
    expect(r.ok).toBe(true);
    expect(r.body).toContain("ok");
    expect(spy).toHaveBeenCalledTimes(2);
  });

  it("httpJson does NOT retry a hard 404", async () => {
    const spy = installFetchMock(() => ({ status: 404, body: "{}" }));
    const r = await httpJson("GET", "https://x.test/a");
    expect(r.ok).toBe(false);
    expect(spy).toHaveBeenCalledTimes(1);
  });
});

describe("R2: mapLimit bounds concurrency", () => {
  it("never exceeds the limit of simultaneous tasks", async () => {
    let inFlight = 0;
    let peak = 0;
    await mapLimit(Array.from({ length: 20 }, (_, i) => i), 4, async () => {
      inFlight++;
      peak = Math.max(peak, inFlight);
      await new Promise((r) => setTimeout(r, 5));
      inFlight--;
    });
    expect(peak).toBeLessThanOrEqual(4);
  });
});

describe("R5: --exclude-domains re-applied after a redirect", () => {
  it("drops a source whose followed redirect lands on an excluded host", async () => {
    installFetchMock((url) => {
      if (url.includes("redirector")) return { body: "<p>landed on a banned host</p>", url: "https://banned.test/final" };
      if (url.includes("good.test")) return { body: "<p>kept content here</p>" };
      return undefined;
    });
    const dir = mkdtempSync(join(tmpdir(), "us-redir-"));
    await runGather(
      opts({
        backends: ["generic"],
        urls: ["https://start.test/redirector", "https://good.test/page"],
        excludeDomains: ["banned.test"],
        out: dir,
      }),
    );
    const sources = JSON.parse(readFileSync(join(dir, "sources.json"), "utf8")) as Source[];
    expect(sources.map((s) => s.domain)).toEqual(["good.test"]);
    rmSync(dir, { recursive: true, force: true });
  });
});
