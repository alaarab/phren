import Foundation
import Observation
import PhrenKit
import PhrenLive

@Observable @MainActor
final class AccountUsageCache {
    static let shared = AccountUsageCache()
    private var cache = AccountUsageMemoryCache()
    @ObservationIgnored private var requests: [UUID: Request] = [:]
    private struct Request { let id: UUID; let host: LiveHost; let task: Task<AccountUsageSnapshot, Error> }
    @ObservationIgnored private let fetch: (LiveHost) async throws -> AccountUsageSnapshot
    @ObservationIgnored private let now: () -> Date

    init(now: @escaping () -> Date = Date.init,
         fetch: ((LiveHost) async throws -> AccountUsageSnapshot)? = nil) {
        self.now = now; self.fetch = fetch ?? { try await Self.fetch($0) }
    }
    func snapshot(for host: LiveHost) -> AccountUsageSnapshot? { cache.snapshot(for: host) }

    @discardableResult
    func refresh(_ host: LiveHost, force: Bool = false) async throws -> AccountUsageSnapshot {
        if !force, !cache.needsRefresh(host, at: now()), let value = cache.snapshot(for: host) { return value }
        if let request = requests[host.id], request.host == host { return try await request.task.value }
        let id = UUID(), started = CFAbsoluteTimeGetCurrent()
        let task = Task { try await fetch(host) }
        requests[host.id] = Request(id: id, host: host, task: task)
        defer { if requests[host.id]?.id == id { requests.removeValue(forKey: host.id) } }
        let value = try await task.value
        if requests[host.id]?.id == id { cache.insert(value, for: host, at: now()) }
        #if DEBUG
        if ProcessInfo.processInfo.environment["PHREN_PERFORMANCE_LOG"] == "1" {
            print("[PhrenPerformance] usage fetch: \(String(format: "%.3f", (CFAbsoluteTimeGetCurrent() - started) * 1_000)) ms")
        }
        #endif
        return value
    }

    private static func fetch(_ host: LiveHost) async throws -> AccountUsageSnapshot {
        #if DEBUG && targetEnvironment(simulator)
        if AppModel.isUITesting {
            guard ProcessInfo.processInfo.arguments.contains("--account-usage-fixture") else {
                return try AccountUsageSnapshot.read(Data(#"{"accounts":[]}"#.utf8))
            }
            if ProcessInfo.processInfo.arguments.contains("--usage-delayed") { try await Task.sleep(for: .milliseconds(800)) }
            let now = Date()
            var accounts = ["codex", "claude"].map { source in
                ["source": source, "updatedAt": now.ISO8601Format(), "windows": [
                    ["id": "five_hour", "name": "5-hour limit", "usedPercent": 23.5, "resetsAt": now.addingTimeInterval(7200).ISO8601Format()],
                    ["id": "seven_day", "name": "7-day limit", "usedPercent": 41.2, "resetsAt": now.addingTimeInterval(172800).ISO8601Format()]
                ]] as [String: Any]
            }
            accounts.append(["source": "opencode", "updatedAt": now.ISO8601Format(), "windows": [],
                             "spend": ["amountUSD": 4.39, "period": "rolling_7_days"]])
            accounts.append(["source": "openrouter", "accountId": String(repeating: "a", count: 64),
                             "updatedAt": now.ISO8601Format(), "windows": [],
                             "spend": ["amountUSD": 5.08, "period": "calendar_week"]])
            let payload: [String: Any] = ["accounts": accounts]
            return try AccountUsageSnapshot.read(JSONSerialization.data(withJSONObject: payload))
        }
        #endif
        return try await PhrenConnection.accountUsage(host: host, privateKey: DeviceSSHKey.load(host.id))
    }
}
