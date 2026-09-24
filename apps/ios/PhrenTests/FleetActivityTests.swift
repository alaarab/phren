import Foundation
import XCTest
@testable import Phren

/// The one Live Activity for every agent: its counts line, the request it
/// leads with, and payloads from older app versions.
final class FleetActivityTests: XCTestCase {
    private typealias Attributes = SessionWorkingActivityAttributes
    private let now = Date(timeIntervalSince1970: 1_800_000_000)

    private func session(_ id: String, _ state: String, computer: String = "Desk", at offset: TimeInterval = -30) -> SessionWorkingActivityBuilder.Session {
        .init(entry: .init(id: id, project: id, provider: "codex", computer: computer, state: state),
              state: state, startedAt: now.addingTimeInterval(offset))
    }
    private func approval(_ id: String, expiresIn seconds: TimeInterval = 300, question: Bool = false) -> Attributes.PendingApproval {
        .init(requestID: id, provider: "Claude", project: "phren", host: "Desk",
              explanation: "Run the tests", expiresAt: now.addingTimeInterval(seconds), question: question)
    }

    func testHeadlineCountsWorkingAndNeedsYouAcrossComputers() {
        let state = SessionWorkingActivityBuilder.build([
            session("a", "working"), session("b", "working", computer: "Linuxbox"), session("c", "working"),
            session("d", "waiting"),
        ], now: now)
        XCTAssertEqual(state.headline, "3 working · 1 needs you · 2 computers")
        XCTAssertEqual(state.entries.first?.id, "d", "Needs-you rows lead")
    }

    func testARequestCountsAsNeedingYouEvenBeforeThePaneReportsWaiting() {
        var state = SessionWorkingActivityBuilder.build([session("a", "working")], now: now)
        XCTAssertEqual(state.headline, "1 working")
        state.approval = approval("r1")
        XCTAssertEqual(state.needsYou, 1)
        XCTAssertEqual(state.headline, "1 working · 1 needs you")
    }

    func testQuietFleetSaysHowManyAgents() {
        let state = SessionWorkingActivityBuilder.build([session("a", "idle", at: -5)], now: now)
        XCTAssertEqual(state.headline, "1 agent")
    }

    func testRequestHeadlineAndRoute() throws {
        XCTAssertEqual(approval("r1").headline, "Claude needs approval")
        XCTAssertEqual(approval("r1", question: true).headline, "Claude has a question")
        let url = try XCTUnwrap(approval("0D2F6A3E-6C1B-4D3E-9D3B-1C1F9E0A7B11").openURL)
        XCTAssertEqual(url.absoluteString, "phren://approval?request=0D2F6A3E-6C1B-4D3E-9D3B-1C1F9E0A7B11")
    }

    func testOlderPayloadsDecodeWithoutARequestOrReply() throws {
        let old = #"{"working":2,"waiting":0,"startedAt":0,"entries":[{"id":"a","project":"p","provider":"codex","computer":"Desk"}]}"#
        let state = try JSONDecoder().decode(Attributes.ContentState.self, from: Data(old.utf8))
        XCTAssertNil(state.approval)
        XCTAssertNil(state.entries.first?.reply)
        var withRequest = state
        withRequest.approval = approval("r1")
        let round = try JSONDecoder().decode(Attributes.ContentState.self, from: JSONEncoder().encode(withRequest))
        XCTAssertEqual(round, withRequest)
    }

    @MainActor
    func testQueueKeepsTheNewestLastAndBringsBackTheOneBefore() {
        typealias Controller = SessionWorkingActivityController
        var queue = Controller.queue([], adding: approval("r1"))
        queue = Controller.queue(queue, adding: approval("r2"))
        queue = Controller.queue(queue, adding: approval("r1"))
        XCTAssertEqual(queue.map(\.requestID), ["r2", "r1"], "A repeated request moves to the top, once")
        queue = Controller.queue(queue, removing: ["r1"], now: now)
        XCTAssertEqual(queue.last?.requestID, "r2", "Answering the top request brings back the one before")
        queue = Controller.queue(queue + [approval("old", expiresIn: -1)], removing: [], now: now)
        XCTAssertEqual(queue.map(\.requestID), ["r2"], "Expired requests drop")
        for index in 0..<12 { queue = Controller.queue(queue, adding: approval("n\(index)")) }
        XCTAssertEqual(queue.count, 8)
        XCTAssertEqual(queue.last?.requestID, "n11")
    }
}
