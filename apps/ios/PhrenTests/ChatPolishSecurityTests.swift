import XCTest
import PhrenKit
@testable import Phren

@MainActor
final class ChatPolishSecurityTests: XCTestCase {
    func testMessageSuggestionContainsOnlyTheSession() throws {
        let host = try LiveHost(name: "Mac", address: "test.invalid", username: "test")
        let snapshot = try LiveWorkspaces.read(Data(#"{"kind":"herdr","groups":[{"id":"w","label":"Work","children":[{"id":"t","label":"Check fonts","agent":"codex","agentStatus":"working"}]}]}"#.utf8))
        let entity = AgentSessionEntity(try XCTUnwrap(snapshot.sessions(on: host).first))
        let suggestion = MessageAgentIntent.suggestion(session: entity)
        XCTAssertEqual(suggestion.session.id, entity.id)
        XCTAssertEqual(suggestion.message, "")
    }

    func testImageMarkersAndBareFooterDisappearOnlyWithActualImages() throws {
        let text = "[Image #83]Why does this wrap?\n\nAttached files on this computer:"
        func message(images: Bool) throws -> AgentChatMessage {
            var blocks: [[String: Any]] = [["type": "text", "text": text]]
            if images { blocks.append(["type": "image", "source": ["type": "base64", "data": "aGVsbG8="]]) }
            let frame = try AgentChatTranscript.read(JSONSerialization.data(withJSONObject: ["type": "backlog", "source": "claude", "totalLines": 1,
                "entries": [["line": 0, "raw": ["type": "user", "message": ["role": "user", "content": blocks]]]]]), source: "claude")
            return try XCTUnwrap(frame.messages.first)
        }
        let landed = try message(images: true)
        XCTAssertEqual(landed.imageBlocks, [1])
        XCTAssertEqual(ChatMessageDisplayCache.text(for: landed, imagePaths: [], hasImages: false, inlineImages: true), "Why does this wrap?")
        XCTAssertEqual(ChatMessageDisplayCache.text(for: try message(images: false), imagePaths: [], hasImages: false, inlineImages: false), text)
    }

    func testClaudeToolErrorSurvivesDecodingAndMarksPhrenCardFailed() throws {
        let data = Data(#"{"type":"backlog","source":"claude","totalLines":2,"entries":[{"line":0,"raw":{"type":"assistant","message":{"role":"assistant","content":[{"type":"tool_use","name":"mcp__phren__add_task","id":"t","input":{"task":"Check fonts"}}]}}},{"line":1,"raw":{"type":"user","message":{"role":"user","content":[{"type":"tool_result","tool_use_id":"t","is_error":true,"content":"Permission denied"}]}}}]}"#.utf8)
        let messages = try AgentChatTranscript.read(data, source: "claude").messages
        XCTAssertTrue(try XCTUnwrap(messages.last).isToolError)
        XCTAssertEqual(ChatTimelineEntry.group(messages).first?.phren?.status, .failed)
    }

    func testCuratedFontPinsRejectTampering() {
        for font in TerminalFonts.curated {
            XCTAssertEqual(font.sha256.count, 64)
            XCTAssertTrue(font.sha256.allSatisfy { $0.isHexDigit })
            XCTAssertFalse(TerminalFonts.matchesPin(Data(repeating: 0, count: 20_000), for: font))
        }
        let known = TerminalFonts.Curated(name: "Test", file: "test.ttf", url: URL(string: "https://example.com/test.ttf")!, detail: "Test",
            sha256: "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad")
        XCTAssertTrue(TerminalFonts.matchesPin(Data("abc".utf8), for: known))
        XCTAssertFalse(TerminalFonts.matchesPin(Data("abd".utf8), for: known))
    }
}
