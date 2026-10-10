#!/usr/bin/env node

// src/cli.ts
import { basename as basename5, join as join28, relative as relative3, resolve as resolve8 } from "path";
import { pathToFileURL as pathToFileURL2, fileURLToPath as fileURLToPath2 } from "url";
import { realpathSync as realpathSync4, existsSync as existsSync19, statSync as statSync11, readdirSync as readdirSync6, readFileSync as readFileSync20 } from "fs";

// src/types.ts
var VERSION = "1.40.0";
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
  "clinicaltrials",
  "dblp",
  "standards",
  "reddit",
  "pepper",
  "generic",
  "fixture",
  "claude"
];
var ALL_MODES = ["topic", "bug", "research", "clinical", "learn", "startup", "deals"];
var ALL_TEMPLATES = [...ALL_MODES, "verification"];
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
var ALL_BROWSER_MODES = ["fallback", "always", "off"];

// src/backends/websearch.ts
var URL_KEYS = ["url", "link", "href", "uri"];
var TITLE_KEYS = ["title", "name", "heading"];
var SNIPPET_KEYS = ["snippet", "description", "summary", "content", "text", "excerpt"];
var CITE_KEYS = ["citeUrl", "cite_url", "citeURL", "cite"];
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
  const citeUrl = firstString(o, CITE_KEYS);
  return {
    url,
    title: firstString(o, TITLE_KEYS),
    snippet: firstString(o, SNIPPET_KEYS),
    ...citeUrl ? { citeUrl } : {}
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
import { join as join12 } from "path";
import { tmpdir as tmpdir3 } from "os";

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
  deepOnly: ["searxng", "reddit"],
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

// src/modes/clinical.ts
var clinicalMode = {
  name: "clinical",
  description: "Clinical / biomedical evidence review \u2014 PubMed (E-utilities), Europe PMC, ClinicalTrials.gov, Crossref; no arXiv (+OpenAlex/Semantic Scholar/web guidelines at deep) + refs.bib.",
  backends: ["pubmed", "europepmc", "clinicaltrials", "crossref"],
  deepOnly: ["openalex", "semanticscholar", "duckduckgo"],
  extras: ["bibtex"],
  searchAngles: [
    "the condition + the intervention + 'randomized controlled trial'",
    "'systematic review' OR 'meta-analysis' + the condition and the intervention",
    "clinical practice guidelines and consensus statements (national agencies, learned societies) on the topic",
    "the MeSH terms for the condition and the intervention, as PubMed spells them",
    "cohort, registry or case-series outcomes + the topic",
    "adverse events, complications and safety signals of the intervention",
    "registered and ongoing trials (ClinicalTrials.gov, EU CTR) for the condition",
    "the comparator: standard of care, placebo or the alternative intervention",
    "long-term follow-up: survival, recurrence, revision or relapse",
    "cost-effectiveness and health-economic evaluations"
  ],
  template: [
    "## TL;DR (clinical bottom line)",
    "## Clinical question (PICO)",
    "## Evidence base (trials, systematic reviews, cohorts)",
    "## Efficacy outcomes",
    "## Safety & adverse events",
    "## Guidelines & recommendations",
    "## Certainty of evidence & limitations",
    "## Ongoing & registered trials",
    "## Gaps & open questions",
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
  deepOnly: ["wikipedia", "reddit"],
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

// src/modes/deals.ts
var dealsMode = {
  name: "deals",
  description: "Coupon & discount-code finder for a merchant \u2014 deal communities (Dealabs/hotukdeals/mydealz\u2026), Reddit, the web; codes extracted, ranked, marked UNVERIFIED (+codes.json).",
  backends: ["pepper", "reddit", "duckduckgo", "searxng"],
  deepOnly: [],
  extras: ["codes"],
  // Ordered by yield: `queries` keeps the first 2 / 4 / 8 by depth.
  searchAngles: [
    "the merchant + 'promo code' in the country's language + this month and year (e.g. 'code promo decathlon octobre 2026')",
    "site: the country's Pepper deal community (dealabs.com, hotukdeals.com, mydealz.de, chollometro.com, pepper.pl, nl.pepper.com) + the merchant",
    "the country's coupon aggregators + the merchant (RetailMeNot, Ma-Reduc, Radins, Picodi, Sparwelt, Groupon\u2026)",
    "site:reddit.com + the merchant + 'code', and the country's consumer forums",
    "the merchant's OWN offers: first-order / welcome discount, newsletter sign-up, app-only codes, loyalty programme",
    "influencer, podcast and YouTube sponsor codes for the merchant",
    "student, healthcare / key-worker, military and teacher discounts for the merchant",
    "cashback portals and card-linked offers for the merchant",
    "the merchant's referral (refer-a-friend) programme and discounted gift cards",
    "the merchant's sales calendar: seasonal sales, Black Friday, its own event days",
    "price matching, outlet, clearance and refurbished sections",
    "'<merchant> code not working' / 'expired' \u2014 what people report failing"
  ],
  template: [
    "## TL;DR",
    "## Candidate codes",
    "### Codes table (code \xB7 discount \xB7 conditions \xB7 expires \xB7 sources \xB7 confidence \xB7 tested)",
    "## Merchant's own offers",
    "## Other ways to save",
    "## Sales calendar",
    "## Expired, fake or unverifiable codes",
    "## Sources"
  ].join("\n")
};

// src/modes/registry.ts
var MODES = {
  topic: topicMode,
  bug: bugMode,
  research: researchMode,
  clinical: clinicalMode,
  learn: learnMode,
  startup: startupMode,
  deals: dealsMode
};
function getMode(name) {
  return MODES[name];
}
function listModes() {
  return Object.values(MODES);
}

// src/vendor/webindex-engine.mjs
import { inflateRawSync, inflateSync } from "zlib";
import { spawn, spawnSync } from "child_process";
import { readdirSync, readFileSync } from "fs";
import { spawn as spawn2 } from "child_process";
import { mkdtempSync, readFileSync as readFileSync2, rmSync, writeFileSync, existsSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { isAbsolute } from "path";
import { inflateRawSync as inflateRawSync2 } from "zlib";
import { spawn as spawn3, spawnSync as spawnSync2 } from "child_process";
import { mkdtempSync as mkdtempSync2, readdirSync as readdirSync2, readFileSync as readFileSync3, rmSync as rmSync2, writeFileSync as writeFileSync2 } from "fs";
import { tmpdir as tmpdir2 } from "os";
import { join as join2 } from "path";
import { existsSync as existsSync2, readFileSync as readFileSync4, writeFileSync as writeFileSync3 } from "fs";
import { join as join3 } from "path";
import { mkdirSync, renameSync, unlinkSync, writeFileSync as writeFileSync4 } from "fs";
import { existsSync as existsSync3, readdirSync as readdirSync3, readFileSync as readFileSync5, statSync } from "fs";
import { createHash, randomBytes } from "crypto";
import { EventEmitter } from "events";
import { accessSync, constants, statSync as statSync2 } from "fs";
import { homedir } from "os";
import { posix, win32 } from "path";
import { spawn as nodeSpawn } from "child_process";
import { mkdir, open, readFile, rename, rm, stat, writeFile } from "fs/promises";
import { existsSync as existsSync5, statSync as statSync3 } from "fs";
import { isAbsolute as isAbsolute2, join as join7 } from "path";
import { chmodSync, copyFileSync as copyFileSync2, existsSync as existsSync6, lstatSync, mkdirSync as mkdirSync3, readdirSync as readdirSync5, readFileSync as readFileSync7, realpathSync, rmSync as rmSync4, statSync as statSync4, writeFileSync as writeFileSync5 } from "fs";
import { homedir as homedir2 } from "os";
import { basename as basename2, join as join8, resolve as resolve2, sep } from "path";
import { randomUUID } from "crypto";
import { appendFileSync, closeSync, existsSync as existsSync7, openSync, readFileSync as readFileSync8, rmSync as rmSync5, statSync as statSync5, unlinkSync as unlinkSync2, writeSync } from "fs";
import { join as join9 } from "path";
import { join as join10 } from "path";
import { promisify } from "util";
import { gunzip } from "zlib";
import { spawnSync as spawnSync3 } from "child_process";
import { existsSync as existsSync10, lstatSync as lstatSync3, mkdirSync as mkdirSync6, readFileSync as readFileSync10, statSync as statSync8, writeFileSync as writeFileSync6 } from "fs";
import { dirname as dirname2, join as join14, resolve as resolve5 } from "path";
import { chmodSync as chmodSync2, existsSync as existsSync9, lstatSync as lstatSync2, mkdirSync as mkdirSync5, readFileSync as readFileSync9, readdirSync as readdirSync7, rmSync as rmSync7, statSync as statSync7 } from "fs";
import { dirname, join as join13 } from "path";
import { tmpdir as tmpdir5 } from "os";
import { readFileSync as readFileSync11 } from "fs";
import { existsSync as existsSync11 } from "fs";
import { join as join17, resolve as resolve6 } from "path";
import { join as join16 } from "path";
import { existsSync as existsSync12, readdirSync as readdirSync8, readFileSync as readFileSync12, realpathSync as realpathSync2, statSync as statSync9 } from "fs";
import { basename as basename4, dirname as dirname3, join as join18, relative, resolve as resolve7, sep as sep2 } from "path";
import { fileURLToPath } from "url";
import { createInterface } from "readline";
import { createHash as createHash4, timingSafeEqual } from "crypto";
var __defProp = Object.defineProperty;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __esm = (fn, res, err) => function __init() {
  if (err) throw err[0];
  try {
    return fn && (res = (0, fn[__getOwnPropNames(fn)[0]])(fn = 0)), res;
  } catch (e) {
    throw err = [e], e;
  }
};
var __export = (target, all) => {
  for (var name in all)
    __defProp(target, name, { get: all[name], enumerable: true });
};
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
var DEFAULT_BRAND;
var current;
var init_brand = __esm({
  "src/brand.ts"() {
    "use strict";
    DEFAULT_BRAND = {
      name: "webindex",
      envPrefix: "WEBINDEX",
      cli: "webindex",
      contactUrl: "https://github.com/maxgfr/webindex"
    };
    current = { ...DEFAULT_BRAND };
  }
});
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
var MAX_STREAM_BYTES;
var MAX_TOTAL_BYTES;
var DICT_WINDOW;
var WIN_ANSI_C1;
var winAnsi;
var ESCAPES;
var isWhite;
var isDelimiter;
var isHexDigit;
var isNumberChar;
var Lexer;
var TOO_BIG;
var NOT_TEXT_RE;
var init_native = __esm({
  "src/pdf/native.ts"() {
    "use strict";
    MAX_STREAM_BYTES = 32 * 1024 * 1024;
    MAX_TOTAL_BYTES = 128 * 1024 * 1024;
    DICT_WINDOW = 4096;
    WIN_ANSI_C1 = [
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
    winAnsi = (c) => {
      const code = c.charCodeAt(0);
      return code === 127 ? "\u2022" : String.fromCharCode(WIN_ANSI_C1[code - 128]);
    };
    ESCAPES = { n: "\n", r: "\r", t: "	", b: "\b", f: "\f", "(": "(", ")": ")", "\\": "\\" };
    isWhite = (c) => c === 32 || c === 10 || c === 13 || c === 9 || c === 12 || c === 0;
    isDelimiter = (c) => c === 40 || c === 41 || c === 60 || c === 62 || c === 91 || c === 93 || c === 123 || c === 125 || c === 47 || c === 37;
    isHexDigit = (c) => c >= 48 && c <= 57 || c >= 65 && c <= 70 || c >= 97 && c <= 102;
    isNumberChar = (c) => c >= 48 && c <= 57 || c === 45 || c === 43 || c === 46;
    Lexer = class {
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
    TOO_BIG = /* @__PURE__ */ Symbol("too big");
    NOT_TEXT_RE = /\/Subtype\s*\/Image\b|\/Length[123]\b/;
  }
});
function isControlCode(c) {
  if (c >= 9 && c <= 13) return false;
  return c < 32 || c >= 127 && c <= 159;
}
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
var MIN_CHARS_FOR_SHAPE_CHECKS;
var CONTROL_RATIO_MAX;
var REPLACEMENT_RATIO_MAX;
var LONGEST_RUN_MAX;
var LETTER_RATIO_MIN;
var REPLACEMENT_CODE;
var SPACE_RE;
var isSpace;
var LETTER_RE;
var isRuleChar;
var NO_TEXT_LAYER;
var init_quality = __esm({
  "src/pdf/quality.ts"() {
    "use strict";
    MIN_CHARS_FOR_SHAPE_CHECKS = 200;
    CONTROL_RATIO_MAX = 5e-3;
    REPLACEMENT_RATIO_MAX = 5e-3;
    LONGEST_RUN_MAX = 300;
    LETTER_RATIO_MIN = 0.5;
    REPLACEMENT_CODE = 65533;
    SPACE_RE = /\s/;
    isSpace = (c) => c < 128 ? c === 32 || c >= 9 && c <= 13 : SPACE_RE.test(String.fromCharCode(c));
    LETTER_RE = /[\p{L}\p{N}]/u;
    isRuleChar = (c) => c === 95 || c === 45 || c === 46 || c === 61;
    NO_TEXT_LAYER = "no text layer (scanned or image-only PDF?)";
  }
});
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
    let stat2;
    try {
      stat2 = readFileSync(`/proc/${entry}/stat`, "latin1");
    } catch {
      continue;
    }
    const ppid = Number(stat2.slice(stat2.lastIndexOf(")") + 2).split(" ")[1]);
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
  const queue2 = [pid];
  while (queue2.length) {
    for (const child of tree.get(queue2.shift()) ?? []) {
      if (found.has(child) || child === pid) continue;
      found.add(child);
      queue2.push(child);
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
var init_process_tree = __esm({
  "src/process-tree.ts"() {
    "use strict";
  }
});
function binaryName(name) {
  return process.platform === "win32" && name === "npx" ? "npx.cmd" : name;
}
function runWithInput(cmd, args, input, timeoutMs, opts = {}) {
  return new Promise((resolve82) => {
    let child;
    try {
      const bin = binaryName(cmd);
      const viaShell = process.platform === "win32" && /\.(?:cmd|bat)$/i.test(bin);
      const quote = (s) => `"${s.replace(/"/g, '""')}"`;
      const common = { stdio: ["pipe", "pipe", "pipe"], ...opts.env ? { env: opts.env } : {} };
      child = viaShell ? spawn2([bin, ...args].map(quote).join(" "), { ...common, shell: true, windowsHide: true }) : spawn2(bin, args, common);
    } catch (e) {
      resolve82({ ok: false, stdout: "", error: e.message });
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
      resolve82(r);
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
var PDF_INSPECTOR_SPEC;
var ANYDOC_SPEC;
var MAX_STDOUT_BYTES;
var STDERR_END_CHARS;
var init_exec = __esm({
  "src/pdf/exec.ts"() {
    "use strict";
    init_process_tree();
    PDF_INSPECTOR_SPEC = "@firecrawl/pdf-inspector@1";
    ANYDOC_SPEC = "@firecrawl/anydoc@0.1";
    MAX_STDOUT_BYTES = 24 * 1024 * 1024;
    STDERR_END_CHARS = 1024;
  }
});
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
var DEFAULT_TIMEOUT_MS;
var DEFAULT_MAX_DOCS;
var DEFAULT_LANG;
var spent;
var toolsProbe;
var init_ocr = __esm({
  "src/pdf/ocr.ts"() {
    "use strict";
    init_brand();
    init_exec();
    DEFAULT_TIMEOUT_MS = 3e5;
    DEFAULT_MAX_DOCS = 3;
    DEFAULT_LANG = "eng";
    spent = 0;
  }
});
function npxTimeoutMs() {
  return envInt("NPX_TIMEOUT_MS", 9e4, 1e3, 6e5);
}
function npxEnv() {
  const env2 = { ...process.env };
  for (const [key, value] of Object.entries(FAIL_FAST)) {
    if (env2[key] === void 0 && env2[key.toUpperCase()] === void 0) env2[key] = value;
  }
  return env2;
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
var FAIL_FAST;
var NPM_ERROR_RE;
var NETWORK_CODES;
var proven;
var registryDown;
var installed;
var NOISE_RE;
var THROW_SITE_RE;
var ERROR_LINE_RE;
var PATH_RE;
var init_npx = __esm({
  "src/pdf/npx.ts"() {
    "use strict";
    init_brand();
    init_exec();
    FAIL_FAST = {
      npm_config_fetch_retries: "1",
      npm_config_fetch_retry_mintimeout: "1000",
      npm_config_fetch_retry_maxtimeout: "2000",
      npm_config_fetch_timeout: "30000"
    };
    NPM_ERROR_RE = /^npm (?:ERR!|error) code (\S+)/m;
    NETWORK_CODES = /* @__PURE__ */ new Set([
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
    proven = /* @__PURE__ */ new Set();
    installed = /* @__PURE__ */ new Map();
    NOISE_RE = /^(?:npm (?:warn|WARN|notice)\b|\(node:\d+\)|\(Use `node --|\^+$|at\s|Node\.js v\d)/;
    THROW_SITE_RE = /^(?:file:\/\/|\/|[A-Za-z]:\\)\S*:\d+$/;
    ERROR_LINE_RE = /^\w*error\b/i;
    PATH_RE = /(?<![\w:/.\\])(?:file:\/\/\/?(?:[A-Za-z]:)?|[A-Za-z]:(?=\\))?(?:[/\\][^\s/\\:'"()]+)+/g;
  }
});
function enginesFromEnv(name, known) {
  const raw = env(name)?.trim();
  if (!raw) return void 0;
  const asked = raw.toLowerCase().split(",").map((s) => s.trim()).filter(Boolean);
  if (asked.length === 1 && asked[0] === "none") return [];
  const picked = [...new Set(asked.filter((s) => known.includes(s)))];
  const unknown = asked.filter((s) => !known.includes(s));
  if (unknown.length && !warnedEngineValues.has(`${name}=${raw}`)) {
    warnedEngineValues.add(`${name}=${raw}`);
    const fallback2 = picked.length ? "" : " \u2014 using the full ladder";
    process.emitWarning(`${envName(name)}: ignoring unknown rung ${unknown.map((u) => `"${u}"`).join(", ")} (known: ${known.join(", ")}, or none)${fallback2}`);
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
var PDF_EXTRACTORS;
var PDFTOTEXT_TIMEOUT_MS;
var dead;
var warnedEngineValues;
var init_ladder = __esm({
  "src/pdf/ladder.ts"() {
    "use strict";
    init_brand();
    init_exec();
    init_npx();
    init_quality();
    init_native();
    init_ocr();
    PDF_EXTRACTORS = ["pdf-inspector", "anydoc", "firecrawl", "pdftotext", "native", "ocr"];
    PDFTOTEXT_TIMEOUT_MS = 6e4;
    dead = /* @__PURE__ */ new Map();
    warnedEngineValues = /* @__PURE__ */ new Set();
  }
});
var init_pdf = __esm({
  "src/pdf.ts"() {
    "use strict";
    init_native();
    init_quality();
    init_ocr();
    init_ladder();
  }
});
function docFormatForUrl(url) {
  const m = /\.([a-z0-9]{2,5})(?:$|[?#])/i.exec(url);
  return m ? BY_EXTENSION[m[1].toLowerCase()] : void 0;
}
function docFormatForContentType(contentType) {
  const type = contentType.split(";")[0]?.trim().toLowerCase();
  return type ? BY_CONTENT_TYPE[type] : void 0;
}
function sniffDocument(bytes) {
  const head = bytes.subarray(0, 1024).toString("latin1");
  if (PDF_HEADER_RE.test(head)) return "pdf";
  if (bytes.subarray(0, 8).equals(OLE_SIGNATURE)) return BINARY;
  if (head.startsWith("{\\rtf")) return BINARY;
  if (head.startsWith("PK") && (head.startsWith("mimetype", 30) || bytes.includes("[Content_Types].xml"))) return BINARY;
  return void 0;
}
var BINARY;
var CSV;
var BY_EXTENSION;
var BY_CONTENT_TYPE;
var DOC_EXTENSIONS;
var PDF_HEADER_RE;
var OLE_SIGNATURE;
var init_formats = __esm({
  "src/doc/formats.ts"() {
    "use strict";
    BINARY = { textFallback: false };
    CSV = { format: "csv", textFallback: true };
    BY_EXTENSION = {
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
    BY_CONTENT_TYPE = {
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
    DOC_EXTENSIONS = Object.keys(BY_EXTENSION);
    PDF_HEADER_RE = /(?:^|[\r\n])%PDF-\d/;
    OLE_SIGNATURE = Buffer.from([208, 207, 17, 224, 161, 177, 26, 225]);
  }
});
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
function decodeXml(s) {
  if (!s.includes("&")) return s;
  return s.replace(/&(?:#x([0-9a-fA-F]{1,6})|#([0-9]{1,7})|([a-zA-Z]{2,4}));/g, (m, hex, dec, name) => {
    if (name) return ENTITIES[name] ?? m;
    const cp = hex ? parseInt(hex, 16) : Number(dec);
    return cp > 0 && cp <= 1114111 ? String.fromCodePoint(cp) : m;
  });
}
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
function blankRow(row, width) {
  for (let c = 0; c < row.length && c < width; c++) if (row[c]?.trim()) return false;
  return true;
}
function keepRow(table, row) {
  const blank2 = blankRow(row, row.length);
  if (!blank2 || !table.blank) table.rows.push(row);
  table.blank = blank2;
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
  let blank2 = false;
  for (let r = 1; r < last; r++) {
    const row = rows[r];
    const empty = blankRow(row, width);
    if (empty && blank2) continue;
    blank2 = empty;
    if (!budget.takeRules(rules)) break;
    out.push(line(row));
  }
  return out.join("\n");
}
function joinBlocks(blocks2) {
  const out = [];
  for (const [i, block] of blocks2.entries()) {
    if (i) out.push(block.startsWith("- ") && blocks2[i - 1].startsWith("- ") ? "\n" : "\n\n");
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
  const blocks2 = [];
  const paragraphs = [];
  const tables = [];
  let inText = 0;
  let fallback2 = 0;
  let tabStops = 0;
  let moved = 0;
  const add2 = (p, s) => {
    if (p && !moved && budget.take(s.length)) p.text += s;
  };
  const emit = (block) => {
    const table = tables[tables.length - 1];
    if (table?.cell) table.cell.push(block);
    else if (block.trim()) blocks2.push(block);
  };
  walkXml(xml, {
    open(name, attrs) {
      const n = local(name);
      if (n === "Fallback") fallback2++;
      else if (n === "tabs") tabStops++;
      if (fallback2) return;
      const p = paragraphs[paragraphs.length - 1];
      const table = tables[tables.length - 1];
      if (n === "moveFrom") moved++;
      else if (n === "p") paragraphs.push({ text: "", prefix: "" });
      else if (n === "t") inText++;
      else if (n === "tab" && !tabStops) add2(p, "	");
      else if (n === "br" || n === "cr") add2(p, "\n");
      else if (n === "noBreakHyphen") add2(p, "-");
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
        fallback2 = Math.max(0, fallback2 - 1);
        return;
      }
      if (n === "tabs") tabStops = Math.max(0, tabStops - 1);
      if (fallback2) return;
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
      if (!fallback2 && inText) add2(paragraphs[paragraphs.length - 1], s);
    }
  });
  return joinBlocks(blocks2);
}
function sharedStrings(xml) {
  const strings2 = [];
  if (!xml) return strings2;
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
        strings2.push(current2);
        current2 = void 0;
      } else if (n === "t") inText = Math.max(0, inText - 1);
      else if (n === "rPh") phonetic = Math.max(0, phonetic - 1);
    },
    text(s) {
      if (current2 !== void 0 && inText && !phonetic) current2 += s;
    }
  });
  return strings2;
}
function columnOf(ref) {
  const letters = ref && /^[A-Za-z]{1,3}/.exec(ref)?.[0];
  if (!letters) return void 0;
  let col = 0;
  for (const ch of letters.toUpperCase()) col = col * 26 + (ch.charCodeAt(0) - 64);
  return col - 1;
}
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
function serialDate(serial, kind, date1904) {
  const days = date1904 ? serial + 1462 : serial < 60 ? serial + 1 : serial;
  if (!(serial >= 0 && days <= 2958466)) return void 0;
  const iso2 = new Date(Math.round((EXCEL_EPOCH + days * DAY_MS) / 1e3) * 1e3).toISOString();
  const time = iso2.slice(11, iso2.endsWith(":00.000Z") ? 16 : 19);
  return kind === "date" ? iso2.slice(0, 10) : kind === "time" ? time : `${iso2.slice(0, 10)} ${time}`;
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
  const blocks2 = [];
  for (const sheet of sheets) {
    if (budget.spent) break;
    const part = rels.get(sheet.id)?.target;
    const xml = part ? zip.text(part) : void 0;
    const table = xml ? markdownTable(sheetRows(xml, shared, styles, budget), budget) : "";
    if (table) blocks2.push(`## ${sheet.name}

${table}`);
  }
  return blocks2.join("\n\n");
}
function drawingText(xml, budget, onlyBody = false) {
  const lines = [];
  const titles = [];
  const shapes = [];
  const tables = [];
  let para;
  let inText = 0;
  let fallback2 = 0;
  const add2 = (s) => {
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
      if (n === "Fallback") fallback2++;
      if (fallback2) return;
      const table = tables[tables.length - 1];
      if (n === "sp") shapes.push({ kind: "other", lines: [] });
      else if (n === "ph" && shapes.length) {
        const type = attr(attrs, "type");
        shapes[shapes.length - 1].kind = type === "title" || type === "ctrTitle" ? "title" : type === "body" ? "body" : "other";
      } else if (n === "p" && name.startsWith("a:")) para = "";
      else if (n === "t") inText++;
      else if (n === "br") add2("\n");
      else if (name === "a:tbl") tables.push({ rows: [] });
      else if (name === "a:tr" && table) table.row = [];
      else if (name === "a:tc" && table?.row) table.cell = [];
    },
    close(name) {
      const n = local(name);
      if (n === "Fallback") {
        fallback2 = Math.max(0, fallback2 - 1);
        return;
      }
      if (fallback2) return;
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
      if (!fallback2 && inText) add2(s);
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
  const blocks2 = [];
  for (const [i, part] of order.entries()) {
    if (budget.spent) break;
    const slide = drawingText(zip.text(part) ?? "", budget);
    const notesPart = relatedPart(relationships(zip, part), "notesSlide");
    const notes = notesPart ? drawingText(zip.text(notesPart) ?? "", budget, true).text : "";
    const heading = `## Slide ${i + 1}${slide.title ? `: ${slide.title}` : ""}`;
    if (slide.title || slide.text || notes) blocks2.push(`${heading}${slide.text ? `

${slide.text}` : ""}${notes ? `

Notes: ${notes}` : ""}`);
  }
  return blocks2.join("\n\n");
}
function openDocumentText(xml, budget) {
  const blocks2 = [];
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
  const add2 = (p, s) => {
    if (p && budget.take(s.length)) p.text += s;
  };
  const emit = (block) => {
    const table = tables[tables.length - 1];
    if (table?.cell) table.cell.push(block);
    else if (titleFrame) title.push(block);
    else if (inNotes) notes.push(block);
    else if (block.trim()) blocks2.push(block);
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
      else if (name === "text:s") add2(p, " ".repeat(Math.min(100, Number(attr(attrs, "text:c")) || 1)));
      else if (name === "text:tab") add2(p, "	");
      else if (name === "text:line-break") add2(p, "\n");
      else if (name === "office:spreadsheet") spreadsheet = true;
      else if (name === "draw:page") {
        heading = blocks2.push(`## Slide ${++slide}`) - 1;
        title.length = 0;
        notes.length = 0;
      } else if (name === "presentation:notes") inNotes++;
      else if (name === "draw:frame" && (titleFrame || attr(attrs, "presentation:class") === "title")) titleFrame++;
      else if (name === "table:table") {
        const sheet = attr(attrs, "table:name");
        const heading2 = sheet && spreadsheet && !tables.length ? blocks2.push(`## ${sheet}`) - 1 : void 0;
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
        if (done?.heading !== void 0 && blocks2.length === done.heading + 1) blocks2.length = done.heading;
      } else if (name === "draw:frame" && titleFrame) titleFrame--;
      else if (name === "presentation:notes") inNotes = Math.max(0, inNotes - 1);
      else if (name === "draw:page" && heading >= 0) {
        if (title.length) blocks2[heading] = `## Slide ${slide}: ${title.join(" ")}`;
        if (notes.length) blocks2.push(`Notes: ${notes.join(" ")}`);
        if (!title.length && !notes.length && blocks2.length === heading + 1) blocks2.length = heading;
        heading = -1;
      }
    },
    text(s) {
      if (!skip) add2(paragraphs[paragraphs.length - 1], s.replace(/[ \t\r\n]+/g, " "));
    }
  });
  return joinBlocks(blocks2);
}
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
  const main2 = mainPart(zip);
  const xml = main2 ? zip.text(main2) : void 0;
  if (!main2 || xml === void 0) throw new Refused("not an OOXML or OpenDocument file");
  if (main2.startsWith("word/")) {
    const stylesPart = relatedPart(relationships(zip, main2), "styles");
    return wordText(xml, budget, wordStyles(stylesPart ? zip.text(stylesPart) : void 0));
  }
  if (main2.startsWith("xl/")) return spreadsheetText(zip, main2, budget);
  if (main2.startsWith("ppt/")) return presentationText(zip, main2, budget);
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
var MAX_ENTRIES;
var MAX_ENTRY_BYTES;
var MAX_TOTAL_BYTES2;
var MAX_OUTPUT_CHARS;
var MAX_COLUMNS;
var MAX_REPEAT;
var Refused;
var Zip;
var Budget;
var ENTITIES;
var local;
var attrPatterns;
var cell;
var HEADING_STYLE_RE;
var TITLE_STYLE_RE;
var LIST_STYLE_RE;
var BUILTIN_TEMPORAL;
var DAY_MS;
var EXCEL_EPOCH;
var ODF_ASIDES;
var OLE_SIGNATURE2;
var init_office = __esm({
  "src/doc/office.ts"() {
    "use strict";
    MAX_ENTRIES = 1e4;
    MAX_ENTRY_BYTES = 64 * 1024 * 1024;
    MAX_TOTAL_BYTES2 = 256 * 1024 * 1024;
    MAX_OUTPUT_CHARS = 24 * 1024 * 1024;
    MAX_COLUMNS = 256;
    MAX_REPEAT = 1e3;
    Refused = class extends Error {
    };
    Zip = class {
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
    Budget = class {
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
    ENTITIES = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'" };
    local = (name) => name.slice(name.indexOf(":") + 1);
    attrPatterns = /* @__PURE__ */ new Map();
    cell = (s) => s.replace(/\s+/g, " ").trim().replace(/\|/g, "\\|");
    HEADING_STYLE_RE = /^(?:heading|titre|berschrift|überschrift|kop|titolo|encabezado|ttulo|título)\s?([1-6])$/i;
    TITLE_STYLE_RE = /^(?:title|titel|titre|titolo|ttulo|título)$/i;
    LIST_STYLE_RE = /^list ?(?:bullet|number)/i;
    BUILTIN_TEMPORAL = {
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
    DAY_MS = 864e5;
    EXCEL_EPOCH = Date.UTC(1899, 11, 30);
    ODF_ASIDES = /* @__PURE__ */ new Set(["text:note", "office:annotation", "text:tracked-changes"]);
    OLE_SIGNATURE2 = Buffer.from([208, 207, 17, 224, 161, 177, 26, 225]);
  }
});
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
var DOC_EXTRACTORS;
var dead2;
var init_ladder2 = __esm({
  "src/doc/ladder.ts"() {
    "use strict";
    init_brand();
    init_exec();
    init_ladder();
    init_npx();
    init_quality();
    init_office();
    DOC_EXTRACTORS = ["anydoc", "firecrawl", "builtin"];
    dead2 = /* @__PURE__ */ new Map();
  }
});
var init_doc = __esm({
  "src/doc.ts"() {
    "use strict";
    init_formats();
    init_ladder2();
    init_office();
  }
});
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
var TRACKING_PARAMS;
var SHARE_SI_HOSTS;
var LOCAL_FILE_DOMAIN;
var FNV_OFFSET_HI;
var FNV_OFFSET_LO;
var FNV_PRIME_LOW;
var laneHi;
var laneLo;
var init_url = __esm({
  "src/url.ts"() {
    "use strict";
    TRACKING_PARAMS = /^(utm_|fbclid$|gclid$|gclsrc$|dclid$|msclkid$|yclid$|twclid$|ttclid$|li_fat_id$|mkt_tok$|_gl$|mc_|ref_src$|ref_url$|spm$|_hsenc$|_hsmi$|igshid$|igsh$)/i;
    SHARE_SI_HOSTS = /(^|\.)(youtube\.com|youtu\.be|spotify\.com)$/;
    LOCAL_FILE_DOMAIN = "local file";
    FNV_OFFSET_HI = 3421674724;
    FNV_OFFSET_LO = 2216829733;
    FNV_PRIME_LOW = 435;
    laneHi = 0;
    laneLo = 0;
  }
});
function parse(url) {
  try {
    const u = new URL(url);
    return u.protocol === "https:" || u.protocol === "http:" ? u : void 0;
  } catch {
    return void 0;
  }
}
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
var VIDEO_ID;
var YOUTUBE_HOSTS;
var onHost;
var HOSTS;
var safeKey;
var shortHash;
var init_url2 = __esm({
  "src/video/url.ts"() {
    "use strict";
    init_url();
    VIDEO_ID = /^[A-Za-z0-9_-]{11}$/;
    YOUTUBE_HOSTS = ["youtube.com", "youtube-nocookie.com"];
    onHost = (host, domain) => host === domain || host.endsWith(`.${domain}`);
    HOSTS = [
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
    safeKey = (site, id) => `${site}-${id}`.replace(/[^A-Za-z0-9._-]/g, "_").slice(0, 120);
    shortHash = (text) => fnv1a64(text).toString(16).padStart(16, "0").slice(0, 8);
  }
});
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
function have(cmd) {
  let hit = havePresence.get(cmd);
  if (hit === void 0) {
    const probe = spawnSync2(process.platform === "win32" ? "where" : "which", [cmd], { encoding: "utf8" });
    hit = probe.status === 0 && (probe.stdout ?? "").trim().length > 0;
    havePresence.set(cmd, hit);
  }
  return hit;
}
function shAsync(cmd, args, opts = {}) {
  const timeoutMs = opts.timeoutMs ?? defaultTimeoutMs();
  if (opts.signal?.aborted) return Promise.resolve({ ok: false, status: 130, stdout: "", stderr: "aborted" });
  return new Promise((resolve82) => {
    let settled = false;
    let timer;
    let onAbort;
    const done = (r) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (onAbort) opts.signal?.removeEventListener("abort", onAbort);
      resolve82(r);
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
var STDOUT_CAP;
var defaultTimeoutMs;
var havePresence;
var init_exec2 = __esm({
  "src/exec.ts"() {
    "use strict";
    init_brand();
    init_process_tree();
    STDOUT_CAP = 24 * 1024 * 1024;
    defaultTimeoutMs = () => envInt("SH_TIMEOUT_MS", 6e4, 1e3);
    havePresence = /* @__PURE__ */ new Map();
  }
});
function ytdlpExtraArgs() {
  return (env("YTDLP_ARGS") ?? "").split(/\s+/).filter(Boolean);
}
function runYtdlp(args, opts = {}) {
  const strict = opts.knownOnly ? ["--use-extractors", "default,-generic"] : [];
  const argv = [...strict, ...args, ...ytdlpExtraArgs(), ...opts.url ? ["--", opts.url] : []];
  return (opts.run ?? defaultVideoRunner)("yt-dlp", argv, { timeoutMs: opts.timeoutMs ?? PROBE_TIMEOUT_MS, signal: opts.signal });
}
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
var defaultVideoRunner;
var PROBE_TIMEOUT_MS;
var SUBTITLE_TIMEOUT_MS;
var str;
var httpUrl;
var num;
var init_ytdlp = __esm({
  "src/video/ytdlp.ts"() {
    "use strict";
    init_brand();
    init_exec2();
    init_url2();
    defaultVideoRunner = (cmd, args, opts) => shAsync(cmd, args, opts);
    PROBE_TIMEOUT_MS = 12e4;
    SUBTITLE_TIMEOUT_MS = 12e4;
    str = (v) => typeof v === "string" && v.trim() ? v.trim() : void 0;
    httpUrl = (v) => v && /^https?:\/\//i.test(v) ? v : void 0;
    num = (v) => typeof v === "number" && Number.isFinite(v) ? v : void 0;
  }
});
function seconds(stamp) {
  const parts = stamp.replace(",", ".").split(":").map(Number);
  return parts.reduce((acc, p) => acc * 60 + p, 0);
}
function decode(text) {
  return text.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (whole2, name) => {
    if (name[0] === "#") {
      const code = name[1] === "x" || name[1] === "X" ? Number.parseInt(name.slice(2), 16) : Number(name.slice(1));
      return Number.isFinite(code) && code > 0 && code <= 1114111 ? String.fromCodePoint(code) : whole2;
    }
    return ENTITIES2[name.toLowerCase()] ?? whole2;
  });
}
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
var TIMING;
var MIN_CUE_S;
var ENTITIES2;
var clean;
var SENTENCE_END;
var MAX_SEGMENT_S;
var MAX_SENTENCES;
var PAUSE_S;
var WORDS_TO_CLOSE;
var BREAK_SLACK_S;
var init_vtt = __esm({
  "src/video/vtt.ts"() {
    "use strict";
    TIMING = /^((?:\d+:)?\d{1,2}:\d{2}[.,]\d{3})\s+-->\s+((?:\d+:)?\d{1,2}:\d{2}[.,]\d{3})/;
    MIN_CUE_S = 0.05;
    ENTITIES2 = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ", lrm: "", rlm: "" };
    clean = (line) => decode(line.replace(/<[^>]*>/g, "").replace(/\{\\[^}]*\}/g, "")).replace(/\s+/g, " ").trim();
    SENTENCE_END = /[.!?…]+["'”’)\]]*(?=\s|$)/g;
    MAX_SEGMENT_S = 30;
    MAX_SENTENCES = 3;
    PAUSE_S = 5;
    WORDS_TO_CLOSE = 25;
    BREAK_SLACK_S = 0.5;
  }
});
function whisperBudgetLeft() {
  return Math.max(0, envInt("WHISPER_MAX", DEFAULT_MAX) - spent2);
}
function whisperModel() {
  return env("WHISPER_MODEL") ?? DEFAULT_MODEL;
}
function whisperSegments(json2) {
  try {
    const parsed = JSON.parse(json2);
    return (parsed.segments ?? []).map((s) => ({
      start: Number(s.start),
      end: Number(s.end),
      text: String(s.text ?? "").replace(/\s+/g, " ").trim()
    })).filter((s) => Number.isFinite(s.start) && Number.isFinite(s.end) && s.text);
  } catch {
    return [];
  }
}
function whisperLanguage(tag2) {
  const base2 = tag2?.toLowerCase().split(/[-_]/)[0];
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
var DEFAULT_MAX;
var DEFAULT_TIMEOUT_MS2;
var DEFAULT_MODEL;
var PYAV_PIN;
var AUDIO_FORMAT;
var spent2;
var init_whisper = __esm({
  "src/video/whisper.ts"() {
    "use strict";
    init_brand();
    init_ytdlp();
    DEFAULT_MAX = 3;
    DEFAULT_TIMEOUT_MS2 = 30 * 6e4;
    DEFAULT_MODEL = "small";
    PYAV_PIN = "av<18";
    AUDIO_FORMAT = "bestaudio/best";
    spent2 = 0;
  }
});
function videoDeps(own) {
  return { run: own?.run ?? processDeps.run ?? defaultVideoRunner, have: own?.have ?? processDeps.have ?? have };
}
function enabledTranscribers(engines) {
  return engines ?? enginesFromEnv("VIDEO_ENGINES", VIDEO_TRANSCRIBERS) ?? VIDEO_TRANSCRIBERS;
}
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
async function subtitleRung(auto, meta, info, opts, deps) {
  const track2 = auto ? pickAutoTrack(meta) : pickManualTrack(meta, opts.lang);
  if (!track2) return { failure: auto ? "no auto-captions in the video's language" : "no manual subtitles", noTrack: true };
  const got = await downloadSubtitle(info, track2, auto, deps.run, opts.signal, opts.knownHostsOnly);
  if ("error" in got) return { failure: `${auto ? "auto-captions" : "subtitles"} (${track2}): ${got.error}` };
  return { segments: mergeSegments(parseVtt(got.vtt, { rolling: auto }), chapterStarts(meta)), track: track2 };
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
var VIDEO_TRANSCRIBERS;
var processDeps;
var dead3;
var MIN_WORDS_PER_MINUTE;
var base;
var chapterStarts;
var plain;
var init_ladder3 = __esm({
  "src/video/ladder.ts"() {
    "use strict";
    init_brand();
    init_exec2();
    init_ladder();
    init_url2();
    init_vtt();
    init_whisper();
    init_ytdlp();
    VIDEO_TRANSCRIBERS = ["manual-subs", "auto-subs", "whisper"];
    processDeps = {};
    dead3 = /* @__PURE__ */ new Map();
    MIN_WORDS_PER_MINUTE = 5;
    base = (tag2) => tag2.toLowerCase().split(/[-_]/)[0];
    chapterStarts = (meta) => meta.chapters.map((c) => c.start);
    plain = (segments) => segments.map((s) => s.text).join("\n");
  }
});
function formatStamp(seconds3) {
  const t = Math.max(0, Math.floor(Number.isFinite(seconds3) ? seconds3 : 0));
  const pad2 = (n) => String(n).padStart(2, "0");
  const h = Math.floor(t / 3600);
  const m = Math.floor(t % 3600 / 60);
  const s = t % 60;
  return h ? `${h}:${pad2(m)}:${pad2(s)}` : `${pad2(m)}:${pad2(s)}`;
}
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
var VIA_LABEL;
var paragraph;
var baseLang;
var init_markdown = __esm({
  "src/video/markdown.ts"() {
    "use strict";
    VIA_LABEL = {
      "manual-subs": "manual subtitles",
      "auto-subs": "YouTube auto-captions",
      whisper: "local whisper transcription"
    };
    paragraph = (s) => `[${formatStamp(s.start)}] ${s.text}`;
    baseLang = (tag2) => tag2.toLowerCase().replace(/-orig$/, "").split(/[-_]/)[0];
  }
});
function setNoWrite(on) {
  flagged = on;
}
function isNoWrite() {
  return flagged || envFlag("NO_WRITE");
}
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
function writeFileAtomic(path, content, mode2) {
  const tmp = `${path}.${process.pid}.${tmpCounter++}.tmp`;
  try {
    writeFileSync4(tmp, content, mode2 === void 0 ? void 0 : { mode: mode2 });
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
var flagged;
var collected;
var tmpCounter;
var init_no_write = __esm({
  "src/no-write.ts"() {
    "use strict";
    init_brand();
    flagged = false;
    collected = [];
    tmpCounter = 0;
  }
});
function escapeRegExp(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
function isStopword(term) {
  const t = term.toLowerCase();
  if (STOPWORDS.has(t)) return true;
  if (LOCALE_STOPWORDS.has(t) && !(term !== t && term === term.toUpperCase())) return true;
  const extra = brand().extraStopwords;
  return extra ? extraStopwordSet(extra).has(t) : false;
}
function extraStopwordSet(extra) {
  const hit = extraSets.get(extra);
  if (hit && hit.length === extra.length) return hit.set;
  const set = new Set(extra.map((w) => w.toLowerCase()));
  extraSets.set(extra, { length: extra.length, set });
  return set;
}
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
  const add2 = (raw, minLength) => {
    const lower = raw.toLowerCase();
    if (raw.length < minLength || isStopword(raw) || seen.has(lower)) return;
    seen.add(lower);
    out.push(raw);
  };
  const nonAscii = NON_ASCII.test(question);
  for (const [raw] of (nonAscii ? question.normalize("NFC") : question).matchAll(TOKEN_RE)) {
    if (!nonAscii || !CJK_CHAR.test(raw)) {
      add2(raw, 2);
      continue;
    }
    for (const piece of raw.split(CJK_RUNS)) {
      if (!piece) continue;
      if (!CJK_CHAR.test(piece)) add2(piece, 2);
      else for (const gram of cjkBigrams(piece)) add2(gram, 1);
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
function baseChar(ch) {
  const known = BASE_OF.get(ch);
  if (known) return known;
  const stripped = ch.normalize("NFD").replace(new RegExp("\\p{M}+", "gu"), "");
  return stripped.length === 1 ? stripped : ch;
}
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
function atxTitle(line) {
  const open2 = ATX_OPEN.exec(line);
  if (!open2) return void 0;
  let title = line.slice(open2[0].length).trimEnd();
  const close = ATX_CLOSE.exec(title);
  if (close) title = title.slice(0, close.index).trimEnd();
  return title ? title.replace(MD_ESCAPE, "$1") : void 0;
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
  const tag2 = fnv1a64(canonical).toString(16).padStart(16, "0").slice(0, 8);
  const readable = /[\u0080-\uffff]/.test(normalized) ? s.replace(/-{2,}/g, "-") : s;
  const head = readable.slice(0, Math.max(0, max - tag2.length - 1)).replace(/-+$/, "");
  return head ? `${head}-${tag2}` : tag2;
}
var STOPWORDS;
var LOCALE_STOPWORDS;
var extraSets;
var TOKEN_RE;
var CJK_CHAR;
var CJK_RUNS;
var ACCENT_CLASSES;
var BASE_OF;
var NON_ASCII;
var MAX_PATTERNS;
var VARIANT_PRIORITY;
var LIGATURE_SPELLING;
var LIGATURE_OF;
var SHORT_VARIANT;
var ATX_OPEN;
var ATX_CLOSE;
var MD_ESCAPE;
var init_text = __esm({
  "src/text.ts"() {
    "use strict";
    init_brand();
    init_url();
    STOPWORDS = /* @__PURE__ */ new Set([
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
    LOCALE_STOPWORDS = /* @__PURE__ */ new Set([
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
    extraSets = /* @__PURE__ */ new WeakMap();
    TOKEN_RE = new RegExp("(?<![\\p{L}\\p{M}\\p{N}_])\\.net(?![\\p{L}\\p{M}\\p{N}_])|[\\p{L}\\p{M}\\p{N}_]+(?:(?<=\\p{L})[+#]{1,2}\\d*(?![\\p{L}\\p{M}\\p{N}_+#])|\\/\\d(?:\\.\\d)?(?![\\p{L}\\p{M}\\p{N}_./]))?", "giu");
    CJK_CHAR = /[\p{scx=Han}\p{scx=Hiragana}\p{scx=Katakana}]/u;
    CJK_RUNS = /([\p{scx=Han}\p{scx=Hiragana}\p{scx=Katakana}]+)/u;
    ACCENT_CLASSES = {
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
    BASE_OF = /* @__PURE__ */ new Map();
    for (const [base2, cls] of Object.entries(ACCENT_CLASSES)) {
      for (const ch of cls) BASE_OF.set(ch, base2);
    }
    NON_ASCII = /[\u0080-\uffff]/;
    MAX_PATTERNS = 24;
    VARIANT_PRIORITY = { original: 0, folded: 1, subtoken: 2 };
    LIGATURE_SPELLING = { \u0153: "oe", \u00E6: "ae", \u00DF: "ss" };
    LIGATURE_OF = { oe: "\u0153", ae: "\xE6", ss: "\xDF" };
    SHORT_VARIANT = 3;
    ATX_OPEN = /^#{1,6}\s+/;
    ATX_CLOSE = /(?:^|\s)#+$/;
    MD_ESCAPE = /\\([!-/:-@[-`{-~])/g;
  }
});
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
function bm25Tokenize(text, opts = {}) {
  return tokenize(text, opts.subtokens !== false);
}
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
function foldCached(raw) {
  const hit = foldCache.get(raw);
  if (hit !== void 0) return hit;
  const t = foldTerm(raw);
  if (foldCache.size >= FOLD_CACHE_MAX) foldCache.clear();
  foldCache.set(raw, t);
  return t;
}
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
function recencyScore(meta, minYear, maxYear) {
  const y = typeof meta?.year === "number" ? meta.year : void 0;
  if (y === void 0 || maxYear <= minYear) return 0.5;
  const clamped = Math.min(maxYear, Math.max(minYear, y));
  return (clamped - minYear) / (maxYear - minYear);
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
function popcount32(n) {
  let x = n - (n >>> 1 & 1431655765);
  x = (x & 858993459) + (x >>> 2 & 858993459);
  return Math.imul(x + (x >>> 4) & 252645135, 16843009) >>> 24;
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
var byCodeUnit;
var indexTokenCache;
var WORD_SPLIT;
var NON_ASCII2;
var CJK_CHAR2;
var CJK_RUNS2;
var IDENT_BOUNDARY;
var MAX_IDENT;
var FOLD_CACHE_MAX;
var foldCache;
var NO_SUBTERMS;
var subtermCache;
var subtermExtras;
var MASK32;
var PAIR_CACHE_MAX;
var URL_IN_TEXT;
var init_rank = __esm({
  "src/rank.ts"() {
    "use strict";
    init_brand();
    init_text();
    init_url();
    byCodeUnit = (a, b) => a < b ? -1 : a > b ? 1 : 0;
    indexTokenCache = /* @__PURE__ */ new WeakMap();
    WORD_SPLIT = /[^\p{L}\p{M}\p{N}_]+/u;
    NON_ASCII2 = /[^\p{ASCII}]/u;
    CJK_CHAR2 = /[\p{scx=Han}\p{scx=Hiragana}\p{scx=Katakana}]/u;
    CJK_RUNS2 = /([\p{scx=Han}\p{scx=Hiragana}\p{scx=Katakana}]+)/u;
    IDENT_BOUNDARY = new RegExp("_|[\\p{Ll}\\p{N}]\\p{Lu}|\\p{Lu}\\p{Lu}\\p{Ll}|\\p{L}\\p{N}|\\p{N}\\p{L}", "u");
    MAX_IDENT = 64;
    FOLD_CACHE_MAX = 5e4;
    foldCache = /* @__PURE__ */ new Map();
    NO_SUBTERMS = [];
    subtermCache = /* @__PURE__ */ new Map();
    subtermExtras = { list: void 0, length: 0 };
    MASK32 = 0xffffffffn;
    PAIR_CACHE_MAX = 2048;
    URL_IN_TEXT = /https?:\/\/(?:[^\s/@?#]+@)?[\p{L}\p{N}.-]+/giu;
  }
});
var baseLang2;
var readJson;
var PASSAGE_S;
var chapterAt;
var init_run = __esm({
  "src/video/run.ts"() {
    "use strict";
    init_brand();
    init_no_write();
    init_rank();
    init_ladder3();
    init_markdown();
    init_url2();
    init_ytdlp();
    baseLang2 = (tag2) => tag2.toLowerCase().replace(/-orig$/, "").split(/[-_]/)[0];
    readJson = (path) => {
      try {
        return JSON.parse(readFileSync5(path, "utf8"));
      } catch {
        return void 0;
      }
    };
    PASSAGE_S = 45;
    chapterAt = (chapters, t) => [...chapters].reverse().find((c) => c.start <= t + 0.5)?.title;
  }
});
var BEFORE_S;
var AFTER_S;
var chapterAt2;
var init_align = __esm({
  "src/video/align.ts"() {
    "use strict";
    init_markdown();
    BEFORE_S = 5;
    AFTER_S = 10;
    chapterAt2 = (chapters, t) => [...chapters].sort((a, b) => b.start - a.start).find((c) => c.start <= t + 0.5)?.title;
  }
});
var DHASH_FRAME_BYTES;
var DHASH_SAME;
var init_dhash = __esm({
  "src/video/dhash.ts"() {
    "use strict";
    DHASH_FRAME_BYTES = 72;
    DHASH_SAME = 6;
  }
});
var FRAME_EFFORT;
var SCENE_THRESHOLD;
var VIDEO_FORMAT;
var FRAMES_TIMEOUT_MS;
var MIN_FRAMES;
var INTERVAL_FRAMES;
var JPEG_FILTER;
var plural;
var fileStamp;
var init_frames = __esm({
  "src/video/frames.ts"() {
    "use strict";
    init_no_write();
    init_align();
    init_dhash();
    init_ladder3();
    init_markdown();
    init_run();
    init_url2();
    init_ytdlp();
    FRAME_EFFORT = { low: 20, med: 50, high: 100 };
    SCENE_THRESHOLD = 0.3;
    VIDEO_FORMAT = "bv*[height<=720]/b[height<=720]/bv*/b";
    FRAMES_TIMEOUT_MS = 30 * 6e4;
    MIN_FRAMES = 3;
    INTERVAL_FRAMES = 10;
    JPEG_FILTER = "scale='min(1280,iw)':-2:out_range=full,format=yuvj420p";
    plural = (n, word) => `${n} ${word}${n === 1 ? "" : "s"}`;
    fileStamp = (t) => formatStamp(t).replace(/:/g, "-");
  }
});
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
var init_pool = __esm({
  "src/pool.ts"() {
    "use strict";
  }
});
var LIST_TIMEOUT_MS;
var DEFAULT_LIMIT;
var CORPUS_CONCURRENCY;
var init_list = __esm({
  "src/video/list.ts"() {
    "use strict";
    init_no_write();
    init_pool();
    init_ladder3();
    init_markdown();
    init_run();
    init_url2();
    init_ytdlp();
    LIST_TIMEOUT_MS = 12e4;
    DEFAULT_LIMIT = 10;
    CORPUS_CONCURRENCY = 2;
  }
});
var init_video = __esm({
  "src/video.ts"() {
    "use strict";
    init_url2();
    init_ytdlp();
    init_vtt();
    init_whisper();
    init_ladder3();
    init_markdown();
    init_run();
    init_frames();
    init_list();
  }
});
function parseArgs(argv, spec) {
  const commands = new Set(spec.commands);
  const valueFlags = new Set(spec.valueFlags);
  const boolFlags = new Set(spec.boolFlags);
  if (argv.length === 0) return { kind: "help" };
  if (isHelpWord(argv[0])) return argv[1] !== void 0 && commands.has(argv[1]) ? { kind: "help", command: argv[1] } : { kind: "help" };
  if (isVersionWord(argv[0])) return { kind: "version" };
  const command2 = argv[0];
  if (!commands.has(command2)) {
    throw new UsageError(`unknown command "${command2}" \u2014 run --help for the supported commands`);
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
      if (isHelpWord(arg)) return { kind: "help", command: command2 };
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
  return { kind: "command", command: command2, positional, values, bools };
}
function isHelpWord(a) {
  return a === "--help" || a === "-h" || a === "help";
}
function isVersionWord(a) {
  return a === "--version" || a === "-v" || a === "version";
}
var EXIT_OK;
var EXIT_FAILURE;
var EXIT_USAGE;
var EXIT_HUMAN;
var UsageError;
var init_cli_kit = __esm({
  "src/cli-kit.ts"() {
    "use strict";
    init_brand();
    init_text();
    EXIT_OK = 0;
    EXIT_FAILURE = 1;
    EXIT_USAGE = 2;
    EXIT_HUMAN = 3;
    UsageError = class extends Error {
      exitCode = EXIT_USAGE;
    };
  }
});
function encodeFrame(opcode, payload, opts = {}) {
  const mask = opts.mask ?? true;
  const len = payload.length;
  const lenBytes = len <= 125 ? 0 : len <= 65535 ? 2 : 8;
  const head = Buffer.alloc(2 + lenBytes + (mask ? 4 : 0));
  head[0] = (opts.fin === false ? 0 : 128) | opcode & 15;
  head[1] = (mask ? 128 : 0) | (lenBytes === 0 ? len : lenBytes === 2 ? 126 : 127);
  if (lenBytes === 2) head.writeUInt16BE(len, 2);
  if (lenBytes === 8) head.writeBigUInt64BE(BigInt(len), 2);
  if (!mask) return Buffer.concat([head, payload]);
  const key = opts.maskKey ?? randomBytes(4);
  key.copy(head, 2 + lenBytes);
  return Buffer.concat([head, unmask(payload, key)]);
}
function unmask(payload, key) {
  const out = Buffer.allocUnsafe(payload.length);
  for (let i = 0; i < payload.length; i++) out[i] = payload[i] ^ key[i & 3];
  return out;
}
async function connectWebSocket(url, opts = {}) {
  const { request } = await import("http");
  return new Promise((resolve82, reject) => {
    let u;
    try {
      u = new URL(url);
    } catch {
      return reject(new Error(`bad WebSocket URL: ${url}`));
    }
    if (u.protocol !== "ws:") return reject(new Error(`only ws:// URLs are supported, got ${u.protocol}//`));
    const key = randomBytes(16).toString("base64");
    const expected = createHash("sha1").update(key + GUID).digest("base64");
    let settled = false;
    const settle = (fn) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      fn();
    };
    const req = request({
      host: u.hostname.replace(/^\[|\]$/g, ""),
      port: u.port || 80,
      path: u.pathname + u.search,
      headers: { Connection: "Upgrade", Upgrade: "websocket", "Sec-WebSocket-Key": key, "Sec-WebSocket-Version": "13" }
    });
    const timer = setTimeout(
      () => settle(() => {
        req.destroy();
        reject(new Error(`WebSocket connect timed out after ${opts.connectTimeoutMs ?? 1e4} ms`));
      }),
      opts.connectTimeoutMs ?? 1e4
    );
    req.on("upgrade", (res, socket, head) => {
      if (res.headers["sec-websocket-accept"] !== expected) {
        socket.destroy();
        return settle(() => reject(new Error("WebSocket handshake failed: bad Accept")));
      }
      settle(() => resolve82(new WsClient(socket, opts, head)));
    });
    req.on("response", (res) => {
      res.resume();
      settle(() => reject(new Error(`WebSocket handshake failed: HTTP ${res.statusCode}`)));
    });
    req.on("error", (e) => settle(() => reject(e)));
    req.end();
  });
}
var GUID;
var DEFAULT_MAX_MESSAGE;
var WsProtocolError;
var FrameParser;
var WsClient;
var init_ws = __esm({
  "src/browser/ws.ts"() {
    "use strict";
    GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";
    DEFAULT_MAX_MESSAGE = 64 * 1024 * 1024;
    WsProtocolError = class extends Error {
      constructor(message, code) {
        super(message);
        this.code = code;
        this.name = "WsProtocolError";
      }
      code;
    };
    FrameParser = class {
      buf = Buffer.alloc(0);
      max;
      constructor(opts = {}) {
        this.max = opts.maxMessageSize ?? DEFAULT_MAX_MESSAGE;
      }
      push(chunk) {
        this.buf = this.buf.length === 0 ? chunk : Buffer.concat([this.buf, chunk]);
        const frames = [];
        for (; ; ) {
          const frame = this.next();
          if (!frame) return frames;
          frames.push(frame);
        }
      }
      next() {
        const b = this.buf;
        if (b.length < 2) return void 0;
        const masked = (b[1] & 128) !== 0;
        let len = b[1] & 127;
        let off = 2;
        if (len === 126) {
          if (b.length < 4) return void 0;
          len = b.readUInt16BE(2);
          off = 4;
        } else if (len === 127) {
          if (b.length < 10) return void 0;
          const big = b.readBigUInt64BE(2);
          if (big > BigInt(this.max)) throw new WsProtocolError("message too large", 1009);
          len = Number(big);
          off = 10;
        }
        if (len > this.max) throw new WsProtocolError("message too large", 1009);
        const total = off + (masked ? 4 : 0) + len;
        if (b.length < total) return void 0;
        const payload = masked ? unmask(b.subarray(off + 4, total), b.subarray(off, off + 4)) : Buffer.from(b.subarray(off, total));
        this.buf = b.subarray(total);
        return { fin: (b[0] & 128) !== 0, opcode: b[0] & 15, payload };
      }
    };
    WsClient = class extends EventEmitter {
      constructor(socket, opts = {}, head = Buffer.alloc(0)) {
        super();
        this.socket = socket;
        this.max = opts.maxMessageSize ?? DEFAULT_MAX_MESSAGE;
        this.closeTimeoutMs = opts.closeTimeoutMs ?? 2e3;
        this.parser = new FrameParser({ maxMessageSize: this.max });
        socket.on("data", (d) => this.feed(d));
        socket.on("error", (e) => this.fail(e, 1006));
        socket.on("close", () => this.finish(1006, ""));
        socket.pause();
        setImmediate(() => {
          if (head.length) this.feed(head);
          socket.resume();
        });
      }
      socket;
      parser;
      max;
      closeTimeoutMs;
      fragments = [];
      fragmentBytes = 0;
      started = false;
      closing = false;
      done = false;
      send(text) {
        if (this.done || this.closing) throw new Error("WebSocket is not open");
        this.socket.write(encodeFrame(1, Buffer.from(text, "utf8")));
      }
      /** Send a close frame, then wait (bounded) for the peer to answer or hang up. */
      async close(code = 1e3, reason = "") {
        if (this.done) return;
        if (!this.closing) {
          this.closing = true;
          this.writeClose(code, reason);
        }
        await new Promise((resolve82) => {
          const timer = setTimeout(() => {
            this.socket.destroy();
            this.finish(code, reason);
          }, this.closeTimeoutMs);
          this.once("close", () => {
            clearTimeout(timer);
            resolve82();
          });
        });
      }
      /** Drop the socket without a closing handshake. */
      terminate() {
        this.socket.destroy();
        this.finish(1006, "");
      }
      writeClose(code, reason) {
        const payload = Buffer.alloc(2 + Buffer.byteLength(reason));
        payload.writeUInt16BE(code, 0);
        payload.write(reason, 2);
        if (!this.socket.destroyed) this.socket.write(encodeFrame(8, payload));
      }
      feed(chunk) {
        let frames;
        try {
          frames = this.parser.push(chunk);
        } catch (e) {
          this.fail(e, e instanceof WsProtocolError ? e.code : 1002);
          return;
        }
        for (const frame of frames) {
          if (this.done) return;
          let text;
          try {
            text = this.onFrame(frame);
          } catch (e) {
            this.fail(e, e instanceof WsProtocolError ? e.code : 1002);
            return;
          }
          if (text !== void 0) this.deliver(text);
        }
      }
      deliver(text) {
        try {
          this.emit("message", text);
        } catch (e) {
          if (this.listenerCount("error") > 0) this.emit("error", e);
          else
            process.nextTick(() => {
              throw e;
            });
        }
      }
      /** Handle one frame; returns the text of a message it completed. */
      onFrame(f) {
        if (this.done) return;
        switch (f.opcode) {
          case 9:
            if (!this.socket.destroyed) this.socket.write(encodeFrame(10, f.payload));
            return;
          case 10:
            return;
          case 8: {
            const code = f.payload.length >= 2 ? f.payload.readUInt16BE(0) : 1005;
            const reason = f.payload.subarray(2).toString("utf8");
            if (!this.closing) this.writeClose(f.payload.length >= 2 ? code : 1e3, "");
            this.socket.end();
            this.finish(code, reason);
            return;
          }
          case 1:
          case 2:
            if (this.started) throw new WsProtocolError("new data frame inside a fragmented message", 1002);
            this.started = true;
            break;
          case 0:
            if (!this.started) throw new WsProtocolError("unexpected continuation frame", 1002);
            break;
          default:
            throw new WsProtocolError(`unknown opcode ${f.opcode}`, 1002);
        }
        this.fragmentBytes += f.payload.length;
        if (this.fragmentBytes > this.max) throw new WsProtocolError("message too large", 1009);
        this.fragments.push(f.payload);
        if (!f.fin) return;
        const text = Buffer.concat(this.fragments).toString("utf8");
        this.fragments = [];
        this.fragmentBytes = 0;
        this.started = false;
        return text;
      }
      /** Protocol or socket failure: tell the peer why (when we can), surface the error, close. */
      fail(err, code) {
        if (this.done) return;
        if (code !== 1006 && !this.closing) {
          this.closing = true;
          this.writeClose(code, "");
        }
        if (this.listenerCount("error") > 0) this.emit("error", err);
        this.socket.end();
        this.finish(code, err.message);
      }
      finish(code, reason) {
        if (this.done) return;
        this.done = true;
        this.emit("close", { code, reason });
      }
    };
  }
});
var DEFAULT_CALL_TIMEOUT_MS;
var DEFAULT_CONNECT_TIMEOUT_MS;
var CdpError;
var defaultConnector;
var bucket;
var CdpClient;
var init_cdp = __esm({
  "src/browser/cdp.ts"() {
    "use strict";
    init_ws();
    DEFAULT_CALL_TIMEOUT_MS = 3e4;
    DEFAULT_CONNECT_TIMEOUT_MS = 1e4;
    CdpError = class extends Error {
      constructor(method, code, message) {
        super(`CDP ${method} failed: ${message}${code ? ` (${code})` : ""}`);
        this.method = method;
        this.code = code;
        this.name = "CdpError";
      }
      method;
      code;
    };
    defaultConnector = (url, { timeoutMs }) => connectWebSocket(url, { connectTimeoutMs: timeoutMs });
    bucket = (sessionId, method) => `${sessionId ?? ""}
${method}`;
    CdpClient = class _CdpClient {
      constructor(ws) {
        this.ws = ws;
        ws.on("message", (text) => this.onMessage(text));
        ws.on("close", () => this.onClosed());
        ws.on("error", () => {
        });
      }
      ws;
      nextId = 0;
      pending = /* @__PURE__ */ new Map();
      handlers = /* @__PURE__ */ new Map();
      closeHandlers = /* @__PURE__ */ new Set();
      isClosed = false;
      static async connect(wsUrl, opts = {}) {
        const connector = opts.transport ?? defaultConnector;
        return new _CdpClient(await connector(wsUrl, { timeoutMs: opts.timeoutMs ?? DEFAULT_CONNECT_TIMEOUT_MS }));
      }
      get closed() {
        return this.isClosed;
      }
      send(method, params, opts = {}) {
        if (this.isClosed) return Promise.reject(new Error(`CDP connection closed (${method})`));
        const id = ++this.nextId;
        const timeoutMs = opts.timeoutMs ?? DEFAULT_CALL_TIMEOUT_MS;
        return new Promise((resolve82, reject) => {
          const timer = setTimeout(() => {
            this.pending.delete(id);
            reject(new Error(`CDP command timed out: ${method} (${timeoutMs} ms)`));
          }, timeoutMs);
          this.pending.set(id, { method, resolve: resolve82, reject, timer });
          try {
            this.ws.send(JSON.stringify({ id, method, params, sessionId: opts.sessionId }));
          } catch (e) {
            clearTimeout(timer);
            this.pending.delete(id);
            reject(e);
          }
        });
      }
      on(method, handler, sessionId) {
        const key = bucket(sessionId, method);
        let set = this.handlers.get(key);
        if (!set) this.handlers.set(key, set = /* @__PURE__ */ new Set());
        set.add(handler);
      }
      off(method, handler, sessionId) {
        const key = bucket(sessionId, method);
        const set = this.handlers.get(key);
        if (!set) return;
        set.delete(handler);
        if (set.size === 0) this.handlers.delete(key);
      }
      /** Resolve with the params of the next matching event; reject on timeout or when the socket closes. */
      once(method, opts = {}) {
        const timeoutMs = opts.timeoutMs ?? DEFAULT_CALL_TIMEOUT_MS;
        return new Promise((resolve82, reject) => {
          const cleanup = () => {
            clearTimeout(timer);
            this.off(method, handler, opts.sessionId);
            this.closeHandlers.delete(onClose);
          };
          const handler = (params) => {
            if (opts.predicate && !opts.predicate(params)) return;
            cleanup();
            resolve82(params);
          };
          const onClose = () => {
            cleanup();
            reject(new Error(`CDP connection closed while waiting for ${method}`));
          };
          const timer = setTimeout(() => {
            cleanup();
            reject(new Error(`Timed out waiting for CDP event ${method} (${timeoutMs} ms)`));
          }, timeoutMs);
          this.on(method, handler, opts.sessionId);
          this.closeHandlers.add(onClose);
          if (this.isClosed) onClose();
        });
      }
      /** A view of this client bound to one session (`Target.attachToTarget({ flatten: true })`). */
      session(sessionId) {
        return {
          sessionId,
          send: (method, params, opts) => this.send(method, params, { ...opts, sessionId }),
          on: (method, handler) => this.on(method, handler, sessionId),
          off: (method, handler) => this.off(method, handler, sessionId),
          once: (method, opts) => this.once(method, { ...opts, sessionId })
        };
      }
      /** Run `handler` once the connection is closed (at once if it already is). Returns its unsubscribe. */
      onClose(handler) {
        if (this.isClosed) {
          handler();
          return () => {
          };
        }
        this.closeHandlers.add(handler);
        return () => void this.closeHandlers.delete(handler);
      }
      /** Close the connection (the browser keeps running). */
      async close() {
        if (this.isClosed) return;
        await this.ws.close();
        this.onClosed();
      }
      onMessage(text) {
        let msg;
        try {
          msg = JSON.parse(text);
        } catch {
          return;
        }
        if (msg === null || typeof msg !== "object") return;
        if (typeof msg.id === "number") {
          const p = this.pending.get(msg.id);
          if (!p) return;
          clearTimeout(p.timer);
          this.pending.delete(msg.id);
          if (msg.error) p.reject(new CdpError(p.method, Number(msg.error.code) || 0, String(msg.error.message ?? "unknown error")));
          else p.resolve(msg.result);
          return;
        }
        if (typeof msg.method !== "string") return;
        const set = this.handlers.get(bucket(msg.sessionId, msg.method));
        if (!set) return;
        for (const h of [...set]) {
          try {
            h(msg.params);
          } catch {
          }
        }
      }
      onClosed() {
        if (this.isClosed) return;
        this.isClosed = true;
        for (const p of this.pending.values()) {
          clearTimeout(p.timer);
          p.reject(new Error(`CDP connection closed (${p.method})`));
        }
        this.pending.clear();
        for (const h of [...this.closeHandlers]) h();
        this.closeHandlers.clear();
      }
    };
  }
});
function isLaunchable(path) {
  try {
    if (!statSync2(path).isFile()) return false;
    if (process.platform !== "win32") accessSync(path, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}
function candidates(kind, platform, sys, home) {
  if (platform === "darwin") {
    const app = MAC_APPS[kind];
    return ["/Applications", posix.join(home, "Applications")].map((dir) => posix.join(dir, `${app}.app`, "Contents", "MacOS", app));
  }
  if (platform === "win32") {
    const roots = [sys.ProgramFiles, sys["ProgramFiles(x86)"], sys.LOCALAPPDATA].filter((r) => !!r);
    return roots.map((root) => win32.join(root, WINDOWS_PATHS[kind]));
  }
  const dirs = (sys.PATH ?? "").split(":").filter(Boolean);
  return LINUX_NAMES[kind].flatMap((name) => dirs.map((dir) => posix.join(dir, name)));
}
function kindOf(path) {
  const name = (path.split(/[\\/]/).pop() ?? "").toLowerCase();
  if (name.includes("brave")) return "brave";
  if (name.includes("edge")) return "edge";
  if (name.includes("chromium")) return "chromium";
  return "chrome";
}
function detectBrowserBinary(opts = {}) {
  const platform = opts.platform ?? process.platform;
  const sys = opts.processEnv ?? process.env;
  const exists = opts.exists ?? isLaunchable;
  const home = opts.home ?? homedir();
  const explicit = opts.env ? opts.env("BROWSER_BIN") : env("BROWSER_BIN");
  if (explicit) {
    const bare = !/[\\/]/.test(explicit);
    const options = bare ? (sys.PATH ?? "").split(":").filter(Boolean).map((d) => posix.join(d, explicit)) : [explicit];
    const found = options.find(exists);
    if (!found) throw new Error(`BROWSER_BIN points at "${explicit}", which is not an executable file`);
    return { kind: kindOf(found), path: found };
  }
  let only = opts.kind;
  if (!only && !opts.prefer) {
    const asked = (opts.env ? opts.env("BROWSER_KIND") : env("BROWSER_KIND"))?.trim().toLowerCase();
    if (asked && !isBrowserKind(asked)) throw new Error(`${envName("BROWSER_KIND")} is "${asked}", not one of ${ORDER.join(", ")}`);
    if (asked && isBrowserKind(asked)) only = asked;
  }
  const prefer = opts.prefer;
  const kinds = only ? [only] : prefer ? [prefer, ...ORDER.filter((k) => k !== prefer)] : ORDER;
  for (const kind of kinds) {
    const path = candidates(kind, platform, sys, home).find(exists);
    if (path) return { kind, path };
  }
  return null;
}
function ignoresUnpackedExtensions(bin, browserVersion) {
  if (bin.kind !== "chrome" || /for[ _-]?testing|[\\/]chrome-(?:linux|mac|win)[^\\/]*[\\/]/i.test(bin.path)) return false;
  if (browserVersion === void 0) return true;
  const major = /^(?:Headless)?Chrome\/(\d+)\./.exec(browserVersion)?.[1];
  return major !== void 0 && Number(major) >= 137;
}
var ORDER;
var isBrowserKind;
var MAC_APPS;
var LINUX_NAMES;
var WINDOWS_PATHS;
var init_detect = __esm({
  "src/browser/detect.ts"() {
    "use strict";
    init_brand();
    ORDER = ["chrome", "brave", "chromium", "edge"];
    isBrowserKind = (v) => ORDER.includes(v);
    MAC_APPS = {
      chrome: "Google Chrome",
      brave: "Brave Browser",
      chromium: "Chromium",
      edge: "Microsoft Edge"
    };
    LINUX_NAMES = {
      chrome: ["google-chrome", "google-chrome-stable"],
      brave: ["brave-browser"],
      chromium: ["chromium", "chromium-browser"],
      edge: ["microsoft-edge"]
    };
    WINDOWS_PATHS = {
      chrome: "Google\\Chrome\\Application\\chrome.exe",
      brave: "BraveSoftware\\Brave-Browser\\Application\\brave.exe",
      chromium: "Chromium\\Application\\chrome.exe",
      edge: "Microsoft\\Edge\\Application\\msedge.exe"
    };
  }
});
var discovery_exports = {};
__export(discovery_exports, {
  activateTarget: () => activateTarget,
  assertLoopback: () => assertLoopback,
  closeTarget: () => closeTarget,
  dialHost: () => dialHost,
  getVersion: () => getVersion,
  isPortAlive: () => isPortAlive,
  listPages: () => listPages,
  listTargets: () => listTargets,
  loopbackSocketUrl: () => loopbackSocketUrl,
  newTarget: () => newTarget,
  parseCdpEndpoint: () => parseCdpEndpoint
});
function assertLoopback(host) {
  const bare = host.replace(/^\[|\]$/g, "").toLowerCase();
  if (!LOOPBACK.has(bare)) throw new Error(`refusing non-loopback DevTools host "${host}" (only 127.0.0.1, ::1 and localhost are allowed)`);
  return bare;
}
function loopbackSocketUrl(wsUrl) {
  let url;
  try {
    url = new URL(wsUrl);
  } catch {
    throw new Error(`invalid DevTools WebSocket URL "${wsUrl}"`);
  }
  if (url.protocol !== "ws:") throw new Error(`refusing DevTools WebSocket URL "${wsUrl}": only ws:// on loopback is dialled`);
  assertLoopback(url.hostname);
  return wsUrl;
}
function parseCdpEndpoint(input) {
  const text = input.trim();
  if (/^\d+$/.test(text)) return { host: "127.0.0.1", port: checkPort(Number(text), input) };
  let url;
  try {
    url = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(text) ? text : `http://${text}`);
  } catch {
    throw new Error(`invalid DevTools endpoint "${input}"`);
  }
  if (!["http:", "https:", "ws:", "wss:"].includes(url.protocol)) throw new Error(`unsupported DevTools endpoint scheme "${url.protocol}" in "${input}"`);
  const host = assertLoopback(url.hostname);
  if (!url.port) throw new Error(`DevTools endpoint "${input}" has no port`);
  const endpoint = { host, port: checkPort(Number(url.port), input) };
  if (url.protocol === "ws:" || url.protocol === "wss:") endpoint.wsUrl = text;
  return endpoint;
}
function checkPort(port, input) {
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error(`invalid port in DevTools endpoint "${input}"`);
  return port;
}
function dialHost(host) {
  const bare = assertLoopback(host);
  return bare === "localhost" ? "127.0.0.1" : bare;
}
async function http(method, port, host, path, timeoutMs = REQUEST_TIMEOUT_MS) {
  const { request } = await import("http");
  return new Promise((resolve82, reject) => {
    const req = request({ host: dialHost(host), port, path, method, timeout: timeoutMs }, (res) => {
      const chunks = [];
      res.on("data", (c) => chunks.push(c));
      res.on("end", () => resolve82({ status: res.statusCode ?? 0, body: Buffer.concat(chunks).toString("utf8") }));
      res.on("error", reject);
    });
    req.on("timeout", () => req.destroy(new Error(`DevTools request ${method} ${path} timed out after ${timeoutMs} ms`)));
    req.on("error", reject);
    req.end();
  });
}
async function json(method, port, host, path) {
  const { status, body } = await http(method, port, host, path);
  if (status < 200 || status >= 300) throw new Error(`DevTools ${method} ${path} answered HTTP ${status}`);
  try {
    return JSON.parse(body);
  } catch {
    throw new Error(`DevTools ${path} did not return valid JSON`);
  }
}
function getVersion(port, host = "127.0.0.1") {
  return json("GET", port, host, "/json/version");
}
function listTargets(port, host = "127.0.0.1") {
  return json("GET", port, host, "/json/list");
}
async function listPages(port, host = "127.0.0.1") {
  return (await listTargets(port, host)).filter((t) => t.type === "page");
}
async function newTarget(port, url, host = "127.0.0.1") {
  const path = url === void 0 ? "/json/new" : `/json/new?${encodeURIComponent(url)}`;
  try {
    return await json("PUT", port, host, path);
  } catch (e) {
    if (!/answered HTTP/.test(e.message)) throw e;
    return json("GET", port, host, path);
  }
}
async function command(port, host, path) {
  const { status, body } = await http("GET", port, host, path);
  if (status < 200 || status >= 300) throw new Error(`DevTools GET ${path} answered HTTP ${status}`);
  return body;
}
async function closeTarget(port, id, host = "127.0.0.1") {
  await command(port, host, `/json/close/${encodeURIComponent(id)}`);
}
async function activateTarget(port, id, host = "127.0.0.1") {
  await command(port, host, `/json/activate/${encodeURIComponent(id)}`);
}
async function isPortAlive(port, host = "127.0.0.1") {
  try {
    const { status } = await http("GET", port, host, "/json/version", ALIVE_TIMEOUT_MS);
    return status === 200;
  } catch {
    return false;
  }
}
var REQUEST_TIMEOUT_MS;
var ALIVE_TIMEOUT_MS;
var LOOPBACK;
var init_discovery = __esm({
  "src/browser/discovery.ts"() {
    "use strict";
    REQUEST_TIMEOUT_MS = 3e3;
    ALIVE_TIMEOUT_MS = 1e3;
    LOOPBACK = /* @__PURE__ */ new Set(["127.0.0.1", "::1", "localhost"]);
  }
});
function defaultBrowserDeps() {
  return {
    spawn: (cmd, args, opts) => nodeSpawn(cmd, args, opts),
    fs: { readFile, writeFile, rename, mkdir, rm, stat, open },
    now: () => Date.now(),
    sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
    connectCdp: (wsUrl) => CdpClient.connect(wsUrl),
    discovery: discovery_exports,
    detectBrowser: (kind) => detectBrowserBinary(kind ? { kind } : {}),
    kill: (pid, signal) => void process.kill(pid, signal),
    env: (name) => env(name),
    platform: process.platform
  };
}
function browserDeps(own) {
  return { ...defaultBrowserDeps(), ...own };
}
var init_deps = __esm({
  "src/browser/deps.ts"() {
    "use strict";
    init_brand();
    init_cdp();
    init_detect();
    init_discovery();
  }
});
function extensionDirs(raw) {
  const name = envName("BROWSER_EXTENSIONS");
  return (raw ?? "").split(",").map((s) => s.trim()).filter(Boolean).map((dir) => {
    if (!isAbsolute2(dir)) throw new UsageError(`${name} takes absolute paths, not ${JSON.stringify(dir)}`);
    let isDir = false;
    try {
      isDir = statSync3(dir).isDirectory();
    } catch {
    }
    if (!isDir) throw new UsageError(`${name}: no such directory: ${dir}`);
    if (!existsSync5(join7(dir, "manifest.json"))) {
      throw new UsageError(`${name}: ${dir} has no manifest.json \u2014 name the unpacked extension's own folder, the one that holds manifest.json`);
    }
    return dir;
  });
}
function extensionArgs(dirs) {
  if (dirs.length === 0) return [];
  const list = dirs.join(",");
  return [`--load-extension=${list}`, `--disable-extensions-except=${list}`];
}
var unpackedIgnoredNote;
var init_extensions = __esm({
  "src/browser/extensions.ts"() {
    "use strict";
    init_brand();
    init_cli_kit();
    unpackedIgnoredNote = () => `Google Chrome \u2265 137 ignores unpacked extensions \u2014 use Brave (built-in ad/tracker blocking: ${envName("BROWSER_KIND")}=brave), Chromium or Chrome for Testing`;
  }
});
function browserHome() {
  return env("BROWSER_DIR") ?? brand().browserDir ?? join8(homedir2(), `.${brand().name}`, "browser");
}
function checkName(name) {
  if (!PROFILE_NAME.test(name) || name === "." || name === "..") {
    throw new UsageError(`invalid profile name ${JSON.stringify(name)} (1-64 of letters, digits, ".", "_", "-")`);
  }
}
function profileDir(name = "default") {
  checkName(name);
  return join8(browserHome(), "profiles", name);
}
function profileKindFile(name = "default") {
  return join8(profileDir(name), `.${brand().name}-kind`);
}
function readProfileKind(name = "default") {
  try {
    const kind = readFileSync7(profileKindFile(name), "utf8").trim();
    return isBrowserKind(kind) ? kind : void 0;
  } catch {
    return void 0;
  }
}
function writeProfileKind(name, kind) {
  ensurePrivateDir(profileDir(name));
  writeFileSync5(profileKindFile(name), `${kind}
`, { mode: 384 });
}
function ensurePrivateDir(path) {
  try {
    mkdirSync3(path, { recursive: true, mode: 448 });
  } catch (e) {
    if (e.code !== "EEXIST") throw e;
  }
  const st = lstatSync(path);
  if (st.isSymbolicLink()) throw new Error(`${path} is a symbolic link`);
  if (!st.isDirectory()) throw new Error(`${path} is not a directory`);
  if (typeof process.getuid === "function" && st.uid !== process.getuid()) {
    throw new Error(`${path} belongs to another user`);
  }
  if (process.platform === "win32") return;
  if (st.mode & 18) throw new Error(`${path} is writable by other users`);
  if (st.mode & 63) chmodSync(path, 448);
}
var PROFILE_NAME;
var init_profile = __esm({
  "src/browser/profile.ts"() {
    "use strict";
    init_brand();
    init_cli_kit();
    init_detect();
    PROFILE_NAME = /^[A-Za-z0-9._-]{1,64}$/;
  }
});
function checkTargetId(id) {
  if (!/^[A-Za-z0-9_-][A-Za-z0-9_.-]*$/.test(id)) throw new Error(`invalid target id: ${JSON.stringify(id)}`);
  return id;
}
function readJson2(path) {
  try {
    return JSON.parse(readFileSync8(path, "utf8"));
  } catch {
    return null;
  }
}
function writeJson(dir, name, value) {
  ensurePrivateDir(dir);
  writeFileAtomic(join9(dir, name), `${JSON.stringify(value)}
`, FILE_MODE);
}
function readSession(o) {
  const v = readJson2(join9(homeOf(o), "session.json"));
  if (!isObj(v) || v.version !== 1 || typeof v.port !== "number" || typeof v.targetId !== "string") return null;
  return v;
}
function writeSession(s, o) {
  if (isNoWrite()) return;
  writeJson(homeOf(o), "session.json", s);
}
function clearSession(o) {
  if (isNoWrite()) return;
  rmSync5(join9(homeOf(o), "session.json"), { force: true });
}
function clearRefs(targetId, o) {
  const id = targetId === void 0 ? void 0 : checkTargetId(targetId);
  if (isNoWrite()) return;
  const dir = join9(homeOf(o), "refs");
  rmSync5(id === void 0 ? dir : join9(dir, `${id}.json`), { recursive: true, force: true });
}
function clearNetwork(targetId, o) {
  const path = targetId === void 0 ? join9(homeOf(o), "network") : networkFile(targetId, o);
  if (isNoWrite()) return;
  rmSync5(path, { recursive: true, force: true });
}
function pidAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return e.code === "EPERM";
  }
}
function staleReason(path, staleMs, now) {
  let at;
  let pid;
  try {
    const held = JSON.parse(readFileSync8(path, "utf8"));
    pid = held.pid;
    at = typeof held.at === "number" ? held.at : Number.NaN;
  } catch {
    at = Number.NaN;
  }
  if (Number.isNaN(at)) {
    try {
      at = statSync5(path).mtimeMs;
    } catch {
      return "gone";
    }
  }
  if (now - at > staleMs) return "old";
  if (typeof pid === "number" && !pidAlive(pid)) return "dead";
  return null;
}
function holds(path, token) {
  try {
    const held = JSON.parse(readFileSync8(path, "utf8"));
    return held.pid === process.pid && held.token === token;
  } catch {
    return false;
  }
}
async function withBrowserLock(fn, opts = {}) {
  if (isNoWrite()) return fn();
  const { staleMs = 3e4, waitMs = 1e4, pollMs = 50 } = opts;
  const { now, sleep: sleep2 } = opts.deps ?? realDeps;
  const dir = homeOf(opts);
  ensurePrivateDir(dir);
  const path = join9(dir, "lock");
  const token = randomUUID();
  const stamp = () => JSON.stringify({ pid: process.pid, at: now(), token });
  const deadline = now() + waitMs;
  for (; ; ) {
    try {
      const fd = openSync(path, "wx", FILE_MODE);
      try {
        writeSync(fd, stamp());
      } finally {
        closeSync(fd);
      }
      break;
    } catch (e) {
      if (e.code !== "EEXIST") throw e;
    }
    if (staleReason(path, staleMs, now())) {
      try {
        unlinkSync2(path);
      } catch {
      }
      continue;
    }
    if (now() >= deadline) throw new Error(`browser busy: another webindex command holds ${path} (waited ${waitMs} ms)`);
    await sleep2(pollMs);
  }
  const beat = setInterval(
    () => {
      if (!holds(path, token)) return;
      try {
        writeFileAtomic(path, stamp(), FILE_MODE);
      } catch {
      }
    },
    Math.max(1e3, staleMs / 3)
  );
  beat.unref?.();
  try {
    return await fn();
  } finally {
    clearInterval(beat);
    try {
      if (holds(path, token)) unlinkSync2(path);
    } catch {
    }
  }
}
var FILE_MODE;
var homeOf;
var isObj;
var networkFile;
var realDeps;
var init_state = __esm({
  "src/browser/state.ts"() {
    "use strict";
    init_no_write();
    init_profile();
    FILE_MODE = 384;
    homeOf = (o) => o?.home ?? browserHome();
    isObj = (v) => typeof v === "object" && v !== null && !Array.isArray(v);
    networkFile = (targetId, o) => join9(homeOf(o), "network", `${checkTargetId(targetId)}.jsonl`);
    realDeps = {
      now: () => Date.now(),
      sleep: (ms) => new Promise((r) => setTimeout(r, ms))
    };
  }
});
async function resolveEndpoint(opts = {}) {
  const deps = browserDeps(opts.deps);
  const profile = opts.profile ?? "default";
  const headless = opts.headless ?? false;
  if (opts.cdp !== void 0) {
    let host;
    let port;
    try {
      const ep = parseCdpEndpoint(String(opts.cdp));
      host = dialHost(ep.host);
      port = ep.port;
    } catch (e) {
      throw new UsageError(e.message);
    }
    if (!await deps.discovery.isPortAlive(port, host)) throw new Error(`nothing answers DevTools on ${host}:${port}`);
    return { host, port, launchedByUs: false, profile, headless };
  }
  const saved2 = readSession();
  const usable = saved2 && (saved2.launchedByUs ? opts.profile === void 0 || saved2.profile === opts.profile : opts.profile === void 0 && !opts.ownOnly);
  if (saved2 && usable) {
    const host = saved2.host ?? "127.0.0.1";
    const same = saved2.wsBrowserUrl ? await isSameBrowser(deps, saved2.port, host, saved2.wsBrowserUrl) : !saved2.launchedByUs && await deps.discovery.isPortAlive(saved2.port, host);
    if (same) {
      return {
        host,
        port: saved2.port,
        launchedByUs: saved2.launchedByUs,
        ...saved2.pid !== void 0 ? { pid: saved2.pid } : {},
        profile: saved2.profile,
        headless: saved2.headless
      };
    }
    clearSession();
  }
  return launch(deps, opts.binary, profile, headless, opts.kind);
}
function wantedKind(deps, kind, profile) {
  if (kind) return kind;
  const asked = deps.env("BROWSER_KIND")?.trim().toLowerCase();
  if (asked && !isBrowserKind(asked)) throw new UsageError(`${envName("BROWSER_KIND")} is "${asked}", not one of chrome, brave, chromium, edge`);
  return asked && isBrowserKind(asked) ? asked : readProfileKind(profile);
}
async function launch(deps, binary, profile, headless, kind) {
  const wanted = binary ? void 0 : wantedKind(deps, kind, profile);
  const found = binary ? { kind: kindOf(binary), path: binary } : deps.detectBrowser(wanted);
  if (!found && wanted) throw new UsageError(`no ${wanted} found: install it, or name its executable with ${envName("BROWSER_BIN")}`);
  if (!found) {
    throw new Error(`no Chrome, Brave, Chromium or Edge found: install one, or set ${envName("BROWSER_BIN")} to the browser's executable`);
  }
  const bin = found.path;
  const dir = profileDir(profile);
  ensurePrivateDir(browserHome());
  ensurePrivateDir(join10(browserHome(), "profiles"));
  ensurePrivateDir(dir);
  const portFile = join10(dir, "DevToolsActivePort");
  const running = await readActivePort(deps, portFile);
  if (running && await isSameBrowser(deps, running.port, "127.0.0.1", running.path)) {
    return { host: "127.0.0.1", port: running.port, launchedByUs: true, profile, headless };
  }
  const owner = readProfileKind(profile);
  if (owner && owner !== found.kind) {
    const named = binary !== void 0 || !!deps.env("BROWSER_BIN");
    const hint = named ? `; ${envName("BROWSER_BIN")} names a ${found.kind} binary` : `, or ${owner} (\`--browser-kind ${owner}\`)`;
    throw new UsageError(
      `the profile "${profile}" belongs to ${owner} (its logins are encrypted for that browser), not ${found.kind}: use a profile of its own (\`--profile ${found.kind}\`)${hint}`
    );
  }
  const extensions = extensionDirs(deps.env("BROWSER_EXTENSIONS"));
  const dropped = extensions.length > 0 && ignoresUnpackedExtensions(found);
  await deps.fs.rm(portFile, { force: true });
  const args = [
    "--remote-debugging-port=0",
    `--user-data-dir=${dir}`,
    "--no-first-run",
    "--no-default-browser-check",
    ...dropped ? [] : extensionArgs(extensions)
  ];
  if (headless) args.push("--headless=new");
  args.push("about:blank");
  const child = deps.spawn(bin, args, { detached: true, stdio: "ignore" });
  let failure2;
  child.on("exit", (code, signal) => {
    const how = code !== null ? `code ${code}` : `signal ${signal}`;
    const hint = code === 0 ? `; is a browser already running on the profile ${dir}?` : "";
    failure2 = `the browser exited before exposing a DevTools port (${how}${hint})`;
  });
  child.on("error", (err) => {
    failure2 = `could not start ${bin}: ${err.message}`;
  });
  child.unref();
  const deadline = deps.now() + STARTUP_TIMEOUT_MS;
  for (; ; ) {
    const active22 = await readActivePort(deps, portFile);
    if (active22 && await isSameBrowser(deps, active22.port, "127.0.0.1", active22.path)) {
      const port = active22.port;
      if (!owner) {
        try {
          writeProfileKind(profile, found.kind);
        } catch {
        }
      }
      const notes = dropped ? [unpackedIgnoredNote()] : [];
      return {
        host: "127.0.0.1",
        port,
        launchedByUs: true,
        spawned: true,
        ...child.pid !== void 0 ? { pid: child.pid } : {},
        profile,
        headless,
        ...notes.length ? { notes } : {}
      };
    }
    if (failure2) throw new Error(failure2);
    if (deps.now() >= deadline) {
      child.kill("SIGTERM");
      throw new Error(`${bin} did not expose a DevTools port within ${STARTUP_TIMEOUT_MS / 1e3} s (no usable ${portFile})`);
    }
    await deps.sleep(POLL_MS);
  }
}
async function readActivePort(deps, file) {
  let text;
  try {
    text = await deps.fs.readFile(file, "utf8");
  } catch {
    return void 0;
  }
  const [first = "", second = ""] = text.split("\n");
  const port = Number(first.trim());
  const path = second.trim();
  if (!Number.isInteger(port) || port < 1 || port > 65535 || !path) return void 0;
  return { port, path };
}
function socketPath(urlOrPath) {
  try {
    return new URL(urlOrPath).pathname;
  } catch {
    return urlOrPath;
  }
}
async function isSameBrowser(deps, port, host, wsBrowserUrl) {
  try {
    const { webSocketDebuggerUrl } = await deps.discovery.getVersion(port, host);
    return socketPath(webSocketDebuggerUrl) === socketPath(wsBrowserUrl);
  } catch {
    return false;
  }
}
var STARTUP_TIMEOUT_MS;
var POLL_MS;
var init_launch = __esm({
  "src/browser/launch.ts"() {
    "use strict";
    init_brand();
    init_cli_kit();
    init_deps();
    init_detect();
    init_discovery();
    init_extensions();
    init_profile();
    init_state();
    STARTUP_TIMEOUT_MS = 2e4;
    POLL_MS = 100;
  }
});
function cleanTabs(v) {
  const out = {};
  if (typeof v !== "object" || v === null) return out;
  for (const [id, targetId] of Object.entries(v)) if (TAB_ID.test(id) && typeof targetId === "string") out[id] = targetId;
  return out;
}
function syncTabs(map, pages) {
  const live = new Set(pages.map((p) => p.id));
  let high = 0;
  const out = {};
  const kept = /* @__PURE__ */ new Set();
  for (const [id, targetId] of Object.entries(map)) {
    high = Math.max(high, tabNumber(id));
    if (live.has(targetId) && !kept.has(targetId)) {
      out[id] = targetId;
      kept.add(targetId);
    }
  }
  const unseen = pages.map((p) => p.id).filter((id) => !kept.has(id));
  for (const id of unseen.sort()) out[`t${++high}`] = id;
  return out;
}
function pick(tabs, id) {
  const tab = tabs.find((t) => t.id === id || t.targetId === id);
  if (!tab) throw new Error(`no tab ${id}: list the tabs to see their ids`);
  return tab;
}
function tabList(map, pages, current2) {
  const byId = new Map(pages.map((p) => [p.id, p]));
  return Object.entries(map).sort(([a], [b]) => tabNumber(a) - tabNumber(b)).map(([id, targetId]) => {
    const p = byId.get(targetId);
    return { id, targetId, url: p?.url ?? "", title: p?.title ?? "", active: targetId === current2 };
  });
}
function assertOpenableUrl(url) {
  const u = url.trim();
  let ok = /^about:blank$/i.test(u) || u.startsWith("#");
  if (!ok) {
    try {
      ok = /^https?:$/.test(new URL(u).protocol);
    } catch {
    }
  }
  if (!ok) throw new UsageError(`only http(s) URLs (and about:blank) can be opened \u2014 use \`${brand().cli} extract <path>\` for local files`);
}
async function createTarget(cdp) {
  const { targetId } = await cdp.send("Target.createTarget", { url: "about:blank" });
  return targetId;
}
async function attachPage(cdp, targetId) {
  const { sessionId } = await cdp.send("Target.attachToTarget", { targetId, flatten: true });
  const page = cdp.session(sessionId);
  const o = { timeoutMs: ATTACH_TIMEOUT_MS };
  try {
    await Promise.all([
      page.send("Page.enable", void 0, o),
      page.send("Runtime.enable", void 0, o),
      page.send("DOM.enable", void 0, o),
      page.send("Page.setLifecycleEventsEnabled", { enabled: true }, o)
    ]);
  } catch (e) {
    if (e instanceof CdpError || cdp.closed) throw e;
    throw new Error(
      `the tab does not answer; most likely a JavaScript dialog the page opened between commands \u2014 answer it in the window, or \`${brand().cli} browser close\``
    );
  }
  return sessionId;
}
async function closeLaunched(cdp, pid, deps) {
  try {
    await cdp.send("Browser.close", void 0, { timeoutMs: BROWSER_CLOSE_TIMEOUT_MS });
  } catch {
    if (cdp.closed || pid === void 0) return;
    try {
      deps.kill(pid, "SIGTERM");
    } catch {
    }
  }
}
function forget(targetIds, all) {
  clearSession();
  if (all) {
    clearRefs();
    clearNetwork();
    return;
  }
  for (const id of new Set(targetIds)) {
    clearRefs(id);
    clearNetwork(id);
  }
}
async function openBrowserSession(opts = {}) {
  const deps = browserDeps(opts.deps);
  const endpoint = await resolveEndpoint({ ...opts, deps });
  const saved2 = readSession();
  const same = saved2 !== null && saved2.port === endpoint.port && (saved2.host ?? "127.0.0.1") === endpoint.host ? saved2 : null;
  const { webSocketDebuggerUrl } = await deps.discovery.getVersion(endpoint.port, endpoint.host);
  const cdp = await deps.connectCdp(loopbackSocketUrl(webSocketDebuggerUrl));
  let created;
  try {
    const pages = await deps.discovery.listPages(endpoint.port, endpoint.host);
    let targetId;
    if (opts.newTab || opts.scratch) targetId = created = await createTarget(cdp);
    else if (same && pages.some((p) => p.id === same.targetId)) targetId = same.targetId;
    else targetId = pages[0]?.id ?? await createTarget(cdp);
    const sessionId = await attachPage(cdp, targetId);
    const session = new BrowserSession(cdp, endpoint, webSocketDebuggerUrl, deps, targetId, sessionId, cleanTabs(same?.tabs), opts.scratch);
    if (!opts.scratch) await session.listTabs();
    if (opts.url !== void 0) await session.navigate(opts.url);
    return session;
  } catch (e) {
    if (created !== void 0) await deps.discovery.closeTarget(endpoint.port, created, endpoint.host).catch(() => {
    });
    await cdp.close();
    throw e;
  }
}
var NAVIGATION_TIMEOUT_MS;
var BROWSER_CLOSE_TIMEOUT_MS;
var STATUS_TIMEOUT_MS;
var ATTACH_TIMEOUT_MS;
var TAB_ID;
var LIFECYCLE;
var NavigationTimeoutError;
var committedIn;
var stillLoading;
var tabNumber;
var BrowserSession;
var init_session = __esm({
  "src/browser/session.ts"() {
    "use strict";
    init_brand();
    init_cli_kit();
    init_cdp();
    init_deps();
    init_discovery();
    init_launch();
    init_profile();
    init_state();
    NAVIGATION_TIMEOUT_MS = 3e4;
    BROWSER_CLOSE_TIMEOUT_MS = 5e3;
    STATUS_TIMEOUT_MS = 2e3;
    ATTACH_TIMEOUT_MS = 5e3;
    TAB_ID = /^t([1-9]\d*)$/;
    LIFECYCLE = { load: "load", domcontentloaded: "DOMContentLoaded" };
    NavigationTimeoutError = class extends Error {
    };
    committedIn = (frameId, isNew) => (e) => e.frameId === frameId && isNew(e.loaderId) && (e.kind === "commit" || e.kind === "lifecycle" && e.name !== "init");
    stillLoading = (timeoutMs) => `still loading after ${timeoutMs} ms \u2014 take a snapshot or \`${brand().cli} browser wait --load\``;
    tabNumber = (id) => Number(TAB_ID.exec(id)?.[1] ?? 0);
    BrowserSession = class {
      /** @internal use openBrowserSession */
      constructor(cdp, endpoint, wsBrowserUrl, deps, targetId, sessionId, tabs, scratch = false) {
        this.cdp = cdp;
        this.endpoint = endpoint;
        this.wsBrowserUrl = wsBrowserUrl;
        this.deps = deps;
        this.scratch = scratch;
        this.current = { targetId, sessionId, page: cdp.session(sessionId) };
        this.tabs = tabs;
      }
      cdp;
      endpoint;
      wsBrowserUrl;
      deps;
      scratch;
      tabs;
      current;
      /** Targets closed by this session that /json/list may still report for a moment. */
      closed = /* @__PURE__ */ new Set();
      /** Dialog listeners, each bound to the current tab's session and moved with it. */
      dialogListeners = /* @__PURE__ */ new Map();
      ended = false;
      get port() {
        return this.endpoint.port;
      }
      get host() {
        return this.endpoint.host;
      }
      get launchedByUs() {
        return this.endpoint.launchedByUs;
      }
      /** Whether opening this session started the browser (not a reuse of one already running). */
      get spawned() {
        return this.endpoint.spawned === true;
      }
      /** The browser-level socket URL: its path names this run of the browser and no other. */
      get browserSocket() {
        return this.wsBrowserUrl;
      }
      get pid() {
        return this.endpoint.pid;
      }
      get profile() {
        return this.endpoint.profile;
      }
      get headless() {
        return this.endpoint.headless;
      }
      /** What the launch had to say (extensions the browser will not load), once: the next call gets nothing. */
      takeNotes() {
        const notes = this.endpoint.notes ?? [];
        this.endpoint.notes = void 0;
        return notes;
      }
      get targetId() {
        return this.current.targetId;
      }
      get sessionId() {
        return this.current.sessionId;
      }
      /** The current tab's flat session. It changes with selectTab/newTab/closeTab: read it, do not keep it. */
      get page() {
        return this.current.page;
      }
      /** Write session.json (port, ownership, current tab, tab ids). A no-op once shut down, and for a scratch tab. */
      save() {
        if (this.ended || this.scratch) return;
        const { host, port, pid, launchedByUs, profile, headless } = this.endpoint;
        writeSession({
          version: 1,
          ...host !== "127.0.0.1" ? { host } : {},
          port,
          wsBrowserUrl: this.wsBrowserUrl,
          ...pid !== void 0 ? { pid } : {},
          launchedByUs,
          profile,
          headless,
          targetId: this.targetId,
          tabs: this.tabs,
          updatedAt: this.deps.now()
        });
      }
      // --- page --------------------------------------------------------------------
      async frame() {
        const { frameTree } = await this.page.send("Page.getFrameTree");
        return frameTree.frame;
      }
      async currentUrl() {
        const f = await this.frame();
        return f.url + (f.urlFragment ?? "");
      }
      async loaderId() {
        return (await this.frame()).loaderId;
      }
      async title() {
        const { targetInfo } = await this.cdp.send("Target.getTargetInfo", { targetId: this.targetId });
        return targetInfo.title ?? "";
      }
      /** The document's HTTP status from the Navigation Timing entry; undefined when the page does not say. */
      async responseStatus() {
        try {
          const r = await this.page.send(
            "Runtime.evaluate",
            { expression: "performance.getEntriesByType('navigation')[0]?.responseStatus", returnByValue: true },
            { timeoutMs: STATUS_TIMEOUT_MS }
          );
          const v = r.result?.value;
          return typeof v === "number" && v > 0 ? v : void 0;
        } catch {
          return void 0;
        }
      }
      async loaded() {
        const f = await this.frame();
        const status = await this.responseStatus();
        return { url: f.url + (f.urlFragment ?? ""), loaderId: f.loaderId, ...status !== void 0 ? { status } : {} };
      }
      /**
       * Start recording navigation events BEFORE the command that causes them: the
       * browser may report the new document's lifecycle before it answers the
       * command itself, and an event listened for too late never comes again.
       */
      watch() {
        const page = this.page;
        const seen = [];
        let wake;
        let closed = false;
        let leaving = false;
        let cancelled = false;
        const push = (e) => {
          seen.push(e);
          wake?.();
        };
        const handlers = [
          ["Page.lifecycleEvent", (p) => push({ kind: "lifecycle", frameId: p.frameId, loaderId: p.loaderId, name: p.name })],
          ["Page.navigatedWithinDocument", (p) => push({ kind: "same-document", frameId: p.frameId })],
          // A page restored from the back/forward cache fires no lifecycle event. Any other is a new
          // document committing: in the main frame, what a navigation that has not loaded yet has got to.
          [
            "Page.frameNavigated",
            (p) => {
              if (p.type === "BackForwardCacheRestore") push({ kind: "bfcache", frameId: p.frame?.id, loaderId: p.frame?.loaderId });
              else if (p.frame && !p.frame.parentId) push({ kind: "commit", frameId: p.frame.id, loaderId: p.frame.loaderId });
            }
          ],
          ["Page.javascriptDialogOpening", (p) => leaving = p?.type === "beforeunload"],
          [
            "Page.javascriptDialogClosed",
            (p) => {
              if (leaving && p?.result === false) {
                cancelled = true;
                wake?.();
              }
              leaving = false;
            }
          ]
        ];
        for (const [method, h] of handlers) page.on(method, h);
        const offClose = this.cdp.onClose(() => {
          closed = true;
          wake?.();
        });
        return {
          stop: () => {
            for (const [method, h] of handlers) page.off(method, h);
            offClose();
          },
          /** Whether such an event has come, whatever was waited for. */
          saw: (match) => seen.some(match),
          until: (match, timeoutMs, what, cancelledWhat) => new Promise((resolve82, reject) => {
            const timer = setTimeout(() => {
              wake = void 0;
              reject(new NavigationTimeoutError(`${what} within ${timeoutMs} ms`));
            }, timeoutMs);
            wake = () => {
              const hit = seen.find(match);
              if (hit) resolve82(hit);
              else if (cancelled) reject(new Error(`${cancelledWhat} was cancelled: the page asked to confirm leaving it (beforeunload), and that was declined`));
              else if (closed) reject(new Error("the browser connection closed while waiting for the page to load"));
              else return;
              clearTimeout(timer);
              wake = void 0;
            };
            wake();
          })
        };
      }
      /**
       * Load `url` in the current tab and wait for the new document's `load` (or
       * `DOMContentLoaded`, or nothing). The tab's refs are cleared: they named
       * nodes of the document that is going away. A navigation the browser refuses
       * (`errorText`: DNS failure, refused connection…) rejects, and so does one
       * that did not even commit in time. One that committed but has not loaded
       * (a cold server, a render-blocking script that holds even DOMContentLoaded)
       * is the page now, still loading: it resolves, with a `note`.
       */
      async navigate(url, opts = {}) {
        assertOpenableUrl(url);
        const waitUntil = opts.waitUntil ?? "load";
        const timeoutMs = opts.timeoutMs ?? NAVIGATION_TIMEOUT_MS;
        const nav = this.watch();
        try {
          const r = await this.page.send("Page.navigate", { url }, { timeoutMs });
          if (r.errorText) throw new Error(`navigation to ${url} failed: ${r.errorText}`);
          if (!r.loaderId) {
            const f = await this.frame();
            return { url: f.url + (f.urlFragment ?? ""), loaderId: f.loaderId };
          }
          clearRefs(this.targetId);
          if (waitUntil === "none") return { url, loaderId: r.loaderId };
          const name = LIFECYCLE[waitUntil];
          try {
            await nav.until(
              (e) => e.kind === "lifecycle" && e.name === name && e.loaderId === r.loaderId,
              timeoutMs,
              `navigation to ${url} did not reach ${name}`,
              `navigation to ${url}`
            );
          } catch (e) {
            if (!(e instanceof NavigationTimeoutError) || !nav.saw(committedIn(r.frameId, (l) => l === r.loaderId))) throw e;
            return { ...await this.loaded(), note: stillLoading(timeoutMs) };
          }
          return await this.loaded();
        } finally {
          nav.stop();
        }
      }
      /**
       * Run a history move or a reload and wait until the main frame shows another
       * document (or the same one, scrolled). One that committed but has not loaded
       * in time resolves with a `note`, as in navigate.
       */
      async settle(what, trigger, timeoutMs = NAVIGATION_TIMEOUT_MS) {
        const before = await this.frame();
        const nav = this.watch();
        try {
          await trigger(timeoutMs);
          const isNew = (l) => l !== before.loaderId;
          let hit;
          try {
            hit = await nav.until(
              (e) => e.frameId === before.id && (e.kind === "same-document" || e.kind === "bfcache" || e.kind === "lifecycle" && e.name === "load" && isNew(e.loaderId)),
              timeoutMs,
              `${what} did not reach load`,
              what
            );
          } catch (e) {
            if (!(e instanceof NavigationTimeoutError) || !nav.saw(committedIn(before.id, isNew))) throw e;
            clearRefs(this.targetId);
            return { ...await this.loaded(), note: stillLoading(timeoutMs) };
          }
          if (hit.kind !== "same-document") clearRefs(this.targetId);
          return await this.loaded();
        } finally {
          nav.stop();
        }
      }
      async history(step, timeoutMs) {
        const h = await this.page.send("Page.getNavigationHistory");
        const entry = h.entries[h.currentIndex + step];
        if (!entry) throw new Error(step < 0 ? "no previous page in this tab's history" : "no next page in this tab's history");
        return this.settle(
          step < 0 ? "going back" : "going forward",
          (t) => this.page.send("Page.navigateToHistoryEntry", { entryId: entry.id }, { timeoutMs: t }),
          timeoutMs
        );
      }
      back(opts = {}) {
        return this.history(-1, opts.timeoutMs);
      }
      forward(opts = {}) {
        return this.history(1, opts.timeoutMs);
      }
      reload(opts = {}) {
        return this.settle("reloading", (t) => this.page.send("Page.reload", void 0, { timeoutMs: t }), opts.timeoutMs);
      }
      // --- tabs --------------------------------------------------------------------
      /** The browser's tabs with their stable short ids; the map is refreshed and saved. */
      async listTabs() {
        const pages = (await this.deps.discovery.listPages(this.port, this.host)).filter((p) => !this.closed.has(p.id));
        this.tabs = syncTabs(this.tabs, pages);
        this.save();
        return tabList(this.tabs, pages, this.targetId);
      }
      /**
       * Hear the JavaScript dialogs of whichever tab is current, across tab
       * switches, each with the page session that can answer it. Returns its unsubscribe.
       */
      onDialog(listener) {
        this.hookDialogs(listener, this.page);
        return () => {
          const h = this.dialogListeners.get(listener);
          if (h) this.page.off("Page.javascriptDialogOpening", h);
          this.dialogListeners.delete(listener);
        };
      }
      hookDialogs(listener, page) {
        const h = (p) => listener({ type: String(p?.type ?? "alert"), message: String(p?.message ?? ""), ...typeof p?.url === "string" ? { url: p.url } : {} }, page);
        page.on("Page.javascriptDialogOpening", h);
        this.dialogListeners.set(listener, h);
      }
      /** Move this session onto another tab: attach to it, let go of the old one, bring it to the front. */
      async switchTo(targetId) {
        const old = this.current.sessionId;
        const sessionId = await attachPage(this.cdp, targetId);
        const oldPage = this.current.page;
        this.current = { targetId, sessionId, page: this.cdp.session(sessionId) };
        for (const [listener, h] of [...this.dialogListeners]) {
          oldPage.off("Page.javascriptDialogOpening", h);
          this.hookDialogs(listener, this.current.page);
        }
        await this.cdp.send("Target.detachFromTarget", { sessionId: old }).catch(() => {
        });
        await this.deps.discovery.activateTarget(this.port, targetId, this.host);
        this.save();
      }
      async selectTab(id) {
        const tab = pick(await this.listTabs(), id);
        await this.switchTo(tab.targetId);
        return { ...tab, active: true };
      }
      /** Open a tab, make it current and, given a url, load it. */
      async newTab(url, opts = {}) {
        if (url !== void 0) assertOpenableUrl(url);
        const targetId = await createTarget(this.cdp);
        try {
          await this.switchTo(targetId);
        } catch (e) {
          await this.deps.discovery.closeTarget(this.port, targetId, this.host).catch(() => {
          });
          throw e;
        }
        if (url !== void 0) await this.navigate(url, opts);
        return pick(await this.listTabs(), targetId);
      }
      /**
       * Close a tab and forget its refs and network log. Closing the current tab
       * moves to another one first; closing the last opens a blank one, since a
       * browser left with no tab may quit.
       */
      async closeTab(id) {
        const tabs = await this.listTabs();
        const tab = pick(tabs, id);
        if (tab.targetId === this.targetId) {
          const next = tabs.find((t) => t.targetId !== tab.targetId);
          await this.switchTo(next ? next.targetId : await createTarget(this.cdp));
        }
        await this.deps.discovery.closeTarget(this.port, tab.targetId, this.host);
        this.closed.add(tab.targetId);
        clearRefs(tab.targetId);
        clearNetwork(tab.targetId);
        await this.listTabs();
      }
      // --- lifetime ------------------------------------------------------------------
      /** Close the socket only. The browser and its tabs keep running; the next call reconnects. */
      async detach() {
        await this.cdp.close();
      }
      /**
       * End the session. A browser we launched is closed (`Browser.close`, then
       * SIGTERM to its pid if it refuses); one we attached to is left running. Either
       * way session.json and our tabs' refs and network logs go (every tab's with `all`).
       */
      async shutdown(opts = {}) {
        this.ended = true;
        if (this.launchedByUs) await closeLaunched(this.cdp, this.pid, this.deps);
        await this.cdp.close();
        forget([this.targetId, ...Object.values(this.tabs)], opts.all);
      }
      async status() {
        const tabs = await this.listTabs();
        const cur = tabs.find((t) => t.active);
        return {
          alive: true,
          port: this.port,
          launchedByUs: this.launchedByUs,
          profile: this.profile,
          headless: this.headless,
          targetId: this.targetId,
          url: cur?.url ?? "",
          title: cur?.title ?? "",
          tabs
        };
      }
    };
  }
});
var AMBIGUOUS_TYPES;
var init_mime = __esm({
  "src/mime.ts"() {
    "use strict";
    AMBIGUOUS_TYPES = /* @__PURE__ */ new Set([
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
  }
});
function bomEncoding(bytes) {
  if (bytes.length >= 3 && bytes[0] === 239 && bytes[1] === 187 && bytes[2] === 191) return { encoding: "utf-8", skip: 3 };
  if (bytes.length >= 2 && bytes[0] === 255 && bytes[1] === 254) return { encoding: "utf-16le", skip: 2 };
  if (bytes.length >= 2 && bytes[0] === 254 && bytes[1] === 255) return { encoding: "utf-16be", skip: 2 };
  return void 0;
}
function charsetFromContentType(contentType) {
  return CHARSET_IN_CONTENT_TYPE.exec(contentType ?? "")?.[1]?.toLowerCase();
}
function prescanLabel(label) {
  const lower = label.toLowerCase();
  if (UTF16_LABELS.has(lower)) return "utf-8";
  return lower === "x-user-defined" ? "windows-1252" : lower;
}
function metaAttributes(tag2) {
  const attrs = /* @__PURE__ */ new Map();
  for (const m of tag2.slice(5).matchAll(TAG_ATTRIBUTE)) {
    const value = m[2] ?? m[3] ?? m[4];
    const name = m[1].toLowerCase();
    if (value !== void 0 && !attrs.has(name)) attrs.set(name, value);
  }
  return attrs;
}
function charsetFromHtml(head) {
  for (const [tag2] of head.slice(0, 4096).matchAll(META_TAG)) {
    const attrs = metaAttributes(tag2);
    const direct = attrs.get("charset")?.trim();
    if (direct) return prescanLabel(direct);
    if (attrs.get("http-equiv")?.trim().toLowerCase() !== "content-type") continue;
    const pragma = charsetFromContentType(attrs.get("content") ?? "");
    if (pragma) return prescanLabel(pragma);
  }
  return void 0;
}
function charsetFromXmlDeclaration(bytes) {
  const label = XML_DECLARATION.exec(bytes.subarray(0, 256).toString("latin1"))?.[1];
  return label ? prescanLabel(label) : void 0;
}
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
var CHARSET_IN_CONTENT_TYPE;
var UTF16_LABELS;
var META_TAG;
var TAG_ATTRIBUTE;
var XML_DECLARATION;
var isUtf8Label;
var SNIFFABLE_MIME;
var CP1252_C1;
var CP1252_LABELS;
var CP1252_C1_RANGE;
var cp1252C1;
var init_charset = __esm({
  "src/charset.ts"() {
    "use strict";
    init_mime();
    CHARSET_IN_CONTENT_TYPE = /charset\s*=\s*["']?([a-z0-9_:.+-]+)/i;
    UTF16_LABELS = /* @__PURE__ */ new Set(["utf-16", "utf-16le", "utf-16be", "unicode", "unicodefeff", "unicodefffe", "ucs-2", "csunicode", "iso-10646-ucs-2"]);
    META_TAG = /<meta\b(?:[^>"']|"[^"]*(?:"|$)|'[^']*(?:'|$))*(?:>|$)/gi;
    TAG_ATTRIBUTE = /([^\s"'<>/=]+)(?:\s*=\s*(?:"([^"]*)(?:"|$)|'([^']*)(?:'|$)|([^\s"'=<>`]+)))?/g;
    XML_DECLARATION = /^\s*<\?xml\b[^>]*?\bencoding\s*=\s*["']([A-Za-z0-9._:-]+)["']/;
    isUtf8Label = (label) => label === "utf-8" || label === "utf8";
    SNIFFABLE_MIME = /* @__PURE__ */ new Set(["text/html", "application/xhtml+xml", ...AMBIGUOUS_TYPES]);
    CP1252_C1 = [
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
    CP1252_LABELS = /* @__PURE__ */ new Set([
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
    CP1252_C1_RANGE = /[\x80-\x9f]/g;
    cp1252C1 = (c) => String.fromCharCode(CP1252_C1[c.charCodeAt(0) - 128]);
  }
});
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
var NAMED;
var INVISIBLE;
var charFor;
var ENTITY_BY_NAME;
var ENTITY_RE;
var init_entities = __esm({
  "src/entities.ts"() {
    "use strict";
    init_charset();
    NAMED = `
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
    INVISIBLE = /* @__PURE__ */ new Set([173, 8203, 8204, 8205, 8206, 8207, 8288, 65279]);
    charFor = (cp) => INVISIBLE.has(cp) ? "" : String.fromCodePoint(cp);
    ENTITY_BY_NAME = /* @__PURE__ */ new Map();
    {
      const parts = NAMED.trim().split(/\s+/);
      for (let i = 0; i < parts.length; i += 2) ENTITY_BY_NAME.set(parts[i], charFor(Number.parseInt(parts[i + 1], 16)));
      ENTITY_BY_NAME.set("nbsp", " ");
    }
    ENTITY_RE = /&(#[xX][0-9a-fA-F]+|#\d+|[a-zA-Z][a-zA-Z0-9]*);/g;
  }
});
function closeTagRe(name) {
  let re = CLOSE_TAG_RE.get(name);
  if (!re) CLOSE_TAG_RE.set(name, re = new RegExp(`</${name}\\s*>`, "gi"));
  return re;
}
function htmlAttributes(tag2) {
  const attrs = /* @__PURE__ */ new Map();
  for (const m of tag2.matchAll(/(?<![^\s"'<>/=])([^\s"'<>/=]+)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+))/g)) {
    const name = m[1].toLowerCase();
    if (!attrs.has(name)) attrs.set(name, m[2] ?? m[3] ?? m[4] ?? "");
  }
  return attrs;
}
function dropElements(html, names, toEof = /* @__PURE__ */ new Set()) {
  const drop = new Set(names);
  const open2 = new RegExp(`<!--|${TAG_RE.source}|<(${names.join("|")})(?=[\\s/>])`, "gi");
  const unclosed = /* @__PURE__ */ new Set();
  let out = "";
  let last = 0;
  let m;
  while (m = open2.exec(html)) {
    const tag2 = m[0];
    const name = m[1]?.toLowerCase() ?? (tag2 === "<!--" ? "!--" : tag2[1] === "/" ? "" : tagName(tag2));
    const opaque = !drop.has(name) && RCDATA_ELEMENTS.has(name);
    if (name !== "!--" && !drop.has(name) && !opaque || unclosed.has(name)) continue;
    let end;
    if (name === "!--") {
      const close = html.indexOf("-->", m.index + 2);
      end = close < 0 ? -1 : close + 3;
    } else {
      const close = closeTagRe(name);
      close.lastIndex = open2.lastIndex;
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
    open2.lastIndex = end;
  }
  return last === 0 ? html : out + html.slice(last);
}
function balancedRegions(html, tag2, isCandidate) {
  const re = new RegExp(`<${tag2}(?=[\\s/>])(?:[^<>"']|"[^"]*"|'[^']*')*>|</${tag2}\\s*>`, "gi");
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
  const regions = [...names].flatMap((name) => balancedRegions(html, name, (open2) => hasRole.test(open2))).sort((a, b) => a.from - b.from);
  let out = "";
  let last = 0;
  for (const r of regions) {
    if (r.from < last) continue;
    out += `${html.slice(last, r.from)} `;
    last = r.to;
  }
  return last === 0 ? html : out + html.slice(last);
}
var BLOCK_TAGS;
var INLINE_TAGS;
var TAG_RE;
var LOOSE_TAG_RE;
var tagName;
var CLOSE_TAG_RE;
var RCDATA_ELEMENTS;
var CHROME_ROLES;
var HIDDEN_ELEMENTS;
var CHROME_ELEMENTS;
var RAW_TEXT_ELEMENTS;
var init_html = __esm({
  "src/html.ts"() {
    "use strict";
    BLOCK_TAGS = /* @__PURE__ */ new Set([
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
    INLINE_TAGS = /* @__PURE__ */ new Set([
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
    TAG_RE = /<[a-zA-Z!/?][^<>"']*(?:(?:"[^"]*"|'[^']*')[^<>"']*)*>/g;
    LOOSE_TAG_RE = /<[a-zA-Z!/?][^<>]*>/g;
    tagName = (tag2) => /^<\/?([a-zA-Z][^\s/>]*)/.exec(tag2)?.[1]?.toLowerCase() ?? "";
    CLOSE_TAG_RE = /* @__PURE__ */ new Map();
    RCDATA_ELEMENTS = /* @__PURE__ */ new Set(["title"]);
    CHROME_ROLES = ["navigation", "banner", "contentinfo"];
    HIDDEN_ELEMENTS = ["script", "style", "noscript", "head", "svg", "template", "select", "datalist"];
    CHROME_ELEMENTS = ["nav", "footer"];
    RAW_TEXT_ELEMENTS = /* @__PURE__ */ new Set(["script", "style"]);
  }
});
function retryDelayMs(retryAfterMs) {
  if (retryAfterMs === void 0) return defaultRetryMs();
  return retryAfterMs <= RETRY_AFTER_CAP_MS ? retryAfterMs : void 0;
}
function isPermanentFailure(e) {
  const err = e;
  const code = err?.cause?.code ?? err?.code;
  if (typeof code === "string" && PERMANENT_CODES.has(code)) return true;
  return [err?.message, err?.cause?.message].some((m) => typeof m === "string" && PERMANENT_MESSAGE.test(m));
}
var maxAttempts;
var defaultRetryMs;
var RETRY_AFTER_CAP_MS;
var PERMANENT_CODES;
var PERMANENT_MESSAGE;
var init_retry = __esm({
  "src/retry.ts"() {
    "use strict";
    init_brand();
    maxAttempts = () => envInt("MAX_ATTEMPTS", 2, 1, 5);
    defaultRetryMs = () => envInt("RETRY_MS", 600, 0, 5e3);
    RETRY_AFTER_CAP_MS = 5e3;
    PERMANENT_CODES = /* @__PURE__ */ new Set([
      "ENOTFOUND",
      "ERR_INVALID_URL",
      "ERR_TLS_CERT_ALTNAME_INVALID",
      "CERT_HAS_EXPIRED",
      "DEPTH_ZERO_SELF_SIGNED_CERT",
      "SELF_SIGNED_CERT_IN_CHAIN",
      "UNABLE_TO_VERIFY_LEAF_SIGNATURE",
      "UNABLE_TO_GET_ISSUER_CERT_LOCALLY"
    ]);
    PERMANENT_MESSAGE = /redirect count exceeded|scheme must be|unknown scheme|bad port|invalid url|failed to parse url/i;
  }
});
function fragmentText(html) {
  return decodeEntities(html.replace(TAG_RE, (tag2) => INLINE_TAGS.has(tagName(tag2)) ? "" : " ").replace(LOOSE_TAG_RE, " "));
}
function spanAttr(attrs, name) {
  const n = Number.parseInt(attrs.get(name) ?? "", 10);
  return Number.isFinite(n) && n >= 1 ? Math.min(n, 100) : 1;
}
function expand(rows) {
  const grid = rows.map(() => []);
  let slots = 0;
  for (let r = 0; r < rows.length; r++) {
    const out = grid[r];
    let c = 0;
    for (const cell22 of rows[r]) {
      while (out[c] !== void 0) c++;
      const down = Math.min(cell22.rowspan, rows.length - r);
      slots += down * cell22.colspan;
      if (slots > MAX_SLOTS) return void 0;
      for (let j = 0; j < down; j++) for (let i = 0; i < cell22.colspan; i++) grid[r + j][c + i] = cell22.text;
      c += cell22.colspan;
    }
  }
  const width = grid.reduce((w, row) => Math.max(w, row.length), 0);
  if (width * grid.length > MAX_SLOTS) return void 0;
  return grid.map((row) => Array.from({ length: width }, (_, i) => row[i] ?? ""));
}
function extractTables(html) {
  const src = dropElements(html, NOT_RENDERED, RAW_TEXT_ELEMENTS);
  const tag2 = /<(\/?)(table|caption|thead|tbody|tfoot|tr|td|th)(?=[\s/>])(?:[^<>"']|"[^"]*"|'[^']*')*>/gi;
  const done = [];
  const stack = [];
  let order = 0;
  let last = 0;
  let buried = 0;
  let m;
  while (m = tag2.exec(src)) {
    const top = stack[stack.length - 1];
    if (top) top.text(src.slice(last, m.index));
    last = tag2.lastIndex;
    const closing2 = m[1] === "/";
    const name = m[2].toLowerCase();
    if (top && (buried || name === "table" && !closing2 && stack.length >= MAX_DEPTH)) {
      if (name === "table") buried += closing2 ? -1 : 1;
      top.text(" ");
      continue;
    }
    if (name === "table") {
      if (!closing2) stack.push(new OpenTable(order++));
      else if (top) closeTable(stack, done);
      continue;
    }
    if (!top) continue;
    if (name === "td" || name === "th") {
      if (closing2) top.endCell();
      else top.startCell(name === "th", htmlAttributes(m[0]));
    } else if (name === "tr") {
      top.endRow();
      if (!closing2) top.startRow();
    } else if (name === "caption") {
      top.endRow();
      top.inCaption = !closing2;
    } else {
      top.endRow();
      top.inHead = name === "thead" && !closing2;
    }
  }
  while (stack.length) closeTable(stack, done);
  return done.sort((a, b) => a.order - b.order).map((d) => d.table);
}
function closeTable(stack, done) {
  const t = stack.pop();
  t.endRow();
  const caption = collapse(t.caption.join(""));
  const table = buildTable(t.rows, caption);
  if (table) done.push({ order: t.order, table });
  const flat2 = [caption, ...t.rows.flatMap((r) => r.cells.map((c) => c.text))].filter(Boolean).join(" ");
  stack[stack.length - 1]?.nested(flat2);
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
var collapse;
var MAX_SLOTS;
var NOT_RENDERED;
var MAX_DEPTH;
var OpenTable;
var init_tables = __esm({
  "src/tables.ts"() {
    "use strict";
    init_entities();
    init_html();
    collapse = (s) => s.replace(/\s+/g, " ").trim();
    MAX_SLOTS = 1e6;
    NOT_RENDERED = ["script", "style", "template", "svg", "select", "datalist"];
    MAX_DEPTH = 8;
    OpenTable = class {
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
  }
});
function markdownAgainst(html, base2, fullPage) {
  const src = withoutNul(html);
  const hidden = fullPage ? HIDDEN_ELEMENTS : [...HIDDEN_ELEMENTS, ...CHROME_ELEMENTS];
  let s = dropElements(src, hidden, RAW_TEXT_ELEMENTS);
  if (!fullPage) s = dropLandmarks(s, CHROME_ROLES);
  const tables = /* @__PURE__ */ new Map();
  if (TABLE_OPEN.test(s)) for (const r of balancedRegions(s, "table", () => true)) tables.set(r.from, r);
  const w = new Writer();
  const tag2 = new RegExp(TAG_RE.source, "g");
  const headingEdge = new RegExp(HEADING_EDGE.source, "gi");
  let preUnclosed = false;
  let headingEnd = -1;
  const divs = [];
  let divOverflow = 0;
  let prevAEnd = -1;
  let last = 0;
  let m;
  while (m = tag2.exec(s)) {
    if (m.index > last) w.text(s.slice(last, m.index));
    last = tag2.lastIndex;
    const t = m[0];
    const closing2 = t[1] === "/";
    const name = tagName(t);
    const adjacentLinks = name === "a" && !closing2 && m.index === prevAEnd;
    prevAEnd = name === "a" && closing2 ? tag2.lastIndex : -1;
    if (!name) continue;
    if (name === "div") {
      if (closing2) {
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
        if (closing2) continue;
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
      if (closing2) continue;
      w.heading = heading;
      headingEdge.lastIndex = tag2.lastIndex;
      const edge = headingEdge.exec(s);
      headingEnd = edge && edge[0][1] === "/" ? edge.index : -1;
      continue;
    }
    if (name === "pre" && !closing2 && !preUnclosed) {
      const close = closeTagRe("pre");
      close.lastIndex = tag2.lastIndex;
      const c = close.exec(s);
      if (c) {
        w.flush();
        w.codeBlock(s.slice(tag2.lastIndex, c.index), codeLanguage(t, s.slice(tag2.lastIndex, c.index), divs));
        last = tag2.lastIndex = c.index + c[0].length;
        continue;
      }
      preUnclosed = true;
    }
    if (name === "table" && !closing2) {
      const region = tables.get(m.index);
      const table = region && !isLayoutTable(t, s, region) ? extractTables(s.slice(region.from, region.to))[0] : void 0;
      if (region && table) {
        w.flush();
        const escaped = {
          ...table.caption ? { caption: escapeText(table.caption) } : {},
          headers: table.headers.map((cell22) => escapeText(cell22)),
          rows: table.rows.map((row) => row.map((cell22) => escapeText(cell22)))
        };
        w.block(tableToMarkdown(escaped).split("\n"));
        last = tag2.lastIndex = region.to;
        continue;
      }
    }
    switch (name) {
      case "ul":
      case "ol":
        w.flush();
        if (closing2) w.closeList();
        else w.openList(name === "ol", listStart(t));
        continue;
      case "li":
        w.flush();
        if (closing2) w.closeItem();
        else w.openItem();
        continue;
      case "blockquote":
        w.flush();
        if (closing2) w.closeQuote();
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
      if (closing2) {
        w.close(kind);
        continue;
      }
      if (adjacentLinks) w.space();
      if (kind === "a") {
        w.close("a");
        const href = htmlAttributes(t).get("href");
        w.open("a", linkTarget(href, base2), href?.trimStart().startsWith("#"));
      } else w.open(kind);
      continue;
    }
    if (BLOCK_TAGS.has(name)) w.flush();
    else if (!INLINE_TAGS.has(name)) w.space();
  }
  if (last < s.length) w.text(s.slice(last));
  return w.finish();
}
function withoutNul(html) {
  return html.includes(NUL) ? html.split(NUL).join("\uFFFD") : html;
}
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
function codeLanguage(pre, inner2, divs) {
  const code = /^\s*(<code(?=[\s/>])[^<>]*>)/i.exec(inner2)?.[1];
  for (const t of [pre, code, divs[divs.length - 1], divs[divs.length - 2]]) {
    if (!t) continue;
    const lang = LANGUAGE_CLASS.exec(htmlAttributes(t).get("class") ?? "")?.[1]?.toLowerCase();
    if (lang && !NO_LANGUAGE.has(lang)) return lang;
  }
  return "";
}
function isLayoutTable(open2, html, region) {
  if (/^(?:presentation|none)$/i.test(htmlAttributes(open2).get("role")?.trim() ?? "")) return true;
  const inner2 = new RegExp(LAYOUT_INSIDE.source, "gi");
  inner2.lastIndex = region.start;
  const next = inner2.exec(html);
  return next !== null && next.index < region.end;
}
function listStart(open2) {
  const n = Number.parseInt(htmlAttributes(open2).get("start") ?? "", 10);
  return Number.isFinite(n) && n >= 0 && n < 1e9 ? n : 1;
}
var NUL;
var TABLE_OPEN;
var HEADING_EDGE;
var MAX_BLOCK_DEPTH;
var MAX_INLINE_DEPTH;
var INLINE_KIND;
var Writer;
var FLANK_PUNCT;
var FLANK_WORD;
var MARKUP_CHARS;
var PERMALINK_TEXT;
var HTML_SPACE;
var ALWAYS_SYNTAX;
var EDGE_UNDERSCORE;
var HTML_LIKE;
var ENTITY_LIKE;
var STRIKE;
var OPEN_END;
var UNFOLLOWABLE;
var BASE_TAG;
var LANGUAGE_CLASS;
var NO_LANGUAGE;
var LAYOUT_INSIDE;
var init_markdown2 = __esm({
  "src/markdown.ts"() {
    "use strict";
    init_entities();
    init_html();
    init_tables();
    NUL = "\0";
    TABLE_OPEN = /<table[\s/>]/i;
    HEADING_EDGE = /<\/h[1-6]\s*>|<h[1-6](?=[\s/>])/;
    MAX_BLOCK_DEPTH = 24;
    MAX_INLINE_DEPTH = 16;
    INLINE_KIND = {
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
    Writer = class {
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
        const candidates2 = [attrs.get("src"), attrs.get("data-src"), attrs.get("data-original"), attrs.get("srcset")?.trim().split(/\s+/)[0]];
        const src = candidates2.map((c) => linkTarget(c, base2)).find((u) => u !== void 0);
        const pixel = ["width", "height"].some((d) => /^[01]$/.test(attrs.get(d)?.trim() ?? ""));
        if (!src || pixel || this.inCode()) {
          this.space();
          return;
        }
        const alt = decodeEntities(attrs.get("alt") ?? "").replace(HTML_SPACE, " ").trim();
        this.push(`![${escapeText(alt)}](${destination(src)})`);
      }
      codeBlock(inner2, lang) {
        const body = decodeEntities(inner2.replace(/<br\s*\/?>/gi, "\n").replace(LOOSE_TAG_RE, "")).replace(/\r\n?/g, "\n").replace(/^\n/, "").trimEnd();
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
        const open2 = this.frames.map((f) => ({ ...f }));
        while (this.frames.length) this.wrap(this.frames.pop());
        const text = this.parts.join("");
        this.parts = [];
        this.flanked = void 0;
        this.pendingSpace = false;
        this.frames = open2.map((f) => ({ ...f, start: 0 }));
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
    FLANK_PUNCT = /[\p{P}\p{S}]/u;
    FLANK_WORD = /[^\s\p{P}\p{S}]/u;
    MARKUP_CHARS = "\\*`[]";
    PERMALINK_TEXT = /^(?:¶|#|§|🔗)$/u;
    HTML_SPACE = /[ \t\n\r\f]+/g;
    ALWAYS_SYNTAX = /[\\`*[\]]/g;
    EDGE_UNDERSCORE = /(?<![\p{L}\p{N}])_|_(?![\p{L}\p{N}])/gu;
    HTML_LIKE = /<(?=[a-zA-Z/!?])/g;
    ENTITY_LIKE = /&(?=#?[a-zA-Z0-9]+;)/g;
    STRIKE = /~(?=~)|(?<=[^\t\n\f\r\p{Zs}])~/gu;
    OPEN_END = /(?:<|&#?[a-zA-Z0-9]*)$/;
    UNFOLLOWABLE = /^(?:javascript|vbscript|data):/i;
    BASE_TAG = /<base(?=[\s/>])[^<>"']*(?:(?:"[^"]*"|'[^']*')[^<>"']*)*>/gi;
    LANGUAGE_CLASS = /(?:^|\s)(?:(?:language|lang|highlight(?:-source)?)-|brush:\s*)([\w+#.-]+)/i;
    NO_LANGUAGE = /* @__PURE__ */ new Set(["none", "nohighlight", "plaintext"]);
    LAYOUT_INSIDE = /<(?:table|pre)[\s/>]/;
  }
});
function parseTag(tag2) {
  const parts = (tag2 || "en").trim().replace(/[.@].*$/, "").split(/[-_]/);
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
function acceptLanguageHeader(lang, region) {
  const l = baseLang3(lang);
  const r = resolveRegion(lang, region);
  if (r === NO_REGION) return l === "en" ? "en" : `${l},en;q=0.5`;
  const R = r.toUpperCase();
  if (l === "en") return `${l}-${R},${l};q=0.9`;
  return `${l}-${R},${l};q=0.9,en;q=0.5`;
}
var LANG_COUNTRY;
var SCRIPT_COUNTRY;
var REGION_ALIASES;
var DDG_LANG_ALIASES;
var DDG_KL;
var NO_REGION;
var init_locale = __esm({
  "src/locale.ts"() {
    "use strict";
    LANG_COUNTRY = {
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
    SCRIPT_COUNTRY = {
      "zh-hant": "tw",
      "zh-hans": "cn"
    };
    REGION_ALIASES = {
      gb: "uk",
      en: "us",
      "419": "xl",
      si: "sl"
    };
    DDG_LANG_ALIASES = {
      nb: "no",
      // Bokmål
      nn: "no",
      // Nynorsk
      ja: "jp",
      ko: "kr",
      fil: "tl"
    };
    DDG_KL = {
      ar: "xa-ar",
      ca: "ct-ca",
      "zh-tw": "tw-tzh",
      "zh-hk": "hk-tzh",
      "es-us": "ue-es"
    };
    NO_REGION = "wt";
  }
});
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
function mapScrapeResponse(json2) {
  if (!json2 || typeof json2 !== "object" || Array.isArray(json2)) return null;
  if (json2.success === false) return null;
  const data = json2.data;
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
function mapSearchResponse(json2) {
  if (!json2 || typeof json2 !== "object") return [];
  if (json2.success === false) return [];
  const data = json2.data;
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
var FIRECRAWL_DEFAULT_BASE;
var PROBE_TIMEOUT_MS2;
var SCRAPE_TIMEOUT_MS;
var SEARCH_TIMEOUT_MS;
var SERVER_MARGIN_MS;
var SCRAPE_MAX_AGE_MS;
var PROBE_DOWN_TTL_MS;
var ProbeMemo;
var probeCache;
var prefixCache;
var init_firecrawl = __esm({
  "src/firecrawl.ts"() {
    "use strict";
    init_brand();
    init_fetch();
    init_locale();
    FIRECRAWL_DEFAULT_BASE = "http://localhost:3002";
    PROBE_TIMEOUT_MS2 = 2e3;
    SCRAPE_TIMEOUT_MS = 45e3;
    SEARCH_TIMEOUT_MS = 3e4;
    SERVER_MARGIN_MS = { scrape: 5e3, search: 2e3 };
    SCRAPE_MAX_AGE_MS = 24 * 60 * 60 * 1e3;
    PROBE_DOWN_TTL_MS = 3e4;
    ProbeMemo = class {
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
    probeCache = new ProbeMemo();
    prefixCache = /* @__PURE__ */ new Map();
  }
});
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
var JUNK_PATTERNS;
var init_junk = __esm({
  "src/junk.ts"() {
    "use strict";
    JUNK_PATTERNS = [
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
  }
});
function browserFetchMode(explicit) {
  const m = (explicit ?? env("BROWSER_FETCH"))?.toLowerCase();
  return m === "always" || m === "fallback" ? m : "off";
}
function worthRendering(res) {
  if (RENDER_STATUS.has(res.status)) return res.status ? `got HTTP ${res.status}` : "got no answer";
  if (res.status < 200 || res.status >= 300) return void 0;
  const junk = looksLikeJunkExtraction(res.text);
  if (junk) return `read a ${junk}`;
  return res.text.trim().length < 200 ? "found almost no text" : void 0;
}
var RENDER_STATUS;
var init_mode = __esm({
  "src/browser/mode.ts"() {
    "use strict";
    init_brand();
    init_junk();
    RENDER_STATUS = /* @__PURE__ */ new Set([0, 401, 403, 429, 503]);
  }
});
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
  return new Promise((resolve82) => {
    if (signal?.aborted) return resolve82();
    const done = () => {
      clearTimeout(t);
      signal?.removeEventListener("abort", done);
      resolve82();
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
  const read3 = await readCappedBytes(res, max + 1);
  const bytes = read3.subarray(0, max);
  return { bytes, bytesRead: bytes.length, truncated: read3.length > max };
}
function isBinaryDocument(contentType) {
  return /application\/pdf/i.test(contentType) || docFormatForContentType(contentType) !== void 0;
}
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
async function authorizedGet(url, init, authorize) {
  let target = url;
  const fail2 = (error, redirectFailed) => ({
    failure: { ok: false, status: 0, body: "", contentType: "", url: target, error, ...redirectFailed ? { redirectFailed } : {} }
  });
  const headers = { ...init.headers };
  for (let redirects = 0; ; redirects++) {
    try {
      if (!await authorize(target)) return fail2(`URL not authorized: ${target}`);
    } catch (e) {
      return fail2(`URL authorization failed for ${target}: ${e.message}`);
    }
    const response = await fetch(target, { ...init, headers, redirect: "manual" });
    const location = response.headers.get("location");
    if (!REDIRECT_STATUS.has(response.status) || !location) return { response };
    await response.body?.cancel().catch(() => {
    });
    if (redirects >= 20) return fail2("Too many redirects (maximum 20)", true);
    try {
      const next = new URL(location, target);
      if (!/^https?:$/.test(next.protocol)) return fail2(`Unsupported redirect protocol: ${next.protocol}`, true);
      if (next.origin !== new URL(target).origin) {
        delete headers.authorization;
        delete headers.cookie;
        delete headers["proxy-authorization"];
      }
      target = next.href;
    } catch {
      return fail2(`Invalid redirect URL from ${target}`, true);
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
function cleanInline(s) {
  const text = decodeEntities(String(s));
  const opened = /* @__PURE__ */ new Set();
  const closed = /* @__PURE__ */ new Set();
  for (const m of text.matchAll(INLINE_FORMAT_TAG)) (m[1] ? closed : opened).add(m[2].toLowerCase());
  return text.replace(INLINE_FORMAT_TAG, (tag2, slash, rawName, attrs) => {
    const name = rawName.toLowerCase();
    if (name.startsWith("mml:") || name.startsWith("jats:")) return "";
    if (!INLINE_FORMAT.has(name)) return tag2;
    if (name === "br") return " ";
    const markup = attrs.trim().replace(/\/$/, "") !== "" || name === "wbr" || (slash ? opened : closed).has(name);
    return markup ? "" : tag2;
  }).replace(/\s+/g, " ").trim();
}
function preSlotIndex(line) {
  if (line.length < 3 || line[0] !== NUL2 || line[line.length - 1] !== NUL2) return void 0;
  const i = Number(line.slice(1, -1));
  return Number.isInteger(i) ? i : void 0;
}
function restoreInlinePre(line, blocks2) {
  const parts = line.split(NUL2);
  let out = parts[0];
  for (let i = 1; i < parts.length; i += 2) {
    const code = (blocks2[Number(parts[i])] ?? "").replace(/\s+/g, " ").trim();
    out += ` ${code} ${parts[i + 1] ?? ""}`;
  }
  return out.replace(/ {2,}/g, " ").trim();
}
function setAsidePre(html, blocks2) {
  const open2 = /<pre(?=[\s/>])(?:[^<>"']|"[^"]*"|'[^']*')*>/gi;
  const close = closeTagRe("pre");
  let out = "";
  let last = 0;
  let m;
  while (m = open2.exec(html)) {
    close.lastIndex = open2.lastIndex;
    const c = close.exec(html);
    if (!c) break;
    const inner2 = html.slice(open2.lastIndex, c.index);
    const text = decodeEntities(inner2.replace(/<br\s*\/?>/gi, "\n").replace(LOOSE_TAG_RE, "")).replace(/\r\n?/g, "\n").replace(/^\n/, "").trimEnd();
    blocks2.push(text);
    out += html.slice(last, m.index) + PRE_SLOT(blocks2.length - 1);
    last = open2.lastIndex = c.index + c[0].length;
  }
  return last === 0 ? html : out + html.slice(last);
}
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
    const text = html.slice(HEADING_OPEN.lastIndex, b.index).replace(PERMALINK, "").replace(TAG_RE, (tag2) => INLINE_TAGS.has(tagName(tag2)) ? "" : " ").replace(/\s+/g, " ").trim();
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
  let prevAEnd = -1;
  s = s.replace(TAG_RE, (tag2, at) => {
    const closing2 = tag2[1] === "/";
    const name = tagName(tag2);
    const adjacentLinks = name === "a" && !closing2 && at === prevAEnd;
    prevAEnd = name === "a" && closing2 ? at + tag2.length : -1;
    if (/^h[1-6]$/.test(name)) {
      return closing2 ? "\n" : "\n" + "#".repeat(Number(name[1])) + " ";
    }
    if (BLOCK_TAGS.has(name) || name === "br" || name === "hr") return "\n";
    if (INLINE_TAGS.has(name)) return adjacentLinks ? " " : "";
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
function firstElementText(html, name) {
  const open2 = new RegExp(`<${name}(?=[\\s/>])(?:[^<>"']|"[^"]*"|'[^']*')*>`, "i").exec(html);
  if (!open2) return void 0;
  const close = closeTagRe(name);
  close.lastIndex = open2.index + open2[0].length;
  const c = close.exec(html);
  if (!c) return void 0;
  const inner2 = html.slice(open2.index + open2[0].length, c.index).replace(TAG_RE, (tag2) => INLINE_TAGS.has(tagName(tag2)) ? "" : " ");
  return decodeEntities(inner2).replace(/\s+/g, " ").trim() || void 0;
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
  const clean32 = dropElements(html, NOT_TITLE);
  return firstElementText(clean32, "title") ?? metaContent(clean32, ["og:title", "twitter:title"]) ?? firstElementText(clean32, "h1");
}
function htmlCanonicalUrl(html) {
  const clean32 = dropElements(html, ["script", "style", "template"]);
  const end = clean32.search(/<\/head\s*>|<body(?=[\s/>])/i);
  const head = end < 0 ? clean32 : clean32.slice(0, end);
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
function isContentContainer(open2) {
  const attrs = htmlAttributes(open2);
  for (const token of `${attrs.get("id") ?? ""} ${attrs.get("class") ?? ""}`.toLowerCase().split(/\s+/)) {
    if (token === "markdown-body") return true;
    const words = token.split(/\W+/);
    if (words.some((w) => CONTENT_WORDS.has(w)) && !words.some((w) => CHROME_WORDS.has(w))) return true;
  }
  return false;
}
function blockKind(open2) {
  const tag2 = /^<([a-zA-Z][a-zA-Z0-9-]*)/.exec(open2)?.[1]?.toLowerCase() ?? "";
  const firstClass = (htmlAttributes(open2).get("class") ?? "").trim().split(/\s+/)[0];
  return `${tag2} ${firstClass.replace(/\d+/g, "0")}`;
}
function textProfile(html) {
  const at = [];
  const len = [];
  const link = [];
  const prose = [];
  let inA = false;
  let inP = false;
  let total = 0;
  let linked = 0;
  let para = 0;
  let last = 0;
  for (const m of html.matchAll(LOOSE_TAG_RE)) {
    const n = html.slice(last, m.index).replace(/\s+/g, " ").trim().length;
    total += n;
    if (inA) linked += n;
    else if (inP) para += n;
    at.push(m.index);
    len.push(total);
    link.push(linked);
    prose.push(para);
    last = m.index + m[0].length;
    const name = tagName(m[0]);
    const closing2 = m[0][1] === "/";
    if (name === "a") inA = !closing2;
    else if (name === "p") inP = !closing2;
    else if (!closing2 && CLOSES_P.has(name)) inP = false;
  }
  const index = (pos) => {
    let lo = 0;
    let hi = at.length - 1;
    while (lo < hi) {
      const mid = lo + hi + 1 >> 1;
      if (at[mid] <= pos) lo = mid;
      else hi = mid - 1;
    }
    return lo;
  };
  return (from, to) => {
    if (!at.length) return { len: 0, link: 0, prose: 0 };
    const i = index(from);
    const j = index(to);
    return { len: len[j] - len[i], link: link[j] - link[i], prose: prose[j] - prose[i] };
  };
}
function headlineProse(clean32, stats, lists, minProse) {
  const firstAtOrAfter = (pos) => {
    let lo = 0;
    let hi = lists.length;
    while (lo < hi) {
      const mid = lo + hi >> 1;
      if (lists[mid].from < pos) lo = mid + 1;
      else hi = mid;
    }
    return lo;
  };
  const inList = (pos) => {
    const k = firstAtOrAfter(pos + 1) - 1;
    return k >= 0 && pos < lists[k].to;
  };
  const h1 = [...clean32.matchAll(/<h1(?=[\s/>])/gi)].map((m) => m.index).find((pos) => !inList(pos));
  if (h1 === void 0) return void 0;
  const ancestors = ["div", "section", "article", "main"].flatMap((tag2) => balancedRegions(clean32, tag2, () => true)).filter((r) => r.start <= h1 && h1 < r.end).sort((a, b) => a.end - a.start - (b.end - b.start));
  const cum = [{ len: 0, link: 0, prose: 0 }];
  for (const r of lists) {
    const s = stats(r.from, r.to);
    const p = cum[cum.length - 1];
    cum.push({ len: p.len + s.len, link: p.link + s.link, prose: p.prose + s.prose });
  }
  const measure = (r) => {
    const i2 = firstAtOrAfter(r.start);
    const j2 = Math.max(i2, firstAtOrAfter(r.end));
    const s = stats(r.start, r.end);
    const cut = { len: cum[j2].len - cum[i2].len, link: cum[j2].link - cum[i2].link, prose: cum[j2].prose - cum[i2].prose };
    return { region: r, i: i2, j: j2, cut: cut.len, len: s.len - cut.len, link: s.link - cut.link, prose: s.prose - cut.prose };
  };
  let best;
  for (const r of ancestors) {
    const m = measure(r);
    if (m.prose < minProse || m.prose < m.cut || isLinkList(m)) continue;
    if (!best || m.prose >= best.prose * 1.3) best = m;
  }
  if (!best) return void 0;
  const { region, i, j } = best;
  let out = "";
  let last = region.start;
  for (const r of lists.slice(i, j)) {
    out += `${clean32.slice(last, r.from)} `;
    last = r.to;
  }
  return out + clean32.slice(last, region.end);
}
function extractMainHtml(html) {
  const clean32 = dropElements(html, ["script", "style", "template", "svg"]);
  const roleMainTags = /* @__PURE__ */ new Set(["main"]);
  for (const m of clean32.matchAll(ROLE_MAIN_TAG)) roleMainTags.add(m[1].toLowerCase());
  const stats = textProfile(clean32);
  const tiers = [
    { tags: [...roleMainTags], isCandidate: (open2) => /^<main[\s/>]/i.test(open2) || ROLE_MAIN.test(open2) },
    { tags: ["article"], isCandidate: () => true },
    { tags: ["div", "section"], isCandidate: isContentContainer }
  ];
  for (const tier of tiers) {
    const regions = tier.tags.flatMap((tag2) => balancedRegions(clean32, tag2, tier.isCandidate)).sort((a, b) => a.start - b.start);
    if (!regions.length) continue;
    const outer = [];
    let reach = -1;
    for (const r of regions) {
      if (r.start < reach) continue;
      reach = r.end;
      outer.push({ ...r, len: visibleLength(clean32.slice(r.start, r.end)) });
    }
    let best = outer[0];
    for (const r of outer) if (r.len > best.len) best = r;
    const linkList = (r) => isLinkList(stats(r.start, r.end));
    const kind = blockKind(best.open);
    const bestIsList = linkList(best);
    const kept = outer.filter((r) => r === best || blockKind(r.open) === kind && (bestIsList || !linkList(r)));
    if (bestIsList) {
      const listProse = kept.reduce((n, r) => n + stats(r.start, r.end).prose, 0);
      const prose = headlineProse(clean32, stats, outer.filter(linkList), Math.max(MIN_PROSE, listProse + 1));
      if (prose !== void 0) return prose;
    }
    const keptLen = kept.reduce((n, r) => n + r.len, 0);
    if (keptLen < 500 && keptLen < visibleLength(clean32) * 0.3) return html;
    if (kept.length === 1) return clean32.slice(best.start, best.end);
    return kept.map((r) => `<div>${clean32.slice(r.start, r.end)}</div>`).join("\n");
  }
  return html;
}
function looksLikePdfUrl(url) {
  if (PDF_URL_RE.test(url)) return true;
  return PDF_ROUTE_RE.test(url) && !NON_PDF_TAIL_RE.test(url);
}
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
  const browser = opts.authorizeUrl || opts.headers || wantsPdf || wantsDoc ? "off" : browserFetchMode(opts.browser);
  if (browser === "always") {
    const got2 = await renderInBrowser(url, opts);
    if (got2.result) return got2.result;
    const res2 = await readWithoutBrowser(url, opts, wantsPdf, wantsDoc, { page: false });
    return { ...res2, note: [`${got2.note}; read without it.`, got2.detail, res2.note].filter(Boolean).join(" ") };
  }
  const seen = { page: false };
  const res = await readWithoutBrowser(url, opts, wantsPdf, wantsDoc, seen);
  const why = browser === "fallback" && seen.page && !opts.signal?.aborted ? worthRendering(res) : void 0;
  if (!why) return res;
  const got = await renderInBrowser(url, opts);
  if (got.result?.text.trim())
    return { ...got.result, note: [`Read ${url} in the browser: the built-in fetch ${why}.`, got.result.note].filter(Boolean).join(" ") };
  return { ...res, note: [res.note, got.result ? got.result.note : `${got.note}.`, got.detail].filter(Boolean).join(" ") || void 0 };
}
async function renderInBrowser(url, opts) {
  try {
    const { readRenderedPage: readRenderedPage2 } = await Promise.resolve().then(() => (init_read(), read_exports));
    const { format, fullPage, stripConsent, keepHtml, signal, timeoutMs } = opts;
    const result = await readRenderedPage2(url, { format, fullPage, stripConsent, keepHtml, signal, timeoutMs });
    if (result.status >= 400) return { note: `The browser got HTTP ${result.status} for ${url}`, detail: result.note };
    return { result };
  } catch (e) {
    return { note: `The browser could not read ${url} (${e instanceof Error ? e.message : String(e)})` };
  }
}
async function readWithoutBrowser(url, opts, wantsPdf, wantsDoc, seen) {
  const cancelled = () => ({ text: "", finalUrl: url, status: 0, note: `Fetching ${url} was cancelled.` });
  let firecrawlNote;
  if (!wantsPdf && !wantsDoc && !opts.authorizeUrl && !opts.fullPage) {
    const fc = await scrapeViaFirecrawl(url, opts);
    if (fc.data && (fc.data.statusCode ?? 200) < 400) {
      seen.page = true;
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
    seen.page = true;
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
  seen.page = isHtml;
  const extracted = isHtml ? extractFromHtml(body, res.url, opts) : { text: body, consentDropped: 0, title: void 0, canonical: void 0, metaDescription: void 0 };
  const notDocument = answeredHtml ? `${url} looked like ${claimsPdf ? "a PDF" : "an office document"} but the server returned HTML (a login wall or landing page?), so it was read as a web page.` : void 0;
  const cut = res.truncated ? `Read only the first ${res.bytesRead} bytes of ${url} (the response size cap), so this text is a prefix.` : void 0;
  return {
    ...extracted,
    finalUrl: res.url,
    status: res.status,
    note: [firecrawlNote, notDocument, cut].filter(Boolean).join(" ") || void 0,
    ...res.truncated ? { truncated: true } : {},
    ...validators
  };
}
function extractFromHtml(html, finalUrl, opts = {}) {
  const markdown = opts.format === "markdown";
  const main2 = opts.fullPage ? html : extractMainHtml(html);
  const stripped = markdown ? markdownAgainst(main2, documentBaseUrl(html, finalUrl), opts.fullPage) : htmlToText(main2, opts);
  const consent = opts.stripConsent && !opts.fullPage ? stripConsentBoilerplate(stripped, { markdown }) : { text: stripped, dropped: 0 };
  return {
    text: consent.text,
    consentDropped: consent.dropped,
    title: pageTitle(html),
    canonical: absoluteCanonical(htmlCanonicalUrl(html), finalUrl),
    metaDescription: metaDescriptionOf(html),
    ...opts.keepHtml ? { html } : {}
  };
}
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
var DEFAULT_BROWSER_UA;
var RETRY_STATUS;
var defaultTimeoutMs2;
var DEFAULT_MAX_RESPONSE_BYTES;
var mimeOf;
var namesDocument;
var REDIRECT_STATUS;
var INLINE_FORMAT;
var INLINE_FORMAT_TAG;
var NUL2;
var PRE_SLOT;
var HEADING_OPEN;
var HEADING_BOUNDARY;
var PERMALINK;
var NOT_TITLE;
var visibleLength;
var ROLE_MAIN;
var ROLE_MAIN_TAG;
var CONTENT_WORDS;
var CHROME_WORDS;
var CLOSES_P;
var isLinkList;
var MIN_PROSE;
var PDF_URL_RE;
var PDF_ROUTE_RE;
var NON_PDF_TAIL_RE;
var PDF_FETCH_OPTS;
var DOC_FETCH_OPTS;
var PURE_VIDEO_HOSTS;
var HTML_TYPE_RE;
var NON_TEXT_TYPE_RE;
var DEAD_LINK_STATUS;
var CONSENT_PATTERNS;
var CONSENT_ACTIONS;
var BANNER_VOICE;
var BUTTON_LABEL;
var BUTTON_LENGTH;
var NOTICE_LENGTH;
var MD_FENCE;
var MD_LINE_START;
var MD_DESTINATION;
var MD_MARKUP;
var init_fetch = __esm({
  "src/fetch.ts"() {
    "use strict";
    init_brand();
    init_charset();
    init_entities();
    init_html();
    init_mime();
    init_retry();
    init_text();
    init_markdown2();
    init_pdf();
    init_doc();
    init_firecrawl();
    init_video();
    init_mode();
    init_junk();
    DEFAULT_BROWSER_UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";
    RETRY_STATUS = /* @__PURE__ */ new Set([429, 503, 502, 504]);
    defaultTimeoutMs2 = () => envInt("TIMEOUT_MS", 2e4, 1e3, 3e5);
    DEFAULT_MAX_RESPONSE_BYTES = 4 * 1024 * 1024;
    mimeOf = (contentType) => contentType.split(";")[0].trim().toLowerCase();
    namesDocument = (filename) => filename !== void 0 && (PDF_URL_RE.test(filename) || docFormatForUrl(filename) !== void 0);
    REDIRECT_STATUS = /* @__PURE__ */ new Set([301, 302, 303, 307, 308]);
    INLINE_FORMAT = /* @__PURE__ */ new Set([...INLINE_TAGS, "br", "scp"]);
    INLINE_FORMAT_TAG = /<(\/?)([a-zA-Z][\w.-]*(?::[\w.-]+)?)(?=[\s/>])([^<>]*)>/g;
    NUL2 = "\0";
    PRE_SLOT = (i) => `
${NUL2}${i}${NUL2}
`;
    HEADING_OPEN = /<h([1-6])(?=[\s/>])(?:[^<>"']|"[^"]*"|'[^']*')*>/gi;
    HEADING_BOUNDARY = /<\/h[1-6]\s*>|<h[1-6](?=[\s/>])/gi;
    PERMALINK = /<a\b[^<>]*>\s*(?:(?:¶|#|§|🔗|&para;|&#182;|&#x[bB]6;|&sect;)\s*)?<\/a\s*>/gi;
    NOT_TITLE = ["script", "style", "template", "svg"];
    visibleLength = (h) => h.replace(/<[^<>]*>/g, " ").replace(/\s+/g, " ").trim().length;
    ROLE_MAIN = /\srole\s*=\s*["']?main(?=["'\s/>])/i;
    ROLE_MAIN_TAG = /<([a-zA-Z][a-zA-Z0-9-]*)(?=[\s/>])[^<>]*\srole\s*=\s*["']?main(?=["'\s/>])/gi;
    CONTENT_WORDS = /* @__PURE__ */ new Set(["content", "article", "post", "entry", "story", "main", "prose"]);
    CHROME_WORDS = /* @__PURE__ */ new Set([
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
    CLOSES_P = /* @__PURE__ */ new Set([
      "address",
      "article",
      "aside",
      "blockquote",
      "div",
      "dl",
      "fieldset",
      "figure",
      "footer",
      "form",
      "h1",
      "h2",
      "h3",
      "h4",
      "h5",
      "h6",
      "header",
      "hr",
      "main",
      "nav",
      "ol",
      "pre",
      "section",
      "table",
      "ul"
    ]);
    isLinkList = (s) => s.len > 0 && s.link > s.len * 0.5;
    MIN_PROSE = 200;
    PDF_URL_RE = /\.pdf($|[?#])/i;
    PDF_ROUTE_RE = /\/pdf\/[^/?#]+($|[?#])/i;
    NON_PDF_TAIL_RE = /\.(html?|php|aspx?|jsp|json|xml|txt|md|csv)($|[?#])/i;
    PDF_FETCH_OPTS = { accept: "application/pdf,*/*", binary: true, maxBytes: 16 * 1024 * 1024 };
    DOC_FETCH_OPTS = { accept: "*/*", binary: true, maxBytes: 16 * 1024 * 1024 };
    PURE_VIDEO_HOSTS = /* @__PURE__ */ new Set(["youtube", "vimeo", "dailymotion"]);
    HTML_TYPE_RE = /^(?:text\/html|application\/xhtml\+xml)$/;
    NON_TEXT_TYPE_RE = /^(?:image\/(?!svg\+xml$)|audio\/|video\/|font\/|model\/|application\/(?:gzip|x-gzip|x-tar|x-bzip2|x-xz|x-7z-compressed|x-rar-compressed|vnd\.rar|java-archive|wasm|x-msdownload|vnd\.android\.package-archive|x-shockwave-flash|ogg)$)/;
    DEAD_LINK_STATUS = /* @__PURE__ */ new Set([404, 410, 451, 403]);
    CONSENT_PATTERNS = [
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
    CONSENT_ACTIONS = [
      /\b(?:accept|reject|decline|agree|allow|manage|preferences|settings|choices)\b/i,
      /\b(?:opt[ -]out|we use cookies|this (?:site|website) uses cookies|by continuing)\b/i,
      /\b(?:learn more|privacy policy|cookie policy)\b/i
    ];
    BANNER_VOICE = /\b(?:we|us|our)\b[^.]{0,60}?\b(?:cookies?|partners|consent|tracking)\b|\bby (?:clicking|continuing|using|browsing)\b|\bthis (?:site|website) uses cookies\b|\bnous (?:utilisons|et nos partenaires)\b|\ben cliquant sur\b|\bwir (?:verwenden|nutzen|setzen|und unsere partner)\b|\bmit (?:dem )?klick auf\b/i;
    BUTTON_LABEL = /^(?:tout (?:accepter|refuser)|(?:accepter|refuser) tout|accepter et (?:fermer|continuer)|continuer sans accepter|(?:param[ée]trer|g[ée]rer|personnaliser|accepter|refuser) (?:les|mes) cookies|alle (?:cookies )?(?:akzeptieren|ablehnen)|nur (?:notwendige|essenzielle)(?: cookies)?|cookie-einstellungen|einstellungen verwalten|akzeptieren und schlie(?:ß|ss)en)$/i;
    BUTTON_LENGTH = 40;
    NOTICE_LENGTH = 400;
    MD_FENCE = /^[\s>]*(`{3,}|~{3,})(.*)$/;
    MD_LINE_START = /^[\s>]*(?:(?:[-+*]|\d{1,9}[.)])\s+)?(?:#{1,6}\s+)?/;
    MD_DESTINATION = /\]\((?:[^()\s\\]|\\.|\([^()\s]*\))*\)/g;
    MD_MARKUP = /\\(?=[!-/:-@[-`{-~])|!?\[|\]|\*+|`+/g;
  }
});
function add(out, cond, e) {
  if (cond) out.push(e);
}
function genericEvidence(h, sig) {
  const out = [];
  const inTitle = GENERIC_PHRASES.find((p) => h.title.includes(p));
  add(out, inTitle, { signal: `title mentions "${inTitle}"` });
  if (h.text.length < PHRASE_TEXT_MAX) {
    const inText = GENERIC_PHRASES.find((p) => h.text.includes(p));
    add(out, inText, { signal: `text mentions "${inText}"` });
  }
  add(out, frameHas(h, "captcha"), { signal: "captcha frame", widget: true });
  add(out, sig.status !== void 0 && BLOCKED_STATUS.has(sig.status) && sig.status !== 503 && h.text.trim().length < LITTLE_TEXT, {
    signal: `status ${sig.status} with almost no text`,
    interstitial: true
  });
  return out;
}
function classifyChallenge(sig) {
  const text = norm((sig.text ?? "").slice(0, 4096));
  const h = {
    title: norm(sig.title),
    text,
    urls: [...sig.frameUrls ?? [], ...sig.scriptUrls ?? []].map(norm),
    frames: (sig.frameUrls ?? []).map(norm),
    scripts: (sig.scriptUrls ?? []).map(norm),
    cookies: (sig.cookieNames ?? []).map(norm),
    selectors: (sig.selectors ?? []).map(norm)
  };
  const statusBlocked = sig.status !== void 0 && BLOCKED_STATUS.has(sig.status);
  const littleText = sig.text !== void 0 && sig.text.trim().length < LITTLE_TEXT;
  const finish = (kind, ev2) => ({
    kind,
    // An empty page makes a block of what is not a widget or a tag; a widget or a tag needs a blocked status.
    blocking: statusBlocked || ev2.some((e) => e.interstitial || littleText && !e.weak && !e.widget),
    signals: ev2.map((e) => e.signal)
  });
  for (const [kind, rule] of VENDORS) {
    const ev2 = rule(h);
    if (ev2.some((e) => !e.weak) || ev2.length > 0 && statusBlocked) return finish(kind, ev2);
  }
  const ev = genericEvidence(h, sig);
  return ev.length > 0 ? finish("generic", ev) : null;
}
function frameUrls(node, out = []) {
  if (!node) return out;
  if (node.frame?.url) out.push(node.frame.url);
  for (const c of node.childFrames ?? []) frameUrls(c, out);
  return out;
}
async function probeChallenge(session) {
  try {
    const r = await session.page.send(
      "Runtime.evaluate",
      { expression: PROBE, returnByValue: true },
      { timeoutMs: PROBE_TIMEOUT_MS3 }
    );
    const v = r.result?.value;
    if (typeof v !== "object" || v === null) return { ok: false };
    const p = v;
    let tree = [];
    try {
      tree = frameUrls((await session.page.send("Page.getFrameTree")).frameTree);
    } catch {
    }
    const challenge = classifyChallenge({
      url: typeof p.url === "string" ? p.url : "",
      title: typeof p.title === "string" ? p.title : "",
      text: typeof p.text === "string" ? p.text : void 0,
      frameUrls: [...strings(p.iframeSrcs), ...tree],
      scriptUrls: strings(p.scriptUrls),
      cookieNames: strings(p.cookieNames),
      selectors: strings(p.selectors),
      status: typeof p.status === "number" ? p.status : void 0
    });
    return { ok: true, challenge };
  } catch {
    return { ok: false };
  }
}
async function detectChallenge(session) {
  const probe = await probeChallenge(session);
  return probe.ok ? probe.challenge : null;
}
var CHALLENGE_SELECTORS;
var LITTLE_TEXT;
var PHRASE_TEXT_MAX;
var BLOCKED_STATUS;
var norm;
var urlHas;
var frameHas;
var scriptHas;
var selHas;
var datadome;
var CF_ORCHESTRATE;
var cloudflare;
var perimeterx;
var akamai;
var imperva;
var arkose;
var hcaptcha;
var recaptcha;
var VENDORS;
var GENERIC_PHRASES;
var PROBE_TIMEOUT_MS3;
var PROBE;
var strings;
var init_challenge = __esm({
  "src/browser/challenge.ts"() {
    "use strict";
    CHALLENGE_SELECTORS = [
      "#challenge-form",
      ".cf-turnstile",
      ".g-recaptcha",
      ".h-captcha",
      "#px-captcha",
      'iframe[src*="datadome"]',
      "#sec-if-cpt-container"
    ];
    LITTLE_TEXT = 200;
    PHRASE_TEXT_MAX = 1500;
    BLOCKED_STATUS = /* @__PURE__ */ new Set([403, 429, 503]);
    norm = (s) => s.normalize("NFD").replace(new RegExp("\\p{M}", "gu"), "").replace(/[‘’]/g, "'").toLowerCase();
    urlHas = (h, needle) => h.urls.find((u) => u.includes(needle));
    frameHas = (h, needle) => h.frames.find((u) => u.includes(needle));
    scriptHas = (h, needle) => h.scripts.find((u) => u.includes(needle));
    selHas = (h, needle) => h.selectors.some((s) => s.includes(needle));
    datadome = (h) => {
      const out = [];
      const frame = frameHas(h, "captcha-delivery.com");
      add(out, frame, { signal: "captcha-delivery.com", interstitial: true });
      add(out, scriptHas(h, "captcha-delivery.com"), { signal: "captcha-delivery.com script", weak: true });
      add(out, selHas(h, "datadome"), { signal: "datadome frame" });
      add(out, h.cookies.includes("datadome"), { signal: "datadome cookie", weak: true });
      add(out, urlHas(h, "datadome.co"), { signal: "datadome.co script", weak: true });
      return out;
    };
    CF_ORCHESTRATE = /\/cdn-cgi\/challenge-platform\/(?:h\/[a-z]\/)?orchestrate\//;
    cloudflare = (h) => {
      const out = [];
      const t = h.title.trim();
      add(out, t.includes("just a moment") || t.startsWith("un instant") || t.includes("attention required! | cloudflare"), {
        signal: `title "${h.title.trim()}"`,
        interstitial: true
      });
      add(out, selHas(h, "#challenge-form"), { signal: "#challenge-form", interstitial: true });
      add(out, urlHas(h, "cf-chl") || urlHas(h, "__cf_chl"), { signal: "cf-chl", interstitial: true });
      const platform = h.urls.filter((u) => u.includes("/cdn-cgi/challenge-platform/") && !u.includes("turnstile"));
      add(
        out,
        platform.some((u) => CF_ORCHESTRATE.test(u)),
        { signal: "/cdn-cgi/challenge-platform/ orchestrate", interstitial: true }
      );
      add(
        out,
        platform.some((u) => !CF_ORCHESTRATE.test(u)),
        { signal: "/cdn-cgi/challenge-platform/", weak: true }
      );
      add(
        out,
        h.cookies.some((c) => c.startsWith("cf-chl") || c.startsWith("__cf_chl")),
        { signal: "cf-chl cookie", weak: true }
      );
      add(out, selHas(h, ".cf-turnstile"), { signal: ".cf-turnstile", widget: true });
      add(out, frameHas(h, "challenges.cloudflare.com"), { signal: "challenges.cloudflare.com frame", widget: true });
      add(out, scriptHas(h, "challenges.cloudflare.com"), { signal: "challenges.cloudflare.com script", weak: true });
      return out;
    };
    perimeterx = (h) => {
      const out = [];
      add(out, selHas(h, "px-captcha"), { signal: "#px-captcha", interstitial: true });
      add(out, h.text.includes("press & hold") || h.text.includes("appuyez et maintenez"), { signal: "Press & Hold", interstitial: true });
      add(out, urlHas(h, "captcha.px-cdn.net"), { signal: "captcha.px-cdn.net", widget: true });
      const tag2 = urlHas(h, "px-cdn.net") ?? urlHas(h, "px-cloud.net");
      add(out, tag2, { signal: "px script", weak: true });
      add(
        out,
        h.cookies.some((c) => c === "_px3" || c === "_pxvid" || c === "_pxhd"),
        { signal: "_px cookie", weak: true }
      );
      return out;
    };
    akamai = (h) => {
      const out = [];
      add(out, h.title.includes("access denied") && h.text.includes("reference #"), { signal: "Access Denied + Reference #", interstitial: true });
      add(out, urlHas(h, "sec-if-cpt") || selHas(h, "sec-if-cpt") || selHas(h, "sec-cpt"), { signal: "sec-if-cpt", interstitial: true });
      add(out, urlHas(h, "edgesuite.net") || h.text.includes("edgesuite.net"), { signal: "edgesuite.net" });
      add(out, h.cookies.includes("sec_cpt"), { signal: "sec_cpt cookie", weak: true });
      return out;
    };
    imperva = (h) => {
      const out = [];
      add(out, h.text.includes("incapsula incident id"), { signal: "Incapsula incident ID", interstitial: true });
      add(out, urlHas(h, "_incapsula_resource") || h.text.includes("_incapsula_resource"), { signal: "_Incapsula_Resource", weak: true });
      add(
        out,
        h.cookies.some((c) => c.startsWith("incap_ses")),
        { signal: "incap_ses cookie", weak: true }
      );
      return out;
    };
    arkose = (h) => {
      const out = [];
      const f = frameHas(h, "arkoselabs.com") ?? frameHas(h, "funcaptcha");
      add(out, f, { signal: f?.includes("funcaptcha") ? "funcaptcha" : "arkoselabs.com", widget: true });
      add(out, scriptHas(h, "arkoselabs.com") ?? scriptHas(h, "funcaptcha"), { signal: "arkose script", weak: true });
      return out;
    };
    hcaptcha = (h) => {
      const out = [];
      add(out, frameHas(h, "hcaptcha.com"), { signal: "hcaptcha.com frame", widget: true });
      add(out, scriptHas(h, "hcaptcha.com"), { signal: "hcaptcha.com script", weak: true });
      add(out, selHas(h, ".h-captcha"), { signal: ".h-captcha", widget: true });
      return out;
    };
    recaptcha = (h) => {
      const out = [];
      add(out, frameHas(h, "google.com/recaptcha") || frameHas(h, "recaptcha.net"), { signal: "recaptcha frame", widget: true });
      add(out, scriptHas(h, "google.com/recaptcha") || scriptHas(h, "recaptcha.net"), { signal: "recaptcha script", weak: true });
      add(out, selHas(h, ".g-recaptcha"), { signal: ".g-recaptcha", widget: true });
      return out;
    };
    VENDORS = [
      ["datadome", datadome],
      ["cloudflare", cloudflare],
      ["perimeterx", perimeterx],
      ["akamai", akamai],
      ["imperva", imperva],
      ["arkose", arkose],
      ["hcaptcha", hcaptcha],
      ["recaptcha", recaptcha]
    ];
    GENERIC_PHRASES = [
      "captcha",
      "are you a robot",
      "are you human",
      "verify you are human",
      "verify you're human",
      "unusual traffic",
      "checking your browser",
      "verifiez que vous etes humain",
      "je ne suis pas un robot"
    ];
    PROBE_TIMEOUT_MS3 = 3e3;
    PROBE = `(() => {
  const sel = ${JSON.stringify(CHALLENGE_SELECTORS)}.filter((s) => { try { return !!document.querySelector(s); } catch { return false; } });
  const nav = performance.getEntriesByType("navigation")[0];
  return {
    url: location.href,
    title: document.title || "",
    text: (document.body ? document.body.innerText : "").slice(0, 4096),
    scriptUrls: Array.from(document.scripts, (s) => s.src).filter(Boolean),
    iframeSrcs: Array.from(document.querySelectorAll("iframe"), (f) => f.src).filter(Boolean),
    cookieNames: (() => { try { return document.cookie.split(";").map((c) => c.split("=")[0].trim()).filter(Boolean); } catch (e) { return []; } })(),
    selectors: sel,
    status: nav && nav.responseStatus > 0 ? nav.responseStatus : undefined,
  };
})()`;
    strings = (v) => Array.isArray(v) ? v.filter((x) => typeof x === "string") : [];
  }
});
var CONSENT_SELECTORS;
var BARE_TEXT_MAX;
var CONTROL_TAGS;
var CONTROL_ROLES;
var HELPERS;
var OVERLAYS_SOURCE;
var OVERLAY_ROOT_SOURCE;
var DESCRIBE_SOURCE;
var OVERLAY_INFO_SOURCE;
var READ_DOCUMENT;
var init_overlay = __esm({
  "src/browser/overlay.ts"() {
    "use strict";
    CONSENT_SELECTORS = [
      // OneTrust
      "#onetrust-consent-sdk",
      "#onetrust-banner-sdk",
      "#onetrust-pc-sdk",
      // Didomi
      "#didomi-host",
      "#didomi-notice",
      'div[class^="didomi-"]',
      // Sourcepoint
      '[id^="sp_message_container"]',
      // Quantcast Choice
      ".qc-cmp2-container",
      "#qc-cmp2-container",
      // Cookiebot
      "#CybotCookiebotDialog",
      "#CybotCookiebotDialogBodyUnderlay",
      // Usercentrics
      "#usercentrics-root",
      "#usercentrics-cmp-ui",
      // TrustArc
      "#truste-consent-track",
      "#consent_blackbar",
      'div[class^="truste_"]',
      // consentmanager.net, Commanders Act, Axeptio, Iubenda, Complianz, CookieYes, Osano, Borlabs, Google Funding Choices
      "#cmpbox",
      "#cmpbox2",
      "#tc-privacy-wrapper",
      "#axeptio_overlay",
      "#iubenda-cs-banner",
      "#cmplz-cookiebanner-container",
      ".cky-consent-container",
      ".osano-cm-window",
      "#BorlabsCookieBox",
      ".fc-consent-root",
      // The IAB TCF / GPP locator frames
      'iframe[name="__tcfapiLocator"]',
      'iframe[name="__cmpLocator"]',
      'iframe[name="__gppLocator"]'
    ];
    BARE_TEXT_MAX = 40;
    CONTROL_TAGS = ["A", "BUTTON", "INPUT", "SELECT", "TEXTAREA", "IFRAME", "SUMMARY", "DETAILS"];
    CONTROL_ROLES = [
      "button",
      "link",
      "checkbox",
      "radio",
      "switch",
      "tab",
      "menuitem",
      "menuitemcheckbox",
      "menuitemradio",
      "option",
      "textbox",
      "searchbox",
      "combobox",
      "slider",
      "spinbutton"
    ];
    HELPERS = `const up = (n) => n.parentElement || (n.parentNode && n.parentNode.host) || n.host || null;
  const body = document.body;
  const roleOf = (el) => String((el.getAttribute && el.getAttribute("role")) || "").toLowerCase();
  const isDialog = (el) =>
    roleOf(el) === "dialog" ||
    roleOf(el) === "alertdialog" ||
    (!!el.getAttribute && el.getAttribute("aria-modal") === "true") ||
    (String(el.tagName || "").toUpperCase() === "DIALOG" && el.open === true);
  const CONSENT = ${JSON.stringify(CONSENT_SELECTORS.join(", "))};
  const isConsent = (el) => {
    try {
      return !!el.matches && el.matches(CONSENT);
    } catch (e) {
      return false;
    }
  };
  const CONTROL_TAGS = ${JSON.stringify(CONTROL_TAGS)};
  const CONTROL_ROLES = ${JSON.stringify(CONTROL_ROLES)};
  /** Something to act on: a native control, a control role, a focusable (tabindex >= 0) or editable element. */
  const isControl = (el) => {
    const attr = (n) => (el.getAttribute ? el.getAttribute(n) : null);
    const tag = String(el.tagName || "").toUpperCase();
    if (tag === "A") return attr("href") !== null;
    if (tag === "INPUT") return String(attr("type") || "").toLowerCase() !== "hidden";
    if (CONTROL_TAGS.indexOf(tag) >= 0 || CONTROL_ROLES.indexOf(roleOf(el)) >= 0) return true;
    const tab = attr("tabindex");
    if (tab !== null && tab !== "" && Number(tab) >= 0) return true;
    const edit = attr("contenteditable");
    return edit === "" || edit === "true" || edit === "plaintext-only";
  };
  const textLength = (n) => String((typeof n.innerText === "string" ? n.innerText : n.textContent) || "").replace(/\\s+/g, " ").trim().length;
  /**
   * Nothing to answer in it: no control, itself or inside (open shadow roots
   * included), and under ${BARE_TEXT_MAX} characters of text. An ad slot holding
   * an image is one; a cookie wall, a login dialog, a notice to read are not.
   * Never bare: a consent vendor's container (its buttons may be plain divs),
   * nor anything holding a custom element with no open shadow root (a closed
   * one hides its text and controls from here).
   */
  const bare = (el) => {
    let text = textLength(el);
    const stack = [el];
    for (let seen = 0; stack.length > 0; seen++) {
      // Too big to look through: whatever it is, it is no empty layer.
      if (text >= ${BARE_TEXT_MAX} || seen > 5000) return false;
      const n = stack.pop();
      if (n.nodeType === 1 && (isControl(n) || isConsent(n))) return false;
      if (n.nodeType === 1 && String(n.tagName || "").indexOf("-") >= 0 && !n.shadowRoot) return false;
      for (const k of Array.from(n.children || [])) stack.push(k);
      if (n.shadowRoot) {
        for (const k of Array.from(n.shadowRoot.children || [])) {
          text += textLength(k);
          stack.push(k);
        }
      }
    }
    return text < ${BARE_TEXT_MAX};
  };
  /** Fixed or sticky, itself or an ancestor up to the body: what a click's covering node belongs to. */
  const pinned = (el) => {
    for (let n = el; n && n.nodeType === 1 && n !== body && n !== document.documentElement; n = up(n)) {
      const p = getComputedStyle(n).position;
      if (p === "fixed" || p === "sticky") return true;
    }
    return false;
  };`;
    OVERLAYS_SOURCE = `function findOverlays() {
  ${HELPERS}
  const found = [];
  const vw = window.innerWidth;
  const vh = window.innerHeight;
  if (!body || !(vw > 0) || !(vh > 0)) return found;
  const isMain = (el) => String(el.tagName || "").toUpperCase() === "MAIN" || roleOf(el) === "main";
  const holdsMain = (el) => isMain(el) || Array.prototype.some.call(el.querySelectorAll("*"), isMain);
  const textOf = (el) => String(el.textContent || "").length;
  const pageText = textOf(body);
  const fixed = (el) => {
    for (let n = el; n && n.nodeType === 1 && n !== body && n !== document.documentElement; n = up(n)) if (getComputedStyle(n).position === "fixed") return true;
    return false;
  };
  /** Out of the flow of the page, itself or an ancestor: what can be over something. */
  const floating = (el) => {
    for (let n = el; n && n.nodeType === 1 && n !== body && n !== document.documentElement; n = up(n)) {
      const p = getComputedStyle(n).position;
      if (p === "fixed" || p === "absolute") return true;
    }
    return false;
  };
  const hiddenUp = (el) => {
    for (let n = el; n && n.nodeType === 1; n = up(n)) {
      if (n.getAttribute && (n.getAttribute("aria-hidden") === "true" || n.getAttribute("inert") !== null)) return true;
      const cs = getComputedStyle(n);
      if (cs.display === "none" || Number(cs.opacity) === 0) return true;
    }
    return false;
  };
  const shown = (el) => {
    if (el.checkVisibility && !el.checkVisibility({ opacityProperty: true, visibilityProperty: true })) return false;
    const cs = getComputedStyle(el);
    if (cs.visibility === "hidden" || cs.visibility === "collapse") return false;
    const r = el.getBoundingClientRect();
    if (!(r.width > 0 && r.height > 0) || r.right <= 0 || r.bottom <= 0 || r.left >= vw || r.top >= vh) return false;
    return !hiddenUp(el);
  };
  /** The part of the viewport the element covers, or null when it is under 30%. */
  const area = (el) => {
    const r = el.getBoundingClientRect();
    const left = Math.max(r.left, 0);
    const top = Math.max(r.top, 0);
    const w = Math.min(r.right, vw) - left;
    const h = Math.min(r.bottom, vh) - top;
    return w > 0 && h > 0 && w * h >= 0.3 * vw * vh ? { left, top, w, h } : null;
  };
  const covers = (el, a) => {
    // A side column is no overlay: one is wide, or strictly across the middle of the screen.
    const middle = a.left < vw / 2 && a.left + a.w > vw / 2 && a.top < vh / 2 && a.top + a.h > vh / 2;
    if (a.w < 0.6 * vw && !middle) return false;
    const root = el.getRootNode ? el.getRootNode() : document;
    const at = (root && root.elementFromPoint ? root : document).elementFromPoint(a.left + a.w / 2, a.top + a.h / 2);
    for (let n = at; n; n = up(n)) if (n === el) return true;
    return false;
  };
  const kids = (n) => Array.from((n && n.children) || []);
  const visit = (el, inShell) => {
    let shell = inShell;
    let take = false;
    const role = roleOf(el);
    if (isConsent(el)) take = shown(el) && !holdsMain(el);
    else if (isDialog(el)) take = floating(el) && shown(el) && !holdsMain(el);
    else if (!inShell && role !== "presentation" && role !== "none") {
      const a = area(el);
      if (a && fixed(el) && shown(el) && covers(el, a)) {
        if (holdsMain(el) || (pageText > 0 && textOf(el) > 0.6 * pageText)) shell = true;
        else take = true;
      }
    }
    // An overlay is taken whole: what is inside it is its own. A bare one is none, nor is anything inside it.
    if (take && bare(el)) return;
    if (take) {
      found.push(el);
      return;
    }
    for (const k of kids(el)) visit(k, shell);
    if (el.shadowRoot) for (const k of kids(el.shadowRoot)) visit(k, shell);
  };
  for (const k of kids(body)) visit(k, false);
  return found.slice(0, 5);
}`;
    OVERLAY_ROOT_SOURCE = `function overlayRoot() {
  ${HELPERS}
  const overlays = (${OVERLAYS_SOURCE})();
  for (let n = this; n; n = up(n)) if (overlays.indexOf(n) >= 0) return n;
  let outer = null;
  for (let n = this; n && n !== body && n !== document.documentElement; n = up(n)) {
    if (n.nodeType !== 1) continue;
    if (isDialog(n)) return n;
    if (pinned(n) && !pinned(up(n) || body)) outer = n;
  }
  return outer;
}`;
    DESCRIBE_SOURCE = `const describe = (el) => {
    const tag = String(el.tagName || "").toLowerCase();
    const attr = (n) => (el.getAttribute ? el.getAttribute(n) : null);
    const role = attr("role");
    const type = tag === "input" ? attr("type") : null;
    const text = String(el.innerText || el.textContent || "").replace(/\\s+/g, " ").trim();
    const shown = text.length > 60 ? text.slice(0, 57) + "..." : text;
    return "<" + tag + (el.id ? "#" + el.id : "") + (role ? ' role="' + role + '"' : "") + (type ? ' type="' + type + '"' : "") + ">" + (shown ? ' "' + shown + '"' : "");
  };`;
    OVERLAY_INFO_SOURCE = `function overlayInfo() {
  ${HELPERS}
  ${DESCRIBE_SOURCE}
  const overlays = (${OVERLAYS_SOURCE})();
  return { what: describe(this), overlay: (overlays.indexOf(this) >= 0 || isDialog(this) || isConsent(this)) && !bare(this) };
}`;
    READ_DOCUMENT = `(() => {
  const findOverlays = ${OVERLAYS_SOURCE};
  const root = document.documentElement;
  if (!root) return { html: "", url: location.href };
  const mark = "data-overlay-" + Math.random().toString(36).slice(2, 10);
  let overlays = [];
  let html = "";
  try {
    try {
      overlays = findOverlays();
    } catch (e) {}
    for (const el of overlays) if (el.getRootNode && el.getRootNode() === document) el.setAttribute(mark, "");
    html = root.outerHTML;
  } finally {
    for (const el of overlays) if (el.removeAttribute) el.removeAttribute(mark);
  }
  let parsed;
  try {
    parsed = new DOMParser().parseFromString(html, "text/html");
  } catch (e) {
    return { html, url: location.href };
  }
  const drop = ["[" + mark + "]", '[role="dialog"]', '[role="alertdialog"]', '[aria-modal="true"]', "dialog", ${CONSENT_SELECTORS.map((s) => JSON.stringify(s)).join(", ")}];
  const keep = (el) =>
    el === parsed.body || el === parsed.documentElement || el.tagName === "MAIN" || el.getAttribute("role") === "main" || !!el.querySelector("main, [role=main]");
  for (const sel of drop) {
    let els = [];
    try {
      els = Array.from(parsed.querySelectorAll(sel));
    } catch (e) {}
    for (const el of els) if (!keep(el)) el.remove();
  }
  return { html: parsed.documentElement.outerHTML, url: location.href };
})()`;
  }
});
function timeoutText(c, elapsedMs) {
  if ("text" in c) return `text ${JSON.stringify(c.text)} did not appear after ${elapsedMs} ms`;
  if ("gone" in c) return `text ${JSON.stringify(c.gone)} is still on the page after ${elapsedMs} ms`;
  if ("selector" in c) return `no element matches ${JSON.stringify(c.selector)} after ${elapsedMs} ms`;
  if ("url" in c) return `the url did not match ${JSON.stringify(c.url)} after ${elapsedMs} ms`;
  if ("load" in c) return `the page did not finish loading after ${elapsedMs} ms`;
  if ("idle" in c) return `the network did not go idle after ${elapsedMs} ms`;
  if ("clear" in c)
    return `the challenge is still there after ${elapsedMs} ms \u2014 a human must solve it in the browser window (\`${brand().cli} browser open <url>\` shows it), then run wait --clear again`;
  return `timed out after ${elapsedMs} ms`;
}
async function watchNetwork(page) {
  const inflight3 = /* @__PURE__ */ new Set();
  const handlers = [
    ["Network.requestWillBeSent", (p) => inflight3.add(String(p.requestId))],
    ["Network.loadingFinished", (p) => inflight3.delete(String(p.requestId))],
    ["Network.loadingFailed", (p) => inflight3.delete(String(p.requestId))]
  ];
  for (const [m, h] of handlers) page.on(m, h);
  await page.send("Network.enable").catch(() => {
  });
  return {
    count: () => inflight3.size,
    stop: () => {
      for (const [m, h] of handlers) page.off(m, h);
    }
  };
}
async function evaluate(page, expression) {
  try {
    const r = await page.send("Runtime.evaluate", { expression, returnByValue: true }, { timeoutMs: EVAL_TIMEOUT_MS });
    return r.result?.value;
  } catch {
    return void 0;
  }
}
function urlMatcher(pattern) {
  const re = /^\/(.+)\/([a-z]*)$/.exec(pattern);
  if (re) {
    try {
      const rx = new RegExp(re[1], re[2]);
      return (u) => rx.test(u);
    } catch {
    }
  }
  if (pattern.includes("*")) {
    const rx = new RegExp(
      `^${pattern.split("*").map((s) => s.replace(/[.+?^${}()|[\]\\]/g, "\\$&")).join(".*")}$`
    );
    return (u) => rx.test(u);
  }
  return (u) => u.includes(pattern);
}
function checker(page, cond, now, net) {
  const hasText = (t) => evaluate(page, `(document.body ? document.body.innerText : "").includes(${JSON.stringify(t)})`);
  if ("text" in cond) return async () => await hasText(cond.text) === true;
  if ("gone" in cond) return async () => await hasText(cond.gone) === false;
  if ("selector" in cond) {
    const sel = JSON.stringify(cond.selector);
    return async () => await evaluate(
      page,
      `(() => { try { const el = document.querySelector(${sel}); return !!el && el.getClientRects().length > 0; } catch { return false; } })()`
    ) === true;
  }
  if ("url" in cond) {
    const match = urlMatcher(cond.url);
    return async () => {
      const href = await evaluate(page, "location.href");
      return typeof href === "string" && match(href);
    };
  }
  if ("load" in cond) return async () => await evaluate(page, 'document.readyState === "complete"') === true;
  if ("idle" in cond) {
    let quietSince;
    return async () => {
      if ((net?.count() ?? 0) > 0) {
        quietSince = void 0;
        return false;
      }
      quietSince ??= now();
      return now() - quietSince >= IDLE_MS;
    };
  }
  let streak = 0;
  return async () => {
    const probe = await probeChallenge({ page });
    streak = probe.ok && !probe.challenge?.blocking ? streak + 1 : 0;
    return streak >= 2;
  };
}
async function waitFor(session, cond, opts = {}) {
  const present = KEYS.filter((k) => k in cond);
  if (present.length !== 1) throw new TypeError(`invalid wait condition ${JSON.stringify(cond)}: give exactly one of ${KEYS.join(", ")}`);
  const { now, sleep: sleep2 } = browserDeps(opts.deps);
  const start = now();
  const live = () => {
    if (opts.signal?.aborted) throw new WaitCancelledError();
  };
  if ("ms" in cond) {
    for (let left = cond.ms; ; left = cond.ms - (now() - start)) {
      live();
      if (left <= 0) break;
      await sleep2(Math.min(POLL_MS2, left));
    }
    return { waitedMs: now() - start, matched: "ms" };
  }
  const timeoutMs = opts.timeoutMs ?? ("clear" in cond ? CLEAR_TIMEOUT_MS : DEFAULT_TIMEOUT_MS3);
  const net = "idle" in cond ? await watchNetwork(session.page) : void 0;
  try {
    const check = checker(session.page, cond, now, net);
    for (; ; ) {
      live();
      if (await check()) return { waitedMs: now() - start, matched: present[0] };
      const elapsed = now() - start;
      if (elapsed >= timeoutMs) throw new WaitTimeoutError(cond, elapsed);
      await sleep2(Math.min(POLL_MS2, timeoutMs - elapsed));
    }
  } finally {
    net?.stop();
  }
}
var WaitTimeoutError;
var WaitCancelledError;
var POLL_MS2;
var DEFAULT_TIMEOUT_MS3;
var CLEAR_TIMEOUT_MS;
var EVAL_TIMEOUT_MS;
var IDLE_MS;
var KEYS;
var init_wait = __esm({
  "src/browser/wait.ts"() {
    "use strict";
    init_brand();
    init_challenge();
    init_deps();
    WaitTimeoutError = class extends Error {
      constructor(condition, elapsedMs) {
        super(timeoutText(condition, elapsedMs));
        this.condition = condition;
        this.elapsedMs = elapsedMs;
        this.name = "WaitTimeoutError";
      }
      condition;
      elapsedMs;
    };
    WaitCancelledError = class extends Error {
      constructor() {
        super("the wait was cancelled");
        this.name = "WaitCancelledError";
      }
    };
    POLL_MS2 = 250;
    DEFAULT_TIMEOUT_MS3 = 3e4;
    CLEAR_TIMEOUT_MS = 3e5;
    EVAL_TIMEOUT_MS = 2e3;
    IDLE_MS = 500;
    KEYS = ["text", "gone", "selector", "url", "load", "idle", "ms", "clear"];
  }
});
var read_exports = {};
__export(read_exports, {
  closeBrowserReads: () => closeBrowserReads,
  readRenderedPage: () => readRenderedPage
});
function pump() {
  for (let next = queue[0]; next && active < next.limit; next = queue[0]) {
    queue.shift();
    active++;
    next.go();
  }
}
async function acquire(limit, signal, cancelled) {
  if (queue.length === 0 && active < limit) active++;
  else {
    await new Promise((resolve82, reject) => {
      const onAbort = () => {
        queue.splice(queue.indexOf(waiter), 1);
        reject(cancelled());
      };
      const waiter = {
        limit,
        go: () => {
          signal?.removeEventListener("abort", onAbort);
          resolve82();
        }
      };
      signal?.addEventListener("abort", onAbort, { once: true });
      queue.push(waiter);
    });
  }
  return () => {
    active--;
    pump();
  };
}
function track(p) {
  inflight.add(p);
  const done = () => inflight.delete(p);
  p.then(done, done);
  return p;
}
async function closeBrowserReads(opts = {}) {
  try {
    if (inflight.size > 0) {
      let timer;
      const bound = new Promise((r) => {
        timer = setTimeout(r, opts.waitMs ?? DRAIN_MS);
        timer.unref?.();
      });
      await Promise.race([Promise.allSettled([...inflight]), bound]);
      clearTimeout(timer);
    }
    const ours = launched;
    launched = void 0;
    if (!ours) return { closed: false };
    const deps = opts.deps ? browserDeps({ ...ours.deps, ...opts.deps }) : ours.deps;
    if (!await isSameBrowser(deps, ours.port, ours.host, ours.wsBrowserUrl)) return { closed: false };
    const saved2 = readSession();
    if (saved2?.wsBrowserUrl && socketPath(saved2.wsBrowserUrl) === socketPath(ours.wsBrowserUrl)) return { closed: false };
    let cdp;
    try {
      cdp = await deps.connectCdp(loopbackSocketUrl(ours.wsBrowserUrl));
    } catch {
      if (ours.pid === void 0) return { closed: false };
      deps.kill(ours.pid, "SIGTERM");
      return { closed: true };
    }
    try {
      await closeLaunched(cdp, ours.pid, deps);
    } finally {
      await cdp.close();
    }
    return { closed: true };
  } catch {
    return { closed: false };
  }
}
async function render(url, opts, deps, timeoutMs, run) {
  const { cdp, profile, headless, binary } = opts;
  const session = await withBrowserLock(
    async () => {
      if (run.stopped) throw new Error("stopped");
      return openBrowserSession({ cdp, profile, headless, binary, deps, scratch: true, ownOnly: true });
    },
    { deps }
  );
  run.session = session;
  if (session.spawned) {
    const { host, port, pid, browserSocket } = session;
    launched = { host, port, wsBrowserUrl: browserSocket, ...pid !== void 0 ? { pid } : {}, deps };
  }
  const page = session.page;
  let status;
  let mime;
  let mainFrame;
  const onResponse = (p) => {
    if (p.type !== "Document" || p.frameId !== mainFrame || typeof p.response?.status !== "number") return;
    status = p.response.status;
    mime = typeof p.response.mimeType === "string" ? p.response.mimeType : void 0;
  };
  try {
    if (run.stopped) throw new Error("stopped");
    mainFrame = (await page.send("Page.getFrameTree")).frameTree.frame.id;
    page.on("Network.responseReceived", onResponse);
    await page.send("Network.enable");
    await page.send("Page.setDownloadBehavior", { behavior: "deny" }).catch((e) => {
      throw new Error(`could not refuse downloads in the reading tab (${e.message}), so ${url} was not loaded`);
    });
    const nav = await session.navigate(url, { waitUntil: "load", timeoutMs });
    if (mime && !WEB_PAGE.test(mime)) throw new Error(`${url} is not a web page but ${mime}`);
    if (opts.waitUntil !== "load") {
      const idleMs = opts.waitUntil === "idle" ? timeoutMs / 2 : Math.min(IDLE_CAP_MS, timeoutMs);
      await waitFor(session, { idle: true }, { timeoutMs: idleMs, deps }).catch(() => {
      });
    }
    const challenge = await detectChallenge(session);
    const got = await page.send(
      "Runtime.evaluate",
      { expression: opts.fullPage ? WHOLE_DOCUMENT : READ_DOCUMENT, returnByValue: true },
      { timeoutMs }
    );
    const finalUrl = typeof got.result?.value?.url === "string" ? got.result.value.url : nav.url;
    const code = status ?? nav.status ?? 200;
    if (challenge?.blocking) {
      return {
        text: "",
        finalUrl,
        status: code >= 400 ? code : 403,
        extractor: "browser",
        note: `${challenge.kind} challenge \u2014 open it with \`${brand().cli} browser open ${url}\` and let the human solve it`
      };
    }
    const html = typeof got.result?.value?.html === "string" ? got.result.value.html : "";
    return { ...extractFromHtml(html, finalUrl, opts), finalUrl, status: code, extractor: "browser" };
  } finally {
    page.off("Network.responseReceived", onResponse);
    await deps.discovery.closeTarget(session.port, session.targetId, session.host).catch(() => {
    });
    await session.detach();
  }
}
function readRenderedPage(url, opts = {}) {
  return track(read(url, opts));
}
async function read(url, opts) {
  const cancelled = () => new Error(`reading ${url} in the browser was cancelled`);
  const { signal } = opts;
  if (signal?.aborted) throw cancelled();
  const deps = browserDeps(opts.deps);
  const timeoutMs = opts.timeoutMs ?? envInt("BROWSER_TIMEOUT_MS", 3e4, 5e3, 3e5);
  const release = await acquire(envInt("BROWSER_CONCURRENCY", 1, 1, 4), signal, cancelled);
  if (signal?.aborted) {
    release();
    throw cancelled();
  }
  const run = { stopped: false };
  const work = track(render(url, opts, deps, timeoutMs, run));
  work.then(release, release);
  let stop;
  const cut = new Promise((_, reject) => {
    stop = reject;
  });
  const timer = setTimeout(() => stop(new Error(`reading ${url} in the browser did not finish within ${timeoutMs} ms`)), timeoutMs);
  const onAbort = () => stop(cancelled());
  signal?.addEventListener("abort", onAbort, { once: true });
  try {
    return await Promise.race([work, cut]);
  } catch (e) {
    run.stopped = true;
    work.catch(() => {
    });
    await run.session?.detach();
    throw e;
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener("abort", onAbort);
  }
}
var IDLE_CAP_MS;
var WEB_PAGE;
var active;
var queue;
var DRAIN_MS;
var launched;
var inflight;
var WHOLE_DOCUMENT;
var init_read = __esm({
  "src/browser/read.ts"() {
    "use strict";
    init_brand();
    init_fetch();
    init_challenge();
    init_deps();
    init_launch();
    init_discovery();
    init_overlay();
    init_session();
    init_state();
    init_wait();
    IDLE_CAP_MS = 3e3;
    WEB_PAGE = /^(?:text\/html|application\/xhtml\+xml)$/i;
    active = 0;
    queue = [];
    DRAIN_MS = 5e3;
    inflight = /* @__PURE__ */ new Set();
    WHOLE_DOCUMENT = "({ html: document.documentElement ? document.documentElement.outerHTML : '', url: location.href })";
  }
});
init_brand();
init_pdf();
init_doc();
init_video();
init_session();
init_read();
init_cli_kit();
init_cdp();
init_overlay();
init_state();
init_challenge();
init_detect();
init_profile();
init_exec();
init_fetch();
init_markdown2();
init_firecrawl();
init_text();
init_url();
init_rank();
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
init_locale();
init_exec2();
init_brand();
init_exec2();
init_brand();
init_text();
var STALE_STAGING_MS = 24 * 60 * 60 * 1e3;
init_brand();
init_exec2();
init_fetch();
init_retry();
init_text();
var MAX_BODY_BYTES = 4 * 1024 * 1024;
init_fetch();
var NPM_TIME_TAIL_FIRST_BYTES = 256 * 1024;
var NPM_TIME_TAIL_BYTES = 2 * 1024 * 1024;
init_charset();
init_brand();
init_fetch();
var ROBOTS_TTL_MS = 24 * 60 * 60 * 1e3;
var UNREACHABLE_TTL_MS = 5 * 60 * 1e3;
init_entities();
init_fetch();
init_html();
init_charset();
init_fetch();
init_html();
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
  const open2 = openerRe(name);
  const close = closeTagRe(name);
  const out = [];
  open2.lastIndex = 0;
  let m;
  while (out.length < limit && (m = open2.exec(scan))) {
    const tagEnd = scan.indexOf(">", open2.lastIndex);
    if (tagEnd < 0) break;
    const attrs = xml.slice(open2.lastIndex, tagEnd);
    if (attrs.endsWith("/")) {
      out.push({ attrs: attrs.slice(0, -1), inner: "", from: m.index, to: tagEnd + 1 });
      open2.lastIndex = tagEnd + 1;
      continue;
    }
    close.lastIndex = tagEnd + 1;
    const c = close.exec(scan);
    if (!c) break;
    out.push({ attrs, inner: xml.slice(tagEnd + 1, c.index), from: m.index, to: c.index + c[0].length });
    open2.lastIndex = c.index + c[0].length;
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
  const stripped = dropElements(html, ["script", "style"], RAW_TEXT_ELEMENTS).replace(TAG_RE, (tag2) => INLINE_TAGS.has(tagName(tag2)) ? "" : " ").replace(LOOSE_TAG_RE, " ");
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
  const pick2 = links.find((a) => hrefOf(a) && (rels(a).length === 0 || rels(a).includes("alternate"))) ?? links.find((a) => hrefOf(a) && !rels(a).some((r) => NOT_THE_PAGE.has(r))) ?? links.find((a) => hrefOf(a));
  const href = pick2 && hrefOf(pick2);
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
  const blocks2 = elements(xml, atom ? "entry" : "item");
  const items = [];
  for (const block of blocks2) {
    const inner2 = block.inner;
    const it = {};
    const title2 = proseText(inner2, atom, "title");
    if (title2) it.title = title2;
    const url = itemUrl(inner2, atom ? xmlBase(block.attrs, feedBase) : feedBase);
    if (url) it.url = url;
    const published = tagText(inner2, "pubDate", "published", "updated", "dc:date");
    if (published) it.published = published;
    const summary = proseText(inner2, atom, "description", "summary") ?? clip2(proseText(inner2, atom, "content", "content:encoded"));
    if (summary) it.summary = summary;
    const id = tagText(inner2, "guid", "id");
    if (id) it.id = id;
    if (it.title || it.url) items.push(it);
  }
  let head = "";
  let last = 0;
  for (const b of blocks2) {
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
  const str5 = (v) => typeof v === "string" && v.trim() ? v.trim() : void 0;
  const items = [];
  for (const raw of Array.isArray(feed.items) ? feed.items : []) {
    if (!raw || typeof raw !== "object") continue;
    const entry = raw;
    const it = {};
    const id = typeof entry.id === "number" ? String(entry.id) : str5(entry.id);
    if (id) it.id = id;
    const url = str5(entry.url) ?? str5(entry.external_url);
    if (url) it.url = resolveUrl2(url, baseUrl);
    const title2 = str5(entry.title);
    if (title2) it.title = title2;
    const published = str5(entry.date_published) ?? str5(entry.date_modified);
    if (published) it.published = published;
    const html = str5(entry.content_html);
    const summary = str5(entry.summary) ?? clip2(str5(entry.content_text) ?? (html ? fragmentText2(html) : void 0));
    if (summary) it.summary = summary;
    if (it.title || it.url) items.push(it);
  }
  const title = str5(feed.title);
  return { kind: "json", items, ...title ? { title } : {} };
}
var SITEMAP_MAX_BYTES = 50 * 1024 * 1024;
var gunzipAsync = promisify(gunzip);
init_brand();
init_fetch();
init_locale();
init_url();
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
var element = (tag2, cls) => ({ open: new RegExp(`<${tag2}\\b([^<>]*)>`, "gi"), close: new RegExp(`</${tag2}\\s*>`, "i"), cls });
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
    const inner2 = html.slice(m.index + m[0].length);
    const end = el.close.exec(inner2);
    return end ? stripTags(inner2.slice(0, end.index)) : "";
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
init_brand();
init_fetch();
init_firecrawl();
init_locale();
init_url();
var SEARXNG_DEFAULT_BASE = "http://localhost:8888";
var PROBE_TIMEOUT_MS4 = 2e3;
function searxngBase(opts = {}) {
  const raw = (opts.searxng ?? env("SEARXNG") ?? SEARXNG_DEFAULT_BASE).trim();
  if (!raw || raw.toLowerCase() === "off") return null;
  return raw.replace(/\/+$/, "");
}
function searxngIsExplicit(opts = {}) {
  return !!(opts.searxng ?? env("SEARXNG"));
}
var probeCache2 = new ProbeMemo();
function probeSearxng(base2, explicit = false) {
  return probeCache2.get(`${base2}|${explicit}`, async () => {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), PROBE_TIMEOUT_MS4);
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
init_brand();
init_fetch();
init_doc();
init_video();
init_firecrawl();
init_url();
init_no_write();
init_brand();
init_mode();
var DEFAULT_TTL_MS = 24 * 60 * 60 * 1e3;
function cacheDir() {
  return namedCacheDir() ?? join13(tmpdir5(), userScoped(brand().name), "cache");
}
var namedCacheDir = () => env("CACHE_DIR") ?? brand().cacheDir;
function userScoped(name) {
  const uid = typeof process.getuid === "function" ? process.getuid() : void 0;
  return uid === void 0 ? name : `${name}-${uid}`;
}
function cachePath(url, acceptLanguage = "", extractor = "native", variant = "") {
  const canon = canonicalizeUrl(url);
  const domain = domainOf(url).replace(/[^a-z0-9.-]/gi, "_") || "url";
  const ns = extractor === "browser" ? "browser\0no-overlays" : extractor;
  const key = `${canon}\0${acceptLanguage}\0${ns}${variant ? `\0${variant}` : ""}`;
  return join13(cacheDir(), `${domain}-${fnv1a64(key).toString(16)}.json`);
}
var TEXT_VARIANTS = ["", "consent", "full"];
var MARKDOWN_VARIANTS = ["md", "consent-md", "full-md"];
var PLAIN = [""];
function variantOf(opts) {
  const read3 = opts.fullPage ? "full" : opts.stripConsent ? "consent" : "";
  if (opts.format !== "markdown") return read3;
  return read3 ? `${read3}-md` : "md";
}
var sameFormat = (variant) => MARKDOWN_VARIANTS.includes(variant) ? MARKDOWN_VARIANTS : TEXT_VARIANTS;
var PDF_CACHE_NS = "pdf";
var DOC_CACHE_NS = "doc";
var VIDEO_CACHE_NS = "video";
async function currentExtractor(opts, url) {
  if (looksLikePdfUrl(url)) return PDF_CACHE_NS;
  if (knownVideo(url)) return VIDEO_CACHE_NS;
  if (docFormatForUrl(url)) return DOC_CACHE_NS;
  if (browserFetchMode(opts.browser) === "always") return "browser";
  if (opts.fullPage) return "native";
  const base2 = firecrawlBase(opts);
  return base2 && await probeFirecrawl(base2, firecrawlIsExplicit(opts)) ? "firecrawl" : "native";
}
var DOCUMENT_NAMESPACES = [PDF_CACHE_NS, DOC_CACHE_NS, VIDEO_CACHE_NS, "pdf-inspector", "pdftotext", "anydoc", "ocr"];
var WRITTEN_NAMESPACES = ["native", "firecrawl", "browser", ...DOCUMENT_NAMESPACES];
var splitByVariant = (ns) => ns === "native" || ns === "browser";
function namespaceFor(result, predicted) {
  if (predicted === VIDEO_CACHE_NS && result.documentType !== "video") return result.extractor ?? "native";
  return result.documentType ?? (predicted === PDF_CACHE_NS || predicted === DOC_CACHE_NS || predicted === VIDEO_CACHE_NS ? predicted : result.extractor ?? "native");
}
function readAnyNamespace(url, acceptLanguage, namespaces = WRITTEN_NAMESPACES, variants = PLAIN) {
  let best;
  for (const ns of namespaces) {
    for (const variant of splitByVariant(ns) ? variants : PLAIN) {
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
  const fallback2 = brand().cacheTtlMs ?? DEFAULT_TTL_MS;
  const hours = env("CACHE_TTL_HOURS");
  if (hours !== void 0) {
    const h = Number(hours);
    return Number.isFinite(h) ? Math.round(Math.max(0, h) * 36e5) : fallback2;
  }
  return envInt("CACHE_TTL_MS", fallback2);
}
var mode = { refresh: false, offline: false };
function setCacheMode(next) {
  mode = { ...mode, ...next };
}
function cacheMode() {
  return { ...mode };
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
  const meta = cachePath(url, acceptLanguage, extractor, splitByVariant(extractor) ? variant : "");
  return { meta, body: meta.replace(/\.json$/, ".body") };
}
function readCache(url, acceptLanguage = "", extractor = "native", variant = "") {
  if (!entryDir(false)) return void 0;
  const { meta, body } = entryPaths(url, acceptLanguage, extractor, variant);
  if (!existsSync9(meta)) return void 0;
  try {
    const entry = JSON.parse(readFileSync9(meta, "utf8"));
    if (typeof entry.cachedAt !== "number") return void 0;
    const text = existsSync9(body) ? readFileSync9(body, "utf8") : entry.text;
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
  mkdirSync5(dir, { recursive: true });
  ensured.add(dir);
}
function openCacheDir(create) {
  const dir = cacheDir();
  const uid = typeof process.getuid === "function" ? process.getuid() : void 0;
  if (namedCacheDir() !== void 0 || uid === void 0) {
    if (create) ensureDir2(dir);
    return { dir };
  }
  if (create) mkdirSync5(dirname(dirname(dir)), { recursive: true });
  for (const p of [dirname(dir), dir]) {
    if (create) mkdirPrivate(p);
    let st;
    try {
      st = lstatSync2(p);
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
        chmodSync2(p, 448);
      } catch {
      }
    }
  }
  return { dir };
}
function mkdirPrivate(p) {
  try {
    mkdirSync5(p, { mode: 448 });
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
    const { note: _stored, browserTried: _tried, ...rest } = entry;
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
  const fallback2 = browserFetchMode(opts.browser) === "fallback";
  const store = (result, tried = false) => {
    const target = namespaceFor(result, ns);
    let entry = ns === "firecrawl" && target === "native" ? { ...result, fallbackFrom: "firecrawl" } : result;
    if (tried && wouldRender(entry)) entry = { ...entry, browserTried: true };
    writeCache(url, entry, now, lang, target, variant);
  };
  const hit = refresh ? void 0 : lookup(url, lang, ns, variant, fallback2);
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
  const unconditional = res === void 0;
  res ??= await fetchAndExtract(url, opts);
  if (res.text?.trim()) {
    store(res, fallback2 && unconditional);
    return res;
  }
  const stale = hit ?? readAnyCopy(url, lang, variant);
  if (stale) return served(stale, `${url} returned ${res.status || "no response"}; served the cached copy from ${new Date(stale.cachedAt).toISOString()}.`);
  return res;
}
function lookup(url, acceptLanguage, ns, variant, browserFallback = false) {
  const own = lookupOwn(url, acceptLanguage, ns, variant);
  const best = browserFallback && own && wouldRender(own) ? void 0 : own;
  const rendered = browserFallback ? readCache(url, acceptLanguage, "browser", variant) : void 0;
  return rendered && (!best || rendered.cachedAt > best.cachedAt) ? rendered : best;
}
var wouldRender = (entry) => !entry.browserTried && !entry.documentType && ["native", "firecrawl"].includes(entry.extractor ?? "native") && worthRendering(entry) !== void 0;
function lookupOwn(url, acceptLanguage, ns, variant) {
  const best = readAnyNamespace(url, acceptLanguage, [.../* @__PURE__ */ new Set([ns, ...DOCUMENT_NAMESPACES])], [variant]);
  if (ns === VIDEO_CACHE_NS && !best) return readCache(url, acceptLanguage, "native", variant);
  if (ns !== "firecrawl") return best;
  const fallback2 = readCache(url, acceptLanguage, "native", variant);
  return fallback2?.fallbackFrom === "firecrawl" && (!best || fallback2.cachedAt > best.cachedAt) ? fallback2 : best;
}
var ORPHAN_GRACE_MS = 10 * 60 * 1e3;
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
  const base2 = join14(cacheDir(), "compose");
  return [
    { path: join14(base2, "docker-compose.yml"), content: renderAsset(COMPOSE_YAML) },
    { path: join14(base2, "docker", "searxng", "settings.yml"), content: renderAsset(SEARXNG_SETTINGS_YAML) },
    { path: join14(base2, "docker", "firecrawl", "firecrawl.env"), content: renderAsset(FIRECRAWL_ENV) }
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
      body = readFileSync10(a.path, "utf8");
    } catch {
    }
    if (body !== a.content) return `${a.path} does not hold the stack this binary ships, and could not be rewritten`;
  }
  const uid = typeof process.getuid === "function" ? process.getuid() : void 0;
  if (uid === void 0) return void 0;
  const root = resolve5(cacheDir());
  const chosen = !!(env("CACHE_DIR") ?? brand().cacheDir);
  const top = chosen ? root : dirname2(root);
  const paths = /* @__PURE__ */ new Set();
  for (const a of assets) {
    for (let p = resolve5(a.path); p !== top && p !== dirname2(p); p = dirname2(p)) paths.add(p);
  }
  for (const p of [top, ...paths]) {
    try {
      const st = p === top && chosen ? statSync8(p) : lstatSync3(p);
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
    if (existsSync10(path) && readFileSync10(path, "utf8") === content) return;
    mkdirSync6(dirname2(path), { recursive: true, mode: 448 });
    writeFileSync6(path, content);
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
  const tag2 = `${brand().cli} ${names.join("+")}`;
  const spec = combine(names);
  if (!spec) {
    const bad = names.filter((n) => !STACKS[n]);
    return { message: `${brand().cli}: unknown service ${bad.map((b) => `"${b}"`).join(", ")} \u2014 expected one of ${STACK_SERVICES.join(", ")}`, code: 1 };
  }
  if (action !== "up" && action !== "down" && action !== "status") {
    return { message: `${tag2}: unknown action "${action}" (use: up | down | status)`, code: 1 };
  }
  if (!has("docker")) {
    return { message: `${tag2}: docker not found on PATH. The stack is optional \u2014 everything it provides degrades to a note.`, code: 1 };
  }
  const file = ensureComposeMaterialized();
  const distrust = untrustedStack();
  if (distrust) {
    return {
      message: `${tag2}: refusing to run docker against the stack in ${dirname2(file)} \u2014 ${distrust}. Set ${envName("CACHE_DIR")} to a directory only you can write.`,
      code: 1
    };
  }
  const daemon = run("docker", ["info", "--format", "{{.ServerVersion}}"], { timeoutMs: DAEMON_PROBE_TIMEOUT_MS, capture: true });
  if (!daemon.ok) {
    const why = daemon.stderr.trim().split("\n")[0];
    return {
      message: `${tag2}: docker is installed but its daemon is not answering \u2014 start Docker (Docker Desktop, colima, or \`systemctl start docker\`) and retry.${why ? `
${why}` : ""}`,
      code: 1
    };
  }
  const profiles = spec.profiles.flatMap((p) => ["--profile", p]);
  if (action === "down") {
    const r = run("docker", ["compose", "-f", file, ...profiles, "down"], { timeoutMs: DOWN_TIMEOUT_MS, capture: true });
    return { message: r.ok ? `${tag2}: stopped.` : `${tag2}: down failed.
${r.stderr}`, code: r.ok ? 0 : 1 };
  }
  if (action === "status") {
    const r = run("docker", ["compose", "-f", file, ...profiles, "ps"], { timeoutMs: PS_TIMEOUT_MS, capture: true });
    return { message: r.ok ? r.stdout.trim() || `${tag2}: no services running.` : `${tag2}: status failed.
${r.stderr}`, code: r.ok ? 0 : 1 };
  }
  const pulled = run("docker", ["compose", "-f", file, ...profiles, "pull"], { timeoutMs: pullTimeoutMs() });
  if (!pulled.ok) {
    const why = pulled.timedOut ? ` after ${pullTimeoutMs()}ms (the images are large \u2014 raise ${envName("DOCKER_PULL_TIMEOUT_MS")})` : " \u2014 docker's output above says why";
    return { message: `${tag2}: pulling the images failed${why}.${pulled.stderr ? `
${pulled.stderr}` : ""}`, code: 1 };
  }
  const up = run("docker", ["compose", "-f", file, ...profiles, "up", "-d", "--wait"], { timeoutMs: UP_TIMEOUT_MS });
  if (!up.ok) {
    const why = up.timedOut ? ` \u2014 the services were not healthy within ${UP_TIMEOUT_MS / 1e3}s` : "";
    return { message: `${tag2}: up failed${why}.${up.stderr ? `
${up.stderr}` : ""}`, code: 1 };
  }
  return { message: [`${tag2}: ${spec.summary}`, ...spec.postUp?.(file, run) ?? []].join("\n"), code: 0 };
}
init_pool();
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
init_no_write();
init_no_write();
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
    return JSON.parse(readFileSync11(path, "utf8"));
  } catch {
    return void 0;
  }
}
init_fetch();
var FINGERPRINT_MAX_BYTES = 64 * 1024 * 1024;
init_tables();
init_brand();
init_fetch();
init_pool();
init_html();
init_markdown2();
init_url();
var nextFree = /* @__PURE__ */ new Map();
var holdUntil = /* @__PURE__ */ new Map();
var MAX_TIMER_MS = 2 ** 31 - 1;
async function sleepFor(ms, signal) {
  for (let left = ms; left > 0 && !signal?.aborted; left -= MAX_TIMER_MS) await sleep(Math.min(left, MAX_TIMER_MS), signal);
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
init_brand();
init_fetch();
init_pool();
init_brand();
init_fetch();
init_rank();
var TOKEN_RE2 = /\[([^\]\n]+)\](?!\()/g;
function stripHtmlComments(text) {
  return text.replace(/<!--[\s\S]*?-->/g, (m) => m.replace(/[^\n]/g, " "));
}
function stripInlineCode(line) {
  return line.replace(/`[^`\n]*`/g, " ");
}
function codeMask(lines) {
  const mask = new Array(lines.length).fill(false);
  let open2;
  for (let i = 0; i < lines.length; i++) {
    const m = /^\s*(`{3,}|~{3,})(.*)$/.exec(lines[i]);
    if (!open2) {
      if (m && !(m[1][0] === "`" && m[2].includes("`"))) {
        open2 = { ch: m[1][0], len: m[1].length };
        mask[i] = true;
      }
      continue;
    }
    mask[i] = true;
    if (m && m[1][0] === open2.ch && m[1].length >= open2.len && m[2].trim() === "") open2 = void 0;
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
init_brand();
init_no_write();
init_brand();
var WORKFLOW_FORBIDDEN = ["Date.now(", "Math.random(", "new Date("];
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
function emitWorkflowScript(phase, emission, runAbs, engineAbs, smallWorklist, constants2 = {}) {
  const cli = brand().cli;
  const scriptPath = join16(runAbs, "orchestration", `${phase.name}.workflow.mjs`);
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
    ...Object.entries(constants2).map(([name, value]) => `const ${name} = ${JSON.stringify(value)}`),
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
        `Fan out: \`Workflow({ scriptPath: "${join16(runAbs, "orchestration", `${ph.name}.workflow.mjs`)}" })\``,
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
function listPhases(runDir, engineAbs, defs) {
  const run = resolve6(runDir);
  return defs.map((def) => {
    const worklist = join17(run, def.worklist);
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
  const run = resolve6(runDir);
  if (!existsSync11(run)) {
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
  const orchDir = join17(run, "orchestration");
  const agentsDir = join17(orchDir, "agents");
  ensureDir(join17(orchDir, "out"));
  ensureDir(agentsDir);
  const written = [];
  const notices = [];
  for (const [name, content] of Object.entries(contracts(run, engineAbs, phases))) {
    written.push(writeArtifact(join17(agentsDir, `${name}.md`), content));
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
      written.push(writeArtifact(join17(orchDir, `${ph.name}.workflow.mjs`), emitWorkflowScript(ph, def, run, engineAbs, small, opts.constants)));
    }
  }
  written.push(writeArtifact(join17(orchDir, "RUNBOOK.md"), runbookMd(phases, defs, run, engineAbs, brand().cli, opts.runbookPreamble, small)));
  return { exitCode: 0, written, notices, errors: [], phases };
}
init_cli_kit();
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
init_brand();
init_brand();
var skillName = () => brand().name;
var URI_SCHEME = "skill://";
function resolveSkillRoot(moduleDir) {
  const here = moduleDir ?? dirname3(fileURLToPath(import.meta.url));
  const name = brand().name;
  const candidates2 = [resolve7(here, ".."), resolve7(here, "..", "skills", name), resolve7(here, "..", "..", "skills", name)];
  return candidates2.find((dir) => existsSync12(join18(dir, "SKILL.md")));
}
function listResources(moduleDir) {
  const root = resolveSkillRoot(moduleDir);
  if (!root) return [];
  const out = [describe(root, "SKILL.md", `${skillName()}: the skill`)];
  const refDir = join18(root, "references");
  if (!existsSync12(refDir)) return out;
  for (const file of readdirSync8(refDir).sort()) {
    if (!file.endsWith(".md")) continue;
    out.push(describe(root, join18("references", file), `${skillName()} reference: ${basename4(file, ".md")}`));
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
  const target = resolve7(root, rel);
  const served = relative(root, target).split(sep2).join("/");
  if (served !== "SKILL.md" && !/^references\/[^/]+\.md$/.test(served)) {
    throw new ResourceError(`not a resource this server serves: ${uri} (resources/list names them)`);
  }
  const rootReal = realpathSync2(root);
  let targetReal;
  try {
    targetReal = realpathSync2(target);
  } catch {
    throw new ResourceError(`no such resource: ${uri}`);
  }
  if (targetReal !== rootReal && !targetReal.startsWith(rootReal + sep2)) {
    throw new ResourceError(`resource path escapes the skill root: ${uri}`);
  }
  if (!statSync9(targetReal).isFile()) throw new ResourceError(`not a file: ${uri}`);
  return { uri, mimeType: "text/markdown", text: readFileSync12(targetReal, "utf8") };
}
var ResourceError = class extends Error {
};
function describe(root, rel, fallbackTitle) {
  const decl = {
    uri: `${URI_SCHEME}${rel.split(sep2).join("/")}`,
    name: rel.split(sep2).join("/"),
    title: fallbackTitle,
    mimeType: "text/markdown"
  };
  const summary = firstProse(join18(root, rel));
  if (summary) decl.description = summary;
  return decl;
}
function firstProse(file) {
  let text;
  try {
    text = readFileSync12(file, "utf8");
  } catch {
    return void 0;
  }
  const body = text.startsWith("---\n") ? text.slice(text.indexOf("\n---", 3) + 4) : text;
  for (const block of body.split(/\n\s*\n/)) {
    const line = block.trim();
    if (!line || line.startsWith("#") || line.startsWith(">") || line.startsWith("|") || line.startsWith("```")) continue;
    const flat2 = line.replace(/\s+/g, " ").replace(/[*`]/g, "");
    return flat2.length > 300 ? `${flat2.slice(0, 297)}\u2026` : flat2;
  }
  return void 0;
}
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
  const active22 = /* @__PURE__ */ new Map();
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
        if (typeof target === "string" || typeof target === "number") active22.get(target)?.cancel();
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
    active22.set(id, request);
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
      if (active22.get(id) === request) active22.delete(id);
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
      const { text: raw, artifact, images } = await adapter.callTool(name, normalized, context);
      const text = capResponse(raw, name, maxBytes, artifact, adapter.capAdvice);
      const capped = text !== raw;
      const structured = protocol >= RICH_TOOLS_SINCE ? structuredContentFor(text, capped, decl.outputSchema !== void 0) : void 0;
      const pictures = (images ?? []).map((i) => ({ type: "image", data: i.data, mimeType: i.mimeType }));
      reply({ result: { content: [{ type: "text", text }, ...pictures], ...structured ? { structuredContent: structured } : {} } });
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
  const track2 = (p) => {
    inFlight.add(p);
    void p.finally(() => inFlight.delete(p));
    return p;
  };
  let active22 = 0;
  const waiting = [];
  const queued = /* @__PURE__ */ new Map();
  let negotiated;
  const handleOpts = { notify: send };
  const runToolCall = async (msg, id, reply) => {
    const ticket = { cancelled: false };
    queued.set(id, ticket);
    try {
      while (active22 >= MAX_IN_FLIGHT) await new Promise((resolve82) => waiting.push(resolve82));
    } finally {
      if (queued.get(id) === ticket) queued.delete(id);
    }
    if (ticket.cancelled) {
      waiting.shift()?.();
      return;
    }
    active22++;
    try {
      await server.handle(msg, reply, handleOpts);
    } finally {
      active22--;
      waiting.shift()?.();
    }
  };
  const dispatch3 = async (msg, reply) => {
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
        track2(
          (async () => {
            const out = [];
            await Promise.all(batch.map((m) => dispatch3(m, (r) => void out.push(r))));
            if (out.length) emit(JSON.stringify(out) + "\n");
          })().catch(reportInternal(send))
        );
        continue;
      }
      if (parsed === null || typeof parsed !== "object") {
        send({ jsonrpc: "2.0", id: null, error: { code: ERR_INVALID_REQUEST, message: "invalid request: expected a JSON-RPC object" } });
        continue;
      }
      track2(dispatch3(parsed, send).catch(reportInternal(send)));
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
init_brand();
var MCP_PATH = "/mcp";
var MAX_BODY_BYTES2 = 4 * 1024 * 1024;
var REQUEST_TIMEOUT_MS2 = 6e4;
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
  server.requestTimeout = REQUEST_TIMEOUT_MS2;
  server.headersTimeout = 6e4;
  server.keepAliveTimeout = 12e4;
  return new Promise((resolve82, reject) => {
    server.once("error", reject);
    server.listen(opts.port ?? 0, bind, () => {
      server.removeListener("error", reject);
      const addr = server.address();
      const port = typeof addr === "object" && addr ? addr.port : opts.port ?? 0;
      const host = bind.includes(":") ? `[${bind}]` : bind;
      resolve82({
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
  const digest = (s) => createHash4("sha256").update(s).digest();
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
  return new Promise((resolve82, reject) => {
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
      else resolve82(Buffer.concat(chunks).toString("utf8"));
    });
    req.on("error", reject);
    req.on("aborted", () => reject(new Error("client aborted the request")));
  });
}

// src/stack.ts
import { homedir as homedir3 } from "os";
import { join as join4 } from "path";
function withStackCache(action) {
  const key = brand().envPrefix + "_CACHE_DIR";
  const saved2 = process.env[key];
  process.env[key] = process.env.ULTRA_STACK_CACHE_DIR || join4(homedir3(), ".cache", "skills");
  try {
    return action();
  } finally {
    if (saved2 === void 0) delete process.env[key];
    else process.env[key] = saved2;
  }
}
function sharedStackControl(service, action, deps = {}) {
  return withStackCache(() => stackControl(service, action, deps));
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
  const pick2 = (bibliographic ? paras[1] : lead) || lead;
  return pick2.slice(0, 200) || text.trim().replace(/\s+/g, " ").slice(0, 200);
}
var BACKEND_TRUST = {
  arxiv: 0.9,
  crossref: 0.9,
  openalex: 0.9,
  semanticscholar: 0.9,
  europepmc: 0.9,
  pubmed: 0.9,
  clinicaltrials: 0.9,
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
  // Community threads (reddit, the Pepper deal sites): the route says "people said
  // this", nothing more — spelled out at the neutral value so the omission reads
  // as a decision.
  reddit: 0.5,
  pepper: 0.5,
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
  const add2 = (re, group = 0) => {
    for (const m of question.matchAll(re)) {
      const v = (m[group] ?? m[0]).trim();
      if (v) out.add(v);
    }
  };
  add2(/\bv?\d+(?:\.\d+){1,}\b/g);
  add2(/\b10\.\d{4,}\/\S+/g);
  add2(/\b\d{4}\.\d{4,5}(?:v\d+)?\b/g);
  add2(/\b[a-z]+(?:[A-Z][a-z0-9]+)+\b/g);
  add2(/\b[A-Za-z]+_[A-Za-z0-9_]+\b/g);
  add2(/\b\d{3,}\b/g);
  add2(/"([^"\n]{3,})"/g, 1);
  return [...out];
}
function planVariants(question, depth) {
  const base2 = question.trim();
  const variants = base2 ? [base2] : [];
  const kw = rankedKeywords(question).slice(0, 8).join(" ");
  if (kw && kw.toLowerCase() !== base2.toLowerCase()) variants.push(kw);
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
  return uniq.slice(0, n).length ? uniq.slice(0, n) : [base2];
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
var RUN_SLUG = { max: 80, fallback: "run" };

// src/backends/searxng.ts
var searxngBackend = async (ctx) => {
  const base2 = searxngBase({ searxng: ctx.options.searxng });
  if (!base2) {
    return {
      backend: "searxng",
      items: [],
      notes: ["SearXNG disabled (--searxng off / ULTRASEARCH_SEARXNG=off). Skipping."]
    };
  }
  const explicit = searxngIsExplicit({ searxng: ctx.options.searxng });
  if (!await probeSearxng(base2, explicit)) {
    return {
      backend: "searxng",
      items: [],
      notes: [
        explicit ? `SearXNG not reachable at ${base2}. Skipping; consider your own WebSearch.` : `SearXNG not running at ${base2} \u2014 start it with \`ultrasearch searxng up\` for a local, keyless discovery backend. Skipping.`
      ]
    };
  }
  const pages = Math.max(1, ctx.options.pages ?? 1);
  const acceptLanguage = acceptLanguageHeader(ctx.options.lang, ctx.options.region);
  const perPage = ctx.options.perSource * 2;
  const base0 = `${base2}/search?q=${encodeURIComponent(ctx.question)}&format=json&safesearch=1${ctx.options.lang ? `&language=${encodeURIComponent(ctx.options.lang)}` : ""}${ctx.options.since ? `&time_range=year` : ""}`;
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
          notes: [`SearXNG ${why} at ${base2}. Skipping; consider your own WebSearch.`]
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
          notes: [`SearXNG at ${base2} did not return JSON (the instance likely disables format=json).`]
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
function parseDdgPage(body, limit) {
  const found = [];
  const blockRe = /<a\b([^>]*\bresult__a\b[^>]*)>([\s\S]*?)<\/a>([\s\S]*?)(?=<a\b[^>]*\bresult__a\b|$)/gi;
  let m;
  while ((m = blockRe.exec(body)) && found.length < limit) {
    const href0 = /\bhref="([^"]+)"/.exec(m[1]);
    if (!href0) continue;
    const href = ddgRedirectTarget(href0[1]);
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
    const href = ddgRedirectTarget(href0[1]);
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

// src/browser.ts
var ENV = "ULTRASEARCH_BROWSER_FETCH";
var NO_BINARY = "no Chrome, Brave, Chromium or Edge found (install one, or point ULTRASEARCH_BROWSER_BIN at it)";
function canShowWindow(platform, env2) {
  if (platform === "darwin" || platform === "win32") return true;
  return !!(env2.DISPLAY || env2.WAYLAND_DISPLAY);
}
function resolveBrowserRung(opts = {}) {
  const env2 = opts.env ?? process.env;
  const platform = opts.platform ?? process.platform;
  const detect = () => {
    try {
      const found = (opts.detect ?? (() => detectBrowserBinary({ processEnv: env2, platform, env: (suffix) => env2[`ULTRASEARCH_${suffix}`] })))();
      return found ? { binary: found, missing: NO_BINARY } : { missing: NO_BINARY };
    } catch (e) {
      return { missing: e instanceof Error ? e.message : String(e) };
    }
  };
  const on = (mode2, source2) => {
    const { binary: binary2, missing: missing2 } = detect();
    return binary2 ? { mode: mode2, source: source2, binary: binary2 } : { mode: mode2, source: source2, reason: missing2 };
  };
  if (opts.flag !== void 0) return opts.flag === "off" ? { mode: "off", source: "flag", reason: "--browser off" } : on(opts.flag, "flag");
  const raw = env2[ENV]?.trim();
  if (raw) {
    const m = raw.toLowerCase();
    return m === "always" || m === "fallback" ? on(m, "env") : { mode: "off", source: "env", reason: `${ENV}=${raw}` };
  }
  if (opts.noWrite ?? isNoWrite()) {
    return { mode: "off", source: "default", reason: "--stdout / ULTRASEARCH_NO_WRITE: nothing may be written, and a browser writes its profile" };
  }
  const { binary, missing } = detect();
  if (!binary) return { mode: "off", source: "default", reason: missing };
  if (!canShowWindow(platform, env2)) {
    return { mode: "off", source: "default", binary, reason: "no display to show a browser window in (Linux without DISPLAY or WAYLAND_DISPLAY)" };
  }
  return { mode: "fallback", source: "default", binary };
}
function rescuesEmptyRead(status, mode2) {
  return mode2 === "fallback" && status === 402;
}
var BROWSER_RESCUE_CAP = 8;
function describeBrowserRung(r) {
  if (r.mode === "off") return { name: "browser", ok: false, detail: `off \u2014 ${r.reason ?? "disabled"}` };
  if (!r.binary) return { name: "browser", ok: false, detail: `${r.mode} (from ${originOf(r)}), but ${r.reason ?? NO_BINARY}` };
  const what = r.mode === "always" ? "renders every web page" : "renders a page the built-in reader was refused, walled or handed a JS shell for";
  return {
    name: "browser",
    ok: true,
    detail: `${r.mode} (${originOf(r)}) \u2014 ${r.binary.kind} at ${r.binary.path}; ${what}, in its own profile (${browserHome()}). A window may open during a run. \`--browser off\` to disable.`
  };
}
function originOf(r) {
  return r.source === "flag" ? "--browser" : r.source === "env" ? ENV : "default: a browser is installed and a window can be shown";
}
var sharing = 0;
var closing;
async function withBrowserClosed(fn) {
  while (closing) await closing;
  sharing++;
  try {
    return await fn();
  } finally {
    if (--sharing === 0) {
      const done = closeBrowserReads().finally(() => {
        if (closing === done) closing = void 0;
      });
      closing = done;
      await done;
    }
  }
}
function closeBrowserOnSignal() {
  const on = (sig) => {
    void closeBrowserReads({ waitMs: 0 }).finally(() => process.exit(sig === "SIGINT" ? 130 : 143));
  };
  process.once("SIGINT", on);
  process.once("SIGTERM", on);
  return () => {
    process.off("SIGINT", on);
    process.off("SIGTERM", on);
  };
}

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
  const extractOpts = {
    acceptLanguage: acceptLanguageHeader(ctx.options.lang, ctx.options.region),
    firecrawl: ctx.options.firecrawl,
    browser: ctx.options.browser ?? resolveBrowserRung().mode
  };
  const fetched = await mapLimit(urls, ctx.options.concurrency ?? 6, (url) => cachedFetchAndExtract(url, extractOpts, !!ctx.options.cache));
  const items = [];
  const notes = [];
  for (let i = 0; i < urls.length; i++) {
    const url = urls[i];
    const { text, title, note, finalUrl, extractor } = fetched[i];
    if (note) notes.push(note);
    if (!text) continue;
    items.push({
      url: finalUrl || url,
      // record the post-redirect URL for provenance + exclude
      title: title || finalUrl || url,
      backend: "generic",
      score: urls.length - i,
      snippet: bestExcerpt(text, ctx.question),
      text,
      ...extractor ? { meta: { extractor } } : {}
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

// src/backends/backoff.ts
function isThrottled(a) {
  return a.status === 429 || a.status === 503 || a.rateLimited === true;
}
async function withBackoff(call, opts = {}) {
  const attempts = Math.max(1, Math.floor(opts.attempts ?? 3));
  const baseMs = opts.baseMs ?? envInt("BACKOFF_MS", 1e3, 0, 6e4);
  const capMs = opts.capMs ?? envInt("BACKOFF_CAP_MS", 3e4, 0, 3e5);
  const pause = opts.sleepFn ?? sleep;
  let waitedMs = 0;
  for (let i = 1; ; i++) {
    const result = await call();
    if (!isThrottled(result)) return { result, attempts: i, waitedMs, rateLimited: false };
    if (i >= attempts) return { result, attempts: i, waitedMs, rateLimited: true };
    const asked = result.retryAfterMs;
    if (asked !== void 0 && asked > capMs) {
      return { result, attempts: i, waitedMs, rateLimited: true, gaveUpOnRetryAfterMs: asked };
    }
    const wait = asked ?? baseMs * 2 ** (i - 1);
    if (wait > 0) await pause(wait);
    waitedMs += wait;
  }
}
async function apiGet(url, opts = {}) {
  const accept = opts.accept ?? "application/json";
  const out = await withBackoff(
    () => httpGet(url, { accept, retries: 0, timeoutMs: opts.timeoutMs ?? 12e3, ...opts.userAgent ? { userAgent: opts.userAgent } : {} }),
    opts
  );
  const r = out.result;
  let data = r.body;
  if (opts.json !== false && r.body) {
    try {
      data = JSON.parse(r.body);
    } catch {
      data = r.body;
    }
  }
  return { ok: r.ok, status: r.status, data, rateLimited: out.rateLimited, attempts: out.attempts, ...r.error ? { error: r.error } : {} };
}
function apiFailure(label, r) {
  if (r.rateLimited || r.status === 429 || r.status === 503) {
    return `${label} rate-limited (HTTP ${r.status}${r.attempts > 1 ? ` after ${r.attempts} attempts` : ""}).`;
  }
  return `${label} failed or empty (status ${r.status}).`;
}

// src/backends/crossref.ts
var crossrefBackend = async (ctx) => {
  const n = Math.max(3, Math.min(15, ctx.options.perSource));
  const since = sinceDate(ctx.options.since);
  const url = `https://api.crossref.org/works?query=${encodeURIComponent(ctx.question)}&rows=${n}` + (since ? `&filter=from-pub-date:${since}` : "");
  const r = await apiGet(url, { userAgent: contactUa() });
  const items0 = r.ok && Array.isArray(r.data?.message?.items) ? r.data.message.items : [];
  if (!r.ok || !items0.length) {
    return { backend: "crossref", items: [], notes: [apiFailure("Crossref search", r)] };
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
  const r = await apiGet(url);
  const results = r.ok && Array.isArray(r.data?.results) ? r.data.results : [];
  if (!r.ok || !results.length) {
    return { backend: "openalex", items: [], notes: [apiFailure("OpenAlex search", r)] };
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
  const r = await apiGet(url);
  const data = r.ok && Array.isArray(r.data?.data) ? r.data.data : [];
  if (!r.ok || !data.length) {
    return { backend: "semanticscholar", items: [], notes: [apiFailure("Semantic Scholar search", r)] };
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
  const r = await apiGet(url);
  const results = r.ok && Array.isArray(r.data?.resultList?.result) ? r.data.resultList.result : [];
  if (!r.ok || !results.length) {
    return { backend: "europepmc", items: [], notes: [apiFailure("Europe PMC search", r)] };
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
  const base2 = "https://eutils.ncbi.nlm.nih.gov/entrez/eutils";
  const esearch2 = `${base2}/esearch.fcgi?db=pubmed&retmode=json&retmax=${n}&tool=ultrasearch&term=${encodeURIComponent(ctx.question)}`;
  const sr = await apiGet(esearch2);
  const ids = sr.ok && Array.isArray(sr.data?.esearchresult?.idlist) ? sr.data.esearchresult.idlist : [];
  if (!sr.ok || !ids.length) {
    return { backend: "pubmed", items: [], notes: [apiFailure("PubMed esearch", sr)] };
  }
  const esummary2 = `${base2}/esummary.fcgi?db=pubmed&retmode=json&tool=ultrasearch&id=${ids.join(",")}`;
  const dr = await apiGet(esummary2);
  const result = dr.ok ? dr.data?.result : void 0;
  if (!result) {
    return { backend: "pubmed", items: [], notes: [dr.rateLimited ? apiFailure("PubMed esummary", dr) : `PubMed esummary failed (status ${dr.status}).`] };
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

// src/backends/clinicaltrials.ts
var API = "https://clinicaltrials.gov/api/v2/studies";
var titleCase = (s) => s.toLowerCase().replace(/_/g, " ").replace(/^\w/, (c) => c.toUpperCase());
function studyText(study) {
  const p = study?.protocolSection ?? {};
  const id = p.identificationModule ?? {};
  const status = p.statusModule ?? {};
  const design = p.designModule ?? {};
  const desc = p.descriptionModule ?? {};
  const nctId = typeof id.nctId === "string" ? id.nctId : void 0;
  const title = cleanInline(String(id.briefTitle ?? id.officialTitle ?? nctId ?? "Untitled")) || "Untitled";
  const start = status.startDateStruct?.date;
  const year = start ? Number(String(start).slice(0, 4)) || void 0 : void 0;
  const sponsor = p.sponsorCollaboratorsModule?.leadSponsor?.name;
  const phases = Array.isArray(design.phases) ? design.phases.filter((x) => x && x !== "NA") : [];
  const lines = [`# ${title}`, ""];
  const facts = [
    ["Registry id", nctId],
    ["Official title", id.officialTitle && id.officialTitle !== id.briefTitle ? cleanInline(String(id.officialTitle)) : void 0],
    ["Status", status.overallStatus ? titleCase(String(status.overallStatus)) + (status.whyStopped ? ` \u2014 ${status.whyStopped}` : "") : void 0],
    ["Study type", design.studyType ? titleCase(String(design.studyType)) : void 0],
    ["Phase", phases.length ? phases.map((x) => x.replace(/^PHASE/, "Phase ")).join(", ") : void 0],
    ["Allocation", design.designInfo?.allocation ? titleCase(String(design.designInfo.allocation)) : void 0],
    ["Masking", design.designInfo?.maskingInfo?.masking ? titleCase(String(design.designInfo.maskingInfo.masking)) : void 0],
    [
      "Enrollment",
      design.enrollmentInfo?.count !== void 0 ? `${design.enrollmentInfo.count}${design.enrollmentInfo.type ? ` (${String(design.enrollmentInfo.type).toLowerCase()})` : ""}` : void 0
    ],
    ["Conditions", Array.isArray(p.conditionsModule?.conditions) ? p.conditionsModule.conditions.join("; ") : void 0],
    [
      "Interventions",
      Array.isArray(p.armsInterventionsModule?.interventions) ? p.armsInterventionsModule.interventions.map((i) => [i?.type ? titleCase(String(i.type)) : "", i?.name].filter(Boolean).join(": ")).join("; ") : void 0
    ],
    ["Lead sponsor", sponsor],
    ["Start", start],
    ["Primary completion", status.primaryCompletionDateStruct?.date],
    ["Results posted", study?.hasResults === true ? "yes" : study?.hasResults === false ? "no" : void 0]
  ];
  for (const [k, v] of facts) if (v) lines.push(`- ${k}: ${v}`);
  const primary = Array.isArray(p.outcomesModule?.primaryOutcomes) ? p.outcomesModule.primaryOutcomes : [];
  if (primary.length) {
    lines.push("", "## Primary outcomes");
    for (const o of primary) lines.push(`- ${cleanInline(String(o?.measure ?? ""))}${o?.timeFrame ? ` (${o.timeFrame})` : ""}`);
  }
  if (desc.briefSummary) lines.push("", "## Brief summary", "", String(desc.briefSummary).trim());
  if (desc.detailedDescription) lines.push("", "## Detailed description", "", String(desc.detailedDescription).trim());
  return { title, text: lines.join("\n"), nctId, year, sponsor };
}
var clinicaltrialsBackend = async (ctx) => {
  const n = Math.max(3, Math.min(15, ctx.options.perSource));
  const since = sinceDate(ctx.options.since);
  const url = `${API}?query.term=${encodeURIComponent(ctx.question)}&pageSize=${n}&format=json` + (since ? `&filter.advanced=${encodeURIComponent(`AREA[StartDate]RANGE[${since},MAX]`)}` : "");
  const r = await apiGet(url);
  const studies = r.ok && Array.isArray(r.data?.studies) ? r.data.studies : [];
  if (!r.ok || !studies.length) {
    return { backend: "clinicaltrials", items: [], notes: [apiFailure("ClinicalTrials.gov search", r)] };
  }
  const items = [];
  studies.slice(0, n).forEach((study, i) => {
    const s = studyText(study);
    if (!s.nctId) return;
    const summary = String(study?.protocolSection?.descriptionModule?.briefSummary ?? "");
    items.push({
      url: `https://clinicaltrials.gov/study/${s.nctId}`,
      title: s.title,
      backend: "clinicaltrials",
      score: n - i,
      snippet: (summary || s.title).replace(/\s+/g, " ").slice(0, 360),
      text: s.text,
      // The sponsor is not an author: kept apart so refs.bib does not invent one.
      meta: { nctId: s.nctId, year: s.year, ...s.sponsor ? { sponsor: s.sponsor } : {}, venue: "ClinicalTrials.gov" }
    });
  });
  return { backend: "clinicaltrials", items, notes: [`ClinicalTrials.gov returned ${items.length} study record(s).`] };
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
  const add2 = (s) => {
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
  for (const s of rfcHits) add2(s);
  const mdnDocs = Array.isArray(mdnResult.data?.documents) ? mdnResult.data.documents : [];
  const ranked = rankedKeywords(ctx.question).map((t) => t.toLowerCase());
  const mdnRelevant = (d) => {
    const top = ranked[0];
    if (top === void 0) return true;
    const hay = new Set(keywords(`${d.title ?? ""} ${d.summary ?? ""}`).map((t) => t.toLowerCase()));
    if (hay.has(top)) return true;
    return ranked.length >= 2 && ranked.filter((t) => hay.has(t)).length >= 2;
  };
  let mdnKept = 0;
  for (let i = 0; i < mdnDocs.length && mdnKept < Math.min(perSource, 5); i++) {
    const d = mdnDocs[i];
    if (!d?.mdn_url || !mdnRelevant(d)) continue;
    mdnKept++;
    add2({
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
    add2(rfcSource(o, 40 - kept));
    kept++;
  }
  const apiDown = !mdnResult.ok && !titleResult.ok && rfcHits.every((x) => x === null);
  if (apiDown) notes.push("Standards backends (IETF datatracker + MDN) were unreachable.");
  notes.push(items.length ? `Standards backend returned ${items.length} spec(s).` : "Standards backend found no matching specs.");
  return { backend: "standards", items, notes };
};

// src/backends/reddit.ts
var SEARCH_URL = "https://www.reddit.com/search.rss";
var COMMENT_THREADS = 3;
var COMMENTS_PER_THREAD = 5;
var THREAD_RE = /^https:\/\/(?:www\.|old\.)?reddit\.com\/r\/([^/]+)\/comments\/[a-z0-9]+\//i;
function redditWindow(since, nowMs = Date.now()) {
  const secs = sinceEpochSeconds(since);
  if (secs === null) return "all";
  const days = (nowMs / 1e3 - secs) / 86400;
  if (days <= 1) return "day";
  if (days <= 7) return "week";
  if (days <= 31) return "month";
  if (days <= 366) return "year";
  return "all";
}
var SITE_RE = /\b(?:https?:\/\/)?(?:www\.)?([a-z0-9][a-z0-9-]*)\.(?:co\.uk|com\.au|com|net|org|fr|de|at|ch|be|nl|es|it|pl|pt|eu|uk|us|ca|ie|se|dk|no|fi)(?:\/\S*)?(?![\w.])/gi;
function redditQuery(question) {
  return question.replace(SITE_RE, (_m, name) => `"${name}"`);
}
async function readFeed(url) {
  await awaitHostSlot(url);
  const r = await httpGet(url, { accept: "application/atom+xml", userAgent: browserUa(), retries: 0, timeoutMs: 12e3 });
  if (!r.ok || !r.body) return { why: throttleReason(r.status, r.error).why };
  const feed = parseFeed(r.body, url);
  if (!feed) return { why: "answered with a page that is not a feed (a login or challenge wall)" };
  return { feed };
}
function postText(summary) {
  return (summary ?? "").replace(/\s*submitted by\s+\/u\/\S+[\s\S]*$/i, "").trim();
}
function fallback(q) {
  return `Search it with your own WebSearch instead \u2014 \`site:reddit.com ${q}\` \u2014 and ingest the threads that matter.`;
}
var redditBackend = async (ctx) => {
  const n = Math.max(3, Math.min(15, ctx.options.perSource));
  const q = ctx.question;
  const url = `${SEARCH_URL}?q=${encodeURIComponent(redditQuery(q))}&sort=relevance&t=${redditWindow(ctx.options.since)}&limit=${Math.min(25, n * 2)}`;
  const { feed, why } = await readFeed(url);
  if (!feed) return { backend: "reddit", items: [], notes: [`Reddit search ${why}. ${fallback(q)}`] };
  const threads = feed.items.filter((it) => it.url && THREAD_RE.test(it.url)).slice(0, n);
  const items = threads.map((it, i) => {
    const title = it.title ?? it.url;
    const body = postText(it.summary);
    const published = it.published ? new Date(it.published) : void 0;
    const valid = published && !Number.isNaN(published.getTime());
    return {
      url: it.url,
      title,
      backend: "reddit",
      score: threads.length - i,
      snippet: (body || title).slice(0, 360),
      text: body ? `${title}

${body}` : title,
      meta: {
        subreddit: THREAD_RE.exec(it.url)[1],
        ...valid ? { published: published.toISOString(), year: published.getUTCFullYear() } : {}
      }
    };
  });
  const notes = [items.length ? `Reddit returned ${items.length} thread(s).` : "Reddit returned no threads."];
  if (ctx.options.depth === "deep" && items.length) notes.push(await readComments(items.slice(0, COMMENT_THREADS)));
  return { backend: "reddit", items, notes };
};
async function readComments(threads) {
  let read2 = 0;
  for (const [i, t] of threads.entries()) {
    if (i > 0 && politeDelayMs()) await sleep(politeDelayMs());
    const { feed, why } = await readFeed(`${t.url.replace(/\/?$/, "/")}.rss`);
    if (!feed) return `Reddit comments: read ${read2} of ${threads.length} thread(s), then the feed ${why} \u2014 stopped there. ${fallback(t.title)}`;
    const comments = feed.items.filter((c) => c.url && c.url.replace(/\/$/, "") !== t.url.replace(/\/$/, "") && c.summary).slice(0, COMMENTS_PER_THREAD).map((c) => `- ${postText(c.summary).replace(/\s+/g, " ").slice(0, 400)}`);
    if (comments.length) t.text = `${t.text}

Top comments:
${comments.join("\n")}`;
    read2++;
  }
  return `Reddit comments: read the top comments of ${read2} thread(s).`;
}

// src/codes.ts
import { join as join5 } from "path";
var KEYWORDS = [
  // en
  "promotional code",
  "promo code",
  "discount code",
  "coupon code",
  "voucher code",
  "offer code",
  "referral code",
  "coupon",
  "voucher",
  // fr
  "code de r\xE9duction",
  "code de reduction",
  "code r\xE9duction",
  "code reduction",
  "bon de r\xE9duction",
  "bon de reduction",
  "code de remise",
  "code remise",
  "code avantage",
  "codes promo",
  "code promo",
  // de
  "gutscheincode",
  "rabattcode",
  "aktionscode",
  "promocode",
  "promo-code",
  "gutschein",
  // es / pt
  "c\xF3digo promocional",
  "codigo promocional",
  "c\xF3digo de descuento",
  "codigo de descuento",
  "c\xF3digo de desconto",
  "cup\xF3n",
  "cupon",
  "cupom",
  // it
  "codice promozionale",
  "codice sconto",
  "codice promo",
  "buono sconto",
  // nl
  "kortingscode",
  "kortingsbon",
  "couponcode",
  "actiecode",
  // pl
  "kod rabatowy",
  "kod promocyjny",
  "kupon rabatowy",
  "kupon"
].sort((a, b) => b.length - a.length);
var LEAD = "(?:use|using|with|enter|apply|redeem|avec|gr\xE2ce au|grace au|via|utilise[rz]?|saisi(?:ssez|r)|entrez|tape[rz]?|mit|gib|nutze|usa(?:ndo)?|con|inserisci|met|gebruik|z|u\u017Cyj|com)(?:\\s+(?:the|le|la|dem|den|el|il|lo|de|o))?\\s+(?:code|codice|c\xF3digo|codigo|kod(?:em)?)";
var STOP_TOKENS = /* @__PURE__ */ new Set([
  "CODE",
  "CODES",
  "PROMO",
  "PROMOS",
  "COUPON",
  "COUPONS",
  "VOUCHER",
  "VOUCHERS",
  "DISCOUNT",
  "OFFER",
  "OFFERS",
  "DEAL",
  "DEALS",
  "FREE",
  "SALE",
  "SALES",
  "OFF",
  "NEW",
  "BLACK",
  "FRIDAY",
  "CYBER",
  "MONDAY",
  "PRIME",
  "EXCLUSIVE",
  "VALID",
  "EXPIRED",
  "VERIFIED",
  "HTTP",
  "HTTPS",
  "HTML",
  "JSON",
  "NULL",
  "NONE",
  "TRUE",
  "FALSE",
  "WWW",
  "EUR",
  "EURO",
  "EUROS",
  "USD",
  "GBP",
  "PLN",
  "CHF",
  "TVA",
  "VAT",
  "TTC",
  "SKU",
  "EAN",
  "ISBN",
  "AVEC",
  "POUR",
  "SANS",
  "DANS",
  "VALABLE",
  "VALIDE",
  "GRATUIT",
  "GRATUITE",
  "OFFERT",
  "OFFERTE",
  "SOLDES",
  "REDUCTION",
  "REMISE",
  "LIVRAISON",
  "EXCLU",
  "EXCLUSIF",
  "RABATT",
  "GUTSCHEIN",
  "GUTSCHEINE",
  "AKTION",
  "GRATIS",
  "CUPON",
  "CUPONES",
  "DESCUENTO",
  "SCONTO",
  "CODICE",
  "KORTING",
  "KOD",
  "KUPON",
  "RABATOWY"
]);
var MONTHS = {};
var MONTH_NAMES = [
  ["january", "jan", "janvier", "janv", "januar", "j\xE4nner", "enero", "ene", "gennaio", "gen", "januari", "stycznia", "stycze\u0144", "janeiro"],
  ["february", "feb", "f\xE9vrier", "fevrier", "f\xE9vr", "fevr", "februar", "febrero", "febbraio", "februari", "lutego", "luty", "fevereiro"],
  ["march", "mar", "mars", "m\xE4rz", "maerz", "marz", "marzo", "maart", "marca", "marzec", "mar\xE7o", "marco"],
  ["april", "apr", "avril", "avr", "abril", "abr", "aprile", "kwietnia", "kwiecie\u0144"],
  ["may", "mai", "mayo", "maggio", "mag", "mei", "maja", "maj", "maio"],
  ["june", "jun", "juin", "juni", "junio", "giugno", "giu", "czerwca", "czerwiec", "junho"],
  ["july", "jul", "juillet", "juil", "juli", "julio", "luglio", "lug", "lipca", "lipiec", "julho"],
  ["august", "aug", "ao\xFBt", "aout", "agosto", "ago", "augustus", "sierpnia", "sierpie\u0144"],
  ["september", "sep", "sept", "septembre", "septiembre", "settembre", "set", "wrze\u015Bnia", "wrzesnia", "wrzesie\u0144", "setembro"],
  ["october", "oct", "octobre", "oktober", "okt", "octubre", "ottobre", "ott", "pa\u017Adziernika", "pazdziernika", "pa\u017Adziernik", "outubro", "out"],
  ["november", "nov", "novembre", "noviembre", "listopada", "listopad", "novembro"],
  ["december", "dec", "d\xE9cembre", "decembre", "d\xE9c", "dezember", "dez", "diciembre", "dic", "dicembre", "grudnia", "grudzie\u0144", "dezembro"]
];
MONTH_NAMES.forEach((names, i) => {
  for (const n of names) MONTHS[n] = i + 1;
});
for (const n of Object.keys(MONTHS)) if (n.length >= 4) STOP_TOKENS.add(deaccent(n).toUpperCase());
var MIN_MARKER = "(?:d\xE8s|des|\xE0 partir de|a partir de|minimum(?:\\s+(?:d'achat|d\u2019achat|de commande|order|spend|purchase))?(?:\\s+(?:de|of))?|min\\.?|on orders? (?:over|of|above)|orders? (?:over|above)|when you spend|spend(?:\\s+(?:over|at least))?|over|ab(?:\\s+einem\\s+(?:Einkauf|Bestellwert)\\s+von)?|Mindestbestellwert(?:\\s+von)?|desde|compra m\xEDnima de|da|con una spesa minima di|vanaf|bij besteding van|od|przy zakupach (?:za|od)|powy\u017Cej)";
var EXP_MARKER = "(?:expires?|expiring|expiry|exp\\.|valid (?:until|till|through|thru|to)|ends?|until|till|jusqu['\u2019]?(?:au|\xE0)|valable jusqu['\u2019]?(?:au|\xE0)|expire le|fin le|se termine le|g\xFCltig bis(?: zum)?|bis zum|bis|endet am|v\xE1lido hasta(?: el)?|valido hasta(?: el)?|hasta el|hasta|valido fino al|fino al|scade il|geldig (?:t\\/m|tot(?: en met)?)|tot en met|t\\/m|wa\u017Cny do|wazny do|do)";
var foldText = (s) => deaccent(s.toLowerCase()).replace(/[^a-z0-9]/g, "");
var BOUNDARY_BEFORE = "(?<![\\p{L}\\p{N}_])";
var KEYWORD_RE = new RegExp(`${BOUNDARY_BEFORE}(?:${KEYWORDS.map(escapeRegExp).join("|")})(?:s|e|n)?(?![\\p{L}\\p{N}])`, "giu");
var HAS_KEYWORD = new RegExp(KEYWORD_RE.source, "iu");
var LEAD_RE = new RegExp(`${BOUNDARY_BEFORE}${LEAD}(?![\\p{L}\\p{N}])|${BOUNDARY_BEFORE}code\\s*[:\uFF1A]`, "giu");
var STRONG_RE = /^[\s:：=\-–—>»«"“”„'‘’*`([]{0,6}([A-Za-z0-9][A-Za-z0-9_-]{3,19})(?![A-Za-z0-9_-]|\.\.|…)/u;
var QUOTED_RE = /(?:\*\*|__|["“”«»„'‘’`])\s*([A-Za-z0-9][A-Za-z0-9_-]{3,19})\s*(?:\*\*|__|["“”«»'‘’`])/gu;
var WEAK_WINDOW = 60;
var REPEAT_WINDOW = 80;
var TOKEN_SHAPE = /^[A-Z0-9][A-Z0-9_-]{3,19}$/;
function acceptToken(raw, merchant, structured = false) {
  const token = raw.trim();
  if (!structured && /[a-z]/.test(token) && !/\d/.test(token)) return void 0;
  const up = token.toUpperCase();
  if (!TOKEN_SHAPE.test(up) || !/[A-Z]/.test(up)) return void 0;
  if (/\d{6,}/.test(up)) return void 0;
  if (up.length >= 12 && /^[0-9A-F]+$/.test(up)) return void 0;
  if (STOP_TOKENS.has(up)) return void 0;
  if (merchant) {
    const m = deaccent(merchant).toUpperCase();
    if (up === m.replace(/[^A-Z0-9]/g, "")) return void 0;
    if (m.split(/[^A-Z0-9]+/).some((w) => w.length >= 4 && w === up)) return void 0;
  }
  return up;
}
function cleanCode(raw, merchant) {
  return raw ? acceptToken(raw, merchant, true) : void 0;
}
var MERCHANT_NOISE = /* @__PURE__ */ new Set([
  ...KEYWORDS.flatMap((k) => k.split(/[\s-]+/)),
  "code",
  "codes",
  "promo",
  "promos",
  "coupons",
  "vouchers",
  "discount",
  "discounts",
  "deal",
  "deals",
  "offer",
  "offers",
  "sale",
  "sales",
  "reduction",
  "r\xE9duction",
  "r\xE9ductions",
  "remise",
  "bons",
  "plans",
  "gutscheine",
  "rabatt",
  "descuento",
  "descuentos",
  "sconto",
  "korting",
  "rabat",
  "de",
  "du",
  "des",
  "le",
  "les",
  "pour",
  "chez",
  "sur",
  "en",
  "au",
  "for",
  "the",
  "at",
  "on",
  "in",
  "of",
  "best",
  "latest",
  "working",
  "valid",
  "bei",
  "f\xFCr",
  "fur",
  "von",
  "para",
  "en",
  "per",
  "voor",
  "na",
  "dla",
  "w",
  "and",
  "et",
  "und",
  "y",
  "uk",
  "us",
  "usa",
  "fr",
  "france",
  "de",
  "deutschland",
  "es",
  "espana",
  "espa\xF1a",
  "it",
  "italia",
  "nl",
  "pl"
]);
function merchantOf(question) {
  const host = /(?:https?:\/\/)?((?:[a-z0-9-]+\.)+[a-z]{2,})(?=[/\s?#]|$)/i.exec(question.trim())?.[1];
  if (host) {
    const labels = host.toLowerCase().replace(/^www\d?\./, "").split(".");
    const n = labels.length;
    const secondLevel = n >= 3 && /^(co|com|org|net|gov|ac|edu)$/.test(labels[n - 2]) && labels[n - 1].length === 2;
    const name = secondLevel ? labels[n - 3] : labels[n - 2];
    if (name) return name;
  }
  const words = question.toLowerCase().split(/[^\p{L}\p{N}'’&-]+/u).filter((w) => w && !MERCHANT_NOISE.has(w) && !(w in MONTHS) && !/^\d+$/.test(w));
  return words.length ? words.join(" ") : void 0;
}
var CURRENCY = {
  "\u20AC": { sym: "\u20AC", prefix: false },
  eur: { sym: "\u20AC", prefix: false },
  euro: { sym: "\u20AC", prefix: false },
  euros: { sym: "\u20AC", prefix: false },
  "\xA3": { sym: "\xA3", prefix: true },
  gbp: { sym: "\xA3", prefix: true },
  $: { sym: "$", prefix: true },
  usd: { sym: "$", prefix: true },
  z\u0142: { sym: "z\u0142", prefix: false },
  zl: { sym: "z\u0142", prefix: false },
  pln: { sym: "z\u0142", prefix: false },
  chf: { sym: "CHF", prefix: false }
};
var NUM = "(\\d{1,5}(?:[.,]\\d{1,2})?)";
var AMOUNT = `(?:([\u20AC\xA3$])\\s?${NUM}|${NUM}\\s?(\u20AC|\xA3|\\$|z\u0142|zl|chf|eur|euros?|gbp|usd|pln)(?![\\p{L}]))`;
var AMOUNT_RE = new RegExp(AMOUNT, "giu");
var MIN_RE = new RegExp(`${BOUNDARY_BEFORE}${MIN_MARKER}\\s*${AMOUNT}`, "giu");
var PERCENT_RE = /(?<![\d.,])(\d{1,2}(?:[.,]\d)?)\s?%/g;
var FREE_SHIPPING_RE = /livraison (?:offerte|gratuite)|frais de port (?:offerts|gratuits)|free (?:shipping|delivery|postage)|versandkostenfrei|kostenlose[rn]? versand|gratis versand|env[ií]o gratis|envio gratuito|spedizione gratuita|gratis verzending|darmowa dostawa/i;
function formatAmount(m) {
  const sym = (m[1] ?? m[4] ?? "").toLowerCase();
  const num5 = (m[2] ?? m[3] ?? "").replace(/[.,]00$/, "");
  const c = CURRENCY[sym] ?? { sym, prefix: false };
  return c.prefix ? `${c.sym}${num5}` : `${num5} ${c.sym}`;
}
function readDiscount(window) {
  const out = {};
  const minSpans = [];
  for (const m of window.matchAll(MIN_RE)) {
    const amount = new RegExp(AMOUNT, "iu").exec(m[0]);
    if (!amount) continue;
    out.minSpend ??= formatAmount(amount);
    minSpans.push([m.index, m.index + m[0].length]);
  }
  const insideMin = (i) => minSpans.some(([a, b]) => i >= a && i < b);
  const hits = [];
  for (const m of window.matchAll(PERCENT_RE)) if (!insideMin(m.index)) hits.push({ at: m.index, value: `${m[1].replace(",", ".")}%` });
  for (const m of window.matchAll(AMOUNT_RE)) if (!insideMin(m.index)) hits.push({ at: m.index, value: formatAmount(m) });
  hits.sort((a, b) => a.at - b.at);
  if (hits[0]) out.discount = hits[0].value;
  else if (FREE_SHIPPING_RE.test(window)) out.discount = "free shipping";
  return out;
}
var MONTH_WORD = `(${Object.keys(MONTHS).sort((a, b) => b.length - a.length).map(escapeRegExp).join("|")})`;
var DATE_ISO = /^(\d{4})-(\d{1,2})-(\d{1,2})/;
var DATE_NUM = /^(\d{1,2})[./-](\d{1,2})(?:[./-](\d{4}|\d{2}))?(?!\d)/;
var DATE_DM = new RegExp(`^(\\d{1,2})(?:er|st|nd|rd|th|\\.)?\\s+(?:de\\s+)?${MONTH_WORD}\\.?(?:,?\\s+(?:de\\s+)?(\\d{4}))?(?![\\p{L}])`, "iu");
var DATE_MD = new RegExp(`^${MONTH_WORD}\\.?\\s+(\\d{1,2})(?:st|nd|rd|th)?(?:,?\\s+(\\d{4}))?(?![\\p{L}\\d])`, "iu");
var EXP_RE = new RegExp(`${BOUNDARY_BEFORE}${EXP_MARKER}\\s*(?:le\\s+|the\\s+|am\\s+|el\\s+|il\\s+|on\\s+)?`, "giu");
function iso(y, m, d) {
  if (m < 1 || m > 12 || d < 1 || d > 31) return void 0;
  const dt = new Date(Date.UTC(y, m - 1, d));
  if (dt.getUTCMonth() !== m - 1) return void 0;
  return dt.toISOString().slice(0, 10);
}
function parseDateAt(s, opts) {
  const nowYear = Number(opts.now.slice(0, 4));
  const year = (y) => !y ? nowYear : y.length === 2 ? 2e3 + Number(y) : Number(y);
  const us = (opts.region ?? "").toLowerCase() === "us" || /-us$/i.test(opts.lang ?? "");
  let m = DATE_ISO.exec(s);
  if (m) return iso(Number(m[1]), Number(m[2]), Number(m[3]));
  m = DATE_NUM.exec(s);
  if (m) {
    const [a, b] = [Number(m[1]), Number(m[2])];
    return us ? iso(year(m[3]), a, b) : iso(year(m[3]), b, a);
  }
  m = DATE_DM.exec(s);
  if (m) return iso(year(m[3]), MONTHS[m[2].toLowerCase()] ?? 0, Number(m[1]));
  m = DATE_MD.exec(s);
  if (m) return iso(year(m[3]), MONTHS[m[1].toLowerCase()] ?? 0, Number(m[2]));
  return void 0;
}
function readExpiry(window, opts) {
  for (const m of window.matchAll(EXP_RE)) {
    const date = parseDateAt(window.slice(m.index + m[0].length), opts);
    if (date) return date;
  }
  return void 0;
}
var SENTENCE_END2 = /[.!?;](?=\s+[\p{Lu}\d"“«(*]|\s*$)|\n/gu;
function sentenceAround(text, at) {
  let start = 0;
  let end = text.length;
  let nextEnd = text.length;
  for (const m of text.matchAll(SENTENCE_END2)) {
    const stop = m.index + 1;
    if (stop <= at) start = stop;
    else if (end === text.length) end = stop;
    else {
      nextEnd = stop;
      break;
    }
  }
  return { here: text.slice(Math.max(start, at - 200), Math.min(end, at + 240)), next: text.slice(end, Math.min(nextEnd, end + 240)) };
}
function mergeMention(a, b) {
  const out = { ...a };
  if (b.via === "structured") out.via = "structured";
  if (b.strength === "strong") out.strength = "strong";
  for (const k of ["discount", "minSpend", "expires", "context"]) if (out[k] === void 0 && b[k] !== void 0) out[k] = b[k];
  if (b.expired) out.expired = true;
  return out;
}
function extractCodes(text, opts) {
  if (!text) return [];
  const leads = [...text.matchAll(LEAD_RE)].map((m) => ({ start: m.index, end: m.index + m[0].length }));
  const anchors = leads.map((l) => ({ end: l.end, applied: true }));
  for (const m of text.matchAll(KEYWORD_RE)) {
    const [start, end] = [m.index, m.index + m[0].length];
    anchors.push({ end, applied: leads.some((l) => l.end > start && l.end <= end) });
  }
  if (!anchors.length) return [];
  anchors.sort((a, b) => a.end - b.end);
  const found = [];
  for (const { end, applied } of anchors) {
    const strong = STRONG_RE.exec(text.slice(end, end + 40));
    const bareWord = !!strong && !applied && !/\d/.test(strong[1]) && !/\S/.test(strong[0].slice(0, -strong[1].length));
    const code = strong && !bareWord ? acceptToken(strong[1], opts.merchant) : void 0;
    if (code) {
      found.push({ code, at: end + strong.index + strong[0].length - strong[1].length, strength: "strong" });
      continue;
    }
    const window = text.slice(end, end + WEAK_WINDOW);
    for (const q of window.matchAll(QUOTED_RE)) {
      const weak = acceptToken(q[1], opts.merchant);
      if (weak) {
        found.push({ code: weak, at: end + q.index + q[0].indexOf(q[1]), strength: "weak" });
        break;
      }
    }
  }
  const inWindow = (at) => anchors.some((a) => at >= a.end && at - a.end <= REPEAT_WINDOW);
  const byCode = /* @__PURE__ */ new Map();
  for (const f of found) {
    const outside = [...text.matchAll(new RegExp(`(?<![A-Za-z0-9_-])${escapeRegExp(f.code)}(?![A-Za-z0-9_-])`, "gi"))].filter(
      (m) => !inWindow(m.index)
    ).length;
    if (outside >= 3) continue;
    const { here, next } = sentenceAround(text, f.at);
    const tail = next && !HAS_KEYWORD.test(next) ? next : "";
    const terms = readDiscount(here);
    const discount = terms.discount ?? (tail ? readDiscount(tail).discount : void 0);
    const expires = readExpiry(here, opts) ?? (tail ? readExpiry(tail, opts) : void 0);
    const mention = {
      code: f.code,
      via: "text",
      strength: f.strength,
      ...discount ? { discount } : {},
      ...terms.minSpend ? { minSpend: terms.minSpend } : {},
      ...expires ? { expires } : {},
      context: here.replace(/\s+/g, " ").trim().slice(0, 160)
    };
    const prev = byCode.get(f.code);
    byCode.set(
      f.code,
      prev ? prev.strength === "weak" && mention.strength === "strong" ? mergeMention(mention, prev) : mergeMention(prev, mention) : mention
    );
  }
  return [...byCode.values()];
}
function annotateCodes(text, meta, opts, about = "") {
  if (opts.merchant && !foldText(`${about} ${text}`).includes(foldText(opts.merchant))) return meta;
  const extracted = extractCodes(text, opts);
  if (!extracted.length) return meta;
  const merged = /* @__PURE__ */ new Map();
  for (const c of meta?.codes ?? []) merged.set(c.code, c);
  for (const c of extracted) {
    const prev = merged.get(c.code);
    merged.set(c.code, prev ? mergeMention(prev, c) : c);
  }
  return { ...meta, codes: [...merged.values()] };
}
function idNum(id) {
  return Number(/^S(\d+)$/.exec(id)?.[1] ?? 0);
}
function consensus(values) {
  const counts = /* @__PURE__ */ new Map();
  for (const v of values) if (v) counts.set(v, (counts.get(v) ?? 0) + 1);
  let best;
  for (const [v, n] of counts) if (best === void 0 || n > counts.get(best)) best = v;
  return best;
}
function aggregateCodes(sources, manifest) {
  const today = manifest.builtAt.slice(0, 10);
  const groups = /* @__PURE__ */ new Map();
  for (const s of [...sources].sort((a, b) => idNum(a.id) - idNum(b.id))) {
    for (const mention of s.meta?.codes ?? []) {
      const g = groups.get(mention.code) ?? [];
      g.push({ source: s, mention });
      groups.set(mention.code, g);
    }
  }
  const all = [];
  for (const [code, g] of groups) {
    const ms = g.map((x) => x.mention);
    const structured = ms.some((m) => m.via === "structured");
    const strength = ms.some((m) => m.strength === "strong") ? "strong" : "weak";
    const domains = new Set(g.map((x) => x.source.domain)).size;
    const expires = ms.map((m) => m.expires).filter((d) => !!d).sort().at(-1);
    const future = !!expires && expires >= today;
    const isExpired = !!expires && expires < today || ms.some((m) => m.expired) && !future;
    const discount = consensus(ms.map((m) => m.discount));
    const minSpend = consensus(ms.map((m) => m.minSpend));
    const score = 3 * Number(structured) + 2 * Math.min(domains, 4) + Number(strength === "strong") + Number(!!discount) + Number(future) - 5 * Number(isExpired);
    all.push({
      code,
      ...discount ? { discount } : {},
      ...minSpend ? { minSpend } : {},
      ...expires ? { expires } : {},
      sources: [...new Set(g.map((x) => x.source.id))],
      domains,
      structured,
      strength,
      score,
      confidence: score >= 8 ? "high" : score >= 5 ? "medium" : "low",
      isExpired
    });
  }
  all.sort((a, b) => b.score - a.score || b.domains - a.domains || a.code.localeCompare(b.code));
  const strip = ({ isExpired: _, ...c }) => c;
  return { candidates: all.filter((c) => !c.isExpired).map(strip), expired: all.filter((c) => c.isExpired).map(strip) };
}
function codesOptions(manifest) {
  return { lang: manifest.lang, region: manifest.region, now: manifest.builtAt, merchant: merchantOf(manifest.question) };
}
var TABLE_ROWS = 15;
function writeCodes(dir, sources, manifest) {
  const { candidates: candidates2, expired } = aggregateCodes(sources, manifest);
  const merchant = merchantOf(manifest.question);
  const file = {
    ...merchant ? { merchant } : {},
    ...manifest.region ? { region: manifest.region } : {},
    builtAt: manifest.builtAt,
    candidates: candidates2,
    expired
  };
  writeArtifact(join5(dir, "codes.json"), JSON.stringify(file, null, 2));
  const out = [
    "## Candidate codes (extracted \u2014 UNVERIFIED)",
    "",
    "> Machine-extracted from the sources below and **never tested**. Before a code goes in the report, confirm it in the `[S#]` it cites \u2014 the page must show that exact code for this merchant. **Never invent, guess or complete a code**, and never present one as working unless it was tried. Full list, with expired codes: `codes.json`.",
    ""
  ];
  if (!candidates2.length) {
    out.push(
      `_No candidate code was extracted from these sources${expired.length ? ` (${expired.length} expired one(s) are listed in codes.json)` : ""}. Search the merchant's own offers and the deal sites yourself before concluding there is none._`
    );
    return out;
  }
  out.push("| Code | Discount | Conditions | Expires | Sources | Confidence |");
  out.push("|---|---|---|---|---|---|");
  for (const c of candidates2.slice(0, TABLE_ROWS)) {
    out.push(
      `| \`${c.code}\` | ${c.discount ?? "\u2014"} | ${c.minSpend ? `min. ${c.minSpend}` : "\u2014"} | ${c.expires ?? "\u2014"} | ${c.sources.map((s) => `[${s}]`).join("")} | ${c.confidence} |`
    );
  }
  const more = candidates2.length - TABLE_ROWS;
  if (more > 0) out.push("", `_${more} more candidate(s) in codes.json._`);
  if (expired.length) out.push("", `_${expired.length} expired code(s) left out of this table \u2014 see \`expired\` in codes.json._`);
  return out;
}
function codesSummary(sources, manifest) {
  const { candidates: candidates2, expired } = aggregateCodes(sources, manifest);
  const data = {
    to_try: candidates2.map((c) => ({
      code: c.code,
      ...c.discount ? { discount: c.discount } : {},
      ...c.minSpend ? { min_spend: c.minSpend } : {},
      ...c.expires ? { expires: c.expires } : {},
      confidence: c.confidence,
      sources: c.sources
    })),
    expired: expired.map((c) => c.code)
  };
  if (!candidates2.length) {
    return {
      key: "codes",
      data,
      lines: [
        `  codes:    none extracted${expired.length ? ` (${expired.length} expired: ${data.expired.join(", ")})` : ""} \u2014 search the deal sites yourself and ingest them`
      ]
    };
  }
  const cells = candidates2.map((c) => [
    c.code,
    c.discount ?? "\u2014",
    c.minSpend ? `min. ${c.minSpend}` : "",
    c.expires ? `until ${c.expires}` : "",
    c.confidence,
    c.sources.map((s) => `[${s}]`).join("")
  ]);
  const widths = cells[0].map((_, i) => Math.max(...cells.map((row) => row[i].length)));
  const lines = [
    `  codes:    ${candidates2.length} to try \u2014 UNVERIFIED: confirm each in its [S#], never pay to test (full list: codes.json)`,
    ...cells.map(
      (row) => `            ${row.map((cell3, i) => i === row.length - 1 ? cell3 : cell3.padEnd(widths[i])).filter((_, i) => widths[i] > 0).join("  ")}`.trimEnd()
    ),
    ...expired.length ? [`            expired: ${data.expired.join(", ")}`] : []
  ];
  return { key: "codes", data, lines };
}

// src/backends/pepper.ts
var PEPPER_SITES = {
  fr: { host: "www.dealabs.com", search: "/search?q={q}", vouchers: "/codes-promo/{slug}" },
  gb: { host: "www.hotukdeals.com", search: "/search?q={q}", vouchers: "/vouchers/{slug}" },
  de: { host: "www.mydealz.de", search: "/search?q={q}", vouchers: "/gutscheine/{slug}" },
  at: { host: "www.preisjaeger.at", search: "/search?q={q}" },
  es: { host: "www.chollometro.com", search: "/search?q={q}", vouchers: "/cupones/{slug}" },
  pl: { host: "www.pepper.pl", search: "/search?q={q}", vouchers: "/kupony/{slug}" },
  nl: { host: "nl.pepper.com", search: "/search?q={q}", vouchers: "/kortingscode/{slug}" }
};
var REGION_ALIASES2 = { uk: "gb" };
function pepperSiteFor(lang, region) {
  const [base2, sub] = lang.toLowerCase().split(/[-_]/);
  const key = (region ?? sub ?? (base2 === "en" ? "" : base2) ?? "").toLowerCase();
  const r = REGION_ALIASES2[key] ?? key;
  const site = PEPPER_SITES[r];
  return site ? { region: r, site } : void 0;
}
function sliceJsonObject(text, start) {
  let depth = 0;
  let inStr = false;
  for (let i = start; i < text.length; i++) {
    const c = text[i];
    if (inStr) {
      if (c === "\\") i++;
      else if (c === '"') inStr = false;
    } else if (c === '"') inStr = true;
    else if (c === "{") depth++;
    else if (c === "}" && --depth === 0) return text.slice(start, i + 1);
  }
  return void 0;
}
function tryJson(s) {
  if (!s) return void 0;
  try {
    return JSON.parse(s);
  } catch {
    return void 0;
  }
}
function embeddedJson(html) {
  const out = [];
  for (const m of html.matchAll(/\sdata-vue[23]=(?:'([^']*)'|"([^"]*)")/g)) out.push(tryJson(decodeEntities(m[1] ?? m[2] ?? "")));
  for (const m of html.matchAll(/<script\b[^>]*type=["']application\/(?:ld\+)?json["'][^>]*>([\s\S]*?)<\/script>/gi)) out.push(tryJson(m[1].trim()));
  const state = /__INITIAL_STATE__\s*=\s*\{/.exec(html);
  if (state) out.push(tryJson(sliceJsonObject(html, state.index + state[0].length - 1)));
  return out.filter((x) => x !== void 0);
}
var isObj2 = (v) => typeof v === "object" && v !== null && !Array.isArray(v);
function collectThreads(node, out, depth = 0) {
  if (depth > 40) return;
  if (Array.isArray(node)) for (const v of node) collectThreads(v, out, depth + 1);
  else if (isObj2(node)) {
    if ((typeof node.threadId === "string" || typeof node.threadId === "number") && typeof node.title === "string") out.push(node);
    for (const v of Object.values(node)) collectThreads(v, out, depth + 1);
  }
}
function regexThreads(html) {
  const text = html.replace(/&quot;/g, '"');
  const str4 = (win, key) => {
    const m = new RegExp(`"${key}":"((?:[^"\\\\]|\\\\.)*)"`).exec(win);
    return m ? tryJson(`"${m[1]}"`) : void 0;
  };
  const out = [];
  for (const m of text.matchAll(/"threadId":"?(\d+)"?/g)) {
    const win = text.slice(m.index, m.index + 4096);
    const title = str4(win, "title");
    if (!title) continue;
    out.push({
      threadId: m[1],
      title,
      voucherCode: str4(win, "voucherCode"),
      isExpired: /"isExpired":true/.test(win),
      merchant: { merchantName: str4(win, "merchantName"), merchantUrlName: str4(win, "merchantUrlName") }
    });
  }
  return out;
}
function threadLinks(html, host) {
  const links = /* @__PURE__ */ new Map();
  const re = new RegExp(`href="(https://${host.replace(/\./g, "\\.")}/(?!visit/|share-deal/)[^"?#]+?-(\\d{4,}))"`, "g");
  for (const m of html.matchAll(re)) if (!links.has(m[2])) links.set(m[2], m[1]);
  return links;
}
function cardText(html, id) {
  const m = new RegExp(`<article\\b[^>]*id="thread_${id}"[\\s\\S]*?</article>`).exec(html);
  if (!m) return void 0;
  const t = htmlToText(m[0].replace(/<script[\s\S]*?<\/script>/gi, "")).replace(/\s+/g, " ").trim();
  return t ? t.slice(0, 1200) : void 0;
}
var num2 = (v) => typeof v === "number" && Number.isFinite(v) ? v : typeof v === "string" && v.trim() && Number.isFinite(Number(v)) ? Number(v) : void 0;
var epochIso = (v) => {
  const n = num2(isObj2(v) ? v.timestamp : v);
  return n && n > 0 ? new Date(n * 1e3).toISOString() : void 0;
};
function parsePepperThreads(html, host) {
  const raw = [];
  for (const blob of embeddedJson(html)) collectThreads(blob, raw);
  if (!raw.length) raw.push(...regexThreads(html));
  const links = threadLinks(html, host);
  const byId = /* @__PURE__ */ new Map();
  for (const t of raw) {
    const id = String(t.threadId);
    if (byId.has(id)) continue;
    const merchant = isObj2(t.merchant) ? t.merchant : {};
    const shipping = isObj2(t.shipping) ? t.shipping : {};
    const pct = num2(t.percentage);
    const published = epochIso(t.publishedAt);
    const expires = epochIso(t.endDate)?.slice(0, 10);
    const code = typeof t.voucherCode === "string" ? t.voucherCode.trim() : "";
    byId.set(id, {
      id,
      title: decodeEntities(String(t.title)),
      url: links.get(id) ?? `https://${host}/share-deal/${id}`,
      ...typeof merchant.merchantName === "string" ? { merchant: merchant.merchantName } : {},
      ...typeof merchant.merchantUrlName === "string" ? { merchantSlug: merchant.merchantUrlName } : {},
      ...code ? { code } : {},
      ...num2(t.price) ? { price: num2(t.price) } : {},
      ...pct ? { discount: `${pct}%` } : {},
      ...shipping.isFree === 1 || shipping.isFree === true ? { freeShipping: true } : {},
      expired: t.isExpired === true || String(t.status ?? "").toLowerCase() === "expired",
      ...published ? { published } : {},
      ...expires ? { expires } : {},
      ...cardText(html, id) ? { description: cardText(html, id) } : {}
    });
  }
  return [...byId.values()];
}
function flightText(html) {
  const parts = [...html.matchAll(/self\.__next_f\.push\(\[1,("(?:[^"\\]|\\.)*")\]\)/g)].map((m) => tryJson(m[1]));
  const text = parts.filter((p) => typeof p === "string").join("");
  return text || html.replace(/\\"/g, '"');
}
function parsePepperVouchers(html) {
  const text = flightText(html);
  const listings = [...text.matchAll(/"(\w*Offers)":\{/g)].map((m) => ({ at: m.index, expired: /expired/i.test(m[1]) }));
  const out = [];
  const seen = /* @__PURE__ */ new Set();
  for (const m of text.matchAll(/"voucher":\{/g)) {
    const v = tryJson(sliceJsonObject(text, m.index + m[0].length - 1));
    if (!isObj2(v) || typeof v.code !== "string" || !v.code.trim()) continue;
    const listing = listings.filter((l) => l.at < m.index).at(-1);
    const expired = !!listing?.expired;
    const key = `${v.code}|${expired}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const end = typeof v.endTime === "string" ? v.endTime.slice(0, 10) : void 0;
    out.push({
      code: v.code.trim(),
      title: typeof v.title === "string" ? v.title : v.code,
      ...typeof v.termsAndConditions === "string" ? { terms: v.termsAndConditions } : {},
      ...typeof v.caption1 === "string" && /\d/.test(v.caption1) ? { discount: v.caption1.replace(/\s+/g, "") } : {},
      ...end && /^\d{4}-\d{2}-\d{2}$/.test(end) ? { expires: end } : {},
      expired
    });
  }
  return out;
}
var fold = (s) => s.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase().replace(/[^a-z0-9]/g, "");
function aboutMerchant(t, merchant) {
  if (!merchant) return true;
  const m = fold(merchant);
  return [t.merchant, t.merchantSlug, t.title].some((v) => v && fold(v).includes(m));
}
function threadSource(t, i, total, merchant) {
  const code = t.code ? cleanCode(t.code, merchant) : void 0;
  const facts = [
    t.merchant && `Merchant: ${t.merchant}`,
    t.price !== void 0 && `Price: ${t.price}`,
    code && `Code: ${code}`,
    t.discount && `Discount: ${t.discount}`,
    t.freeShipping && "Free shipping",
    t.expires && `Ends: ${t.expires}`,
    t.expired && "Status: expired"
  ].filter(Boolean);
  const mention = code ? {
    code,
    via: "structured",
    strength: "strong",
    ...t.discount ? { discount: t.discount } : t.freeShipping ? { discount: "free shipping" } : {},
    ...t.expires ? { expires: t.expires } : {},
    ...t.expired ? { expired: true } : {}
  } : void 0;
  const year = t.published ? new Date(t.published).getUTCFullYear() : void 0;
  return {
    url: t.url,
    title: t.expired ? `${t.title} (expired)` : t.title,
    backend: "pepper",
    // Live threads first, expired ones kept below them: an expired code is still evidence.
    score: (t.expired ? 0 : total) + total - i,
    snippet: [facts.join(" \xB7 "), t.description].filter(Boolean).join(" \u2014 ").slice(0, 360),
    text: [t.title, facts.join(" \xB7 "), t.description].filter(Boolean).join("\n\n"),
    meta: {
      ...t.published ? { published: t.published, year } : {},
      ...mention ? { codes: [mention] } : {}
    }
  };
}
function voucherSource(url, title, vouchers, merchant) {
  const codes = [];
  const lines = [];
  for (const v of vouchers) {
    const code = cleanCode(v.code, merchant);
    if (!code) continue;
    lines.push(
      [
        `Code ${code}${v.expired ? " (expired)" : ""} \u2014 ${v.title}`,
        v.discount && `Discount: ${v.discount}`,
        v.expires && `Ends: ${v.expires}`,
        v.terms && `Terms: ${v.terms}`
      ].filter(Boolean).join(" \xB7 ")
    );
    codes.push({
      code,
      via: "structured",
      strength: "strong",
      ...v.discount ? { discount: v.discount } : {},
      ...v.expires ? { expires: v.expires } : {},
      ...v.expired ? { expired: true } : {}
    });
  }
  if (!codes.length) return void 0;
  return {
    url,
    title,
    backend: "pepper",
    score: 1e3,
    // the merchant's own code page outranks any single thread
    snippet: lines.slice(0, 2).join(" \u2014 ").slice(0, 360),
    text: [title, ...lines].join("\n\n"),
    meta: { codes }
  };
}
async function get(url, lang, region) {
  await awaitHostSlot(url);
  return httpGet(url, { accept: "text/html", acceptLanguage: acceptLanguageHeader(lang, region), userAgent: browserUa(), retries: 0, timeoutMs: 15e3 });
}
function websearchHint(host, q) {
  return `Search it with your own WebSearch instead \u2014 \`site:${host.replace(/^www\./, "")} ${q}\`.`;
}
var pepperBackend = async (ctx) => {
  const found = pepperSiteFor(ctx.options.lang, ctx.options.region);
  if (!found) {
    return {
      backend: "pepper",
      items: [],
      notes: [
        `Pepper: no deal community for region "${ctx.options.region ?? ctx.options.lang}" \u2014 covered: ${Object.keys(PEPPER_SITES).join(", ")} (uk = gb). Pass --region to pick one.`
      ]
    };
  }
  const { region, site } = found;
  const merchant = merchantOf(ctx.question);
  const q = merchant ?? ctx.question;
  const url = `https://${site.host}${site.search.replace("{q}", encodeURIComponent(q))}`;
  const r = await get(url, ctx.options.lang, region);
  if (!r.ok || !r.body) {
    return { backend: "pepper", items: [], notes: [`${site.host} search ${throttleReason(r.status, r.error).why}. ${websearchHint(site.host, q)}`] };
  }
  const threads = parsePepperThreads(r.body, site.host);
  if (!threads.length) {
    const wall = looksLikeChallenge(r.body) ? "challenge page" : looksLikeJunkExtraction(htmlToText(r.body));
    const why = wall ? `served a ${wall} instead of results` : "returned a page with 0 parsable threads \u2014 markup changed?";
    return { backend: "pepper", items: [], notes: [`${site.host} ${why} ${websearchHint(site.host, q)}`] };
  }
  const relevant = threads.filter((t) => aboutMerchant(t, merchant));
  const items = relevant.slice(0, Math.max(5, ctx.options.perSource * 2)).map((t, i, all) => threadSource(t, i, all.length, merchant));
  const withCodes = items.filter((it) => it.meta?.codes?.length).length;
  const expired = relevant.filter((t) => t.expired).length;
  const notes = [
    `${site.host}: ${items.length} thread(s) about "${q}"` + (threads.length > relevant.length ? ` (${threads.length - relevant.length} about other merchants dropped)` : "") + `, ${withCodes} carrying a voucher code` + (expired ? `, ${expired} marked expired by the community` : "") + "."
  ];
  if (ctx.options.depth === "deep" && site.vouchers) {
    const slug = relevant.find((t) => t.merchantSlug)?.merchantSlug ?? (merchant ? merchant.toLowerCase().replace(/[^a-z0-9.]+/g, "-") : void 0);
    if (slug) {
      const vurl = `https://${site.host}${site.vouchers.replace("{slug}", encodeURIComponent(slug))}`;
      const vr = await get(vurl, ctx.options.lang, region);
      const vouchers = vr.ok && vr.body ? parsePepperVouchers(vr.body) : [];
      const title = vr.body ? /<title>([^<]*)<\/title>/i.exec(vr.body)?.[1]?.trim() ?? vurl : vurl;
      const src = voucherSource(vurl, decodeEntities(title), vouchers, merchant);
      if (src) {
        items.unshift(src);
        const kept = src.meta.codes;
        notes.push(`${site.host} voucher page: ${kept.length} code(s) (${kept.filter((c) => c.expired).length} expired).`);
      } else {
        notes.push(`${site.host} voucher page ${vurl}: ${vr.ok ? "no voucher code on it" : throttleReason(vr.status, vr.error).why}.`);
      }
    }
  }
  return { backend: "pepper", items, notes };
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
  clinicaltrials: clinicaltrialsBackend,
  dblp: dblpBackend,
  standards: standardsBackend,
  reddit: redditBackend,
  pepper: pepperBackend
};
var SINGLE_QUERY = /* @__PURE__ */ new Set([
  "github",
  "stackexchange",
  "semanticscholar",
  "pubmed",
  "standards",
  "fixture",
  "generic",
  "claude",
  "reddit",
  "pepper"
]);
var POLITE_SEQUENTIAL = /* @__PURE__ */ new Set(["arxiv", "crossref", "openalex", "europepmc", "clinicaltrials", "dblp"]);
async function fanOutVariants(handler, ctx, variants, polite2) {
  if (!polite2) return Promise.all(variants.map((q) => handler({ ...ctx, question: q })));
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
import { existsSync as existsSync4, readFileSync as readFileSync6 } from "fs";
import { join as join11 } from "path";

// src/authority.ts
function sourceSignals(opts) {
  const hosts = externalHosts(opts.url, opts.text);
  const selfIdentified = urlDeclaresIdentity(opts.url) || !!deriveCitableUrl(opts.text.slice(0, 4e3));
  const corroboration = opts.corroboration ?? 1;
  const notes = [
    `cites ${hosts.size} external source(s) \xB7 surfaced by ${corroboration} engine(s) \xB7 ${selfIdentified ? "declares a persistent identity (DOI/arXiv/canonical)" : "declares no persistent identity"}`
  ];
  return { refDiversity: hosts.size, selfIdentified, corroboration, notes };
}

// src/extras.ts
import { join as join6 } from "path";

// src/bibtex.ts
function clean2(s) {
  return s.replace(/[{}]/g, "").replace(/\s+/g, " ").trim();
}
function bibKey(s, used) {
  const last = s.meta?.authors?.[0]?.split(/\s+/).pop()?.toLowerCase().replace(/[^a-z0-9]/g, "");
  const year = s.meta?.year ? String(s.meta.year) : "";
  const word = s.title.split(/\s+/).find((w) => w.replace(/[^a-z0-9]/gi, "").length > 3)?.toLowerCase().replace(/[^a-z0-9]/g, "");
  const base2 = `${last ?? s.id.toLowerCase()}${year}${word ?? ""}` || s.id.toLowerCase();
  let key = base2;
  let n = 2;
  while (used.has(key)) key = `${base2}${n++}`;
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
    const fields = [`  title = {${clean2(s.title)}}`];
    if (s.meta?.authors?.length) fields.push(`  author = {${s.meta.authors.map(clean2).join(" and ")}}`);
    if (s.meta?.year) fields.push(`  year = {${s.meta.year}}`);
    if (s.meta?.venue) fields.push(`  journal = {${clean2(String(s.meta.venue))}}`);
    if (s.meta?.doi) fields.push(`  doi = {${clean2(String(s.meta.doi))}}`);
    if (s.meta?.arxivId) {
      fields.push(`  eprint = {${clean2(String(s.meta.arxivId))}}`);
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

// src/extras.ts
var EXTRAS = {
  // research: a BibTeX file built from the scholarly sources' metadata.
  bibtex: {
    files: ["refs.bib"],
    write: ({ dir, sources }) => {
      writeArtifact(join6(dir, "refs.bib"), toBibtex(sources));
      return [];
    }
  },
  // learn: the model writes these into REPORT.md itself; the engine has nothing to produce.
  glossary: { files: [] },
  exercises: { files: [] },
  // deals: candidate discount codes, extracted per source while the full text is
  // in hand, then ranked across the dossier into codes.json + an UNVERIFIED table.
  codes: {
    files: ["codes.json"],
    annotate: (text, source2, manifest) => annotateCodes(text, source2.meta, codesOptions(manifest), `${source2.title} ${source2.url}`),
    write: ({ dir, sources, manifest }) => writeCodes(dir, sources, manifest),
    summary: ({ sources, manifest }) => codesSummary(sources, manifest)
  }
};
function active2(manifest) {
  return (manifest.extras ?? []).map((e) => EXTRAS[e]).filter((s) => s !== void 0);
}
function annotateExtras(text, source2, manifest) {
  let out = source2;
  for (const spec of active2(manifest)) {
    if (!spec.annotate) continue;
    const meta = spec.annotate(text, out, manifest);
    if (meta !== out.meta) out = { ...out, meta };
  }
  return out;
}
function writeExtras(dir, sources, manifest) {
  const blocks2 = [];
  for (const spec of active2(manifest)) {
    const lines = spec.write?.({ dir, sources, manifest }) ?? [];
    if (lines.length) blocks2.push(lines);
  }
  return blocks2;
}
function extraSummaries(sources, manifest) {
  return active2(manifest).map((spec) => spec.summary?.({ dir: "", sources, manifest })).filter((s) => s !== void 0);
}
function extraFiles() {
  return [...new Set(Object.values(EXTRAS).flatMap((s) => s.files))];
}

// src/passages.ts
var OMISSION_NOTICE = "[Other source text omitted; passages selected for the question. Character positions use UTF-16 offsets in the fetched extract.]";
function sourceTextWithoutPassageLabels(text) {
  return text.split("\n").filter((line) => {
    const trimmed = line.trim();
    return !/^\[Source passage: characters \d+-\d+ of \d+\]$/.test(trimmed) && trimmed !== OMISSION_NOTICE;
  }).join("\n");
}
function selectSourcePassages(text, question, depth) {
  const cap = depth === "deep" ? Infinity : depth === "standard" ? 8e3 : 4e3;
  if (text.length <= cap || !question.trim()) return capExtract(text, depth);
  const matcher = buildMatcher(question);
  const candidates2 = [];
  for (let start = 0; start < text.length; ) {
    let end = Math.min(text.length, start + 800);
    if (end < text.length) {
      const paragraph2 = text.lastIndexOf("\n", end);
      const sentence = text.lastIndexOf(". ", end);
      const boundary = Math.max(paragraph2, sentence);
      if (boundary > start + 400) end = boundary + 1;
      else if (/[\uD800-\uDBFF]/.test(text[end - 1])) end--;
    }
    const score = matcher.matchLine(text.slice(start, end)).size;
    if (score) {
      let contextStart = Math.max(0, start - 160);
      let contextEnd = Math.min(text.length, end + 160);
      if (contextStart > 0 && /[\uDC00-\uDFFF]/.test(text[contextStart]) && /[\uD800-\uDBFF]/.test(text[contextStart - 1])) contextStart--;
      if (contextEnd < text.length && /[\uD800-\uDBFF]/.test(text[contextEnd - 1]) && /[\uDC00-\uDFFF]/.test(text[contextEnd])) contextEnd++;
      candidates2.push({ start: contextStart, end: contextEnd, score });
    }
    start = end;
  }
  if (!candidates2.length) return capExtract(text, depth);
  candidates2.sort((a, b) => b.score - a.score || a.start - b.start);
  const selected = [];
  const maxPassages = depth === "summary" ? 3 : 6;
  let remaining = cap - 800;
  for (const candidate of candidates2) {
    if (selected.length >= maxPassages) break;
    if (selected.some((w) => candidate.start < w.end && candidate.end > w.start)) continue;
    const length = candidate.end - candidate.start;
    if (length > remaining) continue;
    selected.push(candidate);
    remaining -= length;
  }
  if (!selected.length) return capExtract(text, depth);
  selected.sort((a, b) => a.start - b.start);
  return selected.map((w) => `[Source passage: characters ${w.start + 1}-${w.end} of ${text.length}]
${text.slice(w.start, w.end)}`).join("\n\n") + `

${OMISSION_NOTICE}`;
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
function readJson3(path, what) {
  let raw;
  try {
    raw = readFileSync6(path, "utf8");
  } catch (e) {
    throw new Error(`${what} could not be read (${path}): ${e.message}`);
  }
  try {
    return JSON.parse(raw);
  } catch (e) {
    throw new Error(`${what} is not valid JSON (${path}): ${e.message}`);
  }
}
function sourceIdentityError(sources) {
  if (!Array.isArray(sources)) return "is not a JSON array";
  const seen = /* @__PURE__ */ new Set();
  for (const [index, source2] of sources.entries()) {
    if (!source2 || typeof source2 !== "object" || typeof source2.id !== "string" || !source2.id.trim()) {
      return `has a missing or invalid source id at row ${index + 1}`;
    }
    if (seen.has(source2.id)) return `contains duplicate source id: ${source2.id}`;
    seen.add(source2.id);
  }
  return void 0;
}
function idNum2(id) {
  const m = /^S(\d+)$/.exec(id);
  return m ? Number(m[1]) : 0;
}
function maxSourceId(sources, dropped = []) {
  const kept = sources.reduce((acc, s) => Math.max(acc, idNum2(s.id)), 0);
  return dropped.reduce((acc, id) => Math.max(acc, idNum2(id)), kept);
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
    ...rs.fullText === false ? { fullText: false } : {},
    // A wall is snippet-only by construction; the flag says WHY, which is what
    // `check` and `drop --where wall` act on.
    ...rs.wall ? { wall: true } : {},
    ...rs.offTopic ? { offTopic: true } : {}
  };
}
function renderSourceExtract(s, text, depth, question = "") {
  const head = [
    `# ${s.id} \u2014 ${s.title}`,
    `- url: ${s.url}`,
    `- backend: ${s.backend} \xB7 fetched: ${s.fetchedAt} \xB7 trust: ${s.trust} \xB7 score: ${s.score}`,
    ""
  ].join("\n");
  return head + selectSourcePassages(text, question, depth) + "\n";
}
function readSourceText(dir, s) {
  const p = join11(dir, s.extract);
  if (!existsSync4(p)) return s.snippet ?? "";
  const lines = readFileSync6(p, "utf8").split("\n");
  const hasHeader = lines.length >= 3 && lines[0].startsWith("# ") && lines[1].startsWith("- url:") && lines[2].startsWith("- backend:");
  const body = (hasHeader ? lines.slice(3) : lines).join("\n").trim();
  return body || s.snippet || "";
}
function writeSourceExtract(dir, s, text, depth, question = "") {
  writeArtifact(join11(dir, s.extract), renderSourceExtract(s, text, depth, question));
}
function writeDossierIndex(dir, sources, manifest, template) {
  const sourcesJson = join11(dir, "sources.json");
  const dossierMd = join11(dir, "DOSSIER.md");
  const manifestJson = join11(dir, "manifest.json");
  writeArtifact(sourcesJson, JSON.stringify(sources, null, 2));
  writeArtifact(manifestJson, JSON.stringify(manifest, null, 2));
  const blocks2 = writeExtras(dir, sources, manifest);
  writeArtifact(dossierMd, renderDossierMarkdown(sources, manifest, template, blocks2));
  return { dir, sourcesJson, dossierMd, manifestJson };
}
function writeDossier(dir, rawSources, manifest, template) {
  ensureDir(join11(dir, "sources"));
  const sources = rawSources.map((rs, i) => {
    const id = `S${i + 1}`;
    const text = rs.text ?? rs.snippet ?? "";
    const s = annotateExtras(text, buildSource(rs, id, manifest.builtAt, manifest.question), manifest);
    writeSourceExtract(dir, s, text, manifest.depth, manifest.question);
    return s;
  });
  const m = { ...manifest, sourceCount: sources.length };
  return { dir, sources, paths: writeDossierIndex(dir, sources, m, template) };
}
function renderDossierMarkdown(sources, manifest, template, extraBlocks = []) {
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
  const offTopic = sources.filter((s) => s.offTopic).map((s) => s.id);
  if (offTopic.length) {
    out.push(
      `> \u{1F5D1} **Probably off-topic** \u2014 ${offTopic.join(", ")}: few of the question's terms, low content score. ` + (noWrite ? `Skim them, and leave them out of the answer if they are what they look like.` : `Skim them, then clear them in one call: \`ultrasearch drop --run <dir> --where offtopic\` (ids are never reused).`)
    );
    out.push("");
  }
  if (manifest.droppedIds?.length) {
    out.push(`> **Dropped:** ${manifest.droppedIds.join(", ")} \u2014 removed with \`drop\`; these ids are never reused, and citing one fails \`check\`.`);
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
  out.push(`## Report template (${manifest.template ?? manifest.mode})`);
  out.push("");
  out.push("```markdown");
  out.push(template);
  out.push("```");
  if (manifest.extras.length) {
    out.push("");
    out.push(`_Also produce: ${manifest.extras.join(", ")}._`);
  }
  out.push("");
  for (const block of extraBlocks) {
    out.push(...block);
    out.push("");
  }
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
    const off = s.offTopic ? " \xB7 \u{1F5D1} probably off-topic" : "";
    const quality = s.wall ? " \xB7 \u26D4 wall (the page was a consent/anti-bot wall \u2014 snippet only, do not cite)" : s.fullText === false ? " \xB7 \u26A0 snippet only (page fetch failed)" : "";
    const where = noWrite ? `extract: streamed as \`${s.extract}\`` : `extract: \`${s.extract}\``;
    out.push(`url: ${s.url} \xB7 backend: ${s.backend} \xB7 trust: ${s.trust} \xB7 ${where}${quality}${off}`);
    for (const sig of s.signals ?? []) out.push(`_${sig}_`);
    out.push("");
    out.push(s.snippet);
    out.push("");
  }
  return out.join("\n");
}
function readDossier(dir) {
  const sources = readJson3(join11(dir, "sources.json"), "sources.json");
  const identityError = sourceIdentityError(sources);
  if (identityError) throw new Error(`sources.json in ${dir} ${identityError} \u2014 re-run \`ultrasearch gather\`.`);
  const manifest = readJson3(join11(dir, "manifest.json"), "manifest.json");
  return { sources, manifest };
}

// src/templates.ts
var EXTRA_TEMPLATES = {
  verification: {
    description: "A reference or claim check: verdict, one row per reference, the discrepancies, what could not be verified.",
    template: [
      "## Verdict",
      "## Reference-by-reference table",
      "### (# \xB7 resolved as \xB7 authors \xB7 title \xB7 journal \xB7 year \xB7 vol \xB7 issue \xB7 pages \xB7 DOI \xB7 source)",
      "## Discrepancies",
      "## Claims checked against their sources",
      "## Not verifiable",
      "## Open questions",
      "## Sources"
    ].join("\n")
  }
};
function templateFor(manifest) {
  const t = manifest.template;
  if (t && t in EXTRA_TEMPLATES) return EXTRA_TEMPLATES[t].template;
  return getMode(t && t !== manifest.mode ? t : manifest.mode).template;
}
function setDossierTemplate(dir, name) {
  const { sources, manifest } = readDossier(dir);
  const next = { ...manifest, template: name };
  writeDossierIndex(dir, sources, next, templateFor(next));
  return next;
}
function hasOpenQuestions(markdown) {
  return /^\s{0,3}#{1,6}\s+.*\b(open questions?|questions? ouvertes?|contradictions?)\b/im.test(markdown);
}

// src/walls.ts
var MIN_USEFUL_CHARS = 300;
var LOCAL_WALLS = [
  [/\bcookies? (must|need to|have to|should) be (enabled|turned on|allowed)\b/i, "cookie wall"],
  [/\benable cookies (for|on|in)\b[\s\S]{0,160}?\b(reload|refresh|continue)\b/i, "cookie wall"],
  [/\b(your browser|this browser) (does not|doesn't) (accept|support) cookies\b/i, "cookie wall"],
  [/\bwe value your privacy\b[\s\S]{0,600}?\b(accept|agree|consent)\b/i, "cookie/consent wall"],
  [/\b(accept|allow) all cookies\b[\s\S]{0,400}?\b(reject|decline|manage|settings|preferences)\b/i, "cookie/consent wall"],
  [/\b(please )?(enable|turn on) javascript\b[\s\S]{0,120}?\b(to continue|to proceed|and reload|and refresh|to view|to use)\b/i, "JavaScript-required shell"],
  [/\byou need to enable javascript to run this app\b/i, "JavaScript-required shell"],
  [/\bpour continuer,? (veuillez )?activer (les cookies|javascript)\b|\bles cookies doivent être activés\b/i, "cookie wall (fr)"]
];
var WALL_MAX_CHARS = 2e3;
function usefulChars(text) {
  return text.split("\n").filter((l) => !/^\s*#{1,6}\s/.test(l)).join(" ").replace(/\s+/g, " ").trim().length;
}
function wallPattern(text) {
  const t = text.trim();
  if (!t) return void 0;
  const engine = looksLikeJunkExtraction(t);
  if (engine) return engine;
  if (t.length >= WALL_MAX_CHARS) return void 0;
  const head = t.slice(0, 800);
  return LOCAL_WALLS.find(([re]) => re.test(head))?.[1];
}
function looksLikeWall(text) {
  const wall = wallPattern(text);
  if (wall) return wall;
  const n = usefulChars(text);
  return n < MIN_USEFUL_CHARS ? `near-empty page (${n} useful characters)` : void 0;
}
function isWordedWall(reason) {
  return !!reason && !reason.startsWith("near-empty page");
}
var bypassing = 0;
var saved;
async function readPastCachedWall(url, opts, enabled) {
  const res = await cachedFetchAndExtract(url, opts, enabled);
  if (!res.cached || !res.text?.trim() || !looksLikeWall(res.text)) return res;
  if (bypassing++ === 0) {
    saved = cacheMode();
    setCacheMode({ refresh: true });
  }
  try {
    return await cachedFetchAndExtract(url, opts, enabled);
  } finally {
    if (--bypassing === 0 && saved) {
      setCacheMode(saved);
      saved = void 0;
    }
  }
}

// src/providers/ncbi.ts
var PUBMED_PAGE = /^https?:\/\/(?:(?:www\.)?pubmed\.ncbi\.nlm\.nih\.gov|(?:www\.)?ncbi\.nlm\.nih\.gov\/pubmed)\/(\d{4,9})\/?(?:[?#].*)?$/i;
var PMC_PAGE = /^https?:\/\/(?:(?:www\.)?pmc\.ncbi\.nlm\.nih\.gov|(?:www\.)?ncbi\.nlm\.nih\.gov\/pmc)\/articles\/(pmc\d+)\/?(?:[?#].*)?$/i;
var EFETCH = /^https?:\/\/eutils\.ncbi\.nlm\.nih\.gov\/entrez\/eutils\/efetch\.fcgi\?/i;
var EUROPE_PMC_XML = /^https?:\/\/(?:www\.)?ebi\.ac\.uk\/europepmc\/webservices\/rest\/(pmc\d+)\/fulltextxml\/?(?:[?#].*)?$/i;
function europePmcFullTextUrl(pmcid) {
  return `https://www.ebi.ac.uk/europepmc/webservices/rest/${pmcid.toUpperCase()}/fullTextXML`;
}
function pmcPage(pmcid) {
  return `https://pmc.ncbi.nlm.nih.gov/articles/${pmcid.toUpperCase()}/`;
}
function ncbiDocument(url) {
  const raw = url.trim();
  const pubmed = raw.match(PUBMED_PAGE);
  if (pubmed) return { kind: "pubmed", id: pubmed[1], citeUrl: `https://pubmed.ncbi.nlm.nih.gov/${pubmed[1]}/`, textUrl: pubmedAbstractUrl(pubmed[1]) };
  const pmc = raw.match(PMC_PAGE) ?? raw.match(EUROPE_PMC_XML);
  if (pmc) {
    const id = pmc[1].toUpperCase();
    return { kind: "pmc", id, citeUrl: pmcPage(id), textUrl: europePmcFullTextUrl(id) };
  }
  if (EFETCH.test(raw)) {
    let params;
    try {
      params = new URL(raw).searchParams;
    } catch {
      return void 0;
    }
    const ids = (params.get("id") ?? "").split(/[,\s+]+/).filter(Boolean);
    if (ids.length !== 1) return void 0;
    const db = (params.get("db") ?? "").toLowerCase();
    const id = ids[0];
    if (db === "pubmed" && /^\d+$/.test(id)) return { kind: "pubmed", id, citeUrl: `https://pubmed.ncbi.nlm.nih.gov/${id}/`, textUrl: raw };
    if (db === "pmc") {
      const pmcid = /^pmc/i.test(id) ? id.toUpperCase() : `PMC${id}`;
      return { kind: "pmc", id: pmcid, citeUrl: pmcPage(pmcid), textUrl: europePmcFullTextUrl(pmcid) };
    }
  }
  return void 0;
}
async function readNcbiDocument(doc, opts = {}) {
  if (doc.kind === "pubmed") {
    const res2 = await readPastCachedWall(doc.textUrl, {}, !!opts.cache);
    const text2 = res2.text?.trim() ?? "";
    if (!text2) return { ok: false, why: `E-utilities returned nothing for PMID ${doc.id} (HTTP ${res2.status || "no response"})` };
    const wall2 = looksLikeWall(text2);
    if (wall2) return { ok: false, why: `E-utilities returned a ${wall2} for PMID ${doc.id}` };
    return { ok: true, text: text2, via: doc.textUrl };
  }
  const res = await httpGet(doc.textUrl, { accept: "application/xml, text/xml;q=0.9, */*;q=0.1" });
  if (!res.ok || !/<article\b/i.test(res.body)) {
    return { ok: false, why: `Europe PMC has no full text for ${doc.id} (HTTP ${res.status || "no response"})` };
  }
  const { text, title } = jatsToText(res.body);
  const wall = looksLikeWall(text);
  if (wall) return { ok: false, why: `Europe PMC's full text for ${doc.id} is a ${wall}` };
  return { ok: true, text, ...title ? { title } : {}, via: doc.textUrl };
}
var DROP = ["table-wrap", "table", "disp-formula", "inline-formula", "mml:math", "supplementary-material", "ref-list", "ack", "fn-group", "alternatives"];
function inner(xml, tag2) {
  return xml.match(new RegExp(`<${tag2}\\b[^>]*>([\\s\\S]*?)</${tag2}>`, "i"))?.[1];
}
function clean3(s) {
  return decodeEntities(s.replace(/<[^>]+>/g, " ")).replace(/\s+/g, " ").replace(/\s+([,.;:)\]])/g, "$1").replace(/([([])\s+/g, "$1").trim();
}
function blocks(xml) {
  let x = xml;
  for (const tag2 of DROP) x = x.replace(new RegExp(`<${tag2}\\b[^>]*>[\\s\\S]*?</${tag2}>`, "gi"), " ");
  const out = [];
  const re = /<(title|p)\b[^>]*>([\s\S]*?)<\/\1>/gi;
  let m;
  while (m = re.exec(x)) {
    const body = clean3(m[2]);
    if (!body) continue;
    out.push(m[1].toLowerCase() === "title" ? `## ${body}` : body);
  }
  return out;
}
function jatsToText(xml) {
  const front = inner(xml, "front") ?? xml;
  const titleXml = inner(inner(front, "title-group") ?? front, "article-title");
  const title = titleXml ? clean3(titleXml) : void 0;
  const parts = [];
  if (title) parts.push(`# ${title}`);
  const abstract = inner(front, "abstract");
  if (abstract) {
    const ab = blocks(abstract);
    if (ab.length) parts.push("## Abstract", ...ab.filter((b) => b !== "## Abstract"));
  }
  const body = inner(xml, "body");
  if (body) parts.push(...blocks(body));
  return { text: parts.join("\n\n"), ...title ? { title } : {} };
}

// src/services.ts
var VERSION_PROBE_TIMEOUT_MS = 2e4;
async function toolVersion(cmd, args) {
  const r = await runWithInput(cmd, args, Buffer.alloc(0), VERSION_PROBE_TIMEOUT_MS);
  if (!r.ok) return void 0;
  return r.stdout.trim().split("\n")[0]?.trim() || "installed";
}
async function probeServices(opts = {}, only) {
  const rungs = enabledExtractors();
  const docRungs = enabledDocExtractors();
  let npxChain = Promise.resolve();
  const afterNpx = (f) => {
    const p = npxChain.then(f);
    npxChain = p.catch(() => {
    });
    return p;
  };
  const probes = [
    {
      name: "searxng",
      run: async () => {
        const sxBase = searxngBase({ searxng: opts.searxng });
        if (!sxBase) return { name: "searxng", ok: false, detail: "disabled (--searxng off)" };
        const up = await probeSearxng(sxBase, searxngIsExplicit({ searxng: opts.searxng }));
        return {
          name: "searxng",
          ok: up,
          detail: up ? `answering at ${sxBase}` : `not running at ${sxBase} \u2014 \`ultrasearch searxng up\``
        };
      }
    },
    {
      name: "firecrawl",
      run: async () => {
        const fcBase = firecrawlBase(opts);
        if (!fcBase) return { name: "firecrawl", ok: false, detail: "disabled (--firecrawl off)" };
        const explicit = firecrawlIsExplicit(opts);
        const up = await probeFirecrawl(fcBase, explicit);
        return {
          name: "firecrawl",
          ok: up,
          detail: up ? `answering at ${fcBase}` : (
            // Distinguish "nothing there" from "something there, but not Firecrawl" —
            // a squatted port is a confusing failure to debug without being told.
            `not running at ${fcBase}${explicit ? "" : " (or the port is held by another app)"} \u2014 \`ultrasearch firecrawl up\``
          )
        };
      }
    },
    {
      // The keyless rung next to the container that does the same job: a real
      // browser that reads JS shells and consent walls. Not probed by launching
      // it — detection and the mode are what decide whether a run will use it.
      name: "browser",
      run: async () => describeBrowserRung(resolveBrowserRung({ flag: opts.browser }))
    },
    {
      name: "pdf-inspector",
      run: async () => {
        if (!rungs.includes("pdf-inspector")) return { name: "pdf-inspector", ok: false, detail: "skipped (ULTRASEARCH_NO_NPX / ULTRASEARCH_PDF_ENGINE)" };
        const v = await afterNpx(() => toolVersion("npx", ["-y", "--prefer-offline", PDF_INSPECTOR_SPEC, "--version"]));
        return {
          name: "pdf-inspector",
          ok: !!v,
          detail: v ? `${v} (via npx)` : "unavailable \u2014 needs npm, and a prebuilt binary for this platform"
        };
      }
    },
    {
      name: "pdftotext",
      run: async () => {
        const pt = await toolVersion("pdftotext", ["-v"]);
        return { name: "pdftotext", ok: !!pt, detail: pt ?? "not installed (poppler-utils)" };
      }
    },
    {
      // OCR is the only rung that can read a scan, and it needs TWO binaries.
      // Which one is missing is the whole answer here — "OCR unavailable" would
      // send you looking in the wrong place, and copyable-pdf's own remedy for a
      // missing tesseract is an interactive `brew install` this never triggers.
      name: "ocr",
      run: async () => {
        if (!rungs.includes("ocr")) return { name: "ocr", ok: false, detail: "skipped (ULTRASEARCH_PDF_ENGINE)" };
        const { copyablePdf, tesseract } = await ocrTools();
        return {
          name: "ocr",
          ok: copyablePdf && tesseract,
          detail: copyablePdf && tesseract ? `copyable-pdf + tesseract, ${ocrBudgetLeft()} document(s) per run (ULTRASEARCH_OCR_MAX)` : !copyablePdf && !tesseract ? "not installed \u2014 `brew install maxgfr/tap/copyable-pdf tesseract` (scanned PDFs stay unreadable)" : copyablePdf ? "copyable-pdf is installed but tesseract is not \u2014 `brew install tesseract`" : "tesseract is installed but copyable-pdf is not \u2014 `brew install maxgfr/tap/copyable-pdf`"
        };
      }
    },
    { name: "pdf ladder", run: async () => ({ name: "pdf ladder", ok: true, detail: rungs.join(" \u2192 ") }) },
    {
      // The office-document converter. It needs Node 20+, one version above this
      // package's own floor, so "unavailable" here is a normal outcome on a Node
      // 18 host rather than a misconfiguration — say so instead of implying a fix.
      name: "anydoc",
      run: async () => {
        if (!docRungs.includes("anydoc")) return { name: "anydoc", ok: false, detail: "skipped (ULTRASEARCH_NO_NPX / ULTRASEARCH_DOC_ENGINE)" };
        const v = await afterNpx(() => toolVersion("npx", ["-y", "--prefer-offline", ANYDOC_SPEC, "--version"]));
        return {
          name: "anydoc",
          ok: !!v,
          detail: v ? `${v} (via npx)` : "unavailable \u2014 needs npm, Node 20+, and a prebuilt binary for this platform"
        };
      }
    },
    {
      name: "doc ladder",
      run: async () => ({
        name: "doc ladder",
        ok: docRungs.length > 0,
        // An empty ladder is not a broken one, but it does mean every .docx/.pptx a
        // run meets will be refused — worth saying plainly rather than printing "".
        detail: docRungs.length ? docRungs.join(" \u2192 ") : "disabled \u2014 office documents will be refused, not read"
      })
    }
  ];
  const wanted = only ? probes.filter((p) => only.includes(p.name)) : probes;
  return Promise.all(wanted.map((p) => p.run()));
}
function describeServices(s) {
  const parts = [];
  parts.push(
    s.searxng.requested ? `searxng ${s.searxng.sources ? `\u2713 ${s.searxng.sources} result(s)` : "\u2717 no results"}` : "searxng not in this mode's backends"
  );
  parts.push(s.firecrawl.pages ? `firecrawl \u2713 ${s.firecrawl.pages} page(s)` : "firecrawl \u2717 not used");
  if (s.browser) parts.push(s.browser.pages ? `browser \u2713 ${s.browser.pages} page(s)` : "browser \u2717 not used");
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
var OFF_TOPIC_TERM_SHARE = 1 / 3;
var OFF_TOPIC_CONTENT = 0.2;
function round4(n) {
  return Number(n.toFixed(4));
}
function headingLines(text) {
  return text.split("\n").filter((l) => /^#{1,6}\s/.test(l)).join("\n");
}
var ENRICH_NUDGE = "agent: run another WebSearch round at the thin areas and fold the WHOLE round in with `ultrasearch ingest --run <dir> --web-results <f.json>` (one process, not one per URL) before writing the report.";
var ENRICH_NUDGE_NO_WRITE = "agent: run another WebSearch round at the thin areas and read those pages directly before answering.";
function defaultRunDir(mode2, question, d) {
  return join12(tmpdir3(), "ultrasearch", `${mode2}-${slugify(question, RUN_SLUG)}`, runId(d));
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
function resolveBackends(options, mode2) {
  if (options.backends?.length) return [...new Set(options.backends)];
  const base2 = options.depth === "deep" ? [...mode2.backends, ...mode2.deepOnly] : [...mode2.backends];
  const withEngine = applyWebEngine(base2, options.webEngine);
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
  const mode2 = getMode(options.mode);
  const backends = resolveBackends(options, mode2);
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
  const browser = options.browser ??= resolveBrowserRung().mode;
  const ctx = { question: options.question, mode: mode2, options, variants };
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
  const browserTried = /* @__PURE__ */ new Set();
  let browserRescues = 0;
  const extractorUse = /* @__PURE__ */ new Map();
  const prehydratedTallied = /* @__PURE__ */ new Set();
  const docExtractorUse = /* @__PURE__ */ new Map();
  const tallyExtractor = (res, url) => {
    const k = res.extractor ?? "native";
    extractorUse.set(k, (extractorUse.get(k) ?? 0) + 1);
    if (url && res.extractor && docFormatForUrl(url)) {
      docExtractorUse.set(k, (docExtractorUse.get(k) ?? 0) + 1);
    }
  };
  const extractOpts = { acceptLanguage, firecrawl: options.firecrawl, browser };
  const hydrate = (url, key) => {
    let p = hydrateCache.get(key);
    if (!p) {
      p = readPastCachedWall(url, extractOpts, !!options.cache).then((res) => {
        if (res.cached) cacheHits++;
        tallyExtractor(res, url);
        return res;
      });
      hydrateCache.set(key, p);
    }
    return p;
  };
  const ncbiCache = /* @__PURE__ */ new Map();
  const ncbiServed = /* @__PURE__ */ new Set();
  const readNcbi = (doc) => {
    let p = ncbiCache.get(doc.textUrl);
    if (!p) {
      p = readNcbiDocument(doc, { cache: !!options.cache });
      ncbiCache.set(doc.textUrl, p);
    }
    return p;
  };
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
        const key2 = canonicalizeUrl(it.url);
        if (it.meta?.extractor && !prehydratedTallied.has(key2)) {
          tallyExtractor({ extractor: it.meta.extractor }, it.url);
          prehydratedTallied.add(key2);
        }
        return;
      }
      const key = canonicalizeUrl(it.url);
      const ncbi = ncbiDocument(it.url);
      if (ncbi) {
        const got = await readNcbi(ncbi);
        if (got.ok) {
          it.text = got.text;
          it.fullText = true;
          it.meta = { ...it.meta, textVia: got.via };
          if (!it.snippet) it.snippet = bestExcerpt(got.text, options.question);
          if ((!it.title || it.title === it.url) && got.title) it.title = got.title;
          ncbiServed.add(ncbi.id);
          return;
        }
      }
      const fromCache = hydrateCache.has(key);
      const res = await hydrate(it.url, key);
      if (res.finalUrl && res.finalUrl !== it.url) it.url = res.finalUrl;
      if (res.note) hydrateNotes.push(res.note);
      let text = res.text?.trim() ? res.text : "";
      let junk = text ? looksLikeWall(text) : void 0;
      let title = junk ? void 0 : res.title;
      if (fromCache && res.waybackSnapshot && it.meta?.waybackSnapshot !== res.waybackSnapshot) {
        it.meta = { ...it.meta, waybackSnapshot: res.waybackSnapshot };
        hydrateNotes.push(`Recovered ${it.url} from the Wayback Machine (snapshot ${res.waybackSnapshot}).`);
      }
      if (!text || junk) {
        const absUrl = typeof it.meta?.absUrl === "string" ? it.meta.absUrl : void 0;
        const candidates2 = [absUrl, resolveProvider(it.url).textUrl, absUrl ? resolveProvider(absUrl).textUrl : void 0];
        for (const cand of [...new Set(candidates2)]) {
          if (!cand || cand === it.url) continue;
          const doc = ncbiDocument(cand);
          const viaNcbi = doc ? await readNcbi(doc) : void 0;
          if (doc && viaNcbi?.ok) {
            text = viaNcbi.text;
            junk = void 0;
            title = title || viaNcbi.title;
            it.meta = { ...it.meta, textVia: viaNcbi.via };
            ncbiServed.add(doc.id);
            hydrateNotes.push(`Primary page for ${it.url} was unusable \u2014 hydrated the fallback ${cand} instead.`);
            break;
          }
          const alt = await hydrate(cand, canonicalizeUrl(cand));
          if (alt.text?.trim() && !looksLikeWall(alt.text)) {
            text = alt.text;
            junk = void 0;
            title = title || alt.title;
            it.meta = { ...it.meta, textVia: cand };
            hydrateNotes.push(`Primary page for ${it.url} was unusable \u2014 hydrated the fallback ${cand} instead.`);
            if (alt.waybackSnapshot) {
              it.meta = { ...it.meta, waybackSnapshot: alt.waybackSnapshot };
              hydrateNotes.push(`Recovered ${it.url} from the Wayback Machine (snapshot ${alt.waybackSnapshot}).`);
            }
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
          hydrateCache.set(key, Promise.resolve({ ...res, text, title, waybackSnapshot: wb.timestamp }));
        }
      }
      if (text && junk && res.extractor !== "firecrawl") {
        const wall = junk;
        const fc = await scrapeViaFirecrawl(it.url, { firecrawl: options.firecrawl });
        if (fc.data?.markdown && !looksLikeWall(fc.data.markdown)) {
          text = fc.data.markdown;
          junk = void 0;
          title = title || fc.data.title;
          tallyExtractor({ extractor: "firecrawl" });
          hydrateCache.set(key, Promise.resolve({ ...res, text: fc.data.markdown, title, extractor: "firecrawl" }));
          hydrateNotes.push(`Extraction from ${it.url} looked like a ${wall} \u2014 re-extracted it with Firecrawl.`);
        }
      }
      if (!text && rescuesEmptyRead(res.status, browser) && !browserTried.has(key) && browserRescues < BROWSER_RESCUE_CAP) {
        browserTried.add(key);
        browserRescues++;
        const rendered = await cachedFetchAndExtract(it.url, { ...extractOpts, browser: "always" }, !!options.cache);
        if (rendered.extractor === "browser" && rendered.text?.trim() && !looksLikeWall(rendered.text)) {
          text = rendered.text;
          junk = void 0;
          title = title || rendered.title;
          tallyExtractor({ extractor: "browser" });
          hydrateCache.set(key, Promise.resolve({ ...res, text: rendered.text, title, extractor: "browser" }));
          hydrateNotes.push(`Recovered ${it.url} in a real browser \u2014 the built-in read was an empty HTTP ${res.status} answer.`);
        } else if (rendered.note) {
          const own = res.note ? rendered.note.replace(res.note, "").trim() : rendered.note;
          if (own) hydrateNotes.push(own);
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
        if (text && isWordedWall(junk)) it.wall = true;
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
    const alphaTerms = bm25.queryTerms.filter((t) => new RegExp("\\p{L}", "u").test(t));
    if (alphaTerms.length >= 2) {
      for (const it of kept) {
        const matched = (matchedByUrl.get(it.url) ?? []).filter((t) => new RegExp("\\p{L}", "u").test(t));
        const content = it.meta?.rank?.content ?? 0;
        const off = isDisambiguation(it) || matched.length === 0 || alphaTerms.length >= 3 && matched.length / alphaTerms.length < OFF_TOPIC_TERM_SHARE && content < OFF_TOPIC_CONTENT;
        if (off) it.offTopic = true;
        else delete it.offTopic;
      }
    }
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
    ...docExtractorUse.size ? { doc: Object.fromEntries(docExtractorUse) } : {},
    // Absent when the rung was off: nothing could have been rendered.
    ...browser !== "off" || extractorUse.has("browser") ? { browser: { mode: browser, pages: extractorUse.get("browser") ?? 0 } } : {}
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
        `\u26A0 max asked for Firecrawl and no page came back through it \u2014 the stack is down. Start it: \`ultrasearch firecrawl up\`. Without it you lose Firecrawl's extraction and its consent-wall rescue, so this run is max-minus-the-stack. ` + (browser !== "off" ? `The browser rung (${browser}) was on, so walled and JS-rendered pages still went through a real browser \u2014 the keyless alternative to the stack.` : `The keyless alternative is the browser rung: \`--browser fallback\` renders walled and JS-rendered pages in a real Chrome or Brave, no container needed.`)
      ] : []
    ] : [],
    ...profile === "light" && !explicit ? [
      `--search light: the keyless scraped cascade and SearXNG are OFF (the WebSearch lane is the discovery). Firecrawl still extracts. Use --search full to fuse the keyless engines in as well.`,
      ...seedDomains.length ? [
        `--seed-domains needs a discovery engine to run its site: queries; --search light has none. Use --search full, or pass those pages in --web-results.`
      ] : [],
      ...(options.rounds ?? 1) >= 2 ? [`--rounds 2 needs a discovery engine for its gap search; --search light has none. Use --search full.`] : []
    ] : [],
    ...ncbiServed.size ? [
      `Read ${ncbiServed.size} PubMed/PMC record(s) through their endpoints (E-utilities abstracts, Europe PMC full text) \u2014 their pages are cookie/anti-bot walls to this reader; each still cites its PubMed or PMC page.`
    ] : [],
    ...cacheHits > 0 ? [`Fetch cache served ${cacheHits} page(s) from disk (up to 24h old). Use --no-cache for an all-live run.`] : [],
    ...services.firecrawl.pages > 0 ? [`Firecrawl cleaned ${services.firecrawl.pages} page(s) (self-hosted, browser-rendered main-content markdown instead of the built-in HTML stripper).`] : [],
    ...services.browser?.pages ? [
      `Rendered ${services.browser.pages} page(s) in a real browser (the keyless browser rung, --browser ${browser}): JS shells and walls the built-in reader could not see past.`
    ] : [],
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
    ...options.template && options.template !== options.mode ? { template: options.template } : {},
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
    slug: `${options.mode}-${slugify(options.question, RUN_SLUG)}`,
    tiers: ["SUMMARY.md", "REPORT.md"],
    extras: mode2.extras,
    notes,
    timings,
    ...thin ? { recallFloor: { count: merged.length, floor } } : {},
    ...coverageTerms.length ? { coverage: { terms: coverageTerms, under } } : {},
    cache: { enabled: !!options.cache, hits: cacheHits },
    services
  };
  const dir = options.out ?? defaultRunDir(options.mode, options.question);
  const { sources } = writeDossier(dir, merged, manifest, templateFor(manifest));
  return { dir, sources, manifest: { ...manifest, sourceCount: sources.length } };
}

// src/enrich.ts
import { existsSync as existsSync8, readFileSync as readFileSync13, statSync as statSync6 } from "fs";
import { basename, resolve } from "path";
import { pathToFileURL } from "url";
function loadState(dir) {
  const { sources, manifest } = readDossier(dir);
  const byCanon = /* @__PURE__ */ new Map();
  for (const s of sources) if (!byCanon.has(s.canonicalUrl)) byCanon.set(s.canonicalUrl, s);
  return { sources, manifest, byCanon, maxId: maxSourceId(sources, manifest.droppedIds), template: templateFor(manifest) };
}
function commit(dir, state, p) {
  const id = `S${++state.maxId}`;
  const s = annotateExtras(p.text, buildSource(p.raw, id, (/* @__PURE__ */ new Date()).toISOString(), p.question), state.manifest);
  writeSourceExtract(dir, s, p.text, state.manifest.depth, p.question);
  state.sources.push(s);
  state.byCanon.set(s.canonicalUrl, s);
  state.manifest = { ...state.manifest, sourceCount: state.sources.length, backendsUsed: [.../* @__PURE__ */ new Set([...state.manifest.backendsUsed, p.backend])] };
  return { id, added: true, ...p.note ? { note: p.note } : {} };
}
function flushIndex(dir, state) {
  writeDossierIndex(dir, state.sources, state.manifest, state.template);
}
async function addSources(dir, hits, opts = {}) {
  opts = { ...opts, browser: opts.browser ?? resolveBrowserRung().mode };
  const rescues = { left: BROWSER_RESCUE_CAP };
  const results = [];
  let state;
  const stateOf = () => state ??= loadState(dir);
  let committed = 0;
  try {
    for (const hit of hits) {
      const { url, title, citeUrl } = typeof hit === "string" ? { url: hit, title: void 0, citeUrl: void 0 } : hit;
      const p = await prepareSource(stateOf, url, { ...opts, title, ...citeUrl ? { citeUrl } : {}, rescues });
      let r;
      if (p.ok) {
        r = commit(dir, stateOf(), p);
        committed++;
      } else {
        r = p.result;
      }
      results.push({ ...r, url });
    }
  } finally {
    if (state && committed > 0) flushIndex(dir, state);
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
  let state;
  const stateOf = () => state ??= loadState(dir);
  let committed = 0;
  try {
    for (const p of paths) {
      const abs = resolve(p);
      const url = pathToFileURL(abs).href;
      const prep = await prepareFile(stateOf, abs, opts);
      let r;
      if (prep.ok) {
        r = commit(dir, stateOf(), prep);
        committed++;
      } else {
        r = prep.result;
      }
      results.push({ ...r, url });
    }
  } finally {
    if (state && committed > 0) flushIndex(dir, state);
  }
  return {
    results,
    added: results.filter((r) => r.added).length,
    skipped: results.filter((r) => !r.added).length
  };
}
async function prepareFile(stateOf, abs, opts) {
  const url = pathToFileURL(abs).href;
  if (!existsSync8(abs) || !statSync6(abs).isFile()) {
    return { ok: false, result: { id: "", added: false, note: `${abs} is not a readable file` } };
  }
  const state = stateOf();
  const question = opts.question ?? state.manifest.question;
  const existing = state.byCanon.get(canonicalizeUrl(url));
  if (existing) return { ok: false, result: { id: existing.id, added: false, note: `already in dossier as ${existing.id}` } };
  const bytes = readFileSync13(abs);
  const name = basename(abs);
  let text;
  let extractor;
  const docFmt = docFormatForUrl(url);
  if (looksLikePdfUrl(url)) {
    const got = await extractPdf(bytes, {});
    if (!got.text) return { ok: false, result: { id: "", added: false, note: `could not extract text from ${name} \u2014 ${got.reason}.` } };
    text = got.text;
    extractor = got.via;
  } else if (docFmt) {
    const got = await extractDocument(bytes, docFmt, {});
    if (!got.text && docFmt.textFallback) text = bytes.toString("utf8");
    else if (!got.text) return { ok: false, result: { id: "", added: false, note: `could not extract text from ${name} \u2014 ${got.reason}.` } };
    else {
      text = got.text;
      extractor = got.via;
    }
  } else if (TEXT_FILE_RE.test(abs)) {
    const raw2 = bytes.toString("utf8");
    text = /\.html?$/i.test(abs) ? htmlToText(extractMainHtml(raw2)) : raw2;
  } else {
    return {
      ok: false,
      result: {
        id: "",
        added: false,
        note: `${name}: unsupported file type \u2014 ingest reads PDFs, office documents (${DOC_EXTENSIONS.join(", ")}) and plain text.`
      }
    };
  }
  if (!text.trim()) return { ok: false, result: { id: "", added: false, note: `${name} is empty` } };
  const raw = {
    url,
    title: titleFromText(text) || name,
    backend: "file",
    score: 0,
    snippet: bestExcerpt(text, question),
    text,
    ...extractor ? { meta: { textVia: extractor } } : {}
  };
  return { ok: true, raw, backend: "file", text, question };
}
async function addSource(dir, url, opts = {}) {
  const state = loadState(dir);
  const p = await prepareSource(() => state, url, opts);
  if (!p.ok) return p.result;
  const r = commit(dir, state, p);
  flushIndex(dir, state);
  return r;
}
async function prepareSource(stateOf, url, opts) {
  const state = stateOf();
  const question = opts.question ?? state.manifest.question;
  const addressed = addressedIdCount(url);
  if (addressed > 1) {
    return { ok: false, result: { id: "", added: false, note: `${url} addresses ${addressed} records \u2014 a source is ONE document. Fetch them one at a time.` } };
  }
  const supplied = opts.citeUrl?.trim();
  if (supplied && !isCitableUrl(supplied)) {
    return { ok: false, result: { id: "", added: false, note: `citeUrl ${supplied} is not a page a reader can open \u2014 pass the document's own page.` } };
  }
  const provider = resolveProvider(url);
  if (provider.reject && !supplied) return { ok: false, result: { id: "", added: false, note: provider.reject } };
  const ncbi = ncbiDocument(url);
  let citeUrl = supplied || ncbi?.citeUrl || provider.citeUrl;
  const canon = canonicalizeUrl(citeUrl);
  const existing = state.byCanon.get(canon);
  if (existing) {
    return { ok: false, result: { id: existing.id, added: false, note: `already in dossier as ${existing.id}` } };
  }
  let ncbiMiss;
  if (ncbi) {
    const got = await readNcbiDocument(ncbi, { cache: !!opts.cache });
    if (got.ok) {
      const backend2 = opts.backend ?? "claude";
      const raw2 = {
        url: citeUrl,
        title: opts.title || got.title || titleFromText(got.text) || citeUrl,
        backend: backend2,
        score: 0,
        snippet: bestExcerpt(got.text, question),
        text: got.text,
        meta: { textVia: got.via }
      };
      return { ok: true, raw: raw2, backend: backend2, text: got.text, question };
    }
    ncbiMiss = got.why;
  }
  const preferred = provider.preferText && provider.textUrl ? provider.textUrl : citeUrl;
  const readsEndpoint = !isCitableUrl(url) && citeUrl !== url;
  const readUrl = supplied || readsEndpoint ? url : preferred;
  const browser = opts.browser ?? resolveBrowserRung().mode;
  const readOpts = { firecrawl: opts.firecrawl, browser };
  const fetched = await readPastCachedWall(readUrl, readOpts, !!opts.cache);
  let { text, title } = fetched;
  let rendered = fetched.extractor === "browser";
  let wall = text?.trim() ? looksLikeWall(text) : void 0;
  if (wall) title = void 0;
  const meta = {};
  let via;
  if (readUrl !== citeUrl) {
    via = readUrl;
    meta.textVia = readUrl;
  }
  const fallbackUrl = readUrl === citeUrl ? provider.textUrl : citeUrl;
  if ((!text?.trim() || wall) && fallbackUrl && fallbackUrl !== readUrl) {
    const alt = await readPastCachedWall(fallbackUrl, readOpts, !!opts.cache);
    if (alt.text?.trim() && !looksLikeWall(alt.text)) {
      text = alt.text;
      title = title || alt.title;
      wall = void 0;
      rendered = alt.extractor === "browser";
      via = fallbackUrl === citeUrl ? void 0 : fallbackUrl;
      if (via) meta.textVia = via;
      else delete meta.textVia;
    }
  }
  if (text?.trim() && wall && fetched.extractor !== "firecrawl") {
    const fc = await scrapeViaFirecrawl(readUrl, { firecrawl: opts.firecrawl });
    if (fc.data?.markdown && !looksLikeWall(fc.data.markdown)) {
      text = fc.data.markdown;
      title = title || fc.data.title;
      wall = void 0;
      rendered = false;
    }
  }
  let note;
  const rescues = opts.rescues ?? { left: BROWSER_RESCUE_CAP };
  if (!text?.trim() && rescuesEmptyRead(fetched.status, browser) && rescues.left > 0) {
    rescues.left--;
    const page = await cachedFetchAndExtract(readUrl, { ...readOpts, browser: "always" }, !!opts.cache);
    if (page.extractor === "browser" && page.text?.trim() && !looksLikeWall(page.text)) {
      note = `Recovered ${readUrl} in a real browser \u2014 the built-in read was an empty HTTP ${fetched.status} answer.`;
      text = page.text;
      title = title || page.title;
      wall = void 0;
      rendered = true;
    }
  }
  if (!text?.trim() && DEAD_LINK_STATUS.has(fetched.status)) {
    const wb = await rescueViaWayback(readUrl, readOpts);
    if (wb) {
      text = wb.text;
      title = title || wb.title;
      wall = void 0;
      rendered = false;
      meta.waybackSnapshot = wb.timestamp;
    }
  }
  if (text?.trim() && wall) {
    return {
      ok: false,
      result: {
        id: "",
        added: false,
        note: `${readUrl} extracted to a ${wall}, not content \u2014 not added. Retry later, or pin a source that carries the text.` + (ncbiMiss ? ` (${ncbiMiss}.)` : "")
      }
    };
  }
  if (!text?.trim()) {
    const why = fetched.note ?? `no readable content at ${readUrl}`;
    return { ok: false, result: { id: "", added: false, note: ncbiMiss ? `${why} (${ncbiMiss}.)` : why } };
  }
  if (supplied && supplied !== url) {
    meta.textVia = url;
    via = url;
  } else if (!isCitableUrl(citeUrl)) {
    const derived = deriveCitableUrl(text, fetched.canonical);
    if (!derived) {
      return {
        ok: false,
        result: {
          id: "",
          added: false,
          note: `${citeUrl} is an API endpoint and its payload names no document (no canonical link, DOI, arXiv id or PMID). Find the page this record describes and pass it as citeUrl \u2014 the text still comes from the endpoint.`
        }
      };
    }
    meta.textVia = citeUrl;
    via = citeUrl;
    citeUrl = derived;
    const dup = state.byCanon.get(canonicalizeUrl(citeUrl));
    if (dup) return { ok: false, result: { id: dup.id, added: false, note: `already in dossier as ${dup.id} (${citeUrl})` } };
  }
  if (rendered) meta.extractor = "browser";
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
  return { ok: true, raw, backend, text, question, ...note ? { note } : {} };
}

// src/render.ts
import { existsSync as existsSync13, readFileSync as readFileSync14 } from "fs";
import { join as join15 } from "path";

// src/claims.ts
var SOURCE_RE = /^S\d+$/;
function hintMask(lines) {
  return markedQuoteMask(lines, /\[model-hint\]/i);
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
function cellsOf(line) {
  return line.trim().replace(/^\|/, "").replace(/\|$/, "").split("|").map((c) => c.trim());
}
function tableCells(line, dropFirst = false) {
  return (dropFirst ? cellsOf(line).slice(1) : cellsOf(line)).join(" ");
}
var INDEX_HEADER = /^(#|n[°ºo]\.?|no\.|num(ber|éro|ero)?\.?|r[ée]f(s|\.|érence|erence)?\.?|id|item)$/i;
var INDEX_CELL = /^\[?\d{1,3}\]?\.?$/;
function indexColumnRows(lines, code) {
  const out = lines.map(() => false);
  for (let i = 0; i + 1 < lines.length; i++) {
    if (code[i] || code[i + 1] || !isTableRow(lines[i]) || !isTableSeparator(lines[i + 1])) continue;
    const rows = [];
    for (let j = i + 2; j < lines.length && !code[j] && isTableRow(lines[j]); j++) rows.push(j);
    if (cellsOf(lines[i]).length < 2) continue;
    const header2 = cellsOf(lines[i])[0].replace(/[*_`]/g, "").trim();
    const firsts = rows.map((j) => cellsOf(lines[j])[0].replace(/[*_`]/g, "").trim());
    const index = INDEX_HEADER.test(header2) || rows.length >= 2 && firsts.every((c) => INDEX_CELL.test(c));
    if (index) for (const j of rows) out[j] = true;
    i = rows.length ? rows[rows.length - 1] : i + 1;
  }
  return out;
}
var NO_NUMERALS_RE = /<!--\s*ultrasearch:no-numerals\s*-->/i;
function noNumeralsMask(rawLines) {
  const out = rawLines.map(() => false);
  for (let i = 0; i < rawLines.length; i++) {
    const line = rawLines[i];
    if (!NO_NUMERALS_RE.test(line)) continue;
    let start = i;
    if (!line.replace(NO_NUMERALS_RE, "").trim()) {
      start = i + 1;
      while (start < rawLines.length && !rawLines[start].trim()) start++;
    } else {
      while (start > 0 && rawLines[start - 1].trim()) start--;
    }
    for (let j = start; j < rawLines.length && rawLines[j].trim(); j++) out[j] = true;
  }
  return out;
}
function isListItem(line) {
  return /^\s*([-*+]|\d+\.)\s+\S/.test(line);
}
function extractUnits(lines, code, hint, noNumerals = []) {
  const units = [];
  const indexRows = indexColumnRows(lines, code);
  let prose = [];
  let proseExempt = false;
  const flag = (u, exempt) => exempt ? { ...u, noNumerals: true } : u;
  const flush = () => {
    if (prose.length) units.push(flag({ kind: "text", text: prose.join(" ") }, proseExempt));
    prose = [];
    proseExempt = false;
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
      if (!isTableSeparator(next)) units.push(flag({ kind: "text", text: tableCells(line, indexRows[i]) }, !!noNumerals[i]));
      i++;
      continue;
    }
    if (/^\s*>/.test(line)) {
      flush();
      const quoted = [];
      const exempt = !!noNumerals[i];
      while (i < lines.length && !code[i] && !hint[i]) {
        const ql = stripInlineCode(lines[i]);
        if (!/^\s*>/.test(ql)) break;
        const dq = ql.replace(/^\s*>\s?/, "").trim();
        if (dq) quoted.push(dq);
        i++;
      }
      if (quoted.length) units.push(flag({ kind: "text", text: quoted.join(" ") }, exempt));
      continue;
    }
    if (isListItem(line)) {
      flush();
      const items = [];
      const exempt = !!noNumerals[i];
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
      units.push(flag({ kind: "list", items }, exempt));
      continue;
    }
    prose.push(line);
    if (noNumerals[i]) proseExempt = true;
    i++;
  }
  flush();
  return units;
}
var APPENDIX_HEADING = /^(?:sources?|references?|r[ée]f[ée]rences(?:\s+bibliographiques)?|bibliograph(?:y|ie)|works cited)\s*\(.*\)$/i;
function reportAppendixMask(lines) {
  return appendixMask(lines, { headings: APPENDIX_HEADING });
}
function maskedFile(text) {
  const noNumerals = noNumeralsMask(text.split("\n"));
  const lines = stripHtmlComments(text).split("\n");
  const code = codeMask(lines);
  const { mask: hint, regions } = hintMask(lines);
  const appendix = reportAppendixMask(lines);
  return { lines, code, regions, appendix, unclaimable: hint.map((h, i) => h || appendix[i]), noNumerals };
}
function unitsOfMasked(m) {
  return extractUnits(m.lines, m.code, m.unclaimable, m.noNumerals);
}
function unitsOfFile(text) {
  return unitsOfMasked(maskedFile(text));
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
  const appendix = reportAppendixMask(lines);
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
    const base2 = `${idPrefix}-${slugify(text, RUN_SLUG)}`;
    let id = base2;
    let n = 2;
    while (usedIds.has(id)) id = `${base2}-${n++}`;
    usedIds.add(id);
    return id;
  };
  while (i < lines.length) {
    const line = lines[i];
    const fence = /^\s*(```|~~~)(.*)$/.exec(line);
    if (fence) {
      const marker = fence[1];
      const close = new RegExp(`^\\s*${marker}`);
      const body = [];
      i++;
      while (i < lines.length && !close.test(lines[i])) {
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
      const inner2 = inline(escapeHtml(quote.join(" ").trim()));
      if (isHint) {
        out.push(`<blockquote class="model-hint"><span class="mhint-badge">model hint \xB7 unverified</span> ${inner2}</blockquote>`);
      } else {
        out.push(`<blockquote>${inner2}</blockquote>`);
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
function loadRenderContext(dir) {
  const { sources, manifest } = readDossier(dir);
  const verify = readVerify(dir);
  const tiers = [];
  const cited = /* @__PURE__ */ new Set();
  for (const tier of TIERS) {
    const p = join15(dir, tier.file);
    if (!existsSync13(p)) continue;
    const text = readFileSync14(p, "utf8");
    tiers.push({ tier, text });
    for (const id of citedSourceIds(text)) cited.add(id);
  }
  return { dir, sources, manifest, tiers, verify, cited };
}
function toContext(dirOrCtx) {
  return typeof dirOrCtx === "string" ? loadRenderContext(dirOrCtx) : dirOrCtx;
}
function readVerify(dir) {
  const p = join15(dir, "VERIFY.json");
  if (!existsSync13(p)) return void 0;
  try {
    return JSON.parse(readFileSync14(p, "utf8"));
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
function renderHtml(dirOrCtx) {
  const ctx = toContext(dirOrCtx);
  const { sources, manifest, verify } = ctx;
  const verdicts = worstBySource(verify);
  const rendered = ctx.tiers.map(({ tier, text }) => {
    const { html, headings } = mdToHtml(text, tier.id, { verdicts });
    return { ...tier, html, headings };
  });
  let contradictionsId;
  for (const t of rendered) {
    const h = t.headings.find((x) => /open question|contradiction|questions? ouvertes?/i.test(x.text));
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
  main2.push(sourcesSection(sources, ctx.cited));
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
      ...s.wall ? [`<span class="snippet-only" title="the page was a consent/anti-bot wall \u2014 snippet only">\u26D4 wall</span>`] : s.fullText === false ? [`<span class="snippet-only" title="page fetch failed \u2014 snippet only">\u26A0 snippet only</span>`] : [],
      ...uncited ? [`<span class="chip-uncited" title="never cited by any report tier">uncited</span>`] : []
    ].join(" \xB7 ");
    const cls = uncited ? ` class="s-uncited"` : "";
    return `<li id="src-${s.id}"${cls}><strong>[${s.id}]</strong> <a href="${escapeHtml(s.url)}" rel="noopener" target="_blank">${escapeHtml(s.title)}</a><br><span class="s-meta">${meta}</span></li>`;
  }).join("\n");
  return `<section id="sources"><h1>Sources</h1><ol class="sources">${items}</ol></section>`;
}
function writeHtml(dirOrCtx, out) {
  const ctx = toContext(dirOrCtx);
  const html = renderHtml(ctx);
  const path = out ?? join15(ctx.dir, "index.html");
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
function buildReportMarkdown(dirOrCtx) {
  const ctx = toContext(dirOrCtx);
  const { sources, manifest, verify } = ctx;
  const meta = `> ${manifest.mode} \xB7 depth ${manifest.depth} \xB7 ${sources.length} sources${manifest.lang ? ` \xB7 lang ${manifest.lang}` : ""}${manifest.region ? `/${manifest.region}` : ""} \xB7 ${manifest.builtAt} \xB7 generated by ultrasearch`;
  const parts = [`# ${manifest.question || "ultrasearch report"}`, "", meta, ""];
  for (const { tier, text } of ctx.tiers) {
    const body = text.trim();
    if (!body) continue;
    parts.push("---", "", `## ${tier.label}`, "", body, "");
  }
  if (verify) {
    parts.push("---", "", verificationMarkdown(verify));
  }
  parts.push("---", "", `## Sources`, "");
  if (sources.length) {
    const cited = ctx.cited;
    const mark = cited.size > 0;
    for (const s of sources) {
      const flag = s.wall ? " \xB7 \u26D4 wall" : s.fullText === false ? " \xB7 \u26A0 snippet only" : "";
      const uncited = mark && !cited.has(s.id) ? " \xB7 uncited" : "";
      parts.push(`- **[${s.id}]** [${mdLinkText(s.title)}](${s.url}) \u2014 ${s.backend} \xB7 ${s.domain} \xB7 trust ${s.trust}${flag}${uncited}`);
    }
  } else {
    parts.push("_No sources in this dossier yet._");
  }
  parts.push("");
  return parts.join("\n");
}
function writeReportMarkdown(dirOrCtx, out) {
  const ctx = toContext(dirOrCtx);
  const md = buildReportMarkdown(ctx);
  const path = out ?? join15(ctx.dir, "index.md");
  return writeArtifact(path, md);
}

// src/check.ts
import { existsSync as existsSync15, readFileSync as readFileSync16 } from "fs";
import { join as join20 } from "path";

// src/verify.ts
import { createHash as createHash2 } from "crypto";
import { existsSync as existsSync14, readFileSync as readFileSync15, readdirSync as readdirSync4 } from "fs";
import { join as join19 } from "path";
var HARD_FILES = ["REPORT.md"];
var VALID_VERDICTS = ["supported", "partial", "refuted", "unsupported"];
function pairFingerprint(claim, extract) {
  return createHash2("sha256").update(String(claim.length)).update("|").update(claim).update(extract).digest("hex").slice(0, 32);
}
function claimStrings(text) {
  const out = [];
  for (const u of unitsOfFile(text)) {
    const noNumerals = u.noNumerals === true;
    if (u.kind === "text") out.push({ claim: u.text, noNumerals });
    else for (const it of u.items) out.push({ claim: it, noNumerals });
  }
  return out;
}
function buildWorklist(dir, opts = {}) {
  const sources = readJson3(join19(dir, "sources.json"), "sources.json");
  const identityError = sourceIdentityError(sources);
  if (identityError) throw new Error(`sources.json in ${dir} ${identityError} \u2014 re-run \`ultrasearch gather\`.`);
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
      t = normalizeNumeralText(sourceTextWithoutPassageLabels(textOf(s)));
      normCache.set(s.id, t);
    }
    return t;
  };
  const pairs = [];
  let claimNo = 0;
  for (const file of HARD_FILES) {
    const p = join19(dir, file);
    if (!existsSync14(p)) continue;
    const text = readFileSync15(p, "utf8");
    for (const { claim, noNumerals } of claimStrings(text)) {
      const ids = unitSourceTokens(claim).filter((id) => byId.has(id));
      if (!ids.length) continue;
      claimNo++;
      const claimId = `C${claimNo}`;
      const nums = noNumerals ? [] : extractNumerals(claim);
      for (const id of ids) {
        const s = byId.get(id);
        pairs.push({
          claimId,
          file,
          sourceId: id,
          claim: claim.trim().slice(0, 400),
          extractPath: s.extract,
          trust: s.trust,
          source: s,
          rawClaim: claim,
          nums
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
  const emit = (p) => {
    if (opts.keysOnly) {
      return { claimId: p.claimId, file: p.file, sourceId: p.sourceId, claim: p.claim, extractPath: p.extractPath, extractDigest: "" };
    }
    const norm3 = p.nums.length ? normOf(p.source) : "";
    const numeralsAbsent = p.nums.filter((n) => !norm3.includes(n));
    return {
      claimId: p.claimId,
      file: p.file,
      sourceId: p.sourceId,
      claim: p.claim,
      extractPath: p.extractPath,
      extractDigest: focusedSnippet(textOf(p.source), p.rawClaim, { maxChars: 600, maxSentences: 4 }),
      // Bound to the FULL claim + the FULL extract as they are RIGHT NOW.
      fingerprint: pairFingerprint(p.rawClaim, textOf(p.source)),
      ...numeralsAbsent.length ? { numeralsAbsent } : {}
    };
  };
  const worklist = { run: dir, pairs: shaped.map(emit) };
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
  writeArtifact(join19(dir, todoName), JSON.stringify(todo, null, 2));
  writeArtifact(join19(dir, mdName), renderWorklistMd(worklist, total, kept));
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
  const raw = readJson3(verdictsPath, `verdicts file`);
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
      ...typeof v.fingerprint === "string" && v.fingerprint ? { fingerprint: v.fingerprint } : {},
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
var pairKey = (p) => `${p.claimId}/${p.sourceId}`;
function bindToWorklist(dir, verdicts, opts = {}) {
  let expected;
  try {
    expected = buildWorklist(dir).worklist.pairs;
  } catch {
    return { derivable: false, stale: [], unbound: [], bound: verdicts, expected: [] };
  }
  const byKey = new Map(expected.map((p) => [pairKey(p), p]));
  const saved2 = /* @__PURE__ */ new Map();
  if (!opts.strict) {
    for (const name of readdirSync4(dir).filter((name2) => /^VERIFY\.todo(?:\.\d+)?\.json$/.test(name2))) {
      try {
        const todo = JSON.parse(readFileSync15(join19(dir, name), "utf8"));
        if (!Array.isArray(todo?.pairs)) continue;
        for (const p of todo.pairs) {
          if (!p || typeof p.claimId !== "string" || typeof p.sourceId !== "string" || !/^[a-f0-9]{32}$/.test(p.fingerprint ?? "")) continue;
          const key = pairKey(p);
          const fingerprints = saved2.get(key) ?? /* @__PURE__ */ new Set();
          fingerprints.add(p.fingerprint);
          saved2.set(key, fingerprints);
        }
      } catch {
      }
    }
  }
  const stale = [];
  const unbound = [];
  const bound = [];
  for (const v of verdicts) {
    const key = pairKey(v);
    const exp = byKey.get(key);
    if (!exp) {
      bound.push(v);
      continue;
    }
    if (v.fingerprint) {
      if (v.fingerprint !== exp.fingerprint) stale.push(key);
      bound.push(v);
      continue;
    }
    const contradicts = !!v.claim && v.claim.trim() !== exp.claim.trim() || !!v.extractPath && v.extractPath !== exp.extractPath || !!v.extractDigest && v.extractDigest !== exp.extractDigest;
    const fingerprints = saved2.get(key);
    if (contradicts || !opts.strict && fingerprints && !fingerprints.has(exp.fingerprint)) stale.push(key);
    else if (opts.strict || !fingerprints) {
      if (v.verdict) unbound.push(key);
      bound.push(v);
      continue;
    }
    bound.push(stale.includes(key) ? v : { ...v, fingerprint: exp.fingerprint });
  }
  return { derivable: true, stale, unbound, bound, expected };
}
function applyVerdicts(dir, verdictsPath) {
  const paths = Array.isArray(verdictsPath) ? verdictsPath : [verdictsPath];
  const merged = /* @__PURE__ */ new Map();
  for (const p of paths) {
    for (const v of parseVerdictFile(p)) {
      merged.set(`${v.claimId} ${v.sourceId}`, v);
    }
  }
  const binding = bindToWorklist(dir, [...merged.values()]);
  if (binding.stale.length) {
    throw new Error(
      `${binding.stale.length} verdict(s) judged text that has changed since the worklist was generated (${binding.stale.slice(0, 6).join(", ")}${binding.stale.length > 6 ? ", \u2026" : ""}): REPORT.md and/or the cited extract were edited after \`verify\`. Re-run \`verify\` and re-adjudicate the regenerated worklist, then \`verify --apply\` \u2014 a verdict cannot be transferred to text nobody judged (nothing was written).`
    );
  }
  if (binding.unbound.length) {
    throw new Error(
      `Unbound verdict(s) (${binding.unbound.join(", ")}): missing a valid generation-time fingerprint. Re-run \`verify\`, re-adjudicate the saved worklist, then \`verify --apply\` (nothing was written).`
    );
  }
  const verdicts = binding.bound;
  const result = reduceVerdicts(verdicts);
  writeArtifact(join19(dir, "VERIFY.json"), JSON.stringify({ ...result, verdicts }, null, 2));
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
  const mf = maskedFile(text);
  const { lines, code, regions, appendix } = mf;
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
  const units = unitsOfMasked(mf);
  for (const u of units) {
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
  return { file, sourceTokens, appendixSourceTokens, modelHints: mMarkers + regions, unknownTokens, unsourcedClaims, units };
}
function applySemantic(dir, result, requireVerify) {
  const flag = requireVerify ? "--require-verify" : "--semantic";
  const p = join20(dir, "VERIFY.json");
  if (!existsSync15(p)) {
    result.ok = false;
    result.errors.push(`${flag}: no VERIFY.json \u2014 run \`verify\` then \`verify --apply <verdicts.json>\` before the semantic gate.`);
    return;
  }
  let stored;
  try {
    stored = JSON.parse(readFileSync16(p, "utf8"));
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
    const binding = bindToWorklist(dir, verdicts, { strict: true });
    if (!binding.derivable) {
      result.ok = false;
      result.errors.push(
        `${flag}: REPORT's claim\u2194source worklist could not be re-derived (unreadable sources.json/extract), so the verdicts cannot be bound to the text they judged \u2014 fix the dossier and re-run \`verify\` + \`verify --apply\`.`
      );
    }
    if (binding.stale.length) {
      result.ok = false;
      result.errors.push(
        `${flag}: ${binding.stale.length} adjudicated pair(s) no longer match the text they judged (${binding.stale.slice(0, 6).join(", ")}${binding.stale.length > 6 ? ", \u2026" : ""}) \u2014 REPORT.md and/or the cited extract changed since \`verify\` generated the worklist. Re-run \`verify\`, re-adjudicate, then \`verify --apply\`.`
      );
    }
    if (binding.unbound.length) {
      result.ok = false;
      result.errors.push(
        `${flag}: ${binding.unbound.length} verdict(s) in VERIFY.json are not bound to any adjudicated content (${binding.unbound.slice(0, 6).join(", ")}${binding.unbound.length > 6 ? ", \u2026" : ""}) \u2014 the record predates or bypasses content binding. Re-run \`verify\` and \`verify --apply <verdicts.json>\` to bind each verdict to the claim + extract it judged.`
      );
    }
    const expected = binding.derivable ? binding.expected : [];
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
    return JSON.parse(readFileSync16(join20(dir, "manifest.json"), "utf8"));
  } catch {
    return void 0;
  }
}
function runCheck(dir, opts = {}) {
  const errors = [];
  const warnings = [];
  const sourcesPath = join20(dir, "sources.json");
  if (!existsSync15(sourcesPath)) {
    return blank(false, [`No sources.json in ${dir} \u2014 run \`ultrasearch gather\` first.`]);
  }
  let sources;
  try {
    sources = JSON.parse(readFileSync16(sourcesPath, "utf8"));
  } catch (e) {
    return blank(false, [`sources.json is unreadable: ${e.message}`]);
  }
  const identityError = sourceIdentityError(sources);
  if (identityError) return blank(false, [`sources.json in ${dir} ${identityError} \u2014 re-run \`ultrasearch gather\`.`]);
  const ids = new Set(sources.map((s) => s.id));
  const present = [...HARD_FILES2, ...SOFT_FILES].filter((f) => existsSync15(join20(dir, f)));
  if (!present.some((f) => HARD_FILES2.includes(f))) {
    return blank(false, [`No REPORT.md in ${dir} \u2014 write the report tier, then re-run check.`]);
  }
  const analyses = present.map((f) => analyzeFile(f, readFileSync16(join20(dir, f), "utf8")));
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
  const bySourceId = new Map(sources.map((s) => [s.id, s]));
  const textCache = /* @__PURE__ */ new Map();
  const textOf = (id) => {
    let t = textCache.get(id);
    if (t === void 0) {
      const s = bySourceId.get(id);
      try {
        t = s && existsSync15(join20(dir, s.extract)) ? readSourceText(dir, s) : null;
      } catch {
        t = null;
      }
      textCache.set(id, t);
    }
    return t;
  };
  const walledCited = [];
  const snippetCited = [];
  const apiCited = [];
  for (const s of sources) {
    if (!citedIds.has(s.id)) continue;
    if (isApiEndpoint(s.url)) apiCited.push(s.id);
    const text = textOf(s.id);
    const worded = text === null ? void 0 : wallPattern(text);
    if (s.wall || worded) {
      walledCited.push({ id: s.id, wall: worded ?? "consent/anti-bot wall" });
      continue;
    }
    if (s.fullText === false) {
      snippetCited.push({ id: s.id, why: "snippet only \u2014 the page fetch failed" });
      continue;
    }
    if (text === null) continue;
    const n = usefulChars(sourceTextWithoutPassageLabels(text));
    if (n < MIN_USEFUL_CHARS) snippetCited.push({ id: s.id, why: `near-empty extract (${n} useful characters)` });
  }
  if (walledCited.length) {
    errors.push(
      `${walledCited.length} cited source(s) are a wall, not content: ${walledCited.slice(0, 5).map((w) => `${w.id} (${w.wall})`).join(", ")}${walledCited.length > 5 ? ", \u2026" : ""}. A claim resting on one rests on nothing \u2014 re-\`fetch --url\` the page (or its text endpoint), cite another source, or \`drop --where wall\`.`
    );
  }
  if (snippetCited.length) {
    const msg = `${snippetCited.length} cited source(s) hold no readable page: ${snippetCited.slice(0, 5).map((w) => `${w.id} (${w.why})`).join(", ")}${snippetCited.length > 5 ? ", \u2026" : ""}. Nobody can check a claim against them \u2014 re-\`fetch --url\` the page or cite a source that carries the text.`;
    if (opts.failOnWall) errors.push(`--fail-on-wall: ${msg}`);
    else warnings.push(msg);
  }
  if (apiCited.length) {
    warnings.push(
      `${apiCited.length} cited source(s) point at an API endpoint, not a page a reader can open: ${apiCited.slice(0, 5).join(", ")}. Re-\`fetch --url\` them \u2014 the endpoint is where the text lives, the landing page is what gets cited.`
    );
  }
  const numeralIssues = [];
  const normCache = /* @__PURE__ */ new Map();
  const normOf = (id) => {
    let t = normCache.get(id);
    if (t === void 0) {
      const raw = textOf(id);
      t = raw === null ? null : normalizeNumeralText(sourceTextWithoutPassageLabels(raw));
      normCache.set(id, t);
    }
    return t;
  };
  for (const a of analyses) {
    if (!HARD_FILES2.includes(a.file)) continue;
    for (const u of a.units) {
      if (u.noNumerals) continue;
      for (const claim of u.kind === "text" ? [u.text] : u.items) {
        const cited = unitSourceTokens(claim).filter((id) => ids.has(id));
        if (!cited.length) continue;
        const nums = extractNumerals(claim);
        if (!nums.length) continue;
        const texts = cited.map(normOf).filter((t) => t !== null);
        if (!texts.length) continue;
        for (const n of nums) {
          if (!texts.some((t) => t.includes(n))) {
            numeralIssues.push({ file: a.file, claim: claim.trim().slice(0, 120), numeral: n, sourceIds: cited });
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
  if (!hasOpenQuestions(stripHtmlComments(readFileSync16(join20(dir, "REPORT.md"), "utf8")))) {
    warnings.push(`REPORT.md has no "Open questions" section \u2014 section titles are free, but say what the sources leave open.`);
  }
  if (opts.minSources !== void 0 && sources.length < opts.minSources) {
    errors.push(
      `Only ${sources.length} source(s) in the dossier (--min-sources ${opts.minSources}). Enrich with \`fetch --url\` or broaden the gather before relying on this report.`
    );
  }
  const result = {
    ok: errors.length === 0,
    ...numeralIssues.length ? { numeralIssues } : {},
    ...walledCited.length ? { walledCited } : {},
    ...snippetCited.length ? { snippetCited } : {},
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
  for (const w of (r.walledCited ?? []).slice(0, 8)) lines.push(`  \u2717 ${w.id} is a ${w.wall}, not content`);
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
  return listIssuesFrom(sources, (s) => safeText(dir, s));
}
function listIssuesFrom(sources, textOf) {
  const issues = [];
  for (const s of sources) {
    const text = textOf(s);
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
    const wall = s.wall ? "consent/anti-bot wall" : text ? wallPattern(text) : void 0;
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
  const { sources, manifest } = readDossier(dir);
  const template = templateFor(manifest);
  const state = newState(sources);
  const cache = /* @__PURE__ */ new Map();
  const textOf = (s) => {
    const hit = cache.get(s.id);
    if (hit !== void 0) return hit;
    const text = safeText(dir, s);
    cache.set(s.id, text);
    return text;
  };
  const repaired = [];
  const tried = /* @__PURE__ */ new Set();
  for (; ; ) {
    const next = listIssuesFrom(state.sources, textOf).find((i) => i.reason === "not-citable" && i.derived && !tried.has(i.id));
    if (!next) break;
    tried.add(next.id);
    const { result, relinked, text } = applyRelink(state, next.id, next.derived, textOf);
    if (!result.relinked || !relinked) continue;
    writeSourceExtract(dir, relinked, text ?? "", manifest.depth);
    cache.set(relinked.id, safeText(dir, relinked));
    repaired.push(result);
  }
  if (repaired.length) writeDossierIndex(dir, state.sources, refreshed(manifest, state.sources), template);
  return { repaired, remaining: listIssuesFrom(state.sources, textOf) };
}
function newState(sources) {
  const byCanon = /* @__PURE__ */ new Map();
  for (const s of sources) if (!byCanon.has(s.canonicalUrl)) byCanon.set(s.canonicalUrl, s);
  return { sources: [...sources], byCanon };
}
function applyRelink(state, id, url, textOf, opts = {}) {
  const idx = state.sources.findIndex((s) => s.id === id);
  if (idx < 0) return { result: { id, relinked: false, note: `${id} is not in this dossier` } };
  const target = state.sources[idx];
  const next = url.trim();
  if (!isCitableUrl(next)) {
    return { result: { id, relinked: false, note: `${next} is not a citable page url \u2014 a citation must open in a browser` } };
  }
  const canon = canonicalizeUrl(next);
  if (canon === target.canonicalUrl) return { result: { id, relinked: false, note: `${id} already points at ${next}` } };
  const clash = state.byCanon.get(canon);
  if (clash) {
    return { result: { id, relinked: false, note: `${clash.id} already cites ${next} \u2014 merge the claims onto it instead of duplicating the source` } };
  }
  const from = target.url;
  const text = textOf(target);
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
  state.sources[idx] = relinked;
  if (state.byCanon.get(target.canonicalUrl) === target) state.byCanon.delete(target.canonicalUrl);
  state.byCanon.set(canon, relinked);
  return { result: { id, relinked: true, from, to: next }, relinked, text };
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
  const state = newState(sources);
  const { result, relinked, text } = applyRelink(state, id, url, (s) => safeText(dir, s), opts);
  if (!result.relinked || !relinked) return result;
  writeSourceExtract(dir, relinked, text ?? "", manifest.depth);
  writeDossierIndex(dir, state.sources, refreshed(manifest, state.sources), templateFor(manifest));
  return result;
}
function refreshed(manifest, sources) {
  return { ...manifest, sourceCount: sources.length };
}

// src/drop.ts
import { existsSync as existsSync16, readFileSync as readFileSync17, rmSync as rmSync3 } from "fs";
import { join as join21 } from "path";
var DROP_WHERE = ["wall", "snippet", "offtopic"];
var TIERS2 = ["REPORT.md", "SUMMARY.md", "glossary.md"];
function safeText2(dir, s) {
  try {
    return readSourceText(dir, s);
  } catch {
    return "";
  }
}
function selects(dir, s, where) {
  if (where === "offtopic") return s.offTopic ? "probably off-topic" : void 0;
  if (where === "snippet") return s.fullText === false ? s.wall ? "a wall (snippet only)" : "snippet only" : void 0;
  if (s.wall) return "a wall";
  const worded = wallPattern(safeText2(dir, s));
  return worded ? `a ${worded}` : void 0;
}
function dropSources(dir, sel) {
  if (!sel.ids?.length && !sel.where) throw new Error("drop needs --id <S#,\u2026> or --where wall|snippet|offtopic");
  const { sources, manifest } = readDossier(dir);
  const template = getMode(manifest.mode).template;
  const byId = new Map(sources.map((s) => [s.id, s]));
  const reasons = /* @__PURE__ */ new Map();
  const missing = [];
  for (const raw of sel.ids ?? []) {
    const id = raw.trim().toUpperCase();
    if (!id) continue;
    if (byId.has(id)) reasons.set(id, "asked for by id");
    else if (!missing.includes(id)) missing.push(id);
  }
  if (sel.where) {
    for (const s of sources) {
      const why = selects(dir, s, sel.where);
      if (why && !reasons.has(s.id)) reasons.set(s.id, why);
    }
  }
  const dropped = sources.filter((s) => reasons.has(s.id)).map((s) => ({ id: s.id, url: s.url, title: s.title, reason: reasons.get(s.id) }));
  const ids = new Set(dropped.map((d) => d.id));
  const citedBy = [];
  for (const file of TIERS2) {
    const p = join21(dir, file);
    if (!existsSync16(p)) continue;
    const hit = [...citedSourceIds(readFileSync17(p, "utf8"))].filter((id) => ids.has(id));
    if (hit.length) citedBy.push({ file, ids: hit });
  }
  const remaining = sources.filter((s) => !ids.has(s.id));
  const dryRun = sel.dryRun === true;
  if (dropped.length && !dryRun) {
    if (!isNoWrite()) {
      for (const d of dropped) {
        const s = byId.get(d.id);
        rmSync3(join21(dir, s.extract), { force: true });
      }
    }
    const droppedIds = [.../* @__PURE__ */ new Set([...manifest.droppedIds ?? [], ...ids])].sort((a, b) => Number(a.slice(1)) - Number(b.slice(1)));
    writeDossierIndex(dir, remaining, { ...manifest, sourceCount: remaining.length, droppedIds }, template);
  }
  return { run: dir, dryRun, dropped, missing, citedBy, remaining: dryRun ? sources.length : remaining.length };
}
function formatDropReport(r) {
  const lines = [];
  const verb = r.dryRun ? "would drop" : "dropped";
  if (!r.dropped.length) lines.push(`ultrasearch drop: nothing matched \u2014 the dossier is unchanged (${r.remaining} source(s)).`);
  else lines.push(`ultrasearch drop: ${verb} ${r.dropped.length} source(s) \u2192 ${r.remaining} left in ${r.run}`);
  for (const d of r.dropped) lines.push(`  ${d.id}  ${d.reason}  ${d.url}`);
  if (r.missing.length) lines.push(`  \u26A0 not in this dossier: ${r.missing.join(", ")}`);
  for (const c of r.citedBy) {
    lines.push(`  \u26A0 ${c.file} cites ${c.ids.join(", ")} \u2014 \`check\` will fail them as dangling: rewrite those claims onto another source.`);
  }
  if (r.dropped.length && !r.dryRun) lines.push("  ids are never reused: the next source ingested takes a fresh one.");
  return lines.join("\n");
}

// src/plan.ts
import { join as join22 } from "path";
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
  { re: /risks|moats/i, ask: (s) => `What are the risks and moats for ${s}?`, angle: "what are the risks and moats", terms: ["risk", "moat"] },
  // deals — worded to stay clear of the startup facets above (timing, pricing,
  // customer) and learn's "example": the table stops at the first match.
  {
    re: /candidate code|codes table|coupon|promo code/i,
    ask: (s) => `Which discount codes for ${s} are currently reported, and where?`,
    angle: "which discount codes are currently reported, and where",
    terms: ["promo code", "coupon"]
  },
  {
    re: /own offers/i,
    ask: (s) => `What discounts does ${s} itself offer (first order, newsletter, app, loyalty)?`,
    angle: "what discounts does the merchant itself offer (first order, newsletter, app, loyalty)",
    terms: ["first order discount", "newsletter"]
  },
  {
    re: /ways to save|cashback/i,
    ask: (s) => `What other ways to save on ${s} exist (cashback, student discounts, referral, gift cards)?`,
    angle: "what other ways to save exist (cashback, student discounts, referral, gift cards)",
    terms: ["cashback", "student discount"]
  },
  {
    re: /sales calendar/i,
    ask: (s) => `When do ${s}'s sales and seasonal promotions run?`,
    angle: "when do the sales and seasonal promotions run",
    terms: ["sales", "black friday"]
  },
  {
    re: /expired|fake|unverifiable/i,
    ask: (s) => `Which ${s} codes are reported expired, fake or not working?`,
    angle: "which codes are reported expired, fake or not working",
    terms: ["code not working", "expired"]
  },
  // clinical — last, so they only ever claim headings nothing above matched;
  // the clinical "Gaps & open questions" heading is left to the gaps facet.
  {
    re: /pico|clinical question/i,
    ask: (s) => `Which patients, intervention, comparator and outcomes define the clinical question on ${s}?`,
    angle: "which patients, intervention, comparator and outcomes define the clinical question",
    terms: ["population", "intervention"]
  },
  {
    re: /evidence base|systematic review|randomi[sz]ed/i,
    ask: (s) => `Which trials, systematic reviews and cohort studies have evaluated ${s}?`,
    angle: "which trials, systematic reviews and cohort studies have evaluated it",
    terms: ["randomized controlled trial", "systematic review"]
  },
  {
    re: /efficacy|effectiveness/i,
    ask: (s) => `How effective is ${s} on its main clinical outcomes?`,
    angle: "how effective is it on the main clinical outcomes",
    terms: ["efficacy", "outcomes"]
  },
  {
    re: /safety|adverse|complication/i,
    ask: (s) => `What adverse events and complications are reported for ${s}?`,
    angle: "what adverse events and complications are reported",
    terms: ["adverse events", "complications"]
  },
  {
    re: /guideline|recommendation/i,
    ask: (s) => `What do clinical guidelines recommend about ${s}?`,
    angle: "what do clinical guidelines recommend",
    terms: ["guideline", "recommendation"]
  },
  {
    re: /certainty|risk of bias|level of evidence/i,
    ask: (s) => `How certain is the evidence on ${s}, and what limits it?`,
    angle: "how certain is the evidence, and what limits it",
    terms: ["risk of bias", "GRADE"]
  },
  {
    re: /ongoing|registered trial/i,
    ask: (s) => `Which trials on ${s} are registered or still ongoing?`,
    angle: "which trials are registered or still ongoing",
    terms: ["ongoing trial", "ClinicalTrials.gov"]
  }
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
function runPlan(question, mode2, override, cap = DEEP_CAPS.maxSubQuestions, runRoot, depth) {
  const q = question.trim();
  let subs;
  if (override?.length) {
    subs = override.map((s) => mk(s.trim(), "agent", "agent-supplied"));
  } else {
    subs = [];
    const idents = extractIdentifiers(q);
    if (idents.length) subs.push(mk(`${q} ${idents.join(" ")}`, "identifier", `identifiers: ${idents.join(", ")}`));
    subs.push(...templateFacets(q, getMode(mode2).template));
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
    if (runRoot) s.out = join22(runRoot, s.id.toLowerCase());
  });
  const result = { question: q, mode: mode2, ...depth ? { depth } : {}, subQuestions: uniq };
  if (runRoot) {
    ensureDir(runRoot);
    writeArtifact(join22(runRoot, "PLAN.json"), JSON.stringify(result, null, 2));
  }
  return result;
}

// src/queries.ts
var TARGET_PER_DEPTH = { summary: 2, standard: 4, deep: 8 };
function planQueries(opts) {
  const lang = opts.lang ?? "en";
  const mode2 = getMode(opts.mode);
  const target = TARGET_PER_DEPTH[opts.depth];
  return {
    question: opts.question,
    mode: opts.mode,
    depth: opts.depth,
    lang,
    target,
    planned: planVariants(opts.question, opts.depth),
    angles: mode2.searchAngles.slice(0, target),
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
import { join as join23 } from "path";
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
function buildCandidateQuestions(question, mode2, angles) {
  const headings = getMode(mode2).template.split("\n").map((l) => /^##\s+(.+?)\s*$/.exec(l.trim())?.[1]?.trim()).filter((h) => !!h && !/^(tl;?dr|abstract|executive summary|sources|references)/i.test(h)).slice(0, 2);
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
  const mode2 = getMode(options.mode);
  const backends = options.backends?.length ? options.backends : PROBE_BACKENDS;
  const ctx = { question: options.question, mode: mode2, options: { ...options, perSource: 5 }, variants: [options.question] };
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
  writeArtifact(join23(dir, "BRAINSTORM.json"), JSON.stringify(result, null, 2));
  writeArtifact(join23(dir, "BRAINSTORM.md"), renderBrainstormMd(result));
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
    ...s.fullText === false ? { fullText: false } : {},
    ...s.wall ? { wall: true } : {},
    ...s.offTopic ? { offTopic: true } : {}
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
  const mode2 = getMode(modeName);
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
    slug: `${modeName}-${slugify(question, RUN_SLUG)}`,
    tiers: ["SUMMARY.md", "REPORT.md"],
    extras: mode2.extras,
    notes: [
      `Merged ${dossiers.length} sub-dossier(s) \u2192 ${merged.length} source(s) (${deduped.dropped} near-duplicate(s) collapsed).`,
      "agent: write the report against THIS master dossier's [S#] ids; then verify + check --semantic."
    ],
    timings: {},
    mergedFrom: options.runs.slice(),
    subQuestions
  };
  const dir = options.master ?? defaultRunDir(modeName, question);
  const { sources } = writeDossier(dir, merged, manifest, mode2.template);
  return { dir, sources, manifest: { ...manifest, sourceCount: sources.length } };
}

// src/orchestrate.ts
import { join as join25 } from "path";

// src/orchestrate-templates.ts
import { join as join24 } from "path";
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
function agentContracts(runAbs, engineAbs, opts = {}) {
  const browserFlag = opts.browser ? ` --browser ${opts.browser}` : "";
  const gathererFooter = GATHERER_FOOTER.replaceAll("<RUN>", runAbs);
  const skepticFooter = ONE_WRITER_FOOTER.replaceAll("<RUN>", runAbs);
  return {
    gatherer: `# Contract: gatherer

You are gathering web evidence for ONE (or a few) sub-question(s) of a larger ultrasearch research run. Handle ONLY the sub-questions whose \`id\` (Q#) is named in your prompt (\`ITEMS=<Q#,\u2026>\`).

Worklist: \`${join24(runAbs, "PLAN.json")}\` (\`subQuestions[]\`; each entry has \`id\`, \`question\`, \`queries\`, \`out\`; the plan also carries the run's \`mode\` and \`depth\`).

**Stale-id guard:** if an ITEMS id is no longer in the worklist, or its \`Q#\` entry's question text doesn't match the sub-question you were dispatched for, STOP and report the mismatch instead of gathering \u2014 a re-plan renumbers ids, and gathering under a stale id would fill the wrong sub-dossier.

For EACH of your sub-questions:

1. **Sweep with your OWN WebSearch first \u2014 this is the primary engine, not an extra.**
   \`node ${engineAbs} queries --q "<its question>" --mode <the plan's mode> --depth <the plan's depth>\`
   names how many DISTINCT queries to run and which angles to cover. Run your WebSearch once per angle, pool EVERY hit into \`<its out dir>/websearch.json\` as \`[{"url":\u2026,"title":\u2026,"snippet":\u2026}, \u2026]\`. A fan-out multiplies whatever discovery it was given, so a sub-question gathered with no lane is where this run quietly gets worse.
2. Run (add \`--lang <code> --region <cc>\` and translate BOTH the \`--queries\` and your WebSearch queries into that language when the run targets a non-English audience):
   \`node ${engineAbs} gather --q "<its question>" --queries "<its queries, |-joined>" --mode <the plan's mode> --depth <the plan's depth; deep when the plan predates the field> --web-results "<its out dir>/websearch.json" --out "<its out dir>"${browserFlag}\`
   (The on-disk fetch cache is ON by default and shared across processes, so a URL two sub-questions both surface is fetched once. Do NOT pass \`--no-cache\` here.)
3. Open \`<its out dir>/DOSSIER.md\`. If it is flagged **thin**, or it lists **under-covered** terms, or an angle is missing, run a SECOND WebSearch round at that gap and fold the whole round in with ONE call:
   \`node ${engineAbs} ingest --run "<its out dir>" --web-results "<round2.json>"${browserFlag}\`
   Pin URLs a reader can OPEN \u2014 landing pages, never raw API endpoints or batch/search URLs (the engine rewrites the endpoints it knows and refuses the rest). If it answers that a page "extracted to a \u2026 wall", the host is throttling you: that is a refusal, not a setback to work around \u2014 take another source, or pass the provider's text endpoint and let the engine record the page.
4. Do NOT write any report tier.

Return (structured output): \`{ "gathered": [{ "id", "out", "coverage", "newSubQuestions" }] }\` \u2014 for each of your ITEMS: its \`out\` dir, a one-line coverage note, and any NEW sub-questions you discovered (an empty array for none).
${gathererFooter}`,
    skeptic: `# Contract: skeptic

You are an adversarial skeptic verifying the claims of an ultrasearch report against their cited sources. Try to REFUTE each claim: assume it is wrong until the source proves it.

Worklist: \`${join24(runAbs, "VERIFY.todo.json")}\` (an object with \`pairs[]\`; each entry has \`claimId\`, \`sourceId\`, \`claim\`, \`extractPath\`, \`extractDigest\`, and sometimes \`numeralsAbsent\`). Handle ONLY the pairs whose \`claimId:sourceId\` key is named in your prompt (\`ITEMS=<C#:S#,\u2026>\`).

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
function runbookPreamble(phases, runAbs, engineAbs) {
  const cell3 = (s) => s.replace(/\r?\n/g, " ").replaceAll("|", "\\|");
  const status = phases.map((p) => `| ${p.name} | \`${cell3(p.worklist)}\` | ${p.ready ? `ready (${p.items} item(s))` : "not ready"} | \`${cell3(p.prerequisite)}\` |`).join("\n");
  const engine = `node ${shq(engineAbs)}`;
  const gather = phases.find((p) => p.name === "gather");
  const gatherPlan = gather?.parsed;
  const outs = gatherPlan ? shq(gatherPlan.subQuestions.map((s) => s.out ?? join24(runAbs, s.id.toLowerCase())).join(",")) : '"<the out dirs, comma-joined>"';
  const q = gatherPlan ? shq(gatherPlan.question) : '"<question>"';
  const mode2 = gatherPlan ? gatherPlan.mode : "<m>";
  const run = shq(runAbs);
  return [
    `Engine: \`${engine}\`

Generated by \`ultrasearch orchestrate\` from the CURRENT run state. This sequential path is
correctness-identical to the multi-agent workflows \u2014 same worklists, same contracts, same
fail-closed gates; only wall-clock differs.
Parallel subagents are an optimization, never a requirement.

## Phase status

| Phase | Worklist | Status | Produce it with |
|---|---|---|---|
${status}

## The loop (play every role yourself, one item at a time)

1. **Plan** (if not done): \`${engine} plan --q "<question>" --mode <m> --run-root ${run}\` \u2192 \`${join24(runAbs, "PLAN.json")}\` (standard tier: keep it small with \`--max-subquestions 3\` and pass \`--depth standard\`; deep tier: add \`--depth deep\`; without \`--depth\` the fan-out gathers deep).
2. **Gather per sub-question** \u2014 for EVERY entry in \`${join24(runAbs, "PLAN.json")}\`, apply \`${join24(runAbs, "orchestration", "agents", "gatherer.md")}\` yourself: sweep with your own WebSearch into \`<its out dir>/websearch.json\`, run its \`gather --q \u2026 --queries \u2026 --web-results \u2026 --out <its out dir>\`, then top up a thin or under-covered sub-dossier with a second round (\`ingest --run <its out dir> --web-results <round2.json>\`).
3. **Merge** \u2014 \`${engine} merge --runs ${outs} --master ${run} --q ${q} --mode ${mode2}\`. Cite only the MASTER \`[S#]\` ids from here.
4. **Write the tiers** \u2014 SUMMARY.md + REPORT.md in \`${runAbs}\`, every claim cited \`[S#]\`, your own knowledge flagged \`[M]\`.
5. **Verify the claims** \u2014 \`${engine} verify --run ${run}\` writes \`${join24(runAbs, "VERIFY.todo.json")}\`. For EVERY pair, apply \`${join24(runAbs, "orchestration", "agents", "skeptic.md")}\` yourself (open the cited extract, verdict supported/partial/unsupported/refuted + note). Save your verdicts as \`${join24(runAbs, "verdicts.json")}\`, then fold: \`${engine} verify --apply ${run} --run ${run}\`.
6. **Gate** \u2014 \`${engine} render --run ${run}\` and \`${engine} check --run ${run} --semantic\` must pass before presenting (deep tier: add \`--require-verify\`).
7. **Loop until dry** \u2014 NEW sub-questions from step 2 \u2192 fan out again, \`merge\` into the SAME master, re-verify. Before re-folding, delete or archive the previous round's \`verdicts*.json\`: re-running \`verify\` renumbers claim ids, and the \`--apply\` directory glob refolds every \`verdicts*.json\` (a stale round-1 file corrupts the gate last-wins). Stop when a round surfaces nothing new.

With subagents available, prefer the emitted workflows instead: \`orchestrate --run ${run} --phase <p>\` then \`Workflow({ scriptPath: "${join24(runAbs, "orchestration", "<p>.workflow.mjs")}" })\` \u2014 you stay the sole writer either way.
`
  ];
}

// src/orchestrate.ts
var PHASES = ["gather", "verify"];
function mergeHint(runAbs, engineAbs, plan) {
  const outs = plan ? plan.subQuestions.map((s) => s.out ?? join25(runAbs, s.id.toLowerCase())) : [`${join25(runAbs, "q1")},\u2026`];
  const q = plan ? plan.question : "<question>";
  const mode2 = plan ? plan.mode : "<mode>";
  return [
    `node ${shq(engineAbs)} merge --runs ${shq(outs.join(","))} --master ${shq(runAbs)} --q ${shq(q)} --mode ${mode2}`,
    `then write SUMMARY.md/REPORT.md against the MASTER [S#] ids, and feed any NEW sub-questions into the next round.`
  ];
}
var GATHER = {
  name: "gather",
  worklist: "PLAN.json",
  ids: (plan) => Array.isArray(plan?.subQuestions) ? plan.subQuestions.map((s) => s.id) : void 0,
  // Carry the persisted depth when there is one, so re-running the prerequisite
  // regenerates the SAME plan instead of silently dropping the field.
  prerequisite: (run, engineAbs, plan) => plan ? `node ${shq(engineAbs)} plan --q ${shq(plan.question)} --mode ${plan.mode}${plan.depth ? ` --depth ${plan.depth}` : ""} --run-root ${shq(run)}` : `node ${shq(engineAbs)} plan --q "<question>" --mode <m> --run-root ${shq(run)}`,
  role: "gatherer",
  title: "Gather",
  schema: GATHER_SCHEMA,
  batchSize: 1,
  // Heavy units — a full sub-question gather each — so fan out at any count ≥ 2
  // and collapse only a single-item worklist.
  collapseFloor: () => 1,
  description: (n) => `Gather web evidence for the ${n} sub-question(s) of an ultrasearch run (one gatherer per sub-question; the dossier union stays with the orchestrator)`,
  applyHint: (run, engineAbs, phase) => mergeHint(run, engineAbs, phase.parsed)
};
var VERIFY = {
  name: "verify",
  worklist: "VERIFY.todo.json",
  ids: (todo) => Array.isArray(todo?.pairs) ? todo.pairs.map((p) => `${p.claimId}:${p.sourceId}`) : void 0,
  prerequisite: (run, engineAbs) => `node ${shq(engineAbs)} verify --run ${shq(run)}`,
  role: "skeptic",
  title: "Verify",
  schema: VERIFY_SCHEMA,
  batchSize: 8,
  // Cheap per-pair judgments: a worklist at or under the shared floor does not
  // amortize a fan-out.
  collapseFloor: (small) => small,
  description: (n) => `Adversarially verify the ${n} claim\u2194source pair(s) of an ultrasearch report (skeptic fan-out, fail-closed fold)`,
  applyHint: (run, engineAbs) => [
    `round 2+: delete or archive the previous round's verdicts*.json FIRST \u2014 re-running verify renumbers claim ids,`,
    `and the directory fold below picks up EVERY verdicts*.json (a stale fragment corrupts the fold last-wins). Then:`,
    `save each returned fragment as ${join25(run, "verdicts.<i>.json")} then reassemble + gate:`,
    `node ${shq(engineAbs)} verify --apply ${shq(run)} --run ${shq(run)}   # a dir picks up every verdicts*.json`
  ]
};
var PHASE_DEFS = [GATHER, VERIFY];
function emitOrchestration(runDir, engineAbs, { browser, ...opts } = {}) {
  const contracts = (runAbs, engine) => agentContracts(runAbs, engine, { browser });
  return orchestrateRun(runDir, engineAbs, PHASE_DEFS, contracts, {
    ...opts,
    runbookPreamble: runbookPreamble(listPhasesFor(runDir, engineAbs), runDir, engineAbs)
  });
}
function listPhasesFor(runDir, engineAbs) {
  return listPhases(runDir, engineAbs, PHASE_DEFS);
}

// src/mcp/handlers.ts
import { existsSync as existsSync18, readFileSync as readFileSync19, realpathSync as realpathSync3, statSync as statSync10 } from "fs";
import { isAbsolute as isAbsolute3, join as join27, relative as relative2, resolve as resolve4, sep as sep3 } from "path";

// src/refcheck/index.ts
import { existsSync as existsSync17, readFileSync as readFileSync18 } from "fs";
import { basename as basename3, extname, join as join26, resolve as resolve3 } from "path";
import { tmpdir as tmpdir4 } from "os";

// src/refcheck/parse.ts
var REF_HEADING = /^\s{0,3}(?:#{1,6}\s*)?(?:\d+[.)]?\s+)?(r[ée]f[ée]rences(?:\s+bibliographiques)?|bibliograph(?:y|ie)|references|works cited|literature cited|literatur(?:verzeichnis)?|referencias|bibliografia)\s*:?\s*$/i;
var HEADING = /^\s{0,3}#{1,6}\s+\S/;
var NUMBERED = new RegExp("^\\s*(?:\\[(\\d{1,4})\\]|(\\d{1,4})[.)]|(\\d{1,4})(?=\\s+\\p{Lu}))\\s*(.*)$", "u");
function referenceHeadingLine(lines) {
  let at = -1;
  for (let i = 0; i < lines.length; i++) if (REF_HEADING.test(lines[i].trim())) at = i;
  return at;
}
function splitDocument(text) {
  const lines = text.replace(/\r\n?/g, "\n").split("\n");
  const at = referenceHeadingLine(lines);
  if (at < 0) return { body: "", list: text, hadHeading: false };
  let end = lines.length;
  for (let i = at + 1; i < lines.length; i++) {
    if (HEADING.test(lines[i]) && !NUMBERED.test(lines[i].replace(/^\s*#+\s*/, ""))) {
      end = i;
      break;
    }
  }
  return { body: [...lines.slice(0, at), ...lines.slice(end)].join("\n"), list: lines.slice(at + 1, end).join("\n"), hadHeading: true };
}
function splitEntries(list) {
  const lines = list.replace(/\r\n?/g, "\n").split("\n");
  const numbered = lines.filter((l) => NUMBERED.test(l) && l.trim().length > 12).length;
  const out = [];
  if (numbered >= 2) {
    for (const line of lines) {
      const t = line.trim();
      if (!t || HEADING.test(line)) continue;
      const m = NUMBERED.exec(t);
      if (m && (m[4] ?? "").length > 8) out.push({ n: Number(m[1] ?? m[2] ?? m[3]), raw: m[4].trim() });
      else if (out.length) out[out.length - 1].raw += ` ${t}`;
    }
    return out;
  }
  const paras = list.replace(/\r\n?/g, "\n").split(new RegExp("\\n\\s*\\n|\\n(?=\\s*\\p{Lu}[\\p{L}'\u2019 -]+ \\p{Lu}{1,4}[,.])", "u")).map((p) => p.replace(/\s+/g, " ").trim()).filter((p) => p.length > 12 && !HEADING.test(p));
  return paras.map((raw, i) => ({ n: i + 1, raw: raw.replace(/^[-*•]\s+/, "") }));
}
var DOI_RE2 = /(?:\bdoi:?\s*|https?:\/\/(?:dx\.)?doi\.org\/)(10\.\d{4,9}\/[^\s"<>]+)|\b(10\.\d{4,9}\/[^\s"<>]+)/i;
var DATE_VOL = /[.?!]\s*((?:19|20)\d{2})(?:\s+[A-Z][a-z]{2}(?:[-–\s]+[A-Z]?[a-z]{0,2})?(?:\s+\d{1,2})?)?\s*;\s*([^():;.\s][^():;.]*?)?\s*(?:\(([^)]*)\))?\s*(?::\s*([A-Za-z]?\d+[A-Za-z]?(?:\s*[-–]\s*[A-Za-z]?\d+[A-Za-z]?)?))?\s*(?:\.|$)/;
var DATE_ONLY = /[.?!]\s*((?:19|20)\d{2})(?:\s+[A-Z][a-z]{2}(?:\s+\d{1,2})?)?\s*\.(?:\s|$)/;
var AUTHOR_TOKEN = new RegExp("^(?:(?:\\p{Ll}{1,4}\\s+)*\\p{Lu}[\\p{L}'\u2019-]*(?:\\s+(?:\\p{Ll}{1,4}\\s+)*\\p{L}[\\p{L}'\u2019-]*)*\\s+\\p{Lu}{1,4}(?:\\s+(?:Jr|Sr|II|III|IV))?|et\\s+al)$", "u");
function trimDoi(doi) {
  return doi.replace(/[.,;:)\]]+$/, "");
}
function parseAuthorList(s) {
  const tokens = s.split(/\s*,\s*/).map((t) => t.trim().replace(/\.$/, "")).filter(Boolean);
  if (!tokens.length || !tokens.every((t) => AUTHOR_TOKEN.test(t))) return void 0;
  const etAl = tokens.some((t) => /^et\s+al$/i.test(t));
  return { authors: tokens.filter((t) => !/^et\s+al$/i.test(t)), etAl };
}
function parseVancouver(raw, n) {
  const ref = { n, raw, authors: [], etAl: false };
  let work = ` ${raw.replace(/\s+/g, " ").trim()}`;
  const doi = DOI_RE2.exec(work);
  if (doi) {
    ref.doi = trimDoi(doi[1] ?? doi[2]);
    work = work.slice(0, doi.index) + work.slice(doi.index + doi[0].length);
  }
  const pmid = /\bPMID:?\s*(\d{4,9})/i.exec(work);
  if (pmid) {
    ref.pmid = pmid[1];
    work = work.replace(pmid[0], " ");
  }
  const pmcid = /\bPMCID:?\s*(PMC\d+)|\b(PMC\d{4,})\b/i.exec(work);
  if (pmcid) {
    ref.pmcid = (pmcid[1] ?? pmcid[2]).toUpperCase();
    work = work.replace(pmcid[0], " ");
  }
  work = work.replace(/\s+(?:Epub|Published)\b[^.]*\.?/gi, " ").replace(/\s+/g, " ");
  let rest = work.trim();
  for (const m of rest.matchAll(/\.\s+/g)) {
    const parsed = parseAuthorList(rest.slice(0, m.index));
    if (parsed) {
      ref.authors = parsed.authors;
      ref.etAl = parsed.etAl;
      rest = rest.slice(m.index + m[0].length);
    }
    break;
  }
  const dv = DATE_VOL.exec(rest) ?? DATE_ONLY.exec(rest);
  let head = rest;
  if (dv) {
    head = rest.slice(0, dv.index + 1);
    ref.year = dv[1];
    if (dv[2]?.trim()) ref.volume = dv[2].trim();
    if (dv[3]?.trim()) ref.issue = dv[3].trim();
    if (dv[4]?.trim()) ref.pages = dv[4].replace(/\s+/g, "").replace(/–/g, "-");
  }
  head = head.trim().replace(/[.]$/, "");
  const breaks = [...head.matchAll(/[.?!]\s+/g)];
  const last = breaks.at(-1);
  if (dv && last) {
    ref.title = head.slice(0, last.index + (last[0].startsWith(".") ? 0 : 1)).trim();
    ref.journal = head.slice(last.index + last[0].length).trim() || void 0;
  } else if (head) {
    ref.title = head;
  }
  if (ref.title === "") delete ref.title;
  return ref;
}
function bibValue(s, i) {
  while (s[i] === " " || s[i] === "	" || s[i] === "\n" || s[i] === "\r") i++;
  if (s[i] === "{") {
    let depth = 0;
    let j = i;
    for (; j < s.length; j++) {
      if (s[j] === "{") depth++;
      else if (s[j] === "}" && --depth === 0) break;
    }
    return { value: s.slice(i + 1, j), end: j + 1 };
  }
  if (s[i] === '"') {
    let j = i + 1;
    let depth = 0;
    for (; j < s.length; j++) {
      if (s[j] === "{") depth++;
      else if (s[j] === "}") depth--;
      else if (s[j] === '"' && depth === 0) break;
    }
    return { value: s.slice(i + 1, j), end: j + 1 };
  }
  const m = /^[^,}\s]+/.exec(s.slice(i));
  return { value: m ? m[0] : "", end: i + (m ? m[0].length : 0) };
}
var unbrace = (s) => s.replace(/\\&/g, "&").replace(/[{}]/g, "").replace(/\s+/g, " ").trim();
function vancouverName(name) {
  const n = unbrace(name);
  let family;
  let given;
  if (n.includes(",")) [family, given] = [n.slice(0, n.indexOf(",")).trim(), n.slice(n.indexOf(",") + 1).trim()];
  else {
    const parts = n.split(/\s+/);
    family = parts.pop() ?? n;
    given = parts.join(" ");
  }
  const initials = given.split(/[\s.-]+/).filter(Boolean).map((p) => p[0].toUpperCase()).join("");
  return initials ? `${family} ${initials}` : family;
}
function parseBibtex(text) {
  const out = [];
  const re = /@(\w+)\s*\{\s*([^,\s]*)\s*,/g;
  let m;
  while (m = re.exec(text)) {
    if (/^(comment|preamble|string)$/i.test(m[1])) continue;
    const fields = {};
    let i = re.lastIndex;
    for (; ; ) {
      const f = /^\s*([A-Za-z][\w-]*)\s*=\s*/.exec(text.slice(i));
      if (!f) break;
      const v = bibValue(text, i + f[0].length);
      fields[f[1].toLowerCase()] = v.value;
      i = v.end;
      const sep4 = /^\s*,?/.exec(text.slice(i));
      i += sep4 ? sep4[0].length : 0;
      if (text[i] === "}") break;
    }
    re.lastIndex = i;
    const names = fields.author ? unbrace(fields.author).split(/\s+and\s+/i) : [];
    const etAl = names.some((x) => /^others$/i.test(x.trim()));
    const authors = names.filter((x) => !/^others$/i.test(x.trim())).map(vancouverName);
    const n = out.length + 1;
    const ref = {
      n,
      key: m[2] || void 0,
      raw: [authors.join(", ") + (etAl ? ", et al" : ""), unbrace(fields.title ?? ""), unbrace(fields.journal ?? fields.booktitle ?? ""), fields.year].filter(Boolean).join(". "),
      authors,
      etAl
    };
    if (fields.title) ref.title = unbrace(fields.title);
    if (fields.journal || fields.booktitle) ref.journal = unbrace(fields.journal ?? fields.booktitle);
    if (fields.year) ref.year = unbrace(fields.year);
    if (fields.volume) ref.volume = unbrace(fields.volume);
    if (fields.number || fields.issue) ref.issue = unbrace(fields.number ?? fields.issue);
    if (fields.pages) ref.pages = unbrace(fields.pages).replace(/-{2,}|–/g, "-");
    if (fields.doi) ref.doi = trimDoi(unbrace(fields.doi).replace(/^https?:\/\/(dx\.)?doi\.org\//i, ""));
    if (fields.pmid) ref.pmid = unbrace(fields.pmid);
    out.push(ref);
  }
  return out;
}
function parseReferences(text) {
  if (/@\w+\s*\{[^,\s]*\s*,/.test(text) && /\b(title|author)\s*=/.test(text)) return parseBibtex(text);
  return splitEntries(splitDocument(text).list).map((e) => parseVancouver(e.raw, e.n));
}

// src/refcheck/citing.ts
var SUP = { "\u2070": "0", "\xB9": "1", "\xB2": "2", "\xB3": "3", "\u2074": "4", "\u2075": "5", "\u2076": "6", "\u2077": "7", "\u2078": "8", "\u2079": "9", "\u207B": "-", "\u02D2": "," };
var LIST = String.raw`\d{1,4}(?:\s*[-–—]\s*\d{1,4})?(?:\s*[,;]\s*\d{1,4}(?:\s*[-–—]\s*\d{1,4})?)*`;
var BRACKET = new RegExp(String.raw`\[\s*(${LIST})\s*\]`, "g");
var PAREN = new RegExp(String.raw`\(\s*(${LIST})\s*\)`, "g");
var SUPERSCRIPT = /<sup>\s*([\d,\s–—-]+)\s*<\/sup>|\^([\d,–—-]+)\^|([⁰¹²³⁴⁵⁶⁷⁸⁹][⁰¹²³⁴⁵⁶⁷⁸⁹⁻˒,]*)/g;
function expandCallList(list) {
  const out = [];
  for (const part of list.split(/[,;]/)) {
    const m = /^\s*(\d+)\s*(?:[-–—]\s*(\d+))?\s*$/.exec(part);
    if (!m) return [];
    const a = Number(m[1]);
    const b = m[2] !== void 0 ? Number(m[2]) : a;
    if (b < a || b - a > 50) return [];
    for (let i = a; i <= b; i++) out.push(i);
  }
  return [...new Set(out)];
}
function findCalls(paragraph2, style, refCount) {
  const out = [];
  if (style === "brackets") {
    for (const m of paragraph2.matchAll(BRACKET)) {
      const numbers = expandCallList(m[1]);
      if (numbers.length) out.push({ index: m.index, length: m[0].length, token: m[0], numbers });
    }
  } else if (style === "parentheses") {
    for (const m of paragraph2.matchAll(PAREN)) {
      const numbers = expandCallList(m[1]);
      if (!numbers.length || numbers.some((x) => x < 1 || x > refCount)) continue;
      if (/^\s*(?:%|‰|mm|cm|ans|years?|yeux|eyes|patients?)/i.test(paragraph2.slice(m.index + m[0].length))) continue;
      out.push({ index: m.index, length: m[0].length, token: m[0], numbers });
    }
  }
  for (const m of paragraph2.matchAll(SUPERSCRIPT)) {
    if (m[3] && /(?:\d|\b(?:m|cm|mm|km|kg|µm|nm|ml|mL))\s*$/.test(paragraph2.slice(0, m.index))) continue;
    const body = m[1] ?? m[2] ?? [...m[3]].map((c) => SUP[c] ?? c).join("");
    const numbers = expandCallList(body);
    if (numbers.length && numbers.every((x) => x >= 1 && x <= Math.max(refCount, 1))) out.push({ index: m.index, length: m[0].length, token: m[0], numbers });
  }
  return out.sort((a, b) => a.index - b.index);
}
function detectStyle(text, refCount) {
  if (new RegExp(BRACKET.source).test(text)) return "brackets";
  if (findCalls(text, "none", refCount).length) return "superscript";
  let paren = 0;
  for (const m of text.matchAll(PAREN)) if (expandCallList(m[1]).every((x) => x >= 1 && x <= refCount)) paren++;
  return paren >= 2 ? "parentheses" : "none";
}
var SENTENCE_BREAK = /(?<=[.!?](?:\[[\d\s,;–—-]+\]|[⁰¹²³⁴⁵⁶⁷⁸⁹⁻˒,]+)?)\s+(?=[\p{Lu}\d«"“([])/u;
function hasWords(s) {
  return new RegExp("\\p{L}{3,}", "u").test(s);
}
function analyseCiting(text, refNumbers) {
  const known = new Set(refNumbers);
  const refCount = refNumbers.length ? Math.max(...refNumbers) : 0;
  const style = detectStyle(text, refCount);
  const calls = [];
  const paragraphs = text.replace(/\r\n?/g, "\n").split(/\n/).map((p) => p.trim());
  paragraphs.forEach((para, pi) => {
    if (!para) return;
    const sentences = para.split(SENTENCE_BREAK);
    let previous = "";
    for (const sentence of sentences) {
      const found = findCalls(sentence, style, refCount);
      let from = 0;
      found.forEach((c, k) => {
        let claim = sentence.slice(from, c.index);
        if (k === found.length - 1) claim += ` ${sentence.slice(c.index + c.length)}`;
        claim = claim.replace(/^[\s,;:.]+|[\s,;:]+$/g, "");
        if (!hasWords(claim) && !extractNumerals(claim).length) claim = previous;
        const bare = claim.replace(BRACKET, " ").replace(SUPERSCRIPT, " ");
        calls.push({ numbers: c.numbers, token: c.token, sentence: sentence.trim(), claim: claim.trim(), numerals: extractNumerals(bare, 12), paragraph: pi });
        from = c.index + c.length;
      });
      if (hasWords(sentence.replace(BRACKET, " "))) previous = sentence.replace(BRACKET, " ").replace(/\s+/g, " ").trim();
    }
  });
  const firstCitationOrder = [];
  const seen = /* @__PURE__ */ new Set();
  for (const c of calls) {
    for (const n of c.numbers) {
      if (!seen.has(n)) {
        seen.add(n);
        firstCitationOrder.push(n);
      }
    }
  }
  const outOfOrder = [];
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
    outOfOrder
  };
}
function numeralIn(numeral, text) {
  const hay = normalizeNumeralText(text);
  const esc = numeral.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`(?<![\\d.])${esc}(?![\\d]|\\.\\d)`).test(hay);
}

// src/refcheck/diff.ts
var FIELDS = ["authors", "title", "journal", "year", "volume", "issue", "pages", "doi"];
var VANCOUVER_AUTHORS = 6;
var norm2 = (s) => deaccent(s.toLowerCase()).replace(/[^\p{L}\p{N}]+/gu, " ").trim();
function titleSimilarity(a, b) {
  const ta = norm2(a).split(" ").filter(Boolean);
  const tb = norm2(b).split(" ").filter(Boolean);
  if (!ta.length || !tb.length) return 0;
  const sb = new Set(tb);
  const common = ta.filter((t) => sb.has(t)).length;
  return common / Math.max(ta.length, tb.length);
}
function expandPages(p) {
  const m = /^([A-Za-z]?)(\d+)([A-Za-z]?)\s*[-–]\s*([A-Za-z]?)(\d+)([A-Za-z]?)$/.exec(p.trim());
  if (!m) return p.trim();
  const [, pre, a, , , b] = m;
  const last = b.length < a.length ? a.slice(0, a.length - b.length) + b : b;
  return `${pre}${a}-${pre}${last}`;
}
function vancouverAuthors(authors) {
  return authors.length > VANCOUVER_AUTHORS ? `${authors.slice(0, VANCOUVER_AUTHORS).join(", ")}, et al.` : authors.join(", ");
}
function splitName(a) {
  const m = new RegExp("^(.*\\S)\\s+(\\p{Lu}{1,4})$", "u").exec(a.trim());
  return m ? { family: norm2(m[1]), initials: m[2] } : { family: norm2(a), initials: "" };
}
function diffAuthors(ref, rec) {
  const expected = vancouverAuthors(rec.authors);
  if (!rec.authors.length) return { field: "authors", status: "match", note: "the record lists no individual author" };
  const cited = ref.authors.join(", ") + (ref.etAl ? ", et al." : "");
  if (!ref.authors.length) return { field: "authors", status: "missing", expected };
  const problems = [];
  ref.authors.forEach((a, i) => {
    const want = rec.authors[i];
    if (!want) {
      problems.push(`"${a}" is not an author on the record (${rec.authors.length} listed)`);
      return;
    }
    const x = splitName(a);
    const y = splitName(want);
    if (x.family !== y.family) problems.push(`author ${i + 1}: "${a}" \u2014 record has "${want}"`);
    else if (x.initials && y.initials && x.initials !== y.initials) problems.push(`author ${i + 1}: initials "${x.initials}" \u2014 record has "${y.initials}"`);
  });
  if (!ref.etAl && ref.authors.length < rec.authors.length) {
    problems.push(`${ref.authors.length} of ${rec.authors.length} authors listed and no "et al."`);
  }
  if (problems.length) return { field: "authors", status: "mismatch", cited, expected, note: problems.join("; ") };
  const style = ref.etAl && rec.authors.length > VANCOUVER_AUTHORS && ref.authors.length < VANCOUVER_AUTHORS ? `style: ${ref.authors.length} author(s) before "et al." (Vancouver lists ${VANCOUVER_AUTHORS})` : ref.etAl && rec.authors.length <= VANCOUVER_AUTHORS ? `style: "et al." although the record has only ${rec.authors.length} author(s) (Vancouver lists them all)` : void 0;
  return { field: "authors", status: "match", cited, expected, ...style ? { note: style } : {} };
}
function simple(field, cited, expected, same) {
  if (!expected) return void 0;
  if (!cited) return { field, status: "missing", expected };
  return same(cited, expected) ? { field, status: "match", cited, expected } : { field, status: "mismatch", cited, expected };
}
function diffReference(ref, rec) {
  const out = [diffAuthors(ref, rec)];
  const title = simple("title", ref.title?.replace(/[.]$/, ""), rec.title.replace(/[.]$/, ""), (a, b) => norm2(a) === norm2(b));
  if (title?.status === "mismatch") title.note = `${Math.round(titleSimilarity(title.cited, title.expected) * 100)}% of words in common`;
  const journal = simple("journal", ref.journal, rec.journal, (a, b) => norm2(a) === norm2(b) || !!rec.journalFull && norm2(a) === norm2(rec.journalFull));
  if (journal && rec.via === "crossref") journal.note = "Crossref short title \u2014 not necessarily the NLM abbreviation";
  else if (journal?.status === "mismatch") journal.note = "the NLM abbreviation is the PubMed one";
  const rest = [
    title,
    journal,
    simple("year", ref.year, rec.year, (a, b) => a.trim() === b.trim()),
    simple("volume", ref.volume, rec.volume, (a, b) => norm2(a) === norm2(b)),
    simple("issue", ref.issue, rec.issue, (a, b) => norm2(a) === norm2(b)),
    simple("pages", ref.pages, rec.pages, (a, b) => expandPages(a).toLowerCase() === expandPages(b).toLowerCase()),
    simple("doi", ref.doi, rec.doi, (a, b) => a.trim().toLowerCase() === b.trim().toLowerCase())
  ];
  for (const d of rest) if (d) out.push(d);
  return out;
}

// src/refcheck/resolve.ts
var EUTILS2 = "https://eutils.ncbi.nlm.nih.gov/entrez/eutils";
var BATCH = 100;
async function polite() {
  const ms = politeDelayMs();
  if (ms) await sleep(ms);
}
function firstPage(pages) {
  return pages ? /^[A-Za-z]?\d+[A-Za-z]?/.exec(pages)?.[0] : void 0;
}
async function ecitmatch(refs) {
  const out = /* @__PURE__ */ new Map();
  const lines = refs.filter((r) => r.journal && r.year && (r.volume || firstPage(r.pages)) && r.authors.length).map((r) => [r.journal, r.year, r.volume ?? "", firstPage(r.pages) ?? "", r.authors[0], String(r.n), ""].join("|"));
  for (let i = 0; i < lines.length; i += 50) {
    const bdata = lines.slice(i, i + 50).join("\r");
    const r = await apiGet(`${EUTILS2}/ecitmatch.cgi?db=pubmed&retmode=xml&tool=ultrasearch&bdata=${encodeURIComponent(bdata)}`, {
      json: false,
      accept: "text/plain"
    });
    if (!r.ok || typeof r.data !== "string") continue;
    for (const line of r.data.split(/\r?\n/)) {
      const cols = line.split("|");
      const key = Number(cols[5]);
      const pmid = cols[6]?.trim();
      if (key && pmid && /^\d+$/.test(pmid)) out.set(key, pmid);
    }
    await polite();
  }
  return out;
}
async function esearch(term) {
  const r = await apiGet(`${EUTILS2}/esearch.fcgi?db=pubmed&retmode=json&retmax=3&tool=ultrasearch&term=${encodeURIComponent(term)}`);
  await polite();
  return r.ok && Array.isArray(r.data?.esearchresult?.idlist) ? r.data.esearchresult.idlist : [];
}
async function esummary(pmids) {
  const out = /* @__PURE__ */ new Map();
  for (let i = 0; i < pmids.length; i += BATCH) {
    const ids = pmids.slice(i, i + BATCH);
    const r = await apiGet(`${EUTILS2}/esummary.fcgi?db=pubmed&retmode=json&tool=ultrasearch&id=${ids.join(",")}`);
    await polite();
    const result = r.ok ? r.data?.result : void 0;
    if (!result) continue;
    for (const id of ids) {
      const d = result[id];
      if (!d || d.error) continue;
      const articleIds = Array.isArray(d.articleids) ? d.articleids : [];
      const doi = articleIds.find((a) => a?.idtype === "doi")?.value;
      const pmcid = articleIds.find((a) => a?.idtype === "pmc")?.value;
      const authors = (Array.isArray(d.authors) ? d.authors : []).filter((a) => !a?.authtype || a.authtype === "Author").map((a) => String(a?.name ?? "")).filter(Boolean);
      out.set(id, {
        via: "pubmed",
        how: "pmid",
        pmid: id,
        ...pmcid ? { pmcid } : {},
        ...doi ? { doi } : {},
        authors,
        title: cleanInline(String(d.title ?? "")).replace(/\.$/, ""),
        journal: d.source ? String(d.source) : void 0,
        journalFull: d.fulljournalname ? String(d.fulljournalname) : void 0,
        year: /\d{4}/.exec(String(d.pubdate ?? d.epubdate ?? ""))?.[0],
        volume: d.volume ? String(d.volume) : void 0,
        issue: d.issue ? String(d.issue) : void 0,
        pages: d.pages ? String(d.pages) : void 0,
        url: `https://pubmed.ncbi.nlm.nih.gov/${id}/`
      });
    }
  }
  return out;
}
async function efetchAbstracts(pmids) {
  const out = /* @__PURE__ */ new Map();
  for (let i = 0; i < pmids.length; i += BATCH) {
    const ids = pmids.slice(i, i + BATCH);
    const r = await apiGet(`${EUTILS2}/efetch.fcgi?db=pubmed&retmode=xml&rettype=abstract&tool=ultrasearch&id=${ids.join(",")}`, {
      json: false,
      accept: "application/xml"
    });
    await polite();
    if (!r.ok || typeof r.data !== "string") continue;
    for (const art of r.data.split(/<PubmedArticle>/).slice(1)) {
      const pmid = /<PMID[^>]*>(\d+)<\/PMID>/.exec(art)?.[1];
      if (!pmid) continue;
      const parts = [];
      for (const m of art.matchAll(/<AbstractText([^>]*)>([\s\S]*?)<\/AbstractText>/g)) {
        const label = /Label="([^"]+)"/.exec(m[1])?.[1];
        const body = decodeEntities(m[2].replace(/<[^>]+>/g, "")).replace(/\s+/g, " ").trim();
        if (body) parts.push(label ? `${label}: ${body}` : body);
      }
      if (parts.length) out.set(pmid, parts.join("\n\n"));
    }
  }
  return out;
}
function crossrefRecord(w, how) {
  if (!w?.DOI) return void 0;
  const parts = w.issued?.["date-parts"]?.[0] ?? w["published-print"]?.["date-parts"]?.[0] ?? w["published-online"]?.["date-parts"]?.[0];
  const authors = (Array.isArray(w.author) ? w.author : []).map((a) => a.family ? vancouverName(`${a.family}, ${a.given ?? ""}`) : String(a.name ?? "")).filter(Boolean);
  const first = (v) => Array.isArray(v) ? v[0] : v;
  return {
    via: "crossref",
    how,
    doi: String(w.DOI),
    authors,
    title: cleanInline(String(first(w.title) ?? "")),
    journal: first(w["short-container-title"]) ?? first(w["container-title"]),
    journalFull: first(w["container-title"]),
    year: parts?.[0] ? String(parts[0]) : void 0,
    volume: w.volume ? String(w.volume) : void 0,
    issue: w.issue ? String(w.issue) : void 0,
    pages: w.page ? String(w.page) : w["article-number"] ? String(w["article-number"]) : void 0,
    ...w.abstract ? {
      abstract: decodeEntities(String(w.abstract).replace(/<[^>]+>/g, " ")).replace(/\s+/g, " ").trim()
    } : {},
    url: `https://doi.org/${w.DOI}`
  };
}
async function crossrefByDoi(doi) {
  const r = await apiGet(`https://api.crossref.org/works/${encodeURIComponent(doi)}`, { userAgent: contactUa() });
  await polite();
  return r.ok ? crossrefRecord(r.data?.message, "doi") : void 0;
}
async function crossrefBibliographic(ref) {
  const r = await apiGet(`https://api.crossref.org/works?rows=2&query.bibliographic=${encodeURIComponent(ref.raw)}`, { userAgent: contactUa() });
  await polite();
  const items = r.ok && Array.isArray(r.data?.message?.items) ? r.data.message.items : [];
  for (const w of items) {
    const rec = crossrefRecord(w, "bibliographic");
    if (rec && ref.title && titleSimilarity(ref.title, rec.title) >= 0.85) return rec;
  }
  return void 0;
}
async function checkDoi(doi) {
  const r = await apiGet(`https://doi.org/api/handles/${encodeURIComponent(doi)}`);
  await polite();
  const code = r.data?.responseCode;
  if (code === 1) {
    const url = (Array.isArray(r.data.values) ? r.data.values : []).find((v) => v?.type === "URL")?.data?.value;
    return { doi, resolves: true, ...url ? { target: String(url) } : {} };
  }
  if (code === 100 || r.status === 404) return { doi, resolves: false };
  return { doi, resolves: void 0 };
}
async function resolveReferences(refs) {
  const notes = [];
  const pmidOf = /* @__PURE__ */ new Map();
  for (const r of refs) if (r.pmid) pmidOf.set(r.n, { pmid: r.pmid, how: "pmid" });
  const matched = await ecitmatch(refs.filter((r) => !pmidOf.has(r.n)));
  for (const [n, pmid] of matched) pmidOf.set(n, { pmid, how: "ecitmatch" });
  for (const r of refs) {
    if (pmidOf.has(r.n)) continue;
    if (r.doi) {
      const ids = await esearch(`${r.doi}[aid]`);
      if (ids.length === 1) {
        pmidOf.set(r.n, { pmid: ids[0], how: "doi" });
        continue;
      }
    }
    if (r.title) {
      const t = r.title.replace(/[^\p{L}\p{N}\s-]/gu, " ").replace(/\s+/g, " ").trim();
      const ids = await esearch(`${t}[ti]${r.year ? ` AND ${r.year}[dp]` : ""}`);
      if (ids.length >= 1 && ids.length <= 3) pmidOf.set(r.n, { pmid: ids[0], how: "title" });
    }
  }
  const pmids = [...new Set([...pmidOf.values()].map((v) => v.pmid))];
  const summaries = pmids.length ? await esummary(pmids) : /* @__PURE__ */ new Map();
  const abstracts = pmids.length ? await efetchAbstracts(pmids) : /* @__PURE__ */ new Map();
  const records = /* @__PURE__ */ new Map();
  for (const r of refs) {
    const hit = pmidOf.get(r.n);
    const rec = hit ? summaries.get(hit.pmid) : void 0;
    if (rec && (hit.how !== "title" || !r.title || titleSimilarity(r.title, rec.title) >= 0.8)) {
      const abs = abstracts.get(rec.pmid);
      records.set(r.n, { ...rec, how: hit.how, ...abs ? { abstract: abs } : {} });
      continue;
    }
    const viaCrossref = (r.doi ? await crossrefByDoi(r.doi) : void 0) ?? (r.title ? await crossrefBibliographic(r) : void 0);
    if (viaCrossref) records.set(r.n, viaCrossref);
  }
  if (summaries.size < pmids.length) notes.push(`PubMed returned no summary for ${pmids.length - summaries.size} PMID(s).`);
  const doiChecks = /* @__PURE__ */ new Map();
  for (const r of refs) {
    if (!r.doi || doiChecks.has(r.doi.toLowerCase())) continue;
    doiChecks.set(r.doi.toLowerCase(), await checkDoi(r.doi));
  }
  return { records, doiChecks, notes };
}

// src/refcheck/index.ts
var TEXT_EXT = /\.(txt|md|markdown|bib|bibtex|text|ris)$/i;
async function readDocumentText(path) {
  const abs = resolve3(path);
  if (!existsSync17(abs)) throw new Error(`file not found: ${abs}`);
  const bytes = readFileSync18(abs);
  const ext = extname(abs).toLowerCase();
  if (TEXT_EXT.test(ext) || !ext) return bytes.toString("utf8");
  if (ext === ".pdf") {
    const got = await extractPdf(bytes, {});
    if (!got.text) throw new Error(`could not extract text from ${basename3(abs)}${got.reason ? ` \u2014 ${got.reason}` : ""}`);
    return got.text;
  }
  const text = officeToText(bytes);
  if (!text) throw new Error(`could not read ${basename3(abs)} as an office document (.docx, .odt, .pptx, .xlsx)`);
  return text;
}
function recordText(ref, rec) {
  const where = [rec.journal, [rec.year, rec.volume ? `;${rec.volume}` : "", rec.issue ? `(${rec.issue})` : "", rec.pages ? `:${rec.pages}` : ""].join("")].filter(Boolean).join(". ");
  return [
    `# ${rec.title}`,
    "",
    `${vancouverAuthors(rec.authors)}. ${where}.`,
    [rec.pmid ? `PMID: ${rec.pmid}` : "", rec.pmcid ? `PMCID: ${rec.pmcid}` : "", rec.doi ? `DOI: ${rec.doi}` : ""].filter(Boolean).join(" \xB7 "),
    `Cited as reference [${ref.n}] \u2014 resolved via ${rec.via === "pubmed" ? "PubMed" : "Crossref"} (${rec.how}).`,
    "",
    "## Abstract",
    "",
    rec.abstract || "(no abstract on record)"
  ].join("\n");
}
function summarise(entries, citing) {
  const fields = entries.flatMap((e) => e.fields);
  const numerals = entries.flatMap((e) => e.claims.flatMap((c) => c.numerals));
  return {
    references: entries.length,
    resolved: entries.filter((e) => e.record).length,
    viaPubmed: entries.filter((e) => e.record?.via === "pubmed").length,
    viaCrossref: entries.filter((e) => e.record?.via === "crossref").length,
    unresolved: entries.filter((e) => e.status === "unresolved").length,
    withDiscrepancies: entries.filter((e) => e.status === "discrepancies").length,
    fieldMismatches: fields.filter((f) => f.status === "mismatch").length,
    fieldsMissing: fields.filter((f) => f.status === "missing").length,
    doisCited: entries.filter((e) => e.cited.doi).length,
    doisBroken: entries.filter((e) => e.doi?.resolves === false).length,
    uncited: citing?.uncited.length ?? 0,
    unknownCalls: citing?.unknown.length ?? 0,
    outOfOrder: citing?.outOfOrder.length ?? 0,
    numeralsChecked: numerals.filter((x) => x.status !== "no-abstract").length,
    numeralsAbsent: numerals.filter((x) => x.status === "absent").length
  };
}
async function runRefcheck(opts) {
  const refsText = await readDocumentText(opts.refs);
  const refs = parseReferences(refsText);
  if (!refs.length)
    throw new Error(`no reference found in ${basename3(opts.refs)} \u2014 expected a numbered list ("1. Author A. Title. Journal. 2020;\u2026") or a .bib file`);
  const notes = [];
  let citingText;
  let citingFile;
  if (opts.citing) {
    citingFile = resolve3(opts.citing);
    const raw = await readDocumentText(opts.citing);
    citingText = splitDocument(raw).body || raw;
  } else {
    const body = splitDocument(refsText).body;
    if (new RegExp("\\p{L}{3,}", "u").test(body)) {
      citingText = body;
      citingFile = resolve3(opts.refs);
      notes.push(`Citing text: the body of ${basename3(opts.refs)}, before its reference list.`);
    }
  }
  const numbers = refs.map((r) => r.n);
  const citing = citingText ? analyseCiting(citingText, numbers) : void 0;
  if (citing && citing.style === "none") notes.push("No citation call ([n], (n) or superscript) was found in the citing text.");
  const resolved = opts.offline ? void 0 : await resolveReferences(refs);
  if (resolved) notes.push(...resolved.notes);
  else notes.push("Offline: nothing was resolved \u2014 metadata, DOIs and figures are unchecked.");
  const builtAt = (/* @__PURE__ */ new Date()).toISOString();
  const dir = resolve3(opts.out ?? join26(tmpdir4(), "ultrasearch", `refcheck-${slugify(basename3(opts.refs), RUN_SLUG)}`, runId()));
  if (existsSync17(join26(dir, "sources.json")) && !existsSync17(join26(dir, "refcheck.json"))) {
    throw new Error(`${dir} already holds a dossier that refcheck did not write \u2014 pass another --out`);
  }
  const entries = refs.map((ref) => {
    const rec = resolved?.records.get(ref.n);
    const fields = rec ? diffReference(ref, rec) : [];
    const doi = ref.doi ? resolved?.doiChecks.get(ref.doi.toLowerCase()) : void 0;
    if (doi?.resolves === false) {
      const d = fields.find((f) => f.field === "doi");
      if (d && d.status === "match") Object.assign(d, { status: "mismatch", note: "does not resolve on doi.org" });
      else if (!d) fields.push({ field: "doi", status: "mismatch", cited: ref.doi, note: "does not resolve on doi.org" });
    }
    const own = citing?.calls.filter((c) => c.numbers.includes(ref.n)) ?? [];
    const claims = own.filter((c) => c.numerals.length).map((c) => ({
      claim: c.claim,
      numerals: c.numerals.map((value) => ({
        value,
        status: !rec?.abstract ? "no-abstract" : numeralIn(value, rec.abstract) ? "found" : "absent"
      }))
    }));
    const bad = fields.some((f) => f.status !== "match");
    const status = !resolved ? "not-checked" : !rec ? "unresolved" : bad || doi?.resolves === false ? "discrepancies" : "ok";
    const { abstract, ...meta } = rec ?? {};
    return {
      n: ref.n,
      raw: ref.raw,
      cited: ref,
      status,
      ...rec ? { record: { ...meta, hasAbstract: !!abstract } } : {},
      fields,
      ...doi ? { doi } : {},
      calls: own.length,
      claims
    };
  });
  ensureDir(dir);
  if (resolved) {
    ensureDir(join26(dir, "sources"));
    const manifest = {
      version: VERSION,
      question: `Reference check \u2014 ${basename3(opts.refs)}`,
      mode: "research",
      template: "verification",
      depth: "deep",
      lang: "en",
      backends: ["pubmed", "crossref"],
      backendsUsed: [...new Set(entries.map((e) => e.record?.via).filter((v) => !!v))],
      sourceCount: 0,
      builtAt,
      slug: `refcheck-${slugify(basename3(opts.refs), RUN_SLUG)}`,
      tiers: ["SUMMARY.md", "REPORT.md"],
      extras: ["bibtex"],
      notes: [
        "Built by `refcheck`: source S<n> is reference n (unresolved references have no source, so their ids are gaps).",
        "REFCHECK.md is the generated check; write REPORT.md to the verification template, citing [S#], then `check`.",
        ...notes
      ],
      timings: {},
      cache: { enabled: false, hits: 0 }
    };
    const sources = [];
    for (const e of entries) {
      const rec = resolved.records.get(e.n);
      if (!rec) continue;
      const raw = {
        url: rec.url,
        title: rec.title || e.cited.title || `Reference ${e.n}`,
        backend: rec.via,
        score: 1,
        snippet: (rec.abstract ?? rec.title).replace(/\s+/g, " ").slice(0, 360),
        text: recordText(e.cited, rec),
        meta: {
          ...rec.doi ? { doi: rec.doi } : {},
          ...rec.pmid ? { pmid: rec.pmid } : {},
          ...rec.pmcid ? { pmcid: rec.pmcid } : {},
          authors: rec.authors,
          ...rec.year ? { year: Number(rec.year) } : {},
          ...rec.journal ? { venue: rec.journal } : {},
          reference: e.n
        }
      };
      const s = buildSource(raw, `S${e.n}`, builtAt, manifest.question);
      writeSourceExtract(dir, s, raw.text, manifest.depth, manifest.question);
      sources.push(s);
      e.sourceId = s.id;
    }
    manifest.sourceCount = sources.length;
    if (sources.length) writeDossierIndex(dir, sources, manifest, templateFor(manifest));
    else notes.push("No reference resolved: no dossier was written.");
  }
  const result = {
    version: VERSION,
    refsFile: resolve3(opts.refs),
    ...citingFile ? { citingFile } : {},
    builtAt,
    offline: !resolved,
    dir,
    summary: summarise(entries, citing),
    references: entries,
    ...citing ? { citing: { ...citing, calls: citing.calls.length } } : {},
    notes
  };
  writeArtifact(join26(dir, "refcheck.json"), JSON.stringify(result, null, 2));
  writeArtifact(join26(dir, "REFCHECK.md"), renderRefcheckMarkdown(result));
  return result;
}
var cell2 = (s) => (s ?? "").replace(/\|/g, "\\|").replace(/\s+/g, " ").trim();
var MARK = { match: "\u2713", mismatch: "\u2717", missing: "\u2205" };
function fieldMark(e, field) {
  const f = e.fields.find((x) => x.field === field);
  return f ? MARK[f.status] : "\u2014";
}
function renderRefcheckMarkdown(r) {
  const s = r.summary;
  const out = [`# Reference check \u2014 ${basename3(r.refsFile)}`, ""];
  out.push(`_Generated by ultrasearch ${r.version} on ${r.builtAt}. \u2713 match \xB7 \u2717 mismatch \xB7 \u2205 missing from the citation \xB7 \u2014 not judged._`, "");
  out.push("## Verdict", "");
  if (r.offline) {
    out.push(`- ${s.references} reference(s) parsed. **Offline run**: nothing was looked up \u2014 metadata, DOIs and figures are unchecked.`);
  } else {
    out.push(
      `- ${s.references} reference(s): ${s.resolved} resolved (${s.viaPubmed} PubMed, ${s.viaCrossref} Crossref only), ${s.unresolved} unresolved.`,
      `- ${s.withDiscrepancies} reference(s) with a discrepancy: ${s.fieldMismatches} field mismatch(es), ${s.fieldsMissing} field(s) missing from the citation.`,
      `- DOIs: ${s.doisCited} cited, ${s.doisBroken} not resolving on doi.org.`
    );
  }
  if (r.citing) {
    out.push(
      `- Citing text (${r.citing.style} calls, ${r.citing.calls} call site(s)): ${s.uncited} reference(s) never cited, ${s.unknownCalls} call(s) to a number not in the list, ${s.outOfOrder} reference(s) out of Vancouver order.`
    );
    if (!r.offline) out.push(`- Figures: ${s.numeralsChecked} checked against the cited abstract, ${s.numeralsAbsent} not found there.`);
  } else {
    out.push("- No citing text: orphans, order and figures were not checked (pass `--citing <file>`).");
  }
  out.push("");
  out.push("## Reference-by-reference table", "");
  out.push(`| # | Status | Resolved as | ${FIELDS.map((f) => f).join(" | ")} | Calls | Source |`);
  out.push(`|---|---|---|${FIELDS.map(() => "---").join("|")}|---|---|`);
  for (const e of r.references) {
    const as = e.record ? `${e.record.via === "pubmed" ? `PMID ${e.record.pmid}` : `DOI ${e.record.doi}`}` : "\u2014";
    out.push(
      `| ${e.n} | ${e.status} | ${cell2(as)} | ${FIELDS.map((f) => fieldMark(e, f)).join(" | ")} | ${e.calls} | ${e.sourceId ? `[${e.sourceId}]` : "\u2014"} |`
    );
  }
  out.push("");
  out.push("## Discrepancies", "");
  const bad = r.references.filter((e) => e.fields.some((f) => f.status !== "match") || e.fields.some((f) => f.note?.startsWith("style:")));
  if (!bad.length) out.push(r.offline ? "_Not checked (offline)._" : "_None: every resolved reference matches its record._");
  for (const e of bad) {
    out.push(`### [${e.n}] ${cell2(e.cited.title ?? e.raw).slice(0, 140)}${e.sourceId ? ` [${e.sourceId}]` : ""}`, "");
    for (const f of e.fields) {
      if (f.status === "match" && !f.note?.startsWith("style:")) continue;
      const what = f.status === "missing" ? `missing \u2014 the record has \`${cell2(f.expected)}\`` : f.status === "mismatch" ? `cited \`${cell2(f.cited)}\`${f.expected ? ` \u2014 record has \`${cell2(f.expected)}\`` : ""}` : "matches";
      out.push(`- **${f.field}**: ${what}${f.note ? ` (${f.note})` : ""}`);
    }
    out.push("");
  }
  out.push("## Claims checked against their sources", "");
  if (!r.citing) out.push("_No citing text._");
  else {
    if (r.citing.uncited.length) out.push(`- **Never cited:** ${r.citing.uncited.map((n) => `[${n}]`).join(", ")}`);
    if (r.citing.unknown.length) out.push(`- **Called but not in the list:** ${r.citing.unknown.map((n) => `[${n}]`).join(", ")}`);
    if (r.citing.outOfOrder.length) {
      out.push(`- **Out of Vancouver order** (first cited after a higher number): ${r.citing.outOfOrder.map((o) => `[${o.n}] after [${o.after}]`).join(", ")}`);
    }
    if (!r.citing.uncited.length && !r.citing.unknown.length && !r.citing.outOfOrder.length) {
      out.push("- Every reference is cited, every call has a reference, and first citations run in order.");
    }
    const rows = r.references.flatMap((e) => e.claims.flatMap((c) => c.numerals.map((nu) => ({ e, claim: c.claim, value: nu.value, status: nu.status }))));
    if (rows.length) {
      out.push("", "| Ref | Figure | In the abstract | Citing passage |", "|---|---|---|---|");
      for (const x of rows) {
        out.push(`| [${x.e.n}]${x.e.sourceId ? ` [${x.e.sourceId}]` : ""} | ${x.value} | ${x.status} | ${cell2(x.claim).slice(0, 220)} |`);
      }
      out.push(
        "",
        "_A figure absent from an abstract is a lead, not a verdict: it may come from the full text, a table, or a calculation. Open the article before calling it wrong._"
      );
    }
  }
  out.push("");
  out.push("## Not verifiable", "");
  const nv = r.references.filter((e) => e.status === "unresolved" || e.status === "not-checked" || e.record && !e.record.hasAbstract);
  if (!nv.length) out.push("_Nothing: every reference resolved, with an abstract._");
  for (const e of nv) {
    const why = e.status === "not-checked" ? "offline run" : e.status === "unresolved" ? "not found on PubMed or Crossref \u2014 check the reference by hand" : "resolved, but the record has no abstract: its figures could not be checked";
    out.push(`- [${e.n}] ${cell2(e.raw).slice(0, 160)} \u2014 ${why}`);
  }
  out.push("");
  out.push("## Open questions", "");
  out.push("- Which discrepancies are typos in the citation, and which point at the wrong article?");
  if (!r.offline && r.summary.numeralsAbsent) out.push("- Do the figures missing from the abstracts appear in the full texts?");
  if (r.summary.unresolved) out.push("- Do the unresolved references exist (books, chapters, theses and grey literature are rarely indexed)?");
  for (const n of r.notes) out.push(`- Note: ${n}`);
  out.push("");
  return out.join("\n");
}

// src/mcp/handlers.ts
var MAX_READ_LINES = 2e3;
var MAX_READ_BYTES = 8 * 1024 * 1024;
var DEFAULT_DEPTH = "standard";
function str2(v) {
  return typeof v === "string" && v.trim() !== "" ? v : void 0;
}
function num3(v) {
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
  const n = num3(v);
  if (n === void 0) return void 0;
  if (n <= 0) throw new ToolError(`\`${key}\` must be greater than 0.`);
  return n;
}
function requiredStr(args, key, hint) {
  const v = str2(args[key]);
  if (!v) throw new ToolError(`\`${key}\` is required \u2014 ${hint}`);
  return v;
}
function oneOf(value, allowed, key, fallback2) {
  if (value === void 0) return fallback2;
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
function browserArg(args) {
  const v = str2(args.browser);
  return resolveBrowserRung({ flag: v === void 0 ? void 0 : oneOf(v, ALL_BROWSER_MODES, "browser", "fallback") }).mode;
}
function requiredRun(args, defaults) {
  const run = str2(args.run) ?? defaults.defaultRun;
  if (!run) throw new ToolError("`run` is required: the dossier directory returned by ultrasearch_gather.");
  if (!isAbsolute3(run)) throw new ToolError("`run` must be an absolute path.");
  const abs = resolve4(run);
  if (!existsSync18(join27(abs, "manifest.json"))) {
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
  const out = str2(args.out);
  if (out !== void 0 && !isAbsolute3(out)) throw new ToolError("`out` must be an absolute path.");
  const depth = oneOf(str2(args.depth), ALL_DEPTHS, "depth", DEFAULT_DEPTH);
  const caps = DEPTH_CAPS[depth];
  const web = webResultsArg(args.web_results);
  return {
    question: requiredStr(args, "question", "the topic or question to research."),
    mode: oneOf(str2(args.mode), ALL_MODES, "mode", "topic"),
    depth,
    backends,
    queries: strArray(args.queries),
    maxSources: positive(args.max_sources, "max_sources"),
    perSource: positive(args.per_source, "per_source") ?? caps.perSource,
    lang: str2(args.lang) ?? "en",
    region: str2(args.region),
    // Pilotable from MCP, at last: these were hardcoded, so a client could not
    // pin an engine, point at a SearXNG, or reach the WebSearch lane at all.
    webEngine: oneOf(str2(args.web_engine), ALL_WEB_ENGINES, "web_engine", "auto"),
    search: oneOf(str2(args.search), ALL_SEARCH_PROFILES, "search", "auto"),
    ...web ? { webResults: web.hits, webResultsRejected: web.rejected } : {},
    searxng: str2(args.searxng),
    firecrawl: str2(args.firecrawl),
    since: str2(args.since),
    excludeDomains: strArray(args.exclude_domains) ?? [],
    seedDomains: strArray(args.seed_domains),
    browser: browserArg(args),
    ...templateArg(args) ? { template: templateArg(args) } : {},
    out,
    json: true
  };
}
function templateArg(args) {
  const t = str2(args.template);
  return t === void 0 ? void 0 : oneOf(t, ALL_TEMPLATES, "template", "verification");
}
var PAGE_TOOLS = /* @__PURE__ */ new Set(["ultrasearch_search", "ultrasearch_gather", "ultrasearch_brainstorm", "ultrasearch_fetch", "ultrasearch_ingest"]);
async function callTool(name, args, defaults = {}) {
  const run = () => dispatch(name, args, defaults);
  const result = PAGE_TOOLS.has(name) ? await withBrowserClosed(run) : await run();
  return outcome(name, result);
}
var NO_WRITE_REFUSED_TOOLS = {
  ultrasearch_fetch: "it adds a new [S#] to a dossier on disk",
  ultrasearch_ingest: "it adds new [S#] entries to a dossier on disk",
  ultrasearch_merge: "it unions the sub-dossiers into a master dossier on disk",
  ultrasearch_verify: "it emits a worklist for skeptics to read from disk",
  ultrasearch_drop: "it removes sources from a dossier on disk",
  ultrasearch_refcheck: "it writes refcheck.json, REFCHECK.md and a dossier of the resolved references"
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
    // Creates its own output dir, like gather.
    case "ultrasearch_refcheck":
      return await handleRefcheck(args);
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
          case "ultrasearch_drop":
            return handleDrop(args, run);
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
    // The mode's own result, inline — for deals, the codes to try with their [S#].
    ...Object.fromEntries(extraSummaries(res.sources, res.manifest).map((s) => [s.key, s.data])),
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
    dossier_md: join27(res.dir, "DOSSIER.md"),
    ...head,
    next: `Read ${join27(res.dir, "DOSSIER.md")} with ultrasearch_read, write the report citing [S#], then prove it with ultrasearch_check.`
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
  for (const a of takeArtifacts()) files[relative2(dir, a.path) || a.path] = a.content;
  return files;
}
function handlePlan(args) {
  const question = requiredStr(args, "question", "the umbrella question to decompose.");
  const mode2 = oneOf(str2(args.mode), ALL_MODES, "mode", "topic");
  const runRoot = str2(args.run_root);
  if (runRoot !== void 0 && !isAbsolute3(runRoot)) throw new ToolError("`run_root` must be an absolute path.");
  const res = runPlan(question, mode2, strArray(args.subquestions), positive(args.max_subquestions, "max_subquestions"), runRoot);
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
    if (!isAbsolute3(r)) throw new ToolError(`\`runs\` must contain absolute paths (got "${r}").`);
    if (!existsSync18(join27(r, "manifest.json"))) throw new ToolError(`no dossier at ${r} \u2014 every entry of \`runs\` must be a gathered dossier.`);
  }
  const master = str2(args.master);
  if (master !== void 0 && !isAbsolute3(master)) throw new ToolError("`master` must be an absolute path.");
  const res = runMerge({ runs, master, question: str2(args.question), mode: str2(args.mode) });
  return {
    run: res.dir,
    dossier_md: join27(res.dir, "DOSSIER.md"),
    sources: res.sources.length,
    merged_from: runs.length,
    next: `Write ONE report against ${res.dir}, citing the merged [S#] ids, then prove it with ultrasearch_check.`
  };
}
async function handleFetch(args, run) {
  const url = requiredStr(args, "url", "an absolute http(s) URL to fetch.");
  if (!/^https?:\/\//i.test(url)) throw new ToolError("`url` must be an absolute http(s) URL.");
  const res = await addSource(run, url, { question: str2(args.question), title: str2(args.title), citeUrl: str2(args.cite_url), browser: browserArg(args) });
  return { run, url, ...res };
}
async function handleRefcheck(args) {
  const refs = requiredStr(args, "refs", "the absolute path to the reference list.");
  const citing = str2(args.citing);
  const out = str2(args.out);
  for (const [k, v] of [
    ["refs", refs],
    ["citing", citing],
    ["out", out]
  ]) {
    if (v !== void 0 && !isAbsolute3(v)) throw new ToolError(`\`${k}\` must be an absolute path.`);
  }
  if (!existsSync18(refs)) throw new ToolError(`no file at ${refs}`);
  if (citing && !existsSync18(citing)) throw new ToolError(`no file at ${citing}`);
  let res;
  try {
    res = await runRefcheck({ refs, citing, out, offline: bool(args.offline) });
  } catch (e) {
    throw new ToolError(e.message);
  }
  const hasDossier = res.references.some((e) => e.sourceId);
  return {
    dir: res.dir,
    report: join27(res.dir, "REFCHECK.md"),
    summary: res.summary,
    ...res.citing ? { citing: res.citing } : {},
    // One line per reference that needs a look, not the whole record set.
    issues: res.references.filter((e) => e.status !== "ok").map((e) => ({
      n: e.n,
      status: e.status,
      ...e.sourceId ? { source: e.sourceId } : {},
      fields: e.fields.filter((f) => f.status !== "match"),
      ...e.doi?.resolves === false ? { doi: "does not resolve" } : {}
    })),
    notes: res.notes,
    next: hasDossier ? `Read ${join27(res.dir, "REFCHECK.md")}; ${res.dir} is a dossier in which source S<n> is reference n \u2014 write REPORT.md to the verification template, citing [S#], then ultrasearch_check with run: ${res.dir}.` : `Read ${join27(res.dir, "REFCHECK.md")}.`
  };
}
async function handleIngest(args, run) {
  const web = webResultsArg(args.web_results);
  const listed = strArray(args.urls) ?? [];
  for (const u of listed) {
    if (!/^https?:\/\//i.test(u)) throw new ToolError(`\`urls\` must hold absolute http(s) URLs (got "${u}").`);
  }
  const hits = [...listed, ...web?.hits ?? []];
  const template = templateArg(args);
  if (template) {
    setDossierTemplate(run, template);
    if (!hits.length) return { run, template, next: "DOSSIER.md now carries that template. Write the report to it, then ultrasearch_check." };
  }
  if (!hits.length) throw new ToolError("`web_results` or `urls` is required \u2014 the URLs to fold into the dossier.");
  const res = await addSources(run, hits, { question: str2(args.question), firecrawl: str2(args.firecrawl), cache: true, browser: browserArg(args) });
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
    failOnWall: bool(args.fail_on_wall),
    minSources: positive(args.min_sources, "min_sources")
  });
  return { run, ...res };
}
function handleRelink(args, run) {
  const id = str2(args.id);
  const url = str2(args.url);
  if (bool(args.list)) return { run, issues: listIssues(run) };
  if (id || url) {
    if (!id || !url) throw new ToolError("`id` and `url` go together \u2014 pass both to repoint one source, or neither to run the automatic pass.");
    const res = relink(run, id, url, { title: str2(args.title) });
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
function handleDrop(args, run) {
  const ids = strArray(args.ids) ?? [];
  const whereRaw = str2(args.where);
  if (whereRaw !== void 0 && !DROP_WHERE.includes(whereRaw)) {
    throw new ToolError(`\`where\` must be one of: ${DROP_WHERE.join(", ")}.`);
  }
  if (!ids.length && !whereRaw) throw new ToolError("Pass `ids` or `where` \u2014 which sources to remove.");
  const res = dropSources(run, { ids, where: whereRaw, dryRun: bool(args.dry_run) });
  return {
    ...res,
    next: res.citedBy.length ? "Some report tiers cite a dropped id \u2014 rewrite those claims onto another source, then run ultrasearch_check." : res.dryRun ? "Nothing was changed. Call again without dry_run to remove these." : "Done. Ids are never reused; the next source ingested takes a fresh one."
  };
}
function handleVerify(args, run) {
  const shards = positive(args.shards, "shards");
  const shard = num3(args.shard);
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
  const wantHtml = !bool(args.no_html);
  const wantMd = !bool(args.no_md);
  if (!wantHtml && !wantMd) throw new ToolError("both `no_html` and `no_md` were set \u2014 there is nothing left to render.");
  const ctx = loadRenderContext(run);
  const written = [];
  if (wantHtml) written.push(writeHtml(ctx));
  if (wantMd) written.push(writeReportMarkdown(ctx));
  return { run, written };
}
function handleRead(args, run) {
  const raw = requiredStr(args, "path", "a path relative to the dossier, or an absolute path inside it.");
  const target = isAbsolute3(raw) ? raw : join27(run, raw);
  let real;
  try {
    real = realpathSync3(target);
  } catch {
    throw new ToolError(`no such file: ${raw}`);
  }
  const root = realpathSync3(run);
  if (real !== root && !real.startsWith(root + sep3)) {
    throw new ToolError(`path is outside the dossier: ${raw}. Use your own file tool for anything else.`);
  }
  const st = statSync10(real);
  if (!st.isFile()) throw new ToolError(`not a file: ${raw}`);
  if (st.size > MAX_READ_BYTES) throw new ToolError(`file is too large to read (${st.size} bytes): ${raw}`);
  const lines = readFileSync19(real, "utf8").split("\n");
  const total = lines.length;
  const start = Math.max(1, Math.floor(num3(args.start_line) ?? 1));
  if (start > total) throw new ToolError(`start_line ${start} is past the end of the file (${total} lines).`);
  const requestedEnd = Math.floor(num3(args.end_line) ?? total);
  const end = Math.min(total, Math.max(start, requestedEnd), start + MAX_READ_LINES - 1);
  return {
    path: isAbsolute3(raw) ? real : raw,
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
  description: "Which research profile to use: topic (general), bug (an error \u2014 StackOverflow/GitHub/HN), research (scholarly APIs + BibTeX), clinical (PubMed, Europe PMC, ClinicalTrials.gov \u2014 a clinical or biomedical question; no arXiv; BibTeX), learn (a lesson), startup (market and competitors), deals (coupons and discount codes for a merchant \u2014 pair with lang + region for the country; writes codes.json). Default: topic."
};
var langProp = { type: "string", description: "Search language, e.g. 'fr'. Default: en." };
var templateProp = {
  type: "string",
  enum: [...ALL_TEMPLATES].sort(),
  description: "The report template the dossier asks for, when not the mode's own \u2014 any mode's, or 'verification' (verdict, reference-by-reference table, discrepancies, not verifiable). Headings are free; ultrasearch_check only expects an 'Open questions' section."
};
var webResultsProp = {
  type: "array",
  items: { type: "object" },
  description: "YOUR OWN web-search hits \u2014 [{url, title, snippet}, \u2026]. This is the PRIMARY discovery lane: the strongest index available here, and the only one that needs neither a container nor a scrape. Run your web search first, pass the hits, and the engine fetches, ranks and dedupes them like any other candidate. A bare list of URL strings works too. For ultrasearch_ingest, a hit may add citeUrl: the text is read from url and that page is cited."
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
var browserProp = {
  type: "string",
  enum: [...ALL_BROWSER_MODES].sort(),
  description: "The browser rung: a real, separate Chrome or Brave (its own profile) renders the pages the built-in reader cannot \u2014 JS shells, consent and anti-bot walls. 'fallback' = only a page that was refused, walled or empty; 'always' = every web page (slow); 'off' = never. Default: fallback when a browser is installed and a window can be shown, else off (ULTRASEARCH_BROWSER_FETCH overrides it). A window may appear while the call runs; it is closed when the call ends. It never accepts a consent wall for the user and never solves a challenge."
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
        max_sources: { type: "number", description: "Cap on results returned (default 10)." },
        browser: browserProp
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
        browser: browserProp,
        template: templateProp,
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
        firecrawl: firecrawlProp,
        browser: browserProp,
        template: { ...templateProp, description: `${templateProp.description} Alone (no urls/web_results), it only switches the template.` }
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
        },
        browser: browserProp
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
        fail_on_wall: {
          type: "boolean",
          description: "Also fail when a cited source holds only a snippet or a near-empty extract. A cited wall (cookie/consent/anti-bot page) fails regardless."
        },
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
    name: "ultrasearch_drop",
    title: "Remove sources from a dossier",
    description: "Take sources out of a dossier \u2014 by id, or every source of a kind: `wall` (the page was a cookie/consent/anti-bot wall), `snippet` (only the search snippet is on file), `offtopic` (flagged by gather as unrelated). Ids stay stable: the gaps remain and a dropped id is never reused. Use dry_run first.",
    inputSchema: {
      type: "object",
      properties: {
        run: runProp,
        ids: { type: "array", items: { type: "string" }, description: 'The sources to remove, e.g. ["S43", "S44"].' },
        where: { type: "string", enum: ["offtopic", "snippet", "wall"], description: "Remove every source of this kind." },
        dry_run: { type: "boolean", description: "List what would be removed and change nothing." }
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
      properties: {
        question: questionProp,
        mode: modeProp,
        out: { type: "string", description: "Absolute directory to write BRAINSTORM.md to." },
        browser: browserProp
      },
      required: ["question"]
    }
  },
  {
    name: "ultrasearch_refcheck",
    title: "Check a bibliography against PubMed and Crossref",
    description: "Check a reference list the way a reviewer would: resolve each reference on PubMed (E-utilities) or Crossref, diff authors, title, NLM journal, year, volume, issue, pages and DOI field by field, and check every cited DOI on doi.org. With a citing text (or a document whose body precedes its reference list), it also lists references never cited, calls with no reference, the Vancouver first-citation order, and every figure a citing passage states that the cited abstract lacks. Writes refcheck.json, REFCHECK.md and a dossier in which source S<n> is reference n \u2014 write a report from it and prove it with ultrasearch_check.",
    inputSchema: {
      type: "object",
      properties: {
        refs: {
          type: "string",
          description: "Absolute path to the reference list: numbered Vancouver (.txt/.md, or a .docx/.pdf with a References heading) or .bib."
        },
        citing: { type: "string", description: "Absolute path to the text that cites them (.md/.txt/.docx/.pdf). Defaults to the body of `refs`." },
        out: { type: "string", description: "Absolute output directory (default: a timestamped dir under the temp root)." },
        offline: { type: "boolean", description: "Parse and read the citing text only \u2014 no PubMed, Crossref or doi.org." }
      },
      required: ["refs"]
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
  ultrasearch_drop: { write: true, destructive: true, idempotent: true, openWorld: false },
  ultrasearch_verify: { write: true, destructive: false, idempotent: true, openWorld: false },
  ultrasearch_render: { write: true, destructive: false, idempotent: true, openWorld: false },
  ultrasearch_plan: { openWorld: false },
  ultrasearch_merge: { write: true, destructive: false, idempotent: true, openWorld: false },
  ultrasearch_brainstorm: { write: true, destructive: false, idempotent: true, openWorld: false },
  ultrasearch_refcheck: { write: true, destructive: false, idempotent: true, openWorld: true },
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
  const base2 = opts.allowWrite ? [...TOOLS, ...WRITE_TOOLS] : TOOLS;
  const withAnnotations = protocolVersion >= ANNOTATIONS_SINCE;
  const withRich = protocolVersion >= RICH_TOOLS_SINCE;
  return base2.map((t) => {
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
  },
  {
    name: "find_coupons",
    title: "Find discount codes for a merchant",
    description: "The deals workflow: sweep the web and the deal communities for a merchant's coupon codes, rank what they report, and answer with a table in which every code is cited to a page that shows it \u2014 never a code guessed or remembered.",
    arguments: [
      { name: "merchant", description: "The shop, ideally with its domain for the country (e.g. decathlon.fr).", required: true },
      { name: "country", description: "Two-letter country code, e.g. fr, gb, de, us. Picks the deal community and the local sites.", required: false },
      { name: "lang", description: "Search language, e.g. fr. Default: the country's.", required: false }
    ]
  }
];
var RENDER = {
  research_topic: researchTopic,
  debug_error: debugError,
  literature_review: literatureReview,
  find_coupons: findCoupons
};
var RENDERED_PROMPTS = Object.keys(RENDER);
function getPrompt(name, args = {}) {
  const decl = PROMPTS.find((p) => p.name === name);
  if (!decl) throw new PromptError(`unknown prompt: ${name || "(none given)"}`);
  for (const arg of decl.arguments ?? []) {
    if (arg.required && !str3(args[arg.name])) throw new PromptError(`\`${arg.name}\` is required for prompt "${name}"`);
  }
  const render2 = RENDER[name];
  if (!render2) throw new PromptError(`prompt "${name}" has no renderer`);
  const text = render2(args);
  return { description: decl.description, messages: [{ role: "user", content: { type: "text", text } }] };
}
var CORE_RULE = `Answer only from the sources this dossier actually fetched. Your training data is stale, and on a fast-moving topic it is confidently wrong. If the dossier does not cover something, say so and gather more \u2014 never fill the gap from memory and decorate it with a nearby citation.`;
var GATE = `\`ultrasearch_check\` returning \`ok: false\` is a VERDICT, not a tool failure. Read the errors, fix the report, and check again. Do not report a document that has not passed.`;
var THIN = `**If the dossier comes back thin**, do not write around it. Either gather again with different wording \u2014 the topic's own vocabulary, not yours \u2014 or find pages yourself and ingest each one with \`ultrasearch_fetch\` so it becomes a citable [S#]. A thin dossier honestly reported beats a full-looking report resting on four sources.`;
function researchTopic(args) {
  const question = str3(args.question);
  const depth = str3(args.depth);
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
  const error = str3(args.error);
  const context = str3(args.context);
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
  const question = str3(args.question);
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
function findCoupons(args) {
  const merchant = str3(args.merchant);
  const country = str3(args.country)?.toLowerCase();
  const lang = str3(args.lang);
  const locale = [lang && `\`lang: "${lang}"\``, country && `\`region: "${country}"\``].filter(Boolean).join(" and ");
  const domain = /\.[a-z]{2,}$/i.test(merchant.trim()) ? merchant.trim() : void 0;
  return `Find working discount codes for:

> ${merchant}${country ? ` (${country})` : ""}

${CORE_RULE}

**A code is a claim like any other \u2014 it needs a source that shows it.** Never write a code you did not see on a fetched page, never "complete" a partial one, and never present a code as working unless it was actually tried.

**Sequence:**

1. Sweep with your own web search first \u2014 the merchant + "promo code" in the country's language with this month and year, the country's deal community (Dealabs, hotukdeals, mydealz\u2026), its coupon aggregators, and Reddit. Keep the hits.
2. \`ultrasearch_gather\` with \`mode: "deals"\`${locale ? `, ${locale}` : ""}${domain ? `, \`seed_domains: ["${domain}"]\`` : ""}, and your hits as \`web_results\`. It returns the dossier directory.
3. \`ultrasearch_read\` its \`codes.json\` \u2014 the ranked candidates, with the [S#] sources each was seen in \u2014 then \`DOSSIER.md\`. Confirm every candidate in the extract it cites.
4. For a gap (no code from the merchant's own site, a candidate seen on one page only), find the page and \`ultrasearch_fetch\` it so it becomes a citable [S#].
5. Write the report to the deals template: one row per code \u2014 code \xB7 discount \xB7 conditions \xB7 expiry \xB7 sources \xB7 confidence \xB7 tested \u2014 then the merchant's own offers, the other ways to save, and the expired or dubious codes, each cited.
6. \`ultrasearch_check\` on the dossier, then \`ultrasearch_render\`.

**Rank honestly.** A code on one aggregator page is weak; the same code on the deal community and a forum, with a future expiry, is strong. Say which is which. Mark every code "not tested" unless the user tried it in their own cart.

${THIN}

${GATE}`;
}
function str3(v) {
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
  ultrasearch ingest --run <dossier-dir> [--web-results <f.json|->] [--urls <u,...>] [--files <p,...>] [--template <t>] [--json]
  ultrasearch refcheck --refs <list.txt|.docx|.pdf|.bib> [--citing <text.md|.docx>] [--out <dir>] [--offline] [--json]
  ultrasearch render --run <dossier-dir> [--no-html] [--no-md]
  ultrasearch check  --run <dossier-dir> [--semantic] [--require-verify] [--strict-numerals] [--fail-on-wall] [--min-sources <n>]
  ultrasearch relink --run <dossier-dir> [--list] [--id <S#> --url <page>] [--title <s>]
  ultrasearch drop   --run <dossier-dir> (--id <S#,...> | --where wall|snippet|offtopic) [--dry-run] [--json]
  ultrasearch modes  [--json]
  ultrasearch doctor [--run <dossier-dir>] [--json]
  ultrasearch mcp    [--transport stdio|http] [--run <dossier-dir>] [--port <n>] [--bind <addr>]
                     [--allow-origin <o,...>] [--allow-remote] [--max-response-bytes <n>]
  ultrasearch brainstorm --q "<vague question>" [--mode <m>] [--out <dir>] [--json]
  ultrasearch plan   --q "<question>" [--mode <m>] [--subquestions "a|b|c"] [--run-root <dir>] [--max-subquestions <n>]
  ultrasearch merge  --runs "<dir1,dir2,\u2026>" --master <dir> [--q "<question>"]
  ultrasearch verify --run <dossier-dir> [--apply <files>] [--shards <n> --shard <i>] [--max-verify <n>]
  ultrasearch orchestrate --run <run-dir> [--phase gather|verify] [--eco] [--list] [--browser <m>]
  ultrasearch browser open <url>

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
           PubMed and PMC pages (and efetch URLs) are read through E-utilities
           and Europe PMC, never through their cookie / anti-bot walls.
  refcheck Check a bibliography: resolve every reference on PubMed (E-utilities)
           or Crossref, diff authors / title / NLM journal / year / volume /
           issue / pages / DOI field by field, check each cited DOI on doi.org,
           and \u2014 with a citing text (--citing, or the body of --refs itself) \u2014
           list orphan references and calls, the Vancouver first-citation order,
           and every figure a citing sentence states that its abstract lacks.
           Writes refcheck.json + REFCHECK.md and a dossier in which source
           S<n> is reference n (verification template), so 'check' applies.
  render   Render the report tiers in a dossier to a self-contained index.html
           AND a consolidated index.md (both by default; --no-html / --no-md skip one).
  check    Validate citation grounding of SUMMARY/REPORT.md (--semantic
           also folds in the verify verdicts: fails on unsupported claims;
           --require-verify makes a missing/empty VERIFY.json a hard failure \u2014
           the deep-tier exit gate; --min-sources <n> fails a too-thin dossier).
           A CITED source whose extract is a wall (cookie, consent, anti-bot)
           always fails; one holding only a snippet warns (--fail-on-wall fails).
  relink   Repair source CITATIONS in place (no re-fetch, no network). Bare, it
           rewrites every source whose own text names where it lives (canonical
           link, DOI, arXiv id, PMID) and then prints what it could not prove.
           --list is the dry run. --id <S#> --url <page> folds in your answer.
  drop     Remove sources from a dossier: --id S43,S44 or --where wall |
           snippet | offtopic. Deletes their extracts and rewrites the index.
           Ids are stable \u2014 the gaps stay, and a dropped id is never reused, so
           a report still citing one fails 'check' as dangling. --dry-run lists
           what would go.
  modes    List the report modes and their backend profiles.
  doctor   Report the state of the engine and its optional helpers: the SearXNG
           and Firecrawl containers, the browser rung, the PDF extractor ladder. The helpers are
           skipped in SILENCE when absent, so this is how you find out a
           container is up but unused, or a stronger PDF reader is missing.
           With --run <dossier-dir>, also says whether THAT run had a WebSearch
           lane \u2014 a dossier built without one looks just like a good one.
  searxng  | firecrawl   Manage the optional container: up | down | status.
  browser  open <url>: open a page in the dedicated browser (~/.ultrasearch/browser)
           for YOU to deal with \u2014 the CAPTCHA or anti-bot check a read reported.
           The engine never solves one; once you have, the next read gets the page.
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
           sequential RUNBOOK.md, under <RUN>/orchestration/. Subagents return
           fragments; the merge / verify --apply folds stay with you.

Options:
  --q, --question <s>  The topic or question                      (required)
  --mode <m>           ${ALL_MODES.join(" | ")}   (default: topic)
                       (checking a bibliography is the 'refcheck' command, not a mode)
  --template <t>       For gather / ingest: write the report to another template
                       than the mode's: ${ALL_TEMPLATES.join(" | ")}
                       (verification = verdict, reference-by-reference table,
                       discrepancies, not verifiable). Headings are free; 'check'
                       only expects an "Open questions" section.
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
  --browser <m>        ${ALL_BROWSER_MODES.join(" | ")}   the browser rung, for gather / search / brainstorm /
                       fetch / ingest / orchestrate: a real, separate Chrome or
                       Brave (own profile) renders the pages the built-in reader
                       cannot \u2014 JS shells, consent and anti-bot walls. A window
                       may appear during the run; it is closed when the command
                       ends. It never accepts a consent wall for you and never
                       solves a challenge.
                       fallback = only a page that was refused, walled or empty
                       always   = every web page (slow)
                       off      = never
                       (env ULTRASEARCH_BROWSER_FETCH; default: fallback when a
                       Chrome/Brave/Chromium/Edge is installed and a window can
                       be shown \u2014 macOS, Windows, Linux with a display \u2014 else
                       off; always off by default under --stdout, which writes
                       nothing, not even the browser's profile)
  --web-results <f>    YOUR OWN WebSearch hits, as JSON: [{url,title,snippet}, \u2026]
                       (a bare array of URLs, or '-' for stdin, also work). For
                       'ingest', a hit may add citeUrl: read the text from url,
                       cite that page (fetch --cite-url, per hit). This
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
  --refs <file>        For 'refcheck': the reference list \u2014 a numbered Vancouver
                       list (.txt/.md, or the text of a .docx/.pdf, found under
                       its References heading) or a .bib file
  --citing <file>      For 'refcheck': the text that cites them (.md/.txt/.docx/.pdf)
  --offline            For 'refcheck': parse and read the citing text only \u2014 no
                       PubMed, Crossref or doi.org lookup
  --cite-url <page>    For 'fetch': read the text from --url but CITE this page \u2014
                       when you know the document an endpoint returns
  --id <S#>            For 'relink': the source to repoint. For 'drop': the
                       source(s) to remove (comma-separated)
  --where <kind>       For 'drop': remove every source of a kind \u2014 wall (the
                       page was a cookie/consent/anti-bot wall), snippet (only
                       the search snippet is on file), offtopic (flagged by
                       gather as unrelated to the question)
  --dry-run            For 'drop': list what would be removed, change nothing
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
  --no-cache           Disable the on-disk fetch cache: every read is live \u2014 the
                       page, its text endpoint (E-utilities, Europe PMC) and the
                       landing-page fallback alike. A cached copy that turns out
                       to be a wall is re-read live even without it
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
  --fail-on-wall       For 'check': also fail (not warn) when a cited source holds
                       only a snippet or a near-empty extract \u2014 a cited WALL
                       fails with or without this flag
  --min-sources <n>    For 'check': fail a dossier with fewer kept sources
  --stdout             Write NOTHING to disk; stream what would have been written
                       (env ULTRASEARCH_NO_WRITE=1 does the same globally). For a
                       read-only phase. gather \u2192 DOSSIER.md + every source
                       extract \xB7 brainstorm \u2192 BRAINSTORM.md \xB7 plan \u2192 PLAN.json \xB7
                       render \u2192 index.md (no HTML). merge / fetch / verify /
                       orchestrate / drop exit 2: they exist to leave files behind.
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
  "drop",
  "modes",
  "brainstorm",
  "plan",
  "merge",
  "verify",
  "orchestrate",
  "refcheck",
  "mcp",
  "doctor",
  "searxng",
  "firecrawl",
  "browser"
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
  "browser",
  "web-engine",
  "web-results",
  "search",
  "urls",
  "files",
  "url",
  "cite-url",
  "id",
  "since",
  "where",
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
  "template",
  "refs",
  "citing",
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
  "fail-on-wall",
  "cache",
  "no-cache",
  "eco",
  "list",
  "dry-run",
  "allow-remote",
  "offline"
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
function parseCli(argv) {
  let parsed;
  try {
    parsed = parseArgs(argv, { commands: COMMANDS, valueFlags: VALUE_FLAGS, boolFlags: BOOL_FLAGS });
  } catch (e) {
    if (!(e instanceof UsageError)) throw e;
    fail(e.message);
  }
  if (parsed.kind === "help") {
    process.stdout.write(HELP);
    process.exit(0);
  }
  if (parsed.kind === "version") {
    process.stdout.write(VERSION + "\n");
    process.exit(0);
  }
  return parsed;
}
function parseList(s) {
  return s.split(",").map((x) => x.trim()).filter(Boolean);
}
function resolveApplyPaths(spec) {
  if (spec.includes(",")) return parseList(spec).map((x) => resolve8(x));
  const abs = resolve8(spec);
  if (existsSync19(abs) && statSync11(abs).isDirectory()) {
    const files = readdirSync6(abs).filter((f) => /verdict/i.test(f) && /\.json$/i.test(f)).sort().map((f) => resolve8(abs, f));
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
      return readFileSync20(0, "utf8");
    } catch {
      fail("--web-results -: could not read stdin");
    }
  }
  const abs = resolve8(spec);
  if (!existsSync19(abs)) fail(`--web-results file not found: ${abs}`);
  try {
    return readFileSync20(abs, "utf8");
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
  drop: "it removes sources from a dossier on disk",
  verify: "it emits a worklist for skeptics to read from disk (and --apply folds their verdicts back into it)",
  orchestrate: "it emits workflow scripts and agent contracts the harness opens by path",
  refcheck: "it writes refcheck.json, REFCHECK.md and a dossier of the resolved references"
};
var STDOUT_BRIEF = ["DOSSIER.md", "BRAINSTORM.md", "PLAN.json", "index.md"];
function sourceNum(rel) {
  return Number(/^sources\/S(\d+)\.md$/.exec(rel)?.[1] ?? 0);
}
function emitArtifacts(dir, asJson, extra = {}) {
  const artifacts = takeArtifacts().map((a) => ({ rel: relative3(dir, a.path) || basename5(a.path), content: a.content }));
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
    ...extraFiles().map(at)
  ].filter((a) => a !== void 0);
  const out = shown.map((a) => `===== ${a.rel} =====
${a.content.endsWith("\n") ? a.content : a.content + "\n"}`);
  if (out.length) process.stdout.write(out.join(""));
}
function num4(name, raw, fallback2) {
  if (raw === void 0) return fallback2;
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
  const offTopicIds = r.sources.filter((s) => s.offTopic).map((s) => s.id);
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
      // Named here as well as in DOSSIER.md: a 42-source dossier whose six arXiv
      // papers are unrelated should not need reading end to end to find them.
      ...offTopicIds.length ? [
        `  offtopic: ${offTopicIds.slice(0, 8).join(", ")}${offTopicIds.length > 8 ? ", \u2026" : ""} \u2014 probably unrelated` + (options.stdout ? "" : `; clear them: ultrasearch drop --run ${r.dir} --where offtopic`)
      ] : [],
      // What the mode's extras found (the codes to try, for deals), up front.
      ...extraSummaries(r.sources, r.manifest).flatMap((s) => s.lines),
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
function browserMode(p) {
  const flag = p.values.browser === void 0 ? void 0 : oneOf2("browser", p.values.browser, ALL_BROWSER_MODES);
  return resolveBrowserRung({ flag }).mode;
}
var PAGE_COMMANDS = /* @__PURE__ */ new Set(["gather", "search", "fetch", "add-source", "ingest", "brainstorm"]);
async function exitClosed(code) {
  await closeBrowserReads();
  process.exit(code);
}
var REFCHECK_POINTER = "checking a bibliography is the `refcheck` command, not a mode: ultrasearch refcheck --refs <list.txt|.docx|.pdf|.bib> [--citing <text>] --out <dir>";
function modeOf(p) {
  if (p.values.mode === "refcheck") fail(REFCHECK_POINTER);
  return oneOf2("mode", p.values.mode ?? "topic", ALL_MODES);
}
function templateOf(p) {
  return p.values.template === void 0 ? void 0 : oneOf2("template", p.values.template, ALL_TEMPLATES);
}
function buildGatherOptions(p, opts = {}) {
  const question = p.values.q ?? p.values.question ?? "";
  if (opts.requireQuestion !== false && !question) fail('missing --q "<question>"');
  const mode2 = modeOf(p);
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
    mode: mode2,
    depth,
    backends: p.values.backends ? parseBackends(p.values.backends) : void 0,
    queries: p.values.queries ? p.values.queries.split("|").map((s) => s.trim()).filter(Boolean) : void 0,
    // Unset unless asked for: no default FETCH budget (see GatherOptions).
    maxSources: p.values["max-sources"] ? num4("max-sources", p.values["max-sources"], 0) : void 0,
    perSource: num4("per-source", p.values["per-source"], caps.perSource),
    lang: p.values.lang ?? "en",
    region: p.values.region,
    searxng: p.values.searxng,
    firecrawl: p.values.firecrawl,
    webEngine,
    search,
    ...parsedWeb ? { webResults: parsedWeb.hits, webResultsRejected: parsedWeb.rejected } : {},
    pages: p.values.pages ? Math.min(5, num4("pages", p.values.pages, 1)) : void 0,
    webBreadth: p.values["web-breadth"] ? Math.min(5, num4("web-breadth", p.values["web-breadth"], 1)) : void 0,
    urls: p.values.url ? parseList(p.values.url) : void 0,
    since: p.values.since,
    excludeDomains: p.values["exclude-domains"] ? parseList(p.values["exclude-domains"]) : [],
    seedDomains: p.values["seed-domains"] ? parseList(p.values["seed-domains"]) : void 0,
    concurrency: p.values.concurrency ? num4("concurrency", p.values.concurrency, 6) : void 0,
    rounds: p.values.rounds ? num4("rounds", p.values.rounds, 1) : void 0,
    // Default ON: the on-disk cache is a pure win for the deep tier's fan-out,
    // for a re-gather after a failed check, and for the `fetch --url` bridge.
    // `--cache` stays an accepted no-op so every prompt and emitted contract
    // already in the wild keeps working; `--no-cache` is the escape hatch.
    cache: !p.bools.has("no-cache"),
    browser: browserMode(p),
    out: p.values.out ? resolve8(p.values.out) : void 0,
    json: p.bools.has("json"),
    // Read from the gate, not the flag, so ULTRASEARCH_NO_WRITE=1 alone still
    // reshapes the guidance. main() calls setNoWrite before this runs.
    stdout: isNoWrite(),
    ...templateOf(p) ? { template: templateOf(p) } : {}
  };
}
async function main(argv = process.argv.slice(2)) {
  const p = parseCli(argv);
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
  if (!PAGE_COMMANDS.has(p.command)) return dispatch2(p);
  const uninstall = closeBrowserOnSignal();
  try {
    await withBrowserClosed(() => dispatch2(p));
  } finally {
    uninstall();
  }
}
async function dispatch2(p) {
  switch (p.command) {
    case "gather": {
      const options = buildGatherOptions(p);
      if (options.search === "max" && !options.json) {
        const down = (await probeServices({ firecrawl: options.firecrawl, searxng: options.searxng }, ["searxng", "firecrawl"])).filter((s) => !s.ok);
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
      const summaries = Object.fromEntries(extraSummaries(r.sources, r.manifest).map((s) => [s.key, s.data]));
      if (options.stdout) {
        emitArtifacts(r.dir, options.json, { manifest: r.manifest, ...summaries });
        process.stderr.write(report.lines.join("\n") + "\n");
        process.exitCode = report.exitCode;
        return;
      }
      if (options.json) {
        process.stdout.write(JSON.stringify({ dir: r.dir, manifest: r.manifest, ...summaries }, null, 2) + "\n");
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
      if (p.values.mode === "refcheck") {
        process.stdout.write(`ultrasearch: ${REFCHECK_POINTER}
`);
        return;
      }
      const question = p.values.q ?? p.values.question;
      if (!question) fail('missing --q "<question>"');
      const plan = planQueries({
        question,
        mode: modeOf(p),
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
        const mf = join28(resolve8(runDir), "manifest.json");
        if (!existsSync19(mf)) fail(`no dossier at ${resolve8(runDir)} (no manifest.json)`);
        try {
          manifest = JSON.parse(readFileSync20(mf, "utf8"));
        } catch (e) {
          fail(`could not read ${mf}: ${e.message}`);
        }
      }
      const rows = [
        describeWebSearchLane(manifest),
        ...await probeServices({
          firecrawl: p.values.firecrawl,
          searxng: p.values.searxng,
          browser: p.values.browser === void 0 ? void 0 : oneOf2("browser", p.values.browser, ALL_BROWSER_MODES)
        })
      ];
      if (p.bools.has("json")) {
        process.stdout.write(JSON.stringify(rows, null, 2) + "\n");
        return;
      }
      const head = runDir ? `ultrasearch ${VERSION} \u2014 ${resolve8(runDir)}` : `ultrasearch ${VERSION} \u2014 the engine, and the optional helpers`;
      process.stdout.write(`${head}

${formatServices(rows)}
`);
      return;
    }
    // The human's half of the browser rung. A read that meets a CAPTCHA or an
    // anti-bot check reports it and moves on — it is never solved for anyone.
    // This opens the page in the same dedicated browser (its own profile), and
    // leaves it open: once the human has passed the check there, the next read
    // of that host gets the page.
    case "browser": {
      const action = p.positional[0];
      const url = p.positional[1] ?? p.values.url;
      if (action !== "open") fail(`browser: unknown action '${action ?? ""}' (expected: open <url>)`);
      if (!url || !/^https?:\/\//i.test(url)) fail("browser open: expected an absolute http(s) URL");
      let session;
      try {
        session = await openBrowserSession({ newTab: true });
      } catch (e) {
        fail(`browser open: ${e.message}`);
      }
      for (const n of session.takeNotes()) process.stderr.write(`ultrasearch: ${n}
`);
      try {
        await session.navigate(url, { waitUntil: "domcontentloaded" });
      } catch (e) {
        if (session.spawned) await session.shutdown();
        else await session.detach();
        fail(`browser open: ${e.message}`);
      }
      await session.detach();
      process.stderr.write(`ultrasearch: opened ${url} in the dedicated browser \u2014 deal with the check there, then re-run the read.
`);
      return;
    }
    case "searxng":
    case "firecrawl": {
      const action = p.positional[0] ?? "status";
      if (action === "status") {
        const rows = await probeServices({ firecrawl: p.values.firecrawl, searxng: p.values.searxng }, [p.command]);
        process.stdout.write(formatServices(rows) + "\n");
        return;
      }
      if (action !== "up" && action !== "down") {
        fail(`${p.command}: unknown action '${action}' (expected up | down | status)`);
      }
      const r = sharedStackControl(p.command, action);
      process.stdout.write(r.message + "\n");
      if (r.code !== 0) process.exit(r.code);
      if (action === "up") {
        const rows = await probeServices({ firecrawl: p.values.firecrawl, searxng: p.values.searxng }, [p.command]);
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
      out.push(`  written: ${resolve8(result.dir)}/BRAINSTORM.md`);
      process.stdout.write(out.join("\n") + "\n");
      return;
    }
    case "plan": {
      const options = buildGatherOptions(p);
      const override = p.values.subquestions ? p.values.subquestions.split("|").map((s) => s.trim()).filter(Boolean) : void 0;
      const cap = p.values["max-subquestions"] ? num4("max-subquestions", p.values["max-subquestions"], 6) : void 0;
      const runRoot = p.values["run-root"] ? resolve8(p.values["run-root"]) : void 0;
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
      const runs = p.values.runs ? parseList(p.values.runs).map((d) => resolve8(d)) : [];
      if (!runs.length) fail('missing --runs "<dir1,dir2,\u2026>"');
      for (const d of runs) if (!existsSync19(d)) fail(`run dir not found: ${d}`);
      const mode2 = p.values.mode ? oneOf2("mode", p.values.mode, ALL_MODES) : void 0;
      const result = runMerge({
        runs,
        master: p.values.master ? resolve8(p.values.master) : void 0,
        question: p.values.q ?? p.values.question,
        mode: mode2
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
      const r = await addSource(resolve8(dir), url, {
        question: p.values.q ?? p.values.question,
        title: p.values.title,
        citeUrl: p.values["cite-url"],
        firecrawl: p.values.firecrawl,
        cache: !p.bools.has("no-cache"),
        // same default-on policy as gather
        browser: browserMode(p)
      });
      if (p.bools.has("json")) {
        process.stdout.write(JSON.stringify(r, null, 2) + "\n");
      } else if (r.added) {
        process.stdout.write(`${r.id}
`);
        process.stderr.write(`ultrasearch: added ${r.id} \u2190 ${url}
`);
        if (r.note) process.stderr.write(`ultrasearch: ${r.note}
`);
      } else {
        process.stderr.write(`ultrasearch: ${r.note ?? "not added"}
`);
        if (r.id) process.stdout.write(`${r.id}
`);
      }
      if (!r.id) await exitClosed(1);
      return;
    }
    case "ingest": {
      const dir = p.values.run ?? p.values.out;
      if (!dir) fail("missing --run <dossier-dir>");
      const spec = p.values["web-results"];
      const listed = p.values.urls ? parseList(p.values.urls) : [];
      const files = p.values.files ? parseList(p.values.files) : [];
      const template = templateOf(p);
      if (template) {
        if (!existsSync19(join28(resolve8(dir), "manifest.json"))) fail(`no dossier at ${resolve8(dir)} (no manifest.json)`);
        setDossierTemplate(resolve8(dir), template);
        process.stderr.write(`ultrasearch: ${resolve8(dir)} now asks for the ${template} template (DOSSIER.md rewritten)
`);
        if (!spec && !listed.length && !files.length) return;
      }
      if (!spec && !listed.length && !files.length) fail("missing --web-results <f.json|->, --urls <u,...>, --files <p,...> or --template <t>");
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
        firecrawl: p.values.firecrawl,
        browser: browserMode(p)
      };
      const web = hits.length ? await addSources(resolve8(dir), hits, enrichOpts) : void 0;
      const local2 = files.length ? await addFiles(resolve8(dir), files, enrichOpts) : void 0;
      const r = {
        results: [...web?.results ?? [], ...local2?.results ?? []],
        added: (web?.added ?? 0) + (local2?.added ?? 0),
        skipped: (web?.skipped ?? 0) + (local2?.skipped ?? 0)
      };
      if (p.bools.has("json")) {
        process.stdout.write(JSON.stringify(r, null, 2) + "\n");
      } else {
        for (const o of r.results) {
          process.stdout.write(o.added ? `${o.id}	${o.url}
` : `-	${o.url}	${o.note ?? "not added"}
`);
          if (o.added && o.note) process.stderr.write(`ultrasearch: ${o.note}
`);
        }
        const what = files.length ? hits.length ? "input(s)" : "file(s)" : "URL(s)";
        process.stderr.write(`ultrasearch: ingested ${r.added} source(s), skipped ${r.skipped} of ${r.results.length} ${what} \u2192 ${resolve8(dir)}
`);
      }
      if (!r.added) await exitClosed(1);
      return;
    }
    case "refcheck": {
      const refs = p.values.refs;
      if (!refs) fail("missing --refs <list.txt|.docx|.pdf|.bib>");
      const r = await runRefcheck({ refs, citing: p.values.citing, out: p.values.out ?? p.values.run, offline: p.bools.has("offline") });
      if (p.bools.has("json")) {
        process.stdout.write(JSON.stringify(r, null, 2) + "\n");
        return;
      }
      const s = r.summary;
      const lines = [
        `ultrasearch refcheck: ${s.references} reference(s) in ${basename5(r.refsFile)}`,
        r.offline ? `  offline:  parsed only \u2014 nothing looked up` : `  resolved: ${s.resolved} (${s.viaPubmed} PubMed, ${s.viaCrossref} Crossref) \xB7 unresolved: ${s.unresolved}`,
        ...r.offline ? [] : [
          `  fields:   ${s.withDiscrepancies} reference(s) with a discrepancy \u2014 ${s.fieldMismatches} mismatch(es), ${s.fieldsMissing} missing`,
          `  DOIs:     ${s.doisCited} cited, ${s.doisBroken} not resolving`
        ],
        ...r.citing ? [
          `  citing:   ${r.citing.calls} call(s) \xB7 ${s.uncited} never cited \xB7 ${s.unknownCalls} unknown number(s) \xB7 ${s.outOfOrder} out of order`,
          ...r.offline ? [] : [`  figures:  ${s.numeralsChecked} checked against abstracts, ${s.numeralsAbsent} not found`]
        ] : [`  citing:   none \u2014 pass --citing <file> to check orphans, order and figures`],
        `  report:   ${join28(r.dir, "REFCHECK.md")}`,
        ...r.references.some((e) => e.sourceId) ? [`  dossier:  ${r.dir} \u2014 source S<n> is reference n; write REPORT.md (verification template), then check --run ${r.dir}`] : []
      ];
      process.stderr.write(lines.join("\n") + "\n");
      return;
    }
    case "render": {
      const dir = p.values.run ?? p.values.out;
      if (!dir) fail("missing --run <dossier-dir>");
      const rdir = resolve8(dir);
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
      const wantHtml = !p.bools.has("no-html");
      const wantMd = !p.bools.has("no-md");
      const written = {};
      if (wantHtml || wantMd) {
        const ctx = loadRenderContext(rdir);
        if (wantHtml) {
          written.html = writeHtml(ctx, p.values.out && p.values.run ? resolve8(p.values.out) : void 0);
          process.stderr.write(`ultrasearch: wrote ${written.html}
`);
        }
        if (wantMd) {
          written.md = writeReportMarkdown(ctx);
          process.stderr.write(`ultrasearch: wrote ${written.md}
`);
        }
      }
      if (p.bools.has("json")) process.stdout.write(JSON.stringify(written, null, 2) + "\n");
      return;
    }
    case "verify": {
      const dir = p.values.run ?? p.values.out;
      if (!dir) fail("missing --run <dossier-dir>");
      const rdir = resolve8(dir);
      if (p.values.apply) {
        const result = applyVerdicts(rdir, resolveApplyPaths(p.values.apply));
        if (p.bools.has("json")) process.stdout.write(JSON.stringify(result, null, 2) + "\n");
        else process.stdout.write(formatVerifyReport(result) + "\n");
        if (!result.ok) process.exit(1);
        return;
      }
      const maxVerify = p.values["max-verify"] ? num4("max-verify", p.values["max-verify"], DEEP_CAPS.maxVerify) : void 0;
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
      const engineAbs = realpathSync4(fileURLToPath2(import.meta.url));
      if (p.bools.has("list")) {
        if (!existsSync19(resolve8(dir))) {
          process.stderr.write(`ultrasearch orchestrate: run dir not found: ${resolve8(dir)}
`);
          process.exit(2);
        }
        process.stdout.write(JSON.stringify({ phases: listPhasesFor(dir, engineAbs) }, null, 2) + "\n");
        return;
      }
      const res = emitOrchestration(dir, engineAbs, {
        phase: p.values.phase,
        eco: p.bools.has("eco"),
        // Only an EXPLICIT flag is carried into the gatherers' commands; each
        // gather otherwise resolves its own default, in its own environment.
        ...p.values.browser === void 0 ? {} : { browser: oneOf2("browser", p.values.browser, ALL_BROWSER_MODES) }
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
        lines.push(`Follow ${join28(resolve8(dir), "orchestration", "RUNBOOK.md")} sequentially (the eco path).`);
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
        const uninstall = closeBrowserOnSignal();
        try {
          await runStdioServer(ultrasearchAdapter(options), options);
        } finally {
          uninstall();
          await closeBrowserReads({ waitMs: 0 });
        }
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
          void closeBrowserReads({ waitMs: 0 }).then(() => running.close()).finally(() => process.exit(0));
        });
      }
      await new Promise((resolve9) => running.server.once("close", resolve9));
      return;
    }
    case "check": {
      const dir = p.values.run ?? p.values.out;
      if (!dir) fail("missing --run <dossier-dir>");
      const minSources = p.values["min-sources"] ? num4("min-sources", p.values["min-sources"], 1) : void 0;
      const res = runCheck(resolve8(dir), {
        semantic: p.bools.has("semantic"),
        requireVerify: p.bools.has("require-verify"),
        strictNumerals: p.bools.has("strict-numerals"),
        failOnWall: p.bools.has("fail-on-wall"),
        minSources
      });
      if (p.bools.has("json")) {
        process.stdout.write(JSON.stringify(res, null, 2) + "\n");
      } else {
        process.stdout.write(formatCheckReport(res, resolve8(dir)) + "\n");
      }
      if (!res.ok) process.exit(1);
      return;
    }
    case "drop": {
      const dir = p.values.run ?? p.values.out;
      if (!dir) fail("missing --run <dossier-dir>");
      const where = p.values.where === void 0 ? void 0 : oneOf2("where", p.values.where, DROP_WHERE);
      const ids = p.values.id ? parseList(p.values.id) : [];
      if (!ids.length && !where) fail("drop: pass --id <S#,...> or --where wall|snippet|offtopic");
      const r = dropSources(resolve8(dir), { ids, where, dryRun: p.bools.has("dry-run") });
      if (p.bools.has("json")) process.stdout.write(JSON.stringify(r, null, 2) + "\n");
      else process.stdout.write(formatDropReport(r) + "\n");
      if (r.missing.length) process.exitCode = 1;
      return;
    }
    case "relink": {
      const dir = p.values.run ?? p.values.out;
      if (!dir) fail("missing --run <dossier-dir>");
      const rdir = resolve8(dir);
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
function invokedAsThisModule() {
  const argv1 = process.argv[1];
  if (argv1 === void 0) return false;
  const modulePath = fileURLToPath2(import.meta.url);
  try {
    if (realpathSync4(argv1) === realpathSync4(modulePath)) return true;
  } catch {
  }
  return import.meta.url === pathToFileURL2(argv1).href;
}
if (invokedAsThisModule()) {
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
  browserMode,
  buildGatherOptions,
  gatherReport,
  main,
  parseCli,
  parseShardArgs,
  readWebResultsPayload,
  resolveApplyPaths
};
