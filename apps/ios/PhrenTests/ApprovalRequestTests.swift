import XCTest
import PhrenKit
@testable import Phren

final class ApprovalRequestTests: XCTestCase {
    func testPersistedRequestIsBoundToHostAndConsumedOnce() async throws {
        let root = FileManager.default.temporaryDirectory.appending(path: UUID().uuidString)
        defer { try? FileManager.default.removeItem(at: root) }
        let url = root.appending(path: "requests.json")
        let host = try LiveHost(name: "Computer", address: "computer.local", username: "user")
        let target = try AgentChatTarget(hostID: host.id, workspaceID: "w1", tabID: "w1:t1", paneID: "w1:p1", source: "codex", sessionID: "conversation")
        let now = Date()
        let record = ApprovalRequestStore.Record(id: UUID().uuidString, actionID: "action", host: host, target: target, expiresAt: now.addingTimeInterval(55))
        let preferences = try LiveSessionPreferences.read(LiveSessionPreferences.saving(host, in: Data()))
        let store = ApprovalRequestStore(url: url)
        let saved = try await store.save(record)
        XCTAssertEqual(saved, record)
        let restored = ApprovalRequestStore(url: url)
        let claimed = try await restored.claim(record.id, preferences: preferences)
        XCTAssertEqual(claimed, record)
        do { _ = try await store.claim(record.id, preferences: preferences); XCTFail("Replayed answer") } catch {}
        _ = try await store.save(record)
        do { _ = try await store.claim(record.id, preferences: preferences, now: now.addingTimeInterval(60)); XCTFail("Expired answer") } catch {}
        _ = try await store.save(record)
        let changedHost = try LiveHost(id: host.id, name: host.name, address: "another.local", username: host.username)
        let changed = try LiveSessionPreferences.read(LiveSessionPreferences.saving(changedHost, in: Data()))
        do { _ = try await store.claim(record.id, preferences: changed); XCTFail("Changed destination") } catch {}
        do { _ = try await store.claim(record.id, preferences: preferences); XCTFail("Retried invalidated answer") } catch {}
    }

    func testApprovalDetailsAndSavedTargetValidation() throws {
        let host = UUID()
        let target = try AgentChatTarget(hostID: host, workspaceID: "w1", tabID: "w1:t1", paneID: "w1:p1", source: "codex", sessionID: "session")
        let input = "{\"justification\":\"Run the requested tests\",\"command\":\"swift test\"}"
        let raw: [String: Any] = ["agentStatus": ["source": "codex", "session": "session", "pendingApproval": [
            "actionId": "action", "message": input, "expiresAt": "2026-09-11T20:00:00.125Z"]]]
        let approval = try XCTUnwrap(AgentInteractionStatus.read(JSONSerialization.data(withJSONObject: raw), target: target)?.approval)
        XCTAssertEqual(approval.explanation, "Run the requested tests")
        XCTAssertEqual(approval.message, input)
        XCTAssertNotNil(approval.expiration)
        let data = try JSONEncoder().encode(target)
        XCTAssertEqual(try JSONDecoder().decode(AgentChatTarget.self, from: data), target)
        var corrupt = try XCTUnwrap(JSONSerialization.jsonObject(with: data) as? [String: Any])
        corrupt["paneID"] = "../../different"
        XCTAssertThrowsError(try JSONDecoder().decode(AgentChatTarget.self, from: JSONSerialization.data(withJSONObject: corrupt)))
    }
}
