import XCTest
import PhrenKit
@testable import Phren

final class ChatTimelineTests: XCTestCase {
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

    private func read(_ payloads: [[String: Any]]) throws -> [AgentChatMessage] {
        try AgentChatTranscript.read(JSONSerialization.data(withJSONObject: ["type": "backlog", "source": "codex", "totalLines": payloads.count,
            "entries": payloads.enumerated().map { ["line": $0.offset, "raw": ["type": "response_item", "payload": $0.element]] }]), source: "codex").messages
    }
}
