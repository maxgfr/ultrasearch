import { httpGet, sleep } from "./fetch.js";
import { envInt } from "../engine.js";

// Rate-limit handling for the scholarly APIs (PubMed, Europe PMC, Crossref,
// OpenAlex, Semantic Scholar, ClinicalTrials.gov).
//
// The engine's own retry is built for page reads: two attempts, and a
// Retry-After above 5 s means "give up now". That is right for a page in a
// 60-URL hydration pool and wrong for the one API call a backend makes per
// run — Semantic Scholar answers an anonymous burst with a 429 and a
// Retry-After of a few seconds, and losing the whole backend to it (as a
// clinical run did) costs far more than waiting. So these calls go through
// here instead, with the engine's retry turned off underneath:
//   • at most 3 attempts;
//   • a Retry-After of up to 30 s is honoured as given; a longer one is not
//     waited out — the backend reports itself rate-limited and the run goes on;
//   • without Retry-After, exponential back-off from ULTRASEARCH_BACKOFF_MS
//     (default 1000 ms: 1 s, then 2 s);
//   • a passing failure — a 502 or 504 from a gateway, a connection reset — is
//     tried once more after the first back-off. Turning the engine's retry off
//     had made a single 502 from Crossref or OpenAlex lose the backend for the
//     variant. Not a timeout (the whole budget is spent, and a host silent that
//     long rarely answers a second time — the engine's own rule), and not a
//     failure no retry can change: an unknown host, a bad certificate, an
//     invalid URL.

/** What the back-off loop needs to know about one attempt. */
export interface BackoffAttempt {
  status: number;
  /** Parsed Retry-After, in ms, when the server sent one. */
  retryAfterMs?: number;
  /** Engine's own rate-limit verdict (a 429, or a 403 with x-ratelimit-remaining: 0). */
  rateLimited?: boolean;
  /** The engine's description of a failure with no answer (status 0). */
  error?: string;
}

export interface BackoffOptions {
  /** Total attempts, first one included (default 3). */
  attempts?: number;
  /** First exponential delay in ms (default ULTRASEARCH_BACKOFF_MS, else 1000). */
  baseMs?: number;
  /** Longest Retry-After honoured, in ms (default ULTRASEARCH_BACKOFF_CAP_MS, else 30000). */
  capMs?: number;
  /** Injected for tests. */
  sleepFn?: (ms: number) => Promise<void>;
}

export interface BackoffOutcome<T> {
  result: T;
  /** Attempts actually made. */
  attempts: number;
  /** Total time spent waiting between attempts. */
  waitedMs: number;
  /** The last attempt was still rate-limited. */
  rateLimited: boolean;
  /** Set when a Retry-After above the cap ended the loop early. */
  gaveUpOnRetryAfterMs?: number;
}

/** A status worth waiting out: throttled (429), or temporarily unavailable (503). */
export function isThrottled(a: BackoffAttempt): boolean {
  return a.status === 429 || a.status === 503 || a.rateLimited === true;
}

// No answer, and asking again will not change that.
const FINAL_ERROR =
  /timed out|cancelled|ENOTFOUND|EAI_AGAIN|ERR_INVALID_URL|CERT|SELF_SIGNED|UNABLE_TO_(?:VERIFY|GET)|redirect count exceeded|scheme must be|unknown scheme|bad port|invalid url|failed to parse url/i;

/** A failure worth one more try: a gateway's 502/504, or a connection that dropped. */
export function isTransient(a: BackoffAttempt): boolean {
  if (a.status === 502 || a.status === 504) return true;
  return a.status === 0 && !!a.error && !FINAL_ERROR.test(a.error);
}

/** Run `call` until it is not throttled, waiting politely in between. */
export async function withBackoff<T extends BackoffAttempt>(call: () => Promise<T>, opts: BackoffOptions = {}): Promise<BackoffOutcome<T>> {
  const attempts = Math.max(1, Math.floor(opts.attempts ?? 3));
  const baseMs = opts.baseMs ?? envInt("BACKOFF_MS", 1000, 0, 60_000);
  const capMs = opts.capMs ?? envInt("BACKOFF_CAP_MS", 30_000, 0, 300_000);
  const pause = opts.sleepFn ?? sleep;
  let waitedMs = 0;
  let transientRetried = false;
  for (let i = 1; ; i++) {
    const result = await call();
    if (!isThrottled(result)) {
      // One more try for a passing failure, never more: it is not a throttle,
      // and a gateway that fails twice is down for this run.
      if (!isTransient(result) || transientRetried || i >= attempts) return { result, attempts: i, waitedMs, rateLimited: false };
      transientRetried = true;
      if (baseMs > 0) await pause(baseMs);
      waitedMs += baseMs;
      continue;
    }
    if (i >= attempts) return { result, attempts: i, waitedMs, rateLimited: true };
    const asked = result.retryAfterMs;
    if (asked !== undefined && asked > capMs) {
      return { result, attempts: i, waitedMs, rateLimited: true, gaveUpOnRetryAfterMs: asked };
    }
    const wait = asked ?? baseMs * 2 ** (i - 1);
    if (wait > 0) await pause(wait);
    waitedMs += wait;
  }
}

// Hosts that publish a request-rate ceiling, and the gap kept between two calls
// to each. NCBI allows 3 requests/s without an API key and answers a burst with
// 429s: a `gather` hydrating 18 PubMed hits six at a time used to lose a third
// of them that way — and a lost efetch fell back to the PubMed page, which is a
// cookie wall. Back-off cures a 429 after the fact; pacing keeps it from
// happening. ULTRASEARCH_NCBI_INTERVAL_MS overrides the gap (0 turns it off).
const HOST_GAP_MS: Record<string, () => number> = {
  "eutils.ncbi.nlm.nih.gov": () => envInt("NCBI_INTERVAL_MS", 350, 0, 10_000),
};
// The earliest moment each paced host may be called again. Reserved
// synchronously, before any await, so concurrent callers queue instead of racing.
const nextSlot = new Map<string, number>();

/** Wait until `url`'s host may be called again (immediate for an unpaced host). */
export async function paceHost(url: string, pause: (ms: number) => Promise<void> = sleep): Promise<void> {
  let host: string;
  try {
    host = new URL(url).hostname.toLowerCase();
  } catch {
    return;
  }
  const gap = HOST_GAP_MS[host]?.() ?? 0;
  if (gap <= 0) return;
  const now = Date.now();
  const slot = Math.max(now, nextSlot.get(host) ?? 0);
  nextSlot.set(host, slot + gap);
  if (slot > now) await pause(slot - now);
}

/** One JSON GET as the scholarly backends see it. */
export interface ApiJson {
  ok: boolean;
  status: number;
  data: any;
  /** The run was throttled to the end — the honest label for the backend's note. */
  rateLimited: boolean;
  attempts: number;
  error?: string;
}

/**
 * GET a JSON (or text) API endpoint under `withBackoff`. Uses the engine's
 * `httpGet` rather than `httpJson` because only the former hands back the
 * Retry-After it saw; the engine's retry is switched off (`retries: 0`) so the
 * two loops never stack.
 */
export async function apiGet(
  url: string,
  opts: { timeoutMs?: number; userAgent?: string; accept?: string; json?: boolean } & BackoffOptions = {},
): Promise<ApiJson> {
  const accept = opts.accept ?? "application/json";
  const out = await withBackoff(async () => {
    await paceHost(url);
    return httpGet(url, { accept, retries: 0, timeoutMs: opts.timeoutMs ?? 12000, ...(opts.userAgent ? { userAgent: opts.userAgent } : {}) });
  }, opts);
  const r = out.result;
  let data: any = r.body;
  if (opts.json !== false && r.body) {
    try {
      data = JSON.parse(r.body);
    } catch {
      data = r.body;
    }
  }
  return { ok: r.ok, status: r.status, data, rateLimited: out.rateLimited, attempts: out.attempts, ...(r.error ? { error: r.error } : {}) };
}

/**
 * The backend note for a failed or empty call: rate-limited reads as such,
 * never as "failed" — and an answer that came back fine but empty says so,
 * instead of "failed or empty (status 200)".
 */
export function apiFailure(label: string, r: Pick<ApiJson, "status" | "rateLimited" | "attempts">, query?: string): string {
  if (r.rateLimited || r.status === 429 || r.status === 503) {
    return `${label} rate-limited (HTTP ${r.status}${r.attempts > 1 ? ` after ${r.attempts} attempts` : ""}).`;
  }
  if (r.status >= 200 && r.status < 300) return `${label} returned nothing${query ? ` for "${query}"` : ""}.`;
  return `${label} failed (status ${r.status || "no response"}).`;
}
