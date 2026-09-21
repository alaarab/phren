import PhrenKit
import XCTest
@testable import Phren

final class MemoryBrowsingTests: XCTestCase {
    private let store = "sample/brain"

    private func snapshot() -> LocalStore.Snapshot {
        var snapshot = LocalStore.Snapshot.empty
        snapshot.projects = [Project(name: "ledger"), Project(name: "phren")]
        snapshot.findings = [
            "ledger": FindingsFile(content: """
            # Findings

            ## 2026-09-16

            - [pitfall] Keys are scoped per merchant <!-- fid:1a2b3c4d -->

            ## 2026-09-11

            - [decision] The ledger is append-only <!-- fid:2b3c4d5e -->
            - A plain finding without any tag at all <!-- fid:3c4d5e6f -->
            """).parse(),
            "phren": FindingsFile(content: """
            # Findings

            ## 2026-09-19

            - [pattern] Rows are one flat rectangle <!-- fid:a0000005 -->
            """).parse(),
        ]
        snapshot.tasks = ["ledger": TasksFile(project: "ledger", content: """
        # ledger tasks

        ## Active

        - [ ] Backfill merchant ids [high] <!-- bid:70a7b8c9 created:2026-09-16T12:00:00.000Z -->

        ## Queue

        - [ ] Retire the shim <!-- bid:80b8c9d0 -->

        ## Done

        - [x] Batch line items <!-- bid:90c9d0e1 -->
        """).doc]
        snapshot.notes = ["phren": NotesFile(project: "phren", date: "2026-09-18", content: """
        ## 09:12 <!-- nid:aa11bb22 -->

        Ship Memory first.

        ## 14:40 <!-- nid:cc33dd44 -->

        Retest the graph.
        """).notes]
        return snapshot
    }

    private func payload(_ snapshot: LocalStore.Snapshot) -> GraphPayload {
        let markdown = snapshot.findings.mapValues { findings in
            findings.map { "## \($0.date)\n\($0.rawLine)" }.joined(separator: "\n")
        }
        return GraphBuilder.build(GraphBuilder.Input(
            findingsMarkdown: markdown, tasks: snapshot.tasks,
            projects: snapshot.projects.map(\.name), storeName: store
        ))
    }

    private func contents(project: String? = nil) -> [MemoryItem] {
        let snapshot = snapshot()
        let nodes = MemoryBrowsing.NodeIndex(payload: payload(snapshot))
        return MemoryBrowsing.contents(snapshot: snapshot, storeId: store, project: project, nodes: nodes)
    }

    func testContentsListFindingsNewestFirstThenNotesTasksAndTopics() {
        let items = contents()
        XCTAssertEqual(items.map(\.id), [
            "finding:a0000005", "finding:1a2b3c4d", "finding:2b3c4d5e", "finding:3c4d5e6f",
            "note:cc33dd44", "note:aa11bb22",
            "task:70a7b8c9", "task:80b8c9d0", "task:90c9d0e1",
            "topic:decision", "topic:general", "topic:pattern", "topic:pitfall",
        ])
        XCTAssertEqual(items[1].text, "Keys are scoped per merchant", "the tag leaves the text for its chip")
        XCTAssertEqual(items[1].typeTag, "pitfall")
        XCTAssertEqual(items[3].typeTag, nil)
        XCTAssertEqual(items[6].text, "Backfill merchant ids", "priority tags leave the task text")
        XCTAssertEqual(items[6].section, .active)
        XCTAssertEqual(items[6].date, "2026-09-16")
        XCTAssertEqual(items[12].detail, "1 finding")
        XCTAssertEqual(items[9].detail, "1 finding")
    }

    func testRowsResolveToTheGraphNodesTheRendererDraws() {
        let items = contents()
        let byID = Dictionary(uniqueKeysWithValues: items.map { ($0.id, $0) })
        XCTAssertNotNil(byID["finding:1a2b3c4d"]?.nodeID)
        XCTAssertEqual(byID["finding:1a2b3c4d"]?.nodeID?.hasPrefix("finding:"), true)
        XCTAssertNotNil(byID["finding:3c4d5e6f"]?.nodeID, "an untagged finding is a node too")
        XCTAssertEqual(byID["task:70a7b8c9"]?.nodeID, "ledger:task:A1")
        XCTAssertEqual(byID["task:80b8c9d0"]?.nodeID, "ledger:task:Q1")
        XCTAssertNil(byID["task:90c9d0e1"]?.nodeID, "done tasks are not drawn")
        XCTAssertNil(byID["note:aa11bb22"]?.nodeID, "notes are not drawn")
    }

    func testProjectScopeAndCountsLine() {
        XCTAssertEqual(MemoryBrowsing.counts(contents()).line, "4 findings · 3 tasks · 4 topics")
        let ledger = contents(project: "ledger")
        XCTAssertEqual(MemoryBrowsing.counts(ledger).line, "3 findings · 3 tasks · 3 topics")
        XCTAssertTrue(ledger.allSatisfy { $0.project == "ledger" || $0.kind == .topic })
        XCTAssertTrue(MemoryBrowsing.counts([]).isEmpty)
        XCTAssertEqual(MemoryCounts(findings: 1, notes: 0, tasks: 1, topics: 1).line, "1 finding · 1 task · 1 topic")
        XCTAssertEqual(MemoryCounts(findings: 4, notes: 2, tasks: 3, topics: 4).line(for: []), "4 findings · 3 tasks · 4 topics")
        XCTAssertEqual(MemoryCounts(findings: 4, notes: 2, tasks: 3, topics: 4).line(for: [.findings]), "4 findings")
        XCTAssertEqual(MemoryCounts(findings: 4, notes: 2, tasks: 3, topics: 4).line(for: [.notes]), "2 notes")
    }

    func testKindsFilterAndGraphFilterFollowTheSelection() {
        let items = contents()
        XCTAssertEqual(MemoryBrowsing.filter(items, kinds: []).count, 13, "every kind is in view")
        XCTAssertEqual(MemoryBrowsing.filter(items, kinds: Set(MemoryKind.allCases)).count, 13)
        XCTAssertEqual(MemoryBrowsing.filter(items, kinds: [.findings]).count, 4)
        XCTAssertEqual(MemoryBrowsing.filter(items, kinds: [.notes]).count, 2)
        XCTAssertEqual(MemoryBrowsing.filter(items, kinds: [.tasks]).count, 3)
        XCTAssertEqual(MemoryBrowsing.filter(items, kinds: [.topics]).count, 4)
        XCTAssertEqual(MemoryBrowsing.filter(items, kinds: [.findings, .tasks]).map(\.kind).filter { $0 == .note }.count, 0)

        XCTAssertEqual(MemoryBrowsing.graphFilter(kinds: []), .all)
        XCTAssertEqual(MemoryBrowsing.graphFilter(kinds: [.findings]), .findings)
        XCTAssertEqual(MemoryBrowsing.graphFilter(kinds: [.topics]), .findings)
        XCTAssertEqual(MemoryBrowsing.graphFilter(kinds: [.tasks]), .tasks)
        XCTAssertEqual(MemoryBrowsing.graphFilter(kinds: [.findings, .tasks]), .all)
        XCTAssertEqual(MemoryBrowsing.graphFilter(kinds: [.notes]), .all)
    }

    func testResultsMapIndexHitsOntoRowsAndAddProjectsFromTheGraph() {
        let snapshot = snapshot()
        let graph = payload(snapshot)
        let rows = MemoryBrowsing.contents(snapshot: snapshot, storeId: store, project: nil,
                                           nodes: MemoryBrowsing.NodeIndex(payload: graph))
        let hits = SearchIndex(snapshot: snapshot).search("merchant")
        let results = MemoryBrowsing.results(hits: hits, graphMatches: graph.search("ledger"), contents: rows, storeId: store)
        XCTAssertEqual(Set(results.map(\.id)), ["finding:1a2b3c4d", "task:70a7b8c9", "project:ledger"])
        XCTAssertTrue(results.allSatisfy { $0.nodeID != nil }, "each result knows its node")
        XCTAssertEqual(results.last?.kind, .project)
        XCTAssertEqual(results.last?.detail, "3 findings · 2 tasks")
        let grouped = MemoryBrowsing.grouped(results)
        XCTAssertEqual(grouped.map(\.project), ["ledger"])
        XCTAssertEqual(MemoryBrowsing.results(hits: [], graphMatches: [], contents: rows, storeId: store), [])
    }

    func testFreshnessReadsTheStoreStatus() {
        let now = Date(timeIntervalSince1970: 1_800_000_000)
        XCTAssertTrue(MemoryFreshness().isStale(now: now))
        XCTAssertEqual(MemoryFreshness().text(now: now), "not synced")
        let fresh = MemoryFreshness(lastSyncedAt: now.addingTimeInterval(-120))
        XCTAssertFalse(fresh.isStale(now: now))
        XCTAssertEqual(fresh.text(now: now), "updated 2m ago")
        let stale = MemoryFreshness(lastSyncedAt: now.addingTimeInterval(-25 * 60))
        XCTAssertTrue(stale.isStale(now: now))
        XCTAssertEqual(stale.text(now: now), "updated 25m ago")
        XCTAssertEqual(MemoryFreshness(lastSyncedAt: now.addingTimeInterval(-3 * 3600)).text(now: now), "updated 3h ago")
        XCTAssertFalse(MemoryFreshness(isSyncing: true).isStale(now: now))
        XCTAssertEqual(MemoryFreshness(isSyncing: true).text(now: now), "syncing")
        XCTAssertEqual(MemoryFreshness(hasError: true).text(now: now), "sync error")
    }

}
