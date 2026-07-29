import { TOOLS, WRITE_TOOLS } from "./tools.js";

// The workflows, as MCP prompts.
//
// Tools are the half of this skill a client can discover on its own. The other
// half is the invariant the whole thing exists for: the report says what the
// FETCHED SOURCES say, not what the model remembers. A client handed eleven
// tools and no protocol runs one search, recognises the topic, and writes from
// memory with a few citations decorating it — which is indistinguishable from
// grounded work right up until it is wrong.
//
// Each prompt says three things, in this order: the contract, the exact tool
// sequence, and what the gate does on failure.

export interface PromptArgument {
  name: string;
  description: string;
  required?: boolean;
}

export interface PromptDecl {
  name: string;
  title?: string;
  description: string;
  arguments: PromptArgument[];
}

export interface PromptMessage {
  role: "user" | "assistant";
  content: { type: "text"; text: string };
}

export interface PromptResult {
  description: string;
  messages: PromptMessage[];
}

export class PromptError extends Error {}

export const PROMPTS: PromptDecl[] = [
  {
    name: "research_topic",
    title: "Research a topic from the real web",
    description:
      "The grounded-report workflow: gather a dossier from live sources, write a report that cites every claim, and prove it with the citation gate. Use " +
      "for any 'what does the web say about X' question.",
    arguments: [
      { name: "question", description: "The topic or question to research.", required: true },
      { name: "depth", description: "summary (~30s), standard (2-4 min), deep (10-20 min). Default: standard.", required: false },
    ],
  },
  {
    name: "debug_error",
    title: "Debug an error against real reports of it",
    description:
      "The bug workflow: search StackOverflow, GitHub issues and HN for this exact failure, read what actually fixed it for other people, and answer with " +
      "the fix and its evidence rather than a plausible guess.",
    arguments: [
      { name: "error", description: "The error message or failing behaviour, verbatim.", required: true },
      { name: "context", description: "Library, version, runtime — anything that narrows which report applies.", required: false },
    ],
  },
  {
    name: "literature_review",
    title: "Review the literature on a question",
    description:
      "The research workflow: search the scholarly APIs, decompose a broad question into sub-questions, merge the sub-dossiers, and write a review whose " +
      "every claim is traceable to a paper.",
    arguments: [{ name: "question", description: "The research question.", required: true }],
  },
];

export function getPrompt(name: string, args: Record<string, unknown> = {}): PromptResult {
  const decl = PROMPTS.find((p) => p.name === name);
  if (!decl) throw new PromptError(`unknown prompt: ${name || "(none given)"}`);

  for (const arg of decl.arguments) {
    if (arg.required && !str(args[arg.name])) throw new PromptError(`\`${arg.name}\` is required for prompt "${name}"`);
  }

  const text = name === "research_topic" ? researchTopic(args) : name === "debug_error" ? debugError(args) : literatureReview(args);
  return { description: decl.description, messages: [{ role: "user", content: { type: "text", text } }] };
}

// The rule every workflow here rests on. Stated once, quoted into each prompt,
// so the two can never drift apart.
const CORE_RULE = `Answer only from the sources this dossier actually fetched. Your training data is stale, and on a fast-moving topic it is confidently wrong. If the dossier does not cover something, say so and gather more — never fill the gap from memory and decorate it with a nearby citation.`;

const GATE = `\`ultrasearch_check\` returning \`ok: false\` is a VERDICT, not a tool failure. Read the errors, fix the report, and check again. Do not report a document that has not passed.`;

const THIN = `**If the dossier comes back thin**, do not write around it. Either gather again with different wording — the topic's own vocabulary, not yours — or find pages yourself and ingest each one with \`ultrasearch_fetch\` so it becomes a citable [S#]. A thin dossier honestly reported beats a full-looking report resting on four sources.`;

function researchTopic(args: Record<string, unknown>): string {
  const question = str(args.question)!;
  const depth = str(args.depth);

  return `Research this and write a cited report:

> ${question}

${CORE_RULE}

**Sequence:**

1. If the question is too vague to search well, \`ultrasearch_brainstorm\` first and sharpen it. A broad gather returns a shallow dossier about the wrong thing.
2. \`ultrasearch_gather\` with \`mode: "topic"\`${depth ? ` and \`depth: "${depth}"\`` : ""}. It returns the dossier directory.
3. \`ultrasearch_read\` its \`DOSSIER.md\`. Read every source before writing anything.
4. Write the report: one claim per sentence, each carrying the \`[S#]\` it rests on. Quote figures, dates and names verbatim from the source — never reconstructed.
5. \`ultrasearch_check\` on the dossier. Then \`ultrasearch_render\` once it passes.

${THIN}

**Where sources disagree, say so and cite both.** A synthesis that silently picks a side is the failure this whole pipeline is built to prevent.

${GATE}`;
}

function debugError(args: Record<string, unknown>): string {
  const error = str(args.error)!;
  const context = str(args.context);

  return `Find out what actually causes this error and what fixes it:

> ${error}
${context ? `\nContext: ${context}\n` : ""}
${CORE_RULE}

**Sequence:**

1. \`ultrasearch_gather\` with \`mode: "bug"\` and the error message as the question${context ? `, adding "${context}" to narrow it` : ""}. That mode searches StackOverflow, GitHub issues and HN — where this failure is actually reported.
2. \`ultrasearch_read\` the dossier. Read the accepted answers AND the comments under them: the top-voted fix is often superseded further down.
3. \`ultrasearch_search\` with \`backend: "github"\` if the dossier is thin — an open issue on the library itself settles "is this me or is this a bug" faster than anything else.
4. Answer with: the cause, the fix, and what to check to confirm it is the same failure and not a lookalike. Each cited \`[S#]\`.
5. \`ultrasearch_check\` on the dossier.

**Check the version.** A fix from a 2019 answer for a library now on v5 is not evidence about v5. If the sources do not say which version they apply to, say so — that is a real limit on the answer, not a detail to smooth over.

${GATE}`;
}

function literatureReview(args: Record<string, unknown>): string {
  const question = str(args.question)!;

  return `Write a literature review on:

> ${question}

${CORE_RULE}

**Sequence:**

1. \`ultrasearch_plan\` with \`mode: "research"\` — a broad question decomposes into sub-questions, each with its own dossier directory.
2. \`ultrasearch_gather\` on each sub-question, into the directory the plan named.
3. \`ultrasearch_merge\` the sub-dossiers into one. The \`[S#]\` ids are re-assigned to stay unique — cite the MERGED ids, not the ones you saw per sub-question.
4. \`ultrasearch_read\` the merged dossier, then write ONE review against it — not one section per sub-question stapled together.
5. \`ultrasearch_check\` on the merged dossier, then \`ultrasearch_render\`.

${THIN}

**Attribute findings to specific papers, with their limits.** "Studies show X" citing four papers is weaker than one sentence naming what one study measured, in what population, and what it did not establish. Where the literature disagrees, that disagreement IS the finding.

${GATE}`;
}

function str(v: unknown): string | undefined {
  return typeof v === "string" && v.trim() !== "" ? v : undefined;
}

// Every tool a prompt tells the model to call must actually be declared —
// otherwise a prompt survives a tool rename as a set of instructions that
// cannot be followed. Exported so the test can assert it.
const DECLARED = new Set([...TOOLS, ...WRITE_TOOLS].map((t) => t.name));

export function toolNamesReferencedBy(text: string): string[] {
  const found = new Set<string>();
  for (const m of text.matchAll(/ultrasearch_[a-z_]+/g)) if (DECLARED.has(m[0])) found.add(m[0]);
  return [...found].sort();
}

export function unknownToolNamesIn(text: string): string[] {
  const bad = new Set<string>();
  for (const m of text.matchAll(/ultrasearch_[a-z_]+/g)) if (!DECLARED.has(m[0])) bad.add(m[0]);
  return [...bad].sort();
}
