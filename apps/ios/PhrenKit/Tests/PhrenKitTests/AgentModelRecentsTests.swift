import XCTest
@testable import PhrenKit

final class AgentModelRecentsTests: XCTestCase {
    func testRemembersNewestFirstCapsAndIsolatesPerSource() {
        var store = AgentModelRecents()
        for id in ["m1", "m2", "m3", "m4", "m5", "m6"] { store.remember(id, source: "claude") }
        XCTAssertEqual(store.ids(source: "claude"), ["m6", "m5", "m4", "m3", "m2"], "Newest first, capped at five")
        store.remember("m3", source: "claude")
        XCTAssertEqual(store.ids(source: "claude"), ["m3", "m6", "m5", "m4", "m2"], "A repeat moves to the front without duplicating")
        store.remember("gpt-5.6-sol", source: "codex")
        XCTAssertEqual(store.ids(source: "claude"), ["m3", "m6", "m5", "m4", "m2"], "Another harness's recents never touch this one")
        XCTAssertEqual(store.ids(source: "codex"), ["gpt-5.6-sol"])
        XCTAssertEqual(AgentModelRecents.perSourceLimit, 5)
    }

    func testRawJSONSurvivesPunctuationAndGarbageIsNoRecents() {
        var store = AgentModelRecents()
        store.remember("model,with;punct=uality", source: "claude")
        XCTAssertEqual(AgentModelRecents(raw: store.raw).ids(source: "claude"), ["model,with;punct=uality"],
                       "JSON keeps one odd id as one id")
        XCTAssertTrue(AgentModelRecents(raw: "claude=a,b;codex=c").ids(source: "claude").isEmpty,
                      "The old delimited encoding is never trusted back")
        XCTAssertTrue(AgentModelRecents(raw: "{not json").ids(source: "claude").isEmpty)
        XCTAssertTrue(AgentModelRecents(raw: "").ids(source: "claude").isEmpty)
        XCTAssertTrue(AgentModelRecents(raw: "[{\"source\":\"\",\"ids\":[]}]").ids(source: "").isEmpty)
    }

    func testOrdersRecentsFirstAndKeepsOffCatalogueRows() {
        let catalogue = AgentModelChoice.choices(source: "claude")
        let ordered = AgentModelRecents.ordered(catalogue, recent: ["claude-haiku-4-5-20251001", "custom-model-id"])
        XCTAssertEqual(ordered.map(\.argument),
                       ["claude-haiku-4-5-20251001", "custom-model-id",
                        "claude-fable-5-1", "claude-opus-5", "claude-sonnet-5", "claude-fable-5-1[1m]"])
        XCTAssertEqual(ordered[1].name, "custom-model-id")
        XCTAssertEqual(ordered[1].description, "Used recently")
        XCTAssertEqual(AgentModelRecents.ordered(catalogue, recent: []).map(\.argument), catalogue.map(\.argument),
                       "No recents leaves the default-led catalogue order alone")
        let deduped = AgentModelRecents.ordered(catalogue, recent: ["claude-opus-5", "claude-opus-5"])
        XCTAssertEqual(deduped.filter { $0.argument == "claude-opus-5" }.count, 1)
    }
}
