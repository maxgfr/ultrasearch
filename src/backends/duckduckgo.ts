import type { Backend, BackendResult, RawSource } from "../types.js";
import { httpGet, decodeEntities, sleep, PAGE_DELAY_MS } from "./fetch.js";
import { canonicalizeUrl } from "../util.js";
import { ddgRegion, acceptLanguageHeader } from "../locale.js";

export function stripTags(s: string): string {
  return decodeEntities(s.replace(/<[^>]+>/g, " "))
    .replace(/\s+/g, " ")
    .trim();
}

// Decode DDG's redirector link: the real URL rides in the `uddg` query param.
// Shared by the DuckDuckGo HTML and Lite backends.
export function realUrl(href: string): string {
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
// Parse one DDG HTML results page. Each result is a BLOCK — the title anchor
// plus everything up to the next result anchor — so a skipped result (an ad,
// DDG's own domain) cannot shift snippets onto the wrong result (index-zip
// misalignment).
function parseDdgPage(body: string, limit: number): { url: string; title: string; snippet: string }[] {
  const found: { url: string; title: string; snippet: string }[] = [];
  const blockRe = /<a\b([^>]*\bresult__a\b[^>]*)>([\s\S]*?)<\/a>([\s\S]*?)(?=<a\b[^>]*\bresult__a\b|$)/gi;
  let m: RegExpExecArray | null;
  while ((m = blockRe.exec(body)) && found.length < limit) {
    const href0 = /\bhref="([^"]+)"/.exec(m[1]!);
    if (!href0) continue;
    const href = realUrl(href0[1]!);
    if (!/^https?:\/\//.test(href) || /duckduckgo\.com/.test(href)) continue;
    const snipM = /class="result__snippet"[^>]*>([\s\S]*?)<\/a>/i.exec(m[3]!);
    found.push({ url: href, title: stripTags(m[2]!) || href, snippet: snipM ? stripTags(snipM[1]!) : "" });
  }
  return found;
}

export const duckduckgoBackend: Backend = async (ctx): Promise<BackendResult> => {
  const pages = Math.max(1, ctx.options.pages ?? 1);
  const kl = ddgRegion(ctx.options.lang, ctx.options.region);
  const acceptLanguage = acceptLanguageHeader(ctx.options.lang, ctx.options.region);
  const perPage = ctx.options.perSource * 2;
  const seen = new Set<string>();
  const found: { url: string; title: string; snippet: string }[] = [];
  // Paginate via the `s` start offset (DDG serves ~30 results/page). Accumulate
  // across pages, deduping by canonical URL, and STOP as soon as a page adds no
  // new URLs — so an engine that ignores `s` (returns page 1 again) costs at most
  // one extra request instead of looping.
  for (let p = 0; p < pages; p++) {
    const url = `https://html.duckduckgo.com/html/?q=${encodeURIComponent(ctx.question)}&kl=${encodeURIComponent(kl)}` + (p > 0 ? `&s=${p * 30}` : "");
    const r = await httpGet(url, { accept: "text/html", acceptLanguage, timeoutMs: 12000 });
    if (!r.ok || !r.body) {
      if (p === 0) {
        const why = r.status === 429 || r.status === 503 ? `rate-limited (HTTP ${r.status}) — consider your own WebSearch` : `unreachable (status ${r.status})`;
        return { backend: "duckduckgo", items: [], notes: [`DuckDuckGo ${why}.`] };
      }
      break; // a later page failed — keep what page 1 already returned
    }
    const before = found.length;
    for (const f of parseDdgPage(r.body, perPage)) {
      const key = canonicalizeUrl(f.url);
      if (seen.has(key)) continue;
      seen.add(key);
      found.push(f);
    }
    if (found.length === before) break; // no new URLs → real pagination exhausted/unsupported
    if (p < pages - 1 && PAGE_DELAY_MS) await sleep(PAGE_DELAY_MS);
  }

  const items: RawSource[] = found.map((f, i) => ({
    url: f.url,
    title: f.title,
    backend: "duckduckgo" as const,
    score: found.length - i,
    snippet: f.snippet.slice(0, 360),
    lang: ctx.options.lang,
  }));

  return {
    backend: "duckduckgo",
    items,
    notes: items.length ? [`DuckDuckGo returned ${items.length} result(s).`] : [`DuckDuckGo returned no results.`],
  };
};
