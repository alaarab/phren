import Foundation
import PhrenKit
import XCTest
@testable import PhrenLive

final class LaunchSessionTests: XCTestCase {
    func testLaunchReplyDecodesIdsStatusAndOptionalSession() throws {
        let data = Data(#"{"ok":true,"workspaceId":"w9","tabId":"w9:t1","paneId":"w9:p1","agent":"claude","agentStatus":"idle","sessionId":"aaaaaaaa-1111-4111-8111-111111111111"}"#.utf8)
        let launched = try PhrenConnection.launchedSession(from: data, kind: .claude)
        XCTAssertEqual(launched, .init(workspaceID: "w9", tabID: "w9:t1", paneID: "w9:p1", agent: "claude", agentStatus: "idle",
                                       sessionID: "aaaaaaaa-1111-4111-8111-111111111111"))
        let pending = try PhrenConnection.launchedSession(from: Data(#"{"ok":true,"workspaceId":"w9","tabId":"w9:t1","paneId":"w9:p1","agent":"codex"}"#.utf8), kind: .codex)
        XCTAssertNil(pending.sessionID); XCTAssertNil(pending.agentStatus)
    }

    func testLaunchReplyRejectsWrongAgentMissingIdsOrBadIds() {
        let wrongAgent = Data(#"{"ok":true,"workspaceId":"w9","tabId":"w9:t1","paneId":"w9:p1","agent":"codex"}"#.utf8)
        XCTAssertThrowsError(try PhrenConnection.launchedSession(from: wrongAgent, kind: .claude))
        let noPane = Data(#"{"ok":true,"workspaceId":"w9","tabId":"w9:t1","agent":"claude"}"#.utf8)
        XCTAssertThrowsError(try PhrenConnection.launchedSession(from: noPane, kind: .claude))
        let badID = Data(#"{"ok":true,"workspaceId":"w 9","tabId":"w9:t1","paneId":"w9:p1","agent":"claude"}"#.utf8)
        XCTAssertThrowsError(try PhrenConnection.launchedSession(from: badID, kind: .claude))
        XCTAssertThrowsError(try PhrenConnection.launchedSession(from: Data(#"{"error":"nope"}"#.utf8), kind: .claude))
    }

    func testLaunchValidatesInputBeforeConnecting() async throws {
        let host = try LiveHost(name: "Fixture", address: "fixture.invalid", username: "fixture")
        do { _ = try await PhrenConnection.launchSession(host: host, privateKey: Data(), cwd: "relative", label: "phren", kind: .codex); XCTFail("relative cwd") }
        catch { XCTAssertTrue(error.localizedDescription.contains("full folder path")) }
        do { _ = try await PhrenConnection.launchSession(host: host, privateKey: Data(), cwd: "/work", label: "   ", kind: .codex); XCTFail("blank label") }
        catch { XCTAssertTrue(error.localizedDescription.contains("short workspace name")) }
        do { _ = try await PhrenConnection.launchSession(host: host, privateKey: Data(), cwd: "/work", label: "phren", kind: .codex, workspaceID: "w 1"); XCTFail("bad workspace id") }
        catch { XCTAssertTrue(error.localizedDescription.contains("Herdr workspace")) }
    }
}
