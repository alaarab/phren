import PhrenKit
import XCTest
@testable import Phren

@MainActor
final class AccountUsageCacheTests: XCTestCase {
    func testReopeningUsesCacheAndConcurrentReadersShareOneFetch() async throws {
        let host = try LiveHost(name: "Mac", address: "mac.invalid", username: "test")
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
}
