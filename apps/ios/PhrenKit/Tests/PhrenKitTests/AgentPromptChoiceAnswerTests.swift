import XCTest
@testable import PhrenKit

final class AgentPromptChoiceAnswerTests: XCTestCase {
    func testCodexDialogUsesItsShortcutsAndFallsBackToEscape() {
        let codex = AgentPromptChoice(title: "Would you like to run the following command?", options: [
            .init(label: "Yes, proceed", key: "y"), .init(label: "No, and tell Codex what to do differently", key: "esc"),
        ])
        XCTAssertEqual(codex.approveKey, .yes)
        XCTAssertEqual(codex.rejectKey, .escape)
        let unlabeled = AgentPromptChoice(title: "Pick one", options: [.init(label: "Keep going", key: "1"), .init(label: "Stop here", key: "2")])
        XCTAssertEqual(unlabeled.approveKey, .one)
        XCTAssertEqual(unlabeled.rejectKey, .escape)
        // Folded from testClaudeDialogApprovesWithYesAndRejectsWithNo.
        do {
            let choice = AgentPromptChoice(title: "Do you want to proceed?", options: [
                .init(label: "Yes", key: "1"), .init(label: "Yes, and don't ask again", key: "2"),
                .init(label: "No", key: "3"), .init(label: "Cancel", key: "Escape"),
            ])
            XCTAssertEqual(choice.approveKey, .one)
            XCTAssertEqual(choice.rejectKey, .three)
        }
    }
}
