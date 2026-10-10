import { execFile } from "node:child_process";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { fileSearchSchema, searchRepository } from "./file-search.js";

const exec = promisify(execFile);
let root: string;
beforeAll(async () => {
  root = await realpath(await mkdtemp(path.join(tmpdir(), "file-search-")));
  await exec("git", ["init", "-q", root]);
  await mkdir(path.join(root, "src/deep"), { recursive: true });
  await writeFile(path.join(root, "src/app.ts"), "let accent = green\nconst Accent = 1\n");
  await writeFile(path.join(root, "src/deep/more.ts"), "accentColor()\n");
  await writeFile(path.join(root, "notes.md"), `${"x".repeat(500)}accent${"y".repeat(500)}\n`);
  await writeFile(path.join(root, ".gitignore"), "ignored.ts\n");
  await writeFile(path.join(root, "ignored.ts"), "accent\n");
  await writeFile(path.join(root, "image.bin"), Buffer.from([0, 1, 2, 97, 99, 99, 101, 110, 116]));
});
afterAll(async () => { await rm(root, { recursive: true, force: true }); });

const search = (input: Record<string, unknown>) => searchRepository(root, fileSearchSchema.parse(input));
const files = (result: Awaited<ReturnType<typeof search>>) => result.matches.map(m => m.file).sort();

describe("searchRepository", () => {
  it("finds case-insensitive literals in untracked files, skipping ignored and binary files", async () => {
    const result = await search({ query: "accent" });
    expect(files(result)).toEqual(["notes.md", "src/app.ts", "src/deep/more.ts"]);
    expect(result.matches.find(m => m.file === "src/app.ts")?.lines).toEqual([
      { line: 1, column: 5, text: "let accent = green" }, { line: 2, column: 7, text: "const Accent = 1" }]);
  });

  it("honours case, whole word, regex and path patterns", async () => {
    expect((await search({ query: "Accent", caseSensitive: true })).total).toBe(1);
    expect(files(await search({ query: "accent", wholeWord: true }))).toEqual(["src/app.ts"]);
    expect((await search({ query: "accent(Color)?\\(", regex: true })).total).toBe(1);
    expect(files(await search({ query: "accent", include: ["*.ts"] }))).toEqual(["src/app.ts", "src/deep/more.ts"]);
    expect(files(await search({ query: "accent", include: ["src/deep/**"] }))).toEqual(["src/deep/more.ts"]);
  });

  it("keeps the match in view on long lines, caps results, and returns empty for no match", async () => {
    const long = (await search({ query: "accent", include: ["*.md"] })).matches[0].lines[0];
    expect(long.text.length).toBeLessThanOrEqual(300);
    expect(long.text).toContain("accent");
    expect(long).toMatchObject({ line: 1, column: 501, offset: 460 });
    expect(await search({ query: "accent", limit: 2 })).toMatchObject({ total: 2, truncated: true });
    expect(await search({ query: "nothing-matches-this" })).toEqual({ matches: [], files: 0, total: 0, truncated: false });
  });

  it("rejects pathspec magic, parent paths and multi-line queries", () => {
    for (const bad of [{ query: "a", include: [":(top)x"] }, { query: "a", include: ["../x"] }, { query: "a\nb" }, { query: "" }]) {
      expect(() => fileSearchSchema.parse(bad)).toThrow();
    }
  });
});
