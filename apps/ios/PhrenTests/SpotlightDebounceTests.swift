import XCTest
@testable import Phren

final class SpotlightDebounceTests: XCTestCase {
    private let start = Date(timeIntervalSince1970: 1_000)

    func testOneSecondPollsCoalesceWithoutStarvingTheLatestChange() {
        var debounce = SpotlightDebounce<String>(interval: 3)
        debounce.update("first", at: start)
        debounce.update("second", at: start.addingTimeInterval(1))
        debounce.update("latest", at: start.addingTimeInterval(2))
        XCTAssertNil(debounce.ready(at: start.addingTimeInterval(2)))
        XCTAssertEqual(debounce.ready(at: start.addingTimeInterval(3)), "latest")
        debounce.complete("latest", succeeded: true, at: start.addingTimeInterval(3))
        for tick in 4...60 { debounce.update("latest", at: start.addingTimeInterval(Double(tick))) }
        XCTAssertNil(debounce.deadline, "Identical polls must not rewrite Spotlight")
    }

    func testReturningToCommittedValueCancelsUnnecessaryWrite() {
        var debounce = SpotlightDebounce<String>()
        debounce.update("idle", at: start)
        debounce.complete("idle", succeeded: true, at: start.addingTimeInterval(3))
        debounce.update("working", at: start.addingTimeInterval(4))
        debounce.update("idle", at: start.addingTimeInterval(5))
        XCTAssertNil(debounce.deadline)
    }

    func testFailureDoesNotAcknowledgeChangesAndRemainsRetryable() {
        var debounce = SpotlightDebounce<[String]>()
        debounce.update(["ended"], at: start)
        debounce.complete(["ended"], succeeded: true, at: start.addingTimeInterval(3))
        debounce.update([], at: start.addingTimeInterval(4))
        debounce.complete([], succeeded: false, at: start.addingTimeInterval(7))
        XCTAssertNil(debounce.committed, "A partial write requires a full reconciliation")
        XCTAssertEqual(debounce.ready(at: start.addingTimeInterval(10)), [])
        debounce.complete([], succeeded: true, at: start.addingTimeInterval(10))
        XCTAssertNil(debounce.deadline)
    }

    func testChangesDuringAnInFlightWriteGetAnotherWrite() {
        var debounce = SpotlightDebounce<String>()
        debounce.update("old", at: start)
        let writing = debounce.ready(at: start.addingTimeInterval(3))!
        debounce.update("new", at: start.addingTimeInterval(4))
        debounce.complete(writing, succeeded: true, at: start.addingTimeInterval(5))
        XCTAssertEqual(debounce.committed, "old")
        XCTAssertEqual(debounce.ready(at: start.addingTimeInterval(8)), "new")
    }
}
