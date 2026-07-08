import type { Backend, BackendResult, RawSource } from "../types.js";
import { httpJson } from "./fetch.js";
import { rankedKeywords, keywords } from "../util.js";

// Web standards & specifications via two keyless JSON APIs:
//   - IETF Datatracker (RFCs) — https://datatracker.ietf.org/api/v1/doc/document/
//   - MDN Web Docs search    — https://developer.mozilla.org/api/v1/search
// Surfaces the DEFINING spec for standards-backed topics (HTTP 429 → RFC 6585 +
// MDN), which keyless general search reliably missed. RFCs carry their abstract
// as text (rfc-editor.org serves clean full text for hydration); MDN hits are
// discovery-only (gather fetches the page).
const DATATRACKER = "https://datatracker.ietf.org/api/v1/doc/document/";
const MDN = "https://developer.mozilla.org/api/v1/search";

async function rfcByNumber(n: number): Promise<RawSource | null> {
  const r = await httpJson("GET", `${DATATRACKER}?format=json&name=rfc${n}`, undefined, { timeoutMs: 10000 });
  const o = Array.isArray(r.data?.objects) ? r.data.objects[0] : undefined;
  if (!o?.rfc_number) return null;
  return rfcSource(o, 100);
}

function rfcSource(o: any, score: number): RawSource {
  const n = Number(o.rfc_number);
  const title = String(o.title ?? `RFC ${n}`);
  const abstract = String(o.abstract ?? "").trim();
  return {
    url: `https://www.rfc-editor.org/rfc/rfc${n}`,
    title: `RFC ${n}: ${title}`,
    backend: "standards",
    score,
    snippet: abstract.slice(0, 360) || title,
    ...(abstract ? { text: `${title}\n\n${abstract}` } : {}),
    meta: { rfcNumber: n },
  };
}

export const standardsBackend: Backend = async (ctx): Promise<BackendResult> => {
  const items: RawSource[] = [];
  const notes: string[] = [];
  const seen = new Set<string>();
  const add = (s: RawSource | null) => {
    if (s && !seen.has(s.url)) {
      seen.add(s.url);
      items.push(s);
    }
  };
  const perSource = Math.max(3, Math.min(8, ctx.options.perSource));
  const qTerms = new Set(keywords(ctx.question));

  // 1. Explicit "RFC 6585" mentions → direct datatracker lookups (cap 3).
  const rfcNums = [...new Set([...ctx.question.matchAll(/\bRFC[-\s]?(\d{3,5})\b/gi)].map((m) => Number(m[1])))].slice(0, 3);
  const [rfcHits, mdnResult, titleResult] = await Promise.all([
    Promise.all(rfcNums.map((n) => rfcByNumber(n).catch(() => null))),
    // 2. MDN search (discovery — url + summary, gather hydrates).
    httpJson("GET", `${MDN}?q=${encodeURIComponent(ctx.question)}&locale=en-US`, undefined, { timeoutMs: 10000 }).catch(() => ({
      ok: false,
      status: 0,
      data: undefined,
    })),
    // 3. Datatracker keyword title search (kept only when rfc_number is set and
    //    a query term actually appears — kills the "RFC 2429 shares digits" class).
    (() => {
      const bigram = rankedKeywords(ctx.question).slice(0, 2).join(" ");
      if (!bigram) return Promise.resolve({ ok: false, status: 0, data: undefined });
      return httpJson("GET", `${DATATRACKER}?format=json&title__icontains=${encodeURIComponent(bigram)}&limit=10`, undefined, { timeoutMs: 10000 }).catch(
        () => ({
          ok: false,
          status: 0,
          data: undefined,
        }),
      );
    })(),
  ]);

  for (const s of rfcHits) add(s);

  const mdnDocs: any[] = Array.isArray(mdnResult.data?.documents) ? mdnResult.data.documents : [];
  for (let i = 0; i < Math.min(perSource, mdnDocs.length, 5); i++) {
    const d = mdnDocs[i];
    if (!d?.mdn_url) continue;
    add({
      url: `https://developer.mozilla.org${d.mdn_url}`,
      title: String(d.title ?? d.mdn_url),
      backend: "standards",
      score: 50 - i,
      snippet: String(d.summary ?? "").slice(0, 360),
    });
  }

  const titleObjs: any[] = Array.isArray(titleResult.data?.objects) ? titleResult.data.objects : [];
  let kept = 0;
  for (const o of titleObjs) {
    if (kept >= 5) break;
    if (!o?.rfc_number) continue; // slides / drafts without an RFC number
    // Word-boundary relevance re-check: a query term must appear in the title
    // or abstract, so RFC 2429 (only shares the "2429"/"429" digits) is dropped.
    const hay = keywords(`${o.title ?? ""} ${o.abstract ?? ""}`);
    if (![...qTerms].some((t) => hay.includes(t))) continue;
    add(rfcSource(o, 40 - kept));
    kept++;
  }

  const apiDown = !mdnResult.ok && !titleResult.ok && rfcHits.every((x) => x === null);
  if (apiDown) notes.push("Standards backends (IETF datatracker + MDN) were unreachable.");
  notes.push(items.length ? `Standards backend returned ${items.length} spec(s).` : "Standards backend found no matching specs.");
  return { backend: "standards", items, notes };
};
