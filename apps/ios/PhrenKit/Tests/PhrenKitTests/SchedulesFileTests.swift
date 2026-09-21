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
                 every: .weekly(days: [.mon, .tue, .wed, .thu, .fri], hour: 7, minute: 30),
                 prompt: prompt, createdAt: ISO8601Dates.parse("2026-09-20T21:00:00.123Z")!,
                 updatedAt: ISO8601Dates.parse("2026-09-20T21:00:00.456Z")!)
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
        XCTAssertEqual(value.every, .weekly(days: [.mon, .tue, .wed, .thu, .fri], hour: 7, minute: 30))
    }

    func testCodableUsesTheFlatHookShape() throws {
        let expected = schedule()
        let data = try JSONEncoder().encode(expected)
        let object = try XCTUnwrap(JSONSerialization.jsonObject(with: data) as? [String: Any])
        XCTAssertEqual(object["every"] as? String, "weekly")
        XCTAssertEqual(object["createdAt"] as? String, "2026-09-20T21:00:00.123Z")
        XCTAssertEqual(object["updatedAt"] as? String, "2026-09-20T21:00:00.456Z")
        XCTAssertEqual(object["at"] as? String, "07:30")
        XCTAssertEqual(object["days"] as? [String], ["mon", "tue", "wed", "thu", "fri"])
        XCTAssertEqual(try JSONDecoder().decode(Schedule.self, from: data), expected)
    }

    func testTypedFrequenciesRoundTripThroughYAMLAndHookJSON() throws {
        let once = try XCTUnwrap(Calendar.current.date(from: DateComponents(
            year: 2026, month: 9, day: 21, hour: 9, minute: 30)))
        let frequencies: [Schedule.Every] = [
            .interval(minutes: 5), .interval(minutes: 360), .interval(minutes: 2_880),
            .daily(hour: 7, minute: 30), .weekly(days: [.fri, .mon], hour: 18, minute: 5),
            .once(once), .cron("0 7 * * 1-5"),
        ]
        for frequency in frequencies {
            var value = schedule()
            value.every = frequency
            XCTAssertEqual(SchedulesFile.parse(SchedulesFile.render([value])), [value])
            let data = try JSONEncoder().encode(value)
            XCTAssertEqual(try JSONDecoder().decode(Schedule.self, from: data), value)
        }
    }

    func testInvalidTimeDateAndOverflowingIntervalsAreRejected() throws {
        var value = schedule()
        value.every = .daily(hour: 7, minute: 30)
        let yaml = SchedulesFile.render([value])
        XCTAssertTrue(SchedulesFile.parse(yaml.replacingOccurrences(of: "07:30", with: "24:00")).isEmpty)
        XCTAssertTrue(SchedulesFile.parse(yaml.replacingOccurrences(of: "07:30", with: "0٧:30")).isEmpty)
        XCTAssertTrue(SchedulesFile.parse(yaml.replacingOccurrences(of: "7f3a2c1d", with: "'")).isEmpty)
        for interval in ["4m", "0h", "999999999999999999999d"] {
            let invalid = yaml.replacingOccurrences(of: "every: daily", with: "every: interval")
                .replacingOccurrences(of: "at: \"07:30\"", with: "interval: \(interval)")
            XCTAssertTrue(SchedulesFile.parse(invalid).isEmpty, interval)
        }
        let invalidDate = yaml.replacingOccurrences(of: "every: daily", with: "every: once")
            .replacingOccurrences(of: "at: \"07:30\"", with: "once: 2026-02-30T09:00:00")
        XCTAssertTrue(SchedulesFile.parse(invalidDate).isEmpty)
        let invalidJSON = try XCTUnwrap(String(data: JSONEncoder().encode(value), encoding: .utf8))
            .replacingOccurrences(of: "07:30", with: "24:00")
        XCTAssertThrowsError(try JSONDecoder().decode(Schedule.self, from: Data(invalidJSON.utf8)))
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

    func testDuplicateIDsKeepOnlyTheFirstSchedule() {
        let first = schedule()
        var duplicate = first
        duplicate.name = "Repeated entry after a merge"
        XCTAssertEqual(SchedulesFile.parse(SchedulesFile.render([first, duplicate])), [first])
    }

    func testSnapshotReadsSchedulesAndRawContent() async throws {
        let content = SchedulesFile.render([schedule()], preserving: nil)
        let store = try LocalStore(rootDirectory: directory, owner: "o", repo: "r", branch: "main")
        try await store.write("demo/schedules.yaml", content: content, blobSha: nil)

        let snapshot = await store.snapshot()
        XCTAssertEqual(snapshot.schedules["demo"], [schedule()])
        XCTAssertEqual(snapshot.schedulesContent["demo"], content)
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
