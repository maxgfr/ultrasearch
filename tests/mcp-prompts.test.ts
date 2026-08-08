import { describe, it, expect } from "vitest";
import { getPrompt, PROMPTS, PromptError, unknownToolNamesIn, toolNamesReferencedBy } from "../src/mcp/prompts.js";

describe("prompt declarations", () => {
  it("names every prompt uniquely and describes what it is for", () => {
    const names = PROMPTS.map((p) => p.name);
    expect(new Set(names).size).toBe(names.length);
    for (const p of PROMPTS) {
      expect(p.name, p.name).toMatch(/^[a-z][a-z0-9_]*$/);
      expect(p.title, p.name).toBeTruthy();
      expect(p.description, p.name).toBeTruthy();
      expect(p.description?.length ?? 0, p.name).toBeGreaterThan(60);
    }
  });

  it("documents every argument", () => {
    for (const p of PROMPTS) {
      expect(p.arguments, p.name).toBeTruthy();
      for (const a of p.arguments ?? []) {
        expect(a.description, `${p.name}.${a.name}`).toBeTruthy();
        expect(a.name, `${p.name}.${a.name}`).toMatch(/^[a-z][a-z0-9_]*$/);
      }
    }
  });
});

describe("prompts/get", () => {
  const args = { question: "how do rust async runtimes compare?", error: "TypeError: x is not a function" };

  it("renders every prompt from its required arguments", () => {
    for (const p of PROMPTS) {
      const got = getPrompt(p.name, args);
      expect(got.description, p.name).toBe(p.description);
      expect(got.messages.length, p.name).toBeGreaterThan(0);
      expect(got.messages[0]!.role, p.name).toBe("user");
      expect(got.messages[0]!.content.type, p.name).toBe("text");
      expect(got.messages[0]!.content.text.length, p.name).toBeGreaterThan(400);
    }
  });

  it("interpolates the arguments it was given", () => {
    const text = getPrompt("research_topic", args).messages[0]!.content.text;
    expect(text).toContain("how do rust async runtimes compare?");
  });

  it("mentions optional arguments only when they are supplied", () => {
    const without = getPrompt("research_topic", args).messages[0]!.content.text;
    expect(without).not.toContain('depth: "deep"');

    const deep = getPrompt("research_topic", { ...args, depth: "deep" }).messages[0]!.content.text;
    expect(deep).toContain('depth: "deep"');
  });

  it("carries the debugging context into the bug workflow when given one", () => {
    const bare = getPrompt("debug_error", args).messages[0]!.content.text;
    expect(bare).toContain("TypeError: x is not a function");
    expect(bare).not.toContain("Context:");

    const withCtx = getPrompt("debug_error", { ...args, context: "vite 5.2" }).messages[0]!.content.text;
    expect(withCtx).toContain("vite 5.2");
  });

  it("rejects an unknown prompt", () => {
    expect(() => getPrompt("nope", args)).toThrow(PromptError);
  });

  it("rejects a missing required argument", () => {
    expect(() => getPrompt("research_topic", {})).toThrow(/`question` is required/);
    expect(() => getPrompt("debug_error", { question: "x" })).toThrow(/`error` is required/);
    // Whitespace is not an argument.
    expect(() => getPrompt("research_topic", { question: "   " })).toThrow(/`question` is required/);
  });
});

describe("prompts stay honest about the tools", () => {
  const args = { question: "q", error: "boom" };

  it("never tells the model to call a tool that is not declared", () => {
    // The failure this catches: a tool gets renamed, the prompt keeps naming
    // the old one, and every host following the prompt fails on a tool that
    // does not exist. Nobody notices, because the prompt still reads fine.
    for (const p of PROMPTS) {
      const text = getPrompt(p.name, args).messages[0]!.content.text;
      expect(unknownToolNamesIn(text), `${p.name} names undeclared tools`).toEqual([]);
    }
  });

  it("gives each workflow a real tool sequence, ending at the citation gate", () => {
    for (const p of PROMPTS) {
      const text = getPrompt(p.name, args).messages[0]!.content.text;
      const referenced = toolNamesReferencedBy(text);
      expect(referenced.length, `${p.name} names no tools at all`).toBeGreaterThan(2);
      expect(referenced, `${p.name} never reaches the gate`).toContain("ultrasearch_check");
    }
  });

  it("carries the core rule into every workflow", () => {
    // Every prompt must state the do-not-answer-from-memory rule. A workflow
    // that lists tools without it is the failure mode this whole primitive
    // exists to prevent.
    for (const p of PROMPTS) {
      const text = getPrompt(p.name, args).messages[0]!.content.text;
      expect(text, p.name).toContain("Answer only from the sources this dossier actually fetched");
      expect(text, p.name).toMatch(/ok: false|VERDICT/);
    }
  });
});
