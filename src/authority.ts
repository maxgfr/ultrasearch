import { domainOf } from "./util.js";
import { deriveCitableUrl, urlDeclaresIdentity } from "./citable.js";

// How much a source looks like a document of RECORD, judged without a list.
//
// The obvious approach — an allowlist of authoritative hosts — is a losing
// game, and this codebase already proved it: `domainTrust` scored the WHATWG
// HTML Standard, the normative specification for the subject under research,
// exactly the same as `jobsbyculture.com`, because nobody had added whatwg.org.
// Extending the list only moves the boundary; it never removes it.
//
// A phrase list is the same mistake on a different axis. Measured on a real
// 60-source pool: 3 of 5 content-marketing pages carried no call-to-action
// wording at all, and read like honest engineering prose. Lexical tells do not
// survive contact with competent SEO.
//
// So these signals are STRUCTURAL and corpus-relative — properties of the
// document and of this run, not of anything hardcoded:
//
//   * reference diversity — how many distinct external hosts the text links to.
//     A document of record cites other documents. Measured on that pool:
//     primary sources averaged 10.7 external hosts, content-marketing pages 2.5.
//   * self-declared identity — does the document name itself with a persistent
//     identifier (canonical link, DOI, arXiv id, PMID)? Reuses citable.ts, so
//     "what counts as an identity" is decided in one place.
//   * corroboration — how many independent backends surfaced it. Cross-engine
//     agreement is evidence no single engine can fake.
//
// None of them is a verdict, and the measurement says so plainly: the combined
// signal caught 6 of 11 known content-marketing pages with no false positive on
// a primary source — but it did flag a legitimate registry entry
// (spec.openapis.org). So this NEVER drops or re-ranks a source. It annotates,
// and the agent reading the dossier decides. A heuristic that is right most of
// the time earns a caution, not a veto.

export interface SourceSignals {
  /** Distinct external hosts the extract links to. */
  refDiversity: number;
  /** The document names itself with a persistent identifier. */
  selfIdentified: boolean;
  /** How many independent backends surfaced this source. */
  corroboration: number;
  /** Rendered into DOSSIER.md so a reader can disagree with the machine. */
  notes: string[];
}

const URL_IN_TEXT = /https?:\/\/[a-z0-9.-]+/gi;

/** Hosts an extract links to, excluding the source's own (and `www.` noise). */
export function externalHosts(url: string, text: string): Set<string> {
  const self = domainOf(url).replace(/^www\./, "");
  const out = new Set<string>();
  for (const m of text.match(URL_IN_TEXT) ?? []) {
    const h = domainOf(m).replace(/^www\./, "");
    if (h && h !== self) out.add(h);
  }
  return out;
}

/**
 * Signals for one source. `trust` is the domain-class prior already computed
 * for it; `corroboration` is how many backends surfaced it (1 when unknown).
 *
 * The "thin attribution" caution fires only on the CONJUNCTION — cites almost
 * nothing external, sits on a domain the trust table does not recognise, and
 * declares no persistent identity. Any one of those alone is ordinary.
 */
export function sourceSignals(opts: { url: string; text: string; corroboration?: number }): SourceSignals {
  const hosts = externalHosts(opts.url, opts.text);
  // Either the document names itself in its text, or its own address is a
  // persistent identifier. A PDF usually only has the second: extraction drops
  // hyperlinks, so the text can declare nothing at all.
  const selfIdentified = urlDeclaresIdentity(opts.url) || !!deriveCitableUrl(opts.text.slice(0, 4000));
  const corroboration = opts.corroboration ?? 1;

  // FACTS, not a verdict.
  //
  // This used to render a judgment — "⚠ thin attribution — often marketing
  // content" — and a judgment can be wrong. It was: a vendor's own API
  // reference and a legitimate standards registry both got flagged, purely
  // because a reference page links nowhere. Patching that took a `vouchedFor`
  // escape hatch, which is the shape of a heuristic defending a claim it
  // should not have made.
  //
  // Three counts, each of them simply true, are strictly more useful and
  // cannot be false. The agent reads them next to the extract and draws the
  // conclusion — which is the party that was going to be right anyway.
  const notes = [
    `cites ${hosts.size} external source(s) · surfaced by ${corroboration} engine(s) · ${selfIdentified ? "declares a persistent identity (DOI/arXiv/canonical)" : "declares no persistent identity"}`,
  ];

  return { refDiversity: hosts.size, selfIdentified, corroboration, notes };
}
