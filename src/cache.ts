import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { fetchAndExtract, PDF_URL_RE, type ExtractorId } from "./backends/fetch.js";
import { firecrawlBase, probeFirecrawl } from "./backends/firecrawl.js";
import { canonicalizeUrl, domainOf, fnv1a64 } from "./util.js";
import { isNoWrite } from "./no-write.js";

// Opt-in on-disk fetch cache (--cache). The in-process hydrate cache only spans
// ONE gather; the deep tier fans out N separate `gather` processes (one per
// sub-question) that re-fetch overlapping URLs. This cache spans processes: a
// URL fetched by sub-question 1 is served from disk to sub-question 2.
//
// Zero-dependency (node:fs only). Keyed by canonical URL, so tracking-param /
// case variants of the same page share an entry. Only SUCCESSFUL extractions
// are cached — a failed/empty fetch always re-tries. Entries expire by TTL and a
// corrupt/expired entry is ignored (and overwritten), never thrown.

type Extract = Awaited<ReturnType<typeof fetchAndExtract>>;
interface CacheEntry extends Extract {
  cachedAt: number; // ms epoch when written (threaded by the caller so TTL is testable)
}

function envInt(name: string, def: number): number {
  const v = Number(process.env[name]);
  return Number.isFinite(v) && v >= 0 ? Math.floor(v) : def;
}

// 24h default; override with ULTRASEARCH_CACHE_TTL_MS (0 = always stale → refetch).
const DEFAULT_TTL_MS = 24 * 60 * 60 * 1000;

export function cacheDir(): string {
  return process.env.ULTRASEARCH_CACHE_DIR || join(tmpdir(), "ultrasearch", "cache");
}

// domain prefix (debuggability) + 64-bit hash of the canonical URL AND the
// Accept-Language the fetch will send. Locale is part of the key because many
// sites serve a different body per language: without it, a `--lang de` run would
// be served the English body an earlier `--lang en` run cached, silently breaking
// the skill's "search the audience's language" rule.
//
// The EXTRACTOR is part of the key because the same URL yields materially
// different text depending on who read it — the built-in regex reader vs
// Firecrawl's browser-rendered main-content markdown. Without it, bringing
// Firecrawl up would be a no-op for a whole TTL: every page an earlier native
// run cached would be served from disk and shadow the better extraction.
//
// Entries written under an older key simply miss and get overwritten — no
// migration needed.
export function cachePath(url: string, acceptLanguage = "", extractor: CacheNamespace = "native"): string {
  const canon = canonicalizeUrl(url);
  const domain = domainOf(url).replace(/[^a-z0-9.-]/gi, "_") || "url";
  return join(cacheDir(), `${domain}-${fnv1a64(`${canon}\u0000${acceptLanguage}\u0000${extractor}`).toString(16)}.json`);
}

// The cache-key namespace a fetch made RIGHT NOW would use: Firecrawl when one
// is configured AND answering (the probe is memoised per process, so this costs
// a single refused connection at worst), else the built-in reader. Resolved
// before the cache is consulted so the lookup and the write that follows it
// agree on the key — and so bringing Firecrawl up or down immediately switches
// namespace instead of being masked by yesterday's entries.
//
// PDFs are the exception and share one namespace. They go through the extractor
// ladder, whose winning rung depends on which tools happen to be installed and
// is only known AFTER extraction — a pre-fetch prediction cannot name it, so
// filing PDFs under the rung that won would miss the cache on every single run.
// The rung is still reported on the source itself; it just isn't part of the key.
const PDF_CACHE_NS = "pdf" as const;
type CacheNamespace = ExtractorId | typeof PDF_CACHE_NS;

async function currentExtractor(opts: { firecrawl?: string }, url: string): Promise<CacheNamespace> {
  if (PDF_URL_RE.test(url)) return PDF_CACHE_NS;
  const base = firecrawlBase(opts);
  return base && (await probeFirecrawl(base)) ? "firecrawl" : "native";
}

function ttlMs(): number {
  return envInt("ULTRASEARCH_CACHE_TTL_MS", DEFAULT_TTL_MS);
}

// Read a fresh cache entry, or undefined when missing / expired / unreadable.
function readCache(url: string, now: number, acceptLanguage = "", extractor: CacheNamespace = "native"): Extract | undefined {
  const p = cachePath(url, acceptLanguage, extractor);
  if (!existsSync(p)) return undefined;
  try {
    const entry = JSON.parse(readFileSync(p, "utf8")) as CacheEntry;
    if (typeof entry.cachedAt !== "number" || now - entry.cachedAt > ttlMs()) return undefined;
    if (!entry.text?.trim()) return undefined; // only successes are cached; ignore anything else
    return entry;
  } catch {
    return undefined; // corrupt entry — ignore, it will be overwritten on the next success
  }
}

function writeCache(url: string, res: Extract, now: number, acceptLanguage = "", extractor: CacheNamespace = "native"): void {
  // Under no-write the cache degrades to READ-only rather than being disabled:
  // a plan-phase run is still served by whatever an earlier normal run left
  // here, it just never leaves a trace of its own. Deliberately not routed
  // through writeArtifact — a cache entry is not an artifact anyone wants
  // streamed back to them.
  if (isNoWrite()) return;
  try {
    mkdirSync(cacheDir(), { recursive: true });
    const entry: CacheEntry = { ...res, cachedAt: now };
    writeFileSync(cachePath(url, acceptLanguage, extractor), JSON.stringify(entry));
  } catch {
    /* a cache write must never break a run */
  }
}

// fetchAndExtract with an optional on-disk cache in front. `enabled` false ⇒
// byte-identical to calling fetchAndExtract directly (no disk I/O). `now` is the
// current epoch ms, threaded in by the caller so this stays testable/pure w.r.t.
// the clock.
export async function cachedFetchAndExtract(
  url: string,
  opts: { acceptLanguage?: string; firecrawl?: string } = {},
  enabled = false,
  now = Date.now(),
): Promise<Extract & { cached?: boolean }> {
  if (!enabled) return fetchAndExtract(url, opts);
  const lang = opts.acceptLanguage ?? "";
  const ns = await currentExtractor(opts, url);
  const hit = readCache(url, now, lang, ns);
  if (hit) return { ...hit, cached: true };
  const res = await fetchAndExtract(url, opts);
  // Cache successes only, filed under the extractor that ACTUALLY produced the
  // text — a Firecrawl run that fell back to the built-in reader for one page
  // must not leave that page sitting in Firecrawl's namespace. PDFs keep the
  // shared namespace resolved above, for the reason documented there.
  if (res.text?.trim()) writeCache(url, res, now, lang, ns === PDF_CACHE_NS ? PDF_CACHE_NS : (res.extractor ?? "native"));
  return res;
}
