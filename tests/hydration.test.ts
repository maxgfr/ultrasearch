import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { runGather } from "../src/gather.js";
import { addSource } from "../src/enrich.js";
import { writeFixtureDossier } from "./dossierfix.js";
import type { GatherOptions, Manifest, Source } from "../src/types.js";
import { installFetchMock } from "./fetchmock.js";

afterEach(() => {
  vi.unstubAllGlobals();
  delete process.env.ULTRASEARCH_NO_WAYBACK;
});

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

// A feed with `n` arXiv entries whose html + abs pages are both dead.
function arxivFeed(n: number): string {
  const entries = Array.from(
    { length: n },
    (_, i) => `<entry><id>http://arxiv.org/abs/2101.${String(i).padStart(5, "0")}v1</id>
    <title>Dead Paper ${i}</title><summary>Abstract about token buckets number ${i}.</summary>
    <published>2021-01-01T00:00:00Z</published><author><name>A. B.</name></author></entry>`,
  ).join("");
  return `<feed>${entries}</feed>`;
}

const WAYBACK_AVAIL = JSON.stringify({
  archived_snapshots: {
    closest: { status: "200", available: true, url: "https://web.archive.org/web/20220101000000/https://arxiv.org/x", timestamp: "20220101000000" },
  },
});
const ARCHIVE_HTML = `<html><head><title>Archived Copy</title></head><body><article><p>${"Recovered archived content about token bucket rate limiting from the wayback machine. ".repeat(6)}</p></article></body></html>`;

describe("Wayback Machine dead-link rescue (P1.7)", () => {
  it("recovers a dead source from the closest snapshot and records it", async () => {
    installFetchMock((url) => {
      if (url.includes("export.arxiv.org")) return { body: arxivFeed(1), contentType: "application/atom+xml" };
      if (url.includes("arxiv.org/html/") || url.includes("arxiv.org/abs/")) return { status: 404, body: "gone" };
      if (url.includes("archive.org/wayback/available")) return { body: WAYBACK_AVAIL, contentType: "application/json" };
      if (url.includes("web.archive.org")) return { body: ARCHIVE_HTML };
      return undefined;
    });
    const dir = mkdtempSync(join(tmpdir(), "us-wb-"));
    await run(dir);
    const sources = JSON.parse(readFileSync(join(dir, "sources.json"), "utf8")) as Source[];
    expect(sources).toHaveLength(1);
    expect(sources[0]!.fullText).not.toBe(false);
    expect(sources[0]!.url).toContain("arxiv.org/html/"); // ORIGINAL url kept, not the archive url
    expect(sources[0]!.meta?.waybackSnapshot).toBe("20220101000000");
    const extract = readFileSync(join(dir, sources[0]!.extract), "utf8");
    expect(extract).toContain("Recovered archived content");
    const manifest = JSON.parse(readFileSync(join(dir, "manifest.json"), "utf8")) as Manifest;
    expect(manifest.notes.join(" ")).toMatch(/Wayback Machine/i);
    rmSync(dir, { recursive: true, force: true });
  });

  it("caps rescues at 5 per run", async () => {
    let availCalls = 0;
    installFetchMock((url) => {
      if (url.includes("export.arxiv.org")) return { body: arxivFeed(8), contentType: "application/atom+xml" };
      if (url.includes("arxiv.org/html/") || url.includes("arxiv.org/abs/")) return { status: 404, body: "gone" };
      if (url.includes("archive.org/wayback/available")) {
        availCalls++;
        return { body: WAYBACK_AVAIL, contentType: "application/json" };
      }
      if (url.includes("web.archive.org")) return { body: ARCHIVE_HTML };
      return undefined;
    });
    const dir = mkdtempSync(join(tmpdir(), "us-wb-"));
    await run(dir);
    expect(availCalls).toBeLessThanOrEqual(5);
    rmSync(dir, { recursive: true, force: true });
  });

  it("is disabled by ULTRASEARCH_NO_WAYBACK", async () => {
    process.env.ULTRASEARCH_NO_WAYBACK = "1";
    let availCalls = 0;
    installFetchMock((url) => {
      if (url.includes("export.arxiv.org")) return { body: arxivFeed(1), contentType: "application/atom+xml" };
      if (url.includes("arxiv.org/html/") || url.includes("arxiv.org/abs/")) return { status: 404, body: "gone" };
      if (url.includes("archive.org")) {
        availCalls++;
        return { body: WAYBACK_AVAIL, contentType: "application/json" };
      }
      return undefined;
    });
    const dir = mkdtempSync(join(tmpdir(), "us-wb-"));
    await run(dir);
    expect(availCalls).toBe(0);
    const sources = JSON.parse(readFileSync(join(dir, "sources.json"), "utf8")) as Source[];
    expect(sources[0]!.fullText).toBe(false); // fell back to snippet, no rescue
    rmSync(dir, { recursive: true, force: true });
  });

  it("enrich (fetch --url) rescues a dead URL via Wayback", async () => {
    installFetchMock((url) => {
      // archive.org rules FIRST: the availability API URL embeds the (encoded)
      // original URL, whose unencoded host "dead.test" would otherwise match below.
      if (url.includes("archive.org/wayback/available")) return { body: WAYBACK_AVAIL, contentType: "application/json" };
      if (url.includes("web.archive.org")) return { body: ARCHIVE_HTML };
      if (url.includes("dead.test")) return { status: 410, body: "gone" };
      return undefined;
    });
    const dir = mkdtempSync(join(tmpdir(), "us-wb-enrich-"));
    writeFixtureDossier(dir, 1);
    const r = await addSource(dir, "https://dead.test/gone-article");
    expect(r.added).toBe(true);
    const sources = JSON.parse(readFileSync(join(dir, "sources.json"), "utf8")) as Source[];
    const added = sources.find((s) => s.url === "https://dead.test/gone-article")!;
    expect(added).toBeTruthy();
    expect(added.meta?.waybackSnapshot).toBe("20220101000000");
    rmSync(dir, { recursive: true, force: true });
  });
});
