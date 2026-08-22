import { Readable, Writable } from 'node:stream';
import { Server } from 'node:http';

declare const ENGINE_VERSION = "1.18.3";

interface Brand {
    /** Human-readable engine consumer, used in notes and diagnostics. */
    name: string;
    /** Uppercase prefix for environment variables, without the trailing underscore. */
    envPrefix: string;
    /** The command users type, used when a note tells them what to run. */
    cli: string;
    /**
     * The consumer's own release version, for the polite User-Agent.
     *
     * Without it every consumer identifies as `<name>/1.x`, which is the one
     * thing that header exists to avoid being: a maintainer looking at their logs
     * to decide whether to throttle a client cannot tell one release from another,
     * and cannot tell a fixed version from the one that was hammering them.
     */
    version?: string;
    /** Root for on-disk caches. Defaults to `<tmpdir>/<name>` when unset. */
    cacheDir?: string;
    /**
     * Root for cloned working trees. Defaults to `<tmpdir>/<name>/repos`.
     *
     * Exists because a consumer that already had its own clone cache cannot adopt
     * `ensureClone` without it: the engine would key clones somewhere else, which
     * orphans every checkout the tool has already made and splits one cache in
     * two. Declaring the directory it already uses makes adoption free.
     */
    repoDir?: string;
    /**
     * How long a cached page stays fresh. Defaults to 24h.
     *
     * A per-consumer decision, not a universal one: a research tool that re-runs
     * the same question all day wants a week, a search tool wants a day. It was
     * the reason one consumer kept its own cache rather than adopt this one.
     */
    cacheTtlMs?: number;
    /**
     * Which User-Agent unlabelled requests carry.
     *
     * `browser` (the default, and the historical behaviour) sends a realistic
     * desktop UA, because several keyless endpoints serve 403 or empty to obvious
     * bots. `contact` sends the polite identifying one instead and falls back to
     * the browser UA exactly once, on a 403/429 — the "identify honestly, disguise
     * only when refused" policy one consumer chose deliberately and would have
     * lost by adopting this layer.
     */
    defaultUa?: "browser" | "contact";
    /**
     * Called once per response body read: bytes, and whether the cache served it.
     *
     * The observability seam. Without it a consumer that instruments retrieval —
     * attributing bytes to the concurrent angle that issued the request — has to
     * keep its own `httpGet` to keep counting, which is the whole duplication this
     * engine exists to remove. Never throws into the caller: a failing counter must
     * not fail a fetch.
     */
    onFetch?: (bytes: number, cached: boolean) => void;
    /**
     * Where a rate-limited API maintainer can find out who is calling.
     *
     * Goes into the polite User-Agent that arXiv, Crossref, OpenAlex and friends
     * are sent. That header is a courtesy with teeth — it is how those services
     * attribute traffic and choose to throttle a well-behaved client gently
     * rather than block it — so it has to name the SKILL doing the calling, not
     * the shared engine underneath.
     */
    contactUrl?: string;
    /**
     * Words this consumer wants dropped on top of the engine's list.
     *
     * The shared list is question scaffolding — "what", "is", "the", plus the
     * French equivalents. What counts as noise BEYOND that is domain knowledge the
     * engine cannot have: a documentation tool reading source repositories sees
     * "test" and "request" in almost every file, so keeping them as keywords
     * scores every document alike. A market-research tool would say the opposite.
     *
     * This exists so adopting the shared matcher is not an all-or-nothing choice.
     * Without it a consumer with two extra words has to keep its own copy of the
     * whole keyword machinery — which is exactly the duplication being removed.
     */
    extraStopwords?: string[];
}
/**
 * Declare the consuming skill's identity. Call once, as early as possible in
 * the CLI entry point and in the MCP server bootstrap — both are process
 * entry points, and a run that starts through either must see the same brand.
 */
declare function configure(next: Brand): void;
/** The active brand. Consumers read `.cli` to name commands inside notes. */
declare function brand(): Readonly<Brand>;
/** Restore the default identity. Test-only; production code configures once. */
declare function resetBrand(): void;
/** Full variable name for a suffix, e.g. `env` name for "SEARXNG". */
declare function envName(suffix: string): string;
/**
 * Read `${envPrefix}_${suffix}`, trimmed. Returns undefined for unset OR
 * empty-after-trim, so `FOO=` and `FOO="  "` behave like unset rather than
 * like the empty string — an exported-but-blank variable is a user mistake,
 * not a request for empty configuration.
 */
declare function env(suffix: string): string | undefined;
/**
 * Presence-as-truth, matching the `if (process.env.X_NO_NPX)` shape the
 * extracted code already used. Any non-empty value except the explicit
 * negatives turns the flag on, so `NO_NPX=1`, `NO_NPX=true` and `NO_NPX=yes`
 * all work — but `NO_NPX=0` and `NO_NPX=false` read as off, because a user who
 * writes that plainly means off and the old presence-only test got it wrong.
 */
declare function envFlag(suffix: string): boolean;
/**
 * Read a numeric tunable, clamped into [min, max]. A missing, non-numeric or
 * negative-where-forbidden value falls back to `def` silently — these are
 * performance knobs, and a typo in one must never abort a run.
 *
 * Replaces three separate copies of this helper that had drifted apart (one
 * clamped, one did not, one rejected zero).
 */
declare function envInt(suffix: string, def: number, min?: number, max?: number): number;

declare function pdfToText(buf: Buffer): string;

interface PdfVerdict {
    ok: boolean;
    /** Short, human-readable cause when `ok` is false. */
    reason?: string;
}
/**
 * Judge extracted PDF text. Returns `{ ok: true }` when the text is safe to
 * cite, else a short reason the caller can put in a dossier note.
 */
declare function assessPdfText(text: string): PdfVerdict;
/**
 * Judge extracted text. Returns `{ ok: true }` when the text is safe to cite,
 * else a short reason the caller can put in a dossier note. `emptyReason` names
 * what an empty extraction means for the format at hand — a PDF with no text
 * layer was probably scanned, an empty .docx conversion means something else.
 *
 * Deliberately independent of length: the failure this guards against produces
 * HUNDREDS of kilobytes, which is exactly what a length-gated check misses.
 */
declare function assessExtractedText(text: string, emptyReason: string): PdfVerdict;

/** Test seam: forget the per-process OCR budget. */
declare function resetOcrBudget(): void;
/** Documents this process may still OCR. */
declare function ocrBudgetLeft(): number;
/**
 * Is OCR possible on this machine?
 *
 * Both binaries must resolve: `copyable-pdf` itself, and the `tesseract` it
 * shells out to. Checking tesseract separately is what keeps us out of the
 * install prompt described above — and it makes `doctor` able to say WHICH part
 * is missing, which "OCR unavailable" alone could not.
 */
declare function ocrTools(): Promise<{
    copyablePdf: boolean;
    tesseract: boolean;
}>;
/**
 * OCR a scanned PDF to text, or return undefined when it cannot be done.
 *
 * Undefined (rather than an empty string) means "this rung is unavailable or
 * failed" — the ladder's signal to try the next one and, for a non-firecrawl
 * rung, to stop asking for the rest of the process.
 */
declare function ocrPdf(bytes: Buffer): Promise<string | undefined>;

type PdfExtractorId = "pdf-inspector" | "anydoc" | "firecrawl" | "pdftotext" | "native" | "ocr";
declare const PDF_EXTRACTORS: PdfExtractorId[];
interface PdfExtraction {
    text: string;
    /** Which rung produced `text`. Absent when every rung failed. */
    via?: PdfExtractorId;
    /** Why the result is empty, when it is — suitable for a dossier note. */
    reason?: string;
}
interface PdfLadderOptions {
    /**
     * Fetch this PDF's text through an already-running Firecrawl, or undefined
     * when there is none. Injected by the caller so this module stays free of the
     * Firecrawl client (and so tests can drive the rung without a container).
     */
    firecrawl?: () => Promise<string | undefined>;
    /** Restrict/reorder the ladder. Defaults to PDF_EXTRACTORS. */
    engines?: PdfExtractorId[];
}
/** Test seam: forget which rungs were found unavailable, and refill the OCR budget. */
declare function resetPdfLadderCache(): void;
/**
 * The rungs to try, honouring `<PREFIX>_PDF_ENGINE` (force exactly one) and
 * `<PREFIX>_NO_NPX` (skip the rung that needs an implicit install), where
 * `<PREFIX>` is whatever the consuming skill declared via `configure()`.
 *
 * An explicit `engines` list wins over both: it is the most specific instruction
 * available, and it is how callers and tests drive the ladder deterministically
 * without fighting whatever the environment happens to say.
 */
declare function enabledExtractors(engines?: PdfExtractorId[]): PdfExtractorId[];
/**
 * Extract text from PDF bytes, trying each enabled rung in order and returning
 * the first result that `assessPdfText` accepts.
 *
 * Never throws. When every rung fails, returns empty text plus the LAST
 * rejection reason, so the caller can say why the source is unusable instead of
 * silently citing nothing.
 */
declare function extractPdf(bytes: Buffer, opts?: PdfLadderOptions): Promise<PdfExtraction>;

interface DocFormat {
    /** Passed as `--format` only when byte detection cannot work. */
    format?: string;
    /**
     * Is this format readable as plain text when no converter is available?
     *
     * False for every binary format: refusing is the whole point, because the
     * alternative is citing a decoded ZIP. True for CSV, which was already served
     * as usable text before this ladder existed — refusing it would be a
     * regression, not a fix.
     */
    textFallback: boolean;
}
/** Every extension this module routes, for docs and tests. */
declare const DOC_EXTENSIONS: readonly string[];
/**
 * Is this URL an office document, judged before the fetch?
 *
 * Extension-only, and deliberately so. The PDF sniffer also has to recognise
 * extension-less routes because `arxiv.org/pdf/<id>` is the single most common
 * PDF a run fetches; office documents have no such convention — a route that
 * serves one without saying so in the path is caught after the fetch, by
 * `docFormatForContentType`.
 *
 * Returns the table entry (never a URL-derived string) or undefined.
 */
declare function docFormatForUrl(url: string): DocFormat | undefined;
/** Is this response an office document, judged from its content-type? */
declare function docFormatForContentType(contentType: string): DocFormat | undefined;

type DocExtractorId = "anydoc" | "firecrawl";
declare const DOC_EXTRACTORS: DocExtractorId[];
interface DocExtraction {
    text: string;
    /** Which rung produced `text`. Absent when every rung failed. */
    via?: DocExtractorId;
    /** Why the result is empty, when it is — suitable for a dossier note. */
    reason?: string;
}
interface DocLadderOptions {
    /**
     * Convert this document through an already-running Firecrawl, or undefined
     * when there is none. Injected by the caller for the same reason the PDF
     * ladder does it: so this module needs no Firecrawl client, and so tests can
     * drive the rung without a container.
     */
    firecrawl?: () => Promise<string | undefined>;
    /** Restrict/reorder the ladder. Defaults to DOC_EXTRACTORS. */
    engines?: DocExtractorId[];
}
/** Test seam: forget which rungs were found unavailable. */
declare function resetDocLadderCache(): void;
/**
 * The rungs to try, honouring `<PREFIX>_DOC_ENGINE` (force exactly one, or
 * `none` to disable the ladder) and `<PREFIX>_NO_NPX` (skip the rung that
 * needs an implicit install), where `<PREFIX>` is whatever the consuming skill
 * declared via `configure()`.
 *
 * An explicit `engines` list wins over both, exactly as in the PDF ladder: it is
 * the most specific instruction available, and it is how callers and tests drive
 * the ladder deterministically without fighting the environment.
 */
declare function enabledDocExtractors(engines?: DocExtractorId[]): DocExtractorId[];
/**
 * Convert an office document to Markdown, trying each enabled rung in order and
 * returning the first result that the quality gate accepts.
 *
 * Never throws. When every rung fails, returns empty text plus the reason, so
 * the caller can say why the source is unusable instead of silently citing
 * nothing — or, worse, citing the raw bytes.
 */
declare function extractDocument(bytes: Buffer, fmt: DocFormat, opts?: DocLadderOptions): Promise<DocExtraction>;

declare const PDF_INSPECTOR_SPEC = "@firecrawl/pdf-inspector@1";
declare const ANYDOC_SPEC = "@firecrawl/anydoc@0.1";
interface RunResult {
    ok: boolean;
    stdout: string;
    /** Short cause when `ok` is false: "not installed", "timed out", "exit 2"… */
    error?: string;
}
/**
 * Spawn `cmd args…`, write `input` to its stdin, resolve with its stdout.
 * Never throws and never leaves a child behind: a missing binary, a non-zero
 * exit and a timeout all come back as `{ ok: false, error }`.
 */
declare function runWithInput(cmd: string, args: string[], input: Buffer, timeoutMs: number): Promise<RunResult>;

/**
 * A realistic desktop-browser User-Agent. Several keyless web endpoints (DDG,
 * Mojeek) serve 403 or empty to obvious bot UAs, so scrapers default to this.
 * Override with `<PREFIX>_UA`.
 */
declare function browserUa(): string;
/**
 * The polite, identifying User-Agent for well-behaved JSON/XML APIs (arXiv,
 * Crossref, OpenAlex, Europe PMC). Naming ourselves is what lets them
 * attribute and throttle us courteously instead of blocking outright — so it
 * names the consuming tool, not the shared engine underneath.
 */
declare function contactUa(): string;
/**
 * The User-Agent an unlabelled request carries, per the brand's declared policy.
 *
 * Two defensible policies, and the choice belongs to the consuming tool rather
 * than to this layer. `browser` (the default) optimises for getting the page:
 * several keyless endpoints serve 403 or empty to anything that admits to being
 * a script. `contact` optimises for being a good citizen — it names the tool and
 * where to complain about it — and pays for that with the occasional refusal,
 * which `fetchAndExtract` answers by retrying once as a browser.
 */
declare function defaultUa(): string;
/**
 * Polite pause between successive result-page fetches to the same web engine
 * (multi-page pagination). Keyless engines block aggressive scraping, so pages
 * are fetched sequentially with a small gap. Tunable; 0 disables.
 */
declare function pageDelayMs(): number;
/**
 * Polite pause between a rate-limited scholarly API's per-variant calls
 * (Crossref/OpenAlex/arXiv/Europe PMC), which the registry serialises rather
 * than firing concurrently to avoid tripping their anonymous quotas. Tunable;
 * 0 disables (tests set it to 0 to stay fast).
 */
declare function politeDelayMs(): number;
interface HttpResult {
    ok: boolean;
    status: number;
    body: string;
    contentType: string;
    url: string;
    bytes?: Buffer;
    error?: string;
    /** Cache validators, kept so a stale entry can be revalidated for free. */
    etag?: string;
    lastModified?: string;
    /** True on an explicit 429, or a 403 that carries an exhausted quota header. */
    rateLimited?: boolean;
    /** Retry-After, parsed and capped, when the server sent one. */
    retryAfterMs?: number;
}
declare function sleep(ms: number): Promise<void>;
/**
 * A rate-limit signal: an explicit 429, or a 403 whose remaining-quota header is
 * zero — which is how GitHub's unauthenticated APIs report throttling. Worth
 * separating from a plain 403, because one is "come back later" and the other is
 * "you may never read this", and a caller that retries the second burns the
 * quota it is waiting on.
 */
declare function detectRateLimited(status: number, headers: Headers): boolean;
/**
 * Parse `Retry-After` — delta-seconds or an HTTP-date — into a millisecond
 * delay, clamped to `capMs`. Returns undefined when the header is absent or
 * unparseable, so a caller can tell "no hint" from "wait zero".
 */
declare function parseRetryAfter(headers: Headers, capMs?: number): number | undefined;
/**
 * Read a Response body, keeping at most `max` bytes and cancelling the transfer
 * the moment the cap is crossed.
 *
 * This exists because `await res.arrayBuffer()` then `.subarray(0, max)` — what
 * this module used to do — caps the VALUE and not the DOWNLOAD: a 2 GB response
 * was fully allocated before being trimmed to 4 MB. A cap that only applies
 * after the bytes are already in memory is not a cap.
 *
 * Falls back to a one-shot read where no readable stream is exposed.
 */
declare function readCapped(res: Response, max: number): Promise<string>;
/** Same streaming cap as `readCapped`, returning the raw bytes. */
declare function readCappedBytes(res: Response, max: number): Promise<Buffer>;
declare function httpGet(url: string, opts?: {
    timeoutMs?: number;
    accept?: string;
    acceptLanguage?: string;
    maxBytes?: number;
    userAgent?: string;
    binary?: boolean;
    /** Extra request headers, lower-cased. The escape hatch for conditional GET
     *  (`if-none-match`, `if-modified-since`) and for an API that wants auth. */
    headers?: Record<string, string>;
    /** Extra attempts on a transient failure, overriding `<PREFIX>_MAX_ATTEMPTS`.
     *  Per-call because the right number is per-endpoint: a probe wants 0, a
     *  paper download off a flaky mirror wants 2. */
    retries?: number;
}): Promise<HttpResult>;
declare function httpJson(method: string, url: string, body?: unknown, opts?: {
    timeoutMs?: number;
    accept?: string;
    acceptLanguage?: string;
    userAgent?: string;
    headers?: Record<string, string>;
    retries?: number;
}): Promise<{
    ok: boolean;
    status: number;
    data: any;
    error?: string;
}>;
/**
 * Decode the common named entities plus decimal/hex numeric references, in ONE
 * non-rescanning pass.
 *
 * The pass count is the whole design. Decoding numeric refs and then walking the
 * named table with split/join re-reads its own output, so `&amp;lt;` — which is
 * how a document writes the literal text "&lt;" — becomes "&lt;" and then "<".
 * The page said one thing and the extract says another, which for a page
 * documenting markup is most of its content. One pass cannot do that: each
 * reference is replaced exactly once, from the original text.
 *
 * Names are matched case-SENSITIVELY, because case is meaningful here: `&dagger;`
 * is † and `&Dagger;` is ‡. An unknown name is left exactly as written rather
 * than guessed at or blanked.
 */
declare function decodeEntities(s: string): string;
declare function cleanInline(s: string): string;
declare function htmlToText(html: string): string;
declare function htmlTitle(html: string): string | undefined;
declare function htmlCanonicalUrl(html: string): string | undefined;
declare function extractMainHtml(html: string): string;
declare const PDF_URL_RE: RegExp;
/**
 * Is this URL a PDF, judged before the fetch?
 *
 * It decides two things that both matter: whether to request BYTES (an
 * extension-less PDF fetched as text costs a second round-trip once the
 * content-type gives it away), and whether the documented extractor ladder
 * runs in its documented order. `fetchAndExtract` hands a non-PDF to Firecrawl
 * FIRST, so a misjudged PDF silently skips `pdf-inspector` — the ladder's
 * preferred rung — whenever a Firecrawl container happens to be up.
 */
declare function looksLikePdfUrl(url: string): boolean;
type ExtractorId = "native" | "firecrawl" | "pdf-inspector" | "pdftotext" | "anydoc" | "ocr";
interface ExtractResult {
    text: string;
    title?: string;
    note?: string;
    finalUrl: string;
    status: number;
    extractor?: ExtractorId;
    canonical?: string;
    /**
     * The page's own one-line summary (`<meta name=description>`, else
     * `og:description`).
     *
     * Worth carrying because extraction drops `<head>` entirely, so a caller that
     * finds nothing in the body matching its question has no second-best left —
     * and citing a nav bar is worse than citing the summary the page wrote about
     * itself. Only ever set on the HTML path.
     */
    metaDescription?: string;
    /**
     * The raw HTML, only when the caller asked for it with `keepHtml` and only on
     * the built-in HTML path.
     *
     * Opt-in because it doubles what a page costs in memory, and almost every
     * caller wants the text and nothing else. The one that does not is a caller
     * following LINKS — `crawlSite` — and the alternative for it is a second
     * request for bytes this function already had in hand.
     */
    html?: string;
    etag?: string;
    lastModified?: string;
}
declare function fetchAndExtract(url: string, opts?: {
    acceptLanguage?: string;
    firecrawl?: string;
    /** Extra request headers for the built-in path — how the cache sends
     *  `if-none-match` / `if-modified-since`. Firecrawl does its own fetching and
     *  ignores these, which is why a revalidating caller skips it. */
    headers?: Record<string, string>;
    /**
     * Drop consent-banner lines from the extracted text.
     *
     * Opt-in, and applied to the BUILT-IN extractor's HTML only. Never to
     * Firecrawl markdown: main-content extraction has already removed the
     * banner, so all the heuristic could still do there is damage — on a page
     * documenting HTTP cookies it would eat the article.
     */
    stripConsent?: boolean;
    /**
     * Carry the raw HTML up in `html`. For a caller that follows links out of
     * the page it just read; see ExtractResult.html for why it is opt-in.
     */
    keepHtml?: boolean;
}): Promise<ExtractResult>;
declare const DEAD_LINK_STATUS: Set<number>;
declare function rescueViaWayback(url: string, opts?: {
    acceptLanguage?: string;
    firecrawl?: string;
}): Promise<{
    text: string;
    title?: string;
    snapshotUrl: string;
    timestamp: string;
} | undefined>;
declare function looksLikeJunkExtraction(text: string): string | undefined;
/**
 * Drop consent-banner lines from extracted text, and say how many went.
 *
 * Deliberately conservative: a line goes only on two distinct pattern hits, or
 * on one hit when the line is short enough to be a button ("Accept all
 * cookies"). Prose that mentions cookies once inside a real sentence stays —
 * this must never quietly delete the paragraph someone wanted to cite.
 */
declare function stripConsentBoilerplate(text: string): {
    text: string;
    dropped: number;
};
/**
 * The page's `<meta name=description>`, falling back to `og:description`.
 *
 * Read from raw HTML because htmlToText drops `<head>` entirely. Worth having as
 * a last-resort summary for a page whose body has nothing matching the question
 * — better than citing a nav bar.
 */
declare function metaDescriptionOf(html: string): string | undefined;
declare function focusedSnippet(text: string, question: string, opts?: {
    maxChars?: number;
    maxSentences?: number;
}): string;
declare function bestExcerpt(text: string, question: string, maxChars?: number): string;
declare function capExtract(text: string, depth: "summary" | "standard" | "deep"): string;

declare const FIRECRAWL_DEFAULT_BASE = "http://localhost:3002";
interface FirecrawlOptions {
    /** `--firecrawl <url>`; "off" disables Firecrawl entirely. */
    firecrawl?: string;
}
/**
 * Resolve the configured Firecrawl base: an explicit `--firecrawl` wins, else
 * `<PREFIX>_FIRECRAWL`, else the localhost default. The literal value `off`
 * (either source) disables Firecrawl entirely and returns null.
 */
declare function firecrawlBase(opts?: FirecrawlOptions): string | null;
/** True when the base came from the user (flag or env) rather than the default. */
declare function firecrawlIsExplicit(opts?: FirecrawlOptions): boolean;
/**
 * Test seam: forget which bases were probed.
 *
 * The memoisation is per-process and deliberately sticky — the whole cost of an
 * absent Firecrawl is meant to be one refused connection. That is right in
 * production and wrong across test cases, where one case's "down" verdict would
 * silently decide the next case's behaviour. Mirrors resetOcrBudget,
 * resetPdfLadderCache and resetDocLadderCache.
 */
declare function resetFirecrawlProbeCache(): void;
/**
 * Record that `base` stopped answering, so the rest of this run skips it.
 *
 * The probe runs once and is then trusted for the process — which is right for
 * "it was never there" and wrong for "the container died at page 4 of 40". A
 * caller that sees a request abort with no status knows something the memoised
 * verdict does not, and without this every remaining page pays the timeout again.
 * Both probe modes are marked down: the instance is gone whether or not the user
 * named it.
 */
declare function markFirecrawlDown(base: string): void;
/**
 * Decide whether the thing that answered `GET {base}/` is actually Firecrawl.
 *
 * "Something is listening" is NOT the same question, and conflating them is a
 * real trap: 3002 is a common dev port, so a Next.js/Vite app squatting it
 * answers 200 and every page extraction then POSTs to an app that 404s — each
 * one paying a wasted round-trip before falling back, while `doctor` cheerfully
 * reports "firecrawl answering". A false positive here is worse than a false
 * negative, because it is invisible.
 *
 * The rule: an HTML page with no Firecrawl marker is somebody else's app.
 * Anything else (its JSON root, an empty body, a proxy's 404) is accepted, so
 * the reverse-proxy case the original probe protected still works. Exported for
 * unit tests — this is a decision, not a detail.
 */
declare function looksLikeFirecrawl(contentType: string | null, body: string): boolean;
/**
 * Is a Firecrawl instance answering at `base`? `GET {base}/` with a hard 2s
 * ceiling. The response must also look like Firecrawl (see above) unless the
 * caller named the instance itself — pointing `--firecrawl` somewhere is a
 * statement about what lives there, and it may legitimately sit behind a proxy
 * that masks the root. Connection refused / timeout ⇒ down. Memoised for the
 * process, so the whole cost of an absent Firecrawl is one refused connection.
 * Never throws.
 *
 * Deliberately bypasses `httpGet`: that layer retries once with a backoff,
 * which would turn a 2s ceiling into ~4.6s on a blackholed host. A probe wants
 * a single shot.
 */
declare function probeFirecrawl(base: string, explicit?: boolean): Promise<boolean>;
/** The API prefix in use for `base`: `/v2` until a 404 proves it is `/v1`. */
declare function apiPrefix(base: string): string;
/** A page as Firecrawl returned it: main-content markdown plus provenance. */
interface FirecrawlScrape {
    markdown: string;
    title?: string;
    sourceURL?: string;
    statusCode?: number;
}
/**
 * PURE mapper for a `/scrape` response body → the fields the extractor needs,
 * or null when there is nothing usable: `{success:false}`, a missing/non-object
 * `data`, or empty markdown. Exported so the response contract is unit-tested
 * against a fixture instead of the network.
 */
declare function mapScrapeResponse(json: any): FirecrawlScrape | null;
/** One `web` hit from a `/search` response. */
interface FirecrawlHit {
    url: string;
    title: string;
    description: string;
    markdown?: string;
}
/**
 * PURE mapper for a `/search` response body → the `web` hits. Tolerates the
 * shape drifting to a bare array or to `data.results`, and drops any entry
 * without a usable URL. Never throws.
 */
declare function mapSearchResponse(json: any): FirecrawlHit[];
/** What a scrape attempt tells the caller: the page, or WHY it fell through. */
interface ScrapeAttempt {
    data?: FirecrawlScrape;
    /**
     * A user-visible reason the caller should surface as a note. Only set when
     * Firecrawl was actually REACHED and still produced nothing — an unreachable
     * or disabled instance is silent (see the note-policy comment in fetch.ts).
     */
    why?: string;
}
/**
 * Scrape one URL through Firecrawl, returning the cleaned markdown or the
 * reason it could not. A single `/scrape` call — never `/batch/scrape`, which is
 * an async job + polling protocol not worth the complexity for one page.
 * Returns `{}` (silently) when Firecrawl is disabled or unreachable.
 */
declare function scrapeViaFirecrawl(url: string, opts?: FirecrawlOptions): Promise<ScrapeAttempt>;
/**
 * Query Firecrawl's keyless `/search` (Fire-Engine → SearXNG → DuckDuckGo
 * internally). Returns the `web` hits, or a reason.
 */
declare function searchViaFirecrawl(query: string, limit: number, opts?: FirecrawlOptions): Promise<{
    hits?: FirecrawlHit[];
    why?: string;
}>;

declare function escapeRegExp(s: string): string;
/**
 * Is this term question scaffolding rather than content?
 *
 * Exported because a consumer's own scorer must agree with buildMatcher on what
 * a term IS. A caller's own ranking tokeniser should drop the same words and
 * apply the same folding, so a document ranks against the same vocabulary the
 * excerpt matcher highlights. Two lists that drift apart make the two disagree,
 * and the symptom — a source that scores well but shows an excerpt with no
 * highlight — looks like a bug in neither.
 */
declare function isStopword(term: string): boolean;
declare function keywords(question: string): string[];
declare function rankedKeywords(question: string): string[];
declare function deaccent(s: string): string;
declare function foldTerm(raw: string): string;
declare function subtokens(raw: string): string[];
interface KeywordVariant {
    text: string;
    kind: "original" | "folded" | "subtoken";
}
interface ExpandedKeyword {
    canonical: string;
    original: string;
    variants: KeywordVariant[];
}
declare function expandTokens(tokens: string[], max?: number): ExpandedKeyword[];
declare function accentPattern(text: string): string;
interface KeywordMatcher {
    expanded: ExpandedKeyword[];
    canonicals: string[];
    /**
     * The compiled pattern sources, each with the keyword it attributes to.
     *
     * What makes the matcher usable by something other than this process: a
     * consumer can hand these to ripgrep or any external scanner and still map
     * the hits back to canonicals. Without them the matcher only works line by
     * line in memory, which is the wrong shape for searching a whole repository.
     */
    patterns: {
        source: string;
        canonical: string;
    }[];
    /** Map a matched span — as an external scanner reports it — back to its keyword. */
    canonicalOf(span: string): string | undefined;
    /** Which canonicals does this line of text cover? */
    matchLine(line: string): Set<string>;
}
declare function buildMatcher(question: string, max?: number): KeywordMatcher;
/**
 * A matcher over raw tokens, skipping keyword extraction.
 *
 * The fallback for a question with no distinctive keywords left after stopword
 * removal — "what is it for?" reduces to nothing, and a matcher that matches
 * nothing highlights nothing. Searching the words as given is worse than a good
 * query and much better than an empty one. Still accent-folded and
 * subtoken-expanded, so attribution stays consistent with buildMatcher.
 */
declare function matcherFromTokens(tokens: string[], max?: number): KeywordMatcher;
/**
 * The markdown heading a line sits under, ignoring heading-lookalikes inside
 * fenced code blocks. `anchor` is a 0-based line index.
 *
 * Lives here rather than with the HTTP layer because it is a fact about text:
 * the extractor happens to be what usually produces the markdown, but a caller
 * reading a `.md` off disk has exactly the same question.
 */
declare function nearestHeading(lines: string[], anchor: number): string | undefined;
/** A passage of a document, chosen because it answers the question. */
interface ExcerptWindow {
    /** First line kept, 0-based. */
    start: number;
    /** One past the last line kept. */
    end: number;
    /** The line the window was centred on. */
    anchor: number;
    /**
     * How many DISTINCT question keywords the anchor line covered.
     *
     * Zero is meaningful and is not an error: it is the top-of-page fallback,
     * emitted when nothing in the document matched. A caller that ranks evidence
     * wants to know it is looking at boilerplate rather than at an answer.
     */
    score: number;
    /** The markdown section the anchor sits under, when there is one. */
    heading?: string;
    snippet: string;
}
/**
 * Find the passages of `text` that answer `question`.
 *
 * This is the half of "turn a page into excerpts" that is the same everywhere:
 * score each line against the question, take the best ones, widen each into a
 * readable window, and stop windows from overlapping. What an excerpt then IS —
 * a citation, an evidence item, a snippet with a section title — is the caller's
 * model and stays with the caller.
 *
 * Three decisions, each taken from whichever copy had it right:
 *
 * - Scoring goes through `buildMatcher`, so accents, plurals and camelCase
 *   subtokens all match. A raw `line.includes(keyword)` misses "Générateur" for
 *   "generateur" and "parseQuery" for "query".
 * - `question` may be a LIST, and a line scores by its best single-question
 *   coverage rather than by the union. A page then gets excerpted around the one
 *   claim it actually supports instead of around a diluted average of all of them.
 * - Windows are de-duplicated by RANGE OVERLAP, not by bucketing line numbers.
 *   Fixed buckets let two near-identical excerpts straddle a boundary and both
 *   survive, which is how the same paragraph ends up quoted twice.
 */
declare function excerptWindows(text: string, question: string | string[], opts?: {
    perDoc?: number;
    before?: number;
    after?: number;
    maxChars?: number;
}): ExcerptWindow[];
/**
 * Turn an arbitrary identifier into a filesystem-safe slug —
 * `github.com/expressjs/express` → `github.com-expressjs-express`.
 *
 * Used as an on-disk cache key, which is why the normalisation matters: a
 * repository named as `https://github.com/x/y.git`, `git@github.com:x/y.git`
 * and `github.com/x/y` is ONE repository, and three slugs would mean three
 * clones of it.
 *
 * `max` is a parameter because the two uses want different lengths — a repo
 * identity is short and a research question is not — and truncating a question
 * at a repo's length collides distinct runs.
 */
declare function slugify(input: string, opts?: {
    max?: number;
    fallback?: string;
}): string;

declare function canonicalizeUrl(raw: string): string;
declare function normalizeDoi(doi: string): string;
declare function domainOf(raw: string): string;
/** The `domain` a local file is filed under. Not a host, and deliberately not one. */
declare const LOCAL_FILE_DOMAIN = "local file";
declare function fnv1a64(s: string): bigint;

/**
 * The minimum a candidate must expose to be ranked: where it came from and how
 * good the caller currently thinks it is. `text` is optional because only the
 * content-similarity passes need it.
 */
interface Ranked {
    url: string;
    score: number;
    text?: string;
}
/**
 * Reciprocal Rank Fusion: merge several ranked lists into one ranking without
 * comparable cross-list scores.
 *
 * The problem it solves is that a keyless web engine's "score" and a scholarly
 * API's "relevance" are not the same quantity and cannot be added. RRF only
 * reads POSITION, so it needs no calibration: an item's contribution from each
 * list is `1/(k + rank)`, and `k` damps the tail so rank 40 cannot outvote a
 * couple of top-tens.
 */
declare function rrf<T>(lists: T[][], keyOf: (item: T) => string, k?: number): Map<string, number>;
/**
 * The arXiv id inside a URL, so `abs/`, `pdf/` and `html/` variants of the SAME
 * paper collapse to one identity even when the backend supplied no metadata.
 * Handles modern (2405.12345) and legacy (math.GT/0309136) ids, any arxiv.org
 * subdomain, and strips a version suffix and a trailing `.pdf`.
 */
declare function arxivIdFromUrl(url: string): string | undefined;
/**
 * The DOI inside a URL — a doi.org resolver link, or a publisher landing page
 * that carries the DOI in its path (`dl.acm.org/doi/…`, `/doi/full/…`). Returned
 * normalised, so a DOI-in-path collapses with a bare one.
 */
declare function doiFromUrl(url: string): string | undefined;
/**
 * Drop duplicates by canonical URL, keeping the best-scored copy. Survivors keep
 * their input order, so a caller that already ranked its list does not have to
 * re-sort after de-duplicating.
 */
declare function dedupeByUrl<T extends Ranked>(items: readonly T[]): {
    items: T[];
    dropped: number;
};
interface Bm25Doc {
    id: string;
    title: string;
    headings: string;
    body: string;
}
interface Bm25Index {
    idf: Map<string, number>;
    avgdl: number;
    N: number;
    queryTerms: string[];
    k1: number;
    b: number;
    titleWeight: number;
    headingWeight: number;
}
/**
 * Tokenise into canonical terms WITH repetition, so term frequency survives.
 *
 * Shares `foldTerm` and `isStopword` with `buildMatcher`, which is the point:
 * two scorers that disagree about whether "requests" and "request" are the same
 * term will disagree about relevance for reasons nobody can debug.
 */
declare function bm25Tokenize(text: string): string[];
/**
 * Build the index over the candidate pool — the pool IS the corpus, so IDF is
 * relative to what was actually retrieved.
 *
 * Below three documents IDF is too noisy to mean anything, so it degrades to
 * uniform (pure TF). A three-result pool where one term happens to be missing
 * from two of them would otherwise assign that term a huge weight on no evidence.
 */
declare function buildBm25Index(question: string, docs: readonly Bm25Doc[], opts?: {
    k1?: number;
    b?: number;
}): Bm25Index;
/** BM25F score of one document against the index (raw, ≥0). */
declare function bm25Score(index: Bm25Index, doc: Bm25Doc): number;
/** Which distinct query terms actually occur in a document. */
declare function bm25MatchedTerms(index: Bm25Index, doc: Bm25Doc): string[];
/**
 * Drop candidates that share no meaningful term with the query.
 *
 * Two off-topic shapes: an EMPTY overlap, and an overlap that is only numeric —
 * a page whose sole connection to the question is that a PR number happens to
 * contain the same digits as a year. Only active when the query has at least two
 * terms and at least one alphabetic one, since a one-word query carries too
 * little signal to filter on.
 *
 * NEVER drops below `floor`. A genuinely thin pool has to survive its own filter,
 * so the best-ranked "off-topic" candidates are re-admitted until the floor is
 * met. `ranked` must be best-first.
 */
declare function applyRelevanceFloor<T>(ranked: readonly T[], matchedOf: (t: T) => string[], queryTerms: string[], floor: number): {
    kept: T[];
    dropped: T[];
};
/**
 * What fraction of the question's distinctive keywords appear in a text. Cheaper
 * and blunter than BM25 — useful for snippet selection, where "does this line
 * mention the thing at all" is the whole question.
 */
declare function contentCoverage(matcher: KeywordMatcher, text: string): number;
/**
 * Pool-relative recency in 0..1, neutral 0.5 when the item has no year or the
 * pool has no spread.
 *
 * Relative to the RESULT SET rather than wall-clock on purpose: a score computed
 * against "now" changes every day, which would make two runs over identical
 * inputs rank differently and make any golden test rot on a calendar.
 */
declare function recencyScore(meta: {
    year?: number;
} | undefined, minYear: number, maxYear: number): number;
/**
 * 64-bit SimHash over 3-gram shingles. Near-duplicate documents land a few bits
 * apart; unrelated ones sit around 32.
 */
declare function simhash(text: string): bigint;
/** How many bits two SimHashes differ by. */
declare function hammingDistance(a: bigint, b: bigint): number;
/**
 * Collapse near-duplicate items by SimHash over their text, keeping the
 * best-scored copy. Items shorter than `minChars` carry too little signal and
 * are never collapsed. Expects best-first input and preserves that order.
 */
declare function dedupeNearDuplicates<T extends Ranked>(items: readonly T[], opts?: {
    maxBits?: number;
    minChars?: number;
}): {
    items: T[];
    dropped: number;
};
/**
 * Re-order a ranked list so the top of it says several DIFFERENT things.
 *
 * The failure this fixes is not redundancy in the near-duplicate sense: eight
 * independent pages can each restate the same argument in their own words, be
 * correctly on-topic, and collectively bury the one source that says something
 * else. Relevance ranking has no defence against that, because each one really
 * is relevant.
 *
 * Greedy Maximal Marginal Relevance: at each rank pick the candidate maximising
 * `λ·relevance − (1−λ)·(similarity to what is already ranked)`. Similarity is
 * Jaccard over BM25 tokens — no new extraction, no model, deterministic.
 *
 * It REORDERS ONLY. Every input comes back exactly once: this changes what you
 * read first, never what you have. λ = 0.75 keeps relevance dominant, so
 * diversity breaks ties and demotes redundancy rather than promoting noise.
 */
declare function diversify<T extends Ranked>(items: readonly T[], tokensOf: (it: T) => Set<string>, lambda?: number): T[];
/**
 * The hosts a text links out to, excluding its own domain and `www.` noise.
 *
 * A page that cites nothing external is not automatically bad, but it is a fact
 * worth surfacing next to a claim — so this reports the set and lets the caller
 * decide what it means.
 */
declare function externalHosts(url: string, text: string): Set<string>;

declare function isApiEndpoint(url: string): boolean;
/**
 * How many documents a URL addresses, when it says so in its query string.
 * 0 means "it doesn't say" — the normal case for an ordinary page.
 */
declare function addressedIdCount(url: string): number;
/** A url fit to appear in a report: parseable, http(s), and not an API endpoint. */
declare function isCitableUrl(url: string): boolean;
/**
 * Does the URL ITSELF carry a persistent identifier?
 *
 * `deriveCitableUrl` reads identifiers out of a document's text, which misses
 * the commonest case in scholarly work: the address IS the identifier
 * (`arxiv.org/pdf/2408.05636`, `doi.org/10.1145/…`). A PDF makes that worse —
 * extraction drops hyperlinks, so the text can carry none at all. Measured: two
 * arXiv papers were flagged "thin attribution" purely because nothing looked at
 * their own URL.
 *
 * Identifier SYNTAX only (DOI, arXiv id). No hostnames.
 */
declare function urlDeclaresIdentity(url: string): boolean;
/**
 * Derive a citable URL from what a fetch returned, for the case where the URL we
 * fetched is not itself citable. Reads the document's own identifiers, in
 * descending order of authority:
 *
 *   1. the canonical link the page declares (`<link rel=canonical>` / `og:url`),
 *   2. a DOI — the identifier publishers agree on,
 *   3. an arXiv id, 4. a PMID.
 *
 * Returns undefined when the payload names no document, which is the honest
 * answer: the caller then refuses or asks the agent for the page.
 */
declare function deriveCitableUrl(text: string, canonical?: string): string | undefined;

interface ResolvedProvider {
    citeUrl: string;
    textUrl?: string;
    reject?: string;
    preferText?: true;
}
declare function pubmedAbstractUrl(pmid: string): string;
declare function resolveProvider(url: string): ResolvedProvider;

declare function baseLang(lang: string | undefined): string;
declare function resolveRegion(lang: string | undefined, region?: string): string;
declare function ddgRegion(lang: string | undefined, region?: string): string;
declare function acceptLanguageHeader(lang: string | undefined, region?: string): string;

interface ShResult {
    ok: boolean;
    status: number;
    stdout: string;
    stderr: string;
    /** The executable itself was not found — not a failure OF the command. */
    missing?: boolean;
}
declare function have(cmd: string): boolean;
/** Test seam: forget which executables were found. */
declare function resetHaveCache(): void;
/** Run a command synchronously. Never throws — a missing binary is a result. */
declare function sh(cmd: string, args: string[], opts?: {
    cwd?: string;
    input?: string;
    timeoutMs?: number;
    env?: NodeJS.ProcessEnv;
}): ShResult;
/**
 * Run a command without blocking the event loop.
 *
 * Preferred wherever several commands could overlap — a synchronous `git clone`
 * freezes everything else in the process for the whole transfer, which is the
 * difference between three clones taking as long as the slowest and taking as
 * long as all of them put together. SIGKILL on timeout, and never an orphan.
 */
declare function shAsync(cmd: string, args: string[], opts?: {
    cwd?: string;
    timeoutMs?: number;
    env?: NodeJS.ProcessEnv;
}): Promise<ShResult>;

interface RepoRef {
    /** Exactly what the caller passed. */
    raw: string;
    /** `github.com`, `local` for a directory, `generic` for unrecognisable text. */
    host: string;
    /** Owner, keeping GitLab subgroups intact ("group/subgroup"). */
    owner?: string;
    repo?: string;
    cloneUrl?: string;
    webUrl?: string;
    isLocal: boolean;
    /** Stable, filesystem-safe identity — the on-disk cache key. */
    slug: string;
}
/**
 * Where clones live: `<PREFIX>_REPO_DIR`, then the brand's declared `repoDir`,
 * then `<tmpdir>/<name>/repos`.
 *
 * The brand tier is what lets a consumer that already had a clone cache adopt
 * this module at all. Without it, adopting moves every checkout: the clones the
 * tool made yesterday are orphaned under the old path and re-fetched under the
 * new one, and the cache commands still reading the old path report an empty
 * cache that is not empty.
 */
declare function repoCacheRoot(): string;
/**
 * Parse any repository identifier into a `RepoRef`. Accepts a local directory,
 * `https://host/owner/repo(.git)`, `ssh://`/`git://` URLs, `git@host:owner/repo`,
 * `host/owner/repo`, and the bare `owner/repo` shorthand (which means GitHub).
 *
 * An unrecognisable seed becomes a `generic` ref with NO synthesised clone URL.
 * That matters: minting `https://github.com/<free text>.git` would turn "some
 * words the user typed" into a plausible-looking URL that 404s later, far from
 * where the mistake was made.
 */
declare function resolveRepo(raw: string): RepoRef;
/**
 * A working tree for `ref`, cloned if needed, returned as an absolute path.
 *
 * Shallow and blobless by default (`--depth 1 --filter=blob:none`): reading a
 * repository's current state does not need its history or every past version of
 * every file, and on a large project that is the difference between seconds and
 * minutes. `ensureHistoryDepth` deepens it when a caller genuinely needs history.
 *
 * Never throws for a reason the caller cannot act on — a missing `git` says so
 * rather than reporting a clone failure.
 */
declare function ensureClone(ref: RepoRef, opts?: {
    refresh?: boolean;
    branch?: string;
}): Promise<string>;
/** Test seam: forget which working trees were deepened. */
declare function resetHistoryDepthCache(): void;
/**
 * Make a clone usable for history-walking commands (`git log -S/-G`, blame).
 *
 * There are TWO things to undo, and missing either one leaves the caller with a
 * repository that answers slowly and wrongly:
 *
 *   --depth 1          no history to walk
 *   --filter=blob:none no blob CONTENT to diff
 *
 * `ensureClone` above sets both. An earlier version of this function only looked
 * for `.git/shallow` and only passed `--unshallow`, which produced the worst
 * case of all: a full commit graph over a blobless object database, where every
 * pickaxe comparison triggers a per-blob promisor fetch over the network. So the
 * filter is cleared and `--refetch` re-pulls the objects in one transfer.
 *
 * Shallowness is read from `git rev-parse --is-shallow-repository` rather than
 * from the presence of `.git/shallow`, which is git's private bookkeeping and not
 * a contract.
 *
 * Returns a note rather than throwing when it cannot: a shallow clone still
 * answers every question about the CURRENT state, so failing the whole call
 * because history is unavailable would refuse the answers that are available.
 */
declare function ensureHistoryDepth(dir: string, opts?: {
    deepen?: number;
}): Promise<{
    ok: boolean;
    note?: string;
}>;
/** The commit a working tree is on, or undefined when it is not a repo. */
declare function headCommit(dir: string): string | undefined;
/** Its `origin` remote, or undefined when it has none. */
declare function originUrl(dir: string): string | undefined;
/**
 * Two commits are the same, tolerating one being absent — and tolerating either
 * being an ABBREVIATION of the other.
 *
 * The abbreviation half is load-bearing, not politeness. A stored artifact
 * records the commit it was built against, and git abbreviates a SHA almost
 * everywhere it prints one, so strict equality answers "different" to a full SHA
 * compared against its own 7-character prefix. Downstream, that means every
 * stored citation silently stops being re-validated against the working tree —
 * a check that reports success while checking nothing.
 */
declare function sameCommit(a: string | undefined, b: string | undefined): boolean;

type ForgeKind = "github" | "gitlab" | "gitea";
interface ForgeItem {
    kind: "issue" | "pr" | "release" | "tag" | "discussion";
    number?: number;
    title: string;
    url: string;
    state?: string;
    labels: string[];
    body: string;
    updatedAt?: string;
    /** Whatever the forge scored it, when it scores at all. */
    score?: number;
}
interface ForgeResult {
    items: ForgeItem[];
    /** Why it came back thin, in words a caller can show. Never an exception. */
    note?: string;
    rateLimited?: boolean;
}
interface ForgeOptions {
    /** Override the API base — a self-hosted GitLab, or GitHub Enterprise. */
    apiBase?: string;
    limit?: number;
    timeoutMs?: number;
}
/** Which forge a host is, by its shape. Unknown hosts get no client. */
declare function forgeKind(host: string): ForgeKind | undefined;
/**
 * The API base for a repo's host.
 *
 * GitHub Enterprise is the awkward one: github.com serves `api.github.com`,
 * while a self-hosted install serves `<host>/api/v3`. Getting this wrong is a
 * 404 that reads like "no such repository".
 *
 * Takes a bare host string as well as a ref, because a provider layer routinely
 * knows the host before it has resolved anything into a `RepoRef` — and having to
 * fabricate one just to ask this question is exactly why a second copy of this
 * function grew downstream.
 */
declare function apiBase(ref: Pick<RepoRef, "host"> | string, opts?: ForgeOptions): string;
/** Auth headers when a token is in the environment; none when it is not. */
declare function forgeAuthHeaders(kind: ForgeKind): Record<string, string>;
/**
 * Map GitHub's issue-search payload into `ForgeItem`s.
 *
 * Exported for the parsing edges it has to survive: labels arriving as strings
 * or as objects, the draft flag standing in for a state, missing fields. A null
 * element is filtered first so one bad entry cannot throw away the whole page.
 */
declare function mapGithubIssues(raw: unknown[], kind: "issue" | "pr"): ForgeItem[];
/** Test seam: forget which repositories were resolved. */
declare function resetCanonicalRepoCache(): void;
/**
 * The repository's canonical owner and repo, following renames.
 *
 * A moved repository (calcom/cal.com → calcom/cal.diy) still answers on its old
 * name through a redirect, but every subsequent SEARCH keyed on the old name
 * fails with a 422 that reads like a malformed query. So this is resolved once
 * and the answer used everywhere after.
 *
 * Prefers the `gh` CLI when it is installed and the host is github.com: it is
 * already authenticated, so it resolves against a quota far above the anonymous
 * one this would otherwise spend. Falls back to the keyless REST call — `gh` is
 * a bonus, never a requirement.
 *
 * Returns the parts rather than a slug because a provider layer builds URLs from
 * them; `canonicalRepo` below joins them for the callers that want the string.
 */
declare function canonicalRepoRef(ref: RepoRef, opts?: ForgeOptions): Promise<{
    owner: string;
    repo: string;
}>;
/** The same answer as `canonicalRepoRef`, as an `owner/repo` slug. */
declare function canonicalRepo(ref: RepoRef, opts?: ForgeOptions): Promise<string | undefined>;
/**
 * Search a repository's issues or pull requests.
 *
 * GitHub gets its search API — the only one of the three that ranks by
 * relevance. GitLab and Gitea have no such endpoint, so they get a scoped list
 * filtered by search terms, which is why their `score` is absent: they are
 * ordered by recency and saying otherwise would be a lie the caller might rank on.
 */
declare function searchIssues(ref: RepoRef, terms: string[], kind: "issue" | "pr", opts?: ForgeOptions): Promise<ForgeResult>;
/** A repository's releases, newest first. */
declare function listReleases(ref: RepoRef, opts?: ForgeOptions): Promise<ForgeResult>;
/** A repository's tags, which exist even where releases do not. */
declare function listTags(ref: RepoRef, opts?: ForgeOptions): Promise<ForgeResult>;
interface RepoFacts {
    fullName?: string;
    description?: string;
    homepage?: string;
    license?: string;
    stars?: number;
    forks?: number;
    openIssues?: number;
    defaultBranch?: string;
    pushedAt?: string;
    archived?: boolean;
    topics: string[];
}
/**
 * The repository's own metadata — stars, licence, homepage, whether it is
 * archived.
 *
 * Worth having for a reason beyond curiosity: "is this project maintained" is
 * otherwise answered by reading a README that says it is. `archived` and
 * `pushedAt` answer it from the record.
 */
declare function repoFacts(ref: RepoRef, opts?: ForgeOptions): Promise<RepoFacts | undefined>;

type RegistryKind = "npm" | "pypi" | "crates";
interface PackageFacts {
    registry: RegistryKind;
    name: string;
    version?: string;
    description?: string;
    homepage?: string;
    /** Normalised to an https URL where the registry gives something git-shaped. */
    repository?: string;
    documentation?: string;
    license?: string;
    /** The registry's own deprecation notice, when there is one. */
    deprecated?: string;
    /** Recent downloads, where the registry publishes them. */
    downloads?: number;
    publishedAt?: string;
}
/**
 * Turn whatever a registry calls a repository into a browsable https URL.
 *
 * They are wildly inconsistent — `git+https://…​.git`, `git://`, `git@host:…`,
 * a bare `owner/repo`, or a plain URL — and a caller that passes any of those
 * to a browser or a clone gets a different failure for each.
 */
declare function normalizeRepoUrl(raw: unknown): string | undefined;
/**
 * Look a package up in one registry.
 *
 * Returns undefined for "no such package", which is different from a failed
 * request — a caller resolving a name across several registries needs to know
 * whether to try the next one or to stop and report a network problem.
 */
declare function lookupPackage(registry: RegistryKind, name: string, version?: string): Promise<PackageFacts | undefined>;
/**
 * Resolve a bare library name across the registries, in the order most likely to
 * be right, and return the first that knows it.
 *
 * Order is deliberate rather than alphabetical: npm has by far the most names,
 * so trying it first resolves most lookups in one request. An explicit
 * `registry` skips the guessing entirely, which a caller who knows the ecosystem
 * should always do.
 */
declare function resolvePackage(name: string, opts?: {
    registry?: RegistryKind;
    version?: string;
}): Promise<PackageFacts | undefined>;

/** The charset named by a Content-Type header, if it names one. */
declare function charsetFromContentType(contentType: string): string | undefined;
/**
 * The charset a document declares about itself: `<meta charset>` or the older
 * `<meta http-equiv="content-type">`.
 *
 * Only the first 4 KB is scanned. The spec requires the declaration inside the
 * first 1024 bytes, and reading further would mean decoding the body to find out
 * how to decode the body.
 */
declare function charsetFromHtml(head: string): string | undefined;
/**
 * Decode response bytes into text, honouring — in order — a BOM, the
 * Content-Type header, and the document's own `<meta charset>`.
 *
 * Precedence follows what actually helps: a BOM cannot be wrong, a header is
 * usually right, and a meta tag is the last resort because a page served as
 * UTF-8 while declaring latin1 in its markup is almost always a stale template
 * rather than a truthful declaration.
 *
 * Falls back to UTF-8 on an unknown or unsupported label, so a nonsense charset
 * degrades to today's behaviour rather than failing the fetch.
 */
declare function decodeBody(bytes: Buffer, contentType?: string): string;

interface RobotsRule {
    allow: boolean;
    path: string;
}
interface Robots {
    /** Rules for the group that best matches our agent, most specific first. */
    rules: RobotsRule[];
    /** `Crawl-delay` for our group, in ms, when one was declared. */
    crawlDelayMs?: number;
    /** Every `Sitemap:` line — they are file-level, not per-group. */
    sitemaps: string[];
    /** True when the file could not be read at all (which means "allowed"). */
    absent: boolean;
}
/**
 * Parse a robots.txt for one user-agent token.
 *
 * Group selection follows the spec's precedence: the most specific matching
 * `User-agent` wins, and `*` is the fallback. A file with no group for us and no
 * `*` group imposes nothing.
 */
declare function parseRobots(body: string, userAgent: string): Robots;
/**
 * Does this robots.txt permit fetching `url`?
 *
 * An absent or unparseable file means yes — that is what the spec says, and it
 * is also the only safe default for a tool that must not turn a network hiccup
 * into "this site is off limits".
 */
declare function isAllowed(robots: Robots, url: string): boolean;
/** Test seam: forget every fetched robots.txt. */
declare function resetRobotsCache(): void;
/**
 * Fetch and parse the robots.txt governing `url`, memoised per origin.
 *
 * Memoised because the alternative is one extra request per page fetched, which
 * is precisely the kind of load robots.txt exists to prevent. Disabled entirely
 * by `<PREFIX>_NO_ROBOTS`, for an operator who knows they are crawling their own
 * site.
 */
declare function fetchRobots(url: string): Promise<Robots>;

interface PageMetadata {
    title?: string;
    description?: string;
    /** `og:type`, or JSON-LD `@type`. */
    type?: string;
    siteName?: string;
    /** ISO-ish date strings, exactly as the page wrote them. */
    publishedAt?: string;
    modifiedAt?: string;
    authors: string[];
    imageUrl?: string;
    canonicalUrl?: string;
    /** Every JSON-LD block that parsed, untouched — for a caller that wants more. */
    jsonLd: unknown[];
}
/**
 * Every `<script type="application/ld+json">` block that parses.
 *
 * A block that does not parse is skipped rather than thrown: malformed JSON-LD
 * is common (trailing commas, templating artefacts, HTML comments wrapped around
 * it) and must never cost the caller the rest of the page.
 */
declare function extractJsonLd(html: string): unknown[];
/** Every `<meta>` name/property and its content, lower-cased keys. */
declare function extractMetaTags(html: string): Map<string, string>;
/**
 * What a page says about itself, merged from JSON-LD and its meta tags.
 *
 * JSON-LD wins on conflict: OpenGraph is written for social-preview cards and is
 * routinely stale or templated, while JSON-LD is what the site feeds search
 * engines and tends to be generated from the real record.
 */
declare function pageMetadata(html: string): PageMetadata;

interface FeedItem {
    title?: string;
    url?: string;
    /** As written by the feed. */
    published?: string;
    summary?: string;
    id?: string;
}
interface Feed {
    title?: string;
    kind: "rss" | "atom";
    items: FeedItem[];
}
/**
 * Parse an RSS 2.0 or Atom feed.
 *
 * Returns an empty item list rather than throwing on anything unrecognised —
 * the caller asked "does this site publish a feed", and "no" is a valid answer
 * that must not look like a crash.
 */
declare function parseFeed(xml: string): Feed | undefined;
/** Feed URLs a page advertises via `<link rel="alternate">`. */
declare function discoverFeeds(html: string, baseUrl: string): string[];
interface Sitemap {
    /** Page URLs, for a urlset. */
    urls: {
        loc: string;
        lastmod?: string;
    }[];
    /** Nested sitemap URLs, for a sitemapindex — fetch these to go deeper. */
    sitemaps: string[];
}
/**
 * Parse a sitemap.xml, whether it is a `urlset` or a `sitemapindex`.
 *
 * The two are reported separately rather than followed automatically: a sitemap
 * index can name hundreds of children, and deciding how much of a site to
 * enumerate is the caller's budget to spend, not this function's.
 */
declare function parseSitemap(xml: string): Sitemap;
/**
 * Fetch and parse the sitemap(s) for an origin.
 *
 * Tries the ones robots.txt names first — a site that publishes its sitemap
 * location there means it — then falls back to `/sitemap.xml`. `max` bounds how
 * many documents are fetched, because a sitemap index is an invitation to
 * enumerate a site and that has to stay a budget the caller sets.
 */
declare function fetchSitemap(url: string, opts?: {
    sitemaps?: string[];
    max?: number;
}): Promise<Sitemap>;
/** Fetch and parse a feed URL. */
declare function fetchFeed(url: string): Promise<Feed | undefined>;

/** A keyless engine this module knows how to query. */
type KeylessEngine = "ddg" | "ddglite" | "mojeek";
declare const KEYLESS_ENGINES: KeylessEngine[];
declare function isKeylessEngine(v: string): v is KeylessEngine;
/**
 * Which keyless engines the cascade may use: an explicit option wins, then
 * `<PREFIX>_ENGINES` (a comma-separated list, or `off`), then all of them.
 *
 * The env switch matters because these are the only rung that reaches the public
 * internet without being asked to. SearXNG and Firecrawl are localhost by
 * default, so "no stack running" already means "no network"; without
 * `<PREFIX>_ENGINES=off` a caller with no stack — a test suite, an air-gapped
 * run, a sandbox — would start scraping duckduckgo.com the moment it called
 * `search()`. Unknown names are ignored rather than throwing: a typo should cost
 * one engine, not the run.
 */
declare function keylessEngines(opts?: {
    engines?: KeylessEngine[];
}): KeylessEngine[];
interface EngineHit {
    url: string;
    title: string;
    snippet: string;
}
interface EngineResult {
    hits: EngineHit[];
    /** Why it returned nothing, in words a caller can show. Never an exception. */
    note?: string;
    /** The engine refused for load reasons — worth trying again later, unlike a 404. */
    throttled?: boolean;
    /**
     * The engine turned the request away as automated traffic.
     *
     * Separate from `throttled` because it answers a different question for the
     * caller. `throttled` says "come back later"; `blocked` says "we learned
     * nothing about the web here" — and a caller that reports zero results
     * WITHOUT knowing this tells its user the web is empty when in fact nobody
     * was asked. Blocked implies throttled: it is worth retrying later too.
     */
    blocked?: boolean;
}
/** Tags out, entities decoded, whitespace collapsed. */
declare function stripTags(s: string): string;
/**
 * The real destination behind a DuckDuckGo redirector link, which rides in the
 * `uddg` query parameter. Without this every DDG result is cited as a
 * duckduckgo.com URL that resolves to the right page but names the wrong source.
 */
declare function ddgRedirectTarget(href: string): string;
/**
 * Why an engine refused, when the refusal is about load rather than the query.
 *
 * "Rate-limited" and "unreachable" are different facts: the first will work
 * again in a few minutes and the second will not, and a caller that reports the
 * wrong one sends its user down the wrong path. Repeated identically across six
 * backends before it lived here.
 */
declare function throttleReason(status: number): {
    throttled: boolean;
    why: string;
};
/**
 * Is this body a challenge page rather than a result page?
 *
 * The hard case, and the reason this cannot be done on status alone: BOTH of
 * these engines serve their challenge with a SUCCESS status. Captured
 * 2026-08-21 — DuckDuckGo answers 202 with an `anomaly-modal` ("Unfortunately,
 * bots use DuckDuckGo too"), Mojeek answers 200 with `<title>Captcha</title>`.
 * `res.ok` is true, the parser finds no result blocks, and without this the
 * engine reports "returned no results" — a refusal wearing the clothes of an
 * empty web.
 *
 * Deliberately narrow, and never the first word. It only fires on a body that is
 * BOTH short — a challenge page carries no results, so it is a fraction of a
 * result page — and carrying one of these engines' own challenge markers. And
 * `searchViaKeyless` only consults it once parsing has produced NOTHING, so a
 * page with results can never be called blocked however its markup reads.
 */
declare function looksLikeChallenge(body: string): boolean;
/** One page of `html.duckduckgo.com/html/`. */
declare function parseDdgHtml(body: string, limit?: number): EngineHit[];
/** One page of `lite.duckduckgo.com/lite/` — a flat table, simpler and steadier. */
declare function parseDdgLite(body: string, limit?: number): EngineHit[];
/** One page of `mojeek.com/search` — direct hrefs, no redirector. */
declare function parseMojeek(body: string, limit?: number): EngineHit[];
/**
 * Ask one keyless engine, walking `pages` result pages.
 *
 * Pagination stops as soon as a page adds no NEW canonical URL. An engine that
 * ignores the offset parameter and re-serves page one would otherwise be walked
 * to the requested depth, paying a request per page for the same ten results.
 */
declare function searchViaKeyless(engine: KeylessEngine, query: string, opts?: {
    limit?: number;
    pages?: number;
    lang?: string;
    region?: string;
    timeoutMs?: number;
}): Promise<EngineResult>;

/** The docker stack publishes SearXNG here. */
declare const SEARXNG_DEFAULT_BASE = "http://localhost:8888";
interface SearchHit {
    url: string;
    title: string;
    snippet: string;
    /** Which engine produced it. */
    via: "searxng" | "firecrawl" | KeylessEngine;
}
interface SearchOptions {
    /** Base URL, or "off" to disable. Defaults to `<PREFIX>_SEARXNG` then localhost. */
    searxng?: string;
    /** Base URL, or "off" to disable. */
    firecrawl?: string;
    /** How many hits to aim for. */
    limit?: number;
    /** BCP-47 language tag, e.g. "fr-FR". */
    lang?: string;
    region?: string;
    /** Result pages to walk. SearXNG paginates with `&pageno=`. */
    pages?: number;
    /**
     * Which keyless engines the cascade may fall back to, in order. Defaults to
     * all of them; `[]` disables the keyless rung entirely, leaving the local
     * stack as the only discovery path.
     */
    engines?: KeylessEngine[];
}
interface SearchResult {
    hits: SearchHit[];
    /** What degraded, in words a caller can show a user. Never an exception. */
    notes: string[];
}
/**
 * Resolve the SearXNG base: an explicit option wins, else `<PREFIX>_SEARXNG`,
 * else the localhost default. The literal `off` from either source disables it.
 */
declare function searxngBase(opts?: SearchOptions): string | null;
/** True when the base came from the caller rather than the default. */
declare function searxngIsExplicit(opts?: SearchOptions): boolean;
/** Test seam: forget memoised probe verdicts. */
declare function resetSearxngProbeCache(): void;
/**
 * Is a SearXNG instance answering at `base`? A single `GET {base}/healthz` with
 * a hard 2s ceiling; ANY HTTP response counts as up, because a 404 from a proxy
 * in front of it still proves something is listening. Memoised per base, so the
 * whole cost of an absent instance is one refused connection per process.
 *
 * Deliberately bypasses httpGet, whose retry-with-backoff would turn a 2s
 * ceiling into roughly 4.6s on a blackholed host. A probe wants a single shot.
 */
declare function probeSearxng(base: string): Promise<boolean>;
/**
 * Query a SearXNG instance's keyless JSON API.
 *
 * Most PUBLIC instances disable `format=json`, which is exactly why the stack
 * ships a local one. Returns candidates — title, snippet, URL — never page
 * text: hydrating a hit is `fetchAndExtract`'s job.
 */
declare function searchViaSearxng(query: string, opts?: SearchOptions): Promise<SearchResult>;
/**
 * Search: the local stack first, then the keyless engines, then Firecrawl.
 *
 * SearXNG leads because it is the cheapest and aggregates many upstreams at
 * once. The keyless engines come next because they need nothing installed at
 * all — an install with no Docker still discovers pages, which is the whole
 * reason they are here. Mojeek is in that group deliberately: it runs its own
 * crawler rather than reselling somebody else's index, so it answers when the
 * DuckDuckGo family has nothing.
 *
 * Firecrawl is last, not first: its own keyless `/search` delegates to SearXNG
 * anyway, so reaching for it early pays for a browser stack to arrive at the
 * same index.
 *
 * Never throws. When nothing answers, the result is empty hits plus notes saying
 * which piece was missing and how to start it — "no results" and "no search
 * engine running" are different facts, and a caller that cannot tell them apart
 * reports the wrong one.
 */
declare function search(query: string, opts?: SearchOptions): Promise<SearchResult>;

declare const COMPOSE_YAML = "# Optional, fully-local, no-API-key stack for a semantic mode, web\n# search and content extraction. Start it with `{{CLI}} semantic up` (or\n# `docker compose --profile all up -d`). The published bundle stays\n# dependency-free \u2014 it only speaks HTTP to these containers on localhost;\n# nothing here is required for Tier-1 retrieval.\n#\n# Profiles let you start subsets:\n#   --profile semantic  \u2192 qdrant + ollama (vector search)\n#   --profile search    \u2192 searxng (web discovery)\n#   --profile all       \u2192 everything above\n#   --profile extract   \u2192 firecrawl (content cleaning; `{{CLI}} firecrawl up`)\n# \u2500\u2500 One stack, however many tools use it \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\n# Any tool needing SearXNG or Firecrawl binds the SAME host ports. Run two from\n# separate compose projects and only one can ever be up: the second fails with\n# \"port is already allocated\", after leaving its sidecars running.\n#\n# So this file uses one fixed project name, one set of container names and one\n# set of volumes. A second tool bringing the stack up is a no-op against the\n# containers already running, and the whole thing costs one machine's worth of\n# RAM rather than one per tool.\n#\n# WARNING: any tool shipping its own copy of these service blocks must keep them\n# byte-identical. Docker compares the RESOLVED config, so a divergence makes an\n# up from one recreate the other's running containers.\n\nname: skills\n\nservices:\n  # Vector database \u2014 Apache-2.0, self-hosted, no key.\n  qdrant:\n    image: qdrant/qdrant:v1.18.2\n    container_name: skills-qdrant\n    ports:\n      - \"6333:6333\"\n    volumes:\n      - qdrant:/qdrant/storage\n    restart: unless-stopped\n    profiles: [\"semantic\", \"all\"]\n    healthcheck:\n      # The image ships no curl/wget \u2014 probe the REST port over bash's /dev/tcp.\n      test: [\"CMD-SHELL\", \"bash -c ':> /dev/tcp/127.0.0.1/6333' || exit 1\"]\n      interval: 30s\n      timeout: 5s\n      retries: 3\n      start_period: 15s\n\n  # Local embedding server \u2014 no key, no data leaves the machine. Pull the model\n  # once: `docker compose exec ollama ollama pull nomic-embed-text`\n  # (`{{CLI}} semantic up` does this for you).\n  ollama:\n    image: ollama/ollama:0.30.7\n    container_name: skills-ollama\n    ports:\n      - \"11434:11434\"\n    volumes:\n      - ollama:/root/.ollama\n    restart: unless-stopped\n    profiles: [\"semantic\", \"all\"]\n    healthcheck:\n      test: [\"CMD\", \"ollama\", \"list\"]\n      interval: 30s\n      timeout: 5s\n      retries: 3\n      start_period: 15s\n\n  # Self-hosted metasearch for keyless web discovery. JSON output is enabled in\n  # docker/searxng/settings.yml so the engine can be queried programmatically.\n  # Also backs Firecrawl's keyless /search through SEARXNG_ENDPOINT.\n  searxng:\n    image: searxng/searxng:2026.6.11-a1490676e\n    container_name: skills-searxng\n    ports:\n      - \"8888:8080\"\n    environment:\n      - SEARXNG_BASE_URL=http://localhost:8888/\n    volumes:\n      - ./docker/searxng:/etc/searxng:rw\n    restart: unless-stopped\n    profiles: [\"search\", \"all\"]\n    healthcheck:\n      # busybox wget is in the image; /healthz answers on the container port.\n      test: [\"CMD-SHELL\", \"wget -qO- http://localhost:8080/healthz || exit 1\"]\n      interval: 30s\n      timeout: 5s\n      retries: 3\n      start_period: 15s\n\n  # Self-hosted Firecrawl \u2014 keyless content cleaning. Fetches a page with a real\n  # browser and returns main-content markdown, which beats the built-in regex\n  # HTML stripper on nav/cookie chrome and is the only way JS-rendered pages\n  # yield any text at all. Keyless because USE_DB_AUTHENTICATION=false; see\n  # docker/firecrawl/firecrawl.env for the tunables.\n  #\n  # Deliberately NOT in the \"all\" profile: it is ~3 GB of images and 5\n  # containers, and `{{CLI}} semantic up` must stay cheap.\n  #\n  #   docker compose --profile search --profile extract up -d --wait\n  firecrawl:\n    image: ghcr.io/firecrawl/firecrawl:2.10.5@sha256:8ce1af201332e1de046d70d5d516fbfe7f0f6229820d271d880873eeca531ea6\n    container_name: skills-firecrawl\n    ports:\n      - \"3002:3002\"\n    env_file:\n      - ./docker/firecrawl/firecrawl.env\n    environment:\n      # Wiring lives here; tunables live in the env file above.\n      - HOST=0.0.0.0\n      - PORT=3002\n      - ENV=local\n      - REDIS_URL=redis://firecrawl-redis:6379\n      - REDIS_RATE_LIMIT_URL=redis://firecrawl-redis:6379\n      - PLAYWRIGHT_MICROSERVICE_URL=http://firecrawl-playwright:3000/scrape\n      - POSTGRES_HOST=firecrawl-postgres\n      - NUQ_RABBITMQ_URL=amqp://firecrawl-rabbitmq:5672\n      # Keeps /search keyless by delegating to the searxng service above.\n      # Unreachable when the `search` profile is down \u2014 Firecrawl then falls\n      # back to DuckDuckGo on its own.\n      - SEARXNG_ENDPOINT=http://searxng:8080\n    command: node dist/src/harness.js --start-docker\n    depends_on:\n      firecrawl-redis:\n        condition: service_started\n      firecrawl-playwright:\n        condition: service_started\n      firecrawl-postgres:\n        condition: service_started\n      firecrawl-rabbitmq:\n        condition: service_healthy\n    restart: unless-stopped\n    profiles: [\"extract\"]\n    # The image ships no curl/wget, but it is a Node image \u2014 probe with node.\n    healthcheck:\n      test: [\"CMD\", \"node\", \"-e\", \"fetch('http://127.0.0.1:3002/').then(r=>process.exit(r.status<500?0:1)).catch(()=>process.exit(1))\"]\n      interval: 15s\n      timeout: 5s\n      retries: 10\n      start_period: 60s\n    # Trimmed for a 16 GB laptop; upstream asks for 4 CPU / 8 GB. Measured at\n    # 2.3 GB steady under 5 concurrent scrapes, so 3 GB was too tight a cap \u2014\n    # MAX_RAM=0.8 in the env file makes Firecrawl self-throttle at ~3.2 GB.\n    cpus: 2.0\n    mem_limit: 4g\n    memswap_limit: 4g\n\n  # Headless-browser sidecar \u2014 this is what makes JS-rendered pages extractable.\n  firecrawl-playwright:\n    image: ghcr.io/firecrawl/playwright-service:latest@sha256:8c50add7293201e575110e6c7489fa383a9dfc46f168936526a458e06ffc5c28\n    container_name: skills-firecrawl-playwright\n    environment:\n      - PORT=3000\n      - BLOCK_MEDIA=true\n      - MAX_CONCURRENT_PAGES=4\n    restart: unless-stopped\n    profiles: [\"extract\"]\n    cpus: 1.5\n    mem_limit: 2g\n    memswap_limit: 2g\n    tmpfs:\n      - /tmp/.cache:noexec,nosuid,size=512m\n\n  firecrawl-redis:\n    image: redis:alpine\n    container_name: skills-firecrawl-redis\n    command: redis-server --bind 0.0.0.0\n    restart: unless-stopped\n    profiles: [\"extract\"]\n\n  firecrawl-rabbitmq:\n    image: rabbitmq:3-management\n    container_name: skills-firecrawl-rabbitmq\n    restart: unless-stopped\n    profiles: [\"extract\"]\n    healthcheck:\n      test: [\"CMD\", \"rabbitmq-diagnostics\", \"-q\", \"check_running\"]\n      interval: 10s\n      timeout: 5s\n      retries: 5\n      start_period: 20s\n\n  firecrawl-postgres:\n    image: ghcr.io/firecrawl/nuq-postgres:latest@sha256:aed86f62858f29bd971abddcdeb301c12888098d2cf5d33c1ba42b053bc460f6\n    container_name: skills-firecrawl-postgres\n    environment:\n      - POSTGRES_USER=postgres\n      - POSTGRES_PASSWORD=postgres\n      - POSTGRES_DB=postgres\n    volumes:\n      - firecrawl_pg:/var/lib/postgresql/data\n    restart: unless-stopped\n    profiles: [\"extract\"]\n\nvolumes:\n  qdrant:\n  ollama:\n  firecrawl_pg:\n";
declare const SEARXNG_SETTINGS_YAML = "# Minimal SearXNG config for keyless, self-hosted web discovery. The important\n# bit is enabling the JSON output format so the CLI can query it\n# programmatically (`/search?format=json`) \u2014 most PUBLIC instances disable it,\n# which is why a local one ships here.\n#\n# The service names and ports below are deliberately stable, so several tools on\n# one machine share a single container rather than each starting their own.\nuse_default_settings: true\n\nserver:\n  # Override with a real random secret if you expose this beyond localhost.\n  secret_key: \"searxng-local-dev-change-me\"\n  # The limiter/bot-detection middleware answers 403 to format=json requests.\n  limiter: false\n  image_proxy: false\n\nsearch:\n  safe_search: 0\n  autocomplete: \"\"\n  formats:\n    - html\n    - json\n";
declare const FIRECRAWL_ENV = "# Tunables for the self-hosted Firecrawl stack (docker compose --profile extract).\n# Wiring (hostnames, ports, SEARXNG_ENDPOINT) lives in docker-compose.yml and\n# overrides anything set here.\n\n# THIS is what makes the API keyless. Turning it on would require a Supabase\n# project; there is no reason to for a localhost stack.\nUSE_DB_AUTHENTICATION=false\n\n# Firecrawl's Rust PDF extractor, which is OFF by default upstream. Without it\n# Firecrawl falls back to pdf-parse (JS) for PDFs. Still keyless: this is the\n# local Rust path, not the MinerU / Fire PDF routes, which need API credentials.\n# Reached as a rung of the PDF ladder when the built-in reader finds no text.\nPDF_RUST_EXTRACT_ENABLE=true\n\n# Postgres credentials for the bundled nuq-postgres container. It is not\n# published on a host port, so these never leave the compose network.\nPOSTGRES_USER=postgres\nPOSTGRES_PASSWORD=postgres\nPOSTGRES_DB=postgres\nPOSTGRES_PORT=5432\n\n# Admin queue dashboard at http://localhost:3002/admin/CHANGEME/queues\nBULL_AUTH_KEY=CHANGEME\n\n# Concurrency, trimmed for a laptop. Upstream defaults are 8/5/5/10 and assume\n# a 4-CPU / 8-GB box; these keep the stack near ~4 GB total.\nNUM_WORKERS_PER_QUEUE=2\nMAX_CONCURRENT_JOBS=3\nBROWSER_POOL_SIZE=2\nCRAWL_CONCURRENT_REQUESTS=4\n\n# Back off before the host runs out of headroom.\nMAX_CPU=0.8\nMAX_RAM=0.8\n\nLOGGING_LEVEL=info\n";
/**
 * The embedded assets with `{{CLI}}` resolved to the consumer's command.
 *
 * The templates name a tool in their comments, and the tool they name is
 * whoever wrote the file out — not this engine. A vendored copy that told the
 * reader to run `webindex semantic up` would be naming a binary they do not
 * have. Substituted at CALL time, per the lazy rule in src/brand.ts.
 */
declare function renderAsset(template: string): string;
declare function ensureComposeMaterialized(): string;
/** What one `docker` invocation produced. Mirrors the shape a caller can act on. */
interface StackRun {
    ok: boolean;
    stdout: string;
    stderr: string;
    /** The binary was not on PATH — a different problem from a non-zero exit. */
    missing?: boolean;
}
/**
 * The two host effects `stackControl` needs, injectable so its orchestration is
 * unit-testable without a Docker daemon. Both default to the real thing.
 */
interface StackDeps {
    run?: (cmd: string, args: string[], opts: {
        timeoutMs: number;
        capture?: boolean;
    }) => StackRun;
    has?: (cmd: string) => boolean;
}
interface StackResult {
    /** Ready to print. Multi-line for `up`, which reports what to do next. */
    message: string;
    code: number;
}
type StackAction = "up" | "down" | "status";
/** The embedding model the `ollama` service is expected to serve. */
declare function embedModel(): string;
/** The services this stack knows how to drive. */
declare const STACK_SERVICES: string[];
/** Which compose profiles each service needs. */
declare const SERVICE_PROFILES: Record<string, string[]>;
/**
 * Run `docker compose` for a service, against the embedded stack.
 *
 * Materialises the compose file first, so this works from any install — a
 * global npm install, a Homebrew cellar, a vendored bundle — and not only from
 * a checkout with docker-compose.yml beside the source. That last assumption is
 * what made the equivalent command fail for everyone who installed the tool
 * rather than cloned it.
 *
 * Never throws. Every failure comes back as a message and a non-zero code,
 * because not having Docker is a normal state for this tool: everything the
 * stack provides is optional and degrades to a note.
 */
declare function stackControl(service: string | string[], action: string, deps?: StackDeps): StackResult;

/**
 * Map `items` through `fn` with at most `limit` in flight, preserving order.
 *
 * A rejecting `fn` rejects the whole call, the same contract as `Promise.all`.
 * A caller that must degrade per item catches inside `fn` — which is what
 * retrieval wants, since one unreachable page should never abandon the rest.
 */
declare function mapLimit<T, R>(items: readonly T[], limit: number, fn: (item: T, index: number) => Promise<R>): Promise<R[]>;

declare function withRunLock<T>(slug: string, fn: () => Promise<T>): Promise<T>;
declare function resetRunLocks(): void;

type Extract = Awaited<ReturnType<typeof fetchAndExtract>>;
interface CacheEntry extends Extract {
    cachedAt: number;
    etag?: string;
    lastModified?: string;
}
declare function cacheDir(): string;
declare function cachePath(url: string, acceptLanguage?: string, extractor?: CacheNamespace): string;
declare const PDF_CACHE_NS: "pdf";
declare const DOC_CACHE_NS: "doc";
type CacheNamespace = ExtractorId | typeof PDF_CACHE_NS | typeof DOC_CACHE_NS;
/** How the cache behaves for this run. Both default to off. */
interface CacheMode {
    /** Ignore any stored entry and re-fetch. The fresh result is still written. */
    refresh: boolean;
    /**
     * Never touch the network. Serve what is on disk however stale, and return an
     * honest note on a genuine miss rather than an empty page — a hole the caller
     * cannot distinguish from "this URL has nothing on it" is worse than a refusal.
     */
    offline: boolean;
}
/** Declare `--refresh` / `--offline` for this process. */
declare function setCacheMode(next: Partial<CacheMode>): void;
/** What the two switches are set to right now. */
declare function cacheMode(): CacheMode;
/** Test seam: back to plain caching. */
declare function resetCacheMode(): void;
/**
 * Is this entry still inside the TTL?
 *
 * Strictly less-than, so a TTL of 0 means what it is documented to mean: always
 * stale, always refetch. With `<=` it instead meant "fresh for the millisecond
 * it was written in", which is indistinguishable from working until two calls
 * land in the same tick — and then the entry is served and the refetch the
 * operator asked for silently does not happen.
 */
declare function isCacheFresh(entry: CacheEntry, now?: number): boolean;
/**
 * Conditional-request headers for a stale entry, so revalidating it costs a
 * request header and a 304 instead of the whole body again.
 *
 * Empty when the entry has no validators — the origin never sent any, so there
 * is nothing to ask about and the caller must re-fetch normally.
 */
declare function revalidationHeaders(entry: Pick<CacheEntry, "etag" | "lastModified">): Record<string, string>;
declare function cachedFetchAndExtract(url: string, opts?: {
    acceptLanguage?: string;
    firecrawl?: string;
    stripConsent?: boolean;
}, enabled?: boolean, now?: number): Promise<Extract & {
    cached?: boolean;
}>;
interface CacheStats {
    dir: string;
    entries: number;
    bytes: number;
    fresh: number;
    stale: number;
    ttlMs: number;
    oldest?: string;
    newest?: string;
}
/**
 * What is on disk right now: how many entries, how much space, how many are
 * still fresh.
 *
 * A cache nobody can inspect is a cache nobody trusts — "is this stale answer
 * coming from disk?" was previously only answerable by deleting the directory
 * and watching whether the run got slower.
 */
declare function cacheStats(now?: number): CacheStats;
/**
 * Drop stale entries, or every entry with `all`. Returns how many went.
 *
 * Nothing else ever removes anything: before this, the only eviction was the TTL
 * deciding not to READ an entry, so a long-lived cache directory grew without
 * bound and kept bodies for pages nobody would look at again.
 */
declare function cacheClean(all?: boolean, now?: number): number;

interface Artifact {
    /** Path the artifact WOULD have been written to. */
    path: string;
    content: string;
}
declare function setNoWrite(on: boolean): void;
declare function isNoWrite(): boolean;
/** mkdirSync -p, or nothing at all under no-write. */
declare function ensureDir(dir: string): void;
/**
 * Write a file, or collect it under no-write. Returns the path either way — so
 * callers keep their existing shape — which means a caller that PRINTS the
 * returned path must check `isNoWrite()` first, or it advertises a file that
 * does not exist. The CLI does exactly that.
 *
 * The write is ATOMIC (see writeFileAtomic). Every artifact this engine and its
 * consumers produce is read back by something — a manifest by the next command,
 * an index by a concurrent MCP tool call, a report by the agent that cited it —
 * and a plain writeFileSync leaves a window where a reader sees a truncated
 * file and `JSON.parse` throws on it. Only one of the eight consuming skills
 * had noticed and written its own atomic helper; making it the default here
 * means none of the other seven has to.
 */
declare function writeArtifact(path: string, content: string): string;
/**
 * Write a file so a concurrent reader sees either the old bytes or the new
 * ones, never a half-written file. `rename` is atomic within a filesystem, and
 * the temp file is a SIBLING so it always is one — a temp in os.tmpdir() would
 * cross a mount point and silently degrade to a copy.
 *
 * Bypasses the no-write gate on purpose: this is the durability primitive, and
 * `writeArtifact` above is the gated caller. A caller holding a path of its own
 * that must not be written under `--stdout` calls `writeArtifact`, not this.
 */
declare function writeFileAtomic(path: string, content: string | Uint8Array): void;
/** Drain the collected artifacts. Empty when writes actually went to disk. */
declare function takeArtifacts(): Artifact[];
/** Test seam: clear both the switch and anything collected under it. */
declare function resetNoWrite(): void;

/**
 * The readable id a default output folder is named after: `run-YYYYMMDD-HHMMSS`.
 *
 * LOCAL time, not UTC, and that is the point: the person reading `ls` is the
 * person who started the run, and a folder stamped three hours off their clock
 * is a folder they cannot find. Sortable lexicographically, which is what makes
 * `ls` order runs chronologically for free.
 *
 * The Date is a parameter so tests can pin it. Callers pass nothing.
 */
declare function runId(d?: Date): string;
/**
 * Shell-single-quote a value for a command line this engine EMITS — the
 * free-text question and every path in an orchestration runbook.
 *
 * Single quotes are the only POSIX shell context with zero expansion: backticks,
 * `$`, `|`, `;`, `&&` and newlines all stay literal inside them. An embedded
 * single quote closes and reopens the quoting (' → '"'"'), which is the one
 * escape the form does not admit directly.
 *
 * Newlines collapse to spaces so an emitted command stays ONE line. A runbook
 * is copy-pasted by a human or a subagent; a command that wraps across lines is
 * a command that gets pasted half-executed.
 */
declare function shq(s: string): string;
/**
 * Read and parse a JSON file, or return undefined.
 *
 * Absent, unreadable and malformed collapse to the SAME answer on purpose. Every
 * caller of this in a run directory is asking "is this worklist ready?", and a
 * file that exists but does not parse is not ready — it is the half-written or
 * hand-edited state, and treating it as a hard error would strand a run that the
 * prerequisite command can simply regenerate.
 *
 * It does NOT validate the shape. The caller knows what it asked for; this
 * returns whatever parsed, typed as what the caller claimed. A caller that acts
 * on a field must still check the field is there — which is why every worklist
 * reader in the consuming skills tests `Array.isArray(...)` before trusting it.
 */
declare function readJsonSafe<T>(path: string): T | undefined;
/**
 * Read a run's manifest. Same tolerance as readJsonSafe, and the same warning:
 * the type parameter is the caller's claim, not a guarantee.
 */
declare function readManifest<T>(dir: string, file?: string): T | undefined;
/**
 * Write a run's manifest — atomically, and through the no-write gate.
 *
 * Atomic because this is the file most likely to be read while it is written:
 * an MCP server answering a tool call and a CLI in another terminal both reach
 * for it, and a torn read is a `JSON.parse` throw in whichever got there first.
 * Gated because a run under `--stdout` must leave the filesystem as it found it.
 *
 * Returns the path it wrote (or would have written) — so a caller that PRINTS
 * it must check `isNoWrite()` first, the same contract as `writeArtifact`.
 */
declare function writeManifest(dir: string, value: unknown, file?: string): string;

interface Fingerprint {
    /** The URL as asked for. Not canonicalised: a caller comparing must compare like with like. */
    url: string;
    /** The strong validator, when the server sent one. */
    etag?: string;
    lastModified?: string;
    /** SHA-256 of the body, when one was read. */
    contentHash?: string;
    /** Bytes read. 0 on a 304, which is the whole point of a 304. */
    bytes: number;
    status: number;
    /** ISO timestamp of the observation, so a caller can age its own record. */
    fetchedAt: string;
}
/** SHA-256 of a body, hex. Exported because a caller holding bytes from elsewhere wants the same digest. */
declare function contentHash(body: string | Buffer): string;
/**
 * Observe a URL: its validators, its hash, and when it was seen.
 *
 * Always reads the body, because that is what makes the hash available for the
 * many servers that send neither an ETag nor a Last-Modified. Use `hasChanged`
 * when a validator is already in hand — that is the path that costs nothing.
 */
declare function fingerprint(url: string, opts?: {
    timeoutMs?: number;
    maxBytes?: number;
}): Promise<Fingerprint>;
interface ChangeVerdict {
    /** Undefined when the request failed — "I could not tell" is not "unchanged". */
    changed?: boolean;
    /** How it was decided, so a caller can weigh the evidence. */
    via: "not-modified" | "etag" | "last-modified" | "hash" | "unknown";
    /** The fresh observation, so a caller can store it without a second request. */
    fingerprint: Fingerprint;
    note?: string;
}
/**
 * Whether a URL has changed since a previous observation.
 *
 * Sends the conditional headers when `previous` carries validators. A 304 is
 * the ideal answer: definitive, and no body crossed the wire.
 *
 * `changed` is deliberately OPTIONAL rather than defaulting to false. A network
 * error, a 500 or a redirect to an error page all mean "I could not tell", and
 * a caller that treats those as "unchanged" silently stops watching the page it
 * asked to watch — which is the failure this shape exists to make impossible to
 * write by accident.
 */
declare function hasChanged(url: string, previous?: Pick<Fingerprint, "etag" | "lastModified" | "contentHash">, opts?: {
    timeoutMs?: number;
    maxBytes?: number;
}): Promise<ChangeVerdict>;

interface Table {
    /** The `<caption>`, when there is one. */
    caption?: string;
    /** Header cells, from `<thead>` or the first row of `<th>`. Empty when the table declares none. */
    headers: string[];
    /** Body rows, each padded to the widest row so a column index means one thing. */
    rows: string[][];
}
/**
 * Every table in a document, as rows and columns.
 *
 * A table with no data rows is dropped: a layout table used for positioning is
 * still common on older sites, and returning it as data is a false positive a
 * caller has no way to filter.
 */
declare function extractTables(html: string): Table[];
/**
 * A table as markdown, for folding back into extracted text.
 *
 * Pipes inside a cell are escaped, because an unescaped one silently splits the
 * cell and shifts the rest of the row — the same failure the span handling above
 * exists to prevent, reintroduced at the last step.
 */
declare function tableToMarkdown(table: Table): string;

/** Test seam. Never call this from product code — in-flight waiters would bunch up. */
declare function resetHostSchedule(): void;
/**
 * The floor between two requests to the SAME host, when robots.txt declares no
 * `Crawl-delay` of its own.
 *
 * Deliberately the same knob `httpGet` already used for its inter-request
 * pause, so a consumer that had tuned politeness keeps one number to tune.
 */
declare function hostDelayMs(): number;
/**
 * Wait until this host is willing to hear from us again, then claim the slot.
 *
 * The claim happens BEFORE the await returns, so two concurrent callers for one
 * host serialise instead of both reading the same free time and departing
 * together — which is the bug a naive "sleep if too soon" has, and the one that
 * makes a rate limiter look like it works right up until the pool widens.
 *
 * Different hosts never wait on each other: the whole point is to keep
 * concurrency high across a candidate list while staying single-file per site.
 */
declare function awaitHostSlot(url: string, delayMs?: number, now?: number): Promise<number>;
/**
 * Push a host's next departure out by `ms` — what a `Retry-After` means.
 *
 * `httpGet` already honours Retry-After for the request that received it; this
 * is how that answer applies to every OTHER request queued for the same host,
 * which is the difference between backing off and backing off once.
 */
declare function backOffHost(url: string, ms: number, now?: number): void;
interface CrawlOptions {
    /** Hard ceiling on pages fetched. Required in spirit; defaulted low on purpose. */
    maxPages?: number;
    /** How many links deep to follow. The seed is depth 0. */
    maxDepth?: number;
    /** Leave the seed's origin. Off by default — a crawl that wanders is not a site walk. */
    crossOrigin?: boolean;
    /** Seed the frontier from the site's sitemap as well as the seed page. Default true. */
    useSitemap?: boolean;
    /** Ignore robots.txt. For a site you own, and named so it cannot happen by accident. */
    ignoreRobots?: boolean;
    /** Per-host delay override. Otherwise robots' own Crawl-delay, else hostDelayMs(). */
    delayMs?: number;
    /** Called as each page lands, so a caller can stream rather than wait for the whole walk. */
    onPage?(page: CrawledPage): void;
}
interface CrawledPage {
    url: string;
    depth: number;
    title?: string;
    text: string;
    extractor: string;
    /** Links found on this page, already absolute and canonicalised. */
    links: string[];
}
interface CrawlResult {
    pages: CrawledPage[];
    /** URLs that were in scope but never fetched — the budget ran out. */
    pending: string[];
    /** URLs robots.txt refused. Reported rather than hidden: a silent skip reads as "not there". */
    disallowed: string[];
    notes: string[];
}
/** Absolute, canonical links out of a page's HTML. */
declare function linksFrom(html: string, baseUrl: string): string[];
/**
 * Walk a site from a seed, breadth-first.
 *
 * Bounded three independent ways — pages, depth, and origin — because any one
 * of them alone leaves a hole: a depth limit still admits a combinatorial
 * frontier, a page limit alone will spend the whole budget on a paginated
 * archive, and neither stops a link out to an unrelated host.
 *
 * robots.txt is consulted at EVERY hop, not once for the seed. That is the
 * difference between this and `fetch`, and it is deliberate: `fetch` follows a
 * URL the caller was handed, which is not crawling; this enumerates, which is.
 * A refused URL is reported in `disallowed` rather than dropped, because a
 * silent skip is indistinguishable from a page that does not exist.
 *
 * Breadth-first, so a shallow budget returns the pages nearest the seed — the
 * ones a reader would have reached first — rather than one deep spur.
 */
declare function crawlSite(seed: string, opts?: CrawlOptions): Promise<CrawlResult>;

/** Where the local Ollama answers. `off` disables the layer entirely. */
declare function ollamaBase(): string;
/** Whether the caller has turned embeddings off outright. */
declare function embeddingsDisabled(): boolean;
interface EmbedResult {
    /** One vector per input, in input order. Empty when the service did not answer. */
    vectors: number[][];
    /** The model that produced them, for a caller that stores vectors alongside their model. */
    model: string;
    /** Why the result is empty, when it is. Never thrown — the layer is optional. */
    note?: string;
}
/** Test seam, and the escape hatch for a server that came up mid-run. */
declare function resetOllamaProbe(): void;
/**
 * Whether the local embedding server answers.
 *
 * Cached for the process: a probe per call would double the request count of
 * every batch, and a server that goes away mid-run shows up as a failed embed
 * anyway.
 */
declare function probeOllama(base?: string): Promise<boolean>;
/**
 * Embed a batch of texts.
 *
 * Order is preserved and matters: callers index their documents by position,
 * and a race-ordered result would attach every vector to the wrong text —
 * silently, since a vector carries no identity of its own. `mapLimit` gives that
 * guarantee.
 *
 * An empty input returns immediately without probing, so a caller need not
 * special-case it.
 */
declare function embed(texts: readonly string[], opts?: {
    base?: string;
    model?: string;
    concurrency?: number;
}): Promise<EmbedResult>;
/** Embed one text. Convenience over `embed`, same degradation. */
declare function embedOne(text: string, opts?: {
    base?: string;
    model?: string;
}): Promise<number[] | undefined>;
/**
 * Cosine similarity, in [-1, 1]. Zero whenever the answer would not be a number.
 *
 * Three ways that happens, and all three collapse to 0 rather than propagating:
 *
 *   - a zero-magnitude vector;
 *   - vectors of DIFFERENT length, which for embeddings means two different
 *     models. Scoring them over a shared prefix produces a plausible number for
 *     a comparison that has no meaning, which is worse than refusing;
 *   - a non-finite component — a NaN or an Infinity that reached the caller
 *     from a broken embedding response.
 *
 * NaN compares false whichever way a comparator is written, so one degenerate
 * vector would sort to the bottom of one ranking and the top of another
 * depending on how someone happened to spell the sort.
 */
declare function cosine(a: readonly number[], b: readonly number[]): number;
/** A unit-length copy. A zero vector is returned unchanged, for the reason above. */
declare function normalize(v: readonly number[]): number[];

/** Where the local Qdrant answers. `off` disables the store. */
declare function qdrantBase(): string;
/** Test seam, and the escape hatch for a store that came up mid-run. */
declare function resetQdrantProbe(): void;
/** Whether the local vector store answers. Cached for the process, like the Ollama probe. */
declare function probeQdrant(base?: string): Promise<boolean>;
interface VectorPoint {
    /** Qdrant accepts an unsigned integer or a UUID. A caller keying by URL should hash it. */
    id: string | number;
    vector: number[];
    /** Whatever the caller needs back with a hit. The engine never reads it. */
    payload?: Record<string, unknown>;
}
interface VectorHit {
    id: string | number;
    score: number;
    payload?: Record<string, unknown>;
}
/**
 * Create a collection if it is not already there.
 *
 * `size` must match the embedding model's dimension, and getting it wrong is
 * not a soft failure — Qdrant rejects every later upsert. Callers derive it from
 * a real embedding rather than hardcoding a number that changes with the model.
 *
 * Distance defaults to cosine because that is what `nomic-embed-text` is trained
 * for and what `cosine()` here computes; a caller using a dot-product model says
 * so explicitly.
 */
declare function ensureCollection(name: string, size: number, opts?: {
    base?: string;
    distance?: "Cosine" | "Dot" | "Euclid";
}): Promise<{
    ok: boolean;
    note?: string;
}>;
/** Insert or replace points. Waits for the write, so a search right after sees them. */
declare function upsert(name: string, points: readonly VectorPoint[], opts?: {
    base?: string;
}): Promise<{
    ok: boolean;
    note?: string;
}>;
/** Nearest neighbours of a vector. Empty with a note when the store is absent. */
declare function searchVectors(name: string, vector: readonly number[], opts?: {
    base?: string;
    limit?: number;
    filter?: unknown;
}): Promise<{
    hits: VectorHit[];
    note?: string;
}>;
/** Drop a collection. Used by a caller that re-indexes from scratch. */
declare function deleteCollection(name: string, opts?: {
    base?: string;
}): Promise<{
    ok: boolean;
    note?: string;
}>;
/**
 * A document both lanes can read. Deliberately `Bm25Doc` itself rather than a
 * new shape: it already carries the identity (`id`) the fusion keys on and the
 * three fields the lexical lane weights, and inventing a parallel type would
 * make every caller map between two descriptions of one document.
 */
type HybridDoc = Bm25Doc;
interface HybridHit<D extends HybridDoc> {
    doc: D;
    /** The fused score. Comparable WITHIN one call and meaningless across calls. */
    score: number;
    /** 1-based rank in each lane, when that lane returned the document at all. */
    lexicalRank?: number;
    denseRank?: number;
}
/**
 * Rank documents against a question with both retrievers, fused.
 *
 * The dense lane needs no vector store: it embeds the question and the
 * documents in one batch and sorts by cosine. That keeps the common case — a
 * pool of candidates already in memory, which is what a research run has —
 * free of any indexing step. A caller with a corpus too large to embed per
 * query indexes it in Qdrant and calls `searchVectors` directly.
 *
 * RRF rather than a weighted sum of scores: a cosine and a BM25 score share no
 * scale, and any normalisation between them is a constant someone has to tune
 * per corpus and will get wrong on the next one. Fusing by RANK needs no such
 * constant, which is why it is the standard answer.
 *
 * With the embedding server absent, this degrades to exactly the lexical
 * ranking the caller would have got from `bm25Score` alone, plus a note. It
 * never throws and never returns fewer documents than it was given.
 */
declare function hybridSearch<D extends HybridDoc>(question: string, docs: readonly D[], opts?: {
    limit?: number;
    base?: string;
    model?: string;
    k?: number;
}): Promise<{
    hits: HybridHit<D>[];
    note?: string;
}>;

/**
 * A bracketed token that is not a markdown link.
 *
 * The negative lookahead is the whole subtlety: `[see the spec](https://…)` is
 * a link whose text happens to be bracketed, and counting it as a citation
 * makes every linked phrase look grounded.
 *
 * Global, so callers must reset `lastIndex` or use `matchAll`. The helpers
 * below do; a caller reaching for the constant directly should too.
 */
declare const TOKEN_RE: RegExp;
/** `[S1]` — the numbered-source shape. */
declare const SOURCE_TOKEN: RegExp;
/** `[E1]` — the numbered-evidence shape. */
declare const EVIDENCE_TOKEN: RegExp;
/** `[src/foo.ts:12]` or `[src/foo.ts:12-40]` — the file-and-line shape. */
declare const FILE_LINE_TOKEN: RegExp;
/** A `[path:line]` or `[path:start-end]` citation, parsed. Undefined when the token is not one. */
declare function parseFileLine(token: string): {
    path: string;
    start: number;
    end: number;
} | undefined;
/**
 * Blank HTML comments, preserving line breaks so every later mask still lines
 * up with the original numbering.
 *
 * A citation inside `<!-- [S1] -->` is invisible to the reader, so it must not
 * ground the sentence beside it.
 */
declare function stripHtmlComments(text: string): string;
/** Remove inline-code spans, so a `` `[S1]` `` shown as an EXAMPLE is not a citation. */
declare function stripInlineCode(line: string): string;
/**
 * Lines inside ``` or ~~~ fences, plus the fence lines themselves.
 *
 * A report that documents its own citation format has `[S1]` in a code block;
 * that is a sample, not a source.
 */
declare function codeMask(lines: readonly string[]): boolean[];
/**
 * Lines belonging to a marked blockquote region: a maximal run of consecutive
 * `>` lines in which any line carries `marker`.
 *
 * The marker is the caller's, because what it MEANS is the caller's. One skill
 * uses `[model-hint]` to flag a passage it knows is unsourced; the engine only
 * needs to know which lines to set aside.
 */
declare function markedQuoteMask(lines: readonly string[], marker: RegExp): {
    mask: boolean[];
    regions: number;
};
/**
 * Lines belonging to a trailing "## Sources" / "## References" section — from
 * its heading through to the next heading of the same or shallower level.
 *
 * That section is the rendered listing of what was cited, not a place where
 * citing happens. Counting its `[S#]` entries marks every source as cited and
 * pads any coverage number computed downstream, which is the failure mode this
 * exists for.
 */
declare function appendixMask(lines: readonly string[]): boolean[];
/** OR a set of per-line masks together. Length is taken from the first. */
declare function orMasks(...masks: readonly boolean[][]): boolean[];
/**
 * A unit of assertion: one block of prose or one table row, or a list read as a
 * group. Lists stay grouped because an item is often only a claim in the
 * context of its lead-in.
 *
 * `section` is whatever the caller's `sectionTag` returned for the heading this
 * unit sits under — a hook for "this part of the document plays by different
 * rules" without the engine having to know which rules.
 */
type ClaimUnit = ({
    kind: "text";
    text: string;
} | {
    kind: "list";
    items: string[];
}) & {
    section?: string;
};
interface ClaimUnitOptions {
    /**
     * Extra lines to set aside, on top of code fences and HTML comments — a
     * marked-quote mask, an appendix mask, or both through `orMasks`.
     */
    exclude?(lines: readonly string[]): boolean[];
    /**
     * A blockquote is its own unit ("unit", the default) or folds into the
     * surrounding prose ("prose").
     *
     * "unit" is the safer reading and the reason it is the default: folding a
     * quotation into the preceding paragraph lets it inherit that paragraph's
     * citation, so a fabricated quote passes on someone else's source.
     */
    blockquotes?: "unit" | "prose";
    /**
     * Drop the header row of a table — the row immediately above the `|---|`
     * separator. It is structure, not an assertion. Default true.
     */
    skipTableHeader?: boolean;
    /**
     * Keep inline-code spans in the STORED text. Structure detection always runs
     * on the stripped form, so a pipe or a bracket inside backticks is never read
     * as a table or a citation either way; this only decides whether a warning
     * that echoes the claim can quote it verbatim. Default false.
     */
    keepInlineCode?: boolean;
    /** Given a heading line's text, the tag to carry on units beneath it. */
    sectionTag?(heading: string): string | undefined;
}
/**
 * Split a markdown document into claim units.
 *
 * Headings, horizontal rules, code fences, HTML comments and table separators
 * are structure and never become units. What remains is what a reader would
 * call an assertion.
 *
 * This is a parser, not a judge: it says what the document asserts, never
 * whether the assertions are grounded.
 */
declare function extractClaimUnits(text: string, opts?: ClaimUnitOptions): ClaimUnit[];
/** The text a unit asserts: one string for prose, one per item for a list. */
declare function unitTexts(unit: ClaimUnit): string[];
/**
 * The distinct citation tokens in a piece of text, in order of first
 * appearance.
 *
 * `isCitation` is the caller's, and deliberately has no default: `[S1]`,
 * `[E12]`, `[issue#45]` and `[src/foo.ts:12]` are all citations to the skill
 * that uses them and prose to every other one. The engine will not guess.
 */
declare function citationTokensIn(text: string, isCitation: (token: string) => boolean): string[];
/**
 * Every bracketed token in the text, whether or not it is a citation.
 *
 * The counterpart to the function above: a caller that wants to report
 * "3 bracketed tokens I did not recognise" needs the ones the predicate
 * rejected, and re-scanning with an inverted predicate would miss that a token
 * can look like two things at once.
 */
declare function bracketedTokensIn(text: string): string[];
/**
 * The citation tokens a document uses to ground its claims, and the ones that
 * appear ONLY where they cannot.
 *
 * The second list is the useful half: a token that exists solely inside a code
 * fence, an HTML comment or an excluded section looks like grounding to a
 * reader skimming the file and grounds nothing. What to do about it — warn,
 * fail, ignore — is the caller's.
 */
declare function collectCitations(text: string, isCitation: (token: string) => boolean, opts?: ClaimUnitOptions): {
    grounding: string[];
    inertOnly: string[];
};
/**
 * Cited tokens that resolve to nothing known — a set difference, and nothing
 * more. Whether a dangling citation is fatal is the caller's to decide.
 */
declare function danglingTokens(cited: Iterable<string>, known: Iterable<string>): string[];
/** Known ids that no claim cites. The inverse of the above, same disclaimer. */
declare function uncitedIds(cited: Iterable<string>, known: Iterable<string>): string[];
/**
 * Strip digit-group separators — comma, NBSP, narrow NBSP, apostrophe, plain
 * space — so "10,000", "10 000" and "1'000" all read as one number.
 *
 * Applied to both sides of any containment test, which is the point: a report
 * writing "10,000" and a source writing "10 000" are stating the same figure,
 * and a comparison that says otherwise generates a false accusation.
 *
 * A comma is only a GROUP separator when it is followed by exactly three digits
 * that no further digit follows. Everywhere else it is a DECIMAL comma and
 * becomes a point, because most of the world writes "0,25" for what an English
 * source writes "0.25". Stripping it unconditionally — as this did until the
 * distinction was drawn — turned "0,25" into "025" and "1,5" into "15", so a
 * report accused itself of inventing every figure it had correctly transcribed.
 * That is not a corner case: the skills built on this engine are told to search
 * in the audience's language and report in the user's, so a French report over
 * English sources is the normal path, not the odd one.
 *
 * "1,000" stays ambiguous by construction and is read as one thousand — the
 * three-digit group is the far more common convention in the corpora these
 * tools fetch. NBSP, narrow NBSP and apostrophe are never decimal marks, so
 * they are still stripped between any two digits.
 */
declare function normalizeNumeralText(text: string): string;
/**
 * The specific figures a claim asserts, normalised.
 *
 * Digits inside citation tokens, inline code and markdown-link URLs never
 * count — `[S3]` and `/v2/users` are not claims about quantity. A bare single
 * digit is dropped as too weak a signal to check anything with; "two parts" and
 * "3 ways" are prose. Capped at 8, deduped, in order.
 */
declare function extractNumerals(text: string, max?: number): string[];

/**
 * The three calls that throw inside the workflow harness.
 *
 * `new Date()` with arguments is fine — it is the ARGLESS form that reads the
 * clock — but the emitter refuses both, because distinguishing them by regex
 * invites exactly the mistake the rule exists to stop. A workflow that needs a
 * timestamp takes one as an injected constant.
 */
declare const WORKFLOW_FORBIDDEN: readonly ["Date.now(", "Math.random(", "new Date("];
/** The half of a phase that describes how it is EMITTED, as the skill declares it. */
interface PhaseEmission {
    /** Contract filename under `orchestration/agents/<role>.md`, and the agent's role. */
    role: string;
    /** Progress-group title in the emitted workflow. */
    title: string;
    /** JSON Schema handed to `agent(…, { schema })`, so a fragment is validated on return. */
    schema: unknown;
    /** One agent per batch of at most this many items. */
    batchSize: number;
    /** Collapse to a single batch at or under this count. Defaults to the caller's floor. */
    collapseFloor?(smallWorklist: number): number;
    /** `meta.description` of the emitted workflow. */
    description(items: number): string;
    /** The orchestrator's fold step, rendered as comment lines in the script and in the runbook. */
    applyHint(run: string, engineAbs: string, phase: PhaseInfo): string[];
    /**
     * Extra options spliced into this phase's `agent(…)` call, as literal source.
     *
     * The case it exists for is worktree isolation: a phase whose subagents WRITE
     * — a builder running a task — needs `isolation: 'worktree'` or they collide
     * in one checkout. That is a property of the phase, not of the engine, and
     * without a hook such a phase has to keep its own emitter.
     *
     * Source rather than a value because these are harness options, not data: the
     * caller writes exactly what the harness expects. It is spliced into the
     * emitted file, so it goes through the same safety assertion as everything
     * else — a `Date.now()` in here is refused.
     */
    agentOpts?: string;
}
/**
 * The family-standard footer for a dispatch contract: subagents return
 * fragments, the orchestrator is the sole writer.
 *
 * One writer, many readers — no races and no clobbered evidence. Every skill
 * here had a copy; they differed only in whether a role gets a sanctioned
 * write of its own, so that is the parameter.
 *
 * @param runAbs      the run directory, for the oversized-prose escape hatch
 * @param sanctioned  the ONE write this role may perform, if any
 * @param writingCommands  engine commands the subagent must not run
 */
declare function oneWriterFooter(runAbs: string, opts?: {
    sanctioned?: string;
    writingCommands?: readonly string[];
}): string;
/** Chunk ids into batches, one subagent per batch. Order-preserving and deterministic. */
declare function toBatches(ids: readonly string[], batchSize: number): string[][];
/**
 * The launchable Workflow script for one ready phase.
 *
 * The worklist is the source of truth: the batches are frozen into the script
 * at emit time, so a worklist that changes needs a re-emit before launching.
 * Saying so in the file itself is cheaper than the confusion of a stale run.
 */
declare function emitWorkflowScript<T>(phase: PhaseInfo<T>, emission: PhaseEmission, runAbs: string, engineAbs: string, smallWorklist: number, constants?: Record<string, unknown>): string;
/**
 * The sequential fallback.
 *
 * Not a lesser path — it is the correct one for a small worklist, and the only
 * one when no subagent-capable harness is present. It lists every phase,
 * whether it is ready, and the exact command that makes it ready, so a reader
 * can walk the whole run by hand.
 */
declare function runbookMd<T>(phases: readonly PhaseInfo<T>[], defs: readonly PhaseEmission[], runAbs: string, engineAbs: string, cli: string, preamble?: readonly string[]): string;

/**
 * Below this many items a fan-out does not pay for itself, and `orchestrate`
 * says so rather than emitting a workflow nobody should launch.
 *
 * A default, not a rule: each phase overrides it through `collapseFloor`,
 * because the units differ in weight. One heavy per-sub-question gather is
 * worth its own agent at any count above one; one cheap claim↔source judgment
 * is not.
 */
declare const SMALL_WORKLIST = 3;
/** One agent per batch of at most this many items, unless a phase says otherwise. */
declare const BATCH_SIZE = 8;
/**
 * A phase, as the SKILL declares it.
 *
 * `T` is whatever that phase's worklist file parses to — the skill's own type.
 * This module reads it only through the two callbacks below, so it never has to
 * know the shape.
 */
interface PhaseDefinition<T = unknown> extends PhaseEmission {
    /** Phase name, used for `--phase`, the script filename and the progress group. */
    name: string;
    /** The worklist filename, relative to the run directory. */
    worklist: string;
    /**
     * The fan-out ids for this phase, or undefined when it is not ready.
     *
     * Returning undefined is how a file that exists but is half-written stays
     * "not ready" instead of producing a workflow over garbage — which is why
     * every consumer's version of this tested `Array.isArray(...)` before
     * trusting the parse.
     *
     * `run` and `engineAbs` come along because a phase's units are not always a
     * field of one file: one consumer derives its research gaps by ANALYSING the
     * whole run, and needs the engine path to write each unit's drill command
     * into the id itself. A callback that only ever saw the parsed worklist
     * forced that phase to stay forked.
     */
    ids(parsed: T | undefined, run: string, engineAbs: string): string[] | undefined;
    /** The engine command that produces this worklist. Shown when it is missing. */
    prerequisite(run: string, engineAbs: string, parsed?: T): string;
}
/** A phase, as this module resolved it against a run directory. */
interface PhaseInfo<T = unknown> {
    name: string;
    ready: boolean;
    /** Absolute path of the worklist this phase fans out over. */
    worklist: string;
    items: number;
    ids: string[];
    /** The command that produces the worklist when it is missing. */
    prerequisite: string;
    /** The parsed worklist, when ready — a phase's own emitters may need it. */
    parsed?: T;
}
interface OrchestrateOptions {
    /** Emit only this phase. Exit code 2 when its worklist does not exist yet. */
    phase?: string;
    /** Emit only the RUNBOOK and the contracts — the explicit low-token path. */
    eco?: boolean;
    /** Override the default collapse floor. */
    smallWorklist?: number;
    /** Lines the skill wants at the top of RUNBOOK.md, above the phase list. */
    runbookPreamble?: string[];
    /**
     * Extra `const NAME = <json>` lines in every emitted workflow.
     *
     * For run-specific data a subagent must receive rather than fetch: a judge
     * handed the decision and its evidence verbatim never has to open the run
     * folder it is judging. Values are JSON-serialised, so the harness's
     * pure-literal rule still holds.
     */
    constants?: Record<string, unknown>;
}
interface OrchestrateResult {
    exitCode: number;
    written: string[];
    notices: string[];
    errors: string[];
    phases: PhaseInfo[];
}
/**
 * Resolve every declared phase against a run directory.
 *
 * Reading is tolerant by design (see readJsonSafe): absent, unreadable and
 * malformed all mean "not ready", because the prerequisite command can simply
 * regenerate the file and failing hard would strand the run instead.
 */
declare function listPhases<T>(runDir: string, engineAbs: string, defs: readonly PhaseDefinition<T>[]): PhaseInfo<T>[];
/**
 * Emit the run's orchestration from its current worklists.
 *
 * Writes, in `<run>/orchestration/`:
 *   agents/<role>.md      the dispatch contracts, every role, every call
 *   <phase>.workflow.mjs  one launchable Workflow script per ready phase
 *   RUNBOOK.md            the sequential fallback
 *
 * The contracts are rewritten on every call, including under `--eco`: they
 * double as the RUNBOOK's self-pass checklists, so the sequential path needs
 * them just as much as the fan-out does.
 *
 * Every write goes through `writeArtifact`, so `--stdout` leaves the filesystem
 * exactly as it found it. That is not a refinement — one consuming skill wrote
 * these files with a bare writeFileSync and silently escaped its own gate.
 */
declare function orchestrateRun<T>(runDir: string, engineAbs: string, defs: readonly PhaseDefinition<T>[], contracts: (run: string, engineAbs: string, phases: PhaseInfo<T>[]) => Record<string, string>, opts?: OrchestrateOptions): OrchestrateResult;

/** The command did what it was asked. */
declare const EXIT_OK = 0;
/** The command ran and the answer is a failure: nothing found, a gate refused. */
declare const EXIT_FAILURE = 1;
/** The invocation itself was wrong: unknown command, unknown flag, missing value. */
declare const EXIT_USAGE = 2;
/**
 * The invocation was malformed. Carries EXIT_USAGE so a caller can map every
 * parse failure to the right code without matching on the message.
 *
 * Thrown, not printed: the parser has no business owning stderr, and a test
 * that asserts on a message should not have to capture a stream to read it.
 */
declare class UsageError extends Error {
    readonly exitCode = 2;
}
interface CliSpec {
    /** Every command word the CLI answers to. */
    commands: Iterable<string>;
    /** Flags that take a value: `--out <dir>` or `--out=<dir>`. */
    valueFlags: Iterable<string>;
    /** Flags that are present or absent: `--json`. Never take a value. */
    boolFlags: Iterable<string>;
}
/** A parsed invocation of one command. */
interface CommandArgs {
    command: string;
    /** Bare words, in order, with flags and their values removed. */
    positional: string[];
    values: Record<string, string>;
    bools: ReadonlySet<string>;
}
/**
 * What an argv turned out to be. `--help` and `--version` are outcomes rather
 * than commands because every CLI answers them the same way and none of them
 * wants a case in its command switch for it.
 */
type ParsedArgs = {
    kind: "help";
} | {
    kind: "version";
} | ({
    kind: "command";
} & CommandArgs);
/**
 * Parse an argv against a spec.
 *
 * Rejects, rather than ignoring: an unknown flag is a typo, and a CLI that
 * silently drops `--limt 5` runs the whole command with the wrong budget and
 * reports success. That silence is what this replaces — webindex's own CLI read
 * flags with `argv.indexOf("--" + name)` and accepted anything.
 *
 * Throws UsageError on: an unknown command, an unknown flag, a value flag with
 * no value, and a boolean flag given one.
 */
declare function parseArgs(argv: readonly string[], spec: CliSpec): ParsedArgs;
/** A value flag, or undefined. */
declare function argValue(p: CommandArgs, name: string): string | undefined;
/** Whether a boolean flag was given. */
declare function argBool(p: CommandArgs, name: string): boolean;
/**
 * A value flag as an integer, or undefined when absent.
 *
 * Throws UsageError on a value that is not one, rather than returning NaN. A
 * NaN budget propagates into a comparison that is false whichever way it is
 * written, so `--limit abc` would silently mean "no limit" — the opposite of
 * what was asked.
 */
declare function argInt(p: CommandArgs, name: string): number | undefined;
/** A comma-separated value flag as a trimmed, empty-free list. Absent → []. */
declare function argList(p: CommandArgs, name: string): string[];
/**
 * A value flag constrained to a set. Absent → undefined; present and outside
 * the set → UsageError naming what was expected.
 */
declare function argOneOf<T extends string>(p: CommandArgs, name: string, allowed: readonly T[]): T | undefined;
/**
 * The positional words as one string.
 *
 * `search rate limiting --limit 5` is ONE query of two words, not two queries
 * and a stray number. The parser already dropped the flag and its value, so
 * joining what is left is the whole of it — which is why this is three lines
 * here and was a 25-line hand-rolled scanner in src/cli.ts.
 */
declare function positionalText(p: CommandArgs): string;
/** JSON as a CLI writes it: two-space indent, one trailing newline. */
declare function jsonLine(value: unknown): string;
/**
 * A fresh global regex matching a documented `--flag`.
 *
 * The lookbehind skips a `--` glued to a word tail (`foo--bar`, `---`) so a
 * bold, parenthesised or em-dashed flag is still seen.
 *
 * Returns a NEW regex per call on purpose: a global regex carries `lastIndex`
 * between uses, so a shared one silently skips matches in the second caller.
 */
declare function docFlagRegex(): RegExp;
/** Every distinct `--flag` a document mentions, in first-seen order. */
declare function documentedFlags(text: string): string[];
/**
 * Whether a help text mentions `--flag` as a whole token.
 *
 * The lookahead is what stops `--run` from being "covered" by `--run-root`, and
 * `--shard` by `--shards`. Without it the gate passes on precisely the pairs it
 * exists to catch.
 */
declare function helpCoversFlag(help: string, flag: string): boolean;
/** The flags a CLI accepts that its help text never names. */
declare function missingFromHelp(help: string, flags: Iterable<string>): string[];
/**
 * The pipe-separated value list documented for `--<flag>` on one line, or null
 * when the line carries no such enumeration.
 *
 * The list must FOLLOW the flag with only non-letters in between, so a markdown
 * table's pipes elsewhere on the line cannot false-positive. Backticks are
 * stripped first so `` `a`|`b` `` still matches, and an escaped `\|` — which is
 * how a literal pipe must be written inside a table cell — is unescaped first,
 * because an enumeration in a table cell is still an enumeration.
 */
declare function pipedEnum(line: string, flag: string): string[] | null;
/**
 * Whether this process was started AS the CLI, rather than imported.
 *
 * Importing a bundle must not run it: the skill-bundle gate imports each built
 * artifact to read its flag tables, and a `main()` that fired on import would
 * turn a verification step into a run.
 *
 * Matches the basename against the configured brand, so a consumer's
 * `scripts/ultrasearch.mjs`, a Homebrew `bin/ultrasearch` symlink and a global
 * npm shim all count, while `node -e 'import(...)'` does not. brand() is read at
 * CALL time — the lazy rule in brand.ts applies here like everywhere else.
 */
declare function isInvokedDirectly(argv1?: string | undefined, cli?: string): boolean;

declare const PROTOCOL_VERSIONS: readonly ["2024-11-05", "2025-03-26", "2025-06-18", "2025-11-25"];
type ProtocolVersion = (typeof PROTOCOL_VERSIONS)[number];
declare const LATEST_PROTOCOL: ProtocolVersion;
declare const ASSUMED_HTTP_PROTOCOL: ProtocolVersion;
declare const ANNOTATIONS_SINCE = "2025-03-26";
declare const RICH_TOOLS_SINCE = "2025-06-18";
declare const DEFAULT_MAX_RESPONSE_BYTES = 1000000;
declare function isProtocolVersion(v: unknown): v is ProtocolVersion;
declare function negotiateProtocol(requested: unknown): ProtocolVersion;
interface JsonSchemaProp {
    type?: "string" | "number" | "boolean" | "array" | "object";
    items?: {
        type?: string;
    };
    enum?: readonly string[];
    description?: string;
}
interface JsonSchema {
    type: "object";
    properties: Record<string, JsonSchemaProp>;
    required: string[];
}
declare function validateArgs(schema: JsonSchema, args: Record<string, unknown>): string | undefined;
/**
 * How to ask for less, per tool name.
 *
 * A cap that only says "too big" makes the model retry the same call; one that
 * names the narrowing argument gets a smaller second call. Which argument that
 * is depends entirely on the tool, so the map is supplied by the consuming
 * skill through McpAdapter.capAdvice — the engine knows a response is oversized,
 * only the consumer knows how to make it smaller.
 */
type CapAdvice = Record<string, string>;
declare function capResponse(text: string, tool: string, maxBytes: number, artifact?: string, advice?: CapAdvice): string;
declare function structuredContentFor(text: string, capped: boolean, hasSchema: boolean): Record<string, unknown> | undefined;
declare function isOriginAllowed(origin: string | undefined, allowed?: string[]): boolean;

interface JsonRpcMessage {
    jsonrpc?: string;
    id?: string | number | null;
    method?: string;
    params?: Record<string, unknown>;
    [k: string]: unknown;
}
interface ToolDecl {
    name: string;
    description: string;
    inputSchema: JsonSchema;
    title?: string;
    outputSchema?: JsonSchema;
    annotations?: Record<string, boolean>;
}
interface PromptDecl {
    name: string;
    title?: string;
    description?: string;
    arguments?: {
        name: string;
        description?: string;
        required?: boolean;
    }[];
}
interface PromptResult {
    description?: string;
    messages: {
        role: string;
        content: {
            type: string;
            text: string;
        };
    }[];
}
/** What a tool handler gives back: text for the model, plus an optional artifact path. */
interface ToolOutcome {
    text: string;
    artifact?: string;
}
/**
 * Thrown for anything the caller can fix by calling again differently. The
 * server turns it into an `isError` tool result, never a JSON-RPC error: the
 * tool ran, the request was wrong or the world didn't cooperate.
 *
 * Lives here rather than in each skill so the distinction is decided in ONE
 * place. Conflating a tool failure with a protocol error hides a client bug
 * inside a model-readable result the model then tries to reason around.
 */
declare class ToolError extends Error {
}
/** Thrown for an unknown prompt or a missing required argument. A client bug. */
declare class PromptError extends Error {
}
/**
 * The skill half of the server. Everything the engine cannot know.
 *
 * `listTools` takes the negotiated protocol version because tool declarations
 * are version-gated: annotations and output schemas only exist from certain
 * revisions onward, and advertising them to an older client is a spec
 * violation.
 */
interface McpAdapter {
    /** Version reported in `serverInfo`. The skill's, not the engine's. */
    version: string;
    listTools(protocol: ProtocolVersion): ToolDecl[];
    callTool(name: string, args: Record<string, unknown>): Promise<ToolOutcome>;
    /**
     * Per-tool advice for narrowing an oversized request. The engine detects the
     * overflow; only the skill knows which argument makes the result smaller.
     */
    capAdvice?: CapAdvice;
    /** Omit to advertise no prompts; the capability is declared either way. */
    prompts?: PromptDecl[];
    getPrompt?(name: string, args: Record<string, unknown>): PromptResult;
}
interface ServerOptions {
    maxResponseBytes?: number;
    /** Defaults to the brand name. */
    serverName?: string;
    skillDir?: string;
}
declare const ERR_INVALID_REQUEST = -32600;
declare const ERR_METHOD_NOT_FOUND = -32601;
declare const ERR_INVALID_PARAMS = -32602;
declare const ERR_INTERNAL = -32603;
interface McpServer {
    handle(msg: JsonRpcMessage, send: (out: JsonRpcMessage) => void): Promise<void>;
    protocolVersion(): ProtocolVersion;
    setProtocolVersion(v: ProtocolVersion): void;
    tools(): ToolDecl[];
}
declare function createServer(adapter: McpAdapter, opts?: ServerOptions): McpServer;

interface StdioOptions extends ServerOptions {
    input?: Readable;
    output?: Writable;
    captureStdout?: boolean;
}
declare function runStdioServer(adapter: McpAdapter, opts?: StdioOptions): Promise<void>;

interface HttpOptions extends ServerOptions {
    port?: number;
    bind?: string;
    allowOrigin?: string[];
    allowRemote?: boolean;
}
interface RunningHttpServer {
    server: Server;
    port: number;
    url: string;
    close(): Promise<void>;
}
declare function startHttpServer(adapter: McpAdapter, opts?: HttpOptions): Promise<RunningHttpServer>;

/**
 * Display name used in resource titles. Comes from the brand, so a consumer
 * called "reader" serves "reader: the skill" — SKILL.md is the file convention
 * being served, not an assumption about who is serving it.
 */
declare const skillName: () => string;
interface ResourceDecl {
    uri: string;
    name: string;
    title?: string;
    description?: string;
    mimeType: string;
}
interface ResourceContents {
    uri: string;
    mimeType: string;
    text: string;
}
declare function resolveSkillRoot(moduleDir?: string): string | undefined;
declare function listResources(moduleDir?: string): ResourceDecl[];
declare function readResource(uri: string, moduleDir?: string): ResourceContents;
declare class ResourceError extends Error {
}

export { ANNOTATIONS_SINCE, ANYDOC_SPEC, ASSUMED_HTTP_PROTOCOL, type Artifact, BATCH_SIZE, type Bm25Doc, type Bm25Index, type Brand, COMPOSE_YAML, type CacheEntry, type CacheMode, type CacheStats, type CapAdvice, type ChangeVerdict, type ClaimUnit, type ClaimUnitOptions, type CliSpec, type CommandArgs, type CrawlOptions, type CrawlResult, type CrawledPage, DEAD_LINK_STATUS, DEFAULT_MAX_RESPONSE_BYTES, DOC_EXTENSIONS, DOC_EXTRACTORS, type DocExtraction, type DocExtractorId, type DocFormat, type DocLadderOptions, ENGINE_VERSION, ERR_INTERNAL, ERR_INVALID_PARAMS, ERR_INVALID_REQUEST, ERR_METHOD_NOT_FOUND, EVIDENCE_TOKEN, EXIT_FAILURE, EXIT_OK, EXIT_USAGE, type EmbedResult, type EngineHit, type EngineResult, type ExcerptWindow, type ExpandedKeyword, type ExtractResult, type ExtractorId, FILE_LINE_TOKEN, FIRECRAWL_DEFAULT_BASE, FIRECRAWL_ENV, type Feed, type FeedItem, type Fingerprint, type FirecrawlHit, type FirecrawlOptions, type FirecrawlScrape, type ForgeItem, type ForgeKind, type ForgeOptions, type ForgeResult, type HttpOptions, type HttpResult, type HybridDoc, type HybridHit, type JsonRpcMessage, type JsonSchema, type JsonSchemaProp, KEYLESS_ENGINES, type KeylessEngine, type KeywordMatcher, type KeywordVariant, LATEST_PROTOCOL, LOCAL_FILE_DOMAIN, type McpAdapter, type McpServer, type OrchestrateOptions, type OrchestrateResult, PDF_EXTRACTORS, PDF_INSPECTOR_SPEC, PDF_URL_RE, PROTOCOL_VERSIONS, type PackageFacts, type PageMetadata, type ParsedArgs, type PdfExtraction, type PdfExtractorId, type PdfLadderOptions, type PdfVerdict, type PhaseDefinition, type PhaseEmission, type PhaseInfo, type PromptDecl, PromptError, type PromptResult, type ProtocolVersion, RICH_TOOLS_SINCE, type Ranked, type RegistryKind, type RepoFacts, type RepoRef, type ResolvedProvider, type ResourceContents, type ResourceDecl, ResourceError, type Robots, type RobotsRule, type RunningHttpServer, SEARXNG_DEFAULT_BASE, SEARXNG_SETTINGS_YAML, SERVICE_PROFILES, SMALL_WORKLIST, SOURCE_TOKEN, STACK_SERVICES, type ScrapeAttempt, type SearchHit, type SearchOptions, type SearchResult, type ServerOptions, type ShResult, type Sitemap, type StackAction, type StackDeps, type StackResult, type StackRun, type StdioOptions, TOKEN_RE, type Table, type ToolDecl, ToolError, type ToolOutcome, UsageError, type VectorHit, type VectorPoint, WORKFLOW_FORBIDDEN, accentPattern, acceptLanguageHeader, addressedIdCount, apiBase, apiPrefix, appendixMask, applyRelevanceFloor, argBool, argInt, argList, argOneOf, argValue, arxivIdFromUrl, assessExtractedText, assessPdfText, awaitHostSlot, backOffHost, baseLang, bestExcerpt, bm25MatchedTerms, bm25Score, bm25Tokenize, bracketedTokensIn, brand, browserUa, buildBm25Index, buildMatcher, cacheClean, cacheDir, cacheMode, cachePath, cacheStats, cachedFetchAndExtract, canonicalRepo, canonicalRepoRef, canonicalizeUrl, capExtract, capResponse, charsetFromContentType, charsetFromHtml, citationTokensIn, cleanInline, codeMask, collectCitations, configure, contactUa, contentCoverage, contentHash, cosine, crawlSite, createServer, danglingTokens, ddgRedirectTarget, ddgRegion, deaccent, decodeBody, decodeEntities, dedupeByUrl, dedupeNearDuplicates, defaultUa, deleteCollection, deriveCitableUrl, detectRateLimited, discoverFeeds, diversify, docFlagRegex, docFormatForContentType, docFormatForUrl, documentedFlags, doiFromUrl, domainOf, embed, embedModel, embedOne, embeddingsDisabled, emitWorkflowScript, enabledDocExtractors, enabledExtractors, ensureClone, ensureCollection, ensureComposeMaterialized, ensureDir, ensureHistoryDepth, env, envFlag, envInt, envName, escapeRegExp, excerptWindows, expandTokens, externalHosts, extractClaimUnits, extractDocument, extractJsonLd, extractMainHtml, extractMetaTags, extractNumerals, extractPdf, extractTables, fetchAndExtract, fetchFeed, fetchRobots, fetchSitemap, fingerprint, firecrawlBase, firecrawlIsExplicit, fnv1a64, focusedSnippet, foldTerm, forgeAuthHeaders, forgeKind, hammingDistance, hasChanged, have, headCommit, helpCoversFlag, hostDelayMs, htmlCanonicalUrl, htmlTitle, htmlToText, httpGet, httpJson, hybridSearch, isAllowed, isApiEndpoint, isCacheFresh, isCitableUrl, isInvokedDirectly, isKeylessEngine, isNoWrite, isOriginAllowed, isProtocolVersion, isStopword, jsonLine, keylessEngines, keywords, linksFrom, listPhases, listReleases, listResources, listTags, looksLikeChallenge, looksLikeFirecrawl, looksLikeJunkExtraction, looksLikePdfUrl, lookupPackage, mapGithubIssues, mapLimit, mapScrapeResponse, mapSearchResponse, markFirecrawlDown, markedQuoteMask, matcherFromTokens, metaDescriptionOf, missingFromHelp, nearestHeading, negotiateProtocol, normalize, normalizeDoi, normalizeNumeralText, normalizeRepoUrl, ocrBudgetLeft, ocrPdf, ocrTools, ollamaBase, oneWriterFooter, orMasks, orchestrateRun, originUrl, pageDelayMs, pageMetadata, parseArgs, parseDdgHtml, parseDdgLite, parseFeed, parseFileLine, parseMojeek, parseRetryAfter, parseRobots, parseSitemap, pdfToText, pipedEnum, politeDelayMs, positionalText, probeFirecrawl, probeOllama, probeQdrant, probeSearxng, pubmedAbstractUrl, qdrantBase, rankedKeywords, readCapped, readCappedBytes, readJsonSafe, readManifest, readResource, recencyScore, renderAsset, repoCacheRoot, repoFacts, rescueViaWayback, resetBrand, resetCacheMode, resetCanonicalRepoCache, resetDocLadderCache, resetFirecrawlProbeCache, resetHaveCache, resetHistoryDepthCache, resetHostSchedule, resetNoWrite, resetOcrBudget, resetOllamaProbe, resetPdfLadderCache, resetQdrantProbe, resetRobotsCache, resetRunLocks, resetSearxngProbeCache, resolvePackage, resolveProvider, resolveRegion, resolveRepo, resolveSkillRoot, revalidationHeaders, rrf, runId, runStdioServer, runWithInput, runbookMd, sameCommit, scrapeViaFirecrawl, search, searchIssues, searchVectors, searchViaFirecrawl, searchViaKeyless, searchViaSearxng, searxngBase, searxngIsExplicit, setCacheMode, setNoWrite, sh, shAsync, shq, simhash, skillName, sleep, slugify, stackControl, startHttpServer, stripConsentBoilerplate, stripHtmlComments, stripInlineCode, stripTags, structuredContentFor, subtokens, tableToMarkdown, takeArtifacts, throttleReason, toBatches, uncitedIds, unitTexts, upsert, urlDeclaresIdentity, validateArgs, withRunLock, writeArtifact, writeFileAtomic, writeManifest };
