import XCTest
@testable import PhrenKit

final class AgentMenuChoiceTests: XCTestCase {
    func testMenusAndKeys() {
        let menu = AgentMenuChoice.menu(command: "/permissions", source: "codex")
        XCTAssertEqual(menu?.title, "Permissions")
        XCTAssertEqual(menu?.rows.map(\.name), ["Ask for approval", "Approve for me", "Full Access"])
        XCTAssertNil(AgentMenuChoice.menu(command: "/permissions", source: "claude"))
        XCTAssertNil(AgentMenuChoice.menu(command: "/model", source: "codex"))
        XCTAssertEqual(AgentMenuChoice.keys(selecting: 0), [.enter])
        XCTAssertEqual(AgentMenuChoice.keys(selecting: 2), [.down, .down, .enter])
    }
}
