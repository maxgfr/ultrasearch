import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Depth, ModeName, PlanResult, SubQuestion } from "./types.js";
import { DEEP_CAPS } from "./types.js";
import { getMode } from "./modes/registry.js";
import { rankedKeywords, extractIdentifiers, keywords, planVariants } from "./util.js";

// Mode-template headings that are summary or structure, not independent research
// angles — skipped when deriving sub-questions (the deep loop synthesises these
// from the others, it doesn't research them).
const SKIP_HEADING = /^(tl;?dr|abstract\b|executive summary|sources\b|references\b|further reading|solutions\b)/i;

// Strip leading research scaffolding so the sub-questions are ABOUT the subject,
// not "…—How it works" appended to the raw ask. "deep research on HTTP 429 rate
// limiting" → "HTTP 429 rate limiting". Falls back to the whole question when
// the residue is too thin to be a subject.
export function subjectOf(question: string): string {
  const bare = question.trim().replace(/\?+\s*$/, "");
  let s = bare;
  const strip =
    /^(please\s+)?(deep\s+|thoroughly\s+|exhaustively\s+)?(research(?:\s+on)?|explain|describe|tell me about|teach me|give me|summari[sz]e|what(?:'s| is| are)?|how (?:do(?:es)?|to)|why (?:is|are|do(?:es)?)|when (?:did|was)|who (?:is|are))\b[:\s]*/i;
  let prev: string;
  do {
    prev = s;
    s = s.replace(strip, "").trim();
  } while (s !== prev && s.length > 0);
  s = s
    .replace(/^(about|on|regarding|of)\s+/i, "")
    .replace(/^(the|a|an)\s+/i, "")
    .trim();
  return keywords(s).length >= 2 ? s : bare;
}

// Map a mode-template heading to a genuinely interrogative sub-question about
// the subject, plus facet-specific query terms. Covers all five shipped
// templates by pattern; an unmatched heading gets a generic (never the old
// "<question> — <heading>" concat). Exported so `brainstorm` reuses it.
//
// `ask` embeds the subject as a NOUN PHRASE ("What is <s>…"). When `subjectOf`
// leaves a clausal residue (a finite verb survives the interrogative strip —
// "…algorithms compare for API gateways", "deploy a Node app…") that noun frame
// is ungrammatical, so `angle` is a self-standing question clause we hang off a
// reference to the ORIGINAL question instead ("In the context of "<q>",
// <angle>?"). `angle` stays grammatical for any subject shape.
const FACET_PATTERNS: { re: RegExp; ask: (s: string) => string; angle: string; terms: string[] }[] = [
  // topic / research
  {
    re: /what it is|definition/i,
    ask: (s) => `What is ${s} and how is it defined?`,
    angle: "what are the key concepts and how are they defined",
    terms: ["definition", "overview"],
  },
  {
    re: /how it works|key concepts|mechanism/i,
    ask: (s) => `How does ${s} work under the hood?`,
    angle: "how do the underlying mechanisms work",
    terms: ["how it works", "internals"],
  },
  {
    re: /history|evolution|background|motivation/i,
    ask: (s) => `What is the history and motivation behind ${s}?`,
    angle: "what is the history and motivation",
    terms: ["history", "origin"],
  },
  {
    re: /current state|today/i,
    ask: (s) => `What is the current state of ${s} today?`,
    angle: "what is the current state today",
    terms: ["current", "latest"],
  },
  {
    re: /variants|approaches|alternatives|compar|methods/i,
    ask: (s) => `What are the main variants and approaches to ${s}, and how do they compare?`,
    angle: "what are the main approaches and how do they compare",
    terms: ["comparison", "alternatives"],
  },
  {
    re: /controvers|debate|gaps|open problem/i,
    ask: (s) => `What are the open debates, gaps or limitations of ${s}?`,
    angle: "what are the open debates, gaps or limitations",
    terms: ["limitations", "criticism"],
  },
  {
    re: /practical|implication|future direction/i,
    ask: (s) => `What are the practical implications and future directions of ${s}?`,
    angle: "what are the practical implications and future directions",
    terms: ["best practices", "use cases"],
  },
  {
    re: /key papers|literature/i,
    ask: (s) => `What are the key papers and prior work on ${s}?`,
    angle: "what are the key papers and prior work",
    terms: ["paper", "prior work"],
  },
  {
    re: /findings|consensus|results/i,
    ask: (s) => `What are the main findings and consensus on ${s}?`,
    angle: "what are the main findings and consensus",
    terms: ["findings", "evidence"],
  },
  // bug
  {
    re: /symptom|reproduction/i,
    ask: (s) => `What are the symptoms and how do you reproduce ${s}?`,
    angle: "what are the symptoms and how is it reproduced",
    terms: ["error", "reproduce"],
  },
  { re: /root cause/i, ask: (s) => `What is the root cause of ${s}?`, angle: "what is the root cause", terms: ["root cause", "why"] },
  {
    re: /candidate fix|fixes|solution/i,
    ask: (s) => `What are the candidate fixes for ${s}?`,
    angle: "what are the candidate fixes",
    terms: ["fix", "resolve"],
  },
  {
    re: /related issues|versions affected/i,
    ask: (s) => `What related issues or affected versions are known for ${s}?`,
    angle: "what related issues or affected versions are known",
    terms: ["issue", "version"],
  },
  { re: /workaround/i, ask: (s) => `What workarounds exist for ${s}?`, angle: "what workarounds exist", terms: ["workaround", "mitigation"] },
  { re: /diagnostic/i, ask: (s) => `What further diagnostics help when ${s} persists?`, angle: "what further diagnostics help", terms: ["debug", "diagnose"] },
  // learn
  {
    re: /learning objective|objectives/i,
    ask: (s) => `What should someone learn first about ${s}?`,
    angle: "what should someone learn first",
    terms: ["basics", "introduction"],
  },
  {
    re: /prerequisite/i,
    ask: (s) => `What are the prerequisites for learning ${s}?`,
    angle: "what are the prerequisites",
    terms: ["prerequisite", "fundamentals"],
  },
  { re: /lesson|glossary|concept/i, ask: (s) => `What are the core concepts of ${s}?`, angle: "what are the core concepts", terms: ["concept", "explanation"] },
  {
    re: /worked example|example/i,
    ask: (s) => `What are good worked examples of ${s}?`,
    angle: "what are good worked examples",
    terms: ["example", "tutorial"],
  },
  { re: /exercise/i, ask: (s) => `What exercises help practise ${s}?`, angle: "what exercises help build proficiency", terms: ["exercise", "practice"] },
  // startup
  {
    re: /problem|customer/i,
    ask: (s) => `What problem does ${s} solve and for which customers?`,
    angle: "what problem is solved and for which customers",
    terms: ["problem", "customer"],
  },
  {
    re: /market siz/i,
    ask: (s) => `How large is the market for ${s} (TAM/SAM/SOM)?`,
    angle: "how large is the market (TAM/SAM/SOM)",
    terms: ["market size", "TAM"],
  },
  {
    re: /competit/i,
    ask: (s) => `Who are the competitors in ${s} and how are they positioned?`,
    angle: "who are the competitors and how are they positioned",
    terms: ["competitor", "alternatives"],
  },
  {
    re: /pricing|business model/i,
    ask: (s) => `What pricing and business models are used in ${s}?`,
    angle: "what pricing and business models are used",
    terms: ["pricing", "business model"],
  },
  {
    re: /go-to-market|channel/i,
    ask: (s) => `What go-to-market channels work for ${s}?`,
    angle: "what go-to-market channels work",
    terms: ["go to market", "acquisition"],
  },
  {
    re: /trends|timing/i,
    ask: (s) => `What trends and timing favour ${s} now?`,
    angle: "what trends and timing are favourable now",
    terms: ["trend", "timing"],
  },
  { re: /risks|moats/i, ask: (s) => `What are the risks and moats for ${s}?`, angle: "what are the risks and moats", terms: ["risk", "moat"] },
];

// Verbs that, surviving into a subjectOf residue, mark it as a CLAUSE rather
// than a noun phrase (so the "What is <s>…" frames would break). Auxiliaries +
// the common action verbs that trail comparison/how-to/why question forms.
const CLAUSE_VERB =
  /\b(is|are|was|were|be|been|being|do|does|did|has|have|had|can|could|should|would|will|shall|may|might|must|compares?|compared|works?|worked|deploys?|deployed|builds?|creates?|uses?|implements?|runs?|configures?|installs?|handles?|manages?|scales?|optimi[sz]es?|chooses?|migrates?|fix(?:es)?|debugs?|prevents?|avoids?|improves?|reduces?|increases?|affects?|causes?|differs?|relates?|applies|integrates?|connects?|stores?|processes?|generates?|renders?|parses?|validates?|measures?|monitors?)\b/i;

// A subjectOf residue is clausal (not a clean noun phrase) when a finite/base
// verb survives it, or it is so long it is almost certainly a full clause.
function isClausalSubject(subject: string): boolean {
  const words = subject.split(/\s+/).filter(Boolean);
  return words.length >= 8 || CLAUSE_VERB.test(subject);
}

// Hang a self-standing angle clause off a quoted reference to the original
// question — grammatical no matter how clause-shaped the subject is.
function clauseSafe(question: string, angle: string): string {
  const topic = question.trim().replace(/\?+\s*$/, "");
  return `In the context of "${topic}", ${angle}?`;
}

// `question` (the original ask) is only used when the subject is clausal, to
// switch from the noun-phrase frame to the clause-safe "In the context of …"
// frame. Callers that pass a clean noun-phrase subject (e.g. brainstorm) can
// omit it and keep the noun-phrase phrasing.
export function facetQuestion(subject: string, heading: string, question?: string): { question: string; terms: string[] } {
  const clausal = question !== undefined && isClausalSubject(subject);
  for (const p of FACET_PATTERNS) {
    if (p.re.test(heading)) {
      return { question: clausal ? clauseSafe(question, p.angle) : p.ask(subject), terms: p.terms };
    }
  }
  const generic = clausal
    ? clauseSafe(question, `what does the evidence say about ${heading.toLowerCase()}`)
    : `What does the evidence say about ${heading.toLowerCase()} for ${subject}?`;
  return { question: generic, terms: keywords(heading).slice(0, 2) };
}

function dedupeQueries(qs: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const q of qs) {
    const k = q.trim().toLowerCase();
    if (!k || seen.has(k)) continue;
    seen.add(k);
    out.push(q.trim());
  }
  return out;
}

function mk(question: string, facet: SubQuestion["facet"], rationale: string, queries?: string[]): SubQuestion {
  return { id: "", question, facet, queries: queries ?? planVariants(question, "deep"), rationale };
}

// Distinct researchable angles from the mode's report template: each "## …"
// heading (minus the summary/structure ones) becomes a genuinely interrogative
// sub-question about the SUBJECT (scaffolding stripped), with facet-specific
// queries (the interrogative + the subject's distinctive terms joined with the
// facet terms) — so the fan-out searches differently per angle.
function templateFacets(question: string, template: string): SubQuestion[] {
  const subject = subjectOf(question);
  const subjKeywords = rankedKeywords(subject).slice(0, 3).join(" ");
  const out: SubQuestion[] = [];
  for (const line of template.split("\n")) {
    const m = /^##\s+(.+?)\s*$/.exec(line.trim());
    if (!m) continue;
    const heading = m[1]!.trim();
    if (SKIP_HEADING.test(heading)) continue;
    const fq = facetQuestion(subject, heading, question);
    const facetQuery = `${subjKeywords} ${fq.terms.slice(0, 2).join(" ")}`.trim();
    const queries = dedupeQueries([...planVariants(fq.question, "deep").slice(0, 2), facetQuery]);
    out.push(mk(fq.question, "template", `mode facet: ${heading}`, queries));
  }
  return out;
}

// Decompose a question into sub-questions for the deep-research fan-out. Pure
// and deterministic — no LLM, no network: an identifier drill first (when the
// question carries versions / status codes / DOIs), then the mode-template
// angles (real interrogative sub-questions, not the raw ask + a heading label),
// then distinctive-keyword facets as a floor for thin templates. Deduped and
// capped (DEEP_CAPS.maxSubQuestions, overridable). The agent can bypass the whole
// generator with its own `override` list (the CLI's --subquestions). When
// `runRoot` is given, each sub-question also carries a deterministic `out` dir
// (<runRoot>/q1…/qN) AND the plan is written to <runRoot>/PLAN.json so the
// orchestrator can dispatch one fan-out gather per sub-question without parsing
// stdout. `depth` (when given) is persisted with the plan, so an orchestrated
// fan-out gathers at the depth the run was planned at (standard runs stay
// standard; the deep tier passes `deep`).
export function runPlan(
  question: string,
  mode: ModeName,
  override?: string[],
  cap: number = DEEP_CAPS.maxSubQuestions,
  runRoot?: string,
  depth?: Depth,
): PlanResult {
  const q = question.trim();
  let subs: SubQuestion[];
  if (override?.length) {
    subs = override.map((s) => mk(s.trim(), "agent", "agent-supplied"));
  } else {
    subs = [];
    const idents = extractIdentifiers(q);
    if (idents.length) subs.push(mk(`${q} ${idents.join(" ")}`, "identifier", `identifiers: ${idents.join(", ")}`));
    subs.push(...templateFacets(q, getMode(mode).template));
    if (subs.length < 3) {
      for (const term of rankedKeywords(q).slice(0, 3 - subs.length)) {
        subs.push(mk(`${q} ${term}`, "keyword", `distinctive term: ${term}`));
      }
    }
  }

  // Dedupe case-insensitively by question text, drop blanks, cap, then assign
  // stable Q# ids by final position (parallel to the S# source scheme). A running
  // set of query strings dedupes ACROSS facets so Q3 doesn't re-issue Q1's query.
  const seen = new Set<string>();
  const usedQueries = new Set<string>();
  const uniq: SubQuestion[] = [];
  const limit = Math.max(1, Math.floor(cap));
  for (const s of subs) {
    const key = s.question.toLowerCase();
    if (!s.question || seen.has(key)) continue;
    seen.add(key);
    const q2 = s.queries.filter((v) => {
      const k = v.toLowerCase();
      if (usedQueries.has(k)) return false;
      usedQueries.add(k);
      return true;
    });
    s.queries = q2.length ? q2 : s.queries.slice(0, 1); // never leave a facet query-less
    uniq.push(s);
    if (uniq.length >= limit) break;
  }
  uniq.forEach((s, i) => {
    s.id = `Q${i + 1}`;
    if (runRoot) s.out = join(runRoot, s.id.toLowerCase());
  });
  const result: PlanResult = { question: q, mode, ...(depth ? { depth } : {}), subQuestions: uniq };
  if (runRoot) {
    mkdirSync(runRoot, { recursive: true });
    writeFileSync(join(runRoot, "PLAN.json"), JSON.stringify(result, null, 2));
  }
  return result;
}
