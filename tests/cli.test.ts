import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { parseArgs } from "../src/cli.js";

// parseArgs calls process.exit on help/version/errors; make it throw so we can
// assert on it without killing the test runner, and silence the writes.
beforeEach(() => {
  vi.spyOn(process, "exit").mockImplementation(((code?: number) => {
    throw new Error(`exit:${code ?? 0}`);
  }) as never);
  vi.spyOn(process.stdout, "write").mockImplementation(() => true);
  vi.spyOn(process.stderr, "write").mockImplementation(() => true);
});
afterEach(() => vi.restoreAllMocks());

describe("parseArgs", () => {
  it("parses a command, value flags (--k v) and bool flags", () => {
    const p = parseArgs(["gather", "--q", "hello world", "--mode", "bug", "--json"]);
    expect(p.command).toBe("gather");
    expect(p.values.q).toBe("hello world");
    expect(p.values.mode).toBe("bug");
    expect(p.bools.has("json")).toBe(true);
  });

  it("parses --k=v form", () => {
    const p = parseArgs(["gather", "--q=hi", "--depth=deep"]);
    expect(p.values.q).toBe("hi");
    expect(p.values.depth).toBe("deep");
  });

  it("rejects an unknown command", () => {
    expect(() => parseArgs(["frobnicate"])).toThrow(/exit:1/);
  });

  it("rejects an unknown flag", () => {
    expect(() => parseArgs(["gather", "--nope", "x"])).toThrow(/exit:1/);
  });

  it("rejects a value given to a boolean flag", () => {
    expect(() => parseArgs(["gather", "--json=1"])).toThrow(/exit:1/);
  });

  it("rejects a missing value at end of argv", () => {
    expect(() => parseArgs(["gather", "--q"])).toThrow(/exit:1/);
  });

  it("exits 0 on --help and --version", () => {
    expect(() => parseArgs(["--help"])).toThrow(/exit:0/);
    expect(() => parseArgs(["-v"])).toThrow(/exit:0/);
  });
});
