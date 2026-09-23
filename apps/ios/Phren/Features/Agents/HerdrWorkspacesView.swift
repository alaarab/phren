import PhrenKit
import PhrenLive
import SwiftUI

struct HerdrWorkspacesView: View {
    let hostID: UUID
    @Environment(\.liveSessionPreferences) private var preferencesStore
    @Environment(\.scenePhase) private var scenePhase
    @State private var servers: [PhrenConnection.HerdrServer] = []
    @State private var error: String?
    @State private var busy = false
    @State private var visible = false
    @State private var refresh = UUID()
    @State private var operation: Edit?
    @State private var name = ""
    @State private var cwd = ""
    @State private var closing: Edit?
    @State private var action: Task<Void, Never>?
    @State private var query = ""
    @State private var collapsed: Set<String> = []
    @State private var showingServers = false
    @State private var actionTarget: RowAction?
    private var host: LiveHost? { preferencesStore.preferences?.hosts.first { $0.id == hostID } }
    /// The overview's monitor for this computer: the workspaces arrive over
    /// its stream (or poll), not a second loop of this screen's own.
    private var monitor: LiveHostMonitor? { SessionOverviewMonitor.shared.computers.first { $0.host.id == hostID }?.monitor }
    private var snapshot: LiveWorkspaces? { monitor?.snapshot }
    private var active: Bool { visible && scenePhase == .active }
    private struct Edit: Identifiable {
        var id = UUID()
        let workspace: String?
        var tab: String? = nil
        let title: String
    }
    private enum RowAction: Identifiable {
        case workspace(id: String, label: String)
        case tab(workspace: String, id: String, label: String, displayTitle: String)
        var id: String {
            switch self {
            case .workspace(let id, _): return "workspace:\(id)"
            case .tab(let workspace, let id, _, _): return "tab:\(workspace):\(id)"
            }
        }
    }
    var body: some View {
        PhrenList {
            if let host {
                Section {
                    LabeledContent("Computer", value: host.name)
                    Button { showingServers = true } label: {
                        LabeledContent("Herdr server", value: host.herdrSession ?? "default")
                            .frame(minHeight: 44).contentShape(Rectangle())
                    }
                    .buttonStyle(.plain)
                    .disabled(servers.isEmpty || busy)
                    .accessibilityIdentifier("herdr-server")
                    NavigationLink { HerdrTerminalView(host: host) } label: { Label("Open Herdr terminal", systemImage: "terminal") }
                }
                if let error = error ?? monitor?.message { Section { Text(error).font(.footnote).foregroundStyle(PhrenTheme.warning) } }
                if let snapshot {
                    // One tree: workspaces as plain rows you can fold, their
                    // tabs beneath with the harness mark, the state on the
                    // right, and the tab Herdr has in front tinted.
                    let needle = query.trimmingCharacters(in: .whitespaces).lowercased()
                    let groups = snapshot.groups.filter { group in
                        needle.isEmpty || group.label.lowercased().contains(needle) || group.children.contains { $0.displayTitle.lowercased().contains(needle) || ($0.agent ?? "").contains(needle) }
                    }
                    Section {
                        ForEach(groups) { group in
                            let open = !collapsed.contains(group.id)
                            HStack(spacing: 4) {
                                Button {
                                    withAnimation(.easeInOut(duration: 0.15)) { if open { collapsed.insert(group.id) } else { collapsed.remove(group.id) } }
                                } label: { WorkspaceTreeDisclosure(label: group.label, count: group.children.count, open: open) }
                                .buttonStyle(.plain)
                                .accessibilityLabel("\(group.label) workspace, \(open ? "expanded" : "collapsed")")
                                .accessibilityIdentifier("workspace:\(group.id)")
                                Spacer(minLength: 0)
                                PhrenIconButton(icon: "ellipsis", label: "Workspace actions") {
                                    actionTarget = .workspace(id: group.id, label: group.label)
                                }
                                .phrenIdentifier("workspace-actions:\(group.id)")
                            }
                            .listRowBackground(Color.clear)
                            .listRowInsets(EdgeInsets(top: 2, leading: 16, bottom: 2, trailing: 16))
                            if open {
                                ForEach(group.children.filter { needle.isEmpty || $0.displayTitle.lowercased().contains(needle) || ($0.agent ?? "").contains(needle) || group.label.lowercased().contains(needle) }) { tab in
                                    let session = LiveAgentSession(host: host, workspaceID: group.id, workspaceName: group.label, tab: tab)
                                    let focused = snapshot.focus?.workspaceID == group.id && snapshot.focus?.tabID == tab.id
                                    HStack(spacing: 4) {
                                        NavigationLink { HerdrPanesView(session: session) } label: {
                                            WorkspaceTreeAgentLabel(tab: tab, selected: focused)
                                        }
                                        .accessibilityIdentifier("workspace-tab:\(tab.id)")
                                        Spacer(minLength: 0)
                                        PhrenIconButton(icon: "ellipsis", label: "Tab actions") {
                                            actionTarget = .tab(workspace: group.id, id: tab.id, label: tab.label, displayTitle: tab.displayTitle)
                                        }
                                        .phrenIdentifier("workspace-tab-actions:\(tab.id)")
                                    }
                                    .listRowBackground(focused ? PhrenTheme.success.opacity(0.14) : Color.clear)
                                    .listRowInsets(EdgeInsets(top: 2, leading: 44, bottom: 2, trailing: 16))
                                    .swipeActions(edge: .trailing) {
                                        Button("Close", systemImage: "xmark", role: .destructive) { closing = .init(workspace: group.id, tab: tab.id, title: tab.displayTitle) }
                                    }
                                }
                            }
                        }
                    } header: { Text("Workspaces") }
                    if snapshot.groups.isEmpty { ContentUnavailableView("No workspaces", systemImage: "rectangle.split.3x1", description: Text("Create a workspace to open a shell on this computer.")) }
                } else if error == nil { ProgressView("Loading Herdr…") }
            }
        }
        .safeAreaInset(edge: .top, spacing: 0) {
            PhrenSearchField(text: $query, placeholder: "Search workspaces, tabs, agents", identifier: "herdr-search")
                .padding(.horizontal, PhrenTheme.Space.large)
                .padding(.vertical, PhrenTheme.Space.small)
                .background(PhrenTheme.bg)
        }
        .navigationTitle("Herdr").navigationBarTitleDisplayMode(.inline)
        .toolbar {
            Button("New workspace", systemImage: "plus") { name = ""; cwd = snapshot?.groups.flatMap(\.children).compactMap(\.cwd).first ?? ""; operation = .init(workspace: nil, title: "New workspace") }.disabled(busy || host == nil)
        }
        .sheet(item: $operation) { op in
            NavigationStack {
                PhrenScreen {
                    PhrenGroup("Name") {
                        PhrenTextField("Name", text: $name, identifier: "herdr-name")
                    }
                    if op.workspace == nil {
                        PhrenGroup("Folder") {
                            PhrenTextField("Full folder path on computer", text: $cwd, identifier: "herdr-cwd", monospaced: true)
                                .textInputAutocapitalization(.never).autocorrectionDisabled()
                        }
                    }
                }
                .navigationTitle(op.title)
                .navigationBarTitleDisplayMode(.inline)
                .toolbar {
                    ToolbarItem(placement: .cancellationAction) { Button("Cancel") { operation = nil } }
                    ToolbarItem(placement: .confirmationAction) {
                        Button("Save") {
                            if let host { perform(op.workspace == nil ? .create : .rename, host: host, workspace: op.workspace, tab: op.tab, label: name, cwd: op.workspace == nil ? cwd : nil) }
                            operation = nil
                        }
                    }
                }
            }
            .presentationDetents([.medium])
        }
        .phrenDialog(
            isPresented: $closing.isPresent(),
            title: "Close \(closing?.title ?? "workspace")?",
            message: "Running shells and agents in this destination will be stopped.",
            actions: closeActions,
            identifier: "herdr-close-dialog"
        )
        .phrenSingleSelectSheet(isPresented: $showingServers, title: "Herdr server", options: serverOptions,
                                selection: serverSelection, rowPrefix: "herdr-server")
        .phrenActionSheet(isPresented: $actionTarget.isPresent(), title: rowActionTitle, actions: rowActions,
                          identifier: "herdr-row-actions")
        .onAppear { visible = true }.onDisappear { visible = false; action?.cancel() }
        .onChange(of: host) { _, _ in servers = []; action?.cancel() }
        .onChange(of: scenePhase) { _, phase in if phase != .active { action?.cancel() } }
        .task(id: Run(host: host, active: active, refresh: refresh)) {
            guard active, let host else { return }
            if let hosts = preferencesStore.preferences?.hosts { SessionOverviewMonitor.shared.ensureRunning(hosts: hosts) }
            monitor?.refreshNow()
            do {
                #if DEBUG && targetEnvironment(simulator)
                if AgentChatFixture.enabled {
                    servers = try JSONDecoder().decode([PhrenConnection.HerdrServer].self, from: Data(#"[{"id":"herdr:default","kind":"herdr","session":"default","running":true},{"id":"herdr:work","kind":"herdr","session":"work","running":true}]"#.utf8))
                } else { servers = try await PhrenConnection.herdrServers(host: host, privateKey: DeviceSSHKey.load(host.id)) }
                #else
                servers = try await PhrenConnection.herdrServers(host: host, privateKey: DeviceSSHKey.load(host.id))
                #endif
                error = nil
            } catch { if !Task.isCancelled { self.error = error.localizedDescription } }
        }
        .refreshable { refresh = UUID() }
    }
    private func perform(_ operation: PhrenConnection.HerdrOperation, host: LiveHost, workspace: String? = nil, tab: String? = nil, label: String? = nil, cwd: String? = nil) {
        guard !busy, active, self.host == host else { return }
        busy = true; error = nil
        action = Task {
            defer { busy = false }
            do {
                try await PhrenConnection.herdrAction(host: host, privateKey: DeviceSSHKey.load(host.id), operation: operation,
                                                     workspaceID: workspace, tabID: tab, label: label, cwd: cwd)
                refresh = UUID()
            } catch { self.error = "Action wasn't confirmed. Refresh before trying again. \(error.localizedDescription)" }
        }
    }
    private struct Run: Equatable { let host: LiveHost?; let active: Bool; let refresh: UUID }

    private var serverOptions: [PhrenOption<String>] {
        servers.map { PhrenOption(id: $0.session, value: $0.session, title: $0.session) }
    }

    private var serverSelection: Binding<String> {
        Binding(get: { host?.herdrSession ?? "default" }, set: { session in
            guard let host else { return }
            do {
                var changed = host; changed.herdrSession = session == "default" ? nil : session
                try preferencesStore.update { try LiveSessionPreferences.saving(changed, in: $0) }
            } catch { self.error = error.localizedDescription }
        })
    }

    private var rowActionTitle: String {
        guard let actionTarget else { return "" }
        switch actionTarget {
        case .workspace(_, let label): return label
        case .tab(_, _, _, let displayTitle): return displayTitle
        }
    }

    private var rowActions: [PhrenControlAction] {
        guard let host, let actionTarget else { return [] }
        switch actionTarget {
        case .workspace(let id, let label):
            return [
                PhrenControlAction(id: "new-tab", title: "New tab", icon: "plus") {
                    perform(.create, host: host, workspace: id)
                },
                PhrenControlAction(id: "rename", title: "Rename workspace", icon: "pencil") {
                    name = label; operation = .init(workspace: id, title: "Rename workspace")
                },
                PhrenControlAction(id: "close", title: "Close workspace", icon: "xmark", role: .destructive) {
                    closing = .init(workspace: id, title: label)
                },
            ]
        case .tab(let workspace, let id, let label, let displayTitle):
            return [
                PhrenControlAction(id: "rename", title: "Rename tab", icon: "pencil") {
                    name = label; operation = .init(workspace: workspace, tab: id, title: "Rename tab")
                },
                PhrenControlAction(id: "close", title: "Close tab", icon: "xmark", role: .destructive) {
                    closing = .init(workspace: workspace, tab: id, title: displayTitle)
                },
            ]
        }
    }

    private var closeActions: [PhrenDialog.Action] {
        guard let op = closing else {
            return [.init(id: "cancel", title: "Cancel", role: .cancel) {}]
        }
        return [
            .init(id: "close", title: "Close and stop its processes", role: .destructive) {
                if let host { perform(.close, host: host, workspace: op.workspace, tab: op.tab) }
            },
            .init(id: "cancel", title: "Cancel", role: .cancel) {},
        ]
    }
}

private struct HerdrPanesView: View {
    let session: LiveAgentSession
    @Environment(\.scenePhase) private var scenePhase
    @Environment(\.liveSessionPreferences) private var preferencesStore
    @State private var panes: [AgentChatPanes.Pane] = []
    @State private var error: String?
    @State private var visible = false
    @State private var creating = false
    @State private var createTask: Task<Void, Never>?
    private var active: Bool { visible && scenePhase == .active && preferencesStore.preferences?.hosts.first(where: { $0.id == session.host.id }) == session.host }
    private var overviewTab: LiveWorkspaces.Tab? {
        SessionOverviewMonitor.shared.computers.first { $0.host.id == session.host.id }?.monitor.snapshot?
            .groups.first { $0.id == session.workspaceID }?.children.first { $0.id == session.tab.id }
    }
    private struct PanesRead: Equatable { let active: Bool; let tab: LiveWorkspaces.Tab? }
    var body: some View {
        PhrenList {
            Section {
                HStack(spacing: 4) {
                    Text(session.host.name).fontWeight(.medium)
                        .foregroundStyle(PhrenTheme.hostColor(session.host.color ?? LiveHost.defaultColor(for: session.host.id)))
                    Text("· \(session.host.herdrSession ?? "default")").foregroundStyle(PhrenTheme.textMuted)
                }.font(.caption)
                NavigationLink { HerdrTerminalView(host: session.host, session: session) } label: { Label("Open tab in terminal", systemImage: "terminal") }
                AgentConversationLink(session: session) { Label("Chat with agent", systemImage: "bubble.left.and.bubble.right") }
            }
            if let error { Text(error).foregroundStyle(PhrenTheme.warning) }
            ForEach(panes) { pane in
                Section(pane.displayTitle) {
                    LabeledContent("Status", value: pane.agentStatus ?? "Shell")
                    if let cwd = pane.cwd { Text(cwd).font(.caption.monospaced()).textSelection(.enabled) }
                    NavigationLink { HerdrTerminalView(host: session.host, session: session, paneID: pane.id) } label: {
                        Label("Open pane", systemImage: "terminal")
                    }
                }
            }
        }
        .navigationTitle(session.tab.displayTitle).navigationBarTitleDisplayMode(.inline)
        .toolbar {
            Button("New pane", systemImage: "rectangle.split.2x1") {
                guard active, !creating else { return }
                creating = true
                createTask = Task {
                    defer { creating = false }
                    do {
                        let key = try DeviceSSHKey.load(session.host.id)
                        _ = try await PhrenConnection.chatPanes(host: session.host, privateKey: key, workspaceID: session.workspaceID, tabID: session.tab.id)
                        try Task.checkCancellation()
                        try await PhrenConnection.herdrAction(host: session.host, privateKey: key, operation: .create, workspaceID: session.workspaceID, tabID: session.tab.id)
                    } catch { self.error = "Pane creation wasn't confirmed. Refresh before trying again. \(error.localizedDescription)" }
                }
            }.disabled(!active || creating)
        }
        .onAppear { visible = true }.onDisappear { visible = false; createTask?.cancel() }
        .onChange(of: scenePhase) { _, phase in if phase != .active { createTask?.cancel() } }
        // Read when the overview's row for this tab changes (a pane added,
        // closed or retitled shows there first), not on a timer.
        .task(id: PanesRead(active: active, tab: overviewTab)) {
            guard active else { return }
            do {
                let result = try await AgentChatModel.fetchPanes(session)
                try Task.checkCancellation(); panes = result.panes; error = nil
            } catch { if !Task.isCancelled { self.error = error.localizedDescription } }
        }
    }
}
