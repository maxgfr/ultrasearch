import { afterEach, describe, expect, it, vi } from "vitest";
import { assessPdfText, extractPdf, enabledExtractors, resetPdfLadderCache } from "../src/backends/pdf.js";

afterEach(() => {
  vi.unstubAllEnvs();
  resetPdfLadderCache();
});

// Text long enough to clear the shape-check floor, so the ratio checks are what
// decide — the way real extractions are judged.
const PROSE = "Recurrent neural networks have been firmly established as state of the art approaches in sequence modelling and machine translation. ".repeat(4);

function withControlBytes(prose: string, n: number): string {
  return prose + String.fromCharCode(2).repeat(n);
}

describe("assessPdfText", () => {
  it("accepts ordinary extracted prose", () => {
    expect(assessPdfText(PROSE).ok).toBe(true);
  });

  it("accepts a short but clean extraction — it judges garbage, not brevity", () => {
    expect(assessPdfText("Figure 1.").ok).toBe(true);
  });

  it("rejects an empty extraction with a scanned-PDF reason", () => {
    expect(assessPdfText("")).toMatchObject({ ok: false });
    expect(assessPdfText("   \n ").reason).toMatch(/no text layer/i);
  });

  // The failure this whole gate exists for: a stream of image/font bytes that
  // inflated, contained `Tj`, and got mined as text. It is long and non-empty,
  // so every length-gated check downstream waves it through.
  it("rejects text laced with binary control bytes, however long", () => {
    const v = assessPdfText(withControlBytes(PROSE, Math.ceil(PROSE.length * 0.05)));
    expect(v.ok).toBe(false);
    expect(v.reason).toMatch(/binary\/control/i);
  });

  it("tolerates the stray control byte a clean extractor leaves behind", () => {
    // pdftotext keeps a few form feeds: ~4e-4 of the text. Must not trip the gate.
    expect(assessPdfText(withControlBytes(PROSE, 1)).ok).toBe(true);
  });

  it("rejects a wall of replacement characters (wrong character map)", () => {
    const v = assessPdfText(PROSE + "�".repeat(Math.ceil(PROSE.length * 0.05)));
    expect(v.ok).toBe(false);
    expect(v.reason).toMatch(/replacement characters/i);
  });

  it("rejects one enormous unbroken run of non-letters", () => {
    const v = assessPdfText("=".repeat(900) + "/".repeat(200));
    expect(v.ok).toBe(false);
    expect(v.reason).toMatch(/unreadable/i);
  });
});

describe("enabledExtractors", () => {
  it("defaults to the full ladder, strongest first", () => {
    vi.stubEnv("ULTRASEARCH_PDF_ENGINE", undefined);
    expect(enabledExtractors()).toEqual(["pdf-inspector", "anydoc", "firecrawl", "pdftotext", "native"]);
  });

  it("drops BOTH rungs that need an implicit install under ULTRASEARCH_NO_NPX", () => {
    vi.stubEnv("ULTRASEARCH_PDF_ENGINE", undefined);
    vi.stubEnv("ULTRASEARCH_NO_NPX", "1");
    expect(enabledExtractors()).not.toContain("pdf-inspector");
    expect(enabledExtractors()).not.toContain("anydoc");
    expect(enabledExtractors()).toContain("pdftotext");
  });

  it("honours ULTRASEARCH_PDF_ENGINE by running exactly that rung", () => {
    vi.stubEnv("ULTRASEARCH_PDF_ENGINE", "native");
    expect(enabledExtractors()).toEqual(["native"]);
  });

  it("ignores an unknown engine name rather than emptying the ladder", () => {
    vi.stubEnv("ULTRASEARCH_PDF_ENGINE", "nope");
    expect(enabledExtractors()).toEqual(["pdf-inspector", "anydoc", "firecrawl", "pdftotext", "native"]);
  });
});

// The ladder is driven through `engines` + an injected Firecrawl callback, so
// these stay offline and never shell out to npx or poppler.
describe("extractPdf", () => {
  const SCANNED = Buffer.from("%PDF-1.4\nstream\n/Image only, no text operators\nendstream\n", "latin1");
  const TEXTUAL = Buffer.from(`%PDF-1.4\nstream\nBT (${PROSE}) Tj ET\nendstream\n`, "latin1");

  it("returns the first rung whose output passes the gate", async () => {
    const r = await extractPdf(TEXTUAL, { engines: ["native"] });
    expect(r.via).toBe("native");
    expect(r.text).toContain("Recurrent neural networks");
  });

  it("falls through to the next rung when one yields nothing usable", async () => {
    const firecrawl = vi.fn(async () => PROSE);
    const r = await extractPdf(SCANNED, { engines: ["native", "firecrawl"], firecrawl });
    expect(r.via).toBe("firecrawl");
    expect(firecrawl).toHaveBeenCalledOnce();
  });

  it("skips the Firecrawl rung silently when no container is injected", async () => {
    const r = await extractPdf(SCANNED, { engines: ["firecrawl", "native"] });
    expect(r.via).toBeUndefined();
    expect(r.text).toBe("");
  });

  // The point of the whole exercise: when nothing can read the PDF, say so
  // instead of handing a caller text that will end up under a citation.
  it("refuses with a reason when every rung fails", async () => {
    const r = await extractPdf(SCANNED, { engines: ["native"] });
    expect(r.text).toBe("");
    expect(r.via).toBeUndefined();
    expect(r.reason).toMatch(/no text layer/i);
  });

  it("never throws, whatever the bytes are", async () => {
    const r = await extractPdf(Buffer.from([0x00, 0xff, 0xfe, 0x01]), { engines: ["native"] });
    expect(r.text).toBe("");
  });

  // The two rungs that shell out, exercised without network and without caring
  // what the machine has installed: an empty PATH makes both binaries ENOENT, so
  // the spawn path runs and each rung reports itself unavailable. Covers the
  // real invocations (npx -y --prefer-offline …, pdftotext -layout - -) that the
  // suite otherwise never reaches, since setup.ts pins the ladder to `native`.
  it("falls through when neither external extractor can be launched", async () => {
    vi.stubEnv("PATH", "/nonexistent-ultrasearch-test");
    const r = await extractPdf(TEXTUAL, { engines: ["pdf-inspector", "pdftotext"] });
    expect(r.via).toBeUndefined();
    expect(r.text).toBe("");
  });

  // Without this, a 40-source run would re-pay a 90s npx discovery per PDF.
  it("remembers an unavailable rung instead of retrying it for every PDF", async () => {
    const firecrawl = vi.fn(async () => undefined);
    await extractPdf(SCANNED, { engines: ["firecrawl", "native"], firecrawl });
    await extractPdf(SCANNED, { engines: ["firecrawl", "native"], firecrawl });
    // Firecrawl is the exception — its own client memoises the probe, and it can
    // legitimately fail on one URL and work on the next, so it IS retried.
    expect(firecrawl).toHaveBeenCalledTimes(2);
  });
});
