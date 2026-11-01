import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import type { IncomingMessage, ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ZodError } from "zod";
import { BUILTIN_MODULES } from "../modules/registry.js";
import { bindingPath } from "./agent-hook-stores.js";
import { resetSharedHerdrState } from "./herdr.js";
import { writeLaunchBrief } from "./launch-brief.js";
import { BridgeError, type Json } from "./protocol.js";
import { setTerminalProvider, type TerminalProvider } from "./terminal.js";
import { noteTurn } from "./turn-records.js";

const mocks = vi.hoisted(() => ({
  servers: vi.fn(async (): Promise<Json[]> => []),
  freshServers: vi.fn(async (): Promise<Json[]> => []),
  peers: vi.fn(async (): Promise<Json[]> => []),
  request: vi.fn(),
}));
vi.mock("./herdr.js", async original => ({ ...await original<typeof import("./herdr.js")>(),
  recentServers: mocks.servers, servers: mocks.freshServers }));
vi.mock("./peers.js", async original => ({ ...await original<typeof import("./peers.js")>(), hookPeers: mocks.peers, peerRequest: mocks.request }));

const { capabilitiesForModules, createRouteHandler } = await import("./server-routes.js");

const recorded = (): Json => ({
  tabs: [
    { tab_id: "w1:t1", workspace_id: "w1", label: "docs", agent_status: "working" },
    { tab_id: "w2:t1", workspace_id: "w2", label: "checks", agent_status: "blocked" },
  ],
  panes: [
    { pane_id: "w1:p1", tab_id: "w1:t1", workspace_id: "w1", title: "Build the docs", agent: "claude", agent_status: "working" },
    { pane_id: "w2:p1", tab_id: "w2:t1", workspace_id: "w2", title: "Run the tests", agent: "codex", agent_status: "blocked" },
  ],
});

let root: string, snapshots: Record<string, Json>, failures: Record<string, unknown>;
let restore: (() => void) | undefined;

beforeEach(async () => {
  vi.resetAllMocks();
  resetSharedHerdrState();
  root = await mkdtemp(path.join(tmpdir(), "phren-terminal-resolve-"));
  vi.stubEnv("PHREN_BRIDGE_HOME", root);
  failures = {};
  snapshots = { default: recorded() };
  mocks.servers.mockResolvedValue([{ session: "default" }]);
  mocks.freshServers.mockResolvedValue([]);
  mocks.peers.mockResolvedValue([]);
  restore = setTerminalProvider({ kind: "fake", snapshot: async server => {
    if (failures[server]) throw failures[server];
    return snapshots[server] ?? {};
  } } as unknown as TerminalProvider);
});
afterEach(async () => {
  restore?.(); restore = undefined; resetSharedHerdrState(); vi.unstubAllEnvs();
  await rm(root, { recursive: true, force: true });
});

async function request(query: string, computer: Record<string, unknown> = { id: "00000000-0000-4000-8000-0000000000aa", name: "Self" }): Promise<{ status: number; body: Json }> {
  const handler = createRouteHandler({ modules: { has: () => true, modules: BUILTIN_MODULES }, info: { computer }, streams: {} } as never);
  const incoming = Readable.from([]) as IncomingMessage;
  incoming.method = "GET"; incoming.url = `/v1/terminals/resolve${query}`; incoming.headers = {};
  let payload = "";
  const response = { statusCode: 200, setHeader() {}, end(value: string) { payload = value; } };
  await handler(incoming, response as unknown as ServerResponse);
  return { status: response.statusCode, body: JSON.parse(payload) as Json };
}
const resolve = (ref?: string, extra: Record<string, string> = {}, computer?: Record<string, unknown>) =>
  request(`?${new URLSearchParams({ ...(ref === undefined ? {} : { ref }), ...extra })}`, computer);

describe("terminal references from chat text", () => {
  it("advertises the capability only with the Hook module", () => {
    const hook = { has: (name: string) => name === "hook", modules: BUILTIN_MODULES.filter(module => module.name === "hook") };
    expect(capabilitiesForModules(hook as never).terminalResolve).toBe(true);
    expect(capabilitiesForModules({ has: () => false, modules: [] } as never)).not.toHaveProperty("terminalResolve");
  });

  it("resolves a bare pane with its title, agent and status", async () => {
    expect(await resolve("w1:p1")).toEqual({ status: 200, body: { computer: "Self", server: "default", pane: "w1:p1", tab: "w1:t1",
      workspace: "w1", title: "Build the docs", agent: "claude", status: "working" } });
  });

  it("resolves a bare tab to the pane it shows", async () => {
    expect(await resolve("w2:t1")).toEqual({ status: 200, body: { computer: "Self", server: "default", pane: "w2:p1", tab: "w2:t1",
      workspace: "w2", title: "Run the tests", agent: "codex", status: "blocked" } });
  });

  it("answers 404 terminal-not-found for a pane or tab that is gone", async () => {
    expect(await resolve("w9:p9")).toMatchObject({ status: 404, body: { code: "terminal-not-found" } });
    expect(await resolve("w9:t9")).toMatchObject({ status: 404, body: { code: "terminal-not-found" } });
  });

  it("reports a failed snapshot instead of claiming an unread terminal is absent", async () => {
    mocks.servers.mockResolvedValue([{ session: "default" }, { session: "work" }]);
    failures = { work: new BridgeError(503, "Herdr is not reachable on this computer (EACCES).", { code: "herdr-permission" }) };
    expect(await resolve("w9:p9")).toMatchObject({ status: 503, body: { code: "herdr-permission" } });
  });

  it("finds a terminal on a server discovered after the shared list was cached", async () => {
    snapshots = {
      default: recorded(),
      work: { tabs: [], panes: [{ pane_id: "w7:p1", tab_id: "w7:t1", workspace_id: "w7", title: "New server", agent: "codex", agent_status: "idle" }] },
    };
    mocks.freshServers.mockResolvedValue([{ session: "default" }, { session: "work" }]);
    expect(await resolve("w7:p1")).toMatchObject({ status: 200, body: { server: "work", title: "New server" } });
    expect(mocks.freshServers).toHaveBeenCalledTimes(1);
  });

  it("refreshes discovery before matching a duplicate id on the wrong server", async () => {
    snapshots = {
      default: recorded(),
      work: { tabs: [], panes: [
        { pane_id: "w1:p1", tab_id: "w1:t1", workspace_id: "w1", title: "Right server", agent: "codex", agent_status: "working" },
        { pane_id: "w8:p1", tab_id: "w8:t1", workspace_id: "w8", title: "Origin", agent: "claude", agent_status: "idle" },
      ] },
    };
    mocks.freshServers.mockResolvedValue([{ session: "default" }, { session: "work" }]);
    expect(await resolve("w1:p1", { from: "w8:p1" })).toMatchObject({ status: 200, body: { server: "work", title: "Right server" } });
    expect(mocks.freshServers).toHaveBeenCalledTimes(1);
  });

  it("resolves a renamed pane under its pane label, not its old harness title", async () => {
    const pane = (snapshots.default.panes as Json[])[0]!;
    pane.label = "Tide charts";
    expect(await resolve("w1:p1")).toMatchObject({ status: 200, body: { title: "Tide charts" } });
  });

  it("names a dispatched worker by its dispatch label, not the brief-derived title", async () => {
    const session = "00000001-1111-4111-8111-111111111111", dispatch = "40000000-0000-4000-8000-000000000001";
    snapshots = { default: {
      workspaces: [{ workspace_id: "w1", label: "phren" }],
      tabs: [{ tab_id: "w1:t1", workspace_id: "w1", label: "docs" }],
      panes: [{ pane_id: "w1:p1", tab_id: "w1:t1", workspace_id: "w1", terminal_id: "term-1",
        title: "Read and follow the brief in /home/sam/bridge/briefs/x/brief.md", agent: "claude", agent_status: "idle",
        agent_session: { kind: "id", agent: "claude", value: session } }],
    } };
    await noteTurn("default", "w1:p1", { event: "UserPromptSubmit", terminal: "term-1", source: "claude", session, dispatch });
    await writeLaunchBrief({ id: dispatch, text: "Do the work" }, Date.now(), "Worker name");
    expect(await resolve("w1:p1")).toMatchObject({ status: 200, body: { title: "Worker name", agent: "claude", status: "idle" } });
  });

  it("names a dispatched worker from the Hook's binding when Herdr reports no session", async () => {
    const session = "00000002-1111-4111-8111-111111111111", dispatch = "40000000-0000-4000-8000-000000000002";
    snapshots = { default: {
      workspaces: [{ workspace_id: "w1", label: "phren" }],
      tabs: [{ tab_id: "w1:t1", workspace_id: "w1", label: "docs" }],
      panes: [{ pane_id: "w1:p1", tab_id: "w1:t1", workspace_id: "w1", terminal_id: "term-1",
        title: "Read and follow the brief in /home/sam/bridge/briefs/y/brief.md", agent: "claude", agent_status: "idle" }],
    } };
    await mkdir(path.dirname(bindingPath("default", "w1:p1")), { recursive: true });
    await writeFile(bindingPath("default", "w1:p1"), JSON.stringify({ terminal: "term-1", source: "claude", session }));
    await noteTurn("default", "w1:p1", { event: "UserPromptSubmit", terminal: "term-1", source: "claude", session, dispatch });
    await writeLaunchBrief({ id: dispatch, text: "Do the work" }, Date.now(), "Bound worker");
    expect(await resolve("w1:p1")).toMatchObject({ status: 200, body: { title: "Bound worker", agent: "claude", status: "idle" } });
  });

  it.each(["", "w1", "w1:x1", "w1:p", "w1:p1 ", "w1:p1\n", "https://host/w1:p1", "w1:p1/extra", "../w1:p1"])("answers 400 to the malformed reference %j", async ref => {
    expect(await resolve(ref)).toMatchObject({ status: 400 });
  });

  it("answers 400 when no reference was sent", async () => {
    expect(await request("")).toMatchObject({ status: 400 });
  });

  it("resolves this computer's own name prefix locally", async () => {
    expect(await resolve("self/w1:p1")).toMatchObject({ status: 200, body: { computer: "Self", pane: "w1:p1", title: "Build the docs" } });
    expect(mocks.request).not.toHaveBeenCalled();
  });

  it("answers 404 for a computer that is neither this one nor a verified peer", async () => {
    expect(await resolve("Devbox/w1:p1")).toMatchObject({ status: 404, body: { code: "terminal-not-found" } });
    expect(mocks.request).not.toHaveBeenCalled();
  });

  it("answers 404, not a hooks.yaml error, when this Hook has no peers", async () => {
    mocks.peers.mockRejectedValue(new BridgeError(409, "Configure peers and verified host keys in the Hook's hooks.yaml first.", { hooksYaml: "missing" }));
    expect(await resolve("Devbox/w1:p1")).toMatchObject({ status: 404, body: { code: "terminal-not-found" } });
  });

  it("propagates a broken hooks.yaml instead of treating its computers as unknown", async () => {
    mocks.peers.mockRejectedValue(new ZodError([]));
    expect(await resolve("Devbox/w1:p1")).toMatchObject({ status: 400 });
  });

  it("forwards a peer-prefixed reference to that computer's Hook", async () => {
    const peer = { name: "Devbox", address: "devbox.invalid", username: "owner", port: 22, server: "default", hostKey: "ssh-ed25519 fixture" };
    const remote = { computer: "Devbox", server: "work", pane: "w9:p1", tab: "w9:t1", workspace: "w9", title: "Remote build", agent: "claude", status: "idle" };
    mocks.peers.mockResolvedValue([peer]);
    mocks.request.mockResolvedValue(remote);
    expect(await resolve("Devbox/w9:p1")).toEqual({ status: 200, body: remote });
    expect(mocks.request).toHaveBeenCalledWith(peer, "/v1/terminals/resolve?ref=w9%3Ap1");
  });

  it("uses the pane the text came from to choose its server", async () => {
    const pane = (title: string, agent: string, status: string): Json => ({ pane_id: "w1:p1", tab_id: "w1:t1", workspace_id: "w1", title, agent, agent_status: status });
    snapshots = {
      default: { tabs: [], panes: [pane("Wrong server", "claude", "idle")] },
      work: { tabs: [], panes: [pane("Right server", "codex", "working"), { pane_id: "w8:p1", tab_id: "w8:t1", workspace_id: "w8", title: "Origin", agent: "claude", agent_status: "idle" }] },
    };
    mocks.servers.mockResolvedValue([{ session: "default" }, { session: "work" }]);
    expect(await resolve("w1:p1", { from: "w8:p1" })).toMatchObject({ status: 200, body: { server: "work", title: "Right server" } });
  });
});
