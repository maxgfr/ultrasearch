import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { main } from "../src/cli.js";
import { installFetchMock } from "./fetchmock.js";

// Drive main() in-process (same capture harness as cli-main.test.ts) so V8
// coverage sees the fetch/add-source success + dedup + failure branches, which
// need a mocked network the pure error-path tests don't exercise.
async function run(argv: string[]): Promise<{ out: string; err: string; exit?: number }> {
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
  try {
    await main(argv);
  } catch (er) {
    const m = /^exit:(\d+)$/.exec((er as Error).message);
    if (!m) {
      o.mockRestore();
      e.mockRestore();
      x.mockRestore();
      throw er;
    }
    exit = Number(m[1]);
  }
  o.mockRestore();
  e.mockRestore();
  x.mockRestore();
  return { out: out.join(""), err: err.join(""), exit };
}

const PAGE = `<html><head><title>Good Doc</title></head><body><main>${"Rate limiting caps how many requests a client may make in a window. ".repeat(20)}</main></body></html>`;

afterEach(() => vi.unstubAllGlobals());

describe("main() — fetch/add-source (network paths)", () => {
  it("ingests a URL (prints S#), dedupes a repeat, and exits 1 on an unfetchable url", async () => {
    const dir = mkdtempSync(join(tmpdir(), "us-cli-fetch-"));
    // Wayback is stubbed off so a dead link fails cleanly instead of rescuing.
    const prev = process.env.ULTRASEARCH_NO_WAYBACK;
    process.env.ULTRASEARCH_NO_WAYBACK = "1";
    try {
      await run(["gather", "--q", "rate limiting", "--backends", "fixture", "--out", dir]);
      installFetchMock((url) => {
        if (url.includes("good.test")) return { body: PAGE, contentType: "text/html" };
        if (url.includes("bad.test")) return { status: 403, body: "" };
        return undefined;
      });

      const ok = await run(["fetch", "--out", dir, "--url", "https://good.test/article"]);
      expect(ok.exit).toBeUndefined();
      expect(ok.out).toMatch(/S\d+/);
      expect(ok.err).toMatch(/added S\d+/);

      // Same URL again → dedup: no new id, "already in dossier" note, still exit 0.
      const dup = await run(["fetch", "--out", dir, "--url", "https://good.test/article"]);
      expect(dup.exit).toBeUndefined();
      expect(dup.err).toMatch(/already in dossier/i);
      expect(dup.out).toMatch(/S\d+/);

      // Unfetchable (403, wayback off) → no id → exit 1.
      const bad = await run(["fetch", "--out", dir, "--url", "https://bad.test/x"]);
      expect(bad.exit).toBe(1);
      expect(bad.err).toMatch(/could not fetch|not added|no readable/i);
    } finally {
      if (prev === undefined) delete process.env.ULTRASEARCH_NO_WAYBACK;
      else process.env.ULTRASEARCH_NO_WAYBACK = prev;
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("emits JSON for a successful ingest with --json", async () => {
    const dir = mkdtempSync(join(tmpdir(), "us-cli-fetchj-"));
    try {
      await run(["gather", "--q", "rate limiting", "--backends", "fixture", "--out", dir]);
      installFetchMock((url) => (url.includes("good.test") ? { body: PAGE, contentType: "text/html" } : undefined));
      const j = await run(["fetch", "--out", dir, "--url", "https://good.test/a", "--json"]);
      const parsed = JSON.parse(j.out);
      expect(parsed.added).toBe(true);
      expect(parsed.id).toMatch(/S\d+/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
