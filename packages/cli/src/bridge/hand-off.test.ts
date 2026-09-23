import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { hookRequest } from "./client.js";
import { handOff, listLiveSessions } from "./hand-off.js";

vi.mock("./client.js", () => ({ hookRequest: vi.fn() }));
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

it("lists local sessions and says why enrolled computers were skipped when hooks.yaml is broken", async () => {
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
