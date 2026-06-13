import type { Backend, BackendResult, RawSource } from "../types.js";
import { httpJson } from "./fetch.js";

// Reconstruct an abstract from OpenAlex's inverted index {word: [positions]}.
function fromInverted(idx: Record<string, number[]> | null | undefined): string {
  if (!idx) return "";
  const words: string[] = [];
  for (const [w, positions] of Object.entries(idx)) for (const p of positions) words[p] = w;
  return words.filter(Boolean).join(" ");
}

// OpenAlex via its keyless REST API. Returns work metadata + reconstructed
// abstract for the report and BibTeX.
export const openalexBackend: Backend = async (ctx): Promise<BackendResult> => {
  const n = Math.max(3, Math.min(15, ctx.options.perSource));
  const url = `https://api.openalex.org/works?search=${encodeURIComponent(ctx.question)}&per_page=${n}`;
  const r = await httpJson("GET", url, undefined, { timeoutMs: 12000 });
  const results: any[] = r.ok && Array.isArray(r.data?.results) ? r.data.results : [];
  if (!r.ok || !results.length) {
    return { backend: "openalex", items: [], notes: [`OpenAlex search failed or empty (status ${r.status}).`] };
  }
  const items: RawSource[] = results.slice(0, n).map((w: any, i: number): RawSource => {
    const title = String(w.title ?? w.display_name ?? "Untitled");
    const abstract = fromInverted(w.abstract_inverted_index);
    const authors = Array.isArray(w.authorships)
      ? w.authorships.map((a: any) => a?.author?.display_name).filter(Boolean)
      : [];
    const year = (w.publication_year as number) || undefined;
    const venue = w.primary_location?.source?.display_name as string | undefined;
    const doi = typeof w.doi === "string" ? w.doi.replace(/^https?:\/\/doi\.org\//, "") : undefined;
    const url2 = w.primary_location?.landing_page_url ?? (doi ? `https://doi.org/${doi}` : w.id);
    return {
      url: String(url2),
      title,
      backend: "openalex",
      score: n - i,
      snippet: (abstract || `${title} — ${venue ?? ""} ${year ?? ""}`).slice(0, 360),
      text: `${title}\n\n${abstract || "(no abstract provided by OpenAlex)"}`,
      meta: { doi, authors, year, venue },
    };
  });
  return { backend: "openalex", items, notes: [`OpenAlex returned ${items.length} work(s).`] };
};
