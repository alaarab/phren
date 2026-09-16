import XCTest
@testable import PhrenKit

final class SessionRelativeTimeTests: XCTestCase {
    func testCompactBoundariesAndFutureClockSkew() {
        let start = Date(timeIntervalSince1970: 1_000)
        for (seconds, expected) in [(-10, "now"), (0, "now"), (9, "now"), (10, "10s ago"),
                                    (59, "59s ago"), (60, "1m ago"), (3599, "59m ago"),
                                    (3600, "1h ago"), (86399, "23h ago"), (86400, "1d ago")] {
            XCTAssertEqual(SessionRelativeTime.text(since: start, at: start.addingTimeInterval(Double(seconds))), expected)
        }
    }

    func testHookTimestampSupportsFractionalSecondsAndOlderHooks() throws {
        for (timestamp, expected) in [("\"2026-09-15T10:00:00.123Z\"", true), ("\"2026-09-15T10:00:00Z\"", true),
                                       ("null", false), ("\"bad date\"", false), ("123", false)] {
            let data = Data("""
            {"kind":"herdr","groups":[{"id":"w","label":"Work","children":[{"id":"t","label":"Build","lastChangedAt":\(timestamp)}]}]}
            """.utf8)
            let date = try LiveWorkspaces.read(data).groups[0].children[0].lastChangedAt
            XCTAssertEqual(date != nil, expected)
        }
        let older = Data(#"{"kind":"herdr","groups":[{"id":"w","label":"Work","children":[{"id":"t","label":"Build"}]}]}"#.utf8)
        XCTAssertNil(try LiveWorkspaces.read(older).groups[0].children[0].lastChangedAt)
    }
}
