import { mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { runWithInput } from "./exec.js";

// OCR for scanned PDFs, through `copyable-pdf` (github.com/maxgfr/copyable-pdf).
//
// This is the last rung of the PDF ladder and the only one that can read a page
// with NO text layer. Every other rung mines a text layer that a scan simply
// does not have, so before this existed an image-only PDF could only ever be
// refused — honestly, but with the source contributing nothing.
//
// Three things make this rung different from the others, and all three are why
// it lives in its own module:
//
//   1. It takes a PATH, not stdin. `copyable-pdf` rasterises with pdftoppm and
//      reassembles with pdfunite, so it needs a real file. This module owns that
//      temp directory and removes it on every exit path, including a timeout.
//   2. It is EXPENSIVE — ~2.7s per page at the default 300 DPI on an M-series
//      Mac, so a 30-page scan is a minute. Hence a per-process budget (below):
//      one runaway document must not turn a 40-source run into an hour.
//   3. Its dependencies are checked HERE rather than by the tool. Asked for a
//      missing `tesseract`, copyable-pdf offers to run `brew install` /
//      `sudo apt-get install -y` and waits on stdin for a yes. A research run
//      must never install a system package as a side effect, so the rung is
//      skipped unless both binaries already resolve. (Closing stdin also makes
//      the prompt answer "no" on its own — this is the belt to that braces.)

const DEFAULT_TIMEOUT_MS = 300_000;
const DEFAULT_MAX_DOCS = 3;
const DEFAULT_LANG = "eng";

function envInt(name: string, fallback: number): number {
  const n = Number(process.env[name]);
  return Number.isFinite(n) && n >= 0 ? n : fallback;
}

/** How many documents this process has already OCR'd. */
let spent = 0;

/** Test seam: forget the per-process OCR budget. */
export function resetOcrBudget(): void {
  spent = 0;
}

/** Documents this process may still OCR. */
export function ocrBudgetLeft(): number {
  return Math.max(0, envInt("ULTRASEARCH_OCR_MAX", DEFAULT_MAX_DOCS) - spent);
}

/**
 * Is OCR possible on this machine?
 *
 * Both binaries must resolve: `copyable-pdf` itself, and the `tesseract` it
 * shells out to. Checking tesseract separately is what keeps us out of the
 * install prompt described above — and it makes `doctor` able to say WHICH part
 * is missing, which "OCR unavailable" alone could not.
 */
export async function ocrTools(): Promise<{ copyablePdf: boolean; tesseract: boolean }> {
  const probe = async (cmd: string, args: string[]) => (await runWithInput(cmd, args, Buffer.alloc(0), 20_000)).ok;
  const [copyablePdf, tesseract] = await Promise.all([probe("copyable-pdf", ["--help"]), probe("tesseract", ["--version"])]);
  return { copyablePdf, tesseract };
}

/**
 * OCR a scanned PDF to text, or return undefined when it cannot be done.
 *
 * Undefined (rather than an empty string) means "this rung is unavailable or
 * failed" — the ladder's signal to try the next one and, for a non-firecrawl
 * rung, to stop asking for the rest of the process.
 */
export async function ocrPdf(bytes: Buffer): Promise<string | undefined> {
  if (ocrBudgetLeft() <= 0) return undefined;
  const { copyablePdf, tesseract } = await ocrTools();
  if (!copyablePdf || !tesseract) return undefined;

  const dir = mkdtempSync(join(tmpdir(), "ultrasearch-ocr-"));
  try {
    const input = join(dir, "in.pdf");
    const output = join(dir, "out.pdf");
    writeFileSync(input, bytes);

    // `-m` writes `<output without extension>.md` — layout-preserved text pulled
    // out of the OCR'd PDF. `-l` takes tesseract language codes ("fra+eng"); it
    // is NOT derived from the run's --lang, because a code whose language pack
    // is not installed turns a working rung into a failing one. Opt in when you
    // know the pack is there.
    const lang = process.env.ULTRASEARCH_OCR_LANG?.trim() || DEFAULT_LANG;
    // Empty stdin, deliberately: it closes immediately, so any prompt the tool
    // might reach reads EOF and takes the default instead of hanging.
    const r = await runWithInput(
      "copyable-pdf",
      ["-o", output, "-m", "-l", lang, input],
      Buffer.alloc(0),
      envInt("ULTRASEARCH_OCR_TIMEOUT_MS", DEFAULT_TIMEOUT_MS),
    );
    // Count a document against the budget once it has actually been attempted —
    // a rung skipped for a missing binary costs nothing and must not.
    spent++;
    if (!r.ok) return undefined;

    const md = output.replace(/\.pdf$/, ".md");
    return existsSync(md) ? readFileSync(md, "utf8") : undefined;
  } catch {
    return undefined; // a rung must never take the run down
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
