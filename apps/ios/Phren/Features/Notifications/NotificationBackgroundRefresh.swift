import BackgroundTasks
import Foundation

@MainActor
enum NotificationBackgroundRefresh {
    static let identifier = "com.phren.ios.notifications.refresh"

    static func register() {
        guard !AppRuntime.isUITesting else { return }
        BGTaskScheduler.shared.register(forTaskWithIdentifier: identifier, using: .main) { task in
            Task { @MainActor in
                guard let refresh = task as? BGAppRefreshTask else { task.setTaskCompleted(success: false); return }
                run(refresh)
            }
        }
    }

    static func schedule() {
        guard !AppRuntime.isUITesting else { return }
        BGTaskScheduler.shared.cancel(taskRequestWithIdentifier: identifier)
        guard LocalNotificationSettings.approvalsEnabled || LocalNotificationSettings.schedulesEnabled,
              !LocalNotificationMonitor.shared.hosts.isEmpty else { return }
        let request = BGAppRefreshTaskRequest(identifier: identifier)
        request.earliestBeginDate = Date().addingTimeInterval(15 * 60)
        try? BGTaskScheduler.shared.submit(request)
    }

    private static func run(_ task: BGAppRefreshTask) {
        schedule()
        let completion = RefreshCompletion { task.setTaskCompleted(success: $0) }
        let work = Task { @MainActor in
            await LocalNotificationMonitor.shared.hostsChanged()
            await LocalNotificationMonitor.shared.poll(includeApprovals: true)
            completion.finish(success: !Task.isCancelled)
        }
        completion.cancel = { work.cancel() }
        task.expirationHandler = { Task { @MainActor in completion.finish(success: false) } }
        completion.deadline = Task { @MainActor in
            do { try await Task.sleep(for: .seconds(20)) } catch { return }
            completion.finish(success: false)
        }
    }
}

/// Completion does not wait on an unresponsive SSH child. Cancellation stops
/// that child's publication, and the system task is finished exactly once.
@MainActor
final class RefreshCompletion {
    var cancel: (() -> Void)?
    var deadline: Task<Void, Never>?
    private var completed = false
    private let complete: (Bool) -> Void
    init(complete: @escaping (Bool) -> Void) { self.complete = complete }
    func finish(success: Bool) {
        guard !completed else { return }
        completed = true
        if !success { cancel?() }
        deadline?.cancel(); deadline = nil; cancel = nil
        complete(success)
    }
}
