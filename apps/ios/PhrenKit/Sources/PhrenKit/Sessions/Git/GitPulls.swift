import Foundation

/// `/v1/git/pulls` on the computer: the GitHub CLI's open pull requests for
/// the pane's repository, normalized to flat fields. `available` is false when
/// `gh` is missing or not signed in, which is a state rather than an error.
public struct GitPulls: Decodable, Equatable, Sendable {
    public enum State: String, Decodable, Sendable {
        case open, merged, closed, unknown

        /// GitHub spells its states in caps and can grow new ones; an
        /// unrecognized value reads as `unknown` instead of failing the list.
        public init(from decoder: Decoder) throws {
            let raw = try decoder.singleValueContainer().decode(String.self)
            self = State(rawValue: raw.lowercased()) ?? .unknown
        }
    }

    public struct Pull: Decodable, Equatable, Sendable, Identifiable {
        public let number: Int
        public let title: String
        public let head: String
        public let base: String
        public let author: String
        public let url: String
        public let draft: Bool
        public let state: State
        /// GitHub's `updatedAt`, an ISO 8601 string.
        public let updated: String
        public var id: Int { number }
        public var updatedDate: Date? { ISO8601Dates.parse(updated) }
    }

    public let available: Bool
    public let pulls: [Pull]

    public static func read(_ data: Data) throws -> Self {
        guard data.count <= 8_388_608 else { throw PhrenKitError.validation("The pull request list is too large.") }
        let result = try JSONDecoder().decode(Self.self, from: data)
        guard result.pulls.count <= 200 else {
            throw PhrenKitError.validation("The pull request list is invalid.")
        }
        return result
    }
}