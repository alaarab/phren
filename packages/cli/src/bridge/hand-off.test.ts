import { afterEach, expect, it, vi } from "vitest";
import { hookRequest } from "./client.js";
import { handOff } from "./hand-off.js";

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
