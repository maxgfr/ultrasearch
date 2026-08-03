import { describe, expect, it } from "vitest";
import { runWithInput, binaryName } from "../src/backends/pdf/exec.js";

// `node` itself is the one binary guaranteed to exist wherever these tests run,
// so every case drives it rather than a tool that may or may not be installed
// (which is exactly the non-determinism the PDF ladder's own tests avoid).
const NODE = process.execPath;
const script = (body: string) => ["--input-type=module", "-e", body];

describe("runWithInput", () => {
  it("pipes the input to stdin and returns stdout", async () => {
    const r = await runWithInput(NODE, script("process.stdin.pipe(process.stdout)"), Buffer.from("a PDF's bytes"), 30_000);
    expect(r.ok).toBe(true);
    expect(r.stdout).toBe("a PDF's bytes");
  });

  it("reports a non-zero exit instead of throwing", async () => {
    const r = await runWithInput(NODE, script("process.exit(3)"), Buffer.alloc(0), 30_000);
    expect(r.ok).toBe(false);
    expect(r.error).toBe("exit 3");
  });

  // The ladder turns this into "rung unavailable" and remembers it, which is how
  // a machine without npm or poppler still gets an answer.
  it("reports a missing binary as `not installed`", async () => {
    const r = await runWithInput("ultrasearch-no-such-binary-xyz", [], Buffer.alloc(0), 30_000);
    expect(r.ok).toBe(false);
    expect(r.error).toBe("not installed");
  });

  it("kills a hung tool at the timeout rather than hanging the run", async () => {
    const r = await runWithInput(NODE, script("setTimeout(() => {}, 60_000)"), Buffer.alloc(0), 300);
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/timed out after/);
  });

  // A tool that rejects the input closes stdin early; the resulting EPIPE must
  // not surface as a crash.
  it("survives a tool that closes stdin without reading it", async () => {
    const big = Buffer.alloc(2 * 1024 * 1024, 0x41);
    const r = await runWithInput(NODE, script("process.stdout.write('done'); process.stdin.destroy();"), big, 30_000);
    expect(r.stdout).toContain("done");
  });

  it("drains stderr so a chatty tool cannot deadlock on a full pipe", async () => {
    const r = await runWithInput(NODE, script("process.stderr.write('x'.repeat(200_000)); process.stdout.write('ok')"), Buffer.alloc(0), 30_000);
    expect(r.ok).toBe(true);
    expect(r.stdout).toBe("ok");
  });
});

describe("binaryName", () => {
  const platform = process.platform;
  const setPlatform = (p: string) => Object.defineProperty(process, "platform", { value: p, configurable: true });

  it("passes names through unchanged off Windows", () => {
    setPlatform("darwin");
    expect(binaryName("npx")).toBe("npx");
    expect(binaryName("pdftotext")).toBe("pdftotext");
    setPlatform(platform);
  });

  // Windows ships npx as a .cmd shim, which `spawn` will not resolve on its own.
  it("resolves npx to its .cmd shim on Windows", () => {
    setPlatform("win32");
    expect(binaryName("npx")).toBe("npx.cmd");
    expect(binaryName("pdftotext")).toBe("pdftotext"); // a real .exe needs no shim
    setPlatform(platform);
  });
});
