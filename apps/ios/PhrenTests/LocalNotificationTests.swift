import Foundation
import PhrenKit
import PhrenLive
import UserNotifications
import XCTest
@testable import Phren

@MainActor
final class LocalNotificationTests: XCTestCase {
    private let hostID = UUID(uuidString: "11111111-1111-1111-1111-111111111111")!
    private func reminder(id: String = "1234abcd", offset: TimeInterval = 600, prompt: String = "Check tests\nThen report") -> LocalScheduleReminder {
        let date = Date(timeIntervalSince1970: 2_000_000_000)
        return .init(hostID: hostID, project: "demo", schedule: Schedule(id: id, name: "Check", enabled: true,
            computer: "Desk", harness: .codex, every: .interval(minutes: 30), prompt: prompt,
            createdAt: date, updatedAt: date), fireDate: date.addingTimeInterval(offset))
    }

    func testRegisterUnchangedReplaceAndDeleteSchedule() async throws {
        let center = FakeLocalNotificationCenter()
        let scheduler = LocalScheduleNotifications(center: center)
        let original = reminder()
        await scheduler.reconcile([original])
        XCTAssertEqual(center.added.count, 1)
        XCTAssertEqual(center.requests[original.id]?.content.body, "demo: Check tests")
        XCTAssertEqual(center.requests[original.id]?.content.title, "Check is due")
        let trigger = try XCTUnwrap(center.requests[original.id]?.trigger as? UNCalendarNotificationTrigger)
        XCTAssertFalse(trigger.repeats)
        XCTAssertEqual(trigger.dateComponents.timeZone?.secondsFromGMT(), 0)
        await scheduler.reconcile([original])
        XCTAssertEqual(center.added.count, 1, "Unchanged schedules keep the registered request")
        let changed = reminder(offset: 1_200, prompt: "Review changes\nAnd report")
        await scheduler.reconcile([changed])
        XCTAssertEqual(center.added.count, 2)
        XCTAssertEqual(center.requests.count, 1)
        XCTAssertEqual(center.requests[original.id]?.content.body, "demo: Review changes")
        center.shown[original.id] = changed.request
        await scheduler.reconcile([])
        XCTAssertTrue(center.requests.isEmpty)
        XCTAssertTrue(center.shown.isEmpty)
    }

    func testRelaunchCancelsOrphanedSchedulesButPreservesOtherNotifications() async {
        let center = FakeLocalNotificationCenter()
        let removedComputer = reminder()
        center.requests[removedComputer.id] = removedComputer.request
        center.shown[removedComputer.id] = removedComputer.request
        let unrelated = UNNotificationRequest(identifier: "remote-approval", content: UNMutableNotificationContent(), trigger: nil)
        center.requests[unrelated.identifier] = unrelated
        await LocalScheduleNotifications(center: center).reconcile([])
        XCTAssertEqual(Set(center.requests.keys), [unrelated.identifier])
        XCTAssertTrue(center.shown.isEmpty)
    }

    func testSchedulePlanUsesComputerTimeAndCancelsDeletedPausedAndReassignedSchedules() async {
        let item = reminder()
        let status = ScheduleStatus(schedule: item.schedule, project: item.project, nextRun: item.fireDate,
                                    lastRun: nil, running: false)
        let snapshot = ScheduleSnapshot(computer: "Desk", timeZone: "UTC", schedules: [status])
        let center = FakeLocalNotificationCenter()
        let scheduler = LocalScheduleNotifications(center: center)
        func plan(_ values: [Schedule]) -> [LocalScheduleReminder] {
            LocalNotificationMonitor.reminders(hostID: hostID, snapshot: snapshot,
                local: ["demo": values], deleted: values.isEmpty ? [LocalNotificationMonitor.scheduleKey("demo", item.schedule.id)] : [],
                now: item.schedule.createdAt)
        }
        await scheduler.reconcile(plan([item.schedule]))
        XCTAssertEqual(center.requests.count, 1)
        var changed = item.schedule
        changed.every = .interval(minutes: 60)
        changed.updatedAt = changed.updatedAt.addingTimeInterval(1)
        let updated = plan([changed])
        XCTAssertEqual(updated.first?.fireDate, changed.createdAt.addingTimeInterval(3_600))
        await scheduler.reconcile(updated)
        XCTAssertEqual(center.added.count, 2)
        changed.enabled = false
        await scheduler.reconcile(plan([changed]))
        XCTAssertTrue(center.requests.isEmpty)
        changed.enabled = true; changed.computer = "Linuxbox"
        XCTAssertTrue(plan([changed]).isEmpty)
        await scheduler.reconcile(plan([item.schedule]))
        await scheduler.reconcile(plan([]))
        XCTAssertTrue(center.requests.isEmpty, "A stale Hook response cannot resurrect a local deletion")
    }

    func testNewScheduleUsesComputerZoneButOldHookWaitsForConfirmation() {
        let item = reminder()
        let snapshot = ScheduleSnapshot(computer: "Desk", timeZone: "UTC", schedules: [])
        let values = LocalNotificationMonitor.reminders(hostID: hostID, snapshot: snapshot,
            local: ["demo": [item.schedule]], pending: [LocalNotificationMonitor.scheduleKey("demo", item.schedule.id)],
            now: item.schedule.createdAt)
        XCTAssertEqual(values.first?.fireDate, item.schedule.createdAt.addingTimeInterval(1_800))
        let oldHook = ScheduleSnapshot(computer: "Desk", timeZone: nil, schedules: [])
        XCTAssertTrue(LocalNotificationMonitor.reminders(hostID: hostID, snapshot: oldHook,
            local: ["demo": [item.schedule]], now: item.schedule.createdAt).isEmpty)
        XCTAssertTrue(LocalNotificationMonitor.reminders(hostID: hostID, snapshot: snapshot,
            local: ["demo": [item.schedule]], now: item.schedule.createdAt).isEmpty,
            "A stale store snapshot cannot recreate a schedule the computer deleted")
    }

    func testScheduleCapacityKeepsSoonestSixtyAndDropsReplacedRequests() async {
        let center = FakeLocalNotificationCenter()
        let scheduler = LocalScheduleNotifications(center: center)
        let values = (0..<65).map { reminder(id: String(format: "%08x", $0), offset: Double(600 + $0)) }
        await scheduler.reconcile(values.reversed())
        XCTAssertEqual(Set(center.requests.keys), Set(values.prefix(60).map(\.id)))
        await scheduler.reconcile([values[64]])
        XCTAssertEqual(Set(center.requests.keys), [values[64].id])
    }

    func testApprovalDedupeAnswerExpiryAndSettingsCancellation() async throws {
        let suite = "local-notification-tests-\(UUID().uuidString)"
        let defaults = try XCTUnwrap(UserDefaults(suiteName: suite))
        defer { defaults.removePersistentDomain(forName: suite) }
        let center = FakeLocalNotificationCenter()
        var enabled = true
        let manager = LocalApprovalNotifications(center: center, defaults: defaults, enabled: { enabled })
        let host = try LiveHost(id: hostID, name: "Desk", address: "Desk", username: "sam")
        let session = try AgentLaunch.session(host: host, workspaceID: "w1", tabID: "t1", label: "Check",
                                              agent: "codex", agentStatus: "waiting", cwd: "/home/sam/demo")
        let target = try AgentChatTarget(hostID: host.id, workspaceID: "w1", tabID: "t1", paneID: "p1",
                                         source: "codex", sessionID: "session")
        func approval(_ id: String) throws -> AgentApproval {
            try JSONDecoder().decode(AgentApproval.self, from: JSONSerialization.data(withJSONObject: [
                "actionId": id, "title": "Run tests?", "message": "{\"command\":\"pnpm test\"}",
                "expiresAt": Date().addingTimeInterval(300).ISO8601Format(),
            ]))
        }
        let first = try approval("first")
        await manager.sync(first, session: session, target: target, deliver: false)
        XCTAssertTrue(center.added.isEmpty)
        await manager.deliverWaiting()
        XCTAssertEqual(center.added.count, 1)
        XCTAssertEqual(center.added.first?.content.title, "Codex asks")
        XCTAssertEqual(center.added.first?.content.body, "Run tests?\npnpm test")
        await manager.sync(first, session: session, target: target, deliver: true)
        XCTAssertEqual(center.added.count, 1)
        manager.answered(hostID: host.id, actionID: first.id)
        XCTAssertTrue(center.requests.isEmpty)
        let reloaded = LocalApprovalNotifications(center: center, defaults: defaults, enabled: { enabled })
        await reloaded.sync(first, session: session, target: target, deliver: true)
        XCTAssertEqual(center.added.count, 1, "An answered ID stays spent after process restart")
        await reloaded.sync(try approval("second"), session: session, target: target, deliver: true)
        XCTAssertEqual(center.added.count, 2)
        reloaded.retireExpired(now: Date().addingTimeInterval(600))
        XCTAssertTrue(center.requests.isEmpty)
        await reloaded.sync(try approval("third"), session: session, target: target, deliver: true)
        enabled = false
        await reloaded.deliverWaiting()
        XCTAssertTrue(center.requests.isEmpty)
        manager.clear(); reloaded.clear()
    }

    func testBackgroundCompletionRunsExactlyOnceAndCancelsOnExpiry() {
        var results: [Bool] = [], cancellations = 0
        let completion = RefreshCompletion { results.append($0) }
        completion.cancel = { cancellations += 1 }
        completion.finish(success: false)
        completion.finish(success: true)
        XCTAssertEqual(results, [false])
        XCTAssertEqual(cancellations, 1)
    }
}

@MainActor
private final class FakeLocalNotificationCenter: LocalNotificationCenter {
    var requests: [String: UNNotificationRequest] = [:]
    var shown: [String: UNNotificationRequest] = [:]
    var added: [UNNotificationRequest] = []
    func pending() async -> [UNNotificationRequest] { Array(requests.values) }
    func delivered() async -> [UNNotificationRequest] { Array(shown.values) }
    func add(_ request: UNNotificationRequest) async throws {
        added.append(request); requests[request.identifier] = request
    }
    func remove(_ ids: [String]) {
        for id in ids { requests.removeValue(forKey: id); shown.removeValue(forKey: id) }
    }
}
