import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { redirectedHome, searchPageOf } from "../src/listing.js";
import { identityKeys } from "../src/identity.js";
import { urlIdentity } from "../src/util.js";
import { addSource, addSources } from "../src/enrich.js";
import { runGather } from "../src/gather.js";
import { writeFixtureDossier } from "./dossierfix.js";
import { installFetchMock, routes } from "./fetchmock.js";
import type { GatherOptions, Source } from "../src/types.js";

// Pages that are not documents (a results page, a dead link answered by the
// home page), and one paper banked under several addresses — all three found
// by a run on a real thesis.

afterEach(() => vi.unstubAllGlobals());

function scratch(): string {
  return mkdtempSync(join(tmpdir(), "us-listing-"));
}
function sourcesOf(dir: string): Source[] {
  return JSON.parse(readFileSync(join(dir, "sources.json"), "utf8")) as Source[];
}
const ARTICLE = `<article><h1>Carlevale lens outcomes</h1><p>${"Forty-one eyes were followed for four years after Carlevale implantation with two scleral pockets. ".repeat(6)}</p></article>`;
const ABSTRACT = {
  contentType: "text/plain",
  body: [
    "1. J Cataract Refract Surg. 2022;48(3):301-308. doi: 10.1097/j.jcrs.0000000000000777.",
    "",
    "Carlevale sutureless scleral fixation: four-year outcomes.",
    "",
    `${"We followed forty-one eyes after Carlevale implantation and report anchor exteriorisation and its complications. ".repeat(3)}`,
    "",
    "DOI: 10.1097/j.jcrs.0000000000000777",
    "PMID: 35000001",
  ].join("\n"),
};

describe("searchPageOf", () => {
  it("names the results pages of search engines and databases", () => {
    for (const u of [
      "https://pubmed.ncbi.nlm.nih.gov/?term=carlevale",
      "https://www.ncbi.nlm.nih.gov/pmc/?term=carlevale",
      "https://europepmc.org/search?query=carlevale",
      "https://www.google.com/search?q=carlevale",
      "https://scholar.google.com/scholar?q=carlevale",
      "https://duckduckgo.com/?q=carlevale",
    ]) {
      expect(searchPageOf(u), u).toMatch(/is a search results page/);
    }
  });

  it("leaves documents alone, query strings included", () => {
    for (const u of [
      "https://pubmed.ncbi.nlm.nih.gov/35000001/",
      "https://example.test/article?id=4",
      "https://example.test/2024/carlevale-review?q=carlevale",
      "https://example.test/search-engines-explained",
      "not a url",
    ]) {
      expect(searchPageOf(u), u).toBeUndefined();
    }
  });
});

describe("redirectedHome", () => {
  it("is a deep link that landed on the site's root", () => {
    expect(redirectedHome("https://www.escrs.org/guidelines/iol-2019.pdf", "https://www.escrs.org/")).toBe(true);
    expect(redirectedHome("https://site.test/en/page", "https://site.test/en/")).toBe(true);
  });
  it("is not a root asked for, an ordinary redirect, or no redirect", () => {
    expect(redirectedHome("https://site.test/", "https://site.test/")).toBe(false);
    expect(redirectedHome("http://site.test/a", "https://site.test/a/")).toBe(false);
    expect(redirectedHome("https://site.test/a", undefined)).toBe(false);
    expect(redirectedHome("https://site.test/a", "https://site.test/?redirected=1")).toBe(false);
  });
});

describe("fetch / ingest refuse what is not a document", () => {
  it("refuses a PubMed search URL instead of banking PubMed's interface", async () => {
    const dir = scratch();
    writeFixtureDossier(dir, 1);
    const spy = installFetchMock(() => ({ body: "<p>Create a new collection. Save citations to file.</p>" }));
    const r = await addSources(dir, ["https://pubmed.ncbi.nlm.nih.gov/?term=carlevale+scleral"]);
    expect(r.added).toBe(0);
    expect(r.results[0]!.note).toMatch(/is a search results page \(term=carlevale scleral\), not a document/);
    expect(spy).not.toHaveBeenCalled();
    rmSync(dir, { recursive: true, force: true });
  });

  it("refuses a deep link that redirected to the home page, after asking the archive", async () => {
    const dir = scratch();
    writeFixtureDossier(dir, 1);
    installFetchMock((url) =>
      url.includes("escrs.org")
        ? { url: "https://www.escrs.org/", body: `<main><h1>ESCRS</h1><p>${"Welcome to the society's home page and its many events. ".repeat(10)}</p></main>` }
        : undefined,
    );
    const r = await addSource(dir, "https://www.escrs.org/guidelines/old-iol-guideline", {});
    expect(r.added).toBe(false);
    expect(r.note).toMatch(/redirected to the site's home page \(https:\/\/www\.escrs\.org\/\) — the document is gone/);
    rmSync(dir, { recursive: true, force: true });
  });

  it("prefers the page's own title to a host name given as the title", async () => {
    const dir = scratch();
    writeFixtureDossier(dir, 1);
    installFetchMock(() => ({ body: `<title>Carlevale lens outcomes</title>${ARTICLE}` }));
    await addSources(dir, [{ url: "https://journal.test/carlevale", title: "journal.test" }]);
    expect(sourcesOf(dir)[1]!.title).toBe("Carlevale lens outcomes");
    rmSync(dir, { recursive: true, force: true });
  });
});

describe("one paper, several addresses", () => {
  it("keys a source by its DOI, PMID and PMCID", () => {
    expect(identityKeys("https://doi.org/10.1097/J.JCRS.0000000000000777")).toEqual(["doi:10.1097/j.jcrs.0000000000000777"]);
    expect(identityKeys("https://journals.test/doi/full/10.1016/abc?x=1")).toEqual(["doi:10.1016/abc"]);
    expect(identityKeys("https://www.ncbi.nlm.nih.gov/pmc/articles/PMC123/")).toEqual(["pmcid:PMC123"]);
    expect(identityKeys("https://pubmed.ncbi.nlm.nih.gov/35000001/", undefined, ABSTRACT.body).sort()).toEqual([
      "doi:10.1097/j.jcrs.0000000000000777",
      "pmid:35000001",
    ]);
    expect(identityKeys("https://publisher.test/a", { doi: "10.1016/ABC." })).toEqual(["doi:10.1016/abc"]);
  });

  it("ingest: the PubMed page of a paper already banked by its DOI is the same source", async () => {
    const dir = scratch();
    writeFixtureDossier(dir, 1);
    installFetchMock(
      routes([
        ["eutils.ncbi.nlm.nih.gov", ABSTRACT],
        ["doi.org", { body: ARTICLE }],
        [
          "rest/PMC777/fullTextXML",
          {
            contentType: "application/xml",
            body: `<article><body><p>${"Carlevale lenses stayed in place in most eyes at four years of follow-up. ".repeat(6)}</p></body></article>`,
          },
        ],
      ]),
    );
    const first = await addSource(dir, "https://doi.org/10.1097/j.jcrs.0000000000000777", {});
    expect(first.added).toBe(true);
    const twin = await addSource(dir, "https://pubmed.ncbi.nlm.nih.gov/35000001/", {});
    expect(twin).toMatchObject({ id: first.id, added: false });
    expect(twin.note).toMatch(/the same paper: .*doi:10\.1097\/j\.jcrs\.0000000000000777/);
    // and the legacy PMC host is the current one
    const pmc = await addSources(dir, ["https://pmc.ncbi.nlm.nih.gov/articles/PMC777/", "https://www.ncbi.nlm.nih.gov/pmc/articles/PMC777/"]);
    expect(pmc.results[1]!.note ?? "").toMatch(/already in dossier/);
    rmSync(dir, { recursive: true, force: true });
  });

  it("gather: merges the PMC page's two hosts, and a DOI with the PubMed record that names it", async () => {
    const dir = scratch();
    installFetchMock(
      routes([
        ["eutils.ncbi.nlm.nih.gov", ABSTRACT],
        ["doi.org/10.1097", { status: 403, body: "" }],
        [
          "rest/PMC4444/fullTextXML",
          {
            contentType: "application/xml",
            body: `<article><body><p>${"Carlevale lenses stayed in place in most eyes at four years of follow-up. ".repeat(6)}</p></body></article>`,
          },
        ],
      ]),
    );
    const opts: GatherOptions = {
      question: "Carlevale scleral fixation outcomes",
      mode: "topic",
      depth: "standard",
      perSource: 6,
      lang: "en",
      webEngine: "auto",
      excludeDomains: [],
      json: false,
      backends: ["host"],
      out: dir,
      webResults: [
        {
          url: "https://doi.org/10.1097/j.jcrs.0000000000000777",
          title: "Carlevale four-year outcomes",
          snippet: "Carlevale scleral fixation outcomes at four years.",
        },
        { url: "https://pubmed.ncbi.nlm.nih.gov/35000001/" },
        { url: "https://pmc.ncbi.nlm.nih.gov/articles/PMC4444/" },
        { url: "https://www.ncbi.nlm.nih.gov/pmc/articles/PMC4444/" },
      ],
    };
    const r = await runGather(opts);
    const urls = r.sources.map((s) => s.url);
    expect(urls.filter((u) => u.includes("PMC4444"))).toEqual(["https://pmc.ncbi.nlm.nih.gov/articles/PMC4444/"]);
    expect(urls).toContain("https://pubmed.ncbi.nlm.nih.gov/35000001/");
    expect(urls).not.toContain("https://doi.org/10.1097/j.jcrs.0000000000000777");
    const pubmed = r.sources.find((s) => s.url.includes("35000001"))!;
    expect(pubmed.meta?.alsoAt).toEqual(["https://doi.org/10.1097/j.jcrs.0000000000000777"]);
    expect(r.manifest.notes.join("\n")).toMatch(/Merged 1 source\(s\) that were the same paper/);
    rmSync(dir, { recursive: true, force: true });
  });

  it("gather: drops a search results page and says so", async () => {
    const dir = scratch();
    installFetchMock(() => ({ body: ARTICLE }));
    const r = await runGather({
      question: "Carlevale scleral fixation outcomes",
      mode: "topic",
      depth: "standard",
      perSource: 6,
      lang: "en",
      webEngine: "auto",
      excludeDomains: [],
      json: false,
      backends: ["host"],
      out: dir,
      webResults: [{ url: "https://pubmed.ncbi.nlm.nih.gov/?term=carlevale" }, { url: "https://journal.test/carlevale" }],
    });
    expect(r.sources.map((s) => s.url)).toEqual(["https://journal.test/carlevale"]);
    expect(r.manifest.notes.join("\n")).toMatch(/Dropped 1 search results page\(s\)/);
    rmSync(dir, { recursive: true, force: true });
  });
});

// A real research run (v1.42.7) banked one Web of Science record four times
// under one URL, and ingested a paper's arXiv /abs/ page as a new source while
// its /html/ page was already on file.
describe("one address, one source", () => {
  const WOS = "https://www.webofscience.com/wos/woscc/full-record/10.1088%2F3049-4753%2FAE4982?SID=EUW1ED0F6B&fromWosSearch=1";
  const GATHER: Omit<GatherOptions, "out" | "webResults"> = {
    question: "Carlevale scleral fixation outcomes",
    mode: "topic",
    depth: "standard",
    perSource: 6,
    lang: "en",
    webEngine: "auto",
    excludeDomains: [],
    json: false,
    backends: ["host"],
  };

  it("keys a URL by its percent-decoded form: %2F, %2f and / in the path, any hex case in the query", () => {
    const keys = [
      WOS,
      WOS.replace(/%2F/g, "%2f"),
      WOS.replace(/%2F/g, "/"),
      "https://webofscience.com/wos/woscc/full-record/10.1088%2f3049-4753%2fAE4982/?fromWosSearch=1&SID=EUW1ED0F6B#x",
    ].map(urlIdentity);
    expect(new Set(keys).size).toBe(1);
    expect(urlIdentity("https://ex.test/a%7Eb?q=a%2Fb")).toBe(urlIdentity("https://ex.test/a~b?q=a/b"));
    // A different record, or a different query value, is still another address.
    expect(urlIdentity(WOS.replace("AE4982", "AE4983"))).not.toBe(urlIdentity(WOS));
    expect(urlIdentity(WOS.replace("SID=EUW1ED0F6B", "SID=OTHER"))).not.toBe(urlIdentity(WOS));
  });

  it("gather: one Web of Science record reached four ways is one source", async () => {
    const dir = scratch();
    // Two hits redirect onto the record's page, the other two ARE that page,
    // written with different percent-encodings. The page is a sign-in wall, so
    // each hit keeps its own snippet: nothing but the address says they are one.
    installFetchMock((url) => (url.includes("webofscience.com") ? { url: WOS, status: 403, body: "" } : undefined));
    const hit = (url: string, n: number) => ({
      url,
      title: `Carlevale record ${n}`,
      snippet: `Carlevale scleral fixation outcomes, listing ${n} of the record.`,
    });
    const r = await runGather({
      ...GATHER,
      out: dir,
      webResults: [
        hit(WOS, 1),
        hit(WOS.replace(/%2F/g, "%2f"), 2),
        hit("https://www.webofscience.com/api/gateway?KeyAID=10.1088%2F3049-4753%2FAE4982&DestApp=DOI", 3),
        hit("https://www.webofscience.com/api/gateway?KeyAID=10.1088%2F3049-4753%2FAE4982&DestApp=WOS", 4),
      ],
    });
    expect(r.sources.filter((s) => s.url.includes("webofscience"))).toHaveLength(1);
    rmSync(dir, { recursive: true, force: true });
  });

  it("ingest: the same URL under another percent-encoding is already in the dossier", async () => {
    const dir = scratch();
    writeFixtureDossier(dir, 1);
    installFetchMock(() => ({ body: ARTICLE }));
    const first = await addSources(dir, [WOS]);
    expect(first.added).toBe(1);
    const again = await addSources(dir, [WOS.replace(/%2F/g, "%2f"), WOS.replace(/%2F/g, "/")]);
    expect(again.added).toBe(0);
    expect(again.results.map((x) => x.note)).toEqual(["already in dossier as S2", "already in dossier as S2"]);
    rmSync(dir, { recursive: true, force: true });
  });

  it("keys an arXiv paper by its id, whichever page and version", () => {
    for (const u of [
      "https://arxiv.org/abs/2609.32209",
      "https://arxiv.org/abs/2609.32209v2",
      "https://arxiv.org/html/2609.32209v1",
      "https://arxiv.org/pdf/2609.32209",
      "http://export.arxiv.org/abs/2609.32209",
    ]) {
      expect(identityKeys(u), u).toEqual(["arxiv:2609.32209"]);
    }
    expect(identityKeys("https://arxiv.org/abs/hep-th/9901001v3")).toEqual(["arxiv:hep-th/9901001"]);
    expect(identityKeys("https://publisher.test/a", { arxivId: "2609.32209v4" })).toEqual(["arxiv:2609.32209"]);
  });

  it("ingest: the /abs/ page of a paper banked by its /html/ page is the same source", async () => {
    const dir = scratch();
    writeFixtureDossier(dir, 1);
    installFetchMock((url) => (url.includes("arxiv.org") ? { body: ARTICLE } : undefined));
    const first = await addSources(dir, ["https://arxiv.org/html/2609.32209"]);
    expect(first.added).toBe(1);
    const again = await addSources(dir, ["https://arxiv.org/abs/2609.32209"]);
    expect(again.added).toBe(0);
    expect(again.results[0]!.note).toMatch(/already in dossier as S2/);
    expect(sourcesOf(dir)).toHaveLength(2);
    rmSync(dir, { recursive: true, force: true });
  });

  it("gather: merges the /abs/, /html/ and /pdf/ pages of one arXiv paper", async () => {
    const dir = scratch();
    // The abstract page and the full text read differently: only the id says they are one paper.
    const ABS = `<article><h1>Carlevale lens outcomes</h1><p>${"Abstract: we report scleral fixation outcomes of the Carlevale lens in a retrospective series. ".repeat(5)}</p></article>`;
    installFetchMock((url) => (url.includes("arxiv.org/html") ? { body: ARTICLE } : url.includes("arxiv.org/abs") ? { body: ABS } : undefined));
    const r = await runGather({
      ...GATHER,
      out: dir,
      webResults: [{ url: "https://arxiv.org/html/2609.32209" }, { url: "https://arxiv.org/abs/2609.32209v2" }, { url: "https://journal.test/carlevale" }],
    });
    expect(r.sources.filter((s) => s.url.includes("arxiv.org"))).toHaveLength(1);
    rmSync(dir, { recursive: true, force: true });
  });
});
