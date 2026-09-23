import { mkdtemp, rm, writeFile } from "node:fs/promises";
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
    const live = await listLiveSessions();
    expect(live).toMatchObject({ sessions: [], unreachable: [], enrolled: 0 });
    expect(live.peerError).toMatch(/^hooks\.yaml is invalid at version: /);
  } finally { vi.unstubAllEnvs(); await rm(root, { recursive: true, force: true }); }
});
