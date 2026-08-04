import type { ModeProfile } from "../types.js";

// Debugging an error / symptom. Leans on Q&A and issue trackers.
export const bugMode: ModeProfile = {
  name: "bug",
  description: "Error & debugging research (Stack Overflow, GitHub issues, Hacker News, changelogs).",
  backends: ["stackexchange", "github", "duckduckgo", "hackernews", "standards"],
  deepOnly: ["searxng"],
  extras: [],
  searchAngles: [
    "the error text VERBATIM, in quotes",
    "the error text with the volatile parts (paths, ids, ports) stripped out",
    "the symptom described in plain words, without the stack trace",
    "the library/tool name + the error + 'github issue'",
    "the library/tool name + the version where it started",
    "the fix phrasing: how people who solved it describe the workaround",
    "the changelog or release notes around the version that broke it",
    "the same symptom in a NEIGHBOURING tool — often the same root cause",
  ],
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
