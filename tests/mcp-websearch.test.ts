import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { callTool, ToolError } from "../src/mcp/handlers.js";
import { installFetchMock } from "./fetchmock.js";
import { writeFixtureDossier } from "./dossierfix.js";

afterEach(() => vi.unstubAllGlobals());

const page = (n: string) =>
  `<html><head><title>${n}</title></head><body><main>${`Rate limiting caps requests per window. ${n} `.repeat(20)}</main></body></html>`;

async function call(name: string, args: Record<string, unknown>): Promise<unknown> {
  const res = await callTool(name, args);
  return JSON.parse(res.text);
}

describe("MCP — the engines a client could not previously drive", () => {
  it("rejects an out-of-enum web_engine and search profile with a fixable message", async () => {
    for (const [key, value] of [
      ["web_engine", "bing"],
      ["search", "medium"],
    ]) {
      await expect(callTool("ultrasearch_gather", { question: "x", [key!]: value })).rejects.toThrow(ToolError);
    }
  });

  it("rejects a web_results payload that is not an array, or holds no usable hit", async () => {
    await expect(callTool("ultrasearch_gather", { question: "x", web_results: "https://a.test" })).rejects.toThrow(/must be an array/);
    await expect(callTool("ultrasearch_gather", { question: "x", web_results: [{ title: "no url" }] })).rejects.toThrow(/no usable hit/);
  });
});

describe("MCP — ultrasearch_ingest", () => {
  it("folds a whole batch in and reports an outcome per URL", async () => {
    const dir = mkdtempSync(join(tmpdir(), "us-mcp-ingest-"));
    try {
      writeFixtureDossier(dir, 1);
      installFetchMock((url) => (url.includes(".test") ? { body: page(url), contentType: "text/html" } : undefined));
      const res = (await call("ultrasearch_ingest", {
        run: dir,
        web_results: [{ url: "https://a.test/one", title: "One" }],
        urls: ["https://b.test/two"],
      })) as { added: number; results: { url: string; id: string }[] };
      expect(res.added).toBe(2);
      expect(res.results.map((r) => r.id)).toEqual(["S2", "S3"]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("requires something to ingest, and refuses a non-http url", async () => {
    const dir = mkdtempSync(join(tmpdir(), "us-mcp-ingest-bad-"));
    try {
      writeFixtureDossier(dir, 1);
      await expect(callTool("ultrasearch_ingest", { run: dir })).rejects.toThrow(/is required/);
      await expect(callTool("ultrasearch_ingest", { run: dir, urls: ["ftp://a.test/x"] })).rejects.toThrow(/absolute http\(s\) URLs/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("says what to do when part of the batch was refused", async () => {
    const dir = mkdtempSync(join(tmpdir(), "us-mcp-ingest-partial-"));
    const prev = process.env.ULTRASEARCH_NO_WAYBACK;
    process.env.ULTRASEARCH_NO_WAYBACK = "1";
    try {
      writeFixtureDossier(dir, 1);
      installFetchMock((url) => (url.includes("good.test") ? { body: page("good"), contentType: "text/html" } : { status: 404, body: "" }));
      const res = (await call("ultrasearch_ingest", { run: dir, urls: ["https://good.test/a", "https://dead.test/b"] })) as {
        added: number;
        skipped: number;
        next?: string;
      };
      expect(res.added).toBe(1);
      expect(res.skipped).toBe(1);
      expect(res.next).toMatch(/not added/i);
    } finally {
      if (prev === undefined) delete process.env.ULTRASEARCH_NO_WAYBACK;
      else process.env.ULTRASEARCH_NO_WAYBACK = prev;
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
