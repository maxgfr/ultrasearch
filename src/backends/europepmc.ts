import type { Backend, BackendResult, RawSource } from "../types.js";
import { httpJson } from "./fetch.js";

// Europe PMC via its keyless REST API — biomedical & life-sciences literature,
// the single largest corpus the physics/CS-leaning scholarly backends miss.
// resultType=core returns the abstract inline, so it's a content backend.
export const europepmcBackend: Backend = async (ctx): Promise<BackendResult> => {
  const n = Math.max(3, Math.min(15, ctx.options.perSource));
  const url =
    `https://www.ebi.ac.uk/europepmc/webservices/rest/search?query=${encodeURIComponent(ctx.question)}` +
    `&format=json&resultType=core&pageSize=${n}`;
  const r = await httpJson("GET", url, undefined, { timeoutMs: 12000 });
  const results: any[] = r.ok && Array.isArray(r.data?.resultList?.result) ? r.data.resultList.result : [];
  if (!r.ok || !results.length) {
    const why = r.status === 429 || r.status === 503 ? `rate-limited (HTTP ${r.status})` : `failed or empty (status ${r.status})`;
    return { backend: "europepmc", items: [], notes: [`Europe PMC search ${why}.`] };
  }
  const items: RawSource[] = results.slice(0, n).map((w: any, i: number): RawSource => {
    const title = String(w.title ?? "Untitled").replace(/\.$/, "");
    const abstract = String(w.abstractText ?? "").replace(/<[^>]+>/g, "");
    const authors = w.authorString ? String(w.authorString).split(/,\s*/).filter(Boolean) : [];
    const year = w.pubYear ? Number(w.pubYear) : undefined;
    const venue = w.journalInfo?.journal?.title ?? w.journalTitle;
    const doi = w.doi as string | undefined;
    const link = doi ? `https://doi.org/${doi}` : `https://europepmc.org/article/${w.source}/${w.id}`;
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
