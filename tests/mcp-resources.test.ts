import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterAll, describe, it, expect } from "vitest";
import { listResources, readResource, resolveSkillRoot, ResourceError, skillName } from "../src/engine.js";

const REPO_ROOT = resolve(__dirname, "..");
const PAYLOAD = join(REPO_ROOT, "skills", skillName());

const temps: string[] = [];
function tmp(): string {
  const d = mkdtempSync(join(tmpdir(), "ultrasearch-res-"));
  temps.push(d);
  return d;
}
afterAll(() => {
  for (const d of temps) rmSync(d, { recursive: true, force: true });
});

describe("skill root resolution", () => {
  // The three layouts this same code runs from. Each is a real directory shape,
  // not a mock: the failure this guards against is a bundle that finds its
  // documentation in the repo and not once installed.
  it("finds the payload from an installed skill (<payload>/scripts/x.mjs)", () => {
    const root = tmp();
    mkdirSync(join(root, "scripts"), { recursive: true });
    writeFileSync(join(root, "SKILL.md"), "# skill\n\nBody.\n");
    expect(resolveSkillRoot(join(root, "scripts"))).toBe(root);
  });

  it("finds the payload from a repo-root bundle (<repo>/scripts/x.mjs)", () => {
    const repo = tmp();
    const payload = join(repo, "skills", skillName());
    mkdirSync(join(repo, "scripts"), { recursive: true });
    mkdirSync(payload, { recursive: true });
    writeFileSync(join(payload, "SKILL.md"), "# skill\n\nBody.\n");
    expect(resolveSkillRoot(join(repo, "scripts"))).toBe(payload);
  });

  it("finds the payload from the source tree (<repo>/src/mcp/)", () => {
    // No override: this is the real module resolving the real payload, which is
    // what the test suite itself runs as.
    expect(resolveSkillRoot()).toBe(PAYLOAD);
  });

  it("returns undefined rather than throwing when there is no payload", () => {
    expect(resolveSkillRoot(join(tmp(), "scripts"))).toBeUndefined();
  });
});

describe("resources/list", () => {
  it("serves SKILL.md plus every reference the skill actually ships", () => {
    const uris = listResources().map((r) => r.uri);
    expect(uris[0]).toBe("skill://SKILL.md");
    expect(uris).toContain("skill://references/citation-format.md");
    // Sorted and unique, so a client's list is stable across calls.
    expect(new Set(uris).size).toBe(uris.length);
    expect(uris.slice(1)).toEqual([...uris.slice(1)].sort());
  });

  it("describes each resource with prose from the file, not its title repeated", () => {
    for (const r of listResources()) {
      expect(r.mimeType, r.uri).toBe("text/markdown");
      expect(r.title, r.uri).toBeTruthy();
      expect(r.description, r.uri).toBeTruthy();
      expect(r.description!.startsWith("#"), r.uri).toBe(false);
      expect(r.description!.length, r.uri).toBeLessThanOrEqual(300);
    }
  });

  it("is empty, not fatal, when the payload is missing", () => {
    // A skill installed without its documentation must still serve its tools.
    expect(listResources(join(tmp(), "scripts"))).toEqual([]);
  });
});

describe("resources/read", () => {
  it("returns the real file off disk", () => {
    const got = readResource("skill://SKILL.md");
    expect(got.mimeType).toBe("text/markdown");
    expect(got.text).toContain("ultrasearch");
    expect(got.text.length).toBeGreaterThan(1000);
  });

  it("reads a reference by its listed uri", () => {
    for (const decl of listResources()) {
      expect(readResource(decl.uri).text.length, decl.uri).toBeGreaterThan(0);
    }
  });

  it("rejects an unknown scheme", () => {
    expect(() => readResource("file:///etc/passwd")).toThrow(ResourceError);
  });

  it("rejects traversal out of the skill root", () => {
    // Refused on the path alone, before the disk is read: only SKILL.md and
    // references/*.md are served.
    expect(() => readResource("skill://../../package.json")).toThrow(/not a resource this server serves/);
  });

  it("serves only SKILL.md and references/*.md", () => {
    expect(() => readResource("skill://scripts/ultrasearch.mjs")).toThrow(/not a resource this server serves/);
    expect(() => readResource("skill://references/nested/x.md")).toThrow(/not a resource this server serves/);
  });

  it("rejects a symlink that points out of the skill root", () => {
    // Normalising the path string is not enough: this one only escapes once
    // the filesystem resolves it, which is why containment is checked on the
    // realpath. Relevant because this server can be reached over HTTP.
    const root = tmp();
    mkdirSync(join(root, "scripts"), { recursive: true });
    writeFileSync(join(root, "SKILL.md"), "# skill\n\nBody.\n");
    const secret = join(tmp(), "secret.md");
    writeFileSync(secret, "top secret");
    // Under references/, a path the server does serve, so the refusal can only
    // come from the realpath containment check.
    mkdirSync(join(root, "references"), { recursive: true });
    symlinkSync(secret, join(root, "references", "escape.md"));

    expect(() => readResource("skill://references/escape.md", join(root, "scripts"))).toThrow(/escapes the skill root/);
  });

  it("rejects a directory and a file that is not there", () => {
    expect(() => readResource("skill://references")).toThrow(/not a resource this server serves/);
    expect(() => readResource("skill://references/nope.md")).toThrow(/no such resource/);
    // A directory whose name passes the path check is still not read.
    const root = tmp();
    mkdirSync(join(root, "scripts"), { recursive: true });
    writeFileSync(join(root, "SKILL.md"), "# skill\n\nBody.\n");
    mkdirSync(join(root, "references", "dir.md"), { recursive: true });
    expect(() => readResource("skill://references/dir.md", join(root, "scripts"))).toThrow(/not a file/);
  });

  it("explains itself when there is no payload at all", () => {
    expect(() => readResource("skill://SKILL.md", join(tmp(), "scripts"))).toThrow(/no skill payload/);
  });
});
