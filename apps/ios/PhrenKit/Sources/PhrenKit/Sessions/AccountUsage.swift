import Foundation

public struct AccountUsageSnapshot: Decodable, Equatable, Sendable {
    public struct Window: Decodable, Equatable, Sendable, Identifiable {
        public let id: String
        public let name: String
        public let usedPercent: Double
        public let resetsAt: String?
        public var resetDate: Date? { AccountUsageSnapshot.date(resetsAt) }
    }
    public struct Account: Decodable, Equatable, Sendable, Identifiable {
        public let source: String
        public let windows: [Window]
        public let updatedAt: String?
        public let message: String?
        public var id: String { source }
        public var name: String { source == "claude" ? "Claude" : "Codex" }
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
        guard value.accounts.count <= 2, Set(value.accounts.map(\.id)).count == value.accounts.count,
              value.accounts.allSatisfy({ account in
                  ["codex", "claude"].contains(account.source) && account.windows.count <= 32
                  && (account.message?.utf8.count ?? 0) <= 1_000
                  && (account.updatedAt == nil || account.updatedDate != nil)
                  && Set(account.windows.map(\.id)).count == account.windows.count
                  && account.windows.allSatisfy { window in
                      !window.id.isEmpty && window.id.utf8.count <= 200 && window.name.utf8.count <= 200
                      && window.usedPercent.isFinite && (0...100).contains(window.usedPercent)
                      && (window.resetsAt == nil || window.resetDate != nil)
                  }
              }) else { throw PhrenKitError.validation("The computer returned invalid account usage. Refresh to try again.") }
        return value
    }
    private static func date(_ text: String?) -> Date? {
        guard let text else { return nil }
        return (try? Date.ISO8601FormatStyle(includingFractionalSeconds: true).parse(text))
            ?? (try? Date.ISO8601FormatStyle().parse(text))
    }
}
