#if DEBUG && targetEnvironment(simulator)
import Foundation

/// `--chat-turn-changes` (Codex) and `--chat-turn-changes-claude`: one
/// finished turn that edited three files through a patch call and a shell
/// command the Hook measured, so its end carries the turn's diff row.
extension AgentChatFixture {
    static func appendTurnChanges(to entries: inout [[String: Any]], source: String) throws {
        let started = Date.now.addingTimeInterval(-300)
        func stamp(_ offset: TimeInterval) -> String { started.addingTimeInterval(offset).formatted(.iso8601) }
        func add(_ raw: [String: Any]) { entries.append(["line": entries.count, "raw": raw]) }
        let hookPatch = "diff --git a/Sources/Theme.swift b/Sources/Theme.swift\n--- a/Sources/Theme.swift\n+++ b/Sources/Theme.swift\n@@ -1,4 +1,4 @@\n import SwiftUI\n-let accent = green\n+let accent = purple\n let radius = 12\n let spacing = 8\n"
        let notesPatch = "diff --git a/Docs/Colors.md b/Docs/Colors.md\nnew file mode 100644\n--- /dev/null\n+++ b/Docs/Colors.md\n@@ -0,0 +1,3 @@\n+# Colors\n+\n+Actions use phren purple.\n"
        let hookFiles: [[String: Any]] = [
            ["root": root, "path": "Sources/Theme.swift", "status": "M", "added": 1, "removed": 1, "patch": hookPatch],
            ["root": root, "path": "Docs/Colors.md", "status": "A", "added": 3, "removed": 0, "patch": notesPatch],
        ]
        let request = "Use phren purple for actions and note it in the docs."
        let reply = "Actions are purple now, and Docs/Colors.md says why."
        if source == "claude" {
            add(["type": "user", "timestamp": stamp(0), "message": ["role": "user", "content": request]])
            add(["type": "assistant", "timestamp": stamp(4), "message": ["role": "assistant", "content": [["type": "tool_use", "id": "turn-edit", "name": "Edit",
                "input": ["file_path": root + "/Sources/Button.swift", "old_string": "    .tint(.green)\n    .font(.body)", "new_string": "    .tint(PhrenTheme.accent)\n    .font(PhrenTypography.body)"]]]]])
            add(["type": "user", "timestamp": stamp(5), "message": ["role": "user", "content": [["type": "tool_result", "tool_use_id": "turn-edit", "content": "Updated"]]]])
            add(["type": "assistant", "timestamp": stamp(8), "message": ["role": "assistant", "content": [["type": "tool_use", "id": "turn-shell", "name": "Bash",
                "input": ["command": "python3 scripts/recolor.py", "description": "Recolor the theme"]]]]])
            add(["type": "user", "timestamp": stamp(12), "message": ["role": "user", "content": [["type": "tool_result", "tool_use_id": "turn-shell", "content": "Recolored 1 file"]]],
                 "phren_changes": ["turn-shell": hookFiles]])
            add(["type": "assistant", "timestamp": stamp(48), "message": ["role": "assistant", "stop_reason": "end_turn", "content": [["type": "text", "text": reply]]]])
        } else {
            add(["type": "response_item", "payload": ["type": "message", "role": "user", "content": request]])
            add(["type": "event_msg", "payload": ["type": "task_started", "started_at": started.timeIntervalSince1970]])
            add(["type": "response_item", "payload": ["type": "custom_tool_call", "call_id": "turn-patch", "name": "apply_patch",
                "input": "*** Begin Patch\n*** Update File: Sources/Button.swift\n@@\n-    .tint(.green)\n-    .font(.body)\n+    .tint(PhrenTheme.accent)\n+    .font(PhrenTypography.body)\n*** End Patch"]])
            add(["type": "response_item", "payload": ["type": "custom_tool_call_output", "call_id": "turn-patch", "output": "Success. Updated Sources/Button.swift"]])
            add(["type": "response_item", "payload": ["type": "function_call", "call_id": "turn-shell", "name": "exec_command",
                "arguments": String(decoding: try JSONSerialization.data(withJSONObject: ["cmd": "python3 scripts/recolor.py"]), as: UTF8.self)]])
            add(["type": "response_item", "payload": ["type": "function_call_output", "call_id": "turn-shell", "output": "Recolored 1 file"],
                 "phren_changes": ["turn-shell": hookFiles]])
            add(["type": "response_item", "payload": ["type": "message", "role": "assistant", "content": reply]])
            add(["type": "event_msg", "payload": ["type": "task_complete", "completed_at": started.addingTimeInterval(48).timeIntervalSince1970]])
        }
    }
}
#endif
