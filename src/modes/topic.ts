import type { ModeProfile } from "../types.js";

// General briefing on any subject — the default. Leans on encyclopedic +
// general web coverage.
export const topicMode: ModeProfile = {
  name: "topic",
  description: "General briefing on any subject (Wikipedia + general web).",
  backends: ["wikipedia", "searxng", "duckduckgo", "standards"],
  deepOnly: [],
  extras: [],
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
