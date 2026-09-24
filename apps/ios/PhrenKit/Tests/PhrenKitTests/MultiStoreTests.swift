import XCTest
@testable import PhrenKit

final class MultiStoreTests: XCTestCase {
    private func makeStore(_ name: String) async throws -> (LocalStore, URL) {
        let dir = FileManager.default.temporaryDirectory
            .appendingPathComponent("phren-multistore-\(name)-\(UUID().uuidString)")
        let store = try LocalStore(rootDirectory: dir, owner: "o", repo: name, branch: "main")
        return (store, dir)
    }

    func testSearchIndexAttributesStores() async throws {
        let (storeA, dirA) = try await makeStore("a")
        let (storeB, dirB) = try await makeStore("b")
        defer {
            try? FileManager.default.removeItem(at: dirA)
            try? FileManager.default.removeItem(at: dirB)
        }

        try await storeA.write("proj/FINDINGS.md",
                               content: try Fixtures.text("findings-after-remove.md"), blobSha: nil)
        try await storeB.write("proj/tasks.md",
                               content: try Fixtures.text("tasks-after-update.md"), blobSha: nil)

        let index = SearchIndex(snapshots: [
            (store: "personal", snapshot: await storeA.snapshot()),
            (store: "team", snapshot: await storeB.snapshot()),
        ])

        let jwt = index.search("jwt expiry")
        XCTAssertEqual(jwt.first?.store, "personal")

        let flaky = index.search("flaky")
        XCTAssertEqual(flaky.first?.store, "team")

        // Store filter scopes results.
        XCTAssertTrue(index.search("jwt", store: "team").isEmpty)
        XCTAssertFalse(index.search("jwt", store: "personal").isEmpty)

        // Same project name in both stores → doc ids stay distinct.
        XCTAssertNotEqual(jwt.first?.id, flaky.first?.id)
    }

    func testReviewQueueOrderSharedComparator() {
        func item(_ id: String, project: String, section: QueueItem.Section, date: String) -> ProjectQueueItem {
            ProjectQueueItem(project: project, item: QueueItem(
                id: id, section: section, date: date, text: "t", line: "- [\(date)] t",
                confidence: nil, risky: section != .review, machine: nil, model: nil
            ))
        }

        // Cross-store merge sorts exactly like a single store: section order
        // (Review < Stale < Conflicts), then date desc, then project, then id.
        let merged = [
            item("M1", project: "zeta", section: .stale, date: "2026-07-20"),
            item("M1", project: "alpha", section: .review, date: "2026-07-10"),
            item("M2", project: "beta", section: .review, date: "2026-07-15"),
            item("M1", project: "beta", section: .review, date: "2026-07-15"),
            item("M1", project: "gamma", section: .conflicts, date: "2026-07-25"),
        ].sorted(by: LocalStore.reviewQueueOrder)

        XCTAssertEqual(
            merged.map { "\($0.item.section.rawValue)/\($0.project)/\($0.item.id)" },
            [
                "Review/beta/M1",
                "Review/beta/M2",
                "Review/alpha/M1",
                "Stale/zeta/M1",
                "Conflicts/gamma/M1",
            ]
        )
    }

    func testStoreDescriptorDecodesLegacySelectedRepoJSON() throws {
        // The pre-multi-store app persisted {owner, name, branch} under
        // "phren.selected-repo"; migration decodes it as a StoreDescriptor
        // with canPush defaulting to true.
        let legacy = Data(#"{"owner":"alaarab","name":"phren-store","branch":"main"}"#.utf8)
        let decoded = try JSONDecoder().decode(StoreDescriptor.self, from: legacy)
        XCTAssertEqual(decoded.owner, "alaarab")
        XCTAssertEqual(decoded.branch, "main")
        XCTAssertTrue(decoded.canPush)
    }
}
