import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { arxivQueries, parseArxivEntry, repairCollaboration } from "../src/backends/arxiv.js";
import { runGather } from "../src/gather.js";
import type { GatherOptions, Source } from "../src/types.js";
import { installFetchMock } from "./fetchmock.js";

afterEach(() => vi.unstubAllGlobals());

// What arXiv's API really returns for a collaboration paper (hep-ex/0602035):
// the byline split into one-word "authors" closed by a bare colon.
const COLLAB_ENTRY = `<entry>
  <id>http://arxiv.org/abs/hep-ex/0602035v1</id>
  <title>Final Report of the Muon E821 Anomalous Magnetic Moment Measurement at BNL</title>
  <summary>We present the final report.</summary>
  <published>2006-02-20T23:30:55Z</published>
  <arxiv:journal_ref>Phys.Rev.D73:072003,2006</arxiv:journal_ref>
  <author><name> Muon</name><arxiv:affiliation>g-2</arxiv:affiliation></author>
  <author><name> Collaboration</name></author>
  <author><name> :</name></author>
  <author><name>G. W. Bennett</name></author>
  <arxiv:doi>10.1103/PhysRevD.73.072003</arxiv:doi>
</entry>`;

describe("arXiv records", () => {
  it("rejoins a collaboration byline and keeps the DOI and journal reference", () => {
    const r = parseArxivEntry(COLLAB_ENTRY);
    expect(r.arxivId).toBe("hep-ex/0602035");
    expect(r.authors).toEqual(["Muon Collaboration", "G. W. Bennett"]);
    expect(r.doi).toBe("10.1103/PhysRevD.73.072003");
    expect(r.venue).toBe("Phys.Rev.D73:072003,2006");
    expect(r.year).toBe(2006);
  });

  it("strips only a trailing version from a legacy id that contains a v", () => {
    const r = parseArxivEntry(`<entry><id>http://arxiv.org/abs/solv-int/9901001v2</id><title>T</title></entry>`);
    expect(r.arxivId).toBe("solv-int/9901001");
  });

  it("leaves an ordinary author list alone", () => {
    expect(repairCollaboration([" Ada Lovelace", "Alan Turing "])).toEqual(["Ada Lovelace", "Alan Turing"]);
    expect(repairCollaboration(["Ada Lovelace", ":", "Alan Turing"])).toEqual(["Ada Lovelace", "Alan Turing"]);
  });

  it("gives a web-search arXiv hit the paper's own title, its record and a refs.bib entry", async () => {
    const feed = `<feed><entry>
      <id>http://arxiv.org/abs/2603.21376v2</id>
      <title>A transformer architecture alteration to incentivise externalised reasoning</title>
      <summary>We propose an early-exit mechanism at intermediate layers, trained with reinforcement learning.</summary>
      <published>2026-03-22T19:28:21Z</published>
      <author><name>Elizabeth Pavlova</name></author><author><name>Puria Radmard</name></author>
    </entry></feed>`;
    const asked: string[] = [];
    installFetchMock((url) => {
      if (url.includes("export.arxiv.org")) {
        asked.push(url);
        return { body: feed, contentType: "application/atom+xml" };
      }
      // The abstract page is site chrome around the abstract: never read.
      if (url.includes("arxiv.org/abs/")) return { body: "<html><body>Bibliographic Explorer Toggle arXivLabs</body></html>" };
      return undefined;
    });
    const dir = mkdtempSync(join(tmpdir(), "us-arxiv-"));
    const options: GatherOptions = {
      question: "early exit transformer reinforcement learning",
      mode: "research",
      depth: "standard",
      perSource: 6,
      lang: "en",
      webEngine: "auto",
      excludeDomains: [],
      json: false,
      backends: ["host"],
      out: dir,
      webResults: [{ url: "https://arxiv.org/abs/2603.21376", title: "Early exit transformer with RL (2026)", snippet: "early exit" }],
    };
    await runGather(options);
    const sources = JSON.parse(readFileSync(join(dir, "sources.json"), "utf8")) as Source[];
    expect(sources).toHaveLength(1);
    const s = sources[0]!;
    expect(s.url).toBe("https://arxiv.org/abs/2603.21376");
    expect(s.title).toBe("A transformer architecture alteration to incentivise externalised reasoning");
    expect(s.meta?.arxivId).toBe("2603.21376");
    expect(s.meta?.authors).toEqual(["Elizabeth Pavlova", "Puria Radmard"]);
    const extract = readFileSync(join(dir, s.extract), "utf8");
    expect(extract).toContain("early-exit mechanism");
    expect(extract).not.toContain("arXivLabs");
    const bib = readFileSync(join(dir, "refs.bib"), "utf8");
    expect(bib).toContain("A transformer architecture alteration");
    expect(bib).toContain("Elizabeth Pavlova and Puria Radmard");
    expect(asked).toHaveLength(1);
    expect(asked[0]).toContain("id_list=2603.21376");
    rmSync(dir, { recursive: true, force: true });
  });
});

describe("arxivQueries", () => {
  it("asks for every content word, with an any-word fallback", () => {
    const [all, any] = arxivQueries("What is the best learning rate for the Muon optimizer?");
    expect(all.toLowerCase()).toContain("all:muon");
    expect(all).toContain(" AND ");
    expect(all).not.toMatch(/all:(what|the|for)\b/);
    expect(any).toBe(all.replaceAll(" AND ", " OR "));
  });
});
