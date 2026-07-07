import type { Backend, BackendResult, RawSource } from "../types.js";
import { httpJson, htmlToText } from "./fetch.js";
import { rankedKeywords, sinceDate } from "../util.js";

// GitHub issues/PRs via the unauthenticated Search API (~10 req/min, so one
// page). Good for "is this a known bug?" — returns each issue's title + body.
export const githubBackend: Backend = async (ctx): Promise<BackendResult> => {
  const since = sinceDate(ctx.options.since);
  const q = (rankedKeywords(ctx.question).slice(0, 6).join(" ") || ctx.question) + (since ? ` created:>=${since}` : "");
  const n = Math.max(3, Math.min(10, ctx.options.perSource));
  const url = `https://api.github.com/search/issues?q=${encodeURIComponent(q)}&per_page=${n}`;
  const r = await httpJson("GET", url, undefined, { timeoutMs: 10000, accept: "application/vnd.github+json" });
  if (!r.ok || !Array.isArray(r.data?.items)) {
    const msg = r.data?.message ? ` — ${r.data.message}` : "";
    return { backend: "github", items: [], notes: [`GitHub search failed (status ${r.status})${msg}.`] };
  }
  const items: RawSource[] = r.data.items.slice(0, n).map((it: any, i: number): RawSource => {
    const body = htmlToText(String(it.body ?? ""));
    const repo = String(it.repository_url ?? "").replace("https://api.github.com/repos/", "");
    const issueTitle = String(it.title ?? "Untitled");
    return {
      // Guard a missing html_url so it never renders as the string "undefined".
      url: it.html_url ? String(it.html_url) : "",
      title: `${it.pull_request ? "PR" : "Issue"}: ${issueTitle}${repo ? ` (${repo})` : ""}`,
      backend: "github",
      score: n - i,
      snippet: (body || issueTitle).slice(0, 360),
      text: `${issueTitle}\nstate: ${it.state} · comments: ${it.comments}\n\n${body}`,
      meta: {},
    };
  });
  return {
    backend: "github",
    items,
    notes: items.length ? [`GitHub returned ${items.length} issue/PR(s).`] : ["GitHub returned no results."],
  };
};
