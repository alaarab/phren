import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as fs from "fs";
import * as path from "path";
import { execFileSync } from "node:child_process";
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
let add: ToolHandler;

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
  add = registered.get("add_task")!.handler;
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

describe("task write receipts", () => {
  const receipt = () => ({ path: path.join(tmp.path, PROJECT, TASKS_FILENAME), commit: null });

  it("preserves scalar add data and names the file written without Git", async () => {
    const res = parse(await add({ project: PROJECT, item: "scalar task", scope: "builder" }));
    expect(res.data).toEqual({ project: PROJECT, item: "scalar task", scope: "builder", write: receipt() });
    expect(fs.readFileSync(res.data.write.path, "utf8")).toContain("scalar task");
  });

  it("retains batch successes and errors alongside the receipt", async () => {
    const res = parse(await add({ project: PROJECT, item: ["first task", "", "second task"] }));
    expect(res.ok).toBe(true);
    expect(res.data).toEqual({ project: PROJECT, added: ["first task", "second task"], errors: [""], write: receipt() });
  });

  it("reports an actual formatting write even when every batch item fails", async () => {
    const res = parse(await add({ project: PROJECT, item: ["", " "] }));
    expect(res.ok).toBe(false);
    expect(res.error).toContain("No tasks added");
    expect(res.data).toEqual({ project: PROJECT, added: [], errors: ["", " "], write: receipt() });
  });

  it("does not mistake an existing store HEAD for a commit of the new task", async () => {
    const git = (...args: string[]) => execFileSync("git", args, { cwd: tmp.path, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
    git("init", "--initial-branch=main");
    git("add", ".");
    git("-c", "user.name=Test", "-c", "user.email=test@example.com", "-c", "commit.gpgsign=false", "commit", "-qm", "seed");
    const head = git("rev-parse", "HEAD");
    const res = parse(await add({ project: PROJECT, item: ["uncommitted task"] }));
    expect(res.data.write).toEqual(receipt());
    expect(git("rev-parse", "HEAD")).toBe(head);
    expect(git("show", `${head}:${PROJECT}/${TASKS_FILENAME}`)).not.toContain("uncommitted task");
  });

  it("uses the owning team store path", async () => {
    const team = path.join(tmp.path, "team-store");
    initTestPhrenRoot(team);
    fs.mkdirSync(path.join(team, PROJECT), { recursive: true });
    fs.writeFileSync(path.join(team, PROJECT, TASKS_FILENAME), SAMPLE);
    fs.mkdirSync(path.join(tmp.path, ".runtime"), { recursive: true });
    fs.writeFileSync(path.join(tmp.path, ".runtime", "attached-stores.yaml"), JSON.stringify({
      version: 1,
      stores: [{ id: "11111111", name: "team", path: team, role: "team", sync: "managed-git", projects: [PROJECT] }],
    }));
    const res = parse(await add({ project: `team/${PROJECT}`, item: ["team task"] }));
    expect(res.ok).toBe(true);
    expect(res.data.write).toEqual({ path: path.join(team, PROJECT, TASKS_FILENAME), commit: null });
    expect(fs.readFileSync(res.data.write.path, "utf8")).toContain("team task");
    expect(fs.readFileSync(path.join(tmp.path, PROJECT, TASKS_FILENAME), "utf8")).toBe(SAMPLE);
  });

  it.each([
    { action: "complete", item: "original task" },
    { action: "remove", item: "original task" },
    { action: "update", item: "original task", updates: { text: "changed task" } },
    { action: "pin", item: "original task" },
    { action: "claim", item: "original task" },
  ])("forwards the receipt through manage_task $action", async (args) => {
    const res = parse(await manage({ project: PROJECT, ...args }));
    expect(res.ok).toBe(true);
    expect(res.data.write).toEqual(receipt());
  });

  it("retains partial completion and removal failures through the composite", async () => {
    const completed = parse(await manage({ action: "complete", project: PROJECT, item: ["original task", "absent"] }));
    expect(completed.data).toMatchObject({ completed: ["original task line"], errors: ["absent"], write: receipt() });
    const removed = parse(await manage({ action: "remove", project: PROJECT, item: ["original task", "absent"] }));
    expect(removed.data).toMatchObject({ removed: ["original task line"], errors: ["absent"], write: receipt() });
  });

  it("distinguishes dry runs and tidy no-ops from an archive write", async () => {
    const noop = parse(await manage({ action: "tidy", project: PROJECT, keep: 0 }));
    expect(noop.data.write).toBeNull();
    await manage({ action: "complete", project: PROJECT, item: "original task" });
    const dry = parse(await manage({ action: "tidy", project: PROJECT, keep: 0, dry_run: true }));
    expect(dry.data.write).toBeNull();
    const archived = parse(await manage({ action: "tidy", project: PROJECT, keep: 0 }));
    expect(archived.data.write).toEqual(receipt());
  });

  it("does not attach a previous call's receipt to a validation error", async () => {
    await add({ project: PROJECT, item: ["a task"] });
    const res = parse(await manage({ action: "update", project: PROJECT, item: "absent", updates: { text: "new text" } }));
    expect(res.ok).toBe(false);
    expect(res.data).toBeUndefined();
  });
});

describe("manage_task action=update through the composite", () => {
  it("applies section, priority and text when updates arrives as an object", async () => {
    const res = parse(await manage({ action: "update", project: PROJECT, item: "original task", updates: { section: "Queue", priority: "high", text: "renamed task line" } }));
    expect(res.ok).toBe(true);
    const queue = queueLines();
    expect(queue).toHaveLength(1);
    expect(queue[0]).toContain("renamed task line");
    expect(queue[0]).toContain("[high]");
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
    expect(res.data.write).toEqual({ path: path.join(tmp.path, PROJECT, TASKS_FILENAME), commit: null });
  });

  it("returns a receipt for add_task after the wire schema normalizes a scalar", async () => {
    const res = parse(await client.callTool({ name: "add_task", arguments: { project: PROJECT, item: "wire task" } }));
    expect(res.ok).toBe(true);
    expect(res.data).toMatchObject({ added: ["wire task"], errors: [], write: { path: path.join(tmp.path, PROJECT, TASKS_FILENAME), commit: null } });
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
