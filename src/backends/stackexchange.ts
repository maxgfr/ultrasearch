import type { Backend, BackendResult, RawSource } from "../types.js";
import { httpJson, htmlToText, decodeEntities } from "./fetch.js";
import { rankedKeywords } from "../util.js";

// Stack Overflow via the keyless StackExchange API (anonymous; ~modest rate
// limit, so one page only). Returns each question's title + body as text.
export const stackexchangeBackend: Backend = async (ctx): Promise<BackendResult> => {
  const q = rankedKeywords(ctx.question).slice(0, 6).join(" ") || ctx.question;
  const n = Math.max(3, Math.min(10, ctx.options.perSource));
  const url =
    `https://api.stackexchange.com/2.3/search/advanced?order=desc&sort=relevance` +
    `&q=${encodeURIComponent(q)}&site=stackoverflow&filter=withbody&pagesize=${n}`;
  const r = await httpJson("GET", url, undefined, { timeoutMs: 10000 });
  if (!r.ok || !Array.isArray(r.data?.items)) {
    return { backend: "stackexchange", items: [], notes: [`StackExchange search failed (status ${r.status}).`] };
  }
  const items: RawSource[] = r.data.items.slice(0, n).map((it: any, i: number): RawSource => {
    const title = decodeEntities(String(it.title ?? "Stack Overflow question"));
    const body = htmlToText(String(it.body ?? ""));
    return {
      url: String(it.link ?? `https://stackoverflow.com/q/${it.question_id}`),
      title,
      backend: "stackexchange",
      score: n - i + (it.is_answered ? 2 : 0),
      snippet: body.slice(0, 360),
      text: `${title}\n\n${body}`,
      meta: { answerScore: Number(it.score ?? 0) },
    };
  });
  return {
    backend: "stackexchange",
    items,
    notes: items.length ? [`StackExchange returned ${items.length} question(s).`] : ["StackExchange returned no results."],
  };
};
