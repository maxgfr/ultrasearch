import type { Backend, BackendResult, RawSource } from "../types.js";
import { fetchAndExtract, bestExcerpt } from "./fetch.js";

// Fetch an explicit set of URLs (from --url) and turn each into a source with
// full text. This is what `search --backend generic --url a,b` and
// `gather --backends generic --url a,b` use; single-URL ingestion into an
// existing dossier goes through `fetch`/`add-source` (src/enrich.ts).
export const genericBackend: Backend = async (ctx): Promise<BackendResult> => {
  const urls = ctx.options.urls ?? [];
  if (!urls.length) {
    return {
      backend: "generic",
      items: [],
      notes: ["generic backend needs --url <u,...>; nothing to fetch."],
    };
  }
  const items: RawSource[] = [];
  const notes: string[] = [];
  for (let i = 0; i < urls.length; i++) {
    const url = urls[i]!;
    const { text, title, note } = await fetchAndExtract(url);
    if (note) notes.push(note);
    if (!text) continue;
    items.push({
      url,
      title: title || url,
      backend: "generic",
      score: urls.length - i,
      snippet: bestExcerpt(text, ctx.question),
      text,
    });
  }
  return { backend: "generic", items, notes };
};
