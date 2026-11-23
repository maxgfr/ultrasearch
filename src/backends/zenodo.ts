import type { Backend, BackendResult, RawSource } from "../types.js";
import { htmlToText, cleanInline, contactUa } from "./fetch.js";
import { apiFailure, apiGet } from "./backoff.js";
import { sinceDate } from "../util.js";

// Zenodo's `q` is an Elasticsearch query string: `/` is a regex delimiter (a
// bare "a/b testing" is an HTTP 500), `field:` scopes a word to a field, and
// unbalanced brackets or quotes change what is searched. The question is meant
// as plain words, so the syntax characters become spaces and the uppercase
// operators lowercase words. Probed live, November 2026.
function plainQuery(question: string): string {
  return question
    .replace(/[+\-!(){}[\]^"~*?:\\/&|<>=]/g, " ")
    .replace(/\b(AND|OR|NOT)\b/g, (w) => w.toLowerCase())
    .replace(/\s+/g, " ")
    .trim();
}

// Zenodo via its keyless records API, restricted to publications (`type=
// publication`: articles, preprints, reports, conference papers, books…) —
// never datasets, software or images. The description is HTML, stripped to
// text as the abstract. Anonymous clients get 30 requests a minute.
export const zenodoBackend: Backend = async (ctx): Promise<BackendResult> => {
  const n = Math.max(3, Math.min(15, ctx.options.perSource));
  const words = plainQuery(ctx.question) || ctx.question;
  // --since: a publication-date range in the query itself. The words are
  // grouped: the search ORs them, and an ungrouped `a b AND date` makes only
  // `b` required (probed live: "muon optimizer AND …" counted exactly the
  // "optimizer AND …" hits). The far end is open, as for Europe PMC.
  const since = sinceDate(ctx.options.since);
  const query = since ? `(${words}) AND publication_date:[${since} TO *]` : words;
  const url = `https://zenodo.org/api/records?q=${encodeURIComponent(query)}&type=publication&size=${n}`;
  // The contact UA is not politeness only: zenodo.org answers a browser UA (and
  // Node's default one) with a 403 "unusual traffic" page.
  const r = await apiGet(url, { userAgent: contactUa() });
  const hits: any[] = r.ok && Array.isArray(r.data?.hits?.hits) ? r.data.hits.hits : [];
  if (!r.ok || !hits.length) {
    return { backend: "zenodo", items: [], notes: [apiFailure("Zenodo search", r, ctx.question)] };
  }
  const items: RawSource[] = hits.slice(0, n).map((h: any, i: number): RawSource => {
    const m = h?.metadata ?? {};
    const title = cleanInline(String(m.title ?? h.title ?? "Untitled")) || "Untitled";
    const abstract = m.description ? htmlToText(String(m.description)) : "";
    // Creators come as Zenodo stores them — "Family, Given" (which BibTeX and
    // bibKey read natively), a full name, or an uploader's free text — and are
    // kept as given: flipping "Family, Given" would scramble the records that
    // put two people in one entry ("Sourav Mandal, Sagar Choudhary").
    const authors = Array.isArray(m.creators) ? m.creators.map((c: any) => cleanInline(String(c?.name ?? ""))).filter(Boolean) : [];
    // publication_date is "YYYY-MM-DD", sometimes just "YYYY".
    const year = Number(String(m.publication_date ?? "").slice(0, 4)) || undefined;
    // The venue is the journal the work appeared in, and nothing else: bibtex.ts
    // writes every source as `@article{… journal = {venue}}`, so the resource
    // type ("Journal article", "Report", "Book") would print `journal = {Report}`.
    // The journal is uploader-entered and is sometimes the record's own title
    // repeated: that is no venue either. Without a real journal, no venue.
    const journal = cleanInline(String(m.journal?.title ?? ""));
    const venue = journal && journal.toLowerCase() !== title.toLowerCase() ? journal : undefined;
    // A Zenodo-minted DOI (10.5281/zenodo.N) or the publisher's own one.
    const doi = typeof h.doi === "string" && h.doi ? h.doi : typeof m.doi === "string" && m.doi ? m.doi : undefined;
    // The record page is the citable address; the DOI resolves there (or to the
    // publisher) when the API gave no page link.
    const url2 = h.links?.self_html || (doi ? `https://doi.org/${doi}` : h.id ? `https://zenodo.org/records/${h.id}` : "");
    return {
      url: String(url2),
      title,
      backend: "zenodo",
      score: n - i,
      snippet: (abstract || [title, venue, year].filter(Boolean).join(" — ")).slice(0, 360),
      text: `${title}\n\n${abstract || "(no abstract provided by Zenodo)"}`,
      meta: { doi, authors, year, venue },
    };
  });
  return { backend: "zenodo", items, notes: [`Zenodo returned ${items.length} publication(s).`] };
};
