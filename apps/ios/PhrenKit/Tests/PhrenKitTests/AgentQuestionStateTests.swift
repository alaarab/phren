import XCTest
@testable import PhrenKit

final class AgentQuestionStateTests: XCTestCase {
    private let title = "By code, do you mean Codex?"
    private func ask(_ id: String = "call-1", title: String? = nil, options: [String] = ["Codex", "Claude"]) throws -> [AgentQuestionEvent] {
        let args: [String: Any] = ["questions": [["title": title ?? self.title, "options": options]]]
        return AgentQuestionEvent.read(["type": "response_item", "payload": ["type": "function_call", "name": "functions.request_user_input_async", "call_id": id,
            "arguments": String(decoding: try JSONSerialization.data(withJSONObject: args), as: UTF8.self)]], source: "codex")
    }
    private func output(_ text: String) -> [AgentQuestionEvent] {
        AgentQuestionEvent.read(["type": "response_item", "payload": ["type": "function_call_output", "call_id": "call-1", "output": text]], source: "codex")
    }
    private func reply(_ text: String, role: String = "user") -> [AgentQuestionEvent] {
        AgentQuestionEvent.read(["type": "response_item", "payload": ["type": "message", "role": role, "content": [["type": "input_text", "text": text]]]], source: "codex")
    }
    func testActualCodexAsyncShapeStaysPendingAfterAcceptedAndFinalReply() throws {
        var state = AgentQuestionState()
        state.receive(try ask())
        XCTAssertEqual(state.pending.first?.questions.first?.question, title)
        XCTAssertEqual(state.pending.first?.questions.first?.options.map(\.label), ["Codex", "Claude"])
        XCTAssertEqual(state.pending.first?.isAsync, true)
        state.receive(output(#"{"accepted":true}"#))
        state.receive(reply("I will investigate.", role: "assistant"))
        XCTAssertEqual(state.pending.count, 1)
        state.receive(reply("Another issue"))
        XCTAssertEqual(state.pending.count, 1)
        state.receive(reply("> \(title)\n\nCodex"))
        XCTAssertTrue(state.pending.isEmpty)
        state.receive(try ask(), reset: true)
        XCTAssertTrue(state.pending.isEmpty, "Reconnect must not resurrect an answered prompt")
    }
    func testIndependentQuestionsResolveOnlyTheirMatchingQuotedAnswers() throws {
        var state = AgentQuestionState()
        state.receive(try ask())
        state.receive(try ask("call-2", title: "Which screens?"))
        XCTAssertEqual(state.pending.count, 2)
        state.receive(reply("> \(title)\n\nCodex", role: "assistant"))
        XCTAssertEqual(state.pending.count, 2)
        state.receive(reply("> \(title)\n\nCodex"))
        XCTAssertEqual(state.pending.map(\.id), ["call-2"])
    }
    func testLiveStatusRestoresAnOlderPendingQuestionAndSupportsTypedReply() throws {
        let data = Data(#"{"agentStatus":{"source":"codex","session":"test-session","capabilities":{"questions":false,"asyncQuestions":true},"pendingQuestions":[{"toolUseId":"older-call","isAsync":true,"questions":[{"question":"Which screens?","options":[{"label":"Both"}]}]}]}}"#.utf8)
        let target = try AgentChatTarget(hostID: UUID(), workspaceID: "w1", tabID: "t1", paneID: "p1", source: "codex", sessionID: "test-session")
        let status = try XCTUnwrap(AgentInteractionStatus.read(data, target: target))
        XCTAssertFalse(status.questionsSupported)
        XCTAssertTrue(status.asyncQuestionsSupported)
        var state = AgentQuestionState()
        state.replaceAsync(try XCTUnwrap(status.pendingQuestions))
        state.receive([], reset: true)
        let prompt = try XCTUnwrap(state.pending.first, "A short reconnect backlog must preserve status-restored pending questions")
        XCTAssertEqual(prompt.isAsync, true)
        let body = try JSONSerialization.jsonObject(with: prompt.answerBody(target: target, answers: [.init(text: "Only chat")])) as? [String: Any]
        XCTAssertEqual((body?["answers"] as? [[String: Any]])?.first?["text"] as? String, "Only chat")
        state.replaceAsync([])
        XCTAssertTrue(state.pending.isEmpty)
    }
    func testFailedRequestClearsAndFreeTextAsyncQuestionsParse() throws {
        var state = AgentQuestionState()
        state.receive(try ask(options: []))
        XCTAssertEqual(state.pending.first?.questions.first?.isFreeText, true)
        state.receive(output(#"{"accepted":false,"error":"Unavailable"}"#))
        XCTAssertTrue(state.pending.isEmpty)
    }
}
