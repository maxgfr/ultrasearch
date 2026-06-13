import type { Backend, BackendResult, RawSource } from "../types.js";
import { httpJson, htmlToText } from "./fetch.js";
import { sinceEpochSeconds } from "../util.js";

// Hacker News via the keyless Algolia API. Stories (not comments) ranked by
// relevance; text is the story text when present, else title + discussion link.
export const hackernewsBackend: Backend = async (ctx): Promise<BackendResult> => {
  const n = Math.max(3, Math.min(15, ctx.options.perSource));
  const since = sinceEpochSeconds(ctx.options.since);
  const url =
    `https://hn.algolia.com/api/v1/search?query=${encodeURIComponent(ctx.question)}&tags=story&hitsPerPage=${n}` +
    (since ? `&numericFilters=created_at_i>${since}` : "");
  const r = await httpJson("GET", url, undefined, { timeoutMs: 10000 });
  if (!r.ok || !Array.isArray(r.data?.hits)) {
    return { backend: "hackernews", items: [], notes: [`Hacker News search failed (status ${r.status}).`] };
  }
  const items: RawSource[] = r.data.hits.slice(0, n).map((h: any, i: number): RawSource => {
    const title = String(h.title ?? h.story_title ?? "HN story");
    const discussion = `https://news.ycombinator.com/item?id=${h.objectID}`;
    const storyText = h.story_text ? htmlToText(String(h.story_text)) : "";
    return {
      url: h.url ? String(h.url) : discussion,
      title,
      backend: "hackernews",
      score: n - i,
      snippet: (storyText || title).slice(0, 360),
      text: `${title}\n\n${storyText}\nHN discussion: ${discussion}`,
      meta: { points: Number(h.points ?? 0) },
    };
  });
  return {
    backend: "hackernews",
    items,
    notes: items.length ? [`Hacker News returned ${items.length} story(ies).`] : ["Hacker News returned no results."],
  };
};
