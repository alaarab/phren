import PhrenKit
import PhrenLive
import SwiftUI

/// "Open on a computer": pick the computer, confirm the folder, pick the
/// harness, and the phone asks Phren Hook to create a Herdr workspace there,
/// start the agent in it, and open the chat. The store already says which
/// computers carry the project (`machines.yaml` + profiles) and the folder
/// it was added from, so the usual case is three taps.
struct LaunchSessionView: View {
    let storeID: String
    let project: String
    var taskRequest: TaskAgentRequest? = nil
    @Environment(AppModel.self) private var model
    @Environment(\.dismiss) private var dismiss
    @AppStorage("sessions.live.preferences.v1") private var data = Data()
    @AppStorage("launch.kind.v1") private var kind = "codex"
    @State private var hostID: UUID?
    @State private var folder = ""
    @State private var folderEdited = false
    @State private var computerNames: [UUID: String] = [:]
    /// Folders the selected computer says the project lives in.
    @State private var located: [UUID: [PhrenConnection.LocatedFolder]] = [:]
    @State private var locating = false
    @State private var launching = false
    @State private var status: String?
    @State private var error: String?
    @State private var chatSession: LiveAgentSession?
    @State private var modelName = ""

    private typealias Harness = PhrenConnection.LaunchKind
    private var harness: Harness? { Harness(rawValue: kind) }
    /// Harnesses whose CLI accepts a model at startup.
    private var supportsModel: Bool { ["codex", "claude", "opencode"].contains(kind) }
    private var modelSuggestions: [String] {
        switch kind {
        case "opencode": return ["openrouter/deepseek/deepseek-v4.1-flash", "openrouter/deepseek/deepseek-v4-pro"]
        case "claude": return ["opus", "sonnet", "haiku"]
        case "codex": return ["gpt-5-codex", "gpt-5"]
        default: return []
        }
    }
    private var modelPlaceholder: String {
        switch kind {
        case "opencode": return "provider/model"
        case "claude": return "opus, sonnet, or haiku"
        case "codex": return "e.g. gpt-5-codex"
        default: return "model"
        }
    }
    private func storedModel(_ kind: String) -> String { UserDefaults.standard.string(forKey: "launch.model.\(kind)") ?? "" }
    private var preferences: LiveSessionPreferences? { try? LiveSessionPreferences.read(data) }
    private var hosts: [LiveHost] { preferences?.hosts ?? [] }
    private var registry: MachineRegistry { model.machineRegistry(storeId: storeID) }
    private var selectedHost: LiveHost? { hosts.first { $0.id == hostID } }

    /// The store knows this computer has the project, by the name the
    /// computer gives itself (from the Hook), or by how it was saved here.
    private func knowsProject(_ host: LiveHost) -> Bool {
        [computerNames[host.id], host.name, host.address].compactMap { $0 }.contains { registry.hosts($0, project: project) }
    }

    /// Where the project lives on that computer: a folder the user already
    /// matched to it on this iPhone, else what the computer itself reports
    /// (an agent worked there, Herdr saved it, phren registered it), else the
    /// folder the project was added to phren from — which may be another
    /// machine's path, so it comes last.
    private func suggestedFolder(_ host: LiveHost) -> String {
        if let saved = preferences?.mappings.first(where: { $0.hostID == host.id && $0.storeID == storeID && $0.project == project }) {
            return saved.directory
        }
        return located[host.id]?.first?.directory ?? registry.sourcePaths[project] ?? ""
    }

    private func locate(_ host: LiveHost) async {
        guard host.fingerprint != nil, located[host.id] == nil else { return }
        locating = true
        defer { locating = false }
        let folders: [PhrenConnection.LocatedFolder]
        #if DEBUG && targetEnvironment(simulator)
        if AgentChatFixture.enabled { folders = (try? await AgentChatFixture.locate(project: project)) ?? [] }
        else { folders = (try? await PhrenConnection.locateProject(host: host, privateKey: DeviceSSHKey.load(host.id), project: project)) ?? [] }
        #else
        folders = (try? await PhrenConnection.locateProject(host: host, privateKey: DeviceSSHKey.load(host.id), project: project)) ?? []
        #endif
        located[host.id] = folders
        if hostID == host.id, !folderEdited { folder = suggestedFolder(host); folderEdited = false }
    }

    private var canOpen: Bool {
        !launching && selectedHost?.fingerprint != nil && folder.hasPrefix("/") && harness != nil
    }

    var body: some View {
        PhrenNavigationStack {
            PhrenList {
                Section {
                    if hosts.isEmpty {
                        Text("Connect a computer in Agents first. Phren Hook on it creates the workspace.").foregroundStyle(PhrenTheme.textMuted)
                    }
                    ForEach(hosts) { host in
                        Button { select(host) } label: {
                            HStack(spacing: 10) {
                                Image(systemName: "desktopcomputer").foregroundStyle(PhrenTheme.textMuted)
                                VStack(alignment: .leading, spacing: 2) {
                                    Text(host.name).foregroundStyle(PhrenTheme.text)
                                    if knowsProject(host) {
                                        Text("has \(project)").font(.caption).foregroundStyle(PhrenTheme.success)
                                    } else if host.fingerprint == nil {
                                        Text("finish verifying in Agents").font(.caption).foregroundStyle(PhrenTheme.warning)
                                    }
                                }
                                Spacer()
                                if host.id == hostID { Image(systemName: "checkmark").foregroundStyle(PhrenTheme.cyan) }
                            }
                        }
                        .accessibilityIdentifier("launch-computer:\(host.id)")
                        .accessibilityAddTraits(host.id == hostID ? .isSelected : [])
                    }
                } header: { Text("Computer") }

                Section {
                    TextField("/path/to/\(project)", text: $folder)
                        .font(.system(.body, design: .monospaced)).autocorrectionDisabled().textInputAutocapitalization(.never)
                        .onChange(of: folder) { _, _ in folderEdited = true }
                        .accessibilityIdentifier("launch-folder")
                    if let host = selectedHost {
                        if locating && located[host.id] == nil {
                            HStack(spacing: 8) { ProgressView().controlSize(.small); Text("Asking \(host.name) where \(project) is…") }
                                .font(.caption).foregroundStyle(PhrenTheme.textMuted)
                        }
                        ForEach(located[host.id] ?? []) { candidate in
                            Button { folder = candidate.directory; folderEdited = false } label: {
                                HStack(spacing: 8) {
                                    Image(systemName: candidate.directory == folder ? "checkmark.circle.fill" : "folder")
                                        .foregroundStyle(candidate.directory == folder ? PhrenTheme.success : PhrenTheme.chatNeutralDim)
                                    VStack(alignment: .leading, spacing: 1) {
                                        Text(candidate.directory).font(.system(.caption, design: .monospaced)).foregroundStyle(PhrenTheme.text)
                                            .lineLimit(1).truncationMode(.head)
                                        Text(candidate.sourceLabel).font(.caption2).foregroundStyle(PhrenTheme.textMuted)
                                    }
                                }
                            }
                            .accessibilityIdentifier("launch-found:\(candidate.directory)")
                        }
                    }
                } header: { Text("Folder on that computer") } footer: {
                    Text(selectedHost.flatMap { located[$0.id]?.isEmpty == false ? "Found on the computer itself — where an agent last worked on it, a saved Herdr workspace, or phren's registration." : nil }
                         ?? (folderEdited || selectedHost.map(suggestedFolder)?.isEmpty != false
                             ? "The workspace opens here; the agent starts in it."
                             : "From where the project was added to phren. Change it if this computer keeps it elsewhere."))
                }

                Section {
                    ForEach(Harness.allCases) { harness in
                        Button { kind = harness.rawValue } label: {
                            HStack(spacing: 10) {
                                AgentProviderGlyph(source: harness.rawValue, size: 20)
                                Text(harness.title).foregroundStyle(PhrenTheme.text)
                                Spacer()
                                if kind == harness.rawValue { Image(systemName: "checkmark").foregroundStyle(PhrenTheme.cyan) }
                            }
                        }
                        .accessibilityIdentifier("launch-harness:\(harness.rawValue)")
                        .accessibilityAddTraits(kind == harness.rawValue ? .isSelected : [])
                    }
                } header: { Text("Harness") }

                if supportsModel {
                    Section {
                        TextField(modelPlaceholder, text: $modelName)
                            .font(.system(.body, design: .monospaced)).autocorrectionDisabled().textInputAutocapitalization(.never)
                            .accessibilityIdentifier("launch-model")
                        ForEach(modelSuggestions, id: \.self) { suggestion in
                            Button { modelName = suggestion } label: {
                                HStack(spacing: 8) {
                                    Text(suggestion).font(.system(.caption, design: .monospaced)).foregroundStyle(PhrenTheme.text)
                                    Spacer()
                                    if modelName == suggestion { Image(systemName: "checkmark").foregroundStyle(PhrenTheme.cyan) }
                                }
                            }
                            .accessibilityIdentifier("launch-model-suggestion:\(suggestion)")
                        }
                    } header: { Text("Model") } footer: {
                        Text("Optional. Passed to \(harness?.title ?? kind) as --model when it starts; leave blank for its default.")
                    }
                }

                Section {
                    Button {
                        Task { await open() }
                    } label: {
                        HStack {
                            if launching { ProgressView().tint(PhrenTheme.chatPanel).padding(.trailing, 6) }
                            Text(launching ? (status ?? "Opening…") : taskRequest == nil
                                 ? "Open \(project) with \(harness?.title ?? kind)"
                                 : "Start \(harness?.title ?? kind) on task")
                                .fontWeight(.semibold)
                        }
                        .frame(maxWidth: .infinity, minHeight: 44)
                    }
                    .buttonStyle(.borderedProminent).tint(PhrenTheme.cyan).foregroundStyle(PhrenTheme.chatPanel)
                    .disabled(!canOpen)
                    .accessibilityIdentifier("launch-open")
                } footer: {
                    Text(taskRequest == nil
                         ? "Creates a Herdr workspace on the computer, starts the agent in it, and opens the chat here. Starting can take up to a minute."
                         : "Creates a workspace, sends the task and its context, then opens the working agent. The task moves to Active only after delivery succeeds.")
                }
            }
            .listSectionSpacing(12)
            .navigationTitle("Open \(project)").navigationBarTitleDisplayMode(.inline)
            .toolbar { ToolbarItem(placement: .cancellationAction) { Button("Cancel") { dismiss() }.disabled(launching) } }
            .phrenScreen()
            .modifier(SessionLaunchAlert(error: $error))
            .navigationDestination(item: $chatSession) { AgentChatSheet(session: $0) }
            .interactiveDismissDisabled(launching)
            .task { modelName = storedModel(kind); await prepare() }
            .onChange(of: kind) { _, newKind in modelName = storedModel(newKind) }
            .onChange(of: modelName) { _, newValue in UserDefaults.standard.set(newValue, forKey: "launch.model.\(kind)") }
        }
    }

    /// Pre-select the first computer the store says has the project, and
    /// learn each computer's own name so `machines.yaml` can be matched.
    private func prepare() async {
        if hostID == nil, let known = hosts.first(where: knowsProject) ?? hosts.first { select(known) }
        await withTaskGroup(of: (UUID, String?).self) { group in
            for host in hosts where host.fingerprint != nil {
                group.addTask {
                    #if DEBUG && targetEnvironment(simulator)
                    if AgentChatFixture.enabled { return (host.id, host.name) }
                    #endif
                    let name = try? await PhrenConnection.computerName(host: host, privateKey: DeviceSSHKey.load(host.id))
                    return (host.id, name)
                }
            }
            for await (id, name) in group where name != nil { computerNames[id] = name }
        }
        // A better-informed choice once names are in, unless the user moved on.
        if !folderEdited, let current = selectedHost, !knowsProject(current), let known = hosts.first(where: knowsProject) { select(known) }
    }

    private func select(_ host: LiveHost) {
        hostID = host.id
        if !folderEdited { folder = suggestedFolder(host); folderEdited = false }
        Task { await locate(host) }
    }

    private func open() async {
        guard let host = selectedHost, let harness, canOpen else { return }
        let cwd = folder.trimmingCharacters(in: .whitespacesAndNewlines)
        launching = true; error = nil
        defer { launching = false; status = nil }
        do {
            status = "Starting \(harness.title) in \(project)…"
            let chosen = supportsModel ? modelName.trimmingCharacters(in: .whitespacesAndNewlines) : ""
            let session = try await AgentLaunch.launch(host: host, cwd: cwd, label: project, kind: harness, model: chosen.isEmpty ? nil : chosen) { status = $0 }
            // Remember the folder for this project on this computer, so the
            // next session is found without asking.
            data = (try? LiveSessionPreferences.assigning(hostID: host.id, directory: cwd, storeID: storeID, project: project, in: data)) ?? data
            if let request = taskRequest {
                status = "Sending task to \(harness.title)…"
                do {
                    try await AgentLaunch.sendInitialPrompt(request.prompt, to: session)
                } catch {
                    throw PhrenKitError.validation("The agent session was created, but Phren couldn't send the task. The task remains in \(request.row.task.section == .queue ? "Backlog" : request.row.task.section.rawValue). Find the new session in Agents and try again. \(error.localizedDescription)")
                }
                if request.row.task.section == .queue {
                    status = "Marking task active…"
                    do {
                        try await model.enqueue(TaskMove.start.operation(for: request.row), in: request.row.storeId)
                        await model.refresh()
                    } catch {
                        model.lastActionError = "The agent is working, but the task couldn't move to Active. \(error.localizedDescription)"
                    }
                }
            }
            chatSession = session
        } catch {
            self.error = error.localizedDescription
        }
    }

}
