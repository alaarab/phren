import XCTest
@testable import PhrenKit

final class SearchIndexTests: XCTestCase {
    func testRecencyContinuesAgingWithoutRebuildingTheIndex() throws {
        var snapshot = LocalStore.Snapshot.empty
        snapshot.truths["demo"] = [Truth(text: "Remember this convention", addedDate: "2026-01-01")]
        let index = SearchIndex(snapshot: snapshot)
        let start = try Date("2026-01-01T00:00:00Z", strategy: .iso8601)

        for (ageDays, expectedScore) in [(-30.0, 3.0), (0, 3), (90, 2), (180, 1), (365, 1)] {
            let now = start.addingTimeInterval(ageDays * 86_400)
            let result = try XCTUnwrap(index.search("remember", now: now).first)
            XCTAssertEqual(result.score, expectedScore, accuracy: 0.000001)
            XCTAssertEqual(result.date, "2026-01-01")
        }
    }

    func testInvalidAndNonDayDatesRemainSearchableWithoutRecencyBoosts() throws {
        let dates: [String?] = ["2026-01-01", "2026-13-40", "not-a-date", "2026-01-01T12:00:00Z", nil]
        var snapshot = LocalStore.Snapshot.empty
        snapshot.truths["demo"] = dates.enumerated().map {
            Truth(text: "Memory entry \($0.offset)", addedDate: $0.element)
        }
        let index = SearchIndex(snapshot: snapshot)
        let now = try Date("2026-01-01T00:00:00Z", strategy: .iso8601)
        let results = index.search("memory", now: now)

        XCTAssertEqual(results.count, dates.count)
        XCTAssertEqual(results.first?.text, "Memory entry 0")
        for (offset, date) in dates.enumerated() {
            let result = try XCTUnwrap(results.first { $0.text == "Memory entry \(offset)" })
            XCTAssertEqual(result.date, date)
            XCTAssertEqual(result.score, offset == 0 ? 3 : 1, accuracy: 0.000001)
        }
    }
}
