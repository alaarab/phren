import Foundation
import XCTest
@testable import PhrenKit

final class SchedulesFileTests: XCTestCase {
    private var directory: URL!

    override func setUpWithError() throws {
        directory = FileManager.default.temporaryDirectory
            .appendingPathComponent("phren-schedules-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
    }

    override func tearDownWithError() throws {
        try? FileManager.default.removeItem(at: directory)
    }

    private func schedule(id: String = "7f3a2c1d", prompt: String = "Run the tests.\n") -> Schedule {
        Schedule(id: id, name: "Nightly test sweep", enabled: true, computer: "Desk",
                 harness: .codex, model: "gpt-5.6-sol",
                 every: .weekly(at: "07:30", days: [.mon, .tue, .wed, .thu, .fri]),
                 prompt: prompt, createdAt: "2026-09-20T21:00:00Z",
                 updatedAt: "2026-09-20T21:00:00Z")
    }

    func testParsesContractExample() throws {
        let yaml = """
        version: 1
        schedules:
          - id: 7f3a2c1d
            name: Nightly test sweep
            enabled: true
            computer: Desk
            harness: codex
            model: gpt-5.6-sol
            every: weekly
            at: "07:30"
            days: [mon, tue, wed, thu, fri]
            prompt: |
              Run the full test suite, fix what is red, and leave a summary in tasks.
            createdAt: 2026-09-20T21:00:00Z
            updatedAt: 2026-09-20T21:00:00Z
        """
        let value = try XCTUnwrap(SchedulesFile.parse(yaml).first)
        XCTAssertEqual(value.id, "7f3a2c1d")
        XCTAssertEqual(value.name, "Nightly test sweep")
        XCTAssertEqual(value.harness, .codex)
        XCTAssertEqual(value.model, "gpt-5.6-sol")
        XCTAssertEqual(value.prompt, "Run the full test suite, fix what is red, and leave a summary in tasks.\n")
        XCTAssertEqual(value.every, .weekly(at: "07:30", days: [.mon, .tue, .wed, .thu, .fri]))
    }

    func testCodableUsesTheFlatHookShape() throws {
        let expected = schedule()
        let data = try JSONEncoder().encode(expected)
        let object = try XCTUnwrap(JSONSerialization.jsonObject(with: data) as? [String: Any])
        XCTAssertEqual(object["every"] as? String, "weekly")
        XCTAssertEqual(object["at"] as? String, "07:30")
        XCTAssertEqual(object["days"] as? [String], ["mon", "tue", "wed", "thu", "fri"])
        XCTAssertEqual(try JSONDecoder().decode(Schedule.self, from: data), expected)
    }

    func testRenderRoundTripsAndPreservesUnknownTopLevelContent() {
        let original = """
        # owned by phren
        version: 1
        source: phone
        schedules: []
        policy:
          review: required
        """
        let expected = schedule(prompt: "First line\n\nThird line\n")
        let rendered = SchedulesFile.render([expected], preserving: original)

        XCTAssertTrue(rendered.contains("version: 1"))
        XCTAssertTrue(rendered.contains("source: phone"))
        XCTAssertTrue(rendered.contains("policy:\n  review: required"))
        XCTAssertEqual(SchedulesFile.parse(rendered), [expected])
    }

    func testBlockPromptKeepsBlankLinesAndChomping() throws {
        let yaml = """
        version: 1
        schedules:
          - id: 7f3a2c1d
            name: Notes
            enabled: true
            computer: Desk
            harness: claude
            every: daily
            at: "09:15"
            prompt: |-
              First

              Third
            createdAt: 2026-09-20T21:00:00Z
            updatedAt: 2026-09-20T21:00:00Z
        """
        XCTAssertEqual(try XCTUnwrap(SchedulesFile.parse(yaml).first).prompt, "First\n\nThird")
    }

    func testUnknownEveryDropsOnlyThatSchedule() {
        let valid = SchedulesFile.render([schedule()], preserving: nil)
        let invalid = valid.replacingOccurrences(of: "7f3a2c1d", with: "aaaaaaaa")
            .replacingOccurrences(of: "every: weekly", with: "every: monthly")
        let secondEntry = valid.dropFirst("version: 1\nschedules:\n".count)
        let joined = invalid + secondEntry
        XCTAssertEqual(SchedulesFile.parse(joined).map(\.id), ["7f3a2c1d"])
    }

    func testParserCapsTheListAt64Schedules() {
        let entries = (0..<65).map { index -> String in
            let rendered = SchedulesFile.render([
                schedule(id: String(format: "%08x", index + 1)),
            ], preserving: nil)
            return String(rendered.dropFirst("version: 1\nschedules:\n".count))
        }
        let yaml = "version: 1\nschedules:\n" + entries.joined()
        XCTAssertEqual(SchedulesFile.parse(yaml).count, 64)
    }

    func testSnapshotReadsSchedulesAndRawContent() async throws {
        let content = SchedulesFile.render([schedule()], preserving: nil)
        let store = try LocalStore(rootDirectory: directory, owner: "o", repo: "r", branch: "main")
        try await store.write("demo/schedules.yaml", content: content, blobSha: nil)

        let snapshot = await store.snapshot()
        XCTAssertEqual(snapshot.schedules["demo"], [schedule()])
        XCTAssertEqual(snapshot.scheduleContents["demo"], content)
        XCTAssertTrue(LocalStore.isWritablePath("demo/schedules.yaml"))
        XCTAssertFalse(LocalStore.isSchedulesPath("global/schedules.yaml"))
    }

    func testSaveSchedulesRefusesStaleExpectedContent() async throws {
        let current = SchedulesFile.render([schedule()], preserving: nil)
        let stale = SchedulesFile.render([], preserving: nil)
        let replacement = SchedulesFile.render([
            schedule(prompt: "Changed on the phone.\n"),
        ], preserving: current)
        let store = try LocalStore(rootDirectory: directory, owner: "o", repo: "r", branch: "main")
        try await store.write("demo/schedules.yaml", content: current, blobSha: GitBlob.sha(of: current))
        let client = FakeGitHubClient(remote: ["demo/schedules.yaml": current])
        let engine = SyncEngine(client: client, store: store, stateDirectory: directory)
        await engine.setAutoFlush(false)

        do {
            try await engine.enqueue(.saveSchedules(project: "demo", content: replacement,
                                                    expectedContent: stale))
            XCTFail("a stale expectedContent must be refused")
        } catch {
            XCTAssertTrue(error.localizedDescription.contains("changed since"))
        }
        let stored = await store.read("demo/schedules.yaml")
        let pending = await engine.pendingOps()
        XCTAssertEqual(stored, current)
        XCTAssertTrue(pending.isEmpty)
    }
}
