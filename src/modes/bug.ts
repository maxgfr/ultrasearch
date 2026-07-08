import type { ModeProfile } from "../types.js";

// Debugging an error / symptom. Leans on Q&A and issue trackers.
export const bugMode: ModeProfile = {
  name: "bug",
  description: "Error & debugging research (Stack Overflow, GitHub issues, Hacker News, changelogs).",
  backends: ["stackexchange", "github", "duckduckgo", "hackernews", "standards"],
  deepOnly: ["searxng"],
  extras: [],
  template: [
    "## TL;DR (likely cause + fastest fix)",
    "## Symptom & reproduction",
    "## Root cause analysis",
    "## Candidate fixes (ranked)",
    "### Fix A — <summary> [confidence]",
    "### Fix B — <summary>",
    "## Related issues & versions affected",
    "## Workarounds",
    "## If still stuck (next diagnostics)",
    "## Sources",
  ].join("\n"),
};
