import type { Backend, BackendResult, RawSource } from "../types.js";
import { httpGet, sleep, PAGE_DELAY_MS } from "./fetch.js";
import { stripTags } from "./duckduckgo.js";
import { canonicalizeUrl } from "../util.js";
import { acceptLanguageHeader } from "../locale.js";

// Parse one Mojeek results page. Block-match from one title anchor to the next so
// a skipped row can't shift snippets onto the wrong result.
function parseMojeekPage(body: string, limit: number): { url: string; title: string; snippet: string }[] {
  const found: { url: string; title: string; snippet: string }[] = [];
  const blockRe = /<a\b([^>]*\bclass="[^"]*\btitle\b[^"]*"[^>]*)>([\s\S]*?)<\/a>([\s\S]*?)(?=<a\b[^>]*\bclass="[^"]*\btitle\b|$)/gi;
  let m: RegExpExecArray | null;
  while ((m = blockRe.exec(body)) && found.length < limit) {
    const href0 = /\bhref="([^"]+)"/.exec(m[1]!);
    if (!href0) continue;
    let href = href0[1]!;
    if (href.startsWith("//")) href = "https:" + href;
    if (!/^https?:\/\//.test(href) || /mojeek\.com/.test(href)) continue;
    const snipM = /<p\b[^>]*\bclass="[^"]*\bs\b[^"]*"[^>]*>([\s\S]*?)<\/p>/i.exec(m[3]!);
    found.push({ url: href, title: stripTags(m[2]!) || href, snippet: snipM ? stripTags(snipM[1]!) : "" });
  }
  return found;
}

// Discovery via Mojeek — an independent search engine with its OWN crawler and
// index (not a Bing/Google reseller), keyless HTML. Because its index is
// independent it surfaces pages the DDG family misses, so it both widens recall
// and serves as a cascade fallback. Each result's title anchor carries class
// "title"; the snippet rides in a following <p class="s">; the href is a direct
// URL (no redirector). Mojeek has no reliable URL locale param, so we steer
// language with the Accept-Language header.
export const mojeekBackend: Backend = async (ctx): Promise<BackendResult> => {
  const pages = Math.max(1, ctx.options.pages ?? 1);
  const acceptLanguage = acceptLanguageHeader(ctx.options.lang, ctx.options.region);
  const perPage = ctx.options.perSource * 2;
  const seen = new Set<string>();
  const found: { url: string; title: string; snippet: string }[] = [];
  // Mojeek's `s` is the 1-based index of the first result (10 results/page), so
  // page 2 starts at s=11. Accumulate + dedupe across pages; stop when a page
  // adds no new URLs.
  for (let p = 0; p < pages; p++) {
    const url = `https://www.mojeek.com/search?q=${encodeURIComponent(ctx.question)}` + (p > 0 ? `&s=${p * 10 + 1}` : "");
    const r = await httpGet(url, { accept: "text/html", acceptLanguage, timeoutMs: 12000 });
    if (!r.ok || !r.body) {
      if (p === 0) {
        const why = r.status === 429 || r.status === 503 ? `rate-limited (HTTP ${r.status})` : `unreachable (status ${r.status})`;
        return { backend: "mojeek", items: [], notes: [`Mojeek ${why}.`] };
      }
      break;
    }
    const before = found.length;
    for (const f of parseMojeekPage(r.body, perPage)) {
      const key = canonicalizeUrl(f.url);
      if (seen.has(key)) continue;
      seen.add(key);
      found.push(f);
    }
    if (found.length === before) break;
    if (p < pages - 1 && PAGE_DELAY_MS) await sleep(PAGE_DELAY_MS);
  }

  const items: RawSource[] = found.map((f, i) => ({
    url: f.url,
    title: f.title,
    backend: "mojeek" as const,
    score: found.length - i,
    snippet: f.snippet.slice(0, 360),
    lang: ctx.options.lang,
  }));

  return {
    backend: "mojeek",
    items,
    notes: items.length ? [`Mojeek returned ${items.length} result(s).`] : [`Mojeek returned no results.`],
  };
};
