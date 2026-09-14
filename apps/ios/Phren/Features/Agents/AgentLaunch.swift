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
    struct Pending: Codable {
        var hostID: UUID, workspaceID: String, tabID: String, label: String, agent: String, cwd: String
    }
    static func setPending(_ session: LiveAgentSession) {
        let pending = Pending(hostID: session.host.id, workspaceID: session.workspaceID, tabID: session.tab.id, label: session.tab.displayTitle, agent: session.tab.agent ?? "codex", cwd: session.tab.cwd ?? "/")
        AppRuntime.defaults.set(try? JSONEncoder().encode(pending), forKey: pendingKey)
    }
    /// The pending chat, once, as a session on one of the saved hosts.
    static func takePending() -> LiveAgentSession? {
        guard let data = AppRuntime.defaults.data(forKey: pendingKey), let pending = try? JSONDecoder().decode(Pending.self, from: data) else { return nil }
        AppRuntime.defaults.removeObject(forKey: pendingKey)
        let hosts = (try? LiveSessionPreferences.read(AppRuntime.defaults.data(forKey: "sessions.live.preferences.v1") ?? Data()))?.hosts ?? []
        guard let host = hosts.first(where: { $0.id == pending.hostID }) else { return nil }
        return try? session(host: host, workspaceID: pending.workspaceID, tabID: pending.tabID, label: pending.label, agent: pending.agent, agentStatus: nil, cwd: pending.cwd)
    }
}
