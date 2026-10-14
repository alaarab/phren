import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DELIVERY_GIVE_UP_MS, DELIVERY_RETENTION_MS, matchingOffsets, promptHash, PromptDeliveries, userTexts } from "./prompt-deliveries.js";
import type { Json, Target } from "./protocol.js";

const target: Target = { server: "default", workspace: "w6", tab: "w6:t1", pane: "w6:p1", source: "codex", session: "01a10831-4b62-7000-8000-000000000001" };
const rotated: Target = { ...target, session: "01a10985-bf36-7000-8000-000000000002" };
let root: string, file: string, clock: number, landed: boolean, matches = 1, hookRows = false, stores: PromptDeliveries[] = [];
const deliveries = () => { const store = new PromptDeliveries(file, () => clock, async () => landed ? Array.from({ length: matches }, (_, i) => ({ offset: i * 100, hook: hookRows })) : []); stores.push(store); return store; };
const claudeTarget: Target = { ...target, source: "claude" };
const pane = (status: string, terminal = "term-1", agent = "codex"): Json => ({ pane_id: target.pane, agent, terminal_id: terminal, agent_status: status });
const claudePane = (status: string): Json => pane(status, "term-1", "claude");
/** Typed into a busy pane and answered queued, as /v1/prompt does. */
async function send(store: PromptDeliveries, id: string, text: string, where = target) {
  expect(await store.expect(where, text, 1, undefined, id, "term-1")).toBe("pending");
  store.queue(id, where);
}

beforeEach(async () => { root = await mkdtemp(path.join(tmpdir(), "phren-deliveries-")); file = path.join(root, "deliveries.json"); clock = 1_000_000; landed = false; matches = 1; hookRows = false; });
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

describe("a message the agent took into its running turn", () => {
  it("is delivered while the agent still works, not left queued until its turn ends", async () => {
    const store = deliveries();
    await send(store, "mid-0001", "How long until it is all in?", claudeTarget);
    await store.observe("default", [claudePane("working")]);
    expect(store.status("mid-0001", claudeTarget).state).toBe("queued");
    landed = true; clock += 3_000;
    await store.observe("default", [claudePane("working")]);
    expect(store.status("mid-0001", claudeTarget).state).toBe("delivered");
  });
  it("settles one of two identical messages per transcript entry", async () => {
    const store = deliveries();
    await send(store, "yes-00001", "yes", claudeTarget);
    clock += 10; await send(store, "yes-00002", "yes", claudeTarget);
    landed = true; matches = 1; clock += 3_000;
    await store.observe("default", [claudePane("working")]);
    expect(store.status("yes-00001", claudeTarget).state).toBe("delivered");
    expect(store.status("yes-00002", claudeTarget).state).toBe("queued");
    matches = 2; clock += 3_000;
    await store.observe("default", [claudePane("working")]);
    expect(store.status("yes-00002", claudeTarget).state).toBe("delivered");
  });
  it("does not offer an entry an earlier identical message settled with to a later one", async () => {
    const store = deliveries();
    await send(store, "again-0001", "yes", claudeTarget);
    landed = true; matches = 1; clock += 3_000;
    await store.observe("default", [claudePane("working")]);
    expect(store.status("again-0001", claudeTarget).state).toBe("delivered");
    // A second "yes" a moment later: the scan still sees the first entry (it reaches back past the send).
    clock += 1_000; await send(store, "again-0002", "yes", claudeTarget);
    clock += 3_000;
    await store.observe("default", [claudePane("working")]);
    expect(store.status("again-0002", claudeTarget).state).toBe("queued");
    matches = 2; clock += 3_000;
    await store.observe("default", [claudePane("working")]);
    expect(store.status("again-0002", claudeTarget).state).toBe("delivered");
  });
  it("gives a late hook to the message the transcript settled, not to another with the same words", async () => {
    const store = deliveries();
    await send(store, "late-0001", "yes", claudeTarget);
    clock += 10; await send(store, "late-0002", "yes", claudeTarget);
    landed = true; matches = 1; hookRows = true; clock += 3_000;
    await store.observe("default", [claudePane("working")]);
    expect(store.status("late-0001", claudeTarget).state).toBe("delivered");
    // The UserPromptSubmit for that same row arrives late.
    clock += 1_000; store.submitted(claudeTarget, "yes");
    expect(store.status("late-0002", claudeTarget).state).toBe("queued");
    // A hook for a second send is that message's own.
    clock += 1_000; store.submitted(claudeTarget, "yes");
    expect(store.status("late-0002", claudeTarget).state).toBe("delivered");
  });
  it("survives a Hook restart after the transcript check", async () => {
    const store = deliveries();
    await send(store, "keep-0001", "Still queued", claudeTarget);
    await store.observe("default", [claudePane("working")]);
    await send(store, "keep-0002", "Saves the file again", claudeTarget);
    await store.flush();
    const restarted = deliveries();
    expect(restarted.status("keep-0001", claudeTarget).state).toBe("queued");
  });
  it("is looked for in the transcript at most every few seconds", async () => {
    const calls: number[] = [];
    const store = new PromptDeliveries(undefined, () => clock, async () => { calls.push(clock); return []; });
    await send(store, "mid-0002", "Anything yet?", claudeTarget);
    await store.observe("default", [claudePane("working")]);
    clock += 1_000; await store.observe("default", [claudePane("working")]);
    clock += 2_000; await store.observe("default", [claudePane("working")]);
    expect(calls.length).toBe(2);
  });
  it("reads a dequeued-from-the-queue row as the user's words", () => {
    expect(userTexts({ type: "queue-operation", operation: "remove", reason: "absorbed_mid_turn", content: "from my phone" })).toEqual(["from my phone"]);
    expect(userTexts({ type: "queue-operation", operation: "remove", reason: "delivered_to_agent", content: "from my phone" })).toEqual(["from my phone"]);
    // Input the agent never saw is not input it took.
    expect(userTexts({ type: "queue-operation", operation: "remove", reason: "cleared_on_cancel", content: "from my phone" })).toEqual([]);
    expect(userTexts({ type: "queue-operation", operation: "remove", content: "from my phone" })).toEqual([]);
    expect(userTexts({ type: "queue-operation", operation: "enqueue", content: "from my phone" })).toEqual([]);
    expect(userTexts({ type: "queue-operation", operation: "dequeue" })).toEqual([]);
  });
  it("leaves Codex delivery as it was: not settled from a transcript while the agent works", async () => {
    const store = deliveries();
    await send(store, "codex-0001", "yes");
    landed = true; clock += 3_000;
    await store.observe("default", [pane("working")]);
    expect(store.status("codex-0001", target).state).toBe("queued");
  });
  it("counts one entry for a row that repeats the words", () => {
    const at = 1_000;
    const row = (blocks: string[], stamp: string) => JSON.stringify({ type: "user", timestamp: stamp, message: { content: blocks.map(text => ({ type: "text", text })) } });
    const lines = [row(["other"], "2026-10-14T00:00:00.000Z"), row(["yes", "yes"], "2026-10-14T00:00:01.000Z"), row(["yes"], "2026-10-14T00:00:02.000Z")];
    const buffer = Buffer.from(lines.join("\n") + "\n");
    const offsets = matchingOffsets(buffer, 100, { hash: promptHash("yes"), at });
    expect(offsets.map(entry => entry.offset)).toEqual([100 + Buffer.byteLength(lines[0] + "\n" + lines[1] + "\n"), 100 + Buffer.byteLength(lines[0] + "\n")]);
    expect(offsets.every(entry => entry.hook)).toBe(true);
    expect(matchingOffsets(Buffer.from(JSON.stringify({ type: "queue-operation", operation: "remove", reason: "absorbed_mid_turn", content: "yes", timestamp: "2026-10-14T00:00:02.000Z" }) + "\n"), 0, { hash: promptHash("yes"), at })).toEqual([{ offset: 0, hook: false }]);
  });
});

describe("a message held by a Codex thread the pane has left", () => {
  it("fails loudly, and still settles if the old thread takes it after all", async () => {
    const store = deliveries();
    await send(store, "left-0001", "Run the suite");
    await send(store, "other-0002", "Elsewhere", { ...target, pane: "w6:p2" });
    store.threadChanged(target);
    expect(store.status("left-0001", target)).toEqual({ state: "failed", reason: "The pane moved to another Codex conversation before the agent took the message.", session: target.session });
    expect(store.status("other-0002", { ...target, pane: "w6:p2" }).state).toBe("queued");
    store.submitted(target, "Run the suite");
    expect(store.status("left-0001", target).state).toBe("delivered");
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
