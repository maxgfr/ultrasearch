import type { BackendKind, Depth, RawSource, SourceMeta } from "./types.js";

// URL identity, keyword extraction and matching, the FNV hash — and, since
// webindex v1.13, the whole RANKING layer — live in the vendored engine. They
// were the same code written two or three times across this repo, construct and
// ultradoc, drifting apart in each: `rrf` was byte-identical in two of them,
// BM25 existed here in full and in ultradoc reduced, and `slugify` had three
// versions that disagreed about length and normalisation, which for an on-disk
// cache key means one repository under three names.
//
// Re-exported from here so every existing `from "./util.js"` keeps working —
// not one call site changed when 427 lines left this file.
//
// What remains below is the part that is genuinely ultrasearch's: identity and
// trust keyed on ITS evidence model, query planning, and the dossier-shaped
// helpers. The engine ranks; it does not know what a source is.
import { canonicalizeUrl, keywords, normalizeDoi, rankedKeywords, arxivIdFromUrl, doiFromUrl } from "./engine.js";

export {
  escapeRegExp,
  canonicalizeUrl,
  normalizeDoi,
  domainOf,
  LOCAL_FILE_DOMAIN,
  fnv1a64,
  keywords,
  rankedKeywords,
  deaccent,
  foldTerm,
  subtokens,
  expandTokens,
  accentPattern,
  buildMatcher,
  type KeywordVariant,
  type ExpandedKeyword,
  isStopword,
  type KeywordMatcher,
  // Ranking, as of webindex v1.13.
  slugify,
  dedupeByUrl,
  rrf,
  arxivIdFromUrl,
  doiFromUrl,
  contentCoverage,
  type Bm25Doc,
  type Bm25Index,
  bm25Tokenize,
  buildBm25Index,
  bm25MatchedTerms,
  applyRelevanceFloor,
  bm25Score,
  recencyScore,
  simhash,
  hammingDistance,
  diversify,
  dedupeNearDuplicates,
  mapLimit,
} from "./engine.js";

// A plain-text payload (an E-utilities abstract, a .txt spec) has no <title>,
// and the endpoint URL is a useless stand-in for one. Take the document's first
// real paragraph — skipping the bibliographic line a record often opens with
// ("1. Ophthalmology. 2020 Sep;127(9):1234-58. doi: …").
export function titleFromText(text: string): string {
  // A leading markdown heading (Firecrawl's output, a rendered extract) is
  // already the document's own name — take it verbatim.
  const heading = /^\s*#{1,6}\s+(.+?)\s*#*\s*$/m.exec(text.split(/\n\s*\n/)[0] ?? "");
  if (heading) return heading[1]!.trim().slice(0, 200);
  const paras = text
    .split(/\n\s*\n/)
    .map((p) => p.replace(/\s+/g, " ").trim())
    .filter(Boolean);
  const lead = paras[0] ?? "";
  const bibliographic = /^\d+\.\s/.test(lead) && /\bdoi:|\bepub\b|\d{4}\s+\w{3}\b/i.test(lead);
  const pick = (bibliographic ? paras[1] : lead) || lead;
  return pick.slice(0, 200) || text.trim().replace(/\s+/g, " ").slice(0, 200);
}

// Shell-single-quote a value for the command lines `orchestrate` emits (the
// free-text question and every path). Single quotes are the only POSIX shell
// context with zero expansion — backticks, `$`, `|`, `;` all stay literal.
// Embedded single quotes close/reopen the quoting (' → '"'"'); newlines are
// collapsed to spaces so an emitted command line stays one line.
export function shq(s: string): string {
  return `'${s.replace(/\r?\n/g, " ").replaceAll("'", `'"'"'`)}'`;
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

// Provenance floor — how much a source is trusted for the ROUTE it arrived by.
//
// This is deliberately the only trust table left, and it is a statement about
// THIS TOOL'S OWN plumbing, not about the web: a record handed over by arXiv's
// API is a bibliographic record by construction, while a page a scraper found
// is an arbitrary page. There used to be a second table here scoring hostnames
// — .gov, the spec bodies, the doc hosts, the content farms — and it was
// deleted on purpose. A frozen list of "good sites" is unmaintainable and was
// measurably wrong: it scored the WHATWG HTML Standard, the normative
// specification for the subject under research, exactly the same as a content
// farm, because nobody had added whatwg.org to it. Every list has that failure
// waiting in it.
//
// Authority now comes from two places that need no list: structural signals
// computed from the document itself (src/authority.ts), and the reading agent,
// which sees every extract and is far better at "is this a source of record?"
// than any regex could be.
const BACKEND_TRUST: Partial<Record<BackendKind, number>> = {
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
  file: 0.5,
};

// Neutral prior for a source whose route says nothing about it — every page a
// general-web engine found. It is a deliberate 0.5 rather than 0: the tool has
// NO opinion on an arbitrary page, and pretending otherwise is what the deleted
// hostname table did.
const NEUTRAL_TRUST = 0.5;

/**
 * Provenance trust, 0..1: how much the ROUTE a source arrived by vouches for it.
 * Never a judgment about the page — that is the agent's, made from the text.
 *
 * `url` is kept in the signature because callers legitimately have it and a
 * future route-based rule may need it (a DOI resolver, say); it is deliberately
 * NOT inspected for hostnames.
 */
export function trustScore(_url: string, backend: BackendKind): number {
  return Number(Math.max(NEUTRAL_TRUST, BACKEND_TRUST[backend] ?? 0).toFixed(2));
}

// ---------------------------------------------------------------------------
// Keyword extraction + matching (ported from ultradoc): used to score fetched
// page text against the question so excerpts carry the relevant lines.
// Lowercase, drop stopwords (EN + FR question scaffolding), keep identifiers,
// fold accents/plurals, split camelCase/snake_case, compile accent-insensitive
// patterns. Deterministic, no LLM, no deps.
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// SimHash near-duplicate detection. Identity dedup (DOI/arXiv/URL, see
// identityKey + fuse) collapses the *same* resource; this catches the same
// CONTENT syndicated across different URLs/domains (mirrored articles, scraper
// copies) that would otherwise each eat a source slot. 64-bit, deterministic.
// ---------------------------------------------------------------------------

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

/**
 * This repo's slug policy, passed explicitly at every call site.
 *
 * The engine's `slugify` is deliberately unopinionated: length and the
 * empty-input fallback are the CALLER's, because a repository identity and a
 * research question want different ones — 120 characters is right for
 * `github.com/owner/repo` and truncates two distinct questions onto one
 * directory. ultrasearch slugs questions, so 80 with a `run` fallback, which is
 * what its own copy did before the engine owned the implementation.
 */
export const RUN_SLUG = { max: 80, fallback: "run" } as const;
