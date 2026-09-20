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

    func testParsesTheFanoutLauncherByProvider() throws {
        let codex = try XCTUnwrap(BackgroundJobLabel.parse(
            command: #"cat p.txt | ~/.phren/global/skills/fanout/scripts/run.sh --provider codex --model gpt-6-astra --label "Astra cleanup" --worktree /tmp/wt"#
        ))
        XCTAssertEqual(codex.provider, "codex")
        XCTAssertEqual(codex.label, "Astra cleanup")
        let go = try XCTUnwrap(BackgroundJobLabel.parse(
            command: "~/.phren/global/skills/fanout/scripts/run.sh --label 'Go worker' --provider opencode --model opencode-go/kimi-k3 --worktree /tmp/wt"
        ))
        XCTAssertEqual(go.provider, "opencode")
        XCTAssertEqual(go.label, "Go worker")
        let direct = try XCTUnwrap(BackgroundJobLabel.parse(
            command: #"~/.phren/global/skills/fanout/scripts/opencode.sh --label "Direct" --worktree /tmp/wt --model openrouter/x/y"#
        ))
        XCTAssertEqual(direct.provider, "opencode")
        XCTAssertNil(BackgroundJobLabel.parse(command: #"~/.phren/global/skills/fanout/scripts/run.sh --label "No provider" --worktree /tmp/wt"#))
    }

    func testRejectsALabelTheShellHadNotExpanded() {
        // A loop launching several workers passes the label as a variable;
        // the raw text is not a name the person should see.
        XCTAssertNil(BackgroundJobLabel.parse(
            command: #"for n in a b; do cat $S/$n.txt | ~/.phren/global/skills/deepseek/scripts/run.sh --label "${L[$n]}" --worktree $S/wt/$n; done"#
        ))
        XCTAssertNil(BackgroundJobLabel.parse(
            command: #"~/.phren/global/skills/codex/scripts/run.sh --label "$(cat title.txt)""#
        ))
    }

    func testRejectsUnrelatedLabeledCommand() {
        XCTAssertNil(BackgroundJobLabel.parse(
            command: #"./scripts/run.sh --label "Unrelated worker""#
        ))
    }
}
