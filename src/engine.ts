// The vendored webindex engine, configured for this skill.
//
// Everything in src/ reaches the engine through THIS module, never through
// src/vendor/webindex-engine.mjs directly. That is the whole point: you cannot
// obtain an engine function without first importing the module that configures
// it, so there is no ordering hazard to remember and no entry point that can
// forget — a new CLI command, a new MCP handler and a test all get a configured
// engine for free.
//
// The alternative — a side-effect import at each entry point — is exactly the
// fragile shape the extraction removed from fetch.ts, where tests carried
// "must be imported FIRST" comments. Not worth reintroducing one layer up.
//
// What configure() buys: the engine reads `${envPrefix}_*` at call time, so
// ULTRASEARCH_SEARXNG, ULTRASEARCH_FIRECRAWL, ULTRASEARCH_PDF_ENGINE and the
// rest keep working exactly as they did before the extraction. `cli` names this
// tool inside engine-emitted notes, and `contactUrl` goes into the polite
// User-Agent arXiv and Crossref see — which must identify ultrasearch, not the
// shared engine underneath.
import { configure } from "./vendor/webindex-engine.mjs";

configure({
  name: "ultrasearch",
  envPrefix: "ULTRASEARCH",
  cli: "ultrasearch",
  contactUrl: "https://github.com/maxgfr/ultrasearch",
});

export * from "./vendor/webindex-engine.mjs";
