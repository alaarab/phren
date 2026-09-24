import PhrenKit
import PhrenLive
import SwiftUI
import UIKit

struct AgentChatView: View {
    /// The terminal's Chat control pops back to the nearest chat beneath it.
    static let screenTag = "agent-chat"
    let session: LiveAgentSession
    let switchSession: (LiveAgentSession) -> Void
    let initialPane: AgentChatPanes.Pane?
    let initialTarget: AgentChatTarget?
    @Binding var incomingAttachments: [AgentAttachment]
    @Binding var incomingDraft: String
    /// Kept by the sheet so selecting a child under another tab survives the
    /// parent chat being replaced with that tab's conversation.
    @Binding var requestedChild: AgentChildRequest?
    /// Opened by the Action button: start listening as soon as the chat is up.
    var startsDictation = false
    /// Opened by "talk to my conductor": start talk mode as soon as the chat is up.
    var startsTalk = false
    @State private var indexedCode: SessionCodeContext?
    @State private var initialized = false
    @State private var messageMenu = ChatMessageMenu()
    @Environment(AppModel.self) private var appModel
    @Environment(\.scenePhase) private var scenePhase
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @Environment(\.accessibilityVoiceOverEnabled) private var voiceOver
    @Environment(\.liveSessionPreferences) private var preferencesStore
    /// From `AgentChatModels`: a conversation opened again keeps its rows.
    @State var model: AgentChatModel
    @State private var sendTask: Task<Void, Never>?
    @State private var visible = false
    @State private var refresh = UUID()
    @State private var showingContext = false
    @State private var commandDestination: CommandDestination?
    @State private var showingAttachmentMenu = false
    @State private var attachmentSource: ChatAttachmentSource?
    @State private var attachmentTarget: AgentChatTarget?
    @State private var attachmentError: String?
    @State private var dictation = ChatDictationController()
    private var dictating: Bool { dictation.isRecording }
    @State private var talk = TalkModeController()
    @State private var showingAgentSwitcher = false
    @State private var launchingNewThread = false
    @State private var launchingWorktree: WorktreeLaunchRequest?
    @State private var showingUsage = false
    @State private var showingOptions = false
    @State private var showingModelPicker = false
    @State private var showingSecret = false
    @State private var menuCommand: ChatMenuCommand?
    @State private var showingChildAgents = false
    @State private var childAgents: [AgentChild] = []
    /// Why the sub-agent tree could not be read, or why remote children are missing from it.
    @State private var childAgentsError: String?
    @State private var openedChild: AgentWorkNavigation?
    @State private var previewImage: ChatAttachmentDraft?
    @State private var assigningProject = false
    @State private var showingChanges = false
    @State private var fullDiff: ChatFullDiff?
    /// A localhost link the agent printed, open in the web preview on its computer.
    @State private var localSite: WebServerSelection?
    @State private var turnChanges: ChatTurnChanges?
    @State private var fullToolOutput: FullToolOutput?
    /// A send grows the transcript, resigns the composer and resizes the
    /// viewport in one frame. The pin that follows waits for layout and then
    /// for the keyboard animation; no other pin runs inside that transition.
    @State private var sendScrollToken = 0
    @State private var suppressComposingPin = false
    /// The project this pane's folder belongs to. Kept here and set by
    /// `ChatModelObservers` when it changes, so the screen does not observe
    /// the pane list the model refreshes every few seconds.
    @State private var project: SessionProject?
    @State private var fellBackToTerminal = false
    @State private var composing = false
    /// The one paragraph showing native text selection, if any.
    @State private var textSelection = ChatTextSelection()

    private func startDictation() {
        dictation.start(model: model, host: session.host) { scenePhase == .active }
    }
    private func stopDictation() {
        dictation.stop(model: model) { sendDictationIfRequested() }
    }

    private func toggleTalk() {
        if talk.isOn { talk.stop(); return }
        if dictating { stopDictation() }
        talk.start(TalkModeController.chat(model: model, session: session))
    }

    private func sendDictationIfRequested() {
        if ChatSettings.autoSendsDictation,
           !model.draft.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
            sendDraft(handoffCommands: false)
        }
    }

    private func acceptIncomingAttachments() {
        guard !incomingAttachments.isEmpty || !incomingDraft.isEmpty,
              !model.restoringDraft, let target = model.target else { return }
        if let initialPane {
            guard let expected = try? initialPane.target(hostID: session.host.id, workspaceID: session.workspaceID,
                                                         tabID: session.tab.id, muxID: session.host.muxID),
                  target == expected else { return }
        }
        guard model.attachments.count + incomingAttachments.count <= ChatAttachmentLimit.maximum else {
            model.deliveryError = "Make room for \(incomingAttachments.count) attachment(s). Each message can include four."
            return
        }
        let items = incomingAttachments
        incomingAttachments = []
        for item in items { model.add(item) }
        let text = incomingDraft.trimmingCharacters(in: .whitespacesAndNewlines)
        incomingDraft = ""
        if !text.isEmpty {
            model.draft += (model.draft.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty ? "" : "\n\n") + text
        }
    }

    /// Pasted images join the draft as attachments, the same as the + picker's.
    private func pasteImages(_ providers: [NSItemProvider]) {
        guard let openingTarget = model.target else { return }
        Task { @MainActor in
            for provider in providers {
                guard model.target == openingTarget else { return }
                do {
                    let attachment = try await ChatAttachmentPreparation.pasted(provider)
                    guard model.target == openingTarget else { return }
                    model.add(attachment)
                } catch { model.deliveryError = error.localizedDescription }
            }
        }
    }

    private var currentHost: LiveHost? {
        preferencesStore.preferences?.hosts.first { $0.id == session.host.id }
    }
    /// The project for the chosen pane's folder. Read by `ChatModelObservers`,
    /// which stores it in `project` when it changes.
    private var currentProject: SessionProject? {
        let pane = model.panes.first { $0.id == model.target?.paneID }
        let cwd = pane?.cwd ?? (model.panes.count == 1 ? session.tab.cwd : nil)
        return preferencesStore.preferences?.projectMatch(hostID: session.host.id, cwd: cwd, projects: appModel.sessionProjects)?.project
    }
    private var hostMatches: Bool { currentHost?.hasSameConnection(as: session.host) == true }
    private var codeOrigin: SessionCodeContext? {
        guard let project, let target = model.target, !target.isStarting else { return nil }
        return SessionCodeContext(storeID: project.storeID, project: project.name, host: session.host, target: target)
    }
    /// Talk mode keeps the conversation read while locked, so its replies arrive.
    private var active: Bool {
        visible && (scenePhase == .active || TalkBackground.continues(talk.isOn))
            && currentHost?.hasSameConnection(as: session.host) == true
    }
    private var transcriptActions: ChatTranscriptActions {
        ChatTranscriptActions(
            reconnect: { refresh = UUID() },
            choosePane: { pane in model.choose(pane, session: session); refresh = UUID() },
            openTerminal: { pane in commandDestination = .init(paneID: pane.id, menu: false) },
            preview: { previewImage = $0 },
            isAgent: isAgent)
    }
    private func isAgent(_ pane: AgentChatPanes.Pane) -> Bool {
        (try? pane.target(hostID: session.host.id, workspaceID: session.workspaceID, tabID: session.tab.id, muxID: session.host.muxID)) != nil
    }
    private var hasAgentPanes: Bool { model.panes.contains(where: isAgent) }

    var body: some View { ChatPerformance.measure("chat container") {
        chatSheets(content.phrenAnchoredMenuHost()).modifier(ChatMessageMenuPresenter(menu: messageMenu)).performanceCountersProbe()
    } }
    private var content: some View {
        VStack(spacing: 0) {
            AgentChatHeader(session: session, model: model, project: project, active: active) { showingOptions = true }
            // Rows scrolling up dissolve into the canvas under the header's
            // solid band instead of stopping at a hard edge beside the title.
            ChatTranscriptPane(session: session, model: model, active: active, hostMatches: hostMatches, project: project,
                               textSelection: textSelection, composing: $composing,
                               suppressComposingPin: $suppressComposingPin, sendScrollToken: sendScrollToken,
                               childAgents: childAgents, actions: transcriptActions)
                .overlay(alignment: .top) { ChatHeaderFade() }
            ChatPendingInteraction(model: model, session: session, active: active, run: runAgentRequest)
            ChatBackgroundJobsSlot(timeline: model.timelineState)
            ChatPendingQueue(model: model, session: session, active: active, run: runAgentRequest) { composing = true }
            if let preview = dictation.preview {
                DictationCleanupPreviewCard(
                    preview: preview,
                    useTightened: { dictation.resolvePreview(useTightened: true, model: model) { sendDictationIfRequested() } },
                    keepOriginal: { dictation.resolvePreview(useTightened: false, model: model) { sendDictationIfRequested() } }
                )
                .padding(.horizontal, 12).padding(.top, 6)
            }
            if talk.isOn || talk.failure != nil {
                TalkStatusBar(talk: talk).padding(.horizontal, 12).padding(.top, 6)
            }
            ChatSideAnswerSlot(model: model, session: session)
            ChatHistoryStalledSlot(model: model, projectKnown: project != nil) { launchingNewThread = true }
            composerBar
                .dynamicTypeSize(...DynamicTypeSize.accessibility1)
        }
        .background(PhrenTheme.chatCanvas)
        .confirmsWebLinks()
        .environment(\.openChatDiff) { fullDiff = $0 }
        .environment(\.openTurnChanges) { turnChanges = $0 }
        .environment(\.resolvePendingEcho) { id, retry in model.resolvePendingEcho(id, retry: retry) }
        .environment(\.openLocalWebServer) { url in
            guard let server = WebServer.loopback(url) else { return false }
            let path = URLComponents(url: url, resolvingAgainstBaseURL: false).map { parts in
                parts.percentEncodedPath + (parts.percentEncodedQuery.map { "?" + $0 } ?? "")
            }
            localSite = WebServerSelection(hostID: session.host.id, server: server, path: path?.isEmpty == false ? path : nil)
            return true
        }
        .fullScreenCover(item: $localSite) { selection in
            NavigationStack { WebPreviewView(selection: selection) }
        }
        .environment(\.openToolOutput) { fullToolOutput = $0 }
        .environment(model.turnControl)
        .environment(textSelection)
        .chatAttachmentSources(source: $attachmentSource, canAdd: model.attachments.count < ChatAttachmentLimit.maximum,
                               add: { item in if model.target == attachmentTarget { model.add(item) } },
                               error: $attachmentError)
        // Opening the menu leaves the keyboard and the composer alone:
        // resigning here slid the whole transcript down under the card.
        .onChange(of: messageMenu.request?.id) { _, id in
            if id != nil { textSelection.end() }
        }
        #if DEBUG && targetEnvironment(simulator)
        .overlay(alignment: .topLeading) { if AgentChatFixture.enabled { ChatFixtureReport() } }
        .onChange(of: model.draft) { _, draft in
            // Dictation's insert: typing the marker replaces the draft from
            // outside the editor, as a dictated segment does.
            guard AgentChatFixture.enabled, ProcessInfo.processInfo.arguments.contains("--chat-composer-inserts"),
                  draft.hasSuffix("#dictate") else { return }
            model.draft = DictationSession.join(String(draft.dropLast("#dictate".count)), "Dictated line one\nDictated line two")
        }
        #endif
        .overlay {
            // The ZStack stays put so the backdrop and the panel can animate
            // in and out on their own: the scrim fades, the drawer slides.
            ZStack(alignment: .leading) {
                if showingAgentSwitcher {
                    Color.black.opacity(0.34).ignoresSafeArea()
                        .transition(.opacity)
                        .onTapGesture { closeAgentDrawer() }
                    AgentDrawer(current: session, panes: model.panes, selectedPaneID: model.target?.paneID,
                                choosePane: { pane in model.choose(pane, session: session); refresh = UUID() },
                                children: childAgents, openChild: openChildFromDrawer,
                                openSessionChild: openSessionChildFromDrawer,
                                chooseSession: switchSession, close: closeAgentDrawer)
                        .transition(.move(edge: .leading))
                }
            }.zIndex(20)
        }
        .modifier(ChatDismissGuard(model: model))
        .toolbar(.hidden, for: .navigationBar)
        // Pushed inside a tab, the chat is a full-height screen: the tab bar
        // would otherwise sit under the composer.
        .toolbar(.hidden, for: .tabBar)
        .keepsInteractivePop(hidesNavigationBar: true, screenTag: Self.screenTag)
        .navigationDestination(item: $openedChild) { AgentWorkDestinationView(navigation: $0) }
        .navigationDestination(item: $fullDiff) { FileDiffView(file: $0.file, section: $0.section) }
        .navigationDestination(item: $turnChanges) { ChatTurnDiffView(changes: $0) }
        .environment(\.fileLinkContext, model.target.map { FileLinkContext(host: session.host, target: $0) })
        .navigationDestination(item: $fullToolOutput) { FullToolOutputView(output: $0) }
        .navigationDestination(isPresented: $showingChanges) {
            if let target = model.target {
                // Besides the pane's tree: whatever the session's commands
                // wrote elsewhere — the phren store, a sibling checkout.
                AgentChangesView(session: session, target: target, codeOrigin: codeOrigin)
            }
        }
        .onAppear {
            ChatJourney.appeared(); ChatJourney.beginIfIdle()
            if !initialized {
                initialized = true
                if let initialTarget, model.target != initialTarget { model.choose(initialTarget, session: session) }
                else if let initialPane, model.target == nil || model.target != (try? initialPane.target(hostID: session.host.id, workspaceID: session.workspaceID, tabID: session.tab.id, muxID: session.host.muxID)) {
                    model.choose(initialPane, session: session)
                }
                if startsDictation {
                    // Let the push finish first; the microphone prompt and the
                    // keyboard both fight a screen that is still sliding in.
                    Task { try? await Task.sleep(for: .milliseconds(450)); if !dictating { startDictation() } }
                } else if startsTalk {
                    Task { try? await Task.sleep(for: .milliseconds(450)); if !talk.isOn { toggleTalk() } }
                }
            }
            visible = true
        }
        // UIKit restores the stack's bar as the scene activates, after the
        // bridge's own became-active pass; ask for one more hide a turn later.
        .onChange(of: scenePhase) { _, phase in
            guard phase == .active else { return }
            DispatchQueue.main.async {
                NotificationCenter.default.post(name: .phrenReassertNavigationBarHidden, object: nil)
            }
        }
        // Every model-driven side effect lives in this invisible view, so the
        // screen itself observes almost nothing the model changes.
        .background {
            ChatModelObservers(model: model, session: session, active: active, currentProject: { currentProject },
                               project: $project, composing: $composing,
                               acceptIncoming: acceptIncomingAttachments,
                               loaded: fallBackToTerminalIfShellOnly(loaded:),
                               refreshChildAgents: refreshChildAgents,
                               stop: { sendTask = Task { await model.stop(session) } })
        }
        .onChange(of: requestedChild, initial: true) { _, _ in openRequestedChildIfReady() }
        .onDisappear { visible = false; ChatJourney.cancel(); sendTask?.cancel(); dictation.cancelCleanupTask(); model.flushDrafts() }
        // Settings → Notifications → Keep screen on holds in a chat too.
        .keepsScreenAwake()
        .onChange(of: scenePhase) { _, phase in if phase != .active { sendTask?.cancel(); model.flushDrafts() } }
        .onChange(of: currentHost) { _, _ in sendTask?.cancel() }
        .onChange(of: reduceMotion || voiceOver, initial: true) { _, instant in
            model.animateReplies = !instant
            if instant { model.reveal.finish() }
        }
        .navigationDestination(item: $commandDestination) { destination in
            HerdrTerminalView(host: session.host, session: session, target: destination.menu ? model.target : nil,
                              paneID: destination.paneID, commandMenu: destination.menu)
        }
        .onChange(of: commandDestination) { previous, current in
            if previous != nil && current == nil {
                // Commands chosen in the live menu can replace the session too.
                model.chooseAnother(); refresh = UUID()
            }
        }
    }

    /// Every sheet this screen can present. UIKit restores the stack's bar
    /// when one goes away; dismissing any of them must re-hide it.
    private var anySheetPresented: Bool {
        showingOptions || launchingNewThread || launchingWorktree != nil || menuCommand != nil
            || showingModelPicker || showingUsage || showingSecret || showingChildAgents
            || previewImage != nil || showingContext || assigningProject
    }

    /// The second half of the chat chrome: dictation, sheets and lifecycle
    /// tasks. Split from `content` so the type checker finishes.
    private func chatSheets<V: View>(_ content: V) -> some View {
        content
        .onChange(of: anySheetPresented) { _, presented in
            guard !presented else { return }
            DispatchQueue.main.async {
                NotificationCenter.default.post(name: .phrenReassertNavigationBarHidden, object: nil)
            }
        }
        // Talk mode keeps going with the screen locked or phren in the
        // background (the audio background mode keeps the microphone and the
        // voice alive); dictation into the composer does not.
        .onChange(of: scenePhase) { _, phase in if phase != .active { stopDictation(); if !TalkBackground.continues(talk.isOn) { talk.stop() } } }
        .onDisappear { dictation.tearDown(); talk.stop() }
        .sheet(isPresented: $showingOptions) {
            ChatOptionsSheet(session: session, model: model, project: project, indexedCode: indexedCode,
                             fallbackStoreID: appModel.storeDescriptors.first?.id,
                             isPresented: $showingOptions, perform: performOption)
        }
        .task(id: codeOrigin?.id) {
            indexedCode = nil
            guard let origin = codeOrigin, await origin.hasIndex(), !Task.isCancelled else { return }
            indexedCode = origin
        }
        .sheet(isPresented: $launchingNewThread) {
            if let project { LaunchSessionView(storeID: project.storeID, project: project.name, preferredHostID: session.host.id) }
        }
        .sheet(item: $launchingWorktree) { LaunchSessionView(worktree: $0) }
        .sheet(item: $menuCommand) { item in
            if let menu = AgentMenuChoice.menu(command: item.command, source: model.target?.source ?? "") {
                ChatMenuPickerSheet(title: menu.title, command: item.command, rows: menu.rows) { index in
                    menuCommand = nil
                    sendTask = Task { await model.drive(session, menuCommand: item.command, index: index) }
                }
            }
        }
        .sheet(isPresented: $showingModelPicker) {
            ChatModelPickerSheet(source: model.target?.source ?? "", current: model.modelName,
                                 currentEffort: model.modelEffort, host: session.host,
                                 choose: { argument, effort in try await model.switchModel(session, argument: argument, effort: effort) },
                                 deferChoice: { argument, effort in model.deferModelSwitch(session, argument: argument, effort: effort) })
        }
        .sheet(isPresented: $showingUsage) { ChatUsageSheet(model: model) { showingUsage = false } }
        .sheet(isPresented: $showingSecret) { ChatSecretSheet(model: model, session: session) }
        .sheet(isPresented: $showingChildAgents) {
            if let target = model.target { ChatSubagentsView(session: session, target: target, agents: childAgents) }
        }
        .fullScreenCover(item: $previewImage) { item in
            FileViewer(attachment: item.attachment)
        }
        .sheet(isPresented: $showingContext) {
            if let project {
                ChatContextPicker(project: project) { context in
                    model.draft += (model.draft.isEmpty ? "" : "\n\n") + context
                }
            }
        }
        .sheet(isPresented: $assigningProject) {
            NavigationStack {
                LiveProjectPicker(hostID: session.host.id, cwd: session.tab.cwd ?? "",
                                  existing: preferencesStore.preferences?.mapping(hostID: session.host.id, cwd: session.tab.cwd))
            }
        }
        .phrenDialog(isPresented: $attachmentError.isPresent(), title: "Could not add attachment",
                     message: attachmentError ?? "",
                     actions: [.init(id: "ok", title: "OK", role: .cancel) { attachmentError = nil }],
                     identifier: "chat-attachment-error")
        .task(id: RunIdentity(active: active, refresh: refresh)) {
            guard active else { return }
            await model.run(session)
        }
    }

    private func refreshChildAgents() async {
        guard let target = model.target, !target.isStarting else {
            childAgents = []
            await SessionWorkingActivityController.shared.observeSubagents(
                session: session, count: session.tab.runningChildren)
            return
        }
        #if DEBUG && targetEnvironment(simulator)
        if AgentChatFixture.enabled {
            childAgents = (try? AgentChatFixture.childAgents(target).agents) ?? []
            let computers = AgentChild.runningRows(childAgents).compactMap { $0.agent.computer?.name }
            await SessionWorkingActivityController.shared.observeSubagents(
                session: session, count: runningChildAgentCount, computers: computers)
            return
        }
        #endif
        do {
            let key = try DeviceSSHKey.load(session.host.id)
            let tree = try await PhrenConnection.childAgents(host: session.host, privateKey: key, target: target)
            childAgents = tree.agents
            childAgentsError = tree.peerError.map { "Sub-agents on other computers are missing: \($0)" }
            let computers = AgentChild.runningRows(childAgents).compactMap { $0.agent.computer?.name }
            await SessionWorkingActivityController.shared.observeSubagents(
                session: session, count: runningChildAgentCount, computers: computers)
        } catch is CancellationError {
        } catch {
            // Keep the last tree; say why it may be stale.
            childAgentsError = "Couldn't refresh sub-agents: \(error.localizedDescription)"
        }
    }

    private func openChildFromDrawer(_ child: AgentChild) {
        closeAgentDrawer()
        guard let target = model.target else { return }
        openedChild = workNavigation(child, session: session, target: target)
    }

    private func openSessionChildFromDrawer(_ childSession: LiveAgentSession, target: AgentChatTarget, child: AgentChild) {
        closeAgentDrawer()
        requestedChild = AgentChildRequest(session: childSession, target: target, agent: child)
    }

    private func openRequestedChildIfReady() {
        guard let request = requestedChild, request.session.id == session.id else { return }
        requestedChild = nil
        openedChild = workNavigation(request.agent, session: request.session, target: request.target)
    }

    private func workNavigation(_ agent: AgentChild, session: LiveAgentSession,
                                target: AgentChatTarget) -> AgentWorkNavigation? {
        let hosts = preferencesStore.preferences?.hosts ?? []
        let offline = Set(SessionOverviewMonitor.shared.computers.compactMap { computer in
            computer.monitor.message != nil || computer.monitor.isStale(at: .now)
                ? computer.host.id : nil
        })
        return AgentWorkNavigation.resolve(agent: agent, session: session, target: target,
                                           hosts: hosts, offlineHostIDs: offline)
    }

    /// A tab with only shells is a terminal, not a chat: go straight there
    /// once, and come back to the picker when an agent starts.
    private func fallBackToTerminalIfShellOnly(loaded: Bool) {
        guard loaded, !fellBackToTerminal, model.target == nil, model.error == nil else { return }
        guard let first = model.panes.first, !hasAgentPanes, commandDestination == nil else { return }
        fellBackToTerminal = true
        commandDestination = .init(paneID: first.id, menu: false)
    }

    private func openAgentDrawer() {
        withAnimation(reduceMotion ? nil : .easeOut(duration: 0.22)) { showingAgentSwitcher = true }
    }
    private func closeAgentDrawer() {
        withAnimation(reduceMotion ? nil : .easeIn(duration: 0.18)) { showingAgentSwitcher = false }
    }

    private var runningChildAgentCount: Int { childAgents.reduce(0) { $0 + $1.runningCount } }

    /// A row in the options sheet, run once that sheet has closed.
    private func performOption(_ action: ChatOptionsSheet.Action) {
        switch action {
        case .showChanges: showingChanges = true
        case .linkProject: assigningProject = true
        case .chooseAnother: model.chooseAnother(); refresh = UUID()
        case .pickModel: showingModelPicker = true
        case .showUsage: showingUsage = true
        case .addContext: showingContext = true
        case .newWorktree: launchingWorktree = project.flatMap { WorktreeLaunchRequest(session: session, project: $0) }
        }
    }

    /// Runs one agent request as the send task, so leaving the chat cancels it.
    private func runAgentRequest(_ operation: @escaping @MainActor () async -> Void) {
        sendTask = Task { await operation() }
    }

    private var composerBar: some View {
        ChatComposerBar(model: model, session: session, active: active, composing: $composing,
                        dictation: dictation, talk: talk, textSelection: textSelection,
                        childAgentsError: childAgentsError, runningChildAgentCount: runningChildAgentCount,
                        actions: ChatComposerActions(
                            run: runAgentRequest,
                            preview: { previewImage = $0 },
                            addAttachment: { showingAttachmentMenu.toggle() },
                            switchAgent: { showingAgentSwitcher = true },
                            showChildAgents: { showingChildAgents = true },
                            enterSecret: { showingSecret = true },
                            // Settings > Voice decides what the mic does: dictate into the
                            // box (never sends on its own) or start talk mode.
                            toggleDictation: {
                                if SpeechSettings.micButton() == .talk, !dictating { toggleTalk() }
                                else if dictating { stopDictation() } else { talk.stop(); startDictation() }
                            },
                            toggleTalk: toggleTalk,
                            primary: primaryAction,
                            openCommandMenu: openCommandMenu,
                            pasteImages: pasteImages),
                        attachmentMenu: $showingAttachmentMenu, attachmentMenuItems: attachmentMenuItems)
    }

    /// The + menu: Photos, Camera, Files and Paste, plus Project memory and a
    /// fixture row. Every row closes the menu, then runs its own action.
    private var attachmentMenuItems: [PhrenMenuItem] {
        let canAdd = model.attachments.count < ChatAttachmentLimit.maximum
        var items: [PhrenMenuItem] = [
            PhrenMenuItem(id: "photos", title: "Photos", systemImage: "photo.on.rectangle", isEnabled: canAdd) {
                attachmentTarget = model.target; attachmentSource = .photos
            },
            PhrenMenuItem(id: "files", title: "Files", systemImage: "doc", isEnabled: canAdd) {
                attachmentTarget = model.target; attachmentSource = .files
            },
            PhrenMenuItem(id: "paste", title: "Paste image", systemImage: "clipboard",
                          isEnabled: canAdd && UIPasteboard.general.hasImages) { pasteFromClipboard() },
        ]
        if UIImagePickerController.isSourceTypeAvailable(.camera) {
            items.insert(PhrenMenuItem(id: "camera", title: "Camera", systemImage: "camera", isEnabled: canAdd) {
                attachmentTarget = model.target; attachmentSource = .camera
            }, at: 1)
        }
        if project != nil {
            items.append(PhrenMenuItem(id: "context", title: "Project memory", systemImage: "brain") {
                // Let the menu dismiss before the context sheet slides up.
                Task { try? await Task.sleep(for: .milliseconds(350)); showingContext = true }
            })
        }
        #if DEBUG && targetEnvironment(simulator)
        if AgentChatFixture.enabled {
            items.append(PhrenMenuItem(id: "test-image", title: "Add test image", systemImage: "photo", isEnabled: canAdd) {
                model.add(AgentChatFixture.image)
            })
        }
        #endif
        return items
    }

    private func pasteFromClipboard() {
        Task { @MainActor in
            do {
                if let attachment = try await ChatAttachmentPreparation.pasteFromClipboard() {
                    model.add(attachment)
                }
            } catch { attachmentError = error.localizedDescription }
        }
    }

    /// The composer's round button: stop, open the command menu, draw an
    /// agent menu, pick a model, or send.
    private func primaryAction() {
        composing = false
        let trimmed = model.draft.trimmingCharacters(in: .whitespacesAndNewlines)
        if ChatComposerMode(model: model, active: active).showsStop {
            sendTask = Task { await model.stop(session) }
        } else if trimmed == "/", model.attachments.isEmpty {
            openCommandMenu()
        } else if model.attachments.isEmpty, AgentMenuChoice.menu(command: trimmed, source: model.target?.source ?? "") != nil {
            // The agent would draw a menu in its terminal; the
            // phone draws the same rows and walks it with keys.
            menuCommand = ChatMenuCommand(command: trimmed)
        } else if ["/model", "/models"].contains(trimmed), model.attachments.isEmpty, AgentModelChoice.supportsPicker(source: model.target?.source ?? "") {
            // Model selection uses a verified control route.
            model.draft = ""
            showingModelPicker = true
        } else {
            suppressComposingPin = true
            sendDraft()
            sendScrollToken &+= 1
        }
    }

    /// Sends the draft. A slash command normally hands off to the terminal,
    /// where the agent draws its menu; a command with its answer already in
    /// it (`/model sonnet`) is answered in the transcript and stays here.
    private func sendDraft(handoffCommands: Bool = true) {
        dictation.dropCleanup()
        sendTask = Task {
            if dictating { dictation.session.updateDraft(model.draft) }
            // A /btw side question answers on its own card; it opens no terminal.
            let sentCommand = model.draft
            let isCommand = AgentSlashCommand.isCommand(model.draft)
                && AgentSideAnswer.question(source: model.target?.source ?? "", text: model.draft) == nil, pane = model.target?.paneID
            await model.send(session, consumeDraft: dictating ? { [dictation, model] in dictation.restartSegment(model: model) } : nil)
            if model.deliveryError == nil, !isCommand { PhrenAppShortcuts.donateMessage(to: session) }
            if isCommand, handoffCommands, model.deliveryError == nil, let pane {
                // /clear and /new draw no menu: stay in the chat, which follows
                // the pane's fresh conversation. Others open the terminal.
                if !AgentSlashCommand.startsFreshConversation(sentCommand) { commandDestination = .init(paneID: pane, menu: false) }
                // /new, /clear and /resume may change the session ID.
                model.chooseAnother()
            }
        }
    }
    private struct CommandDestination: Hashable { let paneID: String; let menu: Bool }
    private func openCommandMenu() {
        guard let target = model.target else { return }
        composing = false
        commandDestination = .init(paneID: target.paneID, menu: true)
    }
    private struct RunIdentity: Equatable { let active: Bool; let refresh: UUID }
}

