import { describe, expect, it } from "vitest";
// @ts-expect-error plain browser ESM
import { handoffNotices, movePlan, sameChatTarget } from "../ui/shell/handoff.js";

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
