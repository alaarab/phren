import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { HarnessInventory } from "./harnesses.js";
import { BridgeError, type Json } from "./protocol.js";
import { launchSession, makeConductor, setLaunchInventory } from "./server-launch.js";
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
  afterEach(() => { restore(); setLaunchInventory(undefined); vi.unstubAllEnvs(); rmSync(home, { recursive: true, force: true }); });

  it("runs `phren agent -i`, with --model and --reasoning when asked", async () => {
    expect(await launchSession("default", { cwd, label: "Phren plain", kind: "phren" })).toMatchObject({ ok: true, agent: "phren" });
    expect(starts[0]).toMatchObject({ name: "phren-plain", kind: "phren", args: ["agent", "-i"] });
    await launchSession("default", { cwd, label: "Phren tuned", kind: "phren", model: "openai-codex/gpt-6-sol", effort: "high" });
    expect(starts[1].args).toEqual(["agent", "-i", "--model", "openai-codex/gpt-6-sol", "--reasoning", "high"]);
  });

  it("maps the phone's efforts onto phren-agent's low to xhigh", async () => {
    const wanted: Record<string, string> = { minimal: "low", low: "low", medium: "medium", high: "high", xhigh: "xhigh", max: "max" };
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

  it("refuses a conductor, a permission mode, an account, and a computer without the agent, before any pane exists", async () => {
    const refusal = (data: Json) => launchSession("default", { cwd, label: "Phren", kind: "phren", ...data }).catch(error => error as BridgeError);
    const conductor = await refusal({ role: "conductor" });
    expect(conductor).toMatchObject({ status: 400, message: expect.stringMatching(/phren agent cannot run as a conductor/) });
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

  it("will not make a running phren agent the conductor", async () => {
    state.panes.push({ pane_id: "w9:p1", tab_id: "w9:t1", workspace_id: "w9", agent: "phren", agent_status: "idle" });
    await expect(makeConductor("default", { paneId: "w9:p1" })).rejects.toMatchObject({ status: 400, message: expect.stringMatching(/phren agent cannot run as a conductor/) });
  });
});
