// Consolidated RC regression source. UNRUN: no harness/provider process is launched.
import { describe, expect, it, vi } from "vitest";
import { HarnessEvents } from "./contract.js";
import { AcpAdapter, type AcpPeer } from "./acp.js";
import { PaneTypingAdapter } from "./direct.js";
import { expireObservation, WATCH_MS, noticeLine } from "../dispatch-returns.js";
import type { Receipt } from "../dispatch.js";

describe("structured harness safety", () => {
  it("reports a bounded-journal gap rather than silently losing events", async () => {
    const events = new HarnessEvents(); for (let i = 0; i < 1002; i++) events.publish("session", "text", { text: String(i) });
    const abort = new AbortController(), stream = events.stream("session", 0, abort.signal)[Symbol.asyncIterator]();
    expect((await stream.next()).value).toMatchObject({ type: "event-gap", seq: 2 }); abort.abort(); await stream.return?.(); events.close();
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
    await expect(adapter.respondToRequest("opaque-session", "1", { decision: "approve" })).rejects.toThrow("no one-time approval"); expect(peer.respond).not.toHaveBeenCalled();
    await adapter.respondToRequest("opaque-session", "1", { decision: "deny" }); expect(peer.respond).toHaveBeenCalledWith(1, { outcome: { outcome: "cancelled" } });
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
});
