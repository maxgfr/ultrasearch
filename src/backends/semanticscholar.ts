import type { Backend, BackendResult, RawSource } from "../types.js";
import { httpJson } from "./fetch.js";

// Semantic Scholar via the keyless Graph API. Returns paper abstracts +
// metadata (DOI / arXiv id / venue / year) for the report and BibTeX.
export const semanticscholarBackend: Backend = async (ctx): Promise<BackendResult> => {
  const n = Math.max(3, Math.min(15, ctx.options.perSource));
  const fields = "title,abstract,url,year,authors,externalIds,venue";
  const url = `https://api.semanticscholar.org/graph/v1/paper/search?query=${encodeURIComponent(ctx.question)}&limit=${n}&fields=${fields}`;
  const r = await httpJson("GET", url, undefined, { timeoutMs: 12000 });
  const data: any[] = r.ok && Array.isArray(r.data?.data) ? r.data.data : [];
  if (!r.ok || !data.length) {
    return { backend: "semanticscholar", items: [], notes: [`Semantic Scholar search failed or empty (status ${r.status}).`] };
  }
  const items: RawSource[] = data.slice(0, n).map((p: any, i: number): RawSource => {
    const title = String(p.title ?? "Untitled");
    const abstract = String(p.abstract ?? "");
    const authors = Array.isArray(p.authors) ? p.authors.map((a: any) => a?.name).filter(Boolean) : [];
    const year = (p.year as number) || undefined;
    const doi = p.externalIds?.DOI as string | undefined;
    const arxivId = p.externalIds?.ArXiv as string | undefined;
    return {
      url: String(p.url ?? (doi ? `https://doi.org/${doi}` : "")),
      title,
      backend: "semanticscholar",
      score: n - i,
      snippet: (abstract || `${title} — ${p.venue ?? ""} ${year ?? ""}`).slice(0, 360),
      text: `${title}\n\n${abstract || "(no abstract provided by Semantic Scholar)"}`,
      meta: { doi, arxivId, authors, year, venue: p.venue },
    };
  });
  return { backend: "semanticscholar", items, notes: [`Semantic Scholar returned ${items.length} paper(s).`] };
};
