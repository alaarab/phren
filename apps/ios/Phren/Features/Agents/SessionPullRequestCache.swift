import Foundation
import PhrenKit
import PhrenLive
import SwiftUI

/// The pull request each session's branch has, as `/v1/git/pulls` last
/// reported it. The card never asks on its own: the Changes screen records
/// what it loads, and the overview's refresh (its first reveal, pull to
/// refresh, Refresh all sessions) asks again for sessions on a known branch.
/// Kept on disk so a card shows its last known state after a relaunch.
@Observable @MainActor
final class SessionPullRequestCache {
    static let shared = SessionPullRequestCache()

    struct Entry: Codable, Equatable {
        let branch: String
        let pull: GitPulls.Current
    }

    private(set) var entries: [String: Entry] = [:]
    @ObservationIgnored private var refreshing = false
    @ObservationIgnored private var revealed = false
    private static let storageKey = "sessions.pullRequests.v1"
    private static let maximumEntries = 64

    init() {
        // UI tests start from nothing so a fixture decides what the card shows.
        guard !AppModel.isUITesting, let data = UserDefaults.standard.data(forKey: Self.storageKey),
              let stored = try? JSONDecoder().decode([String: Entry].self, from: data) else { return }
        entries = stored
    }

    static func key(_ id: LiveAgentSession.ID) -> String {
        "\(id.hostID.uuidString)|\(id.muxID)|\(id.workspace)|\(id.tab)"
    }

    /// The card's pull request, only while the session is still on the branch
    /// it was recorded for. A tab whose branch Herdr does not report keeps the
    /// Hook's own answer.
    func pull(for session: LiveAgentSession) -> GitPulls.Current? {
        guard let entry = entries[Self.key(session.id)] else { return nil }
        if let branch = session.tab.branch, !branch.isEmpty, branch != entry.branch { return nil }
        return entry.pull
    }

    /// Record the pane's own pulls answer. No pull request for the branch, or
    /// gh unavailable, clears the chip rather than leaving an old one.
    func record(_ pulls: GitPulls, for session: LiveAgentSession) {
        let key = Self.key(session.id)
        var next: Entry?
        if pulls.available, let current = pulls.current {
            next = Entry(branch: pulls.branch ?? current.head, pull: current)
        }
        guard entries[key] != next else { return }
        entries[key] = next
        if entries.count > Self.maximumEntries, let oldest = entries.keys.sorted().first(where: { $0 != key }) {
            entries[oldest] = nil
        }
        save()
    }

    /// The overview's first reveal after launch counts as its first refresh.
    func refreshOnReveal(_ sessions: [LiveAgentSession]) {
        guard !revealed else { return }
        revealed = true
        Task { await refresh(sessions) }
    }

    /// Ask again for sessions on a known branch (or with a recorded pull
    /// request), a few at a time, on computers serving the Changes routes.
    func refresh(_ sessions: [LiveAgentSession]) async {
        guard !refreshing else { return }
        refreshing = true
        defer { refreshing = false }
        let candidates = sessions.filter { session in
            (session.tab.branch?.isEmpty == false || entries[Self.key(session.id)] != nil)
                && SessionOverviewMonitor.shared.allows(.changes, on: session.host, fallback: session.capabilities)
        }.prefix(12)
        await withTaskGroup(of: (LiveAgentSession, GitPulls?).self) { group in
            var pending = Array(candidates)
            func next() {
                guard !pending.isEmpty else { return }
                let session = pending.removeFirst()
                group.addTask { (session, try? await Self.fetch(session)) }
            }
            for _ in 0..<3 { next() }
            while let (session, pulls) = await group.next() {
                if let pulls { record(pulls, for: session) }
                next()
            }
        }
    }

    private static func fetch(_ session: LiveAgentSession) async throws -> GitPulls? {
        #if DEBUG && targetEnvironment(simulator)
        if AgentChatFixture.enabled { return try AgentChatFixture.pulls() }
        #endif
        let panes = try await AgentChatModel.fetchPanes(session)
        guard let pane = panes.panes.first(where: { $0.agent != nil }), let sessionID = pane.sessionId else { return nil }
        let target = try AgentChatTarget(hostID: session.host.id, workspaceID: session.workspaceID,
            tabID: session.tab.id, paneID: pane.id, source: pane.agent ?? session.tab.agent ?? "codex",
            sessionID: sessionID, muxID: session.host.muxID)
        return try await PhrenConnection.gitPulls(host: session.host, privateKey: DeviceSSHKey.load(session.host.id), target: target)
    }

    private func save() {
        guard !AppModel.isUITesting, let data = try? JSONEncoder().encode(entries) else { return }
        UserDefaults.standard.set(data, forKey: Self.storageKey)
    }
}

/// The session card's pull request: number, state, and a checks mark.
struct SessionPullRequestChip: View {
    let pull: GitPulls.Current

    var body: some View {
        HStack(spacing: 3) {
            Image(systemName: "arrow.triangle.pull").font(PhrenTypography.icon(9, weight: .semibold))
            Text("#\(pull.number)").fontWeight(.medium)
            Text(pull.stateLabel)
            if let checks = pull.checks {
                Image(systemName: Self.checksIcon(checks)).font(PhrenTypography.icon(9, weight: .bold))
                    .foregroundStyle(Self.checksColor(checks))
            }
        }
        .font(PhrenTypography.monoCaption2)
        .foregroundStyle(Self.stateColor(pull))
        .padding(.horizontal, 5).padding(.vertical, 1)
        .background(Self.stateColor(pull).opacity(0.14), in: Capsule())
        .lineLimit(1)
        .fixedSize()
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(Self.spoken(pull))
    }

    static func stateColor(_ pull: GitPulls.Current) -> Color {
        if pull.draft && pull.state == .open { return PhrenTheme.textMuted }
        switch pull.state {
        case .open: return PhrenTheme.success
        case .merged: return PhrenTheme.violet
        case .closed: return PhrenTheme.danger
        case .unknown: return PhrenTheme.textMuted
        }
    }

    static func checksIcon(_ checks: GitPulls.Checks) -> String {
        switch checks {
        case .passing: "checkmark"
        case .failing: "xmark"
        case .pending: "clock"
        }
    }

    static func checksColor(_ checks: GitPulls.Checks) -> Color {
        switch checks {
        case .passing: PhrenTheme.success
        case .failing: PhrenTheme.danger
        case .pending: PhrenTheme.warning
        }
    }

    static func spoken(_ pull: GitPulls.Current) -> String {
        var words = "Pull request \(pull.number), \(pull.stateLabel)"
        if let checks = pull.checks { words += ", checks \(checks.rawValue)" }
        return words
    }
}
