import XCTest
@testable import PhrenKit

/// What phren's prompt hook injected into a Claude turn reaches the phone as
/// its own folded row, never as the agent's reply or a notification's noise.
final class PhrenHookContextTests: XCTestCase {
    private func read(_ rows: [[String: Any]]) throws -> AgentChatTranscript {
        let entries = rows.enumerated().map { ["line": $0.offset, "raw": $0.element] as [String: Any] }
        return try AgentChatTranscript.read(JSONSerialization.data(withJSONObject: ["type": "backlog", "source": "claude", "entries": entries,
                                                                                    "startLine": 0, "totalLines": entries.count]), source: "claude")
    }
    private let injected = "◆ phren · phren · 2 results\n<phren-context>\n[phren/FINDINGS.md] (findings)\n- one finding\n</phren-context>\n◆ phren · trace: intent=debug"

    func testTypedPromptInjectionIsItsOwnRowAndNotTheReply() throws {
        let transcript = try read([
            ["type": "user", "message": ["role": "user", "content": "Why is the build slow?"]],
            ["type": "phren_turn_input", "notification": false],
            ["type": "phren_hook_context", "content": injected],
            ["type": "assistant", "message": ["role": "assistant", "content": [["type": "text", "text": "The graph bundle rebuilds."]]]],
        ])
        let context = try XCTUnwrap(transcript.messages.first { $0.isHookContext })
        XCTAssertEqual(context.text, injected)
        XCTAssertEqual(context.role, .assistant)
        XCTAssertEqual(transcript.messages.filter { !$0.isHookContext }.map(\.text), ["Why is the build slow?", "The graph bundle rebuilds."])
    }

    func testNotificationInjectionIsLeftOut() throws {
        let transcript = try read([
            ["type": "phren_turn_input", "notification": true],
            ["type": "phren_hook_context", "content": injected],
            ["type": "phren_turn_input", "notification": false],
            ["type": "phren_hook_context", "content": injected],
        ])
        XCTAssertEqual(transcript.messages.filter(\.isHookContext).count, 1, "Only the typed prompt's injection is shown")
        XCTAssertEqual(transcript.messages.first?.line, 3)
    }
}
