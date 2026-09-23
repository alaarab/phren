#if DEBUG && targetEnvironment(simulator)
import Foundation
import PhrenKit

/// Fixture answers for the Changes screen's pull requests and working tree.
/// Kept apart from the chat fixture so the two screens evolve independently.
extension AgentChatFixture {
    static func pulls() throws -> GitPulls {
        try GitPulls.read(Data(#"""
        {"available":true,"pulls":[
          {"number":42,"title":"Changes: pull requests and a working tree","head":"changes/pulls","base":"main","author":"sam","url":"https://github.com/sam/phren/pull/42","draft":false,"state":"OPEN","updated":"2026-09-20T10:00:00Z"},
          {"number":37,"title":"Draft: working tree browser","head":"changes/tree","base":"main","author":"sam","url":"https://github.com/sam/phren/pull/37","draft":true,"state":"OPEN","updated":"2026-09-19T09:00:00Z"}
        ]}
        """#.utf8))
    }

    nonisolated(unsafe) private static var gitFiles: [GitStatus.File] = [
        .init(path: "Sources/App.swift", status: "M", staged: false, additions: 1, deletions: 1),
        .init(path: "Sources/App/Settings.swift", status: "M", staged: true, additions: 4, deletions: 1),
        .init(path: "Sources/App/Settings.swift", status: "M", staged: false, additions: 1, deletions: 1),
        .init(path: "Notes.md", status: "?", staged: false, additions: 6, deletions: 0),
    ]

    /// Two workers' worktrees and one nobody claims, as `/v1/git/worktrees` lists them.
    static let parserWorktree = "0123456789abcdef0123456789abcdef"
    static func gitWorktrees() throws -> GitWorktrees {
        GitWorktrees(worktrees: [
            .init(id: parserWorktree, path: ".claude/worktrees/agent-parser", branch: "worktree-agent-parser",
                  ahead: 2, changed: 3, worker: .init(label: "Fix the parser", provider: "claude",
                                                      child: String(repeating: "c", count: 32), state: "running")),
            .init(id: "fedcba9876543210fedcba9876543210", path: "~/work/phren-review", branch: "fanout/review",
                  ahead: 1, changed: 0, worker: .init(label: "Review bridge routes", provider: "codex", state: "completed")),
            .init(id: "00112233445566778899aabbccddeeff", path: ".claude/worktrees/agent-old", branch: "worktree-agent-old"),
        ])
    }

    static func gitStatus(_ target: AgentChatTarget, child: String? = nil, worktree: String? = nil) throws -> GitStatus {
        if worktree != nil {
            // A worker's checkout: its own branch and edits, none of the pane's.
            return GitStatus(branch: "worktree-agent-parser", upstream: nil, ahead: 2, behind: 0, staged: 0, unstaged: 2, untracked: 1,
                             additions: 18, deletions: 4, files: [
                                .init(path: "Sources/Parser.swift", status: "M", staged: false, additions: 12, deletions: 4),
                                .init(path: "Sources/Lexer.swift", status: "M", staged: false, additions: 2, deletions: 0),
                                .init(path: "Tests/ParserTests.swift", status: "?", staged: false, additions: 4, deletions: 0),
                             ])
        }
        return GitStatus(branch: child == nil ? "main" : "deepseek/compact-phone", upstream: "origin/main", ahead: 1, behind: 0,
                  staged: gitFiles.filter(\.staged).count,
                  unstaged: gitFiles.filter { !$0.staged && $0.status != "?" }.count,
                  untracked: gitFiles.filter { $0.status == "?" }.count,
                  additions: gitFiles.reduce(0) { $0 + $1.additions }, deletions: gitFiles.reduce(0) { $0 + $1.deletions },
                  files: gitFiles)
    }

    static func gitWrite(_ route: String, paths: [String]) throws {
        guard ["stage", "unstage", "discard"].contains(route) else { throw PhrenKitError.validation("Unknown Git action.") }
        for path in paths {
            let affected = gitFiles.filter { $0.path == path && (route == "unstage" ? $0.staged : !$0.staged) }
            gitFiles.removeAll { affected.contains($0) }
            guard route != "discard" else { continue }
            for file in affected {
                let staged = route == "stage"
                let existing = gitFiles.first { $0.path == path && $0.staged == staged }
                gitFiles.removeAll { $0.path == path && $0.staged == staged }
                gitFiles.append(.init(path: path, status: file.status == "?" && staged ? "A" : file.status,
                                      staged: staged, additions: file.additions + (existing?.additions ?? 0),
                                      deletions: file.deletions + (existing?.deletions ?? 0)))
            }
        }
    }

    static func gitDiff() throws -> AgentRepositoryDiff {
        let files: [[String: Any]] = Dictionary(grouping: gitFiles, by: \.path).sorted { $0.key < $1.key }.map { path, changes in
            let sections: [[String: Any]] = changes.map { file in
                let kind = file.staged ? "staged" : "unstaged"
                let patch = path == "Sources/App.swift"
                    ? "@@ -2,3 +2,3 @@\n import SwiftUI\n-let accent = green\n+let accent = purple\n let radius = 12\n@@ -10,2 +10,2 @@\n-old value\n+new value with a sufficiently long line to exercise horizontal scrolling in the phone diff editor\n keep"
                    : "@@ -1 +1 @@\n-old value\n+new value"
                return ["id": "\(kind):\(path)", "kind": kind, "binary": false, "loadState": "loaded", "patch": patch]
            }
            return ["path": path, "status": changes.first?.status ?? "M", "sections": sections]
        }
        return try AgentRepositoryDiff.read(JSONSerialization.data(withJSONObject: [
            "root": "/home/sam/phren", "launchPath": "/home/sam/phren", "branch": "main", "files": files,
        ]))
    }

    /// Ignored entries the working tree hides until Show ignored is on: a
    /// media folder (the owner's `video/`), build output and one file.
    private static let ignoredPaths = ["video/intro.mp4", "video/clips/demo.mov", "build/app.o", "debug.log"]

    static func tree(path: String, ignored: Bool = false) throws -> GitWorkingTree {
        let paths = Set(gitFiles.map(\.path)).union(["README.md"]).union(ignored ? Set(ignoredPaths) : [])
        let prefix = path.isEmpty ? "" : path + "/"
        var entries: [String: [String: Any]] = [:]
        for file in paths where file.hasPrefix(prefix) {
            let parts = file.dropFirst(prefix.count).split(separator: "/")
            guard let first = parts.first else { continue }
            let name = String(first), directory = parts.count > 1
            var entry: [String: Any] = ["name": name, "path": prefix + name, "kind": directory ? "dir" : "file"]
            if ignoredPaths.contains(file) {
                // A folder that also holds tracked files is not ignored itself.
                if let existing = entries[name], existing["ignored"] == nil { continue }
                entry["ignored"] = true
            } else if directory { entry["status"] = "changed" }
            else if let change = gitFiles.first(where: { $0.path == file }) { entry["status"] = change.status }
            entries[name] = entry
        }
        let sorted = entries.values.sorted {
            let lhs = $0["kind"] as? String ?? "", rhs = $1["kind"] as? String ?? ""
            return lhs == rhs ? ($0["name"] as? String ?? "") < ($1["name"] as? String ?? "") : lhs == "dir"
        }
        return try GitWorkingTree.read(JSONSerialization.data(withJSONObject: ["path": path, "entries": sorted]))
    }
}
#endif
