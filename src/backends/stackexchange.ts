import type { Backend, BackendResult, RawSource } from "../types.js";
import { httpJson, htmlToText, decodeEntities } from "./fetch.js";
import { rankedKeywords, sinceEpochSeconds } from "../util.js";

// The Stack Exchange network sites worth searching for bug/debugging questions
// — fanned out beyond just Stack Overflow so server/ops/security/Linux Q&A is
// covered. Anonymous quota is shared (~300/day per IP), so each site uses a
// small page and we read quota_remaining/backoff into a note.
const SITES = ["stackoverflow", "serverfault", "superuser", "askubuntu", "unix.stackexchange"];

async function searchSite(
  site: string,
  q: string,
  perSite: number,
  fromdate: number | null,
): Promise<{ items: RawSource[]; backoff?: number; remaining?: number; failed?: { status: number; throttled: boolean } }> {
  const url =
    `https://api.stackexchange.com/2.3/search/advanced?order=desc&sort=relevance` +
    `&q=${encodeURIComponent(q)}&site=${encodeURIComponent(site)}&filter=withbody&pagesize=${perSite}` +
    (fromdate ? `&fromdate=${fromdate}` : "");
  const r = await httpJson("GET", url, undefined, { timeoutMs: 10000 });
  if (!r.ok || !Array.isArray(r.data?.items)) {
    // A refusal is not an empty answer. The API throttles with HTTP 400 and a
    // JSON error naming it, so the body is read on failure too.
    const throttled = r.status === 429 || r.status === 503 || r.data?.error_name === "throttle_violation";
    return { items: [], failed: { status: r.status, throttled }, ...(typeof r.data?.backoff === "number" ? { backoff: r.data.backoff } : {}) };
  }
  const label = site === "stackoverflow" ? "" : `${site.replace(/\.stackexchange$/, "")}: `;
  const items: RawSource[] = r.data.items.map((it: any, i: number): RawSource => {
    const title = decodeEntities(String(it.title ?? "question"));
    const body = htmlToText(String(it.body ?? ""));
    return {
      url: String(it.link ?? `https://${site}.com/q/${it.question_id}`),
      title: `${label}${title}`,
      backend: "stackexchange",
      score: (it.score ?? 0) + (it.is_answered ? 2 : 0) + (perSite - i) * 0.1,
      snippet: body.slice(0, 360),
      text: `${title}\n\n${body}`,
      meta: { answerScore: Number(it.score ?? 0) },
    };
  });
  return { items, backoff: r.data.backoff, remaining: r.data.quota_remaining };
}

// Stack Overflow + sibling sites via the keyless StackExchange API.
export const stackexchangeBackend: Backend = async (ctx): Promise<BackendResult> => {
  const q = rankedKeywords(ctx.question).slice(0, 6).join(" ") || ctx.question;
  const n = Math.max(3, Math.min(10, ctx.options.perSource));
  const perSite = Math.max(2, Math.ceil(n / 2));
  const fromdate = sinceEpochSeconds(ctx.options.since);

  const perSiteResults = await Promise.all(SITES.map((s) => searchSite(s, q, perSite, fromdate)));
  const items = perSiteResults.flatMap((r) => r.items).sort((a, b) => b.score - a.score);

  const notes: string[] = [];
  const backoff = perSiteResults.find((r) => r.backoff)?.backoff;
  if (backoff) notes.push(`StackExchange asked to back off ${backoff}s on one site.`);
  const remaining = perSiteResults.map((r) => r.remaining).filter((x): x is number => typeof x === "number");
  if (remaining.length && Math.min(...remaining) < 20) notes.push(`StackExchange anon quota low (${Math.min(...remaining)} left).`);
  const failures = perSiteResults.map((r) => r.failed).filter((f): f is { status: number; throttled: boolean } => f !== undefined);
  const worst = failures.find((f) => f.throttled) ?? failures[0];
  const status = worst ? `${worst.status || "no response"}` : "";
  if (items.length) {
    notes.push(`StackExchange returned ${items.length} question(s) across ${SITES.length} sites.`);
    if (worst) notes.push(`${failures.length} of ${SITES.length} sites failed (status ${status}).`);
  } else if (worst?.throttled) {
    notes.push(`StackExchange rate-limited (HTTP ${status}) — no results this run; it will answer again shortly.`);
  } else if (failures.length === SITES.length) {
    notes.push(`StackExchange search failed on all ${SITES.length} sites (status ${status}).`);
  } else {
    notes.push("StackExchange returned no results.");
    if (worst) notes.push(`${failures.length} of ${SITES.length} sites failed (status ${status}).`);
  }

  return { backend: "stackexchange", items, notes };
};
