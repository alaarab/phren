import { afterEach, expect, it } from "vitest";
// @ts-expect-error plain ESM
import { savedToday, dayBounds, utcDatesOfDay } from "../ui/shell/saved-today.js";
// @ts-expect-error plain ESM
import { savedAgo } from "../ui/time.js";

const ORIGINAL_TZ = process.env.TZ;
afterEach(() => { if (ORIGINAL_TZ === undefined) delete process.env.TZ; else process.env.TZ = ORIGINAL_TZ; });

const entry = (key: string, created: string, extra: object = {}) => ({ kind: key.startsWith("f") ? "finding" : "task", key, created, ...extra });
const keys = (list: { key: string }[]) => list.map((e) => e.key);

it("keeps what was saved since local midnight, newest first, with date-only findings after the timed ones", () => {
  process.env.TZ = "UTC";
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
  expect(keys(out)).toEqual(["t-new", "t-old", "t-midnight", "f-a", "f-b"]);
  expect(out[3].at).toBeNull();
});

it("US Pacific evening: the local day spans two UTC dates and a finding dated either counts", () => {
  process.env.TZ = "America/Los_Angeles";
  const now = Date.parse("2026-10-17T02:00:00Z"); // 19:00 PDT on Oct 16
  expect([...utcDatesOfDay(now)].sort()).toEqual(["2026-10-16", "2026-10-17"]);
  const out = savedToday([entry("f-utc-next", "2026-10-17"), entry("f-utc-same", "2026-10-16"), entry("f-before", "2026-10-15"), entry("f-after", "2026-10-18")], now);
  expect(keys(out)).toEqual(["f-utc-next", "f-utc-same"]);
});

it("Auckland morning: the local day spans the previous UTC date and today's", () => {
  process.env.TZ = "Pacific/Auckland";
  const now = Date.parse("2026-10-15T19:00:00Z"); // 08:00 NZDT on Oct 16
  expect([...utcDatesOfDay(now)].sort()).toEqual(["2026-10-15", "2026-10-16"]);
  const [start] = dayBounds(now);
  expect(new Date(start).toISOString()).toBe("2026-10-15T11:00:00.000Z");
  const out = savedToday([
    entry("t-in", "2026-10-15T11:00:00Z"), entry("t-before", "2026-10-15T10:59:00Z"),
    entry("f-prev", "2026-10-15"), entry("f-next", "2026-10-17"),
  ], now);
  expect(keys(out)).toEqual(["t-in", "f-prev"]);
});

it("a 23 hour (spring forward) and a 25 hour (fall back) day keep exact bounds and their UTC dates", () => {
  process.env.TZ = "America/Los_Angeles";
  const spring = Date.parse("2026-03-08T20:00:00Z");
  const [s1, e1] = dayBounds(spring);
  expect((e1 - s1) / 3_600_000).toBe(23);
  expect([...utcDatesOfDay(spring)].sort()).toEqual(["2026-03-08", "2026-03-09"]);
  const fall = Date.parse("2026-11-01T20:00:00Z");
  const [s2, e2] = dayBounds(fall);
  expect((e2 - s2) / 3_600_000).toBe(25);
  expect([...utcDatesOfDay(fall)].sort()).toEqual(["2026-11-01", "2026-11-02"]);
  // A task one minute before the 25 hour day's end is in; at the end it is out.
  expect(keys(savedToday([entry("t-in", new Date(e2 - 60_000).toISOString()), entry("t-out", new Date(e2).toISOString())], fall))).toEqual(["t-in"]);
});

it("collapses the same item seen from several computers to the preferred one", () => {
  process.env.TZ = "UTC";
  const now = Date.parse("2026-10-16T12:00:00Z");
  const out = savedToday([
    entry("f-remote", "2026-10-16", { dedupe: "s1|fid:1", rank: 1 }),
    entry("f-local", "2026-10-16", { dedupe: "s1|fid:1", rank: 0 }),
    entry("f-other", "2026-10-16", { dedupe: "s1|fid:2", rank: 1 }),
  ], now);
  expect(keys(out)).toEqual(["f-local", "f-other"]);
});

it("labels the age", () => {
  const now = Date.parse("2026-10-16T12:00:00Z");
  expect(savedAgo(now - 20_000, now)).toBe("20s ago");
  expect(savedAgo(now - 12 * 60_000, now)).toBe("12m ago");
  expect(savedAgo(now - 3 * 3_600_000 - 5 * 60_000, now)).toBe("3h ago");
  expect(savedAgo(null, now)).toBe("today");
  expect(savedAgo(now + 60_000, now)).toBe("now");
});
