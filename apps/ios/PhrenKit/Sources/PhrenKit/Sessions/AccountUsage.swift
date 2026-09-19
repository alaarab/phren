import Foundation

public struct AccountUsageSnapshot: Decodable, Equatable, Sendable {
    public struct Spend: Decodable, Equatable, Sendable {
        public let amountUSD: Double
        public let period: String
        public init(amountUSD: Double, period: String) { self.amountUSD = amountUSD; self.period = period }
        public var periodLabel: String {
            period == "rolling_7_days" ? "Past 7 days" : "This week · UTC"
        }
    }
    public struct Window: Decodable, Equatable, Sendable, Identifiable {
        public let id: String
        public let name: String
        public let usedPercent: Double
        public let resetsAt: String?
        /// When this window was last read, if it is older than the account
        /// as a whole (Claude's per-model windows come from Claude Code's own
        /// usage snapshot, refreshed when it opens /usage).
        public let asOf: String?
        public var resetDate: Date? { AccountUsageSnapshot.date(resetsAt) }
        public var asOfDate: Date? { AccountUsageSnapshot.date(asOf) }
        public init(id: String, name: String, usedPercent: Double, resetsAt: String?, asOf: String? = nil) {
            self.id = id; self.name = name; self.usedPercent = usedPercent; self.resetsAt = resetsAt; self.asOf = asOf
        }
    }
    public struct Account: Decodable, Equatable, Sendable, Identifiable {
        public let source: String
        public let windows: [Window]
        public let updatedAt: String?
        public let message: String?
        public let spend: Spend?
        /// A one-way key fingerprint. It lets reports from two computers
        /// avoid counting the same OpenRouter key twice.
        public let accountId: String?
        public var id: String { source }
        public var name: String {
            switch source {
            case "claude": "Claude"
            case "opencode": "OpenCode"
            case "openrouter": "OpenRouter"
            default: "Codex"
            }
        }
        public var updatedDate: Date? { AccountUsageSnapshot.date(updatedAt) }
        public func isStale(at now: Date) -> Bool {
            guard let updatedDate else { return true }
            return now.timeIntervalSince(updatedDate) > 120 || windows.contains { ($0.resetDate ?? .distantFuture) <= now }
        }
    }
    public let accounts: [Account]

    public static func read(_ data: Data) throws -> Self {
        guard data.count <= 65_536 else { throw PhrenKitError.validation("The usage response is too large.") }
        let value = try JSONDecoder().decode(Self.self, from: data)
        guard value.accounts.count <= 4, Set(value.accounts.map(\.id)).count == value.accounts.count,
              value.accounts.allSatisfy({ account in
                  ["codex", "claude", "opencode", "openrouter"].contains(account.source) && account.windows.count <= 32
                  && (account.message?.utf8.count ?? 0) <= 1_000
                  && (account.updatedAt == nil || account.updatedDate != nil)
                  && (account.accountId == nil || account.accountId?.range(of: #"^[0-9a-f]{64}$"#, options: .regularExpression) != nil)
                  && (account.spend == nil || (account.spend!.amountUSD.isFinite && (0...1_000_000_000).contains(account.spend!.amountUSD)
                      && ["rolling_7_days", "calendar_week"].contains(account.spend!.period)))
                  && Set(account.windows.map(\.id)).count == account.windows.count
                  && account.windows.allSatisfy { window in
                      !window.id.isEmpty && window.id.utf8.count <= 200 && window.name.utf8.count <= 200
                      && window.usedPercent.isFinite && (0...100).contains(window.usedPercent)
                      && (window.resetsAt == nil || window.resetDate != nil)
                      && (window.asOf == nil || window.asOfDate != nil)
                  }
              }) else { throw PhrenKitError.validation("The computer returned invalid account usage. Refresh to try again.") }
        return value
    }
    private static func date(_ text: String?) -> Date? { ISO8601Dates.parse(text) }
}
