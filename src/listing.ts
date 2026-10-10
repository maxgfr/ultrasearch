// Pages that are not documents, whatever they contain: a search engine's (or a
// database's) results page, and a page that redirected to its site's home.
//
// Both were banked as sources by a real run. `ingest` took a PubMed search URL
// (`pubmed.ncbi.nlm.nih.gov/?term=…`) and stored PubMed's interface ("Create a
// new collection…") as the source's text; an old ESCRS link redirected to
// `https://www.escrs.org/` and the society's home page went into the dossier
// under the title of the guideline it no longer served. Neither is a wall — the
// text is real — so neither was caught; neither can carry a claim.

// Query parameters that hold a search.
const SEARCH_PARAMS = ["term", "q", "query", "search", "searchtext", "search_query", "keywords", "keyword", "text", "wd"];
// Paths that are a results page when one of those parameters is set.
const SEARCH_PATH = /^\/(?:|search|scholar|results|find|pmc|pubmed|webhp|html|web|search\/[\w-]*|[\w-]*\/search)\/?$/i;

/** Why `url` is a search results page, or undefined when it is not one. */
export function searchPageOf(url: string): string | undefined {
  let u: URL;
  try {
    u = new URL(url.trim());
  } catch {
    return undefined;
  }
  if (!/^https?:$/.test(u.protocol)) return undefined;
  const param = SEARCH_PARAMS.find((p) => (u.searchParams.get(p) ?? "").trim());
  if (!param || !SEARCH_PATH.test(u.pathname)) return undefined;
  return `${url} is a search results page (${param}=${u.searchParams.get(param)}), not a document — open the result you mean and pass its own URL.`;
}

/**
 * True when a read that asked for a page deep in a site ended on the site's
 * home page — the way dead links on many sites are answered, with a 200.
 */
export function redirectedHome(requested: string, final: string | undefined): boolean {
  if (!final || final === requested) return false;
  try {
    const a = new URL(requested);
    const b = new URL(final);
    const home = (p: string) => p === "" || p === "/" || /^\/(index\.\w+|home|accueil|[a-z]{2}(-[a-z]{2})?)\/?$/i.test(p);
    return !home(a.pathname) && home(b.pathname) && !b.search;
  } catch {
    return false;
  }
}
