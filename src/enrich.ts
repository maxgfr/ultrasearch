import type { BackendKind, RawSource, SourceMeta } from "./types.js";
import { readDossier, buildSource, writeSourceExtract, writeDossierIndex, nextSourceId } from "./dossier.js";
import { getMode } from "./modes/registry.js";
import { bestExcerpt, rescueViaWayback, looksLikeJunkExtraction, DEAD_LINK_STATUS } from "./backends/fetch.js";
import { scrapeViaFirecrawl } from "./backends/firecrawl.js";
import { cachedFetchAndExtract } from "./cache.js";
import { resolveProvider } from "./providers.js";
import { addressedIdCount, deriveCitableUrl, isCitableUrl } from "./citable.js";
import { canonicalizeUrl, titleFromText } from "./util.js";

export interface EnrichResult {
  id: string;
  added: boolean;
  note?: string;
}

// Ingest a single URL into an existing dossier — the bridge for the agent's own
// WebSearch hits. Fetches + cleans the page, allocates the next S# id, appends
// to sources.json, writes sources/S#.md, and refreshes manifest + DOSSIER.md.
// If the URL is already in the dossier it returns the existing id (no dup).
//
// Runs the same rescue ladder `gather` hydrates with — provider text endpoint →
// Firecrawl → Wayback — and, like `gather`, REFUSES content that is really a
// consent/anti-bot wall. A pinned source is cited verbatim, so silently storing
// "Checking your browser…" as a source's full text is worse than not adding it.
export async function addSource(
  dir: string,
  url: string,
  opts: { question?: string; title?: string; citeUrl?: string; backend?: BackendKind; cache?: boolean; firecrawl?: string } = {},
): Promise<EnrichResult> {
  const { sources, manifest } = readDossier(dir);
  const question = opts.question ?? manifest.question;

  // An API endpoint and its landing page are the same document: fetch wherever
  // the text is, but record the page a reader can open. A batch/query endpoint
  // is not a document at all and is refused with a note saying what to do.
  // A URL that addresses several records is not a source, whoever serves it —
  // one `S#` per document is what citation checking rests on.
  const addressed = addressedIdCount(url);
  if (addressed > 1) {
    return { id: "", added: false, note: `${url} addresses ${addressed} records — a source is ONE document. Fetch them one at a time.` };
  }
  // An endpoint is a legitimate way to READ a walled document; it is never a
  // legitimate thing to cite. When you already know the page — you searched for
  // it, or reconstructed it from the record — hand it over and the engine reads
  // the text from `url` while recording yours.
  const supplied = opts.citeUrl?.trim();
  if (supplied && !isCitableUrl(supplied)) {
    return { id: "", added: false, note: `citeUrl ${supplied} is not a page a reader can open — pass the document's own page.` };
  }
  const provider = resolveProvider(url);
  if (provider.reject && !supplied) return { id: "", added: false, note: provider.reject };
  let citeUrl = supplied || provider.citeUrl;

  // Dedupe on the CITE url so the same paper can't enter twice — once as its
  // page and once as the endpoint that carries its text.
  const canon = canonicalizeUrl(citeUrl);
  const existing = sources.find((s) => s.canonicalUrl === canon);
  if (existing) {
    return { id: existing.id, added: false, note: `already in dossier as ${existing.id}` };
  }

  // Where the TEXT comes from. Normally the citation page, but a provider that
  // marks its textUrl as the real content (arXiv: /abs/ is an abstract, the PDF
  // is the paper) is read there first — otherwise the landing page always
  // "succeeds" and the full text is never fetched at all.
  const preferred = provider.preferText && provider.textUrl ? provider.textUrl : citeUrl;
  const readUrl = supplied ? url : preferred;
  const fetched = await cachedFetchAndExtract(readUrl, { firecrawl: opts.firecrawl }, !!opts.cache);
  let { text, title } = fetched;
  let wall = text?.trim() ? looksLikeJunkExtraction(text) : undefined;
  // A wall's <title> is boilerplate too ("Checking your browser - reCAPTCHA") —
  // drop it with the body, or a rescued source ends up labelled by the wall.
  if (wall) title = undefined;
  const meta: SourceMeta = {};
  let via: string | undefined;
  // Reading somewhere other than the citation page is provenance worth keeping,
  // whether it was the preferred text URL or a fallback below.
  if (readUrl !== citeUrl) {
    via = readUrl;
    meta.textVia = readUrl;
  }

  // Nothing usable (empty, or a wall the regex reader can't see past). Try the
  // OTHER url of the pair: the provider's text endpoint when we read the landing
  // page, or the landing page when we already preferred the text endpoint and it
  // came back empty (a paywalled or image-only PDF).
  const fallbackUrl = readUrl === citeUrl ? provider.textUrl : citeUrl;
  if ((!text?.trim() || wall) && fallbackUrl && fallbackUrl !== readUrl) {
    const alt = await cachedFetchAndExtract(fallbackUrl, { firecrawl: opts.firecrawl }, !!opts.cache);
    if (alt.text?.trim() && !looksLikeJunkExtraction(alt.text)) {
      text = alt.text;
      title = title || alt.title;
      wall = undefined;
      via = fallbackUrl === citeUrl ? undefined : fallbackUrl;
      if (via) meta.textVia = via;
      else delete meta.textVia;
    }
  }
  // A real browser gets past most consent walls and JS shells the stripper can't.
  // Skipped when this text ALREADY came from Firecrawl — re-asking returns the
  // same wall.
  if (text?.trim() && wall && fetched.extractor !== "firecrawl") {
    const fc = await scrapeViaFirecrawl(readUrl, { firecrawl: opts.firecrawl });
    if (fc.data?.markdown && !looksLikeJunkExtraction(fc.data.markdown)) {
      text = fc.data.markdown;
      title = title || fc.data.title;
      wall = undefined;
    }
  }
  // A dead origin (404/410/451/403) → try the Wayback Machine's closest snapshot
  // before giving up, so an agent's own WebSearch hit that has since rotted still
  // makes it into the dossier. The ORIGINAL url is kept as the source url.
  if (!text?.trim() && DEAD_LINK_STATUS.has(fetched.status)) {
    const wb = await rescueViaWayback(readUrl, { firecrawl: opts.firecrawl });
    if (wb) {
      text = wb.text;
      title = title || wb.title;
      wall = undefined;
      meta.waybackSnapshot = wb.timestamp;
    }
  }
  if (text?.trim() && wall) {
    return {
      id: "",
      added: false,
      note: `${readUrl} extracted to a ${wall}, not content — not added. Retry later, or pin a source that carries the text.`,
    };
  }
  if (!text?.trim()) {
    return { id: "", added: false, note: fetched.note ?? `no readable content at ${readUrl}` };
  }

  // We have the text; now settle what gets CITED. If the url we read is a
  // machine endpoint, ask the document for its own address (canonical link,
  // DOI, arXiv id, PMID) rather than pinning a URL no reader can open. When the
  // payload names no document, refuse — guessing a landing page would be worse
  // than saying so.
  if (supplied && supplied !== url) {
    meta.textVia = url;
    via = url;
  } else if (!isCitableUrl(citeUrl)) {
    const derived = deriveCitableUrl(text, fetched.canonical);
    if (!derived) {
      return {
        id: "",
        added: false,
        note:
          `${citeUrl} is an API endpoint and its payload names no document (no canonical link, DOI, arXiv id or PMID). ` +
          `Find the page this record describes and pass it as citeUrl — the text still comes from the endpoint.`,
      };
    }
    meta.textVia = citeUrl;
    via = citeUrl;
    citeUrl = derived;
    const dup = sources.find((s2) => s2.canonicalUrl === canonicalizeUrl(citeUrl));
    if (dup) return { id: dup.id, added: false, note: `already in dossier as ${dup.id} (${citeUrl})` };
  }

  const id = nextSourceId(sources); // shares the S<n> scheme the grounding contract depends on
  const backend: BackendKind = opts.backend ?? "claude";
  const raw: RawSource = {
    url: citeUrl,
    // Never fall back to the URL as a title when the text came from an API
    // endpoint — a bare endpoint string is unreadable in a source list.
    title: opts.title || title || (via ? titleFromText(text) : citeUrl),
    backend,
    score: 0,
    snippet: bestExcerpt(text, question),
    text,
    ...(Object.keys(meta).length ? { meta } : {}),
  };
  const s = buildSource(raw, id, new Date().toISOString(), question);
  writeSourceExtract(dir, s, text, manifest.depth);

  const nextSources = [...sources, s];
  const backendsUsed = [...new Set([...manifest.backendsUsed, backend])];
  const nextManifest = { ...manifest, sourceCount: nextSources.length, backendsUsed };
  writeDossierIndex(dir, nextSources, nextManifest, getMode(nextManifest.mode).template);

  return { id, added: true };
}
