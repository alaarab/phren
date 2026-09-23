import PhrenKit
import PhrenLive
import SwiftUI

struct LiveSessionsView: View {
    @Environment(AppModel.self) private var model
    @Environment(\.scenePhase) private var scenePhase
    @Environment(\.liveSessionPreferences) private var livePreferences
    @State private var sessions = LiveSessionsModel()
    private var overview: SessionOverviewMonitor { sessions.overview }
    @State private var selected: OverviewSelection?
    @State private var sessionOpen: SessionOpen?
    @State private var scheduleOpen: ScheduleHistoryOpen?
    @State private var closeRequest: SessionCloseRequest?
    @State private var closeError: String?
    @State private var schedulesStoreID: String?
    @State private var setupDestination: LiveSessionsModel.SetupAction?
    @State private var showingConductorLaunch = false
    @State private var conductorStoreID: String?
    private var conductorStore: StoreDescriptor? {
        model.storeDescriptors.first(where: { $0.id == conductorStoreID })
            ?? model.storeDescriptors.first(where: { $0.id == model.storeFilter })
            ?? model.storeDescriptors.first
    }
    private struct SessionOpen: Identifiable, Hashable {
        let session: LiveAgentSession
        let destination: AgentLaunch.Destination
        var draft = ""
        var attachments: [AgentAttachment] = []
        var id: String { "\(session.id.hostID)|\(session.id.muxID)|\(session.id.workspace)|\(session.id.tab)|\(destination.rawValue)" }
        static func == (lhs: Self, rhs: Self) -> Bool { lhs.id == rhs.id && lhs.draft == rhs.draft && lhs.attachments.count == rhs.attachments.count }
        func hash(into hasher: inout Hasher) { hasher.combine(id) }
    }
    private struct ScheduleHistoryOpen: Identifiable, Hashable {
        let storeID: String
        let project: String
        let schedule: Schedule
        var id: String { storeID + "/" + project + "/" + schedule.id }
        static func == (lhs: Self, rhs: Self) -> Bool { lhs.id == rhs.id }
        func hash(into hasher: inout Hasher) { hasher.combine(id) }
    }
    private var preferences: LiveSessionPreferences? { livePreferences.preferences }
    private var hosts: [LiveHost] { preferences?.hosts ?? [] }

    private struct OverviewSelection: Identifiable, Hashable {
        let session: LiveAgentSession
        let monitor: LiveHostMonitor
        var id: LiveAgentSession.ID { session.id }
        static func == (lhs: Self, rhs: Self) -> Bool { lhs.id == rhs.id && lhs.monitor === rhs.monitor }
        func hash(into hasher: inout Hasher) { hasher.combine(id) }
    }
    private struct PollID: Equatable { let hosts: [LiveHost]; let active: Bool; let refresh: UUID }
    /// The store metadata the model needs, as one value so an unchanged input
    /// never reconfigures the shared monitor.
    private struct ModelInputs: Equatable {
        let preferences: LiveSessionPreferences?
        let projects: [SessionProject]
        let metadataReady: Bool
        let memoryConnected: Bool
    }
    private var modelInputs: ModelInputs {
        ModelInputs(preferences: preferences, projects: model.sessionProjects,
                    metadataReady: model.phase != .loading && model.phase != .initialSync,
                    memoryConnected: model.phase == .ready)
    }

    var body: some View {
        let screen = overview.screen
        Group {
            if !hosts.isEmpty && !overview.ready {
                ProgressView().tint(PhrenTheme.cyan)
                    .frame(maxWidth: .infinity, maxHeight: .infinity)
                    .background(PhrenTheme.bg).accessibilityLabel("Loading sessions")
                    .accessibilityIdentifier("agents-loading")
                    .transition(.opacity)
            } else {
            ScrollView {
                LazyVStack(alignment: .leading, spacing: PhrenTheme.Space.medium) {
                    if let store = conductorStore {
                        conductorEntry(store: store, screen: screen)
                    }
                    sessionSections(screen)
                    PhrenGroup("Computers", identifier: "sessions-computers") {
                        if screen.preferencesReadable {
                            ForEach(screen.computers) { computer in
                                HStack(spacing: 0) {
                                    // Keep this row and its identity as the computer hold-action hook.
                                    NavigationLink { LiveHostView(hostID: computer.id) } label: {
                                        PhrenMenuRow(title: computer.host.name,
                                                     subtitle: computer.connecting ? "Connecting…" : computer.host.address,
                                                     icon: "desktopcomputer",
                                                     titleColor: PhrenTheme.hostColor(computer.host.color ?? LiveHost.defaultColor(for: computer.host.id)))
                                            .overlay(alignment: .trailing) { connectionStatus(computer).padding(.trailing, 4) }
                                    }
                                    .buttonStyle(.plain)
                                    .accessibilityIdentifier("live-host:\(computer.id)")
                                    // The terminal needs only SSH, not the Hook: when the
                                    // Hook is down this is still the way onto the machine.
                                    if computer.message != nil, !computer.needsVerification {
                                        NavigationLink { HerdrTerminalView(host: computer.host, route: .herdr(server: "default")) } label: {
                                            Image(systemName: "terminal").font(.system(size: 15, weight: .semibold))
                                                .frame(width: 44, height: 44).contentShape(Rectangle())
                                        }
                                        .buttonStyle(.plain).foregroundStyle(PhrenTheme.cyan)
                                        .accessibilityLabel("Open \(computer.host.name)'s terminal")
                                        .accessibilityIdentifier("overview-terminal:\(computer.id)")
                                    }
                                }
                                .padding(.horizontal, 12)
                                .background(PhrenTheme.surface, in: RoundedRectangle(cornerRadius: PhrenTheme.Radius.questionOption))
                            }
                            Button { sessions.adding = true } label: {
                                PhrenMenuRow(title: "Add computer", icon: "plus")
                                    .padding(.horizontal, 12)
                                    .background(PhrenTheme.surface, in: RoundedRectangle(cornerRadius: PhrenTheme.Radius.questionOption))
                            }
                            .buttonStyle(.plain).accessibilityIdentifier("sessions-add-computer")
                        } else {
                            Text("Saved connections couldn't be read. They have been preserved; update phren before editing them.")
                                .foregroundStyle(PhrenTheme.warning)
                        }
                    }
                }
                .padding(PhrenTheme.Space.large)
            }
            .accessibilityIdentifier("sessions-scroll")
            .modifier(SessionCloseDialogs(request: $closeRequest, error: $closeError,
                                          monitor: { session in sessions.monitor(for: session.host.id) }))
                .transition(.opacity)
            }
        }
        .animation(.easeOut(duration: 0.2), value: overview.ready)
        .onChange(of: modelInputs, initial: true) { _, value in
            sessions.update(preferences: value.preferences, projects: value.projects,
                            metadataReady: value.metadataReady, memoryConnected: value.memoryConnected)
        }
        .navigationTitle("Live sessions")
        // Keep the title in the navigation bar rather than the collapsible
        // large-title region when this list is hosted directly by a tab.
        .navigationBarTitleDisplayMode(.inline)
        .phrenScreen()
        .toolbar {
            if sessions.setupActions.contains(.connectMemory) {
                Button("Connect memory", systemImage: "brain") { model.showingMemoryConnection = true }
                    .accessibilityIdentifier("sessions-connect-memory")
            }
            // Schedules is the one thing up here worth a button; refresh is a
            // pull, and computers, skills and instructions live in Settings.
            if SessionOverviewMonitor.shared.allowsSchedules(),
               let storeID = model.storeDescriptors.first(where: { model.storeFilter == nil || $0.id == model.storeFilter })?.id {
                Button("Schedules", systemImage: "clock.badge.checkmark") { schedulesStoreID = storeID }
                    .accessibilityIdentifier("sessions-schedules")
            }
            AccountUsageRings(hosts: hosts)
            // Settings → Show on Agents chooses these.
            if IntegrationSettings.enabled(IntegrationSettings.showWebServersKey) {
                NavigationLink { WebServersView() } label: { Label("Web servers", systemImage: "globe") }
                    .accessibilityIdentifier("all-web-servers")
            }
            if IntegrationSettings.enabled(IntegrationSettings.showSimulatorsKey) {
                NavigationLink { SimulatorsView() } label: { Label("Simulators", systemImage: "iphone") }
                    .accessibilityIdentifier("all-simulators")
            }
            if IntegrationSettings.enabled(IntegrationSettings.showFilesKey) {
                NavigationLink { HostFilesView() } label: { Label("Files", systemImage: "folder") }
                    .accessibilityIdentifier("all-files")
            }
        }
        .onAppear { if IntegrationSettings.enabled(IntegrationSettings.agentsKeepScreenOnKey, default: false) { UIApplication.shared.isIdleTimerDisabled = true } }
        .onDisappear { UIApplication.shared.isIdleTimerDisabled = false }
        .task(id: scenePhase) {
            if scenePhase == .active { sessions.setFocusFilter(await AgentFocusFilterStore.refreshFromSystem()) }
        }
        .onReceive(NotificationCenter.default.publisher(for: AgentFocusFilterStore.changed)) { _ in
            sessions.setFocusFilter(AgentFocusFilterStore.load())
        }
        .refreshable { sessions.refresh() }
        .navigationDestination(item: $schedulesStoreID) { storeID in
            SchedulesView(storeId: storeID, project: nil)
        }
        .navigationDestination(item: $setupDestination) { destination in
            switch destination {
            case .skills: SkillsView()
            case .instructions: AgentsView()
            case .connectMemory: EmptyView()
            }
        }
        .sheet(isPresented: $sessions.adding) { NavigationStack { LiveHostEditor() } }
        .sheet(isPresented: $showingConductorLaunch) {
            if let store = conductorStore {
                LaunchSessionView(storeID: store.id,
                                  project: LiveSessionsModel.conductorProject(storeID: store.id, projects: model.sessionProjects,
                                                                              registry: model.machineRegistry(storeId: store.id)),
                                  initialRole: .conductor, allowsStoreSelection: true,
                                  onStoreSelected: { conductorStoreID = $0 })
            }
        }
        .navigationDestination(item: $selected) { selection in
            LiveSessionDetailView(sessionID: selection.id, monitor: selection.monitor)
        }
        .navigationDestination(item: $sessionOpen) { open in
            switch open.destination {
            case .chat, .dictate:
                AgentChatSheet(session: open.session, attachments: open.attachments, draft: open.draft,
                               startsDictation: open.destination == .dictate).id(open.id)
            case .terminal: HerdrTerminalView(host: open.session.host, session: open.session).id(open.id)
            }
        }
        .modifier(ScheduleOpenRouting(scheduleOpen: $scheduleOpen, openPending: openPendingSchedule))
        // Siri and Spotlight leave an exact session and destination here.
        .onChange(of: model.pendingChatVersion, initial: true) { _, _ in
            if let pending = AgentLaunch.takePendingOpen() {
                selected = nil
                let content = AgentLaunch.takePendingContent(for: pending.session)
                sessionOpen = SessionOpen(session: pending.session, destination: pending.destination,
                                          draft: content.draft, attachments: content.attachments)
            }
        }
        // The poll is a task this view owns, not a `.task` modifier: SwiftUI
        // cancels those when a pushed screen covers the list, which froze the
        // sessions behind an open chat. It runs while the app is active and
        // this list has appeared at least once; only leaving the foreground,
        // changing computers, or editing them restarts it.
        .onChange(of: PollID(hosts: hosts, active: scenePhase == .active && !sessions.adding, refresh: sessions.refreshID), initial: true) { _, id in
            sessions.syncPolling(hosts: hosts, active: id.active)
        }
        // Once the sessions are known, Siri can name them ("message phren on mini in phren").
        .onChange(of: overview.ready, initial: true) { _, ready in
            guard ready else { return }
            let revealed = overview.computers.flatMap { computer in computer.monitor.snapshot?.sessions(on: computer.host) ?? [] }
            PhrenAppShortcuts.donateSessions(revealed)
            SessionPullRequestCache.shared.refreshOnReveal(revealed)
        }
        .onChange(of: sessions.hookAssociations, initial: true) { _, associations in
            for association in associations where preferences?.hosts.first(where: { $0.id == association.hostID })?.hookComputerID != association.computerID {
                do {
                    try livePreferences.update {
                        try LiveSessionPreferences.associating(hostID: association.hostID,
                                                               hookComputerID: association.computerID, in: $0)
                    }
                } catch { /* Keep the verified connection unchanged when an identity conflicts. */ }
            }
        }
    }

    @ViewBuilder
    private func conductorEntry(store: StoreDescriptor, screen: SessionOverviewMonitor.Screen) -> some View {
        VStack(alignment: .leading, spacing: 0) {
            if let conductor = sessions.conductor(in: store.id) {
                sessionCard(conductor, screen: screen)
            } else {
                Button { showingConductorLaunch = true } label: {
                    ConductorStartRow(storeName: model.storeDescriptors.count > 1 ? store.id : nil)
                }
                .buttonStyle(.plain)
                .phrenIdentifier("sessions-start-conductor")
            }
        }
        .accessibilityElement(children: .contain)
        .phrenIdentifier("sessions-conductor-slot")
    }

    private func sessionCard(_ session: LiveAgentSession, screen: SessionOverviewMonitor.Screen) -> some View {
        let monitor = sessions.monitor(for: session.host.id)
        return LiveSessionCard(session: session, fresh: monitor?.isLive(at: .now) == true,
                               stale: monitor?.isStale(at: .now) == true,
                               showHost: true,
                               resolvedProject: screen.projects[session.id] ?? preferences?.projectMatch(hostID: session.host.id, cwd: session.tab.cwd,
                                                                                                       projects: model.sessionProjects)?.project.name,
                               resolvedPin: preferences?.isPinned(session.id) == true,
                               onChat: { sessionOpen = SessionOpen(session: session, destination: .chat) }, onDetails: {
            if let monitor { selected = OverviewSelection(session: session, monitor: monitor) }
        }, onClose: { request, confirm in
            if confirm { closeRequest = request }
            else { SessionCloseDialogs.perform(request, monitor: sessions.monitor(for: request.session.host.id)) { closeError = $0 } }
        })
        .equatable()
    }

    /// A schedule notification lands here; the run's history opens once the
    /// store snapshot that holds the schedule is in.
    private struct ScheduleOpenRouting: ViewModifier {
        @Binding var scheduleOpen: ScheduleHistoryOpen?
        let openPending: () -> Void
        @Environment(AppModel.self) private var model

        func body(content: Content) -> some View {
            content
                .navigationDestination(item: $scheduleOpen) { open in
                    ScheduleHistoryView(storeId: open.storeID, project: open.project, schedule: open.schedule)
                }
                .onChange(of: model.pendingScheduleVersion, initial: true) { _, _ in openPending() }
                .onChange(of: model.searchRevision) { _, _ in openPending() }
        }
    }

    private func openPendingSchedule() {
        guard let pending = model.pendingSchedule else { return }
        for store in model.storeDescriptors {
            if let schedule = model.snapshot(for: store.id).schedules[pending.project]?.first(where: { $0.id == pending.scheduleID }) {
                selected = nil; sessionOpen = nil
                scheduleOpen = .init(storeID: store.id, project: pending.project, schedule: schedule)
                model.clearPendingSchedule()
                return
            }
        }
    }

    /// Only what needs saying above the sessions: the hint when there is no
    /// computer yet, a Focus filter when one is on. The connected count lives
    /// in the Computers section; the sections say the rest.
    @ViewBuilder
    private func caption(_ screen: SessionOverviewMonitor.Screen) -> some View {
        VStack(alignment: .leading, spacing: 5) {
            if screen.computers.isEmpty {
                Text("Connect a computer to see its sessions here.")
                    .accessibilityIdentifier("agents-introduction")
            }
            if let focusFilter = screen.focusFilter {
                HStack(spacing: 5) {
                    Text("Filtered by Focus · \(focusFilter.label)").accessibilityIdentifier("agents-focus-filter")
                    Button("Clear Focus filter", systemImage: "xmark.circle.fill") {
                        AgentFocusFilterStore.save(nil); sessions.setFocusFilter(nil)
                    }.labelStyle(.iconOnly).accessibilityIdentifier("agents-focus-clear")
                }
            }
        }.font(.caption).foregroundStyle(PhrenTheme.textMuted).textCase(nil)
    }

    @ViewBuilder
    private func sessionSections(_ screen: SessionOverviewMonitor.Screen) -> some View {
        if screen.computers.isEmpty || screen.focusFilter != nil { caption(screen) }
        if screen.groups.isEmpty && !screen.computers.isEmpty {
            if screen.computers.contains(where: \.connecting) {
                HStack { ProgressView(); Text("Finding sessions…") }.font(.subheadline)
            } else {
                Text(screen.connectedCount == 0 && screen.computers.contains(where: { $0.message != nil })
                     ? "No computers connected" : "No sessions running on the connected computers")
                    .font(.subheadline).foregroundStyle(PhrenTheme.textMuted)
                    .accessibilityIdentifier("sessions-empty")
            }
        }
        let conductorID = conductorStore.flatMap { sessions.conductor(in: $0.id)?.id }
        ForEach(screen.groups) { group in
            let remaining = group.sessions.filter { $0.id != conductorID }
            if !remaining.isEmpty {
                PhrenGroup("\(group.title) · \(remaining.count)") {
                    ForEach(remaining) { session in
                        sessionCard(session, screen: screen)
                    }
                    if group.id == "previous" {
                        Text("phren can't reach these computers right now. Their terminal still opens from their row under Computers.")
                            .font(.caption).foregroundStyle(PhrenTheme.textMuted)
                    }
                }
            }
        }
    }
}

extension LiveSessionsView {
    /// A computer's connection trouble, on its own row: a colored dot and a
    /// word, only when something is wrong.
    @ViewBuilder func connectionStatus(_ computer: SessionOverviewMonitor.ComputerRow) -> some View {
        if computer.message != nil || computer.slow == true {
            let label = computer.needsVerification ? "Verify" : computer.message != nil ? "Offline" : "Slow"
            HStack(spacing: 5) {
                Circle().fill(computer.message != nil ? PhrenTheme.warning : PhrenTheme.textMuted).frame(width: 7, height: 7)
                Text(label).font(PhrenTypography.caption).foregroundStyle(PhrenTheme.warning)
            }
            .accessibilityElement(children: .combine)
            .accessibilityLabel("\(computer.host.name) \(label.lowercased())")
            .accessibilityIdentifier("computer-status:\(computer.id)")
        }
    }
}
