import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { clearAccountCaches } from "./claude-accounts.js";
import { setChoiceReaders } from "./account-choice.js";
import type { AccountUsage } from "./usage.js";
import type { HarnessInventory } from "./harnesses.js";
import { paneAccount, paneAccountKey } from "./pane-accounts.js";
import type { Json } from "./protocol.js";
import { launchSession, setLaunchInventory } from "./server-launch.js";
import { type AgentStart, type PanePlacement, setTerminalProvider, type TerminalProvider } from "./terminal.js";

const inventory = (over: Partial<Record<string, unknown>> = {}): HarnessInventory => ({ harnesses: [
  { source: "claude", installed: true, usable: true, accounts: [
    { id: "default", label: "Claude", key: "k1", signedIn: true, usable: true },
    { id: "work", label: "Work", key: "k2", signedIn: true, usable: true },
    { id: "out", label: "Out", key: "k3", signedIn: false, usable: false, reason: "Not signed in" }] },
  { source: "codex", installed: true, usable: true, accounts: [{ id: "default", label: "Codex", key: "codex", signedIn: true, usable: true }] },
  { source: "opencode", installed: false, usable: false, reason: "Not installed" },
  ...(over.extra as never[] ?? []),
] });

describe("launching under a Claude account", () => {
  let home: string, cwd: string, restore: () => void, placements: PanePlacement[], starts: AgentStart[], state: Json;
  beforeEach(() => {
    home = mkdtempSync(path.join(tmpdir(), "phren-launch-accounts-"));
    cwd = path.join(home, "project"); mkdirSync(cwd);
    mkdirSync(path.join(home, ".claude-work")); writeFileSync(path.join(home, ".claude-work", ".claude.json"), "{}");
    vi.stubEnv("HOME", home); vi.stubEnv("CLAUDE_CONFIG_DIR", ""); vi.stubEnv("PHREN_BRIDGE_HOME", path.join(home, "bridge"));
    clearAccountCaches();
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

  it("sets CLAUDE_CONFIG_DIR for the pane and the agent, trusts the folder in that home, and remembers the pane's account", async () => {
    const launched = await launchSession("default", { cwd, label: "Worker", kind: "claude", account: "work" }, { trustFolder: true });
    const dir = path.join(home, ".claude-work");
    expect(launched).toMatchObject({ ok: true, account: "work" });
    expect(placements[0].env).toEqual({ CLAUDE_CONFIG_DIR: dir });
    expect(starts[0].env).toEqual({ CLAUDE_CONFIG_DIR: dir });
    expect(readFileSync(path.join(dir, ".claude.json"), "utf8")).toContain("hasTrustDialogAccepted");
    expect(paneAccount(paneAccountKey("default", "w1:p1"), "term-1")).toMatchObject({ id: "work" });
  });

  it("runs a launch that names no account under the one with the most room, and never overrides a named one", async () => {
    const usage = (id: string, used: number): AccountUsage => ({ source: "claude", account: { id, label: id, key: id }, windows: [{ id: "five_hour", name: "5-hour", usedPercent: used, resetsAt: new Date(Date.now() + 3_600_000).toISOString() }] });
    setChoiceReaders({ usage: async () => [usage("default", 95), usage("work", 20)], inventory: async () => inventory() });
    try {
      const chosen = await launchSession("default", { cwd, label: "A", kind: "claude" });
      expect(chosen).toMatchObject({ account: "work", accountChoice: expect.stringContaining("most headroom: work (80% 5-hour left") });
      expect(placements[0].env).toEqual({ CLAUDE_CONFIG_DIR: path.join(home, ".claude-work") });
      const pinned = await launchSession("default", { cwd, label: "B", kind: "claude", account: "default" });
      expect(pinned).toMatchObject({ account: "default" });
      expect(pinned).not.toHaveProperty("accountChoice");
    } finally { setChoiceReaders({}); }
  });

  it("launches unchanged without an account, and for the default account", async () => {
    const plain = await launchSession("default", { cwd, label: "A", kind: "claude" });
    expect(plain).not.toHaveProperty("account");
    expect(placements[0].env).toBeUndefined();
    await launchSession("default", { cwd, label: "B", kind: "claude", account: "default" });
    expect(placements[1].env).toBeUndefined();
  });

  it("refuses an unknown, signed-out or unsupported account with 409 account_unavailable before creating a pane", async () => {
    for (const request of [{ kind: "claude", account: "nope" }, { kind: "claude", account: "out" }, { kind: "codex", account: "work" }]) {
      await expect(launchSession("default", { cwd, label: "X", ...request })).rejects.toMatchObject({ status: 409, details: { code: "account_unavailable" } });
    }
    await expect(launchSession("default", { cwd, label: "X", kind: "claude", account: "Bad Slug" })).rejects.toThrow();
    expect(placements).toHaveLength(0);
  });

  it("refuses a harness that is not installed with 409 harness_unavailable", async () => {
    await expect(launchSession("default", { cwd, label: "X", kind: "opencode" })).rejects.toMatchObject({ status: 409, details: { code: "harness_unavailable" } });
    expect(placements).toHaveLength(0);
  });

  it("goes on when the inventory cannot be read", async () => {
    setLaunchInventory(async () => { throw new Error("probe failed"); });
    expect(await launchSession("default", { cwd, label: "X", kind: "claude" })).toMatchObject({ ok: true });
  });
});
