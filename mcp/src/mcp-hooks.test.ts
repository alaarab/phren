import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as fs from "fs";
import * as path from "path";
import { makeTempDir, grantAdmin } from "./test-helpers.js";
import { register } from "./mcp-hooks.js";
import { readProjectConfig } from "./project-config.js";
import type { McpContext } from "./mcp-types.js";

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

describe("mcp-hooks project overrides", () => {
  let tmp: { path: string; cleanup: () => void };
  let server: ReturnType<typeof makeMockServer>;

  beforeEach(() => {
    tmp = makeTempDir("mcp-hooks-project-");
    grantAdmin(tmp.path);
    fs.mkdirSync(path.join(tmp.path, "demo"), { recursive: true });
    server = makeMockServer();

    const ctx: McpContext = {
      phrenPath: tmp.path,
      profile: "",
      db: () => { throw new Error("unused"); },
      rebuildIndex: async () => {},
      updateFileInIndex: () => {},
      withWriteQueue: async <T>(fn: () => Promise<T>) => fn(),
    };
    register(server as any, ctx);
  });

  afterEach(() => {
    tmp.cleanup();
  });

  it("toggle_hooks can disable hooks for a project", async () => {
    const res = parseResult(await server.call("toggle_hooks", { project: "demo", enabled: false }));
    expect(res.ok).toBe(true);
    expect(res.data.project).toBe("demo");
    expect(readProjectConfig(tmp.path, "demo").hooks?.enabled).toBe(false);
  });

  it("toggle_hooks can override a single project lifecycle event", async () => {
    await server.call("toggle_hooks", { project: "demo", enabled: false });
    const res = parseResult(await server.call("toggle_hooks", {
      project: "demo",
      event: "UserPromptSubmit",
      enabled: true,
    }));

    expect(res.ok).toBe(true);
    const config = readProjectConfig(tmp.path, "demo");
    expect(config.hooks?.enabled).toBe(false);
    expect(config.hooks?.UserPromptSubmit).toBe(true);
  });

  it("list_hooks returns effective project event status when a project is requested", async () => {
    await server.call("toggle_hooks", { project: "demo", enabled: false });
    await server.call("toggle_hooks", { project: "demo", event: "UserPromptSubmit", enabled: true });

    const res = parseResult(await server.call("list_hooks", { project: "demo" }));
    expect(res.ok).toBe(true);
    expect(res.data.projectHooks.project).toBe("demo");
    const events = Object.fromEntries(
      res.data.projectHooks.events.map((entry: { event: string; enabled: boolean }) => [entry.event, entry.enabled]),
    );
    expect(events.UserPromptSubmit).toBe(true);
    expect(events.Stop).toBe(false);
    expect(events.SessionStart).toBe(false);
  });
});
