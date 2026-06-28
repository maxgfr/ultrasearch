#!/usr/bin/env node

// src/cli.ts
import { resolve } from "path";
import { pathToFileURL, fileURLToPath } from "url";
import { realpathSync, existsSync as existsSync5, statSync, readdirSync } from "fs";

// src/types.ts
var VERSION = "1.5.2";
var ALL_BACKENDS = [
  "searxng",
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

// src/gather.ts
import { join as join2 } from "path";
import { tmpdir } from "os";

// src/modes/topic.ts
var topicMode = {
  name: "topic",
  description: "General briefing on any subject (Wikipedia + general web).",
  backends: ["wikipedia", "searxng", "duckduckgo"],
  deepOnly: [],
  extras: [],
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
  backends: ["stackexchange", "github", "duckduckgo", "hackernews"],
  deepOnly: ["searxng"],
  extras: [],
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
  description: "Scholarly literature review (arXiv, Crossref, OpenAlex, Semantic Scholar) + refs.bib.",
  backends: ["arxiv", "openalex", "crossref", "semanticscholar", "europepmc"],
  deepOnly: ["pubmed", "duckduckgo", "wikipedia"],
  extras: ["bibtex"],
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
  deepOnly: [],
  extras: ["glossary", "exercises"],
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

// src/util.ts
function escapeRegExp(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
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
    const search = keep.length ? "?" + keep.map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`).join("&") : "";
    return `${proto}//${host}${port ? ":" + port : ""}${path}${search}`.replace(/\/$/, "");
  } catch {
    return raw.trim().replace(/#.*$/, "").replace(/\/$/, "");
  }
}
function normalizeDoi(doi) {
  return doi.trim().toLowerCase().replace(/^https?:\/\/(dx\.)?doi\.org\//, "");
}
function domainOf(raw) {
  try {
    return new URL(raw).hostname.toLowerCase().replace(/^www\./, "");
  } catch {
    return "";
  }
}
var BACKEND_TRUST = {
  arxiv: 0.9,
  crossref: 0.9,
  openalex: 0.9,
  semanticscholar: 0.9,
  europepmc: 0.9,
  pubmed: 0.9,
  wikipedia: 0.85,
  github: 0.8,
  stackexchange: 0.72,
  hackernews: 0.5
};
function domainTrust(domain) {
  if (!domain) return 0.5;
  if (/\.gov(\.[a-z]{2})?$/.test(domain) || /\.edu(\.[a-z]{2})?$/.test(domain)) return 0.95;
  if (/(^|\.)wikipedia\.org$/.test(domain)) return 0.85;
  if (/(^|\.)(arxiv\.org|nih\.gov|acm\.org|ieee\.org|nature\.com|sciencedirect\.com|springer\.com)$/.test(domain)) return 0.9;
  if (/(readthedocs\.io|docs\.|developer\.|\.dev$)/.test(domain)) return 0.78;
  if (/(^|\.)(github\.com|gitlab\.com|stackoverflow\.com|stackexchange\.com|mozilla\.org|w3\.org)$/.test(domain)) return 0.8;
  if (/(^|\.)(medium\.com|dev\.to|substack\.com|hashnode\.|blogspot\.|wordpress\.com)$/.test(domain)) return 0.55;
  if (/(^|\.)(pinterest\.|quora\.com|w3schools\.com|geeksforgeeks\.org|tutorialspoint\.com)$/.test(domain)) return 0.35;
  return 0.5;
}
function trustScore(url, backend) {
  const d = domainTrust(domainOf(url));
  const b = BACKEND_TRUST[backend] ?? 0;
  return Number(Math.max(d, b).toFixed(2));
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
function keywords(question) {
  const seen = /* @__PURE__ */ new Set();
  const out = [];
  for (const raw of question.split(/[^\p{L}\p{N}_]+/u)) {
    if (!raw) continue;
    const lower = raw.toLowerCase();
    if (raw.length < 2) continue;
    if (STOPWORDS.has(lower)) continue;
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
    if (lower.length < 3 || STOPWORDS.has(lower)) continue;
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
  return {
    expanded,
    canonicals: expanded.map((e) => e.canonical),
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
function identityKey(item) {
  const doi = item.meta?.doi;
  if (doi) return "doi:" + normalizeDoi(String(doi));
  const arxiv = item.meta?.arxivId;
  if (arxiv) return "arxiv:" + String(arxiv).toLowerCase().replace(/v\d+$/, "");
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
    if (STOPWORDS.has(raw.toLowerCase())) continue;
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
function recencyScore(meta, minYear, maxYear) {
  const y = typeof meta?.year === "number" ? meta.year : void 0;
  if (y === void 0 || maxYear <= minYear) return 0.5;
  const clamped = Math.min(maxYear, Math.max(minYear, y));
  return (clamped - minYear) / (maxYear - minYear);
}
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

// src/backends/pdf.ts
import { inflateSync, inflateRawSync } from "zlib";
function decodePdfString(tok) {
  if (!tok || tok[0] !== "(") return "";
  const inner = tok.slice(1, -1);
  const simple = { n: "\n", r: "\r", t: "	", b: "\b", f: "\f", "(": "(", ")": ")", "\\": "\\" };
  return inner.replace(/\\([nrtbf()\\])/g, (_m, c) => simple[c] ?? c).replace(/\\([0-7]{1,3})/g, (_m, o) => String.fromCharCode(parseInt(o, 8) & 255));
}
function decodeTJArray(tok) {
  let out = "";
  const re = /\((?:\\.|[^\\()])*\)|-?\d+(?:\.\d+)?/g;
  let m;
  while (m = re.exec(tok)) {
    const t = m[0];
    if (t[0] === "(") out += decodePdfString(t);
    else if (Number(t) <= -100) out += " ";
  }
  return out;
}
function extractTextOps(content) {
  let out = "";
  let lastString = "";
  let lastArray = "";
  const re = /\((?:\\.|[^\\()])*\)|\[(?:\\.|[^\]\\])*\]|\bT\*|\bTd\b|\bTD\b|\bTj\b|\bTJ\b|'|"/g;
  let m;
  while (m = re.exec(content)) {
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

// src/backends/fetch.ts
var BROWSER_UA = process.env.ULTRASEARCH_UA || "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";
var CONTACT_UA = "ultrasearch/1.x (+https://github.com/maxgfr/ultrasearch)";
var RETRY_STATUS = /* @__PURE__ */ new Set([429, 503, 502, 504]);
function envInt(name, def, min, max) {
  const v = Number(process.env[name]);
  return Number.isFinite(v) ? Math.min(max, Math.max(min, Math.floor(v))) : def;
}
var MAX_ATTEMPTS = envInt("ULTRASEARCH_MAX_ATTEMPTS", 2, 1, 5);
var DEFAULT_RETRY_MS = envInt("ULTRASEARCH_RETRY_MS", 600, 0, 5e3);
var PAGE_DELAY_MS = envInt("ULTRASEARCH_PAGE_DELAY_MS", 350, 0, 5e3);
function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}
function retryDelayMs(retryAfter) {
  if (retryAfter) {
    const secs = Number(retryAfter);
    if (Number.isFinite(secs)) return Math.min(Math.max(secs * 1e3, 0), 5e3);
  }
  return DEFAULT_RETRY_MS;
}
async function httpGet(url, opts = {}) {
  let last = { ok: false, status: 0, body: "", contentType: "", url };
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), opts.timeoutMs ?? 2e4);
    try {
      const headers = { "user-agent": opts.userAgent ?? BROWSER_UA, accept: opts.accept ?? "*/*" };
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
      if (RETRY_STATUS.has(res.status) && attempt < MAX_ATTEMPTS - 1) {
        last = result;
        await sleep(retryDelayMs(res.headers.get("retry-after")));
        continue;
      }
      return result;
    } catch (e) {
      last = { ok: false, status: 0, body: "", contentType: "", url, error: e.message };
      if (attempt < MAX_ATTEMPTS - 1) await sleep(DEFAULT_RETRY_MS);
    } finally {
      clearTimeout(t);
    }
  }
  return last;
}
async function httpJson(method, url, body, opts = {}) {
  let last = { ok: false, status: 0, data: void 0 };
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), opts.timeoutMs ?? 2e4);
    try {
      const headers = {
        "content-type": "application/json",
        accept: opts.accept ?? "application/json",
        "user-agent": opts.userAgent ?? BROWSER_UA
      };
      if (opts.acceptLanguage) headers["accept-language"] = opts.acceptLanguage;
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
      if (RETRY_STATUS.has(res.status) && attempt < MAX_ATTEMPTS - 1) {
        last = result;
        await sleep(retryDelayMs(res.headers.get("retry-after")));
        continue;
      }
      return result;
    } catch (e) {
      last = { ok: false, status: 0, data: void 0, error: e.message };
      if (attempt < MAX_ATTEMPTS - 1) await sleep(DEFAULT_RETRY_MS);
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
  "&copy;": "\xA9"
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
function extractMainHtml(html) {
  const visible = (h) => h.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim().length;
  const tiers = [
    /<main\b[^>]*>([\s\S]*?)<\/main>/gi,
    /<article\b[^>]*>([\s\S]*?)<\/article>/gi,
    /<(?:div|section)\b[^>]*\b(?:id|class)="[^"]*\b(?:content|article|post|entry|story|markdown-body|main|prose)\b[^"]*"[^>]*>([\s\S]*?)<\/(?:div|section)>/gi
  ];
  const candidates = [];
  for (const re of tiers) {
    let m;
    while (m = re.exec(html)) candidates.push(m[1]);
    if (candidates.length) break;
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
var PDF_FETCH_OPTS = { accept: "application/pdf,*/*", binary: true, maxBytes: 16 * 1024 * 1024 };
async function fetchAndExtract(url, opts = {}) {
  const wantsPdf = PDF_URL_RE.test(url);
  const res = await httpGet(url, wantsPdf ? PDF_FETCH_OPTS : { accept: "text/html,text/plain,*/*", acceptLanguage: opts.acceptLanguage });
  if (!res.ok) {
    const why = res.status === 429 ? "rate-limited (HTTP 429)" : `status ${res.status}${res.error ? ", " + res.error : ""}`;
    return { text: "", finalUrl: res.url, note: `Could not fetch ${url} (${why}).` };
  }
  if (wantsPdf || /application\/pdf/i.test(res.contentType)) {
    const bytes = res.bytes ?? (await httpGet(url, PDF_FETCH_OPTS)).bytes;
    const text2 = bytes ? pdfToText(bytes) : "";
    return {
      text: text2,
      finalUrl: res.url,
      note: text2 ? void 0 : `Fetched ${url} but could not extract text (scanned/encrypted PDF?).`
    };
  }
  const isHtml = /html/i.test(res.contentType) || /^\s*</.test(res.body);
  const text = isHtml ? htmlToText(extractMainHtml(res.body)) : res.body;
  const title = isHtml ? htmlTitle(res.body) : void 0;
  return { text, title, finalUrl: res.url };
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
  if (region && region.trim()) return region.trim().toLowerCase();
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

// src/backends/searxng.ts
function resolveSearxngBase(ctx) {
  const base = ctx.options.searxng || process.env.ULTRASEARCH_SEARXNG;
  return base ? base.replace(/\/$/, "") : null;
}
var searxngBackend = async (ctx) => {
  const base = resolveSearxngBase(ctx);
  if (!base) {
    return {
      backend: "searxng",
      items: [],
      notes: ["SearXNG not configured \u2014 set --searxng <url> or ULTRASEARCH_SEARXNG (run `docker-compose up` for a local instance). Skipping."]
    };
  }
  const pages = Math.max(1, ctx.options.pages ?? 1);
  const acceptLanguage = acceptLanguageHeader(ctx.options.lang, ctx.options.region);
  const perPage = ctx.options.perSource * 2;
  const base0 = `${base}/search?q=${encodeURIComponent(ctx.question)}&format=json&safesearch=1${ctx.options.lang ? `&language=${encodeURIComponent(ctx.options.lang)}` : ""}${ctx.options.since ? `&time_range=year` : ""}`;
  const seen = /* @__PURE__ */ new Set();
  const found = [];
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
    const results = Array.isArray(data?.results) ? data.results : [];
    const before = found.length;
    for (const x of results.slice(0, perPage)) {
      if (!x?.url || typeof x.url !== "string") continue;
      const key = canonicalizeUrl(x.url);
      if (seen.has(key)) continue;
      seen.add(key);
      found.push({ url: x.url, title: String(x.title ?? x.url), snippet: String(x.content ?? "").slice(0, 360) });
    }
    if (found.length === before) break;
    if (p < pages - 1 && PAGE_DELAY_MS) await sleep(PAGE_DELAY_MS);
  }
  const items = found.map((f, i) => ({
    url: f.url,
    title: f.title,
    backend: "searxng",
    score: found.length - i,
    snippet: f.snippet,
    lang: ctx.options.lang
  }));
  return {
    backend: "searxng",
    items,
    notes: items.length ? [`SearXNG returned ${items.length} result(s).`] : [`SearXNG returned no results.`]
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
    if (p < pages - 1 && PAGE_DELAY_MS) await sleep(PAGE_DELAY_MS);
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
    if (p < pages - 1 && PAGE_DELAY_MS) await sleep(PAGE_DELAY_MS);
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
    if (p < pages - 1 && PAGE_DELAY_MS) await sleep(PAGE_DELAY_MS);
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
      title: String(x.title ?? x.url),
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
  const items = [];
  const top = pages.slice(0, Math.min(limit, 6));
  for (let i = 0; i < top.length; i++) {
    const p = top[i];
    if (!p?.key) continue;
    const summaryUrl = `${host}/api/rest_v1/page/summary/${encodeURIComponent(p.key)}`;
    const dr = await httpJson("GET", summaryUrl, void 0, { timeoutMs: 1e4 });
    const extract = dr.ok ? decodeEntities(String(dr.data?.extract ?? "")) : "";
    const pageUrl = dr.data?.content_urls?.desktop?.page ?? `${host}/wiki/${encodeURIComponent(p.key)}`;
    const descExcerpt = decodeEntities(String(p.excerpt ?? "").replace(/<[^>]+>/g, ""));
    const text = extract || descExcerpt;
    if (!text) continue;
    items.push({
      url: pageUrl,
      title: decodeEntities(String(p.title ?? p.key)),
      backend: "wikipedia",
      score: top.length - i,
      snippet: (descExcerpt || extract).slice(0, 360),
      text,
      lang
    });
  }
  return {
    backend: "wikipedia",
    items,
    notes: items.length ? [`Wikipedia returned ${items.length} page(s).`] : [`Wikipedia returned no usable pages.`]
  };
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
    const discussion = `https://news.ycombinator.com/item?id=${h.objectID}`;
    const storyText = h.story_text ? htmlToText(String(h.story_text)) : "";
    return {
      url: h.url ? String(h.url) : discussion,
      title,
      backend: "hackernews",
      score: n - i,
      snippet: (storyText || title).slice(0, 360),
      text: `${title}

${storyText}
HN discussion: ${discussion}`,
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
    return {
      url: String(it.html_url),
      title: `${it.pull_request ? "PR" : "Issue"}: ${it.title}${repo ? ` (${repo})` : ""}`,
      backend: "github",
      score: n - i,
      snippet: (body || String(it.title)).slice(0, 360),
      text: `${it.title}
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
  const r = await httpGet(url, { accept: "application/atom+xml", timeoutMs: 12e3, userAgent: CONTACT_UA });
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
  const r = await httpJson("GET", url, void 0, { timeoutMs: 12e3, userAgent: CONTACT_UA });
  const items0 = r.ok && Array.isArray(r.data?.message?.items) ? r.data.message.items : [];
  if (!r.ok || !items0.length) {
    return { backend: "crossref", items: [], notes: [`Crossref search failed or empty (status ${r.status}).`] };
  }
  const items = items0.slice(0, n).map((w, i) => {
    const title = cleanInline(Array.isArray(w.title) ? w.title.join(" ") : String(w.title ?? "Untitled")) || "Untitled";
    const abstract = w.abstract ? htmlToText(String(w.abstract)) : "";
    const authors = Array.isArray(w.author) ? w.author.map((a) => [a.given, a.family].filter(Boolean).join(" ")).filter(Boolean) : [];
    const year = w.issued?.["date-parts"]?.[0]?.[0];
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
    const title = String(w.title ?? w.display_name ?? "Untitled");
    const abstract = fromInverted(w.abstract_inverted_index);
    const authors = Array.isArray(w.authorships) ? w.authorships.map((a) => a?.author?.display_name).filter(Boolean) : [];
    const year = w.publication_year || void 0;
    const venue = w.primary_location?.source?.display_name;
    const doi = typeof w.doi === "string" ? w.doi.replace(/^https?:\/\/doi\.org\//, "") : void 0;
    const url2 = w.primary_location?.landing_page_url ?? (doi ? `https://doi.org/${doi}` : w.id);
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
    const title = String(p.title ?? "Untitled");
    const abstract = String(p.abstract ?? "");
    const authors = Array.isArray(p.authors) ? p.authors.map((a) => a?.name).filter(Boolean) : [];
    const year = p.year || void 0;
    const doi = p.externalIds?.DOI;
    const arxivId = p.externalIds?.ArXiv;
    return {
      url: String(p.url ?? (doi ? `https://doi.org/${doi}` : "")),
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
    const link = doi ? `https://doi.org/${doi}` : `https://europepmc.org/article/${w.source}/${w.id}`;
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
    const title = String(d.title ?? "Untitled").replace(/\.$/, "");
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
      // no text → the gatherer hydrates the landing page for the abstract
      meta: { doi, authors, year, venue: d.source }
    };
  });
  return { backend: "pubmed", items, notes: [`PubMed returned ${items.length} record(s).`] };
};

// src/backends/registry.ts
var HANDLERS = {
  searxng: searxngBackend,
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
  pubmed: pubmedBackend
};
var SINGLE_QUERY = /* @__PURE__ */ new Set(["github", "stackexchange", "semanticscholar", "pubmed", "fixture", "generic"]);
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
      const perVariant = await Promise.all(variants.map((q) => handler({ ...ctx, question: q })));
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
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "fs";
import { join } from "path";
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
  return {
    id,
    url: rs.url,
    canonicalUrl: canonicalizeUrl(rs.url),
    title: rs.title || rs.url,
    backend: rs.backend,
    fetchedAt: builtAt,
    lang: rs.lang,
    domain: domainOf(rs.url),
    trust: trustScore(rs.url, rs.backend),
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
  const p = join(dir, s.extract);
  if (!existsSync(p)) return s.snippet ?? "";
  const lines = readFileSync(p, "utf8").split("\n");
  const hasHeader = lines.length >= 3 && lines[0].startsWith("# ") && lines[1].startsWith("- url:") && lines[2].startsWith("- backend:");
  const body = (hasHeader ? lines.slice(3) : lines).join("\n").trim();
  return body || s.snippet || "";
}
function writeDossier(dir, rawSources, manifest, template) {
  mkdirSync(join(dir, "sources"), { recursive: true });
  const sources = rawSources.map((rs, i) => {
    const id = `S${i + 1}`;
    const s = buildSource(rs, id, manifest.builtAt, manifest.question);
    writeFileSync(join(dir, s.extract), renderSourceExtract(s, rs.text ?? rs.snippet ?? "", manifest.depth));
    return s;
  });
  const m = { ...manifest, sourceCount: sources.length };
  const sourcesJson = join(dir, "sources.json");
  const dossierMd = join(dir, "DOSSIER.md");
  const manifestJson = join(dir, "manifest.json");
  writeFileSync(sourcesJson, JSON.stringify(sources, null, 2));
  writeFileSync(manifestJson, JSON.stringify(m, null, 2));
  writeFileSync(dossierMd, renderDossierMarkdown(sources, m, template));
  return { dir, sources, paths: { dir, sourcesJson, dossierMd, manifestJson } };
}
function renderDossierMarkdown(sources, manifest, template) {
  const out = [];
  out.push(`# Search dossier`);
  out.push("");
  out.push(`**Question:** ${manifest.question}`);
  out.push(
    `**Mode:** ${manifest.mode} \xB7 **depth:** ${manifest.depth} \xB7 **lang:** ${manifest.lang} \xB7 **sources:** ${sources.length} \xB7 **built:** ${manifest.builtAt}`
  );
  out.push(`**Backends used:** ${manifest.backendsUsed.join(", ") || "none"}`);
  out.push("");
  if (manifest.recallFloor) {
    out.push(
      `> \u26A0 **Thin dossier** \u2014 only ${manifest.recallFloor.count} on-topic source(s) were retrieved (recall floor ${manifest.recallFloor.floor}). Enrich the thin areas with your own WebSearch + \`fetch --url\` BEFORE writing, or the report will rest on too little evidence.`
    );
    out.push("");
  }
  out.push(
    `> Write three tiers from these sources: \`SUMMARY.md\` (TL;DR), \`REPORT.md\` (the full template below), and \`FULL.md\` (exhaustive \u2014 use every relevant source). Then run \`render\` and \`check\`. Do not answer from memory.`
  );
  out.push("");
  out.push(`## Grounding rules`);
  out.push("");
  out.push(CITATION_RULES);
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
  if (sources.length === 0) {
    out.push(`_No sources were retrieved. Broaden the query, add backends, or enrich with your own WebSearch via \`fetch --url\`._`);
  }
  for (const s of sources) {
    out.push(`### [${s.id}] ${s.title}`);
    const quality = s.fullText === false ? " \xB7 \u26A0 snippet only (page fetch failed)" : "";
    out.push(`url: ${s.url} \xB7 backend: ${s.backend} \xB7 trust: ${s.trust} \xB7 extract: \`${s.extract}\`${quality}`);
    out.push("");
    out.push(s.snippet);
    out.push("");
  }
  return out.join("\n");
}
function readDossier(dir) {
  const sources = JSON.parse(readFileSync(join(dir, "sources.json"), "utf8"));
  const manifest = JSON.parse(readFileSync(join(dir, "manifest.json"), "utf8"));
  return { sources, manifest };
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
  const scholarly = sources.filter((s) => s.meta && (s.meta.doi || s.meta.arxivId || s.meta.authors && s.meta.authors.length || s.meta.year));
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

// src/gather.ts
import { writeFileSync as writeFileSync2 } from "fs";
var OVERSHOOT = { summary: 5, standard: 10, deep: 20 };
var HYDRATE_CONCURRENCY = 6;
function headingLines(text) {
  return text.split("\n").filter((l) => /^#{1,6}\s/.test(l)).join("\n");
}
var ENRICH_NUDGE = "agent: enrich thin areas with your own WebSearch, then ingest each good URL via `ultrasearch fetch --url <u> --out <dir>` before writing the report.";
function defaultRunDir(mode, question, d) {
  return join2(tmpdir(), "ultrasearch", `${mode}-${slugify(question)}`, runId(d));
}
var DISCOVERY = ["searxng", "duckduckgo", "ddglite", "mojeek", "marginalia"];
var ENGINE_BACKEND = {
  searxng: "searxng",
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
  const tried = [];
  let enough = 0;
  for (const engine of engines) {
    const [r] = await runBackends([engine], ctx);
    if (!r) continue;
    out.push(r);
    tried.push(engine);
    if (r.items.length >= ctx.options.perSource) enough++;
    if (enough >= breadth) break;
  }
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
function resolveBackends(options, mode) {
  if (options.backends && options.backends.length) return [...new Set(options.backends)];
  const base = options.depth === "deep" ? [...mode.backends, ...mode.deepOnly] : [...mode.backends];
  return [...new Set(applyWebEngine(base, options.webEngine))];
}
function fuse(lists) {
  const fused = rrf(lists, identityKey);
  const best = /* @__PURE__ */ new Map();
  for (const list of lists) {
    for (const it of list) {
      const key = identityKey(it);
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
  const merged = [...best.values()];
  for (const it of merged) it.score = fused.get(identityKey(it)) ?? 0;
  merged.sort((a, b) => b.score - a.score || a.url.localeCompare(b.url));
  return merged;
}
function resolveVariants(options) {
  if (options.queries && options.queries.length) {
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
  const variants = resolveVariants(options);
  const effPages = Math.max(1, options.pages ?? PAGES_PER_DEPTH[options.depth] ?? 1);
  options.pages = effPages;
  const breadth = Math.max(1, options.webBreadth ?? WEB_BREADTH_PER_DEPTH[options.depth] ?? 1);
  const acceptLanguage = acceptLanguageHeader(options.lang, options.region);
  const ctx = { question: options.question, mode, options, variants };
  const explicit = !!(options.backends && options.backends.length);
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
  const excluded = (it) => {
    const d = domainOf(it.url);
    return !options.excludeDomains.some((ex) => d === ex || d.endsWith("." + ex));
  };
  const hydrateCache = /* @__PURE__ */ new Map();
  async function assemble(rawLists) {
    let merged2 = fuse(rawLists);
    const droppedDup = rawLists.reduce((n, l) => n + l.length, 0) - merged2.length;
    if (options.excludeDomains.length) merged2 = merged2.filter(excluded);
    const overshoot = OVERSHOOT[options.depth] ?? 10;
    const pool = merged2.slice(0, Math.min(merged2.length, options.maxSources + overshoot));
    const hydrateNotes = [];
    await mapLimit(pool, options.concurrency ?? HYDRATE_CONCURRENCY, async (it) => {
      if (it.text && it.text.trim()) {
        it.fullText = true;
        return;
      }
      const key = canonicalizeUrl(it.url);
      let res = hydrateCache.get(key);
      if (!res) {
        res = await fetchAndExtract(it.url, { acceptLanguage });
        hydrateCache.set(key, res);
      }
      if (res.finalUrl && res.finalUrl !== it.url) it.url = res.finalUrl;
      if (res.note) hydrateNotes.push(res.note);
      if (res.text && res.text.trim()) {
        it.text = res.text;
        it.fullText = true;
        if (!it.snippet) it.snippet = bestExcerpt(res.text, options.question);
        if ((!it.title || it.title === it.url) && res.title) it.title = res.title;
      } else {
        it.text = it.snippet || "";
        it.fullText = false;
      }
    });
    let withContent = pool.filter((it) => it.text && it.text.trim() || it.snippet.trim());
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
    withContent.forEach((it, i) => {
      const content = rawContent[i] / contentMax;
      const rrfN = it.score / rrfMax;
      const trust = trustScore(it.url, it.backend);
      const recency = recencyScore(it.meta, minYear, maxYear);
      it.score = Number((0.45 * rrfN + 0.35 * content + 0.15 * trust + 0.05 * recency).toFixed(6));
    });
    withContent.sort((a, b) => b.score - a.score || a.url.localeCompare(b.url));
    const near = dedupeNearDuplicates(withContent);
    return { merged: near.items.slice(0, options.maxSources), withContent, hydrateNotes, droppedDup, nearDropped: near.dropped, queryTerms: bm25.queryTerms };
  }
  const lists = results.map((r2) => [...r2.items].sort((a, b) => b.score - a.score));
  let r = await assemble(lists);
  let gapNote;
  if ((options.rounds ?? 1) >= 2 && webBackends.length > 0 && !explicit) {
    const top = r.withContent.slice(0, Math.min(10, r.withContent.length));
    const gaps = r.queryTerms.filter((term) => {
      let cov = 0;
      for (const it of top) if (bm25Tokenize(it.text || it.snippet || "").includes(term)) cov++;
      return cov < 2;
    });
    if (gaps.length) {
      const seenTerm = /* @__PURE__ */ new Set();
      const gapQuery = [...rankedKeywords(options.question).slice(0, 2), ...gaps].filter((t) => {
        const k = t.toLowerCase();
        return seenTerm.has(k) ? false : (seenTerm.add(k), true);
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
  const enginesFused = [...new Set(backendsUsed.filter((b) => DISCOVERY.includes(b)))];
  const timings = {};
  for (const res of results) if (res.ms !== void 0) timings[res.backend] = res.ms;
  timings.total = Date.now() - t0;
  const floor = Math.min(RECALL_FLOORS[options.depth], options.maxSources);
  const thin = merged.length < floor;
  const notes = [
    ...results.flatMap((res) => res.notes),
    ...r.hydrateNotes,
    ...r.droppedDup > 0 ? [`Dropped ${r.droppedDup} duplicate result(s) across backends.`] : [],
    ...r.nearDropped > 0 ? [`Collapsed ${r.nearDropped} near-duplicate (syndicated) page(s).`] : [],
    ...gapNote ? [gapNote] : [],
    ...thin ? [
      `Thin dossier: only ${merged.length} on-topic source(s) (recall floor ${floor}). Enrich the thin areas with your own WebSearch via \`fetch --url\` before writing.`
    ] : [],
    ENRICH_NUDGE
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
    sourceCount: merged.length,
    maxSources: options.maxSources,
    builtAt: (/* @__PURE__ */ new Date()).toISOString(),
    slug: `${options.mode}-${slugify(options.question)}`,
    tiers: ["SUMMARY.md", "REPORT.md", "FULL.md"],
    extras: mode.extras,
    notes,
    timings,
    ...thin ? { recallFloor: { count: merged.length, floor } } : {}
  };
  const dir = options.out ?? defaultRunDir(options.mode, options.question);
  const { sources } = writeDossier(dir, merged, manifest, mode.template);
  if (mode.extras.includes("bibtex")) {
    writeFileSync2(join2(dir, "refs.bib"), toBibtex(sources));
  }
  return { dir, sources, manifest: { ...manifest, sourceCount: sources.length } };
}

// src/enrich.ts
import { writeFileSync as writeFileSync3 } from "fs";
import { join as join3 } from "path";
async function addSource(dir, url, opts = {}) {
  const { sources, manifest } = readDossier(dir);
  const question = opts.question ?? manifest.question;
  const canon = canonicalizeUrl(url);
  const existing = sources.find((s2) => s2.canonicalUrl === canon);
  if (existing) {
    return { id: existing.id, added: false, note: `already in dossier as ${existing.id}` };
  }
  const { text, title, note } = await fetchAndExtract(url);
  if (!text || !text.trim()) {
    return { id: "", added: false, note: note ?? `no readable content at ${url}` };
  }
  const id = nextSourceId(sources);
  const backend = opts.backend ?? "claude";
  const raw = {
    url,
    title: opts.title || title || url,
    backend,
    score: 0,
    snippet: bestExcerpt(text, question),
    text
  };
  const s = buildSource(raw, id, (/* @__PURE__ */ new Date()).toISOString(), question);
  writeFileSync3(join3(dir, s.extract), renderSourceExtract(s, text, manifest.depth));
  const nextSources = [...sources, s];
  const backendsUsed = [.../* @__PURE__ */ new Set([...manifest.backendsUsed, backend])];
  const nextManifest = { ...manifest, sourceCount: nextSources.length, backendsUsed };
  writeFileSync3(join3(dir, "sources.json"), JSON.stringify(nextSources, null, 2));
  writeFileSync3(join3(dir, "manifest.json"), JSON.stringify(nextManifest, null, 2));
  writeFileSync3(join3(dir, "DOSSIER.md"), renderDossierMarkdown(nextSources, nextManifest, getMode(nextManifest.mode).template));
  return { id, added: true };
}

// src/render.ts
import { existsSync as existsSync2, readFileSync as readFileSync2, writeFileSync as writeFileSync4 } from "fs";
import { join as join4 } from "path";
var VERDICT_SEVERITY = { supported: 0, partial: 1, unsupported: 2, refuted: 3 };
var TIERS = [
  { id: "summary", label: "Summary", file: "SUMMARY.md" },
  { id: "report", label: "Report", file: "REPORT.md" },
  { id: "full", label: "Full", file: "FULL.md" },
  { id: "glossary", label: "Glossary", file: "glossary.md" }
];
function escapeHtml(s) {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}
function renderInline(escaped, verdicts) {
  let s = escaped;
  s = s.replace(/`([^`]+)`/g, (_m, c) => `<code>${c}</code>`);
  s = s.replace(/\[([^\]]+)\]\((https?:[^)\s]+)\)/g, (_m, t, u) => `<a href="${u}" rel="noopener" target="_blank">${t}</a>`);
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
      const header = splitRow(line);
      i += 2;
      while (i < lines.length && /\|/.test(lines[i]) && lines[i].trim() !== "") {
        rows.push(lines[i]);
        i++;
      }
      const thead = `<thead><tr>${header.map((c) => `<th>${inline(escapeHtml(c))}</th>`).join("")}</tr></thead>`;
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
@media(max-width:760px){.wrap{grid-template-columns:1fr}nav{position:static;max-height:none}}
`;
function readVerify(dir) {
  const p = join4(dir, "VERIFY.json");
  if (!existsSync2(p)) return void 0;
  try {
    return JSON.parse(readFileSync2(p, "utf8"));
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
  const present = TIERS.filter((t) => existsSync2(join4(dir, t.file)));
  const verify = readVerify(dir);
  const verdicts = worstBySource(verify);
  const rendered = present.map((t) => {
    const md = readFileSync2(join4(dir, t.file), "utf8");
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
  main2.push(sourcesSection(sources));
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
function sourcesSection(sources) {
  const items = sources.map((s) => {
    const meta = [
      s.backend,
      s.domain,
      `<span class="trust" title="trust score">trust ${s.trust}</span>`,
      ...s.fullText === false ? [`<span class="snippet-only" title="page fetch failed \u2014 snippet only">\u26A0 snippet only</span>`] : []
    ].join(" \xB7 ");
    return `<li id="src-${s.id}"><strong>[${s.id}]</strong> <a href="${escapeHtml(s.url)}" rel="noopener" target="_blank">${escapeHtml(s.title)}</a><br><span class="s-meta">${meta}</span></li>`;
  }).join("\n");
  return `<section id="sources"><h1>Sources</h1><ol class="sources">${items}</ol></section>`;
}
function writeHtml(dir, out) {
  const html = renderHtml(dir);
  const path = out ?? join4(dir, "index.html");
  writeFileSync4(path, html);
  return path;
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
  const present = TIERS.filter((t) => existsSync2(join4(dir, t.file)));
  const verify = readVerify(dir);
  const meta = `> ${manifest.mode} \xB7 depth ${manifest.depth} \xB7 ${sources.length} sources${manifest.lang ? ` \xB7 lang ${manifest.lang}` : ""}${manifest.region ? `/${manifest.region}` : ""} \xB7 ${manifest.builtAt} \xB7 generated by ultrasearch`;
  const parts = [`# ${manifest.question || "ultrasearch report"}`, "", meta, ""];
  for (const t of present) {
    const body = readFileSync2(join4(dir, t.file), "utf8").trim();
    if (!body) continue;
    parts.push("---", "", `## ${t.label}`, "", body, "");
  }
  if (verify) {
    parts.push("---", "", verificationMarkdown(verify));
  }
  parts.push("---", "", `## Sources`, "");
  if (sources.length) {
    for (const s of sources) {
      const flag = s.fullText === false ? " \xB7 \u26A0 snippet only" : "";
      parts.push(`- **[${s.id}]** [${mdLinkText(s.title)}](${s.url}) \u2014 ${s.backend} \xB7 ${s.domain} \xB7 trust ${s.trust}${flag}`);
    }
  } else {
    parts.push("_No sources in this dossier yet._");
  }
  parts.push("");
  return parts.join("\n");
}
function writeReportMarkdown(dir, out) {
  const md = buildReportMarkdown(dir);
  const path = out ?? join4(dir, "index.md");
  writeFileSync4(path, md);
  return path;
}

// src/check.ts
import { existsSync as existsSync3, readFileSync as readFileSync3 } from "fs";
import { join as join5 } from "path";
var HARD_FILES = ["REPORT.md", "FULL.md"];
var SOFT_FILES = ["SUMMARY.md", "glossary.md"];
var TOKEN_RE = /\[([^\]\n]+)\](?!\()/g;
var SOURCE_RE = /^S\d+$/;
var MIN_CLAIM_WORDS = 6;
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
function claimWordCount(unit) {
  const stripped = unit.replace(/\[[^\]\n]+\](?!\()/g, " ").replace(/\[([^\]]+)\]\([^)]*\)/g, "$1").replace(/[#>*`_~|]/g, " ");
  const words = stripped.split(/\s+/).filter((w) => /[\p{L}\p{N}]{2,}/u.test(w));
  return words.length;
}
function hasSourceToken(unit) {
  TOKEN_RE.lastIndex = 0;
  let m;
  while (m = TOKEN_RE.exec(unit)) if (SOURCE_RE.test(m[1].trim())) return true;
  return false;
}
function hasHintMarker(unit) {
  TOKEN_RE.lastIndex = 0;
  let m;
  while (m = TOKEN_RE.exec(unit)) if (m[1].trim() === "M") return true;
  return false;
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
      units.push({ kind: "text", text: tableCells(line) });
      i++;
      continue;
    }
    if (/^\s*>/.test(line)) {
      const dequoted = line.replace(/^\s*>\s?/, "").trim();
      if (dequoted) prose.push(dequoted);
      i++;
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
function unitsOfFile(text) {
  const lines = stripHtmlComments(text).split("\n");
  const code = codeMask(lines);
  const { mask: hint } = hintMask(lines);
  return extractUnits(lines, code, hint);
}
function unitSourceTokens(text) {
  const masked = stripInlineCode(text);
  const out = [];
  TOKEN_RE.lastIndex = 0;
  let m;
  while (m = TOKEN_RE.exec(masked)) {
    const tok = m[1].trim();
    if (SOURCE_RE.test(tok) && !out.includes(tok)) out.push(tok);
  }
  return out;
}
function analyzeFile(file, text) {
  const lines = text.replace(/<!--[\s\S]*?-->/g, (m) => m.replace(/[^\n]/g, " ")).split("\n");
  const code = codeMask(lines);
  const { mask: hint, regions } = hintMask(lines);
  const sourceTokens = [];
  const unknownTokens = [];
  let mMarkers = 0;
  for (let i = 0; i < lines.length; i++) {
    if (code[i]) continue;
    const masked = stripInlineCode(lines[i]);
    TOKEN_RE.lastIndex = 0;
    let m;
    while (m = TOKEN_RE.exec(masked)) {
      const tok = m[1].trim();
      if (SOURCE_RE.test(tok)) sourceTokens.push(tok);
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
  for (const u of extractUnits(lines, code, hint)) {
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
  return { file, sourceTokens, modelHints: mMarkers + regions, unknownTokens, unsourcedClaims };
}
function applySemantic(dir, result) {
  const p = join5(dir, "VERIFY.json");
  if (!existsSync3(p)) {
    result.warnings.push("--semantic: no VERIFY.json \u2014 run `verify` then `verify --apply <verdicts.json>` first; semantic gate skipped.");
    return;
  }
  try {
    const sem = JSON.parse(readFileSync3(p, "utf8"));
    result.semantic = sem;
    if (!sem.ok) {
      result.ok = false;
      result.errors.push(`Semantic verification failed: ${sem.failures.length} claim(s) refuted or unsupported by their cited source (see VERIFY.json).`);
    }
    if (sem.unadjudicated?.length) {
      result.warnings.push(`${sem.unadjudicated.length} claim(s) not fully adjudicated by verify.`);
    }
    if (sem.contradictions?.length) {
      result.warnings.push(
        `${sem.contradictions.length} claim(s) have contradicting cited sources: ${sem.contradictions.map((c) => c.claimId).join(", ")} (see VERIFY.json).`
      );
    }
  } catch (e) {
    result.warnings.push(`--semantic: VERIFY.json is unreadable (${e.message}).`);
  }
}
function readManifestSafe(dir) {
  try {
    return JSON.parse(readFileSync3(join5(dir, "manifest.json"), "utf8"));
  } catch {
    return void 0;
  }
}
function runCheck(dir, opts = {}) {
  const errors = [];
  const warnings = [];
  const sourcesPath = join5(dir, "sources.json");
  if (!existsSync3(sourcesPath)) {
    return blank(false, [`No sources.json in ${dir} \u2014 run \`ultrasearch gather\` first.`]);
  }
  let sources;
  try {
    sources = JSON.parse(readFileSync3(sourcesPath, "utf8"));
  } catch (e) {
    return blank(false, [`sources.json is unreadable: ${e.message}`]);
  }
  const ids = new Set(sources.map((s) => s.id));
  const present = [...HARD_FILES, ...SOFT_FILES].filter((f) => existsSync3(join5(dir, f)));
  if (!present.some((f) => HARD_FILES.includes(f))) {
    return blank(false, [`No REPORT.md or FULL.md in ${dir} \u2014 write the report tiers, then re-run check.`]);
  }
  const analyses = present.map((f) => analyzeFile(f, readFileSync3(join5(dir, f), "utf8")));
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
    for (const u of a.unknownTokens) unknown.add(u);
    if (HARD_FILES.includes(a.file)) {
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
      `${unmarkedUnsourced.length} unsourced claim(s) in REPORT/FULL with no [S#] and no model-hint flag. Cite a source or flag as [M] / > [model-hint].`
    );
  }
  if (unknown.size) {
    warnings.push(`${unknown.size} bracketed non-citation token(s) ignored: ${[...unknown].slice(0, 5).join(", ")}.`);
  }
  if (uncitedSources.length) {
    warnings.push(`${uncitedSources.length} source(s) were never cited (informational).`);
  }
  const manifest = readManifestSafe(dir);
  if (manifest?.recallFloor) {
    warnings.push(
      `Thin dossier: ${manifest.recallFloor.count} source(s) retrieved (recall floor ${manifest.recallFloor.floor}) \u2014 consider enriching with \`fetch --url\` before relying on it.`
    );
  }
  if (opts.minSources !== void 0 && sources.length < opts.minSources) {
    errors.push(
      `Only ${sources.length} source(s) in the dossier (--min-sources ${opts.minSources}). Enrich with \`fetch --url\` or broaden the gather before relying on this report.`
    );
  }
  const result = {
    ok: errors.length === 0,
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
  if (opts.semantic) applySemantic(dir, result);
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

// src/plan.ts
import { join as join6 } from "path";
var SKIP_HEADING = /^(tl;?dr|abstract\b|executive summary|sources\b|references\b|further reading|solutions\b)/i;
function mk(question, facet, rationale) {
  return { id: "", question, facet, queries: planVariants(question, "deep"), rationale };
}
function templateFacets(question, template) {
  const out = [];
  for (const line of template.split("\n")) {
    const m = /^##\s+(.+?)\s*$/.exec(line.trim());
    if (!m) continue;
    const heading = m[1].trim();
    if (SKIP_HEADING.test(heading)) continue;
    out.push(mk(`${question} \u2014 ${heading}`, "template", `mode facet: ${heading}`));
  }
  return out;
}
function runPlan(question, mode, override, cap = DEEP_CAPS.maxSubQuestions, runRoot) {
  const q = question.trim();
  let subs;
  if (override && override.length) {
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
  const uniq = [];
  const limit = Math.max(1, Math.floor(cap));
  for (const s of subs) {
    const key = s.question.toLowerCase();
    if (!s.question || seen.has(key)) continue;
    seen.add(key);
    uniq.push(s);
    if (uniq.length >= limit) break;
  }
  uniq.forEach((s, i) => {
    s.id = `Q${i + 1}`;
    if (runRoot) s.out = join6(runRoot, s.id.toLowerCase());
  });
  return { question: q, mode, subQuestions: uniq };
}

// src/merge.ts
import { writeFileSync as writeFileSync5 } from "fs";
import { join as join7 } from "path";
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
  const manifest = {
    version: VERSION,
    question,
    mode: modeName,
    depth: "deep",
    lang: dossiers[0].manifest.lang ?? "en",
    backends: [...new Set(dossiers.flatMap((d) => d.manifest.backends))],
    backendsUsed: [...new Set(dossiers.flatMap((d) => d.manifest.backendsUsed))],
    sourceCount: merged.length,
    maxSources: merged.length,
    builtAt,
    slug: `${modeName}-${slugify(question)}`,
    tiers: ["SUMMARY.md", "REPORT.md", "FULL.md"],
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
  if (mode.extras.includes("bibtex")) {
    writeFileSync5(join7(dir, "refs.bib"), toBibtex(sources));
  }
  return { dir, sources, manifest: { ...manifest, sourceCount: sources.length } };
}

// src/verify.ts
import { existsSync as existsSync4, readFileSync as readFileSync4, writeFileSync as writeFileSync6 } from "fs";
import { join as join8 } from "path";
var HARD_FILES2 = ["REPORT.md", "FULL.md"];
var VALID_VERDICTS = ["supported", "partial", "refuted", "unsupported"];
function claimStrings(text) {
  const out = [];
  for (const u of unitsOfFile(text)) {
    if (u.kind === "text") out.push(u.text);
    else for (const it of u.items) out.push(it);
  }
  return out;
}
function runVerify(dir, opts = {}) {
  const sources = JSON.parse(readFileSync4(join8(dir, "sources.json"), "utf8"));
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
  const pairs = [];
  let claimNo = 0;
  for (const file of HARD_FILES2) {
    const p = join8(dir, file);
    if (!existsSync4(p)) continue;
    const text = readFileSync4(p, "utf8");
    for (const claim of claimStrings(text)) {
      const ids = unitSourceTokens(claim).filter((id) => byId.has(id));
      if (!ids.length) continue;
      claimNo++;
      const claimId = `C${claimNo}`;
      for (const id of ids) {
        const s = byId.get(id);
        pairs.push({
          claimId,
          file,
          sourceId: id,
          claim: claim.trim().slice(0, 400),
          extractPath: s.extract,
          extractDigest: focusedSnippet(textOf(s), claim, { maxChars: 600, maxSentences: 4 }),
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
  const todo = {
    run: dir,
    pairs: worklist.pairs.map((p) => ({ ...p, verdict: null, note: "" }))
  };
  const todoName = shards !== void 0 ? `VERIFY.todo.${shard}.json` : "VERIFY.todo.json";
  const mdName = shards !== void 0 ? `VERIFY.${shard}.md` : "VERIFY.md";
  writeFileSync6(join8(dir, todoName), JSON.stringify(todo, null, 2));
  writeFileSync6(join8(dir, mdName), renderWorklistMd(worklist, pairs.length, shaped.length));
  return worklist;
}
function renderWorklistMd(wl, total, kept) {
  const out = [];
  out.push(`# Verification worklist`);
  out.push("");
  out.push(
    `For each pair below, open the cited extract and judge whether it **supports** the claim. In \`VERIFY.todo.json\`, set each \`verdict\` to one of supported \xB7 partial \xB7 refuted \xB7 unsupported, add a short \`note\`, save it (e.g. as \`verdicts.json\`), then run \`ultrasearch verify --apply verdicts.json --run <dir>\`.`
  );
  if (kept < total) out.push(`
_Showing ${kept} of ${total} pair(s) \u2014 capped at the highest-trust sources._`);
  out.push("");
  for (const p of wl.pairs) {
    out.push(`## ${p.claimId} \xB7 ${p.sourceId}`);
    out.push(`**Claim:** ${p.claim}`);
    out.push(`**Cited source (\`${p.extractPath}\`):** ${p.extractDigest}`);
    out.push(`**Verdict:** _____ \xB7 **Note:** _____`);
    out.push("");
  }
  return out.join("\n");
}
function parseVerdictFile(verdictsPath) {
  const raw = JSON.parse(readFileSync4(verdictsPath, "utf8"));
  const list = Array.isArray(raw) ? raw : Array.isArray(raw?.pairs) ? raw.pairs : [];
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
  writeFileSync6(join8(dir, "VERIFY.json"), JSON.stringify({ ...result, verdicts }, null, 2));
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

// src/cli.ts
var HELP = `ultrasearch v${VERSION}
Recap everything the web says about a topic \u2014 fan out keyless web search,
fetch + dedupe sources into a dossier, and write a citation-checked, tiered
report (with self-contained HTML). The web-facing sibling of ultradoc.

Usage:
  ultrasearch gather --q "<topic/question>" [--mode <m>] [--depth <d>] [options]
  ultrasearch search --backend <kind> --q "<query>" [options]
  ultrasearch fetch  --url <u> --out <dossier-dir> [--q "<question>"]
  ultrasearch render --run <dossier-dir>
  ultrasearch check  --run <dossier-dir> [--semantic] [--min-sources <n>]
  ultrasearch modes  [--json]
  ultrasearch plan   --q "<question>" [--mode <m>] [--subquestions "a|b|c"] [--run-root <dir>]
  ultrasearch merge  --runs "<dir1,dir2,\u2026>" --master <dir> [--q "<question>"]
  ultrasearch verify --run <dossier-dir> [--apply <files>] [--shards <n> --shard <i>]

Commands:
  gather   Fan out the mode's backends, fetch + dedupe, write the evidence
           dossier (sources.json, sources/S#.md, DOSSIER.md, manifest.json).
           You then write SUMMARY/REPORT/FULL.md, run render, then check.
  search   Drill ONE backend and print ranked results (writes nothing).
  fetch    Ingest a URL into an existing dossier (alias: add-source). Prints the
           new source id (S#). This is the bridge for your own WebSearch hits.
  render   Render the report tiers in a dossier to a self-contained index.html
           AND a consolidated index.md (both by default; --no-html / --no-md skip one).
  check    Validate citation grounding of SUMMARY/REPORT/FULL.md (--semantic
           also folds in the verify verdicts: fails on unsupported claims;
           --min-sources <n> fails a too-thin dossier).
  modes    List the report modes and their backend profiles.

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

Options:
  --q, --question <s>  The topic or question                      (required)
  --mode <m>           ${ALL_MODES.join(" | ")}   (default: topic)
  --depth <d>          ${ALL_DEPTHS.join(" | ")}            (default: standard)
  --backends <list>    Override the mode profile (comma-separated backend kinds)
  --backend <kind>     For 'search': the single backend to drill
  --queries <a|b|c>    Pipe-separated query variants to search with (overrides the
                       built-in planner \u2014 use to drive recall with your own phrasings)
  --max-sources <n>    Cap total sources kept            (default: per depth)
  --per-source <n>     Cap results per backend           (default: per depth)
  --lang <code>        Search language (translate --queries to it)  (default: en)
  --region <cc>        Region/country for locale-aware search   (default: from lang)
  --searxng <url>      SearXNG base URL                  (env ULTRASEARCH_SEARXNG)
  --web-engine <e>     auto | searxng | ddg | ddglite | mojeek | marginalia | claude
                       auto = resilient fallback cascade        (default: auto)
  --pages <n>          Result pages to fetch per web engine (\u22645; default: per depth)
  --web-breadth <n>    Web engines the auto cascade fuses   (\u22645; default: per depth)
  --url <u,...>        URLs for the 'generic' backend / 'fetch'
  --since <date>       Recency hint where a backend supports it
  --exclude-domains <list>  Drop these hosts from results
  --concurrency <n>    In-flight page-fetch concurrency      (default: 6)
  --rounds <n>         Retrieval rounds; 2 adds a gap-driven follow-up web
                       search for under-covered terms          (default: 1)
  --out <dir>          Dossier output dir   (default: /tmp/ultrasearch/<slug>/<id>)
  --run <dir>          For render/check: the dossier dir to operate on
  --json               Machine-readable output
  -h, --help           Show this help
  -v, --version        Show version

Grounding:
  'gather' writes the dossier; you write SUMMARY/REPORT/FULL.md citing sources
  like [S1], flagging your own knowledge as [M] or '> [model-hint]'. Then:
    ultrasearch render --run <dir>   # \u2192 index.html
    ultrasearch check  --run <dir>   # exit\u22600 if a claim is ungrounded
`;
var COMMANDS = /* @__PURE__ */ new Set(["gather", "search", "fetch", "add-source", "render", "check", "modes", "plan", "merge", "verify"]);
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
  "web-engine",
  "url",
  "since",
  "exclude-domains",
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
  "min-sources"
]);
var BOOL_FLAGS = /* @__PURE__ */ new Set(["json", "fresh", "no-html", "no-md", "verbose", "semantic"]);
function fail(message) {
  process.stderr.write(`ultrasearch: ${message}
`);
  process.exit(1);
}
function oneOf(name, value, allowed) {
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
  if (spec.includes(",")) return parseList(spec).map((x) => resolve(x));
  const abs = resolve(spec);
  if (existsSync5(abs) && statSync(abs).isDirectory()) {
    const files = readdirSync(abs).filter((f) => /verdict/i.test(f) && /\.json$/i.test(f)).sort().map((f) => resolve(abs, f));
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
function num(name, raw, fallback) {
  if (raw === void 0) return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) fail(`invalid --${name} "${raw}"`);
  return Math.floor(n);
}
function buildGatherOptions(p, opts = {}) {
  const question = p.values.q ?? p.values.question ?? "";
  if (opts.requireQuestion !== false && !question) fail('missing --q "<question>"');
  const mode = oneOf("mode", p.values.mode ?? "topic", ALL_MODES);
  const depth = oneOf("depth", p.values.depth ?? "standard", ALL_DEPTHS);
  const caps = DEPTH_CAPS[depth];
  const webEngine = oneOf("web-engine", p.values["web-engine"] ?? "auto", ["auto", "searxng", "ddg", "ddglite", "mojeek", "marginalia", "claude"]);
  return {
    question,
    mode,
    depth,
    backends: p.values.backends ? parseBackends(p.values.backends) : void 0,
    queries: p.values.queries ? p.values.queries.split("|").map((s) => s.trim()).filter(Boolean) : void 0,
    maxSources: num("max-sources", p.values["max-sources"], caps.maxSources),
    perSource: num("per-source", p.values["per-source"], caps.perSource),
    lang: p.values.lang ?? "en",
    region: p.values.region,
    searxng: p.values.searxng,
    webEngine,
    pages: p.values.pages ? Math.min(5, num("pages", p.values.pages, 1)) : void 0,
    webBreadth: p.values["web-breadth"] ? Math.min(5, num("web-breadth", p.values["web-breadth"], 1)) : void 0,
    urls: p.values.url ? parseList(p.values.url) : void 0,
    since: p.values.since,
    excludeDomains: p.values["exclude-domains"] ? parseList(p.values["exclude-domains"]) : [],
    concurrency: p.values.concurrency ? num("concurrency", p.values.concurrency, 6) : void 0,
    rounds: p.values.rounds ? num("rounds", p.values.rounds, 1) : void 0,
    out: p.values.out ? resolve(p.values.out) : void 0,
    json: p.bools.has("json"),
    fresh: p.bools.has("fresh")
  };
}
async function main() {
  const p = parseArgs(process.argv.slice(2));
  switch (p.command) {
    case "gather": {
      const options = buildGatherOptions(p);
      const r = await runGather(options);
      if (options.json) {
        process.stdout.write(JSON.stringify({ dir: r.dir, manifest: r.manifest }, null, 2) + "\n");
        return;
      }
      const used = r.manifest.backendsUsed.join(", ") || "none";
      const lines = [
        `ultrasearch: ${r.sources.length} source(s) for "${options.question}"`,
        `  mode:     ${options.mode} \xB7 depth: ${options.depth}`,
        `  backends: ${used}`,
        `  dossier:  ${r.dir}`,
        `  next:     read ${r.dir}/DOSSIER.md, write SUMMARY/REPORT/FULL.md (cite [S#]), then:`,
        `            ultrasearch render --run ${r.dir} && ultrasearch check --run ${r.dir}`
      ];
      process.stderr.write(lines.join("\n") + "\n");
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
    case "plan": {
      const options = buildGatherOptions(p);
      const override = p.values.subquestions ? p.values.subquestions.split("|").map((s) => s.trim()).filter(Boolean) : void 0;
      const cap = p.values["max-subquestions"] ? num("max-subquestions", p.values["max-subquestions"], 6) : void 0;
      const runRoot = p.values["run-root"] ? resolve(p.values["run-root"]) : void 0;
      const result = runPlan(options.question, options.mode, override, cap, runRoot);
      process.stdout.write(JSON.stringify(result, null, 2) + "\n");
      const rootHint = runRoot ? ` \u2014 each carries an \`out\` dir under ${runRoot} to gather into` : "";
      process.stderr.write(
        `ultrasearch: ${result.subQuestions.length} sub-question(s) for "${options.question}" (mode ${options.mode}) \u2014 fan out a gather per sub-question, then \`merge\`${rootHint}.
`
      );
      return;
    }
    case "merge": {
      const runs = p.values.runs ? parseList(p.values.runs).map((d) => resolve(d)) : [];
      if (!runs.length) fail('missing --runs "<dir1,dir2,\u2026>"');
      for (const d of runs) if (!existsSync5(d)) fail(`run dir not found: ${d}`);
      const mode = p.values.mode ? oneOf("mode", p.values.mode, ALL_MODES) : void 0;
      const result = runMerge({
        runs,
        master: p.values.master ? resolve(p.values.master) : void 0,
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
        `  next:     read ${result.dir}/DOSSIER.md, write SUMMARY/REPORT/FULL.md citing the MASTER [S#] ids, then:`,
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
      const r = await addSource(resolve(dir), url, {
        question: p.values.q ?? p.values.question,
        title: p.values.title
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
    case "render": {
      const dir = p.values.run ?? p.values.out;
      if (!dir) fail("missing --run <dossier-dir>");
      const rdir = resolve(dir);
      const written = {};
      if (!p.bools.has("no-html")) {
        written.html = writeHtml(rdir, p.values.out && p.values.run ? resolve(p.values.out) : void 0);
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
      const rdir = resolve(dir);
      if (p.values.apply) {
        const result = applyVerdicts(rdir, resolveApplyPaths(p.values.apply));
        if (p.bools.has("json")) process.stdout.write(JSON.stringify(result, null, 2) + "\n");
        else process.stdout.write(formatVerifyReport(result) + "\n");
        if (!result.ok) process.exit(1);
        return;
      }
      const maxVerify = p.values["max-verify"] ? num("max-verify", p.values["max-verify"], DEEP_CAPS.maxVerify) : void 0;
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
    case "check": {
      const dir = p.values.run ?? p.values.out;
      if (!dir) fail("missing --run <dossier-dir>");
      const minSources = p.values["min-sources"] ? num("min-sources", p.values["min-sources"], 1) : void 0;
      const res = runCheck(resolve(dir), { semantic: p.bools.has("semantic"), minSources });
      if (p.bools.has("json")) {
        process.stdout.write(JSON.stringify(res, null, 2) + "\n");
      } else {
        process.stdout.write(formatCheckReport(res, resolve(dir)) + "\n");
      }
      if (!res.ok) process.exit(1);
      return;
    }
  }
}
function isInvokedDirectly() {
  const argv1 = process.argv[1];
  if (argv1 === void 0) return false;
  const modulePath = fileURLToPath(import.meta.url);
  try {
    if (realpathSync(argv1) === realpathSync(modulePath)) return true;
  } catch {
  }
  return import.meta.url === pathToFileURL(argv1).href;
}
if (isInvokedDirectly()) {
  main().catch((e) => fail(e.message));
}
export {
  COMMANDS,
  buildGatherOptions,
  parseArgs,
  parseShardArgs,
  resolveApplyPaths
};
