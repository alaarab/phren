import { expect, it } from "vitest";
// @ts-expect-error plain ESM without declarations
import { createSnoozes, snoozable, snoozeChoices, snoozeVersion } from "../ui/shell/snooze.js";

const waiting = (id: string, extra: object = {}) => ({
  key: `Desk/${id}`,
  computer: "Desk",
  child: { id, agentStatus: "waiting", lastChangedAt: "2026-10-10T12:00:00Z", lastReply: "Open a PR?", target: { pane: "1" }, ...extra },
});

function setup(seed?: string) {
  let at = Date.parse("2026-10-16T10:00:00Z");
  const data = new Map<string, string>(seed ? [["phren.desktop.snoozed", seed]] : []);
  const storage = { getItem: (k: string) => data.get(k) ?? null, setItem: (k: string, v: string) => { data.set(k, v); } };
  const timers: { fn: () => void; ms: number }[] = [];
  const state = createSnoozes({
    storage,
    now: () => at,
    setTimer: (fn: () => void, ms: number) => { timers.push({ fn, ms }); return timers.length; },
    clearTimer: (id: number) => { if (timers[id - 1]) timers[id - 1] = { fn: () => {}, ms: -1 }; },
  });
  return { state, data, timers, advance: (ms: number) => { at += ms; }, now: () => at };
}

it("hides a snoozed row until its time passes, then shows it again", () => {
  const { state, advance, now } = setup();
  const row = waiting("a");
  expect(state.visible([row])).toHaveLength(1);
  expect(state.snooze(row, now() + 15 * 60_000)).toBe(true);
  expect(state.visible([row])).toHaveLength(0);
  expect(state.snoozed([row]).map((r: { until: number }) => r.until)).toEqual([now() + 15 * 60_000]);
  advance(15 * 60_000);
  expect(state.visible([row])).toHaveLength(1);
  expect(state.snoozed([row])).toHaveLength(0);
});

it("a new message or a changed state resurfaces the row at once", () => {
  const { state, now } = setup();
  state.snooze(waiting("a"), now() + 3_600_000);
  expect(state.visible([waiting("a")])).toHaveLength(0);
  expect(state.visible([waiting("a", { lastReply: "Also, tests failed" })])).toHaveLength(1);
  expect(state.visible([waiting("a", { lastChangedAt: "2026-10-10T12:05:00Z" })])).toHaveLength(1);
  // Reconciling drops the stale entry, so the old version does not hide it again later.
  state.reconcile([waiting("a", { lastReply: "Also, tests failed" })]);
  expect(state.size).toBe(0);
  expect(state.visible([waiting("a")])).toHaveLength(1);
});

it("never snoozes an approval, a blocked agent or anything that is not a plain wait", () => {
  const { state, now, data } = setup();
  const approval = waiting("b", { approvalPending: true });
  const blocked = waiting("c", { agentStatus: "blocked" });
  const working = waiting("d", { agentStatus: "working" });
  for (const row of [approval, blocked, working]) {
    expect(snoozable(row.child)).toBe(false);
    expect(state.snooze(row, now() + 60_000)).toBe(false);
  }
  expect(state.size).toBe(0);
  expect(data.has("phren.desktop.snoozed")).toBe(false);
  expect(state.visible([approval, blocked])).toHaveLength(2);
  // A stored entry for a chat that became an approval no longer hides it.
  state.snooze(waiting("e"), now() + 60_000);
  const asked = waiting("e", { approvalPending: true });
  expect(state.visible([asked])).toHaveLength(1);
  state.reconcile([asked]);
  expect(state.size).toBe(0);
});

it("excludes snoozed rows from the count and restores them on wake", () => {
  const { state, now } = setup();
  const rows = [waiting("a"), waiting("b"), waiting("c", { approvalPending: true })];
  expect(state.visible(rows)).toHaveLength(3);
  state.snooze(rows[0], now() + 60_000);
  expect(state.visible(rows).map((r: { key: string }) => r.key)).toEqual(["Desk/b", "Desk/c"]);
  state.wake("Desk/a");
  expect(state.visible(rows)).toHaveLength(3);
});

it("keeps entries across a reload and prunes the expired ones", () => {
  const first = setup();
  first.state.snooze(waiting("a"), first.now() + 60_000);
  first.state.snooze(waiting("b"), first.now() + 120_000);
  const saved = first.data.get("phren.desktop.snoozed")!;
  const reload = setup(saved);
  expect(reload.state.size).toBe(2);
  reload.advance(90_000);
  reload.state.sweep();
  expect(reload.state.size).toBe(1);
  expect(JSON.parse(reload.data.get("phren.desktop.snoozed")!).map((e: { key: string }) => e.key)).toEqual(["Desk/b"]);
  // Corrupt storage starts empty instead of throwing.
  expect(setup("{nope").state.size).toBe(0);
  expect(setup(JSON.stringify([{ key: 1 }, null, { key: "x", version: "v", until: "soon" }])).state.size).toBe(0);
});

it("caps the entries, keeping the ones that wake latest", () => {
  const { state, now } = setup();
  for (let i = 0; i < 60; i++) state.snooze(waiting(`s${i}`), now() + 60_000 + i * 1000);
  expect(state.size).toBe(50);
  expect(state.isSnoozed(waiting("s0"))).toBe(false);
  expect(state.isSnoozed(waiting("s59"))).toBe(true);
});

it("arms one timer for the next wake, re-armed after every change, and wakes on sweep", () => {
  const { state, timers, advance, now } = setup();
  const live = () => timers.filter((t) => t.ms >= 0);
  let woken = 0;
  state.subscribe(() => { woken++; });
  state.snooze(waiting("a"), now() + 3_600_000);
  state.snooze(waiting("b"), now() + 900_000);
  expect(timers.filter((t) => t.ms >= 0)).toHaveLength(1); // earlier ones were cleared
  expect(live()[0].ms).toBe(900_000 + 5);
  woken = 0;
  advance(900_000 + 5);
  live()[0].fn();
  expect(woken).toBe(1);
  expect(state.isSnoozed(waiting("b"))).toBe(false);
  expect(state.isSnoozed(waiting("a"))).toBe(true);
  expect(live().at(-1)!.ms).toBe(3_600_000 - 900_000 - 5 + 5);
  // After a sleep the timer is late; a re-check on focus still wakes the row.
  advance(2 * 3_600_000);
  state.sweep();
  expect(state.isSnoozed(waiting("a"))).toBe(false);
  expect(woken).toBe(2);
  expect(state.size).toBe(0);
});

it("offers 15 minutes, 1 hour and tomorrow 9:00 local", () => {
  const now = new Date(2026, 9, 16, 14, 30).getTime();
  const [a, b, c] = snoozeChoices(now);
  expect([a.label, b.label, c.label]).toEqual(["15 minutes", "1 hour", "Until tomorrow 9:00"]);
  expect(a.until - now).toBe(900_000);
  expect(b.until - now).toBe(3_600_000);
  expect(new Date(c.until)).toEqual(new Date(2026, 9, 17, 9, 0));
  // Past midnight it is still the next calendar day.
  expect(new Date(snoozeChoices(new Date(2026, 9, 17, 0, 30).getTime())[2].until)).toEqual(new Date(2026, 9, 18, 9, 0));
});

it("versions a row by status, last change and last reply", () => {
  expect(snoozeVersion(waiting("a").child)).not.toBe(snoozeVersion(waiting("a", { lastReply: "x" }).child));
  expect(snoozeVersion(waiting("a").child)).toBe(snoozeVersion(waiting("a").child));
});
