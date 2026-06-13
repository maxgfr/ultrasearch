import type { Backend, BackendResult, RawSource } from "../types.js";
import { httpGet } from "./fetch.js";
import { realUrl, stripTags } from "./duckduckgo.js";

// Discovery via DuckDuckGo's "lite" HTML endpoint. The Lite page is a single
// flat results table with far simpler, more stable markup than the main HTML
// endpoint, so it tends to survive layout changes better — it's the first DDG
// fallback in the web cascade. Keyless, no Docker. Result anchors carry class
// "result-link"; the snippet rides in a following "result-snippet" cell.
export const ddgliteBackend: Backend = async (ctx): Promise<BackendResult> => {
  const url = `https://lite.duckduckgo.com/lite/?q=${encodeURIComponent(ctx.question)}`;
  const r = await httpGet(url, { accept: "text/html", timeoutMs: 12000 });
  if (!r.ok || !r.body) {
    const why =
      r.status === 429 || r.status === 503 ? `rate-limited (HTTP ${r.status})` : `unreachable (status ${r.status})`;
    return { backend: "ddglite", items: [], notes: [`DuckDuckGo Lite ${why}.`] };
  }

  // Parse each result anchor as a BLOCK up to the next result anchor so a
  // skipped row (an ad, DDG's own domain) cannot shift snippets onto the wrong
  // result (the same anti-misalignment technique as the main DDG backend).
  const found: { url: string; title: string; snippet: string }[] = [];
  const blockRe = /<a\b([^>]*\bresult-link\b[^>]*)>([\s\S]*?)<\/a>([\s\S]*?)(?=<a\b[^>]*\bresult-link\b|$)/gi;
  let m: RegExpExecArray | null;
  while ((m = blockRe.exec(r.body)) && found.length < ctx.options.perSource * 2) {
    const href0 = /\bhref="([^"]+)"/.exec(m[1]!);
    if (!href0) continue;
    const href = realUrl(href0[1]!);
    if (!/^https?:\/\//.test(href) || /duckduckgo\.com/.test(href)) continue;
    const snipM = /class="result-snippet"[^>]*>([\s\S]*?)<\/td>/i.exec(m[3]!);
    found.push({ url: href, title: stripTags(m[2]!) || href, snippet: snipM ? stripTags(snipM[1]!) : "" });
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
