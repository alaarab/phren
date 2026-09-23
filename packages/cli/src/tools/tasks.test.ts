import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as fs from "fs";
import * as path from "path";
import { makeTempDir, initTestPhrenRoot } from "../test-helpers.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
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

  it("moves the task when updates is { section: \"Queue\" }", async () => {
    const res = parse(await manage({ action: "update", project: PROJECT, item: "original task", updates: { section: "Queue" } }));
    expect(res.ok).toBe(true);
    expect(queueLines()).toEqual([expect.stringContaining("original task line")]);
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

const THREE = `# demo

## Active

- [ ] alpha one <!-- bid:aaaaaaaa -->
- [ ] beta two <!-- bid:bbbbbbbb -->
- [ ] gamma three <!-- bid:cccccccc -->

## Queue

## Done
`;

function doneLines(): string[] {
  const after = readTasks(tmp.path, PROJECT);
  expect(after.ok).toBe(true);
  if (!after.ok) return [];
  return after.data.items.Done.map((entry) => entry.line);
}

describe("manage_task action=complete through the composite", () => {
  beforeEach(() => {
    fs.writeFileSync(path.join(tmp.path, PROJECT, TASKS_FILENAME), THREE);
  });

  it("completes every item of an array, not the array as one string", async () => {
    const res = parse(await manage({ action: "complete", project: PROJECT, item: ["bid:aaaaaaaa", "bid:bbbbbbbb"] }));
    expect(res.ok).toBe(true);
    expect(res.data.completed).toEqual(["alpha one", "beta two"]);
    expect(doneLines().sort()).toEqual(["alpha one", "beta two"]);
  });

  it("completes every item when the host passes the array as a JSON string", async () => {
    const res = parse(await manage({ action: "complete", project: PROJECT, item: '["bid:aaaaaaaa", "bid:bbbbbbbb"]' }));
    expect(res.ok).toBe(true);
    expect(res.data.completed).toEqual(["alpha one", "beta two"]);
  });

  it("still takes a single plain string", async () => {
    const res = parse(await manage({ action: "complete", project: PROJECT, item: "bid:cccccccc" }));
    expect(res.ok).toBe(true);
    expect(doneLines()).toEqual(["gamma three"]);
  });
});

// The composite advertises only `action` and leaves every other argument
// untyped, so this runs the real MCP request path: the SDK validates the
// composite's own schema, then the gate dispatches with the target's schema.
describe("manage_task over the MCP wire", () => {
  let client: Client;

  beforeEach(async () => {
    fs.writeFileSync(path.join(tmp.path, PROJECT, TASKS_FILENAME), THREE);
    const server = new McpServer({ name: "phren-test", version: "0" });
    const register = server.registerTool.bind(server);
    const gate = createToolGate({ profile: "core", register: (name, config, handler) => register(name as never, config as never, handler as never) });
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
    const [serverSide, clientSide] = InMemoryTransport.createLinkedPair();
    await server.connect(serverSide);
    client = new Client({ name: "phren-test-client", version: "0" });
    await client.connect(clientSide);
  });

  afterEach(async () => {
    await client.close();
  });

  const call = async (args: Record<string, unknown>) => parse(await client.callTool({ name: "manage_task", arguments: args }));

  it("passes an array of items through as an array", async () => {
    const res = await call({ action: "complete", project: PROJECT, item: ["bid:aaaaaaaa", "bid:bbbbbbbb"] });
    expect(res.ok).toBe(true);
    expect(doneLines().sort()).toEqual(["alpha one", "beta two"]);
  });

  it("passes an updates object through as an object", async () => {
    const res = await call({ action: "update", project: PROJECT, item: "gamma", updates: { section: "Queue" } });
    expect(res.ok).toBe(true);
    expect(queueLines()).toEqual([expect.stringContaining("gamma three")]);
  });

  it("decodes the JSON strings a host sends for untyped arguments", async () => {
    const completed = await call({ action: "complete", project: PROJECT, item: '["bid:aaaaaaaa","bid:bbbbbbbb"]' });
    expect(completed.ok).toBe(true);
    expect(completed.data.completed).toEqual(["alpha one", "beta two"]);
    const updated = await call({ action: "update", project: PROJECT, item: "gamma", updates: '{"section":"Queue"}' });
    expect(updated.ok).toBe(true);
    expect(queueLines()).toEqual([expect.stringContaining("gamma three")]);
  });
});
