import type { Backend, BackendResult, RawSource } from "../types.js";
import { httpGet } from "./fetch.js";
import { stripTags } from "./duckduckgo.js";

// Discovery via Mojeek — an independent search engine with its OWN crawler and
// index (not a Bing/Google reseller), keyless HTML. Because its index is
// independent it surfaces pages the DDG family misses, so it both widens recall
// and serves as a cascade fallback. Each result's title anchor carries class
// "title"; the snippet rides in a following <p class="s">; the href is a direct
// URL (no redirector).
export const mojeekBackend: Backend = async (ctx): Promise<BackendResult> => {
  const url = `https://www.mojeek.com/search?q=${encodeURIComponent(ctx.question)}`;
  const r = await httpGet(url, { accept: "text/html", timeoutMs: 12000 });
  if (!r.ok || !r.body) {
    const why =
      r.status === 429 || r.status === 503 ? `rate-limited (HTTP ${r.status})` : `unreachable (status ${r.status})`;
    return { backend: "mojeek", items: [], notes: [`Mojeek ${why}.`] };
  }

  // Block-match from one title anchor to the next so a skipped row can't shift
  // snippets onto the wrong result.
  const found: { url: string; title: string; snippet: string }[] = [];
  const blockRe = /<a\b([^>]*\bclass="[^"]*\btitle\b[^"]*"[^>]*)>([\s\S]*?)<\/a>([\s\S]*?)(?=<a\b[^>]*\bclass="[^"]*\btitle\b|$)/gi;
  let m: RegExpExecArray | null;
  while ((m = blockRe.exec(r.body)) && found.length < ctx.options.perSource * 2) {
    const href0 = /\bhref="([^"]+)"/.exec(m[1]!);
    if (!href0) continue;
    let href = href0[1]!;
    if (href.startsWith("//")) href = "https:" + href;
    if (!/^https?:\/\//.test(href) || /mojeek\.com/.test(href)) continue;
    const snipM = /<p\b[^>]*\bclass="[^"]*\bs\b[^"]*"[^>]*>([\s\S]*?)<\/p>/i.exec(m[3]!);
    found.push({ url: href, title: stripTags(m[2]!) || href, snippet: snipM ? stripTags(snipM[1]!) : "" });
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
