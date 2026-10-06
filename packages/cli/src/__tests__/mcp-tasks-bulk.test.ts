import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as fs from "fs";
import * as path from "path";
import { makeTempDir, grantAdmin } from "../test-helpers.js";
import { register } from "../tools/tasks.js";
import type { McpContext } from "../tools/types.js";
import { TASKS_FILENAME } from "../data/access.js";

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

const PROJECT = "testproj";

const SAMPLE_TASKS = `# testproj tasks

## Active

- [ ] Implement auth middleware [high]

## Queue

- [ ] Add rate limiting

## Done

`;

describe("add_task bulk (array): error field when nothing is added", () => {
  let tmp: { path: string; cleanup: () => void };
  let server: ReturnType<typeof makeMockServer>;

  beforeEach(() => {
    tmp = makeTempDir("mcp-tasks-bulk-add-");
    grantAdmin(tmp.path);
    const projectDir = path.join(tmp.path, PROJECT);
    fs.mkdirSync(projectDir, { recursive: true });
    fs.writeFileSync(path.join(projectDir, TASKS_FILENAME), SAMPLE_TASKS);

    const ctx: McpContext = {
      phrenPath: tmp.path,
      profile: "",
      db: () => { throw new Error("unused"); },
      rebuildIndex: async () => {},
      updateFileInIndex: () => {},
      withWriteQueue: async <T>(fn: () => Promise<T>) => fn(),
    };
    server = makeMockServer();
    register(server as any, ctx);
  });

  afterEach(() => {
    tmp.cleanup();
  });

  it("returns ok:false and an error field when all items are empty strings", async () => {
    const res = parseResult(
      await server.call("add_task", { project: PROJECT, item: ["", "   "] })
    );

    expect(res.ok).toBe(false);
    expect(typeof res.error).toBe("string");
    expect(res.error.length).toBeGreaterThan(0);
    expect(res.data.added).toHaveLength(0);
  });
});

describe("complete_task bulk (array): error field when nothing is completed", () => {
  let tmp: { path: string; cleanup: () => void };
  let server: ReturnType<typeof makeMockServer>;

  beforeEach(() => {
    tmp = makeTempDir("mcp-tasks-bulk-complete-");
    grantAdmin(tmp.path);
    const projectDir = path.join(tmp.path, PROJECT);
    fs.mkdirSync(projectDir, { recursive: true });
    fs.writeFileSync(path.join(projectDir, TASKS_FILENAME), SAMPLE_TASKS);

    const ctx: McpContext = {
      phrenPath: tmp.path,
      profile: "",
      db: () => { throw new Error("unused"); },
      rebuildIndex: async () => {},
      updateFileInIndex: () => {},
      withWriteQueue: async <T>(fn: () => Promise<T>) => fn(),
    };
    server = makeMockServer();
    register(server as any, ctx);
  });

  afterEach(() => {
    tmp.cleanup();
  });

  it("returns ok:false and an error field when no items match", async () => {
    const res = parseResult(
      await server.call("complete_task", {
        project: PROJECT,
        item: ["nonexistent-task-xyz-123", "another-nonexistent-abc"],
      })
    );

    expect(res.ok).toBe(false);
    expect(typeof res.error).toBe("string");
    expect(res.error.length).toBeGreaterThan(0);
  });
});
