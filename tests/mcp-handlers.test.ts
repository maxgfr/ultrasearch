import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createServer, type JsonRpcMessage } from "../src/mcp/server.js";
import { callTool } from "../src/mcp/handlers.js";

// The handlers driven through the JSON-RPC core, in-process, against a real
// dossier. Everything runs on the `fixture` backend, so nothing here touches
// the network: the point is that a tool name reaches the same library call the
// CLI makes, not that the open web is up.

let RUN: string;
const temps: string[] = [];

beforeAll(async () => {
  const out = mkdtempSync(join(tmpdir(), "us-mcp-"));
  temps.push(out);
  const res = await callTool("ultrasearch_gather", {
    question: "how does rate limiting work?",
    backends: ["fixture"],
    depth: "summary",
    out,
  });
  RUN = JSON.parse(res.text).run;
}, 120_000);

afterAll(() => {
  for (const d of temps) rmSync(d, { recursive: true, force: true });
});

const server = createServer();

async function rpc(msg: Omit<JsonRpcMessage, "jsonrpc">): Promise<JsonRpcMessage | undefined> {
  let out: JsonRpcMessage | undefined;
  await server.handle({ jsonrpc: "2.0", ...msg }, (m) => {
    out = m;
  });
  return out;
}

async function call(name: string, args: Record<string, unknown>): Promise<JsonRpcMessage> {
  return (await rpc({ id: 1, method: "tools/call", params: { name, arguments: args } }))!;
}

async function ok(name: string, args: Record<string, unknown>): Promise<Record<string, unknown>> {
  const res = await call(name, args);
  const result = res.result as { content: { text: string }[]; isError?: boolean } | undefined;
  expect(res.error, `unexpected JSON-RPC error: ${JSON.stringify(res.error)}`).toBeUndefined();
  expect(result?.isError, `unexpected isError: ${result?.content?.[0]?.text}`).toBeFalsy();
  return JSON.parse(result!.content[0]!.text);
}

async function errorText(name: string, args: Record<string, unknown>): Promise<string> {
  const res = await call(name, args);
  const result = res.result as { content: { text: string }[]; isError?: boolean } | undefined;
  expect(result?.isError, "expected an isError tool result").toBe(true);
  return result!.content[0]!.text;
}

describe("lifecycle methods", () => {
  it("negotiates a protocol version and advertises all three primitives", async () => {
    const res = await rpc({ id: 1, method: "initialize", params: { protocolVersion: "2025-06-18" } });
    const r = res!.result as { protocolVersion: string; serverInfo: { name: string }; capabilities: unknown };
    expect(r.protocolVersion).toBe("2025-06-18");
    expect(r.serverInfo.name).toBe("ultrasearch");
    expect(r.capabilities).toEqual({
      tools: { listChanged: false },
      resources: { subscribe: false, listChanged: false },
      prompts: { listChanged: false },
    });
  });

  it("rejects an unknown method, an unknown tool and bad arguments as protocol errors", async () => {
    expect((await rpc({ id: 1, method: "resources/subscribe" }))!.error).toMatchObject({ code: -32601 });
    expect((await call("ultrasearch_nope", {})).error).toMatchObject({ code: -32602 });
    expect((await call("ultrasearch_gather", {})).error).toMatchObject({ code: -32602 });
  });

  it("serves resources and prompts alongside tools", async () => {
    const resources = ((await rpc({ id: 1, method: "resources/list" }))!.result as { resources: { uri: string }[] }).resources;
    expect(resources.map((r) => r.uri)).toContain("skill://SKILL.md");

    const contents = ((await rpc({ id: 2, method: "resources/read", params: { uri: "skill://SKILL.md" } }))!.result as { contents: { text: string }[] })
      .contents;
    expect(contents[0]!.text).toContain("ultrasearch");

    const prompts = ((await rpc({ id: 3, method: "prompts/list" }))!.result as { prompts: { name: string }[] }).prompts;
    expect(prompts.map((p) => p.name)).toContain("research_topic");

    const got = await rpc({ id: 4, method: "prompts/get", params: { name: "research_topic", arguments: { question: "why?" } } });
    expect((got!.result as { messages: { content: { text: string } }[] }).messages[0]!.content.text).toContain("why?");
  });

  it("reports a bad resource uri, a missing uri and a bad prompt name as invalid params", async () => {
    // A client naming something wrong is a client bug — the same class as an
    // unknown tool, and never a failed read.
    expect((await rpc({ id: 1, method: "resources/read", params: {} }))!.error).toMatchObject({ code: -32602 });
    expect((await rpc({ id: 2, method: "resources/read", params: { uri: "skill://../../package.json" } }))!.error).toMatchObject({ code: -32602 });
    expect((await rpc({ id: 3, method: "resources/read", params: { uri: "file:///etc/passwd" } }))!.error).toMatchObject({ code: -32602 });
    expect((await rpc({ id: 4, method: "prompts/get", params: { name: "nope" } }))!.error).toMatchObject({ code: -32602 });
    expect((await rpc({ id: 5, method: "prompts/get", params: { name: "research_topic", arguments: {} } }))!.error).toMatchObject({ code: -32602 });
  });

  it("drops a request the client cancelled, and answers the next one", async () => {
    expect(await rpc({ method: "notifications/cancelled", params: { requestId: 7 } })).toBeUndefined();
    expect(await rpc({ id: 7, method: "ping" })).toBeUndefined();
    expect((await rpc({ id: 8, method: "ping" }))!.result).toEqual({});
  });

  it("rejects a frame that is not a JSON-RPC object", async () => {
    let out: JsonRpcMessage | undefined;
    await server.handle(null as unknown as JsonRpcMessage, (m) => {
      out = m;
    });
    expect(out!.error).toMatchObject({ code: -32600 });
  });
});

describe("gather", () => {
  it("wrote a real dossier and pointed at the next step", async () => {
    const res = await ok("ultrasearch_read", { run: RUN, path: "DOSSIER.md" });
    expect(String(res.content).length).toBeGreaterThan(100);
  });

  it("defaults to standard depth, not deep", async () => {
    // deep runs 10-20 minutes; an MCP client that times out mid-gather loses
    // the run. The default has to be the one that comes back.
    const res = await ok("ultrasearch_gather", { question: "x", backends: ["fixture"], out: mkdtempSync(join(tmpdir(), "us-depth-")) });
    expect(res.depth).toBe("standard");
    temps.push(String(res.run));
  });

  it("rejects an unknown backend at the schema, before any work starts", async () => {
    // The declared enum catches this, so it comes back as a protocol error
    // rather than a tool result — which is right: the client sent something
    // the schema it was given forbids.
    expect((await call("ultrasearch_gather", { question: "x", backends: ["nope"] })).error).toMatchObject({ code: -32602 });
  });

  it("rejects a relative out path", async () => {
    expect(await errorText("ultrasearch_gather", { question: "x", out: "relative/dir" })).toMatch(/must be an absolute path/);
  });
});

describe("search", () => {
  it("returns results and says nothing was written", async () => {
    const res = await ok("ultrasearch_search", { query: "rate limiting", backend: "fixture" });
    expect(Array.isArray(res.results)).toBe(true);
    expect(String(res.next)).toMatch(/Nothing was written/);
  });

  it("requires a backend rather than inventing one", async () => {
    // There is no general "web" token: a broad sweep is gather's job, and a
    // default here would silently send every caller to one arbitrary engine.
    expect((await call("ultrasearch_search", { query: "x" })).error).toMatchObject({ code: -32602 });
  });
});

describe("the citation gate", () => {
  it("fails a report whose citation does not resolve — as a verdict, not an error", async () => {
    writeFileSync(join(RUN, "REPORT.md"), "# R\n\nA claim with a bogus citation [S99].\n");
    const res = await ok("ultrasearch_check", { run: RUN });
    expect(res.ok).toBe(false);
  });

  it("reports a dossier that is not there, naming the tool that makes one", async () => {
    const empty = mkdtempSync(join(tmpdir(), "us-empty-"));
    temps.push(empty);
    expect(await errorText("ultrasearch_check", { run: empty })).toMatch(/no dossier at .*ultrasearch_gather/s);
  });

  it("requires an absolute run path", async () => {
    expect(await errorText("ultrasearch_check", { run: "relative" })).toMatch(/must be an absolute path/);
  });
});

describe("read", () => {
  it("returns a line window and reports the real total", async () => {
    const res = await ok("ultrasearch_read", { run: RUN, path: "DOSSIER.md", start_line: 1, end_line: 3 });
    expect(res.start_line).toBe(1);
    expect(String(res.content).split("\n").length).toBeLessThanOrEqual(3);
  });

  it("refuses a path outside the dossier", async () => {
    // Containment is the whole point: this server can be reached over HTTP.
    expect(await errorText("ultrasearch_read", { run: RUN, path: "/etc/passwd" })).toMatch(/outside the dossier/);
    expect(await errorText("ultrasearch_read", { run: RUN, path: "../../etc/passwd" })).toMatch(/outside the dossier|no such file/);
  });
});

describe("plan and merge", () => {
  it("plans sub-questions with their own directories", async () => {
    const res = await ok("ultrasearch_plan", { question: "how do async runtimes compare?", mode: "research" });
    expect(String(res.next)).toMatch(/ultrasearch_merge/);
  });

  it("refuses to merge a directory that is not a dossier", async () => {
    const notADossier = mkdtempSync(join(tmpdir(), "us-nd-"));
    temps.push(notADossier);
    expect(await errorText("ultrasearch_merge", { runs: [notADossier] })).toMatch(/no dossier at/);
  });

  it("requires runs to be absolute", async () => {
    expect(await errorText("ultrasearch_merge", { runs: ["rel/dir"] })).toMatch(/absolute paths/);
  });
});

describe("render", () => {
  it("refuses a call that would render nothing", async () => {
    expect(await errorText("ultrasearch_render", { run: RUN, no_html: true, no_md: true })).toMatch(/nothing left to render/);
  });
});

describe("guardrails", () => {
  it("uses the server's default dossier when the caller omits one", async () => {
    const withDefault = createServer({ defaultRun: RUN });
    let out: JsonRpcMessage | undefined;
    await withDefault.handle({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "ultrasearch_read", arguments: { path: "DOSSIER.md" } } }, (m) => {
      out = m;
    });
    const result = out!.result as { content: { text: string }[]; isError?: boolean };
    expect(result.isError).toBeFalsy();
    expect(JSON.parse(result.content[0]!.text).total_lines).toBeTypeOf("number");
  });

  it("rejects a non-http url", async () => {
    expect(await errorText("ultrasearch_fetch", { run: RUN, url: "file:///etc/passwd" })).toMatch(/absolute http\(s\) URL/);
  });

  it("rejects a shard outside its shard count", async () => {
    expect(await errorText("ultrasearch_verify", { run: RUN, shards: 2, shard: 5 })).toMatch(/`shard` must be between 0 and 1/);
  });
});
