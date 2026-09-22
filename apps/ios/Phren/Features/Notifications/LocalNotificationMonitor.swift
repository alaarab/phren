import Foundation
import PhrenKit
import PhrenLive
import UIKit
import UserNotifications

enum LocalNotificationSettings {
    static let approvalsKey = "notifications.local.approvals.v1"
    static let schedulesKey = "notifications.local.schedules.v1"
    static var approvalsEnabled: Bool { AppRuntime.defaults.object(forKey: approvalsKey) as? Bool ?? true }
    static var schedulesEnabled: Bool { AppRuntime.defaults.object(forKey: schedulesKey) as? Bool ?? true }
}

@MainActor
final class LocalNotificationMonitor {
    static let shared = LocalNotificationMonitor()
    let approvals: LocalApprovalNotifications
    private let schedules: LocalScheduleNotifications
    private var snapshots: [UUID: ScheduleSnapshot] = [:]
    private var localSchedules: [String: [Schedule]]
    private struct Edits: Codable {
        var pending: Set<String> = []
        var deleted: Set<String> = []
    }
    private var edits: Edits
    private let editsKey = "notifications.schedule-edits.v1"
    private var foreground: Task<Void, Never>?
    private var background: Task<Void, Never>?
    private var lease: UIBackgroundTaskIdentifier = .invalid
    private var hostRevision = UUID()
    private var pollRevision = UUID()
    private var knownHosts: [LiveHost] = []
    private let catalogKey = "notifications.schedule-catalog.v1"

    private init() {
        let center = SystemLocalNotificationCenter()
        schedules = LocalScheduleNotifications(center: center)
        approvals = LocalApprovalNotifications(center: center, defaults: AppRuntime.defaults)
        edits = AppRuntime.defaults.data(forKey: editsKey)
            .flatMap { try? JSONDecoder().decode(Edits.self, from: $0) } ?? .init()
        localSchedules = AppRuntime.defaults.data(forKey: catalogKey)
            .flatMap { try? JSONDecoder().decode([String: [Schedule]].self, from: $0) } ?? [:]
    }

    var hosts: [LiveHost] {
        (try? LiveSessionPreferences.read(AppRuntime.defaults.data(forKey: "sessions.live.preferences.v1") ?? Data()))?.hosts ?? []
    }

    func enterForeground() {
        guard !AppRuntime.isUITesting else { return }
        endBackgroundWindow()
        foreground?.cancel()
        foreground = Task {
            approvals.retireExpired()
            await hostsChanged()
            while !Task.isCancelled {
                await poll(includeApprovals: false)
                do { try await Task.sleep(for: .seconds(30)) } catch { return }
            }
        }
    }

    func enterBackground() {
        guard !AppRuntime.isUITesting else { return }
        foreground?.cancel(); foreground = nil
        NotificationBackgroundRefresh.schedule()
        guard lease == .invalid, LocalNotificationSettings.approvalsEnabled else { return }
        lease = UIApplication.shared.beginBackgroundTask(withName: "Check agent approvals") { [weak self] in
            Task { @MainActor in self?.endBackgroundWindow() }
        }
        guard lease != .invalid else { return }
        background = Task {
            await approvals.deliverWaiting()
            // iOS may expire this lease sooner. Never assume minutes are owed.
            let deadline = Date().addingTimeInterval(150)
            while !Task.isCancelled, Date() < deadline {
                await poll(includeApprovals: true)
                do { try await Task.sleep(for: .seconds(3)) } catch { break }
            }
            if !Task.isCancelled { endBackgroundWindow() }
        }
    }

    private func endBackgroundWindow() {
        background?.cancel(); background = nil
        if lease != .invalid { UIApplication.shared.endBackgroundTask(lease); lease = .invalid }
    }

    func hostsChanged() async {
        hostRevision = UUID()
        let ids = Set(hosts.map(\.id))
        let current = hosts
        snapshots = snapshots.filter { id, _ in
            guard let before = knownHosts.first(where: { $0.id == id }) else { return false }
            return current.contains(before)
        }
        knownHosts = current
        approvals.retainHosts(ids)
        await reconcileSchedules()
    }

    func settingsChanged() async {
        if !LocalNotificationSettings.approvalsEnabled { approvals.clear(); endBackgroundWindow() }
        await reconcileSchedules()
        if LocalNotificationSettings.approvalsEnabled || LocalNotificationSettings.schedulesEnabled {
            await poll(includeApprovals: UIApplication.shared.applicationState != .active)
        }
        NotificationBackgroundRefresh.schedule()
    }

    /// All store refreshes use this, including a deletion learned through sync.
    func updateCatalog(_ model: AppModel) async {
        guard !AppRuntime.isUITesting, !model.storeContexts.isEmpty else { return }
        var next: [String: [Schedule]] = [:]
        for context in model.storeContexts {
            for (project, values) in context.snapshot.schedules {
                // Same-named projects with conflicting schedules are ambiguous.
                if let existing = next[project], existing != values { next[project] = [] }
                else { next[project] = values }
            }
        }
        guard next != localSchedules else { return }
        // A store refresh that began before an edit must not roll it back.
        for (project, previous) in localSchedules {
            if next[project] == nil { next[project] = [] }
            for newer in previous {
                if let index = next[project]?.firstIndex(where: { $0.id == newer.id }),
                   let incoming = next[project]?[index], incoming.updatedAt < newer.updatedAt {
                    next[project]?[index] = newer
                }
            }
        }
        recordChanges(next)
        localSchedules = next
        saveCatalog()
        await reconcileSchedules()
    }

    func scheduleEdited(project: String, schedules: [Schedule]) async {
        guard !AppRuntime.isUITesting else { return }
        let offerAuthorization = LocalNotificationSettings.schedulesEnabled
            && UIApplication.shared.applicationState == .active
            && schedules.contains { $0.enabled && !(localSchedules[project] ?? []).contains($0) }
        var next = localSchedules
        next[project] = schedules
        recordChanges(next, explicitProject: project)
        localSchedules = next
        saveCatalog()
        await reconcileSchedules()
        if offerAuthorization { Task { _ = await requestAuthorization() } }
    }

    private func recordChanges(_ next: [String: [Schedule]], explicitProject: String? = nil) {
        for (project, schedules) in next {
            let old = localSchedules[project] ?? []
            for removed in old where !schedules.contains(where: { $0.id == removed.id }) {
                let key = Self.scheduleKey(project, removed.id)
                edits.deleted.insert(key); edits.pending.remove(key)
            }
            for schedule in schedules where !old.contains(schedule) {
                // A first store load is a snapshot, not evidence of a local edit.
                guard localSchedules[project] != nil || explicitProject == project else { continue }
                let key = Self.scheduleKey(project, schedule.id)
                // A stale refresh cannot undo an accepted local deletion.
                if edits.deleted.contains(key), explicitProject == nil { continue }
                edits.pending.insert(key); edits.deleted.remove(key)
            }
        }
    }

    private func saveCatalog() {
        AppRuntime.defaults.set(try? JSONEncoder().encode(localSchedules), forKey: catalogKey)
        AppRuntime.defaults.set(try? JSONEncoder().encode(edits), forKey: editsKey)
    }
    static func scheduleKey(_ project: String, _ id: String) -> String { project + "\u{1f}" + id }

    private func acknowledge(_ snapshot: ScheduleSnapshot) {
        for status in snapshot.schedules {
            if let local = localSchedules[status.project]?.first(where: { $0.id == status.id }),
               status.updatedAt >= local.updatedAt {
                edits.pending.remove(Self.scheduleKey(status.project, status.id))
            }
        }
        saveCatalog()
    }

    /// Cancellation is checked before publishing every network result. The BG
    /// task owns the outer budget and cancels this work when time runs out.
    func poll(includeApprovals: Bool) async {
        guard !AppRuntime.isUITesting else { return }
        let run = hostRevision
        let pollRun = UUID()
        pollRevision = pollRun
        let currentHosts = hosts
        approvals.retireExpired()
        await withTaskGroup(of: Void.self) { group in
            for host in currentHosts {
                group.addTask { @MainActor in
                    guard !Task.isCancelled else { return }
                    guard let key = try? DeviceSSHKey.load(host.id) else {
                        if run == self.hostRevision, pollRun == self.pollRevision { self.snapshots[host.id] = nil }
                        return
                    }
                    if includeApprovals, LocalNotificationSettings.approvalsEnabled {
                        if let snapshot = try? await PhrenConnection.fetch(host: host, privateKey: key),
                           !Task.isCancelled, run == self.hostRevision, pollRun == self.pollRevision {
                            let sessions = snapshot.sessions(on: host)
                            self.approvals.reconcile(host: host, sessions: sessions)
                            let monitor = OverviewApprovalMonitor(sync: { approval, session, target in
                                guard !Task.isCancelled, run == self.hostRevision, pollRun == self.pollRevision,
                                      self.hosts.contains(host) else { return }
                                await self.approvals.sync(approval, session: session, target: target,
                                    deliver: UIApplication.shared.applicationState != .active)
                            })
                            await monitor.refresh(sessions)
                        }
                    }
                    if LocalNotificationSettings.schedulesEnabled {
                        let result = try? await PhrenConnection.scheduleSnapshot(host: host, privateKey: key)
                        guard !Task.isCancelled, run == self.hostRevision, pollRun == self.pollRevision else { return }
                        // A failed contact removes reminders for that computer.
                        self.snapshots[host.id] = result
                        if let result { self.acknowledge(result) }
                    }
                }
            }
        }
        guard !Task.isCancelled, run == hostRevision, pollRun == pollRevision else { return }
        await reconcileSchedules()
    }

    private func reconcileSchedules() async {
        var reminders: [LocalScheduleReminder] = []
        if LocalNotificationSettings.schedulesEnabled {
            for host in hosts {
                guard let snapshot = snapshots[host.id] else { continue }
                reminders += Self.reminders(hostID: host.id, snapshot: snapshot, local: localSchedules,
                    pending: edits.pending, deleted: edits.deleted, now: .now)
            }
        }
        await schedules.reconcile(reminders)
    }

    static func reminders(hostID: UUID, snapshot: ScheduleSnapshot, local: [String: [Schedule]],
                          pending: Set<String> = [], deleted: Set<String> = [], now: Date) -> [LocalScheduleReminder] {
        let remote = Dictionary(grouping: snapshot.schedules, by: \.project)
        var reminders: [LocalScheduleReminder] = []
        for project in Set(remote.keys).union(local.keys) {
            let statuses = remote[project] ?? []
            var candidates = Dictionary(uniqueKeysWithValues: statuses.map { ($0.id, $0.schedule) })
            for saved in local[project] ?? [] {
                let key = scheduleKey(project, saved.id)
                if let remote = candidates[saved.id], saved.updatedAt > remote.updatedAt { candidates[saved.id] = saved }
                else if candidates[saved.id] == nil, pending.contains(key) { candidates[saved.id] = saved }
            }
            for schedule in candidates.values {
                guard !deleted.contains(scheduleKey(project, schedule.id)) else { continue }
                let status = statuses.first { $0.id == schedule.id }
                guard SchedulesView.canonicalHost(schedule.computer) == SchedulesView.canonicalHost(snapshot.computer) else { continue }
                let next: Date?
                if let status, schedule == status.schedule { next = status.nextRun }
                else if let zone = snapshot.timeZone.flatMap(TimeZone.init(identifier:)) {
                    var calendar = Calendar(identifier: .gregorian); calendar.timeZone = zone
                    next = ScheduleNextRun.next(schedule, lastStartedAt: status?.lastRun?.startedAt, computerCalendar: calendar)
                } else { next = nil }
                if let date = ScheduleNextRun.reminderDate(next, enabled: schedule.enabled, running: status?.running ?? false, now: now) {
                    reminders.append(.init(hostID: hostID, project: project, schedule: schedule, fireDate: date))
                }
            }
        }
        return reminders
    }

    /// Call after a user visits settings, enables a kind or saves a schedule.
    func requestAuthorization() async -> Bool {
        guard !AppRuntime.isUITesting else { return true }
        let center = UNUserNotificationCenter.current()
        let status = await center.notificationSettings().authorizationStatus
        let granted: Bool
        if status == .notDetermined { granted = (try? await center.requestAuthorization(options: [.alert, .sound])) == true }
        else { granted = status == .authorized || status == .provisional || status == .ephemeral }
        if granted {
            UIApplication.shared.registerForRemoteNotifications()
            await settingsChanged()
        }
        return granted
    }
}
