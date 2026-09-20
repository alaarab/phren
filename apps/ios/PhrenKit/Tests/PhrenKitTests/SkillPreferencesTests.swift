import XCTest
@testable import PhrenKit

final class SkillPreferencesTests: XCTestCase {
    func testReadsCLISettingsAndNormalizesNames() throws {
        let prefs = try SkillPreferences.parse(Fixtures.text("skill-preferences.json"))
        XCTAssertEqual(prefs.explicitSetting(scope: "myproj", name: "Audit.MD"), false)
        XCTAssertEqual(prefs.explicitSetting(scope: "global", name: "audit"), true)
        XCTAssertNil(prefs.explicitSetting(scope: "other", name: "audit"))
    }

    func testOnlySkillPreferencesAreAdmittedUnderConfig() {
        XCTAssertTrue(LocalStore.isWritablePath(SkillPreferences.path))
        XCTAssertTrue(LocalStore.isSyncedPath(SkillPreferences.path))
        for path in [".config/install-preferences.json", ".config/access-control.json", ".config//skill-preferences.json",
                     "/.config/skill-preferences.json", ".runtime/install-preferences.json"] {
            XCTAssertFalse(LocalStore.isWritablePath(path))
            XCTAssertFalse(LocalStore.isSyncedPath(path))
        }
    }

    func testChangesOneKeyAndPreservesUnknownMetadata() throws {
        let original = #"{"schemaVersion":1,"enabledSkills":{"demo:audit":false,"other:audit":true},"future":{"keep":[1,2]}}"#
        let changed = try SkillPreferences.setting(original, scope: "demo", name: "audit", enabled: true, expected: false)
        let parsed = try SkillPreferences.parse(changed)
        XCTAssertEqual(parsed.enabledSkills, ["demo:audit": true, "other:audit": true])
        let json = try XCTUnwrap(JSONSerialization.jsonObject(with: Data(changed.utf8)) as? [String: Any])
        XCTAssertEqual((json["future"] as? [String: [Int]])?["keep"], [1, 2])
    }

    func testMalformedFutureAndConflictingSettingsAreNeverOverwritten() {
        for bad in ["broken", "[]", #"{"schemaVersion":2,"enabledSkills":{}}"#,
                    #"{"schemaVersion":true,"enabledSkills":{}}"#, #"{"schemaVersion":1,"enabledSkills":{"demo:audit":"false"}}"#] {
            XCTAssertThrowsError(try SkillPreferences.setting(bad, scope: "demo", name: "audit", enabled: false, expected: nil))
        }
        let existing = #"{"schemaVersion":1,"enabledSkills":{"demo:audit":true}}"#
        XCTAssertThrowsError(try SkillPreferences.setting(existing, scope: "demo", name: "audit", enabled: false, expected: nil))
        XCTAssertNoThrow(try SkillPreferences.setting(existing, scope: "demo", name: "audit", enabled: true, expected: nil))
        XCTAssertThrowsError(try SkillPreferences.setting(nil, scope: "../outside", name: "audit", enabled: false, expected: nil))
    }

    func testOfflineSettingsSurviveRestartAndMergeOtherDevicesChanges() async throws {
        let root = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        defer { try? FileManager.default.removeItem(at: root) }
        let store = try LocalStore(rootDirectory: root, owner: "o", repo: "r", branch: "main")
        let client = FakeGitHubClient(remote: [:])
        let engine = SyncEngine(client: client, store: store, stateDirectory: root)
        await engine.setAutoFlush(false)
        let op = PendingOp.setSkillEnabled(scope: "demo", name: "audit", enabled: false, expectedEnabled: nil)
        try await engine.enqueue(op)
        let persisted = PendingOpsQueue.load(from: root.appendingPathComponent("pending-ops.json"))
        XCTAssertEqual(persisted.queue.pending.map(\.op), [op])
        XCTAssertEqual(persisted.queue.schemaVersion, PendingOpsQueue.currentSchemaVersion)
        let remote = try SkillPreferences.setting(nil, scope: "other", name: "audit", enabled: true, expected: nil)
        await client.setRemote(SkillPreferences.path, remote)
        await client.failNextPut(on: [SkillPreferences.path])
        await engine.flushNow()
        let written = await client.remoteContent(SkillPreferences.path)
        XCTAssertEqual(try SkillPreferences.parse(written).enabledSkills, ["demo:audit": false, "other:audit": true])
        let failed = await engine.failedOps()
        XCTAssertTrue(failed.isEmpty)
        let snapshot = await store.snapshot()
        XCTAssertEqual(try SkillPreferences.parse(snapshot.skillPreferencesContent).enabledSkills, ["demo:audit": false, "other:audit": true])
    }
}
