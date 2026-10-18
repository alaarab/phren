import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DELIVERY_GIVE_UP_MS, DELIVERY_RETENTION_MS, IN_FLIGHT_MS, matchingOffsets, promptHash, PromptDeliveries, userTexts } from "./prompt-deliveries.js";
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
    await store.submitted(rotated, "Split PR #283 by scope");
    expect(store.status("rotate-0001", target)).toEqual({ state: "delivered", session: rotated.session });
    expect(store.forPane(rotated)).toEqual([{ deliveryId: "rotate-0001", state: "delivered", session: rotated.session }]);
  });

  it("keep back-to-back sends to a busy agent apart, each settled by its own id", async () => {
    const store = deliveries();
    await send(store, "first-0001", "Run the suite");
    await send(store, "second-0002", "Then open the PR");
    expect(store.forPane(target).map(item => item.state)).toEqual(["queued", "queued"]);
    await store.submitted(target, "Run the suite");
    expect(store.status("first-0001", target).state).toBe("delivered");
    expect(store.status("second-0002", target).state).toBe("queued");
    await store.submitted(target, "Then open the PR");
    expect(store.status("second-0002", target).state).toBe("delivered");
  });

  it("settle the same words sent twice one submission at a time", async () => {
    const store = deliveries();
    await send(store, "same-0001", "yes");
    await send(store, "same-0002", "yes");
    await store.submitted(target, "yes");
    expect([store.status("same-0001", target).state, store.status("same-0002", target).state]).toEqual(["delivered", "queued"]);
  });

  it("leave a prompt typed by hand in another pane alone", async () => {
    const store = deliveries();
    await send(store, "mine-0001", "continue");
    await store.submitted({ ...target, pane: "w6:p2" }, "continue");
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
    await restarted.submitted(rotated, "Merge the deps branch");
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
    await store.submitted(target, "Lost words");
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
  it("leaves a user row to its hook while the agent works: one turn settles one message", async () => {
    const store = deliveries();
    await send(store, "row-0001", "yes", claudeTarget);
    clock += 10; await send(store, "row-0002", "yes", claudeTarget);
    landed = true; matches = 1; hookRows = true; clock += 3_000;
    await store.observe("default", [claudePane("working")]);
    // The row's own UserPromptSubmit settles the first; nothing the transcript said claimed an entry.
    expect(store.status("row-0001", claudeTarget).state).toBe("queued");
    clock += 5_000; await store.submitted(claudeTarget, "yes");
    expect(store.status("row-0001", claudeTarget).state).toBe("delivered");
    expect(store.status("row-0002", claudeTarget).state).toBe("queued");
    await store.observe("default", [claudePane("working")]);
    expect(store.status("row-0002", claudeTarget).state).toBe("queued");
    // The second turn's row is in the transcript now.
    matches = 2; clock += 5_000; await store.submitted(claudeTarget, "yes");
    expect(store.status("row-0002", claudeTarget).state).toBe("delivered");
  });
  it("settles a user row at idle only for a hook that never came, once per row", async () => {
    const store = deliveries();
    await send(store, "idle-0001", "yes", claudeTarget);
    clock += 10; await send(store, "idle-0002", "yes", claudeTarget);
    // Stop before the settlement: the idle check reads the row, and there is no hook left to come.
    clock += 1; store.stopped(claudeTarget);
    landed = true; matches = 1; hookRows = true;
    await store.observe("default", [claudePane("idle")]);
    clock += DELIVERY_GIVE_UP_MS;
    await store.observe("default", [claudePane("idle")]);
    expect(store.status("idle-0001", claudeTarget).state).toBe("delivered");
    // One row, one message: the second was not taken (it fails loudly).
    expect(store.status("idle-0002", claudeTarget).state).toBe("failed");
    // A delayed callback for the row the idle check already claimed settles nothing more, even the failed message.
    await store.submitted(claudeTarget, "yes");
    expect(store.status("idle-0002", claudeTarget).state).toBe("failed");
    // The next turn's own row and callback settle it.
    matches = 2; await store.submitted(claudeTarget, "yes");
    expect(store.status("idle-0002", claudeTarget).state).toBe("delivered");
  });
  it("is unaffected by a Stop that lands while the transcript is being read", async () => {
    let store!: PromptDeliveries;
    let stopDuringRead = false, rows: { offset: number; hook: boolean }[] = [{ offset: 0, hook: false }];
    store = new PromptDeliveries(undefined, () => clock, async () => {
      if (stopDuringRead) store.stopped(claudeTarget);
      return rows;
    });
    stores.push(store);
    await send(store, "mid-read-1", "yes", claudeTarget);
    clock += 10; await send(store, "mid-read-2", "yes", claudeTarget);
    stopDuringRead = true; clock += 3_000;
    await store.observe("default", [claudePane("working")]);
    expect(store.status("mid-read-1", claudeTarget).state).toBe("delivered");
    expect(store.status("mid-read-2", claudeTarget).state).toBe("queued");
    rows = [{ offset: 0, hook: false }, { offset: 100, hook: true }];
    await store.submitted(claudeTarget, "yes");
    expect(store.status("mid-read-2", claudeTarget).state).toBe("delivered");
  });
  it("keeps a Stop across a restart, so an idle pane's message is still failed", async () => {
    const store = deliveries();
    await send(store, "stop-0001", "Go on", claudeTarget);
    clock += 1; store.stopped(claudeTarget);
    await store.flush();
    const restarted = deliveries();
    await restarted.observe("default", [claudePane("idle")]);
    clock += DELIVERY_GIVE_UP_MS;
    await restarted.observe("default", [claudePane("idle")]);
    expect(restarted.status("stop-0001", claudeTarget).state).toBe("failed");
  });
  it("settles nothing for a callback when no unclaimed row is within reach of the message", async () => {
    const store = deliveries();
    await send(store, "far-0001", "yes", claudeTarget);
    clock += 10; await send(store, "far-0002", "yes", claudeTarget);
    // First message settled from its row at idle; the second message is far newer than that row, so its scan window holds no row at all.
    clock += 1; store.stopped(claudeTarget);
    landed = true; matches = 1; hookRows = true;
    await store.observe("default", [claudePane("idle")]);
    clock += DELIVERY_GIVE_UP_MS;
    await store.observe("default", [claudePane("idle")]);
    expect(store.status("far-0001", claudeTarget).state).toBe("delivered");
    const state = store.status("far-0002", claudeTarget).state;
    landed = false;
    await store.submitted(claudeTarget, "yes");
    expect(store.status("far-0002", claudeTarget).state).toBe(state);
  });
  it("claims rows per conversation: a new conversation's row at the same offset is its own", async () => {
    const store = deliveries();
    await send(store, "conv-0001", "yes", claudeTarget);
    clock += 1; store.stopped(claudeTarget);
    landed = true; matches = 1; hookRows = true;
    await store.observe("default", [claudePane("idle")]);
    clock += DELIVERY_GIVE_UP_MS;
    await store.observe("default", [claudePane("idle")]);
    expect(store.status("conv-0001", claudeTarget).state).toBe("delivered");
    // /clear: another conversation, its own transcript, a row at the same byte offset 0.
    const next: Target = { ...claudeTarget, session: "00000000-bbbb-7000-8000-00000000000c" };
    clock += 10; await send(store, "conv-0002", "yes", next);
    await store.submitted(next, "yes");
    expect(store.status("conv-0002", next).state).toBe("delivered");
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
  it("reads a dequeued-from-the-queue row as the user's words", async () => {
    expect(userTexts({ type: "queue-operation", operation: "remove", reason: "absorbed_mid_turn", content: "from my phone" })).toEqual(["from my phone"]);
    expect(userTexts({ type: "queue-operation", operation: "remove", reason: "delivered_to_agent", content: "from my phone" })).toEqual(["from my phone"]);
    // Input the agent never saw is not input it took.
    expect(userTexts({ type: "queue-operation", operation: "remove", reason: "cleared_on_cancel", content: "from my phone" })).toEqual([]);
    expect(userTexts({ type: "queue-operation", operation: "remove", content: "from my phone" })).toEqual([]);
    expect(userTexts({ type: "queue-operation", operation: "enqueue", content: "from my phone" })).toEqual([]);
    expect(userTexts({ type: "queue-operation", operation: "dequeue" })).toEqual([]);
  });
  it("settles from a user row while the agent works in a pane that sends no callbacks", async () => {
    const store = deliveries();
    await send(store, "nohook-01", "Start the build", claudeTarget);
    landed = true; hookRows = true; clock += 3_000;
    await store.observe("default", [claudePane("working")]);
    // Its hook would claim the row: give it a check's time.
    expect(store.status("nohook-01", claudeTarget).state).toBe("queued");
    clock += 3_000;
    await store.observe("default", [claudePane("working")]);
    expect(store.status("nohook-01", claudeTarget).state).toBe("delivered");
  });
  it("never downgrades a message its hook settled while the idle check was reading", async () => {
    let store!: PromptDeliveries;
    let reads = 0;
    store = new PromptDeliveries(undefined, () => clock, async () => {
      // The idle check's read: the hook arrives, claims its row (the hook's own read), and only then does the idle read return nothing.
      if (++reads === 1) { await store.submitted(claudeTarget, "yes"); return []; }
      return [{ offset: 0, hook: true }];
    });
    stores.push(store);
    await send(store, "race-0001", "yes", claudeTarget);
    clock += 1; store.stopped(claudeTarget);
    await store.observe("default", [claudePane("idle")]);
    clock += DELIVERY_GIVE_UP_MS;
    await store.observe("default", [claudePane("idle")]);
    expect(store.status("race-0001", claudeTarget).state).toBe("delivered");
  });
  it("settles at once on a hook that came before its row was written, as Claude writes the row after its hooks", async () => {
    const store = deliveries();
    await send(store, "early-0001", "yes", claudeTarget);
    hookRows = true;
    await store.submitted(claudeTarget, "yes");
    expect(store.status("early-0001", claudeTarget).state).toBe("delivered");
    // Its row, written once the hooks returned, is not offered to the next identical message.
    clock += 1_000; await send(store, "early-0002", "yes", claudeTarget);
    landed = true; clock += 3_000;
    await store.observe("default", [claudePane("working")]);
    clock += 1; store.stopped(claudeTarget);
    await store.observe("default", [claudePane("idle")]);
    clock += DELIVERY_GIVE_UP_MS;
    await store.observe("default", [claudePane("idle")]);
    expect(store.status("early-0002", claudeTarget).state).toBe("failed");
  });
  it("keeps a hook's claim waiting for its own row when an identical message already claimed one in the conversation", async () => {
    const store = deliveries();
    await send(store, "claimed-01", "yes", claudeTarget);
    // Its user row, seen on two checks in a pane that has sent no callbacks yet.
    landed = true; hookRows = true; clock += 3_000;
    await store.observe("default", [claudePane("working")]);
    clock += 3_000; await store.observe("default", [claudePane("working")]);
    expect(store.status("claimed-01", claudeTarget).state).toBe("delivered");
    clock += 10_000; await send(store, "claimed-02", "yes", claudeTarget);
    // The first message's row is past this one's scan window: none readable yet for the callback.
    landed = false;
    await store.submitted(claudeTarget, "yes");
    expect(store.status("claimed-02", claudeTarget).state).toBe("queued");
    landed = true; matches = 2; clock += 3_000;
    await store.observe("default", [claudePane("working")]);
    expect(store.status("claimed-02", claudeTarget).state).toBe("delivered");
  });
  it("does not let a late hook whose transcript cannot be read confirm a later identical message", async () => {
    let readable = true;
    const store = new PromptDeliveries(undefined, () => clock, async () => { if (!readable) throw new Error("EIO"); return [{ offset: 0, hook: true }]; });
    stores.push(store);
    await send(store, "unread-01", "yes", claudeTarget);
    // Its user row, seen on two checks in a pane that has sent no callbacks yet.
    clock += 3_000; await store.observe("default", [claudePane("working")]);
    clock += 3_000; await store.observe("default", [claudePane("working")]);
    expect(store.status("unread-01", claudeTarget).state).toBe("delivered");
    clock += 1_000; await send(store, "unread-02", "yes", claudeTarget);
    // The first message's hook, late, and the transcript unreadable now.
    readable = false;
    await store.submitted(claudeTarget, "yes");
    expect(store.status("unread-02", claudeTarget).state).toBe("queued");
  });
  it("keeps the row of a message its hook settled unread for that message after a restart, while the agent works", async () => {
    let readable = false;
    const store = () => { const made = new PromptDeliveries(file, () => clock, async () => { if (!readable) throw new Error("EIO"); return [{ offset: 0, hook: true }]; }); stores.push(made); return made; };
    const first = store();
    await send(first, "unread-a1", "yes", claudeTarget);
    await first.submitted(claudeTarget, "yes");
    expect(first.status("unread-a1", claudeTarget).state).toBe("delivered");
    await first.flush();
    // After a restart (no callbacks seen yet) an identical message within the scan slack must not take A's row.
    readable = true;
    const restarted = store();
    clock += 1_000; await send(restarted, "unread-b1", "yes", claudeTarget);
    clock += 3_000; await restarted.observe("default", [claudePane("working")]);
    clock += 3_000; await restarted.observe("default", [claudePane("working")]);
    expect(restarted.status("unread-b1", claudeTarget).state).toBe("queued");
  });
  it("settles in the conversation that submitted it, and turns a failed message delivered when its late hook comes", async () => {
    const next: Target = { ...claudeTarget, session: "00000000-cccc-7000-8000-00000000000d" };
    const store = deliveries();
    await send(store, "clear-0001", "yes", claudeTarget);
    // /clear, then the new conversation submits it before its row is written.
    await store.submitted(next, "yes");
    expect(store.status("clear-0001", claudeTarget)).toEqual({ state: "delivered", session: next.session });
    await send(store, "late-0001", "go", claudeTarget);
    clock += 1; store.stopped(claudeTarget);
    await store.observe("default", [claudePane("idle")]);
    clock += DELIVERY_GIVE_UP_MS;
    await store.observe("default", [claudePane("idle")]);
    expect(store.status("late-0001", claudeTarget).state).toBe("failed");
    hookRows = true;
    await store.submitted(claudeTarget, "go");
    expect(store.status("late-0001", claudeTarget).state).toBe("delivered");
  });
  it("keeps the row a message without a phone id claimed across a restart", async () => {
    const store = deliveries();
    expect(await store.expect(claudeTarget, "yes", 1)).toBe("pending");
    landed = true; matches = 1; clock += 3_000;
    await store.observe("default", [claudePane("working")]);
    await store.flush();
    const restarted = deliveries();
    clock += 1_000; await send(restarted, "after-0001", "yes", claudeTarget);
    clock += 3_000;
    await restarted.observe("default", [claudePane("working")]);
    expect(restarted.status("after-0001", claudeTarget).state).toBe("queued");
  });
  it("leaves Codex delivery as it was: not settled from a transcript while the agent works", async () => {
    const store = deliveries();
    await send(store, "codex-0001", "yes");
    landed = true; clock += 3_000;
    await store.observe("default", [pane("working")]);
    expect(store.status("codex-0001", target).state).toBe("queued");
  });
  it("counts one entry for a row that repeats the words", async () => {
    const at = 1_000;
    const row = (blocks: string[], stamp: string) => JSON.stringify({ type: "user", timestamp: stamp, message: { content: blocks.map(text => ({ type: "text", text })) } });
    const lines = [row(["other"], "2026-10-14T00:00:00.000Z"), row(["yes", "yes"], "2026-10-14T00:00:01.000Z"), row(["yes"], "2026-10-14T00:00:02.000Z")];
    const buffer = Buffer.from(lines.join("\n") + "\n");
    const offsets = matchingOffsets(buffer, 100, { hash: promptHash("yes"), at });
    expect(offsets.map(entry => entry.offset)).toEqual([100 + Buffer.byteLength(lines[0] + "\n" + lines[1] + "\n"), 100 + Buffer.byteLength(lines[0] + "\n")]);
    expect(offsets.every(entry => entry.hook)).toBe(true);
    expect(matchingOffsets(Buffer.from(JSON.stringify({ type: "queue-operation", operation: "remove", reason: "absorbed_mid_turn", content: "yes", timestamp: "2026-10-14T00:00:02.000Z" }) + "\n"), 0, { hash: promptHash("yes"), at })).toEqual([{ offset: 0, hook: false, at: Date.parse("2026-10-14T00:00:02.000Z") }]);
  });
  it("finds a queued message taken mid-turn behind the older attachment rows Claude writes after it", () => {
    // 2026-10-17: two voice messages queued, both taken at :27; the attachment of the first,
    // stamped when it was typed, follows the removals and is older than the second message's window.
    const line = (row: Json) => JSON.stringify(row);
    const lines = [
      line({ type: "queue-operation", operation: "enqueue", content: "[voice] check the build again", timestamp: "2026-10-17T22:34:23.699Z" }),
      line({ type: "queue-operation", operation: "remove", reason: "absorbed_mid_turn", content: "[voice] check the build again", timestamp: "2026-10-17T22:34:27.049Z" }),
      line({ type: "attachment", timestamp: "2026-10-17T22:34:15.589Z" }),
      line({ type: "attachment", timestamp: "2026-10-17T22:34:21.692Z" }),
    ];
    const at = Date.parse("2026-10-17T22:34:21.379Z");
    expect(matchingOffsets(Buffer.from(lines.join("\n") + "\n"), 0, { hash: promptHash("[voice] check the build again"), at }))
      .toEqual([{ offset: Buffer.byteLength(lines[0] + "\n"), hook: false, at: Date.parse("2026-10-17T22:34:27.049Z") }]);
    // A row with these words from before the window still does not count.
    expect(matchingOffsets(Buffer.from(lines.join("\n") + "\n"), 0, { hash: promptHash("[voice] check the build again"), at: at + 60_000 })).toEqual([]);
  });
});

describe("a message that will never settle", () => {
  it("holds its pane only while young, unless the pane's hooks will settle it", async () => {
    // A Copilot pane, or Codex without hooks: no UserPromptSubmit or Stop ever settles what was typed there.
    const store = deliveries(), hooked: Target = { ...target, pane: "w6:p2" };
    store.stopped(hooked);
    clock += 1; await send(store, "nohook-0001", "Run the suite");
    await send(store, "hooked-0001", "Run the suite", hooked);
    expect([store.holding(target), store.held("nohook-0001", target), store.holding(hooked)]).toEqual([true, true, true]);
    clock += IN_FLIGHT_MS;
    expect([store.holding(target), store.held("nohook-0001", target)]).toEqual([false, false]);
    // Still queued for the phone: only the hold on the pane ends.
    expect(store.status("nohook-0001", target).state).toBe("queued");
    expect([store.holding(hooked), store.held("hooked-0001", hooked)]).toEqual([true, true]);
  });
  it("is not taken late by an identical prompt after the pane's next Stop", async () => {
    const store = deliveries();
    await send(store, "lost-0001", "go");
    store.fail("lost-0001", target, "The agent did not take the message; it may still be in its input line.");
    clock += 1; store.stopped(target);
    clock += 60_000; await store.submitted(target, "go");
    expect(store.status("lost-0001", target).state).toBe("failed");
  });
});

describe("identical Claude messages and their rows", () => {
  it("gives a message its hook settled the row written after it, not a later identical message that was dropped", async () => {
    // A "yes" settled by its hook at t, its row written after the hooks; a second "yes" typed 6 s later and dropped (Esc).
    let rows: { offset: number; hook: boolean; at?: number }[] = [];
    const store = new PromptDeliveries(undefined, () => clock, async () => rows);
    stores.push(store);
    await send(store, "hooked-a1", "yes", claudeTarget);
    clock += 1_000; await store.submitted(claudeTarget, "yes");
    expect(store.status("hooked-a1", claudeTarget).state).toBe("delivered");
    const settledAt = clock;
    clock += 6_000; await send(store, "dropped-b1", "yes", claudeTarget);
    rows = [{ offset: 0, hook: true, at: settledAt + 3_000 }];
    clock += 1; store.stopped(claudeTarget);
    await store.observe("default", [claudePane("idle")]);
    clock += DELIVERY_GIVE_UP_MS;
    await store.observe("default", [claudePane("idle")]);
    expect(store.status("dropped-b1", claudeTarget).state).toBe("failed");
  });
  it("settles a repeated short reply on its hook after an earlier one was taken mid-turn", async () => {
    // The first "yes" was absorbed into the running turn (a queue removal, no hook); the second starts a turn.
    let rows: { offset: number; hook: boolean }[] = [{ offset: 0, hook: false }];
    const store = new PromptDeliveries(undefined, () => clock, async () => rows);
    stores.push(store);
    await send(store, "steer-0001", "yes", claudeTarget);
    clock += 3_000; await store.observe("default", [claudePane("working")]);
    expect(store.status("steer-0001", claudeTarget).state).toBe("delivered");
    clock += 1_000; await send(store, "turn-00002", "yes", claudeTarget);
    rows = [{ offset: 0, hook: false }];
    await store.submitted(claudeTarget, "yes");
    expect(store.status("turn-00002", claudeTarget).state).toBe("delivered");
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
    await store.submitted(target, "Run the suite");
    expect(store.status("left-0001", target).state).toBe("delivered");
  });
});

describe("user text in transcripts", () => {
  it("reads Claude user rows and Codex user messages, not assistant rows", async () => {
    expect(userTexts({ type: "user", message: { content: "Hello" } })).toEqual(["Hello"]);
    expect(userTexts({ type: "user", message: { content: [{ type: "text", text: "Hi" }, { type: "image" }] } })).toEqual(["Hi"]);
    expect(userTexts({ type: "event_msg", payload: { type: "user_message", message: "Go" } })).toEqual(["Go"]);
    expect(userTexts({ type: "response_item", payload: { type: "message", role: "user", content: [{ type: "input_text", text: "Go" }] } })).toEqual(["Go"]);
    expect(userTexts({ type: "response_item", payload: { type: "message", role: "assistant", content: [{ type: "output_text", text: "No" }] } })).toEqual([]);
  });
});
