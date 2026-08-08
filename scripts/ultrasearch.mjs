#!/usr/bin/env node

// src/cli.ts
import { basename as basename3, join as join15, relative as relative2, resolve as resolve5 } from "path";
import { pathToFileURL as pathToFileURL2, fileURLToPath as fileURLToPath2 } from "url";
import { realpathSync as realpathSync3, existsSync as existsSync12, statSync as statSync4, readdirSync as readdirSync2, readFileSync as readFileSync12 } from "fs";

// src/types.ts
var VERSION = "1.25.0";
var ALL_BACKENDS = [
  "searxng",
  "firecrawl",
  "duckduckgo",
  "ddglite",
  "mojeek",
  "marginalia",
  "wikipedia",
  "stackexchange",
  "hackernews",
  "github",
  "arxiv",
  "crossref",
  "openalex",
  "semanticscholar",
  "europepmc",
  "pubmed",
  "dblp",
  "standards",
  "generic",
  "fixture",
  "claude"
];
var ALL_MODES = ["topic", "bug", "research", "learn", "startup"];
var ALL_DEPTHS = ["summary", "standard", "deep"];
var DEPTH_CAPS = {
  summary: { maxSources: 10, perSource: 4, deepOnly: false },
  standard: { maxSources: 25, perSource: 6, deepOnly: false },
  deep: { maxSources: 60, perSource: 10, deepOnly: true }
};
var RECALL_FLOORS = {
  summary: 3,
  standard: 6,
  deep: 12
};
var UNDER_COVERED_MIN = 2;
var PAGES_PER_DEPTH = {
  summary: 1,
  standard: 2,
  deep: 3
};
var WEB_BREADTH_PER_DEPTH = {
  summary: 1,
  standard: 2,
  deep: 5
};
var DEEP_CAPS = {
  maxSubQuestions: 6,
  maxRounds: 3,
  maxVerify: 40,
  perSubQuestionSources: 60
};
var ALL_WEB_ENGINES = ["auto", "searxng", "firecrawl", "ddg", "ddglite", "mojeek", "marginalia", "claude"];
var ALL_SEARCH_PROFILES = ["auto", "light", "full", "max"];

// src/backends/websearch.ts
var URL_KEYS = ["url", "link", "href", "uri"];
var TITLE_KEYS = ["title", "name", "heading"];
var SNIPPET_KEYS = ["snippet", "description", "summary", "content", "text", "excerpt"];
function firstString(o, keys) {
  for (const k of keys) {
    const v = o[k];
    if (typeof v === "string" && v.trim()) return v.trim();
  }
  return void 0;
}
function normalizeUrl(raw) {
  const s = raw.trim();
  if (!s) return void 0;
  try {
    const u = new URL(s);
    if (u.protocol !== "http:" && u.protocol !== "https:") return void 0;
    return u.toString();
  } catch {
    return void 0;
  }
}
function hitFrom(entry) {
  if (typeof entry === "string") {
    const url2 = normalizeUrl(entry);
    return url2 ? { url: url2 } : void 0;
  }
  if (!entry || typeof entry !== "object" || Array.isArray(entry)) return void 0;
  const o = entry;
  const raw = firstString(o, URL_KEYS);
  if (!raw) return void 0;
  const url = normalizeUrl(raw);
  if (!url) return void 0;
  return {
    url,
    title: firstString(o, TITLE_KEYS),
    snippet: firstString(o, SNIPPET_KEYS)
  };
}
function entriesOf(parsed) {
  if (Array.isArray(parsed)) return parsed;
  if (parsed && typeof parsed === "object") {
    for (const k of ["results", "hits", "items", "webResults", "web_results", "sources"]) {
      const v = parsed[k];
      if (Array.isArray(v)) return v;
    }
  }
  return void 0;
}
function parseWebResults(raw) {
  const text = raw.trim();
  if (!text) return { hits: [], rejected: 0, notes: ["--web-results was empty."] };
  const notes = [];
  let entries;
  try {
    entries = entriesOf(JSON.parse(text));
    if (!entries) {
      return { hits: [], rejected: 0, notes: ["--web-results parsed as JSON but held no array of results (expected [{url,title,snippet}, \u2026])."] };
    }
  } catch {
    entries = text.split(/\r?\n/).filter((l) => l.trim());
    notes.push("--web-results was not JSON \u2014 read it as a newline-separated URL list.");
  }
  const hits = [];
  const seen = /* @__PURE__ */ new Set();
  let rejected = 0;
  for (const entry of entries) {
    const hit = hitFrom(entry);
    if (!hit) {
      rejected++;
      continue;
    }
    if (seen.has(hit.url)) continue;
    seen.add(hit.url);
    hits.push(hit);
  }
  if (rejected) notes.push(`--web-results: ignored ${rejected} entr${rejected === 1 ? "y" : "ies"} with no usable http(s) URL.`);
  return { hits, rejected, notes };
}
var websearchBackend = async (ctx) => {
  const hits = ctx.options.webResults ?? [];
  if (!hits.length) {
    return {
      backend: "claude",
      items: [],
      notes: ["WebSearch lane: no hits supplied (pass --web-results <file.json|->)."]
    };
  }
  const items = hits.map((h, i) => ({
    url: h.url,
    title: h.title || h.url,
    backend: "claude",
    score: hits.length - i,
    snippet: h.snippet ?? ""
    // No `text`: the page is hydrated by the gatherer through the same rescue
    // ladder as any other candidate, so a WebSearch hit is held to the same
    // evidentiary standard. The snippet is only the fallback when it fails.
  }));
  return {
    backend: "claude",
    items,
    notes: [`WebSearch lane: ${items.length} hit(s) supplied by the agent.`]
  };
};

// src/gather.ts
import { join as join6 } from "path";
import { tmpdir as tmpdir4 } from "os";

// src/modes/topic.ts
var topicMode = {
  name: "topic",
  description: "General briefing on any subject (Wikipedia + general web).",
  backends: ["wikipedia", "searxng", "duckduckgo", "standards"],
  deepOnly: [],
  extras: [],
  searchAngles: [
    "the subject itself, as a plain definition",
    "how it works \u2014 mechanism, architecture, internals",
    "the official/primary source: the vendor, project or standards body's own pages",
    "criticism, limitations and open debates",
    "current state: what changed most recently, and when",
    "alternatives and how they compare",
    "who actually runs it in production, and what they report",
    "the numbers: benchmarks, costs, adoption figures with a date"
  ],
  template: [
    "## TL;DR",
    "## What it is",
    "## How it works / key concepts",
    "## History & evolution",
    "## Current state (today)",
    "## Notable variants / approaches",
    "## Controversies & open debates",
    "## Practical implications",
    "## Sources"
  ].join("\n")
};

// src/modes/bug.ts
var bugMode = {
  name: "bug",
  description: "Error & debugging research (Stack Overflow, GitHub issues, Hacker News, changelogs).",
  backends: ["stackexchange", "github", "duckduckgo", "hackernews", "standards"],
  deepOnly: ["searxng"],
  extras: [],
  searchAngles: [
    "the error text VERBATIM, in quotes",
    "the error text with the volatile parts (paths, ids, ports) stripped out",
    "the symptom described in plain words, without the stack trace",
    "the library/tool name + the error + 'github issue'",
    "the library/tool name + the version where it started",
    "the fix phrasing: how people who solved it describe the workaround",
    "the changelog or release notes around the version that broke it",
    "the same symptom in a NEIGHBOURING tool \u2014 often the same root cause"
  ],
  template: [
    "## TL;DR (likely cause + fastest fix)",
    "## Symptom & reproduction",
    "## Root cause analysis",
    "## Candidate fixes (ranked)",
    "### Fix A \u2014 <summary> [confidence]",
    "### Fix B \u2014 <summary>",
    "## Related issues & versions affected",
    "## Workarounds",
    "## If still stuck (next diagnostics)",
    "## Sources"
  ].join("\n")
};

// src/modes/research.ts
var researchMode = {
  name: "research",
  description: "Scholarly literature review (arXiv, Crossref, OpenAlex, Semantic Scholar, Europe PMC; +PubMed/dblp at deep) + refs.bib.",
  backends: ["arxiv", "openalex", "crossref", "semanticscholar", "europepmc"],
  deepOnly: ["pubmed", "dblp", "duckduckgo", "wikipedia"],
  extras: ["bibtex"],
  searchAngles: [
    "the topic + 'survey' or 'systematic review'",
    "the canonical method/model name, as the field spells it",
    "the seminal paper: earliest work everyone cites",
    "recent work: the topic + the current year",
    "the counter-position: critiques, failed replications, negative results",
    "the benchmark or dataset the field measures this on",
    "the review article that maps the subfield's disagreements",
    "who cites the seminal work and what they changed about it"
  ],
  template: [
    "## Abstract / TL;DR",
    "## Background & motivation",
    "## Key papers (chronological)",
    "## Methods & approaches compared",
    "## Findings & consensus",
    "## Gaps & open problems",
    "## Future directions",
    "## References (see refs.bib)",
    "## Sources"
  ].join("\n")
};

// src/modes/learn.ts
var learnMode = {
  name: "learn",
  description: "Pedagogical lesson with glossary, worked examples and exercises (rich HTML).",
  backends: ["wikipedia", "duckduckgo", "searxng"],
  deepOnly: ["standards"],
  extras: ["glossary", "exercises"],
  searchAngles: [
    "the topic + 'tutorial' or 'getting started'",
    "the topic explained for a beginner ('explained', 'from scratch')",
    "the official documentation's own introduction",
    "worked examples and common exercises",
    "the mistakes beginners make ('common pitfalls', 'gotchas')",
    "the prerequisites: what you must know first",
    "the mental model an expert uses (analogies, first principles)",
    "what to learn NEXT once this is understood"
  ],
  template: [
    "## Learning objectives",
    "## Prerequisites",
    "## Glossary (see glossary.md)",
    "## Lesson",
    "### Concept 1 \u2014 explanation + example",
    "### Concept 2 \u2014 explanation + example",
    "## Worked examples",
    "## Exercises",
    "## Solutions",
    "## Further reading",
    "## Sources"
  ].join("\n")
};

// src/modes/startup.ts
var startupMode = {
  name: "startup",
  description: "Market research \u2014 competitors, market sizing, pricing, GTM (general web + public sources).",
  backends: ["duckduckgo", "searxng", "hackernews"],
  deepOnly: ["wikipedia"],
  extras: [],
  searchAngles: [
    "the product category + 'alternatives' or 'vs'",
    "each named competitor's own pricing page",
    "market size / market share for the category, with a year",
    "what customers complain about (reviews, forums, HN threads)",
    "funding, acquisitions and who is actually shipping",
    "the regulatory or distribution constraint the category lives under",
    "how incumbents price and package, in their own words",
    "who tried this and failed, and the post-mortem they wrote"
  ],
  template: [
    "## Executive summary",
    "## Problem & customer",
    "## Market sizing (TAM / SAM / SOM)",
    "## Competitive landscape",
    "### Competitor table (name \xB7 positioning \xB7 pricing)",
    "## Pricing & business models observed",
    "## Go-to-market channels",
    "## Trends & timing",
    "## Risks & moats",
    "## Sources"
  ].join("\n")
};

// src/modes/registry.ts
var MODES = {
  topic: topicMode,
  bug: bugMode,
  research: researchMode,
  learn: learnMode,
  startup: startupMode
};
function getMode(name) {
  return MODES[name];
}
function listModes() {
  return Object.values(MODES);
}

// src/vendor/webindex-engine.mjs
import { inflateSync, inflateRawSync } from "zlib";
import { mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { spawn } from "child_process";
import { spawnSync } from "child_process";
import { existsSync as existsSync2, mkdirSync, readFileSync as readFileSync2, writeFileSync as writeFileSync2 } from "fs";
import { tmpdir as tmpdir2 } from "os";
import { dirname, join as join2 } from "path";
import { existsSync as existsSync3, mkdirSync as mkdirSync3, readFileSync as readFileSync3, writeFileSync as writeFileSync4 } from "fs";
import { join as join3 } from "path";
import { tmpdir as tmpdir3 } from "os";
import { mkdirSync as mkdirSync2, writeFileSync as writeFileSync3 } from "fs";
import { existsSync as existsSync4, readdirSync, readFileSync as readFileSync4, realpathSync, statSync } from "fs";
import { basename, dirname as dirname2, join as join4, resolve, sep } from "path";
import { fileURLToPath } from "url";
import { createInterface } from "readline";
import { createServer as createHttpServer } from "http";
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
var PDF_INSPECTOR_SPEC = "@firecrawl/pdf-inspector@1";
var ANYDOC_SPEC = "@firecrawl/anydoc@0.1";
var MAX_STDOUT_BYTES = 24 * 1024 * 1024;
function binaryName(name) {
  return process.platform === "win32" && name === "npx" ? "npx.cmd" : name;
}
function runWithInput(cmd, args, input, timeoutMs) {
  return new Promise((resolve22) => {
    let child;
    try {
      child = spawn(binaryName(cmd), args, { stdio: ["pipe", "pipe", "pipe"] });
    } catch (e) {
      resolve22({ ok: false, stdout: "", error: e.message });
      return;
    }
    const chunks = [];
    let size = 0;
    let settled = false;
    const done = (r) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve22(r);
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
var DEFAULT_TIMEOUT_MS = 3e5;
var DEFAULT_MAX_DOCS = 3;
var DEFAULT_LANG = "eng";
var spent = 0;
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
var PDF_EXTRACTORS = ["pdf-inspector", "anydoc", "firecrawl", "pdftotext", "native", "ocr"];
var NPX_TIMEOUT_MS = 9e4;
var PDFTOTEXT_TIMEOUT_MS = 6e4;
var dead = /* @__PURE__ */ new Set();
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
var DOC_EXTRACTORS = ["anydoc", "firecrawl"];
var NPX_TIMEOUT_MS2 = 9e4;
var dead2 = /* @__PURE__ */ new Set();
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
var DEFAULT_BROWSER_UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";
function browserUa() {
  return env("UA") || DEFAULT_BROWSER_UA;
}
function contactUa() {
  const b = brand();
  return `${b.name}/1.x (+${b.contactUrl ?? `https://github.com/maxgfr/${b.name}`})`;
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
function retryDelayMs(retryAfter) {
  if (retryAfter) {
    const secs = Number(retryAfter);
    if (Number.isFinite(secs)) return Math.min(Math.max(secs * 1e3, 0), 5e3);
  }
  return defaultRetryMs();
}
async function httpGet(url, opts = {}) {
  let last = { ok: false, status: 0, body: "", contentType: "", url };
  for (let attempt = 0; attempt < maxAttempts(); attempt++) {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), opts.timeoutMs ?? 2e4);
    try {
      const headers = { "user-agent": opts.userAgent ?? browserUa(), accept: opts.accept ?? "*/*" };
      if (opts.acceptLanguage) headers["accept-language"] = opts.acceptLanguage;
      const res = await fetch(url, {
        signal: ctrl.signal,
        redirect: "follow",
        headers
      });
      const buf = Buffer.from(await res.arrayBuffer());
      const max = opts.maxBytes ?? 4 * 1024 * 1024;
      const capped = buf.subarray(0, max);
      const result = {
        ok: res.ok,
        status: res.status,
        body: opts.binary ? "" : capped.toString("utf8"),
        bytes: opts.binary ? capped : void 0,
        contentType: res.headers.get("content-type") ?? "",
        url: res.url || url
      };
      if (RETRY_STATUS.has(res.status) && attempt < maxAttempts() - 1) {
        last = result;
        await sleep(retryDelayMs(res.headers.get("retry-after")));
        continue;
      }
      return result;
    } catch (e) {
      last = { ok: false, status: 0, body: "", contentType: "", url, error: e.message };
      if (attempt < maxAttempts() - 1) await sleep(defaultRetryMs());
    } finally {
      clearTimeout(t);
    }
  }
  return last;
}
async function httpJson(method, url, body, opts = {}) {
  let last = { ok: false, status: 0, data: void 0 };
  for (let attempt = 0; attempt < maxAttempts(); attempt++) {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), opts.timeoutMs ?? 2e4);
    try {
      const headers = {
        "content-type": "application/json",
        accept: opts.accept ?? "application/json",
        "user-agent": opts.userAgent ?? browserUa()
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
      let data;
      try {
        data = text ? JSON.parse(text) : void 0;
      } catch {
        data = text;
      }
      const result = { ok: res.ok, status: res.status, data };
      if (RETRY_STATUS.has(res.status) && attempt < maxAttempts() - 1) {
        last = result;
        await sleep(retryDelayMs(res.headers.get("retry-after")));
        continue;
      }
      return result;
    } catch (e) {
      last = { ok: false, status: 0, data: void 0, error: e.message };
      if (attempt < maxAttempts() - 1) await sleep(defaultRetryMs());
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
function decodeEntities(s) {
  let out = s.replace(/&#x([0-9a-fA-F]+);/g, (_m, h) => {
    try {
      return String.fromCodePoint(parseInt(h, 16));
    } catch {
      return " ";
    }
  });
  out = out.replace(/&#(\d+);/g, (_m, n) => {
    try {
      return String.fromCodePoint(Number(n));
    } catch {
      return " ";
    }
  });
  for (const [k, v] of Object.entries(ENTITIES)) out = out.split(k).join(v);
  return out;
}
function cleanInline(s) {
  return decodeEntities(String(s)).replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
}
function htmlToText(html) {
  let s = html;
  s = s.replace(/<!--[\s\S]*?-->/g, " ");
  s = s.replace(/<(script|style|noscript|head|nav|footer|svg|template)[\s\S]*?<\/\1>/gi, " ");
  s = s.replace(/<h([1-6])(?:\s[^>]*)?>/gi, (_m, n) => "\n" + "#".repeat(Number(n)) + " ");
  s = s.replace(/<\/(p|div|section|article|li|tr|h[1-6]|pre|blockquote|br)>/gi, "\n");
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
  for (const tag2 of [canonical, og]) {
    const href = tag2 && /\b(?:href|content)=["']([^"']+)["']/i.exec(tag2)?.[1];
    if (href?.trim()) return decodeEntities(href.trim());
  }
  return void 0;
}
function sliceToMatchingClose(html, start, tag2) {
  const re = new RegExp(`<${tag2}\\b|</${tag2}\\s*>`, "gi");
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
  const fetchOpts = wantsPdf ? PDF_FETCH_OPTS : wantsDoc ? DOC_FETCH_OPTS : { accept: "text/html,text/plain,*/*", acceptLanguage: opts.acceptLanguage };
  const res = await httpGet(url, fetchOpts);
  if (!res.ok) {
    const why = res.status === 429 ? "rate-limited (HTTP 429)" : `status ${res.status}${res.error ? ", " + res.error : ""}`;
    return { text: "", finalUrl: res.url, status: res.status, note: `Could not fetch ${url} (${why}).` };
  }
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
      note: got.text ? firecrawlNote : `Fetched ${url} but could not extract text \u2014 ${got.reason}.`
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
      return { text: bytes.toString("utf8"), finalUrl: res.url, status: res.status, note: firecrawlNote };
    }
    return {
      text: got.text,
      finalUrl: res.url,
      status: res.status,
      extractor: got.via,
      note: got.text ? firecrawlNote : `Fetched ${url} but could not extract text \u2014 ${got.reason}.`
    };
  }
  const isHtml = /html/i.test(res.contentType) || /^\s*</.test(res.body);
  const text = isHtml ? htmlToText(extractMainHtml(res.body)) : res.body;
  const title = isHtml ? htmlTitle(res.body) : void 0;
  const canonical = isHtml ? htmlCanonicalUrl(res.body) : void 0;
  return { text, title, canonical, finalUrl: res.url, status: res.status, note: firecrawlNote };
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
var SEARXNG_DEFAULT_BASE = "http://localhost:8888";
var PROBE_TIMEOUT_MS2 = 2e3;
function searxngBase(opts = {}) {
  const raw = (opts.searxng ?? env("SEARXNG") ?? SEARXNG_DEFAULT_BASE).trim();
  if (!raw || raw.toLowerCase() === "off") return null;
  return raw.replace(/\/+$/, "");
}
function searxngIsExplicit(opts = {}) {
  return !!(opts.searxng ?? env("SEARXNG"));
}
var probeCache2 = /* @__PURE__ */ new Map();
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
function ensureComposeMaterialized() {
  const base = join2(brand().cacheDir ?? join2(tmpdir2(), brand().name), "compose");
  const composePath = join2(base, "docker-compose.yml");
  const settingsPath = join2(base, "docker", "searxng", "settings.yml");
  const firecrawlEnvPath = join2(base, "docker", "firecrawl", "firecrawl.env");
  writeIfChanged(composePath, renderAsset(COMPOSE_YAML));
  writeIfChanged(settingsPath, renderAsset(SEARXNG_SETTINGS_YAML));
  writeIfChanged(firecrawlEnvPath, renderAsset(FIRECRAWL_ENV));
  return composePath;
}
function writeIfChanged(path, content) {
  try {
    if (existsSync2(path) && readFileSync2(path, "utf8") === content) return;
    mkdirSync(dirname(path), { recursive: true });
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
  const res = spawnSync(cmd, args, {
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
var STACK_SERVICES = Object.keys(STACKS);
var SERVICE_PROFILES = Object.fromEntries(Object.entries(STACKS).map(([k, v]) => [k, v.profiles]));
function stackControl(service, action, deps = {}) {
  const run = deps.run ?? defaultRun;
  const has = deps.has ?? defaultHas;
  const tag2 = `${brand().cli} ${service}`;
  const spec = STACKS[service];
  if (!spec) return { message: `${brand().cli}: unknown service "${service}" \u2014 expected one of ${STACK_SERVICES.join(", ")}`, code: 1 };
  if (action !== "up" && action !== "down" && action !== "status") {
    return { message: `${tag2}: unknown action "${action}" (use: up | down | status)`, code: 1 };
  }
  if (!has("docker")) {
    return { message: `${tag2}: docker not found on PATH. The stack is optional \u2014 everything it provides degrades to a note.`, code: 1 };
  }
  const file = ensureComposeMaterialized();
  const profiles = spec.profiles.flatMap((p) => ["--profile", p]);
  if (action === "down") {
    const r = run("docker", ["compose", "-f", file, ...profiles, "down"], { timeoutMs: DOWN_TIMEOUT_MS, capture: true });
    return { message: r.ok ? `${tag2}: stopped.` : `${tag2}: down failed.
${r.stderr}`, code: r.ok ? 0 : 1 };
  }
  if (action === "status") {
    const r = run("docker", ["compose", "-f", file, ...profiles, "ps"], { timeoutMs: PS_TIMEOUT_MS, capture: true });
    return { message: r.ok ? r.stdout.trim() || `${tag2}: no services running.` : `${tag2}: status failed.
${r.stderr}`, code: 0 };
  }
  const pulled = run("docker", ["compose", "-f", file, ...profiles, "pull"], { timeoutMs: pullTimeoutMs() });
  if (!pulled.ok) {
    return {
      message: `${tag2}: pulling the images failed (they are large \u2014 raise ${envName("DOCKER_PULL_TIMEOUT_MS")}, currently ${pullTimeoutMs()}ms).` + (pulled.stderr ? `
${pulled.stderr}` : ""),
      code: 1
    };
  }
  const up = run("docker", ["compose", "-f", file, ...profiles, "up", "-d", "--wait"], { timeoutMs: UP_TIMEOUT_MS });
  if (!up.ok) return { message: `${tag2}: up failed.${up.stderr ? `
${up.stderr}` : ""}`, code: 1 };
  return { message: [`${tag2}: ${spec.summary}`, ...spec.postUp?.(file, run) ?? []].join("\n"), code: 0 };
}
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
  mkdirSync2(dir, { recursive: true });
}
function writeArtifact(path, content) {
  if (isNoWrite()) {
    const at = collected.findIndex((a) => a.path === path);
    if (at !== -1) collected[at] = { path, content };
    else collected.push({ path, content });
    return path;
  }
  writeFileSync3(path, content);
  return path;
}
function takeArtifacts() {
  return collected.splice(0, collected.length);
}
var DEFAULT_TTL_MS = 24 * 60 * 60 * 1e3;
function cacheDir() {
  return env("CACHE_DIR") ?? brand().cacheDir ?? join3(tmpdir3(), brand().name, "cache");
}
function cachePath(url, acceptLanguage = "", extractor = "native") {
  const canon = canonicalizeUrl(url);
  const domain = domainOf(url).replace(/[^a-z0-9.-]/gi, "_") || "url";
  return join3(cacheDir(), `${domain}-${fnv1a64(`${canon}\0${acceptLanguage}\0${extractor}`).toString(16)}.json`);
}
var PDF_CACHE_NS = "pdf";
var DOC_CACHE_NS = "doc";
async function currentExtractor(opts, url) {
  if (looksLikePdfUrl(url)) return PDF_CACHE_NS;
  if (docFormatForUrl(url)) return DOC_CACHE_NS;
  const base = firecrawlBase(opts);
  return base && await probeFirecrawl(base, firecrawlIsExplicit(opts)) ? "firecrawl" : "native";
}
function ttlMs() {
  return envInt("CACHE_TTL_MS", DEFAULT_TTL_MS);
}
function readCache(url, now, acceptLanguage = "", extractor = "native") {
  const p = cachePath(url, acceptLanguage, extractor);
  if (!existsSync3(p)) return void 0;
  try {
    const entry = JSON.parse(readFileSync3(p, "utf8"));
    if (typeof entry.cachedAt !== "number" || now - entry.cachedAt > ttlMs()) return void 0;
    if (!entry.text?.trim()) return void 0;
    return entry;
  } catch {
    return void 0;
  }
}
function writeCache(url, res, now, acceptLanguage = "", extractor = "native") {
  if (isNoWrite()) return;
  try {
    mkdirSync3(cacheDir(), { recursive: true });
    const entry = { ...res, cachedAt: now };
    writeFileSync4(cachePath(url, acceptLanguage, extractor), JSON.stringify(entry));
  } catch {
  }
}
async function cachedFetchAndExtract(url, opts = {}, enabled = false, now = Date.now()) {
  if (!enabled) return fetchAndExtract(url, opts);
  const lang = opts.acceptLanguage ?? "";
  const ns = await currentExtractor(opts, url);
  const hit = readCache(url, now, lang, ns);
  if (hit) return { ...hit, cached: true };
  const res = await fetchAndExtract(url, opts);
  if (res.text?.trim()) writeCache(url, res, now, lang, ns === PDF_CACHE_NS || ns === DOC_CACHE_NS ? ns : res.extractor ?? "native");
  return res;
}
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
var skillName = () => brand().name;
var URI_SCHEME = "skill://";
function resolveSkillRoot(moduleDir) {
  const here = moduleDir ?? dirname2(fileURLToPath(import.meta.url));
  const name = brand().name;
  const candidates = [resolve(here, ".."), resolve(here, "..", "skills", name), resolve(here, "..", "..", "skills", name)];
  return candidates.find((dir) => existsSync4(join4(dir, "SKILL.md")));
}
function listResources(moduleDir) {
  const root = resolveSkillRoot(moduleDir);
  if (!root) return [];
  const out = [describe(root, "SKILL.md", `${skillName()}: the skill`)];
  const refDir = join4(root, "references");
  if (!existsSync4(refDir)) return out;
  for (const file of readdirSync(refDir).sort()) {
    if (!file.endsWith(".md")) continue;
    out.push(describe(root, join4("references", file), `${skillName()} reference: ${basename(file, ".md")}`));
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
  const target = resolve(root, rel);
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
  if (!statSync(targetReal).isFile()) throw new ResourceError(`not a file: ${uri}`);
  return { uri, mimeType: "text/markdown", text: readFileSync4(targetReal, "utf8") };
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
  const summary = firstProse(join4(root, rel));
  if (summary) decl.description = summary;
  return decl;
}
function firstProse(file) {
  let text;
  try {
    text = readFileSync4(file, "utf8");
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
  return new Promise((resolve22, reject) => {
    server.once("error", reject);
    server.listen(opts.port ?? 0, bind, () => {
      server.removeListener("error", reject);
      const addr = server.address();
      const port = typeof addr === "object" && addr ? addr.port : opts.port ?? 0;
      const host = bind.includes(":") ? `[${bind}]` : bind;
      resolve22({
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
  return new Promise((resolve22, reject) => {
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
      else resolve22(Buffer.concat(chunks).toString("utf8"));
    });
    req.on("error", reject);
    req.on("aborted", () => reject(new Error("client aborted the request")));
  });
}

// src/engine.ts
configure({
  name: "ultrasearch",
  envPrefix: "ULTRASEARCH",
  cli: "ultrasearch",
  contactUrl: "https://github.com/maxgfr/ultrasearch"
});

// src/util.ts
function titleFromText(text) {
  const heading = /^\s*#{1,6}\s+(.+?)\s*#*\s*$/m.exec(text.split(/\n\s*\n/)[0] ?? "");
  if (heading) return heading[1].trim().slice(0, 200);
  const paras = text.split(/\n\s*\n/).map((p) => p.replace(/\s+/g, " ").trim()).filter(Boolean);
  const lead = paras[0] ?? "";
  const bibliographic = /^\d+\.\s/.test(lead) && /\bdoi:|\bepub\b|\d{4}\s+\w{3}\b/i.test(lead);
  const pick = (bibliographic ? paras[1] : lead) || lead;
  return pick.slice(0, 200) || text.trim().replace(/\s+/g, " ").slice(0, 200);
}
function shq(s) {
  return `'${s.replace(/\r?\n/g, " ").replaceAll("'", `'"'"'`)}'`;
}
function slugify(input) {
  return input.toLowerCase().replace(/^https?:\/\//, "").replace(/[^a-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 80) || "run";
}
function pad(n) {
  return String(n).padStart(2, "0");
}
function runId(d = /* @__PURE__ */ new Date()) {
  return `run-${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
}
var BACKEND_TRUST = {
  arxiv: 0.9,
  crossref: 0.9,
  openalex: 0.9,
  semanticscholar: 0.9,
  europepmc: 0.9,
  pubmed: 0.9,
  dblp: 0.9,
  standards: 0.9,
  wikipedia: 0.85,
  github: 0.8,
  // General-web discovery engines (searxng, duckduckgo, ddglite, mojeek,
  // marginalia, firecrawl) deliberately get NO authority floor: they surface
  // arbitrary pages, so trust must come from the domain alone. `firecrawl` is
  // spelled out at 0 (identical to being absent) so the omission reads as a
  // decision rather than an oversight — its /search proxies the same open web.
  firecrawl: 0,
  stackexchange: 0.72,
  hackernews: 0.5,
  // A file the user named on the command line. No floor, for the same reason the
  // discovery engines get none: the route says the operator chose it, not that
  // the document is authoritative. Spelled out at the neutral value so the
  // omission reads as a decision.
  file: 0.5
};
var NEUTRAL_TRUST = 0.5;
function trustScore(_url, backend) {
  return Number(Math.max(NEUTRAL_TRUST, BACKEND_TRUST[backend] ?? 0).toFixed(2));
}
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
function identityKey(item) {
  const doi = item.meta?.doi;
  if (doi) return "doi:" + normalizeDoi(String(doi));
  const arxiv = item.meta?.arxivId;
  if (arxiv) return "arxiv:" + String(arxiv).toLowerCase().replace(/v\d+$/, "");
  const urlDoi = doiFromUrl(item.url);
  if (urlDoi) return "doi:" + urlDoi;
  const urlArxiv = arxivIdFromUrl(item.url);
  if (urlArxiv) return "arxiv:" + urlArxiv;
  return canonicalizeUrl(item.url);
}
function extractIdentifiers(question) {
  const out = /* @__PURE__ */ new Set();
  const add = (re, group = 0) => {
    for (const m of question.matchAll(re)) {
      const v = (m[group] ?? m[0]).trim();
      if (v) out.add(v);
    }
  };
  add(/\bv?\d+(?:\.\d+){1,}\b/g);
  add(/\b10\.\d{4,}\/\S+/g);
  add(/\b\d{4}\.\d{4,5}(?:v\d+)?\b/g);
  add(/\b[a-z]+(?:[A-Z][a-z0-9]+)+\b/g);
  add(/\b[A-Za-z]+_[A-Za-z0-9_]+\b/g);
  add(/\b\d{3,}\b/g);
  add(/"([^"\n]{3,})"/g, 1);
  return [...out];
}
function planVariants(question, depth) {
  const base = question.trim();
  const variants = base ? [base] : [];
  const kw = rankedKeywords(question).slice(0, 8).join(" ");
  if (kw && kw.toLowerCase() !== base.toLowerCase()) variants.push(kw);
  const idents = extractIdentifiers(question);
  if (idents.length) variants.push(idents.join(" "));
  const ordered = keywords(question);
  if (ordered.length >= 2) variants.push(`"${ordered.slice(0, 4).join(" ")}"`);
  if (idents.length && ordered.length) variants.push([ordered[0], ...idents].join(" "));
  const seen = /* @__PURE__ */ new Set();
  const uniq = [];
  for (const v of variants) {
    const key = v.toLowerCase();
    if (v && !seen.has(key)) {
      seen.add(key);
      uniq.push(v);
    }
  }
  const n = depth === "summary" ? 1 : depth === "standard" ? 2 : 3;
  return uniq.slice(0, n).length ? uniq.slice(0, n) : [base];
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
function bm25MatchedTerms(index, doc) {
  if (!index.queryTerms.length) return [];
  const present = new Set(docTokens(doc, index.titleWeight, index.headingWeight));
  return index.queryTerms.filter((t) => present.has(t));
}
function applyRelevanceFloor(ranked, matchedOf, queryTerms, floor) {
  const isAlpha = (t) => new RegExp("\\p{L}", "u").test(t);
  const alphaTerms = queryTerms.filter(isAlpha);
  if (queryTerms.length < 2 || alphaTerms.length < 1) return { kept: ranked, dropped: [] };
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
  for (const sh of shingles) {
    const h = fnv1a64(sh);
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
function betterSource(a, b) {
  if (a.score !== b.score) return a.score > b.score;
  return a.url.localeCompare(b.url) < 0;
}
function diversify(items, tokensOf, lambda = 0.75) {
  if (items.length <= 2) return [...items];
  const toks = new Map(items.map((it) => [it, tokensOf(it)]));
  const max = Math.max(...items.map((it) => it.score), 1e-9);
  const rel = (it) => it.score / max;
  const jaccard2 = (a, b) => {
    if (!a.size || !b.size) return 0;
    const [small, large] = a.size <= b.size ? [a, b] : [b, a];
    let inter = 0;
    for (const t of small) if (large.has(t)) inter++;
    return inter / (a.size + b.size - inter);
  };
  let simMax = 0;
  for (let i = 0; i < items.length; i++) {
    for (let j = i + 1; j < items.length; j++) {
      const v = jaccard2(toks.get(items[i]), toks.get(items[j]));
      if (v > simMax) simMax = v;
    }
  }
  const sim = (a, b) => simMax > 0 ? jaccard2(toks.get(a), toks.get(b)) / simMax : 0;
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
    for (const it of remaining) {
      maxSim.set(it, Math.max(maxSim.get(it) ?? 0, sim(it, picked)));
    }
  }
  return out;
}
function dedupeNearDuplicates(items, opts = {}) {
  const maxBits = opts.maxBits ?? 3;
  const minChars = opts.minChars ?? 500;
  const kept = [];
  let dropped = 0;
  for (const it of items) {
    const text = it.text || "";
    const hash = text.length >= minChars ? simhash(text) : null;
    if (hash !== null) {
      const dup = kept.find((k) => k.hash !== null && hammingDistance(k.hash, hash) <= maxBits);
      if (dup) {
        dropped++;
        if (betterSource(it, dup.it)) {
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
function sinceEpochSeconds(since) {
  if (!since) return null;
  const ms = Date.parse(since.length === 4 ? `${since}-01-01` : since);
  return Number.isFinite(ms) ? Math.floor(ms / 1e3) : null;
}
function sinceDate(since) {
  const secs = sinceEpochSeconds(since);
  return secs === null ? null : new Date(secs * 1e3).toISOString().slice(0, 10);
}
async function mapLimit(items, limit, fn) {
  const results = new Array(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, async () => {
    while (true) {
      const idx = next++;
      if (idx >= items.length) break;
      results[idx] = await fn(items[idx], idx);
    }
  });
  await Promise.all(workers);
  return results;
}

// src/backends/searxng.ts
var searxngBackend = async (ctx) => {
  const base = searxngBase({ searxng: ctx.options.searxng });
  if (!base) {
    return {
      backend: "searxng",
      items: [],
      notes: ["SearXNG disabled (--searxng off / ULTRASEARCH_SEARXNG=off). Skipping."]
    };
  }
  if (!await probeSearxng(base)) {
    return {
      backend: "searxng",
      items: [],
      notes: [
        searxngIsExplicit({ searxng: ctx.options.searxng }) ? `SearXNG not reachable at ${base}. Skipping; consider your own WebSearch.` : `SearXNG not running at ${base} \u2014 start it with \`ultrasearch searxng up\` for a local, keyless discovery backend. Skipping.`
      ]
    };
  }
  const pages = Math.max(1, ctx.options.pages ?? 1);
  const acceptLanguage = acceptLanguageHeader(ctx.options.lang, ctx.options.region);
  const perPage = ctx.options.perSource * 2;
  const base0 = `${base}/search?q=${encodeURIComponent(ctx.question)}&format=json&safesearch=1${ctx.options.lang ? `&language=${encodeURIComponent(ctx.options.lang)}` : ""}${ctx.options.since ? `&time_range=year` : ""}`;
  const seen = /* @__PURE__ */ new Set();
  const found = [];
  const suspended = /* @__PURE__ */ new Map();
  for (let p = 0; p < pages; p++) {
    const url = base0 + (p > 0 ? `&pageno=${p + 1}` : "");
    const r = await httpGet(url, { accept: "application/json", acceptLanguage, timeoutMs: 8e3 });
    if (!r.ok) {
      if (p === 0) {
        const why = r.status === 429 || r.status === 503 ? `rate-limited (HTTP ${r.status})` : `unreachable (status ${r.status})`;
        return {
          backend: "searxng",
          items: [],
          notes: [`SearXNG ${why} at ${base}. Skipping; consider your own WebSearch.`]
        };
      }
      break;
    }
    let data;
    try {
      data = JSON.parse(r.body);
    } catch {
      if (p === 0) {
        return {
          backend: "searxng",
          items: [],
          notes: [`SearXNG at ${base} did not return JSON (the instance likely disables format=json).`]
        };
      }
      break;
    }
    for (const u of Array.isArray(data?.unresponsive_engines) ? data.unresponsive_engines : []) {
      const [engine, why] = Array.isArray(u) ? u : [u, ""];
      if (engine) suspended.set(String(engine), String(why ?? "").trim());
    }
    const results = Array.isArray(data?.results) ? data.results : [];
    const before = found.length;
    for (const x of results.slice(0, perPage)) {
      if (!x?.url || typeof x.url !== "string") continue;
      const key = canonicalizeUrl(x.url);
      if (seen.has(key)) continue;
      seen.add(key);
      found.push({ url: x.url, title: String(x.title || x.url), snippet: String(x.content ?? "").slice(0, 360) });
    }
    if (found.length === before) break;
    if (p < pages - 1 && pageDelayMs()) await sleep(pageDelayMs());
  }
  const items = found.map((f, i) => ({
    url: f.url,
    title: f.title,
    backend: "searxng",
    score: found.length - i,
    snippet: f.snippet,
    lang: ctx.options.lang
  }));
  const throttled = [...suspended].map(([engine, why]) => why ? `${engine} (${why})` : engine);
  const blocked = throttled.length ? ` Upstream engines unavailable: ${throttled.join(", ")}.` : "";
  return {
    backend: "searxng",
    items,
    notes: items.length ? [`SearXNG returned ${items.length} result(s).${blocked}`] : [
      throttled.length ? `SearXNG returned no results \u2014 its upstream engines are throttling this instance, which is transient.${blocked} The cascade fell through to the other engines; retry in a few minutes for SearXNG's own recall.` : `SearXNG returned no results.`
    ]
  };
};

// src/backends/firecrawl.ts
var firecrawlBackend = async (ctx) => {
  const { hits, why } = await searchViaFirecrawl(ctx.question, ctx.options.perSource * 2, ctx.options);
  if (!hits) return { backend: "firecrawl", items: [], notes: [why ?? "Firecrawl search returned nothing."] };
  const items = hits.slice(0, ctx.options.perSource * 2).map((h, i) => ({
    url: h.url,
    title: h.title,
    backend: "firecrawl",
    score: hits.length - i,
    snippet: h.description,
    // Firecrawl only returns page markdown with a search hit when asked to
    // scrape each result; when it does, the gatherer skips re-fetching the page.
    ...h.markdown ? { text: h.markdown } : {},
    lang: ctx.options.lang
  }));
  return {
    backend: "firecrawl",
    items,
    notes: items.length ? [`Firecrawl search returned ${items.length} result(s).`] : [`Firecrawl search returned no results.`]
  };
};

// src/backends/duckduckgo.ts
function stripTags(s) {
  return decodeEntities(s.replace(/<[^>]+>/g, " ")).replace(/\s+/g, " ").trim();
}
function realUrl(href) {
  const uddg = /[?&]uddg=([^&]+)/.exec(href);
  if (uddg) {
    try {
      return decodeURIComponent(uddg[1]);
    } catch {
    }
  }
  return href.startsWith("//") ? "https:" + href : href;
}
function parseDdgPage(body, limit) {
  const found = [];
  const blockRe = /<a\b([^>]*\bresult__a\b[^>]*)>([\s\S]*?)<\/a>([\s\S]*?)(?=<a\b[^>]*\bresult__a\b|$)/gi;
  let m;
  while ((m = blockRe.exec(body)) && found.length < limit) {
    const href0 = /\bhref="([^"]+)"/.exec(m[1]);
    if (!href0) continue;
    const href = realUrl(href0[1]);
    if (!/^https?:\/\//.test(href) || /duckduckgo\.com/.test(href)) continue;
    const snipM = /class="result__snippet"[^>]*>([\s\S]*?)<\/a>/i.exec(m[3]);
    found.push({ url: href, title: stripTags(m[2]) || href, snippet: snipM ? stripTags(snipM[1]) : "" });
  }
  return found;
}
var duckduckgoBackend = async (ctx) => {
  const pages = Math.max(1, ctx.options.pages ?? 1);
  const kl = ddgRegion(ctx.options.lang, ctx.options.region);
  const acceptLanguage = acceptLanguageHeader(ctx.options.lang, ctx.options.region);
  const perPage = ctx.options.perSource * 2;
  const seen = /* @__PURE__ */ new Set();
  const found = [];
  for (let p = 0; p < pages; p++) {
    const url = `https://html.duckduckgo.com/html/?q=${encodeURIComponent(ctx.question)}&kl=${encodeURIComponent(kl)}` + (p > 0 ? `&s=${p * 30}` : "");
    const r = await httpGet(url, { accept: "text/html", acceptLanguage, timeoutMs: 12e3 });
    if (!r.ok || !r.body) {
      if (p === 0) {
        const why = r.status === 429 || r.status === 503 ? `rate-limited (HTTP ${r.status}) \u2014 consider your own WebSearch` : `unreachable (status ${r.status})`;
        return { backend: "duckduckgo", items: [], notes: [`DuckDuckGo ${why}.`] };
      }
      break;
    }
    const before = found.length;
    for (const f of parseDdgPage(r.body, perPage)) {
      const key = canonicalizeUrl(f.url);
      if (seen.has(key)) continue;
      seen.add(key);
      found.push(f);
    }
    if (found.length === before) break;
    if (p < pages - 1 && pageDelayMs()) await sleep(pageDelayMs());
  }
  const items = found.map((f, i) => ({
    url: f.url,
    title: f.title,
    backend: "duckduckgo",
    score: found.length - i,
    snippet: f.snippet.slice(0, 360),
    lang: ctx.options.lang
  }));
  return {
    backend: "duckduckgo",
    items,
    notes: items.length ? [`DuckDuckGo returned ${items.length} result(s).`] : [`DuckDuckGo returned no results.`]
  };
};

// src/backends/ddglite.ts
function parseLitePage(body, limit) {
  const found = [];
  const blockRe = /<a\b([^>]*\bresult-link\b[^>]*)>([\s\S]*?)<\/a>([\s\S]*?)(?=<a\b[^>]*\bresult-link\b|$)/gi;
  let m;
  while ((m = blockRe.exec(body)) && found.length < limit) {
    const href0 = /\bhref="([^"]+)"/.exec(m[1]);
    if (!href0) continue;
    const href = realUrl(href0[1]);
    if (!/^https?:\/\//.test(href) || /duckduckgo\.com/.test(href)) continue;
    const snipM = /class="result-snippet"[^>]*>([\s\S]*?)<\/td>/i.exec(m[3]);
    found.push({ url: href, title: stripTags(m[2]) || href, snippet: snipM ? stripTags(snipM[1]) : "" });
  }
  return found;
}
var ddgliteBackend = async (ctx) => {
  const pages = Math.max(1, ctx.options.pages ?? 1);
  const kl = ddgRegion(ctx.options.lang, ctx.options.region);
  const acceptLanguage = acceptLanguageHeader(ctx.options.lang, ctx.options.region);
  const perPage = ctx.options.perSource * 2;
  const seen = /* @__PURE__ */ new Set();
  const found = [];
  for (let p = 0; p < pages; p++) {
    const url = `https://lite.duckduckgo.com/lite/?q=${encodeURIComponent(ctx.question)}&kl=${encodeURIComponent(kl)}` + (p > 0 ? `&s=${p * 30}` : "");
    const r = await httpGet(url, { accept: "text/html", acceptLanguage, timeoutMs: 12e3 });
    if (!r.ok || !r.body) {
      if (p === 0) {
        const why = r.status === 429 || r.status === 503 ? `rate-limited (HTTP ${r.status})` : `unreachable (status ${r.status})`;
        return { backend: "ddglite", items: [], notes: [`DuckDuckGo Lite ${why}.`] };
      }
      break;
    }
    const before = found.length;
    for (const f of parseLitePage(r.body, perPage)) {
      const key = canonicalizeUrl(f.url);
      if (seen.has(key)) continue;
      seen.add(key);
      found.push(f);
    }
    if (found.length === before) break;
    if (p < pages - 1 && pageDelayMs()) await sleep(pageDelayMs());
  }
  const items = found.map((f, i) => ({
    url: f.url,
    title: f.title,
    backend: "ddglite",
    score: found.length - i,
    snippet: f.snippet.slice(0, 360),
    lang: ctx.options.lang
  }));
  return {
    backend: "ddglite",
    items,
    notes: items.length ? [`DuckDuckGo Lite returned ${items.length} result(s).`] : [`DuckDuckGo Lite returned no results.`]
  };
};

// src/backends/mojeek.ts
function parseMojeekPage(body, limit) {
  const found = [];
  const blockRe = /<a\b([^>]*\bclass="[^"]*\btitle\b[^"]*"[^>]*)>([\s\S]*?)<\/a>([\s\S]*?)(?=<a\b[^>]*\bclass="[^"]*\btitle\b|$)/gi;
  let m;
  while ((m = blockRe.exec(body)) && found.length < limit) {
    const href0 = /\bhref="([^"]+)"/.exec(m[1]);
    if (!href0) continue;
    let href = href0[1];
    if (href.startsWith("//")) href = "https:" + href;
    if (!/^https?:\/\//.test(href) || /mojeek\.com/.test(href)) continue;
    const snipM = /<p\b[^>]*\bclass="[^"]*\bs\b[^"]*"[^>]*>([\s\S]*?)<\/p>/i.exec(m[3]);
    found.push({ url: href, title: stripTags(m[2]) || href, snippet: snipM ? stripTags(snipM[1]) : "" });
  }
  return found;
}
var mojeekBackend = async (ctx) => {
  const pages = Math.max(1, ctx.options.pages ?? 1);
  const acceptLanguage = acceptLanguageHeader(ctx.options.lang, ctx.options.region);
  const perPage = ctx.options.perSource * 2;
  const seen = /* @__PURE__ */ new Set();
  const found = [];
  for (let p = 0; p < pages; p++) {
    const url = `https://www.mojeek.com/search?q=${encodeURIComponent(ctx.question)}` + (p > 0 ? `&s=${p * 10 + 1}` : "");
    const r = await httpGet(url, { accept: "text/html", acceptLanguage, timeoutMs: 12e3 });
    if (!r.ok || !r.body) {
      if (p === 0) {
        const why = r.status === 429 || r.status === 503 ? `rate-limited (HTTP ${r.status})` : `unreachable (status ${r.status})`;
        return { backend: "mojeek", items: [], notes: [`Mojeek ${why}.`] };
      }
      break;
    }
    const before = found.length;
    for (const f of parseMojeekPage(r.body, perPage)) {
      const key = canonicalizeUrl(f.url);
      if (seen.has(key)) continue;
      seen.add(key);
      found.push(f);
    }
    if (found.length === before) break;
    if (p < pages - 1 && pageDelayMs()) await sleep(pageDelayMs());
  }
  const items = found.map((f, i) => ({
    url: f.url,
    title: f.title,
    backend: "mojeek",
    score: found.length - i,
    snippet: f.snippet.slice(0, 360),
    lang: ctx.options.lang
  }));
  return {
    backend: "mojeek",
    items,
    notes: items.length ? [`Mojeek returned ${items.length} result(s).`] : [`Mojeek returned no results.`]
  };
};

// src/backends/marginalia.ts
var marginaliaBackend = async (ctx) => {
  const url = `https://api.marginalia-search.com/public/search/${encodeURIComponent(ctx.question)}?count=${ctx.options.perSource * 2}`;
  const acceptLanguage = acceptLanguageHeader(ctx.options.lang, ctx.options.region);
  const r = await httpJson("GET", url, void 0, { timeoutMs: 12e3, acceptLanguage });
  if (!r.ok) {
    const why = r.status === 429 || r.status === 503 ? `rate-limited (HTTP ${r.status})` : `unreachable (status ${r.status || 0})`;
    return { backend: "marginalia", items: [], notes: [`Marginalia ${why}.`] };
  }
  const results = Array.isArray(r.data?.results) ? r.data.results : [];
  const items = [];
  results.slice(0, ctx.options.perSource * 2).forEach((x, i) => {
    if (!x?.url || typeof x.url !== "string") return;
    items.push({
      url: x.url,
      title: String(x.title || x.url),
      // `||`: an empty title degrades to the URL, never blank
      backend: "marginalia",
      score: results.length - i,
      snippet: String(x.description ?? "").slice(0, 360),
      lang: ctx.options.lang
    });
  });
  return {
    backend: "marginalia",
    items,
    notes: items.length ? [`Marginalia returned ${items.length} result(s).`] : [`Marginalia returned no results.`]
  };
};

// src/backends/wikipedia.ts
var wikipediaBackend = async (ctx) => {
  const lang = (ctx.options.lang || "en").split("-")[0];
  const host = `https://${lang}.wikipedia.org`;
  const limit = Math.max(3, Math.min(10, ctx.options.perSource));
  const searchUrl = `${host}/w/rest.php/v1/search/page?q=${encodeURIComponent(ctx.question)}&limit=${limit}`;
  const sr = await httpJson("GET", searchUrl, void 0, { timeoutMs: 1e4 });
  if (!sr.ok || !Array.isArray(sr.data?.pages)) {
    return { backend: "wikipedia", items: [], notes: [`Wikipedia search failed (status ${sr.status}).`] };
  }
  const pages = sr.data.pages;
  const top = pages.slice(0, Math.min(limit, 6));
  let disambigSkipped = 0;
  const built = await mapLimit(top, 4, async (p, i) => {
    if (!p?.key) return null;
    const summaryUrl = `${host}/api/rest_v1/page/summary/${encodeURIComponent(p.key)}`;
    const dr = await httpJson("GET", summaryUrl, void 0, { timeoutMs: 1e4 });
    if (dr.data?.type === "disambiguation") {
      disambigSkipped++;
      return null;
    }
    const extract = dr.ok ? decodeEntities(String(dr.data?.extract ?? "")) : "";
    const pageUrl = dr.data?.content_urls?.desktop?.page ?? `${host}/wiki/${encodeURIComponent(p.key)}`;
    const descExcerpt = decodeEntities(String(p.excerpt ?? "").replace(/<[^>]+>/g, ""));
    const text = extract || descExcerpt;
    if (!text) return null;
    return {
      url: pageUrl,
      title: decodeEntities(String(p.title ?? p.key)),
      backend: "wikipedia",
      score: top.length - i,
      snippet: (descExcerpt || extract).slice(0, 360),
      text,
      lang
    };
  });
  const items = built.filter((x) => x !== null);
  const notes = items.length ? [`Wikipedia returned ${items.length} page(s).`] : [`Wikipedia returned no usable pages.`];
  if (disambigSkipped) notes.push(`Skipped ${disambigSkipped} disambiguation page(s).`);
  return { backend: "wikipedia", items, notes };
};

// src/backends/generic.ts
var genericBackend = async (ctx) => {
  const urls = ctx.options.urls ?? [];
  if (!urls.length) {
    return {
      backend: "generic",
      items: [],
      notes: ["generic backend needs --url <u,...>; nothing to fetch."]
    };
  }
  const items = [];
  const notes = [];
  for (let i = 0; i < urls.length; i++) {
    const url = urls[i];
    const { text, title, note, finalUrl } = await fetchAndExtract(url);
    if (note) notes.push(note);
    if (!text) continue;
    items.push({
      url: finalUrl || url,
      // record the post-redirect URL for provenance + exclude
      title: title || finalUrl || url,
      backend: "generic",
      score: urls.length - i,
      snippet: bestExcerpt(text, ctx.question),
      text
    });
  }
  return { backend: "generic", items, notes };
};

// src/backends/fixture.ts
var FIXTURE_SOURCES = [
  {
    url: "https://fixture.test/rate-limiting-overview",
    title: "Rate limiting \u2014 overview",
    backend: "fixture",
    score: 5,
    snippet: "Rate limiting controls how many requests a client may make in a window of time.",
    text: [
      "# Rate limiting",
      "Rate limiting controls how many requests a client may make to a service in a given window of time.",
      "It protects a backend from overload, abuse, and runaway costs, and keeps one noisy client from",
      "degrading service for everyone else.",
      "## Why it matters",
      "Without a rate limit, a single client (or a bug, or an attack) can exhaust a service's capacity.",
      "Limits are usually expressed as a number of requests per second, minute, or hour."
    ].join("\n")
  },
  {
    url: "https://fixture.test/rate-limiting-algorithms",
    title: "Rate limiting algorithms",
    backend: "fixture",
    score: 4,
    snippet: "Common algorithms include the token bucket, leaky bucket, fixed window, and sliding window.",
    text: [
      "# Algorithms",
      "## Token bucket",
      "A token bucket refills tokens at a steady rate; each request spends a token. Bursts are allowed",
      "up to the bucket size, which makes the token bucket the most common production choice.",
      "## Leaky bucket",
      "The leaky bucket drains queued requests at a constant rate, smoothing bursts into a steady stream.",
      "## Fixed and sliding windows",
      "Fixed window counts requests per discrete interval; sliding window smooths the boundary effect."
    ].join("\n")
  },
  {
    url: "https://fixture.test/rate-limiting-http-429",
    title: "HTTP 429 and Retry-After",
    backend: "fixture",
    score: 3,
    snippet: "A rate-limited request returns HTTP 429 Too Many Requests, often with a Retry-After header.",
    text: [
      "# Signalling a rate limit over HTTP",
      "When a client exceeds the limit, the server responds with HTTP status 429 Too Many Requests.",
      "A Retry-After header tells the client how long to wait before retrying.",
      "Well-behaved clients back off exponentially when they see a 429."
    ].join("\n")
  }
];
var fixtureBackend = async () => {
  return {
    backend: "fixture",
    items: FIXTURE_SOURCES.map((s) => ({ ...s })),
    notes: ["fixture backend: offline canned sources (testing only)."]
  };
};

// src/backends/stackexchange.ts
var SITES = ["stackoverflow", "serverfault", "superuser", "askubuntu", "unix.stackexchange"];
async function searchSite(site, q, perSite, fromdate) {
  const url = `https://api.stackexchange.com/2.3/search/advanced?order=desc&sort=relevance&q=${encodeURIComponent(q)}&site=${encodeURIComponent(site)}&filter=withbody&pagesize=${perSite}` + (fromdate ? `&fromdate=${fromdate}` : "");
  const r = await httpJson("GET", url, void 0, { timeoutMs: 1e4 });
  if (!r.ok || !Array.isArray(r.data?.items)) return { items: [] };
  const label = site === "stackoverflow" ? "" : `${site.replace(/\.stackexchange$/, "")}: `;
  const items = r.data.items.map((it, i) => {
    const title = decodeEntities(String(it.title ?? "question"));
    const body = htmlToText(String(it.body ?? ""));
    return {
      url: String(it.link ?? `https://${site}.com/q/${it.question_id}`),
      title: `${label}${title}`,
      backend: "stackexchange",
      score: (it.score ?? 0) + (it.is_answered ? 2 : 0) + (perSite - i) * 0.1,
      snippet: body.slice(0, 360),
      text: `${title}

${body}`,
      meta: { answerScore: Number(it.score ?? 0) }
    };
  });
  return { items, backoff: r.data.backoff, remaining: r.data.quota_remaining };
}
var stackexchangeBackend = async (ctx) => {
  const q = rankedKeywords(ctx.question).slice(0, 6).join(" ") || ctx.question;
  const n = Math.max(3, Math.min(10, ctx.options.perSource));
  const perSite = Math.max(2, Math.ceil(n / 2));
  const fromdate = sinceEpochSeconds(ctx.options.since);
  const perSiteResults = await Promise.all(SITES.map((s) => searchSite(s, q, perSite, fromdate)));
  const items = perSiteResults.flatMap((r) => r.items).sort((a, b) => b.score - a.score);
  const notes = [];
  const backoff = perSiteResults.find((r) => r.backoff)?.backoff;
  if (backoff) notes.push(`StackExchange asked to back off ${backoff}s on one site.`);
  const remaining = perSiteResults.map((r) => r.remaining).filter((x) => typeof x === "number");
  if (remaining.length && Math.min(...remaining) < 20) notes.push(`StackExchange anon quota low (${Math.min(...remaining)} left).`);
  notes.push(items.length ? `StackExchange returned ${items.length} question(s) across ${SITES.length} sites.` : "StackExchange returned no results.");
  return { backend: "stackexchange", items, notes };
};

// src/backends/hackernews.ts
var hackernewsBackend = async (ctx) => {
  const n = Math.max(3, Math.min(15, ctx.options.perSource));
  const since = sinceEpochSeconds(ctx.options.since);
  const url = `https://hn.algolia.com/api/v1/search?query=${encodeURIComponent(ctx.question)}&tags=story&hitsPerPage=${n}` + (since ? `&numericFilters=created_at_i>${since}` : "");
  const r = await httpJson("GET", url, void 0, { timeoutMs: 1e4 });
  if (!r.ok || !Array.isArray(r.data?.hits)) {
    return { backend: "hackernews", items: [], notes: [`Hacker News search failed (status ${r.status}).`] };
  }
  const items = r.data.hits.slice(0, n).map((h, i) => {
    const title = String(h.title ?? h.story_title ?? "HN story");
    const discussion = h.objectID ? `https://news.ycombinator.com/item?id=${h.objectID}` : void 0;
    const storyText = h.story_text ? htmlToText(String(h.story_text)) : "";
    return {
      url: h.url ? String(h.url) : discussion ?? "https://news.ycombinator.com/",
      title,
      backend: "hackernews",
      score: n - i,
      snippet: (storyText || title).slice(0, 360),
      text: `${title}

${storyText}${discussion ? `
HN discussion: ${discussion}` : ""}`,
      meta: { points: Number(h.points ?? 0) }
    };
  });
  return {
    backend: "hackernews",
    items,
    notes: items.length ? [`Hacker News returned ${items.length} story(ies).`] : ["Hacker News returned no results."]
  };
};

// src/backends/github.ts
var githubBackend = async (ctx) => {
  const since = sinceDate(ctx.options.since);
  const q = (rankedKeywords(ctx.question).slice(0, 6).join(" ") || ctx.question) + (since ? ` created:>=${since}` : "");
  const n = Math.max(3, Math.min(10, ctx.options.perSource));
  const url = `https://api.github.com/search/issues?q=${encodeURIComponent(q)}&per_page=${n}`;
  const r = await httpJson("GET", url, void 0, { timeoutMs: 1e4, accept: "application/vnd.github+json" });
  if (!r.ok || !Array.isArray(r.data?.items)) {
    const msg = r.data?.message ? ` \u2014 ${r.data.message}` : "";
    return { backend: "github", items: [], notes: [`GitHub search failed (status ${r.status})${msg}.`] };
  }
  const items = r.data.items.slice(0, n).map((it, i) => {
    const body = htmlToText(String(it.body ?? ""));
    const repo = String(it.repository_url ?? "").replace("https://api.github.com/repos/", "");
    const issueTitle = String(it.title ?? "Untitled");
    return {
      // Guard a missing html_url so it never renders as the string "undefined".
      url: it.html_url ? String(it.html_url) : "",
      title: `${it.pull_request ? "PR" : "Issue"}: ${issueTitle}${repo ? ` (${repo})` : ""}`,
      backend: "github",
      score: n - i,
      snippet: (body || issueTitle).slice(0, 360),
      text: `${issueTitle}
state: ${it.state} \xB7 comments: ${it.comments}

${body}`,
      meta: {}
    };
  });
  return {
    backend: "github",
    items,
    notes: items.length ? [`GitHub returned ${items.length} issue/PR(s).`] : ["GitHub returned no results."]
  };
};

// src/backends/arxiv.ts
function tag(block, name) {
  const m = new RegExp(`<${name}[^>]*>([\\s\\S]*?)<\\/${name}>`, "i").exec(block);
  return m ? decodeEntities(m[1].replace(/\s+/g, " ").trim()) : "";
}
var arxivBackend = async (ctx) => {
  const n = Math.max(3, Math.min(15, ctx.options.perSource));
  const url = `http://export.arxiv.org/api/query?search_query=${encodeURIComponent("all:" + ctx.question)}&start=0&max_results=${n}`;
  const r = await httpGet(url, { accept: "application/atom+xml", timeoutMs: 12e3, userAgent: contactUa() });
  if (!r.ok || !r.body) {
    const why = r.status === 429 || r.status === 503 ? `rate-limited (HTTP ${r.status})` : `failed (status ${r.status})`;
    return { backend: "arxiv", items: [], notes: [`arXiv search ${why}.`] };
  }
  const entries = r.body.split(/<entry>/).slice(1);
  const items = entries.slice(0, n).map((block, i) => {
    const idUrl = tag(block, "id");
    const arxivId = /abs\/([^v<]+)/.exec(idUrl)?.[1] ?? idUrl;
    const authors = [...block.matchAll(/<name>([\s\S]*?)<\/name>/gi)].map((m) => decodeEntities(m[1].trim()));
    const year = Number(/<published>(\d{4})/.exec(block)?.[1] ?? 0) || void 0;
    const title = tag(block, "title");
    const summary = tag(block, "summary");
    const absUrl = idUrl || `https://arxiv.org/abs/${arxivId}`;
    const htmlUrl = `https://arxiv.org/html/${arxivId}`;
    return {
      // Point at the HTML full text so the gatherer hydrates the whole paper,
      // not just the abstract. No `text` here → hydration fetches htmlUrl; if
      // that paper has no HTML rendering, the fetch falls back to the abstract
      // snippet (gather sets text = snippet when a fetch yields nothing).
      url: htmlUrl,
      title,
      backend: "arxiv",
      score: n - i,
      snippet: summary.slice(0, 360),
      meta: { arxivId, authors, year, htmlUrl, absUrl }
    };
  });
  return {
    backend: "arxiv",
    items,
    notes: items.length ? [`arXiv returned ${items.length} paper(s).`] : ["arXiv returned no results."]
  };
};

// src/backends/crossref.ts
var crossrefBackend = async (ctx) => {
  const n = Math.max(3, Math.min(15, ctx.options.perSource));
  const since = sinceDate(ctx.options.since);
  const url = `https://api.crossref.org/works?query=${encodeURIComponent(ctx.question)}&rows=${n}` + (since ? `&filter=from-pub-date:${since}` : "");
  const r = await httpJson("GET", url, void 0, { timeoutMs: 12e3, userAgent: contactUa() });
  const items0 = r.ok && Array.isArray(r.data?.message?.items) ? r.data.message.items : [];
  if (!r.ok || !items0.length) {
    return { backend: "crossref", items: [], notes: [`Crossref search failed or empty (status ${r.status}).`] };
  }
  const items = items0.slice(0, n).map((w, i) => {
    const title = cleanInline(Array.isArray(w.title) ? w.title.join(" ") : String(w.title ?? "Untitled")) || "Untitled";
    const abstract = w.abstract ? htmlToText(String(w.abstract)) : "";
    const authors = Array.isArray(w.author) ? w.author.map((a) => [a.given, a.family].filter(Boolean).join(" ") || String(a.name ?? "")).filter(Boolean) : [];
    const year = w.issued?.["date-parts"]?.[0]?.[0] ?? void 0;
    const venue = cleanInline(Array.isArray(w["container-title"]) ? String(w["container-title"][0] ?? "") : "") || void 0;
    return {
      url: String(w.URL ?? (w.DOI ? `https://doi.org/${w.DOI}` : "")),
      title,
      backend: "crossref",
      score: n - i,
      snippet: (abstract || `${title} \u2014 ${venue ?? ""} ${year ?? ""}`).slice(0, 360),
      text: `${title}

${abstract || "(no abstract provided by Crossref)"}`,
      meta: { doi: w.DOI, authors, year, venue }
    };
  });
  return {
    backend: "crossref",
    items,
    notes: [`Crossref returned ${items.length} work(s).`]
  };
};

// src/backends/openalex.ts
function fromInverted(idx) {
  if (!idx) return "";
  const words = [];
  for (const [w, positions] of Object.entries(idx)) for (const p of positions) words[p] = w;
  return words.filter(Boolean).join(" ");
}
var openalexBackend = async (ctx) => {
  const n = Math.max(3, Math.min(15, ctx.options.perSource));
  const since = sinceDate(ctx.options.since);
  const url = `https://api.openalex.org/works?search=${encodeURIComponent(ctx.question)}&per_page=${n}` + (since ? `&filter=from_publication_date:${since}` : "");
  const r = await httpJson("GET", url, void 0, { timeoutMs: 12e3 });
  const results = r.ok && Array.isArray(r.data?.results) ? r.data.results : [];
  if (!r.ok || !results.length) {
    return { backend: "openalex", items: [], notes: [`OpenAlex search failed or empty (status ${r.status}).`] };
  }
  const items = results.slice(0, n).map((w, i) => {
    const title = cleanInline(String(w.title ?? w.display_name ?? "Untitled")) || "Untitled";
    const abstract = fromInverted(w.abstract_inverted_index);
    const authors = Array.isArray(w.authorships) ? w.authorships.map((a) => a?.author?.display_name).filter(Boolean) : [];
    const year = w.publication_year || void 0;
    const venue = w.primary_location?.source?.display_name;
    const doi = typeof w.doi === "string" ? w.doi.replace(/^https?:\/\/doi\.org\//, "") : void 0;
    const url2 = w.primary_location?.landing_page_url || (doi ? `https://doi.org/${doi}` : w.id);
    return {
      url: String(url2),
      title,
      backend: "openalex",
      score: n - i,
      snippet: (abstract || `${title} \u2014 ${venue ?? ""} ${year ?? ""}`).slice(0, 360),
      text: `${title}

${abstract || "(no abstract provided by OpenAlex)"}`,
      meta: { doi, authors, year, venue }
    };
  });
  return { backend: "openalex", items, notes: [`OpenAlex returned ${items.length} work(s).`] };
};

// src/backends/semanticscholar.ts
var semanticscholarBackend = async (ctx) => {
  const n = Math.max(3, Math.min(15, ctx.options.perSource));
  const fields = "title,abstract,url,year,authors,externalIds,venue";
  const url = `https://api.semanticscholar.org/graph/v1/paper/search?query=${encodeURIComponent(ctx.question)}&limit=${n}&fields=${fields}`;
  const r = await httpJson("GET", url, void 0, { timeoutMs: 12e3 });
  const data = r.ok && Array.isArray(r.data?.data) ? r.data.data : [];
  if (!r.ok || !data.length) {
    return { backend: "semanticscholar", items: [], notes: [`Semantic Scholar search failed or empty (status ${r.status}).`] };
  }
  const items = data.slice(0, n).map((p, i) => {
    const title = cleanInline(String(p.title ?? "Untitled")) || "Untitled";
    const abstract = String(p.abstract ?? "");
    const authors = Array.isArray(p.authors) ? p.authors.map((a) => a?.name).filter(Boolean) : [];
    const year = p.year || void 0;
    const doi = p.externalIds?.DOI;
    const arxivId = p.externalIds?.ArXiv;
    return {
      // `||` guards both a missing and an empty-string url; fall back to the DOI,
      // then the arXiv abstract, before giving up on a link.
      url: String(p.url || (doi ? `https://doi.org/${doi}` : arxivId ? `https://arxiv.org/abs/${arxivId}` : "")),
      title,
      backend: "semanticscholar",
      score: n - i,
      snippet: (abstract || `${title} \u2014 ${p.venue ?? ""} ${year ?? ""}`).slice(0, 360),
      text: `${title}

${abstract || "(no abstract provided by Semantic Scholar)"}`,
      meta: { doi, arxivId, authors, year, venue: p.venue }
    };
  });
  return { backend: "semanticscholar", items, notes: [`Semantic Scholar returned ${items.length} paper(s).`] };
};

// src/backends/europepmc.ts
var europepmcBackend = async (ctx) => {
  const n = Math.max(3, Math.min(15, ctx.options.perSource));
  const url = `https://www.ebi.ac.uk/europepmc/webservices/rest/search?query=${encodeURIComponent(ctx.question)}&format=json&resultType=core&pageSize=${n}`;
  const r = await httpJson("GET", url, void 0, { timeoutMs: 12e3 });
  const results = r.ok && Array.isArray(r.data?.resultList?.result) ? r.data.resultList.result : [];
  if (!r.ok || !results.length) {
    const why = r.status === 429 || r.status === 503 ? `rate-limited (HTTP ${r.status})` : `failed or empty (status ${r.status})`;
    return { backend: "europepmc", items: [], notes: [`Europe PMC search ${why}.`] };
  }
  const items = results.slice(0, n).map((w, i) => {
    const title = cleanInline(String(w.title ?? "Untitled")).replace(/\.$/, "") || "Untitled";
    const abstract = decodeEntities(String(w.abstractText ?? "")).replace(/<[^>]+>/g, "");
    const authors = w.authorString ? String(w.authorString).split(/,\s*/).filter(Boolean) : [];
    const year = w.pubYear ? Number(w.pubYear) : void 0;
    const venue = cleanInline(String(w.journalInfo?.journal?.title ?? w.journalTitle ?? "")) || void 0;
    const doi = w.doi;
    const link = doi ? `https://doi.org/${doi}` : w.source && w.id ? `https://europepmc.org/article/${w.source}/${w.id}` : "";
    return {
      url: link,
      title,
      backend: "europepmc",
      score: n - i,
      snippet: (abstract || `${title} \u2014 ${venue ?? ""} ${year ?? ""}`).slice(0, 360),
      text: `${title}

${abstract || "(no abstract provided by Europe PMC)"}`,
      meta: { doi, authors, year, venue }
    };
  });
  return { backend: "europepmc", items, notes: [`Europe PMC returned ${items.length} record(s).`] };
};

// src/backends/pubmed.ts
var pubmedBackend = async (ctx) => {
  const n = Math.max(3, Math.min(15, ctx.options.perSource));
  const base = "https://eutils.ncbi.nlm.nih.gov/entrez/eutils";
  const esearch = `${base}/esearch.fcgi?db=pubmed&retmode=json&retmax=${n}&tool=ultrasearch&term=${encodeURIComponent(ctx.question)}`;
  const sr = await httpJson("GET", esearch, void 0, { timeoutMs: 12e3 });
  const ids = sr.ok && Array.isArray(sr.data?.esearchresult?.idlist) ? sr.data.esearchresult.idlist : [];
  if (!sr.ok || !ids.length) {
    const why = sr.status === 429 || sr.status === 503 ? `rate-limited (HTTP ${sr.status})` : `failed or empty (status ${sr.status})`;
    return { backend: "pubmed", items: [], notes: [`PubMed esearch ${why}.`] };
  }
  const esummary = `${base}/esummary.fcgi?db=pubmed&retmode=json&tool=ultrasearch&id=${ids.join(",")}`;
  const dr = await httpJson("GET", esummary, void 0, { timeoutMs: 12e3 });
  const result = dr.ok ? dr.data?.result : void 0;
  if (!result) {
    return { backend: "pubmed", items: [], notes: [`PubMed esummary failed (status ${dr.status}).`] };
  }
  const items = ids.slice(0, n).map((uid, i) => {
    const d = result[uid] ?? {};
    const title = cleanInline(String(d.title ?? "Untitled")).replace(/\.$/, "") || "Untitled";
    const articleIds = Array.isArray(d.articleids) ? d.articleids : [];
    const doi = articleIds.find((a) => a?.idtype === "doi")?.value;
    const year = d.pubdate ? Number(String(d.pubdate).slice(0, 4)) || void 0 : void 0;
    const authors = Array.isArray(d.authors) ? d.authors.map((a) => a?.name).filter(Boolean) : [];
    const link = doi ? `https://doi.org/${doi}` : `https://pubmed.ncbi.nlm.nih.gov/${uid}/`;
    return {
      url: link,
      title,
      backend: "pubmed",
      score: ids.length - i,
      snippet: `${title} \u2014 ${d.source ?? ""} ${year ?? ""}`.trim().slice(0, 360),
      // no text → the gatherer hydrates the landing page for the abstract.
      // `absUrl` gives it somewhere to go when the DOI resolves to a paywalled
      // publisher page; from there the provider table finds the E-utilities
      // abstract if PubMed's own HTML is throttling.
      meta: { doi, authors, year, venue: d.source, ...doi ? { absUrl: `https://pubmed.ncbi.nlm.nih.gov/${uid}/` } : {} }
    };
  });
  return { backend: "pubmed", items, notes: [`PubMed returned ${items.length} record(s).`] };
};

// src/backends/dblp.ts
function authorNames(authors) {
  const a = authors?.author;
  const list = Array.isArray(a) ? a : a ? [a] : [];
  return list.map((x) => cleanInline(String(x?.text ?? x ?? ""))).filter(Boolean);
}
function firstStr(v) {
  if (Array.isArray(v)) return v.find((x) => typeof x === "string" && x.length > 0);
  return typeof v === "string" && v.length > 0 ? v : void 0;
}
var dblpBackend = async (ctx) => {
  const n = Math.max(3, Math.min(15, ctx.options.perSource));
  const url = `https://dblp.org/search/publ/api?q=${encodeURIComponent(ctx.question)}&format=json&h=${n}`;
  const r = await httpJson("GET", url, void 0, { timeoutMs: 12e3 });
  const hitRaw = r.data?.result?.hits?.hit;
  const hits = r.ok ? Array.isArray(hitRaw) ? hitRaw : hitRaw ? [hitRaw] : [] : [];
  if (!r.ok || !hits.length) {
    return { backend: "dblp", items: [], notes: [`dblp search failed or empty (status ${r.status}).`] };
  }
  const items = hits.slice(0, n).map((h, i) => {
    const info = h.info ?? {};
    const title = cleanInline(String(info.title ?? "Untitled")).replace(/\.$/, "") || "Untitled";
    const authors = authorNames(info.authors);
    const year = Number(info.year) || void 0;
    const venue = cleanInline(String(info.venue ?? "")) || void 0;
    const doi = firstStr(info.doi);
    const ee = firstStr(info.ee);
    const recUrl = firstStr(info.url) ?? "";
    const url2 = ee || (doi ? `https://doi.org/${doi}` : recUrl);
    const meta = { doi, authors, year, venue };
    const desc = [venue, year].filter(Boolean).join(" \xB7 ");
    return {
      url: url2,
      title,
      backend: "dblp",
      score: n - i,
      snippet: `${title}${desc ? " \u2014 " + desc : ""}${authors.length ? " \xB7 " + authors.slice(0, 4).join(", ") : ""}`.slice(0, 360),
      text: `${title}

${authors.join(", ")}
${desc}`,
      meta
    };
  });
  return {
    backend: "dblp",
    items,
    notes: [`dblp returned ${items.length} publication(s).`]
  };
};

// src/backends/standards.ts
var DATATRACKER = "https://datatracker.ietf.org/api/v1/doc/document/";
var MDN = "https://developer.mozilla.org/api/v1/search";
async function rfcByNumber(n) {
  const r = await httpJson("GET", `${DATATRACKER}?format=json&name=rfc${n}`, void 0, { timeoutMs: 1e4 });
  const o = Array.isArray(r.data?.objects) ? r.data.objects[0] : void 0;
  if (!o?.rfc_number) return null;
  return rfcSource(o, 100);
}
function rfcSource(o, score) {
  const n = Number(o.rfc_number);
  const title = String(o.title ?? `RFC ${n}`);
  const abstract = String(o.abstract ?? "").trim();
  return {
    url: `https://www.rfc-editor.org/rfc/rfc${n}`,
    title: `RFC ${n}: ${title}`,
    backend: "standards",
    score,
    snippet: abstract.slice(0, 360) || title,
    ...abstract ? { text: `${title}

${abstract}` } : {},
    meta: { rfcNumber: n }
  };
}
var standardsBackend = async (ctx) => {
  const items = [];
  const notes = [];
  const seen = /* @__PURE__ */ new Set();
  const add = (s) => {
    if (s && !seen.has(s.url)) {
      seen.add(s.url);
      items.push(s);
    }
  };
  const perSource = Math.max(3, Math.min(8, ctx.options.perSource));
  const qTerms = new Set(keywords(ctx.question));
  const rfcNums = [...new Set([...ctx.question.matchAll(/\bRFC[-\s]?(\d{3,5})\b/gi)].map((m) => Number(m[1])))].slice(0, 3);
  const bigram = rankedKeywords(ctx.question).slice(0, 2).join(" ");
  const [rfcHits, mdnResult, titleResult] = await Promise.all([
    Promise.all(rfcNums.map((n) => rfcByNumber(n))),
    // 2. MDN search (discovery — url + summary, gather hydrates).
    httpJson("GET", `${MDN}?q=${encodeURIComponent(ctx.question)}&locale=en-US`, void 0, { timeoutMs: 1e4 }),
    // 3. Datatracker keyword title search (kept only when rfc_number is set and
    //    a query term actually appears — kills the "RFC 2429 shares digits" class).
    bigram ? httpJson("GET", `${DATATRACKER}?format=json&title__icontains=${encodeURIComponent(bigram)}&limit=10`, void 0, { timeoutMs: 1e4 }) : Promise.resolve({ ok: false, status: 0, data: void 0 })
  ]);
  for (const s of rfcHits) add(s);
  const mdnDocs = Array.isArray(mdnResult.data?.documents) ? mdnResult.data.documents : [];
  for (let i = 0; i < Math.min(perSource, mdnDocs.length, 5); i++) {
    const d = mdnDocs[i];
    if (!d?.mdn_url) continue;
    add({
      url: `https://developer.mozilla.org${d.mdn_url}`,
      title: String(d.title ?? d.mdn_url),
      backend: "standards",
      score: 50 - i,
      snippet: String(d.summary ?? "").slice(0, 360)
    });
  }
  const titleObjs = Array.isArray(titleResult.data?.objects) ? titleResult.data.objects : [];
  let kept = 0;
  for (const o of titleObjs) {
    if (kept >= 5) break;
    if (!o?.rfc_number) continue;
    const hay = keywords(`${o.title ?? ""} ${o.abstract ?? ""}`);
    if (![...qTerms].some((t) => hay.includes(t))) continue;
    add(rfcSource(o, 40 - kept));
    kept++;
  }
  const apiDown = !mdnResult.ok && !titleResult.ok && rfcHits.every((x) => x === null);
  if (apiDown) notes.push("Standards backends (IETF datatracker + MDN) were unreachable.");
  notes.push(items.length ? `Standards backend returned ${items.length} spec(s).` : "Standards backend found no matching specs.");
  return { backend: "standards", items, notes };
};

// src/backends/registry.ts
var HANDLERS = {
  claude: websearchBackend,
  searxng: searxngBackend,
  firecrawl: firecrawlBackend,
  duckduckgo: duckduckgoBackend,
  ddglite: ddgliteBackend,
  mojeek: mojeekBackend,
  marginalia: marginaliaBackend,
  wikipedia: wikipediaBackend,
  generic: genericBackend,
  fixture: fixtureBackend,
  stackexchange: stackexchangeBackend,
  hackernews: hackernewsBackend,
  github: githubBackend,
  arxiv: arxivBackend,
  crossref: crossrefBackend,
  openalex: openalexBackend,
  semanticscholar: semanticscholarBackend,
  europepmc: europepmcBackend,
  pubmed: pubmedBackend,
  dblp: dblpBackend,
  standards: standardsBackend
};
var SINGLE_QUERY = /* @__PURE__ */ new Set(["github", "stackexchange", "semanticscholar", "pubmed", "standards", "fixture", "generic", "claude"]);
var POLITE_SEQUENTIAL = /* @__PURE__ */ new Set(["arxiv", "crossref", "openalex", "europepmc", "dblp"]);
async function fanOutVariants(handler, ctx, variants, polite) {
  if (!polite) return Promise.all(variants.map((q) => handler({ ...ctx, question: q })));
  const out = [];
  for (let i = 0; i < variants.length; i++) {
    if (i > 0 && politeDelayMs()) await sleep(politeDelayMs());
    out.push(await handler({ ...ctx, question: variants[i] }));
  }
  return out;
}
function mergeVariants(backend, lists, notes) {
  const ranked = lists.map((l) => [...l].sort((a, b) => b.score - a.score));
  const fused = rrf(ranked, (it) => canonicalizeUrl(it.url));
  const best = /* @__PURE__ */ new Map();
  for (const list of ranked) {
    for (const it of list) {
      const key = canonicalizeUrl(it.url);
      const prev = best.get(key);
      if (!prev) best.set(key, { ...it });
      else if (!prev.text && it.text) best.set(key, { ...it, meta: { ...prev.meta, ...it.meta } });
      else if (it.meta) prev.meta = { ...it.meta, ...prev.meta };
    }
  }
  const items = [...best.values()];
  for (const it of items) it.score = fused.get(canonicalizeUrl(it.url)) ?? 0;
  items.sort((a, b) => b.score - a.score || a.url.localeCompare(b.url));
  return { backend, items, notes: [...new Set(notes)] };
}
async function runBackends(kinds, ctx) {
  const variants = ctx.variants.length ? ctx.variants : [ctx.question];
  const tasks = kinds.map(async (kind) => {
    const handler = HANDLERS[kind];
    if (!handler) {
      return { backend: kind, items: [], notes: [`No handler for backend "${kind}".`], ms: 0 };
    }
    const t0 = Date.now();
    try {
      if (SINGLE_QUERY.has(kind) || variants.length <= 1) {
        const res = await handler(ctx);
        return { ...res, ms: Date.now() - t0 };
      }
      const perVariant = await fanOutVariants(handler, ctx, variants, POLITE_SEQUENTIAL.has(kind));
      const merged = mergeVariants(
        kind,
        perVariant.map((r) => r.items),
        perVariant.flatMap((r) => r.notes)
      );
      return { ...merged, ms: Date.now() - t0 };
    } catch (e) {
      return { backend: kind, items: [], notes: [`${kind} backend failed: ${e.message}`], ms: Date.now() - t0 };
    }
  });
  return Promise.all(tasks);
}

// src/dossier.ts
import { existsSync as existsSync5, readFileSync as readFileSync5 } from "fs";
import { join as join5 } from "path";

// src/authority.ts
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
function sourceSignals(opts) {
  const hosts = externalHosts(opts.url, opts.text);
  const selfIdentified = urlDeclaresIdentity(opts.url) || !!deriveCitableUrl(opts.text.slice(0, 4e3));
  const corroboration = opts.corroboration ?? 1;
  const notes = [
    `cites ${hosts.size} external source(s) \xB7 surfaced by ${corroboration} engine(s) \xB7 ${selfIdentified ? "declares a persistent identity (DOI/arXiv/canonical)" : "declares no persistent identity"}`
  ];
  return { refDiversity: hosts.size, selfIdentified, corroboration, notes };
}

// src/bibtex.ts
function clean(s) {
  return s.replace(/[{}]/g, "").replace(/\s+/g, " ").trim();
}
function bibKey(s, used) {
  const last = s.meta?.authors?.[0]?.split(/\s+/).pop()?.toLowerCase().replace(/[^a-z0-9]/g, "");
  const year = s.meta?.year ? String(s.meta.year) : "";
  const word = s.title.split(/\s+/).find((w) => w.replace(/[^a-z0-9]/gi, "").length > 3)?.toLowerCase().replace(/[^a-z0-9]/g, "");
  const base = `${last ?? s.id.toLowerCase()}${year}${word ?? ""}` || s.id.toLowerCase();
  let key = base;
  let n = 2;
  while (used.has(key)) key = `${base}${n++}`;
  used.add(key);
  return key;
}
function toBibtex(sources) {
  const scholarly = sources.filter((s) => s.meta && (s.meta.doi || s.meta.arxivId || s.meta.authors?.length || s.meta.year));
  if (!scholarly.length) {
    return "% No scholarly sources with citable metadata in this dossier.\n";
  }
  const used = /* @__PURE__ */ new Set();
  const out = ["% Generated by ultrasearch \u2014 research mode", ""];
  for (const s of scholarly) {
    const key = bibKey(s, used);
    const fields = [`  title = {${clean(s.title)}}`];
    if (s.meta?.authors?.length) fields.push(`  author = {${s.meta.authors.map(clean).join(" and ")}}`);
    if (s.meta?.year) fields.push(`  year = {${s.meta.year}}`);
    if (s.meta?.venue) fields.push(`  journal = {${clean(String(s.meta.venue))}}`);
    if (s.meta?.doi) fields.push(`  doi = {${clean(String(s.meta.doi))}}`);
    if (s.meta?.arxivId) {
      fields.push(`  eprint = {${clean(String(s.meta.arxivId))}}`);
      fields.push(`  archivePrefix = {arXiv}`);
    }
    if (s.url) fields.push(`  url = {${s.url}}`);
    fields.push(`  note = {ultrasearch source ${s.id}}`);
    out.push(`@article{${key},`);
    out.push(fields.join(",\n"));
    out.push(`}`);
    out.push("");
  }
  return out.join("\n");
}

// src/dossier.ts
var CITATION_RULES = [
  "**Cite every factual claim** with the id of the source it rests on, e.g. `[S1]`",
  "(multiple sources: `[S1][S4]`). The ids are listed below and in `sources.json`.",
  "",
  "If you state something from your **own background knowledge** that no fetched",
  "source backs, you must FLAG it as unverified \u2014 either end the sentence with",
  "`[M]`, or put the passage in a `> [model-hint] \u2026` blockquote. `ultrasearch check`",
  "tolerates flagged hints but FAILS on any *unmarked* unsourced claim, and on any",
  "`[S#]` that does not resolve to a real source."
].join("\n");
var CITATION_RULES_NO_WRITE = [
  "**Cite every factual claim** with the id of the source it rests on, e.g. `[S1]`",
  "(multiple sources: `[S1][S4]`). The ids are listed below, and each source's full",
  "extract is streamed after this brief.",
  "",
  "If you state something from your **own background knowledge** that no fetched",
  "source backs, you must FLAG it as unverified \u2014 either end the sentence with",
  "`[M]`, or put the passage in a `> [model-hint] \u2026` blockquote.",
  "",
  "**Nothing was written, so `ultrasearch check` cannot run here.** The mechanical",
  "gate that normally catches a dangling `[S#]` or an unsourced sentence is absent:",
  "the discipline is entirely yours. Never state anything the extracts do not say."
].join("\n");
function readJson(path, what) {
  let raw;
  try {
    raw = readFileSync5(path, "utf8");
  } catch (e) {
    throw new Error(`${what} could not be read (${path}): ${e.message}`);
  }
  try {
    return JSON.parse(raw);
  } catch (e) {
    throw new Error(`${what} is not valid JSON (${path}): ${e.message}`);
  }
}
function idNum(id) {
  const m = /^S(\d+)$/.exec(id);
  return m ? Number(m[1]) : 0;
}
function nextSourceId(sources) {
  const max = sources.reduce((acc, s) => Math.max(acc, idNum(s.id)), 0);
  return `S${max + 1}`;
}
function buildSource(rs, id, builtAt, question) {
  const text = rs.text ?? rs.snippet ?? "";
  const trust = trustScore(rs.url, rs.backend);
  const signals = sourceSignals({
    url: rs.url,
    text,
    corroboration: typeof rs.meta?.foundBy === "number" ? rs.meta.foundBy : 1
  }).notes;
  return {
    id,
    url: rs.url,
    canonicalUrl: canonicalizeUrl(rs.url),
    title: rs.title || rs.url,
    backend: rs.backend,
    fetchedAt: builtAt,
    lang: rs.lang,
    domain: domainOf(rs.url),
    trust,
    ...signals.length ? { signals } : {},
    score: Number(rs.score.toFixed(4)),
    extract: `sources/${id}.md`,
    // A richer multi-sentence digest snippet when we have full text; a backend's
    // own snippet (already short) is used as-is. Capped modestly for the digest.
    snippet: (rs.snippet || focusedSnippet(text, question, { maxChars: 480, maxSentences: 3 })).slice(0, 480),
    meta: rs.meta,
    // Only record the flag when we positively know the page fetch failed; absent
    // (the common case, incl. enrich/search callers) means full text on file.
    ...rs.fullText === false ? { fullText: false } : {}
  };
}
function renderSourceExtract(s, text, depth) {
  const head = [
    `# ${s.id} \u2014 ${s.title}`,
    `- url: ${s.url}`,
    `- backend: ${s.backend} \xB7 fetched: ${s.fetchedAt} \xB7 trust: ${s.trust} \xB7 score: ${s.score}`,
    ""
  ].join("\n");
  return head + capExtract(text, depth) + "\n";
}
function readSourceText(dir, s) {
  const p = join5(dir, s.extract);
  if (!existsSync5(p)) return s.snippet ?? "";
  const lines = readFileSync5(p, "utf8").split("\n");
  const hasHeader = lines.length >= 3 && lines[0].startsWith("# ") && lines[1].startsWith("- url:") && lines[2].startsWith("- backend:");
  const body = (hasHeader ? lines.slice(3) : lines).join("\n").trim();
  return body || s.snippet || "";
}
function writeSourceExtract(dir, s, text, depth) {
  writeArtifact(join5(dir, s.extract), renderSourceExtract(s, text, depth));
}
function writeDossierIndex(dir, sources, manifest, template) {
  const sourcesJson = join5(dir, "sources.json");
  const dossierMd = join5(dir, "DOSSIER.md");
  const manifestJson = join5(dir, "manifest.json");
  writeArtifact(sourcesJson, JSON.stringify(sources, null, 2));
  writeArtifact(manifestJson, JSON.stringify(manifest, null, 2));
  writeArtifact(dossierMd, renderDossierMarkdown(sources, manifest, template));
  return { dir, sourcesJson, dossierMd, manifestJson };
}
function writeBibtex(dir, sources, extras) {
  if (!extras.includes("bibtex")) return;
  writeArtifact(join5(dir, "refs.bib"), toBibtex(sources));
}
function writeDossier(dir, rawSources, manifest, template) {
  ensureDir(join5(dir, "sources"));
  const sources = rawSources.map((rs, i) => {
    const id = `S${i + 1}`;
    const s = buildSource(rs, id, manifest.builtAt, manifest.question);
    writeSourceExtract(dir, s, rs.text ?? rs.snippet ?? "", manifest.depth);
    return s;
  });
  const m = { ...manifest, sourceCount: sources.length };
  return { dir, sources, paths: writeDossierIndex(dir, sources, m, template) };
}
function renderDossierMarkdown(sources, manifest, template) {
  const noWrite = isNoWrite();
  const enrich = noWrite ? "Search further yourself (your own WebSearch) and read those pages directly" : "Top them up (another WebSearch round + `ingest --run <dir> --web-results <f.json>`)";
  const out = [];
  out.push(`# Search dossier`);
  out.push("");
  out.push(`**Question:** ${manifest.question}`);
  out.push(
    `**Mode:** ${manifest.mode} \xB7 **depth:** ${manifest.depth} \xB7 **lang:** ${manifest.lang} \xB7 **sources:** ${sources.length} \xB7 **built:** ${manifest.builtAt}`
  );
  out.push(`**Backends used:** ${manifest.backendsUsed.join(", ") || "none"}`);
  if (manifest.searchProfile) out.push(`**Search profile:** ${manifest.searchProfile}`);
  out.push("");
  if (manifest.webSearch) {
    const ws = manifest.webSearch;
    out.push(
      ws.supplied ? `**WebSearch lane:** ${ws.supplied} agent-supplied hit(s) \u2192 ${ws.kept} kept` + (ws.rejected ? ` (${ws.rejected} rejected as unusable)` : "") : `> \u{1F50E} **No WebSearch lane** \u2014 discovery ran on the keyless engines alone, and those are best-effort. If you have a WebSearch tool, search yourself and fold the hits in with \`ingest --run <dir> --web-results <f.json>\`; next time, pass them to \`gather --web-results\` from the start.`
    );
    out.push("");
  }
  if (manifest.recallFloor) {
    out.push(
      `> \u26A0 **Thin dossier** \u2014 only ${manifest.recallFloor.count} on-topic source(s) were retrieved (recall floor ${manifest.recallFloor.floor}). ${enrich} BEFORE answering, or the answer will rest on too little evidence.`
    );
    out.push("");
  }
  if (manifest.coverage?.under.length) {
    out.push(
      `> \u{1F50D} **Under-covered** \u2014 \`${manifest.coverage.under.join("`, `")}\`: fewer than ${UNDER_COVERED_MIN} of the top sources mention these terms from your question. ${enrich} before answering, or state the gap explicitly under "Open questions".`
    );
    out.push("");
  }
  out.push(
    noWrite ? `> Nothing was written \u2014 every source's full extract follows this brief on stdout. Answer the question directly from them, in the shape of the template below (use every relevant source and end with an "Open questions / contradictions" section). Do not answer from memory.` : `> Write two tiers from these sources: \`SUMMARY.md\` (TL;DR) and \`REPORT.md\` (the full template below, filled exhaustively \u2014 use every relevant source and end with an "Open questions / contradictions" section). Then run \`render\` and \`check\`. Do not answer from memory.`
  );
  out.push("");
  out.push(`## Grounding rules`);
  out.push("");
  out.push(noWrite ? CITATION_RULES_NO_WRITE : CITATION_RULES);
  out.push("");
  out.push(`## Report template (${manifest.mode})`);
  out.push("");
  out.push("```markdown");
  out.push(template);
  out.push("```");
  if (manifest.extras.length) {
    out.push("");
    out.push(`_Also produce: ${manifest.extras.join(", ")}._`);
  }
  out.push("");
  if (manifest.notes.length) {
    out.push(`## Retrieval notes`);
    out.push("");
    for (const n of manifest.notes) out.push(`- ${n}`);
    out.push("");
  }
  out.push(`## Sources`);
  out.push("");
  out.push(
    `> **You are the judge of these sources.** This engine ranks for RELEVANCE and keeps everything it retrieved \u2014 it holds no list of "good" websites, and \`trust\` below reflects only the ROUTE a source arrived by (a scholarly API vouches for a record; a web engine vouches for nothing). Deciding what is authoritative is your job, and you are the only party here who can actually read the page.`
  );
  out.push(`>`);
  out.push(
    `> As you read each extract, appraise it: is this the primary source (a spec, a vendor's own docs, the paper), secondary reporting, or content marketing rewriting someone else's work? Prefer the primary one for a load-bearing claim, and when only a weak source carries a claim, **say so in the report** rather than leaning on it silently. Discarding a page you judge worthless is a legitimate reading decision \u2014 the engine deliberately did not make it for you.`
  );
  out.push("");
  if (sources.some((s) => s.signals?.length)) {
    out.push(
      `> Each source carries three **measured facts** \u2014 how many external sources it cites, how many engines independently surfaced it, whether it declares a persistent identity. They are counts, not verdicts: a page citing nothing can be the primary source (a spec, an API reference), and a page citing plenty can be a rewrite. Use them to decide what to open first, then judge from the text.`
    );
    out.push("");
  }
  if (sources.length === 0) {
    out.push(
      noWrite ? `_No sources were retrieved. Broaden the query, add backends, or search yourself with your own WebSearch._` : `_No sources were retrieved. Search yourself and feed the hits in \u2014 \`gather --web-results <f.json>\`, or \`ingest --run <dir> --web-results <f.json>\` on this dossier \u2014 then widen with \`--search full\`._`
    );
  }
  for (const s of sources) {
    out.push(`### [${s.id}] ${s.title}`);
    const quality = s.fullText === false ? " \xB7 \u26A0 snippet only (page fetch failed)" : "";
    const where = noWrite ? `extract: streamed as \`${s.extract}\`` : `extract: \`${s.extract}\``;
    out.push(`url: ${s.url} \xB7 backend: ${s.backend} \xB7 trust: ${s.trust} \xB7 ${where}${quality}`);
    for (const sig of s.signals ?? []) out.push(`_${sig}_`);
    out.push("");
    out.push(s.snippet);
    out.push("");
  }
  return out.join("\n");
}
function readDossier(dir) {
  const sources = readJson(join5(dir, "sources.json"), "sources.json");
  if (!Array.isArray(sources)) {
    throw new Error(`sources.json in ${dir} is not a JSON array \u2014 re-run \`ultrasearch gather\`.`);
  }
  const manifest = readJson(join5(dir, "manifest.json"), "manifest.json");
  return { sources, manifest };
}

// src/services.ts
var VERSION_PROBE_TIMEOUT_MS = 2e4;
async function toolVersion(cmd, args) {
  const r = await runWithInput(cmd, args, Buffer.alloc(0), VERSION_PROBE_TIMEOUT_MS);
  if (!r.ok) return void 0;
  return r.stdout.trim().split("\n")[0]?.trim() || "installed";
}
async function probeServices(opts = {}) {
  const out = [];
  const sxBase = searxngBase({ searxng: opts.searxng });
  if (!sxBase) out.push({ name: "searxng", ok: false, detail: "disabled (--searxng off)" });
  else {
    const up = await probeSearxng(sxBase);
    out.push({
      name: "searxng",
      ok: up,
      detail: up ? `answering at ${sxBase}` : `not running at ${sxBase} \u2014 \`ultrasearch searxng up\``
    });
  }
  const fcBase = firecrawlBase(opts);
  if (!fcBase) out.push({ name: "firecrawl", ok: false, detail: "disabled (--firecrawl off)" });
  else {
    const explicit = firecrawlIsExplicit(opts);
    const up = await probeFirecrawl(fcBase, explicit);
    out.push({
      name: "firecrawl",
      ok: up,
      detail: up ? `answering at ${fcBase}` : (
        // Distinguish "nothing there" from "something there, but not Firecrawl" —
        // a squatted port is a confusing failure to debug without being told.
        `not running at ${fcBase}${explicit ? "" : " (or the port is held by another app)"} \u2014 \`ultrasearch firecrawl up\``
      )
    });
  }
  const rungs = enabledExtractors();
  if (rungs.includes("pdf-inspector")) {
    const v = await toolVersion("npx", ["-y", "--prefer-offline", PDF_INSPECTOR_SPEC, "--version"]);
    out.push({
      name: "pdf-inspector",
      ok: !!v,
      detail: v ? `${v} (via npx)` : "unavailable \u2014 needs npm, and a prebuilt binary for this platform"
    });
  } else {
    out.push({ name: "pdf-inspector", ok: false, detail: "skipped (ULTRASEARCH_NO_NPX / ULTRASEARCH_PDF_ENGINE)" });
  }
  const pt = await toolVersion("pdftotext", ["-v"]);
  out.push({ name: "pdftotext", ok: !!pt, detail: pt ?? "not installed (poppler-utils)" });
  if (rungs.includes("ocr")) {
    const { copyablePdf, tesseract } = await ocrTools();
    out.push({
      name: "ocr",
      ok: copyablePdf && tesseract,
      detail: copyablePdf && tesseract ? `copyable-pdf + tesseract, ${ocrBudgetLeft()} document(s) per run (ULTRASEARCH_OCR_MAX)` : !copyablePdf && !tesseract ? "not installed \u2014 `brew install maxgfr/tap/copyable-pdf tesseract` (scanned PDFs stay unreadable)" : copyablePdf ? "copyable-pdf is installed but tesseract is not \u2014 `brew install tesseract`" : "tesseract is installed but copyable-pdf is not \u2014 `brew install maxgfr/tap/copyable-pdf`"
    });
  } else {
    out.push({ name: "ocr", ok: false, detail: "skipped (ULTRASEARCH_PDF_ENGINE)" });
  }
  out.push({ name: "pdf ladder", ok: true, detail: rungs.join(" \u2192 ") });
  const docRungs = enabledDocExtractors();
  if (docRungs.includes("anydoc")) {
    const v = await toolVersion("npx", ["-y", "--prefer-offline", ANYDOC_SPEC, "--version"]);
    out.push({
      name: "anydoc",
      ok: !!v,
      detail: v ? `${v} (via npx)` : "unavailable \u2014 needs npm, Node 20+, and a prebuilt binary for this platform"
    });
  } else {
    out.push({ name: "anydoc", ok: false, detail: "skipped (ULTRASEARCH_NO_NPX / ULTRASEARCH_DOC_ENGINE)" });
  }
  out.push({
    name: "doc ladder",
    ok: docRungs.length > 0,
    // An empty ladder is not a broken one, but it does mean every .docx/.pptx a
    // run meets will be refused — worth saying plainly rather than printing "".
    detail: docRungs.length ? docRungs.join(" \u2192 ") : "disabled \u2014 office documents will be refused, not read"
  });
  return out;
}
function describeServices(s) {
  const parts = [];
  parts.push(
    s.searxng.requested ? `searxng ${s.searxng.sources ? `\u2713 ${s.searxng.sources} result(s)` : "\u2717 no results"}` : "searxng not in this mode's backends"
  );
  parts.push(s.firecrawl.pages ? `firecrawl \u2713 ${s.firecrawl.pages} page(s)` : "firecrawl \u2717 not used");
  const pdf = Object.entries(s.pdf);
  if (pdf.length) parts.push(`pdf ${pdf.map(([k, n]) => `${k} \u2713 ${n}`).join(", ")}`);
  const doc = Object.entries(s.doc ?? {});
  if (doc.length) parts.push(`doc ${doc.map(([k, n]) => `${k} \u2713 ${n}`).join(", ")}`);
  return parts.join(" \xB7 ") + ". Run `ultrasearch doctor` to see what is available.";
}
function formatServices(rows) {
  const w = Math.max(...rows.map((r) => r.name.length));
  return rows.map((r) => `  ${r.ok ? "\u2713" : "\u2717"} ${r.name.padEnd(w)}  ${r.detail}`).join("\n");
}
function describeWebSearchLane(manifest) {
  if (!manifest) {
    return {
      name: "websearch",
      ok: true,
      detail: "the PRIMARY engine \u2014 supplied by you, not probeable here. Run `queries`, then `gather --web-results <f.json>`."
    };
  }
  const ws = manifest.webSearch;
  if (!ws?.supplied) {
    return {
      name: "websearch",
      ok: false,
      detail: "this run had NO lane \u2014 discovery fell back to the best-effort keyless engines. Top it up: `ingest --run <dir> --web-results <f.json>`."
    };
  }
  return {
    name: "websearch",
    ok: true,
    detail: `${ws.supplied} hit(s) supplied \u2192 ${ws.kept} kept${ws.rejected ? ` (${ws.rejected} rejected)` : ""}${manifest.searchProfile ? `, --search ${manifest.searchProfile}` : ""}`
  };
}

// src/gather.ts
var OVERSHOOT = { summary: 5, standard: 10, deep: 20 };
var HYDRATE_CONCURRENCY = 6;
function round4(n) {
  return Number(n.toFixed(4));
}
function headingLines(text) {
  return text.split("\n").filter((l) => /^#{1,6}\s/.test(l)).join("\n");
}
var ENRICH_NUDGE = "agent: run another WebSearch round at the thin areas and fold the WHOLE round in with `ultrasearch ingest --run <dir> --web-results <f.json>` (one process, not one per URL) before writing the report.";
var ENRICH_NUDGE_NO_WRITE = "agent: run another WebSearch round at the thin areas and read those pages directly before answering.";
function defaultRunDir(mode, question, d) {
  return join6(tmpdir4(), "ultrasearch", `${mode}-${slugify(question)}`, runId(d));
}
var DISCOVERY = ["searxng", "duckduckgo", "ddglite", "mojeek", "marginalia"];
var ENGINE_BACKEND = {
  searxng: "searxng",
  // Pinnable, but absent from DISCOVERY above — so `auto` never reaches for it.
  firecrawl: "firecrawl",
  ddg: "duckduckgo",
  ddglite: "ddglite",
  mojeek: "mojeek",
  marginalia: "marginalia"
};
function applyWebEngine(kinds, engine) {
  if (engine === "auto") return kinds;
  if (engine === "claude") return kinds.filter((k) => !DISCOVERY.includes(k));
  const keep = ENGINE_BACKEND[engine];
  if (kinds.includes(keep)) return kinds.filter((k) => !DISCOVERY.includes(k) || k === keep);
  return [...kinds.filter((k) => !DISCOVERY.includes(k)), keep];
}
async function runWebCascade(engines, ctx, breadth = 1) {
  const out = [];
  let enough = 0;
  let i = 0;
  while (i < engines.length && enough < breadth) {
    const waveSize = Math.min(breadth - enough, engines.length - i);
    const wave = engines.slice(i, i + waveSize);
    i += waveSize;
    for (const r of await runBackends(wave, ctx)) {
      out.push(r);
      if (r.items.length >= ctx.options.perSource) enough++;
    }
  }
  const tried = out.map((r) => r.backend);
  const producers = out.filter((r) => r.items.length > 0).map((r) => r.backend);
  if (producers.length) {
    const lead = out.find((r) => r.items.length > 0);
    if (producers.length > 1) {
      lead.notes = [...lead.notes, `Web cascade fused ${producers.length} engines: ${producers.join(", ")}.`];
    } else if (tried.length > 1) {
      lead.notes = [...lead.notes, `Web cascade tried ${tried.join(" \u2192 ")}; results from ${producers.join(", ")}.`];
    }
  }
  return out;
}
function ignoredByExplicitBackends(options) {
  if (!options.backends?.length) return [];
  const out = [];
  if (options.seedDomains?.length) out.push("--seed-domains");
  if ((options.rounds ?? 1) >= 2) out.push("--rounds");
  if (options.webEngine !== "auto") out.push("--web-engine");
  if (options.search && options.search !== "auto") out.push("--search");
  if (options.webResults?.length && !options.backends.includes("claude")) out.push("--web-results");
  return out;
}
function resolveSearchProfile(options) {
  const asked = options.search ?? "auto";
  if (asked !== "auto") return asked;
  if (options.webResults?.length && options.webEngine === "auto") return "light";
  return "full";
}
function termCoverage(items, queryTerms, top = 10) {
  const toks = items.slice(0, Math.min(top, items.length)).map((it) => new Set(bm25Tokenize(it.text || it.snippet || "")));
  return queryTerms.map((term) => ({ term, sources: toks.reduce((n, t) => n + (t.has(term) ? 1 : 0), 0) }));
}
function underCovered(cov) {
  return cov.filter((c) => c.sources < UNDER_COVERED_MIN).map((c) => c.term);
}
function resolveBackends(options, mode) {
  if (options.backends?.length) return [...new Set(options.backends)];
  const base = options.depth === "deep" ? [...mode.backends, ...mode.deepOnly] : [...mode.backends];
  const withEngine = applyWebEngine(base, options.webEngine);
  const profile = resolveSearchProfile(options);
  const discovery = profile === "light" ? withEngine.filter((k) => !DISCOVERY.includes(k)) : withEngine;
  const ceiling = profile === "max" ? [...DISCOVERY, "firecrawl"] : [];
  const lane = options.webResults?.length ? ["claude"] : [];
  return [.../* @__PURE__ */ new Set([...lane, ...discovery, ...ceiling])];
}
var MAX_PROFILE_KNOBS = { pages: 5, webBreadth: 5, rounds: 2, perSource: 50 };
function ignoredByMaxProfile(options) {
  if (resolveSearchProfile(options) !== "max") return [];
  const out = [];
  if (options.webEngine !== "auto") out.push("--web-engine");
  return out;
}
function fuse(lists) {
  const fused = rrf(lists, identityKey);
  const best = /* @__PURE__ */ new Map();
  const foundBy = /* @__PURE__ */ new Map();
  for (const list of lists) {
    const seenInList = /* @__PURE__ */ new Set();
    for (const it of list) {
      const key = identityKey(it);
      if (!seenInList.has(key)) {
        seenInList.add(key);
        foundBy.set(key, (foundBy.get(key) ?? 0) + 1);
      }
      const prev = best.get(key);
      if (!prev) {
        best.set(key, { ...it });
      } else if (!prev.text && it.text) {
        best.set(key, { ...it, meta: { ...prev.meta, ...it.meta } });
      } else if (it.meta) {
        prev.meta = { ...it.meta, ...prev.meta };
      }
    }
  }
  for (const [key, it] of best) it.meta = { ...it.meta, foundBy: foundBy.get(key) ?? 1 };
  const merged = [...best.values()];
  for (const it of merged) it.score = fused.get(identityKey(it)) ?? 0;
  merged.sort((a, b) => b.score - a.score || a.url.localeCompare(b.url));
  return merged;
}
function resolveVariants(options) {
  if (options.queries?.length) {
    const cap = options.depth === "summary" ? 2 : options.depth === "standard" ? 4 : 6;
    const seen = /* @__PURE__ */ new Set();
    const out = [];
    for (const q of options.queries) {
      const t = q.trim();
      const key = t.toLowerCase();
      if (t && !seen.has(key)) {
        seen.add(key);
        out.push(t);
      }
    }
    if (out.length) return out.slice(0, cap);
  }
  return planVariants(options.question, options.depth);
}
async function runGather(options) {
  const t0 = Date.now();
  const mode = getMode(options.mode);
  const backends = resolveBackends(options, mode);
  const profile = resolveSearchProfile(options);
  if (profile === "max") {
    options.pages ??= MAX_PROFILE_KNOBS.pages;
    options.perSource = Math.max(options.perSource, MAX_PROFILE_KNOBS.perSource);
    options.webBreadth ??= MAX_PROFILE_KNOBS.webBreadth;
    options.rounds ??= MAX_PROFILE_KNOBS.rounds;
  }
  const variants = resolveVariants(options);
  const effPages = Math.max(1, options.pages ?? PAGES_PER_DEPTH[options.depth] ?? 1);
  options.pages = effPages;
  const breadth = Math.max(1, options.webBreadth ?? WEB_BREADTH_PER_DEPTH[options.depth] ?? 1);
  const acceptLanguage = acceptLanguageHeader(options.lang, options.region);
  const ctx = { question: options.question, mode, options, variants };
  const explicit = !!options.backends?.length;
  const webBackends = backends.filter((b) => DISCOVERY.includes(b));
  let results;
  if (explicit || webBackends.length === 0) {
    results = await runBackends(backends, ctx);
  } else {
    const rest = backends.filter((b) => !DISCOVERY.includes(b));
    const cascade = options.webEngine === "auto" ? [...DISCOVERY] : DISCOVERY.filter((d) => webBackends.includes(d));
    const [restResults, webResults] = await Promise.all([runBackends(rest, ctx), runWebCascade(cascade, ctx, breadth)]);
    results = [...restResults, ...webResults];
  }
  const seedDomains = (options.seedDomains ?? []).slice(0, 3);
  if (seedDomains.length && webBackends.length > 0 && !explicit) {
    const cascade = options.webEngine === "auto" ? [...DISCOVERY] : DISCOVERY.filter((d) => webBackends.includes(d));
    const kw = rankedKeywords(options.question).slice(0, 4).join(" ");
    const seedResults = await Promise.all(
      seedDomains.map((d) => {
        const q = `site:${d} ${kw}`.trim();
        return runWebCascade(cascade, { ...ctx, question: q, variants: [q], options: { ...options, pages: 1 } }, 1);
      })
    );
    results = [...results, ...seedResults.flat()];
  }
  const excluded = (it) => {
    const d = domainOf(it.url);
    return !options.excludeDomains.some((ex) => d === ex || d.endsWith("." + ex));
  };
  const hydrateCache = /* @__PURE__ */ new Map();
  let cacheHits = 0;
  let waybackUsed = 0;
  const WAYBACK_CAP = 5;
  const extractorUse = /* @__PURE__ */ new Map();
  const docExtractorUse = /* @__PURE__ */ new Map();
  const tallyExtractor = (res, url) => {
    const k = res.extractor ?? "native";
    extractorUse.set(k, (extractorUse.get(k) ?? 0) + 1);
    if (url && res.extractor && docFormatForUrl(url)) {
      docExtractorUse.set(k, (docExtractorUse.get(k) ?? 0) + 1);
    }
  };
  const extractOpts = { acceptLanguage, firecrawl: options.firecrawl };
  async function assemble(rawLists) {
    let merged2 = fuse(rawLists);
    const droppedDup = rawLists.reduce((n, l) => n + l.length, 0) - merged2.length;
    if (options.excludeDomains.length) merged2 = merged2.filter(excluded);
    const overshoot = OVERSHOOT[options.depth] ?? 10;
    const budget = options.maxSources === void 0 ? merged2.length : Math.min(merged2.length, options.maxSources + overshoot);
    const pool = merged2.slice(0, budget);
    const notFetched = merged2.length - pool.length;
    const hydrateNotes = [];
    await mapLimit(pool, options.concurrency ?? HYDRATE_CONCURRENCY, async (it) => {
      if (it.text?.trim()) {
        it.fullText = true;
        return;
      }
      const key = canonicalizeUrl(it.url);
      let res = hydrateCache.get(key);
      if (!res) {
        res = await cachedFetchAndExtract(it.url, extractOpts, !!options.cache);
        if (res.cached) cacheHits++;
        tallyExtractor(res, it.url);
        hydrateCache.set(key, res);
      }
      if (res.finalUrl && res.finalUrl !== it.url) it.url = res.finalUrl;
      if (res.note) hydrateNotes.push(res.note);
      let text = res.text?.trim() ? res.text : "";
      let junk = text ? looksLikeJunkExtraction(text) : void 0;
      let title = junk ? void 0 : res.title;
      if (!text || junk) {
        const absUrl = typeof it.meta?.absUrl === "string" ? it.meta.absUrl : void 0;
        const candidates = [absUrl, resolveProvider(it.url).textUrl, absUrl ? resolveProvider(absUrl).textUrl : void 0];
        for (const cand of [...new Set(candidates)]) {
          if (!cand || cand === it.url) continue;
          const altKey = canonicalizeUrl(cand);
          let alt = hydrateCache.get(altKey);
          if (!alt) {
            alt = await cachedFetchAndExtract(cand, extractOpts, !!options.cache);
            if (alt.cached) cacheHits++;
            tallyExtractor(alt, cand);
            hydrateCache.set(altKey, alt);
          }
          if (alt.text?.trim() && !looksLikeJunkExtraction(alt.text)) {
            text = alt.text;
            junk = void 0;
            title = title || alt.title;
            it.meta = { ...it.meta, textVia: cand };
            hydrateNotes.push(`Primary page for ${it.url} was unusable \u2014 hydrated the fallback ${cand} instead.`);
            break;
          }
        }
      }
      if (!text && DEAD_LINK_STATUS.has(res.status) && waybackUsed < WAYBACK_CAP && !process.env.ULTRASEARCH_NO_WAYBACK) {
        waybackUsed++;
        const wb = await rescueViaWayback(it.url, extractOpts);
        if (wb) {
          text = wb.text;
          junk = void 0;
          title = title || wb.title;
          it.meta = { ...it.meta, waybackSnapshot: wb.timestamp };
          hydrateNotes.push(`Recovered ${it.url} from the Wayback Machine (snapshot ${wb.timestamp}).`);
        }
      }
      if (text && junk && res.extractor !== "firecrawl") {
        const wall = junk;
        const fc = await scrapeViaFirecrawl(it.url, { firecrawl: options.firecrawl });
        if (fc.data?.markdown && !looksLikeJunkExtraction(fc.data.markdown)) {
          text = fc.data.markdown;
          junk = void 0;
          title = title || fc.data.title;
          tallyExtractor({ extractor: "firecrawl" });
          hydrateCache.set(key, { ...res, text: fc.data.markdown, title, extractor: "firecrawl" });
          hydrateNotes.push(`Extraction from ${it.url} looked like a ${wall} \u2014 re-extracted it with Firecrawl.`);
        }
      }
      if (text && !junk) {
        it.text = text;
        it.fullText = true;
        if (!it.snippet) it.snippet = bestExcerpt(text, options.question);
        if ((!it.title || it.title === it.url) && title) it.title = title;
      } else {
        if (junk && text) hydrateNotes.push(`Extraction from ${it.url} looks like a ${junk} \u2014 kept as snippet only.`);
        it.text = it.snippet || "";
        it.fullText = false;
      }
    });
    let withContent = pool.filter((it) => it.text?.trim() || it.snippet.trim());
    if (options.excludeDomains.length) withContent = withContent.filter(excluded);
    const docs = withContent.map((it) => ({
      id: it.url,
      title: it.title || "",
      headings: headingLines(it.text || ""),
      body: it.text || it.snippet || ""
    }));
    const bm25 = buildBm25Index(options.question, docs);
    const rawContent = docs.map((d) => bm25Score(bm25, d));
    const contentMax = Math.max(1e-9, ...rawContent);
    const rrfMax = Math.max(1e-9, ...withContent.map((it) => it.score));
    const years = withContent.map((it) => it.meta?.year).filter((y) => typeof y === "number");
    const minYear = years.length ? Math.min(...years) : 0;
    const maxYear = years.length ? Math.max(...years) : 0;
    const isSeedDomain = (url) => {
      const d = domainOf(url);
      return seedDomains.some((s) => d === s || d.endsWith("." + s));
    };
    withContent.forEach((it, i) => {
      const content = rawContent[i] / contentMax;
      const rrfN = it.score / rrfMax;
      const trust = Math.max(trustScore(it.url, it.backend), isSeedDomain(it.url) ? 0.95 : 0);
      const recency = recencyScore(it.meta, minYear, maxYear);
      it.score = Number((0.45 * rrfN + 0.35 * content + 0.15 * trust + 0.05 * recency).toFixed(6));
      it.meta = { ...it.meta, rank: { rrf: round4(rrfN), content: round4(content), trust: round4(trust), recency: round4(recency) } };
    });
    withContent.sort((a, b) => b.score - a.score || a.url.localeCompare(b.url));
    const matchedByUrl = new Map(docs.map((d) => [d.id, bm25MatchedTerms(bm25, d)]));
    const isDisambiguation = (it) => /^.{0,80}?\bmay (also )?refer to\b/i.test((it.text || "").trim());
    const floor2 = Math.min(RECALL_FLOORS[options.depth], options.maxSources ?? Number.POSITIVE_INFINITY);
    const { kept, dropped } = applyRelevanceFloor(withContent, (it) => isDisambiguation(it) ? [] : matchedByUrl.get(it.url) ?? [], bm25.queryTerms, floor2);
    const floorDropped = dropped.length;
    const near = dedupeNearDuplicates(kept);
    const ordered = diversify(near.items, (it) => new Set(bm25Tokenize((it.text || it.snippet || "").slice(0, 2e4))));
    return {
      merged: ordered,
      withContent: kept,
      hydrateNotes,
      droppedDup,
      notFetched,
      nearDropped: near.dropped,
      floorDropped,
      queryTerms: bm25.queryTerms
    };
  }
  const lists = results.map((r2) => [...r2.items].sort((a, b) => b.score - a.score));
  let r = await assemble(lists);
  let gapNote;
  if ((options.rounds ?? 1) >= 2 && webBackends.length > 0 && !explicit) {
    const gaps = underCovered(termCoverage(r.withContent, r.queryTerms));
    if (gaps.length) {
      const seenTerm = /* @__PURE__ */ new Set();
      const gapQuery = [...rankedKeywords(options.question).slice(0, 2), ...gaps].filter((t) => {
        const k = t.toLowerCase();
        if (seenTerm.has(k)) return false;
        seenTerm.add(k);
        return true;
      }).join(" ");
      const cascade = options.webEngine === "auto" ? [...DISCOVERY] : DISCOVERY.filter((d) => webBackends.includes(d));
      const gapCtx = { ...ctx, question: gapQuery, variants: [gapQuery], options: { ...options, pages: 1 } };
      const gapResults = await runWebCascade(cascade, gapCtx, 1);
      results = [...results, ...gapResults];
      const gapLists = gapResults.map((rr) => [...rr.items].sort((a, b) => b.score - a.score));
      r = await assemble([...lists, ...gapLists]);
      gapNote = `Gap round searched "${gapQuery}" for under-covered term(s): ${gaps.join(", ")}.`;
    }
  }
  const merged = r.merged;
  const backendsUsed = results.filter((res) => res.items.length > 0).map((res) => res.backend);
  const enginesFused = [...new Set(backendsUsed.filter((b) => DISCOVERY.includes(b) || b === "claude" || b === "firecrawl"))];
  const timings = {};
  for (const res of results) if (res.ms !== void 0) timings[res.backend] = res.ms;
  timings.total = Date.now() - t0;
  const floor = Math.min(RECALL_FLOORS[options.depth], options.maxSources ?? Number.POSITIVE_INFINITY);
  const thin = merged.length < floor;
  const coverageTerms = termCoverage(r.withContent, r.queryTerms);
  const under = underCovered(coverageTerms);
  const ignoredFlags = ignoredByExplicitBackends(options);
  const supplied = options.webResults?.length ?? 0;
  const laneKept = merged.filter((it) => it.backend === "claude").length;
  const webSearch = { supplied, rejected: options.webResultsRejected ?? 0, kept: laneKept };
  const bridge = options.stdout ? "and read those pages directly before answering" : "and fold the round in with `ingest --web-results` before writing";
  const searxngResult = results.find((res) => res.backend === "searxng");
  const services = {
    searxng: { requested: backends.includes("searxng"), sources: searxngResult?.items.length ?? 0 },
    firecrawl: { pages: extractorUse.get("firecrawl") ?? 0 },
    // `anydoc` is counted under whichever ladder actually ran it: the PDF bucket
    // gets what it read as a PDF, the doc bucket what it read as an office file.
    pdf: Object.fromEntries(
      [...extractorUse].filter(([k]) => k === "pdf-inspector" || k === "pdftotext" || k === "anydoc" || k === "ocr").map(([k, n]) => [k, n - (docExtractorUse.get(k) ?? 0)]).filter(([, n]) => n > 0)
    ),
    ...docExtractorUse.size ? { doc: Object.fromEntries(docExtractorUse) } : {}
  };
  const notes = [
    ...results.flatMap((res) => res.notes),
    // Deduped: every per-page hydrate note names its URL and so is unique, but
    // the instance-level ones (an explicitly-configured Firecrawl that is down)
    // would otherwise repeat once per page in the pool.
    ...new Set(r.hydrateNotes),
    ...r.droppedDup > 0 ? [`Dropped ${r.droppedDup} duplicate result(s) across backends.`] : [],
    ...r.nearDropped > 0 ? [`Collapsed ${r.nearDropped} near-duplicate (syndicated) page(s).`] : [],
    ...r.floorDropped > 0 ? [`Relevance floor dropped ${r.floorDropped} off-topic result(s) with no meaningful query-term overlap.`] : [],
    ...r.notFetched > 0 ? [
      `Discovery found ${r.notFetched} more candidate(s) than this run fetched \u2014 \`--max-sources ${options.maxSources}\` is the FETCH budget (+${OVERSHOOT[options.depth] ?? 10} overshoot). They were never retrieved, so they are not in this dossier: raise --max-sources or --depth to reach them.`
    ] : [],
    ...seedDomains.length ? [`Ran a targeted site: search for seed domain(s): ${seedDomains.join(", ")}.`] : [],
    ...gapNote ? [gapNote] : [],
    ...explicit ? [
      `--backends pinned retrieval to ${backends.join(", ")}: the resilient web cascade is OFF` + (ignoredFlags.length ? `, and ${ignoredFlags.join(" / ")} ${ignoredFlags.length > 1 ? "were" : "was"} ignored` : "") + `. Drop --backends to get the auto cascade, seed-domain and gap rounds back.`
    ] : [],
    // The WebSearch lane, said out loud in every direction. Silence here is
    // exactly the failure this whole layer exists to fix: the best engine
    // available to the caller going unused, and nothing recording the fact.
    ...webSearch.rejected > 0 ? [`--web-results: ignored ${webSearch.rejected} entr${webSearch.rejected === 1 ? "y" : "ies"} with no usable http(s) URL.`] : [],
    ...supplied > 0 ? [`WebSearch lane: ${supplied} agent-supplied hit(s), ${laneKept} kept after fusion, hydration and the relevance floor.`] : explicit ? [] : [
      `No WebSearch lane this run: discovery fell back to the keyless engines, which are best-effort. If you have a WebSearch tool, run it and pass the hits with --web-results <file.json> \u2014 it is the strongest engine available here.`
    ],
    // `max` is a promise of the ceiling, and the ceiling includes ~3 GB of
    // containers the engine cannot start for you. A run that asked for max and
    // silently got full-minus-the-stack is the worst outcome here: it LOOKS
    // exhaustive. So say exactly which part was missing.
    ...profile === "max" ? [
      `--search max: every lane at its ceiling (pages ${options.pages}, breadth ${options.webBreadth}, ${options.rounds} round(s), ${options.perSource} per backend, Firecrawl /search in discovery).`,
      ...ignoredByMaxProfile(options).length ? [`--search max supersedes ${ignoredByMaxProfile(options).join(" / ")}: max means every engine, not one.`] : [],
      // Do NOT guess why. A running SearXNG whose upstreams are throttling
      // (brave 429, duckduckgo CAPTCHA) contributes nothing and reports
      // exactly that in its own note — telling the reader "the container is
      // down" would contradict a more accurate note in the same dossier and
      // send them to restart something that is already healthy.
      ...services.searxng.sources === 0 ? [
        `\u26A0 max asked for SearXNG and it contributed nothing. Its own note above says why (a stopped container, or its upstream engines throttling). \`ultrasearch doctor\` tells the two apart.`
      ] : [],
      ...services.firecrawl.pages === 0 ? [
        `\u26A0 max asked for Firecrawl and no page came back through it \u2014 the stack is down. Start it: \`ultrasearch firecrawl up\`. Without it you lose browser-rendered extraction and the consent-wall rescue, so this run is max-minus-the-stack.`
      ] : []
    ] : [],
    ...profile === "light" && !explicit ? [
      `--search light: the keyless scraped cascade and SearXNG are OFF (the WebSearch lane is the discovery). Firecrawl still extracts. Use --search full to fuse the keyless engines in as well.`,
      ...seedDomains.length ? [
        `--seed-domains needs a discovery engine to run its site: queries; --search light has none. Use --search full, or pass those pages in --web-results.`
      ] : [],
      ...(options.rounds ?? 1) >= 2 ? [`--rounds 2 needs a discovery engine for its gap search; --search light has none. Use --search full.`] : []
    ] : [],
    ...cacheHits > 0 ? [`Fetch cache served ${cacheHits} page(s) from disk (up to 24h old). Use --no-cache for an all-live run.`] : [],
    ...services.firecrawl.pages > 0 ? [`Firecrawl cleaned ${services.firecrawl.pages} page(s) (self-hosted, browser-rendered main-content markdown instead of the built-in HTML stripper).`] : [],
    // The optional helpers are silent by design when absent, so ONE line per run
    // says what they actually did. Without it a container can be up for weeks,
    // never be queried, and leave no trace of the fact anywhere.
    `Helpers: ${describeServices(services)}`,
    ...thin ? [`Thin dossier: only ${merged.length} on-topic source(s) (recall floor ${floor}). Enrich the thin areas with your own WebSearch ${bridge}.`] : [],
    ...under.length ? [
      `Under-covered term(s): ${under.join(", ")} \u2014 fewer than ${UNDER_COVERED_MIN} of the top sources mention them. Search these yourself ${bridge}, or say so under "Open questions".`
    ] : [],
    options.stdout ? ENRICH_NUDGE_NO_WRITE : ENRICH_NUDGE
  ];
  const manifest = {
    version: VERSION,
    question: options.question,
    mode: options.mode,
    depth: options.depth,
    lang: options.lang,
    ...options.region ? { region: options.region } : {},
    pages: effPages,
    backends,
    backendsUsed,
    ...enginesFused.length ? { enginesFused } : {},
    webSearch,
    searchProfile: profile,
    sourceCount: merged.length,
    maxSources: options.maxSources,
    builtAt: (/* @__PURE__ */ new Date()).toISOString(),
    slug: `${options.mode}-${slugify(options.question)}`,
    tiers: ["SUMMARY.md", "REPORT.md"],
    extras: mode.extras,
    notes,
    timings,
    ...thin ? { recallFloor: { count: merged.length, floor } } : {},
    ...coverageTerms.length ? { coverage: { terms: coverageTerms, under } } : {},
    cache: { enabled: !!options.cache, hits: cacheHits },
    services
  };
  const dir = options.out ?? defaultRunDir(options.mode, options.question);
  const { sources } = writeDossier(dir, merged, manifest, mode.template);
  writeBibtex(dir, sources, mode.extras);
  return { dir, sources, manifest: { ...manifest, sourceCount: sources.length } };
}

// src/enrich.ts
import { existsSync as existsSync6, readFileSync as readFileSync6, statSync as statSync2 } from "fs";
import { basename as basename2, resolve as resolve2 } from "path";
import { pathToFileURL } from "url";
async function addSources(dir, hits, opts = {}) {
  const results = [];
  for (const hit of hits) {
    const { url, title } = typeof hit === "string" ? { url: hit, title: void 0 } : hit;
    const r = await addSource(dir, url, { ...opts, title });
    results.push({ ...r, url });
  }
  return {
    results,
    added: results.filter((r) => r.added).length,
    skipped: results.filter((r) => !r.added).length
  };
}
var TEXT_FILE_RE = /\.(txt|md|markdown|rst|adoc|org|html?|xml|json|ya?ml|tsv|log)$/i;
async function addFiles(dir, paths, opts = {}) {
  const results = [];
  for (const p of paths) {
    const abs = resolve2(p);
    const url = pathToFileURL(abs).href;
    results.push({ ...await addFile(dir, abs, opts), url });
  }
  return {
    results,
    added: results.filter((r) => r.added).length,
    skipped: results.filter((r) => !r.added).length
  };
}
async function addFile(dir, abs, opts) {
  const url = pathToFileURL(abs).href;
  if (!existsSync6(abs) || !statSync2(abs).isFile()) {
    return { id: "", added: false, note: `${abs} is not a readable file` };
  }
  const { sources, manifest } = readDossier(dir);
  const question = opts.question ?? manifest.question;
  const existing = sources.find((s2) => s2.canonicalUrl === canonicalizeUrl(url));
  if (existing) return { id: existing.id, added: false, note: `already in dossier as ${existing.id}` };
  const bytes = readFileSync6(abs);
  const name = basename2(abs);
  let text;
  let extractor;
  const docFmt = docFormatForUrl(url);
  if (looksLikePdfUrl(url)) {
    const got = await extractPdf(bytes, {});
    if (!got.text) return { id: "", added: false, note: `could not extract text from ${name} \u2014 ${got.reason}.` };
    text = got.text;
    extractor = got.via;
  } else if (docFmt) {
    const got = await extractDocument(bytes, docFmt, {});
    if (!got.text && docFmt.textFallback) text = bytes.toString("utf8");
    else if (!got.text) return { id: "", added: false, note: `could not extract text from ${name} \u2014 ${got.reason}.` };
    else {
      text = got.text;
      extractor = got.via;
    }
  } else if (TEXT_FILE_RE.test(abs)) {
    const raw2 = bytes.toString("utf8");
    text = /\.html?$/i.test(abs) ? htmlToText(extractMainHtml(raw2)) : raw2;
  } else {
    return {
      id: "",
      added: false,
      note: `${name}: unsupported file type \u2014 ingest reads PDFs, office documents (${DOC_EXTENSIONS.join(", ")}) and plain text.`
    };
  }
  if (!text.trim()) return { id: "", added: false, note: `${name} is empty` };
  const id = nextSourceId(sources);
  const raw = {
    url,
    title: titleFromText(text) || name,
    backend: "file",
    score: 0,
    snippet: bestExcerpt(text, question),
    text,
    ...extractor ? { meta: { textVia: extractor } } : {}
  };
  const s = buildSource(raw, id, (/* @__PURE__ */ new Date()).toISOString(), question);
  writeSourceExtract(dir, s, text, manifest.depth);
  const nextSources = [...sources, s];
  const nextManifest = { ...manifest, sourceCount: nextSources.length, backendsUsed: [.../* @__PURE__ */ new Set([...manifest.backendsUsed, "file"])] };
  writeDossierIndex(dir, nextSources, nextManifest, getMode(nextManifest.mode).template);
  return { id, added: true };
}
async function addSource(dir, url, opts = {}) {
  const { sources, manifest } = readDossier(dir);
  const question = opts.question ?? manifest.question;
  const addressed = addressedIdCount(url);
  if (addressed > 1) {
    return { id: "", added: false, note: `${url} addresses ${addressed} records \u2014 a source is ONE document. Fetch them one at a time.` };
  }
  const supplied = opts.citeUrl?.trim();
  if (supplied && !isCitableUrl(supplied)) {
    return { id: "", added: false, note: `citeUrl ${supplied} is not a page a reader can open \u2014 pass the document's own page.` };
  }
  const provider = resolveProvider(url);
  if (provider.reject && !supplied) return { id: "", added: false, note: provider.reject };
  let citeUrl = supplied || provider.citeUrl;
  const canon = canonicalizeUrl(citeUrl);
  const existing = sources.find((s2) => s2.canonicalUrl === canon);
  if (existing) {
    return { id: existing.id, added: false, note: `already in dossier as ${existing.id}` };
  }
  const preferred = provider.preferText && provider.textUrl ? provider.textUrl : citeUrl;
  const readUrl = supplied ? url : preferred;
  const fetched = await cachedFetchAndExtract(readUrl, { firecrawl: opts.firecrawl }, !!opts.cache);
  let { text, title } = fetched;
  let wall = text?.trim() ? looksLikeJunkExtraction(text) : void 0;
  if (wall) title = void 0;
  const meta = {};
  let via;
  if (readUrl !== citeUrl) {
    via = readUrl;
    meta.textVia = readUrl;
  }
  const fallbackUrl = readUrl === citeUrl ? provider.textUrl : citeUrl;
  if ((!text?.trim() || wall) && fallbackUrl && fallbackUrl !== readUrl) {
    const alt = await cachedFetchAndExtract(fallbackUrl, { firecrawl: opts.firecrawl }, !!opts.cache);
    if (alt.text?.trim() && !looksLikeJunkExtraction(alt.text)) {
      text = alt.text;
      title = title || alt.title;
      wall = void 0;
      via = fallbackUrl === citeUrl ? void 0 : fallbackUrl;
      if (via) meta.textVia = via;
      else delete meta.textVia;
    }
  }
  if (text?.trim() && wall && fetched.extractor !== "firecrawl") {
    const fc = await scrapeViaFirecrawl(readUrl, { firecrawl: opts.firecrawl });
    if (fc.data?.markdown && !looksLikeJunkExtraction(fc.data.markdown)) {
      text = fc.data.markdown;
      title = title || fc.data.title;
      wall = void 0;
    }
  }
  if (!text?.trim() && DEAD_LINK_STATUS.has(fetched.status)) {
    const wb = await rescueViaWayback(readUrl, { firecrawl: opts.firecrawl });
    if (wb) {
      text = wb.text;
      title = title || wb.title;
      wall = void 0;
      meta.waybackSnapshot = wb.timestamp;
    }
  }
  if (text?.trim() && wall) {
    return {
      id: "",
      added: false,
      note: `${readUrl} extracted to a ${wall}, not content \u2014 not added. Retry later, or pin a source that carries the text.`
    };
  }
  if (!text?.trim()) {
    return { id: "", added: false, note: fetched.note ?? `no readable content at ${readUrl}` };
  }
  if (supplied && supplied !== url) {
    meta.textVia = url;
    via = url;
  } else if (!isCitableUrl(citeUrl)) {
    const derived = deriveCitableUrl(text, fetched.canonical);
    if (!derived) {
      return {
        id: "",
        added: false,
        note: `${citeUrl} is an API endpoint and its payload names no document (no canonical link, DOI, arXiv id or PMID). Find the page this record describes and pass it as citeUrl \u2014 the text still comes from the endpoint.`
      };
    }
    meta.textVia = citeUrl;
    via = citeUrl;
    citeUrl = derived;
    const dup = sources.find((s2) => s2.canonicalUrl === canonicalizeUrl(citeUrl));
    if (dup) return { id: dup.id, added: false, note: `already in dossier as ${dup.id} (${citeUrl})` };
  }
  const id = nextSourceId(sources);
  const backend = opts.backend ?? "claude";
  const raw = {
    url: citeUrl,
    // Never fall back to the URL as a title when the text came from an API
    // endpoint — a bare endpoint string is unreadable in a source list.
    title: opts.title || title || (via ? titleFromText(text) : citeUrl),
    backend,
    score: 0,
    snippet: bestExcerpt(text, question),
    text,
    ...Object.keys(meta).length ? { meta } : {}
  };
  const s = buildSource(raw, id, (/* @__PURE__ */ new Date()).toISOString(), question);
  writeSourceExtract(dir, s, text, manifest.depth);
  const nextSources = [...sources, s];
  const backendsUsed = [.../* @__PURE__ */ new Set([...manifest.backendsUsed, backend])];
  const nextManifest = { ...manifest, sourceCount: nextSources.length, backendsUsed };
  writeDossierIndex(dir, nextSources, nextManifest, getMode(nextManifest.mode).template);
  return { id, added: true };
}

// src/render.ts
import { existsSync as existsSync7, readFileSync as readFileSync7 } from "fs";
import { join as join7 } from "path";

// src/claims.ts
var TOKEN_RE2 = /\[([^\]\n]+)\](?!\()/g;
var SOURCE_RE = /^S\d+$/;
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
function hintMask(lines) {
  const mask = new Array(lines.length).fill(false);
  let regions = 0;
  let i = 0;
  while (i < lines.length) {
    if (/^\s*>/.test(lines[i])) {
      let j = i;
      let isHint = false;
      while (j < lines.length && /^\s*>/.test(lines[j])) {
        if (/\[model-hint\]/i.test(lines[j])) isHint = true;
        j++;
      }
      if (isHint) {
        regions++;
        for (let k = i; k < j; k++) mask[k] = true;
      }
      i = j;
    } else {
      i++;
    }
  }
  return { mask, regions };
}
function stripInlineCode(line) {
  return line.replace(/`[^`\n]*`/g, " ");
}
function isHeadingOrRule(t) {
  return /^#{1,6}\s/.test(t) || /^([-*_])\1{2,}$/.test(t);
}
function isTableSeparator(line) {
  return /\|/.test(line) && /^[\s:|-]+$/.test(line.trim()) && /-/.test(line);
}
function isTableRow(line) {
  return /\|/.test(line.trim()) && !isTableSeparator(line);
}
function tableCells(line) {
  return line.trim().replace(/^\|/, "").replace(/\|$/, "").split("|").map((c) => c.trim()).join(" ");
}
function isListItem(line) {
  return /^\s*([-*+]|\d+\.)\s+\S/.test(line);
}
function extractUnits(lines, code, hint) {
  const units = [];
  let prose = [];
  const flush = () => {
    if (prose.length) units.push({ kind: "text", text: prose.join(" ") });
    prose = [];
  };
  let i = 0;
  while (i < lines.length) {
    if (code[i] || hint[i]) {
      flush();
      i++;
      continue;
    }
    const line = stripInlineCode(lines[i]);
    const t = line.trim();
    if (t === "" || isHeadingOrRule(t) || isTableSeparator(line)) {
      flush();
      i++;
      continue;
    }
    if (isTableRow(line)) {
      flush();
      const next = i + 1 < lines.length && !code[i + 1] ? stripInlineCode(lines[i + 1]) : "";
      if (!isTableSeparator(next)) units.push({ kind: "text", text: tableCells(line) });
      i++;
      continue;
    }
    if (/^\s*>/.test(line)) {
      flush();
      const quoted = [];
      while (i < lines.length && !code[i] && !hint[i]) {
        const ql = stripInlineCode(lines[i]);
        if (!/^\s*>/.test(ql)) break;
        const dq = ql.replace(/^\s*>\s?/, "").trim();
        if (dq) quoted.push(dq);
        i++;
      }
      if (quoted.length) units.push({ kind: "text", text: quoted.join(" ") });
      continue;
    }
    if (isListItem(line)) {
      flush();
      const items = [];
      while (i < lines.length && !code[i] && !hint[i]) {
        const l = stripInlineCode(lines[i]);
        const tt = l.trim();
        if (tt === "" || isHeadingOrRule(tt) || isTableSeparator(l) || isTableRow(l)) break;
        if (isListItem(l)) {
          items.push(l.replace(/^\s*([-*+]|\d+\.)\s+/, "").trim());
        } else if (items.length) {
          items[items.length - 1] += " " + tt;
        } else {
          items.push(tt);
        }
        i++;
      }
      units.push({ kind: "list", items });
      continue;
    }
    prose.push(line);
    i++;
  }
  flush();
  return units;
}
function stripHtmlComments(text) {
  return text.replace(/<!--[\s\S]*?-->/g, (m) => m.replace(/[^\n]/g, " "));
}
function normalizeNumeralText(text) {
  return text.replace(/(\d)[,\u00A0\u202F' ](?=\d)/g, "$1");
}
function extractNumerals(text) {
  const cleaned = stripInlineCode(text).replace(/\[([^\]]+)\]\([^)]*\)/g, "$1").replace(/\[[^\]\n]+\](?!\()/g, " ");
  const out = [];
  for (const m of cleaned.matchAll(/\d[\d,\u00A0\u202F']*(?:\.\d+)?%?/g)) {
    const numeric = normalizeNumeralText(m[0]).replace(/[,\u00A0\u202F'%]/g, "");
    const digits = numeric.replace(/\D/g, "");
    if (digits.length < 2 && !numeric.includes(".")) continue;
    if (!out.includes(numeric)) out.push(numeric);
    if (out.length >= 8) break;
  }
  return out;
}
var APPENDIX_HEADING = /^\s*(#{2,6})\s+(sources|references)\b/i;
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
function unitsOfFile(text) {
  const lines = stripHtmlComments(text).split("\n");
  const code = codeMask(lines);
  const { mask: hint } = hintMask(lines);
  const appendix = appendixMask(lines);
  return extractUnits(
    lines,
    code,
    hint.map((h, i) => h || appendix[i])
  );
}
function unitSourceTokens(text) {
  const masked = stripInlineCode(text);
  const out = [];
  TOKEN_RE2.lastIndex = 0;
  let m;
  while (m = TOKEN_RE2.exec(masked)) {
    const tok = m[1].trim();
    if (SOURCE_RE.test(tok) && !out.includes(tok)) out.push(tok);
  }
  return out;
}
function citedSourceIds(text) {
  const lines = stripHtmlComments(text).split("\n");
  const code = codeMask(lines);
  const appendix = appendixMask(lines);
  const out = /* @__PURE__ */ new Set();
  for (let i = 0; i < lines.length; i++) {
    if (code[i] || appendix[i]) continue;
    for (const tok of unitSourceTokens(lines[i])) out.add(tok);
  }
  return out;
}

// src/render.ts
var VERDICT_SEVERITY = { supported: 0, partial: 1, unsupported: 2, refuted: 3 };
var TIERS = [
  { id: "summary", label: "Summary", file: "SUMMARY.md" },
  { id: "report", label: "Report", file: "REPORT.md" },
  { id: "glossary", label: "Glossary", file: "glossary.md" }
];
function escapeHtml(s) {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}
function renderInline(escaped, verdicts) {
  const stash = [];
  const keep = (out) => {
    stash.push(out);
    return `\uE000${stash.length - 1}\uE000`;
  };
  let s = escaped;
  s = s.replace(/`([^`]+)`/g, (_m, c) => keep(`<code>${c}</code>`));
  s = s.replace(/\[([^\]]+)\]\((https?:[^)\s]+)\)/g, (_m, t, u) => keep(`<a href="${u}" rel="noopener" target="_blank">${t}</a>`));
  s = s.replace(/\[(S\d+)\]/g, (_m, id) => {
    const v = verdicts?.get(id);
    const cls = v ? `cite v-${v}` : "cite";
    const title = v ? `source ${id} \u2014 ${v}` : `source ${id}`;
    return `<a class="${cls}" href="#src-${id}" title="${title}">[${id}]</a>`;
  });
  s = s.replace(/\[M\]/g, `<sup class="mhint" title="model hint \u2014 not from a fetched source">[M]</sup>`);
  s = s.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
  s = s.replace(/(^|[^*])\*([^*\n]+)\*/g, "$1<em>$2</em>");
  s = s.replace(/(^|[^\w])_([^_\n]+)_/g, "$1<em>$2</em>");
  s = s.replace(/\uE000(\d+)\uE000/g, (_m, n) => stash[Number(n)] ?? "");
  return s;
}
function mdToHtml(md, idPrefix, opts = {}) {
  const lines = md.split("\n");
  const out = [];
  const headings = [];
  const usedIds = /* @__PURE__ */ new Set();
  const inline = (text) => renderInline(text, opts.verdicts);
  let i = 0;
  const headingId = (text) => {
    const base = `${idPrefix}-${slugify(text)}`;
    let id = base;
    let n = 2;
    while (usedIds.has(id)) id = `${base}-${n++}`;
    usedIds.add(id);
    return id;
  };
  while (i < lines.length) {
    const line = lines[i];
    const fence = /^\s*(```|~~~)(.*)$/.exec(line);
    if (fence) {
      const marker = fence[1];
      const body = [];
      i++;
      while (i < lines.length && !new RegExp(`^\\s*${marker}`).test(lines[i])) {
        body.push(lines[i]);
        i++;
      }
      i++;
      out.push(`<pre><code>${escapeHtml(body.join("\n"))}</code></pre>`);
      continue;
    }
    const h = /^(#{1,6})\s+(.+?)\s*#*\s*$/.exec(line);
    if (h) {
      const level = h[1].length;
      const text = h[2];
      const id = headingId(text);
      headings.push({ level, text, id });
      out.push(`<h${level} id="${id}">${inline(escapeHtml(text))}</h${level}>`);
      i++;
      continue;
    }
    if (/^([-*_])\1{2,}\s*$/.test(line)) {
      out.push("<hr>");
      i++;
      continue;
    }
    if (/^\s*>/.test(line)) {
      const quote = [];
      let isHint = false;
      while (i < lines.length && /^\s*>/.test(lines[i])) {
        let q = lines[i].replace(/^\s*>\s?/, "");
        if (/\[model-hint\]/i.test(q)) {
          isHint = true;
          q = q.replace(/\[model-hint\]\s*/i, "");
        }
        quote.push(q);
        i++;
      }
      const inner = inline(escapeHtml(quote.join(" ").trim()));
      if (isHint) {
        out.push(`<blockquote class="model-hint"><span class="mhint-badge">model hint \xB7 unverified</span> ${inner}</blockquote>`);
      } else {
        out.push(`<blockquote>${inner}</blockquote>`);
      }
      continue;
    }
    if (/\|/.test(line) && i + 1 < lines.length && /^\s*\|?[\s:|-]+\|?\s*$/.test(lines[i + 1]) && /-/.test(lines[i + 1])) {
      const rows = [];
      const header2 = splitRow(line);
      i += 2;
      while (i < lines.length && /\|/.test(lines[i]) && lines[i].trim() !== "") {
        rows.push(lines[i]);
        i++;
      }
      const thead = `<thead><tr>${header2.map((c) => `<th>${inline(escapeHtml(c))}</th>`).join("")}</tr></thead>`;
      const tbody = rows.map(
        (r) => `<tr>${splitRow(r).map((c) => `<td>${inline(escapeHtml(c))}</td>`).join("")}</tr>`
      ).join("");
      out.push(`<table>${thead}<tbody>${tbody}</tbody></table>`);
      continue;
    }
    if (/^\s*([-*+]|\d+\.)\s+/.test(line)) {
      const ordered = /^\s*\d+\.\s+/.test(line);
      const items = [];
      while (i < lines.length && /^\s*([-*+]|\d+\.)\s+/.test(lines[i])) {
        const item = lines[i].replace(/^\s*([-*+]|\d+\.)\s+/, "");
        items.push(`<li>${inline(escapeHtml(item))}</li>`);
        i++;
      }
      out.push(`<${ordered ? "ol" : "ul"}>${items.join("")}</${ordered ? "ol" : "ul"}>`);
      continue;
    }
    if (line.trim() === "") {
      i++;
      continue;
    }
    const para = [];
    while (i < lines.length && lines[i].trim() !== "" && !/^(#{1,6})\s/.test(lines[i]) && !/^\s*>/.test(lines[i]) && !/^\s*([-*+]|\d+\.)\s+/.test(lines[i]) && !/^\s*(```|~~~)/.test(lines[i]) && !/^([-*_])\1{2,}\s*$/.test(lines[i])) {
      para.push(lines[i]);
      i++;
    }
    out.push(`<p>${inline(escapeHtml(para.join(" ")))}</p>`);
  }
  return { html: out.join("\n"), headings };
}
function splitRow(row) {
  return row.trim().replace(/^\|/, "").replace(/\|$/, "").split("|").map((c) => c.trim());
}
var STYLE = `
:root{--fg:#1a1a1a;--muted:#666;--bg:#fafafa;--card:#fff;--accent:#2962a8;--line:#e3e3e3;--hint:#b8860b}
*{box-sizing:border-box}
body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;line-height:1.6;color:var(--fg);background:var(--bg);margin:0}
.wrap{max-width:1040px;margin:0 auto;padding:24px;display:grid;grid-template-columns:240px 1fr;gap:32px}
header{grid-column:1/-1;border-bottom:2px solid var(--accent);padding-bottom:12px}
header h1{margin:0 0 4px;font-size:1.6rem}
.meta{color:var(--muted);font-size:.86rem}
nav{position:sticky;top:16px;align-self:start;font-size:.9rem;max-height:90vh;overflow:auto}
nav a{display:block;color:var(--accent);text-decoration:none;padding:1px 0}
nav a:hover{text-decoration:underline}
nav .h3{padding-left:12px;font-size:.85rem;color:var(--muted)}
nav .tier{font-weight:600;margin-top:10px}
main{min-width:0}
section{background:var(--card);border:1px solid var(--line);border-radius:8px;padding:20px 24px;margin-bottom:24px}
section h1{font-size:1.3rem;border-bottom:1px solid var(--line);padding-bottom:6px}
h1,h2,h3,h4{line-height:1.3}
a{color:var(--accent)}
code{background:#f0f0f2;padding:1px 5px;border-radius:4px;font-size:.9em}
pre{background:#1e1e22;color:#eee;padding:14px;border-radius:6px;overflow:auto}
pre code{background:none;color:inherit;padding:0}
blockquote{border-left:4px solid var(--line);margin:1em 0;padding:.2em 1em;color:#333}
blockquote.model-hint{border-left-color:var(--hint);background:#fff8e6}
.mhint-badge{display:inline-block;background:var(--hint);color:#fff;font-size:.7rem;font-weight:600;padding:1px 6px;border-radius:4px;margin-right:6px;text-transform:uppercase;letter-spacing:.03em}
.cite{font-size:.82em;text-decoration:none;vertical-align:super}
.mhint{color:var(--hint);font-weight:600}
table{border-collapse:collapse;width:100%;margin:1em 0;font-size:.92rem}
th,td{border:1px solid var(--line);padding:6px 10px;text-align:left}
th{background:#f4f4f6}
.sources li{margin-bottom:10px}
.sources .s-meta,.subq .s-meta{color:var(--muted);font-size:.82rem}
.subq li{margin-bottom:10px}
.trust{display:inline-block;font-size:.72rem;padding:0 6px;border-radius:4px;background:#eef3fa;color:var(--accent)}
.callout{background:#fff8e6;border-left:4px solid var(--hint)}
.vbadge{display:inline-block;font-size:.72rem;font-weight:600;padding:0 6px;border-radius:4px;text-transform:uppercase;letter-spacing:.02em}
.v-supported{background:#e6f4ea;color:#1a7f37}
.v-partial{background:#fff4d6;color:#9a6700}
.v-unsupported{background:#f0f0f2;color:#555}
.v-refuted{background:#fbe9e7;color:#c1121f}
a.cite.v-supported{color:#1a7f37}
a.cite.v-partial{color:#9a6700}
a.cite.v-unsupported{color:#777}
a.cite.v-refuted{color:#c1121f;font-weight:700}
.contradictions{margin-top:1rem;padding:.6rem .9rem;border-left:3px solid #c1121f;background:#fbe9e7;border-radius:6px}
.contradictions h2{margin:.2rem 0 .4rem;font-size:1rem}
.snippet-only{color:#9a6700}
li.s-uncited{opacity:.6}
.chip-uncited{color:#6a737d;background:#eef1f4;border-radius:4px;padding:0 .35rem;font-size:.82em}
@media(max-width:760px){.wrap{grid-template-columns:1fr}nav{position:static;max-height:none}}
`;
function citedAcrossTiers(dir) {
  const cited = /* @__PURE__ */ new Set();
  for (const t of TIERS) {
    const p = join7(dir, t.file);
    if (!existsSync7(p)) continue;
    for (const id of citedSourceIds(readFileSync7(p, "utf8"))) cited.add(id);
  }
  return cited;
}
function readVerify(dir) {
  const p = join7(dir, "VERIFY.json");
  if (!existsSync7(p)) return void 0;
  try {
    return JSON.parse(readFileSync7(p, "utf8"));
  } catch {
    return void 0;
  }
}
function worstBySource(verify) {
  const m = /* @__PURE__ */ new Map();
  for (const v of verify?.verdicts ?? []) {
    if (!v.verdict) continue;
    const cur = m.get(v.sourceId);
    if (!cur || VERDICT_SEVERITY[v.verdict] > VERDICT_SEVERITY[cur]) m.set(v.sourceId, v.verdict);
  }
  return m;
}
function renderHtml(dir) {
  const { sources, manifest } = readDossier(dir);
  const present = TIERS.filter((t) => existsSync7(join7(dir, t.file)));
  const verify = readVerify(dir);
  const verdicts = worstBySource(verify);
  const rendered = present.map((t) => {
    const md = readFileSync7(join7(dir, t.file), "utf8");
    const { html, headings } = mdToHtml(md, t.id, { verdicts });
    return { ...t, html, headings };
  });
  let contradictionsId;
  for (const t of rendered) {
    const h = t.headings.find((x) => /open question|contradiction/i.test(x.text));
    if (h) {
      contradictionsId = h.id;
      break;
    }
  }
  if (!contradictionsId && verify?.contradictions?.length) contradictionsId = "contradictions";
  const subs = manifest.subQuestions ?? [];
  const toc = ['<nav><div class="tier"><a href="#top">\u2191 Top</a></div>'];
  for (const t of rendered) {
    toc.push(`<div class="tier"><a href="#tier-${t.id}">${t.label}</a></div>`);
    for (const h of t.headings.filter((x) => x.level === 2)) {
      toc.push(`<a class="h3" href="#${h.id}">${escapeHtml(h.text)}</a>`);
    }
  }
  if (verify) toc.push(`<div class="tier"><a href="#verification">Verification</a></div>`);
  if (verify?.contradictions?.length) toc.push(`<a class="h3" href="#contradictions">Contradictions (${verify.contradictions.length})</a>`);
  if (subs.length) toc.push(`<div class="tier"><a href="#subquestions">Sub-questions (${subs.length})</a></div>`);
  toc.push(`<div class="tier"><a href="#sources">Sources (${sources.length})</a></div></nav>`);
  const main2 = ["<main>"];
  if (contradictionsId) {
    main2.push(
      `<section class="callout"><strong>\u26A0 Open questions / contradictions</strong> \u2014 this report flags unresolved or conflicting findings. <a href="#${contradictionsId}">Jump to the section \u2193</a></section>`
    );
  }
  for (const t of rendered) {
    main2.push(`<section id="tier-${t.id}"><h1>${t.label}</h1>${t.html}</section>`);
  }
  if (verify) main2.push(verificationSection(verify));
  if (subs.length) main2.push(subQuestionsSection(manifest, sources));
  main2.push(sourcesSection(sources, citedAcrossTiers(dir)));
  main2.push("</main>");
  const title = escapeHtml(manifest.question || "ultrasearch report");
  const metaLine = `${escapeHtml(manifest.mode)} \xB7 depth ${escapeHtml(manifest.depth)} \xB7 ${sources.length} sources \xB7 ${escapeHtml(manifest.builtAt)} \xB7 generated by ultrasearch`;
  return `<!DOCTYPE html>
<html lang="${escapeHtml((manifest.lang || "en").split("-")[0])}">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>${title} \u2014 ultrasearch</title>
<style>${STYLE}</style>
</head>
<body>
<a id="top"></a>
<div class="wrap">
<header><h1>${title}</h1><div class="meta">${metaLine}</div></header>
${toc.join("\n")}
${main2.join("\n")}
</div>
</body>
</html>
`;
}
function verificationSection(r) {
  const summary = `supported ${r.supported} \xB7 partial ${r.partial} \xB7 refuted ${r.refuted} \xB7 unsupported ${r.unsupported}`;
  const status = r.ok ? `<span class="vbadge v-supported">grounded</span>` : `<span class="vbadge v-refuted">${r.failures.length} claim(s) failed</span>`;
  const rows = (r.verdicts ?? []).map(
    (v) => `<tr><td>${escapeHtml(v.claimId)}</td><td><a href="#src-${v.sourceId}">[${escapeHtml(v.sourceId)}]</a></td><td><span class="vbadge v-${v.verdict}">${escapeHtml(v.verdict ?? "\u2014")}</span></td><td>${escapeHtml(v.claim)}</td><td>${escapeHtml(v.note || "")}</td></tr>`
  ).join("");
  const table = rows ? `<table><thead><tr><th>Claim</th><th>Source</th><th>Verdict</th><th>Statement</th><th>Note</th></tr></thead><tbody>${rows}</tbody></table>` : "";
  const srcLinks = (ids) => ids.map((s) => `<a href="#src-${escapeHtml(s)}">[${escapeHtml(s)}]</a>`).join(" ");
  const contras = r.contradictions ?? [];
  const contra = contras.length ? `<div class="contradictions" id="contradictions"><h2>Contradictions (${contras.length})</h2><p>Claims whose cited sources disagree \u2014 read both sides before relying on them.</p><ul>` + contras.map(
    (c) => `<li><strong>${escapeHtml(c.claimId)}</strong>: supported by ${srcLinks(c.supporting)} \xB7 refuted by ${srcLinks(c.refuting)}${c.note ? ` \u2014 ${escapeHtml(c.note)}` : ""}</li>`
  ).join("") + `</ul></div>` : "";
  return `<section id="verification"><h1>Verification</h1><p>${status} \u2014 ${escapeHtml(summary)}</p>${table}${contra}</section>`;
}
function subQuestionsSection(manifest, sources) {
  const items = (manifest.subQuestions ?? []).map((sq) => {
    const ids = sources.filter((s) => (s.meta?.provenance ?? []).some((p) => p.subQuestion === sq.question)).map((s) => `<a href="#src-${s.id}">[${s.id}]</a>`);
    const links = ids.length ? ids.join(" ") : `<span class="s-meta">(no sources)</span>`;
    return `<li><strong>${escapeHtml(sq.id)}</strong> ${escapeHtml(sq.question)}<br><span class="s-meta">${links}</span></li>`;
  }).join("");
  return `<section id="subquestions"><h1>Sub-questions</h1><ol class="subq">${items}</ol></section>`;
}
function sourcesSection(sources, cited) {
  const mark = cited.size > 0;
  const items = sources.map((s) => {
    const uncited = mark && !cited.has(s.id);
    const meta = [
      s.backend,
      s.domain,
      `<span class="trust" title="trust score">trust ${s.trust}</span>`,
      ...s.fullText === false ? [`<span class="snippet-only" title="page fetch failed \u2014 snippet only">\u26A0 snippet only</span>`] : [],
      ...uncited ? [`<span class="chip-uncited" title="never cited by any report tier">uncited</span>`] : []
    ].join(" \xB7 ");
    const cls = uncited ? ` class="s-uncited"` : "";
    return `<li id="src-${s.id}"${cls}><strong>[${s.id}]</strong> <a href="${escapeHtml(s.url)}" rel="noopener" target="_blank">${escapeHtml(s.title)}</a><br><span class="s-meta">${meta}</span></li>`;
  }).join("\n");
  return `<section id="sources"><h1>Sources</h1><ol class="sources">${items}</ol></section>`;
}
function writeHtml(dir, out) {
  const html = renderHtml(dir);
  const path = out ?? join7(dir, "index.html");
  return writeArtifact(path, html);
}
function mdLinkText(s) {
  return s.replace(/[[\]]/g, "").trim() || "(untitled)";
}
function verificationMarkdown(r) {
  const status = r.ok ? "**grounded**" : `**${r.failures.length} claim(s) failed**`;
  const counts = `supported ${r.supported} \xB7 partial ${r.partial} \xB7 refuted ${r.refuted} \xB7 unsupported ${r.unsupported}`;
  const out = [`## Verification`, "", `${status} \u2014 ${counts}`, ""];
  const verdicts = r.verdicts ?? [];
  if (verdicts.length) {
    out.push("| Claim | Source | Verdict | Note |", "|---|---|---|---|");
    for (const v of verdicts) {
      out.push(`| ${v.claimId} | [${v.sourceId}] | ${v.verdict ?? "\u2014"} | ${(v.note || "").replace(/\|/g, "\\|")} |`);
    }
    out.push("");
  }
  const contras = r.contradictions ?? [];
  if (contras.length) {
    out.push(`### Contradictions (${contras.length})`, "");
    for (const c of contras) {
      out.push(
        `- **${c.claimId}**: supported by ${c.supporting.map((s) => `[${s}]`).join(" ")} \xB7 refuted by ${c.refuting.map((s) => `[${s}]`).join(" ")}${c.note ? ` \u2014 ${c.note}` : ""}`
      );
    }
    out.push("");
  }
  return out.join("\n");
}
function buildReportMarkdown(dir) {
  const { sources, manifest } = readDossier(dir);
  const present = TIERS.filter((t) => existsSync7(join7(dir, t.file)));
  const verify = readVerify(dir);
  const meta = `> ${manifest.mode} \xB7 depth ${manifest.depth} \xB7 ${sources.length} sources${manifest.lang ? ` \xB7 lang ${manifest.lang}` : ""}${manifest.region ? `/${manifest.region}` : ""} \xB7 ${manifest.builtAt} \xB7 generated by ultrasearch`;
  const parts = [`# ${manifest.question || "ultrasearch report"}`, "", meta, ""];
  for (const t of present) {
    const body = readFileSync7(join7(dir, t.file), "utf8").trim();
    if (!body) continue;
    parts.push("---", "", `## ${t.label}`, "", body, "");
  }
  if (verify) {
    parts.push("---", "", verificationMarkdown(verify));
  }
  parts.push("---", "", `## Sources`, "");
  if (sources.length) {
    const cited = citedAcrossTiers(dir);
    const mark = cited.size > 0;
    for (const s of sources) {
      const flag = s.fullText === false ? " \xB7 \u26A0 snippet only" : "";
      const uncited = mark && !cited.has(s.id) ? " \xB7 uncited" : "";
      parts.push(`- **[${s.id}]** [${mdLinkText(s.title)}](${s.url}) \u2014 ${s.backend} \xB7 ${s.domain} \xB7 trust ${s.trust}${flag}${uncited}`);
    }
  } else {
    parts.push("_No sources in this dossier yet._");
  }
  parts.push("");
  return parts.join("\n");
}
function writeReportMarkdown(dir, out) {
  const md = buildReportMarkdown(dir);
  const path = out ?? join7(dir, "index.md");
  return writeArtifact(path, md);
}

// src/check.ts
import { existsSync as existsSync9, readFileSync as readFileSync9 } from "fs";
import { join as join9 } from "path";

// src/verify.ts
import { existsSync as existsSync8, readFileSync as readFileSync8 } from "fs";
import { join as join8 } from "path";
var HARD_FILES = ["REPORT.md"];
var VALID_VERDICTS = ["supported", "partial", "refuted", "unsupported"];
function claimStrings(text) {
  const out = [];
  for (const u of unitsOfFile(text)) {
    if (u.kind === "text") out.push(u.text);
    else for (const it of u.items) out.push(it);
  }
  return out;
}
function buildWorklist(dir, opts = {}) {
  const sources = readJson(join8(dir, "sources.json"), "sources.json");
  if (!Array.isArray(sources)) {
    throw new Error(`sources.json in ${dir} is not a JSON array \u2014 re-run \`ultrasearch gather\`.`);
  }
  const byId = new Map(sources.map((s) => [s.id, s]));
  const textCache = /* @__PURE__ */ new Map();
  const textOf = (s) => {
    let t = textCache.get(s.id);
    if (t === void 0) {
      t = readSourceText(dir, s);
      textCache.set(s.id, t);
    }
    return t;
  };
  const normCache = /* @__PURE__ */ new Map();
  const normOf = (s) => {
    let t = normCache.get(s.id);
    if (t === void 0) {
      t = normalizeNumeralText(textOf(s));
      normCache.set(s.id, t);
    }
    return t;
  };
  const pairs = [];
  let claimNo = 0;
  for (const file of HARD_FILES) {
    const p = join8(dir, file);
    if (!existsSync8(p)) continue;
    const text = readFileSync8(p, "utf8");
    for (const claim of claimStrings(text)) {
      const ids = unitSourceTokens(claim).filter((id) => byId.has(id));
      if (!ids.length) continue;
      claimNo++;
      const claimId = `C${claimNo}`;
      const nums = extractNumerals(claim);
      for (const id of ids) {
        const s = byId.get(id);
        const numeralsAbsent = nums.filter((n) => !normOf(s).includes(n));
        pairs.push({
          claimId,
          file,
          sourceId: id,
          claim: claim.trim().slice(0, 400),
          extractPath: s.extract,
          extractDigest: focusedSnippet(textOf(s), claim, { maxChars: 600, maxSentences: 4 }),
          ...numeralsAbsent.length ? { numeralsAbsent } : {},
          trust: s.trust
        });
      }
    }
  }
  const cmp = (a, b) => b.trust - a.trust || a.claimId.localeCompare(b.claimId) || a.sourceId.localeCompare(b.sourceId);
  const max = Math.max(1, Math.floor(opts.maxVerify ?? DEEP_CAPS.maxVerify));
  const kept = pairs.length > max ? pairs.slice().sort(cmp).slice(0, max) : pairs;
  const shards = opts.shards !== void 0 ? Math.max(1, Math.floor(opts.shards)) : void 0;
  const shard = shards !== void 0 ? Math.min(Math.max(0, Math.floor(opts.shard ?? 0)), shards - 1) : 0;
  const shaped = shards !== void 0 ? kept.slice().sort(cmp).filter((_, i) => i % shards === shard) : kept;
  const worklist = { run: dir, pairs: shaped.map(({ trust, ...rest }) => rest) };
  return { worklist, total: pairs.length, kept: shaped.length };
}
function runVerify(dir, opts = {}) {
  const { worklist, total, kept } = buildWorklist(dir, opts);
  const shards = opts.shards !== void 0 ? Math.max(1, Math.floor(opts.shards)) : void 0;
  const shard = shards !== void 0 ? Math.min(Math.max(0, Math.floor(opts.shard ?? 0)), shards - 1) : 0;
  const todo = {
    run: dir,
    pairs: worklist.pairs.map((p) => ({ ...p, verdict: null, note: "" }))
  };
  const todoName = shards !== void 0 ? `VERIFY.todo.${shard}.json` : "VERIFY.todo.json";
  const mdName = shards !== void 0 ? `VERIFY.${shard}.md` : "VERIFY.md";
  writeArtifact(join8(dir, todoName), JSON.stringify(todo, null, 2));
  writeArtifact(join8(dir, mdName), renderWorklistMd(worklist, total, kept));
  return worklist;
}
function renderWorklistMd(wl, total, kept) {
  const out = [];
  out.push(`# Verification worklist`);
  out.push("");
  out.push(
    `For each pair below, open the cited extract and judge whether it **supports** the claim. In \`VERIFY.todo.json\`, set each \`verdict\` to one of supported \xB7 partial \xB7 refuted \xB7 unsupported, add a short \`note\`, save it (e.g. as \`verdicts.json\`), then run \`ultrasearch verify --apply verdicts.json --run <dir>\`. A specific numeral/date/quantity asserted by the claim but absent from the cited extract caps the verdict at **partial** \u2014 never \`supported\` (flagged pairs carry a precomputed warning).`
  );
  if (kept < total) out.push(`
_Showing ${kept} of ${total} pair(s) \u2014 capped at the highest-trust sources._`);
  out.push("");
  for (const p of wl.pairs) {
    out.push(`## ${p.claimId} \xB7 ${p.sourceId}`);
    out.push(`**Claim:** ${p.claim}`);
    out.push(`**Cited source (\`${p.extractPath}\`):** ${p.extractDigest}`);
    if (p.numeralsAbsent?.length) {
      out.push(
        `**\u26A0 Numerals not found in this source's extract:** ${p.numeralsAbsent.join(", ")} \u2014 verdict caps at *partial* unless you locate them in the full extract.`
      );
    }
    out.push(`**Verdict:** _____ \xB7 **Note:** _____`);
    out.push("");
  }
  return out.join("\n");
}
function parseVerdictFile(verdictsPath) {
  const raw = readJson(verdictsPath, `verdicts file`);
  const list = Array.isArray(raw) ? raw : Array.isArray(raw?.pairs) ? raw.pairs : Array.isArray(raw?.verdicts) ? raw.verdicts : [];
  const verdicts = [];
  for (const v of list) {
    if (!v || typeof v.claimId !== "string" || typeof v.sourceId !== "string") continue;
    const verdict = VALID_VERDICTS.includes(v.verdict) ? v.verdict : void 0;
    verdicts.push({
      claimId: v.claimId,
      file: typeof v.file === "string" ? v.file : "",
      sourceId: v.sourceId,
      claim: typeof v.claim === "string" ? v.claim : "",
      extractPath: typeof v.extractPath === "string" ? v.extractPath : "",
      extractDigest: typeof v.extractDigest === "string" ? v.extractDigest : "",
      verdict,
      note: typeof v.note === "string" ? v.note : ""
    });
  }
  if (verdicts.length === 0) {
    throw new Error(
      `${verdictsPath}: no verdict rows found \u2014 expected a bare array, { pairs: [...] } or { verdicts: [...] } with at least one { claimId, sourceId, verdict, note } row (fail-closed: an empty fold would pass a 0/0 gate).`
    );
  }
  return verdicts;
}
function applyVerdicts(dir, verdictsPath) {
  const paths = Array.isArray(verdictsPath) ? verdictsPath : [verdictsPath];
  const merged = /* @__PURE__ */ new Map();
  for (const p of paths) {
    for (const v of parseVerdictFile(p)) {
      merged.set(`${v.claimId} ${v.sourceId}`, v);
    }
  }
  const verdicts = [...merged.values()];
  const result = reduceVerdicts(verdicts);
  writeArtifact(join8(dir, "VERIFY.json"), JSON.stringify({ ...result, verdicts }, null, 2));
  return result;
}
function reduceVerdicts(verdicts) {
  const counts = { supported: 0, partial: 0, refuted: 0, unsupported: 0 };
  for (const v of verdicts) if (v.verdict && counts[v.verdict] !== void 0) counts[v.verdict]++;
  const byClaim = /* @__PURE__ */ new Map();
  for (const v of verdicts) {
    const group = byClaim.get(v.claimId) ?? [];
    group.push(v);
    byClaim.set(v.claimId, group);
  }
  const failures = [];
  const unadjudicated = [];
  const contradictions = [];
  const uniqSorted = (ids) => [...new Set(ids)].sort((a, b) => a.localeCompare(b));
  for (const [claimId, group] of byClaim) {
    const adjudicated = group.filter((g) => !!g.verdict);
    if (adjudicated.length < group.length) unadjudicated.push(claimId);
    const refuted = adjudicated.find((g) => g.verdict === "refuted");
    const hasSupport = adjudicated.some((g) => g.verdict === "supported" || g.verdict === "partial");
    if (refuted) {
      failures.push({ claimId, sourceId: refuted.sourceId, verdict: "refuted", note: refuted.note });
    } else if (adjudicated.length === group.length && adjudicated.length > 0 && !hasSupport) {
      const u = adjudicated.find((g) => g.verdict === "unsupported") ?? adjudicated[0];
      failures.push({ claimId, sourceId: u.sourceId, verdict: u.verdict, note: u.note });
    }
    const supporting = adjudicated.filter((g) => g.verdict === "supported" || g.verdict === "partial");
    const refuting = adjudicated.filter((g) => g.verdict === "refuted");
    if (supporting.length && refuting.length) {
      const note = refuting.find((g) => g.note)?.note ?? supporting.find((g) => g.note)?.note ?? "";
      contradictions.push({
        claimId,
        supporting: uniqSorted(supporting.map((g) => g.sourceId)),
        refuting: uniqSorted(refuting.map((g) => g.sourceId)),
        note
      });
    }
  }
  return {
    ok: failures.length === 0,
    pairs: verdicts.length,
    adjudicated: verdicts.filter((v) => !!v.verdict).length,
    supported: counts.supported,
    partial: counts.partial,
    refuted: counts.refuted,
    unsupported: counts.unsupported,
    failures,
    unadjudicated,
    ...contradictions.length ? { contradictions } : {}
  };
}
function formatVerifyReport(r) {
  const lines = [];
  lines.push(`ultrasearch verify: ${r.adjudicated}/${r.pairs} pair(s) adjudicated`);
  lines.push(`  supported: ${r.supported} \xB7 partial: ${r.partial} \xB7 refuted: ${r.refuted} \xB7 unsupported: ${r.unsupported}`);
  for (const f of r.failures.slice(0, 12)) {
    lines.push(`  \u2717 ${f.claimId} (${f.sourceId}): ${f.verdict}${f.note ? " \u2014 " + f.note : ""}`);
  }
  if (r.unadjudicated.length) {
    lines.push(`  \u26A0 ${r.unadjudicated.length} claim(s) not fully adjudicated: ${r.unadjudicated.join(", ")}`);
  }
  lines.push(r.ok ? `  \u2713 every claim is backed by a cited source` : `  \u2717 some claims are refuted or unsupported`);
  return lines.join("\n");
}

// src/check.ts
var HARD_FILES2 = ["REPORT.md"];
var SOFT_FILES = ["SUMMARY.md", "glossary.md"];
var MIN_CLAIM_WORDS = 6;
function claimWordCount(unit) {
  const stripped = unit.replace(/\[[^\]\n]+\](?!\()/g, " ").replace(/\[([^\]]+)\]\([^)]*\)/g, "$1").replace(/[#>*`_~|]/g, " ");
  const words = stripped.split(/\s+/).filter((w) => /[\p{L}\p{N}]{2,}/u.test(w));
  return words.length;
}
function hasSourceToken(unit) {
  TOKEN_RE2.lastIndex = 0;
  let m;
  while (m = TOKEN_RE2.exec(unit)) if (SOURCE_RE.test(m[1].trim())) return true;
  return false;
}
function hasHintMarker(unit) {
  TOKEN_RE2.lastIndex = 0;
  let m;
  while (m = TOKEN_RE2.exec(unit)) if (m[1].trim() === "M") return true;
  return false;
}
function analyzeFile(file, text) {
  const lines = text.replace(/<!--[\s\S]*?-->/g, (m) => m.replace(/[^\n]/g, " ")).split("\n");
  const code = codeMask(lines);
  const { mask: hint, regions } = hintMask(lines);
  const appendix = appendixMask(lines);
  const sourceTokens = [];
  const appendixSourceTokens = [];
  const unknownTokens = [];
  let mMarkers = 0;
  for (let i = 0; i < lines.length; i++) {
    if (code[i]) continue;
    const masked = stripInlineCode(lines[i]);
    TOKEN_RE2.lastIndex = 0;
    let m;
    while (m = TOKEN_RE2.exec(masked)) {
      const tok = m[1].trim();
      if (SOURCE_RE.test(tok)) (appendix[i] ? appendixSourceTokens : sourceTokens).push(tok);
      else if (appendix[i])
        continue;
      else if (tok === "M") mMarkers++;
      else if (/^model-hint$/i.test(tok))
        continue;
      else unknownTokens.push(tok);
    }
  }
  const unsourcedClaims = [];
  const flag = (unit) => {
    if (claimWordCount(unit) < MIN_CLAIM_WORDS) return false;
    if (hasSourceToken(unit) || hasHintMarker(unit)) return false;
    unsourcedClaims.push(unit.trim().slice(0, 120));
    return true;
  };
  for (const u of extractUnits(
    lines,
    code,
    hint.map((h, i) => h || appendix[i])
  )) {
    if (u.kind === "text") {
      flag(u.text);
    } else {
      let any = false;
      for (const it of u.items) any = flag(it) || any;
      if (!any) {
        const joined = u.items.join(" ");
        const grouped = u.items.join("\n");
        if (claimWordCount(joined) >= MIN_CLAIM_WORDS && !hasSourceToken(grouped) && !hasHintMarker(grouped)) {
          unsourcedClaims.push(joined.trim().slice(0, 120));
        }
      }
    }
  }
  return { file, sourceTokens, appendixSourceTokens, modelHints: mMarkers + regions, unknownTokens, unsourcedClaims };
}
function applySemantic(dir, result, requireVerify) {
  const flag = requireVerify ? "--require-verify" : "--semantic";
  const p = join9(dir, "VERIFY.json");
  if (!existsSync9(p)) {
    result.ok = false;
    result.errors.push(`${flag}: no VERIFY.json \u2014 run \`verify\` then \`verify --apply <verdicts.json>\` before the semantic gate.`);
    return;
  }
  let stored;
  try {
    stored = JSON.parse(readFileSync9(p, "utf8"));
  } catch (e) {
    result.ok = false;
    result.errors.push(`${flag}: VERIFY.json is unreadable (${e.message}) \u2014 re-run \`verify --apply <verdicts.json>\`.`);
    return;
  }
  const verdicts = Array.isArray(stored.verdicts) ? stored.verdicts : [];
  const reduced = reduceVerdicts(verdicts);
  result.semantic = { ...reduced, verdicts };
  if (!reduced.adjudicated) {
    result.ok = false;
    result.errors.push(`${flag}: VERIFY.json has 0 adjudicated claim(s) \u2014 fill the verdicts and \`verify --apply\` before the gate.`);
    return;
  }
  if (stored.ok !== reduced.ok) {
    result.warnings.push("VERIFY.json's stored gate disagrees with its verdicts[] \u2014 re-reduced from the verdicts at check time.");
  }
  if (!reduced.ok) {
    result.ok = false;
    result.errors.push(`Semantic verification failed: ${reduced.failures.length} claim(s) refuted or unsupported by their cited source (see VERIFY.json).`);
  }
  if (requireVerify) {
    let expected = [];
    try {
      expected = buildWorklist(dir).worklist.pairs;
    } catch {
      expected = [];
    }
    const adjudicatedKeys = new Set(verdicts.filter((v) => !!v.verdict).map((v) => `${v.claimId}\0${v.sourceId}`));
    const uncovered = expected.filter((p2) => !adjudicatedKeys.has(`${p2.claimId}\0${p2.sourceId}`));
    if (uncovered.length) {
      result.ok = false;
      const claims = [...new Set(uncovered.map((p2) => p2.claimId))];
      result.errors.push(
        `${flag}: ${uncovered.length} claim\u2194source pair(s) in REPORT have no verdict in VERIFY.json (${claims.slice(0, 6).join(", ")}${claims.length > 6 ? ", \u2026" : ""}) \u2014 re-run \`verify\` + \`verify --apply\` so every cited claim is adjudicated (the exit gate must not pass on dropped verdicts).`
      );
    }
  }
  if (reduced.unadjudicated?.length) {
    result.warnings.push(`${reduced.unadjudicated.length} claim(s) not fully adjudicated by verify.`);
  }
  if (reduced.contradictions?.length) {
    result.warnings.push(
      `${reduced.contradictions.length} claim(s) have contradicting cited sources: ${reduced.contradictions.map((c) => c.claimId).join(", ")} (see VERIFY.json).`
    );
  }
}
function readManifestSafe(dir) {
  try {
    return JSON.parse(readFileSync9(join9(dir, "manifest.json"), "utf8"));
  } catch {
    return void 0;
  }
}
function runCheck(dir, opts = {}) {
  const errors = [];
  const warnings = [];
  const sourcesPath = join9(dir, "sources.json");
  if (!existsSync9(sourcesPath)) {
    return blank(false, [`No sources.json in ${dir} \u2014 run \`ultrasearch gather\` first.`]);
  }
  let sources;
  try {
    sources = JSON.parse(readFileSync9(sourcesPath, "utf8"));
  } catch (e) {
    return blank(false, [`sources.json is unreadable: ${e.message}`]);
  }
  if (!Array.isArray(sources)) {
    return blank(false, [`sources.json in ${dir} is not a JSON array \u2014 re-run \`ultrasearch gather\`.`]);
  }
  const ids = new Set(sources.map((s) => s.id));
  const present = [...HARD_FILES2, ...SOFT_FILES].filter((f) => existsSync9(join9(dir, f)));
  if (!present.some((f) => HARD_FILES2.includes(f))) {
    return blank(false, [`No REPORT.md in ${dir} \u2014 write the report tier, then re-run check.`]);
  }
  const analyses = present.map((f) => analyzeFile(f, readFileSync9(join9(dir, f), "utf8")));
  const danglingSet = /* @__PURE__ */ new Set();
  const citedIds = /* @__PURE__ */ new Set();
  let sourceCitations = 0;
  let modelHints = 0;
  const unknown = /* @__PURE__ */ new Set();
  const unmarkedUnsourced = [];
  for (const a of analyses) {
    modelHints += a.modelHints;
    for (const tok of a.sourceTokens) {
      if (ids.has(tok)) {
        sourceCitations++;
        citedIds.add(tok);
      } else {
        danglingSet.add(tok);
      }
    }
    for (const tok of a.appendixSourceTokens) {
      if (!ids.has(tok)) danglingSet.add(tok);
    }
    for (const u of a.unknownTokens) unknown.add(u);
    if (HARD_FILES2.includes(a.file)) {
      for (const c of a.unsourcedClaims) unmarkedUnsourced.push({ file: a.file, text: c });
    }
  }
  const dangling = [...danglingSet];
  const uncitedSources = sources.map((s) => s.id).filter((id) => !citedIds.has(id));
  if (sourceCitations === 0) {
    errors.push("No source citations found \u2014 a grounded report must cite sources like [S1].");
  }
  if (dangling.length) {
    errors.push(`Dangling citation(s) not in sources.json: ${dangling.join(", ")}`);
  }
  if (unmarkedUnsourced.length) {
    errors.push(
      `${unmarkedUnsourced.length} unsourced claim(s) in REPORT with no [S#] and no model-hint flag. Cite a source or flag as [M] / > [model-hint].`
    );
  }
  if (unknown.size) {
    warnings.push(`${unknown.size} bracketed non-citation token(s) ignored: ${[...unknown].slice(0, 5).join(", ")}.`);
  }
  if (uncitedSources.length) {
    warnings.push(`${uncitedSources.length} source(s) were never cited (informational).`);
  }
  const walled = [];
  const apiCited = [];
  for (const s of sources) {
    if (!citedIds.has(s.id)) continue;
    if (isApiEndpoint(s.url)) apiCited.push(s.id);
    try {
      if (!existsSync9(join9(dir, s.extract))) continue;
      const wall = looksLikeJunkExtraction(readSourceText(dir, s));
      if (wall) walled.push(`${s.id} (${wall})`);
    } catch {
    }
  }
  if (walled.length) {
    warnings.push(
      `${walled.length} cited source(s) extracted to a wall, not content: ${walled.slice(0, 5).join(", ")}. Re-\`fetch --url\` them (the page may have been throttling) or drop the claims that rest on them.`
    );
  }
  if (apiCited.length) {
    warnings.push(
      `${apiCited.length} cited source(s) point at an API endpoint, not a page a reader can open: ${apiCited.slice(0, 5).join(", ")}. Re-\`fetch --url\` them \u2014 the endpoint is where the text lives, the landing page is what gets cited.`
    );
  }
  const numeralIssues = [];
  const bySourceId = new Map(sources.map((s) => [s.id, s]));
  const normCache = /* @__PURE__ */ new Map();
  const normOf = (id) => {
    let t = normCache.get(id);
    if (t === void 0) {
      const s = bySourceId.get(id);
      try {
        t = s && existsSync9(join9(dir, s.extract)) ? normalizeNumeralText(readSourceText(dir, s)) : null;
      } catch {
        t = null;
      }
      normCache.set(id, t);
    }
    return t;
  };
  for (const f of present) {
    if (!HARD_FILES2.includes(f)) continue;
    for (const u of unitsOfFile(readFileSync9(join9(dir, f), "utf8"))) {
      for (const claim of u.kind === "text" ? [u.text] : u.items) {
        const cited = unitSourceTokens(claim).filter((id) => ids.has(id));
        if (!cited.length) continue;
        const nums = extractNumerals(claim);
        if (!nums.length) continue;
        const texts = cited.map(normOf).filter((t) => t !== null);
        if (!texts.length) continue;
        for (const n of nums) {
          if (!texts.some((t) => t.includes(n))) {
            numeralIssues.push({ file: f, claim: claim.trim().slice(0, 120), numeral: n, sourceIds: cited });
          }
        }
      }
    }
  }
  if (numeralIssues.length) {
    const eg = numeralIssues[0];
    const msg = `${numeralIssues.length} numeral(s) in cited claim(s) not found in any cited source extract (e.g. "${eg.numeral}" cited to ${eg.sourceIds.join(", ")}). Verify the attribution, \`fetch --url\` the page that carries the figure, or flag it [M].`;
    if (opts.strictNumerals) errors.push(`--strict-numerals: ${msg}`);
    else warnings.push(msg);
  }
  const manifest = readManifestSafe(dir);
  if (manifest?.recallFloor) {
    warnings.push(
      `Thin dossier: ${manifest.recallFloor.count} source(s) retrieved (recall floor ${manifest.recallFloor.floor}) \u2014 run another WebSearch round and fold it in with \`ingest --run <dir> --web-results <f.json>\` before relying on it.`
    );
  }
  if (manifest?.coverage?.under.length) {
    warnings.push(
      `Under-covered question term(s): ${manifest.coverage.under.slice(0, 6).join(", ")} \u2014 the dossier may not support claims about them; enrich with \`fetch --url\` or say so under "Open questions".`
    );
  }
  if (opts.minSources !== void 0 && sources.length < opts.minSources) {
    errors.push(
      `Only ${sources.length} source(s) in the dossier (--min-sources ${opts.minSources}). Enrich with \`fetch --url\` or broaden the gather before relying on this report.`
    );
  }
  const result = {
    ok: errors.length === 0,
    ...numeralIssues.length ? { numeralIssues } : {},
    filesChecked: present,
    sourceCitations,
    modelHints,
    dangling,
    unmarkedUnsourced,
    uncitedSources,
    unknownTokens: [...unknown],
    errors,
    warnings
  };
  if (opts.semantic || opts.requireVerify) applySemantic(dir, result, opts.requireVerify === true);
  return result;
}
function blank(ok, errors) {
  return {
    ok,
    filesChecked: [],
    sourceCitations: 0,
    modelHints: 0,
    dangling: [],
    unmarkedUnsourced: [],
    uncitedSources: [],
    unknownTokens: [],
    errors,
    warnings: []
  };
}
function formatCheckReport(r, dir) {
  const lines = [];
  lines.push(`ultrasearch check: ${dir}`);
  lines.push(`  files: ${r.filesChecked.join(", ") || "none"}`);
  lines.push(`  citations: ${r.sourceCitations} \xB7 model-hints: ${r.modelHints} \xB7 dangling: ${r.dangling.length} \xB7 unsourced: ${r.unmarkedUnsourced.length}`);
  for (const u of r.unmarkedUnsourced.slice(0, 8)) lines.push(`  \u2717 [${u.file}] unsourced: "${u.text}\u2026"`);
  for (const n of (r.numeralIssues ?? []).slice(0, 5))
    lines.push(`  \u26A0 [${n.file}] numeral "${n.numeral}" not in ${n.sourceIds.join("/")}: "${n.claim.slice(0, 80)}\u2026"`);
  if (r.semantic) {
    const s = r.semantic;
    lines.push(`  semantic: supported ${s.supported} \xB7 partial ${s.partial} \xB7 refuted ${s.refuted} \xB7 unsupported ${s.unsupported}`);
    for (const f of s.failures.slice(0, 8)) lines.push(`  \u2717 semantic ${f.claimId} (${f.sourceId}): ${f.verdict}`);
  }
  for (const e of r.errors) lines.push(`  \u2717 ${e}`);
  for (const w of r.warnings) lines.push(`  \u26A0 ${w}`);
  lines.push(r.ok ? `  \u2713 report is grounded \u2014 every claim cites a source or is a flagged hint` : `  \u2717 report is NOT grounded`);
  return lines.join("\n");
}

// src/relink.ts
function listIssues(dir) {
  const { sources } = readDossier(dir);
  const issues = [];
  for (const s of sources) {
    const text = safeText(dir, s);
    if (!isCitableUrl(s.url)) {
      const derived = text ? deriveCitableUrl(text) : void 0;
      const twin = derived ? sources.find((o) => o.id !== s.id && o.canonicalUrl === canonicalizeUrl(derived)) : void 0;
      issues.push({
        id: s.id,
        url: s.url,
        reason: twin ? "duplicate" : "not-citable",
        // No derivation means the payload named nothing — so hand over what a
        // SEARCH can start from instead of a dead end. Reconstructing the page
        // from a title and an opening paragraph is the agent's job, not a
        // regex's.
        ...derived ? {} : { evidence: { title: s.title === s.url ? titleFromText(text) : s.title, excerpt: text.replace(/\s+/g, " ").trim().slice(0, 400) } },
        detail: twin ? `the url is a machine endpoint, and the document it names is already in the dossier as ${twin.id}` : "the url is a machine endpoint \u2014 a reader who clicks it gets a payload, not the document",
        ...derived ? { derived } : {},
        fix: twin ? `cite ${twin.id} instead and drop ${s.id}'s citations, or relink ${s.id} to a different page` : derived ? `its own text names ${derived} \u2014 \`relink --run <dir>\` applies that for you` : `its text names no document \u2014 search for it with the evidence below, then: relink --run <dir> --id ${s.id} --url "<page>"`
      });
      continue;
    }
    const wall = text ? looksLikeJunkExtraction(text) : void 0;
    if (wall) {
      issues.push({
        id: s.id,
        url: s.url,
        reason: "wall",
        detail: `the extract is a ${wall}, not the document \u2014 the host was throttling when it was fetched`,
        fix: `the text is missing, not just the link: re-run \`fetch --url "${s.url}"\` into a dossier, or drop the claims resting on it`
      });
    }
  }
  return issues;
}
function autoRelink(dir) {
  const repaired = [];
  const tried = /* @__PURE__ */ new Set();
  for (; ; ) {
    const next = listIssues(dir).find((i) => i.reason === "not-citable" && i.derived && !tried.has(i.id));
    if (!next) break;
    tried.add(next.id);
    const r = relink(dir, next.id, next.derived);
    if (r.relinked) repaired.push(r);
  }
  return { repaired, remaining: listIssues(dir) };
}
function safeText(dir, s) {
  try {
    return readSourceText(dir, s);
  } catch {
    return "";
  }
}
function relink(dir, id, url, opts = {}) {
  const { sources, manifest } = readDossier(dir);
  const idx = sources.findIndex((s) => s.id === id);
  if (idx < 0) return { id, relinked: false, note: `${id} is not in this dossier` };
  const target = sources[idx];
  const next = url.trim();
  if (!isCitableUrl(next)) {
    return { id, relinked: false, note: `${next} is not a citable page url \u2014 a citation must open in a browser` };
  }
  const canon = canonicalizeUrl(next);
  if (canon === target.canonicalUrl) return { id, relinked: false, note: `${id} already points at ${next}` };
  const clash = sources.find((s) => s.id !== id && s.canonicalUrl === canon);
  if (clash) return { id, relinked: false, note: `${clash.id} already cites ${next} \u2014 merge the claims onto it instead of duplicating the source` };
  const from = target.url;
  const text = safeText(dir, target);
  const titled = target.title && target.title !== from ? target.title : titleFromText(text) || next;
  const relinked = {
    ...target,
    url: next,
    canonicalUrl: canon,
    domain: domainOf(next),
    trust: trustScore(next, target.backend),
    title: opts.title || titled,
    // Where the text came from stays on the record: the claim is grounded in
    // that payload, and a reader auditing the source deserves to know.
    meta: { ...target.meta, textVia: target.meta?.textVia ?? from }
  };
  const nextSources = [...sources];
  nextSources[idx] = relinked;
  writeSourceExtract(dir, relinked, text, manifest.depth);
  writeDossierIndex(dir, nextSources, refreshed(manifest, nextSources), getMode(manifest.mode).template);
  return { id, relinked: true, from, to: next };
}
function refreshed(manifest, sources) {
  return { ...manifest, sourceCount: sources.length };
}

// src/plan.ts
import { join as join10 } from "path";
var SKIP_HEADING = /^(tl;?dr|abstract\b|executive summary|sources\b|references\b|further reading|solutions\b)/i;
function subjectOf(question) {
  const bare = question.trim().replace(/\?+\s*$/, "");
  let s = bare;
  const strip = /^(please\s+)?(deep\s+|thoroughly\s+|exhaustively\s+)?(research(?:\s+on)?|explain|describe|tell me about|teach me|give me|summari[sz]e|what(?:'s| is| are)?|how (?:do(?:es)?|to)|why (?:is|are|do(?:es)?)|when (?:did|was)|who (?:is|are))\b[:\s]*/i;
  let prev;
  do {
    prev = s;
    s = s.replace(strip, "").trim();
  } while (s !== prev && s.length > 0);
  s = s.replace(/^(about|on|regarding|of)\s+/i, "").replace(/^(the|a|an)\s+/i, "").trim();
  return keywords(s).length >= 2 ? s : bare;
}
var FACET_PATTERNS = [
  // topic / research
  {
    re: /what it is|definition/i,
    ask: (s) => `What is ${s} and how is it defined?`,
    angle: "what are the key concepts and how are they defined",
    terms: ["definition", "overview"]
  },
  {
    re: /how it works|key concepts|mechanism/i,
    ask: (s) => `How does ${s} work under the hood?`,
    angle: "how do the underlying mechanisms work",
    terms: ["how it works", "internals"]
  },
  {
    re: /history|evolution|background|motivation/i,
    ask: (s) => `What is the history and motivation behind ${s}?`,
    angle: "what is the history and motivation",
    terms: ["history", "origin"]
  },
  {
    re: /current state|today/i,
    ask: (s) => `What is the current state of ${s} today?`,
    angle: "what is the current state today",
    terms: ["current", "latest"]
  },
  {
    re: /variants|approaches|alternatives|compar|methods/i,
    ask: (s) => `What are the main variants and approaches to ${s}, and how do they compare?`,
    angle: "what are the main approaches and how do they compare",
    terms: ["comparison", "alternatives"]
  },
  {
    re: /controvers|debate|gaps|open problem/i,
    ask: (s) => `What are the open debates, gaps or limitations of ${s}?`,
    angle: "what are the open debates, gaps or limitations",
    terms: ["limitations", "criticism"]
  },
  {
    re: /practical|implication|future direction/i,
    ask: (s) => `What are the practical implications and future directions of ${s}?`,
    angle: "what are the practical implications and future directions",
    terms: ["best practices", "use cases"]
  },
  {
    re: /key papers|literature/i,
    ask: (s) => `What are the key papers and prior work on ${s}?`,
    angle: "what are the key papers and prior work",
    terms: ["paper", "prior work"]
  },
  {
    re: /findings|consensus|results/i,
    ask: (s) => `What are the main findings and consensus on ${s}?`,
    angle: "what are the main findings and consensus",
    terms: ["findings", "evidence"]
  },
  // bug
  {
    re: /symptom|reproduction/i,
    ask: (s) => `What are the symptoms and how do you reproduce ${s}?`,
    angle: "what are the symptoms and how is it reproduced",
    terms: ["error", "reproduce"]
  },
  { re: /root cause/i, ask: (s) => `What is the root cause of ${s}?`, angle: "what is the root cause", terms: ["root cause", "why"] },
  {
    re: /candidate fix|fixes|solution/i,
    ask: (s) => `What are the candidate fixes for ${s}?`,
    angle: "what are the candidate fixes",
    terms: ["fix", "resolve"]
  },
  {
    re: /related issues|versions affected/i,
    ask: (s) => `What related issues or affected versions are known for ${s}?`,
    angle: "what related issues or affected versions are known",
    terms: ["issue", "version"]
  },
  { re: /workaround/i, ask: (s) => `What workarounds exist for ${s}?`, angle: "what workarounds exist", terms: ["workaround", "mitigation"] },
  { re: /diagnostic/i, ask: (s) => `What further diagnostics help when ${s} persists?`, angle: "what further diagnostics help", terms: ["debug", "diagnose"] },
  // learn
  {
    re: /learning objective|objectives/i,
    ask: (s) => `What should someone learn first about ${s}?`,
    angle: "what should someone learn first",
    terms: ["basics", "introduction"]
  },
  {
    re: /prerequisite/i,
    ask: (s) => `What are the prerequisites for learning ${s}?`,
    angle: "what are the prerequisites",
    terms: ["prerequisite", "fundamentals"]
  },
  { re: /lesson|glossary|concept/i, ask: (s) => `What are the core concepts of ${s}?`, angle: "what are the core concepts", terms: ["concept", "explanation"] },
  {
    re: /worked example|example/i,
    ask: (s) => `What are good worked examples of ${s}?`,
    angle: "what are good worked examples",
    terms: ["example", "tutorial"]
  },
  { re: /exercise/i, ask: (s) => `What exercises help practise ${s}?`, angle: "what exercises help build proficiency", terms: ["exercise", "practice"] },
  // startup
  {
    re: /problem|customer/i,
    ask: (s) => `What problem does ${s} solve and for which customers?`,
    angle: "what problem is solved and for which customers",
    terms: ["problem", "customer"]
  },
  {
    re: /market siz/i,
    ask: (s) => `How large is the market for ${s} (TAM/SAM/SOM)?`,
    angle: "how large is the market (TAM/SAM/SOM)",
    terms: ["market size", "TAM"]
  },
  {
    re: /competit/i,
    ask: (s) => `Who are the competitors in ${s} and how are they positioned?`,
    angle: "who are the competitors and how are they positioned",
    terms: ["competitor", "alternatives"]
  },
  {
    re: /pricing|business model/i,
    ask: (s) => `What pricing and business models are used in ${s}?`,
    angle: "what pricing and business models are used",
    terms: ["pricing", "business model"]
  },
  {
    re: /go-to-market|channel/i,
    ask: (s) => `What go-to-market channels work for ${s}?`,
    angle: "what go-to-market channels work",
    terms: ["go to market", "acquisition"]
  },
  {
    re: /trends|timing/i,
    ask: (s) => `What trends and timing favour ${s} now?`,
    angle: "what trends and timing are favourable now",
    terms: ["trend", "timing"]
  },
  { re: /risks|moats/i, ask: (s) => `What are the risks and moats for ${s}?`, angle: "what are the risks and moats", terms: ["risk", "moat"] }
];
var CLAUSE_VERB = /\b(is|are|was|were|be|been|being|do|does|did|has|have|had|can|could|should|would|will|shall|may|might|must|compares?|compared|works?|worked|deploys?|deployed|builds?|creates?|uses?|implements?|runs?|configures?|installs?|handles?|manages?|scales?|optimi[sz]es?|chooses?|migrates?|fix(?:es)?|debugs?|prevents?|avoids?|improves?|reduces?|increases?|affects?|causes?|differs?|relates?|applies|integrates?|connects?|stores?|processes?|generates?|renders?|parses?|validates?|measures?|monitors?)\b/i;
function isClausalSubject(subject) {
  const words = subject.split(/\s+/).filter(Boolean);
  return words.length >= 8 || CLAUSE_VERB.test(subject);
}
function clauseSafe(question, angle) {
  const topic = question.trim().replace(/\?+\s*$/, "");
  return `In the context of "${topic}", ${angle}?`;
}
function facetQuestion(subject, heading, question) {
  const clausal = question !== void 0 && isClausalSubject(subject);
  for (const p of FACET_PATTERNS) {
    if (p.re.test(heading)) {
      return { question: clausal ? clauseSafe(question, p.angle) : p.ask(subject), terms: p.terms };
    }
  }
  const generic = clausal ? clauseSafe(question, `what does the evidence say about ${heading.toLowerCase()}`) : `What does the evidence say about ${heading.toLowerCase()} for ${subject}?`;
  return { question: generic, terms: keywords(heading).slice(0, 2) };
}
function dedupeQueries(qs) {
  const seen = /* @__PURE__ */ new Set();
  const out = [];
  for (const q of qs) {
    const k = q.trim().toLowerCase();
    if (!k || seen.has(k)) continue;
    seen.add(k);
    out.push(q.trim());
  }
  return out;
}
function mk(question, facet, rationale, queries) {
  return { id: "", question, facet, queries: queries ?? planVariants(question, "deep"), rationale };
}
function templateFacets(question, template) {
  const subject = subjectOf(question);
  const subjKeywords = rankedKeywords(subject).slice(0, 3).join(" ");
  const out = [];
  for (const line of template.split("\n")) {
    const m = /^##\s+(.+?)\s*$/.exec(line.trim());
    if (!m) continue;
    const heading = m[1].trim();
    if (SKIP_HEADING.test(heading)) continue;
    const fq = facetQuestion(subject, heading, question);
    const facetQuery = `${subjKeywords} ${fq.terms.slice(0, 2).join(" ")}`.trim();
    const queries = dedupeQueries([...planVariants(fq.question, "deep").slice(0, 2), facetQuery]);
    out.push(mk(fq.question, "template", `mode facet: ${heading}`, queries));
  }
  return out;
}
function runPlan(question, mode, override, cap = DEEP_CAPS.maxSubQuestions, runRoot, depth) {
  const q = question.trim();
  let subs;
  if (override?.length) {
    subs = override.map((s) => mk(s.trim(), "agent", "agent-supplied"));
  } else {
    subs = [];
    const idents = extractIdentifiers(q);
    if (idents.length) subs.push(mk(`${q} ${idents.join(" ")}`, "identifier", `identifiers: ${idents.join(", ")}`));
    subs.push(...templateFacets(q, getMode(mode).template));
    if (subs.length < 3) {
      for (const term of rankedKeywords(q).slice(0, 3 - subs.length)) {
        subs.push(mk(`${q} ${term}`, "keyword", `distinctive term: ${term}`));
      }
    }
  }
  const seen = /* @__PURE__ */ new Set();
  const usedQueries = /* @__PURE__ */ new Set();
  const uniq = [];
  const limit = Math.max(1, Math.floor(cap));
  for (const s of subs) {
    const key = s.question.toLowerCase();
    if (!s.question || seen.has(key)) continue;
    seen.add(key);
    const q2 = s.queries.filter((v) => {
      const k = v.toLowerCase();
      if (usedQueries.has(k)) return false;
      usedQueries.add(k);
      return true;
    });
    s.queries = q2.length ? q2 : s.queries.slice(0, 1);
    uniq.push(s);
    if (uniq.length >= limit) break;
  }
  uniq.forEach((s, i) => {
    s.id = `Q${i + 1}`;
    if (runRoot) s.out = join10(runRoot, s.id.toLowerCase());
  });
  const result = { question: q, mode, ...depth ? { depth } : {}, subQuestions: uniq };
  if (runRoot) {
    ensureDir(runRoot);
    writeArtifact(join10(runRoot, "PLAN.json"), JSON.stringify(result, null, 2));
  }
  return result;
}

// src/queries.ts
var TARGET_PER_DEPTH = { summary: 2, standard: 4, deep: 8 };
function planQueries(opts) {
  const lang = opts.lang ?? "en";
  const mode = getMode(opts.mode);
  const target = TARGET_PER_DEPTH[opts.depth];
  return {
    question: opts.question,
    mode: opts.mode,
    depth: opts.depth,
    lang,
    target,
    planned: planVariants(opts.question, opts.depth),
    angles: mode.searchAngles.slice(0, target),
    next: `Run your own WebSearch once per angle, pool EVERY hit into one JSON array, then: ultrasearch gather --q "${opts.question}" --mode ${opts.mode} --depth ${opts.depth} --web-results <hits.json>`
  };
}
function formatQueryPlan(plan) {
  const lines = [
    `ultrasearch: WebSearch worklist for "${plan.question}"`,
    `  mode: ${plan.mode} \xB7 depth: ${plan.depth} \xB7 search language: ${plan.lang}`,
    ``,
    // Say the budget AND what it covers. Announcing "run 8" over a list of 6
    // is the kind of small dishonesty that teaches an agent to stop reading.
    plan.angles.length >= plan.target ? `Run ${plan.target} DISTINCT WebSearch queries \u2014 one per angle, phrased in ${plan.lang}:` : `Run ${plan.target} DISTINCT WebSearch queries, phrased in ${plan.lang} \u2014 these ${plan.angles.length} angles, then ${plan.target - plan.angles.length} of your own:`,
    ...plan.angles.map((a, i) => `  ${i + 1}. ${a}`),
    ``,
    `Starting points from the built-in planner (yours will be better):`,
    ...plan.planned.map((q) => `  \xB7 ${q}`),
    ``,
    `Then pool every hit into one JSON array \u2014 [{"url":\u2026,"title":\u2026,"snippet":\u2026}, \u2026] \u2014 and:`,
    `  ultrasearch gather --q "${plan.question}" --mode ${plan.mode} --depth ${plan.depth} --web-results <hits.json>`
  ];
  return lines.join("\n") + "\n";
}

// src/brainstorm.ts
import { join as join11 } from "path";
var PROBE_BACKENDS = ["wikipedia", "duckduckgo"];
var PROBE_CAP = 10;
var INTERROGATIVE = /\?|^\s*(what|how|why|when|who|whom|which|whose|is|are|was|were|does|do|did|can|could|should|would|will)\b/i;
function titleTokens(title) {
  return [...new Set(keywords(title).map((k) => foldTerm(k)))].filter((t) => t.length >= 2);
}
function jaccard(a, b) {
  if (!a.size || !b.size) return 0;
  let inter = 0;
  for (const x of a) if (b.has(x)) inter++;
  return inter / (a.size + b.size - inter);
}
function clusterTitles(results) {
  const clusters = [];
  for (const r of results) {
    const toks = new Set(titleTokens(r.title));
    if (!toks.size) continue;
    const hit = clusters.find((c) => jaccard(c.tokens, toks) >= 0.2);
    if (hit) {
      hit.titles.push(r);
      for (const t of toks) hit.tokens.add(t);
    } else {
      clusters.push({ titles: [r], tokens: new Set(toks) });
    }
  }
  return clusters;
}
function angleLabel(cluster) {
  const freq = /* @__PURE__ */ new Map();
  for (const t of cluster.titles) for (const tok of titleTokens(t.title)) freq.set(tok, (freq.get(tok) ?? 0) + 1);
  const terms = [...freq.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).slice(0, 3).map(([t]) => t);
  return { label: terms.join(" ") || cluster.titles[0].title.slice(0, 40), terms };
}
function detectSignals(question, clusters) {
  const words = keywords(question).length;
  const interrogative = INTERROGATIVE.test(question.trim());
  const identifiers = extractIdentifiers(question);
  const reasons = [];
  if (words <= 3) reasons.push(`Only ${words} content word(s) \u2014 too broad to scope.`);
  if (!interrogative && words <= 5) reasons.push("Not phrased as a question and quite short \u2014 intent is unclear.");
  if (clusters >= 3 && words <= 4 && !interrogative) {
    reasons.push(`The probe spans ${clusters} unrelated topic clusters \u2014 the term may be ambiguous.`);
  }
  return { words, interrogative, identifiers, clusters, ambiguous: reasons.length > 0, reasons };
}
function buildUserQuestions(angles, signals) {
  const qs = [];
  if (angles.length >= 2) {
    qs.push(
      `Which of these do you mean: ${angles.slice(0, 3).map((a) => a.label).join(" \xB7 ")}? (or something else)`
    );
  }
  qs.push("Who is this for, and how deep should it go \u2014 a quick overview or a thorough deep dive?");
  if (!signals.identifiers.some((id) => /^\d{4}$/.test(id))) {
    qs.push("Any timeframe or recency constraint \u2014 the current state, or the historical picture too?");
  }
  if (qs.length < 4) {
    qs.push("What angle fits best: a general briefing, debugging an error, a literature review, learning it, or market research?");
  }
  return qs.slice(0, 4);
}
function buildCandidateQuestions(question, mode, angles) {
  const headings = getMode(mode).template.split("\n").map((l) => /^##\s+(.+?)\s*$/.exec(l.trim())?.[1]?.trim()).filter((h) => !!h && !/^(tl;?dr|abstract|executive summary|sources|references)/i.test(h)).slice(0, 2);
  const subjects = [subjectOf(question), ...angles.map((a) => a.label)];
  const out = [];
  const seen = /* @__PURE__ */ new Set();
  for (const subject of subjects) {
    for (const heading of headings) {
      const fq = facetQuestion(subject, heading);
      const key = fq.question.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({ question: fq.question, facet: heading, rationale: `angle: ${subject}` });
      if (out.length >= 6) return out;
    }
  }
  return out;
}
async function runBrainstorm(options) {
  const mode = getMode(options.mode);
  const backends = options.backends?.length ? options.backends : PROBE_BACKENDS;
  const ctx = { question: options.question, mode, options: { ...options, perSource: 5 }, variants: [options.question] };
  const backendResults = await runBackends(backends, ctx);
  const notes = backendResults.flatMap((r) => r.notes);
  const fused = fuse(backendResults.map((r) => r.items)).slice(0, PROBE_CAP);
  const results = fused.map((s) => ({ title: s.title, url: s.url, domain: domainOf(s.url) }));
  const clusters = clusterTitles(results);
  const angles = clusters.slice().sort((a, b) => b.titles.length - a.titles.length).slice(0, 4).map((c) => {
    const { label, terms } = angleLabel(c);
    return { label, terms, examples: c.titles.slice(0, 2).map((t) => ({ title: t.title, domain: t.domain })) };
  });
  const signals = detectSignals(options.question, clusters.length);
  const candidateQuestions = buildCandidateQuestions(options.question, options.mode, angles);
  const userQuestions = buildUserQuestions(angles, signals);
  const dir = options.out ?? defaultRunDir("brainstorm", options.question);
  const result = {
    question: options.question,
    mode: options.mode,
    dir,
    probe: { backendsUsed: backends, results, notes },
    signals,
    angles,
    candidateQuestions,
    userQuestions
  };
  ensureDir(dir);
  writeArtifact(join11(dir, "BRAINSTORM.json"), JSON.stringify(result, null, 2));
  writeArtifact(join11(dir, "BRAINSTORM.md"), renderBrainstormMd(result));
  return result;
}
function renderBrainstormMd(r) {
  const out = [];
  out.push(`# Brainstorm \u2014 ${r.question}`, "");
  out.push(
    r.signals.ambiguous ? `**This question looks under-specified.** ${r.signals.reasons.join(" ")}` : "**This question looks specific enough to research directly.**",
    ""
  );
  if (r.angles.length) {
    out.push("## Candidate angles", "");
    for (const a of r.angles) {
      const eg = a.examples.map((e) => `${e.title} (${e.domain})`).join("; ");
      out.push(`- **${a.label}**${eg ? ` \u2014 e.g. ${eg}` : ""}`);
    }
    out.push("");
  }
  if (r.candidateQuestions.length) {
    out.push("## Candidate refined questions", "");
    for (const c of r.candidateQuestions) out.push(`- ${c.question}  _(${c.facet})_`);
    out.push("");
  }
  out.push("## Questions to ask the user", "");
  for (const q of r.userQuestions) out.push(`- ${q}`);
  out.push("");
  return out.join("\n");
}

// src/merge.ts
function toRawSource(s, text) {
  return {
    url: s.url,
    title: s.title,
    backend: s.backend,
    score: s.score,
    snippet: s.snippet,
    text,
    lang: s.lang,
    meta: s.meta,
    // Carry the snippet-only quality flag into the master dossier so the
    // deep-research report (written against the master) still sees it. Only when
    // false, so full-text sources keep a byte-identical merged sources.json.
    ...s.fullText === false ? { fullText: false } : {}
  };
}
function runMerge(options) {
  if (!options.runs.length) throw new Error("merge needs at least one --runs dossier");
  const dossiers = options.runs.map((dir2) => ({ dir: dir2, ...readDossier(dir2) }));
  const lists = [];
  const provByKey = /* @__PURE__ */ new Map();
  for (const d of dossiers) {
    const subQuestion = d.manifest.question;
    const list = [];
    for (const s of d.sources) {
      const raw = toRawSource(s, readSourceText(d.dir, s));
      list.push(raw);
      const key = identityKey(raw);
      const prov = provByKey.get(key) ?? [];
      if (!prov.some((pv) => pv.runDir === d.dir && pv.subQuestion === subQuestion)) {
        prov.push({ subQuestion, runDir: d.dir });
      }
      provByKey.set(key, prov);
    }
    lists.push(list);
  }
  const fused = fuse(lists);
  const deduped = dedupeNearDuplicates(fused);
  const merged = deduped.items;
  for (const it of merged) {
    const prov = (provByKey.get(identityKey(it)) ?? []).slice().sort((a, b) => a.runDir.localeCompare(b.runDir) || a.subQuestion.localeCompare(b.subQuestion));
    it.meta = { ...it.meta, provenance: prov };
  }
  const question = options.question ?? dossiers[0].manifest.question;
  const modeName = options.mode ?? dossiers[0].manifest.mode;
  const mode = getMode(modeName);
  const builtAt = dossiers.map((d) => d.manifest.builtAt).sort().at(-1) ?? dossiers[0].manifest.builtAt;
  const subQuestions = dossiers.map((d, i) => ({ id: `Q${i + 1}`, question: d.manifest.question }));
  const rank = (d) => ALL_DEPTHS.indexOf(d);
  const depth = dossiers.map((d) => d.manifest.depth).filter((d) => d !== void 0).sort((a, b) => rank(a) - rank(b)).at(-1) ?? "deep";
  const manifest = {
    version: VERSION,
    question,
    mode: modeName,
    depth,
    lang: dossiers[0].manifest.lang ?? "en",
    backends: [...new Set(dossiers.flatMap((d) => d.manifest.backends))],
    backendsUsed: [...new Set(dossiers.flatMap((d) => d.manifest.backendsUsed))],
    sourceCount: merged.length,
    maxSources: merged.length,
    builtAt,
    slug: `${modeName}-${slugify(question)}`,
    tiers: ["SUMMARY.md", "REPORT.md"],
    extras: mode.extras,
    notes: [
      `Merged ${dossiers.length} sub-dossier(s) \u2192 ${merged.length} source(s) (${deduped.dropped} near-duplicate(s) collapsed).`,
      "agent: write the report against THIS master dossier's [S#] ids; then verify + check --semantic."
    ],
    timings: {},
    mergedFrom: options.runs.slice(),
    subQuestions
  };
  const dir = options.master ?? defaultRunDir(modeName, question);
  const { sources } = writeDossier(dir, merged, manifest, mode.template);
  writeBibtex(dir, sources, mode.extras);
  return { dir, sources, manifest: { ...manifest, sourceCount: sources.length } };
}

// src/orchestrate.ts
import { existsSync as existsSync10, readFileSync as readFileSync10 } from "fs";
import { join as join13, resolve as resolve3 } from "path";

// src/orchestrate-templates.ts
import { join as join12 } from "path";
var ONE_WRITER_FOOTER = `
## Return, don't write

Return ONLY the structured output specified above. Do NOT write, edit, or delete any file; do NOT run any engine command that writes (\`gather\`, \`fetch\`, \`merge\`, \`verify\`, \`render\`). The orchestrator is the sole writer \u2014 it saves your verdict fragments as \`verdicts.<i>.json\` itself and runs the fail-closed fold (\`verify --apply\`). Exception: if a note is prose too large to return, write ONLY to \`<RUN>/orchestration/out/<role>-<batch>.md\` (a file namespaced to you alone) and return its path.
`;
var GATHERER_FOOTER = `
## Return, don't write (one sanctioned exception)

Return the structured output specified above. Your ONLY sanctioned writes are \`gather --out\` / \`fetch --out\` into YOUR OWN sub-dossier dir(s) \u2014 the \`out\` dir of each of your ITEMS, disjoint from every other gatherer's by construction. NEVER touch the parent run dir, the master dossier, any report tier (SUMMARY.md/REPORT.md), PLAN.json, or another sub-question's dir. The orchestrator is the sole writer everywhere else \u2014 it runs the \`merge\` fold itself. Exception: if a coverage note is prose too large to return, write ONLY to \`<RUN>/orchestration/out/gatherer-<batch>.md\` (a file namespaced to you alone) and return its path.
`;
var GATHER_SCHEMA = {
  type: "object",
  required: ["gathered"],
  properties: {
    gathered: {
      type: "array",
      items: {
        type: "object",
        required: ["id", "out", "coverage", "newSubQuestions"],
        properties: {
          id: { type: "string", description: "the sub-question id (Q#)" },
          out: { type: "string", description: "the sub-dossier dir you gathered into (absolute)" },
          coverage: { type: "string", description: "one-line coverage note" },
          newSubQuestions: { type: "array", items: { type: "string" }, description: "NEW sub-questions you discovered (empty array for none)" }
        }
      }
    }
  }
};
var VERIFY_SCHEMA = {
  type: "object",
  required: ["verdicts"],
  properties: {
    verdicts: {
      type: "array",
      items: {
        type: "object",
        required: ["claimId", "sourceId", "verdict", "note"],
        properties: {
          claimId: { type: "string" },
          sourceId: { type: "string" },
          verdict: { enum: ["supported", "partial", "unsupported", "refuted"] },
          note: { type: "string", description: "one line grounded in the cited extract" }
        }
      }
    }
  }
};
function mergeHint(engineAbs, ph, runAbs) {
  const outs = ph.plan ? ph.plan.subQuestions.map((s) => s.out ?? join12(runAbs, s.id.toLowerCase())) : [`${join12(runAbs, "q1")},\u2026`];
  const q = ph.plan ? ph.plan.question : "<question>";
  const mode = ph.plan ? ph.plan.mode : "<mode>";
  return [
    `node ${shq(engineAbs)} merge --runs ${shq(outs.join(","))} --master ${shq(runAbs)} --q ${shq(q)} --mode ${mode}`,
    `then write SUMMARY.md/REPORT.md against the MASTER [S#] ids, and feed any NEW sub-questions into the next round.`
  ];
}
var PHASE_SPECS = {
  gather: {
    role: "gatherer",
    title: "Gather",
    schema: GATHER_SCHEMA,
    batchSize: 1,
    // one gatherer per sub-question — the playbook's fan-out
    collapseFloor: () => 1,
    // heavy units: fan out at any count ≥ 2
    description: (n) => `Gather web evidence for the ${n} sub-question(s) of an ultrasearch run (one gatherer per sub-question; the dossier union stays with the orchestrator)`,
    applyHint: mergeHint
  },
  verify: {
    role: "skeptic",
    title: "Verify",
    schema: VERIFY_SCHEMA,
    batchSize: 8,
    // BATCH_SIZE — one skeptic per batch of claim↔source pairs
    collapseFloor: (smallWorklist) => smallWorklist,
    // cheap per-pair judgments: ≤ SMALL_WORKLIST doesn't amortize
    description: (n) => `Adversarially verify the ${n} claim\u2194source pair(s) of an ultrasearch report (skeptic fan-out, fail-closed fold)`,
    applyHint: (engine, _ph, run) => [
      `round 2+: delete or archive the previous round's verdicts*.json FIRST \u2014 re-running verify renumbers claim ids,`,
      `and the directory fold below picks up EVERY verdicts*.json (a stale fragment corrupts the fold last-wins). Then:`,
      `save each returned fragment as ${join12(run, "verdicts.<i>.json")} then reassemble + gate:`,
      `node ${shq(engine)} verify --apply ${shq(run)} --run ${shq(run)}   # a dir picks up every verdicts*.json`
    ]
  }
};
function phaseSpec(name) {
  const spec = PHASE_SPECS[name];
  if (!spec) throw new Error(`no phase spec for "${name}"`);
  return spec;
}
function toBatches(ids, batchSize) {
  const out = [];
  for (let i = 0; i < ids.length; i += batchSize) out.push(ids.slice(i, i + batchSize));
  return out;
}
function phaseWorkflowScript(ph, runAbs, engineAbs, smallWorklist) {
  const spec = phaseSpec(ph.name);
  const scriptPath = join12(runAbs, "orchestration", `${ph.name}.workflow.mjs`);
  const meta = { name: `ultrasearch-${ph.name}`, description: spec.description(ph.items), phases: [{ title: spec.title }] };
  const batches = ph.items <= spec.collapseFloor(smallWorklist) ? [ph.ids] : toBatches(ph.ids, spec.batchSize);
  const hint = spec.applyHint(engineAbs, ph, runAbs);
  return [
    `export const meta = ${JSON.stringify(meta)}`,
    ``,
    `// NOT a plain Node script: launch via the Workflow tool \u2014 Workflow({ scriptPath: ${JSON.stringify(scriptPath)} }).`,
    `// Emitted by \`ultrasearch orchestrate\` from the CURRENT worklist. The worklist is the source`,
    `// of truth: if it changes, re-run \`orchestrate --phase ${ph.name}\` before launching.`,
    ``,
    `// Constants for THIS run (injected at emit time; no Date.now/Math.random in this harness).`,
    `const RUN = ${JSON.stringify(runAbs)}`,
    `const ENGINE = ${JSON.stringify(engineAbs)}`,
    `const WORKLIST = ${JSON.stringify(ph.worklist)}`,
    `const AGENTS = RUN + '/orchestration/agents'`,
    `const BATCHES = ${JSON.stringify(batches)}`,
    `const SCHEMA = ${JSON.stringify(spec.schema)}`,
    ``,
    `function contract(name, extra) {`,
    `  return 'Read and follow the dispatch contract at ' + AGENTS + '/' + name + '.md VERBATIM.\\n'`,
    `    + 'Constants: RUN=' + RUN + '  ENGINE=' + ENGINE + '  WORKLIST=' + WORKLIST + '.\\n'`,
    `    + 'Invoke the engine only by its ABSOLUTE path: node ' + ENGINE + ' <cmd> \u2014 stay within the contract write rules.'`,
    `    + (extra ? '\\n' + extra : '')`,
    `}`,
    ``,
    `log('ultrasearch ${ph.name}: ' + ${JSON.stringify(String(ph.items))} + ' item(s) across ' + BATCHES.length + ' agent(s)')`,
    ``,
    `phase(${JSON.stringify(spec.title)})`,
    `const results = await pipeline(BATCHES, (batch, _item, i) =>`,
    `  agent(contract('${spec.role}', 'ITEMS=' + batch.join(',')), { label: '${ph.name}:' + (i + 1), phase: ${JSON.stringify(spec.title)}, agentType: 'general-purpose', schema: SCHEMA }))`,
    ``,
    `// One-writer rule: this workflow only COLLECTS the subagents' fragments. The main agent`,
    `// runs the fold itself:`,
    ...hint.map((l) => `//   ${l}`),
    `return { phase: ${JSON.stringify(ph.name)}, worklist: WORKLIST, results: results.filter(Boolean) }`,
    ``
  ].join("\n");
}
function agentContracts(runAbs, engineAbs) {
  const gathererFooter = GATHERER_FOOTER.replaceAll("<RUN>", runAbs);
  const skepticFooter = ONE_WRITER_FOOTER.replaceAll("<RUN>", runAbs);
  return {
    gatherer: `# Contract: gatherer

You are gathering web evidence for ONE (or a few) sub-question(s) of a larger ultrasearch research run. Handle ONLY the sub-questions whose \`id\` (Q#) is named in your prompt (\`ITEMS=<Q#,\u2026>\`).

Worklist: \`${join12(runAbs, "PLAN.json")}\` (\`subQuestions[]\`; each entry has \`id\`, \`question\`, \`queries\`, \`out\`; the plan also carries the run's \`mode\` and \`depth\`).

**Stale-id guard:** if an ITEMS id is no longer in the worklist, or its \`Q#\` entry's question text doesn't match the sub-question you were dispatched for, STOP and report the mismatch instead of gathering \u2014 a re-plan renumbers ids, and gathering under a stale id would fill the wrong sub-dossier.

For EACH of your sub-questions:

1. **Sweep with your OWN WebSearch first \u2014 this is the primary engine, not an extra.**
   \`node ${engineAbs} queries --q "<its question>" --mode <the plan's mode> --depth <the plan's depth>\`
   names how many DISTINCT queries to run and which angles to cover. Run your WebSearch once per angle, pool EVERY hit into \`<its out dir>/websearch.json\` as \`[{"url":\u2026,"title":\u2026,"snippet":\u2026}, \u2026]\`. A fan-out multiplies whatever discovery it was given, so a sub-question gathered with no lane is where this run quietly gets worse.
2. Run (add \`--lang <code> --region <cc>\` and translate BOTH the \`--queries\` and your WebSearch queries into that language when the run targets a non-English audience):
   \`node ${engineAbs} gather --q "<its question>" --queries "<its queries, |-joined>" --mode <the plan's mode> --depth <the plan's depth; deep when the plan predates the field> --web-results "<its out dir>/websearch.json" --out "<its out dir>"\`
   (The on-disk fetch cache is ON by default and shared across processes, so a URL two sub-questions both surface is fetched once. Do NOT pass \`--no-cache\` here.)
3. Open \`<its out dir>/DOSSIER.md\`. If it is flagged **thin**, or it lists **under-covered** terms, or an angle is missing, run a SECOND WebSearch round at that gap and fold the whole round in with ONE call:
   \`node ${engineAbs} ingest --run "<its out dir>" --web-results "<round2.json>"\`
   Pin URLs a reader can OPEN \u2014 landing pages, never raw API endpoints or batch/search URLs (the engine rewrites the endpoints it knows and refuses the rest). If it answers that a page "extracted to a \u2026 wall", the host is throttling you: that is a refusal, not a setback to work around \u2014 take another source, or pass the provider's text endpoint and let the engine record the page.
4. Do NOT write any report tier.

Return (structured output): \`{ "gathered": [{ "id", "out", "coverage", "newSubQuestions" }] }\` \u2014 for each of your ITEMS: its \`out\` dir, a one-line coverage note, and any NEW sub-questions you discovered (an empty array for none).
${gathererFooter}`,
    skeptic: `# Contract: skeptic

You are an adversarial skeptic verifying the claims of an ultrasearch report against their cited sources. Try to REFUTE each claim: assume it is wrong until the source proves it.

Worklist: \`${join12(runAbs, "VERIFY.todo.json")}\` (an object with \`pairs[]\`; each entry has \`claimId\`, \`sourceId\`, \`claim\`, \`extractPath\`, \`extractDigest\`, and sometimes \`numeralsAbsent\`). Handle ONLY the pairs whose \`claimId:sourceId\` key is named in your prompt (\`ITEMS=<C#:S#,\u2026>\`).

**Stale-id guard:** if an ITEMS key is no longer in the worklist, STOP and report the mismatch instead of adjudicating \u2014 a regenerated worklist renumbers claim ids, and a verdict filed under a stale id would adjudicate the wrong claim.

For EACH of your pairs:

1. Open the cited source's full extract at \`${runAbs}/<extractPath>\` (the \`extractDigest\` in the worklist is only a claim-focused preview) and read the relevant passage in context.
2. Judge whether the source actually SUPPORTS the claim:
   - \`supported\` \u2014 the source states the claim.
   - \`partial\` \u2014 it supports part / a weaker version.
   - \`unsupported\` \u2014 it doesn't address the claim.
   - \`refuted\` \u2014 it contradicts the claim.
   When unsure, choose the HARSHER verdict \u2014 a false pass is worse than a false fail.
3. **Numeral rule:** if the pair lists \`numeralsAbsent\` (a figure/date/quantity the claim asserts that is not in the cited extract), the verdict caps at \`partial\` \u2014 never \`supported\` \u2014 unless you locate the figure in the full extract.
4. \`note\` is REQUIRED \u2014 one line grounded in what you read (quote or paraphrase the decisive passage).

Return (structured output): \`{ "verdicts": [{ "claimId", "sourceId", "verdict", "note" }] }\` \u2014 your ITEMS only.
${skepticFooter}`
  };
}
function runbookMd(phases, runAbs, engineAbs) {
  const cell = (s) => s.replace(/\r?\n/g, " ").replaceAll("|", "\\|");
  const status = phases.map((p) => `| ${p.name} | \`${cell(p.worklist)}\` | ${p.ready ? `ready (${p.items} item(s))` : "not ready"} | \`${cell(p.prerequisite)}\` |`).join("\n");
  const engine = `node ${shq(engineAbs)}`;
  const gather = phases.find((p) => p.name === "gather");
  const outs = gather?.plan ? shq(gather.plan.subQuestions.map((s) => s.out ?? join12(runAbs, s.id.toLowerCase())).join(",")) : '"<the out dirs, comma-joined>"';
  const q = gather?.plan ? shq(gather.plan.question) : '"<question>"';
  const mode = gather?.plan ? gather.plan.mode : "<m>";
  const run = shq(runAbs);
  return `# ultrasearch \u2014 sequential RUNBOOK (eco / no-subagent fallback)

Run: \`${runAbs}\` \xB7 Engine: \`${engine}\`

Generated by \`ultrasearch orchestrate\` from the CURRENT run state. This sequential path is
correctness-identical to the multi-agent workflows \u2014 same worklists, same contracts, same
fail-closed gates; only wall-clock differs.
Parallel subagents are an optimization, never a requirement.

## Phase status

| Phase | Worklist | Status | Produce it with |
|---|---|---|---|
${status}

## The loop (play every role yourself, one item at a time)

1. **Plan** (if not done): \`${engine} plan --q "<question>" --mode <m> --run-root ${run}\` \u2192 \`${join12(runAbs, "PLAN.json")}\` (standard tier: keep it small with \`--max-subquestions 3\` and pass \`--depth standard\`; deep tier: add \`--depth deep\`; without \`--depth\` the fan-out gathers deep).
2. **Gather per sub-question** \u2014 for EVERY entry in \`${join12(runAbs, "PLAN.json")}\`, apply \`${join12(runAbs, "orchestration", "agents", "gatherer.md")}\` yourself: sweep with your own WebSearch into \`<its out dir>/websearch.json\`, run its \`gather --q \u2026 --queries \u2026 --web-results \u2026 --out <its out dir>\`, then top up a thin or under-covered sub-dossier with a second round (\`ingest --run <its out dir> --web-results <round2.json>\`).
3. **Merge** \u2014 \`${engine} merge --runs ${outs} --master ${run} --q ${q} --mode ${mode}\`. Cite only the MASTER \`[S#]\` ids from here.
4. **Write the tiers** \u2014 SUMMARY.md + REPORT.md in \`${runAbs}\`, every claim cited \`[S#]\`, your own knowledge flagged \`[M]\`.
5. **Verify the claims** \u2014 \`${engine} verify --run ${run}\` writes \`${join12(runAbs, "VERIFY.todo.json")}\`. For EVERY pair, apply \`${join12(runAbs, "orchestration", "agents", "skeptic.md")}\` yourself (open the cited extract, verdict supported/partial/unsupported/refuted + note). Save your verdicts as \`${join12(runAbs, "verdicts.json")}\`, then fold: \`${engine} verify --apply ${run} --run ${run}\`.
6. **Gate** \u2014 \`${engine} render --run ${run}\` and \`${engine} check --run ${run} --semantic\` must pass before presenting (deep tier: add \`--require-verify\`).
7. **Loop until dry** \u2014 NEW sub-questions from step 2 \u2192 fan out again, \`merge\` into the SAME master, re-verify. Before re-folding, delete or archive the previous round's \`verdicts*.json\`: re-running \`verify\` renumbers claim ids, and the \`--apply\` directory glob refolds every \`verdicts*.json\` (a stale round-1 file corrupts the gate last-wins). Stop when a round surfaces nothing new.

With subagents available, prefer the emitted workflows instead: \`orchestrate --run ${run} --phase <p>\` then \`Workflow({ scriptPath: "${join12(runAbs, "orchestration", "<p>.workflow.mjs")}" })\` \u2014 you stay the sole writer either way.
`;
}

// src/orchestrate.ts
var PHASES = ["gather", "verify"];
var SMALL_WORKLIST = 3;
function listPhases(runDir, engineAbs) {
  const run = resolve3(runDir);
  const planPath = join13(run, "PLAN.json");
  let plan;
  if (existsSync10(planPath)) {
    try {
      const f = JSON.parse(readFileSync10(planPath, "utf8"));
      if (f && Array.isArray(f.subQuestions)) plan = f;
    } catch {
    }
  }
  const planIds = plan ? plan.subQuestions.map((s) => s.id) : [];
  const verPath = join13(run, "VERIFY.todo.json");
  let verIds = [];
  let verReady = false;
  if (existsSync10(verPath)) {
    try {
      const f = JSON.parse(readFileSync10(verPath, "utf8"));
      if (f && Array.isArray(f.pairs)) {
        verReady = true;
        verIds = f.pairs.map((p) => `${p.claimId}:${p.sourceId}`);
      }
    } catch {
    }
  }
  return [
    {
      name: "gather",
      ready: plan !== void 0,
      worklist: planPath,
      items: planIds.length,
      ids: planIds,
      ...plan ? { plan } : {},
      prerequisite: plan ? (
        // Carry the persisted depth (when present) so re-running the prerequisite
        // regenerates the SAME plan instead of silently dropping the field.
        `node ${shq(engineAbs)} plan --q ${shq(plan.question)} --mode ${plan.mode}${plan.depth ? ` --depth ${plan.depth}` : ""} --run-root ${shq(run)}`
      ) : `node ${shq(engineAbs)} plan --q "<question>" --mode <m> --run-root ${shq(run)}`
    },
    {
      name: "verify",
      ready: verReady,
      worklist: verPath,
      items: verIds.length,
      ids: verIds,
      prerequisite: `node ${shq(engineAbs)} verify --run ${shq(run)}`
    }
  ];
}
function orchestrateRun(runDir, engineAbs, opts = {}) {
  const run = resolve3(runDir);
  if (!existsSync10(run)) {
    return { exitCode: 2, written: [], notices: [], errors: [`run dir not found: ${run}`], phases: [] };
  }
  const phases = listPhases(run, engineAbs);
  let selected = phases.filter((p) => p.ready);
  if (opts.phase !== void 0) {
    const ph = phases.find((p) => p.name === opts.phase);
    if (!ph) {
      return {
        exitCode: 2,
        written: [],
        notices: [],
        errors: [`unknown phase "${opts.phase}" \u2014 expected one of: ${PHASES.join(", ")}.`],
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
  const orchDir = join13(run, "orchestration");
  const agentsDir = join13(orchDir, "agents");
  ensureDir(join13(orchDir, "out"));
  ensureDir(agentsDir);
  const written = [];
  const notices = [];
  for (const [name, content] of Object.entries(agentContracts(run, engineAbs))) {
    const p = join13(agentsDir, `${name}.md`);
    writeArtifact(p, content);
    written.push(p);
  }
  if (!opts.eco) {
    for (const ph of selected) {
      if (ph.items === 0) {
        notices.push(`phase "${ph.name}": worklist is empty \u2014 nothing to orchestrate.`);
        continue;
      }
      if (ph.items <= phaseSpec(ph.name).collapseFloor(SMALL_WORKLIST)) {
        notices.push(`phase "${ph.name}": only ${ph.items} item(s) \u2014 the sequential --eco path is equivalent and cheaper.`);
      }
      const p = join13(orchDir, `${ph.name}.workflow.mjs`);
      writeArtifact(p, phaseWorkflowScript(ph, run, engineAbs, SMALL_WORKLIST));
      written.push(p);
    }
  }
  const rb = join13(orchDir, "RUNBOOK.md");
  writeArtifact(rb, runbookMd(phases, run, engineAbs));
  written.push(rb);
  return { exitCode: 0, written, notices, errors: [], phases };
}

// src/mcp/handlers.ts
import { existsSync as existsSync11, readFileSync as readFileSync11, realpathSync as realpathSync2, statSync as statSync3 } from "fs";
import { isAbsolute, join as join14, relative, resolve as resolve4, sep as sep2 } from "path";
var MAX_READ_LINES = 2e3;
var MAX_READ_BYTES = 8 * 1024 * 1024;
var DEFAULT_DEPTH = "standard";
function str(v) {
  return typeof v === "string" && v.trim() !== "" ? v : void 0;
}
function num(v) {
  const n = typeof v === "number" ? v : typeof v === "string" && v.trim() !== "" ? Number(v) : NaN;
  return Number.isFinite(n) ? n : void 0;
}
function bool(v) {
  return v === true || v === "true";
}
function strArray(v) {
  return Array.isArray(v) && v.every((x) => typeof x === "string") ? v : void 0;
}
function positive(v, key) {
  const n = num(v);
  if (n === void 0) return void 0;
  if (n <= 0) throw new ToolError(`\`${key}\` must be greater than 0.`);
  return n;
}
function requiredStr(args, key, hint) {
  const v = str(args[key]);
  if (!v) throw new ToolError(`\`${key}\` is required \u2014 ${hint}`);
  return v;
}
function oneOf(value, allowed, key, fallback) {
  if (value === void 0) return fallback;
  if (!allowed.includes(value)) {
    throw new ToolError(`\`${key}\` must be one of: ${allowed.join(", ")} (got "${value}")`);
  }
  return value;
}
function webResultsArg(v) {
  if (v === void 0 || v === null) return void 0;
  if (!Array.isArray(v)) throw new ToolError("`web_results` must be an array of {url, title, snippet} objects (or of URL strings).");
  if (!v.length) return void 0;
  const parsed = parseWebResults(JSON.stringify(v));
  if (!parsed.hits.length) {
    throw new ToolError('`web_results` held no usable hit \u2014 expected [{"url": "https://\u2026"}, \u2026] (or a list of URL strings).');
  }
  return { hits: parsed.hits, rejected: parsed.rejected };
}
function requiredRun(args, defaults) {
  const run = str(args.run) ?? defaults.defaultRun;
  if (!run) throw new ToolError("`run` is required: the dossier directory returned by ultrasearch_gather.");
  if (!isAbsolute(run)) throw new ToolError("`run` must be an absolute path.");
  const abs = resolve4(run);
  if (!existsSync11(join14(abs, "manifest.json"))) {
    throw new ToolError(`no dossier at ${abs} \u2014 build one first with ultrasearch_gather (it returns the directory to pass here).`);
  }
  return abs;
}
function gatherOptions(args) {
  const backends = strArray(args.backends);
  if (backends) {
    for (const b of backends) {
      if (!ALL_BACKENDS.includes(b)) throw new ToolError(`unknown backend "${b}" \u2014 one of: ${[...ALL_BACKENDS].join(", ")}`);
    }
  }
  const out = str(args.out);
  if (out !== void 0 && !isAbsolute(out)) throw new ToolError("`out` must be an absolute path.");
  const depth = oneOf(str(args.depth), ALL_DEPTHS, "depth", DEFAULT_DEPTH);
  const caps = DEPTH_CAPS[depth];
  const web = webResultsArg(args.web_results);
  return {
    question: requiredStr(args, "question", "the topic or question to research."),
    mode: oneOf(str(args.mode), ALL_MODES, "mode", "topic"),
    depth,
    backends,
    queries: strArray(args.queries),
    maxSources: positive(args.max_sources, "max_sources"),
    perSource: positive(args.per_source, "per_source") ?? caps.perSource,
    lang: str(args.lang) ?? "en",
    region: str(args.region),
    // Pilotable from MCP, at last: these were hardcoded, so a client could not
    // pin an engine, point at a SearXNG, or reach the WebSearch lane at all.
    webEngine: oneOf(str(args.web_engine), ALL_WEB_ENGINES, "web_engine", "auto"),
    search: oneOf(str(args.search), ALL_SEARCH_PROFILES, "search", "auto"),
    ...web ? { webResults: web.hits, webResultsRejected: web.rejected } : {},
    searxng: str(args.searxng),
    firecrawl: str(args.firecrawl),
    since: str(args.since),
    excludeDomains: strArray(args.exclude_domains) ?? [],
    seedDomains: strArray(args.seed_domains),
    out,
    json: true
  };
}
async function callTool(name, args, defaults = {}) {
  const result = await dispatch(name, args, defaults);
  return outcome(name, result);
}
var NO_WRITE_REFUSED_TOOLS = {
  ultrasearch_fetch: "it adds a new [S#] to a dossier on disk",
  ultrasearch_ingest: "it adds new [S#] entries to a dossier on disk",
  ultrasearch_merge: "it unions the sub-dossiers into a master dossier on disk",
  ultrasearch_verify: "it emits a worklist for skeptics to read from disk"
};
async function dispatch(name, args, defaults) {
  const refused = NO_WRITE_REFUSED_TOOLS[name];
  if (refused && isNoWrite()) {
    throw new ToolError(
      `\`${name}\` cannot run while ULTRASEARCH_NO_WRITE is set \u2014 ${refused}. Unset it, or use ultrasearch_gather, which streams its dossier back inline.`
    );
  }
  switch (name) {
    // These three touch no dossier at all.
    case "ultrasearch_modes":
      return { modes: listModes() };
    case "ultrasearch_search":
      return await handleSearch(args);
    case "ultrasearch_plan":
      return handlePlan(args);
    // A gather creates its dossier, so there is nothing yet to lock against.
    case "ultrasearch_gather":
      return await handleGather(args);
    case "ultrasearch_brainstorm":
      return await handleBrainstorm(args);
    case "ultrasearch_merge":
      return handleMerge(args);
    // Everything below mutates or reads ONE existing dossier, and is
    // serialized against other calls on the same one.
    default: {
      const run = requiredRun(args, defaults);
      return await withRunLock(run, async () => {
        switch (name) {
          case "ultrasearch_fetch":
            return await handleFetch(args, run);
          case "ultrasearch_ingest":
            return await handleIngest(args, run);
          case "ultrasearch_check":
            return handleCheck(args, run);
          case "ultrasearch_relink":
            return handleRelink(args, run);
          case "ultrasearch_verify":
            return handleVerify(args, run);
          case "ultrasearch_render":
            return handleRender(args, run);
          case "ultrasearch_read":
            return handleRead(args, run);
          default:
            throw new ToolError(`unknown tool: ${name}`);
        }
      });
    }
  }
}
function outcome(name, result) {
  return { text: JSON.stringify(result, null, 2) + "\n", artifact: artifactFor(name, result) };
}
function artifactFor(name, result) {
  if (isNoWrite()) return void 0;
  if (typeof result !== "object" || result === null) return void 0;
  const r = result;
  if (name === "ultrasearch_gather" || name === "ultrasearch_merge") return typeof r.dossier_md === "string" ? r.dossier_md : void 0;
  if (name === "ultrasearch_brainstorm") return typeof r.path === "string" ? r.path : void 0;
  return void 0;
}
async function handleSearch(args) {
  const query = requiredStr(args, "query", "the search query.");
  const chosen = requiredStr(args, "backend", `which backend to query, one of: ${[...ALL_BACKENDS].join(", ")}`);
  const backend = oneOf(chosen, ALL_BACKENDS, "backend", ALL_BACKENDS[0]);
  const options = gatherOptions({ ...args, question: query, depth: "summary" });
  const results = await runBackends([backend], { question: query, mode: getMode(options.mode), options, variants: [query] });
  const max = positive(args.max_sources, "max_sources") ?? 10;
  const items = results.flatMap((r) => r.items).slice(0, max);
  const notes = results.flatMap((r) => r.notes);
  return {
    query,
    backend,
    count: items.length,
    // A backend that degraded is information, not a failure: it bounds what
    // the caller may conclude from an empty result.
    ...notes.length ? { notes } : {},
    results: items.map((i) => ({ url: i.url, title: i.title, snippet: i.snippet })),
    next: "Nothing was written. To cite any of this, ingest the URL with ultrasearch_fetch into a dossier, or run ultrasearch_gather."
  };
}
async function handleGather(args) {
  const options = gatherOptions(args);
  const res = await runGather(options);
  const head = {
    question: options.question,
    mode: options.mode,
    depth: options.depth,
    sources: res.sources.length,
    ...res.manifest.notes?.length ? { notes: res.manifest.notes } : {}
  };
  if (isNoWrite()) {
    return {
      run: null,
      ...head,
      artifacts: artifactMap(res.dir),
      next: "Nothing was written. Answer from the artifacts above, citing [S#]. ultrasearch_check cannot run without files \u2014 the grounding discipline is yours."
    };
  }
  return {
    run: res.dir,
    dossier_md: join14(res.dir, "DOSSIER.md"),
    ...head,
    next: `Read ${join14(res.dir, "DOSSIER.md")} with ultrasearch_read, write the report citing [S#], then prove it with ultrasearch_check.`
  };
}
async function handleBrainstorm(args) {
  const options = gatherOptions(args);
  const res = await runBrainstorm(options);
  if (isNoWrite()) {
    return {
      ...res,
      dir: null,
      artifacts: artifactMap(res.dir),
      next: "Nothing was written. Pick an angle, then run ultrasearch_gather on the sharpened question."
    };
  }
  return { ...res, next: "Pick an angle, then run ultrasearch_gather on the sharpened question." };
}
function artifactMap(dir) {
  const files = {};
  for (const a of takeArtifacts()) files[relative(dir, a.path) || a.path] = a.content;
  return files;
}
function handlePlan(args) {
  const question = requiredStr(args, "question", "the umbrella question to decompose.");
  const mode = oneOf(str(args.mode), ALL_MODES, "mode", "topic");
  const runRoot = str(args.run_root);
  if (runRoot !== void 0 && !isAbsolute(runRoot)) throw new ToolError("`run_root` must be an absolute path.");
  const res = runPlan(question, mode, strArray(args.subquestions), positive(args.max_subquestions, "max_subquestions"), runRoot);
  if (isNoWrite()) takeArtifacts();
  return {
    ...res,
    next: "Run ultrasearch_gather on each sub-question into its own dir, then ultrasearch_merge them into one dossier before writing anything."
  };
}
function handleMerge(args) {
  const runs = strArray(args.runs);
  if (!runs?.length) throw new ToolError("`runs` is required \u2014 the sub-dossier directories to union.");
  for (const r of runs) {
    if (!isAbsolute(r)) throw new ToolError(`\`runs\` must contain absolute paths (got "${r}").`);
    if (!existsSync11(join14(r, "manifest.json"))) throw new ToolError(`no dossier at ${r} \u2014 every entry of \`runs\` must be a gathered dossier.`);
  }
  const master = str(args.master);
  if (master !== void 0 && !isAbsolute(master)) throw new ToolError("`master` must be an absolute path.");
  const res = runMerge({ runs, master, question: str(args.question), mode: str(args.mode) });
  return {
    run: res.dir,
    dossier_md: join14(res.dir, "DOSSIER.md"),
    sources: res.sources.length,
    merged_from: runs.length,
    next: `Write ONE report against ${res.dir}, citing the merged [S#] ids, then prove it with ultrasearch_check.`
  };
}
async function handleFetch(args, run) {
  const url = requiredStr(args, "url", "an absolute http(s) URL to fetch.");
  if (!/^https?:\/\//i.test(url)) throw new ToolError("`url` must be an absolute http(s) URL.");
  const res = await addSource(run, url, { question: str(args.question), title: str(args.title), citeUrl: str(args.cite_url) });
  return { run, url, ...res };
}
async function handleIngest(args, run) {
  const web = webResultsArg(args.web_results);
  const listed = strArray(args.urls) ?? [];
  for (const u of listed) {
    if (!/^https?:\/\//i.test(u)) throw new ToolError(`\`urls\` must hold absolute http(s) URLs (got "${u}").`);
  }
  const hits = [...listed, ...web?.hits ?? []];
  if (!hits.length) throw new ToolError("`web_results` or `urls` is required \u2014 the URLs to fold into the dossier.");
  const res = await addSources(run, hits, { question: str(args.question), firecrawl: str(args.firecrawl), cache: true });
  return {
    run,
    ...res,
    ...web?.rejected ? { rejected: web.rejected } : {},
    // Say what to do next, and only when there IS something to do: a partial
    // ingest is normal (walls, dead links), and the caller needs to know which
    // URLs never became citable rather than assume all of them did.
    ...res.skipped ? { next: "Some URLs were not added \u2014 read each result's `note`. A refused page is not citable; find a primary source that carries the text." } : {}
  };
}
function handleCheck(args, run) {
  const res = runCheck(run, {
    semantic: bool(args.semantic),
    requireVerify: bool(args.require_verify),
    strictNumerals: bool(args.strict_numerals),
    minSources: positive(args.min_sources, "min_sources")
  });
  return { run, ...res };
}
function handleRelink(args, run) {
  const id = str(args.id);
  const url = str(args.url);
  if (bool(args.list)) return { run, issues: listIssues(run) };
  if (id || url) {
    if (!id || !url) throw new ToolError("`id` and `url` go together \u2014 pass both to repoint one source, or neither to run the automatic pass.");
    const res = relink(run, id, url, { title: str(args.title) });
    if (!res.relinked) throw new ToolError(res.note ?? `${id} was not relinked.`);
    return { run, ...res };
  }
  const { repaired, remaining } = autoRelink(run);
  return {
    run,
    repaired,
    remaining,
    next: remaining.length ? "Each remaining entry carries the reason and what would settle it. Search for the page, then call ultrasearch_relink again with id + url." : "Every source cites a page a reader can open."
  };
}
function handleVerify(args, run) {
  const shards = positive(args.shards, "shards");
  const shard = num(args.shard);
  if (shards !== void 0 && shard !== void 0 && (shard < 0 || shard >= shards)) {
    throw new ToolError(`\`shard\` must be between 0 and ${shards - 1}.`);
  }
  const res = runVerify(run, { maxVerify: positive(args.max_verify, "max_verify"), shards, shard });
  return {
    ...res,
    run,
    next: "For each pair, read the cited source and judge it supported / partial / refuted / unsupported. Rewrite any claim its source does not carry."
  };
}
function handleRender(args, run) {
  if (isNoWrite()) {
    if (bool(args.no_md)) throw new ToolError("`no_md` with ULTRASEARCH_NO_WRITE leaves nothing to render \u2014 no HTML is produced in that mode.");
    writeReportMarkdown(run);
    return {
      run,
      written: [],
      artifacts: artifactMap(run),
      next: "Nothing was written; index.md is above. index.html is skipped \u2014 it is only useful as a file."
    };
  }
  const written = [];
  if (!bool(args.no_html)) written.push(writeHtml(run));
  if (!bool(args.no_md)) written.push(writeReportMarkdown(run));
  if (!written.length) throw new ToolError("both `no_html` and `no_md` were set \u2014 there is nothing left to render.");
  return { run, written };
}
function handleRead(args, run) {
  const raw = requiredStr(args, "path", "a path relative to the dossier, or an absolute path inside it.");
  const target = isAbsolute(raw) ? raw : join14(run, raw);
  let real;
  try {
    real = realpathSync2(target);
  } catch {
    throw new ToolError(`no such file: ${raw}`);
  }
  const root = realpathSync2(run);
  if (real !== root && !real.startsWith(root + sep2)) {
    throw new ToolError(`path is outside the dossier: ${raw}. Use your own file tool for anything else.`);
  }
  const st = statSync3(real);
  if (!st.isFile()) throw new ToolError(`not a file: ${raw}`);
  if (st.size > MAX_READ_BYTES) throw new ToolError(`file is too large to read (${st.size} bytes): ${raw}`);
  const lines = readFileSync11(real, "utf8").split("\n");
  const total = lines.length;
  const start = Math.max(1, Math.floor(num(args.start_line) ?? 1));
  if (start > total) throw new ToolError(`start_line ${start} is past the end of the file (${total} lines).`);
  const requestedEnd = Math.floor(num(args.end_line) ?? total);
  const end = Math.min(total, Math.max(start, requestedEnd), start + MAX_READ_LINES - 1);
  return {
    path: isAbsolute(raw) ? real : raw,
    start_line: start,
    end_line: end,
    total_lines: total,
    truncated: end < Math.min(total, requestedEnd),
    content: lines.slice(start - 1, end).join("\n")
  };
}

// src/mcp/tools.ts
var MODE_ENUM = [...ALL_MODES].sort();
var DEPTH_ENUM = [...ALL_DEPTHS].sort();
var BACKEND_ENUM = [...ALL_BACKENDS].sort();
var runProp = { type: "string", description: "The dossier directory returned by ultrasearch_gather." };
var questionProp = { type: "string", description: "The topic or question, in natural language." };
var modeProp = {
  type: "string",
  enum: MODE_ENUM,
  description: "Which research profile to use: topic (general), bug (an error \u2014 StackOverflow/GitHub/HN), research (scholarly APIs + BibTeX), learn (a lesson), startup (market and competitors). Default: topic."
};
var langProp = { type: "string", description: "Search language, e.g. 'fr'. Default: en." };
var webResultsProp = {
  type: "array",
  items: { type: "object" },
  description: "YOUR OWN web-search hits \u2014 [{url, title, snippet}, \u2026]. This is the PRIMARY discovery lane: the strongest index available here, and the only one that needs neither a container nor a scrape. Run your web search first, pass the hits, and the engine fetches, ranks and dedupes them like any other candidate. A bare list of URL strings works too."
};
var searchProfileProp = {
  type: "string",
  enum: [...ALL_SEARCH_PROFILES].sort(),
  description: "How wide discovery casts: 'light' = your web_results lane + the mode's API backends (no scraped cascade, no SearXNG); 'full' = also fuse the keyless engines and SearXNG; 'auto' (default) = light when web_results is given, full when it is not."
};
var webEngineProp = {
  type: "string",
  enum: [...ALL_WEB_ENGINES].sort(),
  description: "Pin the keyless discovery engine instead of running the fallback cascade. 'auto' (default) cascades; 'claude' means your web_results lane IS the discovery."
};
var searxngProp = { type: "string", description: "SearXNG base URL (optional self-hosted container; auto-detected on localhost:8888)." };
var firecrawlProp = {
  type: "string",
  description: "Self-hosted Firecrawl base URL for browser-rendered extraction; 'off' disables it. Auto-detected on localhost:3002. Extraction only \u2014 it does not discover."
};
var GROUNDING_NOTE = "Returns SOURCES, not an answer \u2014 you write the report from them, citing [S#], and prove it with ultrasearch_check.";
var TOOLS = [
  {
    name: "ultrasearch_search",
    title: "Search one backend, write nothing",
    description: "Run one query against ONE search backend and get ranked results back. Writes nothing and keeps no dossier \u2014 this is the cheap lookup for a single fact, or a probe to see what a backend knows before committing to a full gather. For anything you intend to cite, use ultrasearch_gather.",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string", description: "The search query." },
        backend: {
          type: "string",
          enum: BACKEND_ENUM,
          description: "Which backend to query. There is no default: a general web sweep is what ultrasearch_gather does, and picking one here is the point of this tool. Use stackexchange/github/hackernews for a bug, arxiv/openalex/pubmed/crossref for research, wikipedia for a definition, duckduckgo/mojeek/marginalia for the open web."
        },
        lang: langProp,
        max_sources: { type: "number", description: "Cap on results returned (default 10)." }
      },
      required: ["query", "backend"]
    }
  },
  {
    name: "ultrasearch_gather",
    title: "Build a cited dossier from the web",
    description: "Fetch and dedupe pages into a dossier on disk: sources.json, one file per source, DOSSIER.md and manifest.json. Returns the dossier directory. PASS YOUR OWN WEB-SEARCH HITS as `web_results` \u2014 that lane is the primary engine, and the keyless backends behind it are best-effort fallbacks. SLOW and network-bound: depth 'summary' is about 30s, 'standard' 2-4 minutes, 'deep' 10-20 minutes \u2014 'standard' is the default here because a client that times out mid-gather loses the run. " + GROUNDING_NOTE,
    inputSchema: {
      type: "object",
      properties: {
        question: questionProp,
        web_results: webResultsProp,
        search: searchProfileProp,
        mode: modeProp,
        depth: {
          type: "string",
          enum: DEPTH_ENUM,
          description: "How hard to look: summary (~30s, \u226410 sources), standard (2-4 min, \u226425), deep (10-20 min, \u226460). Default: standard."
        },
        backends: { type: "array", items: { type: "string" }, enum: BACKEND_ENUM, description: "Override the mode's backend profile." },
        queries: { type: "array", items: { type: "string" }, description: "Your own query variants, instead of the planner's." },
        max_sources: { type: "number", description: "Cap on sources kept (default: per depth)." },
        per_source: { type: "number", description: "Max excerpts kept per source (default: per depth)." },
        lang: langProp,
        region: { type: "string", description: "Region/country for locale-aware search (else derived from lang)." },
        since: { type: "string", description: "Recency filter, where the backend supports it (e.g. 2024)." },
        seed_domains: { type: "array", items: { type: "string" }, description: "Primary hosts to also search with site: and rank as primary." },
        exclude_domains: { type: "array", items: { type: "string" }, description: "Hosts to drop from results." },
        web_engine: webEngineProp,
        searxng: searxngProp,
        firecrawl: firecrawlProp,
        out: { type: "string", description: "Absolute directory to write the dossier to (default: a timestamped dir under the temp root)." }
      },
      required: ["question"]
    }
  },
  {
    name: "ultrasearch_ingest",
    title: "Ingest many URLs into a dossier at once",
    description: "The batch form of ultrasearch_fetch: fold a whole set of your own web-search hits into an existing dossier in one call, each becoming a citable [S#]. Use this instead of calling ultrasearch_fetch once per URL. Every URL comes back with an outcome \u2014 added, already present, or refused with the reason.",
    inputSchema: {
      type: "object",
      properties: {
        run: runProp,
        web_results: webResultsProp,
        urls: { type: "array", items: { type: "string" }, description: "Plain list of absolute http(s) URLs (alternative to web_results)." },
        question: { type: "string", description: "What you're looking for on these pages \u2014 ranks the excerpts kept. Defaults to the dossier's question." },
        firecrawl: firecrawlProp
      },
      required: ["run"]
    }
  },
  {
    name: "ultrasearch_fetch",
    title: "Ingest one URL into a dossier",
    description: "Fetch a specific URL, extract and rank its text, and add it to an existing dossier as a new [S#] you can cite. This is how you fold in a page you found yourself \u2014 including via your own web search \u2014 so that it becomes citable evidence rather than an uncited assertion.",
    inputSchema: {
      type: "object",
      properties: {
        run: runProp,
        url: { type: "string", description: "Absolute http(s) URL to fetch." },
        question: { type: "string", description: "What you're looking for on the page \u2014 ranks the excerpts kept. Defaults to the dossier's question." },
        title: { type: "string", description: "Override the extracted title." },
        cite_url: {
          type: "string",
          description: "Read the text from `url` but record THIS page as the citation. For when `url` is an API endpoint whose document you already know."
        }
      },
      required: ["run", "url"]
    }
  },
  {
    name: "ultrasearch_check",
    title: "Validate a report's citations",
    description: "The grounding gate. Prove every [S#] in your report resolves to a real source in the dossier, and that enough of the prose is cited at all. A result with ok:false is a real verdict, not a tool failure \u2014 read the errors, fix the report, and check again.",
    inputSchema: {
      type: "object",
      properties: {
        run: runProp,
        semantic: { type: "boolean", description: "Also fold in recorded verify verdicts, failing on a refuted or unsupported claim." },
        require_verify: { type: "boolean", description: "Fail when no verdicts have been recorded yet." },
        strict_numerals: { type: "boolean", description: "Every number in the prose must appear in a cited source." },
        min_sources: { type: "number", description: "Fail when the dossier holds fewer on-topic sources than this." }
      },
      required: ["run"]
    }
  },
  {
    name: "ultrasearch_relink",
    title: "Repair source citations in a dossier",
    description: "Fix sources that cite something a reader cannot open \u2014 a machine endpoint rather than the document's page \u2014 and list the ones only you can settle. Called bare it repairs every source whose stored text names its own document (no network); pass id + url to point one at a page you found.",
    inputSchema: {
      type: "object",
      properties: {
        run: runProp,
        list: { type: "boolean", description: "Dry run: report what needs repair and change nothing." },
        id: { type: "string", description: 'The source to repoint, e.g. "S12". Requires url.' },
        url: { type: "string", description: "The page that source should cite. Requires id." },
        title: { type: "string", description: "Override the repaired source's title." }
      },
      required: ["run"]
    }
  },
  {
    name: "ultrasearch_verify",
    title: "Build a claim-support worklist",
    description: "Go past 'the citation resolves' to 'the source actually supports the claim'. Emits a deterministic claim-by-source worklist from the dossier and its report, for you to adjudicate each pair as supported / partial / refuted / unsupported.",
    inputSchema: {
      type: "object",
      properties: {
        run: runProp,
        max_verify: { type: "number", description: "Cap on the number of claim/source pairs emitted." },
        shards: { type: "number", description: "Split the worklist into this many shards, to adjudicate in parallel." },
        shard: { type: "number", description: "Which shard to emit, 0-based." }
      },
      required: ["run"]
    }
  },
  {
    name: "ultrasearch_render",
    title: "Render the dossier to HTML and Markdown",
    description: "Turn a dossier plus the report you wrote into a self-contained index.html and index.md, with citations linked to their sources. Run it after ultrasearch_check passes \u2014 rendering an unvalidated report just makes an ungrounded document look finished.",
    inputSchema: {
      type: "object",
      properties: { run: runProp, no_html: { type: "boolean", description: "Skip index.html." }, no_md: { type: "boolean", description: "Skip index.md." } },
      required: ["run"]
    }
  },
  {
    name: "ultrasearch_plan",
    title: "Decompose a question into sub-questions",
    description: "Split a broad question into independent sub-questions, each with its own deterministic dossier directory. This is the front half of deep research: gather each sub-question separately, then ultrasearch_merge them into one dossier with stable [S#] ids.",
    inputSchema: {
      type: "object",
      properties: {
        question: questionProp,
        mode: modeProp,
        subquestions: { type: "array", items: { type: "string" }, description: "Your own sub-questions, instead of the planner's." },
        max_subquestions: { type: "number", description: "Cap on how many are emitted." },
        run_root: { type: "string", description: "Absolute directory to root the per-sub-question dossier paths at." }
      },
      required: ["question"]
    }
  },
  {
    name: "ultrasearch_merge",
    title: "Merge sub-dossiers into one",
    description: "Union several dossiers into a master one, re-assigning [S#] ids so they stay stable and unique across the merge. The back half of deep research: you write ONE report against the merged dossier, not one per sub-question.",
    inputSchema: {
      type: "object",
      properties: {
        runs: { type: "array", items: { type: "string" }, description: "The sub-dossier directories to union." },
        master: { type: "string", description: "Absolute output directory (default: derived from mode and question)." },
        question: { type: "string", description: "The original umbrella question." },
        mode: modeProp
      },
      required: ["runs"]
    }
  },
  {
    name: "ultrasearch_brainstorm",
    title: "Probe a vague question before researching it",
    description: "Turn a question too vague to research into angles worth taking and the clarifying questions worth asking first. Use it when the ask is broad enough that a gather would return a shallow dossier about the wrong thing.",
    inputSchema: {
      type: "object",
      properties: { question: questionProp, mode: modeProp, out: { type: "string", description: "Absolute directory to write BRAINSTORM.md to." } },
      required: ["question"]
    }
  },
  {
    name: "ultrasearch_modes",
    title: "List the research modes",
    description: "What each mode is for and which backends it searches. Read this when unsure which mode a question belongs to. Writes nothing.",
    inputSchema: { type: "object", properties: {}, required: [] }
  },
  {
    name: "ultrasearch_read",
    title: "Read a file from a dossier",
    description: "Read a file, or a line range of one, from a dossier \u2014 DOSSIER.md, a source file, manifest.json, VERIFY.todo.json. Reads are confined to the dossier directory; anything else is your own file tool's job.",
    inputSchema: {
      type: "object",
      properties: {
        run: runProp,
        path: { type: "string", description: "Path relative to the dossier (e.g. 'DOSSIER.md', 'sources/S1.md'), or an absolute path inside it." },
        start_line: { type: "number", description: "First line to return, 1-based (default 1)." },
        end_line: { type: "number", description: "Last line to return, inclusive (default: end of file, capped)." }
      },
      required: ["run", "path"]
    },
    outputSchema: {
      type: "object",
      properties: {
        path: { type: "string" },
        start_line: { type: "number" },
        end_line: { type: "number" },
        total_lines: { type: "number" },
        truncated: { type: "boolean" },
        content: { type: "string" }
      },
      required: ["path", "start_line", "end_line", "total_lines", "truncated", "content"]
    }
  }
];
var WRITE_TOOLS = [];
var TOOL_META = {
  ultrasearch_search: { openWorld: true },
  ultrasearch_gather: { write: true, destructive: false, idempotent: false, openWorld: true },
  ultrasearch_fetch: { write: true, destructive: false, idempotent: true, openWorld: true },
  // Idempotent for the same reason `fetch` is: a URL already in the dossier
  // comes back as its existing [S#] rather than a second copy.
  ultrasearch_ingest: { write: true, destructive: false, idempotent: true, openWorld: true },
  ultrasearch_check: { openWorld: false },
  ultrasearch_relink: { write: true, destructive: false, idempotent: true, openWorld: false },
  ultrasearch_verify: { write: true, destructive: false, idempotent: true, openWorld: false },
  ultrasearch_render: { write: true, destructive: false, idempotent: true, openWorld: false },
  ultrasearch_plan: { openWorld: false },
  ultrasearch_merge: { write: true, destructive: false, idempotent: true, openWorld: false },
  ultrasearch_brainstorm: { write: true, destructive: false, idempotent: true, openWorld: false },
  ultrasearch_modes: { openWorld: false },
  ultrasearch_read: { openWorld: false }
};
function annotationsFor(name) {
  const meta = TOOL_META[name];
  if (!meta) return void 0;
  if (isNoWrite()) return { readOnlyHint: true, openWorldHint: meta.openWorld === true };
  return {
    readOnlyHint: !meta.write,
    ...meta.write ? { destructiveHint: meta.destructive === true, idempotentHint: meta.idempotent === true } : {},
    openWorldHint: meta.openWorld === true
  };
}
function toolsFor(protocolVersion, opts = {}) {
  const base = opts.allowWrite ? [...TOOLS, ...WRITE_TOOLS] : TOOLS;
  const withAnnotations = protocolVersion >= ANNOTATIONS_SINCE;
  const withRich = protocolVersion >= RICH_TOOLS_SINCE;
  return base.map((t) => {
    const decl = {
      name: t.name,
      description: t.description,
      inputSchema: applyDefaultRun(t.inputSchema, opts.defaultRun)
    };
    if (withRich && t.title) decl.title = t.title;
    if (withRich && t.outputSchema) decl.outputSchema = t.outputSchema;
    if (withAnnotations) {
      const a = annotationsFor(t.name);
      if (a) decl.annotations = a;
    }
    return decl;
  });
}
function applyDefaultRun(schema, defaultRun2) {
  const existing = schema.properties.run;
  if (!defaultRun2 || !existing) return schema;
  return {
    type: "object",
    properties: {
      ...schema.properties,
      run: { ...existing, description: `${existing.description} Optional \u2014 defaults to ${defaultRun2}.` }
    },
    required: schema.required.filter((r) => r !== "run")
  };
}

// src/mcp/prompts.ts
var PROMPTS = [
  {
    name: "research_topic",
    title: "Research a topic from the real web",
    description: "The grounded-report workflow: gather a dossier from live sources, write a report that cites every claim, and prove it with the citation gate. Use for any 'what does the web say about X' question.",
    arguments: [
      { name: "question", description: "The topic or question to research.", required: true },
      { name: "depth", description: "summary (~30s), standard (2-4 min), deep (10-20 min). Default: standard.", required: false }
    ]
  },
  {
    name: "debug_error",
    title: "Debug an error against real reports of it",
    description: "The bug workflow: search StackOverflow, GitHub issues and HN for this exact failure, read what actually fixed it for other people, and answer with the fix and its evidence rather than a plausible guess.",
    arguments: [
      { name: "error", description: "The error message or failing behaviour, verbatim.", required: true },
      { name: "context", description: "Library, version, runtime \u2014 anything that narrows which report applies.", required: false }
    ]
  },
  {
    name: "literature_review",
    title: "Review the literature on a question",
    description: "The research workflow: search the scholarly APIs, decompose a broad question into sub-questions, merge the sub-dossiers, and write a review whose every claim is traceable to a paper.",
    arguments: [{ name: "question", description: "The research question.", required: true }]
  }
];
function getPrompt(name, args = {}) {
  const decl = PROMPTS.find((p) => p.name === name);
  if (!decl) throw new PromptError(`unknown prompt: ${name || "(none given)"}`);
  for (const arg of decl.arguments ?? []) {
    if (arg.required && !str2(args[arg.name])) throw new PromptError(`\`${arg.name}\` is required for prompt "${name}"`);
  }
  const text = name === "research_topic" ? researchTopic(args) : name === "debug_error" ? debugError(args) : literatureReview(args);
  return { description: decl.description, messages: [{ role: "user", content: { type: "text", text } }] };
}
var CORE_RULE = `Answer only from the sources this dossier actually fetched. Your training data is stale, and on a fast-moving topic it is confidently wrong. If the dossier does not cover something, say so and gather more \u2014 never fill the gap from memory and decorate it with a nearby citation.`;
var GATE = `\`ultrasearch_check\` returning \`ok: false\` is a VERDICT, not a tool failure. Read the errors, fix the report, and check again. Do not report a document that has not passed.`;
var THIN = `**If the dossier comes back thin**, do not write around it. Either gather again with different wording \u2014 the topic's own vocabulary, not yours \u2014 or find pages yourself and ingest each one with \`ultrasearch_fetch\` so it becomes a citable [S#]. A thin dossier honestly reported beats a full-looking report resting on four sources.`;
function researchTopic(args) {
  const question = str2(args.question);
  const depth = str2(args.depth);
  return `Research this and write a cited report:

> ${question}

${CORE_RULE}

**Sequence:**

1. If the question is too vague to search well, \`ultrasearch_brainstorm\` first and sharpen it. A broad gather returns a shallow dossier about the wrong thing.
2. \`ultrasearch_gather\` with \`mode: "topic"\`${depth ? ` and \`depth: "${depth}"\`` : ""}. It returns the dossier directory.
3. \`ultrasearch_read\` its \`DOSSIER.md\`. Read every source before writing anything.
4. Write the report: one claim per sentence, each carrying the \`[S#]\` it rests on. Quote figures, dates and names verbatim from the source \u2014 never reconstructed.
5. \`ultrasearch_check\` on the dossier. Then \`ultrasearch_render\` once it passes.

${THIN}

**Where sources disagree, say so and cite both.** A synthesis that silently picks a side is the failure this whole pipeline is built to prevent.

${GATE}`;
}
function debugError(args) {
  const error = str2(args.error);
  const context = str2(args.context);
  return `Find out what actually causes this error and what fixes it:

> ${error}
${context ? `
Context: ${context}
` : ""}
${CORE_RULE}

**Sequence:**

1. \`ultrasearch_gather\` with \`mode: "bug"\` and the error message as the question${context ? `, adding "${context}" to narrow it` : ""}. That mode searches StackOverflow, GitHub issues and HN \u2014 where this failure is actually reported.
2. \`ultrasearch_read\` the dossier. Read the accepted answers AND the comments under them: the top-voted fix is often superseded further down.
3. \`ultrasearch_search\` with \`backend: "github"\` if the dossier is thin \u2014 an open issue on the library itself settles "is this me or is this a bug" faster than anything else.
4. Answer with: the cause, the fix, and what to check to confirm it is the same failure and not a lookalike. Each cited \`[S#]\`.
5. \`ultrasearch_check\` on the dossier.

**Check the version.** A fix from a 2019 answer for a library now on v5 is not evidence about v5. If the sources do not say which version they apply to, say so \u2014 that is a real limit on the answer, not a detail to smooth over.

${GATE}`;
}
function literatureReview(args) {
  const question = str2(args.question);
  return `Write a literature review on:

> ${question}

${CORE_RULE}

**Sequence:**

1. \`ultrasearch_plan\` with \`mode: "research"\` \u2014 a broad question decomposes into sub-questions, each with its own dossier directory.
2. \`ultrasearch_gather\` on each sub-question, into the directory the plan named.
3. \`ultrasearch_merge\` the sub-dossiers into one. The \`[S#]\` ids are re-assigned to stay unique \u2014 cite the MERGED ids, not the ones you saw per sub-question.
4. \`ultrasearch_read\` the merged dossier, then write ONE review against it \u2014 not one section per sub-question stapled together.
5. \`ultrasearch_check\` on the merged dossier, then \`ultrasearch_render\`.

${THIN}

**Attribute findings to specific papers, with their limits.** "Studies show X" citing four papers is weaker than one sentence naming what one study measured, in what population, and what it did not establish. Where the literature disagrees, that disagreement IS the finding.

${GATE}`;
}
function str2(v) {
  return typeof v === "string" && v.trim() !== "" ? v : void 0;
}
var DECLARED = new Set([...TOOLS, ...WRITE_TOOLS].map((t) => t.name));

// src/mcp/adapter.ts
var CAP_ADVICE = {
  ultrasearch_gather: 'lower `max_sources` or `per_source`, or drop to `depth: "summary"`',
  ultrasearch_search: "lower `max_sources`",
  ultrasearch_merge: "merge fewer `runs`, or read the merged DOSSIER.md instead of inlining it",
  ultrasearch_verify: "lower `max_verify`, or split the worklist with `shards`/`shard`",
  ultrasearch_check: "the report is very large; check it in pieces",
  ultrasearch_read: "pass `start_line`/`end_line` to read a window instead of the whole file"
};
function ultrasearchAdapter(opts = {}) {
  return {
    version: VERSION,
    listTools: (protocol) => toolsFor(protocol, opts),
    callTool: (name, args) => callTool(name, args, opts),
    capAdvice: CAP_ADVICE,
    prompts: PROMPTS,
    getPrompt
  };
}

// src/cli.ts
var HELP = `ultrasearch v${VERSION}
Recap everything the web says about a topic \u2014 fan out keyless web search,
fetch + dedupe sources into a dossier, and write a citation-checked, tiered
report (with self-contained HTML). The web-facing sibling of ultradoc.

Usage:
  ultrasearch gather --q "<topic/question>" [--mode <m>] [--depth <d>] [options]
  ultrasearch queries --q "<question>" [--mode <m>] [--depth <d>] [--lang <c>] [--json]
  ultrasearch search --backend <kind> --q "<query>" [options]
  ultrasearch fetch  --url <u> --out <dossier-dir> [--q "<question>"] [--title <s>] [--cite-url <page>]
  ultrasearch ingest --run <dossier-dir> [--web-results <f.json|->] [--urls <u,...>] [--files <p,...>] [--json]
  ultrasearch render --run <dossier-dir> [--no-html] [--no-md]
  ultrasearch check  --run <dossier-dir> [--semantic] [--require-verify] [--strict-numerals] [--min-sources <n>]
  ultrasearch relink --run <dossier-dir> [--list] [--id <S#> --url <page>] [--title <s>]
  ultrasearch modes  [--json]
  ultrasearch doctor [--run <dossier-dir>] [--json]
  ultrasearch mcp    [--transport stdio|http] [--run <dossier-dir>] [--port <n>] [--bind <addr>]
                     [--allow-origin <o,...>] [--allow-remote] [--max-response-bytes <n>]
  ultrasearch brainstorm --q "<vague question>" [--mode <m>] [--out <dir>] [--json]
  ultrasearch plan   --q "<question>" [--mode <m>] [--subquestions "a|b|c"] [--run-root <dir>] [--max-subquestions <n>]
  ultrasearch merge  --runs "<dir1,dir2,\u2026>" --master <dir> [--q "<question>"]
  ultrasearch verify --run <dossier-dir> [--apply <files>] [--shards <n> --shard <i>] [--max-verify <n>]
  ultrasearch orchestrate --run <run-dir> [--phase gather|verify] [--eco] [--list]

Commands:
  gather   Fan out the mode's backends, fetch + dedupe, write the evidence
           dossier (sources.json, sources/S#.md, DOSSIER.md, manifest.json).
           You then write SUMMARY/REPORT.md, run render, then check.
  queries  Print the WebSearch worklist: how many DISTINCT queries to run for
           this depth, the mode's angles to cover, and the planner's starting
           points. Run YOUR OWN WebSearch once per angle, pool every hit, and
           feed them to gather --web-results. One query is not a sweep.
  search   Drill ONE backend and print ranked results (writes nothing).
  fetch    Ingest ONE URL into an existing dossier (alias: add-source). Prints
           the new source id (S#).
  ingest   Ingest MANY URLs into an existing dossier in a single process \u2014 the
           batch form of 'fetch', and the way to top up a dossier from your own
           WebSearch. Takes --web-results <f.json|-> or --urls <u,...>, and
           reports one outcome per URL (added / already there / refused).
  render   Render the report tiers in a dossier to a self-contained index.html
           AND a consolidated index.md (both by default; --no-html / --no-md skip one).
  check    Validate citation grounding of SUMMARY/REPORT.md (--semantic
           also folds in the verify verdicts: fails on unsupported claims;
           --require-verify makes a missing/empty VERIFY.json a hard failure \u2014
           the deep-tier exit gate; --min-sources <n> fails a too-thin dossier).
  relink   Repair source CITATIONS in place (no re-fetch, no network). Bare, it
           rewrites every source whose own text names where it lives (canonical
           link, DOI, arXiv id, PMID) and then prints what it could not prove.
           --list is the dry run. --id <S#> --url <page> folds in your answer.
  modes    List the report modes and their backend profiles.
  doctor   Report the state of the engine and its optional helpers: the SearXNG
           and Firecrawl containers, the PDF extractor ladder. The helpers are
           skipped in SILENCE when absent, so this is how you find out a
           container is up but unused, or a stronger PDF reader is missing.
           With --run <dossier-dir>, also says whether THAT run had a WebSearch
           lane \u2014 a dossier built without one looks just like a good one.
  searxng  | firecrawl   Manage the optional container: up | down | status.
  brainstorm  Probe a vague/ambiguous question with a shallow keyless search and
           propose candidate angles + clarifying questions before a full run
           (writes BRAINSTORM.md / BRAINSTORM.json). Use when the ask is unclear.

Deep research (the agentic tier \u2014 see references/deep-research-playbook.md):
  plan     Decompose a question into sub-questions (JSON) for the fan-out:
           run one 'gather' per sub-question, then 'merge'. With --run-root <dir>
           each sub-question carries a deterministic 'out' dir (<dir>/q1\u2026) so you
           can dispatch one gather per sub-question without parsing stdout.
  merge    Union sub-dossiers into one master dossier with stable [S#] ids.
  verify   Emit a claim\u2194source worklist for adversarial verification, then
           (--apply <files>) gate on refuted/unsupported claims. --shards <n>
           --shard <i> writes shard i only (one skeptic subagent per shard);
           --apply accepts several verdict files (comma list or a directory).
  orchestrate  Emit the run's multi-agent orchestration from its CURRENT
           worklists: one launchable workflow per ready phase (gather fans out
           one gatherer per PLAN.json sub-question; verify fans skeptics over
           VERIFY.todo.json) + the agents/<role>.md dispatch contracts + a
           sequential RUNBOOK.md, under <run>/orchestration/. Subagents return
           fragments; the merge / verify --apply folds stay with you.

Options:
  --q, --question <s>  The topic or question                      (required)
  --mode <m>           ${ALL_MODES.join(" | ")}   (default: topic)
  --depth <d>          ${ALL_DEPTHS.join(" | ")}            (default: standard)
  --backends <list>    Override the mode profile (comma-separated backend kinds)
  --backend <kind>     For 'search': the single backend to drill
  --queries <a|b|c>    Pipe-separated query variants to search with (overrides the
                       built-in planner; kept in dedup order, capped 2/4/6 by depth)
  --max-sources <n>    Opt-in FETCH budget: cap how many discovered candidates
                       get hydrated. UNSET BY DEFAULT \u2014 every page discovery
                       finds is fetched, and every page fetched and found
                       on-topic is kept. Set it only to bound a run's cost;
                       whatever it leaves behind is reported, never silent.
  --per-source <n>     Cap results per backend           (default: per depth)
  --lang <code>        Search language (translate --queries to it)  (default: en)
  --region <cc>        Region/country for locale-aware search   (default: from lang)
  --searxng <url>      SearXNG base URL                  (env ULTRASEARCH_SEARXNG)
  --firecrawl <url>    Self-hosted Firecrawl base URL for browser-rendered page
                       extraction; "off" disables it   (env ULTRASEARCH_FIRECRAWL,
                       default http://localhost:3002, skipped when unreachable)
  --web-results <f>    YOUR OWN WebSearch hits, as JSON: [{url,title,snippet}, \u2026]
                       (a bare array of URLs, or '-' for stdin, also work). This
                       is the PRIMARY discovery lane \u2014 the strongest index here,
                       and the only one needing neither a container nor a scrape.
  --search <p>         ${ALL_SEARCH_PROFILES.join(" | ")}   how wide discovery casts:
                       light = the WebSearch lane + the mode's API backends
                       full  = also fuse the keyless cascade + SearXNG
                       max   = the ceiling \u2014 full + Firecrawl's /search in
                               discovery, every recall knob at its limit, and
                               --depth deep unless you pin one. Wants the whole
                               container stack up and says so when it is not.
                       auto  = light when --web-results is given, else full
  --web-engine <e>     ${ALL_WEB_ENGINES.join(" | ")}
                       auto = resilient fallback cascade        (default: auto)
  --pages <n>          Result pages to fetch per web engine (\u22645; default: per depth)
  --web-breadth <n>    Web engines the auto cascade fuses   (\u22645; default: per depth)
  --url <u,...>        URLs for the 'generic' backend / 'fetch' / 'relink'
  --urls <u,...>       For 'ingest': the URLs to add (alternative to --web-results)
  --files <p,...>      For 'ingest': local documents to add \u2014 PDFs, office files
                       (.docx/.pptx/.xlsx/.odt/\u2026) and plain text. Their contents
                       enter the dossier and any report rendered from it.
  --cite-url <page>    For 'fetch': read the text from --url but CITE this page \u2014
                       when you know the document an endpoint returns
  --id <S#>            For 'relink': the source to repoint
  --title <s>          For 'fetch'/'relink': override the source's title
  --since <date>       Recency hint where a backend supports it
  --exclude-domains <list>  Drop these hosts from results
  --seed-domains <list>     Also run a targeted site: search for these primary
                       hosts and rank them as primary (up to 3, comma-separated)
  --concurrency <n>    In-flight page-fetch concurrency      (default: 6)
  --rounds <n>         Retrieval rounds; 2 adds a gap-driven follow-up web
                       search for under-covered terms          (default: 1)
  --cache              (default; kept as an accepted no-op) Reuse the on-disk
                       fetch cache across runs \u2014 24h TTL, keyed by canonical URL
                       + Accept-Language, successful extractions only
  --no-cache           Disable the on-disk fetch cache: fetch every page live
  --out <dir>          Dossier output dir   (default: /tmp/ultrasearch/<slug>/<id>)
  --run <dir>          For render/check/verify/orchestrate: the run dir to operate on
  --phase <name>       For 'orchestrate': emit one phase only \u2014 gather | verify
                       (exit 2 when its worklist does not exist yet)
  --eco                For 'orchestrate': emit only RUNBOOK.md + agents/*.md \u2014
                       the explicit sequential low-token path
  --list               For 'orchestrate': print the phases + readiness as JSON
  --no-html / --no-md  For 'render': skip index.html / the consolidated index.md
  --semantic           For 'check': also gate on the verify verdicts
  --require-verify     For 'check': fail if no adjudicated VERIFY.json (deep gate)
  --strict-numerals    For 'check': fail (not warn) when a cited claim's numeral
                       is absent from every cited source extract
  --min-sources <n>    For 'check': fail a dossier with fewer kept sources
  --stdout             Write NOTHING to disk; stream what would have been written
                       (env ULTRASEARCH_NO_WRITE=1 does the same globally). For a
                       read-only phase. gather \u2192 DOSSIER.md + every source
                       extract \xB7 brainstorm \u2192 BRAINSTORM.md \xB7 plan \u2192 PLAN.json \xB7
                       render \u2192 index.md (no HTML). merge / fetch / verify /
                       orchestrate exit 2: they exist to leave files behind.
                       No 'check' gate is possible without files \u2014 cite carefully.
  --json               Machine-readable output
  -h, --help           Show this help
  -v, --version        Show version

Deep-tier options (plan / merge / verify):
  --subquestions <a|b|c>    plan: override the sub-questions (pipe-separated)
  --max-subquestions <n>    plan: cap the decomposition       (default: ${DEEP_CAPS.maxSubQuestions})
  --run-root <dir>          plan: give each sub-question an out dir under <dir>
  --runs <d1,d2,\u2026>          merge: the sub-dossiers to union
  --master <dir>            merge: the master dossier dir     (default: derived)
  --apply <spec>            verify: verdict file, comma list, or directory
  --shards <n> --shard <i>  verify: write only shard i of the worklist (0-based)
  --max-verify <n>          verify: cap claim\u2194source pairs    (default: ${DEEP_CAPS.maxVerify})

Grounding:
  'gather' writes the dossier; you write SUMMARY/REPORT.md citing sources
  like [S1], flagging your own knowledge as [M] or '> [model-hint]'. Then:
    ultrasearch render --run <dir>   # \u2192 index.html + index.md
    ultrasearch check  --run <dir>   # exit\u22600 if a claim is ungrounded
`;
var COMMANDS = /* @__PURE__ */ new Set([
  "gather",
  "queries",
  "search",
  "fetch",
  "add-source",
  "ingest",
  "render",
  "check",
  "relink",
  "modes",
  "brainstorm",
  "plan",
  "merge",
  "verify",
  "orchestrate",
  "mcp",
  "doctor",
  "searxng",
  "firecrawl"
]);
var VALUE_FLAGS = /* @__PURE__ */ new Set([
  "q",
  "question",
  "mode",
  "depth",
  "backends",
  "backend",
  "queries",
  "max-sources",
  "per-source",
  "concurrency",
  "rounds",
  "pages",
  "web-breadth",
  "out",
  "run",
  "lang",
  "region",
  "searxng",
  "firecrawl",
  "web-engine",
  "web-results",
  "search",
  "urls",
  "files",
  "url",
  "cite-url",
  "id",
  "since",
  "exclude-domains",
  "seed-domains",
  "title",
  "subquestions",
  "runs",
  "master",
  "apply",
  "max-subquestions",
  "max-verify",
  "run-root",
  "shards",
  "shard",
  "min-sources",
  "phase",
  // `mcp` only. The flag sets are global, so these are accepted (and ignored)
  // on every command — the same as --phase and --list already are.
  "transport",
  "port",
  "bind",
  "allow-origin",
  "max-response-bytes"
]);
var BOOL_FLAGS = /* @__PURE__ */ new Set([
  "json",
  "stdout",
  "no-html",
  "no-md",
  "semantic",
  "require-verify",
  "strict-numerals",
  "cache",
  "no-cache",
  "eco",
  "list",
  "allow-remote"
]);
function fail(message) {
  process.stderr.write(`ultrasearch: ${message}
`);
  process.exit(1);
}
function oneOf2(name, value, allowed) {
  if (!allowed.includes(value)) {
    fail(`invalid --${name} "${value}" (expected: ${allowed.join(", ")})`);
  }
  return value;
}
function parseArgs(argv) {
  if (argv.length === 0) {
    process.stdout.write(HELP);
    process.exit(0);
  }
  if (argv[0] === "-h" || argv[0] === "--help") {
    process.stdout.write(HELP);
    process.exit(0);
  }
  if (argv[0] === "-v" || argv[0] === "--version") {
    process.stdout.write(VERSION + "\n");
    process.exit(0);
  }
  const command = argv[0];
  if (!COMMANDS.has(command)) {
    fail(`unknown command: ${command} (run --help for usage)`);
  }
  const values = {};
  const bools = /* @__PURE__ */ new Set();
  const positional = [];
  for (let i = 1; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "-h" || arg === "--help") {
      process.stdout.write(HELP);
      process.exit(0);
    }
    if (arg === "-v" || arg === "--version") {
      process.stdout.write(VERSION + "\n");
      process.exit(0);
    }
    if (arg.startsWith("--")) {
      const eq = arg.indexOf("=");
      const key = eq !== -1 ? arg.slice(2, eq) : arg.slice(2);
      if (BOOL_FLAGS.has(key)) {
        if (eq !== -1) fail(`--${key} is a boolean flag and does not take a value`);
        bools.add(key);
        continue;
      }
      if (!VALUE_FLAGS.has(key)) {
        fail(`unknown flag: --${key} (run --help for the supported options)`);
      }
      let value;
      if (eq !== -1) {
        value = arg.slice(eq + 1);
      } else {
        const next = argv[i + 1];
        if (next === void 0 || next.startsWith("--")) {
          fail(`missing value for --${key}`);
        }
        value = next;
        i++;
      }
      values[key] = value;
      continue;
    }
    positional.push(arg);
  }
  return { command, positional, values, bools };
}
function parseList(s) {
  return s.split(",").map((x) => x.trim()).filter(Boolean);
}
function resolveApplyPaths(spec) {
  if (spec.includes(",")) return parseList(spec).map((x) => resolve5(x));
  const abs = resolve5(spec);
  if (existsSync12(abs) && statSync4(abs).isDirectory()) {
    const files = readdirSync2(abs).filter((f) => /verdict/i.test(f) && /\.json$/i.test(f)).sort().map((f) => resolve5(abs, f));
    if (!files.length) fail(`no verdict files (*verdict*.json) in directory ${abs}`);
    return files;
  }
  return [abs];
}
function parseShardArgs(shardsRaw, shardRaw) {
  let shards;
  if (shardsRaw !== void 0) {
    const n = Number(shardsRaw);
    if (!Number.isInteger(n) || n < 1) return { ok: false, error: `invalid --shards "${shardsRaw}" (expected an integer \u2265 1)` };
    shards = n;
  }
  let shard;
  if (shardRaw !== void 0) {
    const n = Number(shardRaw);
    if (!Number.isInteger(n) || n < 0) return { ok: false, error: `invalid --shard "${shardRaw}" (expected an integer \u2265 0)` };
    shard = n;
  }
  if (shards !== void 0 && shard === void 0) return { ok: false, error: "--shards requires --shard <i> (0-based)" };
  if (shards === void 0 && shard !== void 0) return { ok: false, error: "--shard requires --shards <n>" };
  if (shards !== void 0 && shard !== void 0 && shard >= shards) {
    return { ok: false, error: `--shard ${shard} is out of range for --shards ${shards} (use 0..${shards - 1})` };
  }
  return { ok: true, shards, shard };
}
function readWebResultsPayload(spec) {
  if (spec === "-") {
    try {
      return readFileSync12(0, "utf8");
    } catch {
      fail("--web-results -: could not read stdin");
    }
  }
  const abs = resolve5(spec);
  if (!existsSync12(abs)) fail(`--web-results file not found: ${abs}`);
  try {
    return readFileSync12(abs, "utf8");
  } catch (e) {
    fail(`--web-results: could not read ${abs} (${e.message})`);
  }
}
function parseBackends(s) {
  const out = [];
  for (const t of parseList(s)) {
    if (!ALL_BACKENDS.includes(t)) {
      fail(`unknown backend "${t}" (use: ${ALL_BACKENDS.join(", ")})`);
    }
    if (!out.includes(t)) out.push(t);
  }
  if (out.length === 0) fail("--backends resolved to nothing");
  return out;
}
var NO_WRITE_REFUSED = {
  merge: "it unions the sub-dossiers into a master dossier on disk",
  fetch: "it adds a new [S#] to a dossier on disk",
  "add-source": "it adds a new [S#] to a dossier on disk",
  ingest: "it adds new [S#] entries to a dossier on disk",
  relink: "it rewrites a source's url in a dossier on disk",
  verify: "it emits a worklist for skeptics to read from disk (and --apply folds their verdicts back into it)",
  orchestrate: "it emits workflow scripts and agent contracts the harness opens by path"
};
var STDOUT_BRIEF = ["DOSSIER.md", "BRAINSTORM.md", "PLAN.json", "index.md"];
function sourceNum(rel) {
  return Number(/^sources\/S(\d+)\.md$/.exec(rel)?.[1] ?? 0);
}
function emitArtifacts(dir, asJson, extra = {}) {
  const artifacts = takeArtifacts().map((a) => ({ rel: relative2(dir, a.path) || basename3(a.path), content: a.content }));
  if (asJson) {
    const files = {};
    for (const a of artifacts) files[a.rel] = a.content;
    process.stdout.write(JSON.stringify({ dir: null, ...extra, artifacts: files }, null, 2) + "\n");
    return;
  }
  const at = (rel) => artifacts.find((a) => a.rel === rel);
  const shown = [
    ...STDOUT_BRIEF.map(at),
    ...artifacts.filter((a) => sourceNum(a.rel) > 0).sort((a, b) => sourceNum(a.rel) - sourceNum(b.rel)),
    at("refs.bib")
  ].filter((a) => a !== void 0);
  const out = shown.map((a) => `===== ${a.rel} =====
${a.content.endsWith("\n") ? a.content : a.content + "\n"}`);
  if (out.length) process.stdout.write(out.join(""));
}
function num2(name, raw, fallback) {
  if (raw === void 0) return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) fail(`invalid --${name} "${raw}"`);
  return Math.floor(n);
}
function gatherReport(r, options) {
  const used = r.manifest.backendsUsed.join(", ") || "none";
  const head = [
    `ultrasearch: ${r.sources.length} source(s) for "${options.question}"`,
    `  mode:     ${options.mode} \xB7 depth: ${options.depth}`,
    `  backends: ${used}`,
    // Never advertise a directory that --stdout deliberately did not create.
    options.stdout ? `  dossier:  --stdout \u2014 nothing written; the dossier is on stdout` : `  dossier:  ${r.dir}`
  ];
  if (r.sources.length === 0) {
    const noLane = !options.webResults?.length;
    return {
      exitCode: 1,
      lines: [
        ...head,
        `  EMPTY DOSSIER \u2014 retrieval returned nothing usable. Do NOT write tiers over this. Recover it:`,
        noLane ? `    1. run YOUR OWN WebSearch and feed it back: ultrasearch gather --q "\u2026" --web-results <hits.json>` : `    1. widen the lane: more/other WebSearch queries \u2192 a bigger --web-results, or --search full to fuse the keyless engines`,
        options.stdout ? `    2. or read the pages your WebSearch found directly \u2014 \`fetch\`/\`ingest\` need a dossier on disk.` : `    2. or pin what you found: ultrasearch ingest --run ${r.dir} --web-results <hits.json>`,
        `    3. stop after two empty attempts \u2014 report the gap; NEVER invent sources.`
      ]
    };
  }
  const fused = r.manifest.enginesFused ?? [];
  const ignored = ignoredByExplicitBackends(options);
  const under = r.manifest.coverage?.under ?? [];
  const ws = r.manifest.webSearch;
  const laneLine = ws?.supplied ? `  websearch: ${ws.supplied} hit(s) supplied \u2192 ${ws.kept} kept${ws.rejected ? ` (${ws.rejected} rejected)` : ""}` : `  websearch: none supplied \u2014 pass your own hits with --web-results <f.json> for the strongest lane`;
  return {
    exitCode: 0,
    lines: [
      ...head,
      ...r.manifest.searchProfile ? [`  search:   ${r.manifest.searchProfile}`] : [],
      laneLine,
      ...fused.length ? [`  engines:  ${fused.join(", ")} (fused)`] : [],
      ...ignored.length ? [`  IGNORED:  ${ignored.join(", ")} \u2014 --backends bypasses the cascade, seed-domain and gap rounds`] : [],
      ...under.length ? [`  weak:     ${under.slice(0, 6).join(", ")} \u2014 enrich these before ${options.stdout ? "answering" : "writing"}`] : [],
      ...options.stdout ? [
        `  next:     the dossier and every source extract are on stdout \u2014 answer inline, citing [S#].`,
        `            NO 'check' gate exists without files: never state anything the extracts do not say.`
      ] : [
        `  next:     read ${r.dir}/DOSSIER.md, write SUMMARY/REPORT.md (cite [S#]), then:`,
        `            ultrasearch render --run ${r.dir} && ultrasearch check --run ${r.dir}`
      ]
    ]
  };
}
function buildGatherOptions(p, opts = {}) {
  const question = p.values.q ?? p.values.question ?? "";
  if (opts.requireQuestion !== false && !question) fail('missing --q "<question>"');
  const mode = oneOf2("mode", p.values.mode ?? "topic", ALL_MODES);
  const askedMax = p.values.search === "max";
  const depth = oneOf2("depth", p.values.depth ?? (askedMax ? "deep" : "standard"), ALL_DEPTHS);
  const caps = DEPTH_CAPS[depth];
  const webEngine = oneOf2("web-engine", p.values["web-engine"] ?? "auto", ALL_WEB_ENGINES);
  const search = oneOf2("search", p.values.search ?? "auto", ALL_SEARCH_PROFILES);
  const webSpec = p.values["web-results"];
  const parsedWeb = webSpec ? parseWebResults(readWebResultsPayload(webSpec)) : void 0;
  if (parsedWeb) {
    for (const n of parsedWeb.notes) process.stderr.write(`ultrasearch: ${n}
`);
    if (!parsedWeb.hits.length) {
      fail(`--web-results ${webSpec} yielded no usable hit \u2014 expected [{"url":"https://\u2026"}, \u2026] (or a list of URLs).`);
    }
  }
  return {
    question,
    mode,
    depth,
    backends: p.values.backends ? parseBackends(p.values.backends) : void 0,
    queries: p.values.queries ? p.values.queries.split("|").map((s) => s.trim()).filter(Boolean) : void 0,
    // Unset unless asked for: no default FETCH budget (see GatherOptions).
    maxSources: p.values["max-sources"] ? num2("max-sources", p.values["max-sources"], 0) : void 0,
    perSource: num2("per-source", p.values["per-source"], caps.perSource),
    lang: p.values.lang ?? "en",
    region: p.values.region,
    searxng: p.values.searxng,
    firecrawl: p.values.firecrawl,
    webEngine,
    search,
    ...parsedWeb ? { webResults: parsedWeb.hits, webResultsRejected: parsedWeb.rejected } : {},
    pages: p.values.pages ? Math.min(5, num2("pages", p.values.pages, 1)) : void 0,
    webBreadth: p.values["web-breadth"] ? Math.min(5, num2("web-breadth", p.values["web-breadth"], 1)) : void 0,
    urls: p.values.url ? parseList(p.values.url) : void 0,
    since: p.values.since,
    excludeDomains: p.values["exclude-domains"] ? parseList(p.values["exclude-domains"]) : [],
    seedDomains: p.values["seed-domains"] ? parseList(p.values["seed-domains"]) : void 0,
    concurrency: p.values.concurrency ? num2("concurrency", p.values.concurrency, 6) : void 0,
    rounds: p.values.rounds ? num2("rounds", p.values.rounds, 1) : void 0,
    // Default ON: the on-disk cache is a pure win for the deep tier's fan-out,
    // for a re-gather after a failed check, and for the `fetch --url` bridge.
    // `--cache` stays an accepted no-op so every prompt and emitted contract
    // already in the wild keeps working; `--no-cache` is the escape hatch.
    cache: !p.bools.has("no-cache"),
    out: p.values.out ? resolve5(p.values.out) : void 0,
    json: p.bools.has("json"),
    // Read from the gate, not the flag, so ULTRASEARCH_NO_WRITE=1 alone still
    // reshapes the guidance. main() calls setNoWrite before this runs.
    stdout: isNoWrite()
  };
}
async function main(argv = process.argv.slice(2)) {
  const p = parseArgs(argv);
  setNoWrite(p.bools.has("stdout"));
  const refused = NO_WRITE_REFUSED[p.command];
  if (refused && isNoWrite()) {
    process.stderr.write(
      `ultrasearch: \`${p.command}\` cannot run without writing \u2014 ${refused}.
             Drop --stdout / ULTRASEARCH_NO_WRITE=1, or run it outside the read-only phase.
`
    );
    process.exitCode = 2;
    return;
  }
  switch (p.command) {
    case "gather": {
      const options = buildGatherOptions(p);
      if (options.search === "max" && !options.json) {
        const down = (await probeServices({ firecrawl: options.firecrawl, searxng: options.searxng })).filter(
          (s) => !s.ok && (s.name === "searxng" || s.name === "firecrawl")
        );
        if (down.length) {
          process.stderr.write(
            `ultrasearch: --search max wants the container stack, and ${down.map((s) => s.name).join(" + ")} ${down.length > 1 ? "are" : "is"} not answering.
             Start it:  ultrasearch firecrawl up
             Continuing without it \u2014 the run will say what it lost.
`
          );
        }
      }
      const r = await runGather(options);
      const report = gatherReport(r, options);
      if (options.stdout) {
        emitArtifacts(r.dir, options.json, { manifest: r.manifest });
        process.stderr.write(report.lines.join("\n") + "\n");
        process.exitCode = report.exitCode;
        return;
      }
      if (options.json) {
        process.stdout.write(JSON.stringify({ dir: r.dir, manifest: r.manifest }, null, 2) + "\n");
        process.exitCode = report.exitCode;
        return;
      }
      process.stderr.write(report.lines.join("\n") + "\n");
      process.exitCode = report.exitCode;
      return;
    }
    case "search": {
      const backendStr = p.values.backend;
      if (!backendStr) fail("missing --backend <kind>");
      const [backend] = parseBackends(backendStr);
      const options = buildGatherOptions(p);
      const ctx = { question: options.question, mode: getMode(options.mode), options, variants: [options.question] };
      const [res] = await runBackends([backend], ctx);
      if (!res) return;
      if (p.bools.has("json")) {
        process.stdout.write(JSON.stringify(res, null, 2) + "\n");
        return;
      }
      const out = [`# ${backend} \u2014 ${res.items.length} result(s) for "${options.question}"`, ""];
      res.items.forEach((it, i) => {
        const s = buildSource(it, `S${i + 1}`, (/* @__PURE__ */ new Date()).toISOString(), options.question);
        out.push(`## [${s.id}] ${s.title}`);
        out.push(`${s.url} \xB7 trust: ${s.trust} \xB7 score: ${s.score}`);
        if (s.snippet) out.push(s.snippet);
        out.push("");
      });
      for (const n of res.notes) out.push(`> ${n}`);
      process.stdout.write(out.join("\n") + "\n");
      return;
    }
    case "queries": {
      const question = p.values.q ?? p.values.question;
      if (!question) fail('missing --q "<question>"');
      const plan = planQueries({
        question,
        mode: oneOf2("mode", p.values.mode ?? "topic", ALL_MODES),
        depth: oneOf2("depth", p.values.depth ?? "standard", ALL_DEPTHS),
        lang: p.values.lang
      });
      process.stdout.write(p.bools.has("json") ? JSON.stringify(plan, null, 2) + "\n" : formatQueryPlan(plan));
      return;
    }
    case "modes": {
      const modes = listModes();
      if (p.bools.has("json")) {
        process.stdout.write(JSON.stringify(modes, null, 2) + "\n");
        return;
      }
      const out = ["ultrasearch modes:", ""];
      for (const m of modes) {
        out.push(`  ${m.name.padEnd(9)} ${m.description}`);
        out.push(`            backends: ${m.backends.join(", ")}${m.deepOnly.length ? ` (+deep: ${m.deepOnly.join(", ")})` : ""}`);
        if (m.extras.length) out.push(`            extras:   ${m.extras.join(", ")}`);
      }
      process.stdout.write(out.join("\n") + "\n");
      return;
    }
    // Which optional helpers are actually live. Exists because every one of them
    // is skipped in silence when absent: without this, a SearXNG container can
    // sit up for weeks, never be queried, and nothing anywhere says so.
    case "doctor": {
      const runDir = p.values.run;
      let manifest;
      if (runDir) {
        const mf = join15(resolve5(runDir), "manifest.json");
        if (!existsSync12(mf)) fail(`no dossier at ${resolve5(runDir)} (no manifest.json)`);
        try {
          manifest = JSON.parse(readFileSync12(mf, "utf8"));
        } catch (e) {
          fail(`could not read ${mf}: ${e.message}`);
        }
      }
      const rows = [describeWebSearchLane(manifest), ...await probeServices({ firecrawl: p.values.firecrawl, searxng: p.values.searxng })];
      if (p.bools.has("json")) {
        process.stdout.write(JSON.stringify(rows, null, 2) + "\n");
        return;
      }
      const head = runDir ? `ultrasearch ${VERSION} \u2014 ${resolve5(runDir)}` : `ultrasearch ${VERSION} \u2014 the engine, and the optional helpers`;
      process.stdout.write(`${head}

${formatServices(rows)}
`);
      return;
    }
    case "searxng":
    case "firecrawl": {
      const action = p.positional[0] ?? "status";
      if (action === "status") {
        const rows = (await probeServices({ firecrawl: p.values.firecrawl, searxng: p.values.searxng })).filter((r2) => r2.name === p.command);
        process.stdout.write(formatServices(rows) + "\n");
        return;
      }
      if (action !== "up" && action !== "down") {
        fail(`${p.command}: unknown action '${action}' (expected up | down | status)`);
      }
      const r = stackControl(p.command, action);
      process.stdout.write(r.message + "\n");
      if (r.code !== 0) process.exit(r.code);
      if (action === "up") {
        const rows = (await probeServices({ firecrawl: p.values.firecrawl, searxng: p.values.searxng })).filter((r2) => r2.name === p.command);
        process.stdout.write("\n" + formatServices(rows) + "\n");
      }
      return;
    }
    case "brainstorm": {
      const options = buildGatherOptions(p);
      const result = await runBrainstorm(options);
      if (options.stdout) {
        emitArtifacts(result.dir, options.json);
        process.stderr.write(`ultrasearch brainstorm: "${result.question}" \u2014 nothing written (--stdout).
`);
        return;
      }
      if (p.bools.has("json")) {
        process.stdout.write(JSON.stringify(result, null, 2) + "\n");
        return;
      }
      const out = [];
      out.push(`ultrasearch brainstorm: "${result.question}"`);
      out.push(result.signals.ambiguous ? `  \u26A0 under-specified \u2014 ${result.signals.reasons.join(" ")}` : `  \u2713 specific enough to research directly`);
      if (result.angles.length) {
        out.push("  candidate angles:");
        for (const a of result.angles) out.push(`    \xB7 ${a.label}`);
      }
      if (result.candidateQuestions.length) {
        out.push("  candidate refined questions:");
        for (const c of result.candidateQuestions) out.push(`    \xB7 ${c.question}`);
      }
      out.push("  ask the user:");
      for (const q of result.userQuestions) out.push(`    ? ${q}`);
      out.push(`  written: ${resolve5(result.dir)}/BRAINSTORM.md`);
      process.stdout.write(out.join("\n") + "\n");
      return;
    }
    case "plan": {
      const options = buildGatherOptions(p);
      const override = p.values.subquestions ? p.values.subquestions.split("|").map((s) => s.trim()).filter(Boolean) : void 0;
      const cap = p.values["max-subquestions"] ? num2("max-subquestions", p.values["max-subquestions"], 6) : void 0;
      const runRoot = p.values["run-root"] ? resolve5(p.values["run-root"]) : void 0;
      const depth = p.values.depth !== void 0 ? options.depth : void 0;
      const result = runPlan(options.question, options.mode, override, cap, runRoot, depth);
      if (options.stdout) takeArtifacts();
      process.stdout.write(JSON.stringify(result, null, 2) + "\n");
      const rootHint = runRoot ? ` \u2014 each carries an \`out\` dir under ${runRoot} to gather into` : "";
      process.stderr.write(
        `ultrasearch: ${result.subQuestions.length} sub-question(s) for "${options.question}" (mode ${options.mode}) \u2014 fan out a gather per sub-question, then \`merge\`${rootHint}.
`
      );
      return;
    }
    case "merge": {
      const runs = p.values.runs ? parseList(p.values.runs).map((d) => resolve5(d)) : [];
      if (!runs.length) fail('missing --runs "<dir1,dir2,\u2026>"');
      for (const d of runs) if (!existsSync12(d)) fail(`run dir not found: ${d}`);
      const mode = p.values.mode ? oneOf2("mode", p.values.mode, ALL_MODES) : void 0;
      const result = runMerge({
        runs,
        master: p.values.master ? resolve5(p.values.master) : void 0,
        question: p.values.q ?? p.values.question,
        mode
      });
      if (p.bools.has("json")) {
        process.stdout.write(JSON.stringify({ dir: result.dir, manifest: result.manifest }, null, 2) + "\n");
        return;
      }
      const lines = [
        `ultrasearch: merged ${runs.length} sub-dossier(s) \u2192 ${result.sources.length} source(s)`,
        `  master:   ${result.dir}`,
        `  next:     read ${result.dir}/DOSSIER.md, write SUMMARY/REPORT.md citing the MASTER [S#] ids, then:`,
        `            ultrasearch verify --run ${result.dir} && ultrasearch check --semantic --run ${result.dir}`
      ];
      process.stderr.write(lines.join("\n") + "\n");
      return;
    }
    case "fetch":
    case "add-source": {
      const dir = p.values.out ?? p.values.run;
      if (!dir) fail("missing --out <dossier-dir>");
      const url = p.values.url;
      if (!url) fail("missing --url <u>");
      const r = await addSource(resolve5(dir), url, {
        question: p.values.q ?? p.values.question,
        title: p.values.title,
        citeUrl: p.values["cite-url"],
        firecrawl: p.values.firecrawl,
        cache: !p.bools.has("no-cache")
        // same default-on policy as gather
      });
      if (p.bools.has("json")) {
        process.stdout.write(JSON.stringify(r, null, 2) + "\n");
      } else if (r.added) {
        process.stdout.write(`${r.id}
`);
        process.stderr.write(`ultrasearch: added ${r.id} \u2190 ${url}
`);
      } else {
        process.stderr.write(`ultrasearch: ${r.note ?? "not added"}
`);
        if (r.id) process.stdout.write(`${r.id}
`);
      }
      if (!r.id) process.exit(1);
      return;
    }
    case "ingest": {
      const dir = p.values.run ?? p.values.out;
      if (!dir) fail("missing --run <dossier-dir>");
      const spec = p.values["web-results"];
      const listed = p.values.urls ? parseList(p.values.urls) : [];
      const files = p.values.files ? parseList(p.values.files) : [];
      if (!spec && !listed.length && !files.length) fail("missing --web-results <f.json|->, --urls <u,...> or --files <p,...>");
      const hits = [...listed];
      if (spec) {
        const parsed = parseWebResults(readWebResultsPayload(spec));
        for (const n of parsed.notes) process.stderr.write(`ultrasearch: ${n}
`);
        if (!parsed.hits.length && !listed.length && !files.length) {
          fail(`--web-results ${spec} yielded no usable hit \u2014 expected [{"url":"https://\u2026"}, \u2026] (or a list of URLs).`);
        }
        hits.push(...parsed.hits);
      }
      const enrichOpts = {
        question: p.values.q ?? p.values.question,
        cache: !p.bools.has("no-cache"),
        firecrawl: p.values.firecrawl
      };
      const web = hits.length ? await addSources(resolve5(dir), hits, enrichOpts) : void 0;
      const local = files.length ? await addFiles(resolve5(dir), files, enrichOpts) : void 0;
      const r = {
        results: [...web?.results ?? [], ...local?.results ?? []],
        added: (web?.added ?? 0) + (local?.added ?? 0),
        skipped: (web?.skipped ?? 0) + (local?.skipped ?? 0)
      };
      if (p.bools.has("json")) {
        process.stdout.write(JSON.stringify(r, null, 2) + "\n");
      } else {
        for (const o of r.results) {
          process.stdout.write(o.added ? `${o.id}	${o.url}
` : `-	${o.url}	${o.note ?? "not added"}
`);
        }
        const what = files.length ? hits.length ? "input(s)" : "file(s)" : "URL(s)";
        process.stderr.write(`ultrasearch: ingested ${r.added} source(s), skipped ${r.skipped} of ${r.results.length} ${what} \u2192 ${resolve5(dir)}
`);
      }
      if (!r.added) process.exit(1);
      return;
    }
    case "render": {
      const dir = p.values.run ?? p.values.out;
      if (!dir) fail("missing --run <dossier-dir>");
      const rdir = resolve5(dir);
      if (isNoWrite()) {
        if (p.bools.has("no-md")) {
          process.stderr.write("ultrasearch render: --stdout --no-md leaves nothing to emit (--stdout never produces HTML).\n");
          process.exitCode = 2;
          return;
        }
        writeReportMarkdown(rdir);
        emitArtifacts(rdir, p.bools.has("json"));
        process.stderr.write("ultrasearch: --stdout \u2014 index.md above; index.html skipped (it is only useful as a file).\n");
        return;
      }
      const written = {};
      if (!p.bools.has("no-html")) {
        written.html = writeHtml(rdir, p.values.out && p.values.run ? resolve5(p.values.out) : void 0);
        process.stderr.write(`ultrasearch: wrote ${written.html}
`);
      }
      if (!p.bools.has("no-md")) {
        written.md = writeReportMarkdown(rdir);
        process.stderr.write(`ultrasearch: wrote ${written.md}
`);
      }
      if (p.bools.has("json")) process.stdout.write(JSON.stringify(written, null, 2) + "\n");
      return;
    }
    case "verify": {
      const dir = p.values.run ?? p.values.out;
      if (!dir) fail("missing --run <dossier-dir>");
      const rdir = resolve5(dir);
      if (p.values.apply) {
        const result = applyVerdicts(rdir, resolveApplyPaths(p.values.apply));
        if (p.bools.has("json")) process.stdout.write(JSON.stringify(result, null, 2) + "\n");
        else process.stdout.write(formatVerifyReport(result) + "\n");
        if (!result.ok) process.exit(1);
        return;
      }
      const maxVerify = p.values["max-verify"] ? num2("max-verify", p.values["max-verify"], DEEP_CAPS.maxVerify) : void 0;
      const sh = parseShardArgs(p.values.shards, p.values.shard);
      if (!sh.ok) fail(sh.error);
      const wl = runVerify(rdir, { maxVerify, shards: sh.shards, shard: sh.shard });
      if (p.bools.has("json")) {
        process.stdout.write(JSON.stringify(wl, null, 2) + "\n");
        return;
      }
      if (sh.shards !== void 0) {
        process.stderr.write(
          `ultrasearch: ${wl.pairs.length} pair(s) (shard ${sh.shard} of ${sh.shards}) \u2192 ${rdir}/VERIFY.todo.${sh.shard}.json
  adjudicate each verdict, save as verdicts.${sh.shard}.json, then (once all shards are done):
  ultrasearch verify --apply ${rdir} --run ${rdir}   # a dir picks up every verdicts*.json
`
        );
      } else {
        process.stderr.write(
          `ultrasearch: ${wl.pairs.length} claim\u2194source pair(s) \u2192 ${rdir}/VERIFY.todo.json
  adjudicate each verdict, save as verdicts.json, then: ultrasearch verify --apply verdicts.json --run ${rdir}
`
        );
      }
      return;
    }
    case "orchestrate": {
      const dir = p.values.run;
      if (!dir) {
        process.stderr.write("ultrasearch orchestrate: --run <dir> is required (the run dir holding the worklists PLAN.json / VERIFY.todo.json).\n");
        process.exit(2);
      }
      const engineAbs = realpathSync3(fileURLToPath2(import.meta.url));
      if (p.bools.has("list")) {
        if (!existsSync12(resolve5(dir))) {
          process.stderr.write(`ultrasearch orchestrate: run dir not found: ${resolve5(dir)}
`);
          process.exit(2);
        }
        process.stdout.write(JSON.stringify({ phases: listPhases(dir, engineAbs) }, null, 2) + "\n");
        return;
      }
      const res = orchestrateRun(dir, engineAbs, {
        phase: p.values.phase,
        eco: p.bools.has("eco")
      });
      if (res.exitCode !== 0) {
        for (const e of res.errors) process.stderr.write(`ultrasearch orchestrate: ${e}
`);
        process.exit(res.exitCode);
      }
      const lines = ["ultrasearch orchestrate: generated"];
      for (const w of res.written) lines.push(`  ${w}`);
      const workflows = res.written.filter((w) => w.endsWith(".workflow.mjs"));
      if (workflows.length) {
        lines.push("");
        for (const w of workflows) lines.push(`Launch: Workflow({ scriptPath: ${JSON.stringify(w)} })`);
        lines.push("Then run the fold shown at the end of each workflow yourself (merge / verify --apply) \u2014 you stay the sole writer.");
      } else {
        lines.push(`Follow ${join15(resolve5(dir), "orchestration", "RUNBOOK.md")} sequentially (the eco path).`);
      }
      process.stdout.write(lines.join("\n") + "\n");
      for (const n of res.notices) process.stderr.write(`ultrasearch orchestrate: note \u2014 ${n}
`);
      if (p.values.phase === void 0 && workflows.length === 0 && !p.bools.has("eco")) {
        process.stderr.write(`ultrasearch orchestrate: no ready phase \u2014 phases are ${PHASES.join(", ")} (see --list).
`);
      }
      return;
    }
    case "mcp": {
      const transport = oneOf2("transport", p.values.transport ?? "stdio", ["stdio", "http"]);
      const maxResponseBytes = p.values["max-response-bytes"] ? Number(p.values["max-response-bytes"]) : void 0;
      if (maxResponseBytes !== void 0 && (!Number.isFinite(maxResponseBytes) || maxResponseBytes <= 0)) fail("invalid --max-response-bytes");
      const options = {
        // A default dossier makes `run` optional on every tool, for a server
        // dedicated to one piece of research.
        defaultRun: p.values.run,
        maxResponseBytes
      };
      if (transport === "stdio") {
        await runStdioServer(ultrasearchAdapter(options), options);
        return;
      }
      const port = p.values.port ? Number(p.values.port) : 7339;
      if (!Number.isInteger(port) || port < 0 || port > 65535) fail("invalid --port");
      const allowOrigin = p.values["allow-origin"] ? p.values["allow-origin"].split(",").map((s) => s.trim()).filter(Boolean) : void 0;
      let running;
      try {
        running = await startHttpServer(ultrasearchAdapter(options), {
          ...options,
          port,
          bind: p.values.bind,
          allowOrigin,
          allowRemote: p.bools.has("allow-remote")
        });
      } catch (e) {
        fail(e.message);
      }
      process.stderr.write(`ultrasearch: MCP server listening on ${running.url}
`);
      process.stderr.write(`  client: claude mcp add --transport http ultrasearch ${running.url}
`);
      for (const sig of ["SIGINT", "SIGTERM"]) {
        process.once(sig, () => {
          void running.close().then(() => process.exit(0));
        });
      }
      await new Promise((resolve6) => running.server.once("close", resolve6));
      return;
    }
    case "check": {
      const dir = p.values.run ?? p.values.out;
      if (!dir) fail("missing --run <dossier-dir>");
      const minSources = p.values["min-sources"] ? num2("min-sources", p.values["min-sources"], 1) : void 0;
      const res = runCheck(resolve5(dir), {
        semantic: p.bools.has("semantic"),
        requireVerify: p.bools.has("require-verify"),
        strictNumerals: p.bools.has("strict-numerals"),
        minSources
      });
      if (p.bools.has("json")) {
        process.stdout.write(JSON.stringify(res, null, 2) + "\n");
      } else {
        process.stdout.write(formatCheckReport(res, resolve5(dir)) + "\n");
      }
      if (!res.ok) process.exit(1);
      return;
    }
    case "relink": {
      const dir = p.values.run ?? p.values.out;
      if (!dir) fail("missing --run <dossier-dir>");
      const rdir = resolve5(dir);
      if (p.bools.has("list")) {
        const issues = listIssues(rdir);
        if (p.bools.has("json")) process.stdout.write(JSON.stringify(issues, null, 2) + "\n");
        else if (!issues.length) process.stdout.write("ultrasearch relink: nothing to repair \u2014 every source cites a page and reads as a document.\n");
        else for (const i of issues) process.stdout.write(`${i.id}  ${i.reason}  ${i.url}
    ${i.detail}
    \u2192 ${i.fix}
`);
        return;
      }
      if (!p.values.id && !p.values.url) {
        const { repaired, remaining } = autoRelink(rdir);
        if (p.bools.has("json")) {
          process.stdout.write(JSON.stringify({ repaired, remaining }, null, 2) + "\n");
          return;
        }
        for (const r2 of repaired) process.stderr.write(`ultrasearch: ${r2.id} now cites ${r2.to} (was ${r2.from})
`);
        if (!remaining.length) {
          process.stdout.write(`ultrasearch relink: repaired ${repaired.length} source(s); nothing left to fix.
`);
          return;
        }
        process.stdout.write(`ultrasearch relink: repaired ${repaired.length}, ${remaining.length} need you:
`);
        for (const i of remaining) process.stdout.write(`${i.id}  ${i.reason}  ${i.url}
    ${i.detail}
    \u2192 ${i.fix}
`);
        return;
      }
      const id = p.values.id;
      const url = p.values.url;
      if (!id) fail("missing --id <S#> (or pass --list)");
      if (!url) fail("missing --url <page>");
      const r = relink(rdir, id, url, { title: p.values.title });
      if (p.bools.has("json")) {
        process.stdout.write(JSON.stringify(r, null, 2) + "\n");
      } else if (r.relinked) {
        process.stderr.write(`ultrasearch: ${r.id} now cites ${r.to} (was ${r.from})
`);
      } else {
        process.stderr.write(`ultrasearch: ${r.note ?? "not relinked"}
`);
      }
      if (!r.relinked) process.exit(1);
      return;
    }
  }
}
function isInvokedDirectly() {
  const argv1 = process.argv[1];
  if (argv1 === void 0) return false;
  const modulePath = fileURLToPath2(import.meta.url);
  try {
    if (realpathSync3(argv1) === realpathSync3(modulePath)) return true;
  } catch {
  }
  return import.meta.url === pathToFileURL2(argv1).href;
}
if (isInvokedDirectly()) {
  main().catch((e) => fail(e.message));
}
export {
  ALL_SEARCH_PROFILES,
  ALL_WEB_ENGINES,
  BOOL_FLAGS,
  COMMANDS,
  HELP,
  NO_WRITE_REFUSED,
  VALUE_FLAGS,
  buildGatherOptions,
  gatherReport,
  main,
  parseArgs,
  parseShardArgs,
  readWebResultsPayload,
  resolveApplyPaths
};
