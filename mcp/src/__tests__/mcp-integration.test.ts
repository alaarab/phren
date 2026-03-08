import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as fs from "fs";
import * as path from "path";
import { makeTempDir, grantAdmin, writeFile } from "../test-helpers.js";
import { buildIndex, updateFileInIndex, type SqlJsDatabase } from "../shared-index.js";
import { register as registerSearch } from "../mcp-search.js";
import { register as registerFinding } from "../mcp-finding.js";
import { register as registerBacklog } from "../mcp-backlog.js";
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

describe("MCP integration: add_finding -> search_knowledge round-trip", () => {
  let tmp: { path: string; cleanup: () => void };
  let server: ReturnType<typeof makeMockServer>;
  let db: SqlJsDatabase;

  beforeEach(async () => {
    tmp = makeTempDir("mcp-integ-");
    grantAdmin(tmp.path);
    makeProject(tmp.path, "integ-proj", {
      "summary.md": "# integ-proj\nIntegration test project.",
    });

    db = await buildIndex(tmp.path);
    server = makeMockServer();

    const ctx: McpContext = {
      cortexPath: tmp.path,
      profile: "test",
      db: () => db,
      rebuildIndex: async () => {
        db.close();
        db = await buildIndex(tmp.path);
      },
      updateFileInIndex: () => {},
      withWriteQueue: async <T>(fn: () => Promise<T>) => fn(),
    };
    registerSearch(server as any, ctx);
    registerFinding(server as any, ctx);
    registerBacklog(server as any, ctx);
  });

  afterEach(() => {
    delete process.env.CORTEX_ACTOR;
    db.close();
    tmp.cleanup();
  });

  it("add_finding then search_knowledge finds the finding", async () => {
    const addRes = parseResult(await server.call("add_finding", {
      project: "integ-proj",
      finding: "Xylophone tuning requires precise frequency calibration at 440Hz",
    }));
    expect(addRes.ok).toBe(true);

    // Rebuild index to include the new finding
    db.close();
    db = await buildIndex(tmp.path);

    const searchRes = parseResult(await server.call("search_knowledge", {
      query: "Xylophone tuning frequency",
    }));
    expect(searchRes.ok).toBe(true);
    expect(searchRes.data.results.length).toBeGreaterThan(0);
    const texts = searchRes.data.results.map((r: any) => r.snippet || r.text || "").join(" ");
    expect(texts.toLowerCase()).toContain("xylophone");
  });

  it("add_finding then remove_finding then search verifies removal", async () => {
    const addRes = parseResult(await server.call("add_finding", {
      project: "integ-proj",
      finding: "Zygomorphic algorithm requires O(n log n) time complexity analysis",
    }));
    expect(addRes.ok).toBe(true);

    const removeRes = parseResult(await server.call("remove_finding", {
      project: "integ-proj",
      finding: "Zygomorphic",
    }));
    expect(removeRes.ok).toBe(true);

    // Rebuild index after removal
    db.close();
    db = await buildIndex(tmp.path);

    const searchRes = parseResult(await server.call("search_knowledge", {
      query: "Zygomorphic algorithm",
      project: "integ-proj",
    }));
    expect(searchRes.ok).toBe(true);
    // Should have no results or result should not contain the removed finding
    const matchingResults = searchRes.data.results.filter(
      (r: any) => (r.snippet || r.text || "").toLowerCase().includes("zygomorphic")
    );
    expect(matchingResults).toHaveLength(0);
  });

  it("backlog round-trip: add -> get -> complete -> get", async () => {
    const addRes = parseResult(await server.call("add_backlog_item", {
      project: "integ-proj",
      item: "Implement xylophone frequency calibration module",
    }));
    expect(addRes.ok).toBe(true);

    const getRes1 = parseResult(await server.call("get_backlog", {
      project: "integ-proj",
    }));
    expect(getRes1.ok).toBe(true);
    const queueItems = getRes1.data.items?.Queue || [];
    const found = queueItems.some((i: any) => (i.line || "").includes("xylophone"));
    expect(found).toBe(true);

    const completeRes = parseResult(await server.call("complete_backlog_item", {
      project: "integ-proj",
      item: "xylophone frequency",
    }));
    expect(completeRes.ok).toBe(true);

    const getRes2 = parseResult(await server.call("get_backlog", {
      project: "integ-proj",
      status: "all",
    }));
    expect(getRes2.ok).toBe(true);
    const doneItems = getRes2.data.items?.Done || [];
    const foundDone = doneItems.some((i: any) => (i.line || "").includes("xylophone"));
    expect(foundDone).toBe(true);
  });

  it("add_finding with invalid project returns ok: false", async () => {
    const res = parseResult(await server.call("add_finding", {
      project: "../escape",
      finding: "Should fail",
    }));
    expect(res.ok).toBe(false);
  });
});

describe("MCP integration: backlog immediately searchable after add", () => {
  let tmp: { path: string; cleanup: () => void };
  let server: ReturnType<typeof makeMockServer>;
  let db: SqlJsDatabase;

  beforeEach(async () => {
    tmp = makeTempDir("mcp-backlog-search-");
    grantAdmin(tmp.path);
    const dir = path.join(tmp.path, "search-proj");
    fs.mkdirSync(dir, { recursive: true });
    writeFile(path.join(dir, "summary.md"), "# search-proj\nSearch visibility test project.");

    db = await buildIndex(tmp.path);
    server = makeMockServer();

    const ctx: McpContext = {
      cortexPath: tmp.path,
      profile: "test",
      db: () => db,
      rebuildIndex: async () => {
        db.close();
        db = await buildIndex(tmp.path);
      },
      updateFileInIndex: (filePath: string) => {
        try { updateFileInIndex(db, filePath, tmp.path); } catch { /* best effort */ }
      },
      withWriteQueue: async <T>(fn: () => Promise<T>) => fn(),
    };
    registerSearch(server as any, ctx);
    registerBacklog(server as any, ctx);
  });

  afterEach(() => {
    delete process.env.CORTEX_ACTOR;
    db.close();
    tmp.cleanup();
  });

  it("add_backlog_item is visible to search_knowledge after index refresh", async () => {
    const addRes = parseResult(await server.call("add_backlog_item", {
      project: "search-proj",
      item: "Implement zymurgy fermentation tracking algorithm for brew optimization",
    }));
    expect(addRes.ok).toBe(true);

    // Rebuild to guarantee visibility (tests the add → file write → index round-trip)
    db.close();
    db = await buildIndex(tmp.path);

    const searchRes = parseResult(await server.call("search_knowledge", {
      query: "zymurgy fermentation",
      project: "search-proj",
    }));
    expect(searchRes.ok).toBe(true);
    expect(searchRes.data.results.length).toBeGreaterThan(0);
    const texts = searchRes.data.results.map((r: any) => r.snippet || r.text || "").join(" ");
    expect(texts.toLowerCase()).toContain("zymurgy");
  });
});
