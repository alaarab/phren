import Foundation

/// A repository's branches from Phren Hook's `POST /v1/git/branches`: the
/// branch the working tree is on, the local branches with their upstream and
/// ahead/behind counts, and the remote-tracking branches.
public struct GitBranches: Decodable, Equatable, Sendable {
    public struct Local: Decodable, Equatable, Sendable, Identifiable {
        public let name: String
        public let upstream: String?
        public let ahead: Int
        public let behind: Int
        public let date: String
        public var id: String { name }
        public var relativeTime: String { ISO8601Dates.parse(date).map { SessionRelativeTime.text(since: $0, at: .now) } ?? "" }
        /// "↑2 ↓1" when the branch has moved off its upstream, otherwise nil.
        public var tracking: String? {
            guard ahead > 0 || behind > 0 else { return nil }
            return [ahead > 0 ? "↑\(ahead)" : nil, behind > 0 ? "↓\(behind)" : nil].compactMap { $0 }.joined(separator: " ")
        }
    }

    public struct Remote: Decodable, Equatable, Sendable, Identifiable {
        public let name: String
        public let date: String
        public var id: String { name }
        public var relativeTime: String { ISO8601Dates.parse(date).map { SessionRelativeTime.text(since: $0, at: .now) } ?? "" }
    }

    public let current: String?
    public let local: [Local]
    public let remote: [Remote]

    public static func read(_ data: Data) throws -> Self {
        guard data.count <= 8_388_608 else { throw PhrenKitError.validation("The branch list is too large.") }
        let result: Self
        do { result = try JSONDecoder().decode(Self.self, from: data) }
        catch { throw PhrenKitError.validation("The branch list response is invalid.") }
        guard result.local.count <= 10_000, result.remote.count <= 10_000,
              result.local.allSatisfy({ !$0.name.isEmpty && $0.name.utf8.count <= 1_000 && ($0.upstream?.utf8.count ?? 0) <= 1_000 }),
              result.remote.allSatisfy({ !$0.name.isEmpty && $0.name.utf8.count <= 1_000 }) else {
            throw PhrenKitError.validation("The branch list response is invalid.")
        }
        return result
    }
}
