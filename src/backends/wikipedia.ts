import type { Backend, BackendResult, RawSource } from "../types.js";
import { httpJson } from "./fetch.js";

// Wikipedia via the keyless REST API: search for pages, then pull each top
// page's summary extract as the source text. Language-aware via --lang.
export const wikipediaBackend: Backend = async (ctx): Promise<BackendResult> => {
  const lang = (ctx.options.lang || "en").split("-")[0]!;
  const host = `https://${lang}.wikipedia.org`;
  const limit = Math.max(3, Math.min(10, ctx.options.perSource));
  const searchUrl = `${host}/w/rest.php/v1/search/page?q=${encodeURIComponent(ctx.question)}&limit=${limit}`;
  const sr = await httpJson("GET", searchUrl, undefined, { timeoutMs: 10000 });
  if (!sr.ok || !Array.isArray(sr.data?.pages)) {
    return { backend: "wikipedia", items: [], notes: [`Wikipedia search failed (status ${sr.status}).`] };
  }

  const pages: any[] = sr.data.pages;
  const items: RawSource[] = [];
  // Fetch summaries for the top pages (cap to keep it polite).
  const top = pages.slice(0, Math.min(limit, 6));
  for (let i = 0; i < top.length; i++) {
    const p = top[i]!;
    if (!p?.key) continue;
    const summaryUrl = `${host}/api/rest_v1/page/summary/${encodeURIComponent(p.key)}`;
    const dr = await httpJson("GET", summaryUrl, undefined, { timeoutMs: 10000 });
    const extract: string = dr.ok ? String(dr.data?.extract ?? "") : "";
    const pageUrl: string =
      dr.data?.content_urls?.desktop?.page ?? `${host}/wiki/${encodeURIComponent(p.key)}`;
    const descExcerpt = String(p.excerpt ?? "").replace(/<[^>]+>/g, "");
    const text = extract || descExcerpt;
    if (!text) continue;
    items.push({
      url: pageUrl,
      title: String(p.title ?? p.key),
      backend: "wikipedia",
      score: top.length - i,
      snippet: (descExcerpt || extract).slice(0, 360),
      text,
      lang,
    });
  }

  return {
    backend: "wikipedia",
    items,
    notes: items.length ? [`Wikipedia returned ${items.length} page(s).`] : [`Wikipedia returned no usable pages.`],
  };
};
