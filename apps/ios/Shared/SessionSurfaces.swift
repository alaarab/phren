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

struct SessionWorkingActivityAttributes: ActivityAttributes {
    struct ContentState: Codable, Hashable {
        let provider: String
        let project: String
        let branch: String?
        let toolName: String?
        let state: String
        let startedAt: Date
        let expiresAt: Date
    }

    let routeID: String
    let sessionID: String
}

enum SessionWorkingActivityPolicy {
    static let maximumDuration: TimeInterval = 2 * 60 * 60

    enum Action: Equatable { case none, start, update, end }

    static func action(trackedSessionID: String?, incomingSessionID: String, activity: String,
                       optedIn: Bool, startedAt: Date?, now: Date) -> Action {
        if let startedAt, now.timeIntervalSince(startedAt) >= maximumDuration { return .end }
        if trackedSessionID == incomingSessionID {
            return activity == "working" ? .update : .end
        }
        return optedIn && activity == "working" ? .start : .none
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
