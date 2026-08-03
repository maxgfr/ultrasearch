// URL-SHAPE rules — the small, optional layer above the generic citability
// machinery in citable.ts.
//
// Generic mechanisms answer most of the problem: `isCitableUrl` recognises a
// machine endpoint by shape, and `deriveCitableUrl` reads the document's own
// identifiers out of whatever came back. Both work without knowing which API
// they are looking at.
//
// Two things they can't do, because they need the CONTENT before they can act:
//
//   • refuse a search endpoint before spending a request — its response is a
//     result list, so pinning it would cite a query, not a document (the
//     many-ids case needs no table: `addressedIdCount` reads it off any URL);
//   • say where the text lives when a page walls — some publishers rate-limit
//     their HTML while a keyless API next door keeps serving the same document
//     (PubMed answers `pubmed.ncbi.nlm.nih.gov/<pmid>/` with a reCAPTCHA
//     interstitial under HTTP 200, while E-utilities hands back the abstract).
//
// Hence this table: pure, no I/O, and deliberately short. An unlisted URL falls
// through to the generic path unchanged — adding a provider here is an
// optimisation, never a prerequisite.

export interface ResolvedProvider {
  // What the dossier records and the report cites. Never an API endpoint.
  citeUrl: string;
  // A same-document alternate to hydrate text from when `citeUrl` fetches empty
  // or extracts to a consent/anti-bot wall. Undefined when the page is the only
  // source of text we know about.
  textUrl?: string;
  // Set when the URL cannot become a source at all (a batch/query endpoint that
  // is not one document). The message says what to do instead.
  reject?: string;
  // `textUrl` carries the REAL content and should be read first, with citeUrl
  // kept only for the citation. Without this the landing page wins by default,
  // which is right for PubMed (a full landing page, with the E-utilities
  // endpoint as the un-walled fallback) and wrong for arXiv, whose /abs/ page is
  // an abstract while the PDF is the paper.
  preferText?: true;
}

const PUBMED_LANDING = /^https?:\/\/(?:www\.)?pubmed\.ncbi\.nlm\.nih\.gov\/(\d{4,9})\/?$/i;
const PMC_LANDING = /^https?:\/\/(?:www\.)?pmc\.ncbi\.nlm\.nih\.gov\/articles\/(PMC\d+)\/?$/i;
const EUTILS = /^https?:\/\/eutils\.ncbi\.nlm\.nih\.gov\/entrez\/eutils\/([a-z]+)\.fcgi/i;
// arXiv's PDF form, with or without the `.pdf` suffix and with or without a
// version (`v2`) — the abstract page keeps the version, so it is not stripped.
const ARXIV_PDF = /^https?:\/\/(?:www\.|export\.)?arxiv\.org\/pdf\/([^?#]+?)(?:\.pdf)?\/?$/i;

// NCBI accepts a comma-separated id list; agents (and copy-pasted UI links) also
// produce space- or `+`-separated ones, which URL-decode to spaces.
function eutilsIds(raw: string | null): string[] {
  return (raw ?? "")
    .split(/[,\s+]+/)
    .map((s) => s.trim())
    .filter(Boolean);
}

export function pubmedAbstractUrl(pmid: string): string {
  return `https://eutils.ncbi.nlm.nih.gov/entrez/eutils/efetch.fcgi?db=pubmed&id=${pmid}&rettype=abstract&retmode=text`;
}

// Resolve a URL to its { citeUrl, textUrl } pair. An unknown URL comes back
// unchanged with no alternate — the caller's behaviour is then exactly what it
// was before this module existed.
export function resolveProvider(url: string): ResolvedProvider {
  const raw = url.trim();

  const pubmed = raw.match(PUBMED_LANDING);
  if (pubmed) {
    const pmid = pubmed[1]!;
    return { citeUrl: `https://pubmed.ncbi.nlm.nih.gov/${pmid}/`, textUrl: pubmedAbstractUrl(pmid) };
  }

  const pmc = raw.match(PMC_LANDING);
  if (pmc) return { citeUrl: `https://pmc.ncbi.nlm.nih.gov/articles/${pmc[1]!.toUpperCase()}/` };

  const eutils = raw.match(EUTILS);
  if (eutils) return resolveEutils(raw, eutils[1]!.toLowerCase());

  const arxiv = raw.match(ARXIV_PDF);
  if (arxiv) return { citeUrl: `https://arxiv.org/abs/${arxiv[1]!}`, textUrl: raw, preferText: true };

  return { citeUrl: raw };
}

function resolveEutils(raw: string, op: string): ResolvedProvider {
  let params: URLSearchParams;
  try {
    params = new URL(raw).searchParams;
  } catch {
    return { citeUrl: raw };
  }
  // esearch/espell/egquery take a `term`, not an id: they are QUERIES. Their
  // response is a list of ids, so pinning one as a source would cite a search,
  // not a document.
  if (op === "esearch" || op === "egquery" || op === "espell") {
    return { citeUrl: raw, reject: `${raw} is an E-utilities ${op} query, not a document — fetch the record it points at instead.` };
  }
  const db = (params.get("db") ?? "").toLowerCase();
  const ids = eutilsIds(params.get("id"));
  const id = ids[0];
  if (!id) return { citeUrl: raw };
  if (db === "pubmed" && /^\d+$/.test(id)) {
    return { citeUrl: `https://pubmed.ncbi.nlm.nih.gov/${id}/`, textUrl: pubmedAbstractUrl(id) };
  }
  if (db === "pmc") {
    const pmcid = /^pmc/i.test(id) ? id.toUpperCase() : `PMC${id}`;
    return { citeUrl: `https://pmc.ncbi.nlm.nih.gov/articles/${pmcid}/` };
  }
  return { citeUrl: raw };
}
