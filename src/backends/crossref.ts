import type { Backend, BackendResult, RawSource } from "../types.js";
import { httpJson, htmlToText, cleanInline, CONTACT_UA } from "./fetch.js";
import { sinceDate } from "../util.js";

// Crossref via its keyless REST API (polite UA). Returns work metadata; the
// abstract (when present, often JATS XML) is stripped to text.
export const crossrefBackend: Backend = async (ctx): Promise<BackendResult> => {
  const n = Math.max(3, Math.min(15, ctx.options.perSource));
  const since = sinceDate(ctx.options.since);
  const url = `https://api.crossref.org/works?query=${encodeURIComponent(ctx.question)}&rows=${n}` + (since ? `&filter=from-pub-date:${since}` : "");
  const r = await httpJson("GET", url, undefined, { timeoutMs: 12000, userAgent: CONTACT_UA });
  const items0: any[] = r.ok && Array.isArray(r.data?.message?.items) ? r.data.message.items : [];
  if (!r.ok || !items0.length) {
    return { backend: "crossref", items: [], notes: [`Crossref search failed or empty (status ${r.status}).`] };
  }
  const items: RawSource[] = items0.slice(0, n).map((w: any, i: number): RawSource => {
    // Crossref titles carry HTML entities (R&amp;D) and JATS tags (<i>, <sub>).
    const title = cleanInline(Array.isArray(w.title) ? w.title.join(" ") : String(w.title ?? "Untitled")) || "Untitled";
    const abstract = w.abstract ? htmlToText(String(w.abstract)) : "";
    // Author entries are usually {given, family} but can be organizations
    // ({name: "World Health Organization"}) — fall back to `name` so consortium
    // works keep their byline instead of losing the author entirely.
    const authors = Array.isArray(w.author)
      ? w.author.map((a: any) => [a.given, a.family].filter(Boolean).join(" ") || String(a.name ?? "")).filter(Boolean)
      : [];
    // date-parts can be [[null]] (date pending) → normalize null to undefined so
    // meta.year matches every other backend (undefined, never null).
    const year = (w.issued?.["date-parts"]?.[0]?.[0] as number | null | undefined) ?? undefined;
    const venue = cleanInline(Array.isArray(w["container-title"]) ? String(w["container-title"][0] ?? "") : "") || undefined;
    return {
      url: String(w.URL ?? (w.DOI ? `https://doi.org/${w.DOI}` : "")),
      title,
      backend: "crossref",
      score: n - i,
      snippet: (abstract || `${title} — ${venue ?? ""} ${year ?? ""}`).slice(0, 360),
      text: `${title}\n\n${abstract || "(no abstract provided by Crossref)"}`,
      meta: { doi: w.DOI, authors, year, venue },
    };
  });
  return {
    backend: "crossref",
    items,
    notes: [`Crossref returned ${items.length} work(s).`],
  };
};
