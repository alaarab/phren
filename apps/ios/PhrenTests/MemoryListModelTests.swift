import PhrenKit
import XCTest
@testable import Phren

@MainActor
final class MemoryListModelTests: XCTestCase {
    private let store = "sample/brain"

    private func item(_ kind: MemoryItem.Kind, key: String, project: String,
                      date: String? = nil, typeTag: String? = nil,
                      section: PhrenTask.Section? = nil, detail: String? = nil) -> MemoryItem {
        MemoryItem(kind: kind, key: key, storeId: store, project: project, text: key,
                   date: date, typeTag: typeTag, section: section, detail: detail,
                   nodeID: nil, finding: nil, task: nil)
    }

    func testGroupingFollowsTheProjectFilterAndTheMetaLineKnowsWhatToDraw() {
        let model = MemoryListModel()
        let contents = [
            item(.task, key: "t1", project: "phren", date: "2026-09-19", section: .active),
            item(.finding, key: "f1", project: "ledger", date: "2026-09-18", typeTag: "pattern"),
            item(.topic, key: "decision", project: "", detail: "2 findings"),
        ]

        model.update(contents: contents, kinds: [], projects: [], query: "", searchResults: [])
        XCTAssertTrue(model.grouped, "no project chosen groups the list")
        XCTAssertEqual(model.groups.map(\.project), ["phren", "ledger", ""])
        XCTAssertEqual(model.rows.count, 3)
        XCTAssertEqual(model.counts.tasks, 1)
        XCTAssertFalse(model.scopeIsEmpty)

        model.update(contents: contents, kinds: [.tasks], projects: ["phren"], query: "", searchResults: [])
        XCTAssertFalse(model.grouped, "exactly one project leaves the list flat")
        XCTAssertTrue(model.groups.isEmpty, "a flat list carries no groups")
        XCTAssertEqual(model.rows.map(\.id), ["task:t1"], "one project and Tasks keep only its tasks")

        model.update(contents: [], kinds: [], projects: ["ledger"], query: "", searchResults: [])
        XCTAssertTrue(model.scopeIsEmpty)
        XCTAssertTrue(model.rows.isEmpty)
        model.update(contents: contents, kinds: [], projects: ["absent"], query: "", searchResults: [])
        XCTAssertEqual(model.rows.map(\.kind), [.topic], "topic rows stay in view whatever the project filter")

        // A task draws its section chip (and usually its date) whatever the
        // filters, so its meta line is never empty; a bare finding with no
        // chips to show draws no meta line at all.
        let task = contents[0]
        XCTAssertTrue(MemoryRowCard.hasMetaLine(item: task, showKind: false, showProject: false))
        let bare = item(.finding, key: "f2", project: "phren")
        XCTAssertFalse(MemoryRowCard.hasMetaLine(item: bare, showKind: false, showProject: false))
        XCTAssertTrue(MemoryRowCard.hasMetaLine(item: bare, showKind: false, showProject: true),
                      "the project chip alone is enough to draw the line")
        XCTAssertTrue(MemoryRowCard.hasMetaLine(item: bare, showKind: true, showProject: false),
                      "the kind chip alone is enough too")
    }
}
