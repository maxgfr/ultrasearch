import { buildMatcher } from "../util.js";
import { pdfToText } from "./pdf.js";

// A realistic desktop-browser User-Agent. Several keyless web endpoints (DDG,
// Mojeek) serve 403/empty to obvious bot UAs, so scrapers default to this.
// Override with ULTRASEARCH_UA. Polite JSON/XML APIs (arXiv, Crossref) instead
// pass CONTACT_UA per call so they can attribute / rate-limit us courteously.
export const BROWSER_UA =
  process.env.ULTRASEARCH_UA || "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";
export const CONTACT_UA = "ultrasearch/1.x (+https://github.com/maxgfr/ultrasearch)";

// Transient statuses worth one retry; a single throttled call would otherwise
// silently zero out a whole high-signal backend (Stack Overflow, GitHub, S2).
const RETRY_STATUS = new Set([429, 503, 502, 504]);

// Retry policy is tunable via env (keyless, no new CLI surface): attempts and
// the fixed backoff. Clamped to sane bounds, read once at module load.
function envInt(name: string, def: number, min: number, max: number): number {
  const v = Number(process.env[name]);
  return Number.isFinite(v) ? Math.min(max, Math.max(min, Math.floor(v))) : def;
}
const MAX_ATTEMPTS = envInt("ULTRASEARCH_MAX_ATTEMPTS", 2, 1, 5);
const DEFAULT_RETRY_MS = envInt("ULTRASEARCH_RETRY_MS", 600, 0, 5000);
// Polite pause between successive result-page fetches to the same web engine
// (multi-page pagination). Keyless engines block aggressive scraping, so we
// fetch pages sequentially with a small gap. Tunable; 0 disables.
export const PAGE_DELAY_MS = envInt("ULTRASEARCH_PAGE_DELAY_MS", 350, 0, 5000);

export interface HttpResult {
  ok: boolean;
  status: number;
  body: string;
  contentType: string;
  url: string; // final URL after redirects (for post-redirect exclude re-check)
  bytes?: Buffer; // raw body, only when opts.binary (for PDF extraction)
  error?: string;
}

export function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

// How long to wait before a retry: honor Retry-After (seconds) clamped to 5s,
// else a small fixed backoff.
function retryDelayMs(retryAfter: string | null): number {
  if (retryAfter) {
    const secs = Number(retryAfter);
    if (Number.isFinite(secs)) return Math.min(Math.max(secs * 1000, 0), 5000);
  }
  return DEFAULT_RETRY_MS;
}

// Minimal HTTP GET on Node's built-in fetch (Node ≥18) — no dependencies.
// Times out, sends a UA, caps the body, never throws (errors come back as
// { ok:false }), and retries ONCE on a transient status or network error.
export async function httpGet(
  url: string,
  opts: { timeoutMs?: number; accept?: string; acceptLanguage?: string; maxBytes?: number; userAgent?: string; binary?: boolean } = {},
): Promise<HttpResult> {
  let last: HttpResult = { ok: false, status: 0, body: "", contentType: "", url };
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), opts.timeoutMs ?? 20_000);
    try {
      const headers: Record<string, string> = { "user-agent": opts.userAgent ?? BROWSER_UA, accept: opts.accept ?? "*/*" };
      if (opts.acceptLanguage) headers["accept-language"] = opts.acceptLanguage;
      const res = await fetch(url, {
        signal: ctrl.signal,
        redirect: "follow",
        headers,
      });
      const buf = Buffer.from(await res.arrayBuffer());
      const max = opts.maxBytes ?? 4 * 1024 * 1024;
      const capped = buf.subarray(0, max);
      const result: HttpResult = {
        ok: res.ok,
        status: res.status,
        body: opts.binary ? "" : capped.toString("utf8"),
        bytes: opts.binary ? capped : undefined,
        contentType: res.headers.get("content-type") ?? "",
        url: res.url || url,
      };
      if (RETRY_STATUS.has(res.status) && attempt < MAX_ATTEMPTS - 1) {
        last = result;
        await sleep(retryDelayMs(res.headers.get("retry-after")));
        continue;
      }
      return result;
    } catch (e) {
      last = { ok: false, status: 0, body: "", contentType: "", url, error: (e as Error).message };
      if (attempt < MAX_ATTEMPTS - 1) await sleep(DEFAULT_RETRY_MS);
    } finally {
      clearTimeout(t);
    }
  }
  return last;
}

// JSON request helper for the keyless search APIs. Returns parsed JSON or an
// error; never throws; retries once on a transient status / network error.
export async function httpJson(
  method: string,
  url: string,
  body?: unknown,
  opts: { timeoutMs?: number; accept?: string; acceptLanguage?: string; userAgent?: string } = {},
): Promise<{ ok: boolean; status: number; data: any; error?: string }> {
  let last: { ok: boolean; status: number; data: any; error?: string } = { ok: false, status: 0, data: undefined };
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), opts.timeoutMs ?? 20_000);
    try {
      const headers: Record<string, string> = {
        "content-type": "application/json",
        accept: opts.accept ?? "application/json",
        "user-agent": opts.userAgent ?? BROWSER_UA,
      };
      if (opts.acceptLanguage) headers["accept-language"] = opts.acceptLanguage;
      const res = await fetch(url, {
        method,
        signal: ctrl.signal,
        headers,
        body: body === undefined ? undefined : JSON.stringify(body),
      });
      const text = await res.text();
      let data: any;
      try {
        data = text ? JSON.parse(text) : undefined;
      } catch {
        data = text;
      }
      const result = { ok: res.ok, status: res.status, data };
      if (RETRY_STATUS.has(res.status) && attempt < MAX_ATTEMPTS - 1) {
        last = result;
        await sleep(retryDelayMs(res.headers.get("retry-after")));
        continue;
      }
      return result;
    } catch (e) {
      last = { ok: false, status: 0, data: undefined, error: (e as Error).message };
      if (attempt < MAX_ATTEMPTS - 1) await sleep(DEFAULT_RETRY_MS);
    } finally {
      clearTimeout(t);
    }
  }
  return last;
}

const ENTITIES: Record<string, string> = {
  "&amp;": "&",
  "&lt;": "<",
  "&gt;": ">",
  "&quot;": '"',
  "&#39;": "'",
  "&apos;": "'",
  "&nbsp;": " ",
  "&mdash;": "—",
  "&ndash;": "–",
  "&hellip;": "…",
  "&copy;": "©",
};

// Decode the common named entities plus decimal/hex numeric references.
export function decodeEntities(s: string): string {
  let out = s.replace(/&#x([0-9a-fA-F]+);/g, (_m, h) => {
    try {
      return String.fromCodePoint(parseInt(h, 16));
    } catch {
      return " ";
    }
  });
  out = out.replace(/&#(\d+);/g, (_m, n) => {
    try {
      return String.fromCodePoint(Number(n));
    } catch {
      return " ";
    }
  });
  for (const [k, v] of Object.entries(ENTITIES)) out = out.split(k).join(v);
  return out;
}

// Clean a backend-provided inline field (a title or one-line snippet) that may
// carry escaped or literal markup: decode entities FIRST (so escaped tags like
// `&lt;i&gt;` become real tags), THEN strip the tags, then collapse whitespace.
// Decode-then-strip handles both `R&amp;D` → `R&D` and `&lt;i&gt;P53&lt;/i&gt;`
// → `P53` (and literal `<i>P53</i>` → `P53`).
export function cleanInline(s: string): string {
  return decodeEntities(String(s))
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

// Extract readable text from an HTML page. Zero-dep and intentionally simple:
// drop script/style/head/nav/footer, turn block tags into newlines, keep
// heading structure as markdown markers, decode common entities, collapse
// whitespace. Good enough to ground a report in a page's prose without a DOM.
export function htmlToText(html: string): string {
  let s = html;
  s = s.replace(/<!--[\s\S]*?-->/g, " ");
  s = s.replace(/<(script|style|noscript|head|nav|footer|svg|template)[\s\S]*?<\/\1>/gi, " ");
  s = s.replace(/<h([1-6])(?:\s[^>]*)?>/gi, (_m, n) => "\n" + "#".repeat(Number(n)) + " ");
  s = s.replace(/<\/(p|div|section|article|li|tr|h[1-6]|pre|blockquote|br)>/gi, "\n");
  s = s.replace(/<(br|hr)\s*\/?>/gi, "\n");
  s = s.replace(/<[^>]+>/g, " ");
  s = decodeEntities(s);
  s = s.replace(/[ \t]+/g, " ").replace(/\n{3,}/g, "\n\n");
  return s
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l.length > 0)
    .join("\n");
}

// Best-effort page title from an HTML document.
export function htmlTitle(html: string): string | undefined {
  const m = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(html);
  if (!m) return undefined;
  const t = decodeEntities(m[1]!.replace(/\s+/g, " ").trim());
  return t || undefined;
}

// Readability-lite: isolate the main content region of an HTML page so the
// blunt htmlToText strip isn't diluted by nav/sidebar/footer boilerplate.
// Dependency-free and CONSERVATIVE — when it can't confidently find a main
// region (or that region looks too small versus the whole page) it returns the
// input unchanged, so we never extract LESS than the previous behaviour. The
// strongest matching tier wins: <main>/<article> first, then common content
// containers. (Regex can't track nested tags; the size gate below catches a
// container truncated at its first nested close tag and falls back.)
export function extractMainHtml(html: string): string {
  const visible = (h: string) =>
    h
      .replace(/<[^>]+>/g, " ")
      .replace(/\s+/g, " ")
      .trim().length;
  const tiers: RegExp[] = [
    /<main\b[^>]*>([\s\S]*?)<\/main>/gi,
    /<article\b[^>]*>([\s\S]*?)<\/article>/gi,
    /<(?:div|section)\b[^>]*\b(?:id|class)="[^"]*\b(?:content|article|post|entry|story|markdown-body|main|prose)\b[^"]*"[^>]*>([\s\S]*?)<\/(?:div|section)>/gi,
  ];
  const candidates: string[] = [];
  for (const re of tiers) {
    let m: RegExpExecArray | null;
    while ((m = re.exec(html))) candidates.push(m[1]!);
    if (candidates.length) break; // use the strongest tier that matched
  }
  if (!candidates.length) return html;
  let best = candidates[0]!;
  let bestLen = visible(best);
  for (const c of candidates.slice(1)) {
    const len = visible(c);
    if (len > bestLen) {
      best = c;
      bestLen = len;
    }
  }
  // Size gate: a tiny region (short absolutely AND a small share of the page) is
  // probably a truncated/wrong match — fall back to the full document.
  const fullLen = visible(html);
  if (bestLen < 500 && bestLen < fullLen * 0.3) return html;
  return best;
}

const PDF_URL_RE = /\.pdf($|[?#])/i;
const PDF_FETCH_OPTS = { accept: "application/pdf,*/*", binary: true, maxBytes: 16 * 1024 * 1024 } as const;

// Fetch a URL and return its readable text + a title. HTML is narrowed to its
// main content then stripped to prose; PDFs are run through a best-effort
// text-layer extractor. Returns a `note` instead of throwing when the page
// can't be fetched or a PDF yields no text.
export async function fetchAndExtract(
  url: string,
  opts: { acceptLanguage?: string } = {},
): Promise<{ text: string; title?: string; note?: string; finalUrl: string }> {
  const wantsPdf = PDF_URL_RE.test(url);
  const res = await httpGet(url, wantsPdf ? PDF_FETCH_OPTS : { accept: "text/html,text/plain,*/*", acceptLanguage: opts.acceptLanguage });
  if (!res.ok) {
    const why = res.status === 429 ? "rate-limited (HTTP 429)" : `status ${res.status}${res.error ? ", " + res.error : ""}`;
    return { text: "", finalUrl: res.url, note: `Could not fetch ${url} (${why}).` };
  }
  if (wantsPdf || /application\/pdf/i.test(res.contentType)) {
    // A content-type-only PDF (no .pdf in the URL) was fetched as text — refetch
    // the raw bytes so the extractor sees an intact binary.
    const bytes = res.bytes ?? (await httpGet(url, PDF_FETCH_OPTS)).bytes;
    const text = bytes ? pdfToText(bytes) : "";
    return {
      text,
      finalUrl: res.url,
      note: text ? undefined : `Fetched ${url} but could not extract text (scanned/encrypted PDF?).`,
    };
  }
  const isHtml = /html/i.test(res.contentType) || /^\s*</.test(res.body);
  const text = isHtml ? htmlToText(extractMainHtml(res.body)) : res.body;
  const title = isHtml ? htmlTitle(res.body) : undefined;
  return { text, title, finalUrl: res.url };
}

// The markdown heading a line sits under, ignoring fenced code blocks.
export function nearestHeading(lines: string[], anchor: number): string | undefined {
  let heading: string | undefined;
  let inFence = false;
  for (let i = 0; i <= anchor && i < lines.length; i++) {
    const line = lines[i]!;
    if (/^\s*(```|~~~)/.test(line)) {
      inFence = !inFence;
      continue;
    }
    if (inFence) continue;
    const m = line.match(/^#{1,6}\s+(.+?)\s*#*\s*$/);
    if (m) heading = m[1]!.trim();
  }
  return heading;
}

// Query-focused, multi-sentence snippet (the lead shown in sources.json /
// DOSSIER.md). Splits the page text into sentences, scores each by how many of
// the question's keywords it covers, and stitches together the top few (in
// document order) under their nearest heading — so the agent reads the most
// on-point passage rather than a single best line. Falls back to the opening
// sentences when nothing matches.
export function focusedSnippet(text: string, question: string, opts: { maxChars?: number; maxSentences?: number } = {}): string {
  const maxChars = opts.maxChars ?? 360;
  const maxSentences = opts.maxSentences ?? 3;
  const lines = text.split("\n");
  const matcher = buildMatcher(question);
  const sentences: { text: string; line: number; score: number }[] = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    if (/^#{1,6}\s/.test(line)) continue; // headings handled separately
    for (const raw of line.split(/(?<=[.!?])\s+/)) {
      const t = raw.trim();
      if (t.length < 20) continue; // skip nav crumbs / fragments
      sentences.push({ text: t, line: i, score: matcher.matchLine(t).size });
    }
  }
  if (!sentences.length) return lines.slice(0, 4).join(" ").slice(0, maxChars).trim();
  const hits = sentences.filter((s) => s.score > 0);
  const chosen = (hits.length ? hits : sentences)
    .map((s, idx) => ({ s, idx }))
    .sort((a, b) => b.s.score - a.s.score || a.idx - b.idx)
    .slice(0, maxSentences)
    .sort((a, b) => a.idx - b.idx)
    .map((x) => x.s);
  const heading = nearestHeading(lines, chosen[0]!.line);
  let out = chosen.map((s) => s.text).join(" ");
  if (heading && !out.startsWith(heading)) out = `${heading} — ${out}`;
  return out.slice(0, maxChars).trim();
}

// Back-compat alias — a short query-focused excerpt. Kept so existing callers
// (gather hydration, dossier digest, generic backend) are unchanged.
export function bestExcerpt(text: string, question: string, maxChars = 360): string {
  return focusedSnippet(text, question, { maxChars, maxSentences: 2 });
}

// Cap an extract's length according to depth, so standard runs stay readable
// and deep runs keep everything. Always keeps whole lines.
export function capExtract(text: string, depth: "summary" | "standard" | "deep"): string {
  const cap = depth === "deep" ? Infinity : depth === "standard" ? 8000 : 4000;
  if (text.length <= cap) return text;
  const slice = text.slice(0, cap);
  const lastNl = slice.lastIndexOf("\n");
  return (lastNl > cap * 0.6 ? slice.slice(0, lastNl) : slice) + "\n\n… [truncated]";
}
