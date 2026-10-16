import { afterEach, beforeEach, expect, it, vi } from "vitest";

const hooks = vi.hoisted(() => ({ merged: null as null | { rows: object[] }, listeners: new Set<(m: unknown) => void>() }));
vi.mock("../ui/redact.js", () => ({ redactNotice: (s: string) => s }));
vi.mock("../ui/api.js", () => ({ hookPost: vi.fn() }));
vi.mock("../ui/shell/approvals.js", () => ({ approvals: { approval: () => undefined, subscribe: () => () => {} } }));
vi.mock("../ui/shell/store.js", async () => {
  // @ts-expect-error plain ESM without declarations
  const { snoozes } = await import("../ui/shell/snooze.js");
  const rows = () => (hooks.merged?.rows ?? []) as { key: string; computer: string; child: Record<string, unknown> }[];
  snoozes.subscribe(() => { for (const fn of hooks.listeners) fn(hooks.merged); });
  return {
    projectOf: () => "phren",
    sessions: () => rows(),
    store: {
      get merged() { return hooks.merged; },
      needsYou: () => snoozes.visible(rows()),
      sessions: () => rows(),
      subscribe: (fn: (m: unknown) => void) => { hooks.listeners.add(fn); if (hooks.merged) fn(hooks.merged); return () => hooks.listeners.delete(fn); },
    },
  };
});
// @ts-expect-error plain ESM without declarations
import { snoozes } from "../ui/shell/snooze.js";
// @ts-expect-error plain ESM without declarations
import { startNeedsNotify } from "../ui/shell/needs-notify.js";

const chat = (reply: string) => ({ key: "Desk/a", computer: "Desk", child: { id: "a", title: "Fix login", label: "claude", agentStatus: "waiting", lastReply: reply, target: { pane: "1" } } });
const publish = (...rows: object[]) => { hooks.merged = { rows }; for (const fn of hooks.listeners) fn(hooks.merged); };

beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(new Date("2026-10-16T10:00:00Z")); hooks.merged = null; });
afterEach(() => { vi.useRealTimers(); snoozes.wake("Desk/a"); hooks.listeners.clear(); });

it("snoozing never notifies, and the end of a snooze reminds once with 'Still waiting'", () => {
  const notify = vi.fn();
  startNeedsNotify({ notify }, { enabled: () => true, openSession: () => {} });
  publish(); // silent baseline
  publish(chat("Open a PR?"));
  expect(notify).toHaveBeenCalledTimes(1);
  expect(notify.mock.calls[0][0]).toBe("phren needs you");

  notify.mockClear();
  expect(snoozes.snooze(chat("Open a PR?"), Date.now() + 15 * 60_000)).toBe(true);
  expect(notify).not.toHaveBeenCalled();
  publish(chat("Open a PR?")); // a frame while snoozed
  expect(notify).not.toHaveBeenCalled();

  vi.advanceTimersByTime(15 * 60_000 + 10);
  expect(notify).toHaveBeenCalledTimes(1);
  expect(notify.mock.calls[0][0]).toBe("Still waiting: Fix login");
  expect(notify.mock.calls[0][1]).toContain("Open a PR?");
  publish(chat("Open a PR?")); // later frames do not repeat it
  vi.advanceTimersByTime(60 * 60_000);
  expect(notify).toHaveBeenCalledTimes(1);
});

it("a new message on a snoozed chat is an ordinary notice, and Wake now is silent", () => {
  const notify = vi.fn();
  startNeedsNotify({ notify }, { enabled: () => true, openSession: () => {} });
  publish();
  publish(chat("Open a PR?"));
  notify.mockClear();
  snoozes.snooze(chat("Open a PR?"), Date.now() + 3_600_000);
  hooks.merged = { rows: [chat("CI failed. Retry?")] };
  snoozes.reconcile((hooks.merged as { rows: never[] }).rows);
  for (const fn of hooks.listeners) fn(hooks.merged);
  expect(notify).toHaveBeenCalledTimes(1);
  expect(notify.mock.calls[0][0]).toBe("phren needs you");

  notify.mockClear();
  snoozes.snooze(chat("CI failed. Retry?"), Date.now() + 3_600_000);
  snoozes.wake("Desk/a");
  expect(notify).not.toHaveBeenCalled(); // the owner woke it and is looking at it
});
