import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { runGather } from "../src/gather.js";
import type { GatherOptions, Manifest, Source } from "../src/types.js";
import { installFetchMock } from "./fetchmock.js";

afterEach(() => vi.unstubAllGlobals());

function opts(over: Partial<GatherOptions>): GatherOptions {
  return {
    question: "token bucket rate limiting",
    mode: "topic",
    depth: "standard",
    maxSources: 25,
    perSource: 6,
    lang: "en",
    webEngine: "auto",
    excludeDomains: [],
    json: false,
    ...over,
  };
}

// One arXiv entry whose /html/<id> URL 404s (common) but which carries an
// abstract page (absUrl) in its metadata.
const ARXIV_FEED = `<feed><entry>
  <id>http://arxiv.org/abs/2101.00001v1</id>
  <title>Token Bucket Scheduling</title>
  <summary>We study token bucket rate limiting algorithms in depth.</summary>
  <published>2021-01-01T00:00:00Z</published>
  <author><name>A. Researcher</name></author>
</entry></feed>`;

const GOOD_ABS_HTML = `<html><head><title>Token Bucket Scheduling</title></head><body><article>
  <h1>Token Bucket Scheduling</h1>
  <p>${"The token bucket algorithm meters traffic by accumulating tokens over time and admitting requests only when tokens remain. ".repeat(8)}</p>
</article></body></html>`;

const CONSENT_WALL = `<html><body><div>We use cookies to improve your experience. Accept all cookies to continue.</div></body></html>`;

function run(dir: string) {
  return runGather(opts({ backends: ["arxiv"], out: dir }));
}

describe("gather hydration fallbacks (P0.4)", () => {
  it("falls back to the arXiv abstract page when /html/<id> 404s", async () => {
    installFetchMock((url) => {
      if (url.includes("export.arxiv.org")) return { body: ARXIV_FEED, contentType: "application/atom+xml" };
      if (url.includes("/html/")) return { status: 404, body: "not found" };
      if (url.includes("/abs/")) return { body: GOOD_ABS_HTML };
      return undefined;
    });
    const dir = mkdtempSync(join(tmpdir(), "us-hyd-"));
    await run(dir);
    const sources = JSON.parse(readFileSync(join(dir, "sources.json"), "utf8")) as Source[];
    expect(sources).toHaveLength(1);
    expect(sources[0]!.fullText).not.toBe(false); // hydrated from the fallback → full text
    const extract = readFileSync(join(dir, sources[0]!.extract), "utf8");
    expect(extract).toContain("meters traffic");
    const manifest = JSON.parse(readFileSync(join(dir, "manifest.json"), "utf8")) as Manifest;
    expect(manifest.notes.join(" ")).toMatch(/hydrated the fallback/i);
    rmSync(dir, { recursive: true, force: true });
  });

  it("keeps only the snippet when both the html and abstract pages are consent walls", async () => {
    installFetchMock((url) => {
      if (url.includes("export.arxiv.org")) return { body: ARXIV_FEED, contentType: "application/atom+xml" };
      if (url.includes("/html/") || url.includes("/abs/")) return { body: CONSENT_WALL };
      return undefined;
    });
    const dir = mkdtempSync(join(tmpdir(), "us-hyd-"));
    await run(dir);
    const sources = JSON.parse(readFileSync(join(dir, "sources.json"), "utf8")) as Source[];
    expect(sources).toHaveLength(1);
    expect(sources[0]!.fullText).toBe(false); // consent wall rejected → snippet only
    const manifest = JSON.parse(readFileSync(join(dir, "manifest.json"), "utf8")) as Manifest;
    expect(manifest.notes.join(" ")).toMatch(/snippet only/i);
    // the abstract snippet survives as the source text
    expect(sources[0]!.snippet).toMatch(/token bucket/i);
    rmSync(dir, { recursive: true, force: true });
  });
});
