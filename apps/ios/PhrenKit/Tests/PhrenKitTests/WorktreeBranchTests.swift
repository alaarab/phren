import Foundation
import XCTest
@testable import PhrenKit

final class WorktreeBranchTests: XCTestCase {
    private let id = UUID(uuidString: "A1B2C3D4-0000-4000-8000-000000000000")!

    func testSuggestsASlugOfTheFirstLineOrAShortID() {
        XCTAssertEqual(WorktreeBranch.suggested(firstLine: "Fix the login bug on Desk\nMore context", id: id), "phren/fix-the-login-bug-on-desk")
        XCTAssertEqual(WorktreeBranch.suggested(firstLine: "Café: résumé export!", id: id), "phren/cafe-resume-export")
        XCTAssertEqual(WorktreeBranch.suggested(firstLine: nil, id: id), "phren/a1b2c3")
        XCTAssertEqual(WorktreeBranch.suggested(firstLine: "  ??  ", id: id), "phren/a1b2c3")
    }

    func testSuggestsFromASessionTitle() {
        // A session's title as Herdr reports it: a status glyph, mixed case, punctuation.
        XCTAssertEqual(WorktreeBranch.suggested(firstLine: "Polish the phone app", id: id), "phren/polish-the-phone-app")
        XCTAssertEqual(WorktreeBranch.suggested(firstLine: "\u{2733} Claude Code", id: id), "phren/claude-code")
        XCTAssertEqual(WorktreeBranch.suggested(firstLine: "Fix #42: the iOS_build (again)", id: id), "phren/fix-42-the-ios-build-again")
        let long = WorktreeBranch.suggested(firstLine: "Continue where the earlier session left off in Codex", id: id)
        XCTAssertEqual(long, "phren/continue-where-the-earlier-session-left")
        XCTAssertNotNil(long.dropFirst(6).range(of: #"^[a-z0-9-]{1,40}$"#, options: .regularExpression))
    }

    func testSlugStopsAtAWordWithinTheLimit() {
        let slug = WorktreeBranch.slug("Move the schedule editor into its own screen and keep every field", limit: 40)
        XCTAssertEqual(slug, "move-the-schedule-editor-into-its-own")
        XCTAssertLessThanOrEqual(slug.count, 40)
        XCTAssertEqual(WorktreeBranch.slug(String(repeating: "x", count: 60), limit: 40).count, 40)
    }

    func testFlagsNamesTheHookWouldRefuse() {
        XCTAssertNil(WorktreeBranch.problem("phren/fix-login"))
        XCTAssertNil(WorktreeBranch.problem("release/1.0"))
        for bad in ["", "-x", ".x", "a b", "a..b", "a//b", "a/", "a.lock", "a/.b", String(repeating: "x", count: 101)] {
            XCTAssertNotNil(WorktreeBranch.problem(bad), bad)
        }
        // Every suggestion is acceptable.
        XCTAssertNil(WorktreeBranch.problem(WorktreeBranch.suggested(firstLine: "Ship 1.0 -- now", id: id)))
    }
}
