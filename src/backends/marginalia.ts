import type { Backend, BackendResult, RawSource } from "../types.js";
import { httpJson } from "./fetch.js";
import { acceptLanguageHeader } from "../locale.js";

// Discovery via Marginalia's free public JSON API (no key). Marginalia indexes
// the small, non-commercial, text-first long-tail web that DDG/Mojeek and the
// big engines systematically under-surface, so it both broadens recall and is
// the final fallback in the web cascade. Best-effort: a missing/changed API
// degrades to an honest note, never a throw. Its index is English-centric and
// the public API exposes no reliable page offset, so it stays single-page; we
// still send Accept-Language so a localized result is preferred where available.
export const marginaliaBackend: Backend = async (ctx): Promise<BackendResult> => {
  const url = `https://api.marginalia-search.com/public/search/${encodeURIComponent(ctx.question)}?count=${
    ctx.options.perSource * 2
  }`;
  const acceptLanguage = acceptLanguageHeader(ctx.options.lang, ctx.options.region);
  const r = await httpJson("GET", url, undefined, { timeoutMs: 12000, acceptLanguage });
  if (!r.ok) {
    const why =
      r.status === 429 || r.status === 503 ? `rate-limited (HTTP ${r.status})` : `unreachable (status ${r.status || 0})`;
    return { backend: "marginalia", items: [], notes: [`Marginalia ${why}.`] };
  }
  const results: any[] = Array.isArray(r.data?.results) ? r.data.results : [];
  const items: RawSource[] = [];
  results.slice(0, ctx.options.perSource * 2).forEach((x, i) => {
    if (!x?.url || typeof x.url !== "string") return;
    items.push({
      url: x.url,
      title: String(x.title ?? x.url),
      backend: "marginalia",
      score: results.length - i,
      snippet: String(x.description ?? "").slice(0, 360),
      lang: ctx.options.lang,
    });
  });
  return {
    backend: "marginalia",
    items,
    notes: items.length ? [`Marginalia returned ${items.length} result(s).`] : [`Marginalia returned no results.`],
  };
};
