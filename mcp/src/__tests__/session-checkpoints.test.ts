import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as fs from "fs";
import * as path from "path";
import type { SqlJsDatabase } from "../shared-index.js";
import type { McpContext } from "../mcp-types.js";
import { makeTempDir, grantAdmin } from "../test-helpers.js";
import { register as registerSession } from "../mcp-session.js";
import { register as registerTasks } from "../mcp-tasks.js";
import { checkpointPath, clearTaskCheckpoint, listTaskCheckpoints, writeTaskCheckpoint } from "../session-checkpoints.js";

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

describe("session-checkpoints", () => {
  let tmp: { path: string; cleanup: () => void };
  let server: ReturnType<typeof makeMockServer>;
  let db: SqlJsDatabase;

  beforeEach(() => {
    tmp = makeTempDir("session-checkpoints-");
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

    registerSession(server as any, ctx);
    registerTasks(server as any, ctx);
  });

  afterEach(() => {
    db.close();
    tmp.cleanup();
  });

  it("writes checkpoint on session_end when an active task exists", async () => {
    const demoDir = path.join(tmp.path, "demo");
    fs.mkdirSync(demoDir, { recursive: true });
    fs.writeFileSync(
      path.join(demoDir, "tasks.md"),
      [
        "# demo tasks",
        "",
        "## Active",
        "",
        "- [ ] Fix flaky test ordering <!-- bid:abc123ef -->",
        "",
        "## Queue",
        "",
        "## Done",
        "",
      ].join("\n"),
      "utf8",
    );

    const started = parseResult(await server.call("session_start", { project: "demo" }));
    const ended = parseResult(await server.call("session_end", {
      sessionId: started.data.sessionId,
      summary: "Reproduced the failure\nNext step: stabilize sort order",
    }));

    expect(ended.ok).toBe(true);

    const file = checkpointPath(tmp.path, "demo", "abc123ef");
    expect(fs.existsSync(file)).toBe(true);
    const checkpoint = JSON.parse(fs.readFileSync(file, "utf8")) as { taskText?: string; resumptionHint: { nextStep: string } };
    expect(checkpoint.taskText).toContain("Fix flaky test ordering");
    expect(checkpoint.resumptionHint.nextStep).toContain("stabilize sort order");
  });

  it("shows saved checkpoints in the next session_start context", async () => {
    writeTaskCheckpoint(tmp.path, {
      project: "demo",
      taskId: "deadbeef",
      taskLine: "Improve cache invalidation",
      createdAt: new Date().toISOString(),
      resumptionHint: {
        lastAttempt: "Added invalidation hooks",
        nextStep: "cover edge cases for stale reads",
      },
      gitStatus: "M mcp/src/cache.ts",
      editedFiles: ["mcp/src/cache.ts"],
      failingTests: ["cache invalidation preserves consistency"],
    });

    const started = parseResult(await server.call("session_start", { project: "demo" }));
    expect(started.ok).toBe(true);
    expect(started.message).toContain("Continue where you left off?");
    expect(started.message).toContain("Improve cache invalidation");
    expect(started.message).toContain("cover edge cases for stale reads");
  });

  it("cleans up checkpoint when complete_task resolves the task", async () => {
    const demoDir = path.join(tmp.path, "demo");
    fs.mkdirSync(demoDir, { recursive: true });
    fs.writeFileSync(
      path.join(demoDir, "tasks.md"),
      [
        "# demo tasks",
        "",
        "## Active",
        "",
        "- [ ] Improve cache invalidation <!-- bid:deadbeef -->",
        "",
        "## Queue",
        "",
        "## Done",
        "",
      ].join("\n"),
      "utf8",
    );

    writeTaskCheckpoint(tmp.path, {
      project: "demo",
      taskId: "deadbeef",
      taskLine: "Improve cache invalidation",
      createdAt: new Date().toISOString(),
      resumptionHint: {
        lastAttempt: "Partial implementation",
        nextStep: "finish edge-case handling",
      },
      gitStatus: "",
      editedFiles: [],
      failingTests: [],
    });

    const cp = checkpointPath(tmp.path, "demo", "deadbeef");
    expect(fs.existsSync(cp)).toBe(true);

    const completed = parseResult(await server.call("complete_task", { project: "demo", item: "cache invalidation" }));
    expect(completed.ok).toBe(true);
    expect(fs.existsSync(cp)).toBe(false);
  });

  it("lists and clears checkpoint records via session-checkpoints module helpers", () => {
    writeTaskCheckpoint(tmp.path, {
      project: "demo",
      taskId: "task1",
      taskLine: "Task one",
      createdAt: new Date().toISOString(),
      resumptionHint: { lastAttempt: "A", nextStep: "B" },
      gitStatus: "",
      editedFiles: [],
      failingTests: [],
    });
    writeTaskCheckpoint(tmp.path, {
      project: "demo",
      taskId: "task2",
      taskLine: "Task two",
      createdAt: new Date().toISOString(),
      resumptionHint: { lastAttempt: "C", nextStep: "D" },
      gitStatus: "",
      editedFiles: [],
      failingTests: [],
    });

    const listed = listTaskCheckpoints(tmp.path, "demo");
    expect(listed.map((item) => item.taskId).sort()).toEqual(["task1", "task2"]);

    const removed = clearTaskCheckpoint(tmp.path, { project: "demo", taskId: "task1" });
    expect(removed).toBe(1);

    const remaining = listTaskCheckpoints(tmp.path, "demo");
    expect(remaining).toHaveLength(1);
    expect(remaining[0].taskId).toBe("task2");
  });
});
