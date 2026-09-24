import PhrenKit
import XCTest
@testable import Phren

final class PhrenToolCardModelTests: XCTestCase {
    private let store = "sample/brain"
    private func snapshot() -> LocalStore.Snapshot {
        var snapshot = LocalStore.Snapshot.empty
        snapshot.tasks["phone"] = TasksFile(project: "phone", content: "# Tasks\n## Queue\n- [ ] Verify pasted images <!-- bid:a1b2c3d4 -->\n").doc
        snapshot.findings["phone"] = FindingsFile(content: "# Findings\n## 2026-09-22\n- [pitfall] Keep the original image <!-- fid:b1c2d3e4 -->\n").parse()
        return snapshot
    }
    private func presentation(_ tool: String, _ input: String, result: String = #"{"ok":true}"#) throws -> PhrenToolPresentation {
        try XCTUnwrap(PhrenToolPresentation(name: "mcp__phren__" + tool, input: input, result: result))
    }
    func testTaskUsesExactTextOrStableIDWithinItsSourceStore() throws {
        for (tool, input) in [
            ("add_task", #"{"project":"phone","item":"Verify pasted images"}"#),
            ("manage_task", #"{"project":"phone","action":"complete","item":"bid:a1b2c3d4"}"#)
        ] {
            let card = try presentation(tool, input)
            let destination = PhrenToolCardModel.destination(card, sourceStore: store, snapshots: [store: snapshot()])
            guard case .task(let row) = destination else { return XCTFail("Expected a task destination") }
            XCTAssertEqual(row.task.stableId, "a1b2c3d4")
            XCTAssertEqual(row.storeId, store)
        }
    }
    func testUnresolvedAmbiguousAndOtherStoreTargetsHaveNoDestination() throws {
        for input in [
            #"{"project":"phone","item":"Not synced yet"}"#,
            #"{"project":"phone","item":"Q1"}"#,
            #"{"project":"phone","item":"Verify pasted images","store":"another/brain"}"#,
            #"{"project":"phone","id":"missing-id","item":"Verify pasted images"}"#
        ] {
            let card = try presentation("add_task", input)
            XCTAssertNil(PhrenToolCardModel.destination(card, sourceStore: store, snapshots: [store: snapshot()]))
        }
        let card = try presentation("add_task", #"{"project":"phone","item":"Verify pasted images"}"#)
        XCTAssertNil(PhrenToolCardModel.destination(card, sourceStore: nil, snapshots: [store: snapshot()]))
        var duplicate = snapshot()
        duplicate.tasks["phone"] = TasksFile(project: "phone", content: "# Tasks\n## Queue\n- [ ] Verify pasted images\n- [ ] Verify pasted images\n").doc
        XCTAssertNil(PhrenToolCardModel.destination(card, sourceStore: store, snapshots: [store: duplicate]))
    }
    func testFindingDossierUsesSyncedIdentityAndSearchUsesCapturedResults() throws {
        let finding = try presentation("revise_finding", #"{"project":"phone","finding_id":"fid:b1c2d3e4","text":"Keep the original image"}"#)
        guard case .finding(let resolvedStore, let project, let record) = PhrenToolCardModel.destination(finding, sourceStore: store, snapshots: [store: snapshot()]) else {
            return XCTFail("Expected a finding dossier")
        }
        XCTAssertEqual(resolvedStore, store); XCTAssertEqual(project, "phone")
        XCTAssertEqual(record.stableId, "b1c2d3e4")
        let search = try presentation("search_knowledge", #"{"query":"images"}"#, result: #"{"ok":true,"data":{"results":[{"title":"Fourth result"}]}}"#)
        guard case .search(let output) = PhrenToolCardModel.destination(search, sourceStore: nil, snapshots: [:]) else {
            return XCTFail("Captured results should remain available")
        }
        XCTAssertTrue(output.fullOutput?.contains("Fourth result") == true)
    }
    func testRepresentativeFailedResultsCannotShowSuccessOrNavigate() throws {
        let cases: [(String, String)] = [
            (#"{"ok":false,"error":"Store is read-only.\nNo task saved."}"#, "Store is read-only."),
            (#"{"isError":true,"content":[{"type":"text","text":"Store is read-only."}]}"#, "Store is read-only."),
            (#"{"content":[{"type":"text","text":"{\"ok\":false,\"error\":\"No matching task.\"}"}]}"#, "No matching task."),
            (#"{"structuredContent":{"ok":false,"error":{"message":"Permission denied."}}}"#, "Permission denied."),
            (#"{"content":[{"type":"text","text":"Processing"},{"type":"text","text":"{\"ok\":false,\"error\":\"Store unavailable.\"}"}]}"#, "Store unavailable.")
        ]
        for (result, reason) in cases {
            let card = try presentation("add_task", #"{"project":"phone","item":"Verify pasted images"}"#, result: result)
            XCTAssertEqual(card.status, .failed, result)
            XCTAssertEqual(card.resultSummary, reason)
            XCTAssertEqual(card.rawResult, result)
            XCTAssertNil(PhrenToolCardModel.destination(card, sourceStore: store, snapshots: [store: snapshot()]))
        }
        let transportError = PhrenToolPresentation(name: "mcp__phren__session", input: "{}", result: "Connection closed.\nTry later.", isError: true)
        XCTAssertEqual(transportError?.status, .failed)
        XCTAssertEqual(transportError?.resultSummary, "Connection closed.")
        let recalledError = try presentation("search_knowledge", "{}", result: #"{"ok":true,"data":{"results":[{"error":"A finding about errors"}]}}"#)
        XCTAssertEqual(recalledError.status, .succeeded)
    }
}
