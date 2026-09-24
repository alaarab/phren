import XCTest
@testable import PhrenKit

final class ReplySummaryTests: XCTestCase {
    func testKeepsTheFirstTwoSentencesOfPlainProse() {
        let reply = "Merged the fix. All 274 UI tests passed. Build 143 is ready to upload. I also cleaned the worktree."
        XCTAssertEqual(ReplySummary.fallback(reply), "Merged the fix. All 274 UI tests passed.")
    }

    func testDropsCodeTablesAndMarkdown() {
        let reply = """
        ## Done

        **Merged** the `sync` fix into [main](https://example.com/pr/1).

        ```swift
        let x = 1
        ```

        | Suite | Result |
        |---|---|
        | UI | pass |

        - Tests pass
        - Hook installed
        """
        XCTAssertEqual(ReplySummary.fallback(reply), "Done. Merged the sync fix into main.")
    }

    func testBulletsBecomeSeparateSentences() {
        XCTAssertEqual(ReplySummary.fallback("- first thing\n- second thing\n- third"), "first thing. second thing.")
    }

    func testVersionNumbersAndPathsDoNotEndASentence() {
        XCTAssertEqual(ReplySummary.fallback("Installed Hook 0.2.14 in dist/bridge-hook.mjs today. Canary passed. Next."),
                       "Installed Hook 0.2.14 in dist/bridge-hook.mjs today. Canary passed.")
    }

    func testOneLongSentenceIsClippedAtAWord() throws {
        let reply = String(repeating: "word ", count: 80)
        let summary = try XCTUnwrap(ReplySummary.fallback(reply, limit: 40))
        XCTAssertLessThanOrEqual(summary.count, 41)
        XCTAssertTrue(summary.hasSuffix("word…"))
    }

    func testNothingReadableIsNil() {
        XCTAssertNil(ReplySummary.fallback("```\ncode only\n```"))
        XCTAssertNil(ReplySummary.fallback("   \n "))
    }

    func testNeedsSummary() {
        XCTAssertFalse(ReplySummary.needsSummary("Done, tests pass."))
        XCTAssertTrue(ReplySummary.needsSummary("One. Two. Three."))
        XCTAssertTrue(ReplySummary.needsSummary("Here:\n```\nx\n```"))
        XCTAssertTrue(ReplySummary.needsSummary(String(repeating: "a ", count: 200)))
    }
}
