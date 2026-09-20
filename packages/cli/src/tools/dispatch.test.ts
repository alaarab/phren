import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { afterEach, describe, expect, it, vi } from "vitest";
import { hookRequest } from "../bridge/client.js";
import { lookupCommand } from "../cli-registry.js";
import { createToolGate, type ToolHandler } from "../mcp/profile.js";
import { register } from "./dispatch.js";

vi.mock("../bridge/client.js", () => ({ hookRequest: vi.fn() }));
const brief = { computer: "Desk", project: "phren", harness: "codex", label: "Checks", prompt: "Run checks" };

describe("dispatch entry points", () => {
  afterEach(() => { vi.restoreAllMocks(); vi.resetAllMocks(); });
  it.each(["core", "full"] as const)("reaches the same Hook through the %s MCP profile", async profile => {
    const exposed = new Map<string, ToolHandler>();
    const gate = createToolGate({ profile, register: (name, _config, handler) => exposed.set(name, handler) });
    register({ registerTool: gate.registerTool } as unknown as McpServer); gate.finish();
    vi.mocked(hookRequest).mockResolvedValue({ ok: true, computer: "Desk", state: "accepted" });
    const result = await exposed.get(profile === "full" ? "dispatch" : "phren_admin")!({ ...brief, ...(profile === "core" ? { action: "dispatch" } : {}) });
    expect(JSON.parse((result as { content: { text: string }[] }).content[0].text).ok).toBe(true);
    expect(hookRequest).toHaveBeenCalledWith("/v1/dispatch", brief, undefined, 180_000);
  });

  it("routes CLI dispatch and status and returns failure for uncertain delivery", async () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    const command = lookupCommand("dispatch")!;
    const context = { phrenPath: () => "unused", profile: () => "unused" };
    vi.mocked(hookRequest).mockResolvedValue({ ok: false, state: "uncertain" });
    expect(await command.run(["Desk", "phren", "--label", "Checks", "--prompt", "Run checks"], context)).toBe(1);
    expect(hookRequest).toHaveBeenCalledWith("/v1/dispatch", brief, undefined, 180_000);
    vi.mocked(hookRequest).mockResolvedValue({ dispatches: [] });
    expect(await command.run(["status"], context)).toBe(0);
    expect(hookRequest).toHaveBeenLastCalledWith("/v1/dispatch");
  });
});
