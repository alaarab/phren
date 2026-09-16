import Foundation
import XCTest
@testable import PhrenKit

final class AgentIntegrationTests: XCTestCase {
    private func target(_ mux: String = "herdr:default", host: UUID = UUID()) throws -> AgentChatTarget {
        try .init(hostID: host, workspaceID: "w1", tabID: "w1:t1", paneID: "w1:p1", source: "codex", sessionID: "test-session", muxID: mux)
    }
    func testLegacyHostDefaultsToDefaultHerdrAndNamedServersIsolateDrafts() throws {
        let id = UUID()
        let old = Data("{\"id\":\"\(id)\",\"name\":\"Mac\",\"address\":\"mac.local\",\"port\":22,\"username\":\"me\"}".utf8)
        let host = try JSONDecoder().decode(LiveHost.self, from: old)
        XCTAssertEqual(host.muxID, "herdr:default")
        XCTAssertNotEqual(try target(host: id).id, try target("herdr:work", host: id).id)
        XCTAssertThrowsError(try LiveHost(name: "Mac", address: "mac", username: "me", herdrSession: "wrong:server"))
    }
    func testDraftSurvivesNewStoreWithImagesAndClearsOnlyItsConversation() throws {
        let root = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        defer { try? FileManager.default.removeItem(at: root) }
        let attachment = try AgentAttachment(name: "photo.png", data: Data([1, 2, 3]), isImage: true)
        let store = AgentDraftStore(root: root)
        try store.save(.init(text: "Unsent words", attachments: [attachment]), target: "first")
        try store.save(.init(text: "Other computer"), target: "second")
        let reopened = AgentDraftStore(root: root)
        let draft = try reopened.load(target: "first")
        XCTAssertEqual(draft.text, "Unsent words"); XCTAssertEqual(draft.attachments, [attachment])
        try reopened.save(.init(), target: "first")
        XCTAssertEqual(try reopened.load(target: "second").text, "Other computer")
        XCTAssertEqual(try AgentDraftStore(root: root).load(target: "first").text, "")
    }
    func testDraftRepositoryRejectsDelayedSavesAfterNewerEditsAndClear() async throws {
        let root = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        defer { try? FileManager.default.removeItem(at: root) }
        let repository = AgentDraftRepository(root: root)
        let file = try AgentAttachment(name: "sample.png", data: Data(repeating: 1, count: 1024), isImage: true)
        try await repository.save(.init(text: "newer", attachments: [file]), target: "first", revision: 2)
        try await repository.save(.init(text: "delayed"), target: "first", revision: 1)
        let latest = try await repository.load(target: "first")
        XCTAssertEqual(latest.text, "newer"); XCTAssertEqual(latest.attachments, [file])
        try await repository.save(.init(text: "other machine"), target: "second", revision: 3)
        try await repository.save(.init(), target: "first", revision: 4)
        try await repository.save(.init(text: "old text", attachments: [file]), target: "first", revision: 2)
        XCTAssertEqual(try AgentDraftStore(root: root).load(target: "first").text, "")
        try await repository.save(.init(text: "reattached", attachments: [file]), target: "first", revision: 5)
        XCTAssertEqual(try AgentDraftStore(root: root).load(target: "first").attachments, [file])
        XCTAssertEqual(try AgentDraftStore(root: root).load(target: "second").text, "other machine")
    }
    func testCorruptOrFutureDraftCannotBeOverwrittenEvenWithoutLoadingFirst() throws {
        for future in [false, true] {
            let root = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
            defer { try? FileManager.default.removeItem(at: root) }
            try AgentDraftStore(root: root).save(.init(text: "preserve me"), target: "target")
            let folder = try XCTUnwrap(FileManager.default.contentsOfDirectory(at: root, includingPropertiesForKeys: nil).first)
            let manifest = folder.appendingPathComponent("draft.json")
            let original = Data((future ? #"{"schemaVersion":999,"target":"target","text":"future draft","files":[]}"# : "broken json").utf8)
            try original.write(to: manifest)
            XCTAssertThrowsError(try AgentDraftStore(root: root).save(.init(), target: "target"))
            XCTAssertThrowsError(try AgentDraftStore(root: root).save(.init(text: "replacement"), target: "target"))
            let preserved = try FileManager.default.contentsOfDirectory(at: folder, includingPropertiesForKeys: nil)
            XCTAssertTrue(preserved.contains { (try? Data(contentsOf: $0)) == original })
        }
    }
    func testAttachmentCorruptionPreservesManifestAndRejectsLoad() throws {
        let root = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        defer { try? FileManager.default.removeItem(at: root) }
        let item = try AgentAttachment(name: "file.txt", data: Data("original".utf8), isImage: false)
        try AgentDraftStore(root: root).save(.init(attachments: [item]), target: "target")
        let folder = try XCTUnwrap(FileManager.default.contentsOfDirectory(at: root, includingPropertiesForKeys: nil).first)
        try Data("changed".utf8).write(to: folder.appendingPathComponent(item.id.uuidString + ".bin"))
        XCTAssertThrowsError(try AgentDraftStore(root: root).load(target: "target"))
        XCTAssertTrue(FileManager.default.fileExists(atPath: folder.appendingPathComponent("draft.json").path))
    }
    func testHandwrittenLegacyDraftDefaultsAndAttachmentQuota() throws {
        let root = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        defer { try? FileManager.default.removeItem(at: root) }
        try AgentDraftStore(root: root).save(.init(text: "initial"), target: "target")
        let folder = try XCTUnwrap(FileManager.default.contentsOfDirectory(at: root, includingPropertiesForKeys: nil).first)
        try Data(#"{"target":"target","text":"Unsent legacy draft"}"#.utf8).write(to: folder.appendingPathComponent("draft.json"))
        let reopened = AgentDraftStore(root: root)
        let draft = try reopened.load(target: "target")
        XCTAssertEqual(draft.text, "Unsent legacy draft"); XCTAssertTrue(draft.attachments.isEmpty)
        let quota = root.appendingPathComponent("quota-fixture.bin")
        FileManager.default.createFile(atPath: quota.path, contents: Data())
        let handle = try FileHandle(forWritingTo: quota)
        try handle.truncate(atOffset: 256 * 1_024 * 1_024); try handle.close()
        let item = try AgentAttachment(name: "file.txt", data: Data("new bytes".utf8), isImage: false)
        XCTAssertThrowsError(try reopened.save(.init(text: draft.text, attachments: [item]), target: "target"))
        XCTAssertEqual(try AgentDraftStore(root: root).load(target: "target").text, draft.text)
    }
    func testOriginalImageIndexesAndQuestionResolutionArePreserved() throws {
        let raw = Data(#"{"type":"backlog","source":"claude","entries":[{"line":18,"raw":{"message":{"role":"user","content":[{"type":"thinking","thinking":"private"},{"type":"text","text":"photo"},{"type":"image","source":{"type":"base64","data":"fake"}}]}}}] }"#.utf8)
        XCTAssertEqual(try AgentChatTranscript.read(raw, source: "claude").messages.flatMap(\.imageBlocks), [2])
        let prompt = try JSONDecoder().decode(AgentQuestionPrompt.self, from: Data(#"{"toolUseId":"question-1","questions":[{"id":"color","question":"Which color?","options":[{"label":"Cyan"},{"label":"Purple"}]}]}"#.utf8))
        let t = try target()
        let body = try XCTUnwrap(JSONSerialization.jsonObject(with: prompt.answerBody(target: t, selections: [[1]])) as? [String: Any])
        XCTAssertEqual(body["toolUseId"] as? String, "question-1")
        XCTAssertEqual((body["answers"] as? [[String: Any]])?.first?["optionIndexes"] as? [Int], [1])
        XCTAssertThrowsError(try prompt.answerBody(target: t, selections: [[2]]))
        XCTAssertThrowsError(try prompt.answerBody(target: t, selections: [[0, 1]]))
        XCTAssertEqual(AgentQuestionEvent.read(["type": "response_item", "payload": ["type": "function_call_output", "call_id": "question-1"]], source: "codex"), [.resolved("question-1")])
    }
    func testAskUserQuestionApprovalBecomesQuestionsAndAnswersOnlyAddToItsInput() throws {
        let t = try target()
        let input: [String: Any] = ["title": "Design", "questions": [
            ["question": "Which accent?", "header": "Design", "options": [["label": "Cyan", "description": "Keep it"], ["label": "Lavender", "description": "Softer"]]],
            ["question": "Which screens?", "header": "Scope", "multiSelect": true, "options": [["label": "Chat"], ["label": "Agents"], ["label": "Settings"]]],
        ], "metadata": ["source": "plan"]]
        let message = String(decoding: try JSONSerialization.data(withJSONObject: input), as: UTF8.self)
        let raw: [String: Any] = ["agentStatus": ["source": "codex", "session": "test-session", "pendingApproval": [
            "actionId": "ask-1", "toolName": "AskUserQuestion", "title": "Allow AskUserQuestion?", "message": message]]]
        let approval = try XCTUnwrap(AgentInteractionStatus.read(JSONSerialization.data(withJSONObject: raw), target: t)?.approval)
        XCTAssertTrue(approval.isQuestion)
        let prompt = try XCTUnwrap(approval.questionPrompt)
        XCTAssertEqual(prompt.id, "ask-1")
        XCTAssertEqual(prompt.questions.map(\.header), ["Design", "Scope"])
        XCTAssertEqual(prompt.questions.map(\.multiSelect), [nil, true])
        XCTAssertEqual(prompt.questions[0].options.map(\.description), ["Keep it", "Softer"])
        XCTAssertFalse(prompt.questions[0].isFreeText)
        // Incomplete or over-chosen answers never build an input.
        XCTAssertFalse(prompt.isAnswered([.init(selections: [0]), .init()]))
        XCTAssertFalse(prompt.isAnswered([.init(selections: [0, 1]), .init(selections: [1])]))
        XCTAssertFalse(prompt.isAnswered([.init(selections: [0], text: "Other"), .init(selections: [1])]))
        XCTAssertFalse(prompt.isAnswered([.init(selections: [2]), .init(selections: [1])]))
        XCTAssertTrue(prompt.isAnswered([.init(selections: [0]), .init(selections: [1])]))
        let original = try XCTUnwrap(approval.questionInput)
        let answered = try prompt.answeredInput(original, answers: [.init(text: " Something warmer "), .init(selections: [2, 0], text: "Onboarding")])
        let answers = try XCTUnwrap(answered["answers"] as? [String: Any])
        XCTAssertEqual(answers["Which accent?"] as? String, "Something warmer")
        XCTAssertEqual(answers["Which screens?"] as? [String], ["Chat", "Settings", "Onboarding"])
        // The round trip keeps the request's own input intact beside the answers.
        var untouched = answered; untouched["answers"] = nil
        XCTAssertEqual(try JSONSerialization.data(withJSONObject: untouched, options: .sortedKeys),
                       try JSONSerialization.data(withJSONObject: original, options: .sortedKeys))
        XCTAssertEqual(try JSONSerialization.data(withJSONObject: untouched, options: .sortedKeys),
                       try JSONSerialization.data(withJSONObject: input, options: .sortedKeys))
        // A typed kind takes text alone; other tools are not questions.
        let typed = try XCTUnwrap(AgentQuestionPrompt.read(id: "ask-2", questions: [["question": "How many?", "kind": "number", "options": []]]))
        XCTAssertTrue(typed.questions[0].isFreeText)
        XCTAssertEqual(try typed.answeredInput([:], answers: [.init(text: "3")])["answers"] as? [String: String], ["How many?": "3"])
        XCTAssertFalse(typed.isAnswered([.init()]))
        XCTAssertNil(AgentQuestionPrompt.read(id: "ask-3", questions: [["question": "Pick", "options": []]]))
        let bash = try XCTUnwrap(AgentInteractionStatus.read(Data(#"{"agentStatus":{"source":"codex","session":"test-session","pendingApproval":{"actionId":"a","toolName":"Bash","message":"{\"questions\":[]}"}}}"#.utf8), target: t)?.approval)
        XCTAssertFalse(bash.isQuestion); XCTAssertNil(bash.questionPrompt)
    }
    func testApprovalMustMatchConversationAndDiffMustStayOnGateway() throws {
        let t = try target()
        let valid = Data(#"{"agentStatus":{"source":"codex","session":"test-session","pendingApproval":{"actionId":"action-1","title":"Run tests","message":"npm test"}}}"#.utf8)
        XCTAssertEqual(try AgentInteractionStatus.read(valid, target: t)?.approval?.id, "action-1")
        XCTAssertThrowsError(try AgentInteractionStatus.read(Data(String(decoding: valid, as: UTF8.self).replacingOccurrences(of: "test-session", with: "other").utf8), target: t))
        XCTAssertEqual(try AgentRepositoryDiff.statusPath(Data(#"{"git":true,"url":"/apps/diff/diff_ab12/"}"#.utf8)), "/apps/diff/diff_ab12/api/status")
        for url in ["https://example.com/", "/apps/diff/diff_ab12/../", "/apps/diff/diff_ab12/?token=x"] {
            XCTAssertThrowsError(try AgentRepositoryDiff.statusPath(JSONSerialization.data(withJSONObject: ["git": true, "url": url])))
        }
    }
}
