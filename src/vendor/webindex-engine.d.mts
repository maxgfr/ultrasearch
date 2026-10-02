import { EventEmitter } from 'node:events';
import { Socket } from 'node:net';
import { SpawnOptions } from 'node:child_process';
import { FileHandle } from 'node:fs/promises';
import { Readable, Writable } from 'node:stream';
import { Server } from 'node:http';

declare const ENGINE_VERSION = "1.29.2";

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
     * Home of the dedicated browser: its profiles (logins live there), the saved
     * session and the snapshots' refs. Defaults to `~/.<name>/browser`.
     *
     * Under the home directory rather than the temp dir on purpose: a tmp sweeper
     * would silently log the user out of every site, and a login is the one thing
     * the user cannot regenerate by re-running the command. A consumer that
     * already keeps such state somewhere declares it here instead of having it
     * orphaned.
     */
    browserDir?: string;
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
 * Read a numeric tunable. A missing or non-numeric value falls back to `def`,
 * and a number outside [min, max] — a negative one under the default min of 0
 * included — is truncated and clamped to the nearer bound, never refused:
 * these are performance knobs, and a typo in one must never abort a run.
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
/** Test seam: forget which OCR binaries were found. */
declare function resetOcrTools(): void;
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
/** Test seam: forget which rungs and OCR binaries were found, and refill the OCR budget. */
declare function resetPdfLadderCache(): void;
/**
 * The rungs to try, honouring `<PREFIX>_PDF_ENGINE` (a comma list of rungs to
 * run, in order, or `none`) and `<PREFIX>_NO_NPX` (skip the rungs that need an
 * implicit install), where `<PREFIX>` is whatever the consuming skill declared
 * via `configure()`.
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
 * Never throws. When every rung fails, returns empty text plus the reason — the
 * last rung's verdict, sharpened where the bytes say more (not a PDF at all, an
 * encrypted one, a scan that OCR would read), then what the tools themselves
 * said — so the caller can say why the source is unusable instead of silently
 * citing nothing.
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
/**
 * What these bytes are, when they are a document: `"pdf"`, an office format,
 * or undefined for anything else (text, HTML, images, plain archives).
 *
 * For a response whose URL and headers gave nothing away — a download route
 * answering `application/octet-stream`, or no type at all — and for a local
 * file whose name lies. The signatures are the ones the converters themselves
 * trust, which is why an office match carries no `format`: anydoc reads the
 * real one from the same bytes.
 *
 * A ZIP counts only with a package manifest (`[Content_Types].xml` for OOXML,
 * a leading `mimetype` entry for OpenDocument and EPUB): a source archive is
 * not a document, and routing it to the converter would misreport it.
 */
declare function sniffDocument(bytes: Buffer): "pdf" | DocFormat | undefined;

type DocExtractorId = "anydoc" | "firecrawl" | "builtin";
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
 * The rungs to try, honouring `<PREFIX>_DOC_ENGINE` (a comma list of rungs to
 * run, in order, or `none` to disable the ladder — parsed as `PDF_ENGINE` is)
 * and `<PREFIX>_NO_NPX` (skip the rung that needs an implicit install), where
 * `<PREFIX>` is whatever the consuming skill declared via `configure()`.
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
 * Never throws. When every rung fails, returns empty text plus the reason — the
 * gate's verdict, or what the converter itself said, or why it could not run —
 * so the caller can say why the source is unusable instead of silently citing
 * nothing, or, worse, citing the raw bytes.
 */
declare function extractDocument(bytes: Buffer, fmt: DocFormat, opts?: DocLadderOptions): Promise<DocExtraction>;

/**
 * The text of an OOXML (.docx, .xlsx, .pptx) or OpenDocument (.odt, .ods, .odp)
 * file as Markdown: headings, paragraphs, lists, and tables — a spreadsheet's
 * sheets as one table each, a deck's slides in presentation order with their
 * speaker notes.
 *
 * Undefined when the bytes are not such a file, or break one of the reader's
 * limits (ZIP64, encryption, an unknown compression method, a decompression
 * bomb, too many entries). Never throws. The text is not judged here: callers
 * run it through the same quality gate as every other rung.
 */
declare function officeToText(bytes: Buffer): string | undefined;

/**
 * The video id a YouTube URL points at, or undefined when it names no single
 * video. Reads `watch?v=`, `youtu.be/<id>`, and the `/shorts/`, `/embed/`,
 * `/live/` and `/v/` paths, on youtube.com, its subdomains (www, m, music) and
 * youtube-nocookie.com.
 */
declare function youtubeVideoId(url: string): string | undefined;
/**
 * Whether a YouTube URL names a list of videos: a `playlist` (any URL carrying
 * `list=`) or a `channel` (`/@handle`, `/channel/`, `/c/`, `/user/`).
 * Undefined for anything else, a single video included.
 */
declare function youtubeListKind(url: string): "playlist" | "channel" | undefined;
/** A video URL resolved to what yt-dlp is handed, and — when the URL alone says — the run it is kept under. */
interface VideoSource {
    /** `youtube`, `vimeo`, `dailymotion`… — the host's short name; `web` for a site this module does not know. */
    site: string;
    /** The URL yt-dlp reads: a canonical form rebuilt from the id where there is one, else the URL as given. */
    url: string;
    /** The run directory's name (`dQw4w9WgXcQ`, `vimeo-76979871`), when the URL alone determines it. */
    key?: string;
}
/**
 * A single video on a host this module knows — YouTube or one of the common
 * video sites — resolved to the URL yt-dlp reads and, where the URL gives the
 * id, its run key. Undefined for anything else, a playlist or a channel
 * included.
 */
declare function knownVideo(url: string): VideoSource | undefined;
/**
 * The URL an explicit video command may hand yt-dlp: a known video host's,
 * canonicalised; with `anySite`, any other http(s) URL too, as given (yt-dlp
 * then says whether there is a video there). Undefined for anything that is
 * not http(s) — no string starting with `-` can get through.
 */
declare function videoSource(url: string, opts?: {
    anySite?: boolean;
}): VideoSource | undefined;
/**
 * The run key of a video yt-dlp has read: its YouTube id as is, else
 * `<site>-<id>`. yt-dlp's catch-all extractor names a page by its last path
 * segment — `a.com/talks/intro` and `b.org/course/intro` are both `intro` — so
 * a `web` key, and any id that had to be made filesystem-safe, also carries a
 * hash of the page it came from: two pages never share a run.
 */
declare function videoRunKey(site: string, id: string, pageUrl?: string): string;
/**
 * The watch URL opened at `seconds`, in the form each site understands:
 * YouTube `?t=`, Vimeo `#t=`, Dailymotion `?start=`, Twitch `?t=0h1m2s`. A site
 * with no known form gets its URL unchanged.
 */
declare function videoUrlAt(webpageUrl: string, seconds: number): string;

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
 * long as all of them put together. SIGKILL on timeout — to the command and
 * everything it started — and never an orphan.
 */
declare function shAsync(cmd: string, args: string[], opts?: {
    cwd?: string;
    timeoutMs?: number;
    env?: NodeJS.ProcessEnv;
    signal?: AbortSignal;
}): Promise<ShResult>;

/** Runs a command. The default is shAsync; tests inject their own. */
type VideoRunner = (cmd: string, args: string[], opts?: {
    timeoutMs?: number;
    cwd?: string;
    signal?: AbortSignal;
}) => Promise<ShResult>;
interface VideoChapter {
    start: number;
    end: number;
    title: string;
}
/** What yt-dlp's `-J` says about one video, reduced to what a transcript needs. */
interface VideoMeta {
    /** The site's own id for the video. */
    id: string;
    /** `youtube`, `vimeo`, `dailymotion`… — from yt-dlp's extractor. Absent in runs written before other sites were read: YouTube. */
    site?: string;
    /** The run directory's name: the YouTube id itself, else `<site>-<id>`. */
    key?: string;
    title: string;
    channel?: string;
    /** YYYY-MM-DD. */
    uploadDate?: string;
    /** Seconds. */
    duration?: number;
    /** The video's own language, when YouTube knows it (`en`, `fr`…). */
    language?: string;
    chapters: VideoChapter[];
    /** Languages with manual subtitles. */
    subtitles: string[];
    /** Languages with auto-captions — the original (`<lang>-orig`) and YouTube's machine translations. */
    autoCaptions: string[];
    webpageUrl: string;
    /** A stream that is on air now, or scheduled: there is nothing whole to transcribe yet. */
    live?: "live" | "upcoming";
}
/** The metadata, and the raw `-J` JSON later calls are fed with `--load-info-json`. */
type VideoProbe = {
    meta: VideoMeta;
    info: string;
} | {
    error: string;
    missing?: boolean;
};
/**
 * The short site name of a yt-dlp extractor — the prefix knownVideo uses, so a
 * run's key is the same whether it came from the URL or from the probe:
 * "YoutubeTab" → youtube, "TwitchVod" → twitch, "Twitter" → x, "TedTalk" →
 * ted, "Generic" → web.
 */
declare function siteOf(extractor: string): string;
/** Project yt-dlp's info JSON onto VideoMeta. Undefined when it is not a single video. */
declare function videoMetaFromInfo(info: Record<string, unknown>, sourceUrl?: string): VideoMeta | undefined;
/** Read one video's metadata. Never throws: a failure is a reason. */
declare function probeVideo(url: string, run?: VideoRunner, signal?: AbortSignal, knownOnly?: boolean): Promise<VideoProbe>;
/**
 * yt-dlp's failure, said the way a reader can act on it. The order matters:
 * YouTube's own wording names the most specific cause, and a 403 is the least
 * specific of them.
 */
declare function classifyYtdlpError(stderr: string): string;
/**
 * One subtitle track, as WebVTT text. Fed the probe's own JSON through
 * `--load-info-json`, so the page is not extracted a second time.
 */
declare function downloadSubtitle(info: string, lang: string, auto: boolean, run?: VideoRunner, signal?: AbortSignal, knownOnly?: boolean): Promise<{
    vtt: string;
} | {
    error: string;
}>;
/** yt-dlp's version, and how many days old that release is. Undefined when it is not installed. */
declare function ytdlpVersionAge(run?: VideoRunner, now?: number): Promise<{
    version: string;
    ageDays?: number;
} | undefined>;

/** One timed piece of transcript, in seconds from the start of the video. */
interface VideoSegment {
    start: number;
    end: number;
    text: string;
}
/**
 * The cues of a WebVTT (or SRT) file, tags stripped and entities decoded. On a rolling
 * track (auto-captions) each cue opens by repeating what the previous one
 * showed; those leading lines are dropped, and a line that continues the last
 * one keeps only what it adds — while a line said twice on purpose ("no no",
 * a chorus) is kept. `rolling` defaults to what the file looks like: word-timing
 * tags give an auto track away. Empty for anything that is neither WebVTT nor SRT.
 */
declare function parseVtt(src: string, opts?: {
    rolling?: boolean;
}): VideoSegment[];
/**
 * Cues merged into segments of one to three sentences: a segment closes after
 * its third sentence, or on a sentence end once it holds a couple of lines'
 * worth of words. It never spans more than 30 s — which is what bounds an
 * unpunctuated auto-caption stream — nor a pause of more than 5 s, nor any
 * of `breaks` (chapter starts, in seconds).
 */
declare function mergeSegments(cues: VideoSegment[], breaks?: number[]): VideoSegment[];

/** Videos this process may still transcribe. */
declare function whisperBudgetLeft(): number;
/** The whisper model to ask for: `<PREFIX>_WHISPER_MODEL`, else `small`. */
declare function whisperModel(): string;

type VideoTranscriberId = "manual-subs" | "auto-subs" | "whisper";
declare const VIDEO_TRANSCRIBERS: VideoTranscriberId[];
interface VideoTranscript {
    /** The transcript as plain text, one segment per line. Empty when every rung failed. */
    text: string;
    segments: VideoSegment[];
    chapters: VideoChapter[];
    /** Absent only when yt-dlp could not read the video at all. */
    meta?: VideoMeta;
    /** Which rung produced the transcript. */
    via?: VideoTranscriberId;
    /**
     * The subtitle track it was read from (`en`, `fr`, `en-orig`). A manual
     * track in another language than the video's is a translation, and a reader
     * quoting it must know.
     */
    track?: string;
    /** Why there is no transcript, when there is none. */
    reason?: string;
}
/** What the ladder shells out through. Injected by tests; the defaults run the real tools. */
interface VideoDeps {
    run: VideoRunner;
    have: (cmd: string) => boolean;
}
interface VideoLadderOptions {
    /** The preferred subtitle language (`fr`, `en-US`). Defaults to the video's own. */
    lang?: string;
    /** Restrict or reorder the rungs. Defaults to `<PREFIX>_VIDEO_ENGINES`, else all three. */
    engines?: VideoTranscriberId[];
    deps?: Partial<VideoDeps>;
    /** Stops the ladder, and kills whichever command it is running. */
    signal?: AbortSignal;
    /**
     * Read only the video hosts `knownVideo` recognises (YouTube, Vimeo,
     * Dailymotion…), not any http(s) URL. Off by default: an explicit request
     * for a video's transcript may name any page yt-dlp can read.
     */
    knownHostsOnly?: boolean;
    /** The probe of this very URL, already made (see probeVideo): the page is not extracted a second time. */
    probed?: {
        meta: VideoMeta;
        info: string;
    };
}
/** Test seam: the runner and `have` every later call uses by default; no argument restores the real tools. */
declare function setVideoDeps(deps?: Partial<VideoDeps>): void;
/** Test seam: forget which rungs were found missing, and refill the whisper budget. */
declare function resetVideoLadderCache(): void;
/** The rungs to try: an explicit list, else `<PREFIX>_VIDEO_ENGINES` (a comma list, or `none`), else all. */
declare function enabledTranscribers(engines?: VideoTranscriberId[]): VideoTranscriberId[];
/**
 * Whether a transcript is worth citing: not empty, and for a video over a
 * minute at least 5 words a minute. The bar judges emptiness, not eloquence —
 * it is there so a music video's three captioned lines fall through to
 * whisper instead of passing for its transcript.
 */
declare function assessTranscript(segments: VideoSegment[], duration?: number): {
    ok: true;
} | {
    ok: false;
    reason: string;
};
/**
 * A video's transcript — YouTube, or any site yt-dlp reads — from the first
 * rung whose output passes the quality gate. Never throws: every failure is a
 * `reason`.
 *
 * Only an http(s) URL is read, and it always reaches yt-dlp after `--`, so no
 * caller's string can be taken for an option. A known host's URL is rebuilt
 * from its id first (a YouTube watch URL, Vimeo's player).
 */
declare function transcribeVideo(url: string, opts?: VideoLadderOptions): Promise<VideoTranscript>;

/** Seconds as `mm:ss`, or `h:mm:ss` past an hour. */
declare function formatStamp(seconds: number): string;
/** The transcript as Markdown: header, chapters, stamped paragraphs. Empty when there is no transcript. */
declare function transcriptMarkdown(t: VideoTranscript): string;

/** Where video runs live: `--out`, else `<PREFIX>_VIDEO_DIR`, else `<tmp>/<brand>/video`. */
declare function videoRoot(out?: string): string;
/** meta.json: the video's metadata plus how and when its transcript was made. */
interface VideoRunMeta extends VideoMeta {
    via: VideoTranscriberId;
    /** The subtitle track read (`en`, `fr`, `en-orig`); absent for whisper. */
    track?: string;
    /** The language the caller asked for, when it asked. */
    lang?: string;
    fetchedAt: string;
}
type VideoRunResult = {
    ok: true;
    id: string;
    dir: string;
    transcript: string;
    reused: boolean;
    meta: VideoRunMeta;
    segments: number;
    /** The transcript itself, when nothing was written (NO_WRITE): `transcript` then names a file that does not exist. */
    markdown?: string;
} | {
    ok: false;
    id?: string;
    reason: string;
};
/** A run already on disk: its metadata and segments, or undefined when either is missing or unreadable. */
declare function readVideoRun(dir: string): {
    meta: VideoRunMeta;
    segments: VideoSegment[];
} | undefined;
/**
 * Read a video into `<root>/<key>/` — the YouTube id, else `<site>-<id>` —
 * or reuse the run already there —
 * unless `refresh`, or the run was read in another language than `lang` asks.
 * Never throws: a video with no transcript, or a run that cannot be written,
 * comes back as a reason.
 *
 * meta.json is written last, so a run cut short is never taken for a whole
 * one. Under NO_WRITE nothing is written, and nothing is collected either —
 * the transcript comes back in `markdown`: a long-lived MCP server would
 * otherwise keep every transcript it ever read in memory.
 */
declare function fetchVideoRun(url: string, root: string, opts?: VideoLadderOptions & {
    refresh?: boolean;
}): Promise<VideoRunResult>;
/** One passage a search found: where it is, a link that opens the video there, and its text. */
interface VideoHit {
    /** `V1`… when the directory is a corpus, else the run key. */
    label: string;
    /** The run key: the YouTube id, else `<site>-<id>`. */
    videoId: string;
    title: string;
    chapter?: string;
    /** Where the words that answer begin: the passage's best-matching segment, not the passage's own start. */
    start: number;
    stamp: string;
    url: string;
    /** The whole passage, for context. */
    text: string;
    score: number;
}
/** The runs under a directory, in a stable order: the directory itself when it is one run, else its children that are. */
declare function listVideoRuns(dir: string): {
    dir: string;
    meta: VideoRunMeta;
    segments: VideoSegment[];
}[];
/** A corpus directory's V# labels (from its corpus.json), keyed by video id; empty for any other directory. */
declare function corpusLabels(dir: string): Map<string, string>;
/**
 * Search the transcripts under `dir` — one run, or every run in it — for a
 * question: ~45 s passages ranked by BM25F, chapter titles weighted as
 * headings. Each hit is labelled with its video's V# when `dir` is a corpus
 * (see fetchVideoCorpus), or `labels` says so; with its id otherwise.
 */
declare function searchVideoRuns(dir: string, query: string, opts?: {
    limit?: number;
    labels?: Map<string, string>;
}): VideoHit[];

/** Why a frame was taken: a scene change, a chapter start, or — for a video with neither — a regular interval. */
type FrameKind = "scene" | "chapter" | "interval";
/** One kept frame, with the transcript around it. */
interface VideoFrame {
    /** Path relative to the run directory: `frames/0003_01-23.jpg`. */
    file: string;
    time: number;
    stamp: string;
    kind: FrameKind;
    chapter?: string;
    /** The segments spoken from 5 s before the frame to 10 s after, stamped. */
    text: string;
}

/** How many frames each effort keeps at most. */
declare const FRAME_EFFORT: {
    readonly low: 20;
    readonly med: 50;
    readonly high: 100;
};
type FrameEffort = keyof typeof FRAME_EFFORT;
type FramesResult = {
    ok: true;
    dir: string;
    markdown: string;
    frames: VideoFrame[];
    candidates: number;
    duplicates: number;
    effort: FrameEffort;
} | {
    ok: false;
    reason: string;
};
/**
 * Extract the frames of a video already fetched into `runDir` (see
 * fetchVideoRun). Never throws: a missing tool or a failed download is a reason.
 */
declare function extractFrames(runDir: string, opts?: {
    effort?: FrameEffort;
    deps?: Partial<VideoDeps>;
    signal?: AbortSignal;
    /** The video's URL, as the caller approved it; else the page the run was read from. */
    url?: string;
    /** Only the known video hosts, and never yt-dlp's catch-all extractor (an MCP policy). */
    knownHostsOnly?: boolean;
}): Promise<FramesResult>;

/** One video a listing names. */
interface ListedVideo {
    /** The site's id for it. */
    id: string;
    /** Its run key, when its URL gives one (every YouTube video does). */
    key?: string;
    title: string;
    duration?: number;
    url: string;
}
/**
 * The first `limit` videos of a playlist or channel, without reading any of
 * them. Never throws: a URL that names no list, or a refusal, is an error.
 */
declare function listVideos(url: string, opts?: {
    limit?: number;
    deps?: Partial<VideoDeps>;
    signal?: AbortSignal;
    knownHostsOnly?: boolean;
}): Promise<{
    title?: string;
    videos: ListedVideo[];
} | {
    error: string;
}>;
/** One row of a corpus: V#, and the run it points at or why there is none. */
interface CorpusVideo {
    label: string;
    id: string;
    title: string;
    duration?: number;
    via?: string;
    dir?: string;
    reused?: boolean;
    reason?: string;
}
interface VideoCorpus {
    source: string;
    title?: string;
    createdAt: string;
    videos: CorpusVideo[];
}
type CorpusResult = {
    ok: true;
    dir: string;
    corpus: string;
    videos: CorpusVideo[];
    title?: string;
} | {
    ok: false;
    reason: string;
};
/** CORPUS.md: the V1…Vn table an answer cites from. */
declare function corpusMarkdown(c: VideoCorpus, root: string): string;
/**
 * Read a playlist or channel into `root`: every listed video kept as its own
 * run (an existing one reused), then CORPUS.md and corpus.json naming them
 * V1…Vn in listing order. A video that cannot be read keeps its label, with
 * the reason, so the numbering never shifts under an answer.
 */
declare function fetchVideoCorpus(url: string, root: string, opts?: VideoLadderOptions & {
    limit?: number;
    refresh?: boolean;
    onVideo?: (done: number, total: number, title: string) => void;
}): Promise<CorpusResult>;

interface WsOptions {
    /** Handshake budget (default 10 s). */
    connectTimeoutMs?: number;
    /** How long `close()` waits for the peer before dropping the socket (default 2 s). */
    closeTimeoutMs?: number;
    /** Largest message accepted, fragments included (default 64 MiB). */
    maxMessageSize?: number;
}
/**
 * An open connection. Events: `'message'` (string), `'close'` ({ code, reason },
 * emitted once) and `'error'` (Error, followed by `'close'`).
 */
declare class WsClient extends EventEmitter {
    private readonly socket;
    private readonly parser;
    private readonly max;
    private readonly closeTimeoutMs;
    private fragments;
    private fragmentBytes;
    private started;
    private closing;
    private done;
    constructor(socket: Socket, opts?: WsOptions, head?: Buffer);
    send(text: string): void;
    /** Send a close frame, then wait (bounded) for the peer to answer or hang up. */
    close(code?: number, reason?: string): Promise<void>;
    /** Drop the socket without a closing handshake. */
    terminate(): void;
    private writeClose;
    private feed;
    private deliver;
    /** Handle one frame; returns the text of a message it completed. */
    private onFrame;
    /** Protocol or socket failure: tell the peer why (when we can), surface the error, close. */
    private fail;
    private finish;
}

/** What the client needs from a socket; `WsClient` satisfies it, tests may inject their own. */
type CdpSocket = Pick<WsClient, "send" | "on" | "terminate"> & {
    close(code?: number, reason?: string): Promise<void> | void;
};
type CdpConnector = (url: string, opts: {
    timeoutMs: number;
}) => Promise<CdpSocket>;
interface CdpConnectOptions {
    timeoutMs?: number;
    /** Replaces the real WebSocket connector (tests). */
    transport?: CdpConnector;
}
interface CdpSendOptions {
    sessionId?: string;
    timeoutMs?: number;
}
interface CdpOnceOptions {
    predicate?: (params: any) => boolean;
    timeoutMs?: number;
    sessionId?: string;
}
type CdpHandler = (params: any) => void;
/** A client bound to one flat-mode session. */
interface CdpSession {
    readonly sessionId: string;
    send<T = unknown>(method: string, params?: object, opts?: {
        timeoutMs?: number;
    }): Promise<T>;
    on(method: string, handler: CdpHandler): void;
    off(method: string, handler: CdpHandler): void;
    once(method: string, opts?: Omit<CdpOnceOptions, "sessionId">): Promise<any>;
}
declare class CdpClient {
    private readonly ws;
    private nextId;
    private readonly pending;
    private readonly handlers;
    private readonly closeHandlers;
    private isClosed;
    private constructor();
    static connect(wsUrl: string, opts?: CdpConnectOptions): Promise<CdpClient>;
    get closed(): boolean;
    send<T = unknown>(method: string, params?: object, opts?: CdpSendOptions): Promise<T>;
    on(method: string, handler: CdpHandler, sessionId?: string): void;
    off(method: string, handler: CdpHandler, sessionId?: string): void;
    /** Resolve with the params of the next matching event; reject on timeout or when the socket closes. */
    once(method: string, opts?: CdpOnceOptions): Promise<any>;
    /** A view of this client bound to one session (`Target.attachToTarget({ flatten: true })`). */
    session(sessionId: string): CdpSession;
    /** Run `handler` once the connection is closed (at once if it already is). Returns its unsubscribe. */
    onClose(handler: () => void): () => void;
    /** Close the connection (the browser keeps running). */
    close(): Promise<void>;
    private onMessage;
    private onClosed;
}

type BrowserKind = "chrome" | "brave" | "chromium" | "edge";
interface BrowserBinary {
    kind: BrowserKind;
    path: string;
}
interface DetectOptions {
    /** Tried first, before the usual order. */
    prefer?: BrowserKind;
    /** This kind only: null when it is not installed, never another one instead. */
    kind?: BrowserKind;
    /** Reads `<PREFIX>_<suffix>`; defaults to the brand's own environment. */
    env?: (suffix: string) => string | undefined;
    /** The system environment (`PATH`, `ProgramFiles`, `LOCALAPPDATA`); defaults to `process.env`. */
    processEnv?: Record<string, string | undefined>;
    platform?: NodeJS.Platform;
    /** The home directory `~/Applications` is looked up in. */
    home?: string;
    /** Whether a path is a launchable file. */
    exists?: (path: string) => boolean;
}
/**
 * The browser to launch: `<PREFIX>_BROWSER_BIN` if set; else that `kind` only
 * (`<PREFIX>_BROWSER_KIND` when neither `kind` nor `prefer` is given); else
 * `prefer`, then Chrome, Brave, Chromium, Edge. `null` when none is installed.
 *
 * An explicit path that does not exist throws rather than falling through: a
 * user who named a binary and was handed a different one would drive the wrong
 * browser without knowing it.
 */
declare function detectBrowserBinary(opts?: DetectOptions): BrowserBinary | null;

interface BrowserVersion {
    Browser?: string;
    "Protocol-Version"?: string;
    "User-Agent"?: string;
    webSocketDebuggerUrl: string;
    [key: string]: unknown;
}
interface TargetInfo {
    id: string;
    type: string;
    title?: string;
    url: string;
    webSocketDebuggerUrl?: string;
    [key: string]: unknown;
}
interface CdpEndpoint {
    host: string;
    port: number;
    /** Set when the input was a `ws://` URL. */
    wsUrl?: string;
}
/** Throw unless `host` is a loopback name (127.0.0.1, ::1 or localhost). Returns it without brackets. */
declare function assertLoopback(host: string): string;
/**
 * A browser socket URL a DevTools endpoint handed back (/json/version, /json/new),
 * refused unless it is ws:// on loopback too: the HTTP hop being local says
 * nothing of where its answer points. Returned as given.
 */
declare function loopbackSocketUrl(wsUrl: string): string;
/** Accepts `9222`, `127.0.0.1:9222`, `http://localhost:9222`, `ws://[::1]:9222/devtools/browser/x`. */
declare function parseCdpEndpoint(input: string): CdpEndpoint;
/**
 * The address to dial for a loopback host. `localhost` is dialled as 127.0.0.1:
 * Node >= 17 keeps the resolver's order, which often puts ::1 first, while
 * Chrome's DevTools server listens on 127.0.0.1 only — so `localhost:9222`
 * would be refused against a browser that is plainly running.
 */
declare function dialHost(host: string): string;
declare function getVersion(port: number, host?: string): Promise<BrowserVersion>;
declare function listTargets(port: number, host?: string): Promise<TargetInfo[]>;
declare function listPages(port: number, host?: string): Promise<TargetInfo[]>;
/** Open a tab. Chrome >= 111 wants PUT; older and other builds only answer GET. */
declare function newTarget(port: number, url?: string, host?: string): Promise<TargetInfo>;
declare function closeTarget(port: number, id: string, host?: string): Promise<void>;
declare function activateTarget(port: number, id: string, host?: string): Promise<void>;
/** True when something answers DevTools on `port`. Never throws. */
declare function isPortAlive(port: number, host?: string): Promise<boolean>;

type discovery_BrowserVersion = BrowserVersion;
type discovery_CdpEndpoint = CdpEndpoint;
type discovery_TargetInfo = TargetInfo;
declare const discovery_activateTarget: typeof activateTarget;
declare const discovery_assertLoopback: typeof assertLoopback;
declare const discovery_closeTarget: typeof closeTarget;
declare const discovery_dialHost: typeof dialHost;
declare const discovery_getVersion: typeof getVersion;
declare const discovery_isPortAlive: typeof isPortAlive;
declare const discovery_listPages: typeof listPages;
declare const discovery_listTargets: typeof listTargets;
declare const discovery_loopbackSocketUrl: typeof loopbackSocketUrl;
declare const discovery_newTarget: typeof newTarget;
declare const discovery_parseCdpEndpoint: typeof parseCdpEndpoint;
declare namespace discovery {
  export { type discovery_BrowserVersion as BrowserVersion, type discovery_CdpEndpoint as CdpEndpoint, type discovery_TargetInfo as TargetInfo, discovery_activateTarget as activateTarget, discovery_assertLoopback as assertLoopback, discovery_closeTarget as closeTarget, discovery_dialHost as dialHost, discovery_getVersion as getVersion, discovery_isPortAlive as isPortAlive, discovery_listPages as listPages, discovery_listTargets as listTargets, discovery_loopbackSocketUrl as loopbackSocketUrl, discovery_newTarget as newTarget, discovery_parseCdpEndpoint as parseCdpEndpoint };
}

/** The slice of a child process the launcher uses. */
interface SpawnedProcess {
    pid?: number;
    kill(signal?: NodeJS.Signals | number): boolean;
    on(event: "exit", listener: (code: number | null, signal: NodeJS.Signals | null) => void): unknown;
    /** A binary that cannot be started emits this instead of "exit"; unheard, it would crash the process. */
    on(event: "error", listener: (err: Error) => void): unknown;
    unref(): void;
}
/** The slice of node:fs/promises the state and launch code use. */
interface BrowserFs {
    readFile(path: string, encoding: BufferEncoding): Promise<string>;
    writeFile(path: string, data: string | Uint8Array, opts?: {
        mode?: number;
    }): Promise<void>;
    rename(from: string, to: string): Promise<void>;
    mkdir(path: string, opts?: {
        recursive?: boolean;
        mode?: number;
    }): Promise<unknown>;
    rm(path: string, opts?: {
        recursive?: boolean;
        force?: boolean;
    }): Promise<void>;
    stat(path: string): Promise<{
        isFile(): boolean;
        isDirectory(): boolean;
        mtimeMs: number;
        size: number;
    }>;
    /** `open(path, "wx")` is how the lock file is created: it fails if the file exists. */
    open(path: string, flags: string, mode?: number): Promise<Pick<FileHandle, "writeFile" | "close">>;
}
interface BrowserDeps {
    spawn(cmd: string, args: string[], opts: SpawnOptions): SpawnedProcess;
    fs: BrowserFs;
    now(): number;
    sleep(ms: number): Promise<void>;
    connectCdp(wsUrl: string): Promise<CdpClient>;
    discovery: typeof discovery;
    /** Which browser to launch when no binary is named (`detectBrowserBinary`): of that `kind` only, when one is given. */
    detectBrowser(kind?: BrowserKind): BrowserBinary | null;
    /** Signal a process we launched in an earlier call, known only by its pid. */
    kill(pid: number, signal: NodeJS.Signals): void;
    /** Reads `WEBINDEX_<name>` (brand-aware), like the rest of the library. */
    env(name: string): string | undefined;
    platform: NodeJS.Platform;
}

interface LaunchOptions {
    /** An already-running browser: a port, `host:port` or URL (loopback only). */
    cdp?: string | number;
    /** Dedicated profile name; `default` when unset. */
    profile?: string;
    headless?: boolean;
    /** The browser binary; detected when unset. */
    binary?: string;
    /** The kind of browser to launch (`--browser-kind`); BROWSER_KIND, then the profile's own kind, when unset. */
    kind?: BrowserKind;
    /**
     * Never a saved browser this library did not launch (one `attach` or `--cdp`
     * named): the user lent it for the agent's session, not for reads in the
     * background. Ours is used, or launched, instead. An explicit `cdp` still wins.
     */
    ownOnly?: boolean;
    deps?: Partial<BrowserDeps>;
}
interface Endpoint {
    /** Loopback address to dial (never `localhost`, see `dialHost`). */
    host: string;
    port: number;
    /** True only for a browser this library started: only that one may be closed. */
    launchedByUs: boolean;
    /** True only from the call that started the browser: a reuse of one already running never says so. */
    spawned?: boolean;
    pid?: number;
    profile: string;
    headless: boolean;
    /** What the launch has to tell the user (extensions the browser will not load); only from the call that spawned it. */
    notes?: string[];
}

interface OpenOptions extends LaunchOptions {
    /** Work in a fresh tab instead of the one used last time. */
    newTab?: boolean;
    /** Navigate there once attached. */
    url?: string;
    /**
     * Work in a fresh tab that is nobody's: session.json is never written, so
     * the agent's current tab and tab ids stay as they were. The caller closes
     * the tab when done (a page read for `fetch`, see read.ts).
     */
    scratch?: boolean;
}
type WaitUntil = "load" | "domcontentloaded" | "none";
interface NavigateOptions {
    /** Which lifecycle event of the new document to wait for; `load` by default. */
    waitUntil?: WaitUntil;
    timeoutMs?: number;
}
interface NavigationResult {
    url: string;
    /** Identifies the document; refs taken on another one are stale. */
    loaderId: string;
    /** The HTTP status of the document, when the page exposes it. */
    status?: number;
    /** The new document committed but did not finish loading in time (see navigate). */
    note?: string;
}
interface BrowserTab {
    id: string;
    targetId: string;
    url: string;
    title: string;
    active: boolean;
}
interface BrowserStatus {
    alive: boolean;
    port?: number;
    launchedByUs?: boolean;
    profile?: string;
    headless?: boolean;
    targetId?: string;
    url?: string;
    title?: string;
    tabs?: BrowserTab[];
}
interface CloseOptions {
    /** Also wipe the refs and network logs of every tab, not only ours. */
    all?: boolean;
}
/** A JavaScript dialog as the page announces it (Page.javascriptDialogOpening). */
interface DialogEvent {
    type: string;
    message: string;
    url?: string;
}
/** Hears a dialog, with the page session that heard it: the one that can answer it. */
type DialogListener = (d: DialogEvent, page: CdpSession) => void;
declare class BrowserSession {
    /** The browser-level connection. */
    readonly cdp: CdpClient;
    private readonly endpoint;
    private readonly wsBrowserUrl;
    private readonly deps;
    /** A scratch tab's session: it saves nothing. */
    private readonly scratch;
    private tabs;
    private current;
    /** Targets closed by this session that /json/list may still report for a moment. */
    private readonly closed;
    /** Dialog listeners, each bound to the current tab's session and moved with it. */
    private readonly dialogListeners;
    private ended;
    /** @internal use openBrowserSession */
    constructor(
    /** The browser-level connection. */
    cdp: CdpClient, endpoint: Endpoint, wsBrowserUrl: string, deps: BrowserDeps, targetId: string, sessionId: string, tabs: Record<string, string>, 
    /** A scratch tab's session: it saves nothing. */
    scratch?: boolean);
    get port(): number;
    get host(): string;
    get launchedByUs(): boolean;
    /** Whether opening this session started the browser (not a reuse of one already running). */
    get spawned(): boolean;
    /** The browser-level socket URL: its path names this run of the browser and no other. */
    get browserSocket(): string;
    get pid(): number | undefined;
    get profile(): string;
    get headless(): boolean;
    /** What the launch had to say (extensions the browser will not load), once: the next call gets nothing. */
    takeNotes(): string[];
    get targetId(): string;
    get sessionId(): string;
    /** The current tab's flat session. It changes with selectTab/newTab/closeTab: read it, do not keep it. */
    get page(): CdpSession;
    /** Write session.json (port, ownership, current tab, tab ids). A no-op once shut down, and for a scratch tab. */
    save(): void;
    private frame;
    currentUrl(): Promise<string>;
    loaderId(): Promise<string>;
    title(): Promise<string>;
    /** The document's HTTP status from the Navigation Timing entry; undefined when the page does not say. */
    private responseStatus;
    private loaded;
    /**
     * Start recording navigation events BEFORE the command that causes them: the
     * browser may report the new document's lifecycle before it answers the
     * command itself, and an event listened for too late never comes again.
     */
    private watch;
    /**
     * Load `url` in the current tab and wait for the new document's `load` (or
     * `DOMContentLoaded`, or nothing). The tab's refs are cleared: they named
     * nodes of the document that is going away. A navigation the browser refuses
     * (`errorText`: DNS failure, refused connection…) rejects, and so does one
     * that did not even commit in time. One that committed but has not loaded
     * (a cold server, a render-blocking script that holds even DOMContentLoaded)
     * is the page now, still loading: it resolves, with a `note`.
     */
    navigate(url: string, opts?: NavigateOptions): Promise<NavigationResult>;
    /**
     * Run a history move or a reload and wait until the main frame shows another
     * document (or the same one, scrolled). One that committed but has not loaded
     * in time resolves with a `note`, as in navigate.
     */
    private settle;
    private history;
    back(opts?: {
        timeoutMs?: number;
    }): Promise<NavigationResult>;
    forward(opts?: {
        timeoutMs?: number;
    }): Promise<NavigationResult>;
    reload(opts?: {
        timeoutMs?: number;
    }): Promise<NavigationResult>;
    /** The browser's tabs with their stable short ids; the map is refreshed and saved. */
    listTabs(): Promise<BrowserTab[]>;
    /**
     * Hear the JavaScript dialogs of whichever tab is current, across tab
     * switches, each with the page session that can answer it. Returns its unsubscribe.
     */
    onDialog(listener: DialogListener): () => void;
    private hookDialogs;
    /** Move this session onto another tab: attach to it, let go of the old one, bring it to the front. */
    private switchTo;
    selectTab(id: string): Promise<BrowserTab>;
    /** Open a tab, make it current and, given a url, load it. */
    newTab(url?: string, opts?: NavigateOptions): Promise<BrowserTab>;
    /**
     * Close a tab and forget its refs and network log. Closing the current tab
     * moves to another one first; closing the last opens a blank one, since a
     * browser left with no tab may quit.
     */
    closeTab(id: string): Promise<void>;
    /** Close the socket only. The browser and its tabs keep running; the next call reconnects. */
    detach(): Promise<void>;
    /**
     * End the session. A browser we launched is closed (`Browser.close`, then
     * SIGTERM to its pid if it refuses); one we attached to is left running. Either
     * way session.json and our tabs' refs and network logs go (every tab's with `all`).
     */
    shutdown(opts?: CloseOptions): Promise<void>;
    status(): Promise<BrowserStatus>;
}
/**
 * Connect to the browser (attaching to, reusing or launching one by the launch
 * policy) and attach to a tab: a new one when asked (or a scratch one), else
 * the saved one if it still exists, else the first page, else a fresh one.
 */
declare function openBrowserSession(opts?: OpenOptions): Promise<BrowserSession>;

/**
 * Decode named and decimal/hex numeric character references, in ONE
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

/** When fetchAndExtract renders a page in the browser: every time, only when the built-in read fails, or never. */
type BrowserFetchMode = "always" | "fallback" | "off";

declare function looksLikeJunkExtraction(text: string): string | undefined;

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
    /** Retained response bytes, before character decoding. */
    bytesRead?: number;
    /** The name Content-Disposition gives the body, when it gives one — what a download route calls its file. */
    filename?: string;
    /** The body exceeded the cap; its retained prefix is incomplete. */
    truncated?: boolean;
    error?: string;
    /** Cache validators, kept so a stale entry can be revalidated for free. */
    etag?: string;
    lastModified?: string;
    /** True on an explicit 429, or a 403 that carries an exhausted quota header. */
    rateLimited?: boolean;
    /** Retry-After in ms, when the server sent one — its own number, not capped to what httpGet waits out. */
    retryAfterMs?: number;
    /**
     * The server answered, but only with redirects that lead nowhere this client
     * goes: more than 20 of them, or to a URL or a scheme it cannot fetch. Status
     * is 0 as for a failure, yet nothing failed to answer.
     */
    redirectFailed?: boolean;
}
/**
 * Resolve after `ms`, or as soon as `signal` aborts: early, and never with a
 * rejection — a caller that was cancelled only wants to stop waiting, and
 * checks its signal next.
 */
declare function sleep(ms: number, signal?: AbortSignal): Promise<void>;
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
    /** Network budget per attempt, in ms. Default `<PREFIX>_TIMEOUT_MS` (20 s); a timed-out attempt is not retried. */
    timeoutMs?: number;
    accept?: string;
    acceptLanguage?: string;
    maxBytes?: number;
    /** Optional larger cap for a response identified as a document by MIME.
     *  An explicit maxBytes always wins. */
    maxDocumentBytes?: number;
    userAgent?: string;
    binary?: boolean;
    /** Approve the initial URL and every redirect before network access. */
    authorizeUrl?: (url: string) => Promise<boolean>;
    /** Extra request headers, lower-cased. The escape hatch for conditional GET
     *  (`if-none-match`, `if-modified-since`) and for an API that wants auth. */
    headers?: Record<string, string>;
    /** Extra attempts on a transient failure, overriding `<PREFIX>_MAX_ATTEMPTS`.
     *  Per-call because the right number is per-endpoint: a probe wants 0, a
     *  paper download off a flaky mirror wants 2. */
    retries?: number;
    /** Told, BEFORE the wait, that a transient answer (429, 502–504) will be
     *  retried after `waitMs` — so a caller queueing other requests for that
     *  host (crawlSite) holds them for the same window instead of sending them
     *  into it while this one sleeps. */
    onBackOff?: (url: string, waitMs: number) => void;
    /** Abandons the request: an attempt in flight is aborted and none starts
     *  after. Reported as `error: "cancelled"`, never retried — the caller
     *  that cancelled is not waiting for a second try. */
    signal?: AbortSignal;
}): Promise<HttpResult>;
declare function httpJson(method: string, url: string, body?: unknown, opts?: {
    timeoutMs?: number;
    accept?: string;
    acceptLanguage?: string;
    userAgent?: string;
    headers?: Record<string, string>;
    retries?: number;
    /** Response cap in bytes; over it the transfer is cancelled and the call fails. Default 4 MB. */
    maxBytes?: number;
}): Promise<{
    ok: boolean;
    status: number;
    data: any;
    error?: string;
    bytesRead?: number;
    truncated?: boolean;
    /** Set when the call ended on `timeoutMs` — this caller's own deadline, not the server's failure. */
    timedOut?: boolean;
}>;

declare function cleanInline(s: string): string;
declare function htmlToText(html: string, opts?: {
    fullPage?: boolean;
}): string;
declare function htmlTitle(html: string): string | undefined;
declare function htmlCanonicalUrl(html: string): string | undefined;
/**
 * The main content region of `html`, or `html` itself when none is found with
 * confidence.
 *
 * Candidates are found and measured on the page WITHOUT its comments, scripts,
 * styles, templates and SVGs, and a region is returned from that cleaned page.
 * Inline scripts count as characters but are not text: a sidebar holding a chat
 * widget's JSON outscored the article, and a `__NEXT_DATA__` blob outside
 * `<main>` inflated the page until the size gate refused the real region.
 */
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
type ExtractorId = "native" | "firecrawl" | "pdf-inspector" | "pdftotext" | "anydoc" | "ocr" | "builtin" | "manual-subs" | "auto-subs" | "whisper" | "browser";
interface ExtractResult {
    text: string;
    consentDropped?: number;
    title?: string;
    note?: string;
    finalUrl: string;
    status: number;
    extractor?: ExtractorId;
    /** Document type detected from the URL or response, independent of converter. */
    documentType?: "pdf" | "doc" | "video";
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
    /** The response overran the byte cap, so `text` is a prefix of the page, not all of it. */
    truncated?: boolean;
    /** On a failed fetch: the origin throttled it (429, or a 403 with an exhausted quota). */
    rateLimited?: boolean;
    /**
     * On a failed fetch: how long the origin asked callers to wait (its
     * Retry-After, in ms), so a caller with a queue can back the whole host off
     * rather than learn the same answer once per URL.
     */
    retryAfterMs?: number;
}
declare function fetchAndExtract(url: string, opts?: {
    acceptLanguage?: string;
    firecrawl?: string;
    /** Extra request headers for the built-in path — how the cache sends
     *  `if-none-match` / `if-modified-since`. Firecrawl does its own fetching and
     *  ignores these, which is why a revalidating caller skips it. */
    headers?: Record<string, string>;
    /** Check the initial URL and each redirect; disables remote extraction. */
    authorizeUrl?: (url: string) => Promise<boolean>;
    /** Network budget for the built-in fetch, in ms (see httpGet). Firecrawl keeps its own. */
    timeoutMs?: number;
    /**
     * Drop consent-banner lines from the extracted text.
     *
     * Opt-in, and applied to the BUILT-IN extractor's HTML only. Never to
     * Firecrawl markdown: main-content extraction has already removed the
     * banner, so all the heuristic could still do there is damage — on a page
     * documenting HTTP cookies it would eat the article.
     */
    stripConsent?: boolean;
    /** Keep all page text through the built-in reader, bypassing isolation and consent filtering. */
    fullPage?: boolean;
    /**
     * `false` reads a video host's URL (YouTube, Vimeo…) as a page instead of
     * sending it to the transcript ladder.
     */
    video?: boolean;
    /**
     * The shape of an HTML page's text. "text" (the default) is htmlToText's:
     * headings kept as `#` lines, everything else flattened. "markdown" is
     * htmlToMarkdown's CommonMark, links and images absolute — the shape
     * Firecrawl returns, so the answer no longer depends on whether Firecrawl
     * ran. Firecrawl's own Markdown is used as it comes either way; PDFs and
     * office documents keep their extractors' text.
     */
    format?: "text" | "markdown";
    /**
     * Carry the raw HTML up in `html`. For a caller that follows links out of
     * the page it just read; see ExtractResult.html for why it is opt-in.
     */
    keepHtml?: boolean;
    /** Passed to httpGet: told before a transient answer is waited out and retried. */
    onBackOff?: (url: string, waitMs: number) => void;
    /**
     * Render the page in the dedicated browser (see src/browser/read.ts):
     * `always` for every web page, ahead of Firecrawl; `fallback` only when the
     * built-in read was refused (HTTP 0/401/403/429/503), came back a consent
     * or anti-bot wall, or found almost no text — the better read is kept.
     * `<PREFIX>_BROWSER_FETCH` by default; off unless set. Never with
     * `authorizeUrl`, and never for a PDF, an office document or a video.
     */
    browser?: BrowserFetchMode;
    /**
     * Abandons the fetch: the built-in request is aborted, and no extraction
     * ladder starts after it. A Firecrawl request already sent finishes — it is
     * short, and an aborted one would read to the probe as a Firecrawl that is
     * down, for every other caller too.
     */
    signal?: AbortSignal;
}): Promise<ExtractResult>;
/**
 * Read an HTML page the way fetchAndExtract reads one: main-content isolation
 * (unless `fullPage`), text or Markdown, consent lines dropped on request, and
 * the title, canonical URL and description off the whole page. `finalUrl` is
 * the address the HTML came from, which relative links and the canonical are
 * resolved against. For a caller that already holds the HTML — a page a
 * browser rendered — and wants the same text a fetch would have given.
 */
declare function extractFromHtml(html: string, finalUrl: string, opts?: {
    format?: "text" | "markdown";
    fullPage?: boolean;
    stripConsent?: boolean;
    keepHtml?: boolean;
}): Pick<ExtractResult, "text" | "consentDropped" | "title" | "canonical" | "metaDescription" | "html">;
declare const DEAD_LINK_STATUS: Set<number>;
declare function rescueViaWayback(url: string, opts?: {
    acceptLanguage?: string;
    firecrawl?: string;
    authorizeUrl?: (url: string) => Promise<boolean>;
}): Promise<{
    text: string;
    title?: string;
    snapshotUrl: string;
    timestamp: string;
} | undefined>;
/**
 * Drop consent-banner lines from extracted text, and say how many went.
 *
 * Deliberately conservative, because this must never quietly delete the
 * paragraph someone wanted to cite. A line goes when it is:
 *
 * - a known FR/DE button label, the whole line;
 * - button-length and either names two consent topics ("Accept all cookies")
 *   or names one next to a consent action ("Cookie settings");
 * - a notice in the banner's own voice ("We use cookies…", "By clicking…")
 *   that names a consent topic.
 *
 * Counting topic words alone is not enough on a longer line: an article about
 * the GDPR names two of them per sentence, and a recipe says "allow the cookies
 * to cool".
 *
 * `markdown` reads htmlToMarkdown's output: each line is judged by the text a
 * reader sees — a banner's "Accept all cookies" button is a link whose URL
 * would otherwise push it past button length — and fenced code and table rows
 * are never touched, since dropping a table's header row breaks the table.
 */
declare function stripConsentBoilerplate(text: string, opts?: {
    markdown?: boolean;
}): {
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

interface ReadPageOptions extends LaunchOptions {
    /** As fetchAndExtract's: the shape of the text. */
    format?: "text" | "markdown";
    fullPage?: boolean;
    stripConsent?: boolean;
    keepHtml?: boolean;
    /**
     * The whole render, from the moment a tab is free; BROWSER_TIMEOUT_MS
     * (30 s) by default. The tab is closed when it runs out.
     */
    timeoutMs?: number;
    /** Abandons the read, or the wait for a free tab. */
    signal?: AbortSignal;
    /**
     * `load` reads as soon as the page has loaded; `idle` then waits for a quiet
     * network for up to half the timeout. By default, load and up to 3 s of quiet.
     * Waiting for quiet is never fatal: a page that keeps polling is read anyway.
     */
    waitUntil?: "load" | "idle";
}
interface CloseReadsOptions {
    /** How long to wait for the reads still in flight in this process; 5 s by default. */
    waitMs?: number;
    /** The seams to close through; by default, the ones the launching read used. */
    deps?: Partial<BrowserDeps>;
}
/**
 * Close the browser that a read of this process launched, at the end of a
 * consumer's run: once the reads still in flight here are done (or after
 * `waitMs`), and only if the browser answering on its port is still that one
 * (`Browser.close`, then SIGTERM to its pid if it refuses). A browser the reads
 * only reused, one named with `cdp`, one an agent's session has taken over since,
 * or nothing launched at all: `{ closed: false }`, untouched. Reads of other
 * processes are not waited for. Never throws; a second call is a no-op.
 */
declare function closeBrowserReads(opts?: CloseReadsOptions): Promise<{
    closed: boolean;
}>;
/**
 * Render `url` in a scratch tab of the dedicated browser and extract it as
 * fetchAndExtract would have (`extractor: "browser"`; `status` is the main
 * document's HTTP status). Throws when the browser cannot be had or the page
 * cannot be loaded, when the read runs out of time, and when it is cancelled.
 */
declare function readRenderedPage(url: string, opts?: ReadPageOptions): Promise<ExtractResult>;

interface RefTable {
    /** Document the refs belong to; a navigation changes it and makes them stale. */
    loaderId: string;
    url: string;
    /** The number the next new ref gets (`e<next>`). */
    next: number;
    refs: Record<string, number>;
}

/** A CDP Accessibility.AXValue, reduced to what we read. */
interface AXValue {
    type?: string;
    value?: unknown;
}
/** A CDP Accessibility.AXNode, reduced to what we read. */
interface AXNode {
    nodeId: string;
    ignored?: boolean;
    role?: AXValue;
    name?: AXValue;
    value?: AXValue;
    properties?: {
        name: string;
        value: AXValue;
    }[];
    childIds?: string[];
    backendDOMNodeId?: number;
    parentId?: string;
}
interface RenderOptions {
    /** Only nodes that have a ref, flat (no indentation, no text, no `/url` lines). */
    interactive?: boolean;
    /** Cut the tree at a line boundary once it is longer than this (a first line longer than all of it is cut itself). No limit by default. */
    maxChars?: number;
    /** Render only the subtree of this node. */
    rootBackendId?: number;
    /** The refs seen so far; never mutated, an updated copy is returned. */
    refs: RefTable;
    /** Same-process iframe trees, keyed by the iframe's backendDOMNodeId as a string. */
    frames?: Record<string, AXNode[]>;
    /** The backendDOMNodeIds of the overlays over the page: rendered first, each under its own header. Ignored with rootBackendId. */
    overlays?: number[];
}
interface RenderResult {
    text: string;
    refs: RefTable;
    truncated: boolean;
    /** Refs visible in `text`. */
    refCount: number;
}
/**
 * Render AX nodes as a compact text tree (2 spaces per level, one node per line),
 * giving refs to what an agent can act on. In `interactive` mode only the nodes
 * with refs are printed, flat; no landmark context is added, to keep it cheap.
 */
declare function renderSnapshot(nodes: AXNode[], opts: RenderOptions): RenderResult;
interface SnapshotOptions {
    interactive?: boolean;
    maxChars?: number;
    /** Render only this ref's subtree. */
    ref?: string;
}
interface SnapshotResult {
    text: string;
    url: string;
    title: string;
    loaderId: string;
    refCount: number;
    truncated: boolean;
}

type ChallengeKind = "datadome" | "cloudflare" | "recaptcha" | "hcaptcha" | "arkose" | "perimeterx" | "akamai" | "imperva" | "generic";
interface Challenge {
    kind: ChallengeKind;
    /** A full-page interstitial the page cannot be used through, as opposed to a widget inside a normal page. */
    blocking: boolean;
    /** What matched, for the agent and the logs. */
    signals: string[];
}
interface ChallengeSignature {
    url: string;
    title: string;
    /** The first ~4 KB of `document.body.innerText`. */
    text?: string;
    frameUrls?: string[];
    scriptUrls?: string[];
    /** Names (never values) of the cookies script can see. */
    cookieNames?: string[];
    /** Which of CHALLENGE_SELECTORS matched an element. */
    selectors?: string[];
    /** The document's HTTP status, when the page exposes it. */
    status?: number;
}
/**
 * Decide from a probe whether the page is, or carries, an anti-bot challenge.
 * `blocking` separates an interstitial (vendor interstitial title or frame,
 * status 403/429/503, almost no text) from a widget inside a normal page (a
 * reCAPTCHA checkbox on a login form).
 */
declare function classifyChallenge(sig: ChallengeSignature): Challenge | null;

/**
 * Where the browser keeps its state: `<PREFIX>_BROWSER_DIR`, then the brand's
 * declared `browserDir`, then `~/.<name>/browser`.
 */
declare function browserHome(): string;

interface NetworkEntry {
    /** 1-based and stable within the log file. */
    n: number;
    /** ISO time the response finished. */
    at: string;
    method: string;
    url: string;
    status: number;
    mime: string;
    resourceType: string;
    /** The request's postData, cut to 4 KiB. */
    requestBody?: string;
    /** Body size in bytes (the wire size when the body was not fetched). */
    size: number;
    json?: unknown;
    text?: string;
    bodyTruncated?: boolean;
    error?: string;
}

interface DialogInfo {
    /** "alert", "confirm", "prompt" or "beforeunload". */
    type: string;
    message: string;
    /** The CLI dismissed it before its command ended: it is no longer open. */
    dismissed?: boolean;
    /** Someone closed it in the window before the CLI could dismiss it. */
    closed?: boolean;
}
interface ActionResult {
    ok: true;
    action: string;
    ref?: string;
    /** The main frame loaded another document because of the action. */
    navigated: boolean;
    url: string;
    title: string;
    /** A dialog the action opened; it is still open. */
    dialog?: DialogInfo;
    /** An anti-bot challenge on the page after the action; null when none. */
    challenge?: Challenge | null;
    value?: unknown;
    /** The page the move landed on committed but was still loading when the wait ran out. */
    note?: string;
}

declare const PDF_INSPECTOR_SPEC = "@firecrawl/pdf-inspector@1";
declare const ANYDOC_SPEC = "@firecrawl/anydoc@0.1";
interface RunResult {
    ok: boolean;
    stdout: string;
    /** Short cause when `ok` is false: "not installed", "timed out", "exit 2"… */
    error?: string;
    /** What the tool wrote to stderr — its first and last ~1 KB — when `ok` is false and it wrote any. */
    stderr?: string;
}
/**
 * Spawn `cmd args…`, write `input` to its stdin, resolve with its stdout.
 * Never throws and never leaves a child behind: a missing binary, a non-zero
 * exit and a timeout all come back as `{ ok: false, error }` — with the tail
 * of stderr, when the tool wrote one, so a caller can say WHY.
 */
declare function runWithInput(cmd: string, args: string[], input: Buffer, timeoutMs: number, opts?: {
    env?: NodeJS.ProcessEnv;
}): Promise<RunResult>;

interface MarkdownOptions {
    /**
     * The address the HTML came from. Links and images resolve against it — or
     * against the page's own `<base href>`, itself resolved against this — so
     * every URL in the output is absolute. Without either, a relative URL is
     * kept as written.
     */
    baseUrl?: string;
    /** Keep navigation, footers and ARIA chrome, as htmlToText's `fullPage` does. */
    fullPage?: boolean;
}
/**
 * A page as CommonMark: headings, paragraphs, links and images with absolute
 * URLs, emphasis, inline code, fenced code blocks (verbatim, with the language
 * a `language-x`, `lang-x` or `highlight-x` class names), ordered, unordered
 * and nested lists, blockquotes, rules, and tables as GFM tables.
 *
 * Drops what htmlToText drops — scripts, styles, forms' option lists, and the
 * page chrome unless `fullPage` — and escapes the text's own Markdown
 * metacharacters, so a literal `*` or `[1]` does not become syntax. Pass the
 * main-content region (extractMainHtml) for an article rather than a page.
 */
declare function htmlToMarkdown(html: string, opts?: MarkdownOptions): string;

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
 * An "up" verdict is sticky for the process and a "down" one lasts 30 s, so
 * the whole cost of an absent Firecrawl is one refused connection per burst of
 * calls. That is right in production and wrong across test cases, where one
 * case's verdict would silently decide the next case's behaviour. Mirrors
 * resetOcrBudget, resetPdfLadderCache and resetDocLadderCache.
 */
declare function resetFirecrawlProbeCache(): void;
/**
 * Record that `base` stopped answering, so the calls that follow skip it.
 *
 * An "up" verdict is trusted for the process — which is right for "it is
 * there" and wrong for "the container died at page 4 of 40". A caller that
 * sees a request fail with no status knows something the memoised verdict does
 * not, and without this every remaining page pays the timeout again. Like any
 * "down" verdict it expires, so an instance that comes back is found again.
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
 * that masks the root. Connection refused / timeout ⇒ down. Memoised — "up"
 * for the process, "down" for 30 s — so the whole cost of an absent Firecrawl is
 * one refused connection per burst of calls. Never throws.
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
    /** The URL Firecrawl was asked for (`metadata.sourceURL`, else `metadata.url`). */
    sourceURL?: string;
    /** Where the page ended up after redirects (`metadata.url`, else `sourceURL`) — the address to cite. */
    finalUrl?: string;
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
/** What `searchViaFirecrawl` may be told besides the base. */
interface FirecrawlSearchOptions extends FirecrawlOptions {
    /** BCP-47 language tag. Sent as Firecrawl's `lang`, with the `country` it implies; without one Firecrawl answers in US English. */
    lang?: string;
    /** A country code overriding the one `lang` implies; "wt" names none. */
    region?: string;
    /** The most this call may take, in ms: its request's timeout is the smaller of this and 30 s. */
    budgetMs?: number;
}
/**
 * Query Firecrawl's keyless `/search` (Fire-Engine → SearXNG → DuckDuckGo
 * internally). Returns the `web` hits, or a reason.
 */
declare function searchViaFirecrawl(query: string, limit: number, opts?: FirecrawlSearchOptions): Promise<{
    hits?: FirecrawlHit[];
    why?: string;
    /** When it produced no hit list: the HTTP status that ended it, 0 when nothing answered. Absent when disabled. */
    status?: number;
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
 *
 * Pass the term as written: a French or German stopword in capitals is an
 * English acronym (MIT, DAS, IM) and is not one.
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
 *
 * A slug that had to drop letters (anything outside ASCII) or be cut at `max`
 * ends in eight hex digits of a hash of the whole input. Without them
 * `file:///srv/git/项目` and `file:///srv/git/文档` were both `file-srv-git`,
 * and the second repository was handed the first one's checkout. An ASCII
 * input that fits keeps its readable name as it always had.
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
 * FNV-1a 64 of the concatenation of `pieces`, as two 32-bit words written to
 * `out[0]` (high) and `out[1]` (low). Same value as `fnv1a64(pieces.join(""))`
 * without building the string or the BigInt — the form simhash needs, once per
 * shingle.
 */
declare function fnv1a64Words(pieces: readonly string[], out: Uint32Array): void;

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
 *
 * An item counts ONCE per list, at its best rank, as in Cormack et al. Callers
 * key by canonical URL or DOI, so tracking-param variants, pagination overlap
 * and abs/pdf twins inside one engine's list share a key — summed, one engine
 * repeating a URL counted as much as two engines agreeing on it.
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
 * that carries the DOI in its path (`dl.acm.org/doi/…`, `/doi/full/…`,
 * `link.springer.com/article/10.1007/…`, bioRxiv's `/content/10.1101/…v1`) or
 * its query (PLOS's `?id=10.1371/…`). Returned normalised, so a DOI-in-path
 * collapses with a bare one.
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
 * Shares `foldTerm`, `isStopword` and `subtokens` with `buildMatcher`, which is
 * the point: two scorers that disagree about whether "requests" and "request"
 * — or "RateLimiter" and "rate limiter" — are the same term will disagree about
 * relevance for reasons nobody can debug. An identifier therefore yields its
 * whole folded form AND its inner words (`subtokens: false` keeps the whole
 * form only).
 *
 * Chinese and Japanese, written without spaces, come back as overlapping
 * character bigrams; a lone ideograph is kept as a unigram.
 */
declare function bm25Tokenize(text: string, opts?: {
    subtokens?: boolean;
}): string[];
/**
 * Build the index over the candidate pool — the pool IS the corpus, so IDF is
 * relative to what was actually retrieved.
 *
 * Below three documents IDF is too noisy to mean anything, so it degrades to
 * uniform (pure TF). A three-result pool where one term happens to be missing
 * from two of them would otherwise assign that term a huge weight on no evidence.
 *
 * `tokensOf` supplies a body's tokens, exactly as `bm25Tokenize(doc.body)`
 * returns them, when the caller already has them — so a pipeline that also
 * hashes and diversifies the same bodies tokenises each one once.
 */
declare function buildBm25Index(question: string, docs: readonly Bm25Doc[], opts?: {
    k1?: number;
    b?: number;
    tokensOf?: (doc: Bm25Doc) => readonly string[];
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
 *
 * `tokens` hashes words the caller already has instead of tokenising `text`
 * again — a pipeline that indexed a document need not read it a second time.
 * Only hashes built from the same kind of tokens are comparable.
 */
declare function simhash(text: string, opts?: {
    tokens?: readonly string[];
}): bigint;
/**
 * How many bits two SimHashes differ by.
 *
 * The 64 bits a SimHash actually has are counted with two 32-bit popcounts, and
 * that is the whole answer for every value `simhash` produces. Anything above
 * 64 bits then falls through to the bit-clearing loop rather than being
 * silently dropped: this is an exported function, a caller may hold a wider
 * bigint, and answering "0 differing bits" for two values that differ is worse
 * than the 3 ns the guard costs.
 */
declare function hammingDistance(a: bigint, b: bigint): number;
/**
 * Collapse near-duplicate items by SimHash over their text, keeping the
 * best-scored copy. Items shorter than `minChars` carry too little signal and
 * are never collapsed. Expects best-first input and preserves that order.
 *
 * `duplicates` names each dropped URL and the kept one it duplicated: a mirror
 * is an alternate citation, and the evidence when a collapse was wrong.
 *
 * `tokensOf` hands over words the caller already tokenised (see `simhash`), so
 * a pipeline reads each text once.
 */
declare function dedupeNearDuplicates<T extends Ranked>(items: readonly T[], opts?: {
    maxBits?: number;
    minChars?: number;
    tokensOf?: (it: T) => readonly string[];
}): {
    items: T[];
    dropped: number;
    duplicates: {
        url: string;
        of: string;
    }[];
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
 * diversity breaks ties and demotes redundancy rather than promoting noise —
 * and every item scoring above zero is placed before any item that does not.
 *
 * MMR is quadratic in the pool. `window` bounds it: only the `window` most
 * relevant items are diversified, and the rest follow in relevance order — the
 * top of a long list is where diversity is read, and a 2 000-document pool then
 * costs what a `window`-sized one does.
 */
declare function diversify<T extends Ranked>(items: readonly T[], tokensOf: (it: T) => Iterable<string>, lambda?: number, opts?: {
    window?: number;
}): T[];
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
 *   3. an arXiv id, 4. a PMID, 5. a PMC id.
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
declare function searxngLanguage(lang: string | undefined, region?: string): string | undefined;
declare function acceptLanguageHeader(lang: string | undefined, region?: string): string;

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
    /** The HTTP status of a request that failed — 0 when it got no answer at all. */
    status?: number;
    /** When a spent quota resets, as the forge stated it (ISO 8601). */
    resetAt?: string;
}
interface ForgeOptions {
    /**
     * Override the API base — a self-hosted GitLab, or GitHub Enterprise. Naming
     * it is also what sends the forge's token there: the calling code chose this
     * host, which a repository string alone never proves.
     */
    apiBase?: string;
    /**
     * Which forge the host runs, for a self-hosted one whose name does not say
     * (salsa.debian.org is a GitLab). It picks the API to ask and nothing else: a
     * token still goes only where `forgeAuthHeaders` allows.
     */
    kind?: ForgeKind;
    limit?: number;
    timeoutMs?: number;
    /**
     * searchIssues: when every term together matches nothing, search once more
     * with the most distinctive half of them, and say so in the note. Default on;
     * `false` keeps a search to exactly one request.
     */
    relax?: boolean;
    /**
     * Approve each URL before it is requested — the API URL and every redirect it
     * leads to — as `httpGet`'s hook of the same name does. A refusal is a failed
     * answer (status 0, "URL not authorized") and is not retried. The client
     * follows its redirects itself, so this is the only place a caller sees where
     * they go: a public-only server needs it, or a public host's 302 walks the
     * client into the machine's own network.
     */
    authorizeUrl?: (url: string) => Promise<boolean>;
}
/**
 * Which forge a host is: `opts.kind` when the caller says, then a host declared
 * in `<PREFIX>_FORGE_HOSTS`, then the host's shape. Unknown hosts get no client.
 */
declare function forgeKind(host: string, opts?: Pick<ForgeOptions, "kind">): ForgeKind | undefined;
/**
 * The ref a forge can answer for. A local checkout stands for its `origin`
 * remote — `webindex repo .` means the project this directory is a clone of —
 * with any credential in that URL dropped, since the ref travels into output. A
 * checkout with no origin, and every other ref, comes back as it was.
 */
declare function forgeRef(ref: RepoRef, opts?: Pick<ForgeOptions, "kind">): RepoRef;
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
/**
 * Auth headers when a token is in the environment; none when it is not.
 *
 * Given the `host` a request goes to, a token comes back only for a host it
 * belongs to (see `TOKEN_HOSTS`). Without one this answers by kind alone, as it
 * always has — for a caller that decides where the header goes itself.
 *
 * Every token travels in `Authorization`, GitLab's included (it accepts a
 * personal token as a Bearer): that is the header a runtime drops on a
 * cross-origin redirect, where a custom `private-token` sailed through.
 */
declare function forgeAuthHeaders(kind: ForgeKind, host?: string): Record<string, string>;
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
 * relevance, and it does so only when left to its default order: terms are
 * best-match first, a listing with no terms most recently updated first. GitLab
 * and Gitea have no such endpoint, so they get a scoped list filtered by search
 * terms, which is why their `score` is absent: they are ordered by recency and
 * saying otherwise would be a lie the caller might rank on.
 *
 * Every term must match, so a natural five-word description often matches
 * nothing. Then — unless `relax: false` — it searches once more with the most
 * distinctive half of the words (qualifiers such as `label:bug` kept), and the
 * note says so: a looser answer must never pass for the one asked for.
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
/** `repoFacts`, with the reason when there are none. */
interface RepoFactsResult {
    facts?: RepoFacts;
    /** Why there are no facts, in words a caller can show. */
    note?: string;
    /** The HTTP status of the answer — 0 when there was none; absent when nothing was asked. */
    status?: number;
    rateLimited?: boolean;
    /** When a spent quota resets, as the forge stated it (ISO 8601). */
    resetAt?: string;
}
/**
 * The repository's own metadata — stars, licence, homepage, whether it is
 * archived.
 *
 * Worth having for a reason beyond curiosity: "is this project maintained" is
 * otherwise answered by reading a README that says it is. `archived` and
 * `pushedAt` answer it from the record.
 *
 * Undefined for any failure; `repoFactsResult` says which one it was.
 */
declare function repoFacts(ref: RepoRef, opts?: ForgeOptions): Promise<RepoFacts | undefined>;
/**
 * `repoFacts`, and when it has none, why: no such repository, a rejected token,
 * a quota (with its reset time), an outage, or no network at all. Each wants a
 * different response, and all of them used to arrive as the same `undefined`.
 */
declare function repoFactsResult(ref: RepoRef, opts?: ForgeOptions): Promise<RepoFactsResult>;

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
 * A URL copied from a browser names its repository, not the page within it.
 * `opts.kind` says which forge a self-hosted host runs, where its name does not.
 * `opts.local: false` reads the string as a remote only, without asking the
 * filesystem whether it names a directory — for a caller (a server others can
 * reach) whose answer must not say what exists on the machine.
 *
 * An unrecognisable seed becomes a `generic` ref with NO synthesised clone URL.
 * That matters: minting `https://github.com/<free text>.git` would turn "some
 * words the user typed" into a plausible-looking URL that 404s later, far from
 * where the mistake was made.
 */
declare function resolveRepo(raw: string, opts?: {
    kind?: ForgeKind;
    local?: boolean;
}): RepoRef;
/**
 * A working tree for `ref`, cloned if needed, returned as an absolute path.
 *
 * Shallow and blobless by default (`--depth 1 --filter=blob:none`): reading a
 * repository's current state does not need its history or every past version of
 * every file, and on a large project that is the difference between seconds and
 * minutes. `ensureHistoryDepth` deepens it when a caller genuinely needs history.
 *
 * Never throws for a reason the caller cannot act on — a missing `git` says so
 * rather than reporting a clone failure, and a refresh that could not reach the
 * remote says so rather than returning the old tree as if it were fresh.
 *
 * Each `branch` gets its own directory beside the default one: the cache is
 * keyed by what was cloned, so asking for `v2` never answers with `main`.
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

type RegistryKind = "npm" | "pypi" | "crates";
interface PackageFacts {
    registry: RegistryKind;
    name: string;
    version?: string;
    description?: string;
    homepage?: string;
    /** Normalised to an https URL where the registry gives something git-shaped. */
    repository?: string;
    /** Where in that repository the package lives — a monorepo's `packages/x`, from npm's `repository.directory`. */
    repositoryDirectory?: string;
    documentation?: string;
    license?: string;
    /** The registry's own deprecation notice, when there is one. */
    deprecated?: string;
    /** Recent downloads, where the registry publishes them. */
    downloads?: number;
    publishedAt?: string;
}
/** One registry's answer: the facts, or its status and why there are none. */
interface PackageLookup {
    facts?: PackageFacts;
    /** The registry's HTTP status — 404 is "no such package (or version)", 0 is no answer at all. */
    status: number;
    /** Why a request that was not a plain 404 failed, as the runtime or registry said it. */
    error?: string;
}
/** A name resolved across registries — or why it was not. */
interface PackageResolution {
    facts?: PackageFacts;
    /** Why there are no facts, in words a caller can show. */
    note?: string;
    /** Each registry asked, in order, and what it answered. */
    tried: {
        registry: RegistryKind;
        status: number;
        error?: string;
    }[];
}
/**
 * Turn whatever a registry calls a repository into a browsable https URL.
 *
 * They are wildly inconsistent — `git+https://…​.git`, `git://`, `git@host:…`,
 * `ssh://git@host:…`, npm's `github:owner/repo`, a bare `owner/repo`, any of
 * them upper-cased or with a `#branch` — and a caller that passes any of those
 * to a browser or a clone gets a different failure for each.
 */
declare function normalizeRepoUrl(raw: unknown): string | undefined;
/**
 * Look a package up in one registry.
 *
 * Returns undefined for "no such package" AND for a request that failed;
 * `lookupPackageResult` tells the two apart, which a caller resolving a name
 * across several registries needs — to try the next one, or to stop and report
 * a network problem.
 *
 * With `version`, it is that version or nothing: every registry is asked for
 * it by name, and one that does not have it answers 404.
 */
declare function lookupPackage(registry: RegistryKind, name: string, version?: string): Promise<PackageFacts | undefined>;
/** `lookupPackage`, with the registry's status and, for anything but a 404, why it failed. */
declare function lookupPackageResult(registry: RegistryKind, name: string, version?: string): Promise<PackageLookup>;
/**
 * Resolve a bare library name across the registries, in the order most likely to
 * be right, and return the first that knows it.
 *
 * Order is deliberate rather than alphabetical: npm has by far the most names,
 * so trying it first resolves most lookups without probing another registry. An
 * explicit `registry` skips the guessing entirely, which a caller who knows the
 * ecosystem should always do.
 *
 * Undefined when no registry has it — or when one could not be asked;
 * `resolvePackageResult` says which.
 */
declare function resolvePackage(name: string, opts?: {
    registry?: RegistryKind;
    version?: string;
}): Promise<PackageFacts | undefined>;
/**
 * `resolvePackage`, with the reason when it finds nothing.
 *
 * Only a definite 404 hands the name on to the next registry. A registry that
 * is down, rate-limited or unreachable STOPS the walk: the next ecosystem's
 * namesake is a different project, and "npm is down" answered with PyPI's
 * `react` (python-react 4.3.0) was a wrong answer that looked like a right one.
 */
declare function resolvePackageResult(name: string, opts?: {
    registry?: RegistryKind;
    version?: string;
}): Promise<PackageResolution>;

/** The charset named by a Content-Type header, if it names one. */
declare function charsetFromContentType(contentType: string): string | undefined;
/**
 * The charset a document declares about itself: `<meta charset>` or the older
 * `<meta http-equiv="content-type">`, the first one found winning.
 *
 * Read attribute by attribute, as the WHATWG prescan does: `charset=` counts in
 * a meta tag's own `charset`, or in its `content` when the tag is a
 * content-type pragma — never anywhere else. A description reading "how to set
 * charset=utf-16" is prose, and used to outrank the real `<meta charset>` after
 * it. A declared UTF-16 resolves to UTF-8 (see UTF16_LABELS).
 *
 * Only the first 4 KB is scanned. The spec requires the declaration inside the
 * first 1024 bytes, and reading further would mean decoding the body to find out
 * how to decode the body.
 */
declare function charsetFromHtml(head: string): string | undefined;
/**
 * Decode response bytes into text, honouring — in order — a BOM, the
 * Content-Type header, an XML declaration, and (for a body that may be HTML) the
 * document's own `<meta charset>`; with none of those naming a non-UTF-8
 * encoding, UTF-8 when the bytes read as UTF-8 and Windows-1252 when they do
 * not.
 *
 * Precedence follows what actually helps: a BOM cannot be wrong, a header is
 * usually right, and a meta tag is the last resort because a page served as
 * UTF-8 while declaring latin1 in its markup is almost always a stale template
 * rather than a truthful declaration. The final rescue is what an undeclared
 * Latin-1 page — or one whose meta sits past the sniff window behind a large
 * inline script — needs; only a header's explicit UTF-8 is trusted over it.
 *
 * Falls back to UTF-8 on an unknown or unsupported label, so a nonsense charset
 * degrades to today's behaviour rather than failing the fetch.
 */
declare function decodeBody(bytes: Buffer, contentType?: string): string;
/**
 * Decode bytes read from disk: BOM, then an XML declaration or `<meta charset>`,
 * then a UTF-8 validity rescue. A local file has no transport header to trust,
 * and a stale template declaring UTF-8 over Latin-1 bytes is common. Without a
 * BOM or a non-UTF-8 declaration, trust UTF-8 only when the bytes read as UTF-8;
 * otherwise use Windows-1252 so accents and typographic punctuation survive.
 *
 * `sniffHtmlCharset: false` skips the meta step — for a file the caller already
 * knows is plain text, where a `<meta charset>` can only be quoted markup. An
 * XML declaration is still honoured: it has to open the file to count.
 */
declare function decodeLocal(bytes: Buffer, opts?: {
    sniffHtmlCharset?: boolean;
}): string;
declare const CP1252_C1: readonly number[];

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
    /**
     * True when there was no file to read (a 4xx, an empty one, or redirects
     * that loop or leave HTTP), which means "allowed".
     */
    absent: boolean;
    /** The status robots.txt answered with; 0 when no answer came. Absent when it was never requested. */
    status?: number;
    /**
     * The server errored (5xx, 429) or never answered. RFC 9309 §2.3.1.4: the
     * crawler MUST then assume complete disallow, so `rules` holds `Disallow: /`.
     */
    unreachable?: boolean;
}
/**
 * Parse a robots.txt for one user-agent token.
 *
 * Group selection follows the spec's precedence: the group naming our product
 * token wins, and `*` is the fallback. A file with no group for us and no `*`
 * group imposes nothing. A full User-Agent string is reduced to its product
 * token (`MyBot/2.1 (compatible; …)` is `mybot`), the same way the file's lines are.
 */
declare function parseRobots(body: string, userAgent: string): Robots;
/**
 * Does this robots.txt permit fetching `url`?
 *
 * An absent file means yes — that is what the spec says. An unreachable one
 * means no, which is also what the spec says: its rules are `Disallow: /`.
 */
declare function isAllowed(robots: Robots, url: string): boolean;
type UrlAuthorizer = (url: string) => Promise<boolean>;
/** Test seam: forget every fetched robots.txt. */
declare function resetRobotsCache(): void;
/**
 * Fetch and parse the robots.txt governing `url`, memoised per origin.
 *
 * Memoised because the alternative is one extra request per page fetched, which
 * is precisely the kind of load robots.txt exists to prevent — for a day at
 * most, and for a few minutes when the file was unreachable. Disabled entirely
 * by `<PREFIX>_NO_ROBOTS`, for an operator who knows they are crawling their
 * own site.
 */
declare function fetchRobots(url: string, opts?: {
    authorizeUrl?: UrlAuthorizer;
}): Promise<Robots>;

interface PageMetadata {
    title?: string;
    description?: string;
    /** `og:type`, or JSON-LD `@type`. */
    type?: string;
    siteName?: string;
    /** ISO-ish date strings, exactly as the page wrote them. */
    publishedAt?: string;
    modifiedAt?: string;
    /** Every author the page names, each once, in the order given; at most 10 000. */
    authors: string[];
    imageUrl?: string;
    canonicalUrl?: string;
    /** Every JSON-LD block that parsed, untouched — for a caller that wants more. */
    jsonLd: unknown[];
}
/**
 * Every `<script type="application/ld+json">` block that parses.
 *
 * A block that does not parse, even leniently, is skipped rather than thrown:
 * malformed JSON-LD is common and must never cost the caller the rest of the
 * page. So is one nested deeper than any real block. The type may be unquoted
 * or carry a charset parameter.
 *
 * One forward pass: each script's close is searched from its opener, and a
 * script that never closes ends the scan, since nothing after it can close
 * either. A lazy `[\s\S]*?</script>` per opener re-read the rest of the page
 * from every unclosed one. Comments are skipped in the same pass, whichever
 * of a comment and a script comes first owning what follows, as dropElements
 * does: `<!-- old tracker: <script> -->` paired with the real block's
 * </script> and swallowed it, and a commented-out block is not what the page
 * says. A comment that never closes is text, as metaEntries reads it.
 */
declare function extractJsonLd(html: string): unknown[];
/** Every `<meta>` name/property and its content, lower-cased keys; the first of a repeated key wins. */
declare function extractMetaTags(html: string): Map<string, string>;
/**
 * What a page says about itself, merged from JSON-LD and its meta tags.
 *
 * JSON-LD wins on conflict: OpenGraph is written for social-preview cards and is
 * routinely stale or templated, while JSON-LD is what the site feeds search
 * engines and tends to be generated from the real record. But only the JSON-LD
 * that describes THIS page: the primary entity is the first work the page
 * presents (an Article, a Product, a Recipe…), else the first other thing
 * that is not site chrome (a business on its own page), else the page node.
 * Taking every field from whichever node came first reported a news story as
 * the newspaper's Organization block, titled with its name.
 *
 * The canonical URL is the page's own `<link rel="canonical">`, then `og:url`,
 * then the JSON-LD `url` — never an `@id`, which is an identifier such as
 * "…/post-slug/#article", not an address. With `baseUrl` (the address the page
 * was fetched from), relative canonical and image URLs are resolved against it.
 */
declare function pageMetadata(html: string, opts?: {
    baseUrl?: string;
}): PageMetadata;

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
    kind: "rss" | "atom" | "json";
    items: FeedItem[];
}
/**
 * Parse an RSS 2.0, RSS 1.0 (RDF), Atom or JSON Feed document.
 *
 * Returns undefined for anything that is not one — judged by the element the
 * document opens with, not by a `<channel` anywhere in it: a page using a
 * `<channel-nav>` element is still a page, and must fall through to discovery.
 * A feed with no entries is an empty list rather than a throw — "no" is a
 * valid answer that must not look like a crash.
 *
 * `baseUrl` is where the feed was fetched from. Relative links — and Atom's
 * `xml:base` — resolve against it; without it they are returned as written.
 */
declare function parseFeed(xml: string, baseUrl?: string): Feed | undefined;
/**
 * Feed URLs a page advertises via `<link rel="alternate">`.
 *
 * A bare `application/json` alternate is not taken: that is how WordPress
 * advertises its REST API, and JSON Feed's own discovery type is `feed+json`.
 */
declare function discoverFeeds(html: string, baseUrl: string): string[];
interface Sitemap {
    /** Page URLs, for a urlset. */
    urls: {
        loc: string;
        lastmod?: string;
    }[];
    /** Nested sitemap URLs, for a sitemapindex — fetch these to go deeper. */
    sitemaps: string[];
    /** fetchSitemap: the nested sitemaps its document budget did not reach. Raise `max` to read them. */
    unfetched?: string[];
    /** fetchSitemap: why a document was not read, or not read whole. */
    notes?: string[];
}
/**
 * Parse a sitemap, whether it is a `urlset`, a `sitemapindex`, or the
 * protocol's plain-text form (one URL per line).
 *
 * The two are reported separately rather than followed automatically: a sitemap
 * index can name hundreds of children, and deciding how much of a site to
 * enumerate is the caller's budget to spend, not this function's.
 */
declare function parseSitemap(xml: string): Sitemap;
/**
 * Fetch and parse the sitemap(s) for an origin.
 *
 * Reads the ones robots.txt names — a site that publishes its sitemap location
 * there means it — and their children, breadth-first. `/sitemap.xml` is only a
 * guess, so it is tried only when robots.txt named none or the named ones gave
 * nothing: fetched ahead of the index's children, it spent the budget on a
 * usually-404 request.
 *
 * `max` bounds how many documents are fetched (default 3), because a sitemap
 * index is an invitation to enumerate a site and that has to stay a budget the
 * caller sets. The children it did not reach come back in `unfetched`.
 */
declare function fetchSitemap(url: string, opts?: {
    sitemaps?: string[];
    max?: number;
    authorizeUrl?: (url: string) => Promise<boolean>;
    /** Stops the walk: the document in flight is abandoned and none is read after it. */
    signal?: AbortSignal;
    /** Told as each document has been read — the `fetched`-th of at most `max`. */
    onDocument?: (url: string, fetched: number) => void;
}): Promise<Sitemap>;
/**
 * Fetch and parse a feed URL, resolving its links against where it was served from.
 *
 * `authorizeUrl` approves the URL and every redirect before it is requested —
 * a page can advertise a feed anywhere, so a caller confining what it fetches
 * needs it here too; `signal` abandons the request.
 */
declare function fetchFeed(url: string, opts?: {
    authorizeUrl?: (url: string) => Promise<boolean>;
    signal?: AbortSignal;
}): Promise<Feed | undefined>;

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
/**
 * The names in `<PREFIX>_ENGINES` that are not engines — what `keylessEngines`
 * skipped. Ignoring a typo is right; ignoring it SILENTLY is not: a list with
 * no valid name removed the whole keyless rung, and the run then reported "no
 * results" for a search nobody made.
 */
declare function unknownEngines(opts?: {
    engines?: KeylessEngine[];
}): string[];
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
    /**
     * The engine served a result page and it was read — hits, or a genuinely
     * empty page. Anything else (a refusal, an error status, a timeout, no
     * connection) says nothing about the web, and a caller counting "no results"
     * must not count it.
     */
    answered?: boolean;
    /** When it did not answer: the HTTP status that ended it, 0 when no response came back at all. */
    status?: number;
    /**
     * The call stopped before the engine could answer: the caller's signal fired
     * (before the request or during it), or no budget was left to ask. It says
     * nothing about the engine — read as a status 0 it was "unreachable", and a
     * caller that cancelled was told a working engine was down.
     */
    stopped?: boolean;
}
/** Tags out, entities decoded, whitespace collapsed. Inline markup vanishes; a block or `<br>` leaves a space. */
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
 *
 * `error` is the transport's own account of a request that got no status at
 * all — "timed out after 12000 ms", "ENOTFOUND: …" — which says far more than
 * "status 0".
 */
declare function throttleReason(status: number, error?: string): {
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
 * Pagination stops at a page that names no next page, and as soon as a page
 * adds no NEW canonical URL. An engine that ignores the offset parameter and
 * re-serves page one would otherwise be walked to the requested depth, paying a
 * request per page for the same ten results.
 */
declare function searchViaKeyless(engine: KeylessEngine, query: string, opts?: {
    limit?: number;
    pages?: number;
    lang?: string;
    region?: string;
    /** Each request's timeout, in ms (default 12000). */
    timeoutMs?: number;
    /** The whole call's budget in ms, every page included: no page starts after it, and each request's timeout is capped to what is left. */
    budgetMs?: number;
    /**
     * Checked before each page and cuts the pause between two short; a page in
     * flight is aborted (httpGet takes the signal). A call it stopped before
     * any page came back is `stopped`, not unreachable.
     */
    signal?: AbortSignal;
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
    /** Country code overriding the one `lang` implies, e.g. "ca"; "wt" asks for no region. */
    region?: string;
    /** Result pages to walk. SearXNG paginates with `&pageno=`. */
    pages?: number;
    /**
     * The whole search's budget in ms, every rung and page included. No rung or
     * page starts after it, and each request's own timeout is capped to what is
     * left, so the worst case is this plus the 2 s availability probes of
     * SearXNG and Firecrawl.
     */
    timeoutMs?: number;
    /**
     * Abandons the search: checked before each rung and page, and a SearXNG or
     * keyless-engine request in flight is aborted. A Firecrawl request already
     * sent finishes within its own timeout — an aborted one would read to the
     * shared availability probe as a Firecrawl that is down.
     */
    signal?: AbortSignal;
    /**
     * Which keyless engines the cascade may fall back to, in order. Defaults to
     * all of them; `[]` disables the keyless rung entirely, leaving the local
     * stack as the only discovery path.
     */
    engines?: KeylessEngine[];
}
/** A rung of the cascade: SearXNG, one keyless engine, or Firecrawl. */
type SearchRung = "searxng" | "firecrawl" | KeylessEngine;
/**
 * What one rung did. The first two are ANSWERS — the rung read a result page —
 * and only they say anything about the web:
 *
 * - `hits` / `empty`: it answered, with results or with none;
 * - `throttled`: it refused for load, and will work again later;
 * - `blocked`: it turned this client away as automated traffic;
 * - `unreachable`: nothing answered — not running, no connection, timed out;
 * - `error`: something answered, but not with results — an error status, an
 *   empty or unreadable page, a request the backend rejected;
 * - `disabled`: switched off; `not-tried`: the cascade stopped before it
 *   answered — out of budget, or cancelled, even with its request in flight.
 */
type RungOutcome = "hits" | "empty" | "throttled" | "blocked" | "unreachable" | "error" | "disabled" | "not-tried";
interface RungReport {
    rung: SearchRung;
    outcome: RungOutcome;
    /** How many hits it returned, when it returned any. */
    hits?: number;
    /** Its note, when it had one. */
    note?: string;
}
interface SearchResult {
    hits: SearchHit[];
    /** What degraded, in words a caller can show a user. Never an exception. */
    notes: string[];
    /**
     * What each rung did, in cascade order: the facts behind `notes`, for a
     * caller that must tell "blocked" from "empty" without reading English.
     */
    rungs?: RungReport[];
    /**
     * True when at least one rung ANSWERED (outcome `hits` or `empty`). False
     * means nothing was searched — every rung was off, refused or failed — and
     * an empty `hits` is then no finding about the web.
     */
    searched?: boolean;
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
 * a hard 2s ceiling.
 *
 * What counts as an answer depends on who chose the base, as for Firecrawl's
 * probe. On the localhost DEFAULT it must be SearXNG's own `OK`: 8888 is also
 * Jupyter's default port, and taking a notebook server for SearXNG made doctor
 * report it "answering" and every search blame SearXNG's JSON setting. A base
 * the caller NAMED is a statement about what lives there, so ANY HTTP response
 * counts — a proxy in front of it may not route /healthz.
 *
 * Memoised per base: "up" for the process, "down" for 30 s, so an absent
 * instance costs one refused connection per burst of calls while a long-lived
 * MCP server still finds one started later.
 *
 * Deliberately bypasses httpGet, whose retry-with-backoff would turn a 2s
 * ceiling into roughly 4.6s on a blackholed host. A probe wants a single shot.
 */
declare function probeSearxng(base: string, explicit?: boolean): Promise<boolean>;
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
 * reports the wrong one. `rungs` and `searched` carry the same facts as data.
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
/**
 * Write the stack out under the cache dir's `compose/` (rewriting only what
 * changed, so an upgrade refreshes it) and return the compose file's path. The
 * SearXNG settings and the Firecrawl env file sit at the `./docker/...` paths
 * the compose file names relative to itself.
 */
declare function ensureComposeMaterialized(): string;
/** What one `docker` invocation produced. Mirrors the shape a caller can act on. */
interface StackRun {
    ok: boolean;
    stdout: string;
    stderr: string;
    /** The binary was not on PATH — a different problem from a non-zero exit. */
    missing?: boolean;
    /** It was killed at its budget — the one failure a longer budget fixes. */
    timedOut?: boolean;
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
 * A rejecting `fn` rejects the whole call, the same contract as `Promise.all`,
 * and no further item is started — the same at every width. A caller that must
 * degrade per item catches inside `fn` — which is what retrieval wants, since
 * one unreachable page should never abandon the rest.
 *
 * A `limit` that is not a number runs sequentially.
 */
declare function mapLimit<T, R>(items: readonly T[], limit: number, fn: (item: T, index: number) => Promise<R>): Promise<R[]>;

declare function withRunLock<T>(slug: string, fn: () => Promise<T>): Promise<T>;
declare function resetRunLocks(): void;

type Extract = Awaited<ReturnType<typeof fetchAndExtract>>;
interface CacheEntry extends Extract {
    cachedAt: number;
    etag?: string;
    lastModified?: string;
    /**
     * Set on built-in text written while Firecrawl was up but failed on this page.
     * Lookups that predict Firecrawl read it too; otherwise every call for the
     * TTL paid for the same failed scrape plus a fresh download.
     */
    fallbackFrom?: "firecrawl";
    /**
     * Set on a built-in or Firecrawl read stored while the browser fallback was
     * on, that the fallback would retry: the browser was tried and did no better.
     * Served until its TTL like any other entry, rather than rendered again on
     * every call.
     */
    browserTried?: true;
}
declare function cacheDir(): string;
declare function cachePath(url: string, acceptLanguage?: string, extractor?: CacheNamespace, variant?: CacheVariant): string;
type CacheRead = "" | "consent" | "full";
type CacheVariant = CacheRead | "md" | `${Exclude<CacheRead, "">}-md`;
declare const PDF_CACHE_NS: "pdf";
declare const DOC_CACHE_NS: "doc";
declare const VIDEO_CACHE_NS: "video";
type CacheNamespace = ExtractorId | typeof PDF_CACHE_NS | typeof DOC_CACHE_NS | typeof VIDEO_CACHE_NS;
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
    fullPage?: boolean;
    /** "markdown" reads an HTML page as CommonMark; cached apart from its text (see fetchAndExtract). */
    format?: "text" | "markdown";
    timeoutMs?: number;
    signal?: AbortSignal;
    /** The browser rung (see fetchAndExtract); its reads are cached under their own namespace. */
    browser?: BrowserFetchMode;
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
    /**
     * Why the default directory is not used, when it is not: it is a symbolic
     * link, belongs to another user, or other users may write it. The cache then
     * reads and writes nothing, and every fetch goes to the network.
     */
    refused?: string;
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
 * bound and kept bodies for pages nobody would look at again. The same sweep
 * takes this module's own debris — a body whose metadata never landed, a
 * killed writer's temp file — immediately with `all`, and once it is old
 * enough to be abandoned otherwise. Nothing it did not write is touched.
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
 * `mode` sets the permission bits of the new file (e.g. 0o600 for state that
 * holds a login); omitted, the file gets the usual umask-derived default.
 *
 * Bypasses the no-write gate on purpose: this is the durability primitive, and
 * `writeArtifact` above is the gated caller. A caller holding a path of its own
 * that must not be written under `--stdout` calls `writeArtifact`, not this.
 */
declare function writeFileAtomic(path: string, content: string | Uint8Array, mode?: number): void;
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
 * Line breaks — LF, CRLF and a lone CR, which a terminal takes as Enter just
 * the same — collapse to spaces so an emitted command stays ONE line. A runbook
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
    /** SHA-256 of the body's bytes as received — before any character decoding — when all of it was read. */
    contentHash?: string;
    /** Bytes read. 0 on a 304, which is the whole point of a 304. */
    bytes: number;
    status: number;
    /** ISO timestamp of the observation, so a caller can age its own record. */
    fetchedAt: string;
    /** Why no complete body was read, when none was: a baseline without a hash is no baseline. */
    error?: string;
}
/** SHA-256 of a body, hex. Exported because a caller holding bytes from elsewhere wants the same digest. */
declare function contentHash(body: string | Buffer): string;
/**
 * Observe a URL: its validators, its hash, and when it was seen.
 *
 * Always reads the body, because that is what makes the hash available for the
 * many servers that send neither an ETag nor a Last-Modified. Use `hasChanged`
 * when a validator is already in hand — that is the path that costs nothing.
 * `error` says why there is no hash, when there is none.
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
    /** Header cells, from `<thead>` or a first row of `<th>`. Empty when the table declares none. */
    headers: string[];
    /** Body rows, each padded to the widest row so a column index means one thing. */
    rows: string[][];
}
/**
 * Every table in a document, as rows and columns.
 *
 * A table with no data rows is dropped: a layout table used for positioning is
 * still common on older sites, and returning it as data is a false positive a
 * caller has no way to filter. A table nested in another's cell is reported on
 * its own, and its text also stays in the cell that holds it.
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
 * The longest `Crawl-delay` a crawl will wait out (`<PREFIX>_MAX_CRAWL_DELAY_MS`,
 * default 60 s). A host that asks for more is not crawled, and a note says so:
 * `Crawl-delay: 3600` honoured literally stalls a walk for an hour per page,
 * and none of the ways of not honouring it is polite.
 */
declare function maxCrawlDelayMs(): number;
/**
 * Wait until this host is willing to hear from us again, then claim the slot.
 *
 * The claim happens BEFORE the await returns, so two concurrent callers for one
 * host serialise instead of both reading the same free time and departing
 * together — which is the bug a naive "sleep if too soon" has, and the one that
 * makes a rate limiter look like it works right up until the pool widens.
 *
 * A back-off (backOffHost) holds every departure, with or without a delay, and
 * is checked again after each sleep: a slot claimed before the server said
 * "not now" must not go out inside the window it asked for.
 *
 * Different hosts never wait on each other: the whole point is to keep
 * concurrency high across a candidate list while staying single-file per site.
 *
 * `signal` ends the wait early, and the caller must then not send: the slot
 * stays claimed, which errs on the polite side, and the time returned is the
 * time actually waited.
 */
declare function awaitHostSlot(url: string, delayMs?: number, now?: number, signal?: AbortSignal): Promise<number>;
/**
 * Hold a host's departures for `ms` — what a `Retry-After` means.
 *
 * `httpGet` already honours Retry-After for the request that received it; this
 * is how that answer applies to every OTHER request queued for the same host,
 * which is the difference between backing off and backing off once.
 */
declare function backOffHost(url: string, ms: number, now?: number): void;
interface CrawlOptions {
    /**
     * Ceiling on pages RETURNED. Required in spirit; defaulted low on purpose.
     *
     * A URL that yields no readable text costs a request but no slot, so the walk
     * goes on to the next URL rather than hand back a fraction of the asked-for
     * pages — up to `maxRequests`, which is what keeps a site answering 404s from
     * being asked for every URL its sitemap lists.
     */
    maxPages?: number;
    /**
     * Ceiling on page REQUESTS, failed ones included (default 3 × maxPages).
     * robots.txt and sitemap reads are not counted here: they are bounded on
     * their own, one per origin and a few documents.
     */
    maxRequests?: number;
    /**
     * How many links deep to follow. The seed is depth 0. On every ceiling here,
     * `Infinity` is no ceiling and a value that is not a number is the default.
     */
    maxDepth?: number;
    /**
     * Leave the crawl's origin. Off by default — a crawl that wanders is not a
     * site walk. The origin is the seed's, or wherever the seed's own redirect
     * lands (http→https, apex→www): that is the site the caller named.
     */
    crossOrigin?: boolean;
    /**
     * Seed the frontier from the site's sitemap as well as the seed page. Default
     * true. For a seed below the root (`/docs/`, or `/docs`), only the sitemap's
     * entries under that path are taken, after the seed's own links.
     */
    useSitemap?: boolean;
    /** Only follow URLs whose path starts with this (`/docs/`): links and sitemap entries alike. The seed itself is always read. */
    prefix?: string;
    /** Ignore robots.txt. For a site you own, and named so it cannot happen by accident. */
    ignoreRobots?: boolean;
    /**
     * The caller's own policy, asked before every request the crawl makes —
     * each page and each of its redirects, robots.txt, the sitemaps. A URL it
     * refuses is not requested, and a note says so. How a server that refuses
     * private addresses keeps a crawl from walking into them.
     */
    authorizeUrl?: (url: string) => Promise<boolean>;
    /** Per-host delay override. Otherwise robots' own Crawl-delay, else hostDelayMs(). */
    delayMs?: number;
    /**
     * Called as each page lands, so a caller can stream rather than wait for the
     * whole walk. Fires in frontier order — the same order as `pages` — however
     * the fetches interleaved.
     */
    onPage?(page: CrawledPage): void;
    /**
     * Stops the walk: the page requests in flight are abandoned, none starts
     * after, and what was still queued comes back in `pending` with a note. A
     * caller that gave up must not leave a site still being walked for it.
     */
    signal?: AbortSignal;
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
/**
 * Absolute, canonical links out of a page's HTML: `<a href>` and `<area href>`,
 * resolved against the page's `<base href>` when it has one.
 *
 * Attributes are read by exact name, quoted or not — `href=/about` is valid
 * HTML that minifiers emit everywhere, and a `data-href` is not an `href`.
 */
declare function linksFrom(html: string, baseUrl: string): string[];
/**
 * How many pages a crawl keeps in flight at once (`<PREFIX>_CRAWL_CONCURRENCY`,
 * default 4, 1–16). Per-host politeness still serialises DEPARTURES to one
 * host through `awaitHostSlot`; this only lets the responses overlap.
 */
declare function crawlConcurrency(): number;
/**
 * Walk a site from a seed, breadth-first.
 *
 * Bounded four independent ways — pages, requests, depth, and origin — because
 * any one of them alone leaves a hole: a depth limit still admits a
 * combinatorial frontier, a page limit alone will spend the whole budget on a
 * paginated archive and keeps asking while every answer fails, and none of
 * them stops a link out to an unrelated host.
 *
 * robots.txt is consulted at EVERY hop, not once for the seed, and per ORIGIN
 * when the walk crosses one. That is the difference between this and `fetch`,
 * and it is deliberate: `fetch` follows a URL the caller was handed, which is
 * not crawling; this enumerates, which is. A refused URL is reported in
 * `disallowed` rather than dropped, because a silent skip is indistinguishable
 * from a page that does not exist. A robots.txt that errors stops the walk
 * before it starts (RFC 9309 §2.3.1.4), and so does a Crawl-delay over
 * `maxCrawlDelayMs()`.
 *
 * Breadth-first, so a shallow budget returns the pages nearest the seed — the
 * ones a reader would have reached first — rather than one deep spur. Each
 * depth is fetched as one wave with `crawlConcurrency()` pages in flight, and
 * `pages` keeps frontier order regardless of which answer came back first.
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
 * Cached per base: a probe per call would double the request count of every
 * batch, and a server that goes away mid-run shows up as a failed embed anyway.
 * A "no" is asked again after 30 s, so a server started mid-run is found.
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
/**
 * The prefixes to put before a query and before a document for `model` (the
 * configured one by default): from a small table of the common local models,
 * overridden by `${PREFIX}_EMBED_QUERY_PREFIX` / `${PREFIX}_EMBED_DOC_PREFIX`
 * (`none` for no prefix; a space is added after a non-empty one). A model the
 * table does not know gets none — the right answer for most models.
 *
 * `embed` itself never adds them: it embeds exactly what it is given. A caller
 * indexing documents and querying them later applies the same pair both times.
 */
declare function embedPrefixes(model?: string): {
    query: string;
    doc: string;
};
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
/** Whether the local vector store answers. Cached per base like the Ollama probe: a "no" is asked again after 30 s. */
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
 *
 * An existing collection is checked against both: one built by another
 * embedding model (768 dimensions where 1024 are asked) is refused here, by
 * name, instead of every later upsert failing with an opaque 400.
 */
declare function ensureCollection(name: string, size: number, opts?: {
    base?: string;
    distance?: "Cosine" | "Dot" | "Euclid";
}): Promise<{
    ok: boolean;
    note?: string;
}>;
/**
 * Insert or replace points. Waits for the write, so a search right after sees them.
 *
 * Sent in chunks of `${PREFIX}_QDRANT_UPSERT_BATCH` points (default 256), one
 * after another: 3 000 nomic vectors in one request is ~47 MB, and Qdrant
 * refuses anything over 32 MB by default. A failed chunk stops the upsert and
 * is named; the chunks before it are written, and re-running is safe, since an
 * upsert of the same ids replaces them.
 */
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
 *
 * The question and the documents are embedded with the model's task prefixes
 * (`embedPrefixes`; `queryPrefix`/`docPrefix` override them verbatim), and each
 * document is cut to `maxChars` (`${PREFIX}_EMBED_MAX_CHARS`, default 8 000,
 * 0 for no cut) — the model truncates to its context window anyway, so the rest
 * was bandwidth.
 *
 * Fusion is by POSITION in `docs`, not by `id`: two documents sharing an id
 * (the same URL from two engines) are still two documents, each with its own
 * ranks.
 */
declare function hybridSearch<D extends HybridDoc>(question: string, docs: readonly D[], opts?: {
    limit?: number;
    base?: string;
    model?: string;
    k?: number;
    queryPrefix?: string;
    docPrefix?: string;
    maxChars?: number;
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
 *
 * A fence closes the way CommonMark closes it: with the SAME character, at
 * least as many of them, and nothing after. Flipping on any fence-looking line
 * inverted the mask for a ```` block quoting a ``` sample, or a bash block
 * echoing ~~~ — the sample's citation grounded, the real claim went inert.
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
 *
 * The title is matched whole, accents and case aside, in English, French,
 * German, Spanish, Portuguese, Italian and Dutch ("Références", "Quellen",
 * "Works cited"…), with or without a trailing colon or `{#anchor}`, as an ATX
 * or a setext heading. `headings` adds the caller's own titles; it is tested
 * against the heading text as written, without its `#` markers.
 */
declare function appendixMask(lines: readonly string[], opts?: {
    headings?: RegExp;
}): boolean[];
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
 *
 * The group pass consumes no digit, only the separator. When it consumed the
 * digit before each one, the second comma of "1,000,000" had no free leading
 * digit left, was skipped, and the decimal pass made it "1000.000" — every
 * figure of a million or more was misread.
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
declare function runbookMd<T>(phases: readonly PhaseInfo<T>[], defs: readonly PhaseEmission[], runAbs: string, engineAbs: string, cli: string, preamble?: readonly string[], smallWorklist?: number): string;

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
 * Writes, in `<RUN>/orchestration/`:
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
 *
 * A help asked for mid-command (`search --help`) carries that `command`, so the
 * answer can be the one command's usage rather than a wall of every command's.
 */
type ParsedArgs = {
    kind: "help";
    command?: string;
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
 * what was asked. A blank value is not one either: `Number("")` is 0, so
 * `--limit=` read as a budget of nothing.
 *
 * `range` bounds it, inclusively, and refuses what falls outside rather than
 * clamping. Engine functions clamp — a limit of 0 becomes one result, a depth
 * of -1 the seed alone — which is right for a library call and wrong at a
 * command line, where the command then succeeds at a question nobody asked.
 */
declare function argInt(p: CommandArgs, name: string, range?: {
    min?: number;
    max?: number;
}): number | undefined;
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
declare const PROGRESS_MESSAGE_SINCE = "2025-03-26";
declare const BATCHES_REMOVED_IN = "2025-06-18";
/**
 * Why a JSON-RPC batch cannot be served, or undefined when it can.
 *
 * `negotiated` is the revision the client agreed to, and undefined before it
 * agreed to any: a batch is then read the way JSON-RPC reads one rather than
 * refused over a revision nobody named. An empty array is invalid in every
 * revision — JSON-RPC answers it with one error, not with silence.
 */
declare function batchRefusal(batch: readonly unknown[], negotiated: ProtocolVersion | undefined): string | undefined;
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
/**
 * What a client may assume about a tool (MCP 2025-03-26 on). Hints, not
 * guarantees — a client decides from them whether a call needs confirmation.
 */
interface ToolAnnotations {
    /** A display name; the server fills it from ToolDecl.title when absent. */
    title?: string;
    /** Changes nothing in its environment. */
    readOnlyHint?: boolean;
    /** May destroy or overwrite something (meaningful only when not read-only). */
    destructiveHint?: boolean;
    /** Calling it again with the same arguments has no further effect. */
    idempotentHint?: boolean;
    /** Reaches an open world — the web, a remote API — rather than a closed one. */
    openWorldHint?: boolean;
    [hint: string]: boolean | string | undefined;
}
interface ToolDecl {
    name: string;
    description: string;
    inputSchema: JsonSchema;
    title?: string;
    outputSchema?: JsonSchema;
    annotations?: ToolAnnotations;
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
    /**
     * Images sent after the text as `image` content blocks (a screenshot).
     * The response cap measures the text only: a tool bounds its own images.
     */
    images?: {
        data: string;
        mimeType: string;
    }[];
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
/** Malformed domain arguments discovered by a tool handler. */
declare class InvalidParamsError extends Error {
}
/** Thrown for an unknown prompt or a missing required argument. A client bug. */
declare class PromptError extends Error {
}
/**
 * What the server hands a tool call besides its arguments.
 *
 * Dropping a cancelled call's answer is not cancelling it: the fetch, the crawl
 * or the search went on to its own budget for a client that had moved on. The
 * signal is how the work itself stops — pass it to whatever takes one.
 */
interface ToolCallContext {
    /** Aborted by the client's notifications/cancelled, or when the transport loses the request. */
    signal: AbortSignal;
    /**
     * Report how far the call has got. A no-op unless the client asked with
     * `_meta.progressToken`; a value that does not move forward is dropped, as
     * the spec requires progress to increase.
     */
    progress(progress: number, total?: number, message?: string): void;
}
/** How a transport hands one message to the server, beyond the message itself. */
interface HandleOptions {
    /** The transport lost the request — an HTTP client hung up. Aborts the tool's signal. */
    signal?: AbortSignal;
    /**
     * Where notifications about this request (progress) go. Defaults to `send`;
     * a batch collects its replies in `send`, so it names the stream here.
     */
    notify?: (out: JsonRpcMessage) => void;
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
    callTool(name: string, args: Record<string, unknown>, context?: ToolCallContext): Promise<ToolOutcome>;
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
    handle(msg: JsonRpcMessage, send: (out: JsonRpcMessage) => void, opts?: HandleOptions): Promise<void>;
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
    /**
     * Answer only requests carrying `Authorization: Bearer <token>`; anything
     * else gets a 401. The one wall that keeps a reachable port from being
     * everyone's: the others limit what a caller can do, this limits who calls.
     */
    bearerToken?: string;
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

export { ANNOTATIONS_SINCE, ANYDOC_SPEC, ASSUMED_HTTP_PROTOCOL, type Artifact, BATCHES_REMOVED_IN, BATCH_SIZE, type Bm25Doc, type Bm25Index, type Brand, type AXNode as BrowserAXNode, type ActionResult as BrowserActionResult, type BrowserBinary, type Challenge as BrowserChallenge, type ChallengeSignature as BrowserChallengeSignature, type CloseReadsOptions as BrowserCloseReadsOptions, type DetectOptions as BrowserDetectOptions, type BrowserKind, type NetworkEntry as BrowserNetworkEntry, type OpenOptions as BrowserOpenOptions, type ReadPageOptions as BrowserReadOptions, type RenderOptions as BrowserRenderOptions, type RenderResult as BrowserRenderResult, BrowserSession, type SnapshotOptions as BrowserSnapshotOptions, type SnapshotResult as BrowserSnapshotResult, COMPOSE_YAML, CP1252_C1, type CacheEntry, type CacheMode, type CacheStats, type CapAdvice, type ChangeVerdict, type ClaimUnit, type ClaimUnitOptions, type CliSpec, type CommandArgs, type CorpusResult, type CorpusVideo, type CrawlOptions, type CrawlResult, type CrawledPage, DEAD_LINK_STATUS, DEFAULT_MAX_RESPONSE_BYTES, DOC_EXTENSIONS, DOC_EXTRACTORS, type DocExtraction, type DocExtractorId, type DocFormat, type DocLadderOptions, ENGINE_VERSION, ERR_INTERNAL, ERR_INVALID_PARAMS, ERR_INVALID_REQUEST, ERR_METHOD_NOT_FOUND, EVIDENCE_TOKEN, EXIT_FAILURE, EXIT_OK, EXIT_USAGE, type EmbedResult, type EngineHit, type EngineResult, type ExcerptWindow, type ExpandedKeyword, type ExtractResult, type ExtractorId, FILE_LINE_TOKEN, FIRECRAWL_DEFAULT_BASE, FIRECRAWL_ENV, FRAME_EFFORT, type Feed, type FeedItem, type Fingerprint, type FirecrawlHit, type FirecrawlOptions, type FirecrawlScrape, type FirecrawlSearchOptions, type ForgeItem, type ForgeKind, type ForgeOptions, type ForgeResult, type FrameEffort, type FrameKind, type FramesResult, type HandleOptions, type HttpOptions, type HttpResult, type HybridDoc, type HybridHit, InvalidParamsError, type JsonRpcMessage, type JsonSchema, type JsonSchemaProp, KEYLESS_ENGINES, type KeylessEngine, type KeywordMatcher, type KeywordVariant, LATEST_PROTOCOL, LOCAL_FILE_DOMAIN, type ListedVideo, type MarkdownOptions, type McpAdapter, type McpServer, type OrchestrateOptions, type OrchestrateResult, PDF_EXTRACTORS, PDF_INSPECTOR_SPEC, PDF_URL_RE, PROGRESS_MESSAGE_SINCE, PROTOCOL_VERSIONS, type PackageFacts, type PackageLookup, type PackageResolution, type PageMetadata, type ParsedArgs, type PdfExtraction, type PdfExtractorId, type PdfLadderOptions, type PdfVerdict, type PhaseDefinition, type PhaseEmission, type PhaseInfo, type PromptDecl, PromptError, type PromptResult, type ProtocolVersion, RICH_TOOLS_SINCE, type Ranked, type RegistryKind, type RepoFacts, type RepoFactsResult, type RepoRef, type ResolvedProvider, type ResourceContents, type ResourceDecl, ResourceError, type Robots, type RobotsRule, type RungOutcome, type RungReport, type RunningHttpServer, SEARXNG_DEFAULT_BASE, SEARXNG_SETTINGS_YAML, SERVICE_PROFILES, SMALL_WORKLIST, SOURCE_TOKEN, STACK_SERVICES, type ScrapeAttempt, type SearchHit, type SearchOptions, type SearchResult, type SearchRung, type ServerOptions, type ShResult, type Sitemap, type StackAction, type StackDeps, type StackResult, type StackRun, type StdioOptions, TOKEN_RE, type Table, type ToolAnnotations, type ToolCallContext, type ToolDecl, ToolError, type ToolOutcome, UsageError, VIDEO_TRANSCRIBERS, type VectorHit, type VectorPoint, type VideoChapter, type VideoCorpus, type VideoDeps, type VideoFrame, type VideoHit, type VideoLadderOptions, type VideoMeta, type VideoProbe, type VideoRunMeta, type VideoRunResult, type VideoRunner, type VideoSegment, type VideoSource, type VideoTranscriberId, type VideoTranscript, WORKFLOW_FORBIDDEN, accentPattern, acceptLanguageHeader, addressedIdCount, apiBase, apiPrefix, appendixMask, applyRelevanceFloor, argBool, argInt, argList, argOneOf, argValue, arxivIdFromUrl, assessExtractedText, assessPdfText, assessTranscript, awaitHostSlot, backOffHost, baseLang, batchRefusal, bestExcerpt, bm25MatchedTerms, bm25Score, bm25Tokenize, bracketedTokensIn, brand, browserHome, browserUa, buildBm25Index, buildMatcher, cacheClean, cacheDir, cacheMode, cachePath, cacheStats, cachedFetchAndExtract, canonicalRepo, canonicalRepoRef, canonicalizeUrl, capExtract, capResponse, charsetFromContentType, charsetFromHtml, citationTokensIn, classifyChallenge as classifyBrowserChallenge, classifyYtdlpError, cleanInline, closeBrowserReads, codeMask, collectCitations, configure, contactUa, contentCoverage, contentHash, corpusLabels, corpusMarkdown, cosine, crawlConcurrency, crawlSite, createServer, danglingTokens, ddgRedirectTarget, ddgRegion, deaccent, decodeBody, decodeEntities, decodeLocal, dedupeByUrl, dedupeNearDuplicates, defaultUa, deleteCollection, deriveCitableUrl, detectBrowserBinary, detectRateLimited, discoverFeeds, diversify, docFlagRegex, docFormatForContentType, docFormatForUrl, documentedFlags, doiFromUrl, domainOf, downloadSubtitle, embed, embedModel, embedOne, embedPrefixes, embeddingsDisabled, emitWorkflowScript, enabledDocExtractors, enabledExtractors, enabledTranscribers, ensureClone, ensureCollection, ensureComposeMaterialized, ensureDir, ensureHistoryDepth, env, envFlag, envInt, envName, escapeRegExp, excerptWindows, expandTokens, externalHosts, extractClaimUnits, extractDocument, extractFrames, extractFromHtml, extractJsonLd, extractMainHtml, extractMetaTags, extractNumerals, extractPdf, extractTables, fetchAndExtract, fetchFeed, fetchRobots, fetchSitemap, fetchVideoCorpus, fetchVideoRun, fingerprint, firecrawlBase, firecrawlIsExplicit, fnv1a64, fnv1a64Words, focusedSnippet, foldTerm, forgeAuthHeaders, forgeKind, forgeRef, formatStamp, hammingDistance, hasChanged, have, headCommit, helpCoversFlag, hostDelayMs, htmlCanonicalUrl, htmlTitle, htmlToMarkdown, htmlToText, httpGet, httpJson, hybridSearch, isAllowed, isApiEndpoint, isCacheFresh, isCitableUrl, isInvokedDirectly, isKeylessEngine, isNoWrite, isOriginAllowed, isProtocolVersion, isStopword, jsonLine, keylessEngines, keywords, knownVideo, linksFrom, listPhases, listReleases, listResources, listTags, listVideoRuns, listVideos, looksLikeChallenge, looksLikeFirecrawl, looksLikeJunkExtraction, looksLikePdfUrl, lookupPackage, lookupPackageResult, mapGithubIssues, mapLimit, mapScrapeResponse, mapSearchResponse, markFirecrawlDown, markedQuoteMask, matcherFromTokens, maxCrawlDelayMs, mergeSegments, metaDescriptionOf, missingFromHelp, nearestHeading, negotiateProtocol, normalize, normalizeDoi, normalizeNumeralText, normalizeRepoUrl, ocrBudgetLeft, ocrPdf, ocrTools, officeToText, ollamaBase, oneWriterFooter, openBrowserSession, orMasks, orchestrateRun, originUrl, pageDelayMs, pageMetadata, parseArgs, parseDdgHtml, parseDdgLite, parseFeed, parseFileLine, parseMojeek, parseRetryAfter, parseRobots, parseSitemap, parseVtt, pdfToText, pipedEnum, politeDelayMs, positionalText, probeFirecrawl, probeOllama, probeQdrant, probeSearxng, probeVideo, pubmedAbstractUrl, qdrantBase, rankedKeywords, readCapped, readCappedBytes, readJsonSafe, readManifest, readRenderedPage, readResource, readVideoRun, recencyScore, renderAsset, renderSnapshot as renderBrowserSnapshot, repoCacheRoot, repoFacts, repoFactsResult, rescueViaWayback, resetBrand, resetCacheMode, resetCanonicalRepoCache, resetDocLadderCache, resetFirecrawlProbeCache, resetHaveCache, resetHistoryDepthCache, resetHostSchedule, resetNoWrite, resetOcrBudget, resetOcrTools, resetOllamaProbe, resetPdfLadderCache, resetQdrantProbe, resetRobotsCache, resetRunLocks, resetSearxngProbeCache, resetVideoLadderCache, resolvePackage, resolvePackageResult, resolveProvider, resolveRegion, resolveRepo, resolveSkillRoot, revalidationHeaders, rrf, runId, runStdioServer, runWithInput, runbookMd, sameCommit, scrapeViaFirecrawl, search, searchIssues, searchVectors, searchViaFirecrawl, searchViaKeyless, searchViaSearxng, searchVideoRuns, searxngBase, searxngIsExplicit, searxngLanguage, setCacheMode, setNoWrite, setVideoDeps, sh, shAsync, shq, simhash, siteOf, skillName, sleep, slugify, sniffDocument, stackControl, startHttpServer, stripConsentBoilerplate, stripHtmlComments, stripInlineCode, stripTags, structuredContentFor, subtokens, tableToMarkdown, takeArtifacts, throttleReason, toBatches, transcribeVideo, transcriptMarkdown, uncitedIds, unitTexts, unknownEngines, upsert, urlDeclaresIdentity, validateArgs, videoMetaFromInfo, videoRoot, videoRunKey, videoSource, videoUrlAt, whisperBudgetLeft, whisperModel, withRunLock, writeArtifact, writeFileAtomic, writeManifest, youtubeListKind, youtubeVideoId, ytdlpVersionAge };
