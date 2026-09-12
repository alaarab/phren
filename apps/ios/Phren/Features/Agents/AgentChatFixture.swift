#if DEBUG && targetEnvironment(simulator)
import Foundation
import PhrenKit
import PhrenLive
import UIKit

/// Isolated, in-memory conversations for UI tests; never active on an iPhone.
@MainActor enum AgentChatFixture {
    static var enabled: Bool { AppModel.isUITesting && ProcessInfo.processInfo.arguments.contains("--native-chat-fixture") }
    static var sent: [(String, String)] = []
    static var reads = 0
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
        var panes: [[String: Any]] = [["id": "\(session.workspaceID):p1", "label": "1", "title": "Polish the phone app", "agent": flag("--chat-copilot") ? "copilot" : "codex",
                                     "agentStatus": ((flag("--chat-blocked") || flag("--chat-approval") || flag("--chat-question")) && !answered) ? "blocked" : (flag("--chat-working") && !stopped ? "working" : "idle"), "sessionId": flag("--chat-copilot") ? "00000000-0000-0000-0000-000000000023" : "fixture-codex-session", "cwd": "/work/phone"]]
        if flag("--chat-multiple") {
            panes.append(["id": "\(session.workspaceID):p2", "label": "2", "title": "Review the changes", "agent": "claude", "agentStatus": "idle", "sessionId": "fixture-claude-session"])
        }
        return try AgentChatPanes.read(JSONSerialization.data(withJSONObject: ["kind": "herdr", "groupId": session.workspaceID, "childId": session.tab.id, "panes": panes]),
                                       workspaceID: session.workspaceID, tabID: session.tab.id)
    }
    static func transcript(_ target: AgentChatTarget) throws -> AgentChatTranscript {
        hasReadTranscript = true
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
        append("user", "Can you refine the project screen?")
        append("assistant", target.source == "codex" ? "The project screen is ready. What would you like to change?" : target.source == "copilot" ? "Copilot is connected to this project. What would you like to change?" : "I reviewed the changes. The project navigation looks consistent.")
        if flag("--chat-long-history") {
            for index in 0..<20 { append("assistant", "Recent discussion \(index). " + String(repeating: "Keep the current message visible while older history loads. ", count: 3)) }
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
        if flag("--chat-diffs") || flag("--chat-dense-diff") {
            let patch = flag("--chat-dense-diff")
                ? "*** Begin Patch\n*** Update File: Dense.swift\n@@\n" + String(repeating: "+x\n", count: 2_000) + "+Final dense patch marker\n*** End Patch"
                : "*** Begin Patch\n*** Update File: Theme.swift\n@@\n-let action = green\n+let action = phrenPurple\n*** End Patch"
            entries.append(["line": entries.count, "raw": ["type": "response_item", "payload": ["type": "custom_tool_call", "name": "apply_patch", "input": patch]]])
            let output = String(decoding: try JSONSerialization.data(withJSONObject: ["chunk_id": "fixture", "output": "Updated Theme.swift", "exit_code": 0]), as: UTF8.self)
            entries.append(["line": entries.count, "raw": ["type": "response_item", "payload": ["type": "function_call_output", "output": [["type": "input_text", "text": output]]]]])
        }
        if flag("--chat-markdown") { append("assistant", "# Changes\nHere is the fix:\n```swift\nlet color = \"cyan\"\n```\nReady to test.") }
        if flag("--chat-link") { append("assistant", "[Open linked page](https://example.org/phren-fixture)") }
        // Real transcripts retain the tool call after it is answered. Keep its
        // line stable so the reply appends instead of reusing a tool message ID.
        if flag("--chat-question") {
            let args: [String: Any] = ["questions": [["id": "palette", "header": "Design", "question": "Which accent should the project use?", "options": [["label": "Cyan", "description": "Keep the Phren accent"], ["label": "Lavender", "description": "A softer accent"]]]]]
            let raw: [String: Any] = ["type": "response_item", "payload": ["type": "function_call", "name": "request_user_input", "call_id": "fixture-question", "arguments": String(decoding: try JSONSerialization.data(withJSONObject: args), as: UTF8.self)]]
            entries.append(["line": entries.count, "raw": raw])
        }
        if flag("--chat-historical-image") {
            let raw: [String: Any] = ["type": "response_item", "payload": ["type": "message", "role": "user", "content": [["type": "input_image", "image_url": "fixture"]]]]
            entries.append(["line": entries.count, "raw": raw])
        }
        if answered { append("assistant", "Answer received in this conversation.") }
        if denied { append("assistant", "Permission denied in this conversation.") }
        if stopped { append("assistant", "Turn stopped in the selected pane.") }
        for (id, text) in sent where id == target.id {
            append("user", text)
            append("assistant", "Received in \(target.source) on \(target.paneID): \(text)")
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
}
#endif
