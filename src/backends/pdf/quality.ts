// Is this extracted PDF text fit to be cited?
//
// This is the rung test for the extractor ladder (see ladder.ts) AND the last
// gate before a PDF's text enters a dossier. It exists because the built-in
// text-layer reader can hand back output that LOOKS like prose but isn't: a
// stream of image/font bytes that happened to inflate and contain `Tj`, or a
// CID-font page decoded through the wrong code map. Such text is long, non-empty
// and plausible, so nothing downstream catches it — `looksLikeJunkExtraction`
// only inspects the first 800 chars of texts SHORTER than 2000 and only looks
// for consent/anti-bot walls.
//
// A false positive costs one rung (we fall through to the next extractor, or
// keep the search snippet). A false negative puts fabricated evidence under a
// citation. So the checks below key on signals that essentially never occur in
// real prose, rather than on anything stylistic.

export interface PdfVerdict {
  ok: boolean;
  /** Short, human-readable cause when `ok` is false. */
  reason?: string;
}

// The two weaker heuristics below need enough text to mean anything; under this
// length only the control/replacement ratios apply. Note there is deliberately
// no minimum LENGTH for acceptance: this gate judges garbage, not brevity. A
// short-but-clean extraction is the caller's problem (it degrades to a snippet
// like any other thin source), not something to relabel as unreadable.
const MIN_CHARS_FOR_SHAPE_CHECKS = 200;

// Calibrated on a real corpus (arXiv 1706.03762 and 2404.19756, each through
// every rung). Clean extractors land at 0 – 4.0e-4 (pdftotext keeps a few form
// feeds); the built-in reader's garbage lands at 4.5e-2 – 1.7e-1. 5e-3 sits an
// order of magnitude clear of both sides.
const CONTROL_RATIO_MAX = 0.005;
const REPLACEMENT_RATIO_MAX = 0.005;

// Mojibake also shows up as absurdly long unbroken runs (no spaces survive the
// mis-decoding) and as a collapsed share of letters.
const LONGEST_RUN_MAX = 300;
const LETTER_RATIO_MIN = 0.5;

// C0 controls (minus tab/LF/CR) and C1 controls are the strongest tell: real
// text, in any language and any encoding, does not contain them, while binary
// read as latin1 is full of them. Tested by code point rather than as a literal
// character class so this file stays free of raw control bytes (which would make
// git and grep treat it as binary — see tests/source-hygiene.test.ts).
function isControlCode(c: number): boolean {
  if (c === 0x09 || c === 0x0a || c === 0x0d) return false;
  return c < 0x20 || (c >= 0x7f && c <= 0x9f);
}

const REPLACEMENT_CODE = 0xfffd; // U+FFFD: a decoder already gave up on these bytes.

function scanRatios(t: string): { control: number; replacement: number } {
  let control = 0;
  let replacement = 0;
  for (let i = 0; i < t.length; i++) {
    const c = t.charCodeAt(i);
    if (c === REPLACEMENT_CODE) replacement++;
    else if (isControlCode(c)) control++;
  }
  return { control: control / t.length, replacement: replacement / t.length };
}

/**
 * Judge extracted PDF text. Returns `{ ok: true }` when the text is safe to
 * cite, else a short reason the caller can put in a dossier note.
 *
 * Deliberately independent of length: the failure this guards against produces
 * HUNDREDS of kilobytes, which is exactly what a length-gated check misses.
 */
export function assessPdfText(text: string): PdfVerdict {
  const t = text.trim();
  if (!t) return { ok: false, reason: "no text layer (scanned or image-only PDF?)" };

  const { control, replacement } = scanRatios(t);
  if (control > CONTROL_RATIO_MAX) {
    return { ok: false, reason: "binary/control characters in the text (undecodable PDF stream)" };
  }
  if (replacement > REPLACEMENT_RATIO_MAX) {
    return { ok: false, reason: "replacement characters throughout (wrong character map)" };
  }

  // Two weaker signals, both required: a page of dense tabular data can trip
  // either one on its own.
  if (t.length < MIN_CHARS_FOR_SHAPE_CHECKS) return { ok: true };
  let longestRun = 0;
  for (const w of t.split(/\s+/)) if (w.length > longestRun) longestRun = w.length;
  const letters = (t.match(/\p{L}|\p{N}/gu)?.length ?? 0) / t.replace(/\s+/g, "").length;
  if (longestRun > LONGEST_RUN_MAX && letters < LETTER_RATIO_MIN) {
    return { ok: false, reason: "unreadable text layer (garbled glyph encoding)" };
  }

  return { ok: true };
}
