import XCTest
import PhrenKit
@testable import Phren

final class TaskBrowsingTests: XCTestCase {
    private func row(_ id: String, date: String? = nil, tags: String = "", rank: Int = 1, store: String = "personal") -> TaskListRow {
        let dateTag = date.map { " created:\($0)" } ?? ""
        let file = TasksFile(project: "demo", content: "# Tasks\n## Queue\n- [ ] Task \(id) \(tags) <!-- bid:\(id) rank:\(rank)\(dateTag) -->\n  Context: release planning\n")
        return TaskListRow(storeId: store, storeName: store, project: "demo", task: file.doc.queue[0])
    }

    func testCreationFormatsAndUnknownDates() throws {
        let whole = try XCTUnwrap(TaskBrowsing.creationDate("2026-09-10T12:00:00Z"))
        XCTAssertEqual(TaskBrowsing.creationDate("2026-09-10T13:00:00+01:00"), whole)
        XCTAssertEqual(TaskBrowsing.creationDate("2026-09-10T12:00:00.123Z")!.timeIntervalSince(whole), 0.123, accuracy: 0.001)
        XCTAssertNotNil(TaskBrowsing.creationDate("2026-09-10"))
        XCTAssertNil(TaskBrowsing.creationDate(nil))
        XCTAssertNil(TaskBrowsing.creationDate("not a date"))
    }

    func testNewestAndOldestKeepUndatedTasksLast() {
        let old = row("00000001", date: "2020-01-01T00:00:00Z", rank: 3)
        let recent = row("00000002", date: "2026-09-10T00:00:00.123Z", rank: 2)
        let unknown = row("00000003", tags: "[pinned]", rank: 1)
        XCTAssertEqual(TaskBrowsing.rows([unknown, old, recent], query: "", priority: nil, age: .all, sort: .newest).map(\.id), [recent.id, old.id, unknown.id])
        XCTAssertEqual(TaskBrowsing.rows([recent, unknown, old], query: "", priority: nil, age: .all, sort: .oldest).map(\.id), [old.id, recent.id, unknown.id])
    }

    func testTaskOrderPinsFirstAndSortTiesAreStableAcrossStores() {
        let a = row("00000001", rank: 1, store: "a")
        let b = row("00000001", rank: 1, store: "b")
        let pinned = row("00000003", tags: "[pinned]", rank: 3)
        XCTAssertEqual(TaskBrowsing.rows([b, pinned, a], query: "", priority: nil, age: .all, sort: .manual).map(\.id), [pinned.id, a.id, b.id])
    }

    func testPrioritySortAndCombinedSearchFilters() throws {
        let now = try XCTUnwrap(TaskBrowsing.creationDate("2026-09-10T12:00:00Z"))
        let high = row("00000001", date: "2026-09-09T12:00:00Z", tags: "[high]")
        let low = row("00000002", tags: "[low]")
        let medium = row("00000003", tags: "[medium]")
        let unspecified = row("00000004")
        let rows = [low, unspecified, medium, high]
        XCTAssertEqual(TaskBrowsing.rows(rows, query: "", priority: nil, age: .all, sort: .priority).map(\.id), [high.id, medium.id, low.id, unspecified.id])
        XCTAssertEqual(TaskBrowsing.rows(rows, query: " RELEASE ", priority: .high, age: .week, sort: .manual, now: now).map(\.id), [high.id])
        XCTAssertTrue(TaskBrowsing.rows(rows, query: "absent", priority: nil, age: .all, sort: .manual).isEmpty)
        XCTAssertEqual(TaskBrowsing.rows(rows, query: "demo", priority: .low, age: .unknown, sort: .manual).map(\.id), [low.id])
    }

    func testMovesUseStableTaskIDsAndPreserveFields() {
        let item = row("deadbeef", tags: "[high]", store: "team")
        XCTAssertEqual(TaskMove.start.operation(for: item), .updateTask(project: "demo", match: "deadbeef", text: nil, priority: nil, section: "Active"))
        XCTAssertEqual(TaskMove.backlog.operation(for: item), .updateTask(project: "demo", match: "deadbeef", text: nil, priority: nil, section: "Queue"))
        XCTAssertEqual(TaskMove.done.operation(for: item), .completeTask(project: "demo", match: "deadbeef"))
    }

    func testTaskAgentRequestIncludesExactVisibleTaskContextAndIdentity() {
        let item = row("deadbeef", tags: "[high] [pinned]", store: "team/brain")
        let request = TaskAgentRequest(row: item)
        XCTAssertEqual(request.title, "Task deadbeef")
        XCTAssertEqual(request.prompt, """
        Work on this Phren task and continue until it is complete:

        Store: team/brain
        Project: demo

        Task:
        Task deadbeef

        Context:
        release planning
        """)
    }

    func testAgeRangesAndMissingDates() throws {
        let now = try XCTUnwrap(TaskBrowsing.creationDate("2026-09-10T12:00:00Z"))
        func daysAgo(_ days: Int) -> Date { Calendar.current.date(byAdding: .day, value: -days, to: now)! }
        XCTAssertTrue(TaskAge.week.includes(daysAgo(6), now: now))
        XCTAssertFalse(TaskAge.week.includes(daysAgo(7), now: now))
        XCTAssertTrue(TaskAge.month.includes(daysAgo(29), now: now))
        XCTAssertFalse(TaskAge.month.includes(daysAgo(30), now: now))
        XCTAssertTrue(TaskAge.older.includes(daysAgo(30), now: now))
        XCTAssertFalse(TaskAge.week.includes(daysAgo(-1), now: now))
        XCTAssertFalse(TaskAge.older.includes(nil, now: now))
        XCTAssertTrue(TaskAge.unknown.includes(nil, now: now))
        XCTAssertTrue(TaskAge.all.includes(nil, now: now))
    }
}
