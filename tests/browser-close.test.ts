import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { main } from "../src/cli.js";
import { callTool } from "../src/mcp/handlers.js";

// Every command that may read pages closes the browser its reads launched, on
// the way out — errors included — so no window is ever left behind. The engine
// is stubbed at closeBrowserReads (nothing launches in a test anyway), and the
// page reads at src/cache.js.

const { close, fetchPage } = vi.hoisted(() => ({ close: vi.fn(async () => ({ closed: false })), fetchPage: vi.fn() }));
vi.mock("../src/engine.js", async (original) => ({
  ...(await original<typeof import("../src/engine.js")>()),
  closeBrowserReads: close,
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
