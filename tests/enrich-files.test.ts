import { describe, it, expect, beforeEach } from "vitest";
import { mkdtempSync, writeFileSync, readFileSync, cpSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { addFiles } from "../src/enrich.js";
import { readDossier } from "../src/dossier.js";
import { writeFixtureDossier } from "./dossierfix.js";

let dir: string;
let scratch: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "us-files-"));
  scratch = mkdtempSync(join(tmpdir(), "us-src-"));
  writeFixtureDossier(dir, 1);
});

function file(name: string, body: string): string {
  const p = join(scratch, name);
  writeFileSync(p, body);
  return p;
}

describe("addFiles", () => {
  it("adds a plain-text document as a citable source", async () => {
    const p = file("notes.md", "# Rate limiting\n\nToken buckets smooth bursts without dropping traffic.\n");
    const r = await addFiles(dir, [p], { question: "rate limiting" });

    expect(r.added).toBe(1);
    const { sources } = readDossier(dir);
    const s = sources.at(-1)!;
    expect(s.id).toBe("S2"); // shares the S<n> scheme the grounding contract rests on
    expect(s.backend).toBe("file");
    expect(s.url.startsWith("file://")).toBe(true);
    expect(readFileSync(join(dir, s.extract), "utf8")).toContain("Token buckets");
  });

  // domainOf() has no hostname to return for a file: URL. Empty would read as
  // "unknown" in a source list; naming the route tells a reader at a glance that
  // this evidence came off the machine rather than the web.
  it("files a local document under a domain that says it is local", async () => {
    const r = await addFiles(dir, [file("a.txt", "some local prose about caching")], {});
    expect(r.added).toBe(1);
    expect(readDossier(dir).sources.at(-1)!.domain).toBe("local file");
  });

  it("converts an office document through the ladder", async () => {
    const p = join(scratch, "report.docx");
    cpSync(join(__dirname, "fixtures", "docs", "sample.docx"), p);
    const r = await addFiles(dir, [p], {});
    // The suite pins ULTRASEARCH_DOC_ENGINE=none, so nothing can convert it —
    // and the point is that it REFUSES rather than storing the ZIP as text.
    expect(r.added).toBe(0);
    expect(r.results[0]!.note).toMatch(/could not extract text/i);
    expect(readDossier(dir).sources).toHaveLength(1);
  });

  // A local PDF goes through the PDF ladder, not the document one. The suite
  // pins that ladder to the built-in reader, which is exactly what an offline
  // machine with no tools gets — so this covers the real fallback path.
  it("reads a local PDF through the PDF ladder", async () => {
    const p = join(scratch, "paper.pdf");
    writeFileSync(p, "%PDF-1.4\nstream\nBT (LocalPdfBodyText) Tj ET\nendstream\n");
    const r = await addFiles(dir, [p], {});
    expect(r.added).toBe(1);
    const s = readDossier(dir).sources.at(-1)!;
    expect(readFileSync(join(dir, s.extract), "utf8")).toContain("LocalPdfBodyText");
  });

  it("refuses a local PDF with no readable text rather than adding an empty source", async () => {
    const p = join(scratch, "scan.pdf");
    writeFileSync(p, "%PDF-1.4 no text operators here");
    const r = await addFiles(dir, [p], {});
    expect(r.added).toBe(0);
    expect(r.results[0]!.note).toMatch(/could not extract text/i);
  });

  it("refuses a file type it cannot read instead of decoding it hopefully", async () => {
    const r = await addFiles(dir, [file("logo.png", "\x89PNG\r\n\x1a\n binary")], {});
    expect(r.added).toBe(0);
    expect(r.results[0]!.note).toMatch(/unsupported file type/);
  });

  it("reports a missing path rather than throwing", async () => {
    const r = await addFiles(dir, [join(scratch, "nope.md")], {});
    expect(r.added).toBe(0);
    expect(r.skipped).toBe(1);
    expect(r.results[0]!.note).toMatch(/not a readable file/);
  });

  it("refuses an empty file", async () => {
    const r = await addFiles(dir, [file("empty.txt", "   ")], {});
    expect(r.added).toBe(0);
    expect(r.results[0]!.note).toMatch(/is empty/);
  });

  it("does not add the same file twice", async () => {
    const p = file("dup.md", "content worth citing exactly once");
    expect((await addFiles(dir, [p], {})).added).toBe(1);
    const again = await addFiles(dir, [p], {});
    expect(again.added).toBe(0);
    expect(again.results[0]!.note).toMatch(/already in dossier as S2/);
  });

  // The batch contract addSources set: every input gets an outcome, refusals
  // included. An ingest that quietly dropped half its input would be worse than
  // one that failed outright.
  it("returns one outcome per input, and keeps allocating ids across a batch", async () => {
    const r = await addFiles(dir, [file("a.md", "first document about queues"), join(scratch, "gone.md"), file("b.md", "second document about locks")], {});
    expect(r.results).toHaveLength(3);
    expect(r.added).toBe(2);
    expect(r.skipped).toBe(1);
    expect(readDossier(dir).sources.map((s) => s.id)).toEqual(["S1", "S2", "S3"]);
  });

  it("strips chrome from a local HTML file rather than storing its markup", async () => {
    const body = `<p>${"real prose about token buckets and leaky buckets. ".repeat(20)}</p>`;
    const p = file("page.html", `<title>Doc</title><body><nav>menu</nav><main>${body}</main><footer>copyright junk</footer></body>`);
    await addFiles(dir, [p], {});
    const s = readDossier(dir).sources.at(-1)!;
    const text = readFileSync(join(dir, s.extract), "utf8");
    expect(text).toContain("token buckets");
    expect(text).not.toContain("<nav>");
    expect(text).not.toContain("copyright junk");
  });
});
