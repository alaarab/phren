import ActivityKit
import AppIntents
import Foundation

/// Small app-group payload for the iOS 18 Control Center / Lock Screen control.
/// It contains a local route, never SSH credentials or conversation content.
struct SessionControlSnapshot: Codable, Equatable, Sendable {
    static let filename = "session-control.json"

    let sessionID: String
    let displayName: String
    let computer: String
    let state: String
    let hostID: UUID
    let muxID: String
    let workspaceID: String
    let tabID: String
    let label: String
    let agent: String
    let cwd: String
}

/// Controls execute this intent in the containing app so navigation uses the
/// same pending-session handoff as Siri and Spotlight.
struct OpenAttentionSessionIntent: AppIntent {
    static var title: LocalizedStringResource = "Open Session Needing Attention"
    static var description = IntentDescription("Opens the live agent session that most needs your attention.")
    static var openAppWhenRun = true
    static var authenticationPolicy: IntentAuthenticationPolicy = .requiresAuthentication

    @MainActor
    func perform() async throws -> some IntentResult {
        #if PHREN_APP
        try WidgetBridge.openAttentionSession()
        #else
        throw NSError(domain: "PhrenControl", code: 1,
                      userInfo: [NSLocalizedDescriptionKey: "Open phren to refresh live sessions."])
        #endif
        return .result()
    }
}

/// Whether the agents Live Activity is wanted at all. Written by the app,
/// read by the Control Center toggle from the app group.
struct WorkingActivityPreference: Codable, Equatable, Sendable {
    static let filename = "working-activity.json"
    static let appGroupID = "group.com.phren.ios"
    var enabled: Bool

    static func load() -> WorkingActivityPreference {
        guard let url = FileManager.default.containerURL(forSecurityApplicationGroupIdentifier: appGroupID)?.appendingPathComponent(filename),
              let data = try? Data(contentsOf: url), let value = try? JSONDecoder().decode(Self.self, from: data) else { return .init(enabled: true) }
        return value
    }
    func save() throws {
        guard let url = FileManager.default.containerURL(forSecurityApplicationGroupIdentifier: Self.appGroupID)?.appendingPathComponent(Self.filename) else { return }
        try JSONEncoder().encode(self).write(to: url, options: .atomic)
    }
}

/// Control Center toggle: show or hide the agents Live Activity. Runs in the
/// app so the activity itself is started and ended by its owner.
struct ToggleWorkingActivityIntent: SetValueIntent {
    static var title: LocalizedStringResource = "Agents Live Activity"
    static var description = IntentDescription("Shows or hides the Live Activity that counts your working agents.")
    static var authenticationPolicy: IntentAuthenticationPolicy = .requiresAuthentication

    @Parameter(title: "Shown")
    var value: Bool

    init() {}
    init(value: Bool) { self.value = value }

    @MainActor
    func perform() async throws -> some IntentResult {
        try WorkingActivityPreference(enabled: value).save()
        #if PHREN_APP
        await SessionWorkingActivityController.shared.setEnabled(value)
        #endif
        return .result()
    }
}

struct SessionWorkingActivityAttributes: ActivityAttributes {
    struct Entry: Codable, Hashable, Identifiable {
        let id: String
        let project: String
        let provider: String
        let tool: String?
        let computer: String
    }
    struct ContentState: Codable, Hashable {
        let working: Int
        let waiting: Int
        let entries: [Entry]
        let startedAt: Date
        var headline: String { waiting > 0 ? "\(working) working · \(waiting) waiting" : "\(working) agents working" }

        init(working: Int, waiting: Int, entries: [Entry], startedAt: Date) {
            self.working = working; self.waiting = waiting; self.entries = entries; self.startedAt = startedAt
        }
        private enum CodingKeys: String, CodingKey { case working, waiting, entries, startedAt }
        /// Decode activities created before the aggregate upgrade too, so the
        /// app can find and replace/end them instead of leaving an orphan.
        init(from decoder: Decoder) throws {
            let values = try decoder.container(keyedBy: CodingKeys.self)
            working = try values.decodeIfPresent(Int.self, forKey: .working) ?? 1
            waiting = try values.decodeIfPresent(Int.self, forKey: .waiting) ?? 0
            entries = try values.decodeIfPresent([Entry].self, forKey: .entries) ?? []
            startedAt = try values.decode(Date.self, forKey: .startedAt)
        }
    }
    let routeID: String
}

/// Stable input independent of ActivityKit or a real computer. The controller
/// retains each start across title/tool changes and merges the open chat by ID.
enum SessionWorkingActivityBuilder {
    struct Session: Equatable {
        let entry: SessionWorkingActivityAttributes.Entry
        let state: String
        let startedAt: Date
    }
    static func build(_ sessions: [Session], pinnedID: String? = nil, now: Date) -> SessionWorkingActivityAttributes.ContentState {
        let unique = Dictionary(sessions.map { ($0.entry.id, $0) }, uniquingKeysWith: { _, latest in latest }).values
        let working = unique.filter { $0.state == "working" }
        let waiting = unique.filter { $0.state == "waiting" }
        let visible = (Array(working) + Array(waiting)).sorted {
            if ($0.entry.id == pinnedID) != ($1.entry.id == pinnedID) { return $0.entry.id == pinnedID }
            if $0.state != $1.state { return $0.state == "working" }
            if $0.state == "working", $0.startedAt != $1.startedAt { return $0.startedAt < $1.startedAt }
            return $0.entry.id < $1.entry.id
        }
        return .init(working: working.count, waiting: waiting.count, entries: Array(visible.prefix(4).map(\.entry)),
                     startedAt: working.map(\.startedAt).min() ?? now)
    }
}

enum SessionWorkingActivityPolicy {
    static let updateInterval: TimeInterval = 2
    static let quietInterval: TimeInterval = 30
    static func shouldEnd(working: Int, quietSince: Date?, now: Date) -> Bool {
        working == 0 && quietSince.map { now.timeIntervalSince($0) >= quietInterval } == true
    }
}

enum SessionElapsedTime {
    static func format(from startedAt: Date, to now: Date) -> String {
        let seconds = max(0, Int(now.timeIntervalSince(startedAt)))
        let hours = seconds / 3_600
        let minutes = seconds % 3_600 / 60
        let remainder = seconds % 60
        return hours > 0
            ? String(format: "%d:%02d:%02d", hours, minutes, remainder)
            : String(format: "%d:%02d", minutes, remainder)
    }
}
