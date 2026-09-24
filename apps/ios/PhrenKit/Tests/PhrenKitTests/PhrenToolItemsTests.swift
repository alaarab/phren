import XCTest
@testable import PhrenKit

final class PhrenToolItemsTests: XCTestCase {
    func testSeveralTasksInOneCallAreSeparateRows() throws {
        let input = #"{"project":"phren","item":["Search memory card misaligned","Show what the hook injected","Dispatch to the local Mac"]}"#
        let card = try XCTUnwrap(PhrenToolPresentation(name: "mcp__phren__add_task", input: input, result: #"{"ok":true}"#))
        XCTAssertEqual(card.items, ["Search memory card misaligned", "Show what the hook injected", "Dispatch to the local Mac"])
        XCTAssertEqual(card.toolName, "mcp__phren__add_task")
        XCTAssertTrue(card.fullInput.contains("Dispatch to the local Mac"))
    }

    func testOneTaskStaysTheBody() throws {
        let card = try XCTUnwrap(PhrenToolPresentation(name: "mcp__phren__add_task", input: #"{"project":"phren","item":["Just one"]}"#))
        XCTAssertEqual(card.items, [])
        XCTAssertEqual(card.body, "Just one")
    }
}
