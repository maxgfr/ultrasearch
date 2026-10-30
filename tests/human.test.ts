import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { main } from "../src/cli.js";
import { runGather } from "../src/gather.js";
import { readDossier } from "../src/dossier.js";
import {
  challengeCandidates,
  challengeIn,
  handOffDuringRun,
  humanCandidates,
  humanHint,
  humanTimeoutMs,
  refusedForChallenge,
  runHuman,
  selectForHuman,
} from "../src/human.js";
import type { Source } from "../src/types.js";
import { makeCtx } from "./ctx.js";

// `ultrasearch human`, with the engine stubbed at the one seam every page read
// goes through (src/cache.js): no browser starts, and the human is a stub too —
// a read that carries `human` is answered as the engine's handoff would answer.

const { fetchPage, scrape, wayback } = vi.hoisted(() => ({ fetchPage: vi.fn(), scrape: vi.fn(), wayback: vi.fn() }));
vi.mock("../src/cache.js", async (original) => ({
  ...(await original<typeof import("../src/cache.js")>()),
  cachedFetchAndExtract: fetchPage,
}));
vi.mock("../src/backends/firecrawl.js", async (original) => ({
  ...(await original<typeof import("../src/backends/firecrawl.js")>()),
  scrapeViaFirecrawl: scrape,
}));
vi.mock("../src/backends/fetch.js", async (original) => ({
  ...(await original<typeof import("../src/backends/fetch.js")>()),
  rescueViaWayback: wayback,
}));

const WALL = "Nous utilisons des cookies pour améliorer votre expérience. Accepter tous les cookies. Paramétrer les cookies.";
const ARTICLE = "Rate limiting caps how many requests a client may make in a window, with token buckets and leaky buckets. ".repeat(12);
const CHALLENGED = "https://cf.test/rate-limits";
const CF_NOTE = `The browser got HTTP 403 for ${CHALLENGED}. cloudflare challenge — open it with \`ultrasearch browser open ${CHALLENGED}\` and let the human solve it`;

type Opts = { browser?: string; human?: unknown };
/** How the web answers before anyone helps: one consent wall, one challenge, one dead page. */
async function untouched(url: string) {
  if (url.includes("walled.test")) return { text: WALL, title: "Cookies", finalUrl: url, status: 200 };
  if (url.includes("cf.test")) return { text: "", finalUrl: url, status: 403, note: CF_NOTE };
  return { text: "", finalUrl: url, status: 404, note: `Could not fetch ${url} (status 404).` };
}

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "us-human-"));
  fetchPage.mockReset();
  fetchPage.mockImplementation(untouched);
  scrape.mockReset();
  scrape.mockResolvedValue({ why: "Firecrawl is not running" });
  wayback.mockReset();
  wayback.mockResolvedValue(undefined);
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

async function dossier(): Promise<Source[]> {
  const urls = ["https://walled.test/article", CHALLENGED, "https://gone.test/page"];
  await runGather(
    makeCtx("rate limiting", {
      backends: ["host"],
      webResults: urls.map((url) => ({ url, title: "Rate limiting explained", snippet: "Rate limiting caps requests per client and window." })),
      out: dir,
      browser: "fallback",
    }).options,
  );
  fetchPage.mockClear();
  return readDossier(dir).sources;
}
const byUrl = (sources: Source[], url: string) => sources.find((s) => s.url === url) as Source;

describe("humanCandidates", () => {
  it("takes every ⛔ wall, and a snippet-only source whose read met a challenge — not a dead page", async () => {
    const sources = await dossier();
    const { manifest } = readDossier(dir);
    const found = humanCandidates(sources, manifest);
    expect(found.map((c) => c.url).sort()).toEqual([CHALLENGED, "https://walled.test/article"]);
    expect(found.find((c) => c.url === CHALLENGED)?.why).toBe("snippet only — cloudflare challenge");
    expect(found.find((c) => c.url.includes("walled"))?.why).toBe("⛔ wall");
    expect(humanHint(dir)).toBe(`2 page(s) need a human: ultrasearch human --run ${dir}`);
  });

  it("does not read a note about a longer URL as one about this one", () => {
    const s = { id: "S1", url: "https://x.test/a", fullText: false } as Source;
    expect(humanCandidates([s], { notes: ["cloudflare challenge — open it with `ultrasearch browser open https://x.test/ab`"] })).toEqual([]);
    expect(humanCandidates([s], { notes: ["cloudflare challenge — open it with `ultrasearch browser open https://x.test/a`"] })).toHaveLength(1);
  });
});

describe("runHuman", () => {
  it("hands each page to the human and repairs its source in place, same S#", async () => {
    const before = await dossier();
    const wallId = byUrl(before, "https://walled.test/article").id;
    // Once the human is past it, the read comes back with the page.
    fetchPage.mockImplementation(async (url: string, opts: Opts = {}) =>
      opts.human ? { text: ARTICLE, title: "Rate limiting", finalUrl: url, status: 200, extractor: "browser", handoff: "cleared" } : untouched(url),
    );
    const { chosen } = selectForHuman(dir);
    const started: string[] = [];
    const results = await runHuman(dir, chosen, { timeoutMs: 60_000, onStart: (c) => started.push(c.id) });
    expect(results.map((r) => r.outcome)).toEqual(["repaired", "repaired"]);
    expect(started).toEqual(chosen.map((c) => c.id));
    // Through the browser, the cache unread, the human's time handed on.
    for (const call of fetchPage.mock.calls.filter((c) => c[1]?.human)) {
      expect(call[1]).toMatchObject({ browser: "always", human: { timeoutMs: 60_000 } });
      expect(call[2]).toBe(false);
    }
    const after = readDossier(dir).sources;
    expect(after).toHaveLength(before.length);
    const repaired = byUrl(after, "https://walled.test/article");
    expect(repaired.id).toBe(wallId);
    expect(repaired.wall).toBeUndefined();
    expect(repaired.fullText).not.toBe(false);
    expect(readFileSync(join(dir, repaired.extract), "utf8")).toContain("token buckets");
    expect(humanHint(dir)).toBeUndefined();
  });

  it("says timed out when nobody got past the wall, and still walled when the page stayed one", async () => {
    await dossier();
    fetchPage.mockImplementation(async (url: string, opts: Opts = {}) =>
      opts.human && url.includes("cf.test")
        ? { text: "", finalUrl: url, status: 403, handoff: "timeout", note: `${CF_NOTE} Nobody got past it within 60 s.` }
        : untouched(url),
    );
    const results = await runHuman(dir, selectForHuman(dir).chosen, { timeoutMs: 60_000 });
    const of = (u: string) => results.find((r) => r.url.includes(u));
    expect(of("cf.test")?.outcome).toBe("timed out");
    expect(of("walled.test")?.outcome).toBe("still walled");
    // Nothing repaired, nothing lost: both are still there to hand over.
    expect(humanCandidates(readDossier(dir).sources, readDossier(dir).manifest)).toHaveLength(2);
  });

  it("waits for nobody when no window can be shown", async () => {
    await dossier();
    const results = await runHuman(dir, selectForHuman(dir).chosen, { noWindow: "no window can be shown here" });
    expect(results.every((r) => r.outcome === "skipped" && r.note === "no window can be shown here")).toBe(true);
    expect(fetchPage).not.toHaveBeenCalled();
  });

  it("with --id, takes the sources named — a weak one the run did not flag too — and leaves a good one alone", async () => {
    const sources = await dossier();
    const gone = byUrl(sources, "https://gone.test/page");
    const wall = byUrl(sources, "https://walled.test/article");
    const sel = selectForHuman(dir, [gone.id, wall.id, "S999"]);
    expect(sel.chosen.map((c) => c.id).sort()).toEqual([gone.id, wall.id].sort());
    expect(sel.missing).toEqual(["S999"]);
  });
});

describe("the handoff at the end of a run", () => {
  const OTHER = "https://cf.test/other-page";
  const lines: string[] = [];
  const tell = (l: string) => void lines.push(l);
  const on = { ULTRASEARCH_HUMAN_TIMEOUT_MS: "20000" };
  const shown = () => true;
  beforeEach(() => {
    lines.length = 0;
  });

  it("reads the wait from ULTRASEARCH_HUMAN_TIMEOUT_MS: 5 minutes unset, 10 s to an hour, 0 never", () => {
    expect(humanTimeoutMs({})).toBe(300_000);
    expect(humanTimeoutMs({ ULTRASEARCH_HUMAN_TIMEOUT_MS: "90000" })).toBe(90_000);
    expect(humanTimeoutMs({ ULTRASEARCH_HUMAN_TIMEOUT_MS: "5" })).toBe(10_000);
    expect(humanTimeoutMs({ ULTRASEARCH_HUMAN_TIMEOUT_MS: "99999999" })).toBe(3_600_000);
    expect(humanTimeoutMs({ ULTRASEARCH_HUMAN_TIMEOUT_MS: "soon" })).toBe(300_000);
    expect(humanTimeoutMs({ ULTRASEARCH_HUMAN_TIMEOUT_MS: "0" })).toBeUndefined();
  });

  it("names a challenge, never a sign-in or consent wall", () => {
    expect(challengeIn(CF_NOTE)).toBe("challenge");
    expect(challengeIn("Please verify you are human to continue")).toBe("verify you are human");
    expect(challengeIn("hCaptcha")).toBe("hCaptcha");
    expect(challengeIn("login wall")).toBeUndefined();
    expect(challengeIn(WALL)).toBeUndefined();
    expect(refusedForChallenge(OTHER, CF_NOTE)).toEqual({ id: "-", url: OTHER, why: "refused — challenge" });
    expect(refusedForChallenge(OTHER, "Could not fetch it (status 404).")).toBeUndefined();
  });

  it("takes the pages a challenge stopped, not a consent wall", async () => {
    const sources = await dossier();
    expect(challengeCandidates(dir, sources, readDossier(dir).manifest).map((c) => c.url)).toEqual([CHALLENGED]);
  });

  it("hands them over with the wait the env names, and repairs the source in place", async () => {
    const before = await dossier();
    fetchPage.mockImplementation(async (url: string, opts: Opts = {}) =>
      opts.human ? { text: ARTICLE, title: "Rate limiting", finalUrl: url, status: 200, extractor: "browser", handoff: "cleared" } : untouched(url),
    );
    const got = await handOffDuringRun(dir, { browser: "fallback", tell, env: on, canShow: shown });
    expect(got).toEqual([expect.objectContaining({ id: byUrl(before, CHALLENGED).id, url: CHALLENGED, outcome: "repaired" })]);
    const handed = fetchPage.mock.calls.filter((c) => c[1]?.human);
    expect(handed.map((c) => c[0])).toEqual([CHALLENGED]);
    expect(handed[0]?.[1]).toMatchObject({ browser: "always", human: { timeoutMs: 20_000 } });
    expect(lines[0]).toContain("1 page(s) stopped at a human check");
    expect(lines[0]).toContain("up to 20 s each");
    expect(lines[1]).toMatch(/\trepaired$/);
    expect(byUrl(readDossier(dir).sources, CHALLENGED).fullText).not.toBe(false);
  });

  it("stops at the first page nobody got past: nobody is at the window", async () => {
    await dossier();
    fetchPage.mockImplementation(async (url: string, opts: Opts = {}) =>
      opts.human ? { text: "", finalUrl: url, status: 403, handoff: "timeout", note: `${CF_NOTE} Nobody got past it within 20 s.` } : untouched(url),
    );
    const got = await handOffDuringRun(dir, {
      browser: "fallback",
      tell,
      env: on,
      canShow: shown,
      refused: [{ id: "-", url: OTHER, why: "refused — challenge" }],
    });
    expect(got.map((r) => [r.url, r.outcome])).toEqual([
      [CHALLENGED, "timed out"],
      [OTHER, "skipped"],
    ]);
    expect(got[1]?.note).toBe(`nobody got past ${CHALLENGED} in time — left for \`ultrasearch human --run ${dir}\``);
    expect(fetchPage.mock.calls.filter((c) => c[1]?.human)).toHaveLength(1);
  });

  it("adds a page fetch refused for a challenge once the person is past it", async () => {
    await dossier();
    fetchPage.mockImplementation(async (url: string, opts: Opts = {}) =>
      opts.human ? { text: ARTICLE, title: "Other page", finalUrl: url, status: 200, extractor: "browser", handoff: "cleared" } : untouched(url),
    );
    const n = readDossier(dir).sources.length;
    const got = await handOffDuringRun(dir, {
      browser: "fallback",
      tell,
      env: on,
      canShow: shown,
      refused: [{ id: "-", url: OTHER, why: "refused — challenge" }],
    });
    expect(got.find((r) => r.url === OTHER)).toMatchObject({ outcome: "added", id: `S${n + 1}` });
    expect(readDossier(dir).sources).toHaveLength(n + 1);
  });

  it("waits for nobody when the rung is off, the env says 0, or no window can be shown", async () => {
    await dossier();
    expect(await handOffDuringRun(dir, { browser: "off", tell, env: on, canShow: shown })).toEqual([]);
    expect(await handOffDuringRun(dir, { browser: "fallback", tell, env: { ULTRASEARCH_HUMAN_TIMEOUT_MS: "0" }, canShow: shown })).toEqual([]);
    expect(await handOffDuringRun(dir, { browser: "always", tell, env: on, canShow: () => false })).toEqual([]);
    expect(fetchPage).not.toHaveBeenCalled();
    expect(lines).toEqual([]);
  });
});

// Drive main() in-process, as tests/cli-fetch.test.ts does.
async function run(argv: string[]): Promise<{ out: string; err: string; exit?: number; code?: number | string }> {
  const out: string[] = [];
  const err: string[] = [];
  const o = vi.spyOn(process.stdout, "write").mockImplementation(((c: unknown) => {
    out.push(String(c));
    return true;
  }) as never);
  const e = vi.spyOn(process.stderr, "write").mockImplementation(((c: unknown) => {
    err.push(String(c));
    return true;
  }) as never);
  const x = vi.spyOn(process, "exit").mockImplementation(((code?: number) => {
    throw new Error(`exit:${code ?? 0}`);
  }) as never);
  let exit: number | undefined;
  const before = process.exitCode;
  process.exitCode = undefined;
  try {
    await main(argv);
  } catch (er) {
    const m = /^exit:(\d+)$/.exec((er as Error).message);
    if (!m) throw er;
    exit = Number(m[1]);
  } finally {
    o.mockRestore();
    e.mockRestore();
    x.mockRestore();
  }
  const code = process.exitCode;
  process.exitCode = before;
  return { out: out.join(""), err: err.join(""), exit, code };
}

describe("main() — human", () => {
  afterEach(() => vi.unstubAllEnvs());

  it("lists the pages that need a human with --list, opening nothing", async () => {
    const sources = await dossier();
    const r = await run(["human", "--run", dir, "--list"]);
    expect(r.exit).toBeUndefined();
    expect(r.out).toContain(`${byUrl(sources, CHALLENGED).id}\t${CHALLENGED}\tsnippet only — cloudflare challenge`);
    expect(r.out).toContain("⛔ wall");
    expect(fetchPage).not.toHaveBeenCalled();
  });

  it("skips every page, waiting for nobody, where no window can be shown — and says so per source", async () => {
    await dossier();
    vi.stubEnv("CI", "true");
    const r = await run(["human", "--run", dir, "--timeout", "30"]);
    expect(r.out.trim().split("\n")).toHaveLength(2);
    expect(r.out).toMatch(/\tskipped\t/);
    expect(r.err).toContain("repaired 0 of 2 page(s)");
    expect(r.exit).toBe(1);
    expect(fetchPage).not.toHaveBeenCalled();
  });

  it("gather, fetch and ingest hand a page a challenge stopped to the person before they end", async () => {
    vi.stubEnv("ULTRASEARCH_HUMAN_TIMEOUT_MS", "30000");
    vi.stubEnv("CI", "");
    vi.stubEnv("DISPLAY", ":0");
    fetchPage.mockImplementation(async (url: string, opts: Opts = {}) =>
      opts.human ? { text: ARTICLE, title: "Rate limiting", finalUrl: url, status: 200, extractor: "browser", handoff: "cleared" } : untouched(url),
    );
    const { writeFileSync } = await import("node:fs");
    const web = join(dir, "web.json");
    writeFileSync(
      web,
      JSON.stringify(
        [CHALLENGED, "https://walled.test/article"].map((url) => ({ url, title: "Rate limiting explained", snippet: "Rate limiting caps requests." })),
      ),
    );
    const out = join(dir, "run");
    const g = await run(["gather", "--q", "rate limiting", "--backends", "host", "--web-results", web, "--out", out, "--browser", "fallback"]);
    expect(g.err).toContain("1 page(s) stopped at a human check");
    expect(g.err).toMatch(/ultrasearch: human: S\d+\thttps:\/\/cf\.test\/rate-limits\trepaired/);
    // The consent wall is left for `ultrasearch human`: only it is still counted.
    expect(g.err).toContain(`  human:    1 page(s) need a human: ultrasearch human --run ${out}`);
    const f = await run(["fetch", "--out", out, "--url", "https://cf.test/fresh", "--browser", "fallback"]);
    expect(f.err).toContain("stopped at a human check");
    expect(f.out.trim()).toMatch(/^S\d+$/);
    expect(f.exit).toBeUndefined();
    const i = await run(["ingest", "--run", out, "--urls", "https://cf.test/third,https://gone.test/x", "--browser", "fallback"]);
    expect(i.out).toMatch(/^S\d+\thttps:\/\/cf\.test\/third$/m);
    expect(i.err).toContain("ingested 1 source(s), skipped 1 of 2 URL(s)");
    // With --browser off, nothing comes forward and nobody is waited for.
    fetchPage.mockClear();
    await run(["fetch", "--out", out, "--url", "https://cf.test/fourth", "--browser", "off"]);
    expect(fetchPage.mock.calls.filter((c) => c[1]?.human)).toEqual([]);
  });

  it("exits 2 under --stdout, like the other writers", async () => {
    await dossier();
    const r = await run(["human", "--run", dir, "--stdout"]);
    expect(r.code).toBe(2);
    expect(r.err).toContain("`human` cannot run without writing");
  });

  it("ends gather, ingest and fetch with the hint when the dossier holds such pages", async () => {
    const urls = ["https://walled.test/article", CHALLENGED];
    const web = join(dir, "web.json");
    const { writeFileSync } = await import("node:fs");
    writeFileSync(web, JSON.stringify(urls.map((url) => ({ url, title: "Rate limiting explained", snippet: "Rate limiting caps requests." }))));
    const out = join(dir, "run");
    const hint = `2 page(s) need a human: ultrasearch human --run ${out}`;
    const g = await run(["gather", "--q", "rate limiting", "--backends", "host", "--web-results", web, "--out", out, "--browser", "fallback"]);
    expect(g.err).toContain(`  human:    ${hint}`);
    const f = await run(["fetch", "--out", out, "--url", "https://walled.test/other"]);
    expect(f.err).toContain(`ultrasearch: ${hint}`);
    const i = await run(["ingest", "--run", out, "--urls", "https://walled.test/third"]);
    expect(i.err).toContain(`ultrasearch: ${hint}`);
  });
});
