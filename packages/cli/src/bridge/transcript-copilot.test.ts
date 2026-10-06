import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { visibleCopilotEvent } from "./transcript-copilot.js";
import { TranscriptReader } from "./transcripts.js";

const here = path.dirname(fileURLToPath(import.meta.url));
/** A real GitHub Copilot CLI 1.0.87 session (resumed from 1.0.86), sanitized:
 * same lines, event types and field names; neutral text and placeholder ids. */
const events = path.join(here, "fixtures/copilot/1.0.87/events.jsonl");
/** The backlog frame PhrenKit decodes in CopilotChatTests. */
const phoneFixture = path.resolve(here, "../../fixtures/conformance/copilot-1.0.87-backlog.json");
const session = "00000000-0000-4000-8000-000000000187";

describe("Copilot 1.0.87 transcript projection", () => {
  it("keeps the final-answer phase, tool success and the shown reasoning summary, and drops private reasoning and prompt augmentation", async () => {
    const page = await new TranscriptReader(events, "copilot").read();
    expect(page.entries).toHaveLength(60);
    const counts: Record<string, number> = {};
    for (const entry of page.entries) counts[String(entry.raw.type)] = (counts[String(entry.raw.type)] ?? 0) + 1;
    // The page's 60 entries include the two skills' bodies, so the first
    // prompt and its turn_start fall to the next page.
    expect(counts).toEqual({ "user.message": 2, "assistant.turn_start": 9, "assistant.message": 13, "assistant.turn_end": 10,
      "tool.execution_start": 12, "tool.execution_complete": 12, "skill.invoked": 2 });
    const finals = page.entries.filter(entry => (entry.raw.data as { phase?: string }).phase === "final_answer");
    expect(finals.map(entry => entry.line)).toEqual([19, 67, 126]);
    const completes = page.entries.filter(entry => entry.raw.type === "tool.execution_complete");
    expect(completes.every(entry => (entry.raw.data as { success?: boolean }).success === true)).toBe(true);
    const wire = JSON.stringify(page.entries);
    // The summary Copilot prints under "Thought for Ns" rides on its message.
    const thoughts = page.entries.filter(entry => typeof (entry.raw.data as { reasoningText?: unknown }).reasoningText === "string");
    expect(thoughts.length).toBeGreaterThan(0);
    expect(thoughts.every(entry => entry.raw.type === "assistant.message")).toBe(true);
    for (const hidden of ["reasoningOpaque", "reasoningBlocks", "encryptedContent", "transformedContent", "toolTelemetry", "interactionId"]) {
      expect(wire).not.toContain(hidden);
    }
  });

  it("produces the backlog frame the phone's fixture holds", async () => {
    // The whole session as one frame: the opening page plus every older one.
    const reader = new TranscriptReader(events, "copilot");
    let page = await reader.read();
    const entries = [...page.entries];
    while (page.hasMore) { page = await reader.read(page.startLine); entries.unshift(...page.entries); }
    const frame = { ...page, entries, hasMore: false, type: "backlog", source: "copilot", session };
    if (process.env.PHREN_UPDATE_FIXTURES === "1") writeFileSync(phoneFixture, `${JSON.stringify(frame, null, 1)}\n`);
    expect(frame).toEqual(JSON.parse(readFileSync(phoneFixture, "utf8")));
  });
});

describe("Copilot skills and MCP calls", () => {
  it("exports what a skill loaded, bounded, and nothing else of the event", () => {
    expect(visibleCopilotEvent({ type: "skill.invoked", timestamp: "t", data: { name: "audit", content: "# Codebase audit", description: "Audit a codebase",
      path: "/home/me/.copilot/skills/audit/SKILL.md", allowedTools: ["bash"], source: "personal-copilot" } }))
      .toEqual({ type: "skill.invoked", timestamp: "t", data: { name: "audit", content: "# Codebase audit", description: "Audit a codebase" } });
    expect(visibleCopilotEvent({ type: "skill.invoked", agentId: "child", data: { name: "audit", content: "x" } })).toBeUndefined();
    expect(visibleCopilotEvent({ type: "skill.invoked", data: { name: "audit" } })).toBeUndefined();
  });
  it("names the MCP server and tool of a call", () => {
    const start = visibleCopilotEvent({ type: "tool.execution_start", data: { toolName: "phren-get_tasks", toolCallId: "c1", arguments: { limit: 5 },
      mcpServerName: "phren", mcpToolName: "get_tasks", mcpTransport: "stdio", mcpConfigSource: "/home/me/.copilot/mcp-config.json" } });
    expect(start?.data).toEqual({ toolName: "phren-get_tasks", toolCallId: "c1", arguments: { limit: 5 }, mcpServerName: "phren", mcpToolName: "get_tasks" });
  });
});
