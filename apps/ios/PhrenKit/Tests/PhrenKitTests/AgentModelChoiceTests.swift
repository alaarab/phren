import XCTest
@testable import PhrenKit

final class AgentModelChoiceTests: XCTestCase {
    func testChoicesAndCommands() {
        XCTAssertTrue(AgentModelChoice.supportsPicker(source: "claude"))
        XCTAssertTrue(AgentModelChoice.supportsPicker(source: "codex"))
        XCTAssertFalse(AgentModelChoice.supportsPicker(source: "opencode"))
        XCTAssertEqual(AgentModelChoice.choices(source: "claude").map(\.argument), ["claude-fable-5-1", "opus", "opus[1m]", "sonnet", "haiku"])
        XCTAssertEqual(AgentModelChoice.choices(source: "codex").first?.argument, "gpt-5.6-sol")
        XCTAssertTrue(AgentModelChoice.choices(source: "copilot").isEmpty)
        XCTAssertEqual(AgentModelChoice.command(for: " sonnet "), "/model sonnet")
        XCTAssertEqual(AgentModelChoice.command(for: "opus[1m]"), "/model opus[1m]")
        XCTAssertNil(AgentModelChoice.command(for: ""))
        XCTAssertNil(AgentModelChoice.command(for: "two words"))
        XCTAssertNil(AgentModelChoice.command(for: "bad;id"))
    }
}
