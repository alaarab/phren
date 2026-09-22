import XCTest
import PhrenKit
@testable import Phren

final class TasksModelTests: XCTestCase {
    private func row(_ project: String, _ id: String, section: PhrenTask.Section = .queue,
                      store: String = "sample/brain") -> TaskListRow {
        let header: String
        let bullet: String
        switch section {
        case .active: (header, bullet) = ("Active", "- [ ]")
        case .queue: (header, bullet) = ("Queue", "- [ ]")
        case .done: (header, bullet) = ("Done", "- [x]")
        }
        let file = TasksFile(project: project, content: "# Tasks\n## \(header)\n\(bullet) Task \(id) <!-- bid:\(id) -->\n")
        let task: PhrenTask
        switch section {
        case .active: task = file.doc.active[0]
        case .queue: task = file.doc.queue[0]
        case .done: task = file.doc.done[0]
        }
        return TaskListRow(storeId: store, storeName: store, project: project, task: task)
    }

    func testCollapseEncodingRoundTripsRegardlessOfInsertionOrder() {
        XCTAssertEqual(TasksCollapse.decode(""), [])
        XCTAssertEqual(TasksCollapse.encode([]), "")
        let folded: Set<String> = ["payments", "demo", "atlas"]
        XCTAssertEqual(TasksCollapse.encode(folded), "atlas\ndemo\npayments",
                       "Encoding is sorted, so the raw string is stable")
        XCTAssertEqual(TasksCollapse.decode(TasksCollapse.encode(folded)), folded)
        XCTAssertEqual(TasksCollapse.decode("demo\npayments"), ["demo", "payments"])
        XCTAssertEqual(TasksCollapse.decode("\n\ndemo\n"), ["demo"])
    }

    func testSectionsOrderByOpenCountNotVisibleRows() {
        // Under Backlog: api shows 1 row but carries 3 more active tasks
        // (open 4); demo shows 3 rows and nothing active (open 3).
        let apiVisible = [row("api", "a1")]
        let demoVisible = [row("demo", "d1"), row("demo", "d2"), row("demo", "d3")]
        let groups = TasksModel.groups(visible: apiVisible + demoVisible,
                                       activeCounts: ["api": 3],
                                       queueCounts: ["api": 1, "demo": 3],
                                       storeIdByProject: [:])
        XCTAssertEqual(groups.map(\.project), ["api", "demo"],
                       "Open count (4 vs 3) decides the order; visible rows would say demo first")
        XCTAssertEqual(groups.map(\.rows.count), [1, 3])
        XCTAssertEqual(groups[0].activeCount, 3)
        XCTAssertEqual(groups[0].queueCount, 1)
        XCTAssertEqual(groups[1].activeCount, 0)
        XCTAssertEqual(groups[1].queueCount, 3)
    }

    func testEqualOpenCountsFallBackToProjectName() {
        let beta = [row("beta", "b1"), row("beta", "b2", section: .active)]
        let alpha = [row("alpha", "a1"), row("alpha", "a2", section: .active)]
        let groups = TasksModel.groups(visible: beta + alpha,
                                       activeCounts: ["beta": 1, "alpha": 1],
                                       queueCounts: ["beta": 1, "alpha": 1],
                                       storeIdByProject: [:])
        XCTAssertEqual(groups.map(\.project), ["alpha", "beta"])
    }

    func testColourStoreComesFromTheStoreListNotTheFilteredRows() {
        // The only visible rows belong to zstore, but the store list says
        // this project's colour is keyed on astore: a search dropping one
        // store's rows must not re-colour the header.
        let groups = TasksModel.groups(visible: [row("demo", "d1", store: "zstore/brain")],
                                       activeCounts: [:],
                                       queueCounts: ["demo": 1],
                                       storeIdByProject: ["demo": "astore/brain"])
        XCTAssertEqual(groups.map(\.storeId), ["astore/brain"])
        let fallback = TasksModel.groups(visible: [row("demo", "d1", store: "zstore/brain")],
                                         activeCounts: [:],
                                         queueCounts: ["demo": 1],
                                         storeIdByProject: [:])
        XCTAssertEqual(fallback.map(\.storeId), ["zstore/brain"])
    }

    func testProjectsWithoutVisibleRowsGetNoSection() {
        let groups = TasksModel.groups(visible: [row("demo", "d1")],
                                       activeCounts: ["ghost": 1],
                                       queueCounts: [:],
                                       storeIdByProject: [:])
        XCTAssertEqual(groups.map(\.project), ["demo"])
    }

    func testStatusFilterPartitionsRowsAndCounts() {
        let apiActive = row("api", "a1", section: .active)
        let apiQueue = row("api", "q1")
        let apiDone = row("api", "d1", section: .done)
        let demoQueue = row("demo", "q2")
        let all = [apiActive, apiQueue, apiDone, demoQueue]

        // Partition: which sections each status keeps, in row order.
        XCTAssertEqual(TaskStatus.open.sections, [.active, .queue])
        XCTAssertEqual(TaskStatus.active.sections, [.active])
        XCTAssertEqual(TaskStatus.backlog.sections, [.queue])
        XCTAssertEqual(TaskStatus.done.sections, [.done])
        XCTAssertEqual(TaskStatus.all.sections, [.active, .queue, .done])
        func kept(_ status: TaskStatus) -> [String] {
            all.filter { status.sections.contains($0.task.section) }.map(\.id)
        }
        XCTAssertEqual(kept(.open), [apiActive.id, apiQueue.id, demoQueue.id])
        XCTAssertEqual(kept(.active), [apiActive.id])
        XCTAssertEqual(kept(.backlog), [apiQueue.id, demoQueue.id])
        XCTAssertEqual(kept(.done), [apiDone.id])
        XCTAssertEqual(kept(.all).count, 4)

        // Counts: each status totals only its own sections, and the section
        // order follows that total (Backlog flips demo above api on queue
        // counts 4 vs 1, where Open would order api first on 4 vs 4 ties by name).
        XCTAssertEqual(TaskStatus.open.count(active: 3, queue: 2, done: 9), 5)
        XCTAssertEqual(TaskStatus.backlog.count(active: 3, queue: 2, done: 9), 2)
        XCTAssertEqual(TaskStatus.all.count(active: 3, queue: 2, done: 1), 6)
        let activeCounts = ["api": 3, "demo": 0]
        let queueCounts = ["api": 1, "demo": 4]
        let doneCounts = ["api": 2, "demo": 1]
        let underBacklog = TasksModel.groups(visible: all,
                                             activeCounts: activeCounts,
                                             queueCounts: queueCounts,
                                             storeIdByProject: [:],
                                             doneCounts: doneCounts,
                                             status: .backlog)
        XCTAssertEqual(underBacklog.map(\.project), ["demo", "api"])
        XCTAssertEqual(underBacklog.map(\.queueCount), [4, 1])
        XCTAssertEqual(underBacklog.map(\.doneCount), [1, 2])
        let underDone = TasksModel.groups(visible: all,
                                          activeCounts: activeCounts,
                                          queueCounts: queueCounts,
                                          storeIdByProject: [:],
                                          doneCounts: doneCounts,
                                          status: .done)
        XCTAssertEqual(underDone.map(\.project), ["api", "demo"],
                       "Done orders by done count (2 vs 1)")
        XCTAssertEqual(underDone.map(\.doneCount), [2, 1])
    }
}
