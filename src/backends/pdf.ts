import { inflateSync, inflateRawSync } from "node:zlib";

// Best-effort, dependency-free PDF text extraction. Finds content streams,
// FlateDecode-inflates them (zlib is built into Node — no npm), and pulls text
// from the text-showing operators (Tj / TJ / ' / "). Many PDFs (Type0/CID
// fonts, scanned image-only pages, encrypted files) won't yield clean text —
// this returns whatever it can and NEVER throws. Good enough to ground a report
// in a paper's prose beyond its abstract.

// Decode a PDF literal string token "( … )": resolve backslash escapes and
// octal character codes; drop the surrounding parens.
function decodePdfString(tok: string): string {
  if (!tok || tok[0] !== "(") return "";
  const inner = tok.slice(1, -1);
  const simple: Record<string, string> = { n: "\n", r: "\r", t: "\t", b: "\b", f: "\f", "(": "(", ")": ")", "\\": "\\" };
  return inner.replace(/\\([nrtbf()\\])/g, (_m, c) => simple[c] ?? c).replace(/\\([0-7]{1,3})/g, (_m, o) => String.fromCharCode(parseInt(o, 8) & 0xff));
}

// Decode a TJ array "[ (str) -250 (str) … ]": concatenate the strings, turning
// large negative kerning adjustments into spaces (word breaks).
function decodeTJArray(tok: string): string {
  let out = "";
  const re = /\((?:\\.|[^\\()])*\)|-?\d+(?:\.\d+)?/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(tok))) {
    const t = m[0];
    if (t[0] === "(") out += decodePdfString(t);
    else if (Number(t) <= -100) out += " ";
  }
  return out;
}

// Pull visible text out of one decoded content stream by scanning for string
// literals / TJ arrays and the operators that show or position them.
function extractTextOps(content: string): string {
  let out = "";
  let lastString = "";
  let lastArray = "";
  const re = /\((?:\\.|[^\\()])*\)|\[(?:\\.|[^\]\\])*\]|\bT\*|\bTd\b|\bTD\b|\bTj\b|\bTJ\b|'|"/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(content))) {
    const tok = m[0];
    if (tok[0] === "(") lastString = tok;
    else if (tok[0] === "[") lastArray = tok;
    else if (tok === "Tj") {
      out += decodePdfString(lastString) + " ";
      lastString = "";
    } else if (tok === "'" || tok === '"') {
      out += "\n" + decodePdfString(lastString) + " ";
      lastString = "";
    } else if (tok === "TJ") {
      out += decodeTJArray(lastArray) + " ";
      lastArray = "";
    } else if (tok === "T*") {
      out += "\n";
    }
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
