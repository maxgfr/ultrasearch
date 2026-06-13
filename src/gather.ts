import { join } from "node:path";
import { tmpdir } from "node:os";
import { VERSION } from "./types.js";
import type { BackendKind, BackendResult, GatherOptions, Manifest, ModeProfile, RawSource, RunContext, Source } from "./types.js";
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
  rankedKeywords,
  identityKey,
  canonicalizeUrl,
  buildBm25Index,
  bm25Score,
  bm25Tokenize,
  recencyScore,
  dedupeNearDuplicates,
  trustScore,
  mapLimit,
} from "./util.js";
import type { Bm25Doc } from "./util.js";
import { writeFileSync } from "node:fs";

// How many candidates beyond maxSources to hydrate so content-aware re-ranking
// can promote a deeply-relevant page a backend ranked low.
const OVERSHOOT: Record<string, number> = { summary: 5, standard: 10, deep: 20 };
const HYDRATE_CONCURRENCY = 6;

// Heading lines (markdown "# …" emitted by htmlToText) of a fetched page —
// fed to BM25 as a boosted field so on-topic headings lift a source's score.
function headingLines(text: string): string {
  return text
    .split("\n")
    .filter((l) => /^#{1,6}\s/.test(l))
    .join("\n");
}

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

// General-web discovery engines, in cascade preference order: the more precise/
// robust engines first, broad fallbacks last. `auto` runs them as a fallback
// cascade (see runWebCascade); a pinned engine runs just that one.
const DISCOVERY: BackendKind[] = ["searxng", "duckduckgo", "ddglite", "mojeek", "marginalia"];

const ENGINE_BACKEND: Record<Exclude<GatherOptions["webEngine"], "auto" | "claude">, BackendKind> = {
  searxng: "searxng",
  ddg: "duckduckgo",
  ddglite: "ddglite",
  mojeek: "mojeek",
  marginalia: "marginalia",
};

// Apply --web-engine to the general-web discovery backends: `auto` keeps the
// profile's discovery engines (runGather then runs the full fallback cascade);
// a named engine pins to exactly that one (injecting it if the profile didn't
// list it); `claude` drops web discovery (you drive it via your own WebSearch +
// `fetch --url`). Mode-specific backends (wikipedia, scholarly APIs) are
// untouched.
function applyWebEngine(kinds: BackendKind[], engine: GatherOptions["webEngine"]): BackendKind[] {
  if (engine === "auto") return kinds;
  if (engine === "claude") return kinds.filter((k) => !DISCOVERY.includes(k));
  const keep = ENGINE_BACKEND[engine];
  if (kinds.includes(keep)) return kinds.filter((k) => !DISCOVERY.includes(k) || k === keep);
  return [...kinds.filter((k) => !DISCOVERY.includes(k)), keep];
}

// Run the general-web discovery engines as a fallback cascade in preference
// order, short-circuiting as soon as one yields enough results — so web recall
// does not collapse when the primary engine (DDG) blocks or changes its markup.
// Each engine runs through the normal per-variant fan-out; engines past the
// first that satisfies `perSource` are not queried at all (polite + fast).
async function runWebCascade(engines: BackendKind[], ctx: RunContext): Promise<BackendResult[]> {
  const out: BackendResult[] = [];
  const tried: BackendKind[] = [];
  for (const engine of engines) {
    const [r] = await runBackends([engine], ctx);
    if (!r) continue;
    out.push(r);
    tried.push(engine);
    if (r.items.length >= ctx.options.perSource) break;
  }
  // When the cascade fell through past an empty/blocked engine to a later one,
  // record provenance so the agent sees its web results came from a fallback.
  const producers = out.filter((r) => r.items.length > 0).map((r) => r.backend);
  if (tried.length > 1 && producers.length) {
    const lead = out.find((r) => r.items.length > 0);
    if (lead) lead.notes = [...lead.notes, `Web cascade tried ${tried.join(" → ")}; results from ${producers.join(", ")}.`];
  }
  return out;
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

// The query variants a run searches with: agent-supplied `--queries` take over
// (the agent knows the domain better than the regex planner), deduped and capped
// by depth so a long list can't explode fan-out on rate-limited backends; else
// fall back to the deterministic planner. Single-query backends always use the
// original question (see registry), so this only widens the multi-query fan-out.
export function resolveVariants(options: GatherOptions): string[] {
  if (options.queries && options.queries.length) {
    const cap = options.depth === "summary" ? 2 : options.depth === "standard" ? 4 : 6;
    const seen = new Set<string>();
    const out: string[] = [];
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

// Full `gather`: fan out backends, fuse + dedupe + filter + cap, fetch full
// text for any source that lacks it, then write the dossier. The model writes
// the tiered reports afterward.
export async function runGather(options: GatherOptions): Promise<GatherResult> {
  const t0 = Date.now();
  const mode = getMode(options.mode);
  const backends = resolveBackends(options, mode);
  const variants = resolveVariants(options);
  const ctx: RunContext = { question: options.question, mode, options, variants };

  // Run the mode's non-web backends in parallel, and the general-web discovery
  // engines as a resilient fallback cascade. An explicit --backends override or
  // a profile with no web engine just runs everything as-is (the user asked for
  // exactly those backends).
  const explicit = !!(options.backends && options.backends.length);
  const webBackends = backends.filter((b) => DISCOVERY.includes(b));
  let results: BackendResult[];
  if (explicit || webBackends.length === 0) {
    results = await runBackends(backends, ctx);
  } else {
    const rest = backends.filter((b) => !DISCOVERY.includes(b));
    // `auto` augments the cascade with the broader fallback engines; a pinned
    // engine cascades over just the discovery engine(s) the profile resolved to.
    const cascade = options.webEngine === "auto" ? [...DISCOVERY] : DISCOVERY.filter((d) => webBackends.includes(d));
    const [restResults, webResults] = await Promise.all([runBackends(rest, ctx), runWebCascade(cascade, ctx)]);
    results = [...restResults, ...webResults];
  }

  const excluded = (it: RawSource): boolean => {
    const d = domainOf(it.url);
    return !options.excludeDomains.some((ex) => d === ex || d.endsWith("." + ex));
  };
  // Fetches are cached across rounds by canonical URL so the gap round never
  // re-fetches a page round 1 already hydrated.
  const hydrateCache = new Map<string, { text: string; title?: string; note?: string; finalUrl: string }>();

  // Fuse → exclude → hydrate a slightly-oversized pool → content-aware re-rank
  // (BM25F field-weighted, proximity-aware, blended with fusion rank, trust and
  // pool-relative recency) → collapse near-duplicate CONTENT → cap. Shared by
  // the main pass and the gap round so both score identically.
  async function assemble(rawLists: RawSource[][]) {
    let merged = fuse(rawLists);
    const droppedDup = rawLists.reduce((n, l) => n + l.length, 0) - merged.length;
    if (options.excludeDomains.length) merged = merged.filter(excluded);

    const overshoot = OVERSHOOT[options.depth] ?? 10;
    const pool = merged.slice(0, Math.min(merged.length, options.maxSources + overshoot));

    const hydrateNotes: string[] = [];
    await mapLimit(pool, options.concurrency ?? HYDRATE_CONCURRENCY, async (it) => {
      if (it.text && it.text.trim()) return;
      const key = canonicalizeUrl(it.url);
      let res = hydrateCache.get(key);
      if (!res) {
        res = await fetchAndExtract(it.url);
        hydrateCache.set(key, res);
      }
      if (res.finalUrl && res.finalUrl !== it.url) it.url = res.finalUrl; // follow redirects (provenance + exclude re-check)
      if (res.note) hydrateNotes.push(res.note);
      if (res.text && res.text.trim()) {
        it.text = res.text;
        if (!it.snippet) it.snippet = bestExcerpt(res.text, options.question);
        if ((!it.title || it.title === it.url) && res.title) it.title = res.title;
      } else {
        it.text = it.snippet || "";
      }
    });

    let withContent = pool.filter((it) => (it.text && it.text.trim()) || it.snippet.trim());
    // Re-apply --exclude-domains AFTER hydration: a followed redirect can land a
    // kept source on an excluded host the pre-fetch URL didn't reveal.
    if (options.excludeDomains.length) withContent = withContent.filter(excluded);

    const docs: Bm25Doc[] = withContent.map((it) => ({
      id: it.url,
      title: it.title || "",
      headings: headingLines(it.text || ""),
      body: it.text || it.snippet || "",
    }));
    const bm25 = buildBm25Index(options.question, docs);
    const rawContent = docs.map((d) => bm25Score(bm25, d));
    const contentMax = Math.max(1e-9, ...rawContent);
    const rrfMax = Math.max(1e-9, ...withContent.map((it) => it.score));
    const years = withContent.map((it) => it.meta?.year).filter((y): y is number => typeof y === "number");
    const minYear = years.length ? Math.min(...years) : 0;
    const maxYear = years.length ? Math.max(...years) : 0;
    withContent.forEach((it, i) => {
      const content = rawContent[i]! / contentMax;
      const rrfN = it.score / rrfMax;
      const trust = trustScore(it.url, it.backend);
      const recency = recencyScore(it.meta, minYear, maxYear);
      it.score = Number((0.45 * rrfN + 0.35 * content + 0.15 * trust + 0.05 * recency).toFixed(6));
    });
    withContent.sort((a, b) => b.score - a.score || a.url.localeCompare(b.url));
    const near = dedupeNearDuplicates(withContent);
    return { merged: near.items.slice(0, options.maxSources), withContent, hydrateNotes, droppedDup, nearDropped: near.dropped, queryTerms: bm25.queryTerms };
  }

  const lists = results.map((r) => [...r.items].sort((a, b) => b.score - a.score));
  let r = await assemble(lists);

  // Optional gap round (--rounds ≥ 2, web discovery active): if some of the
  // question's terms are under-covered by the top sources, issue ONE focused web
  // cascade for them and re-assemble the union — recall insurance for the long
  // tail the first pass missed.
  let gapNote: string | undefined;
  if ((options.rounds ?? 1) >= 2 && webBackends.length > 0 && !explicit) {
    const top = r.withContent.slice(0, Math.min(10, r.withContent.length));
    const gaps = r.queryTerms.filter((term) => {
      let cov = 0;
      for (const it of top) if (bm25Tokenize(it.text || it.snippet || "").includes(term)) cov++;
      return cov < 2;
    });
    if (gaps.length) {
      const seenTerm = new Set<string>();
      const gapQuery = [...rankedKeywords(options.question).slice(0, 2), ...gaps]
        .filter((t) => {
          const k = t.toLowerCase();
          return seenTerm.has(k) ? false : (seenTerm.add(k), true);
        })
        .join(" ");
      const cascade = options.webEngine === "auto" ? [...DISCOVERY] : DISCOVERY.filter((d) => webBackends.includes(d));
      const gapResults = await runWebCascade(cascade, { ...ctx, question: gapQuery, variants: [gapQuery] });
      results = [...results, ...gapResults];
      const gapLists = gapResults.map((rr) => [...rr.items].sort((a, b) => b.score - a.score));
      r = await assemble([...lists, ...gapLists]);
      gapNote = `Gap round searched "${gapQuery}" for under-covered term(s): ${gaps.join(", ")}.`;
    }
  }

  const merged = r.merged;
  const backendsUsed = results.filter((res) => res.items.length > 0).map((res) => res.backend);
  const timings: Record<string, number> = {};
  for (const res of results) if (res.ms !== undefined) timings[res.backend] = res.ms;
  timings.total = Date.now() - t0;

  const notes = [
    ...results.flatMap((res) => res.notes),
    ...r.hydrateNotes,
    ...(r.droppedDup > 0 ? [`Dropped ${r.droppedDup} duplicate result(s) across backends.`] : []),
    ...(r.nearDropped > 0 ? [`Collapsed ${r.nearDropped} near-duplicate (syndicated) page(s).`] : []),
    ...(gapNote ? [gapNote] : []),
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
