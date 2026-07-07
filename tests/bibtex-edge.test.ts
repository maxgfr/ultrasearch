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

// Edge branches of bibtex.ts: a citable-by-year-only source (no author/doi/
// arxiv/venue), a source with no url, and a title with no long word (key falls
// back to the source id).
describe("toBibtex — edge cases", () => {
  it("emits a minimal @article for a year-only source (no author/doi/eprint/journal)", () => {
    const bib = toBibtex([s({ id: "S1", title: "Some Networking Study", meta: { year: 2019 } })]);
    expect(bib).toContain("year = {2019}");
    expect(bib).toContain("url = {https://x.test}");
    expect(bib).toContain("note = {ultrasearch source S1}");
    expect(bib).not.toContain("author = {");
    expect(bib).not.toContain("doi = {");
    expect(bib).not.toContain("eprint = {");
    expect(bib).not.toContain("journal = {");
  });

  it("omits the url field for a source with no url", () => {
    const bib = toBibtex([s({ id: "S1", url: "", title: "Untitled Work", meta: { year: 2021 } })]);
    expect(bib).toContain("year = {2021}");
    expect(bib).not.toContain("url = {");
  });

  it("keys off the source id when the title has no word longer than three chars", () => {
    const bib = toBibtex([s({ id: "S7", title: "AI ML", meta: { year: 2020 } })]);
    // no author, no long title word → base = id + year
    expect(bib).toMatch(/@article\{s72020/);
  });
});
