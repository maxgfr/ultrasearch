import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { europePmcFullTextUrl, jatsToText, ncbiDocument, readNcbiDocument } from "../src/providers/ncbi.js";
import { addSource, addSources } from "../src/enrich.js";
import { parseWebResults } from "../src/backends/websearch.js";
import { runGather } from "../src/gather.js";
import { main } from "../src/cli.js";
import { writeFixtureDossier } from "./dossierfix.js";
import { installFetchMock, routes, type MockResponse } from "./fetchmock.js";
import type { GatherOptions, Source } from "../src/types.js";

afterEach(() => vi.unstubAllGlobals());

function scratch(): string {
  return mkdtempSync(join(tmpdir(), "us-ncbi-"));
}
function sourcesOf(dir: string): Source[] {
  return JSON.parse(readFileSync(join(dir, "sources.json"), "utf8")) as Source[];
}

const EFETCH = "https://eutils.ncbi.nlm.nih.gov/entrez/eutils/efetch.fcgi?db=pubmed&id=34397876&rettype=abstract&retmode=text";
const COOKIE_WALL: MockResponse = {
  body: "<title>PubMed</title><h1>Cookies must be enabled.</h1><p>Enable cookies for pubmed.ncbi.nlm.nih.gov and reload this page to continue.</p>",
};
const PMC_WALL: MockResponse = {
  body: "<title>Preparing to download</title><p>Checking your browser before accessing pmc.ncbi.nlm.nih.gov. Click here if you are not redirected.</p>",
};
const ABSTRACT: MockResponse = {
  contentType: "text/plain",
  body: [
    "1. Ophthalmology. 2020 Sep;127(9):1234-1258. doi: 10.1016/j.ophtha.2020.03.005.",
    "",
    "Intraocular Lens Implantation in the Absence of Zonular Support: An Outcomes and",
    "Safety Update.",
    "",
    "Shen JF, Deng S, Hammersmith KM.",
    "",
    "PURPOSE: To review the published literature on the visual acuity results and",
    "complications of different surgical techniques for intraocular lens implantation",
    "in the absence of zonular support. Forty-two studies met the inclusion criteria.",
    "",
    "PMID: 34397876",
  ].join("\n"),
};
const JATS = `<?xml version="1.0"?>
<article xmlns:mml="http://www.w3.org/1998/Math/MathML">
  <front>
    <article-meta>
      <title-group><article-title>Scleral fixation of a dislocated <italic>intraocular</italic> lens</article-title></title-group>
      <abstract><title>Abstract</title><p>We followed 42 eyes for two years after scleral fixation &amp; report the outcomes.</p></abstract>
    </article-meta>
  </front>
  <body>
    <sec><title>Introduction</title><p>Late in-the-bag dislocation affects nearly nine displaced anchors out of ten <xref ref-type="bibr" rid="R1">[1]</xref> .</p></sec>
    <sec><title>Methods</title>
      <p>Patients were operated on between 2015 and 2020.</p>
      <table-wrap><table><tr><td>row 1</td><td>99999</td></tr></table></table-wrap>
      <disp-formula><mml:math><mml:mi>x</mml:mi></mml:math></disp-formula>
      <fig><caption><p>Figure 4. Postoperative view.</p></caption></fig>
    </sec>
    <sec><title>Discussion</title><p>Scleral fixation restored useful vision in most eyes, and the complication profile compared favourably with anterior chamber lenses in the same period of follow-up.</p></sec>
  </body>
  <back><ref-list><ref><mixed-citation>Smith J. A cited paper.</mixed-citation></ref></ref-list></back>
</article>`;

describe("ncbiDocument", () => {
  it("recognises every address of a PubMed record", () => {
    for (const u of [
      "https://pubmed.ncbi.nlm.nih.gov/34397876/",
      "https://www.ncbi.nlm.nih.gov/pubmed/34397876",
      "https://pubmed.ncbi.nlm.nih.gov/34397876/?from=search",
    ]) {
      expect(ncbiDocument(u)).toMatchObject({ kind: "pubmed", id: "34397876", citeUrl: "https://pubmed.ncbi.nlm.nih.gov/34397876/" });
    }
    expect(ncbiDocument(EFETCH)).toEqual({ kind: "pubmed", id: "34397876", citeUrl: "https://pubmed.ncbi.nlm.nih.gov/34397876/", textUrl: EFETCH });
  });

  it("sends every address of a PMC article to Europe PMC's full text", () => {
    const want = { kind: "pmc", id: "PMC7654321", citeUrl: "https://pmc.ncbi.nlm.nih.gov/articles/PMC7654321/", textUrl: europePmcFullTextUrl("PMC7654321") };
    expect(ncbiDocument("https://pmc.ncbi.nlm.nih.gov/articles/PMC7654321/")).toEqual(want);
    expect(ncbiDocument("https://www.ncbi.nlm.nih.gov/pmc/articles/pmc7654321")).toEqual(want);
    expect(ncbiDocument("https://eutils.ncbi.nlm.nih.gov/entrez/eutils/efetch.fcgi?db=pmc&id=7654321")).toEqual(want);
    expect(ncbiDocument("https://www.ebi.ac.uk/europepmc/webservices/rest/PMC7654321/fullTextXML")).toEqual(want);
  });

  it("leaves batches, searches and other hosts alone", () => {
    expect(ncbiDocument("https://eutils.ncbi.nlm.nih.gov/entrez/eutils/efetch.fcgi?db=pubmed&id=1,2")).toBeUndefined();
    expect(ncbiDocument("https://eutils.ncbi.nlm.nih.gov/entrez/eutils/efetch.fcgi?db=protein&id=5")).toBeUndefined();
    expect(ncbiDocument("https://eutils.ncbi.nlm.nih.gov/entrez/eutils/esearch.fcgi?db=pubmed&term=x")).toBeUndefined();
    expect(ncbiDocument("https://example.test/pubmed/123456")).toBeUndefined();
  });
});

describe("jatsToText", () => {
  it("keeps the title, the abstract and the body's sections and paragraphs, nothing else", () => {
    const { text, title } = jatsToText(JATS);
    expect(title).toBe("Scleral fixation of a dislocated intraocular lens");
    expect(text).toMatch(
      /^# Scleral fixation of a dislocated intraocular lens\n\n## Abstract\n\nWe followed 42 eyes for two years after scleral fixation & report/,
    );
    expect(text).toContain("## Introduction");
    expect(text).toContain("nearly nine displaced anchors out of ten [1].");
    expect(text).toContain("## Methods\n\nPatients were operated on between 2015 and 2020.");
    expect(text).toContain("Figure 4. Postoperative view.");
    expect(text).not.toMatch(/99999|mixed-citation|A cited paper|<|mml/);
  });

  it("copes with a payload that has no front matter", () => {
    expect(jatsToText("<article><body><p>Only a paragraph.</p></body></article>")).toEqual({ text: "Only a paragraph." });
  });
});

describe("readNcbiDocument", () => {
  it("says why when an endpoint has nothing", async () => {
    installFetchMock(routes([["eutils", { status: 503, body: "" }]]));
    const pubmed = await readNcbiDocument(ncbiDocument("https://pubmed.ncbi.nlm.nih.gov/1234567/")!);
    expect(pubmed).toMatchObject({ ok: false });
    expect(!pubmed.ok && pubmed.why).toMatch(/E-utilities returned nothing for PMID 1234567/);
    installFetchMock(routes([["ebi.ac.uk", { status: 404, body: "not found" }]]));
    const pmc = await readNcbiDocument(ncbiDocument("https://pmc.ncbi.nlm.nih.gov/articles/PMC1/")!);
    expect(!pmc.ok && pmc.why).toBe("Europe PMC has no full text for PMC1 (HTTP 404)");
  });

  it("refuses a wall or a near-empty answer from the endpoint itself", async () => {
    installFetchMock(routes([["eutils", { contentType: "text/plain", body: "1. Short letter. No abstract available." }]]));
    const r = await readNcbiDocument(ncbiDocument("https://pubmed.ncbi.nlm.nih.gov/7654321/")!);
    expect(!r.ok && r.why).toMatch(/E-utilities returned a near-empty page/);
    installFetchMock(routes([["ebi.ac.uk", { contentType: "application/xml", body: "<article><body><p>Too short.</p></body></article>" }]]));
    const x = await readNcbiDocument(ncbiDocument("https://pmc.ncbi.nlm.nih.gov/articles/PMC2/")!);
    expect(!x.ok && x.why).toMatch(/Europe PMC's full text for PMC2 is a near-empty page/);
  });
});

describe("addSource — PubMed and PMC through their endpoints", () => {
  // U2: the efetch URL used to be resolved to its PubMed page, which was then
  // READ — the cookie wall replacing the abstract the caller had pointed at.
  it("keeps the efetch text even though the PubMed page is a cookie wall", async () => {
    const dir = scratch();
    writeFixtureDossier(dir, 1);
    installFetchMock(
      routes([
        ["eutils.ncbi.nlm.nih.gov", ABSTRACT],
        ["pubmed.ncbi.nlm.nih.gov", COOKIE_WALL],
      ]),
    );
    const r = await addSource(dir, EFETCH, { question: "zonular support" });
    expect(r.added).toBe(true);
    const added = sourcesOf(dir)[1]!;
    expect(added.url).toBe("https://pubmed.ncbi.nlm.nih.gov/34397876/");
    expect(added.meta?.textVia).toBe(EFETCH);
    expect(added.title).toBe("Intraocular Lens Implantation in the Absence of Zonular Support: An Outcomes and Safety Update.");
    const extract = readFileSync(join(dir, added.extract), "utf8");
    expect(extract).toContain("Forty-two studies met the inclusion criteria");
    expect(extract).not.toMatch(/Cookies must be enabled/);
    rmSync(dir, { recursive: true, force: true });
  });

  it("reads a PubMed page's abstract from E-utilities before ever opening the page", async () => {
    const dir = scratch();
    writeFixtureDossier(dir, 1);
    const spy = installFetchMock(
      routes([
        ["eutils.ncbi.nlm.nih.gov", ABSTRACT],
        ["pubmed.ncbi.nlm.nih.gov", COOKIE_WALL],
      ]),
    );
    const r = await addSource(dir, "https://pubmed.ncbi.nlm.nih.gov/34397876/", { title: "Zonular support review" });
    expect(r.added).toBe(true);
    expect(spy.mock.calls.map((c) => String(c[0])).some((u) => u.startsWith("https://pubmed.ncbi.nlm.nih.gov"))).toBe(false);
    expect(sourcesOf(dir)[1]!.title).toBe("Zonular support review");
    rmSync(dir, { recursive: true, force: true });
  });

  // U6: a PMC article behind its interstitial, read from Europe PMC instead.
  it("reads a PMC article from Europe PMC's full-text XML and cites the PMC page", async () => {
    const dir = scratch();
    writeFixtureDossier(dir, 1);
    installFetchMock(
      routes([
        ["ebi.ac.uk/europepmc/webservices/rest/PMC7654321/fullTextXML", { contentType: "application/xml", body: JATS }],
        ["pmc.ncbi.nlm.nih.gov", PMC_WALL],
      ]),
    );
    const r = await addSource(dir, "https://www.ncbi.nlm.nih.gov/pmc/articles/PMC7654321/", {});
    expect(r.added).toBe(true);
    const added = sourcesOf(dir)[1]!;
    expect(added.url).toBe("https://pmc.ncbi.nlm.nih.gov/articles/PMC7654321/");
    expect(added.title).toBe("Scleral fixation of a dislocated intraocular lens");
    expect(added.meta?.textVia).toBe(europePmcFullTextUrl("PMC7654321"));
    expect(readFileSync(join(dir, added.extract), "utf8")).toContain("nine displaced anchors out of ten");
    rmSync(dir, { recursive: true, force: true });
  });

  it("falls back to the ordinary ladder when Europe PMC has nothing, and says what it tried", async () => {
    const dir = scratch();
    writeFixtureDossier(dir, 1);
    installFetchMock(routes([["pmc.ncbi.nlm.nih.gov", PMC_WALL]])); // Europe PMC 404s
    const r = await addSource(dir, "https://pmc.ncbi.nlm.nih.gov/articles/PMC1111111/", {});
    expect(r.added).toBe(false);
    expect(r.note).toMatch(/anti-bot interstitial, not content — not added/);
    expect(r.note).toMatch(/Europe PMC has no full text for PMC1111111 \(HTTP 404\)/);
    rmSync(dir, { recursive: true, force: true });
  });

  it("dedupes an efetch URL against its PubMed page already in the dossier", async () => {
    const dir = scratch();
    writeFixtureDossier(dir, 1);
    installFetchMock(routes([["eutils.ncbi.nlm.nih.gov", ABSTRACT]]));
    const first = await addSource(dir, "https://pubmed.ncbi.nlm.nih.gov/34397876/", {});
    const again = await addSource(dir, EFETCH, {});
    expect(again).toMatchObject({ id: first.id, added: false });
    rmSync(dir, { recursive: true, force: true });
  });
});

describe("ingest — a citeUrl per hit", () => {
  it("parses citeUrl / cite_url per element and keeps it verbatim", () => {
    const parsed = parseWebResults(
      JSON.stringify([
        { url: "https://records.test/v1/77?format=json", citeUrl: "https://journal.test/a" },
        { url: "https://records.test/v1/78?format=json", cite_url: "not a url" },
        { url: "https://plain.test/" },
      ]),
    );
    expect(parsed.hits).toEqual([
      { url: "https://records.test/v1/77?format=json", citeUrl: "https://journal.test/a" },
      { url: "https://records.test/v1/78?format=json", citeUrl: "not a url" },
      { url: "https://plain.test/" },
    ]);
  });

  it("reads each hit's text from its url and cites its citeUrl, refusing an unusable one", async () => {
    const dir = scratch();
    writeFixtureDossier(dir, 1);
    installFetchMock(routes([["records.test", { contentType: "text/plain", body: `A record with no identifier at all. ${"Body text. ".repeat(40)}` }]]));
    const r = await addSources(dir, [
      { url: "https://records.test/v1/77?format=json", citeUrl: "https://journal.test/articles/77" },
      { url: "https://records.test/v1/78?format=json", citeUrl: "https://api.crossref.org/works/10.1/x" },
    ]);
    expect(r.added).toBe(1);
    const added = sourcesOf(dir)[1]!;
    expect(added.url).toBe("https://journal.test/articles/77");
    expect(added.meta?.textVia).toBe("https://records.test/v1/77?format=json");
    expect(r.results[1]!.note).toMatch(/not a page a reader can open/);
    rmSync(dir, { recursive: true, force: true });
  });

  it("does it from the CLI, in one process", async () => {
    const dir = scratch();
    writeFixtureDossier(dir, 1);
    installFetchMock(
      routes([
        ["eutils.ncbi.nlm.nih.gov", ABSTRACT],
        ["pubmed.ncbi.nlm.nih.gov", COOKIE_WALL],
      ]),
    );
    const hits = join(dir, "hits.json");
    writeFileSync(hits, JSON.stringify([{ url: EFETCH, citeUrl: "https://pubmed.ncbi.nlm.nih.gov/34397876/" }]));
    const out = vi.spyOn(process.stdout, "write").mockImplementation((() => true) as never);
    const err = vi.spyOn(process.stderr, "write").mockImplementation((() => true) as never);
    try {
      await main(["ingest", "--run", dir, "--web-results", hits, "--no-cache"]);
    } finally {
      out.mockRestore();
      err.mockRestore();
    }
    const added = sourcesOf(dir)[1]!;
    expect(added.url).toBe("https://pubmed.ncbi.nlm.nih.gov/34397876/");
    expect(readFileSync(join(dir, added.extract), "utf8")).toContain("PURPOSE: To review");
    rmSync(dir, { recursive: true, force: true });
  });
});

describe("gather — PubMed and PMC hits", () => {
  function opts(over: Partial<GatherOptions>): GatherOptions {
    return {
      question: "scleral fixation intraocular lens",
      mode: "topic",
      depth: "standard",
      perSource: 6,
      lang: "en",
      webEngine: "auto",
      excludeDomains: [],
      json: false,
      ...over,
    };
  }

  it("hydrates PubMed and PMC WebSearch hits from their endpoints, citing the pages", async () => {
    const dir = scratch();
    installFetchMock(
      routes([
        ["eutils.ncbi.nlm.nih.gov", ABSTRACT],
        ["ebi.ac.uk/europepmc/webservices/rest/PMC7654321/fullTextXML", { contentType: "application/xml", body: JATS }],
        ["pubmed.ncbi.nlm.nih.gov", COOKIE_WALL],
        ["pmc.ncbi.nlm.nih.gov", PMC_WALL],
      ]),
    );
    const r = await runGather(
      opts({
        backends: ["claude"],
        webResults: [{ url: "https://pubmed.ncbi.nlm.nih.gov/34397876/" }, { url: "https://pmc.ncbi.nlm.nih.gov/articles/PMC7654321/", title: "PMC hit" }],
        out: dir,
      }),
    );
    const pubmed = r.sources.find((s) => s.url.includes("pubmed"))!;
    const pmc = r.sources.find((s) => s.url.includes("pmc."))!;
    expect(pubmed.fullText).not.toBe(false);
    expect(pubmed.meta?.textVia).toContain("efetch.fcgi");
    expect(pmc.meta?.textVia).toBe(europePmcFullTextUrl("PMC7654321"));
    expect(readFileSync(join(dir, pmc.extract), "utf8")).toContain("nine displaced anchors");
    expect(r.manifest.notes.join("\n")).toMatch(/Read 2 PubMed\/PMC record\(s\) through their endpoints/);
    rmSync(dir, { recursive: true, force: true });
  });

  it("salvages a DOI item whose page is paywalled through its PubMed record", async () => {
    const dir = scratch();
    installFetchMock((url) => {
      if (url.includes("esearch.fcgi")) return { body: JSON.stringify({ esearchresult: { idlist: ["34397876"] } }), contentType: "application/json" };
      if (url.includes("esummary.fcgi"))
        return {
          body: JSON.stringify({
            result: {
              uids: ["34397876"],
              "34397876": {
                title: "Intraocular lens implantation without zonular support.",
                pubdate: "2020",
                source: "Ophthalmology",
                articleids: [{ idtype: "doi", value: "10.1016/j.ophtha.2020.03.005" }],
              },
            },
          }),
          contentType: "application/json",
        };
      if (url.includes("efetch.fcgi")) return ABSTRACT;
      if (url.includes("doi.org")) return { status: 403, body: "paywall" };
      return undefined;
    });
    const r = await runGather(opts({ question: "intraocular lens zonular support", backends: ["pubmed"], out: dir }));
    const doi = r.sources.find((s) => s.url.includes("doi.org"))!;
    expect(doi.fullText).not.toBe(false);
    expect(doi.meta?.textVia).toContain("efetch.fcgi");
    expect(r.manifest.notes.join("\n")).toMatch(/Primary page for https:\/\/doi\.org\/10\.1016\/j\.ophtha\.2020\.03\.005 was unusable — hydrated the fallback/);
    rmSync(dir, { recursive: true, force: true });
  });
});
