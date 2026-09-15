import PhrenKit
import SwiftUI

extension LiveWorkspaces.Tab.Activity {
    var color: Color {
        switch self {
        case .working: PhrenTheme.stateWorking
        case .waiting: PhrenTheme.stateWaiting
        case .error: PhrenTheme.danger
        case .done: PhrenTheme.stateDone
        case .idle, .unknown: PhrenTheme.textMuted
        }
    }
    var icon: String {
        switch self {
        case .working: "bolt.fill"
        case .waiting: "pause.fill"
        case .error: "exclamationmark"
        case .done: "checkmark"
        case .idle: "moon"
        case .unknown: "questionmark"
        }
    }
}

/// Shared compact content for overview, computer, and project session lists.
///
/// Reads top-down the way you ask about a session: *which project* (bold,
/// with its branch), *which conversation* (the tab title), *what's happening*
/// (a state line in the state's colour). On the left, the harness's own mark
/// sits inside a ring that carries the state — cyan and spinning while it
/// works, amber when it needs you, green when done, grey when idle — with the
/// context used drawn as the ring's fill and a small state badge at its foot.
struct SessionCardContent: View {
    @Environment(\.dynamicTypeSize) private var textSize
    let session: LiveAgentSession
    let fresh: Bool
    /// The project name the store matched to this session, when it has one.
    var project: String? = nil
    /// The computer, shown when the list spans several.
    var computer: String? = nil
    /// Kept for callers that build their own line; unused when `project` is given.
    var subtitle: String = ""
    let identifierPrefix: String
    /// Tapping the ring opens the session's details; nil makes it inert.
    var onDetails: (() -> Void)? = nil

    private var headline: String { session.projectDisplayName(project) }
    /// The quiet last line. The list is already sectioned by state, so the
    /// state itself is only the dot's colour here; words are for what the
    /// section can't say — a permission waiting, a stale computer — and the
    /// computer's name when the list spans several.
    private var state: String {
        var parts: [String] = []
        if session.tab.approvalPending == true { parts.append("Permission needed") }
        if !fresh { parts.append("Stale") }
        if let computer { parts.append(computer) }
        return parts.joined(separator: " · ")
    }
    private var stateColor: Color { fresh ? session.tab.activity.color : PhrenTheme.textMuted }

    var body: some View {
        HStack(spacing: 10) {
            Button { onDetails?() } label: {
                SessionActivityIndicator(tab: session.tab, fresh: fresh)
                    .accessibilityIdentifier("\(identifierPrefix)-context:\(session.accessibilityKey)")
                    .frame(width: 44, height: 44).contentShape(Rectangle())
            }
            .buttonStyle(.plain).disabled(onDetails == nil)
            .accessibilityLabel("\(session.tab.agent?.capitalized ?? "Agent"), \(session.tab.status)")
            .accessibilityValue(session.tab.contextUsedPercent.map { "context \(Int($0.rounded()))%" } ?? "")
            .accessibilityHint("Session details")
            .accessibilityIdentifier(identifierPrefix == "live" ? "live-detail:\(session.workspaceID):\(session.tab.id)" : "\(identifierPrefix)-detail:\(session.accessibilityKey)")
            VStack(alignment: .leading, spacing: 2) {
                HStack(spacing: 6) {
                    if session.usesFolderFallback(mappedProject: project) {
                        Image(systemName: "folder").font(.caption).foregroundStyle(PhrenTheme.textMuted)
                            .accessibilityLabel("Folder")
                    }
                    Text(headline).font(.subheadline.weight(.semibold)).foregroundStyle(PhrenTheme.sessionProject).lineLimit(1)
                    if let branch = session.tab.branch, !branch.isEmpty {
                        HStack(spacing: 3) {
                            Image(systemName: "arrow.triangle.branch").font(.system(size: 9, weight: .semibold))
                            Text(branch).lineLimit(1).truncationMode(.middle)
                        }.font(.system(.caption2, design: .monospaced)).foregroundStyle(PhrenTheme.chatNeutral)
                    }
                }
                if session.tab.displayTitle != headline {
                    Text(session.tab.displayTitle).font(.footnote).foregroundStyle(PhrenTheme.sessionTitle)
                        .lineLimit(textSize.isAccessibilitySize ? 3 : 1)
                }
                if !state.isEmpty || !subtitle.isEmpty {
                    HStack(spacing: 5) {
                        Circle().fill(stateColor).frame(width: 6, height: 6)
                            .accessibilityLabel(session.tab.status)
                        if !state.isEmpty {
                            Text(state).font(.caption2.weight(.medium))
                                .foregroundStyle(session.tab.approvalPending == true || !fresh ? stateColor : PhrenTheme.sessionMeta)
                        }
                        if !subtitle.isEmpty, project == nil { Text("· " + subtitle).font(.caption2).foregroundStyle(PhrenTheme.sessionMeta).lineLimit(1) }
                    }
                }
            }.frame(maxWidth: .infinity, alignment: .leading)
        }
        .padding(.leading, 10).padding(.trailing, 2).padding(.vertical, 8)
        .frame(minHeight: 64)
        .overlay(alignment: .leading) {
            // A bar on the edge for the states that want a glance: working, and needs you.
            if fresh, session.tab.activity == .working || session.tab.activity == .waiting {
                Capsule().fill(stateColor).frame(width: 3, height: 26)
                    .accessibilityLabel(session.tab.activity == .working ? "Agent is active" : "Agent needs you")
                    .accessibilityIdentifier("\(identifierPrefix)-running:\(session.accessibilityKey)")
            }
        }
        .contentShape(Rectangle())
    }
}

private struct SessionActivityIndicator: View {
    let tab: LiveWorkspaces.Tab
    let fresh: Bool
    private var color: Color { fresh ? tab.activity.color : PhrenTheme.textMuted }
    private var percent: Double? { tab.contextUsedPercent }

    var body: some View {
        ZStack {
            Circle().stroke(color.opacity(0.22), lineWidth: 2).frame(width: 36, height: 36)
            if let percent {
                // Context used, as how much of the ring is lit.
                Circle().trim(from: 0, to: percent / 100)
                    .stroke(color.opacity(fresh ? 0.85 : 0.4), style: StrokeStyle(lineWidth: 2, lineCap: .round))
                    .rotationEffect(.degrees(-90)).frame(width: 36, height: 36)
            }
            if fresh && tab.activity == .working {
                SessionActivityArc(color: color).frame(width: 42, height: 42)
            }
            AgentProviderGlyph(source: tab.agent, size: 20).opacity(fresh ? 1 : 0.55)
        }
        .frame(width: 42, height: 42)
        .overlay(alignment: .bottomTrailing) {
            // What it is doing, on the ring's foot.
            Image(systemName: tab.activity.icon).font(.system(size: 7.5, weight: .bold))
                .foregroundStyle(tab.activity == .idle || tab.activity == .unknown ? PhrenTheme.textMuted : Color.black.opacity(0.85))
                .frame(width: 15, height: 15)
                .background(tab.activity == .idle || tab.activity == .unknown ? PhrenTheme.surface : color, in: Circle())
                .overlay(Circle().strokeBorder(PhrenTheme.bg, lineWidth: 1.5))
                .offset(x: 2, y: 2)
        }
        .accessibilityElement(children: .ignore)
        .accessibilityLabel("\(tab.agent?.capitalized ?? "Agent"), \(tab.status)")
        .accessibilityValue(percent.map { "context \(Int($0.rounded()))%" } ?? "")
    }
}

/// Animate only the arc's transform, without a per-frame timeline or a 20 Hz cap.
/// Ordinary snapshot/context updates preserve the ongoing rotation.
private struct SessionActivityArc: View {
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @Environment(\.scenePhase) private var scenePhase
    @State private var visible = false
    @State private var spinning = false
    let color: Color
    private var shouldAnimate: Bool { visible && scenePhase == .active && !reduceMotion }

    var body: some View {
        Circle().trim(from: 0, to: 0.22)
            .stroke(color, style: StrokeStyle(lineWidth: 1.5, lineCap: .round))
            .rotationEffect(.degrees(spinning ? 270 : -90))
            .animation(spinning ? .linear(duration: 0.9).repeatForever(autoreverses: false) : nil,
                       value: spinning)
            .onAppear { visible = true }
            .onDisappear { visible = false; spinning = false }
            .onChange(of: shouldAnimate, initial: true) { _, active in spinning = active }
    }
}

struct SessionPinButton: View {
    let session: LiveAgentSession
    let pinned: Bool
    let identifierPrefix: String
    @Binding var data: Data
    @State private var error: String?

    var body: some View {
        Button {
            do {
                let current = try LiveSessionPreferences.read(data)
                data = try LiveSessionPreferences.setPinned(!current.isPinned(session.id), for: session.id, in: data)
            } catch { self.error = error.localizedDescription }
        } label: {
            Image(systemName: pinned ? "pin.fill" : "pin")
                .font(.system(size: 13, weight: .medium))
                .foregroundStyle(pinned ? PhrenTheme.cyan : PhrenTheme.textDim)
                .frame(width: 44, height: 44).contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .accessibilityLabel(pinned ? "Unpin session" : "Pin session")
        .accessibilityIdentifier("\(identifierPrefix)-pin:\(session.accessibilityKey)")
        .alert("Couldn't update pin", isPresented: $error.isPresent()) {
            Button("OK", role: .cancel) { error = nil }
        } message: { Text(error ?? "") }
    }
}

extension LiveAgentSession {
    // Accessibility names retain the existing overview destination format;
    // persistence uses the structured ID, never this display-only string.
    var accessibilityKey: String { "\(host.id):\(host.muxID):\(workspaceID):\(tab.id)" }
}

extension View {
    /// Each session in its own outlined card, on the plain page: no box
    /// around the section and no lines between rows (`separatedSessionRow`).
    func sessionCard() -> some View {
        self.background(PhrenTheme.surface, in: RoundedRectangle(cornerRadius: 12))
            .overlay(RoundedRectangle(cornerRadius: 12).strokeBorder(PhrenTheme.border, lineWidth: 1))
    }

    func separatedSessionRow() -> some View {
        self.listRowInsets(EdgeInsets(top: 5, leading: 0, bottom: 5, trailing: 0))
            .listRowSeparator(.hidden, edges: .all).listRowBackground(Color.clear)
    }
}
