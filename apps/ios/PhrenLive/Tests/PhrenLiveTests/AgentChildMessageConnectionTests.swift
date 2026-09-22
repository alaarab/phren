import Foundation
import PhrenKit
import XCTest
@testable import PhrenLive

final class AgentChildMessageConnectionTests: XCTestCase {
    func testWorkerResumeCarriesParentTargetAndOpaqueChildOnly() throws {
        let target = try AgentChatTarget(hostID: UUID(), workspaceID: "w", tabID: "w:t", paneID: "w:p", source: "codex", sessionID: "fixture")
        let child = String(repeating: "a", count: 32)
        let text = "Review `file.swift`\n$(literal)"
        let request = try GatewayRequest.resumeChild(target, child: child, text: text)
        let body = try XCTUnwrap(JSONSerialization.jsonObject(with: XCTUnwrap(request.body)) as? [String: Any])
        XCTAssertEqual(request.path, "/v1/subagents/resume")
        XCTAssertEqual(body["target"] as? [String: String], GatewayRequest.targetQuery(target))
        XCTAssertEqual(body["child"] as? String, child)
        XCTAssertEqual(body["text"] as? String, text)
        XCTAssertNil(body["store"]); XCTAssertNil(body["worktree"]); XCTAssertNil(body["session"])
    }

    func testWorkerResumeRefusesAnotherComputerBeforeUsingItsKey() async throws {
        let host = try LiveHost(name: "Desk", address: "desk.example", username: "sam")
        let target = try AgentChatTarget(hostID: UUID(), workspaceID: "w", tabID: "w:t", paneID: "w:p", source: "codex", sessionID: "fixture")
        do {
            _ = try await PhrenConnection.resumeChildAgent(host: host, privateKey: Data(), target: target,
                child: String(repeating: "a", count: 32), text: "Do not send")
            XCTFail("The destination must be validated before transport")
        } catch { XCTAssertTrue(error.localizedDescription.contains("another computer")) }
    }

}
