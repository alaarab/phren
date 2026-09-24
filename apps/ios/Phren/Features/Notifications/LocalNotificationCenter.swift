import CryptoKit
import Foundation
import PhrenKit
import UserNotifications

@MainActor
protocol LocalNotificationCenter: AnyObject {
    func pending() async -> [UNNotificationRequest]
    func delivered() async -> [UNNotificationRequest]
    func add(_ request: UNNotificationRequest) async throws
    func remove(_ ids: [String])
}

@MainActor
final class SystemLocalNotificationCenter: LocalNotificationCenter {
    private let center = UNUserNotificationCenter.current()
    func pending() async -> [UNNotificationRequest] { await center.pendingNotificationRequests() }
    func delivered() async -> [UNNotificationRequest] { await center.deliveredNotifications().map(\.request) }
    func add(_ request: UNNotificationRequest) async throws { try await center.add(request) }
    func remove(_ ids: [String]) {
        guard !ids.isEmpty else { return }
        center.removePendingNotificationRequests(withIdentifiers: ids)
        center.removeDeliveredNotifications(withIdentifiers: ids)
    }
}

enum LocalNotificationIdentity {
    static func digest(_ parts: String...) -> String {
        SHA256.hash(data: (try? JSONEncoder().encode(parts)) ?? Data()).map { String(format: "%02x", $0) }.joined()
    }
}

struct LocalScheduleReminder: Equatable {
    let hostID: UUID
    let project: String
    let schedule: Schedule
    let fireDate: Date

    var id: String { "local.schedule." + LocalNotificationIdentity.digest(hostID.uuidString, project, schedule.id) }
    var request: UNNotificationRequest {
        let content = UNMutableNotificationContent()
        content.title = "\(schedule.name) is due"
        content.body = "\(project): \(schedule.prompt.components(separatedBy: .newlines).first ?? "")"
        content.sound = .default
        content.categoryIdentifier = "PHREN_SCHEDULE"
        content.userInfo = ["localKind": "schedule", "hostID": hostID.uuidString, "project": project,
                            "scheduleID": schedule.id, "fireDate": fireDate.timeIntervalSince1970,
                            "revision": schedule.updatedAt.timeIntervalSince1970]
        var calendar = Calendar(identifier: .gregorian)
        calendar.timeZone = TimeZone(secondsFromGMT: 0)!
        var parts = calendar.dateComponents([.year, .month, .day, .hour, .minute, .second], from: fireDate)
        parts.calendar = calendar; parts.timeZone = calendar.timeZone
        return UNNotificationRequest(identifier: id, content: content,
                                     trigger: UNCalendarNotificationTrigger(dateMatching: parts, repeats: false))
    }
}

/// Serialize notification-center mutations, including the async add, so an
/// older refresh cannot resurrect a schedule removed by a newer refresh.
@MainActor
final class LocalScheduleNotifications {
    private let center: LocalNotificationCenter
    private var previous: Task<Void, Never>?
    init(center: LocalNotificationCenter) { self.center = center }

    func reconcile(_ reminders: [LocalScheduleReminder]) async {
        let before = previous
        let task = Task {
            await before?.value
            guard !Task.isCancelled else { return }
            await apply(reminders)
        }
        previous = task
        await withTaskCancellationHandler { await task.value } onCancel: { task.cancel() }
    }

    private func apply(_ reminders: [LocalScheduleReminder]) async {
        // Leave room under the system's pending request limit. Each schedule
        // gets one next run, with the soonest 60 taking priority.
        let desired = reminders.sorted { $0.fireDate == $1.fireDate ? $0.id < $1.id : $0.fireDate < $1.fireDate }
            .prefix(60).map(\.request)
        let ids = Set(desired.map(\.identifier))
        let pending = await center.pending().filter { $0.identifier.hasPrefix("local.schedule.") }
        let delivered = await center.delivered().filter { $0.identifier.hasPrefix("local.schedule.") }
        guard !Task.isCancelled else { return }
        center.remove((pending + delivered).filter { !ids.contains($0.identifier) }.map(\.identifier))
        for request in desired {
            guard !Task.isCancelled else { return }
            if let old = pending.first(where: { $0.identifier == request.identifier }),
               old.content.title == request.content.title, old.content.body == request.content.body,
               NSDictionary(dictionary: old.content.userInfo).isEqual(to: request.content.userInfo) { continue }
            center.remove([request.identifier])
            try? await center.add(request)
            if Task.isCancelled { center.remove([request.identifier]); return }
        }
    }
}
