import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DELIVERY_GIVE_UP_MS, DELIVERY_RETENTION_MS, PromptDeliveries, userTexts } from "./prompt-deliveries.js";
import type { Json, Target } from "./protocol.js";

const target: Target = { server: "default", workspace: "w6", tab: "w6:t1", pane: "w6:p1", source: "codex", session: "01a10831-4b62-7000-8000-000000000001" };
const rotated: Target = { ...target, session: "01a10985-bf36-7000-8000-000000000002" };
let root: string, file: string, clock: number, landed: boolean, stores: PromptDeliveries[] = [];
const deliveries = () => { const store = new PromptDeliveries(file, () => clock, async () => landed); stores.push(store); return store; };
const pane = (status: string, terminal = "term-1"): Json => ({ pane_id: target.pane, agent: "codex", terminal_id: terminal, agent_status: status });
/** Typed into a busy pane and answered queued, as /v1/prompt does. */
async function send(store: PromptDeliveries, id: string, text: string, where = target) {
  expect(await store.expect(where, text, 1, undefined, id, "term-1")).toBe("pending");
  store.queue(id, where);
}

beforeEach(async () => { root = await mkdtemp(path.join(tmpdir(), "phren-deliveries-")); file = path.join(root, "deliveries.json"); clock = 1_000_000; landed = false; });
afterEach(async () => { await Promise.all(stores.map(store => store.flush())); stores = []; await rm(root, { recursive: true, force: true }); });

describe("phone messages bound to their pane", () => {
  it("reach the conversation that replaced the one they were sent to while queued", async () => {
    const store = deliveries();
    await send(store, "rotate-0001", "Split PR #283 by scope");
    store.submitted(rotated, "Split PR #283 by scope");
    expect(store.status("rotate-0001", target)).toEqual({ state: "delivered", session: rotated.session });
    expect(store.forPane(rotated)).toEqual([{ deliveryId: "rotate-0001", state: "delivered", session: rotated.session }]);
  });

  it("keep back-to-back sends to a busy agent apart, each settled by its own id", async () => {
    const store = deliveries();
    await send(store, "first-0001", "Run the suite");
    await send(store, "second-0002", "Then open the PR");
    expect(store.forPane(target).map(item => item.state)).toEqual(["queued", "queued"]);
    store.submitted(target, "Run the suite");
    expect(store.status("first-0001", target).state).toBe("delivered");
    expect(store.status("second-0002", target).state).toBe("queued");
    store.submitted(target, "Then open the PR");
    expect(store.status("second-0002", target).state).toBe("delivered");
  });

  it("settle the same words sent twice one submission at a time", async () => {
    const store = deliveries();
    await send(store, "same-0001", "yes");
    await send(store, "same-0002", "yes");
    store.submitted(target, "yes");
    expect([store.status("same-0001", target).state, store.status("same-0002", target).state]).toEqual(["delivered", "queued"]);
  });

  it("leave a prompt typed by hand in another pane alone", async () => {
    const store = deliveries();
    await send(store, "mine-0001", "continue");
    store.submitted({ ...target, pane: "w6:p2" }, "continue");
    expect(store.status("mine-0001", target).state).toBe("queued");
  });

  it("survive a Hook restart, keeping only a hash of the words", async () => {
    const store = deliveries();
    await send(store, "restart-0001", "Merge the deps branch");
    // Typed when the Hook stopped, before its reply: in the pane or nowhere.
    expect(await store.expect(target, "And rebase", 1, undefined, "restart-0002", "term-1")).toBe("pending");
    await store.flush();
    expect(await readFile(file, "utf8")).not.toContain("deps");
    const restarted = deliveries();
    expect(restarted.status("restart-0001", target).state).toBe("queued");
    expect(restarted.status("restart-0002", target).state).toBe("queued");
    restarted.submitted(rotated, "Merge the deps branch");
    expect(restarted.status("restart-0001", target)).toEqual({ state: "delivered", session: rotated.session });
  });

  it("are forgotten after retention, and a retried failed id replaces its record", async () => {
    const store = deliveries();
    await send(store, "old-0001", "Ping");
    store.fail("old-0001", target, "The agent finished its turn without taking the message.");
    await send(store, "old-0001", "Ping");
    expect(store.forPane(target)).toEqual([{ deliveryId: "old-0001", state: "queued", session: target.session }]);
    clock += DELIVERY_RETENTION_MS + 1;
    expect(store.status("old-0001", target).state).toBe("unknown");
  });
});

describe("a message the agent never takes fails loudly", () => {
  it("when its pane closes or its agent restarts", async () => {
    const store = deliveries();
    await send(store, "closed-0001", "One");
    await send(store, "restart-0002", "Two", { ...target, pane: "w6:p2" });
    await store.observe("default", [{ ...pane("idle", "term-2"), pane_id: "w6:p2" }]);
    expect(store.status("closed-0001", target)).toMatchObject({ state: "failed", reason: "The agent's pane closed before it took the message." });
    expect(store.status("restart-0002", { ...target, pane: "w6:p2" })).toMatchObject({ state: "failed", reason: "The agent in this pane restarted before it took the message." });
  });

  it("when the agent ended its turn and stayed idle without it, but not while it works", async () => {
    const store = deliveries();
    await send(store, "dropped-0001", "Lost words");
    await store.observe("default", [pane("idle")]);
    clock += DELIVERY_GIVE_UP_MS * 10;
    // Idle without a Stop seen after the send: its hooks may not run here.
    await store.observe("default", [pane("idle")]);
    expect(store.status("dropped-0001", target).state).toBe("queued");
    clock += 1; store.stopped(target);
    await store.observe("default", [pane("working")]);
    clock += DELIVERY_GIVE_UP_MS;
    await store.observe("default", [pane("idle")]);
    clock += DELIVERY_GIVE_UP_MS - 1;
    await store.observe("default", [pane("idle")]);
    expect(store.status("dropped-0001", target).state).toBe("queued");
    clock += 1;
    await store.observe("default", [pane("idle")]);
    expect(store.status("dropped-0001", target)).toEqual({ state: "failed", reason: "The agent finished its turn without taking the message.", session: target.session });
    // Taken late after all (someone pressed Enter in the terminal).
    store.submitted(target, "Lost words");
    expect(store.status("dropped-0001", target).state).toBe("delivered");
  });

  it("unless its transcript shows it arrived (a steer its hook did not report)", async () => {
    const store = deliveries();
    await send(store, "steer-0001", "Also fix the lint");
    clock += 1; store.stopped(target);
    await store.observe("default", [pane("idle")]);
    landed = true; clock += DELIVERY_GIVE_UP_MS;
    await store.observe("default", [pane("idle")]);
    expect(store.status("steer-0001", target).state).toBe("delivered");
  });
});

describe("user text in transcripts", () => {
  it("reads Claude user rows and Codex user messages, not assistant rows", () => {
    expect(userTexts({ type: "user", message: { content: "Hello" } })).toEqual(["Hello"]);
    expect(userTexts({ type: "user", message: { content: [{ type: "text", text: "Hi" }, { type: "image" }] } })).toEqual(["Hi"]);
    expect(userTexts({ type: "event_msg", payload: { type: "user_message", message: "Go" } })).toEqual(["Go"]);
    expect(userTexts({ type: "response_item", payload: { type: "message", role: "user", content: [{ type: "input_text", text: "Go" }] } })).toEqual(["Go"]);
    expect(userTexts({ type: "response_item", payload: { type: "message", role: "assistant", content: [{ type: "output_text", text: "No" }] } })).toEqual([]);
  });
});
