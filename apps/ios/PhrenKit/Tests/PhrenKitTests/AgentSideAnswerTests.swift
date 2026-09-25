import XCTest
@testable import PhrenKit

final class AgentSideAnswerTests: XCTestCase {
    private let id = "3de86345-892c-4d34-bfdb-3116041d3d13"

    func testDecodesAnsweredSideFrameWithoutMessages() throws {
        let data = Data(#"{"type":"side-answer","source":"claude","session":"side-session","id":"3de86345-892c-4d34-bfdb-3116041d3d13","question":"what is 2+2","state":"answer","answer":"2 + 2 = 4."}"#.utf8)
        let frame = try AgentChatTranscript.read(data, source: "claude", session: "side-session")
        XCTAssertEqual(frame.kind, .sideAnswer)
        XCTAssertTrue(frame.messages.isEmpty)
        XCTAssertFalse(frame.updatesPreview)
        XCTAssertEqual(frame.sideAnswer, AgentSideAnswer(id: id, question: "what is 2+2", state: .answer, answer: "2 + 2 = 4."))
    }

    func testDecodesPendingAndCancelledStates() throws {
        for state in ["pending", "cancelled", "error"] {
            let data = Data(#"{"type":"side-answer","source":"claude","id":"\#(id)","question":"q","state":"\#(state)"}"#.utf8)
            XCTAssertEqual(try AgentChatTranscript.read(data, source: "claude").sideAnswer?.state.rawValue, state)
        }
    }

    func testRejectsMalformedSideFrames() {
        for body in [#""id":"not-a-uuid","question":"q","state":"answer","answer":"a""#,
                     #""id":"\#(id)","question":"","state":"pending""#,
                     #""id":"\#(id)","question":"q","state":"thinking""#,
                     #""id":"\#(id)","question":"q","state":"answer""#] {
            let data = Data(#"{"type":"side-answer","source":"claude",\#(body)}"#.utf8)
            XCTAssertThrowsError(try AgentChatTranscript.read(data, source: "claude"), body)
        }
    }

    func testSideQuestionIsClaudeOnlyAndNeedsWords() {
        XCTAssertEqual(AgentSideAnswer.question(source: "claude", text: " /btw  what is\n2+2 "), "what is 2+2")
        XCTAssertNil(AgentSideAnswer.question(source: "claude", text: "/btw"))
        XCTAssertNil(AgentSideAnswer.question(source: "claude", text: "/btwx hi"))
        XCTAssertNil(AgentSideAnswer.question(source: "codex", text: "/btw hi"))
        // Folded from testBtwIsSuggestedForClaude.
        do {
            XCTAssertEqual(AgentSlashCommand.suggestions(source: "claude", draft: "/b"), ["/btw"])
            XCTAssertEqual(AgentSlashCommand.menu(source: "claude", draft: "/btw").first?.detail, "Ask a side question while it works")
            XCTAssertTrue(AgentSlashCommand.suggestions(source: "codex", draft: "/b").isEmpty)
        }
    }
}
