import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { afterEach, describe, expect, it, vi } from "vitest";
import { hookRequest } from "../bridge/client.js";
import { hookPeers, peerRequest } from "../bridge/peers.js";
import { lookupCommand } from "../cli-registry.js";
import { createToolGate, type ToolHandler } from "../mcp/profile.js";
import { register } from "./dispatch.js";

vi.mock("../bridge/client.js", () => ({ hookRequest: vi.fn() }));
vi.mock("../bridge/peers.js", () => ({ hookPeers: vi.fn(), peerRequest: vi.fn() }));
const brief = { computer: "Desk", project: "phren", harness: "codex", label: "Checks", prompt: "Run checks" };
const session = "aaaaaaaa-1111-4111-8111-111111111111";
const target = { server: "default", workspace: "w1", tab: "t1", pane: "p1", source: "codex", session };
const overview = { groups: [{ id: "w1", children: [{ id: "t1", target }] }] };

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

  it.each(["core", "full"] as const)("hands off locally through the %s MCP profile", async profile => {
    const exposed = new Map<string, ToolHandler>();
    const gate = createToolGate({ profile, register: (name, _config, handler) => exposed.set(name, handler) });
    register({ registerTool: gate.registerTool } as unknown as McpServer); gate.finish();
    vi.mocked(hookRequest).mockImplementation(async route => route === "/v1/workspaces" ? overview : { ok: true });
    const input = { session, text: "Please take this next step" };
    const result = await exposed.get(profile === "full" ? "hand_off" : "phren_admin")!({ ...input, ...(profile === "core" ? { action: "hand_off" } : {}) });
    expect(JSON.parse((result as { content: { text: string }[] }).content[0].text).data).toMatchObject({ ok: true, delivered: true, target });
    expect(hookRequest).toHaveBeenLastCalledWith("/v1/prompt", { target, text: input.text });
  });

  it("hands off through a named peer and resolves its session from that peer's overview", async () => {
    const exposed = new Map<string, ToolHandler>();
    const gate = createToolGate({ profile: "full", register: (name, _config, handler) => exposed.set(name, handler) });
    register({ registerTool: gate.registerTool } as unknown as McpServer); gate.finish();
    const peer = { name: "Desk", server: "default" } as Awaited<ReturnType<typeof hookPeers>>[number];
    vi.mocked(hookPeers).mockResolvedValue([peer]);
    vi.mocked(peerRequest).mockImplementation(async (_peer, route) => route.startsWith("/v1/workspaces") ? overview : { ok: true });
    const result = await exposed.get("hand_off")!({ computer: "Desk", session, text: "Review the current work" });
    expect(JSON.parse((result as { content: { text: string }[] }).content[0].text).data).toMatchObject({ delivered: true, target });
    expect(peerRequest).toHaveBeenLastCalledWith(peer, "/v1/prompt", { target, text: "Review the current work" });
    expect(hookRequest).not.toHaveBeenCalled();
  });

  it("routes the hand-off CLI command to a local session", async () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.mocked(hookRequest).mockImplementation(async route => route === "/v1/workspaces" ? overview : { ok: true });
    const command = lookupCommand("hand-off")!;
    const context = { phrenPath: () => "unused", profile: () => "unused" };
    expect(await command.run(["local", "--session", session, "--text", "Continue here"], context)).toBe(0);
    expect(hookRequest).toHaveBeenLastCalledWith("/v1/prompt", { target, text: "Continue here" });
  });
});
