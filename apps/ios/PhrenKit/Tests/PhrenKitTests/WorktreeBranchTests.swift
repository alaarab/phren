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
