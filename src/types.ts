// Single source of truth for the version the CLI/bundle reports. Kept in
// lockstep with package.json and SKILL.md by scripts/sync-version.mjs during a
// semantic-release run. Do not edit by hand outside a release.
export const VERSION = "1.19.1";

// Every retrieval backend a run can draw from. Search/discovery backends
// (searxng, duckduckgo) yield candidate URLs the gatherer then fetches;
// content backends (wikipedia, the keyless APIs) yield items that already carry
// text. "generic" fetches an explicit URL; "fixture" is the offline CI backend;
// "claude" is the provenance label for a source the agent added via `fetch`.
// "firecrawl" is a self-hosted Firecrawl instance's keyless /search — an
// EXPLICIT choice only, never part of the `auto` discovery cascade.
export type BackendKind =
  | "searxng"
  | "firecrawl"
  | "duckduckgo"
  | "ddglite"
  | "mojeek"
  | "marginalia"
  | "wikipedia"
  | "stackexchange"
  | "hackernews"
  | "github"
  | "arxiv"
  | "crossref"
  | "openalex"
  | "semanticscholar"
  | "europepmc"
  | "pubmed"
  | "dblp"
  | "standards"
  | "generic"
  | "fixture"
  | "claude";

export const ALL_BACKENDS: readonly BackendKind[] = [
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
  "claude",
];

// The five report shapes. Each maps to a ModeProfile (backend priority +
// template + extras) in src/modes.
export type ModeName = "topic" | "bug" | "research" | "learn" | "startup";
export const ALL_MODES: readonly ModeName[] = ["topic", "bug", "research", "learn", "startup"];

// How far a run fans out. `summary` is a quick survey, `deep` runs every
// backend (including deep-only ones) and keeps the most sources. Tiers
// (SUMMARY/REPORT) are always written regardless of depth — depth caps
// how much retrieval feeds the report.
export type Depth = "summary" | "standard" | "deep";
export const ALL_DEPTHS: readonly Depth[] = ["summary", "standard", "deep"];

// Per-depth retrieval caps, scaled in gather. maxSources/perSource defaults are
// derived from these unless overridden by --max-sources / --per-source.
export const DEPTH_CAPS: Record<Depth, { maxSources: number; perSource: number; deepOnly: boolean }> = {
  summary: { maxSources: 10, perSource: 4, deepOnly: false },
  standard: { maxSources: 25, perSource: 6, deepOnly: false },
  deep: { maxSources: 60, perSource: 10, deepOnly: true },
};

// Recall floor per depth: below this many on-topic sources a dossier is "thin"
// — `gather` records it on the manifest + DOSSIER.md so the agent enriches
// before writing, and `check` warns (or fails with --min-sources). Scaled to the
// depth's target (and clamped to --max-sources) so a quick survey isn't held to a
// deep run's bar.
export const RECALL_FLOORS: Record<Depth, number> = {
  summary: 3,
  standard: 6,
  deep: 12,
};

// A question term is "under-covered" when fewer than this many of the top kept
// sources mention it. Long the private threshold of the `--rounds 2` gap round;
// hoisted here now that EVERY gather reports its coverage map, so the gap round
// and the reported worklist can never disagree about what "under-covered" means.
export const UNDER_COVERED_MIN = 2;

// How many result PAGES each web discovery engine fetches per query (default by
// depth; override with --pages). Page 1 emits the engine's URL unchanged, so a
// 1-page run is byte-identical to before; deeper depths paginate further to pull
// more of the long tail. A backend stops early once a page adds no new URLs.
export const PAGES_PER_DEPTH: Record<Depth, number> = {
  summary: 1,
  standard: 2,
  deep: 3,
};

// How many web discovery engines the `auto` cascade lets satisfy `perSource`
// before it stops (default by depth; override with --web-breadth). At breadth 1
// it short-circuits on the first engine that returns enough (the original, cheap
// behaviour). At higher breadth it keeps querying further engines and FUSES
// their results, widening recall across independent indexes. 5 covers all of
// DISCOVERY. Thin engines (under perSource) are always fused too — recall is
// never lost — they just don't count toward the breadth target.
export const WEB_BREADTH_PER_DEPTH: Record<Depth, number> = {
  summary: 1,
  standard: 2,
  deep: 5,
};

// ---------------------------------------------------------------------------
// Deep-research tier. The agentic orchestration (driven by SKILL.md) that fans
// out one `gather` per sub-question, merges the dossiers, and adversarially
// verifies each claim before synthesis. These are ORCHESTRATION caps that bound
// the long (10–20 min) loop — distinct from Depth, which is a per-`gather`
// retrieval cap. Each sub-question fan-out is itself a `gather --depth deep`.
// ---------------------------------------------------------------------------
// Two of these four are ENFORCED by the engine; two are ADVISORY budget guidance
// for the agent driving the loop. The distinction is load-bearing — docs used to
// claim all four "bound the loop so it can't run away", which was false for the
// advisory pair. Keep the labels honest.
export interface DeepCaps {
  /** ENFORCED by `plan` (cap on the decomposition; `--max-subquestions` overrides). */
  maxSubQuestions: number;
  /** ENFORCED by `verify` (cap on emitted claim↔source pairs; `--max-verify` overrides). */
  maxVerify: number;
  /**
   * ADVISORY. The loop-until-dry cycle is AGENT-driven — no engine step counts
   * rounds, and refusing a 4th `merge` would block a legitimate re-merge after a
   * citation fix. Surfaced as budget guidance in the playbook/RUNBOOK only.
   */
  maxRounds: number;
  /**
   * ADVISORY, and redundant by construction: it equals `DEPTH_CAPS.deep.maxSources`,
   * which a `--depth deep` fan-out gather already resolves to on its own (the
   * equality is pinned by tests/caps.test.ts). Passing it as `--max-sources`
   * would be a no-op.
   */
  perSubQuestionSources: number;
}
export const DEEP_CAPS: DeepCaps = {
  maxSubQuestions: 6,
  maxRounds: 3,
  maxVerify: 40,
  perSubQuestionSources: 60,
};

// One facet of a decomposed question, emitted by `plan`. `queries` are the
// ready-to-use variants to pass straight to `gather --queries`; `facet` records
// where it came from (a mode-template heading, a distinctive keyword, an
// identifier, or the agent's own --subquestions override).
export type SubQuestionFacet = "template" | "keyword" | "identifier" | "agent";
export interface SubQuestion {
  id: string; // "Q1", "Q2", … (parallel to the S# source scheme)
  question: string;
  facet: SubQuestionFacet;
  queries: string[];
  rationale: string;
  out?: string; // suggested fan-out dossier dir (<runRoot>/q1…), set when `plan --run-root` is given
}
export interface PlanResult {
  question: string;
  mode: ModeName;
  /** The requested retrieval depth, persisted into PLAN.json so `orchestrate` emits fan-out gathers at the run's depth (absent on older plans, which were deep-tier only). */
  depth?: Depth;
  subQuestions: SubQuestion[];
}

// Which sub-question(s) surfaced a source — recorded on SourceMeta.provenance by
// `merge` so the enriched render can draw the decomposition tree.
export interface Provenance {
  subQuestion: string;
  runDir: string;
}

// Which keyless discovery engine the web layer uses. "auto" runs a resilient
// fallback cascade (searxng → duckduckgo → ddglite → mojeek → marginalia),
// short-circuiting once one yields enough results; the named engines pin to that
// one; "claude" drops web discovery so the agent drives it via its own WebSearch.
// "firecrawl" is pinnable but deliberately absent from the `auto` cascade — it
// needs a local container stack, and its upstream is the same SearXNG the
// `searxng` engine already queries directly.
// Single source of truth: the CLI validator and --help both derive from this list.
export const ALL_WEB_ENGINES = ["auto", "searxng", "firecrawl", "ddg", "ddglite", "mojeek", "marginalia", "claude"] as const;
export type WebEngine = (typeof ALL_WEB_ENGINES)[number];

// How wide the DISCOVERY layer casts, as a preset over the primitives above.
// The harness WebSearch lane is the engine; the keyless cascade is the
// amplifier — this knob says whether to pay for the amplifier.
//
//   light — the WebSearch lane + the mode's API backends (Wikipedia, arXiv,
//           Crossref, StackExchange, GitHub, HN, standards). No scraped cascade,
//           no SearXNG. Firecrawl still EXTRACTS (it is not a discovery engine).
//   full  — everything keyless, fused: the lane + the scraped cascade + SearXNG.
//   max   — the ceiling. `full`, plus Firecrawl's own /search as a discovery
//           lane, plus every recall knob at its limit (pages 5, breadth 5, the
//           gap round) and `--depth deep` unless the caller pinned one. Wants
//           the whole container stack up; says so plainly when it is not.
//   auto  — light when the agent supplied --web-results, full when it did not.
//           A harness with no WebSearch tool therefore keeps the old behaviour
//           and never comes back empty. `auto` never resolves to `max`: paying
//           for ~3 GB of containers and a 10-minute run is always a decision.
export const ALL_SEARCH_PROFILES = ["auto", "light", "full", "max"] as const;
export type SearchProfile = (typeof ALL_SEARCH_PROFILES)[number];

// One hit from the agent's own WebSearch tool, as handed to `--web-results`.
// Only `url` is required — a hit with no title falls back to the URL, and a
// missing snippet just means the excerpt comes from the hydrated page.
export interface WebSearchHit {
  url: string;
  title?: string;
  snippet?: string;
}

// Optional, backend-specific metadata carried on a source.
export interface SourceMeta {
  doi?: string;
  arxivId?: string;
  authors?: string[];
  year?: number;
  venue?: string;
  stars?: number; // github
  answerScore?: number; // stackoverflow accepted/top answer score
  points?: number; // hacker news
  heading?: string; // nearest heading for a web excerpt
  htmlUrl?: string; // arxiv: the /html/<id> full-text URL
  absUrl?: string; // arxiv: the /abs/<id> abstract page (hydration fallback)
  waybackSnapshot?: string; // timestamp of the Wayback snapshot a dead link was recovered from
  textVia?: string; // API endpoint the text was hydrated from when the landing page was walled (the source url stays the page)
  foundBy?: number; // independent backend lists that surfaced this source (cross-engine corroboration)
  // The score's components, kept so a re-weighting can be replayed exactly
  // against a dossier already on disk instead of re-running retrieval (two runs
  // never return the same pool, which made the question unanswerable).
  rank?: { rrf: number; content: number; trust: number; recency: number };
  provenance?: Provenance[]; // which sub-question(s) surfaced this source (set by `merge`)
  [k: string]: unknown;
}

// What a backend yields before stable ids and on-disk extract paths are
// assigned. `text` is the full cleaned content when the backend already has it
// (Wikipedia summary, an abstract, an API payload); discovery backends
// (searxng/duckduckgo) leave it undefined and the gatherer fetches the page.
export interface RawSource {
  url: string;
  title: string;
  backend: BackendKind;
  score: number;
  snippet: string;
  text?: string;
  lang?: string;
  meta?: SourceMeta;
  fullText?: boolean; // false when only a search snippet was available (page fetch failed)
}

// A source as persisted in sources.json. `extract` is the relative path to the
// cleaned full text in sources/S#.md; the model cites this source as [S#].
export interface Source {
  id: string; // "S1", "S2", …
  url: string;
  canonicalUrl: string;
  title: string;
  backend: BackendKind;
  fetchedAt: string;
  lang?: string;
  domain: string;
  trust: number; // 0..1 heuristic (domain class + backend authority)
  score: number; // fused relevance
  extract: string; // relative path, e.g. "sources/S1.md"
  snippet: string;
  meta?: SourceMeta;
  // false ⇒ the page fetch failed and only the search snippet is on file; the
  // extract is the snippet, not the real page. Surfaced in DOSSIER.md / HTML so
  // a reader doesn't cite a source it only saw a snippet of. Absent ⇒ full text.
  fullText?: boolean;
  // Structural, corpus-relative authority signals (src/authority.ts): reference
  // diversity, self-declared identity, cross-backend corroboration. Rendered as
  // guidance for the reader — they never drop or re-rank a source, because the
  // measurement says they are right often, not always.
  signals?: string[];
}

// What a backend module returns: candidate sources + honest notes (e.g.
// "SearXNG unreachable", "GitHub rate-limited"). Backends never throw — the
// registry wraps them and turns failures into notes.
export interface BackendResult {
  backend: BackendKind;
  items: RawSource[];
  notes: string[];
  ms?: number;
}

export type Backend = (ctx: RunContext) => Promise<BackendResult>;

export type ModeExtra = "bibtex" | "glossary" | "exercises";

// A mode = a backend-priority profile + a report template + extra outputs.
export interface ModeProfile {
  name: ModeName;
  description: string;
  backends: BackendKind[]; // priority order, run at standard depth and below
  deepOnly: BackendKind[]; // additional backends run only at --depth deep
  template: string; // the markdown template skeleton (section headings)
  extras: ModeExtra[];
  // The distinct ANGLES a WebSearch sweep should cover for this mode, emitted by
  // `queries` as the agent's search worklist. The engine cannot run the agent's
  // WebSearch for it, so the next best thing is to say precisely what to search
  // — one query per angle beats one query repeated.
  searchAngles: string[];
}

// Resolved options for one `gather` run.
export interface GatherOptions {
  question: string;
  mode: ModeName;
  depth: Depth;
  backends?: BackendKind[]; // explicit override of the mode profile
  queries?: string[]; // agent-supplied query variants (override the planner)
  maxSources: number;
  perSource: number;
  lang: string;
  region?: string; // region/country for locale-aware web search (else derived from lang)
  searxng?: string; // SearXNG base URL (else env / default)
  firecrawl?: string; // Firecrawl base URL (else env / http://localhost:3002); "off" disables it
  webEngine: WebEngine;
  search?: SearchProfile; // --search: how wide DISCOVERY casts (default auto)
  webResults?: WebSearchHit[]; // --web-results: the harness WebSearch hits the agent supplied
  webResultsRejected?: number; // entries in that payload with no usable http(s) URL (reported, never hidden)
  pages?: number; // result pages each web engine fetches per query (else per depth)
  webBreadth?: number; // engines the auto cascade fuses before stopping (else per depth)
  urls?: string[]; // explicit URLs for the `generic` backend / `search --backend generic`
  since?: string; // recency filter where a backend supports it
  excludeDomains: string[];
  seedDomains?: string[]; // --seed-domains: primary hosts to also search with `site:` and rank as primary

  concurrency?: number; // in-flight page hydration fetches (default 6)
  rounds?: number; // retrieval rounds; ≥2 enables a gap-driven follow-up web search
  cache?: boolean; // --cache: reuse an on-disk fetch cache across runs (deep fan-out)
  out?: string;
  json: boolean;
  stdout?: boolean; // --stdout / ULTRASEARCH_NO_WRITE: nothing is written, so the guidance changes
}

// Context handed to every backend for a run. `question` is the active query (a
// backend may be invoked once per variant by the registry); `variants` is the
// full planned set the registry fans out over.
export interface RunContext {
  question: string;
  mode: ModeProfile;
  options: GatherOptions;
  variants: string[];
}

// manifest.json — run metadata. `notes` carries retrieval hints (incl. the
// "agent: enrich with your own WebSearch via `fetch --url`" nudge).
export interface Manifest {
  version: string;
  question: string;
  mode: ModeName;
  depth: Depth;
  lang: string;
  region?: string; // region/country used for locale-aware web search (when set)
  pages?: number; // result pages fetched per web engine this run
  backends: BackendKind[]; // requested
  backendsUsed: BackendKind[]; // returned at least one source
  enginesFused?: BackendKind[]; // discovery lanes whose results were fused this run (incl. "claude", the WebSearch lane)
  // What the harness WebSearch lane contributed. `supplied: 0` on a run that
  // could have had one is the signal that the best engine available was not
  // used — the dossier says so rather than leaving it to be inferred.
  webSearch?: { supplied: number; rejected: number; kept: number };
  searchProfile?: SearchProfile; // the DISCOVERY preset this run resolved to (light | full)
  sourceCount: number;
  maxSources: number;
  builtAt: string;
  slug: string;
  tiers: string[]; // ["SUMMARY.md","REPORT.md"]
  extras: ModeExtra[];
  notes: string[];
  timings: Record<string, number>; // backend kind -> ms, plus "total"
  mergedFrom?: string[]; // (merge dossiers) the sub-dossier run dirs unioned
  subQuestions?: { id: string; question: string }[]; // (merge dossiers) the decomposition
  recallFloor?: { count: number; floor: number }; // set when the dossier is thin (count < floor)
  // Per-term coverage of the question's distinctive terms across the top kept
  // sources, plus the under-covered ones — the agent's enrichment worklist.
  // Computed in-memory from the already-hydrated extracts, so it costs no extra
  // retrieval. Absent on merge dossiers (a master has no single query basis).
  coverage?: { terms: { term: string; sources: number }[]; under: string[] };
  // On-disk fetch cache state for this run. `enabled: false` ⇒ every page was
  // fetched live. `hits` counts pages served from disk (≤ the TTL old), so a
  // dossier is self-describing about how fresh its page bodies are.
  cache?: { enabled: boolean; hits: number };
  // What the OPTIONAL helpers contributed this run. They are all skipped in
  // silence when absent — right for a per-URL note, wrong once per run, because
  // it lets a container sit up for weeks without ever being queried and without
  // anything saying so. `sources: 0` on a requested SearXNG, or an empty `pdf`
  // on a run full of papers, is the signal that something is not wired up.
  services?: ManifestServices;
}

export interface ManifestServices {
  /** `requested` = the backend ran at all; `sources` = results it contributed. */
  searxng: { requested: boolean; sources: number };
  /** Pages whose text came from the self-hosted Firecrawl rather than the built-in reader. */
  firecrawl: { pages: number };
  /** PDF ladder rung → pages read by it. Absent rungs simply never won. */
  pdf: Record<string, number>;
}

// Result of `ultrasearch check`. Fails (ok=false) on dangling citations, on
// unmarked unsourced claims, or when no source is cited at all. Flagged
// model-hints are tolerated; uncited sources and unknown tokens only warn.
export interface CheckResult {
  ok: boolean;
  filesChecked: string[];
  sourceCitations: number; // total [S#] tokens resolved across tiers
  modelHints: number; // [M] markers + > [model-hint] regions
  dangling: string[]; // [S#] with no matching source
  unmarkedUnsourced: { file: string; text: string }[]; // claims missing a source/flag
  uncitedSources: string[]; // sources never cited (informational)
  unknownTokens: string[]; // bracketed non-citations (informational)
  errors: string[];
  warnings: string[];
  numeralIssues?: { file: string; claim: string; numeral: string; sourceIds: string[] }[]; // claim numerals absent from every cited extract (advisory; --strict-numerals fails)
  semantic?: VerifyResult; // populated only by `check --semantic` (folds VERIFY.json)
}

// ---------------------------------------------------------------------------
// Semantic claim verification. The mechanical `check` only proves a [S#] is
// PRESENT next to a claim; `verify` asks whether the cited source actually
// SUPPORTS it. `verify --run` emits ClaimEvidencePair[] (a deterministic
// worklist); agents fill a Verdict per pair; `verify --apply` / `check
// --semantic` then FAIL the gate on any refuted/unsupported claim — the
// semantic extension of the citation-presence gate.
// ---------------------------------------------------------------------------
export type VerdictKind = "supported" | "partial" | "refuted" | "unsupported";

// A claim-unit paired with one of the sources it cites + a claim-focused digest
// of that source's extract, for an agent to adjudicate.
export interface ClaimEvidencePair {
  claimId: string; // "C1", "C2", …
  file: string; // "REPORT.md"
  sourceId: string; // the cited [S#]
  claim: string; // the claim-unit text (capped)
  extractPath: string; // relative path, e.g. "sources/S2.md"
  extractDigest: string; // claim-focused snippet of the cited extract
  numeralsAbsent?: string[]; // claim numerals NOT found in this source's full extract (normalized) — verdict caps at `partial`
}

// A ClaimEvidencePair with the agent's judgement filled in.
export interface Verdict extends ClaimEvidencePair {
  verdict: VerdictKind;
  note: string;
}

// Outcome of folding the adjudicated verdicts back in. `ok` is false when any
// claim is refuted/unsupported. `unadjudicated` lists pairs still missing a
// verdict (warn, not fail).
export interface VerifyResult {
  ok: boolean;
  pairs: number;
  adjudicated: number;
  supported: number;
  partial: number;
  refuted: number;
  unsupported: number;
  failures: { claimId: string; sourceId: string; verdict: VerdictKind; note: string }[];
  unadjudicated: string[];
  // Claims whose own cited sources DISAGREE — some support it, another refutes
  // it. A purely additive, deterministic signal (does NOT change `ok`): surfaced
  // in the report + `check --semantic` so a reader sees source-level conflicts.
  contradictions?: { claimId: string; supporting: string[]; refuting: string[]; note: string }[];
  verdicts?: Verdict[]; // the full adjudicated list, persisted for `render` (not needed by the gate)
}
