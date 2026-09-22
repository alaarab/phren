import XCTest
@testable import PhrenKit

final class AgentQueuedQuestionTests: XCTestCase {
    private func status(terminalPrompt: String) throws -> AgentInteractionStatus {
        let json = #"{"agentStatus":{"source":"codex","session":"test-session","status":"blocked","terminalPrompt":\#(terminalPrompt)}}"#
        let data = Data(json.utf8)
        let target = try AgentChatTarget(hostID: UUID(), workspaceID: "w1", tabID: "t1", paneID: "p1", source: "codex", sessionID: "test-session")
        return try XCTUnwrap(AgentInteractionStatus.read(data, target: target))
    }
    func testQueuedFollowUpQuestionDecodesAsAChoiceThatOpensWithAltUp() throws {
        let prompt = try status(terminalPrompt:
            #"{"toolName":"Question","message":"Deploy as-is?","queued":true,"choice":{"title":"Deploy as-is?","options":[{"label":"Yes, deploy","key":"1"},{"label":"Hold","key":"2"}]}}"#
        ).terminalPrompt
        let queued = try XCTUnwrap(prompt)
        XCTAssertTrue(queued.queued)
        XCTAssertEqual(queued.toolName, "Question")
        XCTAssertEqual(queued.message, "Deploy as-is?")
        let choice = try XCTUnwrap(queued.choice)
        XCTAssertEqual(choice.options.map(\.label), ["Yes, deploy", "Hold"])
        XCTAssertEqual(choice.options.compactMap(\.answerKey), [.one, .two])
        let card = try XCTUnwrap(choice.prompt(id: "terminal-choice"))
        XCTAssertEqual(card.questions.first?.question, "Deploy as-is?")
        // The phone answers with alt+up first, then the chosen option's key.
        let keys = [AgentAnswerKey.altUp, choice.answerKey(selections: [0])].compactMap { $0 }
        XCTAssertEqual(keys.map(\.rawValue), ["AltUp", "1"])
    }
    func testUnsupportedTerminalChoiceFallsBackToTerminal() {
        let choice = AgentPromptChoice(title: "Choose", options: [
            .init(label: "Continue", key: "1"), .init(label: "Unsupported", key: "F20"),
        ])
        XCTAssertNil(choice.prompt(id: "choice"))
    }
    func testTerminalPromptWithoutQueuedDefaultsToFalse() throws {
        let prompt = try status(terminalPrompt: #"{"toolName":"Shell","message":"{\"command\":\"ls\"}"}"#).terminalPrompt
        XCTAssertFalse(try XCTUnwrap(prompt).queued)
    }
    func testReleasedAskUserQuestionDecodesItsQuestionsForTheCard() throws {
        let prompt = try XCTUnwrap(status(terminalPrompt:
            #"{"toolName":"AskUserQuestion","message":"{}","questionIndex":0,"questions":[{"question":"Which accent?","header":"Design","options":[{"label":"Cyan","description":"Keep it"},{"label":"Lavender"}]},{"question":"Which screens?","header":"Scope","multiSelect":true,"options":[{"label":"Chat"},{"label":"Agents"}]}]}"#
        ).terminalPrompt)
        XCTAssertNil(prompt.choice)
        XCTAssertEqual(prompt.questionIndex, 0)
        XCTAssertEqual(prompt.questions?.count, 2)
        let card = try XCTUnwrap(prompt.questionPrompt)
        XCTAssertEqual(card.questions.map(\.header), ["Design", "Scope"])
        XCTAssertEqual(card.questions.map(\.multiSelect), [nil, true])
        XCTAssertEqual(card.questions[0].options.map(\.label), ["Cyan", "Lavender"])
        XCTAssertEqual(card.questions[0].options.first?.description, "Keep it")
        XCTAssertEqual(card.questions[1].options.map(\.label), ["Chat", "Agents"])
    }
    func testWaitingStatusWithoutATerminalPromptHasNoCard() throws {
        let json = #"{"agentStatus":{"source":"codex","session":"test-session","status":"blocked"}}"#
        let target = try AgentChatTarget(hostID: UUID(), workspaceID: "w1", tabID: "t1", paneID: "p1", source: "codex", sessionID: "test-session")
        let status = try XCTUnwrap(AgentInteractionStatus.read(Data(json.utf8), target: target))
        XCTAssertNil(status.terminalPrompt)
        XCTAssertFalse(status.passwordPrompt)
    }
    func testDecodesAPasswordPromptAndATerminalChoice() throws {
        let json = #"""
        {"agentStatus":{"source":"codex","session":"test-session","status":"waiting","passwordPrompt":true,
        "terminalPrompt":{"toolName":"Question","message":"Would you like to run the following command?\n$ bun /tmp/x.ts",
        "choice":{"title":"Would you like to run the following command?\n$ bun /tmp/x.ts",
        "options":[{"label":"Yes, proceed","key":"y"},{"label":"Yes, and don't ask again","key":"p"},{"label":"No","key":"esc"}]}}}}
        """#
        let target = try AgentChatTarget(hostID: UUID(), workspaceID: "w1", tabID: "t1", paneID: "p1", source: "codex", sessionID: "test-session")
        let status = try XCTUnwrap(AgentInteractionStatus.read(Data(json.utf8), target: target))
        XCTAssertTrue(status.passwordPrompt)
        let choice = try XCTUnwrap(status.terminalPrompt?.choice)
        XCTAssertEqual(choice.options.map(\.label), ["Yes, proceed", "Yes, and don't ask again", "No"])
        XCTAssertEqual(choice.options.compactMap(\.answerKey), [.yes, .proceedAlways, .escape])
        let card = try XCTUnwrap(choice.prompt(id: "terminal-choice"))
        XCTAssertTrue(try XCTUnwrap(card.questions.first?.question).contains("bun /tmp/x.ts"))
    }
}
