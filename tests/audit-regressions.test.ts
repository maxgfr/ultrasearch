import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { extractMainHtml, htmlToText, decodeEntities } from "../src/backends/fetch.js";
import { pubmedBackend } from "../src/backends/pubmed.js";
import { openalexBackend } from "../src/backends/openalex.js";
import { semanticscholarBackend } from "../src/backends/semanticscholar.js";
import { dblpBackend } from "../src/backends/dblp.js";
import { searxngBackend } from "../src/backends/searxng.js";
import { marginaliaBackend } from "../src/backends/marginalia.js";
import { runCheck } from "../src/check.js";
import { runVerify } from "../src/verify.js";
import { mdToHtml } from "../src/render.js";
import { writeDossier, readDossier } from "../src/dossier.js";
import type { Manifest, RawSource } from "../src/types.js";
import { installFetchMock, routes } from "./fetchmock.js";
import { makeCtx } from "./ctx.js";

afterEach(() => vi.unstubAllGlobals());

// These are regression tests for real bugs found in the parser/engine audit —
// each FAILED before its fix. Kept fixture-based so the offline suite guards
// them forever (the live backends can't).

function dossier(dir: string, n: number): void {
  const raws: RawSource[] = Array.from({ length: n }, (_, k) => ({
    url: `https://x.test/${k + 1}`,
    title: `T${k + 1}`,
    backend: "duckduckgo",
    score: n - k,
    snippet: `snippet ${k + 1}`,
    text: `body content number ${k + 1} `.repeat(20),
  }));
  const manifest: Manifest = {
    version: "1.0.0",
    question: "rate limiting",
    mode: "topic",
    depth: "standard",
    lang: "en",
    backends: ["duckduckgo"],
    backendsUsed: ["duckduckgo"],
    sourceCount: n,
    maxSources: 25,
    builtAt: "2026-06-14T10:00:00.000Z",
    slug: "topic-rl",
    tiers: ["SUMMARY.md", "REPORT.md"],
    extras: [],
    notes: [],
    timings: {},
  };
  writeDossier(dir, raws, manifest, "## TL;DR\n## Sources");
}

describe("fetch.ts — extractMainHtml balanced container", () => {
  it("keeps the whole content div when it wraps a nested block div", () => {
    const intro = "Article intro about rate limiting is quite important here. ".repeat(15);
    const rest = "CONCLUSION leaky buckets smooth bursty traffic nicely. ".repeat(15);
    const html =
      `<body><div class="entry-content"><p>${intro}</p>` +
      `<div class="wp-block-image"><figcaption>a chart</figcaption></div>` +
      `<p>${rest}</p></div><footer>${"footer junk ".repeat(40)}</footer></body>`;
    const text = htmlToText(extractMainHtml(html));
    expect(text).toContain("CONCLUSION"); // was truncated at the first nested </div>
    expect(text).toContain("Article intro");
    expect(text).not.toContain("footer junk");
  });
});

describe("fetch.ts — decodeEntities named entities", () => {
  it("decodes common typographic and accented named entities", () => {
    const out = decodeEntities("R&amp;D caf&eacute; &ldquo;quote&rdquo; user&rsquo;s 5&nbsp;&euro; 100&pound; &mdash; &copy;");
    expect(out).toContain("café");
    expect(out).toContain("€");
    expect(out).toContain("£");
    expect(out).toContain("R&D");
    // no named entity references survive
    expect(out).not.toMatch(/&(rsquo|lsquo|ldquo|rdquo|eacute|euro|pound|agrave|ccedil);/);
  });
});

describe("scholarly backends — title sanitization", () => {
  it("pubmed decodes entities and strips inline markup in titles", async () => {
    installFetchMock((url) => {
      if (url.includes("esearch.fcgi")) return { body: JSON.stringify({ esearchresult: { idlist: ["1"] } }), contentType: "application/json" };
      if (url.includes("esummary.fcgi"))
        return {
          body: JSON.stringify({
            result: {
              uids: ["1"],
              "1": { title: "Role of <i>Escherichia coli</i> in R&amp;D.", pubdate: "2012", source: "Science", authors: [], articleids: [] },
            },
          }),
          contentType: "application/json",
        };
      return undefined;
    });
    const r = await pubmedBackend(makeCtx("e coli"));
    expect(r.items[0]!.title).toBe("Role of Escherichia coli in R&D");
    expect(r.items[0]!.title).not.toMatch(/<\/?i>|&amp;/);
  });

  it("openalex strips inline markup / entities in titles", async () => {
    const body = JSON.stringify({ results: [{ title: "Deep <i>learning</i> &amp; nets", authorships: [], publication_year: 2020 }] });
    installFetchMock(routes([["api.openalex.org", { body, contentType: "application/json" }]]));
    const r = await openalexBackend(makeCtx("dl"));
    expect(r.items[0]!.title).toBe("Deep learning & nets");
  });

  it("semanticscholar strips inline markup / entities in titles", async () => {
    const body = JSON.stringify({ data: [{ title: "A &amp; B <sub>2</sub>", authors: [], externalIds: {} }] });
    installFetchMock(routes([["api.semanticscholar.org", { body, contentType: "application/json" }]]));
    const r = await semanticscholarBackend(makeCtx("ab"));
    expect(r.items[0]!.title).toBe("A & B 2");
  });
});

describe("dblp — array-valued ee/doi", () => {
  it("uses the first ee when the field is an array (no data loss)", async () => {
    const body = JSON.stringify({
      result: {
        hits: {
          "@total": "1",
          hit: {
            info: {
              title: "Preprint.",
              year: "2021",
              ee: ["https://arxiv.org/abs/2101.00001", "https://arxiv.org/pdf/2101.00001"],
              url: "https://dblp.org/rec/x",
            },
          },
        },
      },
    });
    installFetchMock(routes([["dblp.org/search/publ", { body, contentType: "application/json" }]]));
    const r = await dblpBackend(makeCtx("x"));
    expect(r.items[0]!.url).toBe("https://arxiv.org/abs/2101.00001");
  });

  it("uses the first doi when the field is an array (valid DOI url + bibtex)", async () => {
    const body = JSON.stringify({
      result: { hits: { "@total": "1", hit: { info: { title: "P.", year: "2020", doi: ["10.1/a", "10.1/b"], url: "https://dblp.org/rec/y" } } } },
    });
    installFetchMock(routes([["dblp.org/search/publ", { body, contentType: "application/json" }]]));
    const r = await dblpBackend(makeCtx("x"));
    expect(r.items[0]!.url).not.toContain(","); // was https://doi.org/10.1/a,10.1/b
    expect(String(r.items[0]!.meta?.doi)).not.toContain(",");
  });
});

describe("JSON web backends — empty-string title fallback", () => {
  it("searxng falls back to the URL when a result title is empty", async () => {
    const body = JSON.stringify({ results: [{ url: "https://a.test/1", title: "", content: "c" }] });
    installFetchMock(routes([["format=json", { body, contentType: "application/json" }]]));
    const r = await searxngBackend(makeCtx("q", { searxng: "http://localhost:8888" }));
    expect(r.items[0]!.title).toBe("https://a.test/1");
  });

  it("marginalia falls back to the URL when a result title is empty", async () => {
    const body = JSON.stringify({ results: [{ url: "https://b.test/1", title: "", description: "d" }] });
    installFetchMock(routes([["api.marginalia-search.com", { body, contentType: "application/json" }]]));
    const r = await marginaliaBackend(makeCtx("q"));
    expect(r.items[0]!.title).toBe("https://b.test/1");
  });
});

describe("check.ts — malformed dossier + blockquote grounding", () => {
  it("does not throw (returns ungrounded) on a valid-JSON but non-array sources.json", () => {
    const dir = mkdtempSync(join(tmpdir(), "us-audit-check-"));
    writeFileSync(join(dir, "sources.json"), "{}");
    writeFileSync(join(dir, "REPORT.md"), "# X\nA substantive grounded-looking claim about rate limiting here [S1].");
    expect(() => runCheck(dir)).not.toThrow();
    expect(runCheck(dir).ok).toBe(false);
    rmSync(dir, { recursive: true, force: true });
  });

  it("flags a fabricated blockquote directly after a sourced line (no blank line)", () => {
    const dir = mkdtempSync(join(tmpdir(), "us-audit-bq-"));
    dossier(dir, 2);
    writeFileSync(
      join(dir, "REPORT.md"),
      "# X\nRate limiting caps how many requests a client may make per window here [S1].\n> The IETF formally banned leaky buckets across all EU member states in 2024 with no source at all.",
    );
    expect(runCheck(dir).ok).toBe(false); // the blockquote claim is unsourced
    rmSync(dir, { recursive: true, force: true });
  });
});

describe("render.ts — inline formatting isolation", () => {
  it("does not linkify a [S#] inside an inline-code span", () => {
    const { html } = mdToHtml("Write the citation as `[S99]` in the text.", "report");
    expect(html).not.toContain('href="#src-S99"');
    expect(html).toContain("<code>[S99]</code>");
  });

  it("does not inject <em> into a link URL that contains underscores", () => {
    const { html } = mdToHtml("See [the doc](https://site.com/path/_internal_docs).", "report");
    expect(html).toContain('href="https://site.com/path/_internal_docs"');
    expect(html).not.toContain("<em>internal</em>");
  });
});

describe("readDossier / verify — non-array sources.json", () => {
  it("readDossier throws a clean named error (not a raw TypeError) on a non-array sources.json", () => {
    const dir = mkdtempSync(join(tmpdir(), "us-audit-rd-"));
    writeFileSync(join(dir, "sources.json"), "null");
    writeFileSync(join(dir, "manifest.json"), "{}");
    expect(() => readDossier(dir)).toThrow(/not a JSON array/);
    rmSync(dir, { recursive: true, force: true });
  });

  it("runVerify throws a clean named error on a non-array sources.json", () => {
    const dir = mkdtempSync(join(tmpdir(), "us-audit-rv-"));
    writeFileSync(join(dir, "sources.json"), "42");
    expect(() => runVerify(dir)).toThrow(/not a JSON array/);
    rmSync(dir, { recursive: true, force: true });
  });
});
