import { describe, it, expect } from "vitest";
import { TOOLS, WRITE_TOOLS, TOOL_META, annotationsFor, toolsFor } from "../src/mcp/tools.js";
import { validateArgs } from "../src/engine.js";
import { ALL_BACKENDS, ALL_DEPTHS, ALL_MODES } from "../src/types.js";
import { readFileSync } from "node:fs";

const ALL = [...TOOLS, ...WRITE_TOOLS];

describe("tool declarations", () => {
  it("documents every advertised MCP tool in the README", () => {
    const readme = readFileSync(new URL("../README.md", import.meta.url), "utf8");
    const section = readme.match(/### Tools\n([\s\S]*?)\n### /)?.[1] ?? "";
    const documented = [...section.matchAll(/\| `(ultrasearch_[a-z_]+)` \|/g)].map((match) => match[1]).sort();
    const advertised = ALL.map((tool) => tool.name).sort();

    expect(documented).toEqual(advertised);
    expect(section).toContain(`${advertised.length} tools.`);
  });

  it("names every tool consistently and uniquely", () => {
    const names = ALL.map((t) => t.name);
    expect(new Set(names).size).toBe(names.length);
    for (const n of names) expect(n).toMatch(/^ultrasearch_[a-z_]+$/);
  });

  it("declares a well-formed object schema whose required properties exist", () => {
    for (const t of ALL) {
      expect(t.inputSchema.type, t.name).toBe("object");
      expect(Array.isArray(t.inputSchema.required), t.name).toBe(true);
      for (const r of t.inputSchema.required) {
        expect(Object.keys(t.inputSchema.properties), `${t.name}.required lists "${r}"`).toContain(r);
      }
      for (const [key, spec] of Object.entries(t.inputSchema.properties)) {
        expect(spec.description, `${t.name}.${key} has no description`).toBeTruthy();
      }
    }
  });

  it("gives every tool a description that says what it is for", () => {
    for (const t of ALL) {
      expect(t.description.length, t.name).toBeGreaterThan(80);
      expect(t.title, t.name).toBeTruthy();
    }
  });

  it("keeps the mode, depth and backend enums in sync with what the engine accepts", () => {
    // The schema cannot advertise a spelling the engine would reject, nor omit
    // one it would have understood.
    const gather = TOOLS.find((t) => t.name === "ultrasearch_gather")!;
    expect([...gather.inputSchema.properties.mode!.enum!].sort()).toEqual([...ALL_MODES].sort());
    expect([...gather.inputSchema.properties.depth!.enum!].sort()).toEqual([...ALL_DEPTHS].sort());
    expect([...gather.inputSchema.properties.backends!.enum!].sort()).toEqual([...ALL_BACKENDS].sort());

    const search = TOOLS.find((t) => t.name === "ultrasearch_search")!;
    expect([...search.inputSchema.properties.backend!.enum!].sort()).toEqual([...ALL_BACKENDS].sort());
  });

  it("warns about wall-clock on the tool that can run for twenty minutes", () => {
    // An MCP client times out long before a deep gather finishes. The
    // description is the only place it can find that out before committing.
    const gather = TOOLS.find((t) => t.name === "ultrasearch_gather")!;
    expect(gather.description).toMatch(/SLOW/);
    expect(gather.description).toMatch(/10-20 minutes/);
    expect(gather.inputSchema.properties.depth!.description).toMatch(/standard/);
  });

  it("says out loud that retrieval returns sources, not an answer", () => {
    expect(TOOLS.find((t) => t.name === "ultrasearch_gather")!.description).toMatch(/citing \[S#\]/);
  });

  it("declares an outputSchema only where the result shape is small and stable", () => {
    expect(ALL.filter((t) => t.outputSchema).map((t) => t.name)).toEqual(["ultrasearch_read"]);
  });
});

describe("annotations", () => {
  // Asserted tool by tool: a new tool with no expected row fails here rather
  // than sliding in unannotated.
  const EXPECTED: Record<string, { readOnlyHint: boolean; openWorldHint: boolean; destructiveHint?: boolean; idempotentHint?: boolean }> = {
    ultrasearch_search: { readOnlyHint: true, openWorldHint: true },
    ultrasearch_gather: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    ultrasearch_fetch: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    ultrasearch_ingest: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    ultrasearch_check: { readOnlyHint: true, openWorldHint: false },
    ultrasearch_relink: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    ultrasearch_verify: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    ultrasearch_render: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    ultrasearch_plan: { readOnlyHint: true, openWorldHint: false },
    ultrasearch_merge: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    ultrasearch_brainstorm: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    ultrasearch_modes: { readOnlyHint: true, openWorldHint: false },
    ultrasearch_read: { readOnlyHint: true, openWorldHint: false },
  };

  it("annotates every declared tool, and only declared tools", () => {
    expect(Object.keys(TOOL_META).sort()).toEqual(ALL.map((t) => t.name).sort());
    expect(Object.keys(EXPECTED).sort()).toEqual(ALL.map((t) => t.name).sort());
  });

  it("matches the expected hint matrix", () => {
    for (const [name, want] of Object.entries(EXPECTED)) {
      expect(annotationsFor(name), name).toEqual(want);
    }
  });

  it("marks every tool that reaches the network as open-world", () => {
    // A client that batches or caches read-only calls must be told which ones
    // depend on the outside world.
    const openWorld = ALL.filter((t) => TOOL_META[t.name]!.openWorld).map((t) => t.name);
    expect(openWorld.sort()).toEqual(["ultrasearch_fetch", "ultrasearch_gather", "ultrasearch_ingest", "ultrasearch_search"]);
  });

  it("declares nothing destructive — no tool here removes a dossier", () => {
    expect(ALL.filter((t) => TOOL_META[t.name]!.destructive)).toEqual([]);
    expect(WRITE_TOOLS).toEqual([]);
  });
});

describe("toolsFor", () => {
  it("gates rich fields and annotations on the negotiated protocol version", () => {
    const old = toolsFor("2024-11-05").find((t) => t.name === "ultrasearch_read")!;
    expect(old.annotations).toBeUndefined();
    expect(old.title).toBeUndefined();
    expect(old.outputSchema).toBeUndefined();

    const now = toolsFor("2025-06-18").find((t) => t.name === "ultrasearch_read")!;
    expect(now.annotations).toBeTruthy();
    expect(now.title).toBeTruthy();
    expect(now.outputSchema).toBeTruthy();
  });

  it("makes `run` optional, and says so, when the server has a default dossier", () => {
    for (const t of toolsFor("2025-06-18", { defaultRun: "/tmp/dossier" })) {
      if (!t.inputSchema.properties.run) continue;
      expect(t.inputSchema.required, t.name).not.toContain("run");
      expect(t.inputSchema.properties.run.description, t.name).toContain("/tmp/dossier");
    }
  });

  it("leaves the schema untouched without a default dossier", () => {
    const read = toolsFor("2025-06-18").find((t) => t.name === "ultrasearch_read")!;
    expect(read.inputSchema.required).toContain("run");
  });
});

describe("declared schemas accept what the handlers expect", () => {
  it("validates a representative call per tool", () => {
    const sample: Record<string, Record<string, unknown>> = {
      ultrasearch_search: { query: "rust async", backend: "duckduckgo", max_sources: 5 },
      ultrasearch_gather: {
        question: "rust async",
        mode: "topic",
        depth: "summary",
        web_results: [{ url: "https://example.com/a", title: "A" }],
        search: "light",
        web_engine: "claude",
      },
      ultrasearch_fetch: { run: "/tmp/d", url: "https://example.com", cite_url: "https://example.com/page" },
      ultrasearch_ingest: { run: "/tmp/d", web_results: [{ url: "https://example.com/a" }], urls: ["https://example.com/b"] },
      ultrasearch_check: { run: "/tmp/d", semantic: true, min_sources: 3 },
      ultrasearch_relink: { run: "/tmp/d", id: "S12", url: "https://example.com/a" },
      ultrasearch_verify: { run: "/tmp/d", max_verify: 10, shards: 2, shard: 0 },
      ultrasearch_render: { run: "/tmp/d", no_html: true },
      ultrasearch_plan: { question: "rust async", mode: "research", subquestions: ["a", "b"] },
      ultrasearch_merge: { runs: ["/tmp/a", "/tmp/b"], master: "/tmp/m" },
      ultrasearch_brainstorm: { question: "vague", mode: "topic" },
      ultrasearch_modes: {},
      ultrasearch_read: { run: "/tmp/d", path: "DOSSIER.md", start_line: 1, end_line: 40 },
    };
    for (const t of ALL) {
      expect(validateArgs(t.inputSchema, sample[t.name]!), t.name).toBeUndefined();
    }
  });

  it("rejects a missing required argument and an out-of-enum value", () => {
    const gather = TOOLS.find((t) => t.name === "ultrasearch_gather")!;
    expect(validateArgs(gather.inputSchema, {})).toMatch(/`question` is required/);
    expect(validateArgs(gather.inputSchema, { question: "x", mode: "nope" })).toMatch(/mode/);
  });
});
