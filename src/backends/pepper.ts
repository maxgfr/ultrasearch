import type { Backend, BackendResult, CodeMention, RawSource } from "../types.js";
import { httpGet, htmlToText, decodeEntities, looksLikeJunkExtraction, browserUa } from "./fetch.js";
import { awaitHostSlot, looksLikeChallenge, throttleReason } from "../engine.js";
import { cleanCode, merchantOf } from "../codes.js";
import { acceptLanguageHeader } from "../locale.js";

// The Pepper network — Dealabs, hotukdeals, mydealz and their siblings: one
// platform, one markup, a community that posts deals and voucher codes and
// votes them up or marks them expired. Keyless, and the richest single source of
// codes there is, because a thread carries the code as a FIELD (`voucherCode`)
// rather than as prose to be guessed at.
//
// Two pages per site:
//   search    — /search?q=<merchant>: thread cards, each a JSON blob in a
//               `data-vue3` attribute (threadId, title, voucherCode, isExpired,
//               endDate, merchant…).
//   vouchers  — the merchant's code page (--depth deep): a Next.js payload of
//               active and expired voucher offers with code, terms and end date.
//
// Every thread is cited by its OWN page. The cards also carry `/visit/` links —
// affiliate click-outs — and those are never followed or cited.

export interface PepperSite {
  host: string;
  /** Search path, `{q}` = the url-encoded merchant. */
  search: string;
  /** The merchant voucher page, `{slug}` = Pepper's own merchant slug. Absent where the site has none. */
  vouchers?: string;
}

// Probed live 2026-10-01: every search path answered 200 with thread JSON; every
// vouchers path answered 200 for a real merchant slug. preisjaeger.at has no
// voucher section, and pepper.it is gone — it closed on 2025-08-14.
export const PEPPER_SITES: Record<string, PepperSite> = {
  fr: { host: "www.dealabs.com", search: "/search?q={q}", vouchers: "/codes-promo/{slug}" },
  gb: { host: "www.hotukdeals.com", search: "/search?q={q}", vouchers: "/vouchers/{slug}" },
  de: { host: "www.mydealz.de", search: "/search?q={q}", vouchers: "/gutscheine/{slug}" },
  at: { host: "www.preisjaeger.at", search: "/search?q={q}" },
  es: { host: "www.chollometro.com", search: "/search?q={q}", vouchers: "/cupones/{slug}" },
  pl: { host: "www.pepper.pl", search: "/search?q={q}", vouchers: "/kupony/{slug}" },
  nl: { host: "nl.pepper.com", search: "/search?q={q}", vouchers: "/kortingscode/{slug}" },
};
const REGION_ALIASES: Record<string, string> = { uk: "gb" };

/** The Pepper site for a run's country: --region first, else the language's region subtag, else the language itself. */
export function pepperSiteFor(lang: string, region?: string): { region: string; site: PepperSite } | undefined {
  const [base, sub] = lang.toLowerCase().split(/[-_]/);
  const key = (region ?? sub ?? (base === "en" ? "" : base) ?? "").toLowerCase();
  const r = REGION_ALIASES[key] ?? key;
  const site = PEPPER_SITES[r];
  return site ? { region: r, site } : undefined;
}

export interface PepperThread {
  id: string;
  title: string;
  /** The thread's own page — never an affiliate `/visit/` link. */
  url: string;
  merchant?: string;
  merchantSlug?: string;
  code?: string;
  price?: number;
  discount?: string;
  freeShipping?: boolean;
  expired: boolean;
  published?: string; // ISO
  expires?: string; // YYYY-MM-DD
  description?: string;
}

// ---------------------------------------------------------------------------
// Parsing
// ---------------------------------------------------------------------------

/** The balanced JSON object starting at `start` (a `{`), respecting strings. */
export function sliceJsonObject(text: string, start: number): string | undefined {
  let depth = 0;
  let inStr = false;
  for (let i = start; i < text.length; i++) {
    const c = text[i];
    if (inStr) {
      if (c === "\\") i++;
      else if (c === '"') inStr = false;
    } else if (c === '"') inStr = true;
    else if (c === "{") depth++;
    else if (c === "}" && --depth === 0) return text.slice(start, i + 1);
  }
  return undefined;
}

function tryJson(s: string | undefined): unknown {
  if (!s) return undefined;
  try {
    return JSON.parse(s);
  } catch {
    return undefined;
  }
}

// Every JSON blob a Pepper page embeds, in the shapes it has used: Vue mount
// attributes (data-vue3, formerly data-vue2), JSON <script> blocks (incl.
// JSON-LD), and a window.__INITIAL_STATE__ assignment.
function embeddedJson(html: string): unknown[] {
  const out: unknown[] = [];
  for (const m of html.matchAll(/\sdata-vue[23]=(?:'([^']*)'|"([^"]*)")/g)) out.push(tryJson(decodeEntities(m[1] ?? m[2] ?? "")));
  for (const m of html.matchAll(/<script\b[^>]*type=["']application\/(?:ld\+)?json["'][^>]*>([\s\S]*?)<\/script>/gi)) out.push(tryJson(m[1]!.trim()));
  const state = /__INITIAL_STATE__\s*=\s*\{/.exec(html);
  if (state) out.push(tryJson(sliceJsonObject(html, state.index + state[0].length - 1)));
  return out.filter((x) => x !== undefined);
}

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === "object" && v !== null && !Array.isArray(v);

// Depth-first: every object that is a thread (has a threadId and a title).
function collectThreads(node: unknown, out: Obj[], depth = 0): void {
  if (depth > 40) return;
  if (Array.isArray(node)) for (const v of node) collectThreads(v, out, depth + 1);
  else if (isObj(node)) {
    if ((typeof node.threadId === "string" || typeof node.threadId === "number") && typeof node.title === "string") out.push(node);
    for (const v of Object.values(node)) collectThreads(v, out, depth + 1);
  }
}

// Last resort when no blob parses: read the fields straight out of a 4 KB
// window after each "threadId". Cruder, but a markup change that breaks the
// attribute quoting still leaves the JSON text itself on the page.
function regexThreads(html: string): Obj[] {
  const text = html.replace(/&quot;/g, '"');
  const str = (win: string, key: string) => {
    const m = new RegExp(`"${key}":"((?:[^"\\\\]|\\\\.)*)"`).exec(win);
    return m ? (tryJson(`"${m[1]}"`) as string | undefined) : undefined;
  };
  const out: Obj[] = [];
  for (const m of text.matchAll(/"threadId":"?(\d+)"?/g)) {
    const win = text.slice(m.index!, m.index! + 4096);
    const title = str(win, "title");
    if (!title) continue;
    out.push({
      threadId: m[1],
      title,
      voucherCode: str(win, "voucherCode"),
      isExpired: /"isExpired":true/.test(win),
      merchant: { merchantName: str(win, "merchantName"), merchantUrlName: str(win, "merchantUrlName") },
    });
  }
  return out;
}

// threadId → the thread's own page, from the anchors on the page itself.
function threadLinks(html: string, host: string): Map<string, string> {
  const links = new Map<string, string>();
  const re = new RegExp(`href="(https://${host.replace(/\./g, "\\.")}/(?!visit/|share-deal/)[^"?#]+?-(\\d{4,}))"`, "g");
  for (const m of html.matchAll(re)) if (!links.has(m[2]!)) links.set(m[2]!, m[1]!);
  return links;
}

// A thread card's own text: its description, read from the <article> it sits in.
function cardText(html: string, id: string): string | undefined {
  const m = new RegExp(`<article\\b[^>]*id="thread_${id}"[\\s\\S]*?</article>`).exec(html);
  if (!m) return undefined;
  const t = htmlToText(m[0].replace(/<script[\s\S]*?<\/script>/gi, ""))
    .replace(/\s+/g, " ")
    .trim();
  return t ? t.slice(0, 1200) : undefined;
}

const num = (v: unknown) =>
  typeof v === "number" && Number.isFinite(v) ? v : typeof v === "string" && v.trim() && Number.isFinite(Number(v)) ? Number(v) : undefined;
const epochIso = (v: unknown) => {
  const n = num(isObj(v) ? v.timestamp : v);
  return n && n > 0 ? new Date(n * 1000).toISOString() : undefined;
};

/**
 * Every thread a Pepper search page carries. Structured JSON first (deep walk
 * over every embedded blob), the regex window as a fallback. Deduped by
 * threadId, page order kept, each url the thread's own page.
 */
export function parsePepperThreads(html: string, host: string): PepperThread[] {
  const raw: Obj[] = [];
  for (const blob of embeddedJson(html)) collectThreads(blob, raw);
  if (!raw.length) raw.push(...regexThreads(html));

  const links = threadLinks(html, host);
  const byId = new Map<string, PepperThread>();
  for (const t of raw) {
    const id = String(t.threadId);
    if (byId.has(id)) continue;
    const merchant = isObj(t.merchant) ? t.merchant : {};
    const shipping = isObj(t.shipping) ? t.shipping : {};
    const pct = num(t.percentage);
    const published = epochIso(t.publishedAt);
    const expires = epochIso(t.endDate)?.slice(0, 10);
    const code = typeof t.voucherCode === "string" ? t.voucherCode.trim() : "";
    byId.set(id, {
      id,
      title: decodeEntities(String(t.title)),
      url: links.get(id) ?? `https://${host}/share-deal/${id}`,
      ...(typeof merchant.merchantName === "string" ? { merchant: merchant.merchantName } : {}),
      ...(typeof merchant.merchantUrlName === "string" ? { merchantSlug: merchant.merchantUrlName } : {}),
      ...(code ? { code } : {}),
      ...(num(t.price) ? { price: num(t.price) } : {}),
      ...(pct ? { discount: `${pct}%` } : {}),
      ...(shipping.isFree === 1 || shipping.isFree === true ? { freeShipping: true } : {}),
      expired: t.isExpired === true || String(t.status ?? "").toLowerCase() === "expired",
      ...(published ? { published } : {}),
      ...(expires ? { expires } : {}),
      ...(cardText(html, id) ? { description: cardText(html, id) } : {}),
    });
  }
  return [...byId.values()];
}

export interface PepperVoucher {
  code: string;
  title: string;
  terms?: string;
  discount?: string;
  expires?: string; // YYYY-MM-DD
  expired: boolean;
}

// The text of a Next.js page's flight payload (self.__next_f.push([1,"…"])),
// where the voucher pages keep their data. Falls back to the raw page with its
// escaped quotes undone.
function flightText(html: string): string {
  const parts = [...html.matchAll(/self\.__next_f\.push\(\[1,("(?:[^"\\]|\\.)*")\]\)/g)].map((m) => tryJson(m[1]!));
  const text = parts.filter((p): p is string => typeof p === "string").join("");
  return text || html.replace(/\\"/g, '"');
}

/**
 * The voucher offers on a merchant's code page. A voucher sits under an
 * `…Offers` listing key; under an `…ExpiredOffers` one it is expired whatever
 * its end date says.
 */
export function parsePepperVouchers(html: string): PepperVoucher[] {
  const text = flightText(html);
  const listings = [...text.matchAll(/"(\w*Offers)":\{/g)].map((m) => ({ at: m.index!, expired: /expired/i.test(m[1]!) }));
  const out: PepperVoucher[] = [];
  const seen = new Set<string>();
  for (const m of text.matchAll(/"voucher":\{/g)) {
    const v = tryJson(sliceJsonObject(text, m.index! + m[0].length - 1));
    if (!isObj(v) || typeof v.code !== "string" || !v.code.trim()) continue;
    const listing = listings.filter((l) => l.at < m.index!).at(-1);
    const expired = !!listing?.expired;
    const key = `${v.code}|${expired}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const end = typeof v.endTime === "string" ? v.endTime.slice(0, 10) : undefined;
    out.push({
      code: v.code.trim(),
      title: typeof v.title === "string" ? v.title : v.code,
      ...(typeof v.termsAndConditions === "string" ? { terms: v.termsAndConditions } : {}),
      ...(typeof v.caption1 === "string" && /\d/.test(v.caption1) ? { discount: v.caption1.replace(/\s+/g, "") } : {}),
      ...(end && /^\d{4}-\d{2}-\d{2}$/.test(end) ? { expires: end } : {}),
      expired,
    });
  }
  return out;
}

// ---------------------------------------------------------------------------
// Backend
// ---------------------------------------------------------------------------

const fold = (s: string) =>
  s
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]/g, "");

function aboutMerchant(t: PepperThread, merchant: string | undefined): boolean {
  if (!merchant) return true;
  const m = fold(merchant);
  return [t.merchant, t.merchantSlug, t.title].some((v) => v && fold(v).includes(m));
}

function threadSource(t: PepperThread, i: number, total: number, merchant: string | undefined): RawSource {
  const code = t.code ? cleanCode(t.code, merchant) : undefined;
  const facts = [
    t.merchant && `Merchant: ${t.merchant}`,
    t.price !== undefined && `Price: ${t.price}`,
    code && `Code: ${code}`,
    t.discount && `Discount: ${t.discount}`,
    t.freeShipping && "Free shipping",
    t.expires && `Ends: ${t.expires}`,
    t.expired && "Status: expired",
  ].filter(Boolean);
  const mention: CodeMention | undefined = code
    ? {
        code,
        via: "structured",
        strength: "strong",
        ...(t.discount ? { discount: t.discount } : t.freeShipping ? { discount: "free shipping" } : {}),
        ...(t.expires ? { expires: t.expires } : {}),
        ...(t.expired ? { expired: true } : {}),
      }
    : undefined;
  const year = t.published ? new Date(t.published).getUTCFullYear() : undefined;
  return {
    url: t.url,
    title: t.expired ? `${t.title} (expired)` : t.title,
    backend: "pepper",
    // Live threads first, expired ones kept below them: an expired code is still evidence.
    score: (t.expired ? 0 : total) + total - i,
    snippet: [facts.join(" · "), t.description].filter(Boolean).join(" — ").slice(0, 360),
    text: [t.title, facts.join(" · "), t.description].filter(Boolean).join("\n\n"),
    meta: {
      ...(t.published ? { published: t.published, year } : {}),
      ...(mention ? { codes: [mention] } : {}),
    },
  };
}

function voucherSource(url: string, title: string, vouchers: PepperVoucher[], merchant: string | undefined): RawSource | undefined {
  const codes: CodeMention[] = [];
  const lines: string[] = [];
  for (const v of vouchers) {
    const code = cleanCode(v.code, merchant);
    if (!code) continue;
    lines.push(
      [
        `Code ${code}${v.expired ? " (expired)" : ""} — ${v.title}`,
        v.discount && `Discount: ${v.discount}`,
        v.expires && `Ends: ${v.expires}`,
        v.terms && `Terms: ${v.terms}`,
      ]
        .filter(Boolean)
        .join(" · "),
    );
    codes.push({
      code,
      via: "structured",
      strength: "strong",
      ...(v.discount ? { discount: v.discount } : {}),
      ...(v.expires ? { expires: v.expires } : {}),
      ...(v.expired ? { expired: true } : {}),
    });
  }
  if (!codes.length) return undefined;
  return {
    url,
    title,
    backend: "pepper",
    score: 1000, // the merchant's own code page outranks any single thread
    snippet: lines.slice(0, 2).join(" — ").slice(0, 360),
    text: [title, ...lines].join("\n\n"),
    meta: { codes },
  };
}

async function get(url: string, lang: string, region: string) {
  await awaitHostSlot(url);
  return httpGet(url, { accept: "text/html", acceptLanguage: acceptLanguageHeader(lang, region), userAgent: browserUa(), retries: 0, timeoutMs: 15000 });
}

function websearchHint(host: string, q: string): string {
  return `Search it with your own WebSearch instead — \`site:${host.replace(/^www\./, "")} ${q}\`.`;
}

export const pepperBackend: Backend = async (ctx): Promise<BackendResult> => {
  const found = pepperSiteFor(ctx.options.lang, ctx.options.region);
  if (!found) {
    return {
      backend: "pepper",
      items: [],
      notes: [
        `Pepper: no deal community for region "${ctx.options.region ?? ctx.options.lang}" — covered: ${Object.keys(PEPPER_SITES).join(", ")} (uk = gb). Pass --region to pick one.`,
      ],
    };
  }
  const { region, site } = found;
  const merchant = merchantOf(ctx.question);
  const q = merchant ?? ctx.question;
  const url = `https://${site.host}${site.search.replace("{q}", encodeURIComponent(q))}`;
  const r = await get(url, ctx.options.lang, region);
  if (!r.ok || !r.body) {
    return { backend: "pepper", items: [], notes: [`${site.host} search ${throttleReason(r.status, r.error).why}. ${websearchHint(site.host, q)}`] };
  }

  const threads = parsePepperThreads(r.body, site.host);
  if (!threads.length) {
    const wall = looksLikeChallenge(r.body) ? "challenge page" : looksLikeJunkExtraction(htmlToText(r.body));
    const why = wall ? `served a ${wall} instead of results` : "returned a page with 0 parsable threads — markup changed?";
    return { backend: "pepper", items: [], notes: [`${site.host} ${why} ${websearchHint(site.host, q)}`] };
  }

  const relevant = threads.filter((t) => aboutMerchant(t, merchant));
  const items = relevant.slice(0, Math.max(5, ctx.options.perSource * 2)).map((t, i, all) => threadSource(t, i, all.length, merchant));
  const withCodes = items.filter((it) => it.meta?.codes?.length).length;
  const expired = relevant.filter((t) => t.expired).length;
  const notes = [
    `${site.host}: ${items.length} thread(s) about "${q}"` +
      (threads.length > relevant.length ? ` (${threads.length - relevant.length} about other merchants dropped)` : "") +
      `, ${withCodes} carrying a voucher code` +
      (expired ? `, ${expired} marked expired by the community` : "") +
      ".",
  ];

  if (ctx.options.depth === "deep" && site.vouchers) {
    const slug = relevant.find((t) => t.merchantSlug)?.merchantSlug ?? (merchant ? merchant.toLowerCase().replace(/[^a-z0-9.]+/g, "-") : undefined);
    if (slug) {
      const vurl = `https://${site.host}${site.vouchers.replace("{slug}", encodeURIComponent(slug))}`;
      const vr = await get(vurl, ctx.options.lang, region);
      const vouchers = vr.ok && vr.body ? parsePepperVouchers(vr.body) : [];
      const title = vr.body ? (/<title>([^<]*)<\/title>/i.exec(vr.body)?.[1]?.trim() ?? vurl) : vurl;
      const src = voucherSource(vurl, decodeEntities(title), vouchers, merchant);
      if (src) {
        items.unshift(src);
        const kept = src.meta!.codes!;
        notes.push(`${site.host} voucher page: ${kept.length} code(s) (${kept.filter((c) => c.expired).length} expired).`);
      } else {
        notes.push(`${site.host} voucher page ${vurl}: ${vr.ok ? "no voucher code on it" : throttleReason(vr.status, vr.error).why}.`);
      }
    }
  }
  return { backend: "pepper", items, notes };
};
