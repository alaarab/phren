// Consolidated RC regression source. UNRUN: no harness/provider process is launched.
import { describe, expect, it, vi } from "vitest";
import { HarnessEvents } from "./contract.js";
import { AcpAdapter, type AcpPeer } from "./acp.js";
import { PaneTypingAdapter } from "./direct.js";
import { TurnSubmissions } from "./submissions.js";
import { expireObservation, WATCH_MS, noticeLine } from "../dispatch-returns.js";
import type { Receipt } from "../dispatch.js";

describe("structured harness safety", () => {
  it("reports a bounded-journal gap rather than silently losing events", async () => {
    const events = new HarnessEvents(); for (let i = 0; i < 1002; i++) events.publish("session", "text", { text: String(i) });
    const abort = new AbortController(), stream = events.stream("session", 0, abort.signal)[Symbol.asyncIterator]();
    expect((await stream.next()).value).toMatchObject({ type: "event-gap", seq: 2 }); abort.abort(); await stream.return?.(); events.close();
  });
  it("drains the final events after a provider closes and finishes a session consumer", async () => {
    const events = new HarnessEvents(); events.publish("session", "failed", { reason: "provider disconnected" }); events.end("session");
    const stream = events.stream("session")[Symbol.asyncIterator]();
    expect((await stream.next()).value).toMatchObject({ type: "failed" }); expect((await stream.next()).done).toBe(true);
    events.publish("other", "result"); events.close();
    const drained = []; for await (const row of events.stream("other")) drained.push(row);
    expect(drained).toMatchObject([{ session: "other", type: "result" }]);
  });
  it("keeps a queued submission once across Hook reconnections and binds its id to the prompt", async () => {
    const worker = new TurnSubmissions(), send = vi.fn(async () => ({ turnId: "turn", acknowledged: false }));
    await Promise.all([worker.run("delivery-one", "owner prompt", send), worker.run("delivery-one", "owner prompt", send)]);
    expect(send).toHaveBeenCalledTimes(1); expect(worker.status("delivery-one")).toEqual({ state: "queued", turnId: "turn" });
    await worker.run("delivery-one", "owner prompt", send); expect(send).toHaveBeenCalledTimes(1);
    await expect(worker.run("delivery-one", "another prompt", send)).rejects.toThrow("different text");
  });
  it("keeps an uncertain submitted turn from being retried automatically", async () => {
    const worker = new TurnSubmissions(), send = vi.fn(async () => { throw new Error("response lost"); });
    await expect(worker.run("delivery-one", "prompt", send)).rejects.toThrow("response lost");
    await expect(worker.run("delivery-one", "prompt", send)).rejects.toThrow("response lost");
    expect(send).toHaveBeenCalledTimes(1); expect(worker.status("delivery-one")).toEqual({ state: "uncertain" });
  });
  it("advertises no turn acknowledgement or structured interrupt for pane typing", async () => {
    const fallback = new PaneTypingAdapter({ server: "default", pane: "p1" }, "session");
    expect(fallback.capabilities.turnAcknowledgement).toBe(false); expect(fallback.capabilities.interrupt).toBe(false);
    await expect(fallback.interruptTurn("session", "stale-turn")).rejects.toThrow("turn-scoped interrupt");
  });
  it("answers only the right ACP session and refuses persistent-only permissions", async () => {
    let listener: Parameters<AcpPeer["on"]>[0] = () => {};
    const peer: AcpPeer = { request: vi.fn(async method => method === "initialize" ? { protocolVersion: 1, agentCapabilities: {} } : { sessionId: "opaque-session" }), notify: vi.fn(), respond: vi.fn(), respondError: vi.fn(), on(fn) { listener = fn; return () => {}; }, close: vi.fn() };
    const adapter = new AcpAdapter(peer, "cursor"); await adapter.startSession({ cwd: "/workspace" });
    listener({ method: "session/request_permission", id: 1, params: { sessionId: "opaque-session", options: [{ kind: "allow_always", optionId: "always" }] } });
    listener({ method: "session/request_permission", id: "1", params: { sessionId: "opaque-session", options: [{ kind: "allow_once", optionId: "once" }] } });
    await expect(adapter.respondToRequest("opaque-session", "number:1", { decision: "approve" })).rejects.toThrow("no one-time approval"); expect(peer.respond).not.toHaveBeenCalled();
    await adapter.respondToRequest("opaque-session", "number:1", { decision: "deny" }); expect(peer.respond).toHaveBeenCalledWith(1, { outcome: { outcome: "cancelled" } });
    await adapter.respondToRequest("opaque-session", "string:1", { decision: "approve" }); expect(peer.respond).toHaveBeenCalledWith("1", { outcome: { outcome: "selected", optionId: "once" } });
    listener({ method: "fs/write_text_file", id: 2, params: { sessionId: "opaque-session" } }); expect(peer.respondError).toHaveBeenCalledWith(2, -32601, expect.any(String)); await adapter.close();
  });
});

describe("expired dispatch observation", () => {
  const receipt = () => ({ id: "40000000-0000-4000-8000-000000000001", computer: "peer", project: "phren", harness: "claude", label: "worker", createdAt: new Date(0).toISOString(), updatedAt: new Date(0).toISOString(), state: "accepted" }) as Receipt;
  it("expires at the boundary without marking done or authorizing a close", () => {
    const current = receipt(); expect(expireObservation(current, WATCH_MS - 1)).toBe(false); expect(expireObservation(current, WATCH_MS)).toBe(true);
    expect(current.returned).toMatchObject({ state: "expired", read: false }); expect(current.returned?.error).toContain("completion was not verified"); expect(current.closedAt).toBeUndefined(); expect(current.closePending).toBeUndefined();
    expect(noticeLine([current])).toContain("observation expired"); expect(expireObservation(current, WATCH_MS + 1)).toBe(false);
  });
  it("preserves a verified terminal return and refuses malformed time", () => {
    const current = receipt(); current.returned = { state: "done", at: new Date(1).toISOString(), read: false }; expect(expireObservation(current, WATCH_MS)).toBe(false);
    const invalid = receipt(); invalid.createdAt = "unknown"; expect(expireObservation(invalid, WATCH_MS)).toBe(false);
  });
  it("expires an unfinished blocked observation without erasing its approval or authorizing close", () => {
    const current = receipt(); current.returned = { state: "blocked", at: new Date(1).toISOString(), read: false }; current.approval = { actionId: "pending-owner", tool: "Bash", at: new Date(1).toISOString() };
    expect(expireObservation(current, WATCH_MS)).toBe(true); expect(current.returned?.state).toBe("expired"); expect(current.approval?.actionId).toBe("pending-owner"); expect(current.closePending).toBeUndefined();
  });
});
