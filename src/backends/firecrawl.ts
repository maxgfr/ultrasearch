import type { Backend, BackendResult, RawSource } from "../types.js";
import { searchViaFirecrawl } from "../engine.js";

// Discovery via a self-hosted Firecrawl's `/search`.
//
// The CLIENT — probe, scrape, search, response mapping — now lives in the
// vendored webindex engine, because turning a URL into clean text is retrieval
// and every skill needs it. What stays here is the one part that is discovery:
// wrapping those hits as a Backend, which needs this skill's RawSource shape and
// its RunContext. That is the whole seam, and it needed no shim.
//
// An EXPLICIT engine only — not part of the `auto` cascade, because it needs
// ~3GB of containers running and its upstream is the same SearXNG the `searxng`
// backend already queries directly. Reach for it with `--backends firecrawl` or
// `--web-engine firecrawl` when you want Firecrawl's cleaned markdown to come
// back WITH the search hits.

// Re-exported so the rest of the tree keeps its existing import path.
export {
  FIRECRAWL_DEFAULT_BASE,
  firecrawlBase,
  firecrawlIsExplicit,
  looksLikeFirecrawl,
  probeFirecrawl,
  resetFirecrawlProbeCache,
  apiPrefix,
  mapScrapeResponse,
  mapSearchResponse,
  scrapeViaFirecrawl,
  searchViaFirecrawl,
  type FirecrawlOptions,
  type FirecrawlScrape,
  type FirecrawlHit,
  type ScrapeAttempt,
} from "../engine.js";

export const firecrawlBackend: Backend = async (ctx): Promise<BackendResult> => {
  const { hits, why } = await searchViaFirecrawl(ctx.question, ctx.options.perSource * 2, ctx.options);
  if (!hits) return { backend: "firecrawl", items: [], notes: [why ?? "Firecrawl search returned nothing."] };
  const items: RawSource[] = hits.slice(0, ctx.options.perSource * 2).map((h, i) => ({
    url: h.url,
    title: h.title,
    backend: "firecrawl" as const,
    score: hits.length - i,
    snippet: h.description,
    // Firecrawl only returns page markdown with a search hit when asked to
    // scrape each result; when it does, the gatherer skips re-fetching the page.
    ...(h.markdown ? { text: h.markdown } : {}),
    lang: ctx.options.lang,
  }));
  return {
    backend: "firecrawl",
    items,
    notes: items.length ? [`Firecrawl search returned ${items.length} result(s).`] : [`Firecrawl search returned no results.`],
  };
};
