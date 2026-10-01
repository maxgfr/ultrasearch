import type { ModeName, ModeProfile } from "../types.js";
import { topicMode } from "./topic.js";
import { bugMode } from "./bug.js";
import { researchMode } from "./research.js";
import { learnMode } from "./learn.js";
import { startupMode } from "./startup.js";
import { dealsMode } from "./deals.js";

// Registry of the six report modes. Each is a backend-priority profile + a
// report template + extra outputs (bibtex / glossary / exercises / codes).
export const MODES: Record<ModeName, ModeProfile> = {
  topic: topicMode,
  bug: bugMode,
  research: researchMode,
  learn: learnMode,
  startup: startupMode,
  deals: dealsMode,
};

export function getMode(name: ModeName): ModeProfile {
  return MODES[name];
}

export function listModes(): ModeProfile[] {
  return Object.values(MODES);
}
