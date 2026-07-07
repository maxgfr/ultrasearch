// Locale helpers for language/region-aware web search. Pure and deterministic
// (no network, no clock) so they unit-test trivially. The agent picks the search
// LANGUAGE (it translates the queries); these derive the per-engine knobs that
// bias each backend toward that locale: DuckDuckGo's `kl` region code, and the
// `Accept-Language` header every fetch sends.
//
// We default to the language as the primary signal (the agent translated for a
// market), and only split out a separate country when the language alone is
// ambiguous (English) or the caller passes an explicit --region.

// Language → default country. For most locales the country mirrors the language
// (de→de, fr→fr); the entries below are the cases where it does NOT, plus the
// English default. Anything unlisted falls back to the language code itself.
const LANG_COUNTRY: Record<string, string> = {
  en: "us",
  pt: "br",
  ja: "jp",
  zh: "cn",
  ko: "kr",
  sv: "se",
  da: "dk",
  cs: "cz",
  el: "gr",
  uk: "ua", // Ukrainian language → Ukraine
  ar: "xa", // DuckDuckGo's "Arabia" region
  he: "il",
  hi: "in",
};

// Region aliases for engines (DuckDuckGo) that expect a specific code.
const REGION_ALIASES: Record<string, string> = {
  gb: "uk",
  en: "us",
};

// Base language subtag, lowercased: "de-DE" → "de", "EN" → "en".
export function baseLang(lang: string | undefined): string {
  return (lang || "en").split("-")[0]!.toLowerCase();
}

// The country/region code to use, lowercased. Precedence: an explicit region,
// else a region subtag carried on the lang ("de-AT" → "at"), else the language's
// default country, else the language code itself.
export function resolveRegion(lang: string | undefined, region?: string): string {
  if (region?.trim()) return region.trim().toLowerCase();
  const parts = (lang || "en").split("-");
  if (parts.length > 1 && parts[1]) return parts[1]!.toLowerCase();
  const l = baseLang(lang);
  return LANG_COUNTRY[l] ?? l;
}

// DuckDuckGo's `kl` parameter: `{region}-{language}` (e.g. de-de, fr-fr, us-en,
// uk-en). For most non-English locales region == language; English splits by
// country. `wt-wt` is DDG's "no region", which we never emit (we always have a
// language) — callers can pass --region wt to opt out.
export function ddgRegion(lang: string | undefined, region?: string): string {
  const l = baseLang(lang);
  let r = resolveRegion(lang, region);
  r = REGION_ALIASES[r] ?? r;
  return `${r}-${l}`;
}

// An RFC-7231 Accept-Language header biased to the target language, with English
// as a low-priority fallback (so a page with no localized copy still returns
// something). e.g. "de-DE,de;q=0.9,en;q=0.5"; for English: "en-US,en;q=0.9".
export function acceptLanguageHeader(lang: string | undefined, region?: string): string {
  const l = baseLang(lang);
  const R = resolveRegion(lang, region).toUpperCase();
  if (l === "en") return `${l}-${R},${l};q=0.9`;
  return `${l}-${R},${l};q=0.9,en;q=0.5`;
}
