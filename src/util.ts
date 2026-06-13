import type { BackendKind, Depth, RawSource } from "./types.js";

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

// Canonical form of a URL for deduplication. Lowercases ONLY scheme + host
// (paths and query values are case-sensitive — github.com/Microsoft/TypeScript
// is not github.com/microsoft/typescript, and YouTube ?v= ids are case-bearing).
// Drops the fragment, tracking params and default port, sorts the remaining
// query params, re-encodes their values (so an encoded '&' in a value isn't
// turned into a delimiter), and strips a trailing slash. Built from components
// rather than URL.toString().toLowerCase().
export function canonicalizeUrl(raw: string): string {
  try {
    const u = new URL(raw.trim());
    const proto = u.protocol.toLowerCase();
    const host = u.hostname.toLowerCase().replace(/^www\./, "");
    let port = u.port;
    if ((proto === "http:" && port === "80") || (proto === "https:" && port === "443")) port = "";
    const path = u.pathname.replace(/\/+$/, ""); // case preserved
    const keep: [string, string][] = [];
    for (const [k, v] of u.searchParams) {
      if (!TRACKING_PARAMS.test(k)) keep.push([k, v]);
    }
    keep.sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
    const search = keep.length
      ? "?" + keep.map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`).join("&")
      : "";
    return `${proto}//${host}${port ? ":" + port : ""}${path}${search}`.replace(/\/$/, "");
  } catch {
    return raw.trim().replace(/#.*$/, "").replace(/\/$/, "");
  }
}

// Normalize a DOI to a bare lowercase identifier (strip any doi.org prefix) so
// the same work cited as a DOI URL and a bare DOI dedupes to one key.
export function normalizeDoi(doi: string): string {
  return doi.trim().toLowerCase().replace(/^https?:\/\/(dx\.)?doi\.org\//, "");
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
  europepmc: 0.9,
  pubmed: 0.9,
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

// Identity key for de-duplication that is stronger than URL: the same work
// surfaced as an arXiv abstract, a DOI URL and a journal landing page (across
// arxiv/crossref/openalex/semanticscholar) collapses to one key so it doesn't
// eat several source slots. Falls back to canonical URL.
export function identityKey(item: RawSource): string {
  const doi = item.meta?.doi;
  if (doi) return "doi:" + normalizeDoi(String(doi));
  const arxiv = item.meta?.arxivId;
  if (arxiv) return "arxiv:" + String(arxiv).toLowerCase().replace(/v\d+$/, "");
  return canonicalizeUrl(item.url);
}

// Pull distinctive identifiers out of a question — versions (v1.2.3), status
// codes / years (3+ digits), CamelCase / snake_case symbols, DOIs, arXiv ids,
// and quoted spans — to drive an identifier-focused query variant.
export function extractIdentifiers(question: string): string[] {
  const out = new Set<string>();
  const add = (re: RegExp, group = 0) => {
    for (const m of question.matchAll(re)) {
      const v = (m[group] ?? m[0]).trim();
      if (v) out.add(v);
    }
  };
  add(/\bv?\d+(?:\.\d+){1,}\b/g); // versions
  add(/\b10\.\d{4,}\/\S+/g); // DOI
  add(/\b\d{4}\.\d{4,5}(?:v\d+)?\b/g); // arXiv id
  add(/\b[a-z]+(?:[A-Z][a-z0-9]+)+\b/g); // camelCase
  add(/\b[A-Za-z]+_[A-Za-z0-9_]+\b/g); // snake_case
  add(/\b\d{3,}\b/g); // status codes / years
  add(/"([^"\n]{3,})"/g, 1); // quoted spans
  return [...out];
}

// Plan the query variants a run searches with. variant[0] is the full question
// (good for discovery/semantic backends); then a distinctive-keyword query
// (recall for keyword APIs that otherwise choke on stopwords); then an
// identifier query at deep. Count is gated by depth (summary 1 / standard 2 /
// deep 3) so summary stays cheap.
export function planVariants(question: string, depth: Depth): string[] {
  const base = question.trim();
  const variants: string[] = base ? [base] : [];
  const kw = rankedKeywords(question).slice(0, 8).join(" ");
  if (kw && kw.toLowerCase() !== base.toLowerCase()) variants.push(kw);
  const idents = extractIdentifiers(question);
  if (idents.length) variants.push(idents.join(" "));
  const seen = new Set<string>();
  const uniq: string[] = [];
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

// What fraction of the question's distinctive keywords appear in a body of
// text — used to re-rank fetched candidates by actual content relevance.
export function contentCoverage(matcher: KeywordMatcher, text: string): number {
  if (!matcher.canonicals.length || !text) return 0;
  const hit = new Set<string>();
  for (const line of text.split("\n")) {
    for (const c of matcher.matchLine(line)) hit.add(c);
    if (hit.size === matcher.canonicals.length) break;
  }
  return hit.size / matcher.canonicals.length;
}

// Parse a --since value (any Date-parseable string, e.g. "2023" or
// "2023-01-15") into epoch seconds / an ISO date, for backends with date
// filters. Returns null when absent or unparseable.
export function sinceEpochSeconds(since?: string): number | null {
  if (!since) return null;
  const ms = Date.parse(since.length === 4 ? `${since}-01-01` : since);
  return Number.isFinite(ms) ? Math.floor(ms / 1000) : null;
}
export function sinceDate(since?: string): string | null {
  const secs = sinceEpochSeconds(since);
  return secs === null ? null : new Date(secs * 1000).toISOString().slice(0, 10);
}

// Bounded-concurrency async map (dependency-free) — keeps the hydrate step
// polite (a handful of in-flight fetches) instead of firing dozens at once.
export async function mapLimit<T, R>(
  items: T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, async () => {
    while (true) {
      const idx = next++;
      if (idx >= items.length) break;
      results[idx] = await fn(items[idx]!, idx);
    }
  });
  await Promise.all(workers);
  return results;
}
