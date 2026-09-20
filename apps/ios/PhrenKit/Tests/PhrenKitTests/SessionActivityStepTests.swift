import XCTest
@testable import PhrenKit

final class SessionActivityStepTests: XCTestCase {
    func testCommandToolsReadAsNameAndFirstLine() {
        XCTAssertEqual(SessionActivityStep.format(tool: "Bash", detail: "swift test --filter Chat", status: nil),
                       "Bash: swift test --filter Chat")
        XCTAssertEqual(SessionActivityStep.format(tool: "Bash", detail: "pnpm test\npnpm lint", status: nil),
                       "Bash: pnpm test")
        XCTAssertEqual(SessionActivityStep.format(tool: "exec_command", detail: "ls -la", status: nil),
                       "exec_command: ls -la")
        XCTAssertEqual(SessionActivityStep.format(tool: "Bash", detail: nil, status: nil), "Bash")
    }

    func testFileToolsUseTheLastPathComponent() {
        XCTAssertEqual(SessionActivityStep.format(tool: "Edit", detail: "apps/ios/AgentChatView.swift", status: nil),
                       "Editing AgentChatView.swift")
        XCTAssertEqual(SessionActivityStep.format(tool: "Read", detail: "src/net/Server.swift · lines 10–50", status: nil),
                       "Reading Server.swift")
        XCTAssertEqual(SessionActivityStep.format(tool: "apply_patch", detail: nil, status: nil), "Editing file")
    }

    func testFallsBackToStatusWhenNoToolIsRunning() {
        XCTAssertEqual(SessionActivityStep.format(tool: nil, detail: nil, status: "Working"), "Working")
        XCTAssertEqual(SessionActivityStep.format(tool: " ", detail: "  ", status: "Waiting for input"), "Waiting for input")
        XCTAssertNil(SessionActivityStep.format(tool: nil, detail: nil, status: nil))
        XCTAssertNil(SessionActivityStep.format(tool: nil, detail: nil, status: "   "))
    }

    func testStepIsTrimmedToOneLineWithinTheLimit() throws {
        let long = "swift test --filter ChatTranscriptPreparationTests --parallel"
        let value = try XCTUnwrap(SessionActivityStep.format(tool: "Bash", detail: long, status: nil))
        XCTAssertLessThanOrEqual(value.count, SessionActivityStep.limit)
        XCTAssertTrue(value.hasSuffix("…"))
        XCTAssertEqual(value, "Bash: swift test --filter ChatTranscrip…")
    }

    func testAStepTheComputerAlreadyPhrasedIsKeptWithoutATool() {
        XCTAssertEqual(SessionActivityStep.format(tool: nil, detail: "Editing View.swift", status: "Working"), "Editing View.swift")
        XCTAssertEqual(SessionActivityStep.format(tool: nil, detail: "  ", status: "Working"), "Working")
        XCTAssertEqual(SessionActivityStep.format(tool: "Bash", detail: "make", status: "Working"), "Bash: make")
    }
}
