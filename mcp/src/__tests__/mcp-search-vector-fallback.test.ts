import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SqlJsDatabase } from "../shared-index.js";
import type { McpContext } from "../mcp-types.js";

vi.mock("../shared-search-fallback.js", async () => {
  const actual = await vi.importActual<typeof import("../shared-search-fallback.js")>("../shared-search-fallback.js");
  return {
    ...actual,
    vectorFallback: vi.fn(),
  };
});

import { register } from "../mcp-search.js";
import { vectorFallback } from "../shared-search-fallback.js";
import { makeTempDir, grantAdmin } from "../test-helpers.js";

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

function makeEmptyDb(): SqlJsDatabase {
  return {
    run: () => {},
    exec: () => [],
    export: () => new Uint8Array(),
    close: () => {},
  };
}

describe("mcp-search vector fallback", () => {
  let tmp: { path: string; cleanup: () => void };
  let server: ReturnType<typeof makeMockServer>;
  let db: SqlJsDatabase;

  beforeEach(() => {
    tmp = makeTempDir("mcp-search-vector-");
    grantAdmin(tmp.path);
    db = makeEmptyDb();
    server = makeMockServer();

    const ctx: McpContext = {
      cortexPath: tmp.path,
      profile: "test",
      db: () => db,
      rebuildIndex: async () => {},
      withWriteQueue: async <T>(fn: () => Promise<T>) => fn(),
    };

    register(server as any, ctx);
    vi.clearAllMocks();
  });

  afterEach(() => {
    db.close();
    tmp.cleanup();
  });

  it("rescues zero-result searches with persistent vector fallback", async () => {
    vi.mocked(vectorFallback).mockResolvedValue([
      {
        project: "proj",
        filename: "FINDINGS.md",
        type: "findings",
        content: "Webhook delivery for monitor alerts can post to an external URL instead of Discord.",
        path: `${tmp.path}/proj/FINDINGS.md`,
      },
    ]);

    const res = parseResult(await server.call("search_knowledge", { query: "alerts to external webhook instead of discord" }));
    expect(res.ok).toBe(true);
    expect(vectorFallback).toHaveBeenCalledOnce();
    expect(res.data.results).toHaveLength(1);
    expect(res.data.results[0].project).toBe("proj");
  });

  it("retries with a relaxed lexical query before invoking vector fallback", async () => {
    db.exec = (sql: string, params?: unknown[]) => {
      if (!sql.includes("MATCH")) return [];
      const query = String(params?.[0] ?? "");
      if (!query.includes(" OR ")) return [];
      return [{
        columns: ["project", "filename", "type", "content", "path"],
        values: [[
          "cortex",
          "FINDINGS.md",
          "findings",
          "Semantic opt-in during init should finish at the dependency level",
          `${tmp.path}cortex/FINDINGS.md`,
        ]],
      }];
    };

    const res = parseResult(await server.call("search_knowledge", { query: "semantic search setup during init with ollama" }));
    expect(res.ok).toBe(true);
    expect(vectorFallback).not.toHaveBeenCalled();
    expect(res.data.results).toHaveLength(1);
    expect(res.data.results[0].project).toBe("cortex");
  });

  it("applies type filters to vector fallback results", async () => {
    vi.mocked(vectorFallback).mockResolvedValue([
      {
        project: "proj",
        filename: "FINDINGS.md",
        type: "findings",
        content: "finding content",
        path: `${tmp.path}/proj/FINDINGS.md`,
      },
      {
        project: "proj",
        filename: "summary.md",
        type: "summary",
        content: "summary content",
        path: `${tmp.path}/proj/summary.md`,
      },
    ]);

    const res = parseResult(await server.call("search_knowledge", { query: "semantic summary", type: "summary" }));
    expect(res.ok).toBe(true);
    expect(vectorFallback).toHaveBeenCalledOnce();
    expect(res.data.results).toHaveLength(1);
    expect(res.data.results[0].type).toBe("summary");
  });
});
