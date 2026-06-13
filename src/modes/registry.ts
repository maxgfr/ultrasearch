import type { ModeName, ModeProfile } from "../types.js";
import { topicMode } from "./topic.js";
import { bugMode } from "./bug.js";
import { researchMode } from "./research.js";
import { learnMode } from "./learn.js";
import { startupMode } from "./startup.js";

// Registry of the five report modes. Each is a backend-priority profile + a
// report template + extra outputs (bibtex / glossary / exercises).
export const MODES: Record<ModeName, ModeProfile> = {
  topic: topicMode,
  bug: bugMode,
  research: researchMode,
  learn: learnMode,
  startup: startupMode,
};

export function getMode(name: ModeName): ModeProfile {
  return MODES[name];
}

export function listModes(): ModeProfile[] {
  return Object.values(MODES);
}
