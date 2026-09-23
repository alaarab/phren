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
    @State private var indexedCode: SessionCodeContext?
    @State private var initialized = false
    @State private var messageMenu = ChatMessageMenu()
    @Environment(AppModel.self) private var appModel
    @Environment(\.scenePhase) private var scenePhase
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @Environment(\.accessibilityVoiceOverEnabled) private var voiceOver
    @AppStorage("sessions.live.preferences.v1") private var hostData = Data()
    @State private var model = AgentChatModel()
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
    @State private var showingAgentSwitcher = false
    @State private var launchingNewThread = false
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
    @State private var turnChanges: ChatTurnChanges?
    @State private var fullToolOutput: FullToolOutput?
    @State private var historyTask: Task<Void, Never>?
    @State private var atBottom = true
    @State private var nearHistoryTop = false
    /// Older pages pulled in without a scroll in between; a scroll resets it.
    @State private var historyChain = 0
    @State private var paginationReady = false
    @State private var requestedHistoryLine: Int?
    /// Content and viewport stay separate so keyboard layout is never mistaken
    /// for transcript growth, while every requested pin has a real lower bound.
    @State private var scrollHeight: CGFloat = 0
    @State private var transcriptContentHeight: CGFloat = 0
    @State private var scrollMetrics = ChatScrollMetrics(contentHeight: 0, viewportHeight: 0, offsetY: 0)
    @State private var scrollPinRequest: ChatPinRequest?
    /// A send grows the transcript, resigns the composer and resizes the
    /// viewport in one frame. The pin that follows waits for layout and then
    /// for the keyboard animation; no other pin runs inside that transition.
    @State private var sendScrollToken = 0
    @State private var sendScrollTask: Task<Void, Never>?
    @State private var suppressComposingPin = false
    @State private var fellBackToTerminal = false
    @State private var composing = false
    /// The one paragraph showing native text selection, if any.
    @State private var textSelection = ChatTextSelection()

    private func startDictation() {
        dictation.start(model: model) { scenePhase == .active }
    }
    private func stopDictation() {
        dictation.stop(model: model) { sendDictationIfRequested() }
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
        (try? LiveSessionPreferences.read(hostData))?.hosts.first { $0.id == session.host.id }
    }
    private var project: SessionProject? {
        let pane = model.panes.first { $0.id == model.target?.paneID }
        let cwd = pane?.cwd ?? (model.panes.count == 1 ? session.tab.cwd : nil)
        return (try? LiveSessionPreferences.read(hostData))?.projectMatch(hostID: session.host.id, cwd: cwd, projects: appModel.sessionProjects)?.project
    }
    private var codeOrigin: SessionCodeContext? {
        guard let project, let target = model.target, !target.isStarting else { return nil }
        return SessionCodeContext(storeID: project.storeID, project: project.name, host: session.host, target: target)
    }
    private var active: Bool {
        visible && scenePhase == .active && currentHost?.hasSameConnection(as: session.host) == true
    }
    /// The activity line's stop ring works whenever the composer's stop would,
    /// draft or not.
    private var turnStopEnabled: Bool {
        active && model.connected && model.isBusy && model.target?.isStarting != true
            && !model.sending && !model.stopping && !model.answering
    }
    private struct WorkingActivityObservation: Equatable {
        let project: String?
        let projectStoreID: String?
        let provider: String?
        let branch: String?
        let activity: String?
        let toolName: String?
        let toolDetail: String?
    }
    private var workingActivityObservation: WorkingActivityObservation {
        WorkingActivityObservation(project: project?.name, projectStoreID: project?.storeID,
                                   provider: model.target?.source ?? session.tab.agent,
                                   branch: model.branch ?? session.tab.branch,
                                   activity: model.activityPhase == .working ? "working" : model.liveActivity ?? session.tab.agentStatus,
                                   toolName: model.currentToolName, toolDetail: model.currentToolDetail)
    }
    private func isAgent(_ pane: AgentChatPanes.Pane) -> Bool {
        (try? pane.target(hostID: session.host.id, workspaceID: session.workspaceID, tabID: session.tab.id, muxID: session.host.muxID)) != nil
    }
    private var hasAgentPanes: Bool { model.panes.contains(where: isAgent) }

    var body: some View { ChatPerformance.measure("chat container") {
        chatSheets(content.phrenAnchoredMenuHost()).modifier(ChatMessageMenuPresenter(menu: messageMenu))
    } }
    private var content: some View {
        VStack(spacing: 0) {
            AgentChatHeader(session: session, model: model, project: project, active: active) { showingOptions = true }
            // Rows scrolling up dissolve into the canvas under the header's
            // solid band instead of stopping at a hard edge beside the title.
            transcript
                .overlay(alignment: .top) { ChatHeaderFade() }
            ChatPendingInteraction(model: model, session: session, active: active, run: runAgentRequest)
            if !model.backgroundJobs.isEmpty {
                ChatBackgroundJobsView(jobs: model.backgroundJobs)
            }
            ChatPendingQueue(model: model, session: session, active: active, run: runAgentRequest) { composing = true }
            if let preview = dictation.preview {
                DictationCleanupPreviewCard(
                    preview: preview,
                    useTightened: { dictation.resolvePreview(useTightened: true, model: model) { sendDictationIfRequested() } },
                    keepOriginal: { dictation.resolvePreview(useTightened: false, model: model) { sendDictationIfRequested() } }
                )
                .padding(.horizontal, 12).padding(.top, 6)
            }
            if let side = model.visibleSideAnswer {
                ChatSideAnswerCard(side: side) { model.dismissSideAnswer(session) }
                    .padding(.horizontal, 12).padding(.top, 6)
            }
            if model.historyStalled {
                ChatHistoryStalledNotice(since: model.historyStalledSince) { launchingNewThread = true }
                    .disabled(project == nil)
            }
            composerBar
                .dynamicTypeSize(...DynamicTypeSize.accessibility1)
        }
        .background(PhrenTheme.chatCanvas)
        .confirmsWebLinks()
        .environment(\.openChatDiff) { fullDiff = $0 }
        .environment(\.openTurnChanges) { turnChanges = $0 }
        .environment(\.resolvePendingEcho) { id, retry in model.resolvePendingEcho(id, retry: retry) }
        .environment(\.openToolOutput) { fullToolOutput = $0 }
        .environment(model.turnControl)
        .environment(\.chatTurnStop, ChatTurnStop(enabled: turnStopEnabled) { sendTask = Task { await model.stop(session) } })
        .environment(\.chatChildAgents, model.target.flatMap { target in childAgents.isEmpty ? nil : ChatChildAgents(session: session, target: target, agents: childAgents) })
        .environment(textSelection)
        .chatAttachmentSources(source: $attachmentSource, canAdd: model.attachments.count < ChatAttachmentLimit.maximum,
                               add: { item in if model.target == attachmentTarget { model.add(item) } },
                               error: $attachmentError)
        .onChange(of: messageMenu.request?.id) { _, id in
            if id != nil { composing = false; textSelection.end() }
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
        .interactiveDismissDisabled(model.hasMore || model.loadingHistory)
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
            if !initialized {
                initialized = true
                if let initialTarget { model.choose(initialTarget, session: session) }
                else if let initialPane { model.choose(initialPane, session: session) }
                if startsDictation {
                    // Let the push finish first; the microphone prompt and the
                    // keyboard both fight a screen that is still sliding in.
                    Task { try? await Task.sleep(for: .milliseconds(450)); if !dictating { startDictation() } }
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
        .onChange(of: model.restoringDraft) { _, _ in acceptIncomingAttachments() }
        .onChange(of: model.approval?.id) { _, id in if id != nil { composing = false } }
        .onChange(of: model.attachments.count) { _, _ in acceptIncomingAttachments() }
        .onChange(of: requestedChild, initial: true) { _, _ in openRequestedChildIfReady() }
        .onChange(of: workingActivityObservation, initial: true) { _, value in
            Task {
                await SessionWorkingActivityController.shared.observe(
                    session: session, project: value.project, projectStoreID: value.projectStoreID,
                    provider: value.provider,
                    branch: value.branch, activity: value.activity, toolName: value.toolName,
                    toolDetail: value.toolDetail
                )
            }
        }
        .onDisappear { visible = false; sendTask?.cancel(); historyTask?.cancel(); dictation.cancelCleanupTask(); model.flushDrafts() }
        .onChange(of: scenePhase) { _, phase in if phase != .active { sendTask?.cancel(); historyTask?.cancel(); model.flushDrafts() } }
        .onChange(of: currentHost) { _, _ in sendTask?.cancel(); historyTask?.cancel() }
        .onChange(of: reduceMotion || voiceOver, initial: true) { _, instant in
            model.animateReplies = !instant
            if instant { model.reveal.finish() }
        }
        .task(id: active && model.reveal.isRevealing) {
            guard active else { return }
            while model.reveal.isRevealing && !Task.isCancelled {
                do { try await Task.sleep(for: .milliseconds(33)) } catch { return }
                model.reveal.advance()
            }
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

    /// The conversation: the scroll view, its history paging and the pins
    /// that keep it following the latest reply.
    private var transcript: some View {
        ScrollViewReader { proxy in
            transcriptScroll(proxy)
        }
    }

    private func transcriptScroll(_ proxy: ScrollViewProxy) -> some View {
        ScrollView {
            VStack(spacing: 0) {
                transcriptRows(proxy)
                // The scroll marker is not a message: it must not add
                // another inter-message gap below the final reply.
                GeometryReader { geometry in
                    Color.clear.preference(key: ChatBottomPosition.self, value: geometry.frame(in: .named("chat-scroll")).maxY)
                }.frame(height: 1).id("chat-bottom")
            }
            .padding(.horizontal, 18).padding(.top, 6).padding(.bottom, 6)
            .frame(minHeight: scrollHeight, alignment: .bottom)
            .background(GeometryReader { geometry in
                Color.clear.preference(key: ChatContentHeight.self, value: geometry.size.height)
            })
        }
        .accessibilityIdentifier("chat-transcript")
        .contentShape(Rectangle())
        .simultaneousGesture(TapGesture().onEnded {
            guard !textSelection.preventsTranscriptScrolling else {
                textSelection.transcriptTapped()
                return
            }
            composing = false
            textSelection.transcriptTapped()
        })
        .modifier(ChatHistoryScrollObserver { near in
            if near && !nearHistoryTop && model.historyError != nil { requestedHistoryLine = nil }
            if near != nearHistoryTop { historyChain = 0 }
            nearHistoryTop = near
            loadHistoryIfNeeded(proxy)
        })
        .task(id: active && model.connected) {
            paginationReady = false
            guard active, model.connected else { return }
            // Let the first backlog settle at the bottom before deciding
            // whether the viewport needs an earlier page.
            do { try await Task.sleep(for: .milliseconds(350)) } catch { return }
            paginationReady = true
            loadHistoryIfNeeded(proxy)
        }
        .onChange(of: model.history.startLine) { _, _ in loadHistoryIfNeeded(proxy, automatic: true) }
        .onPreferenceChange(ChatContentHeight.self) { transcriptContentHeight = $0 }
        .scrollDismissesKeyboard(textSelection.preventsTranscriptScrolling ? .never : .interactively)
        .scrollDisabled(textSelection.preventsTranscriptScrolling)
        .coordinateSpace(name: "chat-scroll")
        .background(GeometryReader { geometry in
            Color.clear.onAppear { scrollHeight = geometry.size.height }
                .onChange(of: geometry.size.height) { _, height in
                    guard abs(height - scrollHeight) > 0.5 else { return }
                    scrollHeight = height
                }
        })
        .modifier(ChatFollowScroll(viewport: scrollHeight, contentHeight: transcriptContentHeight,
                                   following: atBottom, pinRequest: scrollPinRequest,
                                   selectionActive: textSelection.preventsTranscriptScrolling) { _, new, userDriven in
            scrollMetrics = new
            textSelection.scrolled(to: new.offsetY)
            let near = new.distanceFromBottom <= ChatFollow.threshold
            if userDriven {
                if near != atBottom { atBottom = near }
            } else if near, !atBottom {
                atBottom = true
            }
        })
        .task {
            pinToBottom(proxy)
            for delay in [60, 200, 500] {
                do { try await Task.sleep(for: .milliseconds(delay)) } catch { return }
                guard atBottom else { return }
                pinToBottom(proxy)
            }
        }
        .overlay {
            if (model.loading && model.messages.isEmpty) || (model.timeline.isEmpty && !model.messages.isEmpty) {
                ProgressView()
                    .tint(PhrenTheme.chatNeutral)
                    .accessibilityLabel("Opening conversation")
                    .accessibilityIdentifier("chat-opening-spinner")
            }
        }
        .overlay(alignment: .bottomTrailing) {
            if !atBottom || model.history.hasNewer {
                Button {
                    if model.history.hasNewer {
                        historyTask?.cancel(); historyTask = nil; requestedHistoryLine = nil
                        model.showLatest(); refresh = UUID()
                    }
                    withAnimation { proxy.scrollTo("chat-bottom", anchor: .bottom) }
                } label: {
                    Image(systemName: "arrow.down").frame(width: 40, height: 40).background(PhrenTheme.surfaceRaised, in: Circle())
                }.accessibilityLabel("Latest messages").padding(12)
            }
        }
        .onChange(of: model.target?.id) { _, _ in
            historyTask?.cancel(); historyTask = nil; requestedHistoryLine = nil
            textSelection.end()
            pinToBottom(proxy)
        }
        .onChange(of: model.timeline.last?.id) { _, _ in
            if #unavailable(iOS 18.0), atBottom && !model.loadingHistory {
                pinToBottom(proxy, animated: true)
            }
        }
        .onChange(of: model.reveal.revision) { _, _ in
            if #unavailable(iOS 18.0), atBottom && !model.loadingHistory { pinToBottom(proxy) }
        }
        .onChange(of: model.imagesByMessage) { _, _ in
            if #unavailable(iOS 18.0), atBottom && !model.loadingHistory { pinToBottom(proxy) }
        }
        .onChange(of: model.reconnectRevision) { _, _ in
            if atBottom && !model.loadingHistory { pinToBottom(proxy) }
        }
        .onChange(of: composing) { _, _ in
            // A send resigns focus in the same frame it appends its
            // row; pinAfterSend owns that scroll, so this transition
            // must not also enqueue one against an unlaid row.
            guard !suppressComposingPin else { return }
            // The keyboard's safe-area change keeps the bottom
            // anchored on its own, so a view already at the end needs
            // no help; pinning it again fights the transaction and,
            // against a lazy stack's estimate, throws the transcript
            // past its end. Only a view that had drifted is pulled
            // back, without animation (reduce motion included).
            guard atBottom, !model.loadingHistory,
                  scrollMetrics.distanceFromBottom > 8 else { return }
            pinToBottom(proxy)
        }
        .onChange(of: sendScrollToken) { _, _ in pinAfterSend(proxy) }
    }

    /// The rows inside the scroll view: pane choice, connection notices,
    /// history paging, the transcript itself and the status lines under it.
    private func transcriptRows(_ proxy: ScrollViewProxy) -> some View {
        VStack(alignment: .leading, spacing: 12) {
            if model.target == nil && !model.loading {
                ChatPanePicker(panes: model.panes, isAgent: isAgent,
                               choose: { pane in model.choose(pane, session: session); refresh = UUID() },
                               openTerminal: { pane in commandDestination = .init(paneID: pane.id, menu: false) })
            }
            if let error = model.error { connectionIssue(error, retry: !model.connected && model.target != nil) }
            if currentHost?.hasSameConnection(as: session.host) != true {
                connectionIssue("This computer's connection changed. Reopen chat from the current session list.")
            }
            if model.hasMore {
                VStack(spacing: 8) {
                    if model.loadingHistory { ProgressView().accessibilityLabel("Loading earlier messages") }
                    else if model.historyError != nil {
                        Button("Retry loading earlier messages") {
                            requestedHistoryLine = nil
                            loadHistoryIfNeeded(proxy)
                        }.font(.caption)
                    }
                }
                .frame(maxWidth: .infinity, minHeight: 24)
                .background(GeometryReader { geometry in
                    Color.clear.preference(key: ChatHistoryPosition.self, value: geometry.frame(in: .named("chat-scroll")).minY)
                })
                .accessibilityIdentifier("chat-history")
            }
            ChatTranscriptRows(revision: model.timelineRevision, entries: model.timeline,
                               revealed: model.reveal.visible, revealRevision: model.reveal.revision,
                               images: model.imagesByMessage, session: session, target: model.target,
                               active: active, viewportHeight: scrollHeight,
                               preview: { previewImage = $0 }).equatable()
            if let notice = model.modelSwitchNotice {
                Text(notice).font(PhrenTypography.caption).foregroundStyle(PhrenTheme.textMuted)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .accessibilityIdentifier("chat-model-system-row")
            }
            if let pending = model.deferredModel {
                PhrenOptionRow(title: "Switch after this turn", caption: pending.name + " · Tap to cancel", icon: "clock") {
                    model.cancelModelSwitch()
                }
                .disabled(model.switchingModel)
                .phrenIdentifier("chat-model-pending")
            }
            if let preview = model.replyPreview {
                ChatReplyPreviewRow(preview: preview)
            }
            if model.target?.isStarting == true {
                Text(session.tab.isConductor
                     ? "Starting the conductor with \(model.target?.providerName ?? "agent")…"
                     : "Starting \(model.target?.providerName ?? "agent") in \(session.projectDisplayName(project?.name))…")
                    .foregroundStyle(PhrenTheme.textMuted).padding(.top, 24)
                    .accessibilityIdentifier("chat-starting")
            } else if model.connected && model.messages.isEmpty {
                Text("Ready for your message.").foregroundStyle(PhrenTheme.textMuted).padding(.top, 24)
            }
        }
    }

    /// Every sheet this screen can present. UIKit restores the stack's bar
    /// when one goes away; dismissing any of them must re-hide it.
    private var anySheetPresented: Bool {
        showingOptions || launchingNewThread || menuCommand != nil
            || showingModelPicker || showingUsage || showingSecret || showingChildAgents
            || previewImage != nil || showingContext || assigningProject
    }

    /// The second half of the chat chrome: dictation, sheets and lifecycle
    /// tasks. Split from `content` so the type checker finishes.
    private func chatSheets<V: View>(_ content: V) -> some View {
        content
        .onChange(of: model.loading) { _, loading in fallBackToTerminalIfShellOnly(loaded: !loading) }
        .onChange(of: anySheetPresented) { _, presented in
            guard !presented else { return }
            DispatchQueue.main.async {
                NotificationCenter.default.post(name: .phrenReassertNavigationBarHidden, object: nil)
            }
        }
        .onChange(of: scenePhase) { _, phase in if phase != .active { stopDictation() } }
        .onDisappear { dictation.tearDown() }
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
                                  existing: (try? LiveSessionPreferences.read(hostData))?.mapping(hostID: session.host.id, cwd: session.tab.cwd))
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
        .task(id: childAgentsIdentity) { await refreshChildAgents() }
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
        let hosts = (try? LiveSessionPreferences.read(hostData))?.hosts ?? []
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
    /// Re-read the spawned agents when the conversation or its transcript changes.
    private var childAgentsIdentity: String { (model.target?.id ?? "") + ":" + String(model.timelineRevision) }

    private func openAgentDrawer() {
        withAnimation(reduceMotion ? nil : .easeOut(duration: 0.22)) { showingAgentSwitcher = true }
    }
    private func closeAgentDrawer() {
        withAnimation(reduceMotion ? nil : .easeIn(duration: 0.18)) { showingAgentSwitcher = false }
    }

    /// Pages loaded back to back without a scroll in between. A page of
    /// nothing but lifecycle rows may need a second, but a chain past a few
    /// means the anchor scroll isn't taking and the top stays "near" — left
    /// alone that pulls the whole history and hangs the phone.
    private static let automaticHistoryPages = 3

    private func pinToBottom(_ proxy: ScrollViewProxy, animated: Bool = false) {
        DispatchQueue.main.async {
            guard !textSelection.preventsTranscriptScrolling, scrollMetrics.bottomOffset > 0.5 else { return }
            if #available(iOS 18.0, *) {
                scrollPinRequest = ChatPinRequest(animated: animated)
            } else if animated {
                withAnimation { proxy.scrollTo("chat-bottom", anchor: .bottom) }
            } else {
                proxy.scrollTo("chat-bottom", anchor: .bottom)
            }
        }
    }

    /// The pin that follows a send. The sent row grows the transcript and the
    /// composer's resignation closes the keyboard in the same frame, so a pin
    /// resolved then can target a row the lazy stack has not laid out. Wait one
    /// run loop for the row, pin, then pin once more when the keyboard
    /// animation has finished. `pinToBottom` holds each target to the content
    /// end (the clamped numeric offset on iOS 18, the bottom marker before it).
    private func pinAfterSend(_ proxy: ScrollViewProxy) {
        sendScrollTask?.cancel()
        sendScrollTask = Task { @MainActor in
            await Task.yield()
            suppressComposingPin = false
            guard atBottom, !model.loadingHistory else { return }
            pinToBottom(proxy)
            do { try await Task.sleep(for: .milliseconds(350)) } catch { return }
            guard atBottom, !model.loadingHistory else { return }
            pinToBottom(proxy)
        }
    }

    private func loadHistoryIfNeeded(_ proxy: ScrollViewProxy, automatic: Bool = false) {
        guard active, paginationReady, model.connected, model.hasMore, !model.loadingHistory,
              historyTask == nil, nearHistoryTop, !automatic || historyChain < Self.automaticHistoryPages,
              let line = model.history.startLine, line > 0, requestedHistoryLine != line else { return }
        if automatic { historyChain += 1 } else { historyChain = 0 }
        requestedHistoryLine = line
        let anchor = model.timeline.first?.id
        let target = model.target
        historyTask = Task {
            await model.loadOlder(session)
            guard !Task.isCancelled, model.target == target else {
                if model.target == target { historyTask = nil; requestedHistoryLine = nil }
                return
            }
            await Task.yield()
            if let anchor {
                // Older rows can fold the anchor into a read run under another
                // id; scroll to whichever entry holds that message now.
                let entries = model.timeline
                let row = entries.first { $0.id == anchor || $0.messages.contains { $0.id == anchor } }?.id ?? anchor
                var transaction = Transaction(); transaction.disablesAnimations = true
                withTransaction(transaction) { proxy.scrollTo(row, anchor: .top) }
            }
            // A page may contain only lifecycle events. Recheck after layout
            // settles so it can continue without another scroll gesture.
            do { try await Task.sleep(for: .milliseconds(100)) } catch {
                if model.target == target { historyTask = nil; requestedHistoryLine = nil }
                return
            }
            guard model.target == target else { return }
            historyTask = nil
            loadHistoryIfNeeded(proxy, automatic: true)
        }
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
        }
    }

    private func connectionIssue(_ message: String, retry: Bool = false) -> some View {
        VStack(alignment: .leading, spacing: 8) {
            Label(message, systemImage: "wifi.exclamationmark")
            if retry {
                Button("Reconnect", systemImage: "arrow.clockwise") { refresh = UUID() }
                    .font(.footnote.weight(.semibold)).foregroundStyle(PhrenTheme.cyan)
                    .accessibilityIdentifier("chat-reconnect")
            }
        }
        .font(.footnote).foregroundStyle(PhrenTheme.warning).padding(12).phrenCard()
    }

    /// Runs one agent request as the send task, so leaving the chat cancels it.
    private func runAgentRequest(_ operation: @escaping @MainActor () async -> Void) {
        sendTask = Task { await operation() }
    }

    private var composerBar: some View {
        ChatComposerBar(model: model, session: session, active: active, composing: $composing,
                        dictation: dictation, textSelection: textSelection,
                        childAgentsError: childAgentsError, runningChildAgentCount: runningChildAgentCount,
                        actions: ChatComposerActions(
                            run: runAgentRequest,
                            preview: { previewImage = $0 },
                            addAttachment: { showingAttachmentMenu.toggle() },
                            switchAgent: { showingAgentSwitcher = true },
                            showChildAgents: { showingChildAgents = true },
                            enterSecret: { showingSecret = true },
                            toggleDictation: { if dictating { stopDictation() } else { startDictation() } },
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
            let isCommand = AgentSlashCommand.isCommand(model.draft)
                && AgentSideAnswer.question(source: model.target?.source ?? "", text: model.draft) == nil, pane = model.target?.paneID
            await model.send(session, consumeDraft: dictating ? { [dictation, model] in dictation.restartSegment(model: model) } : nil)
            if model.deliveryError == nil, !isCommand { PhrenAppShortcuts.donateMessage(to: session) }
            if isCommand, handoffCommands, model.deliveryError == nil, let pane {
                commandDestination = .init(paneID: pane, menu: false)
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

