import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { runGather } from "../src/gather.js";
import type { GatherOptions, Manifest, Source } from "../src/types.js";
import { installFetchMock } from "./fetchmock.js";

afterEach(() => {
  vi.unstubAllGlobals();
  delete process.env.ULTRASEARCH_NO_WAYBACK;
});

function opts(over: Partial<GatherOptions>): GatherOptions {
  return {
    question: "token bucket sliding window rate counter",
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

// One DDG hit, pointing at a page that is gone from its origin.
const DDG_DEAD = `
<a class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fdead.test%2Fpage-a">Token bucket</a>
<a class="result__snippet">token bucket only</a>`;

const WAYBACK_AVAIL = JSON.stringify({
  archived_snapshots: {
    closest: { status: "200", available: true, url: "https://web.archive.org/web/20220101000000/https://dead.test/page-a", timestamp: "20220101000000" },
  },
});
const ARCHIVE_HTML = `<html><head><title>Archived Copy</title></head><body><article><p>${"Recovered archived content about token bucket rate limiting from the wayback machine. ".repeat(6)}</p></article></body></html>`;

// The dossier a run wrote, minus the fields that legitimately move between runs
// (clock, engine version, per-backend timings) — the oracle a perf change has to
// leave byte-identical.
function dossier(dir: string) {
  const sources = (JSON.parse(readFileSync(join(dir, "sources.json"), "utf8")) as Source[]).map(({ fetchedAt: _f, ...s }) => s);
  const manifest = JSON.parse(readFileSync(join(dir, "manifest.json"), "utf8")) as Manifest;
  const { version: _v, builtAt: _b, timings: _t, ...rest } = manifest;
  return { sources, manifest: rest };
}

describe("gather --rounds 2: a Wayback rescue is folded into the hydrate cache", () => {
  it("rescues the dead link ONCE across both rounds and writes the same dossier", async () => {
    let availCalls = 0;
    let snapshotCalls = 0;
    installFetchMock((url) => {
      if (url.includes("/search/page")) return { body: JSON.stringify({ pages: [] }), contentType: "application/json" };
      if (url.includes("html.duckduckgo.com")) return { body: DDG_DEAD };
      // archive.org rules first: the availability URL embeds the encoded origin URL.
      if (url.includes("archive.org/wayback/available")) {
        availCalls++;
        return { body: WAYBACK_AVAIL, contentType: "application/json" };
      }
      if (url.includes("web.archive.org")) {
        snapshotCalls++;
        return { body: ARCHIVE_HTML };
      }
      if (url.includes("dead.test")) return { status: 404, body: "gone" };
      return undefined;
    });

    const dir = mkdtempSync(join(tmpdir(), "us-rounds-"));
    const r = await runGather(opts({ webEngine: "ddg", rounds: 2, out: dir }));

    // The gap round really ran (otherwise this test proves nothing about round 2).
    expect(r.manifest.notes.join(" ")).toMatch(/Gap round/);

    // ONE rescue for the whole run: round 2 reuses round 1's, instead of paying
    // archive.org a second time for the same dead page.
    expect(availCalls).toBe(1);
    expect(snapshotCalls).toBe(1);

    // …and the dossier still says exactly what a re-rescue used to make it say.
    const sources = JSON.parse(readFileSync(join(dir, "sources.json"), "utf8")) as Source[];
    const dead = sources.find((s) => s.url.includes("dead.test"))!;
    expect(dead).toBeTruthy();
    expect(dead.fullText).not.toBe(false);
    expect(dead.meta?.waybackSnapshot).toBe("20220101000000");
    expect(readFileSync(join(dir, dead.extract), "utf8")).toContain("Recovered archived content");
    const notes = (JSON.parse(readFileSync(join(dir, "manifest.json"), "utf8")) as Manifest).notes;
    expect(notes.filter((n) => /from the Wayback Machine/.test(n))).toEqual([
      "Recovered https://dead.test/page-a from the Wayback Machine (snapshot 20220101000000).",
    ]);

    expect(dossier(dir)).toMatchInlineSnapshot(`
      {
        "manifest": {
          "backends": [
            "wikipedia",
            "duckduckgo",
            "standards",
          ],
          "backendsUsed": [
            "duckduckgo",
            "duckduckgo",
          ],
          "cache": {
            "enabled": false,
            "hits": 0,
          },
          "coverage": {
            "terms": [
              {
                "sources": 1,
                "term": "token",
              },
              {
                "sources": 1,
                "term": "bucket",
              },
              {
                "sources": 0,
                "term": "sliding",
              },
              {
                "sources": 0,
                "term": "window",
              },
              {
                "sources": 1,
                "term": "rate",
              },
              {
                "sources": 0,
                "term": "counter",
              },
            ],
            "under": [
              "token",
              "bucket",
              "sliding",
              "window",
              "rate",
              "counter",
            ],
          },
          "depth": "standard",
          "enginesFused": [
            "duckduckgo",
          ],
          "extras": [],
          "lang": "en",
          "maxSources": 25,
          "mode": "topic",
          "notes": [
            "Wikipedia returned no usable pages.",
            "Standards backends (IETF datatracker + MDN) were unreachable.",
            "Standards backend found no matching specs.",
            "DuckDuckGo returned 1 result(s).",
            "DuckDuckGo returned 1 result(s).",
            "Could not fetch https://dead.test/page-a (status 404).",
            "Recovered https://dead.test/page-a from the Wayback Machine (snapshot 20220101000000).",
            "Dropped 1 duplicate result(s) across backends.",
            "Gap round searched "token bucket sliding window rate counter" for under-covered term(s): token, bucket, sliding, window, rate, counter.",
            "No WebSearch lane this run: discovery fell back to the keyless engines, which are best-effort. If you have a WebSearch tool, run it and pass the hits with --web-results <file.json> — it is the strongest engine available here.",
            "Helpers: searxng not in this mode's backends · firecrawl ✗ not used. Run \`ultrasearch doctor\` to see what is available.",
            "Thin dossier: only 1 on-topic source(s) (recall floor 6). Enrich the thin areas with your own WebSearch and fold the round in with \`ingest --web-results\` before writing.",
            "Under-covered term(s): token, bucket, sliding, window, rate, counter — fewer than 2 of the top sources mention them. Search these yourself and fold the round in with \`ingest --web-results\` before writing, or say so under "Open questions".",
            "agent: run another WebSearch round at the thin areas and fold the WHOLE round in with \`ultrasearch ingest --run <dir> --web-results <f.json>\` (one process, not one per URL) before writing the report.",
          ],
          "pages": 2,
          "question": "token bucket sliding window rate counter",
          "recallFloor": {
            "count": 1,
            "floor": 6,
          },
          "searchProfile": "full",
          "services": {
            "firecrawl": {
              "pages": 0,
            },
            "pdf": {},
            "searxng": {
              "requested": false,
              "sources": 0,
            },
          },
          "slug": "topic-token-bucket-sliding-window-rate-counter",
          "sourceCount": 1,
          "tiers": [
            "SUMMARY.md",
            "REPORT.md",
          ],
          "webSearch": {
            "kept": 0,
            "rejected": 0,
            "supplied": 0,
          },
        },
        "sources": [
          {
            "backend": "duckduckgo",
            "canonicalUrl": "https://dead.test/page-a",
            "domain": "dead.test",
            "extract": "sources/S1.md",
            "id": "S1",
            "lang": "en",
            "meta": {
              "foundBy": 2,
              "rank": {
                "content": 1,
                "recency": 0.5,
                "rrf": 1,
                "trust": 0.5,
              },
              "waybackSnapshot": "20220101000000",
            },
            "score": 0.9,
            "signals": [
              "cites 0 external source(s) · surfaced by 2 engine(s) · declares no persistent identity",
            ],
            "snippet": "token bucket only",
            "title": "Token bucket",
            "trust": 0.5,
            "url": "https://dead.test/page-a",
          },
        ],
      }
    `);

    rmSync(dir, { recursive: true, force: true });
  });
});

// PubMed hands back a DOI url; the same PubMed landing page is ALSO a plain web
// hit. Different identities (doi: vs url:), so both survive fusion — and the
// slower of the two is still in flight when the other reaches for it as its
// fallback. One page, one fetch.
const PUBMED_ARTICLE = `<html><head><title>A programmable dual-RNA-guided DNA endonuclease</title></head><body><article>
  <p>${"Cas9 is a DNA endonuclease guided to its target by a dual-RNA structure that meters cleavage. ".repeat(8)}</p>
</article></body></html>`;
const DDG_PUBMED = `
<a class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fpubmed.ncbi.nlm.nih.gov%2F28495875%2F">Cas9 endonuclease</a>
<a class="result__snippet">dual-RNA guided endonuclease</a>`;

describe("gather hydration: two workers reaching for one URL fetch it once", () => {
  it("dedupes an in-flight fetch shared by a source and another source's fallback", async () => {
    process.env.ULTRASEARCH_NO_WAYBACK = "1";
    let pageCalls = 0;
    const spy = installFetchMock((url) => {
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
      if (url.includes("html.duckduckgo.com")) return { body: DDG_PUBMED };
      if (url.includes("doi.org")) return { status: 403, body: "paywall" }; // resolves instantly
      if (url.includes("pubmed.ncbi.nlm.nih.gov/28495875")) {
        pageCalls++;
        return { body: PUBMED_ARTICLE, delayMs: 60 }; // still in flight when the DOI source gives up
      }
      return undefined;
    });

    const dir = mkdtempSync(join(tmpdir(), "us-inflight-"));
    await runGather(opts({ question: "Cas9 dual RNA guided endonuclease", backends: ["pubmed", "duckduckgo"], out: dir }));

    expect(pageCalls).toBe(1);
    expect(spy.mock.calls.map((c) => String(c[0])).filter((u) => u.includes("efetch.fcgi"))).toEqual([]); // the fallback never had to look further
    const sources = JSON.parse(readFileSync(join(dir, "sources.json"), "utf8")) as Source[];
    expect(sources.length).toBeGreaterThan(0);
    expect(sources.every((s) => s.fullText !== false)).toBe(true); // both items got the text
    rmSync(dir, { recursive: true, force: true });
  });
});
