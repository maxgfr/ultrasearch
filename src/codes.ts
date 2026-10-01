import { join } from "node:path";
import type { CodeMention, Manifest, Source, SourceMeta } from "./types.js";
import { writeArtifact } from "./no-write.js";
import type { ExtraSummary } from "./extras.js";
import { deaccent, escapeRegExp } from "./util.js";

// Discount-code extraction — the `codes` extra.
//
// Pure, deterministic, no I/O except `writeCodes`. Nothing here decides that a
// code WORKS: it finds tokens a page presents as a code, records what the page
// says about them, and ranks them by how independently they are corroborated.
// The reader confirms each one in its cited source; the report says UNVERIFIED
// until a human or a browser has tried it.
//
// The failure this is built against is the false positive. A coupon page is
// mostly uppercase noise — product names, SKUs, "BLACK FRIDAY", the merchant's
// own name — so a token is only taken when a code keyword sits right in front
// of it, and then still has to survive the stop lists below.

// ---------------------------------------------------------------------------
// Language data
// ---------------------------------------------------------------------------

// Words that introduce a code, longest first so "code promo" wins over "code".
// A bare "code" is deliberately absent: "error code E404" is not a coupon. It is
// only a keyword after a verb that applies it — see LEAD below.
const KEYWORDS = [
  // en
  "promotional code",
  "promo code",
  "discount code",
  "coupon code",
  "voucher code",
  "offer code",
  "referral code",
  "coupon",
  "voucher",
  // fr
  "code de réduction",
  "code de reduction",
  "code réduction",
  "code reduction",
  "bon de réduction",
  "bon de reduction",
  "code de remise",
  "code remise",
  "code avantage",
  "codes promo",
  "code promo",
  // de
  "gutscheincode",
  "rabattcode",
  "aktionscode",
  "promocode",
  "promo-code",
  "gutschein",
  // es / pt
  "código promocional",
  "codigo promocional",
  "código de descuento",
  "codigo de descuento",
  "código de desconto",
  "cupón",
  "cupon",
  "cupom",
  // it
  "codice promozionale",
  "codice sconto",
  "codice promo",
  "buono sconto",
  // nl
  "kortingscode",
  "kortingsbon",
  "couponcode",
  "actiecode",
  // pl
  "kod rabatowy",
  "kod promocyjny",
  "kupon rabatowy",
  "kupon",
].sort((a, b) => b.length - a.length);

// "use code X", "avec le code X", "mit dem Code X", "con el código X", "z kodem X".
const LEAD =
  "(?:use|using|with|enter|apply|redeem|avec|grâce au|grace au|via|utilise[rz]?|saisi(?:ssez|r)|entrez|tape[rz]?|mit|gib|nutze|usa(?:ndo)?|con|inserisci|met|gebruik|z|użyj|com)" +
  "(?:\\s+(?:the|le|la|dem|den|el|il|lo|de|o))?\\s+(?:code|codice|código|codigo|kod(?:em)?)";

// Discount-adjacent words that look like codes when a heading is in capitals.
const STOP_TOKENS = new Set([
  "CODE",
  "CODES",
  "PROMO",
  "PROMOS",
  "COUPON",
  "COUPONS",
  "VOUCHER",
  "VOUCHERS",
  "DISCOUNT",
  "OFFER",
  "OFFERS",
  "DEAL",
  "DEALS",
  "FREE",
  "SALE",
  "SALES",
  "OFF",
  "NEW",
  "BLACK",
  "FRIDAY",
  "CYBER",
  "MONDAY",
  "PRIME",
  "EXCLUSIVE",
  "VALID",
  "EXPIRED",
  "VERIFIED",
  "HTTP",
  "HTTPS",
  "HTML",
  "JSON",
  "NULL",
  "NONE",
  "TRUE",
  "FALSE",
  "WWW",
  "EUR",
  "EURO",
  "EUROS",
  "USD",
  "GBP",
  "PLN",
  "CHF",
  "TVA",
  "VAT",
  "TTC",
  "SKU",
  "EAN",
  "ISBN",
  "AVEC",
  "POUR",
  "SANS",
  "DANS",
  "VALABLE",
  "VALIDE",
  "GRATUIT",
  "GRATUITE",
  "OFFERT",
  "OFFERTE",
  "SOLDES",
  "REDUCTION",
  "REMISE",
  "LIVRAISON",
  "EXCLU",
  "EXCLUSIF",
  "RABATT",
  "GUTSCHEIN",
  "GUTSCHEINE",
  "AKTION",
  "GRATIS",
  "CUPON",
  "CUPONES",
  "DESCUENTO",
  "SCONTO",
  "CODICE",
  "KORTING",
  "KOD",
  "KUPON",
  "RABATOWY",
]);

// Month names → month number, the languages the keywords cover. Unaccented
// spellings are listed too: scraped text loses accents more often than not.
const MONTHS: Record<string, number> = {};
const MONTH_NAMES: string[][] = [
  ["january", "jan", "janvier", "janv", "januar", "jänner", "enero", "ene", "gennaio", "gen", "januari", "stycznia", "styczeń", "janeiro"],
  ["february", "feb", "février", "fevrier", "févr", "fevr", "februar", "febrero", "febbraio", "februari", "lutego", "luty", "fevereiro"],
  ["march", "mar", "mars", "märz", "maerz", "marz", "marzo", "maart", "marca", "marzec", "março", "marco"],
  ["april", "apr", "avril", "avr", "abril", "abr", "aprile", "kwietnia", "kwiecień"],
  ["may", "mai", "mayo", "maggio", "mag", "mei", "maja", "maj", "maio"],
  ["june", "jun", "juin", "juni", "junio", "giugno", "giu", "czerwca", "czerwiec", "junho"],
  ["july", "jul", "juillet", "juil", "juli", "julio", "luglio", "lug", "lipca", "lipiec", "julho"],
  ["august", "aug", "août", "aout", "agosto", "ago", "augustus", "sierpnia", "sierpień"],
  ["september", "sep", "sept", "septembre", "septiembre", "settembre", "set", "września", "wrzesnia", "wrzesień", "setembro"],
  ["october", "oct", "octobre", "oktober", "okt", "octubre", "ottobre", "ott", "października", "pazdziernika", "październik", "outubro", "out"],
  ["november", "nov", "novembre", "noviembre", "listopada", "listopad", "novembro"],
  ["december", "dec", "décembre", "decembre", "déc", "dezember", "dez", "diciembre", "dic", "dicembre", "grudnia", "grudzień", "dezembro"],
];
MONTH_NAMES.forEach((names, i) => {
  for (const n of names) MONTHS[n] = i + 1;
});
for (const n of Object.keys(MONTHS)) if (n.length >= 4) STOP_TOKENS.add(deaccent(n).toUpperCase());

// What precedes a minimum spend, and what precedes an expiry date.
const MIN_MARKER =
  "(?:dès|des|à partir de|a partir de|minimum(?:\\s+(?:d'achat|d’achat|de commande|order|spend|purchase))?(?:\\s+(?:de|of))?|min\\.?|" +
  "on orders? (?:over|of|above)|orders? (?:over|above)|when you spend|spend(?:\\s+(?:over|at least))?|over|" +
  "ab(?:\\s+einem\\s+(?:Einkauf|Bestellwert)\\s+von)?|Mindestbestellwert(?:\\s+von)?|desde|compra mínima de|" +
  "da|con una spesa minima di|vanaf|bij besteding van|od|przy zakupach (?:za|od)|powyżej)";
const EXP_MARKER =
  "(?:expires?|expiring|expiry|exp\\.|valid (?:until|till|through|thru|to)|ends?|until|till|" +
  "jusqu['’]?(?:au|à)|valable jusqu['’]?(?:au|à)|expire le|fin le|se termine le|" +
  "gültig bis(?: zum)?|bis zum|bis|endet am|" +
  "válido hasta(?: el)?|valido hasta(?: el)?|hasta el|hasta|" +
  "valido fino al|fino al|scade il|" +
  "geldig (?:t\\/m|tot(?: en met)?)|tot en met|t\\/m|" +
  "ważny do|wazny do|do)";

// ---------------------------------------------------------------------------
// Patterns
// ---------------------------------------------------------------------------

// Lower-cased, accent-free, alphanumerics only — "La Redoute" matches "laredoute.fr".
const foldText = (s: string) => deaccent(s.toLowerCase()).replace(/[^a-z0-9]/g, "");

const BOUNDARY_BEFORE = "(?<![\\p{L}\\p{N}_])";
const KEYWORD_RE = new RegExp(`${BOUNDARY_BEFORE}(?:${KEYWORDS.map(escapeRegExp).join("|")})(?:s|e|n)?(?![\\p{L}\\p{N}])`, "giu");
const HAS_KEYWORD = new RegExp(KEYWORD_RE.source, "iu"); // non-global: safe to .test()
const LEAD_RE = new RegExp(`${BOUNDARY_BEFORE}${LEAD}(?![\\p{L}\\p{N}])|${BOUNDARY_BEFORE}code\\s*[:：]`, "giu");
// What may sit between a keyword and its code: punctuation, quotes, emphasis.
const STRONG_RE = /^[\s:：=\-–—>»«"“”„'‘’*`([]{0,6}([A-Za-z0-9][A-Za-z0-9_-]{3,19})(?![A-Za-z0-9_-]|\.\.|…)/u; // "IMAG…" is a truncated code, never a code
const QUOTED_RE = /(?:\*\*|__|["“”«»„'‘’`])\s*([A-Za-z0-9][A-Za-z0-9_-]{3,19})\s*(?:\*\*|__|["“”«»'‘’`])/gu;
const WEAK_WINDOW = 60;
const REPEAT_WINDOW = 80;
const TOKEN_SHAPE = /^[A-Z0-9][A-Z0-9_-]{3,19}$/;

/**
 * Normalize a candidate code, or reject it. Shape: 4–20 of [A-Z0-9_-], at least
 * one letter. Rejected: years/EANs/SKUs (6+ digits in a row), hex hashes, the
 * stop vocabulary, and the merchant's own name. A token written in lower case is
 * only a code if it also carries a digit ("save20" yes, "valable" no).
 */
function acceptToken(raw: string, merchant?: string, structured = false): string | undefined {
  const token = raw.trim();
  if (!structured && /[a-z]/.test(token) && !/\d/.test(token)) return undefined;
  const up = token.toUpperCase();
  if (!TOKEN_SHAPE.test(up) || !/[A-Z]/.test(up)) return undefined;
  if (/\d{6,}/.test(up)) return undefined;
  if (up.length >= 12 && /^[0-9A-F]+$/.test(up)) return undefined;
  if (STOP_TOKENS.has(up)) return undefined;
  if (merchant) {
    const m = deaccent(merchant).toUpperCase();
    if (up === m.replace(/[^A-Z0-9]/g, "")) return undefined;
    if (m.split(/[^A-Z0-9]+/).some((w) => w.length >= 4 && w === up)) return undefined;
  }
  return up;
}

/** A deal site's own voucher field, kept only when it is shaped like a code ("APP5" yes, "20% Coupon" no). */
export function cleanCode(raw: string, merchant?: string): string | undefined {
  return raw ? acceptToken(raw, merchant, true) : undefined;
}

// ---------------------------------------------------------------------------
// Merchant
// ---------------------------------------------------------------------------

const MERCHANT_NOISE = new Set([
  ...KEYWORDS.flatMap((k) => k.split(/[\s-]+/)),
  "code",
  "codes",
  "promo",
  "promos",
  "coupons",
  "vouchers",
  "discount",
  "discounts",
  "deal",
  "deals",
  "offer",
  "offers",
  "sale",
  "sales",
  "reduction",
  "réduction",
  "réductions",
  "remise",
  "bons",
  "plans",
  "gutscheine",
  "rabatt",
  "descuento",
  "descuentos",
  "sconto",
  "korting",
  "rabat",
  "de",
  "du",
  "des",
  "le",
  "les",
  "pour",
  "chez",
  "sur",
  "en",
  "au",
  "for",
  "the",
  "at",
  "on",
  "in",
  "of",
  "best",
  "latest",
  "working",
  "valid",
  "bei",
  "für",
  "fur",
  "von",
  "para",
  "en",
  "per",
  "voor",
  "na",
  "dla",
  "w",
  "and",
  "et",
  "und",
  "y",
  "uk",
  "us",
  "usa",
  "fr",
  "france",
  "de",
  "deutschland",
  "es",
  "espana",
  "españa",
  "it",
  "italia",
  "nl",
  "pl",
]);

/**
 * The merchant a deals question is about: the registrable name of a domain when
 * the question names one ("decathlon.fr" → "decathlon"), otherwise the words
 * left once the deal vocabulary, dates and glue words are gone.
 */
export function merchantOf(question: string): string | undefined {
  const host = /(?:https?:\/\/)?((?:[a-z0-9-]+\.)+[a-z]{2,})(?=[/\s?#]|$)/i.exec(question.trim())?.[1];
  if (host) {
    const labels = host
      .toLowerCase()
      .replace(/^www\d?\./, "")
      .split(".");
    const n = labels.length;
    const secondLevel = n >= 3 && /^(co|com|org|net|gov|ac|edu)$/.test(labels[n - 2]!) && labels[n - 1]!.length === 2;
    const name = secondLevel ? labels[n - 3] : labels[n - 2];
    if (name) return name;
  }
  const words = question
    .toLowerCase()
    .split(/[^\p{L}\p{N}'’&-]+/u)
    .filter((w) => w && !MERCHANT_NOISE.has(w) && !(w in MONTHS) && !/^\d+$/.test(w));
  return words.length ? words.join(" ") : undefined;
}

// ---------------------------------------------------------------------------
// Discount, minimum spend, expiry
// ---------------------------------------------------------------------------

const CURRENCY: Record<string, { sym: string; prefix: boolean }> = {
  "€": { sym: "€", prefix: false },
  eur: { sym: "€", prefix: false },
  euro: { sym: "€", prefix: false },
  euros: { sym: "€", prefix: false },
  "£": { sym: "£", prefix: true },
  gbp: { sym: "£", prefix: true },
  $: { sym: "$", prefix: true },
  usd: { sym: "$", prefix: true },
  zł: { sym: "zł", prefix: false },
  zl: { sym: "zł", prefix: false },
  pln: { sym: "zł", prefix: false },
  chf: { sym: "CHF", prefix: false },
};
const NUM = "(\\d{1,5}(?:[.,]\\d{1,2})?)";
const AMOUNT = `(?:([€£$])\\s?${NUM}|${NUM}\\s?(€|£|\\$|zł|zl|chf|eur|euros?|gbp|usd|pln)(?![\\p{L}]))`;
const AMOUNT_RE = new RegExp(AMOUNT, "giu");
const MIN_RE = new RegExp(`${BOUNDARY_BEFORE}${MIN_MARKER}\\s*${AMOUNT}`, "giu");
const PERCENT_RE = /(?<![\d.,])(\d{1,2}(?:[.,]\d)?)\s?%/g;
const FREE_SHIPPING_RE =
  /livraison (?:offerte|gratuite)|frais de port (?:offerts|gratuits)|free (?:shipping|delivery|postage)|versandkostenfrei|kostenlose[rn]? versand|gratis versand|env[ií]o gratis|envio gratuito|spedizione gratuita|gratis verzending|darmowa dostawa/i;

function formatAmount(m: RegExpExecArray): string {
  const sym = (m[1] ?? m[4] ?? "").toLowerCase();
  const num = (m[2] ?? m[3] ?? "").replace(/[.,]00$/, "");
  const c = CURRENCY[sym] ?? { sym, prefix: false };
  return c.prefix ? `${c.sym}${num}` : `${num} ${c.sym}`;
}

function readDiscount(window: string): { discount?: string; minSpend?: string } {
  const out: { discount?: string; minSpend?: string } = {};
  const minSpans: [number, number][] = [];
  for (const m of window.matchAll(MIN_RE)) {
    const amount = new RegExp(AMOUNT, "iu").exec(m[0]);
    if (!amount) continue;
    out.minSpend ??= formatAmount(amount);
    minSpans.push([m.index!, m.index! + m[0].length]);
  }
  const insideMin = (i: number) => minSpans.some(([a, b]) => i >= a && i < b);
  const hits: { at: number; value: string }[] = [];
  for (const m of window.matchAll(PERCENT_RE)) if (!insideMin(m.index!)) hits.push({ at: m.index!, value: `${m[1]!.replace(",", ".")}%` });
  for (const m of window.matchAll(AMOUNT_RE)) if (!insideMin(m.index!)) hits.push({ at: m.index!, value: formatAmount(m) });
  hits.sort((a, b) => a.at - b.at);
  if (hits[0]) out.discount = hits[0].value;
  else if (FREE_SHIPPING_RE.test(window)) out.discount = "free shipping";
  return out;
}

const MONTH_WORD = `(${Object.keys(MONTHS)
  .sort((a, b) => b.length - a.length)
  .map(escapeRegExp)
  .join("|")})`;
const DATE_ISO = /^(\d{4})-(\d{1,2})-(\d{1,2})/;
const DATE_NUM = /^(\d{1,2})[./-](\d{1,2})(?:[./-](\d{4}|\d{2}))?(?!\d)/;
const DATE_DM = new RegExp(`^(\\d{1,2})(?:er|st|nd|rd|th|\\.)?\\s+(?:de\\s+)?${MONTH_WORD}\\.?(?:,?\\s+(?:de\\s+)?(\\d{4}))?(?![\\p{L}])`, "iu");
const DATE_MD = new RegExp(`^${MONTH_WORD}\\.?\\s+(\\d{1,2})(?:st|nd|rd|th)?(?:,?\\s+(\\d{4}))?(?![\\p{L}\\d])`, "iu");
const EXP_RE = new RegExp(`${BOUNDARY_BEFORE}${EXP_MARKER}\\s*(?:le\\s+|the\\s+|am\\s+|el\\s+|il\\s+|on\\s+)?`, "giu");

function iso(y: number, m: number, d: number): string | undefined {
  if (m < 1 || m > 12 || d < 1 || d > 31) return undefined;
  const dt = new Date(Date.UTC(y, m - 1, d));
  if (dt.getUTCMonth() !== m - 1) return undefined; // 31/02
  return dt.toISOString().slice(0, 10);
}

/** Parse a date at the start of `s`. dd/mm everywhere except the US, where mm/dd. A missing year is the run's. */
export function parseDateAt(s: string, opts: { region?: string; lang?: string; now: string }): string | undefined {
  const nowYear = Number(opts.now.slice(0, 4));
  const year = (y?: string) => (!y ? nowYear : y.length === 2 ? 2000 + Number(y) : Number(y));
  const us = (opts.region ?? "").toLowerCase() === "us" || /-us$/i.test(opts.lang ?? "");
  let m = DATE_ISO.exec(s);
  if (m) return iso(Number(m[1]), Number(m[2]), Number(m[3]));
  m = DATE_NUM.exec(s);
  if (m) {
    const [a, b] = [Number(m[1]), Number(m[2])];
    return us ? iso(year(m[3]), a, b) : iso(year(m[3]), b, a);
  }
  m = DATE_DM.exec(s);
  if (m) return iso(year(m[3]), MONTHS[m[2]!.toLowerCase()] ?? 0, Number(m[1]));
  m = DATE_MD.exec(s);
  if (m) return iso(year(m[3]), MONTHS[m[1]!.toLowerCase()] ?? 0, Number(m[2]));
  return undefined;
}

function readExpiry(window: string, opts: ExtractOptions): string | undefined {
  for (const m of window.matchAll(EXP_RE)) {
    const date = parseDateAt(window.slice(m.index! + m[0].length), opts);
    if (date) return date;
  }
  return undefined;
}

// The sentence a code sits in; when it states no discount, the next sentence
// too — unless that one introduces a code of its own.
const SENTENCE_END = /[.!?;](?=\s+[\p{Lu}\d"“«(*]|\s*$)|\n/gu;
function sentenceAround(text: string, at: number): { here: string; next: string } {
  let start = 0;
  let end = text.length;
  let nextEnd = text.length;
  for (const m of text.matchAll(SENTENCE_END)) {
    const stop = m.index! + 1;
    if (stop <= at) start = stop;
    else if (end === text.length) end = stop;
    else {
      nextEnd = stop;
      break;
    }
  }
  return { here: text.slice(Math.max(start, at - 200), Math.min(end, at + 240)), next: text.slice(end, Math.min(nextEnd, end + 240)) };
}

// ---------------------------------------------------------------------------
// Extraction
// ---------------------------------------------------------------------------

export interface ExtractOptions {
  lang?: string;
  region?: string;
  /** ISO timestamp the run is anchored to — the year a year-less date takes. Never Date.now(), so a dossier re-renders identically. */
  now: string;
  merchant?: string;
}

/** Fold one reading of a code into another: strongest wins, fields only fill gaps, structured stays structured. */
function mergeMention(a: CodeMention, b: CodeMention): CodeMention {
  const out: CodeMention = { ...a };
  if (b.via === "structured") out.via = "structured";
  if (b.strength === "strong") out.strength = "strong";
  for (const k of ["discount", "minSpend", "expires", "context"] as const) if (out[k] === undefined && b[k] !== undefined) out[k] = b[k];
  if (b.expired) out.expired = true;
  return out;
}

/**
 * Every code a text presents, keyword-anchored. Strong: a code keyword or an
 * applying verb ("use code", "avec le code") immediately followed by the token.
 * Weak: a quoted or bold token within 60 characters after a keyword. A token
 * seen three or more times OUTSIDE any keyword window is a product name, not a
 * code, and is dropped. One mention per code, strongest reading kept.
 */
export function extractCodes(text: string, opts: ExtractOptions): CodeMention[] {
  if (!text) return [];
  // `applied` = introduced by a verb that applies a code ("use code", "avec le
  // code promo"), as opposed to a bare keyword ("les codes promo ASOS").
  const leads = [...text.matchAll(LEAD_RE)].map((m) => ({ start: m.index!, end: m.index! + m[0].length }));
  const anchors: { end: number; applied: boolean }[] = leads.map((l) => ({ end: l.end, applied: true }));
  for (const m of text.matchAll(KEYWORD_RE)) {
    const [start, end] = [m.index!, m.index! + m[0].length];
    anchors.push({ end, applied: leads.some((l) => l.end > start && l.end <= end) });
  }
  if (!anchors.length) return [];
  anchors.sort((a, b) => a.end - b.end);

  const found: { code: string; at: number; strength: CodeMention["strength"] }[] = [];
  for (const { end, applied } of anchors) {
    const strong = STRONG_RE.exec(text.slice(end, end + 40));
    // A bare word straight after a keyword names a brand ("codes promo ASOS");
    // it is a code only with a digit, a separator or quotes, or a verb applying it.
    const bareWord = !!strong && !applied && !/\d/.test(strong[1]!) && !/\S/.test(strong[0].slice(0, -strong[1]!.length));
    const code = strong && !bareWord ? acceptToken(strong[1]!, opts.merchant) : undefined;
    if (code) {
      found.push({ code, at: end + strong!.index + strong![0].length - strong![1]!.length, strength: "strong" });
      continue;
    }
    const window = text.slice(end, end + WEAK_WINDOW);
    for (const q of window.matchAll(QUOTED_RE)) {
      const weak = acceptToken(q[1]!, opts.merchant);
      if (weak) {
        found.push({ code: weak, at: end + q.index! + q[0].indexOf(q[1]!), strength: "weak" });
        break;
      }
    }
  }

  const inWindow = (at: number) => anchors.some((a) => at >= a.end && at - a.end <= REPEAT_WINDOW);
  const byCode = new Map<string, CodeMention>();
  for (const f of found) {
    // A product name: repeated across the page with no keyword in front of it.
    const outside = [...text.matchAll(new RegExp(`(?<![A-Za-z0-9_-])${escapeRegExp(f.code)}(?![A-Za-z0-9_-])`, "gi"))].filter(
      (m) => !inWindow(m.index!),
    ).length;
    if (outside >= 3) continue;
    const { here, next } = sentenceAround(text, f.at);
    // The following sentence only speaks for this code if it names no code of its own.
    const tail = next && !HAS_KEYWORD.test(next) ? next : "";
    const terms = readDiscount(here);
    const discount = terms.discount ?? (tail ? readDiscount(tail).discount : undefined);
    const expires = readExpiry(here, opts) ?? (tail ? readExpiry(tail, opts) : undefined);
    const mention: CodeMention = {
      code: f.code,
      via: "text",
      strength: f.strength,
      ...(discount ? { discount } : {}),
      ...(terms.minSpend ? { minSpend: terms.minSpend } : {}),
      ...(expires ? { expires } : {}),
      context: here.replace(/\s+/g, " ").trim().slice(0, 160),
    };
    const prev = byCode.get(f.code);
    byCode.set(
      f.code,
      prev ? (prev.strength === "weak" && mention.strength === "strong" ? mergeMention(mention, prev) : mergeMention(prev, mention)) : mention,
    );
  }
  return [...byCode.values()];
}

/**
 * Fold the codes a source's text presents into its meta, alongside any a
 * backend already recorded (Pepper's own voucher field). Idempotent: running it
 * again over the same text changes nothing, which is what lets `merge`
 * re-annotate sources that already carry codes. Returns `meta` itself when there
 * is nothing to add.
 *
 * A page that never names the merchant contributes no text codes: a forum
 * thread's real code for some other shop is still the wrong code. (Measured on a
 * live Decathlon run, where Reddit's search answered with an opera's promo code.)
 * Structured codes are kept — the backend already matched them to the merchant.
 * `about` (the page's title and url) counts as naming it: the merchant's own
 * codes page never repeats its name in the body (boulanger.com's doesn't).
 */
export function annotateCodes(text: string, meta: SourceMeta | undefined, opts: ExtractOptions, about = ""): SourceMeta | undefined {
  if (opts.merchant && !foldText(`${about} ${text}`).includes(foldText(opts.merchant))) return meta;
  const extracted = extractCodes(text, opts);
  if (!extracted.length) return meta;
  const merged = new Map<string, CodeMention>();
  for (const c of meta?.codes ?? []) merged.set(c.code, c);
  for (const c of extracted) {
    const prev = merged.get(c.code);
    merged.set(c.code, prev ? mergeMention(prev, c) : c);
  }
  return { ...meta, codes: [...merged.values()] };
}

// ---------------------------------------------------------------------------
// Aggregation across a dossier
// ---------------------------------------------------------------------------

export type Confidence = "high" | "medium" | "low";

export interface CodeCandidate {
  code: string;
  discount?: string;
  minSpend?: string;
  expires?: string;
  sources: string[]; // [S#] ids, dossier order
  domains: number; // DISTINCT domains — two pages of one site are one witness
  structured: boolean;
  strength: CodeMention["strength"];
  score: number;
  confidence: Confidence;
}

export interface CodesFile {
  merchant?: string;
  region?: string;
  builtAt: string;
  candidates: CodeCandidate[];
  expired: CodeCandidate[];
}

function idNum(id: string): number {
  return Number(/^S(\d+)$/.exec(id)?.[1] ?? 0);
}

// The most-cited value of a field across a code's readings; ties go to the earliest source.
function consensus(values: (string | undefined)[]): string | undefined {
  const counts = new Map<string, number>();
  for (const v of values) if (v) counts.set(v, (counts.get(v) ?? 0) + 1);
  let best: string | undefined;
  for (const [v, n] of counts) if (best === undefined || n > counts.get(best)!) best = v;
  return best;
}

/**
 * Rank every code across a dossier's sources.
 *
 *   score = 3·structured + 2·min(domains, 4) + strong + (discount ? 1 : 0)
 *           + (future expiry ? 1 : 0) − 5·expired
 *
 * Expired means an expiry before the run's own `builtAt` date (never the wall
 * clock, so the same dossier always ranks the same), or a source that itself
 * marks the code expired with no reading giving a later date. Ties sort by code.
 */
export function aggregateCodes(sources: Source[], manifest: Pick<Manifest, "builtAt">): { candidates: CodeCandidate[]; expired: CodeCandidate[] } {
  const today = manifest.builtAt.slice(0, 10);
  const groups = new Map<string, { source: Source; mention: CodeMention }[]>();
  for (const s of [...sources].sort((a, b) => idNum(a.id) - idNum(b.id))) {
    for (const mention of s.meta?.codes ?? []) {
      const g = groups.get(mention.code) ?? [];
      g.push({ source: s, mention });
      groups.set(mention.code, g);
    }
  }
  const all: (CodeCandidate & { isExpired: boolean })[] = [];
  for (const [code, g] of groups) {
    const ms = g.map((x) => x.mention);
    const structured = ms.some((m) => m.via === "structured");
    const strength = ms.some((m) => m.strength === "strong") ? "strong" : "weak";
    const domains = new Set(g.map((x) => x.source.domain)).size;
    const expires = ms
      .map((m) => m.expires)
      .filter((d): d is string => !!d)
      .sort()
      .at(-1);
    const future = !!expires && expires >= today;
    const isExpired = (!!expires && expires < today) || (ms.some((m) => m.expired) && !future);
    const discount = consensus(ms.map((m) => m.discount));
    const minSpend = consensus(ms.map((m) => m.minSpend));
    const score =
      3 * Number(structured) + 2 * Math.min(domains, 4) + Number(strength === "strong") + Number(!!discount) + Number(future) - 5 * Number(isExpired);
    all.push({
      code,
      ...(discount ? { discount } : {}),
      ...(minSpend ? { minSpend } : {}),
      ...(expires ? { expires } : {}),
      sources: [...new Set(g.map((x) => x.source.id))],
      domains,
      structured,
      strength,
      score,
      confidence: score >= 8 ? "high" : score >= 5 ? "medium" : "low",
      isExpired,
    });
  }
  all.sort((a, b) => b.score - a.score || b.domains - a.domains || a.code.localeCompare(b.code));
  const strip = ({ isExpired: _, ...c }: CodeCandidate & { isExpired: boolean }): CodeCandidate => c;
  return { candidates: all.filter((c) => !c.isExpired).map(strip), expired: all.filter((c) => c.isExpired).map(strip) };
}

/** The extraction options a dossier implies: its language, region, anchor date and merchant. */
export function codesOptions(manifest: Pick<Manifest, "lang" | "region" | "builtAt" | "question">): ExtractOptions {
  return { lang: manifest.lang, region: manifest.region, now: manifest.builtAt, merchant: merchantOf(manifest.question) };
}

const TABLE_ROWS = 15;

/**
 * Write codes.json and return the DOSSIER.md block: the top candidates as a
 * table, labelled UNVERIFIED, with the rule that every code must be confirmed in
 * the [S#] it cites and never invented or completed.
 */
export function writeCodes(dir: string, sources: Source[], manifest: Pick<Manifest, "lang" | "region" | "builtAt" | "question">): string[] {
  const { candidates, expired } = aggregateCodes(sources, manifest);
  const merchant = merchantOf(manifest.question);
  const file: CodesFile = {
    ...(merchant ? { merchant } : {}),
    ...(manifest.region ? { region: manifest.region } : {}),
    builtAt: manifest.builtAt,
    candidates,
    expired,
  };
  writeArtifact(join(dir, "codes.json"), JSON.stringify(file, null, 2));

  const out = [
    "## Candidate codes (extracted — UNVERIFIED)",
    "",
    "> Machine-extracted from the sources below and **never tested**. Before a code goes in the report, confirm it in the " +
      "`[S#]` it cites — the page must show that exact code for this merchant. **Never invent, guess or complete a code**, " +
      "and never present one as working unless it was tried. Full list, with expired codes: `codes.json`.",
    "",
  ];
  if (!candidates.length) {
    out.push(
      `_No candidate code was extracted from these sources${expired.length ? ` (${expired.length} expired one(s) are listed in codes.json)` : ""}. Search the merchant's own offers and the deal sites yourself before concluding there is none._`,
    );
    return out;
  }
  out.push("| Code | Discount | Conditions | Expires | Sources | Confidence |");
  out.push("|---|---|---|---|---|---|");
  for (const c of candidates.slice(0, TABLE_ROWS)) {
    out.push(
      `| \`${c.code}\` | ${c.discount ?? "—"} | ${c.minSpend ? `min. ${c.minSpend}` : "—"} | ${c.expires ?? "—"} | ${c.sources.map((s) => `[${s}]`).join("")} | ${c.confidence} |`,
    );
  }
  const more = candidates.length - TABLE_ROWS;
  if (more > 0) out.push("", `_${more} more candidate(s) in codes.json._`);
  if (expired.length) out.push("", `_${expired.length} expired code(s) left out of this table — see \`expired\` in codes.json._`);
  return out;
}

/**
 * The codes to try, as the run hands them back (gather's report, `--json`, the
 * MCP result) — every candidate, best first, each with the sources to confirm
 * it in. The list is the deliverable of a deals run, so it is printed, not left
 * in a file for the caller to discover.
 */
export function codesSummary(sources: Source[], manifest: Pick<Manifest, "builtAt">): ExtraSummary {
  const { candidates, expired } = aggregateCodes(sources, manifest);
  const data = {
    to_try: candidates.map((c) => ({
      code: c.code,
      ...(c.discount ? { discount: c.discount } : {}),
      ...(c.minSpend ? { min_spend: c.minSpend } : {}),
      ...(c.expires ? { expires: c.expires } : {}),
      confidence: c.confidence,
      sources: c.sources,
    })),
    expired: expired.map((c) => c.code),
  };
  if (!candidates.length) {
    return {
      key: "codes",
      data,
      lines: [
        `  codes:    none extracted${expired.length ? ` (${expired.length} expired: ${data.expired.join(", ")})` : ""} — search the deal sites yourself and ingest them`,
      ],
    };
  }
  // One cell per column, padded to the column's widest, so the list reads as a
  // table — a missing minimum or expiry is a blank cell, not a shift left.
  const cells = candidates.map((c) => [
    c.code,
    c.discount ?? "—",
    c.minSpend ? `min. ${c.minSpend}` : "",
    c.expires ? `until ${c.expires}` : "",
    c.confidence,
    c.sources.map((s) => `[${s}]`).join(""),
  ]);
  const widths = cells[0]!.map((_, i) => Math.max(...cells.map((row) => row[i]!.length)));
  const lines = [
    `  codes:    ${candidates.length} to try — UNVERIFIED: confirm each in its [S#], never pay to test (full list: codes.json)`,
    ...cells.map((row) =>
      `            ${row
        .map((cell, i) => (i === row.length - 1 ? cell : cell.padEnd(widths[i]!)))
        .filter((_, i) => widths[i]! > 0)
        .join("  ")}`.trimEnd(),
    ),
    ...(expired.length ? [`            expired: ${data.expired.join(", ")}`] : []),
  ];
  return { key: "codes", data, lines };
}
