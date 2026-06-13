import { buildMatcher } from "../util.js";

const UA = "ultrasearch/0.x (+https://github.com/maxgfr/ultrasearch)";

export interface HttpResult {
  ok: boolean;
  status: number;
  body: string;
  contentType: string;
  error?: string;
}

// Minimal HTTP GET on Node's built-in fetch (Node ≥18) — no dependencies.
// Times out, sends a UA, caps the body so a huge page can't blow up memory,
// and never throws (errors come back as { ok:false }).
export async function httpGet(
  url: string,
  opts: { timeoutMs?: number; accept?: string; maxBytes?: number } = {},
): Promise<HttpResult> {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), opts.timeoutMs ?? 20_000);
  try {
    const res = await fetch(url, {
      signal: ctrl.signal,
      redirect: "follow",
      headers: { "user-agent": UA, accept: opts.accept ?? "*/*" },
    });
    const buf = Buffer.from(await res.arrayBuffer());
    const max = opts.maxBytes ?? 4 * 1024 * 1024;
    return {
      ok: res.ok,
      status: res.status,
      body: buf.subarray(0, max).toString("utf8"),
      contentType: res.headers.get("content-type") ?? "",
    };
  } catch (e) {
    return { ok: false, status: 0, body: "", contentType: "", error: (e as Error).message };
  } finally {
    clearTimeout(t);
  }
}

// JSON request helper for the keyless search APIs. Returns parsed JSON or an
// error; never throws.
export async function httpJson(
  method: string,
  url: string,
  body?: unknown,
  opts: { timeoutMs?: number; accept?: string } = {},
): Promise<{ ok: boolean; status: number; data: any; error?: string }> {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), opts.timeoutMs ?? 20_000);
  try {
    const res = await fetch(url, {
      method,
      signal: ctrl.signal,
      headers: {
        "content-type": "application/json",
        accept: opts.accept ?? "application/json",
        "user-agent": UA,
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await res.text();
    let data: any;
    try {
      data = text ? JSON.parse(text) : undefined;
    } catch {
      data = text;
    }
    return { ok: res.ok, status: res.status, data };
  } catch (e) {
    return { ok: false, status: 0, data: undefined, error: (e as Error).message };
  } finally {
    clearTimeout(t);
  }
}

const ENTITIES: Record<string, string> = {
  "&amp;": "&", "&lt;": "<", "&gt;": ">", "&quot;": '"', "&#39;": "'", "&apos;": "'",
  "&nbsp;": " ", "&mdash;": "—", "&ndash;": "–", "&hellip;": "…", "&copy;": "©",
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

// Fetch a URL and return its readable text (HTML stripped to prose) + a title.
// Returns a `note` instead of throwing when the page can't be fetched.
export async function fetchAndExtract(
  url: string,
): Promise<{ text: string; title?: string; note?: string }> {
  const res = await httpGet(url, { accept: "text/html,text/plain,*/*" });
  if (!res.ok) {
    return { text: "", note: `Could not fetch ${url} (status ${res.status}${res.error ? ", " + res.error : ""}).` };
  }
  const isHtml = /html/i.test(res.contentType) || /^\s*</.test(res.body);
  const text = isHtml ? htmlToText(res.body) : res.body;
  const title = isHtml ? htmlTitle(res.body) : undefined;
  return { text, title };
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

// Pick the most question-relevant window of a page's text as a short snippet
// (the lead shown in sources.json / DOSSIER.md). Scores lines by keyword
// coverage and returns the best-scoring window, prefixed with its heading.
// Falls back to the document's opening lines when nothing matches.
export function bestExcerpt(text: string, question: string, maxChars = 360): string {
  const lines = text.split("\n");
  const matcher = buildMatcher(question);
  let bestIdx = -1;
  let bestCov = 0;
  for (let i = 0; i < lines.length; i++) {
    const cov = matcher.matchLine(lines[i]!).size;
    if (cov > bestCov) {
      bestCov = cov;
      bestIdx = i;
    }
  }
  if (bestIdx < 0) {
    return lines.slice(0, 4).join(" ").slice(0, maxChars).trim();
  }
  const start = Math.max(0, bestIdx - 1);
  const window = lines.slice(start, start + 6).join(" ").slice(0, maxChars).trim();
  const heading = nearestHeading(lines, bestIdx);
  return heading && !window.startsWith(heading) ? `${heading} — ${window}` : window;
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
