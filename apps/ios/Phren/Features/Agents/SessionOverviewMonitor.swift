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
    struct Group: Codable, Identifiable, Equatable {
        let id: String
        let title: String
        let sessions: [LiveAgentSession]
        let fresh: Bool
    }

    struct Configuration: Equatable {
        var query = ""
        var preferences: LiveSessionPreferences? = nil
        var projects: [SessionProject] = []
        var focusFilter: AgentFocusFilter? = nil
        var metadataReady = true
        var memoryConnected = true
    }
    struct ComputerRow: Codable, Identifiable, Equatable {
        let host: LiveHost
        let connecting: Bool
        let fresh: Bool
        let message: String?
        let needsVerification: Bool
        var id: UUID { host.id }
    }
    /// One value is published for the entire screen: header, groups, resolved
    /// projects/pins and computer rows can never come from different refreshes.
    struct Screen: Codable, Equatable {
        var groups: [Group] = []
        var computers: [ComputerRow] = []
        var projects: [LiveAgentSession.ID: String] = [:]
        var pinned: Set<LiveAgentSession.ID> = []
        var focusFilter: AgentFocusFilter? = nil
        var query = ""
        var memoryReady = true
        var memoryConnected = true
        var preferencesReadable = true
        var connectedCount: Int { computers.filter(\.fresh).count }
    }

    private(set) var computers: [Computer] = []
    private(set) var ready = false
    private(set) var screen = Screen()
    @ObservationIgnored private var configuration = Configuration()
    @ObservationIgnored private var latchedHosts: [LiveHost] = []
    @ObservationIgnored private var initialDeadline: ContinuousClock.Instant?
    @ObservationIgnored private var publication: Task<Void, Never>?
    @ObservationIgnored private(set) var listRelayoutsAfterReady = 0
    private var generation = UUID()
    private var pending: Set<UUID> = []
    @ObservationIgnored private var cachedGroups: (key: GroupCacheKey, value: [Group])?
    @ObservationIgnored private(set) var groupComputationCount = 0
    @ObservationIgnored private(set) var lastGroupDurationMilliseconds = 0.0
    @ObservationIgnored private let diskCache: SessionOverviewDiskCache?
    @ObservationIgnored private var refreshingCachedScreen = false
    @ObservationIgnored private let initialWait: Duration
    @ObservationIgnored private let makeMonitor: @MainActor () -> LiveHostMonitor

    init(initialWait: Duration = .seconds(8), diskCache: SessionOverviewDiskCache? = nil, makeMonitor: @escaping @MainActor () -> LiveHostMonitor = { LiveHostMonitor() }) {
        self.initialWait = initialWait; self.diskCache = diskCache; self.makeMonitor = makeMonitor
    }

    /// The one overview the app keeps live: the Agents list drives it and
    /// the agent drawer reads it, so the drawer opens on what is already
    /// known instead of fetching every computer again.
    static let shared = SessionOverviewMonitor(diskCache: AppRuntime.isUITesting
        && !ProcessInfo.processInfo.arguments.contains("--overview-disk-cache") ? nil : .shared)
    @ObservationIgnored private var ownedRun: Task<Void, Never>?
    @ObservationIgnored private var ownedHosts: [LiveHost] = []

    /// Start (or keep) polling these computers from a task this object owns,
    /// so no screen's disappearance can cancel it.
    func ensureRunning(hosts: [LiveHost]) {
        if let ownedRun, !ownedRun.isCancelled, ownedHosts == hosts { return }
        ownedRun?.cancel()
        ownedHosts = hosts
        ownedRun = Task { [weak self] in await self?.run(hosts: hosts) }
    }
    func stopRunning() {
        ownedRun?.cancel(); ownedRun = nil; ownedHosts = []
    }

    func run(hosts: [LiveHost]) async {
        guard !Task.isCancelled else { return }
        let run = UUID(); generation = run
        let identity = hosts.sorted { $0.id.uuidString < $1.id.uuidString }
        let cold = latchedHosts != identity || initialDeadline == nil
        if cold {
            latchedHosts = identity
            ready = false
            screen = Screen()
            refreshingCachedScreen = false
            listRelayoutsAfterReady = 0
            initialDeadline = .now.advanced(by: initialWait)
        }
        computers = hosts.map { host in
            computers.first(where: { $0.host == host }) ?? Computer(host: host, monitor: makeMonitor())
        }
        if cold, let diskCache {
            #if DEBUG && targetEnvironment(simulator)
            await seedCacheFixture(diskCache, hosts: hosts)
            #endif
            let restored = await diskCache.load(hosts: hosts, preferences: configuration.preferences,
                query: configuration.query, focusFilter: configuration.focusFilter)
            guard generation == run, !Task.isCancelled else { return }
            if let restored {
                for computer in computers {
                    let saved = restored.hosts.first { $0.host == computer.host }
                    computer.monitor.snapshot = saved?.snapshot
                    computer.monitor.lastUpdated = saved?.lastUpdated
                    computer.monitor.message = restored.screen.computers.first { $0.id == computer.id }?.message
                }
                screen = restored.screen
                ready = true
                refreshingCachedScreen = true
            }
        }
        for computer in computers {
            computer.monitor.onSnapshotChanged = { [weak self] in self?.schedulePublication() }
        }
        pending = Set(computers.filter { refreshingCachedScreen || ($0.monitor.snapshot == nil && $0.monitor.message == nil) }.map(\.id))
        revealIfPossible()
        // Bound the initial reveal even when a transport cannot respond. A
        // pending computer is shown as connecting, without hiding healthy ones.
        let deadline = Task {
            do { try await Task.sleep(until: initialDeadline ?? .now, clock: .continuous) } catch { return }
            if generation == run { revealIfPossible(deadlineReached: true) }
        }
        // Only a freshness transition publishes a new screen. The per-second
        // relative clock below the cards never reads the list's inputs.
        let freshness = Task {
            while !Task.isCancelled {
                do { try await Task.sleep(for: .seconds(1)) } catch { return }
                guard generation == run, ready else { continue }
                let current = computers.map { $0.monitor.isFresh(at: .now) }
                if current != screen.computers.map(\.fresh) { publish() }
            }
        }
        defer { deadline.cancel(); freshness.cancel(); if generation == run { publication?.cancel() } }
        await withTaskGroup(of: Void.self) { group in
            for computer in computers {
                group.addTask {
                    await computer.monitor.run(host: computer.host) { [weak self] in
                        guard let self, self.generation == run else { return }
                        self.pending.remove(computer.id)
                        self.revealIfPossible()
                    }
                }
            }
        }
    }

    func configure(_ value: Configuration) {
        guard configuration != value else { return }
        configuration = value
        if ready && !refreshingCachedScreen { publish() } else { revealIfPossible() }
    }

    private func revealIfPossible(deadlineReached: Bool = false) {
        guard initialDeadline != nil, !ready || refreshingCachedScreen else { return }
        guard deadlineReached || (pending.isEmpty && configuration.metadataReady) else { return }
        let first = !ready
        refreshingCachedScreen = false
        ready = true
        publish(first: first)
    }

    private func schedulePublication() {
        guard ready, !refreshingCachedScreen else { return }
        publication?.cancel()
        publication = Task {
            do { try await Task.sleep(for: .milliseconds(120)) } catch { return }
            publish()
        }
    }

    private func publish(first: Bool = false) {
        guard ready, !refreshingCachedScreen else { return }
        let started = CFAbsoluteTimeGetCurrent(), date = Date.now
        let groups = groups(at: date, query: configuration.query, preferences: configuration.preferences,
                            projects: configuration.projects, focusFilter: configuration.focusFilter)
        var value = Screen(groups: groups, computers: computers.map {
            ComputerRow(host: $0.host, connecting: $0.monitor.snapshot == nil && $0.monitor.message == nil,
                        fresh: $0.monitor.isFresh(at: date), message: $0.monitor.message,
                        needsVerification: $0.monitor.fingerprint != nil)
        }, focusFilter: configuration.focusFilter, query: configuration.query, memoryReady: configuration.metadataReady,
           memoryConnected: configuration.memoryConnected, preferencesReadable: configuration.preferences != nil)
        for session in groups.flatMap(\.sessions) {
            value.projects[session.id] = configuration.preferences?.projectMatch(hostID: session.host.id,
                cwd: session.tab.cwd, projects: configuration.projects)?.project.name
            if configuration.preferences?.isPinned(session.id) == true { value.pinned.insert(session.id) }
        }
        let changed = first || value != screen
        if let diskCache {
            let record = SessionOverviewDiskCache.Record(savedAt: date, hosts: computers.map {
                .init(host: $0.host, snapshot: $0.monitor.snapshot, lastUpdated: $0.monitor.lastUpdated)
            }, screen: value, preferences: configuration.preferences)
            Task { await diskCache.save(record, force: changed) }
        }
        guard changed else { return }
        screen = value
        if !first { listRelayoutsAfterReady += 1 }
        #if DEBUG
        if ProcessInfo.processInfo.environment["PHREN_PERFORMANCE_LOG"] == "1" {
            print("[PhrenPerformance] list re-layouts after ready: \(listRelayoutsAfterReady); publish \(String(format: "%.3f", (CFAbsoluteTimeGetCurrent() - started) * 1_000)) ms")
        }
        #endif
    }

    func groups(at date: Date, query: String, preferences: LiveSessionPreferences?, projects: [SessionProject],
                focusFilter: AgentFocusFilter? = nil) -> [Group] {
        guard ready else { return [] }
        // Freshness is the one clock-driven input: it flips a computer's
        // sessions between the live sections and "Last seen", so it is part
        // of the key — but it changes at most once per poll interval, not
        // once per tick.
        let key = GroupCacheKey(revisions: computers.map {
            .init(id: $0.id, message: $0.monitor.message,
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
        let left = lhs.tab.lastChangedAt ?? .distantPast, right = rhs.tab.lastChangedAt ?? .distantPast
        if left != right { return left > right }
        if lhs.host.id == rhs.host.id, lhs.tab.changedSeq != rhs.tab.changedSeq {
            return (lhs.tab.changedSeq ?? Int.min) > (rhs.tab.changedSeq ?? Int.min)
        }
        return (lhs.host.name.lowercased(), lhs.host.id.uuidString, lhs.workspaceName.lowercased(), lhs.tab.id)
            < (rhs.host.name.lowercased(), rhs.host.id.uuidString, rhs.workspaceName.lowercased(), rhs.tab.id)
    }

    private struct Revision: Equatable {
        let id: UUID
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
