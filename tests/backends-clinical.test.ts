import { afterEach, describe, expect, it, vi } from "vitest";
import { clinicaltrialsBackend, studyText } from "../src/backends/clinicaltrials.js";
import { apiFailure, apiGet, isThrottled, withBackoff } from "../src/backends/backoff.js";
import { semanticscholarBackend } from "../src/backends/semanticscholar.js";
import { crossrefBackend } from "../src/backends/crossref.js";
import { openalexBackend } from "../src/backends/openalex.js";
import { pubmedBackend } from "../src/backends/pubmed.js";
import { runBackends } from "../src/backends/registry.js";
import { getMode } from "../src/modes/registry.js";
import { trustScore } from "../src/util.js";
import { installFetchMock, routes } from "./fetchmock.js";
import { makeCtx } from "./ctx.js";

afterEach(() => vi.unstubAllGlobals());

const STUDY = {
  protocolSection: {
    identificationModule: {
      nctId: "NCT06122116",
      briefTitle: "PRP and Photobiomodulation for Knee Osteoarthritis",
      officialTitle: "Investigating Orthobiologics After Platelet-Rich Plasma and Photobiomodulation Treatment of Knee Osteoarthritis",
    },
    statusModule: {
      overallStatus: "TERMINATED",
      whyStopped: "IRB terminated the protocol.",
      startDateStruct: { date: "2023-10-13" },
      primaryCompletionDateStruct: { date: "2024-10-10" },
    },
    sponsorCollaboratorsModule: { leadSponsor: { name: "MIRROR" } },
    descriptionModule: {
      briefSummary: "This research assesses PRP injections for knee osteoarthritis.",
      detailedDescription: "Over 20,000 cases were detected.",
    },
    conditionsModule: { conditions: ["Knee Osteoarthritis"] },
    designModule: {
      studyType: "INTERVENTIONAL",
      phases: ["PHASE2"],
      designInfo: { allocation: "RANDOMIZED", maskingInfo: { masking: "NONE" } },
      enrollmentInfo: { count: 33, type: "ACTUAL" },
    },
    armsInterventionsModule: { interventions: [{ type: "BIOLOGICAL", name: "Platelet-rich plasma" }, { name: "Physical therapy" }] },
    outcomesModule: { primaryOutcomes: [{ measure: "Kellgren Lawrence grade", timeFrame: "Baseline" }] },
  },
  hasResults: false,
};

describe("clinicaltrials backend", () => {
  it("turns a study record into a cited page with its design, arms and outcomes as text", async () => {
    const spy = installFetchMock(
      routes([["clinicaltrials.gov/api/v2/studies", { body: JSON.stringify({ studies: [STUDY, { protocolSection: {} }] }), contentType: "application/json" }]]),
    );
    const r = await clinicaltrialsBackend(makeCtx("knee osteoarthritis PRP", { since: "2020" }));
    expect(r.items).toHaveLength(1); // the record without an NCT id has no page to cite
    const it0 = r.items[0]!;
    expect(it0.url).toBe("https://clinicaltrials.gov/study/NCT06122116");
    expect(it0.backend).toBe("clinicaltrials");
    expect(it0.meta).toMatchObject({ nctId: "NCT06122116", year: 2023, sponsor: "MIRROR", venue: "ClinicalTrials.gov" });
    expect(it0.meta?.authors).toBeUndefined();
    expect(it0.text).toContain("- Status: Terminated — IRB terminated the protocol.");
    expect(it0.text).toContain("- Phase: Phase 2");
    expect(it0.text).toContain("- Enrollment: 33 (actual)");
    expect(it0.text).toContain("- Interventions: Biological: Platelet-rich plasma; Physical therapy");
    expect(it0.text).toContain("## Primary outcomes\n- Kellgren Lawrence grade (Baseline)");
    expect(it0.text).toContain("Over 20,000 cases");
    expect(it0.snippet).toContain("PRP injections");
    expect(r.notes[0]).toMatch(/1 study record/);
    const called = String(spy.mock.calls[0]![0]);
    expect(called).toContain("query.term=knee%20osteoarthritis%20PRP");
    expect(decodeURIComponent(called)).toContain("AREA[StartDate]RANGE[2020-01-01,MAX]");
  });

  it("reports an empty result and a rate limit honestly", async () => {
    installFetchMock(routes([["clinicaltrials.gov", { body: JSON.stringify({ studies: [] }), contentType: "application/json" }]]));
    expect((await clinicaltrialsBackend(makeCtx("x"))).notes[0]).toMatch(/failed or empty/);
    installFetchMock(() => ({ status: 429, body: "" }));
    expect((await clinicaltrialsBackend(makeCtx("x"))).notes[0]).toMatch(/rate-limited \(HTTP 429 after 3 attempts\)/);
  });

  it("studyText tolerates a sparse record", () => {
    const s = studyText({ protocolSection: { identificationModule: { nctId: "NCT1" } }, hasResults: true });
    expect(s.title).toBe("NCT1");
    expect(s.text).toContain("- Results posted: yes");
    expect(studyText(undefined).title).toBe("Untitled");
  });

  it("is registered, trusted like the other scholarly APIs, and run by the clinical mode", async () => {
    expect(trustScore("https://clinicaltrials.gov/study/NCT1", "clinicaltrials")).toBe(0.9);
    installFetchMock(routes([["clinicaltrials.gov", { body: JSON.stringify({ studies: [STUDY] }), contentType: "application/json" }]]));
    const ctx = { ...makeCtx("knee PRP"), mode: getMode("clinical"), variants: ["knee PRP", "PRP knee osteoarthritis"] };
    const [res] = await runBackends(["clinicaltrials"], ctx);
    expect(res!.items.map((i) => i.url)).toEqual(["https://clinicaltrials.gov/study/NCT06122116"]);
  });
});

describe("withBackoff", () => {
  it("waits out a 429, honouring Retry-After, then returns the success", async () => {
    const waits: number[] = [];
    const seq = [{ status: 429, retryAfterMs: 2500 }, { status: 503 }, { status: 200 }];
    const out = await withBackoff(async () => seq.shift()!, { baseMs: 1000, sleepFn: async (ms) => void waits.push(ms) });
    expect(out.result.status).toBe(200);
    expect(out.attempts).toBe(3);
    expect(waits).toEqual([2500, 2000]); // Retry-After as given, then exponential (2nd attempt → 2 s)
    expect(out.waitedMs).toBe(4500);
    expect(out.rateLimited).toBe(false);
  });

  it("stops after three attempts and says it is still rate-limited", async () => {
    let calls = 0;
    const out = await withBackoff(
      async () => {
        calls++;
        return { status: 429 };
      },
      { baseMs: 0 },
    );
    expect(calls).toBe(3);
    expect(out.rateLimited).toBe(true);
  });

  it("does not wait out a Retry-After above the 30 s cap", async () => {
    const sleepFn = vi.fn(async () => {});
    const out = await withBackoff(async () => ({ status: 429, retryAfterMs: 120_000 }), { sleepFn });
    expect(sleepFn).not.toHaveBeenCalled();
    expect(out.attempts).toBe(1);
    expect(out.gaveUpOnRetryAfterMs).toBe(120_000);
  });

  it("treats a 403 the engine flagged as rate-limited as throttled, and a 404 as final", () => {
    expect(isThrottled({ status: 403, rateLimited: true })).toBe(true);
    expect(isThrottled({ status: 404 })).toBe(false);
    expect(apiFailure("X", { status: 404, rateLimited: false, attempts: 1 })).toBe("X failed or empty (status 404).");
    expect(apiFailure("X", { status: 429, rateLimited: true, attempts: 1 })).toBe("X rate-limited (HTTP 429).");
  });

  it("apiGet reads Retry-After from the response and returns parsed JSON once it clears", async () => {
    let n = 0;
    installFetchMock(() => (n++ === 0 ? { status: 429, body: "", headers: { "retry-after": "0" } } : { body: '{"ok":1}', contentType: "application/json" }));
    const r = await apiGet("https://api.example.test/x");
    expect(r).toMatchObject({ ok: true, status: 200, data: { ok: 1 }, attempts: 2, rateLimited: false });
    installFetchMock(() => ({ body: "plain", contentType: "text/plain" }));
    expect((await apiGet("https://api.example.test/y", { json: false })).data).toBe("plain");
    installFetchMock(() => ({ body: "<not json", contentType: "application/json" }));
    expect((await apiGet("https://api.example.test/z")).data).toBe("<not json");
  });
});

describe("scholarly backends label a 429 as rate-limited, never as failed", () => {
  it.each([
    ["Semantic Scholar search", semanticscholarBackend],
    ["Crossref search", crossrefBackend],
    ["OpenAlex search", openalexBackend],
    ["PubMed esearch", pubmedBackend],
  ] as const)("%s", async (label, backend) => {
    const spy = installFetchMock(() => ({ status: 429, body: "" }));
    const r = await backend(makeCtx("x"));
    expect(r.items).toHaveLength(0);
    expect(r.notes[0]).toBe(`${label} rate-limited (HTTP 429 after 3 attempts).`);
    expect(spy).toHaveBeenCalledTimes(3);
  });

  it("recovers when the API clears on a later attempt", async () => {
    let n = 0;
    installFetchMock(() =>
      n++ < 1
        ? { status: 429, body: "" }
        : { body: JSON.stringify({ data: [{ title: "Paper", abstract: "A", url: "https://s2.test/p", year: 2020 }] }), contentType: "application/json" },
    );
    const r = await semanticscholarBackend(makeCtx("x"));
    expect(r.items).toHaveLength(1);
  });
});
