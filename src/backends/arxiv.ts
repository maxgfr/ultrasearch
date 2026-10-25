import type { Backend, BackendResult, RawSource, SourceMeta } from "../types.js";
import { httpGet, decodeEntities, contactUa } from "./fetch.js";
import { rankedKeywords } from "../engine.js";

function tag(block: string, name: string): string {
  const m = new RegExp(`<${name}[^>]*>([\\s\\S]*?)<\\/${name}>`, "i").exec(block);
  return m ? decodeEntities(m[1]!.replace(/\s+/g, " ").trim()) : "";
}

/** One paper as arXiv's Atom API describes it. */
export interface ArxivRecord {
  arxivId: string;
  title: string;
  summary: string;
  authors: string[];
  year?: number;
  doi?: string;
  /** `arxiv:journal_ref`: where the paper was published, when arXiv knows. */
  venue?: string;
}

/**
 * arXiv's API splits a collaboration byline into one-word "authors" closed by a
 * bare colon — `Muon`, `Collaboration`, `:`, `G. W. Bennett` — which BibTeX then
 * prints as four people. Rejoin the words before the colon into one name.
 */
export function repairCollaboration(names: string[]): string[] {
  const n = names.map((s) => s.trim()).filter(Boolean);
  const colon = n.indexOf(":");
  if (colon > 0 && n.slice(0, colon).every((w) => !/\s/.test(w))) return [n.slice(0, colon).join(" "), ...n.slice(colon + 1)];
  return n.filter((s) => s !== ":");
}

/** Parse one `<entry>` block of an arXiv Atom feed. */
export function parseArxivEntry(block: string): ArxivRecord {
  const idUrl = tag(block, "id");
  // Strip only a trailing version: legacy ids can contain a "v" (solv-int/9901001).
  const arxivId = /abs\/(.+?)(?:v\d+)?$/.exec(idUrl)?.[1] ?? idUrl;
  const authors = repairCollaboration([...block.matchAll(/<name>([\s\S]*?)<\/name>/gi)].map((m) => decodeEntities(m[1]!)));
  const year = Number(/<published>(\d{4})/.exec(block)?.[1] ?? 0) || undefined;
  const doi = tag(block, "arxiv:doi") || undefined;
  const venue = tag(block, "arxiv:journal_ref") || undefined;
  return {
    arxivId,
    title: tag(block, "title"),
    summary: tag(block, "summary"),
    authors,
    ...(year ? { year } : {}),
    ...(doi ? { doi } : {}),
    ...(venue ? { venue } : {}),
  };
}

/** The bibliographic part of a record, as a source's `meta`. */
export function arxivMeta(rec: ArxivRecord): SourceMeta {
  return {
    arxivId: rec.arxivId,
    authors: rec.authors,
    ...(rec.year ? { year: rec.year } : {}),
    ...(rec.doi ? { doi: rec.doi } : {}),
    ...(rec.venue ? { venue: rec.venue } : {}),
    absUrl: `https://arxiv.org/abs/${rec.arxivId}`,
  };
}

/** A record as a readable text: what the abstract page says, without its chrome. */
export function arxivText(rec: ArxivRecord): string {
  const by = rec.authors.length ? `\n\nAuthors: ${rec.authors.join(", ")}` : "";
  const ref = rec.venue ? `\nPublished in: ${rec.venue}` : "";
  return `# ${rec.title}\n\narXiv:${rec.arxivId}${rec.year ? ` (${rec.year})` : ""}${by}${ref}\n\nAbstract: ${rec.summary}`;
}

/**
 * The records of arXiv papers by id, in batches of 100 (one request per batch:
 * arXiv asks for a few seconds between calls, so per-paper requests would trip
 * its rate limit). Ids arXiv does not know are simply absent from the map, and a
 * failed request costs only the metadata, never the run.
 */
export async function readArxivRecords(ids: string[]): Promise<{ records: Map<string, ArxivRecord>; note?: string }> {
  const records = new Map<string, ArxivRecord>();
  const unique = [...new Set(ids.map((id) => id.toLowerCase()))];
  for (let i = 0; i < unique.length; i += 100) {
    const batch = unique.slice(i, i + 100);
    const url = `https://export.arxiv.org/api/query?id_list=${batch.map(encodeURIComponent).join(",")}&max_results=${batch.length}`;
    const r = await httpGet(url, { accept: "application/atom+xml", timeoutMs: 12000, userAgent: contactUa() });
    if (!r.ok || !r.body)
      return { records, note: `arXiv metadata lookup failed (status ${r.status}) — titles and BibTeX fields of arXiv pages come from the pages themselves.` };
    for (const block of r.body.split(/<entry>/).slice(1)) {
      const rec = parseArxivEntry(block);
      if (rec.title && rec.arxivId) records.set(rec.arxivId.toLowerCase(), rec);
    }
  }
  return { records };
}

/**
 * arXiv's API joins bare words with OR, so "Muon optimizer learning rate" ranks
 * particle-physics muon papers first. Ask for the four most distinctive words (AND),
 * keeping the any-word query (OR) as the fallback.
 */
export function arxivQueries(question: string): [string, string] {
  const terms = rankedKeywords(question)
    .map((t) => t.replace(/[^\p{L}\p{N}-]/gu, ""))
    .filter(Boolean)
    .slice(0, 4);
  if (!terms.length) return [`all:${question}`, `all:${question}`];
  return [terms.map((t) => `all:${t}`).join(" AND "), terms.map((t) => `all:${t}`).join(" OR ")];
}

// arXiv via its keyless Atom API. Returns each paper's abstract as text, with
// arXiv id / authors / year metadata for the BibTeX export.
export const arxivBackend: Backend = async (ctx): Promise<BackendResult> => {
  const n = Math.max(3, Math.min(15, ctx.options.perSource));
  const get = (query: string) =>
    httpGet(`https://export.arxiv.org/api/query?search_query=${encodeURIComponent(query)}&start=0&max_results=${n}`, {
      accept: "application/atom+xml",
      timeoutMs: 12000,
      userAgent: contactUa(),
    });
  const [all, any] = arxivQueries(ctx.question);
  let r = await get(all);
  let entries = r.ok && r.body ? r.body.split(/<entry>/).slice(1) : [];
  // Every term at once can match nothing on a long question: widen to any term.
  if (r.ok && !entries.length && any !== all) {
    r = await get(any);
    entries = r.ok && r.body ? r.body.split(/<entry>/).slice(1) : [];
  }
  if (!r.ok || !r.body) {
    const why = r.status === 429 || r.status === 503 ? `rate-limited (HTTP ${r.status})` : `failed (status ${r.status})`;
    return { backend: "arxiv", items: [], notes: [`arXiv search ${why}.`] };
  }
  const items: RawSource[] = entries.slice(0, n).map((block, i): RawSource => {
    const rec = parseArxivEntry(block);
    const htmlUrl = `https://arxiv.org/html/${rec.arxivId}`;
    return {
      // Point at the HTML full text so the gatherer hydrates the whole paper,
      // not just the abstract. No `text` here → hydration fetches htmlUrl; if
      // that paper has no HTML rendering, the fetch falls back to the abstract
      // snippet (gather sets text = snippet when a fetch yields nothing).
      url: htmlUrl,
      title: rec.title,
      backend: "arxiv",
      score: n - i,
      snippet: rec.summary.slice(0, 360),
      meta: { ...arxivMeta(rec), htmlUrl, absUrl: tag(block, "id") || `https://arxiv.org/abs/${rec.arxivId}` },
    };
  });
  return {
    backend: "arxiv",
    items,
    notes: items.length ? [`arXiv returned ${items.length} paper(s).`] : ["arXiv returned no results."],
  };
};
