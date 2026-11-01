import { Readable } from "node:stream";
import type { IncomingMessage, ServerResponse } from "node:http";
import { createRouteHandler, type RouteContext } from "./server-routes.js";
import { mkdir, mkdtemp, readFile, rename, rm } from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { PromptDeliveries } from "./prompt-deliveries.js";
import { type Target } from "./protocol.js";
import { noteTurn, readTurn } from "./turn-records.js";
import { TurnQueue, turnQueueRoute, type TurnQueueDeps, type TurnQueuePane } from "./turn-queue.js";

const target: Target = { server: "default", workspace: "w1", tab: "w1:t1", pane: "w1:p1", source: "claude", session: "aaaaaaaa-1111-4111-8111-111111111111" };
const event = { terminal: "terminal-1", source: target.source, session: target.session };
let root: string, file: string, queue: TurnQueue, deps: TurnQueueDeps, deliveries: PromptDeliveries;
let present: boolean, held: boolean, background: number, session: string, terminal: string;
const send = vi.fn<TurnQueueDeps["send"]>();
const turn = (name: string) => noteTurn(target.server, target.pane, { ...event, event: name });
const enqueue = (id = "message-0001", text = "Review this") => turnQueueRoute(queue, "/v1/prompt/after-turn", { target, id, text });
const list = () => queue.list(target);

beforeEach(async () => {
  await mkdir(path.join(process.cwd(), ".scratch"), { recursive: true });
  root = await mkdtemp(path.join(process.cwd(), ".scratch/turn-queue-")); file = path.join(root, "turn-queue.json");
  vi.stubEnv("PHREN_BRIDGE_HOME", root);
  present = true; held = false; background = 0; session = target.session; terminal = event.terminal;
  deliveries = new PromptDeliveries(path.join(root, "deliveries.json"), Date.now, async () => []);
  send.mockReset().mockImplementation(async (where, text, id, typing) => {
    await typing();
    // A terminal accepts the paste; its harness's submission is separate.
    void deliveries.expect(where, text, 1, undefined, id, terminal);
    deliveries.queue(id, where);
    return { queued: true };
  });
  deps = {
    current: async (): Promise<TurnQueuePane | undefined> => present ? { terminal, source: target.source, session,
      record: await readTurn(target.server, target.pane), held, background, ready: true } : undefined,
    holding: (where, exceptId) => deliveries.holding(where, exceptId),
    send, delivery: (where, id) => deliveries.status(id, where),
  };
  queue = new TurnQueue(file, deps);
  await turn("UserPromptSubmit");
});
afterEach(async () => { await deliveries.flush(); vi.unstubAllEnvs(); await rm(root, { recursive: true, force: true }); });

it("sends once after Stop, settles through PromptDeliveries, and waits for another Stop before the second item", async () => {
  await enqueue(); await enqueue("message-0002", "Then check docs");
  await queue.tick(); expect(send).not.toHaveBeenCalled();
  await turn("Stop"); await queue.tick(); await queue.tick();
  expect(send).toHaveBeenCalledTimes(1); expect(list().map(item => item.state)).toEqual(["sending", "queued"]);
  await deliveries.submitted(target, "Review this"); await queue.tick();
  expect(list()[0].state).toBe("delivered"); expect(send).toHaveBeenCalledTimes(1);
  await turn("Stop"); await queue.tick(); expect(send).toHaveBeenCalledTimes(1); // duplicate Stop is not another turn
  await turn("UserPromptSubmit"); await queue.tick(); expect(send).toHaveBeenCalledTimes(1);
  await turn("Stop"); await queue.tick(); expect(send).toHaveBeenCalledTimes(2);
  expect(send.mock.calls.map(call => call[2])).toEqual(["message-0001", "message-0002"]);
});

it.each(["approval", "background"])("holds an ended turn while %s is present", async kind => {
  await enqueue(); await turn("Stop");
  held = kind === "approval"; background = kind === "background" ? 1 : 0;
  await queue.tick(); expect(send).not.toHaveBeenCalled();
  held = false; background = 0; await queue.tick(); expect(send).toHaveBeenCalledTimes(1);
});

it.each(["pane-closed", "agent-restarted", "conversation-changed"] as const)("fails an unsent item with %s", async reason => {
  await enqueue(); await turn("Stop");
  if (reason === "pane-closed") present = false;
  if (reason === "agent-restarted") terminal = "terminal-2";
  if (reason === "conversation-changed") session = "bbbbbbbb-2222-4222-8222-222222222222";
  await queue.tick(); expect(list()[0]).toMatchObject({ state: "failed", reason }); expect(send).not.toHaveBeenCalled();
});

it("edits and cancels only queued items, preserves idempotency and refuses mutation after sending", async () => {
  await enqueue(); await enqueue(); expect(list()).toHaveLength(1);
  await turnQueueRoute(queue, "/v1/prompt/after-turn/edit", { target, id: "message-0001", text: "New words" });
  await turnQueueRoute(queue, "/v1/prompt/after-turn/cancel", { target, id: "message-0001" });
  await turn("Stop"); await queue.tick(); expect(send).not.toHaveBeenCalled();
  expect(list()[0]).toMatchObject({ state: "cancelled", text: "New words" });
  await enqueue("message-0002"); await queue.tick();
  for (const route of ["cancel", "edit"]) await expect(turnQueueRoute(queue, `/v1/prompt/after-turn/${route}`, { target, id: "message-0002", text: "Too late" })).rejects.toMatchObject({ status: 409 });
});

it("reloads an interrupted send as unknown and never resends it or releases the next item", async () => {
  await enqueue(); await enqueue("message-0002"); await turn("Stop");
  let release!: () => void;
  const paused = new Promise<void>(resolve => { release = resolve; });
  let started!: () => void;
  const starting = new Promise<void>(resolve => { started = resolve; });
  send.mockImplementationOnce(async (_target, _text, _id, typing) => { await typing(); started(); await paused; return {}; });
  const sending = queue.tick(); await starting;
  expect(JSON.parse(await readFile(file, "utf8")).items[0].state).toBe("sending");
  const restarted = new TurnQueue(file, deps);
  await restarted.tick(); await restarted.tick();
  expect(restarted.list(target).map(item => item.state)).toEqual(["unknown", "queued"]);
  expect(send).toHaveBeenCalledTimes(1);
  release(); await sending;
});

it("retains delivery failure details without retrying the send", async () => {
  await enqueue(); await turn("Stop"); await queue.tick();
  deliveries.fail("message-0001", target, "Terminal rejected the message");
  await queue.tick(); await queue.tick();
  expect(list()[0]).toMatchObject({ state: "failed", reason: "delivery-failed", detail: "Terminal rejected the message" });
  expect(send).toHaveBeenCalledTimes(1);
});

it("bounds queued items and rejects a reused id for another conversation", async () => {
  for (let i = 0; i < 20; i++) await enqueue(`message-${String(i).padStart(4, "0")}`);
  await expect(enqueue("message-overflow")).rejects.toMatchObject({ status: 409 });
  await expect(turnQueueRoute(queue, "/v1/prompt/after-turn", { target: { ...target, session: "bbbbbbbb-2222-4222-8222-222222222222" }, id: "message-0001", text: "wrong" })).rejects.toMatchObject({ status: 409 });
});

it("validates route input, reports absent items and lists using the original target after pane closure", async () => {
  await expect(turnQueueRoute(queue, "/v1/prompt/after-turn", { target, id: "message-0001" })).rejects.toMatchObject({ status: 400 });
  await expect(turnQueueRoute(queue, "/v1/prompt/after-turn/cancel", { target, id: "message-absent" })).rejects.toMatchObject({ status: 404 });
  await expect(turnQueueRoute(queue, "/v1/prompt/after-turn/nope", { target, id: "message-0001" })).rejects.toMatchObject({ status: 404 });
  await expect(turnQueueRoute(queue, "/v1/prompt/after-turn", { target, id: "bad", text: "Review" })).rejects.toBeInstanceOf(Error);
  await enqueue(); present = false; await queue.tick();
  expect(await turnQueueRoute(queue, "/v1/prompt/after-turn/list", { target })).toMatchObject({ items: [{ state: "failed", reason: "pane-closed" }] });
  await expect(enqueue("message-new")).rejects.toMatchObject({ status: 404 });
});

it("exposes the queue through the HTTP router with 400/404 and Hook module gating", async () => {
  let hook = true;
  const handler = createRouteHandler({ turnQueue: queue, modules: { has: () => hook }, streams: {} } as unknown as RouteContext);
  const request = async (route: string, body: unknown) => {
    const input = Readable.from([Buffer.from(JSON.stringify(body))]) as IncomingMessage;
    Object.assign(input, { method: "POST", url: route, headers: {} });
    let payload = "";
    const response = { statusCode: 200, setHeader() {}, end(text: string) { payload = text; } };
    await handler(input, response as unknown as ServerResponse);
    return { status: response.statusCode, body: JSON.parse(payload) };
  };
  const route = "/v1/prompt/after-turn";
  expect(await request(route, { target, id: "bad", text: "Review" })).toMatchObject({ status: 400 });
  expect(await request(`${route}/cancel`, { target, id: "missing-item" })).toMatchObject({ status: 404 });
  expect(await request(route, { target, id: "http-message", text: "Review" })).toMatchObject({ status: 200, body: { item: { id: "http-message", state: "queued" } } });
  hook = false;
  expect(await request(`${route}/list`, { target })).toMatchObject({ status: 404 });
});

it("keeps queued words editable across restart and submits the replacement text", async () => {
  await enqueue();
  queue = new TurnQueue(file, deps);
  await turnQueueRoute(queue, "/v1/prompt/after-turn/edit", { target, id: "message-0001", text: "Replacement" });
  await turn("Stop"); await queue.tick();
  expect(send.mock.calls[0].slice(0, 3)).toEqual([target, "Replacement", "message-0001"]);
});

it("updates a failed queue item when its delivery is confirmed by a late submission", async () => {
  await enqueue(); await turn("Stop"); await queue.tick();
  deliveries.fail("message-0001", target, "The turn ended without taking it");
  await queue.tick(); expect(list()[0]).toMatchObject({ state: "failed", reason: "delivery-failed" });
  await deliveries.submitted(target, "Review this");
  expect(deliveries.status("message-0001", target).state).toBe("delivered");
  await queue.tick();
  expect(list()[0].state).toBe("delivered");
  expect(list()[0]).not.toHaveProperty("reason"); expect(list()[0]).not.toHaveProperty("detail");
  expect(send).toHaveBeenCalledTimes(1);
});

it.each(["edit", "cancel"])("keeps the original item in memory and on reload after a failed %s write", async action => {
  await enqueue();
  const original = list()[0];
  await rename(file, `${file}.backup`); await mkdir(file); // rename-over-directory fails even as root
  await expect(queue.change(target, original.id, action === "edit" ? "Unpersisted words" : undefined)).rejects.toThrow();
  expect(list()[0]).toEqual(original);
  await rm(file, { recursive: true }); await rename(`${file}.backup`, file);
  expect(new TurnQueue(file, deps).list(target)[0]).toEqual(original);
  await turn("Stop"); await queue.tick();
  expect(send).toHaveBeenCalledTimes(1);
  expect(send.mock.calls[0].slice(0, 3)).toEqual([target, original.text, original.id]);
  expect(new TurnQueue(file, deps).list(target)[0]).toMatchObject({ text: original.text, state: "unknown" });
});
