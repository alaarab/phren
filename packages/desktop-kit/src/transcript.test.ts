import { renderKey } from "./message.js";
import { describe, expect, it } from "vitest";
import { type ChatSource, TooManyMessagesError, copilotThought, parseLocalCommand, readTranscriptFrame } from "./transcript.js";
import { AgentChatHistory } from "./history.js";

function frame(rows: unknown[], source: ChatSource, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return { type: "backlog", source, entries: rows.map((raw, line) => ({ line, raw })), hasMore: true, totalLines: rows.length, ...extra };
}
function read(data: unknown, source: ChatSource, options?: { sidechain?: boolean; session?: string }) {
  return readTranscriptFrame(data, source, options);
}

describe("AgentChatTests", () => {
  it("child transcript reads sidechain rows and refuses another conversation", () => {
    const child = "c".repeat(32);
    const rows = [
      { line: 0, raw: { type: "user", isSidechain: true, agentId: "abc", message: { role: "user", content: "Inspect the scripts" } } },
      { line: 1, raw: { type: "assistant", isSidechain: true, agentId: "abc", message: { role: "assistant", content: [{ type: "text", text: "Review complete" }] } } },
    ];
    const value = { type: "backlog", source: "claude", session: child, entries: rows, startLine: 0, totalLines: 2, hasMore: false };
    expect(read(value, "claude").messages.length).toBe(0);
    const transcript = read(value, "claude", { sidechain: true, session: child });
    expect(transcript.messages.map(m => m.text)).toEqual(["Inspect the scripts", "Review complete"]);
    expect(transcript.messages.map(m => m.role)).toEqual(["user", "assistant"]);
    expect(() => read(value, "claude", { sidechain: true, session: "d".repeat(32) })).toThrow();
  });

  it("single oversized Claude row is rejected before replacing history", () => {
    const blocks = Array.from({ length: 65_000 }, () => ({ type: "text", text: "x" }));
    const oversized = frame([{ type: "assistant", message: { role: "assistant", content: blocks } }], "claude");
    expect(JSON.stringify(oversized).length).toBeLessThan(2 * 1_024 * 1_024);
    const history = new AgentChatHistory();
    const recent = read(frame([{ type: "assistant", message: { role: "assistant", content: "Keep this conversation" } }], "claude"), "claude");
    history.receive(recent);
    expect(() => history.receive(read(oversized, "claude"))).toThrow(TooManyMessagesError);
    expect(history.messages).toEqual(recent.messages);
  });

  it("Claude message budget covers mixed blocks across rows", () => {
    const blocks: unknown[] = Array.from({ length: 3_997 }, () => ({ type: "text", text: "x" }));
    blocks.push({ type: "thinking", thinking: "Hidden" }, { type: "text", text: "" },
      { type: "image" }, { type: "tool_use", name: "Read", id: "read-1", input: {} });
    const first = { type: "assistant", message: { role: "assistant", content: blocks } };
    const last = { type: "user", message: { role: "user", content: [{ type: "tool_result", tool_use_id: "read-1", content: "Result" }] } };
    const accepted = read(frame([first, last], "claude"), "claude");
    expect(accepted.messages.length).toBe(4_000);
    expect(accepted.messages[accepted.messages.length - 1].text).toBe("Result");
    expect(() => read(frame([first, last, last], "claude"), "claude")).toThrow(TooManyMessagesError);
    const plain = { type: "assistant", message: { role: "assistant", content: "One more" } };
    expect(() => read(frame([first, last, plain], "claude"), "claude")).toThrow();
  });

  it("empty Claude blocks do not consume visible message budget", () => {
    const blocks = Array.from({ length: 65_000 }, () => ({ type: "text", text: "" }));
    blocks.push({ type: "text", text: "Visible message" });
    const value = read(frame([{ type: "assistant", message: { role: "assistant", content: blocks } }], "claude"), "claude");
    expect(value.messages.map(m => m.text)).toEqual(["Visible message"]);
    expect(value.messages[0].id).toBe("0:65000");
  });

  it("Codex messages and tools exclude system and encrypted reasoning", () => {
    const item = (payload: unknown) => ({ type: "response_item", payload });
    const rows = [
      item({ type: "message", role: "system", content: [{ type: "text", text: "private setup" }] }),
      item({ type: "reasoning", encrypted_content: "private reasoning" }),
      item({ type: "message", role: "user", content: [{ type: "input_text", text: "Fix the screen" }] }),
      item({ type: "custom_tool_call", name: "apply_patch", input: "Edit the view" }),
      item({ type: "custom_tool_call_output", output: "Applied" }),
      { type: "event_msg", payload: { type: "agent_message", message: "Done" } },
      item({ type: "message", role: "assistant", content: [{ type: "output_text", text: "Done" }] }),
    ];
    const transcript = read(frame(rows, "codex"), "codex");
    expect(transcript.messages.map(m => m.role)).toEqual(["user", "tool", "tool", "assistant"]);
    expect(transcript.messages.map(m => m.text)).toEqual(["Fix the screen", "Edit the view", "Applied", "Done"]);
    expect(transcript.hasMore).toBe(true);
    expect(() => read(frame(rows, "codex"), "claude")).toThrow();
  });

  it("images inside tool results are addressable", () => {
    const claude = [
      { type: "assistant", message: { role: "assistant", content: [{ type: "tool_use", id: "t1", name: "Read", input: { file_path: "/x.png" } }] } },
      { type: "user", message: { role: "user", content: [{ type: "text", text: "ok" },
        { type: "tool_result", tool_use_id: "t1", content: [{ type: "text", text: "here" }, { type: "image" }] }] } },
    ];
    const result = read(frame(claude, "claude"), "claude").messages.find(m => m.isToolResult)!;
    expect(result.resultImages).toEqual([{ block: 1, inner: 1 }]);
    const codex = [{ type: "response_item", payload: { type: "function_call_output", call_id: "c1",
      output: [{ type: "input_image", image_url: "data:image/png;base64," }] } }];
    expect(read(frame(codex, "codex"), "codex").messages[0].resultImages).toEqual([{ block: 0, inner: null }]);
  });

  it("shell changes attached by the Hook become patch parts under their call", () => {
    const patch = "diff --git a/src/a.ts b/src/a.ts\nindex 1..2 100644\n--- a/src/a.ts\n+++ b/src/a.ts\n@@ -1 +1 @@\n-const a = 1;\n+const a = 2;\n";
    const rows = [
      { type: "response_item", payload: { type: "function_call", name: "exec_command", call_id: "c1", arguments: "{\"cmd\":\"sed -i s/1/2/ src/a.ts\"}" } },
      { type: "response_item", payload: { type: "function_call_output", call_id: "c1", output: "" },
        phren_changes: { c1: [
          { root: "/work/app", path: "src/a.ts", status: "M", added: 1, removed: 1, patch },
          { root: "/work/app", path: "src/b.ts", status: "A", added: 1, removed: 0, patch: "diff --git a/src/b.ts b/src/b.ts\nnew file mode 100644\n--- /dev/null\n+++ b/src/b.ts\n@@ -0,0 +1 @@\n+export {};\n" },
          { root: "/work/app", path: "", status: "M", patch: "ignored" }] } },
      { type: "response_item", payload: { type: "function_call_output", call_id: "c2", output: "other" },
        phren_changes: { c1: [{ path: "x", patch: "@@\n+y" }] } },
    ];
    const messages = read(frame(rows, "codex"), "codex").messages;
    expect(messages.map(m => m.title)).toEqual(["exec_command", "Tool result", "Changes", "Changes", "Tool result"]);
    expect(messages.map(m => m.isChange)).toEqual([false, false, true, true, false]);
    expect(messages[2].text).toBe("*** Update File: src/a.ts\n@@ -1 +1 @@\n-const a = 1;\n+const a = 2;\n");
    expect(messages[3].text).toBe("*** Add File: src/b.ts\n@@ -0,0 +1 @@\n+export {};\n");
    expect(messages[2].toolCallID).toBe("c1");
    expect(new Set(messages.map(m => m.id)).size).toBe(5);
  });

  it("Claude blocks separate visible text tool calls and results", () => {
    const rows = [
      { type: "user", message: { role: "user", content: "Review this" } },
      { type: "assistant", message: { role: "assistant", content: [{ type: "thinking", thinking: "hidden" },
        { type: "text", text: "Checking" }, { type: "tool_use", name: "Read", input: { path: "app.swift" } }] } },
      { type: "user", message: { role: "user", content: [{ type: "tool_result", content: [{ type: "text", text: "File contents" }] }] } },
      { type: "user", isMeta: true, message: { role: "user", content: "hook metadata" } },
    ];
    const value = read(frame(rows, "claude"), "claude");
    expect(value.messages.map(m => m.role)).toEqual(["user", "assistant", "tool", "tool"]);
    expect(value.messages[value.messages.length - 1].text).toBe("File contents");
    expect(value.messages.some(m => m.text.includes("hidden") || m.text.includes("metadata"))).toBe(false);
  });

  it("tool IDs and empty results survive all provider parsers", () => {
    const sources: [ChatSource, unknown[]][] = [
      ["codex", [
        { type: "response_item", payload: { type: "function_call", name: "test", arguments: "", call_id: "c1" } },
        { type: "response_item", payload: { type: "function_call_output", output: "", call_id: "c1" } }]],
      ["claude", [
        { message: { role: "assistant", content: [{ type: "tool_use", name: "test", id: "c1", input: {} }] } },
        { message: { role: "user", content: [{ type: "tool_result", tool_use_id: "c1", content: [] }] } }]],
      ["copilot", [
        { type: "tool.execution_start", data: { toolName: "test", toolCallId: "c1", arguments: {} } },
        { type: "tool.execution_complete", data: { toolCallId: "c1", result: { content: "" } } }]],
    ];
    for (const [source, rows] of sources) {
      const messages = read(frame(rows, source), source).messages;
      expect(messages.map(m => m.toolCallID), source).toEqual(["c1", "c1"]);
      expect(messages.map(m => m.isToolResult), source).toEqual([false, true]);
    }
    const oversized = [{ type: "response_item", payload: { type: "function_call_output", output: "Result remains readable", call_id: "x".repeat(513) } }];
    const message = read(frame(oversized, "codex"), "codex").messages[0];
    expect(message.text).toBe("Result remains readable");
    expect(message.toolCallID).toBeNull();
  });

  it("Claude compaction collapses to a single bounded part", () => {
    const rows = [
      { type: "system", phrenCompacted: true, timestamp: "2026-09-12T01:00:00Z" },
      { type: "user", isCompactSummary: true, timestamp: "2026-09-12T01:00:00Z", message: { role: "user", content: "s".repeat(6_000) } },
    ];
    const transcript = read(frame(rows, "claude"), "claude");
    expect(transcript.messages.length).toBe(1);
    const message = transcript.messages[0];
    expect(message.isCompaction).toBe(true);
    expect(message.text.length).toBe(4_000);
    expect(transcript.messages.some(m => m.role === "user")).toBe(false);

    const legacy = "This session is being continued from a previous conversation that ran out of context. " + "t".repeat(5_000);
    const legacyTranscript = read(frame([{ type: "user", message: { role: "user", content: legacy } }], "claude"), "claude");
    expect(legacyTranscript.messages.length).toBe(1);
    expect(legacyTranscript.messages[0].isCompaction).toBe(true);
    expect(legacyTranscript.messages[0].text.length).toBe(4_000);
    expect(legacyTranscript.messages.some(m => m.role === "user")).toBe(false);
  });
});

describe("LocalCommandTests", () => {
  const localCommand = (text: string, role: "user" | "assistant" = "user") => (role === "user" ? parseLocalCommand(text) : null);

  it("slash command reads name and arguments", () => {
    const command = localCommand("<command-name>/model</command-name>\n            <command-message>model</command-message>\n            <command-args></command-args>");
    expect(command?.kind).toBe("command");
    expect(command?.text).toBe("/model");
    expect(localCommand("<command-name>/review</command-name><command-message>review</command-message><command-args>ultra 12</command-args>")?.text).toBe("/review ultra 12");
  });

  it("shell line and output", () => {
    expect(localCommand("<bash-input>pwd</bash-input>")).toEqual({ kind: "shell", text: "pwd" });
    const output = localCommand("<bash-stdout>/home/sam/Projects/hub</bash-stdout><bash-stderr></bash-stderr>");
    expect(output?.kind).toBe("output");
    expect(output?.text).toBe("/home/sam/Projects/hub");
    expect(localCommand("<bash-stdout></bash-stdout><bash-stderr></bash-stderr>")?.text).toBe("");
    expect(localCommand("<local-command-stdout>Set model to Opus 5</local-command-stdout>")).toEqual({ kind: "output", text: "Set model to Opus 5" });
  });

  it("ordinary messages are not commands", () => {
    expect(localCommand("Say \"go\" and I'll cut v0.11.27")).toBeNull();
    expect(localCommand("look at <command-name> in the docs")).toBeNull();
    expect(localCommand("<bash-input>pwd</bash-input>", "assistant")).toBeNull();
  });
});

describe("MergedUserTurnTests", () => {
  const readEntries = (entries: unknown[]) => readTranscriptFrame({ type: "backlog", source: "claude", entries }, "claude");
  const user = (content: unknown) => ({ type: "user", message: { role: "user", content } });
  const image = { type: "image", source: { type: "base64", data: "" } };

  it("text and image blocks of one turn become one bubble", () => {
    const raw = user([{ type: "text", text: "[Image #3]Look at this\n\nAttached files on this computer:\n/tmp/shot.png" }, image, image]);
    const transcript = readEntries([{ line: 4, raw }]);
    expect(transcript.messages.length).toBe(1);
    const message = transcript.messages[0];
    expect(message.id).toBe("4:0");
    expect(message.role).toBe("user");
    expect(message.imageBlocks).toEqual([1, 2]);
    expect(message.text.startsWith("[Image #3]Look at this")).toBe(true);
  });

  it("image only turn keeps its placeholder", () => {
    const message = readEntries([{ line: 1, raw: user([image, image]) }]).messages[0];
    expect(message.text).toBe("[Image attachment]");
    expect(message.imageBlocks).toEqual([0, 1]);
  });

  it("upload marker becomes an upload image and leaves the text", () => {
    const path = "/Users/x/.local/share/phren/bridge/uploads/aaaa-1111/0f0f-phren-1a1a.png";
    const raw = user([{ type: "text", text: `[Image: source: ${path}]` }, { type: "text", text: "Why does this header wrap?" }]);
    const transcript = readEntries([{ line: 6, raw }]);
    expect(transcript.messages.length).toBe(1);
    const message = transcript.messages[0];
    expect(message.id).toBe("6:0");
    expect(message.uploadImages).toEqual([path]);
    expect(message.text).toBe("Why does this header wrap?");
    expect(message.imageBlocks).toEqual([]);
    const plain = readEntries([{ line: 6, raw: user("Why does this header wrap?") }]).messages[0];
    expect(renderKey(plain)).not.toBe(renderKey(message));
    expect(plain).not.toEqual(message);
  });

  it("three upload markers in one text become three pictures", () => {
    const text = "Look at these [Image: source: /work/phone/uploads/a.png] [Image: source: /work/phone/uploads/b.JPEG]\n[Image: source: /work/phone/uploads/c.webp]";
    const message = readEntries([{ line: 2, raw: user(text) }]).messages[0];
    expect(message.uploadImages).toEqual(["/work/phone/uploads/a.png", "/work/phone/uploads/b.JPEG", "/work/phone/uploads/c.webp"]);
    expect(message.text).toBe("Look at these");
    const only = readEntries([{ line: 3, raw: user([
      { type: "text", text: "[Image: source: /work/phone/uploads/a.png]" }, { type: "text", text: "[Image: source: /work/phone/uploads/b.png]" }]) }]).messages[0];
    expect(only.text).toBe("[Image attachment]");
    expect(only.uploadImages.length).toBe(2);
    const many = Array.from({ length: 12 }, (_, i) => `[Image: source: /work/phone/uploads/${i}.png]`).join(" ");
    expect(readEntries([{ line: 4, raw: user(many) }]).messages[0].uploadImages.length).toBe(8);
  });

  it("upload marker naming something other than an image is left alone", () => {
    const text = "[Image: source: /work/phone/uploads/notes.pdf] see the notes [Image: source: relative/shot.png] and [Image: source: /work/phone/uploads/shot.png]";
    const message = readEntries([{ line: 5, raw: user(text) }]).messages[0];
    expect(message.uploadImages).toEqual(["/work/phone/uploads/shot.png"]);
    expect(message.text).toBe("[Image: source: /work/phone/uploads/notes.pdf] see the notes [Image: source: relative/shot.png] and");
    const none = readEntries([{ line: 7, raw: user("[Image: source: /work/phone/uploads/notes.pdf] read this") }]).messages[0];
    expect(none.uploadImages).toEqual([]);
    expect(none.text).toBe("[Image: source: /work/phone/uploads/notes.pdf] read this");
    const reply = readEntries([{ line: 8, raw: { type: "assistant", message: { role: "assistant", content: "I saw [Image: source: /work/phone/uploads/shot.png]" } } }]).messages[0];
    expect(reply.uploadImages).toEqual([]);
  });

  it("tool results in the same row stay apart", () => {
    const raw = user([{ type: "tool_result", tool_use_id: "t1", content: "done" }, { type: "text", text: "and now this" }]);
    expect(readEntries([{ line: 1, raw }]).messages.map(m => m.role)).toEqual(["tool", "user"]);
  });

  it("harness preamble turns are not bubbles", () => {
    const codexUser = (text: string) => ({ type: "response_item", payload: { type: "message", role: "user", content: [{ type: "input_text", text }] } });
    const codex = { type: "backlog", source: "codex", entries: [
      { line: 0, raw: codexUser("<environment_context>\n  <cwd>/home/a/p</cwd>\n</environment_context>") },
      { line: 1, raw: codexUser("Fix the header") },
    ] };
    expect(readTranscriptFrame(codex, "codex").messages.map(m => m.text)).toEqual(["Fix the header"]);
    const claude = { type: "backlog", source: "claude", entries: [
      { line: 0, raw: user("<system-reminder>internal</system-reminder>") },
      { line: 1, raw: user("hello") },
    ] };
    expect(readTranscriptFrame(claude, "claude").messages.map(m => m.text)).toEqual(["hello"]);
  });
});

describe("CopilotChatTests", () => {
  const readCopilot = (rows: unknown[]) => readTranscriptFrame({
    type: "backlog", source: "copilot", entries: rows.map((raw, line) => ({ line, raw })), totalLines: rows.length,
  }, "copilot");

  it("visible events exclude private and background content", () => {
    const value = readCopilot([
      { type: "session.start", data: { systemMessage: "private system" } },
      { type: "user.message", data: { content: "Review this", transformedContent: "private augmentation" } },
      { type: "assistant.message", data: { content: "Checking", reasoningText: "Shown summary", encryptedContent: "secret", reasoningOpaque: "private opaque", reasoningBlocks: ["hidden"] } },
      { type: "assistant.message", agentId: "child", data: { content: "background" } },
      { type: "user.message", data: { source: "skill-secret", content: "hidden skill" } },
      { type: "tool.execution_start", data: { toolName: "view", arguments: { path: "app.swift" } } },
      { type: "tool.execution_complete", data: { result: { content: "Visible file content" } } },
      { type: "assistant.message_delta", ephemeral: true, data: { deltaContent: "duplicate" } },
    ]);
    expect(value.messages.map(m => m.role)).toEqual(["user", "assistant", "assistant", "tool", "tool"]);
    expect(value.messages.filter(m => m.isNarration).map(m => m.text)).toEqual(["Shown summary"]);
    expect(value.messages[value.messages.length - 1].text).toBe("Visible file content");
    const joined = value.messages.map(m => m.text).join("");
    for (const hidden of ["private", "secret", "background", "hidden skill", "duplicate"]) expect(joined.includes(hidden)).toBe(false);
  });

  it("reasoning summary is a thinking note before the reply", () => {
    const value = readCopilot([
      { type: "assistant.message", data: { content: "Done.", reasoningText: "  Checking the branch first.\n" } },
      { type: "assistant.message", data: { content: "", reasoningText: "Waiting for the audit." } },
      { type: "assistant.message", data: { content: "No thoughts here." } },
    ]);
    expect(value.messages.map(m => m.text)).toEqual(["Checking the branch first.", "Done.", "Waiting for the audit.", "No thoughts here."]);
    expect(value.messages.map(m => m.isNarration)).toEqual([true, false, true, false]);
    expect(value.messages[1].id).toBe("0:0");
    const history = new AgentChatHistory();
    history.receive(value);
    expect(history.messages.slice(0, 2).map(m => m.isNarration)).toEqual([true, false]);
  });

  it("skill body answers the call that loaded it", () => {
    const value = readCopilot([
      { type: "tool.execution_start", data: { toolName: "skill", toolCallId: "call_s", arguments: { skill: "audit" } } },
      { type: "tool.execution_complete", data: { toolCallId: "call_s", success: true, result: { content: "Skill \"audit\" loaded successfully." } } },
      { type: "skill.invoked", data: { name: "audit", content: "# Codebase audit\n\nEstablish the scope." } },
      { type: "skill.invoked", data: { name: "never-called", content: "# Stray" } },
    ]);
    expect(value.messages.map(m => m.toolCallID)).toEqual(["call_s", "call_s", "call_s"]);
    expect(value.messages[value.messages.length - 1].text).toBe("# Codebase audit\n\nEstablish the scope.");
  });

  it("mcp call is named for its server", () => {
    const value = readCopilot([
      { type: "tool.execution_start", data: { toolName: "phren-get_tasks", toolCallId: "c1", arguments: { limit: 5 }, mcpServerName: "phren", mcpToolName: "get_tasks" } },
      { type: "tool.execution_start", data: { toolName: "phren-add_task", toolCallId: "c2", arguments: { item: ["x"] } } },
    ]);
    expect(value.messages.map(m => m.title)).toEqual(["mcp__phren__get_tasks", "phren-add_task"]);
  });

  it("thought heading reads as a sentence", () => {
    expect(copilotThought("**Finalizing audit details**\n\nI need to provide a **concise** summary.")).toBe("Finalizing audit details. I need to provide a concise summary.");
    expect(copilotThought("**Done?**\nYes.")).toBe("Done? Yes.");
    expect(copilotThought("  plain  ")).toBe("plain");
  });

  it("failed tool run is marked", () => {
    const value = readCopilot([
      { type: "tool.execution_start", data: { toolName: "bash", toolCallId: "call_1", arguments: { command: "false" } } },
      { type: "tool.execution_complete", data: { toolCallId: "call_1", success: false, result: { content: "exit 1" } } },
    ]);
    expect(value.messages.map(m => m.isToolError)).toEqual([false, true]);
  });
});

describe("PhrenAgentTranscriptParityTest", () => {
  it("OpenCode transcript reads the shared event shape", () => {
    const value = readTranscriptFrame({
      type: "backlog", source: "opencode", totalLines: 2, hasMore: false,
      entries: [{ line: 1, raw: { seq: 1, time: "2026-09-12T20:01:00.000Z", type: "user/message",
        data: { source: "user", turn: 1, message: { role: "user", content: "Hello" } } } }],
    }, "opencode");
    expect(value.messages.map(m => m.text)).toEqual(["Hello"]);
  });
});
