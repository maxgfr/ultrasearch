import type { Backend, BackendResult, RawSource } from "../types.js";
import { httpJson } from "./fetch.js";

// PubMed via the keyless NCBI E-utilities: esearch → idlist, then esummary →
// metadata (two-call pattern, like wikipedia). esummary has no abstract, so we
// return metadata + a DOI/PubMed link without `text` and let the gatherer
// hydrate the landing page. `tool=ultrasearch` only — no email/PII, stays
// keyless. Complements Europe PMC with MeSH-indexed / clinical records.
export const pubmedBackend: Backend = async (ctx): Promise<BackendResult> => {
  const n = Math.max(3, Math.min(15, ctx.options.perSource));
  const base = "https://eutils.ncbi.nlm.nih.gov/entrez/eutils";
  const esearch = `${base}/esearch.fcgi?db=pubmed&retmode=json&retmax=${n}&tool=ultrasearch&term=${encodeURIComponent(ctx.question)}`;
  const sr = await httpJson("GET", esearch, undefined, { timeoutMs: 12000 });
  const ids: string[] = sr.ok && Array.isArray(sr.data?.esearchresult?.idlist) ? sr.data.esearchresult.idlist : [];
  if (!sr.ok || !ids.length) {
    const why = sr.status === 429 || sr.status === 503 ? `rate-limited (HTTP ${sr.status})` : `failed or empty (status ${sr.status})`;
    return { backend: "pubmed", items: [], notes: [`PubMed esearch ${why}.`] };
  }

  const esummary = `${base}/esummary.fcgi?db=pubmed&retmode=json&tool=ultrasearch&id=${ids.join(",")}`;
  const dr = await httpJson("GET", esummary, undefined, { timeoutMs: 12000 });
  const result = dr.ok ? dr.data?.result : undefined;
  if (!result) {
    return { backend: "pubmed", items: [], notes: [`PubMed esummary failed (status ${dr.status}).`] };
  }

  const items: RawSource[] = ids.slice(0, n).map((uid, i): RawSource => {
    const d = result[uid] ?? {};
    const title = String(d.title ?? "Untitled").replace(/\.$/, "");
    const articleIds: any[] = Array.isArray(d.articleids) ? d.articleids : [];
    const doi = articleIds.find((a) => a?.idtype === "doi")?.value as string | undefined;
    const year = d.pubdate ? Number(String(d.pubdate).slice(0, 4)) || undefined : undefined;
    const authors = Array.isArray(d.authors) ? d.authors.map((a: any) => a?.name).filter(Boolean) : [];
    const link = doi ? `https://doi.org/${doi}` : `https://pubmed.ncbi.nlm.nih.gov/${uid}/`;
    return {
      url: link,
      title,
      backend: "pubmed",
      score: ids.length - i,
      snippet: `${title} — ${d.source ?? ""} ${year ?? ""}`.trim().slice(0, 360),
      // no text → the gatherer hydrates the landing page for the abstract
      meta: { doi, authors, year, venue: d.source },
    };
  });
  return { backend: "pubmed", items, notes: [`PubMed returned ${items.length} record(s).`] };
};
