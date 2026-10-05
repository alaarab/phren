import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { HAND_OFF_MAX_ROWS, HAND_OFF_RETENTION_MS, HandOffQueue } from "./hand-off-queue.js";
import { BridgeError, type Json, type Target } from "./protocol.js";

const target: Target = { server: "default", workspace: "w1", tab: "t1", pane: "p1", source: "claude", session: "11111111-1111-4111-8111-111111111111" };
let root: string, pane: Json;
const validate = vi.fn(async () => pane);
const send = vi.fn(async (_target, _text, _id, typing) => { await typing(); return { delivered: true }; });
const queue = () => new HandOffQueue({ root, validate, send });
const message = (deliveryId = "handoff-0001", text = "Review parser") => ({ deliveryId, target, text });
beforeEach(async () => { root = await mkdtemp(path.join(tmpdir(), "phren-outbox-")); pane = { terminal_id: "term1", agent_status: "working" }; validate.mockClear(); validate.mockImplementation(async () => pane); send.mockClear(); send.mockImplementation(async (_t, _s, _i, typing) => { await typing(); return { delivered: true }; }); });
afterEach(async () => { await rm(root, { recursive: true, force: true }); });

describe("durable Hook hand-off queue", () => {
  it("queues busy workers, survives restart, and delivers once at idle even with concurrent retries", async () => {
    expect(await queue().enqueue(message())).toMatchObject({ ok: true, queued: true, delivered: false });
    expect(send).not.toHaveBeenCalled();
    pane.agent_status = "idle";
    const restarted = queue();
    await Promise.all([restarted.tick(), restarted.tick(), restarted.enqueue(message())]);
    expect(send).toHaveBeenCalledTimes(1);
    expect(await restarted.status("handoff-0001", target)).toMatchObject({ delivered: true, queued: false });
    expect(await queue().enqueue(message())).toMatchObject({ delivered: true, replayed: true });
    expect(send).toHaveBeenCalledTimes(1);
  });
  it("holds concurrent enqueues until closure finishes and refuses closing with queued work", async () => {
    const q = queue(), closed = vi.fn(async () => ({ closed: true }));
    await q.enqueue(message()); expect(await q.whenNoPending(target, closed)).toMatchObject({ closed: false });
    expect(closed).not.toHaveBeenCalled();
    pane.agent_status = "idle"; await q.tick();
    let release!: () => void, entered!: () => void;
    const waiting = new Promise<void>(resolve => { release = resolve; });
    const started = new Promise<void>(resolve => { entered = resolve; });
    let exists = true;
    validate.mockImplementation(async () => { if (!exists) throw new BridgeError(409, "pane closed"); return pane; });
    const closing = q.whenNoPending(target, async () => { entered(); await waiting; exists = false; return { closed: true }; });
    await started;
    const incoming = q.enqueue(message("handoff-0002")).catch(error => error);
    release(); expect(await closing).toMatchObject({ closed: true });
    expect(await incoming).toMatchObject({ status: 409 });
  });

  it("retains FIFO order across busy turns and rejects message id reuse", async () => {
    const q = queue(); await q.enqueue(message()); await q.enqueue(message("handoff-0002", "Next change"));
    await expect(q.enqueue(message("handoff-0001", "Changed text"))).rejects.toThrow("different message");
    pane.agent_status = "idle"; await q.tick();
    expect(send.mock.calls.map(call => call[1])).toEqual(["Review parser"]);
    await q.tick(); expect(send.mock.calls.map(call => call[1])).toEqual(["Review parser", "Next change"]);
  });
  it("requeues only Herdr agent_not_ready, which guarantees no input", async () => {
    pane.agent_status = "idle";
    send.mockImplementationOnce(async (_t, _s, _i, typing) => { await typing(); throw new BridgeError(409, "not active", { herdrCode: "agent_not_ready" }); });
    const q = queue();
    expect(await q.enqueue(message())).toMatchObject({ queued: true });
    await q.tick(); expect(await q.status("handoff-0001", target)).toMatchObject({ delivered: true });
    expect(send).toHaveBeenCalledTimes(2);
  });
  it("never resends an uncertain delivery or one interrupted between input and acknowledgement", async () => {
    pane.agent_status = "idle";
    send.mockImplementationOnce(async (_t, _s, _i, typing) => { await typing(); throw new Error("ack lost"); });
    const q = queue(); expect(await q.enqueue(message())).toMatchObject({ state: "uncertain", deliveryUncertain: true });
    await q.tick(); await queue().tick(); await q.enqueue(message()); expect(send).toHaveBeenCalledTimes(1);
    const file = path.join(root, "handoff-0001.json"), row = JSON.parse(await readFile(file, "utf8"));
    row.state = "attempting"; await writeFile(file, JSON.stringify(row));
    expect(await queue().status(row.deliveryId, target)).toMatchObject({ state: "uncertain" });
    await queue().tick(); expect(send).toHaveBeenCalledTimes(1);
  });
  it("keeps transport acceptance without submission uncertain, and guards terminal replacement", async () => {
    const q = queue(); await q.enqueue(message()); pane.terminal_id = "replacement"; pane.agent_status = "idle";
    await q.tick(); expect(await q.status("handoff-0001", target)).toMatchObject({ state: "failed" }); expect(send).not.toHaveBeenCalled();
    send.mockImplementationOnce(async (_t, _s, _i, typing) => { await typing(); return { delivered: false, queued: true }; });
    expect(await q.enqueue(message("handoff-0002"))).toMatchObject({ state: "uncertain" });
    await q.tick(); expect(send).toHaveBeenCalledTimes(1);
  });
  it("keeps an offline queued worker and does not answer a blocked dialog", async () => {
    const q = queue(); await q.enqueue(message()); validate.mockRejectedValueOnce(new BridgeError(503, "offline")); await q.tick();
    expect(await q.status("handoff-0001", target)).toMatchObject({ queued: true });
    pane.agent_status = "blocked"; await q.tick(); expect(send).not.toHaveBeenCalled();
  });
  it("notifies the sender through another durable queued message without recursion", async () => {
    const origin = { ...target, pane: "sender" }, q = queue();
    await q.enqueue({ ...message(), origin }); pane.agent_status = "idle"; await q.tick(); await q.tick(); await q.tick();
    expect(send.mock.calls.map(call => call[1])).toEqual(["Review parser", "Hand-off handoff-0001: delivered."]);
  });
  it("keeps accepting hand-offs while a notice waits on the sender's Hook, and coalesces ticks", async () => {
    // Two Hooks each notifying the other while holding their own queue lock refused every hand-off on both.
    let answer!: (value: Json) => void;
    const notify = vi.fn(() => new Promise<Json>(resolve => { answer = resolve; }));
    const q = new HandOffQueue({ root, validate, send, notify }), origin = { ...target, pane: "sender" };
    pane.agent_status = "idle";
    await q.enqueue({ ...message(), origin, originComputer: "Mac" });
    const ticks = [q.tick(), q.tick(), q.tick()];
    await vi.waitFor(() => expect(notify).toHaveBeenCalledTimes(1));
    expect(await q.enqueue(message("handoff-0002", "Next change"))).toMatchObject({ delivered: true });
    expect(await q.status("handoff-0001", target)).toMatchObject({ delivered: true });
    answer({ queued: true }); await Promise.all(ticks);
    expect(notify).toHaveBeenCalledTimes(1);
    expect(JSON.parse(await readFile(path.join(root, "handoff-0001.json"), "utf8"))).toMatchObject({ notified: true });
    await q.tick(); expect(notify).toHaveBeenCalledTimes(1);
  });
  it("follows its pane to the conversation that replaced the one it was queued for", async () => {
    // A Codex pane went through four threads in six hours (w6D, 2026-10-04);
    // each queued hand-off failed as "This pane's conversation changed".
    let session = target.session;
    validate.mockImplementation(async (where: Target) => { if (where.session !== session) throw new BridgeError(409, "This pane's conversation changed. Reopen the chat."); return pane; });
    const current = vi.fn(async () => ({ session, terminal: pane.terminal_id }));
    const q = new HandOffQueue({ root, validate, send, current });
    await q.enqueue(message());
    session = "22222222-2222-4222-8222-222222222222"; pane.agent_status = "idle";
    await q.tick();
    expect(send).toHaveBeenCalledExactlyOnceWith({ ...target, session }, "Review parser", "handoff-0001", expect.any(Function));
    // Still found by the target it was sent to, and replayed rather than resent.
    expect(await q.status("handoff-0001", target)).toMatchObject({ delivered: true, target: { ...target, session } });
    expect(await q.enqueue(message())).toMatchObject({ delivered: true, replayed: true });
    expect(send).toHaveBeenCalledTimes(1);
  });
  it("still fails loudly when the pane's agent was replaced by another terminal", async () => {
    let session = target.session;
    validate.mockImplementation(async (where: Target) => { if (where.session !== session) throw new BridgeError(409, "This pane's conversation changed. Reopen the chat."); return pane; });
    const q = new HandOffQueue({ root, validate, send, current: async () => ({ session, terminal: "term2" }) });
    await q.enqueue(message());
    session = "22222222-2222-4222-8222-222222222222"; pane.agent_status = "idle";
    await q.tick();
    expect(await q.status("handoff-0001", target)).toMatchObject({ state: "failed", error: "This pane's conversation changed. Reopen the chat." });
    expect(send).not.toHaveBeenCalled();
  });
  describe("retention", () => {
    const DAY = 86_400_000;
    const names = async () => (await readdir(root)).sort();
    it("drops settled rows past retention but never a queued or attempting one", async () => {
      let clock = Date.parse("2026-01-01T00:00:00Z");
      const q = new HandOffQueue({ root, validate, send, now: () => clock });
      pane.agent_status = "idle"; await q.enqueue(message("handoff-done")); // delivered
      send.mockImplementationOnce(async () => { throw new BridgeError(409, "gone"); });
      await q.enqueue(message("handoff-fail", "Other")); // failed before typing
      const other = { ...target, pane: "p2" };
      pane.agent_status = "working"; await q.enqueue({ deliveryId: "handoff-wait", target: other, text: "Later" }); // queued
      const file = path.join(root, "handoff-stuck.json");
      await writeFile(file, JSON.stringify({ ...JSON.parse(await readFile(path.join(root, "handoff-wait.json"), "utf8")), deliveryId: "handoff-stuck", target: { ...target, pane: "p3" }, state: "attempting" }));
      clock += HAND_OFF_RETENTION_MS + DAY; await q.tick();
      // The attempting row recovers as uncertain on read and is kept this sweep; the queued row stays queued.
      expect(await names()).toEqual(["handoff-stuck.json", "handoff-wait.json"]);
      expect(await q.status("handoff-wait", other)).toMatchObject({ queued: true });
    });
    it("sweeps at most daily from tick", async () => {
      let clock = Date.parse("2026-01-01T00:00:00Z");
      const q = new HandOffQueue({ root, validate, send, now: () => clock });
      pane.agent_status = "idle"; await q.enqueue(message());
      const HOUR = 3_600_000;
      clock += HAND_OFF_RETENTION_MS - HOUR; await q.tick(); expect(await names()).toEqual(["handoff-0001.json"]); // swept, not yet old
      clock += 2 * HOUR; await q.tick(); expect(await names()).toEqual(["handoff-0001.json"]); // old, but swept an hour ago
      clock += DAY; await q.tick(); expect(await names()).toEqual([]);
    });
    it("caps the directory, dropping the oldest settled rows first and keeping queued ones", async () => {
      let clock = Date.parse("2026-01-01T00:00:00Z");
      const q = new HandOffQueue({ root, validate, send, now: () => clock });
      const busy = { ...target, pane: "busy" }, row = (id: string, state: string, t: Target = target) => ({ target: t, text: "x", deliveryId: id, terminal: "term1", state,
        createdAt: new Date(clock).toISOString(), updatedAt: new Date(clock).toISOString() });
      await writeFile(path.join(root, "handoff-queued-old.json"), JSON.stringify(row("handoff-queued-old", "queued", busy)));
      for (let i = 0; i < HAND_OFF_MAX_ROWS + 5; i++) { clock += 1000; const id = `handoff-${String(i).padStart(4, "0")}`; await writeFile(path.join(root, `${id}.json`), JSON.stringify(row(id, "delivered"))); }
      clock += 1000; pane.agent_status = "working";
      await q.enqueue({ deliveryId: "handoff-new", target: busy, text: "y" });
      const left = await names();
      expect(left).toHaveLength(HAND_OFF_MAX_ROWS);
      expect(left).toContain("handoff-queued-old.json"); expect(left).toContain("handoff-new.json");
      for (const i of [0, 1, 2, 3, 4, 5, 6]) expect(left).not.toContain(`handoff-${String(i).padStart(4, "0")}.json`);
      expect(left).toContain("handoff-0007.json");
    });
  });
});
