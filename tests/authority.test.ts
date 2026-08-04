import { describe, expect, it } from "vitest";
import { externalHosts, sourceSignals } from "../src/authority.js";

// These signals exist because BOTH list-based approaches were measured and
// failed on real data:
//   * a host allowlist scored the WHATWG HTML Standard — the normative spec for
//     the subject — identically to `jobsbyculture.com`, because nobody had added
//     whatwg.org to it;
//   * a phrase list would fare no better: 3 of 5 content-marketing pages in the
//     same pool carried no call-to-action wording at all.
// So everything here is structural and corpus-relative. Nothing is hardcoded
// about WHICH hosts or WHICH words are good.

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

describe("sourceSignals — advisory, never a verdict", () => {
  it("flags thin attribution only on the CONJUNCTION of all three weaknesses", () => {
    const thin = sourceSignals({ url: "https://jobsbyculture.com/blog/x", text: farm });
    expect(thin.notes.join(" ")).toMatch(/thin attribution/);
    expect(thin.refDiversity).toBeLessThanOrEqual(1);

    // Any ONE of the three absent ⇒ ordinary, no caution. Another engine found it…
    expect(sourceSignals({ url: "https://jobsbyculture.com/blog/x", text: farm, corroboration: 2 }).notes.join(" ")).not.toMatch(/thin/);
    // …it cites its field…
    expect(sourceSignals({ url: "https://a.test/x", text: spec }).notes.join(" ")).not.toMatch(/thin/);
    // …or it declares a persistent identity.
    expect(sourceSignals({ url: "https://a.test/x", text: "doi:10.1145/3372297.3417263\nshort note" }).notes.join(" ")).not.toMatch(/thin/);
  });

  it("never second-guesses a page somebody already vouched for", () => {
    // The agent picked this URL out of its own WebSearch, or a scholarly API
    // handed it over. Warning the agent about a page it chose itself is
    // backwards — and it was concretely wrong: a vendor's own API reference
    // (developers.openai.com/api/reference/…) got flagged purely because a
    // reference page links nowhere.
    const apiRef = "# Streaming events\nEvent types emitted while a Response streams.";
    expect(sourceSignals({ url: "https://developers.openai.com/api/reference/x", text: apiRef }).notes.join(" ")).toMatch(/thin/);
    expect(sourceSignals({ url: "https://developers.openai.com/api/reference/x", text: apiRef, vouchedFor: true }).notes.join(" ")).not.toMatch(/thin/);
    // …and it does not silence the caution for pages nobody vouched for.
    expect(sourceSignals({ url: "https://jobsbyculture.com/blog/x", text: farm, vouchedFor: false }).notes.join(" ")).toMatch(/thin/);
  });

  it("reads the identity out of the URL when the text carries none", () => {
    // A PDF loses its hyperlinks in extraction, so an arXiv paper's text can
    // declare nothing at all — while its own address IS the identifier. Two
    // real papers were flagged "thin" before this was checked.
    const bare = "Abstract. We propose a method.";
    expect(sourceSignals({ url: "https://arxiv.org/pdf/2408.05636", text: bare }).selfIdentified).toBe(true);
    expect(sourceSignals({ url: "https://arxiv.org/abs/2401.10774v2", text: bare }).selfIdentified).toBe(true);
    expect(sourceSignals({ url: "https://doi.org/10.1145/3372297.3417263", text: bare }).selfIdentified).toBe(true);
    expect(sourceSignals({ url: "https://a.test/blog/post", text: bare }).selfIdentified).toBe(false);
  });

  it("recognises a document of record by what it does, not where it lives", () => {
    // An UNKNOWN host: no list would ever have contained it.
    const r = sourceSignals({
      url: "https://obscure-journal.example/paper",
      text: "https://doi.org/10.1145/3372297.3417263\n" + spec,
    });
    expect(r.selfIdentified).toBe(true);
    expect(r.notes.join(" ")).toMatch(/document of record/);
    expect(r.notes.join(" ")).not.toMatch(/thin/);
  });

  it("credits cross-backend corroboration, which no single engine can fake", () => {
    expect(sourceSignals({ url: "https://a.test/x", text: spec, corroboration: 3 }).notes.join(" ")).toMatch(/corroborated — 3/);
    expect(sourceSignals({ url: "https://a.test/x", text: spec, corroboration: 2 }).notes.join(" ")).not.toMatch(/corroborated/);
    expect(sourceSignals({ url: "https://a.test/x", text: spec }).corroboration).toBe(1);
  });

  it("never contradicts itself", () => {
    for (const [url, text] of [
      ["https://jobsbyculture.com/blog/x", farm],
      ["https://html.spec.whatwg.org/x", spec],
      ["https://a.test/x", "doi:10.1145/3372297.3417263\n" + spec],
    ] as [string, string][]) {
      const n = sourceSignals({ url, text, corroboration: 4 }).notes;
      const warned = n.some((v) => v.startsWith("⚠"));
      const praised = n.some((v) => v.startsWith("✓ document"));
      expect(warned && praised, url).toBe(false);
    }
  });
});
