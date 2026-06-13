import { join } from "node:path";
import { tmpdir } from "node:os";
import { VERSION } from "./types.js";
import type { BackendKind, GatherOptions, Manifest, ModeProfile, RawSource, RunContext, Source } from "./types.js";
import { getMode } from "./modes/registry.js";
import { runBackends } from "./backends/registry.js";
import { fetchAndExtract, bestExcerpt } from "./backends/fetch.js";
import { writeDossier } from "./dossier.js";
import { toBibtex } from "./bibtex.js";
import {
  domainOf,
  rrf,
  runId,
  slugify,
  planVariants,
  identityKey,
  buildMatcher,
  contentCoverage,
  trustScore,
  mapLimit,
} from "./util.js";
import { writeFileSync } from "node:fs";

// How many candidates beyond maxSources to hydrate so content-aware re-ranking
// can promote a deeply-relevant page a backend ranked low.
const OVERSHOOT: Record<string, number> = { summary: 5, standard: 10, deep: 20 };
const HYDRATE_CONCURRENCY = 6;

export interface GatherResult {
  dir: string;
  sources: Source[];
  manifest: Manifest;
}

const ENRICH_NUDGE =
  "agent: enrich thin areas with your own WebSearch, then ingest each good URL via " +
  "`ultrasearch fetch --url <u> --out <dir>` before writing the report.";

// Default dossier directory under the OS temp dir, keyed by mode + question.
export function defaultRunDir(mode: string, question: string, d?: Date): string {
  return join(tmpdir(), "ultrasearch", `${mode}-${slugify(question)}`, runId(d));
}

const DISCOVERY: BackendKind[] = ["searxng", "duckduckgo"];

// Apply --web-engine to the general-web discovery backends: `searxng`/`ddg`
// pin to that one, `claude` drops both (you drive discovery via your own
// WebSearch + `fetch --url`), `auto` keeps both. Mode-specific backends
// (wikipedia, scholarly APIs, etc.) are untouched.
function applyWebEngine(kinds: BackendKind[], engine: GatherOptions["webEngine"]): BackendKind[] {
  if (engine === "auto") return kinds;
  if (engine === "claude") return kinds.filter((k) => !DISCOVERY.includes(k));
  const keep: BackendKind = engine === "searxng" ? "searxng" : "duckduckgo";
  return kinds.filter((k) => !DISCOVERY.includes(k) || k === keep);
}

// Which backends a run uses: an explicit --backends override, else the mode's
// profile (plus its deep-only backends at --depth deep), then the --web-engine
// discovery filter.
export function resolveBackends(options: GatherOptions, mode: ModeProfile): BackendKind[] {
  if (options.backends && options.backends.length) return [...new Set(options.backends)];
  const base = options.depth === "deep" ? [...mode.backends, ...mode.deepOnly] : [...mode.backends];
  return [...new Set(applyWebEngine(base, options.webEngine))];
}

// Merge each backend's ranked list into one ranking by Reciprocal Rank Fusion
// over an IDENTITY key (DOI / arXiv id, else canonical URL), so the same work
// surfaced by several backends collapses to one entry instead of eating several
// source slots. On collision, prefer the copy that already carries text and
// merge their metadata.
export function fuse(lists: RawSource[][]): RawSource[] {
  const fused = rrf(lists, identityKey);
  const best = new Map<string, RawSource>();
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

// Full `gather`: fan out backends, fuse + dedupe + filter + cap, fetch full
// text for any source that lacks it, then write the dossier. The model writes
// the tiered reports afterward.
export async function runGather(options: GatherOptions): Promise<GatherResult> {
  const t0 = Date.now();
  const mode = getMode(options.mode);
  const backends = resolveBackends(options, mode);
  const variants = planVariants(options.question, options.depth);
  const ctx: RunContext = { question: options.question, mode, options, variants };

  const results = await runBackends(backends, ctx);

  const lists = results.map((r) => [...r.items].sort((a, b) => b.score - a.score));
  let merged = fuse(lists);
  // Count duplicates collapsed by fusion BEFORE the domain filter, so the
  // agent-facing note doesn't miscount excluded hosts as duplicates.
  const droppedDup = lists.reduce((n, l) => n + l.length, 0) - merged.length;

  // --exclude-domains: drop unwanted hosts (suffix match).
  if (options.excludeDomains.length) {
    merged = merged.filter((it) => {
      const d = domainOf(it.url);
      return !options.excludeDomains.some((ex) => d === ex || d.endsWith("." + ex));
    });
  }

  // Two-stage cap: hydrate a candidate pool a bit larger than maxSources, then
  // re-rank by ACTUAL content relevance (keyword coverage of the fetched text)
  // blended with fusion rank and source trust, THEN cut — so a deeply-relevant
  // page a single backend ranked low is not discarded sight-unseen.
  const overshoot = OVERSHOOT[options.depth] ?? 10;
  const pool = merged.slice(0, Math.min(merged.length, options.maxSources + overshoot));

  const hydrateNotes: string[] = [];
  await mapLimit(pool, HYDRATE_CONCURRENCY, async (it) => {
    if (it.text && it.text.trim()) return;
    const { text, title, note, finalUrl } = await fetchAndExtract(it.url);
    if (finalUrl && finalUrl !== it.url) it.url = finalUrl; // follow redirects for provenance + exclude re-check
    if (note) hydrateNotes.push(note);
    if (text && text.trim()) {
      it.text = text;
      if (!it.snippet) it.snippet = bestExcerpt(text, options.question);
      if ((!it.title || it.title === it.url) && title) it.title = title;
    } else {
      it.text = it.snippet || "";
    }
  });

  let withContent = pool.filter((it) => (it.text && it.text.trim()) || it.snippet.trim());

  // Re-apply --exclude-domains AFTER hydration: a followed redirect can land a
  // kept source on an excluded host that the pre-fetch URL didn't reveal.
  if (options.excludeDomains.length) {
    withContent = withContent.filter((it) => {
      const d = domainOf(it.url);
      return !options.excludeDomains.some((ex) => d === ex || d.endsWith("." + ex));
    });
  }

  // Content-aware re-rank against the ORIGINAL question (not the variants).
  const matcher = buildMatcher(options.question);
  const rrfMax = Math.max(1e-9, ...withContent.map((it) => it.score));
  for (const it of withContent) {
    const cov = contentCoverage(matcher, it.text || it.snippet);
    const rrfN = it.score / rrfMax;
    const trust = trustScore(it.url, it.backend);
    it.score = Number((0.5 * rrfN + 0.35 * cov + 0.15 * trust).toFixed(6));
  }
  withContent.sort((a, b) => b.score - a.score || a.url.localeCompare(b.url));
  merged = withContent.slice(0, options.maxSources);

  const backendsUsed = results.filter((r) => r.items.length > 0).map((r) => r.backend);
  const timings: Record<string, number> = {};
  for (const r of results) if (r.ms !== undefined) timings[r.backend] = r.ms;
  timings.total = Date.now() - t0;

  const notes = [
    ...results.flatMap((r) => r.notes),
    ...hydrateNotes,
    ...(droppedDup > 0 ? [`Dropped ${droppedDup} duplicate result(s) across backends.`] : []),
    ENRICH_NUDGE,
  ];

  const manifest: Manifest = {
    version: VERSION,
    question: options.question,
    mode: options.mode,
    depth: options.depth,
    lang: options.lang,
    backends,
    backendsUsed,
    sourceCount: merged.length,
    maxSources: options.maxSources,
    builtAt: new Date().toISOString(),
    slug: `${options.mode}-${slugify(options.question)}`,
    tiers: ["SUMMARY.md", "REPORT.md", "FULL.md"],
    extras: mode.extras,
    notes,
    timings,
  };

  const dir = options.out ?? defaultRunDir(options.mode, options.question);
  const { sources } = writeDossier(dir, merged, manifest, mode.template);
  // Research mode ships a BibTeX file built from the scholarly sources.
  if (mode.extras.includes("bibtex")) {
    writeFileSync(join(dir, "refs.bib"), toBibtex(sources));
  }
  return { dir, sources, manifest: { ...manifest, sourceCount: sources.length } };
}
