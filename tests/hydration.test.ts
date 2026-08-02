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

// PubMed's HTML throttles to a reCAPTCHA interstitial served as HTTP 200, while
// E-utilities keeps handing back the abstract. The provider table turns that
// into a hydration fallback — WITHOUT the endpoint becoming the source url.
const PUBMED_CAPTCHA = `<html><head><title>Checking your browser - reCAPTCHA</title></head><body>
  <p>Checking your browser before accessing pubmed.ncbi.nlm.nih.gov.</p></body></html>`;
const PUBMED_ABSTRACT = [
  "1. Science. 2012 Aug 17;337(6096):816-821. doi: 10.1126/science.aad5227.",
  "",
  "A programmable dual-RNA-guided DNA endonuclease in adaptive bacterial immunity.",
  "",
  "Jinek M, Doudna JA.",
  "",
  `${"Cas9 is a DNA endonuclease guided to its target by a dual-RNA structure. ".repeat(6)}`,
].join("\n");

describe("gather hydration — PubMed behind its anti-bot wall", () => {
  it("hydrates from E-utilities but keeps the citable url, and never cites the endpoint", async () => {
    installFetchMock((url) => {
      if (url.includes("esearch.fcgi")) return { body: JSON.stringify({ esearchresult: { idlist: ["28495875"] } }), contentType: "application/json" };
      if (url.includes("esummary.fcgi")) {
        return {
          body: JSON.stringify({
            result: {
              uids: ["28495875"],
              "28495875": {
                title: "A programmable dual-RNA-guided DNA endonuclease.",
                pubdate: "2012",
                source: "Science",
                articleids: [{ idtype: "doi", value: "10.1126/science.aad5227" }],
              },
            },
          }),
          contentType: "application/json",
        };
      }
      if (url.includes("efetch.fcgi")) return { body: PUBMED_ABSTRACT, contentType: "text/plain" };
      if (url.includes("doi.org")) return { status: 403, body: "paywall" };
      if (url.includes("pubmed.ncbi.nlm.nih.gov")) return { body: PUBMED_CAPTCHA };
      return undefined;
    });
    const dir = mkdtempSync(join(tmpdir(), "us-pm-"));
    process.env.ULTRASEARCH_NO_WAYBACK = "1";
    await runGather(opts({ backends: ["pubmed"], out: dir }));
    const sources = JSON.parse(readFileSync(join(dir, "sources.json"), "utf8")) as Source[];
    expect(sources).toHaveLength(1);
    expect(sources[0]!.url).toBe("https://doi.org/10.1126/science.aad5227"); // the citable url, untouched
    expect(sources[0]!.title).not.toMatch(/reCAPTCHA/); // the wall never names the source
    expect(sources[0]!.fullText).not.toBe(false);
    expect(sources[0]!.meta?.textVia).toContain("efetch.fcgi");
    expect(readFileSync(join(dir, sources[0]!.extract), "utf8")).toContain("dual-RNA structure");
    rmSync(dir, { recursive: true, force: true });
  });
});

const FIRECRAWL_MD = JSON.stringify({
  success: true,
  data: {
    markdown: `# Token Bucket Scheduling\n\n${"A real browser got past the consent wall and read the token bucket paper. ".repeat(8)}`,
    metadata: { title: "Token Bucket Scheduling", statusCode: 200 },
  },
});

describe("Firecrawl junk rescue", () => {
  it("re-extracts a consent wall through Firecrawl instead of demoting it to a snippet", async () => {
    const base = "http://fc-hyd.test";
    // The first two scrapes fail, so the primary hydrate AND the arXiv absUrl
    // fallback both land on the built-in reader's consent wall. Only then does
    // the junk-rescue tier fire — which is exactly what this pins.
    let scrapes = 0;
    installFetchMock((url) => {
      if (url.includes("/scrape")) return scrapes++ < 2 ? { status: 500, body: "boom" } : { body: FIRECRAWL_MD, contentType: "application/json" };
      if (url === `${base}/`) return { status: 200, body: "{}" };
      if (url.includes("export.arxiv.org")) return { body: ARXIV_FEED, contentType: "application/atom+xml" };
      if (url.includes("/html/") || url.includes("/abs/")) return { body: CONSENT_WALL };
      return undefined;
    });
    const dir = mkdtempSync(join(tmpdir(), "us-fc-"));
    await runGather(opts({ backends: ["arxiv"], out: dir, firecrawl: base }));
    const sources = JSON.parse(readFileSync(join(dir, "sources.json"), "utf8")) as Source[];
    expect(sources).toHaveLength(1);
    expect(sources[0]!.fullText).not.toBe(false); // rescued → real full text, not a snippet
    expect(readFileSync(join(dir, sources[0]!.extract), "utf8")).toContain("got past the consent wall");
    const notes = (JSON.parse(readFileSync(join(dir, "manifest.json"), "utf8")) as Manifest).notes.join(" ");
    expect(notes).toMatch(/re-extracted it with Firecrawl/i);
    expect(notes).toMatch(/Firecrawl cleaned 1 page/i);
    rmSync(dir, { recursive: true, force: true });
  });

  it("still keeps only the snippet when Firecrawl is down", async () => {
    const base = "http://fc-down.test";
    installFetchMock((url) => {
      if (url === `${base}/`) throw new Error("ECONNREFUSED");
      if (url.includes("export.arxiv.org")) return { body: ARXIV_FEED, contentType: "application/atom+xml" };
      if (url.includes("/html/") || url.includes("/abs/")) return { body: CONSENT_WALL };
      return undefined;
    });
    const dir = mkdtempSync(join(tmpdir(), "us-fc-down-"));
    await runGather(opts({ backends: ["arxiv"], out: dir, firecrawl: base }));
    const sources = JSON.parse(readFileSync(join(dir, "sources.json"), "utf8")) as Source[];
    expect(sources[0]!.fullText).toBe(false);
    const notes = (JSON.parse(readFileSync(join(dir, "manifest.json"), "utf8")) as Manifest).notes;
    expect(notes.join(" ")).toMatch(/snippet only/i);
    // The "not reachable" note is instance-level, so it appears exactly ONCE
    // however many pages the run hydrated.
    expect(notes.filter((n) => /not reachable/i.test(n))).toHaveLength(1);
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
