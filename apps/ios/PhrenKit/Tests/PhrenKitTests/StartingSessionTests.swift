import Foundation
import XCTest
@testable import PhrenKit

final class StartingSessionTests: XCTestCase {
    private let token = String(repeating: "a", count: 64)
    private func panes(session: String? = nil, token: String? = nil, starting: Bool = true) throws -> AgentChatPanes {
        var pane: [String: Any] = ["id": "w:p", "label": "1", "agent": "codex", "agentStatus": "idle", "startingToken": token ?? self.token]
        if let session { pane["sessionId"] = session } else if starting { pane["starting"] = true }
        return try AgentChatPanes.read(JSONSerialization.data(withJSONObject: ["kind": "herdr", "groupId": "w", "childId": "w:t", "panes": [pane]]), workspaceID: "w", tabID: "w:t")
    }
    func testStartingTargetRequiresAnExplicitBoundPaneAndRoundTrips() throws {
        let list = try panes()
        let target = try list.panes[0].target(hostID: UUID(), workspaceID: "w", tabID: "w:t")
        XCTAssertTrue(target.isStarting); XCTAssertEqual(target.sessionID, "")
        XCTAssertEqual(try list.validate(target, sending: true).id, "w:p")
        XCTAssertEqual(try JSONDecoder().decode(AgentChatTarget.self, from: JSONEncoder().encode(target)), target)
        XCTAssertThrowsError(try panes(starting: false).panes[0].target(hostID: UUID(), workspaceID: "w", tabID: "w:t"))
        XCTAssertThrowsError(try AgentChatTarget(hostID: UUID(), workspaceID: "w", tabID: "w:t", paneID: "w:p", source: "codex", sessionID: ""))
    }
    func testAttachmentRequiresTheSameTerminalAndNeverSelectsAnotherPane() throws {
        let list = try panes()
        let target = try list.panes[0].target(hostID: UUID(), workspaceID: "w", tabID: "w:t")
        XCTAssertNil(try list.attachedTarget(for: target))
        let ready = try panes(session: "aaaaaaaa-1111-4111-8111-111111111111")
        let attached = try XCTUnwrap(ready.attachedTarget(for: target))
        XCTAssertFalse(attached.isStarting); XCTAssertEqual(attached.paneID, target.paneID)
        XCTAssertThrowsError(try ready.validate(target), "A stale first-send target cannot send after attachment")
        XCTAssertThrowsError(try panes(session: "other", token: String(repeating: "b", count: 64)).attachedTarget(for: target))
    }
    func testWorkspacePreservesStartingFlagAndOlderHookStillDecodes() throws {
        for starting in [true, false] {
            var tab: [String: Any] = ["id": "w:t", "label": "1", "agent": "claude"]
            if starting { tab["starting"] = true }
            let snapshot = try LiveWorkspaces.read(JSONSerialization.data(withJSONObject: ["kind": "herdr", "groups": [["id": "w", "label": "Project", "children": [tab]]]]))
            XCTAssertEqual(snapshot.groups[0].children[0].starting, starting ? true : nil)
        }
    }
}
