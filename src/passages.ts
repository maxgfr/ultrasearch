import { buildMatcher, capExtract } from "./engine.js";
import type { Manifest } from "./types.js";

const OMISSION_NOTICE = "[Other source text omitted; passages selected for the question. Character positions use UTF-16 offsets in the fetched extract.]";

// Positions and source lengths are engine metadata, not facts stated by the
// source. Keep the stored extract intact for fingerprints and relinking; only
// grounding consumers remove these annotations from the evidence they search.
export function sourceTextWithoutPassageLabels(text: string): string {
  return text
    .split("\n")
    .filter((line) => {
      const trimmed = line.trim();
      return !/^\[Source passage: characters \d+-\d+ of \d+\]$/.test(trimmed) && trimmed !== OMISSION_NOTICE;
    })
    .join("\n");
}

/**
 * Where the window opening at `start` ends: 800 characters on, pulled back to
 * the last line break or sentence end in its second half when there is one.
 *
 * Only a boundary past `start + 400` is ever used, so only that stretch is
 * searched. `lastIndexOf(x, end)` over the whole text walks back to the start
 * of the EXTRACT when no boundary exists — on a page with no line break
 * (minified text, one long table) every window then cost the size of
 * everything before it: seconds on a 3 MB extract.
 */
export function windowEnd(text: string, start: number): number {
  const end = Math.min(text.length, start + 800);
  if (end >= text.length) return end;
  const from = start + 401;
  const paragraph = text.slice(from, end + 1).lastIndexOf("\n");
  const sentence = text.slice(from, end + 2).lastIndexOf(". ");
  const boundary = Math.max(paragraph, sentence);
  if (boundary >= 0) return from + boundary + 1;
  // Avoid splitting a UTF-16 surrogate pair at a window boundary.
  return /[\uD800-\uDBFF]/.test(text[end - 1]!) ? end - 1 : end;
}

// Rank bounded, contiguous windows of the complete fetched text. The source
// slices stay verbatim; offsets refer to the original extract, not this digest.
export function selectSourcePassages(text: string, question: string, depth: Manifest["depth"]): string {
  const cap = depth === "deep" ? Infinity : depth === "standard" ? 8000 : 4000;
  if (text.length <= cap || !question.trim()) return capExtract(text, depth);
  const matcher = buildMatcher(question);
  const candidates: { start: number; end: number; score: number }[] = [];
  for (let start = 0; start < text.length; ) {
    const end = windowEnd(text, start);
    const score = matcher.matchLine(text.slice(start, end)).size;
    if (score) {
      let contextStart = Math.max(0, start - 160);
      let contextEnd = Math.min(text.length, end + 160);
      // Context padding creates new boundaries: preserve complete surrogate
      // pairs here too, or writing the verbatim slice as UTF-8 replaces them.
      if (contextStart > 0 && /[\uDC00-\uDFFF]/.test(text[contextStart]!) && /[\uD800-\uDBFF]/.test(text[contextStart - 1]!)) contextStart--;
      if (contextEnd < text.length && /[\uD800-\uDBFF]/.test(text[contextEnd - 1]!) && /[\uDC00-\uDFFF]/.test(text[contextEnd]!)) contextEnd++;
      candidates.push({ start: contextStart, end: contextEnd, score });
    }
    start = end;
  }
  if (!candidates.length) return capExtract(text, depth);
  candidates.sort((a, b) => b.score - a.score || a.start - b.start);
  const selected: { start: number; end: number }[] = [];
  const maxPassages = depth === "summary" ? 3 : 6;
  let remaining = cap - 800; // source-position labels and the omission notice
  for (const candidate of candidates) {
    if (selected.length >= maxPassages) break;
    if (selected.some((w) => candidate.start < w.end && candidate.end > w.start)) continue;
    const length = candidate.end - candidate.start;
    if (length > remaining) continue;
    selected.push(candidate);
    remaining -= length;
  }
  if (!selected.length) return capExtract(text, depth);
  selected.sort((a, b) => a.start - b.start);
  return (
    selected.map((w) => `[Source passage: characters ${w.start + 1}-${w.end} of ${text.length}]\n${text.slice(w.start, w.end)}`).join("\n\n") +
    `\n\n${OMISSION_NOTICE}`
  );
}
