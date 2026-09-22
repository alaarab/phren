import XCTest
@testable import PhrenKit

final class PhrenToolPresentationTests: XCTestCase {
    func testFindingTaskAndSessionVerbsUseHumanInput() throws {
        let finding = try XCTUnwrap(PhrenToolPresentation(name: "mcp__phren__add_finding", input: #"{"project":"phone","finding":"Keep the real image turn","findingType":"pitfall"}"#, result: #"{"ok":true}"#))
        XCTAssertEqual(finding.verb, "Save finding")
        XCTAssertEqual(finding.body, "Keep the real image turn")
        XCTAssertEqual(finding.project, "phone"); XCTAssertEqual(finding.tag, "pitfall")
        XCTAssertEqual(finding.status, .succeeded)
        let task = try XCTUnwrap(PhrenToolPresentation(name: "functions.mcp__phren__add_task", input: #"{"task":"Verify the queue"}"#))
        XCTAssertEqual(task.verb, "Add task"); XCTAssertEqual(task.body, "Verify the queue")
        XCTAssertEqual(task.status, .running)
        let done = try XCTUnwrap(PhrenToolPresentation(name: "mcp__phren__manage_task", input: #"{"action":"complete","item":"A2"}"#))
        XCTAssertEqual(done.verb, "Update task"); XCTAssertEqual(done.body, "A2")
        XCTAssertEqual(done.fields.first?.value, "complete")
        for (tool, input, verb) in [("session", #"{"action":"start"}"#, "Session"), ("session", #"{"action":"end"}"#, "Session"), ("phren_admin", #"{"action":"status"}"#, "status")] {
            XCTAssertEqual(PhrenToolPresentation(name: "mcp__phren__" + tool, input: input)?.verb, verb)
        }
    }

    func testSearchUnwrapsActualMCPEnvelopeAndBoundsTitles() throws {
        let response = #"{"ok":true,"data":{"count":7,"results":[{"title":"First"},{"snippet":"Second\nMore text"},{"filename":"Third.md"},{"title":"Hidden fourth"}]}}"#
        let wrapped = String(decoding: try JSONSerialization.data(withJSONObject: ["content": [["type": "text", "text": response]]]), as: UTF8.self)
        let search = try XCTUnwrap(PhrenToolPresentation(name: "mcp__phren__search_knowledge", input: #"{"query":"queue"}"#, result: wrapped))
        XCTAssertEqual(search.verb, "Search memory"); XCTAssertEqual(search.body, "queue")
        XCTAssertEqual(search.resultSummary, "7 memories found")
        XCTAssertEqual(search.titles, ["First", "Second", "Third.md"])
        let empty = PhrenToolPresentation(name: "mcp__phren__search_knowledge", input: "{}", result: #"{"ok":true,"data":{"results":[]}}"#)
        XCTAssertEqual(empty?.resultSummary, "0 memories found")
    }

    func testMemoryDetailFailureAndFutureToolsRemainReadable() throws {
        let detail = PhrenToolPresentation(name: "mcp__phren__get_memory_detail", input: #"{"id":"mem:42"}"#, result: #"{"ok":true,"data":{"content":"A memory title\nIts body"}}"#)
        XCTAssertEqual(detail?.body, "mem:42"); XCTAssertEqual(detail?.resultSummary, "A memory title")
        let failure = PhrenToolPresentation(name: "mcp__phren__add_task", input: "{}", result: #"{"ok":false,"error":"Store is read-only"}"#)
        XCTAssertEqual(failure?.status, .failed); XCTAssertEqual(failure?.resultSummary, "Store is read-only")
        XCTAssertEqual(PhrenToolPresentation(name: "mcp__phren__add_task", input: "{}", result: "Denied", isError: true)?.status, .failed)
        let future = try XCTUnwrap(PhrenToolPresentation(name: "mcp__phren__future_tool", input: #"{"project":"phone","scope":{"type":"team"},"values":["one","two"]}"#))
        XCTAssertEqual(future.fields.map(\.value), ["type: team", "one, two"])
        XCTAssertFalse(future.fields.contains { $0.value.contains("{") })
        XCTAssertNotNil(PhrenToolPresentation(name: "mcp__phren__future_tool", input: "broken JSON"))
        XCTAssertNil(PhrenToolPresentation(name: "mcp__other__add_task", input: "{}"))
    }

    func testLongFindingPreviewIsBoundedWithoutModifyingInput() throws {
        let text = String(repeating: "Long finding. ", count: 1_000)
        let input = String(decoding: try JSONSerialization.data(withJSONObject: ["finding": text]), as: UTF8.self)
        XCTAssertEqual(PhrenToolPresentation(name: "mcp__phren__add_finding", input: input)?.body, String(text.prefix(1_200)).trimmingCharacters(in: .whitespacesAndNewlines))
    }
}

extension PhrenToolPresentationTests {
    func testReadableUnwrapsContentBlocksAndPrettyPrintsPhrenResults() {
        let inner = #"{"ok":true,"data":{"count":1,"results":[{"title":"Interactive back"}]},"message":"Found 1 result(s)."}"#
        let raw = #"{"content":[{"type":"text","text":"\#(inner.replacingOccurrences(of: "\"", with: "\\\""))"}]}"#
        let readable = PhrenToolPresentation.readable(raw)
        XCTAssertTrue(readable.hasPrefix("Found 1 result(s).\n\n{"), readable)
        XCTAssertTrue(readable.contains("\"title\" : \"Interactive back\""), readable)
        XCTAssertFalse(readable.contains("\\\""), "No escaped JSON-in-JSON remains")
        XCTAssertEqual(PhrenToolPresentation.readable("plain prose, not JSON"), "plain prose, not JSON")
        XCTAssertEqual(PhrenToolPresentation.readable(#"{"content":[{"type":"text","text":"just text"}]}"#), "just text")
    }
}
