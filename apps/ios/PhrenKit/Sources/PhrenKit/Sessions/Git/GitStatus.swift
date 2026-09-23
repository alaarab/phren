import Foundation

/// A pane's working tree as Phren Hook reports it: branch and upstream,
/// ahead/behind, the staged, unstaged and untracked counts, and one row per
/// changed file. A file with both staged and unstaged edits arrives twice,
/// once per `staged` flag, because it is two changes to source control.
public struct GitStatus: Decodable, Equatable, Sendable {
    public struct File: Decodable, Equatable, Sendable, Identifiable {
        public let path: String
        /// The porcelain letter (`M`, `A`, `D`, `R`, `?`, `C`, `U`). Kept a
        /// string so a letter this build does not know still round-trips.
        public let status: String
        public let staged: Bool
        public let additions: Int
        public let deletions: Int
        public var name: String { path.split(separator: "/").last.map(String.init) ?? path }
        public var id: String { path + (staged ? "\u{1}staged" : "\u{1}unstaged") }

        public init(path: String, status: String, staged: Bool, additions: Int, deletions: Int) {
            self.path = path; self.status = status; self.staged = staged
            self.additions = additions; self.deletions = deletions
        }

        public init(from decoder: Decoder) throws {
            let values = try decoder.container(keyedBy: CodingKeys.self)
            path = try values.decode(String.self, forKey: .path)
            status = try values.decodeIfPresent(String.self, forKey: .status) ?? ""
            staged = try values.decodeIfPresent(Bool.self, forKey: .staged) ?? false
            additions = try values.decodeIfPresent(Int.self, forKey: .additions) ?? 0
            deletions = try values.decodeIfPresent(Int.self, forKey: .deletions) ?? 0
        }

        private enum CodingKeys: String, CodingKey { case path, status, staged, additions, deletions }
    }

    public enum Kind: String, Sendable {
        case modified = "M", added = "A", deleted = "D", renamed = "R"
        case untracked = "?", copied = "C", unmerged = "U", unknown
    }

    public let branch: String?
    public let upstream: String?
    public let ahead: Int
    public let behind: Int
    public let staged: Int
    public let unstaged: Int
    public let untracked: Int
    public let additions: Int
    public let deletions: Int
    public let files: [File]
    /// The branch a push asks to confirm: the upstream remote's `HEAD`, or
    /// `main`/`master` when the remote records none. Nil from an older Hook.
    public let defaultBranch: String?

    public init(branch: String?, upstream: String?, ahead: Int, behind: Int, staged: Int, unstaged: Int,
                untracked: Int, additions: Int, deletions: Int, files: [File], defaultBranch: String? = nil) {
        self.branch = branch; self.upstream = upstream; self.ahead = ahead; self.behind = behind
        self.staged = staged; self.unstaged = unstaged; self.untracked = untracked
        self.additions = additions; self.deletions = deletions; self.files = files
        self.defaultBranch = defaultBranch
    }

    /// Pushing this branch would update the default branch.
    public var onDefaultBranch: Bool {
        guard let branch, !branch.isEmpty else { return false }
        let destination = upstream.flatMap { $0.split(separator: "/", maxSplits: 1).last.map(String.init) }
        return branch == defaultBranch || (destination != nil && destination == defaultBranch)
    }

    private enum CodingKeys: String, CodingKey {
        case branch, upstream, ahead, behind, staged, unstaged, untracked, additions, deletions, files, defaultBranch
    }

    public init(from decoder: Decoder) throws {
        let values = try decoder.container(keyedBy: CodingKeys.self)
        branch = try values.decodeIfPresent(String.self, forKey: .branch)
        upstream = try values.decodeIfPresent(String.self, forKey: .upstream)
        ahead = try values.decodeIfPresent(Int.self, forKey: .ahead) ?? 0
        behind = try values.decodeIfPresent(Int.self, forKey: .behind) ?? 0
        staged = try values.decodeIfPresent(Int.self, forKey: .staged) ?? 0
        unstaged = try values.decodeIfPresent(Int.self, forKey: .unstaged) ?? 0
        untracked = try values.decodeIfPresent(Int.self, forKey: .untracked) ?? 0
        additions = try values.decodeIfPresent(Int.self, forKey: .additions) ?? 0
        deletions = try values.decodeIfPresent(Int.self, forKey: .deletions) ?? 0
        files = try values.decodeIfPresent([File].self, forKey: .files) ?? []
        defaultBranch = try values.decodeIfPresent(String.self, forKey: .defaultBranch)
    }

    /// Git's letter for this file, with anything unrecognised falling back to
    /// `unknown` rather than failing the whole payload.
    public static func kind(_ status: String) -> Kind {
        Kind(rawValue: status.trimmingCharacters(in: .whitespaces)) ?? .unknown
    }

    public static func read(_ data: Data) throws -> Self {
        guard data.count <= 8_388_608 else { throw PhrenKitError.validation("The repository status is too large.") }
        let value: Self
        do { value = try JSONDecoder().decode(Self.self, from: data) }
        catch { throw PhrenKitError.validation("The computer returned an unusable repository status. Refresh to try again.") }
        guard value.files.count <= 20_000,
              value.files.allSatisfy({ file in
                  !file.path.isEmpty && file.path.utf8.count <= 4_096
                      && file.additions >= 0 && file.deletions >= 0
                      && file.additions <= 1_000_000_000 && file.deletions <= 1_000_000_000
              }) else { throw PhrenKitError.validation("The repository status is invalid.") }
        return value
    }
}