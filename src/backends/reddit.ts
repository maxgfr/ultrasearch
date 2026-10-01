import type { Backend, BackendResult, RawSource } from "../types.js";
import { httpGet, sleep, politeDelayMs, browserUa } from "./fetch.js";
import { awaitHostSlot, parseFeed, throttleReason } from "../engine.js";
import { sinceEpochSeconds } from "../util.js";

// Reddit via its keyless search feed (search.rss — Atom).
//
// Measured 2026-10-01: search.rss answers 200 with a browser User-Agent, but a
// second request in quick succession is a 429, and search.json is a flat 403.
// So this backend is built around ONE request: it is single-query, never
// retried, and at --depth deep it reads at most three threads' comment feeds,
// one after another, stopping at the first refusal. That caps a run at four
// requests to reddit.com. Anything it cannot read becomes a note pointing at the
// agent's own WebSearch (`site:reddit.com …`), which reaches the same threads
// without spending this IP's patience.
//
// Generic on purpose — customer complaints for `startup`, workarounds for `bug`,
// codes people actually used for `deals` — so nothing here knows about deals.

const SEARCH_URL = "https://www.reddit.com/search.rss";
const COMMENT_THREADS = 3;
const COMMENTS_PER_THREAD = 5;
// A thread, as opposed to a subreddit (search.rss mixes communities into the results).
const THREAD_RE = /^https:\/\/(?:www\.|old\.)?reddit\.com\/r\/([^/]+)\/comments\/[a-z0-9]+\//i;

export type RedditWindow = "day" | "week" | "month" | "year" | "all";

/** Map --since onto reddit's `t` window: the smallest window that still covers it. */
export function redditWindow(since?: string, nowMs: number = Date.now()): RedditWindow {
  const secs = sinceEpochSeconds(since);
  if (secs === null) return "all";
  const days = (nowMs / 1000 - secs) / 86400;
  if (days <= 1) return "day";
  if (days <= 7) return "week";
  if (days <= 31) return "month";
  if (days <= 366) return "year";
  return "all";
}

type Feed = NonNullable<ReturnType<typeof parseFeed>>;

// One polite read of a reddit feed: a host slot first, no retry, and a refusal
// described in words rather than a status code.
async function readFeed(url: string): Promise<{ feed?: Feed; why?: string }> {
  await awaitHostSlot(url);
  const r = await httpGet(url, { accept: "application/atom+xml", userAgent: browserUa(), retries: 0, timeoutMs: 12000 });
  if (!r.ok || !r.body) return { why: throttleReason(r.status, r.error).why };
  const feed = parseFeed(r.body, url);
  if (!feed) return { why: "answered with a page that is not a feed (a login or challenge wall)" };
  return { feed };
}

// Reddit appends "submitted by /u/x to r/y [link] [comments]" to every post body.
function postText(summary: string | undefined): string {
  return (summary ?? "").replace(/\s*submitted by\s+\/u\/\S+[\s\S]*$/i, "").trim();
}

function fallback(q: string): string {
  return `Search it with your own WebSearch instead — \`site:reddit.com ${q}\` — and ingest the threads that matter.`;
}

export const redditBackend: Backend = async (ctx): Promise<BackendResult> => {
  const n = Math.max(3, Math.min(15, ctx.options.perSource));
  const q = ctx.question;
  const url = `${SEARCH_URL}?q=${encodeURIComponent(q)}&sort=relevance&t=${redditWindow(ctx.options.since)}&limit=${Math.min(25, n * 2)}`;
  const { feed, why } = await readFeed(url);
  if (!feed) return { backend: "reddit", items: [], notes: [`Reddit search ${why}. ${fallback(q)}`] };

  const threads = feed.items.filter((it) => it.url && THREAD_RE.test(it.url)).slice(0, n);
  const items: RawSource[] = threads.map((it, i) => {
    const title = it.title ?? it.url!;
    const body = postText(it.summary);
    const published = it.published ? new Date(it.published) : undefined;
    const valid = published && !Number.isNaN(published.getTime());
    return {
      url: it.url!,
      title,
      backend: "reddit",
      score: threads.length - i,
      snippet: (body || title).slice(0, 360),
      text: body ? `${title}\n\n${body}` : title,
      meta: {
        subreddit: THREAD_RE.exec(it.url!)![1],
        ...(valid ? { published: published.toISOString(), year: published.getUTCFullYear() } : {}),
      },
    };
  });

  const notes = [items.length ? `Reddit returned ${items.length} thread(s).` : "Reddit returned no threads."];
  if (ctx.options.depth === "deep" && items.length) notes.push(await readComments(items.slice(0, COMMENT_THREADS)));
  return { backend: "reddit", items, notes };
};

// Fold the top comments of the best threads into their text — where the
// "this worked for me / this is expired" signal actually lives. Sequential with
// the polite delay; the first refusal ends it, because a 429 here means the
// next request would be refused too.
async function readComments(threads: RawSource[]): Promise<string> {
  let read = 0;
  for (const [i, t] of threads.entries()) {
    if (i > 0 && politeDelayMs()) await sleep(politeDelayMs());
    const { feed, why } = await readFeed(`${t.url.replace(/\/?$/, "/")}.rss`);
    if (!feed) return `Reddit comments: read ${read} of ${threads.length} thread(s), then the feed ${why} — stopped there. ${fallback(t.title)}`;
    const comments = feed.items
      .filter((c) => c.url && c.url.replace(/\/$/, "") !== t.url.replace(/\/$/, "") && c.summary)
      .slice(0, COMMENTS_PER_THREAD)
      .map((c) => `- ${postText(c.summary).replace(/\s+/g, " ").slice(0, 400)}`);
    if (comments.length) t.text = `${t.text}\n\nTop comments:\n${comments.join("\n")}`;
    read++;
  }
  return `Reddit comments: read the top comments of ${read} thread(s).`;
}
