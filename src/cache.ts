import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { fetchAndExtract } from "./backends/fetch.js";
import { canonicalizeUrl, domainOf, fnv1a64 } from "./util.js";

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

// domain prefix (debuggability) + 64-bit hash of the canonical URL.
export function cachePath(url: string): string {
  const canon = canonicalizeUrl(url);
  const domain = domainOf(url).replace(/[^a-z0-9.-]/gi, "_") || "url";
  return join(cacheDir(), `${domain}-${fnv1a64(canon).toString(16)}.json`);
}

function ttlMs(): number {
  return envInt("ULTRASEARCH_CACHE_TTL_MS", DEFAULT_TTL_MS);
}

// Read a fresh cache entry, or undefined when missing / expired / unreadable.
function readCache(url: string, now: number): Extract | undefined {
  const p = cachePath(url);
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

function writeCache(url: string, res: Extract, now: number): void {
  try {
    mkdirSync(cacheDir(), { recursive: true });
    const entry: CacheEntry = { ...res, cachedAt: now };
    writeFileSync(cachePath(url), JSON.stringify(entry));
  } catch {
    /* a cache write must never break a run */
  }
}

// fetchAndExtract with an optional on-disk cache in front. `enabled` false ⇒
// byte-identical to calling fetchAndExtract directly (no disk I/O). `now` is the
// current epoch ms, threaded in by the caller so this stays testable/pure w.r.t.
// the clock.
export async function cachedFetchAndExtract(url: string, opts: { acceptLanguage?: string } = {}, enabled = false, now = Date.now()): Promise<Extract> {
  if (!enabled) return fetchAndExtract(url, opts);
  const hit = readCache(url, now);
  if (hit) return hit;
  const res = await fetchAndExtract(url, opts);
  if (res.text?.trim()) writeCache(url, res, now); // cache successes only
  return res;
}
