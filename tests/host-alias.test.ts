import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { buildGatherOptions, parseCli as parseArgs } from "../src/cli.js";
import { callTool } from "../src/mcp/handlers.js";
import { TOOLS } from "../src/mcp/tools.js";
import { validateArgs } from "../src/engine.js";
import { readDossier } from "../src/dossier.js";
import { buildWorklist } from "../src/verify.js";
import { runCheck } from "../src/check.js";
import { canonicalBackend } from "../src/types.js";
import { writeFixtureDossier } from "./dossierfix.js";

// The host-search lane was called `claude` before it was renamed `host`. The
// old name keeps working as input, and dossiers written under it still read.

afterEach(() => vi.restoreAllMocks());

describe("canonicalBackend", () => {
  it("maps the deprecated `claude` onto `host` and leaves every other name alone", () => {
    expect(canonicalBackend("claude")).toBe("host");
    expect(canonicalBackend("host")).toBe("host");
    expect(canonicalBackend("duckduckgo")).toBe("duckduckgo");
    // Not an own key of the alias table: no prototype lookup leaks through.
    expect(canonicalBackend("constructor")).toBe("constructor");
  });
});

describe("CLI — `claude` is a deprecated alias of `host`", () => {
  it("accepts --web-engine claude as host, with a one-line deprecation note", () => {
    const err = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    expect(buildGatherOptions(parseArgs(["gather", "--q", "x", "--web-engine", "claude"])).webEngine).toBe("host");
    expect(err.mock.calls.map((c) => String(c[0])).join("")).toMatch(/--web-engine claude is deprecated — use host/);
  });

  it("accepts --backends claude as host", () => {
    vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    expect(buildGatherOptions(parseArgs(["gather", "--q", "x", "--backends", "claude,wikipedia,host"])).backends).toEqual(["host", "wikipedia"]);
  });

  it("takes --web-engine host without any note", () => {
    const err = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    expect(buildGatherOptions(parseArgs(["gather", "--q", "x", "--web-engine", "host"])).webEngine).toBe("host");
    expect(err).not.toHaveBeenCalled();
  });
});

describe("MCP — `claude` is a deprecated alias of `host`", () => {
  it("lets the schema accept the old spelling, so validation does not reject an older client", () => {
    const gather = TOOLS.find((t) => t.name === "ultrasearch_gather")!;
    expect(validateArgs(gather.inputSchema, { question: "x", web_engine: "claude" })).toBeUndefined();
    expect(validateArgs(gather.inputSchema, { question: "x", web_engine: "host" })).toBeUndefined();
    const search = TOOLS.find((t) => t.name === "ultrasearch_search")!;
    expect(validateArgs(search.inputSchema, { query: "x", backend: "claude" })).toBeUndefined();
  });

  it("runs backend / web_engine `claude` as the host lane", async () => {
    const res = JSON.parse(
      (
        await callTool("ultrasearch_search", {
          query: "rate limiting",
          backend: "claude",
          web_engine: "claude",
          web_results: [{ url: "https://a.test/one", title: "One" }],
        })
      ).text,
    ) as { backend: string; results: { url: string }[] };
    expect(res.backend).toBe("host");
    expect(res.results.map((r) => r.url)).toEqual(["https://a.test/one"]);
  });
});

describe("dossiers written before the rename", () => {
  function legacyDossier(): string {
    const dir = mkdtempSync(join(tmpdir(), "us-legacy-claude-"));
    writeFixtureDossier(dir, 2);
    const sources = JSON.parse(readFileSync(join(dir, "sources.json"), "utf8"));
    sources[0].backend = "claude";
    writeFileSync(join(dir, "sources.json"), JSON.stringify(sources, null, 2));
    const manifest = JSON.parse(readFileSync(join(dir, "manifest.json"), "utf8"));
    Object.assign(manifest, {
      backends: ["claude", "duckduckgo"],
      backendsUsed: ["claude", "duckduckgo"],
      enginesFused: ["claude"],
      timings: { claude: 4, duckduckgo: 9, total: 13 },
    });
    writeFileSync(join(dir, "manifest.json"), JSON.stringify(manifest, null, 2));
    return dir;
  }

  it("reads a stored `claude` label as `host`, in sources and manifest alike", () => {
    const dir = legacyDossier();
    try {
      const { sources, manifest } = readDossier(dir);
      expect(sources.map((s) => s.backend)).toEqual(["host", "duckduckgo"]);
      expect(manifest.backends).toEqual(["host", "duckduckgo"]);
      expect(manifest.backendsUsed).toEqual(["host", "duckduckgo"]);
      expect(manifest.enginesFused).toEqual(["host"]);
      expect(manifest.timings).toEqual({ host: 4, duckduckgo: 9, total: 13 });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("still checks and verifies a legacy dossier", () => {
    const dir = legacyDossier();
    try {
      writeFileSync(join(dir, "REPORT.md"), "# Report\n\nRate limiting caps requests per window [S1].\n\n## Open questions\n\n> [model-hint] none.\n");
      const check = runCheck(dir);
      expect(check.errors.filter((e) => /claude|host|backend/i.test(e))).toEqual([]);
      const built = buildWorklist(dir, { keysOnly: true });
      expect(built.total).toBeGreaterThan(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
