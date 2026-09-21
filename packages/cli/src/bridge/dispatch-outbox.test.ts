import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ClaudeBackgroundInbox, CodexBackgroundInbox, DispatchOutbox, pruneDispatchArtifacts, type BackgroundDelivery } from "./dispatch-outbox.js";

const parent = { server: "default", workspace: "w1", tab: "t1", pane: "p1", source: "codex" as const,
  session: "aaaaaaaa-1111-4111-8111-111111111111" };
const report = { dispatchId: "bbbbbbbb-2222-4222-8222-222222222222", turnId: "turn-1", parentTarget: parent,
  envelope: "<task-notification>safe</task-notification>" };

describe("dispatch report outbox", () => {
  let root: string;
  beforeEach(async () => { root = await mkdtemp(path.join(tmpdir(), "phren-report-outbox-")); });
  afterEach(async () => { vi.useRealTimers(); await rm(root, { recursive: true, force: true }); });

  it("deduplicates a backlog by dispatch and remote turn", async () => {
    const outbox = new DispatchOutbox(root);
    const first = await outbox.enqueue(report), duplicate = await outbox.enqueue(report);
    expect(duplicate.id).toBe(first.id);
    expect(await readdir(path.join(root, "dispatch-outbox"))).toHaveLength(1);
  });

  it("never replays a lost acknowledgement", async () => {
    let calls = 0;
    const adapter: BackgroundDelivery = { supported: async () => true, enqueue: async () => { calls++; return "uncertain"; } };
    const outbox = new DispatchOutbox(root), queued = await outbox.enqueue(report);
    expect((await outbox.deliver(queued.id, adapter)).state).toBe("deliveryUncertain");
    expect((await outbox.deliver(queued.id, adapter)).state).toBe("deliveryUncertain");
    expect(calls).toBe(1);
  });

  it("backs off an unavailable exact-session inbox without replaying early", async () => {
    let now = 1_000_000, probes = 0;
    const adapter: BackgroundDelivery = { supported: async () => { probes++; return false; }, enqueue: async () => "delivered" };
    const outbox = new DispatchOutbox(root, () => now), queued = await outbox.enqueue(report);
    const first = await outbox.deliver(queued.id, adapter);
    expect(first).toMatchObject({ state: "pending", attempts: 1, nextAttemptAt: new Date(now + 1000).toISOString() });
    await outbox.deliver(queued.id, adapter); expect(probes).toBe(1);
    now += 1000;
    const second = await outbox.deliver(queued.id, adapter);
    expect(second).toMatchObject({ state: "pending", attempts: 2, nextAttemptAt: new Date(now + 2000).toISOString() });
  });

  it("recovers safely after every persisted outbox step", async () => {
    const outbox = new DispatchOutbox(root), queued = await outbox.enqueue(report);
    expect((await new DispatchOutbox(root).recover())[0].state).toBe("pending");
    const file = path.join(root, `dispatch-outbox/${queued.id}.json`), value = JSON.parse(await readFile(file, "utf8"));
    await writeFile(file, JSON.stringify({ ...value, state: "submitting" }));
    expect((await new DispatchOutbox(root).recover())[0].state).toBe("deliveryUncertain");
    const uncertain = JSON.parse(await readFile(file, "utf8"));
    await writeFile(file, JSON.stringify({ ...uncertain, state: "delivered" }));
    expect((await new DispatchOutbox(root).recover())[0].state).toBe("delivered");
  });

  it("binds the Codex command and inert Claude adapter to the exact parent session", async () => {
    const calls: string[][] = [];
    const run = vi.fn(async (_file: string, args: readonly string[]) => {
      calls.push([...args]); return { stdout: "--thread --message", stderr: "" };
    });
    const codex = new CodexBackgroundInbox("codex", run as never);
    expect(await codex.enqueue(parent, report.envelope)).toBe("delivered");
    expect(calls.at(-1)).toEqual(["queue", "--thread", parent.session, "--message", report.envelope]);

    let delivered: unknown;
    const claudeTarget = { ...parent, source: "claude" as const };
    const claude = new ClaudeBackgroundInbox(async (target, envelope) => { delivered = { target, envelope }; return "delivered"; });
    expect(await claude.enqueue(claudeTarget, report.envelope)).toBe("delivered");
    expect(delivered).toEqual({ target: claudeTarget, envelope: report.envelope });
    expect(await new ClaudeBackgroundInbox().enqueue(claudeTarget, report.envelope)).toBe("unavailable");
  });

  it("retains active and uncertain work while pruning only finished groups", async () => {
    const old = new Date(0).toISOString(), recent = new Date().toISOString();
    await Promise.all(["dispatches", "dispatch-reports", "dispatch-outbox"].map(directory =>
      mkdir(path.join(root, directory), { recursive: true })));
    const finished = "cccccccc-3333-4333-8333-333333333333", uncertain = "dddddddd-4444-4444-8444-444444444444";
    await writeFile(path.join(root, `dispatches/${finished}.json`), JSON.stringify({ id: finished, state: "accepted", updatedAt: old }));
    await writeFile(path.join(root, `dispatch-reports/${finished}.json`), JSON.stringify({ dispatchId: finished, reportState: "completed", updatedAt: old }));
    await writeFile(path.join(root, `dispatches/${uncertain}.json`), JSON.stringify({ id: uncertain, state: "uncertain", updatedAt: old }));
    const fresh = "eeeeeeee-5555-4555-8555-555555555555";
    await writeFile(path.join(root, `dispatches/${fresh}.json`), JSON.stringify({ id: fresh, state: "accepted", updatedAt: recent }));
    await writeFile(path.join(root, `dispatch-reports/${fresh}.json`), JSON.stringify({ dispatchId: fresh, reportState: "completed", updatedAt: recent }));
    const result = await pruneDispatchArtifacts(root, Date.now(), { maxBytes: 1_000_000 });
    expect(result.removed).toBe(2);
    expect(await readFile(path.join(root, `dispatches/${uncertain}.json`), "utf8")).toContain("uncertain");
    expect(await readFile(path.join(root, `dispatches/${fresh}.json`), "utf8")).toContain("accepted");
    expect((await pruneDispatchArtifacts(root, Date.now(), { maxBytes: 1 })).removed).toBe(2);
    await expect(readFile(path.join(root, `dispatches/${fresh}.json`), "utf8")).rejects.toThrow();
    expect(await readFile(path.join(root, `dispatches/${uncertain}.json`), "utf8")).toContain("uncertain");
  });
});
