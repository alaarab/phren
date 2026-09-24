import PhrenKit
import PhrenLive
import SwiftUI

struct WebServersView: View {
    var hostID: UUID? = nil
    @Environment(\.liveSessionPreferences) private var preferencesStore
    @State private var selected: WebServerSelection?
    @State private var refresh = UUID()
    private var hosts: [LiveHost] {
        (preferencesStore.preferences?.hosts ?? []).filter { hostID == nil || $0.id == hostID }
    }

    var body: some View {
        PhrenList {
            if hosts.isEmpty {
                Text("Add a computer in Agents to see its running web apps.").foregroundStyle(PhrenTheme.textMuted)
            }
            ForEach(hosts) { host in
                WebServerSection(host: host, refresh: refresh) { server in
                    selected = WebServerSelection(hostID: host.id, server: server)
                }
            }
        }
        .navigationTitle("Web servers")
        .navigationBarTitleDisplayMode(.inline)
        .phrenScreen()
        .toolbar {
            Button("Refresh web servers", systemImage: "arrow.clockwise") { refresh = UUID() }
        }
        .refreshable { refresh = UUID() }
        .fullScreenCover(item: $selected) { selection in
            NavigationStack { WebPreviewView(selection: selection) }
        }
    }
}

struct WebServerSelection: Identifiable {
    let hostID: UUID
    let server: WebServer
    /// The page a tapped link named ("/admin?tab=2"); nil opens the root.
    var path: String? = nil
    var id: String { "\(hostID):\(server.id)" }
}

private struct WebServerSection: View {
    let host: LiveHost
    let refresh: UUID
    let open: (WebServer) -> Void
    @Environment(\.scenePhase) private var phase
    @State private var servers: [WebServer]?
    @State private var message: String?
    @State private var loading = true
    @State private var editing = false

    private struct PollID: Equatable { let host: LiveHost; let refresh: UUID; let active: Bool }

    var body: some View {
        Section {
            if let servers {
                ForEach(servers) { server in
                    Button { open(server) } label: {
                        HStack(spacing: 12) {
                            Image(systemName: "network").font(.title3).foregroundStyle(PhrenTheme.textMuted)
                                .frame(width: 24)
                            VStack(alignment: .leading, spacing: 3) {
                                Text(server.displayName).font(.body.weight(.medium)).lineLimit(1)
                                    .foregroundStyle(PhrenTheme.text)
                                Text(server.detail).font(.caption.monospaced()).lineLimit(1)
                                    .foregroundStyle(PhrenTheme.textMuted)
                            }
                            Spacer(minLength: 4)
                            Image(systemName: "arrow.up.right").font(.caption.weight(.semibold)).foregroundStyle(PhrenTheme.textMuted)
                        }
                        .padding(.vertical, 3).contentShape(Rectangle())
                    }
                    .buttonStyle(.plain)
                    .accessibilityIdentifier("web-server:\(host.id):\(server.port)")
                }
                if servers.isEmpty && message == nil { Text("No web servers running").foregroundStyle(PhrenTheme.textMuted) }
            } else if loading {
                HStack { ProgressView(); Text("Finding web servers…").foregroundStyle(PhrenTheme.textMuted) }
            }
            if let message {
                Text(message).font(.footnote).foregroundStyle(PhrenTheme.warning)
                Button("Connection settings", systemImage: "gearshape") { editing = true }
            }
        } header: { Text(host.name) }
        footer: {
            if message != nil && servers != nil { Text("Showing the previous list. Opening checks the computer again.") }
        }
        .sheet(isPresented: $editing) { NavigationStack { LiveHostEditor(existing: host) } }
        .task(id: PollID(host: host, refresh: refresh, active: phase == .active && !editing)) {
            guard phase == .active, !editing else { return }
            await LiveRefresh.shared.every(.seconds(15), key: "web-servers:\(host.id):\(refresh)") {
                loading = true
                do {
                    let result = try await fetch()
                    servers = result; message = nil
                } catch {
                    message = error.localizedDescription
                }
                loading = false
            }
        }
    }

    private func fetch() async throws -> [WebServer] {
        #if DEBUG && targetEnvironment(simulator)
        if AppModel.isUITesting && ProcessInfo.processInfo.arguments.contains("--web-servers-fixture") {
            if ProcessInfo.processInfo.arguments.contains("--web-servers-offline") { throw LiveConnectionError.timeout }
            if ProcessInfo.processInfo.arguments.contains("--web-servers-empty") { return [] }
            return try WebServer.readSnapshot(Data(#"{"servers":[{"name":"Phone preview","port":19473,"origin":"http://127.0.0.1:19473","process":"node"},{"name":"Project dashboard","port":19474,"origin":"http://127.0.0.1:19474","process":"bun"}]}"#.utf8))
        }
        #endif
        return try await PhrenConnection.webServers(host: host, privateKey: DeviceSSHKey.load(host.id))
    }
}
