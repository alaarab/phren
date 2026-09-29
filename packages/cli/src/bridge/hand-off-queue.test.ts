import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { HandOffQueue } from "./hand-off-queue.js";
import { BridgeError, type Json, type Target } from "./protocol.js";

const target: Target = { server: "default", workspace: "w1", tab: "t1", pane: "p1", source: "claude", session: "11111111-1111-4111-8111-111111111111" };
let root: string, pane: Json;
const validate = vi.fn(async () => pane);
const send = vi.fn(async (_target, _text, _id, typing) => { await typing(); return { delivered: true }; });
const queue = () => new HandOffQueue({ root, validate, send });
const message = (deliveryId = "handoff-0001", text = "Review parser") => ({ deliveryId, target, text });
beforeEach(async () => { root = await mkdtemp(path.join(tmpdir(), "phren-outbox-")); pane = { terminal_id: "term1", agent_status: "working" }; validate.mockClear(); send.mockClear(); send.mockImplementation(async (_t, _s, _i, typing) => { await typing(); return { delivered: true }; }); });
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
});
