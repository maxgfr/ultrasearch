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
export function sourceSignals(opts: { url: string; text: string; corroboration?: number; vouchedFor?: boolean }): SourceSignals {
  const hosts = externalHosts(opts.url, opts.text);
  // Either the document names itself in its text, or its own address is a
  // persistent identifier. A PDF usually only has the second: extraction drops
  // hyperlinks, so the text can declare nothing at all.
  const selfIdentified = urlDeclaresIdentity(opts.url) || !!deriveCitableUrl(opts.text.slice(0, 4000));
  const corroboration = opts.corroboration ?? 1;
  const notes: string[] = [];

  // Purely structural, and purely a conjunction: a page that nobody vouched
  // for, that cites almost nothing, that no other engine independently found,
  // and that declares no identity of its own. Any ONE of those absent makes it
  // completely ordinary.
  //
  // `vouchedFor` is what stops the caution from being noise. A page the AGENT
  // picked out of its own WebSearch, or one a scholarly API handed over, has
  // already been vouched for by someone who knows more than this heuristic
  // does — warning the agent about a URL it chose itself is backwards. It was:
  // `developers.openai.com/api/reference/…` is a vendor's own API reference,
  // and it was flagged purely because a reference page links nowhere.
  //
  // This used to also require "on a domain with no known authority", which
  // depended on the hostname table that has since been deleted. Dropping that
  // clause is what makes the signal list-free.
  if (!opts.vouchedFor && hosts.size <= 1 && corroboration <= 1 && !selfIdentified) {
    notes.push(
      `⚠ thin attribution — cites ${hosts.size === 0 ? "no" : "one"} external source, no other engine surfaced it, and it declares no DOI/canonical identity of its own. ` +
        `That combination often means marketing content rather than a source of record — but it is a hint, not a verdict. Read it and judge.`,
    );
  }
  if (corroboration >= 3) notes.push(`✓ corroborated — ${corroboration} independent engines surfaced this page.`);
  if (selfIdentified && hosts.size >= 5) notes.push(`✓ document of record — declares a persistent identity and cites ${hosts.size} external sources.`);

  return { refDiversity: hosts.size, selfIdentified, corroboration, notes };
}
