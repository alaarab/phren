import { expect, it } from "vitest";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { TranscriptReader } from "./transcripts.js";

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
