import type { Backend, BackendResult, RawSource } from "../types.js";
import { httpGet, decodeEntities } from "./fetch.js";

function tag(block: string, name: string): string {
  const m = new RegExp(`<${name}[^>]*>([\\s\\S]*?)<\\/${name}>`, "i").exec(block);
  return m ? decodeEntities(m[1]!.replace(/\s+/g, " ").trim()) : "";
}

// arXiv via its keyless Atom API. Returns each paper's abstract as text, with
// arXiv id / authors / year metadata for the BibTeX export.
export const arxivBackend: Backend = async (ctx): Promise<BackendResult> => {
  const n = Math.max(3, Math.min(15, ctx.options.perSource));
  const url = `http://export.arxiv.org/api/query?search_query=${encodeURIComponent("all:" + ctx.question)}&start=0&max_results=${n}`;
  const r = await httpGet(url, { accept: "application/atom+xml", timeoutMs: 12000 });
  if (!r.ok || !r.body) {
    return { backend: "arxiv", items: [], notes: [`arXiv search failed (status ${r.status}).`] };
  }
  const entries = r.body.split(/<entry>/).slice(1);
  const items: RawSource[] = entries.slice(0, n).map((block, i): RawSource => {
    const idUrl = tag(block, "id");
    const arxivId = /abs\/([^v<]+)/.exec(idUrl)?.[1] ?? idUrl;
    const authors = [...block.matchAll(/<name>([\s\S]*?)<\/name>/gi)].map((m) => decodeEntities(m[1]!.trim()));
    const year = Number(/<published>(\d{4})/.exec(block)?.[1] ?? 0) || undefined;
    const title = tag(block, "title");
    const summary = tag(block, "summary");
    return {
      url: idUrl || `https://arxiv.org/abs/${arxivId}`,
      title,
      backend: "arxiv",
      score: n - i,
      snippet: summary.slice(0, 360),
      text: `${title}\n\n${summary}`,
      meta: { arxivId, authors, year },
    };
  });
  return {
    backend: "arxiv",
    items,
    notes: items.length ? [`arXiv returned ${items.length} paper(s).`] : ["arXiv returned no results."],
  };
};
