import Foundation
import PhrenKit
import XCTest
@testable import PhrenLive

final class ScheduleRoutesTests: XCTestCase {
    func testSchedulesRequestPostsAnEmptyObject() throws {
        let request = PhrenConnection.schedulesRequest()
        let body = try XCTUnwrap(JSONSerialization.jsonObject(with: XCTUnwrap(request.body)) as? [String: Any])
        XCTAssertEqual(request.path, "/v1/schedules")
        XCTAssertTrue(body.isEmpty)
    }

    func testRunRequestCarriesProjectAndID() throws {
        let request = try PhrenConnection.runScheduleRequest(project: "phone-kit", id: "7f3a2c1d")
        let body = try XCTUnwrap(JSONSerialization.jsonObject(with: XCTUnwrap(request.body)) as? [String: Any])
        XCTAssertEqual(request.path, "/v1/schedules/run")
        XCTAssertEqual(body["project"] as? String, "phone-kit")
        XCTAssertEqual(body["id"] as? String, "7f3a2c1d")
    }

    func testHistoryRequestCarriesFiltersAndClampsLimit() throws {
        let request = try PhrenConnection.scheduleHistoryRequest(project: "phone-kit", id: "7f3a2c1d", limit: 900)
        let body = try XCTUnwrap(JSONSerialization.jsonObject(with: XCTUnwrap(request.body)) as? [String: Any])
        XCTAssertEqual(request.path, "/v1/schedules/history")
        XCTAssertEqual(body["project"] as? String, "phone-kit")
        XCTAssertEqual(body["id"] as? String, "7f3a2c1d")
        XCTAssertEqual(body["limit"] as? Int, 500)
    }

    func testScheduleRequestsRejectInvalidIdentifiers() {
        XCTAssertThrowsError(try PhrenConnection.runScheduleRequest(project: "../store", id: "7f3a2c1d"))
        XCTAssertThrowsError(try PhrenConnection.runScheduleRequest(project: "phone-kit", id: "not-an-id"))
        XCTAssertThrowsError(try PhrenConnection.scheduleHistoryRequest(project: nil, id: "bad", limit: 50))
    }

    func testStatusAndRunDecodeTheHookShape() throws {
        let data = Data(#"""
        {
          "id":"7f3a2c1d","name":"Nightly","enabled":true,"computer":"Desk",
          "harness":"codex","every":"daily","at":"07:30","prompt":"Test",
          "createdAt":"2026-09-20T21:00:00Z","updatedAt":"2026-09-20T21:00:00Z",
          "project":"phone-kit","nextRun":"2026-09-21T07:30:00Z","running":true,
          "lastRun":{"id":"run-1","scheduleId":"7f3a2c1d","project":"phone-kit",
            "startedAt":"2026-09-20T21:01:00Z","status":"running",
            "launch":{"mode":"herdr","workspaceId":"w1","tabId":"w1:t1","paneId":"w1:p1"}}
        }
        """#.utf8)
        let status = try JSONDecoder().decode(ScheduleStatus.self, from: data)
        XCTAssertEqual(status.id, "7f3a2c1d")
        XCTAssertEqual(status.every, .daily(hour: 7, minute: 30))
        XCTAssertEqual(status.lastRun?.scheduleID, "7f3a2c1d")
        XCTAssertEqual(status.lastRun?.launch.paneID, "w1:p1")
        XCTAssertTrue(status.running)
    }

    func testRunDecodesWithoutNotificationResultFields() throws {
        let data = Data(#"""
        {
          "id":"run-1","scheduleId":"7f3a2c1d","project":"phone-kit",
          "startedAt":"2026-09-20T21:01:00Z","status":"finished",
          "launch":{"mode":"headless","sessionId":"session-1"}
        }
        """#.utf8)

        let run = try JSONDecoder().decode(ScheduleRun.self, from: data)

        XCTAssertEqual(run.id, "run-1")
        XCTAssertEqual(run.status, .finished)
        XCTAssertNil(run.notified)
        XCTAssertNil(run.notifyReason)
        XCTAssertNil(run.blockedStartupPrompt)
    }

    func testBlockedRunDecodesStatusAndPromptText() throws {
        let data = Data(#"""
        {
          "id":"run-2","scheduleId":"7f3a2c1d","project":"phone-kit",
          "startedAt":"2026-09-21T08:00:00Z","status":"blocked",
          "blockedStartupPrompt":"Allow external CLAUDE.md file imports?",
          "launch":{"mode":"herdr","workspaceId":"w1","tabId":"w1:t1","paneId":"w1:p1"}
        }
        """#.utf8)

        let run = try JSONDecoder().decode(ScheduleRun.self, from: data)

        XCTAssertEqual(run.status, .blocked)
        XCTAssertEqual(run.blockedStartupPrompt, "Allow external CLAUDE.md file imports?")
    }

    func testSchedulesListDecodesALatestBlockedRun() throws {
        let data = Data(#"""
        {
          "id":"7f3a2c1d","name":"Nightly","enabled":true,"computer":"Desk",
          "harness":"codex","every":"daily","at":"07:30","prompt":"Test",
          "createdAt":"2026-09-20T21:00:00Z","updatedAt":"2026-09-20T21:00:00Z",
          "project":"phone-kit","nextRun":null,"running":true,
          "lastRun":{"id":"run-2","scheduleId":"7f3a2c1d","project":"phone-kit",
            "startedAt":"2026-09-21T08:00:00Z","status":"blocked",
            "blockedStartupPrompt":"Do you trust the files in this folder?",
            "launch":{"mode":"herdr","workspaceId":"w1","tabId":"w1:t1","paneId":"w1:p1"}}
        }
        """#.utf8)

        let status = try JSONDecoder().decode(ScheduleStatus.self, from: data)
        XCTAssertEqual(status.lastRun?.status, .blocked)
        XCTAssertEqual(status.lastRun?.blockedStartupPrompt, "Do you trust the files in this folder?")
        XCTAssertTrue(status.running)
    }
}
