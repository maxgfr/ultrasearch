import type { Backend, BackendResult, RawSource } from "../types.js";
import { cachedFetchAndExtract } from "../cache.js";
import { acceptLanguageHeader } from "../locale.js";
import { mapLimit } from "../util.js";
import { bestExcerpt } from "./fetch.js";

// Fetch an explicit set of URLs (from --url) and turn each into a source with
// full text. This is what `search --backend generic --url a,b` and
// `gather --backends generic --url a,b` use; single-URL ingestion into an
// existing dossier goes through `fetch`/`add-source` (src/enrich.ts).
//
// The URLs go through the SAME fetcher `gather` hydrates with (src/gather.ts):
// in parallel at --concurrency (default 6), through the opt-in on-disk cache
// (--cache), carrying the run's Accept-Language. Ten --url arguments used to
// cost ten round trips end to end, and --lang was silently ignored here while
// every other fetch in the run honoured it.
//
// Output is unchanged by the parallelism: mapLimit resolves in INPUT order, and
// notes/items/scores are built afterwards in one ordered pass over the original
// indices — never pushed from inside a worker, where completion order would
// leak into the result.
export const genericBackend: Backend = async (ctx): Promise<BackendResult> => {
  const urls = ctx.options.urls ?? [];
  if (!urls.length) {
    return {
      backend: "generic",
      items: [],
      notes: ["generic backend needs --url <u,...>; nothing to fetch."],
    };
  }
  const extractOpts = { acceptLanguage: acceptLanguageHeader(ctx.options.lang, ctx.options.region), firecrawl: ctx.options.firecrawl };
  const fetched = await mapLimit(urls, ctx.options.concurrency ?? 6, (url) => cachedFetchAndExtract(url, extractOpts, !!ctx.options.cache));
  const items: RawSource[] = [];
  const notes: string[] = [];
  for (let i = 0; i < urls.length; i++) {
    const url = urls[i]!;
    const { text, title, note, finalUrl } = fetched[i]!;
    if (note) notes.push(note);
    if (!text) continue;
    items.push({
      url: finalUrl || url, // record the post-redirect URL for provenance + exclude
      title: title || finalUrl || url,
      backend: "generic",
      score: urls.length - i,
      snippet: bestExcerpt(text, ctx.question),
      text,
    });
  }
  return { backend: "generic", items, notes };
};
