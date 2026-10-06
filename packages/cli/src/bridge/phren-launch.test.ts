import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { HarnessInventory } from "./harnesses.js";
import { BridgeError, type Json } from "./protocol.js";
import { launchSession, makeConductor, resetLaunchIds, setLaunchInventory } from "./server-launch.js";
import { type AgentStart, type PanePlacement, setTerminalProvider, type TerminalProvider } from "./terminal.js";

const inventory = (sources = ["claude", "codex", "opencode", "copilot", "phren"]): HarnessInventory =>
  ({ harnesses: sources.map(source => ({ source, installed: true, usable: true })) }) as HarnessInventory;

describe("launching phren's own agent", () => {
  let home: string, cwd: string, restore: () => void, placements: PanePlacement[], starts: AgentStart[], state: Json;
  beforeEach(() => {
    home = mkdtempSync(path.join(tmpdir(), "phren-launch-phren-"));
    cwd = path.join(home, "project"); mkdirSync(cwd);
    vi.stubEnv("HOME", home); vi.stubEnv("CLAUDE_CONFIG_DIR", ""); vi.stubEnv("PHREN_BRIDGE_HOME", path.join(home, "bridge"));
    setLaunchInventory(async () => inventory());
    placements = []; starts = []; state = { workspaces: [], tabs: [], panes: [] };
    restore = setTerminalProvider({
      kind: "fake",
      snapshot: async () => structuredClone(state),
      create: async (_server: string, placement: PanePlacement) => {
        placements.push(placement);
        const n = placements.length;
        state.workspaces.push({ workspace_id: `w${n}`, label: placement.label });
        state.tabs.push({ tab_id: `w${n}:t1`, workspace_id: `w${n}`, label: placement.label });
        state.panes.push({ pane_id: `w${n}:p1`, tab_id: `w${n}:t1`, workspace_id: `w${n}`, terminal_id: `term-${n}` });
      },
      startAgent: async (_server: string, _pane: string, agent: AgentStart) => { starts.push(agent); },
    } as unknown as TerminalProvider);
  });
  afterEach(() => { restore(); setLaunchInventory(undefined); resetLaunchIds(); vi.unstubAllEnvs(); rmSync(home, { recursive: true, force: true }); });

  it("starts one quick chat for one launchId: a double tap or a retry gets the same pane", async () => {
    const launchId = "0b7e3c1a-5d2f-4e8a-9c41-2f6b8d0e7a13";
    const quick = { cwd, label: "Quick chat", kind: "phren", mode: "chat", launchId };
    const [first, second] = await Promise.all([launchSession("default", quick), launchSession("default", quick)]);
    expect(starts).toHaveLength(1);
    expect(second).toMatchObject({ workspaceId: first.workspaceId, tabId: first.tabId, reused: true });
    expect(await launchSession("default", quick)).toMatchObject({ tabId: first.tabId, reused: true });
    expect(starts).toHaveLength(1);
    // Another launchId is another chat; without one nothing is remembered.
    await launchSession("default", { ...quick, launchId: "1c8f4d2b-6e3a-4f9b-8d52-3a7c9e1f8b24" });
    await launchSession("default", { cwd, label: "Quick chat", kind: "phren", mode: "chat" });
    expect(starts).toHaveLength(3);
  });

  it("starts again when the launchId's pane is gone", async () => {
    const quick = { cwd, label: "Quick chat", kind: "phren", mode: "chat", launchId: "2d9a5e3c-7f4b-4a0c-9e63-4b8d0f2a9c35" };
    const first = await launchSession("default", quick);
    state.tabs = state.tabs.filter((tab: Json) => tab.tab_id !== first.tabId);
    expect(await launchSession("default", quick)).not.toHaveProperty("reused");
    expect(starts).toHaveLength(2);
    await expect(launchSession("default", { ...quick, launchId: "not-a-uuid" })).rejects.toThrow();
  });

  it("concurrent retries share one replacement when the old pane is gone", async () => {
    const quick = { cwd, label: "Quick chat", kind: "phren", mode: "chat", launchId: "3e9a5e3c-7f4b-4a0c-9e63-4b8d0f2a9c35" };
    const first = await launchSession("default", quick);
    // The tab can remain after its agent pane closes.
    state.panes = state.panes.filter((pane: Json) => pane.pane_id !== first.paneId);
    const [second, third] = await Promise.all([launchSession("default", quick), launchSession("default", quick)]);
    expect(starts).toHaveLength(2);
    expect(second.paneId).not.toBe(first.paneId);
    expect(third).toMatchObject({ paneId: second.paneId, reused: true });
  });

  it("keeps the original launch after a failed snapshot instead of duplicating it", async () => {
    const quick = { cwd, label: "Quick chat", kind: "phren", mode: "chat", launchId: "4f9a5e3c-7f4b-4a0c-9e63-4b8d0f2a9c35" };
    const first = await launchSession("default", quick);
    const restoreUnavailable = setTerminalProvider({ snapshot: async () => { throw new Error("Terminal unavailable"); } } as unknown as TerminalProvider);
    try { await expect(launchSession("default", quick)).rejects.toThrow("Terminal unavailable"); }
    finally { restoreUnavailable(); }
    expect(await launchSession("default", quick)).toMatchObject({ paneId: first.paneId, reused: true });
    expect(starts).toHaveLength(1);
  });

  it("runs `phren agent -i`, with --model and --reasoning when asked", async () => {
    expect(await launchSession("default", { cwd, label: "Phren plain", kind: "phren" })).toMatchObject({ ok: true, agent: "phren" });
    expect(starts[0]).toMatchObject({ name: "phren-plain", kind: "phren", args: ["agent", "-i"] });
    await launchSession("default", { cwd, label: "Phren tuned", kind: "phren", model: "openai-codex/gpt-6-sol", effort: "high" });
    expect(starts[1].args).toEqual(["agent", "-i", "--model", "openai-codex/gpt-6-sol", "--reasoning", "high"]);
    await launchSession("default", { cwd, label: "Custom", kind: "phren", model: "openai-compat/vendor/model" });
    expect(starts[2].args).toEqual(["agent", "-i", "--provider", "openai-compat", "--model", "vendor/model"]);
  });

  it("preserves the phone's model-supported efforts", async () => {
    const wanted: Record<string, string> = { minimal: "minimal", low: "low", medium: "medium", high: "high", xhigh: "xhigh", max: "max" };
    for (const [effort, reasoning] of Object.entries(wanted)) {
      await launchSession("default", { cwd, label: `Phren ${effort}`, kind: "phren", effort });
      expect(starts.at(-1)!.args).toEqual(["agent", "-i", "--reasoning", reasoning]);
    }
  });

  it("types a dispatched brief afterwards: the TUI takes no first prompt", async () => {
    const launched = await launchSession("default", { cwd, label: "Phren worker", kind: "phren", brief: { id: "c".repeat(8) + "-0000-4000-8000-000000000000", text: "Do it." } });
    expect(launched).toMatchObject({ ok: true, briefLaunched: false });
    expect(starts[0].args).toEqual(["agent", "-i"]);
    expect(starts[0].env?.PHREN_DISPATCH_ID).toBe("c".repeat(8) + "-0000-4000-8000-000000000000");
  });

  it("refuses a tool-free conductor, a permission mode, an account, and a computer without the agent, before any pane exists", async () => {
    const refusal = (data: Json) => launchSession("default", { cwd, label: "Phren", kind: "phren", ...data }).catch(error => error as BridgeError);
    expect(await refusal({ role: "conductor", mode: "chat" })).toMatchObject({ status: 400, message: "A conductor needs agent mode with tools." });
    expect(await refusal({ permissionMode: "full-access" })).toMatchObject({ status: 400, message: expect.stringMatching(/phren agent takes its permissions/) });
    expect(await refusal({ account: "work" })).toMatchObject({ status: 409, details: { code: "account_unavailable" } });
    setLaunchInventory(async () => ({ harnesses: [...inventory(["claude"]).harnesses, { source: "phren", installed: false, usable: false, reason: "Not installed" }] }) as HarnessInventory);
    expect(await refusal({})).toMatchObject({ status: 409, details: { code: "harness_unavailable" } });
    expect(placements).toEqual([]);
    expect(starts).toEqual([]);
  });

  it("starts a quick chat, resumes it, and promotes it to an agent with the same history", async () => {
    const session = "0b6f3c2e-5d1a-4c7e-9f20-3a8b1c4d5e6f";
    await launchSession("default", { cwd, label: "Quick chat", kind: "phren", mode: "chat", model: "openai-codex/gpt-6-sol" });
    expect(starts[0].args).toEqual(["agent", "-i", "--mode", "chat", "--model", "openai-codex/gpt-6-sol"]);
    await launchSession("default", { cwd, label: "Quick chat again", kind: "phren", mode: "chat", resumeSession: session });
    expect(starts[1].args).toEqual(["agent", "-i", "--mode", "chat", "--session", session]);
    await launchSession("default", { cwd, label: "Promoted", kind: "phren", mode: "agent", resumeSession: session });
    expect(starts[2].args).toEqual(["agent", "-i", "--session", session]);
  });

  it("refuses chat mode and resume on another harness, and a session that is not an id, before any pane exists", async () => {
    await expect(launchSession("default", { cwd, label: "Claude chat", kind: "claude", mode: "chat" })).rejects.toMatchObject({ status: 400 });
    await expect(launchSession("default", { cwd, label: "Codex resume", kind: "codex", resumeSession: "0b6f3c2e-5d1a-4c7e-9f20-3a8b1c4d5e6f" })).rejects.toMatchObject({ status: 400 });
    await expect(launchSession("default", { cwd, label: "Bad", kind: "phren", resumeSession: "--yolo" })).rejects.toThrow();
    await expect(launchSession("default", { cwd, label: "Bad", kind: "phren", mode: "turbo" })).rejects.toThrow();
    expect(placements).toEqual([]);
  });

  it("refuses to resume a session that used tools as a quick chat, unless a compaction summary replaced them", async () => {
    const store = path.join(home, "store"), session = "1c2d3e4f-5a6b-4c7d-8e9f-0a1b2c3d4e5f";
    vi.stubEnv("PHREN_PATH", store);
    mkdirSync(path.join(store, ".sessions"), { recursive: true });
    const event = (seq: number, type: string, data: Json) => JSON.stringify({ seq, time: "2026-10-01T00:00:00Z", type, data });
    const log = [
      JSON.stringify({ type: "header", version: 1, sessionId: session, cwd }),
      event(0, "user/message", { message: { role: "user", content: "List the files" }, source: "user", turn: 1 }),
      event(1, "assistant/message", { message: { role: "assistant", content: [{ type: "tool_use", id: "t1", name: "shell", input: { command: "ls" } }] }, stop_reason: "tool_use", turn: 1 }),
      event(2, "tool/results", { message: { role: "user", content: [{ type: "tool_result", tool_use_id: "t1", content: "a b" }] }, turn: 1 }),
      event(3, "assistant/message", { message: { role: "assistant", content: [{ type: "text", text: "Two files." }] }, stop_reason: "end_turn", turn: 1 }),
    ];
    const file = path.join(store, ".sessions", `session-${session}.events.jsonl`);
    writeFileSync(file, log.join("\n") + "\n");
    await expect(launchSession("default", { cwd, label: "Back to chat", kind: "phren", mode: "chat", resumeSession: session }))
      .rejects.toMatchObject({ status: 400, details: { code: "chat-has-tools" } });
    expect(placements).toEqual([]);
    // As an agent it resumes, tools and all.
    await launchSession("default", { cwd, label: "As agent", kind: "phren", mode: "agent", resumeSession: session });
    expect(starts[0].args).toEqual(["agent", "-i", "--session", session]);
    // Compacted behind a summary, the model no longer sees the tool calls.
    writeFileSync(file, [...log, event(4, "log/replace", { start: 1, end: 3, message: { role: "user", content: "Summary: listed two files." } })].join("\n") + "\n");
    await launchSession("default", { cwd, label: "Chat again", kind: "phren", mode: "chat", resumeSession: session });
    expect(starts[1].args).toEqual(["agent", "-i", "--mode", "chat", "--session", session]);
  });

  it("starts a catalog model on its provider: --provider for those phren agent can't read off --model", async () => {
    await launchSession("default", { cwd, label: "Sonnet", kind: "phren", model: "anthropic/claude-sonnet-5" });
    expect(starts[0].args).toEqual(["agent", "-i", "--provider", "anthropic", "--model", "claude-sonnet-5"]);
    await launchSession("default", { cwd, label: "Router", kind: "phren", model: "openrouter/anthropic/claude-sonnet-5" });
    expect(starts[1].args).toEqual(["agent", "-i", "--provider", "openrouter", "--model", "anthropic/claude-sonnet-5"]);
    await launchSession("default", { cwd, label: "Sol", kind: "phren", model: "openai-codex/gpt-6-sol" });
    expect(starts[2].args).toEqual(["agent", "-i", "--model", "openai-codex/gpt-6-sol"]);
  });

  it("makes a running phren agent the conductor", async () => {
    state.panes.push({ pane_id: "w9:p1", tab_id: "w9:t1", workspace_id: "w9", agent: "phren", agent_status: "idle" });
    await expect(makeConductor("default", { paneId: "w9:p1" })).resolves.toMatchObject({ ok: true, conductor: { server: "default" } });
  });
});
