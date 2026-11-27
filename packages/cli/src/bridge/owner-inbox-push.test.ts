import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { tmpdir } from "node:os";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { OwnerInboxPushSweep, type OwnerInboxPushSender, type OwnerInboxPushValue } from "./owner-inbox-push.js";
import { OwnerInbox, type InboxItem } from "./owner-inbox.js";

const DAY = 24 * 60 * 60 * 1000;
const AT = Date.parse("2026-11-27T10:00:00.000Z");
const DEVICE_A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const DEVICE_B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";

let root: string, file: string, now: number;
const iso = (value: number) => new Date(value).toISOString();
const advance = (ms: number) => { now += ms; };

function row(overrides: Partial<InboxItem> = {}): InboxItem {
  return {
    id: randomUUID(), kind: "manual", title: "OVH US VPS-2 is in stock", state: "open",
    createdAt: iso(now), updatedAt: iso(now), ...overrides,
  };
}

interface FakeSender extends OwnerInboxPushSender {
  devices: string[];
  sent: Array<{ value: OwnerInboxPushValue; deviceID: string }>;
  attempts: string[];
  ok: (deviceID: string) => boolean;
}
function fakeSender(ok: (deviceID: string) => boolean = () => true): FakeSender {
  const sender: FakeSender = {
    devices: [], sent: [], attempts: [], ok,
    ownerInboxPushDevices: () => [...sender.devices],
    notifyOwnerInbox: vi.fn(async (value: OwnerInboxPushValue, deviceID: string) => {
      sender.attempts.push(`${value.id}:${deviceID}`);
      if (!sender.ok(deviceID)) return false;
      sender.sent.push({ value, deviceID }); return true;
    }),
  };
  return sender;
}

const sweep = (sender: FakeSender, options: { log?: (message: string) => void; backfillId?: string } = {}) =>
  new OwnerInboxPushSweep(sender, { file, now: () => now, ...options });
const ledger = async () => JSON.parse(await readFile(file, "utf8")) as {
  version: number; initializedAt: string; entries: Array<{ id: string; updatedAt: string; expiresAt: string; sentDeviceIDs: string[] }>;
};

beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), "phren-inbox-push-"));
  file = path.join(root, "owner-inbox-push.json");
  now = AT;
  delete process.env.PHREN_OWNER_INBOX_BACKFILL_ID;
});
afterEach(async () => {
  delete process.env.PHREN_OWNER_INBOX_BACKFILL_ID;
  vi.useRealTimers();
  await rm(root, { recursive: true, force: true });
});

describe("owner inbox push sweep", () => {
  it("seeds at most three recent rows before any phone registers, newest first, then delivers once", async () => {
    const sender = fakeSender();
    const ids = [
      "11111111-1111-4111-8111-111111111111", "22222222-2222-4222-8222-222222222222",
      "33333333-3333-4333-8333-333333333333", "44444444-4444-4444-8444-444444444444",
    ];
    const rows = ids.map((id, index) => row({
      id, title: `Row ${index + 1}`, createdAt: iso(AT - DAY + index * 1000), updatedAt: iso(AT - 4000 + index * 1000),
    }));
    const first = sweep(sender);
    await first.observe(rows);
    expect(sender.attempts).toEqual([]);
    const seeded = await ledger();
    expect(seeded.entries.map(entry => entry.id)).toEqual([ids[3], ids[2], ids[1]]);
    expect(seeded.entries.every(entry => entry.expiresAt === iso(AT + DAY) && entry.sentDeviceIDs.length === 0)).toBe(true);
    expect((await stat(file)).mode & 0o077).toBe(0);

    sender.devices.push(DEVICE_A);
    await first.observe(rows);
    expect(sender.attempts.map(attempt => attempt.split(":")[0]).sort()).toEqual([ids[1], ids[2], ids[3]].sort());
    expect(sender.sent).toHaveLength(3);
    await first.observe(rows);
    expect(sender.attempts).toHaveLength(3);
  });

  it("reserves the first backfill slot for the named open manual row regardless of its age", async () => {
    const sender = fakeSender();
    const oldId = "99999999-9999-4999-8999-999999999999";
    const old = row({ id: oldId, title: "OVH US VPS-2 is in stock", createdAt: iso(AT - 5 * DAY), updatedAt: iso(AT - 5 * DAY) });
    const recent = ["aaaaaaaa-1111-4111-8111-111111111111", "bbbbbbbb-1111-4111-8111-111111111111", "cccccccc-1111-4111-8111-111111111111"]
      .map((id, index) => row({ id, title: `Recent ${index + 1}`, createdAt: iso(AT - DAY + index * 1000), updatedAt: iso(AT - 3000 + index * 1000) }));
    process.env.PHREN_OWNER_INBOX_BACKFILL_ID = oldId;
    await sweep(sender).observe([old, ...recent]);
    const entries = (await ledger()).entries;
    expect(entries.map(entry => entry.id)).toEqual([oldId, recent[2].id, recent[1].id]);
    expect(entries[0].expiresAt).toBe(iso(AT + DAY));

    // A row that is not a manual item cannot take the reserved slot.
    await rm(file);
    process.env.PHREN_OWNER_INBOX_BACKFILL_ID = "88888888-8888-4888-8888-888888888888";
    const blocked = row({ id: "88888888-8888-4888-8888-888888888888", kind: "blocked", createdAt: iso(AT - 5 * DAY), updatedAt: iso(AT - 5 * DAY) });
    await sweep(sender).observe([blocked, ...recent]);
    expect((await ledger()).entries.map(entry => entry.id)).toEqual([recent[2].id, recent[1].id, recent[0].id]);
  });

  it("alerts a row created after the initial snapshot once, and never for a reword or a same-id reopen", async () => {
    const sender = fakeSender();
    sender.devices.push(DEVICE_A);
    const box = sweep(sender);
    await box.observe([]);
    advance(1000);
    const id = "12121212-1212-4212-8212-121212121212";
    const first = row({ id });
    await box.observe([first]);
    expect(sender.sent).toEqual([{ value: { id, title: first.title, expiresAt: iso(Date.parse(first.createdAt) + DAY) }, deviceID: DEVICE_A }]);

    advance(1000);
    const reworded = { ...first, title: "OVH US VPS-2 is back in stock", updatedAt: iso(now) };
    await box.observe([reworded]);
    // A resolved then reopened row keeps its id and still does not enqueue.
    await box.observe([{ ...reworded, state: "resolved", resolvedAt: iso(now) }]);
    await box.observe([{ ...reworded, state: "open", updatedAt: iso(now + 1) }]);
    expect(sender.attempts).toHaveLength(1);
  });

  it("retains a candidate through a reword and a temporary disappearance, sends only while open, and never past its deadline", async () => {
    const sender = fakeSender();
    const box = sweep(sender);
    await box.observe([]);
    advance(1000);
    const first = row({ id: "13131313-1313-4313-8313-131313131313" });
    await box.observe([first]);
    advance(1000);
    const reworded = { ...first, title: "OVH US VPS-2 is still in stock", updatedAt: iso(now) };
    await box.observe([reworded]);
    await box.observe([]);
    sender.devices.push(DEVICE_A);
    await box.observe([reworded]);
    expect(sender.sent).toHaveLength(1);
    expect(sender.sent[0].value.title).toBe(reworded.title);
    expect(sender.sent[0].value.expiresAt).toBe(iso(Date.parse(first.createdAt) + DAY));

    // A never-sent row kept with no phone expires and does not alert later.
    advance(1000);
    const second = row({ id: "14141414-1414-4414-8414-141414141414" });
    await box.observe([reworded, second]);
    expect(sender.sent).toHaveLength(2);
    advance(DAY);
    sender.devices.push(DEVICE_B);
    const late = row({ id: "15151515-1515-4515-8515-151515151515" });
    await box.observe([reworded, second, late]);
    // `second` is past its deadline; only the fresh row is attempted.
    expect(sender.attempts.filter(attempt => attempt.startsWith(`${second.id}:`))).toHaveLength(1);
  });

  it("keeps a candidate with no subscribed phone until its deadline, then drops it", async () => {
    const sender = fakeSender();
    const box = sweep(sender);
    await box.observe([]);
    advance(1000);
    const first = row({ id: "16161616-1616-4616-8616-161616161616" });
    // The owner opted Inbox alerts out: no device reports the kind.
    await box.observe([first]);
    expect(sender.attempts).toEqual([]);
    advance(DAY - 1000);
    sender.devices.push(DEVICE_A);
    await box.observe([first]);
    expect(sender.sent.map(item => item.value.id)).toEqual([first.id]);

    // An unsent row that outlives its 24-hour window never alerts.
    sender.devices.length = 0;
    advance(1000);
    const second = row({ id: "17171717-1717-4717-8717-171717171717" });
    await box.observe([first, second]);
    expect(sender.attempts).toHaveLength(1);
    advance(DAY);
    sender.devices.push(DEVICE_A);
    await box.observe([first, second]);
    expect(sender.sent.map(item => item.value.id)).toEqual([first.id]);

    // A row created after the window still alerts once.
    advance(1000);
    const third = row({ id: "18181818-1818-4818-8818-181818181818" });
    await box.observe([third]);
    expect(sender.sent.map(item => item.value.id)).toEqual([first.id, third.id]);
  });

  it("attempts at most three candidate/device pairs per sweep, oldest first", async () => {
    const sender = fakeSender();
    sender.devices.push(DEVICE_A);
    const box = sweep(sender);
    await box.observe([]);
    advance(1000);
    const rows = Array.from({ length: 5 }, (_, index) => row({
      id: `${index + 1}8181818-1818-4818-8818-181818181818`,
      title: `Queued ${index + 1}`, createdAt: iso(now + index * 1000), updatedAt: iso(now + index * 1000),
    }));
    await box.observe(rows);
    expect(sender.attempts).toEqual(rows.slice(0, 3).map(item => `${item.id}:${DEVICE_A}`));
    await box.observe(rows);
    expect(sender.attempts).toEqual(rows.map(item => `${item.id}:${DEVICE_A}`));
    await box.observe(rows);
    expect(sender.attempts).toHaveLength(5);
  });

  it("retries only the failed phone after a minute, never resending to the phone that accepted", async () => {
    const failing = new Set([DEVICE_B]);
    const sender = fakeSender(deviceID => !failing.has(deviceID));
    sender.devices.push(DEVICE_A, DEVICE_B);
    const box = sweep(sender);
    await box.observe([]);
    advance(1000);
    const first = row({ id: "19191919-1919-4919-8919-191919191919" });
    await box.observe([first]);
    expect(sender.attempts).toEqual([`${first.id}:${DEVICE_A}`, `${first.id}:${DEVICE_B}`]);
    expect(sender.sent.map(item => item.deviceID)).toEqual([DEVICE_A]);

    await box.observe([first]);
    expect(sender.attempts).toHaveLength(2);
    advance(59_999);
    await box.observe([first]);
    expect(sender.attempts).toHaveLength(2);
    advance(1);
    failing.clear();
    await box.observe([first]);
    expect(sender.attempts).toEqual([`${first.id}:${DEVICE_A}`, `${first.id}:${DEVICE_B}`, `${first.id}:${DEVICE_B}`]);
    expect(sender.sent.map(item => item.deviceID)).toEqual([DEVICE_A, DEVICE_B]);
  });

  it("does not resend after a restart, and a phone registering later still gets the retained row", async () => {
    const sender = fakeSender();
    sender.devices.push(DEVICE_A);
    const first = sweep(sender);
    await first.observe([]);
    advance(1000);
    const rowNow = row({ id: "1a1a1a1a-1a1a-4a1a-8a1a-1a1a1a1a1a1a" });
    await first.observe([rowNow]);
    expect(sender.sent.map(item => item.deviceID)).toEqual([DEVICE_A]);

    const restarted = fakeSender();
    restarted.devices.push(DEVICE_A, DEVICE_B);
    await sweep(restarted).observe([rowNow]);
    expect(restarted.sent.map(item => item.deviceID)).toEqual([DEVICE_B]);
  });

  it("never alerts a manual row that was resolved and reopened between ticks", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date(AT));
    const box = new OwnerInbox(async () => [], path.join(root, "owner-inbox.json"));
    const sender = fakeSender();
    sender.devices.push(DEVICE_A);
    const push = new OwnerInboxPushSweep(sender, { file, now: Date.now });
    await push.observe(await box.tick());
    vi.setSystemTime(new Date(AT + 1000));
    const added = (await box.run({ action: "add", title: "OVH US VPS-2 is in stock" })).item as InboxItem;
    await box.run({ action: "resolve", id: added.id, resolution: "done" });
    await box.run({ action: "add", id: added.id, title: "OVH US VPS-2 is back in stock" });
    await push.observe(await box.tick());
    expect(sender.attempts).toEqual([]);

    // A genuinely new row created after the cursor still alerts.
    vi.setSystemTime(new Date(AT + 2000));
    await box.run({ action: "add", title: "OVH has a second plan" });
    await push.observe(await box.tick());
    expect(sender.sent.map(item => item.value.title)).toEqual(["OVH has a second plan"]);
  });

  it("rechecks the newest snapshot right before a later provider call", async () => {
    const sender = fakeSender();
    sender.devices.push(DEVICE_A);
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    let started!: () => void;
    const firstStarted = new Promise<void>(resolve => { started = resolve; });
    sender.notifyOwnerInbox = vi.fn(async (value: OwnerInboxPushValue) => {
      sender.attempts.push(`${value.id}:${DEVICE_A}`);
      if (value.id === first.id) { started(); await gate; }
      return true;
    });
    const box = sweep(sender);
    await box.observe([]);
    advance(1000);
    const first = row({ id: "1e1e1e1e-1e1e-4e1e-8e1e-1e1e1e1e1e1e" });
    const second = row({ id: "1f1f1f1f-1f1f-4f1f-8f1f-1f1f1f1f1f1f", createdAt: iso(now + 1000), updatedAt: iso(now + 1000) });
    const running = box.observe([first, second]);
    await firstStarted;
    // A newer reconciliation closes the second row while the first send waits.
    void box.observe([first, { ...second, state: "resolved", resolvedAt: iso(now) }]);
    release();
    await running;
    expect(sender.attempts).toEqual([`${first.id}:${DEVICE_A}`]);
  });

  it("rechecks the candidate deadline right before a later provider call", async () => {
    const sender = fakeSender();
    sender.devices.push(DEVICE_A);
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    let started!: () => void;
    const firstStarted = new Promise<void>(resolve => { started = resolve; });
    sender.notifyOwnerInbox = vi.fn(async (value: OwnerInboxPushValue) => {
      sender.attempts.push(`${value.id}:${DEVICE_A}`);
      if (value.id === first.id) { started(); await gate; }
      return true;
    });
    const box = sweep(sender);
    await box.observe([]);
    advance(1000);
    const first = row({ id: "2a2a2a2a-2a2a-4a2a-8a2a-2a2a2a2a2a2a" });
    const second = row({ id: "2b2b2b2b-2b2b-4b2b-8b2b-2b2b2b2b2b2b" });
    const running = box.observe([first, second]);
    await firstStarted;
    // The second row is still open in the newest snapshot, but its deadline passes.
    void box.observe([first, second]);
    advance(DAY);
    release();
    await running;
    expect(sender.attempts).toEqual([`${first.id}:${DEVICE_A}`]);
  });

  it("fails closed on a corrupt ledger and explains how to recover", async () => {
    await writeFile(file, "{not json");
    const sender = fakeSender();
    sender.devices.push(DEVICE_A);
    const log = vi.fn();
    const box = sweep(sender, { log });
    await box.observe([row()]);
    await box.observe([row()]);
    expect(sender.attempts).toEqual([]);
    expect(log).toHaveBeenCalledTimes(1);
    expect(log.mock.calls[0][0]).toContain(file);
    expect(log.mock.calls[0][0]).toContain("corrupt");
    expect(await readFile(file, "utf8")).toBe("{not json");
  });

  it("coalesces overlapping observations into one sweep and sends each acceptance once", async () => {
    const sender = fakeSender();
    sender.devices.push(DEVICE_A);
    const box = sweep(sender);
    await box.observe([]);
    advance(1000);
    const first = row({ id: "1b1b1b1b-1b1b-4b1b-8b1b-1b1b1b1b1b1b" });
    await Promise.all([box.observe([first]), box.observe([first]), box.observe([first])]);
    expect(sender.attempts).toEqual([`${first.id}:${DEVICE_A}`]);
  });
});
