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
} from "./shared/index.js";

let tmpDir: string;
let tmpCleanup: (() => void) | undefined;

function makePhren(): string {
  ({ path: tmpDir, cleanup: tmpCleanup } = makeTempDir("phren-index-test-"));
  writeFile(
    path.join(tmpDir, "phren.root.yaml"),
    yaml.dump({ version: 1, installMode: "shared", syncMode: "managed-git" }, { lineWidth: 1000 })
  );
  return tmpDir;
}

function makeProject(phrenDir: string, name: string, files: Record<string, string>): void {
  const dir = path.join(phrenDir, name);
  fs.mkdirSync(dir, { recursive: true });
  for (const [file, content] of Object.entries(files)) {
    writeFile(path.join(dir, file), content);
  }
  if (!Object.prototype.hasOwnProperty.call(files, "phren.project.yaml")) {
    writeFile(path.join(dir, "phren.project.yaml"), yaml.dump({ sourcePath: `/home/user/${name}` }, { lineWidth: 1000 }));
  }
}

beforeEach(() => {
  delete process.env.PHREN_PATH;
  delete process.env.PHREN_PROFILE;
  delete process.env.PHREN_DEBUG;
  delete process.env.PROJECTS_DIR;
});

afterEach(() => {
  delete process.env.PHREN_PATH;
  delete process.env.PHREN_PROFILE;
  delete process.env.PHREN_DEBUG;
  delete process.env.PHREN_ACTOR;
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
    const phren = makePhren();
    writeFile(path.join(phren, "global", "shared", "shared.md"), "shared content here");
    const content = "before\n@import shared/shared.md\nafter";
    const result = resolveImports(content, phren);
    expect(result).toContain("shared content here");
    expect(result).toContain("before");
    expect(result).toContain("after");
  });

  it("handles missing import file gracefully", () => {
    const phren = makePhren();
    const content = "@import shared/nonexistent.md";
    const result = resolveImports(content, phren);
    expect(result).toContain("<!-- @import not found: shared/nonexistent.md -->");
  });

  it("detects circular imports", () => {
    const phren = makePhren();
    writeFile(path.join(phren, "global", "shared", "a.md"), "@import shared/b.md");
    writeFile(path.join(phren, "global", "shared", "b.md"), "@import shared/a.md");
    const content = "@import shared/a.md";
    const result = resolveImports(content, phren);
    expect(result).toContain("<!-- @import cycle:");
  });

  it("blocks path traversal", () => {
    const phren = makePhren();
    const content = "@import ../../etc/passwd";
    const result = resolveImports(content, phren);
    expect(result).toContain("<!-- @import blocked: only shared/*.md allowed -->");
  });

  it("respects max import depth", () => {
    const phren = makePhren();
    // Create a chain of imports deeper than MAX_IMPORT_DEPTH (5)
    for (let i = 0; i < 7; i++) {
      const nextImport = i < 6 ? `@import shared/level${i + 1}.md` : "leaf content";
      writeFile(path.join(phren, "global", "shared", `level${i}.md`), nextImport);
    }
    const content = "@import shared/level0.md";
    const result = resolveImports(content, phren);
    // At depth 5, imports stop being resolved
    expect(result).not.toContain("leaf content");
  });

  it("preserves non-import lines unchanged", () => {
    const phren = makePhren();
    const content = "# Title\nSome text\n- bullet point";
    const result = resolveImports(content, phren);
    expect(result).toBe(content);
  });

  it("resolves nested imports", () => {
    const phren = makePhren();
    writeFile(path.join(phren, "global", "shared", "outer.md"), "outer\n@import shared/inner.md");
    writeFile(path.join(phren, "global", "shared", "inner.md"), "inner content");
    const content = "@import shared/outer.md";
    const result = resolveImports(content, phren);
    expect(result).toContain("outer");
    expect(result).toContain("inner content");
  });

  it("accepts imports when the phren root itself is reached through a symlink", () => {
    const phren = makePhren();
    writeFile(path.join(phren, "global", "shared", "shared.md"), "shared content through symlink");
    const linkedPhren = path.join(os.tmpdir(), `phren-index-link-${Date.now()}-${Math.random().toString(16).slice(2)}`);
    fs.symlinkSync(phren, linkedPhren, process.platform === "win32" ? "junction" : "dir");
    try {
      const result = resolveImports("@import shared/shared.md", linkedPhren);
      expect(result).toContain("shared content through symlink");
      expect(result).not.toContain("blocked: symlink traversal");
    } finally {
      fs.rmSync(linkedPhren, { force: true, recursive: true });
    }
  });

  it("blocks imports outside the documented shared/*.md scope", () => {
    const phren = makePhren();
    writeFile(path.join(phren, "global", "config.json"), "{\"unsafe\":true}");
    expect(resolveImports("@import config.json", phren)).toContain("<!-- @import blocked: only shared/*.md allowed -->");
    expect(resolveImports("@import private/secret.md", phren)).toContain("<!-- @import blocked: only shared/*.md allowed -->");
  });
});

describe("normalizeIndexedContent", () => {
  it("strips finding provenance comments before indexing", () => {
    const phren = makePhren();
    const normalized = normalizeIndexedContent(
      `# proj FINDINGS

## 2026-03-09

- Safe refactors stay incremental <!-- created: 2026-03-09 --> <!-- source: machine:testbox actor:codex model:gpt-5 -->
  <!-- phren:cite {"created_at":"2026-03-09T10:00:00Z","task_item":"deadbeef"} -->
`,
      "findings",
      phren,
    );

    expect(normalized).toContain("Safe refactors stay incremental");
    expect(normalized).not.toContain("created:");
    expect(normalized).not.toContain("source:");
    expect(normalized).not.toContain("phren:cite");
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
    const phren = makePhren();
    makeProject(phren, "myproject", { "SUMMARY.md": "# Summary" });
    const result = detectProject(phren, "/home/user/myproject/src");
    expect(result).toBe("myproject");
  });

  it("returns null when no project matches", () => {
    const phren = makePhren();
    makeProject(phren, "myproject", { "SUMMARY.md": "# Summary" });
    const result = detectProject(phren, "/home/user/other/src");
    expect(result).toBeNull();
  });

  it("uses exact sourcePath matching for short names too", () => {
    const phren = makePhren();
    makeProject(phren, "abc", { "SUMMARY.md": "# Summary" });
    expect(detectProject(phren, "/home/user/abc")).toBe("abc");
    expect(detectProject(phren, "/home/user/abc/src")).toBe("abc");
  });

  it("matches long names by sourcePath prefix", () => {
    const phren = makePhren();
    makeProject(phren, "myapp", { "SUMMARY.md": "# Summary" });
    const result = detectProject(phren, "/home/user/myapp/deep/nested");
    expect(result).toBe("myapp");
  });

  it("uses the stored project name when sourcePath matches", () => {
    const phren = makePhren();
    makeProject(phren, "MyProject", { "SUMMARY.md": "# Summary" });
    writeFile(path.join(phren, "MyProject", "phren.project.yaml"), yaml.dump({ sourcePath: "/home/user/myproject" }, { lineWidth: 1000 }));
    const result = detectProject(phren, "/home/user/myproject/src");
    expect(result).toBe("MyProject");
  });
});

describe("document source keys", () => {
  it("uses project-relative paths for nested project files", () => {
    const phren = makePhren();
    const filePath = path.join(phren, "alpha", "reference", "api", "auth.md");
    expect(buildSourceDocKey("alpha", filePath, phren, "auth.md")).toBe("alpha/reference/api/auth.md");
  });

  it("falls back to filename for native memory paths outside the project root", () => {
    const phren = makePhren();
    const filePath = path.join(os.tmpdir(), "native-findings.md");
    expect(buildSourceDocKey("alpha", filePath, phren, "FINDINGS.md")).toBe("alpha/FINDINGS.md");
  });

  it("finds docs by canonical source key instead of basename alone", async () => {
    const phren = makePhren();
    makeProject(phren, "alpha", {
      "reference/api/auth.md": "# API auth",
      "reference/runbooks/auth.md": "# Runbook auth",
    });

    const db = await buildIndex(phren);
    try {
      const apiDoc = queryDocBySourceKey(db, phren, "alpha/reference/api/auth.md");
      const runbookDoc = queryDocBySourceKey(db, phren, "alpha/reference/runbooks/auth.md");
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
    const phren = makePhren();
    grantAdmin(phren);
    makeProject(phren, "proj", {
      "FINDINGS.md": "- SQLite uses WAL mode for concurrent reads",
      "SUMMARY.md": "# Project Summary\nThis is a test project.",
    });
    const db = await buildIndex(phren);
    expect(db).toBeDefined();

    const rows = queryRows(db, "SELECT * FROM docs WHERE docs MATCH ?", ["SQLite"]);
    expect(rows).not.toBeNull();
    expect(rows!.length).toBeGreaterThanOrEqual(1);
    db.close();
  });

  it("indexes files from multiple projects", async () => {
    const phren = makePhren();
    grantAdmin(phren);
    makeProject(phren, "alpha", { "FINDINGS.md": "- Alpha finding about caching" });
    makeProject(phren, "beta", { "FINDINGS.md": "- Beta finding about routing" });
    const db = await buildIndex(phren);

    const alphaRows = queryRows(db, "SELECT * FROM docs WHERE docs MATCH ? AND project = ?", ["caching", "alpha"]);
    expect(alphaRows).not.toBeNull();

    const betaRows = queryRows(db, "SELECT * FROM docs WHERE docs MATCH ? AND project = ?", ["routing", "beta"]);
    expect(betaRows).not.toBeNull();
    db.close();
  });

  it("strips <details> blocks from indexed content", async () => {
    const phren = makePhren();
    grantAdmin(phren);
    makeProject(phren, "proj", {
      "FINDINGS.md": "- visible finding\n<details>\nxyzuniquehidden archived content\n</details>\n- another visible one",
    });
    const db = await buildIndex(phren);
    const hidden = queryRows(db, "SELECT * FROM docs WHERE docs MATCH ?", ["xyzuniquehidden"]);
    // "xyzuniquehidden" was inside details, should be stripped
    expect(hidden).toBeNull();

    const visible = queryRows(db, "SELECT * FROM docs WHERE docs MATCH ?", ["visible"]);
    expect(visible).not.toBeNull();
    db.close();
  });

  it("resolves @import directives during indexing", async () => {
    const phren = makePhren();
    grantAdmin(phren);
    writeFile(path.join(phren, "global", "shared", "shared-snippet.md"), "imported snippet about testing");
    makeProject(phren, "proj", {
      "CLAUDE.md": "# Config\n@import shared/shared-snippet.md",
    });
    const db = await buildIndex(phren);
    const rows = queryRows(db, "SELECT * FROM docs WHERE docs MATCH ?", ["imported"]);
    expect(rows).not.toBeNull();
    db.close();
  });

  it("indexes repo-owned CLAUDE.md for repo-managed projects instead of the phren copy", async () => {
    const phren = makePhren();
    grantAdmin(phren);
    const projectsDir = path.join(phren, "..", "repos");
    process.env.PROJECTS_DIR = projectsDir;
    fs.mkdirSync(path.join(projectsDir, "proj"), { recursive: true });
    writeFile(path.join(projectsDir, "proj", "CLAUDE.md"), "# Repo Instructions\nrepoownedtoken");

    makeProject(phren, "proj", {
      "CLAUDE.md": "# Phren Instructions\nphrencopytoken",
      "FINDINGS.md": "- searchable finding",
      "phren.project.yaml": yaml.dump({ ownership: "repo-managed", sourcePath: path.join(projectsDir, "proj") }, { lineWidth: 1000 }),
    });

    const db = await buildIndex(phren);
    const repoRows = queryRows(db, "SELECT * FROM docs WHERE docs MATCH ?", ["repoownedtoken"]);
    const phrenRows = queryRows(db, "SELECT * FROM docs WHERE docs MATCH ?", ["phrencopytoken"]);
    const claudeDoc = queryDocBySourceKey(db, phren, "proj/CLAUDE.md");

    expect(repoRows).not.toBeNull();
    expect(phrenRows).toBeNull();
    expect(claudeDoc?.content).toContain("repoownedtoken");
    expect(claudeDoc?.content).not.toContain("phrencopytoken");
    db.close();
  });

  it("uses cached index on second build with same content", async () => {
    const phren = makePhren();
    grantAdmin(phren);
    makeProject(phren, "proj", { "FINDINGS.md": "- stable content" });
    const db1 = await buildIndex(phren);
    db1.close();
    // Second build should hit cache (no way to assert directly, but should not error)
    const db2 = await buildIndex(phren);
    const rows = queryRows(db2, "SELECT * FROM docs WHERE docs MATCH ?", ["stable"]);
    expect(rows).not.toBeNull();
    db2.close();
  });

  it("classifies arbitrary reference docs by topic keywords at index time", async () => {
    const phren = makePhren();
    grantAdmin(phren);
    makeProject(phren, "game", {
      "reference/level-design.md": "# Level Design\n\nShader compilation and frame pacing during combat arenas.\n",
    });
    const saved = writeProjectTopics(phren, "game", [
      { slug: "rendering", label: "Rendering", description: "Shaders and frames", keywords: ["shader", "frame", "render"] },
      { slug: "gameplay", label: "Gameplay", description: "Gameplay systems", keywords: ["combat", "arena", "pause"] },
      { slug: "general", label: "General", description: "Fallback", keywords: [] },
    ]);
    expect(saved.ok).toBe(true);

    const db = await buildIndex(phren);
    const rows = queryRows(
      db,
      "SELECT filename, content FROM docs WHERE project = ? AND filename = ? AND type = ?",
      ["game", "level-design.md", "reference"]
    );
    expect(rows).not.toBeNull();
    expect(String(rows![0][1])).toContain("phrentopicrendering");
    db.close();
  });

  it("keeps legacy reference/topics/<slug>.md compatibility in index-time topic tagging", async () => {
    const phren = makePhren();
    grantAdmin(phren);
    makeProject(phren, "app", {
      "reference/topics/database.md": "# Notes\n\nUI layout notes without strong database keywords.\n",
    });
    const saved = writeProjectTopics(phren, "app", [
      { slug: "database", label: "Database", description: "Storage", keywords: ["query", "schema"] },
      { slug: "frontend", label: "Frontend", description: "UI", keywords: ["ui", "layout"] },
      { slug: "general", label: "General", description: "Fallback", keywords: [] },
    ]);
    expect(saved.ok).toBe(true);

    const db = await buildIndex(phren);
    const rows = queryRows(
      db,
      "SELECT filename, content FROM docs WHERE project = ? AND filename = ? AND type = ?",
      ["app", "database.md", "reference"]
    );
    expect(rows).not.toBeNull();
    expect(String(rows![0][1])).toContain("phrentopicdatabase");
    db.close();
  });
});

// ── queryRows ────────────────────────────────────────────────────────────────

describe("queryRows", () => {
  it("returns null for no results", async () => {
    const phren = makePhren();
    grantAdmin(phren);
    makeProject(phren, "proj", { "FINDINGS.md": "- something" });
    const db = await buildIndex(phren);
    const rows = queryRows(db, "SELECT * FROM docs WHERE docs MATCH ?", ["zzzznonexistent"]);
    expect(rows).toBeNull();
    db.close();
  });

  it("returns null on SQL error", async () => {
    const phren = makePhren();
    grantAdmin(phren);
    makeProject(phren, "proj", { "FINDINGS.md": "- data" });
    const db = await buildIndex(phren);
    const rows = queryRows(db, "SELECT * FROM nonexistent_table", []);
    expect(rows).toBeNull();
    db.close();
  });

  it("returns array of arrays for valid results", async () => {
    const phren = makePhren();
    grantAdmin(phren);
    makeProject(phren, "proj", { "FINDINGS.md": "- database patterns" });
    const db = await buildIndex(phren);
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
    const phren = makePhren();
    grantAdmin(phren);
    makeProject(phren, "proj", { "FINDINGS.md": "- architecture decision records" });
    const db = await buildIndex(phren);
    const docs = queryDocRows(db, "SELECT * FROM docs WHERE docs MATCH ?", ["architecture"]);
    expect(docs).not.toBeNull();
    expect(docs![0].project).toBe("proj");
    expect(docs![0].type).toBe("findings");
    db.close();
  });

  it("returns null when no matches", async () => {
    const phren = makePhren();
    grantAdmin(phren);
    makeProject(phren, "proj", { "FINDINGS.md": "- data" });
    const db = await buildIndex(phren);
    const docs = queryDocRows(db, "SELECT * FROM docs WHERE docs MATCH ?", ["xyznonexistent"]);
    expect(docs).toBeNull();
    db.close();
  });
});
