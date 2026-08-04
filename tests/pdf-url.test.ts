import { describe, expect, it } from "vitest";
import { looksLikePdfUrl } from "../src/backends/fetch.js";

// Regression guard for a defect found on a real `research` run: arXiv serves its
// PDFs at `arxiv.org/pdf/<id>` with NO extension, so an extension-only test
// judged them HTML. Two consequences, both measured:
//   * the documented ladder (pdf-inspector → firecrawl → pdftotext → native) ran
//     out of order — fetchAndExtract hands a non-PDF to Firecrawl FIRST, so the
//     preferred rung never ran whenever a Firecrawl container was up;
//   * with the container down it cost a second round-trip per paper (fetch as
//     text, see the content-type, refetch as bytes).
// Fixing it took the same 10-paper run from 53s to 10s.
describe("looksLikePdfUrl", () => {
  it("catches the extension-less /pdf/ routes scholarly hosts actually serve", () => {
    for (const url of [
      "https://arxiv.org/pdf/2502.19732",
      "https://arxiv.org/pdf/2502.19732v4",
      "http://arxiv.org/pdf/2308.04623",
      "https://example.org/pdf/some-report",
      "https://arxiv.org/pdf/2502.19732?download=1",
      "https://arxiv.org/pdf/2502.19732#page=3",
    ]) {
      expect(looksLikePdfUrl(url), url).toBe(true);
    }
  });

  it("still catches a plain .pdf, however it is decorated", () => {
    for (const url of ["https://a.test/paper.pdf", "https://a.test/paper.PDF", "https://a.test/p.pdf?v=2", "https://a.test/p.pdf#page=1"]) {
      expect(looksLikePdfUrl(url), url).toBe(true);
    }
  });

  it("does not mistake a documentation PAGE that merely lives under /pdf/", () => {
    for (const url of [
      "https://a.test/pdf/guide.html",
      "https://a.test/pdf/index.php",
      "https://a.test/pdf/data.json",
      "https://a.test/pdf/notes.md",
      "https://a.test/pdf/report.xml",
    ]) {
      expect(looksLikePdfUrl(url), url).toBe(false);
    }
  });

  it("leaves ordinary pages alone", () => {
    for (const url of [
      "https://arxiv.org/abs/2502.19732", // the abstract page is HTML
      "https://a.test/pdf/", // a directory, not a document
      "https://a.test/pdfviewer",
      "https://a.test/article",
      "https://a.test/a.pdfx",
    ]) {
      expect(looksLikePdfUrl(url), url).toBe(false);
    }
  });
});
