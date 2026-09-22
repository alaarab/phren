import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as fs from "fs";
import * as path from "path";
import { makeTempDir, initTestPhrenRoot } from "../test-helpers.js";
import { createToolGate, type ToolHandler } from "../mcp/profile.js";
import { register as registerTask } from "./tasks.js";
import type { McpContext } from "./types.js";
import { readTasks, TASKS_FILENAME } from "../data/access.js";

const PROJECT = "demo";
const SAMPLE = `# demo

## Active

- [ ] original task line

## Queue

## Done
`;

let tmp: { path: string; cleanup: () => void };
let manage: ToolHandler;

const parse = (res: unknown) => JSON.parse((res as { content: { text: string }[] }).content[0].text);

beforeEach(() => {
  tmp = makeTempDir("tasks-composite-");
  initTestPhrenRoot(tmp.path);
  const projectDir = path.join(tmp.path, PROJECT);
  fs.mkdirSync(projectDir, { recursive: true });
  fs.writeFileSync(path.join(projectDir, TASKS_FILENAME), SAMPLE);
  const registered = new Map<string, { handler: ToolHandler }>();
  const gate = createToolGate({
    profile: "core",
    register: (name, _config, handler) => { registered.set(name, { handler }); },
  });
  const ctx: McpContext = {
    phrenPath: tmp.path,
    profile: "test",
    db: () => { throw new Error("not used"); },
    rebuildIndex: async () => {},
    updateFileInIndex: () => {},
    withWriteQueue: async <T>(fn: () => Promise<T>) => fn(),
  };
  registerTask(gate as never, ctx);
  gate.finish();
  manage = registered.get("manage_task")!.handler;
});

afterEach(() => {
  delete process.env.PHREN_ACTOR;
  tmp.cleanup();
});

function queueLines(): string[] {
  const after = readTasks(tmp.path, PROJECT);
  expect(after.ok).toBe(true);
  if (!after.ok) return [];
  return after.data.items.Queue.map((entry) => entry.line);
}

describe("manage_task action=update through the composite", () => {
  it("applies section, priority and text when updates arrives as an object", async () => {
    const res = parse(await manage({ action: "update", project: PROJECT, item: "original task", updates: { section: "Queue", priority: "high", text: "renamed task line" } }));
    expect(res.ok).toBe(true);
    const queue = queueLines();
    expect(queue).toHaveLength(1);
    expect(queue[0]).toContain("renamed task line");
    expect(queue[0]).toContain("[high]");
  });

  it("applies the same updates when the host passes them as a JSON string", async () => {
    const res = parse(await manage({ action: "update", project: PROJECT, item: "original task", updates: '{"section":"Queue","priority":"low"}' }));
    expect(res.ok).toBe(true);
    const queue = queueLines();
    expect(queue).toHaveLength(1);
    expect(queue[0]).toContain("original task line");
    expect(queue[0]).toContain("[low]");
  });

  it("reports a bad inner field of a JSON-string updates at that field", async () => {
    const res = parse(await manage({ action: "update", project: PROJECT, item: "original task", updates: '{"priority":"urgent"}' }));
    expect(res.ok).toBe(false);
    expect(res.issues[0].path).toBe("updates.priority");
    expect(res.issues[0].message).not.toMatch(/expected object, received string/);
    const after = readTasks(tmp.path, PROJECT);
    expect(after.ok).toBe(true);
    if (after.ok) expect(after.data.items.Active).toHaveLength(1);
  });
});
