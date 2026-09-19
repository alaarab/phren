import { afterEach, describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { ToolRegistry } from "../tools/registry.js";
import {
  loadHooksConfig,
  runPreToolUseHooks,
  type HookExecutor,
} from "../user-hooks.js";
import type { AgentTool } from "../tools/types.js";

const tmpDirs: string[] = [];

function tmp(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tmpDirs.push(dir);
  return dir;
}

function writeHooks(dir: string, config: unknown): void {
  fs.mkdirSync(path.join(dir, ".phren-agent"), { recursive: true });
  fs.writeFileSync(path.join(dir, ".phren-agent", "hooks.json"), JSON.stringify(config));
}

function tool(name: string, run: () => void): AgentTool {
  return {
    name,
    description: "test tool",
    input_schema: { type: "object", properties: {} },
    async execute() {
      run();
      return { output: "ok" };
    },
  };
}

function registryWith(): ToolRegistry {
  const registry = new ToolRegistry();
  registry.setPermissions({ mode: "full-auto", allowedPaths: [], projectRoot: process.cwd() });
  return registry;
}

afterEach(() => {
  while (tmpDirs.length > 0) fs.rmSync(tmpDirs.pop()!, { recursive: true, force: true });
});

describe("loadHooksConfig", () => {
  it("returns null when nothing is configured", () => {
    expect(loadHooksConfig(tmp("phren-cwd-"), { home: tmp("phren-home-") })).toBeNull();
  });

  it("merges user and project hook files", () => {
    const home = tmp("phren-home-");
    const cwd = tmp("phren-cwd-");
    writeHooks(home, { hooks: { UserPromptSubmit: [{ command: "user-hook" }] } });
    writeHooks(cwd, { hooks: { PreToolUse: [{ matcher: "shell", command: "project-hook" }] } });
    const config = loadHooksConfig(cwd, { home });
    expect(config?.UserPromptSubmit?.[0]?.command).toBe("user-hook");
    expect(config?.PreToolUse?.[0]?.command).toBe("project-hook");
  });
});

describe("PreToolUse hooks", () => {
  it("denies the tool call and returns the hook stderr", async () => {
    const registry = registryWith();
    let executed = false;
    registry.register(tool("edit_file", () => { executed = true; }));
    registry.hookConfig = { PreToolUse: [{ matcher: "shell|edit_file", command: "deny" }] };
    registry.hookExecutor = async () => ({ exitCode: 2, stdout: "", stderr: "blocked by policy", timedOut: false });

    const result = await registry.execute("edit_file", { path: "a.txt" });

    expect(result.is_error).toBe(true);
    expect(result.output).toBe("blocked by policy");
    expect(executed).toBe(false);
  });

  it("passes the event JSON on stdin and only matches the matcher", async () => {
    const registry = registryWith();
    const seen: Record<string, unknown>[] = [];
    registry.register(tool("read_file", () => {}));
    registry.register(tool("shell", () => {}));
    registry.hookConfig = { PreToolUse: [{ matcher: "shell", command: "only-shell" }] };
    registry.hookExecutor = async (_command, stdin) => {
      seen.push(JSON.parse(stdin));
      return { exitCode: 0, stdout: "", stderr: "", timedOut: false };
    };

    await registry.execute("read_file", { path: "a.txt" });
    await registry.execute("shell", { command: "ls" });

    expect(seen).toHaveLength(1);
    expect(seen[0].hook_event_name).toBe("PreToolUse");
    expect(seen[0].tool_name).toBe("shell");
    expect(seen[0].tool_input).toEqual({ command: "ls" });
  });

  it("runs a real hook process and reads its nonzero exit", async () => {
    const result = await runPreToolUseHooks(
      { PreToolUse: [{ command: "echo nope 1>&2; exit 3" }] },
      "shell",
      { command: "ls" },
      { cwd: tmp("phren-cwd-") },
    );
    expect(result.denied).toBe(true);
    expect(result.message).toContain("nope");
  });

  it("does not deny when the executor fails to spawn", async () => {
    const executor: HookExecutor = async () => ({ exitCode: null, stdout: "", stderr: "boom", timedOut: false });
    const result = await runPreToolUseHooks({ PreToolUse: [{ command: "x" }] }, "shell", {}, { executor });
    expect(result.denied).toBe(false);
  });
});

describe("PostToolUse hooks", () => {
  it("runs after the tool and reports output and error state", async () => {
    const registry = registryWith();
    const events: Record<string, unknown>[] = [];
    registry.register(tool("read_file", () => {}));
    registry.hookConfig = { PostToolUse: [{ matcher: "read_file", command: "notify" }] };
    registry.hookExecutor = async (_command, stdin) => {
      events.push(JSON.parse(stdin));
      return { exitCode: 0, stdout: "", stderr: "", timedOut: false };
    };

    const result = await registry.execute("read_file", { path: "a.txt" });

    expect(result.output).toBe("ok");
    expect(events).toHaveLength(1);
    expect(events[0].hook_event_name).toBe("PostToolUse");
    expect(events[0].tool_response).toBe("ok");
    expect(events[0].is_error).toBe(false);
  });

  it("still runs when the tool fails", async () => {
    const registry = registryWith();
    const events: Record<string, unknown>[] = [];
    registry.register({
      name: "boom",
      description: "test tool",
      input_schema: { type: "object", properties: {} },
      async execute() { throw new Error("kaboom"); },
    });
    registry.hookConfig = { PostToolUse: [{ command: "notify" }] };
    registry.hookExecutor = async (_command, stdin) => {
      events.push(JSON.parse(stdin));
      return { exitCode: 0, stdout: "", stderr: "", timedOut: false };
    };

    const result = await registry.execute("boom", {});

    expect(result.is_error).toBe(true);
    expect(events).toHaveLength(1);
    expect(events[0].is_error).toBe(true);
  });
});
