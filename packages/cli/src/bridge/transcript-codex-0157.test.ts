import { describe, expect, it } from "vitest";
import { readFileSync, writeFileSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { historicalImage, TranscriptReader } from "./transcripts.js";

// A Codex 0.157.1 rollout written by its app-server daemon, reduced to one or
// two rows of each kind with neutral text. Beside the rows older readers knew,
// it adds `ordinal`, `world_state`, `token_usage_record` and `item_completed`
// rows that repeat the messages and calls.
const fixture = path.join(path.dirname(fileURLToPath(import.meta.url)), "fixtures", "codex", "0.157.1", "rollout.jsonl");

it("reads a Codex 0.157.1 rollout's messages and tool calls once each", async () => {
  const { entries } = await new TranscriptReader(fixture, "codex").read();
  const rows = entries.map(entry => { const p = (entry.raw as { type: string; payload: Record<string, unknown> }); return [p.type, p.payload.type, p.payload.role ?? p.payload.name].filter(Boolean).join(":"); });
  expect(rows.filter(row => row.startsWith("response_item:message"))).toEqual(["response_item:message:user", "response_item:message:user", "response_item:message:assistant", "response_item:message:assistant"]);
  expect(rows).toContain("response_item:custom_tool_call:exec");
  expect(rows).toContain("response_item:custom_tool_call_output");
  expect(rows).toContain("response_item:function_call:wait");
  expect(rows).toContain("response_item:function_call_output");
  expect(rows).toContain("event_msg:turn_aborted");
  // The new bookkeeping rows and the item_completed copies stay on the computer.
  expect(rows.some(row => /^(session_meta|world_state|token_usage_record)|item_completed|developer/.test(row))).toBe(false);
});

// Codex 0.157.1 code mode: each action a script runs is recorded as its own
// item_completed row, and the `exec` script around them only repeats them.
// Neutral text, fake paths and ids; one row of each item and script outcome.
const codeMode = path.join(path.dirname(fileURLToPath(import.meta.url)), "fixtures", "codex", "0.157.1", "code-mode.rollout.jsonl");
type Raw = { type: string; payload: Record<string, any> };
const describeRow = (raw: Raw) => [raw.type, raw.payload.type, raw.payload.role ?? raw.payload.name].filter(Boolean).join(":");
const payloads = (entries: { line: number; raw: unknown }[], line: number) => entries.filter(entry => entry.line === line).map(entry => (entry.raw as Raw).payload);

describe("Codex 0.157.1 code-mode items", () => {
  it("lists each recorded action as the call the phone draws, in rollout order", async () => {
    const { entries } = await new TranscriptReader(codeMode, "codex").read();
    expect(entries.map(entry => `${entry.line} ${describeRow(entry.raw as Raw)}`)).toEqual([
      "1 turn_context",
      "2 response_item:message:user",
      "7 response_item:message:assistant",
      "10 response_item:function_call:exec_command", "10 response_item:function_call_output",
      "11 response_item:function_call:exec_command", "11 response_item:function_call_output",
      "13 event_msg:token_count",
      "15 response_item:custom_tool_call:apply_patch", "15 response_item:custom_tool_call_output",
      "18 response_item:function_call:mcp__phren__get_tasks", "18 response_item:function_call_output",
      "20 response_item:function_call:view_image",
      "22 response_item:custom_tool_call_output",
      "26 response_item:custom_tool_call:exec", "26 response_item:custom_tool_call_output",
      "27 response_item:custom_tool_call:exec",
      "28 response_item:custom_tool_call_output",
      "31 response_item:function_call:wait", "32 response_item:function_call_output",
      "33 event_msg:task_complete",
    ]);
    const text = JSON.stringify(entries);
    // Reasoning never leaves the computer; the covered scripts' status results
    // and the carrier field stay out of the page.
    expect(text).not.toContain("private");
    expect(JSON.stringify(entries.filter(entry => entry.line !== 28))).not.toMatch(/Script (completed|running)/);
    expect(text).not.toContain("phren_item_output");
  });

  it("draws a command as exec_command with its directory, output and exit code", async () => {
    const { entries } = await new TranscriptReader(codeMode, "codex").read();
    const [call, result] = payloads(entries, 10), [failed, failure] = payloads(entries, 11);
    expect(call).toMatchObject({ type: "function_call", name: "exec_command", call_id: "exec-0001" });
    expect(JSON.parse(call.arguments)).toEqual({ cmd: "git status --short", workdir: "/work/app" });
    expect(result).toMatchObject({ type: "function_call_output", call_id: "exec-0001" });
    expect(JSON.parse(result.output)).toEqual({ output: " M src/label.ts\n", exit_code: 0 });
    expect(JSON.parse(failed.arguments).cmd).toBe("npm test");
    expect(JSON.parse(failure.output)).toEqual({ output: "1 failing\n", exit_code: 1 });
  });

  it("draws a file change as an apply_patch patch covering every file", async () => {
    const { entries } = await new TranscriptReader(codeMode, "codex").read();
    const [call, result] = payloads(entries, 15);
    expect(call).toMatchObject({ type: "custom_tool_call", name: "apply_patch", call_id: "exec-0003" });
    expect(call.input).toBe([
      "*** Begin Patch",
      "*** Update File: /work/app/src/label.ts", "@@ -1,2 +1,2 @@", " export const a = 1;", '-export const label = "old";', '+export const label = "new";',
      "*** Add File: /work/app/src/extra.ts", "+export const extra = 2;",
      "*** Delete File: /work/app/src/unused.ts",
      "*** Update File: /work/app/src/before.ts", "*** Move to: /work/app/src/after.ts", "@@ -1 +1 @@", "-x", "+y",
      "*** End Patch",
    ].join("\n"));
    expect(result).toMatchObject({ type: "custom_tool_call_output", call_id: "exec-0003", output: "Success. Updated the following files:\nM /work/app/src/label.ts\n" });
  });

  it("draws an MCP call under its mcp__server__tool name with its text result", async () => {
    const { entries } = await new TranscriptReader(codeMode, "codex").read();
    const [call, result] = payloads(entries, 18);
    expect(call).toMatchObject({ name: "mcp__phren__get_tasks", call_id: "exec-0004" });
    expect(JSON.parse(call.arguments)).toEqual({ project: "demo" });
    expect(result).toMatchObject({ call_id: "exec-0004", output: '{"ok":true,"message":"2 tasks"}' });
  });

  it("pairs a viewed image's picture with a view_image call and serves its bytes", async () => {
    const { entries } = await new TranscriptReader(codeMode, "codex").read();
    const [call] = payloads(entries, 20), [result] = payloads(entries, 22);
    expect(call).toMatchObject({ type: "function_call", name: "view_image", call_id: "call_image" });
    expect(JSON.parse(call.arguments)).toEqual({ path: "/tmp/shot.png" });
    // Only the picture, as a reference; its bytes come from the image route.
    expect(result).toMatchObject({ call_id: "call_image", output: [{ type: "input_image" }] });
    const bytes = await historicalImage(codeMode, 22, 0, "codex");
    expect(bytes.subarray(1, 4).toString()).toBe("PNG");
  });

  it("finds a result's script when the script is outside the rows read", async () => {
    const { entries } = await new TranscriptReader(codeMode, "codex").readAfter(21);
    const lines = entries.map(entry => `${entry.line} ${describeRow(entry.raw as Raw)}`);
    expect(lines[0]).toBe("22 response_item:custom_tool_call_output");
    expect((entries[0].raw as Raw).payload.output).toEqual([{ type: "input_image" }]);
    expect(lines.some(line => line.startsWith("24 "))).toBe(false);
  });

  it("keeps a failed script with its error, and a script items do not cover", async () => {
    const { entries } = await new TranscriptReader(codeMode, "codex").read();
    const [call, result] = payloads(entries, 26);
    expect(call).toMatchObject({ type: "custom_tool_call", name: "exec", call_id: "call_broken" });
    expect(result).toMatchObject({ type: "custom_tool_call_output", call_id: "call_broken" });
    expect(JSON.stringify(result.output)).toContain("Script error");
    expect(payloads(entries, 27)[0].input).toContain("ALL_TOOLS");
    expect(payloads(entries, 28)[0].call_id).toBe("call_list");
  });

  it("produces the backlog frame the phone's conformance fixture holds", async () => {
    const reader = new TranscriptReader(codeMode, "codex");
    let page = await reader.read();
    const entries = [...page.entries];
    while (page.hasMore) { page = await reader.read(page.startLine); entries.unshift(...page.entries); }
    const frame = { ...page, entries, hasMore: false, type: "backlog", source: "codex", session: "01a0aaaa-0000-7000-8000-000000000001" };
    const phoneFixture = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../fixtures/conformance/codex-0.157.1-backlog.json");
    if (process.env.PHREN_UPDATE_FIXTURES === "1") writeFileSync(phoneFixture, `${JSON.stringify(frame, null, 1)}\n`);
    expect(frame).toEqual(JSON.parse(readFileSync(phoneFixture, "utf8")));
  });

  it("caps a command's output to its tail", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "phren-codex-items-")), file = path.join(root, "rollout.jsonl");
    try {
      const long = "x".repeat(10_000) + "END";
      await writeFile(file, JSON.stringify({ ordinal: 0, type: "event_msg", payload: { type: "item_completed", item: {
        type: "CommandExecution", id: "exec-9", command: ["bash", "-c", "yes"], cwd: "file:///work", status: "completed",
        aggregated_output: long, stdout: long, stderr: "", exit_code: 0 } } }) + "\n");
      const { entries } = await new TranscriptReader(file, "codex").read();
      const [call, result] = payloads(entries, 0);
      expect(JSON.parse(call.arguments)).toEqual({ cmd: "yes", workdir: "/work" });
      const output = JSON.parse(result.output).output as string;
      expect(output).toHaveLength(4_000);
      expect(output.endsWith("END")).toBe(true);
    } finally { await rm(root, { recursive: true, force: true }); }
  });
});
