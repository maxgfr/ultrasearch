// Reading the CITING text: where each reference is called ([n], (n),
// superscripts), whether every reference is called and every call has a
// reference, whether first citations run in Vancouver order, and which figures
// each call vouches for.

import { extractNumerals, normalizeNumeralText } from "../engine.js";

/** One call site: the numbers it cites and the text it vouches for. */
export interface CitationCall {
  numbers: number[];
  /** The call as written ("[4,5]", "(12)", "¹⁻³"). */
  token: string;
  /** The sentence it sits in. */
  sentence: string;
  /** The words this call is attached to: the text since the previous call in the sentence (or the previous sentence, for a call standing alone after a full stop). */
  claim: string;
  /** Figures in `claim` (normalized like `check` does: group separators dropped, decimal comma → point). */
  numerals: string[];
  /** 0-based paragraph index in the citing text. */
  paragraph: number;
}

export interface CitingAnalysis {
  style: "brackets" | "parentheses" | "superscript" | "none";
  calls: CitationCall[];
  /** References never called. */
  uncited: number[];
  /** Numbers called that are not in the list. */
  unknown: number[];
  /** The order references are first called in. */
  firstCitationOrder: number[];
  /** References first called after a higher-numbered one (Vancouver numbers by first citation). */
  outOfOrder: { n: number; after: number }[];
}

const SUP: Record<string, string> = { "⁰": "0", "¹": "1", "²": "2", "³": "3", "⁴": "4", "⁵": "5", "⁶": "6", "⁷": "7", "⁸": "8", "⁹": "9", "⁻": "-", "˒": "," };
const LIST = String.raw`\d{1,4}(?:\s*[-–—]\s*\d{1,4})?(?:\s*[,;]\s*\d{1,4}(?:\s*[-–—]\s*\d{1,4})?)*`;
const BRACKET = new RegExp(String.raw`\[\s*(${LIST})\s*\]`, "g");
const PAREN = new RegExp(String.raw`\(\s*(${LIST})\s*\)`, "g");
const SUPERSCRIPT = /<sup>\s*([\d,\s–—-]+)\s*<\/sup>|\^([\d,–—-]+)\^|([⁰¹²³⁴⁵⁶⁷⁸⁹][⁰¹²³⁴⁵⁶⁷⁸⁹⁻˒,]*)/g;

/**
 * "4,5" · "1-3" · "2, 7–9" → [4,5] · [1,2,3] · [2,7,8,9]. A backwards range or
 * one spanning more than 50 numbers is not a citation at all — it is an
 * interval ("71 [18 – 88]", "[73,4 – 95,3]") — so the whole bracket is dropped.
 */
export function expandCallList(list: string): number[] {
  const out: number[] = [];
  for (const part of list.split(/[,;]/)) {
    const m = /^\s*(\d+)\s*(?:[-–—]\s*(\d+))?\s*$/.exec(part);
    if (!m) return [];
    const a = Number(m[1]);
    const b = m[2] !== undefined ? Number(m[2]) : a;
    if (b < a || b - a > 50) return [];
    for (let i = a; i <= b; i++) out.push(i);
  }
  return [...new Set(out)];
}

interface RawCall {
  index: number;
  length: number;
  token: string;
  numbers: number[];
}

function findCalls(paragraph: string, style: CitingAnalysis["style"], refCount: number): RawCall[] {
  const out: RawCall[] = [];
  if (style === "brackets") {
    for (const m of paragraph.matchAll(BRACKET)) {
      const numbers = expandCallList(m[1]!);
      if (numbers.length) out.push({ index: m.index!, length: m[0].length, token: m[0], numbers });
    }
  } else if (style === "parentheses") {
    for (const m of paragraph.matchAll(PAREN)) {
      const numbers = expandCallList(m[1]!);
      // "(2019)", "(13 %)" and "(3/59)" are not calls: every number must be a
      // reference number, and a figure's unit must not follow.
      if (!numbers.length || numbers.some((x) => x < 1 || x > refCount)) continue;
      if (/^\s*(?:%|‰|mm|cm|ans|years?|yeux|eyes|patients?)/i.test(paragraph.slice(m.index! + m[0].length))) continue;
      out.push({ index: m.index!, length: m[0].length, token: m[0], numbers });
    }
  }
  for (const m of paragraph.matchAll(SUPERSCRIPT)) {
    // A Unicode superscript right after a digit or a unit is an exponent (10⁻³, mm²), not a call.
    if (m[3] && /(?:\d|\b(?:m|cm|mm|km|kg|µm|nm|ml|mL))\s*$/.test(paragraph.slice(0, m.index))) continue;
    const body = m[1] ?? m[2] ?? [...m[3]!].map((c) => SUP[c] ?? c).join("");
    const numbers = expandCallList(body);
    if (numbers.length && numbers.every((x) => x >= 1 && x <= Math.max(refCount, 1))) out.push({ index: m.index!, length: m[0].length, token: m[0], numbers });
  }
  return out.sort((a, b) => a.index - b.index);
}

/** Bracket calls win when there are any; parentheses only when nothing else is used. */
export function detectStyle(text: string, refCount: number): CitingAnalysis["style"] {
  if (new RegExp(BRACKET.source).test(text)) return "brackets";
  if (findCalls(text, "none", refCount).length) return "superscript";
  let paren = 0;
  for (const m of text.matchAll(PAREN)) if (expandCallList(m[1]!).every((x) => x >= 1 && x <= refCount)) paren++;
  return paren >= 2 ? "parentheses" : "none";
}

// Sentence ends: a full stop / ! / ? followed by space and an opening that can
// start a sentence. A call written after the stop ("…dix. [28].") starts its
// own "sentence", which `claim` then attaches to the one before.
// A call glued after the stop ("…description.[26] A series…") still ends the
// sentence there, so the next sentence's words never join the call's claim.
const SENTENCE_BREAK = /(?<=[.!?](?:\[[\d\s,;–—-]+\]|[⁰¹²³⁴⁵⁶⁷⁸⁹⁻˒,]+)?)\s+(?=[\p{Lu}\d«"“([])/u;

function hasWords(s: string): boolean {
  return /\p{L}{3,}/u.test(s);
}

/** Analyse a citing text against a list of `refCount` references (or of the given numbers). */
export function analyseCiting(text: string, refNumbers: number[]): CitingAnalysis {
  const known = new Set(refNumbers);
  const refCount = refNumbers.length ? Math.max(...refNumbers) : 0;
  const style = detectStyle(text, refCount);
  const calls: CitationCall[] = [];
  const paragraphs = text
    .replace(/\r\n?/g, "\n")
    .split(/\n/)
    .map((p) => p.trim());
  paragraphs.forEach((para, pi) => {
    if (!para) return;
    const sentences = para.split(SENTENCE_BREAK);
    let previous = "";
    for (const sentence of sentences) {
      const found = findCalls(sentence, style, refCount);
      let from = 0;
      found.forEach((c, k) => {
        let claim = sentence.slice(from, c.index);
        // The words after the LAST call of a sentence still belong to it
        // ("…improved [3] in 40 patients.").
        if (k === found.length - 1) claim += ` ${sentence.slice(c.index + c.length)}`;
        claim = claim.replace(/^[\s,;:.]+|[\s,;:]+$/g, "");
        // Nothing of its own ("…dix. [28].") → the sentence before. A bare
        // figure (", 72 [22]") is its own claim.
        if (!hasWords(claim) && !extractNumerals(claim).length) claim = previous;
        // Other calls' tokens never leak into a claim's figures.
        const bare = claim.replace(BRACKET, " ").replace(SUPERSCRIPT, " ");
        calls.push({ numbers: c.numbers, token: c.token, sentence: sentence.trim(), claim: claim.trim(), numerals: extractNumerals(bare, 12), paragraph: pi });
        from = c.index + c.length;
      });
      if (hasWords(sentence.replace(BRACKET, " "))) previous = sentence.replace(BRACKET, " ").replace(/\s+/g, " ").trim();
    }
  });

  const firstCitationOrder: number[] = [];
  const seen = new Set<number>();
  for (const c of calls) {
    for (const n of c.numbers) {
      if (!seen.has(n)) {
        seen.add(n);
        firstCitationOrder.push(n);
      }
    }
  }
  const outOfOrder: { n: number; after: number }[] = [];
  let highest = 0;
  for (const n of firstCitationOrder) {
    if (n < highest && known.has(n)) outOfOrder.push({ n, after: highest });
    highest = Math.max(highest, n);
  }
  return {
    style,
    calls,
    uncited: refNumbers.filter((n) => !seen.has(n)),
    unknown: firstCitationOrder.filter((n) => !known.has(n)).sort((a, b) => a - b),
    firstCitationOrder,
    outOfOrder,
  };
}

/** Whether a normalized numeral appears in a text as a whole number (13 must not match 130 or 1.3). */
export function numeralIn(numeral: string, text: string): boolean {
  const hay = normalizeNumeralText(text);
  const esc = numeral.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`(?<![\\d.])${esc}(?![\\d]|\\.\\d)`).test(hay);
}
