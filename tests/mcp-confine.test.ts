import { afterEach, describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { callTool } from "../src/mcp/handlers.js";
import { confineArgs } from "../src/mcp/confine.js";

const temps: string[] = [];
const temp = (): string => {
  const d = realpathSync(mkdtempSync(join(tmpdir(), "us-confine-")));
  temps.push(d);
  return d;
};
afterEach(() => {
  for (const d of temps.splice(0)) rmSync(d, { recursive: true, force: true });
});

describe("mcp --root", () => {
  it("changes nothing when no root is set", () => {
    const args = { run: "/anywhere/at/all" };
    expect(confineArgs("ultrasearch_check", args, undefined)).toBe(args);
  });

  it("refuses a path outside the root, by every argument that names one", () => {
    const root = temp();
    const outside = temp();
    for (const [name, args] of [
      ["ultrasearch_check", { run: outside }],
      ["ultrasearch_gather", { question: "q", out: join(outside, "d") }],
      ["ultrasearch_merge", { runs: [join(root, "a"), outside], master: join(root, "m") }],
      ["ultrasearch_merge", { runs: [join(root, "a")], master: outside }],
      ["ultrasearch_plan", { question: "q", run_root: outside }],
      ["ultrasearch_refcheck", { refs: join(outside, "refs.txt") }],
      ["ultrasearch_refcheck", { refs: join(root, "refs.txt"), citing: join(outside, "t.md") }],
      // `..` that climbs out is outside, however it is spelled.
      ["ultrasearch_check", { run: join(root, "..", "elsewhere") }],
    ] as const) {
      expect(() => confineArgs(name, args as Record<string, unknown>, root), `${name} ${JSON.stringify(args)}`).toThrow(
        /is outside the directory this server is confined to/,
      );
    }
  });

  it("follows a symlink: a link inside the root that points out of it is outside", () => {
    const root = temp();
    const outside = temp();
    symlinkSync(outside, join(root, "escape"));
    expect(() => confineArgs("ultrasearch_check", { run: join(root, "escape") }, root)).toThrow(/outside/);
    expect(() => confineArgs("ultrasearch_gather", { question: "q", out: join(root, "escape", "new", "dir") }, root)).toThrow(/outside/);
  });

  it("accepts the root itself and anything under it, existing or not", () => {
    const root = temp();
    mkdirSync(join(root, "d"));
    for (const run of [root, join(root, "d"), join(root, "d", "not", "yet")]) {
      expect(() => confineArgs("ultrasearch_check", { run }, root)).not.toThrow();
    }
  });

  it("puts the dossiers a tool creates by default inside the root", () => {
    const root = temp();
    const g = confineArgs("ultrasearch_gather", { question: "what is rate limiting", mode: "topic" }, root);
    expect(String(g.out).startsWith(join(root, "topic-what-is-rate-limiting"))).toBe(true);
    expect(String(confineArgs("ultrasearch_merge", { runs: [join(root, "a")] }, root).master).startsWith(join(root, "merge-"))).toBe(true);
    expect(String(confineArgs("ultrasearch_refcheck", { refs: join(root, "r.txt") }, root).out).startsWith(join(root, "refcheck-"))).toBe(true);
    expect(String(confineArgs("ultrasearch_brainstorm", { question: "q" }, root).out).startsWith(join(root, "brainstorm-"))).toBe(true);
  });

  it("refuses a server default dossier outside the root when the client relies on it, however `run` is left blank", () => {
    const root = temp();
    const outside = temp();
    for (const args of [{}, { run: null }, { run: "" }, { run: "  " }]) {
      expect(() => confineArgs("ultrasearch_check", args, root, outside), JSON.stringify(args)).toThrow(/the server's --run default/);
    }
  });

  it("refuses a relative path before anything is created from it", () => {
    const root = temp();
    for (const [key, value] of [
      ["out", "../ro"],
      ["master", "m"],
      ["run", "./d"],
    ] as const) {
      expect(() => confineArgs("ultrasearch_gather", { question: "q", [key]: value }, root)).toThrow(/must be an absolute path inside/);
    }
    expect(() => confineArgs("ultrasearch_merge", { runs: ["rel/dir"] }, root)).toThrow(/must be an absolute path inside/);
  });

  it("is enforced by callTool, end to end", async () => {
    const root = temp();
    const outside = temp();
    writeFileSync(join(outside, "refs.txt"), "1. Smith J. A title here. J A. 2020;1:1.\n2. Doe J. Another title. J B. 2021;2:2.\n");
    await expect(callTool("ultrasearch_refcheck", { refs: join(outside, "refs.txt"), offline: true }, { root })).rejects.toThrow(/outside/);
    const res = await callTool("ultrasearch_gather", { question: "what is rate limiting", backends: ["fixture"], depth: "summary" }, { root });
    expect(JSON.parse(res.text).run.startsWith(root)).toBe(true);
  });
});
