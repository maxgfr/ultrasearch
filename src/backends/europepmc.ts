import type { Backend, BackendResult, RawSource } from "../types.js";
import { decodeEntities, cleanInline } from "./fetch.js";
import { apiFailure, apiGet } from "./backoff.js";
import { sinceDate } from "../util.js";

// Europe PMC via its keyless REST API — biomedical & life-sciences literature,
// the single largest corpus the physics/CS-leaning scholarly backends miss.
// resultType=core returns the abstract inline, so it's a content backend.
export const europepmcBackend: Backend = async (ctx): Promise<BackendResult> => {
  const n = Math.max(3, Math.min(15, ctx.options.perSource));
  // --since: a first-publication date range in the query itself.
  const since = sinceDate(ctx.options.since);
  const query = since ? `(${ctx.question}) AND FIRST_PDATE:[${since} TO ${new Date().toISOString().slice(0, 10)}]` : ctx.question;
  const url = `https://www.ebi.ac.uk/europepmc/webservices/rest/search?query=${encodeURIComponent(query)}` + `&format=json&resultType=core&pageSize=${n}`;
  const r = await apiGet(url);
  const results: any[] = r.ok && Array.isArray(r.data?.resultList?.result) ? r.data.resultList.result : [];
  if (!r.ok || !results.length) {
    return { backend: "europepmc", items: [], notes: [apiFailure("Europe PMC search", r, ctx.question)] };
  }
  const items: RawSource[] = results.slice(0, n).map((w: any, i: number): RawSource => {
    // Europe PMC titles/abstracts carry escaped JATS markup (&lt;i&gt;…&lt;/i&gt;).
    const title = cleanInline(String(w.title ?? "Untitled")).replace(/\.$/, "") || "Untitled";
    // The markup arrives escaped as often as not, so it has to be decoded before
    // it can be stripped — and by then a literal "<" ("p &lt; 0.05") looks like
    // one too. Only what is SHAPED like a tag (a name right after the bracket)
    // is removed: stripping any "<…>" deleted the text between a p-value and
    // the next ">".
    const abstract = decodeEntities(String(w.abstractText ?? "")).replace(/<\/?[a-zA-Z][^<>]*>/g, "");
    const authors = w.authorString ? String(w.authorString).split(/,\s*/).filter(Boolean) : [];
    const year = w.pubYear ? Number(w.pubYear) : undefined;
    const venue = cleanInline(String(w.journalInfo?.journal?.title ?? w.journalTitle ?? "")) || undefined;
    const doi = w.doi as string | undefined;
    // Only build the article URL when both source and id are present, else the
    // link degrades to ".../undefined/undefined".
    const link = doi ? `https://doi.org/${doi}` : w.source && w.id ? `https://europepmc.org/article/${w.source}/${w.id}` : "";
    return {
      url: link,
      title,
      backend: "europepmc",
      score: n - i,
      snippet: (abstract || `${title} — ${venue ?? ""} ${year ?? ""}`).slice(0, 360),
      text: `${title}\n\n${abstract || "(no abstract provided by Europe PMC)"}`,
      meta: { doi, authors, year, venue },
    };
  });
  return { backend: "europepmc", items, notes: [`Europe PMC returned ${items.length} record(s).`] };
};
