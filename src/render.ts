import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Manifest, Source, VerdictKind, VerifyResult } from "./types.js";
import { readDossier } from "./dossier.js";
import { slugify } from "./util.js";

// Verdict severity (worst wins) for the per-source citation badge.
const VERDICT_SEVERITY: Record<VerdictKind, number> = { supported: 0, partial: 1, unsupported: 2, refuted: 3 };

// Tiers rendered into the HTML, in order, plus the learn-mode glossary.
const TIERS: { id: string; label: string; file: string }[] = [
  { id: "summary", label: "Summary", file: "SUMMARY.md" },
  { id: "report", label: "Report", file: "REPORT.md" },
  { id: "full", label: "Full", file: "FULL.md" },
  { id: "glossary", label: "Glossary", file: "glossary.md" },
];

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

// Inline markdown → HTML on already-escaped text. Order matters: code spans
// first (so their content isn't re-formatted), then links, citations, hint
// markers, then emphasis. `[S#]` becomes an anchor into the Sources appendix
// (tinted by its semantic-verification verdict when one is known); `[M]`
// becomes an "unverified" badge.
function renderInline(escaped: string, verdicts?: Map<string, VerdictKind>): string {
  let s = escaped;
  s = s.replace(/`([^`]+)`/g, (_m, c) => `<code>${c}</code>`);
  s = s.replace(/\[([^\]]+)\]\((https?:[^)\s]+)\)/g, (_m, t, u) => `<a href="${u}" rel="noopener" target="_blank">${t}</a>`);
  s = s.replace(/\[(S\d+)\]/g, (_m, id) => {
    const v = verdicts?.get(id);
    const cls = v ? `cite v-${v}` : "cite";
    const title = v ? `source ${id} — ${v}` : `source ${id}`;
    return `<a class="${cls}" href="#src-${id}" title="${title}">[${id}]</a>`;
  });
  s = s.replace(/\[M\]/g, `<sup class="mhint" title="model hint — not from a fetched source">[M]</sup>`);
  s = s.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
  s = s.replace(/(^|[^*])\*([^*\n]+)\*/g, "$1<em>$2</em>");
  s = s.replace(/(^|[^\w])_([^_\n]+)_/g, "$1<em>$2</em>");
  return s;
}

export interface Heading {
  level: number;
  text: string;
  id: string;
}

// Render one markdown document to HTML, collecting its headings for the TOC.
// Deterministic and dependency-free; supports headings, paragraphs, lists,
// blockquotes (with model-hint callout styling), fenced code, tables and rules.
export function mdToHtml(
  md: string,
  idPrefix: string,
  opts: { verdicts?: Map<string, VerdictKind> } = {},
): { html: string; headings: Heading[] } {
  const lines = md.split("\n");
  const out: string[] = [];
  const headings: Heading[] = [];
  const usedIds = new Set<string>();
  const inline = (text: string): string => renderInline(text, opts.verdicts);
  let i = 0;

  const headingId = (text: string): string => {
    let base = `${idPrefix}-${slugify(text)}`;
    let id = base;
    let n = 2;
    while (usedIds.has(id)) id = `${base}-${n++}`;
    usedIds.add(id);
    return id;
  };

  while (i < lines.length) {
    const line = lines[i]!;

    // Fenced code block.
    const fence = /^\s*(```|~~~)(.*)$/.exec(line);
    if (fence) {
      const marker = fence[1]!;
      const body: string[] = [];
      i++;
      while (i < lines.length && !new RegExp(`^\\s*${marker}`).test(lines[i]!)) {
        body.push(lines[i]!);
        i++;
      }
      i++; // closing fence
      out.push(`<pre><code>${escapeHtml(body.join("\n"))}</code></pre>`);
      continue;
    }

    // Heading.
    const h = /^(#{1,6})\s+(.+?)\s*#*\s*$/.exec(line);
    if (h) {
      const level = h[1]!.length;
      const text = h[2]!;
      const id = headingId(text);
      headings.push({ level, text, id });
      out.push(`<h${level} id="${id}">${inline(escapeHtml(text))}</h${level}>`);
      i++;
      continue;
    }

    // Horizontal rule.
    if (/^([-*_])\1{2,}\s*$/.test(line)) {
      out.push("<hr>");
      i++;
      continue;
    }

    // Blockquote (group consecutive >). A model-hint region gets a callout.
    if (/^\s*>/.test(line)) {
      const quote: string[] = [];
      let isHint = false;
      while (i < lines.length && /^\s*>/.test(lines[i]!)) {
        let q = lines[i]!.replace(/^\s*>\s?/, "");
        if (/\[model-hint\]/i.test(q)) {
          isHint = true;
          q = q.replace(/\[model-hint\]\s*/i, "");
        }
        quote.push(q);
        i++;
      }
      const inner = inline(escapeHtml(quote.join(" ").trim()));
      if (isHint) {
        out.push(`<blockquote class="model-hint"><span class="mhint-badge">model hint · unverified</span> ${inner}</blockquote>`);
      } else {
        out.push(`<blockquote>${inner}</blockquote>`);
      }
      continue;
    }

    // Table: a header row of `|` cells followed by a separator row.
    if (/\|/.test(line) && i + 1 < lines.length && /^\s*\|?[\s:|-]+\|?\s*$/.test(lines[i + 1]!) && /-/.test(lines[i + 1]!)) {
      const rows: string[] = [];
      const header = splitRow(line);
      i += 2; // header + separator
      while (i < lines.length && /\|/.test(lines[i]!) && lines[i]!.trim() !== "") {
        rows.push(lines[i]!);
        i++;
      }
      const thead = `<thead><tr>${header.map((c) => `<th>${inline(escapeHtml(c))}</th>`).join("")}</tr></thead>`;
      const tbody = rows
        .map((r) => `<tr>${splitRow(r).map((c) => `<td>${inline(escapeHtml(c))}</td>`).join("")}</tr>`)
        .join("");
      out.push(`<table>${thead}<tbody>${tbody}</tbody></table>`);
      continue;
    }

    // List (group consecutive bullet / ordered items).
    if (/^\s*([-*+]|\d+\.)\s+/.test(line)) {
      const ordered = /^\s*\d+\.\s+/.test(line);
      const items: string[] = [];
      while (i < lines.length && /^\s*([-*+]|\d+\.)\s+/.test(lines[i]!)) {
        const item = lines[i]!.replace(/^\s*([-*+]|\d+\.)\s+/, "");
        items.push(`<li>${inline(escapeHtml(item))}</li>`);
        i++;
      }
      out.push(`<${ordered ? "ol" : "ul"}>${items.join("")}</${ordered ? "ol" : "ul"}>`);
      continue;
    }

    // Blank line.
    if (line.trim() === "") {
      i++;
      continue;
    }

    // Paragraph (group consecutive non-structural lines).
    const para: string[] = [];
    while (
      i < lines.length &&
      lines[i]!.trim() !== "" &&
      !/^(#{1,6})\s/.test(lines[i]!) &&
      !/^\s*>/.test(lines[i]!) &&
      !/^\s*([-*+]|\d+\.)\s+/.test(lines[i]!) &&
      !/^\s*(```|~~~)/.test(lines[i]!) &&
      !/^([-*_])\1{2,}\s*$/.test(lines[i]!)
    ) {
      para.push(lines[i]!);
      i++;
    }
    out.push(`<p>${inline(escapeHtml(para.join(" ")))}</p>`);
  }

  return { html: out.join("\n"), headings };
}

function splitRow(row: string): string[] {
  return row
    .trim()
    .replace(/^\|/, "")
    .replace(/\|$/, "")
    .split("|")
    .map((c) => c.trim());
}

const STYLE = `
:root{--fg:#1a1a1a;--muted:#666;--bg:#fafafa;--card:#fff;--accent:#2962a8;--line:#e3e3e3;--hint:#b8860b}
*{box-sizing:border-box}
body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;line-height:1.6;color:var(--fg);background:var(--bg);margin:0}
.wrap{max-width:1040px;margin:0 auto;padding:24px;display:grid;grid-template-columns:240px 1fr;gap:32px}
header{grid-column:1/-1;border-bottom:2px solid var(--accent);padding-bottom:12px}
header h1{margin:0 0 4px;font-size:1.6rem}
.meta{color:var(--muted);font-size:.86rem}
nav{position:sticky;top:16px;align-self:start;font-size:.9rem;max-height:90vh;overflow:auto}
nav a{display:block;color:var(--accent);text-decoration:none;padding:1px 0}
nav a:hover{text-decoration:underline}
nav .h3{padding-left:12px;font-size:.85rem;color:var(--muted)}
nav .tier{font-weight:600;margin-top:10px}
main{min-width:0}
section{background:var(--card);border:1px solid var(--line);border-radius:8px;padding:20px 24px;margin-bottom:24px}
section h1{font-size:1.3rem;border-bottom:1px solid var(--line);padding-bottom:6px}
h1,h2,h3,h4{line-height:1.3}
a{color:var(--accent)}
code{background:#f0f0f2;padding:1px 5px;border-radius:4px;font-size:.9em}
pre{background:#1e1e22;color:#eee;padding:14px;border-radius:6px;overflow:auto}
pre code{background:none;color:inherit;padding:0}
blockquote{border-left:4px solid var(--line);margin:1em 0;padding:.2em 1em;color:#333}
blockquote.model-hint{border-left-color:var(--hint);background:#fff8e6}
.mhint-badge{display:inline-block;background:var(--hint);color:#fff;font-size:.7rem;font-weight:600;padding:1px 6px;border-radius:4px;margin-right:6px;text-transform:uppercase;letter-spacing:.03em}
.cite{font-size:.82em;text-decoration:none;vertical-align:super}
.mhint{color:var(--hint);font-weight:600}
table{border-collapse:collapse;width:100%;margin:1em 0;font-size:.92rem}
th,td{border:1px solid var(--line);padding:6px 10px;text-align:left}
th{background:#f4f4f6}
.sources li{margin-bottom:10px}
.sources .s-meta,.subq .s-meta{color:var(--muted);font-size:.82rem}
.subq li{margin-bottom:10px}
.trust{display:inline-block;font-size:.72rem;padding:0 6px;border-radius:4px;background:#eef3fa;color:var(--accent)}
.callout{background:#fff8e6;border-left:4px solid var(--hint)}
.vbadge{display:inline-block;font-size:.72rem;font-weight:600;padding:0 6px;border-radius:4px;text-transform:uppercase;letter-spacing:.02em}
.v-supported{background:#e6f4ea;color:#1a7f37}
.v-partial{background:#fff4d6;color:#9a6700}
.v-unsupported{background:#f0f0f2;color:#555}
.v-refuted{background:#fbe9e7;color:#c1121f}
a.cite.v-supported{color:#1a7f37}
a.cite.v-partial{color:#9a6700}
a.cite.v-unsupported{color:#777}
a.cite.v-refuted{color:#c1121f;font-weight:700}
@media(max-width:760px){.wrap{grid-template-columns:1fr}nav{position:static;max-height:none}}
`;

// Read the resolved semantic-verification record, if one exists.
function readVerify(dir: string): VerifyResult | undefined {
  const p = join(dir, "VERIFY.json");
  if (!existsSync(p)) return undefined;
  try {
    return JSON.parse(readFileSync(p, "utf8")) as VerifyResult;
  } catch {
    return undefined;
  }
}

// The worst verdict observed for each source (refuted > unsupported > partial >
// supported), used to tint that source's citation anchors.
function worstBySource(verify?: VerifyResult): Map<string, VerdictKind> {
  const m = new Map<string, VerdictKind>();
  for (const v of verify?.verdicts ?? []) {
    if (!v.verdict) continue;
    const cur = m.get(v.sourceId);
    if (!cur || VERDICT_SEVERITY[v.verdict] > VERDICT_SEVERITY[cur]) m.set(v.sourceId, v.verdict);
  }
  return m;
}

// Build the self-contained index.html for a dossier directory.
export function renderHtml(dir: string): string {
  const { sources, manifest } = readDossier(dir);
  const present = TIERS.filter((t) => existsSync(join(dir, t.file)));
  const verify = readVerify(dir);
  const verdicts = worstBySource(verify);

  const rendered = present.map((t) => {
    const md = readFileSync(join(dir, t.file), "utf8");
    const { html, headings } = mdToHtml(md, t.id, { verdicts });
    return { ...t, html, headings };
  });

  // Hoist an "open questions / contradictions" heading into a top callout.
  let contradictionsId: string | undefined;
  for (const t of rendered) {
    const h = t.headings.find((x) => /open question|contradiction/i.test(x.text));
    if (h) {
      contradictionsId = h.id;
      break;
    }
  }

  const subs = manifest.subQuestions ?? [];

  // TOC: tier label + its h2 headings, then the deep-research sections.
  const toc: string[] = ['<nav><div class="tier"><a href="#top">↑ Top</a></div>'];
  for (const t of rendered) {
    toc.push(`<div class="tier"><a href="#tier-${t.id}">${t.label}</a></div>`);
    for (const h of t.headings.filter((x) => x.level === 2)) {
      toc.push(`<a class="h3" href="#${h.id}">${escapeHtml(h.text)}</a>`);
    }
  }
  if (verify) toc.push(`<div class="tier"><a href="#verification">Verification</a></div>`);
  if (subs.length) toc.push(`<div class="tier"><a href="#subquestions">Sub-questions (${subs.length})</a></div>`);
  toc.push(`<div class="tier"><a href="#sources">Sources (${sources.length})</a></div></nav>`);

  const main: string[] = ["<main>"];
  if (contradictionsId) {
    main.push(
      `<section class="callout"><strong>⚠ Open questions / contradictions</strong> — this report flags ` +
        `unresolved or conflicting findings. <a href="#${contradictionsId}">Jump to the section ↓</a></section>`,
    );
  }
  for (const t of rendered) {
    main.push(`<section id="tier-${t.id}"><h1>${t.label}</h1>${t.html}</section>`);
  }
  if (verify) main.push(verificationSection(verify));
  if (subs.length) main.push(subQuestionsSection(manifest, sources));
  main.push(sourcesSection(sources));
  main.push("</main>");

  const title = escapeHtml(manifest.question || "ultrasearch report");
  const metaLine = `${escapeHtml(manifest.mode)} · depth ${escapeHtml(manifest.depth)} · ${sources.length} sources · ${escapeHtml(manifest.builtAt)} · generated by ultrasearch`;

  return `<!DOCTYPE html>
<html lang="${escapeHtml((manifest.lang || "en").split("-")[0]!)}">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>${title} — ultrasearch</title>
<style>${STYLE}</style>
</head>
<body>
<a id="top"></a>
<div class="wrap">
<header><h1>${title}</h1><div class="meta">${metaLine}</div></header>
${toc.join("\n")}
${main.join("\n")}
</div>
</body>
</html>
`;
}

// Per-claim verdict table + headline status (deep-research semantic check).
function verificationSection(r: VerifyResult): string {
  const summary = `supported ${r.supported} · partial ${r.partial} · refuted ${r.refuted} · unsupported ${r.unsupported}`;
  const status = r.ok
    ? `<span class="vbadge v-supported">grounded</span>`
    : `<span class="vbadge v-refuted">${r.failures.length} claim(s) failed</span>`;
  const rows = (r.verdicts ?? [])
    .map(
      (v) =>
        `<tr><td>${escapeHtml(v.claimId)}</td>` +
        `<td><a href="#src-${v.sourceId}">[${escapeHtml(v.sourceId)}]</a></td>` +
        `<td><span class="vbadge v-${v.verdict}">${escapeHtml(v.verdict ?? "—")}</span></td>` +
        `<td>${escapeHtml(v.claim)}</td><td>${escapeHtml(v.note || "")}</td></tr>`,
    )
    .join("");
  const table = rows
    ? `<table><thead><tr><th>Claim</th><th>Source</th><th>Verdict</th><th>Statement</th><th>Note</th></tr></thead><tbody>${rows}</tbody></table>`
    : "";
  return `<section id="verification"><h1>Verification</h1><p>${status} — ${escapeHtml(summary)}</p>${table}</section>`;
}

// The decomposition tree: each sub-question and the sources its fan-out surfaced
// (from each source's merge provenance).
function subQuestionsSection(manifest: Manifest, sources: Source[]): string {
  const items = (manifest.subQuestions ?? [])
    .map((sq) => {
      const ids = sources
        .filter((s) => (s.meta?.provenance ?? []).some((p) => p.subQuestion === sq.question))
        .map((s) => `<a href="#src-${s.id}">[${s.id}]</a>`);
      const links = ids.length ? ids.join(" ") : `<span class="s-meta">(no sources)</span>`;
      return `<li><strong>${escapeHtml(sq.id)}</strong> ${escapeHtml(sq.question)}<br><span class="s-meta">${links}</span></li>`;
    })
    .join("");
  return `<section id="subquestions"><h1>Sub-questions</h1><ol class="subq">${items}</ol></section>`;
}

function sourcesSection(sources: Source[]): string {
  const items = sources
    .map((s) => {
      const meta = [
        s.backend,
        s.domain,
        `<span class="trust" title="trust score">trust ${s.trust}</span>`,
      ].join(" · ");
      return `<li id="src-${s.id}"><strong>[${s.id}]</strong> <a href="${escapeHtml(s.url)}" rel="noopener" target="_blank">${escapeHtml(s.title)}</a><br><span class="s-meta">${meta}</span></li>`;
    })
    .join("\n");
  return `<section id="sources"><h1>Sources</h1><ol class="sources">${items}</ol></section>`;
}

// Write index.html for a dossier; returns the output path.
export function writeHtml(dir: string, out?: string): string {
  const html = renderHtml(dir);
  const path = out ?? join(dir, "index.html");
  writeFileSync(path, html);
  return path;
}
