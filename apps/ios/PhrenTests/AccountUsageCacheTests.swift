import PhrenKit
import XCTest
@testable import Phren

@MainActor
final class AccountUsageCacheTests: XCTestCase {
    func testReopeningUsesCacheAndConcurrentReadersShareOneFetch() async throws {
        let host = try LiveHost(name: "Desk", address: "desk.example", username: "sam")
        let value = try AccountUsageSnapshot.read(Data(#"{"accounts":[]}"#.utf8))
        var calls = 0, now = Date.now
        let cache = AccountUsageCache(now: { now }) { _ in
            calls += 1
            try await Task.sleep(for: .milliseconds(20))
            return value
        }
        async let first = cache.refresh(host)
        async let second = cache.refresh(host)
        _ = try await (first, second)
        XCTAssertEqual(calls, 1)
        XCTAssertEqual(cache.snapshot(for: host), value)
        _ = try await cache.refresh(host)
        XCTAssertEqual(calls, 1)
        now = now.addingTimeInterval(60)
        _ = try await cache.refresh(host)
        XCTAssertEqual(calls, 2)
        _ = try await cache.refresh(host, force: true)
        XCTAssertEqual(calls, 3)
    }

    func testHeaderRingChoosesPrimaryWindowFromNewestMergedReport() throws {
        let now = try XCTUnwrap(ISO8601Dates.parse("2026-09-20T18:00:00Z"))
        let newest = try AccountUsageSnapshot.read(Data(#"{"accounts":[{"source":"claude","updatedAt":"2026-09-20T17:59:30Z","windows":[{"id":"five_hour","name":"5-hour limit","usedPercent":40},{"id":"seven_day","name":"7-day, all models","usedPercent":16},{"id":"seven_day_fable","name":"7-day, Fable","usedPercent":18}]}]}"#.utf8))
        let older = try AccountUsageSnapshot.read(Data(#"{"accounts":[{"source":"claude","updatedAt":"2026-09-20T17:59:00Z","windows":[{"id":"five_hour","name":"5-hour limit","usedPercent":75},{"id":"seven_day","name":"7-day, all models","usedPercent":80},{"id":"seven_day_fable","name":"7-day, Fable","usedPercent":90}]}]}"#.utf8))
        let accounts = MergedAccountUsage.merge([("Desk", newest), ("Desk 2", older)], at: now)
        let quotas = AccountUsageRingSelection.primaryWindows(in: accounts)

        XCTAssertEqual(quotas.map(\.source), ["claude"])
        XCTAssertEqual(quotas.first?.window.id, "five_hour")
        XCTAssertEqual(quotas.first?.window.usedPercent, 40)
        XCTAssertEqual(AccountUsageRingSelection.accessibilityValue(quotas), "Claude 40%")
    }

    func testHeaderRingsIgnoreOpenCodeGoWithoutAReportedLimit() throws {
        let snapshot = try AccountUsageSnapshot.read(Data(#"{"accounts":[{"source":"opencode-go","updatedAt":"2026-09-20T17:59:30Z","windows":[{"id":"opencode-go:kimi_k3:5h","name":"opencode-go/kimi-k3 · 5h","usedUSD":1.2}]}]}"#.utf8))
        let accounts = MergedAccountUsage.merge([("Desk", snapshot)], at: .now)

        XCTAssertTrue(AccountUsageRingSelection.primaryWindows(in: accounts).isEmpty)
    }
}
