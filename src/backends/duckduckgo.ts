import type { Backend, BackendResult, RawSource } from "../types.js";
import { httpGet, decodeEntities } from "./fetch.js";

function stripTags(s: string): string {
  return decodeEntities(s.replace(/<[^>]+>/g, " ")).replace(/\s+/g, " ").trim();
}

// Decode DDG's redirector link: the real URL rides in the `uddg` query param.
function realUrl(href: string): string {
  const uddg = /[?&]uddg=([^&]+)/.exec(href);
  if (uddg) {
    try {
      return decodeURIComponent(uddg[1]!);
    } catch {
      /* keep raw */
    }
  }
  return href.startsWith("//") ? "https:" + href : href;
}

// Discovery by scraping the keyless DuckDuckGo HTML endpoint (no Docker, no
// key). HTML attribute order is arbitrary, so we match the whole result anchor
// then pull href + inner text out separately; snippets are zipped by index from
// the parallel `result__snippet` anchors. A bit fragile if DDG changes markup —
// that's why the agent's own WebSearch is the real workhorse (fed back via
// `fetch --url`).
export const duckduckgoBackend: Backend = async (ctx): Promise<BackendResult> => {
  const url = `https://html.duckduckgo.com/html/?q=${encodeURIComponent(ctx.question)}`;
  const r = await httpGet(url, { accept: "text/html", timeoutMs: 12000 });
  if (!r.ok || !r.body) {
    return { backend: "duckduckgo", items: [], notes: [`DuckDuckGo unreachable (status ${r.status}).`] };
  }

  const titles: { href: string; title: string }[] = [];
  const anchorRe = /<a\b([^>]*\bresult__a\b[^>]*)>([\s\S]*?)<\/a>/gi;
  let m: RegExpExecArray | null;
  while ((m = anchorRe.exec(r.body))) {
    const href0 = /\bhref="([^"]+)"/.exec(m[1]!);
    if (!href0) continue;
    const href = realUrl(href0[1]!);
    if (!/^https?:\/\//.test(href) || /duckduckgo\.com/.test(href)) continue;
    titles.push({ href, title: stripTags(m[2]!) || href });
  }

  const snippets: string[] = [];
  const snipRe = /class="result__snippet"[^>]*>([\s\S]*?)<\/a>/gi;
  let s: RegExpExecArray | null;
  while ((s = snipRe.exec(r.body))) snippets.push(stripTags(s[1]!));

  const items: RawSource[] = titles.slice(0, ctx.options.perSource * 2).map((t, i) => ({
    url: t.href,
    title: t.title,
    backend: "duckduckgo" as const,
    score: titles.length - i,
    snippet: (snippets[i] ?? "").slice(0, 360),
    lang: ctx.options.lang,
  }));

  return {
    backend: "duckduckgo",
    items,
    notes: items.length ? [`DuckDuckGo returned ${items.length} result(s).`] : [`DuckDuckGo returned no results.`],
  };
};
