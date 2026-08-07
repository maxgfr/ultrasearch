import { runWithInput, ANYDOC_SPEC, PDF_INSPECTOR_SPEC } from "./exec.js";
import { assessPdfText } from "./quality.js";
import { pdfToText } from "./native.js";

// The PDF extractor ladder: try the strongest tool available, fall through when
// it is missing or its output fails the quality gate, and refuse rather than
// cite what nothing could read.
//
// Same shape as the discovery cascade (SearXNG → DuckDuckGo → … in gather.ts):
// stop at the first rung that returns something good enough. The difference is
// that "good enough" is decided by assessPdfText rather than a result count,
// because a bad PDF extraction is not empty — it is hundreds of kilobytes of
// plausible-looking garbage.
//
// Rung order, and why:
//   1. pdf-inspector  the best output by a wide margin (real Markdown, reading
//                     order, tables). Costs one ~6 MB npx download the first
//                     time it is ever used. Pinned to a compatible range rather
//                     than `latest` — see the specs in ./exec.ts.
//   2. anydoc         the same conversion, reached through the office-document
//                     converter (backends/doc/): anydoc embeds pdf-inspector for
//                     text PDFs, and on a real paper the two outputs differ by a
//                     single trailing newline. It sits here purely for platform
//                     coverage — npm publishes an anydoc binary for darwin-x64
//                     and pdf-inspector does not, so on an Intel Mac this is the
//                     rung that keeps PDFs readable without Docker or poppler.
//                     Costs nothing where rung 1 already worked: it only ever
//                     runs after rung 1 has failed.
//   3. firecrawl      the caller's already-running container. Covers hosts with
//                     no npm at all, and any platform neither binary is built
//                     for, because Docker runs the linux-x64 image there anyway.
//   4. pdftotext      poppler, if it happens to be installed. Fast, no network.
//   5. native         the built-in reader. Always present, frequently wrong;
//                     kept only so an offline machine with no tools at all still
//                     gets something, and gated hard by assessPdfText.

export type PdfExtractorId = "pdf-inspector" | "anydoc" | "firecrawl" | "pdftotext" | "native";

export const PDF_EXTRACTORS: PdfExtractorId[] = ["pdf-inspector", "anydoc", "firecrawl", "pdftotext", "native"];

export interface PdfExtraction {
  text: string;
  /** Which rung produced `text`. Absent when every rung failed. */
  via?: PdfExtractorId;
  /** Why the result is empty, when it is — suitable for a dossier note. */
  reason?: string;
}

export interface PdfLadderOptions {
  /**
   * Fetch this PDF's text through an already-running Firecrawl, or undefined
   * when there is none. Injected by the caller so this module stays free of the
   * Firecrawl client (and so tests can drive the rung without a container).
   */
  firecrawl?: () => Promise<string | undefined>;
  /** Restrict/reorder the ladder. Defaults to PDF_EXTRACTORS. */
  engines?: PdfExtractorId[];
}

// First run may download the pdf-inspector binary (~6 MB); later runs are
// ~0.2s. Generous, but paid at most once per process thanks to `dead` below.
const NPX_TIMEOUT_MS = 90_000;
const PDFTOTEXT_TIMEOUT_MS = 60_000;

// Rungs proven unavailable in this process (npm absent, poppler not installed,
// unsupported platform). Without this, a 40-source run would re-pay the same
// 90s discovery for every single PDF.
const dead = new Set<PdfExtractorId>();

/** Test seam: forget which rungs were found unavailable. */
export function resetPdfLadderCache(): void {
  dead.clear();
}

/**
 * The rungs to try, honouring `ULTRASEARCH_PDF_ENGINE` (force exactly one) and
 * `ULTRASEARCH_NO_NPX` (skip the rung that needs an implicit install).
 *
 * An explicit `engines` list wins over both: it is the most specific instruction
 * available, and it is how callers and tests drive the ladder deterministically
 * without fighting whatever the environment happens to say.
 */
export function enabledExtractors(engines?: PdfExtractorId[]): PdfExtractorId[] {
  if (engines) return engines;
  const forced = process.env.ULTRASEARCH_PDF_ENGINE?.trim() as PdfExtractorId | undefined;
  if (forced && (PDF_EXTRACTORS as string[]).includes(forced)) return [forced];
  // Both npx rungs go, not just the first: `anydoc` needs the same implicit
  // install, so leaving it in would defeat the point of the switch.
  if (process.env.ULTRASEARCH_NO_NPX) return PDF_EXTRACTORS.filter((e) => e !== "pdf-inspector" && e !== "anydoc");
  return PDF_EXTRACTORS;
}

async function viaAnydoc(bytes: Buffer): Promise<string | undefined> {
  // `--format pdf` rather than letting anydoc sniff: this rung is only ever
  // reached with bytes the caller already judged to be a PDF, and naming the
  // format keeps a truncated download from being misread as something else.
  const r = await runWithInput("npx", ["-y", "--prefer-offline", ANYDOC_SPEC, "-", "--format", "pdf"], bytes, NPX_TIMEOUT_MS);
  return r.ok ? r.stdout : undefined;
}

async function viaPdfInspector(bytes: Buffer): Promise<string | undefined> {
  // `-` reads the PDF from stdin. `--prefer-offline` keeps the steady state at
  // one local cache hit instead of a registry round-trip per run; `-y` stops npx
  // asking to install. No user input reaches argv — the PDF travels on stdin.
  const r = await runWithInput("npx", ["-y", "--prefer-offline", PDF_INSPECTOR_SPEC, "-"], bytes, NPX_TIMEOUT_MS);
  return r.ok ? r.stdout : undefined;
}

async function viaPdftotext(bytes: Buffer): Promise<string | undefined> {
  // `-layout` preserves column structure, which is what keeps a two-column
  // paper's sentences from interleaving. Trailing `-` writes to stdout.
  const r = await runWithInput("pdftotext", ["-layout", "-", "-"], bytes, PDFTOTEXT_TIMEOUT_MS);
  return r.ok ? r.stdout : undefined;
}

/**
 * Extract text from PDF bytes, trying each enabled rung in order and returning
 * the first result that `assessPdfText` accepts.
 *
 * Never throws. When every rung fails, returns empty text plus the LAST
 * rejection reason, so the caller can say why the source is unusable instead of
 * silently citing nothing.
 */
export async function extractPdf(bytes: Buffer, opts: PdfLadderOptions = {}): Promise<PdfExtraction> {
  let lastReason: string | undefined;

  for (const id of enabledExtractors(opts.engines)) {
    if (dead.has(id)) continue;

    let text: string | undefined;
    try {
      if (id === "pdf-inspector") text = await viaPdfInspector(bytes);
      else if (id === "anydoc") text = await viaAnydoc(bytes);
      else if (id === "pdftotext") text = await viaPdftotext(bytes);
      else if (id === "firecrawl") text = opts.firecrawl ? await opts.firecrawl() : undefined;
      else text = pdfToText(bytes);
    } catch {
      text = undefined; // a rung must never take the run down
    }

    if (text === undefined) {
      // Tool missing / errored / no container. Never ask again this process —
      // except Firecrawl, whose own client already memoises its availability
      // probe and which can legitimately fail on one URL and work on the next.
      if (id !== "firecrawl") dead.add(id);
      continue;
    }

    const verdict = assessPdfText(text);
    if (verdict.ok) return { text: text.trim(), via: id };
    lastReason = verdict.reason;
  }

  return { text: "", reason: lastReason ?? "no PDF extractor available" };
}
