import type { Backend, BackendResult, RawSource } from "../types.js";
import { httpGet } from "./fetch.js";

// Default base for a local SearXNG instance (the one `docker-compose up` brings
// up). Override with --searxng or the ULTRASEARCH_SEARXNG env var.
export const DEFAULT_SEARXNG = process.env.ULTRASEARCH_SEARXNG || "http://localhost:8888";

// Discovery via a SearXNG instance's JSON API (keyless, self-hosted). Returns
// candidate URLs (title + snippet, no full text — the gatherer fetches the
// pages). Many public instances disable format=json, so this falls through
// silently (empty + a note) when unreachable or non-JSON.
export const searxngBackend: Backend = async (ctx): Promise<BackendResult> => {
  const base = (ctx.options.searxng || DEFAULT_SEARXNG).replace(/\/$/, "");
  const url = `${base}/search?q=${encodeURIComponent(ctx.question)}&format=json&safesearch=1${
    ctx.options.lang ? `&language=${encodeURIComponent(ctx.options.lang)}` : ""
  }`;
  const r = await httpGet(url, { accept: "application/json", timeoutMs: 8000 });
  if (!r.ok) {
    return {
      backend: "searxng",
      items: [],
      notes: [`SearXNG unreachable at ${base} (status ${r.status}). Skipping; run \`docker-compose up\` for a local instance.`],
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
