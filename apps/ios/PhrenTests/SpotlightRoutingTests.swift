import AppIntents
import PhrenKit
import XCTest
@testable import Phren

@MainActor
final class SpotlightRoutingTests: XCTestCase {
    private let keys = ["sessions.live.preferences.v1", AgentLaunch.pendingKey, AgentLaunch.pendingProjectKey]
    private var saved: [String: Any] = [:]

    override func setUp() async throws {
        for key in keys {
            saved[key] = AppRuntime.defaults.object(forKey: key)
            AppRuntime.defaults.removeObject(forKey: key)
        }
    }

    override func tearDown() async throws {
        for key in keys {
            if let value = saved[key] { AppRuntime.defaults.set(value, forKey: key) }
            else { AppRuntime.defaults.removeObject(forKey: key) }
        }
    }

    private func entity() throws -> AgentSessionEntity {
        let host = try LiveHost(name: "Mini", address: "mini.fixture.invalid", username: "fixture", herdrSession: "work")
        AppRuntime.defaults.set(try LiveSessionPreferences.saving(host, in: Data()), forKey: keys[0])
        return AgentSessionEntity(try AgentLaunch.session(host: host, workspaceID: "w7", tabID: "w7:t9",
                                                         label: "Spotlight chat", agent: "codex", agentStatus: "working", cwd: "/work/phren"))
    }

    func testOpenIntentPersistsExactChatTargetAndConsumesItOnce() async throws {
        let entity = try entity()
        let intent = OpenAgentSessionIntent()
        intent.target = entity
        _ = try await intent.perform()
        let pending = try XCTUnwrap(AgentLaunch.takePendingOpen())
        XCTAssertEqual(pending.destination, .chat)
        XCTAssertEqual(pending.session.host.id, entity.hostID)
        XCTAssertEqual(pending.session.host.muxID, entity.muxID)
        XCTAssertEqual(pending.session.workspaceID, "w7")
        XCTAssertEqual(pending.session.tab.id, "w7:t9")
        XCTAssertNil(AgentLaunch.takePendingOpen())
    }

    func testTerminalActionPreservesPrefilledSession() async throws {
        let entity = try entity()
        let intent = OpenSessionTerminalIntent()
        intent.session = entity
        _ = try await intent.perform()
        let pending = try XCTUnwrap(AgentLaunch.takePendingOpen())
        XCTAssertEqual(pending.destination, .terminal)
        XCTAssertEqual(pending.session.tab.id, entity.tabID)
        XCTAssertEqual(pending.session.host.muxID, "herdr:work")
        let message = MessageAgentIntent()
        message.session = entity
        XCTAssertEqual(message.session.id, entity.id)
    }

    func testChangedTerminalServerCannotOpenAnotherSessionWithSameTabID() throws {
        let entity = try entity()
        let changed = try LiveHost(id: entity.hostID, name: "Mini", address: "mini.fixture.invalid", username: "fixture")
        AppRuntime.defaults.set(try LiveSessionPreferences.saving(changed, in: Data()), forKey: keys[0])
        XCTAssertThrowsError(try AgentLaunch.openIndexedSession(entity, destination: .terminal))
        XCTAssertNil(AgentLaunch.takePendingOpen())
    }

    func testProjectPendingTargetCarriesExactStoreAndSupersedesChat() throws {
        try AgentLaunch.openIndexedSession(entity(), destination: .chat)
        AgentLaunch.setPendingProject(storeID: "team/brain", project: "phren")
        XCTAssertNil(AgentLaunch.takePendingOpen())
        XCTAssertEqual(AgentLaunch.takePendingProject(), .init(storeID: "team/brain", project: "phren"))
        XCTAssertNil(AgentLaunch.takePendingProject())
    }
}
