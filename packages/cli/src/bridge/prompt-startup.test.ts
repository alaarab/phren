import { setTimeout as sleep } from "node:timers/promises";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { AgentHooks } from "./agent-hooks.js";
import { BridgeError, type Target } from "./protocol.js";
import { promptWithStartupRetry } from "./prompt-startup.js";

vi.mock("node:timers/promises", () => ({ setTimeout: vi.fn() }));
const notReady = () => new BridgeError(409, "Herdr: agent w1:p1 is not an active named agent", { herdrCode: "agent_not_ready" });
let now: number;
beforeEach(() => {
  now = 0;
  vi.spyOn(Date, "now").mockImplementation(() => now);
  vi.mocked(sleep).mockImplementation(async (ms, value) => { now += ms ?? 0; return value; });
});
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); vi.resetAllMocks(); });

it("retries explicit pre-write refusals only after validating the target again", async () => {
  const order: string[] = [];
  const send = vi.fn(async () => { order.push("send"); if (order.length < 5) throw notReady(); return "accepted"; });
  const validate = vi.fn(async () => { order.push("validate"); });
  expect(await promptWithStartupRetry(send, validate)).toBe("accepted");
  expect(order).toEqual(["send", "validate", "send", "validate", "send"]);
  expect(now).toBe(1_000);
});

it("bounds startup retries to twenty seconds without one final write at the deadline", async () => {
  const refused = notReady(), send = vi.fn().mockRejectedValue(refused), validate = vi.fn();
  await expect(promptWithStartupRetry(send, validate)).rejects.toBe(refused);
  expect(now).toBe(20_000);
  expect(send).toHaveBeenCalledTimes(40);
  expect(validate).toHaveBeenCalledTimes(39);
});

it("counts slow refusals and validation against the retry budget", async () => {
  const refused = notReady();
  const send = vi.fn(async () => { now += 10_000; throw refused; });
  const validate = vi.fn(async () => { now += 10_000; });
  await expect(promptWithStartupRetry(send, validate)).rejects.toBe(refused);
  expect(send).toHaveBeenCalledTimes(1);
});

it.each([
  new BridgeError(504, "Herdr did not answer", { code: "herdr-timeout" }),
  new BridgeError(503, "Herdr closed the request before confirming it"),
  new BridgeError(409, "not an active named agent"),
  new BridgeError(409, "another refusal", { herdrCode: "unknown" }),
])("does not retry potentially delivered or unclassified failures: %s", async error => {
  const send = vi.fn().mockRejectedValueOnce(notReady()).mockRejectedValue(error), validate = vi.fn();
  await expect(promptWithStartupRetry(send, validate)).rejects.toBe(error);
  expect(send).toHaveBeenCalledTimes(2);
  expect(validate).toHaveBeenCalledTimes(1);
});

it("ends the retry when fresh validation fails", async () => {
  const changed = new BridgeError(409, "The conversation changed");
  const send = vi.fn().mockRejectedValue(notReady()), validate = vi.fn().mockRejectedValue(changed);
  await expect(promptWithStartupRetry(send, validate)).rejects.toBe(changed);
  expect(send).toHaveBeenCalledTimes(1);
});

it("removes only the submission guard for a definitely unwritten prompt", async () => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  const hooks = new AgentHooks(), refused = new AbortController();
  const target: Target = { server: "default", workspace: "w1", tab: "t1", pane: "p1", source: "claude",
    session: "aaaaaaaa-1111-4111-8111-111111111111" };
  const rejected = hooks.expectDelivery(target, "same prompt", 1_500, refused.signal);
  const other = new AbortController();
  const otherTarget = { ...target, session: "bbbbbbbb-1111-4111-8111-111111111111" };
  const pending = hooks.expectDelivery(otherTarget, "same prompt", 1_500, other.signal);
  // A slow refusal can arrive after the short confirmation wait elapsed.
  await vi.advanceTimersByTimeAsync(1_500);
  refused.abort();
  expect(await rejected).toBe("pending");
  expect(hooks.deliveryPending(target, "same prompt")).toBe(false);
  expect(hooks.deliveryPending(otherTarget, "same prompt")).toBe(true);
  other.abort();
  await pending;
});
