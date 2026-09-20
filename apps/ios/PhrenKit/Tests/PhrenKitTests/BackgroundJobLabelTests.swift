import XCTest
@testable import PhrenKit

final class BackgroundJobLabelTests: XCTestCase {
    func testParsesDoubleQuotedCodexLabel() throws {
        let result = try XCTUnwrap(BackgroundJobLabel.parse(
            command: #"cat p.txt | ~/.phren/global/skills/codex/scripts/run.sh --label "Per-computer color for session cards" --worktree /tmp/wt"#
        ))
        XCTAssertEqual(result.provider, "codex")
        XCTAssertEqual(result.label, "Per-computer color for session cards")
    }

    func testParsesSingleQuotedDeepSeekLabelAsOpenCode() throws {
        let result = try XCTUnwrap(BackgroundJobLabel.parse(
            command: "~/.phren/global/skills/deepseek/scripts/run.sh --label 'Review the release notes'"
        ))
        XCTAssertEqual(result.provider, "opencode")
        XCTAssertEqual(result.label, "Review the release notes")
    }

    func testRejectsWorkerCommandWithoutLabel() {
        XCTAssertNil(BackgroundJobLabel.parse(
            command: "~/.phren/global/skills/codex/scripts/run.sh --worktree /tmp/wt"
        ))
    }

    func testRejectsUnrelatedLabeledCommand() {
        XCTAssertNil(BackgroundJobLabel.parse(
            command: #"./scripts/run.sh --label "Unrelated worker""#
        ))
    }
}
