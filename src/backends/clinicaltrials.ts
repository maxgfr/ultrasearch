import type { Backend, BackendResult, RawSource } from "../types.js";
import { cleanInline } from "./fetch.js";
import { apiFailure, apiGet } from "./backoff.js";
import { sinceDate } from "../util.js";

// ClinicalTrials.gov via its keyless REST API v2 — the registry of record for
// clinical trials, and the only place an ongoing or unpublished trial shows up.
// A content backend: each study record already carries its summary, design,
// arms, outcomes and status, so the text is written here and nothing is
// hydrated. The citation is the study's own page (clinicaltrials.gov/study/NCT…),
// never the API endpoint the record was read from.
const API = "https://clinicaltrials.gov/api/v2/studies";

const titleCase = (s: string) =>
  s
    .toLowerCase()
    .replace(/_/g, " ")
    .replace(/^\w/, (c) => c.toUpperCase());

// One study record → the markdown body a reader (and `check`) sees.
export function studyText(study: any): { title: string; text: string; nctId?: string; year?: number; sponsor?: string } {
  const p = study?.protocolSection ?? {};
  const id = p.identificationModule ?? {};
  const status = p.statusModule ?? {};
  const design = p.designModule ?? {};
  const desc = p.descriptionModule ?? {};
  const nctId: string | undefined = typeof id.nctId === "string" ? id.nctId : undefined;
  const title = cleanInline(String(id.briefTitle ?? id.officialTitle ?? nctId ?? "Untitled")) || "Untitled";
  const start: string | undefined = status.startDateStruct?.date;
  const year = start ? Number(String(start).slice(0, 4)) || undefined : undefined;
  const sponsor: string | undefined = p.sponsorCollaboratorsModule?.leadSponsor?.name;
  const phases: string[] = Array.isArray(design.phases) ? design.phases.filter((x: string) => x && x !== "NA") : [];
  const lines: string[] = [`# ${title}`, ""];
  const facts: [string, string | undefined][] = [
    ["Registry id", nctId],
    ["Official title", id.officialTitle && id.officialTitle !== id.briefTitle ? cleanInline(String(id.officialTitle)) : undefined],
    ["Status", status.overallStatus ? titleCase(String(status.overallStatus)) + (status.whyStopped ? ` — ${status.whyStopped}` : "") : undefined],
    ["Study type", design.studyType ? titleCase(String(design.studyType)) : undefined],
    ["Phase", phases.length ? phases.map((x) => x.replace(/^PHASE/, "Phase ")).join(", ") : undefined],
    ["Allocation", design.designInfo?.allocation ? titleCase(String(design.designInfo.allocation)) : undefined],
    ["Masking", design.designInfo?.maskingInfo?.masking ? titleCase(String(design.designInfo.maskingInfo.masking)) : undefined],
    [
      "Enrollment",
      design.enrollmentInfo?.count !== undefined
        ? `${design.enrollmentInfo.count}${design.enrollmentInfo.type ? ` (${String(design.enrollmentInfo.type).toLowerCase()})` : ""}`
        : undefined,
    ],
    ["Conditions", Array.isArray(p.conditionsModule?.conditions) ? p.conditionsModule.conditions.join("; ") : undefined],
    [
      "Interventions",
      Array.isArray(p.armsInterventionsModule?.interventions)
        ? p.armsInterventionsModule.interventions.map((i: any) => [i?.type ? titleCase(String(i.type)) : "", i?.name].filter(Boolean).join(": ")).join("; ")
        : undefined,
    ],
    ["Lead sponsor", sponsor],
    ["Start", start],
    ["Primary completion", status.primaryCompletionDateStruct?.date],
    ["Results posted", study?.hasResults === true ? "yes" : study?.hasResults === false ? "no" : undefined],
  ];
  for (const [k, v] of facts) if (v) lines.push(`- ${k}: ${v}`);
  const primary: any[] = Array.isArray(p.outcomesModule?.primaryOutcomes) ? p.outcomesModule.primaryOutcomes : [];
  if (primary.length) {
    lines.push("", "## Primary outcomes");
    for (const o of primary) lines.push(`- ${cleanInline(String(o?.measure ?? ""))}${o?.timeFrame ? ` (${o.timeFrame})` : ""}`);
  }
  if (desc.briefSummary) lines.push("", "## Brief summary", "", String(desc.briefSummary).trim());
  if (desc.detailedDescription) lines.push("", "## Detailed description", "", String(desc.detailedDescription).trim());
  return { title, text: lines.join("\n"), nctId, year, sponsor };
}

export const clinicaltrialsBackend: Backend = async (ctx): Promise<BackendResult> => {
  const n = Math.max(3, Math.min(15, ctx.options.perSource));
  const since = sinceDate(ctx.options.since);
  const url =
    `${API}?query.term=${encodeURIComponent(ctx.question)}&pageSize=${n}&format=json` +
    (since ? `&filter.advanced=${encodeURIComponent(`AREA[StartDate]RANGE[${since},MAX]`)}` : "");
  const r = await apiGet(url);
  const studies: any[] = r.ok && Array.isArray(r.data?.studies) ? r.data.studies : [];
  if (!r.ok || !studies.length) {
    return { backend: "clinicaltrials", items: [], notes: [apiFailure("ClinicalTrials.gov search", r, ctx.question)] };
  }
  const items: RawSource[] = [];
  studies.slice(0, n).forEach((study, i) => {
    const s = studyText(study);
    if (!s.nctId) return; // a record without its id has no page to cite
    const summary = String(study?.protocolSection?.descriptionModule?.briefSummary ?? "");
    items.push({
      url: `https://clinicaltrials.gov/study/${s.nctId}`,
      title: s.title,
      backend: "clinicaltrials",
      score: n - i,
      snippet: (summary || s.title).replace(/\s+/g, " ").slice(0, 360),
      text: s.text,
      // The sponsor is not an author: kept apart so refs.bib does not invent one.
      meta: { nctId: s.nctId, year: s.year, ...(s.sponsor ? { sponsor: s.sponsor } : {}), venue: "ClinicalTrials.gov" },
    });
  });
  return { backend: "clinicaltrials", items, notes: [`ClinicalTrials.gov returned ${items.length} study record(s).`] };
};
