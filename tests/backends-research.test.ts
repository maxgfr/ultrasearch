import { afterEach, describe, expect, it, vi } from "vitest";
import { arxivBackend } from "../src/backends/arxiv.js";
import { crossrefBackend } from "../src/backends/crossref.js";
import { openalexBackend } from "../src/backends/openalex.js";
import { semanticscholarBackend } from "../src/backends/semanticscholar.js";
import { europepmcBackend } from "../src/backends/europepmc.js";
import { pubmedBackend } from "../src/backends/pubmed.js";
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
    // Points at the HTML full text so the gatherer hydrates the whole paper;
    // the abstract is kept as the snippet/fallback (no inline text).
    expect(r.items[0]!.url).toBe("https://arxiv.org/html/1706.03762");
    expect(r.items[0]!.meta?.htmlUrl).toBe("https://arxiv.org/html/1706.03762");
    expect(r.items[0]!.snippet).toContain("Transformer");
    expect(r.items[0]!.text).toBeUndefined();
  });

  it("crossref parses title/abstract/doi/year", async () => {
    installFetchMock(routes([["api.crossref.org", { body: CROSSREF, contentType: "application/json" }]]));
    const r = await crossrefBackend(makeCtx("residual learning"));
    expect(r.items[0]!.meta?.doi).toBe("10.1109/cvpr.2016.90");
    expect(r.items[0]!.text).toContain("residual learning framework");
    expect(r.items[0]!.meta?.year).toBe(2016);
  });

  it("crossref decodes entities + strips JATS tags in title AND venue/snippet (real-API regression)", async () => {
    // no abstract → snippet falls back to "title — venue year", so the venue
    // entity (the field that leaked live) must be decoded too.
    const body = JSON.stringify({
      message: {
        items: [
          {
            title: ["Knowledge Production and R&amp;D in <i>vivo</i>"],
            DOI: "10.1/x",
            URL: "https://doi.org/10.1/x",
            "container-title": ["R&amp;D Decisions"],
            issued: { "date-parts": [[2002]] },
          },
        ],
      },
    });
    installFetchMock(routes([["api.crossref.org", { body, contentType: "application/json" }]]));
    const r = await crossrefBackend(makeCtx("r&d"));
    expect(r.items[0]!.title).toBe("Knowledge Production and R&D in vivo");
    expect(r.items[0]!.meta?.venue).toBe("R&D Decisions");
    expect(`${r.items[0]!.title} ${r.items[0]!.snippet}`).not.toMatch(/&(amp|lt|gt|quot);|<\/?i>/);
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

  it("europepmc parses the inline abstract + biomedical metadata", async () => {
    const EPMC = JSON.stringify({
      resultList: {
        result: [
          {
            title: "CRISPR gene editing.",
            abstractText: "<p>We review CRISPR-based genome editing.</p>",
            authorString: "Doudna J, Charpentier E",
            pubYear: "2014",
            journalInfo: { journal: { title: "Science" } },
            doi: "10.1126/science.epmc",
            source: "MED",
            id: "999",
          },
        ],
      },
    });
    installFetchMock(routes([["ebi.ac.uk/europepmc", { body: EPMC, contentType: "application/json" }]]));
    const r = await europepmcBackend(makeCtx("crispr genome editing"));
    expect(r.items[0]!.text).toContain("genome editing");
    expect(r.items[0]!.meta?.doi).toBe("10.1126/science.epmc");
    expect(r.items[0]!.meta?.year).toBe(2014);
    expect(r.items[0]!.url).toBe("https://doi.org/10.1126/science.epmc");
  });

  it("europepmc decodes escaped JATS markup in titles + abstracts (real-API regression)", async () => {
    const EPMC = JSON.stringify({
      resultList: {
        result: [
          {
            title: "Reactivation of &lt;i&gt;P53&lt;/i&gt; pathways.",
            abstractText: "Effects on &lt;sup&gt;13&lt;/sup&gt;C uptake &amp; growth.",
            pubYear: "2021",
            source: "MED",
            id: "1",
          },
        ],
      },
    });
    installFetchMock(routes([["ebi.ac.uk/europepmc", { body: EPMC, contentType: "application/json" }]]));
    const r = await europepmcBackend(makeCtx("p53"));
    expect(r.items[0]!.title).toBe("Reactivation of P53 pathways");
    expect(r.items[0]!.text).toContain("13C uptake & growth");
    expect(`${r.items[0]!.title} ${r.items[0]!.text}`).not.toMatch(/&(amp|lt|gt);/);
  });

  it("pubmed does esearch→esummary and returns metadata (no text → hydrate later)", async () => {
    const ESEARCH = JSON.stringify({ esearchresult: { idlist: ["111", "222"] } });
    const ESUMMARY = JSON.stringify({
      result: {
        uids: ["111", "222"],
        "111": {
          title: "Trial of drug A.",
          pubdate: "2020 Jan",
          source: "NEJM",
          authors: [{ name: "Doe J" }],
          articleids: [{ idtype: "doi", value: "10.1056/pm.a" }],
        },
        "222": { title: "Trial of drug B.", pubdate: "2019", source: "Lancet", authors: [], articleids: [] },
      },
    });
    installFetchMock((url) => {
      if (url.includes("esearch.fcgi")) return { body: ESEARCH, contentType: "application/json" };
      if (url.includes("esummary.fcgi")) return { body: ESUMMARY, contentType: "application/json" };
      return undefined;
    });
    const r = await pubmedBackend(makeCtx("clinical trial drug"));
    expect(r.items).toHaveLength(2);
    expect(r.items[0]!.url).toBe("https://doi.org/10.1056/pm.a");
    expect(r.items[0]!.text).toBeUndefined(); // metadata-only; gather hydrates the landing page
    expect(r.items[0]!.meta?.year).toBe(2020);
    expect(r.items[1]!.url).toContain("pubmed.ncbi.nlm.nih.gov/222");
  });
});
