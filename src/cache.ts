// The opt-in on-disk fetch cache — public surface.
//
// The implementation now lives in the vendored webindex engine
// (github.com/maxgfr/webindex). The cache directory is namespaced by brand, so
// the three skills sharing this engine never serve each other's pages.

export { cacheDir, cachePath, cachedFetchAndExtract } from "./engine.js";
