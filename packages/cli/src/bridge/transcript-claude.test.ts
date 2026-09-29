import { afterEach, describe, expect, it, vi } from "vitest";
import { createHash } from "node:crypto";
import { appendFile, mkdir, mkdtemp, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { CLAUDE_SKILL_QUIET_MS, claudeChildAgents, visibleClaudeEvent } from "./transcript-claude.js";
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

describe("Claude children the parent records without a task launch", () => {
  const roots: string[] = [];
  const session = "dddddddd-4444-4444-8444-444444444444";
  afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });
  const sidechain = (agentId: string, ...rows: Json[]) => [{ type: "user", isSidechain: true, sessionId: session, agentId, message: { role: "user", content: "Go" } }, ...rows]
    .map(row => JSON.stringify(row)).join("\n") + "\n";
  const notice = (task: string, status = "completed") => ({ type: "queue-operation", operation: "enqueue", content: `<task-notification><task-id>${task}</task-id><status>${status}</status></task-notification>` });
  const result = (toolUseResult: Json, call = "call-1") => ({ type: "user", toolUseResult, message: { role: "user", content: [{ type: "tool_result", tool_use_id: call, content: "ok" }] } });

  async function parent(...rows: Json[]) {
    const root = await mkdtemp(path.join(tmpdir(), "phren-child-kinds-")); roots.push(root);
    const directory = path.join(root, session, "subagents"); await mkdir(directory, { recursive: true });
    const file = path.join(root, `${session}.jsonl`);
    await writeFile(file, rows.map(row => JSON.stringify(row)).join("\n") + "\n");
    return { directory, file, append: (...more: Json[]) => appendFile(file, more.map(row => JSON.stringify(row)).join("\n") + "\n"),
      states: async () => (await claudeChildAgents(file, session)).map(({ session: id, path: label, state }) => ({ id, label, state })) };
  }

  it("runs an agent again once SendMessage resumes it, until its next final notification", async () => {
    const f = await parent(result({ status: "async_launched", isAsync: true, agentId: "aworker", description: "Trace the icon" }), notice("aworker"));
    await writeFile(path.join(f.directory, "agent-aworker.jsonl"), sidechain("aworker"));
    expect(await f.states()).toEqual([{ id: "aworker", label: "Trace the icon", state: "completed" }]);
    await f.append(result({ success: true, message: "Resuming agent aworker", resumedAgentId: "aworker" }, "call-2"));
    expect(await f.states()).toEqual([{ id: "aworker", label: "Trace the icon", state: "running" }]);
    await f.append(notice("aworker"));
    expect(await f.states()).toEqual([{ id: "aworker", label: "Trace the icon", state: "completed" }]);
    // A resume of an agent this session never launched adds nothing.
    await f.append(result({ success: true, message: "Resuming agent astranger", resumedAgentId: "astranger" }, "call-3"));
    expect(await f.states()).toHaveLength(1);
  });

  it("lists a background skill until its transcript ends on a finished reply", async () => {
    const f = await parent({ type: "system", subtype: "local_command",
      content: '<local-command-stdout>Running in the background as @code-review</local-command-stdout>\n<forked-skill-launch>{"agentId":"askill","skillName":"code-review","description":"/code-review"}</forked-skill-launch>' });
    const child = path.join(f.directory, "agent-askill.jsonl");
    await writeFile(child, sidechain("askill", { type: "assistant", message: { role: "assistant", stop_reason: "tool_use", content: [] } }));
    expect(await f.states()).toEqual([{ id: "askill", label: "/code-review", state: "running" }]);
    // The parent does not change; the child is looked at again on a timer.
    await appendFile(child, JSON.stringify({ type: "assistant", message: { role: "assistant", stop_reason: "end_turn", content: [{ type: "text", text: "No findings." }] } }) + "\n");
    vi.useFakeTimers({ now: Date.now() + 6_000, toFake: ["Date"] });
    try { expect(await f.states()).toEqual([{ id: "askill", label: "/code-review", state: "completed" }]); } finally { vi.useRealTimers(); }
  });

  it("takes a background skill whose transcript went quiet as finished", async () => {
    const f = await parent({ type: "system", subtype: "local_command", content: '<forked-skill-launch>{"agentId":"aquiet","skillName":"audit"}</forked-skill-launch>' });
    const child = path.join(f.directory, "agent-aquiet.jsonl");
    await writeFile(child, sidechain("aquiet"));
    expect(await f.states()).toEqual([{ id: "aquiet", label: "/audit", state: "running" }]);
    const old = new Date(Date.now() - CLAUDE_SKILL_QUIET_MS - 1_000);
    await utimes(child, old, old);
    await f.append({ type: "system", subtype: "informational", content: "later" });
    expect(await f.states()).toEqual([{ id: "aquiet", label: "/audit", state: "completed" }]);
  });

  it("lists a workflow's agents from its journal until each reports or the run ends", async () => {
    const f = await parent(result({ status: "async_launched", taskId: "wtask01", taskType: "local_workflow", workflowName: "cleanup-wave0", runId: "wf_43bbdee2-dc0" }, "call-wf"));
    const run = path.join(f.directory, "workflows", "wf_43bbdee2-dc0"); await mkdir(run, { recursive: true });
    for (const id of ["afirst", "asecond"]) await writeFile(path.join(run, `agent-${id}.jsonl`), sidechain(id));
    await writeFile(path.join(run, "agent-afirst.meta.json"), JSON.stringify({ agentType: "general-purpose", description: "Shared test scaffolding" }));
    const journal = path.join(run, "journal.jsonl");
    await writeFile(journal, [{ type: "started", key: "k1", agentId: "afirst" }, { type: "started", key: "k2", agentId: "asecond" }].map(row => JSON.stringify(row)).join("\n") + "\n");
    expect(await f.states()).toEqual([{ id: "afirst", label: "Shared test scaffolding", state: "running" }, { id: "asecond", label: "cleanup-wave0", state: "running" }]);
    await appendFile(journal, JSON.stringify({ type: "result", key: "k1", agentId: "afirst", result: {} }) + "\n");
    vi.useFakeTimers({ now: Date.now() + 6_000, toFake: ["Date"] });
    try { expect((await f.states()).map(child => child.state)).toEqual(["completed", "running"]); } finally { vi.useRealTimers(); }
    await f.append(notice("wtask01", "killed"));
    expect((await f.states()).map(child => child.state)).toEqual(["completed", "completed"]);
  });

  it("finds a named teammate by the name in its meta file, and lists a named background agent once", async () => {
    const f = await parent({ type: "assistant", message: { role: "assistant", content: [
      { type: "tool_use", id: "call-mate", name: "Agent", input: { name: "reviewer", description: "Review the diff", prompt: "Review" } },
      { type: "tool_use", id: "call-bg", name: "Agent", input: { name: "builder", description: "Build it", prompt: "Build", run_in_background: true } }] } },
    result({ status: "async_launched", isAsync: true, agentId: "abuilder1", description: "Build it" }, "call-bg"));
    await writeFile(path.join(f.directory, "agent-amate01.jsonl"), sidechain("amate01"));
    await writeFile(path.join(f.directory, "agent-amate01.meta.json"), JSON.stringify({ agentType: "general-purpose", name: "reviewer" }));
    await writeFile(path.join(f.directory, "agent-abuilder1.jsonl"), sidechain("abuilder1"));
    await writeFile(path.join(f.directory, "agent-abuilder1.meta.json"), JSON.stringify({ agentType: "general-purpose", name: "builder" }));
    expect(await f.states()).toEqual([{ id: "abuilder1", label: "Build it", state: "running" }, { id: "amate01", label: "Review the diff", state: "running" }]);
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
