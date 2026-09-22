import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createToolGate } from "../mcp/profile.js";
import { BUILTIN_MODULES } from "../modules/registry.js";
import { indexProject } from "../../../code/src/indexer.js";
import { makeTempDir } from "../test-helpers.js";
import { register } from "./code.js";
import type { McpContext } from "./types.js";

const FIXTURES = path.join(__dirname, "../../../code/src/__fixtures__");

let tmp: ReturnType<typeof makeTempDir>;
let repo: string;
let store: string;
let ctx: McpContext;
let handlers: Map<string, (args: Record<string, unknown>) => unknown>;

function git(...args: string[]): void {
  execFileSync(
    "git",
    ["-c", "user.name=Fixture Author", "-c", "user.email=fixture@example.com", "-c", "commit.gpgsign=false", ...args],
    { cwd: repo, stdio: ["ignore", "pipe", "pipe"] },
  );
}

async function toolText(name: string, args: Record<string, unknown>): Promise<string> {
  const result = await handlers.get(name)!(args) as { content: Array<{ type: string; text: string }> };
  return result.content.map(part => part.text).join("\n");
}

beforeEach(async () => {
  tmp = makeTempDir("code-tools-");
  repo = path.join(tmp.path, "repo");
  store = path.join(tmp.path, "store");
  fs.cpSync(FIXTURES, repo, { recursive: true });
  git("init", "-q");
  git("add", "-A");
  git("commit", "-q", "-m", "fixtures");
  await indexProject(store, "fixture", { repoRoot: repo });

  handlers = new Map();
  const server = {
    registerTool(name: string, _config: unknown, handler: (args: Record<string, unknown>) => unknown) {
      handlers.set(name, handler);
    },
  } as unknown as McpServer;
  ctx = {
    phrenPath: store,
    profile: "test",
    db: () => { throw new Error("not needed"); },
    rebuildIndex: async () => {},
    updateFileInIndex: () => {},
    withWriteQueue: async <T>(fn: () => Promise<T>) => fn(),
  };
  register(server, ctx);
});

afterEach(() => {
  tmp.cleanup();
});

describe("code MCP tool results", () => {
  it("code_search prints one compact line per hit with the doc", async () => {
    const text = await toolText("code_search", { project: "fixture", query: "add" });
    expect(text).toMatch(/match\(es\) for "add"/);
    expect(text).toMatch(/typescript\/app\.ts:\d+ function add/);
    expect(text).toContain("Adds two numbers");
    expect(text).not.toContain('"ok"');
  });

  it("code_definition prints the location, signature, doc, last change and snippet", async () => {
    const text = await toolText("code_definition", { project: "fixture", symbol: "Point.length" });
    expect(text).toMatch(/typescript\/app\.ts:\d+-\d+ method length/);
    expect(text).toContain("Distance from the origin");
    expect(text).toContain("last change");
    expect(text).toContain("Math.sqrt");
  });

  it("code_references groups by file", async () => {
    const text = await toolText("code_references", { project: "fixture", symbol: "greet" });
    expect(text).toMatch(/references for greet \(/);
    expect(text).toContain("in");
    expect(text).toMatch(/\n\s+\d+ call/);
  });

  it("code_outline nests members under their parent", async () => {
    const text = await toolText("code_outline", { project: "fixture", path: "typescript/app.ts" });
    expect(text).toContain("typescript/app.ts (");
    expect(text).toContain("class Point");
    expect(text).toMatch(/\n {2}\d+ method length/);
  });

  it("code_usage prints hot and cold sections", async () => {
    const text = await toolText("code_usage", { project: "fixture", top: 5 });
    expect(text).toContain("symbols by reference count");
    expect(text).toContain("hot");
    expect(text).toContain("cold");
  });

  it("tells the agent to build an index when none exists", async () => {
    const text = await toolText("code_search", { project: "absent", query: "add" });
    expect(text).toContain("No code index");
    expect(text).toContain("phren code index");
  });
});

describe("code module gate", () => {
  const memoryOnly = BUILTIN_MODULES.filter(module => module.name === "memory");
  const withCode = BUILTIN_MODULES.filter(module => module.name === "memory" || module.name === "code");
  const gateCtx: McpContext = {
    phrenPath: "/nonexistent",
    profile: "test",
    db: () => { throw new Error("not used"); },
    rebuildIndex: async () => {},
    updateFileInIndex: () => {},
    withWriteQueue: async <T>(fn: () => Promise<T>) => fn(),
  };

  it("is absent when the code module is off", () => {
    const gate = createToolGate({ profile: "full", modules: memoryOnly, register: () => {} });
    register(gate as unknown as McpServer, gateCtx);
    gate.finish();
    expect(gate.catalog.has("code_search")).toBe(false);
    expect(gate.exposed.has("code_search")).toBe(false);
  });

  it("exposes all five tools in the full profile when the module is on", () => {
    const gate = createToolGate({ profile: "full", modules: withCode, register: () => {} });
    register(gate as unknown as McpServer, gateCtx);
    gate.finish();
    for (const name of ["code_search", "code_definition", "code_references", "code_outline", "code_usage"]) {
      expect(gate.exposed.has(name), name).toBe(true);
    }
  });

  it("keeps code tools out of the core surface but reachable through phren_admin", () => {
    const gate = createToolGate({ profile: "core", modules: withCode, register: () => {} });
    register(gate as unknown as McpServer, gateCtx);
    gate.finish();
    expect(gate.catalog.has("code_search")).toBe(true);
    expect(gate.exposed.has("code_search")).toBe(false);
  });
});
