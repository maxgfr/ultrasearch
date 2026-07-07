import { describe, expect, it } from "vitest";
import { deflateSync } from "node:zlib";
import { pdfToText } from "../src/backends/pdf.js";

// Assemble a one-stream PDF buffer around a raw (uncompressed) content stream.
function pdf(streamBody: Buffer | string): Buffer {
  const body = typeof streamBody === "string" ? Buffer.from(streamBody, "latin1") : streamBody;
  return Buffer.concat([Buffer.from("%PDF-1.4\nstream\n", "latin1"), body, Buffer.from("\nendstream\n%%EOF", "latin1")]);
}

describe("pdfToText", () => {
  it("extracts Tj strings, TJ kerning arrays (as spaces), and ' / T* line breaks", () => {
    const content = "BT\n(Hello) Tj\n[(Wor) -300 (ld)] TJ\nT*\n(second line) '\nET";
    const text = pdfToText(pdf(content));
    expect(text).toContain("Hello");
    expect(text).toContain("Wor ld"); // -300 kerning → a word-break space
    expect(text).toContain("second line");
  });

  it("inflates a FlateDecode content stream (zlib) transparently", () => {
    const raw = "BT (Compressed body text) Tj ET";
    const text = pdfToText(pdf(deflateSync(Buffer.from(raw, "latin1"))));
    expect(text).toContain("Compressed body text");
  });

  it("skips streams with no text operators and returns '' (not a throw)", () => {
    // a stream that inflates/reads but carries only font/xobject noise
    expect(pdfToText(pdf("/Font /Helvetica /Type1 no ops here"))).toBe("");
  });

  it("returns '' for a buffer that is not a PDF at all, never throwing", () => {
    expect(pdfToText(Buffer.from("this is just some bytes, not a pdf", "latin1"))).toBe("");
    expect(pdfToText(Buffer.from([0x00, 0x01, 0x02, 0xff, 0xfe]))).toBe("");
  });

  it("decodes octal escapes and escaped parens inside a literal string", () => {
    const text = pdfToText(pdf("BT (A\\050paren\\051 and \\101) Tj ET")); // \050=( \051=) \101=A
    expect(text).toContain("A(paren) and A");
  });
});
