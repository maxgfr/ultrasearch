import { describe, it, expect } from "vitest";
import { docFormatForUrl, docFormatForContentType, DOC_EXTENSIONS } from "../src/backends/doc.js";

describe("docFormatForUrl", () => {
  it("recognises every office extension it claims to route", () => {
    for (const ext of DOC_EXTENSIONS) {
      expect(docFormatForUrl(`https://x.test/file.${ext}`), ext).toBeDefined();
    }
  });

  it("recognises an extension regardless of case, query or fragment", () => {
    expect(docFormatForUrl("https://x.test/Report.DOCX")).toBeDefined();
    expect(docFormatForUrl("https://x.test/report.docx?v=2")).toBeDefined();
    expect(docFormatForUrl("https://x.test/report.docx#page3")).toBeDefined();
  });

  it("leaves web pages and PDFs alone", () => {
    // PDFs have their own ladder with rungs this one does not have; routing them
    // here would silently downgrade every paper a research run fetches.
    expect(docFormatForUrl("https://x.test/paper.pdf")).toBeUndefined();
    expect(docFormatForUrl("https://x.test/page.html")).toBeUndefined();
    expect(docFormatForUrl("https://x.test/api.json")).toBeUndefined();
    expect(docFormatForUrl("https://x.test/no-extension")).toBeUndefined();
  });

  it("does not mistake a dotted path segment for an extension", () => {
    expect(docFormatForUrl("https://x.test/v1.2/guide")).toBeUndefined();
  });

  // The security property: a format reaching argv must come from the table, so
  // nothing a URL carries can ever become a converter argument.
  it("only ever names a format the table declares — never a slice of the URL", () => {
    expect(docFormatForUrl("https://x.test/evil.docx?x=--output=/etc/passwd")?.format).toBeUndefined();
    expect(docFormatForUrl("https://x.test/data.csv")?.format).toBe("csv");
  });
});

describe("docFormatForContentType", () => {
  it("recognises the OOXML, OpenDocument and legacy office types", () => {
    expect(docFormatForContentType("application/vnd.openxmlformats-officedocument.wordprocessingml.document")).toBeDefined();
    expect(docFormatForContentType("application/vnd.oasis.opendocument.spreadsheet")).toBeDefined();
    expect(docFormatForContentType("application/msword")).toBeDefined();
    expect(docFormatForContentType("application/epub+zip")).toBeDefined();
  });

  it("strips parameters and ignores case", () => {
    expect(docFormatForContentType("TEXT/CSV; charset=utf-8")?.format).toBe("csv");
  });

  it("leaves html, json and pdf alone", () => {
    expect(docFormatForContentType("text/html")).toBeUndefined();
    expect(docFormatForContentType("application/json")).toBeUndefined();
    expect(docFormatForContentType("application/pdf")).toBeUndefined();
    expect(docFormatForContentType("")).toBeUndefined();
  });
});

describe("the text-fallback policy", () => {
  it("refuses binary formats but lets csv fall back to its raw text", () => {
    // A .docx that nothing can convert must refuse: the alternative is citing a
    // decoded ZIP. A .csv was already readable as text before this ladder, so
    // refusing it would be a regression rather than a fix.
    expect(docFormatForUrl("https://x.test/a.docx")?.textFallback).toBe(false);
    expect(docFormatForUrl("https://x.test/a.xlsx")?.textFallback).toBe(false);
    expect(docFormatForUrl("https://x.test/a.epub")?.textFallback).toBe(false);
    expect(docFormatForUrl("https://x.test/a.csv")?.textFallback).toBe(true);
  });
});
