// Single source of truth for the version the CLI/bundle reports. Kept in
// lockstep with package.json and SKILL.md by scripts/sync-version.mjs during a
// semantic-release run. Do not edit by hand outside a release.
export const VERSION = "1.4.0";

// Every retrieval backend a run can draw from. Search/discovery backends
// (searxng, duckduckgo) yield candidate URLs the gatherer then fetches;
// content backends (wikipedia, the keyless APIs) yield items that already carry
// text. "generic" fetches an explicit URL; "fixture" is the offline CI backend;
// "claude" is the provenance label for a source the agent added via `fetch`.
export type BackendKind =
  | "searxng"
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
  | "generic"
  | "fixture"
  | "claude";

export const ALL_BACKENDS: readonly BackendKind[] = [
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

// ---------------------------------------------------------------------------
// Deep-research tier. The agentic orchestration (driven by SKILL.md) that fans
// out one `gather` per sub-question, merges the dossiers, and adversarially
// verifies each claim before synthesis. These are ORCHESTRATION caps that bound
// the long (10–20 min) loop — distinct from Depth, which is a per-`gather`
// retrieval cap. Each sub-question fan-out is itself a `gather --depth deep`.
// ---------------------------------------------------------------------------
export interface DeepCaps {
  maxSubQuestions: number; // sub-questions `plan` emits / the loop fans out on
  maxRounds: number; // loop-until-dry rounds before a forced stop
  maxVerify: number; // claim↔source pairs `verify` emits per run
  perSubQuestionSources: number; // suggested --max-sources for each fan-out gather
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
export type WebEngine = "auto" | "searxng" | "ddg" | "ddglite" | "mojeek" | "marginalia" | "claude";

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
  queries?: string[]; // agent-supplied query variants (override the planner)
  maxSources: number;
  perSource: number;
  lang: string;
  searxng?: string; // SearXNG base URL (else env / default)
  webEngine: WebEngine;
  urls?: string[]; // explicit URLs for the `generic` backend / `search --backend generic`
  since?: string; // recency filter where a backend supports it
  excludeDomains: string[];
  concurrency?: number; // in-flight page hydration fetches (default 6)
  rounds?: number; // retrieval rounds; ≥2 enables a gap-driven follow-up web search
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
  mergedFrom?: string[]; // (merge dossiers) the sub-dossier run dirs unioned
  subQuestions?: { id: string; question: string }[]; // (merge dossiers) the decomposition
  recallFloor?: { count: number; floor: number }; // set when the dossier is thin (count < floor)
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
  file: string; // "REPORT.md" | "FULL.md"
  sourceId: string; // the cited [S#]
  claim: string; // the claim-unit text (capped)
  extractPath: string; // relative path, e.g. "sources/S2.md"
  extractDigest: string; // claim-focused snippet of the cited extract
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
