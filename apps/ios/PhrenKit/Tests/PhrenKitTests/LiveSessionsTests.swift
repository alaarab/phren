import XCTest
@testable import PhrenKit

final class LiveSessionsTests: XCTestCase {
    private let fixture = Data(#"{"kind":"herdr","capabilities":{"paneList":true},"groups":[{"id":"wA","label":"Project","agentStatus":"working","children":[{"id":"wA:t2","label":"Build","agentStatus":"working","agent":"codex","sessionId":"agent-conversation-not-a-herdr-server","cwd":"/work/app","agentPaneCount":2},{"id":"wA:t3","label":"Shell"}]}]}"#.utf8)

    func testObservedHookContractAndUnknownState() throws {
        let value = try LiveWorkspaces.read(fixture)
        XCTAssertEqual(value.groups[0].children[0].status, "Working")
        XCTAssertEqual(value.groups[0].children[0].agentPaneCount, 2)
        XCTAssertEqual(value.groups[0].children[1].status, "Unknown")
        XCTAssertNil(value.groups[0].children[1].cwd)
        XCTAssertThrowsError(try LiveWorkspaces.read(Data(#"{"kind":"tmux","groups":[]}"#.utf8)))
        XCTAssertThrowsError(try LiveWorkspaces.read(Data(repeating: 32, count: 1_048_577)))
        XCTAssertThrowsError(try LiveWorkspaces.read(Data(#"{"kind":"herdr","groups":[{"id":"w1","label":"a","children":[]},{"id":"w1","label":"b","children":[]}]}"#.utf8)))
    }

    func testFocusIsOptionalAndMustReferenceTheReportedWorkspaceAndTab() throws {
        XCTAssertNil(try LiveWorkspaces.read(fixture).focus)
        var raw = try XCTUnwrap(JSONSerialization.jsonObject(with: fixture) as? [String: Any])
        raw["focus"] = ["workspaceID": "wA", "tabID": "wA:t2", "paneID": "wA:p1"]
        XCTAssertEqual(try LiveWorkspaces.read(JSONSerialization.data(withJSONObject: raw)).focus?.paneID, "wA:p1")
        raw["focus"] = ["workspaceID": "wB", "tabID": "wA:t2", "paneID": "wA:p1"]
        XCTAssertThrowsError(try LiveWorkspaces.read(JSONSerialization.data(withJSONObject: raw)))
        raw["focus"] = ["workspaceID": "wA", "tabID": "wA:t2", "paneID": "../wrong"]
        XCTAssertThrowsError(try LiveWorkspaces.read(JSONSerialization.data(withJSONObject: raw)))
    }

    func testReadableTitlesAndConservativeActivity() throws {
        let value = try LiveWorkspaces.read(Data(#"{"kind":"herdr","groups":[{"id":"w1","label":"Phone","children":[{"id":"w1:t1","label":"1","title":"  Build the phone app  ","agentStatus":"blocked","agentPaneCount":2,"paneCount":3},{"id":"w1:t2","label":"Shell","title":"  ","agentStatus":"future-state"}]}]}"#.utf8))
        let tabs = value.groups[0].children
        XCTAssertEqual(tabs[0].displayTitle, "Build the phone app")
        XCTAssertEqual(tabs[0].activity, .waiting)
        XCTAssertEqual(tabs[0].agentPaneCount, 2)
        XCTAssertEqual(tabs[0].paneCount, 3)
        XCTAssertEqual(tabs[1].displayTitle, "Shell")
        XCTAssertEqual(tabs[1].activity, .unknown)
        XCTAssertNil(tabs[1].agentPaneCount)
        XCTAssertNil(tabs[1].paneCount)
    }

    func testSearchFindsTitleWorkspaceAgentAndFolderTogether() throws {
        let value = try LiveWorkspaces.read(Data(#"{"kind":"herdr","groups":[{"id":"w1","label":"Phone work","children":[{"id":"w1:t1","label":"1","title":"Fix navigation","agent":"codex","cwd":"/work/mobile/src"}]}]}"#.utf8))
        let host = try LiveHost(name: "Mac", address: "fixture.invalid", username: "fixture")
        let session = try XCTUnwrap(value.sessions(on: host).first)
        XCTAssertTrue(session.matches("NAVIGATION codex"))
        XCTAssertTrue(session.matches("phone mobile"))
        XCTAssertTrue(session.matches("ios navigation", projectName: "iOS"))
        XCTAssertTrue(session.matches("  \n "))
        XCTAssertFalse(session.matches("navigation unrelated"))
    }

    func testExplicitStoreAndHostIdentityWithLongestDirectoryBoundary() throws {
        let a = try LiveHost(name: "A", address: "100.64.0.1", username: "user")
        let b = try LiveHost(name: "B", address: "server.tail.example", username: "user")
        var data = try LiveSessionPreferences.saving(a, in: Data())
        data = try LiveSessionPreferences.saving(b, in: data)
        data = try LiveSessionPreferences.assigning(hostID: a.id, directory: "/work/app/", storeID: "personal/brain", project: "app", in: data)
        data = try LiveSessionPreferences.assigning(hostID: a.id, directory: "/work/app/team", storeID: "team/brain", project: "app", in: data)
        let value = try LiveSessionPreferences.read(data)
        XCTAssertEqual(value.mapping(hostID: a.id, cwd: "/work/app/src")?.storeID, "personal/brain")
        XCTAssertEqual(value.mapping(hostID: a.id, cwd: "/work/app/team/src")?.storeID, "team/brain")
        XCTAssertNil(value.mapping(hostID: a.id, cwd: "/work/app-other"))
        XCTAssertNil(value.mapping(hostID: b.id, cwd: "/work/app"))
        XCTAssertNil(value.mapping(hostID: a.id, cwd: "/work/app/../secret"))
        XCTAssertNil(value.mapping(hostID: a.id, cwd: nil))
        let removed = try LiveSessionPreferences.read(LiveSessionPreferences.removing(a.id, from: data))
        XCTAssertEqual(removed.hosts.map(\.id), [b.id])
        XCTAssertTrue(removed.mappings.isEmpty)
    }

    func testCorruptAndFuturePreferencesCannotBeOverwritten() throws {
        let host = try LiveHost(name: "Mac", address: "example", username: "user")
        for raw in ["garbage", #"{"schemaVersion":2,"hosts":[],"mappings":[]}"#] {
            let original = Data(raw.utf8)
            XCTAssertThrowsError(try LiveSessionPreferences.saving(host, in: original))
            XCTAssertThrowsError(try LiveSessionPreferences.removing(host.id, from: original))
        }
        XCTAssertNoThrow(try LiveSessionPreferences.read(Data(#"{"schemaVersion":1,"hosts":[],"mappings":[]}"#.utf8)))
        XCTAssertThrowsError(try LiveHost(name: "Mac", address: "https://example", username: "user"))
        XCTAssertThrowsError(try LiveHost(name: "Mac", address: "example", port: 65536, username: "user"))
        XCTAssertThrowsError(try LiveHost(name: "Mac", address: "example", username: "user", fingerprint: "not-a-pin"))
    }

    func testHostColorCompatibilityPersistenceAndDefault() throws {
        let id = try XCTUnwrap(UUID(uuidString: "A1000000-0000-0000-0000-000000000001"))
        let oldHost = Data(#"{"id":"A1000000-0000-0000-0000-000000000001","name":"Test Mac","address":"fixture.invalid","port":22,"username":"fixture"}"#.utf8)
        XCTAssertNil(try JSONDecoder().decode(LiveHost.self, from: oldHost).color)

        let host = try LiveHost(id: id, name: "Test Mac", address: "fixture.invalid", username: "fixture")
        var data = try LiveSessionPreferences.saving(host, in: Data())
        data = try LiveSessionPreferences.settingColor(hostID: id, color: "#FF8A5B", in: data)
        XCTAssertEqual(try LiveSessionPreferences.read(data).hosts.first?.color, "#FF8A5B")
        XCTAssertEqual(try JSONDecoder().decode(LiveSessionPreferences.self, from: data).hosts.first?.color, "#FF8A5B")

        let first = LiveHost.defaultColor(for: id)
        XCTAssertEqual(first, LiveHost.defaultColor(for: id))
        XCTAssertTrue(LiveHost.colorPalette.contains(first))
    }
}
