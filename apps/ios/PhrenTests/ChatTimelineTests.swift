import XCTest
import PhrenKit
@testable import Phren

final class ChatTimelineTests: XCTestCase {
    func testPhrenCallsStaySeparateAndUseTheirOwnDelayedResult() throws {
        let messages = try read([
            ["type": "function_call", "call_id": "a", "name": "mcp__phren__search_knowledge", "arguments": #"{"query":"navigation"}"#],
            ["type": "message", "role": "assistant", "content": "Looking up the project"],
            ["type": "function_call_output", "call_id": "a", "output": #"{"ok":true,"data":{"count":1,"results":[{"title":"Swipe back"}]}}"#],
            ["type": "function_call", "call_id": "b", "name": "mcp__phren__get_tasks", "arguments": "{}"],
            ["type": "function_call_output", "call_id": "b", "output": "[]"],
            ["type": "function_call", "call_id": "c", "name": "mcp__phren__get_project_summary", "arguments": "{}"],
            ["type": "function_call_output", "call_id": "c", "output": "Summary"],
        ])
        let entries = ChatTimelineEntry.group(messages)
        XCTAssertEqual(entries.compactMap(\.phren).count, 3)
        XCTAssertFalse(entries.contains(where: \.isReadRun))
        XCTAssertEqual(entries.first?.phren?.titles, ["Swipe back"])
        XCTAssertEqual(entries.first?.messages.last?.toolCallID, "a")
    }

    func testReadOnlyClassificationIsConservative() {
        XCTAssertTrue(ReadOnlyToolCall.shell("cat README.md | rg Widget"))
        XCTAssertTrue(ReadOnlyToolCall.shell("sed -n '1,20p' App.swift"))
        XCTAssertTrue(ReadOnlyToolCall.shell("git diff --stat"))
        XCTAssertTrue(ReadOnlyToolCall.shell("find Sources -name '*.swift' | wc -l"))
        XCTAssertFalse(ReadOnlyToolCall.shell("sed -i '' s/a/b/ App.swift"))
        XCTAssertFalse(ReadOnlyToolCall.shell("cat input > output"))
        XCTAssertFalse(ReadOnlyToolCall.shell("git checkout main"))
        XCTAssertFalse(ReadOnlyToolCall.shell("rm -rf build"))
    }

    func testThreeConsecutiveReadsFoldAndWritesBreakTheRun() throws {
        var payloads: [[String: Any]] = []
        for (index, command) in ["cat One.swift", "rg TODO Sources", "git status"].enumerated() {
            payloads.append(["type": "function_call", "call_id": "r\(index)", "name": "exec_command", "arguments": "{\"cmd\":\"\(command)\"}"])
            payloads.append(["type": "function_call_output", "call_id": "r\(index)", "output": "ok"])
        }
        payloads.append(["type": "function_call", "call_id": "write", "name": "exec_command", "arguments": "{\"cmd\":\"echo changed > File.swift\"}"])
        payloads.append(["type": "function_call_output", "call_id": "write", "output": "ok"])
        let grouped = ChatTimelineEntry.group(try read(payloads))
        XCTAssertEqual(grouped.count, 2)
        XCTAssertTrue(grouped[0].isReadRun)
        XCTAssertEqual(grouped[0].messages.count, 6)
        XCTAssertFalse(grouped[1].isReadRun)
    }

    /// Commands that changed nothing are the agent looking around, however
    /// they read; the Hook's change row is what makes one its own card — and
    /// it may land a revision after the call, splitting the run it was in.
    func testCommandsThatChangedNothingFoldAndAChangeRowSplitsTheRun() throws {
        let commands = ["swift build", "xcodebuild test -scheme Phren", "pnpm lint", "make fmt", "swift test", "cargo check", "pytest -q", "go vet ./..."]
        func raws(changed: Int?) throws -> [[String: Any]] {
            try commands.enumerated().flatMap { index, command -> [[String: Any]] in
                let arguments = String(decoding: try JSONSerialization.data(withJSONObject: ["cmd": command]), as: UTF8.self)
                var result: [String: Any] = ["type": "response_item", "payload": ["type": "function_call_output", "call_id": "s\(index)", "output": "ok \(index)"]]
                if index == changed {
                    result["phren_changes"] = ["s\(index)": [["root": "/work", "path": "Formatted.swift", "status": "M", "patch": "diff --git a/Formatted.swift b/Formatted.swift\n--- a/Formatted.swift\n+++ b/Formatted.swift\n@@ -1 +1 @@\n-a\n+b\n"]]]
                }
                return [["type": "response_item", "payload": ["type": "function_call", "call_id": "s\(index)", "name": "exec_command", "arguments": arguments]], result]
            }
        }
        let folded = ChatTimelineEntry.group(try readRaw(raws(changed: nil)))
        XCTAssertEqual(folded.map(\.isReadRun), [true])
        XCTAssertEqual(folded[0].messages.count, 16)
        let split = ChatTimelineEntry.group(try readRaw(raws(changed: 3)))
        XCTAssertEqual(split.map(\.isReadRun), [true, false, true])
        XCTAssertEqual(split.map { $0.messages.count }, [6, 3, 8])
        XCTAssertTrue(split[1].messages.contains(where: \.isChange))
        XCTAssertEqual(split[0].id, folded[0].id, "The run before the change keeps its identity")
        XCTAssertEqual(ChatTimelineEntry.group(try readRaw(raws(changed: 3)), foldingReads: false).count, 8)
    }

    /// A call still out, one that failed, or one sent to the background stays
    /// visible as its own card; the looking around either side still folds.
    func testPendingFailedAndBackgroundCallsInterruptTheRun() throws {
        func raws(middle: [[String: Any]]) throws -> [[String: Any]] {
            var raws: [[String: Any]] = []
            for index in 0..<6 {
                if index == 3 { raws += middle }
                raws.append(["type": "response_item", "payload": ["type": "function_call", "call_id": "l\(index)", "name": "exec_command", "arguments": "{\"cmd\":\"rg TODO Sources\"}"]])
                raws.append(["type": "response_item", "payload": ["type": "function_call_output", "call_id": "l\(index)", "output": "ok"]])
            }
            return raws
        }
        let pending = ChatTimelineEntry.group(try readRaw(raws(middle: [
            ["type": "response_item", "payload": ["type": "function_call", "call_id": "wait", "name": "exec_command", "arguments": "{\"cmd\":\"swift test\"}"]]])))
        XCTAssertEqual(pending.map(\.isReadRun), [true, false, true], "A call without its result is still running")
        XCTAssertEqual(pending[1].messages.map(\.toolCallID), ["wait"])
        let failed = ChatTimelineEntry.group(try readRaw(raws(middle: [
            ["type": "response_item", "payload": ["type": "function_call", "call_id": "fail", "name": "exec_command", "arguments": "{\"cmd\":\"swift test\"}"]],
            ["type": "response_item", "payload": ["type": "function_call_output", "call_id": "fail", "output": "{\"output\":\"error: build failed\",\"exit_code\":65}"]]])))
        XCTAssertEqual(failed.map(\.isReadRun), [true, false, true], "A non-zero exit keeps the card")
        XCTAssertEqual(failed[1].messages.first?.toolCallID, "fail")
        let background = ChatTimelineEntry.group(try readRaw(raws(middle: [
            ["type": "response_item", "payload": ["type": "function_call", "call_id": "bg", "name": "exec_command", "arguments": "{\"cmd\":\"swift test\",\"run_in_background\":true}"]],
            ["type": "response_item", "payload": ["type": "function_call_output", "call_id": "bg", "output": "Command running in background with ID: b1"]]])))
        XCTAssertEqual(background.map(\.isReadRun), [true, false, true], "A background job keeps the card")
        // Claude's own error flag on a result, with no exit code in the text.
        let frame: [String: Any] = ["type": "backlog", "source": "claude", "entries": [
            ["line": 0, "raw": ["type": "assistant", "message": ["role": "assistant", "content": [["type": "tool_use", "id": "e1", "name": "Read", "input": ["file_path": "/missing.swift"]]]]]],
            ["line": 1, "raw": ["type": "user", "message": ["role": "user", "content": [["type": "tool_result", "tool_use_id": "e1", "is_error": true, "content": "File does not exist."]]]]],
        ]]
        let errored = try AgentChatTranscript.read(JSONSerialization.data(withJSONObject: frame), source: "claude").messages
        XCTAssertTrue(ReadOnlyToolCall.failed(errored[1]))
        XCTAssertFalse(ReadOnlyToolCall.looksAround(errored))
    }

    func testBackgroundJobsPairPendingCallAndTaskNotification() throws {
        let content = "<task-notification>\n<tool-use-id>bg-1</tool-use-id>\n<status>completed</status>\n<summary>Background tests completed (exit code 2)</summary>\n</task-notification>"
        let frame: [String: Any] = ["type": "backlog", "source": "claude", "entries": [
            ["line": 0, "raw": ["type": "assistant", "message": ["role": "assistant", "content": [["type": "tool_use", "id": "bg-1", "name": "Bash", "input": ["command": "swift test", "run_in_background": true]]]]]],
            ["line": 1, "raw": ["type": "system", "phrenBackground": true, "message": ["role": "user", "content": content]]]
        ]]
        let transcript = try AgentChatTranscript.read(JSONSerialization.data(withJSONObject: frame), source: "claude")
        let jobs = ChatBackgroundJobs.parse(transcript.messages, firstSeen: ["bg-1": Date(timeIntervalSince1970: 10)], now: Date(timeIntervalSince1970: 20))
        XCTAssertEqual(jobs.count, 1)
        XCTAssertEqual(jobs[0].command, "swift test")
        XCTAssertEqual(jobs[0].state, .finished(exitCode: 2))
        XCTAssertTrue(jobs[0].title.contains("completed"))
    }

    /// A background call's tool result comes back at once and only says it
    /// started; that must not read as finished.
    func testBackgroundJobWithOnlyItsStartNoticeIsStillRunningAndFinishedJobsLeaveAfterLingering() throws {
        let frame: [String: Any] = ["type": "backlog", "source": "claude", "entries": [
            ["line": 0, "raw": ["type": "assistant", "message": ["role": "assistant", "content": [["type": "tool_use", "id": "bg-2", "name": "Bash", "input": ["command": "xcodebuild test", "run_in_background": true]]]]]],
            ["line": 1, "raw": ["type": "user", "message": ["role": "user", "content": [["type": "tool_result", "tool_use_id": "bg-2", "content": "Command running in background with ID: b1p4. Output is being written to: /tmp/x.output"]]]]],
        ]]
        let transcript = try AgentChatTranscript.read(JSONSerialization.data(withJSONObject: frame), source: "claude")
        let started = Date(timeIntervalSince1970: 10)
        let running = ChatBackgroundJobs.parse(transcript.messages, firstSeen: ["bg-2": started], now: Date(timeIntervalSince1970: 40))
        XCTAssertEqual(running.map(\.state), [.running])
        XCTAssertEqual(running.first?.startedAt, started)
        XCTAssertTrue(ChatBackgroundJobs.finishedIDs(transcript.messages, firstSeen: ["bg-2": started]).isEmpty)
        // A notification later: finished, and gone once it has lingered.
        let done: [String: Any] = ["line": 2, "raw": ["type": "system", "phrenBackground": true, "message": ["role": "user", "content":
            "<task-notification>\n<tool-use-id>bg-2</tool-use-id>\n<status>completed</status>\n<summary>Background command finished (exit code 0)</summary>\n</task-notification>"]]]
        let later = try AgentChatTranscript.read(JSONSerialization.data(withJSONObject: ["type": "backlog", "source": "claude", "entries": (frame["entries"] as! [[String: Any]]) + [done]]), source: "claude")
        XCTAssertEqual(ChatBackgroundJobs.finishedIDs(later.messages, firstSeen: ["bg-2": started]), ["bg-2"])
        let finishedAt = Date(timeIntervalSince1970: 100)
        let justDone = ChatBackgroundJobs.parse(later.messages, firstSeen: ["bg-2": started], finishedSeen: ["bg-2": finishedAt], now: finishedAt.addingTimeInterval(30))
        XCTAssertEqual(justDone.map(\.state), [.finished(exitCode: 0)])
        XCTAssertEqual(justDone.first?.finishedAt, finishedAt)
        let lingered = ChatBackgroundJobs.parse(later.messages, firstSeen: ["bg-2": started], finishedSeen: ["bg-2": finishedAt], now: finishedAt.addingTimeInterval(ChatBackgroundJobs.finishedLinger + 1))
        XCTAssertTrue(lingered.isEmpty, "Finished jobs leave the row after lingering")
    }

    /// Claude Code also writes the completion as a user turn; that must feed
    /// the jobs row, never draw as a bubble, and a job that finished long ago
    /// (per the row's own timestamp) never appears at all.
    func testNotificationUserTurnsFeedJobsNotBubblesAndOldJobsStayHidden() throws {
        let notice = "<task-notification>\n<task-id>abc</task-id>\n<tool-use-id>bg-3</tool-use-id>\n<status>completed</status>\n<summary>Background command \"Watch deploy\" completed (exit code 0)</summary>\n</task-notification>"
        let frame: [String: Any] = ["type": "backlog", "source": "claude", "entries": [
            ["line": 0, "raw": ["type": "assistant", "timestamp": "2026-09-15T10:00:00.000Z", "message": ["role": "assistant", "content": [["type": "tool_use", "id": "bg-3", "name": "Bash", "input": ["command": "sleep 60", "run_in_background": true]]]]]],
            ["line": 1, "raw": ["type": "user", "timestamp": "2026-09-15T10:00:01.000Z", "message": ["role": "user", "content": [["type": "tool_result", "tool_use_id": "bg-3", "content": "Command running in background with ID: abc"]]]]],
            ["line": 2, "raw": ["type": "user", "timestamp": "2026-09-15T10:01:00.000Z", "message": ["role": "user", "content": notice]]],
        ]]
        let transcript = try AgentChatTranscript.read(JSONSerialization.data(withJSONObject: frame), source: "claude")
        XCTAssertFalse(transcript.messages.contains { $0.role == .user }, "The notification is not a user bubble")
        XCTAssertEqual(transcript.messages.last?.title, "Background notification")
        let finishedAt = Date(timeIntervalSince1970: 1_789_466_460) // 2026-09-15T10:01:00Z
        let soon = ChatBackgroundJobs.parse(transcript.messages, firstSeen: [:], now: finishedAt.addingTimeInterval(30))
        XCTAssertEqual(soon.map(\.state), [.finished(exitCode: 0)])
        XCTAssertEqual(soon.first?.startedAt, Date(timeIntervalSince1970: 1_789_466_400))
        XCTAssertEqual(soon.first?.finishedAt, finishedAt)
        let muchLater = ChatBackgroundJobs.parse(transcript.messages, firstSeen: [:], now: finishedAt.addingTimeInterval(3_600))
        XCTAssertTrue(muchLater.isEmpty, "An hour-old job does not reappear when the chat is opened")
    }

    /// A foreground command that merely prints a background notice (a task
    /// log, a grep) is not a background job.
    func testForegroundCommandQuotingABackgroundNoticeIsNotAJob() throws {
        let frame: [String: Any] = ["type": "backlog", "source": "claude", "entries": [
            ["line": 0, "raw": ["type": "assistant", "message": ["role": "assistant", "content": [["type": "tool_use", "id": "fg-1", "name": "Bash", "input": ["command": "tail -3 /tmp/tasks/b1.output"]]]]]],
            ["line": 1, "raw": ["type": "user", "message": ["role": "user", "content": [["type": "tool_result", "tool_use_id": "fg-1", "content": "TREE: ok\nCommand running in background with ID: b1p4ogscs. Output is being written to: /tmp/x\n** TEST SUCCEEDED **"]]]]],
            ["line": 2, "raw": ["type": "assistant", "message": ["role": "assistant", "content": [["type": "tool_use", "id": "bg-4", "name": "Bash", "input": ["command": "sleep 5"]]]]]],
            ["line": 3, "raw": ["type": "user", "message": ["role": "user", "content": [["type": "tool_result", "tool_use_id": "bg-4", "content": "Command did not complete within its 600s timeout and was moved to the background (ID: b2). Output is being written to: /tmp/y"]]]]],
        ]]
        let transcript = try AgentChatTranscript.read(JSONSerialization.data(withJSONObject: frame), source: "claude")
        let jobs = ChatBackgroundJobs.parse(transcript.messages, firstSeen: [:])
        XCTAssertEqual(jobs.map(\.id), ["bg-4"], "Only the call the agent actually moved to the background")
        XCTAssertEqual(jobs.first?.state, .running)
    }

    func testBackgroundJobStaysRunningWithoutNewHookNotification() throws {
        let messages = try read([["type": "function_call", "call_id": "bg-old", "name": "exec_command",
                                  "arguments": "{\"cmd\":\"swift test\",\"run_in_background\":true}"]])
        let started = Date(timeIntervalSince1970: 10)
        let jobs = ChatBackgroundJobs.parse(messages, firstSeen: ["bg-old": started], now: Date(timeIntervalSince1970: 20))
        XCTAssertEqual(jobs.count, 1)
        XCTAssertEqual(jobs[0].state, .running)
        XCTAssertEqual(jobs[0].startedAt, started)
    }

    func testGroupingRetainsEveryMessageAndNeverCrossesAReply() throws {
        let messages = try read([
            ["type": "function_call_output", "output": "Older result"],
            ["type": "message", "role": "assistant", "content": "Checking the change"],
            ["type": "function_call", "name": "exec_command", "arguments": "{\"cmd\":\"git diff\"}"],
            ["type": "function_call_output", "output": "Patch"],
            ["type": "function_call", "name": "exec_command", "arguments": "{\"cmd\":\"swift test\"}"],
            ["type": "message", "role": "user", "content": "Wait"],
            ["type": "function_call_output", "output": "Test output"]
        ])
        let groups = ChatTimelineEntry.group(messages)
        XCTAssertEqual(groups.flatMap(\.messages), messages)
        XCTAssertEqual(groups.map { $0.messages.count }, [1, 1, 2, 1, 1, 1])
        XCTAssertEqual(groups.map(\.isActivity), [true, false, true, true, false, true])
        XCTAssertEqual(ChatToolSummary(groups[2].messages).count, 1)
        XCTAssertEqual(ChatToolSummary(groups[3].messages).preview, "swift test")
        XCTAssertTrue(ChatTimelineEntry.group([]).isEmpty)
    }

    func testAppendingResultsKeepsTheExpandedGroupIdentity() throws {
        let messages = try read([
            ["type": "function_call", "name": "exec_command", "arguments": "git status"],
            ["type": "function_call_output", "output": "Clean"],
            ["type": "function_call", "name": "exec_command", "arguments": "swift test"]
        ])
        XCTAssertEqual(ChatTimelineEntry.group(Array(messages.prefix(1))).first?.id, ChatTimelineEntry.group(messages).first?.id)
    }

    func testMixedAndResultOnlyGroupsHaveHonestSummaries() throws {
        let messages = try read([
            ["type": "function_call", "name": "exec_command", "arguments": "pwd"],
            ["type": "function_call", "name": "web_search", "arguments": "{\"query\":\"SwiftUI layout\"}"],
            ["type": "function_call_output", "output": "Search output"]
        ])
        let mixed = ChatToolSummary(messages)
        XCTAssertEqual(mixed.title, "Activity")
        XCTAssertEqual(mixed.count, 2)
        XCTAssertEqual(mixed.preview, "SwiftUI layout")
        let result = ChatToolSummary(Array(messages.suffix(1)))
        XCTAssertEqual(result.title, "Tool results")
        XCTAssertEqual(result.preview, "Search output")
        XCTAssertEqual(result.count, 1)
    }

    func testLongPreviewDoesNotTruncateTheActualCommand() throws {
        let command = String(repeating: "echo 👩🏽‍💻; ", count: 100)
        let arguments = String(decoding: try JSONSerialization.data(withJSONObject: ["cmd": command]), as: UTF8.self)
        let messages = try read([["type": "function_call", "name": "functions.exec_command", "arguments": arguments]])
        XCTAssertEqual(ChatToolSummary(messages).title, "Shell")
        XCTAssertEqual(ChatToolSummary(messages).preview, String(command.prefix(180)))
        XCTAssertEqual(ChatTimelineEntry.group(messages).first?.messages.first?.text, arguments)
    }

    func testNestedExecOutputDisplaysOutputAndRetainsFailureAndRawEnvelope() throws {
        let result = try JSONSerialization.data(withJSONObject: ["chunk_id": "123", "output": "diff output\nsecond line", "exit_code": 2])
        let wrapper = try JSONSerialization.data(withJSONObject: [["type": "input_text", "text": String(decoding: result, as: UTF8.self)]])
        let raw = String(decoding: wrapper, as: UTF8.self)
        let display = ToolPresentation(title: "Tool result", text: raw)
        XCTAssertEqual(display.body, "diff output\nsecond line\nExit code: 2")
        XCTAssertEqual(display.raw, raw)
        XCTAssertTrue(ToolPresentation(title: "Tool result", text: "{\"unknown\":42}").body.contains("unknown"))
    }

    func testOrchestratedShellAndPatchAreDecodedWithoutEvaluatingCode() throws {
        let command = "git status\necho '$HOME'"
        let literal = String(decoding: try JSONEncoder().encode(command), as: UTF8.self)
        let display = ToolPresentation(title: "functions.exec", text: "text(await tools.exec_command({cmd:\(literal)}));")
        XCTAssertEqual(display.title, "Shell")
        XCTAssertEqual(display.body, command)
        let dynamic = "await tools.exec_command({cmd:computeCommand()})"
        XCTAssertEqual(ToolPresentation(title: "functions.exec", text: dynamic).body, dynamic)
        let patch = "*** Begin Patch\n*** Update File: Theme.swift\n@@\n-old\n+new\n*** End Patch"
        let patchLiteral = String(decoding: try JSONEncoder().encode(patch), as: UTF8.self)
        let edit = ToolPresentation(title: "functions.exec", text: "text(await tools.apply_patch(\(patchLiteral)));")
        XCTAssertEqual(edit.patch, patch)
        XCTAssertEqual(edit.path, "Theme.swift")
    }

    func testUnifiedDiffNumbersResetAcrossHunksAndHeadersAreNotChanges() {
        let diff = DiffPreview("diff --git a/a b/a\n--- a/a\n+++ b/a\n@@ -7,2 +9,2 @@\n same\n-old\n+new\n@@ -20 +22 @@\n-another\n+replacement")
        XCTAssertEqual(diff.added, 2); XCTAssertEqual(diff.removed, 2)
        XCTAssertEqual(diff.lines.filter { $0.kind == .added }.map(\.new), [10, 22])
        XCTAssertEqual(diff.lines.filter { $0.kind == .removed }.map(\.old), [8, 20])
        let malformed = DiffPreview("@@ - + @@\n+x")
        XCTAssertNil(malformed.lines.last?.new)
    }

    func testParallelOutputsFollowTheirOwnCallIDsAndRepliesKeepTheirPosition() throws {
        let messages = try read([
            ["type": "function_call", "call_id": "a", "name": "exec_command", "arguments": "first"],
            ["type": "function_call", "call_id": "b", "name": "exec_command", "arguments": "second"],
            ["type": "function_call_output", "call_id": "b", "output": "second result"],
            ["type": "function_call_output", "call_id": "a", "output": "first result"],
            ["type": "message", "role": "assistant", "content": "Done"],
            ["type": "function_call_output", "call_id": "a", "output": "Later output"]
        ])
        let groups = ChatTimelineEntry.group(messages)
        XCTAssertEqual(groups.map { $0.messages.map(\.text) }, [["first", "first result"], ["second", "second result"], ["Done"], ["Later output"]])
        XCTAssertEqual(Set(groups.flatMap(\.messages).map(\.id)), Set(messages.map(\.id)))
        XCTAssertEqual(groups[1].id, ChatTimelineEntry.group(Array(messages.prefix(2)))[1].id)
    }

    func testUnknownOrAmbiguousResultIDsNeverAttachToAnotherCall() throws {
        let messages = try read([
            ["type": "function_call", "call_id": "same", "name": "exec_command", "arguments": "one"],
            ["type": "function_call", "call_id": "same", "name": "exec_command", "arguments": "two"],
            ["type": "function_call_output", "call_id": "same", "output": "ambiguous"],
            ["type": "function_call_output", "call_id": "absent", "output": "unmatched"],
            ["type": "function_call_output", "output": "unidentified"]
        ])
        XCTAssertEqual(ChatTimelineEntry.group(messages).map { $0.messages.count }, [1, 1, 1, 1, 1])
    }

    func testToolPreviewBoundsManyLinesAndLongUnicodeWithoutLosingSource() throws {
        XCTAssertEqual(ToolPresentation(title: "mcp__phren__get_tasks", text: "{}").title, "Phren · Get Tasks")
        let output = (0..<2_000).map { "Line \($0)" }.joined(separator: "\n")
        let display = ToolPresentation(title: "Tool result", text: output)
        XCTAssertEqual(ToolOutputPreview(display.body).text, "Line 0\nLine 1\nLine 2\nLine 3\nLine 4\nLine 5…")
        XCTAssertEqual(display.body, output)
        let unicode = String(repeating: "👩🏽‍💻", count: 1_000)
        XCTAssertEqual(ToolOutputPreview(unicode).text, String(unicode.prefix(640)) + "…")
        XCTAssertEqual(ToolOutputPreview("Small output").text, "Small output")
    }

    func testDenseOutputPagesBoundLayoutAndPreserveEverySourceByte() {
        let source = String(repeating: "x\n", count: 8_000) + "Final output marker"
        let output = ToolOutputPages(source)
        XCTAssertEqual(output.totalLines, 8_001)
        XCTAssertEqual(output.pages.first?.firstLine, 1)
        XCTAssertEqual(output.pages.first?.lastLine, 120)
        XCTAssertEqual(output.pages[1].firstLine, 121)
        XCTAssertEqual(output.pages.last?.lastLine, 8_001)
        XCTAssertTrue(output.pages.last!.text.contains("Final output marker"))
        XCTAssertEqual(Data(output.pages.map(\.text).joined().utf8), Data(source.utf8))
        XCTAssertEqual(output.source, source, "Copy output retains the complete provider text")
        for page in output.pages {
            XCTAssertLessThanOrEqual(page.text.count, 4_000)
            XCTAssertLessThanOrEqual(page.displayText.split(omittingEmptySubsequences: false, whereSeparator: \.isNewline).count, 120)
        }
    }

    func testOutputPagesPreserveLongUnicodeLinesMixedNewlinesAndEmptyOutput() {
        let sources = ["", "Small output\n", String(repeating: "👩🏽‍💻", count: 12_000) + "Final marker",
                       String(repeating: "first\r\n\n👩🏽‍💻 e\u{301}\rline\u{2028}", count: 500) + "tail\n"]
        for source in sources {
            let output = ToolOutputPages(source)
            XCTAssertFalse(output.pages.isEmpty)
            XCTAssertEqual(Data(output.pages.map(\.text).joined().utf8), Data(source.utf8))
            for page in output.pages {
                XCTAssertLessThanOrEqual(page.text.count, 4_000)
                XCTAssertLessThanOrEqual(page.displayText.split(omittingEmptySubsequences: false, whereSeparator: \.isNewline).count, 120)
            }
        }
        let longLine = ToolOutputPages(sources[2])
        XCTAssertEqual(longLine.pages.count, 4)
        XCTAssertTrue(longLine.pages.allSatisfy { $0.firstLine == 1 && $0.lastLine == 1 })
        XCTAssertEqual(ToolPresentation(title: "Tool result", text: "\n\nPreview\n" + sources[2]).preview, "Preview")
    }

    /// Rows as the Hook writes them, so a `phren_changes` attachment can ride
    /// next to its payload.
    private func readRaw(_ raws: [[String: Any]]) throws -> [AgentChatMessage] {
        try AgentChatTranscript.read(JSONSerialization.data(withJSONObject: ["type": "backlog", "source": "codex", "totalLines": raws.count,
            "entries": raws.enumerated().map { ["line": $0.offset, "raw": $0.element] }]), source: "codex").messages
    }

    private func read(_ payloads: [[String: Any]]) throws -> [AgentChatMessage] {
        try AgentChatTranscript.read(JSONSerialization.data(withJSONObject: ["type": "backlog", "source": "codex", "totalLines": payloads.count,
            "entries": payloads.enumerated().map { ["line": $0.offset, "raw": ["type": "response_item", "payload": $0.element]] }]), source: "codex").messages
    }
}
