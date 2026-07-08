import type { BackendKind, Depth, RawSource, SourceMeta } from "./types.js";

// Escape a string for safe inclusion as a literal inside a RegExp.
export function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// Turn an arbitrary identifier into a filesystem-safe slug, e.g.
// "How does HTTP rate limiting work?" -> "how-does-http-rate-limiting-work".
export function slugify(input: string): string {
  return (
    input
      .toLowerCase()
      .replace(/^https?:\/\//, "")
      .replace(/[^a-z0-9._-]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 80) || "run"
  );
}

// Two-digit zero pad for the readable run id.
function pad(n: number): string {
  return String(n).padStart(2, "0");
}

// Readable run id used for the default output folder: run-YYYYMMDD-HHMMSS.
export function runId(d: Date = new Date()): string {
  return `run-${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}` + `-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
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
    const search = keep.length ? "?" + keep.map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`).join("&") : "";
    return `${proto}//${host}${port ? ":" + port : ""}${path}${search}`.replace(/\/$/, "");
  } catch {
    return raw.trim().replace(/#.*$/, "").replace(/\/$/, "");
  }
}

// Normalize a DOI to a bare lowercase identifier (strip any doi.org prefix) so
// the same work cited as a DOI URL and a bare DOI dedupes to one key.
export function normalizeDoi(doi: string): string {
  return doi
    .trim()
    .toLowerCase()
    .replace(/^https?:\/\/(dx\.)?doi\.org\//, "");
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
  dblp: 0.9,
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
  // Major vendor / standards doc hosts — primary sources for their own products.
  if (
    /(^|\.)(learn\.microsoft\.com|docs\.aws\.amazon\.com|cloud\.google\.com|developer\.mozilla\.org|kubernetes\.io|docs\.docker\.com|docs\.github\.com|rfc-editor\.org|datatracker\.ietf\.org)$/.test(
      domain,
    )
  )
    return 0.9;
  if (/(readthedocs\.io|docs\.|developer\.|\.dev$)/.test(domain)) return 0.82;
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
  "où",
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
  "être",
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
  const all = [...byCanonical.values()].flatMap((ek, kwIdx) => ek.variants.map((v) => ({ ek, v, kwIdx })));
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

// Pull an arXiv id out of a URL — so abs/pdf/html variants of the SAME paper
// (surfaced by a web backend with no `meta.arxivId`) still collapse to one key.
// Handles modern ids (2405.12345) and legacy ids (math.GT/0309136), any
// arxiv.org subdomain, and strips the version suffix and a trailing .pdf.
export function arxivIdFromUrl(url: string): string | undefined {
  let host: string;
  let path: string;
  try {
    const u = new URL(url.trim());
    host = u.hostname.toLowerCase();
    path = u.pathname;
  } catch {
    return undefined;
  }
  if (!/(^|\.)arxiv\.org$/.test(host)) return undefined;
  const modern = /\/(?:abs|pdf|html|format)\/(\d{4}\.\d{4,5})(?:v\d+)?(?:\.pdf)?$/i.exec(path);
  if (modern) return modern[1]!.toLowerCase();
  const legacy = /\/(?:abs|pdf|html|format)\/([a-z-]+(?:\.[A-Z]{2})?\/\d{7})(?:v\d+)?(?:\.pdf)?$/i.exec(path);
  if (legacy) return legacy[1]!.toLowerCase();
  return undefined;
}

// Pull a DOI out of a URL — doi.org resolver links AND publisher landing pages
// that carry the DOI in their path (dl.acm.org/doi/…, /doi/full/…, /doi/pdf/…).
// Returns the normalized DOI so a DOI-in-path collapses with a bare DOI.
export function doiFromUrl(url: string): string | undefined {
  let host: string;
  let path: string;
  try {
    const u = new URL(url.trim());
    host = u.hostname.toLowerCase();
    path = u.pathname;
  } catch {
    return undefined;
  }
  if (/(^|\.)(dx\.)?doi\.org$/.test(host)) {
    const doi = normalizeDoi(decodeURIComponent(path.replace(/^\/+/, "").replace(/\/+$/, "")));
    return /^10\.\d{4,9}\//.test(doi) ? doi : undefined;
  }
  const m = /\/doi(?:\/(?:abs|full|pdf|epdf|e?pub))?\/(10\.\d{4,9}\/[^\s?#]+)/i.exec(path);
  if (m) return normalizeDoi(decodeURIComponent(m[1]!).replace(/\/+$/, ""));
  return undefined;
}

// Identity key for de-duplication that is stronger than URL: the same work
// surfaced as an arXiv abstract, a DOI URL and a journal landing page (across
// arxiv/crossref/openalex/semanticscholar) collapses to one key so it doesn't
// eat several source slots. Prefers backend metadata, then falls back to
// identifiers parsed out of the URL itself, then the canonical URL.
export function identityKey(item: RawSource): string {
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
  // Lower-priority candidates (only reached at deeper depths / when earlier ones
  // are absent, so pinned counts stay 1/2/3): a quoted exact-phrase of the lead
  // content words (phrase recall), and a head-noun + identifiers query.
  const ordered = keywords(question);
  if (ordered.length >= 2) variants.push(`"${ordered.slice(0, 4).join(" ")}"`);
  if (idents.length && ordered.length) variants.push([ordered[0], ...idents].join(" "));
  const seen = new Set<string>();
  const uniq: string[] = [];
  for (const v of variants) {
    const key = v.toLowerCase();
    if (v && !seen.has(key)) {
      seen.add(key);
      uniq.push(v);
    }
  }
  // Deterministic-planner cap: 1/2/3 by depth — deliberately LOWER than the
  // agent-supplied --queries cap (2/4/6, see resolveVariants in gather.ts),
  // since regex-planned variants are lower-signal than an agent's own phrasings.
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

// ---------------------------------------------------------------------------
// BM25F lexical relevance — the content-aware re-ranking signal. Scores a
// fetched document against the question with TF saturation + IDF computed over
// the candidate pool, field weighting (title > headings > body, via token
// duplication) and a bounded phrase-proximity bonus. Deterministic, zero-dep.
// Replaces the old binary keyword coverage for re-ranking because it (a)
// resists keyword-stuffing — a single term's contribution saturates at k1 —
// and (b) rewards covering more *distinct* query terms. `contentCoverage`
// above is kept for snippet selection and back-compat.
// ---------------------------------------------------------------------------

export interface Bm25Doc {
  id: string;
  title: string;
  headings: string;
  body: string;
}

export interface Bm25Index {
  idf: Map<string, number>;
  avgdl: number;
  N: number;
  queryTerms: string[];
  k1: number;
  b: number;
  titleWeight: number;
  headingWeight: number;
}

// Tokenize text into canonical (deaccented, plural-folded, stopword-free) terms
// WITH repetition so term frequency is preserved. Uses the same `foldTerm`
// canonicalization as `buildMatcher`, so the two scorers agree on what a term
// is (e.g. "requests" and "request" collapse, accents are folded).
export function bm25Tokenize(text: string): string[] {
  if (!text) return [];
  const out: string[] = [];
  for (const raw of text.split(/[^\p{L}\p{N}_]+/u)) {
    if (raw.length < 2) continue;
    if (STOPWORDS.has(raw.toLowerCase())) continue;
    const t = foldTerm(raw);
    if (t.length >= 2) out.push(t);
  }
  return out;
}

// Field-weighted token stream: body once, heading terms `headingWeight`× and
// title terms `titleWeight`× — so a query term in the title/headings carries
// more weight than the same term buried in the body.
function docTokens(doc: Bm25Doc, titleWeight: number, headingWeight: number): string[] {
  const out = bm25Tokenize(doc.body);
  const headings = bm25Tokenize(doc.headings);
  for (let r = 0; r < headingWeight; r++) out.push(...headings);
  const title = bm25Tokenize(doc.title);
  for (let r = 0; r < titleWeight; r++) out.push(...title);
  return out;
}

// Bounded phrase-proximity bonus in [0, cap]: rewards query terms that occur
// close together in the field-weighted token stream (so "token bucket" adjacent
// beats the two words scattered far apart). Returns a multiplier addend.
function proximityBonus(tokens: string[], queryTerms: string[], window = 6, cap = 0.1): number {
  if (queryTerms.length < 2) return 0;
  const q = new Set(queryTerms);
  const hits: { pos: number; term: string }[] = [];
  for (let i = 0; i < tokens.length; i++) {
    const tok = tokens[i]!;
    if (q.has(tok)) hits.push({ pos: i, term: tok });
  }
  if (hits.length < 2) return 0;
  let close = 0;
  for (let i = 1; i < hits.length; i++) {
    if (hits[i]!.term !== hits[i - 1]!.term && hits[i]!.pos - hits[i - 1]!.pos <= window) close++;
  }
  return Math.min(cap, cap * (close / Math.max(1, queryTerms.length - 1)));
}

// Build the BM25 index over the candidate pool: IDF per query term (the pool IS
// the corpus), average field-weighted document length, and the distinct query
// terms. On a tiny pool (N<3) IDF is too noisy to trust, so it degrades to a
// uniform IDF (pure TF scoring).
export function buildBm25Index(question: string, docs: Bm25Doc[], opts: { k1?: number; b?: number } = {}): Bm25Index {
  const k1 = opts.k1 ?? 1.2;
  const b = opts.b ?? 0.75;
  const titleWeight = 3;
  const headingWeight = 2;
  const queryTerms = [...new Set(bm25Tokenize(question))];
  const N = docs.length;
  const df = new Map<string, number>();
  let totalLen = 0;
  for (const doc of docs) {
    const toks = docTokens(doc, titleWeight, headingWeight);
    totalLen += toks.length;
    for (const t of new Set(toks)) df.set(t, (df.get(t) ?? 0) + 1);
  }
  const avgdl = N ? totalLen / N : 0;
  const idf = new Map<string, number>();
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

// The distinct query terms that actually occur in a document's field-weighted
// token stream — the overlap signal the relevance floor keys on (empty overlap
// or an all-numeric overlap ⇒ off-topic). Shares tokenization with bm25Score so
// the two agree on what a term is.
export function bm25MatchedTerms(index: Bm25Index, doc: Bm25Doc): string[] {
  if (!index.queryTerms.length) return [];
  const present = new Set(docTokens(doc, index.titleWeight, index.headingWeight));
  return index.queryTerms.filter((t) => present.has(t));
}

// Off-topic filter for the ranked candidate pool. A candidate is off-topic when
// its query-term overlap is EMPTY (the "Venezuelan sanctions" class) or matched
// ONLY on numeric terms (a year / PR-number false friend like a GitHub PR whose
// number shares digits with the query). Only active when the query has ≥2 terms
// including ≥1 alphabetic one — a single-term or all-numeric query has too weak
// a signal to filter on. NEVER drops below `floor`: if dropping would leave
// fewer than the floor, the highest-ranked "off-topic" ones are kept (a thin
// genuine pool must survive its own filter). `ranked` must be best-first.
export function applyRelevanceFloor<T>(ranked: T[], matchedOf: (t: T) => string[], queryTerms: string[], floor: number): { kept: T[]; dropped: T[] } {
  const isAlpha = (t: string) => /\p{L}/u.test(t);
  const alphaTerms = queryTerms.filter(isAlpha);
  if (queryTerms.length < 2 || alphaTerms.length < 1) return { kept: ranked, dropped: [] };
  const offTopic = (t: T): boolean => {
    const m = matchedOf(t);
    return m.length === 0 || m.every((term) => !isAlpha(term));
  };
  const kept: T[] = [];
  const dropped: T[] = [];
  for (const t of ranked) (offTopic(t) ? dropped : kept).push(t);
  // Safety valve: never leave fewer than `floor`. Re-admit the best-ranked
  // dropped candidates (they were appended in best-first order) until met.
  while (kept.length < floor && dropped.length) kept.push(dropped.shift()!);
  return { kept, dropped };
}

// BM25F score of one document against the index (raw, ≥0). Callers normalize by
// the pool max (see gather.ts) the same way fusion rank is normalized.
export function bm25Score(index: Bm25Index, doc: Bm25Doc): number {
  if (!index.queryTerms.length) return 0;
  const toks = docTokens(doc, index.titleWeight, index.headingWeight);
  const dl = toks.length;
  if (!dl) return 0;
  const tf = new Map<string, number>();
  for (const t of toks) tf.set(t, (tf.get(t) ?? 0) + 1);
  const { k1, b, avgdl } = index;
  const lenNorm = 1 - b + b * (avgdl ? dl / avgdl : 1);
  let score = 0;
  for (const term of index.queryTerms) {
    const f = tf.get(term);
    if (!f) continue;
    const idf = index.idf.get(term) ?? 0;
    score += (idf * (f * (k1 + 1))) / (f + k1 * lenNorm);
  }
  return score * (1 + proximityBonus(toks, index.queryTerms));
}

// Pool-relative recency in 0..1 (newer = higher), neutral 0.5 when a source
// carries no year or the pool has no year spread. Deliberately relative to the
// result set (not wall-clock) so test/eval ordering stays stable over time.
export function recencyScore(meta: SourceMeta | undefined, minYear: number, maxYear: number): number {
  const y = typeof meta?.year === "number" ? meta.year : undefined;
  if (y === undefined || maxYear <= minYear) return 0.5;
  const clamped = Math.min(maxYear, Math.max(minYear, y));
  return (clamped - minYear) / (maxYear - minYear);
}

// ---------------------------------------------------------------------------
// SimHash near-duplicate detection. Identity dedup (DOI/arXiv/URL, see
// identityKey + fuse) collapses the *same* resource; this catches the same
// CONTENT syndicated across different URLs/domains (mirrored articles, scraper
// copies) that would otherwise each eat a source slot. 64-bit, deterministic.
// ---------------------------------------------------------------------------

const FNV_OFFSET = 0xcbf29ce484222325n;
const FNV_PRIME = 0x100000001b3n;
const MASK64 = (1n << 64n) - 1n;

export function fnv1a64(s: string): bigint {
  let h = FNV_OFFSET;
  for (let i = 0; i < s.length; i++) {
    h ^= BigInt(s.charCodeAt(i));
    h = (h * FNV_PRIME) & MASK64;
  }
  return h;
}

// 64-bit SimHash over 3-gram token shingles: near-duplicate documents land a
// few bits apart, unrelated documents ~32 bits apart.
export function simhash(text: string): bigint {
  const toks = bm25Tokenize(text);
  const shingles: string[] = [];
  if (toks.length < 3) shingles.push(...toks);
  else for (let i = 0; i + 3 <= toks.length; i++) shingles.push(`${toks[i]} ${toks[i + 1]} ${toks[i + 2]}`);
  if (!shingles.length) return 0n;
  const v = new Array<number>(64).fill(0);
  for (const sh of shingles) {
    const h = fnv1a64(sh);
    for (let b = 0; b < 64; b++) v[b]! += ((h >> BigInt(b)) & 1n) === 1n ? 1 : -1;
  }
  let out = 0n;
  for (let b = 0; b < 64; b++) if (v[b]! > 0) out |= 1n << BigInt(b);
  return out;
}

// Population count of the XOR — how many bits two SimHashes differ by.
export function hammingDistance(a: bigint, b: bigint): number {
  let x = a ^ b;
  let count = 0;
  while (x) {
    x &= x - 1n;
    count++;
  }
  return count;
}

function betterSource(a: RawSource, b: RawSource): boolean {
  if (a.score !== b.score) return a.score > b.score;
  return a.url.localeCompare(b.url) < 0;
}

// Collapse near-duplicate sources by SimHash over their extracted text, keeping
// the best-scored copy. Short texts are skipped (too little signal to trust).
// Expects items pre-sorted best-first; preserves their order. Deterministic.
export function dedupeNearDuplicates(items: RawSource[], opts: { maxBits?: number; minChars?: number } = {}): { items: RawSource[]; dropped: number } {
  const maxBits = opts.maxBits ?? 3;
  const minChars = opts.minChars ?? 500;
  const kept: { it: RawSource; hash: bigint | null }[] = [];
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
export async function mapLimit<T, R>(items: T[], limit: number, fn: (item: T, index: number) => Promise<R>): Promise<R[]> {
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
