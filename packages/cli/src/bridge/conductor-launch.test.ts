import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { HarnessInventory } from "./harnesses.js";
import { objects, type Json } from "./protocol.js";
import { resetRoleState } from "./conductor-role.js";
import { launchSession, localConductor, makeConductor, setLaunchInventory, stopConductor } from "./server-launch.js";
import { type AgentStart, type PanePlacement, setTerminalProvider, type TerminalProvider } from "./terminal.js";

const mocks = vi.hoisted(() => ({ servers: ["default"], peers: [] as Json[], answer: vi.fn() }));
vi.mock("./herdr.js", async importOriginal => ({ ...await importOriginal<typeof import("./herdr.js")>(),
  servers: async () => mocks.servers.map(session => ({ session })) }));
vi.mock("./peers.js", async importOriginal => ({ ...await importOriginal<typeof import("./peers.js")>(),
  optionalHookPeers: async () => ({ peers: mocks.peers }), peerRequest: mocks.answer }));

const inventory = (): HarnessInventory => ({ harnesses: ["claude", "codex", "opencode"].map(source =>
  ({ source, installed: true, usable: true, accounts: [{ id: "default", label: source, key: source, signedIn: true, usable: true }] })) }) as unknown as HarnessInventory;
const session = (n: number) => `aaaaaaaa-1111-4111-8111-00000000000${n}`;
const hostKey = "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIEp8VWGvSO7U7OMdQo3CQgkVv41Gw2cztUk5uiefMuhg";

/** Herdr keeps an agent's name in `agents`; tmux reports its `@phren_agent` as the pane's `agent_name`. */
for (const mux of [{ kind: "Herdr", server: "default" }, { kind: "tmux", server: "tmux" }]) describe(`the conductor role on ${mux.kind}`, () => {
  let home: string, cwd: string, restore: () => void, state: Json, sessions: number;
  const pane = (id: string) => objects(state.panes).find(p => p.pane_id === id)!;
  /** The agent in `id` exits and a new one starts: a new session, and the multiplexer forgot its name. */
  const restart = (id: string) => {
    const p = pane(id);
    p.agent_session = { kind: "id", agent: p.agent, value: session(++sessions) };
    delete p.agent_name; state.agents = objects(state.agents).filter(agent => agent.pane_id !== id);
  };
  const saved = () => JSON.parse(readFileSync(path.join(home, "bridge", "conductor-role.json"), "utf8")) as Json;

  beforeEach(() => {
    home = mkdtempSync(path.join(tmpdir(), "phren-conductor-launch-"));
    cwd = path.join(home, "store"); mkdirSync(cwd);
    vi.stubEnv("HOME", home); vi.stubEnv("PHREN_BRIDGE_HOME", path.join(home, "bridge")); vi.stubEnv("XDG_CONFIG_HOME", path.join(home, ".config"));
    setLaunchInventory(async () => inventory());
    resetRoleState();
    mocks.servers = [mux.server]; mocks.peers = []; mocks.answer.mockReset();
    state = { workspaces: [], tabs: [], panes: [], agents: [] }; sessions = 0;
    restore = setTerminalProvider({
      kind: "fake",
      snapshot: async () => structuredClone(state),
      create: async (_server: string, placement: PanePlacement) => {
        const n = objects(state.workspaces).length + 1;
        state.workspaces.push({ workspace_id: `w${n}`, label: placement.label });
        state.tabs.push({ tab_id: `w${n}:t1`, workspace_id: `w${n}`, label: placement.label });
        state.panes.push({ pane_id: `w${n}:p1`, tab_id: `w${n}:t1`, workspace_id: `w${n}`, terminal_id: `term-${n}` });
      },
      startAgent: async (_server: string, id: string, agent: AgentStart) => {
        const p = pane(id);
        Object.assign(p, { agent: agent.kind, agent_status: "idle", agent_session: { kind: "id", agent: agent.kind, value: session(++sessions) } });
        if (mux.kind === "tmux") p.agent_name = agent.name; else state.agents.push({ pane_id: id, agent: agent.kind, name: agent.name });
      },
    } as unknown as TerminalProvider);
  });
  afterEach(() => { restore(); setLaunchInventory(undefined); resetRoleState(); vi.unstubAllEnvs(); rmSync(home, { recursive: true, force: true }); });

  it("records a launched conductor and keeps the role through a restart in its pane", async () => {
    const launched = await launchSession(mux.server, { cwd, label: "Conductor", kind: "claude", role: "conductor" });
    expect(launched).toMatchObject({ ok: true, role: "conductor", paneId: "w1:p1" });
    expect(saved().conductor).toMatchObject({ server: mux.server, pane: "w1:p1", terminal: "term-1", by: "launch", session: session(1) });
    restart("w1:p1");
    expect(await localConductor()).toMatchObject({ server: mux.server, target: { pane: "w1:p1", session: session(2) } });
    expect(saved().conductor).toMatchObject({ pane: "w1:p1", session: session(2), by: "launch" });
    // A second conductor on this computer is refused, whatever it is called.
    await expect(launchSession(mux.server, { cwd, label: "Other", kind: "claude", role: "conductor" })).rejects.toMatchObject({ status: 409 });
    // A worker asked into the conductor's workspace gets its own, even with the conductor's name gone.
    const worker = await launchSession(mux.server, { cwd, label: "Worker", kind: "codex", workspaceId: "w1" });
    expect(worker.workspaceId).not.toBe("w1");
  });

  it("makes and stops a conductor for an agent already running, one per computer", async () => {
    await launchSession(mux.server, { cwd, label: "Lead", kind: "claude" });
    await launchSession(mux.server, { cwd, label: "Helper", kind: "codex" });
    expect(await localConductor()).toBeUndefined();
    const made = await makeConductor(mux.server, { workspaceId: "w1", tabId: "w1:t1", paneId: "w1:p1" });
    expect(made).toMatchObject({ ok: true, conductor: { server: mux.server, target: { pane: "w1:p1", session: session(1) } } });
    expect(saved().conductor).toMatchObject({ pane: "w1:p1", by: "owner" });
    // Making it again is fine; another pane is refused until this one stops.
    await expect(makeConductor(mux.server, { paneId: "w1:p1" })).resolves.toMatchObject({ ok: true });
    await expect(makeConductor(mux.server, { paneId: "w2:p1" })).rejects.toMatchObject({ status: 409 });
    await expect(stopConductor({ paneId: "w2:p1" })).rejects.toMatchObject({ status: 409 });
    expect(await stopConductor({ paneId: "w1:p1" })).toEqual({ ok: true, stopped: true });
    expect(await localConductor()).toBeUndefined();
    await expect(makeConductor(mux.server, { paneId: "w2:p1" })).resolves.toMatchObject({ ok: true });
    await expect(makeConductor(mux.server, { paneId: "w9:p1" })).rejects.toMatchObject({ status: 409, message: "The pane changed." });
  });

  it("migrates a conductor started before the record from its name, and a stop ends the name's role", async () => {
    // An older Hook named its conductor and kept no record.
    await launchSession(mux.server, { cwd, label: "Lead", kind: "claude" });
    if (mux.kind === "tmux") pane("w1:p1").agent_name = "conductor-lead"; else objects(state.agents)[0].name = "conductor-lead";
    rmSync(path.join(home, "bridge", "conductor-role.json"), { force: true }); resetRoleState();
    expect(await localConductor()).toMatchObject({ target: { pane: "w1:p1" } });
    expect(saved().conductor).toMatchObject({ pane: "w1:p1", by: "migrated" });
    await stopConductor({});
    expect(await localConductor()).toBeUndefined();
  });

  it("refuses a conductor when a member of the set has one, not when a one-way peer does", async () => {
    const peer = { name: "Mini", address: "mini.example", username: "sam", port: 22, server: "default", hostKey };
    mocks.peers = [peer];
    const remote = { server: "default", target: { server: "default", workspace: "w5", tab: "w5:t1", pane: "w5:p1", source: "codex" } };
    mocks.answer.mockResolvedValue({ computer: { id: "30000000-0000-4000-8000-000000000001", name: "Mini" }, conductor: remote, peers: ["Omarchy"], knowsCaller: true });
    await expect(launchSession(mux.server, { cwd, label: "Conductor", kind: "claude", role: "conductor" })).rejects.toMatchObject({ status: 409, details: { computer: "Mini" } });
    expect(mocks.answer.mock.calls[0][1]).toMatch(/^\/v1\/conductor\?name=/);
    mocks.answer.mockResolvedValue({ computer: { id: "30000000-0000-4000-8000-000000000001", name: "Mini" }, conductor: remote, peers: [], knowsCaller: false });
    await expect(launchSession(mux.server, { cwd, label: "Conductor", kind: "claude", role: "conductor" })).resolves.toMatchObject({ ok: true, role: "conductor" });
  });
});
