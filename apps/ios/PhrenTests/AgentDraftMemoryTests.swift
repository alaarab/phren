import XCTest
import PhrenKit
@testable import Phren

@MainActor
final class AgentDraftMemoryTests: XCTestCase {
    func testConfirmedSavesReleaseAttachmentsAfterConcurrentReadersFinish() throws {
        let target = UUID().uuidString
        let attachment = try AgentAttachment(name: "notes.txt", data: Data("draft".utf8))
        AgentChatDrafts.beginRead(target)
        AgentChatDrafts.beginRead(target)
        AgentChatDrafts.text[target] = "Newest unsaved text"
        AgentChatDrafts.attachments[target] = [.init(attachment: attachment)]
        AgentChatDrafts.pending[target] = 2
        AgentChatDrafts.didSave(target, revision: 1)
        XCTAssertEqual(AgentChatDrafts.text[target], "Newest unsaved text")
        AgentChatDrafts.didSave(target, revision: 2)
        AgentChatDrafts.endRead(target)
        XCTAssertEqual(AgentChatDrafts.attachments[target]?.first?.attachment, attachment)
        AgentChatDrafts.endRead(target)
        XCTAssertNil(AgentChatDrafts.text[target])
        XCTAssertNil(AgentChatDrafts.attachments[target])
        XCTAssertNil(AgentChatDrafts.pending[target])
    }
}
