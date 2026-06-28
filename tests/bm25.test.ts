import { describe, expect, it } from "vitest";
import { buildBm25Index, bm25Score, bm25Tokenize, recencyScore } from "../src/util.js";
import type { Bm25Doc } from "../src/util.js";

function doc(id: string, over: Partial<Bm25Doc>): Bm25Doc {
  return { id, title: "", headings: "", body: "", ...over };
}

describe("bm25Tokenize", () => {
  it("folds plurals/accents, drops stopwords, keeps frequency", () => {
    const toks = bm25Tokenize("the Requests and réessais requests");
    expect(toks).not.toContain("the");
    expect(toks).not.toContain("and");
    expect(toks.filter((t) => t === "request")).toHaveLength(2); // "Requests" + "requests" fold together
    expect(toks).toContain("reessais"); // accent folded (deaccent of "réessais")
  });
});

describe("BM25F", () => {
  it("ranks a title match above a body-only mention above an off-topic page", () => {
    const docs = [
      doc("title", { title: "token bucket rate limiting", body: "an introduction to networking concepts and queues" }),
      doc("body", {
        title: "networking concepts",
        body: "this page mentions rate limiting once among many other topics like caching and queues and latency budgets",
      }),
      doc("none", { title: "gardening", body: "tomatoes and weather and soil moisture" }),
    ];
    const idx = buildBm25Index("token bucket rate limiting", docs);
    const sTitle = bm25Score(idx, docs[0]!);
    const sBody = bm25Score(idx, docs[1]!);
    const sNone = bm25Score(idx, docs[2]!);
    expect(sTitle).toBeGreaterThan(sBody);
    expect(sBody).toBeGreaterThan(sNone);
    expect(sNone).toBe(0);
  });

  it("weights a rare query term above a common one (IDF)", () => {
    const docs = [
      doc("a", { body: "limiting limiting limiting requests throughput budgets" }),
      doc("b", { body: "limiting requests and a mutex guards the shared counter" }),
      doc("c", { body: "limiting throughput and latency budgets here" }),
      doc("d", { body: "limiting and queueing strategies for fairness" }),
    ];
    const idx = buildBm25Index("limiting mutex", docs);
    // 'mutex' is rare (only doc b) -> high IDF; 'limiting' is in every doc -> low.
    // doc b wins despite doc a repeating 'limiting' three times.
    expect(bm25Score(idx, docs[1]!)).toBeGreaterThan(bm25Score(idx, docs[0]!));
  });

  it("gives a proximity bonus when query terms appear adjacent", () => {
    const near = doc("near", { body: "the token bucket algorithm explained in plenty of detail" });
    const far = doc("far", { body: "token shows up early then much later after many words the bucket arrives" });
    const docs = [near, far, doc("x", { body: "unrelated filler about clouds" }), doc("y", { body: "unrelated filler about rivers" })];
    const idx = buildBm25Index("token bucket", docs);
    expect(bm25Score(idx, near)).toBeGreaterThan(bm25Score(idx, far));
  });

  it("is deterministic for identical input", () => {
    const docs = [
      doc("a", { body: "rate limiting token bucket" }),
      doc("b", { body: "leaky bucket smoothing traffic" }),
      doc("c", { body: "queueing theory basics" }),
    ];
    const s1 = bm25Score(buildBm25Index("token bucket", docs), docs[0]!);
    const s2 = bm25Score(buildBm25Index("token bucket", docs), docs[0]!);
    expect(s1).toBe(s2);
  });
});

describe("recencyScore", () => {
  it("is neutral 0.5 without a year or without pool spread", () => {
    expect(recencyScore(undefined, 2000, 2020)).toBe(0.5);
    expect(recencyScore({ year: 2010 }, 2010, 2010)).toBe(0.5);
  });
  it("scores newer sources higher within the pool", () => {
    expect(recencyScore({ year: 2024 }, 2010, 2024)).toBeGreaterThan(recencyScore({ year: 2012 }, 2010, 2024));
  });
});
