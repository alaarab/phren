import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { SqlJsDatabase } from "../shared-index.js";
import type { McpContext } from "../mcp-types.js";
import { makeTempDir, grantAdmin } from "../test-helpers.js";
import { register } from "../mcp-session.js";

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

describe("mcp-session tool contract", () => {
  let tmp: { path: string; cleanup: () => void };
  let server: ReturnType<typeof makeMockServer>;
  let db: SqlJsDatabase;

  beforeEach(() => {
    tmp = makeTempDir("mcp-session-tools-");
    grantAdmin(tmp.path);
    db = makeEmptyDb();
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
    db.close();
    tmp.cleanup();
  });

  it("rejects session_context and session_end calls without explicit identity", async () => {
    const started = parseResult(await server.call("session_start", { project: "demo" }));
    expect(started.ok).toBe(true);

    const contextRes = parseResult(await server.call("session_context", {}));
    expect(contextRes.ok).toBe(false);
    expect(contextRes.error).toContain("sessionId or connectionId");

    const endRes = parseResult(await server.call("session_end", {}));
    expect(endRes.ok).toBe(false);
    expect(endRes.error).toContain("sessionId or connectionId");
  });

  it("resolves session_context and session_end via connectionId binding", async () => {
    const started = parseResult(await server.call("session_start", { project: "demo", connectionId: "conn-1" }));
    expect(started.ok).toBe(true);

    const contextRes = parseResult(await server.call("session_context", { connectionId: "conn-1" }));
    expect(contextRes.ok).toBe(true);
    expect(contextRes.data.project).toBe("demo");

    const endRes = parseResult(await server.call("session_end", { connectionId: "conn-1", summary: "wrapped up" }));
    expect(endRes.ok).toBe(true);

    const afterEnd = parseResult(await server.call("session_context", { connectionId: "conn-1" }));
    expect(afterEnd.ok).toBe(false);
    expect(afterEnd.error).toContain("No active session");
  });

  it("ends sessions cleanly when the explicit sessionId is provided", async () => {
    const started = parseResult(await server.call("session_start", { project: "demo" }));
    expect(started.ok).toBe(true);

    const endRes = parseResult(await server.call("session_end", { sessionId: started.data.sessionId, summary: "done" }));
    expect(endRes.ok).toBe(true);
    expect(endRes.data.sessionId).toBe(started.data.sessionId);
  });
});
