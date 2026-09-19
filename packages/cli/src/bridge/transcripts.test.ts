import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { appendFile, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { childAgent, childAgentTree, historicalImage, publicChildAgents, TranscriptReader } from "./transcripts.js";
import type { Json, Provider } from "./protocol.js";

const text = { type: "text", text: "Keep this text and data:image/png;base64,AAAA unchanged." };
type Fixture = { name: string; source: Provider; event: (image: Json) => Json };
const fixtures: Fixture[] = [
  { name: "Claude tool result", source: "claude", event: image => ({ type: "user", message: { role: "user", content: [
    text, { type: "tool_result", tool_use_id: "tool-1", is_error: false, content: [text, image, text] }, text,
  ] } }) },
  { name: "Codex structured tool output", source: "codex", event: image => ({ type: "response_item",
    payload: { type: "function_call_output", call_id: "tool-1", output: [text, image, text] } }) },
  { name: "Codex wrapped custom tool output", source: "codex", event: image => ({ type: "response_item",
    payload: { type: "custom_tool_call_output", call_id: "tool-1", output: { content: [text, image, text], isError: false } } }) },
  { name: "Copilot user content", source: "copilot", event: image => ({ type: "user.message", data: { source: "user", content: [text, image, text] } }) },
  { name: "Copilot assistant content", source: "copilot", event: image => ({ type: "assistant.message", data: { content: [text, image, text] } }) },
  { name: "Copilot tool result", source: "copilot", event: image => ({ type: "tool.execution_complete",
    data: { toolCallId: "tool-1", result: { content: [text, image, text], isError: false } } }) },
  { name: "opencode tool result", source: "opencode", event: image => ({ type: "tool/results",
    data: { message: { role: "user", content: [{ type: "tool_result", tool_use_id: "tool-1", content: [text, image, text] }] } } }) },
];

describe("transcript image payloads", () => {
  let root: string, file: string;
  beforeEach(async () => { root = await mkdtemp(path.join(tmpdir(), "phren-transcript-")); file = path.join(root, "transcript.jsonl"); });
  afterEach(async () => { await rm(root, { recursive: true }); });

  it.each(fixtures)("omits embedded bytes from $name without losing the row or surrounding text", async ({ source, event }) => {
    // This image exceeds the normal 2 MiB entry budget before sanitizing. The
    // text must remain readable instead of losing the entire tool result.
    const encoded = Buffer.alloc(1_650_000, 37).toString("base64");
    const image = { type: "image", source: { type: "base64", media_type: "image/png", data: encoded } };
    const original = JSON.stringify(event(image)) + "\n";
    await writeFile(file, original);
    const page = await new TranscriptReader(file, source).read();
    expect(page.entries).toEqual([{ line: 0, raw: event({ type: "image" }) }]);
    expect(Buffer.byteLength(JSON.stringify(page))).toBeLessThan(2_000);
    expect(page).toMatchObject({ totalLines: 1, startLine: 0, hasMore: false });
    expect(await readFile(file, "utf8")).toBe(original);
  });

  it("strips structured data URLs while preserving string results, tool arguments, and unknown blocks", async () => {
    const url = "data:image/png;base64," + Buffer.alloc(100_000, 37).toString("base64");
    const structuredImage = { type: "input_image", image_url: url };
    const events = [
      { type: "response_item", payload: { type: "function_call_output", call_id: "image", output: [text, structuredImage, { type: "unknown", data: url }] } },
      { type: "response_item", payload: { type: "function_call_output", call_id: "text", output: JSON.stringify(structuredImage) } },
      { type: "response_item", payload: { type: "function_call", call_id: "arguments", name: "inspect", arguments: { content: [structuredImage] } } },
    ];
    await writeFile(file, events.map(event => JSON.stringify(event)).join("\n") + "\n");
    const page = await new TranscriptReader(file, "codex").read();
    expect(page.entries.map(entry => entry.raw)).toEqual([
      { ...events[0], payload: { ...events[0].payload, output: [text, { type: "input_image" }, { type: "unknown", data: url }] } },
      events[1], events[2],
    ]);
  });

  it("reads opencode plugin events through the shared shape", async () => {
    const events = [
      { seq: 0, time: "2026-09-18T18:12:30.306Z", type: "user/message", data: { source: "user", message: { role: "user", content: [{ type: "text", text: "hi" }] } } },
      { seq: 1, time: "2026-09-18T18:12:30.480Z", type: "assistant/message", data: { stop_reason: "tool_use", message: { role: "assistant", content: [{ type: "text", text: "Working" }, { type: "tool_use", id: "call_1", name: "bash", input: { command: "ls" } }] }, usage: { input_tokens: 100, output_tokens: 20 } } },
      { seq: 2, time: "2026-09-18T18:12:31.000Z", type: "tool/results", data: { message: { role: "user", content: [{ type: "tool_result", tool_use_id: "call_1", content: "a\nb" }] } } },
      { seq: 3, time: "2026-09-18T18:12:32.000Z", type: "reasoning", data: { message: { role: "assistant", content: [{ type: "text", text: "secret" }] } } },
    ];
    await writeFile(file, events.map(event => JSON.stringify(event)).join("\n") + "\n");
    const page = await new TranscriptReader(file, "opencode").read();
    expect(page.entries.map(entry => entry.raw.type)).toEqual(["user/message", "assistant/message", "tool/results"]);
    expect(page.entries[1].raw).toMatchObject({ data: { stop_reason: "tool_use" } });
  });

  it("reads redacted raw opencode run events from verified fan-out logs", async () => {
    const events = [
      { type: "text", part: { type: "text", text: "Review complete", reasoning: "private" } },
      { type: "tool_use", part: { type: "tool", tool: "bash", callID: "call-1", state: { status: "completed", input: { secret: true }, output: "private" } } },
    ];
    await writeFile(file, events.map(JSON.stringify).join("\n") + "\n");
    const page = await new TranscriptReader(file, "opencode").read();
    expect(page.entries).toHaveLength(2);
    expect(JSON.stringify(page)).toContain("Review complete");
    expect(JSON.stringify(page)).not.toContain("private");
    expect(JSON.stringify(page)).not.toContain("secret");
  });

  it.each(["codex", "claude"] as const)("keeps %s direct image positions retrievable from the original row", async source => {
    const bytes = Buffer.alloc(2_048, 37);
    const image = source === "codex" ? { type: "input_image", image_url: "data:image/png;base64," + bytes.toString("base64") }
      : { type: "image", source: { type: "base64", media_type: "image/png", data: bytes.toString("base64") } };
    const event = source === "codex" ? { type: "response_item", payload: { type: "message", role: "user", content: [text, image, text] } }
      : { type: "user", message: { role: "user", content: [text, image, text] } };
    await writeFile(file, JSON.stringify(event) + "\n");
    const page = await new TranscriptReader(file, source).read();
    const message = page.entries[0].raw[source === "codex" ? "payload" : "message"] as Json;
    expect(message.content).toEqual([text, { type: image.type }, text]);
    expect(await historicalImage(file, 0, 1, source)).toEqual(bytes);
  });
});

describe("child agent relationships", () => {
  it("builds a bounded tree from explicit Codex start/completion events", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "phren-children-"));
    const old = process.env.CODEX_HOME; process.env.CODEX_HOME = root;
    const parent = "aaaaaaaa-1111-4111-8111-111111111111", child = "bbbbbbbb-2222-4222-8222-222222222222";
    const dir = path.join(root, "sessions/2026/09/19"); await mkdir(dir, { recursive: true });
    const event = (kind: string) => ({ type: "event_msg", payload: { type: "item_completed", item: {
      type: "SubAgentActivity", id: "call-1", kind, agent_thread_id: child, agent_path: "/root/tester" } } });
    const parentFile = path.join(dir, `rollout-parent-${parent}.jsonl`);
    const unrelated = Array.from({ length: 2_000 }, (_, sequence) => JSON.stringify({ type: "event_msg", payload: { type: "token_count", sequence } }));
    await writeFile(parentFile, [...unrelated, event("started"), event("interacted")].map(JSON.stringify).join("\n") + "\n");
    await writeFile(path.join(dir, `rollout-child-${child}.jsonl`), JSON.stringify({ type: "session_meta", payload: {
      source: { subagent: { thread_spawn: { parent_thread_id: parent } } } } }) + "\n");
    try {
      const running = await childAgentTree("codex", parent);
      expect(running).toHaveLength(1);
      expect(running[0]).toMatchObject({ session: child, provider: "codex", path: "/root/tester", callId: "call-1", state: "running", children: [] });
      expect(running[0].id).toMatch(/^[a-f0-9]{32}$/);
      // An unchanged repeat uses the stat cache. An append consumes only the
      // new complete JSONL rows and advances the existing relation.
      expect(await childAgentTree("codex", parent)).toEqual(running);
      await appendFile(parentFile, JSON.stringify(event("completed")) + "\n");
      const tree = await childAgentTree("codex", parent);
      expect(tree[0]).toMatchObject({ session: child, state: "completed" });
      expect(publicChildAgents(tree)[0]).not.toHaveProperty("session");
      expect(childAgent(tree, tree[0].id)?.path).toBe("/root/tester");
      expect(await childAgentTree("opencode", parent)).toEqual([]);
    } finally { process.env.CODEX_HOME = old; await rm(root, { recursive: true, force: true }); }
  });

  it("relation-gates Claude sidechain transcripts and tracks completion", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "phren-claude-children-"));
    const old = process.env.CLAUDE_CONFIG_DIR; process.env.CLAUDE_CONFIG_DIR = root;
    const parent = "cccccccc-3333-4333-8333-333333333333", agentId = "a1234worker";
    const project = path.join(root, "projects/project"); await mkdir(path.join(project, parent, "subagents"), { recursive: true });
    const launch = { type: "user", toolUseResult: { status: "async_launched", agentId, description: "Review scripts" },
      message: { role: "user", content: [{ type: "tool_result", tool_use_id: "tool-claude", content: "launched" }] } };
    const finished = { type: "queue-operation", operation: "enqueue",
      content: `<task-notification><task-id>${agentId}</task-id><status>completed</status></task-notification>` };
    await writeFile(path.join(project, `${parent}.jsonl`), [launch, finished].map(JSON.stringify).join("\n") + "\n");
    const childFile = path.join(project, parent, "subagents", `agent-${agentId}.jsonl`);
    await writeFile(childFile, [{ type: "user", isSidechain: true, sessionId: parent, agentId,
      message: { role: "user", content: "Inspect the scripts" } }, { type: "assistant", isSidechain: true,
      sessionId: parent, agentId, message: { role: "assistant", content: "Review complete" } }].map(JSON.stringify).join("\n") + "\n");
    try {
      const tree = await childAgentTree("claude", parent);
      expect(tree).toHaveLength(1);
      expect(tree[0]).toMatchObject({ provider: "claude", path: "Review scripts", callId: "tool-claude", state: "completed" });
      expect(tree[0].transcript).toMatch(new RegExp(`/subagents/agent-${agentId}\\.jsonl$`));
      expect(publicChildAgents(tree)[0]).not.toHaveProperty("session");
      expect(publicChildAgents(tree)[0]).not.toHaveProperty("transcript");
      expect((await new TranscriptReader(childFile, "claude", undefined, undefined, true).read()).entries).toHaveLength(2);
      expect((await new TranscriptReader(childFile, "claude").read()).entries).toHaveLength(0);
    } finally { process.env.CLAUDE_CONFIG_DIR = old; await rm(root, { recursive: true, force: true }); }
  });

  it("merges parent-bound opencode fan-outs into the provider-neutral tree", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "phren-opencode-child-")), job = "review-job";
    const parent = "dddddddd-4444-4444-8444-444444444444", directory = path.join(root, ".runtime/agent-fanouts", job);
    await mkdir(directory, { recursive: true }); await writeFile(path.join(directory, "events.jsonl"), "");
    await writeFile(path.join(directory, "manifest.json"), JSON.stringify({ schemaVersion: 1, id: job,
      parent: { provider: "copilot", session: parent }, provider: "opencode", taskLabel: "DeepSeek review",
      cwd: "/repo", worktree: "/repo-wt", model: "deepseek", eventLog: "events.jsonl",
      createdAt: "2026-09-19T19:00:00.000Z", startedAt: "2026-09-19T19:00:00.000Z",
      updatedAt: "2026-09-19T19:00:00.000Z", status: "running" }));
    const old = process.env.PHREN_PATH; process.env.PHREN_PATH = root;
    try {
      const tree = await childAgentTree("copilot", parent);
      expect(tree).toHaveLength(1);
      expect(tree[0]).toMatchObject({ provider: "opencode", path: "DeepSeek review", state: "running" });
      expect(publicChildAgents(tree)[0]).not.toHaveProperty("transcript");
    } finally { process.env.PHREN_PATH = old; await rm(root, { recursive: true, force: true }); }
  });
});
