/**
 * Regression tests: index rebuilds reflect file changes.
 * Verifies that buildIndex picks up modified project files and global @import changes.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as fs from "fs";
import * as path from "path";
import { makeTempDir, grantAdmin, writeFile } from "../test-helpers.js";
import { buildIndex, type SqlJsDatabase } from "../shared/shared-index.js";

describe("index invalidation: file changes trigger rebuild", () => {
  let tmp: { path: string; cleanup: () => void };
  let db: SqlJsDatabase;

  beforeEach(() => {
    tmp = makeTempDir("idx-inval-");
    grantAdmin(tmp.path);

    const projectDir = path.join(tmp.path, "myapp");
    fs.mkdirSync(projectDir, { recursive: true });
    writeFile(path.join(projectDir, "summary.md"), "# myapp\nTest application.");
    writeFile(
      path.join(projectDir, "FINDINGS.md"),
      "# myapp Findings\n\n- Zymurgical pattern: ferment in sealed containers for best results\n"
    );

    // Global dir with shared content (imported by project files)
    const globalDir = path.join(tmp.path, "global", "shared");
    fs.mkdirSync(globalDir, { recursive: true });
    writeFile(
      path.join(globalDir, "conventions.md"),
      "# Global Conventions\n\n- Xylotomy rule: use sharp instruments for precision cuts\n"
    );
  });

  afterEach(() => {
    db?.close();
    tmp.cleanup();
  });

  it("project FINDINGS.md content is indexed on first build", async () => {
    db = await buildIndex(tmp.path);

    const results = db.exec(
      "SELECT content FROM docs WHERE content LIKE '%Zymurgical%'"
    );
    expect(results.length).toBeGreaterThan(0);
    expect(String(results[0].values[0][0])).toContain("Zymurgical");
  });

  it("after modifying FINDINGS.md, a new buildIndex call picks up the change", async () => {
    db = await buildIndex(tmp.path);

    const before = db.exec("SELECT content FROM docs WHERE content LIKE '%Zymurgical%'");
    expect(before.length).toBeGreaterThan(0);
    db.close();

    // Modify the project file (different mtime = different hash = rebuild)
    writeFile(
      path.join(tmp.path, "myapp", "FINDINGS.md"),
      "# myapp Findings\n\n- Zarathustrian insight: async patterns improve throughput significantly\n"
    );

    db = await buildIndex(tmp.path);

    const afterOld = db.exec("SELECT content FROM docs WHERE content LIKE '%Zymurgical%'");
    const afterNew = db.exec("SELECT content FROM docs WHERE content LIKE '%Zarathustrian%'");

    expect(afterNew.length).toBeGreaterThan(0);
    expect(afterOld.length).toBe(0);
  });

  it("project file using @import gets global content indexed", async () => {
    // Write a project file that @imports the global conventions
    writeFile(
      path.join(tmp.path, "myapp", "reference.md"),
      "# myapp reference\n\n@import shared/conventions.md\n"
    );

    db = await buildIndex(tmp.path);

    // The @import-resolved content should be in docs
    const results = db.exec(
      "SELECT content FROM docs WHERE content LIKE '%Xylotomy%'"
    );
    expect(results.length).toBeGreaterThan(0);
  });

  it("changing global file that is @imported causes content change on rebuild", async () => {
    writeFile(
      path.join(tmp.path, "myapp", "reference.md"),
      "# myapp reference\n\n@import shared/conventions.md\n"
    );

    db = await buildIndex(tmp.path);

    const before = db.exec("SELECT content FROM docs WHERE content LIKE '%Xylotomy%'");
    expect(before.length).toBeGreaterThan(0);
    db.close();

    // Modify global file
    writeFile(
      path.join(tmp.path, "global", "shared", "conventions.md"),
      "# Global Conventions\n\n- Zarathustrian rule: use async I/O for all network operations\n"
    );

    db = await buildIndex(tmp.path);

    const afterOld = db.exec("SELECT content FROM docs WHERE content LIKE '%Xylotomy%'");
    const afterNew = db.exec("SELECT content FROM docs WHERE content LIKE '%Zarathustrian%'");

    expect(afterNew.length).toBeGreaterThan(0);
    expect(afterOld.length).toBe(0);
  });
});
