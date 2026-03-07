import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as fs from "fs";
import * as path from "path";
import { makeTempDir, grantAdmin, writeFile } from "../test-helpers.js";
import { register } from "../mcp-data.js";
import type { McpContext } from "../mcp-types.js";

type ToolHandler = (args: Record<string, unknown>) => Promise<{ content: { type: string; text: string }[] }>;

function makeMockServer() {
  const tools = new Map<string, ToolHandler>();
  return {
    registerTool(name: string, _meta: unknown, handler: ToolHandler) {
      tools.set(name, handler);
    },
    call(name: string, args: Record<string, unknown>) {
      const handler = tools.get(name);
      if (!handler) throw new Error(`Tool "${name}" not registered`);
      return handler(args);
    },
  };
}

function parseResult(res: { content: { type: string; text: string }[] }) {
  return JSON.parse(res.content[0].text);
}

function makeCtx(cortexPath: string, overrides?: Partial<McpContext>): McpContext {
  return {
    cortexPath,
    profile: "test",
    db: () => { throw new Error("db not expected"); },
    rebuildIndex: async () => {},
    withWriteQueue: async <T>(fn: () => Promise<T>) => fn(),
    ...overrides,
  };
}

describe("mcp-data: export/import round-trip", () => {
  let tmp: { path: string; cleanup: () => void };
  let server: ReturnType<typeof makeMockServer>;

  beforeEach(() => {
    tmp = makeTempDir("mcp-data-");
    grantAdmin(tmp.path);
    server = makeMockServer();
  });

  afterEach(() => {
    delete process.env.CORTEX_ACTOR;
    tmp.cleanup();
  });

  it("exports a project with findings, backlog, and summary", async () => {
    const projectDir = path.join(tmp.path, "test-proj");
    fs.mkdirSync(projectDir, { recursive: true });

    writeFile(path.join(projectDir, "summary.md"), "# test-proj\nA test project.");
    writeFile(
      path.join(projectDir, "FINDINGS.md"),
      "# test-proj Findings\n\n## 2026-03-01\n\n- Always use WAL mode\n"
    );
    writeFile(
      path.join(projectDir, "backlog.md"),
      "# test-proj backlog\n\n## Active\n\n- [ ] Add caching\n\n## Queue\n\n## Done\n\n- [x] Setup CI\n"
    );
    writeFile(path.join(projectDir, "CLAUDE.md"), "# Instructions\nUse vitest.");

    register(server as any, makeCtx(tmp.path));

    const res = parseResult(await server.call("export_project", { project: "test-proj" }));
    expect(res.ok).toBe(true);
    expect(res.data.project).toBe("test-proj");
    expect(res.data.summary).toContain("A test project.");
    expect(res.data.claudeMd).toContain("Use vitest");
    expect(res.data.findingsRaw).toContain("Always use WAL mode");
    expect(res.data.backlog.Active).toHaveLength(1);
    expect(res.data.backlog.Done).toHaveLength(1);
  });

  it("import recreates project files from exported JSON", async () => {
    // Create and export a project
    const projectDir = path.join(tmp.path, "orig");
    fs.mkdirSync(projectDir, { recursive: true });
    writeFile(path.join(projectDir, "summary.md"), "# orig\nOriginal project.");
    writeFile(
      path.join(projectDir, "FINDINGS.md"),
      "# orig Findings\n\n## 2026-03-01\n\n- Finding alpha\n"
    );
    writeFile(
      path.join(projectDir, "backlog.md"),
      "# orig backlog\n\n## Active\n\n- [ ] Task one\n\n## Queue\n\n## Done\n"
    );
    writeFile(path.join(projectDir, "CLAUDE.md"), "# Claude\nBe concise.");

    register(server as any, makeCtx(tmp.path));

    const exportRes = parseResult(await server.call("export_project", { project: "orig" }));
    expect(exportRes.ok).toBe(true);

    // Import into a new project name
    const importPayload = { ...exportRes.data, project: "imported" };
    const importRes = parseResult(
      await server.call("import_project", { data: JSON.stringify(importPayload) })
    );
    expect(importRes.ok).toBe(true);
    expect(importRes.data.project).toBe("imported");
    expect(importRes.data.files).toContain("summary.md");
    expect(importRes.data.files).toContain("CLAUDE.md");
    expect(importRes.data.files).toContain("FINDINGS.md");

    // Verify files on disk
    const importedDir = path.join(tmp.path, "imported");
    expect(fs.existsSync(importedDir)).toBe(true);
    expect(fs.readFileSync(path.join(importedDir, "summary.md"), "utf8")).toContain("Original project.");
    expect(fs.readFileSync(path.join(importedDir, "CLAUDE.md"), "utf8")).toContain("Be concise.");
    expect(fs.readFileSync(path.join(importedDir, "FINDINGS.md"), "utf8")).toContain("Finding alpha");
  });

  it("import rejects duplicate project without overwrite flag", async () => {
    const projectDir = path.join(tmp.path, "dup");
    fs.mkdirSync(projectDir, { recursive: true });
    writeFile(path.join(projectDir, "summary.md"), "# dup");

    register(server as any, makeCtx(tmp.path));

    const payload = { project: "dup", summary: "new content" };
    const res = parseResult(
      await server.call("import_project", { data: JSON.stringify(payload) })
    );
    expect(res.ok).toBe(false);
    expect(res.error).toContain("already exists");
  });

  it("import with overwrite replaces existing project", async () => {
    const projectDir = path.join(tmp.path, "overme");
    fs.mkdirSync(projectDir, { recursive: true });
    writeFile(path.join(projectDir, "summary.md"), "# old content");

    register(server as any, makeCtx(tmp.path));

    const payload = { project: "overme", overwrite: true, summary: "# replaced content" };
    const res = parseResult(
      await server.call("import_project", { data: JSON.stringify(payload) })
    );
    expect(res.ok).toBe(true);
    expect(fs.readFileSync(path.join(tmp.path, "overme", "summary.md"), "utf8")).toContain("replaced content");
  });

  it("export returns error for nonexistent project", async () => {
    register(server as any, makeCtx(tmp.path));
    const res = parseResult(await server.call("export_project", { project: "nope" }));
    expect(res.ok).toBe(false);
    expect(res.error).toContain("not found");
  });

  it("import rejects invalid JSON", async () => {
    register(server as any, makeCtx(tmp.path));
    const res = parseResult(await server.call("import_project", { data: "not json{" }));
    expect(res.ok).toBe(false);
    expect(res.error).toContain("Invalid JSON");
  });

  it("import rejects invalid project name", async () => {
    register(server as any, makeCtx(tmp.path));
    const res = parseResult(
      await server.call("import_project", { data: JSON.stringify({ project: "../escape" }) })
    );
    expect(res.ok).toBe(false);
    expect(res.error).toContain("Invalid project name");
  });

  it("import builds backlog content from structured data", async () => {
    register(server as any, makeCtx(tmp.path));

    const payload = {
      project: "backlog-test",
      backlog: {
        Active: [{ line: "Active task", checked: false }],
        Queue: [{ line: "Queued task", checked: false }],
        Done: [{ line: "Done task", checked: true }],
      },
    };
    const res = parseResult(
      await server.call("import_project", { data: JSON.stringify(payload) })
    );
    expect(res.ok).toBe(true);

    const backlog = fs.readFileSync(path.join(tmp.path, "backlog-test", "backlog.md"), "utf8");
    expect(backlog).toContain("- [ ] Active task");
    expect(backlog).toContain("- [ ] Queued task");
    expect(backlog).toContain("- [x] Done task");
  });

  it("import builds findings content from learnings array", async () => {
    register(server as any, makeCtx(tmp.path));

    const payload = {
      project: "learn-test",
      learnings: [{ text: "Always close DB connections" }, { text: "Use WAL mode" }],
    };
    const res = parseResult(
      await server.call("import_project", { data: JSON.stringify(payload) })
    );
    expect(res.ok).toBe(true);

    const findings = fs.readFileSync(path.join(tmp.path, "learn-test", "FINDINGS.md"), "utf8");
    expect(findings).toContain("Always close DB connections");
    expect(findings).toContain("Use WAL mode");
  });
});

describe("mcp-data: archive/unarchive", () => {
  let tmp: { path: string; cleanup: () => void };
  let server: ReturnType<typeof makeMockServer>;

  beforeEach(() => {
    tmp = makeTempDir("mcp-data-archive-");
    grantAdmin(tmp.path);
    server = makeMockServer();
  });

  afterEach(() => {
    delete process.env.CORTEX_ACTOR;
    tmp.cleanup();
  });

  it("archives a project by renaming to .archived suffix", async () => {
    const projectDir = path.join(tmp.path, "myproj");
    fs.mkdirSync(projectDir, { recursive: true });
    writeFile(path.join(projectDir, "summary.md"), "# myproj");

    register(server as any, makeCtx(tmp.path));

    const res = parseResult(await server.call("manage_project", { project: "myproj", action: "archive" }));
    expect(res.ok).toBe(true);
    expect(fs.existsSync(path.join(tmp.path, "myproj.archived"))).toBe(true);
    expect(fs.existsSync(projectDir)).toBe(false);
  });

  it("unarchives a project by restoring from .archived suffix", async () => {
    const archivedDir = path.join(tmp.path, "myproj.archived");
    fs.mkdirSync(archivedDir, { recursive: true });
    writeFile(path.join(archivedDir, "summary.md"), "# myproj");

    register(server as any, makeCtx(tmp.path));

    const res = parseResult(await server.call("manage_project", { project: "myproj", action: "unarchive" }));
    expect(res.ok).toBe(true);
    expect(fs.existsSync(path.join(tmp.path, "myproj"))).toBe(true);
    expect(fs.existsSync(archivedDir)).toBe(false);
  });

  it("archive then unarchive round-trip preserves data", async () => {
    const projectDir = path.join(tmp.path, "roundtrip");
    fs.mkdirSync(projectDir, { recursive: true });
    writeFile(path.join(projectDir, "summary.md"), "# roundtrip\nPersistent data.");

    register(server as any, makeCtx(tmp.path));

    const archiveRes = parseResult(await server.call("manage_project", { project: "roundtrip", action: "archive" }));
    expect(archiveRes.ok).toBe(true);

    const unarchiveRes = parseResult(await server.call("manage_project", { project: "roundtrip", action: "unarchive" }));
    expect(unarchiveRes.ok).toBe(true);

    const content = fs.readFileSync(path.join(tmp.path, "roundtrip", "summary.md"), "utf8");
    expect(content).toContain("Persistent data.");
  });

  it("archive fails for nonexistent project", async () => {
    register(server as any, makeCtx(tmp.path));
    const res = parseResult(await server.call("manage_project", { project: "nope", action: "archive" }));
    expect(res.ok).toBe(false);
    expect(res.error).toContain("not found");
  });

  it("unarchive fails when no archive exists", async () => {
    register(server as any, makeCtx(tmp.path));
    const res = parseResult(await server.call("manage_project", { project: "nope", action: "unarchive" }));
    expect(res.ok).toBe(false);
    expect(res.error).toContain("No archive found");
  });

  it("archive fails when .archived already exists", async () => {
    fs.mkdirSync(path.join(tmp.path, "dup"), { recursive: true });
    fs.mkdirSync(path.join(tmp.path, "dup.archived"), { recursive: true });

    register(server as any, makeCtx(tmp.path));
    const res = parseResult(await server.call("manage_project", { project: "dup", action: "archive" }));
    expect(res.ok).toBe(false);
    expect(res.error).toContain("already exists");
  });

  it("unarchive fails when active project already exists", async () => {
    fs.mkdirSync(path.join(tmp.path, "conflict"), { recursive: true });
    fs.mkdirSync(path.join(tmp.path, "conflict.archived"), { recursive: true });

    register(server as any, makeCtx(tmp.path));
    const res = parseResult(await server.call("manage_project", { project: "conflict", action: "unarchive" }));
    expect(res.ok).toBe(false);
    expect(res.error).toContain("already exists as an active project");
  });
});

describe("mcp-data: import rollback on rebuildIndex failure", () => {
  let tmp: { path: string; cleanup: () => void };
  let server: ReturnType<typeof makeMockServer>;

  beforeEach(() => {
    tmp = makeTempDir("mcp-data-rollback-");
    grantAdmin(tmp.path);
    server = makeMockServer();
  });

  afterEach(() => {
    delete process.env.CORTEX_ACTOR;
    tmp.cleanup();
  });

  it("import succeeds even when rebuildIndex throws (project dir is already moved)", async () => {
    const failingCtx = makeCtx(tmp.path, {
      rebuildIndex: async () => { throw new Error("index crash"); },
    });

    register(server as any, failingCtx);

    const payload = { project: "crash-test", summary: "# crash-test\nSome data." };
    // rebuildIndex is called after files are already in place, so the error propagates
    await expect(
      server.call("import_project", { data: JSON.stringify(payload) })
    ).rejects.toThrow("index crash");

    // The project directory was already moved into place before rebuildIndex
    expect(fs.existsSync(path.join(tmp.path, "crash-test"))).toBe(true);
  });
});
