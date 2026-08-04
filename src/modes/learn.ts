import type { ModeProfile } from "../types.js";

// Learning a topic from scratch — pedagogical. Produces a glossary + exercises
// and the richest HTML (collapsible exercise/solution sections).
export const learnMode: ModeProfile = {
  name: "learn",
  description: "Pedagogical lesson with glossary, worked examples and exercises (rich HTML).",
  backends: ["wikipedia", "duckduckgo", "searxng"],
  deepOnly: ["standards"],
  extras: ["glossary", "exercises"],
  searchAngles: [
    "the topic + 'tutorial' or 'getting started'",
    "the topic explained for a beginner ('explained', 'from scratch')",
    "the official documentation's own introduction",
    "worked examples and common exercises",
    "the mistakes beginners make ('common pitfalls', 'gotchas')",
    "the prerequisites: what you must know first",
    "the mental model an expert uses (analogies, first principles)",
    "what to learn NEXT once this is understood",
  ],
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
