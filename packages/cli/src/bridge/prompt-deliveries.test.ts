import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DELIVERY_GIVE_UP_MS, DELIVERY_RETENTION_MS, IN_FLIGHT_MS, matchingOffsets, promptHash, PromptDeliveries, transcriptLine, transcriptSize, userTexts } from "./prompt-deliveries.js";
import type { Json, Target } from "./protocol.js";
import { clearAccountCaches } from "./claude-accounts.js";
import { TranscriptReader } from "./transcripts.js";

const target: Target = { server: "default", workspace: "w6", tab: "w6:t1", pane: "w6:p1", source: "codex", session: "01a10831-4b62-7000-8000-000000000001" };
const rotated: Target = { ...target, session: "01a10985-bf36-7000-8000-000000000002" };
let root: string, file: string, clock: number, landed: boolean, matches = 1, hookRows = false, stores: PromptDeliveries[] = [];
/** The transcript is empty when each message is registered, so every fixture row was written after it. */
const deliveries = () => { const store = new PromptDeliveries(file, () => clock, async () => landed ? Array.from({ length: matches }, (_, i) => ({ offset: i * 100, hook: hookRows })) : [], async () => 0); stores.push(store); return store; };
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

describe("held messages Claude submits as one turn", () => {
  it("settle each of two short messages joined by a newline", async () => {
    const store = deliveries();
    await send(store, "join-0001", "Run the suite", claudeTarget);
    await send(store, "join-0002", "Then open the PR", claudeTarget);
    await store.submitted(claudeTarget, "Run the suite\nThen open the PR");
    expect(store.forPane(claudeTarget).map(item => item.state)).toEqual(["delivered", "delivered"]);
  });

  it("settle only whole lines: a short reply does not settle inside a longer line", async () => {
    const store = deliveries();
    await send(store, "part-0001", "yes", claudeTarget);
    await send(store, "part-0002", "Check the logs", claudeTarget);
    await store.submitted(claudeTarget, "yes, but later\nCheck the logs");
    expect(store.status("part-0001", claudeTarget).state).toBe("queued");
    expect(store.status("part-0002", claudeTarget).state).toBe("delivered");
  });

  it("settle three messages, one of them several lines long", async () => {
    const store = deliveries();
    await send(store, "three-0001", "First step", claudeTarget);
    await send(store, "three-0002", "Second step\nwith a detail", claudeTarget);
    await send(store, "three-0003", "yes", claudeTarget);
    await store.submitted(claudeTarget, "First step\nSecond step\nwith a detail\nyes");
    expect(store.forPane(claudeTarget).map(item => item.state)).toEqual(["delivered", "delivered", "delivered"]);
  });

  it("leave messages held in another pane alone", async () => {
    const store = deliveries();
    await send(store, "other-0001", "Run the suite", claudeTarget);
    await send(store, "other-0002", "Then open the PR", claudeTarget);
    await store.submitted({ ...claudeTarget, pane: "w6:p2" }, "Run the suite\nThen open the PR");
    expect(store.forPane(claudeTarget).map(item => item.state)).toEqual(["queued", "queued"]);
  });

  it("do not let a joined message claim a later message's row", async () => {
    const store = deliveries();
    await send(store, "rowj-0001", "A", claudeTarget);
    await send(store, "rowj-0002", "B", claudeTarget);
    await store.submitted(claudeTarget, "A\nB");
    clock += 1_000; await send(store, "rowj-0003", "A", claudeTarget);
    // The new message's row is in the transcript, and its hook never came.
    clock += 1; store.stopped(claudeTarget);
    landed = true; matches = 1; hookRows = true;
    await store.observe("default", [claudePane("idle")]);
    clock += DELIVERY_GIVE_UP_MS;
    await store.observe("default", [claudePane("idle")]);
    expect(store.status("rowj-0003", claudeTarget).state).toBe("delivered");
  });

  it("leave the joined turn's own row to it, not to a later message with the same words", async () => {
    const store = deliveries();
    await send(store, "rowc-0001", "A", claudeTarget);
    await send(store, "rowc-0002", "B", claudeTarget);
    await store.submitted(claudeTarget, "A\nB");
    // Only the joined turn's row is in the transcript; the new message was never taken.
    clock += 1_000; await send(store, "rowc-0003", "A\nB", claudeTarget);
    clock += 1; store.stopped(claudeTarget);
    landed = true; matches = 1; hookRows = true;
    await store.observe("default", [claudePane("idle")]);
    clock += DELIVERY_GIVE_UP_MS;
    await store.observe("default", [claudePane("idle")]);
    expect(store.status("rowc-0003", claudeTarget).state).toBe("failed");
  });

  it("settle a later identical batch, and keep the joined turn's row across a restart", async () => {
    const store = deliveries();
    await send(store, "again-j001", "A", claudeTarget);
    await send(store, "again-j002", "B", claudeTarget);
    await store.submitted(claudeTarget, "A\nB");
    await send(store, "again-j003", "A", claudeTarget);
    await send(store, "again-j004", "B", claudeTarget);
    await store.submitted(claudeTarget, "A\nB");
    expect(store.forPane(claudeTarget).map(item => item.state)).toEqual(["delivered", "delivered", "delivered", "delivered"]);
    // A message settled inside an earlier join does not stop a later prompt with its words from being split.
    await send(store, "again-j006", "A\nB", claudeTarget);
    await send(store, "again-j007", "C", claudeTarget);
    await store.submitted(claudeTarget, "A\nB\nC");
    await send(store, "again-j008", "A", claudeTarget);
    await send(store, "again-j009", "B", claudeTarget);
    await store.submitted(claudeTarget, "A\nB");
    expect(["again-j008", "again-j009"].map(id => store.status(id, claudeTarget).state)).toEqual(["delivered", "delivered"]);
    await store.flush();
    const restarted = deliveries();
    clock += 1_000; await send(restarted, "again-j005", "A\nB", claudeTarget);
    clock += 1; restarted.stopped(claudeTarget);
    landed = true; matches = 2; hookRows = true;
    await restarted.observe("default", [claudePane("idle")]);
    clock += DELIVERY_GIVE_UP_MS;
    await restarted.observe("default", [claudePane("idle")]);
    // Two joined turns, two rows: neither is the new message's.
    expect(restarted.status("again-j005", claudeTarget).state).toBe("failed");
  });

  it("match only held messages, never a failed one", async () => {
    const store = deliveries();
    await send(store, "fail-0001", "A\nB", claudeTarget);
    store.fail("fail-0001", claudeTarget, "gone");
    await send(store, "fail-0002", "A", claudeTarget);
    await send(store, "fail-0003", "B", claudeTarget);
    await send(store, "fail-0004", "C", claudeTarget);
    await store.submitted(claudeTarget, "A\nB\nC");
    expect(store.forPane(claudeTarget).map(item => item.state)).toEqual(["failed", "delivered", "delivered", "delivered"]);
  });

  it("do not split a late hook for a message already delivered whole", async () => {
    const store = deliveries();
    store.delivered("whole-0001", claudeTarget, "A\nB");
    await send(store, "whole-0002", "A", claudeTarget);
    await send(store, "whole-0003", "B", claudeTarget);
    await store.submitted(claudeTarget, "A\nB");
    expect(store.status("whole-0002", claudeTarget).state).toBe("queued");
    expect(store.status("whole-0003", claudeTarget).state).toBe("queued");
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

  describe("in a Codex transcript", () => {
    /** A transcript of rows with these words, 100 bytes each, of which the last 512 KiB are read. */
    let rows: { offset: number; hook: boolean; at?: number }[], size: number;
    const TAIL = 524_288;
    const write = (row: { hook?: boolean; at?: number } = {}) => { rows.push({ offset: size, hook: row.hook ?? true, ...("at" in row ? { at: row.at } : { at: clock + 50 }) }); size += 100; };
    /** Tool output pushes everything written so far out of the read tail. */
    const evict = () => { size += TAIL + 1_000; };
    const codex = () => {
      const store = new PromptDeliveries(file, () => clock, async () => rows.filter(row => row.offset >= size - TAIL), async () => size);
      stores.push(store); return store;
    };
    /** The agent's turn ends and it stays idle until the message is checked against the transcript. */
    async function giveUp(store: PromptDeliveries) {
      clock += 1; store.stopped(target);
      await store.observe("default", [pane("idle")]);
      clock += DELIVERY_GIVE_UP_MS;
      await store.observe("default", [pane("idle")]);
    }
    beforeEach(() => { rows = []; size = 4_096; });

    it("does not count the row of an identical message sent moments before", async () => {
      const store = codex();
      await send(store, "yes-first", "yes");
      write(); await store.submitted(target, "yes");
      expect(store.status("yes-first", target).state).toBe("delivered");
      // Within the scan's lookback, so the first message's row is still read.
      clock += 2_000; await send(store, "yes-second", "yes");
      await giveUp(store);
      expect(store.status("yes-second", target).state).toBe("failed");
    });

    it("counts a row written after the message was typed", async () => {
      const store = codex();
      await send(store, "yes-only", "yes");
      write({ hook: false });
      await giveUp(store);
      expect(store.status("yes-only", target).state).toBe("delivered");
    });

    it("settles one of two identical messages per row", async () => {
      const store = codex();
      await send(store, "yes-a", "yes");
      clock += 10; await send(store, "yes-b", "yes");
      write({ hook: false });
      await giveUp(store);
      expect([store.status("yes-a", target).state, store.status("yes-b", target).state]).toEqual(["delivered", "failed"]);
    });

    it("leaves a row to the earlier identical message its hook settled before the row was written", async () => {
      const store = codex();
      await send(store, "yes-hooked", "yes");
      await store.submitted(target, "yes");
      clock += 1_000; await send(store, "yes-later", "yes");
      // The first message's row is written after the second was typed.
      write();
      await giveUp(store);
      expect(store.status("yes-later", target).state).toBe("failed");
    });

    it("takes its own row when an earlier identical message its hook settled has one too", async () => {
      const store = codex();
      await send(store, "yes-hooked", "yes");
      await store.submitted(target, "yes");
      clock += 1_000; await send(store, "yes-later", "yes");
      write(); write({ hook: false });
      await giveUp(store);
      expect(store.status("yes-later", target).state).toBe("delivered");
    });

    it("keeps the only row of a later message whose earlier twin's row left the read tail", async () => {
      // Codex review: "yes" A was hook-confirmed, tool output evicted its row, and B's own row was reserved for A.
      const store = codex();
      await send(store, "yes-early", "yes");
      // Codex writes the row after its hooks return; the next tick claims it for its message.
      await store.submitted(target, "yes");
      write(); clock += 3_000; await store.observe("default", [pane("working")]);
      evict();
      clock += 1_000; await send(store, "yes-late", "yes");
      write({ hook: false });
      await giveUp(store);
      expect(store.status("yes-late", target).state).toBe("delivered");
    });

    it("reserves no row for an earlier message whose own row may have left the read tail", async () => {
      const store = codex();
      await send(store, "yes-early", "yes");
      // Its hook came before its row; the row was written, then pushed out of the tail before any check claimed it.
      await store.submitted(target, "yes");
      write(); evict();
      clock += 1_000; await send(store, "yes-late", "yes");
      write({ hook: false });
      await giveUp(store);
      expect(store.status("yes-late", target).state).toBe("delivered");
    });

    it("counts its own row after the Hook's clock moved back", async () => {
      // Codex review: a row stamped a second before registration (an NTP step back) is still written after it.
      const store = codex();
      await send(store, "yes-skew", "yes");
      write({ hook: false, at: clock - 1_000 });
      await giveUp(store);
      expect(store.status("yes-skew", target).state).toBe("delivered");
    });

    it("takes a 0.155 thread's cursor from its copy as it stands, and an empty one for a thread with none", async () => {
      vi.stubEnv("PHREN_BRIDGE_HOME", path.join(root, "bridge")); vi.stubEnv("CODEX_HOME", path.join(root, "codex"));
      try {
        // No rollout, no copy, no thread store: a conversation not written yet.
        expect(await transcriptSize(target)).toBe(0);
        // A copy holding an old "yes": its size, even when appending to it fails, so the old row stays before the cursor.
        const copy = path.join(root, "bridge", "codex-threads", `${target.session}.jsonl`);
        await mkdir(path.dirname(copy), { recursive: true });
        await writeFile(copy, JSON.stringify({ type: "response_item", payload: { type: "message", role: "user", content: [{ type: "input_text", text: "yes" }] } }) + "\n");
        const before = await readFile(copy, "utf8");
        expect(await transcriptSize(target)).toBe(Buffer.byteLength(before));
        expect(await readFile(copy, "utf8")).toBe(before);
      } finally { vi.unstubAllEnvs(); }
    });

    it("never confirms by a materialized Codex 0.155 row from before the message", async () => {
      // Codex review: rows the Hook materializes from thread_history_1.sqlite carry no timestamp.
      const lines = [
        JSON.stringify({ type: "session_meta", payload: { id: target.session, source: "codex-thread-store" } }),
        JSON.stringify({ type: "response_item", payload: { type: "message", role: "user", content: [{ type: "input_text", text: "yes" }] } }),
        JSON.stringify({ type: "response_item", payload: { type: "message", role: "assistant", content: [{ type: "output_text", text: "Done." }] } }),
      ];
      let transcript = Buffer.from(lines.join("\n") + "\n");
      const store = new PromptDeliveries(file, () => clock, async record => matchingOffsets(transcript, 0, record), async () => transcript.length);
      stores.push(store);
      expect(matchingOffsets(transcript, 0, { hash: promptHash("yes"), at: clock })).toHaveLength(1);
      await send(store, "yes-dropped", "yes");
      await giveUp(store);
      expect(store.status("yes-dropped", target).state).toBe("failed");

      await send(store, "yes-taken", "yes");
      transcript = Buffer.concat([transcript, Buffer.from(lines[1] + "\n")]);
      await giveUp(store);
      expect(store.status("yes-taken", target).state).toBe("delivered");
    });
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
  it("counts a Codex turn's user_message event and its response_item copy as one entry", () => {
    const at = Date.parse("2026-10-14T00:00:00.000Z"), stamp = "2026-10-14T00:00:01.000Z";
    const item = JSON.stringify({ type: "response_item", timestamp: stamp, payload: { type: "message", role: "user", content: [{ type: "input_text", text: "yes" }] } });
    const event = JSON.stringify({ type: "event_msg", timestamp: stamp, payload: { type: "user_message", message: "yes" } });
    const rollout = Buffer.from(`${item}\n${event}\n`);
    // The event is the entry; the item the stream shows for it is `shown`.
    expect(matchingOffsets(rollout, 0, { hash: promptHash("yes"), at })).toEqual([{ offset: Buffer.byteLength(item + "\n"), hook: false, at: Date.parse(stamp), shown: 0 }]);
    // A thread materialized from Codex 0.155's history has only the items.
    expect(matchingOffsets(Buffer.from(`${item}\n`), 0, { hash: promptHash("yes"), at })).toEqual([{ offset: 0, hook: false, at: Date.parse(stamp) }]);
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

describe("the row a phone message landed as", () => {
  // Rows sit 100 bytes apart in these fixtures, so a row's line is its offset / 100.
  const lineOf = async (_record: unknown, offset: number) => offset / 100;

  it("names the Claude row its hook settled it before the row was written, once that row appears", async () => {
    let rows: { offset: number; hook: boolean; at?: number; uuid?: string }[] = [];
    const store = new PromptDeliveries(file, () => clock, async () => rows, async () => 0, lineOf);
    stores.push(store);
    await send(store, "landed-c01", "Ship it", claudeTarget);
    clock += 1_000; await store.submitted(claudeTarget, "Ship it");
    // Delivered on the hook's word: no row yet, so no `landed`.
    expect(store.status("landed-c01", claudeTarget)).toEqual({ state: "delivered", session: claudeTarget.session });
    rows = [{ offset: 300, hook: true, at: clock + 500, uuid: "8a1b2c3d-0000-4000-8000-00000000c001" }];
    clock += 3_000; await store.observe("default", [claudePane("working")]);
    await vi.waitFor(() => expect(store.status("landed-c01", claudeTarget).landed).toEqual({ line: 3, uuid: "8a1b2c3d-0000-4000-8000-00000000c001" }));
    expect(store.forPane(claudeTarget)[0]).toMatchObject({ deliveryId: "landed-c01", state: "delivered", landed: { line: 3 } });
    // Kept across a Hook restart.
    await store.flush();
    const restarted = new PromptDeliveries(file, () => clock, async () => rows, async () => 0, lineOf);
    stores.push(restarted);
    expect(restarted.status("landed-c01", claudeTarget).landed).toEqual({ line: 3, uuid: "8a1b2c3d-0000-4000-8000-00000000c001" });
  });

  it("names the row a message was taken from the transcript by, and never a row an earlier identical message has", async () => {
    let rows: { offset: number; hook: boolean; at?: number }[] = [];
    const store = new PromptDeliveries(undefined, () => clock, async () => rows, async () => 0, lineOf);
    stores.push(store);
    await send(store, "steer-l001", "yes", claudeTarget);
    // Taken into the running turn (a queue removal, no hook).
    rows = [{ offset: 200, hook: false }];
    clock += 3_000; await store.observe("default", [claudePane("working")]);
    await vi.waitFor(() => expect(store.status("steer-l001", claudeTarget).landed).toEqual({ line: 2 }));
    await send(store, "steer-l002", "yes", claudeTarget);
    rows = [{ offset: 200, hook: false }, { offset: 500, hook: false }];
    clock += 3_000; await store.observe("default", [claudePane("working")]);
    await vi.waitFor(() => expect(store.status("steer-l002", claudeTarget).landed).toEqual({ line: 5 }));
    expect(store.status("steer-l001", claudeTarget).landed).toEqual({ line: 2 });
  });

  it("names the Codex row a message's hook settled it before", async () => {
    let rows: { offset: number; hook: boolean; at?: number }[] = [];
    const store = new PromptDeliveries(undefined, () => clock, async () => rows, async () => 0, lineOf);
    stores.push(store);
    await send(store, "codex-l001", "Run the suite");
    await store.submitted(target, "Run the suite");
    rows = [{ offset: 700, hook: true }];
    clock += 3_000; await store.observe("default", [pane("working")]);
    await vi.waitFor(() => expect(store.status("codex-l001", target).landed).toEqual({ line: 7 }));
  });

  it("says nothing it could not count, and nothing for a message still held or failed", async () => {
    const store = new PromptDeliveries(undefined, () => clock, async () => [{ offset: 100, hook: false }], async () => 0, async () => undefined);
    stores.push(store);
    await send(store, "nocount-01", "yes", claudeTarget);
    expect(store.status("nocount-01", claudeTarget).landed).toBeUndefined();
    clock += 3_000; await store.observe("default", [claudePane("working")]);
    expect(store.status("nocount-01", claudeTarget)).toEqual({ state: "delivered", session: claudeTarget.session });
  });

  it("counts a row's line as the conversation stream numbers it, and reads Claude's row uuid", async () => {
    const rows = [
      JSON.stringify({ type: "system", subtype: "init" }),
      JSON.stringify({ type: "user", uuid: "11111111-0000-4000-8000-000000000001", timestamp: new Date(clock + 1_000).toISOString(), message: { role: "user", content: "Ship it" } }),
    ];
    const text = `${rows.join("\n")}\n`;
    const offsets = matchingOffsets(Buffer.from(text), 0, { hash: promptHash("Ship it"), at: clock });
    expect(offsets).toEqual([{ offset: rows[0].length + 1, hook: true, at: clock + 1_000, uuid: "11111111-0000-4000-8000-000000000001" }]);
    const projects = path.join(root, "claude", "projects", "-repo");
    await mkdir(projects, { recursive: true });
    await writeFile(path.join(projects, `${claudeTarget.session}.jsonl`), text);
    vi.stubEnv("HOME", root); vi.stubEnv("CLAUDE_CONFIG_DIR", path.join(root, "claude"));
    clearAccountCaches();
    try {
      expect(await transcriptLine(claudeTarget, offsets[0].offset)).toBe(1);
      expect(await transcriptLine(claudeTarget, 0)).toBe(0);
      // An offset past the end (the file was replaced) is not a line.
      expect(await transcriptLine(claudeTarget, text.length + 10)).toBeUndefined();
    } finally { vi.unstubAllEnvs(); clearAccountCaches(); }
  });

  it("names the Codex rollout row the conversation stream shows, not the event that is the turn", async () => {
    const at = clock;
    const rows = [
      JSON.stringify({ type: "session_meta", timestamp: new Date(at).toISOString(), payload: { id: target.session } }),
      JSON.stringify({ type: "response_item", timestamp: new Date(at + 1_000).toISOString(), payload: { type: "message", role: "user", content: [{ type: "input_text", text: "Run the suite" }] } }),
      JSON.stringify({ type: "event_msg", timestamp: new Date(at + 1_000).toISOString(), payload: { type: "user_message", message: "Run the suite" } }),
    ];
    const text = `${rows.join("\n")}\n`;
    const sessions = path.join(root, "codex", "sessions", "2026", "10", "28");
    await mkdir(sessions, { recursive: true });
    const rollout = path.join(sessions, `rollout-2026-10-28T12-00-00-${target.session}.jsonl`);
    await writeFile(rollout, text);
    vi.stubEnv("CODEX_HOME", path.join(root, "codex")); vi.stubEnv("PHREN_BRIDGE_HOME", path.join(root, "bridge"));
    try {
      const [entry] = matchingOffsets(Buffer.from(text), 0, { hash: promptHash("Run the suite"), at });
      // The event is what is claimed; the item before it is what the stream shows.
      expect(entry.offset).toBe(rows[0].length + rows[1].length + 2);
      expect(entry.shown).toBe(rows[0].length + 1);
      const shown = (await new TranscriptReader(rollout, "codex").read()).entries.find(item => (item.raw as Json & { payload?: Json }).payload?.role === "user");
      expect(await transcriptLine(target, entry.shown!)).toBe(shown?.line);
      // Through the store: a message its hook settled names that line once its rows are read.
      const store = new PromptDeliveries(undefined, () => clock);
      stores.push(store);
      await send(store, "rollout-l01", "Run the suite");
      await store.submitted(target, "Run the suite");
      await vi.waitFor(() => expect(store.status("rollout-l01", target).landed).toEqual({ line: shown?.line }));
    } finally { vi.unstubAllEnvs(); }
  });

  it("refuses a line for an offset that no longer starts the claimed row (a transcript made again)", async () => {
    const rows = [
      JSON.stringify({ type: "user", uuid: "22222222-0000-4000-8000-000000000001", message: { role: "user", content: "First" } }),
      JSON.stringify({ type: "user", uuid: "22222222-0000-4000-8000-000000000002", message: { role: "user", content: "Second" } }),
    ];
    const projects = path.join(root, "claude", "projects", "-repo");
    await mkdir(projects, { recursive: true });
    await writeFile(path.join(projects, `${claudeTarget.session}.jsonl`), `${rows.join("\n")}\n`);
    vi.stubEnv("HOME", root); vi.stubEnv("CLAUDE_CONFIG_DIR", path.join(root, "claude"));
    clearAccountCaches();
    try {
      const second = rows[0].length + 1;
      expect(await transcriptLine(claudeTarget, second, "22222222-0000-4000-8000-000000000002")).toBe(1);
      // Mid-row, or another row's id at that offset: not this message's row.
      expect(await transcriptLine(claudeTarget, second + 3)).toBeUndefined();
      expect(await transcriptLine(claudeTarget, second, "22222222-0000-4000-8000-000000000001")).toBeUndefined();
    } finally { vi.unstubAllEnvs(); clearAccountCaches(); }
  });

  it("lets an identical Claude message settle on its own hook after an earlier one claimed its row only to name it", async () => {
    let rows: { offset: number; hook: boolean; at?: number }[] = [];
    const store = new PromptDeliveries(undefined, () => clock, async () => rows, async () => 0, lineOf);
    stores.push(store);
    await send(store, "again-0001", "continue", claudeTarget);
    clock += 1_000; await store.submitted(claudeTarget, "continue");
    rows = [{ offset: 100, hook: true, at: clock + 200 }];
    clock += 3_000; await store.observe("default", [claudePane("working")]);
    await vi.waitFor(() => expect(store.status("again-0001", claudeTarget).landed).toEqual({ line: 1 }));
    // The same words again, a turn later: its own hook settles it at once, with no row of its own yet.
    clock += 1_000; await send(store, "again-0002", "continue", claudeTarget);
    await store.submitted(claudeTarget, "continue");
    expect(store.status("again-0002", claudeTarget).state).toBe("delivered");
    // And it never names the first one's row; it takes its own when that appears.
    expect(store.status("again-0002", claudeTarget).landed).toBeUndefined();
    rows = [{ offset: 100, hook: true, at: clock - 4_800 }, { offset: 400, hook: true, at: clock + 200 }];
    clock += 3_000; await store.observe("default", [claudePane("working")]);
    await vi.waitFor(() => expect(store.status("again-0002", claudeTarget).landed).toEqual({ line: 4 }));
  });

  it("keeps the rows beside the records, so an older Hook still reads every record", async () => {
    let rows: { offset: number; hook: boolean; at?: number; uuid?: string }[] = [];
    const store = new PromptDeliveries(file, () => clock, async () => rows, async () => 0, lineOf);
    stores.push(store);
    await send(store, "beside-001", "Ship it", claudeTarget);
    rows = [{ offset: 200, hook: false, uuid: "33333333-0000-4000-8000-000000000001" }];
    clock += 3_000; await store.observe("default", [claudePane("working")]);
    await vi.waitFor(() => expect(store.status("beside-001", claudeTarget).landed).toBeDefined());
    await store.flush();
    const records = JSON.parse(await readFile(file, "utf8")).records as Json[];
    expect(Object.keys(records[0]).filter(key => key.startsWith("entry")).sort()).toEqual(["entry", "entryHook"]);
    expect(JSON.parse(await readFile(`${file}.landed.json`, "utf8"))).toEqual({ "beside-001": { line: 2, uuid: "33333333-0000-4000-8000-000000000001" } });
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
