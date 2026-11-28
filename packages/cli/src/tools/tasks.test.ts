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
import { TASKS_FILENAME } from "../data/access.js";
import { TASKS_RETIRED_CODE, TASKS_RETIRED_MESSAGE } from "../task/retired.js";

const PROJECT = "demo";
const SAMPLE = `# demo

## Active

- [ ] original task line

## Queue

## Done
`;

let tmp: { path: string; cleanup: () => void };
let tools: Map<string, ToolHandler>;
const taskFile = () => path.join(tmp.path, PROJECT, TASKS_FILENAME);

const parse = (res: unknown) => JSON.parse((res as { content: { text: string }[] }).content[0].text);

function context(): McpContext {
  return {
    phrenPath: tmp.path,
    profile: "test",
    db: () => { throw new Error("not used"); },
    rebuildIndex: async () => {},
    updateFileInIndex: () => {},
    withWriteQueue: async <T>(fn: () => Promise<T>) => fn(),
  };
}

beforeEach(() => {
  tmp = makeTempDir("tasks-retired-");
  initTestPhrenRoot(tmp.path);
  const projectDir = path.join(tmp.path, PROJECT);
  fs.mkdirSync(projectDir, { recursive: true });
  fs.writeFileSync(path.join(projectDir, TASKS_FILENAME), SAMPLE);
  tools = new Map();
  const gate = createToolGate({
    profile: "core",
    register: (name, _config, handler) => { tools.set(name, handler); },
  });
  registerTask(gate as never, context());
  gate.finish();
  tools = new Map([...gate.catalog].map(([name, entry]) => [name, entry.handler]));
});

afterEach(() => tmp.cleanup());

const WRITES: { name: string; args: Record<string, unknown> }[] = [
  { name: "add_task", args: { project: PROJECT, item: "a new task" } },
  { name: "complete_task", args: { project: PROJECT, item: "original task" } },
  { name: "remove_task", args: { project: PROJECT, item: "original task" } },
  { name: "update_task", args: { project: PROJECT, item: "original task", updates: { text: "changed task" } } },
  { name: "tidy_done_tasks", args: { project: PROJECT, keep: 0 } },
  { name: "claim_task", args: { project: PROJECT, item: "original task" } },
  { name: "pin_task", args: { project: PROJECT, item: "original task" } },
];

describe("task tools are read-only", () => {
  it.each(WRITES)("$name returns tasks-retired and leaves tasks.md untouched", async ({ name, args }) => {
    const res = parse(await tools.get(name)!(args));
    expect(res.ok).toBe(false);
    expect(res.errorCode).toBe(TASKS_RETIRED_CODE);
    expect(res.error).toBe(TASKS_RETIRED_MESSAGE);
    expect(res.data).toBeUndefined();
    expect(fs.readFileSync(taskFile(), "utf8")).toBe(SAMPLE);
  });

  it.each([
    { action: "complete", args: { item: "original task" } },
    { action: "claim", args: { item: "original task" } },
    { action: "update", args: { item: "original task", updates: { text: "changed task" } } },
    { action: "remove", args: { item: "original task" } },
    { action: "pin", args: { item: "original task" } },
    { action: "tidy", args: { keep: 0 } },
  ])("manage_task action=$action returns tasks-retired through the composite", async ({ action, args }) => {
    const res = parse(await tools.get("manage_task")!({ action, project: PROJECT, ...args }));
    expect(res.ok).toBe(false);
    expect(res.errorCode).toBe(TASKS_RETIRED_CODE);
    expect(res.error).toBe(TASKS_RETIRED_MESSAGE);
    expect(fs.readFileSync(taskFile(), "utf8")).toBe(SAMPLE);
  });

  it("records no session task ledger entry for a refused claim", async () => {
    process.env.CLAUDE_CODE_SESSION_ID = "sess-retired";
    try {
      const res = parse(await tools.get("claim_task")!({ project: PROJECT, item: "original task" }));
      expect(res.errorCode).toBe(TASKS_RETIRED_CODE);
      expect(fs.existsSync(path.join(tmp.path, ".runtime", "session-tasks"))).toBe(false);
    } finally {
      delete process.env.CLAUDE_CODE_SESSION_ID;
    }
  });
});

describe("task reads keep working", () => {
  it("get_tasks still lists the project's tasks", async () => {
    const res = parse(await tools.get("get_tasks")!({ project: PROJECT }));
    expect(res.ok).toBe(true);
    expect(res.message).toContain("original task line");
  });

  it("returns a single task by id", async () => {
    const res = parse(await tools.get("get_tasks")!({ project: PROJECT, id: "A1" }));
    expect(res.ok).toBe(true);
    expect(res.data.line).toBe("original task line");
  });
});

// The composite advertises only `action` and leaves every other argument
// untyped, so this runs the real MCP request path: the SDK validates the
// composite's own schema, then the gate dispatches with the target's schema.
describe("retired task writes over the MCP wire", () => {
  let client: Client;

  beforeEach(async () => {
    const server = new McpServer({ name: "phren-test", version: "0" });
    const register = server.registerTool.bind(server);
    const gate = createToolGate({ profile: "core", register: (name, config, handler) => register(name as never, config as never, handler as never) });
    registerTask(gate as never, context());
    gate.finish();
    const [serverSide, clientSide] = InMemoryTransport.createLinkedPair();
    await server.connect(serverSide);
    client = new Client({ name: "phren-test-client", version: "0" });
    await client.connect(clientSide);
  });

  afterEach(async () => {
    await client.close();
  });

  it("manage_task returns tasks-retired", async () => {
    const res = parse(await client.callTool({ name: "manage_task", arguments: { action: "complete", project: PROJECT, item: "original task" } }));
    expect(res.errorCode).toBe(TASKS_RETIRED_CODE);
    expect(res.error).toBe(TASKS_RETIRED_MESSAGE);
    expect(fs.readFileSync(taskFile(), "utf8")).toBe(SAMPLE);
  });

  it("add_task returns tasks-retired after the wire schema normalizes a scalar", async () => {
    const res = parse(await client.callTool({ name: "add_task", arguments: { project: PROJECT, item: "wire task" } }));
    expect(res.errorCode).toBe(TASKS_RETIRED_CODE);
    expect(res.error).toBe(TASKS_RETIRED_MESSAGE);
    expect(fs.readFileSync(taskFile(), "utf8")).toBe(SAMPLE);
  });
});
