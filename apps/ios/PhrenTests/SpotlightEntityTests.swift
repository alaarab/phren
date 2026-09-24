import AppIntents
import PhrenKit
import XCTest
@testable import Phren

final class SpotlightEntityTests: XCTestCase {
    private func session(host: LiveHost? = nil, state: String = "working", branch: String = "feature/search") throws -> LiveAgentSession {
        let host = try host ?? LiveHost(name: "Mini", address: "mini.fixture.invalid", username: "fixture")
        return try LiveWorkspaces.read(Data("""
        {"kind":"herdr","groups":[{"id":"w1","label":"Phone work","children":[
        {"id":"w1:t1","label":"1","title":"Index agent sessions","agent":"codex","agentStatus":"\(state)","branch":"\(branch)","cwd":"/work/phren/apps/ios"}]}]}
        """.utf8)).sessions(on: host)[0]
    }

    @available(iOS 18.0, *)
    func testSessionAttributesIncludeAllSearchableMetadataAndHarnessImage() throws {
        var entity = AgentSessionEntity(try session())
        entity.project = "phren"; entity.projectStoreID = "personal/brain"
        let attributes = entity.attributeSet
        XCTAssertEqual(attributes.title, "Index agent sessions")
        XCTAssertEqual(attributes.displayName, "Index agent sessions · phren on Mini")
        XCTAssertEqual(attributes.containerTitle, "phren")
        XCTAssertEqual(attributes.containerDisplayName, "Mini")
        XCTAssertEqual(attributes.path, "/work/phren/apps/ios")
        for word in ["phren", "Mini", "Codex", "Working", "feature/search", "/work/phren/apps/ios"] {
            XCTAssertTrue(attributes.contentDescription?.contains(word) == true, word)
            XCTAssertTrue(attributes.keywords?.contains(word) == true, word)
        }
        XCTAssertEqual(entity.displayRepresentation.image, .init(named: "CodexMark", isTemplate: true))
    }

    @available(iOS 18.0, *)
    func testProjectAttributesIncludeStoreAndRunningSessionMetadata() throws {
        var project = ProjectEntity(target: .init(storeId: "personal/brain", storeName: "brain", project: "phren", qualified: true))
        project.sourceFolder = "/work/phren"
        project.sessions = [AgentSessionEntity(try session())]
        let attributes = project.attributeSet
        XCTAssertEqual(attributes.title, "phren")
        XCTAssertEqual(attributes.displayName, "phren · brain")
        XCTAssertEqual(attributes.containerIdentifier, "personal/brain")
        XCTAssertEqual(attributes.path, "/work/phren")
        for word in ["Mini", "Codex", "Working", "feature/search", "/work/phren/apps/ios"] {
            XCTAssertTrue(attributes.keywords?.contains(word) == true, word)
        }
        XCTAssertEqual(project.displayRepresentation.image, project.sessions.first?.spotlightImage)
        project.sessions = []
        XCTAssertEqual(project.displayRepresentation.image, .init(systemName: "folder"))
        XCTAssertFalse(project.attributeSet.contentDescription?.contains("Working") == true)
    }

    @available(iOS 18.0, *)
    func testMissingMetadataDoesNotInventStateBranchOrFolder() throws {
        let host = try LiveHost(name: "Mini", address: "mini.fixture.invalid", username: "fixture")
        let live = try LiveWorkspaces.read(Data(#"{"kind":"herdr","groups":[{"id":"w","label":"","children":[{"id":"t","label":"Shell","agent":"claude"}]}]}"#.utf8)).sessions(on: host)[0]
        let entity = AgentSessionEntity(live)
        XCTAssertEqual(entity.workspace, "Shell")
        XCTAssertNil(entity.attributeSet.path)
        XCTAssertTrue(entity.attributeSet.keywords?.contains("Unknown") == true)
        XCTAssertEqual(entity.displayRepresentation.image, .init(named: "ClaudeMark", isTemplate: true))
    }

    func testSuccessfulEmptyRefreshRemovesOnlyThatComputersSessions() throws {
        let mini = try session()
        let studio = try session(host: LiveHost(name: "Studio", address: "studio.fixture.invalid", username: "fixture"))
        var catalog = SpotlightCatalog()
        catalog.refreshSessions([mini], on: mini.host)
        catalog.refreshSessions([studio], on: studio.host)
        XCTAssertEqual(catalog.sessions.count, 2)
        catalog.refreshSessions([], on: mini.host)
        XCTAssertEqual(catalog.sessions.map(\.hostID), [studio.host.id])
        catalog.reconcileHosts([mini.host])
        XCTAssertTrue(catalog.sessions.isEmpty)
    }

    func testMetadataUpdatesReplaceAnEntityWithoutChangingItsIdentifier() throws {
        let first = try session()
        let updated = try session(host: first.host, state: "done", branch: "main")
        var catalog = SpotlightCatalog()
        catalog.refreshSessions([first], on: first.host)
        let id = catalog.sessions[0].id
        catalog.refreshSessions([updated], on: first.host)
        XCTAssertEqual(catalog.sessions.count, 1)
        XCTAssertEqual(catalog.sessions[0].id, id)
        XCTAssertEqual(catalog.sessions[0].state, "Done")
        XCTAssertEqual(catalog.sessions[0].branch, "main")
    }

    @MainActor
    func testProjectMatchingPreservesStoreIdentityAndRejectsAmbiguousNames() throws {
        let live = try session()
        let personal = ProjectEntity(target: .init(storeId: "personal/brain", storeName: "brain", project: "phren", qualified: true))
        let team = ProjectEntity(target: .init(storeId: "team/brain", storeName: "brain", project: "phren", qualified: true))
        XCTAssertNotEqual(personal.id, team.id)
        var catalog = SpotlightCatalog(sessions: [AgentSessionEntity(live)], projects: [personal, team])
        var data = try LiveSessionPreferences.saving(live.host, in: Data())
        catalog.matchProjects(preferences: try LiveSessionPreferences.read(data))
        XCTAssertNil(catalog.sessions[0].projectStoreID)
        XCTAssertTrue(catalog.projects.allSatisfy { $0.sessions.isEmpty })
        XCTAssertNil(SpotlightProjects.runningSession(for: team, among: [live], projects: [personal, team],
                                                      preferences: try LiveSessionPreferences.read(data)))
        data = try LiveSessionPreferences.assigning(hostID: live.host.id, directory: "/work/phren", storeID: "team/brain", project: "phren", in: data)
        catalog.matchProjects(preferences: try LiveSessionPreferences.read(data))
        XCTAssertEqual(catalog.sessions[0].projectStoreID, "team/brain")
        XCTAssertTrue(catalog.projects[0].sessions.isEmpty)
        XCTAssertEqual(catalog.projects[1].sessions.count, 1)
        XCTAssertEqual(SpotlightProjects.runningSession(for: team, among: [live], projects: [personal, team],
                                                        preferences: try LiveSessionPreferences.read(data))?.id, live.id)
        XCTAssertNil(SpotlightProjects.runningSession(for: personal, among: [live], projects: [personal, team],
                                                      preferences: try LiveSessionPreferences.read(data)))
        XCTAssertEqual(try JSONDecoder().decode(SpotlightCatalog.self, from: JSONEncoder().encode(catalog)), catalog)
    }

    @MainActor
    func testReadOnlyStoresAreIndexedAndGlobalIsNotAProject() async throws {
        let directory = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        defer { try? FileManager.default.removeItem(at: directory) }
        let store = try LocalStore(rootDirectory: directory, owner: "team", repo: "brain", branch: "main")
        try await store.write("phren/FINDINGS.md", content: "# Findings\n\n- A project\n", blobSha: nil)
        try await store.write("global/FINDINGS.md", content: "# Findings\n\n- Cross-project memory\n", blobSha: nil)
        let descriptor = StoreDescriptor(owner: "team", name: "brain", branch: "main", canPush: false)
        let projects = SpotlightProjects.entities(in: await store.snapshot(), store: descriptor, qualified: true)
        XCTAssertEqual(projects.map(\.id), ["team/brain|phren"])
        XCTAssertEqual(projects[0].storeId, "team/brain")
        XCTAssertTrue(SpotlightProjects.entities(in: .empty, store: descriptor, qualified: true).isEmpty)
    }
}
