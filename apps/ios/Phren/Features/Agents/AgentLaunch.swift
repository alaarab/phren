import PhrenKit
import PhrenLive
import SwiftUI

/// Starting an agent in a project on a computer — shared by the "Open on a
/// computer" screen and the Siri intents.
@MainActor
enum AgentLaunch {
    typealias Harness = PhrenConnection.LaunchKind
    static let harnessKey = "launch.kind.v1"
    /// The harness the user last chose on the launch screen; Codex until then.
    static var defaultHarness: Harness { Harness(rawValue: AppRuntime.defaults.string(forKey: harnessKey) ?? "") ?? .codex }

    /// The store's map of computers to projects, read from the cached store
    /// files — the same registry `AppModel.machineRegistry` serves, but
    /// available to an intent running before the app has bootstrapped.
    static func registry(storeID: String) async -> MachineRegistry {
        if let model = AppModel.current, model.storeContexts.contains(where: { $0.id == storeID }) { return model.machineRegistry(storeId: storeID) }
        guard let descriptor = AppModel.storedDescriptors().first(where: { $0.id == storeID }),
              let store = try? PhrenCapture.openStore(descriptor) else { return .empty }
        return await store.snapshot().machines
    }

    /// Whether the store says this computer carries the project — by the
    /// name the computer gives itself, or by how it was saved on the phone.
    static func knowsProject(_ host: LiveHost, computerName: String?, storeID: String, project: String) async -> Bool {
        let registry = await registry(storeID: storeID)
        return [computerName, host.name, host.address].compactMap { $0 }.contains { registry.hosts($0, project: project) }
    }

    /// Where the project lives on that computer: a folder already matched on
    /// this iPhone, else what the computer reports, else the folder the
    /// project was added to phren from.
    static func folder(host: LiveHost, storeID: String, project: String) async -> String? {
        let preferences = try? LiveSessionPreferences.read(AppRuntime.defaults.data(forKey: "sessions.live.preferences.v1") ?? Data())
        if let saved = preferences?.mappings.first(where: { $0.hostID == host.id && $0.storeID == storeID && $0.project == project }) { return saved.directory }
        let located: [PhrenConnection.LocatedFolder]
        #if DEBUG && targetEnvironment(simulator)
        if AgentChatFixture.enabled { located = (try? await AgentChatFixture.locate(project: project)) ?? [] }
        else { located = (try? await PhrenConnection.locateProject(host: host, privateKey: DeviceSSHKey.load(host.id), project: project)) ?? [] }
        #else
        located = (try? await PhrenConnection.locateProject(host: host, privateKey: DeviceSSHKey.load(host.id), project: project)) ?? []
        #endif
        if let first = located.first { return first.directory }
        let source = await registry(storeID: storeID).sourcePaths[project]
        return source?.hasPrefix("/") == true ? source : nil
    }

    /// Asks the Hook to create the workspace and start the agent, then waits
    /// for Herdr to list the new tab with its agent so the chat can target it.
    static func launch(host: LiveHost, cwd: String, label: String, kind: Harness, progress: @MainActor (String) -> Void = { _ in }) async throws -> LiveAgentSession {
        #if DEBUG && targetEnvironment(simulator)
        if AgentChatFixture.enabled { return try await AgentChatFixture.launch(host: host, cwd: cwd, label: label, kind: kind.rawValue) }
        #endif
        let key = try DeviceSSHKey.load(host.id)
        let launched = try await PhrenConnection.launchSession(host: host, privateKey: key, cwd: cwd, label: label, kind: kind)
        await progress("Waiting for \(kind.title) to be ready…")
        for _ in 0..<20 {
            if let session = try await PhrenConnection.fetch(host: host, privateKey: key).sessions(on: host)
                .first(where: { $0.workspaceID == launched.workspaceID && $0.tab.id == launched.tabID }) {
                if session.tab.agent != nil { return session }
            }
            try await Task.sleep(for: .seconds(1))
        }
        // The agent started (the Hook said so) but the overview hasn't caught up;
        // open the chat on the identifiers we have.
        return try session(host: host, workspaceID: launched.workspaceID, tabID: launched.tabID, label: label, agent: kind.rawValue, agentStatus: launched.agentStatus, cwd: cwd)
    }

    /// A session object from its identifiers alone.
    static func session(host: LiveHost, workspaceID: String, tabID: String, label: String, agent: String, agentStatus: String?, cwd: String) throws -> LiveAgentSession {
        let escape = { (s: String) in s.replacingOccurrences(of: "\\", with: "\\\\").replacingOccurrences(of: "\"", with: "\\\"") }
        let json = #"{"kind":"herdr","groups":[{"id":"\#(escape(workspaceID))","label":"\#(escape(label))","children":[{"id":"\#(escape(tabID))","label":"1","title":"\#(escape(label))","agent":"\#(escape(agent))","agentStatus":"\#(escape(agentStatus ?? "idle"))","cwd":"\#(escape(cwd))"}]}]}"#
        guard let session = try LiveWorkspaces.read(Data(json.utf8)).sessions(on: host).first else {
            throw PhrenKitError.validation("The workspace was created, but its session couldn't be opened. Find it under Live sessions.")
        }
        return session
    }

    /// Remembers the folder for this project on this computer, so the next
    /// session is found without asking.
    static func remember(host: LiveHost, cwd: String, storeID: String, project: String) {
        let key = "sessions.live.preferences.v1"
        let data = AppRuntime.defaults.data(forKey: key) ?? Data()
        if let updated = try? LiveSessionPreferences.assigning(hostID: host.id, directory: cwd, storeID: storeID, project: project, in: data) {
            AppRuntime.defaults.set(updated, forKey: key)
        }
    }

    // MARK: - A chat the app should open next (set by an intent, consumed by the Agents tab)

    static let pendingKey = "agents.pendingChat.v1"
    static let pendingProjectKey = "projects.pendingOpen.v1"
    static let pendingContentKey = "agents.pendingChatContent.v1"
    enum Destination: String, Codable { case chat, terminal }
    struct Pending: Codable {
        var hostID: UUID, workspaceID: String, tabID: String, label: String, agent: String, cwd: String
        var muxID: String? = nil
        var destination: Destination? = nil
    }
    struct PendingProject: Codable, Hashable {
        let storeID: String
        let project: String
    }
    static func setPending(_ session: LiveAgentSession, destination: Destination = .chat) {
        clearPendingContent()
        writePending(session, destination: destination)
    }
    static func setPending(_ session: LiveAgentSession, destination: Destination = .chat,
                           draft: String, attachments: [AgentAttachment],
                           attachmentStore: PendingChatAttachmentStore = .shared) throws {
        let records = try attachments.map(attachmentStore.save)
        clearPendingContent(store: attachmentStore)
        let content = PendingChatContent(hostID: session.host.id, muxID: session.host.muxID,
                                         workspaceID: session.workspaceID, tabID: session.tab.id,
                                         draft: draft, attachments: records)
        AppRuntime.defaults.set(try JSONEncoder().encode(content), forKey: pendingContentKey)
        writePending(session, destination: destination)
    }
    private static func writePending(_ session: LiveAgentSession, destination: Destination) {
        let pending = Pending(hostID: session.host.id, workspaceID: session.workspaceID, tabID: session.tab.id, label: session.tab.displayTitle, agent: session.tab.agent ?? "codex", cwd: session.tab.cwd ?? "/", muxID: session.host.muxID, destination: destination)
        AppRuntime.defaults.removeObject(forKey: pendingProjectKey)
        AppRuntime.defaults.set(try? JSONEncoder().encode(pending), forKey: pendingKey)
        restorePendingNavigation()
    }
    static func setPendingProject(storeID: String, project: String) {
        clearPendingContent()
        AppRuntime.defaults.removeObject(forKey: pendingKey)
        AppRuntime.defaults.set(try? JSONEncoder().encode(PendingProject(storeID: storeID, project: project)), forKey: pendingProjectKey)
        restorePendingNavigation()
    }
    static func restorePendingNavigation() {
        if AppRuntime.defaults.data(forKey: pendingKey) != nil {
            AppModel.current?.selectedTab = .agents
            AppModel.current?.pendingChatVersion += 1
        } else if AppRuntime.defaults.data(forKey: pendingProjectKey) != nil {
            AppModel.current?.selectedTab = .projects
            AppModel.current?.pendingProjectVersion += 1
        }
    }
    static func takePendingProject() -> PendingProject? {
        guard let data = AppRuntime.defaults.data(forKey: pendingProjectKey) else { return nil }
        AppRuntime.defaults.removeObject(forKey: pendingProjectKey)
        return try? JSONDecoder().decode(PendingProject.self, from: data)
    }
    /// Carry identity into the native view; chat/terminal performs its normal
    /// fresh connection and pane validation before any remote interaction.
    static func openIndexedSession(_ entity: AgentSessionEntity, destination: Destination) throws {
        guard entity.isLive, let workspace = entity.workspaceID, let tab = entity.tabID,
              let host = AgentSessions.hosts.first(where: { $0.id == entity.hostID && $0.muxID == entity.muxID }) else {
            throw PhrenKitError.validation("That session's computer or terminal server is no longer saved.")
        }
        let live = try session(host: host, workspaceID: workspace, tabID: tab, label: entity.title,
                               agent: entity.agent ?? "codex", agentStatus: nil, cwd: entity.folder ?? "/")
        setPending(live, destination: destination)
    }
    static func takePendingOpen() -> (session: LiveAgentSession, destination: Destination)? {
        guard let data = AppRuntime.defaults.data(forKey: pendingKey) else { return nil }
        AppRuntime.defaults.removeObject(forKey: pendingKey)
        guard let pending = try? JSONDecoder().decode(Pending.self, from: data),
              let host = AgentSessions.hosts.first(where: { $0.id == pending.hostID && (pending.muxID == nil || $0.muxID == pending.muxID) }),
              let live = try? session(host: host, workspaceID: pending.workspaceID, tabID: pending.tabID,
                                      label: pending.label, agent: pending.agent, agentStatus: nil, cwd: pending.cwd) else {
            clearPendingContent()
            return nil
        }
        return (live, pending.destination ?? .chat)
    }
    static func takePendingContent(for session: LiveAgentSession,
                                   store: PendingChatAttachmentStore = .shared) -> (draft: String, attachments: [AgentAttachment]) {
        guard let data = AppRuntime.defaults.data(forKey: pendingContentKey) else { return ("", []) }
        AppRuntime.defaults.removeObject(forKey: pendingContentKey)
        guard let content = try? JSONDecoder().decode(PendingChatContent.self, from: data) else { return ("", []) }
        guard content.hostID == session.host.id, content.muxID == session.host.muxID,
              content.workspaceID == session.workspaceID, content.tabID == session.tab.id else {
            store.discard(content.attachments)
            return ("", [])
        }
        return (content.draft, content.attachments.compactMap(store.take))
    }
    private static func clearPendingContent(store: PendingChatAttachmentStore = .shared) {
        if let data = AppRuntime.defaults.data(forKey: pendingContentKey),
           let content = try? JSONDecoder().decode(PendingChatContent.self, from: data) {
            store.discard(content.attachments)
        }
        AppRuntime.defaults.removeObject(forKey: pendingContentKey)
    }
    static func takePending() -> LiveAgentSession? { takePendingOpen()?.session }
}

struct PendingChatContent: Codable, Equatable {
    let hostID: UUID
    let muxID: String
    let workspaceID: String
    let tabID: String
    let draft: String
    let attachments: [PendingChatAttachmentStore.Record]
}

struct PendingChatAttachmentStore: Sendable {
    struct Record: Codable, Equatable, Sendable {
        let id: UUID
        let name: String
        let filename: String
        let isImage: Bool
    }

    static let shared: Self = {
        let support = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0]
        return Self(root: support.appendingPathComponent("PendingChatAttachments", isDirectory: true))
    }()

    let root: URL

    func save(_ attachment: AgentAttachment) throws -> Record {
        try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
        let filename = attachment.id.uuidString.lowercased() + ".bin"
        try attachment.data.write(to: root.appendingPathComponent(filename), options: .atomic)
        return Record(id: attachment.id, name: attachment.name, filename: filename, isImage: attachment.isImage)
    }

    func take(_ record: Record) -> AgentAttachment? {
        guard record.filename == record.id.uuidString.lowercased() + ".bin" else { return nil }
        let url = root.appendingPathComponent(record.filename)
        defer { try? FileManager.default.removeItem(at: url) }
        guard let data = try? Data(contentsOf: url) else { return nil }
        return try? AgentAttachment(id: record.id, name: record.name, data: data, isImage: record.isImage)
    }

    func discard(_ records: [Record]) {
        for record in records where record.filename == record.id.uuidString.lowercased() + ".bin" {
            try? FileManager.default.removeItem(at: root.appendingPathComponent(record.filename))
        }
    }
}
