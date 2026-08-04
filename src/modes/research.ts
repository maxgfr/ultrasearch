import type { ModeProfile } from "../types.js";

// Scholarly literature review. Leans on academic APIs and emits a BibTeX file.
export const researchMode: ModeProfile = {
  name: "research",
  description: "Scholarly literature review (arXiv, Crossref, OpenAlex, Semantic Scholar, Europe PMC; +PubMed/dblp at deep) + refs.bib.",
  backends: ["arxiv", "openalex", "crossref", "semanticscholar", "europepmc"],
  deepOnly: ["pubmed", "dblp", "duckduckgo", "wikipedia"],
  extras: ["bibtex"],
  searchAngles: [
    "the topic + 'survey' or 'systematic review'",
    "the canonical method/model name, as the field spells it",
    "the seminal paper: earliest work everyone cites",
    "recent work: the topic + the current year",
    "the counter-position: critiques, failed replications, negative results",
    "the benchmark or dataset the field measures this on",
    "the review article that maps the subfield's disagreements",
    "who cites the seminal work and what they changed about it",
  ],
  template: [
    "## Abstract / TL;DR",
    "## Background & motivation",
    "## Key papers (chronological)",
    "## Methods & approaches compared",
    "## Findings & consensus",
    "## Gaps & open problems",
    "## Future directions",
    "## References (see refs.bib)",
    "## Sources",
  ].join("\n"),
};
