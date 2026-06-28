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
): Promise<{ items: RawSource[]; backoff?: number; remaining?: number }> {
  const url =
    `https://api.stackexchange.com/2.3/search/advanced?order=desc&sort=relevance` +
    `&q=${encodeURIComponent(q)}&site=${encodeURIComponent(site)}&filter=withbody&pagesize=${perSite}` +
    (fromdate ? `&fromdate=${fromdate}` : "");
  const r = await httpJson("GET", url, undefined, { timeoutMs: 10000 });
  if (!r.ok || !Array.isArray(r.data?.items)) return { items: [] };
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
  notes.push(items.length ? `StackExchange returned ${items.length} question(s) across ${SITES.length} sites.` : "StackExchange returned no results.");

  return { backend: "stackexchange", items, notes };
};
