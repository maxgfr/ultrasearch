// Resolving cited references to the record of what was actually published:
// PubMed (E-utilities) first — it carries the NLM journal abbreviation Vancouver
// uses, and the abstract — then Crossref for what PubMed does not index, and
// doi.org for whether a cited DOI exists at all.
//
// Every call goes through `apiGet`, so a 429 from NCBI (3 requests/s without a
// key) is waited out instead of losing the reference. Calls are batched where
// the API allows (ecitmatch, esummary, efetch take many ids at once) and spaced
// politely where it does not.

import { cleanInline, decodeEntities, politeDelayMs, sleep } from "../backends/fetch.js";
import { contactUa } from "../backends/fetch.js";
import { apiGet } from "../backends/backoff.js";
import type { CitedReference } from "./parse.js";
import { vancouverName } from "./parse.js";
import { titleSimilarity } from "./diff.js";

const EUTILS = "https://eutils.ncbi.nlm.nih.gov/entrez/eutils";
const BATCH = 100;

/** The published record a reference resolved to. */
export interface ResolvedRecord {
  via: "pubmed" | "crossref";
  /** How the record was found: an id the reference carried, a citation match, a title search. */
  how: "pmid" | "ecitmatch" | "doi" | "title" | "bibliographic";
  pmid?: string;
  pmcid?: string;
  doi?: string;
  /** "Surname Initials", every author in order. */
  authors: string[];
  title: string;
  /** NLM abbreviation (PubMed) or Crossref's short title. */
  journal?: string;
  journalFull?: string;
  year?: string;
  volume?: string;
  issue?: string;
  pages?: string;
  abstract?: string;
  /** The page a reader can open: the PubMed record, else the DOI. */
  url: string;
}

export interface DoiCheck {
  doi: string;
  resolves: boolean | undefined; // undefined: doi.org could not be asked
  target?: string;
}

export interface ResolveOutcome {
  records: Map<number, ResolvedRecord>;
  doiChecks: Map<string, DoiCheck>;
  notes: string[];
}

async function polite(): Promise<void> {
  const ms = politeDelayMs();
  if (ms) await sleep(ms);
}

// --- PubMed ----------------------------------------------------------------

function firstPage(pages?: string): string | undefined {
  return pages ? /^[A-Za-z]?\d+[A-Za-z]?/.exec(pages)?.[0] : undefined;
}

/** ecitmatch: journal|year|volume|first page|first author|key| → PMID, for every reference complete enough. */
export async function ecitmatch(refs: CitedReference[]): Promise<Map<number, string>> {
  const out = new Map<number, string>();
  const lines = refs
    .filter((r) => r.journal && r.year && (r.volume || firstPage(r.pages)) && r.authors.length)
    .map((r) => [r.journal, r.year, r.volume ?? "", firstPage(r.pages) ?? "", r.authors[0], String(r.n), ""].join("|"));
  for (let i = 0; i < lines.length; i += 50) {
    const bdata = lines.slice(i, i + 50).join("\r");
    const r = await apiGet(`${EUTILS}/ecitmatch.cgi?db=pubmed&retmode=xml&tool=ultrasearch&bdata=${encodeURIComponent(bdata)}`, {
      json: false,
      accept: "text/plain",
    });
    if (!r.ok || typeof r.data !== "string") continue;
    for (const line of r.data.split(/\r?\n/)) {
      const cols = line.split("|");
      const key = Number(cols[5]);
      const pmid = cols[6]?.trim();
      if (key && pmid && /^\d+$/.test(pmid)) out.set(key, pmid);
    }
    await polite();
  }
  return out;
}

async function esearch(term: string): Promise<string[]> {
  const r = await apiGet(`${EUTILS}/esearch.fcgi?db=pubmed&retmode=json&retmax=3&tool=ultrasearch&term=${encodeURIComponent(term)}`);
  await polite();
  return r.ok && Array.isArray(r.data?.esearchresult?.idlist) ? r.data.esearchresult.idlist : [];
}

/** esummary for many PMIDs → the metadata Vancouver compares against. */
export async function esummary(pmids: string[]): Promise<Map<string, ResolvedRecord>> {
  const out = new Map<string, ResolvedRecord>();
  for (let i = 0; i < pmids.length; i += BATCH) {
    const ids = pmids.slice(i, i + BATCH);
    const r = await apiGet(`${EUTILS}/esummary.fcgi?db=pubmed&retmode=json&tool=ultrasearch&id=${ids.join(",")}`);
    await polite();
    const result = r.ok ? r.data?.result : undefined;
    if (!result) continue;
    for (const id of ids) {
      const d = result[id];
      if (!d || d.error) continue;
      const articleIds: any[] = Array.isArray(d.articleids) ? d.articleids : [];
      const doi = articleIds.find((a) => a?.idtype === "doi")?.value as string | undefined;
      const pmcid = articleIds.find((a) => a?.idtype === "pmc")?.value as string | undefined;
      const authors = (Array.isArray(d.authors) ? d.authors : [])
        .filter((a: any) => !a?.authtype || a.authtype === "Author")
        .map((a: any) => String(a?.name ?? ""))
        .filter(Boolean);
      out.set(id, {
        via: "pubmed",
        how: "pmid",
        pmid: id,
        ...(pmcid ? { pmcid } : {}),
        ...(doi ? { doi } : {}),
        authors,
        title: cleanInline(String(d.title ?? "")).replace(/\.$/, ""),
        journal: d.source ? String(d.source) : undefined,
        journalFull: d.fulljournalname ? String(d.fulljournalname) : undefined,
        year: /\d{4}/.exec(String(d.pubdate ?? d.epubdate ?? ""))?.[0],
        volume: d.volume ? String(d.volume) : undefined,
        issue: d.issue ? String(d.issue) : undefined,
        pages: d.pages ? String(d.pages) : undefined,
        url: `https://pubmed.ncbi.nlm.nih.gov/${id}/`,
      });
    }
  }
  return out;
}

/** efetch XML for many PMIDs → their abstracts (structured abstracts keep their section labels). */
export async function efetchAbstracts(pmids: string[]): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  for (let i = 0; i < pmids.length; i += BATCH) {
    const ids = pmids.slice(i, i + BATCH);
    const r = await apiGet(`${EUTILS}/efetch.fcgi?db=pubmed&retmode=xml&rettype=abstract&tool=ultrasearch&id=${ids.join(",")}`, {
      json: false,
      accept: "application/xml",
    });
    await polite();
    if (!r.ok || typeof r.data !== "string") continue;
    for (const art of r.data.split(/<PubmedArticle>/).slice(1)) {
      const pmid = /<PMID[^>]*>(\d+)<\/PMID>/.exec(art)?.[1];
      if (!pmid) continue;
      const parts: string[] = [];
      for (const m of art.matchAll(/<AbstractText([^>]*)>([\s\S]*?)<\/AbstractText>/g)) {
        const label = /Label="([^"]+)"/.exec(m[1]!)?.[1];
        const body = decodeEntities(m[2]!.replace(/<[^>]+>/g, ""))
          .replace(/\s+/g, " ")
          .trim();
        if (body) parts.push(label ? `${label}: ${body}` : body);
      }
      if (parts.length) out.set(pmid, parts.join("\n\n"));
    }
  }
  return out;
}

// --- Crossref ---------------------------------------------------------------

function crossrefRecord(w: any, how: ResolvedRecord["how"]): ResolvedRecord | undefined {
  if (!w?.DOI) return undefined;
  const parts = w.issued?.["date-parts"]?.[0] ?? w["published-print"]?.["date-parts"]?.[0] ?? w["published-online"]?.["date-parts"]?.[0];
  const authors = (Array.isArray(w.author) ? w.author : [])
    .map((a: any) => (a.family ? vancouverName(`${a.family}, ${a.given ?? ""}`) : String(a.name ?? "")))
    .filter(Boolean);
  const first = (v: unknown) => (Array.isArray(v) ? (v[0] as string | undefined) : (v as string | undefined));
  return {
    via: "crossref",
    how,
    doi: String(w.DOI),
    authors,
    title: cleanInline(String(first(w.title) ?? "")),
    journal: first(w["short-container-title"]) ?? first(w["container-title"]),
    journalFull: first(w["container-title"]),
    year: parts?.[0] ? String(parts[0]) : undefined,
    volume: w.volume ? String(w.volume) : undefined,
    issue: w.issue ? String(w.issue) : undefined,
    pages: w.page ? String(w.page) : w["article-number"] ? String(w["article-number"]) : undefined,
    ...(w.abstract
      ? {
          abstract: decodeEntities(String(w.abstract).replace(/<[^>]+>/g, " "))
            .replace(/\s+/g, " ")
            .trim(),
        }
      : {}),
    url: `https://doi.org/${w.DOI}`,
  };
}

export async function crossrefByDoi(doi: string): Promise<ResolvedRecord | undefined> {
  const r = await apiGet(`https://api.crossref.org/works/${encodeURIComponent(doi)}`, { userAgent: contactUa() });
  await polite();
  return r.ok ? crossrefRecord(r.data?.message, "doi") : undefined;
}

export async function crossrefBibliographic(ref: CitedReference): Promise<ResolvedRecord | undefined> {
  const r = await apiGet(`https://api.crossref.org/works?rows=2&query.bibliographic=${encodeURIComponent(ref.raw)}`, { userAgent: contactUa() });
  await polite();
  const items: any[] = r.ok && Array.isArray(r.data?.message?.items) ? r.data.message.items : [];
  for (const w of items) {
    const rec = crossrefRecord(w, "bibliographic");
    // A bibliographic query always returns SOMETHING: keep it only when the
    // title is unmistakably the cited one.
    if (rec && ref.title && titleSimilarity(ref.title, rec.title) >= 0.85) return rec;
  }
  return undefined;
}

// --- doi.org ----------------------------------------------------------------

/** Ask doi.org's handle API whether a DOI exists, and where it points. */
export async function checkDoi(doi: string): Promise<DoiCheck> {
  const r = await apiGet(`https://doi.org/api/handles/${encodeURIComponent(doi)}`);
  await polite();
  const code = r.data?.responseCode;
  if (code === 1) {
    const url = (Array.isArray(r.data.values) ? r.data.values : []).find((v: any) => v?.type === "URL")?.data?.value;
    return { doi, resolves: true, ...(url ? { target: String(url) } : {}) };
  }
  if (code === 100 || r.status === 404) return { doi, resolves: false };
  return { doi, resolves: undefined };
}

// --- the cascade ---------------------------------------------------------------

/**
 * Resolve every reference: its own PMID, else ecitmatch, else its DOI on
 * PubMed, else a PubMed title search, else Crossref (by DOI, then
 * bibliographic). PubMed records get their abstracts; Crossref-only records
 * keep the abstract Crossref has, if any. Every cited DOI is checked on doi.org.
 */
export async function resolveReferences(refs: CitedReference[]): Promise<ResolveOutcome> {
  const notes: string[] = [];
  const pmidOf = new Map<number, { pmid: string; how: ResolvedRecord["how"] }>();
  for (const r of refs) if (r.pmid) pmidOf.set(r.n, { pmid: r.pmid, how: "pmid" });

  const matched = await ecitmatch(refs.filter((r) => !pmidOf.has(r.n)));
  for (const [n, pmid] of matched) pmidOf.set(n, { pmid, how: "ecitmatch" });

  for (const r of refs) {
    if (pmidOf.has(r.n)) continue;
    if (r.doi) {
      const ids = await esearch(`${r.doi}[aid]`);
      if (ids.length === 1) {
        pmidOf.set(r.n, { pmid: ids[0]!, how: "doi" });
        continue;
      }
    }
    if (r.title) {
      const t = r.title
        .replace(/[^\p{L}\p{N}\s-]/gu, " ")
        .replace(/\s+/g, " ")
        .trim();
      const ids = await esearch(`${t}[ti]${r.year ? ` AND ${r.year}[dp]` : ""}`);
      if (ids.length >= 1 && ids.length <= 3) pmidOf.set(r.n, { pmid: ids[0]!, how: "title" });
    }
  }

  const pmids = [...new Set([...pmidOf.values()].map((v) => v.pmid))];
  const summaries = pmids.length ? await esummary(pmids) : new Map<string, ResolvedRecord>();
  const abstracts = pmids.length ? await efetchAbstracts(pmids) : new Map<string, string>();

  const records = new Map<number, ResolvedRecord>();
  for (const r of refs) {
    const hit = pmidOf.get(r.n);
    const rec = hit ? summaries.get(hit.pmid) : undefined;
    // A title search can land on the wrong paper: only keep it when the title agrees.
    if (rec && (hit!.how !== "title" || !r.title || titleSimilarity(r.title, rec.title) >= 0.8)) {
      const abs = abstracts.get(rec.pmid!);
      records.set(r.n, { ...rec, how: hit!.how, ...(abs ? { abstract: abs } : {}) });
      continue;
    }
    const viaCrossref = (r.doi ? await crossrefByDoi(r.doi) : undefined) ?? (r.title ? await crossrefBibliographic(r) : undefined);
    if (viaCrossref) records.set(r.n, viaCrossref);
  }
  if (summaries.size < pmids.length) notes.push(`PubMed returned no summary for ${pmids.length - summaries.size} PMID(s).`);

  const doiChecks = new Map<string, DoiCheck>();
  for (const r of refs) {
    if (!r.doi || doiChecks.has(r.doi.toLowerCase())) continue;
    doiChecks.set(r.doi.toLowerCase(), await checkDoi(r.doi));
  }
  return { records, doiChecks, notes };
}
