import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { main } from "../src/cli.js";
import { callTool } from "../src/mcp/handlers.js";
import { closeBrowserOnSignal, withBrowserClosed } from "../src/browser.js";

// Every command that may read pages closes the browser its reads launched, on
// the way out — errors included — so no window is ever left behind. The engine
// is stubbed at closeBrowserReads (nothing launches in a test anyway), and the
// page reads at src/cache.js.

const { close, fetchPage, openSession } = vi.hoisted(() => ({
  close: vi.fn(async (_opts?: { waitMs?: number }) => ({ closed: false })),
  fetchPage: vi.fn(),
  openSession: vi.fn(),
}));
vi.mock("../src/engine.js", async (original) => ({
  ...(await original<typeof import("../src/engine.js")>()),
  closeBrowserReads: close,
  openBrowserSession: openSession,
}));
vi.mock("../src/cache.js", async (original) => ({
  ...(await original<typeof import("../src/cache.js")>()),
  cachedFetchAndExtract: fetchPage,
}));

const ARTICLE = "Rate limiting caps how many requests a client may make in a window, with token buckets. ".repeat(10);

async function run(argv: string[]): Promise<{ exit?: number; err: string }> {
  const err: string[] = [];
  const o = vi.spyOn(process.stdout, "write").mockImplementation((() => true) as never);
  const e = vi.spyOn(process.stderr, "write").mockImplementation(((c: unknown) => {
    err.push(String(c));
    return true;
  }) as never);
  const x = vi.spyOn(process, "exit").mockImplementation(((code?: number) => {
    throw new Error(`exit:${code ?? 0}`);
  }) as never);
  let exit: number | undefined;
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
  return { exit, err: err.join("") };
}

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "us-browser-close-"));
  fetchPage.mockReset();
  fetchPage.mockImplementation(async (url: string) => ({ text: ARTICLE, title: "Rate limiting", finalUrl: url, status: 200 }));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
  close.mockClear();
});

describe("the CLI closes the browser on the way out", () => {
  it("after gather", async () => {
    await run(["gather", "--q", "rate limiting", "--backends", "fixture", "--out", dir]);
    expect(close).toHaveBeenCalledTimes(1);
  });

  it("after fetch and ingest — even when nothing was added (exit 1)", async () => {
    await run(["gather", "--q", "rate limiting", "--backends", "fixture", "--out", dir]);
    close.mockClear();
    expect((await run(["fetch", "--url", "https://a.test/x", "--out", dir])).exit).toBeUndefined();
    expect(close).toHaveBeenCalled();
    close.mockClear();
    fetchPage.mockImplementation(async (url: string) => ({ text: "", finalUrl: url, status: 0, note: "network down" }));
    expect((await run(["ingest", "--run", dir, "--urls", "https://b.test/y"])).exit).toBe(1);
    expect(close).toHaveBeenCalled();
  });

  it("when the command throws", async () => {
    // Not a dossier: addSource throws on reading it.
    await expect(run(["fetch", "--url", "https://a.test/x", "--out", dir])).rejects.toThrow();
    expect(close).toHaveBeenCalledTimes(1);
  });

  it("passes the resolved mode down to every read", async () => {
    await run(["gather", "--q", "rate limiting", "--backends", "fixture", "--out", dir]);
    fetchPage.mockClear();
    await run(["ingest", "--run", dir, "--urls", "https://c.test/z", "--browser", "always"]);
    expect(fetchPage.mock.calls[0]![1]).toMatchObject({ browser: "always" });
    fetchPage.mockClear();
    await run(["fetch", "--url", "https://d.test/w", "--out", dir]);
    expect(fetchPage.mock.calls[0]![1]).toMatchObject({ browser: "off" }); // the test setup's env
  });

  it("does not bother for a command that reads no page", async () => {
    await run(["modes"]);
    expect(close).not.toHaveBeenCalled();
  });
});

describe("the MCP server closes the browser after each tool call that read pages", () => {
  it("after ultrasearch_ingest, with the mode the caller asked for", async () => {
    await run(["gather", "--q", "rate limiting", "--backends", "fixture", "--out", dir]);
    close.mockClear();
    fetchPage.mockClear();
    await callTool("ultrasearch_ingest", { run: dir, urls: ["https://e.test/v"], browser: "fallback" });
    expect(close).toHaveBeenCalledTimes(1);
    expect(fetchPage.mock.calls[0]![1]).toMatchObject({ browser: "fallback" });
  });

  it("even when the tool call fails", async () => {
    await expect(callTool("ultrasearch_fetch", { run: dir, url: "not-a-url" })).rejects.toThrow();
    expect(close).toHaveBeenCalledTimes(1);
  });

  it("rejects an unknown browser mode", async () => {
    await expect(callTool("ultrasearch_search", { query: "x", backend: "wikipedia", browser: "sometimes" })).rejects.toThrow(/browser/);
  });

  it("not after a call that reads no page", async () => {
    await callTool("ultrasearch_modes", {});
    expect(close).not.toHaveBeenCalled();
  });
});

describe("MCP calls share one browser", () => {
  // The stdio server runs up to four tool calls at once. One call closing the
  // browser while a sibling is still rendering in it would cut that read off.
  it("closes only when the LAST page-reading call in flight ends", async () => {
    await run(["gather", "--q", "rate limiting", "--backends", "fixture", "--out", dir]);
    const other = mkdtempSync(join(tmpdir(), "us-browser-close-b-"));
    try {
      await run(["gather", "--q", "rate limiting", "--backends", "fixture", "--out", other]);
      close.mockClear();
      let release!: () => void;
      const gate = new Promise<void>((r) => {
        release = r;
      });
      fetchPage.mockImplementation(async (url: string) => {
        if (url.includes("slow")) await gate;
        return { text: ARTICLE, title: "Rate limiting", finalUrl: url, status: 200 };
      });
      const slow = callTool("ultrasearch_ingest", { run: other, urls: ["https://slow.test/a"] });
      await callTool("ultrasearch_ingest", { run: dir, urls: ["https://fast.test/b"] });
      expect(close).not.toHaveBeenCalled(); // the slow call is still reading
      release();
      await slow;
      expect(close).toHaveBeenCalledTimes(1);
    } finally {
      rmSync(other, { recursive: true, force: true });
    }
  });
});

describe("a signal closes the browser before the process goes", () => {
  it("SIGTERM: close without waiting for reads, then exit 143; uninstalls cleanly", async () => {
    const exit = vi.spyOn(process, "exit").mockImplementation((() => undefined) as never);
    const before = process.listenerCount("SIGTERM");
    const uninstall = closeBrowserOnSignal();
    try {
      expect(process.listenerCount("SIGTERM")).toBe(before + 1);
      process.emit("SIGTERM", "SIGTERM");
      await vi.waitFor(() => expect(exit).toHaveBeenCalledWith(143));
      expect(close).toHaveBeenCalledWith({ waitMs: 0 });
    } finally {
      uninstall();
      exit.mockRestore();
    }
    expect(process.listenerCount("SIGTERM")).toBe(before);
  });
});

describe("browser open — the human's half of a challenge", () => {
  const session = (spawned: boolean, navigate = vi.fn(async () => ({ url: "x", loaderId: "1" }))) => ({
    spawned,
    navigate,
    takeNotes: vi.fn(() => []),
    detach: vi.fn(async () => {}),
    shutdown: vi.fn(async () => {}),
  });

  afterEach(() => openSession.mockReset());

  it("refuses a URL that is not absolute http(s), without opening anything", async () => {
    expect((await run(["browser", "open", "file:///etc/passwd"])).exit).toBe(1);
    expect((await run(["browser", "nope"])).exit).toBe(1);
    expect(openSession).not.toHaveBeenCalled();
  });

  it("opens the page and only detaches: the window is the human's", async () => {
    const s = session(true);
    openSession.mockResolvedValue(s);
    const r = await run(["browser", "open", "https://challenge.test/page"]);
    expect(r.exit).toBeUndefined();
    expect(s.navigate).toHaveBeenCalledWith("https://challenge.test/page", expect.anything());
    expect(s.detach).toHaveBeenCalled();
    expect(s.shutdown).not.toHaveBeenCalled();
    expect(close).not.toHaveBeenCalled();
  });

  it("shuts down a browser it launched when the page cannot be opened", async () => {
    const s = session(
      true,
      vi.fn(async () => {
        throw new Error("net::ERR_NAME_NOT_RESOLVED");
      }),
    );
    openSession.mockResolvedValue(s);
    const r = await run(["browser", "open", "https://nowhere.test/"]);
    expect(r.exit).toBe(1);
    expect(r.err).toContain("ERR_NAME_NOT_RESOLVED");
    expect(s.shutdown).toHaveBeenCalled();
  });

  it("leaves a browser it only reused running when the page cannot be opened", async () => {
    const s = session(
      false,
      vi.fn(async () => {
        throw new Error("timeout");
      }),
    );
    openSession.mockResolvedValue(s);
    await run(["browser", "open", "https://nowhere.test/"]);
    expect(s.shutdown).not.toHaveBeenCalled();
    expect(s.detach).toHaveBeenCalled();
  });
});

describe("a call that starts while the browser is closing", () => {
  // The last call out closes the browser; a call arriving during that close must
  // not start reading in a browser that is shutting down under it.
  it("waits for the close to finish before it reads", async () => {
    let finish!: () => void;
    close.mockImplementationOnce(
      () =>
        new Promise((r) => {
          finish = () => r({ closed: true });
        }),
    );
    const a = withBrowserClosed(async () => "a");
    await vi.waitFor(() => expect(close).toHaveBeenCalledTimes(1));
    const fnB = vi.fn(async () => "b");
    const b = withBrowserClosed(fnB);
    await new Promise((r) => setTimeout(r, 20));
    expect(fnB).not.toHaveBeenCalled();
    finish();
    expect(await a).toBe("a");
    expect(await b).toBe("b");
    expect(fnB).toHaveBeenCalledTimes(1);
    expect(close).toHaveBeenCalledTimes(2);
  });
});
