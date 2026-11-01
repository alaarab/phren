import { afterEach, describe, expect, it, vi } from "vitest";
import { createHash } from "node:crypto";
import { appendFile, mkdir, mkdtemp, readFile, rm, stat, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { stopFacts } from "./agent-hook-callback.js";
import { CLAUDE_SKILL_QUIET_MS, CLAUDE_STOP_TRUST_MS, claudeChildAgents, visibleClaudeEvent, type ClaudeQueueState } from "./transcript-claude.js";
import { ambiguousPromptIdentities, runningChildAgents, TranscriptReader } from "./transcripts.js";
import { TranscriptPreviewStream } from "./transcript-preview.js";
import { noteTurn } from "./turn-records.js";
import type { Json, Target } from "./protocol.js";

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

describe("Claude background agents the parent's Stop lists", () => {
  const roots: string[] = [];
  const session = "eeeeeeee-5555-4555-8555-555555555555";
  afterEach(async () => { vi.unstubAllEnvs(); await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });
  const ids = Array.from({ length: 9 }, (_, i) => `agent${i + 1}`);

  /** A lead that launched nine background agents; seven sit quiet past the limit (a long build, the
   * machine's build gate), two keep writing. Seen 2026-10-17: the phone showed 2, Claude said 9. */
  async function lead() {
    const root = await mkdtemp(path.join(tmpdir(), "phren-child-stop-")); roots.push(root);
    vi.stubEnv("PHREN_BRIDGE_HOME", path.join(root, "bridge"));
    const directory = path.join(root, session, "subagents"); await mkdir(directory, { recursive: true });
    const file = path.join(root, `${session}.jsonl`), rows: Json[] = [];
    const old = new Date(Date.now() - CLAUDE_SKILL_QUIET_MS - 60_000);
    for (const [index, agentId] of ids.entries()) {
      rows.push({ type: "user", toolUseResult: { status: "async_launched", isAsync: true, agentId, description: `Worker ${index + 1}` },
        message: { role: "user", content: [{ type: "tool_result", tool_use_id: `call-${agentId}`, content: "launched" }] } });
      const child = path.join(directory, `agent-${agentId}.jsonl`);
      await writeFile(child, [{ type: "user", isSidechain: true, sessionId: session, agentId, message: { role: "user", content: "Build" } },
        { type: "assistant", message: { role: "assistant", stop_reason: "tool_use", content: [] } }].map(row => JSON.stringify(row)).join("\n") + "\n");
      if (index < 7) await utimes(child, old, old);
    }
    await writeFile(file, rows.map(row => JSON.stringify(row)).join("\n") + "\n");
    return { file, append: (row: Json) => appendFile(file, JSON.stringify(row) + "\n"),
      running: async () => (await claudeChildAgents(file, session)).filter(child => child.state === "running").map(child => child.session) };
  }
  /** The lead's Stop, as Claude Code sends it, through the Hook's turn record. */
  const stopped = (tasks: { id: string; status: string }[]) => noteTurn("default", "w1:p1", { event: "Stop", terminal: "term-1", source: "claude", session,
    ...stopFacts({ background_tasks: tasks.map(task => ({ ...task, type: "subagent" })) }) });

  it("counts every agent the Stop lists as running, though most have gone quiet", async () => {
    const f = await lead();
    await stopped(ids.map(id => ({ id, status: "running" })));
    expect(await f.running()).toEqual(ids);
    // The overview's count is the tree's.
    expect(runningChildAgents(await claudeChildAgents(f.file, session))).toHaveLength(9);
  });

  it("ends an agent the Stop lists as finished, even one still writing", async () => {
    const f = await lead();
    await stopped([...ids.slice(0, 8).map(id => ({ id, status: "running" })), { id: "agent9", status: "completed" }]);
    expect(await f.running()).toEqual(ids.slice(0, 8));
  });

  it("goes by the agents' own transcripts when no Stop listed them", async () => {
    const f = await lead();
    expect(await f.running()).toEqual(["agent8", "agent9"]);
    // A Stop that lists only shells says nothing of the agents.
    await stopped([{ id: "bshell1", status: "running" }]);
    vi.useFakeTimers({ now: Date.now() + 6_000, toFake: ["Date"] });
    try { expect(await f.running()).toEqual(["agent8", "agent9"]); } finally { vi.useRealTimers(); }
  });

  it("runs an agent SendMessage resumed after the Stop that listed it finished", async () => {
    const f = await lead();
    await stopped([...ids.slice(0, 8).map(id => ({ id, status: "running" })), { id: "agent9", status: "completed" }]);
    await f.append({ type: "user", timestamp: new Date(Date.now() + 1_000).toISOString(), toolUseResult: { success: true, message: "Resuming agent agent9", resumedAgentId: "agent9" },
      message: { role: "user", content: [{ type: "tool_result", tool_use_id: "call-resume", content: "ok" }] } });
    expect(await f.running()).toEqual(ids);
  });

  it("keeps a resumed agent running until it finishes again, past the end_turn it ended on before", async () => {
    const f = await lead();
    const child = path.join(path.dirname(f.file), session, "subagents", "agent-agent9.jsonl"), now = Date.now();
    const reply = (at: number) => appendFile(child, JSON.stringify({ type: "assistant", timestamp: new Date(at).toISOString(),
      message: { role: "assistant", stop_reason: "end_turn", content: [{ type: "text", text: "Done." }] } }) + "\n");
    await reply(now - 1_000);
    await stopped([...ids.slice(0, 8).map(id => ({ id, status: "running" })), { id: "agent9", status: "completed" }]);
    // Resumed after the Stop; the tree is read before the child writes anything new.
    await f.append({ type: "user", timestamp: new Date(now + 1_000).toISOString(), toolUseResult: { success: true, message: "Resuming agent agent9", resumedAgentId: "agent9" },
      message: { role: "user", content: [{ type: "tool_result", tool_use_id: "call-resume", content: "ok" }] } });
    vi.useFakeTimers({ now: now + 2_000, toFake: ["Date"] });
    try { expect(await f.running()).toEqual(ids); } finally { vi.useRealTimers(); }
    // Its unchanged parent is looked at again on a timer, and the next finished reply ends it.
    await reply(now + 3_000);
    vi.useFakeTimers({ now: now + 9_000, toFake: ["Date"] });
    try { expect(await f.running()).toEqual(ids.slice(0, 8)); } finally { vi.useRealTimers(); }
  });

  it("ends a workflow's agents once the Stop lists the workflow finished", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "phren-child-stop-")); roots.push(root);
    vi.stubEnv("PHREN_BRIDGE_HOME", path.join(root, "bridge"));
    const run = path.join(root, session, "subagents", "workflows", "wf_0f0ce397-aa1"); await mkdir(run, { recursive: true });
    const file = path.join(root, `${session}.jsonl`);
    await writeFile(file, JSON.stringify({ type: "user", toolUseResult: { status: "async_launched", taskId: "wtask01", taskType: "local_workflow", workflowName: "sweep", runId: "wf_0f0ce397-aa1" },
      message: { role: "user", content: [{ type: "tool_result", tool_use_id: "call-wf", content: "ok" }] } }) + "\n");
    await writeFile(path.join(run, "agent-afirst.jsonl"), JSON.stringify({ type: "user", isSidechain: true, sessionId: session, agentId: "afirst", message: { role: "user", content: "Go" } }) + "\n");
    await writeFile(path.join(run, "journal.jsonl"), JSON.stringify({ type: "started", key: "k1", agentId: "afirst" }) + "\n");
    const states = async () => (await claudeChildAgents(file, session)).map(child => [child.session, child.state]);
    expect(await states()).toEqual([["afirst", "running"]]);
    // No task-notification reached the parent; the Stop says the run is done.
    await stopped([{ id: "wtask01", status: "completed" }]);
    vi.useFakeTimers({ now: Date.now() + 3_000, toFake: ["Date"] });
    try { expect(await states()).toEqual([["afirst", "completed"]]); } finally { vi.useRealTimers(); }
    // Past the Stop's trust its quiet agent stays ended rather than running again.
    vi.useFakeTimers({ now: Date.now() + CLAUDE_STOP_TRUST_MS + 60_000, toFake: ["Date"] });
    try { expect(await states()).toEqual([["afirst", "completed"]]); } finally { vi.useRealTimers(); }
  });

  it("keeps a quiet workflow agent running while the Stop lists its run as running", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "phren-child-stop-")); roots.push(root);
    vi.stubEnv("PHREN_BRIDGE_HOME", path.join(root, "bridge"));
    const run = path.join(root, session, "subagents", "workflows", "wf_0f0ce397-bb2"); await mkdir(run, { recursive: true });
    const file = path.join(root, `${session}.jsonl`), child = path.join(run, "agent-asecond.jsonl");
    await writeFile(file, JSON.stringify({ type: "user", toolUseResult: { status: "async_launched", taskId: "wtask02", taskType: "local_workflow", workflowName: "sweep", runId: "wf_0f0ce397-bb2" },
      message: { role: "user", content: [{ type: "tool_result", tool_use_id: "call-wf", content: "ok" }] } }) + "\n");
    await writeFile(child, JSON.stringify({ type: "user", isSidechain: true, sessionId: session, agentId: "asecond", message: { role: "user", content: "Go" } }) + "\n");
    await writeFile(path.join(run, "journal.jsonl"), JSON.stringify({ type: "started", key: "k1", agentId: "asecond" }) + "\n");
    const old = new Date(Date.now() - CLAUDE_SKILL_QUIET_MS - 60_000);
    await utimes(child, old, old);
    const states = async () => (await claudeChildAgents(file, session)).map(entry => [entry.session, entry.state]);
    expect(await states()).toEqual([["asecond", "completed"]]);
    await stopped([{ id: "wtask02", status: "running" }]);
    vi.useFakeTimers({ now: Date.now() + 3_000, toFake: ["Date"] });
    try { expect(await states()).toEqual([["asecond", "running"]]); } finally { vi.useRealTimers(); }
  });

  it("forgets a closed pane's Stop once the conversation is resumed in another pane", async () => {
    const f = await lead();
    await stopped(ids.map(id => ({ id, status: "running" })));
    // Quitting Claude ended its agents; `claude --resume` in another pane starts the conversation again.
    await noteTurn("default", "w1:p2", { event: "SessionStart", start: "resume", terminal: "term-2", source: "claude", session, at: Date.now() + 1_000 });
    vi.useFakeTimers({ now: Date.now() + 6_000, toFake: ["Date"] });
    try { expect(await f.running()).toEqual(["agent8", "agent9"]); } finally { vi.useRealTimers(); }
  });

  it("stops believing a Stop hours old, from a session that may have exited", async () => {
    const f = await lead();
    await noteTurn("default", "w1:p1", { event: "Stop", terminal: "term-1", source: "claude", session, at: Date.now() - CLAUDE_STOP_TRUST_MS - 1_000,
      ...stopFacts({ background_tasks: ids.map(id => ({ id, status: "running", type: "subagent" })) }) });
    expect(await f.running()).toEqual(["agent8", "agent9"]);
  });
});

describe("Claude agents launched in the foreground, or reported oddly", () => {
  const roots: string[] = [];
  const session = "ffffffff-6666-4666-8666-666666666666";
  afterEach(async () => { vi.unstubAllEnvs(); await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });
  const call = (id: string, input: Json, at = new Date().toISOString()) => ({ type: "assistant", timestamp: at,
    message: { role: "assistant", content: [{ type: "tool_use", id, name: "Agent", input }] } });
  const result = (id: string, toolUseResult: Json, extra: Json = {}) => ({ type: "user", timestamp: new Date().toISOString(), toolUseResult,
    message: { role: "user", content: [{ type: "tool_result", tool_use_id: id, content: "ok", ...extra }] } });

  async function lead(...rows: Json[]) {
    const root = await mkdtemp(path.join(tmpdir(), "phren-child-fg-")); roots.push(root);
    vi.stubEnv("PHREN_BRIDGE_HOME", path.join(root, "bridge"));
    const directory = path.join(root, session, "subagents"); await mkdir(directory, { recursive: true });
    const file = path.join(root, `${session}.jsonl`);
    await writeFile(file, rows.map(row => JSON.stringify(row)).join("\n") + "\n");
    return { file, directory, append: (...more: Json[]) => appendFile(file, more.map(row => JSON.stringify(row)).join("\n") + "\n"),
      children: () => claudeChildAgents(file, session),
      sidechain: (agentId: string, prompt: string) => writeFile(path.join(directory, `agent-${agentId}.jsonl`),
        JSON.stringify({ type: "user", isSidechain: true, sessionId: session, agentId, message: { role: "user", content: prompt } }) + "\n") };
  }

  it("lists a foreground Agent call without a name while it runs, by its own transcript, until its result", async () => {
    const f = await lead(call("call-fg", { description: "Map the parser", prompt: "Read src/parser.ts and list its entry points." }));
    await f.sidechain("a1b2c3", "Read src/parser.ts and list its entry points.");
    expect((await f.children()).map(child => ({ label: child.path, state: child.state, session: child.session }))).toEqual([{ label: "Map the parser", state: "running", session: "a1b2c3" }]);
    expect(runningChildAgents(await f.children())).toHaveLength(1);
    await f.append(result("call-fg", { status: "completed", content: [] }));
    expect(runningChildAgents(await f.children())).toEqual([]);
  });

  it("counts a foreground call whose own transcript isn't there yet", async () => {
    const f = await lead(call("call-fg", { description: "Write the tests", prompt: "Add tests." }));
    expect((await f.children()).map(child => ({ label: child.path, state: child.state }))).toEqual([{ label: "Write the tests", state: "running" }]);
  });

  it("ends a foreground call interrupted mid-run, or whose turn the parent's Stop ended", async () => {
    const f = await lead(call("call-fg", { description: "Map", prompt: "Go." }), result("call-fg", {}, { is_error: true, content: "[Request interrupted by user for tool use]" }));
    expect(runningChildAgents(await f.children())).toEqual([]);
    const g = await lead(call("call-fg", { description: "Map", prompt: "Go." }, new Date(Date.now() - 60_000).toISOString()));
    await noteTurn("default", "w1:p1", { event: "Stop", terminal: "term-1", source: "claude", session, ...stopFacts({ background_tasks: [] }) });
    expect(runningChildAgents(await g.children())).toEqual([]);
  });

  it("does not list a background or named call twice: their launch and teammate paths own them", async () => {
    const f = await lead(call("call-bg", { description: "Review", prompt: "Review.", run_in_background: true }),
      result("call-bg", { status: "async_launched", isAsync: true, agentId: "abg1", description: "Review" }));
    await f.sidechain("abg1", "Review.");
    expect((await f.children()).map(child => child.session)).toEqual(["abg1"]);
  });

  it("counts an async launch reported with another status, or its id under another key", async () => {
    const f = await lead(result("call-1", { status: "launched", isAsync: true, agentId: "aodd1", description: "Odd status" }),
      result("call-2", { status: "async_launched", agent_id: "aodd2", description: "Other key" }));
    await f.sidechain("aodd1", "x"); await f.sidechain("aodd2", "y");
    expect(runningChildAgents(await f.children()).map(child => child.session).sort()).toEqual(["aodd1", "aodd2"]);
  });

  it("counts an async launch without an id by its own transcript, ending as any launch does", async () => {
    const launchedAt = new Date(Date.now() - 60_000).toISOString();
    const f = await lead(call("call-x", { description: "No id", prompt: "Profile the build.", run_in_background: true }, launchedAt),
      { ...result("call-x", { status: "async_launched", isAsync: true, description: "No id" }), timestamp: launchedAt });
    await f.sidechain("anoid1", "Profile the build.");
    expect((await f.children()).map(child => ({ label: child.path, state: child.state, session: child.session }))).toEqual([{ label: "No id", state: "running", session: "anoid1" }]);
    // The Stop names its agent finished; a background shell still running holds nothing open.
    await noteTurn("default", "w1:p1", { event: "Stop", terminal: "term-1", source: "claude", session,
      ...stopFacts({ background_tasks: [{ id: "anoid1", status: "completed" }, { id: "bshell1", status: "running", type: "shell" }] }) });
    vi.useFakeTimers({ now: Date.now() + 6_000, toFake: ["Date"] });
    try { expect(runningChildAgents(await f.children())).toEqual([]); } finally { vi.useRealTimers(); }
  });

  it("counts an id-less launch whose transcript can't be found for at most the quiet limit", async () => {
    const recent = new Date(Date.now() - 60_000).toISOString(), old = new Date(Date.now() - CLAUDE_SKILL_QUIET_MS - 60_000).toISOString();
    const launch = (id: string, at: string) => [call(id, { description: id, prompt: `Task ${id}.`, run_in_background: true }, at),
      { ...result(id, { status: "async_launched", isAsync: true }), timestamp: at }];
    const f = await lead(...launch("recent", recent), ...launch("old", old));
    expect(runningChildAgents(await f.children()).map(child => child.path)).toEqual(["recent"]);
  });

  it("keeps an id-less launch on its own transcript when a later call with the same prompt finished", async () => {
    const t0 = Date.now() - 120_000, t1 = Date.now() - 60_000;
    const stamped = (agentId: string, at: number, ...rows: Json[]) => writeFile(path.join(f.directory, `agent-${agentId}.jsonl`),
      [{ type: "user", isSidechain: true, sessionId: session, agentId, timestamp: new Date(at).toISOString(), message: { role: "user", content: "Run the suite." } }, ...rows]
        .map(row => JSON.stringify(row)).join("\n") + "\n");
    const f = await lead(call("call-bg", { description: "Background run", prompt: "Run the suite.", run_in_background: true }, new Date(t0).toISOString()),
      { ...result("call-bg", { status: "async_launched", isAsync: true }), timestamp: new Date(t0 + 500).toISOString() },
      call("call-fg", { description: "Foreground run", prompt: "Run the suite." }, new Date(t1).toISOString()), result("call-fg", { status: "completed" }));
    // The background agent is in a long build; the foreground one finished, and wrote last.
    await stamped("abg", t0 + 1_000, { type: "assistant", message: { role: "assistant", stop_reason: "tool_use", content: [] } });
    await stamped("afg", t1 + 1_000, { type: "assistant", message: { role: "assistant", stop_reason: "end_turn", content: [{ type: "text", text: "All green." }] } });
    expect(runningChildAgents(await f.children()).map(child => ({ label: child.path, session: child.session }))).toEqual([{ label: "Background run", session: "abg" }]);
  });

  it("never takes an earlier call's transcript, with the same prompt, for a new foreground call", async () => {
    const f = await lead();
    await f.sidechain("aold1", "Run the test suite.");
    const earlier = new Date(Date.now() - CLAUDE_SKILL_QUIET_MS - 60_000);
    await utimes(path.join(f.directory, "agent-aold1.jsonl"), earlier, earlier);
    await f.append(call("call-new", { description: "Run the tests again", prompt: "Run the test suite." }));
    // Its own file isn't written yet: listed running, awaiting it, never the old (quiet) one.
    expect((await f.children()).map(child => ({ label: child.path, state: child.state, session: child.session }))).toEqual([{ label: "Run the tests again", state: "running", session: undefined }]);
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
    expect(visibleClaudeEvent({ ...queued("remove"), reason: "absorbed_mid_turn" })).toEqual({ type: "phren_queue_consumed", key, timestamp: "t" });
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

  it("keys an accepted remove by its content and draws a cancellation as withdrawal", () => {
    expect(visibleClaudeEvent({ type: "queue-operation", operation: "remove", reason: "absorbed_mid_turn", timestamp: "t", content: "absorbed mid-turn" }))
      .toEqual({ type: "phren_queue_consumed", key: digest("absorbed mid-turn"), timestamp: "t" });
    // A cancellation never reached the agent: it is withdrawn, not sent.
    expect(visibleClaudeEvent({ type: "queue-operation", operation: "remove", reason: "cleared_on_cancel", timestamp: "t", content: "absorbed mid-turn" }))
      .toEqual({ type: "phren_queue_returned", key: digest("absorbed mid-turn"), timestamp: "t" });
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

  // The owner fixture: two pictures queued mid-turn. Claude's row carries its
  // own deliveryId/commandUuid; only the Hook's binding may name the phone send.
  const ownerContent = "[Image #4] [Image #5]These two screens are literally flashing between eachother shits so buggy \nAttached files on this computer:";
  const withBinding = (offset: number): ClaudeQueueState => ({ offset, deliveryFor: (_raw, at) => at === 0 || at === 3 ? "phone-send-0001" : undefined });

  it("names a bound enqueue and its removal with the phone id, never Claude's", () => {
    const enqueue = visibleClaudeEvent({ type: "queue-operation", operation: "enqueue", timestamp: "t", sessionId: "s", content: ownerContent }, false, withBinding(0));
    expect(enqueue).toEqual({ type: "user", phrenQueued: true, phrenQueueKey: digest(ownerContent), phrenDeliveryId: "phone-send-0001",
      timestamp: "t", message: { role: "user", content: ownerContent } });
    const remove = visibleClaudeEvent({ type: "queue-operation", operation: "remove", reason: "absorbed_mid_turn", deliveryId: "626aa5af-75f1-40eb-8d0a-dfc176643b04",
      commandUuid: "f425bffe-b4b6-4129-b7a4-7c3295a10115", timestamp: "t2", sessionId: "s", content: ownerContent }, false, withBinding(3));
    expect(remove).toEqual({ type: "phren_queue_consumed", key: digest(ownerContent), phrenDeliveryId: "phone-send-0001", timestamp: "t2" });
    expect(JSON.stringify(remove)).not.toContain("626aa5af");
    const cancelled = visibleClaudeEvent({ type: "queue-operation", operation: "remove", reason: "cleared_on_cancel", timestamp: "t3", sessionId: "s", content: ownerContent }, false, withBinding(3));
    expect(cancelled).toEqual({ type: "phren_queue_returned", key: digest(ownerContent), phrenDeliveryId: "phone-send-0001", timestamp: "t3" });
  });

  it("names a returned queue occurrence, and a submitted turn that replaced it", () => {
    const popAll = visibleClaudeEvent({ type: "queue-operation", operation: "popAll", timestamp: "t", content: ownerContent }, false, withBinding(3));
    expect(popAll).toEqual({ type: "phren_queue_returned", key: digest(ownerContent), phrenDeliveryId: "phone-send-0001", timestamp: "t" });
    const turn = visibleClaudeEvent({ type: "user", uuid: "u1", timestamp: "t", message: { role: "user", content: "Ship it" } }, false,
      { offset: 9, deliveryFor: (_raw, at) => at === 9 ? "phone-send-0001" : undefined });
    expect(turn).toMatchObject({ type: "user", phrenDeliveryId: "phone-send-0001", message: { content: "Ship it" } });
    // The binding belongs to one occurrence: a tool result with no prompt turn gets no id.
    const tool = visibleClaudeEvent({ type: "user", timestamp: "t", message: { role: "user", content: [{ type: "tool_result", tool_use_id: "x", content: "ok" }] } }, false,
      { deliveryFor: () => "phone-send-0001" });
    expect(tool).not.toMatchObject({ phrenDeliveryId: "phone-send-0001" });
  });
});

describe("Claude prompt identity", () => {
  it("keeps distinct native ids on identical prompts and never puts one on a tool result", async () => {
    const fixture = fileURLToPath(new URL("./fixtures/claude/2.1.316/prompt-identity.jsonl", import.meta.url));
    const { entries } = await new TranscriptReader(fixture, "claude").read();
    const alpha = ["fixture", "prompt", "alpha"].join("-"), beta = ["fixture", "prompt", "beta"].join("-");
    const prompts = entries.filter(entry => entry.promptEntryId);
    expect(prompts.map(entry => ({ line: entry.line, id: entry.promptEntryId, text: (entry.raw as Json).message }))).toEqual([
      { line: 0, id: `claude:prompt:${alpha}`, text: { role: "user", content: "continue" } },
      { line: 3, id: `claude:prompt:${beta}`, text: { role: "user", content: "continue" } },
    ]);
    expect(prompts[0].promptEntryId).not.toBe(prompts[1].promptEntryId);
    const tool = entries.find(entry => entry.line === 2)!;
    expect(tool.raw).toMatchObject({ type: "user", message: { content: [{ type: "tool_result" }] } });
    expect(tool).not.toHaveProperty("promptEntryId");
    // The raw native metadata stays private.
    expect(JSON.stringify(entries.map(entry => entry.raw))).not.toContain('"promptId"');
  });

  it("omits an identity shared by prompts on different pages and fresh readers", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "phren-prompt-pages-")), file = path.join(root, "claude.jsonl");
    const shared = ["fixture", "prompt", "shared"].join("-"), unique = ["fixture", "prompt", "unique"].join("-");
    const user = (uuid: string, promptId: string, text: string) => ({ type: "user", uuid, promptId, timestamp: "2026-01-02T03:04:05.000Z",
      message: { role: "user", content: text } });
    const assistant = (uuid: string) => ({ type: "assistant", uuid, timestamp: "2026-01-02T03:04:06.000Z",
      message: { role: "assistant", stop_reason: "end_turn", content: [{ type: "text", text: "ok" }] } });
    try {
      await writeFile(file, [user("u1", shared, "continue"), assistant("a1"), assistant("a2"),
        user("u2", shared, "continue"), user("u3", unique, "carry on")].map(row => JSON.stringify(row)).join("\n") + "\n");
      const first = await new TranscriptReader(file, "claude").read(2);
      const second = await new TranscriptReader(file, "claude").readAfter(1);
      const together = await new TranscriptReader(file, "claude").read();
      expect(first.entries.find(entry => entry.line === 0)).not.toHaveProperty("promptEntryId");
      expect(second.entries.find(entry => entry.line === 3)).not.toHaveProperty("promptEntryId");
      expect(together.entries.find(entry => entry.line === 0)).not.toHaveProperty("promptEntryId");
      expect(together.entries.find(entry => entry.line === 3)).not.toHaveProperty("promptEntryId");
      expect(together.entries.find(entry => entry.line === 4)?.promptEntryId).toBe(`claude:prompt:${unique}`);
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  it("keeps unique identities available when an identity scan is interrupted", async () => {
    const file = path.join(tmpdir(), `phren-prompt-interrupted-${Date.now()}-${Math.random()}.jsonl`);
    const p1 = ["fixture", "interrupted", "alpha"].join("-"), p2 = ["fixture", "interrupted", "beta"].join("-");
    const user = (uuid: string, promptId: string) => Buffer.from(JSON.stringify({ type: "user", uuid, promptId,
      timestamp: "2026-01-02T03:04:05.000Z", message: { role: "user", content: "continue" } }));
    const rows = [user("u1", p1), user("u2", p2)];
    const index = (revision: string, lines: number, failAt?: number) => ({ revision, lines,
      rows: async function* () {
        for (let i = 0; i < lines; i++) {
          if (i === failAt) throw new Error("interrupted scan");
          yield { line: lines - 1 - i, bytes: rows[i] };
        }
      } });
    await expect(ambiguousPromptIdentities(file, {} as never, index("r1", 3, 2), "claude", false))
      .rejects.toThrow("interrupted scan");
    // The retry starts from the last published position, not partial counts.
    expect([...(await ambiguousPromptIdentities(file, {} as never, index("r1", 2), "claude", false))]).toEqual([]);
    expect([...(await ambiguousPromptIdentities(file, {} as never, index("r1", 2), "claude", false))]).toEqual([]);
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

describe("Claude task-notification user rows", () => {
  const timestamp = "2026-11-01T18:25:01.000Z";
  const notification = `<task-notification>
<task-id>merge-689</task-id>
<tool-use-id>bash-689</tool-use-id>
<status>failed</status>
<summary>Background command "Merge #689 once CI is green" failed with exit code 1</summary>
<output-file>/private/task-output.txt</output-file>
<result>PRIVATE_OUTPUT</result>
</task-notification>`;
  const expected = `<task-notification>
<task-id>merge-689</task-id>
<tool-use-id>bash-689</tool-use-id>
<status>failed</status>
<summary>Background command "Merge #689 once CI is green" failed with exit code 1</summary>
</task-notification>`;
  const row = (content: unknown, origin?: unknown, extra: Json = {}) => ({
    type: "user", timestamp,
    ...(origin === undefined ? {} : { origin }),
    message: { role: "user", content },
    ...extra,
  });

  const cases: { label: string; content: unknown; origin?: unknown }[] = [
    { label: "a string with origin", content: notification, origin: { kind: "task-notification" } },
    { label: "text blocks with origin", content: [{ type: "text", text: notification }], origin: { kind: "task-notification" } },
    { label: "a string without origin", content: notification },
    { label: "text blocks without origin", content: [{ type: "text", text: notification }] },
    { label: "a system-reminder wrapper", content: `<system-reminder>\n${notification}\n</system-reminder>` },
  ];
  it.each(cases)("normalizes $label to a background notice", ({ content, origin }) => {
    expect(visibleClaudeEvent(row(content, origin))).toEqual({
      type: "system", phrenBackground: true, timestamp,
      message: { role: "user", content: expected },
    });
  });

  it("keeps the row's UUID and parent UUID", () => {
    expect(visibleClaudeEvent(row(notification, undefined, { uuid: "u2", parentUuid: "u1" })))
      .toMatchObject({ uuid: "u2", parentUuid: "u1", phrenBackground: true });
  });

  // Reconstructed from a captured Claude Code 2.1.316 row, session 6344b61f at
  // 2026-11-01T01:23:43.684Z: a real non-meta user row with a task-notification
  // origin. Only the four sanitized tags may cross the wire.
  it("normalizes a reconstructed non-meta user notification row", () => {
    const reconstructed = `<task-notification>
<task-id>blbocr5r6</task-id>
<tool-use-id>toolu_011jM1Bzc8tFVJjQi1F6BeJU</tool-use-id>
<output-file>/private/tmp/claude-501/redacted/tasks/blbocr5r6.output</output-file>
<status>completed</status>
<summary>Background command "Launch Codex worker for OpenCode question card" completed (exit code 0)</summary>
</task-notification>`;
    const raw = { type: "user", timestamp: "2026-11-01T01:23:43.684Z", uuid: "f0fe18d5-d841-488d-a84a-655979958646",
      parentUuid: "06fa9d76-09f7-4508-a9aa-1cab7cb4ac54", origin: { kind: "task-notification", producer: "session-task", runId: "redacted" },
      message: { role: "user", content: reconstructed } };
    const event = visibleClaudeEvent(raw);
    expect(event).toMatchObject({ type: "system", phrenBackground: true, timestamp: raw.timestamp, uuid: raw.uuid, parentUuid: raw.parentUuid,
      message: { role: "user", content: `<task-notification>
<task-id>blbocr5r6</task-id>
<tool-use-id>toolu_011jM1Bzc8tFVJjQi1F6BeJU</tool-use-id>
<status>completed</status>
<summary>Background command "Launch Codex worker for OpenCode question card" completed (exit code 0)</summary>
</task-notification>` } });
    expect(JSON.stringify(event)).not.toContain("/private/tmp");
    expect(JSON.stringify(event)).not.toContain("blbocr5r6.output");
  });

  // Reconstructed from captured Monitor notifications (session 6344b61f, 2026-11-01T14:18:16.919Z)
  // carry no tool-use ID, so established provenance is hidden, never user text.
  it("hides a reconstructed Monitor user notification without a tool-use ID", () => {
    const reconstructed = `<task-notification>
<task-id>b4clq7rdz</task-id>
<summary>Monitor event: "Worker exits (680/681/682 Hook + iOS)"</summary>
<event>bug-longchat exited: 0</event>
If this event is something the user would act on now, send a PushNotification. Routine or benign output doesn't need one.
</task-notification>`;
    expect(visibleClaudeEvent({ type: "user", timestamp: "2026-11-01T14:18:16.919Z", origin: { kind: "task-notification" },
      message: { role: "user", content: reconstructed } })).toBeUndefined();
  });

  it("never exports private notification data or falls back to user text", () => {
    const origin = { kind: "task-notification" };
    expect(visibleClaudeEvent(row("PRIVATE_OUTPUT", origin))).toBeUndefined();
    expect(visibleClaudeEvent(row("<task-notification><task-id>merge-689</task-id></task-notification>", origin))).toBeUndefined();
    expect(visibleClaudeEvent(row(`${notification}\n${"x".repeat(65_536)}`, origin))).toBeUndefined();
    const exported = JSON.stringify(visibleClaudeEvent(row(notification, origin)));
    expect(exported).not.toContain("PRIVATE_OUTPUT");
    expect(exported).not.toContain("/private/task-output.txt");
  });

  it("keeps sidechain notifications private and ordinary prose ordinary", () => {
    expect(visibleClaudeEvent(row(notification, undefined, { isSidechain: true }))).toBeUndefined();
    const prose = "How does the <task-notification> envelope work in the transcript?";
    expect(visibleClaudeEvent(row(prose))).toMatchObject({ type: "user", message: { role: "user", content: prose } });
  });

  it("does not reopen the pane after a turn ends on a notification", async () => {
    const target: Target = { source: "claude", session: "preview-session", server: "default", workspace: "w1", tab: "w1:t1", pane: "w1:p1" };
    const pane = vi.fn(async () => "❯ Fix CI\n⏺ Old reply\n❯");
    const stream = new TranscriptPreviewStream(target, pane);
    const normalize = (raw: Json) => {
      const event = visibleClaudeEvent(raw);
      expect(event).toBeDefined();
      return event!;
    };
    const prompt = normalize({ type: "user", timestamp: "2026-11-01T18:25:00.000Z", message: { role: "user", content: "Fix CI" } });
    const ended = normalize({ type: "assistant", timestamp: "2026-11-01T18:25:01.000Z", message: { role: "assistant", content: [], stop_reason: "end_turn" } });
    const notice = normalize(row(notification, { kind: "task-notification" }));
    stream.observe([{ line: 0, raw: prompt }, { line: 1, raw: ended }]);
    expect(await stream.update("working", undefined, 0)).toBeUndefined();
    stream.observe([{ line: 2, raw: notice }]);
    expect(await stream.update("working", undefined, 600)).toBeUndefined();
    expect(pane).not.toHaveBeenCalled();
  });
});
