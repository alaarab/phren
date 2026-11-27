import { mkdtemp, rm } from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { OwnerInbox } from "./owner-inbox.js";
import { OwnerInboxPushSweep } from "./owner-inbox-push.js";
import { observeInboxTick } from "./server.js";

const AT = Date.parse("2026-11-27T10:00:00.000Z");
const DEVICE = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
let root: string;

beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), "phren-inbox-server-"));
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date(AT));
});
afterEach(async () => {
  vi.useRealTimers();
  await rm(root, { recursive: true, force: true });
});

describe("server inbox tick", () => {
  it("hands the reconciled CLI add to the sweep and sends it once", async () => {
    const inbox = new OwnerInbox(async () => [], path.join(root, "owner-inbox.json"));
    const sent: Array<{ id: string; title: string }> = [], devices: string[] = [];
    const sweep = new OwnerInboxPushSweep({
      ownerInboxPushDevices: () => devices,
      notifyOwnerInbox: async value => { sent.push({ id: value.id, title: value.title }); return true; },
    }, { file: path.join(root, "owner-inbox-push.json"), now: Date.now });

    // The first tick initializes the ledger before any phone registered.
    await observeInboxTick(inbox, sweep);
    vi.setSystemTime(new Date(AT + 1000));
    const added = await inbox.run({ action: "add", title: "OVH US VPS-2 is in stock" });
    devices.push(DEVICE);
    await observeInboxTick(inbox, sweep);
    expect(sent).toEqual([{ id: (added.item as { id: string }).id, title: "OVH US VPS-2 is in stock" }]);
    await observeInboxTick(inbox, sweep);
    expect(sent).toHaveLength(1);
  });

  it("still reconciles when no sweep is wired", async () => {
    const inbox = new OwnerInbox(async () => [], path.join(root, "owner-inbox.json"));
    await expect(observeInboxTick(inbox)).resolves.toBeUndefined();
  });
});
