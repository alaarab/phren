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
struct SessionCardContent: View, Equatable {
    @Environment(\.dynamicTypeSize) private var textSize
    let session: LiveAgentSession
    let fresh: Bool
    /// The computer answered before and its answer aged out. A computer still
    /// being reached shows its cached card without the Stale word.
    var stale = false
    /// The project name the store matched to this session, when it has one.
    var project: String? = nil
    /// The store the matched project lives in, so its name can take the
    /// per-project colour chosen on this phone.
    var projectStoreId: String? = nil
    /// The computer, shown when the list spans several.
    var computer: LiveHost? = nil
    /// Kept for callers that build their own line; unused when `project` is given.
    var subtitle: String = ""
    let identifierPrefix: String
    /// Tapping the ring opens the session's details; nil makes it inert.
    var onDetails: (() -> Void)? = nil

    static func == (lhs: Self, rhs: Self) -> Bool {
        lhs.session == rhs.session && lhs.fresh == rhs.fresh && lhs.stale == rhs.stale && lhs.project == rhs.project
            && lhs.projectStoreId == rhs.projectStoreId
            && lhs.computer == rhs.computer && lhs.subtitle == rhs.subtitle
            && lhs.identifierPrefix == rhs.identifierPrefix && (lhs.onDetails == nil) == (rhs.onDetails == nil)
    }

    private var headline: String { session.projectDisplayName(project) }
    private var headlineColor: Color {
        guard let project = project, let projectStoreId = projectStoreId else { return PhrenTheme.sessionProject }
        return PhrenTheme.projectColor(storeId: projectStoreId, project: project)
    }
    /// The quiet last line. The list is already sectioned by state, so the
    /// state itself is only the dot's colour here; words are for what the
    /// section can't say — a permission waiting, a stale computer — and the
    /// computer's name when the list spans several.
    /// Only what the section can't say: a permission waiting, a stale
    /// computer. The computer's name rides the first line, next to the branch.
    private var state: String {
        var parts: [String] = []
        if session.tab.approvalPending == true { parts.append("Permission needed") }
        if stale { parts.append("Stale") }
        return parts.joined(separator: " · ")
    }
    private var stateColor: Color { fresh ? session.tab.activity.color : PhrenTheme.textMuted }

    var body: some View {
        #if DEBUG
        let _ = ProcessInfo.processInfo.environment["PHREN_PERFORMANCE_LOG"] == "1" ? Self._printChanges() : ()
        #endif
        HStack(spacing: PhrenTheme.Space.small) {
            Button { onDetails?() } label: {
                SessionActivityIndicator(tab: session.tab, fresh: fresh)
                    .accessibilityIdentifier("\(identifierPrefix)-context:\(session.accessibilityKey)")
                    .frame(width: 44, height: 44).contentShape(Rectangle())
            }
            .buttonStyle(.plain).disabled(onDetails == nil)
            .accessibilityLabel("\(session.tab.isConductor ? "Conductor" : session.tab.agent?.capitalized ?? "Agent"), \(session.tab.status)")
            .accessibilityValue(session.tab.contextUsedPercent.map { "context \(Int($0.rounded()))%" } ?? "")
            .accessibilityHint("Session details")
            .accessibilityIdentifier(identifierPrefix == "live" ? "live-detail:\(session.workspaceID):\(session.tab.id)" : "\(identifierPrefix)-detail:\(session.accessibilityKey)")
            VStack(alignment: .leading, spacing: 2) {
                HStack(spacing: 6) {
                    if session.usesFolderFallback(mappedProject: project) {
                        Image(systemName: "folder").font(.caption).foregroundStyle(PhrenTheme.textMuted)
                            .accessibilityLabel("Folder")
                    }
                    Text(headline).font(.subheadline.weight(.semibold)).foregroundStyle(headlineColor).lineLimit(1)
                    // Where in the code, then where it runs — one quiet line.
                    if let branch = session.tab.branch, !branch.isEmpty {
                        HStack(spacing: 3) {
                            Image(systemName: "arrow.triangle.branch").font(.system(size: 9, weight: .semibold))
                            Text(branch).lineLimit(1).truncationMode(.middle)
                        }.font(.system(.caption2, design: .monospaced)).foregroundStyle(PhrenTheme.chatNeutral)
                            .layoutPriority(-1)
                    }
                    if let computer {
                        HStack(spacing: 3) {
                            Image(systemName: "desktopcomputer").font(.system(size: 9, weight: .semibold))
                                .foregroundStyle(PhrenTheme.sessionMeta)
                            Text(computer.name).lineLimit(1).fontWeight(.medium)
                                .foregroundStyle(PhrenTheme.hostColor(computer.color ?? LiveHost.defaultColor(for: computer.id)))
                                .accessibilityLabel("on \(computer.name)")
                                .accessibilityIdentifier("session-computer-name")
                        }.font(.system(.caption2, design: .monospaced))
                    }
                    if let changedAt = session.tab.lastChangedAt {
                        SessionRelativeTimeLabel(changedAt: changedAt)
                            .accessibilityIdentifier("\(identifierPrefix)-changed:\(session.accessibilityKey)")
                    }
                }
                if session.tab.isConductor {
                    HStack(spacing: 4) {
                        Text("Conductor").fontWeight(.semibold).foregroundStyle(PhrenTheme.accent)
                        Text("· " + session.tab.displayTitle).foregroundStyle(PhrenTheme.sessionTitle)
                    }
                    .font(.footnote).lineLimit(textSize.isAccessibilitySize ? 3 : 1)
                } else if session.tab.displayTitle != headline {
                    Text(session.tab.displayTitle).font(.footnote).foregroundStyle(PhrenTheme.sessionTitle)
                        .lineLimit(textSize.isAccessibilitySize ? 3 : 1)
                }
                if !state.isEmpty || !subtitle.isEmpty {
                    HStack(spacing: 5) {
                        Circle().fill(stateColor).frame(width: 6, height: 6)
                            .accessibilityLabel(session.tab.status)
                        if !state.isEmpty {
                            Text(state).font(.caption2.weight(.medium))
                                .foregroundStyle(session.tab.approvalPending == true || stale ? stateColor : PhrenTheme.sessionMeta)
                        }
                        if !subtitle.isEmpty, project == nil { Text("· " + subtitle).font(.caption2).foregroundStyle(PhrenTheme.sessionMeta).lineLimit(1) }
                    }
                }
            }.frame(maxWidth: .infinity, alignment: .leading)
        }
        .padding(.leading, PhrenTheme.Space.medium).padding(.trailing, PhrenTheme.Space.xs).padding(.vertical, PhrenTheme.Space.xs)
        .frame(minHeight: 56)
        .overlay(alignment: .leading) {
            // A bar on the edge for the states that want a glance: working, and needs you.
            if fresh, session.tab.activity == .working || session.tab.activity == .waiting {
                Capsule().fill(stateColor).frame(width: 3, height: 26)
                    .accessibilityLabel(session.tab.activity == .working ? "Agent is active" : "Agent needs you")
                    .accessibilityIdentifier("\(identifierPrefix)-running:\(session.accessibilityKey)")
            }
        }
        .contentShape(Rectangle())
        .overlay(alignment: .topLeading) {
            if session.tab.isConductor {
                Color.clear.frame(width: 0, height: 0).accessibilityElement()
                    .accessibilityLabel("Conductor")
                    .accessibilityIdentifier("conductor-card:\(session.accessibilityKey)")
            }
        }
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
            if tab.isConductor {
                Image(systemName: "wand.and.rays")
                    .font(.system(size: 18, weight: .semibold))
                    .foregroundStyle(PhrenTheme.accent)
                    .opacity(fresh ? 1 : 0.55)
                    .accessibilityHidden(true)
            } else {
                AgentProviderGlyph(source: tab.agent, size: 20).opacity(fresh ? 1 : 0.55)
            }
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
        .accessibilityLabel("\(tab.isConductor ? "Conductor" : tab.agent?.capitalized ?? "Agent"), \(tab.status)")
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
    /// One rectangle per session, the way Moshi draws them: a flat rounded
    /// fill, no border, and (`separatedSessionRow`) nothing grouping the
    /// section's cards or drawn between them.
    func sessionCard() -> some View {
        self.background(PhrenTheme.surface, in: RoundedRectangle(cornerRadius: PhrenTheme.Radius.medium, style: .continuous))
    }

    /// A row below the sessions (a computer, a setup link) in the same plain
    /// list: its own small card, the same margins as the session cards.
    func plainListCardRow() -> some View {
        self.padding(.horizontal, 12).padding(.vertical, 8)
            .listRowInsets(EdgeInsets(top: 3, leading: 14, bottom: 3, trailing: 14))
            .listRowSeparator(.hidden, edges: .all)
            .listRowBackground(
                RoundedRectangle(cornerRadius: 14, style: .continuous).fill(PhrenTheme.surface)
                    .padding(.horizontal, 14).padding(.vertical, 3))
    }

    /// A small upper-case section label for the plain sessions list.
    func plainListSectionLabel() -> some View {
        self.font(.caption.weight(.semibold)).foregroundStyle(PhrenTheme.textMuted).textCase(.uppercase).tracking(0.6)
            .padding(.leading, 14).padding(.top, 8)
            .listRowInsets(EdgeInsets(top: 6, leading: 0, bottom: 2, trailing: 0))
    }

    /// plainListSectionLabel's typography without its list padding, for a
    /// label that shares a row with chips or a chevron (the Tasks headers).
    func plainListSectionTypography() -> some View {
        self.font(.caption.weight(.semibold)).foregroundStyle(PhrenTheme.textMuted).textCase(.uppercase).tracking(0.6)
    }

    /// In a plain list the row insets are the card's margins: a short gap
    /// between cards and nearly the full width across.
    func separatedSessionRow() -> some View {
        self.listRowInsets(EdgeInsets(top: 4, leading: 14, bottom: 4, trailing: 14))
            .listRowSeparator(.hidden, edges: .all)
            .listSectionSeparator(.hidden, edges: .all)
            .listRowBackground(Color.clear)
    }
}
