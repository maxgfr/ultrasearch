import { describe, expect, it } from "vitest";
import { addressedIdCount, deriveCitableUrl, isApiEndpoint, isCitableUrl } from "../src/citable.js";

describe("isApiEndpoint", () => {
  it.each([
    "https://eutils.ncbi.nlm.nih.gov/entrez/eutils/efetch.fcgi?db=pubmed&id=1",
    "https://api.crossref.org/works/10.1016/j.ophtha.2020.03.005",
    "https://api.openalex.org/works?filter=doi:10.1234",
    "https://export.arxiv.org/api/query?search_query=all:iol",
    "https://www.ebi.ac.uk/europepmc/webservices/rest/search?query=iol",
    "https://dblp.org/search/publ/api?q=rate+limiting&format=json",
    "https://any.host.test/records/42?format=json", // shape alone is enough — no host list needed
    "https://any.host.test/thing?retmode=text",
  ])("flags %s", (url) => {
    expect(isApiEndpoint(url)).toBe(true);
  });

  it.each([
    "https://pubmed.ncbi.nlm.nih.gov/34397876/",
    "https://doi.org/10.1016/j.ophtha.2020.03.005",
    "https://dblp.org/pid/12/3456.html",
    "https://example.test/article?utm_source=x",
    "nonsense",
  ])("does not flag %s", (url) => {
    expect(isApiEndpoint(url)).toBe(false);
  });
});

describe("addressedIdCount", () => {
  it.each([
    ["comma-separated", "https://any.api.test/records?id=34397876,32000520,32358266", 3],
    ["space-separated", "https://any.api.test/records?id=34397876 32000520", 2],
    ["percent-encoded spaces", "https://any.api.test/records?id=34397876%2032000520", 2],
    ["plus-separated", "https://any.api.test/records?ids=a+b+c+d", 4],
    ["a single id", "https://any.api.test/records?uid=34397876", 1],
    ["no id at all", "https://example.test/article", 0],
    ["not a url", "nonsense", 0],
  ])("counts %s", (_label, url, expected) => {
    expect(addressedIdCount(url)).toBe(expected);
  });
});

describe("isCitableUrl", () => {
  it("accepts an ordinary page and rejects endpoints, non-http and garbage", () => {
    expect(isCitableUrl("https://example.test/a")).toBe(true);
    expect(isCitableUrl("https://api.crossref.org/works/10.1/x")).toBe(false);
    expect(isCitableUrl("ftp://example.test/a")).toBe(false);
    expect(isCitableUrl("not a url")).toBe(false);
  });
});

describe("deriveCitableUrl", () => {
  it("prefers the url the page declares for itself", () => {
    expect(deriveCitableUrl("doi: 10.1/ignored", "https://journal.test/article/7")).toBe("https://journal.test/article/7");
  });

  it("ignores a declared url that is itself an endpoint", () => {
    expect(deriveCitableUrl("PMID: 34397876", "https://api.crossref.org/works/10.1/x")).toBe("https://pubmed.ncbi.nlm.nih.gov/34397876/");
  });

  it("reads a DOI out of a plain-text record and strips the sentence punctuation", () => {
    const abstract = "1. Ophthalmology. 2020 Sep;127(9):1234-1258. doi: 10.1016/j.ophtha.2020.03.005.\n\nIntraocular lens implantation.";
    expect(deriveCitableUrl(abstract)).toBe("https://doi.org/10.1016/j.ophtha.2020.03.005");
  });

  it("falls back to an arXiv id, then to a PMID", () => {
    expect(deriveCitableUrl("Preprint arXiv:2401.01234v2 — no doi here")).toBe("https://arxiv.org/abs/2401.01234v2");
    expect(deriveCitableUrl("Some record.\n\nPMID: 34397876")).toBe("https://pubmed.ncbi.nlm.nih.gov/34397876/");
  });

  it("only looks at the record's head, so a DOI cited deep in a bibliography can't win", () => {
    const body = `${"filler line that is not an identifier\n".repeat(200)}doi: 10.9999/some.reference`;
    expect(deriveCitableUrl(body)).toBeUndefined();
  });

  it("returns undefined when the payload names no document", () => {
    expect(deriveCitableUrl('{"count": 3, "results": []}')).toBeUndefined();
  });
});
