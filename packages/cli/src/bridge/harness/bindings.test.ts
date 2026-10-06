// Prepared for consolidated RC; UNRUN during source integration.
import { afterEach, expect, it, vi } from "vitest";
import { noCapabilities } from "./contract.js";
import type { RunnerEntry } from "./runner-client.js";
const state = vi.hoisted(() => ({ runner: undefined as RunnerEntry | undefined }));
vi.mock("../herdr.js", () => ({ validateTarget: async () => ({ pane_id: "p1", terminal_id: "term", agent: "claude" }) }));
vi.mock("./runner-client.js", async original => ({ ...await original<typeof import("./runner-client.js")>(), runnerForPane: async () => state.runner }));
import { boundHarness, harnessInfo, unbindHarness } from "./bindings.js";
const target = { server: "default", workspace: "w1", tab: "t1", pane: "p1", source: "claude" as const, session: "11111111-1111-4111-8111-111111111111" };
afterEach(async () => { await unbindHarness(target); state.runner = undefined; });
it("refuses a stale phone owner even when a replacement runner reuses the pane and native session", async () => {
  const owner = "22222222-2222-4222-8222-222222222222";
  state.runner = { version: 1, ownerId: owner, pid: 123, server: "default", pane: "p1", terminal: "term", source: "claude", session: target.session,
    nativeSession: target.session, provider: "claude-sdk", capabilities: { ...noCapabilities, startSession: true, readThread: true, events: true } };
  expect(await harnessInfo(target)).toMatchObject({ ownerId: owner, nativeSession: target.session, capabilities: { startSession: false, readThread: true } });
  await boundHarness(target, owner);
  state.runner = { ...state.runner, ownerId: "33333333-3333-4333-8333-333333333333", pid: 124 };
  await expect(boundHarness(target, owner)).rejects.toThrow("owner changed");
  state.runner = undefined;
  await expect(boundHarness(target, owner)).rejects.toThrow("owner changed");
});
