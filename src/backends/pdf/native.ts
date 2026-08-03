import { inflateSync, inflateRawSync } from "node:zlib";

// Best-effort, dependency-free PDF text extraction — the ladder's LAST rung.
//
// Finds content streams, FlateDecode-inflates them (zlib is built into Node — no
// npm) and pulls text from the showing operators (Tj / TJ / ' / "). It has no
// font tables, so Type0/CID pages and ligature glyphs come out wrong, and its
// stream filter is a heuristic, so image data occasionally gets mined as text.
// That is acceptable ONLY because every result goes through assessPdfText: this
// rung is allowed to fail, not to lie. Deliberately not improved further —
// pdf-inspector and pdftotext do this properly and are tried first.
//
// Never throws: returns whatever it could read, possibly "".

// A PDF literal string "( … )": resolve backslash escapes and octal codes.
// Balanced inner parens are legal unescaped, which is why the scanner below
// tracks depth rather than using a flat regex.
function decodePdfString(tok: string): string {
  if (tok[0] !== "(") return "";
  const inner = tok.slice(1, -1);
  const simple: Record<string, string> = { n: "\n", r: "\r", t: "\t", b: "\b", f: "\f", "(": "(", ")": ")", "\\": "\\" };
  return inner.replace(/\\([nrtbf()\\])/g, (_m, c) => simple[c] ?? c).replace(/\\([0-7]{1,3})/g, (_m, o) => String.fromCharCode(parseInt(o, 8) & 0xff));
}

// A hex string "<48656C6C6F>". Used heavily by CID fonts; the previous reader
// ignored these entirely, so such pages came back silently empty.
function decodeHexString(tok: string): string {
  const hex = tok.slice(1, -1).replace(/\s+/g, "");
  let out = "";
  for (let i = 0; i + 1 < hex.length; i += 2) out += String.fromCharCode(parseInt(hex.slice(i, i + 2), 16));
  if (hex.length % 2) out += String.fromCharCode(parseInt(hex[hex.length - 1]! + "0", 16));
  return out;
}

function decodeString(tok: string): string {
  return tok[0] === "<" ? decodeHexString(tok) : decodePdfString(tok);
}

// A TJ array "[ (str) -250 (str) … ]": concatenate the strings, turning large
// negative kerning adjustments into spaces (word breaks).
function decodeTJArray(tok: string): string {
  let out = "";
  const re = /\((?:\\.|[^\\()])*\)|<[0-9A-Fa-f\s]*>|-?\d+(?:\.\d+)?/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(tok))) {
    const t = m[0]!;
    if (t[0] === "(" || t[0] === "<") out += decodeString(t);
    else if (Number(t) <= -100) out += " ";
  }
  return out;
}

// One token of a content stream: a literal string, a hex string, an array, or an
// operator we care about.
//
// The array alternative matches whole strings BEFORE falling back to "any char
// that isn't ]". That detail is load-bearing: a naive `[^\]]*` truncates
// `[(] and gated recurrent [)-250(7)]` at the `]` INSIDE its first string,
// silently dropping the rest of the array. On a real paper that deleted whole
// clauses from the middle of sentences while leaving fluent, citable prose.
const TOKEN_RE = /\((?:\\.|[^\\()])*\)|<[0-9A-Fa-f\s]*>|\[(?:\((?:\\.|[^\\()])*\)|<[0-9A-Fa-f\s]*>|[^\]])*\]|\bT\*|\bTd\b|\bTD\b|\bTj\b|\bTJ\b|'|"/g;

// Pull visible text out of one decoded content stream.
function extractTextOps(content: string): string {
  let out = "";
  // Operands accumulate until an operator consumes them. The previous reader
  // kept a single "last string" and a single "last array" slot instead, so an
  // operator preceded by several operands saw only the most recent one.
  let operands: string[] = [];
  const take = (): string => {
    for (let i = operands.length - 1; i >= 0; i--) {
      const t = operands[i]!;
      if (t[0] === "(" || t[0] === "<") return decodeString(t);
      if (t[0] === "[") return decodeTJArray(t);
    }
    return "";
  };

  TOKEN_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = TOKEN_RE.exec(content))) {
    const tok = m[0]!;
    const c = tok[0]!;
    if (c === "(" || c === "<" || c === "[") {
      operands.push(tok);
      continue;
    }
    if (tok === "Tj" || tok === "TJ") out += take() + " ";
    else if (tok === "'" || tok === '"') out += "\n" + take() + " ";
    else if (tok === "T*") out += "\n";
    operands = [];
  }
  return out;
}

// Find each `stream … endstream` body, strip the single EOL the spec puts before
// `endstream`, and decode it: FlateDecode (zlib), then raw-deflate, else treat
// as an uncompressed content stream.
function extractStreams(buf: Buffer): string[] {
  const out: string[] = [];
  const s = buf.toString("latin1"); // 1 char per byte → indices == byte offsets
  const re = /stream\r?\n/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(s))) {
    const start = m.index + m[0].length;
    const end = s.indexOf("endstream", start);
    if (end < 0) continue;
    let stop = end;
    if (s[stop - 1] === "\n") stop--;
    if (s[stop - 1] === "\r") stop--;
    const chunk = buf.subarray(start, stop);
    let data: Buffer;
    try {
      data = inflateSync(chunk);
    } catch {
      try {
        data = inflateRawSync(chunk);
      } catch {
        data = chunk; // uncompressed content stream
      }
    }
    out.push(data.toString("latin1"));
  }
  return out;
}

export function pdfToText(buf: Buffer): string {
  let out = "";
  try {
    for (const stream of extractStreams(buf)) {
      // Only mine streams that actually contain text operators (skip fonts,
      // images, XObjects that happen to inflate).
      if (/\b(Tj|TJ)\b/.test(stream) || /\)\s*'/.test(stream)) out += extractTextOps(stream) + "\n";
    }
  } catch {
    /* best-effort: return whatever accumulated */
  }
  return out
    .replace(/[ \t]+/g, " ")
    .replace(/ *\n */g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}
