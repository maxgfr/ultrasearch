import type { Backend, BackendResult, RawSource } from "../types.js";
import { mapLimit } from "../util.js";
import { httpJson, decodeEntities } from "./fetch.js";

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
  // Fetch summaries for the top pages (cap to keep it polite), CONCURRENTLY
  // (bounded) — this was the backend's latency floor. mapLimit preserves index
  // order, so the search-rank score (top.length - i) and item order are unchanged.
  const top = pages.slice(0, Math.min(limit, 6));
  let disambigSkipped = 0;
  const built = await mapLimit(top, 4, async (p: any, i): Promise<RawSource | null> => {
    if (!p?.key) return null;
    const summaryUrl = `${host}/api/rest_v1/page/summary/${encodeURIComponent(p.key)}`;
    const dr = await httpJson("GET", summaryUrl, undefined, { timeoutMs: 10000 });
    // A disambiguation page ("Mercury may refer to …") is a router, not a
    // source — the REST summary marks it `type: "disambiguation"`. Skip it at
    // the source so it never eats a slot or seeds off-topic fan-out.
    if (dr.data?.type === "disambiguation") {
      disambigSkipped++;
      return null;
    }
    // The REST API returns HTML entities (&amp; &quot; &#039;) in extracts and
    // search excerpts, and the excerpt also carries <span class="searchmatch">
    // highlight tags. Strip tags, then decode entities so titles/snippets/text
    // are clean prose (they surface verbatim in DOSSIER.md and the HTML report).
    const extract: string = dr.ok ? decodeEntities(String(dr.data?.extract ?? "")) : "";
    const pageUrl: string = dr.data?.content_urls?.desktop?.page ?? `${host}/wiki/${encodeURIComponent(p.key)}`;
    const descExcerpt = decodeEntities(String(p.excerpt ?? "").replace(/<[^>]+>/g, ""));
    const text = extract || descExcerpt;
    if (!text) return null;
    return {
      url: pageUrl,
      title: decodeEntities(String(p.title ?? p.key)),
      backend: "wikipedia",
      score: top.length - i,
      snippet: (descExcerpt || extract).slice(0, 360),
      text,
      lang,
    };
  });
  const items: RawSource[] = built.filter((x): x is RawSource => x !== null);

  const notes = items.length ? [`Wikipedia returned ${items.length} page(s).`] : [`Wikipedia returned no usable pages.`];
  if (disambigSkipped) notes.push(`Skipped ${disambigSkipped} disambiguation page(s).`);
  return { backend: "wikipedia", items, notes };
};
