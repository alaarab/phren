import PhrenKit
import PhrenLive
import SwiftUI

struct LiveSessionDetailView: View {
    @Environment(AppModel.self) private var model
    @Environment(\.dismiss) private var dismiss
    @Environment(\.liveSessionPreferences) private var livePreferences
    @State private var assigning = false
    @State private var copiedFolder = false
    @State private var closingSession = false
    let sessionID: LiveAgentSession.ID
    let monitor: LiveHostMonitor

    private var preferences: LiveSessionPreferences? { livePreferences.preferences }
    private var host: LiveHost? { preferences?.hosts.first { $0.id == sessionID.hostID } }
    private var session: LiveAgentSession? {
        guard let host else { return nil }
        return monitor.snapshot?.sessions(on: host).first { $0.id == sessionID }
    }
    private var match: SessionProjectMatch? {
        preferences?.projectMatch(hostID: sessionID.hostID, cwd: session?.tab.cwd, projects: model.sessionProjects)
    }

    var body: some View {
        Group {
                let fresh = monitor.live
                let stale = monitor.stale
                if let session {
                    let project = match?.project
                    ScrollView {
                        VStack(spacing: 14) {
                            // The hero: who is running, what it is doing, in its state's tint.
                            VStack(spacing: 12) {
                                AgentProviderGlyph(source: session.tab.agent, size: 44)
                                    .frame(width: 88, height: 88)
                                    .background(session.tab.activity.color.opacity(0.14), in: RoundedRectangle(cornerRadius: 22, style: .continuous))
                                Text(session.tab.displayTitle).font(.title2.weight(.bold)).multilineTextAlignment(.center)
                                    .fixedSize(horizontal: false, vertical: true)
                                HStack(spacing: 6) {
                                    if project == nil { Image(systemName: "folder").foregroundStyle(PhrenTheme.textMuted) }
                                    Text(session.projectDisplayName(project?.name)).font(.system(.subheadline, design: .monospaced))
                                        .foregroundStyle(project.map { PhrenTheme.projectColor(storeId: $0.storeID, project: $0.name) } ?? PhrenTheme.textMuted)
                                    if let branch = session.tab.branch, !branch.isEmpty {
                                        Text("·").foregroundStyle(PhrenTheme.textDim)
                                        Label(branch, systemImage: "arrow.triangle.branch").font(.system(.caption, design: .monospaced)).foregroundStyle(PhrenTheme.chatNeutral)
                                    }
                                    Text("·").foregroundStyle(PhrenTheme.textDim)
                                    Text(session.host.name).font(.subheadline).fontWeight(.medium)
                                        .foregroundStyle(PhrenTheme.hostColor(session.host.color ?? LiveHost.defaultColor(for: session.host.id)))
                                    if let date = session.tab.lastChangedAt {
                                        SessionRelativeTimeLabel(changedAt: date)
                                    }
                                }.lineLimit(1).minimumScaleFactor(0.8)
                                Text((session.tab.status + (stale ? " · stale" : "")).uppercased())
                                    .font(.caption.weight(.bold)).tracking(1.2)
                                    .foregroundStyle(fresh ? session.tab.activity.color : PhrenTheme.textMuted)
                                    .padding(.horizontal, 14).padding(.vertical, 6)
                                    .background((fresh ? session.tab.activity.color : PhrenTheme.textMuted).opacity(0.14), in: Capsule())
                            }
                            .frame(maxWidth: .infinity).padding(.vertical, 28).padding(.horizontal, 20)
                            .background(session.tab.activity.color.opacity(fresh ? 0.08 : 0.03), in: RoundedRectangle(cornerRadius: PhrenTheme.Radius.large, style: .continuous))

                            // The two ways in, side by side.
                            HStack(spacing: 10) {
                                AgentConversationLink(session: session) {
                                    Label("Chat", systemImage: "bubble.left.and.bubble.right").font(.body.weight(.semibold))
                                        .frame(maxWidth: .infinity, minHeight: 44)
                                        .background(PhrenTheme.accent.opacity(0.9), in: Capsule()).foregroundStyle(.black)
                                }
                                .buttonStyle(.plain).disabled(!fresh)
                                .accessibilityLabel("Chat with agent")
                                .accessibilityIdentifier("session-detail-chat")
                                NavigationLink { HerdrTerminalView(host: session.host, session: session) } label: {
                                    Label("Terminal", systemImage: "terminal").font(.body.weight(.semibold))
                                        .frame(maxWidth: .infinity, minHeight: 44)
                                        .background(PhrenTheme.surface, in: Capsule()).foregroundStyle(PhrenTheme.text)
                                }
                                .buttonStyle(.plain).disabled(!fresh)
                                .accessibilityLabel("Open terminal")
                                .accessibilityIdentifier("session-detail-terminal")
                            }
                            if stale { Text("Reconnect this computer to resume its session.").font(.caption).foregroundStyle(PhrenTheme.textMuted) }

                            SessionAwaySummaryCard(
                                session: session,
                                project: session.projectDisplayName(project?.name),
                                state: session.tab.activity.rawValue
                            )

                            SessionSubagentsCard(session: session)

                            SessionUsageCard(host: session.host, source: session.tab.agent)

                            // The facts, one per row.
                            VStack(spacing: 0) {
                                factRow("Computer", session.host.name)
                                if let agent = session.tab.agent { factRow("Agent", agent.capitalized) }
                                factRow("Workspace", session.workspaceName)
                                factRow("Tab", session.tab.label)
                                if let count = session.tab.agentPaneCount, count >= 0 { factRow("Agent panes", "\(count)") }
                                if let count = session.tab.paneCount, count >= 0 { factRow("Total panes", "\(count)") }
                                if let cwd = session.tab.cwd {
                                    factRow("Folder", cwd, monospaced: true, copy: { UIPasteboard.general.string = cwd; copiedFolder = true }, copied: copiedFolder)
                                        .accessibilityIdentifier("session-detail-folder")
                                }
                                if let project {
                                    NavigationLink { ProjectDetailView(storeId: project.storeID, project: project.name) } label: {
                                        factRow("Project memory", project.name, chevron: true)
                                    }.buttonStyle(.plain).accessibilityIdentifier("session-detail-project")
                                } else if session.tab.cwd != nil {
                                    Button { assigning = true } label: { factRow("Project memory", "Link to a project", chevron: true) }
                                        .buttonStyle(.plain).accessibilityLabel("Link to project")
                                }
                            }
                            .background(PhrenTheme.surface, in: RoundedRectangle(cornerRadius: 18, style: .continuous))

                            if let project, model.sessionProjects.contains(project) {
                                HStack(spacing: 10) {
                                    NavigationLink { GraphView(focusProject: project.name, initialStoreId: project.storeID) } label: {
                                        Label("Graph", systemImage: "circle.hexagongrid").frame(maxWidth: .infinity, minHeight: 44)
                                            .background(PhrenTheme.surface, in: Capsule())
                                    }.buttonStyle(.plain).accessibilityLabel("Explore graph")
                                    if session.tab.cwd != nil {
                                        Button { assigning = true } label: {
                                            Label("Change project", systemImage: "link").frame(maxWidth: .infinity, minHeight: 44)
                                                .background(PhrenTheme.surface, in: Capsule())
                                        }.buttonStyle(.plain).accessibilityLabel("Change project link")
                                    }
                                }.font(.subheadline).foregroundStyle(PhrenTheme.text)
                            }

                            Button(role: .destructive) { closingSession = true } label: {
                                Text("Close session").font(.body.weight(.medium)).frame(maxWidth: .infinity, minHeight: 48)
                            }
                            .foregroundStyle(PhrenTheme.danger).padding(.top, 6)
                            .accessibilityIdentifier("session-detail-close")
                        }
                        .padding(16)
                    }
                    .background(PhrenTheme.bg)
                    .phrenDialog(isPresented: $closingSession, title: "Close this session?",
                                 message: "\u{201C}\(session.tab.displayTitle)\u{201D} on \(session.host.name) closes; an agent running in it stops.",
                                 actions: [
                                    .init(id: "close", title: "Close tab", role: .destructive) {
                                        Task {
                                            try? await PhrenConnection.herdrAction(host: session.host, privateKey: DeviceSSHKey.load(session.host.id), operation: .close, workspaceID: session.workspaceID, tabID: session.tab.id)
                                            dismiss()
                                        }
                                    },
                                    .init(id: "keep", title: "Keep tab", role: .cancel) {},
                                 ],
                                 identifier: "session-detail-close-dialog")
                } else {
                    PhrenEmptyState(title: "Session no longer available", message: "It was closed or its computer was removed. Return to the list for current sessions.")
                        .frame(maxWidth: .infinity, maxHeight: .infinity).background(PhrenTheme.bg)
                }
            }
            .navigationTitle("Session details")
            .navigationBarTitleDisplayMode(.inline)
            // Pushed over the list, this page is what's on screen, and SwiftUI
            // cancels the list's polling task when it disappears. Keep the
            // computer's monitor running from here; the list picks it back up
            // when it reappears.
            .task(id: host) {
                guard let host else { return }
                await monitor.keepRunning(host: host)
            }
            .onChange(of: session?.tab.cwd) { _, _ in
                copiedFolder = false
                assigning = false
            }
            .sheet(isPresented: $assigning) {
                NavigationStack {
                    LiveProjectPicker(hostID: sessionID.hostID, cwd: session?.tab.cwd ?? "",
                                      existing: preferences?.mapping(hostID: sessionID.hostID, cwd: session?.tab.cwd))
                }
            }
    }
}

/// A key on the left, its value on the right — the plain rows the details
/// sheet is made of.
private func factRow(_ key: String, _ value: String, monospaced: Bool = false, chevron: Bool = false,
                     copy: (() -> Void)? = nil, copied: Bool = false) -> some View {
    HStack(spacing: 10) {
        Text(key).foregroundStyle(PhrenTheme.textMuted)
        Spacer(minLength: 12)
        Text(value).foregroundStyle(PhrenTheme.text).lineLimit(1).truncationMode(.middle)
            .font(monospaced ? .system(.subheadline, design: .monospaced) : .body)
        if let copy {
            Button { copy() } label: { Image(systemName: copied ? "checkmark" : "doc.on.doc").foregroundStyle(copied ? PhrenTheme.success : PhrenTheme.textMuted).frame(width: 32, height: 32) }
                .buttonStyle(.plain).accessibilityLabel(copied ? "Folder copied" : "Copy folder")
        }
        if chevron { Image(systemName: "chevron.right").font(.caption.weight(.semibold)).foregroundStyle(PhrenTheme.textDim) }
    }
    .font(.body).padding(.horizontal, 16).frame(minHeight: 50)
    .overlay(alignment: .bottom) { Rectangle().fill(PhrenTheme.border).frame(height: 0.5).padding(.leading, 16) }
    .contentShape(Rectangle())
    .accessibilityElement(children: copy == nil ? .combine : .contain)
    .accessibilityLabel(copy == nil ? "\(key), \(value)" : key)
}
