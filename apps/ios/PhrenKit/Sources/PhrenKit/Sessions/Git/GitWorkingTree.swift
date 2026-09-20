import Foundation

/// `/v1/git/tree` on the computer: one level of the pane's repository, from
/// `git ls-files` plus untracked files. A directory carries `changed` when any
/// changed file lives under it; a file carries its own status letter.
public struct GitWorkingTree: Decodable, Equatable, Sendable {
    public enum Kind: String, Decodable, Sendable {
        case dir, file, unknown

        public init(from decoder: Decoder) throws {
            let raw = try decoder.singleValueContainer().decode(String.self)
            self = Kind(rawValue: raw) ?? .unknown
        }
    }

    public enum Status: String, Decodable, Sendable {
        case modified = "M"
        case added = "A"
        case deleted = "D"
        case renamed = "R"
        case copied = "C"
        case unmerged = "U"
        case untracked = "?"
        case changed
        case unknown

        /// A status the computer does not know yet is kept, not thrown.
        public init(from decoder: Decoder) throws {
            let raw = try decoder.singleValueContainer().decode(String.self)
            self = Status(rawValue: raw) ?? .unknown
        }
    }

    public struct Entry: Decodable, Equatable, Sendable, Identifiable {
        public let name: String
        public let path: String
        public let kind: Kind
        public let status: Status?
        public var id: String { path }
        public var isDirectory: Bool { kind == .dir }
    }

    /// The path this level was requested for; "" is the repository root.
    public let path: String
    public let entries: [Entry]

    public static func read(_ data: Data) throws -> Self {
        guard data.count <= 8_388_608 else { throw PhrenKitError.validation("The working tree listing is too large.") }
        let result = try JSONDecoder().decode(Self.self, from: data)
        guard result.entries.count <= 5_000, result.path.utf8.count <= 4_096,
              result.entries.allSatisfy({ !$0.path.isEmpty && $0.path.utf8.count <= 4_096 }) else {
            throw PhrenKitError.validation("The working tree listing is invalid.")
        }
        return result
    }
}
