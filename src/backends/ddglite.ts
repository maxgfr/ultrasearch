import type { Backend, BackendResult, RawSource } from "../types.js";
import { httpGet, sleep, PAGE_DELAY_MS } from "./fetch.js";
import { realUrl, stripTags } from "./duckduckgo.js";
import { canonicalizeUrl } from "../util.js";
import { ddgRegion, acceptLanguageHeader } from "../locale.js";

// Parse one DDG Lite results page. Each result anchor is a BLOCK up to the next
// result anchor so a skipped row (an ad, DDG's own domain) cannot shift snippets
// onto the wrong result (the same anti-misalignment technique as the main DDG
// backend).
function parseLitePage(body: string, limit: number): { url: string; title: string; snippet: string }[] {
  const found: { url: string; title: string; snippet: string }[] = [];
  const blockRe = /<a\b([^>]*\bresult-link\b[^>]*)>([\s\S]*?)<\/a>([\s\S]*?)(?=<a\b[^>]*\bresult-link\b|$)/gi;
  let m: RegExpExecArray | null;
  while ((m = blockRe.exec(body)) && found.length < limit) {
    const href0 = /\bhref="([^"]+)"/.exec(m[1]!);
    if (!href0) continue;
    const href = realUrl(href0[1]!);
    if (!/^https?:\/\//.test(href) || /duckduckgo\.com/.test(href)) continue;
    const snipM = /class="result-snippet"[^>]*>([\s\S]*?)<\/td>/i.exec(m[3]!);
    found.push({ url: href, title: stripTags(m[2]!) || href, snippet: snipM ? stripTags(snipM[1]!) : "" });
  }
  return found;
}

// Discovery via DuckDuckGo's "lite" HTML endpoint. The Lite page is a single
// flat results table with far simpler, more stable markup than the main HTML
// endpoint, so it tends to survive layout changes better — it's the first DDG
// fallback in the web cascade. Keyless, no Docker. Result anchors carry class
// "result-link"; the snippet rides in a following "result-snippet" cell.
export const ddgliteBackend: Backend = async (ctx): Promise<BackendResult> => {
  const pages = Math.max(1, ctx.options.pages ?? 1);
  const kl = ddgRegion(ctx.options.lang, ctx.options.region);
  const acceptLanguage = acceptLanguageHeader(ctx.options.lang, ctx.options.region);
  const perPage = ctx.options.perSource * 2;
  const seen = new Set<string>();
  const found: { url: string; title: string; snippet: string }[] = [];
  // Paginate via the `s` start offset; accumulate + dedupe across pages and stop
  // as soon as a page adds no new URLs (see the DuckDuckGo backend for the rationale).
  for (let p = 0; p < pages; p++) {
    const url =
      `https://lite.duckduckgo.com/lite/?q=${encodeURIComponent(ctx.question)}&kl=${encodeURIComponent(kl)}` +
      (p > 0 ? `&s=${p * 30}` : "");
    const r = await httpGet(url, { accept: "text/html", acceptLanguage, timeoutMs: 12000 });
    if (!r.ok || !r.body) {
      if (p === 0) {
        const why =
          r.status === 429 || r.status === 503 ? `rate-limited (HTTP ${r.status})` : `unreachable (status ${r.status})`;
        return { backend: "ddglite", items: [], notes: [`DuckDuckGo Lite ${why}.`] };
      }
      break;
    }
    const before = found.length;
    for (const f of parseLitePage(r.body, perPage)) {
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
    backend: "ddglite" as const,
    score: found.length - i,
    snippet: f.snippet.slice(0, 360),
    lang: ctx.options.lang,
  }));

  return {
    backend: "ddglite",
    items,
    notes: items.length ? [`DuckDuckGo Lite returned ${items.length} result(s).`] : [`DuckDuckGo Lite returned no results.`],
  };
};
