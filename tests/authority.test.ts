import { describe, expect, it } from "vitest";
import { externalHosts, sourceSignals } from "../src/authority.js";

// These signals report FACTS, and that is the whole design.
//
// Two list-based approaches were measured and failed first:
//   * a host allowlist scored the WHATWG HTML Standard — the normative spec for
//     the subject — identically to `jobsbyculture.com`, because nobody had added
//     whatwg.org to it;
//   * a phrase list would fare no better: 3 of 5 content-marketing pages in the
//     same pool carried no call-to-action wording at all.
//
// Then a structural VERDICT ("⚠ thin attribution — often marketing content")
// was tried, and it too was wrong on real data: a vendor's own API reference and
// a standards registry both got flagged, purely because a reference page links
// nowhere. Patching that needed a `vouchedFor` escape hatch — the shape of a
// heuristic defending a claim it should not have made.
//
// Counts cannot be wrong. The agent reads them next to the extract and judges.

const farm = "# Streaming LLM Responses: The Complete Engineering Guide (2026)\nSee https://jobsbyculture.com/about for more.\n".repeat(4);
const spec =
  "# Server-sent events\nThis specification defines... See https://dom.spec.whatwg.org/ and https://fetch.spec.whatwg.org/ " +
  "and https://encoding.spec.whatwg.org/ and https://developer.mozilla.org/ and https://github.com/whatwg/html\n";

describe("externalHosts", () => {
  it("counts distinct external hosts, ignoring the source's own and www.", () => {
    const h = externalHosts("https://www.jobsbyculture.com/blog/x", "https://jobsbyculture.com/a https://b.test/x https://b.test/y https://c.test/z");
    expect([...h].sort()).toEqual(["b.test", "c.test"]);
  });

  it("returns nothing for a page that links nowhere", () => {
    expect(externalHosts("https://a.test/x", "plain prose with no links at all").size).toBe(0);
  });
});

describe("sourceSignals — facts, never a verdict", () => {
  it("states the three counts, and nothing beyond them", () => {
    const r = sourceSignals({ url: "https://a.test/x", text: spec, corroboration: 3 });
    expect(r.notes).toHaveLength(1);
    expect(r.notes[0]).toBe("cites 5 external source(s) · surfaced by 3 engine(s) · declares no persistent identity");
  });

  it("passes no judgment on the page — no verdict vocabulary at all", () => {
    // A vendor API reference links nowhere and declares no DOI. Under the old
    // verdict it was called "thin attribution — often marketing content". It is
    // the primary source.
    const apiRef = sourceSignals({ url: "https://developers.openai.com/api/reference/x", text: "# Streaming events\nEvent types." });
    const contentFarm = sourceSignals({ url: "https://jobsbyculture.com/blog/x", text: farm });
    for (const r of [apiRef, contentFarm]) {
      const joined = r.notes.join(" ");
      expect(joined).not.toMatch(/thin|marketing|⚠|✓|poor|weak|low.quality/i);
    }
    // Both are described identically, because structurally they ARE identical.
    // Telling them apart is a reading task, not a counting one.
    expect(apiRef.notes[0]).toBe(contentFarm.notes[0]);
  });

  it("counts what it says it counts", () => {
    const r = sourceSignals({ url: "https://a.test/x", text: spec });
    expect(r.refDiversity).toBe(5);
    expect(r.corroboration).toBe(1);
    expect(sourceSignals({ url: "https://a.test/x", text: farm }).refDiversity).toBe(1);
  });

  it("reads a persistent identity out of the text OR the URL", () => {
    // A PDF loses its hyperlinks in extraction, so an arXiv paper's text can
    // declare nothing at all — while its own address IS the identifier. Two
    // real papers were misdescribed before this was checked.
    const bare = "Abstract. We propose a method.";
    expect(sourceSignals({ url: "https://arxiv.org/pdf/2408.05636", text: bare }).selfIdentified).toBe(true);
    expect(sourceSignals({ url: "https://arxiv.org/abs/2401.10774v2", text: bare }).selfIdentified).toBe(true);
    expect(sourceSignals({ url: "https://doi.org/10.1145/3372297.3417263", text: bare }).selfIdentified).toBe(true);
    expect(sourceSignals({ url: "https://a.test/x", text: "doi:10.1145/3372297.3417263\n" + bare }).selfIdentified).toBe(true);
    expect(sourceSignals({ url: "https://a.test/blog/post", text: bare }).selfIdentified).toBe(false);
  });

  it("says so plainly when a document declares an identity", () => {
    // An UNKNOWN host: no list would ever have contained it.
    const r = sourceSignals({ url: "https://obscure-journal.example/paper", text: "https://doi.org/10.1145/3372297.3417263\n" + spec });
    expect(r.notes[0]).toMatch(/declares a persistent identity/);
  });
});
