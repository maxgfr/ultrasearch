import type { Depth, ModeName } from "./types.js";
import { getMode } from "./modes/registry.js";
import { planVariants } from "./util.js";

// The WebSearch worklist.
//
// The engine cannot run the agent's WebSearch tool for it — that tool lives in
// the harness, not in this process. What it CAN do is stop the agent from
// firing one query and calling it a sweep. One query against a great index
// still only sees one slice of it; the recall win comes from asking several
// genuinely different questions and pooling the answers.
//
// So this command hands over a worklist: how many distinct queries to run for
// the depth, the mechanical variants as a starting point, and the mode's own
// angles — the ones a good researcher would think to cover for a bug, a paper
// or a market. The agent writes the actual query text; it is far better at that
// than a regex planner, which is exactly why the planner's own output is
// offered as seed material rather than as the answer.

export interface QueryPlan {
  question: string;
  mode: ModeName;
  depth: Depth;
  lang: string;
  /** How many DISTINCT WebSearch queries to run before pooling the hits. */
  target: number;
  /** Deterministic starting points from the built-in planner. */
  planned: string[];
  /** The mode's distinct angles — one query each, in the search language. */
  angles: string[];
  next: string;
}

// How wide the agent's own sweep should be, by depth. Deliberately WIDER than
// the engine's internal planner (1/2/3): those variants feed scrapers that
// rate-limit, while these feed the harness's own search tool, where breadth is
// cheap and is the whole point.
const TARGET_PER_DEPTH: Record<Depth, number> = { summary: 2, standard: 4, deep: 8 };

export function planQueries(opts: { question: string; mode: ModeName; depth: Depth; lang?: string }): QueryPlan {
  const lang = opts.lang ?? "en";
  const mode = getMode(opts.mode);
  const target = TARGET_PER_DEPTH[opts.depth];
  return {
    question: opts.question,
    mode: opts.mode,
    depth: opts.depth,
    lang,
    target,
    planned: planVariants(opts.question, opts.depth),
    angles: mode.searchAngles.slice(0, target),
    next: `Run your own WebSearch once per angle, pool EVERY hit into one JSON array, then: ultrasearch gather --q "${opts.question}" --mode ${opts.mode} --depth ${opts.depth} --web-results <hits.json>`,
  };
}

export function formatQueryPlan(plan: QueryPlan): string {
  const lines = [
    `ultrasearch: WebSearch worklist for "${plan.question}"`,
    `  mode: ${plan.mode} · depth: ${plan.depth} · search language: ${plan.lang}`,
    ``,
    // Say the budget AND what it covers. Announcing "run 8" over a list of 6
    // is the kind of small dishonesty that teaches an agent to stop reading.
    plan.angles.length >= plan.target
      ? `Run ${plan.target} DISTINCT WebSearch queries — one per angle, phrased in ${plan.lang}:`
      : `Run ${plan.target} DISTINCT WebSearch queries, phrased in ${plan.lang} — these ${plan.angles.length} angles, then ${plan.target - plan.angles.length} of your own:`,
    ...plan.angles.map((a, i) => `  ${i + 1}. ${a}`),
    ``,
    `Starting points from the built-in planner (yours will be better):`,
    ...plan.planned.map((q) => `  · ${q}`),
    ``,
    `Then pool every hit into one JSON array — [{"url":…,"title":…,"snippet":…}, …] — and:`,
    `  ultrasearch gather --q "${plan.question}" --mode ${plan.mode} --depth ${plan.depth} --web-results <hits.json>`,
  ];
  return lines.join("\n") + "\n";
}
