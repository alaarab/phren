import { expect, it } from "vitest";
import { exhausted, leftPercent, limitingWindow, resetLabel, windowText } from "../ui/shell/usage-windows.js";

it.each([[{ exhausted: true }, true], [{ usedPercent: 100 }, true], [{ usedPercent: 100, exhausted: false }, false],
  [{ usedPercent: 99.6, leftPercent: 0 }, false], [{ leftPercent: 0 }, false], [{ limited: true }, false], [{ reset: true, exhausted: true }, false]])("shares exhaustion evidence for a window and its account: %j", (window, expected) => {
  expect(exhausted(window)).toBe(expected);
  expect(exhausted({ windows: [window] })).toBe(expected);
});

it("finds the constraining active window without changing reports or rounding room", () => {
  const windows = [{ usedPercent: 100, reset: true }, { usedPercent: 99.6, leftPercent: 0 }, { usedPercent: 99.6 }, {}];
  expect(limitingWindow({ windows })).toBe(windows[1]);
  expect(leftPercent(windows[1])).toBeCloseTo(0.4);
  expect(leftPercent({ leftPercent: 8 })).toBe(8);
  expect(limitingWindow({ windows: [{}] })).toBeNull();
  expect(leftPercent(null)).toBeNull();
});

const now = Date.parse("2026-10-11T12:00:00.000Z");
const later = (hours: number) => new Date(now + hours * 3_600_000).toISOString();
it("gives every window its reset, a 5-hour window without one 'not started', and an API credit its dollars and expiry", () => {
  expect(windowText({ id: "seven_day", name: "7-day", usedPercent: 40, resetsAt: later(50) }, now)).toMatchObject({ value: "40%", caption: `resets ${new Date(later(50)).toLocaleDateString("en-GB", { weekday: "short" })} ${new Date(later(50)).toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit", hour12: false })}` });
  expect(windowText({ id: "five_hour", name: "5-hour limit", usedPercent: 0 }, now)).toMatchObject({ value: "0%", caption: "not started" });
  expect(windowText({ id: "five_hour", name: "5-hour limit", reset: true }, now)).toMatchObject({ value: "reset", caption: "" });
  expect(windowText({ usedPercent: 100, exhausted: true }, now)).toMatchObject({ value: "100%", caption: "Exhausted · reset time unknown" });
  const credit = windowText({ id: "credit:abcd1234", name: "Promo, estimate", usedPercent: 31, usedUSD: 31, limitUSD: 100, resetsAt: "2026-12-31T12:00:00.000Z" }, now);
  expect(credit.value).toBe("$31.00 of $100.00");
  expect(credit.caption).toMatch(/^expires Dec 31$/);
  expect(windowText({ id: "codex:primary", name: "5-hour limit", usedPercent: 100, limited: true, resetsAt: later(1) }, now).caption).toBe("Limit reached · resets in 1h");
});

it("rounds partial minutes up and handles elapsed and reported reset times", () => {
  expect(resetLabel({ resetsAt: later(0.001) }, now)).toBe("resets in 1m");
  expect(resetLabel({ resetsAt: later(0) }, now)).toBe("reset time unknown");
  expect(resetLabel({ resetsIn: "2h" }, now)).toBe("resets in 2h");
});
