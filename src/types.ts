// Single source of truth for the version the CLI/bundle reports. Kept in
// lockstep with package.json and SKILL.md by scripts/sync-version.mjs during a
// semantic-release run. Do not edit by hand outside a release.
export const VERSION = "1.1.0";

// Every retrieval backend a run can draw from. Search/discovery backends
// (searxng, duckduckgo) yield candidate URLs the gatherer then fetches;
// content backends (wikipedia, the keyless APIs) yield items that already carry
// text. "generic" fetches an explicit URL; "fixture" is the offline CI backend;
// "claude" is the provenance label for a source the agent added via `fetch`.
export type BackendKind =
  | "searxng"
  | "duckduckgo"
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
  | "generic"
  | "fixture"
  | "claude";

export const ALL_BACKENDS: readonly BackendKind[] = [
  "searxng",
  "duckduckgo",
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
  "claude",
];

// The five report shapes. Each maps to a ModeProfile (backend priority +
// template + extras) in src/modes.
export type ModeName = "topic" | "bug" | "research" | "learn" | "startup";
export const ALL_MODES: readonly ModeName[] = ["topic", "bug", "research", "learn", "startup"];

// How far a run fans out. `summary` is a quick survey, `deep` runs every
// backend (including deep-only ones) and keeps the most sources. Tiers
// (SUMMARY/REPORT/FULL) are always all three regardless of depth — depth caps
// how much retrieval feeds the deepest tier.
export type Depth = "summary" | "standard" | "deep";
export const ALL_DEPTHS: readonly Depth[] = ["summary", "standard", "deep"];

// Per-depth retrieval caps, scaled in gather. maxSources/perSource defaults are
// derived from these unless overridden by --max-sources / --per-source.
export const DEPTH_CAPS: Record<Depth, { maxSources: number; perSource: number; deepOnly: boolean }> = {
  summary: { maxSources: 10, perSource: 4, deepOnly: false },
  standard: { maxSources: 25, perSource: 6, deepOnly: false },
  deep: { maxSources: 60, perSource: 10, deepOnly: true },
};

// Which keyless discovery engine the web layer uses; "auto" tries
// searxng → duckduckgo, then emits a hint to use the agent's own WebSearch.
export type WebEngine = "auto" | "searxng" | "ddg" | "claude";

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
}

// Resolved options for one `gather` run.
export interface GatherOptions {
  question: string;
  mode: ModeName;
  depth: Depth;
  backends?: BackendKind[]; // explicit override of the mode profile
  maxSources: number;
  perSource: number;
  lang: string;
  searxng?: string; // SearXNG base URL (else env / default)
  webEngine: WebEngine;
  urls?: string[]; // explicit URLs for the `generic` backend / `search --backend generic`
  since?: string; // recency filter where a backend supports it
  excludeDomains: string[];
  out?: string;
  json: boolean;
  fresh: boolean;
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
  backends: BackendKind[]; // requested
  backendsUsed: BackendKind[]; // returned at least one source
  sourceCount: number;
  maxSources: number;
  builtAt: string;
  slug: string;
  tiers: string[]; // ["SUMMARY.md","REPORT.md","FULL.md"]
  extras: ModeExtra[];
  notes: string[];
  timings: Record<string, number>; // backend kind -> ms, plus "total"
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
}
