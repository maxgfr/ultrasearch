import type { ModeProfile } from "../types.js";

// Learning a topic from scratch — pedagogical. Produces a glossary + exercises
// and the richest HTML (collapsible exercise/solution sections).
export const learnMode: ModeProfile = {
  name: "learn",
  description: "Pedagogical lesson with glossary, worked examples and exercises (rich HTML).",
  backends: ["wikipedia", "duckduckgo", "searxng"],
  deepOnly: [],
  extras: ["glossary", "exercises"],
  template: [
    "## Learning objectives",
    "## Prerequisites",
    "## Glossary (see glossary.md)",
    "## Lesson",
    "### Concept 1 — explanation + example",
    "### Concept 2 — explanation + example",
    "## Worked examples",
    "## Exercises",
    "## Solutions",
    "## Further reading",
    "## Sources",
  ].join("\n"),
};
