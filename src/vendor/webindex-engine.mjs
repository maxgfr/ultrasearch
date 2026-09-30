// src/version.ts
var ENGINE_VERSION = "1.26.1";

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
import { inflateRawSync, inflateSync } from "zlib";
var MAX_STREAM_BYTES = 32 * 1024 * 1024;
var MAX_TOTAL_BYTES = 128 * 1024 * 1024;
var DICT_WINDOW = 4096;
var WIN_ANSI_C1 = [
  8364,
  8226,
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
  8226,
  381,
  8226,
  8226,
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
  8226,
  382,
  376
];
var winAnsi = (c) => {
  const code = c.charCodeAt(0);
  return code === 127 ? "\u2022" : String.fromCharCode(WIN_ANSI_C1[code - 128]);
};
var ESCAPES = { n: "\n", r: "\r", t: "	", b: "\b", f: "\f", "(": "(", ")": ")", "\\": "\\" };
function decodePdfString(tok) {
  return tok.slice(1, -1).replace(/\\(?:([nrtbf()\\])|([0-7]{1,3})|(\r\n|\r|\n)|([\s\S]))/g, (_m, esc, oct, _eol, other) => {
    if (esc) return ESCAPES[esc];
    if (oct) return String.fromCharCode(parseInt(oct, 8) & 255);
    return other ?? "";
  });
}
function decodeHexString(tok) {
  const hex = tok.slice(1, -1).replace(/\s+/g, "");
  let out = "";
  for (let i = 0; i + 1 < hex.length; i += 2) out += String.fromCharCode(parseInt(hex.slice(i, i + 2), 16));
  if (hex.length % 2) out += String.fromCharCode(parseInt(hex[hex.length - 1] + "0", 16));
  return out;
}
function decodeString(tok) {
  const bytes = tok[0] === "<" ? decodeHexString(tok) : decodePdfString(tok);
  return bytes.replace(/[\x7f-\x9f]/g, winAnsi);
}
function decodeTJArray(items) {
  let out = "";
  for (const item of items) {
    if (typeof item === "string") out += decodeString(item);
    else if (item <= -100) out += " ";
  }
  return out;
}
var isWhite = (c) => c === 32 || c === 10 || c === 13 || c === 9 || c === 12 || c === 0;
var isDelimiter = (c) => c === 40 || c === 41 || c === 60 || c === 62 || c === 91 || c === 93 || c === 123 || c === 125 || c === 47 || c === 37;
var isHexDigit = (c) => c >= 48 && c <= 57 || c >= 65 && c <= 70 || c >= 97 && c <= 102;
var isNumberChar = (c) => c >= 48 && c <= 57 || c === 45 || c === 43 || c === 46;
var Lexer = class {
  constructor(s) {
    this.s = s;
  }
  s;
  // Cleared by the first literal string whose parentheses never balance: from
  // then on strings are read flat, which is what every string was before
  // nesting was supported, and costs no more than the next parenthesis.
  nested = true;
  // Cleared by the first array that runs to the end of the stream. Every later
  // `[` is scanned through the same segmentation and reaches the same end, so
  // scanning them would re-pay the whole stream each time.
  arrays = true;
  /** End (exclusive) of the literal string opening at `i`, or -1. */
  stringEnd(i) {
    const s = this.s;
    if (this.nested) {
      let depth = 0;
      for (let j = i; j < s.length; j++) {
        const c = s.charCodeAt(j);
        if (c === 92) j++;
        else if (c === 40) depth++;
        else if (c === 41 && --depth === 0) return j + 1;
      }
      this.nested = false;
    }
    for (let j = i + 1; j < s.length; j++) {
      const c = s.charCodeAt(j);
      if (c === 92) j++;
      else if (c === 41) return j + 1;
      else if (c === 40) return -1;
    }
    return -1;
  }
  /** End (exclusive) of the hex string opening at `i`, or -1. */
  hexEnd(i) {
    const s = this.s;
    for (let j = i + 1; j < s.length; j++) {
      const c = s.charCodeAt(j);
      if (c === 62) return j + 1;
      if (!isHexDigit(c) && !isWhite(c)) return -1;
    }
    return -1;
  }
  /**
   * The array opening at `i`: its strings and numbers, and where it ends.
   *
   * A `]` inside one of its strings does not close it. That detail is
   * load-bearing: `[(] and gated recurrent [)-250(7)]` truncated at the inner
   * `]` silently dropped the rest of the array — on a real paper, whole clauses
   * from the middle of sentences, leaving fluent, citable prose.
   */
  array(i) {
    if (!this.arrays) return void 0;
    const s = this.s;
    const items = [];
    for (let j = i + 1; j < s.length; ) {
      const c = s.charCodeAt(j);
      if (c === 93) return { end: j + 1, items };
      const end = c === 40 ? this.stringEnd(j) : c === 60 ? this.hexEnd(j) : -1;
      if (end > 0) {
        items.push(s.slice(j, end));
        j = end;
      } else if (isNumberChar(c)) {
        let e = j + 1;
        while (e < s.length && isNumberChar(s.charCodeAt(e))) e++;
        items.push(Number(s.slice(j, e)));
        j = e;
      } else j++;
    }
    this.arrays = false;
    return void 0;
  }
};
function inlineImageEnd(s, from) {
  for (let k = s.indexOf("EI", from); k >= 0; k = s.indexOf("EI", k + 1)) {
    const after = k + 2 >= s.length || isWhite(s.charCodeAt(k + 2)) || isDelimiter(s.charCodeAt(k + 2));
    if (isWhite(s.charCodeAt(k - 1)) && after) return k + 2;
  }
  return s.length;
}
function extractTextOps(s) {
  const lexer = new Lexer(s);
  let out = "";
  let operands = [];
  const take = () => {
    const last = operands[operands.length - 1];
    if (last === void 0) return "";
    return typeof last === "string" ? decodeString(last) : decodeTJArray(last);
  };
  let i = 0;
  while (i < s.length) {
    const c = s.charCodeAt(i);
    if (c === 40 || c === 60 && s.charCodeAt(i + 1) !== 60) {
      const end2 = c === 40 ? lexer.stringEnd(i) : lexer.hexEnd(i);
      if (end2 > 0) {
        operands.push(s.slice(i, end2));
        i = end2;
      } else i++;
      continue;
    }
    if (c === 91) {
      const arr = lexer.array(i);
      if (arr) {
        operands.push(arr.items);
        i = arr.end;
      } else i++;
      continue;
    }
    if (c === 37) {
      while (i < s.length && s.charCodeAt(i) !== 10 && s.charCodeAt(i) !== 13) i++;
      continue;
    }
    if (isWhite(c) || isDelimiter(c)) {
      i++;
      continue;
    }
    let end = i + 1;
    while (end < s.length && !isWhite(s.charCodeAt(end)) && !isDelimiter(s.charCodeAt(end))) end++;
    const word = s.slice(i, end);
    i = end;
    if (word === "Tj" || word === "TJ") out += take() + " ";
    else if (word === "'" || word === '"') out += "\n" + take() + " ";
    else if (word === "T*") out += "\n";
    else if (word === "ID") i = inlineImageEnd(s, i);
    else if (word !== "Td" && word !== "TD") continue;
    operands = [];
  }
  return out;
}
var TOO_BIG = /* @__PURE__ */ Symbol("too big");
function ascii85Decode(text, cap) {
  const out = Buffer.allocUnsafe(Math.min(cap, 4 * text.length));
  let n = 0;
  let group = 0;
  let count = 0;
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    if (c === 126) break;
    if (isWhite(c)) continue;
    if (c === 122 && count === 0) {
      if (n + 4 > cap) return TOO_BIG;
      out.writeUInt32BE(0, n);
      n += 4;
      continue;
    }
    if (c < 33 || c > 117) return void 0;
    group = group * 85 + (c - 33);
    if (++count === 5) {
      if (n + 4 > cap) return TOO_BIG;
      out.writeUInt32BE(group >>> 0, n);
      n += 4;
      group = 0;
      count = 0;
    }
  }
  if (count === 1) return void 0;
  if (count > 1) {
    for (let k = count; k < 5; k++) group = group * 85 + 84;
    if (n + count - 1 > cap) return TOO_BIG;
    for (let k = 0; k < count - 1; k++) out[n++] = group >>> 24 - 8 * k & 255;
  }
  return out.subarray(0, n);
}
function asciiHexDecode(text) {
  const end = text.indexOf(">");
  const hex = (end < 0 ? text : text.slice(0, end)).replace(/[^0-9A-Fa-f]/g, "");
  return Buffer.from(hex.length % 2 ? `${hex}0` : hex, "hex");
}
function inflateCapped(data, cap) {
  for (const inflate of [inflateSync, inflateRawSync]) {
    try {
      return inflate(data, { maxOutputLength: cap });
    } catch (e) {
      if (e.code === "ERR_BUFFER_TOO_LARGE") return TOO_BIG;
    }
  }
  return void 0;
}
function filtersOf(dict) {
  const m = /\/Filter\s*(\[[^\]]*\]|\/[^\s/<>[\]()]+)/.exec(dict);
  return m ? (m[1].match(/\/[^\s/<>[\]()]+/g) ?? []).map((f) => f.slice(1)) : void 0;
}
var NOT_TEXT_RE = /\/Subtype\s*\/Image\b|\/Length[123]\b/;
function* contentStreams(buf) {
  const s = buf.toString("latin1");
  const re = /(?<!end)stream\r?\n/g;
  let budget = MAX_TOTAL_BYTES;
  let previousEnd = 0;
  let m;
  while (budget > 0 && (m = re.exec(s))) {
    const start = m.index + m[0].length;
    const end = s.indexOf("endstream", start);
    if (end < 0) return;
    re.lastIndex = end + "endstream".length;
    const window = s.slice(Math.max(previousEnd, m.index - DICT_WINDOW), m.index);
    previousEnd = re.lastIndex;
    const dict = window.slice(window.lastIndexOf("obj") + 1);
    if (NOT_TEXT_RE.test(dict)) continue;
    let stop = end;
    if (s[stop - 1] === "\n") stop--;
    if (s[stop - 1] === "\r") stop--;
    let data = buf.subarray(start, stop);
    const filters = filtersOf(dict);
    if (filters) {
      for (const f of filters) {
        if (!data) break;
        const cap = Math.min(MAX_STREAM_BYTES, budget);
        let decoded;
        if (f === "ASCII85Decode" || f === "A85") decoded = ascii85Decode(data.toString("latin1"), cap);
        else if (f === "ASCIIHexDecode" || f === "AHx") decoded = asciiHexDecode(data.toString("latin1"));
        else if (f === "FlateDecode" || f === "Fl") decoded = inflateCapped(data, cap);
        if (decoded === TOO_BIG) budget -= cap;
        data = decoded instanceof Buffer ? decoded : void 0;
      }
    } else {
      const cap = Math.min(MAX_STREAM_BYTES, budget);
      if (/~>\s*$/.test(s.slice(Math.max(start, stop - 8), stop))) {
        const decoded = ascii85Decode(data.toString("latin1"), cap);
        if (decoded === TOO_BIG) {
          budget -= cap;
          continue;
        }
        data = decoded ?? data;
      }
      const inflated = inflateCapped(data, cap);
      if (inflated === TOO_BIG) {
        budget -= cap;
        data = void 0;
      } else if (inflated) data = inflated;
    }
    if (!data) continue;
    budget -= data.length;
    yield data.toString("latin1");
  }
}
function pdfToText(buf) {
  let out = "";
  try {
    for (const stream of contentStreams(buf)) {
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
  if (c >= 9 && c <= 13) return false;
  return c < 32 || c >= 127 && c <= 159;
}
var REPLACEMENT_CODE = 65533;
var SPACE_RE = /\s/;
var isSpace = (c) => c < 128 ? c === 32 || c >= 9 && c <= 13 : SPACE_RE.test(String.fromCharCode(c));
var LETTER_RE = /[\p{L}\p{N}]/u;
var isRuleChar = (c) => c === 95 || c === 45 || c === 46 || c === 61;
function scanShape(t) {
  let control = 0;
  let replacement = 0;
  let letters = 0;
  let nonSpace = 0;
  let run = 0;
  let runIsRule = true;
  let longestRun2 = 0;
  const endRun = () => {
    if (!runIsRule && run > longestRun2) longestRun2 = run;
    run = 0;
    runIsRule = true;
  };
  for (let i = 0; i < t.length; i++) {
    const c = t.charCodeAt(i);
    if (isSpace(c)) {
      endRun();
      continue;
    }
    if (c === REPLACEMENT_CODE) replacement++;
    else if (isControlCode(c)) control++;
    if (!isRuleChar(c)) runIsRule = false;
    if (c < 128) {
      if (c >= 48 && c <= 57 || (c | 32) >= 97 && (c | 32) <= 122) letters++;
      nonSpace++;
      run++;
      continue;
    }
    const cp = t.codePointAt(i);
    const units = cp > 65535 ? 2 : 1;
    if (LETTER_RE.test(String.fromCodePoint(cp))) letters++;
    nonSpace += units;
    run += units;
    i += units - 1;
  }
  endRun();
  return { control: control / t.length, replacement: replacement / t.length, longestRun: longestRun2, letterRatio: nonSpace ? letters / nonSpace : 0 };
}
var NO_TEXT_LAYER = "no text layer (scanned or image-only PDF?)";
function assessPdfText(text) {
  return assessExtractedText(text, NO_TEXT_LAYER);
}
function assessExtractedText(text, emptyReason) {
  const t = text.trim();
  if (!t) return { ok: false, reason: emptyReason };
  const shape = scanShape(t);
  if (shape.control > CONTROL_RATIO_MAX) {
    return { ok: false, reason: "binary/control characters in the text (undecodable PDF stream)" };
  }
  if (shape.replacement > REPLACEMENT_RATIO_MAX) {
    return { ok: false, reason: "replacement characters throughout (wrong character map)" };
  }
  if (t.length < MIN_CHARS_FOR_SHAPE_CHECKS) return { ok: true };
  if (shape.longestRun > LONGEST_RUN_MAX && shape.letterRatio < LETTER_RATIO_MIN) {
    return { ok: false, reason: "unreadable text layer (garbled glyph encoding)" };
  }
  return { ok: true };
}

// src/pdf/ocr.ts
import { mkdtempSync, readFileSync as readFileSync2, rmSync, writeFileSync, existsSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";

// src/pdf/exec.ts
import { spawn as spawn2 } from "child_process";

// src/process-tree.ts
import { spawn, spawnSync } from "child_process";
import { readdirSync, readFileSync } from "fs";
function addChild(tree, parent, child) {
  const siblings = tree.get(parent);
  if (siblings) siblings.push(child);
  else tree.set(parent, [child]);
}
function treeFromProc() {
  let entries;
  try {
    entries = readdirSync("/proc");
  } catch {
    return void 0;
  }
  const tree = /* @__PURE__ */ new Map();
  for (const entry of entries) {
    if (!/^\d+$/.test(entry)) continue;
    let stat;
    try {
      stat = readFileSync(`/proc/${entry}/stat`, "latin1");
    } catch {
      continue;
    }
    const ppid = Number(stat.slice(stat.lastIndexOf(")") + 2).split(" ")[1]);
    if (ppid > 0) addChild(tree, ppid, Number(entry));
  }
  return tree;
}
function treeFromPs() {
  const r = spawnSync("ps", ["-A", "-o", "pid=,ppid="], { encoding: "utf8", timeout: 5e3 });
  if (r.status !== 0 || !r.stdout) return void 0;
  const tree = /* @__PURE__ */ new Map();
  for (const line of r.stdout.split("\n")) {
    const [pid, ppid] = line.trim().split(/\s+/).map(Number);
    if (pid && ppid) addChild(tree, ppid, pid);
  }
  return tree;
}
function descendants(pid) {
  const tree = (process.platform === "linux" ? treeFromProc() : void 0) ?? treeFromPs();
  if (!tree) return [];
  const found = /* @__PURE__ */ new Set();
  const queue = [pid];
  while (queue.length) {
    for (const child of tree.get(queue.shift()) ?? []) {
      if (found.has(child) || child === pid) continue;
      found.add(child);
      queue.push(child);
    }
  }
  return [...found];
}
function killTree(child) {
  try {
    if (process.platform === "win32" && child.pid) {
      spawn("taskkill", ["/pid", String(child.pid), "/T", "/F"], { stdio: "ignore", windowsHide: true }).on("error", () => child.kill("SIGKILL"));
    } else {
      const pids = child.pid ? descendants(child.pid) : [];
      child.kill("SIGKILL");
      for (const pid of pids) {
        try {
          process.kill(pid, "SIGKILL");
        } catch {
        }
      }
    }
  } catch {
    child.kill("SIGKILL");
  }
  child.stdin?.destroy();
  child.stdout?.destroy();
  child.stderr?.destroy();
  child.unref();
}

// src/pdf/exec.ts
var PDF_INSPECTOR_SPEC = "@firecrawl/pdf-inspector@1";
var ANYDOC_SPEC = "@firecrawl/anydoc@0.1";
var MAX_STDOUT_BYTES = 24 * 1024 * 1024;
var STDERR_END_CHARS = 1024;
function binaryName(name) {
  return process.platform === "win32" && name === "npx" ? "npx.cmd" : name;
}
function runWithInput(cmd, args, input, timeoutMs, opts = {}) {
  return new Promise((resolve7) => {
    let child;
    try {
      const bin = binaryName(cmd);
      const viaShell = process.platform === "win32" && /\.(?:cmd|bat)$/i.test(bin);
      const quote = (s) => `"${s.replace(/"/g, '""')}"`;
      const common = { stdio: ["pipe", "pipe", "pipe"], ...opts.env ? { env: opts.env } : {} };
      child = viaShell ? spawn2([bin, ...args].map(quote).join(" "), { ...common, shell: true, windowsHide: true }) : spawn2(bin, args, common);
    } catch (e) {
      resolve7({ ok: false, stdout: "", error: e.message });
      return;
    }
    const chunks = [];
    let size = 0;
    let stderrHead = "";
    let stderrTail = "";
    let stderrCut = false;
    const withStderr = (r) => {
      const stderr = (stderrCut ? `${stderrHead}
\u2026
${stderrTail}` : stderrHead + stderrTail).trim();
      return stderr ? { ...r, stderr } : r;
    };
    let settled = false;
    const done = (r) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve7(r);
    };
    const timer = setTimeout(() => {
      killTree(child);
      done(withStderr({ ok: false, stdout: "", error: `timed out after ${Math.round(timeoutMs / 1e3)}s` }));
    }, timeoutMs);
    child.stdout?.on("data", (d) => {
      if (size >= MAX_STDOUT_BYTES) return;
      size += d.length;
      chunks.push(d);
    });
    child.stderr?.setEncoding("utf8");
    child.stderr?.on("data", (chunk) => {
      let rest = chunk;
      if (stderrHead.length < STDERR_END_CHARS) {
        const room = STDERR_END_CHARS - stderrHead.length;
        stderrHead += rest.slice(0, room);
        rest = rest.slice(room);
      }
      const tail = stderrTail + rest;
      if (tail.length > STDERR_END_CHARS) stderrCut = true;
      stderrTail = tail.slice(-STDERR_END_CHARS);
    });
    child.on("error", (e) => {
      done({ ok: false, stdout: "", error: e.code === "ENOENT" ? "not installed" : e.message });
    });
    child.on("close", (code, signal) => {
      const stdout = Buffer.concat(chunks).subarray(0, MAX_STDOUT_BYTES).toString("utf8");
      if (code === 0) done({ ok: true, stdout });
      else done(withStderr({ ok: false, stdout, error: code === null ? `killed by ${signal}` : `exit ${code}` }));
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
  if (!toolsProbe) {
    toolsProbe = (async () => {
      const probe = async (cmd, args) => (await runWithInput(cmd, args, Buffer.alloc(0), 2e4)).ok;
      const [copyablePdf, tesseract] = await Promise.all([probe("copyable-pdf", ["--help"]), probe("tesseract", ["--version"])]);
      return { copyablePdf, tesseract };
    })();
  }
  return toolsProbe;
}
var toolsProbe;
function resetOcrTools() {
  toolsProbe = void 0;
}
async function ocrPdf(bytes) {
  const r = await ocrAttempt(bytes);
  return "text" in r ? r.text : void 0;
}
async function ocrAttempt(bytes) {
  if (ocrBudgetLeft() <= 0) return { declined: "budget" };
  const { copyablePdf, tesseract } = await ocrTools();
  if (!copyablePdf || !tesseract) return { declined: "tools" };
  if (ocrBudgetLeft() <= 0) return { declined: "budget" };
  spent++;
  const dir = mkdtempSync(join(tmpdir(), `${brand().name}-ocr-`));
  try {
    const input = join(dir, "in.pdf");
    const output = join(dir, "out.pdf");
    writeFileSync(input, bytes);
    const lang = env("OCR_LANG") || DEFAULT_LANG;
    const r = await runWithInput("copyable-pdf", ["-o", output, "-m", "-l", lang, input], Buffer.alloc(0), envInt("OCR_TIMEOUT_MS", DEFAULT_TIMEOUT_MS));
    if (r.error === "not installed") {
      spent = Math.max(0, spent - 1);
      return { declined: "tools" };
    }
    if (!r.ok) return { failed: true };
    const md = output.replace(/\.pdf$/, ".md");
    return existsSync(md) ? { text: readFileSync2(md, "utf8") } : { failed: true };
  } catch {
    return { failed: true };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// src/pdf/npx.ts
import { isAbsolute } from "path";
function npxTimeoutMs() {
  return envInt("NPX_TIMEOUT_MS", 9e4, 1e3, 6e5);
}
var FAIL_FAST = {
  npm_config_fetch_retries: "1",
  npm_config_fetch_retry_mintimeout: "1000",
  npm_config_fetch_retry_maxtimeout: "2000",
  npm_config_fetch_timeout: "30000"
};
function npxEnv() {
  const env2 = { ...process.env };
  for (const [key, value] of Object.entries(FAIL_FAST)) {
    if (env2[key] === void 0 && env2[key.toUpperCase()] === void 0) env2[key] = value;
  }
  return env2;
}
var NPM_ERROR_RE = /^npm (?:ERR!|error) code (\S+)/m;
var NETWORK_CODES = /* @__PURE__ */ new Set([
  "ECONNREFUSED",
  "ECONNRESET",
  "ENOTFOUND",
  "EAI_AGAIN",
  "ETIMEDOUT",
  "ESOCKETTIMEDOUT",
  "EHOSTUNREACH",
  "ENETUNREACH",
  "ENOTCACHED",
  "ERR_SOCKET_TIMEOUT"
]);
var proven = /* @__PURE__ */ new Set();
var registryDown;
function resetNpxState() {
  proven.clear();
  registryDown = void 0;
  installed.clear();
}
function unavailability(r, spec) {
  if (r.error === "not installed" || r.error === "exit 127") return "not installed";
  const stderr = r.stderr ?? "";
  const code = NPM_ERROR_RE.exec(stderr)?.[1];
  if (code) {
    if (!NETWORK_CODES.has(code)) return `could not be installed (npm error ${code})`;
    registryDown = code;
    return `could not be installed (npm error ${code} \u2014 offline?)`;
  }
  if (/could not determine executable to run/.test(stderr)) return "could not be installed (npm found no executable)";
  if (!proven.has(spec) && r.error?.startsWith("timed out")) return `${r.error} on first use (raise ${envName("NPX_TIMEOUT_MS")} on a slow network)`;
  return void 0;
}
function npxBinName(spec) {
  return spec.replace(/^@[^/]+\//, "").replace(/@.*$/, "");
}
var installed = /* @__PURE__ */ new Map();
function findInstalled(spec) {
  let hit = installed.get(spec);
  if (!hit) {
    hit = (async () => {
      if (process.platform === "win32") return {};
      const probe = ["-y", "--prefer-offline", "--package", spec, "-c", `command -v ${npxBinName(spec)}`];
      const r = await runWithInput("npx", probe, Buffer.alloc(0), npxTimeoutMs(), { env: npxEnv() });
      if (!r.ok) {
        const why = unavailability(r, spec);
        return why ? { unavailable: { ...r, unavailable: why } } : {};
      }
      const path = r.stdout.trim().split("\n").pop()?.trim();
      return path && isAbsolute(path) ? { path } : {};
    })();
    installed.set(spec, hit);
  }
  return hit;
}
async function runNpx(spec, args, input) {
  if (registryDown && !proven.has(spec) && !installed.has(spec)) {
    const why2 = `could not be installed (npm error ${registryDown} \u2014 offline?)`;
    return { ok: false, stdout: "", error: why2, unavailable: why2 };
  }
  const found = await findInstalled(spec);
  if (found.unavailable) return found.unavailable;
  if (found.path) {
    const run = await runWithInput(found.path, args, input, npxTimeoutMs());
    if (run.ok) proven.add(spec);
    if (run.error !== "not installed") return run;
    installed.delete(spec);
  }
  const r = await runWithInput("npx", ["-y", "--prefer-offline", spec, ...args], input, npxTimeoutMs(), { env: npxEnv() });
  if (r.ok) {
    proven.add(spec);
    return r;
  }
  const why = unavailability(r, spec);
  return why ? { ...r, unavailable: why } : r;
}
function skipNpxHint() {
  return `set ${envName("NO_NPX")}=1 to skip the rungs that install through npx`;
}
var NOISE_RE = /^(?:npm (?:warn|WARN|notice)\b|\(node:\d+\)|\(Use `node --|\^+$|at\s|Node\.js v\d)/;
var THROW_SITE_RE = /^(?:file:\/\/|\/|[A-Za-z]:\\)\S*:\d+$/;
var ERROR_LINE_RE = /^\w*error\b/i;
var PATH_RE = /(?<![\w:/.\\])(?:file:\/\/\/?(?:[A-Za-z]:)?|[A-Za-z]:(?=\\))?(?:[/\\][^\s/\\:'"()]+)+/g;
function failureDetail(tool, r) {
  const lines = [];
  let source2 = false;
  let props = false;
  for (const raw of (r.stderr ?? "").split(/\r?\n/)) {
    const l = raw.trim();
    if (source2) source2 = false;
    else if (props) props = l !== "}";
    else if (THROW_SITE_RE.test(l)) source2 = true;
    else if (l.startsWith("at ") && l.endsWith("{")) props = true;
    else if (l && !NOISE_RE.test(l)) lines.push(l);
  }
  const line = lines.find((l) => ERROR_LINE_RE.test(l)) ?? lines[0];
  const detail = (line ?? r.error ?? "failed").replace(PATH_RE, (p) => p.slice(Math.max(p.lastIndexOf("/"), p.lastIndexOf("\\")) + 1)).slice(0, 200);
  return detail.startsWith(`${tool}:`) ? detail : `${tool}: ${detail}`;
}

// src/pdf/ladder.ts
var PDF_EXTRACTORS = ["pdf-inspector", "anydoc", "firecrawl", "pdftotext", "native", "ocr"];
var PDFTOTEXT_TIMEOUT_MS = 6e4;
var dead = /* @__PURE__ */ new Map();
function resetPdfLadderCache() {
  dead.clear();
  resetNpxState();
  resetOcrBudget();
  resetOcrTools();
}
var warnedEngineValues = /* @__PURE__ */ new Set();
function enginesFromEnv(name, known) {
  const raw = env(name)?.trim();
  if (!raw) return void 0;
  const asked = raw.toLowerCase().split(",").map((s) => s.trim()).filter(Boolean);
  if (asked.length === 1 && asked[0] === "none") return [];
  const picked = [...new Set(asked.filter((s) => known.includes(s)))];
  const unknown = asked.filter((s) => !known.includes(s));
  if (unknown.length && !warnedEngineValues.has(`${name}=${raw}`)) {
    warnedEngineValues.add(`${name}=${raw}`);
    const fallback = picked.length ? "" : " \u2014 using the full ladder";
    process.emitWarning(`${envName(name)}: ignoring unknown rung ${unknown.map((u) => `"${u}"`).join(", ")} (known: ${known.join(", ")}, or none)${fallback}`);
  }
  return picked.length ? picked : void 0;
}
function enabledExtractors(engines) {
  if (engines) return engines;
  const chosen = enginesFromEnv("PDF_ENGINE", PDF_EXTRACTORS);
  if (chosen) return chosen;
  if (envFlag("NO_NPX")) return PDF_EXTRACTORS.filter((e) => e !== "pdf-inspector" && e !== "anydoc");
  return PDF_EXTRACTORS;
}
async function viaNpx(id, spec, args, bytes) {
  const r = await runNpx(spec, args, bytes);
  if (r.ok) return { text: r.stdout };
  if (r.unavailable === "not installed") return { unavailable: true };
  if (r.unavailable) return { unavailable: true, failure: `${id} ${r.unavailable}`, hint: skipNpxHint() };
  return { failure: failureDetail(id, r) };
}
async function viaPdftotext(bytes) {
  const r = await runWithInput("pdftotext", ["-layout", "-", "-"], bytes, PDFTOTEXT_TIMEOUT_MS);
  if (r.ok) return { text: r.stdout.replace(/\f/g, "\n\n") };
  return r.error === "not installed" ? { unavailable: true } : { failure: failureDetail("pdftotext", r) };
}
async function viaOcr(bytes) {
  const r = await ocrAttempt(bytes);
  if ("text" in r) return { text: r.text };
  if ("declined" in r) return r.declined === "tools" ? { unavailable: true } : { budgetSpent: true };
  return { failure: "ocr: the conversion failed on this document" };
}
async function runRung(id, bytes, opts) {
  try {
    if (id === "pdf-inspector") return await viaNpx(id, PDF_INSPECTOR_SPEC, ["-"], bytes);
    if (id === "anydoc") return await viaNpx(id, ANYDOC_SPEC, ["-", "--format", "pdf"], bytes);
    if (id === "pdftotext") return await viaPdftotext(bytes);
    if (id === "ocr") return await viaOcr(bytes);
    if (id === "firecrawl") {
      const text = opts.firecrawl ? await opts.firecrawl() : void 0;
      return text === void 0 ? {} : { text };
    }
    return { text: pdfToText(bytes) };
  } catch {
    return {};
  }
}
async function extractPdf(bytes, opts = {}) {
  if (!bytes.subarray(0, 1024).includes("%PDF-")) {
    return { text: "", reason: "not a PDF (no %PDF- header \u2014 an error page or a login wall?)" };
  }
  let lastReason;
  const failures = [];
  const hints = /* @__PURE__ */ new Set();
  let ocrMissing = false;
  const noteFailure = (id, got) => {
    if (id === "ocr" && got.unavailable) ocrMissing = true;
    else if (got.failure) failures.push(got.failure);
    if (got.hint) hints.add(got.hint);
  };
  const budgetSpent = `scanned PDF, and this run's OCR budget is spent (raise ${envName("OCR_MAX")})`;
  for (const id of enabledExtractors(opts.engines)) {
    const known = dead.get(id);
    if (known) {
      noteFailure(id, known);
      continue;
    }
    if (id === "ocr" && ocrBudgetLeft() <= 0) {
      lastReason = budgetSpent;
      continue;
    }
    const got = await runRung(id, bytes, opts);
    if (got.text === void 0) {
      if (got.budgetSpent) {
        lastReason = budgetSpent;
        continue;
      }
      if (got.unavailable) dead.set(id, got);
      noteFailure(id, got);
      continue;
    }
    const verdict = assessPdfText(got.text);
    if (verdict.ok) return { text: got.text.trim(), via: id };
    lastReason = verdict.reason;
  }
  if (lastReason === NO_TEXT_LAYER) {
    if (bytes.includes("/Encrypt")) lastReason = "encrypted PDF (no rung here could decrypt its text)";
    else if (ocrMissing) lastReason = `${NO_TEXT_LAYER} \u2014 install copyable-pdf and tesseract to OCR it`;
  }
  const reason = [...new Set([lastReason, ...failures, ...hints].filter(Boolean))].join("; ");
  return { text: "", reason: reason || "no PDF extractor available" };
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
var PDF_HEADER_RE = /(?:^|[\r\n])%PDF-\d/;
var OLE_SIGNATURE = Buffer.from([208, 207, 17, 224, 161, 177, 26, 225]);
function sniffDocument(bytes) {
  const head = bytes.subarray(0, 1024).toString("latin1");
  if (PDF_HEADER_RE.test(head)) return "pdf";
  if (bytes.subarray(0, 8).equals(OLE_SIGNATURE)) return BINARY;
  if (head.startsWith("{\\rtf")) return BINARY;
  if (head.startsWith("PK") && (head.startsWith("mimetype", 30) || bytes.includes("[Content_Types].xml"))) return BINARY;
  return void 0;
}

// src/doc/office.ts
import { inflateRawSync as inflateRawSync2 } from "zlib";
var MAX_ENTRIES = 1e4;
var MAX_ENTRY_BYTES = 64 * 1024 * 1024;
var MAX_TOTAL_BYTES2 = 256 * 1024 * 1024;
var MAX_OUTPUT_CHARS = 24 * 1024 * 1024;
var MAX_COLUMNS = 256;
var MAX_REPEAT = 1e3;
var Refused = class extends Error {
};
var Zip = class {
  constructor(buf, entries) {
    this.buf = buf;
    this.entries = entries;
  }
  buf;
  entries;
  inflated = 0;
  has(name) {
    return this.entries.has(name);
  }
  /** An entry's bytes, or undefined when there is no such entry. Throws Refused on anything it will not read. */
  read(name) {
    const e = this.entries.get(name);
    if (!e) return void 0;
    if (e.flags & 1) throw new Refused("encrypted ZIP entries");
    if (e.compressedSize === 4294967295 || e.size === 4294967295 || e.localHeader === 4294967295) throw new Refused("ZIP64 archives are not supported");
    const buf = this.buf;
    const lh = e.localHeader;
    if (lh + 30 > buf.length || buf.readUInt32LE(lh) !== 67324752) throw new Refused("truncated or corrupt ZIP archive");
    const start = lh + 30 + buf.readUInt16LE(lh + 26) + buf.readUInt16LE(lh + 28);
    const end = start + e.compressedSize;
    if (end > buf.length) throw new Refused("truncated or corrupt ZIP archive");
    const cap = Math.min(MAX_ENTRY_BYTES, MAX_TOTAL_BYTES2 - this.inflated);
    const tooLarge = () => new Refused(
      cap < MAX_ENTRY_BYTES ? `the archive inflates past ${MAX_TOTAL_BYTES2 >> 20} MB` : `an entry inflates past ${MAX_ENTRY_BYTES >> 20} MB (a decompression bomb?)`
    );
    if (cap <= 0) throw tooLarge();
    let out;
    if (e.method === 0) {
      if (e.compressedSize > cap) throw tooLarge();
      out = buf.subarray(start, end);
    } else if (e.method === 8) {
      try {
        out = inflateRawSync2(buf.subarray(start, end), { maxOutputLength: cap });
      } catch (err) {
        throw err.code === "ERR_BUFFER_TOO_LARGE" ? tooLarge() : new Refused("truncated or corrupt ZIP archive");
      }
    } else {
      throw new Refused(`unsupported ZIP compression method ${e.method}`);
    }
    this.inflated += out.length;
    return out;
  }
  /** An XML part as text: UTF-8, or UTF-16LE when it says so with a BOM. */
  text(name) {
    const b = this.read(name);
    if (!b) return void 0;
    if (b[0] === 255 && b[1] === 254) return b.subarray(2).toString("utf16le");
    const s = b.toString("utf8");
    return s.charCodeAt(0) === 65279 ? s.slice(1) : s;
  }
};
function openZip(buf) {
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 22 - 65535); i--) {
    if (buf.readUInt32LE(i) === 101010256) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0)
    throw new Refused(buf.subarray(0, 4).toString("latin1") === "PK" ? "truncated or corrupt ZIP archive" : "not an OOXML or OpenDocument file");
  if (eocd >= 20 && buf.readUInt32LE(eocd - 20) === 117853008) throw new Refused("ZIP64 archives are not supported");
  const count = buf.readUInt16LE(eocd + 10);
  const dirSize = buf.readUInt32LE(eocd + 12);
  const dirOffset = buf.readUInt32LE(eocd + 16);
  if (count === 65535 || dirSize === 4294967295 || dirOffset === 4294967295) throw new Refused("ZIP64 archives are not supported");
  if (count > MAX_ENTRIES) throw new Refused(`more than ${MAX_ENTRIES} ZIP entries`);
  if (dirOffset + dirSize > eocd) throw new Refused("truncated or corrupt ZIP archive");
  const entries = /* @__PURE__ */ new Map();
  let p = dirOffset;
  for (let n = 0; n < count; n++) {
    if (p + 46 > eocd || buf.readUInt32LE(p) !== 33639248) throw new Refused("truncated or corrupt ZIP archive");
    const nameLength = buf.readUInt16LE(p + 28);
    const next = p + 46 + nameLength + buf.readUInt16LE(p + 30) + buf.readUInt16LE(p + 32);
    if (next > eocd) throw new Refused("truncated or corrupt ZIP archive");
    entries.set(buf.toString("utf8", p + 46, p + 46 + nameLength), {
      flags: buf.readUInt16LE(p + 8),
      method: buf.readUInt16LE(p + 10),
      compressedSize: buf.readUInt32LE(p + 20),
      size: buf.readUInt32LE(p + 24),
      localHeader: buf.readUInt32LE(p + 42)
    });
    p = next;
  }
  return new Zip(buf, entries);
}
var Budget = class {
  left = MAX_OUTPUT_CHARS;
  rulesLeft = MAX_OUTPUT_CHARS;
  /** Spend `n` characters: false, and nothing spent, once they no longer fit — the caller drops them. */
  take(n) {
    if (n > this.left) {
      this.left = 0;
      return false;
    }
    this.left -= n;
    return true;
  }
  /** The same, for `n` characters of table rules. */
  takeRules(n) {
    if (n > this.rulesLeft) {
      this.rulesLeft = 0;
      return false;
    }
    this.rulesLeft -= n;
    return true;
  }
  get spent() {
    return this.left <= 0 || this.rulesLeft <= 0;
  }
};
var ENTITIES = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'" };
function decodeXml(s) {
  if (!s.includes("&")) return s;
  return s.replace(/&(?:#x([0-9a-fA-F]{1,6})|#([0-9]{1,7})|([a-zA-Z]{2,4}));/g, (m, hex, dec, name) => {
    if (name) return ENTITIES[name] ?? m;
    const cp = hex ? parseInt(hex, 16) : Number(dec);
    return cp > 0 && cp <= 1114111 ? String.fromCodePoint(cp) : m;
  });
}
var local = (name) => name.slice(name.indexOf(":") + 1);
function walkXml(xml, v) {
  let i = 0;
  while (i < xml.length) {
    const lt = xml.indexOf("<", i);
    const textEnd = lt < 0 ? xml.length : lt;
    if (textEnd > i && v.text) v.text(decodeXml(xml.slice(i, textEnd)));
    if (lt < 0) return;
    if (xml.startsWith("<!--", lt)) {
      const end = xml.indexOf("-->", lt + 4);
      if (end < 0) return;
      i = end + 3;
      continue;
    }
    if (xml.startsWith("<![CDATA[", lt)) {
      const end = xml.indexOf("]]>", lt + 9);
      if (end < 0) return;
      v.text?.(xml.slice(lt + 9, end));
      i = end + 3;
      continue;
    }
    const gt = xml.indexOf(">", lt + 1);
    if (gt < 0) return;
    i = gt + 1;
    const first = xml.charCodeAt(lt + 1);
    if (first === 63 || first === 33) continue;
    if (first === 47) {
      v.close?.(xml.slice(lt + 2, gt).trim());
      continue;
    }
    const selfClosing = xml.charCodeAt(gt - 1) === 47;
    const body = xml.slice(lt + 1, selfClosing ? gt - 1 : gt);
    const space = body.search(/\s/);
    const name = space < 0 ? body : body.slice(0, space);
    v.open?.(name, space < 0 ? "" : body.slice(space));
    if (selfClosing) v.close?.(name);
  }
}
var attrPatterns = /* @__PURE__ */ new Map();
function attr(attrs, name) {
  let re = attrPatterns.get(name);
  if (!re) {
    const key = name.startsWith("*:") ? `[\\w.-]+:${name.slice(2)}` : name.replace(/[.]/g, "\\.");
    re = new RegExp(`(?:^|\\s)${key}\\s*=\\s*(?:"([^"]*)"|'([^']*)')`);
    attrPatterns.set(name, re);
  }
  const m = re.exec(attrs);
  return m ? decodeXml(m[1] ?? m[2] ?? "") : void 0;
}
var cell = (s) => s.replace(/\s+/g, " ").trim().replace(/\|/g, "\\|");
function blankRow(row, width) {
  for (let c = 0; c < row.length && c < width; c++) if (row[c]?.trim()) return false;
  return true;
}
function keepRow(table, row) {
  const blank = blankRow(row, row.length);
  if (!blank || !table.blank) table.rows.push(row);
  table.blank = blank;
}
function markdownTable(rows, budget) {
  let last = rows.length;
  while (last > 0 && rows[last - 1].every((c) => !c.trim())) last--;
  let width = 0;
  for (let r = 0; r < last; r++) {
    const row = rows[r];
    for (let c = Math.min(row.length, MAX_COLUMNS) - 1; c >= width; c--) {
      if (row[c]?.trim()) {
        width = c + 1;
        break;
      }
    }
  }
  if (!last || !width) return "";
  const rules = 3 * width + 2;
  const rule = `|${" --- |".repeat(width)}`;
  if (!budget.takeRules(rules + rule.length + 1)) return "";
  const line = (row) => `| ${Array.from({ length: width }, (_, c) => cell(row[c] ?? "")).join(" | ")} |`;
  const out = [line(rows[0]), rule];
  let blank = false;
  for (let r = 1; r < last; r++) {
    const row = rows[r];
    const empty = blankRow(row, width);
    if (empty && blank) continue;
    blank = empty;
    if (!budget.takeRules(rules)) break;
    out.push(line(row));
  }
  return out.join("\n");
}
function joinBlocks(blocks) {
  const out = [];
  for (const [i, block] of blocks.entries()) {
    if (i) out.push(block.startsWith("- ") && blocks[i - 1].startsWith("- ") ? "\n" : "\n\n");
    out.push(block);
  }
  return out.join("");
}
function relationships(zip, part) {
  const slash = part.lastIndexOf("/");
  const dir = part.slice(0, slash + 1);
  const rels = /* @__PURE__ */ new Map();
  const xml = zip.text(`${dir}_rels/${part.slice(slash + 1)}.rels`);
  if (!xml) return rels;
  walkXml(xml, {
    open(name, attrs) {
      if (local(name) !== "Relationship" || attr(attrs, "TargetMode") === "External") return;
      const id = attr(attrs, "Id");
      const target = attr(attrs, "Target");
      if (id && target) rels.set(id, { target: resolvePart(dir, target), type: attr(attrs, "Type") ?? "" });
    }
  });
  return rels;
}
function relatedPart(rels, type) {
  for (const r of rels.values()) if (r.type.endsWith(`/${type}`)) return r.target;
  return void 0;
}
function resolvePart(dir, target) {
  const segments = [];
  for (const s of (target.startsWith("/") ? target.slice(1) : dir + target).split("/")) {
    if (s === "..") segments.pop();
    else if (s && s !== ".") segments.push(s);
  }
  return segments.join("/");
}
var HEADING_STYLE_RE = /^(?:heading|titre|berschrift|überschrift|kop|titolo|encabezado|ttulo|título)\s?([1-6])$/i;
var TITLE_STYLE_RE = /^(?:title|titel|titre|titolo|ttulo|título)$/i;
var LIST_STYLE_RE = /^list ?(?:bullet|number)/i;
function stylePrefix(name, outline) {
  const level = HEADING_STYLE_RE.exec(name)?.[1] ?? (outline !== void 0 && outline >= 0 && outline < 6 ? String(outline + 1) : void 0);
  if (level) return `${"#".repeat(Number(level))} `;
  if (TITLE_STYLE_RE.test(name)) return "# ";
  if (LIST_STYLE_RE.test(name)) return "- ";
  return void 0;
}
function wordStyles(xml) {
  if (!xml) return void 0;
  const styles = /* @__PURE__ */ new Map();
  let current2;
  walkXml(xml, {
    open(name, attrs) {
      const n = local(name);
      if (n === "style") {
        const id = attr(attrs, "w:styleId");
        current2 = id && attr(attrs, "w:type") === "paragraph" ? { name: "" } : void 0;
        if (current2) styles.set(id, current2);
      } else if (!current2) return;
      else if (n === "name") current2.name = attr(attrs, "w:val") ?? "";
      else if (n === "basedOn") current2.basedOn = attr(attrs, "w:val");
      else if (n === "outlineLvl") current2.outline = Number(attr(attrs, "w:val"));
    },
    close(name) {
      if (local(name) === "style") current2 = void 0;
    }
  });
  const prefixes = /* @__PURE__ */ new Map();
  for (const [id, own] of styles) {
    let style = own;
    for (let depth = 0; style && depth < 16; depth++) {
      const prefix = stylePrefix(style.name, style.outline);
      if (prefix !== void 0) {
        prefixes.set(id, prefix);
        break;
      }
      style = style.basedOn ? styles.get(style.basedOn) : void 0;
    }
    if (!prefixes.has(id)) prefixes.set(id, "");
  }
  return prefixes;
}
function wordText(xml, budget, styles) {
  const blocks = [];
  const paragraphs = [];
  const tables = [];
  let inText = 0;
  let fallback = 0;
  let tabStops = 0;
  let moved = 0;
  const add = (p, s) => {
    if (p && !moved && budget.take(s.length)) p.text += s;
  };
  const emit = (block) => {
    const table = tables[tables.length - 1];
    if (table?.cell) table.cell.push(block);
    else if (block.trim()) blocks.push(block);
  };
  walkXml(xml, {
    open(name, attrs) {
      const n = local(name);
      if (n === "Fallback") fallback++;
      else if (n === "tabs") tabStops++;
      if (fallback) return;
      const p = paragraphs[paragraphs.length - 1];
      const table = tables[tables.length - 1];
      if (n === "moveFrom") moved++;
      else if (n === "p") paragraphs.push({ text: "", prefix: "" });
      else if (n === "t") inText++;
      else if (n === "tab" && !tabStops) add(p, "	");
      else if (n === "br" || n === "cr") add(p, "\n");
      else if (n === "noBreakHyphen") add(p, "-");
      else if (n === "pStyle" && p) {
        const id = attr(attrs, "w:val") ?? "";
        const prefix = styles?.has(id) ? styles.get(id) : stylePrefix(id);
        if (prefix) p.prefix = prefix;
      } else if (n === "numPr" && p && !p.prefix) p.prefix = "- ";
      else if (n === "tbl") tables.push({ rows: [] });
      else if (n === "tr" && table) table.row = [];
      else if (n === "tc" && table) table.cell = [];
    },
    close(name) {
      const n = local(name);
      if (n === "Fallback") {
        fallback = Math.max(0, fallback - 1);
        return;
      }
      if (n === "tabs") tabStops = Math.max(0, tabStops - 1);
      if (fallback) return;
      const table = tables[tables.length - 1];
      if (n === "moveFrom") moved = Math.max(0, moved - 1);
      else if (n === "t") inText = Math.max(0, inText - 1);
      else if (n === "p") {
        const p = paragraphs.pop();
        if (p?.text.trim()) emit(table?.cell ? p.text.trim() : p.prefix ? p.prefix + p.text.trim() : p.text.trimEnd());
      } else if (n === "tc" && table?.row && table.cell) {
        table.row.push(table.cell.join(" "));
        table.cell = void 0;
      } else if (n === "tr" && table?.row) {
        keepRow(table, table.row);
        table.row = void 0;
      } else if (n === "tbl") {
        const done = tables.pop();
        if (done) emit(tables.length ? done.rows.map((r) => r.join(" ")).join(" ") : markdownTable(done.rows, budget));
      }
    },
    text(s) {
      if (!fallback && inText) add(paragraphs[paragraphs.length - 1], s);
    }
  });
  return joinBlocks(blocks);
}
function sharedStrings(xml) {
  const strings = [];
  if (!xml) return strings;
  let current2;
  let inText = 0;
  let phonetic = 0;
  walkXml(xml, {
    open(name) {
      const n = local(name);
      if (n === "si") current2 = "";
      else if (n === "t") inText++;
      else if (n === "rPh") phonetic++;
    },
    close(name) {
      const n = local(name);
      if (n === "si" && current2 !== void 0) {
        strings.push(current2);
        current2 = void 0;
      } else if (n === "t") inText = Math.max(0, inText - 1);
      else if (n === "rPh") phonetic = Math.max(0, phonetic - 1);
    },
    text(s) {
      if (current2 !== void 0 && inText && !phonetic) current2 += s;
    }
  });
  return strings;
}
function columnOf(ref) {
  const letters = ref && /^[A-Za-z]{1,3}/.exec(ref)?.[0];
  if (!letters) return void 0;
  let col = 0;
  for (const ch of letters.toUpperCase()) col = col * 26 + (ch.charCodeAt(0) - 64);
  return col - 1;
}
var BUILTIN_TEMPORAL = {
  14: "date",
  15: "date",
  16: "date",
  17: "date",
  18: "time",
  19: "time",
  20: "time",
  21: "time",
  22: "datetime",
  45: "time",
  47: "time"
};
function temporalOf(code) {
  if (code.length > 255 || /\[[hms]+\]/i.test(code)) return void 0;
  const bare = code.replace(/"[^"]*"|[\\_*].|\[[^[\]]*\]|General|E[+-]/gi, "");
  const time = /[hs]/i.test(bare);
  const date = /[yd]/i.test(bare) || !time && /m/i.test(bare);
  return date && time ? "datetime" : date ? "date" : time ? "time" : void 0;
}
function cellTemporals(xml) {
  const kinds = [];
  if (!xml) return kinds;
  const custom = /* @__PURE__ */ new Map();
  let cellXfs = false;
  walkXml(xml, {
    open(name, attrs) {
      const n = local(name);
      if (n === "numFmt") custom.set(Number(attr(attrs, "numFmtId")), temporalOf(attr(attrs, "formatCode") ?? ""));
      else if (n === "cellXfs") cellXfs = true;
      else if (n === "xf" && cellXfs) {
        const id = Number(attr(attrs, "numFmtId") ?? 0);
        kinds.push(custom.has(id) ? custom.get(id) : BUILTIN_TEMPORAL[id]);
      }
    },
    close(name) {
      if (local(name) === "cellXfs") cellXfs = false;
    }
  });
  return kinds;
}
var DAY_MS = 864e5;
var EXCEL_EPOCH = Date.UTC(1899, 11, 30);
function serialDate(serial, kind, date1904) {
  const days = date1904 ? serial + 1462 : serial < 60 ? serial + 1 : serial;
  if (!(serial >= 0 && days <= 2958466)) return void 0;
  const iso = new Date(Math.round((EXCEL_EPOCH + days * DAY_MS) / 1e3) * 1e3).toISOString();
  const time = iso.slice(11, iso.endsWith(":00.000Z") ? 16 : 19);
  return kind === "date" ? iso.slice(0, 10) : kind === "time" ? time : `${iso.slice(0, 10)} ${time}`;
}
function sheetRows(xml, shared, styles, budget) {
  const table = { rows: [] };
  let row;
  let col = 0;
  let type;
  let style = 0;
  let value;
  let collecting = 0;
  walkXml(xml, {
    open(name, attrs) {
      const n = local(name);
      if (n === "row") row = [];
      else if (n === "c" && row) {
        col = columnOf(attr(attrs, "r")) ?? row.length;
        type = attr(attrs, "t");
        style = Number(attr(attrs, "s") ?? 0);
        value = "";
      } else if ((n === "v" || n === "t") && value !== void 0) collecting++;
    },
    close(name) {
      const n = local(name);
      if ((n === "v" || n === "t") && collecting) collecting--;
      else if (n === "c" && row && value !== void 0) {
        let shown = value;
        const kind = styles.temporal[style];
        if (type === "s") shown = shared[Number(value)] ?? "";
        else if (type === "b") shown = value === "1" ? "TRUE" : "FALSE";
        else if (kind && (type === void 0 || type === "n") && value.trim()) shown = serialDate(Number(value), kind, styles.date1904) ?? value;
        if (col < MAX_COLUMNS && shown && budget.take(shown.length)) {
          while (row.length < col) row.push("");
          row[col] = shown;
        }
        value = void 0;
      } else if (n === "row" && row) {
        keepRow(table, row);
        row = void 0;
      }
    },
    text(s) {
      if (collecting && value !== void 0 && value.length < MAX_OUTPUT_CHARS) value += s;
    }
  });
  return table.rows;
}
function spreadsheetText(zip, workbookPart, budget) {
  const rels = relationships(zip, workbookPart);
  const stringsPart = relatedPart(rels, "sharedStrings");
  const shared = sharedStrings(stringsPart ? zip.text(stringsPart) : void 0);
  const stylesPart = relatedPart(rels, "styles");
  const styles = { temporal: cellTemporals(stylesPart ? zip.text(stylesPart) : void 0), date1904: false };
  const sheets = [];
  walkXml(zip.text(workbookPart) ?? "", {
    open(name, attrs) {
      const n = local(name);
      const id = attr(attrs, "*:id");
      if (n === "sheet" && id) sheets.push({ name: attr(attrs, "name") ?? `Sheet ${sheets.length + 1}`, id });
      else if (n === "workbookPr") styles.date1904 = /^(?:1|true)$/i.test(attr(attrs, "date1904") ?? "");
    }
  });
  const blocks = [];
  for (const sheet of sheets) {
    if (budget.spent) break;
    const part = rels.get(sheet.id)?.target;
    const xml = part ? zip.text(part) : void 0;
    const table = xml ? markdownTable(sheetRows(xml, shared, styles, budget), budget) : "";
    if (table) blocks.push(`## ${sheet.name}

${table}`);
  }
  return blocks.join("\n\n");
}
function drawingText(xml, budget, onlyBody = false) {
  const lines = [];
  const titles = [];
  const shapes = [];
  const tables = [];
  let para;
  let inText = 0;
  let fallback = 0;
  const add = (s) => {
    if (para !== void 0 && budget.take(s.length)) para += s;
  };
  const emit = (line) => {
    const table = tables[tables.length - 1];
    if (table?.cell) table.cell.push(line);
    else if (shapes.length) shapes[shapes.length - 1].lines.push(line);
    else if (!onlyBody) lines.push(line);
  };
  walkXml(xml, {
    open(name, attrs) {
      const n = local(name);
      if (n === "Fallback") fallback++;
      if (fallback) return;
      const table = tables[tables.length - 1];
      if (n === "sp") shapes.push({ kind: "other", lines: [] });
      else if (n === "ph" && shapes.length) {
        const type = attr(attrs, "type");
        shapes[shapes.length - 1].kind = type === "title" || type === "ctrTitle" ? "title" : type === "body" ? "body" : "other";
      } else if (n === "p" && name.startsWith("a:")) para = "";
      else if (n === "t") inText++;
      else if (n === "br") add("\n");
      else if (name === "a:tbl") tables.push({ rows: [] });
      else if (name === "a:tr" && table) table.row = [];
      else if (name === "a:tc" && table?.row) table.cell = [];
    },
    close(name) {
      const n = local(name);
      if (n === "Fallback") {
        fallback = Math.max(0, fallback - 1);
        return;
      }
      if (fallback) return;
      const table = tables[tables.length - 1];
      if (n === "t") inText = Math.max(0, inText - 1);
      else if (n === "p" && name.startsWith("a:") && para !== void 0) {
        const line = para.trim();
        para = void 0;
        if (line) emit(line);
      } else if (name === "a:tc" && table?.row && table.cell) {
        table.row.push(table.cell.join(" "));
        table.cell = void 0;
      } else if (name === "a:tr" && table?.row) {
        keepRow(table, table.row);
        table.row = void 0;
      } else if (name === "a:tbl") {
        const done = tables.pop();
        if (done) emit(tables.length ? done.rows.map((r) => r.join(" ")).join(" ") : `
${markdownTable(done.rows, budget)}
`);
      } else if (n === "sp") {
        const shape = shapes.pop();
        if (!shape) return;
        if (shape.kind === "title" && !onlyBody) titles.push(shape.lines.join(" "));
        else if (!onlyBody || shape.kind === "body") lines.push(...shape.lines);
      }
    },
    text(s) {
      if (!fallback && inText) add(s);
    }
  });
  return { title: titles.join(" ").trim(), text: lines.join("\n").trim() };
}
function presentationText(zip, presentationPart, budget) {
  const rels = relationships(zip, presentationPart);
  const order = [];
  walkXml(zip.text(presentationPart) ?? "", {
    open(name, attrs) {
      const target = local(name) === "sldId" ? rels.get(attr(attrs, "*:id") ?? "")?.target : void 0;
      if (target) order.push(target);
    }
  });
  const blocks = [];
  for (const [i, part] of order.entries()) {
    if (budget.spent) break;
    const slide = drawingText(zip.text(part) ?? "", budget);
    const notesPart = relatedPart(relationships(zip, part), "notesSlide");
    const notes = notesPart ? drawingText(zip.text(notesPart) ?? "", budget, true).text : "";
    const heading = `## Slide ${i + 1}${slide.title ? `: ${slide.title}` : ""}`;
    if (slide.title || slide.text || notes) blocks.push(`${heading}${slide.text ? `

${slide.text}` : ""}${notes ? `

Notes: ${notes}` : ""}`);
  }
  return blocks.join("\n\n");
}
var ODF_ASIDES = /* @__PURE__ */ new Set(["text:note", "office:annotation", "text:tracked-changes"]);
function openDocumentText(xml, budget) {
  const blocks = [];
  const paragraphs = [];
  const tables = [];
  let skip = 0;
  let listItem = false;
  let spreadsheet = false;
  let slide = 0;
  let heading = -1;
  let titleFrame = 0;
  let inNotes = 0;
  const title = [];
  const notes = [];
  const add = (p, s) => {
    if (p && budget.take(s.length)) p.text += s;
  };
  const emit = (block) => {
    const table = tables[tables.length - 1];
    if (table?.cell) table.cell.push(block);
    else if (titleFrame) title.push(block);
    else if (inNotes) notes.push(block);
    else if (block.trim()) blocks.push(block);
  };
  const repeat = (attrs, name) => Math.min(MAX_REPEAT, Math.max(1, Number(attr(attrs, name)) || 1));
  walkXml(xml, {
    open(name, attrs) {
      if (ODF_ASIDES.has(name)) skip++;
      if (skip) return;
      const p = paragraphs[paragraphs.length - 1];
      const table = tables[tables.length - 1];
      if (name === "text:p" || name === "text:h") {
        const level = name === "text:h" ? Math.min(6, Number(attr(attrs, "text:outline-level")) || 1) : 0;
        paragraphs.push({ text: "", prefix: level ? `${"#".repeat(level)} ` : listItem && !table ? "- " : "" });
        listItem = false;
      } else if (name === "text:list-item") listItem = true;
      else if (name === "text:s") add(p, " ".repeat(Math.min(100, Number(attr(attrs, "text:c")) || 1)));
      else if (name === "text:tab") add(p, "	");
      else if (name === "text:line-break") add(p, "\n");
      else if (name === "office:spreadsheet") spreadsheet = true;
      else if (name === "draw:page") {
        heading = blocks.push(`## Slide ${++slide}`) - 1;
        title.length = 0;
        notes.length = 0;
      } else if (name === "presentation:notes") inNotes++;
      else if (name === "draw:frame" && (titleFrame || attr(attrs, "presentation:class") === "title")) titleFrame++;
      else if (name === "table:table") {
        const sheet = attr(attrs, "table:name");
        const heading2 = sheet && spreadsheet && !tables.length ? blocks.push(`## ${sheet}`) - 1 : void 0;
        tables.push({ rows: [], repeatRow: 1, repeatCell: 1, ...heading2 !== void 0 ? { heading: heading2 } : {} });
      } else if (name === "table:table-row" && table) {
        table.row = [];
        table.repeatRow = repeat(attrs, "table:number-rows-repeated");
      } else if ((name === "table:table-cell" || name === "table:covered-table-cell") && table?.row) {
        table.cell = [];
        table.repeatCell = repeat(attrs, "table:number-columns-repeated");
      }
    },
    close(name) {
      if (ODF_ASIDES.has(name)) {
        skip = Math.max(0, skip - 1);
        return;
      }
      if (skip) return;
      const table = tables[tables.length - 1];
      if (name === "text:p" || name === "text:h") {
        const p = paragraphs.pop();
        if (p?.text.trim()) emit(table?.cell ? p.text.trim() : p.prefix + p.text.trim());
      } else if ((name === "table:table-cell" || name === "table:covered-table-cell") && table?.row && table.cell) {
        const text = table.cell.join(" ");
        for (let k = 0; k < table.repeatCell && table.row.length < MAX_COLUMNS; k++) {
          if (k && text && !budget.take(text.length)) break;
          table.row.push(text);
        }
        table.cell = void 0;
      } else if (name === "table:table-row" && table?.row) {
        const size = table.row.reduce((n, c) => n + c.length, 0);
        const times = size ? table.repeatRow : 1;
        for (let k = 0; k < times; k++) {
          if (k && !budget.take(size)) break;
          keepRow(table, table.row);
        }
        table.row = void 0;
      } else if (name === "table:table") {
        const done = tables.pop();
        if (done) emit(tables.length ? done.rows.map((r) => r.join(" ")).join(" ") : markdownTable(done.rows, budget));
        if (done?.heading !== void 0 && blocks.length === done.heading + 1) blocks.length = done.heading;
      } else if (name === "draw:frame" && titleFrame) titleFrame--;
      else if (name === "presentation:notes") inNotes = Math.max(0, inNotes - 1);
      else if (name === "draw:page" && heading >= 0) {
        if (title.length) blocks[heading] = `## Slide ${slide}: ${title.join(" ")}`;
        if (notes.length) blocks.push(`Notes: ${notes.join(" ")}`);
        if (!title.length && !notes.length && blocks.length === heading + 1) blocks.length = heading;
        heading = -1;
      }
    },
    text(s) {
      if (!skip) add(paragraphs[paragraphs.length - 1], s.replace(/[ \t\r\n]+/g, " "));
    }
  });
  return joinBlocks(blocks);
}
var OLE_SIGNATURE2 = Buffer.from([208, 207, 17, 224, 161, 177, 26, 225]);
function mainPart(zip) {
  const officeDocument = relatedPart(relationships(zip, ""), "officeDocument");
  if (officeDocument && zip.has(officeDocument)) return officeDocument;
  return ["word/document.xml", "xl/workbook.xml", "ppt/presentation.xml"].find((p) => zip.has(p));
}
function packageText(bytes, budget) {
  if (bytes.subarray(0, 8).equals(OLE_SIGNATURE2))
    throw new Refused("a legacy binary or password-protected Office file (only OOXML and OpenDocument are read here)");
  const zip = openZip(bytes);
  const mimetype = zip.has("mimetype") ? zip.text("mimetype")?.trim() : void 0;
  if (mimetype?.startsWith("application/vnd.oasis.opendocument.")) {
    const content = zip.text("content.xml");
    if (content === void 0) throw new Refused("an OpenDocument package with no content.xml");
    return openDocumentText(content, budget);
  }
  const main = mainPart(zip);
  const xml = main ? zip.text(main) : void 0;
  if (!main || xml === void 0) throw new Refused("not an OOXML or OpenDocument file");
  if (main.startsWith("word/")) {
    const stylesPart = relatedPart(relationships(zip, main), "styles");
    return wordText(xml, budget, wordStyles(stylesPart ? zip.text(stylesPart) : void 0));
  }
  if (main.startsWith("xl/")) return spreadsheetText(zip, main, budget);
  if (main.startsWith("ppt/")) return presentationText(zip, main, budget);
  throw new Refused("not an OOXML or OpenDocument file");
}
function readOffice(bytes) {
  try {
    const text = packageText(bytes, new Budget()).replace(/\n{3,}/g, "\n\n").trim();
    return { text: text.length > MAX_OUTPUT_CHARS ? text.slice(0, text.lastIndexOf("\n", MAX_OUTPUT_CHARS)) : text };
  } catch (e) {
    return { failure: e instanceof Refused ? e.message : "the built-in reader could not parse it" };
  }
}
function officeToText(bytes) {
  return readOffice(bytes).text;
}

// src/doc/ladder.ts
var DOC_EXTRACTORS = ["anydoc", "firecrawl", "builtin"];
var dead2 = /* @__PURE__ */ new Map();
function resetDocLadderCache() {
  dead2.clear();
  resetNpxState();
}
function enabledDocExtractors(engines) {
  if (engines) return engines;
  const chosen = enginesFromEnv("DOC_ENGINE", DOC_EXTRACTORS);
  if (chosen) return chosen;
  if (envFlag("NO_NPX")) return DOC_EXTRACTORS.filter((e) => e !== "anydoc");
  return DOC_EXTRACTORS;
}
async function viaAnydoc(bytes, format) {
  const args = ["-"];
  if (format) args.push("--format", format);
  const r = await runNpx(ANYDOC_SPEC, args, bytes);
  if (r.ok) return { text: r.stdout };
  if (r.unavailable === "not installed") return { unavailable: true };
  if (r.unavailable) return { unavailable: true, failure: `anydoc ${r.unavailable}; ${skipNpxHint()}` };
  return { failure: failureDetail("anydoc", r) };
}
function viaBuiltin(bytes, fmt) {
  if (fmt.format === "csv") return {};
  const r = readOffice(bytes);
  return r.text === void 0 ? { failure: `builtin: ${r.failure}` } : { text: r.text };
}
async function extractDocument(bytes, fmt, opts = {}) {
  let lastReason;
  const failures = [];
  for (const id of enabledDocExtractors(opts.engines)) {
    const known = dead2.get(id);
    if (known) {
      if (known.failure) failures.push(known.failure);
      continue;
    }
    let got;
    try {
      if (id === "anydoc") got = await viaAnydoc(bytes, fmt.format);
      else if (id === "builtin") got = viaBuiltin(bytes, fmt);
      else got = { text: opts.firecrawl ? await opts.firecrawl() : void 0 };
    } catch {
      got = {};
    }
    if (got.text === void 0) {
      if (got.unavailable) dead2.set(id, { failure: got.failure });
      if (got.failure) failures.push(got.failure);
      continue;
    }
    const verdict = assessExtractedText(got.text, "the converter produced no text");
    if (verdict.ok) return { text: got.text.trim(), via: id };
    lastReason = verdict.reason;
  }
  const reason = [lastReason, ...failures].filter(Boolean).join("; ");
  return { text: "", reason: reason || "no document converter available" };
}

// src/url.ts
var TRACKING_PARAMS = /^(utm_|fbclid$|gclid$|gclsrc$|dclid$|msclkid$|yclid$|twclid$|ttclid$|li_fat_id$|mkt_tok$|_gl$|mc_|ref_src$|ref_url$|spm$|_hsenc$|_hsmi$|igshid$|igsh$)/i;
var SHARE_SI_HOSTS = /(^|\.)(youtube\.com|youtu\.be|spotify\.com)$/;
function canonicalizeUrl(raw) {
  try {
    const u = new URL(raw.trim());
    const proto = u.protocol.toLowerCase();
    const host = u.hostname.toLowerCase().replace(/^www\./, "");
    let port = u.port;
    if (proto === "http:" && port === "80" || proto === "https:" && port === "443") port = "";
    const path = u.pathname.replace(/\/+$/, "");
    const keep = [];
    const shareSi = SHARE_SI_HOSTS.test(host);
    for (const [k, v] of u.searchParams) {
      if (!TRACKING_PARAMS.test(k) && !(shareSi && k === "si")) keep.push([k, v]);
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
var FNV_OFFSET_HI = 3421674724;
var FNV_OFFSET_LO = 2216829733;
var FNV_PRIME_LOW = 435;
var laneHi = 0;
var laneLo = 0;
function fnvMix(s) {
  let hi = laneHi;
  let lo = laneLo;
  for (let i = 0; i < s.length; i++) {
    lo = (lo ^ s.charCodeAt(i)) >>> 0;
    const bP = (lo & 65535) * FNV_PRIME_LOW;
    const aP = (lo >>> 16) * FNV_PRIME_LOW + (bP >>> 16);
    const carry = aP >>> 16;
    hi = carry + Math.imul(hi, FNV_PRIME_LOW) + (lo << 8) >>> 0;
    lo = ((aP & 65535) << 16 | bP & 65535) >>> 0;
  }
  laneHi = hi;
  laneLo = lo;
}
function fnv1a64(s) {
  laneHi = FNV_OFFSET_HI;
  laneLo = FNV_OFFSET_LO;
  fnvMix(s);
  return BigInt(laneHi) << 32n | BigInt(laneLo);
}
function fnv1a64Words(pieces, out) {
  laneHi = FNV_OFFSET_HI;
  laneLo = FNV_OFFSET_LO;
  for (const p of pieces) fnvMix(p);
  out[0] = laneHi;
  out[1] = laneLo;
}

// src/video/url.ts
var VIDEO_ID = /^[A-Za-z0-9_-]{11}$/;
var YOUTUBE_HOSTS = ["youtube.com", "youtube-nocookie.com"];
function parse(url) {
  try {
    const u = new URL(url);
    return u.protocol === "https:" || u.protocol === "http:" ? u : void 0;
  } catch {
    return void 0;
  }
}
var onHost = (host, domain) => host === domain || host.endsWith(`.${domain}`);
function isYoutubeHost(host) {
  const h = host.toLowerCase();
  return YOUTUBE_HOSTS.some((d) => onHost(h, d));
}
function youtubeVideoId(url) {
  const u = parse(url);
  if (!u) return void 0;
  const host = u.hostname.toLowerCase();
  let id;
  if (host === "youtu.be" || host === "www.youtu.be") id = u.pathname.split("/")[1];
  else if (isYoutubeHost(host)) {
    if (u.pathname === "/watch") id = u.searchParams.get("v") ?? void 0;
    else id = /^\/(?:shorts|embed|live|v)\/([^/]+)/.exec(u.pathname)?.[1];
  }
  return id && VIDEO_ID.test(id) ? id : void 0;
}
function youtubeListKind(url) {
  const u = parse(url);
  if (!u || !isYoutubeHost(u.hostname)) return void 0;
  if (u.searchParams.get("list")) return "playlist";
  if (/^\/(?:@[^/]+|channel\/[^/]+|c\/[^/]+|user\/[^/]+)/.test(u.pathname)) return "channel";
  return void 0;
}
var HOSTS = [
  {
    site: "vimeo",
    domains: ["vimeo.com"],
    // vimeo.com/<id>, vimeo.com/<id>/<hash> (unlisted), vimeo.com/channels/<c>/<id>,
    // vimeo.com/groups/<g>/videos/<id>, player.vimeo.com/video/<id>.
    video: /^\/(?:video\/|channels\/[^/]+\/|groups\/[^/]+\/videos\/)?(\d{5,})(?:\/([0-9a-f]{6,}))?\/?$/,
    // The player URL, because vimeo.com's own page now answers yt-dlp with a
    // login wall while the player serves a public video — and its subtitles.
    canonical: (m, u) => {
      const hash = m[2] ?? u.searchParams.get("h") ?? void 0;
      return { id: m[1], url: `https://player.vimeo.com/video/${m[1]}${hash ? `?h=${hash}` : ""}` };
    }
  },
  {
    site: "dailymotion",
    domains: ["dailymotion.com"],
    video: /^\/(?:embed\/)?video\/([a-z0-9]{5,})(?:_[^/]*)?\/?$/i,
    canonical: (m) => ({ id: m[1], url: `https://www.dailymotion.com/video/${m[1]}` })
  },
  {
    site: "dailymotion",
    domains: ["dai.ly"],
    video: /^\/([a-z0-9]{5,})\/?$/i,
    canonical: (m) => ({ id: m[1], url: `https://www.dailymotion.com/video/${m[1]}` })
  },
  // Where the URL names the video, its key does too: a video read once is
  // reused with no yt-dlp call at all, as on YouTube.
  {
    site: "twitch",
    domains: ["twitch.tv"],
    video: /^\/videos\/(\d+)\/?$/,
    canonical: (m) => ({ id: m[1], url: `https://www.twitch.tv/videos/${m[1]}` })
  },
  { site: "twitch", domains: ["twitch.tv"], video: /^\/[^/]+\/clip\/[^/]+\/?$/ },
  {
    site: "ted",
    domains: ["ted.com"],
    video: /^\/talks\/([\w-]+)\/?$/,
    canonical: (m) => ({ id: m[1], url: `https://www.ted.com/talks/${m[1]}` })
  },
  {
    site: "loom",
    domains: ["loom.com"],
    video: /^\/(?:share|embed)\/([0-9a-f]{16,})\/?$/,
    canonical: (m) => ({ id: m[1], url: `https://www.loom.com/share/${m[1]}` })
  },
  {
    site: "tiktok",
    domains: ["tiktok.com"],
    video: /^\/(@[^/]+)\/video\/(\d+)\/?$/,
    canonical: (m) => ({ id: m[2], url: `https://www.tiktok.com/${m[1]}/video/${m[2]}` })
  },
  { site: "instagram", domains: ["instagram.com"], video: /^\/(?:reel|reels|tv)\/[\w-]+\/?$/ },
  { site: "facebook", domains: ["facebook.com"], video: /^\/(?:[^/]+\/videos\/[^/]+|reel\/\d+)\/?$/ },
  { site: "facebook", domains: ["fb.watch"], video: /^\/[\w-]{6,}\/?$/ },
  {
    site: "x",
    domains: ["x.com", "twitter.com"],
    video: /^\/([^/]+)\/status\/(\d+)(?:\/video\/\d)?\/?$/,
    canonical: (m) => ({ id: m[2], url: `https://x.com/${m[1]}/status/${m[2]}` })
  },
  { site: "bilibili", domains: ["bilibili.com"], video: /^\/video\/(?:BV\w+|av\d+)\/?$/i },
  { site: "rumble", domains: ["rumble.com"], video: /^\/v[\w-]+\.html$/ },
  { site: "peertube", domains: ["framatube.org", "tilvids.com"], video: /^\/(?:w|videos\/watch)\/[\w-]+\/?$/ }
];
var safeKey = (site, id) => `${site}-${id}`.replace(/[^A-Za-z0-9._-]/g, "_").slice(0, 120);
var shortHash = (text) => fnv1a64(text).toString(16).padStart(16, "0").slice(0, 8);
function knownVideo(url) {
  const id = youtubeVideoId(url);
  if (id) return { site: "youtube", url: `https://www.youtube.com/watch?v=${id}`, key: id };
  const u = parse(url);
  if (!u) return void 0;
  const host = u.hostname.toLowerCase();
  for (const rule of HOSTS) {
    if (!rule.domains.some((d) => onHost(host, d))) continue;
    const m = rule.video.exec(u.pathname);
    if (!m) continue;
    if (!rule.canonical) return { site: rule.site, url: u.toString() };
    const c = rule.canonical(m, u);
    return { site: rule.site, url: c.url, key: safeKey(rule.site, c.id) };
  }
  return void 0;
}
function videoSource(url, opts = {}) {
  const known = knownVideo(url);
  if (known) return known;
  if (!opts.anySite) return void 0;
  const u = parse(url);
  return u ? { site: "web", url: u.toString() } : void 0;
}
function videoRunKey(site, id, pageUrl) {
  if (site === "youtube" && VIDEO_ID.test(id)) return id;
  const key = safeKey(site, id);
  const altered = key !== `${site}-${id}`;
  return site === "web" || altered ? `${key.slice(0, 110)}-${shortHash(pageUrl ?? id)}` : key;
}
function videoUrlAt(webpageUrl, seconds3) {
  const t = Math.max(0, Math.floor(seconds3));
  const u = parse(webpageUrl);
  if (!u) return webpageUrl;
  const host = u.hostname.toLowerCase();
  if (isYoutubeHost(host) || host === "youtu.be") u.searchParams.set("t", `${t}s`);
  else if (onHost(host, "vimeo.com")) u.hash = `t=${t}s`;
  else if (onHost(host, "dailymotion.com")) u.searchParams.set("start", String(t));
  else if (onHost(host, "twitch.tv")) u.searchParams.set("t", `${Math.floor(t / 3600)}h${Math.floor(t % 3600 / 60)}m${t % 60}s`);
  else return webpageUrl;
  return u.toString();
}

// src/video/ytdlp.ts
import { mkdtempSync as mkdtempSync2, readdirSync as readdirSync2, readFileSync as readFileSync3, rmSync as rmSync2, writeFileSync as writeFileSync2 } from "fs";
import { tmpdir as tmpdir2 } from "os";
import { join as join2 } from "path";

// src/exec.ts
import { spawn as spawn3, spawnSync as spawnSync2 } from "child_process";
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
    const probe = spawnSync2(process.platform === "win32" ? "where" : "which", [cmd], { encoding: "utf8" });
    hit = probe.status === 0 && (probe.stdout ?? "").trim().length > 0;
    havePresence.set(cmd, hit);
  }
  return hit;
}
function resetHaveCache() {
  havePresence.clear();
}
function sh(cmd, args, opts = {}) {
  let r;
  try {
    r = spawnSync2(cmd, args, {
      cwd: opts.cwd,
      input: opts.input,
      timeout: opts.timeoutMs ?? defaultTimeoutMs(),
      encoding: "utf8",
      maxBuffer: STDOUT_CAP,
      env: opts.env ?? process.env
    });
  } catch (e) {
    return { ok: false, status: 1, stdout: "", stderr: e.message };
  }
  return toResult(r.status, String(r.stdout ?? ""), String(r.stderr ?? ""), r.error);
}
function shAsync(cmd, args, opts = {}) {
  const timeoutMs = opts.timeoutMs ?? defaultTimeoutMs();
  if (opts.signal?.aborted) return Promise.resolve({ ok: false, status: 130, stdout: "", stderr: "aborted" });
  return new Promise((resolve7) => {
    let settled = false;
    let timer;
    let onAbort;
    const done = (r) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (onAbort) opts.signal?.removeEventListener("abort", onAbort);
      resolve7(r);
    };
    let child;
    try {
      child = spawn3(cmd, args, { cwd: opts.cwd, env: opts.env ?? process.env, stdio: ["ignore", "pipe", "pipe"] });
    } catch (e) {
      done({ ok: false, status: 1, stdout: "", stderr: e.message });
      return;
    }
    let stdout = "";
    let stderr = "";
    child.stdout?.setEncoding("utf8");
    child.stderr?.setEncoding("utf8");
    child.stdout?.on("data", (d) => {
      if (stdout.length < STDOUT_CAP) stdout += d;
    });
    child.stderr?.on("data", (d) => {
      if (stderr.length < STDOUT_CAP) stderr += d;
    });
    timer = setTimeout(() => {
      killTree(child);
      done({ ok: false, status: 124, stdout, stderr: stderr || `timed out after ${timeoutMs}ms` });
    }, timeoutMs);
    if (opts.signal) {
      onAbort = () => {
        killTree(child);
        done({ ok: false, status: 130, stdout, stderr: "aborted" });
      };
      opts.signal.addEventListener("abort", onAbort, { once: true });
    }
    child.on("error", (e) => done(toResult(null, stdout, stderr, e)));
    child.on("close", (code) => done(toResult(code, stdout, stderr)));
  });
}

// src/video/ytdlp.ts
var defaultVideoRunner = (cmd, args, opts) => shAsync(cmd, args, opts);
var PROBE_TIMEOUT_MS = 12e4;
var SUBTITLE_TIMEOUT_MS = 12e4;
function ytdlpExtraArgs() {
  return (env("YTDLP_ARGS") ?? "").split(/\s+/).filter(Boolean);
}
function runYtdlp(args, opts = {}) {
  const strict = opts.knownOnly ? ["--use-extractors", "default,-generic"] : [];
  const argv = [...strict, ...args, ...ytdlpExtraArgs(), ...opts.url ? ["--", opts.url] : []];
  return (opts.run ?? defaultVideoRunner)("yt-dlp", argv, { timeoutMs: opts.timeoutMs ?? PROBE_TIMEOUT_MS, signal: opts.signal });
}
var str = (v) => typeof v === "string" && v.trim() ? v.trim() : void 0;
var httpUrl = (v) => v && /^https?:\/\//i.test(v) ? v : void 0;
var num = (v) => typeof v === "number" && Number.isFinite(v) ? v : void 0;
function siteOf(extractor) {
  const e = extractor.toLowerCase().split(":")[0].replace(/[^a-z0-9]/g, "");
  const known = [
    ["youtube", "youtube"],
    ["vimeo", "vimeo"],
    ["dailymotion", "dailymotion"],
    ["twitch", "twitch"],
    ["twitter", "x"],
    ["ted", "ted"],
    ["loom", "loom"],
    ["tiktok", "tiktok"],
    ["instagram", "instagram"],
    ["facebook", "facebook"],
    ["bilibili", "bilibili"],
    ["rumble", "rumble"],
    ["peertube", "peertube"]
  ];
  if (!e || e === "generic") return "web";
  return known.find(([prefix]) => e.startsWith(prefix))?.[1] ?? e;
}
function videoMetaFromInfo(info, sourceUrl) {
  const id = str(info.id);
  if (!id) return void 0;
  const site = siteOf(str(info.extractor_key) ?? str(info.extractor) ?? "youtube");
  const webpageUrl = httpUrl(str(info.webpage_url)) ?? httpUrl(str(info.original_url)) ?? httpUrl(sourceUrl) ?? `https://www.youtube.com/watch?v=${id}`;
  const date = str(info.upload_date);
  const tracks = (v) => v && typeof v === "object" ? Object.keys(v).filter((k) => k !== "live_chat") : [];
  const duration = num(info.duration);
  const chapters = Array.isArray(info.chapters) ? info.chapters.map((c) => ({
    start: num(c.start_time) ?? 0,
    end: num(c.end_time) ?? duration ?? 0,
    title: (str(c.title) ?? "").replace(/^<Untitled Chapter (\d+)>$/, "Chapter $1")
  })).filter((c) => c.title) : [];
  return {
    id,
    site,
    key: videoRunKey(site, id, webpageUrl),
    title: str(info.title) ?? id,
    channel: str(info.channel) ?? str(info.uploader),
    uploadDate: date && /^\d{8}$/.test(date) ? `${date.slice(0, 4)}-${date.slice(4, 6)}-${date.slice(6)}` : void 0,
    duration,
    language: str(info.language),
    chapters,
    subtitles: tracks(info.subtitles),
    autoCaptions: tracks(info.automatic_captions),
    webpageUrl,
    ...info.live_status === "is_live" || info.is_live === true ? { live: "live" } : {},
    ...info.live_status === "is_upcoming" ? { live: "upcoming" } : {}
  };
}
async function probeVideo(url, run = defaultVideoRunner, signal, knownOnly = false) {
  const r = await runYtdlp(["-J", "--skip-download", "--no-playlist", "--no-warnings"], { run, url, signal, knownOnly });
  if (signal?.aborted) return { error: "cancelled" };
  if (r.missing) return { error: "install yt-dlp (https://github.com/yt-dlp/yt-dlp) to read videos", missing: true };
  if (!r.ok) return { error: classifyYtdlpError(r.stderr) };
  try {
    const parsed = JSON.parse(r.stdout);
    if (parsed?._type === "playlist") return { error: "a list of videos, not one \u2014 read it with `video list`" };
    const meta = parsed ? videoMetaFromInfo(parsed, url) : void 0;
    return meta ? { meta, info: r.stdout } : { error: "no video at this URL (yt-dlp found none)" };
  } catch {
    return { error: "yt-dlp returned unreadable metadata" };
  }
}
function classifyYtdlpError(stderr) {
  const s = stderr || "";
  const unblock = `update yt-dlp (\`${brand().cli} doctor\` shows how old it is) or set ${envName("YTDLP_ARGS")}="--cookies-from-browser firefox"`;
  if (/private video/i.test(s)) return "private video";
  if (/logged-in|log(?:ged)? ?in (?:is )?required|login required|requires? (?:a )?login|--username and --password|account credentials/i.test(s)) {
    return `the site asks yt-dlp to log in \u2014 ${envName("YTDLP_ARGS")}="--cookies-from-browser firefox" passes your browser's session`;
  }
  if (/members[- ]only|join this channel/i.test(s)) return "members-only video";
  if (/confirm your age|age[- ]restricted|inappropriate for some users/i.test(s)) {
    return `age-restricted video \u2014 it needs a signed-in session: ${envName("YTDLP_ARGS")}="--cookies-from-browser firefox"`;
  }
  if (/not a bot|sign in to confirm|po[ _-]?token|HTTP Error 403/i.test(s)) return `YouTube refused yt-dlp \u2014 ${unblock}`;
  if (/has been removed|account .*terminated|no longer available|copyright claim/i.test(s)) return "video removed";
  if (/unavailable|not available/i.test(s)) return "video unavailable";
  if (/timed out after/i.test(s)) return "yt-dlp timed out";
  if (/DRM protected/i.test(s)) return "the site serves this video under DRM: its picture and sound cannot be downloaded (subtitles still can)";
  if (/unsupported url|no video (?:formats|could be found)|no media found|there's no video/i.test(s)) return "no video at this URL (yt-dlp found none)";
  const line = s.split("\n").map((l) => l.trim()).find((l) => l.startsWith("ERROR:"));
  return `yt-dlp failed: ${(line ?? s.trim().split("\n")[0] ?? "").replace(/^ERROR:\s*/, "").slice(0, 200) || "no output"}`;
}
async function withTempDir(label, fn) {
  const dir = mkdtempSync2(join2(tmpdir2(), `${brand().name}-${label}-`));
  try {
    return await fn(dir);
  } finally {
    rmSync2(dir, { recursive: true, force: true });
  }
}
async function downloadSubtitle(info, lang, auto, run = defaultVideoRunner, signal, knownOnly = false) {
  return withTempDir("subs", async (dir) => {
    const infoPath = join2(dir, "info.json");
    writeFileSync2(infoPath, info);
    const r = await runYtdlp(
      [
        "--load-info-json",
        infoPath,
        "--skip-download",
        "--no-warnings",
        auto ? "--write-auto-subs" : "--write-subs",
        "--sub-langs",
        lang,
        "--sub-format",
        "vtt/srt",
        "-o",
        join2(dir, "sub.%(ext)s")
      ],
      { run, timeoutMs: SUBTITLE_TIMEOUT_MS, signal, knownOnly }
    );
    const file = readdirSync2(dir).find((f) => f.endsWith(".vtt")) ?? readdirSync2(dir).find((f) => f.endsWith(".srt"));
    if (file) return { vtt: readFileSync3(join2(dir, file), "utf8") };
    if (signal?.aborted) return { error: "cancelled" };
    return { error: r.ok ? `yt-dlp wrote no ${lang} track` : classifyYtdlpError(r.stderr) };
  });
}
async function ytdlpVersionAge(run = defaultVideoRunner, now = Date.now()) {
  const r = await run("yt-dlp", ["--version"], { timeoutMs: 2e4 });
  if (!r.ok) return void 0;
  const version = r.stdout.trim().split("\n")[0] ?? "";
  const m = /^(\d{4})\.(\d{2})\.(\d{2})/.exec(version);
  if (!m) return { version };
  const released = Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  return { version, ageDays: Math.max(0, Math.floor((now - released) / 864e5)) };
}
async function downloadMedia(args, dir, stem, opts) {
  let stderr = "";
  for (let attempt = 0; attempt < 2; attempt++) {
    const timeoutMs = typeof opts.timeoutMs === "function" ? opts.timeoutMs() : opts.timeoutMs;
    const r = await runYtdlp([...args, "--no-warnings", "-o", join2(dir, `${stem}.%(ext)s`)], {
      run: opts.run,
      url: opts.url,
      timeoutMs,
      signal: opts.signal,
      knownOnly: opts.knownOnly
    });
    if (opts.signal?.aborted) return { error: "cancelled" };
    if (r.status === 124) return { error: "timed out", timedOut: true };
    const file = r.ok ? readdirSync2(dir).find((f) => f.startsWith(`${stem}.`) && !/\.part(?:-Frag\d+)?$|\.ytdl$|\.f\d+\.\w+$/.test(f)) : void 0;
    if (file) return { file };
    stderr = r.ok ? "yt-dlp wrote no file" : r.stderr;
  }
  return { error: classifyYtdlpError(stderr) };
}

// src/video/vtt.ts
var TIMING = /^((?:\d+:)?\d{1,2}:\d{2}[.,]\d{3})\s+-->\s+((?:\d+:)?\d{1,2}:\d{2}[.,]\d{3})/;
var MIN_CUE_S = 0.05;
function seconds(stamp) {
  const parts = stamp.replace(",", ".").split(":").map(Number);
  return parts.reduce((acc, p) => acc * 60 + p, 0);
}
var ENTITIES2 = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ", lrm: "", rlm: "" };
function decode(text) {
  return text.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (whole2, name) => {
    if (name[0] === "#") {
      const code = name[1] === "x" || name[1] === "X" ? Number.parseInt(name.slice(2), 16) : Number(name.slice(1));
      return Number.isFinite(code) && code > 0 && code <= 1114111 ? String.fromCodePoint(code) : whole2;
    }
    return ENTITIES2[name.toLowerCase()] ?? whole2;
  });
}
var clean = (line) => decode(line.replace(/<[^>]*>/g, "").replace(/\{\\[^}]*\}/g, "")).replace(/\s+/g, " ").trim();
function parseVtt(src, opts = {}) {
  const text = src.replace(/^\uFEFF/, "").replace(/\r\n?/g, "\n");
  const srt = !/^WEBVTT/.test(text) && /^\s*\d+[ \t]*\n\d{2}:\d{2}:\d{2}[,.]\d{3}\s+-->/.test(text);
  if (!/^WEBVTT/.test(text) && !srt) return [];
  const rolling = opts.rolling ?? (/<\d{2}:\d{2}[:.]\d/.test(text) || /<c>/.test(text));
  const out = [];
  let shown = [];
  for (const block of text.split(/\n{2,}/)) {
    const raw = block.split("\n");
    const at = raw.findIndex((l) => TIMING.test(l));
    if (at < 0) continue;
    const m = TIMING.exec(raw[at]);
    const start = seconds(m[1]);
    const end = seconds(m[2]);
    const lines = raw.slice(at + 1).map(clean).filter(Boolean);
    const previous = shown;
    shown = lines;
    if (end - start < MIN_CUE_S) continue;
    let fresh = lines;
    if (rolling) {
      fresh = lines.slice(repeatedLead(lines, previous));
      const last = previous[previous.length - 1];
      if (last && fresh[0]?.startsWith(`${last} `)) fresh = [fresh[0].slice(last.length + 1), ...fresh.slice(1)];
    }
    if (fresh.length) out.push({ start, end, text: fresh.join(" ") });
  }
  return out;
}
function repeatedLead(lines, previous) {
  for (let n = Math.min(lines.length, previous.length); n > 0; n--) {
    const tail = previous.slice(previous.length - n);
    if (tail.every((l, i) => l === lines[i])) return n;
  }
  return 0;
}
var SENTENCE_END = /[.!?…]+["'”’)\]]*(?=\s|$)/g;
var MAX_SEGMENT_S = 30;
var MAX_SENTENCES = 3;
var PAUSE_S = 5;
var WORDS_TO_CLOSE = 25;
var BREAK_SLACK_S = 0.5;
function mergeSegments(cues, breaks = []) {
  const out = [];
  let cur;
  const flush = () => {
    if (cur) out.push(cur);
    cur = void 0;
  };
  const crossesBreak = (from, to) => breaks.some((b) => b > from + BREAK_SLACK_S && b <= to + BREAK_SLACK_S);
  for (const cue of cues) {
    if (cur && (cue.start - cur.end > PAUSE_S || cue.end - cur.start > MAX_SEGMENT_S || crossesBreak(cur.start, cue.start))) flush();
    cur = cur ? { start: cur.start, end: Math.max(cur.end, cue.end), text: `${cur.text} ${cue.text}` } : { ...cue };
    const sentences = cur.text.match(SENTENCE_END)?.length ?? 0;
    const endsSentence = /[.!?…]+["'”’)\]]*$/.test(cur.text);
    const words = cur.text.split(/\s+/).length;
    if (sentences >= MAX_SENTENCES || endsSentence && words >= WORDS_TO_CLOSE) flush();
  }
  flush();
  return out;
}

// src/video/whisper.ts
import { existsSync as existsSync2, readFileSync as readFileSync4, writeFileSync as writeFileSync3 } from "fs";
import { join as join3 } from "path";
var DEFAULT_MAX = 3;
var DEFAULT_TIMEOUT_MS2 = 30 * 6e4;
var DEFAULT_MODEL = "small";
var PYAV_PIN = "av<18";
var AUDIO_FORMAT = "bestaudio/best";
var spent2 = 0;
function resetWhisperBudget() {
  spent2 = 0;
}
function whisperBudgetLeft() {
  return Math.max(0, envInt("WHISPER_MAX", DEFAULT_MAX) - spent2);
}
function whisperModel() {
  return env("WHISPER_MODEL") ?? DEFAULT_MODEL;
}
function whisperSegments(json) {
  try {
    const parsed = JSON.parse(json);
    return (parsed.segments ?? []).map((s) => ({
      start: Number(s.start),
      end: Number(s.end),
      text: String(s.text ?? "").replace(/\s+/g, " ").trim()
    })).filter((s) => Number.isFinite(s.start) && Number.isFinite(s.end) && s.text);
  } catch {
    return [];
  }
}
function whisperLanguage(tag) {
  const base2 = tag?.toLowerCase().split(/[-_]/)[0];
  return base2 && /^[a-z]{2,3}$/.test(base2) ? base2 : void 0;
}
async function whisperTranscribe(info, language, run, signal, knownOnly = false) {
  if (whisperBudgetLeft() <= 0) return { declined: "budget" };
  spent2++;
  const refund = (r) => {
    spent2 = Math.max(0, spent2 - 1);
    return r;
  };
  const budgetMs = envInt("WHISPER_TIMEOUT_MS", DEFAULT_TIMEOUT_MS2, 1e3);
  const deadline = Date.now() + budgetMs;
  const left = () => Math.max(1e3, deadline - Date.now());
  const timedOut = { failed: `whisper: timed out after ${Math.round(budgetMs / 6e4)} min (${envName("WHISPER_TIMEOUT_MS")})` };
  return withTempDir("whisper", async (dir) => {
    const infoPath = join3(dir, "info.json");
    writeFileSync3(infoPath, info);
    const dl = await downloadMedia(["--load-info-json", infoPath, "-f", AUDIO_FORMAT], dir, "audio", { run, timeoutMs: left, signal, knownOnly });
    if (signal?.aborted) return refund({ failed: "whisper: cancelled" });
    if ("timedOut" in dl) return timedOut;
    if ("error" in dl) return refund({ failed: `whisper: the audio download failed (${dl.error})` });
    const audio = dl.file;
    const wav = join3(dir, "speech.wav");
    const ff = await run("ffmpeg", ["-nostdin", "-hide_banner", "-loglevel", "error", "-y", "-i", join3(dir, audio), "-ar", "16000", "-ac", "1", wav], {
      timeoutMs: left(),
      signal
    });
    if (ff.missing) return refund({ failed: "whisper needs ffmpeg", unavailable: true });
    if (signal?.aborted) return refund({ failed: "whisper: cancelled" });
    if (ff.status === 124) return timedOut;
    if (!ff.ok || !existsSync2(wav)) return refund({ failed: "whisper: ffmpeg could not convert the audio" });
    const args = ["--with", PYAV_PIN, "whisper-ctranslate2", wav, "--model", whisperModel(), "--output_format", "json", "--output_dir", dir];
    const lang = whisperLanguage(language);
    if (lang) args.push("--language", lang);
    const w = await run("uvx", args, { timeoutMs: left(), cwd: dir, signal });
    if (w.missing) return refund({ failed: "whisper needs uvx", unavailable: true });
    if (signal?.aborted) return { failed: "whisper: cancelled" };
    if (w.status === 124) return timedOut;
    const out = join3(dir, "speech.json");
    if (!w.ok || !existsSync2(out)) return { failed: `whisper: ${w.stderr.trim().split("\n").pop() || "failed"}` };
    return { segments: whisperSegments(readFileSync4(out, "utf8")) };
  });
}

// src/video/ladder.ts
var VIDEO_TRANSCRIBERS = ["manual-subs", "auto-subs", "whisper"];
var processDeps = {};
function setVideoDeps(deps = {}) {
  processDeps = deps;
}
function videoDeps(own) {
  return { run: own?.run ?? processDeps.run ?? defaultVideoRunner, have: own?.have ?? processDeps.have ?? have };
}
var dead3 = /* @__PURE__ */ new Map();
function resetVideoLadderCache() {
  dead3.clear();
  resetWhisperBudget();
}
function enabledTranscribers(engines) {
  return engines ?? enginesFromEnv("VIDEO_ENGINES", VIDEO_TRANSCRIBERS) ?? VIDEO_TRANSCRIBERS;
}
var MIN_WORDS_PER_MINUTE = 5;
function assessTranscript(segments, duration) {
  const words = segments.reduce((n, s) => n + s.text.split(/\s+/).filter(Boolean).length, 0);
  if (!words) return { ok: false, reason: "empty transcript" };
  if (duration && duration > 60) {
    const minutes = duration / 60;
    if (words / minutes < MIN_WORDS_PER_MINUTE) {
      return { ok: false, reason: `transcript too sparse: ${words} words over ${Math.round(minutes)} min \u2014 music or a silent video?` };
    }
  }
  return { ok: true };
}
var base = (tag) => tag.toLowerCase().split(/[-_]/)[0];
function pickManualTrack(meta, lang) {
  const tracks = meta.subtitles;
  if (!tracks.length) return void 0;
  for (const want of [lang, meta.language, "en"]) {
    if (!want) continue;
    const exact = tracks.find((t) => t.toLowerCase() === want.toLowerCase());
    if (exact) return exact;
    const sameBase = tracks.find((t) => base(t) === base(want));
    if (sameBase) return sameBase;
  }
  return tracks[0];
}
function pickAutoTrack(meta) {
  const tracks = meta.autoCaptions;
  const lang = meta.language;
  if (lang) {
    for (const want of [`${lang}-orig`, lang]) {
      const hit = tracks.find((t) => t.toLowerCase() === want.toLowerCase());
      if (hit) return hit;
    }
    const orig = tracks.find((t) => t.endsWith("-orig") && base(t) === base(lang));
    if (orig) return orig;
    return void 0;
  }
  const origs = tracks.filter((t) => t.endsWith("-orig"));
  return origs.length === 1 ? origs[0] : void 0;
}
var chapterStarts = (meta) => meta.chapters.map((c) => c.start);
async function subtitleRung(auto, meta, info, opts, deps) {
  const track = auto ? pickAutoTrack(meta) : pickManualTrack(meta, opts.lang);
  if (!track) return { failure: auto ? "no auto-captions in the video's language" : "no manual subtitles", noTrack: true };
  const got = await downloadSubtitle(info, track, auto, deps.run, opts.signal, opts.knownHostsOnly);
  if ("error" in got) return { failure: `${auto ? "auto-captions" : "subtitles"} (${track}): ${got.error}` };
  return { segments: mergeSegments(parseVtt(got.vtt, { rolling: auto }), chapterStarts(meta)), track };
}
async function whisperRung(meta, info, opts, deps) {
  const missing = ["uvx", "ffmpeg"].filter((c) => !deps.have(c));
  if (missing.length) return { failure: "whisper needs uvx and ffmpeg", unavailable: true };
  if (whisperBudgetLeft() <= 0) return { failure: `this run's whisper budget is spent (raise ${envName("WHISPER_MAX")})` };
  const r = await whisperTranscribe(info, meta.language, deps.run, opts.signal, opts.knownHostsOnly);
  if ("segments" in r) return { segments: mergeSegments(r.segments, chapterStarts(meta)) };
  if ("declined" in r) return { failure: `this run's whisper budget is spent (raise ${envName("WHISPER_MAX")})` };
  return { failure: r.failed, unavailable: r.unavailable };
}
var plain = (segments) => segments.map((s) => s.text).join("\n");
async function transcribeVideo(url, opts = {}) {
  const none = (reason2, meta2) => ({
    text: "",
    segments: [],
    chapters: meta2?.chapters ?? [],
    ...meta2 ? { meta: meta2 } : {},
    reason: reason2
  });
  const source2 = videoSource(url, { anySite: !opts.knownHostsOnly });
  if (!source2) return none(`not a video URL${opts.knownHostsOnly ? " on a known video host" : ""}: ${url}`);
  const deps = videoDeps(opts.deps);
  const rungs = enabledTranscribers(opts.engines);
  if (!rungs.length) return none(`every transcript rung is switched off (${envName("VIDEO_ENGINES")})`);
  const probe = opts.probed ?? await probeVideo(source2.url, deps.run, opts.signal, opts.knownHostsOnly);
  if ("error" in probe) return none(probe.error);
  const { meta, info } = probe;
  if (meta.live) return none(`live stream ${meta.live === "live" ? "in progress" : "not started yet"} \u2014 read it once it has ended`, meta);
  const failures = [];
  let noTrack = 0;
  let subtitleRungs = 0;
  let whisperMissing = false;
  let gateReason;
  for (const rung of rungs) {
    if (opts.signal?.aborted) return none("cancelled", meta);
    if (rung !== "whisper") subtitleRungs++;
    const known = dead3.get(rung);
    let got;
    if (known) got = { failure: known, unavailable: true };
    else {
      try {
        got = rung === "whisper" ? await whisperRung(meta, info, opts, deps) : await subtitleRung(rung === "auto-subs", meta, info, opts, deps);
      } catch (e) {
        got = { failure: `${rung}: ${e.message}` };
      }
    }
    if (opts.signal?.aborted) return none("cancelled", meta);
    if ("failure" in got) {
      if (got.unavailable) dead3.set(rung, got.failure);
      if (rung === "whisper" && got.unavailable) whisperMissing = true;
      if (got.noTrack) noTrack++;
      failures.push(got.failure);
      continue;
    }
    const verdict = assessTranscript(got.segments, meta.duration);
    if (verdict.ok)
      return { text: plain(got.segments), segments: got.segments, chapters: meta.chapters, meta, via: rung, ...got.track ? { track: got.track } : {} };
    gateReason = verdict.reason;
  }
  let reason;
  if (subtitleRungs && noTrack === subtitleRungs && whisperMissing && !gateReason) reason = "no subtitles, and whisper needs uvx and ffmpeg";
  else reason = [...new Set([gateReason, ...failures].filter(Boolean))].join("; ");
  return none(reason || "no transcript", meta);
}

// src/video/markdown.ts
function formatStamp(seconds3) {
  const t = Math.max(0, Math.floor(Number.isFinite(seconds3) ? seconds3 : 0));
  const pad2 = (n) => String(n).padStart(2, "0");
  const h = Math.floor(t / 3600);
  const m = Math.floor(t % 3600 / 60);
  const s = t % 60;
  return h ? `${h}:${pad2(m)}:${pad2(s)}` : `${pad2(m)}:${pad2(s)}`;
}
var VIA_LABEL = {
  "manual-subs": "manual subtitles",
  "auto-subs": "YouTube auto-captions",
  whisper: "local whisper transcription"
};
var paragraph = (s) => `[${formatStamp(s.start)}] ${s.text}`;
var baseLang = (tag) => tag.toLowerCase().replace(/-orig$/, "").split(/[-_]/)[0];
function source(t) {
  if (!t.via) return void 0;
  const site = t.meta?.site ?? "youtube";
  const label = t.via === "auto-subs" && site !== "youtube" ? `the site's auto-captions` : VIA_LABEL[t.via] ?? t.via;
  const how = `${label} (${t.via}${t.track ? `, track ${t.track}` : ""})`;
  const spoken = t.meta?.language;
  if (t.track && spoken && baseLang(t.track) !== baseLang(spoken)) return `${how} \u2014 a translation: the video speaks ${spoken}`;
  return how;
}
function transcriptMarkdown(t) {
  if (!t.segments.length) return "";
  const meta = t.meta;
  const head = [`# ${meta?.title ?? "Video transcript"}`, ""];
  if (meta) {
    const facts = [
      meta.channel && `- Channel: ${meta.channel}`,
      meta.uploadDate && `- Published: ${meta.uploadDate}`,
      meta.duration !== void 0 && `- Duration: ${formatStamp(meta.duration)}`,
      `- URL: ${meta.webpageUrl}`,
      t.via && `- Transcript: ${source(t)}`
    ].filter(Boolean);
    head.push(...facts, "");
  }
  const body = [];
  const chapters = [...t.chapters].sort((a, b) => a.start - b.start);
  let c = -1;
  for (const seg of t.segments) {
    while (c + 1 < chapters.length && chapters[c + 1].start <= seg.start + 0.5) {
      c++;
      body.push(`## ${chapters[c].title}`, "");
    }
    body.push(paragraph(seg), "");
  }
  return [...head, ...body].join("\n").trimEnd() + "\n";
}

// src/video/run.ts
import { existsSync as existsSync3, readdirSync as readdirSync3, readFileSync as readFileSync5, statSync } from "fs";
import { tmpdir as tmpdir3 } from "os";
import { join as join4, resolve } from "path";

// src/no-write.ts
import { mkdirSync, renameSync, unlinkSync, writeFileSync as writeFileSync4 } from "fs";
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
  mkdirSync(dir, { recursive: true });
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
    writeFileSync4(tmp, content);
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
  "vs"
]);
var LOCALE_STOPWORDS = /* @__PURE__ */ new Set([
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
  "ne",
  // German.
  "der",
  "die",
  "das",
  "und",
  "ist",
  "sind",
  "wie",
  "ein",
  "eine",
  "einen",
  "einem",
  "einer",
  "mit",
  "f\xFCr",
  "von",
  "zu",
  "den",
  "dem",
  "im",
  "auf",
  "nicht",
  "sich",
  "oder",
  "warum",
  "wann",
  "welche",
  "welcher",
  "welches",
  "kann",
  "wird"
]);
function isStopword(term) {
  const t = term.toLowerCase();
  if (STOPWORDS.has(t)) return true;
  if (LOCALE_STOPWORDS.has(t) && !(term !== t && term === term.toUpperCase())) return true;
  const extra = brand().extraStopwords;
  return extra ? extraStopwordSet(extra).has(t) : false;
}
var extraSets = /* @__PURE__ */ new WeakMap();
function extraStopwordSet(extra) {
  const hit = extraSets.get(extra);
  if (hit && hit.length === extra.length) return hit.set;
  const set = new Set(extra.map((w) => w.toLowerCase()));
  extraSets.set(extra, { length: extra.length, set });
  return set;
}
var TOKEN_RE = new RegExp("(?<![\\p{L}\\p{M}\\p{N}_])\\.net(?![\\p{L}\\p{M}\\p{N}_])|[\\p{L}\\p{M}\\p{N}_]+(?:(?<=\\p{L})[+#]{1,2}\\d*(?![\\p{L}\\p{M}\\p{N}_+#])|\\/\\d(?:\\.\\d)?(?![\\p{L}\\p{M}\\p{N}_./]))?", "giu");
var CJK_CHAR = /[\p{scx=Han}\p{scx=Hiragana}\p{scx=Katakana}]/u;
var CJK_RUNS = /([\p{scx=Han}\p{scx=Hiragana}\p{scx=Katakana}]+)/u;
function cjkBigrams(run) {
  const chars = Array.from(run);
  if (chars.length === 1) return [run];
  const out = [];
  for (let i = 0; i + 1 < chars.length; i++) out.push(chars[i] + chars[i + 1]);
  return out;
}
function keywords(question) {
  const seen = /* @__PURE__ */ new Set();
  const out = [];
  const add = (raw, minLength) => {
    const lower = raw.toLowerCase();
    if (raw.length < minLength || isStopword(raw) || seen.has(lower)) return;
    seen.add(lower);
    out.push(raw);
  };
  const nonAscii = NON_ASCII.test(question);
  for (const [raw] of (nonAscii ? question.normalize("NFC") : question).matchAll(TOKEN_RE)) {
    if (!nonAscii || !CJK_CHAR.test(raw)) {
      add(raw, 2);
      continue;
    }
    for (const piece of raw.split(CJK_RUNS)) {
      if (!piece) continue;
      if (!CJK_CHAR.test(piece)) add(piece, 2);
      else for (const gram of cjkBigrams(piece)) add(gram, 1);
    }
  }
  return out;
}
function rankedKeywords(question) {
  const base2 = keywords(question);
  const score = (raw) => {
    let s = 0;
    if (/\d/.test(raw)) s += 3;
    if (/[A-Z]/.test(raw) && !/^[A-Z0-9]+$/.test(raw)) s += 2;
    if (/_/.test(raw)) s += 2;
    if (raw.length >= 8) s += 1.5;
    else if (raw.length >= 5) s += 0.5;
    return s;
  };
  return base2.map((k, i) => ({ k, s: score(k), i })).sort((a, b) => b.s - a.s || a.i - b.i).map((x) => x.k);
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
for (const [base2, cls] of Object.entries(ACCENT_CLASSES)) {
  for (const ch of cls) BASE_OF.set(ch, base2);
}
function baseChar(ch) {
  const known = BASE_OF.get(ch);
  if (known) return known;
  const stripped = ch.normalize("NFD").replace(new RegExp("\\p{M}+", "gu"), "");
  return stripped.length === 1 ? stripped : ch;
}
var NON_ASCII = /[\u0080-\uffff]/;
function deaccent(s) {
  if (!NON_ASCII.test(s)) return s;
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
  const parts = spaced.split(/[^\p{L}\p{M}\p{N}]+/u).filter(Boolean);
  if (parts.length < 2) return [];
  const out = [];
  for (const p of parts) {
    const lower = p.toLowerCase();
    if (lower.length < 3 || isStopword(p)) continue;
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
    const plain2 = deaccent(raw.toLowerCase());
    const variants = [{ text: raw.toLowerCase(), kind: "original" }];
    if (canonical !== plain2) variants.push({ text: canonical, kind: "folded" });
    if (plain2.length > 4 && plain2.endsWith("ies")) variants.push({ text: plain2.slice(0, -1), kind: "folded" });
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
var LIGATURE_SPELLING = { \u0153: "oe", \u00E6: "ae", \u00DF: "ss" };
var LIGATURE_OF = { oe: "\u0153", ae: "\xE6", ss: "\xDF" };
function charPattern(ch) {
  const cls = ACCENT_CLASSES[baseChar(ch)];
  return cls ? `[${cls}]` : escapeRegExp(ch);
}
function accentPattern(text) {
  const chars = [...text];
  let out = "";
  for (let i = 0; i < chars.length; i++) {
    const ch = chars[i];
    const spelled = LIGATURE_SPELLING[ch.toLowerCase()];
    if (spelled) {
      out += `(?:${escapeRegExp(ch)}|${charPattern(spelled[0])}${charPattern(spelled[1])})`;
      continue;
    }
    const next = chars[i + 1];
    const ligature = next && LIGATURE_OF[(ch + next).toLowerCase()];
    if (ligature) {
      out += `(?:${charPattern(ch)}${charPattern(next)}|${ligature})`;
      i++;
      continue;
    }
    out += charPattern(ch);
  }
  return out;
}
var SHORT_VARIANT = 3;
function lineRegex(source2, text) {
  if ([...text].length <= SHORT_VARIANT && !CJK_CHAR.test(text)) {
    try {
      return new RegExp(`(?<![\\p{L}\\p{M}\\p{N}])(?:${source2})s?(?![\\p{L}\\p{M}])`, "iu");
    } catch {
    }
  }
  return new RegExp(source2, "i");
}
function makeMatcher(expanded) {
  const variants = expanded.flatMap((ek) => ek.variants.map((v) => ({ text: v.text, source: accentPattern(v.text), canonical: ek.canonical })));
  const regexes = variants.map(({ text, source: source2, canonical }) => ({ re: lineRegex(source2, text), canonical }));
  const anchored = variants.map(({ source: source2, canonical }) => ({ re: new RegExp(`^(?:${source2})$`, "i"), canonical }));
  return {
    expanded,
    canonicals: expanded.map((e) => e.canonical),
    patterns: variants.map(({ source: source2, canonical }) => ({ source: source2, canonical })),
    canonicalOf: (span) => anchored.find(({ re }) => re.test(span))?.canonical,
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
    const title = atxTitle(line);
    if (title) heading = title;
  }
  return heading;
}
var ATX_OPEN = /^#{1,6}\s+/;
var ATX_CLOSE = /(?:^|\s)#+$/;
var MD_ESCAPE = /\\([!-/:-@[-`{-~])/g;
function atxTitle(line) {
  const open = ATX_OPEN.exec(line);
  if (!open) return void 0;
  let title = line.slice(open[0].length).trimEnd();
  const close = ATX_CLOSE.exec(title);
  if (close) title = title.slice(0, close.index).trimEnd();
  return title ? title.replace(MD_ESCAPE, "$1") : void 0;
}
function excerptWindows(text, question, opts = {}) {
  const lines = text.split("\n");
  const before = opts.before ?? 3;
  const after = opts.after ?? 12;
  const maxChars = opts.maxChars ?? 1500;
  const perDoc = Math.max(1, opts.perDoc ?? 2);
  const matchers2 = (Array.isArray(question) ? question : [question]).filter((q) => q.trim()).map((q) => buildMatcher(q));
  const hits = [];
  for (let i = 0; i < lines.length; i++) {
    let score = 0;
    for (const m of matchers2) {
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
function trimDashes(s) {
  let start = 0;
  let end = s.length;
  while (start < end && s.charCodeAt(start) === 45) start++;
  while (end > start && s.charCodeAt(end - 1) === 45) end--;
  return s.slice(start, end);
}
function slugify(input, opts = {}) {
  const max = opts.max ?? 120;
  const normalized = input.toLowerCase().replace(/^https?:\/\//, "").replace(/^git@/, "").replace(/\.git$/, "");
  const s = trimDashes(normalized.replace(/[^a-z0-9._-]+/g, "-"));
  if (!/[\u0080-\uffff]/.test(normalized) && s.length <= max) return s || (opts.fallback ?? "");
  const canonical = trimDashes(normalized.replace(/[^\p{L}\p{N}._-]+/gu, "-"));
  const tag = fnv1a64(canonical).toString(16).padStart(16, "0").slice(0, 8);
  const readable = /[\u0080-\uffff]/.test(normalized) ? s.replace(/-{2,}/g, "-") : s;
  const head = readable.slice(0, Math.max(0, max - tag.length - 1)).replace(/-+$/, "");
  return head ? `${head}-${tag}` : tag;
}

// src/rank.ts
function rrf(lists, keyOf, k = 60) {
  const score = /* @__PURE__ */ new Map();
  for (const list of lists) {
    const seen = /* @__PURE__ */ new Set();
    list.forEach((item, idx) => {
      const key = keyOf(item);
      if (seen.has(key)) return;
      seen.add(key);
      score.set(key, (score.get(key) ?? 0) + 1 / (k + idx + 1));
    });
  }
  return score;
}
var byCodeUnit = (a, b) => a < b ? -1 : a > b ? 1 : 0;
function trimTrailing(s, ch) {
  let end = s.length;
  while (end > 0 && s[end - 1] === ch) end--;
  return s.slice(0, end);
}
function arxivIdFromUrl(url) {
  let host;
  let path;
  try {
    const u = new URL(url.trim());
    host = u.hostname.toLowerCase();
    path = trimTrailing(u.pathname, "/");
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
  let search2;
  try {
    const u = new URL(url.trim());
    host = u.hostname.toLowerCase();
    path = u.pathname;
    search2 = u.search;
  } catch {
    return void 0;
  }
  const decode2 = (s) => {
    try {
      return decodeURIComponent(s);
    } catch {
      return s;
    }
  };
  if (/(^|\.)(dx\.)?doi\.org$/.test(host)) {
    const doi2 = normalizeDoi(decode2(trimTrailing(path.replace(/^\/+/, ""), "/")));
    return /^10\.\d{4,9}\//.test(doi2) ? doi2 : void 0;
  }
  const m = /\/doi(?:\/(?:abs|full|pdf|epdf|e?pub))?\/(10\.\d{4,9}\/[^\s?#]+)/i.exec(path);
  if (m) return normalizeDoi(trimTrailing(decode2(m[1]), "/"));
  const loose = /(?:^|[/=])(10\.\d{4,9}\/[^\s?#&]+)/.exec(`${path}${search2}`);
  if (!loose) return void 0;
  let doi = normalizeDoi(trimTrailing(decode2(loose[1]), "/")).replace(/\.pdf$/, "");
  if (doi.startsWith("10.1101/")) doi = doi.replace(/\.(?:full|abstract|supplementary-material|article-info|article-metrics)$/, "").replace(/v\d+$/, "");
  return doi;
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
var indexTokenCache = /* @__PURE__ */ new WeakMap();
function bm25Tokenize(text, opts = {}) {
  return tokenize(text, opts.subtokens !== false);
}
var WORD_SPLIT = /[^\p{L}\p{M}\p{N}_]+/u;
var NON_ASCII2 = /[^\p{ASCII}]/u;
var CJK_CHAR2 = /[\p{scx=Han}\p{scx=Hiragana}\p{scx=Katakana}]/u;
var CJK_RUNS2 = /([\p{scx=Han}\p{scx=Hiragana}\p{scx=Katakana}]+)/u;
var IDENT_BOUNDARY = new RegExp("_|[\\p{Ll}\\p{N}]\\p{Lu}|\\p{Lu}\\p{Lu}\\p{Ll}|\\p{L}\\p{N}|\\p{N}\\p{L}", "u");
var MAX_IDENT = 64;
function tokenize(text, expand2) {
  if (!text) return [];
  const out = [];
  const nonAscii = NON_ASCII2.test(text);
  for (const raw of (nonAscii ? text.normalize("NFC") : text).split(WORD_SPLIT)) {
    if (!raw) continue;
    if (nonAscii && CJK_CHAR2.test(raw)) {
      for (const piece of raw.split(CJK_RUNS2)) {
        if (!piece) continue;
        if (CJK_CHAR2.test(piece)) pushBigrams(piece, out);
        else pushTerm(piece, out, expand2);
      }
    } else pushTerm(raw, out, expand2);
  }
  return out;
}
function pushTerm(raw, out, expand2) {
  if (raw.length < 2 || isStopword(raw)) return;
  const t = foldCached(raw);
  if (t.length < 2) return;
  out.push(t);
  if (!expand2 || raw.length > MAX_IDENT) return;
  for (const sub of subtermsCached(raw, t)) out.push(sub);
}
function pushBigrams(run, out) {
  const chars = Array.from(run);
  if (chars.length === 1) {
    out.push(run);
    return;
  }
  for (let i = 0; i + 1 < chars.length; i++) out.push(chars[i] + chars[i + 1]);
}
var FOLD_CACHE_MAX = 5e4;
var foldCache = /* @__PURE__ */ new Map();
function foldCached(raw) {
  const hit = foldCache.get(raw);
  if (hit !== void 0) return hit;
  const t = foldTerm(raw);
  if (foldCache.size >= FOLD_CACHE_MAX) foldCache.clear();
  foldCache.set(raw, t);
  return t;
}
var NO_SUBTERMS = [];
var subtermCache = /* @__PURE__ */ new Map();
var subtermExtras = { list: void 0, length: 0 };
function subtermsCached(raw, folded) {
  const list = brand().extraStopwords;
  if (list !== subtermExtras.list || (list?.length ?? 0) !== subtermExtras.length) {
    subtermCache.clear();
    subtermExtras = { list, length: list?.length ?? 0 };
  }
  const hit = subtermCache.get(raw);
  if (hit !== void 0) return hit;
  let subs = NO_SUBTERMS;
  if (IDENT_BOUNDARY.test(raw)) {
    subs = subtokens(raw).map(foldCached).filter((sub) => sub !== folded && sub.length >= 2);
  }
  if (subtermCache.size >= FOLD_CACHE_MAX) subtermCache.clear();
  subtermCache.set(raw, subs);
  return subs;
}
function docTokens(doc, titleWeight, headingWeight, body) {
  const out = body ? [...body] : bm25Tokenize(doc.body);
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
  const tokenCache = /* @__PURE__ */ new WeakMap();
  let totalLen = 0;
  for (const doc of docs) {
    const toks = docTokens(doc, titleWeight, headingWeight, opts.tokensOf?.(doc));
    tokenCache.set(doc, { title: doc.title, headings: doc.headings, body: doc.body, tokens: toks });
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
  const index = { idf, avgdl, N, queryTerms, k1, b, titleWeight, headingWeight };
  indexTokenCache.set(index, tokenCache);
  return index;
}
function indexedDocTokens(index, doc) {
  const cache2 = indexTokenCache.get(index);
  const cached = cache2?.get(doc);
  if (cached && cached.title === doc.title && cached.headings === doc.headings && cached.body === doc.body) return cached.tokens;
  const tokens = docTokens(doc, index.titleWeight, index.headingWeight);
  cache2?.set(doc, { title: doc.title, headings: doc.headings, body: doc.body, tokens });
  return tokens;
}
function bm25Score(index, doc) {
  if (!index.queryTerms.length) return 0;
  const toks = indexedDocTokens(index, doc);
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
  const present = new Set(indexedDocTokens(index, doc));
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
function simhash(text, opts = {}) {
  const lanes = new Uint32Array(2);
  simhashLanes(opts.tokens ?? tokenize(text, false), lanes);
  return BigInt(lanes[0]) << 32n | BigInt(lanes[1]);
}
function simhashLanes(toks, out) {
  out[0] = 0;
  out[1] = 0;
  if (!toks.length) return;
  const v = new Int32Array(64);
  const words = new Uint32Array(2);
  const pieces = toks.length < 3 ? [""] : ["", " ", "", " ", ""];
  const n = toks.length < 3 ? toks.length : toks.length - 2;
  for (let i = 0; i < n; i++) {
    if (toks.length < 3) pieces[0] = toks[i];
    else {
      pieces[0] = toks[i];
      pieces[2] = toks[i + 1];
      pieces[4] = toks[i + 2];
    }
    fnv1a64Words(pieces, words);
    const hi2 = words[0];
    const lo2 = words[1];
    for (let b = 0; b < 32; b++) {
      v[b] = v[b] + (lo2 >>> b & 1);
      v[b + 32] = v[b + 32] + (hi2 >>> b & 1);
    }
  }
  let lo = 0;
  let hi = 0;
  for (let b = 0; b < 32; b++) {
    if (2 * v[b] > n) lo |= 1 << b;
    if (2 * v[b + 32] > n) hi |= 1 << b;
  }
  out[0] = hi;
  out[1] = lo;
}
var MASK32 = 0xffffffffn;
function popcount32(n) {
  let x = n - (n >>> 1 & 1431655765);
  x = (x & 858993459) + (x >>> 2 & 858993459);
  return Math.imul(x + (x >>> 4) & 252645135, 16843009) >>> 24;
}
function hammingDistance(a, b) {
  let x = a ^ b;
  let count = popcount32(Number(x & MASK32)) + popcount32(Number(x >> 32n & MASK32));
  x >>= 64n;
  while (x) {
    x &= x - 1n;
    count++;
  }
  return count;
}
function dedupeNearDuplicates(items, opts = {}) {
  const maxBits = opts.maxBits ?? 3;
  const minChars = opts.minChars ?? 500;
  const better = (a, b) => a.score !== b.score ? a.score > b.score : byCodeUnit(a.url, b.url) < 0;
  const kept = [];
  const hashed = [];
  const his = [];
  const los = [];
  const lanes = new Uint32Array(2);
  const dups = [];
  for (const it of items) {
    const text = it.text || "";
    if (text.length < minChars) {
      kept.push({ it });
      continue;
    }
    simhashLanes(opts.tokensOf ? opts.tokensOf(it) : tokenize(text, false), lanes);
    const hi = lanes[0];
    const lo = lanes[1];
    let at = -1;
    for (let k = 0; k < hashed.length; k++) {
      if (popcount32(his[k] ^ hi) + popcount32(los[k] ^ lo) <= maxBits) {
        at = k;
        break;
      }
    }
    if (at < 0) {
      const cluster = { it };
      kept.push(cluster);
      hashed.push(cluster);
      his.push(hi);
      los.push(lo);
      continue;
    }
    const dup = hashed[at];
    if (better(it, dup.it)) {
      dups.push({ url: dup.it.url, cluster: dup });
      dup.it = it;
      his[at] = hi;
      los[at] = lo;
    } else dups.push({ url: it.url, cluster: dup });
  }
  return { items: kept.map((k) => k.it), dropped: dups.length, duplicates: dups.map((d) => ({ url: d.url, of: d.cluster.it.url })) };
}
function diversify(items, tokensOf, lambda = 0.75, opts = {}) {
  const sorted = [...items].sort((a, b) => b.score - a.score || byCodeUnit(a.url, b.url));
  if (sorted.length <= 2) return sorted;
  const window = opts.window !== void 0 && opts.window > 0 ? Math.floor(opts.window) : sorted.length;
  if (window >= sorted.length) return mmr(sorted, tokensOf, lambda);
  return [...window > 2 ? mmr(sorted.slice(0, window), tokensOf, lambda) : sorted.slice(0, window), ...sorted.slice(window)];
}
var PAIR_CACHE_MAX = 2048;
function mmr(sorted, tokensOf, lambda) {
  const m = sorted.length;
  let max = 1e-9;
  for (const it of sorted) if (it.score > max) max = it.score;
  const ids = /* @__PURE__ */ new Map();
  const sets = [];
  for (const it of sorted) {
    const raw = [];
    for (const t of tokensOf(it)) {
      let id = ids.get(t);
      if (id === void 0) {
        id = ids.size;
        ids.set(t, id);
      }
      raw.push(id);
    }
    const all = Int32Array.from(raw).sort();
    let k = 0;
    for (let j = 0; j < all.length; j++) if (j === 0 || all[j] !== all[j - 1]) all[k++] = all[j];
    sets.push(all.subarray(0, k));
  }
  const cache2 = m <= PAIR_CACHE_MAX ? new Float64Array(m * (m - 1) / 2) : void 0;
  const pair = (i, j) => i < j ? i * (2 * m - i - 1) / 2 + (j - i - 1) : j * (2 * m - j - 1) / 2 + (i - j - 1);
  let simMax = 0;
  for (let i = 0; i < m; i++) {
    for (let j = i + 1; j < m; j++) {
      const v = jaccardSorted(sets[i], sets[j]);
      if (cache2) cache2[pair(i, j)] = v;
      if (v > simMax) simMax = v;
    }
  }
  const sim = (i, j) => simMax > 0 ? (cache2 ? cache2[pair(i, j)] : jaccardSorted(sets[i], sets[j])) / simMax : 0;
  const out = [sorted[0]];
  const remaining = [];
  for (let i = 1; i < m; i++) remaining.push(i);
  const maxSim = new Float64Array(m);
  for (const i of remaining) maxSim[i] = sim(i, 0);
  let relevantLeft = 0;
  for (const i of remaining) if (sorted[i].score > 0) relevantLeft++;
  while (remaining.length) {
    let bestPos = -1;
    let bestVal = Number.NEGATIVE_INFINITY;
    for (let p = 0; p < remaining.length; p++) {
      const it = sorted[remaining[p]];
      if (relevantLeft > 0 && !(it.score > 0)) continue;
      const val = lambda * (it.score / max) - (1 - lambda) * maxSim[remaining[p]];
      if (bestPos < 0 || val > bestVal || val === bestVal && byCodeUnit(it.url, sorted[remaining[bestPos]].url) < 0) {
        bestVal = val;
        bestPos = p;
      }
    }
    const picked = remaining.splice(bestPos, 1)[0];
    if (sorted[picked].score > 0) relevantLeft--;
    out.push(sorted[picked]);
    for (const i of remaining) {
      const v = sim(i, picked);
      if (v > maxSim[i]) maxSim[i] = v;
    }
  }
  return out;
}
function jaccardSorted(a, b) {
  const na = a.length;
  const nb = b.length;
  if (!na || !nb) return 0;
  let i = 0;
  let j = 0;
  let inter = 0;
  while (i < na && j < nb) {
    const x = a[i];
    const y = b[j];
    if (x === y) {
      inter++;
      i++;
      j++;
    } else if (x < y) i++;
    else j++;
  }
  return inter / (na + nb - inter);
}
var URL_IN_TEXT = /https?:\/\/(?:[^\s/@?#]+@)?[\p{L}\p{N}.-]+/giu;
function unglued(match) {
  const hostStart = Math.max(match.indexOf("//") + 2, match.lastIndexOf("@") + 1);
  const dot = match.lastIndexOf(".");
  if (dot <= hostStart) return match;
  const label = match.slice(dot + 1);
  const turn = label.search(/[\u0080-\uffff]/);
  return turn > 0 && /^[A-Za-z0-9]/.test(label) ? match.slice(0, dot + 1 + turn) : match;
}
function externalHosts(url, text) {
  const self = domainOf(url).replace(/^www\./, "");
  const out = /* @__PURE__ */ new Set();
  for (const m of text.match(URL_IN_TEXT) ?? []) {
    const h = trimTrailing(domainOf(unglued(trimTrailing(m, "."))), ".").replace(/^www\./, "");
    if (h && h !== self) out.add(h);
  }
  return out;
}

// src/video/run.ts
function videoRoot(out) {
  return resolve(out ?? env("VIDEO_DIR") ?? join4(tmpdir3(), brand().name, "video"));
}
var baseLang2 = (tag) => tag.toLowerCase().replace(/-orig$/, "").split(/[-_]/)[0];
function servesLang(meta, lang) {
  if (!lang) return true;
  const read2 = meta.track ?? meta.lang ?? meta.language;
  return read2 !== void 0 && baseLang2(read2) === baseLang2(lang);
}
var readJson = (path) => {
  try {
    return JSON.parse(readFileSync5(path, "utf8"));
  } catch {
    return void 0;
  }
};
function readVideoRun(dir) {
  const meta = readJson(join4(dir, "meta.json"));
  const segments = readJson(join4(dir, "segments.json"));
  if (!meta?.id || !Array.isArray(segments)) return void 0;
  return { meta, segments };
}
async function fetchVideoRun(url, root, opts = {}) {
  const source2 = videoSource(url, { anySite: !opts.knownHostsOnly });
  if (!source2) return { ok: false, reason: `not a video URL${opts.knownHostsOnly ? " on a known video host" : ""}: ${url}` };
  const kept = (key) => {
    const dir2 = join4(root, key);
    const run = opts.refresh ? void 0 : readVideoRun(dir2);
    if (!run || !existsSync3(join4(dir2, "TRANSCRIPT.md")) || !servesLang(run.meta, opts.lang)) return void 0;
    return { ok: true, id: key, dir: dir2, transcript: join4(dir2, "TRANSCRIPT.md"), reused: true, meta: run.meta, segments: run.segments.length };
  };
  if (source2.key) {
    const reused = kept(source2.key);
    if (reused) return reused;
  }
  let probed3;
  if (!source2.key) {
    const probe = await probeVideo(source2.url, videoDeps(opts.deps).run, opts.signal, opts.knownHostsOnly);
    if ("error" in probe) return { ok: false, reason: probe.error };
    const reused = kept(probe.meta.key ?? probe.meta.id);
    if (reused) return reused;
    probed3 = probe;
  }
  const t = await transcribeVideo(url, { ...opts, ...probed3 ? { probed: probed3 } : {} });
  const id = source2.key ?? t.meta?.key ?? t.meta?.id;
  if (!t.via || !t.meta || !id) return { ok: false, ...id ? { id } : {}, reason: t.reason ?? "no transcript" };
  const dir = join4(root, id);
  const transcriptPath = join4(dir, "TRANSCRIPT.md");
  const meta = {
    ...t.meta,
    via: t.via,
    ...t.track ? { track: t.track } : {},
    ...opts.lang ? { lang: opts.lang } : {},
    fetchedAt: (/* @__PURE__ */ new Date()).toISOString()
  };
  const markdown = transcriptMarkdown(t);
  const done = { ok: true, id, dir, transcript: transcriptPath, reused: false, meta, segments: t.segments.length };
  if (isNoWrite()) return { ...done, markdown };
  try {
    ensureDir(dir);
    writeArtifact(join4(dir, "segments.json"), `${JSON.stringify(t.segments, null, 1)}
`);
    writeArtifact(transcriptPath, markdown);
    writeArtifact(join4(dir, "meta.json"), `${JSON.stringify(meta, null, 2)}
`);
  } catch (e) {
    return { ok: false, id, reason: `cannot write the run in ${dir}: ${e.message}` };
  }
  return done;
}
var PASSAGE_S = 45;
function passageGroups(segments, chapterStarts2) {
  const out = [];
  let cur = [];
  for (const s of segments) {
    if (cur.length && chapterStarts2.some((b) => b > cur[0].start + 0.5 && b <= s.start + 0.5)) {
      out.push(cur);
      cur = [];
    }
    cur.push(s);
    if (s.end - cur[0].start >= PASSAGE_S) {
      out.push(cur);
      cur = [];
    }
  }
  if (cur.length) out.push(cur);
  return out;
}
function listVideoRuns(dir) {
  const self = readVideoRun(dir);
  if (self) return [{ dir, ...self }];
  let names = [];
  try {
    names = readdirSync3(dir).sort();
  } catch {
    return [];
  }
  return names.flatMap((name) => {
    const child = join4(dir, name);
    try {
      if (!statSync(child).isDirectory()) return [];
    } catch {
      return [];
    }
    const run = readVideoRun(child);
    return run ? [{ dir: child, ...run }] : [];
  });
}
function corpusLabels(dir) {
  const c = readJson(join4(dir, "corpus.json"));
  const out = /* @__PURE__ */ new Map();
  for (const v of c?.videos ?? []) if (typeof v.id === "string" && typeof v.label === "string") out.set(v.id, v.label);
  return out;
}
var chapterAt = (chapters, t) => [...chapters].reverse().find((c) => c.start <= t + 0.5)?.title;
function searchVideoRuns(dir, query, opts = {}) {
  const labels = opts.labels ?? corpusLabels(dir);
  const docs = [];
  for (const run of listVideoRuns(dir)) {
    const { meta } = run;
    const key = meta.key ?? meta.id;
    for (const parts of passageGroups(
      run.segments,
      (meta.chapters ?? []).map((c) => c.start)
    )) {
      const chapter = chapterAt(meta.chapters ?? [], parts[0].start);
      docs.push({ id: `${key}@${parts[0].start}`, title: "", headings: chapter ?? "", body: parts.map((s) => s.text).join(" "), parts, meta, key, chapter });
    }
  }
  const index = buildBm25Index(query, docs);
  const scored = docs.map((d) => ({ d, score: Math.round(bm25Score(index, d) * 1e3) / 1e3 })).filter((x) => x.score > 0).sort((a, b) => b.score - a.score || a.d.key.localeCompare(b.d.key) || a.d.parts[0].start - b.d.parts[0].start).slice(0, opts.limit ?? 10);
  return scored.map(({ d, score }) => {
    let best = d.parts[0];
    let top = 0;
    for (const s of d.parts) {
      const sc = bm25Score(index, { id: `${d.id}#${s.start}`, title: "", headings: "", body: s.text });
      if (sc > top) {
        top = sc;
        best = s;
      }
    }
    return {
      label: labels.get(d.key) ?? d.key,
      videoId: d.key,
      title: d.meta.title,
      ...d.chapter ? { chapter: d.chapter } : {},
      start: best.start,
      stamp: formatStamp(best.start),
      url: videoUrlAt(d.meta.webpageUrl, best.start),
      text: d.body,
      score
    };
  });
}

// src/video/frames.ts
import { copyFileSync, cpSync, existsSync as existsSync4, mkdirSync as mkdirSync2, readdirSync as readdirSync4, readFileSync as readFileSync6, renameSync as renameSync2, rmSync as rmSync3 } from "fs";
import { join as join5 } from "path";

// src/video/align.ts
var BEFORE_S = 5;
var AFTER_S = 10;
function transcriptAround(segments, t) {
  return segments.filter((s) => s.end >= t - BEFORE_S && s.start <= t + AFTER_S).map((s) => `[${formatStamp(s.start)}] ${s.text}`).join("\n");
}
var chapterAt2 = (chapters, t) => [...chapters].sort((a, b) => b.start - a.start).find((c) => c.start <= t + 0.5)?.title;
function alignFrames(frames, segments, chapters) {
  return frames.map((f) => {
    const chapter = chapterAt2(chapters, f.time);
    return { file: f.file, time: f.time, stamp: formatStamp(f.time), kind: f.kind, ...chapter ? { chapter } : {}, text: transcriptAround(segments, f.time) };
  });
}
function framesMarkdown(meta, frames, note) {
  const out = [`# ${meta.title} \u2014 frames`, "", `- URL: ${meta.webpageUrl}`, `- ${note}`, ""];
  const quoted = /* @__PURE__ */ new Set();
  for (const f of frames) {
    out.push(`## [${f.stamp}]${f.chapter ? ` ${f.chapter}` : ""}`, "", `![${f.stamp}](${f.file})`, "");
    const lines = f.text ? f.text.split("\n") : [];
    const fresh = lines.filter((l) => !quoted.has(l));
    for (const l of fresh) quoted.add(l);
    if (fresh.length) out.push(...fresh.map((l) => `> ${l}`), "");
    else if (lines.length) out.push(`_(said over the passage quoted above, from ${lines[0].slice(0, lines[0].indexOf("]") + 1)})_`, "");
    else out.push("_(nothing said around this frame)_", "");
  }
  return out.join("\n").trimEnd() + "\n";
}

// src/video/dhash.ts
var DHASH_FRAME_BYTES = 72;
var DHASH_SAME = 6;
function dhash(gray) {
  if (gray.length < DHASH_FRAME_BYTES) throw new Error(`dhash needs ${DHASH_FRAME_BYTES} bytes, got ${gray.length}`);
  let h = 0n;
  for (let y = 0; y < 8; y++) {
    for (let x = 0; x < 8; x++) {
      h = h << 1n | (gray[y * 9 + x] > gray[y * 9 + x + 1] ? 1n : 0n);
    }
  }
  return h;
}
function hamming(a, b) {
  let x = a ^ b;
  let n = 0;
  while (x) {
    x &= x - 1n;
    n++;
  }
  return n;
}
function dhashStream(raw) {
  const out = [];
  for (let at = 0; at + DHASH_FRAME_BYTES <= raw.length; at += DHASH_FRAME_BYTES) out.push(dhash(raw.subarray(at, at + DHASH_FRAME_BYTES)));
  return out;
}

// src/video/frames.ts
var FRAME_EFFORT = { low: 20, med: 50, high: 100 };
var SCENE_THRESHOLD = 0.3;
var VIDEO_FORMAT = "bv*[height<=720]/b[height<=720]/bv*/b";
var FRAMES_TIMEOUT_MS = 30 * 6e4;
var MIN_FRAMES = 3;
var INTERVAL_FRAMES = 10;
var JPEG_FILTER = "scale='min(1280,iw)':-2:out_range=full,format=yuvj420p";
function parseShowinfo(stderr) {
  const out = [];
  for (const m of stderr.matchAll(/\bn:\s*(\d+)\s+pts:\s*-?\d+\s+pts_time:(-?[\d.]+)/g)) out[Number(m[1])] = Number(m[2]);
  return out.filter((t) => Number.isFinite(t));
}
function capFrames(frames, max) {
  const kept = [...frames].sort((a, b) => a.time - b.time);
  const limit = Math.max(1, max);
  while (kept.length > limit) {
    const spareChapters = kept.some((f) => f.kind !== "chapter");
    let worst = kept.length - 1;
    let gap = Number.POSITIVE_INFINITY;
    for (let i = 0; i < kept.length; i++) {
      if (spareChapters && kept[i].kind === "chapter") continue;
      const g = i ? kept[i].time - kept[i - 1].time : kept[1].time - kept[0].time;
      if (g < gap) {
        gap = g;
        worst = i;
      }
    }
    kept.splice(worst, 1);
  }
  return kept;
}
var plural = (n, word) => `${n} ${word}${n === 1 ? "" : "s"}`;
var fileStamp = (t) => formatStamp(t).replace(/:/g, "-");
async function extractFrames(runDir, opts = {}) {
  if (isNoWrite()) return { ok: false, reason: "frames are image files, and nothing may be written (NO_WRITE)" };
  const run = readVideoRun(runDir);
  if (!run) return { ok: false, reason: `no video run in ${runDir} \u2014 fetch the video first` };
  const deps = videoDeps(opts.deps);
  if (!deps.have("ffmpeg")) return { ok: false, reason: "frames need ffmpeg" };
  const effort = opts.effort ?? "med";
  const { meta, segments } = run;
  const source2 = videoSource(opts.url ?? meta.webpageUrl, { anySite: !opts.knownHostsOnly });
  if (!source2) return { ok: false, reason: `the run in ${runDir} names no page this may download the video from` };
  const duration = meta.duration ?? 0;
  return withTempDir("frames", async (tmp) => {
    const dl = await downloadMedia(["-f", VIDEO_FORMAT, "--no-playlist"], tmp, "video", {
      run: deps.run,
      url: source2.url,
      knownOnly: opts.knownHostsOnly,
      timeoutMs: FRAMES_TIMEOUT_MS,
      signal: opts.signal
    });
    if (opts.signal?.aborted) return { ok: false, reason: "cancelled" };
    if ("error" in dl) return { ok: false, reason: `the video download failed: ${dl.error}` };
    const video = dl.file;
    const input = join5(tmp, video);
    const ffmpeg = (args) => deps.run("ffmpeg", ["-nostdin", "-hide_banner", ...args], { timeoutMs: FRAMES_TIMEOUT_MS, signal: opts.signal });
    const sceneDir = join5(tmp, "scene");
    mkdirSync2(sceneDir);
    const scenes = await ffmpeg([
      "-i",
      input,
      "-vf",
      `select='gt(scene,${SCENE_THRESHOLD})',showinfo,${JPEG_FILTER}`,
      "-fps_mode",
      "vfr",
      "-q:v",
      "3",
      join5(sceneDir, "%04d.jpg")
    ]);
    if (opts.signal?.aborted) return { ok: false, reason: "cancelled" };
    const times = parseShowinfo(scenes.stderr);
    const sceneFiles = readdirSync4(sceneDir).sort();
    const candidates = sceneFiles.slice(0, times.length).map((f, i) => ({ path: join5(sceneDir, f), time: times[i], kind: "scene" }));
    const single = async (time, kind) => {
      const path = join5(tmp, `${kind}-${candidates.length}.jpg`);
      await ffmpeg(["-loglevel", "error", "-ss", time.toFixed(2), "-i", input, "-frames:v", "1", "-vf", JPEG_FILTER, "-q:v", "3", "-y", path]);
      if (existsSync4(path)) candidates.push({ path, time, kind });
    };
    const last = duration > 1 ? duration - 0.5 : Number.POSITIVE_INFINITY;
    for (const c of meta.chapters ?? []) await single(Math.min(c.start + 1, last), "chapter");
    if (candidates.length < MIN_FRAMES && duration > 0) {
      const n = Math.min(FRAME_EFFORT[effort], INTERVAL_FRAMES);
      for (let i = 0; i < n; i++) await single(duration * (i + 0.5) / n, "interval");
    }
    if (opts.signal?.aborted) return { ok: false, reason: "cancelled" };
    if (!candidates.length)
      return { ok: false, reason: `ffmpeg took no frame from the video${scenes.ok ? "" : ` (${scenes.stderr.trim().split("\n").pop()})`}` };
    candidates.sort((a, b) => a.time - b.time);
    const candDir = join5(tmp, "cand");
    mkdirSync2(candDir);
    candidates.forEach((c, i) => copyFileSync(c.path, join5(candDir, `${String(i + 1).padStart(4, "0")}.jpg`)));
    const raw = join5(tmp, "hash.raw");
    await ffmpeg(["-loglevel", "error", "-i", join5(candDir, "%04d.jpg"), "-vf", "scale=9:8,format=gray", "-f", "rawvideo", "-y", raw]);
    const hashes = existsSync4(raw) ? dhashStream(readFileSync6(raw)) : [];
    const kept = [];
    for (const [i, c] of candidates.entries()) {
      const hash = hashes.length === candidates.length ? hashes[i] : void 0;
      if (hash !== void 0 && kept.some((k) => k.hash !== void 0 && hamming(k.hash, hash) <= DHASH_SAME)) continue;
      kept.push({ ...c, ...hash !== void 0 ? { hash } : {} });
    }
    const chosen = capFrames(kept, FRAME_EFFORT[effort]);
    const staged = join5(tmp, "frames");
    mkdirSync2(staged);
    const placed = chosen.map((c, i) => {
      const file = `frames/${String(i + 1).padStart(4, "0")}_${fileStamp(c.time)}.jpg`;
      copyFileSync(c.path, join5(tmp, file));
      return { file, time: c.time, kind: c.kind };
    });
    const frames = alignFrames(placed, segments, meta.chapters ?? []);
    const dropped = candidates.length - kept.length;
    const note = `${plural(frames.length, "frame")} (effort ${effort}: at most ${FRAME_EFFORT[effort]}) from ${plural(candidates.length, "candidate")} \u2014 scene changes above ${SCENE_THRESHOLD}, one per chapter start, ${plural(dropped, "near-duplicate")} dropped`;
    const framesDir = join5(runDir, "frames");
    try {
      const incoming = `${framesDir}.${process.pid}.${Date.now()}.new`;
      cpSync(staged, incoming, { recursive: true });
      rmSync3(framesDir, { recursive: true, force: true });
      renameSync2(incoming, framesDir);
      writeArtifact(join5(runDir, "frames.json"), `${JSON.stringify(frames, null, 2)}
`);
      const markdown = writeArtifact(join5(runDir, "FRAMES.md"), framesMarkdown(meta, frames, note));
      return { ok: true, dir: framesDir, markdown, frames, candidates: candidates.length, duplicates: dropped, effort };
    } catch (e) {
      return { ok: false, reason: `cannot write the frames in ${runDir}: ${e.message}` };
    }
  });
}

// src/video/list.ts
import { join as join6 } from "path";

// src/pool.ts
async function mapLimit(items, limit, fn) {
  const width = typeof limit !== "number" || Number.isNaN(limit) ? 1 : Math.max(1, Math.floor(limit));
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
      try {
        results[i] = await fn(items[i], i);
      } catch (e) {
        next = items.length;
        throw e;
      }
    }
  });
  await Promise.all(workers);
  return results;
}

// src/video/list.ts
var LIST_TIMEOUT_MS = 12e4;
var DEFAULT_LIMIT = 10;
var CORPUS_CONCURRENCY = 2;
function listingUrl(url) {
  const u = new URL(url);
  if (youtubeListKind(url) === "channel" && /^\/(?:@[^/]+|(?:channel|c|user)\/[^/]+)\/?$/.test(u.pathname)) {
    u.pathname = `${u.pathname.replace(/\/$/, "")}/videos`;
  }
  return u.toString();
}
async function listVideos(url, opts = {}) {
  const u = /^https?:\/\//i.test(url) ? url : void 0;
  if (!u || !youtubeListKind(url) && (opts.knownHostsOnly || knownVideo(url)))
    return { error: `not a playlist or channel URL${opts.knownHostsOnly ? " on YouTube" : ""}: ${url}` };
  const limit = Math.max(1, Math.trunc(opts.limit ?? DEFAULT_LIMIT));
  const r = await runYtdlp(["--flat-playlist", "-J", "--playlist-end", String(limit), "--no-warnings"], {
    run: videoDeps(opts.deps).run,
    url: listingUrl(url),
    timeoutMs: LIST_TIMEOUT_MS,
    signal: opts.signal,
    knownOnly: opts.knownHostsOnly
  });
  if (r.missing) return { error: "install yt-dlp (https://github.com/yt-dlp/yt-dlp) to read videos" };
  if (!r.ok) return { error: classifyYtdlpError(r.stderr) };
  try {
    const info = JSON.parse(r.stdout);
    const videos = (info.entries ?? []).flatMap((e) => {
      const id = typeof e.id === "string" ? e.id : "";
      const ie = typeof e.ie_key === "string" ? e.ie_key : "";
      if (!id || e._type === "playlist" || /tab|playlist|channel|user|album|showcase/i.test(ie)) return [];
      const title = typeof e.title === "string" ? e.title : id;
      const duration = typeof e.duration === "number" ? { duration: e.duration } : {};
      if (youtubeListKind(url)) {
        const watch = `https://www.youtube.com/watch?v=${id}`;
        return (ie === "" || ie === "Youtube") && youtubeVideoId(watch) ? [{ id, key: id, title, ...duration, url: watch }] : [];
      }
      const entryUrl = [e.url, e.webpage_url].find((v) => typeof v === "string" && /^https?:\/\//i.test(v));
      if (!entryUrl || opts.knownHostsOnly && !knownVideo(entryUrl)) return [];
      const known = knownVideo(entryUrl);
      return [{ id, ...known?.key ? { key: known.key } : {}, title, ...duration, url: known?.url ?? entryUrl }];
    });
    const unique = videos.filter((v, i) => videos.findIndex((w) => w.url === v.url) === i);
    return { ...info.title ? { title: info.title } : {}, videos: unique.slice(0, limit) };
  } catch {
    return { error: "yt-dlp returned an unreadable listing" };
  }
}
function corpusMarkdown(c, root) {
  const cell2 = (s) => s.replace(/\|/g, "\\|").replace(/\s+/g, " ");
  const rows = c.videos.map(
    (v) => [
      v.label,
      v.id,
      cell2(v.title),
      v.duration !== void 0 ? formatStamp(v.duration) : "",
      v.via ?? "\u2014",
      v.dir ? `${v.id}/TRANSCRIPT.md` : cell2(`not read: ${v.reason ?? "no transcript"}`)
    ].join(" | ")
  );
  const read2 = c.videos.filter((v) => v.dir).length;
  return [
    `# ${c.title ?? "Video corpus"}`,
    "",
    `- Source: ${c.source}`,
    `- Directory: ${root}`,
    `- ${read2} of ${c.videos.length} videos read, ${c.createdAt}`,
    "",
    "| V# | id | title | duration | via | transcript |",
    "|---|---|---|---|---|---|",
    ...rows.map((r) => `| ${r} |`),
    ""
  ].join("\n");
}
async function fetchVideoCorpus(url, root, opts = {}) {
  if (isNoWrite()) return { ok: false, reason: "a corpus is kept on disk, and nothing may be written (NO_WRITE)" };
  const listed = await listVideos(url, { limit: opts.limit, deps: opts.deps, signal: opts.signal, knownHostsOnly: opts.knownHostsOnly });
  if ("error" in listed) return { ok: false, reason: listed.error };
  if (!listed.videos.length) return { ok: false, reason: `no videos listed at ${url}` };
  let done = 0;
  const videos = await mapLimit(listed.videos, CORPUS_CONCURRENCY, async (v, i) => {
    const r = await fetchVideoRun(v.url, root, { ...opts });
    opts.onVideo?.(++done, listed.videos.length, r.ok ? r.meta.title : v.title);
    const base2 = {
      label: `V${i + 1}`,
      id: r.ok ? r.id : v.key ?? v.id,
      title: r.ok ? r.meta.title : v.title,
      ...v.duration !== void 0 ? { duration: v.duration } : {}
    };
    return r.ok ? { ...base2, ...r.meta.duration !== void 0 ? { duration: r.meta.duration } : {}, via: r.meta.via, dir: r.dir, reused: r.reused } : { ...base2, reason: r.reason };
  });
  const corpus = { source: url, ...listed.title ? { title: listed.title } : {}, createdAt: (/* @__PURE__ */ new Date()).toISOString(), videos };
  let path;
  try {
    ensureDir(root);
    writeArtifact(join6(root, "corpus.json"), `${JSON.stringify(corpus, null, 2)}
`);
    path = writeArtifact(join6(root, "CORPUS.md"), corpusMarkdown(corpus, root));
  } catch (e) {
    return { ok: false, reason: `cannot write the corpus in ${root}: ${e.message}` };
  }
  return { ok: true, dir: root, corpus: path, videos, ...listed.title ? { title: listed.title } : {} };
}

// src/mime.ts
var AMBIGUOUS_TYPES = /* @__PURE__ */ new Set([
  "",
  "application/octet-stream",
  "binary/octet-stream",
  "application/x-download",
  "application/force-download",
  "application/download",
  "application/unknown",
  "application/zip",
  "application/x-zip-compressed"
]);

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
var UTF16_LABELS = /* @__PURE__ */ new Set(["utf-16", "utf-16le", "utf-16be", "unicode", "unicodefeff", "unicodefffe", "ucs-2", "csunicode", "iso-10646-ucs-2"]);
function prescanLabel(label) {
  const lower = label.toLowerCase();
  if (UTF16_LABELS.has(lower)) return "utf-8";
  return lower === "x-user-defined" ? "windows-1252" : lower;
}
var META_TAG = /<meta\b(?:[^>"']|"[^"]*(?:"|$)|'[^']*(?:'|$))*(?:>|$)/gi;
var TAG_ATTRIBUTE = /([^\s"'<>/=]+)(?:\s*=\s*(?:"([^"]*)(?:"|$)|'([^']*)(?:'|$)|([^\s"'=<>`]+)))?/g;
function metaAttributes(tag) {
  const attrs = /* @__PURE__ */ new Map();
  for (const m of tag.slice(5).matchAll(TAG_ATTRIBUTE)) {
    const value = m[2] ?? m[3] ?? m[4];
    const name = m[1].toLowerCase();
    if (value !== void 0 && !attrs.has(name)) attrs.set(name, value);
  }
  return attrs;
}
function charsetFromHtml(head) {
  for (const [tag] of head.slice(0, 4096).matchAll(META_TAG)) {
    const attrs = metaAttributes(tag);
    const direct = attrs.get("charset")?.trim();
    if (direct) return prescanLabel(direct);
    if (attrs.get("http-equiv")?.trim().toLowerCase() !== "content-type") continue;
    const pragma = charsetFromContentType(attrs.get("content") ?? "");
    if (pragma) return prescanLabel(pragma);
  }
  return void 0;
}
var XML_DECLARATION = /^\s*<\?xml\b[^>]*?\bencoding\s*=\s*["']([A-Za-z0-9._:-]+)["']/;
function charsetFromXmlDeclaration(bytes) {
  const label = XML_DECLARATION.exec(bytes.subarray(0, 256).toString("latin1"))?.[1];
  return label ? prescanLabel(label) : void 0;
}
var isUtf8Label = (label) => label === "utf-8" || label === "utf8";
var SNIFFABLE_MIME = /* @__PURE__ */ new Set(["text/html", "application/xhtml+xml", ...AMBIGUOUS_TYPES]);
function readsAsUtf8(text) {
  let valid = 0;
  let replaced = 0;
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    if (c < 128 || c >= 56320 && c <= 57343) continue;
    if (c === 65533) replaced++;
    else valid++;
  }
  return valid > replaced;
}
function decodeUtf8OrCp1252(bytes) {
  const decoder = new TextDecoder("utf-8", { fatal: true });
  let text;
  try {
    text = decoder.decode(bytes, { stream: true });
  } catch {
    const lenient = new TextDecoder("utf-8").decode(bytes);
    return readsAsUtf8(lenient) ? lenient : decodeCp1252(bytes);
  }
  try {
    return text + decoder.decode();
  } catch {
    return /[\x80-\uffff]/.test(text) ? text : decodeCp1252(bytes);
  }
}
function decodeBody(bytes, contentType = "") {
  const bom = bomEncoding(bytes);
  if (bom) return decodeWith(bytes.subarray(bom.skip), bom.encoding);
  const declared = charsetFromContentType(contentType);
  if (declared && !isUtf8Label(declared)) return decodeWith(bytes, declared);
  if (declared) return bytes.toString("utf8");
  const mime = contentType.split(";")[0].trim().toLowerCase();
  const own = charsetFromXmlDeclaration(bytes) ?? (SNIFFABLE_MIME.has(mime) ? charsetFromHtml(bytes.subarray(0, 4096).toString("latin1")) : void 0);
  if (own && !isUtf8Label(own)) return decodeWith(bytes, own);
  return decodeUtf8OrCp1252(bytes);
}
function decodeLocal(bytes, opts = {}) {
  const bom = bomEncoding(bytes);
  if (bom) return decodeWith(bytes.subarray(bom.skip), bom.encoding);
  const own = charsetFromXmlDeclaration(bytes) ?? (opts.sniffHtmlCharset === false ? void 0 : charsetFromHtml(bytes.subarray(0, 4096).toString("latin1")));
  if (own && !isUtf8Label(own)) return decodeWith(bytes, own);
  return decodeUtf8OrCp1252(bytes);
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
var CP1252_C1_RANGE = /[\x80-\x9f]/g;
var cp1252C1 = (c) => String.fromCharCode(CP1252_C1[c.charCodeAt(0) - 128]);
function decodeCp1252(bytes) {
  return bytes.toString("latin1").replace(CP1252_C1_RANGE, cp1252C1);
}
function decodeWith(bytes, encoding) {
  if (CP1252_LABELS.has(encoding)) return decodeCp1252(bytes);
  try {
    return new TextDecoder(encoding, { fatal: false }).decode(bytes);
  } catch {
    return bytes.toString("utf8");
  }
}

// src/entities.ts
var NAMED = `
  quot 22 amp 26 apos 27 lt 3c gt 3e QUOT 22 AMP 26 LT 3c GT 3e COPY a9 REG ae
  nbsp a0 iexcl a1 cent a2 pound a3 curren a4 yen a5 brvbar a6 sect a7 uml a8 copy a9 ordf aa laquo ab not ac shy ad reg ae macr af
  deg b0 plusmn b1 sup2 b2 sup3 b3 acute b4 micro b5 para b6 middot b7 cedil b8 sup1 b9 ordm ba raquo bb frac14 bc frac12 bd frac34 be iquest bf
  Agrave c0 Aacute c1 Acirc c2 Atilde c3 Auml c4 Aring c5 AElig c6 Ccedil c7 Egrave c8 Eacute c9 Ecirc ca Euml cb Igrave cc Iacute cd Icirc ce Iuml cf
  ETH d0 Ntilde d1 Ograve d2 Oacute d3 Ocirc d4 Otilde d5 Ouml d6 times d7 Oslash d8 Ugrave d9 Uacute da Ucirc db Uuml dc Yacute dd THORN de szlig df
  agrave e0 aacute e1 acirc e2 atilde e3 auml e4 aring e5 aelig e6 ccedil e7 egrave e8 eacute e9 ecirc ea euml eb igrave ec iacute ed icirc ee iuml ef
  eth f0 ntilde f1 ograve f2 oacute f3 ocirc f4 otilde f5 ouml f6 divide f7 oslash f8 ugrave f9 uacute fa ucirc fb uuml fc yacute fd thorn fe yuml ff
  OElig 152 oelig 153 Scaron 160 scaron 161 Yuml 178 fnof 192 circ 2c6 tilde 2dc
  Alpha 391 Beta 392 Gamma 393 Delta 394 Epsilon 395 Zeta 396 Eta 397 Theta 398 Iota 399 Kappa 39a Lambda 39b Mu 39c Nu 39d Xi 39e Omicron 39f
  Pi 3a0 Rho 3a1 Sigma 3a3 Tau 3a4 Upsilon 3a5 Phi 3a6 Chi 3a7 Psi 3a8 Omega 3a9
  alpha 3b1 beta 3b2 gamma 3b3 delta 3b4 epsilon 3b5 zeta 3b6 eta 3b7 theta 3b8 iota 3b9 kappa 3ba lambda 3bb mu 3bc nu 3bd xi 3be omicron 3bf
  pi 3c0 rho 3c1 sigmaf 3c2 sigma 3c3 tau 3c4 upsilon 3c5 phi 3c6 chi 3c7 psi 3c8 omega 3c9 thetasym 3d1 upsih 3d2 piv 3d6
  ensp 2002 emsp 2003 thinsp 2009 zwnj 200c zwj 200d lrm 200e rlm 200f ndash 2013 mdash 2014 lsquo 2018 rsquo 2019 sbquo 201a
  ldquo 201c rdquo 201d bdquo 201e dagger 2020 Dagger 2021 bull 2022 hellip 2026 permil 2030 prime 2032 Prime 2033 lsaquo 2039 rsaquo 203a
  oline 203e frasl 2044 euro 20ac image 2111 weierp 2118 real 211c trade 2122 alefsym 2135
  larr 2190 uarr 2191 rarr 2192 darr 2193 harr 2194 crarr 21b5 lArr 21d0 uArr 21d1 rArr 21d2 dArr 21d3 hArr 21d4
  forall 2200 part 2202 exist 2203 empty 2205 nabla 2207 isin 2208 notin 2209 ni 220b prod 220f sum 2211 minus 2212 lowast 2217 radic 221a
  prop 221d infin 221e ang 2220 and 2227 or 2228 cap 2229 cup 222a int 222b there4 2234 sim 223c cong 2245 asymp 2248 ne 2260 equiv 2261
  le 2264 ge 2265 sub 2282 sup 2283 nsub 2284 sube 2286 supe 2287 oplus 2295 otimes 2297 perp 22a5 sdot 22c5
  lceil 2308 rceil 2309 lfloor 230a rfloor 230b lang 27e8 rang 27e9 loz 25ca spades 2660 clubs 2663 hearts 2665 diams 2666
`;
var INVISIBLE = /* @__PURE__ */ new Set([173, 8203, 8204, 8205, 8206, 8207, 8288, 65279]);
var charFor = (cp) => INVISIBLE.has(cp) ? "" : String.fromCodePoint(cp);
var ENTITY_BY_NAME = /* @__PURE__ */ new Map();
{
  const parts = NAMED.trim().split(/\s+/);
  for (let i = 0; i < parts.length; i += 2) ENTITY_BY_NAME.set(parts[i], charFor(Number.parseInt(parts[i + 1], 16)));
  ENTITY_BY_NAME.set("nbsp", " ");
}
var ENTITY_RE = /&(#[xX][0-9a-fA-F]+|#\d+|[a-zA-Z][a-zA-Z0-9]*);/g;
function numericChar(n) {
  if (n >= 128 && n <= 159) return String.fromCodePoint(CP1252_C1[n - 128]);
  if (n === 0 || !(n <= 1114111) || n >= 55296 && n <= 57343) return "\uFFFD";
  return charFor(n);
}
function decodeEntities(s) {
  return s.replace(ENTITY_RE, (m, ref) => {
    if (ref[0] !== "#") return ENTITY_BY_NAME.get(ref) ?? m;
    return numericChar(ref[1] === "x" || ref[1] === "X" ? Number.parseInt(ref.slice(2), 16) : Number(ref.slice(1)));
  });
}

// src/html.ts
var BLOCK_TAGS = /* @__PURE__ */ new Set([
  "p",
  "div",
  "section",
  "article",
  "li",
  "tr",
  "td",
  "th",
  "ul",
  "ol",
  "pre",
  "blockquote",
  "table",
  "caption",
  "dl",
  "dt",
  "dd",
  "header",
  "footer",
  "nav",
  "aside",
  "main",
  "search",
  "figure",
  "figcaption",
  "details",
  "summary",
  "address",
  "form",
  "fieldset",
  "legend",
  "hgroup",
  "center",
  "dialog",
  "menu"
]);
var INLINE_TAGS = /* @__PURE__ */ new Set([
  "a",
  "abbr",
  "acronym",
  "b",
  "bdi",
  "bdo",
  "big",
  "cite",
  "code",
  "data",
  "del",
  "dfn",
  "em",
  "font",
  "i",
  "ins",
  "kbd",
  "label",
  "mark",
  "nobr",
  "q",
  "s",
  "samp",
  "small",
  "span",
  "strike",
  "strong",
  "sub",
  "sup",
  "time",
  "tt",
  "u",
  "var",
  "wbr"
]);
var TAG_RE = /<[a-zA-Z!/?][^<>"']*(?:(?:"[^"]*"|'[^']*')[^<>"']*)*>/g;
var LOOSE_TAG_RE = /<[a-zA-Z!/?][^<>]*>/g;
var tagName = (tag) => /^<\/?([a-zA-Z][^\s/>]*)/.exec(tag)?.[1]?.toLowerCase() ?? "";
var CLOSE_TAG_RE = /* @__PURE__ */ new Map();
function closeTagRe(name) {
  let re = CLOSE_TAG_RE.get(name);
  if (!re) CLOSE_TAG_RE.set(name, re = new RegExp(`</${name}\\s*>`, "gi"));
  return re;
}
function htmlAttributes(tag) {
  const attrs = /* @__PURE__ */ new Map();
  for (const m of tag.matchAll(/(?<![^\s"'<>/=])([^\s"'<>/=]+)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+))/g)) {
    const name = m[1].toLowerCase();
    if (!attrs.has(name)) attrs.set(name, m[2] ?? m[3] ?? m[4] ?? "");
  }
  return attrs;
}
var RCDATA_ELEMENTS = /* @__PURE__ */ new Set(["title"]);
function dropElements(html, names, toEof = /* @__PURE__ */ new Set()) {
  const drop = new Set(names);
  const open = new RegExp(`<!--|${TAG_RE.source}|<(${names.join("|")})(?=[\\s/>])`, "gi");
  const unclosed = /* @__PURE__ */ new Set();
  let out = "";
  let last = 0;
  let m;
  while (m = open.exec(html)) {
    const tag = m[0];
    const name = m[1]?.toLowerCase() ?? (tag === "<!--" ? "!--" : tag[1] === "/" ? "" : tagName(tag));
    const opaque = !drop.has(name) && RCDATA_ELEMENTS.has(name);
    if (name !== "!--" && !drop.has(name) && !opaque || unclosed.has(name)) continue;
    let end;
    if (name === "!--") {
      const close = html.indexOf("-->", m.index + 2);
      end = close < 0 ? -1 : close + 3;
    } else {
      const close = closeTagRe(name);
      close.lastIndex = open.lastIndex;
      const c = close.exec(html);
      end = c ? c.index + c[0].length : toEof.has(name) ? html.length : -1;
    }
    if (end < 0) {
      unclosed.add(name);
      continue;
    }
    if (!opaque) {
      out += html.slice(last, m.index) + " ";
      last = end;
    }
    open.lastIndex = end;
  }
  return last === 0 ? html : out + html.slice(last);
}
function balancedRegions(html, tag, isCandidate) {
  const re = new RegExp(`<${tag}(?=[\\s/>])(?:[^<>"']|"[^"]*"|'[^']*')*>|</${tag}\\s*>`, "gi");
  const stack = [];
  const out = [];
  let m;
  while (m = re.exec(html)) {
    if (m[0][1] === "/") {
      const top = stack.pop();
      if (top?.open) out.push({ start: top.start, end: m.index, from: top.from, to: re.lastIndex, open: top.open });
    } else {
      stack.push({ start: re.lastIndex, from: m.index, open: isCandidate(m[0]) ? m[0] : void 0 });
    }
  }
  return out;
}
function dropLandmarks(html, roles) {
  const role = `\\srole\\s*=\\s*["']?(?:${roles.join("|")})(?=["'\\s/>])`;
  const hasRole = new RegExp(role, "i");
  const names = /* @__PURE__ */ new Set();
  for (const m of html.matchAll(new RegExp(`<([a-zA-Z][a-zA-Z0-9-]*)(?=[\\s/>])[^<>]*${role}`, "gi"))) names.add(m[1].toLowerCase());
  if (!names.size) return html;
  const regions = [...names].flatMap((name) => balancedRegions(html, name, (open) => hasRole.test(open))).sort((a, b) => a.from - b.from);
  let out = "";
  let last = 0;
  for (const r of regions) {
    if (r.from < last) continue;
    out += `${html.slice(last, r.from)} `;
    last = r.to;
  }
  return last === 0 ? html : out + html.slice(last);
}
var CHROME_ROLES = ["navigation", "banner", "contentinfo"];
var HIDDEN_ELEMENTS = ["script", "style", "noscript", "head", "svg", "template", "select", "datalist"];
var CHROME_ELEMENTS = ["nav", "footer"];
var RAW_TEXT_ELEMENTS = /* @__PURE__ */ new Set(["script", "style"]);

// src/retry.ts
var maxAttempts = () => envInt("MAX_ATTEMPTS", 2, 1, 5);
var defaultRetryMs = () => envInt("RETRY_MS", 600, 0, 5e3);
var RETRY_AFTER_CAP_MS = 5e3;
function retryDelayMs(retryAfterMs) {
  if (retryAfterMs === void 0) return defaultRetryMs();
  return retryAfterMs <= RETRY_AFTER_CAP_MS ? retryAfterMs : void 0;
}
var PERMANENT_CODES = /* @__PURE__ */ new Set([
  "ENOTFOUND",
  "ERR_INVALID_URL",
  "ERR_TLS_CERT_ALTNAME_INVALID",
  "CERT_HAS_EXPIRED",
  "DEPTH_ZERO_SELF_SIGNED_CERT",
  "SELF_SIGNED_CERT_IN_CHAIN",
  "UNABLE_TO_VERIFY_LEAF_SIGNATURE",
  "UNABLE_TO_GET_ISSUER_CERT_LOCALLY"
]);
var PERMANENT_MESSAGE = /redirect count exceeded|scheme must be|unknown scheme|bad port|invalid url|failed to parse url/i;
function isPermanentFailure(e) {
  const err = e;
  const code = err?.cause?.code ?? err?.code;
  if (typeof code === "string" && PERMANENT_CODES.has(code)) return true;
  return [err?.message, err?.cause?.message].some((m) => typeof m === "string" && PERMANENT_MESSAGE.test(m));
}

// src/tables.ts
function fragmentText(html) {
  return decodeEntities(html.replace(TAG_RE, (tag) => INLINE_TAGS.has(tagName(tag)) ? "" : " ").replace(LOOSE_TAG_RE, " "));
}
var collapse = (s) => s.replace(/\s+/g, " ").trim();
function spanAttr(attrs, name) {
  const n = Number.parseInt(attrs.get(name) ?? "", 10);
  return Number.isFinite(n) && n >= 1 ? Math.min(n, 100) : 1;
}
var MAX_SLOTS = 1e6;
function expand(rows) {
  const grid = rows.map(() => []);
  let slots = 0;
  for (let r = 0; r < rows.length; r++) {
    const out = grid[r];
    let c = 0;
    for (const cell2 of rows[r]) {
      while (out[c] !== void 0) c++;
      const down = Math.min(cell2.rowspan, rows.length - r);
      slots += down * cell2.colspan;
      if (slots > MAX_SLOTS) return void 0;
      for (let j = 0; j < down; j++) for (let i = 0; i < cell2.colspan; i++) grid[r + j][c + i] = cell2.text;
      c += cell2.colspan;
    }
  }
  const width = grid.reduce((w, row) => Math.max(w, row.length), 0);
  if (width * grid.length > MAX_SLOTS) return void 0;
  return grid.map((row) => Array.from({ length: width }, (_, i) => row[i] ?? ""));
}
function extractTables(html) {
  const src = dropElements(html, NOT_RENDERED, RAW_TEXT_ELEMENTS);
  const tag = /<(\/?)(table|caption|thead|tbody|tfoot|tr|td|th)(?=[\s/>])(?:[^<>"']|"[^"]*"|'[^']*')*>/gi;
  const done = [];
  const stack = [];
  let order = 0;
  let last = 0;
  let buried = 0;
  let m;
  while (m = tag.exec(src)) {
    const top = stack[stack.length - 1];
    if (top) top.text(src.slice(last, m.index));
    last = tag.lastIndex;
    const closing = m[1] === "/";
    const name = m[2].toLowerCase();
    if (top && (buried || name === "table" && !closing && stack.length >= MAX_DEPTH)) {
      if (name === "table") buried += closing ? -1 : 1;
      top.text(" ");
      continue;
    }
    if (name === "table") {
      if (!closing) stack.push(new OpenTable(order++));
      else if (top) closeTable(stack, done);
      continue;
    }
    if (!top) continue;
    if (name === "td" || name === "th") {
      if (closing) top.endCell();
      else top.startCell(name === "th", htmlAttributes(m[0]));
    } else if (name === "tr") {
      top.endRow();
      if (!closing) top.startRow();
    } else if (name === "caption") {
      top.endRow();
      top.inCaption = !closing;
    } else {
      top.endRow();
      top.inHead = name === "thead" && !closing;
    }
  }
  while (stack.length) closeTable(stack, done);
  return done.sort((a, b) => a.order - b.order).map((d) => d.table);
}
var NOT_RENDERED = ["script", "style", "template", "svg", "select", "datalist"];
var MAX_DEPTH = 8;
var OpenTable = class {
  constructor(order) {
    this.order = order;
  }
  order;
  rows = [];
  caption = [];
  inCaption = false;
  inHead = false;
  row;
  cell;
  /** Text between two table tags: it belongs to the open cell, else the caption. */
  text(fragment) {
    if (this.cell) this.cell.parts.push(fragmentText(fragment));
    else if (this.inCaption) this.caption.push(fragmentText(fragment));
  }
  /** A nested table's text, already clean, joins the cell that holds it. */
  nested(text) {
    this.cell?.parts.push(` ${text} `);
  }
  startRow() {
    this.inCaption = false;
    this.row = { cells: [], head: this.inHead };
  }
  startCell(header2, attrs) {
    this.endCell();
    if (!this.row) this.startRow();
    this.cell = { parts: [], header: header2, colspan: spanAttr(attrs, "colspan"), rowspan: spanAttr(attrs, "rowspan") };
  }
  endCell() {
    if (!this.cell || !this.row) return;
    const { parts, header: header2, colspan, rowspan } = this.cell;
    this.row.cells.push({ text: collapse(parts.join("")), header: header2, colspan, rowspan });
    this.cell = void 0;
  }
  endRow() {
    this.endCell();
    if (this.row?.cells.length) this.rows.push(this.row);
    this.row = void 0;
  }
};
function closeTable(stack, done) {
  const t = stack.pop();
  t.endRow();
  const caption = collapse(t.caption.join(""));
  const table = buildTable(t.rows, caption);
  if (table) done.push({ order: t.order, table });
  const flat = [caption, ...t.rows.flatMap((r) => r.cells.map((c) => c.text))].filter(Boolean).join(" ");
  stack[stack.length - 1]?.nested(flat);
}
function buildTable(rows, caption) {
  if (!rows.length) return void 0;
  const grid = expand(rows.map((r) => r.cells));
  if (!grid) return void 0;
  let headers = [];
  let body = grid;
  if (rows.some((r) => r.head)) {
    const head = grid.filter((_, i) => rows[i].head);
    headers = head[0].map((_, c) => [...new Set(head.map((r) => r[c]).filter(Boolean))].join(" "));
    body = grid.filter((_, i) => !rows[i].head);
  } else if (isHeaderRow(rows[0].cells)) {
    headers = grid[0];
    body = grid.slice(1);
  }
  if (!body.length) return void 0;
  return { ...caption ? { caption } : {}, headers, rows: body };
}
function isHeaderRow(cells) {
  return cells.some((c) => c.header) && cells.every((c) => c.header || !c.text);
}
function tableToMarkdown(table) {
  const width = table.rows.reduce((w, r) => Math.max(w, r.length), Math.max(table.headers.length, 1));
  const esc = (s) => s.replace(/\|/g, "\\|");
  const line = (cells) => `| ${Array.from({ length: width }, (_, i) => esc(cells[i] ?? "")).join(" | ")} |`;
  const out = [];
  if (table.caption) out.push(`**${table.caption}**`, "");
  out.push(line(table.headers.length ? table.headers : Array.from({ length: width }, () => "")));
  out.push(`|${" --- |".repeat(width)}`);
  for (const row of table.rows) out.push(line(row));
  return out.join("\n");
}

// src/markdown.ts
function htmlToMarkdown(html, opts = {}) {
  return markdownAgainst(html, documentBaseUrl(withoutNul(html), opts.baseUrl), opts.fullPage);
}
function markdownAgainst(html, base2, fullPage) {
  const src = withoutNul(html);
  const hidden = fullPage ? HIDDEN_ELEMENTS : [...HIDDEN_ELEMENTS, ...CHROME_ELEMENTS];
  let s = dropElements(src, hidden, RAW_TEXT_ELEMENTS);
  if (!fullPage) s = dropLandmarks(s, CHROME_ROLES);
  const tables = /* @__PURE__ */ new Map();
  if (TABLE_OPEN.test(s)) for (const r of balancedRegions(s, "table", () => true)) tables.set(r.from, r);
  const w = new Writer();
  const tag = new RegExp(TAG_RE.source, "g");
  const headingEdge = new RegExp(HEADING_EDGE.source, "gi");
  let preUnclosed = false;
  let headingEnd = -1;
  const divs = [];
  let divOverflow = 0;
  let prevEnd = -1;
  let prevClosed = false;
  let last = 0;
  let m;
  while (m = tag.exec(s)) {
    if (m.index > last) w.text(s.slice(last, m.index));
    last = tag.lastIndex;
    const t = m[0];
    const closing = t[1] === "/";
    const adjacent = m.index === prevEnd && prevClosed && !closing;
    prevEnd = tag.lastIndex;
    prevClosed = closing;
    const name = tagName(t);
    if (!name) continue;
    if (name === "div") {
      if (closing) {
        if (divOverflow) divOverflow--;
        else divs.pop();
      } else if (divs.length < MAX_BLOCK_DEPTH * 4) divs.push(t);
      else divOverflow++;
    }
    const heading = /^h[1-6]$/.test(name) ? Number(name[1]) : 0;
    if (w.heading) {
      if (heading) {
        w.flush();
        headingEnd = -1;
        if (closing) continue;
      } else if (BLOCK_TAGS.has(name) || name === "br" || name === "hr") {
        if (headingEnd >= 0 && m.index < headingEnd) {
          w.space();
          continue;
        }
        w.flush();
        headingEnd = -1;
      }
    }
    if (heading) {
      w.flush();
      if (closing) continue;
      w.heading = heading;
      headingEdge.lastIndex = tag.lastIndex;
      const edge = headingEdge.exec(s);
      headingEnd = edge && edge[0][1] === "/" ? edge.index : -1;
      continue;
    }
    if (name === "pre" && !closing && !preUnclosed) {
      const close = closeTagRe("pre");
      close.lastIndex = tag.lastIndex;
      const c = close.exec(s);
      if (c) {
        w.flush();
        w.codeBlock(s.slice(tag.lastIndex, c.index), codeLanguage(t, s.slice(tag.lastIndex, c.index), divs));
        last = tag.lastIndex = prevEnd = c.index + c[0].length;
        prevClosed = true;
        continue;
      }
      preUnclosed = true;
    }
    if (name === "table" && !closing) {
      const region = tables.get(m.index);
      const table = region && !isLayoutTable(t, s, region) ? extractTables(s.slice(region.from, region.to))[0] : void 0;
      if (region && table) {
        w.flush();
        const escaped = {
          ...table.caption ? { caption: escapeText(table.caption) } : {},
          headers: table.headers.map((cell2) => escapeText(cell2)),
          rows: table.rows.map((row) => row.map((cell2) => escapeText(cell2)))
        };
        w.block(tableToMarkdown(escaped).split("\n"));
        last = tag.lastIndex = prevEnd = region.to;
        prevClosed = true;
        continue;
      }
    }
    switch (name) {
      case "ul":
      case "ol":
        w.flush();
        if (closing) w.closeList();
        else w.openList(name === "ol", listStart(t));
        continue;
      case "li":
        w.flush();
        if (closing) w.closeItem();
        else w.openItem();
        continue;
      case "blockquote":
        w.flush();
        if (closing) w.closeQuote();
        else w.openQuote();
        continue;
      case "hr":
        w.flush();
        w.rule();
        continue;
      case "br":
        w.hardBreak();
        continue;
      case "img":
        w.image(htmlAttributes(t), base2);
        continue;
    }
    const kind = INLINE_KIND[name];
    if (kind) {
      if (closing) {
        w.close(kind);
        continue;
      }
      if (adjacent) w.space();
      if (kind === "a") {
        w.close("a");
        const href = htmlAttributes(t).get("href");
        w.open("a", linkTarget(href, base2), href?.trimStart().startsWith("#"));
      } else w.open(kind);
      continue;
    }
    if (BLOCK_TAGS.has(name)) w.flush();
    else if (INLINE_TAGS.has(name)) {
      if (adjacent) w.space();
    } else w.space();
  }
  if (last < s.length) w.text(s.slice(last));
  return w.finish();
}
var NUL = "\0";
function withoutNul(html) {
  return html.includes(NUL) ? html.split(NUL).join("\uFFFD") : html;
}
var TABLE_OPEN = /<table[\s/>]/i;
var HEADING_EDGE = /<\/h[1-6]\s*>|<h[1-6](?=[\s/>])/;
var MAX_BLOCK_DEPTH = 24;
var MAX_INLINE_DEPTH = 16;
var INLINE_KIND = {
  a: "a",
  em: "em",
  i: "em",
  strong: "strong",
  b: "strong",
  code: "code",
  kbd: "code",
  samp: "code",
  tt: "code"
};
var Writer = class {
  heading = 0;
  lines = [];
  blocks = [];
  blockOverflow = 0;
  parts = [];
  frames = [];
  pendingSpace = false;
  needBlank = false;
  /** The list closed last: its container's depth, its kind, and how many lines were written by then. */
  closedList;
  /** An emphasis just written that ends in punctuation, whose closing marker a letter pushed next would spoil. */
  flanked;
  text(raw) {
    const decoded = decodeEntities(raw.includes("<") ? raw.replace(LOOSE_TAG_RE, " ") : raw).replace(HTML_SPACE, " ");
    if (!decoded) return;
    const core = decoded.trim();
    if (decoded[0] === " ") this.space();
    if (core) this.push(this.inCode() ? core : escapeText(core, { before: this.joinsBefore(decoded[0] !== " "), after: decoded[decoded.length - 1] !== " " }));
    if (core && decoded[decoded.length - 1] === " ") this.space();
  }
  space() {
    if (this.parts.length) this.pendingSpace = true;
  }
  hardBreak() {
    if (this.heading || this.inCode()) this.space();
    else if (this.parts.length) {
      this.parts.push("\n");
      this.pendingSpace = false;
    }
  }
  open(kind, href, self) {
    if (this.frames.length >= MAX_INLINE_DEPTH) return;
    const inert = kind === "a" && href === void 0 || this.inCode() || kind !== "a" && this.frames.some((f) => f.kind === kind);
    this.frames.push({ kind, start: this.parts.length, ...href !== void 0 ? { href } : {}, ...self ? { self } : {}, ...inert ? { inert } : {} });
  }
  /** Close the innermost open `kind`, and whatever opened inside it and never closed. */
  close(kind) {
    let i = this.frames.length - 1;
    while (i >= 0 && this.frames[i].kind !== kind) i--;
    if (i < 0) return;
    while (this.frames.length > i) this.wrap(this.frames.pop());
  }
  image(attrs, base2) {
    const candidates = [attrs.get("src"), attrs.get("data-src"), attrs.get("data-original"), attrs.get("srcset")?.trim().split(/\s+/)[0]];
    const src = candidates.map((c) => linkTarget(c, base2)).find((u) => u !== void 0);
    const pixel = ["width", "height"].some((d) => /^[01]$/.test(attrs.get(d)?.trim() ?? ""));
    if (!src || pixel || this.inCode()) {
      this.space();
      return;
    }
    const alt = decodeEntities(attrs.get("alt") ?? "").replace(HTML_SPACE, " ").trim();
    this.push(`![${escapeText(alt)}](${destination(src)})`);
  }
  codeBlock(inner, lang) {
    const body = decodeEntities(inner.replace(/<br\s*\/?>/gi, "\n").replace(LOOSE_TAG_RE, "")).replace(/\r\n?/g, "\n").replace(/^\n/, "").trimEnd();
    if (!body.trim()) return;
    const fence = "`".repeat(Math.max(3, longestRun(body, "`") + 1));
    this.block([fence + lang, ...body.split("\n"), fence]);
  }
  rule() {
    this.block(["***"]);
  }
  openList(ordered, start) {
    const top = this.blocks[this.blocks.length - 1];
    if (top?.kind === "list" && top.items && this.blocks.length + 1 < MAX_BLOCK_DEPTH) this.blocks.push({ kind: "item", marker: top.last, first: false });
    if (!this.room()) return;
    const item = this.blocks[this.blocks.length - 1];
    if (item?.kind === "item" && !item.first && (!ordered || start === 1)) this.needBlank = false;
    const prev = this.closedList;
    const alt = prev !== void 0 && prev.depth === this.blocks.length && prev.ordered === ordered && prev.lines === this.lines.length && !prev.alt;
    this.blocks.push({ kind: "list", ordered, alt, next: start, items: 0, last: "" });
  }
  closeList() {
    if (this.blockOverflow) {
      this.blockOverflow--;
      return;
    }
    const i = this.nearest("list");
    if (i < 0) return;
    const { ordered, alt } = this.blocks[i];
    this.closedList = { depth: i, ordered, alt, lines: this.lines.length };
    this.blocks.length = i;
    this.needBlank = true;
  }
  openItem() {
    if (this.blockOverflow) {
      this.blockOverflow++;
      return;
    }
    let list = this.nearest("list");
    if (list >= 0) this.blocks.length = list + 1;
    else {
      if (!this.room()) return;
      this.blocks.push({ kind: "list", ordered: false, alt: false, next: 1, items: 0, last: "" });
      list = this.blocks.length - 1;
    }
    if (!this.room()) return;
    const owner = this.blocks[list];
    const marker = owner.ordered ? `${owner.next++}${owner.alt ? ")" : "."} ` : owner.alt ? "+ " : "- ";
    owner.last = marker;
    this.blocks.push({ kind: "item", marker, first: true });
    if (owner.items++) this.needBlank = false;
  }
  closeItem() {
    if (this.blockOverflow) {
      this.blockOverflow--;
      return;
    }
    for (let i = this.blocks.length - 1; i >= 0; i--) {
      const kind = this.blocks[i].kind;
      if (kind === "list") return;
      if (kind === "item") {
        this.blocks.length = i;
        return;
      }
    }
  }
  openQuote() {
    if (this.room()) this.blocks.push({ kind: "quote", first: true });
  }
  closeQuote() {
    if (this.blockOverflow) {
      this.blockOverflow--;
      return;
    }
    const i = this.nearest("quote");
    if (i < 0) return;
    this.blocks.length = i;
    this.needBlank = true;
  }
  /**
   * End the paragraph or heading in progress and write it out. The inline
   * elements still open close over the text so far and reopen for what
   * follows, so a link wrapped round a heading and a paragraph — a card —
   * links both.
   */
  flush() {
    const open = this.frames.map((f) => ({ ...f }));
    while (this.frames.length) this.wrap(this.frames.pop());
    const text = this.parts.join("");
    this.parts = [];
    this.flanked = void 0;
    this.pendingSpace = false;
    this.frames = open.map((f) => ({ ...f, start: 0 }));
    const level = this.heading;
    this.heading = 0;
    if (level) {
      const title = text.replace(/\s+/g, " ").trim();
      if (title) this.block([`${"#".repeat(level)} ${title.replace(/(^|\s)(#+)$/, "$1\\$2")}`]);
      return;
    }
    let para = [];
    for (const raw of `${text}

`.split("\n")) {
      const line = raw.trim();
      if (line) {
        para.push(escapeLineStart(line));
        continue;
      }
      if (!para.length) continue;
      this.block(para.map((l, i) => i < para.length - 1 ? `${l}  ` : l));
      para = [];
    }
  }
  /** Write finished lines under the open blocks' prefixes, a blank line before them where one is due. */
  block(content) {
    if (!content.length) return;
    if (this.needBlank && this.lines.length) this.lines.push(this.prefix(false).trimEnd());
    for (const line of content) {
      const prefix = this.prefix(true);
      this.lines.push(line ? prefix + line : prefix.trimEnd());
    }
    this.needBlank = true;
  }
  finish() {
    this.flush();
    return this.lines.join("\n").trimEnd();
  }
  push(markdown) {
    const f = this.flanked;
    this.flanked = void 0;
    if (f && !this.pendingSpace && f.at === this.parts.length - 1 && FLANK_WORD.test(markdown[0] ?? "")) {
      this.parts[f.at] = flank(f.marker, f.core, f.start, true);
    }
    if (this.pendingSpace) this.parts.push(" ");
    this.pendingSpace = false;
    this.parts.push(markdown);
  }
  inCode() {
    return this.frames.some((f) => f.kind === "code");
  }
  /**
   * Whether text pushed next will stand straight after something other than
   * a space or a line start: the text before it, when `touching` it, or the
   * marker of an emphasis or link that opens where it starts (the marker goes
   * in when the element closes, and moves the element's leading space outside).
   */
  joinsBefore(touching) {
    const last = this.parts[this.parts.length - 1];
    if (touching && !this.pendingSpace && last !== void 0 && last !== "\n") return true;
    return this.frames.some((f) => !f.inert && f.start === this.parts.length);
  }
  /** Replace an element's text with its Markdown, its outer whitespace kept outside it. */
  wrap(f) {
    if (f.inert) return;
    const trailing = this.pendingSpace;
    this.pendingSpace = false;
    if (this.flanked && this.flanked.at >= f.start) this.flanked = void 0;
    const content = this.parts.splice(f.start).join("");
    const core = content.trim();
    const lead = content.slice(0, content.length - content.trimStart().length);
    const trail = content.slice(content.trimEnd().length);
    this.whitespace(lead);
    if (core) {
      let markdown = wrapInline(f, core, this.heading > 0);
      const last = this.parts.length - 1;
      if (f.kind === "a" && markdown && !this.pendingSpace && this.parts[last]?.endsWith("!")) this.parts[last] = `${this.parts[last].slice(0, -1)}\\!`;
      const marker = f.kind === "em" ? "*" : f.kind === "strong" ? "**" : "";
      if (marker) {
        const start = !this.pendingSpace && FLANK_WORD.test(this.parts[last]?.slice(-1) ?? "") && FLANK_PUNCT.test(core[0]);
        if (start) markdown = flank(marker, core, true, false);
        this.push(markdown);
        if (FLANK_PUNCT.test(core[core.length - 1])) this.flanked = { at: this.parts.length - 1, marker, core, start };
      } else this.push(markdown);
    }
    this.whitespace(trail);
    if (trailing) this.space();
  }
  whitespace(ws) {
    if (ws.includes("\n")) {
      if (this.parts.length) this.parts.push("\n");
      this.pendingSpace = false;
    } else if (ws) this.space();
  }
  prefix(consume) {
    let p = "";
    for (const b of this.blocks) {
      if (b.kind === "quote") {
        if (consume || !b.first) p += "> ";
        if (consume) b.first = false;
      } else if (b.kind === "item") {
        p += b.first && consume ? b.marker : " ".repeat(b.marker.length);
        if (consume) b.first = false;
      }
    }
    return p;
  }
  nearest(kind) {
    for (let i = this.blocks.length - 1; i >= 0; i--) if (this.blocks[i].kind === kind) return i;
    return -1;
  }
  /** Whether one more block may nest; past the bound it is counted instead, and its close uncounted. */
  room() {
    if (this.blocks.length < MAX_BLOCK_DEPTH) return true;
    this.blockOverflow++;
    return false;
  }
};
var FLANK_PUNCT = /[\p{P}\p{S}]/u;
var FLANK_WORD = /[^\s\p{P}\p{S}]/u;
var MARKUP_CHARS = "\\*`[]";
function flank(marker, core, start, end) {
  const link = core.includes("](");
  const movable = (i) => {
    const c = core[i];
    if (!(c === " " || FLANK_PUNCT.test(c)) || MARKUP_CHARS.includes(c) || core[i - 1] === "\\") return false;
    return c === "(" || c === ")" ? !link : !(c === "!" && core[i + 1] === "[");
  };
  let from = 0;
  let to = core.length;
  if (start) while (from < to && movable(from)) from++;
  if (end) while (to > from && movable(to - 1)) to--;
  if (from === to) return core;
  return `${core.slice(0, from)}${marker}${core.slice(from, to)}${marker}${core.slice(to)}`;
}
var PERMALINK_TEXT = /^(?:¶|#|§|🔗)$/u;
function wrapInline(f, core, inHeading) {
  switch (f.kind) {
    case "em":
      return `*${core}*`;
    case "strong":
      return `**${core}**`;
    case "code": {
      const code = core.replace(/\s+/g, " ");
      const ticks = "`".repeat(longestRun(code, "`") + 1);
      const pad2 = code[0] === "`" || code[code.length - 1] === "`" ? " " : "";
      return `${ticks}${pad2}${code}${pad2}${ticks}`;
    }
    default:
      if (inHeading && PERMALINK_TEXT.test(core)) return "";
      if (inHeading && f.self) return core;
      return `[${core.replace(/\n{2,}/g, "\n")}](${destination(f.href)})`;
  }
}
var HTML_SPACE = /[ \t\n\r\f]+/g;
var ALWAYS_SYNTAX = /[\\`*[\]]/g;
var EDGE_UNDERSCORE = /(?<![\p{L}\p{N}])_|_(?![\p{L}\p{N}])/gu;
var HTML_LIKE = /<(?=[a-zA-Z/!?])/g;
var ENTITY_LIKE = /&(?=#?[a-zA-Z0-9]+;)/g;
var STRIKE = /~(?=~)|(?<=[^\t\n\f\r\p{Zs}])~/gu;
var OPEN_END = /(?:<|&#?[a-zA-Z0-9]*)$/;
function escapeText(s, edges) {
  let out = s.replace(ALWAYS_SYNTAX, "\\$&").replace(EDGE_UNDERSCORE, "\\_").replace(HTML_LIKE, "\\<").replace(ENTITY_LIKE, "\\&").replace(STRIKE, "\\~");
  if (edges?.after) out = out.replace(OPEN_END, "\\$&");
  if (edges?.before && out[0] === "~") out = `\\${out}`;
  return out;
}
function escapeLineStart(line) {
  const c = line[0];
  if (c === "#") return /^#{1,6}(?:\s|$)/.test(line) ? `\\${line}` : line;
  if (c === ">") return `\\${line}`;
  if (c === "-" || c === "+" || c === "=") return /^[-+=](?:\s|$)/.test(line) || /^(?:[-=]\s*)+$/.test(line) ? `\\${line}` : line;
  const ordered = /^(\d{1,9})[.)](?=\s|$)/.exec(line);
  return ordered ? `${ordered[1]}\\${line.slice(ordered[1].length)}` : line;
}
function longestRun(s, ch) {
  let best = 0;
  let run = 0;
  for (let i = 0; i < s.length; i++) {
    run = s[i] === ch ? run + 1 : 0;
    if (run > best) best = run;
  }
  return best;
}
function linkTarget(raw, base2) {
  const href = raw === void 0 ? "" : afterControls(decodeEntities(raw).replace(/[\t\n\r]/g, "")).trim();
  if (!href || UNFOLLOWABLE.test(href)) return void 0;
  try {
    const url = new URL(href, base2);
    return UNFOLLOWABLE.test(url.protocol) ? void 0 : url.href;
  } catch {
    return base2 === void 0 ? href : void 0;
  }
}
var UNFOLLOWABLE = /^(?:javascript|vbscript|data):/i;
function afterControls(s) {
  let i = 0;
  while (i < s.length && s.charCodeAt(i) <= 32) i++;
  return s.slice(i);
}
function destination(url) {
  const d = url.replace(/[ <>\\]/g, (c) => encodeURIComponent(c));
  let depth = 0;
  for (const c of d) {
    if (c === "(") depth++;
    else if (c === ")" && --depth < 0) break;
  }
  return depth === 0 ? d : d.replace(/[()]/g, "\\$&");
}
var BASE_TAG = /<base(?=[\s/>])[^<>"']*(?:(?:"[^"]*"|'[^']*')[^<>"']*)*>/gi;
function documentBaseUrl(html, pageUrl) {
  if (!/<base[\s/>]/i.test(html)) return pageUrl;
  for (const m of dropElements(html, ["script", "style", "template"], RAW_TEXT_ELEMENTS).matchAll(BASE_TAG)) {
    const href = htmlAttributes(m[0]).get("href");
    if (href === void 0) continue;
    try {
      const base2 = new URL(decodeEntities(href).trim(), pageUrl);
      return base2.protocol === "data:" || base2.protocol === "javascript:" ? pageUrl : base2.href;
    } catch {
      return pageUrl;
    }
  }
  return pageUrl;
}
var LANGUAGE_CLASS = /(?:^|\s)(?:(?:language|lang|highlight(?:-source)?)-|brush:\s*)([\w+#.-]+)/i;
var NO_LANGUAGE = /* @__PURE__ */ new Set(["none", "nohighlight", "plaintext"]);
function codeLanguage(pre, inner, divs) {
  const code = /^\s*(<code(?=[\s/>])[^<>]*>)/i.exec(inner)?.[1];
  for (const t of [pre, code, divs[divs.length - 1], divs[divs.length - 2]]) {
    if (!t) continue;
    const lang = LANGUAGE_CLASS.exec(htmlAttributes(t).get("class") ?? "")?.[1]?.toLowerCase();
    if (lang && !NO_LANGUAGE.has(lang)) return lang;
  }
  return "";
}
function isLayoutTable(open, html, region) {
  if (/^(?:presentation|none)$/i.test(htmlAttributes(open).get("role")?.trim() ?? "")) return true;
  const inner = new RegExp(LAYOUT_INSIDE.source, "gi");
  inner.lastIndex = region.start;
  const next = inner.exec(html);
  return next !== null && next.index < region.end;
}
var LAYOUT_INSIDE = /<(?:table|pre)[\s/>]/;
function listStart(open) {
  const n = Number.parseInt(htmlAttributes(open).get("start") ?? "", 10);
  return Number.isFinite(n) && n >= 0 && n < 1e9 ? n : 1;
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
  nb: "no",
  // Bokmål → Norway
  nn: "no",
  // Nynorsk → Norway
  uk: "ua",
  // Ukrainian language → Ukraine
  ar: "sa",
  he: "il",
  hi: "in",
  et: "ee",
  vi: "vn",
  ms: "my",
  fa: "ir",
  ca: "es",
  sl: "si",
  sr: "rs",
  tl: "ph",
  fil: "ph",
  ga: "ie",
  cy: "gb",
  eu: "es",
  gl: "es",
  sq: "al",
  bs: "ba",
  be: "by",
  ka: "ge",
  hy: "am",
  kk: "kz",
  af: "za",
  sw: "ke",
  ur: "pk",
  bn: "bd",
  ta: "in",
  te: "in",
  mr: "in",
  ne: "np",
  si: "lk",
  km: "kh",
  lo: "la",
  lb: "lu"
};
var SCRIPT_COUNTRY = {
  "zh-hant": "tw",
  "zh-hans": "cn"
};
var REGION_ALIASES = {
  gb: "uk",
  en: "us",
  "419": "xl",
  si: "sl"
};
var DDG_LANG_ALIASES = {
  nb: "no",
  // Bokmål
  nn: "no",
  // Nynorsk
  ja: "jp",
  ko: "kr",
  fil: "tl"
};
var DDG_KL = {
  ar: "xa-ar",
  ca: "ct-ca",
  "zh-tw": "tw-tzh",
  "zh-hk": "hk-tzh",
  "es-us": "ue-es"
};
var NO_REGION = "wt";
function parseTag(tag) {
  const parts = (tag || "en").trim().replace(/[.@].*$/, "").split(/[-_]/);
  const lang = (parts[0] || "en").toLowerCase();
  let i = 1;
  const script = /^[a-z]{4}$/i.test(parts[i] ?? "") ? parts[i++].toLowerCase() : void 0;
  const region = /^(?:[a-z]{2}|\d{3})$/i.test(parts[i] ?? "") ? parts[i].toLowerCase() : void 0;
  return { lang, script, region };
}
function baseLang3(lang) {
  return parseTag(lang).lang;
}
function resolveRegion(lang, region) {
  if (region?.trim()) return region.trim().toLowerCase();
  const t = parseTag(lang);
  if (t.region) return t.region;
  const byScript = t.script ? SCRIPT_COUNTRY[`${t.lang}-${t.script}`] : void 0;
  return byScript ?? LANG_COUNTRY[t.lang] ?? t.lang;
}
function ddgRegion(lang, region) {
  const r = resolveRegion(lang, region);
  if (r === NO_REGION) return "wt-wt";
  const l = baseLang3(lang);
  return DDG_KL[`${l}-${r}`] ?? DDG_KL[l] ?? `${REGION_ALIASES[r] ?? r}-${DDG_LANG_ALIASES[l] ?? l}`;
}
function searxngLanguage(lang, region) {
  if (!lang?.trim()) return void 0;
  const t = parseTag(lang);
  if (!/^[a-z]{2,3}$/.test(t.lang)) return void 0;
  const country = region?.trim() ? region.trim().toLowerCase() : t.region ?? (t.script ? SCRIPT_COUNTRY[`${t.lang}-${t.script}`] : void 0);
  return country && /^[a-z]{2}$/.test(country) && country !== NO_REGION ? `${t.lang}-${country.toUpperCase()}` : t.lang;
}
function acceptLanguageHeader(lang, region) {
  const l = baseLang3(lang);
  const r = resolveRegion(lang, region);
  if (r === NO_REGION) return l === "en" ? "en" : `${l},en;q=0.5`;
  const R = r.toUpperCase();
  if (l === "en") return `${l}-${R},${l};q=0.9`;
  return `${l}-${R},${l};q=0.9,en;q=0.5`;
}

// src/firecrawl.ts
var FIRECRAWL_DEFAULT_BASE = "http://localhost:3002";
var PROBE_TIMEOUT_MS2 = 2e3;
var SCRAPE_TIMEOUT_MS = 45e3;
var SEARCH_TIMEOUT_MS = 3e4;
var SERVER_MARGIN_MS = { scrape: 5e3, search: 2e3 };
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
var PROBE_DOWN_TTL_MS = 3e4;
var ProbeMemo = class {
  entries = /* @__PURE__ */ new Map();
  /** The verdict for `key`, probing when there is none or a "down" one expired. */
  get(key, probe) {
    const hit = this.entries.get(key);
    if (hit && (hit.downAt === void 0 || Date.now() - hit.downAt < PROBE_DOWN_TTL_MS)) return hit.verdict;
    const entry = { verdict: probe() };
    void entry.verdict.then((up) => {
      if (!up) entry.downAt = Date.now();
    });
    this.entries.set(key, entry);
    return entry.verdict;
  }
  markDown(key) {
    this.entries.set(key, { verdict: Promise.resolve(false), downAt: Date.now() });
  }
  clear() {
    this.entries.clear();
  }
};
var probeCache = new ProbeMemo();
function resetFirecrawlProbeCache() {
  probeCache.clear();
}
function markFirecrawlDown(base2) {
  for (const explicit of [true, false]) probeCache.markDown(`${base2}|${explicit}`);
}
function looksLikeFirecrawl(contentType, body) {
  if (/firecrawl/i.test(body.slice(0, 4096))) return true;
  return !/^\s*text\/html/i.test(contentType ?? "");
}
function probeFirecrawl(base2, explicit = false) {
  return probeCache.get(`${base2}|${explicit}`, async () => {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), PROBE_TIMEOUT_MS2);
    try {
      const res = await fetch(`${base2}/`, { signal: ctrl.signal });
      const body = await res.text().catch(() => "");
      return explicit || looksLikeFirecrawl(res.headers.get("content-type"), body);
    } catch {
      return false;
    } finally {
      clearTimeout(t);
    }
  });
}
var prefixCache = /* @__PURE__ */ new Map();
function apiPrefix(base2) {
  return prefixCache.get(base2) ?? "/v2";
}
async function postJson(base2, path, body, opts) {
  const req = { timeoutMs: opts.timeoutMs, retries: opts.retries, headers: authHeaders() };
  const prefix = apiPrefix(base2);
  const first = await httpJson("POST", `${base2}${prefix}${path}`, body(prefix), req);
  if (first.status !== 404 || prefix !== "/v2") return first;
  prefixCache.set(base2, "/v1");
  return httpJson("POST", `${base2}/v1${path}`, body("/v1"), req);
}
function serverReason(data) {
  const raw = typeof data === "string" ? data : typeof data?.error === "string" ? data.error : "";
  const line = cleanInline(raw).slice(0, 200);
  return line || void 0;
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
  const asked = typeof meta.sourceURL === "string" && meta.sourceURL ? meta.sourceURL : void 0;
  const landed = typeof meta.url === "string" && meta.url ? meta.url : void 0;
  const src = asked ?? landed;
  const final = landed ?? asked;
  const status = typeof meta.statusCode === "number" ? meta.statusCode : void 0;
  return {
    markdown,
    ...rawTitle ? { title: rawTitle } : {},
    ...src ? { sourceURL: src } : {},
    ...final ? { finalUrl: final } : {},
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
  const base2 = firecrawlBase(opts);
  if (!base2) return {};
  if (!await probeFirecrawl(base2, firecrawlIsExplicit(opts))) {
    return firecrawlIsExplicit(opts) ? { why: `Firecrawl not reachable at ${base2} \u2014 used the built-in extractor.` } : {};
  }
  const r = await postJson(
    base2,
    "/scrape",
    () => ({
      url,
      formats: ["markdown"],
      onlyMainContent: true,
      blockAds: true,
      removeBase64Images: true,
      maxAge: SCRAPE_MAX_AGE_MS,
      timeout: SCRAPE_TIMEOUT_MS - SERVER_MARGIN_MS.scrape
    }),
    // No retry: the built-in extractor is the fallback, and a second attempt
    // at a browser render that just failed doubles the wait for nothing.
    { timeoutMs: SCRAPE_TIMEOUT_MS, retries: 0 }
  );
  if (!r.ok) {
    if (!r.status) markFirecrawlDown(base2);
    const why = r.status ? `status ${r.status}` : r.error ?? "no response";
    return { why: `Firecrawl could not scrape ${url} (${why}) \u2014 fell back to the built-in extractor.` };
  }
  const data = mapScrapeResponse(r.data);
  if (!data) return { why: `Firecrawl returned no markdown for ${url} \u2014 fell back to the built-in extractor.` };
  return { data };
}
async function searchViaFirecrawl(query, limit, opts = {}) {
  const base2 = firecrawlBase(opts);
  if (!base2) return { why: `Firecrawl disabled (--firecrawl off / ${envName("FIRECRAWL")}=off). Skipping.` };
  if (!await probeFirecrawl(base2, firecrawlIsExplicit(opts))) {
    return { why: `Firecrawl not reachable at ${base2} (bring it up with \`${brand().cli} firecrawl up\`). Skipping.`, status: 0 };
  }
  const n = Number.isFinite(limit) ? Math.min(100, Math.max(1, Math.trunc(limit))) : 10;
  const locale = {};
  if (opts.lang || opts.region) {
    if (opts.lang) locale.lang = baseLang3(opts.lang);
    const country = resolveRegion(opts.lang, opts.region);
    if (/^[a-z]{2}$/.test(country) && country !== "wt") locale.country = country;
  }
  const timeoutMs = Math.max(1, Math.round(Math.min(SEARCH_TIMEOUT_MS, opts.budgetMs ?? SEARCH_TIMEOUT_MS)));
  const r = await postJson(
    base2,
    "/search",
    // `sources` is v2's; v1's strict schema rejects any key it does not know.
    // `timeout` tells Firecrawl to stop just before we do: its own default is
    // 60 s, double the time this client waits.
    (prefix) => ({
      query,
      limit: n,
      ...locale,
      timeout: Math.max(1e3, timeoutMs - SERVER_MARGIN_MS.search),
      ...prefix === "/v2" ? { sources: ["web"] } : {}
    }),
    // No retry: this is the cascade's last rung, and a second attempt at an
    // instance that just failed or throttled us doubles the wait for nothing.
    { timeoutMs, retries: 0 }
  );
  if (!r.ok) {
    const budgetRanOut = r.timedOut === true && timeoutMs < SEARCH_TIMEOUT_MS;
    if (!r.status && !budgetRanOut) markFirecrawlDown(base2);
    const reason = serverReason(r.data);
    const why = r.status === 429 || r.status === 503 ? `rate-limited (HTTP ${r.status})` : !r.status ? `unreachable (${r.error ?? "no response"})` : (
      // It answered: a 4xx is this request refused (a bad field, a key a
      // Cloud base wants), which "unreachable" misreported as an outage.
      `${r.status < 500 ? "rejected the request" : "failed"} (HTTP ${r.status}${reason ? `: ${reason}` : ""})`
    );
    return { why: `Firecrawl search ${why} at ${base2}.`, status: r.status };
  }
  if (r.data?.success === false) {
    return { why: `Firecrawl search failed at ${base2}${serverReason(r.data) ? `: ${serverReason(r.data)}` : ""}.`, status: r.status };
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
var defaultTimeoutMs2 = () => envInt("TIMEOUT_MS", 2e4, 1e3, 3e5);
function pageDelayMs() {
  return envInt("PAGE_DELAY_MS", 350, 0, 5e3);
}
function politeDelayMs() {
  return envInt("POLITE_DELAY_MS", 400, 0, 5e3);
}
function sleep(ms, signal) {
  return signal ? sleepUnlessAborted(ms, signal) : new Promise((r) => setTimeout(r, ms));
}
function sleepUnlessAborted(ms, signal) {
  return new Promise((resolve7) => {
    if (signal?.aborted) return resolve7();
    const done = () => {
      clearTimeout(t);
      signal?.removeEventListener("abort", done);
      resolve7();
    };
    const t = setTimeout(done, ms);
    signal?.addEventListener("abort", done, { once: true });
  });
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
function attemptsFor(retries) {
  return retries === void 0 ? maxAttempts() : Math.min(4, Math.max(0, Math.trunc(retries))) + 1;
}
function networkFailure(e) {
  const err = e;
  const code = typeof err?.cause?.code === "string" ? err.cause.code : void 0;
  const detail = typeof err?.cause?.message === "string" && err.cause.message ? err.cause.message : code;
  if (!detail) return typeof err?.message === "string" ? err.message : String(e);
  return code && !detail.includes(code) ? `${code}: ${detail}` : detail;
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
async function readMeasuredBody(res, max) {
  const read2 = await readCappedBytes(res, max + 1);
  const bytes = read2.subarray(0, max);
  return { bytes, bytesRead: bytes.length, truncated: read2.length > max };
}
var DEFAULT_MAX_RESPONSE_BYTES = 4 * 1024 * 1024;
function isBinaryDocument(contentType) {
  return /application\/pdf/i.test(contentType) || docFormatForContentType(contentType) !== void 0;
}
var mimeOf = (contentType) => contentType.split(";")[0].trim().toLowerCase();
function dispositionFilename(header2) {
  if (!header2) return void 0;
  let name;
  const extended = /filename\*\s*=\s*[^'\s;]*'[^']*'([^;\s]+)/i.exec(header2);
  if (extended) {
    try {
      name = decodeURIComponent(extended[1]);
    } catch {
      name = void 0;
    }
  }
  if (name === void 0) {
    const plain2 = /filename\s*=\s*(?:"((?:\\.|[^"\\])*)"|([^;]+))/i.exec(header2);
    name = plain2 ? plain2[1]?.replace(/\\(.)/g, "$1") ?? plain2[2].trim() : void 0;
  }
  return name?.split(/[\\/]/).pop() || void 0;
}
var namesDocument = (filename) => filename !== void 0 && (PDF_URL_RE.test(filename) || docFormatForUrl(filename) !== void 0);
var REDIRECT_STATUS = /* @__PURE__ */ new Set([301, 302, 303, 307, 308]);
async function authorizedGet(url, init, authorize) {
  let target = url;
  const fail = (error, redirectFailed) => ({
    failure: { ok: false, status: 0, body: "", contentType: "", url: target, error, ...redirectFailed ? { redirectFailed } : {} }
  });
  const headers = { ...init.headers };
  for (let redirects = 0; ; redirects++) {
    try {
      if (!await authorize(target)) return fail(`URL not authorized: ${target}`);
    } catch (e) {
      return fail(`URL authorization failed for ${target}: ${e.message}`);
    }
    const response = await fetch(target, { ...init, headers, redirect: "manual" });
    const location = response.headers.get("location");
    if (!REDIRECT_STATUS.has(response.status) || !location) return { response };
    await response.body?.cancel().catch(() => {
    });
    if (redirects >= 20) return fail("Too many redirects (maximum 20)", true);
    try {
      const next = new URL(location, target);
      if (!/^https?:$/.test(next.protocol)) return fail(`Unsupported redirect protocol: ${next.protocol}`, true);
      if (next.origin !== new URL(target).origin) {
        delete headers.authorization;
        delete headers.cookie;
        delete headers["proxy-authorization"];
      }
      target = next.href;
    } catch {
      return fail(`Invalid redirect URL from ${target}`, true);
    }
  }
}
async function httpGet(url, opts = {}) {
  const attempts = attemptsFor(opts.retries);
  let last = { ok: false, status: 0, body: "", contentType: "", url };
  const timeoutMs = opts.timeoutMs ?? defaultTimeoutMs2();
  const cancelled = () => ({ ok: false, status: 0, body: "", contentType: "", url, error: "cancelled" });
  for (let attempt = 0; attempt < attempts; attempt++) {
    if (opts.signal?.aborted) return cancelled();
    const ctrl = new AbortController();
    const onCancel = () => ctrl.abort();
    opts.signal?.addEventListener("abort", onCancel, { once: true });
    let t;
    let remainingMs = timeoutMs;
    let startedAt = 0;
    let timedOut = false;
    const expire = () => {
      timedOut = true;
      ctrl.abort();
    };
    const pauseTimeout = () => {
      if (t === void 0) return;
      clearTimeout(t);
      t = void 0;
      remainingMs -= performance.now() - startedAt;
    };
    const resumeTimeout = () => {
      startedAt = performance.now();
      if (remainingMs <= 0) expire();
      else t = setTimeout(expire, remainingMs);
    };
    try {
      const headers = { "user-agent": opts.userAgent ?? defaultUa(), accept: opts.accept ?? "*/*" };
      if (opts.acceptLanguage) headers["accept-language"] = opts.acceptLanguage;
      for (const [k, v] of Object.entries(opts.headers ?? {})) headers[k.toLowerCase()] = v;
      const init = {
        signal: ctrl.signal,
        redirect: "follow",
        headers
      };
      if (!opts.authorizeUrl) resumeTimeout();
      const requested = opts.authorizeUrl ? await authorizedGet(url, init, async (target) => {
        pauseTimeout();
        const allowed = await opts.authorizeUrl(target);
        if (allowed) resumeTimeout();
        return allowed;
      }) : { response: await fetch(url, init) };
      if ("failure" in requested) return requested.failure;
      const res = requested.response;
      const meta = {
        contentType: res.headers.get("content-type") ?? "",
        url: res.url || url,
        etag: res.headers.get("etag") ?? void 0,
        lastModified: res.headers.get("last-modified") ?? void 0,
        rateLimited: detectRateLimited(res.status, res.headers),
        retryAfterMs: parseRetryAfter(res.headers, Number.POSITIVE_INFINITY)
      };
      const mime = mimeOf(meta.contentType);
      const filename = dispositionFilename(res.headers.get("content-disposition"));
      const namedDocument = isBinaryDocument(meta.contentType) || namesDocument(filename);
      const ambiguous = AMBIGUOUS_TYPES.has(mime);
      const declared = Number(res.headers.get("content-length"));
      const documentCap = namedDocument || ambiguous ? opts.maxDocumentBytes : void 0;
      const pastDocumentCap = !namedDocument && documentCap !== void 0 && declared > documentCap;
      const max = opts.maxBytes ?? (pastDocumentCap ? Math.min(documentCap, DEFAULT_MAX_RESPONSE_BYTES) : documentCap) ?? DEFAULT_MAX_RESPONSE_BYTES;
      const prefixUseless = opts.binary || namedDocument || NON_TEXT_TYPE_RE.test(mime) || Object.keys(opts.headers ?? {}).some((k) => k.toLowerCase() === "range");
      if (Number.isFinite(declared) && declared > max && prefixUseless) {
        ctrl.abort();
        return { ok: false, status: res.status, body: "", bytesRead: 0, truncated: true, ...meta, error: `response too large: ${declared} bytes > ${max} cap` };
      }
      let { bytes, bytesRead, truncated } = res.status === 304 ? { bytes: Buffer.alloc(0), bytesRead: 0, truncated: false } : await readMeasuredBody(res, max);
      countFetch(bytes.length, false);
      const sniffed = ambiguous ? sniffDocument(bytes) : void 0;
      if (ambiguous && !namedDocument && !sniffed && opts.maxBytes === void 0 && bytes.length > DEFAULT_MAX_RESPONSE_BYTES) {
        bytes = bytes.subarray(0, DEFAULT_MAX_RESPONSE_BYTES);
        bytesRead = bytes.length;
        truncated = true;
      }
      const keepBytes = opts.binary || (namedDocument || sniffed !== void 0) && !truncated;
      const binaryBody = opts.binary || sniffed !== void 0 || isBinaryDocument(meta.contentType) && !mime.startsWith("text/");
      const result = {
        ok: res.ok,
        status: res.status,
        // Decoded per the response's own encoding, not assumed UTF-8. A
        // Windows-1252 page used to come back with every accented character
        // replaced by U+FFFD, and nothing anywhere noticed.
        body: binaryBody ? "" : decodeBody(bytes, meta.contentType),
        bytes: keepBytes ? bytes : void 0,
        bytesRead,
        truncated,
        ...meta,
        ...filename ? { filename } : {}
      };
      const wait = RETRY_STATUS.has(res.status) && attempt < attempts - 1 ? retryDelayMs(meta.retryAfterMs) : void 0;
      if (wait !== void 0) {
        last = result;
        if (wait > 0) opts.onBackOff?.(result.url, wait);
        await sleepUnlessAborted(wait, opts.signal);
        continue;
      }
      return result;
    } catch (e) {
      if (!timedOut && opts.signal?.aborted) return cancelled();
      const error = timedOut ? `timed out after ${timeoutMs} ms` : networkFailure(e);
      last = {
        ok: false,
        status: 0,
        body: "",
        contentType: "",
        url,
        error,
        ...!timedOut && /redirect count exceeded/i.test(error) ? { redirectFailed: true } : {}
      };
      if (timedOut || isPermanentFailure(e)) break;
      if (attempt < attempts - 1) await sleepUnlessAborted(defaultRetryMs(), opts.signal);
    } finally {
      clearTimeout(t);
      opts.signal?.removeEventListener("abort", onCancel);
    }
  }
  return last;
}
async function httpJson(method, url, body, opts = {}) {
  const attempts = attemptsFor(opts.retries);
  let last = { ok: false, status: 0, data: void 0 };
  const timeoutMs = opts.timeoutMs ?? defaultTimeoutMs2();
  for (let attempt = 0; attempt < attempts; attempt++) {
    const ctrl = new AbortController();
    let timedOut = false;
    const t = setTimeout(() => {
      timedOut = true;
      ctrl.abort();
    }, timeoutMs);
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
      const max = opts.maxBytes ?? DEFAULT_MAX_RESPONSE_BYTES;
      const { bytes, bytesRead, truncated } = await readMeasuredBody(res, max);
      countFetch(bytes.length, false);
      if (truncated) {
        ctrl.abort();
        return { ok: false, status: res.status, data: void 0, bytesRead, truncated, error: `response too large: over the ${max}-byte cap` };
      }
      const text = bytes.toString("utf8");
      let data;
      try {
        data = text ? JSON.parse(text) : void 0;
      } catch {
        data = text;
      }
      const result = { ok: res.ok, status: res.status, data, bytesRead, truncated };
      const wait = RETRY_STATUS.has(res.status) && attempt < attempts - 1 ? retryDelayMs(parseRetryAfter(res.headers, Number.POSITIVE_INFINITY)) : void 0;
      if (wait !== void 0) {
        last = result;
        await sleep(wait);
        continue;
      }
      return result;
    } catch (e) {
      last = timedOut ? { ok: false, status: 0, data: void 0, error: `timed out after ${timeoutMs} ms`, timedOut: true } : { ok: false, status: 0, data: void 0, error: networkFailure(e) };
      if (timedOut || isPermanentFailure(e)) break;
      if (attempt < attempts - 1) await sleep(defaultRetryMs());
    } finally {
      clearTimeout(t);
    }
  }
  return last;
}
var INLINE_FORMAT = /* @__PURE__ */ new Set([...INLINE_TAGS, "br", "scp"]);
var INLINE_FORMAT_TAG = /<(\/?)([a-zA-Z][\w.-]*(?::[\w.-]+)?)(?=[\s/>])([^<>]*)>/g;
function cleanInline(s) {
  const text = decodeEntities(String(s));
  const opened = /* @__PURE__ */ new Set();
  const closed = /* @__PURE__ */ new Set();
  for (const m of text.matchAll(INLINE_FORMAT_TAG)) (m[1] ? closed : opened).add(m[2].toLowerCase());
  return text.replace(INLINE_FORMAT_TAG, (tag, slash, rawName, attrs) => {
    const name = rawName.toLowerCase();
    if (name.startsWith("mml:") || name.startsWith("jats:")) return "";
    if (!INLINE_FORMAT.has(name)) return tag;
    if (name === "br") return " ";
    const markup = attrs.trim().replace(/\/$/, "") !== "" || name === "wbr" || (slash ? opened : closed).has(name);
    return markup ? "" : tag;
  }).replace(/\s+/g, " ").trim();
}
var NUL2 = "\0";
var PRE_SLOT = (i) => `
${NUL2}${i}${NUL2}
`;
function preSlotIndex(line) {
  if (line.length < 3 || line[0] !== NUL2 || line[line.length - 1] !== NUL2) return void 0;
  const i = Number(line.slice(1, -1));
  return Number.isInteger(i) ? i : void 0;
}
function restoreInlinePre(line, blocks) {
  const parts = line.split(NUL2);
  let out = parts[0];
  for (let i = 1; i < parts.length; i += 2) {
    const code = (blocks[Number(parts[i])] ?? "").replace(/\s+/g, " ").trim();
    out += ` ${code} ${parts[i + 1] ?? ""}`;
  }
  return out.replace(/ {2,}/g, " ").trim();
}
function setAsidePre(html, blocks) {
  const open = /<pre(?=[\s/>])(?:[^<>"']|"[^"]*"|'[^']*')*>/gi;
  const close = closeTagRe("pre");
  let out = "";
  let last = 0;
  let m;
  while (m = open.exec(html)) {
    close.lastIndex = open.lastIndex;
    const c = close.exec(html);
    if (!c) break;
    const inner = html.slice(open.lastIndex, c.index);
    const text = decodeEntities(inner.replace(/<br\s*\/?>/gi, "\n").replace(LOOSE_TAG_RE, "")).replace(/\r\n?/g, "\n").replace(/^\n/, "").trimEnd();
    blocks.push(text);
    out += html.slice(last, m.index) + PRE_SLOT(blocks.length - 1);
    last = open.lastIndex = c.index + c[0].length;
  }
  return last === 0 ? html : out + html.slice(last);
}
var HEADING_OPEN = /<h([1-6])(?=[\s/>])(?:[^<>"']|"[^"]*"|'[^']*')*>/gi;
var HEADING_BOUNDARY = /<\/h[1-6]\s*>|<h[1-6](?=[\s/>])/gi;
var PERMALINK = /<a\b[^<>]*>\s*(?:(?:¶|#|§|🔗|&para;|&#182;|&#x[bB]6;|&sect;)\s*)?<\/a\s*>/gi;
function flattenHeadings(html) {
  let out = "";
  let last = 0;
  let m;
  HEADING_OPEN.lastIndex = 0;
  while (m = HEADING_OPEN.exec(html)) {
    HEADING_BOUNDARY.lastIndex = HEADING_OPEN.lastIndex;
    const b = HEADING_BOUNDARY.exec(html);
    if (!b) break;
    if (b[0][1] !== "/") continue;
    const text = html.slice(HEADING_OPEN.lastIndex, b.index).replace(PERMALINK, "").replace(TAG_RE, (tag) => INLINE_TAGS.has(tagName(tag)) ? "" : " ").replace(/\s+/g, " ").trim();
    out += html.slice(last, m.index) + (text ? `
${"#".repeat(Number(m[1]))} ${text}
` : "\n");
    last = HEADING_OPEN.lastIndex = b.index + b[0].length;
  }
  return last === 0 ? html : out + html.slice(last);
}
function htmlToText(html, opts = {}) {
  const hidden = opts.fullPage ? HIDDEN_ELEMENTS : [...HIDDEN_ELEMENTS, ...CHROME_ELEMENTS];
  let s = dropElements(html.includes(NUL2) ? html.split(NUL2).join("\uFFFD") : html, hidden, RAW_TEXT_ELEMENTS);
  if (!opts.fullPage) s = dropLandmarks(s, CHROME_ROLES);
  const pre = [];
  s = flattenHeadings(setAsidePre(s, pre));
  let prevEnd = -1;
  let prevClosed = false;
  s = s.replace(TAG_RE, (tag, at) => {
    const closing = tag[1] === "/";
    const adjacent = at === prevEnd && prevClosed && !closing;
    prevEnd = at + tag.length;
    prevClosed = closing;
    const name = tagName(tag);
    if (/^h[1-6]$/.test(name)) {
      return closing ? "\n" : "\n" + "#".repeat(Number(name[1])) + " ";
    }
    if (BLOCK_TAGS.has(name) || name === "br" || name === "hr") return "\n";
    if (INLINE_TAGS.has(name)) return adjacent ? " " : "";
    return " ";
  });
  s = s.replace(LOOSE_TAG_RE, " ");
  s = decodeEntities(s);
  s = s.replace(/[ \t]+/g, " ").replace(/\n{3,}/g, "\n\n");
  return s.split("\n").map((l) => {
    const t = l.trim();
    const slot = preSlotIndex(t);
    if (slot !== void 0) return pre[slot] ?? t;
    return t.includes(NUL2) ? restoreInlinePre(t, pre) : t;
  }).filter((l) => l.length > 0).join("\n");
}
var NOT_TITLE = ["script", "style", "template", "svg"];
function firstElementText(html, name) {
  const open = new RegExp(`<${name}(?=[\\s/>])(?:[^<>"']|"[^"]*"|'[^']*')*>`, "i").exec(html);
  if (!open) return void 0;
  const close = closeTagRe(name);
  close.lastIndex = open.index + open[0].length;
  const c = close.exec(html);
  if (!c) return void 0;
  const inner = html.slice(open.index + open[0].length, c.index).replace(TAG_RE, (tag) => INLINE_TAGS.has(tagName(tag)) ? "" : " ");
  return decodeEntities(inner).replace(/\s+/g, " ").trim() || void 0;
}
function htmlTitle(html) {
  return firstElementText(dropElements(html, NOT_TITLE), "title");
}
function metaContent(html, keys) {
  const found = /* @__PURE__ */ new Map();
  for (const m of html.matchAll(/<meta(?=[\s/>])(?:[^<>"']|"[^"]*"|'[^']*')*>/gi)) {
    const attrs = htmlAttributes(m[0]);
    const key = (attrs.get("property") ?? attrs.get("name"))?.toLowerCase();
    const value = attrs.get("content")?.trim();
    if (key && value && keys.includes(key) && !found.has(key)) found.set(key, decodeEntities(value).replace(/\s+/g, " ").trim());
  }
  return keys.map((k) => found.get(k)).find(Boolean);
}
function pageTitle(html) {
  const clean3 = dropElements(html, NOT_TITLE);
  return firstElementText(clean3, "title") ?? metaContent(clean3, ["og:title", "twitter:title"]) ?? firstElementText(clean3, "h1");
}
function htmlCanonicalUrl(html) {
  const clean3 = dropElements(html, ["script", "style", "template"]);
  const end = clean3.search(/<\/head\s*>|<body(?=[\s/>])/i);
  const head = end < 0 ? clean3 : clean3.slice(0, end);
  let og;
  for (const m of head.matchAll(/<(link|meta)(?=[\s/>])(?:[^<>"']|"[^"]*"|'[^']*')*>/gi)) {
    const attrs = htmlAttributes(m[0]);
    if (m[1].toLowerCase() === "link") {
      const href = attrs.get("href")?.trim();
      if (href && (attrs.get("rel") ?? "").toLowerCase().split(/\s+/).includes("canonical")) return decodeEntities(href);
    } else if (og === void 0 && attrs.get("property")?.toLowerCase() === "og:url") {
      og = attrs.get("content")?.trim() || void 0;
    }
  }
  return og && decodeEntities(og);
}
function absoluteCanonical(href, base2) {
  if (!href) return void 0;
  try {
    const u = new URL(href, base2);
    return u.protocol === "http:" || u.protocol === "https:" ? u.href : void 0;
  } catch {
    return void 0;
  }
}
var visibleLength = (h) => h.replace(/<[^<>]*>/g, " ").replace(/\s+/g, " ").trim().length;
var ROLE_MAIN = /\srole\s*=\s*["']?main(?=["'\s/>])/i;
var ROLE_MAIN_TAG = /<([a-zA-Z][a-zA-Z0-9-]*)(?=[\s/>])[^<>]*\srole\s*=\s*["']?main(?=["'\s/>])/gi;
var CONTENT_WORDS = /* @__PURE__ */ new Set(["content", "article", "post", "entry", "story", "main", "prose"]);
var CHROME_WORDS = /* @__PURE__ */ new Set([
  "nav",
  "navbar",
  "navigation",
  "menu",
  "header",
  "footer",
  "sidebar",
  "breadcrumb",
  "breadcrumbs",
  "banner",
  "cookie",
  "consent",
  "comment",
  "comments",
  "related",
  "share",
  "social",
  "toolbar",
  "widget",
  "meta",
  "ad",
  "ads",
  "promo"
]);
function isContentContainer(open) {
  const attrs = htmlAttributes(open);
  for (const token of `${attrs.get("id") ?? ""} ${attrs.get("class") ?? ""}`.toLowerCase().split(/\s+/)) {
    if (token === "markdown-body") return true;
    const words = token.split(/\W+/);
    if (words.some((w) => CONTENT_WORDS.has(w)) && !words.some((w) => CHROME_WORDS.has(w))) return true;
  }
  return false;
}
function blockKind(open) {
  const tag = /^<([a-zA-Z][a-zA-Z0-9-]*)/.exec(open)?.[1]?.toLowerCase() ?? "";
  const firstClass = (htmlAttributes(open).get("class") ?? "").trim().split(/\s+/)[0];
  return `${tag} ${firstClass.replace(/\d+/g, "0")}`;
}
function extractMainHtml(html) {
  const clean3 = dropElements(html, ["script", "style", "template", "svg"]);
  const roleMainTags = /* @__PURE__ */ new Set(["main"]);
  for (const m of clean3.matchAll(ROLE_MAIN_TAG)) roleMainTags.add(m[1].toLowerCase());
  const tiers = [
    { tags: [...roleMainTags], isCandidate: (open) => /^<main[\s/>]/i.test(open) || ROLE_MAIN.test(open) },
    { tags: ["article"], isCandidate: () => true },
    { tags: ["div", "section"], isCandidate: isContentContainer }
  ];
  for (const tier of tiers) {
    const regions = tier.tags.flatMap((tag) => balancedRegions(clean3, tag, tier.isCandidate)).sort((a, b) => a.start - b.start);
    if (!regions.length) continue;
    const outer = [];
    let reach = -1;
    for (const r of regions) {
      if (r.start < reach) continue;
      reach = r.end;
      outer.push({ ...r, len: visibleLength(clean3.slice(r.start, r.end)) });
    }
    let best = outer[0];
    for (const r of outer) if (r.len > best.len) best = r;
    const kind = blockKind(best.open);
    const kept = outer.filter((r) => r === best || blockKind(r.open) === kind);
    const keptLen = kept.reduce((n, r) => n + r.len, 0);
    if (keptLen < 500 && keptLen < visibleLength(clean3) * 0.3) return html;
    if (kept.length === 1) return clean3.slice(best.start, best.end);
    return kept.map((r) => `<div>${clean3.slice(r.start, r.end)}</div>`).join("\n");
  }
  return html;
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
var PURE_VIDEO_HOSTS = /* @__PURE__ */ new Set(["youtube", "vimeo", "dailymotion"]);
async function fetchAndExtract(url, opts = {}) {
  const cancelled = () => ({ text: "", finalUrl: url, status: 0, note: `Fetching ${url} was cancelled.` });
  if (opts.signal?.aborted) return cancelled();
  const video = opts.video === false ? void 0 : knownVideo(url);
  if (video) {
    if (opts.authorizeUrl && !await opts.authorizeUrl(url)) return { text: "", finalUrl: url, status: 0, note: `Refused ${url}: not a public address.` };
    const t = await transcribeVideo(url, {
      lang: opts.acceptLanguage?.split(/[,;]/)[0]?.trim() || void 0,
      signal: opts.signal,
      knownHostsOnly: true
    });
    if (opts.signal?.aborted) return cancelled();
    const text = transcriptMarkdown(t);
    if (!text && !PURE_VIDEO_HOSTS.has(video.site)) {
      const page = await fetchAndExtract(url, { ...opts, video: false });
      return { ...page, note: [`No video read at ${url} (${t.reason ?? "no transcript"}); read as a page.`, page.note].filter(Boolean).join(" ") };
    }
    return {
      text,
      title: t.meta?.title,
      finalUrl: t.meta?.webpageUrl ?? url,
      status: text ? 200 : 0,
      documentType: "video",
      ...t.via ? { extractor: t.via } : {},
      ...t.reason ? { note: `No transcript for ${url}: ${t.reason}.` } : {}
    };
  }
  const wantsPdf = looksLikePdfUrl(url);
  const wantsDoc = wantsPdf ? void 0 : docFormatForUrl(url);
  let firecrawlNote;
  if (!wantsPdf && !wantsDoc && !opts.authorizeUrl && !opts.fullPage) {
    const fc = await scrapeViaFirecrawl(url, opts);
    if (fc.data && (fc.data.statusCode ?? 200) < 400) {
      return {
        text: fc.data.markdown,
        title: fc.data.title,
        finalUrl: fc.data.finalUrl || url,
        status: fc.data.statusCode ?? 200,
        extractor: "firecrawl"
      };
    }
    firecrawlNote = fc.data ? `Firecrawl got HTTP ${fc.data.statusCode} for ${url} \u2014 fell back to the built-in extractor.` : fc.why;
  }
  const base2 = wantsPdf ? PDF_FETCH_OPTS : wantsDoc ? DOC_FETCH_OPTS : { accept: "text/html,text/plain,*/*", acceptLanguage: opts.acceptLanguage };
  const fetchOpts = {
    ...base2,
    maxDocumentBytes: PDF_FETCH_OPTS.maxBytes,
    headers: opts.headers,
    authorizeUrl: opts.authorizeUrl,
    timeoutMs: opts.timeoutMs,
    onBackOff: opts.onBackOff,
    signal: opts.signal
  };
  if (opts.signal?.aborted) return cancelled();
  let res = await httpGet(url, fetchOpts);
  if (opts.signal?.aborted) return cancelled();
  const toldToWait = (res.retryAfterMs ?? 0) > RETRY_AFTER_CAP_MS;
  if (!res.ok && !toldToWait && brand().defaultUa === "contact" && (res.status === 403 || res.status === 429)) {
    res = await httpGet(url, { ...fetchOpts, userAgent: browserUa(), acceptLanguage: opts.acceptLanguage ?? "en-US,en;q=0.9" });
  }
  if (res.status === 304) {
    return { text: "", finalUrl: res.url, status: 304, etag: res.etag ?? opts.headers?.["if-none-match"], lastModified: res.lastModified };
  }
  if (!res.ok) {
    const wait = res.retryAfterMs !== void 0 ? `, retry after ${Math.ceil(res.retryAfterMs / 1e3)} s` : "";
    const why = res.status === 429 ? `rate-limited (HTTP 429${wait})` : `status ${res.status}${res.error ? ", " + res.error : ""}${wait}`;
    return {
      text: "",
      finalUrl: res.url,
      status: res.status,
      note: `Could not fetch ${url} (${why}).`,
      ...res.rateLimited ? { rateLimited: true } : {},
      ...res.retryAfterMs !== void 0 ? { retryAfterMs: res.retryAfterMs } : {}
    };
  }
  const validators = res.etag || res.lastModified ? { etag: res.etag, lastModified: res.lastModified } : {};
  const mime = mimeOf(res.contentType);
  const claimsPdf = wantsPdf || /application\/pdf/i.test(res.contentType) || res.filename !== void 0 && PDF_URL_RE.test(res.filename);
  const claimsDoc = claimsPdf ? void 0 : wantsDoc ?? docFormatForContentType(res.contentType) ?? (res.filename ? docFormatForUrl(res.filename) : void 0);
  if (res.truncated && (claimsPdf || claimsDoc || !res.body && res.bytesRead)) {
    return { text: "", finalUrl: res.url, status: res.status, note: `Fetched ${url} but the document exceeds the response size cap.` };
  }
  const sniffed = res.bytes ? sniffDocument(res.bytes) : void 0;
  if (!sniffed && NON_TEXT_TYPE_RE.test(mime)) {
    return { text: "", finalUrl: res.url, status: res.status, note: `Fetched ${url} but it is ${mime}, not a text document.`, ...validators };
  }
  const answeredHtml = !sniffed && (claimsPdf || claimsDoc !== void 0) && HTML_TYPE_RE.test(mime);
  const route2 = sniffed ?? (answeredHtml ? void 0 : claimsPdf ? "pdf" : claimsDoc);
  if (route2 === "pdf") {
    const bytes = res.bytes ?? (await httpGet(url, { ...PDF_FETCH_OPTS, headers: opts.headers, authorizeUrl: opts.authorizeUrl, timeoutMs: opts.timeoutMs, signal: opts.signal })).bytes;
    const got = bytes ? await extractPdf(bytes, {
      firecrawl: async () => {
        if (opts.authorizeUrl) return void 0;
        const fc = await scrapeViaFirecrawl(url, opts);
        return fc.data && (fc.data.statusCode ?? 200) < 400 ? fc.data.markdown : void 0;
      }
    }) : { text: "", reason: "empty response body" };
    return {
      text: got.text,
      documentType: "pdf",
      finalUrl: res.url,
      status: res.status,
      // `native` keeps reporting as absent, which is what the cache key and every
      // existing dossier already assume.
      extractor: got.via && got.via !== "native" ? got.via : void 0,
      note: got.text ? firecrawlNote : `Fetched ${url} but could not extract text \u2014 ${got.reason}.`,
      ...validators
    };
  }
  if (route2) {
    const docFmt = route2;
    const bytes = res.bytes ?? (await httpGet(url, { ...DOC_FETCH_OPTS, headers: opts.headers, authorizeUrl: opts.authorizeUrl, timeoutMs: opts.timeoutMs, signal: opts.signal })).bytes;
    const got = bytes ? await extractDocument(bytes, docFmt, {
      firecrawl: async () => {
        if (opts.authorizeUrl) return void 0;
        const fc = await scrapeViaFirecrawl(url, opts);
        return fc.data && (fc.data.statusCode ?? 200) < 400 ? fc.data.markdown : void 0;
      }
    }) : { text: "", reason: "empty response body" };
    if (!got.text && docFmt.textFallback && bytes?.length) {
      return { text: decodeBody(bytes, res.contentType), documentType: "doc", finalUrl: res.url, status: res.status, note: firecrawlNote, ...validators };
    }
    return {
      text: got.text,
      documentType: "doc",
      finalUrl: res.url,
      status: res.status,
      extractor: got.via,
      note: got.text ? firecrawlNote : `Fetched ${url} but could not extract text \u2014 ${got.reason}.`,
      ...validators
    };
  }
  const ambiguousType = AMBIGUOUS_TYPES.has(mime);
  if (ambiguousType && res.body.slice(0, 1024).includes("\0")) {
    return {
      text: "",
      finalUrl: res.url,
      status: res.status,
      note: `Fetched ${url} but it is binary data (${mime || "no content-type"}), not a text document.`,
      ...validators
    };
  }
  const body = !res.body && res.bytes ? decodeBody(res.bytes, res.contentType) : res.body;
  const isHtml = HTML_TYPE_RE.test(mime) || ambiguousType && /^\s*<(?:!doctype\s+html\b|html\b|head\b|body\b|article\b|main\b|p\b|h[1-6]\b)/i.test(body);
  const markdown = opts.format === "markdown";
  const main = isHtml ? opts.fullPage ? body : extractMainHtml(body) : body;
  const stripped = !isHtml ? body : markdown ? markdownAgainst(main, documentBaseUrl(body, res.url), opts.fullPage) : htmlToText(main, opts);
  const consent = isHtml && opts.stripConsent && !opts.fullPage ? stripConsentBoilerplate(stripped, { markdown }) : { text: stripped, dropped: 0 };
  const title = isHtml ? pageTitle(body) : void 0;
  const canonical = isHtml ? absoluteCanonical(htmlCanonicalUrl(body), res.url) : void 0;
  const metaDescription = isHtml ? metaDescriptionOf(body) : void 0;
  const notDocument = answeredHtml ? `${url} looked like ${claimsPdf ? "a PDF" : "an office document"} but the server returned HTML (a login wall or landing page?), so it was read as a web page.` : void 0;
  const cut = res.truncated ? `Read only the first ${res.bytesRead} bytes of ${url} (the response size cap), so this text is a prefix.` : void 0;
  return {
    text: consent.text,
    consentDropped: consent.dropped,
    title,
    canonical,
    metaDescription,
    ...opts.keepHtml && isHtml ? { html: body } : {},
    finalUrl: res.url,
    status: res.status,
    note: [firecrawlNote, notDocument, cut].filter(Boolean).join(" ") || void 0,
    ...res.truncated ? { truncated: true } : {},
    ...validators
  };
}
var HTML_TYPE_RE = /^(?:text\/html|application\/xhtml\+xml)$/;
var NON_TEXT_TYPE_RE = /^(?:image\/(?!svg\+xml$)|audio\/|video\/|font\/|model\/|application\/(?:gzip|x-gzip|x-tar|x-bzip2|x-xz|x-7z-compressed|x-rar-compressed|vnd\.rar|java-archive|wasm|x-msdownload|vnd\.android\.package-archive|x-shockwave-flash|ogg)$)/;
var DEAD_LINK_STATUS = /* @__PURE__ */ new Set([404, 410, 451, 403]);
async function rescueViaWayback(url, opts = {}) {
  if (opts.authorizeUrl || envFlag("NO_WAYBACK")) return void 0;
  const api = `https://archive.org/wayback/available?url=${encodeURIComponent(url)}`;
  const r = await httpJson("GET", api, void 0, { timeoutMs: 1e4, userAgent: contactUa() });
  const snap = r.ok ? r.data?.archived_snapshots?.closest : void 0;
  if (snap?.available !== true || typeof snap.url !== "string") return void 0;
  const got = await fetchAndExtract(snap.url, opts);
  if (!got.text?.trim() || looksLikeJunkExtraction(got.text)) return void 0;
  return { text: got.text, title: got.title, snapshotUrl: snap.url, timestamp: String(snap.timestamp ?? "") };
}
var JUNK_PATTERNS = [
  [/\b(accept|manage)\s+(all\s+)?cookies\b/i, "cookie/consent wall", "strong"],
  [/\bwe use cookies\b/i, "cookie/consent wall", "strong"],
  [/\bcookie (policy|settings|consent|preferences)\b/i, "cookie/consent wall", "weak"],
  [/\b(accept|reject|allow|decline) all\b/i, "cookie/consent wall", "weak"],
  [/\b(please )?enable javascript\b/i, "JavaScript-required shell", "strong"],
  [/\bjavascript is (disabled|required|not enabled)\b/i, "JavaScript-required shell", "strong"],
  [
    /\bverify(ing)? (that )?(you are|you're) (a )?(human|not a (ro)?bot)\b|\bare you a (human|robot)\b|\bhuman verification\b/i,
    "anti-bot interstitial",
    "strong"
  ],
  [/\battention required\b.*cloudflare|\bunusual traffic from your (computer )?network\b|\bchecking your browser\b/i, "anti-bot interstitial", "strong"],
  // Akamai's and Cloudflare's denials carry an incident reference; without one
  // the phrase is as likely a permission-error article.
  [/\baccess denied\b[\s\S]{0,300}?(\breference #|\bray id\b|\bpermission to access\b)/i, "anti-bot interstitial", "strong"],
  // Cloudflare's WAF block page. Its "Attention Required!" is the <title>,
  // which extraction drops, so the body's own wording has to carry it.
  [/\bsorry, you have been blocked\b|\byou are unable to access\b[\s\S]{0,300}?\bray id\b/i, "anti-bot interstitial", "strong"],
  [/\baccess denied\b|\benable cookies\b/i, "anti-bot interstitial", "weak"],
  // FR / DE (the locale layer targets non-EN markets)
  [/\bnous utilisons des cookies\b|\baccepter (tous )?les cookies\b|\bactiver javascript\b/i, "cookie/consent wall (fr)", "strong"],
  [/\bwir verwenden cookies\b|\bcookies akzeptieren\b|\bjavascript aktivieren\b/i, "cookie/consent wall (de)", "strong"]
];
function looksLikeJunkExtraction(text) {
  const t = text.trim();
  if (t.length >= 2e3) return void 0;
  const head = t.slice(0, 800);
  const hits = JUNK_PATTERNS.filter(([re]) => re.test(head));
  const strong = hits.find(([, , kind]) => kind === "strong");
  if (!strong) return void 0;
  if (hits.length >= 2) return strong[1];
  const prose = t.split("\n").filter((l) => l.trim().length >= 60 && !JUNK_PATTERNS.some(([re]) => re.test(l))).length;
  return prose < 3 ? strong[1] : void 0;
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
  /legitimate interest/i,
  // FR / DE: the locale layer targets those markets, and their consent
  // managers (Didomi, Usercentrics, OneTrust) speak the local language.
  /\bconsentement\b/i,
  /\brgpd\b/i,
  /\beinwilligung\b/i,
  /\bdsgvo\b/i
];
var CONSENT_ACTIONS = [
  /\b(?:accept|reject|decline|agree|allow|manage|preferences|settings|choices)\b/i,
  /\b(?:opt[ -]out|we use cookies|this (?:site|website) uses cookies|by continuing)\b/i,
  /\b(?:learn more|privacy policy|cookie policy)\b/i
];
var BANNER_VOICE = /\b(?:we|us|our)\b[^.]{0,60}?\b(?:cookies?|partners|consent|tracking)\b|\bby (?:clicking|continuing|using|browsing)\b|\bthis (?:site|website) uses cookies\b|\bnous (?:utilisons|et nos partenaires)\b|\ben cliquant sur\b|\bwir (?:verwenden|nutzen|setzen|und unsere partner)\b|\bmit (?:dem )?klick auf\b/i;
var BUTTON_LABEL = /^(?:tout (?:accepter|refuser)|(?:accepter|refuser) tout|accepter et (?:fermer|continuer)|continuer sans accepter|(?:param[ée]trer|g[ée]rer|personnaliser|accepter|refuser) (?:les|mes) cookies|alle (?:cookies )?(?:akzeptieren|ablehnen)|nur (?:notwendige|essenzielle)(?: cookies)?|cookie-einstellungen|einstellungen verwalten|akzeptieren und schlie(?:ß|ss)en)$/i;
var BUTTON_LENGTH = 40;
var NOTICE_LENGTH = 400;
function stripConsentBoilerplate(text, opts = {}) {
  if (opts.markdown) return stripConsentMarkdown(text);
  let dropped = 0;
  const kept = text.split("\n").filter((line) => {
    const isBanner = isConsentLine(line.trim());
    if (isBanner) dropped++;
    return !isBanner;
  });
  return { text: kept.join("\n"), dropped };
}
function isConsentLine(t) {
  const hits = CONSENT_PATTERNS.reduce((n, re) => n + (re.test(t) ? 1 : 0), 0);
  return BUTTON_LABEL.test(t) || hits >= 1 && t.length <= BUTTON_LENGTH && (hits >= 2 || CONSENT_ACTIONS.some((re) => re.test(t))) || hits >= 1 && t.length < NOTICE_LENGTH && BANNER_VOICE.test(t);
}
var MD_FENCE = /^[\s>]*(`{3,}|~{3,})(.*)$/;
var MD_LINE_START = /^[\s>]*(?:(?:[-+*]|\d{1,9}[.)])\s+)?(?:#{1,6}\s+)?/;
var MD_DESTINATION = /\]\((?:[^()\s\\]|\\.|\([^()\s]*\))*\)/g;
var MD_MARKUP = /\\(?=[!-/:-@[-`{-~])|!?\[|\]|\*+|`+/g;
function visibleText(line) {
  return line.replace(MD_LINE_START, "").replace(MD_DESTINATION, "]").replace(MD_MARKUP, "").trim();
}
function stripConsentMarkdown(text) {
  let dropped = 0;
  let fence = "";
  const kept = [];
  for (const line of text.split("\n")) {
    const f = MD_FENCE.exec(line);
    if (fence) {
      if (f && f[1][0] === fence[0] && f[1].length >= fence.length && !f[2].trim()) fence = "";
      kept.push(line);
      continue;
    }
    if (f) fence = f[1];
    else if (!line.trim()) {
      if (kept.length && kept[kept.length - 1].trim()) kept.push(line);
      continue;
    } else if (!/^[\s>]*\|/.test(line) && isConsentLine(visibleText(line))) {
      dropped++;
      continue;
    }
    kept.push(line);
  }
  while (kept.length && !kept[kept.length - 1].trim()) kept.pop();
  return { text: kept.join("\n"), dropped };
}
function metaDescriptionOf(html) {
  let og;
  for (const match of html.matchAll(/<meta\b(?:[^"'<>]|"[^"]*"|'[^']*')*>/gi)) {
    const attrs = htmlAttributes(match[0]);
    const value = attrs.get("content")?.replace(/\s+/g, " ").trim();
    if (!value) continue;
    if (attrs.get("name")?.toLowerCase() === "description") return decodeEntities(value);
    if (attrs.get("property")?.toLowerCase() === "og:description" && og === void 0) og = decodeEntities(value);
  }
  return og;
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

// src/citable.ts
var API_HOSTS = /* @__PURE__ */ new Set([
  "eutils.ncbi.nlm.nih.gov",
  "api.crossref.org",
  "api.openalex.org",
  "api.semanticscholar.org",
  "export.arxiv.org",
  "api.github.com",
  "registry.npmjs.org",
  "api.stackexchange.com"
]);
var API_PATHS = [
  /^\/europepmc\/webservices\//i,
  /^\/search\/publ\/api/i,
  /^\/api\/(?!.*\.html?$)/i,
  /^\/entrez\/eutils\//i,
  /^\/pypi\/[^/]+(?:\/[^/]+)?\/json\/?$/i,
  /^\/wayback\/available\b/i
];
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
var ARXIV_RE = /\barxiv(?:\.org\/(?:abs|pdf)\/|[:\s/]+)((?:\d{4}\.\d{4,5}|[a-z-]+(?:\.[A-Z]{2})?\/\d{7})(?:v\d+)?)/i;
var PMID_RE = /\bPMID:?\s*(\d{4,9})\b/i;
var PMCID_RE = /\b(PMC\d{5,9})\b/;
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
  const pmcid = head.match(PMCID_RE)?.[1];
  if (pmcid) return `https://pmc.ncbi.nlm.nih.gov/articles/${pmcid}/`;
  return void 0;
}

// src/providers.ts
var PUBMED_LANDING = /^https?:\/\/(?:(?:www\.)?pubmed\.ncbi\.nlm\.nih\.gov|(?:www\.)?ncbi\.nlm\.nih\.gov\/pubmed)\/(\d{4,9})\/?(?:[?#].*)?$/i;
var PMC_LANDING = /^https?:\/\/(?:(?:www\.)?pmc\.ncbi\.nlm\.nih\.gov|(?:www\.)?ncbi\.nlm\.nih\.gov\/pmc)\/articles\/(PMC\d+)\/?(?:[?#].*)?$/i;
var EUTILS = /^https?:\/\/eutils\.ncbi\.nlm\.nih\.gov\/entrez\/eutils\/([a-z]+)\.fcgi/i;
var ARXIV_PDF = /^https?:\/\/(?:www\.|export\.)?arxiv\.org\/pdf\/([^?#]+?)(?:\.pdf)?\/?(?:[?#].*)?$/i;
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
  if (ids.length > 1) {
    return { citeUrl: raw, reject: `${raw} addresses ${ids.length} records, not one document \u2014 fetch each record's own page instead.` };
  }
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

// src/repo.ts
import { createHash, randomBytes } from "crypto";
import { existsSync as existsSync5, mkdirSync as mkdirSync3, readdirSync as readdirSync5, renameSync as renameSync3, rmSync as rmSync4, statSync as statSync2 } from "fs";
import { tmpdir as tmpdir4 } from "os";
import { basename, join as join7, resolve as resolve2 } from "path";

// src/forge-host.ts
var KINDS = /* @__PURE__ */ new Set(["github", "gitlab", "gitea"]);
var WWW_ALIASED = /* @__PURE__ */ new Set(["github.com", "gitlab.com", "codeberg.org", "bitbucket.org"]);
function normalizeForgeHost(host) {
  const h = host.trim().toLowerCase();
  const bare = h.replace(/^www\./, "");
  return WWW_ALIASED.has(bare) ? bare : h;
}
function configuredForgeHosts() {
  const out = /* @__PURE__ */ new Map();
  for (const entry of (env("FORGE_HOSTS") ?? "").split(/[\s,]+/)) {
    const eq = entry.indexOf("=");
    if (eq < 1) continue;
    const kind = entry.slice(eq + 1).trim().toLowerCase();
    if (KINDS.has(kind)) out.set(normalizeForgeHost(entry.slice(0, eq)), kind);
  }
  return out;
}
function hostForgeKind(host) {
  const h = normalizeForgeHost(host);
  const declared = configuredForgeHosts().get(h);
  if (declared) return declared;
  if (h === "github.com" || h.endsWith(".github.com") || h.startsWith("github.")) return "github";
  if (h === "gitlab.com" || h.includes("gitlab")) return "gitlab";
  if (h.includes("gitea") || h.includes("codeberg")) return "gitea";
  return void 0;
}

// src/repo.ts
function repoCacheRoot() {
  return env("REPO_DIR") ?? brand().repoDir ?? join7(tmpdir4(), brand().name, "repos");
}
var cloneTimeoutMs = () => envInt("GIT_CLONE_TIMEOUT_MS", 3e5, 1e3);
var fetchTimeoutMs = () => envInt("GIT_FETCH_TIMEOUT_MS", 12e4, 1e3);
var historyTimeoutMs = () => envInt("GIT_HISTORY_TIMEOUT_MS", 3e5, 1e3);
function resolveRepo(raw, opts = {}) {
  const trimmed = raw.trim();
  if (trimmed && opts.local !== false) {
    const asPath = resolve2(trimmed);
    if (existsSync5(asPath) && statSync2(asPath).isDirectory()) {
      return { raw: trimmed, host: "local", isLocal: true, slug: `local-${slugify(`${basename(asPath)}-${asPath}`)}` };
    }
  }
  const p = filePath(trimmed);
  if (p !== void 0) {
    return {
      raw: trimmed,
      host: "file",
      ...basename(p) ? { repo: basename(p) } : {},
      cloneUrl: trimmed,
      isLocal: false,
      slug: `file-${repoSlug(p)}`
    };
  }
  const generic = () => ({ raw: trimmed, host: "generic", isLocal: false, slug: slugify(trimmed) || "seed" });
  let transport;
  let host;
  let rest;
  const scp = /^([\w.-]+)@([^:/]+):(.+)$/.exec(trimmed);
  const url = /^([a-z][a-z0-9+.-]*):\/\/(?:([^@/]+)@)?([^/:?#]+)(?::(\d+))?\/(.+)$/i.exec(trimmed);
  const hostPath = /^([a-z0-9.-]+\.[a-z]{2,})\/(.+)$/i.exec(trimmed);
  if (scp) {
    transport = { kind: "scp", user: scp[1], absolute: scp[3].startsWith("/") };
    host = scp[2];
    rest = scp[3];
  } else if (url) {
    const scheme = url[1].toLowerCase();
    transport = /^(?:https?|ssh|git\+ssh|ssh\+git)$/.test(scheme) ? { kind: "url", scheme: scheme.startsWith("http") ? scheme : "ssh", userinfo: url[2], port: url[4] } : { kind: "https" };
    host = url[3];
    rest = url[5];
  } else if (hostPath) {
    transport = { kind: "https" };
    host = hostPath[1];
    rest = hostPath[2];
  } else if (/^[\w.-]+\/[\w.-]+$/.test(trimmed)) {
    transport = { kind: "https" };
    host = "github.com";
    rest = trimmed;
  } else {
    return generic();
  }
  const user = transport.kind === "scp" ? transport.user : transport.kind === "url" ? transport.userinfo : void 0;
  if (host.startsWith("-") || user?.startsWith("-")) return generic();
  host = normalizeForgeHost(host);
  const segments = repoSegments(host, rest, opts.kind ?? hostForgeKind(host));
  if (!segments) return generic();
  const path = segments.join("/");
  const repo = segments[segments.length - 1];
  const owner = segments.length > 1 ? segments.slice(0, -1).join("/") : void 0;
  const cloneUrl = transport.kind === "scp" ? `${transport.user}@${host}:${transport.absolute ? "/" : ""}${path}.git` : transport.kind === "url" ? `${transport.scheme}://${transport.userinfo ? `${transport.userinfo}@` : ""}${host}${transport.port ? `:${transport.port}` : ""}/${path}.git` : `https://${host}/${path}.git`;
  return {
    raw: trimmed,
    host,
    ...owner ? { owner } : {},
    ...repo ? { repo } : {},
    cloneUrl,
    webUrl: `https://${host}/${path}`,
    isLocal: false,
    slug: repoSlug(`${host}/${path}`)
  };
}
function filePath(url) {
  const file = /^file:\/\/(\/.*)$/.exec(url);
  return file ? trimRuns(file[1].replace(/\.git$/, ""), "/", false) : void 0;
}
function trimRuns(s, ch, start = true) {
  const code = ch.charCodeAt(0);
  let a = 0;
  let b = s.length;
  while (start && a < b && s.charCodeAt(a) === code) a++;
  while (b > a && s.charCodeAt(b - 1) === code) b--;
  return s.slice(a, b);
}
var fold = (k) => trimRuns(k.replace(/[^a-z0-9._-]+/g, "-"), "-");
var sha256Hex = (k) => createHash("sha256").update(k).digest("hex");
function repoSlug(key) {
  const k = key.toLowerCase();
  const folded = fold(k);
  if (/^[a-z0-9._/]+$/.test(k) && slugify(k) === folded) return folded;
  return `${folded.slice(0, 105).replace(/-+$/, "") || "repo"}--${sha256Hex(k).slice(0, 12)}`;
}
function legacySlugs(ref) {
  const p = ref.cloneUrl ? filePath(ref.cloneUrl) : void 0;
  const key = ref.host === "file" ? p : ref.repo ? `${ref.host}/${[ref.owner, ref.repo].filter(Boolean).join("/")}` : void 0;
  if (key === void 0) return [];
  const k = key.toLowerCase();
  const before = slugify(k);
  const v121 = /^[a-z0-9._/]+$/.test(k) || before !== fold(k) ? before : `${slugify(k, { max: 111 })}-${sha256Hex(k).slice(0, 8)}`;
  const prefix = ref.host === "file" ? "file-" : "";
  return [.../* @__PURE__ */ new Set([before, v121])].map((s) => `${prefix}${s}`).filter((s) => s !== ref.slug);
}
var DOT_SEGMENT = /^(?:\.|%2e){1,2}$/i;
var TWO_SEGMENT_HOSTS = /* @__PURE__ */ new Set(["bitbucket.org"]);
function repoSegments(host, rest, kind) {
  let segments = rest.replace(/[?#].*$/s, "").split("/").filter(Boolean);
  if (segments.some((s) => DOT_SEGMENT.test(s))) return void 0;
  const dash = segments.indexOf("-");
  if (dash >= 0) segments = segments.slice(0, dash);
  if (kind === "github" || kind === "gitea" || TWO_SEGMENT_HOSTS.has(host)) segments = segments.slice(0, 2);
  const last = segments.length - 1;
  if (last >= 0) segments[last] = segments[last].replace(/\.git$/i, "");
  return segments.filter(Boolean).length ? segments.filter(Boolean) : void 0;
}
async function ensureClone(ref, opts = {}) {
  if (ref.isLocal) return resolve2(ref.raw);
  if (!ref.cloneUrl) throw new Error(`"${ref.raw}" does not name a repository that can be cloned`);
  if (!have("git")) throw new Error(`git is not installed or not on PATH \u2014 cannot clone ${ref.cloneUrl}`);
  const branch = opts.branch?.trim() || void 0;
  if (branch?.startsWith("-")) throw new Error(`"${branch}" is not a branch name`);
  const dir = join7(repoCacheRoot(), branch ? `${ref.slug}@${branchSlug(branch)}` : ref.slug);
  const pending = inflight.get(dir);
  if (pending && !opts.refresh) {
    return pending.catch((e) => {
      const tree = e?.cachedTree;
      return typeof tree === "string" ? tree : Promise.reject(e);
    });
  }
  const run = () => obtainClone(ref, dir, { refresh: opts.refresh, branch });
  const work = (pending ? pending.then(run, run) : run()).finally(() => {
    if (inflight.get(dir) === work) inflight.delete(dir);
  });
  inflight.set(dir, work);
  return work;
}
var inflight = /* @__PURE__ */ new Map();
function branchSlug(branch) {
  return `${slugify(branch, { max: 40, fallback: "branch" })}-${createHash("sha256").update(branch).digest("hex").slice(0, 8)}`;
}
async function obtainClone(ref, dir, opts) {
  let target = dir;
  if (!existsSync5(join7(dir, ".git")) && !opts.branch) {
    for (const old of legacySlugs(ref)) {
      const legacy = join7(repoCacheRoot(), old);
      const origin = existsSync5(join7(legacy, ".git")) ? originUrl(legacy) : void 0;
      if (origin && resolveRepo(origin).slug === ref.slug) {
        target = legacy;
        break;
      }
    }
  }
  if (existsSync5(join7(target, ".git"))) return opts.refresh ? refreshClone(ref, target, opts.branch) : target;
  return freshClone(ref, dir, opts.branch);
}
async function refreshClone(ref, dir, branch) {
  deepened.delete(dir);
  const probe = await shAsync("git", ["-C", dir, "rev-parse", "--is-shallow-repository"], { timeoutMs: 1e4 });
  const shallow = probe.stdout.trim() !== "false";
  const fetched = await shAsync("git", ["-C", dir, "fetch", "--quiet", ...shallow ? ["--depth", "1"] : [], "origin", branch ?? "HEAD"], {
    timeoutMs: fetchTimeoutMs()
  });
  if (!fetched.ok) {
    throw Object.assign(
      new Error(`refresh failed for ${ref.cloneUrl}: ${fetched.stderr.trim() || `exit ${fetched.status}`} (the cached tree at ${dir} is unchanged)`),
      { cachedTree: dir }
    );
  }
  const reset = await shAsync("git", ["-C", dir, "reset", "--quiet", "--hard", "FETCH_HEAD"], { timeoutMs: fetchTimeoutMs() });
  if (!reset.ok) throw new Error(`refresh of ${dir} fetched ${ref.cloneUrl} but could not check it out: ${reset.stderr.trim() || `exit ${reset.status}`}`);
  return dir;
}
var STALE_STAGING_MS = 24 * 60 * 60 * 1e3;
function discard(path) {
  try {
    rmSync4(path, { recursive: true, force: true });
  } catch {
  }
}
function sweepStaging(staging) {
  try {
    for (const name of readdirSync5(staging)) {
      const at = join7(staging, name);
      if (Date.now() - statSync2(at).mtimeMs > STALE_STAGING_MS) rmSync4(at, { recursive: true, force: true });
    }
  } catch {
  }
}
async function freshClone(ref, dir, branch) {
  const staging = join7(repoCacheRoot(), ".partial");
  mkdirSync3(staging, { recursive: true });
  sweepStaging(staging);
  const attempt = async (filter) => {
    const tmp = join7(staging, `${basename(dir)}-${process.pid}-${randomBytes(4).toString("hex")}`);
    const args = ["clone", "--depth", "1", ...filter ? ["--filter=blob:none"] : [], ...branch ? ["--branch", branch] : [], "--", ref.cloneUrl, tmp];
    const r = await shAsync("git", args, { timeoutMs: cloneTimeoutMs() });
    if (!r.ok) discard(tmp);
    return { r, tmp };
  };
  let done = await attempt(true);
  if (!done.r.ok) {
    const first = done.r;
    done = await attempt(false);
    if (!done.r.ok) {
      throw new Error(
        [
          `git clone failed for ${ref.cloneUrl}`,
          `  attempt 1 (--filter=blob:none): ${first.stderr.trim() || `exit ${first.status}`}`,
          `  attempt 2 (no filter):          ${done.r.stderr.trim() || `exit ${done.r.status}`}`
        ].join("\n")
      );
    }
  }
  if (!existsSync5(done.tmp) || readdirSync5(done.tmp).length === 0) throw new Error(`clone produced an empty tree for ${ref.cloneUrl}`);
  if (existsSync5(dir) && !existsSync5(join7(dir, ".git"))) rmSync4(dir, { recursive: true, force: true });
  try {
    renameSync3(done.tmp, dir);
  } catch (e) {
    discard(done.tmp);
    if (!existsSync5(join7(dir, ".git"))) throw new Error(`could not move the clone of ${ref.cloneUrl} into ${dir}: ${e.message}`);
  }
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
import { resolve as resolve3 } from "path";
function forgeKind(host, opts = {}) {
  return opts.kind ?? hostForgeKind(host);
}
function forgeRef(ref, opts = {}) {
  if (!ref.isLocal) return ref;
  const origin = originUrl(resolve3(ref.raw));
  if (!origin) return ref;
  const remote = resolveRepo(origin.replace(/^([a-z][a-z0-9+.-]*:\/\/)[^@/]*@/i, "$1"), opts);
  return remote.host === "generic" || remote.isLocal ? ref : remote;
}
function apiBase(ref, opts = {}) {
  if (opts.apiBase) return opts.apiBase.replace(/\/+$/, "");
  const host = normalizeForgeHost(typeof ref === "string" ? ref : ref.host);
  const kind = forgeKind(host, opts);
  if (kind === "github") return host === "github.com" ? "https://api.github.com" : `https://${host}/api/v3`;
  if (kind === "gitlab") return `https://${host}/api/v4`;
  return `https://${host}/api/v1`;
}
var TOKEN_HOSTS = {
  github: ["github.com", "api.github.com"],
  gitlab: ["gitlab.com"],
  gitea: []
};
function tokenHostAllowed(kind, host) {
  const h = normalizeForgeHost(host);
  return TOKEN_HOSTS[kind].includes(h) || configuredForgeHosts().get(h) === kind;
}
var TOKEN_VARS = {
  github: ["GITHUB_TOKEN", "GH_TOKEN"],
  gitlab: ["GITLAB_TOKEN"],
  gitea: ["GITEA_TOKEN"]
};
function forgeToken(kind) {
  const own = env(TOKEN_VARS[kind][0]);
  if (own) return { value: own, name: envName(TOKEN_VARS[kind][0]) };
  for (const name of TOKEN_VARS[kind]) {
    const value = process.env[name]?.trim();
    if (value) return { value, name };
  }
  return void 0;
}
function forgeAuthHeaders(kind, host) {
  const t = forgeToken(kind);
  if (!t || host !== void 0 && !tokenHostAllowed(kind, host)) return {};
  return { authorization: kind === "gitea" ? `token ${t.value}` : `Bearer ${t.value}` };
}
function limited(status, headers, data) {
  if (status === 429) return true;
  return status === 403 && (headers.get("x-ratelimit-remaining") === "0" || /rate limit/i.test(JSON.stringify(data ?? "")));
}
function resetTime(headers) {
  const wait = parseRetryAfter(headers, Number.POSITIVE_INFINITY);
  if (wait !== void 0) return new Date(Date.now() + wait).toISOString();
  const epoch = Number(headers.get("x-ratelimit-reset") ?? headers.get("ratelimit-reset"));
  return Number.isFinite(epoch) && epoch > 0 ? new Date(epoch * 1e3).toISOString() : void 0;
}
function quotaState(headers) {
  const remaining = headers.get("x-ratelimit-remaining") ?? headers.get("ratelimit-remaining");
  if (remaining === null || remaining.trim() === "" || !Number.isFinite(Number(remaining))) return void 0;
  return Number(remaining) <= 0 ? "spent" : "left";
}
var REDIRECT_STATUS2 = /* @__PURE__ */ new Set([301, 302, 303, 307, 308]);
var RETRY_STATUS2 = /* @__PURE__ */ new Set([502, 503, 504]);
var MAX_REDIRECTS = 5;
var MAX_BODY_BYTES = 4 * 1024 * 1024;
function failureText(e) {
  const err = e;
  const code = typeof err?.cause?.code === "string" ? err.cause.code : void 0;
  const detail = typeof err?.cause?.message === "string" && err.cause.message ? err.cause.message : code;
  if (!detail) return typeof err?.message === "string" ? err.message : String(e);
  return code && !detail.includes(code) ? `${code}: ${detail}` : detail;
}
async function refusal(authorize, url) {
  if (!authorize) return void 0;
  let error;
  try {
    if (!await authorize(url)) error = `URL not authorized: ${url}`;
  } catch (e) {
    error = `URL authorization failed for ${url}: ${e.message}`;
  }
  return error === void 0 ? void 0 : { ok: false, status: 0, data: void 0, error, permanent: true, refused: true };
}
async function forgeGetOnce(url, headers, timeoutMs, authorize) {
  const ctrl = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    ctrl.abort();
  }, timeoutMs);
  const sent = { ...headers };
  let target = url;
  try {
    for (let hop = 0; ; hop++) {
      const refused = await refusal(authorize, target);
      if (refused) return refused;
      const res = await fetch(target, { headers: sent, redirect: "manual", signal: ctrl.signal });
      const location = res.headers.get("location");
      if (REDIRECT_STATUS2.has(res.status) && location) {
        await res.body?.cancel().catch(() => {
        });
        if (hop >= MAX_REDIRECTS) return { ok: false, status: 0, data: void 0, error: `more than ${MAX_REDIRECTS} redirects from ${url}`, permanent: true };
        const next = new URL(location, target);
        if (next.protocol !== "https:" && next.protocol !== "http:") {
          return { ok: false, status: 0, data: void 0, error: `redirected to ${next.protocol}`, permanent: true };
        }
        if (next.origin !== new URL(target).origin) {
          delete sent.authorization;
          delete sent["private-token"];
          delete sent.cookie;
        }
        target = next.href;
        continue;
      }
      const bytes = await readCappedBytes(res, MAX_BODY_BYTES + 1);
      countFetch(Math.min(bytes.length, MAX_BODY_BYTES), false);
      if (bytes.length > MAX_BODY_BYTES) return { ok: false, status: res.status, data: void 0, error: `response over the ${MAX_BODY_BYTES}-byte cap` };
      const text = bytes.toString("utf8");
      let data;
      try {
        data = text ? JSON.parse(text) : void 0;
      } catch {
        data = text;
      }
      const quota = !res.ok && limited(res.status, res.headers, data);
      const retryAfterMs = RETRY_STATUS2.has(res.status) ? parseRetryAfter(res.headers, Number.POSITIVE_INFINITY) : void 0;
      return {
        ok: res.ok,
        status: res.status,
        data,
        ...quota ? { rateLimited: true, resetAt: resetTime(res.headers), quota: quotaState(res.headers) } : {},
        ...retryAfterMs !== void 0 ? { retryAfterMs } : {}
      };
    }
  } catch (e) {
    if (timedOut) return { ok: false, status: 0, data: void 0, error: `timed out after ${timeoutMs} ms`, timedOut };
    return { ok: false, status: 0, data: void 0, error: failureText(e), ...isPermanentFailure(e) ? { permanent: true } : {} };
  } finally {
    clearTimeout(timer);
  }
}
async function forgeGet(url, kind, ref, opts) {
  const auth = opts.apiBase ? forgeAuthHeaders(kind) : forgeAuthHeaders(kind, ref.host);
  const headers = { "user-agent": contactUa(), accept: kind === "github" ? "application/vnd.github+json" : "application/json", ...auth };
  const tokenVar = auth.authorization ? forgeToken(kind)?.name : void 0;
  const timeoutMs = opts.timeoutMs ?? 15e3;
  const attempts = maxAttempts();
  let r = await forgeGetOnce(url, headers, timeoutMs, opts.authorizeUrl);
  for (let attempt = 1; attempt < attempts; attempt++) {
    const wait = retryWait(r);
    if (wait === void 0) break;
    await sleep(wait);
    r = await forgeGetOnce(url, headers, timeoutMs, opts.authorizeUrl);
  }
  return tokenVar ? { ...r, tokenVar } : r;
}
function retryWait(r) {
  if (RETRY_STATUS2.has(r.status)) return retryDelayMs(r.retryAfterMs);
  if (r.status === 0 && !r.timedOut && !r.permanent) return defaultRetryMs();
  return void 0;
}
var FORGE_NAME = { github: "GitHub", gitlab: "GitLab", gitea: "Gitea" };
function failure(r, forge, ref, action, opts) {
  const host = ref.host;
  const tokenVar = TOKEN_VARS[forge][0];
  const declared = !!opts.apiBase || tokenHostAllowed(forge, host);
  const withheld = !r.tokenVar && !declared ? forgeToken(forge)?.name : void 0;
  const declare = `${envName("FORGE_HOSTS")}=${host}=${forge}`;
  const withheldNote = withheld ? `${withheld} is set, but is only sent to hosts listed in ${envName("FORGE_HOSTS")}: declare this one with ${declare}` : "";
  const authAdvice = withheldNote || (declared ? `set ${tokenVar}` : `declare the host with ${declare} and set ${tokenVar}`);
  if (r.rateLimited) {
    const when = r.resetAt ? ` until ${r.resetAt}` : "";
    const advice = r.quota === "left" ? `a secondary limit on how fast requests arrive; the quota${r.tokenVar ? ` for ${r.tokenVar}` : ""} is not spent` : r.tokenVar ? `the quota for ${r.tokenVar} is spent` : `${authAdvice} to raise the anonymous quota`;
    return {
      note: `${FORGE_NAME[forge]} rate-limited this request${when} \u2014 ${advice}.`,
      status: r.status,
      rateLimited: true,
      ...r.resetAt ? { resetAt: r.resetAt } : {}
    };
  }
  if (r.refused) return { note: `${action} refused: ${r.error}.`, status: 0 };
  if (r.status === 0) {
    let apiHost = host;
    try {
      apiHost = new URL(apiBase(ref, opts)).host;
    } catch {
    }
    return { note: `${action} failed: network error reaching ${apiHost} \u2014 ${r.error ?? "no response"}.`, status: 0 };
  }
  const why = r.status === 404 ? `no such repository on ${host}, or it is private${withheldNote ? ` \u2014 ${withheldNote}` : ""}` : r.status === 401 ? r.tokenVar ? `${host} rejected ${r.tokenVar} \u2014 refresh it, or unset it to read public repositories anonymously` : `${host} requires authentication \u2014 ${authAdvice}` : r.status === 403 ? `${host} refused access${r.tokenVar ? ` \u2014 ${r.tokenVar} may lack the scope this needs` : withheldNote ? ` \u2014 ${withheldNote}` : ""}` : r.status === 422 && forge === "github" ? "GitHub cannot search that repository \u2014 it does not exist, or it is private" : r.status >= 500 ? `${host} is unavailable` : r.error ?? `${host} answered with an error`;
  return { note: `${action} failed (status ${r.status}): ${why}.`, status: r.status };
}
function failed(r, forge, ref, action, opts) {
  return { items: [], ...failure(r, forge, ref, action, opts) };
}
var DOT_SEGMENT2 = /^(?:\.|%2e){1,2}$/i;
function repoPath(ref, forge) {
  if (!ref.owner || !ref.repo) return void 0;
  if ([...ref.owner.split("/"), ref.repo].some((s) => !s || DOT_SEGMENT2.test(s))) return void 0;
  return forge === "gitlab" ? `projects/${encodeURIComponent(`${ref.owner}/${ref.repo}`)}` : `repos/${encodeURIComponent(ref.owner)}/${encodeURIComponent(ref.repo)}`;
}
function clip(s, n = 1200) {
  return String(s ?? "").replace(/\r/g, "").trim().slice(0, n);
}
function labelsOf(v) {
  if (!Array.isArray(v)) return [];
  return v.map((l) => typeof l === "string" ? l : l?.name ?? "").filter(Boolean);
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
async function canonicalRepoRef(ref, opts = {}) {
  const { owner, repo } = await canonicalLookup(forgeRef(ref, opts), opts);
  return { owner, repo };
}
function canonicalLookup(ref, opts) {
  const fallback = { owner: ref.owner ?? "", repo: ref.repo ?? "" };
  const path = forgeKind(ref.host, opts) === "github" ? repoPath(ref, "github") : void 0;
  if (!path) return Promise.resolve(fallback);
  const key = `${ref.host}/${ref.owner}/${ref.repo}`;
  let hit = canonCache.get(key);
  if (!hit) {
    const lookup2 = (async () => {
      if (ghUsable(ref.host)) {
        const r2 = await shAsync("gh", ["api", path, "--jq", ".full_name"], { timeoutMs: opts.timeoutMs ?? 15e3 });
        if (r2.ok && r2.stdout.includes("/")) return splitSlug(r2.stdout.trim(), fallback);
      }
      const r = await forgeGet(`${apiBase(ref, opts)}/${path}`, "github", ref, opts);
      if (!r.ok) return { ...fallback, failed: r };
      const full = r.data?.full_name;
      return typeof full === "string" && full.includes("/") ? splitSlug(full, fallback) : fallback;
    })();
    hit = lookup2;
    canonCache.set(key, lookup2);
    void lookup2.then((c) => {
      if (c.failed && canonCache.get(key) === lookup2) canonCache.delete(key);
    });
  }
  return hit;
}
async function canonicalRepo(ref, opts = {}) {
  ref = forgeRef(ref, opts);
  if (!ref.owner || !ref.repo) return void 0;
  const { owner, repo } = await canonicalRepoRef(ref, opts);
  return `${owner}/${repo}`;
}
var noOrigin = (ref) => `"${ref.raw}" is a local directory with no origin remote \u2014 name the repository it is a clone of.`;
async function searchIssues(ref, terms, kind, opts = {}) {
  ref = forgeRef(ref, opts);
  if (ref.isLocal) return { items: [], note: noOrigin(ref) };
  const forge = forgeKind(ref.host, opts);
  if (!forge) return { items: [], note: `${ref.host} is not a forge this engine knows how to query.` };
  const repoAt = repoPath(ref, forge);
  if (!repoAt) return { items: [], note: `"${ref.raw}" does not name owner/repo.` };
  const wanted = terms.map((t) => t.trim()).filter(Boolean);
  const first = await searchOnce(ref, forge, repoAt, wanted, kind, opts);
  if (first.items.length || first.note || opts.relax === false) return first;
  const relaxed = relaxTerms(wanted);
  if (!relaxed) return first;
  const second = await searchOnce(ref, forge, repoAt, relaxed, kind, opts);
  if (second.note) return second;
  return { ...second, note: `No match for all the terms; relaxed to "${relaxed.join(" ")}".` };
}
function relaxTerms(terms) {
  const qualifiers = terms.filter((t) => t.includes(":"));
  const words = terms.filter((t) => !t.includes(":"));
  if (words.length < 3) return void 0;
  const best = rankedKeywords(words.join(" ")).slice(0, Math.max(2, Math.ceil(words.length / 2)));
  if (best.length < 2 || best.length >= words.length) return void 0;
  return [...best, ...qualifiers];
}
async function searchOnce(ref, forge, repoAt, terms, kind, opts) {
  const limit = Math.max(1, opts.limit ?? 10);
  const q = terms.join(" ");
  if (forge === "github") {
    const canon = await canonicalLookup(ref, opts);
    if (canon.failed) return failed(canon.failed, forge, ref, "GitHub search", opts);
    const filter = kind === "pr" ? "is:pr" : "is:issue";
    const order = q ? "" : "&sort=updated&order=desc";
    const url2 = `${apiBase(ref, opts)}/search/issues?q=${encodeURIComponent(`repo:${canon.owner}/${canon.repo} ${filter} ${q}`.trim())}&per_page=${limit}${order}`;
    const r2 = await forgeGet(url2, forge, ref, opts);
    if (!r2.ok) return failed(r2, forge, ref, "GitHub search", opts);
    return { items: mapGithubIssues(r2.data?.items ?? [], kind) };
  }
  if (forge === "gitlab") {
    const path = kind === "pr" ? "merge_requests" : "issues";
    const url2 = `${apiBase(ref, opts)}/${repoAt}/${path}?search=${encodeURIComponent(q)}&per_page=${limit}&order_by=updated_at`;
    const r2 = await forgeGet(url2, forge, ref, opts);
    if (!r2.ok) return failed(r2, forge, ref, "GitLab search", opts);
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
  const url = `${apiBase(ref, opts)}/${repoAt}/issues?state=all&type=${kind === "pr" ? "pulls" : "issues"}&limit=${limit}&q=${encodeURIComponent(q)}`;
  const r = await forgeGet(url, forge, ref, opts);
  if (!r.ok) return failed(r, forge, ref, "Gitea search", opts);
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
  ref = forgeRef(ref, opts);
  if (ref.isLocal) return { items: [], note: noOrigin(ref) };
  const forge = forgeKind(ref.host, opts);
  const repoAt = forge && repoPath(ref, forge);
  if (!forge || !repoAt) return { items: [], note: `Cannot list releases for "${ref.raw}".` };
  const limit = Math.max(1, opts.limit ?? 20);
  const url = `${apiBase(ref, opts)}/${repoAt}/releases?per_page=${limit}${forge === "gitlab" ? "" : `&limit=${limit}`}`;
  const r = await forgeGet(url, forge, ref, opts);
  if (!r.ok) return failed(r, forge, ref, "Listing releases", opts);
  const items = (Array.isArray(r.data) ? r.data : []).map((it) => ({
    kind: "release",
    title: String(it.name ?? it.tag_name ?? it.tag ?? "").trim() || String(it.tag_name ?? ""),
    // GitLab has no html_url; its page is `_links.self`, an object's field.
    url: String(it.html_url ?? it._links?.self ?? it.web_url ?? ref.webUrl ?? ""),
    state: it.prerelease ? "prerelease" : "released",
    labels: [],
    body: clip(it.body ?? it.description),
    updatedAt: String(it.published_at ?? it.released_at ?? it.created_at ?? "") || void 0
  }));
  return { items };
}
async function listTags(ref, opts = {}) {
  ref = forgeRef(ref, opts);
  if (ref.isLocal) return { items: [], note: noOrigin(ref) };
  const forge = forgeKind(ref.host, opts);
  const repoAt = forge && repoPath(ref, forge);
  if (!forge || !repoAt) return { items: [], note: `Cannot list tags for "${ref.raw}".` };
  const limit = Math.max(1, opts.limit ?? 50);
  const url = forge === "gitlab" ? `${apiBase(ref, opts)}/${repoAt}/repository/tags?per_page=${limit}` : `${apiBase(ref, opts)}/${repoAt}/tags?per_page=${limit}&limit=${limit}`;
  const r = await forgeGet(url, forge, ref, opts);
  if (!r.ok) return failed(r, forge, ref, "Listing tags", opts);
  const tagPage = forge === "gitlab" ? "-/tags" : "releases/tag";
  const items = (Array.isArray(r.data) ? r.data : []).map((it) => {
    const name = String(it.name ?? "").trim();
    const commit = it.commit;
    const at = commit?.created_at ?? commit?.created;
    return {
      kind: "tag",
      title: name,
      url: ref.webUrl ? `${ref.webUrl}/${tagPage}/${name.split("/").map(encodeURIComponent).join("/")}` : "",
      labels: [],
      body: "",
      ...typeof at === "string" ? { updatedAt: at } : {}
    };
  });
  return { items };
}
async function repoFacts(ref, opts = {}) {
  return (await repoFactsResult(ref, opts)).facts;
}
async function repoFactsResult(ref, opts = {}) {
  ref = forgeRef(ref, opts);
  if (ref.isLocal) return { note: noOrigin(ref) };
  const forge = forgeKind(ref.host, opts);
  if (!forge) return { note: `${ref.host} is not a forge this engine knows how to query.` };
  const repoAt = repoPath(ref, forge);
  if (!repoAt) return { note: `"${ref.raw}" does not name owner/repo.` };
  const r = await forgeGet(`${apiBase(ref, opts)}/${repoAt}${forge === "gitlab" ? "?license=true" : ""}`, forge, ref, opts);
  if (!r.ok) return failure(r, forge, ref, `Reading ${ref.webUrl ?? ref.raw}`, opts);
  if (!r.data || typeof r.data !== "object") return { status: r.status, note: `${ref.host} answered with something other than a repository record.` };
  return { status: r.status, facts: mapRepoFacts(forge, r.data) };
}
var str2 = (v) => typeof v === "string" && v.trim() ? v : void 0;
var num2 = (v) => typeof v === "number" ? v : void 0;
function mapRepoFacts(forge, d) {
  const topics = (v) => Array.isArray(v) ? v.filter((t) => typeof t === "string") : [];
  const shared = {
    description: str2(d.description),
    forks: num2(d.forks_count),
    openIssues: num2(d.open_issues_count),
    defaultBranch: str2(d.default_branch),
    archived: typeof d.archived === "boolean" ? d.archived : void 0
  };
  if (forge === "gitlab") {
    return {
      ...shared,
      fullName: str2(d.path_with_namespace),
      // A project has no homepage field; its page is the closest thing it states.
      homepage: str2(d.web_url),
      license: str2(d.license?.name) ?? str2(d.license?.key),
      stars: num2(d.star_count),
      pushedAt: str2(d.last_activity_at),
      topics: topics(d.topics).length ? topics(d.topics) : topics(d.tag_list)
    };
  }
  if (forge === "gitea") {
    return {
      ...shared,
      fullName: str2(d.full_name),
      homepage: str2(d.website),
      license: Array.isArray(d.licenses) ? str2(d.licenses[0]) : void 0,
      stars: num2(d.stars_count),
      pushedAt: str2(d.updated_at),
      topics: topics(d.topics)
    };
  }
  const spdx = str2(d.license?.spdx_id);
  return {
    ...shared,
    fullName: str2(d.full_name),
    homepage: str2(d.homepage),
    license: spdx && spdx !== "NOASSERTION" ? spdx : str2(d.license?.name),
    stars: num2(d.stargazers_count),
    pushedAt: str2(d.pushed_at),
    topics: topics(d.topics)
  };
}

// src/registry.ts
var REGISTRIES = ["npm", "pypi", "crates"];
var NPM = (n) => `https://registry.npmjs.org/${encodeURIComponent(n).replace(/^%40/, "@")}`;
var PYPI = (n, version) => `https://pypi.org/pypi/${encodeURIComponent(n)}/${version ? `${encodeURIComponent(version)}/` : ""}json`;
var CRATES = (n) => `https://crates.io/api/v1/crates/${encodeURIComponent(n)}`;
var SHORTHAND_HOST = { github: "github.com", gitlab: "gitlab.com", bitbucket: "bitbucket.org" };
function normalizeRepoUrl(raw) {
  const s = typeof raw === "string" ? raw.trim() : typeof raw?.url === "string" ? String(raw.url).trim() : "";
  if (!s) return void 0;
  const short = /^(github|gitlab|bitbucket):([\w.-]+\/[\w.-]+?)(?:\.git)?(?:#.*)?$/i.exec(s);
  if (short) return `https://${SHORTHAND_HOST[short[1].toLowerCase()]}/${short[2]}`;
  let out = s.replace(/#.*$/s, "").replace(/^git\+/i, "").replace(/^git:\/\//i, "https://").replace(/^ssh:\/\/(?:[^@/]+@)?([^/:]+)(?::\d+)?\//i, "https://$1/").replace(/^ssh:\/\/(?:[^@/]+@)?([^/:]+):/i, "https://$1/").replace(/^[\w.-]+@([^:/]+):/, "https://$1/").replace(/\/+$/, "").replace(/\.git$/i, "");
  if (/^[\w.-]+\/[\w.-]+$/.test(out)) out = `https://github.com/${out}`;
  return /^https?:\/\//i.test(out) ? out.replace(/^https?:\/\//i, (scheme) => scheme.toLowerCase()) : void 0;
}
function reqOpts() {
  return { timeoutMs: 12e3, userAgent: contactUa(), accept: "application/json" };
}
var NPM_TIME_TAIL_FIRST_BYTES = 256 * 1024;
var NPM_TIME_TAIL_BYTES = 2 * 1024 * 1024;
var isWs = (c) => c === " " || c === "	" || c === "\n" || c === "\r";
function opensTimeMap(text, i) {
  let j = i - 1;
  while (j >= 0 && isWs(text[j])) j--;
  if (text[j] !== ":") return false;
  j--;
  while (j >= 0 && isWs(text[j])) j--;
  return j >= 5 && text.slice(j - 5, j + 1) === '"time"';
}
var MAX_OPEN_TIME_MAPS = 16;
function scanTimeMap(text, version, phase) {
  let publishedAt;
  let closed = false;
  let depth = 0;
  let quoted = phase !== "outside";
  let escaped = phase === "escape";
  const open = [];
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quoted) {
      if (escaped) escaped = false;
      else if (c === "\\") escaped = true;
      else if (c === '"') quoted = false;
      continue;
    }
    if (c === '"') quoted = true;
    else if (c === "{") {
      if (open.length < MAX_OPEN_TIME_MAPS && opensTimeMap(text, i)) open.push({ at: i, depth });
      depth++;
    } else if (c === "}") {
      depth--;
      const top = open[open.length - 1];
      if (top?.depth === depth) {
        open.pop();
        try {
          const time = JSON.parse(text.slice(top.at, i + 1));
          if (time && typeof time === "object" && !Array.isArray(time)) {
            closed = true;
            if (typeof time[version] === "string") publishedAt = time[version];
          }
        } catch (err) {
          if (!(err instanceof SyntaxError)) throw err;
        }
      }
      while (open.length && open[open.length - 1].depth > depth) open.pop();
    }
  }
  return { publishedAt, closed };
}
function npmTimeFromTail(text, version) {
  let closed = false;
  for (const phase of ["outside", "string", "escape"]) {
    const found = scanTimeMap(text, version, phase);
    if (found.publishedAt) return found;
    closed ||= found.closed;
  }
  return { closed };
}
async function npmPublishedAt(packageUrl, version) {
  if (!version) return void 0;
  for (const bytes of [NPM_TIME_TAIL_FIRST_BYTES, NPM_TIME_TAIL_BYTES]) {
    const tail = await httpGet(packageUrl, {
      ...reqOpts(),
      // Optional enrichment must not inherit the primary lookup's retry budget:
      // package facts are already usable if this suffix is slow or unavailable.
      timeoutMs: 2500,
      retries: 0,
      headers: { range: `bytes=-${bytes}` },
      maxBytes: bytes
    });
    if (!tail.ok) return void 0;
    const found = npmTimeFromTail(tail.body, version);
    if (found.publishedAt || found.closed || tail.status !== 206) return found.publishedAt;
  }
  return void 0;
}
function record(r) {
  return r.ok && r.data && typeof r.data === "object" && !Array.isArray(r.data) ? r.data : void 0;
}
var ABSENT = /* @__PURE__ */ new Set([400, 404, 410]);
var str3 = (v) => typeof v === "string" && v.trim() ? v.trim() : void 0;
function miss(r) {
  if (ABSENT.has(r.status)) return { status: r.status };
  const said = r.data && typeof r.data === "object" ? str3(r.data.errors?.[0]?.detail) ?? str3(r.data.message) ?? str3(r.data.error) : void 0;
  return { status: r.status, error: r.error ?? said ?? (r.ok ? "the registry answered with something other than a package record" : `status ${r.status}`) };
}
async function lookupPackage(registry, name, version) {
  return (await lookupPackageResult(registry, name, version)).facts;
}
async function lookupPackageResult(registry, name, version) {
  if (!REGISTRIES.includes(registry)) return { status: 0, error: `unknown registry "${String(registry)}" \u2014 expected ${REGISTRIES.join(", ")}` };
  const n = name.trim();
  if (!n) return { status: 0, error: "no package name given" };
  const v = version?.trim() || void 0;
  if (registry === "npm") return npmLookup(n, v);
  if (registry === "pypi") return pypiLookup(n, v);
  return cratesLookup(n, v);
}
async function npmLookup(n, version) {
  const r = await httpJson("GET", `${NPM(n)}/${encodeURIComponent(version ?? "latest")}`, void 0, reqOpts());
  const d = record(r);
  if (!d) return miss(r);
  const asked = version ?? "latest";
  const tags = d["dist-tags"] ?? {};
  const resolved = str3(d.version) ?? (typeof tags[asked] === "string" ? tags[asked] : void 0) ?? (d.versions?.[asked] ? asked : void 0);
  const v = resolved && d.versions?.[resolved] || d;
  const stated = resolved ? d.time?.[resolved] : void 0;
  const publishedAt = typeof stated === "string" ? stated : await npmPublishedAt(NPM(n), resolved);
  const deprecated = typeof v.deprecated === "string" ? v.deprecated : v.deprecated === true ? "deprecated" : void 0;
  const repository = v.repository ?? d.repository;
  const directory = str3(repository?.directory);
  return {
    status: r.status,
    facts: {
      registry: "npm",
      name: d.name ?? n,
      version: resolved,
      description: v.description ?? d.description,
      homepage: v.homepage ?? d.homepage,
      repository: normalizeRepoUrl(repository),
      ...directory ? { repositoryDirectory: directory } : {},
      documentation: typeof v.documentation === "string" ? v.documentation : void 0,
      license: typeof v.license === "string" ? v.license : v.license?.type,
      ...deprecated ? { deprecated } : {},
      publishedAt
    }
  };
}
var FORGE_URL = /^https?:\/\/(?:www\.)?(?:github\.com|gitlab\.com|codeberg\.org|bitbucket\.org)\/[^/]+\/[^/]+/i;
var PYPI_REPO_LABELS = ["source", "sourcecode", "repository", "code", "github", "gitlab"];
function projectUrls(raw) {
  const out = /* @__PURE__ */ new Map();
  if (!raw || typeof raw !== "object") return out;
  for (const [label, url] of Object.entries(raw)) {
    const key = label.toLowerCase().replace(/[^a-z]/g, "");
    if (typeof url === "string" && url.trim() && !out.has(key)) out.set(key, url.trim());
  }
  return out;
}
function pypiLicense(info, classifiers) {
  const expression = str3(info.license_expression);
  if (expression) return expression;
  const license = str3(info.license);
  if (license && license.length <= 100 && !license.includes("\n")) return license;
  const named = classifiers.filter((c) => c.startsWith("License ::")).map((c) => c.split("::").pop().trim());
  return named.filter(Boolean).join(", ") || void 0;
}
async function pypiLookup(n, version) {
  const r = await httpJson("GET", PYPI(n, version), void 0, reqOpts());
  const d = record(r);
  if (!d) return miss(r);
  const info = d.info ?? {};
  const urls = projectUrls(info.project_urls);
  const classifiers = Array.isArray(info.classifiers) ? info.classifiers.filter((c) => typeof c === "string") : [];
  const homepage = str3(info.home_page) ?? urls.get("homepage");
  const labelled = PYPI_REPO_LABELS.map((k) => urls.get(k)).find(Boolean);
  const repository = labelled ?? [info.home_page, urls.get("homepage")].find((u) => typeof u === "string" && FORGE_URL.test(u));
  const filesYanked = Array.isArray(d.urls) && d.urls.length ? d.urls.every((u) => u.yanked) : false;
  const yanked = info.yanked === true ? `this release is yanked${str3(info.yanked_reason) ? `: ${str3(info.yanked_reason)}` : ""}` : filesYanked ? "every file for this release is yanked" : void 0;
  const inactive = classifiers.find((c) => /^Development Status :: 7 - Inactive/.test(c));
  const deprecated = yanked ?? (inactive ? `the project declares itself inactive (${inactive})` : void 0);
  return {
    status: r.status,
    facts: {
      registry: "pypi",
      name: info.name ?? n,
      version: info.version,
      description: info.summary,
      homepage,
      repository: normalizeRepoUrl(repository),
      documentation: str3(info.docs_url) ?? urls.get("documentation") ?? urls.get("docs"),
      license: pypiLicense(info, classifiers),
      ...deprecated ? { deprecated } : {}
    }
  };
}
async function cratesLookup(n, version) {
  const [crateAnswer, pinnedAnswer] = await Promise.all([
    httpJson("GET", `${CRATES(n)}?include=default_version`, void 0, reqOpts()),
    version ? httpJson("GET", `${CRATES(n)}/${encodeURIComponent(version)}`, void 0, reqOpts()) : void 0
  ]);
  const d = record(crateAnswer);
  if (!d) return miss(crateAnswer);
  let v;
  if (pinnedAnswer) {
    const pinned = record(pinnedAnswer);
    if (!pinned) return miss(pinnedAnswer);
    v = pinned.version ?? {};
  }
  const c = d.crate ?? {};
  const listed = Array.isArray(d.versions) ? str3(d.versions[0]?.num) : void 0;
  const newest = str3(c.newest_version) === "0.0.0" ? void 0 : str3(c.newest_version);
  const num3 = version ? str3(v?.num) ?? version : str3(c.default_version) ?? listed ?? str3(c.max_stable_version) ?? newest;
  v ??= Array.isArray(d.versions) ? d.versions.find((x) => x?.num === num3) : void 0;
  const yanked = v?.yanked === true ? `this version is yanked${str3(v.yank_message) ? `: ${str3(v.yank_message)}` : ""}` : void 0;
  return {
    status: crateAnswer.status,
    facts: {
      registry: "crates",
      name: c.name ?? n,
      version: num3,
      description: str3(c.description) ?? str3(v?.description),
      homepage: str3(c.homepage) ?? str3(v?.homepage),
      repository: normalizeRepoUrl(c.repository ?? v?.repository),
      documentation: str3(c.documentation) ?? str3(v?.documentation),
      license: str3(v?.license),
      downloads: typeof c.downloads === "number" ? c.downloads : void 0,
      publishedAt: str3(v?.created_at) ?? (version ? void 0 : str3(c.updated_at)),
      ...yanked ? { deprecated: yanked } : {}
    }
  };
}
async function resolvePackage(name, opts = {}) {
  return (await resolvePackageResult(name, opts)).facts;
}
async function resolvePackageResult(name, opts = {}) {
  if (!name.trim()) return { tried: [], note: "no package name given" };
  const order = opts.registry ? [opts.registry] : REGISTRIES;
  const tried = [];
  for (const registry of order) {
    const r = await lookupPackageResult(registry, name, opts.version);
    tried.push({ registry, status: r.status, ...r.error ? { error: r.error } : {} });
    if (r.facts) return { facts: r.facts, tried };
    if (!REGISTRIES.includes(registry)) return { tried, note: r.error };
    if (!ABSENT.has(r.status)) {
      const why = r.status ? ` (status ${r.status})` : "";
      return { tried, note: `${registry} could not be asked${why}: ${r.error ?? "no answer"} \u2014 retry, or name the registry the package is on.` };
    }
  }
  const at = opts.version ? ` at version ${opts.version}` : "";
  const range = opts.version && /[\^~<>=*|\s]|^[xX]$|\.[xX]\b/.test(opts.version) ? " (a version range is not resolved \u2014 pass an exact version, or an npm dist-tag)" : "";
  return { tried, note: `no registry knows a package called "${name.trim()}"${at}${range}` };
}

// src/robots.ts
var EMPTY = { rules: [], sitemaps: [], absent: true };
function productToken(s) {
  return /^[A-Za-z_-]+/.exec(s.trim())?.[0]?.toLowerCase();
}
function parseRobots(body, userAgent) {
  const ua = productToken(userAgent) ?? userAgent.trim().toLowerCase();
  const groups = /* @__PURE__ */ new Map();
  const delays = /* @__PURE__ */ new Map();
  const sitemaps = [];
  let current2 = [];
  let inHeader = false;
  for (const raw of body.split(/\r\n|\r|\n/)) {
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
      const token = value === "*" ? "*" : productToken(value);
      if (token) current2.push(token);
      inHeader = true;
      for (const g of current2) if (!groups.has(g)) groups.set(g, []);
      continue;
    }
    inHeader = false;
    if (!current2.length) continue;
    if (field === "allow" || field === "disallow") {
      for (const g of current2) groups.get(g).push({ allow: field === "allow", path: value });
    } else if (field === "crawl-delay") {
      const n = value === "" ? Number.NaN : Number(value);
      if (Number.isFinite(n) && n >= 0) for (const g of current2) delays.set(g, n * 1e3);
    }
  }
  const chosen = groups.has(ua) ? ua : groups.has("*") ? "*" : void 0;
  if (chosen === void 0) return { rules: [], sitemaps, absent: false };
  const rules = [...groups.get(chosen)].sort((a, b) => matcherOf(b).length - matcherOf(a).length || (a.allow === b.allow ? 0 : a.allow ? -1 : 1));
  const crawlDelayMs = delays.get(chosen);
  return { rules, sitemaps, absent: false, ...crawlDelayMs !== void 0 ? { crawlDelayMs } : {} };
}
var UNRESERVED = /^[A-Za-z0-9\-._~]$/;
var HEX2 = /^[0-9A-Fa-f]{2}$/;
function normalisePath(s) {
  let out = "";
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (c === "%" && HEX2.test(s.slice(i + 1, i + 3))) {
      const hex = s.slice(i + 1, i + 3);
      const ch2 = String.fromCharCode(Number.parseInt(hex, 16));
      out += UNRESERVED.test(ch2) ? ch2 : `%${hex.toUpperCase()}`;
      i += 2;
      continue;
    }
    const code = c.charCodeAt(0);
    if (code > 32 && code < 127 && !'"<>`{}|\\^'.includes(c)) {
      out += c;
      continue;
    }
    const cp = s.codePointAt(i);
    const ch = String.fromCodePoint(cp);
    try {
      out += encodeURIComponent(ch);
    } catch {
      out += "%EF%BF%BD";
    }
    i += ch.length - 1;
  }
  return out;
}
var matchers = /* @__PURE__ */ new WeakMap();
function matcherOf(rule) {
  let m = matchers.get(rule);
  if (!m) {
    const pattern = normalisePath(rule.path);
    const anchored = pattern.endsWith("$");
    m = { parts: (anchored ? pattern.slice(0, -1) : pattern).split("*"), anchored, length: pattern.length };
    matchers.set(rule, m);
  }
  return m;
}
function matches(m, path) {
  const { parts, anchored } = m;
  const first = parts[0];
  if (!path.startsWith(first)) return false;
  if (parts.length === 1) return !anchored || path.length === first.length;
  let pos = first.length;
  const last = parts.length - 1;
  for (let i = 1; i < last; i++) {
    const at = path.indexOf(parts[i], pos);
    if (at < 0) return false;
    pos = at + parts[i].length;
  }
  const tail = parts[last];
  return anchored ? path.length - tail.length >= pos && path.endsWith(tail) : path.indexOf(tail, pos) >= 0;
}
function isAllowed(robots, url) {
  if (!robots.rules.length) return true;
  let path;
  try {
    const u = new URL(url);
    path = normalisePath(u.pathname + u.search);
  } catch {
    return true;
  }
  for (const rule of robots.rules) {
    if (rule.path !== "" && matches(matcherOf(rule), path)) return rule.allow;
  }
  return true;
}
var ROBOTS_TTL_MS = 24 * 60 * 60 * 1e3;
var UNREACHABLE_TTL_MS = 5 * 60 * 1e3;
var cache = /* @__PURE__ */ new Map();
var guardedCaches = /* @__PURE__ */ new WeakMap();
function resetRobotsCache() {
  cache.clear();
  guardedCaches = /* @__PURE__ */ new WeakMap();
}
async function readRobots(origin, authorize) {
  let refused = false;
  const authorizeUrl = async (u) => {
    const ok = authorize ? await authorize(u) : true;
    if (!ok) refused = true;
    return ok;
  };
  const r = await httpGet(`${origin}/robots.txt`, { accept: "text/plain", timeoutMs: 5e3, maxBytes: 512 * 1024, authorizeUrl });
  if (r.ok) {
    const body = r.truncated ? r.body.slice(0, Math.max(r.body.lastIndexOf("\n"), r.body.lastIndexOf("\r")) + 1) : r.body;
    if (!body.trim()) return { ...EMPTY, status: r.status };
    return { ...parseRobots(body, env("ROBOTS_UA") ?? brand().name), status: r.status };
  }
  if (!refused && !r.redirectFailed && (r.status === 0 || r.status === 429 || r.status >= 500)) {
    return { rules: [{ allow: false, path: "/" }], sitemaps: [], absent: false, status: r.status, unreachable: true };
  }
  return { ...EMPTY, status: r.status };
}
async function fetchRobots(url, opts = {}) {
  if (envFlag("NO_ROBOTS")) return EMPTY;
  let origin;
  try {
    origin = new URL(url).origin;
  } catch {
    return EMPTY;
  }
  let scopedCache = cache;
  if (opts.authorizeUrl) {
    const existing = guardedCaches.get(opts.authorizeUrl);
    scopedCache = existing ?? /* @__PURE__ */ new Map();
    if (!existing) guardedCaches.set(opts.authorizeUrl, scopedCache);
  }
  const hit = scopedCache.get(origin);
  if (hit && hit.expires > Date.now()) return hit.robots;
  const entry = { robots: readRobots(origin, opts.authorizeUrl), expires: Number.POSITIVE_INFINITY };
  scopedCache.set(origin, entry);
  const robots = await entry.robots;
  entry.expires = Date.now() + (robots.unreachable ? UNREACHABLE_TTL_MS : ROBOTS_TTL_MS);
  return robots;
}

// src/structured.ts
var openTag = (name) => new RegExp(`<${name}(?=[\\s/>])(?:[^<>"']|"[^"]*"|'[^']*')*>`, "gi");
function parseJsonLd(raw) {
  try {
    return JSON.parse(raw);
  } catch {
  }
  const lenient = raw.replace(/^\s*(?:\/\*\s*<!\[CDATA\[\s*\*\/|\/\/\s*<!\[CDATA\[|<!\[CDATA\[)/, "").replace(/(?:\/\*\s*\]\]>\s*\*\/|\/\/\s*\]\]>|\]\]>)\s*$/, "").replace(/\s+/g, " ").replace(/,(\s*[}\]])/g, "$1");
  try {
    return JSON.parse(lenient);
  } catch {
    return void 0;
  }
}
var MAX_JSONLD_DEPTH = 32;
function nestsDeeper(v, max) {
  const stack = [[v, 0]];
  while (stack.length) {
    const [x, depth] = stack.pop();
    if (!x || typeof x !== "object") continue;
    if (depth >= max) return true;
    for (const y of Array.isArray(x) ? x : Object.values(x)) if (y && typeof y === "object") stack.push([y, depth + 1]);
  }
  return false;
}
function flattenJsonLd(v, out) {
  if (Array.isArray(v)) for (const x of v) flattenJsonLd(x, out);
  else if (v && typeof v === "object" && Array.isArray(v["@graph"])) {
    for (const x of v["@graph"]) out.push(x);
  } else out.push(v);
}
function extractJsonLd(html) {
  const out = [];
  const open = new RegExp(`<!--|${openTag("script").source}`, "gi");
  const close = closeTagRe("script");
  let commentsClose = true;
  let m;
  while (m = open.exec(html)) {
    if (m[0] === "<!--") {
      const end = commentsClose ? html.indexOf("-->", m.index + 2) : -1;
      if (end < 0) commentsClose = false;
      else open.lastIndex = end + 3;
      continue;
    }
    close.lastIndex = open.lastIndex;
    const c = close.exec(html);
    if (!c) break;
    const type = (htmlAttributes(m[0]).get("type") ?? "").split(";")[0].trim().toLowerCase();
    if (type === "application/ld+json") {
      const raw = html.slice(open.lastIndex, c.index).replace(/^\s*<!--/, "").replace(/-->\s*$/, "").trim();
      const parsed = raw ? parseJsonLd(raw) : void 0;
      if (parsed !== void 0 && !nestsDeeper(parsed, MAX_JSONLD_DEPTH)) flattenJsonLd(parsed, out);
    }
    open.lastIndex = c.index + c[0].length;
  }
  return out;
}
function metaEntries(html) {
  const out = [];
  for (const m of dropElements(html, ["script", "style", "template"]).matchAll(openTag("meta"))) {
    const attrs = htmlAttributes(m[0]);
    const key = (attrs.get("property") ?? attrs.get("name") ?? attrs.get("itemprop"))?.trim().toLowerCase();
    const content = attrs.has("content") ? decodeEntities(attrs.get("content")).trim() : "";
    if (key && content) out.push([key, content]);
  }
  return out;
}
function extractMetaTags(html) {
  const out = /* @__PURE__ */ new Map();
  for (const [key, content] of metaEntries(html)) if (!out.has(key)) out.set(key, content);
  return out;
}
var isNode = (v) => !!v && typeof v === "object" && !Array.isArray(v);
var CHROME_TYPES = /* @__PURE__ */ new Set([
  "Organization",
  "Corporation",
  "NewsMediaOrganization",
  "WebSite",
  "BreadcrumbList",
  "ListItem",
  "SiteNavigationElement",
  "WPHeader",
  "WPFooter",
  "WPSideBar",
  "WPAdBlock",
  "Person",
  "ImageObject",
  "SearchAction",
  "ContactPoint",
  "PostalAddress"
]);
var PAGE_TYPES = /* @__PURE__ */ new Set([
  "WebPage",
  "ItemPage",
  "AboutPage",
  "CollectionPage",
  "ContactPage",
  "ProfilePage",
  "SearchResultsPage",
  "CheckoutPage",
  "QAPage",
  "FAQPage",
  "MedicalWebPage"
]);
var WORK_TYPES = /* @__PURE__ */ new Set([
  "CreativeWork",
  "Blog",
  "Book",
  "Chapter",
  "Course",
  "Dataset",
  "Game",
  "Guide",
  "HowTo",
  "Legislation",
  "Movie",
  "MusicAlbum",
  "Question",
  "Recipe",
  "Report",
  "SoftwareSourceCode",
  "Thesis",
  "VideoGame",
  "VideoObject",
  "AudioObject"
]);
var WORK_SUFFIX = /(?:Article|Posting|Event|Review|Product|Application|Episode|Series|Recording)$/;
var isWork = (t) => WORK_TYPES.has(t) || WORK_SUFFIX.test(t);
var typesOf = (n) => allStrings(n["@type"]).map((t) => t.slice(Math.max(t.lastIndexOf("/"), t.lastIndexOf(":")) + 1));
function rank(n) {
  const types = typesOf(n);
  if (!types.length) return 1;
  if (types.some(isWork)) return 4;
  if (types.some((t) => !CHROME_TYPES.has(t) && !PAGE_TYPES.has(t))) return 3;
  return types.some((t) => PAGE_TYPES.has(t)) ? 2 : 0;
}
function indexById(nodes) {
  const byId = /* @__PURE__ */ new Map();
  const visit = (v, depth) => {
    if (depth > 6) return;
    if (Array.isArray(v)) {
      for (const x of v) visit(x, depth + 1);
      return;
    }
    if (!isNode(v)) return;
    const id = v["@id"];
    if (typeof id === "string" && Object.keys(v).length > 1 && !byId.has(id)) byId.set(id, v);
    for (const x of Object.values(v)) if (typeof x === "object") visit(x, depth + 1);
  };
  visit(nodes, 0);
  return byId;
}
function allStrings(v) {
  if (typeof v === "string") return v.trim() ? [v.trim()] : [];
  if (Array.isArray(v)) return v.flatMap(allStrings);
  return [];
}
function firstString(v) {
  return allStrings(v)[0];
}
function pageMetadata(html, opts = {}) {
  const entries = metaEntries(html);
  const meta = /* @__PURE__ */ new Map();
  for (const [key, content] of entries) if (!meta.has(key)) meta.set(key, content);
  const jsonLd = extractJsonLd(html);
  const out = { authors: [], jsonLd };
  const set = (k, v) => {
    if (v !== void 0 && out[k] === void 0) out[k] = v;
  };
  const authorSeen = /* @__PURE__ */ new Set();
  const addAuthor = (a) => {
    if (out.authors.length >= MAX_AUTHORS || authorSeen.has(a)) return;
    authorSeen.add(a);
    out.authors.push(a);
  };
  const nodes = jsonLd.filter(isNode);
  const byId = indexById(jsonLd);
  const deref = (v) => {
    if (!isNode(v) || typeof v["@id"] !== "string" || "name" in v || "url" in v) return v;
    return byId.get(v["@id"]) ?? v;
  };
  const names = (v) => {
    if (Array.isArray(v)) return v.flatMap(names);
    const d = deref(v);
    return isNode(d) ? allStrings(d.name) : allStrings(d);
  };
  const image = (v) => {
    if (Array.isArray(v)) return v.map(image).find(Boolean);
    const d = deref(v);
    return isNode(d) ? firstString(d.url) ?? firstString(d.contentUrl) : firstString(d);
  };
  let primary;
  for (const n of nodes) if (rank(n) > (primary ? rank(primary) : 0)) primary = n;
  const sources = primary ? [primary, ...nodes.filter((n) => n !== primary && rank(n) === 2)] : [];
  for (const n of sources) {
    set("type", firstString(n["@type"]));
    set("title", firstString(n.headline) ?? names(n.name)[0]);
    set("description", firstString(n.description));
    set("publishedAt", firstString(n.datePublished));
    set("modifiedAt", firstString(n.dateModified));
    set("imageUrl", image(n.image));
    set("siteName", names(n.publisher)[0]);
    if (!out.authors.length) for (const a of names(n.author)) addAuthor(a);
  }
  const nameOfA = (...types) => nodes.filter((n) => typesOf(n).some((t) => types.includes(t))).flatMap((n) => names(n.name))[0];
  set("siteName", nameOfA("WebSite"));
  set("title", meta.get("og:title") ?? meta.get("twitter:title"));
  set("description", meta.get("og:description") ?? meta.get("description") ?? meta.get("twitter:description"));
  set("type", meta.get("og:type"));
  set("siteName", meta.get("og:site_name"));
  set("siteName", nameOfA("Organization", "NewsMediaOrganization", "Corporation"));
  set("publishedAt", meta.get("article:published_time") ?? meta.get("datepublished") ?? meta.get("citation_publication_date"));
  set("modifiedAt", meta.get("article:modified_time") ?? meta.get("datemodified"));
  set("imageUrl", meta.get("og:image") ?? meta.get("twitter:image"));
  set("canonicalUrl", htmlCanonicalUrl(html) ?? sources.map((n) => firstString(n.url)).find(Boolean));
  const authorKeys = /* @__PURE__ */ new Set(["article:author", "author", "citation_author", "dc.creator"]);
  for (const [key, v] of entries) if (authorKeys.has(key)) addAuthor(v);
  if (!primary || rank(primary) < 4) {
    const read2 = new Set(sources);
    const rest = nodes.filter((n) => !read2.has(n) && rank(n) > 0);
    for (const n of rest) {
      if (out.authors.length) break;
      for (const a of names(n.author)) addAuthor(a);
    }
    set("publishedAt", rest.map((n) => firstString(n.datePublished)).find(Boolean));
  }
  set("title", htmlTitle(html));
  if (opts.baseUrl) {
    for (const k of ["canonicalUrl", "imageUrl"]) {
      if (out[k] === void 0) continue;
      const abs = resolveUrl(out[k], opts.baseUrl);
      if (abs) out[k] = abs;
      else delete out[k];
    }
  }
  return out;
}
var MAX_AUTHORS = 1e4;
function resolveUrl(url, base2) {
  try {
    const abs = new URL(url, base2);
    return abs.protocol === "http:" || abs.protocol === "https:" ? abs.href : void 0;
  } catch {
    return void 0;
  }
}

// src/feed.ts
import { promisify } from "util";
import { gunzip } from "zlib";
var OPENERS = /* @__PURE__ */ new Map();
function openerRe(name) {
  let re = OPENERS.get(name);
  if (!re) OPENERS.set(name, re = new RegExp(`<${name}(?=[\\s/>])`, "gi"));
  return re;
}
var withoutBom = (s) => s.charCodeAt(0) === 65279 ? s.slice(1) : s;
function markupOnly(xml) {
  if (!xml.includes("<![CDATA[") && !xml.includes("<!--")) return xml;
  const re = /<!\[CDATA\[|<!--/g;
  let out = "";
  let pos = 0;
  let m;
  while (m = re.exec(xml)) {
    const close = xml.indexOf(m[0] === "<!--" ? "-->" : "]]>", m.index + m[0].length);
    const end = close < 0 ? xml.length : close + 3;
    out += xml.slice(pos, m.index) + " ".repeat(end - m.index);
    pos = re.lastIndex = end;
  }
  return out + xml.slice(pos);
}
function elements(xml, name, limit = Number.POSITIVE_INFINITY) {
  const scan = markupOnly(xml);
  const open = openerRe(name);
  const close = closeTagRe(name);
  const out = [];
  open.lastIndex = 0;
  let m;
  while (out.length < limit && (m = open.exec(scan))) {
    const tagEnd = scan.indexOf(">", open.lastIndex);
    if (tagEnd < 0) break;
    const attrs = xml.slice(open.lastIndex, tagEnd);
    if (attrs.endsWith("/")) {
      out.push({ attrs: attrs.slice(0, -1), inner: "", from: m.index, to: tagEnd + 1 });
      open.lastIndex = tagEnd + 1;
      continue;
    }
    close.lastIndex = tagEnd + 1;
    const c = close.exec(scan);
    if (!c) break;
    out.push({ attrs, inner: xml.slice(tagEnd + 1, c.index), from: m.index, to: c.index + c[0].length });
    open.lastIndex = c.index + c[0].length;
  }
  return out;
}
var OPEN_TAGS = /* @__PURE__ */ new Map();
function openTags(html, name) {
  let re = OPEN_TAGS.get(name);
  if (!re) OPEN_TAGS.set(name, re = new RegExp(`<${name}(?=[\\s/>])[^<>"']*(?:(?:"[^"]*"|'[^']*')[^<>"']*)*>`, "gi"));
  return [...markupOnly(html).matchAll(re)].map((m) => m[0]);
}
function xmlText(raw) {
  const re = /<!\[CDATA\[|<!--/g;
  let out = "";
  let pos = 0;
  let m;
  while (m = re.exec(raw)) {
    const cdata = m[0] !== "<!--";
    const close = raw.indexOf(cdata ? "]]>" : "-->", m.index + m[0].length);
    if (close < 0) break;
    out += decodeEntities(raw.slice(pos, m.index)) + (cdata ? raw.slice(m.index + 9, close) : "");
    pos = re.lastIndex = close + 3;
  }
  return out + decodeEntities(raw.slice(pos));
}
function fragmentText2(html) {
  const stripped = dropElements(html, ["script", "style"], RAW_TEXT_ELEMENTS).replace(TAG_RE, (tag) => INLINE_TAGS.has(tagName(tag)) ? "" : " ").replace(LOOSE_TAG_RE, " ");
  return decodeEntities(stripped).replace(/\s+/g, " ").trim();
}
var collapse2 = (s) => s.replace(/\s+/g, " ").trim();
function tagText(block, ...names) {
  for (const name of names) {
    const el = elements(block, name, 1)[0];
    const text = el && collapse2(xmlText(el.inner));
    if (text) return text;
  }
  return void 0;
}
var HTML_ELEMENTS = /* @__PURE__ */ new Set([...BLOCK_TAGS, ...INLINE_TAGS, "br", "hr", "img", "h1", "h2", "h3", "h4", "h5", "h6"]);
function looksLikeHtml(text) {
  if (!/<\/[A-Za-z]\w*>/.test(text) && !/&#?\w+;/.test(text)) return false;
  for (const m of text.matchAll(/<\/?([A-Za-z]\w*)/g)) if (!HTML_ELEMENTS.has(m[1].toLowerCase())) return false;
  return true;
}
function proseText(block, atom, ...names) {
  for (const name of names) {
    const el = elements(block, name, 1)[0];
    if (!el) continue;
    const declared = htmlAttributes(el.attrs).get("type")?.toLowerCase();
    const decoded = declared === "xhtml" ? "" : xmlText(el.inner);
    const type = declared ?? (atom ? "text" : name === "title" && !looksLikeHtml(decoded) ? "text" : "html");
    const text = type === "xhtml" ? fragmentText2(el.inner) : type === "text" || type === "text/plain" ? collapse2(decoded) : fragmentText2(decoded);
    if (text) return text;
  }
  return void 0;
}
var SUMMARY_MAX = 500;
function clip2(s) {
  return s && s.length > SUMMARY_MAX ? `${s.slice(0, SUMMARY_MAX).trimEnd()}\u2026` : s;
}
function resolveUrl2(href, base2) {
  if (!base2) return href;
  try {
    return new URL(href, base2).href;
  } catch {
    return href;
  }
}
function rootElement(xml) {
  let i = xml.charCodeAt(0) === 65279 ? 1 : 0;
  for (; ; ) {
    while (i < xml.length && /\s/.test(xml[i])) i++;
    if (xml.startsWith("<?", i)) {
      const end = xml.indexOf("?>", i + 2);
      if (end < 0) return void 0;
      i = end + 2;
    } else if (xml.startsWith("<!--", i)) {
      const end = xml.indexOf("-->", i + 4);
      if (end < 0) return void 0;
      i = end + 3;
    } else if (xml.startsWith("<!", i)) {
      let end = xml.indexOf(">", i);
      const subset = xml.indexOf("[", i);
      if (subset >= 0 && subset < end) {
        const closed = xml.indexOf("]", subset);
        end = closed < 0 ? -1 : xml.indexOf(">", closed);
      }
      if (end < 0) return void 0;
      if (/^<!doctype\s+html\b/i.test(xml.slice(i, end))) return "html";
      i = end + 1;
    } else {
      return /^<([A-Za-z_][\w.:-]*)/.exec(xml.slice(i, i + 256))?.[1]?.toLowerCase();
    }
  }
}
var NOT_THE_PAGE = /* @__PURE__ */ new Set(["self", "edit", "replies", "enclosure", "via", "related", "license"]);
function itemUrl(block, base2) {
  const links = openTags(block, "link").map(htmlAttributes);
  const hrefOf = (attrs) => {
    const href2 = attrs.get("href");
    return href2 ? decodeEntities(href2).trim() : void 0;
  };
  const rels = (attrs) => attrs.get("rel")?.toLowerCase().split(/\s+/) ?? [];
  const pick = links.find((a) => hrefOf(a) && (rels(a).length === 0 || rels(a).includes("alternate"))) ?? links.find((a) => hrefOf(a) && !rels(a).some((r) => NOT_THE_PAGE.has(r))) ?? links.find((a) => hrefOf(a));
  const href = pick && hrefOf(pick);
  if (href) return resolveUrl2(href, base2);
  const text = tagText(block, "link");
  if (text) return resolveUrl2(text, base2);
  const guid = elements(block, "guid", 1)[0];
  if (!guid || htmlAttributes(guid.attrs).get("ispermalink")?.toLowerCase() === "false") return void 0;
  const value = collapse2(xmlText(guid.inner));
  return /^https?:\/\//i.test(value) ? value : void 0;
}
function xmlBase(attrs, above) {
  const declared = htmlAttributes(attrs).get("xml:base");
  return declared ? resolveUrl2(decodeEntities(declared).trim(), above) : above;
}
function parseFeed(xml, baseUrl) {
  if (withoutBom(xml).trimStart().startsWith("{")) return parseJsonFeed(xml, baseUrl);
  const root = rootElement(xml);
  if (!root) return void 0;
  const kind = root === "rss" || /(^|:)rdf$/.test(root) ? "rss" : /(^|:)feed$/.test(root) ? "atom" : void 0;
  if (!kind) return void 0;
  const atom = kind === "atom";
  const rootTag = atom ? openTags(xml, root)[0] : void 0;
  const feedBase = rootTag ? xmlBase(rootTag, baseUrl) : baseUrl;
  const blocks = elements(xml, atom ? "entry" : "item");
  const items = [];
  for (const block of blocks) {
    const inner = block.inner;
    const it = {};
    const title2 = proseText(inner, atom, "title");
    if (title2) it.title = title2;
    const url = itemUrl(inner, atom ? xmlBase(block.attrs, feedBase) : feedBase);
    if (url) it.url = url;
    const published = tagText(inner, "pubDate", "published", "updated", "dc:date");
    if (published) it.published = published;
    const summary = proseText(inner, atom, "description", "summary") ?? clip2(proseText(inner, atom, "content", "content:encoded"));
    if (summary) it.summary = summary;
    const id = tagText(inner, "guid", "id");
    if (id) it.id = id;
    if (it.title || it.url) items.push(it);
  }
  let head = "";
  let last = 0;
  for (const b of blocks) {
    head += xml.slice(last, b.from);
    last = b.to;
  }
  head += xml.slice(last);
  const title = proseText(head, atom, "title");
  return { kind, items, ...title ? { title } : {} };
}
function parseJsonFeed(text, baseUrl) {
  let doc;
  try {
    doc = JSON.parse(withoutBom(text));
  } catch {
    return void 0;
  }
  if (!doc || typeof doc !== "object" || Array.isArray(doc)) return void 0;
  const feed = doc;
  if (typeof feed.version !== "string" || !feed.version.startsWith("https://jsonfeed.org/version/")) return void 0;
  const str4 = (v) => typeof v === "string" && v.trim() ? v.trim() : void 0;
  const items = [];
  for (const raw of Array.isArray(feed.items) ? feed.items : []) {
    if (!raw || typeof raw !== "object") continue;
    const entry = raw;
    const it = {};
    const id = typeof entry.id === "number" ? String(entry.id) : str4(entry.id);
    if (id) it.id = id;
    const url = str4(entry.url) ?? str4(entry.external_url);
    if (url) it.url = resolveUrl2(url, baseUrl);
    const title2 = str4(entry.title);
    if (title2) it.title = title2;
    const published = str4(entry.date_published) ?? str4(entry.date_modified);
    if (published) it.published = published;
    const html = str4(entry.content_html);
    const summary = str4(entry.summary) ?? clip2(str4(entry.content_text) ?? (html ? fragmentText2(html) : void 0));
    if (summary) it.summary = summary;
    if (it.title || it.url) items.push(it);
  }
  const title = str4(feed.title);
  return { kind: "json", items, ...title ? { title } : {} };
}
var FEED_TYPES = /* @__PURE__ */ new Set(["application/rss+xml", "application/atom+xml", "application/feed+json"]);
function discoverFeeds(html, baseUrl) {
  const out = [];
  for (const tag of openTags(html, "link")) {
    const attrs = htmlAttributes(tag);
    const rels = attrs.get("rel")?.toLowerCase().split(/\s+/) ?? [];
    if (!rels.includes("alternate")) continue;
    const type = attrs.get("type")?.split(";")[0]?.trim().toLowerCase();
    if (!type || !FEED_TYPES.has(type)) continue;
    const href = attrs.get("href");
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
  const body = withoutBom(xml);
  if (!body.trimStart().startsWith("<")) {
    for (const line of body.split(/\r\n|\r|\n/)) {
      const loc = line.trim();
      if (/^https?:\/\/\S+$/i.test(loc)) out.urls.push({ loc });
    }
    return out;
  }
  const isIndex = /<sitemapindex(?=[\s/>])/i.test(body);
  for (const el of elements(body, "sitemap")) {
    const loc = tagText(el.inner, "loc");
    if (loc) out.sitemaps.push(loc);
  }
  if (isIndex) return out;
  for (const el of elements(body, "url")) {
    const loc = tagText(el.inner, "loc");
    if (!loc) continue;
    const lastmod = tagText(el.inner, "lastmod");
    out.urls.push({ loc, ...lastmod ? { lastmod } : {} });
  }
  return out;
}
var SITEMAP_MAX_BYTES = 50 * 1024 * 1024;
var gunzipAsync = promisify(gunzip);
async function readSitemapDocument(url, authorize, signal) {
  let refused = false;
  const authorizeUrl = authorize && (async (u) => {
    const ok = await authorize(u);
    if (!ok) refused = true;
    return ok;
  });
  const r = await httpGet(url, {
    accept: "application/xml,text/xml,text/plain,*/*",
    timeoutMs: 1e4,
    binary: true,
    maxBytes: SITEMAP_MAX_BYTES,
    authorizeUrl,
    signal
  });
  if (!r.ok) {
    if (r.error === "cancelled") return {};
    if (r.truncated) return { note: `${url} is larger than the 50 MB a sitemap may be; not read.` };
    if (refused || r.status === 404 || r.status === 410) return {};
    return { note: `could not read ${url} (${r.status ? `status ${r.status}` : r.error ?? "no answer"}).` };
  }
  let bytes = r.bytes ?? Buffer.alloc(0);
  const gzipped = bytes[0] === 31 && bytes[1] === 139;
  if (gzipped) {
    if (r.truncated) return { note: `${url} is larger than the 50 MB a sitemap may be; not read.` };
    try {
      bytes = await gunzipAsync(bytes, { maxOutputLength: SITEMAP_MAX_BYTES });
    } catch (e) {
      const tooBig = e.code === "ERR_BUFFER_TOO_LARGE" || e instanceof RangeError;
      return { note: tooBig ? `${url} decompresses past the 50 MB a sitemap may be; not read.` : `${url} is not valid gzip; not read.` };
    }
  }
  return {
    text: decodeBody(bytes, gzipped ? "application/xml" : r.contentType),
    ...r.truncated ? { note: `read only the first 50 MB of ${url}, the most a sitemap may be.` } : {}
  };
}
async function fetchSitemap(url, opts = {}) {
  const out = { urls: [], sitemaps: [] };
  let origin;
  try {
    origin = new URL(url).origin;
  } catch {
    return out;
  }
  const fallback = `${origin}/sitemap.xml`;
  const named = opts.sitemaps ?? [];
  const queue = named.length ? [...named] : [fallback];
  let guessed = !named.length;
  const seen = /* @__PURE__ */ new Set();
  const children = /* @__PURE__ */ new Set();
  const notes = [];
  let fetched = 0;
  const max = opts.max !== void 0 && Number.isFinite(opts.max) ? Math.max(1, Math.floor(opts.max)) : 3;
  for (; ; ) {
    if (!queue.length && !guessed && !out.urls.length && !out.sitemaps.length) {
      guessed = true;
      queue.push(fallback);
    }
    if (!queue.length || fetched >= max) break;
    if (opts.signal?.aborted) {
      notes.push(`cancelled after ${fetched} sitemap document(s).`);
      break;
    }
    const next = queue.shift();
    if (seen.has(next)) continue;
    seen.add(next);
    fetched++;
    const doc = await readSitemapDocument(next, opts.authorizeUrl, opts.signal);
    if (opts.signal?.aborted) {
      queue.unshift(next);
      seen.delete(next);
      notes.push(`cancelled after ${fetched - 1} sitemap document(s).`);
      break;
    }
    opts.onDocument?.(next, fetched);
    if (doc.note) notes.push(doc.note);
    if (!doc.text?.trim()) continue;
    const parsed = parseSitemap(doc.text);
    for (const u of parsed.urls) out.urls.push(u);
    for (const s of parsed.sitemaps) {
      if (children.has(s)) continue;
      children.add(s);
      out.sitemaps.push(s);
      queue.push(s);
    }
  }
  out.unfetched = [...new Set(queue.filter((s) => !seen.has(s) && s !== fallback))];
  if (notes.length) out.notes = notes;
  return out;
}
async function fetchFeed(url, opts = {}) {
  const r = await httpGet(url, {
    accept: "application/atom+xml,application/rss+xml,application/feed+json,application/xml,*/*",
    timeoutMs: 1e4,
    authorizeUrl: opts.authorizeUrl,
    signal: opts.signal
  });
  if (!r.ok || !r.body.trim()) return void 0;
  return parseFeed(r.body, r.url);
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
  return engineNames(raw).filter(isKeylessEngine);
}
function unknownEngines(opts = {}) {
  const raw = opts.engines ? void 0 : env("ENGINES");
  if (raw === void 0 || raw.toLowerCase() === "off") return [];
  return engineNames(raw).filter((s) => !isKeylessEngine(s));
}
function engineNames(raw) {
  return raw.split(",").map((s) => s.trim().toLowerCase()).filter(Boolean);
}
var INLINE_TAG = /<\/?(?:a|abbr|b|bdi|bdo|cite|code|em|i|kbd|mark|q|s|samp|small|span|strong|sub|sup|time|u|var|wbr)\b[^<>]*>/gi;
function stripTags(s) {
  return decodeEntities(s.replace(INLINE_TAG, "").replace(/<[^<>]*>/g, " ")).replace(/\s+/g, " ").trim();
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
function throttleReason(status, error) {
  if (status === 429 || status === 503) return { throttled: true, why: `rate-limited (HTTP ${status})` };
  if (status === 403) return { throttled: true, why: "blocked this client as automated traffic (HTTP 403)" };
  if (status === 0) return { throttled: false, why: `unreachable (${error || "no response"})` };
  return { throttled: false, why: `unreachable (status ${status})` };
}
function looksLikeChallenge(body) {
  if (body.length > 4e4) return false;
  const head = body.slice(0, 4e3).toLowerCase();
  return /<title>[^<]*captcha/.test(head) || head.includes("anomaly-modal") || head.includes("/anomaly.js") || head.includes("captcha-wrap") || head.includes("sending automated queries");
}
var attrPattern = (name) => new RegExp(`(?:^|\\s)${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s"'<>=\`]+))`, "i");
var HREF_ATTR = attrPattern("href");
var CLASS_ATTR = attrPattern("class");
var NAME_ATTR = attrPattern("name");
var TYPE_ATTR = attrPattern("type");
var VALUE_ATTR = attrPattern("value");
function attr2(attrs, re) {
  const m = re.exec(attrs);
  return m ? decodeEntities(m[1] ?? m[2] ?? m[3] ?? "") : void 0;
}
function hasClass(attrs, cls) {
  return (attr2(attrs, CLASS_ATTR) ?? "").split(/\s+/).includes(cls);
}
function hostIs(url, domain) {
  try {
    const host = new URL(url).hostname;
    return host === domain || host.endsWith(`.${domain}`);
  } catch {
    return false;
  }
}
var OPEN_A = /<a\b([^<>]*)>/gi;
var element = (tag, cls) => ({ open: new RegExp(`<${tag}\\b([^<>]*)>`, "gi"), close: new RegExp(`</${tag}\\s*>`, "i"), cls });
function parseBlocks(body, limit, shape) {
  const anchors = [];
  for (const m of body.matchAll(OPEN_A)) {
    if (hasClass(m[1], shape.anchor)) anchors.push({ start: m.index, end: m.index + m[0].length, attrs: m[1] });
  }
  const found = [];
  for (let i = 0; i < anchors.length && found.length < limit; i++) {
    const a = anchors[i];
    const block = body.slice(a.end, anchors[i + 1]?.start ?? body.length);
    const close = /<\/a\s*>/i.exec(block);
    const href = attr2(a.attrs, HREF_ATTR);
    if (!close || !href) continue;
    const url = shape.resolve(href);
    if (!url) continue;
    const rest = block.slice(close.index + close[0].length);
    found.push({ url, title: stripTags(block.slice(0, close.index)) || url, snippet: elementText(rest, shape.snippet) });
  }
  return found;
}
function elementText(html, el) {
  for (const m of html.matchAll(el.open)) {
    if (!hasClass(m[1], el.cls)) continue;
    const inner = html.slice(m.index + m[0].length);
    const end = el.close.exec(inner);
    return end ? stripTags(inner.slice(0, end.index)) : "";
  }
  return "";
}
function ddgDestination(href) {
  const url = ddgRedirectTarget(href);
  if (!/^https?:\/\//i.test(url)) return void 0;
  const unwrapped = url !== (href.startsWith("//") ? `https:${href}` : href);
  return unwrapped || !hostIs(url, "duckduckgo.com") ? url : void 0;
}
function parseDdgHtml(body, limit = 50) {
  return parseBlocks(body, limit, { anchor: "result__a", snippet: element("a", "result__snippet"), resolve: ddgDestination });
}
function parseDdgLite(body, limit = 50) {
  return parseBlocks(body, limit, { anchor: "result-link", snippet: element("td", "result-snippet"), resolve: ddgDestination });
}
function parseMojeek(body, limit = 50) {
  return parseBlocks(body, limit, {
    anchor: "title",
    snippet: element("p", "s"),
    // Mojeek links its results directly, so its own links are the ones on its
    // own host. Its blog, or a page ABOUT Mojeek, is a result like any other.
    resolve: (h) => {
      const url = h.startsWith("//") ? `https:${h}` : h;
      return /^https?:\/\//i.test(url) && !/^https?:\/\/(?:www\.)?mojeek\.com(?:[:/?#]|$)/i.test(url) ? url : void 0;
    }
  });
}
var OPEN_FORM = /<form\b[^<>]*>/gi;
var INPUT = /<input\b([^<>]*)>/gi;
function ddgNextForm(body) {
  const forms = [...body.matchAll(OPEN_FORM)];
  for (let i = 0; i < forms.length; i++) {
    const chunk = body.slice(forms[i].index + forms[i][0].length, forms[i + 1]?.index ?? body.length);
    const end = chunk.search(/<\/form\s*>/i);
    const fields = {};
    let next = false;
    for (const m of (end < 0 ? chunk : chunk.slice(0, end)).matchAll(INPUT)) {
      const value = attr2(m[1], VALUE_ATTR) ?? "";
      if (attr2(m[1], TYPE_ATTR)?.toLowerCase() === "submit") next ||= /^\s*next\b/i.test(value);
      else {
        const name = attr2(m[1], NAME_ATTR);
        if (name) fields[name] = value;
      }
    }
    if (next) return fields;
  }
  return void 0;
}
function ddgNext(endpoint) {
  return (body, q, kl, p) => {
    const form = ddgNextForm(body);
    if (!form) return null;
    return `${endpoint}?${new URLSearchParams({ ...form, q, kl, s: form.s || String((p + 1) * 10) })}`;
  };
}
function mojeekLocaleParams(locale) {
  if (!locale) return "";
  const lang = `&lb=${encodeURIComponent(locale.lang)}&lbb=100`;
  return locale.region === "WT" ? lang : `${lang}&rb=${encodeURIComponent(locale.region)}&rbb=10`;
}
var SPECS = {
  // Page one only: every later page is the one the previous page's own Next
  // form names (see ddgNextForm).
  ddg: {
    label: "DuckDuckGo",
    url: (q, _p, kl) => `https://html.duckduckgo.com/html/?q=${encodeURIComponent(q)}&kl=${encodeURIComponent(kl)}`,
    parse: parseDdgHtml,
    next: ddgNext("https://html.duckduckgo.com/html/")
  },
  ddglite: {
    label: "DuckDuckGo Lite",
    url: (q, _p, kl) => `https://lite.duckduckgo.com/lite/?q=${encodeURIComponent(q)}&kl=${encodeURIComponent(kl)}`,
    parse: parseDdgLite,
    next: ddgNext("https://lite.duckduckgo.com/lite/")
  },
  // Mojeek's `s` is the 1-BASED index of the first result, 10 per page — so
  // page 2 starts at 11, not 10. Its own crawler and index, which is why it is
  // worth asking at all: it surfaces pages the DDG family does not have.
  mojeek: {
    label: "Mojeek",
    url: (q, p, _kl, locale) => `https://www.mojeek.com/search?q=${encodeURIComponent(q)}${p > 0 ? `&s=${p * 10 + 1}` : ""}${mojeekLocaleParams(locale)}`,
    parse: parseMojeek
  }
};
function spentSlackMs(budgetMs) {
  return budgetMs === void 0 ? 0 : Math.min(25, budgetMs / 4);
}
async function searchViaKeyless(engine, query, opts = {}) {
  const spec = SPECS[engine];
  const q = query.trim();
  if (!q) return { hits: [], note: "Empty query." };
  const pages = Math.max(1, opts.pages ?? 1);
  const limit = Math.max(1, opts.limit ?? 10);
  const localised = !!(opts.lang || opts.region);
  const kl = localised ? ddgRegion(opts.lang, opts.region) : "wt-wt";
  const acceptLanguage = acceptLanguageHeader(opts.lang, opts.region);
  const locale = localised ? { lang: baseLang3(opts.lang), region: resolveRegion(opts.lang, opts.region).toUpperCase() } : void 0;
  const seen = /* @__PURE__ */ new Set();
  const hits = [];
  const deadline = opts.budgetMs === void 0 ? Number.POSITIVE_INFINITY : Date.now() + opts.budgetMs;
  let url = spec.url(q, 0, kl, locale);
  for (let p = 0; p < pages && hits.length < limit; p++) {
    if (opts.signal?.aborted || Date.now() >= deadline - spentSlackMs(opts.budgetMs)) {
      if (p > 0) break;
      return { hits: [], note: `${spec.label} was not asked: ${opts.signal?.aborted ? "the search was cancelled" : "no time was left"}.`, stopped: true };
    }
    const r = await httpGet(url, {
      accept: "text/html",
      acceptLanguage,
      timeoutMs: Math.max(1, Math.min(opts.timeoutMs ?? 12e3, deadline - Date.now())),
      retries: 0,
      signal: opts.signal
    });
    if (!r.ok || !r.body.trim()) {
      if (p > 0) break;
      if (!r.status && r.error === "cancelled") return { hits: [], note: `${spec.label} did not get to answer: the search was cancelled.`, stopped: true };
      if (r.ok) return { hits: [], note: `${spec.label} returned an empty page (HTTP ${r.status}).`, status: r.status };
      const { throttled, why } = throttleReason(r.status, r.error);
      return { hits: [], note: `${spec.label} ${why}.`, throttled, ...r.status === 403 ? { blocked: true } : {}, status: r.status };
    }
    const before = hits.length;
    const parsed = spec.parse(r.body, limit * 2);
    if (parsed.length === 0 && looksLikeChallenge(r.body)) {
      if (p > 0) break;
      return {
        hits: [],
        note: `${spec.label} served an anti-bot challenge (HTTP ${r.status}) instead of results \u2014 blocked, not empty.`,
        throttled: true,
        blocked: true,
        status: r.status
      };
    }
    for (const f of parsed) {
      const key = canonicalizeUrl(f.url);
      if (seen.has(key)) continue;
      seen.add(key);
      hits.push(f);
      if (hits.length >= limit) break;
    }
    if (hits.length === before || p + 1 >= pages || hits.length >= limit) break;
    const next = spec.next ? spec.next(r.body, q, kl, p) : spec.url(q, p + 1, kl, locale);
    if (!next) break;
    url = next;
    const pause = pageDelayMs();
    if (opts.signal?.aborted || Date.now() + pause >= deadline - spentSlackMs(opts.budgetMs)) break;
    if (pause) await sleep(pause, opts.signal);
  }
  return hits.length ? { hits, answered: true } : { hits: [], note: `${spec.label} returned no results.`, answered: true };
}

// src/search.ts
var SEARXNG_DEFAULT_BASE = "http://localhost:8888";
var PROBE_TIMEOUT_MS3 = 2e3;
var QUERY_TIMEOUT_MS = 8e3;
function searxngBase(opts = {}) {
  const raw = (opts.searxng ?? env("SEARXNG") ?? SEARXNG_DEFAULT_BASE).trim();
  if (!raw || raw.toLowerCase() === "off") return null;
  return raw.replace(/\/+$/, "");
}
function searxngIsExplicit(opts = {}) {
  return !!(opts.searxng ?? env("SEARXNG"));
}
var probeCache2 = new ProbeMemo();
function resetSearxngProbeCache() {
  probeCache2.clear();
}
function probeSearxng(base2, explicit = false) {
  return probeCache2.get(`${base2}|${explicit}`, async () => {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), PROBE_TIMEOUT_MS3);
    try {
      const res = await fetch(`${base2}/healthz`, { signal: ctrl.signal });
      const body = await res.text().catch(() => "");
      return explicit || res.ok && /^\s*ok\s*$/i.test(body);
    } catch {
      return false;
    } finally {
      clearTimeout(t);
    }
  });
}
async function searchViaSearxng(query, opts = {}) {
  const base2 = searxngBase(opts);
  if (!base2) return rungResult("searxng", "disabled", [], [`SearXNG disabled (--searxng off / ${envName("SEARXNG")}=off).`]);
  const deadline = budgetDeadline(opts);
  if (!await probeSearxng(base2, searxngIsExplicit(opts))) {
    return rungResult(
      "searxng",
      "unreachable",
      [],
      [
        searxngIsExplicit(opts) ? `SearXNG not reachable at ${base2}.` : `SearXNG not running at ${base2} \u2014 start it with \`${brand().cli} searxng up\` for local, keyless discovery.`
      ]
    );
  }
  const pages = Math.max(1, opts.pages ?? 1);
  const limit = Math.max(1, opts.limit ?? 10);
  const acceptLanguage = acceptLanguageHeader(opts.lang, opts.region);
  const language = searxngLanguage(opts.lang, opts.region);
  const root = `${base2}/search?q=${encodeURIComponent(query)}&format=json&safesearch=1` + (language ? `&language=${encodeURIComponent(language)}` : "");
  const notes = [];
  const seen = /* @__PURE__ */ new Set();
  const hits = [];
  const suspended = /* @__PURE__ */ new Map();
  let failed2;
  for (let p = 0; p < pages && hits.length < limit; p++) {
    const stop = halted(opts, deadline);
    if (stop) {
      if (p > 0) break;
      return rungResult("searxng", "not-tried", [], [`SearXNG was not asked: ${stop === "cancelled" ? "the search was cancelled" : "no time was left"}.`]);
    }
    const r = await httpGet(root + (p > 0 ? `&pageno=${p + 1}` : ""), {
      accept: "application/json",
      acceptLanguage,
      timeoutMs: Math.max(1, Math.min(QUERY_TIMEOUT_MS, deadline - Date.now())),
      // No retry: the cascade's next rung is the retry.
      retries: 0,
      signal: opts.signal
    });
    if (!r.ok) {
      if (p === 0 && !r.status && r.error === "cancelled") {
        return rungResult("searxng", "not-tried", [], ["SearXNG did not get to answer: the search was cancelled."]);
      }
      if (p === 0) {
        failed2 = r.status === 429 || r.status === 503 ? "throttled" : r.status === 0 ? "unreachable" : "error";
        notes.push(
          failed2 === "throttled" ? `SearXNG rate-limited (HTTP ${r.status}).` : failed2 === "unreachable" ? `SearXNG unreachable (${r.error || "no response"}).` : (
            // SearXNG answers a format it does not serve with flask.abort(403),
            // and the probe has just shown the instance is up: this is the
            // most common misconfiguration, not an outage.
            r.status === 403 ? "SearXNG refused format=json (HTTP 403) \u2014 add `json` to `search.formats` in its settings.yml." : `SearXNG failed the query (HTTP ${r.status}).`
          )
        );
      }
      break;
    }
    let data;
    try {
      data = JSON.parse(r.body);
    } catch {
      if (p === 0) {
        failed2 = "error";
        notes.push("SearXNG returned a non-JSON body \u2014 is `format: json` enabled on that instance?");
      }
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
    if (p < pages - 1) {
      const pause = pageDelayMs();
      if (opts.signal?.aborted || Date.now() + pause >= deadline - spentSlackMs2(opts.timeoutMs)) break;
      if (pause) await sleep(pause, opts.signal);
    }
  }
  if (suspended.size) {
    notes.push(`SearXNG upstreams throttled: ${[...suspended].map(([e, why]) => `${e} (${why})`).join(", ")} \u2014 fewer results than usual, not an empty web.`);
  }
  if (!hits.length && !notes.length) notes.push("SearXNG returned no results.");
  const outcome = hits.length ? "hits" : failed2 ?? (suspended.size ? "throttled" : "empty");
  return rungResult("searxng", outcome, hits, notes);
}
function budgetDeadline(opts) {
  return opts.timeoutMs !== void 0 && opts.timeoutMs > 0 ? Date.now() + opts.timeoutMs : Number.POSITIVE_INFINITY;
}
function spentSlackMs2(budgetMs) {
  return budgetMs === void 0 ? 0 : Math.min(25, budgetMs / 4);
}
function halted(opts, deadline) {
  if (opts.signal?.aborted) return "cancelled";
  return Date.now() >= deadline - spentSlackMs2(opts.timeoutMs) ? "out of time" : void 0;
}
function rungResult(rung, outcome, hits, notes) {
  return { hits, notes, rungs: [report(rung, outcome, hits.length, notes.join(" "))], searched: answered(outcome) };
}
function report(rung, outcome, hits = 0, note) {
  return { rung, outcome, ...hits ? { hits } : {}, ...note ? { note } : {} };
}
var answered = (outcome) => outcome === "hits" || outcome === "empty";
function keylessOutcome(r) {
  if (r.hits.length) return "hits";
  if (r.stopped) return "not-tried";
  if (r.answered) return "empty";
  if (r.blocked) return "blocked";
  if (r.throttled) return "throttled";
  return r.status ? "error" : "unreachable";
}
async function search(query, opts = {}) {
  const q = query.trim();
  if (!q) return { hits: [], notes: ["Empty query."] };
  const deadline = budgetDeadline(opts);
  const left = () => deadline === Number.POSITIVE_INFINITY ? void 0 : Math.max(1, deadline - Date.now());
  const keyless = keylessEngines(opts);
  const order = ["searxng", ...keyless, "firecrawl"];
  const untried = (rung) => report(rung, rung === "searxng" && !searxngBase(opts) || rung === "firecrawl" && !firecrawlBase(opts) ? "disabled" : "not-tried");
  const notes = [];
  const unknown = unknownEngines(opts);
  if (unknown.length) {
    notes.push(`${envName("ENGINES")} names no engine this knows: ${unknown.join(", ")} (expected ${KEYLESS_ENGINES.join(", ")}) \u2014 ignored.`);
  }
  const rungs = [];
  let hits = [];
  for (let i = 0; i < order.length; i++) {
    const rung = order[i];
    if (hits.length) {
      rungs.push(untried(rung));
      continue;
    }
    const stop = halted(opts, deadline);
    if (stop) {
      const rest = order.slice(i).map(untried);
      const skipped = rest.filter((r) => r.outcome === "not-tried").map((r) => r.rung);
      const why = stop === "cancelled" ? "the search was cancelled" : `the ${opts.timeoutMs} ms budget ran out`;
      if (skipped.length) notes.push(`Stopped before ${skipped.join(", ")}: ${why}.`);
      rungs.push(...rest);
      break;
    }
    if (rung === "searxng") {
      const r = await searchViaSearxng(q, { ...opts, timeoutMs: left() });
      hits = r.hits;
      notes.push(...r.notes);
      rungs.push(...r.rungs ?? []);
    } else if (rung === "firecrawl") {
      const fc = await searchViaFirecrawl(q, limitOf(opts), { firecrawl: opts.firecrawl, lang: opts.lang, region: opts.region, budgetMs: left() });
      hits = firecrawlHits(fc.hits ?? [], limitOf(opts));
      if (fc.why) notes.push(fc.why);
      rungs.push(report("firecrawl", firecrawlOutcome(fc), hits.length, fc.why));
    } else {
      const r = await searchViaKeyless(rung, q, {
        limit: opts.limit,
        pages: opts.pages,
        lang: opts.lang,
        region: opts.region,
        budgetMs: left(),
        signal: opts.signal
      });
      hits = r.hits.map((h) => ({ ...h, via: rung }));
      rungs.push(report(rung, keylessOutcome(r), r.hits.length, r.note));
      if (!r.answered && r.note) notes.push(r.note);
    }
  }
  if (!hits.length) notes.push(closingNote(rungs, opts.signal?.aborted === true));
  return { hits, notes, rungs, searched: rungs.some((r) => answered(r.outcome)) };
}
var limitOf = (opts) => Math.max(1, opts.limit ?? 10);
function firecrawlHits(found, limit) {
  const seen = /* @__PURE__ */ new Set();
  const hits = [];
  for (const h of found) {
    const key = canonicalizeUrl(h.url);
    if (seen.has(key)) continue;
    seen.add(key);
    hits.push({ url: h.url, title: h.title, snippet: h.description, via: "firecrawl" });
    if (hits.length >= limit) break;
  }
  return hits;
}
function firecrawlOutcome(fc) {
  if (fc.hits) return fc.hits.length ? "hits" : "empty";
  if (fc.status === void 0) return "disabled";
  if (fc.status === 0) return "unreachable";
  return fc.status === 429 || fc.status === 503 ? "throttled" : "error";
}
function closingNote(rungs, cancelled) {
  const cli = brand().cli;
  if (rungs.every((r) => r.outcome === "disabled")) {
    return `No search backend was enabled \u2014 SearXNG and Firecrawl are off and no keyless engine is selected, so nothing was searched. Set ${envName("ENGINES")} to a list of ${KEYLESS_ENGINES.join(", ")}, or run \`${cli} stack up\`.`;
  }
  if (rungs.some((r) => answered(r.outcome))) return `No results from any engine. \`${cli} stack up\` starts SearXNG and Firecrawl locally.`;
  if (cancelled) return "The search was cancelled before any engine answered \u2014 nothing was searched.";
  const keyless = rungs.filter((r) => isKeylessEngine(r.rung));
  if (keyless.length && keyless.every((r) => r.outcome === "blocked")) {
    return `Every keyless engine blocked this client (${keyless.map((r) => r.rung).join(", ")}) \u2014 nothing was searched, which is not the same as nothing being there. Try again later, or run \`${cli} stack up\` for a local SearXNG.`;
  }
  return `No engine answered (${rungs.filter((r) => r.outcome !== "disabled").map((r) => `${r.rung} ${r.outcome}`).join(", ")}) \u2014 nothing was searched, which is not the same as nothing being there. Try again later, or run \`${cli} stack up\` for a local SearXNG.`;
}

// src/stack.ts
import { spawnSync as spawnSync3 } from "child_process";
import { existsSync as existsSync7, lstatSync as lstatSync2, mkdirSync as mkdirSync5, readFileSync as readFileSync8, statSync as statSync4, writeFileSync as writeFileSync5 } from "fs";
import { dirname as dirname2, join as join9, resolve as resolve4 } from "path";

// src/cache.ts
import { chmodSync, existsSync as existsSync6, lstatSync, mkdirSync as mkdirSync4, readFileSync as readFileSync7, readdirSync as readdirSync6, rmSync as rmSync5, statSync as statSync3 } from "fs";
import { dirname, join as join8 } from "path";
import { tmpdir as tmpdir5 } from "os";
var DEFAULT_TTL_MS = 24 * 60 * 60 * 1e3;
function cacheDir() {
  return namedCacheDir() ?? join8(tmpdir5(), userScoped(brand().name), "cache");
}
var namedCacheDir = () => env("CACHE_DIR") ?? brand().cacheDir;
function userScoped(name) {
  const uid = typeof process.getuid === "function" ? process.getuid() : void 0;
  return uid === void 0 ? name : `${name}-${uid}`;
}
function cachePath(url, acceptLanguage = "", extractor = "native", variant = "") {
  const canon = canonicalizeUrl(url);
  const domain = domainOf(url).replace(/[^a-z0-9.-]/gi, "_") || "url";
  const key = `${canon}\0${acceptLanguage}\0${extractor}${variant ? `\0${variant}` : ""}`;
  return join8(cacheDir(), `${domain}-${fnv1a64(key).toString(16)}.json`);
}
var TEXT_VARIANTS = ["", "consent", "full"];
var MARKDOWN_VARIANTS = ["md", "consent-md", "full-md"];
var PLAIN = [""];
function variantOf(opts) {
  const read2 = opts.fullPage ? "full" : opts.stripConsent ? "consent" : "";
  if (opts.format !== "markdown") return read2;
  return read2 ? `${read2}-md` : "md";
}
var sameFormat = (variant) => MARKDOWN_VARIANTS.includes(variant) ? MARKDOWN_VARIANTS : TEXT_VARIANTS;
var PDF_CACHE_NS = "pdf";
var DOC_CACHE_NS = "doc";
var VIDEO_CACHE_NS = "video";
async function currentExtractor(opts, url) {
  if (looksLikePdfUrl(url)) return PDF_CACHE_NS;
  if (knownVideo(url)) return VIDEO_CACHE_NS;
  if (docFormatForUrl(url)) return DOC_CACHE_NS;
  if (opts.fullPage) return "native";
  const base2 = firecrawlBase(opts);
  return base2 && await probeFirecrawl(base2, firecrawlIsExplicit(opts)) ? "firecrawl" : "native";
}
var DOCUMENT_NAMESPACES = [PDF_CACHE_NS, DOC_CACHE_NS, VIDEO_CACHE_NS, "pdf-inspector", "pdftotext", "anydoc", "ocr"];
var WRITTEN_NAMESPACES = ["native", "firecrawl", ...DOCUMENT_NAMESPACES];
function namespaceFor(result, predicted) {
  if (predicted === VIDEO_CACHE_NS && result.documentType !== "video") return result.extractor ?? "native";
  return result.documentType ?? (predicted === PDF_CACHE_NS || predicted === DOC_CACHE_NS || predicted === VIDEO_CACHE_NS ? predicted : result.extractor ?? "native");
}
function readAnyNamespace(url, acceptLanguage, namespaces = WRITTEN_NAMESPACES, variants = PLAIN) {
  let best;
  for (const ns of namespaces) {
    for (const variant of ns === "native" ? variants : PLAIN) {
      const hit = readCache(url, acceptLanguage, ns, variant);
      if (hit && (!best || hit.cachedAt > best.cachedAt)) best = hit;
    }
  }
  return best;
}
function readAnyCopy(url, acceptLanguage, variant) {
  return readAnyNamespace(url, acceptLanguage, WRITTEN_NAMESPACES, [variant]) ?? readAnyNamespace(url, acceptLanguage, WRITTEN_NAMESPACES, sameFormat(variant));
}
function ttlMs() {
  const fallback = brand().cacheTtlMs ?? DEFAULT_TTL_MS;
  const hours = env("CACHE_TTL_HOURS");
  if (hours !== void 0) {
    const h = Number(hours);
    return Number.isFinite(h) ? Math.round(Math.max(0, h) * 36e5) : fallback;
  }
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
function entryPaths(url, acceptLanguage, extractor, variant) {
  const meta = cachePath(url, acceptLanguage, extractor, extractor === "native" ? variant : "");
  return { meta, body: meta.replace(/\.json$/, ".body") };
}
function readCache(url, acceptLanguage = "", extractor = "native", variant = "") {
  if (!entryDir(false)) return void 0;
  const { meta, body } = entryPaths(url, acceptLanguage, extractor, variant);
  if (!existsSync6(meta)) return void 0;
  try {
    const entry = JSON.parse(readFileSync7(meta, "utf8"));
    if (typeof entry.cachedAt !== "number") return void 0;
    const text = existsSync6(body) ? readFileSync7(body, "utf8") : entry.text;
    if (!text?.trim()) return void 0;
    return { ...entry, text };
  } catch {
    return void 0;
  }
}
function writeCache(url, res, now, acceptLanguage = "", extractor = "native", variant = "") {
  if (isNoWrite()) return;
  const { meta, body } = entryPaths(url, acceptLanguage, extractor, variant);
  const { text, note: _note, ...rest } = res;
  const write = () => {
    if (!entryDir(true)) return;
    writeFileAtomic(body, text ?? "");
    writeFileAtomic(meta, JSON.stringify({ ...rest, cachedAt: now }));
  };
  try {
    write();
  } catch {
    ensured.delete(cacheDir());
    try {
      write();
    } catch {
    }
  }
}
var ensured = /* @__PURE__ */ new Set();
function ensureDir2(dir) {
  if (ensured.has(dir)) return;
  mkdirSync4(dir, { recursive: true });
  ensured.add(dir);
}
function openCacheDir(create) {
  const dir = cacheDir();
  const uid = typeof process.getuid === "function" ? process.getuid() : void 0;
  if (namedCacheDir() !== void 0 || uid === void 0) {
    if (create) ensureDir2(dir);
    return { dir };
  }
  if (create) mkdirSync4(dirname(dirname(dir)), { recursive: true });
  for (const p of [dirname(dir), dir]) {
    if (create) mkdirPrivate(p);
    let st;
    try {
      st = lstatSync(p);
    } catch (e) {
      if (e.code === "ENOENT") return {};
      return { refused: `${p} cannot be inspected (${e.message})` };
    }
    if (st.isSymbolicLink()) return { refused: `${p} is a symbolic link` };
    if (!st.isDirectory()) return { refused: `${p} is not a directory` };
    if (st.uid !== uid) return { refused: `${p} belongs to another user` };
    if (st.mode & 18) return { refused: `${p} is writable by other users` };
    if (st.mode & 63 && !isNoWrite()) {
      try {
        chmodSync(p, 448);
      } catch {
      }
    }
  }
  return { dir };
}
function mkdirPrivate(p) {
  try {
    mkdirSync4(p, { mode: 448 });
  } catch (e) {
    if (e.code !== "EEXIST") throw e;
  }
}
var announced = /* @__PURE__ */ new Set();
function entryDir(create) {
  const { dir, refused } = openCacheDir(create);
  if (refused && !announced.has(refused)) {
    announced.add(refused);
    process.emitWarning(`the fetch cache is not used: ${refused}. Remove it, or set ${envName("CACHE_DIR")} to a directory only you can write.`);
  }
  return dir;
}
function touchCache(url, entry, now, acceptLanguage = "", extractor = "native", variant = "") {
  writeCache(url, entry, now, acceptLanguage, extractor, variant);
}
async function cachedFetchAndExtract(url, opts = {}, enabled = false, now = Date.now()) {
  const { refresh, offline } = mode;
  if (!enabled && !offline) return fetchAndExtract(url, opts);
  const lang = opts.acceptLanguage ?? "";
  const variant = variantOf(opts);
  const served = (entry, note) => {
    countFetch(Buffer.byteLength(entry.text), true);
    const { note: _stored, ...rest } = entry;
    const about = note ?? (entry.truncated ? `The cached text of ${url} is a prefix: the page overran the response size cap.` : void 0);
    return { ...rest, cached: true, ...about ? { note: about } : {} };
  };
  if (offline) {
    const stored = readAnyCopy(url, lang, variant);
    if (stored) return served(stored);
    const { refused } = openCacheDir(false);
    if (refused) return { text: "", finalUrl: url, status: 0, note: `Offline: the cache is not used \u2014 ${refused}.` };
    return { text: "", finalUrl: url, status: 0, note: `Offline: ${url} is not in the cache (drop --offline, or warm it with a normal run).` };
  }
  const ns = await currentExtractor(opts, url);
  const store = (result) => {
    const target = namespaceFor(result, ns);
    const entry = ns === "firecrawl" && target === "native" ? { ...result, fallbackFrom: "firecrawl" } : result;
    writeCache(url, entry, now, lang, target, variant);
  };
  const hit = refresh ? void 0 : lookup(url, lang, ns, variant);
  if (hit && isCacheFresh(hit, now)) return served(hit);
  let res;
  const revalidate = hit ? revalidationHeaders(hit) : {};
  if (hit && Object.keys(revalidate).length) {
    const probe = await fetchAndExtract(url, { ...opts, headers: revalidate });
    if (probe.status === 304) {
      const renewed = { ...hit, etag: probe.etag ?? hit.etag, lastModified: probe.lastModified ?? hit.lastModified };
      touchCache(url, renewed, now, lang, namespaceFor(hit, ns), variant);
      return served(renewed);
    }
    if (probe.text?.trim()) {
      store(probe);
      return probe;
    }
    if (probe.status !== 412 && !(probe.status >= 200 && probe.status < 300)) res = probe;
  }
  res ??= await fetchAndExtract(url, opts);
  if (res.text?.trim()) {
    store(res);
    return res;
  }
  const stale = hit ?? readAnyCopy(url, lang, variant);
  if (stale) return served(stale, `${url} returned ${res.status || "no response"}; served the cached copy from ${new Date(stale.cachedAt).toISOString()}.`);
  return res;
}
function lookup(url, acceptLanguage, ns, variant) {
  const best = readAnyNamespace(url, acceptLanguage, [.../* @__PURE__ */ new Set([ns, ...DOCUMENT_NAMESPACES])], [variant]);
  if (ns === VIDEO_CACHE_NS && !best) return readCache(url, acceptLanguage, "native", variant);
  if (ns !== "firecrawl") return best;
  const fallback = readCache(url, acceptLanguage, "native", variant);
  return fallback?.fallbackFrom === "firecrawl" && (!best || fallback.cachedAt > best.cachedAt) ? fallback : best;
}
var WRITER_TMP = /\.\d+\.\d+\.tmp$/;
function ownFile(name) {
  const tmp = WRITER_TMP.exec(name);
  const base2 = tmp ? name.slice(0, tmp.index) : name;
  const ext = base2.endsWith(".json") ? "json" : base2.endsWith(".body") ? "body" : void 0;
  if (!ext) return void 0;
  const stem = base2.slice(0, -5);
  const dash = stem.lastIndexOf("-");
  if (dash < 1 || !/^[0-9a-f]{1,16}$/.test(stem.slice(dash + 1)) || !/^[\w.-]+$/.test(stem.slice(0, dash))) return void 0;
  return { kind: tmp ? "tmp" : ext, stem };
}
function readEntryMeta(abs) {
  try {
    const entry = JSON.parse(readFileSync7(abs, "utf8"));
    return entry && typeof entry.cachedAt === "number" && typeof entry.finalUrl === "string" ? entry : void 0;
  } catch {
    return void 0;
  }
}
var ORPHAN_GRACE_MS = 10 * 60 * 1e3;
function sizeOf(abs) {
  try {
    return statSync3(abs).size;
  } catch {
    return 0;
  }
}
function cacheStats(now = Date.now()) {
  const dir = cacheDir();
  const out = { dir, entries: 0, bytes: 0, fresh: 0, stale: 0, ttlMs: ttlMs() };
  const { refused } = openCacheDir(false);
  if (refused) return { ...out, refused };
  if (!existsSync6(dir)) return out;
  let oldest = Number.POSITIVE_INFINITY;
  let newest = 0;
  for (const name of readdirSync6(dir)) {
    const own = ownFile(name);
    if (!own) continue;
    const abs = join8(dir, name);
    if (own.kind !== "json") {
      out.bytes += sizeOf(abs);
      continue;
    }
    const entry = readEntryMeta(abs);
    if (!entry) continue;
    out.bytes += sizeOf(abs);
    out.entries++;
    if (isCacheFresh(entry, now)) out.fresh++;
    else out.stale++;
    if (entry.cachedAt < oldest) oldest = entry.cachedAt;
    if (entry.cachedAt > newest) newest = entry.cachedAt;
  }
  if (out.entries) {
    out.oldest = new Date(oldest).toISOString();
    out.newest = new Date(newest).toISOString();
  }
  return out;
}
function cacheClean(all = false, now = Date.now()) {
  const dir = cacheDir();
  if (isNoWrite() || !openCacheDir(false).dir || !existsSync6(dir)) return 0;
  const names = readdirSync6(dir);
  const present = new Set(names);
  const remove = (name) => {
    try {
      rmSync5(join8(dir, name), { force: true });
      return true;
    } catch {
      return false;
    }
  };
  const abandoned = (name) => {
    try {
      return all || now - statSync3(join8(dir, name)).mtimeMs > ORPHAN_GRACE_MS;
    } catch {
      return false;
    }
  };
  let removed = 0;
  for (const name of names) {
    const own = ownFile(name);
    if (!own) continue;
    if (own.kind === "json") {
      const entry = readEntryMeta(join8(dir, name));
      if (!entry || !all && isCacheFresh(entry, now) || !remove(name)) continue;
      remove(`${own.stem}.body`);
      removed++;
    } else if (own.kind === "body" ? !present.has(`${own.stem}.json`) && abandoned(name) : abandoned(name)) {
      remove(name);
    }
  }
  return removed;
}

// src/stack.ts
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
function composeAssets() {
  const base2 = join9(cacheDir(), "compose");
  return [
    { path: join9(base2, "docker-compose.yml"), content: renderAsset(COMPOSE_YAML) },
    { path: join9(base2, "docker", "searxng", "settings.yml"), content: renderAsset(SEARXNG_SETTINGS_YAML) },
    { path: join9(base2, "docker", "firecrawl", "firecrawl.env"), content: renderAsset(FIRECRAWL_ENV) }
  ];
}
function ensureComposeMaterialized() {
  const assets = composeAssets();
  for (const a of assets) writeIfChanged(a.path, a.content);
  return assets[0].path;
}
function untrustedStack() {
  const assets = composeAssets();
  for (const a of assets) {
    let body;
    try {
      body = readFileSync8(a.path, "utf8");
    } catch {
    }
    if (body !== a.content) return `${a.path} does not hold the stack this binary ships, and could not be rewritten`;
  }
  const uid = typeof process.getuid === "function" ? process.getuid() : void 0;
  if (uid === void 0) return void 0;
  const root = resolve4(cacheDir());
  const chosen = !!(env("CACHE_DIR") ?? brand().cacheDir);
  const top = chosen ? root : dirname2(root);
  const paths = /* @__PURE__ */ new Set();
  for (const a of assets) {
    for (let p = resolve4(a.path); p !== top && p !== dirname2(p); p = dirname2(p)) paths.add(p);
  }
  for (const p of [top, ...paths]) {
    try {
      const st = p === top && chosen ? statSync4(p) : lstatSync2(p);
      if (st.isSymbolicLink()) return `${p} is a symbolic link`;
      if (st.uid !== uid) return `${p} belongs to another user`;
      if (st.mode & 2 && !(st.isDirectory() && st.mode & 512)) return `${p} is writable by anyone`;
    } catch (e) {
      return `${p} cannot be inspected (${e.message})`;
    }
  }
  return void 0;
}
function writeIfChanged(path, content) {
  try {
    if (existsSync7(path) && readFileSync8(path, "utf8") === content) return;
    mkdirSync5(dirname2(path), { recursive: true, mode: 448 });
    writeFileSync5(path, content);
  } catch {
  }
}
var DEFAULT_PULL_TIMEOUT_MS = 12e5;
var UP_TIMEOUT_MS = 3e5;
var DOWN_TIMEOUT_MS = 12e4;
var PS_TIMEOUT_MS = 3e4;
var MODEL_PULL_TIMEOUT_MS = 6e5;
var DAEMON_PROBE_TIMEOUT_MS = 15e3;
function pullTimeoutMs() {
  return envInt("DOCKER_PULL_TIMEOUT_MS", DEFAULT_PULL_TIMEOUT_MS);
}
function embedModel() {
  return env("EMBED_MODEL") ?? "nomic-embed-text";
}
function defaultRun(cmd, args, opts) {
  const res = spawnSync3(cmd, args, {
    encoding: "utf8",
    timeout: opts.timeoutMs,
    maxBuffer: 64 * 1024 * 1024,
    stdio: opts.capture ? "pipe" : "inherit"
  });
  const code = res.error?.code;
  return {
    ok: !res.error && res.status === 0,
    stdout: res.stdout ?? "",
    stderr: res.stderr ?? (res.error ? String(res.error.message) : ""),
    missing: code === "ENOENT",
    ...code === "ETIMEDOUT" ? { timedOut: true } : {}
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
  const distrust = untrustedStack();
  if (distrust) {
    return {
      message: `${tag}: refusing to run docker against the stack in ${dirname2(file)} \u2014 ${distrust}. Set ${envName("CACHE_DIR")} to a directory only you can write.`,
      code: 1
    };
  }
  const daemon = run("docker", ["info", "--format", "{{.ServerVersion}}"], { timeoutMs: DAEMON_PROBE_TIMEOUT_MS, capture: true });
  if (!daemon.ok) {
    const why = daemon.stderr.trim().split("\n")[0];
    return {
      message: `${tag}: docker is installed but its daemon is not answering \u2014 start Docker (Docker Desktop, colima, or \`systemctl start docker\`) and retry.${why ? `
${why}` : ""}`,
      code: 1
    };
  }
  const profiles = spec.profiles.flatMap((p) => ["--profile", p]);
  if (action === "down") {
    const r = run("docker", ["compose", "-f", file, ...profiles, "down"], { timeoutMs: DOWN_TIMEOUT_MS, capture: true });
    return { message: r.ok ? `${tag}: stopped.` : `${tag}: down failed.
${r.stderr}`, code: r.ok ? 0 : 1 };
  }
  if (action === "status") {
    const r = run("docker", ["compose", "-f", file, ...profiles, "ps"], { timeoutMs: PS_TIMEOUT_MS, capture: true });
    return { message: r.ok ? r.stdout.trim() || `${tag}: no services running.` : `${tag}: status failed.
${r.stderr}`, code: r.ok ? 0 : 1 };
  }
  const pulled = run("docker", ["compose", "-f", file, ...profiles, "pull"], { timeoutMs: pullTimeoutMs() });
  if (!pulled.ok) {
    const why = pulled.timedOut ? ` after ${pullTimeoutMs()}ms (the images are large \u2014 raise ${envName("DOCKER_PULL_TIMEOUT_MS")})` : " \u2014 docker's output above says why";
    return { message: `${tag}: pulling the images failed${why}.${pulled.stderr ? `
${pulled.stderr}` : ""}`, code: 1 };
  }
  const up = run("docker", ["compose", "-f", file, ...profiles, "up", "-d", "--wait"], { timeoutMs: UP_TIMEOUT_MS });
  if (!up.ok) {
    const why = up.timedOut ? ` \u2014 the services were not healthy within ${UP_TIMEOUT_MS / 1e3}s` : "";
    return { message: `${tag}: up failed${why}.${up.stderr ? `
${up.stderr}` : ""}`, code: 1 };
  }
  return { message: [`${tag}: ${spec.summary}`, ...spec.postUp?.(file, run) ?? []].join("\n"), code: 0 };
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

// src/run.ts
import { join as join10 } from "path";
import { readFileSync as readFileSync9 } from "fs";
function pad(n) {
  return String(n).padStart(2, "0");
}
function runId(d = /* @__PURE__ */ new Date()) {
  return `run-${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
}
function shq(s) {
  return `'${s.replace(/\r\n?|\n/g, " ").replaceAll("'", `'"'"'`)}'`;
}
function readJsonSafe(path) {
  try {
    return JSON.parse(readFileSync9(path, "utf8"));
  } catch {
    return void 0;
  }
}
function readManifest(dir, file = "manifest.json") {
  return readJsonSafe(join10(dir, file));
}
function writeManifest(dir, value, file = "manifest.json") {
  return writeArtifact(join10(dir, file), `${JSON.stringify(value, null, 2)}
`);
}

// src/changed.ts
import { createHash as createHash2 } from "crypto";
function contentHash(body) {
  return createHash2("sha256").update(body).digest("hex");
}
var FINGERPRINT_MAX_BYTES = 64 * 1024 * 1024;
function read(url, opts, headers) {
  return httpGet(url, { timeoutMs: opts.timeoutMs, maxBytes: opts.maxBytes ?? FINGERPRINT_MAX_BYTES, binary: true, ...headers ? { headers } : {} });
}
function observation(url, res) {
  const complete = res.ok && !res.truncated;
  const error = res.status === 304 || complete ? void 0 : !res.ok ? res.error ?? `status ${res.status}` : "response truncated at the byte cap";
  return {
    url,
    ...res.etag ? { etag: res.etag } : {},
    ...res.lastModified ? { lastModified: res.lastModified } : {},
    ...complete ? { contentHash: contentHash(res.bytes ?? Buffer.alloc(0)) } : {},
    bytes: res.bytesRead ?? 0,
    status: res.status,
    fetchedAt: (/* @__PURE__ */ new Date()).toISOString(),
    ...error ? { error } : {}
  };
}
async function fingerprint(url, opts = {}) {
  return observation(url, await read(url, opts));
}
async function hasChanged(url, previous, opts = {}) {
  const headers = {};
  if (previous?.etag) headers["if-none-match"] = previous.etag;
  if (previous?.lastModified) headers["if-modified-since"] = previous.lastModified;
  const res = await read(url, opts, Object.keys(headers).length ? headers : void 0);
  const observed = observation(url, res);
  if (res.status === 304) {
    const etag = observed.etag ?? previous?.etag;
    const lastModified = observed.lastModified ?? previous?.lastModified;
    const fingerprint2 = {
      ...observed,
      ...etag ? { etag } : {},
      ...lastModified ? { lastModified } : {},
      ...previous?.contentHash ? { contentHash: previous.contentHash } : {},
      status: 304,
      bytes: 0
    };
    return { changed: false, via: "not-modified", fingerprint: fingerprint2 };
  }
  if (!res.ok) {
    return { via: "unknown", fingerprint: observed, note: `could not read ${url}: ${res.error ?? `status ${res.status}`}` };
  }
  if (res.truncated) {
    return { via: "unknown", fingerprint: observed, note: `could not compare ${url}: response truncated at the byte cap.` };
  }
  if (!previous || !previous.etag && !previous.lastModified && !previous.contentHash) {
    return { changed: false, via: "unknown", fingerprint: observed, note: "no previous observation \u2014 this is the baseline." };
  }
  if (previous.contentHash && observed.contentHash) {
    return { changed: previous.contentHash !== observed.contentHash, via: "hash", fingerprint: observed };
  }
  if (previous.etag && observed.etag) return { changed: previous.etag !== observed.etag, via: "etag", fingerprint: observed };
  if (previous.lastModified && observed.lastModified) {
    return { changed: previous.lastModified !== observed.lastModified, via: "last-modified", fingerprint: observed };
  }
  return { via: "unknown", fingerprint: observed, note: "nothing comparable between the two observations \u2014 store contentHash to make this answerable." };
}

// src/crawl.ts
var nextFree = /* @__PURE__ */ new Map();
var holdUntil = /* @__PURE__ */ new Map();
function resetHostSchedule() {
  nextFree.clear();
  holdUntil.clear();
}
var MAX_TIMER_MS = 2 ** 31 - 1;
async function sleepFor(ms, signal) {
  for (let left = ms; left > 0 && !signal?.aborted; left -= MAX_TIMER_MS) await sleep(Math.min(left, MAX_TIMER_MS), signal);
}
function hostDelayMs() {
  return envInt("POLITE_DELAY_MS", 400, 0, 5e3);
}
function maxCrawlDelayMs() {
  return envInt("MAX_CRAWL_DELAY_MS", 6e4, 0, MAX_TIMER_MS);
}
function hostOf(url) {
  try {
    return new URL(url).host.toLowerCase();
  } catch {
    return "";
  }
}
async function awaitHostSlot(url, delayMs = hostDelayMs(), now = Date.now(), signal) {
  const host = hostOf(url);
  if (!host) return 0;
  const spaced = delayMs > 0;
  let waited = 0;
  let t = now;
  for (; ; ) {
    const hold = holdUntil.get(host) ?? 0;
    const free = spaced ? Math.max(nextFree.get(host) ?? 0, hold) : hold;
    const wait = Math.max(0, free - t);
    if (spaced) nextFree.set(host, Math.max(free, t) + delayMs);
    if (wait === 0 || signal?.aborted) return waited;
    const started = Date.now();
    await sleepFor(wait, signal);
    if (signal?.aborted) return waited + Math.min(wait, Math.max(0, Date.now() - started));
    waited += wait;
    t = Date.now();
    if ((holdUntil.get(host) ?? 0) <= t) return waited;
  }
}
function backOffHost(url, ms, now = Date.now()) {
  const host = hostOf(url);
  if (!host || !(ms > 0)) return;
  holdUntil.set(host, Math.max(holdUntil.get(host) ?? 0, now + ms));
}
var LINK_TAG_RE = /<(a|area)(?=[\s/>])[^<>"']*(?:(?:"[^"]*"|'[^']*')[^<>"']*)*>/gi;
var INERT_ELEMENTS = ["script", "style", "template"];
function linksFrom(html, baseUrl) {
  const base2 = documentBaseUrl(html, baseUrl) ?? baseUrl;
  const hrefs = [];
  for (const m of dropElements(html, INERT_ELEMENTS, RAW_TEXT_ELEMENTS).matchAll(LINK_TAG_RE)) {
    const href = htmlAttributes(m[0]).get("href");
    if (href !== void 0) hrefs.push(decodeEntities(href).trim());
  }
  const out = [];
  const seen = /* @__PURE__ */ new Set();
  for (const raw of hrefs) {
    if (!raw || raw.startsWith("#")) continue;
    if (/^(mailto|tel|javascript|data):/i.test(raw)) continue;
    try {
      const abs = new URL(raw, base2);
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
function sameSite(url, origin) {
  try {
    const a = new URL(url);
    const b = new URL(origin);
    const bare = (host) => host.replace(/^www\./, "");
    const scheme = a.protocol === b.protocol || b.protocol === "http:" && a.protocol === "https:";
    return scheme && a.port === b.port && bare(a.hostname) === bare(b.hostname);
  } catch {
    return false;
  }
}
function originOf(url) {
  try {
    return new URL(url).origin;
  } catch {
    return void 0;
  }
}
function pathOf(url) {
  try {
    return new URL(url).pathname;
  } catch {
    return "";
  }
}
function sectionOf(url) {
  const path = pathOf(url) || "/";
  const cut = path.lastIndexOf("/");
  const last = path.slice(cut + 1);
  return last && !last.includes(".") ? `${path}/` : path.slice(0, cut + 1);
}
var NOT_A_PAGE_RE = /\.(?:png|jpe?g|gif|webp|avif|bmp|ico|svg|tiff?|heic|mp3|m4a|aac|ogg|oga|opus|wav|flac|mp4|m4v|mov|avi|wmv|mkv|webm|woff2?|ttf|otf|eot|zip|gz|tgz|bz2|xz|7z|rar|tar|dmg|iso|exe|msi|apk|deb|rpm)$/i;
function crawlConcurrency() {
  return envInt("CRAWL_CONCURRENCY", 4, 1, 16);
}
function whole(n, fallback, min) {
  return typeof n === "number" && !Number.isNaN(n) ? Math.max(min, Math.floor(n)) : fallback;
}
var seconds2 = (ms) => `${ms / 1e3} s`;
async function crawlSite(seed, opts = {}) {
  const maxPages = whole(opts.maxPages, 20, 1);
  const maxDepth = whole(opts.maxDepth, 2, 0);
  const maxRequests = whole(opts.maxRequests, maxPages * 3, 1);
  const delayOverride = opts.delayMs !== void 0 && Number.isFinite(opts.delayMs) ? Math.max(0, opts.delayMs) : void 0;
  const prefix = opts.prefix ? pathOf(`http://x${opts.prefix.startsWith("/") ? "" : "/"}${opts.prefix}`) || void 0 : void 0;
  const width = crawlConcurrency();
  const notes = [];
  const disallowed = [];
  const refused = /* @__PURE__ */ new Set();
  const disallow = (url) => {
    if (refused.has(url)) return;
    refused.add(url);
    disallowed.push(url);
  };
  const pages = [];
  const seedOrigin = originOf(seed);
  if (!seedOrigin) return { pages, pending: [], disallowed, notes: [`${seed} is not a URL.`] };
  let origin = seedOrigin;
  let section = sectionOf(seed);
  const inScope = (url) => opts.crossOrigin === true || sameOrigin(url, origin);
  const permitted = async (url) => {
    if (!opts.authorizeUrl || await opts.authorizeUrl(url)) return true;
    notes.push(`${url}: refused by the caller's policy.`);
    return false;
  };
  const NONE = { rules: [], sitemaps: [], absent: true };
  const robotsPolicy = /* @__PURE__ */ new Map();
  const robotsFor = (url) => {
    if (opts.ignoreRobots) return Promise.resolve(NONE);
    const home = originOf(url) ?? "";
    let authorize = robotsPolicy.get(home);
    if (!authorize) {
      authorize = async (target) => {
        if (!await permitted(target)) return false;
        if (sameSite(target, home) || inScope(target)) return true;
        notes.push(`${target}: destination is outside the crawl origin.`);
        return false;
      };
      robotsPolicy.set(home, authorize);
    }
    return fetchRobots(url, { authorizeUrl: authorize });
  };
  const ceiling = maxCrawlDelayMs();
  const tooSlow = /* @__PURE__ */ new Set();
  const refusesDelay = (url, r) => {
    if (delayOverride !== void 0 || r.crawlDelayMs === void 0 || r.crawlDelayMs <= ceiling) return false;
    const home = originOf(url) ?? url;
    if (!tooSlow.has(home)) {
      tooSlow.add(home);
      notes.push(
        `${home} asks for a Crawl-delay of ${seconds2(r.crawlDelayMs)} between requests \u2014 over the ${seconds2(ceiling)} this crawl will wait (${envName("MAX_CRAWL_DELAY_MS")}), so none of its pages were fetched.`
      );
    }
    return true;
  };
  const delayFor = (r) => delayOverride ?? r.crawlDelayMs ?? hostDelayMs();
  const unreachable2 = (home, r) => `robots.txt at ${home} ${r.status ? `answered HTTP ${r.status}` : "did not answer"} \u2014 RFC 9309 says to assume nothing may be crawled, so nothing was.`;
  const robots = await robotsFor(seed);
  if (!opts.ignoreRobots && robots.unreachable) return { pages, pending: [seed], disallowed, notes: [...notes, unreachable2(seedOrigin, robots)] };
  if (refusesDelay(seed, robots)) return { pages, pending: [seed], disallowed, notes };
  const authorizeHop = async (url, seedHop) => {
    if (opts.signal?.aborted) return false;
    if (!await permitted(url)) return false;
    if (!seedHop && !inScope(url)) {
      notes.push(`${url}: destination is outside the crawl origin.`);
      return false;
    }
    const r = await robotsFor(url);
    if (!opts.ignoreRobots && !isAllowed(r, url)) {
      disallow(url);
      return false;
    }
    if (refusesDelay(url, r)) return false;
    await awaitHostSlot(url, delayFor(r), Date.now(), opts.signal);
    return !opts.signal?.aborted;
  };
  const authorizeUrl = (url) => authorizeHop(url, false);
  const authorizeSeed = (url) => authorizeHop(url, true);
  let settleSeed;
  const seedSettled = new Promise((resolve7) => {
    settleSeed = resolve7;
  });
  const authorizeSitemap = async (url) => {
    if (!sameOrigin(url, seedOrigin)) await seedSettled;
    return authorizeUrl(url);
  };
  let rerooted = false;
  const settle = (got) => {
    if (got.status > 0) {
      if (section !== "/") section = sectionOf(got.finalUrl);
      const moved = originOf(got.finalUrl);
      if (moved && moved !== origin) {
        origin = moved;
        rerooted = true;
        notes.push(`the seed redirected to ${got.finalUrl}${opts.crossOrigin ? "" : `, so the walk stays on ${moved}`}.`);
      }
    }
    settleSeed();
  };
  const seen = /* @__PURE__ */ new Set([canonicalizeUrl(seed)]);
  const read2 = /* @__PURE__ */ new Set();
  let skippedFiles = 0;
  const admit = (url, depth, into) => {
    const canon = canonicalizeUrl(url);
    if (seen.has(canon)) return false;
    if (!inScope(url)) return false;
    const path = pathOf(url);
    if (prefix && !path.startsWith(prefix)) return false;
    seen.add(canon);
    if (NOT_A_PAGE_RE.test(path)) {
      skippedFiles++;
      return false;
    }
    into.push({ url, depth });
    return true;
  };
  const wantSitemap = opts.useSitemap !== false && maxDepth > 0 && maxPages > 1;
  let sitemap = wantSitemap ? fetchSitemap(seed, { sitemaps: robots.sitemaps, authorizeUrl: authorizeSitemap, signal: opts.signal }) : void 0;
  let sitemapAgain = false;
  let requests = 0;
  let failed2 = 0;
  const takeSitemap = async (into) => {
    const sm = await sitemap;
    sitemap = void 0;
    for (const n of sm.notes ?? []) notes.push(n);
    const scope = prefix ?? (section === "/" ? void 0 : section);
    const room = maxRequests - requests;
    let added = 0;
    let outside = 0;
    let beyond = 0;
    for (const entry of sm.urls) {
      if (scope && !pathOf(entry.loc).startsWith(scope)) outside++;
      else if (added >= room) beyond++;
      else if (admit(entry.loc, 1, into)) added++;
    }
    if (added || outside || beyond) {
      notes.push(
        `seeded ${added} URL(s) from the sitemap` + (beyond ? `; ${beyond} more are past this crawl's request ceiling` : "") + (outside ? `; ${outside} outside ${scope} were left out` : "") + "."
      );
    }
    if (!added && rerooted && !sitemapAgain) {
      sitemapAgain = true;
      const home = origin;
      sitemap = robotsFor(home).then((r) => fetchSitemap(home, { sitemaps: r.sitemaps, authorizeUrl, signal: opts.signal }));
    }
  };
  const seedItem = { url: seed, depth: 0 };
  const fetchOne = async (item) => {
    const isSeed = item === seedItem;
    const got = await fetchAndExtract(item.url, {
      keepHtml: item.depth < maxDepth,
      authorizeUrl: isSeed ? authorizeSeed : authorizeUrl,
      // A short Retry-After is waited out and retried inside httpGet; the rest
      // of this host's queue must wait with it, not go out meanwhile.
      onBackOff: (url, ms) => backOffHost(url, ms),
      signal: opts.signal
    });
    if (got.retryAfterMs) backOffHost(got.finalUrl, Math.min(got.retryAfterMs, 6e4));
    if (isSeed) settle(got);
    if (!got.text && opts.signal?.aborted) return { cancelled: true };
    if (!got.text) return { note: `${item.url}: ${got.note ?? "nothing readable"}` };
    return {
      page: {
        url: got.finalUrl,
        depth: item.depth,
        ...got.title ? { title: got.title } : {},
        text: got.text,
        extractor: got.extractor ?? "native",
        links: got.html ? linksFrom(got.html, got.finalUrl) : []
      }
    };
  };
  let wave = [seedItem];
  for (; ; ) {
    if (!wave.length && sitemap) await takeSitemap(wave);
    if (!wave.length || pages.length >= maxPages || requests >= maxRequests) break;
    if (opts.signal?.aborted) {
      notes.push(`cancelled after ${requests} page request(s).`);
      break;
    }
    const room = Math.min(maxPages - pages.length, maxRequests - requests);
    const batch = [];
    let cursor = 0;
    while (cursor < wave.length && batch.length < room) {
      const slice = wave.slice(cursor, cursor + (room - batch.length));
      const files = await Promise.all(slice.map((it) => robotsFor(it.url)));
      slice.forEach((item, i) => {
        if (!opts.ignoreRobots && !isAllowed(files[i], item.url)) disallow(item.url);
        else batch.push(item);
      });
      cursor += slice.length;
    }
    requests += batch.length;
    const leftover = wave.slice(cursor);
    const settled = new Array(batch.length);
    let streamed = 0;
    const streamReady = () => {
      while (streamed < settled.length && settled[streamed] !== void 0) {
        const i = streamed++;
        const done = settled[i];
        if (!("page" in done)) continue;
        const canon = canonicalizeUrl(done.page.url);
        if (read2.has(canon)) {
          settled[i] = { note: `${batch[i].url} redirected to ${done.page.url}, already read.`, duplicate: true };
          continue;
        }
        read2.add(canon);
        seen.add(canon);
        opts.onPage?.(done.page);
      }
    };
    await mapLimit(batch, width, async (item, i) => {
      settled[i] = await fetchOne(item);
      streamReady();
    });
    settleSeed();
    const parents = [];
    const unread = [];
    for (const [i, r] of settled.entries()) {
      if ("cancelled" in r) {
        unread.push(batch[i]);
        requests--;
        continue;
      }
      if ("note" in r) {
        notes.push(r.note);
        if (!r.duplicate) failed2++;
        continue;
      }
      pages.push(r.page);
      if (r.page.depth < maxDepth) parents.push(r.page);
    }
    const next = [];
    const rootSeed = section === "/";
    if (sitemap && rootSeed) await takeSitemap(next);
    for (const page of parents) for (const link of page.links) admit(link, page.depth + 1, next);
    if (sitemap && !rootSeed) await takeSitemap(next);
    wave = [...unread, ...leftover, ...next];
  }
  const pending = wave.map((q) => q.url);
  const queued = pending.length ? ` with ${pending.length} URL(s) still queued` : "";
  const budgetStopped = !opts.signal?.aborted;
  if (budgetStopped && pages.length < maxPages && requests >= maxRequests)
    notes.push(`stopped after ${requests} page requests, ${failed2} of them failed \u2014 the ceiling for a ${maxPages}-page budget${queued}.`);
  else if (budgetStopped && pending.length) notes.push(`stopped at the ${maxPages}-page budget${queued}.`);
  if (skippedFiles) notes.push(`skipped ${skippedFiles} link(s) to images, media, fonts or archives without fetching them.`);
  const policy = [];
  if (opts.ignoreRobots) policy.push("robots.txt was not consulted (ignoreRobots) \u2014 only correct on a site you own.");
  else if (envFlag("NO_ROBOTS")) policy.push(`robots.txt was not consulted (${envName("NO_ROBOTS")}) \u2014 only correct on a site you own.`);
  else {
    const home = await robotsFor(origin);
    if (home.unreachable) policy.push(unreachable2(origin, home));
    else if (home.absent) policy.push(`no robots.txt${home.status ? ` (HTTP ${home.status})` : ""} \u2014 nothing was refused, but nothing was granted either.`);
    if (home.crawlDelayMs && delayOverride === void 0 && home.crawlDelayMs <= ceiling)
      policy.push(`honouring the declared Crawl-delay of ${home.crawlDelayMs}ms.`);
  }
  return { pages, pending, disallowed, notes: [...policy, ...notes] };
}

// src/probe.ts
var PROBE_RETRY_MS = 3e4;
function cachedProbe(cache2, key, ask) {
  const hit = cache2.get(key);
  if (hit && (hit.ok !== false || Date.now() - hit.at < PROBE_RETRY_MS)) return hit.verdict;
  const entry = { verdict: Promise.resolve(false), at: Date.now() };
  entry.verdict = ask().catch(() => false).then((ok) => {
    entry.ok = ok;
    entry.at = Date.now();
    return ok;
  });
  cache2.set(key, entry);
  return entry.verdict;
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
var probed = /* @__PURE__ */ new Map();
function resetOllamaProbe() {
  probed.clear();
}
async function probeOllama(base2 = ollamaBase()) {
  const key = base2.replace(/\/+$/, "");
  if (key.toLowerCase() === "off") return false;
  return cachedProbe(probed, key, async () => (await httpJson("GET", `${key}/api/tags`, void 0, { timeoutMs: 2e3, retries: 0 })).ok);
}
async function embed(texts, opts = {}) {
  const model = opts.model ?? embedModel();
  if (texts.length === 0) return { vectors: [], model };
  const base2 = (opts.base ?? ollamaBase()).replace(/\/+$/, "");
  if (base2.toLowerCase() === "off") return { vectors: [], model, note: "embeddings are disabled (OLLAMA=off)." };
  if (!await probeOllama(base2)) {
    return { vectors: [], model, note: `no embedding server at ${base2} \u2014 \`${brand().cli} semantic up\` starts Ollama and pulls ${model}.` };
  }
  const batches = [];
  const width = embedBatch();
  for (let i = 0; i < texts.length; i += width) batches.push(texts.slice(i, i + width));
  let note;
  let failed2 = false;
  const results = await mapLimit(batches, opts.concurrency ?? embedConcurrency(), async (batch) => {
    if (failed2) return void 0;
    const r = await httpJson("POST", `${base2}/api/embed`, { model, input: batch }, { timeoutMs: 6e4 });
    const got = r.ok ? r.data?.embeddings : void 0;
    if (!got || got.length !== batch.length) {
      failed2 = true;
      note ??= embedFailure(base2, model, r);
      return void 0;
    }
    return got;
  });
  if (results.some((r) => r === void 0)) return { vectors: [], model, ...note ? { note } : {} };
  return { vectors: results.flat(), model };
}
function embedFailure(base2, model, r) {
  const said = typeof r.data?.error === "string" ? r.data.error : void 0;
  const why = r.error ?? (said ? `status ${r.status}: ${said}` : r.ok ? "the response held no vectors for this batch" : `status ${r.status}`);
  const missing = r.status === 404 || /not found/i.test(said ?? "");
  const hint = missing ? ` \u2014 \`ollama pull ${model}\`, or \`${brand().cli} semantic up\`, pulls it.` : ".";
  return `embedding failed at ${base2} (${why})${hint}`;
}
var PREFIXES = [
  { model: /nomic-embed/i, query: "search_query: ", doc: "search_document: " },
  { model: /mxbai-embed/i, query: "Represent this sentence for searching relevant passages: ", doc: "" },
  { model: /snowflake-arctic-embed2/i, query: "query: ", doc: "" },
  { model: /snowflake-arctic-embed/i, query: "Represent this sentence for searching relevant passages: ", doc: "" },
  { model: /(?:^|[/:_-])(?:multilingual-)?e5(?:[-_:]|$)/i, query: "query: ", doc: "passage: " }
];
function embedPrefixes(model = embedModel()) {
  const known = PREFIXES.find((p) => p.model.test(model)) ?? { query: "", doc: "" };
  const fromEnv = (name) => {
    const v = env(name);
    if (v === void 0) return void 0;
    return v.toLowerCase() === "none" ? "" : `${v} `;
  };
  return { query: fromEnv("EMBED_QUERY_PREFIX") ?? known.query, doc: fromEnv("EMBED_DOC_PREFIX") ?? known.doc };
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
var clean2 = (base2) => base2.replace(/\/+$/, "");
var probed2 = /* @__PURE__ */ new Map();
function resetQdrantProbe() {
  probed2.clear();
}
async function probeQdrant(base2 = qdrantBase()) {
  const key = clean2(base2);
  if (key.toLowerCase() === "off") return false;
  return cachedProbe(probed2, key, async () => (await httpJson("GET", `${key}/collections`, void 0, { timeoutMs: 2e3, retries: 0 })).ok);
}
async function ensureCollection(name, size, opts = {}) {
  const base2 = clean2(opts.base ?? qdrantBase());
  if (base2.toLowerCase() === "off") return { ok: false, note: "the vector store is disabled (QDRANT=off)." };
  if (!await probeQdrant(base2)) return { ok: false, note: unreachable(base2) };
  const distance = opts.distance ?? "Cosine";
  const existing = await httpJson("GET", `${base2}/collections/${encodeURIComponent(name)}`, void 0, { retries: 0 });
  if (existing.ok) {
    const have2 = existing.data?.result?.config?.params?.vectors;
    if (typeof have2?.size === "number" && have2.size !== size) {
      return {
        ok: false,
        note: `collection "${name}" exists with size ${have2.size}, not ${size} \u2014 was it built with another embedding model? deleteCollection and re-index.`
      };
    }
    if (typeof have2?.distance === "string" && have2.distance !== distance) {
      return { ok: false, note: `collection "${name}" exists with distance ${have2.distance}, not ${distance} \u2014 deleteCollection and re-index.` };
    }
    return { ok: true };
  }
  const r = await httpJson("PUT", `${base2}/collections/${encodeURIComponent(name)}`, { vectors: { size, distance } });
  return r.ok ? { ok: true } : { ok: false, note: `could not create collection "${name}" at ${base2}: ${r.error ?? `status ${r.status}`}` };
}
async function upsert(name, points, opts = {}) {
  if (points.length === 0) return { ok: true };
  const base2 = clean2(opts.base ?? qdrantBase());
  if (base2.toLowerCase() === "off") return { ok: false, note: "the vector store is disabled (QDRANT=off)." };
  if (!await probeQdrant(base2)) return { ok: false, note: unreachable(base2) };
  const width = Math.max(1, envInt("QDRANT_UPSERT_BATCH", 256));
  for (let i = 0; i < points.length; i += width) {
    const chunk = points.slice(i, i + width);
    const r = await httpJson("PUT", `${base2}/collections/${encodeURIComponent(name)}/points?wait=true`, { points: chunk }, { timeoutMs: 6e4 });
    if (!r.ok) {
      const which = points.length > width ? ` at points ${i + 1}\u2013${i + chunk.length} of ${points.length}` : "";
      return { ok: false, note: `upsert into "${name}" failed${which}: ${r.error ?? `status ${r.status}`}` };
    }
  }
  return { ok: true };
}
async function searchVectors(name, vector, opts = {}) {
  const base2 = clean2(opts.base ?? qdrantBase());
  if (base2.toLowerCase() === "off") return { hits: [], note: "the vector store is disabled (QDRANT=off)." };
  if (!await probeQdrant(base2)) return { hits: [], note: unreachable(base2) };
  const body = { vector: [...vector], limit: opts.limit ?? 10, with_payload: true, ...opts.filter ? { filter: opts.filter } : {} };
  const r = await httpJson("POST", `${base2}/collections/${encodeURIComponent(name)}/points/search`, body);
  if (!r.ok) return { hits: [], note: `search in "${name}" failed: ${r.error ?? `status ${r.status}`}` };
  const raw = r.data?.result ?? [];
  return { hits: raw.map((h) => ({ id: h.id, score: h.score, ...h.payload ? { payload: h.payload } : {} })) };
}
async function deleteCollection(name, opts = {}) {
  const base2 = clean2(opts.base ?? qdrantBase());
  if (base2.toLowerCase() === "off") return { ok: false, note: "the vector store is disabled (QDRANT=off)." };
  const r = await httpJson("DELETE", `${base2}/collections/${encodeURIComponent(name)}`, void 0, { retries: 0 });
  return r.ok ? { ok: true } : { ok: false, note: `could not delete "${name}": ${r.error ?? `status ${r.status}`}` };
}
function unreachable(base2) {
  return `no vector store at ${base2} \u2014 \`${brand().cli} semantic up\` starts Qdrant.`;
}
async function hybridSearch(question, docs, opts = {}) {
  if (docs.length === 0) return { hits: [] };
  const prefixes = embedPrefixes(opts.model);
  const queryPrefix = opts.queryPrefix ?? prefixes.query;
  const docPrefix = opts.docPrefix ?? prefixes.doc;
  const maxChars = opts.maxChars ?? envInt("EMBED_MAX_CHARS", 8e3);
  const embedding = embed([queryPrefix + question, ...docs.map((d) => docPrefix + clip3([d.title, d.headings, d.body].filter(Boolean).join("\n"), maxChars))], {
    ...opts.base !== void 0 ? { base: opts.base } : {},
    ...opts.model !== void 0 ? { model: opts.model } : {}
  });
  const index = buildBm25Index(question, docs);
  const lexical = docs.map((doc, i) => ({ i, score: bm25Score(index, doc) })).sort((a, b) => b.score - a.score).map((s) => s.i);
  const embedded = await embedding;
  let dense = [];
  let note = embedded.note;
  if (embedded.vectors.length === docs.length + 1) {
    const q = embedded.vectors[0];
    const scored = docs.map((_, i) => ({ i, sim: cosine(q, embedded.vectors[i + 1]) }));
    dense = scored.sort((a, b) => b.sim - a.sim).map((s) => s.i);
  } else if (!note) {
    note = "the dense lane returned an unexpected number of vectors \u2014 ranking lexically only.";
  }
  const lists = dense.length ? [lexical, dense] : [lexical];
  const fused = rrf(lists, (i) => String(i), opts.k ?? envInt("RRF_K", 60));
  const lexRank = new Map(lexical.map((i, r) => [i, r + 1]));
  const denseRank = new Map(dense.map((i, r) => [i, r + 1]));
  const hits = docs.map((doc, i) => ({
    doc,
    score: fused.get(String(i)) ?? 0,
    ...lexRank.has(i) ? { lexicalRank: lexRank.get(i) } : {},
    ...denseRank.has(i) ? { denseRank: denseRank.get(i) } : {}
  })).sort((a, b) => b.score - a.score);
  return { hits: opts.limit !== void 0 && opts.limit > 0 ? hits.slice(0, opts.limit) : hits, ...note ? { note } : {} };
}
function clip3(text, max) {
  if (max <= 0 || text.length <= max) return text;
  const code = text.charCodeAt(max - 1);
  return text.slice(0, code >= 55296 && code <= 56319 ? max - 1 : max);
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
  let open;
  for (let i = 0; i < lines.length; i++) {
    const m = /^\s*(`{3,}|~{3,})(.*)$/.exec(lines[i]);
    if (!open) {
      if (m && !(m[1][0] === "`" && m[2].includes("`"))) {
        open = { ch: m[1][0], len: m[1].length };
        mask[i] = true;
      }
      continue;
    }
    mask[i] = true;
    if (m && m[1][0] === open.ch && m[1].length >= open.len && m[2].trim() === "") open = void 0;
  }
  return mask;
}
function statelessRegExp(re) {
  return re.global || re.sticky ? new RegExp(re.source, re.flags.replace(/[gy]/g, "")) : re;
}
function markedQuoteMask(lines, marker) {
  const mask = new Array(lines.length).fill(false);
  const re = statelessRegExp(marker);
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
      if (re.test(lines[j])) marked = true;
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
var APPENDIX_TITLE = /^(?:sources?|references?(?: bibliographiques)?|bibliograph(?:y|ie)|works cited|citations|quellen(?:angaben)?|literatur(?:verzeichnis)?|fuentes|referencias|fontes|fonti|bibliografia|bronnen)$/;
function headingAt(lines, i) {
  const line = lines[i];
  const atx = /^\s{0,3}(#{1,6})(?:\s+(.*))?$/.exec(line);
  if (atx) {
    const text = (atx[2] ?? "").trimEnd().replace(/(?:^|\s)#+$/, "").trimEnd().replace(/\{#[^{}\s]*\}$/, "").trim();
    return { level: atx[1].length, text };
  }
  const under = i + 1 < lines.length ? /^\s{0,3}(=+|-+)\s*$/.exec(lines[i + 1]) : null;
  if (under && line.trim() && !/^\s*(?:[-*+>|]|\d+\.|```|~~~)/.test(line) && !/^\s{4}/.test(line)) {
    return { level: under[1][0] === "=" ? 1 : 2, text: line.trim() };
  }
  return void 0;
}
function appendixMask(lines, opts = {}) {
  const mask = new Array(lines.length).fill(false);
  const extra = opts.headings ? statelessRegExp(opts.headings) : void 0;
  const isAppendix = (text) => {
    const bare = text.replace(/:$/, "").trimEnd();
    const folded = bare.normalize("NFD").replace(new RegExp("\\p{M}+", "gu"), "").toLowerCase().replace(/\s+/g, " ");
    return APPENDIX_TITLE.test(folded) || (extra?.test(bare) ?? false);
  };
  const code = codeMask(lines);
  let level = 0;
  for (let i = 0; i < lines.length; i++) {
    const h = code[i] ? void 0 : headingAt(lines, i);
    if (level && h && h.level <= level) level = 0;
    if (!level && h && isAppendix(h.text)) level = h.level;
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
var isReferenceDefinition = (line) => /^ {0,3}\[[^\]\n]+\]:[ \t]*(?:<[^>\n]*>|\S+)(?:[ \t]+(?:"[^"\n]*"|'[^'\n]*'|\([^)\n]*\)))?[ \t]*$/.test(line);
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
    if (!prose.length && isReferenceDefinition(raw)) {
      i++;
      continue;
    }
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
    for (const tok of citationsInBracket(m[1], isCitation)) if (!out.includes(tok)) out.push(tok);
  }
  return out;
}
function citationsInBracket(inner, isCitation) {
  const tok = inner.trim();
  const unwrapped = tok.startsWith("[") ? tok.slice(1).trim() : tok;
  const parts = unwrapped.split(/[,;]/).map((p) => p.trim());
  if (parts.length > 1 && parts.every((p) => isCitation(p))) return parts;
  if (isCitation(tok)) return [tok];
  return unwrapped !== tok && isCitation(unwrapped) ? [unwrapped] : [];
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
    for (const tok of citationsInBracket(m[1], isCitation)) if (!all.includes(tok)) all.push(tok);
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
  return text.replace(/(\d)[\u00A0\u202F'](?=\d)/g, "$1").replace(/(?<=\d)[, ](?=\d{3}(?!\d))/g, "").replace(/(\d),(?=\d)/g, "$1.");
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
import { existsSync as existsSync8 } from "fs";
import { join as join12, resolve as resolve5 } from "path";

// src/orchestrate/templates.ts
import { join as join11 } from "path";
var WORKFLOW_FORBIDDEN = ["Date.now(", "Math.random(", "new Date("];
function oneWriterFooter(runAbs, opts = {}) {
  const forbidden = opts.writingCommands?.length ? ` Do not run any engine command that writes (${opts.writingCommands.map((c) => `\`${c}\``).join(", ")}).` : "";
  return `
## Return, don't write (the one-writer rule)

Return ONLY the structured output specified above. Do NOT write, edit, or delete any file in the run folder.${forbidden} The orchestrator is the sole writer: it folds your returned fragments in serially and runs the gates itself.${opts.sanctioned ? `

One sanctioned exception: ${opts.sanctioned}` : ""}

Exception for oversized prose: if a note is too large to return, write ONLY to \`${join11(runAbs, "orchestration", "out")}/<role>-<batch>.md\` \u2014 a file namespaced to you alone \u2014 and return its path.
`;
}
var SMALL_WORKLIST = 3;
function phaseBatches(phase, emission, smallWorklist) {
  const floor = emission.collapseFloor ? emission.collapseFloor(smallWorklist) : smallWorklist;
  return phase.items <= floor ? [phase.ids] : toBatches(phase.ids, emission.batchSize);
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
  const scriptPath = join11(runAbs, "orchestration", `${phase.name}.workflow.mjs`);
  const meta = { name: `${cli}-${phase.name}`, description: emission.description(phase.items), phases: [{ title: emission.title }] };
  const batches = phaseBatches(phase, emission, smallWorklist);
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
function runbookMd(phases, defs, runAbs, engineAbs, cli, preamble = [], smallWorklist = SMALL_WORKLIST) {
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
      const batches = phaseBatches(ph, emission, smallWorklist);
      const widest = batches.reduce((w, b) => Math.max(w, b.length), 0);
      lines.push(
        `Fan out: \`Workflow({ scriptPath: "${join11(runAbs, "orchestration", `${ph.name}.workflow.mjs`)}" })\``,
        `(${batches.length} agent(s) of at most ${widest} item(s), contract \`agents/${emission.role}.md\`).`,
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
var BATCH_SIZE = 8;
function listPhases(runDir, engineAbs, defs) {
  const run = resolve5(runDir);
  return defs.map((def) => {
    const worklist = join12(run, def.worklist);
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
  const run = resolve5(runDir);
  if (!existsSync8(run)) {
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
  const orchDir = join12(run, "orchestration");
  const agentsDir = join12(orchDir, "agents");
  ensureDir(join12(orchDir, "out"));
  ensureDir(agentsDir);
  const written = [];
  const notices = [];
  for (const [name, content] of Object.entries(contracts(run, engineAbs, phases))) {
    written.push(writeArtifact(join12(agentsDir, `${name}.md`), content));
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
      written.push(writeArtifact(join12(orchDir, `${ph.name}.workflow.mjs`), emitWorkflowScript(ph, def, run, engineAbs, small, opts.constants)));
    }
  }
  written.push(writeArtifact(join12(orchDir, "RUNBOOK.md"), runbookMd(phases, defs, run, engineAbs, brand().cli, opts.runbookPreamble, small)));
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
  if (isHelpWord(argv[0])) return argv[1] !== void 0 && commands.has(argv[1]) ? { kind: "help", command: argv[1] } : { kind: "help" };
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
      if (isHelpWord(arg)) return { kind: "help", command };
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
function argInt(p, name, range = {}) {
  const raw = p.values[name];
  if (raw === void 0) return void 0;
  const n = raw.trim() ? Number(raw) : Number.NaN;
  if (!Number.isFinite(n) || !Number.isInteger(n)) {
    throw new UsageError(`--${name} expects a whole number, got "${raw}"`);
  }
  const { min, max } = range;
  if (min !== void 0 && n < min || max !== void 0 && n > max) {
    const bound = min !== void 0 && max !== void 0 ? `from ${min} to ${max}` : min !== void 0 ? `of at least ${min}` : `of at most ${max}`;
    throw new UsageError(`--${name} expects a whole number ${bound}, got "${raw}"`);
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
var PROGRESS_MESSAGE_SINCE = "2025-03-26";
var BATCHES_REMOVED_IN = "2025-06-18";
function batchRefusal(batch, negotiated) {
  if (batch.length === 0) return "invalid request: an empty batch";
  if (negotiated !== void 0 && negotiated >= BATCHES_REMOVED_IN) {
    return `invalid request: JSON-RPC batches are not part of MCP ${negotiated} (removed in ${BATCHES_REMOVED_IN}) \u2014 send one message at a time`;
  }
  return void 0;
}
var DEFAULT_MAX_RESPONSE_BYTES2 = 1e6;
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
      if (actual === "number" && Number.isFinite(value)) continue;
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
  if (o === "" || o === "null") return false;
  if (LOOPBACK_ORIGIN.test(o)) return true;
  return allowed.some((a) => a === "*" || a.toLowerCase() === o.toLowerCase());
}

// src/mcp/resources.ts
import { existsSync as existsSync9, readdirSync as readdirSync7, readFileSync as readFileSync10, realpathSync, statSync as statSync5 } from "fs";
import { basename as basename3, dirname as dirname3, join as join13, relative, resolve as resolve6, sep } from "path";
import { fileURLToPath } from "url";
var skillName = () => brand().name;
var URI_SCHEME = "skill://";
function resolveSkillRoot(moduleDir) {
  const here = moduleDir ?? dirname3(fileURLToPath(import.meta.url));
  const name = brand().name;
  const candidates = [resolve6(here, ".."), resolve6(here, "..", "skills", name), resolve6(here, "..", "..", "skills", name)];
  return candidates.find((dir) => existsSync9(join13(dir, "SKILL.md")));
}
function listResources(moduleDir) {
  const root = resolveSkillRoot(moduleDir);
  if (!root) return [];
  const out = [describe(root, "SKILL.md", `${skillName()}: the skill`)];
  const refDir = join13(root, "references");
  if (!existsSync9(refDir)) return out;
  for (const file of readdirSync7(refDir).sort()) {
    if (!file.endsWith(".md")) continue;
    out.push(describe(root, join13("references", file), `${skillName()} reference: ${basename3(file, ".md")}`));
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
  const target = resolve6(root, rel);
  const served = relative(root, target).split(sep).join("/");
  if (served !== "SKILL.md" && !/^references\/[^/]+\.md$/.test(served)) {
    throw new ResourceError(`not a resource this server serves: ${uri} (resources/list names them)`);
  }
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
  if (!statSync5(targetReal).isFile()) throw new ResourceError(`not a file: ${uri}`);
  return { uri, mimeType: "text/markdown", text: readFileSync10(targetReal, "utf8") };
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
  const summary = firstProse(join13(root, rel));
  if (summary) decl.description = summary;
  return decl;
}
function firstProse(file) {
  let text;
  try {
    text = readFileSync10(file, "utf8");
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
var InvalidParamsError = class extends Error {
};
var PromptError = class extends Error {
};
var ERR_INVALID_REQUEST = -32600;
var ERR_METHOD_NOT_FOUND = -32601;
var ERR_INVALID_PARAMS = -32602;
var ERR_INTERNAL = -32603;
function createServer(adapter, opts = {}) {
  const serverInfo = { name: opts.serverName ?? brand().name, version: adapter.version };
  const maxBytes = opts.maxResponseBytes ?? DEFAULT_MAX_RESPONSE_BYTES2;
  let protocol = LATEST_PROTOCOL;
  const active = /* @__PURE__ */ new Map();
  const listTools = () => adapter.listTools(protocol).map((decl) => forRevision(decl, protocol));
  const prompts = () => adapter.prompts ?? [];
  async function handle(msg, send, handleOpts = {}) {
    if (msg === null || typeof msg !== "object" || Array.isArray(msg)) {
      send({ jsonrpc: "2.0", id: null, error: { code: ERR_INVALID_REQUEST, message: "invalid request: expected a JSON-RPC object" } });
      return;
    }
    if (msg.method === void 0 && ("result" in msg || "error" in msg)) return;
    if (msg.id !== void 0 && msg.id !== null && typeof msg.id !== "string" && typeof msg.id !== "number") {
      send({ jsonrpc: "2.0", id: null, error: { code: ERR_INVALID_REQUEST, message: "invalid request: `id` must be a string or a number" } });
      return;
    }
    if (msg.id === void 0 || msg.id === null) {
      if (msg.method === "notifications/cancelled") {
        const target = msg.params?.requestId;
        if (typeof target === "string" || typeof target === "number") active.get(target)?.cancel();
      }
      return;
    }
    const id = msg.id;
    const controller = new AbortController();
    const request = {
      cancelled: false,
      answered: false,
      cancel() {
        request.cancelled = true;
        controller.abort();
      }
    };
    active.set(id, request);
    const lost = handleOpts.signal;
    const onLost = () => request.cancel();
    if (lost?.aborted) request.cancel();
    else lost?.addEventListener("abort", onLost, { once: true });
    const reply = (out) => {
      if (request.cancelled) return;
      request.answered = true;
      send({ jsonrpc: "2.0", id, ...out });
    };
    const token = msg.params?._meta?.progressToken;
    const notify = handleOpts.notify ?? send;
    let last = Number.NEGATIVE_INFINITY;
    const progress = (value, total, message) => {
      if (typeof token !== "string" && typeof token !== "number" || request.cancelled || request.answered) return;
      if (!Number.isFinite(value) || value <= last) return;
      last = value;
      const params = { progressToken: token, progress: value };
      if (total !== void 0 && Number.isFinite(total)) params.total = total;
      if (message && protocol >= PROGRESS_MESSAGE_SINCE) params.message = message;
      notify({ jsonrpc: "2.0", method: "notifications/progress", params });
    };
    const context = { signal: controller.signal, progress };
    try {
      if (typeof msg.method !== "string") {
        reply({ error: { code: ERR_INVALID_REQUEST, message: "invalid request: no `method`" } });
        return;
      }
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
          await handleToolCall(msg, reply, context);
          return;
        case "resources/list":
          reply({ result: { resources: listResources(opts.skillDir) } });
          return;
        // Part of the resources capability declared above; every resource is
        // a fixed document, so there are no templates to offer.
        case "resources/templates/list":
          reply({ result: { resourceTemplates: [] } });
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
    } finally {
      if (active.get(id) === request) active.delete(id);
      lost?.removeEventListener("abort", onLost);
    }
  }
  async function handleToolCall(msg, reply, context) {
    const params = msg.params ?? {};
    const name = typeof params.name === "string" ? params.name : "";
    const rawArgs = params.arguments ?? {};
    if (rawArgs === null || typeof rawArgs !== "object" || Array.isArray(rawArgs)) {
      reply({ error: { code: ERR_INVALID_PARAMS, message: "`arguments` must be an object" } });
      return;
    }
    const args = rawArgs;
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
      const normalized = Object.fromEntries(
        Object.entries(args).map(([key, value]) => [
          key,
          decl.inputSchema.properties[key]?.type === "number" && typeof value === "string" ? Number(value) : value
        ])
      );
      const { text: raw, artifact } = await adapter.callTool(name, normalized, context);
      const text = capResponse(raw, name, maxBytes, artifact, adapter.capAdvice);
      const capped = text !== raw;
      const structured = protocol >= RICH_TOOLS_SINCE ? structuredContentFor(text, capped, decl.outputSchema !== void 0) : void 0;
      reply({ result: { content: [{ type: "text", text }], ...structured ? { structuredContent: structured } : {} } });
    } catch (e) {
      if (e instanceof InvalidParamsError) {
        reply({ error: { code: ERR_INVALID_PARAMS, message: e.message } });
        return;
      }
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
function forRevision(decl, protocol) {
  const { title, outputSchema, annotations, ...base2 } = decl;
  const out = { ...base2 };
  if (protocol >= RICH_TOOLS_SINCE) {
    if (title !== void 0) out.title = title;
    if (outputSchema !== void 0) out.outputSchema = outputSchema;
  }
  if (protocol >= ANNOTATIONS_SINCE && annotations) {
    out.annotations = title !== void 0 && annotations.title === void 0 ? { title, ...annotations } : annotations;
  }
  return out;
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
  let active = 0;
  const waiting = [];
  const queued = /* @__PURE__ */ new Map();
  let negotiated;
  const handleOpts = { notify: send };
  const runToolCall = async (msg, id, reply) => {
    const ticket = { cancelled: false };
    queued.set(id, ticket);
    try {
      while (active >= MAX_IN_FLIGHT) await new Promise((resolve7) => waiting.push(resolve7));
    } finally {
      if (queued.get(id) === ticket) queued.delete(id);
    }
    if (ticket.cancelled) {
      waiting.shift()?.();
      return;
    }
    active++;
    try {
      await server.handle(msg, reply, handleOpts);
    } finally {
      active--;
      waiting.shift()?.();
    }
  };
  const dispatch = async (msg, reply) => {
    if (msg !== null && typeof msg === "object" && !Array.isArray(msg)) {
      if (msg.method === "notifications/cancelled") {
        const target = msg.params?.requestId;
        const ticket = typeof target === "string" || typeof target === "number" ? queued.get(target) : void 0;
        if (ticket) ticket.cancelled = true;
      }
      if (msg.method === "tools/call" && (typeof msg.id === "string" || typeof msg.id === "number")) {
        await runToolCall(msg, msg.id, reply);
        return;
      }
    }
    await server.handle(msg, reply, handleOpts);
    if (msg?.method === "initialize") negotiated = server.protocolVersion();
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
      if (Array.isArray(parsed)) {
        const refusal2 = batchRefusal(parsed, negotiated);
        if (refusal2) {
          send({ jsonrpc: "2.0", id: null, error: { code: ERR_INVALID_REQUEST, message: refusal2 } });
          continue;
        }
        const batch = parsed;
        track(
          (async () => {
            const out = [];
            await Promise.all(batch.map((m) => dispatch(m, (r) => void out.push(r))));
            if (out.length) emit(JSON.stringify(out) + "\n");
          })().catch(reportInternal(send))
        );
        continue;
      }
      if (parsed === null || typeof parsed !== "object") {
        send({ jsonrpc: "2.0", id: null, error: { code: ERR_INVALID_REQUEST, message: "invalid request: expected a JSON-RPC object" } });
        continue;
      }
      track(dispatch(parsed, send).catch(reportInternal(send)));
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
import { createHash as createHash3, timingSafeEqual } from "crypto";
var MCP_PATH = "/mcp";
var MAX_BODY_BYTES2 = 4 * 1024 * 1024;
var REQUEST_TIMEOUT_MS = 6e4;
var CORS_HEADERS = "content-type, accept, mcp-protocol-version, mcp-session-id, authorization, last-event-id";
var LOOPBACK_BIND = /* @__PURE__ */ new Set(["127.0.0.1", "::1", "localhost"]);
async function startHttpServer(adapter, opts = {}) {
  const bind = opts.bind ?? "127.0.0.1";
  if (!LOOPBACK_BIND.has(bind) && !opts.allowRemote) {
    throw new Error(
      `refusing to bind ${bind}: ${brand().name}'s MCP server fetches arbitrary URLs and reads local files. Pass --allow-remote if that is really what you want.`
    );
  }
  const { createServer: createHttpServer } = await import("http");
  const server = createHttpServer((req, res) => {
    void route(req, res, adapter, opts).catch((e) => {
      if (res.headersSent) {
        res.destroy();
        return;
      }
      sendJson(res, 500, { jsonrpc: "2.0", id: null, error: { code: -32603, message: e instanceof Error ? e.message : String(e) } });
    });
  });
  server.requestTimeout = REQUEST_TIMEOUT_MS;
  server.headersTimeout = 6e4;
  server.keepAliveTimeout = 12e4;
  return new Promise((resolve7, reject) => {
    server.once("error", reject);
    server.listen(opts.port ?? 0, bind, () => {
      server.removeListener("error", reject);
      const addr = server.address();
      const port = typeof addr === "object" && addr ? addr.port : opts.port ?? 0;
      const host = bind.includes(":") ? `[${bind}]` : bind;
      resolve7({
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
  if (opts.bearerToken !== void 0 && !bearerMatches(header(req, "authorization"), opts.bearerToken)) {
    sendJson(res, 401, { error: "this server needs `Authorization: Bearer <token>`" }, origin, { "www-authenticate": 'Bearer realm="mcp"' });
    return;
  }
  if (path !== MCP_PATH) {
    sendJson(res, 404, { error: `not found: ${path} (the MCP endpoint is ${MCP_PATH})` }, origin);
    return;
  }
  if (req.method === "GET" || req.method === "DELETE") {
    const why = `${req.method} is not supported: this server is stateless and offers no server-initiated stream`;
    sendJson(res, 405, { error: why }, origin, { allow: "POST, OPTIONS" });
    return;
  }
  if (req.method !== "POST") {
    sendJson(res, 405, { error: `${req.method} is not supported` }, origin, { allow: "POST, OPTIONS" });
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
      sendJson(res, 413, { error: `request body exceeds ${MAX_BODY_BYTES2} bytes` }, origin);
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
  if (Array.isArray(parsed)) {
    const refusal2 = batchRefusal(parsed, declared);
    if (refusal2) {
      sendJson(res, 400, { jsonrpc: "2.0", id: null, error: { code: ERR_INVALID_REQUEST, message: refusal2 } }, origin);
      return;
    }
  }
  const mcp = createServer(adapter, opts);
  mcp.setProtocolVersion(protocol);
  const lost = new AbortController();
  res.on("close", () => {
    if (!res.writableFinished) lost.abort();
  });
  const single = Array.isArray(parsed) ? void 0 : parsed;
  const token = single?.params?._meta;
  const asked = typeof single?.id === "string" || typeof single?.id === "number";
  if (asked && token?.progressToken !== void 0 && accept.includes("text/event-stream")) {
    res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", ...corsHeaders(origin) });
    const event = (m) => {
      if (!res.writableEnded && !res.destroyed) res.write(`event: message
data: ${JSON.stringify(m)}

`);
    };
    await mcp.handle(single, event, { signal: lost.signal, notify: event });
    res.end();
    return;
  }
  const out = [];
  const collect = (m) => void out.push(m);
  const messages = Array.isArray(parsed) ? parsed : [parsed];
  for (const m of messages) await mcp.handle(m, collect, { signal: lost.signal, notify: () => {
  } });
  if (out.length === 0) {
    res.writeHead(202, corsHeaders(origin));
    res.end();
    return;
  }
  sendJson(res, 200, Array.isArray(parsed) ? out : out[0], origin);
}
function bearerMatches(sent, token) {
  const m = /^Bearer[ \t]+(\S+)[ \t]*$/i.exec(sent ?? "");
  if (!m) return false;
  const digest = (s) => createHash3("sha256").update(s).digest();
  return timingSafeEqual(digest(m[1]), digest(token));
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
var DRAIN_LIMIT = MAX_BODY_BYTES2 * 8;
function readBody(req) {
  return new Promise((resolve7, reject) => {
    const chunks = [];
    let size = 0;
    let over = false;
    const declared = Number(req.headers["content-length"]);
    if (Number.isFinite(declared) && declared > MAX_BODY_BYTES2) over = true;
    req.on("data", (c) => {
      size += c.length;
      if (over) {
        if (size > DRAIN_LIMIT) {
          req.destroy();
          reject(new Error("too large"));
        }
        return;
      }
      if (size > MAX_BODY_BYTES2) {
        over = true;
        chunks.length = 0;
        return;
      }
      chunks.push(c);
    });
    req.on("end", () => {
      if (over) reject(new Error("too large"));
      else resolve7(Buffer.concat(chunks).toString("utf8"));
    });
    req.on("error", reject);
    req.on("aborted", () => reject(new Error("client aborted the request")));
  });
}
export {
  ANNOTATIONS_SINCE,
  ANYDOC_SPEC,
  ASSUMED_HTTP_PROTOCOL,
  BATCHES_REMOVED_IN,
  BATCH_SIZE,
  COMPOSE_YAML,
  CP1252_C1,
  DEAD_LINK_STATUS,
  DEFAULT_MAX_RESPONSE_BYTES2 as DEFAULT_MAX_RESPONSE_BYTES,
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
  FRAME_EFFORT,
  InvalidParamsError,
  KEYLESS_ENGINES,
  LATEST_PROTOCOL,
  LOCAL_FILE_DOMAIN,
  PDF_EXTRACTORS,
  PDF_INSPECTOR_SPEC,
  PDF_URL_RE,
  PROGRESS_MESSAGE_SINCE,
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
  VIDEO_TRANSCRIBERS,
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
  assessTranscript,
  awaitHostSlot,
  backOffHost,
  baseLang3 as baseLang,
  batchRefusal,
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
  classifyYtdlpError,
  cleanInline,
  codeMask,
  collectCitations,
  configure,
  contactUa,
  contentCoverage,
  contentHash,
  corpusLabels,
  corpusMarkdown,
  cosine,
  crawlConcurrency,
  crawlSite,
  createServer,
  danglingTokens,
  ddgRedirectTarget,
  ddgRegion,
  deaccent,
  decodeBody,
  decodeEntities,
  decodeLocal,
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
  downloadSubtitle,
  embed,
  embedModel,
  embedOne,
  embedPrefixes,
  embeddingsDisabled,
  emitWorkflowScript,
  enabledDocExtractors,
  enabledExtractors,
  enabledTranscribers,
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
  extractFrames,
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
  fetchVideoCorpus,
  fetchVideoRun,
  fingerprint,
  firecrawlBase,
  firecrawlIsExplicit,
  fnv1a64,
  fnv1a64Words,
  focusedSnippet,
  foldTerm,
  forgeAuthHeaders,
  forgeKind,
  forgeRef,
  formatStamp,
  hammingDistance,
  hasChanged,
  have,
  headCommit,
  helpCoversFlag,
  hostDelayMs,
  htmlCanonicalUrl,
  htmlTitle,
  htmlToMarkdown,
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
  knownVideo,
  linksFrom,
  listPhases,
  listReleases,
  listResources,
  listTags,
  listVideoRuns,
  listVideos,
  looksLikeChallenge,
  looksLikeFirecrawl,
  looksLikeJunkExtraction,
  looksLikePdfUrl,
  lookupPackage,
  lookupPackageResult,
  mapGithubIssues,
  mapLimit,
  mapScrapeResponse,
  mapSearchResponse,
  markFirecrawlDown,
  markedQuoteMask,
  matcherFromTokens,
  maxCrawlDelayMs,
  mergeSegments,
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
  officeToText,
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
  parseVtt,
  pdfToText,
  pipedEnum,
  politeDelayMs,
  positionalText,
  probeFirecrawl,
  probeOllama,
  probeQdrant,
  probeSearxng,
  probeVideo,
  pubmedAbstractUrl,
  qdrantBase,
  rankedKeywords,
  readCapped,
  readCappedBytes,
  readJsonSafe,
  readManifest,
  readResource,
  readVideoRun,
  recencyScore,
  renderAsset,
  repoCacheRoot,
  repoFacts,
  repoFactsResult,
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
  resetOcrTools,
  resetOllamaProbe,
  resetPdfLadderCache,
  resetQdrantProbe,
  resetRobotsCache,
  resetRunLocks,
  resetSearxngProbeCache,
  resetVideoLadderCache,
  resolvePackage,
  resolvePackageResult,
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
  searchVideoRuns,
  searxngBase,
  searxngIsExplicit,
  searxngLanguage,
  setCacheMode,
  setNoWrite,
  setVideoDeps,
  sh,
  shAsync,
  shq,
  simhash,
  siteOf,
  skillName,
  sleep,
  slugify,
  sniffDocument,
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
  transcribeVideo,
  transcriptMarkdown,
  uncitedIds,
  unitTexts,
  unknownEngines,
  upsert,
  urlDeclaresIdentity,
  validateArgs,
  videoMetaFromInfo,
  videoRoot,
  videoRunKey,
  videoSource,
  videoUrlAt,
  whisperBudgetLeft,
  whisperModel,
  withRunLock,
  writeArtifact,
  writeFileAtomic,
  writeManifest,
  youtubeListKind,
  youtubeVideoId,
  ytdlpVersionAge
};
