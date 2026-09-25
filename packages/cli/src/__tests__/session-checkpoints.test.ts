import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { SqlJsDatabase } from "../shared/index.js";
import type { McpContext } from "../tools/types.js";
import { makeTempDir, grantAdmin } from "../test-helpers.js";
import { register as registerSession } from "../tools/session.js";
import { register as registerTasks } from "../tools/tasks.js";
import { clearTaskCheckpoint, listTaskCheckpoints, writeTaskCheckpoint } from "../session/checkpoints.js";

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
      phrenPath: tmp.path,
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
