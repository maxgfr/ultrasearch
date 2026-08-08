// Provider resolution — which URL to fetch, which URL to cite.
//
// Generic across providers by construction. Kept as an import path.

export { pubmedAbstractUrl, resolveProvider } from "./engine.js";
export type { ResolvedProvider } from "./engine.js";
