import Foundation
import Observation
import PhrenKit

/// Present the first refresh together, then keep each host independently live.
@Observable @MainActor
final class SessionOverviewMonitor {
    struct Computer: Identifiable {
        let host: LiveHost
        let monitor: LiveHostMonitor
        var id: UUID { host.id }
    }
    struct Group: Identifiable {
        let id: String
        let title: String
        let sessions: [LiveAgentSession]
        let fresh: Bool
    }

    private(set) var computers: [Computer] = []
    private(set) var ready = false
    private var generation = UUID()
    private var pending: Set<UUID> = []
    @ObservationIgnored private var cachedGroups: (key: GroupCacheKey, value: [Group])?
    @ObservationIgnored private(set) var groupComputationCount = 0
    @ObservationIgnored private(set) var lastGroupDurationMilliseconds = 0.0
    @ObservationIgnored private let initialWait: Duration
    @ObservationIgnored private let makeMonitor: @MainActor () -> LiveHostMonitor

    init(initialWait: Duration = .seconds(8), makeMonitor: @escaping @MainActor () -> LiveHostMonitor = { LiveHostMonitor() }) {
        self.initialWait = initialWait; self.makeMonitor = makeMonitor
    }

    func run(hosts: [LiveHost]) async {
        guard !Task.isCancelled else { return }
        let run = UUID(); generation = run
        computers = hosts.map { host in
            computers.first(where: { $0.host == host }) ?? Computer(host: host, monitor: makeMonitor())
        }
        pending = Set(computers.filter { $0.monitor.snapshot == nil && $0.monitor.message == nil }.map(\.id))
        ready = pending.isEmpty
        // Bound the initial reveal even when a transport cannot respond. A
        // pending computer is shown as connecting, without hiding healthy ones.
        let deadline = Task {
            do { try await Task.sleep(for: initialWait) } catch { return }
            if generation == run { ready = true }
        }
        defer { deadline.cancel() }
        await withTaskGroup(of: Void.self) { group in
            for computer in computers {
                group.addTask {
                    await computer.monitor.run(host: computer.host) { [weak self] in
                        guard let self, self.generation == run else { return }
                        self.pending.remove(computer.id)
                        if self.pending.isEmpty { self.ready = true }
                    }
                }
            }
        }
    }

    func groups(at date: Date, query: String, preferences: LiveSessionPreferences?, projects: [SessionProject],
                focusFilter: AgentFocusFilter? = nil) -> [Group] {
        guard ready else { return [] }
        // Freshness is the one clock-driven input: it flips a computer's
        // sessions between the live sections and "Last seen", so it is part
        // of the key — but it changes at most once per poll interval, not
        // once per tick.
        let key = GroupCacheKey(revisions: computers.map {
            .init(id: $0.id, updated: $0.monitor.lastUpdated, message: $0.monitor.message,
                  snapshot: $0.monitor.snapshot, fresh: $0.monitor.isFresh(at: date))
        }, query: query, preferences: preferences, projects: projects, focusFilter: focusFilter)
        if let cachedGroups, cachedGroups.key == key { return cachedGroups.value }
        let started = CFAbsoluteTimeGetCurrent()
        var live: [LiveAgentSession] = [], previous: [LiveAgentSession] = []
        for computer in computers {
            let sessions = (computer.monitor.snapshot?.sessions(on: computer.host) ?? []).filter { session in
                guard focusFilter?.includes(session, preferences: preferences, projects: projects) != false else { return false }
                let project = preferences?.projectMatch(hostID: computer.id, cwd: session.tab.cwd, projects: projects)
                return session.matches(query, projectName: project?.project.name)
            }
            if computer.monitor.isFresh(at: date) { live += sessions } else { previous += sessions }
        }
        // What needs you first, then what just finished, then what is idle.
        let order: [(LiveWorkspaces.Tab.Activity, String)] = [
            (.working, "Working"), (.waiting, "Needs input"), (.error, "Needs attention"),
            (.done, "Done"), (.idle, "Idle"), (.unknown, "Other sessions"),
        ]
        let pinned = (live + previous).filter { preferences?.isPinned($0.id) == true }.sorted(by: Self.ordered)
        live.removeAll { preferences?.isPinned($0.id) == true }
        previous.removeAll { preferences?.isPinned($0.id) == true }
        var groups: [Group] = pinned.isEmpty ? [] : [
            Group(id: "pinned", title: "Pinned", sessions: pinned, fresh: pinned.allSatisfy { isFresh($0, at: date) }),
        ]
        groups += order.compactMap { activity, title -> Group? in
            let matches = live.filter { $0.tab.activity == activity }.sorted(by: Self.ordered)
            return matches.isEmpty ? nil : Group(id: activity.rawValue, title: title, sessions: matches, fresh: true)
        }
        if !previous.isEmpty {
            groups.append(Group(id: "previous", title: "Last seen", sessions: previous.sorted(by: Self.ordered), fresh: false))
        }
        cachedGroups = (key, groups)
        groupComputationCount += 1
        lastGroupDurationMilliseconds = (CFAbsoluteTimeGetCurrent() - started) * 1_000
        #if DEBUG
        if ProcessInfo.processInfo.environment["PHREN_PERFORMANCE_LOG"] == "1" {
            print("[PhrenPerformance] session groups #\(groupComputationCount): \(String(format: "%.3f", lastGroupDurationMilliseconds)) ms")
        }
        #endif
        return groups
    }

    func connectedCount(at date: Date) -> Int { ready ? computers.filter { $0.monitor.isFresh(at: date) }.count : 0 }

    func isFresh(_ session: LiveAgentSession, at date: Date) -> Bool {
        computers.first { $0.host == session.host }?.monitor.isFresh(at: date) == true
    }

    /// Most recently changed first (Herdr's state counter, when the Hook
    /// reports it), then by computer and workspace so the rest stays stable.
    private static func ordered(_ lhs: LiveAgentSession, _ rhs: LiveAgentSession) -> Bool {
        if lhs.host.id == rhs.host.id, let l = lhs.tab.changedSeq, let r = rhs.tab.changedSeq, l != r { return l > r }
        return (lhs.host.name.lowercased(), lhs.host.id.uuidString, lhs.workspaceName.lowercased(), lhs.tab.id)
            < (rhs.host.name.lowercased(), rhs.host.id.uuidString, rhs.workspaceName.lowercased(), rhs.tab.id)
    }

    private struct Revision: Equatable {
        let id: UUID
        let updated: Date?
        let message: String?
        let snapshot: LiveWorkspaces?
        let fresh: Bool
    }
    private struct GroupCacheKey: Equatable {
        let revisions: [Revision]
        let query: String
        let preferences: LiveSessionPreferences?
        let projects: [SessionProject]
        let focusFilter: AgentFocusFilter?
    }
}
