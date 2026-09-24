import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import * as yaml from "js-yaml";
import { makeTempDir, writeFile, grantAdmin, resetTestPhrenPath } from "./test-helpers.js";
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
import { getPersistentVectorIndex } from "./shared/vector-index.js";
import { getMachineName } from "./machine-identity.js";
import { getProjectSourcePath, readProjectConfig, recordProjectSourcePath } from "./project-config.js";

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
  resetTestPhrenPath();
  delete process.env.PHREN_PROFILE;
  delete process.env.PHREN_DEBUG;
  delete process.env.PROJECTS_DIR;
});

afterEach(() => {
  resetTestPhrenPath();
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
  it.each([
    ["running", "run"],
    ["argued", "argu"],
    ["generalization", "general"],
    ["relational", "relat"],
    ["conditional", "condit"],
  ])("stems '%s' to '%s'", (word, stem) => {
    expect(porterStem(word)).toBe(stem);
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
    // An empty effective query takes the same first-lines path.
    expect(extractSnippet("some content\nmore lines", "")).toContain("some content");
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

  it("falls back to a case-insensitive match, for a sourcePath synced from a case-insensitive filesystem", () => {
    const phren = makePhren();
    makeProject(phren, "myproject", { "SUMMARY.md": "# Summary" });
    expect(detectProject(phren, "/home/user/MyProject/src")).toBe("myproject");
    expect(detectProject(phren, "/home/user/myprojectx")).toBeNull();
  });

  it("uses exact sourcePath matching for short names too", () => {
    const phren = makePhren();
    makeProject(phren, "abc", { "SUMMARY.md": "# Summary" });
    expect(detectProject(phren, "/home/user/abc")).toBe("abc");
    expect(detectProject(phren, "/home/user/abc/src")).toBe("abc");
  });

  it("uses the stored project name when sourcePath matches", () => {
    const phren = makePhren();
    // Stored name intentionally differs from sourcePath basename to prove
    // detectProject returns the stored name rather than deriving from cwd.
    makeProject(phren, "stored-name", { "SUMMARY.md": "# Summary" });
    writeFile(path.join(phren, "stored-name", "phren.project.yaml"), yaml.dump({ sourcePath: "/home/user/other-location" }, { lineWidth: 1000 }));
    const result = detectProject(phren, "/home/user/other-location/src");
    expect(result).toBe("stored-name");
  });

  it("prefers this machine's sourcePaths entry over the shared sourcePath", () => {
    const phren = makePhren();
    makeProject(phren, "shared", {
      "phren.project.yaml": yaml.dump({
        sourcePath: "/home/other/Projects/shared",
        sourcePaths: { [getMachineName()]: "/Users/me/Sites/shared", "other-box": "/home/other/Projects/shared" },
      }),
    });
    expect(detectProject(phren, "/Users/me/Sites/shared/src")).toBe("shared");
    expect(detectProject(phren, "/home/other/Projects/shared")).toBeNull();
  });

  it("falls back to a local git checkout named after the project when the registered folder is another machine's", () => {
    const phren = makePhren();
    const { path: root, cleanup } = makeTempDir("phren-checkout-");
    try {
      const checkout = path.join(root, "Sites", "synced");
      fs.mkdirSync(path.join(checkout, ".git"), { recursive: true });
      fs.mkdirSync(path.join(checkout, "src"), { recursive: true });
      makeProject(phren, "synced", {
        "phren.project.yaml": yaml.dump({ sourcePath: "/home/squid/Projects/synced" }),
      });
      expect(detectProject(phren, path.join(checkout, "src"))).toBe("synced");
      // An agent worktree of that checkout belongs to it too.
      const worktree = path.join(checkout, ".claude", "worktrees", "some-codename");
      fs.mkdirSync(worktree, { recursive: true });
      expect(detectProject(phren, worktree)).toBe("synced");

      // A plain folder that merely shares the name is not a checkout.
      const plain = path.join(root, "elsewhere", "synced");
      fs.mkdirSync(plain, { recursive: true });
      expect(detectProject(phren, plain)).toBeNull();
    } finally {
      cleanup();
    }
  });

  it("keeps the registered folder authoritative when it exists on this machine", () => {
    const phren = makePhren();
    const { path: root, cleanup } = makeTempDir("phren-checkout-");
    try {
      const registered = path.join(root, "real-home");
      fs.mkdirSync(registered, { recursive: true });
      const namesake = path.join(root, "copies", "owned");
      fs.mkdirSync(path.join(namesake, ".git"), { recursive: true });
      makeProject(phren, "owned", { "phren.project.yaml": yaml.dump({ sourcePath: registered }) });
      expect(detectProject(phren, registered)).toBe("owned");
      expect(detectProject(phren, namesake)).toBeNull();
    } finally {
      cleanup();
    }
  });
});

describe("per-machine source paths", () => {
  it("records this machine's folder without dropping other machines' entries", () => {
    const phren = makePhren();
    makeProject(phren, "multi", {
      "phren.project.yaml": yaml.dump({ ownership: "repo-managed", sourcePaths: { "linux-box": "/home/me/multi" } }),
    });
    recordProjectSourcePath(phren, "multi", "/Users/me/Sites/multi", {}, "mac");
    const config = readProjectConfig(phren, "multi");
    expect(config.ownership).toBe("repo-managed");
    expect(config.sourcePath).toBe("/Users/me/Sites/multi");
    expect(config.sourcePaths).toEqual({ "linux-box": "/home/me/multi", mac: "/Users/me/Sites/multi" });
    expect(getProjectSourcePath(phren, "multi", undefined, "linux-box")).toBe(path.resolve("/home/me/multi"));
    expect(getProjectSourcePath(phren, "multi", undefined, "mac")).toBe(path.resolve("/Users/me/Sites/multi"));
    // A machine with no entry of its own uses the shared value.
    expect(getProjectSourcePath(phren, "multi", undefined, "new-box")).toBe(path.resolve("/Users/me/Sites/multi"));
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
      "AGENTS.md": "# Config\n@import shared/shared-snippet.md",
    });
    const db = await buildIndex(phren);
    const rows = queryRows(db, "SELECT * FROM docs WHERE docs MATCH ?", ["imported"]);
    expect(rows).not.toBeNull();
    db.close();
  });

  it("indexes repo-owned AGENTS.md for repo-managed projects instead of the phren copy", async () => {
    const phren = makePhren();
    grantAdmin(phren);
    const projectsDir = path.join(phren, "..", "repos");
    process.env.PROJECTS_DIR = projectsDir;
    fs.mkdirSync(path.join(projectsDir, "proj"), { recursive: true });
    writeFile(path.join(projectsDir, "proj", "AGENTS.md"), "# Repo Instructions\nrepoownedtoken");

    makeProject(phren, "proj", {
      "AGENTS.md": "# Phren Instructions\nphrencopytoken",
      "FINDINGS.md": "- searchable finding",
      "phren.project.yaml": yaml.dump({ ownership: "repo-managed", sourcePath: path.join(projectsDir, "proj") }, { lineWidth: 1000 }),
    });

    const db = await buildIndex(phren);
    const repoRows = queryRows(db, "SELECT * FROM docs WHERE docs MATCH ?", ["repoownedtoken"]);
    const phrenRows = queryRows(db, "SELECT * FROM docs WHERE docs MATCH ?", ["phrencopytoken"]);
    const claudeDoc = queryDocBySourceKey(db, phren, "proj/AGENTS.md");

    expect(repoRows).not.toBeNull();
    expect(phrenRows).toBeNull();
    expect(claudeDoc?.content).toContain("repoownedtoken");
    expect(claudeDoc?.content).not.toContain("phrencopytoken");
    db.close();
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
});

// ── PersistentVectorIndex ────────────────────────────────────────────────────

function makeVec(seed: number, dims = 16): number[] {
  const vec: number[] = [];
  let value = seed >>> 0;
  for (let i = 0; i < dims; i++) {
    value = (Math.imul(value, 1664525) + 1013904223) >>> 0;
    const a = ((value & 0xffff) / 0xffff) * 2 - 1;
    value = (Math.imul(value, 1664525) + 1013904223) >>> 0;
    const b = ((value & 0xffff) / 0xffff) * 2 - 1;
    vec.push(a + b * 0.25);
  }
  return vec;
}

describe("PersistentVectorIndex", () => {
  it("returns a bounded candidate set that still includes the exact vector path", () => {
    const tmp = makeTempDir("vector-index-");
    try {
      const entries = Array.from({ length: 96 }, (_, i) => ({
        path: `${tmp.path}/doc-${i}.md`,
        model: "nomic-embed-text",
        vec: makeVec(i + 1),
      }));

      const index = getPersistentVectorIndex(tmp.path);
      index.ensure(entries);

      const target = entries[37];
      const candidates = index.query(target.model, target.vec, 5);

      expect(candidates).toContain(target.path);
      expect(candidates.length).toBeGreaterThan(0);
      expect(candidates.length).toBeLessThan(entries.length);
    } finally {
      tmp.cleanup();
    }
  });
});
