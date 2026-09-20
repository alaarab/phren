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
    /// What the chat copied and has selected, for tests: reading the
    /// pasteboard from the runner hangs on iOS's paste prompt.
    @Observable final class Report {
        var copied: [String] = []
        var selected = ""
        var json: String {
            let report: [String: Any] = ["copied": copied, "selected": selected]
            return String(decoding: (try? JSONSerialization.data(withJSONObject: report, options: .sortedKeys)) ?? Data(), as: UTF8.self)
        }
    }
    static let report = Report()
    /// The `updatedInput` an AskUserQuestion approval was answered with; the
    /// fixture echoes its answers into the transcript for tests to read.
    static var answeredInput: [String: Any]?
    static let approvalExpiry = Date.ISO8601FormatStyle(includingFractionalSeconds: true).format(Date().addingTimeInterval(55))
    /// Claude Code's AskUserQuestion as the hook reports it: a permission
    /// request whose input is the question set.
    static let questionInput: [String: Any] = ["questions": [
        ["question": "Which accent should the project use?", "header": "Design",
         "options": [["label": "Cyan", "description": "Keep the Phren accent"], ["label": "Lavender", "description": "A softer accent"]]],
        ["question": "Which screens should change?", "header": "Scope", "multiSelect": true,
         "options": [["label": "Chat", "description": "The conversation"], ["label": "Agents", "description": "The overview"], ["label": "Settings"]]],
    ]]
    /// The plan Claude wrote in plan mode: more than a screenful, so the card
    /// cuts it and offers the rest.
    static let planMarkdown = "# Plan: subagent and todo cards\n\n## Steps\n\n1. Parse the Task tool in PhrenKit\n2. Draw the agent card\n3. Fold superseded todo lists\n4. Add fixture flags\n5. Write the UI tests\n6. Run the suite on the simulator\n7. Check the cards at accessibility sizes\n8. Verify the plan approval path\n9. Update the changelog\n10. Ask for review\n\n## Notes\n\n- Keep every card in the phren card family\n- No raw JSON on any card\n- Final step marker: run the full suite once more"
    static func approval(_ target: AgentChatTarget) throws -> AgentApproval? {
        guard !answered else { return nil }
        if flag("--chat-approval-question") {
            let message = String(decoding: try JSONSerialization.data(withJSONObject: questionInput, options: .prettyPrinted), as: UTF8.self)
            return try AgentInteractionStatus.read(JSONSerialization.data(withJSONObject: ["agentStatus": ["source": target.source, "session": target.sessionID, "pendingApproval": ["actionId": "fixture-question-action", "toolName": "AskUserQuestion", "title": "Allow AskUserQuestion?", "message": message, "expiresAt": approvalExpiry]]]), target: target)?.approval
        }
        if flag("--chat-plan-mode") {
            // Claude Code's plan review: a permission request for ExitPlanMode
            // whose input carries the plan.
            let message = String(decoding: try JSONSerialization.data(withJSONObject: ["plan": planMarkdown]), as: UTF8.self)
            return try AgentInteractionStatus.read(JSONSerialization.data(withJSONObject: ["agentStatus": ["source": target.source, "session": target.sessionID, "pendingApproval": ["actionId": "fixture-plan-action", "toolName": "ExitPlanMode", "title": "Allow ExitPlanMode?", "message": message, "expiresAt": approvalExpiry]]]), target: target)?.approval
        }
        guard flag("--chat-approval") else { return nil }
        let (title, message) = tour && !trailer ? ("Push the release branch", "git push origin release/1.0") : ("Run project tests", "npm test")
        return try AgentInteractionStatus.read(JSONSerialization.data(withJSONObject: ["agentStatus": ["source": target.source, "session": target.sessionID, "pendingApproval": ["actionId": "fixture-action", "title": title, "message": message, "expiresAt": approvalExpiry]]]), target: target)?.approval
    }
    static var uploads = 0
    /// The App Store tour: named computers, real project names, a picture
    /// worth looking at where a test only needs some bytes.
    static var tour: Bool { flag("--store-tour-fixture") || trailer }
    /// The product video: the tour's names, and a Claude conversation on the
    /// payments service that ends in a saved finding.
    static var trailer: Bool { flag("--trailer-fixture") }
    /// Where the fixture's project lives on the computer.
    static var root: String { trailer ? "/work/ledger" : tour ? "/work/phren" : "/work/phone" }
    static var image: AgentAttachment { picture(0) }
    /// The tour's pictures are design stills — the app's canvas, a tinted
    /// card, the mascot — in a different tint per picture so four in one
    /// conversation read as four; elsewhere a plain cyan rectangle.
    static func picture(_ index: Int) -> AgentAttachment {
        let size = tour ? CGSize(width: 360, height: 240) : CGSize(width: 120, height: 90)
        let tints = [UIColor(red: 0.725, green: 0.58, blue: 0.957, alpha: 1), UIColor(red: 0.157, green: 0.827, blue: 0.949, alpha: 1),
                     UIColor(red: 0.878, green: 0.737, blue: 0.498, alpha: 1), UIColor(red: 0.541, green: 0.784, blue: 0.675, alpha: 1)]
        let data = UIGraphicsImageRenderer(size: size).pngData { context in
            guard tour else { UIColor.cyan.setFill(); context.fill(CGRect(origin: .zero, size: size)); return }
            UIColor(red: 0.118, green: 0.118, blue: 0.118, alpha: 1).setFill(); context.fill(CGRect(origin: .zero, size: size))
            tints[index % tints.count].withAlphaComponent(0.22).setFill()
            UIBezierPath(roundedRect: CGRect(x: 24, y: 24, width: size.width - 48, height: size.height - 48), cornerRadius: 20).fill()
            UIImage(named: "PhrenMascot")?.draw(in: CGRect(x: (size.width - 150) / 2, y: (size.height - 150) / 2, width: 150, height: 150))
        }
        return try! AgentAttachment(name: "Screenshot.png", data: data, isImage: true)
    }
    /// What the computer would send back for a picture in the conversation:
    /// the fixture picture for any transcript block, and for an upload only
    /// when the path is one the fixture's own turns name.
    static func imageBytes(_ reference: ChatImageReference) throws -> Data {
        switch reference {
        case .upload(let path):
            guard path.hasPrefix(root + "/uploads/") else { throw LiveConnectionError.response(404) }
            return picture(path.hasSuffix("b.png") ? 3 : 2).data
        case .transcript(_, _, let inner):
            return picture(inner ?? 0).data
        }
    }
    static func upload(_ attachment: AgentAttachment) throws -> String {
        uploads += 1
        if flag("--chat-send-blocked-once"), uploads > 1 { throw PhrenKitError.validation("Attachment was uploaded twice.") }
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
        let agent = launchedKind ?? (flag("--chat-copilot") ? "copilot" : (trailer || flag("--chat-claude-queue") || flag("--chat-claude-image") || flag("--chat-read-images") || flag("--chat-approval-question") || flag("--chat-agent-card") || flag("--chat-todos") || flag("--chat-plan-mode") || flag("--chat-web-tools") || flag("--chat-skill-chip") || flag("--chat-mcp-card") || (tour && flag("--chat-phren-tools"))) ? "claude" : "codex")
        var panes: [[String: Any]] = [["id": "\(session.workspaceID):p1", "label": "1", "title": tour ? "Ship the onboarding flow" : "Polish the phone app", "agent": agent,
                                     "agentStatus": ((flag("--chat-blocked") || flag("--chat-approval") || flag("--chat-approval-question") || flag("--chat-plan-mode") || flag("--chat-question")) && !answered) ? "blocked" : (flag("--chat-queue-completion") || (flag("--chat-working") && !stopped) ? "working" : "idle"), "sessionId": agent == "copilot" ? "00000000-0000-0000-0000-000000000023" : "fixture-\(agent)-session", "cwd": root]]
        if flag("--starting-session-fixture") {
            panes[0]["startingToken"] = startingToken
            if startingAttachedAt == nil || Date.now < startingAttachedAt! {
                panes[0].removeValue(forKey: "sessionId")
                panes[0]["starting"] = true
                panes[0]["agentStatus"] = "idle"
            }
        }
        if flag("--chat-shell-only") {
            panes = [["id": "\(session.workspaceID):p1", "label": "1", "title": "alaarab@omarchy:~", "cwd": root]]
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
        if flag("--chat-queue-completion") { return try queueCompletionTranscript(target) }
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
        if trailer {
            // The morning's round, then the one the video reads.
            append("user", "Ship the onboarding flow: merchant sign-up first, then the first order.")
            append("assistant", "Starting with sign-up. The form posts to /merchants, then the welcome screen asks for the first product.")
            append("user", "Keep the sign-up to one screen.")
            append("assistant", "One screen: name, country, payout account. The webhook secret is minted after the first order, not at sign-up.")
            append("user", "Pick up the onboarding flow where we left off — the first order for a new merchant.")
            append("assistant", "Picking it up. Sign-up is in; I'll wire the first order and run the checkout suite.")
        } else if tour {
            append("user", "Pick up the onboarding flow where we left off.")
            append("assistant", "Picking it up. The welcome screen is done; GitHub sign-in and Add computer are next.")
        } else if !flag("--starting-session-fixture") {
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
            let memory = tour ? "phren" : "phone"
            entries.append(["line": entries.count, "raw": ["type": "response_item", "payload": ["type": "function_call", "call_id": "edit-py", "name": "exec_command",
                "arguments": "{\"cmd\":\"python3 - <<'EOF'\\np='Theme.swift'\\ns=open(p).read().replace('green','purple')\\nopen(p,'w').write(s)\\nopen('/Users/fixture/.phren/\(memory)/FINDINGS.md','a').write('- Accent is purple now\\\\n')\\nEOF\"}"]]])
            // Phren Hook attaches what the command changed on disk to its output row.
            entries.append(["line": entries.count, "raw": ["type": "response_item", "payload": ["type": "function_call_output", "call_id": "edit-py", "output": "{\"output\":\"\",\"exit_code\":0}"],
                "phren_changes": ["edit-py": [
                    ["root": root, "path": "Theme.swift", "status": "M", "added": 1, "removed": 1, "patch": "diff --git a/Theme.swift b/Theme.swift\nindex 1..2 100644\n--- a/Theme.swift\n+++ b/Theme.swift\n@@ -1,3 +1,3 @@\n import SwiftUI\n-let accent = green\n+let accent = purple\n let radius = 12\n"],
                    ["root": "/Users/fixture/.phren", "path": "\(memory)/FINDINGS.md", "status": "M", "added": 3, "removed": 2, "patch": "diff --git a/\(memory)/FINDINGS.md b/\(memory)/FINDINGS.md\n--- a/\(memory)/FINDINGS.md\n+++ b/\(memory)/FINDINGS.md\n@@ -2,3 +2,5 @@\n - Tiles are one sprite\n-- Offline first\n-- Old note\n+- Accent is purple now\n+- Offline first, always\n+- Geocoder batches at 8/s\n"]]]]])
        }
        if flag("--chat-phren-tools"), !trailer {
            let project = tour ? "phren" : "phone"
            let saved = tour ? "XCUITest: reading UIPasteboard from the runner raises the paste prompt and hangs the run — verify copies through an in-app signal instead."
                : String(repeating: "Keep queue identities when a real turn replaces its pending copy. ", count: 12)
            let calls: [(String, String, [String: Any], [String: Any])] = [
                ("finding", "add_finding", ["project": project, "findingType": "pitfall", "finding": saved], ["ok": true]),
                ("task", "add_task", ["project": project, "task": "Verify pasted images in chat"], ["ok": true]),
                ("complete", "manage_task", ["project": project, "action": "complete", "item": "Pin curated font downloads"], ["ok": true]),
                ("search", "search_knowledge", ["project": project, "query": "chat navigation"], ["ok": true, "data": ["count": 4, "results": [["title": "Interactive back"], ["title": "Stable chat scroll"], ["title": "One image bubble"], ["title": "Fourth match"]]]]),
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
        // Claude Code's bookkeeping tools, each with a card of its own. Lines
        // count from the same start as `append`'s, so a history offset keeps
        // calls and replies in order.
        let firstLine = flag("--chat-history") ? 20 : 0
        func claudeCall(_ id: String, _ name: String, _ input: [String: Any]) {
            entries.append(["line": firstLine + entries.count, "raw": ["type": "assistant", "message": ["role": "assistant", "content": [["type": "tool_use", "id": id, "name": name, "input": input]]]]])
        }
        func claudeResult(_ id: String, _ text: String, error: Bool = false) {
            var block: [String: Any] = ["type": "tool_result", "tool_use_id": id, "content": text]
            if error { block["is_error"] = true }
            entries.append(["line": firstLine + entries.count, "raw": ["type": "user", "message": ["role": "user", "content": [block]]]])
        }
        if trailer, flag("--chat-phren-tools") {
            // The video's turn: Claude looks around (six commands, one row),
            // fixes the bug it found (one patch), and keeps what it learned
            // (one phren card) — then the person queues the next step.
            let looks: [(String, String)] = [
                ("git status --short", " M src/orders/create.ts\n M src/onboarding/signup.ts"),
                ("npm test -- orders", "Tests: 1 failed, 41 passed, 42 total\n\n  ✕ a retried POST /orders with a reused key returns the caller's order (38 ms)"),
                ("rg -n \"idempotency\" src/orders", "src/orders/create.ts:18:  const existing = await keys.find(idempotencyKey)\nsrc/orders/keys.ts:9:export async function find(key: string) {"),
                ("cat src/orders/keys.ts", "export async function find(key: string) {\n  return db.idempotencyKeys.findUnique({ where: { key } })\n}\n\nexport function scope(merchantId: string, key: string) {\n  return `${merchantId}:${key}`\n}"),
                ("sed -n '12,28p' src/orders/create.ts", "export async function createOrder(merchant: Merchant, input: OrderInput, idempotencyKey: string) {\n  const existing = await keys.find(idempotencyKey)\n  if (existing) return existing.order\n  const order = await orders.insert(merchant.id, input)\n  await keys.save(idempotencyKey, order.id)\n  return order\n}"),
                ("git log --oneline -3", "3f2a1c9 onboarding: one-screen merchant sign-up\n8d41e07 orders: retry banner on the first order\nb77c2aa ledger: reversal references on corrections"),
            ]
            for (index, look) in looks.enumerated() {
                claudeCall("trailer-look-\(index)", "Bash", ["command": look.0, "description": "Look at the orders code"])
                claudeResult("trailer-look-\(index)", look.1)
            }
            claudeCall("trailer-edit", "Edit", ["file_path": root + "/src/orders/create.ts",
                                              "old_string": "  const existing = await keys.find(idempotencyKey)\n  if (existing) return existing.order\n  const order = await orders.insert(merchant.id, input)\n  await keys.save(idempotencyKey, order.id)",
                                              "new_string": "  const scoped = keys.scope(merchant.id, idempotencyKey)\n  const existing = await keys.find(scoped)\n  if (existing) return existing.order\n  const order = await orders.insert(merchant.id, input)\n  await keys.save(scoped, order.id)"])
            claudeResult("trailer-edit", "The file \(root)/src/orders/create.ts has been updated.")
            append("assistant", "Found it: the idempotency lookup ignored the merchant, so a key reused by two merchants returned the first merchant's order. Keys are scoped per merchant now.")
            claudeCall("phren-finding", "mcp__phren__add_finding", ["project": "ledger", "findingType": "pitfall", "finding": UITestFixtures.trailerFinding])
            claudeResult("phren-finding", "{\"ok\":true}")
            append("assistant", "Saved that to phren so the next session starts with it. Running the checkout suite again now.")
        }
        if flag("--chat-agent-card") {
            // One agent back with a report longer than the card shows; one
            // sent to the background and still out there.
            claudeCall("agent-audit", "Task", ["description": "Audit the chat timeline", "subagent_type": "Explore", "model": "haiku",
                                               "prompt": "Read ChatTimelineModels.swift and report which calls fold into a run.\nList every guard that keeps a call out of a run.\nKeep the report under two hundred words."])
            claudeResult("agent-audit", "# Timeline audit\n\n- Reads, greps and lists fold once three are in a row\n- A change row splits the run\n- Phren calls keep their card\n- Background jobs stay out\n- Failed calls stay out\n- Pictured results stay out\n- Card kinds stay out\n- Runs re-group when expanded\n- Nothing else folds\n\nFinal audit marker: no gaps found.\n\nagentId: fixture-audit (for resuming)")
            claudeCall("agent-tests", "Task", ["description": "Run the full test suite", "subagent_type": "general-purpose", "name": "tester", "run_in_background": true,
                                               "prompt": "Run swift test in PhrenKit and the simulator suite; report failures only."])
            claudeResult("agent-tests", "Async agent launched successfully.\nagentId: fixture-tests (for resuming)\noutput_file: /tmp/phren-fixture/tester.txt")
        }
        if flag("--chat-todos") {
            // The first list has an item the second dropped, so a test can
            // tell the folded list's rows from the latest list's.
            let first: [[String: Any]] = [["content": "Sketch the card", "status": "pending", "activeForm": "Sketching the card"],
                                          ["content": "Draw the checklist", "status": "pending", "activeForm": "Drawing the checklist"],
                                          ["content": "Fold superseded lists", "status": "pending", "activeForm": "Folding superseded lists"]]
            claudeCall("todo-1", "TodoWrite", ["todos": first])
            claudeResult("todo-1", "Todos have been modified successfully.")
            append("assistant", "Working through the list.")
            let second: [[String: Any]] = [["content": "Parse the todo tool", "status": "completed", "activeForm": "Parsing the todo tool"],
                                           ["content": "Draw the checklist", "status": "completed", "activeForm": "Drawing the checklist"],
                                           ["content": "Fold superseded lists", "status": "completed", "activeForm": "Folding superseded lists"],
                                           ["content": "Write the UI test", "status": "in_progress", "activeForm": "Writing the UI test"],
                                           ["content": "Update the changelog", "status": "pending", "activeForm": "Updating the changelog"]]
            claudeCall("todo-2", "TodoWrite", ["todos": second])
            claudeResult("todo-2", "Todos have been modified successfully.")
            claudeCall("task-1", "TaskCreate", ["subject": "Verify the cards on a device", "description": "Open a real Claude session and read the cards."])
            claudeResult("task-1", "Task #1 created successfully")
        }
        if flag("--chat-plan-mode") {
            claudeCall("plan-enter", "EnterPlanMode", [:])
            claudeResult("plan-enter", "Entered plan mode. Explore and design before writing code.")
            claudeCall("plan-exit", "ExitPlanMode", ["plan": planMarkdown])
            // Claude Code writes the call before asking; the answer arrives
            // as its result.
            if answered, denied { claudeResult("plan-exit", "The user doesn't want to proceed with this tool use. The tool use was rejected.", error: true) }
            else if answered { claudeResult("plan-exit", "User has approved your plan. You can now start coding.") }
        }
        if flag("--chat-web-tools") {
            // A fetch and a search, done; a reply between them and the next
            // fetch (still out) so the pair does not fold into a read run.
            claudeCall("web-fetch", "WebFetch", ["url": "https://developer.apple.com/documentation/swiftui/scrollview?language=swift",
                                                 "prompt": "Summarize how nested scroll views hand off scrolling."])
            claudeResult("web-fetch", "# ScrollView\n\nA scrollable view.\n\n" + (1...14).map { "Fetched line \($0): nested scroll views hand the gesture to the inner view first." }.joined(separator: "\n")
                + "\n\nSee [ScrollViewReader](https://developer.apple.com/documentation/swiftui/scrollviewreader).\n\nFinal fetched marker line.")
            let links = String(decoding: try JSONSerialization.data(withJSONObject: [
                ["title": "ScrollView | Apple Developer Documentation", "url": "https://developer.apple.com/documentation/swiftui/scrollview"],
                ["title": "Nested ScrollViews in SwiftUI", "url": "https://example.org/nested-scrollviews"]]), as: UTF8.self)
            claudeCall("web-search", "WebSearch", ["query": "SwiftUI nested ScrollView gesture"])
            claudeResult("web-search", "Web search results for query: \"SwiftUI nested ScrollView gesture\"\n\nLinks: \(links)\n\nSwiftUI hands a nested scroll to the inner view until it reaches its edge.")
            append("assistant", "Here is what the documentation says.")
            claudeCall("web-pending", "WebFetch", ["url": "https://example.org/still/loading", "prompt": "Read the changelog."])
        }
        if flag("--chat-skill-chip") {
            // A skill call between two rounds of looking: the reads fold
            // either side of it, the chip sits between the runs.
            for index in 0..<3 {
                claudeCall("skill-read-\(index)", "Read", ["file_path": "/work/phone/Sources/File\(index).swift"])
                claudeResult("skill-read-\(index)", "let value = \(index)")
            }
            claudeCall("skill-design", "Skill", ["skill": "design", "args": "the chat cards, tighter"])
            claudeResult("skill-design", "Launching skill: design\n\n# Design pass\n\nTake the screenshot, fix hierarchy and spacing against phren's own conventions.\n\nFinal skill marker line.")
            for index in 0..<3 {
                claudeCall("skill-grep-\(index)", "Grep", ["pattern": "phrenCard\(index)", "path": "/work/phone"])
                claudeResult("skill-grep-\(index)", "PhrenTheme.swift: func phrenCard()")
            }
            append("assistant", "Running the design pass now.")
        }
        if flag("--chat-mcp-card") {
            // Three calls to other servers in a row: cards, never a run.
            claudeCall("mcp-pr", "mcp__github__get_pull_request", ["owner": "alaarab", "repo": "phren", "pull_number": 42,
                                                                   "filters": ["state": "open", "draft": false], "labels": ["ios", "chat"]])
            let pull = String(decoding: try JSONSerialization.data(withJSONObject: [
                "number": 42, "title": "Chat: cards for web, skills and MCP", "state": "open", "user": ["login": "alaarab", "id": 7],
                "labels": [["name": "ios"], ["name": "chat"]], "additions": 812, "deletions": 40, "mergeable": true, "draft": false]), as: UTF8.self)
            claudeResult("mcp-pr", pull)
            claudeCall("mcp-panes", "mcp__herdr__list_panes", ["workspace": "phone"])
            claudeResult("mcp-panes", "3 panes in phone\n1: codex — Polish the phone app\n2: claude — Review the changes\n3: shell")
            claudeCall("mcp-merge", "mcp__github__merge_pull_request", ["owner": "alaarab", "repo": "phren", "pull_number": 42])
            claudeResult("mcp-merge", "Pull request is not mergeable: checks are still running.", error: true)
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
                ["type": "tool_use", "id": "read-shot", "name": "Read", "input": ["file_path": root + (tour ? "/shots/onboarding.png" : "/shots/shot.png")]]]]]])
            let frame: [String: Any] = ["type": "image", "source": ["type": "base64", "media_type": "image/png", "data": ""]]
            entries.append(["line": entries.count, "raw": ["type": "user", "message": ["role": "user", "content": [
                ["type": "tool_result", "tool_use_id": "read-shot", "content": [frame, frame]]]]]])
            entries.append(["line": entries.count, "raw": ["type": "user", "message": ["role": "user", "content": [
                ["type": "text", "text": "Look at these [Image: source: \(root)/uploads/a.png] [Image: source: \(root)/uploads/b.png]"]]]]])
        }
        if flag("--chat-paragraphs") {
            append("assistant", "Alpha paragraph opens the reply with a summary of what changed on the project screen.\n\nBravo paragraph explains why `ChatRichText` renders blocks, each copying on its own.\n\nCharlie paragraph closes with what to try next on the phone.\n\n```swift\nlet copied = true\n```")
        }
        if flag("--chat-markdown") { append("assistant", "# Changes\nHere is the fix in `packages/cli/src/bridge/projects.ts`, using `lsof -Fpcn`:\n```swift\nlet color = \"cyan\"\n```\nReady to test.") }
        if flag("--chat-link") { append("assistant", "[Open linked page](https://example.org/phren-fixture)") }
        // Real transcripts retain the tool call after it is answered. Keep its
        // line stable so the reply appends instead of reusing a tool message ID.
        if flag("--chat-async-question") || flag("--chat-question-unsupported") {
            let args: [String: Any] = ["questions": [["title": "Which Codex screens are missing approvals?", "options": ["Phren and lock screen", "Lock screen only"]]]]
            entries.append(["line": entries.count, "raw": ["type": "response_item", "payload": ["type": "function_call", "name": "request_user_input_async", "call_id": "fixture-async-question", "arguments": String(decoding: try JSONSerialization.data(withJSONObject: args), as: UTF8.self)]]])
            entries.append(["line": entries.count, "raw": ["type": "response_item", "payload": ["type": "function_call_output", "call_id": "fixture-async-question", "output": "{\"accepted\":true}"]]])
            append("assistant", "I am investigating both paths.")
        }
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
        if let answers = answeredInput?["answers"] as? [String: Any] {
            // Answers as Claude Code would read them, label lists joined.
            let lines = answers.keys.sorted().map { question in
                "\(question) → " + ((answers[question] as? [String])?.joined(separator: ", ") ?? (answers[question] as? String ?? "?"))
            }
            append("assistant", "Answers received in this conversation.\n" + lines.joined(separator: "\n"))
        } else if answered, trailer, !denied {
            // The approved run, then what it found.
            claudeCall("trailer-tests", "Bash", ["command": "npm test", "description": "Run the project tests"])
            claudeResult("trailer-tests", "Tests: 128 passed, 128 total\nTime: 6.4 s")
            append("assistant", "Answer received — all 128 tests pass. The onboarding flow is ready to ship.")
        } else if answered { append("assistant", "Answer received in this conversation.") }
        if denied { append("assistant", "Permission denied in this conversation.") }
        if !flag("--chat-claude-queue"), stopped { append("assistant", "Turn stopped in the selected pane.") }
        for (id, text) in sent where id == target.id || flag("--starting-session-fixture") {
            if flag("--chat-claude-queue") {
                let key = String(repeating: "a", count: 64)
                entries.append(["line": firstLine + entries.count, "raw": ["type": "user", "phrenQueued": true, "phrenQueueKey": key,
                    "message": ["role": "user", "content": text]]])
            } else {
                append("user", text)
                append("assistant", "Received in \(target.source) on \(target.paneID): \(text)")
            }
        }
        if flag("--chat-claude-queue"), stopped {
            for (id, _) in sent where id == target.id {
                entries.append(["line": firstLine + entries.count, "raw": ["type": "phren_queue_consumed", "key": String(repeating: "a", count: 64)]])
            }
            append("assistant", "Queued instructions consumed.")
        }
        return try AgentChatTranscript.read(JSONSerialization.data(withJSONObject: ["type": "backlog", "source": target.source,
                                                                                    "entries": entries, "startLine": flag("--chat-history") ? 20 : 0, "totalLines": (flag("--chat-history") ? 20 : 0) + entries.count, "hasMore": flag("--chat-history")]), source: target.source)
    }
    static func send(_ target: AgentChatTarget, text: String) async throws {
        try await Task.sleep(for: .milliseconds(250))
        sendAttempts += 1
        if flag("--chat-send-blocked-once"), sendAttempts == 1 {
            throw LiveConnectionError.gatewayRejection(status: 409, reason: "Answer the pending question before sending another message.")
        }
        if flag("--chat-send-rejected"), sendAttempts == 1 {
            throw LiveConnectionError.gatewayRejection(status: 422, reason: "The selected terminal is unavailable.")
        }
        if flag("--chat-send-fails") { throw LiveConnectionError.disconnected }
        sent.append((target.id, text))
        if flag("--starting-session-fixture"), target.isStarting { startingAttachedAt = Date.now.addingTimeInterval(3) }
        if flag("--chat-streaming") { streamStarts[target.id] = .now }
    }
    /// The terminal keeps reporting working after Codex's actual completion.
    /// Each queued prompt is acknowledged and finished in the next frame.
    private static func queueCompletionTranscript(_ target: AgentChatTarget) throws -> AgentChatTranscript {
        let kind = streamed.insert(target.id).inserted ? "backlog" : "append"
        var entries: [[String: Any]] = []
        func message(_ role: String, _ text: String) {
            entries.append(["line": entries.count, "raw": ["type": "response_item", "payload": ["type": "message", "role": role, "content": text]]])
        }
        func event(_ type: String) {
            entries.append(["line": entries.count, "raw": ["type": "event_msg", "payload": ["type": type]]])
        }
        message("assistant", "Working after the terminal answer.")
        event("task_started")
        if stopped {
            event("task_completed")
            for (id, text) in sent where id == target.id {
                message("user", text)
                message("assistant", "Received: " + text)
                event("task_completed")
            }
        }
        let previousLine = lastStreamLine[target.id] ?? -1
        lastStreamLine[target.id] = entries.count - 1
        return try AgentChatTranscript.read(JSONSerialization.data(withJSONObject: ["type": kind, "source": target.source,
            "entries": kind == "backlog" ? entries : entries.filter { ($0["line"] as? Int ?? -1) > previousLine },
            "totalLines": entries.count, "hasMore": false]), source: target.source)
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
    /// "Add project": the repositories a computer would offer, and what it
    /// reports after enrolling one. Recorded so a UI test can check the ask.
    static var enrollments: [(directory: String?, cloneURL: String?)] = []
    static func repos() async throws -> [PhrenConnection.RepoCandidate] {
        try await Task.sleep(for: .milliseconds(150))
        return [.init(directory: "/work/nightjar", name: "nightjar", source: "activity", registered: false, lastSeen: "2026-09-12T01:00:00Z"),
                .init(directory: "/Users/fixture/Projects/lantern", name: "lantern", source: "search", registered: false, lastSeen: nil),
                .init(directory: "/Users/fixture/Projects/phren", name: "phren", source: "herdr", registered: true, lastSeen: nil)]
    }
    static func enroll(directory: String?, cloneURL: String?) async throws -> PhrenConnection.EnrolledProject {
        try await Task.sleep(for: .milliseconds(400))
        enrollments.append((directory, cloneURL))
        if flag("--enroll-fails") { throw PhrenKitError.validation("git clone failed: the fixture said no.") }
        let folder = directory ?? "/Users/fixture/Projects/" + (cloneURL?.split(separator: "/").last.map { $0.replacingOccurrences(of: ".git", with: "") } ?? "repo")
        let name = String(folder.split(separator: "/").last ?? "repo")
        return .init(project: name, directory: folder, cloned: cloneURL != nil, store: flag("--enroll-unpushed") ? "committed" : "pushed", storeDetail: flag("--enroll-unpushed") ? "no remote configured" : nil)
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
