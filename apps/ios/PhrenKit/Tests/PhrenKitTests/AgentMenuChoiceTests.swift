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
        // Full Access opens Codex's "Enable full access?" dialog; one Enter confirms it.
        XCTAssertEqual(AgentMenuChoice.confirmationKeys(command: "/permissions", source: "codex", index: 2), [.enter])
        XCTAssertEqual(AgentMenuChoice.confirmationKeys(command: "/permissions", source: "codex", index: 1), [])
        XCTAssertEqual(AgentMenuChoice.confirmationKeys(command: "/permissions", source: "claude", index: 2), [])
    }
}
