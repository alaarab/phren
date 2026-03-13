import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as fs from "fs";
import * as path from "path";
import type { SqlJsDatabase } from "../shared-index.js";
import type { McpContext } from "../mcp-types.js";
import { makeTempDir, grantAdmin } from "../test-helpers.js";
import { register } from "../mcp-session.js";
import { register as registerTasks } from "../mcp-tasks.js";
import { writeTaskCheckpoint } from "../session-checkpoints.js";

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

  it("writes task checkpoints on session_end and surfaces them on next session_start", async () => {
    const demoDir = path.join(tmp.path, "demo");
    fs.mkdirSync(demoDir, { recursive: true });
    fs.writeFileSync(
      path.join(demoDir, "tasks.md"),
      [
        "# demo tasks",
        "",
        "## Active",
        "",
        "- [ ] Implement snapshot pipeline <!-- bid:abc123ef -->",
        "  Context: Wire checkpoint snapshot and summarize failing tests",
        "",
        "## Queue",
        "",
        "## Done",
        "",
      ].join("\n"),
      "utf8"
    );

    const started = parseResult(await server.call("session_start", { project: "demo" }));
    expect(started.ok).toBe(true);
    const ended = parseResult(await server.call("session_end", {
      sessionId: started.data.sessionId,
      summary: "Checkpoint writer added. Failing tests: mcp-session-tools checkpoint context\nNext step: Fix the checkpoint matcher",
    }));
    expect(ended.ok).toBe(true);

    const checkpointFile = path.join(tmp.path, ".sessions", "checkpoint-demo-abc123ef.json");
    expect(fs.existsSync(checkpointFile)).toBe(true);
    const checkpoint = JSON.parse(fs.readFileSync(checkpointFile, "utf8")) as {
      taskId: string;
      taskLine: string;
      taskText?: string;
      failingTests: string[];
      resumptionHint: { lastAttempt: string; nextStep: string };
    };
    expect(checkpoint.taskId).toBe("abc123ef");
    expect(checkpoint.taskLine).toContain("Implement snapshot pipeline");
    expect(checkpoint.taskText).toContain("Implement snapshot pipeline");
    expect(checkpoint.failingTests[0]).toContain("mcp-session-tools checkpoint context");
    expect(checkpoint.resumptionHint.lastAttempt).toContain("Checkpoint writer added.");
    expect(checkpoint.resumptionHint.nextStep).toContain("Fix the checkpoint matcher");

    const resumed = parseResult(await server.call("session_start", { project: "demo" }));
    expect(resumed.ok).toBe(true);
    expect(resumed.message).toContain("Continue where you left off?");
    expect(resumed.message).toContain("Implement snapshot pipeline");
  });

  it("removes checkpoint files when complete_task finishes the associated task", async () => {
    registerTasks(server as any, {
      cortexPath: tmp.path,
      profile: "test",
      db: () => db,
      rebuildIndex: async () => {},
      updateFileInIndex: () => {},
      withWriteQueue: async <T>(fn: () => Promise<T>) => fn(),
    });

    const demoDir = path.join(tmp.path, "demo");
    fs.mkdirSync(demoDir, { recursive: true });
    fs.writeFileSync(
      path.join(demoDir, "tasks.md"),
      [
        "# demo tasks",
        "",
        "## Active",
        "",
        "- [ ] Implement snapshot pipeline <!-- bid:deadbeef -->",
        "",
        "## Queue",
        "",
        "## Done",
        "",
      ].join("\n"),
      "utf8"
    );

    writeTaskCheckpoint(tmp.path, {
      project: "demo",
      taskId: "deadbeef",
      taskLine: "Implement snapshot pipeline",
      createdAt: new Date().toISOString(),
      resumptionHint: {
        lastAttempt: "Wrote baseline implementation",
        nextStep: "Fix failing assertions",
      },
      gitStatus: "M mcp/src/mcp-session.ts",
      editedFiles: ["mcp/src/mcp-session.ts"],
      failingTests: ["mcp-session-tools checkpoint context"],
    });

    const checkpointFile = path.join(tmp.path, ".sessions", "checkpoint-demo-deadbeef.json");
    expect(fs.existsSync(checkpointFile)).toBe(true);

    const completed = parseResult(await server.call("complete_task", { project: "demo", item: "snapshot pipeline" }));
    expect(completed.ok).toBe(true);
    expect(fs.existsSync(checkpointFile)).toBe(false);
  });
});
