import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { BackendKind, GatherOptions, ModeName, RunContext } from "./types.js";
import { getMode } from "./modes/registry.js";
import { runBackends } from "./backends/registry.js";
import { fuse } from "./gather.js";
import { defaultRunDir } from "./gather.js";
import { keywords, foldTerm, domainOf, extractIdentifiers } from "./util.js";
import { facetQuestion, subjectOf } from "./plan.js";

// Default probe backends: one encyclopedic + one general-web, both keyless and
// fast. Overridable via --backends (and --backends fixture makes it offline).
const PROBE_BACKENDS: BackendKind[] = ["wikipedia", "duckduckgo"];
const PROBE_CAP = 10; // titles kept from the shallow probe
const INTERROGATIVE = /\?|^\s*(what|how|why|when|who|whom|which|whose|is|are|was|were|does|do|did|can|could|should|would|will)\b/i;

export interface BrainstormProbeResult {
  title: string;
  url: string;
  domain: string;
}
export interface BrainstormAngle {
  label: string;
  terms: string[];
  examples: { title: string; domain: string }[];
}
export interface BrainstormSignals {
  words: number;
  interrogative: boolean;
  identifiers: string[];
  clusters: number;
  ambiguous: boolean;
  reasons: string[];
}
export interface BrainstormResult {
  question: string;
  mode: ModeName;
  dir: string;
  probe: { backendsUsed: BackendKind[]; results: BrainstormProbeResult[]; notes: string[] };
  signals: BrainstormSignals;
  angles: BrainstormAngle[];
  candidateQuestions: { question: string; facet: string; rationale: string }[];
  userQuestions: string[];
}

// Distinctive folded tokens of a title (stopwords dropped, deduped), used both
// for clustering titles and for labelling the resulting angles.
function titleTokens(title: string): string[] {
  return [...new Set(keywords(title).map((k) => foldTerm(k)))].filter((t) => t.length >= 2);
}

function jaccard(a: Set<string>, b: Set<string>): number {
  if (!a.size || !b.size) return 0;
  let inter = 0;
  for (const x of a) if (b.has(x)) inter++;
  return inter / (a.size + b.size - inter);
}

// Greedily group probe titles into clusters by shared distinctive vocabulary
// (Jaccard ≥ 0.2 joins the first matching cluster). Distinct clusters with
// disjoint vocab signal a homonym / under-specified question.
function clusterTitles(results: BrainstormProbeResult[]): { titles: BrainstormProbeResult[]; tokens: Set<string> }[] {
  const clusters: { titles: BrainstormProbeResult[]; tokens: Set<string> }[] = [];
  for (const r of results) {
    const toks = new Set(titleTokens(r.title));
    if (!toks.size) continue;
    const hit = clusters.find((c) => jaccard(c.tokens, toks) >= 0.2);
    if (hit) {
      hit.titles.push(r);
      for (const t of toks) hit.tokens.add(t);
    } else {
      clusters.push({ titles: [r], tokens: new Set(toks) });
    }
  }
  return clusters;
}

// The 2-3 most frequent distinctive tokens across a cluster's titles → its label.
function angleLabel(cluster: { titles: BrainstormProbeResult[] }): { label: string; terms: string[] } {
  const freq = new Map<string, number>();
  for (const t of cluster.titles) for (const tok of titleTokens(t.title)) freq.set(tok, (freq.get(tok) ?? 0) + 1);
  const terms = [...freq.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, 3)
    .map(([t]) => t);
  return { label: terms.join(" ") || cluster.titles[0]!.title.slice(0, 40), terms };
}

// Detect whether a research question is too vague to run straight away, with a
// human-readable reason per triggered rule. Pure — the probe only informs the
// homonym signal (disjoint clusters).
function detectSignals(question: string, clusters: number): BrainstormSignals {
  const words = keywords(question).length;
  const interrogative = INTERROGATIVE.test(question.trim());
  const identifiers = extractIdentifiers(question);
  const reasons: string[] = [];
  if (words <= 3) reasons.push(`Only ${words} content word(s) — too broad to scope.`);
  if (!interrogative && words <= 5) reasons.push("Not phrased as a question and quite short — intent is unclear.");
  // The homonym signal only applies to a SHORT ask: a long, well-formed question
  // naturally pulls diverse titles from general web search, so probe spread must
  // not condemn it. Gate on a short, non-interrogative query.
  if (clusters >= 3 && words <= 4 && !interrogative) {
    reasons.push(`The probe spans ${clusters} unrelated topic clusters — the term may be ambiguous.`);
  }
  return { words, interrogative, identifiers, clusters, ambiguous: reasons.length > 0, reasons };
}

// Deterministic clarifying questions, 2-4, keyed by the signals. Scope first
// (when the probe found distinct angles), then audience/depth, timeframe, and a
// mode confirmation when the question gives no strong mode cue.
function buildUserQuestions(angles: BrainstormAngle[], signals: BrainstormSignals): string[] {
  const qs: string[] = [];
  if (angles.length >= 2) {
    qs.push(
      `Which of these do you mean: ${angles
        .slice(0, 3)
        .map((a) => a.label)
        .join(" · ")}? (or something else)`,
    );
  }
  qs.push("Who is this for, and how deep should it go — a quick overview or a thorough deep dive?");
  if (!signals.identifiers.some((id) => /^\d{4}$/.test(id))) {
    qs.push("Any timeframe or recency constraint — the current state, or the historical picture too?");
  }
  if (qs.length < 4) {
    qs.push("What angle fits best: a general briefing, debugging an error, a literature review, learning it, or market research?");
  }
  return qs.slice(0, 4);
}

// Candidate refined questions: the plain subject plus each angle label as a
// subject, run through the FIRST TWO researchable facets of the mode template
// (reusing plan's facetQuestion). Deduped, capped at 6.
function buildCandidateQuestions(question: string, mode: ModeName, angles: BrainstormAngle[]): { question: string; facet: string; rationale: string }[] {
  const headings = getMode(mode)
    .template.split("\n")
    .map((l) => /^##\s+(.+?)\s*$/.exec(l.trim())?.[1]?.trim())
    .filter((h): h is string => !!h && !/^(tl;?dr|abstract|executive summary|sources|references)/i.test(h))
    .slice(0, 2);
  const subjects = [subjectOf(question), ...angles.map((a) => a.label)];
  const out: { question: string; facet: string; rationale: string }[] = [];
  const seen = new Set<string>();
  for (const subject of subjects) {
    for (const heading of headings) {
      const fq = facetQuestion(subject, heading);
      const key = fq.question.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({ question: fq.question, facet: heading, rationale: `angle: ${subject}` });
      if (out.length >= 6) return out;
    }
  }
  return out;
}

// Run a SHALLOW keyless probe of a vague question and propose research angles +
// clarifying questions, so the agent can sharpen the ask before a full run. No
// page hydration — titles/snippets/domains only, so it is fast, polite, and
// fully offline under `--backends fixture`. Writes BRAINSTORM.json + .md.
export async function runBrainstorm(options: GatherOptions): Promise<BrainstormResult> {
  const mode = getMode(options.mode);
  const backends = options.backends?.length ? options.backends : PROBE_BACKENDS;
  const ctx: RunContext = { question: options.question, mode, options: { ...options, perSource: 5 }, variants: [options.question] };
  const backendResults = await runBackends(backends, ctx);
  const notes = backendResults.flatMap((r) => r.notes);
  const fused = fuse(backendResults.map((r) => r.items)).slice(0, PROBE_CAP);
  const results: BrainstormProbeResult[] = fused.map((s) => ({ title: s.title, url: s.url, domain: domainOf(s.url) }));

  const clusters = clusterTitles(results);
  const angles: BrainstormAngle[] = clusters
    .slice()
    .sort((a, b) => b.titles.length - a.titles.length)
    .slice(0, 4)
    .map((c) => {
      const { label, terms } = angleLabel(c);
      return { label, terms, examples: c.titles.slice(0, 2).map((t) => ({ title: t.title, domain: t.domain })) };
    });

  const signals = detectSignals(options.question, clusters.length);
  const candidateQuestions = buildCandidateQuestions(options.question, options.mode, angles);
  const userQuestions = buildUserQuestions(angles, signals);

  const dir = options.out ?? defaultRunDir("brainstorm", options.question);
  const result: BrainstormResult = {
    question: options.question,
    mode: options.mode,
    dir,
    probe: { backendsUsed: backends, results, notes },
    signals,
    angles,
    candidateQuestions,
    userQuestions,
  };
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "BRAINSTORM.json"), JSON.stringify(result, null, 2));
  writeFileSync(join(dir, "BRAINSTORM.md"), renderBrainstormMd(result));
  return result;
}

function renderBrainstormMd(r: BrainstormResult): string {
  const out: string[] = [];
  out.push(`# Brainstorm — ${r.question}`, "");
  out.push(
    r.signals.ambiguous
      ? `**This question looks under-specified.** ${r.signals.reasons.join(" ")}`
      : "**This question looks specific enough to research directly.**",
    "",
  );
  if (r.angles.length) {
    out.push("## Candidate angles", "");
    for (const a of r.angles) {
      const eg = a.examples.map((e) => `${e.title} (${e.domain})`).join("; ");
      out.push(`- **${a.label}**${eg ? ` — e.g. ${eg}` : ""}`);
    }
    out.push("");
  }
  if (r.candidateQuestions.length) {
    out.push("## Candidate refined questions", "");
    for (const c of r.candidateQuestions) out.push(`- ${c.question}  _(${c.facet})_`);
    out.push("");
  }
  out.push("## Questions to ask the user", "");
  for (const q of r.userQuestions) out.push(`- ${q}`);
  out.push("");
  return out.join("\n");
}
