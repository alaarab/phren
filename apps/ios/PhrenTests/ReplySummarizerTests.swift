import Foundation
import XCTest
@testable import Phren

final class ReplySummarizerTests: XCTestCase {
    private struct Fake: ReplySummaryGenerating {
        var available = true
        var output: String = "Merged the fix and the tests pass."
        var delay: Duration = .zero
        var fails = false
        func isAvailable() async -> Bool { available }
        func summarize(_ reply: String) async throws -> String {
            if delay > .zero { try await Task.sleep(for: delay) }
            if fails { throw OnDeviceGenerationError.unavailable }
            return output
        }
    }
    private let long = """
    ## Done
    Merged the sync fix. All 274 UI tests passed. The Hook is installed on both computers.
    ```
    pnpm test
    ```
    - build 143 is ready
    """

    func testShortPlainRepliesAreReadAsTheyAre() async {
        let summarizer = ReplySummarizer(generator: Fake(output: "should not be used"))
        let summary = await summarizer.summarize("Done, tests pass.")
        XCTAssertEqual(summary, "Done, tests pass.")
    }

    func testTheModelSummarizesALongReply() async {
        let summary = await ReplySummarizer(generator: Fake()).summarize(long)
        XCTAssertEqual(summary, "Merged the fix and the tests pass.")
    }

    func testNoModelFallsBackToTheFirstSentences() async {
        let summary = await ReplySummarizer(generator: Fake(available: false)).summarize(long)
        XCTAssertEqual(summary, "Done. Merged the sync fix.")
        let none = await ReplySummarizer(generator: nil).summarize(long)
        XCTAssertEqual(none, "Done. Merged the sync fix.")
    }

    func testAFailingOrStrayingModelFallsBack() async {
        let failed = await ReplySummarizer(generator: Fake(fails: true)).summarize(long)
        XCTAssertEqual(failed, "Done. Merged the sync fix.")
        let rambling = await ReplySummarizer(generator: Fake(output: String(repeating: "word ", count: 120))).summarize(long)
        XCTAssertEqual(rambling, "Done. Merged the sync fix.")
        let empty = await ReplySummarizer(generator: Fake(output: "  ")).summarize(long)
        XCTAssertEqual(empty, "Done. Merged the sync fix.")
    }

    func testMarkdownFromTheModelIsFlattened() async {
        let summary = await ReplySummarizer(generator: Fake(output: "**Merged** the `sync` fix.")).summarize(long)
        XCTAssertEqual(summary, "Merged the sync fix.")
    }

    func testUnreadableReplyIsNil() async {
        let summary = await ReplySummarizer(generator: Fake()).summarize("```\nonly code\n```")
        XCTAssertNil(summary)
    }
}
