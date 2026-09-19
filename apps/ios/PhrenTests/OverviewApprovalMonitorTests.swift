import XCTest
import PhrenKit
@testable import Phren

@MainActor
final class OverviewApprovalMonitorTests: XCTestCase {
    func testOverviewPublishesEveryExactPendingPaneWithoutOpeningChatAndClearsResolvedTab() async throws {
        let host = try LiveHost(name: "Mac", address: "mac.local", username: "user")
        let session = try session(host, pending: true)
        let first = try target(session, pane: "p1"), second = try target(session, pane: "p2")
        let approval = try approval(first)
        var reads = 0
        var updates: [(AgentChatTarget, String?)] = []
        let monitor = OverviewApprovalMonitor(read: { _ in
            reads += 1
            return [.init(target: first, approval: nil), .init(target: second, approval: approval)]
        }, sync: { request, _, target in updates.append((target, request?.id)) })
        await monitor.refresh([session])
        XCTAssertEqual(reads, 1)
        XCTAssertEqual(updates.map(\.0), [first, second])
        XCTAssertEqual(updates.map(\.1), [nil, "action"])
        updates = []
        await monitor.refresh([try self.session(host, pending: false)])
        XCTAssertEqual(reads, 1, "Tabs without a pending badge must not open status streams")
        XCTAssertEqual(Set(updates.map(\.0)), [first, second])
        XCTAssertTrue(updates.allSatisfy { $0.1 == nil })
    }

    func testFailedLookupDoesNotClearPendingPermissionAndCancelledLookupCannotPublish() async throws {
        let host = try LiveHost(name: "Mac", address: "mac.local", username: "user")
        let session = try session(host, pending: true), target = try target(session, pane: "p1")
        let approval = try approval(target)
        var fail = false, received = 0, started = false
        let monitor = OverviewApprovalMonitor(read: { _ in
            if fail { throw CancellationError() }
            return [.init(target: target, approval: approval)]
        }, sync: { _, _, _ in received += 1 })
        await monitor.refresh([session]); fail = true
        await monitor.refresh([session])
        XCTAssertEqual(received, 1)
        let cancelled = OverviewApprovalMonitor(read: { _ in
            started = true
            try? await Task.sleep(for: .seconds(30))
            return [.init(target: target, approval: approval)]
        }, sync: { _, _, _ in received += 1 })
        let task = Task { await cancelled.refresh([session]) }
        while !started { await Task.yield() }
        task.cancel(); await task.value
        XCTAssertEqual(received, 1)
    }

    func testRejectsTargetFromAnotherTabOrComputer() async throws {
        let host = try LiveHost(name: "Mac", address: "mac.local", username: "user")
        let session = try session(host, pending: true)
        let foreign = try AgentChatTarget(hostID: UUID(), workspaceID: "w1", tabID: "t1", paneID: "p1", source: "codex", sessionID: "session")
        let wrongTab = try AgentChatTarget(hostID: host.id, workspaceID: "w1", tabID: "t2", paneID: "p1", source: "codex", sessionID: "session")
        var received = 0
        let monitor = OverviewApprovalMonitor(read: { _ in
            [.init(target: foreign, approval: nil), .init(target: wrongTab, approval: nil)]
        }, sync: { _, _, _ in received += 1 })
        await monitor.refresh([session])
        XCTAssertEqual(received, 0)
    }

    private func session(_ host: LiveHost, pending: Bool) throws -> LiveAgentSession {
        let data = Data("{\"kind\":\"herdr\",\"groups\":[{\"id\":\"w1\",\"label\":\"Work\",\"children\":[{\"id\":\"t1\",\"label\":\"Agent\",\"agent\":\"codex\",\"approvalPending\":\(pending)}]}]}".utf8)
        return try XCTUnwrap(LiveWorkspaces.read(data).sessions(on: host).first)
    }
    private func target(_ session: LiveAgentSession, pane: String) throws -> AgentChatTarget {
        try AgentChatTarget(hostID: session.host.id, workspaceID: session.workspaceID, tabID: session.tab.id,
                            paneID: pane, source: "codex", sessionID: "session-\(pane)")
    }
    private func approval(_ target: AgentChatTarget) throws -> AgentApproval {
        let data = try JSONSerialization.data(withJSONObject: ["agentStatus": ["source": target.source, "session": target.sessionID,
            "pendingApproval": ["actionId": "action", "expiresAt": Date.now.addingTimeInterval(55).ISO8601Format()]]])
        return try XCTUnwrap(AgentInteractionStatus.read(data, target: target)?.approval)
    }
}
