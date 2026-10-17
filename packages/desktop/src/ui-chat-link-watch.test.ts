import { afterEach, beforeEach, expect, it, vi } from "vitest";
// @ts-expect-error Plain browser ESM.
import { createLinkWatch } from "../ui/chat/link-watch.js";

type View = { phase: string; seconds: number };
let views: View[];
let watch: ReturnType<typeof createLinkWatch>;
const last = () => views.at(-1);

beforeEach(() => {
  vi.useFakeTimers();
  views = [];
  watch = createLinkWatch({ onView: (v: View) => views.push(v) });
  watch.up("transcript");
  watch.up("status");
});
afterEach(() => { watch.destroy(); vi.useRealTimers(); });

it("stays silent for a blip under 3 seconds", () => {
  watch.down("transcript");
  vi.advanceTimersByTime(2900);
  watch.up("transcript");
  vi.advanceTimersByTime(60_000);
  expect(views).toEqual([]);
  expect(vi.getTimerCount()).toBe(0);
});

it("never shows for a socket that has not connected yet", () => {
  const fresh = createLinkWatch({ onView: (v: View) => views.push(v) });
  fresh.down("transcript");
  vi.advanceTimersByTime(60_000);
  expect(views).toEqual([]);
  fresh.destroy();
});

it("shows reconnecting with a count from 3 seconds, ticking each second", () => {
  watch.down("status");
  vi.advanceTimersByTime(3000);
  expect(last()).toEqual({ phase: "reconnecting", seconds: 3 });
  vi.advanceTimersByTime(9000);
  expect(last()).toEqual({ phase: "reconnecting", seconds: 12 });
});

it("counts from the first socket that went down and stays up until both are back", () => {
  watch.down("transcript");
  vi.advanceTimersByTime(2000);
  watch.down("status");
  vi.advanceTimersByTime(1000);
  expect(last()).toEqual({ phase: "reconnecting", seconds: 3 });
  watch.up("transcript");
  expect(last()?.phase).toBe("reconnecting");
  watch.up("status");
  expect(last()?.phase).toBe("back");
});

it("says it cannot reach the computer after 30 seconds and stops ticking", () => {
  watch.down("transcript");
  vi.advanceTimersByTime(29_000);
  expect(last()).toEqual({ phase: "reconnecting", seconds: 29 });
  vi.advanceTimersByTime(1000);
  expect(last()).toEqual({ phase: "unreachable", seconds: 0 });
  const count = views.length;
  vi.advanceTimersByTime(10_000);
  expect(views).toHaveLength(count);
});

it("shows Back online for 1.5 seconds on reopen, then clears with no timers left", () => {
  watch.down("transcript");
  vi.advanceTimersByTime(5000);
  watch.up("transcript");
  expect(last()?.phase).toBe("back");
  vi.advanceTimersByTime(1499);
  expect(last()?.phase).toBe("back");
  vi.advanceTimersByTime(1);
  expect(last()?.phase).toBe("idle");
  expect(vi.getTimerCount()).toBe(0);
});

it("starts over when the link drops again during Back online", () => {
  watch.down("transcript");
  vi.advanceTimersByTime(4000);
  watch.up("transcript");
  watch.down("transcript");
  expect(last()?.phase).toBe("idle");
  vi.advanceTimersByTime(3000);
  expect(last()).toEqual({ phase: "reconnecting", seconds: 3 });
});

it("leaves no timers and reports nothing after the chat closes", () => {
  watch.down("transcript");
  vi.advanceTimersByTime(5000);
  const count = views.length;
  watch.destroy();
  expect(vi.getTimerCount()).toBe(0);
  watch.up("transcript");
  watch.down("status");
  vi.advanceTimersByTime(60_000);
  expect(views).toHaveLength(count);
  expect(vi.getTimerCount()).toBe(0);
});
