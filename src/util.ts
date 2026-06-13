import type { BackendKind, RawSource } from "./types.js";

// Truncate a string to a max length with an ellipsis marker, for snippets.
export function clip(s: string, max: number): string {
  if (s.length <= max) return s;
  return s.slice(0, max) + `\n… [truncated ${s.length - max} chars]`;
}

// Escape a string for safe inclusion as a literal inside a RegExp.
export function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// Turn an arbitrary identifier into a filesystem-safe slug, e.g.
// "How does HTTP rate limiting work?" -> "how-does-http-rate-limiting-work".
export function slugify(input: string): string {
  return input
    .toLowerCase()
    .replace(/^https?:\/\//, "")
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80) || "run";
}

// Two-digit zero pad for the readable run id.
function pad(n: number): string {
  return String(n).padStart(2, "0");
}

// Readable run id used for the default output folder: run-YYYYMMDD-HHMMSS.
export function runId(d: Date = new Date()): string {
  return (
    `run-${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}` +
    `-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`
  );
}

// ---------------------------------------------------------------------------
// URL canonicalization, deduplication, and trust scoring.
// ---------------------------------------------------------------------------

const TRACKING_PARAMS = /^(utm_|fbclid$|gclid$|mc_|ref$|ref_src$|ref_url$|spm$|_hsenc$|_hsmi$|igshid$)/i;

// Canonical form of a URL for deduplication: lowercase host, drop the fragment
// and tracking query params, drop a default port, strip a trailing slash. Path
// case is preserved logically but lowercased for the dedupe key since most
// content URLs are case-insensitive in practice. Falls back to the lowercased
// input when the URL can't be parsed.
export function canonicalizeUrl(raw: string): string {
  try {
    const u = new URL(raw.trim());
    u.hash = "";
    u.hostname = u.hostname.toLowerCase().replace(/^www\./, "");
    u.pathname = u.pathname.replace(/\/+$/, "");
    if ((u.protocol === "http:" && u.port === "80") || (u.protocol === "https:" && u.port === "443")) {
      u.port = "";
    }
    const keep: [string, string][] = [];
    for (const [k, v] of u.searchParams) {
      if (!TRACKING_PARAMS.test(k)) keep.push([k, v]);
    }
    keep.sort((a, b) => a[0].localeCompare(b[0]));
    u.search = keep.length ? "?" + keep.map(([k, v]) => `${k}=${v}`).join("&") : "";
    let out = u.toString().toLowerCase();
    out = out.replace(/\/$/, "");
    return out;
  } catch {
    return raw.trim().toLowerCase().replace(/#.*$/, "").replace(/\/$/, "");
  }
}

// Bare hostname of a URL (no leading www), or "" when unparseable.
export function domainOf(raw: string): string {
  try {
    return new URL(raw).hostname.toLowerCase().replace(/^www\./, "");
  } catch {
    return "";
  }
}

// Backend authority floor — how much a source is trusted purely for where it
// came from, before domain class is considered.
const BACKEND_TRUST: Partial<Record<BackendKind, number>> = {
  arxiv: 0.9,
  crossref: 0.9,
  openalex: 0.9,
  semanticscholar: 0.9,
  wikipedia: 0.85,
  github: 0.8,
  stackexchange: 0.72,
  hackernews: 0.5,
};

// Domain-class heuristic. Authoritative TLDs and official-docs hosts score
// high; SEO/aggregator domains score low; everything else is neutral.
function domainTrust(domain: string): number {
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

// Combined 0..1 trust for a source: the better of its backend floor and its
// domain class, lightly rounded.
export function trustScore(url: string, backend: BackendKind): number {
  const d = domainTrust(domainOf(url));
  const b = BACKEND_TRUST[backend] ?? 0;
  return Number(Math.max(d, b).toFixed(2));
}

// Drop duplicate sources by canonical URL, keeping the best-scored copy (ties
// broken by the earlier item). Preserves input order of survivors.
export function dedupeByUrl(items: RawSource[]): { items: RawSource[]; dropped: number } {
  const best = new Map<string, RawSource>();
  const order: string[] = [];
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
  return { items: order.map((k) => best.get(k)!), dropped };
}

// ---------------------------------------------------------------------------
// Keyword extraction + matching (ported from ultradoc): used to score fetched
// page text against the question so excerpts carry the relevant lines.
// Lowercase, drop stopwords (EN + FR question scaffolding), keep identifiers,
// fold accents/plurals, split camelCase/snake_case, compile accent-insensitive
// patterns. Deterministic, no LLM, no deps.
// ---------------------------------------------------------------------------

const STOPWORDS = new Set([
  "the","a","an","is","are","was","were","be","been","being","do","does","did","how","what",
  "why","when","where","which","who","whom","this","that","these","those","of","in","on","to",
  "for","with","and","or","but","if","then","else","than","as","at","by","from","into","about",
  "it","its","i","you","we","they","he","she","there","here","can","could","should","would",
  "will","shall","may","might","must","have","has","had","not","no","yes","so","such","only",
  "any","some","all","get","set","use","used","using","work","works","working","handle","handled",
  "happen","happens","default","value","values","please","explain","tell","me","my","our",
  "le","la","les","de","des","du","un","une","est","sont","que","qui","quoi","quel","quelle",
  "quels","quelles","pour","dans","avec","entre","sur","par","pas","plus","et","ou","où","ce",
  "cette","ces","se","sa","son","ses","leur","leurs","comment","pourquoi","quand","fait","faire",
  "peut","doit","être","avoir","il","elle","nous","vous","ils","elles","au","aux","si","ne",
]);

export function keywords(question: string): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
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

// Keywords ordered most-distinctive first (numbers, identifiers, long tokens
// carry more signal). Useful to feed narrow search APIs the few best terms.
export function rankedKeywords(question: string): string[] {
  const base = keywords(question);
  const score = (raw: string): number => {
    let s = 0;
    if (/\d/.test(raw)) s += 3;
    if (/[A-Z]/.test(raw) && !/^[A-Z0-9]+$/.test(raw)) s += 2;
    if (/_/.test(raw)) s += 2;
    if (raw.length >= 8) s += 1.5;
    else if (raw.length >= 5) s += 0.5;
    return s;
  };
  return base
    .map((k, i) => ({ k, s: score(k), i }))
    .sort((a, b) => b.s - a.s || a.i - b.i)
    .map((x) => x.k);
}

const ACCENT_CLASSES: Record<string, string> = {
  a: "aàáâãäåāăą",
  c: "cçćĉċč",
  d: "dďđ",
  e: "eèéêëēĕėęě",
  g: "gĝğġģ",
  i: "iìíîïĩīĭįı",
  l: "lĺļľŀł",
  n: "nñńņň",
  o: "oòóôõöøōŏő",
  r: "rŕŗř",
  s: "sśŝşš",
  t: "tţťŧ",
  u: "uùúûüũūŭůűų",
  y: "yýÿŷ",
  z: "zźżž",
};
const BASE_OF = new Map<string, string>();
for (const [base, cls] of Object.entries(ACCENT_CLASSES)) {
  for (const ch of cls) BASE_OF.set(ch, base);
}

function baseChar(ch: string): string {
  const known = BASE_OF.get(ch);
  if (known) return known;
  const stripped = ch.normalize("NFD").replace(/\p{M}+/gu, "");
  return stripped.length === 1 ? stripped : ch;
}

export function deaccent(s: string): string {
  let out = "";
  for (const ch of s) out += baseChar(ch);
  return out;
}

function foldPlural(t: string): string {
  if (t.length > 4 && t.endsWith("ies")) return t.slice(0, -3) + "y";
  if (t.length > 4 && /(?:[sxz]|[cs]h)es$/.test(t)) return t.slice(0, -2);
  if (t.length > 3 && t.endsWith("s") && !/(?:ss|us|is)$/.test(t)) return t.slice(0, -1);
  return t;
}

export function foldTerm(raw: string): string {
  return foldPlural(deaccent(raw.toLowerCase()));
}

export function subtokens(raw: string): string[] {
  const spaced = raw
    .replace(/([\p{Ll}\p{N}])(\p{Lu})/gu, "$1 $2")
    .replace(/(\p{Lu}+)(\p{Lu}\p{Ll})/gu, "$1 $2")
    .replace(/(\p{L})(\p{N})/gu, "$1 $2")
    .replace(/(\p{N})(\p{L})/gu, "$1 $2");
  const parts = spaced.split(/[^\p{L}\p{N}]+/u).filter(Boolean);
  if (parts.length < 2) return [];
  const out: string[] = [];
  for (const p of parts) {
    const lower = p.toLowerCase();
    if (lower.length < 3 || STOPWORDS.has(lower)) continue;
    if (!out.includes(lower)) out.push(lower);
    if (out.length >= 4) break;
  }
  return out;
}

export interface KeywordVariant {
  text: string;
  kind: "original" | "folded" | "subtoken";
}

export interface ExpandedKeyword {
  canonical: string;
  original: string;
  variants: KeywordVariant[];
}

const MAX_PATTERNS = 24;
const VARIANT_PRIORITY: Record<KeywordVariant["kind"], number> = { original: 0, folded: 1, subtoken: 2 };

export function expandTokens(tokens: string[], max = 8): ExpandedKeyword[] {
  const byCanonical = new Map<string, ExpandedKeyword>();
  for (const raw of tokens) {
    if (byCanonical.size >= max) break;
    const canonical = foldTerm(raw);
    if (!canonical || byCanonical.has(canonical)) continue;
    const plain = deaccent(raw.toLowerCase());
    const variants: KeywordVariant[] = [{ text: raw.toLowerCase(), kind: "original" }];
    if (canonical !== plain) variants.push({ text: canonical, kind: "folded" });
    if (plain.length > 4 && plain.endsWith("ies")) variants.push({ text: plain.slice(0, -1), kind: "folded" });
    for (const sub of subtokens(raw)) variants.push({ text: sub, kind: "subtoken" });
    byCanonical.set(canonical, { canonical, original: raw, variants });
  }
  const all = [...byCanonical.values()].flatMap((ek, kwIdx) =>
    ek.variants.map((v) => ({ ek, v, kwIdx })),
  );
  all.sort((a, b) => VARIANT_PRIORITY[a.v.kind] - VARIANT_PRIORITY[b.v.kind] || a.kwIdx - b.kwIdx);
  const seen = new Set<string>();
  const kept = new Set<KeywordVariant>();
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

export function accentPattern(text: string): string {
  let out = "";
  for (const ch of text) {
    const cls = ACCENT_CLASSES[baseChar(ch)];
    out += cls ? `[${cls}]` : escapeRegExp(ch);
  }
  return out;
}

export interface KeywordMatcher {
  expanded: ExpandedKeyword[];
  canonicals: string[];
  matchLine(line: string): Set<string>;
}

function makeMatcher(expanded: ExpandedKeyword[]): KeywordMatcher {
  const regexes: { re: RegExp; canonical: string }[] = [];
  for (const ek of expanded) {
    for (const v of ek.variants) {
      regexes.push({ re: new RegExp(accentPattern(v.text), "i"), canonical: ek.canonical });
    }
  }
  return {
    expanded,
    canonicals: expanded.map((e) => e.canonical),
    matchLine: (line) => {
      const hit = new Set<string>();
      for (const { re, canonical } of regexes) {
        if (!hit.has(canonical) && re.test(line)) hit.add(canonical);
      }
      return hit;
    },
  };
}

export function buildMatcher(question: string, max = 8): KeywordMatcher {
  return makeMatcher(expandTokens(keywords(question), max));
}

// Reciprocal Rank Fusion: merge several ranked lists into one robust ranking
// without comparable cross-list scores. `k` damps low ranks.
export function rrf<T>(lists: T[][], keyOf: (item: T) => string, k = 60): Map<string, number> {
  const score = new Map<string, number>();
  for (const list of lists) {
    list.forEach((item, idx) => {
      const key = keyOf(item);
      score.set(key, (score.get(key) ?? 0) + 1 / (k + idx + 1));
    });
  }
  return score;
}
