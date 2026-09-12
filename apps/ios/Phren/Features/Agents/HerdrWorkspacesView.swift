import PhrenKit
import PhrenLive
import SwiftUI

struct HerdrWorkspacesView: View {
    let hostID: UUID
    @AppStorage("sessions.live.preferences.v1") private var data = Data()
    @Environment(\.scenePhase) private var scenePhase
    @State private var snapshot: LiveWorkspaces?
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
    private var host: LiveHost? { (try? LiveSessionPreferences.read(data))?.hosts.first { $0.id == hostID } }
    private var active: Bool { visible && scenePhase == .active }
    private struct Edit: Identifiable {
        var id = UUID()
        let workspace: String?
        var tab: String? = nil
        let title: String
    }
    var body: some View {
        PhrenList {
            if let host {
                Section {
                    LabeledContent("Computer", value: host.name)
                    Menu {
                        ForEach(servers) { server in
                            Button(server.session) {
                                do {
                                    var changed = host; changed.herdrSession = server.session == "default" ? nil : server.session
                                    data = try LiveSessionPreferences.saving(changed, in: data)
                                } catch { self.error = error.localizedDescription }
                            }
                        }
                    } label: { LabeledContent("Herdr server", value: host.herdrSession ?? "default") }
                    .disabled(servers.isEmpty || busy)
                    NavigationLink { HerdrTerminalView(host: host) } label: { Label("Open Herdr terminal", systemImage: "terminal") }
                }
                if let error { Section { Text(error).font(.footnote).foregroundStyle(PhrenTheme.warning) } }
                if let snapshot {
                    ForEach(snapshot.groups) { group in
                        Section {
                            ForEach(group.children) { tab in
                                let session = LiveAgentSession(host: host, workspaceID: group.id, workspaceName: group.label, tab: tab)
                                NavigationLink { HerdrPanesView(session: session) } label: {
                                    VStack(alignment: .leading, spacing: 5) {
                                        Text(tab.displayTitle).font(.headline).lineLimit(2)
                                        Text("\(tab.status) · \(tab.paneCount ?? 1) panes").font(.caption).foregroundStyle(PhrenTheme.textMuted)
                                    }.padding(.vertical, 5)
                                }
                                .contextMenu {
                                    Button("Rename tab") { name = tab.label; operation = .init(workspace: group.id, tab: tab.id, title: "Rename tab") }
                                    Button("Close tab", role: .destructive) { closing = .init(workspace: group.id, tab: tab.id, title: tab.displayTitle) }
                                }
                            }
                            Menu {
                                Button("New tab", systemImage: "plus") { perform(.create, host: host, workspace: group.id) }
                                Button("Rename workspace") { name = group.label; operation = .init(workspace: group.id, title: "Rename workspace") }
                                Button("Close workspace", role: .destructive) { closing = .init(workspace: group.id, title: group.label) }
                            } label: { Label("Workspace actions", systemImage: "ellipsis.circle") }.disabled(busy)
                        } header: { Text(group.label) }
                    }
                    if snapshot.groups.isEmpty { ContentUnavailableView("No workspaces", systemImage: "rectangle.split.3x1", description: Text("Create a workspace to open a shell on this computer.")) }
                } else if error == nil { ProgressView("Loading Herdr…") }
            }
        }
        .navigationTitle("Herdr").navigationBarTitleDisplayMode(.inline)
        .toolbar {
            Button("New workspace", systemImage: "plus") { name = ""; cwd = snapshot?.groups.flatMap(\.children).compactMap(\.cwd).first ?? ""; operation = .init(workspace: nil, title: "New workspace") }.disabled(busy || host == nil)
        }
        .alert(operation?.title ?? "Workspace", isPresented: $operation.isPresent()) {
            TextField("Name", text: $name)
            if operation?.workspace == nil { TextField("Full folder path on computer", text: $cwd).textInputAutocapitalization(.never).autocorrectionDisabled() }
            Button("Cancel", role: .cancel) { operation = nil }
            Button("Save") {
                if let op = operation, let host { perform(op.workspace == nil ? .create : .rename, host: host, workspace: op.workspace, tab: op.tab, label: name, cwd: op.workspace == nil ? cwd : nil) }
                operation = nil
            }
        }
        .confirmationDialog("Close \(closing?.title ?? "workspace")?", isPresented: $closing.isPresent(), titleVisibility: .visible) {
            Button("Close and stop its processes", role: .destructive) {
                if let op = closing, let host { perform(.close, host: host, workspace: op.workspace, tab: op.tab) }
                closing = nil
            }
        } message: { Text("Running shells and agents in this destination will be stopped.") }
        .onAppear { visible = true }.onDisappear { visible = false; action?.cancel() }
        .onChange(of: host) { _, _ in snapshot = nil; servers = []; action?.cancel() }
        .onChange(of: scenePhase) { _, phase in if phase != .active { action?.cancel() } }
        .task(id: Run(host: host, active: active, refresh: refresh)) {
            guard active, let host else { return }
            do {
                #if DEBUG && targetEnvironment(simulator)
                if AgentChatFixture.enabled {
                    servers = try JSONDecoder().decode([PhrenConnection.HerdrServer].self, from: Data(#"[{"id":"herdr:default","kind":"herdr","session":"default","running":true},{"id":"herdr:work","kind":"herdr","session":"work","running":true}]"#.utf8))
                } else { servers = try await PhrenConnection.herdrServers(host: host, privateKey: DeviceSSHKey.load(host.id)) }
                #else
                servers = try await PhrenConnection.herdrServers(host: host, privateKey: DeviceSSHKey.load(host.id))
                #endif
                while !Task.isCancelled {
                    let value = try await LiveHostMonitor.fetch(host)
                    try Task.checkCancellation(); snapshot = value; error = nil
                    try await Task.sleep(for: .seconds(3))
                }
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
}

private struct HerdrPanesView: View {
    let session: LiveAgentSession
    @Environment(\.scenePhase) private var scenePhase
    @AppStorage("sessions.live.preferences.v1") private var hostData = Data()
    @State private var panes: [AgentChatPanes.Pane] = []
    @State private var error: String?
    @State private var visible = false
    @State private var creating = false
    @State private var createTask: Task<Void, Never>?
    private var active: Bool { visible && scenePhase == .active && (try? LiveSessionPreferences.read(hostData))?.hosts.first(where: { $0.id == session.host.id }) == session.host }
    var body: some View {
        PhrenList {
            Section {
                Text("\(session.host.name) · \(session.host.herdrSession ?? "default")").font(.caption).foregroundStyle(PhrenTheme.textMuted)
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
        .task(id: active) {
            guard active else { return }
            do {
                while !Task.isCancelled {
                    let result = try await AgentChatModel.fetchPanes(session)
                    try Task.checkCancellation(); panes = result.panes; error = nil
                    try await Task.sleep(for: .seconds(3))
                }
            } catch { if !Task.isCancelled { self.error = error.localizedDescription } }
        }
    }
}
