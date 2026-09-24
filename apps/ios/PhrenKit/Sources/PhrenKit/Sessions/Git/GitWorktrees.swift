import Foundation

/// The pane repository's other worktrees from Phren Hook's
/// `POST /v1/git/worktrees`. Workers (sub-agents, fan-out jobs) edit in their
/// own worktree, so each row is where one worker's changes live: its branch,
/// commits ahead of the pane's HEAD, uncommitted files, and the worker when
/// the computer can name it. `id` is what the git routes take back as
/// `worktree`; the computer resolves it only against its own listing.
public struct GitWorktrees: Decodable, Equatable, Sendable {
    public struct Worker: Decodable, Equatable, Sendable {
        public let label: String
        public let provider: String
        /// This conversation's child agent, when the worker is one of its own.
        public let child: String?
        public let state: String?

        public init(label: String, provider: String, child: String? = nil, state: String? = nil) {
            self.label = label; self.provider = provider; self.child = child; self.state = state
        }
    }

    public struct Worktree: Decodable, Equatable, Sendable, Identifiable {
        public let id: String
        /// Relative to the repository when the worktree lives inside it.
        public let path: String
        public let branch: String?
        public let head: String
        public let ahead: Int
        public let behind: Int
        /// Uncommitted files (staged, unstaged and untracked).
        public let changed: Int
        /// The repository's primary checkout, listed when the pane is in a linked one.
        public let main: Bool
        public let worker: Worker?

        public init(id: String, path: String, branch: String?, head: String = "", ahead: Int = 0, behind: Int = 0,
                    changed: Int = 0, main: Bool = false, worker: Worker? = nil) {
            self.id = id; self.path = path; self.branch = branch; self.head = head
            self.ahead = ahead; self.behind = behind; self.changed = changed; self.main = main; self.worker = worker
        }

        public init(from decoder: Decoder) throws {
            let values = try decoder.container(keyedBy: CodingKeys.self)
            id = try values.decode(String.self, forKey: .id)
            path = try values.decode(String.self, forKey: .path)
            branch = try values.decodeIfPresent(String.self, forKey: .branch)
            head = try values.decodeIfPresent(String.self, forKey: .head) ?? ""
            ahead = try values.decodeIfPresent(Int.self, forKey: .ahead) ?? 0
            behind = try values.decodeIfPresent(Int.self, forKey: .behind) ?? 0
            changed = try values.decodeIfPresent(Int.self, forKey: .changed) ?? 0
            main = try values.decodeIfPresent(Bool.self, forKey: .main) ?? false
            worker = try values.decodeIfPresent(Worker.self, forKey: .worker)
        }

        private enum CodingKeys: String, CodingKey { case id, path, branch, head, ahead, behind, changed, main, worker }

        /// The worker's task when known, otherwise the branch, otherwise the folder.
        public var title: String {
            if let label = worker?.label, !label.isEmpty { return label }
            if let branch, !branch.isEmpty { return branch }
            return path.split(separator: "/").last.map(String.init) ?? path
        }

        /// "2 files · ↑3" style summary; nil when there is nothing to report.
        public var summary: String? {
            var parts: [String] = []
            if changed > 0 { parts.append(changed == 1 ? "1 file" : "\(changed) files") }
            if ahead > 0 { parts.append("↑\(ahead)") }
            if behind > 0 { parts.append("↓\(behind)") }
            return parts.isEmpty ? nil : parts.joined(separator: " · ")
        }
    }

    public let worktrees: [Worktree]

    public init(worktrees: [Worktree]) { self.worktrees = worktrees }

    public static func validID(_ id: String) -> Bool {
        id.range(of: #"^[a-f0-9]{32}$"#, options: .regularExpression) != nil
    }

    public static func read(_ data: Data) throws -> Self {
        guard data.count <= 1_048_576 else { throw PhrenKitError.validation("The worktree list is too large.") }
        let result: Self
        do { result = try JSONDecoder().decode(Self.self, from: data) }
        catch { throw PhrenKitError.validation("The worktree list response is invalid.") }
        guard result.worktrees.count <= 256,
              result.worktrees.allSatisfy({ worktree in
                  validID(worktree.id) && !worktree.path.isEmpty && worktree.path.utf8.count <= 4_096
                      && (worktree.branch?.utf8.count ?? 0) <= 1_000 && worktree.ahead >= 0 && worktree.behind >= 0
                      && worktree.changed >= 0 && (worktree.worker?.label.utf8.count ?? 0) <= 1_000
                      && (worktree.worker?.child.map(validID) ?? true)
              }) else { throw PhrenKitError.validation("The worktree list response is invalid.") }
        return result
    }
}
