import Foundation
import PhrenKit
import XCTest
@testable import Phren

final class ChatTurnChangesTests: XCTestCase {
    func testCodexTurnCollectsPatchesAndHookChanges() throws {
        let themePatch = "diff --git a/Theme.swift b/Theme.swift\nindex 1..2 100644\n--- a/Theme.swift\n+++ b/Theme.swift\n@@ -1,3 +1,3 @@\n import SwiftUI\n-let accent = green\n+let accent = purple\n let radius = 12\n"
        let newPatch = "diff --git a/Notes.md b/Notes.md\nnew file mode 100644\n--- /dev/null\n+++ b/Notes.md\n@@ -0,0 +1,2 @@\n+one\n+two\n"
        let frame = try codex([
            message("user", "Recolor the app"), event("task_started", at: 1000),
            call("patch", name: "apply_patch", input: "*** Begin Patch\n*** Update File: Theme.swift\n@@\n-let action = green\n+let action = purple\n*** Add File: Docs/Colors.md\n+# Colors\n+Purple\n*** End Patch"),
            output("patch", "Done"),
            ["type": "response_item", "payload": ["type": "function_call", "call_id": "shell", "name": "exec_command", "arguments": "{\"cmd\":\"python3 fix.py\"}"]],
            ["type": "response_item", "payload": ["type": "function_call_output", "call_id": "shell", "output": "ok"],
             "phren_changes": ["shell": [["root": "/work/phone", "path": "Theme.swift", "status": "M", "added": 1, "removed": 1, "patch": themePatch],
                                         ["root": "/work/phone", "path": "Notes.md", "status": "A", "added": 2, "removed": 0, "patch": newPatch]]]],
            message("assistant", "Recolored."), event("task_complete", at: 1042),
            message("user", "Thanks"), event("task_started", at: 1100), message("assistant", "Anytime."), event("task_complete", at: 1101),
        ])
        var progress = AgentChatProgress(); progress.receive(frame)
        var prepared = ChatTranscriptPreparation()
        prepared.update(frame.messages, activity: .init(turns: progress.turns))
        let rows = prepared.entries.compactMap(\.turnChanges)
        XCTAssertEqual(rows.count, 1, "A turn that changed nothing has no row")
        let changes = try XCTUnwrap(rows.first)
        XCTAssertEqual(changes.files.map(\.path), ["Theme.swift", "Docs/Colors.md", "Notes.md"])
        XCTAssertEqual(changes.files.map(\.status), ["M", "A", "A"])
        let theme = try XCTUnwrap(changes.files.first)
        XCTAssertEqual([theme.added, theme.removed], [2, 2], "Both edits of one file add up")
        XCTAssertEqual([changes.added, changes.removed], [6, 2])
        XCTAssertEqual(changes.title, "3 files changed")
        // The row closes the turn: after its reply, before the next message.
        let index = try XCTUnwrap(prepared.entries.firstIndex { $0.turnChanges != nil })
        XCTAssertEqual(prepared.entries[index - 1].messages.first?.text, "Recolored.")
        XCTAssertEqual(prepared.entries[index + 1].messages.first?.text, "Thanks")
        XCTAssertEqual(prepared.entries[index].id, "changes:0:0")
        XCTAssertEqual(prepared.entries[index].placeholderIdentifier, "chat-turn-changes:0:0")
        XCTAssertEqual(prepared.entries[index].placeholderLabel, "3 files changed, 6 added, 2 removed")
        // The combined patch draws as one file with both hunks.
        let document = DiffDocument(patch: theme.patch)
        XCTAssertEqual([document.added, document.removed], [2, 2])
    }

    func testClaudeTurnFoldsAbsoluteAndRelativePathsAndAWorkingTurnHasNoRow() throws {
        let hookPatch = "diff --git a/Sources/App.swift b/Sources/App.swift\n--- a/Sources/App.swift\n+++ b/Sources/App.swift\n@@ -4,1 +4,1 @@\n-let size = 1\n+let size = 2\n"
        let raws: [[String: Any]] = [
            claude("user", "Fix the app", at: 1000),
            claudeCall("edit", "Edit", ["file_path": "/work/phone/Sources/App.swift", "old_string": "let name = \"a\"", "new_string": "let name = \"b\""], at: 1001),
            claudeResult("edit", "Updated", at: 1002),
            claudeCall("missing", "Edit", ["file_path": "/work/phone/Missing.swift", "old_string": "x", "new_string": "y"], at: 1003),
            claudeResult("missing", "String not found", error: true, at: 1004),
            claudeCall("write", "Write", ["file_path": "/work/phone/New.swift", "content": "let a = 1\nlet b = 2"], at: 1005),
            claudeResult("write", "Created", at: 1006),
            claudeCall("sed", "Bash", ["command": "sed -i s/1/2/ Sources/App.swift"], at: 1007),
            {
                var result = claudeResult("sed", "", at: 1008)
                result["phren_changes"] = ["sed": [["root": "/work/phone", "path": "Sources/App.swift", "status": "M", "added": 1, "removed": 1, "patch": hookPatch]]]
                return result
            }(),
            claudeFinal("Fixed.", at: 1010),
        ]
        let frame = try AgentChatTranscript.read(JSONSerialization.data(withJSONObject: ["type": "backlog", "source": "claude", "totalLines": raws.count,
            "entries": raws.enumerated().map { ["line": $0.offset, "raw": $0.element] }]), source: "claude")
        var progress = AgentChatProgress(); progress.receive(frame)
        var prepared = ChatTranscriptPreparation()
        prepared.update(frame.messages, activity: .init(turns: progress.turns))
        let changes = try XCTUnwrap(prepared.entries.compactMap(\.turnChanges).first)
        XCTAssertEqual(changes.files.map(\.path), ["Sources/App.swift", "/work/phone/New.swift"])
        XCTAssertEqual(changes.files.map(\.status), ["M", "A"])
        XCTAssertEqual([changes.files[0].added, changes.files[0].removed], [2, 2])
        XCTAssertEqual([changes.files[1].added, changes.files[1].removed], [2, 0])
        XCTAssertEqual(prepared.entries.last?.turnChanges, changes)
        // Inside the pane's folder, a Write's absolute path reads relative too.
        var rooted = ChatTranscriptPreparation()
        rooted.update(frame.messages, activity: .init(turns: progress.turns, workingDirectory: "/work/phone"))
        XCTAssertEqual(rooted.entries.compactMap(\.turnChanges).first?.files.map(\.path), ["Sources/App.swift", "New.swift"])

        // The same rows while the turn still works: no row yet.
        let working = Array(frame.messages.dropLast())
        var live = ChatTranscriptPreparation()
        var running = AgentChatProgress()
        let open = try AgentChatTranscript.read(JSONSerialization.data(withJSONObject: ["type": "backlog", "source": "claude", "totalLines": raws.count - 1,
            "entries": raws.dropLast().enumerated().map { ["line": $0.offset, "raw": $0.element] }]), source: "claude")
        running.receive(open)
        live.update(working, activity: .init(turns: running.turns, busy: true))
        XCTAssertFalse(live.entries.contains { $0.turnChanges != nil })
    }

    func testPiecesSplitApplyPatchAndUnifiedForms() {
        let pieces = ChatTurnChanges.pieces("*** Begin Patch\n*** Update File: a.swift\n*** Move to: b.swift\n@@\n-x\n+y\n*** Delete File: c.swift\n*** End Patch\n")
        XCTAssertEqual(pieces.map(\.path), ["a.swift", "c.swift"])
        XCTAssertEqual(pieces.map(\.status), ["M", "D"])
        XCTAssertEqual(pieces[0].lines, ["@@", "-x", "+y"])
        let unified = ChatTurnChanges.pieces("diff --git a/gone.txt b/gone.txt\ndeleted file mode 100644\n--- a/gone.txt\n+++ /dev/null\n@@ -1 +0,0 @@\n-bye\n")
        XCTAssertEqual(unified, [.init(path: "gone.txt", status: "D", lines: ["@@ -1 +0,0 @@", "-bye"])])
    }

    // MARK: - Transcript rows

    private func message(_ role: String, _ text: String) -> [String: Any] {
        ["type": "response_item", "payload": ["type": "message", "role": role, "content": text]]
    }
    private func event(_ type: String, at seconds: Double) -> [String: Any] {
        ["type": "event_msg", "timestamp": Date(timeIntervalSince1970: seconds).ISO8601Format(),
         "payload": ["type": type, "started_at": seconds, "completed_at": seconds]]
    }
    private func call(_ id: String, name: String, input: String) -> [String: Any] {
        ["type": "response_item", "payload": ["type": "custom_tool_call", "call_id": id, "name": name, "input": input]]
    }
    private func output(_ id: String, _ text: String) -> [String: Any] {
        ["type": "response_item", "payload": ["type": "custom_tool_call_output", "call_id": id, "output": text]]
    }
    private func codex(_ raws: [[String: Any]]) throws -> AgentChatTranscript {
        try AgentChatTranscript.read(JSONSerialization.data(withJSONObject: ["type": "backlog", "source": "codex", "totalLines": raws.count,
            "entries": raws.enumerated().map { ["line": $0.offset, "raw": $0.element] }]), source: "codex")
    }
    private func stamp(_ seconds: Double) -> String { Date(timeIntervalSince1970: seconds).ISO8601Format() }
    private func claude(_ role: String, _ text: String, at seconds: Double) -> [String: Any] {
        ["type": role, "timestamp": stamp(seconds), "message": ["role": role, "content": text]]
    }
    private func claudeCall(_ id: String, _ name: String, _ input: [String: Any], at seconds: Double) -> [String: Any] {
        ["type": "assistant", "timestamp": stamp(seconds),
         "message": ["role": "assistant", "content": [["type": "tool_use", "id": id, "name": name, "input": input]]]]
    }
    private func claudeResult(_ id: String, _ text: String, error: Bool = false, at seconds: Double) -> [String: Any] {
        var block: [String: Any] = ["type": "tool_result", "tool_use_id": id, "content": text]
        if error { block["is_error"] = true }
        return ["type": "user", "timestamp": stamp(seconds), "message": ["role": "user", "content": [block]]]
    }
    private func claudeFinal(_ text: String, at seconds: Double) -> [String: Any] {
        ["type": "assistant", "timestamp": stamp(seconds),
         "message": ["role": "assistant", "stop_reason": "end_turn", "content": [["type": "text", "text": text]]]]
    }
}
