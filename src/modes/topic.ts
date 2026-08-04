import type { ModeProfile } from "../types.js";

// General briefing on any subject — the default. Leans on encyclopedic +
// general web coverage.
export const topicMode: ModeProfile = {
  name: "topic",
  description: "General briefing on any subject (Wikipedia + general web).",
  backends: ["wikipedia", "searxng", "duckduckgo", "standards"],
  deepOnly: [],
  extras: [],
  searchAngles: [
    "the subject itself, as a plain definition",
    "how it works — mechanism, architecture, internals",
    "the official/primary source: the vendor, project or standards body's own pages",
    "criticism, limitations and open debates",
    "current state: what changed most recently, and when",
    "alternatives and how they compare",
    "who actually runs it in production, and what they report",
    "the numbers: benchmarks, costs, adoption figures with a date",
  ],
  template: [
    "## TL;DR",
    "## What it is",
    "## How it works / key concepts",
    "## History & evolution",
    "## Current state (today)",
    "## Notable variants / approaches",
    "## Controversies & open debates",
    "## Practical implications",
    "## Sources",
  ].join("\n"),
};
