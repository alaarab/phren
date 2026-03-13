import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import * as yaml from "js-yaml";
import { makeTempDir, writeFile, grantAdmin } from "./test-helpers.js";
import { writeProjectTopics } from "./project-topics.js";
import {
  buildIndex,
  buildSourceDocKey,
  queryRows,
  resolveImports,
  normalizeIndexedContent,
  detectProject,
  extractSnippet,
  rowToDoc,
  rowToDocWithRowid,
  queryDocBySourceKey,
  queryDocRows,
  porterStem,
} from "./shared-index.js";

let tmpDir: string;
let tmpCleanup: (() => void) | undefined;

function makeCortex(): string {
  ({ path: tmpDir, cleanup: tmpCleanup } = makeTempDir("cortex-index-test-"));
  writeFile(
    path.join(tmpDir, "cortex.root.yaml"),
    yaml.dump({ version: 1, installMode: "shared", syncMode: "managed-git" }, { lineWidth: 1000 })
  );
  return tmpDir;
}

function makeProject(cortexDir: string, name: string, files: Record<string, string>): void {
  const dir = path.join(cortexDir, name);
  fs.mkdirSync(dir, { recursive: true });
  for (const [file, content] of Object.entries(files)) {
    writeFile(path.join(dir, file), content);
  }
  if (!Object.prototype.hasOwnProperty.call(files, "cortex.project.yaml")) {
    writeFile(path.join(dir, "cortex.project.yaml"), yaml.dump({ sourcePath: `/home/user/${name}` }, { lineWidth: 1000 }));
  }
}

beforeEach(() => {
  delete process.env.CORTEX_PATH;
  delete process.env.CORTEX_PROFILE;
  delete process.env.CORTEX_DEBUG;
  delete process.env.PROJECTS_DIR;
});

afterEach(() => {
  delete process.env.CORTEX_PATH;
  delete process.env.CORTEX_PROFILE;
  delete process.env.CORTEX_DEBUG;
  delete process.env.CORTEX_ACTOR;
  delete process.env.PROJECTS_DIR;
  if (tmpCleanup) {
    tmpCleanup();
    tmpCleanup = undefined;
  }
});

// ── porterStem ───────────────────────────────────────────────────────────────

describe("porterStem", () => {
  it("stems 'running' to 'run'", () => {
    expect(porterStem("running")).toBe("run");
  });

  it("stems 'argued' to 'argu'", () => {
    expect(porterStem("argued")).toBe("argu");
  });

  it("stems 'generalization' to 'general'", () => {
    expect(porterStem("generalization")).toBe("general");
  });

  it("stems 'relational' to 'relat'", () => {
    expect(porterStem("relational")).toBe("relat");
  });

  it("stems 'conditional' to 'condit'", () => {
    expect(porterStem("conditional")).toBe("condit");
  });
});

// ── resolveImports ───────────────────────────────────────────────────────────

describe("resolveImports", () => {
  it("replaces @import with file contents", () => {
    const cortex = makeCortex();
    writeFile(path.join(cortex, "global", "shared.md"), "shared content here");
    const content = "before\n@import shared.md\nafter";
    const result = resolveImports(content, cortex);
    expect(result).toContain("shared content here");
    expect(result).toContain("before");
    expect(result).toContain("after");
  });

  it("handles missing import file gracefully", () => {
    const cortex = makeCortex();
    const content = "@import nonexistent.md";
    const result = resolveImports(content, cortex);
    expect(result).toContain("<!-- @import not found: nonexistent.md -->");
  });

  it("detects circular imports", () => {
    const cortex = makeCortex();
    writeFile(path.join(cortex, "global", "a.md"), "@import b.md");
    writeFile(path.join(cortex, "global", "b.md"), "@import a.md");
    const content = "@import a.md";
    const result = resolveImports(content, cortex);
    expect(result).toContain("<!-- @import cycle:");
  });

  it("blocks path traversal", () => {
    const cortex = makeCortex();
    const content = "@import ../../etc/passwd";
    const result = resolveImports(content, cortex);
    expect(result).toContain("<!-- @import blocked: path traversal -->");
  });

  it("respects max import depth", () => {
    const cortex = makeCortex();
    // Create a chain of imports deeper than MAX_IMPORT_DEPTH (5)
    for (let i = 0; i < 7; i++) {
      const nextImport = i < 6 ? `@import level${i + 1}.md` : "leaf content";
      writeFile(path.join(cortex, "global", `level${i}.md`), nextImport);
    }
    const content = "@import level0.md";
    const result = resolveImports(content, cortex);
    // At depth 5, imports stop being resolved
    expect(result).not.toContain("leaf content");
  });

  it("preserves non-import lines unchanged", () => {
    const cortex = makeCortex();
    const content = "# Title\nSome text\n- bullet point";
    const result = resolveImports(content, cortex);
    expect(result).toBe(content);
  });

  it("resolves nested imports", () => {
    const cortex = makeCortex();
    writeFile(path.join(cortex, "global", "outer.md"), "outer\n@import inner.md");
    writeFile(path.join(cortex, "global", "inner.md"), "inner content");
    const content = "@import outer.md";
    const result = resolveImports(content, cortex);
    expect(result).toContain("outer");
    expect(result).toContain("inner content");
  });

  it("accepts imports when the cortex root itself is reached through a symlink", () => {
    const cortex = makeCortex();
    writeFile(path.join(cortex, "global", "shared.md"), "shared content through symlink");
    const linkedCortex = path.join(os.tmpdir(), `cortex-index-link-${Date.now()}-${Math.random().toString(16).slice(2)}`);
    fs.symlinkSync(cortex, linkedCortex, process.platform === "win32" ? "junction" : "dir");
    try {
      const result = resolveImports("@import shared.md", linkedCortex);
      expect(result).toContain("shared content through symlink");
      expect(result).not.toContain("blocked: symlink traversal");
    } finally {
      fs.rmSync(linkedCortex, { force: true, recursive: true });
    }
  });
});

describe("normalizeIndexedContent", () => {
  it("strips finding provenance comments before indexing", () => {
    const cortex = makeCortex();
    const normalized = normalizeIndexedContent(
      `# proj FINDINGS

## 2026-03-09

- Safe refactors stay incremental <!-- created: 2026-03-09 --> <!-- source: machine:testbox actor:codex model:gpt-5 -->
  <!-- cortex:cite {"created_at":"2026-03-09T10:00:00Z","task_item":"deadbeef"} -->
`,
      "findings",
      cortex,
    );

    expect(normalized).toContain("Safe refactors stay incremental");
    expect(normalized).not.toContain("created:");
    expect(normalized).not.toContain("source:");
    expect(normalized).not.toContain("cortex:cite");
  });
});

// ── extractSnippet ───────────────────────────────────────────────────────────

describe("extractSnippet", () => {
  const doc = [
    "# Project",
    "",
    "Intro paragraph.",
    "",
    "## Auth Section",
    "",
    "The auth module handles login.",
    "It uses JWT tokens.",
    "",
    "## Database",
    "",
    "Uses SQLite with WAL mode.",
  ].join("\n");

  it("returns first N lines when query has no matching terms", () => {
    const snippet = extractSnippet(doc, "AND OR NOT");
    const lines = snippet.split("\n");
    expect(lines.length).toBeLessThanOrEqual(5);
    expect(lines[0]).toBe("# Project");
  });

  it("returns first N lines for empty effective query", () => {
    const snippet = extractSnippet("some content\nmore lines", "");
    expect(snippet).toContain("some content");
  });

  it("finds the best matching section", () => {
    const snippet = extractSnippet(doc, "SQLite WAL");
    expect(snippet).toContain("SQLite");
  });

  it("prefers lines near headings", () => {
    const snippet = extractSnippet(doc, "auth");
    // The best match line contains "auth" (case-insensitive match)
    expect(snippet.toLowerCase()).toContain("auth");
    // Should be from the auth section, not database
    expect(snippet).toContain("login");
  });

  it("respects custom line count", () => {
    const snippet = extractSnippet(doc, "auth", 2);
    const lines = snippet.split("\n");
    expect(lines.length).toBeLessThanOrEqual(2);
  });

  it("handles single-line content", () => {
    const snippet = extractSnippet("just one line", "one");
    expect(snippet).toBe("just one line");
  });

  it("handles content with no headings", () => {
    const noHeadings = "line one\nline two\nline three with target\nline four";
    const snippet = extractSnippet(noHeadings, "target");
    expect(snippet).toContain("target");
  });

  it("strips FTS operators from query before matching", () => {
    const snippet = extractSnippet(doc, "AND auth OR login NOT something");
    expect(snippet).toContain("auth");
  });
});

// ── detectProject ────────────────────────────────────────────────────────────

describe("detectProject", () => {
  it("detects project from sourcePath prefix", () => {
    const cortex = makeCortex();
    makeProject(cortex, "myproject", { "SUMMARY.md": "# Summary" });
    const result = detectProject(cortex, "/home/user/myproject/src");
    expect(result).toBe("myproject");
  });

  it("returns null when no project matches", () => {
    const cortex = makeCortex();
    makeProject(cortex, "myproject", { "SUMMARY.md": "# Summary" });
    const result = detectProject(cortex, "/home/user/other/src");
    expect(result).toBeNull();
  });

  it("uses exact sourcePath matching for short names too", () => {
    const cortex = makeCortex();
    makeProject(cortex, "abc", { "SUMMARY.md": "# Summary" });
    expect(detectProject(cortex, "/home/user/abc")).toBe("abc");
    expect(detectProject(cortex, "/home/user/abc/src")).toBe("abc");
  });

  it("matches long names by sourcePath prefix", () => {
    const cortex = makeCortex();
    makeProject(cortex, "myapp", { "SUMMARY.md": "# Summary" });
    const result = detectProject(cortex, "/home/user/myapp/deep/nested");
    expect(result).toBe("myapp");
  });

  it("uses the stored project name when sourcePath matches", () => {
    const cortex = makeCortex();
    makeProject(cortex, "MyProject", { "SUMMARY.md": "# Summary" });
    writeFile(path.join(cortex, "MyProject", "cortex.project.yaml"), yaml.dump({ sourcePath: "/home/user/myproject" }, { lineWidth: 1000 }));
    const result = detectProject(cortex, "/home/user/myproject/src");
    expect(result).toBe("MyProject");
  });
});

describe("document source keys", () => {
  it("uses project-relative paths for nested project files", () => {
    const cortex = makeCortex();
    const filePath = path.join(cortex, "alpha", "reference", "api", "auth.md");
    expect(buildSourceDocKey("alpha", filePath, cortex, "auth.md")).toBe("alpha/reference/api/auth.md");
  });

  it("falls back to filename for native memory paths outside the project root", () => {
    const cortex = makeCortex();
    const filePath = path.join(os.tmpdir(), "native-findings.md");
    expect(buildSourceDocKey("alpha", filePath, cortex, "FINDINGS.md")).toBe("alpha/FINDINGS.md");
  });

  it("finds docs by canonical source key instead of basename alone", async () => {
    const cortex = makeCortex();
    makeProject(cortex, "alpha", {
      "reference/api/auth.md": "# API auth",
      "reference/runbooks/auth.md": "# Runbook auth",
    });

    const db = await buildIndex(cortex);
    try {
      const apiDoc = queryDocBySourceKey(db, cortex, "alpha/reference/api/auth.md");
      const runbookDoc = queryDocBySourceKey(db, cortex, "alpha/reference/runbooks/auth.md");
      expect(apiDoc?.path).toContain(path.join("reference", "api", "auth.md"));
      expect(runbookDoc?.path).toContain(path.join("reference", "runbooks", "auth.md"));
      expect(apiDoc?.path).not.toBe(runbookDoc?.path);
    } finally {
      db.close();
    }
  });
});

// ── buildIndex + queryRows ───────────────────────────────────────────────────

describe("buildIndex", () => {
  it("builds an FTS index from project files", async () => {
    const cortex = makeCortex();
    grantAdmin(cortex);
    makeProject(cortex, "proj", {
      "FINDINGS.md": "- SQLite uses WAL mode for concurrent reads",
      "SUMMARY.md": "# Project Summary\nThis is a test project.",
    });
    const db = await buildIndex(cortex);
    expect(db).toBeDefined();

    const rows = queryRows(db, "SELECT * FROM docs WHERE docs MATCH ?", ["SQLite"]);
    expect(rows).not.toBeNull();
    expect(rows!.length).toBeGreaterThanOrEqual(1);
    db.close();
  });

  it("indexes files from multiple projects", async () => {
    const cortex = makeCortex();
    grantAdmin(cortex);
    makeProject(cortex, "alpha", { "FINDINGS.md": "- Alpha finding about caching" });
    makeProject(cortex, "beta", { "FINDINGS.md": "- Beta finding about routing" });
    const db = await buildIndex(cortex);

    const alphaRows = queryRows(db, "SELECT * FROM docs WHERE docs MATCH ? AND project = ?", ["caching", "alpha"]);
    expect(alphaRows).not.toBeNull();

    const betaRows = queryRows(db, "SELECT * FROM docs WHERE docs MATCH ? AND project = ?", ["routing", "beta"]);
    expect(betaRows).not.toBeNull();
    db.close();
  });

  it("strips <details> blocks from indexed content", async () => {
    const cortex = makeCortex();
    grantAdmin(cortex);
    makeProject(cortex, "proj", {
      "FINDINGS.md": "- visible finding\n<details>\nxyzuniquehidden archived content\n</details>\n- another visible one",
    });
    const db = await buildIndex(cortex);
    const hidden = queryRows(db, "SELECT * FROM docs WHERE docs MATCH ?", ["xyzuniquehidden"]);
    // "xyzuniquehidden" was inside details, should be stripped
    expect(hidden).toBeNull();

    const visible = queryRows(db, "SELECT * FROM docs WHERE docs MATCH ?", ["visible"]);
    expect(visible).not.toBeNull();
    db.close();
  });

  it("resolves @import directives during indexing", async () => {
    const cortex = makeCortex();
    grantAdmin(cortex);
    writeFile(path.join(cortex, "global", "shared-snippet.md"), "imported snippet about testing");
    makeProject(cortex, "proj", {
      "CLAUDE.md": "# Config\n@import shared-snippet.md",
    });
    const db = await buildIndex(cortex);
    const rows = queryRows(db, "SELECT * FROM docs WHERE docs MATCH ?", ["imported"]);
    expect(rows).not.toBeNull();
    db.close();
  });

  it("indexes repo-owned CLAUDE.md for repo-managed projects instead of the cortex copy", async () => {
    const cortex = makeCortex();
    grantAdmin(cortex);
    const projectsDir = path.join(cortex, "..", "repos");
    process.env.PROJECTS_DIR = projectsDir;
    fs.mkdirSync(path.join(projectsDir, "proj"), { recursive: true });
    writeFile(path.join(projectsDir, "proj", "CLAUDE.md"), "# Repo Instructions\nrepoownedtoken");

    makeProject(cortex, "proj", {
      "CLAUDE.md": "# Cortex Instructions\ncortexcopytoken",
      "FINDINGS.md": "- searchable finding",
      "cortex.project.yaml": yaml.dump({ ownership: "repo-managed", sourcePath: path.join(projectsDir, "proj") }, { lineWidth: 1000 }),
    });

    const db = await buildIndex(cortex);
    const repoRows = queryRows(db, "SELECT * FROM docs WHERE docs MATCH ?", ["repoownedtoken"]);
    const cortexRows = queryRows(db, "SELECT * FROM docs WHERE docs MATCH ?", ["cortexcopytoken"]);
    const claudeDoc = queryDocBySourceKey(db, cortex, "proj/CLAUDE.md");

    expect(repoRows).not.toBeNull();
    expect(cortexRows).toBeNull();
    expect(claudeDoc?.content).toContain("repoownedtoken");
    expect(claudeDoc?.content).not.toContain("cortexcopytoken");
    db.close();
  });

  it("uses cached index on second build with same content", async () => {
    const cortex = makeCortex();
    grantAdmin(cortex);
    makeProject(cortex, "proj", { "FINDINGS.md": "- stable content" });
    const db1 = await buildIndex(cortex);
    db1.close();
    // Second build should hit cache (no way to assert directly, but should not error)
    const db2 = await buildIndex(cortex);
    const rows = queryRows(db2, "SELECT * FROM docs WHERE docs MATCH ?", ["stable"]);
    expect(rows).not.toBeNull();
    db2.close();
  });

  it("classifies arbitrary reference docs by topic keywords at index time", async () => {
    const cortex = makeCortex();
    grantAdmin(cortex);
    makeProject(cortex, "game", {
      "reference/level-design.md": "# Level Design\n\nShader compilation and frame pacing during combat arenas.\n",
    });
    const saved = writeProjectTopics(cortex, "game", [
      { slug: "rendering", label: "Rendering", description: "Shaders and frames", keywords: ["shader", "frame", "render"] },
      { slug: "gameplay", label: "Gameplay", description: "Gameplay systems", keywords: ["combat", "arena", "pause"] },
      { slug: "general", label: "General", description: "Fallback", keywords: [] },
    ]);
    expect(saved.ok).toBe(true);

    const db = await buildIndex(cortex);
    const rows = queryRows(
      db,
      "SELECT filename, content FROM docs WHERE project = ? AND filename = ? AND type = ?",
      ["game", "level-design.md", "reference"]
    );
    expect(rows).not.toBeNull();
    expect(String(rows![0][1])).toContain("cortextopicrendering");
    db.close();
  });

  it("keeps legacy reference/topics/<slug>.md compatibility in index-time topic tagging", async () => {
    const cortex = makeCortex();
    grantAdmin(cortex);
    makeProject(cortex, "app", {
      "reference/topics/database.md": "# Notes\n\nUI layout notes without strong database keywords.\n",
    });
    const saved = writeProjectTopics(cortex, "app", [
      { slug: "database", label: "Database", description: "Storage", keywords: ["query", "schema"] },
      { slug: "frontend", label: "Frontend", description: "UI", keywords: ["ui", "layout"] },
      { slug: "general", label: "General", description: "Fallback", keywords: [] },
    ]);
    expect(saved.ok).toBe(true);

    const db = await buildIndex(cortex);
    const rows = queryRows(
      db,
      "SELECT filename, content FROM docs WHERE project = ? AND filename = ? AND type = ?",
      ["app", "database.md", "reference"]
    );
    expect(rows).not.toBeNull();
    expect(String(rows![0][1])).toContain("cortextopicdatabase");
    db.close();
  });
});

// ── queryRows ────────────────────────────────────────────────────────────────

describe("queryRows", () => {
  it("returns null for no results", async () => {
    const cortex = makeCortex();
    grantAdmin(cortex);
    makeProject(cortex, "proj", { "FINDINGS.md": "- something" });
    const db = await buildIndex(cortex);
    const rows = queryRows(db, "SELECT * FROM docs WHERE docs MATCH ?", ["zzzznonexistent"]);
    expect(rows).toBeNull();
    db.close();
  });

  it("returns null on SQL error", async () => {
    const cortex = makeCortex();
    grantAdmin(cortex);
    makeProject(cortex, "proj", { "FINDINGS.md": "- data" });
    const db = await buildIndex(cortex);
    const rows = queryRows(db, "SELECT * FROM nonexistent_table", []);
    expect(rows).toBeNull();
    db.close();
  });

  it("returns array of arrays for valid results", async () => {
    const cortex = makeCortex();
    grantAdmin(cortex);
    makeProject(cortex, "proj", { "FINDINGS.md": "- database patterns" });
    const db = await buildIndex(cortex);
    const rows = queryRows(db, "SELECT * FROM docs WHERE docs MATCH ?", ["database"]);
    expect(rows).not.toBeNull();
    expect(Array.isArray(rows)).toBe(true);
    expect(Array.isArray(rows![0])).toBe(true);
    db.close();
  });
});

// ── rowToDoc ─────────────────────────────────────────────────────────────────

describe("rowToDoc", () => {
  it("maps array to DocRow object", () => {
    const row = ["myproject", "FINDINGS.md", "findings", "some content", "/path/to/file"];
    const doc = rowToDoc(row);
    expect(doc).toEqual({
      project: "myproject",
      filename: "FINDINGS.md",
      type: "findings",
      content: "some content",
      path: "/path/to/file",
    });
  });

  it("throws on short rows instead of coercing missing cells", () => {
    expect(() => rowToDoc(["myproject", "FINDINGS.md"])).toThrow(/expected at least 5 columns/i);
  });
});

describe("rowToDocWithRowid", () => {
  it("maps a rowid-prefixed row to a typed object", () => {
    const decoded = rowToDocWithRowid([42, "myproject", "FINDINGS.md", "findings", "some content", "/path/to/file"]);
    expect(decoded).toEqual({
      rowid: 42,
      doc: {
        project: "myproject",
        filename: "FINDINGS.md",
        type: "findings",
        content: "some content",
        path: "/path/to/file",
      },
    });
  });
});

// ── queryDocRows ─────────────────────────────────────────────────────────────

describe("queryDocRows", () => {
  it("returns DocRow objects for matching results", async () => {
    const cortex = makeCortex();
    grantAdmin(cortex);
    makeProject(cortex, "proj", { "FINDINGS.md": "- architecture decision records" });
    const db = await buildIndex(cortex);
    const docs = queryDocRows(db, "SELECT * FROM docs WHERE docs MATCH ?", ["architecture"]);
    expect(docs).not.toBeNull();
    expect(docs![0].project).toBe("proj");
    expect(docs![0].type).toBe("findings");
    db.close();
  });

  it("returns null when no matches", async () => {
    const cortex = makeCortex();
    grantAdmin(cortex);
    makeProject(cortex, "proj", { "FINDINGS.md": "- data" });
    const db = await buildIndex(cortex);
    const docs = queryDocRows(db, "SELECT * FROM docs WHERE docs MATCH ?", ["xyznonexistent"]);
    expect(docs).toBeNull();
    db.close();
  });
});
