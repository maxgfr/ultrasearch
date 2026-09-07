import { describe, expect, it } from "vitest";
import { buildSource, renderSourceExtract } from "../src/dossier.js";

const question = "What does HTTP 429 mean and how does Retry-After work?";
const answer = "HTTP 429 means Too Many Requests. A Retry-After header indicates how long to wait before retrying.";
const source = buildSource(
  { url: "https://www.rfc-editor.org/rfc/rfc6585", title: "RFC 6585", backend: "generic", score: 1, snippet: "" },
  "S1",
  "2026-09-07",
  question,
);

describe("question-focused source extracts", () => {
  it.each(["summary", "standard"] as const)("retains a late answer and verifiable offsets at %s depth", (depth) => {
    const text = "Unrelated administrative introduction.\n".repeat(500) + answer + "\nEnd of section.";
    const output = renderSourceExtract(source, text, depth, question);
    expect(output).toContain(answer);
    expect(output).toContain("[Source passage:");
    expect(output).toContain("omitted");
    for (const match of output.matchAll(/\[Source passage: characters (\d+)-(\d+) of \d+\]\n([\s\S]*?)(?=\n\n\[|\n$)/g)) {
      expect(match[3]).toBe(text.slice(Number(match[1]) - 1, Number(match[2])));
    }
    expect(output.length).toBeLessThan((depth === "summary" ? 4000 : 8000) + 300);
  });

  it("finds the answer in a single long line", () => {
    const text = "Administrative background. ".repeat(600) + answer;
    expect(renderSourceExtract(source, text, "summary", question)).toContain(answer);
  });

  it("preserves surrogate pairs at both expanded context boundaries when written as UTF-8", () => {
    // The matching 800..1600 window expands to 640..1760: each bound cuts
    // an emoji unless the final context bounds are adjusted as well.
    const text = " ".repeat(639) + "😀" + " ".repeat(900 - 641) + "needle" + " ".repeat(1759 - 906) + "😀" + " ".repeat(6000 - 1761);
    const output = renderSourceExtract(source, text, "summary", "needle");
    const passages = [...output.matchAll(/\[Source passage: characters (\d+)-(\d+) of \d+\]\n([\s\S]*?)(?=\n\n\[|\n$)/g)];
    expect(passages).toHaveLength(1);
    const [, start, end, body] = passages[0]!;
    expect(body).toBe(text.slice(Number(start) - 1, Number(end)));
    expect(Buffer.from(body!, "utf8").toString("utf8")).toBe(body);
    expect(body?.match(/😀/g)).toHaveLength(2);
  });

  it("preserves short and deep extracts verbatim", () => {
    expect(renderSourceExtract(source, answer, "summary", question)).toContain(answer + "\n");
    const text = "Background.\n".repeat(2000) + answer;
    expect(renderSourceExtract(source, text, "deep", question)).toContain(text + "\n");
  });

  it("does not invent matches for an unrelated question and is deterministic", () => {
    const text = "Background information only.\n".repeat(500);
    const result = renderSourceExtract(source, text, "summary", "quantum entanglement");
    expect(result).not.toContain("[Source passage:");
    expect(result).toContain("[truncated]");
    expect(renderSourceExtract(source, text, "summary", "quantum entanglement")).toBe(result);
  });
});
