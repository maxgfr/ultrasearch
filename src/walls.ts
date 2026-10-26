import { cachedFetchAndExtract } from "./cache.js";
import { cacheMode, type ExtractResult, looksLikeWall, setCacheMode } from "./engine.js";

// What a read must carry before it is worth citing lives in the engine now
// (webindex ≥ 1.36: `looksLikeWall`, `wallPattern`, `usefulChars`…, lifted from
// this file). Re-exported so the import path the modules use stays the same;
// the cache-bypassing read below is this skill's policy and stays here.
export { isWordedWall, looksLikeWall, MIN_USEFUL_CHARS, proseOutweighsWall, usefulChars, wallPattern } from "./engine.js";

// How many reads are currently bypassing the cache. The engine's cache mode is
// process-global, and hydration runs several reads at once: a plain save/restore
// would let the first read to finish switch the bypass off under the others —
// or, finishing in the wrong order, leave it on for the rest of the process.
let bypassing = 0;
let saved: ReturnType<typeof cacheMode> | undefined;

/**
 * A cached read that refuses to serve a cached WALL.
 *
 * The cache stores whatever a read got, and a host that was throttling at the
 * time stored its interstitial: every later read inside the TTL is served the
 * same wall, `--no-cache` or a fresh dossier being the only way past it. So a
 * cached copy that is a wall is re-read live (the engine's refresh mode) — which
 * also overwrites the stored copy when the live read is good.
 */
export async function readPastCachedWall(
  url: string,
  opts: Parameters<typeof cachedFetchAndExtract>[1],
  enabled: boolean,
): Promise<ExtractResult & { cached?: boolean }> {
  const res = await cachedFetchAndExtract(url, opts, enabled);
  if (!res.cached || !res.text?.trim() || !looksLikeWall(res.text)) return res;
  if (bypassing++ === 0) {
    saved = cacheMode();
    setCacheMode({ refresh: true });
  }
  try {
    return await cachedFetchAndExtract(url, opts, enabled);
  } finally {
    if (--bypassing === 0 && saved) {
      setCacheMode(saved);
      saved = undefined;
    }
  }
}
