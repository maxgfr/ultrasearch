import type { GatherOptions, ModeProfile, RunContext } from "../src/types.js";

const DUMMY_MODE: ModeProfile = {
  name: "topic",
  description: "test",
  backends: [],
  deepOnly: [],
  template: "",
  extras: [],
};

// Build a minimal RunContext for backend tests.
export function makeCtx(question: string, options: Partial<GatherOptions> = {}): RunContext {
  const opts: GatherOptions = {
    question,
    mode: "topic",
    depth: "standard",
    maxSources: 25,
    perSource: 6,
    lang: "en",
    webEngine: "auto",
    excludeDomains: [],
    json: false,
    fresh: false,
    ...options,
  };
  return { question, mode: DUMMY_MODE, options: opts };
}
