// PDF text extraction — public surface.
//
// The implementation now lives in the vendored webindex engine
// (github.com/maxgfr/webindex), pinned in src/vendor/webindex.meta.json. It used
// to live in ./pdf/, in a copy byte-identical to construct's and ultradoc's
// apart from the environment-variable prefix.
//
// This file stays as the import path the rest of the tree already uses, so the
// swap is an implementation change rather than a rename touching every caller.

export {
  pdfToText,
  assessPdfText,
  ocrTools,
  ocrBudgetLeft,
  resetOcrBudget,
  extractPdf,
  enabledExtractors,
  resetPdfLadderCache,
  PDF_EXTRACTORS,
  type PdfVerdict,
  type PdfExtraction,
  type PdfExtractorId,
  type PdfLadderOptions,
} from "../engine.js";
