import Foundation
import WidgetKit
import PhrenKit

/// Writes `WidgetSnapshot` to the `group.com.phren.ios` shared container so
/// the WidgetKit extension — which reads only this JSON file, never GitHub
/// or PhrenKit directly — can render memory count / top task without the
/// app being open.
///
/// Called from `AppModel.refresh()`, the same place the store-health data
/// (`syncStatus`, per-store `status`) settles each cycle: live-mode polling
/// re-runs `refresh()` roughly every ~7s per store while foregrounded, so
/// the snapshot file is always written with this cycle's freshest counts.
/// The disk write is gated on `Content` changing or `lastSyncedAt` moving by
/// a minute; the widget-visible `reloadAllTimelines()` call is gated on
/// `Content` alone, so a quiet poll (nothing approved, nothing new) never
/// touches the disk or the widget refresh budget.
@MainActor
enum WidgetBridge {
    static let appGroupID = "group.com.phren.ios"

    private static let writer = WidgetSnapshotWriter()
    private static let controlWriter = SessionControlSnapshotWriter()
    private static var sessionsByHost: [UUID: [LiveAgentSession]] = [:]

    static func publish(from model: AppModel) async {
        let snapshot = buildSnapshot(from: model)
        await writer.publish(snapshot)
    }

    /// Live-session monitors call this after each successful host refresh.
    /// Keeping the last successful result for every saved host lets the
    /// control choose across computers without treating an offline host as an
    /// empty response.
    static func publishSessions(_ sessions: [LiveAgentSession], on host: LiveHost) async {
        sessionsByHost[host.id] = sessions.filter { $0.tab.agent != nil }
        await publishCurrentSessions()
        let projects = await SpotlightProjects.current()
        let preferences = try? LiveSessionPreferences.read(AppRuntime.defaults.data(forKey: "sessions.live.preferences.v1") ?? Data())
        await SessionWorkingActivityController.shared.reconcile(sessions, on: host,
                                                                 projects: projects, preferences: preferences)
    }

    static func reconcileSessionHosts(_ hosts: [LiveHost]) async {
        let hadCachedSessions = !sessionsByHost.isEmpty
        sessionsByHost = sessionsByHost.filter { id, _ in hosts.contains { $0.id == id } }
        await SessionWorkingActivityController.shared.reconcileHosts(hosts)
        // On a cold app launch, keep the last good control until at least one
        // saved host answers. An explicit removal after this process observed
        // sessions still clears its route immediately.
        guard hadCachedSessions || hosts.isEmpty else { return }
        await publishCurrentSessions()
    }

    private static func publishCurrentSessions() async {
        let all = sessionsByHost.values.flatMap { $0 }
        let projects = await SpotlightProjects.current()
        let preferences = try? LiveSessionPreferences.read(AppRuntime.defaults.data(forKey: "sessions.live.preferences.v1") ?? Data())
        let reports = SessionStatusService.reports(for: all, projects: projects, preferences: preferences)
        let selected = SessionAttentionSelector.select(all)
        let entity = selected.flatMap { session in reports.first { $0.entity.id == AgentSessionEntity(session).id }?.entity }
        await controlWriter.publish(entity.map(SessionControlSnapshot.init))
    }

    static func openAttentionSession() throws {
        guard let url = FileManager.default.containerURL(forSecurityApplicationGroupIdentifier: appGroupID)?
                .appendingPathComponent(SessionControlSnapshot.filename),
              let data = try? Data(contentsOf: url),
              let snapshot = try? JSONDecoder().decode(SessionControlSnapshot.self, from: data),
              let host = AgentSessions.hosts.first(where: { $0.id == snapshot.hostID && $0.muxID == snapshot.muxID }) else {
            throw PhrenKitError.validation("No waiting or working session is available.")
        }
        let session = try AgentLaunch.session(host: host, workspaceID: snapshot.workspaceID, tabID: snapshot.tabID,
                                              label: snapshot.label, agent: snapshot.agent,
                                              agentStatus: snapshot.state, cwd: snapshot.cwd)
        AgentLaunch.setPending(session)
    }

    private static func buildSnapshot(from model: AppModel) -> WidgetSnapshot {
        WidgetSnapshot(
            memoryCount: model.storeContexts.reduce(0) { $0 + $1.snapshot.projects.reduce(0) { $0 + $1.totalFindingCount } },
            projectCount: model.storeContexts.reduce(0) { $0 + $1.snapshot.projects.filter { $0.name != "global" }.count },
            topTask: topActiveTask(model: model),
            lastSyncedAt: model.syncStatus.lastSyncedAt
        )
    }

    /// Mirrors `TaskListView`'s active-section ordering (pinned first, then
    /// rank — tasks.ts display order) across every store/project, so "top
    /// task" here means the same thing it does in the Tasks tab.
    private static func topActiveTask(model: AppModel) -> WidgetSnapshot.TopTask? {
        var best: (task: PhrenTask, project: String)?
        for (_, _, doc) in model.mergedTaskDocs {
            for task in doc.active {
                guard let current = best else {
                    best = (task, doc.project)
                    continue
                }
                if isHigherPriority(task, doc.project, than: current.task, current.project) {
                    best = (task, doc.project)
                }
            }
        }
        guard let best else { return nil }
        return WidgetSnapshot.TopTask(text: best.task.line, project: best.project)
    }

    private static func isHigherPriority(_ a: PhrenTask, _ aProject: String, than b: PhrenTask, _ bProject: String) -> Bool {
        let aPinned = a.pinned ?? false
        let bPinned = b.pinned ?? false
        if aPinned != bPinned { return aPinned }
        let aRank = a.rank ?? Int.max
        let bRank = b.rank ?? Int.max
        if aRank != bRank { return aRank < bRank }
        return aProject < bProject
    }
}

enum SessionAttentionSelector {
    static func select(_ sessions: [LiveAgentSession]) -> LiveAgentSession? {
        sessions.filter { [.waiting, .working].contains($0.tab.activity) }.sorted { left, right in
            let leftTier = tier(left), rightTier = tier(right)
            if leftTier != rightTier { return leftTier < rightTier }
            let leftSequence = left.tab.changedSeq ?? Int.min
            let rightSequence = right.tab.changedSeq ?? Int.min
            if leftSequence != rightSequence { return leftSequence > rightSequence }
            return AgentSessionEntity(left).id < AgentSessionEntity(right).id
        }.first
    }

    private static func tier(_ session: LiveAgentSession) -> Int {
        if session.tab.approvalPending == true { return 0 }
        return session.tab.activity == .waiting ? 1 : 2
    }
}

private extension SessionControlSnapshot {
    init(_ entity: AgentSessionEntity) {
        self.init(sessionID: entity.id,
                  displayName: "\(entity.project ?? entity.workspace) · \(entity.harnessName ?? "Agent") on \(entity.computer)",
                  computer: entity.computer, state: entity.state?.lowercased() == "permission needed" ? "waiting" : entity.state?.lowercased() ?? "working",
                  hostID: entity.hostID, muxID: entity.muxID,
                  workspaceID: entity.workspaceID ?? "", tabID: entity.tabID ?? "",
                  label: entity.title, agent: entity.agent ?? "codex", cwd: entity.folder ?? "/")
    }
}

/// Serialize writes off the main actor. The file is rewritten when the
/// visible content changes or the sync stamp has moved by at least a minute
/// — not on every ~7s poll, which the widget would never read anyway; only
/// changed visible content spends WidgetKit's refresh budget.
private actor WidgetSnapshotWriter {
    private static let stampInterval: TimeInterval = 60

    private var lastSnapshot: WidgetSnapshot?

    func publish(_ snapshot: WidgetSnapshot) {
        let contentChanged = snapshot.content != lastSnapshot?.content
        guard contentChanged || stampMoved(to: snapshot.lastSyncedAt),
              let url = FileManager.default.containerURL(forSecurityApplicationGroupIdentifier: "group.com.phren.ios")?
                .appendingPathComponent("widget-snapshot.json") else { return }
        let encoder = JSONEncoder(); encoder.dateEncodingStrategy = .iso8601; encoder.outputFormatting = [.sortedKeys]
        do {
            try encoder.encode(snapshot).write(to: url, options: .atomic)
            lastSnapshot = snapshot
            if contentChanged { WidgetCenter.shared.reloadAllTimelines() }
        } catch { /* Keep the previous good snapshot and retry on the next refresh. */ }
    }

    private func stampMoved(to stamp: Date?) -> Bool {
        switch (lastSnapshot?.lastSyncedAt, stamp) {
        case (nil, nil): return lastSnapshot == nil
        case (nil, .some), (.some, nil): return true
        case let (.some(previous), .some(current)):
            return abs(current.timeIntervalSince(previous)) >= Self.stampInterval
        }
    }
}

private actor SessionControlSnapshotWriter {
    private var lastSnapshot: SessionControlSnapshot?
    private var hasPublished = false

    func publish(_ snapshot: SessionControlSnapshot?) {
        guard (!hasPublished || snapshot != lastSnapshot),
              let url = FileManager.default.containerURL(forSecurityApplicationGroupIdentifier: "group.com.phren.ios")?
                .appendingPathComponent(SessionControlSnapshot.filename) else { return }
        do {
            if let snapshot {
                let encoder = JSONEncoder(); encoder.outputFormatting = [.sortedKeys]
                try encoder.encode(snapshot).write(to: url, options: .atomic)
            } else if FileManager.default.fileExists(atPath: url.path) {
                try FileManager.default.removeItem(at: url)
            }
            lastSnapshot = snapshot
            hasPublished = true
            if #available(iOS 18.0, *) {
                ControlCenter.shared.reloadControls(ofKind: "com.phren.ios.widgets.session-attention")
            }
        } catch { /* Keep the previous control snapshot and retry on the next successful refresh. */ }
    }
}
