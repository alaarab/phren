import { afterEach, describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import { appendFile, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { claudeChildAgents, visibleClaudeEvent } from "./transcript-claude.js";
import type { Json } from "./protocol.js";

describe("Claude child completion", () => {
  const roots: string[] = [];
  const session = "cccccccc-3333-4333-8333-333333333333";
  afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });

  async function fixture(tool = "Agent") {
    const root = await mkdtemp(path.join(tmpdir(), "phren-child-status-")); roots.push(root);
    const directory = path.join(root, session, "subagents"); await mkdir(directory, { recursive: true });
    const file = path.join(root, `${session}.jsonl`), rows: Json[] = [];
    for (const agentId of ["worker", "sibling"]) {
      rows.push({ type: "assistant", message: { role: "assistant", content: [{ type: "tool_use", id: `launch-${agentId}`, name: tool,
        input: { description: agentId, prompt: "Review the parser", run_in_background: true } }] } },
      { type: "user", toolUseResult: { status: "async_launched", isAsync: true, agentId, description: agentId },
        message: { role: "user", content: [{ type: "tool_result", tool_use_id: `launch-${agentId}`, content: "launched" }] } });
      await writeFile(path.join(directory, `agent-${agentId}.jsonl`), JSON.stringify({ type: "user", isSidechain: true, sessionId: session, agentId,
        message: { role: "user", content: "Review the parser" } }) + "\n");
    }
    await writeFile(file, rows.map(row => JSON.stringify(row)).join("\n") + "\n");
    return { directory, append: (...events: Json[]) => appendFile(file, events.map(row => JSON.stringify(row)).join("\n") + "\n"),
      read: () => claudeChildAgents(file, session) };
  }

  const stop = (task = "worker") => ({ type: "assistant", message: { role: "assistant", content: [
    { type: "tool_use", id: "stop-1", name: "TaskStop", input: { task_id: task } },
  ] } });
  const stopped = (result: Json = {}, block: Json = {}) => ({ type: "user",
    toolUseResult: { message: "Successfully stopped task: worker (Review the parser)", task_id: "worker", task_type: "local_agent", ...result },
    message: { role: "user", content: [{ type: "tool_result", tool_use_id: "stop-1", content: "stopped", ...block }] } });
  const notice = (status: string, task = "worker") => `<task-notification><task-id>${task}</task-id><status>${status}</status></task-notification>`;

  async function states(f: Awaited<ReturnType<typeof fixture>>) {
    return (await f.read()).map(({ session: id, state }) => ({ id, state }));
  }
  const running = [{ id: "worker", state: "running" }, { id: "sibling", state: "running" }];
  const finished = [{ id: "worker", state: "completed" }, { id: "sibling", state: "running" }];

  it.each(["Task", "Agent"])("finishes a background %s only after TaskStop succeeds, without a notification", async tool => {
    const f = await fixture(tool);
    expect(await states(f)).toEqual(running);
    await f.append(stop());
    expect(await states(f)).toEqual(running);
    await f.append(stopped());
    expect(await states(f)).toEqual(finished);
    // The unchanged parent uses the relation cache and must stay finished.
    expect(await states(f)).toEqual(finished);
  });

  it.each([
    { label: "an error result", row: stopped({}, { is_error: true }) },
    { label: "a different task's result", row: stopped({ task_id: "sibling" }) },
    { label: "an unknown task", row: stopped({ task_id: "unknown" }) },
    { label: "no task id", row: stopped({ task_id: undefined }) },
    { label: "no success message", row: stopped({ message: undefined }) },
    { label: "a failed stop", row: stopped({ message: "Task could not be stopped" }) },
    { label: "an unrelated tool result", row: stopped({}, { tool_use_id: "other-call" }) },
  ])("keeps children running after $label", async ({ row }) => {
    const f = await fixture();
    await f.append(stop(), row);
    expect(await states(f)).toEqual(running);
  });

  it("does not treat a result without its TaskStop call as evidence of completion", async () => {
    const f = await fixture();
    await f.append(stopped());
    expect(await states(f)).toEqual(running);
  });

  const envelopes: { label: string; row: (content: string) => Json }[] = [
    { label: "queue rows", row: content => ({ type: "queue-operation", operation: "enqueue", content }) },
    { label: "user strings", row: content => ({ type: "user", isMeta: true, message: { role: "user", content } }) },
    { label: "text blocks", row: content => ({ type: "user", isMeta: true, message: { role: "user", content: [{ type: "text", text: content }] } }) },
    { label: "queued commands", row: prompt => ({ type: "attachment", attachment: { type: "queued_command", commandMode: "task-notification", prompt } }) },
  ];
  for (const status of ["completed", "failed", "cancelled", "canceled", "killed", "stopped"]) {
    it.each(envelopes)(`finishes a ${status} child notified through $label`, async ({ row }) => {
      const f = await fixture();
      expect(await states(f)).toEqual(running);
      await f.append(row(notice(status)));
      expect(await states(f)).toEqual(finished);
    });
  }

  it.each(["running", "pending", "unknown", "", "not_found"])("keeps a child running for notification status '%s'", async status => {
    const f = await fixture();
    await f.append(envelopes[0].row(notice(status)));
    expect(await states(f)).toEqual(running);
  });

  it("handles multiple envelopes without borrowing another task's terminal status", async () => {
    const f = await fixture();
    await f.append(envelopes[0].row("<task-notification><task-id>worker</task-id></task-notification>" + notice("killed", "sibling")));
    expect(await states(f)).toEqual([{ id: "worker", state: "running" }, { id: "sibling", state: "completed" }]);
  });

  it("ignores unknown task ids, quoted notices, unrelated attachments and interrupted child text", async () => {
    const f = await fixture();
    await f.append(envelopes[0].row(notice("killed", "unknown")),
      { type: "assistant", message: { role: "assistant", content: [{ type: "text", text: notice("killed") }] } },
      { type: "user", message: { role: "user", content: [{ type: "tool_result", tool_use_id: "read-example", content: notice("killed") }] } },
      { type: "attachment", attachment: { type: "queued_command", commandMode: "prompt", prompt: notice("killed") } });
    await appendFile(path.join(f.directory, "agent-worker.jsonl"), JSON.stringify({ type: "user", isSidechain: true, sessionId: session, agentId: "worker",
      message: { role: "user", content: "[Request interrupted by user]" } }) + "\n");
    expect(await states(f)).toEqual(running);
  });

  it("does not invent a finished child when its transcript is missing", async () => {
    const f = await fixture();
    await rm(path.join(f.directory, "agent-worker.jsonl"));
    expect(await states(f)).toEqual([{ id: "sibling", state: "running" }]);
    await writeFile(path.join(f.directory, "agent-worker.jsonl"), JSON.stringify({ type: "fork-context-ref", parentSessionId: session, agentId: "worker" }) + "\n");
    await f.append(envelopes[0].row(notice("unknown")));
    expect(await states(f)).toEqual(running);
  });
});

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
