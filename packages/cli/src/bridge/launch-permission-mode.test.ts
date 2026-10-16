import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { HarnessInventory } from "./harnesses.js";
import { BridgeError, type Json } from "./protocol.js";
import { launchSession, setLaunchInventory } from "./server-launch.js";
import { type AgentStart, type PanePlacement, setTerminalProvider, type TerminalProvider } from "./terminal.js";

const mocks = vi.hoisted(() => ({ structured: false,
  launch: vi.fn(), prompt: vi.fn(), holdSettings: vi.fn(), stop: vi.fn(), awaitThread: vi.fn() }));
vi.mock("./codex-servers.js", async importOriginal => ({ ...await importOriginal<typeof import("./codex-servers.js")>(),
  codexAppServerEnabled: () => mocks.structured,
  codexServers: { forPane: () => undefined, launch: mocks.launch, prompt: mocks.prompt, holdSettings: mocks.holdSettings, stop: mocks.stop, awaitThread: mocks.awaitThread } }));

const inventory = (): HarnessInventory => ({ harnesses: ["claude", "codex", "opencode", "copilot"].map(source =>
  ({ source, installed: true, usable: true, accounts: [{ id: "default", label: source, key: source, signedIn: true, usable: true }] })) }) as unknown as HarnessInventory;

describe("launching in a permission mode", () => {
  let home: string, cwd: string, restore: () => void, placements: PanePlacement[], starts: AgentStart[], state: Json;
  beforeEach(() => {
    home = mkdtempSync(path.join(tmpdir(), "phren-launch-mode-"));
    cwd = path.join(home, "project"); mkdirSync(cwd);
    vi.stubEnv("HOME", home); vi.stubEnv("CLAUDE_CONFIG_DIR", ""); vi.stubEnv("PHREN_BRIDGE_HOME", path.join(home, "bridge"));
    setLaunchInventory(async () => inventory());
    mocks.structured = false; for (const fn of [mocks.launch, mocks.prompt, mocks.holdSettings, mocks.stop, mocks.awaitThread]) fn.mockReset();
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

  it("starts Claude with --permission-mode in Claude's own names, ahead of the brief", async () => {
    const wanted = { supervised: "default", "auto-edits": "acceptEdits", auto: "auto", "full-access": "bypassPermissions" };
    for (const [mode, raw] of Object.entries(wanted)) {
      const launched = await launchSession("default", { cwd, label: `Worker ${mode}`, kind: "claude", model: "opus", effort: "high", permissionMode: mode, brief: { id: "b".repeat(8) + "-0000-4000-8000-000000000000", text: "Do it." } });
      expect(launched).toMatchObject({ ok: true, permissionMode: mode });
      const args = starts.at(-1)!.args as string[];
      expect(args.slice(0, 6)).toEqual(["--model", "opus", "--effort", "high", "--permission-mode", raw]);
    }
  });

  it("starts a typed Codex with the matching approval and sandbox flags", async () => {
    const wanted: Record<string, string[]> = {
      supervised: ["-a", "untrusted", "-s", "read-only"],
      "auto-edits": ["-a", "on-request", "-s", "workspace-write"],
      auto: ["-a", "on-request", "-s", "workspace-write", "-c", 'approvals_reviewer="auto_review"'],
      "full-access": ["-a", "never", "-s", "danger-full-access"],
    };
    for (const [mode, flags] of Object.entries(wanted)) {
      const launched = await launchSession("default", { cwd, label: `Codex ${mode}`, kind: "codex", permissionMode: mode });
      expect(launched).toMatchObject({ ok: true, permissionMode: mode });
      expect(starts.at(-1)!.args).toEqual([...flags, "-c", "check_for_update_on_startup=false"]);
    }
  });

  it.each([[true, false], [false, false], [true, true], [false, true]])("retries Codex once after a startup exit (retry starts %s, readiness rejected %s)", async (recovers, rejected) => {
    // The first process exits before readiness even though Herdr still names it Codex.
    let attempts = 0;
    const base = { snapshot: async () => structuredClone(state),
      create: async (_server: string, placement: PanePlacement) => {
        state.workspaces.push({ workspace_id: "w1", label: placement.label });
        state.tabs.push({ tab_id: "w1:t1", workspace_id: "w1", label: placement.label });
        state.panes.push({ pane_id: "w1:p1", tab_id: "w1:t1", workspace_id: "w1" });
      },
      startAgent: async (_server: string, _pane: string, agent: AgentStart) => {
        starts.push(agent); attempts++;
        state.panes[0].agent = "codex";
        state.panes[0].agent_status = recovers && attempts === 2 ? "idle" : "unknown";
        state.panes[0].agent_session = { kind: "id", agent: "codex", value: "00000004-2222-4222-8222-222222222222" };
        if (rejected && !(recovers && attempts === 2)) throw new BridgeError(409, "not an active named agent", { herdrCode: "agent_not_ready" });
      },
      processes: async () => ({ shellPid: 10, foregroundPids: recovers && attempts === 2 ? [11] : [10] }),
      readScreen: async () => attempts ? `Attempt ${attempts}\nnpm install -g @openai/codex\nPlease restart Codex\n\n` : "$ ",
    };
    const undo = setTerminalProvider({ kind: "fake", ...base } as unknown as TerminalProvider);
    try {
      const launch = launchSession("default", { cwd, label: "Restarted", kind: "codex" });
      if (recovers) await expect(launch).resolves.toMatchObject({ ok: true });
      else await expect(launch).rejects.toMatchObject({ message: "Codex exited at start: Please restart Codex" });
      expect(attempts).toBe(2);
      expect(state.panes).toHaveLength(1);
      expect(starts[1].args).toEqual(starts[0].args);
    } finally { undo(); }
  });

  it("waits for a delayed Codex start without retrying it", async () => {
    vi.useFakeTimers();
    let attempts = 0, running = false;
    const undo = setTerminalProvider({
      kind: "fake", snapshot: async () => ({ panes: [{ pane_id: "w1:p1", agent: running ? "codex" : undefined, agent_status: running ? "idle" : "unknown",
        agent_session: { kind: "id", agent: "codex", value: "00000004-2222-4222-8222-222222222222" } }] }),
      startAgent: async () => { attempts++; await new Promise(resolve => setTimeout(resolve, 3_000)); running = true; },
      processes: async () => ({ shellPid: 10, foregroundPids: running ? [11] : [10] }),
      readScreen: async () => "$ ",
    } as unknown as TerminalProvider);
    try {
      let settled = false;
      const launch = launchSession("default", { cwd, label: "Delayed", kind: "codex" },
        { into: { workspaceId: "w1", tabId: "w1:t1", paneId: "w1:p1" } });
      const completed = expect(launch).resolves.toMatchObject({ ok: true }).then(() => { settled = true; });
      await vi.advanceTimersByTimeAsync(2_000);
      expect(attempts).toBe(1);
      expect(settled).toBe(false);
      await vi.advanceTimersByTimeAsync(2_000);
      await completed;
      expect(attempts).toBe(1);
      expect(running).toBe(true);
    } finally { undo(); vi.useRealTimers(); }
  });

  it.each([true, false])("settles each starter before retrying or reporting an exit (retry starts %s)", async recovers => {
    vi.useFakeTimers();
    let attempts = 0, pending = 0, running = false;
    const undo = setTerminalProvider({
      kind: "fake", snapshot: async () => ({ panes: [{ pane_id: "w1:p1", agent: "codex", agent_status: running ? "idle" : "unknown",
        agent_session: { kind: "id", agent: "codex", value: "00000004-2222-4222-8222-222222222222" } }] }),
      startAgent: async () => {
        expect(pending).toBe(0);
        attempts++; pending++;
        await new Promise(resolve => setTimeout(resolve, 1_500));
        pending--; running = recovers && attempts === 2;
      },
      processes: async () => ({ shellPid: 10, foregroundPids: running ? [11] : [10] }),
      readScreen: async () => attempts ? `Attempt ${attempts}\nPlease restart Codex` : "$ ",
    } as unknown as TerminalProvider);
    try {
      let settled = false;
      const launch = launchSession("default", { cwd, label: "Waiting", kind: "codex" },
        { into: { workspaceId: "w1", tabId: "w1:t1", paneId: "w1:p1" } });
      const outcome = recovers ? expect(launch).resolves.toMatchObject({ ok: true })
        : expect(launch).rejects.toMatchObject({ message: "Codex exited at start: Please restart Codex" });
      const completed = outcome.then(() => { expect(pending).toBe(0); settled = true; });
      await vi.advanceTimersByTimeAsync(1_250);
      expect(attempts).toBe(1);
      expect(settled).toBe(false);
      await vi.advanceTimersByTimeAsync(1_500);
      expect(attempts).toBe(2);
      expect(settled).toBe(false);
      await vi.advanceTimersByTimeAsync(1_000);
      await completed;
      expect(attempts).toBe(2);
    } finally { undo(); vi.useRealTimers(); }
  });

  it("starts Copilot with its model, reasoning effort and the tool approvals of the mode", async () => {
    const wanted: Record<string, string[]> = {
      supervised: [],
      "auto-edits": ["--allow-tool=write"],
      auto: ["--allow-all-tools"],
      "full-access": ["--allow-all"],
    };
    for (const [mode, flags] of Object.entries(wanted)) {
      const launched = await launchSession("default", { cwd, label: `Copilot ${mode}`, kind: "copilot", model: "gpt-6-sol", effort: "high", permissionMode: mode });
      expect(launched).toMatchObject({ ok: true, permissionMode: mode });
      expect(starts.at(-1)!.args).toEqual(["--model", "gpt-6-sol", "--reasoning-effort", "high", ...flags]);
    }
  });

  it("launches unchanged without a mode and says nothing about one", async () => {
    mocks.structured = false;
    const launched = await launchSession("default", { cwd, label: "Plain", kind: "claude" });
    expect(launched).not.toHaveProperty("permissionMode");
    expect(starts[0].args).toEqual([]);
  });

  it("holds the mode for the app-server thread's first turn, before the brief is sent", async () => {
    mocks.structured = true;
    const order: string[] = [];
    const entry = { id: "s1", threadId: "thread-1" };
    mocks.launch.mockResolvedValue({ entry, args: ["resume", "thread-1", "--remote", "unix:///tmp/s.sock"] });
    mocks.holdSettings.mockImplementation(() => { order.push("hold"); });
    mocks.prompt.mockImplementation(async () => { order.push("prompt"); });
    const launched = await launchSession("default", { cwd, label: "Served", kind: "codex", permissionMode: "auto", brief: { id: "c".repeat(8) + "-0000-4000-8000-000000000000", text: "Do it." } });
    expect(launched).toMatchObject({ ok: true, permissionMode: "auto", briefLaunched: true });
    expect(order).toEqual(["hold", "prompt"]);
    expect(mocks.holdSettings).toHaveBeenCalledWith(entry, { approvalPolicy: "on-request", approvalsReviewer: "auto_review", sandboxPolicy: { type: "workspaceWrite" } });
    // The resumed TUI must also skip its startup update screen.
    expect(starts[0].args).toEqual(["resume", "thread-1", "--remote", "unix:///tmp/s.sock", "-c", "check_for_update_on_startup=false"]);
  });

  it("gives a TUI-started app-server thread the mode as remote flags when there is no brief", async () => {
    mocks.structured = true;
    mocks.launch.mockResolvedValue({ entry: { id: "s2" }, args: ["--remote", "unix:///tmp/s.sock"] });
    await launchSession("default", { cwd, label: "Served", kind: "codex", permissionMode: "full-access" });
    expect(mocks.launch.mock.calls[0][1]).toMatchObject({ startThread: false, remoteArgs: ["-a", "never", "-s", "danger-full-access"] });
    expect(mocks.holdSettings).not.toHaveBeenCalled();
  });

  it("refuses a conductor, OpenCode and an unknown mode with 400 before any pane exists", async () => {
    const refused = [
      { kind: "claude", role: "conductor", permissionMode: "auto" },
      { kind: "opencode", permissionMode: "auto" },
      { kind: "claude", permissionMode: "yolo" },
    ];
    for (const request of refused) await expect(launchSession("default", { cwd, label: "X", ...request })).rejects.toThrow();
    await expect(launchSession("default", { cwd, label: "X", kind: "opencode", permissionMode: "auto" })).rejects.toMatchObject({ status: 400, message: expect.stringContaining("OpenCode takes its permissions") });
    await expect(launchSession("default", { cwd, label: "X", kind: "claude", role: "conductor", permissionMode: "auto" })).rejects.toMatchObject({ status: 400 });
    expect(placements).toHaveLength(0);
  });
});
