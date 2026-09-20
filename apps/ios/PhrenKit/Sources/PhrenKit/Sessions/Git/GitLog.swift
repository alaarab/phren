import Foundation

/// A repository's commit history from Phren Hook's `POST /v1/git/log`: the
/// newest commits with their refs and parents, and a summary of the working
/// tree above them. The History tab draws it as a graph rail.
public struct GitLog: Decodable, Equatable, Sendable {
    public struct Ref: Decodable, Equatable, Sendable, Identifiable {
        /// `head` is the branch the working tree is on; the rest name a local
        /// branch, a remote-tracking branch or a tag. A kind this build does
        /// not know is kept, shown as a plain ref, never dropped.
        public enum Kind: String, Decodable, Sendable {
            case head, local, remote, tag, unknown

            public init(from decoder: Decoder) throws {
                let raw = (try? decoder.singleValueContainer().decode(String.self)) ?? ""
                self = Kind(rawValue: raw) ?? .unknown
            }
        }

        public let name: String
        public let kind: Kind
        public var id: String { "\(kind.rawValue):\(name)" }
    }

    public struct Commit: Decodable, Equatable, Sendable, Identifiable {
        public let sha: String
        public let short: String
        public let subject: String
        public let author: String
        public let date: String
        public let refs: [Ref]
        public let parents: [String]
        public var id: String { sha }
        public var relativeTime: String { ISO8601Dates.parse(date).map { SessionRelativeTime.text(since: $0, at: .now) } ?? "" }
    }

    public struct Uncommitted: Decodable, Equatable, Sendable {
        public let files: Int
        public let additions: Int
        public let deletions: Int
    }

    public let commits: [Commit]
    public let uncommitted: Uncommitted

    /// The Hook caps the log at 200 commits; the response stays small enough
    /// for one screen, so the only hard guard is the payload size.
    public static func read(_ data: Data) throws -> Self {
        guard data.count <= 8_388_608 else { throw PhrenKitError.validation("The commit history is too large.") }
        let result: Self
        do { result = try JSONDecoder().decode(Self.self, from: data) }
        catch { throw PhrenKitError.validation("The commit history response is invalid.") }
        guard result.commits.count <= 10_000,
              result.commits.allSatisfy({ !$0.sha.isEmpty && $0.sha.utf8.count <= 200 && $0.subject.utf8.count <= 10_000
                  && $0.author.utf8.count <= 1_000 && $0.refs.count <= 64 && $0.parents.count <= 64 }) else {
            throw PhrenKitError.validation("The commit history response is invalid.")
        }
        return result
    }
}
