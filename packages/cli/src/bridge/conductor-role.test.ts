import { mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { clearConductor, conductorPane, readRoleState, readSetName, recordConductor, resetRoleState, saveSetName } from "./conductor-role.js";
import { resetSharedHerdrState, workspaceSnapshot } from "./herdr.js";
import { objects, type Json } from "./protocol.js";
import { setTmuxDeps, tmuxSnapshot } from "./terminal-tmux.js";

let root: string;
beforeEach(async () => { root = await mkdtemp(path.join(tmpdir(), "phren-conductor-role-")); vi.stubEnv("PHREN_BRIDGE_HOME", root); resetRoleState(); });
afterEach(async () => { vi.unstubAllEnvs(); resetRoleState(); await rm(root, { recursive: true, force: true }); });

const saved = async () => JSON.parse(await readFile(path.join(root, "conductor-role.json"), "utf8")) as Json;
const role = (s: Json, pane?: string | null) => objects(objects(workspaceSnapshot(s, undefined, undefined, undefined, pane).groups)[0].children)[0].role;

/** One Herdr workspace with Claude in its pane. Newer Herdr keeps the agent's name in `agents`. */
function herdr(options: { name?: string; terminal?: string; session?: string; agent?: string | null } = {}): Json {
  const agent = options.agent === undefined ? "claude" : options.agent;
  return {
    workspaces: [{ workspace_id: "w1", label: "Conductor" }],
    tabs: [{ workspace_id: "w1", tab_id: "w1:t1", label: "1" }],
    panes: [{ workspace_id: "w1", tab_id: "w1:t1", pane_id: "w1:p1", terminal_id: options.terminal ?? "term-1",
      ...(agent ? { agent, agent_status: "idle", agent_session: { kind: "id", agent, value: options.session ?? "aaaaaaaa-1111-4111-8111-111111111111" } } : {}) }],
    agents: options.name && agent ? [{ pane_id: "w1:p1", agent, name: options.name }] : [],
  };
}

describe("the conductor role on Herdr", () => {
  it("migrates a conductor named before the record, then keeps it through a restart that lost the name", async () => {
    expect(await readRoleState()).toBeUndefined();
    const named = herdr({ name: "conductor-lead" });
    expect((await conductorPane("default", named))?.pane_id).toBe("w1:p1");
    expect((await saved()).conductor).toMatchObject({ server: "default", pane: "w1:p1", terminal: "term-1", workspace: "w1", tab: "w1:t1", source: "claude", by: "migrated" });
    // The owner logged out of Claude and back in: Herdr registered the new agent without its name.
    const restarted = herdr({ session: "bbbbbbbb-2222-4222-8222-222222222222" });
    expect((await conductorPane("default", restarted))?.pane_id).toBe("w1:p1");
    expect(role(restarted, "w1:p1")).toBe("conductor");
    // Between runs the pane has only its shell: the role waits there.
    expect((await conductorPane("default", herdr({ agent: null })))?.pane_id).toBe("w1:p1");
    expect(role(herdr({ agent: null }), "w1:p1")).toBeUndefined();
  });

  it("ignores conductor names once the Hook has a record", async () => {
    await clearConductor();
    expect(await conductorPane("default", herdr({ name: "conductor" }))).toBeUndefined();
    expect(role(herdr({ name: "conductor" }), null)).toBeUndefined();
    // Without a record at all, the name still decides, as before.
    expect(role(herdr({ name: "conductor" }))).toBe("conductor");
  });

  it("ends the role when the pane closes or its id belongs to a new terminal", async () => {
    await recordConductor("default", objects(herdr().panes)[0], "owner");
    expect(await conductorPane("default", herdr({ terminal: "term-2" }))).toBeUndefined();
    expect((await saved()).conductor).toBeNull();
    await recordConductor("default", objects(herdr().panes)[0], "owner");
    expect(await conductorPane("other", { panes: [] })).toBeUndefined();
    // Another server's snapshot says nothing about this pane.
    expect((await saved()).conductor).toMatchObject({ pane: "w1:p1" });
    expect(await conductorPane("default", { ...herdr(), panes: [] })).toBeUndefined();
    expect((await saved()).conductor).toBeNull();
  });

  it("follows the pane to another tab", async () => {
    await recordConductor("default", objects(herdr().panes)[0], "launch");
    const moved = herdr();
    objects(moved.panes)[0].tab_id = "w1:t2";
    expect((await conductorPane("default", moved))?.pane_id).toBe("w1:p1");
    expect((await saved()).conductor).toMatchObject({ tab: "w1:t2", by: "launch" });
  });

  it("runs a moved-pane note and a stop one after the other, so the stop is never undone", async () => {
    await recordConductor("default", objects(herdr().panes)[0], "owner");
    const moved = herdr();
    objects(moved.panes)[0].tab_id = "w1:t2";
    await Promise.all([conductorPane("default", moved), clearConductor()]);
    expect((await saved()).conductor).toBeNull();
    resetRoleState();
    expect((await readRoleState())?.conductor).toBeNull();
  });

  it("reads a damaged, oversized or linked role file as no conductor, never a crash or a return to names", async () => {
    const file = path.join(root, "conductor-role.json");
    await writeFile(file, "{not json");
    expect((await readRoleState())?.conductor).toBeNull();
    resetRoleState();
    await writeFile(file, JSON.stringify({ version: 1, conductor: null, pad: "x".repeat(70_000) }));
    expect((await readRoleState())?.conductor).toBeNull();
    resetRoleState();
    await rm(file);
    const elsewhere = path.join(root, "elsewhere.json");
    await writeFile(elsewhere, JSON.stringify({ version: 1, conductor: { server: "default", pane: "w1:p1", since: new Date().toISOString(), by: "owner" } }));
    await symlink(elsewhere, file);
    expect((await readRoleState())?.conductor).toBeNull();
    expect(await conductorPane("default", herdr({ name: "conductor" }))).toBeUndefined();
  });

  it("stops only the pane asked about", async () => {
    await recordConductor("default", objects(herdr().panes)[0], "owner");
    expect(await clearConductor("w9:p9")).toBeUndefined();
    expect((await saved()).conductor).toMatchObject({ pane: "w1:p1" });
    expect(await clearConductor("w1:p1")).toMatchObject({ pane: "w1:p1" });
    expect((await saved()).conductor).toBeNull();
  });
});

describe("the conductor role on tmux", () => {
  const row = (values: Record<string, string>) => ["session_id", "session_name", "session_attached", "session_activity", "window_id", "window_name",
    "window_active", "pane_id", "pane_pid", "pane_tty", "pane_active", "pane_current_path", "pane_current_command", "@phren_agent", "pane_title", "@phren_label"]
    .map(field => values[field] ?? "").join("\t");
  const pane = (agentName: string, shellPid = "500") => row({ session_id: "$1", session_name: "conductor", session_attached: "1", session_activity: "1", window_id: "@1",
    window_name: "claude", window_active: "1", pane_id: "%1", pane_pid: shellPid, pane_tty: "/dev/ttys001", pane_active: "1", pane_current_path: "/store",
    pane_current_command: "claude", "@phren_agent": agentName });
  const ps = (shell = "500", agent = "510") => [`  ${shell}   ${shell}   ${agent} ttys001  -zsh`, `  ${agent}   ${agent}   ${agent} ttys001  claude --effort high`].join("\n");
  let restore: (() => void) | undefined;
  const fake = (panes: string, processes: string) => {
    restore?.();
    restore = setTmuxDeps({ binary: () => "/usr/bin/tmux", version: async () => "tmux 3.4\n", processes: async () => processes, sockets: async () => [], sleep: async () => {},
      run: async (_socket, args) => args[0] === "list-panes" ? panes : "" });
  };
  afterEach(() => { restore?.(); restore = undefined; resetSharedHerdrState(); });

  it("migrates a pane marked @phren_agent conductor-*, keeps it when the name is gone and drops it for a new shell in a reused pane id", async () => {
    fake(pane("conductor-main"), ps());
    const first = await tmuxSnapshot("tmux");
    expect((await conductorPane("tmux", first))?.pane_id).toBe("p1");
    expect((await saved()).conductor).toMatchObject({ server: "tmux", pane: "p1", terminal: "p1:500", by: "migrated" });
    // Claude restarted by hand in the same pane, without the Hook's name.
    fake(pane(""), ps());
    const restarted = await tmuxSnapshot("tmux");
    expect((await conductorPane("tmux", restarted))?.pane_id).toBe("p1");
    expect(role(restarted, "p1")).toBe("conductor");
    // tmux restarted and gave %1 to a new shell: another pane.
    fake(pane("", "900"), ps("900", "910"));
    expect(await conductorPane("tmux", await tmuxSnapshot("tmux"))).toBeUndefined();
    expect((await saved()).conductor).toBeNull();
  });

  it("does not take a tmux conductor name as the role once a conductor was stopped", async () => {
    await clearConductor();
    fake(pane("conductor-main"), ps());
    const s = await tmuxSnapshot("tmux");
    expect(await conductorPane("tmux", s)).toBeUndefined();
    expect(role(s, null)).toBeUndefined();
  });
});

describe("set names", () => {
  it("keeps the newest name, clears with null, and never leaves legacy mode for a name alone", async () => {
    expect(await saveSetName("Home", "2026-09-29T10:00:00.000Z")).toBe(true);
    // Naming the set decides nothing about the conductor.
    expect((await readRoleState())?.conductor).toBeUndefined();
    expect(await saveSetName("Old", "2026-09-29T09:00:00.000Z")).toBe(false);
    expect(await readSetName()).toEqual({ name: "Home", namedAt: "2026-09-29T10:00:00.000Z" });
    expect(await saveSetName(null, "2026-09-29T11:00:00.000Z")).toBe(true);
    expect(await saveSetName("Home", "2026-09-29T10:30:00.000Z")).toBe(false);
    expect(await readSetName()).toEqual({ name: null, namedAt: "2026-09-29T11:00:00.000Z" });
  });
});
