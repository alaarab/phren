import Foundation
import XCTest
@testable import PhrenKit

final class GitWorktreesTests: XCTestCase {
    private let payload = #"""
    {"worktrees":[
      {"id":"0123456789abcdef0123456789abcdef","path":".claude/worktrees/agent-one","branch":"worktree-agent-one",
       "head":"a1b2c3d4","ahead":3,"behind":0,"changed":2,
       "worker":{"label":"Fix the parser","provider":"claude","child":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","state":"running"}},
      {"id":"fedcba9876543210fedcba9876543210","path":"~/work/repo-fanout","branch":null,"head":"b2c3","changed":0,"main":true}
    ]}
    """#

    func testReadsWorktreesWorkersAndCounts() throws {
        let list = try GitWorktrees.read(Data(payload.utf8))
        XCTAssertEqual(list.worktrees.count, 2)
        let agent = list.worktrees[0]
        XCTAssertEqual(agent.branch, "worktree-agent-one")
        XCTAssertEqual(agent.worker, .init(label: "Fix the parser", provider: "claude", child: String(repeating: "a", count: 32), state: "running"))
        XCTAssertEqual(agent.title, "Fix the parser")
        XCTAssertEqual(agent.summary, "2 files · ↑3")
        XCTAssertFalse(agent.main)
        let detached = list.worktrees[1]
        XCTAssertNil(detached.branch)
        XCTAssertTrue(detached.main)
        XCTAssertEqual(detached.behind, 0)
        XCTAssertEqual(detached.title, "repo-fanout", "Without a worker or branch the folder names it")
        XCTAssertNil(detached.summary)
    }

    func testBranchTitlesAnUnlabelledWorktree() throws {
        let list = try GitWorktrees.read(Data(#"{"worktrees":[{"id":"0123456789abcdef0123456789abcdef","path":"wt","branch":"fanout/review","changed":1}]}"#.utf8))
        XCTAssertEqual(list.worktrees[0].title, "fanout/review")
        XCTAssertEqual(list.worktrees[0].summary, "1 file")
    }

    func testRejectsAnIdThatIsNotOpaqueOrAWorkerChildThatIsNotAnId() {
        XCTAssertThrowsError(try GitWorktrees.read(Data(#"{"worktrees":[{"id":"../etc","path":"wt"}]}"#.utf8)))
        XCTAssertThrowsError(try GitWorktrees.read(Data(#"{"worktrees":[{"id":"0123456789abcdef0123456789abcdef","path":"wt","worker":{"label":"x","provider":"codex","child":"nope"}}]}"#.utf8)))
        XCTAssertThrowsError(try GitWorktrees.read(Data(#"{"worktrees":[{"id":"0123456789abcdef0123456789abcdef","path":"wt","changed":-1}]}"#.utf8)))
    }

    func testIgnoredTreeEntriesDecode() throws {
        let tree = try GitWorkingTree.read(Data(#"{"path":"","entries":[{"name":"video","path":"video","kind":"dir","ignored":true},{"name":"README.md","path":"README.md","kind":"file"}]}"#.utf8))
        XCTAssertTrue(tree.entries[0].isIgnored)
        XCTAssertTrue(tree.entries[0].isDirectory)
        XCTAssertFalse(tree.entries[1].isIgnored)
    }
}
