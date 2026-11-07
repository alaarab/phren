import { describe, expect, it } from "vitest";
// @ts-expect-error Browser ESM.
import { ansiSpans, createAnsi, duration, matches, statusOf, terminal, webUrl } from "../ui/sections/forge/presentation.js";

describe("Forge presentation", () => {
  it.each([
    ["in_progress", undefined, "running"], ["completed", "success", "success"],
    ["completed", "timed_out", "failed"], ["manual", undefined, "waiting"],
    ["cancelled", undefined, "canceled"], ["neutral", undefined, "skipped"],
    ["claimed", undefined, "queued"], ["future-host-state", undefined, "queued"],
  ])("maps %s / %s to %s", (raw, conclusion, expected) => {
    expect(statusOf(raw, conclusion)).toBe(expected);
  });
  it("keeps unknown and approval states nonterminal", () => {
    expect(terminal("new-state")).toBe(false);
    expect(terminal("waiting")).toBe(false);
    expect(terminal("failed")).toBe(true);
  });
  it("formats elapsed time with missing, live and skewed timestamps", () => {
    const start = "2026-11-07T12:00:00Z";
    expect(duration(start, "2026-11-07T12:00:59Z")).toBe("59s");
    expect(duration(start, "2026-11-07T12:01:05Z")).toBe("1m 5s");
    expect(duration(start, null, Date.parse(start) + 3_661_000)).toBe("1h 1m");
    expect(duration(start, start)).toBe("0s");
    expect(duration(start, "2026-11-07T11:00:00Z")).toBe("0s");
    expect(duration(null, null)).toBe("—");
    expect(duration("invalid", null)).toBe("—");
  });
  it("renders ANSI as styled text, preserving markup literally and stripping terminal commands", () => {
    expect(ansiSpans('before \x1b[1;31m<img onerror=evil()>\x1b[0m after\x1b[2J')).toEqual([
      { text: "before ", cls: "" },
      { text: "<img onerror=evil()>", cls: "forge-ansi-danger forge-ansi-bold" },
      { text: " after", cls: "" },
    ]);
    expect(ansiSpans('\x1b]8;;https://evil.test\x07link\x1b]8;;\x1b\\')).toEqual([{ text: "link", cls: "" }]);
  });
  it("retains escape and colour state across chunks and consumes extended colour parameters", () => {
    const decoder = createAnsi();
    expect(decoder.append("\x1b[3")).toEqual([]);
    expect(decoder.append("2mgreen")).toEqual([{ text: "green", cls: "forge-ansi-done" }]);
    expect(decoder.append(" still green\x1b[0m plain")).toEqual([
      { text: " still green", cls: "forge-ansi-done" }, { text: " plain", cls: "" },
    ]);
    expect(ansiSpans("\x1b[38;2;31;1;0mplain")).toEqual([{ text: "plain", cls: "" }]);
  });
  it("finds across colour boundaries and refuses unsafe external links", () => {
    const text = ansiSpans("er\x1b[31mror\x1b[0m ERROR").map((s: { text: string }) => s.text).join("");
    expect(matches(text, "error")).toEqual([[0, 5], [6, 11]]);
    expect(matches(text, "")).toEqual([]);
    expect(matches("İ error [error]", "error")).toEqual([[2, 7], [9, 14]]);
    expect(matches("a.b aXb", "a.b")).toEqual([[0, 3]]);
    expect(webUrl("javascript:alert(1)")).toBeNull();
    expect(webUrl("https://token@example.com/log")).toBeNull();
    expect(webUrl("https://forge.example.dev/owner/repo")).toBe("https://forge.example.dev/owner/repo");
  });
});
