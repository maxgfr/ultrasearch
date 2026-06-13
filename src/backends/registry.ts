import type { Backend, BackendKind, BackendResult, RunContext } from "../types.js";
import { searxngBackend } from "./searxng.js";
import { duckduckgoBackend } from "./duckduckgo.js";
import { wikipediaBackend } from "./wikipedia.js";
import { genericBackend } from "./generic.js";
import { fixtureBackend } from "./fixture.js";
import { stackexchangeBackend } from "./stackexchange.js";
import { hackernewsBackend } from "./hackernews.js";
import { githubBackend } from "./github.js";
import { arxivBackend } from "./arxiv.js";
import { crossrefBackend } from "./crossref.js";
import { openalexBackend } from "./openalex.js";
import { semanticscholarBackend } from "./semanticscholar.js";

// Registry of retrieval backends. Each is independent, returns candidate
// sources + honest notes, and never throws (the runner wraps failures into
// notes). "claude" is not a search backend — it's the provenance label for a
// source the agent ingested via `fetch`, so it has no handler here.
const HANDLERS: Partial<Record<BackendKind, Backend>> = {
  searxng: searxngBackend,
  duckduckgo: duckduckgoBackend,
  wikipedia: wikipediaBackend,
  generic: genericBackend,
  fixture: fixtureBackend,
  stackexchange: stackexchangeBackend,
  hackernews: hackernewsBackend,
  github: githubBackend,
  arxiv: arxivBackend,
  crossref: crossrefBackend,
  openalex: openalexBackend,
  semanticscholar: semanticscholarBackend,
};

export function hasBackend(kind: BackendKind): boolean {
  return kind in HANDLERS;
}

// Run the given backends concurrently. Discovery and content backends are all
// network-bound, so overlapping them cuts wall-clock. A backend that throws or
// is unknown becomes an empty result + a note — a single failing source never
// sinks the run.
export async function runBackends(kinds: BackendKind[], ctx: RunContext): Promise<BackendResult[]> {
  const tasks = kinds.map(async (kind): Promise<BackendResult> => {
    const handler = HANDLERS[kind];
    if (!handler) {
      return { backend: kind, items: [], notes: [`No handler for backend "${kind}".`], ms: 0 };
    }
    const t0 = Date.now();
    try {
      const res = await handler(ctx);
      return { ...res, ms: Date.now() - t0 };
    } catch (e) {
      return { backend: kind, items: [], notes: [`${kind} backend failed: ${(e as Error).message}`], ms: Date.now() - t0 };
    }
  });
  return Promise.all(tasks);
}
