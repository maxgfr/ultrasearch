import { existsSync, readFileSync, statSync } from "node:fs";
import { basename, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import type { BackendKind, Manifest, RawSource, Source, SourceMeta, WebSearchHit } from "./types.js";
import { readDossier, buildSource, writeSourceExtract, writeDossierIndex, maxSourceId } from "./dossier.js";
import { getMode } from "./modes/registry.js";
import { bestExcerpt, rescueViaWayback, looksLikeJunkExtraction, looksLikePdfUrl, extractMainHtml, htmlToText, DEAD_LINK_STATUS } from "./backends/fetch.js";
import { extractPdf } from "./backends/pdf.js";
import { extractDocument, docFormatForUrl, DOC_EXTENSIONS } from "./backends/doc.js";
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

export interface IngestOutcome extends EnrichResult {
  url: string;
}

export interface IngestResult {
  results: IngestOutcome[];
  added: number;
  skipped: number;
}

// The dossier an ingest is appending to, held in memory for the whole batch.
//
// It exists because the index is O(sources) to write and the batch used to
// rewrite it once per URL: forty URLs meant forty reads of sources.json, forty
// re-renders of DOSSIER.md and forty writes of all three index files, for one
// dossier that only ever needed the last of them. `byCanon` is the same dedupe
// the two `sources.find` scans did, at O(1); `maxId` is the same [S#] the
// serial `nextSourceId` handed out, kept as a counter instead of re-derived.
interface IngestState {
  sources: Source[];
  manifest: Manifest;
  byCanon: Map<string, Source>;
  maxId: number;
}

// One prepared source: everything settled EXCEPT the id, which only exists once
// the source is committed. Refusals never reach commit, so they never burn one.
interface Prepared {
  ok: true;
  raw: RawSource;
  backend: BackendKind;
  text: string;
  question: string;
}
type PrepareResult = Prepared | { ok: false; result: EnrichResult };

function loadState(dir: string): IngestState {
  const { sources, manifest } = readDossier(dir);
  const byCanon = new Map<string, Source>();
  // FIRST match wins, because `sources.find` returned the first match: a
  // dossier that somehow holds two sources on one canonical url has to keep
  // reporting the earlier [S#], or a re-ingest silently re-points at the other.
  for (const s of sources) if (!byCanon.has(s.canonicalUrl)) byCanon.set(s.canonicalUrl, s);
  return { sources, manifest, byCanon, maxId: maxSourceId(sources) };
}

// Bank a prepared source into the in-memory dossier. Synchronous and total: it
// allocates the id, writes the source's own extract, and folds the source into
// `sources`/`byCanon`/`manifest` exactly as the per-URL path did.
//
// The extract stays a PER-SOURCE write on purpose — it is what makes a crashed
// batch recoverable, and it is not the cost the batching removed.
function commit(dir: string, state: IngestState, p: Prepared): EnrichResult {
  const id = `S${++state.maxId}`; // shares the S<n> scheme the grounding contract depends on
  const s = buildSource(p.raw, id, new Date().toISOString(), p.question);
  writeSourceExtract(dir, s, p.text, state.manifest.depth);
  state.sources.push(s);
  state.byCanon.set(s.canonicalUrl, s);
  state.manifest = { ...state.manifest, sourceCount: state.sources.length, backendsUsed: [...new Set([...state.manifest.backendsUsed, p.backend])] };
  return { id, added: true };
}

// Persist the three index files — sources.json, manifest.json, DOSSIER.md —
// from the batch's final state. Called ONCE per batch that added anything.
function flushIndex(dir: string, state: IngestState): void {
  writeDossierIndex(dir, state.sources, state.manifest, getMode(state.manifest.mode).template);
}

// Ingest a BATCH of URLs into one dossier — the whole point being that a
// WebSearch that returned twelve good pages costs ONE process, not twelve.
//
// Deliberately SEQUENTIAL. The batch picks the next free [S#] for each source
// in turn; two concurrent items both claim the same highest id, and one source
// silently overwrites the other — leaving a citation that still resolves, to
// the wrong page. Stable ids are what the whole grounding contract rests on, so
// they are not something to trade for wall-clock. The saving this command
// delivers is the N process spawns and the N agent round-trips, which is where
// the cost actually was.
//
// The dossier index, by contrast, is read once and written once: rewriting it
// per URL cost O(N²) for a file only its last version survives.
//
// Every URL gets an outcome, including the refusals: an ingest that quietly
// dropped half its input would be worse than one that failed.
export async function addSources(
  dir: string,
  hits: (string | WebSearchHit)[],
  opts: { question?: string; backend?: BackendKind; cache?: boolean; firecrawl?: string } = {},
): Promise<IngestResult> {
  const results: IngestOutcome[] = [];
  let state: IngestState | undefined;
  const stateOf = (): IngestState => (state ??= loadState(dir));
  let committed = 0;
  try {
    for (const hit of hits) {
      const { url, title } = typeof hit === "string" ? { url: hit, title: undefined } : hit;
      const p = await prepareSource(stateOf, url, { ...opts, title });
      let r: EnrichResult;
      if (p.ok) {
        r = commit(dir, stateOf(), p);
        committed++;
      } else {
        r = p.result;
      }
      results.push({ ...r, url });
    }
  } finally {
    // Whatever was committed before a throw is still flushed, so a batch that
    // dies halfway leaves a dossier that READS — index and extracts agreeing —
    // rather than extracts no index mentions. A batch that added nothing writes
    // nothing at all, which is how it behaved when each URL wrote its own index.
    if (state && committed > 0) flushIndex(dir, state);
  }
  return {
    results,
    added: results.filter((r) => r.added).length,
    skipped: results.filter((r) => !r.added).length,
  };
}

// Extensions read straight off disk as text, with no converter in between.
// Anything outside this set, the PDF sniffer and the office-document table is
// REFUSED rather than decoded hopefully: a .png read as UTF-8 is exactly the
// kind of plausible-looking garbage the document ladder exists to stop.
const TEXT_FILE_RE = /\.(txt|md|markdown|rst|adoc|org|html?|xml|json|ya?ml|tsv|log)$/i;

// Ingest local FILES into an existing dossier — the same batch contract as
// addSources (sequential, one outcome per input, refusals included, one index
// write at the end), for documents that never had a URL.
//
// A local file skips almost everything addSource does: there is no provider to
// resolve, no consent wall to see past, no dead origin to rescue from Wayback.
// What it does share is the part that matters — the same converters, the same
// quality gate, the same [S#] allocation, so a cited local document is checked
// exactly like a cited page.
export async function addFiles(dir: string, paths: string[], opts: { question?: string; cache?: boolean; firecrawl?: string } = {}): Promise<IngestResult> {
  const results: IngestOutcome[] = [];
  let state: IngestState | undefined;
  const stateOf = (): IngestState => (state ??= loadState(dir));
  let committed = 0;
  try {
    for (const p of paths) {
      const abs = resolve(p);
      const url = pathToFileURL(abs).href;
      const prep = await prepareFile(stateOf, abs, opts);
      let r: EnrichResult;
      if (prep.ok) {
        r = commit(dir, stateOf(), prep);
        committed++;
      } else {
        r = prep.result;
      }
      results.push({ ...r, url });
    }
  } finally {
    if (state && committed > 0) flushIndex(dir, state);
  }
  return {
    results,
    added: results.filter((r) => r.added).length,
    skipped: results.filter((r) => !r.added).length,
  };
}

// Everything a local file needs settled before it can be committed: readable,
// not already in the dossier, and convertible to text worth citing.
//
// `stateOf` is a LAZY handle rather than the state itself: the unreadable-path
// refusal comes first, so `addFiles /nope.md` on a directory that is not a
// dossier still reports the path instead of throwing on a missing sources.json.
async function prepareFile(stateOf: () => IngestState, abs: string, opts: { question?: string; firecrawl?: string }): Promise<PrepareResult> {
  const url = pathToFileURL(abs).href;
  if (!existsSync(abs) || !statSync(abs).isFile()) {
    return { ok: false, result: { id: "", added: false, note: `${abs} is not a readable file` } };
  }

  const state = stateOf();
  const question = opts.question ?? state.manifest.question;

  const existing = state.byCanon.get(canonicalizeUrl(url));
  if (existing) return { ok: false, result: { id: existing.id, added: false, note: `already in dossier as ${existing.id}` } };

  const bytes = readFileSync(abs);
  const name = basename(abs);
  let text: string;
  let extractor: string | undefined;

  const docFmt = docFormatForUrl(url);
  if (looksLikePdfUrl(url)) {
    // No Firecrawl callback: the ladder's rung 3 scrapes a URL, and a container
    // cannot reach a path on this disk. Omitting it skips that rung, which is
    // exactly right — the npx rungs and the built-in reader still apply.
    const got = await extractPdf(bytes, {});
    if (!got.text) return { ok: false, result: { id: "", added: false, note: `could not extract text from ${name} — ${got.reason}.` } };
    text = got.text;
    extractor = got.via;
  } else if (docFmt) {
    const got = await extractDocument(bytes, docFmt, {});
    if (!got.text && docFmt.textFallback) text = bytes.toString("utf8");
    else if (!got.text) return { ok: false, result: { id: "", added: false, note: `could not extract text from ${name} — ${got.reason}.` } };
    else {
      text = got.text;
      extractor = got.via;
    }
  } else if (TEXT_FILE_RE.test(abs)) {
    const raw = bytes.toString("utf8");
    text = /\.html?$/i.test(abs) ? htmlToText(extractMainHtml(raw)) : raw;
  } else {
    return {
      ok: false,
      result: {
        id: "",
        added: false,
        note: `${name}: unsupported file type — ingest reads PDFs, office documents (${DOC_EXTENSIONS.join(", ")}) and plain text.`,
      },
    };
  }

  if (!text.trim()) return { ok: false, result: { id: "", added: false, note: `${name} is empty` } };

  const raw: RawSource = {
    url,
    title: titleFromText(text) || name,
    backend: "file",
    score: 0,
    snippet: bestExcerpt(text, question),
    text,
    ...(extractor ? { meta: { textVia: extractor } } : {}),
  };
  return { ok: true, raw, backend: "file", text, question };
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
  const state = loadState(dir);
  const p = await prepareSource(() => state, url, opts);
  if (!p.ok) return p.result;
  const r = commit(dir, state, p);
  flushIndex(dir, state);
  return r;
}

// Everything `addSource` settles before an id is spent: the refusals, the
// dedupe, the fetch, and the whole rescue ladder. It reads the dossier first
// (through `stateOf`) exactly as the single-URL path always did, so a refusal
// on a directory that is not a dossier still throws there rather than here.
async function prepareSource(
  stateOf: () => IngestState,
  url: string,
  opts: { question?: string; title?: string; citeUrl?: string; backend?: BackendKind; cache?: boolean; firecrawl?: string },
): Promise<PrepareResult> {
  const state = stateOf();
  const question = opts.question ?? state.manifest.question;

  // An API endpoint and its landing page are the same document: fetch wherever
  // the text is, but record the page a reader can open. A batch/query endpoint
  // is not a document at all and is refused with a note saying what to do.
  // A URL that addresses several records is not a source, whoever serves it —
  // one `S#` per document is what citation checking rests on.
  const addressed = addressedIdCount(url);
  if (addressed > 1) {
    return { ok: false, result: { id: "", added: false, note: `${url} addresses ${addressed} records — a source is ONE document. Fetch them one at a time.` } };
  }
  // An endpoint is a legitimate way to READ a walled document; it is never a
  // legitimate thing to cite. When you already know the page — you searched for
  // it, or reconstructed it from the record — hand it over and the engine reads
  // the text from `url` while recording yours.
  const supplied = opts.citeUrl?.trim();
  if (supplied && !isCitableUrl(supplied)) {
    return { ok: false, result: { id: "", added: false, note: `citeUrl ${supplied} is not a page a reader can open — pass the document's own page.` } };
  }
  const provider = resolveProvider(url);
  if (provider.reject && !supplied) return { ok: false, result: { id: "", added: false, note: provider.reject } };
  let citeUrl = supplied || provider.citeUrl;

  // Dedupe on the CITE url so the same paper can't enter twice — once as its
  // page and once as the endpoint that carries its text. Against the batch's
  // in-memory index, so a URL repeated INSIDE one batch is caught by the id the
  // earlier occurrence just took.
  const canon = canonicalizeUrl(citeUrl);
  const existing = state.byCanon.get(canon);
  if (existing) {
    return { ok: false, result: { id: existing.id, added: false, note: `already in dossier as ${existing.id}` } };
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
      ok: false,
      result: {
        id: "",
        added: false,
        note: `${readUrl} extracted to a ${wall}, not content — not added. Retry later, or pin a source that carries the text.`,
      },
    };
  }
  if (!text?.trim()) {
    return { ok: false, result: { id: "", added: false, note: fetched.note ?? `no readable content at ${readUrl}` } };
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
        ok: false,
        result: {
          id: "",
          added: false,
          note:
            `${citeUrl} is an API endpoint and its payload names no document (no canonical link, DOI, arXiv id or PMID). ` +
            `Find the page this record describes and pass it as citeUrl — the text still comes from the endpoint.`,
        },
      };
    }
    meta.textVia = citeUrl;
    via = citeUrl;
    citeUrl = derived;
    const dup = state.byCanon.get(canonicalizeUrl(citeUrl));
    if (dup) return { ok: false, result: { id: dup.id, added: false, note: `already in dossier as ${dup.id} (${citeUrl})` } };
  }

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
  return { ok: true, raw, backend, text, question };
}
