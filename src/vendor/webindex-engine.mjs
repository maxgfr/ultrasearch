// src/version.ts
var ENGINE_VERSION = "1.18.1";

// src/brand.ts
var DEFAULT_BRAND = {
  name: "webindex",
  envPrefix: "WEBINDEX",
  cli: "webindex",
  contactUrl: "https://github.com/maxgfr/webindex"
};
var current = { ...DEFAULT_BRAND };
function configure(next) {
  if (!next.envPrefix || !/^[A-Z][A-Z0-9_]*$/.test(next.envPrefix)) {
    throw new Error(`webindex: envPrefix must be UPPER_SNAKE, got ${JSON.stringify(next.envPrefix)}`);
  }
  if (!next.name || !next.cli) {
    throw new Error("webindex: configure() requires both `name` and `cli`");
  }
  current = { ...next };
}
function brand() {
  return current;
}
function resetBrand() {
  current = { ...DEFAULT_BRAND };
}
function countFetch(bytes, cached = false) {
  const hook = current.onFetch;
  if (!hook) return;
  try {
    hook(bytes, cached);
  } catch {
  }
}
function envName(suffix) {
  return `${current.envPrefix}_${suffix}`;
}
function env(suffix) {
  const raw = process.env[envName(suffix)];
  if (typeof raw !== "string") return void 0;
  const trimmed = raw.trim();
  return trimmed ? trimmed : void 0;
}
function envFlag(suffix) {
  const v = env(suffix);
  if (v === void 0) return false;
  const lower = v.toLowerCase();
  return lower !== "0" && lower !== "false" && lower !== "no" && lower !== "off";
}
function envInt(suffix, def, min = 0, max = Number.MAX_SAFE_INTEGER) {
  const raw = env(suffix);
  if (raw === void 0) return def;
  const n = Number(raw);
  if (!Number.isFinite(n)) return def;
  return Math.min(max, Math.max(min, Math.trunc(n)));
}

// src/pdf/native.ts
import { inflateSync, inflateRawSync } from "zlib";
function decodePdfString(tok) {
  if (tok[0] !== "(") return "";
  const inner = tok.slice(1, -1);
  const simple = { n: "\n", r: "\r", t: "	", b: "\b", f: "\f", "(": "(", ")": ")", "\\": "\\" };
  return inner.replace(/\\([nrtbf()\\])/g, (_m, c) => simple[c] ?? c).replace(/\\([0-7]{1,3})/g, (_m, o) => String.fromCharCode(parseInt(o, 8) & 255));
}
function decodeHexString(tok) {
  const hex = tok.slice(1, -1).replace(/\s+/g, "");
  let out = "";
  for (let i = 0; i + 1 < hex.length; i += 2) out += String.fromCharCode(parseInt(hex.slice(i, i + 2), 16));
  if (hex.length % 2) out += String.fromCharCode(parseInt(hex[hex.length - 1] + "0", 16));
  return out;
}
function decodeString(tok) {
  return tok[0] === "<" ? decodeHexString(tok) : decodePdfString(tok);
}
function decodeTJArray(tok) {
  let out = "";
  const re = /\((?:\\.|[^\\()])*\)|<[0-9A-Fa-f\s]*>|-?\d+(?:\.\d+)?/g;
  let m;
  while (m = re.exec(tok)) {
    const t = m[0];
    if (t[0] === "(" || t[0] === "<") out += decodeString(t);
    else if (Number(t) <= -100) out += " ";
  }
  return out;
}
var TOKEN_RE = /\((?:\\.|[^\\()])*\)|<[0-9A-Fa-f\s]*>|\[(?:\((?:\\.|[^\\()])*\)|<[0-9A-Fa-f\s]*>|[^\]])*\]|\bT\*|\bTd\b|\bTD\b|\bTj\b|\bTJ\b|'|"/g;
function extractTextOps(content) {
  let out = "";
  let operands = [];
  const take = () => {
    for (let i = operands.length - 1; i >= 0; i--) {
      const t = operands[i];
      if (t[0] === "(" || t[0] === "<") return decodeString(t);
      if (t[0] === "[") return decodeTJArray(t);
    }
    return "";
  };
  TOKEN_RE.lastIndex = 0;
  let m;
  while (m = TOKEN_RE.exec(content)) {
    const tok = m[0];
    const c = tok[0];
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
function extractStreams(buf) {
  const out = [];
  const s = buf.toString("latin1");
  const re = /stream\r?\n/g;
  let m;
  while (m = re.exec(s)) {
    const start = m.index + m[0].length;
    const end = s.indexOf("endstream", start);
    if (end < 0) continue;
    let stop = end;
    if (s[stop - 1] === "\n") stop--;
    if (s[stop - 1] === "\r") stop--;
    const chunk = buf.subarray(start, stop);
    let data;
    try {
      data = inflateSync(chunk);
    } catch {
      try {
        data = inflateRawSync(chunk);
      } catch {
        data = chunk;
      }
    }
    out.push(data.toString("latin1"));
  }
  return out;
}
function pdfToText(buf) {
  let out = "";
  try {
    for (const stream of extractStreams(buf)) {
      if (/\b(Tj|TJ)\b/.test(stream) || /\)\s*'/.test(stream)) out += extractTextOps(stream) + "\n";
    }
  } catch {
  }
  return out.replace(/[ \t]+/g, " ").replace(/ *\n */g, "\n").replace(/\n{3,}/g, "\n\n").trim();
}

// src/pdf/quality.ts
var MIN_CHARS_FOR_SHAPE_CHECKS = 200;
var CONTROL_RATIO_MAX = 5e-3;
var REPLACEMENT_RATIO_MAX = 5e-3;
var LONGEST_RUN_MAX = 300;
var LETTER_RATIO_MIN = 0.5;
function isControlCode(c) {
  if (c === 9 || c === 10 || c === 13) return false;
  return c < 32 || c >= 127 && c <= 159;
}
var REPLACEMENT_CODE = 65533;
function scanRatios(t) {
  let control = 0;
  let replacement = 0;
  for (let i = 0; i < t.length; i++) {
    const c = t.charCodeAt(i);
    if (c === REPLACEMENT_CODE) replacement++;
    else if (isControlCode(c)) control++;
  }
  return { control: control / t.length, replacement: replacement / t.length };
}
function assessPdfText(text) {
  return assessExtractedText(text, "no text layer (scanned or image-only PDF?)");
}
function assessExtractedText(text, emptyReason) {
  const t = text.trim();
  if (!t) return { ok: false, reason: emptyReason };
  const { control, replacement } = scanRatios(t);
  if (control > CONTROL_RATIO_MAX) {
    return { ok: false, reason: "binary/control characters in the text (undecodable PDF stream)" };
  }
  if (replacement > REPLACEMENT_RATIO_MAX) {
    return { ok: false, reason: "replacement characters throughout (wrong character map)" };
  }
  if (t.length < MIN_CHARS_FOR_SHAPE_CHECKS) return { ok: true };
  let longestRun = 0;
  for (const w of t.split(/\s+/)) if (w.length > longestRun) longestRun = w.length;
  const letters = (t.match(new RegExp("\\p{L}|\\p{N}", "gu"))?.length ?? 0) / t.replace(/\s+/g, "").length;
  if (longestRun > LONGEST_RUN_MAX && letters < LETTER_RATIO_MIN) {
    return { ok: false, reason: "unreadable text layer (garbled glyph encoding)" };
  }
  return { ok: true };
}

// src/pdf/ocr.ts
import { mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";

// src/pdf/exec.ts
import { spawn } from "child_process";
var PDF_INSPECTOR_SPEC = "@firecrawl/pdf-inspector@1";
var ANYDOC_SPEC = "@firecrawl/anydoc@0.1";
var MAX_STDOUT_BYTES = 24 * 1024 * 1024;
function binaryName(name) {
  return process.platform === "win32" && name === "npx" ? "npx.cmd" : name;
}
function runWithInput(cmd, args, input, timeoutMs) {
  return new Promise((resolve4) => {
    let child;
    try {
      child = spawn(binaryName(cmd), args, { stdio: ["pipe", "pipe", "pipe"] });
    } catch (e) {
      resolve4({ ok: false, stdout: "", error: e.message });
      return;
    }
    const chunks = [];
    let size = 0;
    let settled = false;
    const done = (r) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve4(r);
    };
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      done({ ok: false, stdout: "", error: `timed out after ${Math.round(timeoutMs / 1e3)}s` });
    }, timeoutMs);
    child.stdout?.on("data", (d) => {
      if (size >= MAX_STDOUT_BYTES) return;
      size += d.length;
      chunks.push(d);
    });
    child.stderr?.on("data", () => {
    });
    child.on("error", (e) => {
      done({ ok: false, stdout: "", error: e.code === "ENOENT" ? "not installed" : e.message });
    });
    child.on("close", (code) => {
      const stdout = Buffer.concat(chunks).subarray(0, MAX_STDOUT_BYTES).toString("utf8");
      if (code === 0) done({ ok: true, stdout });
      else done({ ok: false, stdout, error: `exit ${code}` });
    });
    child.stdin?.on("error", () => {
    });
    child.stdin?.end(input);
  });
}

// src/pdf/ocr.ts
var DEFAULT_TIMEOUT_MS = 3e5;
var DEFAULT_MAX_DOCS = 3;
var DEFAULT_LANG = "eng";
var spent = 0;
function resetOcrBudget() {
  spent = 0;
}
function ocrBudgetLeft() {
  return Math.max(0, envInt("OCR_MAX", DEFAULT_MAX_DOCS) - spent);
}
async function ocrTools() {
  const probe = async (cmd, args) => (await runWithInput(cmd, args, Buffer.alloc(0), 2e4)).ok;
  const [copyablePdf, tesseract] = await Promise.all([probe("copyable-pdf", ["--help"]), probe("tesseract", ["--version"])]);
  return { copyablePdf, tesseract };
}
async function ocrPdf(bytes) {
  if (ocrBudgetLeft() <= 0) return void 0;
  const { copyablePdf, tesseract } = await ocrTools();
  if (!copyablePdf || !tesseract) return void 0;
  const dir = mkdtempSync(join(tmpdir(), `${brand().name}-ocr-`));
  try {
    const input = join(dir, "in.pdf");
    const output = join(dir, "out.pdf");
    writeFileSync(input, bytes);
    const lang = env("OCR_LANG") || DEFAULT_LANG;
    const r = await runWithInput("copyable-pdf", ["-o", output, "-m", "-l", lang, input], Buffer.alloc(0), envInt("OCR_TIMEOUT_MS", DEFAULT_TIMEOUT_MS));
    spent++;
    if (!r.ok) return void 0;
    const md = output.replace(/\.pdf$/, ".md");
    return existsSync(md) ? readFileSync(md, "utf8") : void 0;
  } catch {
    return void 0;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// src/pdf/ladder.ts
var PDF_EXTRACTORS = ["pdf-inspector", "anydoc", "firecrawl", "pdftotext", "native", "ocr"];
var NPX_TIMEOUT_MS = 9e4;
var PDFTOTEXT_TIMEOUT_MS = 6e4;
var dead = /* @__PURE__ */ new Set();
function resetPdfLadderCache() {
  dead.clear();
  resetOcrBudget();
}
function enabledExtractors(engines) {
  if (engines) return engines;
  const forced = env("PDF_ENGINE");
  if (forced && PDF_EXTRACTORS.includes(forced)) return [forced];
  if (envFlag("NO_NPX")) return PDF_EXTRACTORS.filter((e) => e !== "pdf-inspector" && e !== "anydoc");
  return PDF_EXTRACTORS;
}
async function viaAnydoc(bytes) {
  const r = await runWithInput("npx", ["-y", "--prefer-offline", ANYDOC_SPEC, "-", "--format", "pdf"], bytes, NPX_TIMEOUT_MS);
  return r.ok ? r.stdout : void 0;
}
async function viaPdfInspector(bytes) {
  const r = await runWithInput("npx", ["-y", "--prefer-offline", PDF_INSPECTOR_SPEC, "-"], bytes, NPX_TIMEOUT_MS);
  return r.ok ? r.stdout : void 0;
}
async function viaPdftotext(bytes) {
  const r = await runWithInput("pdftotext", ["-layout", "-", "-"], bytes, PDFTOTEXT_TIMEOUT_MS);
  return r.ok ? r.stdout : void 0;
}
async function extractPdf(bytes, opts = {}) {
  let lastReason;
  for (const id of enabledExtractors(opts.engines)) {
    if (dead.has(id)) continue;
    if (id === "ocr" && ocrBudgetLeft() <= 0) {
      lastReason = `scanned PDF, and this run's OCR budget is spent (raise ${envName("OCR_MAX")})`;
      continue;
    }
    let text;
    try {
      if (id === "pdf-inspector") text = await viaPdfInspector(bytes);
      else if (id === "anydoc") text = await viaAnydoc(bytes);
      else if (id === "pdftotext") text = await viaPdftotext(bytes);
      else if (id === "firecrawl") text = opts.firecrawl ? await opts.firecrawl() : void 0;
      else if (id === "ocr") text = await ocrPdf(bytes);
      else text = pdfToText(bytes);
    } catch {
      text = void 0;
    }
    if (text === void 0) {
      if (id !== "firecrawl") dead.add(id);
      continue;
    }
    const verdict = assessPdfText(text);
    if (verdict.ok) return { text: text.trim(), via: id };
    lastReason = verdict.reason;
  }
  return { text: "", reason: lastReason ?? "no PDF extractor available" };
}

// src/doc/formats.ts
var BINARY = { textFallback: false };
var CSV = { format: "csv", textFallback: true };
var BY_EXTENSION = {
  // Word
  doc: BINARY,
  docx: BINARY,
  docm: BINARY,
  odt: BINARY,
  rtf: BINARY,
  // PowerPoint
  ppt: BINARY,
  pps: BINARY,
  pot: BINARY,
  pptx: BINARY,
  pptm: BINARY,
  ppsx: BINARY,
  ppsm: BINARY,
  odp: BINARY,
  // Excel
  xls: BINARY,
  xlsx: BINARY,
  xlsm: BINARY,
  xlsb: BINARY,
  ods: BINARY,
  // Everything else the converter reads
  epub: BINARY,
  csv: CSV
};
var BY_CONTENT_TYPE = {
  "application/msword": BINARY,
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document": BINARY,
  "application/vnd.ms-word.document.macroenabled.12": BINARY,
  "application/vnd.oasis.opendocument.text": BINARY,
  "application/rtf": BINARY,
  "text/rtf": BINARY,
  "application/vnd.ms-powerpoint": BINARY,
  "application/vnd.openxmlformats-officedocument.presentationml.presentation": BINARY,
  "application/vnd.oasis.opendocument.presentation": BINARY,
  "application/vnd.ms-excel": BINARY,
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet": BINARY,
  "application/vnd.ms-excel.sheet.binary.macroenabled.12": BINARY,
  "application/vnd.oasis.opendocument.spreadsheet": BINARY,
  "application/epub+zip": BINARY,
  "text/csv": CSV
};
var DOC_EXTENSIONS = Object.keys(BY_EXTENSION);
function docFormatForUrl(url) {
  const m = /\.([a-z0-9]{2,5})(?:$|[?#])/i.exec(url);
  return m ? BY_EXTENSION[m[1].toLowerCase()] : void 0;
}
function docFormatForContentType(contentType) {
  const type = contentType.split(";")[0]?.trim().toLowerCase();
  return type ? BY_CONTENT_TYPE[type] : void 0;
}

// src/doc/ladder.ts
var DOC_EXTRACTORS = ["anydoc", "firecrawl"];
var NPX_TIMEOUT_MS2 = 9e4;
var dead2 = /* @__PURE__ */ new Set();
function resetDocLadderCache() {
  dead2.clear();
}
function enabledDocExtractors(engines) {
  if (engines) return engines;
  const forced = env("DOC_ENGINE");
  if (forced === "none") return [];
  if (forced && DOC_EXTRACTORS.includes(forced)) return [forced];
  if (envFlag("NO_NPX")) return DOC_EXTRACTORS.filter((e) => e !== "anydoc");
  return DOC_EXTRACTORS;
}
async function viaAnydoc2(bytes, format) {
  const args = ["-y", "--prefer-offline", ANYDOC_SPEC, "-"];
  if (format) args.push("--format", format);
  const r = await runWithInput("npx", args, bytes, NPX_TIMEOUT_MS2);
  return r.ok ? r.stdout : void 0;
}
async function extractDocument(bytes, fmt, opts = {}) {
  let lastReason;
  for (const id of enabledDocExtractors(opts.engines)) {
    if (dead2.has(id)) continue;
    let text;
    try {
      if (id === "anydoc") text = await viaAnydoc2(bytes, fmt.format);
      else text = opts.firecrawl ? await opts.firecrawl() : void 0;
    } catch {
      text = void 0;
    }
    if (text === void 0) {
      if (id !== "firecrawl") dead2.add(id);
      continue;
    }
    const verdict = assessExtractedText(text, "the converter produced no text");
    if (verdict.ok) return { text: text.trim(), via: id };
    lastReason = verdict.reason;
  }
  return { text: "", reason: lastReason ?? "no document converter available" };
}

// src/charset.ts
function bomEncoding(bytes) {
  if (bytes.length >= 3 && bytes[0] === 239 && bytes[1] === 187 && bytes[2] === 191) return { encoding: "utf-8", skip: 3 };
  if (bytes.length >= 2 && bytes[0] === 255 && bytes[1] === 254) return { encoding: "utf-16le", skip: 2 };
  if (bytes.length >= 2 && bytes[0] === 254 && bytes[1] === 255) return { encoding: "utf-16be", skip: 2 };
  return void 0;
}
var CHARSET_IN_CONTENT_TYPE = /charset\s*=\s*["']?([a-z0-9_:.+-]+)/i;
function charsetFromContentType(contentType) {
  return CHARSET_IN_CONTENT_TYPE.exec(contentType ?? "")?.[1]?.toLowerCase();
}
function charsetFromHtml(head) {
  const window = head.slice(0, 4096);
  const direct = /<meta[^>]+charset\s*=\s*["']?([a-z0-9_:.+-]+)/i.exec(window);
  if (direct) return direct[1].toLowerCase();
  const httpEquiv = /<meta[^>]+http-equiv\s*=\s*["']?content-type["']?[^>]*content\s*=\s*["'][^"']*charset\s*=\s*([a-z0-9_:.+-]+)/i.exec(window);
  return httpEquiv?.[1]?.toLowerCase();
}
function decodeBody(bytes, contentType = "") {
  const bom = bomEncoding(bytes);
  if (bom) return decodeWith(bytes.subarray(bom.skip), bom.encoding);
  const declared = charsetFromContentType(contentType);
  if (declared && declared !== "utf-8" && declared !== "utf8") return decodeWith(bytes, declared);
  if (declared) return bytes.toString("utf8");
  const meta = charsetFromHtml(bytes.subarray(0, 4096).toString("latin1"));
  if (meta && meta !== "utf-8" && meta !== "utf8") return decodeWith(bytes, meta);
  return bytes.toString("utf8");
}
var CP1252_C1 = [
  8364,
  129,
  8218,
  402,
  8222,
  8230,
  8224,
  8225,
  710,
  8240,
  352,
  8249,
  338,
  141,
  381,
  143,
  144,
  8216,
  8217,
  8220,
  8221,
  8226,
  8211,
  8212,
  732,
  8482,
  353,
  8250,
  339,
  157,
  382,
  376
];
var CP1252_LABELS = /* @__PURE__ */ new Set([
  "windows-1252",
  "cp1252",
  "cp-1252",
  "x-cp1252",
  "ansi_x3.4-1968",
  "iso-8859-1",
  "iso8859-1",
  "latin1",
  "l1",
  "us-ascii",
  "ascii"
]);
function decodeCp1252(bytes) {
  let out = "";
  for (const b of bytes) out += String.fromCharCode(b >= 128 && b <= 159 ? CP1252_C1[b - 128] : b);
  return out;
}
function decodeWith(bytes, encoding) {
  if (CP1252_LABELS.has(encoding)) return decodeCp1252(bytes);
  try {
    return new TextDecoder(encoding, { fatal: false }).decode(bytes);
  } catch {
    return bytes.toString("utf8");
  }
}

// src/text.ts
function escapeRegExp(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
var STOPWORDS = /* @__PURE__ */ new Set([
  "the",
  "a",
  "an",
  "is",
  "are",
  "was",
  "were",
  "be",
  "been",
  "being",
  "do",
  "does",
  "did",
  "how",
  "what",
  "why",
  "when",
  "where",
  "which",
  "who",
  "whom",
  "this",
  "that",
  "these",
  "those",
  "of",
  "in",
  "on",
  "to",
  "for",
  "with",
  "and",
  "or",
  "but",
  "if",
  "then",
  "else",
  "than",
  "as",
  "at",
  "by",
  "from",
  "into",
  "about",
  "it",
  "its",
  "i",
  "you",
  "we",
  "they",
  "he",
  "she",
  "there",
  "here",
  "can",
  "could",
  "should",
  "would",
  "will",
  "shall",
  "may",
  "might",
  "must",
  "have",
  "has",
  "had",
  "not",
  "no",
  "yes",
  "so",
  "such",
  "only",
  "any",
  "some",
  "all",
  "get",
  "set",
  "use",
  "used",
  "using",
  "work",
  "works",
  "working",
  "handle",
  "handled",
  "happen",
  "happens",
  "default",
  "value",
  "values",
  "please",
  "explain",
  "tell",
  "me",
  "my",
  "our",
  "le",
  "la",
  "les",
  "de",
  "des",
  "du",
  "un",
  "une",
  "est",
  "sont",
  "que",
  "qui",
  "quoi",
  "quel",
  "quelle",
  "quels",
  "quelles",
  "pour",
  "dans",
  "avec",
  "entre",
  "sur",
  "par",
  "pas",
  "plus",
  "et",
  "ou",
  "o\xF9",
  "ce",
  "cette",
  "ces",
  "se",
  "sa",
  "son",
  "ses",
  "leur",
  "leurs",
  "comment",
  "pourquoi",
  "quand",
  "fait",
  "faire",
  "peut",
  "doit",
  "\xEAtre",
  "avoir",
  "il",
  "elle",
  "nous",
  "vous",
  "ils",
  "elles",
  "au",
  "aux",
  "si",
  "ne"
]);
function isStopword(term) {
  const t = term.toLowerCase();
  if (STOPWORDS.has(t)) return true;
  const extra = brand().extraStopwords;
  return extra ? extra.some((w) => w.toLowerCase() === t) : false;
}
function keywords(question) {
  const seen = /* @__PURE__ */ new Set();
  const out = [];
  for (const raw of question.split(/[^\p{L}\p{N}_]+/u)) {
    if (!raw) continue;
    const lower = raw.toLowerCase();
    if (raw.length < 2) continue;
    if (isStopword(lower)) continue;
    if (seen.has(lower)) continue;
    seen.add(lower);
    out.push(raw);
  }
  return out;
}
function rankedKeywords(question) {
  const base = keywords(question);
  const score = (raw) => {
    let s = 0;
    if (/\d/.test(raw)) s += 3;
    if (/[A-Z]/.test(raw) && !/^[A-Z0-9]+$/.test(raw)) s += 2;
    if (/_/.test(raw)) s += 2;
    if (raw.length >= 8) s += 1.5;
    else if (raw.length >= 5) s += 0.5;
    return s;
  };
  return base.map((k, i) => ({ k, s: score(k), i })).sort((a, b) => b.s - a.s || a.i - b.i).map((x) => x.k);
}
var ACCENT_CLASSES = {
  a: "a\xE0\xE1\xE2\xE3\xE4\xE5\u0101\u0103\u0105",
  c: "c\xE7\u0107\u0109\u010B\u010D",
  d: "d\u010F\u0111",
  e: "e\xE8\xE9\xEA\xEB\u0113\u0115\u0117\u0119\u011B",
  g: "g\u011D\u011F\u0121\u0123",
  i: "i\xEC\xED\xEE\xEF\u0129\u012B\u012D\u012F\u0131",
  l: "l\u013A\u013C\u013E\u0140\u0142",
  n: "n\xF1\u0144\u0146\u0148",
  o: "o\xF2\xF3\xF4\xF5\xF6\xF8\u014D\u014F\u0151",
  r: "r\u0155\u0157\u0159",
  s: "s\u015B\u015D\u015F\u0161",
  t: "t\u0163\u0165\u0167",
  u: "u\xF9\xFA\xFB\xFC\u0169\u016B\u016D\u016F\u0171\u0173",
  y: "y\xFD\xFF\u0177",
  z: "z\u017A\u017C\u017E"
};
var BASE_OF = /* @__PURE__ */ new Map();
for (const [base, cls] of Object.entries(ACCENT_CLASSES)) {
  for (const ch of cls) BASE_OF.set(ch, base);
}
function baseChar(ch) {
  const known = BASE_OF.get(ch);
  if (known) return known;
  const stripped = ch.normalize("NFD").replace(new RegExp("\\p{M}+", "gu"), "");
  return stripped.length === 1 ? stripped : ch;
}
function deaccent(s) {
  let out = "";
  for (const ch of s) out += baseChar(ch);
  return out;
}
function foldPlural(t) {
  if (t.length > 4 && t.endsWith("ies")) return t.slice(0, -3) + "y";
  if (t.length > 4 && /(?:[sxz]|[cs]h)es$/.test(t)) return t.slice(0, -2);
  if (t.length > 3 && t.endsWith("s") && !/(?:ss|us|is)$/.test(t)) return t.slice(0, -1);
  return t;
}
function foldTerm(raw) {
  return foldPlural(deaccent(raw.toLowerCase()));
}
function subtokens(raw) {
  const spaced = raw.replace(new RegExp("([\\p{Ll}\\p{N}])(\\p{Lu})", "gu"), "$1 $2").replace(new RegExp("(\\p{Lu}+)(\\p{Lu}\\p{Ll})", "gu"), "$1 $2").replace(new RegExp("(\\p{L})(\\p{N})", "gu"), "$1 $2").replace(new RegExp("(\\p{N})(\\p{L})", "gu"), "$1 $2");
  const parts = spaced.split(/[^\p{L}\p{N}]+/u).filter(Boolean);
  if (parts.length < 2) return [];
  const out = [];
  for (const p of parts) {
    const lower = p.toLowerCase();
    if (lower.length < 3 || isStopword(lower)) continue;
    if (!out.includes(lower)) out.push(lower);
    if (out.length >= 4) break;
  }
  return out;
}
var MAX_PATTERNS = 24;
var VARIANT_PRIORITY = { original: 0, folded: 1, subtoken: 2 };
function expandTokens(tokens, max = 8) {
  const byCanonical = /* @__PURE__ */ new Map();
  for (const raw of tokens) {
    if (byCanonical.size >= max) break;
    const canonical = foldTerm(raw);
    if (!canonical || byCanonical.has(canonical)) continue;
    const plain = deaccent(raw.toLowerCase());
    const variants = [{ text: raw.toLowerCase(), kind: "original" }];
    if (canonical !== plain) variants.push({ text: canonical, kind: "folded" });
    if (plain.length > 4 && plain.endsWith("ies")) variants.push({ text: plain.slice(0, -1), kind: "folded" });
    for (const sub of subtokens(raw)) variants.push({ text: sub, kind: "subtoken" });
    byCanonical.set(canonical, { canonical, original: raw, variants });
  }
  const all = [...byCanonical.values()].flatMap((ek, kwIdx) => ek.variants.map((v) => ({ ek, v, kwIdx })));
  all.sort((a, b) => VARIANT_PRIORITY[a.v.kind] - VARIANT_PRIORITY[b.v.kind] || a.kwIdx - b.kwIdx);
  const seen = /* @__PURE__ */ new Set();
  const kept = /* @__PURE__ */ new Set();
  for (const { v } of all) {
    if (kept.size >= MAX_PATTERNS) break;
    const key = deaccent(v.text);
    if (seen.has(key)) continue;
    seen.add(key);
    kept.add(v);
  }
  for (const ek of byCanonical.values()) ek.variants = ek.variants.filter((v) => kept.has(v));
  return [...byCanonical.values()];
}
function accentPattern(text) {
  let out = "";
  for (const ch of text) {
    const cls = ACCENT_CLASSES[baseChar(ch)];
    out += cls ? `[${cls}]` : escapeRegExp(ch);
  }
  return out;
}
function makeMatcher(expanded) {
  const regexes = [];
  for (const ek of expanded) {
    for (const v of ek.variants) {
      regexes.push({ re: new RegExp(accentPattern(v.text), "i"), canonical: ek.canonical });
    }
  }
  const patterns = expanded.flatMap((ek) => ek.variants.map((v) => ({ source: accentPattern(v.text), canonical: ek.canonical })));
  return {
    expanded,
    canonicals: expanded.map((e) => e.canonical),
    patterns,
    canonicalOf: (span) => regexes.find(({ re }) => new RegExp(`^(?:${re.source})$`, "i").test(span))?.canonical,
    matchLine: (line) => {
      const hit = /* @__PURE__ */ new Set();
      for (const { re, canonical } of regexes) {
        if (!hit.has(canonical) && re.test(line)) hit.add(canonical);
      }
      return hit;
    }
  };
}
function buildMatcher(question, max = 8) {
  return makeMatcher(expandTokens(keywords(question), max));
}
function matcherFromTokens(tokens, max = 8) {
  return makeMatcher(expandTokens(tokens.filter(Boolean), max));
}
function nearestHeading(lines, anchor) {
  let heading;
  let inFence = false;
  for (let i = 0; i <= anchor && i < lines.length; i++) {
    const line = lines[i];
    if (/^\s*(```|~~~)/.test(line)) {
      inFence = !inFence;
      continue;
    }
    if (inFence) continue;
    const m = line.match(/^#{1,6}\s+(.+?)\s*#*\s*$/);
    if (m) heading = m[1].trim();
  }
  return heading;
}
function excerptWindows(text, question, opts = {}) {
  const lines = text.split("\n");
  const before = opts.before ?? 3;
  const after = opts.after ?? 12;
  const maxChars = opts.maxChars ?? 1500;
  const perDoc = Math.max(1, opts.perDoc ?? 2);
  const matchers = (Array.isArray(question) ? question : [question]).filter((q) => q.trim()).map((q) => buildMatcher(q));
  const hits = [];
  for (let i = 0; i < lines.length; i++) {
    let score = 0;
    for (const m of matchers) {
      const cov = m.matchLine(lines[i]).size;
      if (cov > score) score = cov;
    }
    if (score > 0) hits.push({ anchor: i, score });
  }
  hits.sort((a, b) => b.score - a.score || a.anchor - b.anchor);
  const take = hits.length ? hits : [{ anchor: 0, score: 0 }];
  const out = [];
  for (const h of take) {
    if (out.length >= perDoc) break;
    const start = Math.max(0, h.anchor - before);
    const end = Math.min(lines.length, h.anchor + after);
    if (out.some((w) => start < w.end && end > w.start)) continue;
    const snippet = lines.slice(start, end).join("\n").slice(0, maxChars);
    if (!snippet.trim()) continue;
    const heading = nearestHeading(lines, h.anchor);
    out.push({ start, end, anchor: h.anchor, score: h.score, ...heading ? { heading } : {}, snippet });
  }
  return out;
}
function slugify(input, opts = {}) {
  const s = input.toLowerCase().replace(/^https?:\/\//, "").replace(/^git@/, "").replace(/\.git$/, "").replace(/[^a-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, opts.max ?? 120);
  return s || (opts.fallback ?? "");
}

// src/firecrawl.ts
var FIRECRAWL_DEFAULT_BASE = "http://localhost:3002";
var PROBE_TIMEOUT_MS = 2e3;
var SCRAPE_TIMEOUT_MS = 45e3;
var SEARCH_TIMEOUT_MS = 3e4;
var SCRAPE_MAX_AGE_MS = 24 * 60 * 60 * 1e3;
function firecrawlBase(opts = {}) {
  const raw = (opts.firecrawl ?? env("FIRECRAWL") ?? FIRECRAWL_DEFAULT_BASE).trim();
  if (!raw || raw.toLowerCase() === "off") return null;
  return raw.replace(/\/+$/, "");
}
function firecrawlIsExplicit(opts = {}) {
  return !!(opts.firecrawl ?? env("FIRECRAWL"));
}
function authHeaders() {
  const key = env("FIRECRAWL_KEY");
  return key ? { authorization: `Bearer ${key}` } : void 0;
}
var probeCache = /* @__PURE__ */ new Map();
function resetFirecrawlProbeCache() {
  probeCache.clear();
}
function markFirecrawlDown(base) {
  for (const explicit of [true, false]) probeCache.set(`${base}|${explicit}`, Promise.resolve(false));
}
function looksLikeFirecrawl(contentType, body) {
  if (/firecrawl/i.test(body.slice(0, 4096))) return true;
  return !/^\s*text\/html/i.test(contentType ?? "");
}
function probeFirecrawl(base, explicit = false) {
  const key = `${base}|${explicit}`;
  let p = probeCache.get(key);
  if (!p) {
    p = (async () => {
      const ctrl = new AbortController();
      const t = setTimeout(() => ctrl.abort(), PROBE_TIMEOUT_MS);
      try {
        const res = await fetch(`${base}/`, { signal: ctrl.signal });
        const body = await res.text().catch(() => "");
        return explicit || looksLikeFirecrawl(res.headers.get("content-type"), body);
      } catch {
        return false;
      } finally {
        clearTimeout(t);
      }
    })();
    probeCache.set(key, p);
  }
  return p;
}
var prefixCache = /* @__PURE__ */ new Map();
function apiPrefix(base) {
  return prefixCache.get(base) ?? "/v2";
}
async function postJson(base, path, body, timeoutMs) {
  const headers = authHeaders();
  const first = await httpJson("POST", `${base}${apiPrefix(base)}${path}`, body, { timeoutMs, headers });
  if (first.status !== 404 || apiPrefix(base) !== "/v2") return first;
  prefixCache.set(base, "/v1");
  return httpJson("POST", `${base}/v1${path}`, body, { timeoutMs, headers });
}
function mapScrapeResponse(json) {
  if (!json || typeof json !== "object" || Array.isArray(json)) return null;
  if (json.success === false) return null;
  const data = json.data;
  if (!data || typeof data !== "object" || Array.isArray(data)) return null;
  const markdown = typeof data.markdown === "string" ? data.markdown.trim() : "";
  if (!markdown) return null;
  const meta = data.metadata && typeof data.metadata === "object" ? data.metadata : {};
  const rawTitle = typeof meta.title === "string" ? cleanInline(meta.title) : "";
  const src = typeof meta.sourceURL === "string" ? meta.sourceURL : typeof meta.url === "string" ? meta.url : void 0;
  const status = typeof meta.statusCode === "number" ? meta.statusCode : void 0;
  return {
    markdown,
    ...rawTitle ? { title: rawTitle } : {},
    ...src ? { sourceURL: src } : {},
    ...status !== void 0 ? { statusCode: status } : {}
  };
}
function mapSearchResponse(json) {
  if (!json || typeof json !== "object") return [];
  if (json.success === false) return [];
  const data = json.data;
  const web = Array.isArray(data) ? data : Array.isArray(data?.web) ? data.web : Array.isArray(data?.results) ? data.results : [];
  const out = [];
  for (const x of web) {
    if (!x || typeof x.url !== "string" || !x.url) continue;
    out.push({
      url: x.url,
      // `||` (not `??`): an empty title degrades to the URL, never blank.
      title: cleanInline(String(x.title || x.url)),
      description: cleanInline(String(x.description ?? x.snippet ?? "")).slice(0, 360),
      ...typeof x.markdown === "string" && x.markdown.trim() ? { markdown: x.markdown } : {}
    });
  }
  return out;
}
async function scrapeViaFirecrawl(url, opts = {}) {
  const base = firecrawlBase(opts);
  if (!base) return {};
  if (!await probeFirecrawl(base, firecrawlIsExplicit(opts))) {
    return firecrawlIsExplicit(opts) ? { why: `Firecrawl not reachable at ${base} \u2014 used the built-in extractor.` } : {};
  }
  const r = await postJson(
    base,
    "/scrape",
    {
      url,
      formats: ["markdown"],
      onlyMainContent: true,
      blockAds: true,
      removeBase64Images: true,
      maxAge: SCRAPE_MAX_AGE_MS,
      timeout: SCRAPE_TIMEOUT_MS
    },
    SCRAPE_TIMEOUT_MS
  );
  if (!r.ok) {
    const why = r.status ? `status ${r.status}` : r.error ?? "no response";
    return { why: `Firecrawl could not scrape ${url} (${why}) \u2014 fell back to the built-in extractor.` };
  }
  const data = mapScrapeResponse(r.data);
  if (!data) return { why: `Firecrawl returned no markdown for ${url} \u2014 fell back to the built-in extractor.` };
  return { data };
}
async function searchViaFirecrawl(query, limit, opts = {}) {
  const base = firecrawlBase(opts);
  if (!base) return { why: `Firecrawl disabled (--firecrawl off / ${envName("FIRECRAWL")}=off). Skipping.` };
  if (!await probeFirecrawl(base, firecrawlIsExplicit(opts))) {
    return { why: `Firecrawl not reachable at ${base} (bring it up with \`${brand().cli} firecrawl up\`). Skipping.` };
  }
  const r = await postJson(base, "/search", { query, limit, sources: ["web"] }, SEARCH_TIMEOUT_MS);
  if (!r.ok) {
    const why = r.status === 429 || r.status === 503 ? `rate-limited (HTTP ${r.status})` : `unreachable (status ${r.status || 0})`;
    return { why: `Firecrawl search ${why} at ${base}.` };
  }
  return { hits: mapSearchResponse(r.data) };
}

// src/fetch.ts
var DEFAULT_BROWSER_UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";
function browserUa() {
  return env("UA") || DEFAULT_BROWSER_UA;
}
function contactUa() {
  const b = brand();
  return `${b.name}/${b.version ?? "1.x"} (+${b.contactUrl ?? `https://github.com/maxgfr/${b.name}`})`;
}
function defaultUa() {
  return brand().defaultUa === "contact" ? contactUa() : browserUa();
}
var RETRY_STATUS = /* @__PURE__ */ new Set([429, 503, 502, 504]);
var maxAttempts = () => envInt("MAX_ATTEMPTS", 2, 1, 5);
var defaultRetryMs = () => envInt("RETRY_MS", 600, 0, 5e3);
function pageDelayMs() {
  return envInt("PAGE_DELAY_MS", 350, 0, 5e3);
}
function politeDelayMs() {
  return envInt("POLITE_DELAY_MS", 400, 0, 5e3);
}
function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}
function detectRateLimited(status, headers) {
  if (status === 429) return true;
  return status === 403 && headers.get("x-ratelimit-remaining") === "0";
}
function parseRetryAfter(headers, capMs = 5e3) {
  const h = headers.get("retry-after");
  if (!h) return void 0;
  const secs = Number(h);
  if (Number.isFinite(secs)) return Math.min(Math.max(0, secs) * 1e3, capMs);
  const when = Date.parse(h);
  if (Number.isFinite(when)) return Math.min(Math.max(0, when - Date.now()), capMs);
  return void 0;
}
function retryDelayMs(headers) {
  return parseRetryAfter(headers) ?? defaultRetryMs();
}
function attemptsFor(retries) {
  return retries === void 0 ? maxAttempts() : Math.min(4, Math.max(0, Math.trunc(retries))) + 1;
}
async function readCapped(res, max) {
  return (await readCappedBytes(res, max)).toString("utf8");
}
async function readCappedBytes(res, max) {
  const reader = res.body?.getReader?.();
  if (!reader) return Buffer.from(await res.arrayBuffer()).subarray(0, max);
  const chunks = [];
  let total = 0;
  for (; ; ) {
    const { done, value } = await reader.read();
    if (done) break;
    if (!value?.byteLength) continue;
    const chunk = Buffer.from(value.buffer, value.byteOffset, value.byteLength);
    const remaining = max - total;
    if (chunk.length >= remaining) {
      chunks.push(chunk.subarray(0, remaining));
      await reader.cancel().catch(() => {
      });
      break;
    }
    chunks.push(chunk);
    total += chunk.length;
  }
  return Buffer.concat(chunks);
}
async function httpGet(url, opts = {}) {
  const attempts = attemptsFor(opts.retries);
  let last = { ok: false, status: 0, body: "", contentType: "", url };
  for (let attempt = 0; attempt < attempts; attempt++) {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), opts.timeoutMs ?? 2e4);
    try {
      const headers = { "user-agent": opts.userAgent ?? defaultUa(), accept: opts.accept ?? "*/*" };
      if (opts.acceptLanguage) headers["accept-language"] = opts.acceptLanguage;
      for (const [k, v] of Object.entries(opts.headers ?? {})) headers[k.toLowerCase()] = v;
      const res = await fetch(url, {
        signal: ctrl.signal,
        redirect: "follow",
        headers
      });
      const max = opts.maxBytes ?? 4 * 1024 * 1024;
      const meta = {
        contentType: res.headers.get("content-type") ?? "",
        url: res.url || url,
        etag: res.headers.get("etag") ?? void 0,
        lastModified: res.headers.get("last-modified") ?? void 0,
        rateLimited: detectRateLimited(res.status, res.headers),
        retryAfterMs: parseRetryAfter(res.headers)
      };
      const declared = Number(res.headers.get("content-length"));
      if (Number.isFinite(declared) && declared > max) {
        ctrl.abort();
        return { ok: false, status: res.status, body: "", ...meta, error: `response too large: ${declared} bytes > ${max} cap` };
      }
      const bytes = res.status === 304 ? Buffer.alloc(0) : await readCappedBytes(res, max);
      countFetch(bytes.length, false);
      const result = {
        ok: res.ok,
        status: res.status,
        // Decoded per the response's own encoding, not assumed UTF-8. A
        // Windows-1252 page used to come back with every accented character
        // replaced by U+FFFD, and nothing anywhere noticed.
        body: opts.binary ? "" : decodeBody(bytes, meta.contentType),
        bytes: opts.binary ? bytes : void 0,
        ...meta
      };
      if (RETRY_STATUS.has(res.status) && attempt < attempts - 1) {
        last = result;
        await sleep(retryDelayMs(res.headers));
        continue;
      }
      return result;
    } catch (e) {
      last = { ok: false, status: 0, body: "", contentType: "", url, error: e.message };
      if (attempt < attempts - 1) await sleep(defaultRetryMs());
    } finally {
      clearTimeout(t);
    }
  }
  return last;
}
async function httpJson(method, url, body, opts = {}) {
  const attempts = attemptsFor(opts.retries);
  let last = { ok: false, status: 0, data: void 0 };
  for (let attempt = 0; attempt < attempts; attempt++) {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), opts.timeoutMs ?? 2e4);
    try {
      const headers = {
        "content-type": "application/json",
        accept: opts.accept ?? "application/json",
        "user-agent": opts.userAgent ?? defaultUa()
      };
      if (opts.acceptLanguage) headers["accept-language"] = opts.acceptLanguage;
      for (const [k, v] of Object.entries(opts.headers ?? {})) headers[k.toLowerCase()] = v;
      const res = await fetch(url, {
        method,
        signal: ctrl.signal,
        headers,
        body: body === void 0 ? void 0 : JSON.stringify(body)
      });
      const text = await res.text();
      countFetch(Buffer.byteLength(text), false);
      let data;
      try {
        data = text ? JSON.parse(text) : void 0;
      } catch {
        data = text;
      }
      const result = { ok: res.ok, status: res.status, data };
      if (RETRY_STATUS.has(res.status) && attempt < attempts - 1) {
        last = result;
        await sleep(retryDelayMs(res.headers));
        continue;
      }
      return result;
    } catch (e) {
      last = { ok: false, status: 0, data: void 0, error: e.message };
      if (attempt < attempts - 1) await sleep(defaultRetryMs());
    } finally {
      clearTimeout(t);
    }
  }
  return last;
}
var ENTITIES = {
  "&amp;": "&",
  "&lt;": "<",
  "&gt;": ">",
  "&quot;": '"',
  "&#39;": "'",
  "&apos;": "'",
  "&nbsp;": " ",
  "&mdash;": "\u2014",
  "&ndash;": "\u2013",
  "&hellip;": "\u2026",
  "&copy;": "\xA9",
  // Typographic punctuation CMSes emit as named refs (WordPress "smart" text) —
  // otherwise a curly quote/apostrophe leaks into the report prose verbatim.
  "&lsquo;": "\u2018",
  "&rsquo;": "\u2019",
  "&sbquo;": "\u201A",
  "&ldquo;": "\u201C",
  "&rdquo;": "\u201D",
  "&bdquo;": "\u201E",
  "&bull;": "\u2022",
  "&middot;": "\xB7",
  "&laquo;": "\xAB",
  "&raquo;": "\xBB",
  "&deg;": "\xB0",
  "&plusmn;": "\xB1",
  "&times;": "\xD7",
  "&divide;": "\xF7",
  "&frac12;": "\xBD",
  "&frac14;": "\xBC",
  "&frac34;": "\xBE",
  "&sup2;": "\xB2",
  "&sup3;": "\xB3",
  "&micro;": "\xB5",
  "&trade;": "\u2122",
  "&reg;": "\xAE",
  "&sect;": "\xA7",
  "&para;": "\xB6",
  "&dagger;": "\u2020",
  "&Dagger;": "\u2021",
  "&prime;": "\u2032",
  "&Prime;": "\u2033",
  "&iexcl;": "\xA1",
  "&iquest;": "\xBF",
  "&cent;": "\xA2",
  "&pound;": "\xA3",
  "&curren;": "\xA4",
  "&yen;": "\xA5",
  "&euro;": "\u20AC",
  // Latin-1 accented letters — pervasive in non-English titles/snippets.
  "&agrave;": "\xE0",
  "&aacute;": "\xE1",
  "&acirc;": "\xE2",
  "&atilde;": "\xE3",
  "&auml;": "\xE4",
  "&aring;": "\xE5",
  "&aelig;": "\xE6",
  "&ccedil;": "\xE7",
  "&egrave;": "\xE8",
  "&eacute;": "\xE9",
  "&ecirc;": "\xEA",
  "&euml;": "\xEB",
  "&igrave;": "\xEC",
  "&iacute;": "\xED",
  "&icirc;": "\xEE",
  "&iuml;": "\xEF",
  "&ntilde;": "\xF1",
  "&ograve;": "\xF2",
  "&oacute;": "\xF3",
  "&ocirc;": "\xF4",
  "&otilde;": "\xF5",
  "&ouml;": "\xF6",
  "&oslash;": "\xF8",
  "&ugrave;": "\xF9",
  "&uacute;": "\xFA",
  "&ucirc;": "\xFB",
  "&uuml;": "\xFC",
  "&yacute;": "\xFD",
  "&yuml;": "\xFF",
  "&szlig;": "\xDF",
  "&Agrave;": "\xC0",
  "&Aacute;": "\xC1",
  "&Acirc;": "\xC2",
  "&Auml;": "\xC4",
  "&Aring;": "\xC5",
  "&AElig;": "\xC6",
  "&Ccedil;": "\xC7",
  "&Egrave;": "\xC8",
  "&Eacute;": "\xC9",
  "&Ecirc;": "\xCA",
  "&Euml;": "\xCB",
  "&Iacute;": "\xCD",
  "&Ntilde;": "\xD1",
  "&Oacute;": "\xD3",
  "&Ouml;": "\xD6",
  "&Oslash;": "\xD8",
  "&Uacute;": "\xDA",
  "&Uuml;": "\xDC"
};
var ENTITY_BY_NAME = new Map(Object.entries(ENTITIES).map(([k, v]) => [k.slice(1, -1), v]));
var ENTITY_RE = /&(#[xX][0-9a-fA-F]+|#\d+|[a-zA-Z][a-zA-Z0-9]*);/g;
function decodeEntities(s) {
  return s.replace(ENTITY_RE, (m, ref) => {
    if (ref[0] === "#") {
      const n = ref[1] === "x" || ref[1] === "X" ? Number.parseInt(ref.slice(2), 16) : Number(ref.slice(1));
      try {
        return Number.isFinite(n) ? String.fromCodePoint(n) : " ";
      } catch {
        return " ";
      }
    }
    return ENTITY_BY_NAME.get(ref) ?? m;
  });
}
function cleanInline(s) {
  return decodeEntities(String(s)).replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
}
function htmlToText(html) {
  let s = html;
  s = s.replace(/<!--[\s\S]*?-->/g, " ");
  s = s.replace(/<(script|style|noscript|head|nav|footer|svg|template)[\s\S]*?<\/\1>/gi, " ");
  s = s.replace(/<h([1-6])(?:\s[^>]*)?>/gi, (_m, n) => "\n" + "#".repeat(Number(n)) + " ");
  s = s.replace(/<\/(p|div|section|article|li|tr|td|th|ul|ol|h[1-6]|pre|blockquote|br)>/gi, "\n");
  s = s.replace(/<(p|div|section|article|li|tr|td|th|ul|ol|pre|blockquote|table)\b[^>]*>/gi, "\n");
  s = s.replace(/<(br|hr)\s*\/?>/gi, "\n");
  s = s.replace(/<[^>]+>/g, " ");
  s = decodeEntities(s);
  s = s.replace(/[ \t]+/g, " ").replace(/\n{3,}/g, "\n\n");
  return s.split("\n").map((l) => l.trim()).filter((l) => l.length > 0).join("\n");
}
function htmlTitle(html) {
  const m = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(html);
  if (!m) return void 0;
  const t = decodeEntities(m[1].replace(/\s+/g, " ").trim());
  return t || void 0;
}
function htmlCanonicalUrl(html) {
  const head = html.slice(0, 6e4);
  const canonical = /<link\b[^>]*\brel=["']?canonical["']?[^>]*>/i.exec(head)?.[0];
  const og = /<meta\b[^>]*\bproperty=["']?og:url["']?[^>]*>/i.exec(head)?.[0];
  for (const tag of [canonical, og]) {
    const href = tag && /\b(?:href|content)=["']([^"']+)["']/i.exec(tag)?.[1];
    if (href?.trim()) return decodeEntities(href.trim());
  }
  return void 0;
}
function sliceToMatchingClose(html, start, tag) {
  const re = new RegExp(`<${tag}\\b|</${tag}\\s*>`, "gi");
  re.lastIndex = start;
  let depth = 1;
  let m;
  while (m = re.exec(html)) {
    if (m[0][1] === "/") {
      if (--depth === 0) return html.slice(start, m.index);
    } else {
      depth++;
    }
  }
  return null;
}
function extractMainHtml(html) {
  const visible = (h) => h.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim().length;
  const tiers = [
    /<(main)\b[^>]*>/gi,
    /<(article)\b[^>]*>/gi,
    /<(div|section)\b[^>]*\b(?:id|class)="[^"]*\b(?:content|article|post|entry|story|markdown-body|main|prose)\b[^"]*"[^>]*>/gi
  ];
  let candidates = [];
  for (const re of tiers) {
    const found = [];
    re.lastIndex = 0;
    let m;
    while (m = re.exec(html)) {
      const inner = sliceToMatchingClose(html, re.lastIndex, m[1].toLowerCase());
      if (inner !== null) found.push(inner);
    }
    if (found.length) {
      candidates = found;
      break;
    }
  }
  if (!candidates.length) return html;
  let best = candidates[0];
  let bestLen = visible(best);
  for (const c of candidates.slice(1)) {
    const len = visible(c);
    if (len > bestLen) {
      best = c;
      bestLen = len;
    }
  }
  const fullLen = visible(html);
  if (bestLen < 500 && bestLen < fullLen * 0.3) return html;
  return best;
}
var PDF_URL_RE = /\.pdf($|[?#])/i;
var PDF_ROUTE_RE = /\/pdf\/[^/?#]+($|[?#])/i;
var NON_PDF_TAIL_RE = /\.(html?|php|aspx?|jsp|json|xml|txt|md|csv)($|[?#])/i;
function looksLikePdfUrl(url) {
  if (PDF_URL_RE.test(url)) return true;
  return PDF_ROUTE_RE.test(url) && !NON_PDF_TAIL_RE.test(url);
}
var PDF_FETCH_OPTS = { accept: "application/pdf,*/*", binary: true, maxBytes: 16 * 1024 * 1024 };
var DOC_FETCH_OPTS = { accept: "*/*", binary: true, maxBytes: 16 * 1024 * 1024 };
async function fetchAndExtract(url, opts = {}) {
  const wantsPdf = looksLikePdfUrl(url);
  const wantsDoc = wantsPdf ? void 0 : docFormatForUrl(url);
  let firecrawlNote;
  if (!wantsPdf && !wantsDoc) {
    const fc = await scrapeViaFirecrawl(url, opts);
    if (fc.data && (fc.data.statusCode ?? 200) < 400) {
      return {
        text: fc.data.markdown,
        title: fc.data.title,
        finalUrl: fc.data.sourceURL || url,
        status: fc.data.statusCode ?? 200,
        extractor: "firecrawl"
      };
    }
    firecrawlNote = fc.data ? `Firecrawl got HTTP ${fc.data.statusCode} for ${url} \u2014 fell back to the built-in extractor.` : fc.why;
  }
  const base = wantsPdf ? PDF_FETCH_OPTS : wantsDoc ? DOC_FETCH_OPTS : { accept: "text/html,text/plain,*/*", acceptLanguage: opts.acceptLanguage };
  const fetchOpts = opts.headers ? { ...base, headers: opts.headers } : base;
  let res = await httpGet(url, fetchOpts);
  if (!res.ok && brand().defaultUa === "contact" && (res.status === 403 || res.status === 429)) {
    res = await httpGet(url, { ...fetchOpts, userAgent: browserUa(), acceptLanguage: opts.acceptLanguage ?? "en-US,en;q=0.9" });
  }
  if (res.status === 304) {
    return { text: "", finalUrl: res.url, status: 304, etag: res.etag ?? opts.headers?.["if-none-match"], lastModified: res.lastModified };
  }
  if (!res.ok) {
    const why = res.status === 429 ? "rate-limited (HTTP 429)" : `status ${res.status}${res.error ? ", " + res.error : ""}`;
    return { text: "", finalUrl: res.url, status: res.status, note: `Could not fetch ${url} (${why}).` };
  }
  const validators = res.etag || res.lastModified ? { etag: res.etag, lastModified: res.lastModified } : {};
  if (wantsPdf || /application\/pdf/i.test(res.contentType)) {
    const bytes = res.bytes ?? (await httpGet(url, PDF_FETCH_OPTS)).bytes;
    const got = bytes ? await extractPdf(bytes, {
      firecrawl: async () => {
        const fc = await scrapeViaFirecrawl(url, opts);
        return fc.data && (fc.data.statusCode ?? 200) < 400 ? fc.data.markdown : void 0;
      }
    }) : { text: "", reason: "empty response body" };
    return {
      text: got.text,
      finalUrl: res.url,
      status: res.status,
      // `native` keeps reporting as absent, which is what the cache key and every
      // existing dossier already assume.
      extractor: got.via && got.via !== "native" ? got.via : void 0,
      note: got.text ? firecrawlNote : `Fetched ${url} but could not extract text \u2014 ${got.reason}.`,
      ...validators
    };
  }
  const docFmt = wantsDoc ?? docFormatForContentType(res.contentType);
  if (docFmt) {
    const bytes = res.bytes ?? (await httpGet(url, DOC_FETCH_OPTS)).bytes;
    const got = bytes ? await extractDocument(bytes, docFmt, {
      firecrawl: async () => {
        const fc = await scrapeViaFirecrawl(url, opts);
        return fc.data && (fc.data.statusCode ?? 200) < 400 ? fc.data.markdown : void 0;
      }
    }) : { text: "", reason: "empty response body" };
    if (!got.text && docFmt.textFallback && bytes?.length) {
      return { text: bytes.toString("utf8"), finalUrl: res.url, status: res.status, note: firecrawlNote, ...validators };
    }
    return {
      text: got.text,
      finalUrl: res.url,
      status: res.status,
      extractor: got.via,
      note: got.text ? firecrawlNote : `Fetched ${url} but could not extract text \u2014 ${got.reason}.`,
      ...validators
    };
  }
  const isHtml = /html/i.test(res.contentType) || /^\s*</.test(res.body);
  const stripped = isHtml ? htmlToText(extractMainHtml(res.body)) : res.body;
  const text = isHtml && opts.stripConsent ? stripConsentBoilerplate(stripped).text : stripped;
  const title = isHtml ? htmlTitle(res.body) : void 0;
  const canonical = isHtml ? htmlCanonicalUrl(res.body) : void 0;
  const metaDescription = isHtml ? metaDescriptionOf(res.body) : void 0;
  return {
    text,
    title,
    canonical,
    metaDescription,
    ...opts.keepHtml && isHtml ? { html: res.body } : {},
    finalUrl: res.url,
    status: res.status,
    note: firecrawlNote,
    ...validators
  };
}
var DEAD_LINK_STATUS = /* @__PURE__ */ new Set([404, 410, 451, 403]);
async function rescueViaWayback(url, opts = {}) {
  if (envFlag("NO_WAYBACK")) return void 0;
  const api = `https://archive.org/wayback/available?url=${encodeURIComponent(url)}`;
  const r = await httpJson("GET", api, void 0, { timeoutMs: 1e4, userAgent: contactUa() });
  const snap = r.ok ? r.data?.archived_snapshots?.closest : void 0;
  if (snap?.available !== true || typeof snap.url !== "string") return void 0;
  const got = await fetchAndExtract(snap.url, opts);
  if (!got.text?.trim() || looksLikeJunkExtraction(got.text)) return void 0;
  return { text: got.text, title: got.title, snapshotUrl: snap.url, timestamp: String(snap.timestamp ?? "") };
}
var JUNK_PATTERNS = [
  [/\b(accept|manage)\s+(all\s+)?cookies\b/i, "cookie/consent wall"],
  [/\bwe use cookies\b/i, "cookie/consent wall"],
  [/\bcookie (policy|settings|consent|preferences)\b/i, "cookie/consent wall"],
  [/\b(please )?enable javascript\b/i, "JavaScript-required shell"],
  [/\bjavascript is (disabled|required|not enabled)\b/i, "JavaScript-required shell"],
  [/\bverify (you are|you're|you are a)\b|\bare you a human\b|\bhuman verification\b/i, "anti-bot interstitial"],
  [/\baccess denied\b|\battention required\b.*cloudflare|\bunusual traffic\b|\bare you a robot\b/i, "anti-bot interstitial"],
  [/\benable cookies\b|\bchecking your browser\b/i, "anti-bot interstitial"],
  // FR / DE (the locale layer targets non-EN markets)
  [/\bnous utilisons des cookies\b|\baccepter (tous )?les cookies\b|\bactiver javascript\b/i, "cookie/consent wall (fr)"],
  [/\bwir verwenden cookies\b|\bcookies akzeptieren\b|\bjavascript aktivieren\b/i, "cookie/consent wall (de)"]
];
function looksLikeJunkExtraction(text) {
  const t = text.trim();
  if (t.length >= 2e3) return void 0;
  const head = t.slice(0, 800);
  for (const [re, reason] of JUNK_PATTERNS) if (re.test(head)) return reason;
  return void 0;
}
var CONSENT_PATTERNS = [
  /\bcookies?\b/i,
  /\bconsent\b/i,
  /\bgdpr\b/i,
  /\bccpa\b/i,
  /accept all\b/i,
  /reject all\b/i,
  /manage (?:preferences|choices|cookies|settings)/i,
  /privacy (?:policy|preferences|choices)/i,
  /tracking technolog/i,
  /advertising partners/i,
  /legitimate interest/i
];
function stripConsentBoilerplate(text) {
  let dropped = 0;
  const kept = text.split("\n").filter((line) => {
    const hits = CONSENT_PATTERNS.reduce((n, re) => n + (re.test(line) ? 1 : 0), 0);
    const isBanner = hits >= 2 || hits === 1 && line.trim().length < 120;
    if (isBanner) dropped++;
    return !isBanner;
  });
  return { text: kept.join("\n"), dropped };
}
function metaDescriptionOf(html) {
  const m = /<meta[^>]+name=["']description["'][^>]*content=["']([^"']+)["']/i.exec(html) || /<meta[^>]+content=["']([^"']+)["'][^>]*name=["']description["']/i.exec(html) || /<meta[^>]+property=["']og:description["'][^>]*content=["']([^"']+)["']/i.exec(html);
  const d = m?.[1]?.replace(/\s+/g, " ").trim();
  return d ? decodeEntities(d) : void 0;
}
function focusedSnippet(text, question, opts = {}) {
  const maxChars = opts.maxChars ?? 360;
  const maxSentences = opts.maxSentences ?? 3;
  const lines = text.split("\n");
  const matcher = buildMatcher(question);
  const sentences = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (/^#{1,6}\s/.test(line)) continue;
    for (const raw of line.split(/(?<=[.!?])\s+/)) {
      const t = raw.trim();
      if (t.length < 20) continue;
      sentences.push({ text: t, line: i, score: matcher.matchLine(t).size });
    }
  }
  if (!sentences.length) return lines.slice(0, 4).join(" ").slice(0, maxChars).trim();
  const hits = sentences.filter((s) => s.score > 0);
  const chosen = (hits.length ? hits : sentences).map((s, idx) => ({ s, idx })).sort((a, b) => b.s.score - a.s.score || a.idx - b.idx).slice(0, maxSentences).sort((a, b) => a.idx - b.idx).map((x) => x.s);
  const heading = nearestHeading(lines, chosen[0].line);
  let out = chosen.map((s) => s.text).join(" ");
  if (heading && !out.startsWith(heading)) out = `${heading} \u2014 ${out}`;
  return out.slice(0, maxChars).trim();
}
function bestExcerpt(text, question, maxChars = 360) {
  return focusedSnippet(text, question, { maxChars, maxSentences: 2 });
}
function capExtract(text, depth) {
  const cap = depth === "deep" ? Infinity : depth === "standard" ? 8e3 : 4e3;
  if (text.length <= cap) return text;
  const slice = text.slice(0, cap);
  const lastNl = slice.lastIndexOf("\n");
  return (lastNl > cap * 0.6 ? slice.slice(0, lastNl) : slice) + "\n\n\u2026 [truncated]";
}

// src/url.ts
var TRACKING_PARAMS = /^(utm_|fbclid$|gclid$|mc_|ref$|ref_src$|ref_url$|spm$|_hsenc$|_hsmi$|igshid$)/i;
function canonicalizeUrl(raw) {
  try {
    const u = new URL(raw.trim());
    const proto = u.protocol.toLowerCase();
    const host = u.hostname.toLowerCase().replace(/^www\./, "");
    let port = u.port;
    if (proto === "http:" && port === "80" || proto === "https:" && port === "443") port = "";
    const path = u.pathname.replace(/\/+$/, "");
    const keep = [];
    for (const [k, v] of u.searchParams) {
      if (!TRACKING_PARAMS.test(k)) keep.push([k, v]);
    }
    keep.sort((a, b) => a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0);
    const search2 = keep.length ? "?" + keep.map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`).join("&") : "";
    return `${proto}//${host}${port ? ":" + port : ""}${path}${search2}`.replace(/\/$/, "");
  } catch {
    return raw.trim().replace(/#.*$/, "").replace(/\/$/, "");
  }
}
function normalizeDoi(doi) {
  return doi.trim().toLowerCase().replace(/^https?:\/\/(dx\.)?doi\.org\//, "");
}
function domainOf(raw) {
  try {
    const u = new URL(raw);
    if (u.protocol === "file:") return LOCAL_FILE_DOMAIN;
    return u.hostname.toLowerCase().replace(/^www\./, "");
  } catch {
    return "";
  }
}
var LOCAL_FILE_DOMAIN = "local file";
var FNV_OFFSET = 0xcbf29ce484222325n;
var FNV_PRIME = 0x100000001b3n;
var MASK64 = (1n << 64n) - 1n;
function fnv1a64(s) {
  let h = FNV_OFFSET;
  for (let i = 0; i < s.length; i++) {
    h ^= BigInt(s.charCodeAt(i));
    h = h * FNV_PRIME & MASK64;
  }
  return h;
}

// src/rank.ts
function rrf(lists, keyOf, k = 60) {
  const score = /* @__PURE__ */ new Map();
  for (const list of lists) {
    list.forEach((item, idx) => {
      const key = keyOf(item);
      score.set(key, (score.get(key) ?? 0) + 1 / (k + idx + 1));
    });
  }
  return score;
}
function arxivIdFromUrl(url) {
  let host;
  let path;
  try {
    const u = new URL(url.trim());
    host = u.hostname.toLowerCase();
    path = u.pathname;
  } catch {
    return void 0;
  }
  if (!/(^|\.)arxiv\.org$/.test(host)) return void 0;
  const modern = /\/(?:abs|pdf|html|format)\/(\d{4}\.\d{4,5})(?:v\d+)?(?:\.pdf)?$/i.exec(path);
  if (modern) return modern[1].toLowerCase();
  const legacy = /\/(?:abs|pdf|html|format)\/([a-z-]+(?:\.[A-Z]{2})?\/\d{7})(?:v\d+)?(?:\.pdf)?$/i.exec(path);
  if (legacy) return legacy[1].toLowerCase();
  return void 0;
}
function doiFromUrl(url) {
  let host;
  let path;
  try {
    const u = new URL(url.trim());
    host = u.hostname.toLowerCase();
    path = u.pathname;
  } catch {
    return void 0;
  }
  if (/(^|\.)(dx\.)?doi\.org$/.test(host)) {
    const doi = normalizeDoi(decodeURIComponent(path.replace(/^\/+/, "").replace(/\/+$/, "")));
    return /^10\.\d{4,9}\//.test(doi) ? doi : void 0;
  }
  const m = /\/doi(?:\/(?:abs|full|pdf|epdf|e?pub))?\/(10\.\d{4,9}\/[^\s?#]+)/i.exec(path);
  if (m) return normalizeDoi(decodeURIComponent(m[1]).replace(/\/+$/, ""));
  return void 0;
}
function dedupeByUrl(items) {
  const best = /* @__PURE__ */ new Map();
  const order = [];
  let dropped = 0;
  for (const it of items) {
    const key = canonicalizeUrl(it.url);
    const prev = best.get(key);
    if (!prev) {
      best.set(key, it);
      order.push(key);
    } else {
      dropped++;
      if (it.score > prev.score) best.set(key, it);
    }
  }
  return { items: order.map((k) => best.get(k)), dropped };
}
function bm25Tokenize(text) {
  if (!text) return [];
  const out = [];
  for (const raw of text.split(/[^\p{L}\p{N}_]+/u)) {
    if (raw.length < 2) continue;
    if (isStopword(raw)) continue;
    const t = foldTerm(raw);
    if (t.length >= 2) out.push(t);
  }
  return out;
}
function docTokens(doc, titleWeight, headingWeight) {
  const out = bm25Tokenize(doc.body);
  const headings = bm25Tokenize(doc.headings);
  for (let r = 0; r < headingWeight; r++) out.push(...headings);
  const title = bm25Tokenize(doc.title);
  for (let r = 0; r < titleWeight; r++) out.push(...title);
  return out;
}
function proximityBonus(tokens, queryTerms, window = 6, cap = 0.1) {
  if (queryTerms.length < 2) return 0;
  const q = new Set(queryTerms);
  const hits = [];
  for (let i = 0; i < tokens.length; i++) {
    const tok = tokens[i];
    if (q.has(tok)) hits.push({ pos: i, term: tok });
  }
  if (hits.length < 2) return 0;
  let close = 0;
  for (let i = 1; i < hits.length; i++) {
    if (hits[i].term !== hits[i - 1].term && hits[i].pos - hits[i - 1].pos <= window) close++;
  }
  return Math.min(cap, cap * (close / Math.max(1, queryTerms.length - 1)));
}
function buildBm25Index(question, docs, opts = {}) {
  const k1 = opts.k1 ?? 1.2;
  const b = opts.b ?? 0.75;
  const titleWeight = 3;
  const headingWeight = 2;
  const queryTerms = [...new Set(bm25Tokenize(question))];
  const N = docs.length;
  const df = /* @__PURE__ */ new Map();
  let totalLen = 0;
  for (const doc of docs) {
    const toks = docTokens(doc, titleWeight, headingWeight);
    totalLen += toks.length;
    for (const t of new Set(toks)) df.set(t, (df.get(t) ?? 0) + 1);
  }
  const avgdl = N ? totalLen / N : 0;
  const idf = /* @__PURE__ */ new Map();
  for (const t of queryTerms) {
    if (N < 3) {
      idf.set(t, 1);
      continue;
    }
    const dfi = df.get(t) ?? 0;
    idf.set(t, Math.log(1 + (N - dfi + 0.5) / (dfi + 0.5)));
  }
  return { idf, avgdl, N, queryTerms, k1, b, titleWeight, headingWeight };
}
function bm25Score(index, doc) {
  if (!index.queryTerms.length) return 0;
  const toks = docTokens(doc, index.titleWeight, index.headingWeight);
  const dl = toks.length;
  if (!dl) return 0;
  const tf = /* @__PURE__ */ new Map();
  for (const t of toks) tf.set(t, (tf.get(t) ?? 0) + 1);
  const { k1, b, avgdl } = index;
  const lenNorm = 1 - b + b * (avgdl ? dl / avgdl : 1);
  let score = 0;
  for (const term of index.queryTerms) {
    const f = tf.get(term);
    if (!f) continue;
    const idf = index.idf.get(term) ?? 0;
    score += idf * (f * (k1 + 1)) / (f + k1 * lenNorm);
  }
  return score * (1 + proximityBonus(toks, index.queryTerms));
}
function bm25MatchedTerms(index, doc) {
  if (!index.queryTerms.length) return [];
  const present = new Set(docTokens(doc, index.titleWeight, index.headingWeight));
  return index.queryTerms.filter((t) => present.has(t));
}
function applyRelevanceFloor(ranked, matchedOf, queryTerms, floor) {
  const isAlpha = (t) => new RegExp("\\p{L}", "u").test(t);
  const alphaTerms = queryTerms.filter(isAlpha);
  if (queryTerms.length < 2 || alphaTerms.length < 1) return { kept: [...ranked], dropped: [] };
  const offTopic = (t) => {
    const m = matchedOf(t);
    return m.length === 0 || m.every((term) => !isAlpha(term));
  };
  const kept = [];
  const dropped = [];
  for (const t of ranked) (offTopic(t) ? dropped : kept).push(t);
  while (kept.length < floor && dropped.length) kept.push(dropped.shift());
  return { kept, dropped };
}
function contentCoverage(matcher, text) {
  if (!matcher.canonicals.length || !text) return 0;
  const hit = /* @__PURE__ */ new Set();
  for (const line of text.split("\n")) {
    for (const c of matcher.matchLine(line)) hit.add(c);
    if (hit.size === matcher.canonicals.length) break;
  }
  return hit.size / matcher.canonicals.length;
}
function recencyScore(meta, minYear, maxYear) {
  const y = typeof meta?.year === "number" ? meta.year : void 0;
  if (y === void 0 || maxYear <= minYear) return 0.5;
  const clamped = Math.min(maxYear, Math.max(minYear, y));
  return (clamped - minYear) / (maxYear - minYear);
}
function simhash(text) {
  const toks = bm25Tokenize(text);
  const shingles = [];
  if (toks.length < 3) shingles.push(...toks);
  else for (let i = 0; i + 3 <= toks.length; i++) shingles.push(`${toks[i]} ${toks[i + 1]} ${toks[i + 2]}`);
  if (!shingles.length) return 0n;
  const v = new Array(64).fill(0);
  for (const sh2 of shingles) {
    const h = fnv1a64(sh2);
    for (let b = 0; b < 64; b++) v[b] += (h >> BigInt(b) & 1n) === 1n ? 1 : -1;
  }
  let out = 0n;
  for (let b = 0; b < 64; b++) if (v[b] > 0) out |= 1n << BigInt(b);
  return out;
}
function hammingDistance(a, b) {
  let x = a ^ b;
  let count = 0;
  while (x) {
    x &= x - 1n;
    count++;
  }
  return count;
}
function dedupeNearDuplicates(items, opts = {}) {
  const maxBits = opts.maxBits ?? 3;
  const minChars = opts.minChars ?? 500;
  const better = (a, b) => a.score !== b.score ? a.score > b.score : a.url.localeCompare(b.url) < 0;
  const kept = [];
  let dropped = 0;
  for (const it of items) {
    const text = it.text || "";
    const hash = text.length >= minChars ? simhash(text) : null;
    if (hash !== null) {
      const dup = kept.find((k) => k.hash !== null && hammingDistance(k.hash, hash) <= maxBits);
      if (dup) {
        dropped++;
        if (better(it, dup.it)) {
          dup.it = it;
          dup.hash = hash;
        }
        continue;
      }
    }
    kept.push({ it, hash });
  }
  return { items: kept.map((k) => k.it), dropped };
}
function diversify(items, tokensOf, lambda = 0.75) {
  if (items.length <= 2) return [...items];
  const toks = new Map(items.map((it) => [it, tokensOf(it)]));
  const max = Math.max(...items.map((it) => it.score), 1e-9);
  const rel = (it) => it.score / max;
  const jaccard = (a, b) => {
    if (!a.size || !b.size) return 0;
    const [small, large] = a.size <= b.size ? [a, b] : [b, a];
    let inter = 0;
    for (const t of small) if (large.has(t)) inter++;
    return inter / (a.size + b.size - inter);
  };
  let simMax = 0;
  for (let i = 0; i < items.length; i++) {
    for (let j = i + 1; j < items.length; j++) {
      const v = jaccard(toks.get(items[i]), toks.get(items[j]));
      if (v > simMax) simMax = v;
    }
  }
  const sim = (a, b) => simMax > 0 ? jaccard(toks.get(a), toks.get(b)) / simMax : 0;
  const remaining = [...items];
  const out = [];
  remaining.sort((a, b) => b.score - a.score || a.url.localeCompare(b.url));
  out.push(remaining.shift());
  const maxSim = new Map(remaining.map((it) => [it, sim(it, out[0])]));
  while (remaining.length) {
    let bestIdx = 0;
    let bestVal = Number.NEGATIVE_INFINITY;
    for (let i = 0; i < remaining.length; i++) {
      const it = remaining[i];
      const val = lambda * rel(it) - (1 - lambda) * (maxSim.get(it) ?? 0);
      if (val > bestVal || val === bestVal && it.url.localeCompare(remaining[bestIdx].url) < 0) {
        bestVal = val;
        bestIdx = i;
      }
    }
    const picked = remaining.splice(bestIdx, 1)[0];
    out.push(picked);
    for (const it of remaining) maxSim.set(it, Math.max(maxSim.get(it) ?? 0, sim(it, picked)));
  }
  return out;
}
var URL_IN_TEXT = /https?:\/\/[a-z0-9.-]+/gi;
function externalHosts(url, text) {
  const self = domainOf(url).replace(/^www\./, "");
  const out = /* @__PURE__ */ new Set();
  for (const m of text.match(URL_IN_TEXT) ?? []) {
    const h = domainOf(m).replace(/^www\./, "");
    if (h && h !== self) out.add(h);
  }
  return out;
}

// src/citable.ts
var API_HOSTS = /* @__PURE__ */ new Set(["eutils.ncbi.nlm.nih.gov", "api.crossref.org", "api.openalex.org", "api.semanticscholar.org", "export.arxiv.org"]);
var API_PATHS = [/^\/europepmc\/webservices\//i, /^\/search\/publ\/api/i, /^\/api\//i, /\.(fcgi|cgi)$/i];
var API_FORMATS = /[?&](format|retmode|rettype|output)=(json|xml|text|atom|csv|bibtex)\b/i;
function isApiEndpoint(url) {
  try {
    const u = new URL(url);
    if (API_HOSTS.has(u.hostname.toLowerCase().replace(/^www\./, ""))) return true;
    if (API_PATHS.some((re) => re.test(u.pathname))) return true;
    return API_FORMATS.test(u.search);
  } catch {
    return false;
  }
}
var ID_PARAMS = ["id", "ids", "uid", "uids", "pmid", "doi", "identifier"];
function addressedIdCount(url) {
  try {
    const params = new URL(url).searchParams;
    for (const name of ID_PARAMS) {
      const raw = params.get(name);
      if (!raw) continue;
      const ids = raw.split(/[,\s+]+/).map((s) => s.trim()).filter(Boolean);
      if (ids.length) return ids.length;
    }
  } catch {
  }
  return 0;
}
function isCitableUrl(url) {
  try {
    const u = new URL(url);
    return (u.protocol === "https:" || u.protocol === "http:") && !isApiEndpoint(url);
  } catch {
    return false;
  }
}
var DOI_RE = /\b(10\.\d{4,9}\/[^\s"'<>()[\],;]+)/;
var ARXIV_RE = /\barxiv[:\s/]+((?:\d{4}\.\d{4,5}|[a-z-]+(?:\.[A-Z]{2})?\/\d{7})(?:v\d+)?)/i;
var PMID_RE = /\bPMID:?\s*(\d{4,9})\b/i;
var ARXIV_ID_PATH_RE = /\/(\d{4}\.\d{4,5}(?:v\d+)?)(?:$|[/?#])/;
function urlDeclaresIdentity(url) {
  return DOI_RE.test(url) || ARXIV_ID_PATH_RE.test(url);
}
function deriveCitableUrl(text, canonical) {
  if (canonical && isCitableUrl(canonical)) return canonical;
  const head = text.slice(0, 4e3);
  const doi = head.match(DOI_RE)?.[1];
  if (doi) return `https://doi.org/${doi.replace(/[.,;:)\]]+$/, "")}`;
  const arxiv = head.match(ARXIV_RE)?.[1];
  if (arxiv) return `https://arxiv.org/abs/${arxiv}`;
  const pmid = head.match(PMID_RE)?.[1];
  if (pmid) return `https://pubmed.ncbi.nlm.nih.gov/${pmid}/`;
  return void 0;
}

// src/providers.ts
var PUBMED_LANDING = /^https?:\/\/(?:www\.)?pubmed\.ncbi\.nlm\.nih\.gov\/(\d{4,9})\/?$/i;
var PMC_LANDING = /^https?:\/\/(?:www\.)?pmc\.ncbi\.nlm\.nih\.gov\/articles\/(PMC\d+)\/?$/i;
var EUTILS = /^https?:\/\/eutils\.ncbi\.nlm\.nih\.gov\/entrez\/eutils\/([a-z]+)\.fcgi/i;
var ARXIV_PDF = /^https?:\/\/(?:www\.|export\.)?arxiv\.org\/pdf\/([^?#]+?)(?:\.pdf)?\/?$/i;
function eutilsIds(raw) {
  return (raw ?? "").split(/[,\s+]+/).map((s) => s.trim()).filter(Boolean);
}
function pubmedAbstractUrl(pmid) {
  return `https://eutils.ncbi.nlm.nih.gov/entrez/eutils/efetch.fcgi?db=pubmed&id=${pmid}&rettype=abstract&retmode=text`;
}
function resolveProvider(url) {
  const raw = url.trim();
  const pubmed = raw.match(PUBMED_LANDING);
  if (pubmed) {
    const pmid = pubmed[1];
    return { citeUrl: `https://pubmed.ncbi.nlm.nih.gov/${pmid}/`, textUrl: pubmedAbstractUrl(pmid) };
  }
  const pmc = raw.match(PMC_LANDING);
  if (pmc) return { citeUrl: `https://pmc.ncbi.nlm.nih.gov/articles/${pmc[1].toUpperCase()}/` };
  const eutils = raw.match(EUTILS);
  if (eutils) return resolveEutils(raw, eutils[1].toLowerCase());
  const arxiv = raw.match(ARXIV_PDF);
  if (arxiv) return { citeUrl: `https://arxiv.org/abs/${arxiv[1]}`, textUrl: raw, preferText: true };
  return { citeUrl: raw };
}
function resolveEutils(raw, op) {
  let params;
  try {
    params = new URL(raw).searchParams;
  } catch {
    return { citeUrl: raw };
  }
  if (op === "esearch" || op === "egquery" || op === "espell") {
    return { citeUrl: raw, reject: `${raw} is an E-utilities ${op} query, not a document \u2014 fetch the record it points at instead.` };
  }
  const db = (params.get("db") ?? "").toLowerCase();
  const ids = eutilsIds(params.get("id"));
  const id = ids[0];
  if (!id) return { citeUrl: raw };
  if (db === "pubmed" && /^\d+$/.test(id)) {
    return { citeUrl: `https://pubmed.ncbi.nlm.nih.gov/${id}/`, textUrl: pubmedAbstractUrl(id) };
  }
  if (db === "pmc") {
    const pmcid = /^pmc/i.test(id) ? id.toUpperCase() : `PMC${id}`;
    return { citeUrl: `https://pmc.ncbi.nlm.nih.gov/articles/${pmcid}/` };
  }
  return { citeUrl: raw };
}

// src/locale.ts
var LANG_COUNTRY = {
  en: "us",
  pt: "br",
  ja: "jp",
  zh: "cn",
  ko: "kr",
  sv: "se",
  da: "dk",
  cs: "cz",
  el: "gr",
  uk: "ua",
  // Ukrainian language → Ukraine
  ar: "xa",
  // DuckDuckGo's "Arabia" region
  he: "il",
  hi: "in"
};
var REGION_ALIASES = {
  gb: "uk",
  en: "us"
};
function baseLang(lang) {
  return (lang || "en").split("-")[0].toLowerCase();
}
function resolveRegion(lang, region) {
  if (region?.trim()) return region.trim().toLowerCase();
  const parts = (lang || "en").split("-");
  if (parts.length > 1 && parts[1]) return parts[1].toLowerCase();
  const l = baseLang(lang);
  return LANG_COUNTRY[l] ?? l;
}
function ddgRegion(lang, region) {
  const l = baseLang(lang);
  let r = resolveRegion(lang, region);
  r = REGION_ALIASES[r] ?? r;
  return `${r}-${l}`;
}
function acceptLanguageHeader(lang, region) {
  const l = baseLang(lang);
  const R = resolveRegion(lang, region).toUpperCase();
  if (l === "en") return `${l}-${R},${l};q=0.9`;
  return `${l}-${R},${l};q=0.9,en;q=0.5`;
}

// src/exec.ts
import { spawn as spawn2, spawnSync } from "child_process";
var STDOUT_CAP = 24 * 1024 * 1024;
var defaultTimeoutMs = () => envInt("SH_TIMEOUT_MS", 6e4, 1e3);
function toResult(status, stdout, stderr, err) {
  const missing = err?.code === "ENOENT";
  return {
    ok: !missing && status === 0,
    status: status ?? (missing ? 127 : 1),
    stdout,
    stderr: stderr || (err ? err.message : ""),
    ...missing ? { missing: true } : {}
  };
}
var havePresence = /* @__PURE__ */ new Map();
function have(cmd) {
  let hit = havePresence.get(cmd);
  if (hit === void 0) {
    const probe = spawnSync(process.platform === "win32" ? "where" : "which", [cmd], { encoding: "utf8" });
    hit = probe.status === 0 && (probe.stdout ?? "").trim().length > 0;
    havePresence.set(cmd, hit);
  }
  return hit;
}
function resetHaveCache() {
  havePresence.clear();
}
function sh(cmd, args, opts = {}) {
  const r = spawnSync(cmd, args, {
    cwd: opts.cwd,
    input: opts.input,
    timeout: opts.timeoutMs ?? defaultTimeoutMs(),
    encoding: "utf8",
    maxBuffer: STDOUT_CAP,
    env: opts.env ?? process.env
  });
  return toResult(r.status, r.stdout ?? "", r.stderr ?? "", r.error);
}
function shAsync(cmd, args, opts = {}) {
  const timeoutMs = opts.timeoutMs ?? defaultTimeoutMs();
  return new Promise((resolve4) => {
    let settled = false;
    const done = (r) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve4(r);
    };
    const child = spawn2(cmd, args, { cwd: opts.cwd, env: opts.env ?? process.env, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout?.on("data", (d) => {
      if (stdout.length < STDOUT_CAP) stdout += String(d);
    });
    child.stderr?.on("data", (d) => {
      if (stderr.length < STDOUT_CAP) stderr += String(d);
    });
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      done({ ok: false, status: 124, stdout, stderr: stderr || `timed out after ${timeoutMs}ms` });
    }, timeoutMs);
    child.on("error", (e) => done(toResult(null, stdout, stderr, e)));
    child.on("close", (code) => done(toResult(code, stdout, stderr)));
  });
}

// src/repo.ts
import { existsSync as existsSync2, mkdirSync, readdirSync, rmSync as rmSync2, statSync } from "fs";
import { tmpdir as tmpdir2 } from "os";
import { basename, join as join2, resolve } from "path";
function repoCacheRoot() {
  return env("REPO_DIR") ?? brand().repoDir ?? join2(tmpdir2(), brand().name, "repos");
}
var cloneTimeoutMs = () => envInt("GIT_CLONE_TIMEOUT_MS", 3e5, 1e3);
var fetchTimeoutMs = () => envInt("GIT_FETCH_TIMEOUT_MS", 12e4, 1e3);
var historyTimeoutMs = () => envInt("GIT_HISTORY_TIMEOUT_MS", 3e5, 1e3);
function resolveRepo(raw) {
  const trimmed = raw.trim();
  if (trimmed) {
    const asPath = resolve(trimmed);
    if (existsSync2(asPath) && statSync(asPath).isDirectory()) {
      return { raw: trimmed, host: "local", isLocal: true, slug: `local-${slugify(`${basename(asPath)}-${asPath}`)}` };
    }
  }
  const file = /^file:\/\/(\/.*)$/.exec(trimmed);
  if (file) {
    const p = file[1].replace(/\.git$/, "").replace(/\/+$/, "");
    return {
      raw: trimmed,
      host: "file",
      ...basename(p) ? { repo: basename(p) } : {},
      cloneUrl: trimmed,
      isLocal: false,
      slug: `file-${slugify(p)}`
    };
  }
  let host;
  let path;
  const scp = /^git@([^:]+):(.+)$/.exec(trimmed);
  const url = /^[a-z][a-z0-9+.-]*:\/\/(?:[^@/]+@)?([^/:]+)(?::\d+)?\/(.+)$/i.exec(trimmed);
  const hostPath = /^([a-z0-9.-]+\.[a-z]{2,})\/(.+)$/i.exec(trimmed);
  if (scp) {
    host = scp[1];
    path = scp[2];
  } else if (url) {
    host = url[1];
    path = url[2];
  } else if (hostPath) {
    host = hostPath[1];
    path = hostPath[2];
  } else if (/^[\w.-]+\/[\w.-]+$/.test(trimmed)) {
    host = "github.com";
    path = trimmed;
  } else {
    return { raw: trimmed, host: "generic", isLocal: false, slug: slugify(trimmed) || "seed" };
  }
  host = host.toLowerCase();
  path = path.replace(/\.git$/, "").replace(/\/+$/, "");
  const segments = path.split("/").filter(Boolean);
  const repo = segments.length ? segments[segments.length - 1] : void 0;
  const owner = segments.length > 1 ? segments.slice(0, -1).join("/") : void 0;
  const base = /^https?:\/\//i.test(trimmed) || scp ? trimmed.replace(/\/+$/, "") : `https://${host}/${path}.git`;
  return {
    raw: trimmed,
    host,
    ...owner ? { owner } : {},
    ...repo ? { repo } : {},
    cloneUrl: base.endsWith(".git") ? base : `${base}.git`,
    webUrl: `https://${host}/${path}`,
    isLocal: false,
    slug: slugify(`${host}/${path}`)
  };
}
async function ensureClone(ref, opts = {}) {
  if (ref.isLocal) return resolve(ref.raw);
  if (!ref.cloneUrl) throw new Error(`"${ref.raw}" does not name a repository that can be cloned`);
  if (!have("git")) throw new Error(`git is not installed or not on PATH \u2014 cannot clone ${ref.cloneUrl}`);
  const dir = join2(repoCacheRoot(), ref.slug);
  const cloned = existsSync2(join2(dir, ".git"));
  if (cloned && !opts.refresh) return dir;
  if (cloned && opts.refresh) {
    await shAsync("git", ["-C", dir, "fetch", "--depth", "1", "origin"], { timeoutMs: fetchTimeoutMs() });
    await shAsync("git", ["-C", dir, "reset", "--hard", "FETCH_HEAD"], { timeoutMs: fetchTimeoutMs() });
    return dir;
  }
  mkdirSync(repoCacheRoot(), { recursive: true });
  const args = ["clone", "--depth", "1", "--filter=blob:none", ...opts.branch ? ["--branch", opts.branch] : [], ref.cloneUrl, dir];
  const first = await shAsync("git", args, { timeoutMs: cloneTimeoutMs() });
  if (!first.ok) {
    if (existsSync2(dir)) {
      try {
        rmSync2(dir, { recursive: true, force: true });
      } catch (e) {
        throw new Error(`could not remove the partial clone at ${dir} before retrying: ${e.message} \u2014 delete it and re-run`);
      }
    }
    const retry = await shAsync("git", ["clone", "--depth", "1", ...opts.branch ? ["--branch", opts.branch] : [], ref.cloneUrl, dir], {
      timeoutMs: cloneTimeoutMs()
    });
    if (!retry.ok) {
      throw new Error(
        [
          `git clone failed for ${ref.cloneUrl}`,
          `  attempt 1 (--filter=blob:none): ${first.stderr.trim() || `exit ${first.status}`}`,
          `  attempt 2 (no filter):          ${retry.stderr.trim() || `exit ${retry.status}`}`
        ].join("\n")
      );
    }
  }
  if (!existsSync2(dir) || readdirSync(dir).length === 0) throw new Error(`clone produced an empty tree at ${dir}`);
  return dir;
}
var deepened = /* @__PURE__ */ new Map();
function resetHistoryDepthCache() {
  deepened.clear();
}
async function ensureHistoryDepth(dir, opts = {}) {
  const cached = deepened.get(dir);
  if (cached) return cached;
  const out = await computeHistoryDepth(dir, opts);
  deepened.set(dir, out);
  return out;
}
async function computeHistoryDepth(dir, opts) {
  if (!have("git")) return { ok: false, note: "git is not installed \u2014 no commit history available." };
  const probe = await shAsync("git", ["-C", dir, "rev-parse", "--is-shallow-repository"], { timeoutMs: 1e4 });
  if (!probe.ok) return { ok: false, note: "Not a git working tree \u2014 no commit history available." };
  const filter = await shAsync("git", ["-C", dir, "config", "remote.origin.partialclonefilter"], { timeoutMs: 1e4 });
  const shallow = probe.stdout.trim() === "true";
  const partial = filter.ok && filter.stdout.trim() !== "";
  if (!shallow && !partial) return { ok: true };
  if (partial) await shAsync("git", ["-C", dir, "config", "remote.origin.partialclonefilter", ""], { timeoutMs: 1e4 });
  const full = await shAsync("git", ["-C", dir, "fetch", "--quiet", ...partial ? ["--refetch"] : [], ...shallow ? ["--unshallow"] : [], "origin"], {
    timeoutMs: historyTimeoutMs()
  });
  if (full.ok) return { ok: true };
  if (shallow && !partial) {
    const deepen = await shAsync("git", ["-C", dir, "fetch", "--quiet", `--deepen=${opts.deepen ?? 500}`, "origin"], { timeoutMs: fetchTimeoutMs() });
    return deepen.ok ? { ok: true, note: `History deepened to ~${opts.deepen ?? 500} commits (full unshallow failed); older changes may be missing.` } : { ok: false, note: "Shallow clone could not be deepened (offline?); history is limited to the latest commit." };
  }
  return { ok: false, note: "Could not fetch full history (offline, or the repo is too large); history results may be incomplete." };
}
function headCommit(dir) {
  const r = sh("git", ["-C", dir, "rev-parse", "HEAD"], { timeoutMs: 1e4 });
  return r.ok ? r.stdout.trim() || void 0 : void 0;
}
function originUrl(dir) {
  const r = sh("git", ["-C", dir, "remote", "get-url", "origin"], { timeoutMs: 1e4 });
  return r.ok ? r.stdout.trim() || void 0 : void 0;
}
var MIN_ABBREV = 7;
function sameCommit(a, b) {
  if (!a || !b) return false;
  if (a === b) return true;
  const [short, long] = a.length <= b.length ? [a, b] : [b, a];
  return short.length >= MIN_ABBREV && long.startsWith(short);
}

// src/forge.ts
function forgeKind(host) {
  const h = host.toLowerCase();
  if (h === "github.com" || h.endsWith(".github.com") || h.startsWith("github.")) return "github";
  if (h === "gitlab.com" || h.includes("gitlab")) return "gitlab";
  if (h.includes("gitea") || h.includes("codeberg")) return "gitea";
  return void 0;
}
function apiBase(ref, opts = {}) {
  if (opts.apiBase) return opts.apiBase.replace(/\/+$/, "");
  const host = typeof ref === "string" ? ref : ref.host;
  const kind = forgeKind(host);
  if (kind === "github") return host === "github.com" ? "https://api.github.com" : `https://${host}/api/v3`;
  if (kind === "gitlab") return `https://${host}/api/v4`;
  return `https://${host}/api/v1`;
}
function forgeAuthHeaders(kind) {
  if (kind === "github") {
    const t2 = env("GITHUB_TOKEN") ?? process.env.GITHUB_TOKEN ?? process.env.GH_TOKEN;
    return t2 ? { authorization: `Bearer ${t2}` } : {};
  }
  if (kind === "gitlab") {
    const t2 = env("GITLAB_TOKEN") ?? process.env.GITLAB_TOKEN;
    return t2 ? { "private-token": t2 } : {};
  }
  const t = env("GITEA_TOKEN") ?? process.env.GITEA_TOKEN;
  return t ? { authorization: `token ${t}` } : {};
}
function reqOpts(kind, opts) {
  return {
    timeoutMs: opts.timeoutMs ?? 15e3,
    userAgent: contactUa(),
    headers: { ...forgeAuthHeaders(kind), ...kind === "github" ? { accept: "application/vnd.github+json" } : {} }
  };
}
function clip(s, n = 1200) {
  return String(s ?? "").replace(/\r/g, "").trim().slice(0, n);
}
function labelsOf(v) {
  if (!Array.isArray(v)) return [];
  return v.map((l) => typeof l === "string" ? l : l?.name ?? "").filter(Boolean);
}
function limited(status, data) {
  if (status === 429) return true;
  return status === 403 && /rate limit/i.test(JSON.stringify(data ?? ""));
}
function mapGithubIssues(raw, kind) {
  return (raw ?? []).filter((it) => !!it && typeof it === "object").map((it) => ({
    kind,
    number: typeof it.number === "number" ? it.number : void 0,
    title: String(it.title ?? "").trim(),
    url: String(it.html_url ?? ""),
    state: it.draft ? "draft" : String(it.state ?? ""),
    labels: labelsOf(it.labels),
    body: clip(it.body),
    updatedAt: it.updated_at ? String(it.updated_at) : void 0,
    score: typeof it.score === "number" ? it.score : void 0
  }));
}
var canonCache = /* @__PURE__ */ new Map();
function resetCanonicalRepoCache() {
  canonCache.clear();
}
function ghUsable(host) {
  return /(^|\.)github\.com$/i.test(host) && !envFlag("NO_GH") && have("gh");
}
function splitSlug(full, fallback) {
  const i = full.indexOf("/");
  return i > 0 ? { owner: full.slice(0, i), repo: full.slice(i + 1) } : fallback;
}
function canonicalRepoRef(ref, opts = {}) {
  const fallback = { owner: ref.owner ?? "", repo: ref.repo ?? "" };
  if (!ref.owner || !ref.repo || forgeKind(ref.host) !== "github") return Promise.resolve(fallback);
  const key = `${ref.host}/${ref.owner}/${ref.repo}`;
  let hit = canonCache.get(key);
  if (!hit) {
    hit = (async () => {
      if (ghUsable(ref.host)) {
        const r2 = await shAsync("gh", ["api", `repos/${ref.owner}/${ref.repo}`, "--jq", ".full_name"], { timeoutMs: opts.timeoutMs ?? 15e3 });
        if (r2.ok && r2.stdout.includes("/")) return splitSlug(r2.stdout.trim(), fallback);
      }
      const r = await httpJson("GET", `${apiBase(ref, opts)}/repos/${ref.owner}/${ref.repo}`, void 0, reqOpts("github", opts));
      const full = r.ok ? r.data?.full_name : void 0;
      return typeof full === "string" && full.includes("/") ? splitSlug(full, fallback) : fallback;
    })();
    canonCache.set(key, hit);
  }
  return hit;
}
async function canonicalRepo(ref, opts = {}) {
  if (!ref.owner || !ref.repo) return void 0;
  const { owner, repo } = await canonicalRepoRef(ref, opts);
  return `${owner}/${repo}`;
}
async function searchIssues(ref, terms, kind, opts = {}) {
  const forge = forgeKind(ref.host);
  if (!forge) return { items: [], note: `${ref.host} is not a forge this engine knows how to query.` };
  if (!ref.owner || !ref.repo) return { items: [], note: `"${ref.raw}" does not name owner/repo.` };
  const limit = Math.max(1, opts.limit ?? 10);
  const q = terms.filter(Boolean).join(" ");
  if (forge === "github") {
    const slug = await canonicalRepo(ref, opts) ?? `${ref.owner}/${ref.repo}`;
    const filter = kind === "pr" ? "is:pr" : "is:issue";
    const url2 = `${apiBase(ref, opts)}/search/issues?q=${encodeURIComponent(`repo:${slug} ${filter} ${q}`)}&per_page=${limit}&sort=updated&order=desc`;
    const r2 = await httpJson("GET", url2, void 0, reqOpts(forge, opts));
    if (limited(r2.status, r2.data))
      return { items: [], rateLimited: true, note: "GitHub rate-limited this search \u2014 set GITHUB_TOKEN to raise the anonymous quota." };
    if (!r2.ok) return { items: [], note: `GitHub search failed (status ${r2.status}).` };
    return { items: mapGithubIssues(r2.data?.items ?? [], kind) };
  }
  if (forge === "gitlab") {
    const project = encodeURIComponent(`${ref.owner}/${ref.repo}`);
    const path2 = kind === "pr" ? "merge_requests" : "issues";
    const url2 = `${apiBase(ref, opts)}/projects/${project}/${path2}?search=${encodeURIComponent(q)}&per_page=${limit}&order_by=updated_at`;
    const r2 = await httpJson("GET", url2, void 0, reqOpts(forge, opts));
    if (limited(r2.status, r2.data)) return { items: [], rateLimited: true, note: "GitLab rate-limited this search." };
    if (!r2.ok) return { items: [], note: `GitLab request failed (status ${r2.status}).` };
    const items2 = (Array.isArray(r2.data) ? r2.data : []).map((it) => ({
      kind,
      number: typeof it.iid === "number" ? it.iid : void 0,
      title: String(it.title ?? "").trim(),
      url: String(it.web_url ?? ""),
      state: String(it.state ?? ""),
      labels: labelsOf(it.labels),
      body: clip(it.description),
      updatedAt: it.updated_at ? String(it.updated_at) : void 0
    }));
    return { items: items2 };
  }
  const path = kind === "pr" ? "pulls" : "issues";
  const url = `${apiBase(ref, opts)}/repos/${ref.owner}/${ref.repo}/${path}?state=all&limit=${limit}&q=${encodeURIComponent(q)}`;
  const r = await httpJson("GET", url, void 0, reqOpts(forge, opts));
  if (limited(r.status, r.data)) return { items: [], rateLimited: true, note: "Gitea rate-limited this request." };
  if (!r.ok) return { items: [], note: `Gitea request failed (status ${r.status}).` };
  const items = (Array.isArray(r.data) ? r.data : []).map((it) => ({
    kind,
    number: typeof it.number === "number" ? it.number : void 0,
    title: String(it.title ?? "").trim(),
    url: String(it.html_url ?? ""),
    state: String(it.state ?? ""),
    labels: labelsOf(it.labels),
    body: clip(it.body),
    updatedAt: it.updated_at ? String(it.updated_at) : void 0
  }));
  return { items };
}
async function listReleases(ref, opts = {}) {
  const forge = forgeKind(ref.host);
  if (!forge || !ref.owner || !ref.repo) return { items: [], note: `Cannot list releases for "${ref.raw}".` };
  const limit = Math.max(1, opts.limit ?? 20);
  const url = forge === "gitlab" ? `${apiBase(ref, opts)}/projects/${encodeURIComponent(`${ref.owner}/${ref.repo}`)}/releases?per_page=${limit}` : `${apiBase(ref, opts)}/repos/${ref.owner}/${ref.repo}/releases?per_page=${limit}&limit=${limit}`;
  const r = await httpJson("GET", url, void 0, reqOpts(forge, opts));
  if (limited(r.status, r.data)) return { items: [], rateLimited: true, note: `${forge} rate-limited the release list.` };
  if (!r.ok) return { items: [], note: `Could not list releases (status ${r.status}).` };
  const items = (Array.isArray(r.data) ? r.data : []).map((it) => ({
    kind: "release",
    title: String(it.name ?? it.tag_name ?? it.tag ?? "").trim() || String(it.tag_name ?? ""),
    url: String(it.html_url ?? it._links ?? it.web_url ?? ref.webUrl ?? ""),
    state: it.prerelease ? "prerelease" : "released",
    labels: [],
    body: clip(it.body ?? it.description),
    updatedAt: String(it.published_at ?? it.released_at ?? it.created_at ?? "") || void 0
  }));
  return { items };
}
async function listTags(ref, opts = {}) {
  const forge = forgeKind(ref.host);
  if (!forge || !ref.owner || !ref.repo) return { items: [], note: `Cannot list tags for "${ref.raw}".` };
  const limit = Math.max(1, opts.limit ?? 50);
  const url = forge === "gitlab" ? `${apiBase(ref, opts)}/projects/${encodeURIComponent(`${ref.owner}/${ref.repo}`)}/repository/tags?per_page=${limit}` : `${apiBase(ref, opts)}/repos/${ref.owner}/${ref.repo}/tags?per_page=${limit}&limit=${limit}`;
  const r = await httpJson("GET", url, void 0, reqOpts(forge, opts));
  if (limited(r.status, r.data)) return { items: [], rateLimited: true, note: `${forge} rate-limited the tag list.` };
  if (!r.ok) return { items: [], note: `Could not list tags (status ${r.status}).` };
  const items = (Array.isArray(r.data) ? r.data : []).map((it) => ({
    kind: "tag",
    title: String(it.name ?? "").trim(),
    url: ref.webUrl ? `${ref.webUrl}/releases/tag/${String(it.name ?? "")}` : "",
    labels: [],
    body: ""
  }));
  return { items };
}
async function repoFacts(ref, opts = {}) {
  const forge = forgeKind(ref.host);
  if (!forge || !ref.owner || !ref.repo) return void 0;
  const url = forge === "gitlab" ? `${apiBase(ref, opts)}/projects/${encodeURIComponent(`${ref.owner}/${ref.repo}`)}` : `${apiBase(ref, opts)}/repos/${ref.owner}/${ref.repo}`;
  const r = await httpJson("GET", url, void 0, reqOpts(forge, opts));
  if (!r.ok || !r.data || typeof r.data !== "object") return void 0;
  const d = r.data;
  return {
    fullName: d.full_name ?? d.path_with_namespace,
    description: d.description ?? void 0,
    homepage: d.homepage ?? d.web_url ?? void 0,
    license: d.license?.spdx_id ?? d.license?.name ?? void 0,
    stars: d.stargazers_count ?? d.star_count,
    forks: d.forks_count,
    openIssues: d.open_issues_count,
    defaultBranch: d.default_branch,
    pushedAt: d.pushed_at ?? d.last_activity_at,
    archived: d.archived,
    topics: Array.isArray(d.topics) ? d.topics : Array.isArray(d.tag_list) ? d.tag_list : []
  };
}

// src/registry.ts
var REGISTRY_URL = {
  npm: (n) => `https://registry.npmjs.org/${encodeURIComponent(n).replace(/^%40/, "@")}`,
  pypi: (n) => `https://pypi.org/pypi/${encodeURIComponent(n)}/json`,
  crates: (n) => `https://crates.io/api/v1/crates/${encodeURIComponent(n)}`
};
function normalizeRepoUrl(raw) {
  const s = typeof raw === "string" ? raw.trim() : typeof raw?.url === "string" ? String(raw.url).trim() : "";
  if (!s) return void 0;
  let out = s.replace(/^git\+/, "").replace(/^git:\/\//, "https://").replace(/^ssh:\/\/git@/, "https://").replace(/^git@([^:]+):/, "https://$1/").replace(/\.git$/, "");
  if (/^[\w.-]+\/[\w.-]+$/.test(out)) out = `https://github.com/${out}`;
  return /^https?:\/\//i.test(out) ? out : void 0;
}
function reqOpts2() {
  return { timeoutMs: 12e3, userAgent: contactUa(), accept: "application/json" };
}
async function lookupPackage(registry, name, version) {
  const n = name.trim();
  if (!n) return void 0;
  const r = await httpJson("GET", REGISTRY_URL[registry](n), void 0, reqOpts2());
  if (!r.ok || !r.data || typeof r.data !== "object") return void 0;
  const d = r.data;
  if (registry === "npm") {
    const latest = version ?? d["dist-tags"]?.latest;
    const v = latest && d.versions?.[latest] || {};
    const deprecated = typeof v.deprecated === "string" ? v.deprecated : v.deprecated === true ? "deprecated" : void 0;
    return {
      registry,
      name: d.name ?? n,
      version: latest,
      description: v.description ?? d.description,
      homepage: v.homepage ?? d.homepage,
      repository: normalizeRepoUrl(v.repository ?? d.repository),
      documentation: typeof v.documentation === "string" ? v.documentation : void 0,
      license: typeof v.license === "string" ? v.license : v.license?.type,
      ...deprecated ? { deprecated } : {},
      publishedAt: latest ? d.time?.[latest] : void 0
    };
  }
  if (registry === "pypi") {
    const info = d.info ?? {};
    const urls = info.project_urls ?? {};
    const yanked = Array.isArray(d.urls) && d.urls.length ? d.urls.every((u) => u.yanked) : false;
    return {
      registry,
      name: info.name ?? n,
      version: info.version,
      description: info.summary,
      homepage: info.home_page || urls.Homepage || urls.homepage,
      repository: normalizeRepoUrl(urls.Source ?? urls.Repository ?? urls["Source Code"] ?? urls.Code ?? info.home_page),
      documentation: info.docs_url || urls.Documentation || urls.documentation,
      license: info.license || void 0,
      ...yanked ? { deprecated: "every file for this release is yanked" } : {}
    };
  }
  const c = d.crate ?? {};
  return {
    registry,
    name: c.name ?? n,
    version: version ?? c.max_stable_version ?? c.newest_version,
    description: c.description,
    homepage: c.homepage,
    repository: normalizeRepoUrl(c.repository),
    documentation: c.documentation,
    downloads: typeof c.downloads === "number" ? c.downloads : void 0,
    publishedAt: c.updated_at
  };
}
async function resolvePackage(name, opts = {}) {
  const order = opts.registry ? [opts.registry] : ["npm", "pypi", "crates"];
  for (const r of order) {
    const found = await lookupPackage(r, name, opts.version);
    if (found) return found;
  }
  return void 0;
}

// src/robots.ts
var EMPTY = { rules: [], sitemaps: [], absent: true };
function parseRobots(body, userAgent) {
  const ua = userAgent.toLowerCase();
  const groups = /* @__PURE__ */ new Map();
  const delays = /* @__PURE__ */ new Map();
  const sitemaps = [];
  let current2 = [];
  let inHeader = false;
  for (const raw of body.split(/\r?\n/)) {
    const line = raw.replace(/#.*$/, "").trim();
    if (!line) continue;
    const sep2 = line.indexOf(":");
    if (sep2 === -1) continue;
    const field = line.slice(0, sep2).trim().toLowerCase();
    const value = line.slice(sep2 + 1).trim();
    if (field === "sitemap") {
      if (value) sitemaps.push(value);
      continue;
    }
    if (field === "user-agent") {
      if (!inHeader) current2 = [];
      current2.push(value.toLowerCase());
      inHeader = true;
      for (const g of current2) if (!groups.has(g)) groups.set(g, []);
      continue;
    }
    inHeader = false;
    if (!current2.length) continue;
    if (field === "allow" || field === "disallow") {
      for (const g of current2) groups.get(g).push({ allow: field === "allow", path: value });
    } else if (field === "crawl-delay") {
      const n = Number(value);
      if (Number.isFinite(n) && n >= 0) for (const g of current2) delays.set(g, n * 1e3);
    }
  }
  let chosen;
  for (const g of groups.keys()) {
    if (g === "*") continue;
    if (ua.includes(g) && (!chosen || g.length > chosen.length)) chosen = g;
  }
  chosen ??= groups.has("*") ? "*" : void 0;
  if (chosen === void 0) return { rules: [], sitemaps, absent: false };
  const rules = [...groups.get(chosen)].sort((a, b) => b.path.length - a.path.length || (a.allow === b.allow ? 0 : a.allow ? -1 : 1));
  const crawlDelayMs = delays.get(chosen);
  return { rules, sitemaps, absent: false, ...crawlDelayMs !== void 0 ? { crawlDelayMs } : {} };
}
function ruleMatches(pattern, path) {
  if (pattern === "") return false;
  const anchored = pattern.endsWith("$");
  const body = anchored ? pattern.slice(0, -1) : pattern;
  if (!body.includes("*")) return anchored ? path === body : path.startsWith(body);
  const re = new RegExp(`^${body.split("*").map(escapeRe).join(".*")}${anchored ? "$" : ""}`);
  return re.test(path);
}
function escapeRe(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
function isAllowed(robots, url) {
  if (robots.absent || !robots.rules.length) return true;
  let path;
  try {
    const u = new URL(url);
    path = u.pathname + u.search;
  } catch {
    return true;
  }
  for (const rule of robots.rules) if (ruleMatches(rule.path, path)) return rule.allow;
  return true;
}
var cache = /* @__PURE__ */ new Map();
function resetRobotsCache() {
  cache.clear();
}
async function fetchRobots(url) {
  if (envFlag("NO_ROBOTS")) return EMPTY;
  let origin;
  try {
    origin = new URL(url).origin;
  } catch {
    return EMPTY;
  }
  let p = cache.get(origin);
  if (!p) {
    p = (async () => {
      const r = await httpGet(`${origin}/robots.txt`, { accept: "text/plain", timeoutMs: 5e3, maxBytes: 512 * 1024 });
      if (!r.ok || !r.body.trim()) return EMPTY;
      return parseRobots(r.body, env("ROBOTS_UA") ?? brand().name);
    })();
    cache.set(origin, p);
  }
  return p;
}

// src/structured.ts
var META_TAG = /<meta\b[^>]*>/gi;
var ATTR = (tag, name) => {
  const re = new RegExp(`\\b${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s>]+))`, "i");
  const m = re.exec(tag);
  const v = m?.[1] ?? m?.[2] ?? m?.[3];
  return v ? decodeEntities(v).trim() : void 0;
};
function extractJsonLd(html) {
  const out = [];
  const re = /<script\b[^>]*type\s*=\s*["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi;
  let m;
  while (m = re.exec(html)) {
    const raw = m[1].replace(/^\s*<!--/, "").replace(/-->\s*$/, "").trim();
    if (!raw) continue;
    try {
      const parsed = JSON.parse(raw);
      if (parsed && typeof parsed === "object" && Array.isArray(parsed["@graph"])) {
        out.push(...parsed["@graph"]);
      } else if (Array.isArray(parsed)) {
        out.push(...parsed);
      } else {
        out.push(parsed);
      }
    } catch {
    }
  }
  return out;
}
function extractMetaTags(html) {
  const out = /* @__PURE__ */ new Map();
  META_TAG.lastIndex = 0;
  for (const m of html.matchAll(META_TAG)) {
    const tag = m[0];
    const key = (ATTR(tag, "property") ?? ATTR(tag, "name") ?? ATTR(tag, "itemprop"))?.toLowerCase();
    const content = ATTR(tag, "content");
    if (key && content && !out.has(key)) out.set(key, content);
  }
  return out;
}
function firstString(v) {
  if (typeof v === "string") return v.trim() || void 0;
  if (Array.isArray(v)) {
    for (const x of v) {
      const s = firstString(x);
      if (s) return s;
    }
    return void 0;
  }
  if (v && typeof v === "object") return firstString(v.name);
  return void 0;
}
function allStrings(v) {
  if (typeof v === "string") return v.trim() ? [v.trim()] : [];
  if (Array.isArray(v)) return v.flatMap(allStrings);
  if (v && typeof v === "object") return allStrings(v.name);
  return [];
}
function pageMetadata(html) {
  const meta = extractMetaTags(html);
  const jsonLd = extractJsonLd(html);
  const out = { authors: [], jsonLd };
  const set = (k, v) => {
    if (v !== void 0 && out[k] === void 0) out[k] = v;
  };
  for (const node of jsonLd) {
    if (!node || typeof node !== "object") continue;
    const n = node;
    set("type", firstString(n["@type"]));
    set("title", firstString(n.headline) ?? firstString(n.name));
    set("description", firstString(n.description));
    set("publishedAt", firstString(n.datePublished));
    set("modifiedAt", firstString(n.dateModified));
    set("canonicalUrl", firstString(n.url) ?? firstString(n["@id"]));
    set("imageUrl", firstString(n.image));
    set("siteName", firstString(n.publisher));
    for (const a of allStrings(n.author)) if (!out.authors.includes(a)) out.authors.push(a);
  }
  set("title", meta.get("og:title") ?? meta.get("twitter:title"));
  set("description", meta.get("og:description") ?? meta.get("description") ?? meta.get("twitter:description"));
  set("type", meta.get("og:type"));
  set("siteName", meta.get("og:site_name"));
  set("publishedAt", meta.get("article:published_time") ?? meta.get("datepublished") ?? meta.get("citation_publication_date"));
  set("modifiedAt", meta.get("article:modified_time") ?? meta.get("datemodified"));
  set("imageUrl", meta.get("og:image") ?? meta.get("twitter:image"));
  set("canonicalUrl", meta.get("og:url"));
  for (const key of ["article:author", "author", "citation_author", "dc.creator"]) {
    const v = meta.get(key);
    if (v && !out.authors.includes(v)) out.authors.push(v);
  }
  if (out.title === void 0) {
    const t = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(html)?.[1];
    if (t) out.title = decodeEntities(t).replace(/\s+/g, " ").trim() || void 0;
  }
  return out;
}

// src/feed.ts
function tagText(block, ...names) {
  for (const name of names) {
    const m = new RegExp(`<${name}\\b[^>]*>([\\s\\S]*?)<\\/${name}>`, "i").exec(block);
    if (!m) continue;
    const raw = m[1];
    const inner = /<!\[CDATA\[([\s\S]*?)\]\]>/.exec(raw)?.[1] ?? raw;
    const text = decodeEntities(inner.replace(/<[^>]+>/g, " ")).replace(/\s+/g, " ").trim();
    if (text) return text;
  }
  return void 0;
}
function itemUrl(block) {
  const link = /<link\b[^>]*\bhref\s*=\s*["']([^"']+)["'][^>]*>/i.exec(block);
  if (link) {
    const alts = [...block.matchAll(/<link\b([^>]*)>/gi)].map((m) => m[1]).filter((attrs) => !/\brel\s*=\s*["'](?:self|edit|replies|enclosure)["']/i.test(attrs));
    for (const attrs of alts) {
      const href = /\bhref\s*=\s*["']([^"']+)["']/i.exec(attrs)?.[1];
      if (href) return decodeEntities(href).trim();
    }
    return decodeEntities(link[1]).trim();
  }
  return tagText(block, "link", "guid");
}
function parseFeed(xml) {
  const isAtom = /<feed\b[^>]*xmlns\s*=\s*["'][^"']*www\.w3\.org\/2005\/Atom/i.test(xml) || /<entry\b/i.test(xml);
  const isRss = /<rss\b/i.test(xml) || /<channel\b/i.test(xml);
  if (!isAtom && !isRss) return void 0;
  const kind = isAtom && !isRss ? "atom" : "rss";
  const itemRe = kind === "atom" ? /<entry\b[\s\S]*?<\/entry>/gi : /<item\b[\s\S]*?<\/item>/gi;
  const items = [];
  for (const m of xml.matchAll(itemRe)) {
    const block = m[0];
    const it = {};
    const title2 = tagText(block, "title");
    if (title2) it.title = title2;
    const url = itemUrl(block);
    if (url) it.url = url;
    const published = tagText(block, "pubDate", "published", "updated", "dc:date");
    if (published) it.published = published;
    const summary = tagText(block, "description", "summary");
    if (summary) it.summary = summary;
    const id = tagText(block, "guid", "id");
    if (id) it.id = id;
    if (it.title || it.url) items.push(it);
  }
  const head = xml.replace(itemRe, "");
  const title = tagText(head, "title");
  return { kind, items, ...title ? { title } : {} };
}
function discoverFeeds(html, baseUrl) {
  const out = [];
  for (const m of html.matchAll(/<link\b([^>]*)>/gi)) {
    const attrs = m[1];
    if (!/\brel\s*=\s*["']?alternate\b/i.test(attrs)) continue;
    if (!/\btype\s*=\s*["'](?:application\/(?:rss|atom)\+xml|application\/feed\+json)["']/i.test(attrs)) continue;
    const href = /\bhref\s*=\s*["']([^"']+)["']/i.exec(attrs)?.[1];
    if (!href) continue;
    try {
      const abs = new URL(decodeEntities(href).trim(), baseUrl).href;
      if (!out.includes(abs)) out.push(abs);
    } catch {
    }
  }
  return out;
}
function parseSitemap(xml) {
  const out = { urls: [], sitemaps: [] };
  const isIndex = /<sitemapindex\b/i.test(xml);
  for (const m of xml.matchAll(/<(sitemap|url)\b[\s\S]*?<\/\1>/gi)) {
    const block = m[0];
    const loc = tagText(block, "loc");
    if (!loc) continue;
    if (isIndex || m[1].toLowerCase() === "sitemap") {
      out.sitemaps.push(loc);
    } else {
      const lastmod = tagText(block, "lastmod");
      out.urls.push({ loc, ...lastmod ? { lastmod } : {} });
    }
  }
  return out;
}
async function fetchSitemap(url, opts = {}) {
  const out = { urls: [], sitemaps: [] };
  let origin;
  try {
    origin = new URL(url).origin;
  } catch {
    return out;
  }
  const queue = [...opts.sitemaps ?? [], `${origin}/sitemap.xml`];
  const seen = /* @__PURE__ */ new Set();
  let fetched = 0;
  const max = Math.max(1, opts.max ?? 3);
  while (queue.length && fetched < max) {
    const next = queue.shift();
    if (seen.has(next)) continue;
    seen.add(next);
    const r = await httpGet(next, { accept: "application/xml,text/xml,*/*", timeoutMs: 1e4 });
    fetched++;
    if (!r.ok || !r.body.trim()) continue;
    const parsed = parseSitemap(r.body);
    out.urls.push(...parsed.urls);
    for (const s of parsed.sitemaps) {
      if (!out.sitemaps.includes(s)) out.sitemaps.push(s);
      queue.push(s);
    }
  }
  return out;
}
async function fetchFeed(url) {
  const r = await httpGet(url, { accept: "application/atom+xml,application/rss+xml,application/xml,*/*", timeoutMs: 1e4 });
  if (!r.ok || !r.body.trim()) return void 0;
  return parseFeed(r.body);
}

// src/engines.ts
var KEYLESS_ENGINES = ["ddg", "ddglite", "mojeek"];
function isKeylessEngine(v) {
  return KEYLESS_ENGINES.includes(v);
}
function keylessEngines(opts = {}) {
  if (opts.engines) return opts.engines;
  const raw = env("ENGINES");
  if (raw === void 0) return KEYLESS_ENGINES;
  if (raw.toLowerCase() === "off") return [];
  return raw.split(",").map((s) => s.trim().toLowerCase()).filter(isKeylessEngine);
}
function stripTags(s) {
  return decodeEntities(s.replace(/<[^>]+>/g, " ")).replace(/\s+/g, " ").trim();
}
function ddgRedirectTarget(href) {
  const uddg = /[?&]uddg=([^&]+)/.exec(href);
  if (uddg) {
    try {
      return decodeURIComponent(uddg[1]);
    } catch {
    }
  }
  return href.startsWith("//") ? `https:${href}` : href;
}
function throttleReason(status) {
  if (status === 429 || status === 503) return { throttled: true, why: `rate-limited (HTTP ${status})` };
  return { throttled: false, why: `unreachable (status ${status})` };
}
function parseBlocks(body, limit, blockRe, snippetRe, reject, resolveHref) {
  const found = [];
  let m;
  blockRe.lastIndex = 0;
  while ((m = blockRe.exec(body)) && found.length < limit) {
    const href0 = /\bhref="([^"]+)"/.exec(m[1]);
    if (!href0) continue;
    const href = resolveHref(href0[1]);
    if (!/^https?:\/\//.test(href) || reject.test(href)) continue;
    const snip = snippetRe.exec(m[3]);
    snippetRe.lastIndex = 0;
    found.push({ url: href, title: stripTags(m[2]) || href, snippet: snip ? stripTags(snip[1]) : "" });
  }
  return found;
}
function parseDdgHtml(body, limit = 50) {
  return parseBlocks(
    body,
    limit,
    /<a\b([^>]*\bresult__a\b[^>]*)>([\s\S]*?)<\/a>([\s\S]*?)(?=<a\b[^>]*\bresult__a\b|$)/gi,
    /class="result__snippet"[^>]*>([\s\S]*?)<\/a>/i,
    /duckduckgo\.com/,
    ddgRedirectTarget
  );
}
function parseDdgLite(body, limit = 50) {
  return parseBlocks(
    body,
    limit,
    /<a\b([^>]*\bresult-link\b[^>]*)>([\s\S]*?)<\/a>([\s\S]*?)(?=<a\b[^>]*\bresult-link\b|$)/gi,
    /class="result-snippet"[^>]*>([\s\S]*?)<\/td>/i,
    /duckduckgo\.com/,
    ddgRedirectTarget
  );
}
function parseMojeek(body, limit = 50) {
  return parseBlocks(
    body,
    limit,
    /<a\b([^>]*\bclass="[^"]*\btitle\b[^"]*"[^>]*)>([\s\S]*?)<\/a>([\s\S]*?)(?=<a\b[^>]*\bclass="[^"]*\btitle\b|$)/gi,
    /<p\b[^>]*\bclass="[^"]*\bs\b[^"]*"[^>]*>([\s\S]*?)<\/p>/i,
    /mojeek\.com/,
    (h) => h.startsWith("//") ? `https:${h}` : h
  );
}
var SPECS = {
  // `s` is a 0-based result offset, ~30 per page.
  ddg: {
    label: "DuckDuckGo",
    url: (q, p, kl) => `https://html.duckduckgo.com/html/?q=${encodeURIComponent(q)}&kl=${encodeURIComponent(kl)}${p > 0 ? `&s=${p * 30}` : ""}`,
    parse: parseDdgHtml
  },
  ddglite: {
    label: "DuckDuckGo Lite",
    url: (q, p, kl) => `https://lite.duckduckgo.com/lite/?q=${encodeURIComponent(q)}&kl=${encodeURIComponent(kl)}${p > 0 ? `&s=${p * 30}` : ""}`,
    parse: parseDdgLite
  },
  // Mojeek's `s` is the 1-BASED index of the first result, 10 per page — so
  // page 2 starts at 11, not 10. Its own crawler and index, which is why it is
  // worth asking at all: it surfaces pages the DDG family does not have.
  mojeek: {
    label: "Mojeek",
    url: (q, p) => `https://www.mojeek.com/search?q=${encodeURIComponent(q)}${p > 0 ? `&s=${p * 10 + 1}` : ""}`,
    parse: parseMojeek
  }
};
async function searchViaKeyless(engine, query, opts = {}) {
  const spec = SPECS[engine];
  const q = query.trim();
  if (!q) return { hits: [], note: "Empty query." };
  const pages = Math.max(1, opts.pages ?? 1);
  const limit = Math.max(1, opts.limit ?? 10);
  const kl = ddgRegion(opts.lang, opts.region);
  const acceptLanguage = acceptLanguageHeader(opts.lang, opts.region);
  const seen = /* @__PURE__ */ new Set();
  const hits = [];
  for (let p = 0; p < pages && hits.length < limit; p++) {
    const r = await httpGet(spec.url(q, p, kl), { accept: "text/html", acceptLanguage, timeoutMs: opts.timeoutMs ?? 12e3 });
    if (!r.ok || !r.body) {
      if (p > 0) break;
      const { throttled, why } = throttleReason(r.status);
      return { hits: [], note: `${spec.label} ${why}.`, throttled };
    }
    const before = hits.length;
    for (const f of spec.parse(r.body, limit * 2)) {
      const key = canonicalizeUrl(f.url);
      if (seen.has(key)) continue;
      seen.add(key);
      hits.push(f);
      if (hits.length >= limit) break;
    }
    if (hits.length === before) break;
    if (p < pages - 1 && pageDelayMs()) await sleep(pageDelayMs());
  }
  return hits.length ? { hits } : { hits: [], note: `${spec.label} returned no results.` };
}

// src/search.ts
var SEARXNG_DEFAULT_BASE = "http://localhost:8888";
var PROBE_TIMEOUT_MS2 = 2e3;
var QUERY_TIMEOUT_MS = 8e3;
function searxngBase(opts = {}) {
  const raw = (opts.searxng ?? env("SEARXNG") ?? SEARXNG_DEFAULT_BASE).trim();
  if (!raw || raw.toLowerCase() === "off") return null;
  return raw.replace(/\/+$/, "");
}
function searxngIsExplicit(opts = {}) {
  return !!(opts.searxng ?? env("SEARXNG"));
}
var probeCache2 = /* @__PURE__ */ new Map();
function resetSearxngProbeCache() {
  probeCache2.clear();
}
function probeSearxng(base) {
  let p = probeCache2.get(base);
  if (!p) {
    p = (async () => {
      const ctrl = new AbortController();
      const t = setTimeout(() => ctrl.abort(), PROBE_TIMEOUT_MS2);
      try {
        const res = await fetch(`${base}/healthz`, { signal: ctrl.signal });
        await res.text().catch(() => "");
        return true;
      } catch {
        return false;
      } finally {
        clearTimeout(t);
      }
    })();
    probeCache2.set(base, p);
  }
  return p;
}
async function searchViaSearxng(query, opts = {}) {
  const base = searxngBase(opts);
  if (!base) return { hits: [], notes: [`SearXNG disabled (${envName("SEARXNG")}=off).`] };
  if (!await probeSearxng(base)) {
    return {
      hits: [],
      notes: [
        searxngIsExplicit(opts) ? `SearXNG not reachable at ${base}.` : `SearXNG not running at ${base} \u2014 start it with \`${brand().cli} searxng up\` for local, keyless discovery.`
      ]
    };
  }
  const pages = Math.max(1, opts.pages ?? 1);
  const limit = Math.max(1, opts.limit ?? 10);
  const acceptLanguage = acceptLanguageHeader(opts.lang, opts.region);
  const root = `${base}/search?q=${encodeURIComponent(query)}&format=json&safesearch=1` + (opts.lang ? `&language=${encodeURIComponent(opts.lang)}` : "");
  const notes = [];
  const seen = /* @__PURE__ */ new Set();
  const hits = [];
  const suspended = /* @__PURE__ */ new Map();
  for (let p = 0; p < pages && hits.length < limit; p++) {
    const r = await httpGet(root + (p > 0 ? `&pageno=${p + 1}` : ""), { accept: "application/json", acceptLanguage, timeoutMs: QUERY_TIMEOUT_MS });
    if (!r.ok) {
      if (p === 0) notes.push(r.status === 429 || r.status === 503 ? `SearXNG rate-limited (HTTP ${r.status}).` : `SearXNG unreachable (status ${r.status}).`);
      break;
    }
    let data;
    try {
      data = JSON.parse(r.body);
    } catch {
      if (p === 0) notes.push("SearXNG returned a non-JSON body \u2014 is `format: json` enabled on that instance?");
      break;
    }
    for (const e of data.unresponsive_engines ?? []) {
      const pair = Array.isArray(e) ? e : [];
      if (typeof pair[0] === "string") suspended.set(pair[0], typeof pair[1] === "string" ? pair[1] : "unavailable");
    }
    const before = hits.length;
    for (const raw of data.results ?? []) {
      const it = raw;
      if (typeof it.url !== "string") continue;
      const key = canonicalizeUrl(it.url);
      if (seen.has(key)) continue;
      seen.add(key);
      hits.push({
        url: it.url,
        title: typeof it.title === "string" && it.title.trim() ? it.title.trim() : it.url,
        snippet: typeof it.content === "string" ? it.content.trim() : "",
        via: "searxng"
      });
      if (hits.length >= limit) break;
    }
    if (hits.length === before) break;
    if (p < pages - 1 && pageDelayMs()) await sleep(pageDelayMs());
  }
  if (suspended.size) {
    notes.push(`SearXNG upstreams throttled: ${[...suspended].map(([e, why]) => `${e} (${why})`).join(", ")} \u2014 fewer results than usual, not an empty web.`);
  }
  if (!hits.length && !notes.length) notes.push("SearXNG returned no results.");
  return { hits, notes };
}
async function search(query, opts = {}) {
  const q = query.trim();
  if (!q) return { hits: [], notes: ["Empty query."] };
  const viaSearxng = await searchViaSearxng(q, opts);
  if (viaSearxng.hits.length) return viaSearxng;
  const notes = [...viaSearxng.notes];
  for (const engine of keylessEngines(opts)) {
    const r = await searchViaKeyless(engine, q, { limit: opts.limit, pages: opts.pages, lang: opts.lang, region: opts.region });
    if (r.hits.length) {
      return { hits: r.hits.map((h) => ({ ...h, via: engine })), notes };
    }
    if (r.throttled && r.note) notes.push(r.note);
  }
  const fc = await searchViaFirecrawl(q, opts.limit ?? 10, opts);
  const hits = (fc.hits ?? []).map((h) => ({ url: h.url, title: h.title, snippet: h.description, via: "firecrawl" }));
  if (fc.why) notes.push(fc.why);
  if (!hits.length) notes.push(`No results from any engine. \`${brand().cli} stack up\` starts SearXNG and Firecrawl locally.`);
  return { hits, notes };
}

// src/stack.ts
import { spawnSync as spawnSync2 } from "child_process";
import { existsSync as existsSync3, mkdirSync as mkdirSync2, readFileSync as readFileSync2, writeFileSync as writeFileSync2 } from "fs";
import { tmpdir as tmpdir3 } from "os";
import { dirname, join as join3 } from "path";
var COMPOSE_YAML = `# Optional, fully-local, no-API-key stack for a semantic mode, web
# search and content extraction. Start it with \`{{CLI}} semantic up\` (or
# \`docker compose --profile all up -d\`). The published bundle stays
# dependency-free \u2014 it only speaks HTTP to these containers on localhost;
# nothing here is required for Tier-1 retrieval.
#
# Profiles let you start subsets:
#   --profile semantic  \u2192 qdrant + ollama (vector search)
#   --profile search    \u2192 searxng (web discovery)
#   --profile all       \u2192 everything above
#   --profile extract   \u2192 firecrawl (content cleaning; \`{{CLI}} firecrawl up\`)
# \u2500\u2500 One stack, however many tools use it \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500
# Any tool needing SearXNG or Firecrawl binds the SAME host ports. Run two from
# separate compose projects and only one can ever be up: the second fails with
# "port is already allocated", after leaving its sidecars running.
#
# So this file uses one fixed project name, one set of container names and one
# set of volumes. A second tool bringing the stack up is a no-op against the
# containers already running, and the whole thing costs one machine's worth of
# RAM rather than one per tool.
#
# WARNING: any tool shipping its own copy of these service blocks must keep them
# byte-identical. Docker compares the RESOLVED config, so a divergence makes an
# up from one recreate the other's running containers.

name: skills

services:
  # Vector database \u2014 Apache-2.0, self-hosted, no key.
  qdrant:
    image: qdrant/qdrant:v1.18.2
    container_name: skills-qdrant
    ports:
      - "6333:6333"
    volumes:
      - qdrant:/qdrant/storage
    restart: unless-stopped
    profiles: ["semantic", "all"]
    healthcheck:
      # The image ships no curl/wget \u2014 probe the REST port over bash's /dev/tcp.
      test: ["CMD-SHELL", "bash -c ':> /dev/tcp/127.0.0.1/6333' || exit 1"]
      interval: 30s
      timeout: 5s
      retries: 3
      start_period: 15s

  # Local embedding server \u2014 no key, no data leaves the machine. Pull the model
  # once: \`docker compose exec ollama ollama pull nomic-embed-text\`
  # (\`{{CLI}} semantic up\` does this for you).
  ollama:
    image: ollama/ollama:0.30.7
    container_name: skills-ollama
    ports:
      - "11434:11434"
    volumes:
      - ollama:/root/.ollama
    restart: unless-stopped
    profiles: ["semantic", "all"]
    healthcheck:
      test: ["CMD", "ollama", "list"]
      interval: 30s
      timeout: 5s
      retries: 3
      start_period: 15s

  # Self-hosted metasearch for keyless web discovery. JSON output is enabled in
  # docker/searxng/settings.yml so the engine can be queried programmatically.
  # Also backs Firecrawl's keyless /search through SEARXNG_ENDPOINT.
  searxng:
    image: searxng/searxng:2026.6.11-a1490676e
    container_name: skills-searxng
    ports:
      - "8888:8080"
    environment:
      - SEARXNG_BASE_URL=http://localhost:8888/
    volumes:
      - ./docker/searxng:/etc/searxng:rw
    restart: unless-stopped
    profiles: ["search", "all"]
    healthcheck:
      # busybox wget is in the image; /healthz answers on the container port.
      test: ["CMD-SHELL", "wget -qO- http://localhost:8080/healthz || exit 1"]
      interval: 30s
      timeout: 5s
      retries: 3
      start_period: 15s

  # Self-hosted Firecrawl \u2014 keyless content cleaning. Fetches a page with a real
  # browser and returns main-content markdown, which beats the built-in regex
  # HTML stripper on nav/cookie chrome and is the only way JS-rendered pages
  # yield any text at all. Keyless because USE_DB_AUTHENTICATION=false; see
  # docker/firecrawl/firecrawl.env for the tunables.
  #
  # Deliberately NOT in the "all" profile: it is ~3 GB of images and 5
  # containers, and \`{{CLI}} semantic up\` must stay cheap.
  #
  #   docker compose --profile search --profile extract up -d --wait
  firecrawl:
    image: ghcr.io/firecrawl/firecrawl:2.10.5@sha256:8ce1af201332e1de046d70d5d516fbfe7f0f6229820d271d880873eeca531ea6
    container_name: skills-firecrawl
    ports:
      - "3002:3002"
    env_file:
      - ./docker/firecrawl/firecrawl.env
    environment:
      # Wiring lives here; tunables live in the env file above.
      - HOST=0.0.0.0
      - PORT=3002
      - ENV=local
      - REDIS_URL=redis://firecrawl-redis:6379
      - REDIS_RATE_LIMIT_URL=redis://firecrawl-redis:6379
      - PLAYWRIGHT_MICROSERVICE_URL=http://firecrawl-playwright:3000/scrape
      - POSTGRES_HOST=firecrawl-postgres
      - NUQ_RABBITMQ_URL=amqp://firecrawl-rabbitmq:5672
      # Keeps /search keyless by delegating to the searxng service above.
      # Unreachable when the \`search\` profile is down \u2014 Firecrawl then falls
      # back to DuckDuckGo on its own.
      - SEARXNG_ENDPOINT=http://searxng:8080
    command: node dist/src/harness.js --start-docker
    depends_on:
      firecrawl-redis:
        condition: service_started
      firecrawl-playwright:
        condition: service_started
      firecrawl-postgres:
        condition: service_started
      firecrawl-rabbitmq:
        condition: service_healthy
    restart: unless-stopped
    profiles: ["extract"]
    # The image ships no curl/wget, but it is a Node image \u2014 probe with node.
    healthcheck:
      test: ["CMD", "node", "-e", "fetch('http://127.0.0.1:3002/').then(r=>process.exit(r.status<500?0:1)).catch(()=>process.exit(1))"]
      interval: 15s
      timeout: 5s
      retries: 10
      start_period: 60s
    # Trimmed for a 16 GB laptop; upstream asks for 4 CPU / 8 GB. Measured at
    # 2.3 GB steady under 5 concurrent scrapes, so 3 GB was too tight a cap \u2014
    # MAX_RAM=0.8 in the env file makes Firecrawl self-throttle at ~3.2 GB.
    cpus: 2.0
    mem_limit: 4g
    memswap_limit: 4g

  # Headless-browser sidecar \u2014 this is what makes JS-rendered pages extractable.
  firecrawl-playwright:
    image: ghcr.io/firecrawl/playwright-service:latest@sha256:8c50add7293201e575110e6c7489fa383a9dfc46f168936526a458e06ffc5c28
    container_name: skills-firecrawl-playwright
    environment:
      - PORT=3000
      - BLOCK_MEDIA=true
      - MAX_CONCURRENT_PAGES=4
    restart: unless-stopped
    profiles: ["extract"]
    cpus: 1.5
    mem_limit: 2g
    memswap_limit: 2g
    tmpfs:
      - /tmp/.cache:noexec,nosuid,size=512m

  firecrawl-redis:
    image: redis:alpine
    container_name: skills-firecrawl-redis
    command: redis-server --bind 0.0.0.0
    restart: unless-stopped
    profiles: ["extract"]

  firecrawl-rabbitmq:
    image: rabbitmq:3-management
    container_name: skills-firecrawl-rabbitmq
    restart: unless-stopped
    profiles: ["extract"]
    healthcheck:
      test: ["CMD", "rabbitmq-diagnostics", "-q", "check_running"]
      interval: 10s
      timeout: 5s
      retries: 5
      start_period: 20s

  firecrawl-postgres:
    image: ghcr.io/firecrawl/nuq-postgres:latest@sha256:aed86f62858f29bd971abddcdeb301c12888098d2cf5d33c1ba42b053bc460f6
    container_name: skills-firecrawl-postgres
    environment:
      - POSTGRES_USER=postgres
      - POSTGRES_PASSWORD=postgres
      - POSTGRES_DB=postgres
    volumes:
      - firecrawl_pg:/var/lib/postgresql/data
    restart: unless-stopped
    profiles: ["extract"]

volumes:
  qdrant:
  ollama:
  firecrawl_pg:
`;
var SEARXNG_SETTINGS_YAML = `# Minimal SearXNG config for keyless, self-hosted web discovery. The important
# bit is enabling the JSON output format so the CLI can query it
# programmatically (\`/search?format=json\`) \u2014 most PUBLIC instances disable it,
# which is why a local one ships here.
#
# The service names and ports below are deliberately stable, so several tools on
# one machine share a single container rather than each starting their own.
use_default_settings: true

server:
  # Override with a real random secret if you expose this beyond localhost.
  secret_key: "searxng-local-dev-change-me"
  # The limiter/bot-detection middleware answers 403 to format=json requests.
  limiter: false
  image_proxy: false

search:
  safe_search: 0
  autocomplete: ""
  formats:
    - html
    - json
`;
var FIRECRAWL_ENV = `# Tunables for the self-hosted Firecrawl stack (docker compose --profile extract).
# Wiring (hostnames, ports, SEARXNG_ENDPOINT) lives in docker-compose.yml and
# overrides anything set here.

# THIS is what makes the API keyless. Turning it on would require a Supabase
# project; there is no reason to for a localhost stack.
USE_DB_AUTHENTICATION=false

# Firecrawl's Rust PDF extractor, which is OFF by default upstream. Without it
# Firecrawl falls back to pdf-parse (JS) for PDFs. Still keyless: this is the
# local Rust path, not the MinerU / Fire PDF routes, which need API credentials.
# Reached as a rung of the PDF ladder when the built-in reader finds no text.
PDF_RUST_EXTRACT_ENABLE=true

# Postgres credentials for the bundled nuq-postgres container. It is not
# published on a host port, so these never leave the compose network.
POSTGRES_USER=postgres
POSTGRES_PASSWORD=postgres
POSTGRES_DB=postgres
POSTGRES_PORT=5432

# Admin queue dashboard at http://localhost:3002/admin/CHANGEME/queues
BULL_AUTH_KEY=CHANGEME

# Concurrency, trimmed for a laptop. Upstream defaults are 8/5/5/10 and assume
# a 4-CPU / 8-GB box; these keep the stack near ~4 GB total.
NUM_WORKERS_PER_QUEUE=2
MAX_CONCURRENT_JOBS=3
BROWSER_POOL_SIZE=2
CRAWL_CONCURRENT_REQUESTS=4

# Back off before the host runs out of headroom.
MAX_CPU=0.8
MAX_RAM=0.8

LOGGING_LEVEL=info
`;
function renderAsset(template) {
  return template.replaceAll("{{CLI}}", brand().cli);
}
function cacheRoot() {
  return env("CACHE_DIR") ?? brand().cacheDir ?? join3(tmpdir3(), brand().name);
}
function ensureComposeMaterialized() {
  const base = join3(cacheRoot(), "compose");
  const composePath = join3(base, "docker-compose.yml");
  const settingsPath = join3(base, "docker", "searxng", "settings.yml");
  const firecrawlEnvPath = join3(base, "docker", "firecrawl", "firecrawl.env");
  writeIfChanged(composePath, renderAsset(COMPOSE_YAML));
  writeIfChanged(settingsPath, renderAsset(SEARXNG_SETTINGS_YAML));
  writeIfChanged(firecrawlEnvPath, renderAsset(FIRECRAWL_ENV));
  return composePath;
}
function writeIfChanged(path, content) {
  try {
    if (existsSync3(path) && readFileSync2(path, "utf8") === content) return;
    mkdirSync2(dirname(path), { recursive: true });
    writeFileSync2(path, content);
  } catch {
  }
}
var DEFAULT_PULL_TIMEOUT_MS = 12e5;
var UP_TIMEOUT_MS = 3e5;
var DOWN_TIMEOUT_MS = 12e4;
var PS_TIMEOUT_MS = 3e4;
var MODEL_PULL_TIMEOUT_MS = 6e5;
function pullTimeoutMs() {
  return envInt("DOCKER_PULL_TIMEOUT_MS", DEFAULT_PULL_TIMEOUT_MS);
}
function embedModel() {
  return env("EMBED_MODEL") ?? "nomic-embed-text";
}
function defaultRun(cmd, args, opts) {
  const res = spawnSync2(cmd, args, {
    encoding: "utf8",
    timeout: opts.timeoutMs,
    maxBuffer: 64 * 1024 * 1024,
    stdio: opts.capture ? "pipe" : "inherit"
  });
  const missing = !!res.error && res.error.code === "ENOENT";
  return {
    ok: !res.error && res.status === 0,
    stdout: res.stdout ?? "",
    stderr: res.stderr ?? (res.error ? String(res.error.message) : ""),
    missing
  };
}
function defaultHas(cmd) {
  const probe = defaultRun(process.platform === "win32" ? "where" : "which", [cmd], { timeoutMs: 1e4, capture: true });
  return probe.ok && probe.stdout.trim().length > 0;
}
var STACKS = {
  searxng: {
    profiles: ["search"],
    summary: "SearXNG is up (:8888) \u2014 keyless discovery, JSON API enabled."
  },
  firecrawl: {
    profiles: ["search", "extract"],
    summary: "Firecrawl is up (:3002 \xB7 playwright \xB7 redis \xB7 rabbitmq \xB7 postgres), with SearXNG behind it.",
    postUp: () => [
      "  keyless: USE_DB_AUTHENTICATION=false \u2014 no API key is sent or needed.",
      "  effect:  pages are now cleaned by a real browser; --firecrawl off opts out."
    ]
  },
  semantic: {
    profiles: ["semantic"],
    summary: "Qdrant (:6333) and Ollama (:11434) are up.",
    postUp: (file, run) => {
      const model = embedModel();
      const pull = run("docker", ["compose", "-f", file, "exec", "-T", "ollama", "ollama", "pull", model], { timeoutMs: MODEL_PULL_TIMEOUT_MS, capture: true });
      return [pull.ok ? `  model:   ${model} ready` : `  model:   pull it yourself: docker compose -f ${file} exec ollama ollama pull ${model}`];
    }
  },
  all: {
    profiles: ["all", "extract"],
    summary: "The whole stack is up (Qdrant \xB7 Ollama \xB7 SearXNG \xB7 Firecrawl).",
    postUp: (file, run) => STACKS.semantic.postUp(file, run)
  }
};
function combine(names) {
  const specs = names.map((n) => STACKS[n]);
  if (specs.some((x) => !x)) return null;
  const found = specs;
  if (found.length === 1) return found[0];
  return {
    profiles: [...new Set(found.flatMap((x) => x.profiles))],
    summary: found.map((x) => x.summary).join("\n  "),
    postUp: (file, run) => found.flatMap((x) => x.postUp?.(file, run) ?? [])
  };
}
var STACK_SERVICES = Object.keys(STACKS);
var SERVICE_PROFILES = Object.fromEntries(Object.entries(STACKS).map(([k, v]) => [k, v.profiles]));
function stackControl(service, action, deps = {}) {
  const run = deps.run ?? defaultRun;
  const has = deps.has ?? defaultHas;
  const names = Array.isArray(service) ? service : [service];
  const tag = `${brand().cli} ${names.join("+")}`;
  const spec = combine(names);
  if (!spec) {
    const bad = names.filter((n) => !STACKS[n]);
    return { message: `${brand().cli}: unknown service ${bad.map((b) => `"${b}"`).join(", ")} \u2014 expected one of ${STACK_SERVICES.join(", ")}`, code: 1 };
  }
  if (action !== "up" && action !== "down" && action !== "status") {
    return { message: `${tag}: unknown action "${action}" (use: up | down | status)`, code: 1 };
  }
  if (!has("docker")) {
    return { message: `${tag}: docker not found on PATH. The stack is optional \u2014 everything it provides degrades to a note.`, code: 1 };
  }
  const file = ensureComposeMaterialized();
  const profiles = spec.profiles.flatMap((p) => ["--profile", p]);
  if (action === "down") {
    const r = run("docker", ["compose", "-f", file, ...profiles, "down"], { timeoutMs: DOWN_TIMEOUT_MS, capture: true });
    return { message: r.ok ? `${tag}: stopped.` : `${tag}: down failed.
${r.stderr}`, code: r.ok ? 0 : 1 };
  }
  if (action === "status") {
    const r = run("docker", ["compose", "-f", file, ...profiles, "ps"], { timeoutMs: PS_TIMEOUT_MS, capture: true });
    return { message: r.ok ? r.stdout.trim() || `${tag}: no services running.` : `${tag}: status failed.
${r.stderr}`, code: 0 };
  }
  const pulled = run("docker", ["compose", "-f", file, ...profiles, "pull"], { timeoutMs: pullTimeoutMs() });
  if (!pulled.ok) {
    return {
      message: `${tag}: pulling the images failed (they are large \u2014 raise ${envName("DOCKER_PULL_TIMEOUT_MS")}, currently ${pullTimeoutMs()}ms).` + (pulled.stderr ? `
${pulled.stderr}` : ""),
      code: 1
    };
  }
  const up = run("docker", ["compose", "-f", file, ...profiles, "up", "-d", "--wait"], { timeoutMs: UP_TIMEOUT_MS });
  if (!up.ok) return { message: `${tag}: up failed.${up.stderr ? `
${up.stderr}` : ""}`, code: 1 };
  return { message: [`${tag}: ${spec.summary}`, ...spec.postUp?.(file, run) ?? []].join("\n"), code: 0 };
}

// src/pool.ts
async function mapLimit(items, limit, fn) {
  const width = Math.max(1, Math.floor(limit));
  if (items.length <= 1 || width === 1) {
    const out = [];
    for (let i = 0; i < items.length; i++) out.push(await fn(items[i], i));
    return out;
  }
  const results = new Array(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(width, items.length) }, async () => {
    for (; ; ) {
      const i = next++;
      if (i >= items.length) return;
      results[i] = await fn(items[i], i);
    }
  });
  await Promise.all(workers);
  return results;
}

// src/run-lock.ts
var chains = /* @__PURE__ */ new Map();
function withRunLock(slug, fn) {
  const prev = chains.get(slug) ?? Promise.resolve();
  const next = prev.then(fn, fn);
  const tail = next.then(noop, noop);
  chains.set(slug, tail);
  tail.then(() => {
    if (chains.get(slug) === tail) chains.delete(slug);
  }, noop);
  return next;
}
function noop() {
}
function resetRunLocks() {
  chains.clear();
}

// src/cache.ts
import { existsSync as existsSync4, mkdirSync as mkdirSync4, readFileSync as readFileSync3, readdirSync as readdirSync2, rmSync as rmSync3, statSync as statSync2, writeFileSync as writeFileSync4 } from "fs";
import { join as join4 } from "path";
import { tmpdir as tmpdir4 } from "os";

// src/no-write.ts
import { mkdirSync as mkdirSync3, renameSync, unlinkSync, writeFileSync as writeFileSync3 } from "fs";
var flagged = false;
function setNoWrite(on) {
  flagged = on;
}
function isNoWrite() {
  return flagged || envFlag("NO_WRITE");
}
var collected = [];
function ensureDir(dir) {
  if (isNoWrite()) return;
  mkdirSync3(dir, { recursive: true });
}
function writeArtifact(path, content) {
  if (isNoWrite()) {
    const at = collected.findIndex((a) => a.path === path);
    if (at !== -1) collected[at] = { path, content };
    else collected.push({ path, content });
    return path;
  }
  writeFileAtomic(path, content);
  return path;
}
var tmpCounter = 0;
function writeFileAtomic(path, content) {
  const tmp = `${path}.${process.pid}.${tmpCounter++}.tmp`;
  try {
    writeFileSync3(tmp, content);
    renameSync(tmp, path);
  } catch (e) {
    try {
      unlinkSync(tmp);
    } catch {
    }
    throw e;
  }
}
function takeArtifacts() {
  return collected.splice(0, collected.length);
}
function resetNoWrite() {
  flagged = false;
  collected.length = 0;
}

// src/cache.ts
var DEFAULT_TTL_MS = 24 * 60 * 60 * 1e3;
function cacheDir() {
  return env("CACHE_DIR") ?? brand().cacheDir ?? join4(tmpdir4(), brand().name, "cache");
}
function cachePath(url, acceptLanguage = "", extractor = "native") {
  const canon = canonicalizeUrl(url);
  const domain = domainOf(url).replace(/[^a-z0-9.-]/gi, "_") || "url";
  return join4(cacheDir(), `${domain}-${fnv1a64(`${canon}\0${acceptLanguage}\0${extractor}`).toString(16)}.json`);
}
var PDF_CACHE_NS = "pdf";
var DOC_CACHE_NS = "doc";
async function currentExtractor(opts, url) {
  if (looksLikePdfUrl(url)) return PDF_CACHE_NS;
  if (docFormatForUrl(url)) return DOC_CACHE_NS;
  const base = firecrawlBase(opts);
  return base && await probeFirecrawl(base, firecrawlIsExplicit(opts)) ? "firecrawl" : "native";
}
var WRITTEN_NAMESPACES = ["native", "firecrawl", PDF_CACHE_NS, DOC_CACHE_NS];
function readAnyNamespace(url, acceptLanguage) {
  let best;
  for (const ns of WRITTEN_NAMESPACES) {
    const hit = readCache(url, acceptLanguage, ns);
    if (hit && (!best || hit.cachedAt > best.cachedAt)) best = hit;
  }
  return best;
}
function ttlMs() {
  const fallback = brand().cacheTtlMs ?? DEFAULT_TTL_MS;
  if (env("CACHE_TTL_HOURS") !== void 0) return envInt("CACHE_TTL_HOURS", fallback / 36e5, 0) * 36e5;
  return envInt("CACHE_TTL_MS", fallback);
}
var mode = { refresh: false, offline: false };
function setCacheMode(next) {
  mode = { ...mode, ...next };
}
function cacheMode() {
  return { ...mode };
}
function resetCacheMode() {
  mode = { refresh: false, offline: false };
}
function isCacheFresh(entry, now = Date.now()) {
  return typeof entry.cachedAt === "number" && now - entry.cachedAt < ttlMs();
}
function revalidationHeaders(entry) {
  const h = {};
  if (entry.etag) h["if-none-match"] = entry.etag;
  if (entry.lastModified) h["if-modified-since"] = entry.lastModified;
  return h;
}
function entryPaths(url, acceptLanguage, extractor) {
  const meta = cachePath(url, acceptLanguage, extractor);
  return { meta, body: meta.replace(/\.json$/, ".body") };
}
function readCache(url, acceptLanguage = "", extractor = "native") {
  const { meta, body } = entryPaths(url, acceptLanguage, extractor);
  if (!existsSync4(meta)) return void 0;
  try {
    const entry = JSON.parse(readFileSync3(meta, "utf8"));
    if (typeof entry.cachedAt !== "number") return void 0;
    const text = existsSync4(body) ? readFileSync3(body, "utf8") : entry.text;
    if (!text?.trim()) return void 0;
    return { ...entry, text };
  } catch {
    return void 0;
  }
}
function writeCache(url, res, now, acceptLanguage = "", extractor = "native") {
  if (isNoWrite()) return;
  try {
    mkdirSync4(cacheDir(), { recursive: true });
    const { meta, body } = entryPaths(url, acceptLanguage, extractor);
    const { text, ...rest } = res;
    writeFileSync4(body, text ?? "");
    writeFileSync4(meta, JSON.stringify({ ...rest, cachedAt: now }));
  } catch {
  }
}
function touchCache(url, entry, now, acceptLanguage = "", extractor = "native") {
  writeCache(url, entry, now, acceptLanguage, extractor);
}
async function cachedFetchAndExtract(url, opts = {}, enabled = false, now = Date.now()) {
  const { refresh, offline } = mode;
  if (!enabled && !offline) return fetchAndExtract(url, opts);
  const lang = opts.acceptLanguage ?? "";
  const served = (entry, note) => {
    countFetch(Buffer.byteLength(entry.text), true);
    return { ...entry, cached: true, ...note ? { note } : {} };
  };
  if (offline) {
    const stored = readAnyNamespace(url, lang);
    if (stored) return served(stored);
    return { text: "", finalUrl: url, status: 0, note: `Offline: ${url} is not in the cache (drop --offline, or warm it with a normal run).` };
  }
  const ns = await currentExtractor(opts, url);
  const hit = refresh ? void 0 : readCache(url, lang, ns);
  if (hit && isCacheFresh(hit, now)) return served(hit);
  const revalidate = hit ? revalidationHeaders(hit) : {};
  if (hit && Object.keys(revalidate).length) {
    const probe = await fetchAndExtract(url, { ...opts, headers: revalidate });
    if (probe.status === 304) {
      touchCache(url, hit, now, lang, ns);
      return served(hit);
    }
    if (probe.text?.trim()) {
      writeCache(url, probe, now, lang, ns === PDF_CACHE_NS || ns === DOC_CACHE_NS ? ns : probe.extractor ?? "native");
      return probe;
    }
  }
  const res = await fetchAndExtract(url, opts);
  if (res.text?.trim()) {
    writeCache(url, res, now, lang, ns === PDF_CACHE_NS || ns === DOC_CACHE_NS ? ns : res.extractor ?? "native");
    return res;
  }
  const stale = hit ?? readAnyNamespace(url, lang);
  if (stale) return served(stale, `${url} returned ${res.status || "no response"}; served the cached copy from ${new Date(stale.cachedAt).toISOString()}.`);
  return res;
}
function cacheStats(now = Date.now()) {
  const dir = cacheDir();
  const out = { dir, entries: 0, bytes: 0, fresh: 0, stale: 0, ttlMs: ttlMs() };
  if (!existsSync4(dir)) return out;
  let oldest = Number.POSITIVE_INFINITY;
  let newest = 0;
  for (const name of readdirSync2(dir)) {
    const abs = join4(dir, name);
    try {
      out.bytes += statSync2(abs).size;
    } catch {
    }
    if (!name.endsWith(".json")) continue;
    try {
      const entry = JSON.parse(readFileSync3(abs, "utf8"));
      if (typeof entry.cachedAt !== "number") continue;
      out.entries++;
      if (isCacheFresh(entry, now)) out.fresh++;
      else out.stale++;
      if (entry.cachedAt < oldest) oldest = entry.cachedAt;
      if (entry.cachedAt > newest) newest = entry.cachedAt;
    } catch {
    }
  }
  if (out.entries) {
    out.oldest = new Date(oldest).toISOString();
    out.newest = new Date(newest).toISOString();
  }
  return out;
}
function cacheClean(all = false, now = Date.now()) {
  const dir = cacheDir();
  if (!existsSync4(dir) || isNoWrite()) return 0;
  let removed = 0;
  for (const name of readdirSync2(dir)) {
    if (!name.endsWith(".json")) continue;
    const abs = join4(dir, name);
    let drop = all;
    if (!drop) {
      try {
        const entry = JSON.parse(readFileSync3(abs, "utf8"));
        drop = !isCacheFresh(entry, now);
      } catch {
        drop = true;
      }
    }
    if (!drop) continue;
    try {
      rmSync3(abs, { force: true });
      rmSync3(abs.replace(/\.json$/, ".body"), { force: true });
      removed++;
    } catch {
    }
  }
  return removed;
}

// src/run.ts
import { join as join5 } from "path";
import { readFileSync as readFileSync4 } from "fs";
function pad(n) {
  return String(n).padStart(2, "0");
}
function runId(d = /* @__PURE__ */ new Date()) {
  return `run-${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
}
function shq(s) {
  return `'${s.replace(/\r?\n/g, " ").replaceAll("'", `'"'"'`)}'`;
}
function readJsonSafe(path) {
  try {
    return JSON.parse(readFileSync4(path, "utf8"));
  } catch {
    return void 0;
  }
}
function readManifest(dir, file = "manifest.json") {
  return readJsonSafe(join5(dir, file));
}
function writeManifest(dir, value, file = "manifest.json") {
  return writeArtifact(join5(dir, file), `${JSON.stringify(value, null, 2)}
`);
}

// src/changed.ts
import { createHash } from "crypto";
function contentHash(body) {
  return createHash("sha256").update(body).digest("hex");
}
async function fingerprint(url, opts = {}) {
  const res = await httpGet(url, opts);
  return {
    url,
    ...res.etag ? { etag: res.etag } : {},
    ...res.lastModified ? { lastModified: res.lastModified } : {},
    ...res.ok ? { contentHash: contentHash(res.body) } : {},
    bytes: res.body.length,
    status: res.status,
    fetchedAt: (/* @__PURE__ */ new Date()).toISOString()
  };
}
async function hasChanged(url, previous, opts = {}) {
  const headers = {};
  if (previous?.etag) headers["if-none-match"] = previous.etag;
  if (previous?.lastModified) headers["if-modified-since"] = previous.lastModified;
  const res = await httpGet(url, { ...opts, ...Object.keys(headers).length ? { headers } : {} });
  const observed = {
    url,
    ...res.etag ? { etag: res.etag } : {},
    ...res.lastModified ? { lastModified: res.lastModified } : {},
    ...res.ok && res.body ? { contentHash: contentHash(res.body) } : {},
    bytes: res.body.length,
    status: res.status,
    fetchedAt: (/* @__PURE__ */ new Date()).toISOString()
  };
  if (res.status === 304) return { changed: false, via: "not-modified", fingerprint: { ...observed, ...previous, status: 304, bytes: 0 } };
  if (!res.ok) {
    return { via: "unknown", fingerprint: observed, note: `could not read ${url}: ${res.error ?? `status ${res.status}`}` };
  }
  if (!previous || !previous.etag && !previous.lastModified && !previous.contentHash) {
    return { changed: false, via: "unknown", fingerprint: observed, note: "no previous observation \u2014 this is the baseline." };
  }
  if (previous.etag && observed.etag) return { changed: previous.etag !== observed.etag, via: "etag", fingerprint: observed };
  if (previous.lastModified && observed.lastModified) {
    return { changed: previous.lastModified !== observed.lastModified, via: "last-modified", fingerprint: observed };
  }
  if (previous.contentHash && observed.contentHash) {
    return { changed: previous.contentHash !== observed.contentHash, via: "hash", fingerprint: observed };
  }
  return { via: "unknown", fingerprint: observed, note: "nothing comparable between the two observations \u2014 store contentHash to make this answerable." };
}

// src/tables.ts
function decodeEntities2(s) {
  return s.replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(Number.parseInt(h, 16))).replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d))).replace(/&nbsp;/gi, " ").replace(/&lt;/gi, "<").replace(/&gt;/gi, ">").replace(/&quot;/gi, '"').replace(/&#39;|&apos;/gi, "'").replace(/&amp;/gi, "&");
}
function cellText(html) {
  return decodeEntities2(
    html.replace(/<br\s*\/?>/gi, " ").replace(/<[^>]*>/g, "").replace(/\s+/g, " ")
  ).trim();
}
function intAttr(tag, name) {
  const m = new RegExp(`\\b${name}\\s*=\\s*["']?(\\d+)`, "i").exec(tag);
  const n = m ? Number(m[1]) : 1;
  return Number.isFinite(n) && n >= 1 ? Math.min(n, 100) : 1;
}
function parseRow(rowHtml) {
  const cells = [];
  for (const m of rowHtml.matchAll(/<(t[hd])\b([^>]*)>([\s\S]*?)<\/\1\s*>/gi)) {
    cells.push({
      text: cellText(m[3]),
      colspan: intAttr(m[2], "colspan"),
      rowspan: intAttr(m[2], "rowspan"),
      header: m[1].toLowerCase() === "th"
    });
  }
  return cells;
}
function expand(rows) {
  const grid = [];
  const carried = /* @__PURE__ */ new Map();
  rows.forEach((cells, r) => {
    const out = [];
    let c = 0;
    const skipCarried = () => {
      while (carried.has(`${r}:${c}`)) {
        out[c] = carried.get(`${r}:${c}`);
        c++;
      }
      return c;
    };
    for (const cell of cells) {
      const startCol = skipCarried();
      for (let i = 0; i < cell.colspan; i++) {
        out[startCol + i] = cell.text;
        for (let j = 1; j < cell.rowspan; j++) carried.set(`${r + j}:${startCol + i}`, cell.text);
      }
      c = startCol + cell.colspan;
    }
    skipCarried();
    grid.push(out);
  });
  const width = grid.reduce((w, row) => Math.max(w, row.length), 0);
  return grid.map((row) => Array.from({ length: width }, (_, i) => row[i] ?? ""));
}
function extractTables(html) {
  const tables = [];
  for (const m of html.matchAll(/<table\b[^>]*>([\s\S]*?)<\/table\s*>/gi)) {
    const inner = m[1];
    const caption = /<caption\b[^>]*>([\s\S]*?)<\/caption\s*>/i.exec(inner);
    const rawRows = [];
    for (const r of inner.matchAll(/<tr\b[^>]*>([\s\S]*?)<\/tr\s*>/gi)) {
      const cells = parseRow(r[1]);
      if (cells.length) rawRows.push(cells);
    }
    if (!rawRows.length) continue;
    const grid = expand(rawRows);
    const headerIndex = rawRows.findIndex((cells) => cells.every((c) => c.header));
    const headers = headerIndex === 0 ? grid[0] : [];
    const rows = headerIndex === 0 ? grid.slice(1) : grid;
    if (!rows.length) continue;
    tables.push({ ...caption ? { caption: cellText(caption[1]) } : {}, headers, rows });
  }
  return tables;
}
function tableToMarkdown(table) {
  const width = Math.max(table.headers.length, ...table.rows.map((r) => r.length), 1);
  const esc = (s) => s.replace(/\|/g, "\\|");
  const line = (cells) => `| ${Array.from({ length: width }, (_, i) => esc(cells[i] ?? "")).join(" | ")} |`;
  const out = [];
  if (table.caption) out.push(`**${table.caption}**`, "");
  out.push(line(table.headers.length ? table.headers : Array.from({ length: width }, () => "")));
  out.push(`|${" --- |".repeat(width)}`);
  for (const row of table.rows) out.push(line(row));
  return out.join("\n");
}

// src/crawl.ts
var nextFree = /* @__PURE__ */ new Map();
function resetHostSchedule() {
  nextFree.clear();
}
function hostDelayMs() {
  return envInt("POLITE_DELAY_MS", 400, 0, 5e3);
}
function hostOf(url) {
  try {
    return new URL(url).host.toLowerCase();
  } catch {
    return "";
  }
}
async function awaitHostSlot(url, delayMs = hostDelayMs(), now = Date.now()) {
  const host = hostOf(url);
  if (!host || delayMs <= 0) return 0;
  const free = nextFree.get(host) ?? 0;
  const waited = Math.max(0, free - now);
  nextFree.set(host, Math.max(free, now) + delayMs);
  if (waited > 0) await sleep(waited);
  return waited;
}
function backOffHost(url, ms, now = Date.now()) {
  const host = hostOf(url);
  if (!host || ms <= 0) return;
  nextFree.set(host, Math.max(nextFree.get(host) ?? 0, now + ms));
}
function linksFrom(html, baseUrl) {
  const out = [];
  const seen = /* @__PURE__ */ new Set();
  for (const m of html.matchAll(/<a\b[^>]*?\bhref\s*=\s*["']([^"'#]+)["']/gi)) {
    const raw = m[1].trim();
    if (/^(mailto|tel|javascript|data):/i.test(raw)) continue;
    try {
      const abs = new URL(raw, baseUrl);
      if (abs.protocol !== "http:" && abs.protocol !== "https:") continue;
      abs.hash = "";
      const canon = canonicalizeUrl(abs.href);
      if (!seen.has(canon)) {
        seen.add(canon);
        out.push(abs.href);
      }
    } catch {
    }
  }
  return out;
}
function sameOrigin(a, b) {
  try {
    const x = new URL(a);
    const y = new URL(b);
    return x.protocol === y.protocol && x.host === y.host;
  } catch {
    return false;
  }
}
async function crawlSite(seed, opts = {}) {
  const maxPages = Math.max(1, opts.maxPages ?? 20);
  const maxDepth = Math.max(0, opts.maxDepth ?? 2);
  const notes = [];
  const disallowed = [];
  const pages = [];
  let robots = { rules: [], sitemaps: [], absent: true };
  if (!opts.ignoreRobots) {
    robots = await fetchRobots(seed);
    if (robots.absent) notes.push("no robots.txt \u2014 nothing was refused, but nothing was granted either.");
  } else {
    notes.push("robots.txt was not consulted (ignoreRobots) \u2014 only correct on a site you own.");
  }
  const delay = opts.delayMs ?? robots.crawlDelayMs ?? hostDelayMs();
  if (robots.crawlDelayMs && opts.delayMs === void 0) notes.push(`honouring the declared Crawl-delay of ${robots.crawlDelayMs}ms.`);
  const seen = /* @__PURE__ */ new Set([canonicalizeUrl(seed)]);
  const queue = [{ url: seed, depth: 0 }];
  if (opts.useSitemap !== false && maxDepth > 0) {
    const sm = await fetchSitemap(seed, { sitemaps: robots.sitemaps });
    let added = 0;
    for (const entry of sm.urls) {
      const canon = canonicalizeUrl(entry.loc);
      if (seen.has(canon)) continue;
      if (!opts.crossOrigin && !sameOrigin(entry.loc, seed)) continue;
      seen.add(canon);
      queue.push({ url: entry.loc, depth: 1 });
      added++;
    }
    if (added) notes.push(`seeded ${added} URL(s) from the sitemap.`);
  }
  while (queue.length && pages.length < maxPages) {
    const next = queue.shift();
    if (!next) break;
    if (!opts.ignoreRobots && !isAllowed(robots, next.url)) {
      disallowed.push(next.url);
      continue;
    }
    await awaitHostSlot(next.url, delay);
    const r = await fetchAndExtract(next.url, { keepHtml: next.depth < maxDepth });
    if (!r.text) {
      notes.push(`${next.url}: ${r.note ?? "nothing readable"}`);
      continue;
    }
    const links = r.html ? linksFrom(r.html, next.url) : [];
    const page = {
      url: next.url,
      depth: next.depth,
      ...r.title ? { title: r.title } : {},
      text: r.text,
      extractor: r.extractor ?? "native",
      links
    };
    pages.push(page);
    opts.onPage?.(page);
    if (next.depth >= maxDepth) continue;
    for (const link of links) {
      const canon = canonicalizeUrl(link);
      if (seen.has(canon)) continue;
      if (!opts.crossOrigin && !sameOrigin(link, seed)) continue;
      seen.add(canon);
      queue.push({ url: link, depth: next.depth + 1 });
    }
  }
  if (queue.length) notes.push(`stopped at the ${maxPages}-page budget with ${queue.length} URL(s) still queued.`);
  return { pages, pending: queue.map((q) => q.url), disallowed, notes };
}

// src/embed.ts
function ollamaBase() {
  return env("OLLAMA") ?? "http://localhost:11434";
}
function embeddingsDisabled() {
  return ollamaBase().toLowerCase() === "off";
}
function embedConcurrency() {
  return Math.max(1, envInt("EMBED_CONCURRENCY", 4));
}
function embedBatch() {
  return Math.max(1, envInt("EMBED_BATCH", 16));
}
var probed;
function resetOllamaProbe() {
  probed = void 0;
}
async function probeOllama(base = ollamaBase()) {
  if (base.toLowerCase() === "off") return false;
  if (probed !== void 0) return probed;
  const r = await httpJson("GET", `${base.replace(/\/+$/, "")}/api/tags`, void 0, { timeoutMs: 2e3, retries: 0 });
  probed = r.ok;
  return probed;
}
async function embed(texts, opts = {}) {
  const model = opts.model ?? embedModel();
  if (texts.length === 0) return { vectors: [], model };
  const base = (opts.base ?? ollamaBase()).replace(/\/+$/, "");
  if (base.toLowerCase() === "off") return { vectors: [], model, note: "embeddings are disabled (OLLAMA=off)." };
  if (!await probeOllama(base)) {
    return { vectors: [], model, note: `no embedding server at ${base} \u2014 \`${brand().cli} semantic up\` starts Ollama and pulls ${model}.` };
  }
  const batches = [];
  const width = embedBatch();
  for (let i = 0; i < texts.length; i += width) batches.push(texts.slice(i, i + width));
  let note;
  const results = await mapLimit(batches, opts.concurrency ?? embedConcurrency(), async (batch) => {
    const r = await httpJson("POST", `${base}/api/embed`, { model, input: batch }, { timeoutMs: 6e4 });
    const got = r.ok ? r.data?.embeddings : void 0;
    if (!got || got.length !== batch.length) {
      note ??= `embedding failed at ${base} (${r.error ?? `status ${r.status}`}) \u2014 is \`${model}\` pulled? \`${brand().cli} semantic up\` pulls it.`;
      return void 0;
    }
    return got;
  });
  if (results.some((r) => r === void 0)) return { vectors: [], model, ...note ? { note } : {} };
  return { vectors: results.flat(), model };
}
async function embedOne(text, opts = {}) {
  const r = await embed([text], opts);
  return r.vectors[0];
}
function cosine(a, b) {
  if (a.length === 0 || a.length !== b.length) return 0;
  let dot = 0;
  let ma = 0;
  let mb = 0;
  for (let i = 0; i < a.length; i++) {
    const x = a[i];
    const y = b[i];
    dot += x * y;
    ma += x * x;
    mb += y * y;
  }
  if (ma === 0 || mb === 0) return 0;
  const r = dot / (Math.sqrt(ma) * Math.sqrt(mb));
  return Number.isFinite(r) ? r : 0;
}
function normalize(v) {
  let m = 0;
  for (const x of v) m += x * x;
  if (m === 0) return [...v];
  const len = Math.sqrt(m);
  return v.map((x) => x / len);
}

// src/vector.ts
function qdrantBase() {
  return env("QDRANT") ?? "http://localhost:6333";
}
var clean = (base) => base.replace(/\/+$/, "");
var probed2;
function resetQdrantProbe() {
  probed2 = void 0;
}
async function probeQdrant(base = qdrantBase()) {
  if (base.toLowerCase() === "off") return false;
  if (probed2 !== void 0) return probed2;
  const r = await httpJson("GET", `${clean(base)}/collections`, void 0, { timeoutMs: 2e3, retries: 0 });
  probed2 = r.ok;
  return probed2;
}
async function ensureCollection(name, size, opts = {}) {
  const base = clean(opts.base ?? qdrantBase());
  if (base.toLowerCase() === "off") return { ok: false, note: "the vector store is disabled (QDRANT=off)." };
  if (!await probeQdrant(base)) return { ok: false, note: unreachable(base) };
  const existing = await httpJson("GET", `${base}/collections/${encodeURIComponent(name)}`, void 0, { retries: 0 });
  if (existing.ok) return { ok: true };
  const r = await httpJson("PUT", `${base}/collections/${encodeURIComponent(name)}`, { vectors: { size, distance: opts.distance ?? "Cosine" } });
  return r.ok ? { ok: true } : { ok: false, note: `could not create collection "${name}" at ${base}: ${r.error ?? `status ${r.status}`}` };
}
async function upsert(name, points, opts = {}) {
  if (points.length === 0) return { ok: true };
  const base = clean(opts.base ?? qdrantBase());
  if (base.toLowerCase() === "off") return { ok: false, note: "the vector store is disabled (QDRANT=off)." };
  if (!await probeQdrant(base)) return { ok: false, note: unreachable(base) };
  const r = await httpJson("PUT", `${base}/collections/${encodeURIComponent(name)}/points?wait=true`, { points });
  return r.ok ? { ok: true } : { ok: false, note: `upsert into "${name}" failed: ${r.error ?? `status ${r.status}`}` };
}
async function searchVectors(name, vector, opts = {}) {
  const base = clean(opts.base ?? qdrantBase());
  if (base.toLowerCase() === "off") return { hits: [], note: "the vector store is disabled (QDRANT=off)." };
  if (!await probeQdrant(base)) return { hits: [], note: unreachable(base) };
  const body = { vector: [...vector], limit: opts.limit ?? 10, with_payload: true, ...opts.filter ? { filter: opts.filter } : {} };
  const r = await httpJson("POST", `${base}/collections/${encodeURIComponent(name)}/points/search`, body);
  if (!r.ok) return { hits: [], note: `search in "${name}" failed: ${r.error ?? `status ${r.status}`}` };
  const raw = r.data?.result ?? [];
  return { hits: raw.map((h) => ({ id: h.id, score: h.score, ...h.payload ? { payload: h.payload } : {} })) };
}
async function deleteCollection(name, opts = {}) {
  const base = clean(opts.base ?? qdrantBase());
  if (base.toLowerCase() === "off") return { ok: false, note: "the vector store is disabled (QDRANT=off)." };
  const r = await httpJson("DELETE", `${base}/collections/${encodeURIComponent(name)}`, void 0, { retries: 0 });
  return r.ok ? { ok: true } : { ok: false, note: `could not delete "${name}": ${r.error ?? `status ${r.status}`}` };
}
function unreachable(base) {
  return `no vector store at ${base} \u2014 \`${brand().cli} semantic up\` starts Qdrant.`;
}
async function hybridSearch(question, docs, opts = {}) {
  if (docs.length === 0) return { hits: [] };
  const index = buildBm25Index(question, docs);
  const lexical = [...docs].sort((a, b) => bm25Score(index, b) - bm25Score(index, a));
  const embedded = await embed([question, ...docs.map((d) => [d.title, d.headings, d.body].filter(Boolean).join("\n"))], {
    ...opts.base !== void 0 ? { base: opts.base } : {},
    ...opts.model !== void 0 ? { model: opts.model } : {}
  });
  let dense = [];
  let note = embedded.note;
  if (embedded.vectors.length === docs.length + 1) {
    const q = embedded.vectors[0];
    const scored = docs.map((doc, i) => ({ doc, sim: cosine(q, embedded.vectors[i + 1]) }));
    dense = scored.sort((a, b) => b.sim - a.sim).map((s) => s.doc);
  } else if (!note) {
    note = "the dense lane returned an unexpected number of vectors \u2014 ranking lexically only.";
  }
  const lists = dense.length ? [lexical, dense] : [lexical];
  const fused = rrf(lists, (d) => d.id, opts.k ?? envInt("RRF_K", 60));
  const lexRank = new Map(lexical.map((d, i) => [d.id, i + 1]));
  const denseRank = new Map(dense.map((d, i) => [d.id, i + 1]));
  const hits = [...docs].map((doc) => ({
    doc,
    score: fused.get(doc.id) ?? 0,
    ...lexRank.has(doc.id) ? { lexicalRank: lexRank.get(doc.id) } : {},
    ...denseRank.has(doc.id) ? { denseRank: denseRank.get(doc.id) } : {}
  })).sort((a, b) => b.score - a.score);
  return { hits: opts.limit ? hits.slice(0, opts.limit) : hits, ...note ? { note } : {} };
}

// src/cite.ts
var TOKEN_RE2 = /\[([^\]\n]+)\](?!\()/g;
var SOURCE_TOKEN = /^S\d+$/;
var EVIDENCE_TOKEN = /^E\d+$/;
var FILE_LINE_TOKEN = /^(.+?):(\d+)(?:-(\d+))?$/;
function parseFileLine(token) {
  const m = FILE_LINE_TOKEN.exec(token.trim());
  if (!m) return void 0;
  const start = Number(m[2]);
  const end = m[3] === void 0 ? start : Number(m[3]);
  if (!Number.isInteger(start) || !Number.isInteger(end) || start < 1 || end < start) return void 0;
  return { path: m[1], start, end };
}
function stripHtmlComments(text) {
  return text.replace(/<!--[\s\S]*?-->/g, (m) => m.replace(/[^\n]/g, " "));
}
function stripInlineCode(line) {
  return line.replace(/`[^`\n]*`/g, " ");
}
function codeMask(lines) {
  const mask = new Array(lines.length).fill(false);
  let inFence = false;
  for (let i = 0; i < lines.length; i++) {
    if (/^\s*(```|~~~)/.test(lines[i])) {
      mask[i] = true;
      inFence = !inFence;
      continue;
    }
    mask[i] = inFence;
  }
  return mask;
}
function markedQuoteMask(lines, marker) {
  const mask = new Array(lines.length).fill(false);
  let regions = 0;
  let i = 0;
  while (i < lines.length) {
    if (!/^\s*>/.test(lines[i])) {
      i++;
      continue;
    }
    let j = i;
    let marked = false;
    while (j < lines.length && /^\s*>/.test(lines[j])) {
      if (marker.test(lines[j])) marked = true;
      j++;
    }
    if (marked) {
      regions++;
      for (let k = i; k < j; k++) mask[k] = true;
    }
    i = j;
  }
  return { mask, regions };
}
var APPENDIX_HEADING = /^\s*(#{2,6})\s+(sources|references|bibliography)\b/i;
function appendixMask(lines) {
  const mask = new Array(lines.length).fill(false);
  let level = 0;
  for (let i = 0; i < lines.length; i++) {
    const h = /^\s*(#{1,6})\s/.exec(lines[i]);
    if (level && h && h[1].length <= level) level = 0;
    if (!level) {
      const a = APPENDIX_HEADING.exec(lines[i]);
      if (a) level = a[1].length;
    }
    mask[i] = level > 0;
  }
  return mask;
}
function orMasks(...masks) {
  const first = masks[0] ?? [];
  return first.map((_, i) => masks.some((m) => m[i] === true));
}
var isHeadingOrRule = (t) => /^#{1,6}\s/.test(t) || /^([-*_])\1{2,}$/.test(t);
var isTableSeparator = (line) => /\|/.test(line) && /^[\s:|-]+$/.test(line.trim()) && /-/.test(line);
var isTableRow = (line) => /\|/.test(line.trim()) && !isTableSeparator(line);
var isListItem = (line) => /^\s*([-*+]|\d+\.)\s+\S/.test(line);
function tableCells(line) {
  return line.trim().replace(/^\|/, "").replace(/\|$/, "").split("|").map((c) => c.trim()).join(" ");
}
function extractClaimUnits(text, opts = {}) {
  const lines = stripHtmlComments(text).split("\n");
  const code = codeMask(lines);
  const extra = opts.exclude ? opts.exclude(lines) : [];
  const skip = (i2) => code[i2] === true || extra[i2] === true;
  const quoteMode = opts.blockquotes ?? "unit";
  const skipHeader = opts.skipTableHeader !== false;
  const stored = (raw) => opts.keepInlineCode ? raw : stripInlineCode(raw);
  const units = [];
  let prose = [];
  let section;
  const tag = (u) => section === void 0 ? u : { ...u, section };
  const flush = () => {
    if (prose.length) units.push(tag({ kind: "text", text: prose.join(" ") }));
    prose = [];
  };
  let i = 0;
  while (i < lines.length) {
    if (skip(i)) {
      flush();
      i++;
      continue;
    }
    const raw = lines[i];
    const line = stripInlineCode(raw);
    const t = line.trim();
    if (t === "" || isHeadingOrRule(t) || isTableSeparator(line)) {
      flush();
      if (/^#{1,6}\s/.test(t)) section = opts.sectionTag?.(t);
      i++;
      continue;
    }
    if (isTableRow(line)) {
      flush();
      const next = i + 1 < lines.length && !skip(i + 1) ? stripInlineCode(lines[i + 1]) : "";
      if (!(skipHeader && isTableSeparator(next))) units.push(tag({ kind: "text", text: tableCells(stored(raw)) }));
      i++;
      continue;
    }
    if (/^\s*>/.test(line)) {
      if (quoteMode === "prose") {
        const dequoted = stored(raw).replace(/^\s*>\s?/, "").trim();
        if (dequoted) prose.push(dequoted);
        i++;
        continue;
      }
      flush();
      const quoted = [];
      while (i < lines.length && !skip(i)) {
        if (!/^\s*>/.test(stripInlineCode(lines[i]))) break;
        const dq = stored(lines[i]).replace(/^\s*>\s?/, "").trim();
        if (dq) quoted.push(dq);
        i++;
      }
      if (quoted.length) units.push(tag({ kind: "text", text: quoted.join(" ") }));
      continue;
    }
    if (isListItem(line)) {
      flush();
      const items = [];
      while (i < lines.length && !skip(i)) {
        const rawL = lines[i];
        const l = stripInlineCode(rawL);
        const tt = l.trim();
        if (tt === "" || isHeadingOrRule(tt) || isTableSeparator(l) || isTableRow(l)) break;
        if (isListItem(l))
          items.push(
            stored(rawL).replace(/^\s*([-*+]|\d+\.)\s+/, "").trim()
          );
        else if (items.length) items[items.length - 1] += ` ${stored(rawL).trim()}`;
        else items.push(stored(rawL).trim());
        i++;
      }
      units.push(tag({ kind: "list", items }));
      continue;
    }
    prose.push(stored(raw));
    i++;
  }
  flush();
  return units;
}
function unitTexts(unit) {
  return unit.kind === "text" ? [unit.text] : unit.items;
}
function citationTokensIn(text, isCitation) {
  const masked = stripInlineCode(text);
  const out = [];
  for (const m of masked.matchAll(TOKEN_RE2)) {
    const tok = m[1].trim();
    if (isCitation(tok) && !out.includes(tok)) out.push(tok);
  }
  return out;
}
function bracketedTokensIn(text) {
  const masked = stripInlineCode(text);
  const out = [];
  for (const m of masked.matchAll(TOKEN_RE2)) {
    const tok = m[1].trim();
    if (!out.includes(tok)) out.push(tok);
  }
  return out;
}
function collectCitations(text, isCitation, opts = {}) {
  const grounding = [];
  for (const unit of extractClaimUnits(text, opts)) {
    for (const part of unitTexts(unit)) {
      for (const tok of citationTokensIn(part, isCitation)) if (!grounding.includes(tok)) grounding.push(tok);
    }
  }
  const all = [];
  for (const m of text.matchAll(TOKEN_RE2)) {
    const tok = m[1].trim();
    if (isCitation(tok) && !all.includes(tok)) all.push(tok);
  }
  return { grounding, inertOnly: all.filter((t) => !grounding.includes(t)) };
}
function danglingTokens(cited, known) {
  const have2 = new Set(known);
  const out = [];
  for (const t of cited) if (!have2.has(t) && !out.includes(t)) out.push(t);
  return out;
}
function uncitedIds(cited, known) {
  const used = new Set(cited);
  return [...new Set(known)].filter((id) => !used.has(id));
}
function normalizeNumeralText(text) {
  return text.replace(/(\d)[\u00A0\u202F'](?=\d)/g, "$1").replace(/(\d)[, ](\d{3})(?!\d)/g, "$1$2").replace(/(\d),(?=\d)/g, "$1.");
}
function extractNumerals(text, max = 8) {
  const cleaned = normalizeNumeralText(
    stripInlineCode(text).replace(/\[([^\]]+)\]\([^)]*\)/g, "$1").replace(/\[[^\]\n]+\](?!\()/g, " ")
  );
  const out = [];
  for (const m of cleaned.matchAll(/\d[\d,\u00A0\u202F']*(?:\.\d+)?%?/g)) {
    const numeric = normalizeNumeralText(m[0]).replace(/[,\u00A0\u202F'%]/g, "");
    if (numeric.replace(/\D/g, "").length < 2 && !numeric.includes(".")) continue;
    if (!out.includes(numeric)) out.push(numeric);
    if (out.length >= max) break;
  }
  return out;
}

// src/orchestrate.ts
import { existsSync as existsSync5 } from "fs";
import { join as join7, resolve as resolve2 } from "path";

// src/orchestrate/templates.ts
import { join as join6 } from "path";
var WORKFLOW_FORBIDDEN = ["Date.now(", "Math.random(", "new Date("];
function oneWriterFooter(runAbs, opts = {}) {
  const forbidden = opts.writingCommands?.length ? ` Do not run any engine command that writes (${opts.writingCommands.map((c) => `\`${c}\``).join(", ")}).` : "";
  return `
## Return, don't write (the one-writer rule)

Return ONLY the structured output specified above. Do NOT write, edit, or delete any file in the run folder.${forbidden} The orchestrator is the sole writer: it folds your returned fragments in serially and runs the gates itself.${opts.sanctioned ? `

One sanctioned exception: ${opts.sanctioned}` : ""}

Exception for oversized prose: if a note is too large to return, write ONLY to \`${join6(runAbs, "orchestration", "out")}/<role>-<batch>.md\` \u2014 a file namespaced to you alone \u2014 and return its path.
`;
}
function toBatches(ids, batchSize) {
  const width = Math.max(1, Math.floor(batchSize));
  const out = [];
  for (let i = 0; i < ids.length; i += width) out.push(ids.slice(i, i + width));
  return out;
}
function assertWorkflowSafe(script, phaseName) {
  for (const bad of WORKFLOW_FORBIDDEN) {
    if (script.includes(bad)) {
      throw new Error(
        `orchestrate: the emitted workflow for phase "${phaseName}" contains ${bad}) \u2014 it throws in the workflow harness, which must stay resumable. Inject the value as a constant at emit time instead.`
      );
    }
  }
}
function emitWorkflowScript(phase, emission, runAbs, engineAbs, smallWorklist, constants = {}) {
  const cli = brand().cli;
  const scriptPath = join6(runAbs, "orchestration", `${phase.name}.workflow.mjs`);
  const meta = { name: `${cli}-${phase.name}`, description: emission.description(phase.items), phases: [{ title: emission.title }] };
  const floor = emission.collapseFloor ? emission.collapseFloor(smallWorklist) : smallWorklist;
  const batches = phase.items <= floor ? [phase.ids] : toBatches(phase.ids, emission.batchSize);
  const hint = emission.applyHint(runAbs, engineAbs, phase);
  const script = [
    `export const meta = ${JSON.stringify(meta)}`,
    ``,
    `// NOT a plain Node script: launch it with the Workflow tool \u2014`,
    `// Workflow({ scriptPath: ${JSON.stringify(scriptPath)} }).`,
    `//`,
    `// Emitted by \`${cli} orchestrate\` from the CURRENT worklist. The worklist is the`,
    `// source of truth: if it changes, re-run \`${cli} orchestrate --phase ${phase.name}\``,
    `// before launching this.`,
    ``,
    `// Constants for THIS run, injected at emit time \u2014 the harness forbids reading`,
    `// the clock or a random source, so nothing here may compute them.`,
    `const RUN = ${JSON.stringify(runAbs)}`,
    `const ENGINE = ${JSON.stringify(engineAbs)}`,
    `const WORKLIST = ${JSON.stringify(phase.worklist)}`,
    `const AGENTS = RUN + '/orchestration/agents'`,
    `const BATCHES = ${JSON.stringify(batches)}`,
    `const SCHEMA = ${JSON.stringify(emission.schema)}`,
    // Run-specific data the caller wants pasted INTO the script rather than
    // read from disk by the subagent. A judge panel is the case that needs it:
    // each judge is handed the decision and its cited evidence verbatim,
    // precisely so it never has to open the run folder it is judging.
    ...Object.entries(constants).map(([name, value]) => `const ${name} = ${JSON.stringify(value)}`),
    ``,
    `function contract(role, extra) {`,
    `  return 'Read and follow the dispatch contract at ' + AGENTS + '/' + role + '.md VERBATIM.\\n'`,
    `    + 'Constants: RUN=' + RUN + '  ENGINE=' + ENGINE + '  WORKLIST=' + WORKLIST + '.\\n'`,
    `    + 'Invoke the engine only by its ABSOLUTE path: node ' + ENGINE + ' <cmd> \u2014 and stay within the contract write rules.'`,
    `    + (extra ? '\\n' + extra : '')`,
    `}`,
    ``,
    `log(${JSON.stringify(`${cli} ${phase.name}: ${phase.items} item(s) across `)} + BATCHES.length + ' agent(s)')`,
    ``,
    `phase(${JSON.stringify(emission.title)})`,
    `const results = await pipeline(BATCHES, (batch, _item, i) =>`,
    `  agent(contract(${JSON.stringify(emission.role)}, 'ITEMS=' + batch.join(',')), {`,
    `    label: ${JSON.stringify(`${phase.name}:`)} + (i + 1),`,
    `    phase: ${JSON.stringify(emission.title)},`,
    `    agentType: 'general-purpose',`,
    `    schema: SCHEMA,${emission.agentOpts ?? ""}`,
    `  }))`,
    ``,
    `// One-writer rule: this workflow only COLLECTS the subagents' fragments.`,
    `// The main agent runs the fold itself:`,
    ...hint.map((l) => `//   ${l}`),
    `return { phase: ${JSON.stringify(phase.name)}, worklist: WORKLIST, results: results.filter(Boolean) }`,
    ``
  ].join("\n");
  assertWorkflowSafe(script, phase.name);
  return script;
}
function runbookMd(phases, defs, runAbs, engineAbs, cli, preamble = []) {
  const lines = [`# ${cli} \u2014 orchestration runbook`, ``, `Run: \`${runAbs}\``, ``];
  if (preamble.length) lines.push(...preamble, ``);
  lines.push(
    `The subagents return fragments; **you** are the sole writer. Each phase below`,
    `either fans out through its \`*.workflow.mjs\` or runs sequentially here \u2014 the`,
    `fold at the end of a phase is yours either way.`,
    ``
  );
  phases.forEach((ph, i) => {
    const emission = defs[i];
    lines.push(`## ${ph.name}`, ``);
    if (!ph.ready) {
      lines.push(`Not ready \u2014 \`${ph.worklist}\` does not exist yet. Produce it first:`, ``, `    ${ph.prerequisite}`, ``);
      return;
    }
    lines.push(`${ph.items} item(s) in \`${ph.worklist}\`.`, ``);
    if (ph.items === 0) {
      lines.push(`Nothing to do for this phase.`, ``);
      return;
    }
    if (emission) {
      const batches = toBatches(ph.ids, emission.batchSize);
      lines.push(
        `Fan out: \`Workflow({ scriptPath: "${join6(runAbs, "orchestration", `${ph.name}.workflow.mjs`)}" })\``,
        `(${batches.length} agent(s) of at most ${emission.batchSize} item(s), contract \`agents/${emission.role}.md\`).`,
        ``,
        `Sequentially instead: play \`agents/${emission.role}.md\` yourself over ${shq(ph.ids.join(","))}.`,
        ``,
        `Then fold, as the sole writer:`,
        ``,
        ...emission.applyHint(runAbs, engineAbs, ph).map((l) => `    ${l}`),
        ``
      );
    }
  });
  return `${lines.join("\n")}
`;
}

// src/orchestrate.ts
var SMALL_WORKLIST = 3;
var BATCH_SIZE = 8;
function listPhases(runDir, engineAbs, defs) {
  const run = resolve2(runDir);
  return defs.map((def) => {
    const worklist = join7(run, def.worklist);
    const parsed = readJsonSafe(worklist);
    const ids = def.ids(parsed, run, engineAbs);
    const ready = ids !== void 0;
    return {
      name: def.name,
      ready,
      worklist,
      items: ids?.length ?? 0,
      ids: ids ?? [],
      prerequisite: def.prerequisite(run, engineAbs, parsed),
      ...ready ? { parsed } : {}
    };
  });
}
function orchestrateRun(runDir, engineAbs, defs, contracts, opts = {}) {
  const run = resolve2(runDir);
  if (!existsSync5(run)) {
    return { exitCode: 2, written: [], notices: [], errors: [`run dir not found: ${run}`], phases: [] };
  }
  const phases = listPhases(run, engineAbs, defs);
  const byName = new Map(defs.map((d) => [d.name, d]));
  const small = opts.smallWorklist ?? SMALL_WORKLIST;
  let selected = phases.filter((p) => p.ready);
  if (opts.phase !== void 0) {
    const ph = phases.find((p) => p.name === opts.phase);
    if (!ph) {
      return {
        exitCode: 2,
        written: [],
        notices: [],
        errors: [`unknown phase "${opts.phase}" \u2014 expected one of: ${defs.map((d) => d.name).join(", ")}.`],
        phases
      };
    }
    if (!ph.ready) {
      return {
        exitCode: 2,
        written: [],
        notices: [],
        errors: [`phase "${ph.name}" is not ready \u2014 its worklist ${ph.worklist} does not exist yet. Produce it first: ${ph.prerequisite}`],
        phases
      };
    }
    selected = [ph];
  }
  const orchDir = join7(run, "orchestration");
  const agentsDir = join7(orchDir, "agents");
  ensureDir(join7(orchDir, "out"));
  ensureDir(agentsDir);
  const written = [];
  const notices = [];
  for (const [name, content] of Object.entries(contracts(run, engineAbs, phases))) {
    written.push(writeArtifact(join7(agentsDir, `${name}.md`), content));
  }
  if (!opts.eco) {
    for (const ph of selected) {
      const def = byName.get(ph.name);
      if (!def) continue;
      if (ph.items === 0) {
        notices.push(`phase "${ph.name}": worklist is empty \u2014 nothing to orchestrate.`);
        continue;
      }
      const floor = def.collapseFloor ? def.collapseFloor(small) : small;
      if (ph.items <= floor) {
        notices.push(`phase "${ph.name}": only ${ph.items} item(s) \u2014 the sequential --eco path is equivalent and cheaper.`);
      }
      written.push(writeArtifact(join7(orchDir, `${ph.name}.workflow.mjs`), emitWorkflowScript(ph, def, run, engineAbs, small, opts.constants)));
    }
  }
  written.push(writeArtifact(join7(orchDir, "RUNBOOK.md"), runbookMd(phases, defs, run, engineAbs, brand().cli, opts.runbookPreamble)));
  return { exitCode: 0, written, notices, errors: [], phases };
}

// src/cli-kit.ts
import { basename as basename2 } from "path";
var EXIT_OK = 0;
var EXIT_FAILURE = 1;
var EXIT_USAGE = 2;
var UsageError = class extends Error {
  exitCode = EXIT_USAGE;
};
function parseArgs(argv, spec) {
  const commands = new Set(spec.commands);
  const valueFlags = new Set(spec.valueFlags);
  const boolFlags = new Set(spec.boolFlags);
  if (argv.length === 0) return { kind: "help" };
  if (isHelpWord(argv[0])) return { kind: "help" };
  if (isVersionWord(argv[0])) return { kind: "version" };
  const command = argv[0];
  if (!commands.has(command)) {
    throw new UsageError(`unknown command "${command}" \u2014 run --help for the supported commands`);
  }
  const values = {};
  const bools = /* @__PURE__ */ new Set();
  const positional = [];
  for (let i = 1; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--") {
      positional.push(...argv.slice(i + 1));
      break;
    }
    if (!arg.startsWith("--") && arg !== "-h" && arg !== "-v") {
      positional.push(arg);
      continue;
    }
    const eq = arg.indexOf("=");
    const key = eq !== -1 ? arg.slice(2, eq) : arg.slice(2);
    if (!boolFlags.has(key) && !valueFlags.has(key)) {
      if (isHelpWord(arg)) return { kind: "help" };
      if (isVersionWord(arg)) return { kind: "version" };
    }
    if (boolFlags.has(key)) {
      if (eq !== -1) throw new UsageError(`--${key} is a boolean flag and takes no value`);
      bools.add(key);
      continue;
    }
    if (!valueFlags.has(key)) {
      throw new UsageError(`unknown flag "--${key}" \u2014 run --help for the supported options`);
    }
    if (eq !== -1) {
      values[key] = arg.slice(eq + 1);
      continue;
    }
    const next = argv[i + 1];
    if (next === void 0 || next.startsWith("--")) {
      throw new UsageError(`missing value for --${key}`);
    }
    values[key] = next;
    i++;
  }
  return { kind: "command", command, positional, values, bools };
}
function isHelpWord(a) {
  return a === "--help" || a === "-h" || a === "help";
}
function isVersionWord(a) {
  return a === "--version" || a === "-v" || a === "version";
}
function argValue(p, name) {
  return p.values[name];
}
function argBool(p, name) {
  return p.bools.has(name);
}
function argInt(p, name) {
  const raw = p.values[name];
  if (raw === void 0) return void 0;
  const n = Number(raw);
  if (!Number.isFinite(n) || !Number.isInteger(n)) {
    throw new UsageError(`--${name} expects a whole number, got "${raw}"`);
  }
  return n;
}
function argList(p, name) {
  const raw = p.values[name];
  if (raw === void 0) return [];
  return raw.split(",").map((s) => s.trim()).filter(Boolean);
}
function argOneOf(p, name, allowed) {
  const raw = p.values[name];
  if (raw === void 0) return void 0;
  if (!allowed.includes(raw)) {
    throw new UsageError(`invalid --${name} "${raw}" \u2014 expected one of: ${allowed.join(", ")}`);
  }
  return raw;
}
function positionalText(p) {
  return p.positional.join(" ");
}
function jsonLine(value) {
  return `${JSON.stringify(value, null, 2)}
`;
}
function docFlagRegex() {
  return /(?<![a-z0-9-])--([a-z][a-z0-9-]*)/g;
}
function documentedFlags(text) {
  const seen = /* @__PURE__ */ new Set();
  for (const m of text.matchAll(docFlagRegex())) seen.add(m[1]);
  return [...seen];
}
function helpCoversFlag(help, flag) {
  return new RegExp(`--${escapeRegExp(flag)}(?![a-z0-9-])`).test(help);
}
function missingFromHelp(help, flags) {
  return [...flags].filter((f) => !helpCoversFlag(help, f));
}
function pipedEnum(line, flag) {
  const cleaned = line.replace(/`/g, "").replace(/\\\|/g, "|");
  const m = cleaned.match(new RegExp(`--${escapeRegExp(flag)}[^a-z|]*((?:[a-z][a-z0-9-]*\\s*\\|\\s*)+[a-z][a-z0-9-]*)`));
  return m ? m[1].split("|").map((s) => s.trim()) : null;
}
function isInvokedDirectly(argv1 = process.argv[1], cli = brand().cli) {
  if (!argv1) return false;
  return basename2(argv1).replace(/\.(mjs|cjs|js)$/, "") === cli;
}

// src/mcp/protocol.ts
var PROTOCOL_VERSIONS = ["2024-11-05", "2025-03-26", "2025-06-18", "2025-11-25"];
var LATEST_PROTOCOL = PROTOCOL_VERSIONS[PROTOCOL_VERSIONS.length - 1];
var ASSUMED_HTTP_PROTOCOL = "2025-03-26";
var ANNOTATIONS_SINCE = "2025-03-26";
var RICH_TOOLS_SINCE = "2025-06-18";
var DEFAULT_MAX_RESPONSE_BYTES = 1e6;
function isProtocolVersion(v) {
  return typeof v === "string" && PROTOCOL_VERSIONS.includes(v);
}
function negotiateProtocol(requested) {
  return isProtocolVersion(requested) ? requested : LATEST_PROTOCOL;
}
function validateArgs(schema, args) {
  for (const key of schema.required) {
    const v = args[key];
    if (v === void 0 || v === null || v === "") return `\`${key}\` is required`;
  }
  for (const [key, value] of Object.entries(args)) {
    if (value === void 0 || value === null) continue;
    const spec = schema.properties[key];
    if (!spec?.type) continue;
    const actual = Array.isArray(value) ? "array" : typeof value;
    if (spec.type === "number") {
      if (actual === "number") continue;
      if (actual === "string" && value.trim() !== "" && Number.isFinite(Number(value))) continue;
      return `\`${key}\` must be a number, got ${actual === "string" ? JSON.stringify(value) : actual}`;
    }
    if (spec.type === "array") {
      if (actual !== "array") return `\`${key}\` must be an array, got ${actual}`;
      const arr = value;
      if (spec.items?.type === "string" && !arr.every((x) => typeof x === "string")) {
        return `\`${key}\` must be an array of strings`;
      }
      if (spec.enum) {
        const bad = arr.find((x) => typeof x === "string" && !spec.enum.includes(x));
        if (bad !== void 0) return `\`${key}\` contains "${String(bad)}" \u2014 allowed: ${spec.enum.join(", ")}`;
      }
      continue;
    }
    if (actual !== spec.type) return `\`${key}\` must be a ${spec.type}, got ${actual}`;
    if (spec.enum && typeof value === "string" && !spec.enum.includes(value)) {
      return `\`${key}\` must be one of: ${spec.enum.join(", ")}`;
    }
  }
  return void 0;
}
function capResponse(text, tool, maxBytes, artifact, advice = {}) {
  const bytes = Buffer.byteLength(text, "utf8");
  if (bytes <= maxBytes) return text;
  return JSON.stringify(
    {
      truncated: true,
      tool,
      bytes,
      maxBytes,
      reason: "This response exceeds the configured limit and was withheld rather than sent as an unusable partial payload.",
      narrower: advice[tool] ?? "narrow the request and call again",
      ...artifact ? { artifact, artifactNote: "The full result is on disk here \u2014 read it directly if you need all of it." } : {}
    },
    null,
    2
  ) + "\n";
}
function structuredContentFor(text, capped, hasSchema) {
  if (capped || !hasSchema) return void 0;
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    return void 0;
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return void 0;
  return parsed;
}
var LOOPBACK_ORIGIN = /^https?:\/\/(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/i;
function isOriginAllowed(origin, allowed = []) {
  if (origin === void 0) return true;
  const o = origin.trim();
  if (o === "" || o === "null") return true;
  if (LOOPBACK_ORIGIN.test(o)) return true;
  return allowed.some((a) => a === "*" || a.toLowerCase() === o.toLowerCase());
}

// src/mcp/resources.ts
import { existsSync as existsSync6, readdirSync as readdirSync3, readFileSync as readFileSync5, realpathSync, statSync as statSync3 } from "fs";
import { basename as basename3, dirname as dirname2, join as join8, resolve as resolve3, sep } from "path";
import { fileURLToPath } from "url";
var skillName = () => brand().name;
var URI_SCHEME = "skill://";
function resolveSkillRoot(moduleDir) {
  const here = moduleDir ?? dirname2(fileURLToPath(import.meta.url));
  const name = brand().name;
  const candidates = [resolve3(here, ".."), resolve3(here, "..", "skills", name), resolve3(here, "..", "..", "skills", name)];
  return candidates.find((dir) => existsSync6(join8(dir, "SKILL.md")));
}
function listResources(moduleDir) {
  const root = resolveSkillRoot(moduleDir);
  if (!root) return [];
  const out = [describe(root, "SKILL.md", `${skillName()}: the skill`)];
  const refDir = join8(root, "references");
  if (!existsSync6(refDir)) return out;
  for (const file of readdirSync3(refDir).sort()) {
    if (!file.endsWith(".md")) continue;
    out.push(describe(root, join8("references", file), `${skillName()} reference: ${basename3(file, ".md")}`));
  }
  return out;
}
function readResource(uri, moduleDir) {
  if (!uri.startsWith(URI_SCHEME)) {
    throw new ResourceError(`unknown resource scheme in "${uri}" (expected ${URI_SCHEME}\u2026)`);
  }
  const root = resolveSkillRoot(moduleDir);
  if (!root) throw new ResourceError("no skill payload found next to this build \u2014 nothing to read");
  const rel = uri.slice(URI_SCHEME.length);
  if (!rel) throw new ResourceError("empty resource path");
  const target = resolve3(root, rel);
  const rootReal = realpathSync(root);
  let targetReal;
  try {
    targetReal = realpathSync(target);
  } catch {
    throw new ResourceError(`no such resource: ${uri}`);
  }
  if (targetReal !== rootReal && !targetReal.startsWith(rootReal + sep)) {
    throw new ResourceError(`resource path escapes the skill root: ${uri}`);
  }
  if (!statSync3(targetReal).isFile()) throw new ResourceError(`not a file: ${uri}`);
  return { uri, mimeType: "text/markdown", text: readFileSync5(targetReal, "utf8") };
}
var ResourceError = class extends Error {
};
function describe(root, rel, fallbackTitle) {
  const decl = {
    uri: `${URI_SCHEME}${rel.split(sep).join("/")}`,
    name: rel.split(sep).join("/"),
    title: fallbackTitle,
    mimeType: "text/markdown"
  };
  const summary = firstProse(join8(root, rel));
  if (summary) decl.description = summary;
  return decl;
}
function firstProse(file) {
  let text;
  try {
    text = readFileSync5(file, "utf8");
  } catch {
    return void 0;
  }
  const body = text.startsWith("---\n") ? text.slice(text.indexOf("\n---", 3) + 4) : text;
  for (const block of body.split(/\n\s*\n/)) {
    const line = block.trim();
    if (!line || line.startsWith("#") || line.startsWith(">") || line.startsWith("|") || line.startsWith("```")) continue;
    const flat = line.replace(/\s+/g, " ").replace(/[*`]/g, "");
    return flat.length > 300 ? `${flat.slice(0, 297)}\u2026` : flat;
  }
  return void 0;
}

// src/mcp/server.ts
var ToolError = class extends Error {
};
var PromptError = class extends Error {
};
var ERR_INVALID_REQUEST = -32600;
var ERR_METHOD_NOT_FOUND = -32601;
var ERR_INVALID_PARAMS = -32602;
var ERR_INTERNAL = -32603;
function createServer(adapter, opts = {}) {
  const serverInfo = { name: opts.serverName ?? brand().name, version: adapter.version };
  const maxBytes = opts.maxResponseBytes ?? DEFAULT_MAX_RESPONSE_BYTES;
  let protocol = LATEST_PROTOCOL;
  const cancelled = /* @__PURE__ */ new Set();
  const CANCELLED_MAX = 1024;
  const listTools = () => adapter.listTools(protocol);
  const prompts = () => adapter.prompts ?? [];
  async function handle(msg, send) {
    if (msg === null || typeof msg !== "object" || Array.isArray(msg)) {
      send({ jsonrpc: "2.0", id: null, error: { code: ERR_INVALID_REQUEST, message: "invalid request: expected a JSON-RPC object" } });
      return;
    }
    if (msg.id === void 0 || msg.id === null) {
      if (msg.method === "notifications/cancelled") {
        const target = msg.params?.requestId;
        if (typeof target === "string" || typeof target === "number") {
          if (cancelled.size >= CANCELLED_MAX) cancelled.delete(cancelled.values().next().value);
          cancelled.add(String(target));
        }
      }
      return;
    }
    const id = msg.id;
    const reply = (out) => {
      if (cancelled.delete(String(id))) return;
      send({ jsonrpc: "2.0", id, ...out });
    };
    try {
      switch (msg.method) {
        case "initialize": {
          protocol = negotiateProtocol(msg.params?.protocolVersion);
          reply({
            result: {
              protocolVersion: protocol,
              // Three primitives, because a skill is three things: the engine
              // (tools), the method (prompts) and the documentation the method
              // refers to (resources). A client given only the first has to
              // invent the other two.
              capabilities: {
                tools: { listChanged: false },
                resources: { subscribe: false, listChanged: false },
                prompts: { listChanged: false }
              },
              serverInfo
            }
          });
          return;
        }
        case "ping":
          reply({ result: {} });
          return;
        case "tools/list":
          reply({ result: { tools: listTools() } });
          return;
        case "tools/call":
          await handleToolCall(msg, reply);
          return;
        case "resources/list":
          reply({ result: { resources: listResources(opts.skillDir) } });
          return;
        case "resources/read": {
          const uri = typeof msg.params?.uri === "string" ? msg.params.uri : "";
          if (!uri) {
            reply({ error: { code: ERR_INVALID_PARAMS, message: "`uri` is required" } });
            return;
          }
          try {
            reply({ result: { contents: [readResource(uri, opts.skillDir)] } });
          } catch (e) {
            if (e instanceof ResourceError) reply({ error: { code: ERR_INVALID_PARAMS, message: e.message } });
            else reply({ error: { code: ERR_INTERNAL, message: errMessage(e) } });
          }
          return;
        }
        case "prompts/list":
          reply({ result: { prompts: prompts() } });
          return;
        case "prompts/get": {
          const name = typeof msg.params?.name === "string" ? msg.params.name : "";
          const args = msg.params?.arguments ?? {};
          try {
            if (!adapter.getPrompt) throw new PromptError(`unknown prompt: ${name || "(none given)"}`);
            reply({ result: adapter.getPrompt(name, args) });
          } catch (e) {
            if (e instanceof PromptError) reply({ error: { code: ERR_INVALID_PARAMS, message: e.message } });
            else reply({ error: { code: ERR_INTERNAL, message: errMessage(e) } });
          }
          return;
        }
        default:
          reply({ error: { code: ERR_METHOD_NOT_FOUND, message: `method not found: ${String(msg.method)}` } });
          return;
      }
    } catch (e) {
      reply({ error: { code: ERR_INTERNAL, message: errMessage(e) } });
    }
  }
  async function handleToolCall(msg, reply) {
    const params = msg.params ?? {};
    const name = typeof params.name === "string" ? params.name : "";
    const args = params.arguments ?? {};
    const decl = listTools().find((t) => t.name === name);
    if (!decl) {
      reply({ error: { code: ERR_INVALID_PARAMS, message: `unknown tool: ${name || "(none given)"}` } });
      return;
    }
    const invalid = validateArgs(decl.inputSchema, args);
    if (invalid) {
      reply({ error: { code: ERR_INVALID_PARAMS, message: invalid } });
      return;
    }
    try {
      const { text: raw, artifact } = await adapter.callTool(name, args);
      const text = capResponse(raw, name, maxBytes, artifact, adapter.capAdvice);
      const capped = text !== raw;
      const structured = protocol >= RICH_TOOLS_SINCE ? structuredContentFor(text, capped, decl.outputSchema !== void 0) : void 0;
      reply({ result: { content: [{ type: "text", text }], ...structured ? { structuredContent: structured } : {} } });
    } catch (e) {
      if (e instanceof ToolError) {
        reply({ result: { content: [{ type: "text", text: e.message }], isError: true } });
        return;
      }
      reply({ error: { code: ERR_INTERNAL, message: errMessage(e) } });
    }
  }
  return {
    handle,
    protocolVersion: () => protocol,
    setProtocolVersion: (v) => {
      protocol = v;
    },
    tools: listTools
  };
}
function errMessage(e) {
  return e instanceof Error ? e.message : String(e);
}

// src/mcp/stdio.ts
import { createInterface } from "readline";
var MAX_IN_FLIGHT = 4;
async function runStdioServer(adapter, opts = {}) {
  const input = opts.input ?? process.stdin;
  const output = opts.output ?? process.stdout;
  const emit = output.write.bind(output);
  let restore;
  if (!opts.captureStdout && output === process.stdout) {
    const original = process.stdout.write;
    process.stdout.write = ((chunk, ...rest) => process.stderr.write(chunk, ...rest));
    restore = () => {
      process.stdout.write = original;
    };
  }
  const server = createServer(adapter, opts);
  const send = (msg) => {
    emit(JSON.stringify(msg) + "\n");
  };
  const inFlight = /* @__PURE__ */ new Set();
  const track = (p) => {
    inFlight.add(p);
    void p.finally(() => inFlight.delete(p));
    return p;
  };
  const drainToLimit = async () => {
    while (inFlight.size >= MAX_IN_FLIGHT) await Promise.race(inFlight);
  };
  const rl = createInterface({ input, terminal: false });
  try {
    for await (const line of rl) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      let parsed;
      try {
        parsed = JSON.parse(trimmed);
      } catch {
        send({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "parse error" } });
        continue;
      }
      await drainToLimit();
      if (Array.isArray(parsed)) {
        track(
          (async () => {
            const out = [];
            await Promise.all(parsed.map((m) => server.handle(m, (r) => void out.push(r))));
            if (out.length) emit(JSON.stringify(out) + "\n");
          })().catch(reportInternal(send))
        );
        continue;
      }
      if (parsed === null || typeof parsed !== "object") {
        send({ jsonrpc: "2.0", id: null, error: { code: ERR_INVALID_REQUEST, message: "invalid request: expected a JSON-RPC object" } });
        continue;
      }
      track(server.handle(parsed, send).catch(reportInternal(send)));
    }
    await Promise.all(inFlight);
  } finally {
    rl.close();
    restore?.();
  }
}
function reportInternal(send) {
  return (e) => {
    send({ jsonrpc: "2.0", id: null, error: { code: -32603, message: e instanceof Error ? e.message : String(e) } });
  };
}

// src/mcp/http.ts
import { createServer as createHttpServer } from "http";
var MCP_PATH = "/mcp";
var MAX_BODY_BYTES = 4 * 1024 * 1024;
var CORS_HEADERS = "content-type, accept, mcp-protocol-version, mcp-session-id, authorization, last-event-id";
var LOOPBACK_BIND = /* @__PURE__ */ new Set(["127.0.0.1", "::1", "localhost"]);
function startHttpServer(adapter, opts = {}) {
  const bind = opts.bind ?? "127.0.0.1";
  if (!LOOPBACK_BIND.has(bind) && !opts.allowRemote) {
    return Promise.reject(
      new Error(
        `refusing to bind ${bind}: ${brand().name}'s MCP server fetches arbitrary URLs and reads local files. Pass --allow-remote if that is really what you want.`
      )
    );
  }
  const server = createHttpServer((req, res) => {
    void route(req, res, adapter, opts).catch((e) => {
      if (res.headersSent) {
        res.destroy();
        return;
      }
      sendJson(res, 500, { jsonrpc: "2.0", id: null, error: { code: -32603, message: e instanceof Error ? e.message : String(e) } });
    });
  });
  server.requestTimeout = 0;
  server.headersTimeout = 6e4;
  server.keepAliveTimeout = 12e4;
  return new Promise((resolve4, reject) => {
    server.once("error", reject);
    server.listen(opts.port ?? 0, bind, () => {
      server.removeListener("error", reject);
      const addr = server.address();
      const port = typeof addr === "object" && addr ? addr.port : opts.port ?? 0;
      const host = bind.includes(":") ? `[${bind}]` : bind;
      resolve4({
        server,
        port,
        url: `http://${host}:${port}${MCP_PATH}`,
        close: () => new Promise((done) => {
          server.closeAllConnections?.();
          server.close(() => done());
        })
      });
    });
  });
}
async function route(req, res, adapter, opts) {
  const path = (req.url ?? "").split("?")[0];
  const origin = header(req, "origin");
  if (!isOriginAllowed(origin, opts.allowOrigin)) {
    sendJson(res, 403, { error: "origin not allowed", origin });
    return;
  }
  if (req.method === "OPTIONS") {
    res.writeHead(204, {
      ...corsHeaders(origin),
      "access-control-allow-methods": "POST, GET, DELETE, OPTIONS",
      "access-control-allow-headers": CORS_HEADERS,
      "access-control-max-age": "86400"
    });
    res.end();
    return;
  }
  if (path !== MCP_PATH) {
    sendJson(res, 404, { error: `not found: ${path} (the MCP endpoint is ${MCP_PATH})` }, origin);
    return;
  }
  if (req.method === "GET" || req.method === "DELETE") {
    res.writeHead(405, { allow: "POST, OPTIONS", ...corsHeaders(origin) });
    res.end(JSON.stringify({ error: `${req.method} is not supported: this server is stateless and offers no server-initiated stream` }));
    return;
  }
  if (req.method !== "POST") {
    res.writeHead(405, { allow: "POST, OPTIONS", ...corsHeaders(origin) });
    res.end(JSON.stringify({ error: `${req.method} is not supported` }));
    return;
  }
  const contentType = (header(req, "content-type") ?? "").split(";")[0].trim().toLowerCase();
  if (contentType && contentType !== "application/json") {
    sendJson(res, 415, { error: `unsupported content-type "${contentType}" \u2014 send application/json` }, origin);
    return;
  }
  const accept = (header(req, "accept") ?? "").toLowerCase();
  if (accept && !/application\/json|text\/event-stream|\*\/\*/.test(accept)) {
    sendJson(res, 406, { error: "this endpoint replies with application/json" }, origin);
    return;
  }
  const declared = header(req, "mcp-protocol-version");
  if (declared !== void 0 && !isProtocolVersion(declared)) {
    sendJson(res, 400, { error: `unsupported MCP-Protocol-Version: ${declared}` }, origin);
    return;
  }
  const protocol = declared ?? ASSUMED_HTTP_PROTOCOL;
  let raw;
  try {
    raw = await readBody(req);
  } catch (e) {
    if (e.message === "too large") {
      sendJson(res, 413, { error: `request body exceeds ${MAX_BODY_BYTES} bytes` }, origin);
      return;
    }
    sendJson(res, 400, { error: `could not read request body: ${e.message}` }, origin);
    return;
  }
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    sendJson(res, 200, { jsonrpc: "2.0", id: null, error: { code: -32700, message: "parse error" } }, origin);
    return;
  }
  const mcp = createServer(adapter, opts);
  mcp.setProtocolVersion(protocol);
  const out = [];
  const collect = (m) => void out.push(m);
  const messages = Array.isArray(parsed) ? parsed : [parsed];
  for (const m of messages) await mcp.handle(m, collect);
  if (out.length === 0) {
    res.writeHead(202, corsHeaders(origin));
    res.end();
    return;
  }
  sendJson(res, 200, Array.isArray(parsed) ? out : out[0], origin);
}
function header(req, name) {
  const v = req.headers[name];
  return Array.isArray(v) ? v[0] : v;
}
function corsHeaders(origin) {
  return origin ? { "access-control-allow-origin": origin, vary: "origin" } : {};
}
function sendJson(res, status, body, origin, extra = {}) {
  const text = JSON.stringify(body);
  res.writeHead(status, {
    "content-type": "application/json",
    "content-length": String(Buffer.byteLength(text, "utf8")),
    ...corsHeaders(origin),
    ...extra
  });
  res.end(text);
}
var DRAIN_LIMIT = MAX_BODY_BYTES * 8;
function readBody(req) {
  return new Promise((resolve4, reject) => {
    const chunks = [];
    let size = 0;
    let over = false;
    const declared = Number(req.headers["content-length"]);
    if (Number.isFinite(declared) && declared > MAX_BODY_BYTES) over = true;
    req.on("data", (c) => {
      size += c.length;
      if (over) {
        if (size > DRAIN_LIMIT) {
          req.destroy();
          reject(new Error("too large"));
        }
        return;
      }
      if (size > MAX_BODY_BYTES) {
        over = true;
        chunks.length = 0;
        return;
      }
      chunks.push(c);
    });
    req.on("end", () => {
      if (over) reject(new Error("too large"));
      else resolve4(Buffer.concat(chunks).toString("utf8"));
    });
    req.on("error", reject);
    req.on("aborted", () => reject(new Error("client aborted the request")));
  });
}
export {
  ANNOTATIONS_SINCE,
  ANYDOC_SPEC,
  ASSUMED_HTTP_PROTOCOL,
  BATCH_SIZE,
  COMPOSE_YAML,
  DEAD_LINK_STATUS,
  DEFAULT_MAX_RESPONSE_BYTES,
  DOC_EXTENSIONS,
  DOC_EXTRACTORS,
  ENGINE_VERSION,
  ERR_INTERNAL,
  ERR_INVALID_PARAMS,
  ERR_INVALID_REQUEST,
  ERR_METHOD_NOT_FOUND,
  EVIDENCE_TOKEN,
  EXIT_FAILURE,
  EXIT_OK,
  EXIT_USAGE,
  FILE_LINE_TOKEN,
  FIRECRAWL_DEFAULT_BASE,
  FIRECRAWL_ENV,
  KEYLESS_ENGINES,
  LATEST_PROTOCOL,
  LOCAL_FILE_DOMAIN,
  PDF_EXTRACTORS,
  PDF_INSPECTOR_SPEC,
  PDF_URL_RE,
  PROTOCOL_VERSIONS,
  PromptError,
  RICH_TOOLS_SINCE,
  ResourceError,
  SEARXNG_DEFAULT_BASE,
  SEARXNG_SETTINGS_YAML,
  SERVICE_PROFILES,
  SMALL_WORKLIST,
  SOURCE_TOKEN,
  STACK_SERVICES,
  TOKEN_RE2 as TOKEN_RE,
  ToolError,
  UsageError,
  WORKFLOW_FORBIDDEN,
  accentPattern,
  acceptLanguageHeader,
  addressedIdCount,
  apiBase,
  apiPrefix,
  appendixMask,
  applyRelevanceFloor,
  argBool,
  argInt,
  argList,
  argOneOf,
  argValue,
  arxivIdFromUrl,
  assessExtractedText,
  assessPdfText,
  awaitHostSlot,
  backOffHost,
  baseLang,
  bestExcerpt,
  bm25MatchedTerms,
  bm25Score,
  bm25Tokenize,
  bracketedTokensIn,
  brand,
  browserUa,
  buildBm25Index,
  buildMatcher,
  cacheClean,
  cacheDir,
  cacheMode,
  cachePath,
  cacheStats,
  cachedFetchAndExtract,
  canonicalRepo,
  canonicalRepoRef,
  canonicalizeUrl,
  capExtract,
  capResponse,
  charsetFromContentType,
  charsetFromHtml,
  citationTokensIn,
  cleanInline,
  codeMask,
  collectCitations,
  configure,
  contactUa,
  contentCoverage,
  contentHash,
  cosine,
  crawlSite,
  createServer,
  danglingTokens,
  ddgRedirectTarget,
  ddgRegion,
  deaccent,
  decodeBody,
  decodeEntities,
  dedupeByUrl,
  dedupeNearDuplicates,
  defaultUa,
  deleteCollection,
  deriveCitableUrl,
  detectRateLimited,
  discoverFeeds,
  diversify,
  docFlagRegex,
  docFormatForContentType,
  docFormatForUrl,
  documentedFlags,
  doiFromUrl,
  domainOf,
  embed,
  embedModel,
  embedOne,
  embeddingsDisabled,
  emitWorkflowScript,
  enabledDocExtractors,
  enabledExtractors,
  ensureClone,
  ensureCollection,
  ensureComposeMaterialized,
  ensureDir,
  ensureHistoryDepth,
  env,
  envFlag,
  envInt,
  envName,
  escapeRegExp,
  excerptWindows,
  expandTokens,
  externalHosts,
  extractClaimUnits,
  extractDocument,
  extractJsonLd,
  extractMainHtml,
  extractMetaTags,
  extractNumerals,
  extractPdf,
  extractTables,
  fetchAndExtract,
  fetchFeed,
  fetchRobots,
  fetchSitemap,
  fingerprint,
  firecrawlBase,
  firecrawlIsExplicit,
  fnv1a64,
  focusedSnippet,
  foldTerm,
  forgeAuthHeaders,
  forgeKind,
  hammingDistance,
  hasChanged,
  have,
  headCommit,
  helpCoversFlag,
  hostDelayMs,
  htmlCanonicalUrl,
  htmlTitle,
  htmlToText,
  httpGet,
  httpJson,
  hybridSearch,
  isAllowed,
  isApiEndpoint,
  isCacheFresh,
  isCitableUrl,
  isInvokedDirectly,
  isKeylessEngine,
  isNoWrite,
  isOriginAllowed,
  isProtocolVersion,
  isStopword,
  jsonLine,
  keylessEngines,
  keywords,
  linksFrom,
  listPhases,
  listReleases,
  listResources,
  listTags,
  looksLikeFirecrawl,
  looksLikeJunkExtraction,
  looksLikePdfUrl,
  lookupPackage,
  mapGithubIssues,
  mapLimit,
  mapScrapeResponse,
  mapSearchResponse,
  markFirecrawlDown,
  markedQuoteMask,
  matcherFromTokens,
  metaDescriptionOf,
  missingFromHelp,
  nearestHeading,
  negotiateProtocol,
  normalize,
  normalizeDoi,
  normalizeNumeralText,
  normalizeRepoUrl,
  ocrBudgetLeft,
  ocrPdf,
  ocrTools,
  ollamaBase,
  oneWriterFooter,
  orMasks,
  orchestrateRun,
  originUrl,
  pageDelayMs,
  pageMetadata,
  parseArgs,
  parseDdgHtml,
  parseDdgLite,
  parseFeed,
  parseFileLine,
  parseMojeek,
  parseRetryAfter,
  parseRobots,
  parseSitemap,
  pdfToText,
  pipedEnum,
  politeDelayMs,
  positionalText,
  probeFirecrawl,
  probeOllama,
  probeQdrant,
  probeSearxng,
  pubmedAbstractUrl,
  qdrantBase,
  rankedKeywords,
  readCapped,
  readCappedBytes,
  readJsonSafe,
  readManifest,
  readResource,
  recencyScore,
  renderAsset,
  repoCacheRoot,
  repoFacts,
  rescueViaWayback,
  resetBrand,
  resetCacheMode,
  resetCanonicalRepoCache,
  resetDocLadderCache,
  resetFirecrawlProbeCache,
  resetHaveCache,
  resetHistoryDepthCache,
  resetHostSchedule,
  resetNoWrite,
  resetOcrBudget,
  resetOllamaProbe,
  resetPdfLadderCache,
  resetQdrantProbe,
  resetRobotsCache,
  resetRunLocks,
  resetSearxngProbeCache,
  resolvePackage,
  resolveProvider,
  resolveRegion,
  resolveRepo,
  resolveSkillRoot,
  revalidationHeaders,
  rrf,
  runId,
  runStdioServer,
  runWithInput,
  runbookMd,
  sameCommit,
  scrapeViaFirecrawl,
  search,
  searchIssues,
  searchVectors,
  searchViaFirecrawl,
  searchViaKeyless,
  searchViaSearxng,
  searxngBase,
  searxngIsExplicit,
  setCacheMode,
  setNoWrite,
  sh,
  shAsync,
  shq,
  simhash,
  skillName,
  sleep,
  slugify,
  stackControl,
  startHttpServer,
  stripConsentBoilerplate,
  stripHtmlComments,
  stripInlineCode,
  stripTags,
  structuredContentFor,
  subtokens,
  tableToMarkdown,
  takeArtifacts,
  throttleReason,
  toBatches,
  uncitedIds,
  unitTexts,
  upsert,
  urlDeclaresIdentity,
  validateArgs,
  withRunLock,
  writeArtifact,
  writeFileAtomic,
  writeManifest
};
