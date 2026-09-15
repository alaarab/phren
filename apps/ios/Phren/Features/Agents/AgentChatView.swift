import PhrenKit
import PhrenLive
import SwiftUI

/// Every agent opens in Phren with its exact computer and conversation.
struct AgentConversationLink<LabelContent: View>: View {
    let session: LiveAgentSession
    var onOpenInPhren: (() -> Void)? = nil
    @ViewBuilder var label: LabelContent
    @State private var showingChat = false

    var body: some View {
        Button {
            PhrenAppShortcuts.donateOpen(session)
            if let onOpenInPhren { onOpenInPhren() }
            else { showingChat = true }
        } label: { label }
        .sheet(isPresented: $showingChat) {
            // Settings → Chat decides which of the two views a session opens in.
            if ChatSettings.opensInTerminal { NavigationStack { HerdrTerminalView(host: session.host, session: session) } }
            else { AgentChatSheet(session: session) }
        }
    }
}

struct AgentChatSheet: View {
    @State private var session: LiveAgentSession
    @State private var incomingAttachments: [AgentAttachment]
    @State private var incomingDraft: String
    private let initialSessionID: LiveAgentSession.ID
    private let initialPane: AgentChatPanes.Pane?
    init(session: LiveAgentSession, initialPane: AgentChatPanes.Pane? = nil,
         attachments: [AgentAttachment] = [], draft: String = "") {
        _session = State(initialValue: session)
        _incomingAttachments = State(initialValue: attachments)
        _incomingDraft = State(initialValue: draft)
        initialSessionID = session.id
        self.initialPane = initialPane
    }
    var body: some View {
        NavigationStack {
            AgentChatView(session: session, switchSession: { session = $0 },
                          initialPane: session.id == initialSessionID ? initialPane : nil,
                          incomingAttachments: $incomingAttachments, incomingDraft: $incomingDraft).id(session.id)
        }
    }
}

struct AgentChatView: View {
    let session: LiveAgentSession
    let switchSession: (LiveAgentSession) -> Void
    let initialPane: AgentChatPanes.Pane?
    @Binding var incomingAttachments: [AgentAttachment]
    @Binding var incomingDraft: String
    @State private var initialized = false
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
    @State private var showingAttachments = false
    /// Dictation writes straight into the composer: the words land in the
    /// message as they are recognised, no separate box to review.
    @State private var dictation = SpeechTranscriber()
    @State private var dictationPrefix = ""
    @State private var dictationBase = ""
    @State private var dictationTask: Task<Void, Never>?
    @State private var cleanupTask: Task<Void, Never>?
    @State private var dictationPreview: DictationCleanupPreview?
    /// The mic is on as far as the person is concerned. The recogniser ends
    /// a segment on its own after a pause; while this is set, each finished
    /// segment is folded into the message and a new one starts.
    @State private var dictating = false
    @State private var showingAgentSwitcher = false
    @State private var showingUsage = false
    @State private var previewImage: ChatAttachmentDraft?
    @State private var assigningProject = false
    @State private var historyTask: Task<Void, Never>?
    @State private var bottomPosition: CGFloat = 0
    @State private var nearHistoryTop = false
    @State private var paginationReady = false
    @State private var requestedHistoryLine: Int?
    @State private var scrollHeight: CGFloat = 0
    @State private var backgroundFirstSeen: [String: Date] = [:]
    @ScaledMetric(relativeTo: .body) private var composerTextSize = 14.0
    @FocusState private var composing: Bool
    // Recalculate when the keyboard changes the viewport as well as when the
    // transcript moves; either measurement can arrive first during layout.
    private var atBottom: Bool { bottomPosition <= scrollHeight + 60 }

    /// Starts recognising into the composer after whatever is already typed.
    private func startDictation() {
        dictationTask?.cancel()
        cleanupTask?.cancel()
        dictationPreview = nil
        dictationTask = Task {
            guard await SpeechTranscriber.requestPermissions() == .authorized else {
                model.deliveryError = "Allow microphone and speech recognition in iPhone Settings to dictate."; return
            }
            guard !Task.isCancelled, scenePhase == .active else { return }
            dictationBase = model.draft + (model.draft.isEmpty || model.draft.hasSuffix(" ") || model.draft.hasSuffix("\n") ? "" : " ")
            dictationPrefix = dictationBase
            do { dictating = true; try dictation.start(); model.deliveryError = nil } catch { dictating = false; model.deliveryError = error.localizedDescription }
        }
    }
    /// Stops and preserves the raw words in the draft. When opted in, Apple
    /// Intelligence prepares a candidate that remains separate until chosen.
    private func stopDictation() {
        guard dictating else { return }
        dictating = false
        let spoken = SpeechSettings.apply(dictation.transcript)
        dictation.stop()
        if !spoken.isEmpty { model.draft = dictationPrefix + spoken }
        model.draft = model.draft.trimmingCharacters(in: .whitespaces)
        let rawDraft = model.draft
        let rawInstruction = rawDraft.hasPrefix(dictationBase)
            ? String(rawDraft.dropFirst(dictationBase.count)) : rawDraft
        guard SpeechSettings.cleanupEnabled(in: AppRuntime.defaults), !rawInstruction.isEmpty else {
            sendDictationIfRequested()
            return
        }
        cleanupTask?.cancel()
        cleanupTask = Task {
            do {
                let tightened = try await DictationCleanupService.clean(rawInstruction)
                guard !Task.isCancelled, model.draft == rawDraft else { return }
                guard let tightened else { sendDictationIfRequested(); return }
                dictationPreview = DictationCleanupPreview(
                    rawDraft: rawDraft, rawInstruction: rawInstruction,
                    tightenedDraft: dictationBase.trimmingCharacters(in: .whitespaces).isEmpty
                        ? tightened : dictationBase + tightened,
                    tightenedInstruction: tightened
                )
            } catch {
                guard !Task.isCancelled else { return }
                sendDictationIfRequested()
            }
        }
    }

    private func resolveDictationPreview(useTightened: Bool) {
        guard let preview = dictationPreview else { return }
        if model.draft == preview.rawDraft {
            model.draft = useTightened ? preview.tightenedDraft : preview.rawDraft
        }
        dictationPreview = nil
        sendDictationIfRequested()
    }

    private func sendDictationIfRequested() {
        if ChatSettings.autoSendsDictation,
           !model.draft.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
            Task { await model.send(session) }
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

    private var currentHost: LiveHost? {
        (try? LiveSessionPreferences.read(hostData))?.hosts.first { $0.id == session.host.id }
    }
    private var project: SessionProject? {
        let pane = model.panes.first { $0.id == model.target?.paneID }
        let cwd = pane?.cwd ?? (model.panes.count == 1 ? session.tab.cwd : nil)
        return (try? LiveSessionPreferences.read(hostData))?.projectMatch(hostID: session.host.id, cwd: cwd, projects: appModel.sessionProjects)?.project
    }
    private var active: Bool { visible && scenePhase == .active && currentHost == session.host }
    private var selectedPane: AgentChatPanes.Pane? { model.panes.first { $0.id == model.target?.paneID } }
    private struct WorkingActivityObservation: Equatable {
        let project: String?
        let provider: String?
        let branch: String?
        let activity: String?
        let toolName: String?
    }
    private var workingActivityObservation: WorkingActivityObservation {
        WorkingActivityObservation(project: project?.name, provider: model.target?.source ?? session.tab.agent,
                                   branch: model.branch ?? session.tab.branch,
                                   activity: model.activityPhase == .working ? "working" : model.liveActivity ?? session.tab.agentStatus,
                                   toolName: model.currentToolName)
    }

    var body: some View {
        VStack(spacing: 0) {
            chatHeader

            ScrollViewReader { proxy in
                ScrollView {
                    VStack(spacing: 0) {
                        LazyVStack(alignment: .leading, spacing: 12) {
                            if model.target == nil && !model.loading {
                                Text("Choose an agent").font(.title2.weight(.semibold))
                                ForEach(model.panes) { pane in
                                    if (try? pane.target(hostID: session.host.id, workspaceID: session.workspaceID, tabID: session.tab.id, muxID: session.host.muxID)) != nil {
                                        Button {
                                            model.choose(pane, session: session); refresh = UUID()
                                        } label: {
                                            HStack { VStack(alignment: .leading) { Text(pane.displayTitle); Text(pane.agent ?? "").font(.caption) }; Spacer(); Image(systemName: "chevron.right") }
                                                .padding(16).phrenCard()
                                        }.buttonStyle(.plain).accessibilityIdentifier("chat-pane:\(pane.id)")
                                    } else {
                                        NavigationLink {
                                            HerdrTerminalView(host: session.host, session: session, paneID: pane.id)
                                        } label: {
                                            Label("\(pane.displayTitle) · Open terminal", systemImage: "terminal").font(.subheadline)
                                        }
                                    }
                                }
                                Text("Native chat supports Codex, Claude Code, and GitHub Copilot sessions recognized on this computer.")
                                    .font(.footnote).foregroundStyle(PhrenTheme.textMuted)
                                if model.panes.contains(where: { $0.agent == "copilot" }) {
                                    Link("Set up Copilot chat", destination: URL(string: "https://alaarab.github.io/phren/phren-hook.html")!)
                                        .font(.footnote)
                                }
                            }
                            if let error = model.error { connectionIssue(error, retry: !model.connected && model.target != nil) }
                            if currentHost != session.host { connectionIssue("This computer's connection changed. Reopen chat from the current session list.") }
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
                            ForEach(model.timeline) { entry in
                                if entry.isReadRun {
                                    ChatReadRun(messages: entry.messages, resultImages: { message in
                                        AnyView(Group {
                                            if let target = model.target {
                                                ForEach(message.resultImages, id: \.self) { ref in
                                                    ChatHistoricalImage(session: session, target: target, line: message.line, block: ref.block, inner: ref.inner, active: active, preview: { previewImage = $0 })
                                                }
                                            }
                                        })
                                    }).id(entry.id)
                                } else if entry.isActivity {
                                    ChatToolActivity(messages: entry.messages, resultImages: { message in
                                        AnyView(Group {
                                            if let target = model.target {
                                                ForEach(message.resultImages, id: \.self) { ref in
                                                    ChatHistoricalImage(session: session, target: target, line: message.line, block: ref.block, inner: ref.inner, active: active, preview: { previewImage = $0 })
                                                }
                                            }
                                        })
                                    }).equatable().id(entry.id)
                                } else if let message = entry.messages.first {
                                    ChatMessageRow(message: message, revealedText: model.reveal.visible[message.id], images: model.sentImages.filter { item in
                                        message.role == .user && item.path.map { message.text.contains($0) } == true
                                    }, preview: { previewImage = $0 }, historical: {
                                        if let target = model.target {
                                            ForEach(message.imageBlocks, id: \.self) { block in
                                                ChatHistoricalImage(session: session, target: target, line: message.line, block: block, active: active, preview: { previewImage = $0 })
                                            }
                                        }
                                    }).id(message.id)
                                }
                            }
                            if let prompt = model.question, model.needsAnswer, model.questionsSupported {
                                ChatQuestionCard(prompt: prompt, busy: model.answering || !active || !model.connected) { selections in
                                    sendTask = Task { await model.answer(session, question: prompt, selections: selections) }
                                }.id(prompt.id)
                            }
                            if model.connected && model.messages.isEmpty { Text("Ready for your message.").foregroundStyle(PhrenTheme.textMuted).padding(.top, 40) }
                        }
                        // The scroll marker is not a message: it must not add
                        // another inter-message gap below the final reply.
                        GeometryReader { geometry in
                            Color.clear.preference(key: ChatBottomPosition.self, value: geometry.frame(in: .named("chat-scroll")).maxY)
                        }.frame(height: 1).id("chat-bottom")
                    }
                    .padding(.horizontal, 18).padding(.top, 18).padding(.bottom, 6)
                }
                .accessibilityIdentifier("chat-transcript")
                .contentShape(Rectangle())
                .simultaneousGesture(TapGesture().onEnded { composing = false })
                .modifier(ChatHistoryScrollObserver { near in
                    if near && !nearHistoryTop && model.historyError != nil { requestedHistoryLine = nil }
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
                .onChange(of: model.history.startLine) { _, _ in loadHistoryIfNeeded(proxy) }
                .scrollDismissesKeyboard(.interactively)
                .defaultScrollAnchor(.bottom)
                .coordinateSpace(name: "chat-scroll")
                .background(GeometryReader { geometry in
                    Color.clear.onAppear { scrollHeight = geometry.size.height }
                        .onChange(of: geometry.size.height) { _, height in
                            if abs(height - scrollHeight) > 0.5 { scrollHeight = height }
                        }
                })
                .onPreferenceChange(ChatBottomPosition.self) { position in
                    if abs(position - bottomPosition) > 0.5 { bottomPosition = position }
                }
                .overlay {
                    if model.loading && model.messages.isEmpty {
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
                    proxy.scrollTo("chat-bottom", anchor: .bottom)
                }
                .onChange(of: model.messages.last?.id) { _, _ in
                    if atBottom && !model.loadingHistory { withAnimation { proxy.scrollTo("chat-bottom", anchor: .bottom) } }
                }
                .onChange(of: model.reveal.revision) { _, _ in
                    if atBottom && !model.loadingHistory { proxy.scrollTo("chat-bottom", anchor: .bottom) }
                }
            }
            if let approval = model.approval {
                ChatApprovalCard(approval: approval, busy: model.answering || !active || !model.interactionConnected) {
                    NavigationLink { HerdrTerminalView(host: session.host, session: session, target: model.target) } label: {
                        Label("Open terminal", systemImage: "terminal").frame(maxWidth: .infinity, minHeight: 32)
                    }.accessibilityIdentifier("chat-approval-terminal")
                } answer: { approve in
                    sendTask = Task { await model.answer(session, approval: approval, approve: approve) }
                }
                .id(approval.id)
                .padding(.horizontal, 12).padding(.vertical, 6)
            }
            let backgroundJobs = ChatBackgroundJobs.parse(model.messages, firstSeen: backgroundFirstSeen)
            if !backgroundJobs.isEmpty {
                ChatBackgroundJobsView(jobs: backgroundJobs)
                    .padding(.horizontal, 12).padding(.vertical, 4)
                    .accessibilityIdentifier("chat-background-jobs")
            }
            // Between the transcript and the input, where Claude Code keeps
            // its queue; outside the lazy stack so the rows are always laid out.
            if !model.queue.isEmpty {
                // As tall as its rows; a scroller only once they pass the cap —
                // a bare ScrollView would take the whole cap and leave a hole.
                ViewThatFits(in: .vertical) {
                    queuedMessages.padding(.horizontal, 12)
                    ScrollView { queuedMessages.padding(.horizontal, 12) }
                }
                .frame(maxHeight: 190).padding(.bottom, 2)
            }
            if let preview = dictationPreview {
                DictationCleanupPreviewCard(
                    preview: preview,
                    useTightened: { resolveDictationPreview(useTightened: true) },
                    keepOriginal: { resolveDictationPreview(useTightened: false) }
                )
                .padding(.horizontal, 12).padding(.top, 6)
            }
            composer
                .dynamicTypeSize(...DynamicTypeSize.accessibility1)
        }
        .background(PhrenTheme.chatCanvas)
        .overlay {
            if showingAgentSwitcher {
                ZStack(alignment: .leading) {
                    Color.black.opacity(0.34).ignoresSafeArea().onTapGesture { closeAgentDrawer() }
                    AgentDrawer(current: session, panes: model.panes, selectedPaneID: model.target?.paneID,
                                choosePane: { pane in model.choose(pane, session: session); refresh = UUID() },
                                chooseSession: switchSession, close: closeAgentDrawer)
                }.zIndex(20)
            }
        }
        .overlay(alignment: .leading) {
            if !showingAgentSwitcher {
                Color.clear.frame(width: 22).contentShape(Rectangle())
                    .gesture(DragGesture(minimumDistance: 18).onEnded { value in
                        if value.translation.width > 55 && abs(value.translation.height) < 80 { openAgentDrawer() }
                    })
                    .accessibilityHidden(true)
            }
        }
        .interactiveDismissDisabled(model.hasMore || model.loadingHistory)
        .navigationTitle("Agent chat")
        .navigationBarTitleDisplayMode(.inline)
        .toolbar(.hidden, for: .navigationBar)
        .onAppear {
            if !initialized {
                initialized = true
                if let initialPane { model.choose(initialPane, session: session) }
            }
            visible = true
        }
        .onChange(of: model.restoringDraft) { _, _ in acceptIncomingAttachments() }
        .onChange(of: model.approval?.id) { _, id in if id != nil { composing = false } }
        .onChange(of: model.attachments.count) { _, _ in acceptIncomingAttachments() }
        .onChange(of: model.messages) { _, messages in
            let now = Date.now
            for id in ChatBackgroundJobs.backgroundIDs(messages) where backgroundFirstSeen[id] == nil { backgroundFirstSeen[id] = now }
        }
        .onChange(of: workingActivityObservation, initial: true) { _, value in
            Task {
                await SessionWorkingActivityController.shared.observe(
                    session: session, project: value.project, provider: value.provider,
                    branch: value.branch, activity: value.activity, toolName: value.toolName
                )
            }
        }
        .onDisappear { visible = false; sendTask?.cancel(); historyTask?.cancel(); cleanupTask?.cancel(); model.flushDrafts() }
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
        .sheet(isPresented: $showingAttachments) {
            if let openingTarget = model.target {
                ChatAttachmentPicker(canAdd: model.attachments.count < ChatAttachmentLimit.maximum, add: { item in
                    if model.target == openingTarget { model.add(item) }
                }, context: project == nil ? nil : {
                    Task { try? await Task.sleep(for: .milliseconds(350)); showingContext = true }
                })
            }
        }
        .onChange(of: dictation.transcript) { _, value in
            if dictating, !value.isEmpty { model.draft = dictationPrefix + value }
        }
        .onChange(of: dictation.isRecording) { _, recording in
            // A segment ended by itself: keep what it heard and listen on.
            guard dictating, !recording else { return }
            let spoken = SpeechSettings.apply(dictation.transcript)
            if !spoken.isEmpty { dictationPrefix += spoken + " "; model.draft = dictationPrefix }
            if scenePhase == .active { try? dictation.start() } else { dictating = false }
        }
        .onChange(of: scenePhase) { _, phase in if phase != .active { stopDictation() } }
        .onDisappear { dictationTask?.cancel(); cleanupTask?.cancel(); dictating = false; if dictation.isRecording { dictation.stop() } }
        .sheet(isPresented: $showingUsage) {
            if let usage = model.progress.usage {
                VStack(alignment: .leading, spacing: 16) {
                    HStack {
                        Text("Latest model response").font(.headline)
                        Spacer()
                        Button("Done") { showingUsage = false }
                    }
                    VStack(spacing: 10) {
                        LabeledContent("Total input", value: usage.input.formatted())
                            .accessibilityElement(children: .combine).accessibilityIdentifier("usage-total-input")
                        if let cached = usage.cachedInput, let uncached = usage.uncachedInput {
                            LabeledContent("Reused from cache", value: cached.formatted())
                            LabeledContent("Uncached input", value: uncached.formatted())
                        }
                        Divider()
                        LabeledContent("Output", value: usage.output.formatted())
                            .accessibilityElement(children: .combine).accessibilityIdentifier("usage-output")
                        if let reasoning = usage.reasoningOutput, reasoning > 0 {
                            LabeledContent("Included reasoning", value: reasoning.formatted())
                        }
                    }.font(.subheadline).monospacedDigit()
                    Text("Input includes conversation context, instructions, and tool results. Cached input is part of that total. These are tokens for one model response, not the whole conversation or your account quota.")
                        .font(.footnote).foregroundStyle(PhrenTheme.textMuted)
                }
                .padding(24).foregroundStyle(PhrenTheme.text)
                .presentationDetents([.medium, .large]).presentationDragIndicator(.visible)
                .presentationBackground(PhrenTheme.chatCanvas)
            }
        }
        .sheet(item: $previewImage) { item in
            NavigationStack {
                ChatAttachmentImage(attachment: item.attachment, maximumPixels: 2_048).padding()
                    .navigationTitle(item.attachment.name).navigationBarTitleDisplayMode(.inline)
                    .toolbar { ToolbarItem(placement: .confirmationAction) { Button("Done") { previewImage = nil } } }
            }
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
        .task(id: RunIdentity(active: active, refresh: refresh)) {
            guard active else { return }
            await model.run(session)
        }
    }

    private func openAgentDrawer() {
        withAnimation(reduceMotion ? nil : .easeOut(duration: 0.22)) { showingAgentSwitcher = true }
    }
    private func closeAgentDrawer() {
        withAnimation(reduceMotion ? nil : .easeIn(duration: 0.18)) { showingAgentSwitcher = false }
    }

    private func loadHistoryIfNeeded(_ proxy: ScrollViewProxy) {
        guard active, paginationReady, model.connected, model.hasMore, !model.loadingHistory,
              historyTask == nil, nearHistoryTop,
              let line = model.history.startLine, line > 0, requestedHistoryLine != line else { return }
        requestedHistoryLine = line
        let anchor = ChatTimelineEntry.group(model.messages).first?.id
        let target = model.target
        historyTask = Task {
            await model.loadOlder(session)
            guard !Task.isCancelled, model.target == target else {
                if model.target == target { historyTask = nil; requestedHistoryLine = nil }
                return
            }
            await Task.yield()
            if let anchor {
                var transaction = Transaction(); transaction.disablesAnimations = true
                withTransaction(transaction) { proxy.scrollTo(anchor, anchor: .top) }
            }
            // A page may contain only lifecycle events. Recheck after layout
            // settles so it can continue without another scroll gesture.
            do { try await Task.sleep(for: .milliseconds(100)) } catch {
                if model.target == target { historyTask = nil; requestedHistoryLine = nil }
                return
            }
            guard model.target == target else { return }
            historyTask = nil
            loadHistoryIfNeeded(proxy)
        }
    }

    /// Where this conversation lives, in the terms the person thinks in:
    /// the project, then the model answering and the branch it is on. The
    /// computer is already the session list's business.
    private var chatLocation: String {
        let modelName = model.modelName.map { name in
            name.hasPrefix("claude-") ? String(name.dropFirst("claude-".count)) : name
        }
        let location = session.usesFolderFallback(mappedProject: project?.name)
            ? "~/\(session.projectDisplayName(nil))" : session.projectDisplayName(project?.name)
        return [location, modelName, model.branch].compactMap { $0 }.joined(separator: " · ")
    }

    /// The computer and workspace left the visible line; VoiceOver still
    /// says them, ahead of the project the workspace resolved to.
    private var chatLocationSpoken: String {
        var parts = [session.host.name]
        if project != nil { parts.append(session.workspaceName) }
        parts.append(chatLocation)
        return parts.joined(separator: " · ")
    }

    private var chatHeader: some View {
        HStack(spacing: 10) {
            ChatDismissButton()
            AgentProviderGlyph(source: model.target?.source)
                .overlay(alignment: .bottomTrailing) {
                    ChatActivityIndicator(connected: model.connected && active,
                                          reconnecting: active && model.target != nil && !model.connected && !model.loading && !model.automaticReconnectSuspended,
                                          waiting: model.awaitingReply, revealing: model.reveal.isRevealing,
                                          needsAnswer: model.needsAnswer || model.approval != nil,
                                          phase: model.activityPhase)
                        .padding(1).background(PhrenTheme.chatPanel, in: Circle())
                        .offset(x: 4, y: 4)
                }
                .accessibilityElement(children: .contain)
            VStack(alignment: .leading, spacing: 3) {
                Text(selectedPane?.displayTitle ?? session.projectDisplayName(project?.name))
                    .font(.system(.subheadline, design: .monospaced).weight(.semibold)).lineLimit(1)
                HStack(spacing: 4) {
                    if session.usesFolderFallback(mappedProject: project?.name) { Image(systemName: "folder").font(.caption2) }
                    Text(chatLocation).lineLimit(1)
                    if project == nil, session.tab.cwd != nil {
                        Button("Link to project", systemImage: "link") { assigningProject = true }
                            .labelStyle(.iconOnly).frame(width: 28, height: 24)
                            .accessibilityIdentifier("chat-link-project")
                    }
                }
                    .font(.system(.caption2, design: .monospaced)).foregroundStyle(PhrenTheme.chatNeutral)
                    .accessibilityLabel(chatLocationSpoken).accessibilityIdentifier("chat-location")
            }.frame(maxWidth: .infinity, alignment: .leading)
            if let target = model.target {
                NavigationLink {
                    // Besides the pane's tree: whatever the session's commands
                    // wrote elsewhere — the phren store, a sibling checkout.
                    AgentDiffView(session: session, target: target, paths: Array(Set(model.messages.filter { $0.role == .tool && !$0.isToolResult && !$0.isChange }
                        .flatMap { ToolPresentation(title: $0.title ?? "", text: $0.text).editedPaths }).sorted().prefix(24)))
                } label: {
                    Image(systemName: "arrow.triangle.branch").font(.system(size: 17)).frame(width: 40, height: 44).contentShape(Rectangle())
                        .foregroundStyle(PhrenTheme.chatText)
                }.accessibilityLabel("Repository changes").accessibilityIdentifier("chat-diff")
            }
            chatOptions
        }
        .buttonStyle(.plain).foregroundStyle(PhrenTheme.chatText)
        .padding(.horizontal, 8).padding(.vertical, 8)
        .background(PhrenTheme.chatPanel, in: RoundedRectangle(cornerRadius: 22, style: .continuous))
        .overlay(RoundedRectangle(cornerRadius: 22).strokeBorder(PhrenTheme.borderStrong, lineWidth: 1))
        .padding(.horizontal, 12).padding(.top, 8).padding(.bottom, 4)
        .dynamicTypeSize(...DynamicTypeSize.accessibility1)
        .accessibilityElement(children: .contain).accessibilityIdentifier("chat-header")
    }

    private var chatOptions: some View {
        // Only what has no home elsewhere on this screen: the terminal,
        // repository changes, slash commands, dictation and reconnecting all
        // live in the header, the composer, or the connection notice.
        Menu {
            NavigationLink { HerdrWorkspacesView(hostID: session.host.id) } label: { Label("Herdr workspaces", systemImage: "rectangle.split.3x1") }
            if let project {
                NavigationLink("Project memory") { ProjectDetailView(storeId: project.storeID, project: project.name) }
                NavigationLink("Project skills") { SkillsView(project: project.name, storeId: project.storeID) }
                NavigationLink("Explore graph") { GraphView(focusProject: project.name, initialStoreId: project.storeID) }
            }
            tokenUsage
            if project != nil {
                Button("Add project context", systemImage: "brain") { showingContext = true }
            }
            if model.panes.filter({ (try? $0.target(hostID: session.host.id, workspaceID: session.workspaceID, tabID: session.tab.id, muxID: session.host.muxID)) != nil }).count > 1 {
                Button("Choose another agent") {
                    model.chooseAnother()
                    refresh = UUID()
                }.disabled(model.sending)
            }
        } label: { Image(systemName: "ellipsis").frame(width: 36, height: 44).contentShape(Rectangle()) }
        .accessibilityLabel("Chat options")
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

    @ViewBuilder private var tokenUsage: some View {
        if let usage = model.progress.usage {
            Button { showingUsage = true } label: {
                Label("Token usage", systemImage: "chart.bar")
            }.accessibilityIdentifier("chat-token-usage").accessibilityLabel("Latest reported usage: \(usage.output) output tokens, \(usage.input) input tokens")
        } else if model.progressUnavailable {
            Menu {
                Link("Set up token counts on this computer", destination: URL(string: "https://github.com/alaarab/phren/blob/main/apps/ios/README.md#live-token-counts")!)
            } label: {
                Text("Tokens unavailable").font(.caption2).foregroundStyle(PhrenTheme.textMuted)
            }
        }
    }

    private var composer: some View {
        VStack(alignment: .leading, spacing: 6) {
            if !model.attachments.isEmpty {
                ScrollView(.horizontal) {
                    HStack(spacing: 10) {
                        ForEach(model.attachments) { item in
                            VStack(spacing: 4) {
                                HStack(spacing: 6) {
                                    Button { if item.attachment.isImage { previewImage = item } } label: {
                                        if item.attachment.isImage {
                                            ChatAttachmentImage(attachment: item.attachment, maximumPixels: 168).frame(width: 56, height: 56).clipped().clipShape(RoundedRectangle(cornerRadius: 10))
                                        } else { Image(systemName: "doc").frame(width: 56, height: 56) }
                                    }.accessibilityLabel("Preview \(item.attachment.name)")
                                    Button {
                                        model.attachments.removeAll { $0.id == item.id }
                                    } label: { Image(systemName: "xmark.circle.fill").font(.system(size: 20)).frame(width: 44, height: 44) }
                                        .disabled(model.sending).accessibilityLabel("Remove \(item.attachment.name)")
                                }
                                Text(item.attachment.name).font(.caption).lineLimit(1).frame(maxWidth: 120)
                            }.padding(8).background(PhrenTheme.surface, in: RoundedRectangle(cornerRadius: 14))
                        }
                    }
                }.accessibilityIdentifier("chat-attachments")
            }

            if composing, AgentSlashCommand.isCommand(model.draft) {
                SlashCommandMenu(source: model.target?.source ?? "", draft: model.draft,
                                 choose: { model.draft = $0 + " " }, openAll: openCommandMenu)
            }
            if model.needsAnswer && model.approval == nil {
                NavigationLink { HerdrTerminalView(host: session.host, session: session, target: model.target) } label: {
                    Label(model.question != nil ? "Or answer in Herdr" : "Answer in Herdr terminal", systemImage: "terminal")
                        .font(.caption).foregroundStyle(PhrenTheme.warning)
                }.accessibilityIdentifier("chat-answer-terminal")
            }
            if let error = model.deliveryError { Text(error).font(.caption).foregroundStyle(PhrenTheme.warning).accessibilityIdentifier("chat-delivery-error") }
            if let error = model.draftStorageError { Text(error).font(.caption).foregroundStyle(PhrenTheme.warning).accessibilityIdentifier("chat-draft-storage-error") }
            VStack(spacing: 0) {
                TextField("Message \(model.target?.providerName ?? "agent")…", text: $model.draft, axis: .vertical)
                    .autocorrectionDisabled(!ChatSettings.autocorrects)
                    .lineLimit(1...4).focused($composing).font(.system(size: composerTextSize, design: .monospaced))
                    .tint(PhrenTheme.cyan).padding(.vertical, 8).padding(.horizontal, 12)
                    .frame(maxWidth: .infinity, minHeight: 36, alignment: .leading)
                    .contentShape(Rectangle())
                    .dismissKeyboardOnDownwardDrag { composing = false }
                    .accessibilityIdentifier("chat-composer").disabled(model.target == nil)
                HStack(alignment: .bottom, spacing: 4) {
                    Button { showingAttachments = true } label: {
                        Image(systemName: "plus").font(.system(size: 21, weight: .light)).frame(width: 36, height: 44).contentShape(Rectangle())
                    }.accessibilityLabel("Add attachment").disabled(model.target == nil || model.sending)
                    NavigationLink {
                        HerdrTerminalView(host: session.host, session: session, target: model.target)
                    } label: {
                        Image(systemName: "terminal").font(.system(size: 18)).frame(width: 44, height: 44).contentShape(Rectangle())
                    }.accessibilityLabel("Open Herdr terminal").accessibilityIdentifier("chat-composer-terminal")
                        .disabled(model.target == nil)
                    Button { composing = false; showingAgentSwitcher = true } label: {
                        Image(systemName: "person.2")
                            .font(.system(size: 18)).frame(width: 40, height: 44).contentShape(Rectangle())
                    }.accessibilityLabel("Switch agent").accessibilityIdentifier("chat-switch-agent")
                        .disabled(model.sending || model.answering || model.stopping)
                    Spacer(minLength: 4)
                    Button {
                        if dictating { stopDictation() } else { startDictation() }
                    } label: {
                        Image(systemName: dictating ? "mic.fill" : "mic").font(.system(size: 20))
                            .foregroundStyle(dictating ? PhrenTheme.accent : PhrenTheme.chatText)
                            .scaleEffect(dictating ? 1 + CGFloat(dictation.audioLevel) * 0.25 : 1)
                            .animation(.easeOut(duration: 0.12), value: dictation.audioLevel)
                            .frame(width: 40, height: 44).contentShape(Rectangle())
                    }.accessibilityLabel(dictating ? "Stop dictation" : "Dictate message")
                        .accessibilityIdentifier("chat-dictate")
                        .disabled(model.target == nil || model.sending)
                    Button {
                        composing = false
                        if showsStop {
                            sendTask = Task { await model.stop(session) }
                        } else if model.draft.trimmingCharacters(in: .whitespacesAndNewlines) == "/", model.attachments.isEmpty {
                            openCommandMenu()
                        } else {
                            let isCommand = AgentSlashCommand.isCommand(model.draft), pane = model.target?.paneID
                            let donatedMessage = model.draft
                            sendTask = Task {
                                await model.send(session)
                                if model.deliveryError == nil, !isCommand { PhrenAppShortcuts.donateMessage(donatedMessage, to: session) }
                                if isCommand, model.deliveryError == nil, let pane {
                                    commandDestination = .init(paneID: pane, menu: false)
                                    // /new, /clear and /resume may change the session ID.
                                    model.chooseAnother()
                                }
                            }
                        }
                    } label: {
                        Group {
                            if model.sending || model.stopping { ProgressView().tint(PhrenTheme.chatPanel) }
                            else { Image(systemName: showsStop ? "stop.fill" : showsQueue ? "text.append" : "arrow.up").font(.system(size: showsStop ? 13 : showsQueue ? 17 : 19, weight: .semibold)) }
                        }
                        .frame(width: 36, height: 36)
                        .foregroundStyle(primaryActionEnabled ? PhrenTheme.chatPanel : PhrenTheme.textDim)
                        .background(primaryActionEnabled ? PhrenTheme.cyan : PhrenTheme.borderStrong, in: Circle())
                        .frame(width: 44, height: 44).contentShape(Rectangle())
                    }
                    .disabled(!primaryActionEnabled)
                    .accessibilityLabel(showsStop ? "Stop" : showsQueue ? "Queue message" : "Send message")
                    .accessibilityIdentifier(showsStop ? "chat-stop" : showsQueue ? "chat-queue" : "chat-send")
                    .accessibilityValue(model.deliveryStatus ?? "")
                    .keyboardShortcut(.return, modifiers: .command)
                }
                .padding(.horizontal, 6).padding(.bottom, 4)
                .contentShape(Rectangle())
                .dismissKeyboardOnDownwardDrag { composing = false }
            }
            .padding(.top, 2)
            .background(PhrenTheme.chatPanel, in: RoundedRectangle(cornerRadius: 22))
            .overlay { RoundedRectangle(cornerRadius: 22).strokeBorder(PhrenTheme.border, lineWidth: 0.5) }
            .accessibilityElement(children: .contain)
            .accessibilityIdentifier("chat-message-box")
            .disabled(model.restoringDraft)
        }
        .buttonStyle(.plain).foregroundStyle(PhrenTheme.chatText)
        .padding(.horizontal, 10).padding(.top, 6).padding(.bottom, 8)
        .background(PhrenTheme.chatCanvas.ignoresSafeArea(.container, edges: .bottom))
    }
    private struct CommandDestination: Hashable { let paneID: String; let menu: Bool }
    private func openCommandMenu() {
        guard let target = model.target else { return }
        composing = false
        commandDestination = .init(paneID: target.paneID, menu: true)
    }
    private struct RunIdentity: Equatable { let active: Bool; let refresh: UUID }
    private var showsStop: Bool {
        model.isBusy && model.draft.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty && model.attachments.isEmpty
    }
    /// A message typed while the agent is busy joins the queue instead of
    /// interrupting; the control says so.
    private var showsQueue: Bool {
        model.isBusy && !showsStop && !AgentSlashCommand.isCommand(model.draft)
    }

    /// Claude Code's queue, on a phone: each waiting message with Send now
    /// (steer), Edit (back into the composer), and remove.
    private var queuedMessages: some View {
        VStack(alignment: .leading, spacing: 6) {
            Text("Queued · \(model.queue.count)").font(.caption.weight(.semibold)).foregroundStyle(PhrenTheme.chatNeutral)
                .padding(.leading, 4)
            ForEach(model.queue) { item in
                HStack(alignment: .top, spacing: 8) {
                    Image(systemName: "clock").font(.system(size: 12)).foregroundStyle(PhrenTheme.chatNeutralDim).padding(.top, 3)
                    VStack(alignment: .leading, spacing: 4) {
                        Text(item.text).font(.system(size: 14, design: .monospaced)).foregroundStyle(PhrenTheme.chatText).lineLimit(3)
                        if !item.attachments.isEmpty {
                            Text("\(item.attachments.count) attachment\(item.attachments.count == 1 ? "" : "s")")
                                .font(.caption2).foregroundStyle(PhrenTheme.chatNeutralDim)
                        }
                    }.frame(maxWidth: .infinity, alignment: .leading)
                    HStack(spacing: 0) {
                        Button { sendTask = Task { await model.sendNow(item, session) } } label: {
                            Image(systemName: "arrow.up.circle").frame(width: 36, height: 36).contentShape(Rectangle())
                        }.accessibilityLabel("Send now").accessibilityIdentifier("chat-queued-send:\(item.id)")
                            .disabled(!active || !model.connected || model.sending)
                        Button { model.edit(item); composing = true } label: {
                            Image(systemName: "pencil").frame(width: 36, height: 36).contentShape(Rectangle())
                        }.accessibilityLabel("Edit").accessibilityIdentifier("chat-queued-edit:\(item.id)")
                        Button { model.remove(item) } label: {
                            Image(systemName: "xmark").frame(width: 36, height: 36).contentShape(Rectangle())
                        }.accessibilityLabel("Remove from queue").accessibilityIdentifier("chat-queued-remove:\(item.id)")
                    }.font(.system(size: 15)).foregroundStyle(PhrenTheme.chatNeutral).buttonStyle(.plain)
                }
                .padding(.leading, 12).padding(.trailing, 4).padding(.vertical, 6)
                .background(PhrenTheme.chatUserBubble, in: RoundedRectangle(cornerRadius: 16, style: .continuous))
                .overlay(RoundedRectangle(cornerRadius: 16, style: .continuous).strokeBorder(PhrenTheme.border, style: StrokeStyle(lineWidth: 1, dash: [4, 3])))
                .accessibilityElement(children: .contain)
                .accessibilityIdentifier("chat-queued:\(item.id)")
            }
        }
        .accessibilityIdentifier("chat-queue")
    }
    private var primaryActionEnabled: Bool {
        showsStop ? active && model.connected && !model.sending && !model.stopping && !model.answering : canSend
    }
    private var canSend: Bool {
        active && model.connected && !model.sending && !model.stopping && !model.answering && !model.needsAnswer && model.approval == nil
            && (!model.draft.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || !model.attachments.isEmpty)
    }
}

private struct ChatBottomPosition: PreferenceKey {
    static let defaultValue: CGFloat = 0
    static func reduce(value: inout CGFloat, nextValue: () -> CGFloat) { value = nextValue() }
}

private struct ChatMessageRow<Historical: View>: View {
    let message: AgentChatMessage
    var revealedText: String? = nil
    let images: [ChatAttachmentDraft]
    let preview: (ChatAttachmentDraft) -> Void
    @ViewBuilder let historical: () -> Historical
    /// The pictures the transcript itself carries. When there are any, the
    /// local previews of the same send would only draw them twice.
    private var inlineImages: Bool { !message.imageBlocks.isEmpty }
    private var displayText: String {
        if let revealedText { return revealedText }
        var text = message.text
        let marker = "\n\nAttached files on this computer:\n"
        if let section = text.range(of: marker, options: .backwards) {
            let paths = text[section.upperBound...].components(separatedBy: "\n")
            let previewPaths = Set(images.compactMap(\.path))
            // Hide our attachment suffix once pictures replace it: local
            // previews of every listed path, or the transcript's own images.
            if inlineImages || (!images.isEmpty && paths.allSatisfy({ previewPaths.contains($0) })) {
                text = String(text[..<section.lowerBound])
            }
        }
        if inlineImages {
            // Claude Code's paste markers and Codex's placeholders name
            // pictures that now sit above the words.
            text = text.replacingOccurrences(of: #"\[Image #\d+\]|\[Image attachment\]"#, with: "", options: .regularExpression)
                .trimmingCharacters(in: .whitespacesAndNewlines)
        }
        return text
    }
    var body: some View {
        if let command = message.localCommand {
            LocalCommandRow(command: command, id: message.id)
        } else {
            bubble
        }
    }
    private var bubble: some View {
        HStack(alignment: .top, spacing: 0) {
            if message.role == .user { Spacer(minLength: 30) }
            VStack(alignment: .leading, spacing: 8) {
                if !inlineImages {
                    ForEach(images) { item in
                        Button { preview(item) } label: {
                            ChatAttachmentImage(attachment: item.attachment).frame(maxHeight: 220).clipShape(RoundedRectangle(cornerRadius: 12))
                        }.accessibilityLabel("View attached \(item.attachment.name)")
                    }
                }
                historical()
                let text = displayText
                if !text.isEmpty && !(text == "[Image attachment]" && !message.imageBlocks.isEmpty) { ChatRichText(text: text).equatable() }
                if revealedText != nil {
                    Capsule().fill(PhrenTheme.chatText).frame(width: 4, height: 13).accessibilityHidden(true)
                }
            }
            .padding(message.role == .user ? 14 : 0)
            .frame(maxWidth: .infinity, alignment: .leading)
            .background(message.role == .user ? PhrenTheme.chatUserBubble : .clear, in: RoundedRectangle(cornerRadius: 20, style: .continuous))
        }
        .accessibilityElement(children: .contain)
        .accessibilityLabel(message.role == .user ? "Your message" : "Agent reply")
        .accessibilityIdentifier("chat-message:\(message.id)")
        .contextMenu {
            Button("Copy message", systemImage: "doc.on.doc") { UIPasteboard.general.string = message.text }
            ShareLink(item: message.text)
        }
    }
}

/// A slash command or `!` shell line typed at the agent's own prompt, and
/// what it printed: system text inline, not a bubble of angle brackets.
private struct LocalCommandRow: View {
    let command: AgentChatMessage.LocalCommand
    let id: String
    var body: some View {
        if command.kind == .output && command.text.isEmpty {
            EmptyView()
        } else {
            HStack(alignment: .firstTextBaseline, spacing: 8) {
                Group {
                    switch command.kind {
                    case .command: Image(systemName: "command")
                    case .shell: Image(systemName: "terminal")
                    case .output: Image(systemName: "arrow.turn.down.right")
                    }
                }
                .font(.system(size: 10, weight: .semibold)).foregroundStyle(PhrenTheme.chatNeutralDim).frame(width: 14)
                .accessibilityHidden(true)
                Text(command.text)
                    .font(.system(.caption, design: .monospaced))
                    .foregroundStyle(command.kind == .output ? PhrenTheme.textMuted : PhrenTheme.textSecondary)
                    .textSelection(.enabled)
                    .lineLimit(command.kind == .output ? 12 : nil)
                    .frame(maxWidth: .infinity, alignment: .leading)
            }
            .padding(.vertical, 2)
            .accessibilityElement(children: .combine)
            .accessibilityLabel(command.kind == .output ? "Command output: \(command.text)" : "Command: \(command.text)")
            .accessibilityIdentifier("chat-command:\(id)")
            .contextMenu { Button("Copy", systemImage: "doc.on.doc") { UIPasteboard.general.string = command.text } }
        }
    }
}

private struct ChatHistoryPosition: PreferenceKey {
    static var defaultValue: CGFloat = -CGFloat.greatestFiniteMagnitude
    static func reduce(value: inout CGFloat, nextValue: () -> CGFloat) { value = nextValue() }
}

/// The presenter's dismiss action can change during its one-second status
/// refresh. Keep that dependency out of the transcript and its open menus.
private struct ChatDismissButton: View {
    @Environment(\.dismiss) private var dismiss
    var body: some View {
        Button { dismiss() } label: {
            Image(systemName: "chevron.left").font(.system(size: 18, weight: .medium)).frame(width: 36, height: 44).contentShape(Rectangle())
        }.accessibilityLabel("Back").accessibilityIdentifier("chat-close")
    }
}

private struct ChatHistoryScrollObserver: ViewModifier {
    let changed: (Bool) -> Void
    func body(content: Content) -> some View {
        if #available(iOS 18.0, *) {
            content.onScrollGeometryChange(for: Bool.self) { geometry in
                geometry.contentOffset.y + geometry.contentInsets.top < 140
            } action: { _, near in changed(near) }
        } else {
            content.onPreferenceChange(ChatHistoryPosition.self) { position in changed(position >= -140) }
        }
    }
}
