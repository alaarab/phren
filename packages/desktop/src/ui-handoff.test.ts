import { describe, expect, it } from "vitest";
// @ts-expect-error plain browser ESM
import { handoffNotices, handoffRow, movePlan, sameChatTarget } from "../ui/shell/handoff.js";

const target = { server: "tmux", workspace: "w", tab: "t", pane: "p", source: "claude", session: "original" };

describe("hand-off decisions and labels", () => {
  it("continues on another Claude account in place even with new-chat support", () => {
    expect(movePlan("claude", { harness: "claude", account: "personal", accountLabel: "Personal" }, true)).toEqual({ label: "Continues here on Personal" });
  });
  it.each([["codex", "Codex"], ["opencode", "OpenCode"], ["copilot", "Copilot"]])("opens a new %s chat only when advertised", (harness, name) => {
    expect(movePlan("claude", { harness }, true)).toEqual({ mode: "new-chat", label: `Opens a new ${name} chat with a hand-off` });
    for (const capability of [false, undefined]) expect(movePlan("claude", { harness }, capability)).toEqual({ label: `Replaces this chat with ${name} (update the Hook for a new chat)` });
  });
  it("labels both sides and resolves the source title by exact target", () => {
    const next = { ...target, tab: "new", pane: "new", source: "codex", session: "new" };
    expect(handoffNotices({ handedOffTo: { target: next } })).toEqual([{ text: "handed off to Codex", target: next }]);
    const rows = [{ child: { title: "Other", target: { ...target, pane: "other" } } }, { child: { title: "Fix quota warnings", target } }];
    expect(handoffNotices({ handedOffFrom: { target } }, rows)).toEqual([{ text: "handed off from Fix quota warnings", target }]);
    expect(handoffNotices({ handedOffFrom: { target, title: "Saved title" } })).toEqual([{ text: "handed off from Saved title", target }]);
    expect(sameChatTarget(target, { ...target, session: "replacement" })).toBe(false);
    expect(handoffNotices({})).toEqual([]);
  });
});

describe("overview hand-off row decoration", () => {
  const next = { ...target, tab: "new", pane: "new", source: "codex", session: "new" };
  const oldChat = { id: "old", title: "Investigate quota", target, handedOffTo: { target: next, title: "Saved destination" } };
  const newChat = { id: "new", title: "Fix quota", target: next, handedOffFrom: target };
  const rows = [{ child: oldChat }, { child: newChat }];

  it("dims the original and names the live destination with a harness link", () => {
    expect(handoffRow(oldChat, rows)).toEqual({ dimmed: true, subtitle: "Handed off to Fix quota", tags: [{ text: "→ Codex", target: next }] });
    expect(rows.map((row) => row.child.id)).toEqual(["old", "new"]);
  });

  it("names the source on the new chat without dimming it", () => {
    expect(handoffRow(newChat, rows)).toEqual({ dimmed: false, subtitle: "", tags: [{ text: "← from Investigate quota", target }] });
  });

  it("retains saved labels without linking a missing or replaced conversation", () => {
    const replacement = [{ child: { ...newChat, target: { ...next, session: "replacement" } } }];
    expect(handoffRow(oldChat, replacement)).toEqual({ dimmed: true, subtitle: "Handed off to Saved destination", tags: [{ text: "→ Codex", target: null }] });
    expect(handoffRow({ handedOffFrom: { target, title: "Original chat" } }, [])).toEqual({ dimmed: false, subtitle: "", tags: [{ text: "← from Original chat", target: null }] });
  });

  it("refreshes titles and links as overview rows change, including a chain", () => {
    const child = { ...newChat, handedOffTo: { target: { ...next, session: "third" }, harness: "opencode", title: "Next step" } };
    expect(handoffRow(child, [{ child: { ...oldChat, title: "Renamed source" } }])).toEqual({ dimmed: true, subtitle: "Handed off to Next step", tags: [{ text: "→ OpenCode", target: null }, { text: "← from Renamed source", target }] });
  });

  it("leaves ordinary and malformed rows undecorated", () => {
    for (const child of [{}, { handedOffTo: "invalid", handedOffFrom: null }]) {
      expect(handoffRow(child, rows)).toEqual({ dimmed: false, subtitle: "", tags: [] });
    }
  });
});
