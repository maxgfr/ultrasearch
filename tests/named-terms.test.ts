import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { namedTerms, runGather } from "../src/gather.js";
import { installFetchMock } from "./fetchmock.js";

afterEach(() => vi.unstubAllGlobals());

describe("namedTerms", () => {
  it("takes proper nouns past the first word, and acronyms anywhere", () => {
    expect(namedTerms("What are the long-term outcomes of Carlevale sutureless scleral-fixated intraocular lenses?")).toEqual(["carlevale"]);
    expect(namedTerms("IOL dislocation after Carlevale implantation")).toEqual(["iol", "carlevale"]);
    expect(namedTerms("Tooth autotransplantation success rate")).toEqual([]);
    expect(namedTerms("What Are The Outcomes")).toEqual([]);
  });
});

describe("gather — a source naming none of the question's named terms moves down", () => {
  it("ranks the Carlevale paper above a broader review that shares more generic words", async () => {
    const dir = mkdtempSync(join(tmpdir(), "us-named-"));
    const page = (body: string) => ({ body: `<article><p>${body}</p></article>` });
    installFetchMock((url) =>
      url.includes("review.test")
        ? page(
            "Long-term outcomes and complications of intraocular lenses implanted in infants: intraocular lens outcomes, intraocular lens complications, lens implantation outcomes and long-term complications in children under two years. ".repeat(
              4,
            ),
          )
        : url.includes("carlevale.test")
          ? page("The Carlevale lens was implanted in forty-one eyes; outcomes were recorded at four years with few complications. ".repeat(4))
          : undefined,
    );
    const r = await runGather({
      question: "What are the long-term outcomes and complications of Carlevale intraocular lenses?",
      mode: "topic",
      depth: "standard",
      perSource: 6,
      lang: "en",
      webEngine: "auto",
      excludeDomains: [],
      json: false,
      backends: ["claude"],
      out: dir,
      webResults: [{ url: "https://review.test/infants" }, { url: "https://carlevale.test/four-years" }],
    });
    expect(r.sources.map((s) => s.url)).toEqual(["https://carlevale.test/four-years", "https://review.test/infants"]);
    expect(r.sources[1]!.meta?.rank?.namedMiss).toBe(0.75);
    expect(r.sources[0]!.meta?.rank?.namedMiss).toBeUndefined();
    rmSync(dir, { recursive: true, force: true });
  });
});
