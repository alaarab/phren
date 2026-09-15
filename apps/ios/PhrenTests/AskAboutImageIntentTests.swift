import PhrenKit
import XCTest
@testable import Phren

@MainActor
final class AskAboutImageIntentTests: XCTestCase {
    private let keys = ["sessions.live.preferences.v1", AgentLaunch.pendingKey,
                        AgentLaunch.pendingProjectKey, AgentLaunch.pendingContentKey]
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

    private func fixture() throws -> (LiveHost, [LiveAgentSession]) {
        let host = try LiveHost(name: "Mini", address: "mini.fixture.invalid", username: "fixture")
        let data = try JSONSerialization.data(withJSONObject: [
            "kind": "herdr",
            "groups": [["id": "w1", "label": "Workspace", "children": [
                ["id": "w1:t1", "label": "1", "title": "Working chat", "agent": "codex",
                 "agentStatus": "working", "cwd": "/work/one"],
                ["id": "w1:t2", "label": "2", "title": "Waiting chat", "agent": "claude",
                 "agentStatus": "waiting", "cwd": "/work/two"],
            ]]],
        ])
        AppRuntime.defaults.set(try LiveSessionPreferences.saving(host, in: Data()), forKey: keys[0])
        return (host, try LiveWorkspaces.read(data).sessions(on: host))
    }

    func testUnspecifiedSessionResolvesMostRelevantWaitingSession() throws {
        let (_, sessions) = try fixture()
        let resolved = AskAboutImageRouting.resolve(nil, sessions: sessions, projects: [], preferences: nil)
        XCTAssertEqual(resolved?.tab.id, "w1:t2")
    }

    func testExplicitSessionOverridesAttentionRanking() throws {
        let (_, sessions) = try fixture()
        let requested = AgentSessionEntity(try XCTUnwrap(sessions.first { $0.tab.id == "w1:t1" }))
        let resolved = AskAboutImageRouting.resolve(requested, sessions: sessions, projects: [], preferences: nil)
        XCTAssertEqual(resolved?.tab.id, "w1:t1")
    }

    func testImageAndDraftTravelThroughPendingChatAndAreConsumedOnce() throws {
        let (_, sessions) = try fixture()
        let session = try XCTUnwrap(sessions.first)
        let root = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString, isDirectory: true)
        defer { try? FileManager.default.removeItem(at: root) }
        let store = PendingChatAttachmentStore(root: root)
        let image = try AgentAttachment(name: "terminal.png", data: Data([0x89, 0x50, 0x4e, 0x47]), isImage: true)

        try AgentLaunch.setPending(session, draft: "What should I know about this image?",
                                   attachments: [image], attachmentStore: store)
        let pending = try XCTUnwrap(AgentLaunch.takePendingOpen())
        let content = AgentLaunch.takePendingContent(for: pending.session, store: store)

        XCTAssertEqual(content.draft, "What should I know about this image?")
        XCTAssertEqual(content.attachments, [image])
        XCTAssertEqual(AgentLaunch.takePendingContent(for: pending.session, store: store).attachments, [])
        XCTAssertFalse(FileManager.default.fileExists(atPath: root.appendingPathComponent(image.id.uuidString.lowercased() + ".bin").path))
    }
}
