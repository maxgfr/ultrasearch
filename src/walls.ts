import { cachedFetchAndExtract } from "./cache.js";
import { type ExtractResult, looksLikeWall } from "./engine.js";

// What a read must carry before it is worth citing lives in the engine now
// (webindex ≥ 1.36: `looksLikeWall`, `wallPattern`, `usefulChars`…, lifted from
// this file). Re-exported so the import path the modules use stays the same;
// the cache-bypassing read below is this skill's policy and stays here.
export { isWordedWall, looksLikeWall, MIN_USEFUL_CHARS, usefulChars, wallPattern } from "./engine.js";

/**
 * A cached read that refuses to serve a cached WALL.
 *
 * The cache stores whatever a read got, and a host that was throttling at the
 * time stored its interstitial: every later read inside the TTL would be served
 * the same wall, `--no-cache` or a fresh dossier being the only way past it. So
 * a cached copy that is a wall is read again live.
 *
 * Live means a read with the cache off for THIS call only. It used to switch
 * the engine's cache mode to `refresh` for the duration, which also overwrote
 * the stored wall — but the mode is process-global, and hydration runs several
 * reads at once: every other worker skipped the disk cache for as long as the
 * live read took, a browser render included. The price of the narrower bypass
 * is that the stored wall stays until its TTL runs out, so a later run reads
 * that one page live again; nobody else pays for it.
 */
export async function readPastCachedWall(
  url: string,
  opts: Parameters<typeof cachedFetchAndExtract>[1],
  enabled: boolean,
): Promise<ExtractResult & { cached?: boolean }> {
  const res = await cachedFetchAndExtract(url, opts, enabled);
  if (!res.cached || !res.text?.trim() || !looksLikeWall(res.text)) return res;
  return cachedFetchAndExtract(url, opts, false);
}
