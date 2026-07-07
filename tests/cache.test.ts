import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { cachedFetchAndExtract, cachePath } from "../src/cache.js";
import { installFetchMock } from "./fetchmock.js";

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "us-cache-"));
  process.env.ULTRASEARCH_CACHE_DIR = dir;
});
afterEach(() => {
  vi.unstubAllGlobals();
  delete process.env.ULTRASEARCH_CACHE_DIR;
  delete process.env.ULTRASEARCH_CACHE_TTL_MS;
  rmSync(dir, { recursive: true, force: true });
});

const PAGE = { body: "<html><body><article><p>cached article body about token buckets and windows</p></article></body></html>" };
const URL = "https://ex.test/page";

describe("cachedFetchAndExtract (--cache)", () => {
  it("serves a fresh hit from disk without a second fetch", async () => {
    const spy = installFetchMock(() => PAGE);
    const a = await cachedFetchAndExtract(URL, {}, true, 1000);
    const b = await cachedFetchAndExtract(URL, {}, true, 1500); // within TTL
    expect(a.text).toContain("token buckets");
    expect(b.text).toBe(a.text);
    expect(spy).toHaveBeenCalledTimes(1); // second call served from disk
  });

  it("refetches once the entry is past its TTL", async () => {
    process.env.ULTRASEARCH_CACHE_TTL_MS = "1000";
    const spy = installFetchMock(() => PAGE);
    await cachedFetchAndExtract(URL, {}, true, 1000);
    await cachedFetchAndExtract(URL, {}, true, 2001); // 1001ms later > 1000 TTL → stale
    expect(spy).toHaveBeenCalledTimes(2);
  });

  it("ignores a corrupt cache entry and refetches without throwing", async () => {
    writeFileSync(cachePath(URL), "{ not json");
    const spy = installFetchMock(() => PAGE);
    const r = await cachedFetchAndExtract(URL, {}, true, 1000);
    expect(r.text).toContain("token buckets");
    expect(spy).toHaveBeenCalledTimes(1);
  });

  it("does not cache a failed/empty fetch (always refetches)", async () => {
    const spy = installFetchMock(() => ({ status: 404, body: "gone" }));
    await cachedFetchAndExtract(URL, {}, true, 1000);
    await cachedFetchAndExtract(URL, {}, true, 1100);
    expect(spy).toHaveBeenCalledTimes(2); // nothing to serve → refetch
  });

  it("is a no-op passthrough when disabled (default)", async () => {
    const spy = installFetchMock(() => PAGE);
    await cachedFetchAndExtract(URL, {}, false, 1000);
    await cachedFetchAndExtract(URL, {}, false, 1000);
    expect(spy).toHaveBeenCalledTimes(2); // no disk cache consulted
  });
});
