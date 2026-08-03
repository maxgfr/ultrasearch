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

  // Regression: on arXiv 1706.03762 the reader used to emit "long short-term
  // memory [ 13 7 in particular", silently deleting "] and gated recurrent ["
  // and "] neural networks". Cause: the TJ-array token pattern excluded "]",
  // so an array was truncated at the first "]" INSIDE one of its strings and
  // everything after it in that array was dropped. The damage is invisible —
  // what survives is fluent, citable prose with clauses missing.
  it("keeps a TJ array whose strings contain a literal ] character", () => {
    const content = "BT [(memory [) -250 (13) -250 (] and gated recurrent [) -250 (7) -250 (] neural networks)] TJ ET";
    const text = pdfToText(pdf(content));
    expect(text).toContain("and gated recurrent");
    expect(text).toContain("neural networks");
  });

  // An operator is preceded by exactly one operand in well-formed PDFs, but
  // real-world streams interleave others. The reader used to keep a single
  // "last string" slot, so anything but the most recent operand was lost.
  it("resolves the showing operator's operand when other operands precede it", () => {
    expect(pdfToText(pdf("BT /F1 12 Tf 1 0 0 1 72 720 Tm (Positioned text) Tj ET"))).toContain("Positioned text");
  });

  it("decodes hex strings, which CID-font pages use throughout", () => {
    // <48656C6C6F> = "Hello"; hex strings used to be ignored entirely.
    expect(pdfToText(pdf("BT <48656C6C6F> Tj ET"))).toContain("Hello");
    expect(pdfToText(pdf("BT [<576F72> -300 <6C64>] TJ ET"))).toContain("Wor ld");
  });
});
