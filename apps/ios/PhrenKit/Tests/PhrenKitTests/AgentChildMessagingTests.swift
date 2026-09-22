import Foundation
import XCTest
@testable import PhrenKit

final class AgentChildMessagingTests: XCTestCase {
    func testOlderInProcessChildUsesLabeledParentDelivery() throws {
        let child = try decode()
        XCTAssertEqual(child.messageDestination, .parent)
        XCTAssertTrue(child.messageNote.contains("goes to its parent"))
        XCTAssertEqual(child.parentMessage("Check the fix"), "About the Parser checks sub-agent: Check the fix")
    }

    func testWorkerCapabilityDecodesWithoutExposingItsSession() throws {
        for provider in ["codex", "opencode"] {
            let child = try decode(provider: provider, fields: #", "fanout":{"resumable":true}"#)
            XCTAssertEqual(child.messageDestination, .worker)
            XCTAssertTrue(child.messageNote.contains("worker's own session"))
            let decoded = try JSONDecoder().decode(AgentChild.self, from: JSONEncoder().encode(child))
            XCTAssertEqual(decoded, child)
            XCTAssertEqual(decoded.navigationID, child.navigationID)
        }
        let unavailable = try decode(fields: #", "fanout":{"resumable":false}"#)
        XCTAssertEqual(unavailable.messageDestination, .unavailableWorker)
        let oldWorker = try decode(call: "fanout:parser")
        XCTAssertEqual(oldWorker.messageDestination, .unavailableWorker)
    }

    func testPaneChildUsesItsFullSessionAndNestedChildKeepsItsOwnRouting() throws {
        let computer = #", "computer":{"id":"c1000000-0000-0000-0000-000000000002","name":"Linuxbox"}"#
        let target = #""target":{"server":"work","workspace":"w9","tab":"w9:t1","pane":"w9:p1","source":"codex","session":"00000000-0000-0000-0000-000000000042"}"#
        let lead = try decode(fields: computer + #", "remote":{\#(target)}"#)
        XCTAssertEqual(lead.messageDestination, .session)
        let nested = try decode(fields: computer + #", "remote":{\#(target),"child":"cccccccccccccccccccccccccccccccc"}, "fanout":{"resumable":true}"#)
        XCTAssertEqual(nested.messageDestination, .worker)
        XCTAssertNotEqual(lead.navigationID, nested.navigationID)
    }

    func testReceiptsDecodeQueuedRunningAndTerminalStatesAndRejectUnknownDelivery() throws {
        for status in ["queued", "running", "completed", "failed"] {
            let body = #"{"ok":true,"message":{"id":"d1000000-0000-0000-0000-000000000001","text":"Review the fix","status":"\#(status)","createdAt":"2026-09-22T12:00:00Z"}}"#
            let receipt = try AgentFanoutMessage.receipt(Data(body.utf8))
            XCTAssertEqual(receipt.status.rawValue, status)
            XCTAssertEqual(receipt.text, "Review the fix")
            let list = try AgentFanoutMessage.list(JSONEncoder().encode(["messages": [receipt]]))
            XCTAssertEqual(list, [receipt])
            XCTAssertThrowsError(try AgentFanoutMessage.receipt(Data(body.replacingOccurrences(of: "true", with: "false").utf8)))
        }
        XCTAssertThrowsError(try AgentFanoutMessage.receipt(Data(#"{"ok":true}"#.utf8)))
    }

    private func decode(provider: String = "codex", call: String = "spawn:parser", fields: String = "") throws -> AgentChild {
        let json = #"{"id":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","provider":"\#(provider)","path":"Parser checks","callId":"\#(call)","state":"completed","children":[]\#(fields)}"#
        return try JSONDecoder().decode(AgentChild.self, from: Data(json.utf8))
    }
}
