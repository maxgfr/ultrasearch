import { afterEach, describe, expect, it, vi } from "vitest";
import { existsSync, readFileSync, rmSync, mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { addSource } from "../src/enrich.js";
import { writeFixtureDossier } from "./dossierfix.js";
import { installFetchMock, routes } from "./fetchmock.js";
import type { Source } from "../src/types.js";

afterEach(() => vi.unstubAllGlobals());

function scratch(): string {
  return mkdtempSync(join(tmpdir(), "us-enrich-"));
}

describe("addSource", () => {
  it("allocates the next S# id, writes the extract and appends to sources.json", async () => {
    const dir = scratch();
    writeFixtureDossier(dir, 2);
    installFetchMock(routes([["new.test", { body: "<title>New</title><p>fresh content about limits</p>" }]]));
    const r = await addSource(dir, "https://new.test/page", { question: "rate limiting" });
    expect(r).toMatchObject({ id: "S3", added: true });
    expect(existsSync(join(dir, "sources/S3.md"))).toBe(true);

    const sources = JSON.parse(readFileSync(join(dir, "sources.json"), "utf8")) as Source[];
    expect(sources).toHaveLength(3);
    expect(sources[2]!.backend).toBe("claude");
    expect(sources[2]!.url).toBe("https://new.test/page");
    rmSync(dir, { recursive: true, force: true });
  });

  it("dedupes a url already present, returning the existing id", async () => {
    const dir = scratch();
    writeFixtureDossier(dir, 1);
    installFetchMock(routes([["dup.test", { body: "<p>x</p>" }]]));
    const first = await addSource(dir, "https://dup.test/a", {});
    expect(first.added).toBe(true);
    const again = await addSource(dir, "https://dup.test/a/", {}); // same canonical url
    expect(again.added).toBe(false);
    expect(again.id).toBe(first.id);
    const sources = JSON.parse(readFileSync(join(dir, "sources.json"), "utf8")) as Source[];
    expect(sources).toHaveLength(2); // S1 fixture + first add; no dup
    rmSync(dir, { recursive: true, force: true });
  });

  it("returns a note (no id) when the page can't be fetched", async () => {
    const dir = scratch();
    writeFixtureDossier(dir, 1);
    installFetchMock(() => ({ status: 500, body: "" }));
    const r = await addSource(dir, "https://gone.test/x", {});
    expect(r.added).toBe(false);
    expect(r.id).toBe("");
    expect(r.note).toBeTruthy();
    rmSync(dir, { recursive: true, force: true });
  });
});
