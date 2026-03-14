import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { makeTempDir, grantAdmin } from "../test-helpers.js";
import { persistMachineName } from "../machine-identity.js";
import { register } from "../mcp-ops.js";
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

// ── get_consolidation_status ─────────────────────────────────────────────────

describe("mcp-ops: get_consolidation_status", () => {
  let tmp: { path: string; cleanup: () => void };
  let server: ReturnType<typeof makeMockServer>;

  beforeEach(() => {
    tmp = makeTempDir("mcp-ops-consol-");
    grantAdmin(tmp.path);
    server = makeMockServer();

    const ctx: McpContext = {
      phrenPath: tmp.path,
      profile: "",
      db: () => { throw new Error("unused"); },
      rebuildIndex: async () => {},
      updateFileInIndex: () => {},
      withWriteQueue: async <T>(fn: () => Promise<T>) => fn(),
    };
    register(server as any, ctx);
  });

  afterEach(() => {
    delete process.env.PHREN_ACTOR;
    tmp.cleanup();
  });

  it("returns recommended:true with 30 entries after consolidated marker", async () => {
    const projectDir = path.join(tmp.path, "testapp");
    fs.mkdirSync(projectDir, { recursive: true });
    fs.writeFileSync(path.join(projectDir, "summary.md"), "# testapp\n");

    const bullets = Array.from({ length: 30 }, (_, i) => `- Finding number ${i + 1}`);
    const content = [
      "# testapp Findings",
      "",
      "<!-- consolidated: 2026-01-01 -->",
      "",
      "## 2026-02-01",
      "",
      ...bullets,
      "",
    ].join("\n");
    fs.writeFileSync(path.join(projectDir, "FINDINGS.md"), content);

    const res = parseResult(await server.call("get_consolidation_status", { project: "testapp" }));
    expect(res.ok).toBe(true);
    expect(res.data.results).toHaveLength(1);
    const status = res.data.results[0];
    expect(status.project).toBe("testapp");
    expect(status.entriesSince).toBe(30);
    expect(status.recommended).toBe(true);
    expect(status.lastConsolidated).toBe("2026-01-01");
    expect(status.threshold).toBe(25);
  });

  it("returns recommended:false for empty FINDINGS.md", async () => {
    const projectDir = path.join(tmp.path, "emptyapp");
    fs.mkdirSync(projectDir, { recursive: true });
    fs.writeFileSync(path.join(projectDir, "summary.md"), "# emptyapp\n");
    fs.writeFileSync(path.join(projectDir, "FINDINGS.md"), "# emptyapp Findings\n");

    const res = parseResult(await server.call("get_consolidation_status", { project: "emptyapp" }));
    expect(res.ok).toBe(true);
    expect(res.data.results).toHaveLength(1);
    const status = res.data.results[0];
    expect(status.entriesSince).toBe(0);
    expect(status.recommended).toBe(false);
  });

  it("counts all entries when no consolidated marker exists", async () => {
    const projectDir = path.join(tmp.path, "nomarker");
    fs.mkdirSync(projectDir, { recursive: true });
    fs.writeFileSync(path.join(projectDir, "summary.md"), "# nomarker\n");

    const bullets = Array.from({ length: 10 }, (_, i) => `- Entry ${i + 1}`);
    const content = [
      "# nomarker Findings",
      "",
      "## 2026-01-15",
      "",
      ...bullets,
      "",
    ].join("\n");
    fs.writeFileSync(path.join(projectDir, "FINDINGS.md"), content);

    const res = parseResult(await server.call("get_consolidation_status", { project: "nomarker" }));
    expect(res.ok).toBe(true);
    const status = res.data.results[0];
    expect(status.entriesSince).toBe(10);
    expect(status.lastConsolidated).toBeNull();
    // 10 < 25 threshold, so not recommended
    expect(status.recommended).toBe(false);
  });

  it("returns error for nonexistent project", async () => {
    const res = parseResult(await server.call("get_consolidation_status", { project: "nonexistent" }));
    expect(res.ok).toBe(false);
    expect(res.error).toContain("not found");
  });
});

// ── get_review_queue ─────────────────────────────────────────────────────────

describe("mcp-ops: get_review_queue", () => {
  let tmp: { path: string; cleanup: () => void };
  let server: ReturnType<typeof makeMockServer>;

  beforeEach(() => {
    tmp = makeTempDir("mcp-ops-queue-");
    grantAdmin(tmp.path);
    server = makeMockServer();

    const ctx: McpContext = {
      phrenPath: tmp.path,
      profile: "",
      db: () => { throw new Error("unused"); },
      rebuildIndex: async () => {},
      updateFileInIndex: () => {},
      withWriteQueue: async <T>(fn: () => Promise<T>) => fn(),
    };
    register(server as any, ctx);
  });

  afterEach(() => {
    tmp.cleanup();
  });

  it("returns queue items for a single project with project metadata", async () => {
    const alphaDir = path.join(tmp.path, "alpha");
    fs.mkdirSync(alphaDir, { recursive: true });
    fs.writeFileSync(
      path.join(alphaDir, "review.md"),
      [
        "# alpha Review Queue",
        "",
        "## Review",
        "",
        "- [2026-03-10] alpha item [confidence 0.82]",
        "",
        "## Stale",
        "",
        "## Conflicts",
        "",
      ].join("\n"),
    );

    const res = parseResult(await server.call("get_review_queue", { project: "alpha" }));
    expect(res.ok).toBe(true);
    expect(res.data.items).toHaveLength(1);
    expect(res.data.items[0].project).toBe("alpha");
    expect(res.data.items[0].text).toContain("alpha item");
  });

  it("aggregates review queue items across all projects when project is omitted", async () => {
    const alphaDir = path.join(tmp.path, "alpha");
    const bravoDir = path.join(tmp.path, "bravo");
    fs.mkdirSync(alphaDir, { recursive: true });
    fs.mkdirSync(bravoDir, { recursive: true });
    fs.writeFileSync(
      path.join(alphaDir, "review.md"),
      [
        "# alpha Review Queue",
        "",
        "## Review",
        "",
        "- [2026-03-10] alpha review",
        "",
        "## Stale",
        "",
        "## Conflicts",
        "",
      ].join("\n"),
    );
    fs.writeFileSync(
      path.join(bravoDir, "review.md"),
      [
        "# bravo Review Queue",
        "",
        "## Review",
        "",
        "## Stale",
        "",
        "- [2026-03-11] bravo stale",
        "",
        "## Conflicts",
        "",
      ].join("\n"),
    );

    const res = parseResult(await server.call("get_review_queue", {}));
    expect(res.ok).toBe(true);
    expect(res.data.items).toHaveLength(2);
    expect(res.data.items.map((item: { project: string }) => item.project).sort()).toEqual(["alpha", "bravo"]);
  });
});

// ── health_check ─────────────────────────────────────────────────────────────

describe("mcp-ops: health_check", () => {
  let tmp: { path: string; cleanup: () => void };
  let server: ReturnType<typeof makeMockServer>;
  const origHome = process.env.HOME;
  const origUserProfile = process.env.USERPROFILE;

  beforeEach(() => {
    tmp = makeTempDir("mcp-ops-health-");
    grantAdmin(tmp.path);
    const homeDir = path.join(tmp.path, "home");
    fs.mkdirSync(homeDir, { recursive: true });
    process.env.HOME = homeDir;
    process.env.USERPROFILE = homeDir;
    server = makeMockServer();

    const ctx: McpContext = {
      phrenPath: tmp.path,
      profile: "test-profile",
      db: () => { throw new Error("unused"); },
      rebuildIndex: async () => {},
      updateFileInIndex: () => {},
      withWriteQueue: async <T>(fn: () => Promise<T>) => fn(),
    };
    register(server as any, ctx);
  });

  afterEach(() => {
    delete process.env.PHREN_ACTOR;
    process.env.HOME = origHome;
    process.env.USERPROFILE = origUserProfile;
    tmp.cleanup();
  });

  it("returns ok:true with version string and does not throw", async () => {
    const res = parseResult(await server.call("health_check", {}));
    expect(res.ok).toBe(true);
    expect(typeof res.data.version).toBe("string");
    expect(res.data.version.length).toBeGreaterThan(0);
    expect(res.data.phrenPath).toBe(tmp.path);
    expect(typeof res.data.mcpEnabled).toBe("boolean");
    expect(typeof res.data.hooksEnabled).toBe("boolean");
    expect(typeof res.data.projectCount).toBe("number");
  });

  it("resolves active profile and machine at call time instead of stale ctx state", async () => {
    persistMachineName("alias-box");
    fs.mkdirSync(path.join(tmp.path, "profiles"), { recursive: true });
    fs.writeFileSync(
      path.join(tmp.path, "profiles", "personal.yaml"),
      "name: personal\nprojects:\n  - global\n  - alpha\n"
    );
    fs.writeFileSync(
      path.join(tmp.path, "profiles", "work.yaml"),
      "name: work\nprojects:\n  - global\n  - bravo\n  - charlie\n"
    );
    fs.writeFileSync(path.join(tmp.path, "machines.yaml"), `alias-box: work\n${os.hostname()}: personal\n`);
    for (const project of ["global", "alpha", "bravo", "charlie"]) {
      fs.mkdirSync(path.join(tmp.path, project), { recursive: true });
      fs.writeFileSync(path.join(tmp.path, project, "summary.md"), `# ${project}\n`);
    }

    const res = parseResult(await server.call("health_check", {}));
    expect(res.ok).toBe(true);
    expect(res.data.profile).toBe("work");
    expect(res.data.machine).toBe("alias-box");
    expect(res.data.projectCount).toBe(3);
  });
});

// ── add_project ─────────────────────────────────────────────────────────────

describe("mcp-ops: add_project", () => {
  let tmp: { path: string; cleanup: () => void };
  let server: ReturnType<typeof makeMockServer>;
  let repoDir: string;

  beforeEach(() => {
    tmp = makeTempDir("mcp-ops-add-project-");
    grantAdmin(tmp.path);
    server = makeMockServer();
    repoDir = path.join(tmp.path, "repo");
    fs.mkdirSync(path.join(repoDir, ".git"), { recursive: true });
    fs.mkdirSync(path.join(tmp.path, "profiles"), { recursive: true });
    fs.writeFileSync(path.join(tmp.path, "profiles", "personal.yaml"), "name: personal\nprojects:\n  - global\n");
    fs.writeFileSync(path.join(tmp.path, "profiles", "work.yaml"), "name: work\nprojects:\n  - global\n");

    const ctx: McpContext = {
      phrenPath: tmp.path,
      profile: "work",
      db: () => { throw new Error("unused"); },
      rebuildIndex: async () => {},
      updateFileInIndex: () => {},
      withWriteQueue: async <T>(fn: () => Promise<T>) => fn(),
    };
    register(server as any, ctx);
  });

  afterEach(() => {
    delete process.env.PHREN_ACTOR;
    tmp.cleanup();
  });

  it("adds a repo to the active profile by default", async () => {
    const res = parseResult(await server.call("add_project", { path: repoDir }));
    expect(res.ok).toBe(true);
    expect(res.data.project).toBe("repo");
    expect(res.data.ownership).toBe("phren-managed");
    expect(fs.readFileSync(path.join(tmp.path, "profiles", "work.yaml"), "utf8")).toContain("- repo");
    expect(fs.readFileSync(path.join(tmp.path, "profiles", "personal.yaml"), "utf8")).not.toContain("- repo");
  });

  it("accepts an explicit ownership mode", async () => {
    const externalRepo = path.join(tmp.path, "workspace", "repo-managed");
    fs.mkdirSync(path.join(externalRepo, ".git"), { recursive: true });
    fs.writeFileSync(path.join(externalRepo, "CLAUDE.md"), "# repo\n");

    const res = parseResult(await server.call("add_project", { path: externalRepo, ownership: "repo-managed" }));
    expect(res.ok).toBe(true);
    expect(res.data.ownership).toBe("repo-managed");
    expect(fs.existsSync(path.join(tmp.path, "repo-managed", "CLAUDE.md"))).toBe(false);
    expect(fs.readFileSync(path.join(tmp.path, "repo-managed", "phren.project.yaml"), "utf8")).toContain("ownership: repo-managed");
  });

  it("requires an explicit path", async () => {
    const res = parseResult(await server.call("add_project", {}));
    expect(res.ok).toBe(false);
    expect(res.error).toContain("Path is required");
  });
});

// ── list_hook_errors ─────────────────────────────────────────────────────────

describe("mcp-ops: list_hook_errors", () => {
  let tmp: { path: string; cleanup: () => void };
  let server: ReturnType<typeof makeMockServer>;

  beforeEach(() => {
    tmp = makeTempDir("mcp-ops-errors-");
    grantAdmin(tmp.path);
    server = makeMockServer();

    const ctx: McpContext = {
      phrenPath: tmp.path,
      profile: "",
      db: () => { throw new Error("unused"); },
      rebuildIndex: async () => {},
      updateFileInIndex: () => {},
      withWriteQueue: async <T>(fn: () => Promise<T>) => fn(),
    };
    register(server as any, ctx);
  });

  afterEach(() => {
    delete process.env.PHREN_ACTOR;
    tmp.cleanup();
  });

  it("returns error lines from debug.log", async () => {
    const rtDir = path.join(tmp.path, ".runtime");
    fs.mkdirSync(rtDir, { recursive: true });
    const logContent = [
      "[2026-03-01 10:00:00] info: index built successfully",
      "[2026-03-01 10:01:00] error: something failed in hook-prompt",
      "[2026-03-01 10:02:00] info: search completed",
      "[2026-03-01 10:03:00] error: ENOENT: file not found /tmp/missing.md",
      "[2026-03-01 10:04:00] info: session ended",
    ].join("\n");
    fs.writeFileSync(path.join(rtDir, "debug.log"), logContent);

    const res = parseResult(await server.call("list_hook_errors", {}));
    expect(res.ok).toBe(true);
    expect(res.data.errors).toHaveLength(2);
    expect(res.data.errors[0]).toContain("something failed");
    expect(res.data.errors[1]).toContain("ENOENT");
    expect(res.data.total).toBe(2);
  });

  it("returns helpful message when no debug.log exists", async () => {
    const res = parseResult(await server.call("list_hook_errors", {}));
    expect(res.ok).toBe(true);
    expect(res.data.errors).toHaveLength(0);
    expect(res.message).toContain("No error entries found");
    expect(res.message).toContain("PHREN_DEBUG=1");
  });

  it("respects limit parameter", async () => {
    const rtDir = path.join(tmp.path, ".runtime");
    fs.mkdirSync(rtDir, { recursive: true });
    const lines = Array.from({ length: 50 }, (_, i) => `[2026-03-01] error: failure ${i + 1}`);
    fs.writeFileSync(path.join(rtDir, "debug.log"), lines.join("\n"));

    const res = parseResult(await server.call("list_hook_errors", { limit: 5 }));
    expect(res.ok).toBe(true);
    expect(res.data.errors).toHaveLength(5);
    expect(res.data.total).toBe(50);
    // Should return the LAST 5 entries
    expect(res.data.errors[0]).toContain("failure 46");
    expect(res.data.errors[4]).toContain("failure 50");
  });
});
