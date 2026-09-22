import PhrenKit
import PhrenLive
import SwiftUI

/// "Open on a computer": pick the computer, confirm the folder, pick the
/// harness, and the phone asks Phren Hook to create a Herdr workspace there,
/// start the agent in it, and open the chat. The store already says which
/// computers carry the project (`machines.yaml` + profiles) and the folder
/// it was added from, so the usual case is three taps.
struct LaunchSessionView: View {
    @State private var storeID: String
    @State private var project: String
    var taskRequest: TaskAgentRequest? = nil
    var preferredHostID: UUID? = nil
    var allowsStoreSelection = false
    var onStoreSelected: ((String) -> Void)? = nil
    var onTaskMoved: ((TaskListRow, PhrenTask.Section) -> Void)? = nil
    @Environment(AppModel.self) private var model
    @Environment(\.dismiss) private var dismiss
    @AppStorage("sessions.live.preferences.v1") private var data = Data()
    @AppStorage("launch.kind.v1") private var kind = "codex"
    @State private var hostID: UUID?
    @State private var showComputers = false
    @State private var showStores = false
    @State private var showProjects = false
    @State private var prepared = false
    @State private var folder = ""
    @State private var folderEdited = false
    @State private var computerNames: [UUID: String] = [:]
    /// Folders the selected computer says the project lives in.
    @State private var located: [UUID: [PhrenConnection.LocatedFolder]] = [:]
    @State private var locating = false
    @State private var launching = false
    @State private var status: String?
    @State private var error: String?
    @State private var role: PhrenConnection.LaunchRole = .agent
    @State private var effort: PhrenConnection.LaunchEffort = .medium
    @State private var showRoles = false
    @State private var showEfforts = false
    @State private var runningConductor: LiveAgentSession?
    @State private var showRunningConductor = false
    @State private var chatSession: LiveAgentSession?
    @State private var terminalRoute: TerminalDestination?
    @State private var modelName = ""

    init(storeID: String, project: String, taskRequest: TaskAgentRequest? = nil,
         preferredHostID: UUID? = nil, initialRole: PhrenConnection.LaunchRole = .agent,
         allowsStoreSelection: Bool = false, onStoreSelected: ((String) -> Void)? = nil,
         onTaskMoved: ((TaskListRow, PhrenTask.Section) -> Void)? = nil) {
        _storeID = State(initialValue: storeID)
        _project = State(initialValue: project)
        _role = State(initialValue: initialRole)
        self.taskRequest = taskRequest
        self.preferredHostID = preferredHostID
        self.allowsStoreSelection = allowsStoreSelection
        self.onStoreSelected = onStoreSelected
        self.onTaskMoved = onTaskMoved
    }

    private typealias Harness = PhrenConnection.LaunchKind
    private var harness: Harness? { Harness(rawValue: kind) }
    /// Harnesses whose CLI accepts a model at startup.
    private var supportsModel: Bool { ["codex", "claude", "opencode"].contains(kind) }
    private var supportsEffort: Bool { ["codex", "claude", "opencode"].contains(kind) }
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
    private func storedModel(_ kind: String) -> String { AppRuntime.defaults.string(forKey: "launch.model.\(kind)") ?? "" }
    private var roleOptions: [PhrenOption<PhrenConnection.LaunchRole>] {
        [.init(id: "agent", value: .agent, title: "Agent"),
         .init(id: "conductor", value: .conductor, title: conductorSummary)]
    }
    private var effortOptions: [PhrenOption<PhrenConnection.LaunchEffort>] {
        PhrenConnection.LaunchEffort.allCases.map { .init(id: $0.rawValue, value: $0, title: $0.rawValue.capitalized) }
    }
    private var conductorSummary: String {
        let harnessName = harness.map { $0 == .claude ? "Claude" : $0.title } ?? kind.capitalized
        let chosenModel = modelName.trimmingCharacters(in: .whitespacesAndNewlines)
        return ["Conductor", [harnessName, chosenModel.isEmpty ? nil : displayModel(chosenModel)].compactMap { $0 }.joined(separator: " "), effort.rawValue]
            .joined(separator: " · ")
    }
    private var preferences: LiveSessionPreferences? { try? LiveSessionPreferences.read(data) }
    private var hosts: [LiveHost] { preferences?.hosts ?? [] }
    private var registry: MachineRegistry { model.machineRegistry(storeId: storeID) }
    private var selectedHost: LiveHost? { hosts.first { $0.id == hostID } }
    private var storeOptions: [PhrenOption<String>] {
        model.storeDescriptors.map { .init(id: $0.id, value: $0.id, title: $0.id) }
    }
    private var projectOptions: [PhrenOption<String>] {
        model.sessionProjects.filter { $0.storeID == storeID && $0.name != "global" }
            .sorted { $0.name < $1.name }
            .map { .init(id: $0.name, value: $0.name, title: $0.name) }
    }
    private var conductorHostID: UUID? {
        guard role == .conductor, let saved = ConductorLaunchSettings.load(storeID: storeID)?.hostID,
              hosts.contains(where: { $0.id == saved }) else { return nil }
        return saved
    }
    private var computerOptions: [PhrenOption<UUID?>] {
        hosts.map { host in
            PhrenOption(id: host.id.uuidString, value: host.id, title: host.name,
                        caption: knowsProject(host) ? "has \(project)"
                            : (host.fingerprint == nil ? "finish verifying in Agents" : nil),
                        icon: "desktopcomputer")
        }
    }

    /// The store knows this computer has the project, by the name the
    /// computer gives itself (from the Hook), or by how it was saved here.
    private func knowsProject(_ host: LiveHost) -> Bool {
        [computerNames[host.id], host.name, host.address].compactMap { $0 }.contains { registry.hosts($0, project: project) }
    }

    /// Where the project lives on that computer: a folder the user already
    /// matched to it on this iPhone, else what the computer itself reports
    /// (an agent worked there, Herdr saved it, phren registered it), else the
    /// folder the project was added to phren from, which may be another
    /// machine's path, so it comes last.
    private func suggestedFolder(_ host: LiveHost) -> String {
        if let saved = preferences?.mappings.first(where: { $0.hostID == host.id && $0.storeID == storeID && $0.project == project }) {
            return saved.directory
        }
        return located[host.id]?.first?.directory ?? registry.sourcePaths[project] ?? ""
    }

    private func locate(_ host: LiveHost) async {
        guard host.fingerprint != nil, located[host.id] == nil else { return }
        let locatingStore = storeID, locatingProject = project
        locating = true
        defer { locating = false }
        let folders: [PhrenConnection.LocatedFolder]
        #if DEBUG && targetEnvironment(simulator)
        if AgentChatFixture.enabled { folders = (try? await AgentChatFixture.locate(project: project)) ?? [] }
        else { folders = (try? await PhrenConnection.locateProject(host: host, privateKey: DeviceSSHKey.load(host.id), project: project)) ?? [] }
        #else
        folders = (try? await PhrenConnection.locateProject(host: host, privateKey: DeviceSSHKey.load(host.id), project: project)) ?? []
        #endif
        guard storeID == locatingStore, project == locatingProject else { return }
        located[host.id] = folders
        if hostID == host.id, !folderEdited { folder = suggestedFolder(host); folderEdited = false }
    }

    private var canOpen: Bool {
        !launching && selectedHost?.fingerprint != nil && folder.hasPrefix("/") && harness != nil
    }

    var body: some View {
        PhrenNavigationStack {
            PhrenScreen {
                if allowsStoreSelection {
                    if storeOptions.count > 1 {
                        PhrenGroup("Store") {
                            PhrenSingleSelect(options: storeOptions, selection: $storeID,
                                              placeholder: "Store", identifier: "launch-store",
                                              isPresented: $showStores)
                        }
                    }
                    if !projectOptions.isEmpty {
                        PhrenGroup("Project") {
                            PhrenSingleSelect(options: projectOptions, selection: $project,
                                              placeholder: "Project", identifier: "launch-project",
                                              isPresented: $showProjects)
                        }
                    }
                }
                PhrenGroup("Role") {
                    PhrenSingleSelect(options: roleOptions, selection: $role,
                                      placeholder: "Role", identifier: "launch-role",
                                      isPresented: $showRoles)
                }

                PhrenGroup("Computer") {
                    if hosts.isEmpty {
                        Text("Connect a computer in Agents first. Phren Hook on it creates the workspace.").foregroundStyle(PhrenTheme.textMuted)
                    } else {
                        PhrenSingleSelect(options: computerOptions, selection: $hostID,
                                          placeholder: "Choose a computer", identifier: "launch-computer",
                                          isPresented: $showComputers)
                    }
                }

                PhrenGroup("Folder on that computer") {
                    TextField("/path/to/\(project)", text: Binding(get: { folder }, set: { folder = $0; folderEdited = true }))
                        .font(.system(.body, design: .monospaced)).autocorrectionDisabled().textInputAutocapitalization(.never)
                        .padding(PhrenTheme.Space.medium)
                        .background(PhrenTheme.surfaceRaised, in: RoundedRectangle(cornerRadius: PhrenTheme.Radius.questionOption))
                        .accessibilityIdentifier("launch-folder")
                    if let host = selectedHost {
                        if locating && located[host.id] == nil {
                            HStack(spacing: 8) { ProgressView().controlSize(.small); Text("Asking \(host.name) where \(project) is…") }
                                .font(.caption).foregroundStyle(PhrenTheme.textMuted)
                        }
                        ForEach(located[host.id] ?? []) { candidate in
                            PhrenOptionRow(title: candidate.directory, caption: candidate.sourceLabel,
                                           selected: candidate.directory == folder, icon: "folder") {
                                folder = candidate.directory
                                folderEdited = false
                            }
                            .accessibilityIdentifier("launch-found:\(candidate.directory)")
                        }
                    }
                    Text(selectedHost.flatMap { located[$0.id]?.isEmpty == false ? "Found on the computer itself: where an agent last worked on it, a saved Herdr workspace, or phren's registration." : nil }
                         ?? (folderEdited || selectedHost.map(suggestedFolder)?.isEmpty != false
                             ? "The workspace opens here; the agent starts in it."
                             : "From where the project was added to phren. Change it if this computer keeps it elsewhere."))
                        .font(PhrenTypography.caption).foregroundStyle(PhrenTheme.textMuted)
                }

                PhrenGroup("Harness") {
                    ForEach(Harness.allCases) { harness in
                        PhrenOptionRow(title: harness.title, selected: kind == harness.rawValue,
                                       glyph: AnyView(AgentProviderGlyph(source: harness.rawValue, size: 20))) {
                            kind = harness.rawValue
                        }
                        .accessibilityIdentifier("launch-harness:\(harness.rawValue)")
                        .accessibilityAddTraits(kind == harness.rawValue ? .isSelected : [])
                    }
                }

                if supportsModel {
                    PhrenGroup("Model") {
                        TextField(modelPlaceholder, text: $modelName)
                            .font(.system(.body, design: .monospaced)).autocorrectionDisabled().textInputAutocapitalization(.never)
                            .padding(PhrenTheme.Space.medium)
                            .background(PhrenTheme.surfaceRaised, in: RoundedRectangle(cornerRadius: PhrenTheme.Radius.questionOption))
                            .accessibilityIdentifier("launch-model")
                        ForEach(modelSuggestions, id: \.self) { suggestion in
                            PhrenOptionRow(title: suggestion, selected: modelName == suggestion) {
                                modelName = suggestion
                            }
                            .accessibilityIdentifier("launch-model-suggestion:\(suggestion)")
                        }
                        Text("Optional. Passed to \(harness?.title ?? kind) as --model when it starts; leave blank for its default.")
                            .font(PhrenTypography.caption).foregroundStyle(PhrenTheme.textMuted)
                    }
                }

                if role == .conductor && supportsEffort {
                    PhrenGroup("Effort") {
                        PhrenSingleSelect(options: effortOptions, selection: $effort,
                                          placeholder: "Effort", identifier: "launch-effort",
                                          isPresented: $showEfforts)
                    }
                }

                VStack(alignment: .leading, spacing: PhrenTheme.Space.small) {
                    Button {
                        Task { await open() }
                    } label: {
                        HStack {
                            if launching { ProgressView().tint(PhrenTheme.chatPanel).padding(.trailing, 6) }
                            Text(launching ? (status ?? "Opening…") : taskRequest == nil
                                 ? role == .conductor ? "Open \(project) with Conductor"
                                 : "Open \(project) with \(harness?.title ?? kind)"
                                 : "Start \(harness?.title ?? kind) on task")
                                .fontWeight(.semibold)
                        }
                        .frame(maxWidth: .infinity, minHeight: 44)
                    }
                    .buttonStyle(.plain).foregroundStyle(PhrenTheme.chatPanel)
                    .background(PhrenTheme.cyan, in: RoundedRectangle(cornerRadius: PhrenTheme.Radius.questionOption))
                    .disabled(!canOpen)
                    .opacity(canOpen ? 1 : 0.45)
                    .accessibilityIdentifier("launch-open")
                    Text(taskRequest == nil
                         ? "Creates a Herdr workspace on the computer, starts the agent in it, and opens the chat here. Starting can take up to a minute."
                         : "Creates a workspace, sends the task and its context, then opens the working agent. The task moves to Active only after delivery succeeds.")
                        .font(PhrenTypography.caption).foregroundStyle(PhrenTheme.textMuted)
                }

                if taskRequest == nil {
                    VStack(alignment: .leading, spacing: PhrenTheme.Space.small) {
                        Button {
                            guard let host = selectedHost else { return }
                            terminalRoute = TerminalDestination(host: host, route: .shell(directory: folder.trimmingCharacters(in: .whitespacesAndNewlines), agent: harness))
                        } label: {
                            PhrenRow(icon: "terminal", title: "Open a terminal instead")
                        }
                        .buttonStyle(.plain)
                        .disabled(!canOpen)
                        .accessibilityIdentifier("launch-terminal")
                        Text("Runs \(harness?.title ?? kind) straight over SSH in that folder. No Herdr needed. Terminal only: it ends when you leave, and it has no chat or approvals.")
                            .font(PhrenTypography.caption).foregroundStyle(PhrenTheme.textMuted)
                    }
                }
            }
            .buttonStyle(.plain)
            .disabled(launching)
            .navigationTitle("Open \(project)").navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Cancel") { dismiss() }
                        .disabled(launching)
                        .phrenIdentifier("launch-cancel")
                }
            }
            .phrenScreen()
            .modifier(SessionLaunchAlert(error: $error))
            .navigationDestination(item: $chatSession) { AgentChatSheet(session: $0) }
            .navigationDestination(item: $terminalRoute) { HerdrTerminalView(host: $0.host, route: $0.route) }
            .interactiveDismissDisabled(launching)
            .task {
                guard !prepared else { return }
                modelName = storedModel(kind)
                roleSelected(role)
                prepared = true
                await prepare()
            }
            .onChange(of: kind) { _, newKind in
                if role == .conductor,
                   let saved = ConductorLaunchSettings.load(storeID: storeID), saved.harness == newKind {
                    modelName = saved.model
                    effort = PhrenConnection.LaunchEffort(rawValue: saved.effort) ?? .medium
                } else {
                    modelName = storedModel(newKind)
                }
                rememberConductorChoice()
            }
            .onChange(of: modelName) { _, newValue in
                AppRuntime.defaults.set(newValue, forKey: "launch.model.\(kind)")
                rememberConductorChoice()
            }
            .onChange(of: effort) { _, _ in rememberConductorChoice() }
        }
        .phrenSingleSelectSheet(isPresented: $showComputers, title: "Computer", options: computerOptions,
                                selection: $hostID, rowPrefix: "launch-computer",
                                onSelect: { id in if let host = hosts.first(where: { $0.id == id }) { select(host) } })
        .phrenSingleSelectSheet(isPresented: $showStores, title: "Store", options: storeOptions,
                                selection: $storeID, rowPrefix: "launch-store", onSelect: { _ in storeSelected() })
        .phrenSingleSelectSheet(isPresented: $showProjects, title: "Project", options: projectOptions,
                                selection: $project, rowPrefix: "launch-project", onSelect: { _ in resetFolder() })
        .phrenSingleSelectSheet(isPresented: $showRoles, title: "Role", options: roleOptions,
                                selection: $role, rowPrefix: "launch-role", onSelect: roleSelected)
        .phrenSingleSelectSheet(isPresented: $showEfforts, title: "Effort", options: effortOptions,
                                selection: $effort, rowPrefix: "launch-effort")
        .phrenDialog(isPresented: $showRunningConductor, title: "Conductor already running",
                     message: "This store already has a conductor. Open its chat instead of starting another.",
                     actions: [
                        .init(id: "open", title: "Open the running conductor") {
                            if let runningConductor { chatSession = runningConductor }
                        },
                        .init(id: "cancel", title: "Keep this screen", role: .cancel) {}
                     ], identifier: "launch-conductor-running")
    }

    private func displayModel(_ value: String) -> String {
        value.split(separator: "-").map { $0.capitalized }.joined(separator: " ")
    }

    private func roleSelected(_ selected: PhrenConnection.LaunchRole) {
        guard selected == .conductor else { return }
        if let saved = ConductorLaunchSettings.load(storeID: storeID),
           let savedHarness = Harness(rawValue: saved.harness),
           let savedEffort = PhrenConnection.LaunchEffort(rawValue: saved.effort) {
            kind = savedHarness.rawValue
            modelName = saved.model
            effort = savedEffort
        }
        rememberConductorChoice()
    }

    private func rememberConductorChoice() {
        guard prepared, role == .conductor, let harness else { return }
        ConductorLaunchSettings.save(storeID: storeID, harness: harness,
                                     model: modelName.trimmingCharacters(in: .whitespacesAndNewlines),
                                     effort: effort)
    }

    private func storeSelected() {
        project = LiveSessionsModel.conductorProject(storeID: storeID, projects: model.sessionProjects, registry: registry)
        modelName = storedModel(kind)
        effort = .medium
        roleSelected(role)
        hostID = nil
        resetFolder()
        onStoreSelected?(storeID)
        Task { await prepare() }
    }

    private func resetFolder() {
        located = [:]
        folder = ""
        folderEdited = false
        if let host = selectedHost { select(host) }
    }

    private func existingConductor() -> LiveAgentSession? {
        for computer in SessionOverviewMonitor.shared.computers {
            for session in computer.monitor.snapshot?.sessions(on: computer.host) ?? [] where session.tab.isConductor {
                let match = preferences?.projectMatch(hostID: session.host.id, cwd: session.tab.cwd,
                                                       projects: model.sessionProjects)
                if match?.project.storeID == storeID { return session }
            }
        }
        return nil
    }

    private func offerRunningConductor(_ session: LiveAgentSession) {
        runningConductor = session
        showRunningConductor = true
    }

    /// Pre-select the first computer the store says has the project, and
    /// learn each computer's own name so `machines.yaml` can be matched.
    private func prepare() async {
        if hostID == nil, let known = hosts.first(where: { $0.id == conductorHostID })
            ?? hosts.first(where: { $0.id == preferredHostID }) ?? hosts.first(where: knowsProject) ?? hosts.first { select(known) }
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
        if conductorHostID == nil, preferredHostID == nil, !folderEdited, let current = selectedHost, !knowsProject(current), let known = hosts.first(where: knowsProject) { select(known) }
    }

    private func select(_ host: LiveHost) {
        hostID = host.id
        if !folderEdited { folder = suggestedFolder(host); folderEdited = false }
        Task { await locate(host) }
    }

    private struct TerminalDestination: Identifiable, Hashable {
        let host: LiveHost
        let route: TerminalRoute
        var id: String { "\(host.id):\(route.command)" }
        static func == (lhs: Self, rhs: Self) -> Bool { lhs.id == rhs.id }
        func hash(into hasher: inout Hasher) { hasher.combine(id) }
    }

    private func open() async {
        guard let host = selectedHost, let harness, canOpen else { return }
        if role == .conductor, let existing = existingConductor() {
            offerRunningConductor(existing)
            return
        }
        let cwd = folder.trimmingCharacters(in: .whitespacesAndNewlines)
        launching = true; error = nil
        defer { launching = false; status = nil }
        do {
            status = "Starting \(harness.title) in \(project)…"
            let chosen = supportsModel ? modelName.trimmingCharacters(in: .whitespacesAndNewlines) : ""
            rememberConductorChoice()
            let session = try await AgentLaunch.launch(host: host, cwd: cwd, label: project, kind: harness,
                                                       model: chosen.isEmpty ? nil : chosen, role: role,
                                                       effort: role == .conductor && supportsEffort ? effort : nil) { status = $0 }
            if role == .conductor {
                ConductorLaunchSettings.save(storeID: storeID, harness: harness, model: chosen,
                                             effort: effort, hostID: host.id, project: project)
            }
            ProjectAgentRecents.record(storeID: storeID, project: project, hostID: host.id)
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
                        try await model.enqueue(TaskMove.active.operation(for: request.row), in: request.row.storeId)
                        await model.refresh()
                        onTaskMoved?(request.row, .active)
                    } catch {
                        model.lastActionError = "The agent is working, but the task couldn't move to Active. \(error.localizedDescription)"
                    }
                }
            }
            chatSession = session
        } catch LiveConnectionError.launchConflict(_, let target) where role == .conductor {
            if let target, var targetHost = selectedHost {
                if let server = target.server {
                    targetHost.herdrSession = server == "default" ? nil : server
                }
                let session = try? AgentLaunch.session(host: targetHost, workspaceID: target.workspaceID,
                    tabID: target.tabID, label: project, agent: target.source ?? harness.rawValue,
                    agentStatus: "working", cwd: cwd, role: .conductor)
                if let session { offerRunningConductor(session); return }
            }
            if let snapshot = try? await LiveHostMonitor.fetch(host),
               let session = snapshot.sessions(on: host).first(where: { $0.tab.isConductor }) {
                offerRunningConductor(session)
            } else if let session = existingConductor() {
                offerRunningConductor(session)
            } else {
                self.error = "A conductor is already running for this store. Refresh Agents and open it there."
            }
        } catch LiveConnectionError.gatewayRejection(status: 409, reason: _) where role == .conductor {
            if let snapshot = try? await LiveHostMonitor.fetch(host),
               let session = snapshot.sessions(on: host).first(where: { $0.tab.isConductor }) {
                offerRunningConductor(session)
            } else if let session = existingConductor() {
                offerRunningConductor(session)
            } else {
                self.error = "A conductor is already running for this store. Refresh Agents and open it there."
            }
        } catch {
            self.error = error.localizedDescription
        }
    }

}

struct SessionLaunchAlert: ViewModifier {
    @Binding var error: String?
    func body(content: Content) -> some View {
        content.phrenDialog(isPresented: $error.isPresent(), title: "Couldn't open session",
                            message: error ?? "",
                            actions: [.init(id: "ok", title: "OK", role: .cancel) { error = nil }],
                            identifier: "launch-error")
    }
}
