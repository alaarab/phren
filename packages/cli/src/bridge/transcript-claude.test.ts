import { describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import { visibleClaudeEvent } from "./transcript-claude.js";

describe("phren prompt-hook context", () => {
  const hook = (content: string, event = "UserPromptSubmit") => ({ type: "attachment", uuid: "u2", parentUuid: "u1", timestamp: "2026-09-23T12:00:00Z",
    attachment: { type: "hook_success", hookName: event, hookEvent: event, toolUseID: "t", content } });
  it("exports phren's injection with its results and trace", () => {
    const content = "◆ phren · phren · 2 results\n<phren-context>\n[phren/FINDINGS.md] (findings)\n- a finding\n</phren-context>\n◆ phren · trace: intent=debug";
    expect(visibleClaudeEvent(hook(content))).toEqual({ type: "phren_hook_context", timestamp: "2026-09-23T12:00:00Z", uuid: "u2", parentUuid: "u1", content });
  });
  it("keeps other hooks' output and other hook events private", () => {
    expect(visibleClaudeEvent(hook("my own hook: secret context"))).toBeUndefined();
    expect(visibleClaudeEvent(hook("◆ phren · 1 result", "SessionStart"))).toBeUndefined();
    expect(visibleClaudeEvent({ type: "attachment", attachment: { type: "prompt_snapshot", content: "◆ phren" } })).toBeUndefined();
  });
  it("marks mid-turn input as a notification or a typed prompt, without its text", () => {
    const queued = (commandMode: string) => ({ type: "attachment", timestamp: "t", attachment: { type: "queued_command", prompt: "private words", commandMode } });
    expect(visibleClaudeEvent(queued("prompt"))).toEqual({ type: "phren_turn_input", timestamp: "t", notification: false });
    expect(visibleClaudeEvent(queued("task-notification"))).toEqual({ type: "phren_turn_input", timestamp: "t", notification: true });
  });
  it("names a picture sent mid-turn so its receipt can match, keeping its queue key", () => {
    // Claude Code 2026-09-27: a phone picture sent while the conductor worked.
    const content = "[Image #7]Attached files on this computer:";
    const key = createHash("sha256").update(content).digest("hex");
    const queued = (operation: string, text = content) => ({ type: "queue-operation", operation, timestamp: "t", sessionId: "s", content: text });
    expect(visibleClaudeEvent(queued("enqueue"))).toEqual({ type: "user", phrenQueued: true, phrenQueueKey: key, timestamp: "t",
      message: { role: "user", content: "[Image attachment]" } });
    expect(visibleClaudeEvent(queued("remove"))).toEqual({ type: "phren_queue_consumed", key, timestamp: "t" });
    // Words, or a file that is not a picture, still cross as written.
    const worded = "[Image #6]I had to approve these..\nAttached files on this computer:";
    expect(visibleClaudeEvent(queued("enqueue", worded))).toMatchObject({ message: { content: worded } });
    const file = "[Image #2]Attached files on this computer:\n/Users/me/report.pdf";
    expect(visibleClaudeEvent(queued("enqueue", file))).toMatchObject({ message: { content: file } });
  });
  it("bounds a very large injection", () => {
    const row = visibleClaudeEvent(hook("◆ phren · big\n" + "x".repeat(40_000)));
    expect(String(row?.content).length).toBeLessThan(16_500);
  });
});

describe("skill bodies", () => {
  const meta = (text: string, extra: Record<string, unknown> = {}) => ({ type: "user", isMeta: true, uuid: "m1", timestamp: "t",
    sourceToolUseID: "toolu_1", message: { role: "user", content: [{ type: "text", text }] }, ...extra });
  it("sends the text a Skill call loaded as that call's second result", () => {
    const body = "Base directory for this skill: /Users/me/.claude/skills/release\n\n# Release a concrete change";
    expect(visibleClaudeEvent(meta(body))).toEqual({ type: "user", timestamp: "t", uuid: "m1",
      message: { role: "user", content: [{ type: "tool_result", tool_use_id: "toolu_1", content: body, phrenSkillBody: true }] } });
  });
  it("keeps every other hidden row private", () => {
    expect(visibleClaudeEvent(meta("<local-command-caveat>Caveat</local-command-caveat>"))).toBeUndefined();
    expect(visibleClaudeEvent(meta("Base directory for this skill: x", { sourceToolUseID: undefined }))).toBeUndefined();
    expect(visibleClaudeEvent(meta("Base directory for this skill: x", { isSidechain: true }))).toBeUndefined();
    expect(visibleClaudeEvent(meta("Base directory for this skill: x", { isMeta: false }))).not.toMatchObject({ message: { content: [{ phrenSkillBody: true }] } });
  });
});
