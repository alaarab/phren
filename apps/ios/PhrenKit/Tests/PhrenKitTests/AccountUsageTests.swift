import XCTest
@testable import PhrenKit

final class AccountUsageTests: XCTestCase {
    func testPercentagesResetTimesAndStaleness() throws {
        let data = Data(#"{"accounts":[{"source":"claude","updatedAt":"2026-09-12T08:00:00.000Z","windows":[{"id":"five_hour","name":"5-hour limit","usedPercent":23.5,"resetsAt":"2026-09-12T09:00:00Z"}]}]}"#.utf8)
        let account = try XCTUnwrap(AccountUsageSnapshot.read(data).accounts.first)
        XCTAssertEqual(account.windows[0].usedPercent, 23.5)
        XCTAssertEqual(account.windows[0].resetDate?.timeIntervalSince(account.updatedDate!), 3600)
        XCTAssertFalse(account.isStale(at: account.updatedDate!.addingTimeInterval(60)))
        XCTAssertTrue(account.isStale(at: account.updatedDate!.addingTimeInterval(121)))
        XCTAssertTrue(account.isStale(at: account.windows[0].resetDate!))
    }
    func testSameAccountOnTwoComputersMergesToOneCardWithTheFreshestWindows() throws {
        let now = try XCTUnwrap(ISO8601Dates.parse("2026-09-15T20:30:00Z"))
        let mac = try AccountUsageSnapshot.read(Data(#"{"accounts":[{"source":"codex","windows":[],"message":"Sign in"},{"source":"claude","updatedAt":"2026-09-15T20:29:30Z","windows":[{"id":"five_hour","name":"5-hour limit","usedPercent":14},{"id":"seven_day_fable","name":"7-day · Fable","usedPercent":48,"asOf":"2026-09-14T08:06:00Z"}]}]}"#.utf8))
        let omarchy = try AccountUsageSnapshot.read(Data(#"{"accounts":[{"source":"codex","updatedAt":"2026-09-15T20:29:40Z","windows":[{"id":"codex:primary","name":"7-day limit","usedPercent":90}]},{"source":"claude","updatedAt":"2026-09-15T20:29:00Z","windows":[{"id":"five_hour","name":"5-hour limit","usedPercent":13},{"id":"seven_day_fable","name":"7-day · Fable","usedPercent":89,"asOf":"2026-09-15T18:00:00Z"}]}]}"#.utf8))
        let merged = MergedAccountUsage.merge([("Mac", mac), ("Omarchy", omarchy)], at: now)
        XCTAssertEqual(merged.map(\.source), ["codex", "claude"])
        XCTAssertEqual(merged[0].computers, ["Mac", "Omarchy"])
        XCTAssertEqual(merged[0].windows.map(\.usedPercent), [90])
        XCTAssertNil(merged[0].message, "A computer that has the account reporting outranks one that asks to sign in")
        let claude = merged[1]
        XCTAssertEqual(claude.windows.map(\.id), ["five_hour", "seven_day_fable"])
        XCTAssertEqual(claude.windows[0].usedPercent, 14, "The computer that reported most recently wins the shared window")
        XCTAssertEqual(claude.windows[1].usedPercent, 89, "A per-model window is dated by its own snapshot, not the report")
        XCTAssertEqual(claude.updatedAt, ISO8601Dates.parse("2026-09-15T20:29:30Z"))
        XCTAssertFalse(claude.stale)
        XCTAssertEqual(MergedAccountUsage.merge([("Mac", nil)], at: now), [])
    }
    func testUnavailableDoesNotInventZeroUsage() throws {
        let value = try AccountUsageSnapshot.read(Data(#"{"accounts":[{"source":"codex","windows":[],"message":"Sign in"}]}"#.utf8))
        XCTAssertTrue(value.accounts[0].windows.isEmpty)
        XCTAssertNil(value.accounts[0].updatedDate)
    }
    func testInvalidProviderPercentDateAndDuplicateWindowsAreRejected() throws {
        let valid = #"{"accounts":[{"source":"codex","windows":[{"id":"primary","name":"5-hour limit","usedPercent":0,"resetsAt":"2026-09-12T09:00:00Z"}]}]}"#
        for invalid in [valid.replacingOccurrences(of: "codex", with: "unknown"),
                        valid.replacingOccurrences(of: ":0,", with: ":101,"),
                        valid.replacingOccurrences(of: "2026-09-12T09:00:00Z", with: "bad date")] {
            XCTAssertThrowsError(try AccountUsageSnapshot.read(Data(invalid.utf8)))
        }
        XCTAssertNoThrow(try AccountUsageSnapshot.read(Data(valid.utf8)))
    }
}
