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

    func testCatalogueFromTheComputer() throws {
        let data = Data(#"{"models":[{"id":"gpt-6-astra","name":"GPT-6-Astra","description":"Most capable.","isDefault":true},{"id":"gpt-5.6-sol","name":"GPT-5.6-Sol"},{"id":"bad id","name":"x"},{"id":"claude-fable-5-1[1m]","name":"Fable 5.1 (1M context)"}]}"#.utf8)
        let models = try AgentModelChoice.read(data)
        XCTAssertEqual(models.map(\.argument), ["gpt-6-astra", "gpt-5.6-sol", "claude-fable-5-1[1m]"])
        XCTAssertEqual(models[0].description, "Most capable.")
        XCTAssertTrue(models[0].isDefault)
        XCTAssertFalse(models[1].isDefault)
        XCTAssertThrowsError(try AgentModelChoice.read(Data("{}".utf8)))
    }
}
