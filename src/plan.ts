import { join } from "node:path";
import type { ModeName, PlanResult, SubQuestion } from "./types.js";
import { DEEP_CAPS } from "./types.js";
import { getMode } from "./modes/registry.js";
import { rankedKeywords, extractIdentifiers, planVariants } from "./util.js";

// Mode-template headings that are summary or structure, not independent research
// angles — skipped when deriving sub-questions (the deep loop synthesises these
// from the others, it doesn't research them).
const SKIP_HEADING = /^(tl;?dr|abstract\b|executive summary|sources\b|references\b|further reading|solutions\b)/i;

function mk(question: string, facet: SubQuestion["facet"], rationale: string): SubQuestion {
  return { id: "", question, facet, queries: planVariants(question, "deep"), rationale };
}

// Distinct researchable angles from the mode's report template: each "## …"
// heading (minus the summary/structure ones) becomes a "<question> — <heading>"
// sub-question, so the decomposition is mode-aware for free.
function templateFacets(question: string, template: string): SubQuestion[] {
  const out: SubQuestion[] = [];
  for (const line of template.split("\n")) {
    const m = /^##\s+(.+?)\s*$/.exec(line.trim());
    if (!m) continue;
    const heading = m[1]!.trim();
    if (SKIP_HEADING.test(heading)) continue;
    out.push(mk(`${question} — ${heading}`, "template", `mode facet: ${heading}`));
  }
  return out;
}

// Decompose a question into sub-questions for the deep-research fan-out. Pure
// and deterministic — no LLM, no network: an identifier drill first (when the
// question carries versions / status codes / DOIs), then the mode-template
// angles, then distinctive-keyword facets as a floor for thin templates. Deduped
// and capped (DEEP_CAPS.maxSubQuestions, overridable). The agent can bypass the
// whole generator with its own `override` list (the CLI's --subquestions).
// When `runRoot` is given, each sub-question also carries a deterministic `out`
// dir (<runRoot>/q1…/qN) so the orchestrator can dispatch one fan-out gather per
// sub-question without parsing stdout.
export function runPlan(question: string, mode: ModeName, override?: string[], cap: number = DEEP_CAPS.maxSubQuestions, runRoot?: string): PlanResult {
  const q = question.trim();
  let subs: SubQuestion[];
  if (override && override.length) {
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
  // stable Q# ids by final position (parallel to the S# source scheme).
  const seen = new Set<string>();
  const uniq: SubQuestion[] = [];
  const limit = Math.max(1, Math.floor(cap));
  for (const s of subs) {
    const key = s.question.toLowerCase();
    if (!s.question || seen.has(key)) continue;
    seen.add(key);
    uniq.push(s);
    if (uniq.length >= limit) break;
  }
  uniq.forEach((s, i) => {
    s.id = `Q${i + 1}`;
    if (runRoot) s.out = join(runRoot, s.id.toLowerCase());
  });
  return { question: q, mode, subQuestions: uniq };
}
