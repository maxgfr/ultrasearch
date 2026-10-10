import type { SourceMeta } from "./types.js";
import { ncbiDocument } from "./providers/ncbi.js";

// The identifiers that make two addresses one paper: its DOI, its PMID, its
// PMCID. A run on the thesis banked the same article three times — through
// Europe PMC's DOI, through its PubMed page, and through the publisher's page —
// because URLs were the only thing compared. Keys are `doi:10.x/y` (lower-case),
// `pmid:123`, `pmcid:PMC123`.

const DOI_IN_URL = /(?:doi\.org|\/doi(?:\/(?:abs|full|pdf|epdf|reader))?)\/(10\.\d{4,9}\/[^?#\s]+)/i;

function doiKey(doi: string): string {
  let d = doi.trim();
  try {
    d = decodeURIComponent(d);
  } catch {
    /* keep as given */
  }
  return `doi:${d.replace(/[.,;)\]]+$/, "").toLowerCase()}`;
}

/**
 * The identifier keys of a source: from its URL (a DOI resolver or a /doi/
 * path, a PubMed or PMC page), from the DOI a backend recorded, and — for text
 * read from E-utilities, whose record ends in labelled `DOI:` / `PMID:` /
 * `PMCID:` lines — from the record itself. A page's own body is never mined:
 * a reference list is full of other papers' DOIs.
 */
export function identityKeys(url: string, meta?: SourceMeta, ncbiText?: string): string[] {
  const keys = new Set<string>();
  const inUrl = url.match(DOI_IN_URL);
  if (inUrl) keys.add(doiKey(inUrl[1]!));
  const doc = ncbiDocument(url);
  if (doc) keys.add(doc.kind === "pubmed" ? `pmid:${doc.id}` : `pmcid:${doc.id}`);
  if (typeof meta?.doi === "string" && meta.doi.trim()) keys.add(doiKey(meta.doi));
  if (ncbiText) {
    const doi = ncbiText.match(/^\s*DOI:\s*(10\.\d{4,9}\/\S+)/im);
    if (doi) keys.add(doiKey(doi[1]!));
    const pmid = ncbiText.match(/^\s*PMID:\s*(\d{4,9})\b/im);
    if (pmid) keys.add(`pmid:${pmid[1]}`);
    const pmcid = ncbiText.match(/\bPMCID:\s*(PMC\d+)\b/i);
    if (pmcid) keys.add(`pmcid:${pmcid[1]!.toUpperCase()}`);
  }
  return [...keys];
}

/** True when `via` (a source's textVia) is an E-utilities read, whose text carries labelled ids. */
export function readFromEutils(via: unknown): boolean {
  return typeof via === "string" && /eutils\.ncbi\.nlm\.nih\.gov/i.test(via);
}
