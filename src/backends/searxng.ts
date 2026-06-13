import type { Backend, BackendResult, RawSource } from "../types.js";
import { httpGet } from "./fetch.js";

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
  const url = `${base}/search?q=${encodeURIComponent(ctx.question)}&format=json&safesearch=1${
    ctx.options.lang ? `&language=${encodeURIComponent(ctx.options.lang)}` : ""
  }${ctx.options.since ? `&time_range=year` : ""}`;
  const r = await httpGet(url, { accept: "application/json", timeoutMs: 8000 });
  if (!r.ok) {
    const why = r.status === 429 || r.status === 503 ? `rate-limited (HTTP ${r.status})` : `unreachable (status ${r.status})`;
    return {
      backend: "searxng",
      items: [],
      notes: [`SearXNG ${why} at ${base}. Skipping; consider your own WebSearch.`],
    };
  }
  let data: any;
  try {
    data = JSON.parse(r.body);
  } catch {
    return {
      backend: "searxng",
      items: [],
      notes: [`SearXNG at ${base} did not return JSON (the instance likely disables format=json).`],
    };
  }
  const results: any[] = Array.isArray(data?.results) ? data.results : [];
  const items: RawSource[] = [];
  results.slice(0, ctx.options.perSource * 2).forEach((x, i) => {
    if (!x?.url || typeof x.url !== "string") return;
    items.push({
      url: x.url,
      title: String(x.title ?? x.url),
      backend: "searxng",
      score: results.length - i,
      snippet: String(x.content ?? "").slice(0, 360),
      lang: ctx.options.lang,
    });
  });
  return {
    backend: "searxng",
    items,
    notes: items.length ? [`SearXNG returned ${items.length} result(s).`] : [`SearXNG returned no results.`],
  };
};
