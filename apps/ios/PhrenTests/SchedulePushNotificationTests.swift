import Foundation
import XCTest
@testable import Phren

final class SchedulePushNotificationTests: XCTestCase {
    func testDecodesSchedulePayloadAndSelectsSessionRoute() throws {
        let route = try routeURL([
            "server": "default", "workspace": "w1", "tab": "w1:t1", "pane": "w1:p1",
            "source": "codex",
        ])
        let notification = try XCTUnwrap(SchedulePushNotification(userInfo: ["phren": [
            "kind": "scheduleFailed", "scheduleId": "7f3a2c1d", "project": "demo",
            "name": "Nightly test sweep", "computer": "Desk", "runId": "run-1",
            "status": "failed", "reason": "Tests failed", "route": route,
        ]]))

        XCTAssertEqual(notification.title, "Nightly test sweep failed")
        XCTAssertEqual(notification.body, "demo on Desk. Tests failed")
        XCTAssertEqual(notification.destination, .session(.init(
            server: "default", workspace: "w1", tab: "w1:t1", pane: "w1:p1", source: "codex"
        )))
    }

    func testSelectsScheduleHistoryWithoutAUsableSessionRoute() throws {
        let notification = try XCTUnwrap(SchedulePushNotification(userInfo: ["phren": [
            "kind": "scheduleFinished", "scheduleId": "7f3a2c1d", "project": "demo",
            "name": "Nightly test sweep", "computer": "Desk", "runId": "run-1", "status": "finished",
        ]]))
        XCTAssertEqual(notification.destination, .history(project: "demo", scheduleID: "7f3a2c1d"))
    }

    func testDecodesBlockedStartupPayloadWithTitleAndStatus() throws {
        let route = try routeURL([
            "server": "default", "workspace": "w1", "tab": "w1:t1", "pane": "w1:p1",
            "source": "claude",
        ])
        let notification = try XCTUnwrap(SchedulePushNotification(userInfo: ["phren": [
            "kind": "scheduleBlocked", "scheduleId": "7f3a2c1d", "project": "demo",
            "name": "Nightly test sweep", "computer": "Desk", "runId": "run-1",
            "status": "blocked", "reason": "Blocked at startup: Allow external CLAUDE.md file imports?",
            "route": route,
        ]]))

        XCTAssertEqual(notification.kind, .scheduleBlocked)
        XCTAssertEqual(notification.status, "blocked")
        XCTAssertEqual(notification.title, "Nightly test sweep blocked")
        XCTAssertEqual(notification.body, "demo on Desk. Blocked at startup: Allow external CLAUDE.md file imports?")
        XCTAssertEqual(notification.destination, .session(.init(
            server: "default", workspace: "w1", tab: "w1:t1", pane: "w1:p1", source: "claude"
        )))
    }

    private func routeURL(_ value: [String: String]) throws -> String {
        let data = try JSONSerialization.data(withJSONObject: value)
        let encoded = data.base64EncodedString().replacingOccurrences(of: "+", with: "-")
            .replacingOccurrences(of: "/", with: "_").replacingOccurrences(of: "=", with: "")
        var components = URLComponents()
        components.scheme = "phren"; components.host = "session"
        components.queryItems = [URLQueryItem(name: "route", value: encoded)]
        return try XCTUnwrap(components.url?.absoluteString)
    }
}
