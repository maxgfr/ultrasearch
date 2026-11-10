import type { ModeName, ModeProfile } from "../types.js";
import { topicMode } from "./topic.js";
import { bugMode } from "./bug.js";
import { researchMode } from "./research.js";
import { clinicalMode } from "./clinical.js";
import { learnMode } from "./learn.js";
import { startupMode } from "./startup.js";
import { dealsMode } from "./deals.js";

// Registry of the seven report modes. Each is a backend-priority profile + a
// report template + extra outputs (bibtex / glossary / exercises / codes).
export const MODES: Record<ModeName, ModeProfile> = {
  topic: topicMode,
  bug: bugMode,
  research: researchMode,
  clinical: clinicalMode,
  learn: learnMode,
  startup: startupMode,
  deals: dealsMode,
};

export function getMode(name: ModeName): ModeProfile {
  // An OWN key only. The name can come from a manifest on disk, and
  // `MODES["toString"]` is a function: its `.template` is undefined, which a
  // caller then prints. An unknown mode is an error, said as one.
  if (!Object.hasOwn(MODES, name)) throw new Error(`unknown mode "${name}"`);
  return MODES[name];
}

export function listModes(): ModeProfile[] {
  return Object.values(MODES);
}
