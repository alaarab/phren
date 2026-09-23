import PhrenKit
import PhrenLive
import SwiftUI

struct LiveHostView: View {
    @Environment(AppModel.self) private var model
    @Environment(\.scenePhase) private var scenePhase
    @Environment(\.liveSessionPreferences) private var livePreferences
    @State private var monitor = LiveHostMonitor()
    @State private var editing = false
    @State private var refreshID = UUID()
    @State private var localError: String?
    @State private var mode: SessionViewMode = .workspaces
    @State private var selected: LiveAgentSession?
    @State private var closeRequest: SessionCloseRequest?
    @State private var closeError: String?
    let hostID: UUID

    private enum SessionViewMode: String, CaseIterable {
        case workspaces = "Workspaces", activity = "Activity"
    }
    private var preferences: LiveSessionPreferences? { livePreferences.preferences }
    private var host: LiveHost? { preferences?.hosts.first { $0.id == hostID } }
    private var sessions: [LiveAgentSession] {
        guard let host else { return [] }
        return monitor.snapshot?.sessions(on: host) ?? []
    }
    private var visible: [LiveAgentSession] { sessions }

    var body: some View {
        ScrollView {
            LazyVStack(alignment: .leading, spacing: 10) {
                connectionCard
                if monitor.snapshot != nil && host != nil {
                    PhrenTextSegment(items: SessionViewMode.allCases.map {
                                         PhrenOption(id: $0.rawValue.lowercased(), value: $0, title: $0.rawValue)
                                     },
                                     selection: $mode, identifier: "host-session-view")
                        .accessibilityLabel("Session view")
                        .padding(.vertical, 4)

                    let visible = visible
                    let preferences = preferences
                    let pinned = visible.filter { preferences?.isPinned($0.id) == true }
                    let unpinned = visible.filter { preferences?.isPinned($0.id) != true }
                    if !pinned.isEmpty {
                        sectionHeading("Pinned", count: pinned.count)
                        sessionCards(pinned)
                    }
                    if visible.isEmpty {
                        PhrenEmptyState(title: "No sessions running",
                                        message: "Open a workspace on this computer to see it here.")
                            .frame(maxWidth: .infinity)
                    } else {
                        switch mode {
                        case .workspaces:
                            ForEach(LiveAgentWorkspaceGrouping.sections(unpinned, preferences: preferences,
                                                                        projects: model.sessionProjects)) { section in
                                sectionHeading(section.title, count: section.sessions.count)
                                sessionCards(section.sessions)
                            }
                        case .activity:
                            ForEach(LiveWorkspaces.Tab.Activity.allCases, id: \.self) { activity in
                                let entries = unpinned.filter { $0.tab.activity == activity }
                                if !entries.isEmpty {
                                    sectionHeading(activity.rawValue, count: entries.count)
                                    sessionCards(entries)
                                }
                            }
                        }
                    }
                    // Health lives in the page, not the toolbar: a fifth
                    // toolbar item pushes the terminal into the overflow menu.
                    if let host {
                        NavigationLink { HookHealthView(hostID: host.id) } label: {
                            PhrenRow(icon: "stethoscope", title: "Health")
                        }
                        .buttonStyle(.plain)
                        .accessibilityIdentifier("host-health")
                        .padding(.top, 8)
                    }
                }

            }
            .padding(.horizontal, 16).padding(.vertical, 8)
        }
        .background(PhrenTheme.bg)
        .modifier(SessionCloseDialogs(request: $closeRequest, error: $closeError, monitor: { _ in monitor }))
        .navigationTitle(host?.name ?? "Computer removed")
        .navigationBarTitleDisplayMode(.inline)
        .toolbar {
            ToolbarItemGroup(placement: .primaryAction) {
                if let host {
                    NavigationLink { WebServersView(hostID: host.id) } label: { Label("Web servers", systemImage: "globe") }
                        .accessibilityIdentifier("host-web-servers")
                    NavigationLink { SimulatorsView(hostID: host.id) } label: { Label("Simulators", systemImage: "iphone") }
                        .accessibilityIdentifier("host-simulators")
                    NavigationLink { HostFilesView(hostID: host.id) } label: { Label("Files", systemImage: "folder") }
                        .accessibilityIdentifier("host-files")
                    NavigationLink { HerdrWorkspacesView(hostID: host.id) } label: {
                        Label("Herdr workspaces & terminal", systemImage: "terminal")
                    }
                }
                Button("Connection settings", systemImage: "gearshape") { editing = true }.disabled(host == nil)
            }
        }
        .onChange(of: host) { _, _ in
            monitor.snapshot = nil
            monitor.lastUpdated = nil
            monitor.message = nil
            monitor.fingerprint = nil
        }
        .sheet(isPresented: $editing) {
            if let host { NavigationStack { LiveHostEditor(existing: host) } }
        }
        .navigationDestination(item: $selected) { selection in
            LiveSessionDetailView(sessionID: selection.id, monitor: monitor)
        }
        .task(id: PollIdentity(host: host, active: scenePhase == .active && !editing, refresh: refreshID)) {
            guard scenePhase == .active, !editing, let host else { return }
            await monitor.run(host: host)
        }
    }

    private var connectionCard: some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack(spacing: 8) {
                TimelineView(.periodic(from: .now, by: 1)) { context in
                    let fresh = monitor.isFresh(at: context.date)
                    VStack(alignment: .leading, spacing: 3) {
                        HStack(spacing: 6) {
                            Circle().fill(fresh ? PhrenTheme.cyan : PhrenTheme.textDim).frame(width: 5, height: 5)
                            Text(fresh ? "Live" : monitor.isConnecting ? "Connecting…" : monitor.slowToAnswer ? "Slow to answer" : "Disconnected")
                            if let date = monitor.lastUpdated {
                                Text("· updated \(date, style: .relative) ago").lineLimit(1)
                            }
                        }
                        if monitor.snapshot != nil {
                            Text(fresh
                                 ? "\(sessions.count) tabs · \(sessions.filter { $0.tab.activity == .working }.count) working · \(sessions.filter { $0.tab.activity == .waiting }.count) waiting"
                                 : monitor.isConnecting ? "Refreshing…" : "Showing previous status")
                        }
                    }.font(.caption).foregroundStyle(PhrenTheme.textMuted)
                }
                Spacer(minLength: 0)
                Button { refreshID = UUID() } label: {
                    Image(systemName: "arrow.clockwise").frame(width: 44, height: 44)
                }.buttonStyle(.plain).foregroundStyle(PhrenTheme.textMuted)
                    .accessibilityLabel("Refresh now").disabled(monitor.refreshing)
            }
            if let message = monitor.message { Text(message).font(.footnote).foregroundStyle(PhrenTheme.warning) }
            if let localError { Text(localError).font(.footnote).foregroundStyle(PhrenTheme.warning) }
            // Reachable over SSH even when the Hook is not answering: the
            // terminal attaches Herdr directly, so a stuck Hook never locks
            // the person out of their own machine.
            if let host, monitor.message != nil, monitor.fingerprint == nil {
                NavigationLink { HerdrTerminalView(host: host, route: .herdr(server: "default")) } label: {
                    Label("Open terminal", systemImage: "terminal").font(.subheadline.weight(.semibold))
                        .frame(maxWidth: .infinity, minHeight: 44)
                }
                .buttonStyle(.plain).foregroundStyle(PhrenTheme.cyan)
                .background(PhrenTheme.surface, in: RoundedRectangle(cornerRadius: PhrenTheme.Radius.medium))
                .accessibilityIdentifier("host-open-terminal")
            }
            if let fingerprint = monitor.fingerprint, host?.fingerprint == nil {
                Text(fingerprint).font(.caption.monospaced()).textSelection(.enabled)
                Text("Compare this fingerprint with the computer's SSH host key before trusting it. On the computer, run ssh-keygen -lf /etc/ssh/ssh_host_ed25519_key.pub (or the matching ECDSA host key).")
                    .font(.caption).foregroundStyle(PhrenTheme.textMuted)
                Button("Trust verified fingerprint") { trust(fingerprint) }
            }
        }
        .padding(.horizontal, 4)
        .accessibilityIdentifier("live-connection-status")
    }

    private func sectionHeading(_ title: String, count: Int) -> some View {
        HStack {
            Text(title).font(.subheadline.weight(.semibold))
            Spacer()
            Text("\(count)").font(.caption.monospacedDigit())
        }
        .foregroundStyle(PhrenTheme.textMuted)
        .padding(.horizontal, 4).padding(.top, 6)
        .accessibilityAddTraits(.isHeader)
    }

    private func sessionCards(_ entries: [LiveAgentSession]) -> some View {
        ForEach(entries) { session in
            TimelineView(.periodic(from: .now, by: 1)) { context in
                LiveSessionCard(session: session, fresh: monitor.isLive(at: context.date), stale: monitor.isStale(at: context.date), onDetails: { selected = session }, onClose: { request, confirm in
                    if confirm { closeRequest = request } else { SessionCloseDialogs.perform(request, monitor: monitor) { closeError = $0 } }
                })
                .equatable().separatedSessionRow()
            }
        }
    }

    private func trust(_ fingerprint: String) {
        guard var host, host.fingerprint == nil else { return }
        do {
            host.fingerprint = fingerprint
            try livePreferences.update { try LiveSessionPreferences.saving(host, in: $0) }
            monitor.fingerprint = nil
            let verifiedHost = host
            Task { await associateVerifiedIdentity(for: verifiedHost) }
        } catch { localError = error.localizedDescription }
    }

    @MainActor private func associateVerifiedIdentity(for host: LiveHost) async {
        do {
            guard let identity = try await PhrenConnection.computerIdentity(
                host: host, privateKey: DeviceSSHKey.load(host.id)
            ), let saved = livePreferences.preferences?.hosts.first(where: { $0.id == host.id }),
               saved.hasSameConnection(as: host) else { return }
            try livePreferences.update {
                try LiveSessionPreferences.associating(hostID: host.id, hookComputerID: identity.id, in: $0)
            }
        } catch { localError = error.localizedDescription }
    }

    private struct PollIdentity: Equatable {
        let host: LiveHost?
        let active: Bool
        let refresh: UUID
    }
}
