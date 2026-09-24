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
        // phren's message is the readable text; its data would only repeat it as JSON.
        XCTAssertEqual(readable, "Found 1 result(s).")
        XCTAssertFalse(readable.contains("\\\""), "No escaped JSON-in-JSON remains")
        XCTAssertEqual(PhrenToolPresentation.readable("plain prose, not JSON"), "plain prose, not JSON")
        XCTAssertEqual(PhrenToolPresentation.readable(#"{"content":[{"type":"text","text":"just text"}]}"#), "just text")
    }
}

extension PhrenToolPresentationTests {
    func testNestedAndTransportFailuresKeepTheirReasonAndRawText() throws {
        let results = [
            #"{"isError":true,"content":[{"type":"text","text":"Store is read-only.\nNo task saved."}]}"#,
            #"{"structuredContent":{"ok":false,"error":{"message":"Store is read-only."}}}"#,
            #"{"content":[{"type":"text","text":"Processing"},{"type":"text","text":"{\"ok\":false,\"error\":\"Store is read-only.\"}"}]}"#,
            #"{"ok":true,"data":{"added":["First task"],"errors":["Store is read-only."]}}"#
        ]
        for result in results {
            let card = try XCTUnwrap(PhrenToolPresentation(name: "mcp__phren__add_task", input: "{}", result: result))
            XCTAssertEqual(card.status, .failed, result)
            XCTAssertEqual(card.resultSummary, "Store is read-only.")
            XCTAssertEqual(card.rawResult, result)
            XCTAssertNil(card.target)
        }
        let failed = PhrenToolPresentation(name: "phren_session", input: "{}", result: "Connection closed.\nTry later.", isError: true)
        XCTAssertEqual(failed?.resultSummary, "Connection closed.")
        XCTAssertEqual(PhrenToolPresentation(name: "phren_session", input: "{}", isError: true)?.status, .failed)
        XCTAssertEqual(PhrenToolPresentation(name: "phren_session", input: "{}", result: "", isError: true)?.resultSummary, "Call failed")
        let recalled = PhrenToolPresentation(name: "phren_search_knowledge", input: "{}", result: #"{"ok":true,"data":{"results":[{"error":"A finding about errors"}]}}"#)
        XCTAssertEqual(recalled?.status, .succeeded)
    }

    func testExpandedInputAndEveryResultRemainComplete() throws {
        let long = String(repeating: "Keep this entire instruction.\n", count: 100) + "Final marker"
        let input = String(decoding: try JSONSerialization.data(withJSONObject: ["item": long]), as: UTF8.self)
        let task = try XCTUnwrap(PhrenToolPresentation(name: "phren_add_task", input: input))
        XCTAssertTrue(task.fullInput.contains(long))
        XCTAssertLessThan(task.body.count, long.count)
        XCTAssertEqual(PhrenToolPresentation.readable(#"{"content":[{"type":"text","text":"First"},{"type":"text","text":"Last"}]}"#), "First\n\nLast")
        let search = try XCTUnwrap(PhrenToolPresentation(name: "phren_search_knowledge", input: "{}", result: #"{"ok":true,"data":{"results":[{"title":"First"},{"title":"Second"},{"title":"Third"},{"title":"Fourth","content":"Full recalled text"}]}}"#))
        XCTAssertEqual(search.titles.count, 3)
        XCTAssertEqual(search.searchResults.count, 4)
        XCTAssertEqual(search.searchResults.last?.text, "Full recalled text")
        XCTAssertNil(PhrenToolPresentation(name: "phren_manage_task", input: #"{"action":"remove","item":"Old task"}"#, result: #"{"ok":true}"#)?.target)
    }

    func testFailedCallShowsItsIssuesNotItsParameterList() {
        let result = #"{"ok":false,"error":"Invalid arguments for update_task","issues":[{"path":"updates","message":"Invalid input: expected object, received string"}],"params":[{"name":"project","required":true}]}"#
        let card = PhrenToolPresentation(name: "mcp__phren__manage_task", input: #"{"action":"update","item":"bid:1"}"#, result: result)
        XCTAssertEqual(card?.status, .failed)
        XCTAssertEqual(card?.resultSummary, "Invalid arguments for update_task")
        XCTAssertEqual(card?.issues, ["updates: Invalid input: expected object, received string"])
    }
}
