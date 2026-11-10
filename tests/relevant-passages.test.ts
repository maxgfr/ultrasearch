import { describe, expect, it } from "vitest";
import { buildSource, renderSourceExtract } from "../src/dossier.js";
import { windowEnd } from "../src/passages.js";

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

describe("windowEnd", () => {
  // The rule as it was first written: search the WHOLE text backwards. Correct,
  // and quadratic on a text with no boundary. The bounded search must cut every
  // window at exactly the same place.
  const reference = (text: string, start: number): number => {
    let end = Math.min(text.length, start + 800);
    if (end < text.length) {
      const boundary = Math.max(text.lastIndexOf("\n", end), text.lastIndexOf(". ", end));
      if (boundary > start + 400) end = boundary + 1;
      else if (/[\uD800-\uDBFF]/.test(text[end - 1]!)) end--;
    }
    return end;
  };
  // A small deterministic generator: the texts must be the same on every run.
  const rng = (seed: number) => () => {
    seed = (seed * 1664525 + 1013904223) >>> 0;
    return seed / 2 ** 32;
  };

  it("ends every window where the unbounded search ended it", () => {
    const next = rng(42);
    const pieces = ["word ", "longerword ", "x", ". ", ".", "\n", "\n\n", "😀", "é ", "a. b ", " "];
    for (let round = 0; round < 40; round++) {
      // Sparse boundaries on some rounds, none at all on others.
      const boundaryRate = round % 4 === 0 ? 0 : 0.002 * round;
      let text = "";
      while (text.length < 6000) {
        const r = next();
        text += r < boundaryRate ? pieces[3 + Math.floor(next() * 4)]! : pieces[Math.floor(next() * 3)]!;
        if (next() < 0.01) text += pieces[7 + Math.floor(next() * 4)]!;
      }
      for (let start = 0; start < text.length; start = windowEnd(text, start)) {
        expect(windowEnd(text, start), `round ${round}, start ${start}`).toBe(reference(text, start));
      }
    }
  });

  it("puts a boundary sitting exactly on either edge of the search on the right side", () => {
    const at = (i: number, piece: string) => "a".repeat(i) + piece + "a".repeat(2000 - i - piece.length);
    for (const i of [399, 400, 401, 402, 798, 799, 800, 801]) {
      for (const piece of ["\n", ". "]) expect(windowEnd(at(i, piece), 0), `${JSON.stringify(piece)} at ${i}`).toBe(reference(at(i, piece), 0));
    }
  });
});
