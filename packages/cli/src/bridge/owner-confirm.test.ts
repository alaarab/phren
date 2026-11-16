import { describe, expect, it } from "vitest";
import { describeOwnerAction, MAX_OWNER_CONFIRMS, OwnerConfirmBroker } from "./owner-confirm.js";

const broker = (holdMs = 5_000) => new OwnerConfirmBroker({ computer: () => "mac", holdMs });
const nextList = (b: OwnerConfirmBroker) => new Promise<ReturnType<OwnerConfirmBroker["list"]>>(resolve => {
  const stop = b.subscribe(requests => { if (requests.length) { stop(); resolve(requests); } });
});

describe("owner confirmations", () => {
  it("goes ahead only when the phone approves, and shows the phone what it approves", async () => {
    const b = broker();
    const shown = nextList(b);
    const held = b.confirm("POST", "/v1/conductor/stop", { paneId: "p3" });
    const [view] = await shown;
    expect(view).toMatchObject({ kind: "owner-confirm", computer: "mac", title: "Stop the conductor on this computer", detail: "Pane p3", route: "POST /v1/conductor/stop" });
    expect(b.answer(view.id, true)).toBe(true);
    await expect(held).resolves.toBeUndefined();
    expect(b.list()).toEqual([]);
    expect(b.answer(view.id, true)).toBe(false);
  });

  it("refuses on deny, on timeout, when the terminal leaves, and past the waiting limit", async () => {
    const b = broker();
    const shown = nextList(b);
    const denied = b.confirm("POST", "/v1/housekeeping/scan", {});
    b.answer((await shown)[0].id, false);
    await expect(denied).rejects.toMatchObject({ status: 403, details: { code: "owner-confirm-denied" } });

    await expect(broker(20).confirm("POST", "/v1/housekeeping/scan", {})).rejects.toMatchObject({ status: 408 });

    let leave!: () => void;
    const left = b.confirm("POST", "/v1/housekeeping/scan", {}, new Promise<void>(done => { leave = done; }));
    leave();
    await expect(left).rejects.toMatchObject({ status: 403 });
    expect(b.list()).toEqual([]);

    const held = Array.from({ length: MAX_OWNER_CONFIRMS }, () => b.confirm("POST", "/v1/housekeeping/scan", {}).catch(() => undefined));
    await expect(b.confirm("POST", "/v1/housekeeping/scan", {})).rejects.toMatchObject({ status: 429 });
    for (const view of b.list()) b.answer(view.id, false);
    await Promise.all(held);
  });

  it("holds only actions it can describe; push registration stays the phone's own", async () => {
    expect(describeOwnerAction("POST", "/v1/push/register", {})).toBeUndefined();
    await expect(broker().confirm("POST", "/v1/push/register", {})).rejects.toMatchObject({ status: 403, details: { code: "owner-proof-required" } });
    expect(describeOwnerAction("POST", "/v1/housekeeping/approve", { ids: ["a", "b"] })?.title).toBe("Apply 2 housekeeping actions");
  });
});
