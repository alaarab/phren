import XCTest
@testable import PhrenKit

final class DismissedAgentsTests: XCTestCase {
    private var suite = ""
    private var defaults: UserDefaults!

    override func setUpWithError() throws {
        suite = "phren-dismissed-agents-tests-\(UUID().uuidString)"
        defaults = try XCTUnwrap(UserDefaults(suiteName: suite))
    }

    override func tearDown() {
        defaults.removePersistentDomain(forName: suite)
        defaults = nil
        super.tearDown()
    }

    func testDismissalsRoundTripAndCanBeRestoredOrCleared() {
        let key = "claude:session-one"
        let store = DismissedAgents(defaults: defaults)
        store.dismiss("child-a", in: key)
        store.dismiss("child-b", in: key)
        store.dismiss("child-a", in: key)

        let reloaded = DismissedAgents(defaults: defaults)
        XCTAssertEqual(reloaded.ids(for: key), ["child-a", "child-b"])

        reloaded.restore("child-a", in: key)
        XCTAssertEqual(store.ids(for: key), ["child-b"])
        reloaded.clearAll(in: key)
        XCTAssertTrue(store.ids(for: key).isEmpty)
    }

    func testEachConversationKeepsItsOwnDismissals() {
        let store = DismissedAgents(defaults: defaults)
        store.dismiss("shared-child", in: "codex:session-one")
        store.dismiss("other-child", in: "codex:session-two")

        XCTAssertEqual(store.ids(for: "codex:session-one"), ["shared-child"])
        XCTAssertEqual(store.ids(for: "codex:session-two"), ["other-child"])

        store.clearAll(in: "codex:session-one")
        XCTAssertTrue(store.ids(for: "codex:session-one").isEmpty)
        XCTAssertEqual(store.ids(for: "codex:session-two"), ["other-child"])
    }

    func testConversationDropsOldestDismissalsAfterTwoHundredIDs() {
        let store = DismissedAgents(defaults: defaults)
        let key = "opencode:large-session"
        for index in 0..<205 {
            store.dismiss("child-\(index)", in: key)
        }

        let ids = store.ids(for: key)
        XCTAssertEqual(ids.count, 200)
        for index in 0..<5 { XCTAssertFalse(ids.contains("child-\(index)")) }
        for index in 5..<205 { XCTAssertTrue(ids.contains("child-\(index)")) }
    }
}
