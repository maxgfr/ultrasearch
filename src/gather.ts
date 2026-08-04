import { join } from "node:path";
import { tmpdir } from "node:os";
import { VERSION, RECALL_FLOORS, PAGES_PER_DEPTH, WEB_BREADTH_PER_DEPTH, UNDER_COVERED_MIN } from "./types.js";
import type {
  BackendKind,
  BackendResult,
  GatherOptions,
  Manifest,
  ManifestServices,
  ModeProfile,
  RawSource,
  RunContext,
  SearchProfile,
  Source,
} from "./types.js";
import { getMode } from "./modes/registry.js";
import { runBackends } from "./backends/registry.js";
import { bestExcerpt, looksLikeJunkExtraction, rescueViaWayback, DEAD_LINK_STATUS, type ExtractResult } from "./backends/fetch.js";
import { scrapeViaFirecrawl } from "./backends/firecrawl.js";
import { cachedFetchAndExtract } from "./cache.js";
import { resolveProvider } from "./providers.js";
import { acceptLanguageHeader } from "./locale.js";
import { writeBibtex, writeDossier } from "./dossier.js";
import { describeServices } from "./services.js";
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
  bm25MatchedTerms,
  bm25Tokenize,
  applyRelevanceFloor,
  recencyScore,
  dedupeNearDuplicates,
  diversify,
  trustScore,
  mapLimit,
} from "./util.js";
import type { Bm25Doc } from "./util.js";

// How many candidates beyond maxSources to hydrate so content-aware re-ranking
// can promote a deeply-relevant page a backend ranked low.
const OVERSHOOT: Record<string, number> = { summary: 5, standard: 10, deep: 20 };
const HYDRATE_CONCURRENCY = 6;

// Round a 0..1 score component for on-disk storage: enough precision to replay
// a re-weighting exactly, short enough not to bloat sources.json.
function round4(n: number): number {
  return Number(n.toFixed(4));
}

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
  "agent: run another WebSearch round at the thin areas and fold the WHOLE round in with " +
  "`ultrasearch ingest --run <dir> --web-results <f.json>` (one process, not one per URL) before writing the report.";
// `ingest` needs a dossier on disk, so under --stdout the top-up is the agent's
// own reading rather than a command it cannot run.
const ENRICH_NUDGE_NO_WRITE = "agent: run another WebSearch round at the thin areas and read those pages directly before answering.";

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
  // Pinnable, but absent from DISCOVERY above — so `auto` never reaches for it.
  firecrawl: "firecrawl",
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
// order, short-circuiting as soon as `breadth` of them yield enough results — so
// web recall does not collapse when the primary engine (DDG) blocks or changes
// its markup. Walk the engines in WAVES: each wave launches only as many engines
// as are still needed to reach `breadth` satisfied ones, run CONCURRENTLY, then
// re-check. At breadth 1 every wave is a single engine, i.e. the exact sequential
// short-circuit (one at a time, stop as soon as one satisfies `perSource`). At
// deep breadth (== all discovery engines) the first wave launches them all in
// parallel — the big win over the old serial loop, and the slowest part of a
// deep run. The SET of engines queried is identical to the sequential cascade
// for deterministic responses (a wave ends exactly at the engine that reaches
// `breadth`), so the fused result is byte-for-byte unchanged.
export async function runWebCascade(engines: BackendKind[], ctx: RunContext, breadth = 1): Promise<BackendResult[]> {
  const out: BackendResult[] = [];
  let enough = 0; // engines that returned >= perSource results so far
  let i = 0;
  while (i < engines.length && enough < breadth) {
    const waveSize = Math.min(breadth - enough, engines.length - i);
    const wave = engines.slice(i, i + waveSize);
    i += waveSize;
    // runBackends preserves `wave` order (Promise.all), so `out` stays in
    // preference order across waves — provenance notes remain deterministic.
    for (const r of await runBackends(wave, ctx)) {
      out.push(r);
      if (r.items.length >= ctx.options.perSource) enough++;
    }
  }
  const tried = out.map((r) => r.backend);
  // Record provenance. At breadth 1 the cascade short-circuits on the first
  // engine that returns enough (a fallback when earlier ones blocked); at higher
  // breadth it keeps going and FUSES several independent engines for wider recall.
  const producers = out.filter((r) => r.items.length > 0).map((r) => r.backend);
  if (producers.length) {
    const lead = out.find((r) => r.items.length > 0)!;
    if (producers.length > 1) {
      lead.notes = [...lead.notes, `Web cascade fused ${producers.length} engines: ${producers.join(", ")}.`];
    } else if (tried.length > 1) {
      lead.notes = [...lead.notes, `Web cascade tried ${tried.join(" → ")}; results from ${producers.join(", ")}.`];
    }
  }
  return out;
}

/**
 * Flags that `--backends` silently turns into no-ops. Pinning the retrieval set
 * is a legitimate power-user move, but `explicit` short-circuits SIX things —
 * the resilient web cascade, `--seed-domains`, the `--rounds 2` gap round,
 * `--web-engine`, the `--search` preset, and the `--web-results` WebSearch lane
 * (resolveBackends returns before any of them apply). Naming them is the
 * difference between a deliberate choice and silent recall loss.
 */
export function ignoredByExplicitBackends(options: GatherOptions): string[] {
  if (!options.backends?.length) return [];
  const out: string[] = [];
  if (options.seedDomains?.length) out.push("--seed-domains");
  if ((options.rounds ?? 1) >= 2) out.push("--rounds");
  if (options.webEngine !== "auto") out.push("--web-engine");
  if (options.search && options.search !== "auto") out.push("--search");
  // The loudest one: the agent went and ran its own WebSearch, and pinning the
  // backends threw every hit away unless "claude" is in the pinned set.
  if (options.webResults?.length && !options.backends.includes("claude")) out.push("--web-results");
  return out;
}

/**
 * Resolve the `--search` preset to a concrete discovery width.
 *
 * `auto` is the whole backward-compatibility story. It picks `light` only when
 * the agent actually supplied a WebSearch lane AND did not pin a specific
 * engine — a pinned `--web-engine` is a deliberate request for that engine, and
 * silently dropping it would be the kind of surprise this codebase spends the
 * `IGNORED:` line avoiding. Everything else resolves to `full`, so a harness
 * with no WebSearch tool behaves exactly as it did before this knob existed.
 */
export function resolveSearchProfile(options: GatherOptions): Exclude<SearchProfile, "auto"> {
  const asked = options.search ?? "auto";
  if (asked !== "auto") return asked;
  if (options.webResults?.length && options.webEngine === "auto") return "light";
  return "full";
}

/**
 * Per-term coverage of the question's BM25 query terms across the TOP kept
 * sources: how many of them actually contain each term. Pure and in-memory (the
 * extracts are already hydrated), so it runs on EVERY gather — not just the
 * `--rounds 2` gap round that used to be its only consumer and threw the answer
 * away. This is what turns "enrich the thin areas" from prose into a worklist.
 */
export function termCoverage(items: RawSource[], queryTerms: string[], top = 10): { term: string; sources: number }[] {
  const toks = items.slice(0, Math.min(top, items.length)).map((it) => new Set(bm25Tokenize(it.text || it.snippet || "")));
  return queryTerms.map((term) => ({ term, sources: toks.reduce((n, t) => n + (t.has(term) ? 1 : 0), 0) }));
}

/** The enrichment worklist: terms fewer than UNDER_COVERED_MIN of the top sources mention. */
export function underCovered(cov: { term: string; sources: number }[]): string[] {
  return cov.filter((c) => c.sources < UNDER_COVERED_MIN).map((c) => c.term);
}

// Which backends a run uses: an explicit --backends override, else the mode's
// profile (plus its deep-only backends at --depth deep), then the --web-engine
// discovery filter, then the --search width, then the WebSearch lane.
export function resolveBackends(options: GatherOptions, mode: ModeProfile): BackendKind[] {
  if (options.backends?.length) return [...new Set(options.backends)];
  const base = options.depth === "deep" ? [...mode.backends, ...mode.deepOnly] : [...mode.backends];
  const withEngine = applyWebEngine(base, options.webEngine);
  // `light` drops the scraped / self-hosted DISCOVERY engines: the WebSearch
  // lane IS the discovery. Firecrawl is untouched by design — it extracts pages,
  // it does not find them, so it keeps rescuing consent walls in either profile.
  const profile = resolveSearchProfile(options);
  const discovery = profile === "light" ? withEngine.filter((k) => !DISCOVERY.includes(k)) : withEngine;
  // `max` means every lane, so it supersedes a pinned --web-engine (reported by
  // ignoredByMaxProfile) and adds Firecrawl's own /search. Firecrawl is normally
  // excluded from discovery because its upstream is the same SearXNG the
  // `searxng` backend queries directly — but its hits can arrive WITH
  // browser-rendered markdown, and `fuse` prefers the copy that carries text.
  // So on a duplicate URL the page comes back already read by a real browser
  // instead of being re-fetched by the regex stripper. That is a quality gain,
  // not redundancy, and it is why `max` pays for it where `full` does not.
  const ceiling: BackendKind[] = profile === "max" ? [...DISCOVERY, "firecrawl"] : [];
  // The lane runs whenever the agent supplied hits, whatever the mode profile
  // listed. It searched already; its hits are never silently discarded.
  const lane: BackendKind[] = options.webResults?.length ? ["claude"] : [];
  return [...new Set([...lane, ...discovery, ...ceiling])];
}

// The recall knobs `--search max` raises, for any the caller did not pin.
// `pages` and `webBreadth` are capped at 5 by the CLI, so these ARE the limits.
export const MAX_PROFILE_KNOBS = { pages: 5, webBreadth: 5, rounds: 2 } as const;

/** What `--search max` overrides, so the override is never silent. */
export function ignoredByMaxProfile(options: GatherOptions): string[] {
  if (resolveSearchProfile(options) !== "max") return [];
  const out: string[] = [];
  if (options.webEngine !== "auto") out.push("--web-engine");
  return out;
}

// Merge each backend's ranked list into one ranking by Reciprocal Rank Fusion
// over an IDENTITY key (DOI / arXiv id, else canonical URL), so the same work
// surfaced by several backends collapses to one entry instead of eating several
// source slots. On collision, prefer the copy that already carries text and
// merge their metadata.
export function fuse(lists: RawSource[][]): RawSource[] {
  const fused = rrf(lists, identityKey);
  const best = new Map<string, RawSource>();
  // How many INDEPENDENT backend lists surfaced each identity. Cross-engine
  // agreement is evidence no single engine can manufacture, and unlike a host
  // list it needs nothing hardcoded — it falls out of the fusion we already do.
  // Recorded, never scored: RRF already rewards agreement through rank.
  const foundBy = new Map<string, number>();
  for (const list of lists) {
    const seenInList = new Set<string>();
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

// The query variants a run searches with: agent-supplied `--queries` take over
// (the agent knows the domain better than the regex planner), deduped and capped
// by depth so a long list can't explode fan-out on rate-limited backends; else
// fall back to the deterministic planner. Single-query backends always use the
// original question (see registry), so this only widens the multi-query fan-out.
export function resolveVariants(options: GatherOptions): string[] {
  if (options.queries?.length) {
    // Agent-supplied variants earn a HIGHER cap (2/4/6 by depth) than the
    // deterministic planner's (1/2/3, see planVariants in util.ts): the agent
    // knows the domain, so its phrasings are worth more fan-out budget. The
    // divergence is intentional — keep the two in sync only in spirit, and see
    // tests/gather.test.ts which pins both so a change here is a conscious one.
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
  const profile = resolveSearchProfile(options);
  // `max` raises every recall knob the caller left alone. Done here, before the
  // knobs are read below, so the ceiling applies to the cascade, the pagination
  // and the gap round alike — and `??=` keeps an explicit value the caller pinned.
  if (profile === "max") {
    options.pages ??= MAX_PROFILE_KNOBS.pages;
    options.webBreadth ??= MAX_PROFILE_KNOBS.webBreadth;
    options.rounds ??= MAX_PROFILE_KNOBS.rounds;
  }
  const variants = resolveVariants(options);
  // How many result pages each web engine fetches and how many engines the auto
  // cascade fuses — default by depth, overridable via --pages / --web-breadth.
  // Set options.pages so the backends (which read ctx.options.pages) see it.
  const effPages = Math.max(1, options.pages ?? PAGES_PER_DEPTH[options.depth] ?? 1);
  options.pages = effPages;
  const breadth = Math.max(1, options.webBreadth ?? WEB_BREADTH_PER_DEPTH[options.depth] ?? 1);
  const acceptLanguage = acceptLanguageHeader(options.lang, options.region);
  const ctx: RunContext = { question: options.question, mode, options, variants };

  // Run the mode's non-web backends in parallel, and the general-web discovery
  // engines as a resilient fallback cascade. An explicit --backends override or
  // a profile with no web engine just runs everything as-is (the user asked for
  // exactly those backends).
  const explicit = !!options.backends?.length;
  const webBackends = backends.filter((b) => DISCOVERY.includes(b));
  let results: BackendResult[];
  if (explicit || webBackends.length === 0) {
    results = await runBackends(backends, ctx);
  } else {
    const rest = backends.filter((b) => !DISCOVERY.includes(b));
    // `auto` augments the cascade with the broader fallback engines; a pinned
    // engine cascades over just the discovery engine(s) the profile resolved to.
    const cascade = options.webEngine === "auto" ? [...DISCOVERY] : DISCOVERY.filter((d) => webBackends.includes(d));
    const [restResults, webResults] = await Promise.all([runBackends(rest, ctx), runWebCascade(cascade, ctx, breadth)]);
    results = [...restResults, ...webResults];
  }

  // --seed-domains: when the agent knows the authoritative hosts for a topic
  // (vendor eng blogs / official docs), run one extra targeted `site:<domain>`
  // web search per domain (cap 3) so the primary source is actually retrieved —
  // keyless discovery otherwise surfaced 0/5 must-hit vendor docs in the eval.
  // Deterministic: results still come from real searches, no synthetic URLs.
  const seedDomains = (options.seedDomains ?? []).slice(0, 3);
  if (seedDomains.length && webBackends.length > 0 && !explicit) {
    const cascade = options.webEngine === "auto" ? [...DISCOVERY] : DISCOVERY.filter((d) => webBackends.includes(d));
    const kw = rankedKeywords(options.question).slice(0, 4).join(" ");
    const seedResults = await Promise.all(
      seedDomains.map((d) => {
        const q = `site:${d} ${kw}`.trim();
        return runWebCascade(cascade, { ...ctx, question: q, variants: [q], options: { ...options, pages: 1 } }, 1);
      }),
    );
    results = [...results, ...seedResults.flat()];
  }

  const excluded = (it: RawSource): boolean => {
    const d = domainOf(it.url);
    return !options.excludeDomains.some((ex) => d === ex || d.endsWith("." + ex));
  };
  // Fetches are cached across rounds by canonical URL so the gap round never
  // re-fetches a page round 1 already hydrated.
  const hydrateCache = new Map<string, ExtractResult & { cached?: boolean }>();
  // Pages served from the on-disk cache instead of the network, across every
  // round of this run. Recorded on the manifest so a dossier is self-describing
  // about how fresh its page bodies are.
  let cacheHits = 0;
  // Wayback dead-link rescues are capped per run so a page full of dead links
  // can't fan out into dozens of archive.org round-trips.
  let waybackUsed = 0;
  const WAYBACK_CAP = 5;
  // Pages whose text came from a self-hosted Firecrawl rather than the built-in
  // reader. Reported as ONE note (like the cache-hit count) instead of one per
  // page, so a dossier says how it was extracted without drowning in notes.
  // Which extractor actually read each page, tallied so the run can REPORT what the
  // optional helpers did. Everything here is skipped in silence when absent, and
  // that silence is why a container can sit up for weeks without being noticed as
  // unused — see the `services` block on the manifest.
  const extractorUse = new Map<string, number>();
  const tallyExtractor = (res: { extractor?: string }) => {
    const k = res.extractor ?? "native";
    extractorUse.set(k, (extractorUse.get(k) ?? 0) + 1);
  };
  const extractOpts = { acceptLanguage, firecrawl: options.firecrawl };

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
      if (it.text?.trim()) {
        it.fullText = true; // a content backend already carried the real text
        return;
      }
      const key = canonicalizeUrl(it.url);
      let res = hydrateCache.get(key);
      if (!res) {
        res = await cachedFetchAndExtract(it.url, extractOpts, !!options.cache);
        if (res.cached) cacheHits++;
        tallyExtractor(res);
        hydrateCache.set(key, res);
      }
      if (res.finalUrl && res.finalUrl !== it.url) it.url = res.finalUrl; // follow redirects (provenance + exclude re-check)
      if (res.note) hydrateNotes.push(res.note);

      let text = res.text?.trim() ? res.text : "";
      let junk = text ? looksLikeJunkExtraction(text) : undefined;
      // A wall's <title> is boilerplate too ("Checking your browser - reCAPTCHA")
      // — drop it with the body so a rescued page isn't labelled by the wall.
      let title = junk ? undefined : res.title;

      // The page gave us nothing usable (failed, empty, or a consent/anti-bot
      // wall). Try same-document alternates before giving up on full text: the
      // backend's own fallback URL — e.g. arXiv points `url` at /html/<id>,
      // which 404s for many papers, but carries meta.absUrl (the abstract page)
      // — then the provider's text endpoint (PubMed's HTML throttles to a
      // reCAPTCHA; E-utilities keeps serving the abstract). `it.url` never
      // changes: only where the TEXT came from does.
      if (!text || junk) {
        const absUrl = typeof it.meta?.absUrl === "string" ? it.meta.absUrl : undefined;
        const candidates = [absUrl, resolveProvider(it.url).textUrl, absUrl ? resolveProvider(absUrl).textUrl : undefined];
        for (const cand of [...new Set(candidates)]) {
          if (!cand || cand === it.url) continue;
          const altKey = canonicalizeUrl(cand);
          let alt = hydrateCache.get(altKey);
          if (!alt) {
            alt = await cachedFetchAndExtract(cand, extractOpts, !!options.cache);
            if (alt.cached) cacheHits++;
            tallyExtractor(alt);
            hydrateCache.set(altKey, alt);
          }
          if (alt.text?.trim() && !looksLikeJunkExtraction(alt.text)) {
            text = alt.text;
            junk = undefined;
            title = title || alt.title;
            it.meta = { ...it.meta, textVia: cand };
            hydrateNotes.push(`Primary page for ${it.url} was unusable — hydrated the fallback ${cand} instead.`);
            break;
          }
        }
      }

      // Dead-link rescue: the origin is gone/blocked (404/410/451/403) and we
      // got nothing — try the Wayback Machine's closest snapshot before dropping
      // to the snippet. Capped per run; the ORIGINAL url stays the source url.
      if (!text && DEAD_LINK_STATUS.has(res.status) && waybackUsed < WAYBACK_CAP && !process.env.ULTRASEARCH_NO_WAYBACK) {
        waybackUsed++; // reserve the slot synchronously (before any await) so the cap holds under concurrency
        const wb = await rescueViaWayback(it.url, extractOpts);
        if (wb) {
          text = wb.text;
          junk = undefined;
          title = title || wb.title;
          it.meta = { ...it.meta, waybackSnapshot: wb.timestamp };
          hydrateNotes.push(`Recovered ${it.url} from the Wayback Machine (snapshot ${wb.timestamp}).`);
        }
      }

      // Junk rescue via Firecrawl. A consent wall, an "enable JavaScript" shell
      // or an anti-bot interstitial extracts to boilerplate the regex reader
      // cannot see past, and those pages currently contribute NOTHING but a
      // snippet. A real browser can get past most of them, so re-extract through
      // Firecrawl before settling for the snippet. Skipped when this text ALREADY
      // came from Firecrawl (re-asking would return the same wall).
      if (text && junk && res.extractor !== "firecrawl") {
        const wall = junk;
        const fc = await scrapeViaFirecrawl(it.url, { firecrawl: options.firecrawl });
        if (fc.data?.markdown && !looksLikeJunkExtraction(fc.data.markdown)) {
          text = fc.data.markdown;
          junk = undefined;
          title = title || fc.data.title;
          tallyExtractor({ extractor: "firecrawl" });
          // Fold the rescue back into the in-process hydrate cache, so a second
          // assemble pass (the --rounds 2 gap round) reuses it rather than
          // re-scraping — and so the run counts this page exactly once.
          hydrateCache.set(key, { ...res, text: fc.data.markdown, title, extractor: "firecrawl" });
          hydrateNotes.push(`Extraction from ${it.url} looked like a ${wall} — re-extracted it with Firecrawl.`);
        }
      }

      if (text && !junk) {
        it.text = text;
        it.fullText = true;
        if (!it.snippet) it.snippet = bestExcerpt(text, options.question);
        if ((!it.title || it.title === it.url) && title) it.title = title;
      } else {
        // Page fetch failed, empty, or looked like a consent/anti-bot wall — fall
        // back to the search snippet so boilerplate can't masquerade as real
        // content. A snippet-only source has only a short body, so the BM25
        // content score already down-ranks it; the flag makes it visible.
        if (junk && text) hydrateNotes.push(`Extraction from ${it.url} looks like a ${junk} — kept as snippet only.`);
        it.text = it.snippet || "";
        it.fullText = false;
      }
    });

    let withContent = pool.filter((it) => it.text?.trim() || it.snippet.trim());
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
    const isSeedDomain = (url: string): boolean => {
      const d = domainOf(url);
      return seedDomains.some((s) => d === s || d.endsWith("." + s));
    };
    withContent.forEach((it, i) => {
      const content = rawContent[i]! / contentMax;
      const rrfN = it.score / rrfMax;
      // A seeded primary domain is ranked as primary (≥0.95) regardless of its
      // backend/domain class — the agent vouched for it explicitly.
      const trust = Math.max(trustScore(it.url, it.backend), isSeedDomain(it.url) ? 0.95 : 0);
      const recency = recencyScore(it.meta, minYear, maxYear);
      it.score = Number((0.45 * rrfN + 0.35 * content + 0.15 * trust + 0.05 * recency).toFixed(6));
      // Keep the COMPONENTS, not just the blend. Without them a weighting can
      // only be evaluated by re-running, and two runs never return the same
      // pool — so "is 0.15 the right weight for trust?" was unanswerable. With
      // them, any blend replays exactly against a dossier already on disk.
      it.meta = { ...it.meta, rank: { rrf: round4(rrfN), content: round4(content), trust: round4(trust), recency: round4(recency) } };
    });
    withContent.sort((a, b) => b.score - a.score || a.url.localeCompare(b.url));

    // Relevance floor: drop off-topic noise before the near-dup pass and slice.
    // A candidate is off-topic when it has no query-term overlap (or matched only
    // on a numeric false-friend), or when its hydrated text is a Wikipedia-style
    // disambiguation stub ("… may refer to:"). Forced into the off-topic bucket
    // by returning no matched terms — the floor's safety valve keeps a thin pool
    // from emptying itself.
    const matchedByUrl = new Map(docs.map((d) => [d.id, bm25MatchedTerms(bm25, d)]));
    const isDisambiguation = (it: RawSource): boolean => /^.{0,80}?\bmay (also )?refer to\b/i.test((it.text || "").trim());
    const floor = Math.min(RECALL_FLOORS[options.depth], options.maxSources);
    const { kept, dropped } = applyRelevanceFloor(withContent, (it) => (isDisambiguation(it) ? [] : (matchedByUrl.get(it.url) ?? [])), bm25.queryTerms, floor);
    const floorDropped = dropped.length;
    const near = dedupeNearDuplicates(kept);
    // Break up topical monopolies before handing the list over. Measured on a
    // real `topic` pool: eight content-marketing pages rewriting each other held
    // ranks 6-20; this takes that to five and lifts a primary source into the
    // top 20. A `research` pool is left byte-identical — there was nothing
    // redundant to demote. Reorders only, never drops.
    const ordered = diversify(near.items, (it) => new Set(bm25Tokenize((it.text || it.snippet || "").slice(0, 20000))));
    // No final cut. Everything that was fetched, cleaned, found on-topic and
    // de-duplicated is KEPT. `--max-sources` bounds how many candidates get
    // HYDRATED (the network cost, applied at `pool` above) — it is a retrieval
    // budget, not a quota on the dossier. Throwing away a page already fetched
    // and judged relevant is pure waste, and it was silent: the run reported
    // duplicates, near-duplicates and off-topic drops but never the cap.
    //
    // This also retires the lane-retention rule that used to live here: when
    // nothing is displaced, nothing needs protecting from displacement.
    return {
      merged: ordered,
      withContent: kept,
      hydrateNotes,
      droppedDup,
      nearDropped: near.dropped,
      floorDropped,
      queryTerms: bm25.queryTerms,
    };
  }

  const lists = results.map((r) => [...r.items].sort((a, b) => b.score - a.score));
  let r = await assemble(lists);

  // Optional gap round (--rounds ≥ 2, web discovery active): if some of the
  // question's terms are under-covered by the top sources, issue ONE focused web
  // cascade for them and re-assemble the union — recall insurance for the long
  // tail the first pass missed.
  let gapNote: string | undefined;
  if ((options.rounds ?? 1) >= 2 && webBackends.length > 0 && !explicit) {
    // Same computation the coverage map reports (same top-10 pool, same floor),
    // so the gap round and the reported worklist can never disagree.
    const gaps = underCovered(termCoverage(r.withContent, r.queryTerms));
    if (gaps.length) {
      const seenTerm = new Set<string>();
      const gapQuery = [...rankedKeywords(options.question).slice(0, 2), ...gaps]
        .filter((t) => {
          const k = t.toLowerCase();
          if (seenTerm.has(k)) return false;
          seenTerm.add(k);
          return true;
        })
        .join(" ");
      const cascade = options.webEngine === "auto" ? [...DISCOVERY] : DISCOVERY.filter((d) => webBackends.includes(d));
      // The gap round is cheap targeted recall insurance: a single page, first
      // engine that satisfies perSource (breadth 1).
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
  // Both lanes that find pages without being in the DISCOVERY cascade belong in
  // the "engines" line: the WebSearch lane, and Firecrawl's /search once
  // `--search max` puts it to work. Reporting 10 Firecrawl hits under a line
  // that names only marginalia is how a lane goes unnoticed.
  const enginesFused = [...new Set(backendsUsed.filter((b) => DISCOVERY.includes(b) || b === "claude" || b === "firecrawl"))];
  const timings: Record<string, number> = {};
  for (const res of results) if (res.ms !== undefined) timings[res.backend] = res.ms;
  timings.total = Date.now() - t0;

  // Thin-dossier signal: the recall floor is the depth's target, clamped to what
  // the run could keep (--max-sources). A run below it is flagged so the agent
  // enriches before writing rather than reasoning over too little evidence.
  const floor = Math.min(RECALL_FLOORS[options.depth], options.maxSources);
  const thin = merged.length < floor;

  // Which of the question's own terms the kept sources barely mention. Free (the
  // extracts are already in memory) and far more actionable than a bare count:
  // it tells the agent WHICH angle to enrich, not just that something is missing.
  const coverageTerms = termCoverage(r.withContent, r.queryTerms);
  const under = underCovered(coverageTerms);
  const ignoredFlags = ignoredByExplicitBackends(options);

  // What the harness WebSearch lane actually contributed. `supplied: 0` is the
  // interesting case: a run that had no lane at all, which is worth SAYING in a
  // tool whose best engine is the agent's own WebSearch.
  const supplied = options.webResults?.length ?? 0;
  const laneKept = merged.filter((it) => it.backend === "claude").length;
  const webSearch = { supplied, rejected: options.webResultsRejected ?? 0, kept: laneKept };

  // `ingest` needs a dossier on disk, so under --stdout the way back into the
  // evidence is the agent reading the pages itself.
  const bridge = options.stdout ? "and read those pages directly before answering" : "and fold the round in with `ingest --web-results` before writing";

  // What the optional helpers actually contributed this run — the answer to
  // "the container is up, is anything using it?".
  const searxngResult = results.find((res) => res.backend === "searxng");
  const services: ManifestServices = {
    searxng: { requested: backends.includes("searxng"), sources: searxngResult?.items.length ?? 0 },
    firecrawl: { pages: extractorUse.get("firecrawl") ?? 0 },
    pdf: Object.fromEntries([...extractorUse].filter(([k]) => k === "pdf-inspector" || k === "pdftotext")),
  };
  const notes = [
    ...results.flatMap((res) => res.notes),
    // Deduped: every per-page hydrate note names its URL and so is unique, but
    // the instance-level ones (an explicitly-configured Firecrawl that is down)
    // would otherwise repeat once per page in the pool.
    ...new Set(r.hydrateNotes),
    ...(r.droppedDup > 0 ? [`Dropped ${r.droppedDup} duplicate result(s) across backends.`] : []),
    ...(r.nearDropped > 0 ? [`Collapsed ${r.nearDropped} near-duplicate (syndicated) page(s).`] : []),
    ...(r.floorDropped > 0 ? [`Relevance floor dropped ${r.floorDropped} off-topic result(s) with no meaningful query-term overlap.`] : []),
    ...(seedDomains.length ? [`Ran a targeted site: search for seed domain(s): ${seedDomains.join(", ")}.`] : []),
    ...(gapNote ? [gapNote] : []),
    ...(explicit
      ? [
          `--backends pinned retrieval to ${backends.join(", ")}: the resilient web cascade is OFF` +
            (ignoredFlags.length ? `, and ${ignoredFlags.join(" / ")} ${ignoredFlags.length > 1 ? "were" : "was"} ignored` : "") +
            `. Drop --backends to get the auto cascade, seed-domain and gap rounds back.`,
        ]
      : []),
    // The WebSearch lane, said out loud in every direction. Silence here is
    // exactly the failure this whole layer exists to fix: the best engine
    // available to the caller going unused, and nothing recording the fact.
    ...(webSearch.rejected > 0
      ? [`--web-results: ignored ${webSearch.rejected} entr${webSearch.rejected === 1 ? "y" : "ies"} with no usable http(s) URL.`]
      : []),
    ...(supplied > 0
      ? [`WebSearch lane: ${supplied} agent-supplied hit(s), ${laneKept} kept after fusion, hydration and the relevance floor.`]
      : explicit
        ? []
        : [
            `No WebSearch lane this run: discovery fell back to the keyless engines, which are best-effort. ` +
              `If you have a WebSearch tool, run it and pass the hits with --web-results <file.json> — it is the strongest engine available here.`,
          ]),
    // `max` is a promise of the ceiling, and the ceiling includes ~3 GB of
    // containers the engine cannot start for you. A run that asked for max and
    // silently got full-minus-the-stack is the worst outcome here: it LOOKS
    // exhaustive. So say exactly which part was missing.
    ...(profile === "max"
      ? [
          `--search max: every lane at its ceiling (pages ${options.pages}, breadth ${options.webBreadth}, ${options.rounds} round(s), Firecrawl /search in discovery).`,
          ...(ignoredByMaxProfile(options).length
            ? [`--search max supersedes ${ignoredByMaxProfile(options).join(" / ")}: max means every engine, not one.`]
            : []),
          // Do NOT guess why. A running SearXNG whose upstreams are throttling
          // (brave 429, duckduckgo CAPTCHA) contributes nothing and reports
          // exactly that in its own note — telling the reader "the container is
          // down" would contradict a more accurate note in the same dossier and
          // send them to restart something that is already healthy.
          ...(services.searxng.sources === 0
            ? [
                `⚠ max asked for SearXNG and it contributed nothing. Its own note above says why (a stopped container, or its upstream engines throttling). \`ultrasearch doctor\` tells the two apart.`,
              ]
            : []),
          ...(services.firecrawl.pages === 0
            ? [
                `⚠ max asked for Firecrawl and no page came back through it — the stack is down. Start it: \`docker compose --profile search --profile extract up -d --wait\`. ` +
                  `Without it you lose browser-rendered extraction and the consent-wall rescue, so this run is max-minus-the-stack.`,
              ]
            : []),
        ]
      : []),
    ...(profile === "light" && !explicit
      ? [
          `--search light: the keyless scraped cascade and SearXNG are OFF (the WebSearch lane is the discovery). ` +
            `Firecrawl still extracts. Use --search full to fuse the keyless engines in as well.`,
          ...(seedDomains.length
            ? [
                `--seed-domains needs a discovery engine to run its site: queries; --search light has none. Use --search full, or pass those pages in --web-results.`,
              ]
            : []),
          ...((options.rounds ?? 1) >= 2 ? [`--rounds 2 needs a discovery engine for its gap search; --search light has none. Use --search full.`] : []),
        ]
      : []),
    ...(cacheHits > 0 ? [`Fetch cache served ${cacheHits} page(s) from disk (up to 24h old). Use --no-cache for an all-live run.`] : []),
    ...(services.firecrawl.pages > 0
      ? [`Firecrawl cleaned ${services.firecrawl.pages} page(s) (self-hosted, browser-rendered main-content markdown instead of the built-in HTML stripper).`]
      : []),
    // The optional helpers are silent by design when absent, so ONE line per run
    // says what they actually did. Without it a container can be up for weeks,
    // never be queried, and leave no trace of the fact anywhere.
    `Helpers: ${describeServices(services)}`,
    ...(thin
      ? [`Thin dossier: only ${merged.length} on-topic source(s) (recall floor ${floor}). Enrich the thin areas with your own WebSearch ${bridge}.`]
      : []),
    ...(under.length
      ? [
          `Under-covered term(s): ${under.join(", ")} — fewer than ${UNDER_COVERED_MIN} of the top sources mention them. ` +
            `Search these yourself ${bridge}, or say so under "Open questions".`,
        ]
      : []),
    options.stdout ? ENRICH_NUDGE_NO_WRITE : ENRICH_NUDGE,
  ];

  const manifest: Manifest = {
    version: VERSION,
    question: options.question,
    mode: options.mode,
    depth: options.depth,
    lang: options.lang,
    ...(options.region ? { region: options.region } : {}),
    pages: effPages,
    backends,
    backendsUsed,
    ...(enginesFused.length ? { enginesFused } : {}),
    webSearch,
    searchProfile: profile,
    sourceCount: merged.length,
    maxSources: options.maxSources,
    builtAt: new Date().toISOString(),
    slug: `${options.mode}-${slugify(options.question)}`,
    tiers: ["SUMMARY.md", "REPORT.md"],
    extras: mode.extras,
    notes,
    timings,
    ...(thin ? { recallFloor: { count: merged.length, floor } } : {}),
    ...(coverageTerms.length ? { coverage: { terms: coverageTerms, under } } : {}),
    cache: { enabled: !!options.cache, hits: cacheHits },
    services,
  };

  const dir = options.out ?? defaultRunDir(options.mode, options.question);
  const { sources } = writeDossier(dir, merged, manifest, mode.template);
  writeBibtex(dir, sources, mode.extras);
  return { dir, sources, manifest: { ...manifest, sourceCount: sources.length } };
}
