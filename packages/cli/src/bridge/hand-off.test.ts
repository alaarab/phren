import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { hookRequest } from "./client.js";
import { handOff, listLiveSessions, notLinkedComputers } from "./hand-off.js";

vi.mock("./client.js", () => ({ hookRequest: vi.fn() }));
// This computer's names are synthetic so the real hostname never matters.
vi.mock("./computer-names.js", () => ({ localNames: () => ["Desk.example.net", "Desk"] }));
vi.mock("./grants.js", () => ({ listGrants: vi.fn(async () => []), matchGrant: vi.fn(), grantLabel: vi.fn() }));
afterEach(() => vi.resetAllMocks());

it("resolves an existing session and delivers one prompt through its live target", async () => {
  const target = { server: "default", workspace: "w1", tab: "t1", pane: "p1", source: "codex",
    session: "aaaaaaaa-1111-4111-8111-111111111111" };
  vi.mocked(hookRequest).mockResolvedValueOnce({ groups: [{ children: [{ target }] }] }).mockResolvedValueOnce({ ok: true });
  expect(await handOff({ session: target.session, text: "Review the tests" })).toEqual({ ok: true, delivered: true, target });
  expect(vi.mocked(hookRequest).mock.calls).toEqual([
    ["/v1/workspaces", undefined], ["/v1/prompt", { target, text: "Review the tests" }],
  ]);
});

it("names the target by its project folder, from the overview it already read", async () => {
  const target = { server: "default", workspace: "w1", tab: "t1", pane: "p1", source: "claude",
    session: "aaaaaaaa-1111-4111-8111-111111111111" };
  vi.mocked(hookRequest).mockResolvedValueOnce({ groups: [{ label: "Studio", children: [{ target, cwd: "/home/sam/ObjectStudio" }] }] })
    .mockResolvedValueOnce({ ok: true });
  expect(await handOff({ session: target.session, text: "Rebase first" })).toEqual({ ok: true, delivered: true, target, label: "ObjectStudio" });
  expect(vi.mocked(hookRequest).mock.calls).toHaveLength(2);
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
    await writeFile(path.join(store, "machines.yaml"), "Desk.local: personal\nLinuxbox: personal\n");
    const target = { server: "default", workspace: "w1", tab: "t1", pane: "p1", source: "claude", session: "aaaaaaaa-1111-4111-8111-111111111111" };
    vi.mocked(hookRequest).mockResolvedValueOnce({ computer: { name: "Desk" } }).mockResolvedValueOnce({ groups: [{ label: "phren",
      children: [{ agent: "claude", agentStatus: "idle", cwd: "/home/sam/phren", target, lastChangedAt: "2026-09-22T11:55:00.000Z" }] }] });
    const live = await listLiveSessions({ store });
    expect(live.sessions).toMatchObject([{ computer: "Desk", project: "phren", status: "idle", idleFor: 300 }]);
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
