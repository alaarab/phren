import PhrenKit
import XCTest
@testable import Phren

final class SelectionSheetTests: XCTestCase {
    private let options: [PhrenOption<String>] = [
        .init(id: "notes", value: "notes", title: "Notes", caption: "Project café"),
        .init(id: "tasks", value: "tasks", title: "Tasks"),
        .init(id: "locked", value: "locked", title: "Unavailable", isEnabled: false),
    ]

    func testSearchMatchesWordsWithoutChangingChipOrderOrCount() {
        XCTAssertEqual(PhrenMultiSelection.filtered(options, query: "  CAFE notes ").map(\.id), ["notes"])
        XCTAssertEqual(PhrenMultiSelection.filtered(options, query: " \n").count, 3)
        XCTAssertTrue(PhrenMultiSelection.filtered(options, query: "missing").isEmpty)
        let selection: Set<String> = ["tasks", "notes", "removed"]
        let chips = PhrenMultiSelection.chosen(options, selection: selection)
        XCTAssertEqual(chips.map(\.id), ["notes", "tasks"])
        XCTAssertEqual(chips.count, 2, "Only current options count, regardless of the search")
    }

    func testRemovingAChipUsesTheSameRulesAsItsRow() {
        let selection: Set<String> = ["notes", "tasks", "locked"]
        let next = PhrenMultiSelection.toggle("notes", options: options, selection: selection, requiresSelection: false)
        XCTAssertEqual(next, ["tasks", "locked"])
        XCTAssertEqual(PhrenMultiSelection.chosen(options, selection: next).count, 2)
        XCTAssertEqual(PhrenMultiSelection.toggle("locked", options: options, selection: next, requiresSelection: false), next)
        XCTAssertEqual(PhrenMultiSelection.toggle("tasks", options: options, selection: ["tasks"], requiresSelection: true), ["tasks"])
        XCTAssertEqual(PhrenMultiSelection.toggle("tasks", options: options, selection: ["tasks"], requiresSelection: false), [])
    }

    func testBulkChangesApplyToAllOptionsAndPreserveUnavailableValues() {
        XCTAssertEqual(PhrenMultiSelection.all(options, selection: ["removed"]), ["notes", "tasks", "removed"])
        XCTAssertEqual(PhrenMultiSelection.none(options, selection: ["notes", "locked", "removed"], requiresSelection: false), ["locked", "removed"])
        XCTAssertEqual(PhrenMultiSelection.none(options, selection: ["notes"], requiresSelection: true), ["notes"])
        XCTAssertEqual(PhrenMultiSelection.none(options, selection: ["notes", "locked"], requiresSelection: true), ["locked"])
    }

    func testComputersSortByReachabilityThenProjectRecency() throws {
        let old = try destination("Desk", reachable: true, date: 10)
        let recent = try destination("Linuxbox", reachable: true, date: 20)
        let offline = try destination("Desk offline", reachable: false, date: 30)
        let unused = try destination("Desk unused", reachable: true, date: nil)
        let targets = [offline, unused, old, recent]
        XCTAssertEqual(ProjectAgentDestination.ordered(targets).map(\.host.name), ["Linuxbox", "Desk", "Desk unused", "Desk offline"])
        XCTAssertEqual(ProjectAgentDestination.lastUsed(in: targets)?.id, offline.id, "The actual last computer stays visible even while offline")
        XCTAssertNil(ProjectAgentDestination.lastUsed(in: [unused]))
    }

    func testComputerStatusExplainsUnavailabilityAndSessionCount() throws {
        var offline = try destination("Desk", reachable: false, date: nil)
        offline.lastSeen = Date(timeIntervalSince1970: 100)
        offline.reason = "SSH connection refused."
        XCTAssertTrue(offline.caption.contains("Offline · 0 sessions"))
        XCTAssertTrue(offline.caption.contains("Last seen"))
        XCTAssertTrue(offline.caption.contains("SSH connection refused."))
        var busy = try destination("Linuxbox", reachable: true, date: nil)
        busy.state = "Working"
        busy.sessionCount = 1
        XCTAssertEqual(busy.caption, "Working · 1 session")
    }

    func testRecentComputersRemainScopedToTheStoreAndProject() throws {
        let host = try destination("Desk", reachable: true, date: nil).host.id
        var data = ProjectAgentRecents.recording(storeID: "sample/brain", project: "phone", hostID: host,
                                                at: Date(timeIntervalSince1970: 10), in: Data())
        data = ProjectAgentRecents.recording(storeID: "team/brain", project: "phone", hostID: host,
                                            at: Date(timeIntervalSince1970: 20), in: data)
        data = ProjectAgentRecents.recording(storeID: "sample/brain", project: "phone", hostID: host,
                                            at: Date(timeIntervalSince1970: 30), in: data)
        let uses = ProjectAgentRecents.read(data)
        XCTAssertEqual(uses.count, 2)
        XCTAssertEqual(uses.first?.storeID, "sample/brain")
        XCTAssertEqual(uses.first?.date, Date(timeIntervalSince1970: 30))
        XCTAssertEqual(uses.last?.storeID, "team/brain")
    }

    private func destination(_ name: String, reachable: Bool, date: TimeInterval?) throws -> ProjectAgentDestination {
        .init(storeID: "sample/brain", project: "phone",
              host: try LiveHost(name: name, address: "computer.invalid", username: "sam"),
              reachable: reachable, state: reachable ? "Idle" : "Offline", sessionCount: 0,
              lastUsed: date.map { Date(timeIntervalSince1970: $0) })
    }
}
