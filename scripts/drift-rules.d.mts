// Type declarations for the shared drift-gate patterns (scripts/drift-rules.mjs),
// so tests/*.ts can import the module under `tsc --noEmit` even though scripts/
// is excluded from the compilation roots.
export function docFlagRegex(): RegExp;
export function helpCoversFlag(help: string, flag: string): boolean;
export function webEngineEnum(line: string): string[] | null;
