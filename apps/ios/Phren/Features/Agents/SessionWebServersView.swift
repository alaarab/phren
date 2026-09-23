import PhrenKit
import PhrenLive
import SwiftUI

/// The web servers this chat's own session started or names in its
/// transcript, from the chat's ••• sheet. Never the computer's whole list:
/// a server another pane started does not appear here.
struct SessionWebServersView: View {
    let session: LiveAgentSession
    let target: AgentChatTarget
    @Environment(\.scenePhase) private var phase
    @State private var servers: [WebServer]?
    @State private var message: String?
    @State private var selected: WebServerSelection?
    @State private var refresh = UUID()

    var body: some View {
        PhrenList {
            if let servers {
                if servers.isEmpty {
                    VStack(spacing: PhrenTheme.Space.small) {
                        Image(systemName: "globe").font(.system(size: 26, weight: .medium)).foregroundStyle(PhrenTheme.textMuted)
                            .accessibilityHidden(true)
                        Text("No web servers from this session").font(PhrenTheme.Font.body.weight(.semibold))
                            .foregroundStyle(PhrenTheme.text)
                        Text("When this agent starts a dev server, it shows up here.")
                            .font(PhrenTheme.Font.caption).foregroundStyle(PhrenTheme.textMuted).multilineTextAlignment(.center)
                    }
                    .frame(maxWidth: .infinity).padding(.vertical, PhrenTheme.Space.section)
                    .accessibilityElement(children: .combine).accessibilityIdentifier("session-servers-empty")
                } else {
                    ForEach(servers) { server in
                        Button { selected = WebServerSelection(hostID: session.host.id, server: server) } label: {
                            HStack(spacing: 10) {
                                Image(systemName: "globe").foregroundStyle(PhrenTheme.accent).frame(width: 22).accessibilityHidden(true)
                                VStack(alignment: .leading, spacing: 2) {
                                    Text(server.displayName).font(PhrenTheme.Font.body.weight(.medium)).foregroundStyle(PhrenTheme.text)
                                        .lineLimit(1)
                                    Text(server.mentionedHere ? "\(server.detail) · mentioned in this chat" : server.detail)
                                        .font(PhrenTheme.Font.caption).foregroundStyle(PhrenTheme.textMuted).lineLimit(1)
                                }
                                Spacer(minLength: 0)
                                Image(systemName: "chevron.right").font(PhrenTheme.Font.caption).foregroundStyle(PhrenTheme.textDim)
                                    .accessibilityHidden(true)
                            }
                            .frame(minHeight: 44).contentShape(Rectangle())
                        }
                        .buttonStyle(.plain)
                        .accessibilityIdentifier("session-server:\(server.port)")
                    }
                }
            } else if let message {
                Text(message).font(PhrenTheme.Font.caption).foregroundStyle(PhrenTheme.warning)
                    .accessibilityIdentifier("session-servers-error")
            } else {
                ProgressView().frame(maxWidth: .infinity).accessibilityIdentifier("session-servers-loading")
            }
        }
        .navigationTitle("Web servers")
        .navigationBarTitleDisplayMode(.inline)
        .phrenScreen()
        .refreshable { refresh = UUID() }
        .task(id: "\(refresh):\(phase == .active)") { if phase == .active { await load() } }
        .fullScreenCover(item: $selected) { selection in
            NavigationStack { WebPreviewView(selection: selection) }
        }
    }

    @MainActor private func load() async {
        #if DEBUG && targetEnvironment(simulator)
        if let fixture = Self.fixture(for: target) { servers = fixture; return }
        #endif
        do {
            servers = try await PhrenConnection.sessionWebServers(host: session.host, privateKey: DeviceSSHKey.load(session.host.id), target: target)
            message = nil
        } catch {
            guard !Task.isCancelled else { return }
            // A Hook older than this route answers 404 for it.
            message = "\(error)".contains("404") ? "Update Phren Hook on \(session.host.name) to list this session's web servers."
                : error.localizedDescription
        }
    }

    #if DEBUG && targetEnvironment(simulator)
    /// `--session-web-servers-fixture`: the fixture chat's tab w7:t9 started a
    /// dev server and names another; every other session has none of its own.
    /// `--session-web-servers-none` makes w7:t9 a session without servers.
    static func fixture(for target: AgentChatTarget) -> [WebServer]? {
        let arguments = ProcessInfo.processInfo.arguments
        guard AgentChatFixture.enabled, arguments.contains("--session-web-servers-fixture") else { return nil }
        guard target.tabID == "w7:t9", !arguments.contains("--session-web-servers-none") else { return [] }
        let json = #"{"servers":[{"name":"Vite App","port":5173,"origin":"http://127.0.0.1:5173","process":"node","pid":4101,"source":"started"},{"name":"API docs","port":8000,"origin":"http://127.0.0.1:8000","process":"python3","pid":4203,"source":"mentioned"}]}"#
        return try? WebServer.readSnapshot(Data(json.utf8))
    }
    #endif
}
