import { describe, expect, it } from "vitest";
import { deflateSync } from "node:zlib";
import { extractMainHtml } from "../src/backends/fetch.js";
import { pdfToText } from "../src/backends/pdf.js";

describe("extractMainHtml (readability-lite)", () => {
  it("keeps the <article> and drops surrounding nav/footer chrome", () => {
    const html = `<html><body>
      <nav>${"menu link ".repeat(50)}</nav>
      <article><h1>Real Title</h1><p>${"the real article body about token buckets ".repeat(20)}</p></article>
      <footer>${"footer junk ".repeat(50)}</footer>
    </body></html>`;
    const main = extractMainHtml(html);
    expect(main).toContain("Real Title");
    expect(main).toContain("token buckets");
    expect(main).not.toContain("menu link");
    expect(main).not.toContain("footer junk");
  });

  it("falls back to the full document when no main region is found", () => {
    const html = "<div><p>just some content with no semantic container at all here</p></div>";
    expect(extractMainHtml(html)).toBe(html);
  });

  it("falls back when the matched region is tiny relative to the page", () => {
    const html = `<main>x</main><div>${"lots of real body content here ".repeat(200)}</div>`;
    expect(extractMainHtml(html)).toBe(html);
  });
});

describe("pdfToText (dependency-free, best-effort)", () => {
  function pdf(streamBody: Buffer, filter = ""): Buffer {
    return Buffer.concat([
      Buffer.from(`%PDF-1.5\n4 0 obj\n<< ${filter}/Length ${streamBody.length} >>\nstream\n`, "latin1"),
      streamBody,
      Buffer.from("\nendstream\nendobj\n%%EOF\n", "latin1"),
    ]);
  }

  it("extracts text from an uncompressed content stream", () => {
    const stream = Buffer.from("BT /F1 24 Tf 72 720 Td (Hello World) Tj ET", "latin1");
    expect(pdfToText(pdf(stream))).toContain("Hello World");
  });

  it("inflates a FlateDecode stream and extracts text", () => {
    const content = Buffer.from("BT /F1 12 Tf 72 700 Td (Compressed PDF text here) Tj ET", "latin1");
    const deflated = deflateSync(content);
    expect(pdfToText(pdf(deflated, "/Filter /FlateDecode "))).toContain("Compressed PDF text here");
  });

  it("joins a TJ array into words", () => {
    const stream = Buffer.from("BT [(Token)-250(bucket)-250(rate)] TJ ET", "latin1");
    const out = pdfToText(pdf(stream));
    expect(out).toContain("Token");
    expect(out).toContain("bucket");
    expect(out).toContain("rate");
  });

  it("returns empty (never throws) on non-PDF garbage", () => {
    expect(pdfToText(Buffer.from("this is not a pdf at all"))).toBe("");
  });
});
