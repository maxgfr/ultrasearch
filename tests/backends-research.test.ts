import { afterEach, describe, expect, it, vi } from "vitest";
import { arxivBackend } from "../src/backends/arxiv.js";
import { crossrefBackend } from "../src/backends/crossref.js";
import { openalexBackend } from "../src/backends/openalex.js";
import { semanticscholarBackend } from "../src/backends/semanticscholar.js";
import { installFetchMock, routes } from "./fetchmock.js";
import { makeCtx } from "./ctx.js";

afterEach(() => vi.unstubAllGlobals());

const ARXIV = `<?xml version="1.0"?><feed>
<title>ArXiv Query</title>
<entry><id>http://arxiv.org/abs/1706.03762v5</id>
<title>Attention Is All You Need</title>
<summary>We propose a new network architecture, the Transformer.</summary>
<published>2017-06-12T00:00:00Z</published>
<author><name>Ashish Vaswani</name></author><author><name>Noam Shazeer</name></author></entry>
</feed>`;

const CROSSREF = JSON.stringify({
  message: {
    items: [
      {
        title: ["Deep Residual Learning for Image Recognition"],
        abstract: "<jats:p>We present a residual learning framework.</jats:p>",
        DOI: "10.1109/cvpr.2016.90",
        author: [{ given: "Kaiming", family: "He" }],
        issued: { "date-parts": [[2016]] },
        URL: "https://doi.org/10.1109/cvpr.2016.90",
        "container-title": ["CVPR"],
      },
    ],
  },
});

const OPENALEX = JSON.stringify({
  results: [
    {
      title: "BERT",
      abstract_inverted_index: { We: [0], introduce: [1], BERT: [2] },
      doi: "https://doi.org/10.18653/v1/n19-1423",
      publication_year: 2019,
      authorships: [{ author: { display_name: "Jacob Devlin" } }],
      primary_location: { landing_page_url: "https://aclanthology.org/N19-1423", source: { display_name: "NAACL" } },
    },
  ],
});

const S2 = JSON.stringify({
  data: [
    {
      title: "Language Models are Few-Shot Learners",
      abstract: "We show that scaling up language models greatly improves few-shot performance.",
      url: "https://www.semanticscholar.org/paper/abc",
      year: 2020,
      authors: [{ name: "Tom Brown" }],
      externalIds: { DOI: "10.5555/gpt3", ArXiv: "2005.14165" },
      venue: "NeurIPS",
    },
  ],
});

describe("research backends", () => {
  it("arxiv parses Atom entries with id/authors/year", async () => {
    installFetchMock(routes([["export.arxiv.org", { body: ARXIV, contentType: "application/atom+xml" }]]));
    const r = await arxivBackend(makeCtx("transformer attention"));
    expect(r.items).toHaveLength(1);
    expect(r.items[0]!.title).toBe("Attention Is All You Need");
    expect(r.items[0]!.meta?.arxivId).toBe("1706.03762");
    expect(r.items[0]!.meta?.authors).toContain("Ashish Vaswani");
    expect(r.items[0]!.meta?.year).toBe(2017);
  });

  it("crossref parses title/abstract/doi/year", async () => {
    installFetchMock(routes([["api.crossref.org", { body: CROSSREF, contentType: "application/json" }]]));
    const r = await crossrefBackend(makeCtx("residual learning"));
    expect(r.items[0]!.meta?.doi).toBe("10.1109/cvpr.2016.90");
    expect(r.items[0]!.text).toContain("residual learning framework");
    expect(r.items[0]!.meta?.year).toBe(2016);
  });

  it("openalex reconstructs the inverted-index abstract", async () => {
    installFetchMock(routes([["api.openalex.org", { body: OPENALEX, contentType: "application/json" }]]));
    const r = await openalexBackend(makeCtx("bert"));
    expect(r.items[0]!.text).toContain("We introduce BERT");
    expect(r.items[0]!.meta?.doi).toBe("10.18653/v1/n19-1423");
  });

  it("semantic scholar parses abstract + externalIds", async () => {
    installFetchMock(routes([["api.semanticscholar.org", { body: S2, contentType: "application/json" }]]));
    const r = await semanticscholarBackend(makeCtx("gpt-3 few shot"));
    expect(r.items[0]!.meta?.arxivId).toBe("2005.14165");
    expect(r.items[0]!.meta?.venue).toBe("NeurIPS");
  });
});
