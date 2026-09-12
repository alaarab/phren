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
