import { runWithInput } from "../pdf/exec.js";
import { assessExtractedText } from "../pdf/quality.js";
import type { DocFormat } from "./formats.js";

// The office-document extractor ladder: convert a fetched .docx/.pptx/.xlsx/…
// to Markdown, and REFUSE rather than cite what nothing could read.
//
// Same shape as the PDF ladder (../pdf/ladder.ts): try the strongest available
// tool, fall through when it is missing or its output fails the quality gate.
// The reason for refusing is starker here than for PDFs. An office document is
// a ZIP or an OLE stream, so the fallback that used to apply — hand back the
// response body as text — did not degrade the evidence, it fabricated it:
// hundreds of kilobytes of U+FFFD under a citation, with no note saying so.
//
// Rung order, and why:
//   1. anydoc     the only local converter for these formats. One npx download
//                 (~4 MB) the first time it is ever used, then a local cache hit.
//                 Reads the format from the BYTES, so a mislabelled file still
//                 converts — see ./formats.ts.
//   2. firecrawl  the caller's already-running container, injected as a callback
//                 so this module stays free of the client. Covers hosts without
//                 npm, and platforms npm has no anydoc binary for.
//
// There is deliberately no built-in last rung. For PDFs one exists because a
// text layer is plain enough to mine with zlib and a regex; unzipping OOXML and
// walking its parts is a different order of problem, and a wrong answer here is
// worse than no answer.

export type DocExtractorId = "anydoc" | "firecrawl";

export const DOC_EXTRACTORS: DocExtractorId[] = ["anydoc", "firecrawl"];

export interface DocExtraction {
  text: string;
  /** Which rung produced `text`. Absent when every rung failed. */
  via?: DocExtractorId;
  /** Why the result is empty, when it is — suitable for a dossier note. */
  reason?: string;
}

export interface DocLadderOptions {
  /**
   * Convert this document through an already-running Firecrawl, or undefined
   * when there is none. Injected by the caller for the same reason the PDF
   * ladder does it: so this module needs no Firecrawl client, and so tests can
   * drive the rung without a container.
   */
  firecrawl?: () => Promise<string | undefined>;
  /** Restrict/reorder the ladder. Defaults to DOC_EXTRACTORS. */
  engines?: DocExtractorId[];
}

// First run may download the anydoc binary; later runs are near-instant.
// Generous, but paid at most once per process thanks to `dead` below.
const NPX_TIMEOUT_MS = 90_000;

// Rungs proven unavailable in this process (npm absent, Node too old for
// anydoc, unsupported platform). Without this, a 40-source run would re-pay the
// same 90s discovery for every single document.
const dead = new Set<DocExtractorId>();

/** Test seam: forget which rungs were found unavailable. */
export function resetDocLadderCache(): void {
  dead.clear();
}

/**
 * The rungs to try, honouring `ULTRASEARCH_DOC_ENGINE` (force exactly one, or
 * `none` to disable the ladder) and `ULTRASEARCH_NO_NPX` (skip the rung that
 * needs an implicit install).
 *
 * An explicit `engines` list wins over both, exactly as in the PDF ladder: it is
 * the most specific instruction available, and it is how callers and tests drive
 * the ladder deterministically without fighting the environment.
 */
export function enabledDocExtractors(engines?: DocExtractorId[]): DocExtractorId[] {
  if (engines) return engines;
  const forced = process.env.ULTRASEARCH_DOC_ENGINE?.trim();
  if (forced === "none") return [];
  if (forced && (DOC_EXTRACTORS as string[]).includes(forced)) return [forced as DocExtractorId];
  if (process.env.ULTRASEARCH_NO_NPX) return DOC_EXTRACTORS.filter((e) => e !== "anydoc");
  return DOC_EXTRACTORS;
}

async function viaAnydoc(bytes: Buffer, format?: string): Promise<string | undefined> {
  // `-` reads the document from stdin. `--prefer-offline` keeps the steady state
  // at one local cache hit instead of a registry round-trip per run; `-y` stops
  // npx asking to install. No user input reaches argv — the document travels on
  // stdin, and `format` comes from the table in ./formats.ts, never from a URL.
  const args = ["-y", "--prefer-offline", "@firecrawl/anydoc", "-"];
  if (format) args.push("--format", format);
  const r = await runWithInput("npx", args, bytes, NPX_TIMEOUT_MS);
  return r.ok ? r.stdout : undefined;
}

/**
 * Convert an office document to Markdown, trying each enabled rung in order and
 * returning the first result that the quality gate accepts.
 *
 * Never throws. When every rung fails, returns empty text plus the reason, so
 * the caller can say why the source is unusable instead of silently citing
 * nothing — or, worse, citing the raw bytes.
 */
export async function extractDocument(bytes: Buffer, fmt: DocFormat, opts: DocLadderOptions = {}): Promise<DocExtraction> {
  let lastReason: string | undefined;

  for (const id of enabledDocExtractors(opts.engines)) {
    if (dead.has(id)) continue;

    let text: string | undefined;
    try {
      if (id === "anydoc") text = await viaAnydoc(bytes, fmt.format);
      else text = opts.firecrawl ? await opts.firecrawl() : undefined;
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

    const verdict = assessExtractedText(text, "the converter produced no text");
    if (verdict.ok) return { text: text.trim(), via: id };
    lastReason = verdict.reason;
  }

  return { text: "", reason: lastReason ?? "no document converter available" };
}
