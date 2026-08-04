// Citability — is this URL something a READER can open?
//
// A source's url is a promise to whoever reads the report: click it and you get
// the document the claim rests on. A machine endpoint breaks that promise —
// clicking lands on JSON, XML or a plain-text dump. Endpoints are still where
// the TEXT often comes from (a walled or rate-limited page next to a keyless
// API), so the two roles have to be kept apart: fetch anywhere, cite a page.
//
// Nothing here is provider-specific. The endpoint test is shape-based, and the
// derivation reads identifiers out of whatever came back — a canonical link, a
// DOI, an arXiv id, a PMID — so any API payload that names its own document
// resolves without the engine knowing the API exists.

// Hosts that only ever serve machine payloads.
const API_HOSTS = new Set(["eutils.ncbi.nlm.nih.gov", "api.crossref.org", "api.openalex.org", "api.semanticscholar.org", "export.arxiv.org"]);
// Hosts that serve BOTH pages and an API, so only the API path counts.
const API_PATHS = [/^\/europepmc\/webservices\//i, /^\/search\/publ\/api/i, /^\/api\//i, /\.(fcgi|cgi)$/i];
// Payload formats nobody reads in a browser.
const API_FORMATS = /[?&](format|retmode|rettype|output)=(json|xml|text|atom|csv|bibtex)\b/i;

export function isApiEndpoint(url: string): boolean {
  try {
    const u = new URL(url);
    if (API_HOSTS.has(u.hostname.toLowerCase().replace(/^www\./, ""))) return true;
    if (API_PATHS.some((re) => re.test(u.pathname))) return true;
    return API_FORMATS.test(u.search);
  } catch {
    return false;
  }
}

// Identifier parameters, by the names APIs actually use. A list in one of them
// means the URL addresses MANY records — so it is not a source, whoever serves
// it. Space and `+` count as separators because both survive URL-encoding of a
// list an agent pasted together.
const ID_PARAMS = ["id", "ids", "uid", "uids", "pmid", "doi", "identifier"];

/**
 * How many documents a URL addresses, when it says so in its query string.
 * 0 means "it doesn't say" — the normal case for an ordinary page.
 */
export function addressedIdCount(url: string): number {
  try {
    const params = new URL(url).searchParams;
    for (const name of ID_PARAMS) {
      const raw = params.get(name);
      if (!raw) continue;
      const ids = raw
        .split(/[,\s+]+/)
        .map((s) => s.trim())
        .filter(Boolean);
      if (ids.length) return ids.length;
    }
  } catch {
    /* not a url — nothing addressed */
  }
  return 0;
}

/** A url fit to appear in a report: parseable, http(s), and not an API endpoint. */
export function isCitableUrl(url: string): boolean {
  try {
    const u = new URL(url);
    return (u.protocol === "https:" || u.protocol === "http:") && !isApiEndpoint(url);
  } catch {
    return false;
  }
}

// A DOI as it appears in prose or metadata. The trailing-punctuation strip
// matters: "doi: 10.1126/science.aad5227." would otherwise carry the sentence's
// full stop into the URL.
const DOI_RE = /\b(10\.\d{4,9}\/[^\s"'<>()[\],;]+)/;
const ARXIV_RE = /\barxiv[:\s/]+((?:\d{4}\.\d{4,5}|[a-z-]+(?:\.[A-Z]{2})?\/\d{7})(?:v\d+)?)/i;
const PMID_RE = /\bPMID:?\s*(\d{4,9})\b/i;

// An arXiv identifier as it appears as a whole PATH SEGMENT (…/2408.05636,
// …/2408.05636v2). Deliberately host-independent — this is the identifier's
// documented syntax, not a list of sites we like.
const ARXIV_ID_PATH_RE = /\/(\d{4}\.\d{4,5}(?:v\d+)?)(?:$|[/?#])/;

/**
 * Does the URL ITSELF carry a persistent identifier?
 *
 * `deriveCitableUrl` reads identifiers out of a document's text, which misses
 * the commonest case in scholarly work: the address IS the identifier
 * (`arxiv.org/pdf/2408.05636`, `doi.org/10.1145/…`). A PDF makes that worse —
 * extraction drops hyperlinks, so the text can carry none at all. Measured: two
 * arXiv papers were flagged "thin attribution" purely because nothing looked at
 * their own URL.
 *
 * Identifier SYNTAX only (DOI, arXiv id). No hostnames.
 */
export function urlDeclaresIdentity(url: string): boolean {
  return DOI_RE.test(url) || ARXIV_ID_PATH_RE.test(url);
}

/**
 * Derive a citable URL from what a fetch returned, for the case where the URL we
 * fetched is not itself citable. Reads the document's own identifiers, in
 * descending order of authority:
 *
 *   1. the canonical link the page declares (`<link rel=canonical>` / `og:url`),
 *   2. a DOI — the identifier publishers agree on,
 *   3. an arXiv id, 4. a PMID.
 *
 * Returns undefined when the payload names no document, which is the honest
 * answer: the caller then refuses or asks the agent for the page.
 */
export function deriveCitableUrl(text: string, canonical?: string): string | undefined {
  if (canonical && isCitableUrl(canonical)) return canonical;
  // Identifiers live in a record's head (its bibliographic block), not three
  // pages into the body where a REFERENCE to some other paper's DOI would win.
  const head = text.slice(0, 4000);

  const doi = head.match(DOI_RE)?.[1];
  if (doi) return `https://doi.org/${doi.replace(/[.,;:)\]]+$/, "")}`;

  const arxiv = head.match(ARXIV_RE)?.[1];
  if (arxiv) return `https://arxiv.org/abs/${arxiv}`;

  const pmid = head.match(PMID_RE)?.[1];
  if (pmid) return `https://pubmed.ncbi.nlm.nih.gov/${pmid}/`;

  return undefined;
}
