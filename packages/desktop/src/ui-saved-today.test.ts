import { afterEach, expect, it } from "vitest";
// @ts-expect-error plain ESM
import { savedToday, savedAgo, localDay, dayBounds } from "../ui/shell/saved-today.js";

const ORIGINAL_TZ = process.env.TZ;
afterEach(() => { if (ORIGINAL_TZ === undefined) delete process.env.TZ; else process.env.TZ = ORIGINAL_TZ; });

const entry = (key: string, created: string) => ({ kind: key.startsWith("f") ? "finding" : "task", key, created });

it("keeps what was saved since local midnight, newest first, with date-only findings after the timed ones", () => {
  const now = new Date(2026, 9, 16, 15, 0, 0).getTime();
  const iso = (h: number, m = 0) => new Date(2026, 9, 16, h, m).toISOString();
  const out = savedToday([
    entry("t-old", iso(9)),
    entry("f-a", "2026-10-16"),
    entry("t-new", iso(14, 48)),
    entry("t-yesterday", new Date(2026, 9, 15, 23, 59).toISOString()),
    entry("f-old", "2026-10-15"),
    entry("t-tomorrow", new Date(2026, 9, 17, 0, 0).toISOString()),
    entry("f-b", "2026-10-16"),
    entry("t-bad", "not a date"),
    entry("t-midnight", iso(0)),
  ], now);
  expect(out.map((e: { key: string }) => e.key)).toEqual(["t-new", "t-old", "t-midnight", "f-a", "f-b"]);
  expect(out[3].at).toBeNull();
});

it("draws the day boundary in the local time zone, not UTC", () => {
  process.env.TZ = "Pacific/Auckland"; // UTC+13 in October: local day starts 11:00 UTC the day before
  const now = Date.parse("2026-10-16T05:00:00Z"); // 18:00 on Oct 16 in Auckland
  expect(localDay(now)).toBe("2026-10-16");
  const [start, end] = dayBounds(now);
  expect(new Date(start).toISOString()).toBe("2026-10-15T11:00:00.000Z");
  expect(end - start).toBe(24 * 3_600_000);
  const out = savedToday([
    entry("t-in", "2026-10-15T11:00:00Z"),
    entry("t-before", "2026-10-15T10:59:00Z"),
    entry("f-in", "2026-10-16"),
  ], now);
  expect(out.map((e: { key: string }) => e.key)).toEqual(["t-in", "f-in"]);
});

it("labels the age", () => {
  const now = Date.parse("2026-10-16T12:00:00Z");
  expect(savedAgo(now - 20_000, now)).toBe("just now");
  expect(savedAgo(now - 12 * 60_000, now)).toBe("12 min ago");
  expect(savedAgo(now - 3 * 3_600_000 - 5 * 60_000, now)).toBe("3 h ago");
  expect(savedAgo(null, now)).toBe("today");
  expect(savedAgo(now + 60_000, now)).toBe("just now");
});
