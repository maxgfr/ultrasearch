import type { ModeProfile } from "../types.js";

// Clinical and biomedical evidence review. `research` was built for CS and
// physics: on a purely clinical question it brought back arXiv preprints (two
// of them 404s) and left PubMed, the reference index of the field, to --depth
// deep. This profile searches the biomedical indexes and the trial registry,
// never arXiv, and asks for the report a clinician reads: the question as PICO,
// trials and reviews, efficacy, harms, guidelines, certainty, ongoing trials.
export const clinicalMode: ModeProfile = {
  name: "clinical",
  description:
    "Clinical / biomedical evidence review — PubMed (E-utilities), Europe PMC, ClinicalTrials.gov, Crossref; no arXiv (+OpenAlex/Semantic Scholar/web guidelines at deep) + refs.bib.",
  backends: ["pubmed", "europepmc", "clinicaltrials", "crossref"],
  deepOnly: ["openalex", "semanticscholar", "duckduckgo"],
  extras: ["bibtex"],
  searchAngles: [
    "the condition + the intervention + 'randomized controlled trial'",
    "'systematic review' OR 'meta-analysis' + the condition and the intervention",
    "clinical practice guidelines and consensus statements (national agencies, learned societies) on the topic",
    "the MeSH terms for the condition and the intervention, as PubMed spells them",
    "cohort, registry or case-series outcomes + the topic",
    "adverse events, complications and safety signals of the intervention",
    "registered and ongoing trials (ClinicalTrials.gov, EU CTR) for the condition",
    "the comparator: standard of care, placebo or the alternative intervention",
    "long-term follow-up: survival, recurrence, revision or relapse",
    "cost-effectiveness and health-economic evaluations",
  ],
  template: [
    "## TL;DR (clinical bottom line)",
    "## Clinical question (PICO)",
    "## Evidence base (trials, systematic reviews, cohorts)",
    "## Efficacy outcomes",
    "## Safety & adverse events",
    "## Guidelines & recommendations",
    "## Certainty of evidence & limitations",
    "## Ongoing & registered trials",
    "## Gaps & open questions",
    "## References (see refs.bib)",
    "## Sources",
  ].join("\n"),
};
