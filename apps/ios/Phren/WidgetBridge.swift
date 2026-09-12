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

    static func publish(from model: AppModel) async {
        let snapshot = buildSnapshot(from: model)
        await writer.publish(snapshot)
    }

    private static func buildSnapshot(from model: AppModel) -> WidgetSnapshot {
        WidgetSnapshot(
            memoryCount: model.storeContexts.reduce(0) { $0 + $1.snapshot.projects.reduce(0) { $0 + $1.findingCount } },
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
