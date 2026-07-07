import type { Backend, BackendResult, RawSource } from "../types.js";
import { httpJson, cleanInline } from "./fetch.js";

// Normalize dblp's `authors.author`, which is a single object for a one-author
// paper and an array otherwise, into a list of author names.
function authorNames(authors: any): string[] {
  const a = authors?.author;
  const list = Array.isArray(a) ? a : a ? [a] : [];
  return list.map((x: any) => cleanInline(String(x?.text ?? x ?? ""))).filter(Boolean);
}

// dblp's XML→JSON renders a repeated element (multiple `ee`/`doi`) as an array
// and a single one as a scalar — the same quirk `authorNames` handles. Take the
// first string so a multi-`ee` record keeps its direct link and a multi-`doi`
// record yields a valid single DOI (not a comma-joined, unresolvable one).
function firstStr(v: any): string | undefined {
  if (Array.isArray(v)) return v.find((x): x is string => typeof x === "string" && x.length > 0);
  return typeof v === "string" && v.length > 0 ? v : undefined;
}

// dblp via its keyless publication search API. Computer-science bibliography —
// metadata only (no abstract), so the gatherer hydrates the `ee`/DOI landing
// page. DOI/arXiv metadata lets identityKey dedupe dblp records against Crossref
// / OpenAlex, and toBibtex pick them up.
export const dblpBackend: Backend = async (ctx): Promise<BackendResult> => {
  const n = Math.max(3, Math.min(15, ctx.options.perSource));
  const url = `https://dblp.org/search/publ/api?q=${encodeURIComponent(ctx.question)}&format=json&h=${n}`;
  const r = await httpJson("GET", url, undefined, { timeoutMs: 12000 });
  // dblp is XML→JSON: `result.hits.hit` is an array for multiple matches but a
  // single object when exactly one publication matches — same object-or-array
  // quirk `authorNames` handles for `authors.author`. Normalizing here stops a
  // legitimate single result being discarded and mislabeled as an API failure.
  const hitRaw = r.data?.result?.hits?.hit;
  const hits: any[] = r.ok ? (Array.isArray(hitRaw) ? hitRaw : hitRaw ? [hitRaw] : []) : [];
  if (!r.ok || !hits.length) {
    return { backend: "dblp", items: [], notes: [`dblp search failed or empty (status ${r.status}).`] };
  }
  const items: RawSource[] = hits.slice(0, n).map((h: any, i: number): RawSource => {
    const info = h.info ?? {};
    const title = cleanInline(String(info.title ?? "Untitled")).replace(/\.$/, "") || "Untitled";
    const authors = authorNames(info.authors);
    const year = Number(info.year) || undefined;
    const venue = cleanInline(String(info.venue ?? "")) || undefined;
    const doi = firstStr(info.doi);
    // Prefer the electronic edition (publisher page), else the DOI, else the
    // dblp record page — a resolvable target the gatherer can hydrate.
    const ee = firstStr(info.ee);
    const recUrl = firstStr(info.url) ?? "";
    const url2 = ee || (doi ? `https://doi.org/${doi}` : recUrl);
    const meta: RawSource["meta"] = { doi, authors, year, venue };
    const desc = [venue, year].filter(Boolean).join(" · ");
    return {
      url: url2,
      title,
      backend: "dblp",
      score: n - i,
      snippet: `${title}${desc ? " — " + desc : ""}${authors.length ? " · " + authors.slice(0, 4).join(", ") : ""}`.slice(0, 360),
      text: `${title}\n\n${authors.join(", ")}\n${desc}`,
      meta,
    };
  });
  return {
    backend: "dblp",
    items,
    notes: [`dblp returned ${items.length} publication(s).`],
  };
};
