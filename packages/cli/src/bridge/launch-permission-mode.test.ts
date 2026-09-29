import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { HarnessInventory } from "./harnesses.js";
import type { Json } from "./protocol.js";
import { launchSession, setLaunchInventory } from "./server-launch.js";
import { type AgentStart, type PanePlacement, setTerminalProvider, type TerminalProvider } from "./terminal.js";

const mocks = vi.hoisted(() => ({ structured: false,
  launch: vi.fn(), prompt: vi.fn(), holdSettings: vi.fn(), stop: vi.fn(), awaitThread: vi.fn() }));
vi.mock("./codex-servers.js", async importOriginal => ({ ...await importOriginal<typeof import("./codex-servers.js")>(),
  codexAppServerEnabled: () => mocks.structured,
  codexServers: { launch: mocks.launch, prompt: mocks.prompt, holdSettings: mocks.holdSettings, stop: mocks.stop, awaitThread: mocks.awaitThread } }));

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
      expect(starts.at(-1)!.args).toEqual(flags);
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
    // The pane joins a thread that already exists, so it has no flags of its own.
    expect(starts[0].args).toEqual(["resume", "thread-1", "--remote", "unix:///tmp/s.sock"]);
  });

  it("gives a TUI-started app-server thread the mode as remote flags when there is no brief", async () => {
    mocks.structured = true;
    mocks.launch.mockResolvedValue({ entry: { id: "s2" }, args: ["--remote", "unix:///tmp/s.sock"] });
    await launchSession("default", { cwd, label: "Served", kind: "codex", permissionMode: "full-access" });
    expect(mocks.launch.mock.calls[0][1]).toMatchObject({ startThread: false, remoteArgs: ["-a", "never", "-s", "danger-full-access"] });
    expect(mocks.holdSettings).not.toHaveBeenCalled();
  });

  it("refuses a conductor, OpenCode, Copilot and an unknown mode with 400 before any pane exists", async () => {
    const refused = [
      { kind: "claude", role: "conductor", permissionMode: "auto" },
      { kind: "opencode", permissionMode: "auto" },
      { kind: "copilot", permissionMode: "auto" },
      { kind: "claude", permissionMode: "yolo" },
    ];
    for (const request of refused) await expect(launchSession("default", { cwd, label: "X", ...request })).rejects.toThrow();
    await expect(launchSession("default", { cwd, label: "X", kind: "opencode", permissionMode: "auto" })).rejects.toMatchObject({ status: 400, message: expect.stringContaining("OpenCode takes its permissions") });
    await expect(launchSession("default", { cwd, label: "X", kind: "claude", role: "conductor", permissionMode: "auto" })).rejects.toMatchObject({ status: 400 });
    expect(placements).toHaveLength(0);
  });
});
