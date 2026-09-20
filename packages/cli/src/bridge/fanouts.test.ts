import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir, homedir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { fanoutChildren, visibleCodexExecEvent, visibleOpenCodeRunEvent } from "./fanouts.js";

const parent = "aaaaaaaa-1111-4111-8111-111111111111";
let roots: string[] = [];

function objectPayload(event: unknown): Record<string, unknown> {
  return (event as { payload: Record<string, unknown> }).payload;
}

async function fixture(id: string, overrides: Record<string, unknown> = {}, events = '{"type":"text"}\n') {
  const root = await mkdtemp(path.join(tmpdir(), "phren-fanouts-")); roots.push(root);
  const directory = path.join(root, ".runtime/agent-fanouts", id); await mkdir(directory, { recursive: true });
  await writeFile(path.join(directory, "events.jsonl"), events);
  await writeFile(path.join(directory, "manifest.json"), JSON.stringify({
    schemaVersion: 1, id, parent: { provider: "codex", session: parent }, provider: "opencode",
    taskLabel: "Review bridge", cwd: "/repo", worktree: "/repo-wt", model: "openrouter/deepseek/deepseek-v4.1-flash",
    eventLog: "events.jsonl", createdAt: "2026-09-19T19:00:00.000Z", startedAt: "2026-09-19T19:00:01.000Z",
    updatedAt: "2026-09-19T19:00:02.000Z", status: "running", ...overrides,
  }));
  return { root, directory, env: { PHREN_PATH: root } };
}

/** A Codex CLI fan-out manifest; `session` is the optional Codex thread UUID. */
function codexFixture(id: string, session?: string, overrides: Record<string, unknown> = {}) {
  return fixture(id, { provider: "codex", model: "gpt-5-codex", ...(session ? { session } : {}), ...overrides },
    '{"type":"thread.started","thread_id":"cccccccc-3333-4333-8333-333333333333"}\n');
}

afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });

describe("fan-out manifests", () => {
  it("returns only jobs bound to the validated parent and hides local metadata", async () => {
    const { env } = await fixture("job-1");
    const found = await fanoutChildren("codex", parent, env);
    expect(found).toHaveLength(1);
    expect(found[0]).toMatchObject({ provider: "opencode", path: "Review bridge", state: "running", children: [] });
    expect(found[0].id).toMatch(/^[a-f0-9]{32}$/);
    expect(found[0].cwd).toBe("/repo-wt");
    expect(JSON.stringify({ ...found[0], transcript: undefined, session: undefined, cwd: undefined })).not.toContain("/repo");
    expect(await fanoutChildren("codex", "bbbbbbbb-2222-4222-8222-222222222222", env)).toEqual([]);
  });

  it("rejects event-log symlinks and mismatched directory IDs", async () => {
    const first = await fixture("job-link");
    const outside = path.join(first.root, "outside.jsonl"); await writeFile(outside, "secret");
    await rm(path.join(first.directory, "events.jsonl")); await symlink(outside, path.join(first.directory, "events.jsonl"));
    expect(await fanoutChildren("codex", parent, first.env)).toEqual([]);
    const second = await fixture("job-name", { id: "different" });
    expect(await fanoutChildren("codex", parent, second.env)).toEqual([]);
  });

  it("returns Codex fan-outs and enforces provider-matching sessions", async () => {
    const thread = "cccccccc-3333-4333-8333-333333333333";
    const bound = await codexFixture("job-codex", thread);
    const found = await fanoutChildren("codex", parent, bound.env);
    expect(found).toHaveLength(1);
    expect(found[0]).toMatchObject({ provider: "codex", session: thread, path: "Review bridge", state: "running", model: "gpt-5-codex" });

    const mismatched = await codexFixture("job-codex-bad", "ses_abc");
    expect(await fanoutChildren("codex", parent, mismatched.env)).toEqual([]);

    const crossProvider = await fixture("job-open-bad", { session: thread });
    expect(await fanoutChildren("codex", parent, crossProvider.env)).toEqual([]);
  });

  it("redacts OpenCode reasoning, arguments, outputs, costs, and snapshots", () => {
    const secret = "sk-secret";
    expect(visibleOpenCodeRunEvent({ type: "text", timestamp: 1_789_845_268_396, part: { type: "text", text: "Visible", reasoning: secret } }))
      .toMatchObject({ type: "assistant/message", data: { message: { content: [{ text: "Visible" }] } } });
    const tool = visibleOpenCodeRunEvent({ type: "tool_use", part: { type: "tool", tool: "bash", callID: "call-1",
      state: { status: "completed", input: { token: secret }, output: secret }, snapshot: secret } });
    expect(tool).toMatchObject({ data: { message: { content: [{ name: "bash", input: {}, phrenStatus: "completed" }] } } });
    expect(JSON.stringify(tool)).not.toContain(secret);
    expect(visibleOpenCodeRunEvent({ type: "step_start", part: { reasoning: secret } })).toBeUndefined();
  });

  it("exports Codex exec commands, output tails, and changed paths", () => {
    const home = homedir(), homePath = path.join(home, ".ssh", "id_rsa");
    const command = "cat ~/.ssh/id_rsa";
    const translated = [
      { type: "item.completed", item: { id: "item_0", type: "agent_message", text: "Visible" } },
      { type: "item.started", item: { id: "item_1", type: "command_execution", command, status: "in_progress" } },
      { type: "item.completed", item: { id: "item_1", type: "command_execution", command, aggregated_output: "some output", exit_code: 0, status: "completed" } },
      { type: "item.started", item: { id: "item_9", type: "file_change", changes: [{ path: homePath, kind: "update" }], status: "in_progress" } },
      { type: "item.completed", item: { id: "item_9", type: "file_change", changes: [{ path: homePath, kind: "update" }], status: "completed" } },
      { type: "turn.completed", usage: { input_tokens: 1, output_tokens: 2 } },
      { type: "error", message: "boom" },
    ].map(visibleCodexExecEvent);
    expect(translated[0]).toMatchObject({ type: "response_item", payload: { type: "message", role: "assistant", content: [{ type: "output_text", text: "Visible" }] } });
    expect(translated[1]).toMatchObject({ type: "response_item", payload: { type: "function_call", name: "shell", call_id: "item_1", arguments: JSON.stringify({ command }) } });
    expect(translated[2]).toMatchObject({ type: "response_item", payload: { type: "function_call_output", call_id: "item_1", output: "some output\n[exit 0]" } });
    expect(translated[3]).toMatchObject({ type: "response_item", payload: { type: "function_call", name: "apply_patch", call_id: "item_9",
      arguments: JSON.stringify({ files: [{ path: `~${path.sep}.ssh${path.sep}id_rsa`, kind: "update" }] }) } });
    expect(translated[4]).toMatchObject({ type: "response_item", payload: { type: "function_call_output", call_id: "item_9",
      output: `1 file(s) changed\n~${path.sep}.ssh${path.sep}id_rsa` } });
    expect(translated[5]).toMatchObject({ type: "event_msg", payload: { type: "task_complete" } });
    expect(translated[6]).toMatchObject({ type: "event_msg", payload: { type: "error", message: "boom" } });

    const oversizeCommand = "x".repeat(3_000);
    const commandCall = visibleCodexExecEvent({ type: "item.started", item: { id: "long", type: "command_execution", command: oversizeCommand } });
    const parsedArguments = JSON.parse(String(objectPayload(commandCall).arguments));
    expect(parsedArguments.command).toHaveLength(2_000);
    expect(parsedArguments.command).toBe(oversizeCommand.slice(0, 2_000));

    const oversizeOutput = "0123456789".repeat(500);
    const outputRow = visibleCodexExecEvent({ type: "item.completed", item: { id: "long", type: "command_execution", aggregated_output: oversizeOutput } });
    const output = String(objectPayload(outputRow).output);
    expect(output).toBe(`${oversizeOutput.slice(-4_000)}\n[finished]`);
    expect(output.startsWith(oversizeOutput.slice(-4_000))).toBe(true);
    expect(output).toContain(oversizeOutput.slice(-1));

    const many = Array.from({ length: 60 }, (_, index) => ({ path: path.join(home, `file-${index}.ts`), kind: "add" }));
    const patchStart = visibleCodexExecEvent({ type: "item.started", item: { id: "many", type: "file_change", changes: many } });
    const files = JSON.parse(String(objectPayload(patchStart).arguments)).files;
    expect(files).toHaveLength(50);
    expect(files[0]).toEqual({ path: `~${path.sep}file-0.ts`, kind: "add" });
    const patchDone = visibleCodexExecEvent({ type: "item.completed", item: { id: "many", type: "file_change", changes: many } });
    const patchOutput = String(objectPayload(patchDone).output);
    expect(patchOutput.split("\n")).toHaveLength(51);
    expect(patchOutput.startsWith("50 file(s) changed\n")).toBe(true);
    expect(patchOutput).toContain(`~${path.sep}file-49.ts`);
    expect(patchOutput).not.toContain("file-50.ts");
  });

  it("ignores private or unknown Codex exec rows", () => {
    expect(visibleCodexExecEvent({ type: "thread.started", thread_id: "cccccccc-3333-4333-8333-333333333333" })).toBeUndefined();
    expect(visibleCodexExecEvent({ type: "turn.started" })).toBeUndefined();
    expect(visibleCodexExecEvent({ type: "item.started", item: { id: "item_0", type: "agent_message", text: "partial" } })).toBeUndefined();
    expect(visibleCodexExecEvent({ type: "item.started", item: { id: "item_5", type: "reasoning" } })).toBeUndefined();
    expect(visibleCodexExecEvent({ type: "made.up" })).toBeUndefined();
    expect(visibleCodexExecEvent({ type: "item.completed", item: { id: "item_2", type: "command_execution", exit_code: null } }))
      .toMatchObject({ type: "response_item", payload: { type: "function_call_output", call_id: "item_2", output: "\n[finished]" } });
  });
});
