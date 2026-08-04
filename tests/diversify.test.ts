import { describe, expect, it } from "vitest";
import { diversify } from "../src/util.js";
import type { RawSource } from "../src/types.js";

// Measured on a real `topic` pool before this existed: eight content-marketing
// pages rewriting each other held ranks 6-20 while the WHATWG specification —
// the only source saying something none of them said — sat at 57. They were not
// near-duplicates (the SimHash collapse correctly left them alone); they were
// independent restatements, and relevance ranking has no defence against that.
//
// Raw Jaccard between two long documents is small even when redundant (0.25
// between those farms, 0.12 to everything else). The contrast is a clean 2x, so
// the fix was to normalise within the pool, not to weight diversity harder.

const src = (url: string, score: number, words: string[]): RawSource => ({
  url,
  title: url,
  backend: "duckduckgo",
  score,
  snippet: "",
  text: words.join(" "),
});

const rewrite = (n: number) => src(`https://farm${n}.test/x`, 0.9 - n * 0.01, ["streaming", "tokens", "latency", "browser", "connection", `filler${n}`]);
// Scored a little BELOW the rewrites, as a spec is: it uses the question's
// vocabulary less than an article written around the question. The gap is the
// realistic one — diversity is meant to overcome a small relevance deficit, not
// a large one, and a source far off the pace should stay far off the pace.
const distinct = src("https://spec.test/x", 0.82, ["normative", "grammar", "octet", "conformance", "registry", "algorithm"]);

describe("diversify — reorders, never removes", () => {
  it("returns exactly the same set, once each", () => {
    const items = [rewrite(0), rewrite(1), distinct, rewrite(2)];
    const out = diversify(items, (it) => new Set((it.text ?? "").split(" ")));
    expect(out).toHaveLength(items.length);
    expect(new Set(out.map((i) => i.url)).size).toBe(items.length);
    for (const it of items) expect(out).toContain(it);
  });

  it("keeps the best-scored source first — the top hit is never demoted", () => {
    const items = [rewrite(0), rewrite(1), rewrite(2), distinct];
    const out = diversify(items, (it) => new Set((it.text ?? "").split(" ")));
    expect(out[0]!.url).toBe("https://farm0.test/x");
  });

  it("promotes the source that says something NEW over the fourth rewrite", () => {
    const items = [rewrite(0), rewrite(1), rewrite(2), rewrite(3), rewrite(4), distinct];
    const before = items.findIndex((i) => i.url === distinct.url);
    const out = diversify(items, (it) => new Set((it.text ?? "").split(" ")));
    const after = out.findIndex((i) => i.url === distinct.url);
    expect(after).toBeLessThan(before);
  });

  it("leaves an already-diverse pool alone (no churn where there is nothing to fix)", () => {
    // Every source shares nothing with the others: there is no redundancy to
    // penalise, so the order stays purely by relevance. This is why a research
    // pool came out byte-identical.
    const items = [
      src("https://a.test/x", 0.9, ["alpha", "one"]),
      src("https://b.test/x", 0.8, ["beta", "two"]),
      src("https://c.test/x", 0.7, ["gamma", "three"]),
      src("https://d.test/x", 0.6, ["delta", "four"]),
    ];
    const out = diversify(items, (it) => new Set((it.text ?? "").split(" ")));
    expect(out.map((i) => i.url)).toEqual(items.map((i) => i.url));
  });

  it("is deterministic, and trivial inputs pass straight through", () => {
    const items = [rewrite(0), rewrite(1), distinct, rewrite(2)];
    const toks = (it: RawSource) => new Set((it.text ?? "").split(" "));
    expect(diversify(items, toks).map((i) => i.url)).toEqual(diversify(items, toks).map((i) => i.url));
    expect(diversify([], toks)).toEqual([]);
    expect(diversify([distinct], toks).map((i) => i.url)).toEqual([distinct.url]);
  });

  it("λ trades relevance against diversity, and relevance stays dominant by default", () => {
    const items = [rewrite(0), rewrite(1), rewrite(2), rewrite(3), distinct];
    const at = (lambda: number) => diversify(items, (it) => new Set((it.text ?? "").split(" ")), lambda).findIndex((i) => i.url === distinct.url);
    // Lower λ ⇒ the distinct source climbs sooner. Never below the top hit.
    expect(at(0.6)).toBeLessThanOrEqual(at(0.95));
    expect(at(0.6)).toBeGreaterThan(0);
  });
});
