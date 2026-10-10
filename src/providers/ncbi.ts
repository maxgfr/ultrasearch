import { decodeEntities, httpGet } from "../backends/fetch.js";
import { pubmedAbstractUrl } from "../providers.js";
import { looksLikeWall, readPastCachedWall } from "../walls.js";

// PubMed and PMC, read where their text actually is.
//
// Both landing pages are hostile to a reader that is not a browser: PubMed
// answers "Cookies must be enabled", PMC an anti-bot interstitial. The text
// itself is served without either — the PubMed abstract by E-utilities' efetch,
// a PMC article's full text by Europe PMC's `fullTextXML` (the same open-access
// subset, mirrored). So for these hosts the endpoint is read FIRST and the
// landing page is what gets cited, instead of reading the wall, refusing it, and
// only then trying the endpoint — or, worse, reading the wall back over the text
// the endpoint had already returned (the `ingest` bug this module retires).

/** One NCBI document: what to cite, and where its text is. */
export interface NcbiDocument {
  kind: "pubmed" | "pmc";
  /** The PMID, or the PMCID (upper-case, `PMC` prefix). */
  id: string;
  /** The page a reader opens. */
  citeUrl: string;
  /** The endpoint that serves the text. */
  textUrl: string;
}

const PUBMED_PAGE = /^https?:\/\/(?:(?:www\.)?pubmed\.ncbi\.nlm\.nih\.gov|(?:www\.)?ncbi\.nlm\.nih\.gov\/pubmed)\/(\d{4,9})\/?(?:[?#].*)?$/i;
const PMC_PAGE = /^https?:\/\/(?:(?:www\.)?pmc\.ncbi\.nlm\.nih\.gov|(?:www\.)?ncbi\.nlm\.nih\.gov\/pmc)\/articles\/(pmc\d+)\/?(?:[?#].*)?$/i;
const EFETCH = /^https?:\/\/eutils\.ncbi\.nlm\.nih\.gov\/entrez\/eutils\/efetch\.fcgi\?/i;
const EUROPE_PMC_XML = /^https?:\/\/(?:www\.)?ebi\.ac\.uk\/europepmc\/webservices\/rest\/(pmc\d+)\/fulltextxml\/?(?:[?#].*)?$/i;

/** Europe PMC's full-text XML for a PMCID — the PMC open-access text without PMC's interstitial. */
export function europePmcFullTextUrl(pmcid: string): string {
  return `https://www.ebi.ac.uk/europepmc/webservices/rest/${pmcid.toUpperCase()}/fullTextXML`;
}

function pmcPage(pmcid: string): string {
  return `https://pmc.ncbi.nlm.nih.gov/articles/${pmcid.toUpperCase()}/`;
}

/**
 * The NCBI document a URL addresses, or undefined: a PubMed page, a PMC article
 * page (current or legacy host), a single-record efetch, or a Europe PMC
 * full-text URL. A URL naming several records is not one document.
 */
export function ncbiDocument(url: string): NcbiDocument | undefined {
  const raw = url.trim();
  const pubmed = raw.match(PUBMED_PAGE);
  if (pubmed) return { kind: "pubmed", id: pubmed[1]!, citeUrl: `https://pubmed.ncbi.nlm.nih.gov/${pubmed[1]}/`, textUrl: pubmedAbstractUrl(pubmed[1]!) };
  const pmc = raw.match(PMC_PAGE) ?? raw.match(EUROPE_PMC_XML);
  if (pmc) {
    const id = pmc[1]!.toUpperCase();
    return { kind: "pmc", id, citeUrl: pmcPage(id), textUrl: europePmcFullTextUrl(id) };
  }
  if (EFETCH.test(raw)) {
    let params: URLSearchParams;
    try {
      params = new URL(raw).searchParams;
    } catch {
      return undefined;
    }
    const ids = (params.get("id") ?? "").split(/[,\s+]+/).filter(Boolean);
    if (ids.length !== 1) return undefined;
    const db = (params.get("db") ?? "").toLowerCase();
    const id = ids[0]!;
    // The URL as given is kept as the text URL: whatever rettype the caller
    // asked for is what they meant to read.
    if (db === "pubmed" && /^\d+$/.test(id)) return { kind: "pubmed", id, citeUrl: `https://pubmed.ncbi.nlm.nih.gov/${id}/`, textUrl: raw };
    if (db === "pmc") {
      const pmcid = /^pmc/i.test(id) ? id.toUpperCase() : `PMC${id}`;
      return { kind: "pmc", id: pmcid, citeUrl: pmcPage(pmcid), textUrl: europePmcFullTextUrl(pmcid) };
    }
  }
  return undefined;
}

/** What reading an NCBI document produced: its text, or why there is none. */
export type NcbiRead = { ok: true; text: string; title?: string; via: string } | { ok: false; why: string };

/**
 * Read an NCBI document's text from its endpoint. Never throws; a failure says
 * why, so the caller can fall back to the ordinary ladder (landing page,
 * Firecrawl, Wayback, the browser rung) knowing what was already tried.
 */
export async function readNcbiDocument(doc: NcbiDocument, opts: { cache?: boolean } = {}): Promise<NcbiRead> {
  if (doc.kind === "pubmed") {
    const res = await readPastCachedWall(doc.textUrl, {}, !!opts.cache);
    const text = res.text?.trim() ?? "";
    if (!text) return { ok: false, why: `E-utilities returned nothing for PMID ${doc.id} (HTTP ${res.status || "no response"})` };
    const wall = looksLikeWall(text);
    if (wall) return { ok: false, why: `E-utilities returned a ${wall} for PMID ${doc.id}` };
    return { ok: true, text, via: doc.textUrl };
  }
  const res = await httpGet(doc.textUrl, { accept: "application/xml, text/xml;q=0.9, */*;q=0.1" });
  if (!res.ok || !/<article\b/i.test(res.body)) {
    return { ok: false, why: `Europe PMC has no full text for ${doc.id} (HTTP ${res.status || "no response"})` };
  }
  const { text, title } = jatsToText(res.body);
  const wall = looksLikeWall(text);
  if (wall) return { ok: false, why: `Europe PMC's full text for ${doc.id} is a ${wall}` };
  return { ok: true, text, ...(title ? { title } : {}), via: doc.textUrl };
}

// Elements whose content is not running text: tables are unreadable flattened,
// formulas and supplementary blocks are noise, and the reference list is the
// paper's bibliography, not its claims.
const DROP = ["table-wrap", "table", "disp-formula", "inline-formula", "mml:math", "supplementary-material", "ref-list", "ack", "fn-group", "alternatives"];

function inner(xml: string, tag: string): string | undefined {
  return xml.match(new RegExp(`<${tag}\\b[^>]*>([\\s\\S]*?)</${tag}>`, "i"))?.[1];
}

function clean(s: string): string {
  return decodeEntities(s.replace(/<[^>]+>/g, " "))
    .replace(/\s+/g, " ")
    .replace(/\s+([,.;:)\]])/g, "$1")
    .replace(/([([])\s+/g, "$1")
    .trim();
}

// A JATS fragment as Markdown-ish text: each <title> a heading, each <p> a
// paragraph, figure captions kept as paragraphs, everything else stripped.
function blocks(xml: string): string[] {
  let x = xml;
  for (const tag of DROP) x = x.replace(new RegExp(`<${tag}\\b[^>]*>[\\s\\S]*?</${tag}>`, "gi"), " ");
  const out: string[] = [];
  const re = /<(title|p)\b[^>]*>([\s\S]*?)<\/\1>/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(x))) {
    const body = clean(m[2]!);
    if (!body) continue;
    out.push(m[1]!.toLowerCase() === "title" ? `## ${body}` : body);
  }
  return out;
}

/**
 * Europe PMC / PMC full-text XML (JATS) to plain text: the article title, the
 * abstract, then the body's section titles and paragraphs, in document order.
 * Tables, formulas, the reference list and every tag are dropped — what is left
 * is the prose a claim can be checked against.
 */
export function jatsToText(xml: string): { text: string; title?: string } {
  const front = inner(xml, "front") ?? xml;
  const titleXml = inner(inner(front, "title-group") ?? front, "article-title");
  const title = titleXml ? clean(titleXml) : undefined;
  const parts: string[] = [];
  if (title) parts.push(`# ${title}`);
  const abstract = inner(front, "abstract");
  if (abstract) {
    const ab = blocks(abstract);
    if (ab.length) parts.push("## Abstract", ...ab.filter((b) => b !== "## Abstract"));
  }
  const body = inner(xml, "body");
  if (body) parts.push(...blocks(body));
  return { text: parts.join("\n\n"), ...(title ? { title } : {}) };
}
