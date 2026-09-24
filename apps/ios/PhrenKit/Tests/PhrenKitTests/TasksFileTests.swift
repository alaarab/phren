import XCTest
@testable import PhrenKit

final class TasksFileTests: XCTestCase {
    func testParseMatchesCLI() throws {
        let file = TasksFile(project: "myproj", content: try Fixtures.text("tasks-after-update.md"))
        guard let expected = try Fixtures.json("tasks-parsed.json") as? [String: Any],
              let items = expected["items"] as? [String: [[String: Any]]] else {
            return XCTFail("bad tasks-parsed.json")
        }

        XCTAssertEqual(file.doc.title, expected["title"] as? String)
        for (sectionName, section) in [("Active", PhrenTask.Section.active),
                                       ("Queue", .queue), ("Done", .done)] {
            let actual = file.doc.items(in: section)
            let exp = items[sectionName] ?? []
            XCTAssertEqual(actual.count, exp.count, sectionName)
            for (item, e) in zip(actual, exp) {
                XCTAssertEqual(item.id, e["id"] as? String)
                XCTAssertEqual(item.stableId, e["stableId"] as? String)
                XCTAssertEqual(item.line, e["line"] as? String)
                XCTAssertEqual(item.checked, e["checked"] as? Bool)
                XCTAssertEqual(item.priority?.rawValue, e["priority"] as? String)
                XCTAssertEqual(item.rank, e["rank"] as? Int)
                XCTAssertEqual(item.createdAt, e["createdAt"] as? String)
            }
        }
    }

    func testRenderRoundTripsCLIFile() throws {
        let content = try Fixtures.text("tasks-after-update.md")
        let file = TasksFile(project: "myproj", content: content)
        assertSameContent(file.render(), content, "tasks round-trip")
    }

    func testCompleteMatchesCLIByteForByte() throws {
        var file = TasksFile(project: "myproj", content: try Fixtures.text("tasks-after-add.md"))
        try file.complete("Write fixture generator")
        assertSameContent(file.render(), try Fixtures.text("tasks-after-complete.md"), "complete")
    }

    func testUpdateMatchesCLIByteForByte() throws {
        var file = TasksFile(project: "myproj", content: try Fixtures.text("tasks-after-complete.md"))
        try file.update("Investigate flaky sync test", updates: .init(
            text: "Investigate flaky sync test on CI",
            priority: .medium,
            section: .active
        ))
        assertSameContent(file.render(), try Fixtures.text("tasks-after-update.md"), "update")
    }

    func testAddAppendsToQueueWithFreshBid() throws {
        var file = TasksFile(project: "myproj", content: try Fixtures.text("tasks-after-update.md"))
        let added = try file.add("New mobile task [high]")
        XCTAssertEqual(added.section, .queue)
        XCTAssertEqual(added.priority, .high)
        XCTAssertNotNil(added.stableId)
        let created = try XCTUnwrap(added.createdAt)
        let date = try Date(created, strategy: Date.ISO8601FormatStyle(includingFractionalSeconds: true))
        XCTAssertLessThan(abs(date.timeIntervalSinceNow), 5)

        let reparsed = TasksFile(project: "myproj", content: file.render())
        XCTAssertEqual(reparsed.doc.queue.first { $0.stableId == added.stableId }?.createdAt, created)
    }

    func testEditingAndCompletingPreserveCreationDatesWithoutDatingLegacyTasks() throws {
        var file = TasksFile(project: "demo", content: "# Tasks\n\n## Queue\n- [ ] Old undated task <!-- bid:12345678 -->\n")
        let added = try file.add("Dated task", createdAt: "2020-03-04T12:34:56.789Z")
        try file.update(added.stableId!, updates: .init(text: "Renamed", section: .active))
        try file.complete(added.stableId!)
        try file.complete("12345678")
        let done = TasksFile(project: "demo", content: file.render()).doc.done
        XCTAssertEqual(done.first { $0.stableId == added.stableId }?.createdAt, "2020-03-04T12:34:56.789Z")
        XCTAssertNil(done.first { $0.stableId == "12345678" }?.createdAt)
    }

    func testMatchByBidAndPositionalId() throws {
        var file = TasksFile(project: "myproj", content: try Fixtures.text("tasks-after-update.md"))
        let target = file.doc.active[0]
        let completed = try file.complete(target.stableId!)
        XCTAssertEqual(completed.stableId, target.stableId)

        var file2 = TasksFile(project: "myproj", content: try Fixtures.text("tasks-after-update.md"))
        let byPositional = try file2.complete("A1")
        XCTAssertEqual(byPositional.stableId, target.stableId)
    }

    func testPriorityTagAccumulationStripped() {
        // tasks.ts:65 — accumulated priority tags all get stripped on render.
        XCTAssertEqual(TasksFile.stripPriorityTag("Fix bug [high] [high] [high]"), "Fix bug")
        XCTAssertEqual(TasksFile.stripPriorityTag("Fix bug [high] [pinned]"), "Fix bug [pinned]")
    }

    func testContinuationLines() throws {
        let content = """
        # myproj tasks

        ## Queue

        - [ ] Task with extras <!-- bid:12ab34cd rank:1 -->
          Context: some background
          GitHub: #42 https://github.com/owner/repo/issues/42
        """
        let file = TasksFile(project: "myproj", content: content)
        let item = file.doc.queue[0]
        XCTAssertEqual(item.context, "some background")
        XCTAssertEqual(item.githubIssue, 42)
        XCTAssertEqual(item.githubUrl, "https://github.com/owner/repo/issues/42")

        // And they render back out.
        let rendered = file.render()
        XCTAssertTrue(rendered.contains("  Context: some background"))
        XCTAssertTrue(rendered.contains("  GitHub: #42 https://github.com/owner/repo/issues/42"))
    }
}
