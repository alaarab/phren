// Ports of the Android kit's ChatTimelineTests.kt, ChatTimelineParityWave2Test.kt,
// ChatTurnActivityTests.kt, ToolCardTimelineTests.kt and ChatTimelineAppParityTest.kt,
// one `it` per `@Test`, over the same raw Hook frames and with the same expectations.
import { describe, expect, it } from "vitest";
import { renderKey } from "./message.js";
import { readTranscriptFrame, copyMessage } from "./transcript.js";
import { AgentChatProgress, readProgressFrame } from "./progress.js";
import {
  ChatTimelineEntry, ChatReadRunPresentation, ChatTranscriptPreparation, ChatToolSummary,
  ChatTurnActivity, ChatBackgroundJobs, ChatBackgroundJob, ReadOnlyToolCall, ToolCardKind,
  ToolOutputPreview, ToolOutputPages, ToolPresentationCache, chatActivityContext, chatPendingEcho,
  toolCardMarkdownPreview,
} from "./timeline.js";
import { ToolPresentation, diffPreview } from "./tool-presentation.js";
import { MCPToolPresentation, SkillCallPresentation, WebToolPresentation, AgentSubagentPresentation, AgentPlanPresentation, AgentTodoPresentation } from "./tool-cards.js";

const json = (value: unknown): string => JSON.stringify(value);
const responseItem = (payload: unknown): unknown => ({ type: "response_item", payload });
const graphemeSegmenter = new Intl.Segmenter(undefined, { granularity: "grapheme" });
const graphemeCount = (value: string): number => Array.from(graphemeSegmenter.segment(value)).length;

function transcript(rows: unknown[], firstLine = 0, kind = "backlog") {
  return readTranscriptFrame({ type: kind, source: "codex", totalLines: firstLine + rows.length,
    entries: rows.map((raw, index) => ({ line: firstLine + index, raw })) }, "codex");
}
const codex = (...payloads: unknown[]) => transcript(payloads.map(responseItem)).messages;
const codexRaw = (raws: unknown[]) => transcript(raws).messages;
const call = (id: string | null, name: string, args: string) => ({ type: "function_call", ...(id !== null ? { call_id: id } : {}), name, arguments: args });
const output = (id: string | null, body: unknown) => ({ type: "function_call_output", ...(id !== null ? { call_id: id } : {}), output: body });
function claude(...raws: unknown[]) {
  return readTranscriptFrame({ type: "backlog", source: "claude", entries: raws.map((raw, line) => ({ line, raw })) }, "claude").messages;
}
const claudeCall = (id: string, name: string, input: unknown, timestamp: string | null = null) => ({ type: "assistant", ...(timestamp !== null ? { timestamp } : {}), message: { role: "assistant", content: [{ type: "tool_use", id, name, input }] } });
const claudeResult = (id: string, body: string, error = false, timestamp: string | null = null) => ({ type: "user", ...(timestamp !== null ? { timestamp } : {}), message: { role: "user", content: [{ type: "tool_result", tool_use_id: id, is_error: error, content: body }] } });
const notice = (id: string, summary: string, status = "completed", timestamp: string | null = null) => ({ type: "system", phrenBackground: true, ...(timestamp !== null ? { timestamp } : {}), message: { role: "user", content: `<task-notification>\n<tool-use-id>${id}</tool-use-id>\n<status>${status}</status>\n<summary>${summary}</summary>\n</task-notification>` } });

function reads(picturedIndex: number | null): unknown[] {
  const out: unknown[] = [];
  for (let index = 0; index < 7; index++) {
    const body: unknown = index === picturedIndex
      ? [{ type: "input_image", image_url: "data:image/png;base64," }, { type: "input_image", image_url: "data:image/png;base64," }]
      : "ok";
    out.push(responseItem({ type: "function_call", call_id: `read${index}`, name: "Read", arguments: json({ file_path: `/work/${index}.png` }) }));
    out.push(responseItem({ type: "function_call_output", call_id: `read${index}`, output: body }));
  }
  return out;
}

describe("ChatTimelineTests", () => {
  it("aSkillChipOpensWhatTheSkillLoaded", () => {
    const entries = ChatTimelineEntry.group(transcript([
      responseItem({ type: "function_call", call_id: "s", name: "Skill", arguments: json({ skill: "release", args: "patch" }) }),
      responseItem({ type: "function_call_output", call_id: "s", output: "Launching skill: release" }),
      responseItem({ type: "function_call_output", call_id: "s", output: "Base directory for this skill: /skills/release\n\n# Release a concrete change" }),
    ]).messages);
    expect(entries.length).toBe(1);
    const card = entries[0].card;
    expect(card?.kind).toBe("skill");
    const skill = (card as { kind: "skill"; value: SkillCallPresentation }).value;
    expect(skill.result).toBe("Base directory for this skill: /skills/release\n\n# Release a concrete change");
    expect(skill.result).toBe(SkillCallPresentation.of("Skill", json({ skill: "release", args: "patch" }), entries[0].messages[entries[0].messages.length - 1].text)?.result);
    expect(toolCardMarkdownPreview(card as never)?.text).toBe(skill.result);
  });

  it("aResultCarryingImagesFoldsIntoTheReadRun", () => {
    const entries = ChatTimelineEntry.group(transcript(reads(3)).messages);
    expect(entries.map((entry) => entry.isReadRun)).toEqual([true]);
    expect(entries[0].messages.filter((message) => message.resultImages.length > 0).map((message) => message.toolCallID)).toEqual(["read3"]);
    expect(entries[0].messages.find((message) => message.toolCallID === "read3" && message.isToolResult)?.resultImages.length).toBe(2);
    const pair = ChatTimelineEntry.group(transcript(reads(3).slice(4, 8)).messages);
    expect(pair.map((entry) => entry.isReadRun)).toEqual([true]);
  });

  it("replacingAMiddleCallRefreshesTheFoldedRunAndCardKey", () => {
    const messages = (middle: string) => codex(...Array.from({ length: 4 }).flatMap((_, index) => [
      call(`r${index}`, "Read", json({ file_path: `/a/${index}.swift` })),
      output(`r${index}`, index === 1 ? middle : "ok"),
    ]));
    const before = messages("first output"); const after = messages("other output");
    expect(before.length).toBe(after.length);
    expect(renderKey(before[0])).toBe(renderKey(after[0]));
    expect(renderKey(before[before.length - 1])).toBe(renderKey(after[after.length - 1]));
    const prepared = new ChatTranscriptPreparation();
    prepared.update(before);
    expect(prepared.entries.map((entry) => entry.isReadRun)).toEqual([true]);
    const unchanged = prepared.entries[0].readRun;
    prepared.update(before);
    expect(prepared.entries[0].readRun).toBe(unchanged);
    prepared.update(after);
    expect(prepared.entries[0].readRun?.groups[1].messages.some((message) => message.text.includes("other output"))).toBe(true);
    expect(new ChatTimelineEntry(before).cardMarkdownKey).not.toBe(new ChatTimelineEntry(after).cardMarkdownKey);
  });

  it("phrenCallsStaySeparateAndUseTheirOwnDelayedResult", () => {
    const messages = codex(
      call("a", "mcp__phren__search_knowledge", json({ query: "navigation" })),
      { type: "message", role: "assistant", content: "Looking up the project" },
      output("a", json({ ok: true, data: { count: 1, results: [{ title: "Swipe back" }] } })),
      call("b", "mcp__phren__get_tasks", "{}"), output("b", "[]"),
      call("c", "mcp__phren__get_project_summary", "{}"), output("c", "Summary"),
    );
    const entries = ChatTimelineEntry.group(messages);
    expect(entries.filter((entry) => entry.phren !== null).length).toBe(3);
    expect(entries.some((entry) => entry.isReadRun)).toBe(false);
    expect(entries[0].phren?.titles).toEqual(["Swipe back"]);
    expect(entries[0].messages[entries[0].messages.length - 1].toolCallID).toBe("a");
  });

  it("commandsThatChangedNothingFoldAndAChangeRowSplitsTheRun", () => {
    const commands = ["swift build", "xcodebuild test -scheme Phren", "pnpm lint", "make fmt", "swift test", "cargo check", "pytest -q", "go vet ./..."];
    const raws = (changed: number | null): unknown[] => commands.flatMap((command, index) => {
      const id = `s${index}`;
      const result: Record<string, unknown> = { type: "response_item", payload: output(id, `ok ${index}`) };
      if (index === changed) result.phren_changes = { [id]: [{ root: "/work", path: "Formatted.swift", status: "M", patch: "diff --git a/Formatted.swift b/Formatted.swift\n--- a/Formatted.swift\n+++ b/Formatted.swift\n@@ -1 +1 @@\n-a\n+b\n" }] };
      return [responseItem(call(id, "exec_command", json({ cmd: command }))), result];
    });
    const folded = ChatTimelineEntry.group(codexRaw(raws(null)));
    expect(folded.map((entry) => entry.isReadRun)).toEqual([true]);
    expect(folded[0].messages.length).toBe(16);
    const changed = codexRaw(raws(3));
    const split = ChatTimelineEntry.group(changed);
    expect(split.map((entry) => entry.isReadRun)).toEqual([true, false, true]);
    expect(split.map((entry) => entry.messages.length)).toEqual([6, 3, 8]);
    expect(split[1].messages.some((message) => message.isChange)).toBe(true);
    expect(folded[0].id).toBe(split[0].id);
    expect(ChatTimelineEntry.group(changed, false).length).toBe(8);
  });

  it("pendingFailedAndBackgroundCallsInterruptTheRun", () => {
    const raws = (middle: unknown[]): unknown[] => {
      const out: unknown[] = [];
      for (let index = 0; index < 6; index++) {
        if (index === 3) out.push(...middle);
        out.push(responseItem(call(`l${index}`, "exec_command", json({ cmd: "rg TODO Sources" }))));
        out.push(responseItem(output(`l${index}`, "ok")));
      }
      return out;
    };
    const pending = ChatTimelineEntry.group(codexRaw(raws([responseItem(call("wait", "exec_command", json({ cmd: "swift test" })))])));
    expect(pending.map((entry) => entry.isReadRun)).toEqual([true, false, true]);
    expect(pending[1].messages.map((message) => message.toolCallID)).toEqual(["wait"]);
    const failed = ChatTimelineEntry.group(codexRaw(raws([
      responseItem(call("fail", "exec_command", json({ cmd: "swift test" }))),
      responseItem(output("fail", json({ output: "error: build failed", exit_code: 65 }))),
    ])));
    expect(failed.map((entry) => entry.isReadRun)).toEqual([true, false, true]);
    expect(failed[1].messages[0].toolCallID).toBe("fail");
    const background = ChatTimelineEntry.group(codexRaw(raws([
      responseItem(call("bg", "exec_command", json({ cmd: "swift test", run_in_background: true }))),
      responseItem(output("bg", "Command running in background with ID: b1")),
    ])));
    expect(background.map((entry) => entry.isReadRun)).toEqual([true, false, true]);
    const errored = claude(claudeCall("e1", "Read", { file_path: "/missing.swift" }), claudeResult("e1", "File does not exist.", true));
    expect(ReadOnlyToolCall.failed(errored[1])).toBe(true);
    expect(ReadOnlyToolCall.looksAround(errored)).toBe(false);
  });

  it("groupingRetainsEveryMessageAndNeverCrossesAReply", () => {
    const messages = codex(
      output(null, "Older result"),
      { type: "message", role: "assistant", content: "Checking the change" },
      call(null, "exec_command", json({ cmd: "git diff" })), output(null, "Patch"),
      call(null, "exec_command", json({ cmd: "swift test" })),
      { type: "message", role: "user", content: "Wait" },
      output(null, "Test output"),
    );
    const groups = ChatTimelineEntry.group(messages);
    expect(groups.flatMap((group) => group.messages)).toEqual(messages);
    expect(groups.map((group) => group.messages.length)).toEqual([1, 1, 3, 1, 1]);
    expect(groups.map((group) => group.isActivity)).toEqual([true, false, true, false, true]);
    expect(groups[2].isReadRun).toBe(true);
    const calls = new ChatReadRunPresentation(groups[2].messages).groups;
    expect(calls.map((group) => group.messages.length)).toEqual([2, 1]);
    expect(new ChatToolSummary(calls[0].messages).count).toBe(1);
    expect(new ChatToolSummary(calls[1].messages).preview).toBe("swift test");
    expect(ChatTimelineEntry.group([]).length).toBe(0);
  });

  it("appendingResultsKeepsTheExpandedGroupIdentity", () => {
    const messages = codex(call(null, "exec_command", "git status"), output(null, "Clean"), call(null, "exec_command", "swift test"));
    expect(ChatTimelineEntry.group(messages.slice(0, 1))[0].id).toBe(ChatTimelineEntry.group(messages)[0].id);
  });

  it("mixedAndResultOnlyGroupsHaveHonestSummaries", () => {
    const messages = codex(call(null, "exec_command", "pwd"), call(null, "web_search", json({ query: "SwiftUI layout" })), output(null, "Search output"));
    const mixed = new ChatToolSummary(messages);
    expect(mixed.title).toBe("Activity");
    expect(mixed.count).toBe(2);
    expect(mixed.preview).toBe("SwiftUI layout");
    const result = new ChatToolSummary(messages.slice(-1));
    expect(result.title).toBe("Tool results");
    expect(result.preview).toBe("Search output");
    expect(result.count).toBe(1);
  });

  it("longPreviewDoesNotTruncateTheActualCommand", () => {
    const command = "echo 👩🏽‍💻; ".repeat(100);
    const args = json({ cmd: command });
    const messages = codex(call(null, "functions.exec_command", args));
    expect(new ChatToolSummary(messages).title).toBe("Shell");
    expect(new ChatToolSummary(messages).preview).toBe(command.slice(0, 180));
    expect(ChatTimelineEntry.group(messages)[0].messages[0].text).toBe(args);
  });

  it("nestedExecOutputDisplaysOutputAndRetainsFailureAndRawEnvelope", () => {
    const result = json({ chunk_id: "123", output: "diff output\nsecond line", exit_code: 2 });
    const raw = json([{ type: "input_text", text: result }]);
    const display = ToolPresentation.of("Tool result", raw);
    expect(display.body).toBe("diff output\nsecond line\nExit code: 2");
    expect(display.raw).toBe(raw);
    expect(ToolPresentation.of("Tool result", json({ unknown: 42 })).body.includes("unknown")).toBe(true);
  });

  it("orchestratedShellAndPatchAreDecodedWithoutEvaluatingCode", () => {
    const command = "git status\necho '$HOME'";
    const literal = json(command);
    const display = ToolPresentation.of("functions.exec", "text(await tools.exec_command({cmd:" + literal + "}));");
    expect(display.title).toBe("Shell");
    expect(display.body).toBe(command);
    const dynamic = "await tools.exec_command({cmd:computeCommand()})";
    expect(ToolPresentation.of("functions.exec", dynamic).body).toBe(dynamic);
    const patch = "*** Begin Patch\n*** Update File: Theme.swift\n@@\n-old\n+new\n*** End Patch";
    const edit = ToolPresentation.of("functions.exec", "text(await tools.apply_patch(" + json(patch) + "));");
    expect(edit.patch).toBe(patch);
    expect(edit.path).toBe("Theme.swift");
  });

  it("unifiedDiffNumbersResetAcrossHunksAndHeadersAreNotChanges", () => {
    const diff = diffPreview("diff --git a/a b/a\n--- a/a\n+++ b/a\n@@ -7,2 +9,2 @@\n same\n-old\n+new\n@@ -20 +22 @@\n-another\n+replacement");
    expect(diff.added).toBe(2);
    expect(diff.removed).toBe(2);
    expect(diff.lines.filter((line) => line.kind === "added").map((line) => line.new)).toEqual([10, 22]);
    expect(diff.lines.filter((line) => line.kind === "removed").map((line) => line.old)).toEqual([8, 20]);
    expect(diffPreview("@@ - + @@\n+x").lines[diffPreview("@@ - + @@\n+x").lines.length - 1].new).toBeNull();
  });

  it("parallelOutputsFollowTheirOwnCallIDsAndRepliesKeepTheirPosition", () => {
    const messages = codex(
      call("a", "exec_command", "first"), call("b", "exec_command", "second"),
      output("b", "second result"), output("a", "first result"),
      { type: "message", role: "assistant", content: "Done" },
      output("a", "Later output"),
    );
    const groups = ChatTimelineEntry.group(messages);
    expect(groups.map((group) => group.messages.map((message) => message.text))).toEqual([
      ["first", "first result", "second", "second result"], ["Done"], ["Later output"],
    ]);
    const calls = new ChatReadRunPresentation(groups[0].messages).groups;
    expect(calls.map((group) => group.messages.map((message) => message.text))).toEqual([["first", "first result"], ["second", "second result"]]);
    expect(new Set(groups.flatMap((group) => group.messages).map((message) => message.id))).toEqual(new Set(messages.map((message) => message.id)));
    const unfolded = ChatTimelineEntry.group(messages, false);
    expect(unfolded[1].id).toBe(ChatTimelineEntry.group(messages.slice(0, 2), false)[1].id);
  });

  it("unknownOrAmbiguousResultIDsNeverAttachToAnotherCall", () => {
    const messages = codex(
      call("same", "exec_command", "one"), call("same", "exec_command", "two"),
      output("same", "ambiguous"), output("absent", "unmatched"), output(null, "unidentified"),
    );
    const groups = ChatTimelineEntry.group(messages);
    expect(groups.map((group) => group.messages.length)).toEqual([2, 1, 1, 1]);
    expect(new ChatReadRunPresentation(groups[0].messages).groups.map((group) => group.messages.length)).toEqual([1, 1]);
    expect(ChatTimelineEntry.group(messages, false).map((group) => group.messages.length)).toEqual([1, 1, 1, 1, 1]);
  });

  it("backgroundJobsPairPendingCallAndTaskNotification", () => {
    const messages = claude(
      claudeCall("bg-1", "Bash", { command: "swift test", run_in_background: true }),
      notice("bg-1", "Background tests completed (exit code 2)"),
    );
    const jobs = ChatBackgroundJobs.parse(messages, new Map([["bg-1", new Date(10_000).toISOString()]]), new Map(), new Date(20_000).toISOString());
    expect(jobs.length).toBe(1);
    expect(jobs[0].command).toBe("swift test");
    expect(jobs[0].state).toEqual(ChatBackgroundJob.State.Finished(2));
    expect(jobs[0].title.includes("completed")).toBe(true);
  });

  it("backgroundJobWithOnlyItsStartNoticeIsStillRunningAndFinishedJobsLeaveAfterLingering", () => {
    const start = new Date(10_000).toISOString();
    const messages = claude(
      claudeCall("bg-2", "Bash", { command: "xcodebuild test", run_in_background: true }),
      claudeResult("bg-2", "Command running in background with ID: b1p4. Output is being written to: /tmp/x.output"),
    );
    const running = ChatBackgroundJobs.parse(messages, new Map([["bg-2", start]]), new Map(), new Date(40_000).toISOString());
    expect(running.map((job) => job.state)).toEqual([ChatBackgroundJob.State.Running]);
    expect(running[0].startedAt).toBe(start);
    expect(running.every((job) => job.state.kind !== "finished")).toBe(true);
    const later = claude(
      claudeCall("bg-2", "Bash", { command: "xcodebuild test", run_in_background: true }),
      claudeResult("bg-2", "Command running in background with ID: b1p4. Output is being written to: /tmp/x.output"),
      notice("bg-2", "Background command finished (exit code 0)"),
    );
    const finished = ChatBackgroundJobs.parse(later, new Map([["bg-2", start]]), new Map(), new Date(100_000).toISOString(), true);
    expect(finished.map((job) => job.state)).toEqual([ChatBackgroundJob.State.Finished(0)]);
    const finishedAt = new Date(100_000).toISOString();
    const justDone = ChatBackgroundJobs.parse(later, new Map([["bg-2", start]]), new Map([["bg-2", finishedAt]]), new Date(130_000).toISOString());
    expect(justDone.map((job) => job.state)).toEqual([ChatBackgroundJob.State.Finished(0)]);
    expect(justDone[0].finishedAt).toBe(finishedAt);
    const lingered = ChatBackgroundJobs.parse(later, new Map([["bg-2", start]]), new Map([["bg-2", finishedAt]]), new Date(100_000 + (ChatBackgroundJobs.FINISHED_LINGER_SECONDS + 1) * 1000).toISOString());
    expect(lingered.length).toBe(0);
  });

  it("notificationUserTurnsFeedJobsNotBubblesAndOldJobsStayHidden", () => {
    const noticeText = "<task-notification>\n<task-id>abc</task-id>\n<tool-use-id>bg-3</tool-use-id>\n<status>completed</status>\n<summary>Background command \"Watch deploy\" completed (exit code 0)</summary>\n</task-notification>";
    const messages = claude(
      claudeCall("bg-3", "Bash", { command: "sleep 60", run_in_background: true }, "2026-09-15T10:00:00.000Z"),
      claudeResult("bg-3", "Command running in background with ID: abc", false, "2026-09-15T10:00:01.000Z"),
      { type: "user", timestamp: "2026-09-15T10:01:00.000Z", message: { role: "user", content: noticeText } },
    );
    expect(messages.some((message) => message.role === "user")).toBe(false);
    expect(messages[messages.length - 1].title).toBe("Background notification");
    const finishedAt = new Date(1_789_466_460_000).toISOString();
    const soon = ChatBackgroundJobs.parse(messages, new Map(), new Map(), new Date(1_789_466_460_000 + 30_000).toISOString());
    expect(soon.map((job) => job.state)).toEqual([ChatBackgroundJob.State.Finished(0)]);
    expect(soon[0].startedAt).toBe(new Date(1_789_466_400_000).toISOString());
    expect(soon[0].finishedAt).toBe(finishedAt);
    expect(ChatBackgroundJobs.parse(messages, new Map(), new Map(), new Date(1_789_466_460_000 + 3_600_000).toISOString()).length).toBe(0);
  });

  it("foregroundCommandQuotingABackgroundNoticeIsNotAJob", () => {
    const messages = claude(
      claudeCall("fg-1", "Bash", { command: "tail -3 /tmp/tasks/b1.output" }),
      claudeResult("fg-1", "TREE: ok\nCommand running in background with ID: b1p4ogscs. Output is being written to: /tmp/x\n** TEST SUCCEEDED **"),
      claudeCall("bg-4", "Bash", { command: "sleep 5" }),
      claudeResult("bg-4", "Command did not complete within its 600s timeout and was moved to the background (ID: b2). Output is being written to: /tmp/y"),
    );
    const jobs = ChatBackgroundJobs.parse(messages, new Map());
    expect(jobs.map((job) => job.id)).toEqual(["bg-4"]);
    expect(jobs[0].state).toEqual(ChatBackgroundJob.State.Running);
  });

  it("backgroundJobStaysRunningWithoutNewHookNotification", () => {
    const messages = codex(call("bg-old", "exec_command", json({ cmd: "swift test", run_in_background: true })));
    const started = new Date(10_000).toISOString();
    const jobs = ChatBackgroundJobs.parse(messages, new Map([["bg-old", started]]), new Map(), new Date(20_000).toISOString());
    expect(jobs.length).toBe(1);
    expect(jobs[0].state).toEqual(ChatBackgroundJob.State.Running);
    expect(jobs[0].startedAt).toBe(started);
  });

  it("foregroundCodexExecWithYieldTimeoutNeverBecomesABackgroundJob", () => {
    const messages = codex(
      { type: "custom_tool_call", call_id: "exec-1", name: "exec", input: json({ cmd: "find .. -name AGENTS.md -print", yield_time_ms: 30000, max_output_tokens: 2000 }) },
      { type: "custom_tool_call_output", call_id: "exec-1", output: "Script completed\nWall time 27.1 seconds\nOutput:\n../AGENTS.md" },
    );
    expect(ChatBackgroundJobs.parse(messages, new Map()).length).toBe(0);
  });

  it("toolPreviewBoundsManyLinesAndLongUnicodeWithoutLosingSource", () => {
    expect(ToolPresentation.of("mcp__phren__get_tasks", "{}").title).toBe("Phren · Get Tasks");
    const body = Array.from({ length: 2_000 }, (_, index) => "Line " + index).join("\n");
    const display = ToolPresentation.of("Tool result", body);
    expect(new ToolOutputPreview(display.body).text).toBe("Line 0\nLine 1\nLine 2\nLine 3\nLine 4\nLine 5…");
    expect(display.body).toBe(body);
    const unicode = "👩🏽‍💻".repeat(1_000);
    expect(new ToolOutputPreview(unicode).text).toBe("👩🏽‍💻".repeat(640) + "…");
    expect(new ToolOutputPreview("Small output").text).toBe("Small output");
  });

  it("denseOutputPagesBoundLayoutAndPreserveEverySourceByte", () => {
    const source = "x\n".repeat(8_000) + "Final output marker";
    const output = new ToolOutputPages(source);
    expect(output.totalLines).toBe(8_001);
    expect(output.pages[0].firstLine).toBe(1);
    expect(output.pages[0].lastLine).toBe(120);
    expect(output.pages[1].firstLine).toBe(121);
    expect(output.pages[output.pages.length - 1].lastLine).toBe(8_001);
    expect(output.pages[output.pages.length - 1].text.includes("Final output marker")).toBe(true);
    expect(output.pages.map((page) => page.text).join("")).toBe(source);
    expect(output.source).toBe(source);
    const newline = /\r\n|[\n\r\u000B\u000C\u0085\u2028\u2029]/;
    for (const page of output.pages) {
      expect(graphemeCount(page.text)).toBeLessThanOrEqual(4_000);
      expect(page.displayText.split(newline).length).toBeLessThanOrEqual(120);
    }
  });

  it("outputPagesPreserveLongUnicodeLinesMixedNewlinesAndEmptyOutput", () => {
    const sources = ["", "Small output\n", "👩🏽‍💻".repeat(12_000) + "Final marker", ("first\r\n\n👩🏽‍💻 e\u0301\rline\u2028").repeat(500) + "tail\n"];
    const newline = /\r\n|[\n\r\u000B\u000C\u0085\u2028\u2029]/;
    for (const source of sources) {
      const output = new ToolOutputPages(source);
      expect(output.pages.length).toBeGreaterThan(0);
      expect(output.pages.map((page) => page.text).join("")).toBe(source);
      for (const page of output.pages) {
        expect(graphemeCount(page.text)).toBeLessThanOrEqual(4_000);
        expect(page.displayText.split(newline).length).toBeLessThanOrEqual(120);
      }
    }
    const longLine = new ToolOutputPages(sources[2]);
    expect(longLine.pages.length).toBe(4);
    expect(longLine.pages.every((page) => page.firstLine === 1 && page.lastLine === 1)).toBe(true);
    expect(ToolPresentation.of("Tool result", "\n\nPreview\n" + sources[2]).preview).toBe("Preview");
  });

  it("bookkeepingCallsGetCardsAndTodoListsSupersede", () => {
    const payloads: unknown[] = [];
    for (let index = 0; index < 2; index++) {
      const id = `r${index}`;
      payloads.push(call(id, "Read", json({ file_path: `/a/${index}.swift` })));
      payloads.push(output(id, "ok"));
    }
    payloads.push(call("t1", "TodoWrite", json({ todos: [{ content: "A", status: "pending" }] })));
    payloads.push(output("t1", "Todos have been modified successfully."));
    payloads.push(call("r2", "Read", json({ file_path: "/a/2.swift" })));
    payloads.push(output("r2", "ok"));
    payloads.push(call("agent", "Task", json({ description: "Audit", prompt: "Look around", subagent_type: "Explore" })));
    payloads.push({ type: "message", role: "assistant", content: "Waiting for the agent" });
    payloads.push(output("agent", "# Report\n- fine"));
    payloads.push(call("t2", "TodoWrite", json({ todos: [{ content: "A", status: "completed" }] })));
    payloads.push(output("t2", "Todos have been modified successfully."));
    payloads.push(call("plan-in", "EnterPlanMode", "{}"));
    payloads.push(output("plan-in", "Entered plan mode."));
    payloads.push(call("plan", "ExitPlanMode", json({ plan: "# Plan\n1. Do it" })));
    payloads.push(output("plan", "User has approved your plan."));
    const entries = ChatTimelineEntry.group(codex(...payloads));
    const runs = entries.filter((entry) => entry.isReadRun);
    expect(runs.length).toBe(1);
    expect(runs[0].messages.filter((message) => !message.isToolResult).length).toBe(2);
    expect(entries.some((entry) => entry.callID === "r2")).toBe(true);
    const cards = entries.map((entry) => entry.card).filter((card) => card !== null);
    expect(cards.length).toBe(5);
    const first = (cards[0] as { kind: "todos"; value: AgentTodoPresentation }).value;
    const agent = (cards[1] as { kind: "agent"; value: AgentSubagentPresentation }).value;
    const second = (cards[2] as { kind: "todos"; value: AgentTodoPresentation }).value;
    expect(cards[3]).toEqual(ToolCardKind.PlanMode);
    const plan = (cards[4] as { kind: "plan"; value: AgentPlanPresentation }).value;
    expect(first.summary).toBe("0 of 1 done");
    expect(second.summary).toBe("1 of 1 done");
    expect(entries.filter((entry) => entry.card !== null).map((entry) => entry.cardSuperseded)).toEqual([true, false, false, false, false]);
    expect(agent.state).toBe(AgentSubagentPresentation.State.DONE);
    expect(agent.report).toBe("# Report\n- fine");
    expect(entries.find((entry) => entry.callID === "agent")?.messages.length).toBe(2);
    expect(plan.state).toBe(AgentPlanPresentation.State.APPROVED);
    expect(toolCardMarkdownPreview(entries.find((entry) => entry.callID === "agent")?.card as never)).not.toBeNull();
    expect(toolCardMarkdownPreview(entries.find((entry) => entry.callID === "t2")?.card as never)).toBeNull();
  });

  it("backgroundAgentFinishesOnItsTaskNotification", () => {
    const launched = "Async agent launched successfully.\nagentId: a1 (for resuming)\noutput_file: /tmp/a1.txt";
    const original = [
      claudeCall("bg-agent", "Task", { description: "Run tests", prompt: "swift test", run_in_background: true }),
      claudeResult("bg-agent", launched),
    ];
    const card = (raws: unknown[]) => {
      const entry = ChatTimelineEntry.group(claude(...raws))[0];
      return entry?.card?.kind === "agent" ? entry.card.value : null;
    };
    const running = card(original);
    expect(running?.state).toBe(AgentSubagentPresentation.State.RUNNING);
    expect(running?.background).toBe(true);
    const done = card([...original, notice("bg-agent", "Agent \"tester\" completed")]);
    expect(done?.state).toBe(AgentSubagentPresentation.State.DONE);
    expect(done?.summary).toBe("Agent \"tester\" completed");
  });

  it("childTranscriptPatchGroupsAsFormattedToolActivity", () => {
    const args = json({ patch: "*** Begin Patch\n*** Update File: Sources/App.swift\n@@\n-let old = true\n+let old = false\n*** End Patch" });
    const patch = "diff --git a/Sources/App.swift b/Sources/App.swift\n--- a/Sources/App.swift\n+++ b/Sources/App.swift\n@@ -1 +1 @@\n-let old = true\n+let old = false\n";
    const messages = codexRaw([
      responseItem(call("patch-1", "apply_patch", args)),
      { type: "response_item", payload: output("patch-1", "Done!"), phren_changes: { "patch-1": [{ root: "/work", path: "Sources/App.swift", status: "M", patch }] } },
    ]);
    const entries = ChatTimelineEntry.group(messages);
    expect(entries.length).toBe(1);
    expect(entries[0].isActivity).toBe(true);
    expect(entries[0].messages.length).toBe(3);
    expect(entries[0].messages.some((message) => message.isToolResult)).toBe(true);
    expect(entries[0].messages.some((message) => message.isChange)).toBe(true);
    const presentation = ToolPresentationCache.value(entries[0].messages[0]);
    expect(presentation.title).toBe("Patch");
    expect(presentation.preview !== "{").toBe(true);
  });

  // Not ported: agentTreeRowsPreserveHierarchyAndSiblingEnds, which exercises
  // AgentChildTree/AgentChild outside this package (see the final note).
});

function parityRead(payloads: unknown[]) {
  return readTranscriptFrame({ type: "backlog", source: "codex", entries: payloads.map((payload, index) => ({ line: index, raw: responseItem(payload) })) }, "codex").messages;
}

describe("ChatTimelineParityWave2Test", () => {
  it("phrenCallsStaySeparateAndUseTheirOwnDelayedResult", () => {
    const messages = parityRead([
      { type: "function_call", call_id: "a", name: "mcp__phren__search_knowledge", arguments: json({ query: "navigation" }) },
      { type: "message", role: "assistant", content: "Looking up the project" },
      { type: "function_call_output", call_id: "a", output: json({ ok: true, data: { count: 1, results: [{ title: "Swipe back" }] } }) },
      { type: "function_call", call_id: "b", name: "mcp__phren__get_tasks", arguments: "{}" },
      { type: "function_call_output", call_id: "b", output: "[]" },
      { type: "function_call", call_id: "c", name: "mcp__phren__get_project_summary", arguments: "{}" },
      { type: "function_call_output", call_id: "c", output: "Summary" },
    ]);
    const entries = ChatTimelineEntry.group(messages);
    expect(entries.filter((entry) => entry.phren !== null).length).toBe(3);
    expect(entries.some((entry) => entry.isReadRun)).toBe(false);
    expect(entries[0].phren?.titles).toEqual(["Swipe back"]);
    expect(entries[0].messages[entries[0].messages.length - 1].toolCallID).toBe("a");
  });

  it("appendingResultsKeepsTheExpandedGroupIdentity", () => {
    const messages = parityRead([
      { type: "function_call", name: "exec_command", arguments: "git status" },
      { type: "function_call_output", output: "Clean" },
      { type: "function_call", name: "exec_command", arguments: "swift test" },
    ]);
    expect(ChatTimelineEntry.group(messages.slice(0, 1))[0].id).toBe(ChatTimelineEntry.group(messages)[0].id);
  });

  it("mixedAndResultOnlyGroupsHaveHonestSummaries", () => {
    const messages = parityRead([
      { type: "function_call", name: "exec_command", arguments: "pwd" },
      { type: "function_call", name: "web_search", arguments: json({ query: "SwiftUI layout" }) },
      { type: "function_call_output", output: "Search output" },
    ]);
    const mixed = new ChatToolSummary(messages);
    expect(mixed.title).toBe("Activity");
    expect(mixed.count).toBe(2);
    expect(mixed.preview).toBe("SwiftUI layout");
    const result = new ChatToolSummary(messages.slice(-1));
    expect(result.title).toBe("Tool results");
    expect(result.preview).toBe("Search output");
    expect(result.count).toBe(1);
  });
});

const distantFuture = "4001-01-01T00:00:00Z";
const turnMessage = (role: string, text: string): unknown => ({ type: "response_item", payload: { type: "message", role, content: text } });
const turnEvent = (type: string, seconds: number): unknown => ({ type: "event_msg", timestamp: new Date(seconds * 1000).toISOString(), payload: { type, started_at: seconds, completed_at: seconds } });

function activityFrame(raws: unknown[], firstLine = 0, kind = "backlog") {
  const raw = { type: kind, source: "codex", totalLines: firstLine + raws.length, entries: raws.map((entry, index) => ({ line: firstLine + index, raw: entry })) };
  const read = readTranscriptFrame(raw, "codex");
  return { ...read, progressEvents: readProgressFrame(raw, "codex").progressEvents };
}

describe("ChatTurnActivityTests", () => {
  it("preparationOwnsEachTurnAndRestoresCompletedRowsOnReopen", () => {
    const frame = activityFrame([
      turnMessage("user", "First"), turnEvent("task_started", 1000.0), turnMessage("assistant", "First reply"), turnEvent("task_complete", 1027.0),
      turnMessage("user", "Second"), turnEvent("task_started", 1100.0),
      responseItem({ type: "function_call", name: "exec_command", call_id: "shell", arguments: json({ cmd: "pwd" }) }),
    ]);
    const progress = new AgentChatProgress(); progress.receive(frame);
    const prepared = new ChatTranscriptPreparation();
    prepared.update(frame.messages, chatActivityContext({ turns: progress.turns, busy: true }));
    const done = prepared.entries.find((entry) => entry.turnActivity?.isLive === false);
    expect(done?.turnActivity?.ownerID).toBe("0:0");
    expect(done?.placeholderIdentifier).toBe("chat-activity-done");
    expect(done?.placeholderLabel).toBe("Thought for 27s");
    expect(done?.id).toBe(prepared.entries[1].id);
    expect(prepared.entries[2].messages[0]?.text).toBe("First reply");
    const live = prepared.entries[prepared.entries.length - 1].turnActivity;
    expect(live?.ownerID).toBe("4:0");
    expect(live?.verb).toBe("Running Shell");
    expect(prepared.entries.filter((entry) => entry.turnActivity?.isLive === true).length).toBe(1);

    const finish = activityFrame([turnMessage("assistant", "Second reply"), turnEvent("task_complete", 1172.0)], 7, "append");
    progress.receive(finish);
    const messages = [...frame.messages, ...finish.messages];
    prepared.update(messages, chatActivityContext({ turns: progress.turns }));
    const summaries = prepared.entries.map((entry) => entry.turnActivity).filter((activity) => activity !== null);
    expect(summaries.map((activity) => activity.ownerID)).toEqual(["0:0", "4:0"]);
    expect(summaries.map((activity) => activity.label(distantFuture))).toEqual(["Thought for 27s", "Worked for 1m 12s"]);
    expect(prepared.entries[prepared.entries.length - 2].turnActivity?.ownerID).toBe("4:0");
    expect(prepared.entries[prepared.entries.length - 1].messages[0]?.text).toBe("Second reply");
    const reopened = new ChatTranscriptPreparation();
    reopened.update(messages, chatActivityContext({ turns: progress.turns }));
    expect(reopened.entries).toEqual(prepared.entries);
  });

  it("pendingEchoLandsWithTheLiveLineAndAboveIt", () => {
    const frame = activityFrame([turnMessage("assistant", "Ready")]);
    const echo = chatPendingEcho(crypto.randomUUID(), "Fix the header", []);
    const prepared = new ChatTranscriptPreparation();
    prepared.update(frame.messages, chatActivityContext({ submittedAt: new Date().toISOString(), submittedAfterLine: 0, busy: true, pendingEchoes: [echo] }));
    const ids = prepared.entries.map((entry) => entry.id);
    expect(prepared.entries[prepared.entries.length - 1].turnActivity?.isLive).toBe(true);
    expect(ids.slice(-2)[0]).toBe(`pending:${echo.id}`);
    prepared.update(frame.messages, chatActivityContext({ submittedAt: new Date().toISOString(), submittedAfterLine: 0, busy: true }));
    expect(prepared.entries.some((entry) => entry.pendingEcho !== null)).toBe(false);
  });

  it("progressOnlyCompletionInvalidatesPreparationAndWaitingHidesLiveRow", () => {
    const frame = activityFrame([turnEvent("task_started", 1000.0), turnMessage("user", "Hello")]);
    const progress = new AgentChatProgress(); progress.receive(frame);
    const prepared = new ChatTranscriptPreparation();
    prepared.update(frame.messages, chatActivityContext({ turns: progress.turns, busy: true }));
    expect(prepared.entries[prepared.entries.length - 1].turnActivity?.ownerID).toBe("1:0");
    expect(prepared.entries[prepared.entries.length - 1].turnActivity?.verb).toBe("Thinking");
    prepared.update(frame.messages, chatActivityContext({ turns: progress.turns, busy: true, waiting: true }));
    expect(prepared.entries.some((entry) => entry.turnActivity !== null)).toBe(false);
    progress.receive(activityFrame([turnEvent("turn_aborted", 1012.0)], 2, "append"));
    prepared.update(frame.messages, chatActivityContext({ turns: progress.turns }));
    expect(prepared.entries[prepared.entries.length - 1].placeholderLabel).toBe("Stopped after 12s");
    expect(prepared.entries[prepared.entries.length - 1].placeholderIdentifier).toBe("chat-activity-done");
    const revision = prepared.revision;
    prepared.update(frame.messages, chatActivityContext({ turns: progress.turns }), distantFuture);
    expect(prepared.revision).toBe(revision);
  });

  it("missingStartAndUnrelatedEarlierToolsDoNotLeakIntoCurrentTurn", () => {
    const frame = activityFrame([
      turnMessage("user", "Earlier"),
      responseItem({ type: "function_call", name: "Read", call_id: "old", arguments: "{}" }),
      turnMessage("assistant", "Earlier reply"), turnMessage("user", "Current"), turnEvent("task_started", 1000.0),
    ]);
    let progress = new AgentChatProgress(); progress.receive(frame);
    const prepared = new ChatTranscriptPreparation();
    prepared.update(frame.messages, chatActivityContext({ turns: progress.turns, busy: true }));
    expect(prepared.entries[prepared.entries.length - 1].turnActivity?.verb).toBe("Thinking");
    const missing = activityFrame([turnMessage("user", "No clock"), { type: "event_msg", payload: { type: "task_started" } }, turnEvent("task_complete", 1200.0)]);
    progress = new AgentChatProgress(); progress.receive(missing);
    prepared.update(missing.messages, chatActivityContext({ turns: progress.turns }));
    expect(prepared.entries.some((entry) => entry.turnActivity !== null)).toBe(false);
  });

  it("queuedInputCannotStealTheActiveTurnAndTextChangesItsVerb", () => {
    const frame = activityFrame([turnMessage("user", "Current"), turnEvent("task_started", 1000.0), turnMessage("assistant", "Writing the reply")]);
    const progress = new AgentChatProgress(); progress.receive(frame);
    const queued = copyMessage(activityFrame([turnMessage("user", "Next")], 3).messages[0], { isQueued: true });
    const prepared = new ChatTranscriptPreparation();
    prepared.update([...frame.messages, queued], chatActivityContext({ turns: progress.turns, submittedAt: new Date(1_020_000).toISOString(), submittedAfterLine: 2, busy: true }));
    expect(prepared.entries[prepared.entries.length - 1].turnActivity?.ownerID).toBe("0:0");
    expect(prepared.entries[prepared.entries.length - 1].turnActivity?.verb).toBe("Responding");
    expect(Date.parse(prepared.entries[prepared.entries.length - 1].turnActivity?.startedAt ?? "")).toBe(1_000_000);
    expect(prepared.entries.filter((entry) => entry.turnActivity !== null).length).toBe(1);
  });

  it("submitFallbackAndToolVerbsUseCardTitles", () => {
    const prepared = new ChatTranscriptPreparation();
    prepared.update([], chatActivityContext({ submittedAt: new Date(1_000_000).toISOString(), busy: true }));
    expect(prepared.entries[prepared.entries.length - 1].turnActivity?.verb).toBe("Thinking");
    expect(ToolPresentation.of("functions.exec_command", "{}").activityVerb).toBe("Running Shell");
    expect(ToolPresentation.of("Read", "{}").activityVerb).toBe("Reading");
    expect(ToolPresentation.of("functions.apply_patch", "{}").activityVerb).toBe("Editing");
    expect(ChatTurnActivity.duration(59.0)).toBe("59s");
    expect(ChatTurnActivity.duration(64.0)).toBe("1m 04s");
  });
});

const tcCall = (id: string, name: string, args: string): unknown => responseItem({ type: "function_call", call_id: id, name, arguments: args });
const tcOutput = (id: string, text: string): unknown => responseItem({ type: "function_call_output", call_id: id, output: text });
const tcRead = (raws: unknown[]) => readTranscriptFrame({ type: "backlog", source: "codex", totalLines: raws.length, entries: raws.map((raw, index) => ({ line: index, raw })) }, "codex").messages;

describe("ToolCardTimelineTests", () => {
  it("threeFetchesFoldLikeReadsAndKeepTheirCardsWhenExpanded", () => {
    const raws: unknown[] = [];
    for (let index = 0; index < 3; index++) {
      raws.push(tcCall(`f${index}`, "WebFetch", json({ url: `https://example.org/page/${index}`, prompt: "Read it" })));
      raws.push(tcOutput(`f${index}`, `Page ${index}`));
    }
    raws.push(tcCall("s", "WebSearch", json({ query: "swiftui" })));
    raws.push(tcOutput("s", "Web search results for query: \"swiftui\""));
    const folded = ChatTimelineEntry.group(tcRead(raws));
    expect(folded.map((entry) => entry.isReadRun)).toEqual([true]);
    const expanded = ChatTimelineEntry.group(folded[0].messages, false);
    expect(expanded.length).toBe(4);
    const fetch = (expanded[0].card as { kind: "web"; value: WebToolPresentation }).value;
    const search = (expanded[expanded.length - 1].card as { kind: "web"; value: WebToolPresentation }).value;
    expect(fetch.location).toBe("example.org/page/0");
    expect(search.location).toBe("“swiftui”");
    const pending = ChatTimelineEntry.group(tcRead(raws.slice(0, -1)));
    expect(pending.map((entry) => entry.isReadRun)).toEqual([true, false]);
    expect((pending[pending.length - 1].card as { kind: "web"; value: WebToolPresentation }).value.status).toBe(WebToolPresentation.Status.RUNNING);
    // WebToolCard.presentation (view-layer) is not ported here.
  });

  it("aSkillCallEndsTheRunAndIsAChipNotAPill", () => {
    const raws: unknown[] = [];
    for (let index = 0; index < 7; index++) {
      if (index === 3) {
        raws.push(tcCall("skill", "Skill", json({ skill: "design", args: "the cards" })));
        raws.push(tcOutput("skill", "Launching skill: design"));
      }
      raws.push(tcCall(`r${index}`, "Read", json({ file_path: `/work/${index}.swift` })));
      raws.push(tcOutput(`r${index}`, "ok"));
    }
    const entries = ChatTimelineEntry.group(tcRead(raws));
    expect(entries.map((entry) => entry.isReadRun)).toEqual([true, false, true]);
    const skill = (entries[1].card as { kind: "skill"; value: SkillCallPresentation }).value;
    expect(skill.command).toBe("/design");
    expect(skill.args).toBe("the cards");
    expect(ToolCardKind.interruptsRun("Skill")).toBe(true);
    expect(ToolCardKind.interruptsRun("mcp__github__get_issue")).toBe(true);
    expect(ToolCardKind.interruptsRun("WebFetch")).toBe(false);
    expect(ToolCardKind.interruptsRun("WebSearch")).toBe(false);
    expect(ToolCardKind.interruptsRun("Read")).toBe(false);
    const bare = ChatTimelineEntry.group(tcRead([tcCall("x", "Skill", "{}")]));
    expect(bare[0].card).toBeNull();
    expect(bare[0].isActivity).toBe(true);
  });

  it("otherServersGetMCPCardsAndNeverFoldWhilePhrenKeepsItsOwn", () => {
    const raws: unknown[] = [];
    const names = ["mcp__github__get_pull_request", "mcp__herdr__list_panes", "mcp__github__merge_pull_request"];
    names.forEach((name, index) => {
      raws.push(tcCall(`m${index}`, name, json({ owner: "alaarab", repo: "phren", labels: ["ios"] })));
      raws.push(tcOutput(`m${index}`, index === 2 ? json({ isError: true, content: [{ type: "text", text: "Not mergeable" }] }) : json({ content: [{ type: "text", text: json({ title: "Cards", state: "open" }) }] })));
    });
    raws.push(tcCall("p", "mcp__phren__add_task", json({ task: "Verify" })));
    raws.push(tcOutput("p", json({ ok: true })));
    const entries = ChatTimelineEntry.group(tcRead(raws));
    expect(entries.some((entry) => entry.isReadRun)).toBe(false);
    expect(entries.length).toBe(4);
    const pull = (entries[0].card as { kind: "mcp"; value: MCPToolPresentation }).value;
    const merge = (entries[2].card as { kind: "mcp"; value: MCPToolPresentation }).value;
    expect(pull.server).toBe("GitHub");
    expect(pull.verb).toBe("Get pull request");
    expect(pull.resultLines).toEqual(["title: Cards", "state: open"]);
    expect(pull.status).toBe(MCPToolPresentation.Status.SUCCEEDED);
    expect(pull.fields.map((field) => field.value)).toEqual(["1 item", "alaarab", "phren"]);
    expect(merge.status).toBe(MCPToolPresentation.Status.FAILED);
    expect(merge.resultLines).toEqual(["Not mergeable"]);
    expect(entries[3].phren).not.toBeNull();
    expect(entries[3].card).toBeNull();
    // MCPToolCard.presentation and SkillChip.presentation (view layer) are not ported here.
  });
});

function appRead(payloads: unknown[]) {
  return readTranscriptFrame({ type: "backlog", source: "codex", totalLines: payloads.length, entries: payloads.map((payload, index) => ({ line: index, raw: responseItem(payload) })) }, "codex").messages;
}

describe("ChatTimelineAppParityTest", () => {
  it("readOnlyClassificationIsConservative", () => {
    for (const command of ["cat README.md | rg Widget", "sed -n '1,20p' App.swift", "git diff --stat", "find Sources -name '*.swift' | wc -l"]) {
      expect(ReadOnlyToolCall.shell(command)).toBe(true);
    }
    for (const command of ["sed -i '' s/a/b/ App.swift", "cat input > output", "git checkout main", "rm -rf build"]) {
      expect(ReadOnlyToolCall.shell(command)).toBe(false);
    }
  });

  it("threeConsecutiveReadsFoldAndWritesBreakTheRun", () => {
    const payloads: unknown[] = [];
    const commands = [["r0", "cat One.swift"], ["r1", "rg TODO Sources"], ["r2", "git status"]];
    for (const [id, command] of commands) {
      payloads.push({ type: "function_call", call_id: id, name: "exec_command", arguments: json({ cmd: command }) });
      payloads.push({ type: "function_call_output", call_id: id, output: "ok" });
    }
    payloads.push({ type: "function_call", call_id: "write", name: "exec_command", arguments: json({ cmd: "echo changed > File.swift" }) });
    payloads.push({ type: "function_call_output", call_id: "write", output: "ok" });
    const grouped = ChatTimelineEntry.group(appRead(payloads));
    expect(grouped.length).toBe(2);
    expect(grouped[0].isReadRun).toBe(true);
    expect(grouped[0].messages.length).toBe(6);
    expect(grouped[1].isReadRun).toBe(false);
  });
});
