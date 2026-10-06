import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { hookRequest } from "./client.js";
import { hookPeers, optionalHookPeers, peerRequest } from "./peers.js";
import { handOff, listLiveSessions, notLinkedComputers } from "./hand-off.js";

vi.mock("./client.js", () => ({ hookRequest: vi.fn() }));
// This computer's names are synthetic so the real hostname never matters.
vi.mock("./computer-names.js", () => ({ localNames: () => ["Desk.example.net", "Desk"] }));
vi.mock("./peers.js", async original => ({ ...await original<typeof import("./peers.js")>(), hookPeers: vi.fn(), peerRequest: vi.fn(), optionalHookPeers: vi.fn() }));
// The real peers unless a test says otherwise.
beforeEach(async () => {
  const actual = await vi.importActual<typeof import("./peers.js")>("./peers.js");
  vi.mocked(hookPeers).mockImplementation(actual.hookPeers);
  vi.mocked(peerRequest).mockImplementation(actual.peerRequest);
  vi.mocked(optionalHookPeers).mockImplementation(actual.optionalHookPeers);
});
vi.mock("./grants.js", () => ({ findGrant: vi.fn(), grantLabel: vi.fn() }));
afterEach(() => vi.resetAllMocks());

it("resolves an existing session and delivers one prompt through its live target", async () => {
  const target = { server: "default", workspace: "w1", tab: "t1", pane: "p1", source: "codex",
    session: "aaaaaaaa-1111-4111-8111-111111111111" };
  vi.mocked(hookRequest).mockResolvedValueOnce({ groups: [{ children: [{ target }] }] }).mockResolvedValueOnce({ ok: true, delivered: true });
  expect(await handOff({ session: target.session, text: "Review the tests" })).toEqual({ ok: true, delivered: true, target });
  expect(vi.mocked(hookRequest).mock.calls).toEqual([
    ["/v1/workspaces", undefined], ["/v1/hand-off", { target, text: "Review the tests", deliveryId: expect.any(String) }],
  ]);
});

it("names the target by its project folder, from the overview it already read", async () => {
  const target = { server: "default", workspace: "w1", tab: "t1", pane: "p1", source: "claude",
    session: "aaaaaaaa-1111-4111-8111-111111111111" };
  vi.mocked(hookRequest).mockResolvedValueOnce({ groups: [{ label: "Studio", children: [{ target, cwd: "/home/sam/ObjectStudio" }] }] })
    .mockResolvedValueOnce({ ok: true, delivered: true });
  expect(await handOff({ session: target.session, text: "Rebase first" })).toEqual({ ok: true, delivered: true, target, label: "ObjectStudio" });
  expect(vi.mocked(hookRequest).mock.calls).toHaveLength(2);
});

it.each([
  { ok: true },
  { ok: true, deliveryUncertain: true },
  { ok: true, delivered: true, deliveryUncertain: true },
  { ok: true, unsubmitted: true },
])("does not report transport-only or uncertain replies as delivered: %j", async result => {
  const target = { server: "default", workspace: "w1", tab: "t1", pane: "p1", source: "codex",
    session: "aaaaaaaa-1111-4111-8111-111111111111" };
  vi.mocked(hookRequest).mockResolvedValueOnce({ groups: [{ children: [{ target }] }] }).mockResolvedValueOnce(result);
  expect(await handOff({ session: target.session, text: "Review the tests" })).toEqual({
    ok: false, delivered: false, target, deliveryUncertain: true,
    ...("unsubmitted" in result ? { unsubmitted: true } : {}),
  });
  expect(vi.mocked(hookRequest).mock.calls.filter(call => call[0] === "/v1/hand-off")).toHaveLength(1);
});

// hooks.yaml must be mode 0600; Windows files carry no POSIX mode bits, so the
// privacy refusal comes before the parse error this test reads. The Hook supports macOS and Linux only.
it.skipIf(process.platform === "win32")("lists local sessions and says why enrolled computers were skipped when hooks.yaml is broken", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "phren-live-"));
  vi.stubEnv("PHREN_BRIDGE_HOME", root);
  try {
    await writeFile(path.join(root, "hooks.yaml"), "version: 2\ncomputers: []\n", { mode: 0o600 });
    vi.mocked(hookRequest).mockResolvedValueOnce({ computer: { name: "Desk" } }).mockResolvedValueOnce({ groups: [] });
    const live = await listLiveSessions({ store: null });
    expect(live).toMatchObject({ sessions: [], unreachable: [], notLinked: [], enrolled: 0 });
    expect(live.peerError).toMatch(/^hooks\.yaml is invalid at version: /);
  } finally { vi.unstubAllEnvs(); await rm(root, { recursive: true, force: true }); }
});

it("lists registered computers that are not linked and how long each session has been idle", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "phren-live-")), store = path.join(root, "store");
  vi.stubEnv("PHREN_BRIDGE_HOME", root);
  vi.useFakeTimers({ now: new Date("2026-09-22T12:00:00.000Z"), toFake: ["Date"] });
  try {
    await writeFile(path.join(root, "hooks.yaml"), "version: 1\ncomputers: []\n", { mode: 0o600 });
    await mkdir(store);
    await writeFile(path.join(store, "machines.yaml"), "Desk.local: personal\nLinuxbox: work\n");
    const target = { server: "default", workspace: "w1", tab: "t1", pane: "p1", source: "claude", session: "aaaaaaaa-1111-4111-8111-111111111111" };
    vi.mocked(hookRequest).mockResolvedValueOnce({ computer: { name: "Desk" } }).mockResolvedValueOnce({ groups: [{ label: "phren",
      children: [{ agent: "claude", agentStatus: "idle", cwd: "/home/sam/phren", target, lastChangedAt: "2026-09-22T11:55:00.000Z" },
        { agent: "claude", agentStatus: "working", backgroundTasks: 5, cwd: "/home/sam/phren", target }] }] });
    const live = await listLiveSessions({ store });
    expect(live.sessions).toMatchObject([{ computer: "Desk", project: "phren", status: "idle", idleFor: 300 }, { status: "working", backgroundTasks: 5 }]);
    expect(live.sessions[0]).not.toHaveProperty("backgroundTasks");
    expect(live.notLinked).toEqual([{ name: "Linuxbox" }]);
    expect(live.enrolled).toBe(0);
  } finally { vi.useRealTimers(); vi.unstubAllEnvs(); await rm(root, { recursive: true, force: true }); }
});

it("names workers in the conductor's workspace by their own tab, never as the conductor", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "phren-live-"));
  vi.stubEnv("PHREN_BRIDGE_HOME", root);
  try {
    const tab = (id: string, extra: Record<string, unknown>) => ({ id, agent: "claude", cwd: "/home/sam/Projects", ...extra });
    vi.mocked(hookRequest).mockResolvedValueOnce({ computer: { name: "Desk" } }).mockResolvedValueOnce({ groups: [{ label: "Conductor", children: [
      tab("w2:t1", { label: "1", role: "conductor" }), tab("w2:t2", { label: "phone-fixes" }), tab("w2:t3", { label: "3" }),
    ] }, { label: "Workers", children: [tab("w3:t1", { label: "1" })] }] });
    const live = await listLiveSessions({ store: null });
    expect(live.sessions.map(session => [session.label, session.role])).toEqual([
      ["Conductor", "conductor"], ["phone-fixes", undefined], [undefined, undefined], ["Workers", undefined],
    ]);
  } finally { vi.unstubAllEnvs(); await rm(root, { recursive: true, force: true }); }
});

it("counts a computer linked under any of its names: hostname label, Bonjour name or a peer's address", async () => {
  const store = await mkdtemp(path.join(tmpdir(), "phren-names-"));
  try {
    await writeFile(path.join(store, "machines.yaml"), "Desk.example.net: home\nDesk: home\nlinuxbox-host: home\nWork-Laptop: work\n");
    expect(notLinkedComputers(store, "Desk.example.net", ["Linuxbox", "linuxbox-host"])).toEqual([{ name: "Work-Laptop" }]);
  } finally { await rm(store, { recursive: true, force: true }); }
});

it("matches registered names by first label, whatever domain DHCP or Bonjour added", async () => {
  const store = await mkdtemp(path.join(tmpdir(), "phren-names-"));
  try {
    await writeFile(path.join(store, "machines.yaml"), "Desk: home\nDesk.local: home\ndesk.lan: home\nLinuxbox.example.net: home\nLAPTOP.local: work\n");
    // Desk is this computer (its local names) under three names; Linuxbox is a peer known by its bare name.
    expect(notLinkedComputers(store, "Desk-Mini", ["linuxbox"])).toEqual([{ name: "LAPTOP.local" }]);
  } finally { await rm(store, { recursive: true, force: true }); }
});

it("collapses one unlinked computer registered under several names into one entry with its aliases", async () => {
  const store = await mkdtemp(path.join(tmpdir(), "phren-names-"));
  try {
    await writeFile(path.join(store, "machines.yaml"), "Linuxbox.example.net: home\nLinuxbox: home\nlinuxbox.local: home\nWork-Laptop: work\n");
    expect(notLinkedComputers(store, "Desk", [])).toEqual([
      { name: "Linuxbox", aliases: ["linuxbox.local", "Linuxbox.example.net"] },
      { name: "Work-Laptop" },
    ]);
  } finally { await rm(store, { recursive: true, force: true }); }
});

it("counts a peer as linked through any name or alias its Hook reports", async () => {
  const store = await mkdtemp(path.join(tmpdir(), "phren-names-"));
  try {
    await writeFile(path.join(store, "machines.yaml"), "Linuxbox.local: home\nlinuxbox-host.example.net: home\n");
    expect(notLinkedComputers(store, "Desk", ["Build", "10.0.0.8", "Linuxbox", "LINUXBOX-HOST"])).toEqual([]);
  } finally { await rm(store, { recursive: true, force: true }); }
});

it("hands off by session only to a session of the requested account, counting a row without one as default", async () => {
  const target = { server: "default", workspace: "w1", tab: "t1", pane: "p1", source: "claude", session: "aaaaaaaa-1111-4111-8111-111111111111" };
  const overview = (account?: { id: string }) => ({ groups: [{ children: [{ target, ...(account ? { account: { ...account, label: "x", key: "k" } } : {}) }] }] });
  vi.mocked(hookRequest).mockResolvedValueOnce(overview({ id: "work" })).mockResolvedValueOnce({ ok: true, delivered: true });
  expect(await handOff({ session: target.session, account: "work", text: "Go" })).toMatchObject({ ok: true });
  vi.mocked(hookRequest).mockReset().mockResolvedValueOnce(overview({ id: "work" }));
  await expect(handOff({ session: target.session, account: "default", text: "Go" })).rejects.toMatchObject({ status: 409, details: { code: "account_mismatch" } });
  vi.mocked(hookRequest).mockReset().mockResolvedValueOnce(overview()).mockResolvedValueOnce({ ok: true, delivered: true });
  expect(await handOff({ session: target.session, account: "default", text: "Go" })).toMatchObject({ ok: true });
  expect(vi.mocked(hookRequest).mock.calls.filter(call => call[0] === "/v1/hand-off")).toHaveLength(1);
  await expect(handOff({ session: target.session, account: "../x", text: "Go" })).rejects.toThrow();
});

it("hands off to a computer named by an alias, and to this computer by its own name", async () => {
  const target = { server: "default", workspace: "w1", tab: "w1:t1", pane: "w1:p1", source: "codex", session: "00000001-1111-4111-8111-111111111111" };
  const linuxbox = { name: "Linuxbox", address: "linuxbox.example", username: "sam", port: 22, hostKey: "unused", server: "default" };
  vi.mocked(hookPeers).mockResolvedValue([linuxbox]);
  vi.mocked(optionalHookPeers).mockResolvedValue({ peers: [linuxbox] });
  vi.mocked(peerRequest).mockResolvedValueOnce({ groups: [{ children: [{ target }] }] }).mockResolvedValueOnce({ ok: true, delivered: true });
  expect(await handOff({ computer: "linuxbox.example", session: target.session, text: "hi" })).toMatchObject({ delivered: true });
  expect(vi.mocked(peerRequest).mock.calls.map(call => call[0].name)).toEqual(["Linuxbox", "Linuxbox"]);
  vi.mocked(hookRequest).mockResolvedValueOnce({ groups: [{ children: [{ target }] }] }).mockResolvedValueOnce({ ok: true, delivered: true });
  expect(await handOff({ computer: "Desk.local", session: target.session, text: "hi" })).toMatchObject({ delivered: true });
  expect(vi.mocked(hookRequest).mock.calls.map(call => call[0])).toContain("/v1/hand-off");
});

it("hands off to this computer by its own name when no computer is enrolled", async () => {
  const target = { server: "default", workspace: "w1", tab: "w1:t1", pane: "w1:p1", source: "codex", session: "00000001-1111-4111-8111-111111111111" };
  const missing = Object.assign(new Error("Configure peers and verified host keys in the Hook's hooks.yaml first."), { status: 409 });
  vi.mocked(hookPeers).mockRejectedValue(missing);
  vi.mocked(optionalHookPeers).mockResolvedValue({ peers: [] });
  vi.mocked(hookRequest).mockResolvedValueOnce({ groups: [{ children: [{ target }] }] }).mockResolvedValueOnce({ ok: true, delivered: true });
  expect(await handOff({ computer: "Desk.local", session: target.session, text: "hi" })).toMatchObject({ delivered: true });
  await expect(handOff({ computer: "Linuxbox", session: target.session, text: "hi" })).rejects.toThrow("hooks.yaml first");
});

vi.mock("./terminal.js", async original => ({ ...await original<object>(), terminalPaneFromEnv: async () => undefined }));
