#if DEBUG && targetEnvironment(simulator)
import Foundation
import PhrenKit
import PhrenLive
import UIKit

/// Isolated, in-memory conversations for UI tests; never active on an iPhone.
@MainActor enum AgentChatFixture {
    static var enabled: Bool { AppModel.isUITesting && ProcessInfo.processInfo.arguments.contains("--native-chat-fixture") }
    static var sent: [(String, String)] = []
    static var startingAttachedAt: Date?
    static let startingToken = String(repeating: "a", count: 64)
    static var reads = 0
    private static var heavyFrames: [String: AgentChatTranscript] = [:]
    static var hasReadTranscript = false
    static var sendAttempts = 0
    static var streamStarts: [String: Date] = [:]
    static var streamed: Set<String> = []
    static var lastStreamLine: [String: Int] = [:]
    static func beginStream(_ target: AgentChatTarget) {
        streamed.remove(target.id)
        lastStreamLine.removeValue(forKey: target.id)
    }
    static let streamingReply = "The reply is arriving word by word. " + String(repeating: "You can follow the changes as they arrive without losing your place in the conversation. ", count: 8)
    static var stopped = false
    static var answered = false
    static var denied = false
    static let approvalExpiry = Date.ISO8601FormatStyle(includingFractionalSeconds: true).format(Date().addingTimeInterval(55))
    static func approval(_ target: AgentChatTarget) throws -> AgentApproval? {
        guard flag("--chat-approval"), !answered else { return nil }
        return try AgentInteractionStatus.read(JSONSerialization.data(withJSONObject: ["agentStatus": ["source": target.source, "session": target.sessionID, "pendingApproval": ["actionId": "fixture-action", "title": "Run project tests", "message": "npm test", "expiresAt": approvalExpiry]]]), target: target)?.approval
    }
    static var uploads = 0
    static var image: AgentAttachment {
        let data = UIGraphicsImageRenderer(size: CGSize(width: 120, height: 90)).pngData { context in
            UIColor.cyan.setFill(); context.fill(CGRect(x: 0, y: 0, width: 120, height: 90))
        }
        return try! AgentAttachment(name: "Screenshot.png", data: data, isImage: true)
    }
    /// What the computer would send back for a picture in the conversation:
    /// the fixture picture for any transcript block, and for an upload only
    /// when the path is one the fixture's own turns name.
    static func imageBytes(_ reference: ChatImageReference) throws -> Data {
        if case .upload(let path) = reference, !path.hasPrefix("/work/phone/uploads/") { throw LiveConnectionError.response(404) }
        return image.data
    }
    static func upload(_ attachment: AgentAttachment) throws -> String {
        uploads += 1
        if flag("--chat-upload-fails") { throw LiveConnectionError.disconnected }
        return "/tmp/phren-fixture/" + attachment.uploadName
    }
    static func older(_ target: AgentChatTarget, beforeLine: Int) throws -> AgentChatTranscript {
        if flag("--chat-metadata-history"), beforeLine > 10 {
            return try AgentChatTranscript.read(JSONSerialization.data(withJSONObject: ["type": "older", "source": target.source,
                "entries": [], "startLine": 10, "totalLines": 22, "hasMore": true]), source: target.source)
        }
        let raw: [String: Any] = ["type": "response_item", "payload": ["type": "message", "role": "assistant", "content": [["type": "output_text", "text": "Earlier project discussion"]]]]
        return try AgentChatTranscript.read(JSONSerialization.data(withJSONObject: ["type": "older", "source": target.source, "entries": [["line": 0, "raw": raw]], "startLine": 0, "totalLines": flag("--chat-long-history") ? 42 : 22, "hasMore": false]), source: target.source)
    }
    static func panes(_ session: LiveAgentSession) throws -> AgentChatPanes {
        reads += 1
        if flag("--chat-offline") && hasReadTranscript { throw LiveConnectionError.disconnected }
        // A session launched from a project runs the harness that was picked.
        let launchedKind = launches.last.map(\.kind).flatMap { session.workspaceID == "w9" ? $0 : nil }
        let agent = launchedKind ?? (flag("--chat-copilot") ? "copilot" : (flag("--chat-claude-queue") || flag("--chat-claude-image") || flag("--chat-read-images")) ? "claude" : "codex")
        var panes: [[String: Any]] = [["id": "\(session.workspaceID):p1", "label": "1", "title": "Polish the phone app", "agent": agent,
                                     "agentStatus": ((flag("--chat-blocked") || flag("--chat-approval") || flag("--chat-question")) && !answered) ? "blocked" : (flag("--chat-working") && !stopped ? "working" : "idle"), "sessionId": agent == "copilot" ? "00000000-0000-0000-0000-000000000023" : "fixture-\(agent)-session", "cwd": "/work/phone"]]
        if flag("--starting-session-fixture") {
            panes[0]["startingToken"] = startingToken
            if startingAttachedAt == nil || Date.now < startingAttachedAt! {
                panes[0].removeValue(forKey: "sessionId")
                panes[0]["starting"] = true
                panes[0]["agentStatus"] = "idle"
            }
        }
        if flag("--chat-multiple") {
            panes.append(["id": "\(session.workspaceID):p2", "label": "2", "title": "Review the changes", "agent": "claude", "agentStatus": "idle", "sessionId": "fixture-claude-session"])
        }
        return try AgentChatPanes.read(JSONSerialization.data(withJSONObject: ["kind": "herdr", "groupId": session.workspaceID, "childId": session.tab.id, "panes": panes]),
                                       workspaceID: session.workspaceID, tabID: session.tab.id)
    }
    static func transcript(_ target: AgentChatTarget) throws -> AgentChatTranscript {
        hasReadTranscript = true
        if flag("--chat-heavy") {
            if let cached = heavyFrames[target.source] { return cached }
            let frame = try AgentChatTranscript.read(ChatHeavyFixture.data(source: target.source), source: target.source)
            heavyFrames[target.source] = frame
            return frame
        }
        if flag("--chat-streaming") { return try streamingTranscript(target) }
        var entries: [[String: Any]] = []
        func append(_ role: String, _ text: String) {
            let raw: [String: Any] = target.source == "copilot"
                ? ["type": role + ".message", "data": ["content": text]]
                : target.source == "codex"
                ? ["type": "response_item", "payload": ["type": "message", "role": role, "content": [["type": "text", "text": text]]]]
                : ["type": role, "message": ["role": role, "content": [["type": "text", "text": text]]]]
            entries.append(["line": (flag("--chat-history") ? 20 : 0) + entries.count, "raw": raw])
        }
        if !flag("--starting-session-fixture") {
        append("user", "Can you refine the project screen?")
        append("assistant", target.source == "codex" ? "The project screen is ready. What would you like to change?" : target.source == "copilot" ? "Copilot is connected to this project. What would you like to change?" : "I reviewed the changes. The project navigation looks consistent.")
        }
        if flag("--chat-write-changes") {
            let patch = "diff --git a/Created.swift b/Created.swift\nnew file mode 100644\n--- /dev/null\n+++ b/Created.swift\n@@ -0,0 +1,2 @@\n+let one = 1\n+let two = 2\n"
            for (call, name, input) in [
                ("write-captured", "Write", ["file_path": "Created.swift", "content": "let one = 1\nlet two = 2"]),
                ("write-fallback", "Write", ["file_path": "Fallback.swift", "content": "let fallback = true"]),
                ("edit-fallback", "Edit", ["file_path": "Edited.swift", "old_string": "let value = 1", "new_string": "let value = 2"])
            ] {
                let arguments = String(decoding: try JSONSerialization.data(withJSONObject: input), as: UTF8.self)
                entries.append(["line": entries.count, "raw": ["type": "response_item", "payload": ["type": "function_call", "call_id": call, "name": name, "arguments": arguments]]])
                var result: [String: Any] = ["type": "response_item", "payload": ["type": "function_call_output", "call_id": call, "output": "Done"]]
                if call == "write-captured" { result["phren_changes"] = [call: [["root": "/work/phone", "path": "Created.swift", "status": "A", "patch": patch, "added": 2, "removed": 0]]] }
                entries.append(["line": entries.count, "raw": result])
            }
        }
        if flag("--chat-long-history") {
            for index in 0..<20 { append("assistant", "Recent discussion \(index). " + String(repeating: "Keep the current message visible while older history loads. ", count: 3)) }
        }
        if flag("--chat-commands") {
            append("user", "<command-name>/model</command-name>\n            <command-message>model</command-message>\n            <command-args></command-args>")
            append("user", "<local-command-stdout>Set model to Opus 5 (1M context) and saved as your default for new sessions</local-command-stdout>")
            append("user", "<bash-input>pwd</bash-input>")
            append("user", "<bash-stdout>/home/alaarab/Projects/hub</bash-stdout><bash-stderr></bash-stderr>")
        }
        if flag("--chat-design") {
            append("user", "Make the conversation easier to read. Keep the details close by.")
            append("assistant", "I'll tighten the session header and give each tool call its own compact row. Replies will have more room to breathe.\n\n")
            for (command, output) in [("git diff --stat", "3 files changed, 42 insertions(+), 18 deletions(-)"), ("swift test --filter ChatTimelineTests", "All 4 timeline tests passed.")] {
                let arguments = String(decoding: try JSONSerialization.data(withJSONObject: ["cmd": command]), as: UTF8.self)
                entries.append(["line": entries.count, "raw": ["type": "response_item", "payload": ["type": "function_call", "name": "exec_command", "arguments": arguments]]])
                entries.append(["line": entries.count, "raw": ["type": "response_item", "payload": ["type": "function_call_output", "output": output]]])
            }
            append("assistant", "The conversation has a quieter layout now. Commands and results stay together; expand one Shell row at a time.\n\nThe terminal is one tap away in the header, and your draft stays with this session when you come back.")
        }
        if flag("--chat-read-run") {
            for (index, item) in [("Read", "{\"file_path\":\"/work/phone/File.swift\"}"),
                                  ("Grep", "{\"pattern\":\"TODO\",\"path\":\"/work/phone\"}"),
                                  ("exec_command", "{\"cmd\":\"git status --short\"}")] .enumerated() {
                let id = "fixture-read-\(index)"
                entries.append(["line": entries.count, "raw": ["type": "response_item", "payload": ["type": "function_call", "call_id": id, "name": item.0, "arguments": item.1]]])
                entries.append(["line": entries.count, "raw": ["type": "response_item", "payload": ["type": "function_call_output", "call_id": id, "output": "read output \(index)"]]])
            }
        }
        if flag("--chat-shell-run") {
            // Eight commands in a row, one of which changed a file: the looking
            // around folds either side of the call that wrote something.
            let patch = "diff --git a/Changed.swift b/Changed.swift\n--- a/Changed.swift\n+++ b/Changed.swift\n@@ -1,2 +1,2 @@\n import SwiftUI\n-let value = 1\n+let value = 2\n"
            for (index, command) in ["swift build", "git log --oneline -5", "rg TODO Sources", "make fmt",
                                     "swift test --filter ChatTimelineTests", "ls -R Sources | head -20",
                                     "git status --short", "wc -l Sources/App.swift"].enumerated() {
                let id = "shell-run-\(index)"
                let arguments = String(decoding: try JSONSerialization.data(withJSONObject: ["cmd": command]), as: UTF8.self)
                entries.append(["line": entries.count, "raw": ["type": "response_item", "payload": ["type": "function_call", "call_id": id, "name": "exec_command", "arguments": arguments]]])
                var result: [String: Any] = ["type": "response_item", "payload": ["type": "function_call_output", "call_id": id, "output": "command output \(index)"]]
                if index == 3 { result["phren_changes"] = [id: [["root": "/work/phone", "path": "Changed.swift", "status": "M", "added": 1, "removed": 1, "patch": patch]]] }
                entries.append(["line": entries.count, "raw": result])
            }
            append("assistant", "The formatter touched one file; everything else was a look.")
        }
        if flag("--chat-long-tools") || flag("--chat-dense-tools") {
            for index in 0..<3 {
                let id = "long-tool-\(index)"
                let output = flag("--chat-dense-tools")
                    ? String(repeating: "x\n", count: 8_000) + "Final dense output marker \(index)"
                    : (0..<1_500).map { "Tool \(index) line \($0): build output" }.joined(separator: "\n") + "\nFinal output marker \(index)"
                entries.append(["line": entries.count, "raw": ["type": "response_item", "payload": ["type": "function_call", "call_id": id, "name": "exec_command", "arguments": "{\"cmd\":\"check-step-\(index)\"}"]]])
                entries.append(["line": entries.count, "raw": ["type": "response_item", "payload": ["type": "function_call_output", "call_id": id, "output": output]]])
            }
            append("assistant", "Each command has its own output.")
        }
        if flag("--chat-diffs") {
            // A Read of a screenshot: the image rides inside the tool result.
            entries.append(["line": entries.count, "raw": ["type": "response_item", "payload": ["type": "function_call", "call_id": "read-png", "name": "Read", "arguments": "{\"file_path\":\"/work/phone/shots/home.png\"}"]]])
            entries.append(["line": entries.count, "raw": ["type": "response_item", "payload": ["type": "function_call_output", "call_id": "read-png", "output": [["type": "input_image", "image_url": "data:image/png;base64,"]]]]])
        }
        if flag("--chat-diffs") || flag("--chat-dense-diff") {
            let patch = flag("--chat-dense-diff")
                ? "*** Begin Patch\n*** Update File: Dense.swift\n@@\n" + String(repeating: "+x\n", count: 2_000) + "+Final dense patch marker\n*** End Patch"
                : "*** Begin Patch\n*** Update File: Theme.swift\n@@\n-let action = green\n+let action = phrenPurple\n*** End Patch"
            entries.append(["line": entries.count, "raw": ["type": "response_item", "payload": ["type": "custom_tool_call", "name": "apply_patch", "input": patch]]])
            let output = String(decoding: try JSONSerialization.data(withJSONObject: ["chunk_id": "fixture", "output": "Updated Theme.swift", "exit_code": 0]), as: UTF8.self)
            entries.append(["line": entries.count, "raw": ["type": "response_item", "payload": ["type": "function_call_output", "output": [["type": "input_text", "text": output]]]]])
        }
        if flag("--chat-diffs") {
            // A shell-driven edit: the card can only show what ran, so it
            // offers the repository diff for what changed.
            entries.append(["line": entries.count, "raw": ["type": "response_item", "payload": ["type": "function_call", "call_id": "edit-py", "name": "exec_command",
                "arguments": "{\"cmd\":\"python3 - <<'EOF'\\np='Theme.swift'\\ns=open(p).read().replace('green','purple')\\nopen(p,'w').write(s)\\nopen('/Users/fixture/.phren/phone/FINDINGS.md','a').write('- Accent is purple now\\\\n')\\nEOF\"}"]]])
            // Phren Hook attaches what the command changed on disk to its output row.
            entries.append(["line": entries.count, "raw": ["type": "response_item", "payload": ["type": "function_call_output", "call_id": "edit-py", "output": "{\"output\":\"\",\"exit_code\":0}"],
                "phren_changes": ["edit-py": [
                    ["root": "/work/phone", "path": "Theme.swift", "status": "M", "added": 1, "removed": 1, "patch": "diff --git a/Theme.swift b/Theme.swift\nindex 1..2 100644\n--- a/Theme.swift\n+++ b/Theme.swift\n@@ -1,3 +1,3 @@\n import SwiftUI\n-let accent = green\n+let accent = purple\n let radius = 12\n"],
                    ["root": "/Users/fixture/.phren", "path": "phone/FINDINGS.md", "status": "M", "added": 3, "removed": 2, "patch": "diff --git a/phone/FINDINGS.md b/phone/FINDINGS.md\n--- a/phone/FINDINGS.md\n+++ b/phone/FINDINGS.md\n@@ -2,3 +2,5 @@\n - Tiles are one sprite\n-- Offline first\n-- Old note\n+- Accent is purple now\n+- Offline first, always\n+- Geocoder batches at 8/s\n"]]]]])
        }
        if flag("--chat-phren-tools") {
            let calls: [(String, String, [String: Any], [String: Any])] = [
                ("finding", "add_finding", ["project": "phone", "findingType": "pitfall", "finding": String(repeating: "Keep queue identities when a real turn replaces its pending copy. ", count: 12)], ["ok": true]),
                ("task", "add_task", ["project": "phone", "task": "Verify pasted images in chat"], ["ok": true]),
                ("complete", "manage_task", ["project": "phone", "action": "complete", "item": "Pin curated font downloads"], ["ok": true]),
                ("search", "search_knowledge", ["project": "phone", "query": "chat navigation"], ["ok": true, "data": ["count": 4, "results": [["title": "Interactive back"], ["title": "Stable chat scroll"], ["title": "One image bubble"], ["title": "Fourth match"]]]]),
            ]
            for (id, tool, input, result) in calls {
                let arguments = String(decoding: try JSONSerialization.data(withJSONObject: input), as: UTF8.self)
                let resultText = String(decoding: try JSONSerialization.data(withJSONObject: result), as: UTF8.self)
                let output: [String: Any] = ["content": [["type": "text", "text": resultText]]]
                if target.source == "codex" {
                    entries.append(["line": entries.count, "raw": ["type": "response_item", "payload": ["type": "function_call", "call_id": "phren-" + id, "name": "mcp__phren__" + tool, "arguments": arguments]]])
                    entries.append(["line": entries.count, "raw": ["type": "response_item", "payload": ["type": "function_call_output", "call_id": "phren-" + id, "output": output]]])
                } else {
                    entries.append(["line": entries.count, "raw": ["type": "assistant", "message": ["role": "assistant", "content": [["type": "tool_use", "id": "phren-" + id, "name": "mcp__phren__" + tool, "input": input]]]]])
                    entries.append(["line": entries.count, "raw": ["type": "user", "message": ["role": "user", "content": [["type": "tool_result", "tool_use_id": "phren-" + id, "content": [["type": "text", "text": resultText]]]]]]])
                }
            }
        }
        if flag("--chat-secure-links") {
            append("assistant", "[Approve](shortcuts://x)\n\n[Docs](https://example.com)")
        }
        if flag("--chat-claude-image") {
            let text = "[Image #1]Why does this terminal wrap?\n\nAttached files on this computer:"
            entries.append(["line": entries.count, "raw": ["type": "user", "phrenQueued": true, "phrenQueueKey": String(repeating: "b", count: 64),
                "message": ["role": "user", "content": text]]])
            if stopped {
                entries.append(["line": entries.count, "raw": ["type": "user", "message": ["role": "user", "content": [
                    ["type": "text", "text": text],
                    ["type": "image", "source": ["type": "base64", "media_type": "image/png", "data": image.data.base64EncodedString()]]]]]])
            }
        }
        if flag("--chat-read-images") {
            // The agent read a screenshot whose result carries two frames, and
            // the person sent two pictures from the phone — which Claude Code
            // records as text markers naming the uploads, not as image blocks.
            entries.append(["line": entries.count, "raw": ["type": "assistant", "message": ["role": "assistant", "content": [
                ["type": "tool_use", "id": "read-shot", "name": "Read", "input": ["file_path": "/work/phone/shots/shot.png"]]]]]])
            let frame: [String: Any] = ["type": "image", "source": ["type": "base64", "media_type": "image/png", "data": ""]]
            entries.append(["line": entries.count, "raw": ["type": "user", "message": ["role": "user", "content": [
                ["type": "tool_result", "tool_use_id": "read-shot", "content": [frame, frame]]]]]])
            entries.append(["line": entries.count, "raw": ["type": "user", "message": ["role": "user", "content": [
                ["type": "text", "text": "Look at these [Image: source: /work/phone/uploads/a.png] [Image: source: /work/phone/uploads/b.png]"]]]]])
        }
        if flag("--chat-markdown") { append("assistant", "# Changes\nHere is the fix in `packages/cli/src/bridge/projects.ts`, using `lsof -Fpcn`:\n```swift\nlet color = \"cyan\"\n```\nReady to test.") }
        if flag("--chat-link") { append("assistant", "[Open linked page](https://example.org/phren-fixture)") }
        // Real transcripts retain the tool call after it is answered. Keep its
        // line stable so the reply appends instead of reusing a tool message ID.
        if flag("--chat-question") {
            let args: [String: Any] = ["questions": [["id": "palette", "header": "Design", "question": "Which accent should the project use?", "options": [["label": "Cyan", "description": "Keep the Phren accent"], ["label": "Lavender", "description": "A softer accent"]]]]]
            let raw: [String: Any] = ["type": "response_item", "payload": ["type": "function_call", "name": "request_user_input", "call_id": "fixture-question", "arguments": String(decoding: try JSONSerialization.data(withJSONObject: args), as: UTF8.self)]]
            entries.append(["line": entries.count, "raw": raw])
        }
        if flag("--chat-image-turn") {
            // One turn from the phone: words plus a picture, as Claude Code
            // records a pasted image next to its text.
            let raw: [String: Any] = target.source == "codex"
                ? ["type": "response_item", "payload": ["type": "message", "role": "user", "content": [
                    ["type": "input_text", "text": "[Image #1]Look at this header\n\nAttached files on this computer:\n/tmp/shot.png"],
                    ["type": "input_image", "image_url": "fixture"]]]]
                : ["type": "user", "message": ["role": "user", "content": [
                    ["type": "text", "text": "[Image #1]Look at this header\n\nAttached files on this computer:\n/tmp/shot.png"],
                    ["type": "image", "source": ["type": "base64", "media_type": "image/png", "data": ""]]]]]
            entries.append(["line": entries.count, "raw": raw])
        }
        if flag("--chat-historical-image") {
            let raw: [String: Any] = ["type": "response_item", "payload": ["type": "message", "role": "user", "content": [["type": "input_image", "image_url": "fixture"]]]]
            entries.append(["line": entries.count, "raw": raw])
        }
        if answered { append("assistant", "Answer received in this conversation.") }
        if denied { append("assistant", "Permission denied in this conversation.") }
        if !flag("--chat-claude-queue"), stopped { append("assistant", "Turn stopped in the selected pane.") }
        for (id, text) in sent where id == target.id || flag("--starting-session-fixture") {
            if flag("--chat-claude-queue") {
                let key = String(repeating: "a", count: 64)
                entries.append(["line": entries.count, "raw": ["type": "user", "phrenQueued": true, "phrenQueueKey": key,
                    "message": ["role": "user", "content": text]]])
            } else {
                append("user", text)
                append("assistant", "Received in \(target.source) on \(target.paneID): \(text)")
            }
        }
        if flag("--chat-claude-queue"), stopped {
            for (id, _) in sent where id == target.id {
                entries.append(["line": entries.count, "raw": ["type": "phren_queue_consumed", "key": String(repeating: "a", count: 64)]])
            }
            append("assistant", "Queued instructions consumed.")
        }
        return try AgentChatTranscript.read(JSONSerialization.data(withJSONObject: ["type": "backlog", "source": target.source,
                                                                                    "entries": entries, "startLine": flag("--chat-history") ? 20 : 0, "totalLines": (flag("--chat-history") ? 20 : 0) + entries.count, "hasMore": flag("--chat-history")]), source: target.source)
    }
    static func send(_ target: AgentChatTarget, text: String) async throws {
        try await Task.sleep(for: .milliseconds(250))
        sendAttempts += 1
        if flag("--chat-send-rejected"), sendAttempts == 1 {
            throw LiveConnectionError.gatewayRejection(status: 422, reason: "The selected terminal is unavailable.")
        }
        if flag("--chat-send-fails") { throw LiveConnectionError.disconnected }
        sent.append((target.id, text))
        if flag("--starting-session-fixture"), target.isStarting { startingAttachedAt = Date.now.addingTimeInterval(3) }
        if flag("--chat-streaming") { streamStarts[target.id] = .now }
    }
    private static func streamingTranscript(_ target: AgentChatTarget) throws -> AgentChatTranscript {
        let kind = streamed.insert(target.id).inserted ? "backlog" : "append"
        var entries: [[String: Any]] = []
        func message(_ line: Int, _ role: String, _ text: String) {
            entries.append(["line": line, "raw": ["type": "response_item", "payload": ["type": "message", "role": role, "content": text]]])
        }
        func event(_ line: Int, _ fields: [String: Any]) {
            entries.append(["line": line, "raw": ["type": "event_msg", "payload": fields]])
        }
        message(0, "assistant", "Ready to stream a reply.")
        if let start = streamStarts[target.id], let text = sent.last(where: { $0.0 == target.id })?.1 {
            let elapsed = Date.now.timeIntervalSince(start)
            message(1, "user", text)
            if elapsed >= 2 {
                event(2, ["type": "task_started", "started_at": start.timeIntervalSince1970])
                event(3, ["type": "token_count", "info": ["last_token_usage": ["input_tokens": 128, "output_tokens": 0]]])
            }
            if elapsed >= 5 {
                message(4, "assistant", streamingReply)
                event(5, ["type": "token_count", "info": ["last_token_usage": ["input_tokens": 128, "output_tokens": 85]]])
            }
            if elapsed >= 9 { event(6, ["type": "task_complete", "completed_at": start.addingTimeInterval(9).timeIntervalSince1970]) }
        }
        let totalLines = entries.count
        let previousLine = lastStreamLine[target.id] ?? -1
        lastStreamLine[target.id] = (entries.last?["line"] as? Int) ?? previousLine
        // Match the hook: append each event once. Replaying the whole turn
        // every 500 ms keeps rebuilding open menus and prevents UI quiescence.
        let delta = kind == "backlog" ? entries : entries.filter { ($0["line"] as? Int ?? -1) > previousLine }
        return try AgentChatTranscript.read(JSONSerialization.data(withJSONObject: ["type": kind, "source": target.source,
            "entries": delta, "startLine": 0, "totalLines": totalLines, "hasMore": false]), source: target.source)
    }
    private static func flag(_ flag: String) -> Bool { ProcessInfo.processInfo.arguments.contains(flag) }

    /// "Open on a computer": what the Hook would return after creating a
    /// workspace and starting the agent, plus the snapshot the session comes
    /// from. Recorded so a UI test can check what was asked for.
    static var launches: [(cwd: String, label: String, kind: String)] = []
    static func locate(project: String) async throws -> [PhrenConnection.LocatedFolder] {
        try await Task.sleep(for: .milliseconds(150))
        return [.init(directory: "/work/\(project)", source: "activity", lastSeen: "2026-09-12T01:00:00Z"),
                .init(directory: "/Users/fixture/Projects/\(project)", source: "search", lastSeen: nil)]
    }
    /// Simulator actions the fixture screen sent, for tests.
    nonisolated(unsafe) static var simulatorActions: [String] = []
    static func launch(host: LiveHost, cwd: String, label: String, kind: String) async throws -> LiveAgentSession {
        try await Task.sleep(for: .milliseconds(400))
        launches.append((cwd, label, kind))
        if flag("--launch-fails") { throw PhrenKitError.validation("Herdr couldn't start \(kind) in the new pane: the fixture said no.") }
        let json = #"{"kind":"herdr","groups":[{"id":"w9","label":"\#(label)","children":[{"id":"w9:t1","label":"1","title":"\#(label)","agent":"\#(kind)","agentStatus":"idle","cwd":"\#(cwd)","sessionId":"fixture-\#(kind)-session","agentPaneCount":1,"paneCount":1}]}]}"#
        guard let session = try LiveWorkspaces.read(Data(json.utf8)).sessions(on: host).first else { throw PhrenKitError.validation("Fixture produced no session.") }
        return session
    }
}
#endif
