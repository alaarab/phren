import { describe, expect, it } from "vitest";
import * as vscode from "vscode";
import {
  asArray,
  asBoolean,
  asNumber,
  asRecord,
  asSessionStatus,
  asString,
  asStringArray,
  asTaskSection,
  categoryIconId,
  formatDateLabel,
  formatRelativeTime,
  formatSessionTimeLabel,
  responseData,
  taskIconId,
  themeIcon,
  truncate,
} from "../src/providers/tree-utils";
import type { TaskNode } from "../src/providers/tree-types";

describe("tree-utils: type coercion helpers", () => {
  it("asRecord accepts plain objects and rejects primitives, arrays-are-objects, and null", () => {
    expect(asRecord({ a: 1 })).toEqual({ a: 1 });
    expect(asRecord(null)).toBeUndefined();
    expect(asRecord(undefined)).toBeUndefined();
    expect(asRecord("string")).toBeUndefined();
    expect(asRecord(42)).toBeUndefined();
    // Arrays are `typeof "object"` — asRecord intentionally doesn't special-case them.
    expect(asRecord([1, 2])).toEqual([1, 2]);
  });

  it("asArray normalizes non-arrays to an empty array", () => {
    expect(asArray([1, 2, 3])).toEqual([1, 2, 3]);
    expect(asArray("not an array")).toEqual([]);
    expect(asArray(undefined)).toEqual([]);
    expect(asArray(null)).toEqual([]);
    expect(asArray({})).toEqual([]);
  });

  it("asString only passes through actual strings", () => {
    expect(asString("hi")).toBe("hi");
    expect(asString("")).toBe("");
    expect(asString(5)).toBeUndefined();
    expect(asString(null)).toBeUndefined();
    expect(asString(undefined)).toBeUndefined();
  });

  it("asStringArray filters non-string entries and treats an all-non-string or empty array as undefined", () => {
    expect(asStringArray(["a", "b"])).toEqual(["a", "b"]);
    expect(asStringArray(["a", 1, null, "b"])).toEqual(["a", "b"]);
    expect(asStringArray([])).toBeUndefined();
    expect(asStringArray([1, 2])).toBeUndefined();
    expect(asStringArray("not an array")).toBeUndefined();
    expect(asStringArray(undefined)).toBeUndefined();
  });

  it("asBoolean and asNumber reject values of the wrong type instead of coercing", () => {
    expect(asBoolean(true)).toBe(true);
    expect(asBoolean(false)).toBe(false);
    expect(asBoolean("true")).toBeUndefined();
    expect(asBoolean(1)).toBeUndefined();
    expect(asNumber(42)).toBe(42);
    expect(asNumber(0)).toBe(0);
    expect(asNumber("42")).toBeUndefined();
    expect(asNumber(NaN)).toBe(NaN); // typeof NaN === "number"; callers must guard separately.
  });

  it("asTaskSection and asSessionStatus only accept their exact literal unions", () => {
    expect(asTaskSection("Active")).toBe("Active");
    expect(asTaskSection("Queue")).toBe("Queue");
    expect(asTaskSection("Done")).toBe("Done");
    expect(asTaskSection("active")).toBeUndefined();
    expect(asTaskSection("Bogus")).toBeUndefined();
    expect(asTaskSection(undefined)).toBeUndefined();

    expect(asSessionStatus("active")).toBe("active");
    expect(asSessionStatus("ended")).toBe("ended");
    expect(asSessionStatus("Active")).toBeUndefined();
    expect(asSessionStatus(undefined)).toBeUndefined();
  });

  it("responseData unwraps the MCP {data: {...}} envelope and tolerates missing/malformed input", () => {
    expect(responseData({ data: { findings: [1] } })).toEqual({ findings: [1] });
    expect(responseData({ data: null })).toBeUndefined();
    expect(responseData({})).toBeUndefined();
    expect(responseData(undefined)).toBeUndefined();
    expect(responseData("garbage")).toBeUndefined();
  });
});

describe("tree-utils: truncate", () => {
  it("collapses internal whitespace/newlines before measuring length", () => {
    expect(truncate("hello   \n\n  world", 20)).toBe("hello world");
  });

  it("returns the compacted string unchanged when within the limit", () => {
    expect(truncate("short", 10)).toBe("short");
  });

  it("truncates and appends an ellipsis, trimming trailing space before it", () => {
    // "abcdefghij" (10 chars) at maxLength 8 → slice(0,5) = "abcde" + "..."
    expect(truncate("abcdefghij", 8)).toBe("abcde...");
  });

  it("never produces a negative slice length for very small maxLength", () => {
    expect(truncate("abcdefghij", 1)).toBe("...");
    expect(truncate("abcdefghij", 0)).toBe("...");
  });
});

describe("tree-utils: categoryIconId / taskIconId", () => {
  it("maps every known category to its icon and falls back to book for unknowns", () => {
    expect(categoryIconId("findings")).toBe("list-flat");
    expect(categoryIconId("notes")).toBe("note");
    expect(categoryIconId("truths")).toBe("pin");
    expect(categoryIconId("sessions")).toBe("history");
    expect(categoryIconId("task")).toBe("checklist");
    expect(categoryIconId("queue")).toBe("inbox");
    expect(categoryIconId("hooks")).toBe("plug");
    expect(categoryIconId("reference")).toBe("book");
  });

  function task(overrides: Partial<TaskNode>): TaskNode {
    return {
      kind: "task",
      projectName: "p",
      id: "1",
      line: "do a thing",
      section: "Active",
      checked: false,
      ...overrides,
    };
  }

  it("prioritizes checked/Done over pinned or section", () => {
    expect(taskIconId(task({ checked: true, section: "Active", pinned: true }))).toBe("check");
    expect(taskIconId(task({ section: "Done", checked: false }))).toBe("check");
  });

  it("shows pinned icon only when not checked/Done", () => {
    expect(taskIconId(task({ pinned: true, section: "Queue" }))).toBe("pinned");
  });

  it("falls back to play for Active and clock for Queue otherwise", () => {
    expect(taskIconId(task({ section: "Active" }))).toBe("play");
    expect(taskIconId(task({ section: "Queue" }))).toBe("clock");
  });
});

describe("tree-utils: date/time formatting", () => {
  it('formatDateLabel special-cases the literal "unknown" date', () => {
    expect(formatDateLabel("unknown")).toBe("Unknown date");
  });

  it("formatDateLabel returns the raw string for an unparseable date", () => {
    expect(formatDateLabel("not-a-date")).toBe("not-a-date");
  });

  it("formatDateLabel buckets Today/Yesterday/N days ago relative to now", () => {
    const now = new Date();
    const iso = (d: Date) => d.toISOString().slice(0, 10);
    const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());

    expect(formatDateLabel(iso(today))).toBe("Today");

    const yesterday = new Date(today);
    yesterday.setDate(yesterday.getDate() - 1);
    expect(formatDateLabel(iso(yesterday))).toBe("Yesterday");

    const threeDaysAgo = new Date(today);
    threeDaysAgo.setDate(threeDaysAgo.getDate() - 3);
    expect(formatDateLabel(iso(threeDaysAgo))).toBe("3 days ago");
  });

  it("formatDateLabel falls back to a month/day date for anything 7+ days old", () => {
    const label = formatDateLabel("2020-01-15");
    expect(label).toContain("Jan");
    expect(label).toContain("15");
    expect(label).toContain("2020"); // different year → year is included
  });

  it("formatSessionTimeLabel renders a locale time string and passes through unparseable input", () => {
    expect(formatSessionTimeLabel("not-a-timestamp")).toBe("not-a-timestamp");
    // Just assert it doesn't throw and returns a non-empty string for valid input;
    // exact locale formatting is environment-dependent.
    expect(formatSessionTimeLabel(new Date().toISOString()).length).toBeGreaterThan(0);
  });

  it("formatRelativeTime returns unknown for an invalid ISO string", () => {
    expect(formatRelativeTime("not-a-date")).toBe("unknown");
  });

  it("formatRelativeTime treats future timestamps as just now instead of negative durations", () => {
    const future = new Date(Date.now() + 60_000).toISOString();
    expect(formatRelativeTime(future)).toBe("just now");
  });

  it("formatRelativeTime buckets minutes/hours/days/months correctly", () => {
    const minutesAgo = (n: number) => new Date(Date.now() - n * 60_000).toISOString();
    const hoursAgo = (n: number) => new Date(Date.now() - n * 3_600_000).toISOString();
    const daysAgo = (n: number) => new Date(Date.now() - n * 86_400_000).toISOString();

    expect(formatRelativeTime(minutesAgo(0))).toBe("just now");
    expect(formatRelativeTime(minutesAgo(5))).toBe("5m ago");
    expect(formatRelativeTime(hoursAgo(3))).toBe("3h ago");
    expect(formatRelativeTime(daysAgo(5))).toBe("5d ago");
    expect(formatRelativeTime(daysAgo(65))).toBe("2mo ago");
  });
});

describe("tree-utils: themeIcon", () => {
  it("returns the shared Folder/File singletons for folder/file ids", () => {
    expect(themeIcon("folder")).toBe(vscode.ThemeIcon.Folder);
    expect(themeIcon("file")).toBe(vscode.ThemeIcon.File);
  });

  it("wraps a color into a ThemeColor when provided", () => {
    const icon = themeIcon("warning", "list.warningForeground") as vscode.ThemeIcon;
    expect(icon.id).toBe("warning");
    expect((icon.color as vscode.ThemeColor).id).toBe("list.warningForeground");
  });

  it("omits color entirely when not provided", () => {
    const icon = themeIcon("lightbulb") as vscode.ThemeIcon;
    expect(icon.id).toBe("lightbulb");
    expect(icon.color).toBeUndefined();
  });
});
