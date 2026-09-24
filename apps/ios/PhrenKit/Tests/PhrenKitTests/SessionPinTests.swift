import XCTest
@testable import PhrenKit

final class SessionPinTests: XCTestCase {
    private func session(on host: LiveHost, workspace: String = "w1", tab: String = "w1:t1",
                         title: String = "Build", conversation: String = "conversation-a") throws -> LiveAgentSession {
        let raw: [String: Any] = ["kind": "herdr", "groups": [
            ["id": workspace, "label": "Work", "children": [
                ["id": tab, "label": "one", "title": title, "sessionId": conversation]
            ]]
        ]]
        let snapshot = try LiveWorkspaces.read(JSONSerialization.data(withJSONObject: raw))
        return try XCTUnwrap(snapshot.sessions(on: host).first)
    }

    func testOlderPreferencesMigrateAndPinChangesPreserveHostsAndMappings() throws {
        let host = try LiveHost(name: "Mac", address: "mac.example", username: "dev",
                               fingerprint: "SHA256:" + String(repeating: "a", count: 43))
        let other = try LiveHost(name: "Other", address: "other.example", username: "dev", herdrSession: "work")
        var data = try LiveSessionPreferences.saving(host, in: Data())
        data = try LiveSessionPreferences.saving(other, in: data)
        data = try LiveSessionPreferences.assigning(hostID: host.id, directory: "/work/app", storeID: "owner/store", project: "app", in: data)
        var legacy = try XCTUnwrap(JSONSerialization.jsonObject(with: data) as? [String: Any])
        legacy.removeValue(forKey: "pinnedSessions")
        data = try JSONSerialization.data(withJSONObject: legacy)
        let before = try LiveSessionPreferences.read(data)
        XCTAssertTrue(before.pinnedSessions.isEmpty)
        let target = try session(on: host)

        data = try LiveSessionPreferences.setPinned(true, for: target.id, in: data)
        data = try LiveSessionPreferences.setPinned(true, for: target.id, in: data)
        let pinned = try LiveSessionPreferences.read(data)
        XCTAssertEqual(pinned.pinnedSessions, [target.id])
        XCTAssertTrue(pinned.isPinned(target.id))
        XCTAssertEqual(pinned.hosts, before.hosts)
        XCTAssertEqual(pinned.mappings, before.mappings)

        data = try LiveSessionPreferences.setPinned(false, for: target.id, in: data)
        data = try LiveSessionPreferences.setPinned(false, for: target.id, in: data)
        XCTAssertEqual(try LiveSessionPreferences.read(data), before)
    }

    func testPinsUseEachIdentityComponentWithoutDelimiterCollisions() throws {
        let host = try LiveHost(name: "Mac", address: "mac.example", username: "dev")
        let other = try LiveHost(name: "Mac", address: "mac.example", username: "dev")
        let target = try session(on: host, workspace: "w:a", tab: "t")
        var data = try LiveSessionPreferences.saving(host, in: Data())
        data = try LiveSessionPreferences.saving(other, in: data)
        data = try LiveSessionPreferences.setPinned(true, for: target.id, in: data)
        let preferences = try LiveSessionPreferences.read(data)
        XCTAssertTrue(preferences.isPinned(target.id))
        for id in [
            LiveAgentSession.ID(hostID: other.id, workspace: "w:a", tab: "t"),
            LiveAgentSession.ID(hostID: host.id, workspace: "w", tab: "a:t"),
            LiveAgentSession.ID(hostID: host.id, workspace: "other", tab: "t"),
            LiveAgentSession.ID(hostID: host.id, workspace: "w:a", tab: "other"),
            LiveAgentSession.ID(hostID: host.id, workspace: "w:a", tab: "t", muxID: "herdr:work")
        ] {
            XCTAssertFalse(preferences.isPinned(id))
        }
        let raw = try XCTUnwrap(JSONSerialization.jsonObject(with: data) as? [String: Any])
        let pins = try XCTUnwrap(raw["pinnedSessions"] as? [[String: Any]])
        XCTAssertEqual(pins.first?["workspace"] as? String, "w:a")
        XCTAssertEqual(pins.first?["tab"] as? String, "t")
        XCTAssertEqual(pins.first?["muxID"] as? String, "herdr:default")
    }

    func testPinsFollowExistingTabAndPersistAcrossMissingSnapshots() throws {
        let host = try LiveHost(name: "Mac", address: "mac.example", username: "dev")
        let original = try session(on: host)
        let renamed = try session(on: host, title: "Review", conversation: "conversation-b")
        let replacement = try session(on: host, tab: "w1:t2", title: "Build")
        let data = try LiveSessionPreferences.setPinned(true, for: original.id,
                                                       in: LiveSessionPreferences.saving(host, in: Data()))
        let preferences = try LiveSessionPreferences.read(data)
        XCTAssertTrue(preferences.isPinned(renamed.id))
        XCTAssertFalse(preferences.isPinned(replacement.id))
        XCTAssertTrue(preferences.pinnedFirst([]).isEmpty)
        XCTAssertEqual(try LiveSessionPreferences.read(JSONEncoder().encode(preferences)).pinnedSessions, [original.id])
    }

    func testPinnedFirstPreservesOrderWithinBothGroups() throws {
        let host = try LiveHost(name: "Mac", address: "mac.example", username: "dev")
        let sessions = try (1...5).map { try session(on: host, tab: "w1:t\($0)") }
        var data = try LiveSessionPreferences.saving(host, in: Data())
        data = try LiveSessionPreferences.setPinned(true, for: sessions[3].id, in: data)
        data = try LiveSessionPreferences.setPinned(true, for: sessions[1].id, in: data)
        var preferences = try LiveSessionPreferences.read(data)
        XCTAssertEqual(preferences.pinnedFirst(sessions).map(\.id), [1, 3, 0, 2, 4].map { sessions[$0].id })
        XCTAssertEqual(preferences.pinnedFirst([sessions[4], sessions[3]]).map(\.id), [sessions[3].id, sessions[4].id])

        data = try LiveSessionPreferences.setPinned(false, for: sessions[1].id, in: data)
        preferences = try LiveSessionPreferences.read(data)
        XCTAssertEqual(preferences.pinnedFirst(sessions).map(\.id), [3, 0, 1, 2, 4].map { sessions[$0].id })
    }

    func testHostUpdatesPreservePinsAndServerSwitchDoesNotTransferThem() throws {
        let host = try LiveHost(name: "Mac", address: "mac.example", username: "dev")
        let target = try session(on: host)
        var data = try LiveSessionPreferences.setPinned(true, for: target.id,
                                                       in: LiveSessionPreferences.saving(host, in: Data()))
        var changed = try LiveHost(id: host.id, name: "Renamed", address: host.address, username: host.username)
        data = try LiveSessionPreferences.saving(changed, in: data)
        XCTAssertTrue(try LiveSessionPreferences.read(data).isPinned(session(on: changed).id))
        changed.herdrSession = "work"
        data = try LiveSessionPreferences.saving(changed, in: data)
        let otherServer = try session(on: changed)
        XCTAssertFalse(try LiveSessionPreferences.read(data).isPinned(otherServer.id))
        XCTAssertThrowsError(try LiveSessionPreferences.setPinned(true, for: target.id, in: data))
        data = try LiveSessionPreferences.setPinned(true, for: otherServer.id, in: data)
        XCTAssertEqual(try LiveSessionPreferences.read(data).pinnedSessions, [target.id, otherServer.id])
        data = try LiveSessionPreferences.setPinned(false, for: target.id, in: data)
        XCTAssertEqual(try LiveSessionPreferences.read(data).pinnedSessions, [otherServer.id])
    }

    func testHostRemovalCleansOnlyItsPinsAndMappings() throws {
        let host = try LiveHost(name: "Mac", address: "mac.example", username: "dev")
        let other = try LiveHost(name: "Other", address: "other.example", username: "dev")
        let target = try session(on: host), retained = try session(on: other)
        var data = try LiveSessionPreferences.saving(host, in: Data())
        data = try LiveSessionPreferences.saving(other, in: data)
        for session in [target, retained] {
            data = try LiveSessionPreferences.setPinned(true, for: session.id, in: data)
            data = try LiveSessionPreferences.assigning(hostID: session.host.id, directory: "/work/app",
                                                         storeID: "owner/store", project: "app", in: data)
        }
        data = try LiveSessionPreferences.removing(host.id, from: data)
        let preferences = try LiveSessionPreferences.read(data)
        XCTAssertEqual(preferences.hosts, [other])
        XCTAssertEqual(preferences.mappings.map(\.hostID), [other.id])
        XCTAssertEqual(preferences.pinnedSessions, [retained.id])
        XCTAssertThrowsError(try LiveSessionPreferences.setPinned(true, for: target.id, in: data))
    }

    func testPinWritesRejectCorruptAndFuturePreferences() throws {
        let host = try LiveHost(name: "Mac", address: "mac.example", username: "dev")
        let target = try session(on: host)
        let valid = try LiveSessionPreferences.setPinned(true, for: target.id,
                                                        in: LiveSessionPreferences.saving(host, in: Data()))
        let document = try XCTUnwrap(JSONSerialization.jsonObject(with: valid) as? [String: Any])
        let pin = try XCTUnwrap((document["pinnedSessions"] as? [[String: Any]])?.first)
        var missingMux = pin
        missingMux.removeValue(forKey: "muxID")
        var wrongHost = pin
        wrongHost["hostID"] = UUID().uuidString
        var emptyTab = pin
        emptyTab["tab"] = ""
        var corrupted = [Data("garbage".utf8), Data(#"{"schemaVersion":2,"hosts":[],"mappings":[]}"#.utf8)]
        let malformedPins: [Any] = [NSNull(), "invalid", [missingMux], [wrongHost], [emptyTab], [pin, pin]]
        for pins in malformedPins {
            var raw = document
            raw["pinnedSessions"] = pins
            corrupted.append(try JSONSerialization.data(withJSONObject: raw))
        }
        var missingMappings = document
        missingMappings.removeValue(forKey: "mappings")
        corrupted.append(try JSONSerialization.data(withJSONObject: missingMappings))
        for data in corrupted {
            XCTAssertThrowsError(try LiveSessionPreferences.setPinned(true, for: target.id, in: data))
            XCTAssertThrowsError(try LiveSessionPreferences.setPinned(false, for: target.id, in: data))
            XCTAssertThrowsError(try LiveSessionPreferences.saving(host, in: data))
            XCTAssertThrowsError(try LiveSessionPreferences.removing(host.id, from: data))
        }
    }
}
