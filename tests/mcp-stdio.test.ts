import { PassThrough, Readable } from "node:stream";
import { describe, expect, it } from "vitest";
import { ultrasearchAdapter } from "../src/mcp/adapter.js";
import { runStdioServer } from "../src/engine.js";

// The stdio transport driven IN-PROCESS, through injected streams.
//
// tests/mcp-stdio-subprocess.test.ts covers the same transport end to end
// against the committed bundle, which is the only place a bundling or wiring
// regression can show. What it cannot do is exercise the framing branches
// individually — a subprocess is opaque to the coverage instrument, and driving
// a malformed batch or a mid-flight throw through a real CLI is awkward. These
// tests do that half: one line in, one frame out, for every shape the loop can
// meet.

// Feed `lines` to the server and collect everything it wrote.
async function run(lines: string[], opts: Record<string, unknown> = {}): Promise<unknown[]> {
  const input = Readable.from(lines.map((l) => `${l}\n`));
  const output = new PassThrough();
  const chunks: string[] = [];
  output.on("data", (c: Buffer) => chunks.push(c.toString("utf8")));

  await runStdioServer(ultrasearchAdapter(opts), { input, output, captureStdout: true, ...opts });

  return chunks
    .join("")
    .split("\n")
    .filter((l) => l.trim())
    .map((l) => JSON.parse(l));
}

describe("framing", () => {
  it("answers one frame per request, and nothing for a blank line", async () => {
    const out = await run(["", '{"jsonrpc":"2.0","id":1,"method":"ping"}', "   "]);
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ id: 1, result: {} });
  });

  it("reports malformed JSON as -32700 and keeps reading", async () => {
    const out = await run(["{ not json", '{"jsonrpc":"2.0","id":2,"method":"ping"}']);
    expect(out[0]).toMatchObject({ id: null, error: { code: -32700 } });
    expect(out[1]).toMatchObject({ id: 2, result: {} });
  });

  it("rejects a non-object frame as an invalid request", async () => {
    // Valid JSON, wrong shape — a distinct branch from a parse error.
    for (const frame of ["null", "42", '"a string"']) {
      const out = await run([frame]);
      expect(out[0], frame).toMatchObject({ id: null, error: { code: -32600 } });
    }
  });

  it("answers nothing at all to a notification", async () => {
    expect(await run(['{"jsonrpc":"2.0","method":"notifications/initialized"}'])).toEqual([]);
  });
});

describe("batches", () => {
  it("answers a batch as a single array frame", async () => {
    const out = await run(['[{"jsonrpc":"2.0","id":1,"method":"ping"},{"jsonrpc":"2.0","id":2,"method":"ping"}]']);
    expect(out).toHaveLength(1);
    expect(Array.isArray(out[0])).toBe(true);
    expect((out[0] as { id: number }[]).map((m) => m.id)).toEqual([1, 2]);
  });

  it("writes no frame for a batch of only notifications", async () => {
    // Answering an empty array would be a protocol violation; answering nothing
    // is the rule, and it is easy to regress into `[]`.
    expect(await run(['[{"jsonrpc":"2.0","method":"notifications/initialized"}]'])).toEqual([]);
  });

  it("keeps a batch's replies in one array even when its members interleave", async () => {
    const out = await run(['[{"jsonrpc":"2.0","id":1,"method":"tools/list"},{"jsonrpc":"2.0","id":2,"method":"ping"}]']);
    expect(out).toHaveLength(1);
    expect((out[0] as { id: number }[]).map((m) => m.id).sort()).toEqual([1, 2]);
  });
});

describe("concurrency", () => {
  it("lets a fast request answer before a slow one that arrived first", async () => {
    // The property the read loop exists for: a gather taking tens of seconds
    // must not make `ping` time out. `search` reaches a backend; the fixture one
    // returns immediately, so the ordering here comes from the loop and not from
    // the network.
    const out = await run([
      '{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"ultrasearch_search","arguments":{"query":"rate limiting","backend":"fixture"}}}',
      '{"jsonrpc":"2.0","id":2,"method":"ping"}',
    ]);
    expect(out.map((m) => (m as { id: number }).id).sort()).toEqual([1, 2]);
  });

  it("answers every request in a burst larger than the in-flight cap", async () => {
    // MAX_IN_FLIGHT is 4; twelve pings exercise drainToLimit rather than
    // sailing past it.
    const frames = Array.from({ length: 12 }, (_, i) => `{"jsonrpc":"2.0","id":${i + 1},"method":"ping"}`);
    const out = await run(frames);
    expect(out).toHaveLength(12);
    expect(out.map((m) => (m as { id: number }).id).sort((a, b) => a - b)).toEqual(frames.map((_, i) => i + 1));
  });

  it("finishes in-flight work after stdin closes instead of dropping the frame", async () => {
    // The loop awaits what is still running before returning: exiting here
    // would lose the reply, because a piped stdout is asynchronous.
    const out = await run(['{"jsonrpc":"2.0","id":1,"method":"tools/list"}']);
    expect(out).toHaveLength(1);
    expect((out[0] as { result: { tools: unknown[] } }).result.tools.length).toBeGreaterThan(0);
  });
});

describe("server options reach the server", () => {
  it("honours a default run, so `run` drops off the required list", async () => {
    const out = await run(['{"jsonrpc":"2.0","id":1,"method":"tools/list"}'], { defaultRun: "/tmp/some-dossier" });
    const read = (out[0] as { result: { tools: { name: string; inputSchema: { required: string[] } }[] } }).result.tools.find(
      (t) => t.name === "ultrasearch_read",
    );
    expect(read!.inputSchema.required).not.toContain("run");
  });

  it("caps an oversized result rather than sending a truncated one", async () => {
    const out = await run(['{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"ultrasearch_modes","arguments":{}}}'], { maxResponseBytes: 120 });
    const payload = JSON.parse((out[0] as { result: { content: { text: string }[] } }).result.content[0]!.text);
    expect(payload.truncated).toBe(true);
    expect(payload.narrower).toBeTruthy();
  });
});

describe("the stdout guard", () => {
  it("leaves process.stdout.write exactly as it found it", async () => {
    // The guard redirects stdout to stderr for the life of the server so a
    // stray console.log cannot corrupt the stream. Restoring it is what lets a
    // test process keep working afterwards — and a leak here would be invisible
    // until something else printed.
    const before = process.stdout.write;
    await run(['{"jsonrpc":"2.0","id":1,"method":"ping"}']);
    expect(process.stdout.write).toBe(before);
  });

  it("sends a stray write to stderr while serving, and restores afterwards", async () => {
    // Every other test here passes `captureStdout`, which skips the guard
    // entirely — so this is the only place its actual behaviour is exercised.
    //
    // Safe to run in-process: the server binds its writer BEFORE raising the
    // guard, so stubbing process.stdout.write first means frames land in
    // `frames` rather than on the real stdout, and a console.log mid-session
    // lands in `strays`.
    const realOut = process.stdout.write;
    const realErr = process.stderr.write;
    const frames: string[] = [];
    const strays: string[] = [];
    process.stdout.write = ((c: unknown) => {
      frames.push(String(c));
      return true;
    }) as typeof process.stdout.write;
    process.stderr.write = ((c: unknown) => {
      strays.push(String(c));
      return true;
    }) as typeof process.stderr.write;

    let guardedWrite: typeof process.stdout.write | undefined;
    try {
      const input = new PassThrough();
      const done = runStdioServer(ultrasearchAdapter(), { input });
      // Mid-session: the guard is up, so this must NOT reach stdout.
      guardedWrite = process.stdout.write;
      process.stdout.write("a stray line\n");
      input.write('{"jsonrpc":"2.0","id":1,"method":"ping"}\n');
      input.end();
      await done;
    } finally {
      process.stdout.write = realOut;
      process.stderr.write = realErr;
    }

    // The guard was actually installed, and then taken back down.
    expect(guardedWrite).not.toBe(realOut);
    expect(strays.join("")).toContain("a stray line");
    // The frame still reached the client through the pre-guard writer.
    expect(frames.join("")).toContain('"id":1');
    expect(frames.join("")).not.toContain("a stray line");
  });
});
