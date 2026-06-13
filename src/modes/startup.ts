import type { ModeProfile } from "../types.js";

// Market research for a product/idea. Leans on general web + community signal.
export const startupMode: ModeProfile = {
  name: "startup",
  description: "Market research — competitors, market sizing, pricing, GTM (general web + public sources).",
  backends: ["duckduckgo", "searxng", "hackernews"],
  deepOnly: ["wikipedia"],
  extras: [],
  template: [
    "## Executive summary",
    "## Problem & customer",
    "## Market sizing (TAM / SAM / SOM)",
    "## Competitive landscape",
    "### Competitor table (name · positioning · pricing)",
    "## Pricing & business models observed",
    "## Go-to-market channels",
    "## Trends & timing",
    "## Risks & moats",
    "## Sources",
  ].join("\n"),
};
