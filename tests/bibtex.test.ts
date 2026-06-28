import { describe, expect, it } from "vitest";
import { toBibtex } from "../src/bibtex.js";
import type { Source } from "../src/types.js";

function s(over: Partial<Source>): Source {
  return {
    id: "S1",
    url: "https://x.test",
    canonicalUrl: "https://x.test",
    title: "A Paper",
    backend: "arxiv",
    fetchedAt: "2026-06-13T10:00:00.000Z",
    domain: "x.test",
    trust: 0.9,
    score: 1,
    extract: "sources/S1.md",
    snippet: "",
    ...over,
  };
}

describe("toBibtex", () => {
  it("emits an @article with author, year, doi and arXiv eprint", () => {
    const bib = toBibtex([
      s({
        id: "S1",
        title: "Attention Is All You Need",
        meta: { authors: ["Ashish Vaswani", "Noam Shazeer"], year: 2017, arxivId: "1706.03762", doi: "10.x/abc", venue: "NeurIPS" },
      }),
    ]);
    expect(bib).toMatch(/@article\{vaswani2017attention/);
    expect(bib).toContain("author = {Ashish Vaswani and Noam Shazeer}");
    expect(bib).toContain("year = {2017}");
    expect(bib).toContain("doi = {10.x/abc}");
    expect(bib).toContain("eprint = {1706.03762}");
    expect(bib).toContain("archivePrefix = {arXiv}");
  });

  it("skips sources without citable metadata", () => {
    const bib = toBibtex([s({ id: "S1", title: "Just a blog post", backend: "duckduckgo", meta: {} })]);
    expect(bib).toMatch(/No scholarly sources/);
  });

  it("disambiguates duplicate keys", () => {
    const meta = { authors: ["Jane Doe"], year: 2020 };
    const bib = toBibtex([s({ id: "S1", title: "Networks", meta }), s({ id: "S2", title: "Networks", meta })]);
    expect(bib).toMatch(/@article\{doe2020networks,/);
    expect(bib).toMatch(/@article\{doe2020networks2,/);
  });
});
