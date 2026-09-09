// Keep the engine's endpoint/identity rules, with one local documentation fix:
// /api/*.html can be a human-readable reference page, as on nodejs.org.
import { isApiEndpoint as engineIsApiEndpoint, isCitableUrl as engineIsCitableUrl, deriveCitableUrl as engineDeriveCitableUrl } from "./engine.js";
export { addressedIdCount, urlDeclaresIdentity } from "./engine.js";

function isHtmlReference(url: string): boolean {
  try {
    const candidate = new URL(url);
    if (!/^\/api\/.*\.html?$/i.test(candidate.pathname)) return false;
    // Remove only the ambiguous path signal. Machine hosts, format=json and
    // non-HTTP schemes still have to pass the unchanged engine rules.
    candidate.pathname = candidate.pathname.replace(/^\/api\//i, "/documentation/");
    return engineIsCitableUrl(candidate.href);
  } catch {
    return false;
  }
}

export function isApiEndpoint(url: string): boolean {
  return engineIsApiEndpoint(url) && !isHtmlReference(url);
}

export function isCitableUrl(url: string): boolean {
  return engineIsCitableUrl(url) || isHtmlReference(url);
}

export function deriveCitableUrl(text: string, canonical?: string): string | undefined {
  return canonical && isHtmlReference(canonical) ? canonical : engineDeriveCitableUrl(text, canonical);
}
