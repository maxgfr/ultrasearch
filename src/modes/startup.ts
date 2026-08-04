import type { ModeProfile } from "../types.js";

// Market research for a product/idea. Leans on general web + community signal.
export const startupMode: ModeProfile = {
  name: "startup",
  description: "Market research — competitors, market sizing, pricing, GTM (general web + public sources).",
  backends: ["duckduckgo", "searxng", "hackernews"],
  deepOnly: ["wikipedia"],
  extras: [],
  searchAngles: [
    "the product category + 'alternatives' or 'vs'",
    "each named competitor's own pricing page",
    "market size / market share for the category, with a year",
    "what customers complain about (reviews, forums, HN threads)",
    "funding, acquisitions and who is actually shipping",
    "the regulatory or distribution constraint the category lives under",
    "how incumbents price and package, in their own words",
    "who tried this and failed, and the post-mortem they wrote",
  ],
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
