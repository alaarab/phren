import { randomUUID } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readAccountLimits, type AccountRoom } from "./account-choice.js";
import { AccountFailover, continuationBrief, planContinuation, type ComputerRooms } from "./account-failover.js";
import { dispatchStatus, type Receipt } from "./dispatch.js";
import type { Json } from "./protocol.js";

const now = Date.parse("2026-10-10T12:00:00Z");
const at = (hours: number) => new Date(now + hours * 3_600_000).toISOString();
const room = (account: string, key: string, fiveHour: number, extra: Partial<AccountRoom> = {}): AccountRoom =>
  ({ account, key, usable: true, fiveHour: { leftPercent: fiveHour, resetsAt: at(2) }, week: { leftPercent: 50, resetsAt: at(72) }, ...extra });
const LIMIT = "Claude usage limit: You've hit your session limit · resets 3pm";

describe("where a worker stopped by its usage limit continues", () => {
  const stopped = { computer: "Mini", account: "default" };
  // The stopped login (claude:a) is already in the ledger when the plan is made.
  const held = [{ key: "claude:a", account: "default", until: at(2), at: at(0) }];

  it("stays on the same computer when another account there has room, even if another computer has more", () => {
    const plan = planContinuation(stopped, [
      { computer: "MacBook", local: false, rooms: [room("work", "claude:b", 100)] },
      { computer: "Mini", local: true, rooms: [room("default", "claude:a", 90), room("work", "claude:b", 30)] }], held);
    expect(plan).toMatchObject({ computer: "Mini", account: "work" });
  });

  it("moves to another computer when none is left on its own, never to the same login signed in there", () => {
    const plan = planContinuation(stopped, [
      { computer: "Mini", local: true, rooms: [room("default", "claude:a", 90), room("work", "claude:b", 0, { exhausted: true })] },
      { computer: "MacBook", local: false, rooms: [room("default", "claude:a", 100), room("spare", "claude:c", 40)] },
      { computer: "NAS", local: false, rooms: [room("other", "claude:d", 20)] }], held);
    expect(plan).toMatchObject({ computer: "MacBook", account: "spare" });
    expect("reason" in plan && plan.reason).toContain("Mini has no other account with room");
  });

  it("reports why when no account anywhere has room", () => {
    const plan = planContinuation(stopped, [{ computer: "Mini", local: true, rooms: [room("default", "claude:a", 90), room("work", "claude:b", 0, { exhausted: true })] }], held);
    expect(plan).toEqual({ error: "No other Claude account has room: Mini: default: hit its limit, held until 2026-10-10T14:00:00.000Z, work: out of quota." });
  });
});

describe("the continuation brief", () => {
  const receipt = { id: randomUUID(), label: "Fix parser", computer: "Mini", account: "default",
    returned: { state: "failed", at: at(0), read: false, error: LIMIT, reply: "Fixed the tokenizer; the grammar is next.", checkout: { path: "/repo/.worktrees/parser", branch: "fix/parser" } } } as unknown as Receipt;

  it("hands over the limit, the checkout, the last reply and the original brief", () => {
    const brief = continuationBrief(receipt, "Fix the parser and open a PR.", "Mini", "Mini");
    expect(brief).toContain(`continuing dispatch ${receipt.id} ("Fix parser")`);
    expect(brief).toContain("Its checkout: /repo/.worktrees/parser on branch fix/parser. Work there.");
    expect(brief).toContain("Fixed the tokenizer; the grammar is next.");
    expect(brief.endsWith("---\nFix the parser and open a PR.")).toBe(true);
  });

  it("tells a worker on another computer to fetch the branch, and cuts an oversized brief to the dispatch limit", () => {
    const brief = continuationBrief(receipt, "x".repeat(40_000), "MacBook", "Mini");
    expect(brief).toContain("on Mini, not this computer. If that branch was pushed, fetch it");
    expect(brief.length).toBeLessThanOrEqual(32_768);
    expect(brief).toContain("The original brief was cut to fit");
  });
});

describe("continuing a stopped worker from the returns loop", () => {
  let root: string;
  const id = randomUUID();
  const save = (receipt: Json) => writeFileSync(path.join(root, "dispatches", `${receipt.id}.json`), JSON.stringify(receipt));
  const stoppedReceipt = (extra: Json = {}) => ({ id, computer: "Mini", project: "phren", harness: "claude", label: "Fix parser", model: "opus",
    createdAt: at(-1), updatedAt: at(0), state: "accepted", origin: { server: "default", workspace: "w1", tab: "w1:t1", pane: "w1:p1", agent: "claude", terminal: "term-1" },
    returned: { state: "failed", at: at(0), read: true, notifiedAt: at(0), error: LIMIT }, ...extra });
  const rooms: ComputerRooms[] = [{ computer: "Mini", local: true, rooms: [room("default", "claude:a", 0, { exhausted: true, until: at(2) }), room("work", "claude:b", 80)] }];

  beforeEach(() => {
    root = mkdtempSync(path.join(tmpdir(), "phren-failover-"));
    mkdirSync(path.join(root, "dispatches"));
    vi.stubEnv("PHREN_BRIDGE_HOME", root);
  });
  afterEach(() => { vi.unstubAllEnvs(); rmSync(root, { recursive: true, force: true }); });

  const failover = (dispatch: (input: Json, origin: unknown, continues: string) => Promise<Json>, enabled = true) => new AccountFailover({
    rooms: async () => rooms, dispatch, isLocal: computer => computer === "Mini", localBrief: async () => "Fix the parser.", enabled: () => enabled, now: () => now });

  it("dispatches the next account with room once, holds the stopped login back, and returns \"continued on account X\" unread", async () => {
    save(stoppedReceipt());
    const calls: Array<[Json, unknown, string]> = [];
    const run = failover(async (input, origin, continues) => { calls.push([input, origin, continues]); return { id: "11111111-1111-4111-8111-111111111111", state: "accepted" }; });
    await run.run(); await run.run();
    expect(calls).toHaveLength(1);
    expect(calls[0][0]).toMatchObject({ computer: "Mini", project: "phren", harness: "claude", account: "work", model: "opus", label: "Fix parser (continued)" });
    expect(calls[0][1]).toEqual({ server: "default", workspace: "w1", tab: "w1:t1", pane: "w1:p1" });
    expect(calls[0][2]).toBe(id);
    expect(String(calls[0][0].prompt)).toContain("Fix the parser.");
    const [receipt] = await dispatchStatus();
    expect(receipt.continued).toMatchObject({ id: "11111111-1111-4111-8111-111111111111", computer: "Mini", account: "work" });
    expect(receipt.returned).toMatchObject({ state: "failed", read: false });
    expect(receipt.returned?.notifiedAt).toBeUndefined();
    expect(receipt.returned?.error).toMatch(/^Continued on account work on Mini \(dispatch 11111111-/);
    expect(await readAccountLimits(now)).toMatchObject([{ key: "claude:a", account: "default", until: at(2) }]);
  });

  it("records why when no other account has room, without dispatching", async () => {
    save(stoppedReceipt({ account: "work" }));
    const dispatch = vi.fn();
    await new AccountFailover({ rooms: async () => [{ computer: "Mini", local: true, rooms: [room("default", "claude:a", 0, { exhausted: true }), room("work", "claude:b", 80)] }],
      dispatch, isLocal: () => true, localBrief: async () => "Fix the parser.", enabled: () => true, now: () => now }).run();
    expect(dispatch).not.toHaveBeenCalled();
    const [receipt] = await dispatchStatus();
    expect(receipt.continued?.error).toMatch(/^No other Claude account has room/);
    expect(receipt.returned?.read).toBe(false);
  });

  it("leaves the worker stopped when the owner turned failover off, and ignores other failures", async () => {
    save(stoppedReceipt());
    const dispatch = vi.fn();
    await failover(dispatch, false).run();
    rmSync(path.join(root, "dispatches", `${id}.json`));
    save(stoppedReceipt({ returned: { state: "failed", at: at(0), read: true, error: "API Error: Connection lost mid-response." } }));
    await failover(dispatch).run();
    expect(dispatch).not.toHaveBeenCalled();
    expect((await dispatchStatus())[0].continued).toBeUndefined();
  });
});
