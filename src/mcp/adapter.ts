import { VERSION } from "../types.js";
import type { McpAdapter } from "../engine.js";
import { callTool } from "./handlers.js";
import { getPrompt, PROMPTS } from "./prompts.js";
import { toolsFor } from "./tools.js";

// The skill half of the MCP server.
//
// The engine owns everything protocol-shaped — version negotiation, the
// notification/request split, cancellation, schema validation, response
// capping, the JSON-RPC-error vs isError-result line, and both transports. It
// cannot know WHICH tools exist, so this file hands it the four things that are
// genuinely ultrasearch's: the version it reports, the tool declarations, the
// dispatcher, and the prompts.
//
// Before this, all five transport files lived here in a copy 97–100% identical
// to construct's and ultradoc's — 929 lines each, and stdio/http/resources were
// byte-for-byte the same across all three.

/**
 * How to ask for less, per tool, when a response is withheld for size.
 *
 * The engine detects the overflow; only the skill knows which argument shrinks
 * the result. A cap that says only "too big" makes the model retry the same
 * call — one that names the narrowing argument gets a smaller second call.
 */
const CAP_ADVICE: Record<string, string> = {
  ultrasearch_gather: 'lower `max_sources` or `per_source`, or drop to `depth: "summary"`',
  ultrasearch_search: "lower `max_sources`",
  ultrasearch_merge: "merge fewer `runs`, or read the merged DOSSIER.md instead of inlining it",
  ultrasearch_verify: "lower `max_verify`, or split the worklist with `shards`/`shard`",
  ultrasearch_check: "the report is very large; check it in pieces",
  ultrasearch_read: "pass `start_line`/`end_line` to read a window instead of the whole file",
};

export interface AdapterOptions {
  /** `--run` default, folded into every tool that takes one. */
  defaultRun?: string;
  /** Whether the tools whose product is a file on disk are offered at all. */
  allowWrite?: boolean;
}

export function ultrasearchAdapter(opts: AdapterOptions = {}): McpAdapter {
  return {
    version: VERSION,
    listTools: (protocol) => toolsFor(protocol, opts),
    callTool: (name, args) => callTool(name, args, opts),
    capAdvice: CAP_ADVICE,
    prompts: PROMPTS,
    getPrompt,
  };
}
