import { buildMatcher, capExtract } from "./engine.js";
import type { Manifest } from "./types.js";

// Rank bounded, contiguous windows of the complete fetched text. The source
// slices stay verbatim; offsets refer to the original extract, not this digest.
export function selectSourcePassages(text: string, question: string, depth: Manifest["depth"]): string {
  const cap = depth === "deep" ? Infinity : depth === "standard" ? 8000 : 4000;
  if (text.length <= cap || !question.trim()) return capExtract(text, depth);
  const matcher = buildMatcher(question);
  const candidates: { start: number; end: number; score: number }[] = [];
  for (let start = 0; start < text.length; ) {
    let end = Math.min(text.length, start + 800);
    if (end < text.length) {
      const paragraph = text.lastIndexOf("\n", end);
      const sentence = text.lastIndexOf(". ", end);
      const boundary = Math.max(paragraph, sentence);
      if (boundary > start + 400) end = boundary + 1;
      // Avoid splitting a UTF-16 surrogate pair at a window boundary.
      else if (/[\uD800-\uDBFF]/.test(text[end - 1]!)) end--;
    }
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
    "\n\n[Other source text omitted; passages selected for the question. Character positions use UTF-16 offsets in the fetched extract.]"
  );
}
