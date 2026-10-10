import type { Manifest, TemplateName } from "./types.js";
import { getMode } from "./modes/registry.js";
import { readDossier, writeDossierIndex } from "./dossier.js";

// Report templates that belong to no retrieval mode. A template is guidance,
// not a contract: `check` asks only that REPORT.md carries an "Open questions"
// section (the one heading every template shares); the other headings are the
// author's to rename, merge or drop.
export const EXTRA_TEMPLATES: Record<Exclude<TemplateName, Manifest["mode"]>, { description: string; template: string }> = {
  verification: {
    description: "A reference or claim check: verdict, one row per reference, the discrepancies, what could not be verified.",
    template: [
      "## Verdict",
      "## Reference-by-reference table",
      "One row per reference: # · resolved as · authors · title · journal · year · vol · issue · pages · DOI · source.",
      "A block quoting the checked document's own (wrong) figures goes under `<!-- ultrasearch:no-numerals -->`, so `check` does not ask a source for them.",
      "## Discrepancies",
      "## Claims checked against their sources",
      "## Not verifiable",
      "## Open questions",
      "## Sources",
    ].join("\n"),
  },
};

/** The template text a dossier asks for: its own `template`, else its mode's. */
export function templateFor(manifest: Pick<Manifest, "mode" | "template">): string {
  const t = manifest.template;
  if (t && t in EXTRA_TEMPLATES) return EXTRA_TEMPLATES[t as keyof typeof EXTRA_TEMPLATES].template;
  return getMode(t && t !== manifest.mode ? (t as Manifest["mode"]) : manifest.mode).template;
}

/** Switch an existing dossier to another report template and rewrite its brief (DOSSIER.md). */
export function setDossierTemplate(dir: string, name: TemplateName): Manifest {
  const { sources, manifest } = readDossier(dir);
  const next: Manifest = { ...manifest, template: name };
  writeDossierIndex(dir, sources, next, templateFor(next));
  return next;
}

/** True when a REPORT has an "Open questions" section (English or French; "contradictions" counts). */
export function hasOpenQuestions(markdown: string): boolean {
  return /^\s{0,3}#{1,6}\s+.*\b(open questions?|questions? ouvertes?|contradictions?)\b/im.test(markdown);
}
