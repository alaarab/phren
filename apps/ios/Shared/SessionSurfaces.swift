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
        /// Optional tab role. Missing means an ordinary agent for activities
        /// created by older app versions.
        let role: String?
        let tool: String?
        let computer: String
        /// The model the agent runs, as the Hook's overview named it; nil when
        /// the transcript had not named one yet.
        let model: String?
        /// The current step, already trimmed for the lock screen (`nil` when
        /// only the status shows). Kept as text so the widget never formats.
        let step: String?
        /// The branch, or a worktree folder name when the pane is not on the
        /// project's main checkout; nil when neither is known.
        let branch: String?
        /// The project name's colour, as a `#RRGGBB` string resolved by the
        /// app (the widget cannot read the app's appearance or defaults).
        let projectColor: String?
        /// Running subagents in this session; 0 when none.
        let subagents: Int
        /// Distinct providers among the running children, for the leading glyph stack.
        let childProviders: [String]
        /// Distinct remote computers seen in the child tree. The overview
        /// cannot supply these, so an empty list deliberately means unknown.
        let leadComputers: [String]
        /// "working", "waiting" or "idle"; the lock screen colours the step by it.
        let state: String?
        /// When the agent's current turn or session began, so each row has its
        /// own timer; nil when the Hook never reported one.
        let startedAt: Date?
        /// What a session that just finished said, in one or two plain
        /// sentences (summarized on the phone); nil when none was read.
        let reply: String?

        init(id: String, project: String, provider: String, role: String? = nil,
             tool: String? = nil, computer: String,
             model: String? = nil, step: String? = nil, branch: String? = nil, projectColor: String? = nil,
             subagents: Int = 0, childProviders: [String] = [], leadComputers: [String] = [], state: String? = nil,
             startedAt: Date? = nil, reply: String? = nil) {
            self.id = id; self.project = project; self.provider = provider; self.role = role; self.tool = tool
            self.computer = computer; self.model = model; self.step = step; self.branch = branch
            self.projectColor = projectColor; self.subagents = subagents
            self.childProviders = childProviders; self.leadComputers = leadComputers
            self.state = state; self.startedAt = startedAt; self.reply = reply
        }
        private enum CodingKeys: String, CodingKey { case id, project, provider, role, tool, computer, model, step, branch, projectColor, subagents, childProviders, leadComputers, state, startedAt, reply }
        /// Decode activities created before the step/subagent/model fields too,
        /// so an upgrade does not make an already-live activity undecodable.
        init(from decoder: Decoder) throws {
            let values = try decoder.container(keyedBy: CodingKeys.self)
            id = try values.decode(String.self, forKey: .id)
            project = try values.decode(String.self, forKey: .project)
            provider = try values.decode(String.self, forKey: .provider)
            role = try values.decodeIfPresent(String.self, forKey: .role)
            tool = try values.decodeIfPresent(String.self, forKey: .tool)
            computer = try values.decode(String.self, forKey: .computer)
            model = try values.decodeIfPresent(String.self, forKey: .model)
            step = try values.decodeIfPresent(String.self, forKey: .step)
            branch = try values.decodeIfPresent(String.self, forKey: .branch)
            projectColor = try values.decodeIfPresent(String.self, forKey: .projectColor)
            subagents = try values.decodeIfPresent(Int.self, forKey: .subagents) ?? 0
            childProviders = try values.decodeIfPresent([String].self, forKey: .childProviders) ?? []
            leadComputers = try values.decodeIfPresent([String].self, forKey: .leadComputers) ?? []
            state = try values.decodeIfPresent(String.self, forKey: .state)
            startedAt = try values.decodeIfPresent(Date.self, forKey: .startedAt)
            reply = try values.decodeIfPresent(String.self, forKey: .reply)
        }
    }
    /// The permission request the fleet activity leads with, so one activity
    /// carries both the counts and the Approve / Deny that answers it. Display
    /// text and an opaque local request id only, as `ApprovalActivityAttributes`.
    struct PendingApproval: Codable, Hashable {
        let requestID: String
        let provider: String
        let project: String
        let host: String
        let explanation: String
        let expiresAt: Date
        /// A question is answered in the app, where its choices are shown.
        let question: Bool

        var headline: String { question ? "\(provider) has a question" : "\(provider) needs approval" }
        /// `phren://approval?request=`: the request's own conversation.
        var openURL: URL? {
            var components = URLComponents()
            components.scheme = "phren"; components.host = "approval"
            components.queryItems = [URLQueryItem(name: "request", value: requestID)]
            return components.url
        }
    }
    struct ContentState: Codable, Hashable {
        let working: Int
        let waiting: Int
        let entries: [Entry]
        let startedAt: Date
        /// Agents beyond the rows the lock screen shows, for its "+N more" line.
        let more: Int
        /// Distinct computers the listed agents run on.
        let computers: Int
        /// The permission request the activity leads with, if one waits.
        var approval: PendingApproval?
        /// Sessions that need the owner: those waiting, and at least the one
        /// whose request the activity carries.
        var needsYou: Int { max(waiting, approval == nil ? 0 : 1) }
        /// "3 working · 1 needs you", the island's and lock screen's one line.
        var headline: String {
            var parts: [String] = []
            if working > 0 { parts.append("\(working) working") }
            if needsYou > 0 { parts.append("\(needsYou) needs you") }
            if parts.isEmpty { parts.append(entries.count + more == 1 ? "1 agent" : "\(entries.count + more) agents") }
            if computers > 1 { parts.append("\(computers) computers") }
            return parts.joined(separator: " · ")
        }
        /// "N agents · M computers", the one line above the per-agent rows.
        /// N counts the listed rows plus those past the cap; M their computers.
        var summary: String { "\(entries.count + more) agents · \(computers) computers" }
        /// The row the lock screen leads with: the pinned session when there is
        /// one, otherwise the first row in waiting-first order.
        var primary: Entry? { entries.first }

        init(working: Int, waiting: Int, entries: [Entry], startedAt: Date, more: Int = 0, computers: Int = 0,
             approval: PendingApproval? = nil) {
            self.working = working; self.waiting = waiting; self.entries = entries; self.startedAt = startedAt
            self.more = more; self.computers = computers; self.approval = approval
        }
        private enum CodingKeys: String, CodingKey { case working, waiting, entries, startedAt, more, computers, approval }
        /// Decode activities created before the aggregate upgrade too, so the
        /// app can find and replace/end them instead of leaving an orphan.
        init(from decoder: Decoder) throws {
            let values = try decoder.container(keyedBy: CodingKeys.self)
            working = try values.decodeIfPresent(Int.self, forKey: .working) ?? 1
            waiting = try values.decodeIfPresent(Int.self, forKey: .waiting) ?? 0
            entries = try values.decodeIfPresent([Entry].self, forKey: .entries) ?? []
            startedAt = try values.decode(Date.self, forKey: .startedAt)
            more = try values.decodeIfPresent(Int.self, forKey: .more) ?? 0
            computers = try values.decodeIfPresent(Int.self, forKey: .computers) ?? Set(entries.map(\.computer)).count
            approval = try values.decodeIfPresent(PendingApproval.self, forKey: .approval)
        }
    }
    let routeID: String
}

/// Stable input independent of ActivityKit or a real computer. The controller
/// retains each start across title/tool changes and merges the open chat by ID.
enum SessionWorkingActivityBuilder {
    /// The rows the lock screen draws; the rest are counted, not listed.
    static let maxEntries = 5
    /// How long a just-finished agent keeps its green row before it drops off.
    static let finishingGrace: TimeInterval = 60

    struct Session: Equatable {
        let entry: SessionWorkingActivityAttributes.Entry
        let state: String
        let startedAt: Date
    }
    struct Presentation: Equatable {
        let state: String
        let step: String?
    }
    /// A session remains active while its workers run. The parent's own step
    /// wins when it is working too.
    static func presentation(state: String, step: String?, runningChildren: Int) -> Presentation {
        guard state == "idle", runningChildren > 0 else { return .init(state: state, step: step) }
        return .init(state: "working", step: "\(runningChildren) \(runningChildren == 1 ? "worker" : "workers")")
    }
    static func build(_ sessions: [Session], pinnedID: String? = nil, now: Date) -> SessionWorkingActivityAttributes.ContentState {
        let unique = Dictionary(sessions.map { ($0.entry.id, $0) }, uniquingKeysWith: { _, latest in latest }).values
        let waiting = unique.filter { $0.state == "waiting" }
        let working = unique.filter { $0.state == "working" }
        // A finish stays a moment so its green row is not yanked as it lands.
        let finishing = unique.filter { $0.state == "idle" && now.timeIntervalSince($0.startedAt) < finishingGrace }
        func rank(_ session: Session) -> Int { session.state == "waiting" ? 0 : session.state == "working" ? 1 : 2 }
        let ordered = (Array(waiting) + Array(working) + Array(finishing)).sorted {
            if ($0.entry.id == pinnedID) != ($1.entry.id == pinnedID) { return $0.entry.id == pinnedID }
            if rank($0) != rank($1) { return rank($0) < rank($1) }
            if $0.state == "working", $0.startedAt != $1.startedAt { return $0.startedAt < $1.startedAt }
            return $0.entry.id < $1.entry.id
        }
        let entries = Array(ordered.prefix(maxEntries).map(\.entry))
        let total = waiting.count + working.count + finishing.count
        return .init(working: working.count, waiting: waiting.count, entries: entries,
                     startedAt: working.map(\.startedAt).min() ?? now,
                     more: max(0, total - entries.count),
                     computers: Set(ordered.map(\.entry.computer)).count)
    }
}

enum SessionWorkingActivityPolicy {
    static let updateInterval: TimeInterval = 2
    static let quietInterval: TimeInterval = 30
    static func shouldEnd(working: Int, quietSince: Date?, now: Date) -> Bool {
        working == 0 && quietSince.map { now.timeIntervalSince($0) >= quietInterval } == true
    }
}
