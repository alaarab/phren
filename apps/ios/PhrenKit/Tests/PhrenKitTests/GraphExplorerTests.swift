import XCTest
@testable import PhrenKit

final class GraphExplorerTests: XCTestCase {
    func testConnectionFocusTraversesEitherDirectionWithoutUnrelatedProjects() throws {
        let graph = GraphBuilder.build(.init(
            findingsMarkdown: ["demo": "- [pattern] Integrates with other", "other": "- [decision] Keep local memory", "unrelated": "- [pattern] Standalone"],
            tasks: [:], projects: ["demo", "other", "unrelated"], storeName: "o/r"
        ))
        let leaf = try XCTUnwrap(graph.nodes.first { $0.project == "demo" && $0.group != "project" })
        XCTAssertEqual(Set(graph.neighborhood(of: leaf.id).nodes.map(\.id)), [leaf.id, "demo"])
        let twoSteps = graph.neighborhood(of: leaf.id, steps: 2)
        XCTAssertTrue(twoSteps.nodes.contains { $0.id == "other" })
        XCTAssertFalse(twoSteps.nodes.contains { $0.project == "unrelated" })
        XCTAssertTrue(graph.neighborhood(of: "other").nodes.contains { $0.id == "demo" }, "Edges are traversable in reverse")
        XCTAssertEqual(graph.neighborhood(of: "deleted"), graph)
        let ids = Set(twoSteps.nodes.map(\.id))
        XCTAssertTrue(twoSteps.links.allSatisfy { ids.contains($0.source) && ids.contains($0.target) })
    }

    func testSavedViewsRoundTripStoreAndFilterWithoutCrossStoreIdentityLoss() throws {
        let first = GraphSavedView(name: "Work", storeID: "work/brain", project: "demo", filter: .tasks, nodeID: "demo", steps: 2)
        let second = GraphSavedView(name: "Personal", storeID: "me/brain", project: "demo", filter: .findings, nodeID: "demo")
        let loaded = try JSONDecoder().decode([GraphSavedView].self, from: JSONEncoder().encode([first, second]))
        XCTAssertEqual(loaded, [first, second])
        XCTAssertNotEqual(loaded[0].storeID, loaded[1].storeID)
    }

    func testTaskOnlyProjectAppearsAndFocusedGraphLiftsTaskCap() throws {
        var tasks = TasksFile(project: "demo", content: nil)
        for index in 1...60 { try tasks.add("Investigate task \(index)") }
        let input = GraphBuilder.Input(findingsMarkdown: [:], tasks: ["demo": tasks.doc],
                                       projects: ["demo"], storeName: "owner/brain")
        let overview = GraphBuilder.build(input)
        let focused = GraphBuilder.build(input, focusProject: "demo")
        XCTAssertEqual(overview.nodes.filter { $0.group.hasPrefix("task-") }.count, 50)
        XCTAssertEqual(focused.nodes.filter { $0.group.hasPrefix("task-") }.count, 60)
        XCTAssertEqual(focused.nodes.first { $0.group == "project" }?.taskCount, 60)
        XCTAssertEqual(focused.links.count, 60)
    }

    func testFiltersRetainHubsAndNeverLeaveDanglingLinks() throws {
        var tasks = TasksFile(project: "demo", content: nil)
        try tasks.add("Review app build")
        let graph = GraphBuilder.build(.init(
            findingsMarkdown: ["demo": "- [pattern] Cache repeated requests"],
            tasks: ["demo": tasks.doc], projects: ["demo"], storeName: "owner/brain"
        ))
        for filter in GraphPayload.ContentFilter.allCases {
            let filtered = graph.filtered(by: filter)
            let ids = Set(filtered.nodes.map(\.id))
            XCTAssertTrue(filtered.links.allSatisfy { ids.contains($0.source) && ids.contains($0.target) })
            XCTAssertEqual(filtered.nodes.filter { $0.group == "project" }.count, 1)
            if filter == .tasks { XCTAssertFalse(filtered.nodes.contains { $0.group.hasPrefix("topic:") }) }
            if filter == .findings { XCTAssertFalse(filtered.nodes.contains { $0.group.hasPrefix("task-") }) }
            XCTAssertEqual(filtered.total, filtered.nodes.count)
        }
    }

    func testSearchMatchesFullTextAndProjectWithWhitespaceAndCase() {
        let graph = GraphBuilder.build(.init(
            findingsMarkdown: ["demo": "- [pattern] Cache repeated requests for offline use"],
            tasks: [:], projects: ["demo"], storeName: "owner/brain"
        ))
        XCTAssertEqual(graph.search("  DEMO  offline \n").count, 1)
        XCTAssertEqual(graph.search("pattern cache").count, 1)
        XCTAssertTrue(graph.search("  \n").isEmpty)
        XCTAssertTrue(graph.search("unrelated").isEmpty)
    }

    func testLocalGraphIncludesJournalAndInstructionOnlyProjects() async throws {
        let root = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        defer { try? FileManager.default.removeItem(at: root) }
        let store = try LocalStore(rootDirectory: root, owner: "o", repo: "r", branch: "main")
        try await store.write("demo/AGENTS.md", content: "# Instructions", blobSha: nil)
        try await store.write("team/journal/2026-07-28-tester.md",
                              content: try Fixtures.text("journal-2026-07-28-tester.md"), blobSha: nil)
        let input = await store.graphInput(storeName: "o/r")
        let graph = GraphBuilder.build(input)
        XCTAssertTrue(graph.nodes.contains { $0.id == "demo" && $0.group == "project" })
        let journalNodes = graph.nodes.filter { $0.id.hasPrefix("journal:") }
        XCTAssertFalse(journalNodes.isEmpty)
        XCTAssertTrue(journalNodes.allSatisfy { $0.scoreKey == nil && $0.project == "team" })
        XCTAssertTrue(graph.nodes.allSatisfy { $0.store == "o/r" })
        XCTAssertEqual(Set(graph.nodes.map(\.id)).count, graph.nodes.count)
        XCTAssertEqual(graph.nodes.first { $0.id == "team" }?.findingCount, journalNodes.count)
    }

    func testArchiveIsExcludedFromLocalGraphWithoutChangingLiveScoreKeys() async throws {
        let root = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        defer { try? FileManager.default.removeItem(at: root) }
        let store = try LocalStore(rootDirectory: root, owner: "o", repo: "r", branch: "main")
        let content = try Fixtures.text("findings-legacy-details-archive.md")
        try await store.write("demo/FINDINGS.md", content: content, blobSha: nil)
        let input = await store.graphInput(storeName: "o/r")
        let graph = GraphBuilder.build(input)
        let file = FindingsFile(content: content)
        let archived = file.parse(includeArchived: true).filter(\.archived)
        XCTAssertFalse(archived.isEmpty)
        for finding in archived {
            XCTAssertFalse(graph.nodes.contains { $0.fullLabel == finding.text })
        }
        for node in graph.nodes where node.group.hasPrefix("topic:") {
            let key = try XCTUnwrap(node.scoreKey)
            let resolved = await store.findingBulletText(project: "demo", scoreKey: key)
            XCTAssertNotNil(resolved, "Live nodes still resolve back to their source bullets")
        }
    }
}

final class GraphProjectCountTests: XCTestCase {
    func testArchivedCountComesFromTheSummaryLine() {
        XCTAssertEqual(LocalStore.archivedFindingCount("## What phren knows\n\n- 20 active findings, 1,600 archived across 17 topics, 3 open tasks."), 1600)
        XCTAssertEqual(LocalStore.archivedFindingCount("- 5 active findings, 0 archived across 0 topics."), 0)
        XCTAssertNil(LocalStore.archivedFindingCount("A project without the generated block."))
    }

    func testProjectLabelsCountWhatTheFilterShowsInFull() {
        let tasks = TasksFile(project: "api", content: "# t\n\n## Active\n\n- [ ] one\n\n## Queue\n\n- [ ] two\n- [ ] three\n\n## Done\n\n- [x] old\n").doc
        let input = GraphBuilder.Input(findingsMarkdown: ["api": "## 2026-09-22\n- [pattern] recent finding that is long enough to count"],
                                       tasks: ["api": tasks], projects: ["api"], storeName: "s",
                                       findingTotals: ["api": 925])
        let payload = GraphBuilder.build(input)
        let project = { (p: GraphPayload) in p.nodes.first { $0.group == "project" && $0.id == "api" } }
        XCTAssertEqual(project(payload.filtered(by: .findings))?.labelCount, 925, "every finding, archive included")
        XCTAssertEqual(project(payload.filtered(by: .all))?.labelCount, 925)
        XCTAssertEqual(project(payload.filtered(by: .tasks))?.labelCount, 3, "open tasks, done ones excluded")
    }
}
