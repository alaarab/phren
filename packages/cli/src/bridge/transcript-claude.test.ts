import { afterEach, describe, expect, it, vi } from "vitest";
import { createHash } from "node:crypto";
import { appendFile, mkdir, mkdtemp, rm, stat, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { CLAUDE_SKILL_QUIET_MS, claudeChildAgents, visibleClaudeEvent, type ClaudeQueueState } from "./transcript-claude.js";
import { TranscriptReader } from "./transcripts.js";
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

  it("rechecks a running skill without reading its unchanged parent again", async () => {
    const f = await parent({ type: "system", subtype: "local_command", content: '<forked-skill-launch>{"agentId":"askill","skillName":"code-review"}</forked-skill-launch>' });
    const child = path.join(f.directory, "agent-askill.jsonl");
    await writeFile(child, sidechain("askill", { type: "assistant", message: { role: "assistant", stop_reason: "tool_use", content: [] } }));
    const at = 1_790_000_000;
    await utimes(f.file, at, at);
    expect(await f.states()).toEqual([{ id: "askill", label: "/code-review", state: "running" }]);
    // Same size, inode and time, other bytes: a reread of the parent would lose the launch.
    await writeFile(f.file, " ".repeat((await stat(f.file)).size)); await utimes(f.file, at, at);
    vi.useFakeTimers({ now: Date.now() + 6_000, toFake: ["Date"] });
    try { expect(await f.states()).toEqual([{ id: "askill", label: "/code-review", state: "running" }]); } finally { vi.useRealTimers(); }
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

  it("ends a teammate and a background agent whose session lost their final notice", async () => {
    // The session restarted: the teammate's last word was a report, not idle or a shutdown,
    // and the background agent's completion notification never reached the parent.
    const f = await parent({ type: "assistant", message: { role: "assistant", content: [
      { type: "tool_use", id: "call-mate", name: "Agent", input: { name: "composer", description: "Talk settings sheet", prompt: "Build" } }] } },
    result({ status: "async_launched", isAsync: true, agentId: "areview1", description: "Review hook-2" }, "call-bg"),
    { type: "user", message: { role: "user", content: '<teammate-message teammate_id="composer" summary="done">The sheet is written.</teammate-message>' } });
    const mate = path.join(f.directory, "agent-acomposer-0123abcd.jsonl"), review = path.join(f.directory, "agent-areview1.jsonl");
    await writeFile(mate, sidechain("acomposer-0123abcd", { type: "assistant", message: { role: "assistant", stop_reason: "tool_use", content: [] } }));
    await writeFile(review, sidechain("areview1", { type: "assistant", message: { role: "assistant", stop_reason: "end_turn", content: [{ type: "text", text: "Findings written." }] } }));
    // The background agent ended on a finished reply; the teammate is mid-tool, so it runs on.
    expect(await f.states()).toEqual([{ id: "areview1", label: "Review hook-2", state: "completed" }, { id: "acomposer-0123abcd", label: "Talk settings sheet", state: "running" }]);
    // Quiet past the limit: the teammate's session is gone, so it is no longer running.
    const old = new Date(Date.now() - CLAUDE_SKILL_QUIET_MS - 1_000);
    await utimes(mate, old, old);
    vi.useFakeTimers({ now: Date.now() + 6_000, toFake: ["Date"] });
    try { expect((await f.states()).map(child => child.state)).toEqual(["completed", "completed"]); } finally { vi.useRealTimers(); }
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

describe("Claude queue consumption", () => {
  const digest = (text: string) => createHash("sha256").update(text).digest("hex");
  const queueState = (turn: Json): ClaudeQueueState => {
    const state: ClaudeQueueState = {};
    visibleClaudeEvent(turn, false, state);
    return state;
  };
  // Redacted shapes from a Claude Code 2.1.263 transcript: a queued prompt
  // enqueues with its content, then a content-free dequeue when it is handed
  // to the model. A self-scheduled prompt (cron, /loop, ScheduleWakeup or an
  // auto-continuation) is delivered as a hidden isMeta user turn.
  const humanTurn = { type: "user", isSidechain: false, promptSource: "queued", origin: { kind: "human" }, timestamp: "2026-09-16T08:55:00.192Z",
    message: { role: "user", content: "Do a pull" } };
  const scheduledTurn = { type: "user", isSidechain: false, isMeta: true, promptSource: "system", scheduledTaskId: "926a7a84",
    scheduledFireId: "41d141b3-0e28-454f-9946-b7093d045570", turnOrigin: "scheduled", timestamp: "2026-09-16T08:55:00.192Z",
    message: { role: "user", content: "Check CI on PR #256 (gh pr checks 256)" } };

  it("keys a remove by its content", () => {
    expect(visibleClaudeEvent({ type: "queue-operation", operation: "remove", timestamp: "t", content: "absorbed mid-turn" }))
      .toEqual({ type: "phren_queue_consumed", key: digest("absorbed mid-turn"), timestamp: "t" });
  });

  it("marks a dequeue as consumption, keyless when the prompt turn is not in view", () => {
    expect(visibleClaudeEvent({ type: "queue-operation", operation: "dequeue", timestamp: "t" }))
      .toEqual({ type: "phren_queue_consumed", timestamp: "t" });
  });

  it("keys a dequeue by the human prompt turn it delivered", () => {
    expect(visibleClaudeEvent({ type: "queue-operation", operation: "dequeue", timestamp: "t" }, false, queueState(humanTurn)))
      .toEqual({ type: "phren_queue_consumed", key: digest("Do a pull"), timestamp: "t" });
  });

  it("pairs one prompt turn with one dequeue, so an older dequeue stays keyless", () => {
    const state = queueState(scheduledTurn);
    visibleClaudeEvent({ type: "queue-operation", operation: "dequeue", timestamp: "t2" }, false, state);
    expect(visibleClaudeEvent({ type: "queue-operation", operation: "dequeue", timestamp: "t1" }, false, state))
      .toEqual({ type: "phren_queue_consumed", timestamp: "t1" });
  });

  it("keys a dequeue by the scheduled turn and flags it", () => {
    expect(visibleClaudeEvent({ type: "queue-operation", operation: "dequeue", timestamp: "t" }, false, queueState(scheduledTurn)))
      .toEqual({ type: "phren_queue_consumed", key: digest("Check CI on PR #256 (gh pr checks 256)"), scheduled: true, timestamp: "t" });
  });

  it("flags an auto-continuation's dequeue as scheduled too", () => {
    const turn = { type: "user", isSidechain: false, isMeta: true, promptSource: "system", origin: { kind: "auto-continuation" },
      timestamp: "t", message: { role: "user", content: "You can continue now." } };
    expect(visibleClaudeEvent({ type: "queue-operation", operation: "dequeue", timestamp: "t" }, false, queueState(turn)))
      .toEqual({ type: "phren_queue_consumed", key: digest("You can continue now."), scheduled: true, timestamp: "t" });
  });

  it("returns a popAll to the input so leftovers are not drawn as a scheduled check", () => {
    expect(visibleClaudeEvent({ type: "queue-operation", operation: "popAll", timestamp: "t", content: "tell me what to mssg that agent" }))
      .toEqual({ type: "phren_queue_returned", key: digest("tell me what to mssg that agent"), timestamp: "t" });
  });

  it("keys a dequeue for a pasted phone message by its unwrapped content", () => {
    const pasted = '<pasted_content id="57d2">\nAm I on the latest version?\n</pasted_content id="57d2">';
    const state: ClaudeQueueState = {};
    visibleClaudeEvent({ type: "user", promptSource: "queued", timestamp: "t", message: { role: "user", content: "\n\n" + pasted } }, false, state);
    expect(visibleClaudeEvent({ type: "queue-operation", operation: "dequeue", timestamp: "t" }, false, state))
      .toEqual({ type: "phren_queue_consumed", key: digest("Am I on the latest version?"), timestamp: "t" });
  });

  it("keeps a queued bubble but does not flag an ordinary peer notice as scheduled", () => {
    const peer = { type: "user", isSidechain: false, isMeta: true, promptSource: "system", origin: { kind: "peer" },
      timestamp: "t", message: { role: "user", content: "Another Claude session sent a message:\n<agent-message />" } };
    expect(visibleClaudeEvent({ type: "queue-operation", operation: "dequeue", timestamp: "t" }, false, queueState(peer)))
      .toEqual({ type: "phren_queue_consumed", key: digest("Another Claude session sent a message:\n<agent-message />"), timestamp: "t" });
  });
});

describe("Claude queue consumption through the transcript reader", () => {
  const roots: string[] = [];
  const session = "eeeeeeee-5555-4555-8555-555555555555";
  afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });

  async function read(rows: Json[]) {
    const root = await mkdtemp(path.join(tmpdir(), "phren-queue-")); roots.push(root);
    const file = path.join(root, `${session}.jsonl`);
    await writeFile(file, rows.map(row => JSON.stringify(row)).join("\n") + "\n");
    const page = await new TranscriptReader(file, "claude").read();
    return page.entries.map(entry => entry.raw);
  }

  const enqueue = (content: string) => ({ type: "queue-operation", operation: "enqueue", timestamp: "2026-09-16T08:55:00.165Z", sessionId: session, content });
  const dequeue = { type: "queue-operation", operation: "dequeue", timestamp: "2026-09-16T08:55:00.184Z", sessionId: session };
  const digest = (text: string) => createHash("sha256").update(text).digest("hex");

  it("exports an absorbed prompt's remove", async () => {
    const rows = await read([enqueue("Another thing we should track"), { type: "queue-operation", operation: "remove", timestamp: "2026-09-16T08:55:00.184Z",
      sessionId: session, content: "Another thing we should track", reason: "absorbed_mid_turn" }]);
    expect(rows.find(row => row.phrenQueued)).toMatchObject({ type: "user", phrenQueued: true, message: { role: "user", content: "Another thing we should track" } });
    expect(rows.find(row => row.type === "phren_queue_consumed"))
      .toEqual({ type: "phren_queue_consumed", key: digest("Another thing we should track"), timestamp: "2026-09-16T08:55:00.184Z" });
  });

  it("exports a human queued prompt's dequeue as its consumption", async () => {
    const rows = await read([enqueue("Do a pull"), dequeue,
      { type: "user", isSidechain: false, promptSource: "queued", origin: { kind: "human" }, uuid: "u1", timestamp: "2026-09-16T08:55:00.192Z",
        message: { role: "user", content: "Do a pull" } }]);
    expect(rows.find(row => row.phrenQueued)).toMatchObject({ phrenQueueKey: digest("Do a pull") });
    expect(rows.find(row => row.type === "phren_queue_consumed"))
      .toEqual({ type: "phren_queue_consumed", key: digest("Do a pull"), timestamp: "2026-09-16T08:55:00.184Z" });
  });

  it("exports a scheduled prompt's dequeue with the scheduled flag", async () => {
    const rows = await read([enqueue("Check CI on PR #256 (gh pr checks 256)"), dequeue,
      { parentUuid: "p1", isSidechain: false, type: "system", subtype: "scheduled_task_fire", isMeta: false, taskId: "926a7a84",
        content: "Claude resuming /loop wakeup (Sep 16 1:55am)", prompt: "Check CI on PR #256 (gh pr checks 256)", taskKind: "loop",
        cron: "55 1 * * *", timestamp: "2026-09-16T08:55:00.162Z", sessionId: session, uuid: "s1" },
      { parentUuid: "s1", isSidechain: false, type: "user", isMeta: true, promptSource: "system", scheduledTaskId: "926a7a84",
        scheduledFireId: "41d141b3-0e28-454f-9946-b7093d045570", turnOrigin: "scheduled", uuid: "u2", timestamp: "2026-09-16T08:55:00.192Z",
        message: { role: "user", content: "Check CI on PR #256 (gh pr checks 256)" } }]);
    expect(rows.find(row => row.phrenQueued)).toMatchObject({ phrenQueued: true, phrenQueueKey: digest("Check CI on PR #256 (gh pr checks 256)") });
    expect(rows.find(row => row.type === "phren_queue_consumed"))
      .toEqual({ type: "phren_queue_consumed", key: digest("Check CI on PR #256 (gh pr checks 256)"), scheduled: true, timestamp: "2026-09-16T08:55:00.184Z" });
    // The scheduled turn itself stays hidden.
    expect(rows.some(row => row.isMeta === true)).toBe(false);
  });
});
