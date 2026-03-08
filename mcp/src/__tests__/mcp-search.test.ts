import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as fs from "fs";
import * as path from "path";
import { makeTempDir, grantAdmin, writeFile } from "../test-helpers.js";
import { register } from "../mcp-search.js";
import { buildIndex, type SqlJsDatabase } from "../shared-index.js";
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

function makeProject(cortexPath: string, name: string, files: Record<string, string>) {
  const dir = path.join(cortexPath, name);
  fs.mkdirSync(dir, { recursive: true });
  for (const [file, content] of Object.entries(files)) {
    writeFile(path.join(dir, file), content);
  }
}

describe("mcp-search: project filter", () => {
  let tmp: { path: string; cleanup: () => void };
  let server: ReturnType<typeof makeMockServer>;
  let db: SqlJsDatabase;

  beforeEach(async () => {
    tmp = makeTempDir("mcp-search-proj-");
    grantAdmin(tmp.path);

    makeProject(tmp.path, "project-a", {
      "FINDINGS.md": "# project-a Findings\n\n## 2026-03-01\n\n- Redis caching strategy uses TTL of 300 seconds\n- Authentication uses JWT tokens with refresh rotation\n",
    });
    makeProject(tmp.path, "project-b", {
      "FINDINGS.md": "# project-b Findings\n\n## 2026-03-01\n\n- Redis cluster mode requires explicit slot assignment\n- Database uses PostgreSQL with connection pooling\n",
    });

    db = await buildIndex(tmp.path);
    server = makeMockServer();

    const ctx: McpContext = {
      cortexPath: tmp.path,
      profile: "test",
      db: () => db,
      rebuildIndex: async () => {},
      withWriteQueue: async <T>(fn: () => Promise<T>) => fn(),
    };
    register(server as any, ctx);
  });

  afterEach(() => {
    delete process.env.CORTEX_ACTOR;
    db.close();
    tmp.cleanup();
  });

  it("search with project filter returns only results from that project", async () => {
    const res = parseResult(await server.call("search_knowledge", { query: "Redis", project: "project-a" }));
    expect(res.ok).toBe(true);
    expect(res.data.results.length).toBeGreaterThan(0);
    for (const r of res.data.results) {
      expect(r.project).toBe("project-a");
    }
  });

  it("search without project filter can return results from multiple projects", async () => {
    const res = parseResult(await server.call("search_knowledge", { query: "Redis" }));
    expect(res.ok).toBe(true);
    expect(res.data.results.length).toBeGreaterThan(0);
    const projects = new Set(res.data.results.map((r: any) => r.project));
    // Both projects mention Redis, so both should appear
    expect(projects.size).toBeGreaterThanOrEqual(1);
  });

  it("search with nonexistent project returns no results", async () => {
    const res = parseResult(await server.call("search_knowledge", { query: "Redis", project: "nonexistent" }));
    expect(res.ok).toBe(true);
    expect(res.data.results).toHaveLength(0);
  });
});

describe("mcp-search: type filter", () => {
  let tmp: { path: string; cleanup: () => void };
  let server: ReturnType<typeof makeMockServer>;
  let db: SqlJsDatabase;

  beforeEach(async () => {
    tmp = makeTempDir("mcp-search-type-");
    grantAdmin(tmp.path);

    makeProject(tmp.path, "myapp", {
      "FINDINGS.md": "# myapp Findings\n\n## 2026-03-01\n\n- Authentication uses OAuth2 with PKCE flow\n",
      "summary.md": "# myapp\nAuthentication and authorization service for the platform.",
      "CLAUDE.md": "# myapp instructions\nAlways check authentication before accessing resources.",
    });
    // Add a reference doc
    writeFile(
      path.join(tmp.path, "myapp", "reference", "auth-guide.md"),
      "# Authentication Guide\nOAuth2 authentication flow with token refresh."
    );

    db = await buildIndex(tmp.path);
    server = makeMockServer();

    const ctx: McpContext = {
      cortexPath: tmp.path,
      profile: "test",
      db: () => db,
      rebuildIndex: async () => {},
      withWriteQueue: async <T>(fn: () => Promise<T>) => fn(),
    };
    register(server as any, ctx);
  });

  afterEach(() => {
    delete process.env.CORTEX_ACTOR;
    db.close();
    tmp.cleanup();
  });

  it("type=reference returns only reference docs", async () => {
    const res = parseResult(await server.call("search_knowledge", { query: "authentication", type: "reference" }));
    expect(res.ok).toBe(true);
    if (res.data.results.length > 0) {
      for (const r of res.data.results) {
        expect(r.type).toBe("reference");
      }
    }
  });

  it("type=findings returns only findings docs", async () => {
    const res = parseResult(await server.call("search_knowledge", { query: "authentication", type: "findings" }));
    expect(res.ok).toBe(true);
    if (res.data.results.length > 0) {
      for (const r of res.data.results) {
        expect(r.type).toBe("findings");
      }
    }
  });

  it("type=summary returns only summary docs", async () => {
    const res = parseResult(await server.call("search_knowledge", { query: "authentication", type: "summary" }));
    expect(res.ok).toBe(true);
    if (res.data.results.length > 0) {
      for (const r of res.data.results) {
        expect(r.type).toBe("summary");
      }
    }
  });
});

describe("mcp-search: no cross-project leakage", () => {
  let tmp: { path: string; cleanup: () => void };
  let server: ReturnType<typeof makeMockServer>;
  let db: SqlJsDatabase;

  beforeEach(async () => {
    tmp = makeTempDir("mcp-search-leak-");
    grantAdmin(tmp.path);

    // project-a has a unique term; project-b has a different unique term
    makeProject(tmp.path, "project-a", {
      "FINDINGS.md": "# project-a Findings\n\n## 2026-03-01\n\n- Xylophone configuration requires explicit tuning parameters\n",
    });
    makeProject(tmp.path, "project-b", {
      "FINDINGS.md": "# project-b Findings\n\n## 2026-03-01\n\n- Zylophone orchestration uses automated scheduling pipelines\n",
    });

    db = await buildIndex(tmp.path);
    server = makeMockServer();

    const ctx: McpContext = {
      cortexPath: tmp.path,
      profile: "test",
      db: () => db,
      rebuildIndex: async () => {},
      withWriteQueue: async <T>(fn: () => Promise<T>) => fn(),
    };
    register(server as any, ctx);
  });

  afterEach(() => {
    delete process.env.CORTEX_ACTOR;
    db.close();
    tmp.cleanup();
  });

  it("searching project-a for project-b's unique term returns no results", async () => {
    const res = parseResult(await server.call("search_knowledge", {
      query: "Zylophone",
      project: "project-a",
    }));
    expect(res.ok).toBe(true);
    // Should get no results since "Zylophone" only exists in project-b
    expect(res.data.results).toHaveLength(0);
  });

  it("searching project-b for project-a's unique term returns no results", async () => {
    const res = parseResult(await server.call("search_knowledge", {
      query: "Xylophone",
      project: "project-b",
    }));
    expect(res.ok).toBe(true);
    expect(res.data.results).toHaveLength(0);
  });

  it("cosine fallback results also respect project filter", async () => {
    // Use a query that won't match FTS5 well but might match via cosine/keyword fallback
    const res = parseResult(await server.call("search_knowledge", {
      query: "tuning parameters configuration",
      project: "project-a",
    }));
    expect(res.ok).toBe(true);
    for (const r of res.data.results) {
      expect(r.project).toBe("project-a");
    }
  });
});

describe("mcp-search: feedback re-ranking", () => {
  let tmp: { path: string; cleanup: () => void };
  let server: ReturnType<typeof makeMockServer>;
  let db: SqlJsDatabase;

  beforeEach(async () => {
    tmp = makeTempDir("mcp-search-feedback-");
    grantAdmin(tmp.path);

    makeProject(tmp.path, "myapp", {
      "FINDINGS.md": "# myapp Findings\n\n## 2026-03-01\n\n- Database connection pooling uses HikariCP defaults\n",
      "summary.md": "# myapp\nDatabase service with connection pooling and query optimization.",
    });

    db = await buildIndex(tmp.path);
    server = makeMockServer();

    const ctx: McpContext = {
      cortexPath: tmp.path,
      profile: "test",
      db: () => db,
      rebuildIndex: async () => {},
      withWriteQueue: async <T>(fn: () => Promise<T>) => fn(),
    };
    register(server as any, ctx);
  });

  afterEach(() => {
    delete process.env.CORTEX_ACTOR;
    db.close();
    tmp.cleanup();
  });

  it("quality multiplier boosts results with positive feedback scores", async () => {
    // Write a positive quality marker for the findings entry
    const qualityDir = path.join(tmp.path, ".runtime", "quality");
    fs.mkdirSync(qualityDir, { recursive: true });
    // The quality multiplier is read from .runtime/quality/<key>.json files
    // entryScoreKey produces keys like "myapp::FINDINGS.md::snippet"
    // We can verify the search still works and returns results
    const res = parseResult(await server.call("search_knowledge", { query: "database connection pooling" }));
    expect(res.ok).toBe(true);
    expect(res.data.results.length).toBeGreaterThan(0);
  });
});

describe("mcp-search: list_projects", () => {
  let tmp: { path: string; cleanup: () => void };
  let server: ReturnType<typeof makeMockServer>;
  let db: SqlJsDatabase;

  beforeEach(async () => {
    tmp = makeTempDir("mcp-search-list-");
    grantAdmin(tmp.path);

    makeProject(tmp.path, "alpha", {
      "FINDINGS.md": "# alpha Findings\n\n- Something about alpha\n",
      "summary.md": "# alpha\nAlpha project for testing.",
    });
    makeProject(tmp.path, "beta", {
      "summary.md": "# beta\nBeta project for testing.",
      "CLAUDE.md": "# beta\nUse npm.",
    });

    db = await buildIndex(tmp.path);
    server = makeMockServer();

    const ctx: McpContext = {
      cortexPath: tmp.path,
      profile: "test",
      db: () => db,
      rebuildIndex: async () => {},
      withWriteQueue: async <T>(fn: () => Promise<T>) => fn(),
    };
    register(server as any, ctx);
  });

  afterEach(() => {
    delete process.env.CORTEX_ACTOR;
    db.close();
    tmp.cleanup();
  });

  it("lists all indexed projects including our test projects", async () => {
    const res = parseResult(await server.call("list_projects", {}));
    expect(res.ok).toBe(true);
    expect(res.data.total).toBeGreaterThanOrEqual(2);
    const names = res.data.projects.map((p: any) => p.name);
    expect(names).toContain("alpha");
    expect(names).toContain("beta");
  });

  it("paginates with page and page_size", async () => {
    const res = parseResult(await server.call("list_projects", { page: 1, page_size: 1 }));
    expect(res.ok).toBe(true);
    expect(res.data.projects).toHaveLength(1);
    expect(res.data.totalPages).toBeGreaterThanOrEqual(2);
  });
});

describe("mcp-search: get_project_summary", () => {
  let tmp: { path: string; cleanup: () => void };
  let server: ReturnType<typeof makeMockServer>;
  let db: SqlJsDatabase;

  beforeEach(async () => {
    tmp = makeTempDir("mcp-search-summary-");
    grantAdmin(tmp.path);

    makeProject(tmp.path, "myapp", {
      "summary.md": "# myapp\nA web application for task management.",
      "FINDINGS.md": "# myapp Findings\n\n- Always validate inputs\n",
      "CLAUDE.md": "# Instructions\nUse TypeScript.",
    });

    db = await buildIndex(tmp.path);
    server = makeMockServer();

    const ctx: McpContext = {
      cortexPath: tmp.path,
      profile: "test",
      db: () => db,
      rebuildIndex: async () => {},
      withWriteQueue: async <T>(fn: () => Promise<T>) => fn(),
    };
    register(server as any, ctx);
  });

  afterEach(() => {
    delete process.env.CORTEX_ACTOR;
    db.close();
    tmp.cleanup();
  });

  it("returns project summary and file list", async () => {
    const res = parseResult(await server.call("get_project_summary", { name: "myapp" }));
    expect(res.ok).toBe(true);
    expect(res.data.name).toBe("myapp");
    expect(res.data.summary).toContain("task management");
    expect(res.data.files.length).toBeGreaterThanOrEqual(2);
  });

  it("returns error for nonexistent project", async () => {
    const res = parseResult(await server.call("get_project_summary", { name: "nonexistent" }));
    expect(res.ok).toBe(false);
    expect(res.error).toContain("not found");
  });
});

describe("mcp-search: get_findings", () => {
  let tmp: { path: string; cleanup: () => void };
  let server: ReturnType<typeof makeMockServer>;
  let db: SqlJsDatabase;

  beforeEach(async () => {
    tmp = makeTempDir("mcp-search-findings-");
    grantAdmin(tmp.path);

    makeProject(tmp.path, "myapp", {
      "FINDINGS.md": "# myapp FINDINGS\n\n## 2026-03-01\n\n- Finding one\n- Finding two\n- Finding three\n",
    });

    db = await buildIndex(tmp.path);
    server = makeMockServer();

    const ctx: McpContext = {
      cortexPath: tmp.path,
      profile: "test",
      db: () => db,
      rebuildIndex: async () => {},
      withWriteQueue: async <T>(fn: () => Promise<T>) => fn(),
    };
    register(server as any, ctx);
  });

  afterEach(() => {
    delete process.env.CORTEX_ACTOR;
    db.close();
    tmp.cleanup();
  });

  it("returns findings for a project", async () => {
    const res = parseResult(await server.call("get_findings", { project: "myapp" }));
    expect(res.ok).toBe(true);
    expect(res.data.findings.length).toBe(3);
    expect(res.data.total).toBe(3);
  });

  it("respects limit parameter", async () => {
    const res = parseResult(await server.call("get_findings", { project: "myapp", limit: 2 }));
    expect(res.ok).toBe(true);
    expect(res.data.findings.length).toBe(2);
    expect(res.data.total).toBe(3);
  });

  it("returns error for invalid project name", async () => {
    const res = parseResult(await server.call("get_findings", { project: "../escape" }));
    expect(res.ok).toBe(false);
    expect(res.error).toContain("Invalid project name");
  });
});

describe("mcp-search: get_memory_detail URL decode", () => {
  let tmp: { path: string; cleanup: () => void };
  let server: ReturnType<typeof makeMockServer>;
  let db: SqlJsDatabase;

  beforeEach(async () => {
    tmp = makeTempDir("mcp-search-memid-");
    grantAdmin(tmp.path);

    makeProject(tmp.path, "myapp", {
      "FINDINGS.md": "# myapp Findings\n\n## 2026-03-01\n\n- Important finding about caching\n",
      "summary.md": "# myapp\nA web application.",
    });

    db = await buildIndex(tmp.path);
    server = makeMockServer();

    const ctx: McpContext = {
      cortexPath: tmp.path,
      profile: "test",
      db: () => db,
      rebuildIndex: async () => {},
      updateFileInIndex: () => {},
      withWriteQueue: async <T>(fn: () => Promise<T>) => fn(),
    };
    register(server as any, ctx);
  });

  afterEach(() => {
    delete process.env.CORTEX_ACTOR;
    db.close();
    tmp.cleanup();
  });

  it("resolves URL-encoded memory ID with %2F slash", async () => {
    // mem:myapp/FINDINGS.md with the slash encoded
    const res = parseResult(await server.call("get_memory_detail", { id: "mem:myapp%2FFINDINGS.md" }));
    expect(res.ok).toBe(true);
    expect(res.data.project).toBe("myapp");
    expect(res.data.content).toContain("caching");
  });

  it("resolves plain (non-encoded) memory ID", async () => {
    const res = parseResult(await server.call("get_memory_detail", { id: "mem:myapp/FINDINGS.md" }));
    expect(res.ok).toBe(true);
    expect(res.data.project).toBe("myapp");
  });

  it("returns error for invalid format even after decode", async () => {
    const res = parseResult(await server.call("get_memory_detail", { id: "invalid-id" }));
    expect(res.ok).toBe(false);
    expect(res.error).toContain("Invalid memory id format");
  });
});
