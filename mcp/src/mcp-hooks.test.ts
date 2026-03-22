import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as fs from "fs";
import * as path from "path";
import { makeTempDir, grantAdmin } from "./test-helpers.js";
import { register } from "./tools/mcp-hooks.js";
import { readProjectConfig } from "./project-config.js";
import type { McpContext } from "./tools/mcp-types.js";

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

describe("mcp-hooks SSRF blocklist", () => {
  let tmp: { path: string; cleanup: () => void };
  let server: ReturnType<typeof makeMockServer>;

  beforeEach(() => {
    tmp = makeTempDir("mcp-hooks-ssrf-");
    grantAdmin(tmp.path);
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

  const blockedWebhooks = [
    ["IPv6 loopback ::1", "http://[::1]/evil"],
    ["IPv6 link-local fe80", "http://[fe80::1]/x"],
    ["IPv6 ULA fc00", "http://[fc00::1]/x"],
    ["IPv6 ULA fd00", "http://[fd00::1]/x"],
    ["IPv4-mapped IPv6 ::ffff:127.0.0.1", "http://[::ffff:127.0.0.1]/x"],
    ["decimal-encoded 127.0.0.1 (2130706433)", "http://2130706433/"],
    ["hex-encoded 0x7f000001", "http://0x7f000001/"],
    ["localhost", "http://localhost/hook"],
    ["127.x.x.x", "http://127.0.0.1/hook"],
    ["10.x.x.x private", "http://10.0.0.1/hook"],
    ["192.168.x.x private", "http://192.168.1.1/hook"],
    [".local mDNS", "http://mybox.local/hook"],
  ];

  for (const [label, webhook] of blockedWebhooks) {
    it(`blocks ${label}`, async () => {
      const res = parseResult(
        await server.call("add_custom_hook", { event: "Stop", webhook })
      );
      expect(res.ok).toBe(false);
      expect(res.error).toMatch(/private|loopback|blocked|ssrf/i);
    });
  }

  it("allows a public HTTPS webhook URL", async () => {
    const res = parseResult(
      await server.call("add_custom_hook", {
        event: "Stop",
        webhook: "https://hooks.example.com/phren",
      })
    );
    expect(res.ok).toBe(true);
  });

  it("rejects command hooks with shell metacharacters", async () => {
    const res = parseResult(
      await server.call("add_custom_hook", {
        event: "pre-save",
        command: "echo ok\nrm -rf /tmp/nope",
      })
    );
    expect(res.ok).toBe(false);
    expect(res.error).toContain("disallowed shell characters");
  });
});
