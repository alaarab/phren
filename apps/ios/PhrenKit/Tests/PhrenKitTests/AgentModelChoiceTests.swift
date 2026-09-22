import XCTest
@testable import PhrenKit

final class AgentModelChoiceTests: XCTestCase {
    func testChoicesAndCommands() {
        XCTAssertTrue(AgentModelChoice.supportsPicker(source: "claude"))
        XCTAssertTrue(AgentModelChoice.supportsPicker(source: "codex"))
        XCTAssertTrue(AgentModelChoice.supportsPicker(source: "opencode"))
        XCTAssertEqual(AgentModelChoice.choices(source: "claude").map(\.argument),
                       ["claude-fable-5-1", "claude-opus-5", "claude-sonnet-5", "claude-haiku-4-5-20251001", "claude-fable-5-1[1m]"])
        XCTAssertEqual(AgentModelChoice.choices(source: "claude").first?.name, "Fable 5.1")
        XCTAssertTrue(AgentModelChoice.choices(source: "claude").first?.isDefault == true)
        let codex = AgentModelChoice.choices(source: "codex")
        XCTAssertEqual(codex.map(\.argument), ["gpt-6-astra", "gpt-5.6-sol", "gpt-5.6-terra"])
        XCTAssertEqual(codex.map(\.name), ["GPT-6-Astra", "GPT-5.6-Sol", "GPT-5.6-Terra"])
        XCTAssertEqual(codex.first?.isDefault, true)
        XCTAssertNotNil(codex.first?.description)
        XCTAssertEqual(codex.dropFirst().compactMap(\.description).count, 2, "Every Codex built-in row carries its caption")
        XCTAssertTrue(AgentModelChoice.choices(source: "copilot").isEmpty)
        XCTAssertEqual(AgentModelChoice.command(for: " sonnet "), "/model sonnet")
        XCTAssertEqual(AgentModelChoice.command(for: "opus[1m]"), "/model opus[1m]")
        XCTAssertNil(AgentModelChoice.command(for: ""))
        XCTAssertNil(AgentModelChoice.command(for: "two words"))
        XCTAssertNil(AgentModelChoice.command(for: "bad;id"))
    }

    func testMarkedChoicePrefersTheExactIdAndMatchesAtMostOneRow() {
        let menu = AgentModelChoice.choices(source: "claude")
        XCTAssertEqual(AgentModelChoice.markedChoice(current: "claude-fable-5-1[1m]", in: menu)?.argument,
                       "claude-fable-5-1[1m]", "The 1M row keeps its own mark; the plain row never steals it")
        XCTAssertEqual(AgentModelChoice.markedChoice(current: "claude-fable-5-1", in: menu)?.argument, "claude-fable-5-1")
        XCTAssertEqual(AgentModelChoice.markedChoice(current: "claude-sonnet-5", in: menu)?.argument, "claude-sonnet-5")
        XCTAssertEqual(AgentModelChoice.markedChoice(current: "sonnet", in: menu)?.argument, "claude-sonnet-5",
                       "An alias marks the catalogue row of its family")
        XCTAssertEqual(AgentModelChoice.markedChoice(current: "fable", in: menu)?.argument, "claude-fable-5-1",
                       "A tie keeps the first row, which the default-led catalogue puts first")
        XCTAssertNil(AgentModelChoice.markedChoice(current: nil, in: menu))
        XCTAssertNil(AgentModelChoice.markedChoice(current: "", in: menu))
        XCTAssertNil(AgentModelChoice.markedChoice(current: "gpt-5.6-sol", in: menu),
                     "Another harness's id marks no row")
    }

    func testContextVariantsNeverFallbackToEachOtherAndRecentsCanBeSelected() {
        let plain = AgentModelChoice(name: "Fable", argument: "claude-fable-5-1")
        let large = AgentModelChoice(name: "Fable 1M", argument: "claude-fable-5-1[1m]")
        XCTAssertNil(AgentModelChoice.markedChoice(current: large.argument, in: [plain]))
        XCTAssertNil(AgentModelChoice.markedChoice(current: plain.argument, in: [large]))
        XCTAssertEqual(AgentModelChoice.markedChoice(current: "fable[1m]", in: [plain, large]), large)
        let ordered = AgentModelRecents.ordered([plain], recent: ["custom-model"])
        XCTAssertEqual(AgentModelChoice.markedChoice(current: "custom-model", in: ordered)?.argument, "custom-model")
        XCTAssertNil(AgentModelChoice.markedChoice(current: "able", in: [plain]))
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
