import type { Backend, BackendResult, RawSource } from "../types.js";
import { httpGet, sleep, PAGE_DELAY_MS } from "./fetch.js";
import { canonicalizeUrl } from "../util.js";
import { acceptLanguageHeader } from "../locale.js";

// Resolve a configured SearXNG base: an explicit --searxng wins, else the
// ULTRASEARCH_SEARXNG env var. Returns null when neither is set — SearXNG is
// OPT-IN so a fresh install doesn't pay an 8s dead-localhost timeout on every
// default topic/learn/startup run.
export function resolveSearxngBase(ctx: { options: { searxng?: string } }): string | null {
  const base = ctx.options.searxng || process.env.ULTRASEARCH_SEARXNG;
  return base ? base.replace(/\/$/, "") : null;
}

// Discovery via a SearXNG instance's JSON API (keyless, self-hosted). Returns
// candidate URLs (title + snippet, no full text — the gatherer fetches the
// pages). Many public instances disable format=json, so this falls through
// silently (empty + a note) when unreachable or non-JSON.
export const searxngBackend: Backend = async (ctx): Promise<BackendResult> => {
  const base = resolveSearxngBase(ctx);
  if (!base) {
    return {
      backend: "searxng",
      items: [],
      notes: ["SearXNG not configured — set --searxng <url> or ULTRASEARCH_SEARXNG (run `docker-compose up` for a local instance). Skipping."],
    };
  }
  const pages = Math.max(1, ctx.options.pages ?? 1);
  const acceptLanguage = acceptLanguageHeader(ctx.options.lang, ctx.options.region);
  const perPage = ctx.options.perSource * 2;
  const base0 = `${base}/search?q=${encodeURIComponent(ctx.question)}&format=json&safesearch=1${
    ctx.options.lang ? `&language=${encodeURIComponent(ctx.options.lang)}` : ""
  }${ctx.options.since ? `&time_range=year` : ""}`;
  const seen = new Set<string>();
  const found: { url: string; title: string; snippet: string }[] = [];
  // SearXNG paginates with `&pageno=` (1-based). Accumulate + dedupe across pages
  // and stop when a page adds no new URLs.
  for (let p = 0; p < pages; p++) {
    const url = base0 + (p > 0 ? `&pageno=${p + 1}` : "");
    const r = await httpGet(url, { accept: "application/json", acceptLanguage, timeoutMs: 8000 });
    if (!r.ok) {
      if (p === 0) {
        const why = r.status === 429 || r.status === 503 ? `rate-limited (HTTP ${r.status})` : `unreachable (status ${r.status})`;
        return {
          backend: "searxng",
          items: [],
          notes: [`SearXNG ${why} at ${base}. Skipping; consider your own WebSearch.`],
        };
      }
      break;
    }
    let data: any;
    try {
      data = JSON.parse(r.body);
    } catch {
      if (p === 0) {
        return {
          backend: "searxng",
          items: [],
          notes: [`SearXNG at ${base} did not return JSON (the instance likely disables format=json).`],
        };
      }
      break;
    }
    const results: any[] = Array.isArray(data?.results) ? data.results : [];
    const before = found.length;
    for (const x of results.slice(0, perPage)) {
      if (!x?.url || typeof x.url !== "string") continue;
      const key = canonicalizeUrl(x.url);
      if (seen.has(key)) continue;
      seen.add(key);
      // `||` (not `??`): some SearXNG engines return an empty title — degrade to
      // the URL like the HTML backends, never emit a blank title.
      found.push({ url: x.url, title: String(x.title || x.url), snippet: String(x.content ?? "").slice(0, 360) });
    }
    if (found.length === before) break;
    if (p < pages - 1 && PAGE_DELAY_MS) await sleep(PAGE_DELAY_MS);
  }
  const items: RawSource[] = found.map((f, i) => ({
    url: f.url,
    title: f.title,
    backend: "searxng",
    score: found.length - i,
    snippet: f.snippet,
    lang: ctx.options.lang,
  }));
  return {
    backend: "searxng",
    items,
    notes: items.length ? [`SearXNG returned ${items.length} result(s).`] : [`SearXNG returned no results.`],
  };
};
