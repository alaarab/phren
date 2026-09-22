import PhrenKit
import PhrenLive
import SwiftUI
import UIKit

/// Every agent opens in Phren with its exact computer and conversation.
struct AgentConversationLink<LabelContent: View>: View {
    let session: LiveAgentSession
    var onOpenInPhren: (() -> Void)? = nil
    @ViewBuilder var label: LabelContent

    var body: some View {
        Group {
            if let onOpenInPhren {
                Button {
                    PhrenAppShortcuts.donateOpen(session)
                    onOpenInPhren()
                } label: { label }
            } else {
                NavigationLink {
                    AgentSessionDestination(session: session).onAppear { PhrenAppShortcuts.donateOpen(session) }
                } label: { label }
            }
        }
    }
}

struct AgentSessionDestination: View {
    let session: LiveAgentSession
    var body: some View {
        if ChatSettings.opensInTerminal { HerdrTerminalView(host: session.host, session: session) }
        else { AgentChatSheet(session: session) }
    }
}

struct AgentChildRequest: Equatable {
    let session: LiveAgentSession
    let target: AgentChatTarget
    let agent: AgentChild
}

struct AgentChatSheet: View {
    @State private var session: LiveAgentSession
    @State private var incomingAttachments: [AgentAttachment]
    @State private var incomingDraft: String
    @State private var requestedChild: AgentChildRequest?
    private let initialSessionID: LiveAgentSession.ID
    private let initialPane: AgentChatPanes.Pane?
    private let initialTarget: AgentChatTarget?
    private let startsDictation: Bool
    init(session: LiveAgentSession, initialPane: AgentChatPanes.Pane? = nil,
         initialTarget: AgentChatTarget? = nil,
         attachments: [AgentAttachment] = [], draft: String = "", startsDictation: Bool = false,
         initialChild: AgentChildRequest? = nil) {
        _session = State(initialValue: session)
        _incomingAttachments = State(initialValue: attachments)
        _incomingDraft = State(initialValue: draft)
        _requestedChild = State(initialValue: initialChild)
        initialSessionID = session.id
        self.initialPane = initialPane
        self.initialTarget = initialTarget
        self.startsDictation = startsDictation
    }
    var body: some View {
        AgentChatView(session: session, switchSession: { session = $0 },
                      initialPane: session.id == initialSessionID ? initialPane : nil,
                      initialTarget: session.id == initialSessionID ? initialTarget : nil,
                      incomingAttachments: $incomingAttachments, incomingDraft: $incomingDraft,
                      requestedChild: $requestedChild,
                      startsDictation: startsDictation && session.id == initialSessionID).id(session.id)
    }
}

private struct ChatHistoryStalledNotice: View {
    let since: Date?
    let newThread: () -> Void

    var body: some View {
        TimelineView(.periodic(from: .now, by: 60)) { context in
            HStack(spacing: 8) {
                Image(systemName: "exclamationmark.triangle.fill")
                Text("Codex stopped recording this thread \(since.map { SessionRelativeTime.text(since: $0, at: context.date) } ?? "recently"). Start a new one to keep following it.")
                    .font(.footnote)
                Spacer(minLength: 4)
                Button("New thread", action: newThread).font(.footnote.weight(.semibold)).fixedSize()
            }
            .foregroundStyle(PhrenTheme.warning)
            .padding(10)
            .background(PhrenTheme.warning.opacity(0.14), in: RoundedRectangle(cornerRadius: 10))
            .padding(.horizontal, 12).padding(.top, 6)
            .accessibilityElement(children: .contain)
            .accessibilityIdentifier("chat-history-stalled")
        }
    }
}

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
    @Binding fileprivate var requestedChild: AgentChildRequest?
    /// Opened by the Action button: start listening as soon as the chat is up.
    var startsDictation = false
    @State private var indexedCode: SessionCodeContext?
    @State private var initialized = false
    @State private var queueHeight: CGFloat = 0
    @State private var messageMenu = ChatMessageMenu()
    private struct ChatQueueHeight: PreferenceKey {
        static let defaultValue: CGFloat = 0
        static func reduce(value: inout CGFloat, nextValue: () -> CGFloat) { value = max(value, nextValue()) }
    }
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
    @State private var dictation = DictationSession(recognizer: SpeechTranscriber(), transform: SpeechSettings.apply)
    @State private var dictationBase = ""
    @State private var dictationTask: Task<Void, Never>?
    @State private var cleanupTask: Task<Void, Never>?
    @State private var dictationPreview: DictationCleanupPreview?
    private var dictating: Bool { dictation.isRecording }
    @State private var showingAgentSwitcher = false
    @State private var launchingNewThread = false
    @State private var showingUsage = false
    @State private var showingOptions = false
    @State private var showingModelPicker = false
    @State private var showingSecret = false
    /// The fallback key strip stays collapsed behind the Keys chip.
    @State private var answerKeysExpanded = false
    @State private var menuCommand: ChatMenuCommand?
    @State private var showingChildAgents = false
    @State private var childAgents: [AgentChild] = []
    @State private var openedChild: AgentWorkNavigation?
    @State private var previewImage: ChatAttachmentDraft?
    @State private var assigningProject = false
    @State private var fullDiff: ChatFullDiff?
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
    @ScaledMetric(relativeTo: .body) private var composerTextSize = 14.0
    @FocusState private var composing: Bool
    /// The one paragraph showing native text selection, if any.
    @State private var textSelection = ChatTextSelection()

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
            dictation.readDraft = { [model] in model.draft }
            dictation.onDraftChange = { [model] in model.draft = $0 }
            dictation.onFailure = { [model] in model.deliveryError = $0 }
            model.deliveryError = nil
            dictation.start(draft: model.draft)
        }
    }
    private func restartDictationSegment() {
        dictationBase = ""
        dictationPreview = nil
        // The send cleared the composer; reattach the draft binding before the
        // fresh segment starts so its first partial lands in the model again.
        dictation.readDraft = { [model] in model.draft }
        dictation.onDraftChange = { [model] in model.draft = $0 }
        dictation.onFailure = { [model] in model.deliveryError = $0 }
        dictation.send()
    }
    /// Stops and preserves the raw words in the draft. When opted in, Apple
    /// Intelligence prepares a candidate that remains separate until chosen.
    private func stopDictation() {
        guard dictating else { return }
        dictation.stop()
        model.draft = model.draft.trimmingCharacters(in: .whitespaces)
        let rawDraft = model.draft
        let base = dictationBase
        let rawInstruction = rawDraft.hasPrefix(base)
            ? String(rawDraft.dropFirst(base.count)) : rawDraft
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
                    tightenedDraft: base.trimmingCharacters(in: .whitespaces).isEmpty
                        ? tightened : base + tightened,
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
    private var selectedPane: AgentChatPanes.Pane? { model.panes.first { $0.id == model.target?.paneID } }
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
        chatSheets(content).modifier(ChatMessageMenuPresenter(menu: messageMenu))
    } }
    private var content: some View {
        VStack(spacing: 0) {
            chatHeader

            ScrollViewReader { proxy in
                ScrollView {
                    VStack(spacing: 0) {
                        VStack(alignment: .leading, spacing: 12) {
                            if model.target == nil && !model.loading { panePicker }
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
                            if let preview = model.replyPreview {
                                ChatReplyPreviewRow(preview: preview)
                            }
                            if model.target?.isStarting == true {
                                Text("Starting \(model.target?.providerName ?? "agent") in \(session.projectDisplayName(project?.name))…")
                                    .foregroundStyle(PhrenTheme.textMuted).padding(.top, 24)
                                    .accessibilityIdentifier("chat-starting")
                            } else if model.connected && model.messages.isEmpty {
                                Text("Ready for your message.").foregroundStyle(PhrenTheme.textMuted).padding(.top, 24)
                            }
                        }
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
                .simultaneousGesture(TapGesture().onEnded { composing = false; textSelection.transcriptTapped() })
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
                .scrollDismissesKeyboard(.interactively)
                .coordinateSpace(name: "chat-scroll")
                .background(GeometryReader { geometry in
                    Color.clear.onAppear { scrollHeight = geometry.size.height }
                        .onChange(of: geometry.size.height) { _, height in
                            guard abs(height - scrollHeight) > 0.5 else { return }
                            scrollHeight = height
                        }
                })
                .modifier(ChatFollowScroll(viewport: scrollHeight, contentHeight: transcriptContentHeight,
                                           following: atBottom, pinRequest: scrollPinRequest) { _, new, userDriven in
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
            if let approval = model.approval, let prompt = approval.questionPrompt, let input = approval.questionInput {
                // Claude Code asks through a permission request: answer it with
                // the request's own input plus the answers; Skip denies.
                ChatQuestionCard(prompt: prompt, busy: model.answering || !active || !model.interactionConnected,
                                 title: "\(model.target?.providerName ?? "Claude") has a question", allowsTyping: true,
                                 skip: { sendTask = Task { await model.answer(session, approval: approval, approve: false) } }) { answers in
                    guard let updated = try? prompt.answeredInput(input, answers: answers) else { return }
                    sendTask = Task { await model.answer(session, approval: approval, decision: .approve, updatedInput: updated) }
                }
                .id(approval.id)
                .padding(.horizontal, 12).padding(.vertical, 6)
            } else if let approval = model.approval, let plan = approval.plan {
                // Claude Code's plan review is a permission request for
                // ExitPlanMode: Approve plan builds it, Keep planning denies.
                ChatPlanApprovalCard(plan: plan, id: approval.id, busy: model.answering || !active || !model.interactionConnected) { approve in
                    sendTask = Task { await model.answer(session, approval: approval, decision: approve ? .approve : .deny) }
                }
                .id(approval.id)
                .padding(.horizontal, 12).padding(.vertical, 6)
            } else if let approval = model.approval {
                ChatApprovalQuestionCard(approval: approval, providerName: model.target?.providerName ?? "Agent",
                    busy: model.answering || !active || !model.interactionConnected,
                    terminal: AnyView(answerTerminalLink.accessibilityIdentifier("chat-approval-terminal")),
                    answerKey: { key in sendTask = Task { await model.answer(session, key: key) } }) { decision in
                    sendTask = Task { await model.answer(session, approval: approval, decision: decision) }
                }
                .id(approval.id)
                .padding(.horizontal, 12).padding(.vertical, 6)
            }
            if model.approval == nil, let prompt = model.question, model.terminalPrompt?.questionPrompt == nil {
                if model.canAnswerQuestion {
                    ChatQuestionCard(prompt: prompt, busy: model.answering || !active || !model.connected,
                                     title: "\(model.target?.providerName ?? "Agent") has a question", allowsTyping: prompt.isAsync == true) { answers in
                        sendTask = Task { await model.answer(session, question: prompt, answers: answers) }
                    }.id(prompt.id).padding(.horizontal, 12).padding(.vertical, 6)
                } else {
                    ChatPendingQuestionCard(prompt: prompt, count: model.pendingQuestionCount) {
                        NavigationLink { HerdrTerminalView(host: session.host, session: session, target: model.target) } label: {
                            Label("Answer in terminal", systemImage: "terminal").frame(maxWidth: .infinity, minHeight: 32)
                        }.accessibilityIdentifier("chat-question-terminal")
                    }.padding(.horizontal, 12).padding(.vertical, 6)
                }
            }
            if !model.backgroundJobs.isEmpty {
                ChatBackgroundJobsView(jobs: model.backgroundJobs)
            }
            // Readiness holds stay above the input until the harness can receive them.
            if !model.localPendingMessages.isEmpty {
                // Exactly as tall as its rows, and a scroller only once they
                // pass the cap. (`frame(maxHeight:)` around a ViewThatFits
                // stretched to the cap and centred the rows in it — the hole
                // above the steer; a ScrollView that is always there clips
                // rows the measurement has not caught up with.)
                let rows = queuedMessages.padding(.horizontal, 12)
                    .background(GeometryReader { geometry in
                        Color.clear.preference(key: ChatQueueHeight.self, value: geometry.size.height)
                    })
                Group {
                    if queueHeight > 190 { ScrollView { rows }.frame(height: 190) } else { rows }
                }
                .onPreferenceChange(ChatQueueHeight.self) { queueHeight = $0 }
                .padding(.bottom, 2)
            }
            if let preview = dictationPreview {
                DictationCleanupPreviewCard(
                    preview: preview,
                    useTightened: { resolveDictationPreview(useTightened: true) },
                    keepOriginal: { resolveDictationPreview(useTightened: false) }
                )
                .padding(.horizontal, 12).padding(.top, 6)
            }
            if model.historyStalled {
                ChatHistoryStalledNotice(since: model.historyStalledSince) { launchingNewThread = true }
                    .disabled(project == nil)
            }
            composer
                .dynamicTypeSize(...DynamicTypeSize.accessibility1)
        }
        .background(PhrenTheme.chatCanvas)
        .confirmsWebLinks()
        .environment(\.openChatDiff) { fullDiff = $0 }
        .environment(\.openToolOutput) { fullToolOutput = $0 }
        .environment(\.chatChildAgents, model.target.flatMap { target in childAgents.isEmpty ? nil : ChatChildAgents(session: session, target: target, agents: childAgents) })
        .environment(textSelection)
        .onChange(of: messageMenu.request?.id) { _, id in
            if id != nil { composing = false; textSelection.end() }
        }
        #if DEBUG && targetEnvironment(simulator)
        .overlay(alignment: .topLeading) { if AgentChatFixture.enabled { ChatFixtureReport() } }
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
        .navigationDestination(item: $fullToolOutput) { FullToolOutputView(output: $0) }
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
    }

    /// Every sheet this screen can present. UIKit restores the stack's bar
    /// when one goes away; dismissing any of them must re-hide it.
    private var anySheetPresented: Bool {
        showingAttachments || showingOptions || launchingNewThread || menuCommand != nil
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
        .sheet(isPresented: $showingAttachments) {
            if let openingTarget = model.target {
                ChatAttachmentPicker(canAdd: model.attachments.count < ChatAttachmentLimit.maximum, add: { item in
                    if model.target == openingTarget { model.add(item) }
                }, context: project == nil ? nil : {
                    Task { try? await Task.sleep(for: .milliseconds(350)); showingContext = true }
                })
            }
        }
        .onChange(of: scenePhase) { _, phase in if phase != .active { stopDictation() } }
        .onDisappear {
            dictationTask?.cancel(); cleanupTask?.cancel()
            dictation.stop()
        }
        .sheet(isPresented: $showingOptions) { chatOptionsSheet }
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
            ChatModelPickerSheet(source: model.target?.source ?? "", current: model.modelName, host: session.host) { command in
                showingModelPicker = false
                model.draft = command
                sendDraft(handoffCommands: false)
            }
        }
        .sheet(isPresented: $showingUsage) { usageSheet }
        .sheet(isPresented: $showingSecret) { ChatSecretSheet(model: model, session: session) }
        .sheet(isPresented: $showingChildAgents) {
            if let target = model.target { ChatSubagentsView(session: session, target: target, agents: childAgents) }
        }
        .sheet(item: $previewImage) { item in
            PhrenImageViewer(attachment: item.attachment)
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
            let computers = AgentChild.runningRows(childAgents).compactMap { $0.agent.computer?.name }
            await SessionWorkingActivityController.shared.observeSubagents(
                session: session, count: runningChildAgentCount, computers: computers)
        } catch {}
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

    /// The tab's panes when no conversation is open yet: agents to chat with,
    /// shells to open as terminals.
    @ViewBuilder private var panePicker: some View {
        Text(hasAgentPanes ? "Choose an agent" : "No agent in this tab").font(.title2.weight(.semibold))
        ForEach(model.panes) { pane in
            if isAgent(pane) {
                Button {
                    model.choose(pane, session: session); refresh = UUID()
                } label: {
                    HStack { VStack(alignment: .leading) { Text(pane.displayTitle); Text(pane.agent ?? "").font(.caption) }; Spacer(); Image(systemName: "chevron.right") }
                        .padding(16).phrenCard()
                }.buttonStyle(.plain).accessibilityIdentifier("chat-pane:\(pane.id)")
            } else {
                Button { commandDestination = .init(paneID: pane.id, menu: false) } label: {
                    HStack { VStack(alignment: .leading) { Text(pane.displayTitle); Text("Open terminal").font(.caption) }; Spacer(); Image(systemName: "terminal") }
                        .padding(16).phrenCard()
                }.buttonStyle(.plain).accessibilityIdentifier("chat-terminal-pane:\(pane.id)")
            }
        }
        Text(hasAgentPanes ? "Native chat supports Codex, Claude Code, and GitHub Copilot sessions recognized on this computer."
             : "Start Codex, Claude Code, or GitHub Copilot in the terminal and chat picks it up here.")
            .font(.footnote).foregroundStyle(PhrenTheme.textMuted)
        if model.panes.contains(where: { $0.agent == "copilot" }) {
            Link("Set up Copilot chat", destination: URL(string: "https://alaarab.github.io/phren/phren-hook.html")!)
                .font(.footnote)
        }
    }

    /// Token counts for the latest model response.
    @ViewBuilder private var usageSheet: some View {
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
            // Pinned to the top: a medium sheet otherwise floats the counts in its middle.
            .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
            .padding(24).foregroundStyle(PhrenTheme.text)
            .presentationDetents([.medium, .large]).presentationDragIndicator(.visible)
            .presentationBackground(PhrenTheme.chatCanvas)
        }
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
            guard scrollMetrics.bottomOffset > 0.5 else { return }
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

    /// Where this conversation lives, in the terms the person thinks in:
    /// the project, then the model answering and the branch it is on. The
    /// computer is already the session list's business.
    private var chatLocation: String {
        [chatLocationProject, chatLocationTail].filter { !$0.isEmpty }.joined(separator: " · ")
    }

    /// The project part of the location line, drawn in the project's own colour.
    private var chatLocationProject: String {
        session.usesFolderFallback(mappedProject: project?.name)
            ? "~/\(session.projectDisplayName(nil))" : session.projectDisplayName(project?.name)
    }

    /// The model and branch after the project name.
    private var chatLocationTail: String {
        let modelName = model.modelName.map { name in
            name.hasPrefix("claude-") ? String(name.dropFirst("claude-".count)) : name
        }
        return [modelName, model.branch].compactMap { $0 }.joined(separator: " · ")
    }

    private var chatLocationColor: Color {
        guard !session.usesFolderFallback(mappedProject: project?.name), let project = project else { return PhrenTheme.chatNeutral }
        return PhrenTheme.projectColor(storeId: project.storeID, project: project.name)
    }

    /// The computer and workspace left the visible line; VoiceOver still
    /// says them, ahead of the project the workspace resolved to.
    private var chatLocationSpoken: String {
        var parts = [session.host.name]
        if project != nil { parts.append(session.workspaceName) }
        parts.append(chatLocation)
        return parts.joined(separator: " · ")
    }

    private var runningChildAgentCount: Int { childAgents.reduce(0) { $0 + $1.runningCount } }

    private var chatHeader: some View {
        HStack(spacing: 10) {
            ChatDismissButton()
            Group {
                if session.tab.isConductor {
                    Image(systemName: "wand.and.rays")
                        .font(.system(size: 20, weight: .semibold))
                        .foregroundStyle(PhrenTheme.accent)
                        .accessibilityLabel("Conductor")
                        .accessibilityIdentifier("chat-conductor-mark")
                } else {
                    AgentProviderGlyph(source: model.target?.source, size: 22)
                }
            }
                .frame(width: 22, height: 22)
                .overlay(alignment: .bottomTrailing) {
                    ChatActivityIndicator(connected: model.connected && active,
                                          reconnecting: active && model.target != nil && !model.connected && !model.loading && !model.automaticReconnectSuspended,
                                          waiting: model.awaitingReply, revealing: model.reveal.isRevealing,
                                          needsAnswer: model.needsAnswer || model.approval != nil,
                                          compacting: model.isCompacting,
                                          phase: model.activityPhase)
                        .padding(1).background(PhrenTheme.chatPanel, in: Circle())
                        .offset(x: 4, y: 4)
                }
                .accessibilityElement(children: .contain)
            VStack(alignment: .leading, spacing: 2) {
                HStack(spacing: 4) {
                    if session.tab.isConductor {
                        Text("Conductor").foregroundStyle(PhrenTheme.accent)
                        Text("·")
                    }
                    Text(selectedPane?.displayTitle ?? session.projectDisplayName(project?.name))
                        .foregroundStyle(selectedPane == nil && project != nil
                                         ? PhrenTheme.projectColor(storeId: project!.storeID, project: project!.name)
                                         : PhrenTheme.chatText)
                }
                .font(PhrenTypography.subheadline.weight(.semibold)).lineLimit(1)
                HStack(spacing: 4) {
                    if session.usesFolderFallback(mappedProject: project?.name) { Image(systemName: "folder").font(.caption2) }
                    Text(chatLocationProject).foregroundStyle(chatLocationColor).lineLimit(1)
                    if !chatLocationTail.isEmpty { Text(" · " + chatLocationTail).lineLimit(1) }
                    if project == nil, session.tab.cwd != nil {
                        Button("Link to project", systemImage: "link") { assigningProject = true }
                            .labelStyle(.iconOnly).frame(width: 28, height: 24)
                            .accessibilityIdentifier("chat-link-project")
                    }
                }
                    .font(PhrenTypography.caption2).foregroundStyle(PhrenTheme.chatNeutral)
                    .accessibilityLabel(chatLocationSpoken).accessibilityIdentifier("chat-location")
            }.frame(maxWidth: .infinity, alignment: .leading)
            if let target = model.target,
               (model.capabilities ?? session.capabilities)?.allows(.changes) ?? true {
                NavigationLink {
                    // Besides the pane's tree: whatever the session's commands
                    // wrote elsewhere — the phren store, a sibling checkout.
                    AgentChangesView(session: session, target: target, codeOrigin: codeOrigin)
                } label: {
                    Image(systemName: "arrow.triangle.branch").font(.system(size: 17)).frame(width: 40, height: 44).contentShape(Rectangle())
                        .foregroundStyle(PhrenTheme.chatText)
                }.accessibilityLabel("Repository changes").accessibilityIdentifier("chat-diff")
            }
            chatOptions
        }
        .buttonStyle(.plain).foregroundStyle(PhrenTheme.chatText)
        .padding(.horizontal, 10).frame(minHeight: 48)
        .phrenPanel(radius: PhrenTheme.Radius.large)
        .padding(.horizontal, 10).padding(.top, PhrenDensity.chatHeaderTop).padding(.bottom, 4)
        .dynamicTypeSize(...DynamicTypeSize.accessibility1)
        .accessibilityElement(children: .contain)
        .overlay(alignment: .topLeading) {
            Color.clear.frame(width: 1, height: 1).accessibilityElement()
                .accessibilityIdentifier("chat-header")
        }
    }

    private var chatOptions: some View {
        Button { showingOptions = true } label: { Image(systemName: "ellipsis").frame(width: 36, height: 44).contentShape(Rectangle()) }
            .accessibilityLabel("Chat options").accessibilityIdentifier("chat-options")
    }

    /// Only what has no home elsewhere on this screen: the terminal,
    /// repository changes, slash commands, dictation and reconnecting all
    /// live in the header, the composer, or the connection notice. A sheet,
    /// not a menu: the header's menu never opened on the phone.
    private var chatOptionsSheet: some View {
        NavigationStack {
            PhrenList {
                Section {
                    NavigationLink { HerdrWorkspacesView(hostID: session.host.id) } label: { Label("Herdr workspaces", systemImage: "rectangle.split.3x1") }
                    if session.tab.isConductor {
                        NavigationLink {
                            ConductorGrantsView(host: session.host, storeId: project?.storeID ?? appModel.storeDescriptors.first?.id)
                        } label: { Label("Grants", systemImage: "checkmark.seal") }
                        .accessibilityIdentifier("chat-options-grants")
                    }
                    if model.panes.filter({ (try? $0.target(hostID: session.host.id, workspaceID: session.workspaceID, tabID: session.tab.id, muxID: session.host.muxID)) != nil }).count > 1 {
                        Button { afterOptions { model.chooseAnother(); refresh = UUID() } } label: { Label("Choose another agent", systemImage: "person.2") }
                            .disabled(model.sending)
                    }
                    if AgentModelChoice.supportsPicker(source: model.target?.source ?? "") {
                        Button { afterOptions { showingModelPicker = true } } label: {
                            Label(model.modelName.map { "Model · \($0)" } ?? "Model", systemImage: "cpu")
                        }
                        .disabled(model.sending || model.target == nil)
                        .accessibilityIdentifier("chat-options-model")
                    }
                }
                if model.progress.usage != nil || model.progressUnavailable {
                    // Above the project rows: the medium sheet's fold would
                    // otherwise hide the conversation's own section.
                    Section("This conversation") { tokenUsage }
                }
                if let project {
                    Section("Project") {
                        if let origin = indexedCode {
                            NavigationLink {
                                CodeView(storeId: origin.storeID, project: origin.project, origin: origin)
                            } label: { Label("Code", systemImage: "curlybraces") }
                            .accessibilityIdentifier("chat-options-code")
                        }
                        NavigationLink { ProjectDetailView(storeId: project.storeID, project: project.name) } label: { Label("Project memory", systemImage: "brain.head.profile") }
                        NavigationLink { SkillsView(project: project.name, storeId: project.storeID) } label: { Label("Project skills", systemImage: "sparkles") }
                        NavigationLink { GraphView(focusProject: project.name, initialStoreId: project.storeID) } label: { Label("Explore graph", systemImage: "point.3.connected.trianglepath.dotted") }
                        Button { afterOptions { showingContext = true } } label: { Label("Add project context", systemImage: "brain") }
                    }
                }
            }
            .navigationTitle("Chat options").navigationBarTitleDisplayMode(.inline)
            .toolbar { ToolbarItem(placement: .confirmationAction) { Button("Done") { showingOptions = false }.accessibilityIdentifier("chat-options-done") } }
        }
        .presentationDetents([.medium, .large]).presentationDragIndicator(.visible)
    }

    /// Close the options sheet, then present or act; two sheets cannot
    /// change places in the same beat.
    private func afterOptions(_ action: @escaping () -> Void) {
        showingOptions = false
        Task { try? await Task.sleep(for: .milliseconds(350)); action() }
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
            Button { afterOptions { showingUsage = true } } label: {
                Label("Token usage", systemImage: "chart.bar")
            }.accessibilityIdentifier("chat-token-usage").accessibilityLabel("Latest reported usage: \(usage.output) output tokens, \(usage.input) input tokens")
        } else if model.progressUnavailable {
            Link(destination: URL(string: "https://github.com/alaarab/phren/blob/main/apps/ios/README.md#live-token-counts")!) {
                Label {
                    VStack(alignment: .leading, spacing: 2) {
                        Text("Tokens unavailable")
                        Text("Set up token counts on this computer").font(.caption).foregroundStyle(PhrenTheme.textMuted)
                    }
                } icon: { Image(systemName: "chart.bar") }
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
            if model.needsAnswer && model.approval == nil && (model.question == nil || model.terminalPrompt?.questionPrompt != nil) {
                if let prompt = model.terminalPrompt {
                    if let questions = prompt.questionPrompt {
                        // A released AskUserQuestion: the same card a held
                        // question draws, answered with each option's digit
                        // through the keys route.
                        ChatQuestionCard(prompt: questions, busy: model.answering || !active || !model.connected,
                                         title: "\(model.target?.providerName ?? "Agent") asks",
                                         headerAccessory: AnyView(terminalAnswerCaption)) { answers in
                            sendTask = Task { await model.answerTerminalQuestions(session, answers: answers) }
                        }
                        .id(prompt.message ?? "terminal-questions")
                    } else if let choice = prompt.choice, choice.prompt(id: "terminal-choice") != nil {
                        // The terminal dialog the Hook read: the actual question
                        // and its options, answered by their own keys. No key
                        // strip and no waiting line behind it. Codex's queued
                        // follow-up question opens with alt+up first.
                        ChatChoiceQuestionCard(choice: choice, id: "terminal-choice", title: "\(model.target?.providerName ?? "Agent") asks",
                                               busy: model.answering || !active || !model.connected,
                                               terminal: AnyView(answerTerminalLink)) { key in
                            let keys: [AgentAnswerKey] = prompt.queued ? [.altUp, key] : [key]
                            sendTask = Task { await model.answer(session, keys: keys) }
                        }
                        .id(prompt.message ?? "terminal-choice")
                    } else {
                        ChatTerminalQuestionCard(providerName: model.target?.providerName ?? "Agent", prompt: prompt,
                                                 answering: model.answering,
                                                 disabled: model.answering || !active || !model.connected,
                                                 terminal: { answerTerminalLink }) { key in
                            sendTask = Task { await model.answer(session, key: key) }
                        }
                    }
                } else {
                    // Nothing parsed: one row with the terminal and a Keys
                    // disclosure, whose strip is hidden until asked for.
                    VStack(alignment: .leading, spacing: 8) {
                        Text("Waiting for your answer")
                            .font(PhrenTheme.Font.caption)
                            .foregroundStyle(PhrenTheme.textMuted)
                            .lineLimit(1)
                        HStack(spacing: 10) {
                            NavigationLink { HerdrTerminalView(host: session.host, session: session, target: model.target) } label: {
                                Label("Open terminal", systemImage: "terminal")
                                    .font(PhrenTheme.Font.caption)
                                    .foregroundStyle(PhrenTheme.textMuted)
                            }
                            .accessibilityIdentifier("chat-answer-terminal")
                            Spacer(minLength: 4)
                            Button { answerKeysExpanded.toggle() } label: {
                                PhrenChip(text: answerKeysExpanded ? "Hide keys" : "Keys", icon: "keyboard")
                            }
                            .buttonStyle(.plain)
                            .accessibilityLabel(answerKeysExpanded ? "Hide answer keys" : "Show answer keys")
                            .accessibilityIdentifier("chat-answer-keys-toggle")
                        }
                        if answerKeysExpanded {
                            ScrollView(.horizontal, showsIndicators: false) {
                                HStack(spacing: 8) {
                                    // Letters answer Claude's own dialogs; in a
                                    // Codex composer they would only type text.
                                    ForEach(quietAnswerKeys) { key in
                                        Button { sendTask = Task { await model.answer(session, key: key) } } label: {
                                            Text(key.label)
                                                .font(PhrenTheme.Font.monoFootnote.weight(.semibold))
                                                .foregroundStyle(PhrenTheme.textMuted)
                                                .frame(minWidth: 48, minHeight: 36)
                                                .contentShape(RoundedRectangle(cornerRadius: PhrenTheme.Radius.small, style: .continuous))
                                                .overlay(RoundedRectangle(cornerRadius: PhrenTheme.Radius.small, style: .continuous)
                                                    .strokeBorder(PhrenTheme.border, lineWidth: 1))
                                        }
                                        .buttonStyle(.plain)
                                        .disabled(model.answering || !active || !model.connected)
                                        .accessibilityLabel(key.spoken)
                                        .accessibilityIdentifier("chat-answer-key:\(key.rawValue)")
                                    }
                                }
                            }
                        }
                    }
                    .accessibilityElement(children: .contain)
                    .accessibilityIdentifier("chat-answer-keys")
                }
            }
            if model.needsAnswer, model.approval == nil, model.passwordPrompt {
                // Only a pane really reading a password offers the secret sheet.
                HStack(spacing: 8) {
                    Image(systemName: "lock.fill").font(.system(size: 13)).foregroundStyle(PhrenTheme.warning)
                    Text("The terminal is asking for a password")
                        .font(PhrenTheme.Font.caption)
                        .foregroundStyle(PhrenTheme.textMuted)
                        .fixedSize(horizontal: false, vertical: true)
                    Spacer(minLength: 4)
                    Button { showingSecret = true } label: {
                        Label("Enter password", systemImage: "key.fill")
                            .font(PhrenTheme.Font.caption.weight(.semibold))
                            .frame(minHeight: 32)
                    }
                    .buttonStyle(.plain)
                    .foregroundStyle(PhrenTheme.cyan)
                    .disabled(model.answering || !active || !model.connected)
                    .accessibilityIdentifier("chat-answer-secret")
                }
                .accessibilityElement(children: .contain)
                .accessibilityIdentifier("chat-password-prompt")
            }
            if let error = model.deliveryError { Text(error).font(.caption).foregroundStyle(PhrenTheme.warning).accessibilityIdentifier("chat-delivery-error") }
            if let error = model.draftStorageError { Text(error).font(.caption).foregroundStyle(PhrenTheme.warning).accessibilityIdentifier("chat-draft-storage-error") }
            VStack(spacing: 0) {
                TextField("Message \(model.target?.providerName ?? "agent")…", text: $model.draft, axis: .vertical)
                    .autocorrectionDisabled(!ChatSettings.autocorrects)
                    .lineLimit(1...4).focused($composing).font(.system(size: composerTextSize, design: .monospaced))
                    .tint(PhrenTheme.cyan).padding(.vertical, 8).padding(.horizontal, 12)
                    .frame(maxWidth: .infinity, minHeight: 32, alignment: .leading)
                    .contentShape(Rectangle())
                    .dismissKeyboardOnDownwardDrag { composing = false }
                    .accessibilityIdentifier("chat-composer").disabled(model.target == nil)
                HStack(alignment: .bottom, spacing: 4) {
                    Button { showingAttachments = true } label: {
                        Image(systemName: "plus").font(.system(size: 17, weight: .light)).frame(width: 40, height: 40)
                            .contentShape(Rectangle().inset(by: -2))
                    }.accessibilityLabel("Add attachment").disabled(model.target == nil || model.sending)
                    NavigationLink {
                        HerdrTerminalView(host: session.host, session: session, target: model.target)
                    } label: {
                        Image(systemName: "terminal").font(.system(size: 17)).frame(width: 40, height: 40)
                            .contentShape(Rectangle().inset(by: -2))
                    }.accessibilityLabel("Open Herdr terminal").accessibilityIdentifier("chat-composer-terminal")
                    Button { composing = false; showingAgentSwitcher = true } label: {
                        Image(systemName: "person.2")
                            .font(.system(size: 17)).frame(width: 40, height: 40)
                            .contentShape(Rectangle().inset(by: -2))
                    }.accessibilityLabel("Switch agent").accessibilityIdentifier("chat-switch-agent")
                        .disabled(model.sending || model.answering || model.stopping)
                    if runningChildAgentCount > 0 {
                        Button { showingChildAgents = true } label: {
                            Image(systemName: "point.3.filled.connected.trianglepath.dotted")
                                .font(.system(size: 17)).frame(width: 40, height: 40)
                                .contentShape(Rectangle().inset(by: -2))
                                .foregroundStyle(PhrenTheme.chatText)
                                .overlay(alignment: .topTrailing) {
                                    Text("\(runningChildAgentCount)")
                                        .font(.system(.caption2, design: .monospaced).weight(.bold)).monospacedDigit()
                                        .foregroundStyle(PhrenTheme.phrenCardAccent)
                                        .padding(.horizontal, 4).padding(.vertical, 1)
                                        .background(PhrenTheme.chatPanel, in: Capsule())
                                }
                        }
                        .accessibilityLabel("\(runningChildAgentCount) running \(runningChildAgentCount == 1 ? "agent" : "agents")")
                        .accessibilityIdentifier("chat-agent-tree")
                    }
                    Spacer(minLength: 4)
                    Button {
                        if dictating { stopDictation() } else { startDictation() }
                    } label: {
                        Image(systemName: dictating ? "mic.fill" : "mic").font(.system(size: 17))
                            .foregroundStyle(dictating ? PhrenTheme.accent : PhrenTheme.chatText)
                            .scaleEffect(dictating ? 1 + CGFloat(dictation.audioLevel) * 0.25 : 1)
                            .animation(.easeOut(duration: 0.12), value: dictation.audioLevel)
                            .frame(width: 40, height: 40).contentShape(Rectangle().inset(by: -2))
                    }.accessibilityLabel(dictating ? "Stop dictation" : "Dictate message")
                        .accessibilityIdentifier("chat-dictate")
                        .disabled(model.target == nil || model.sending)
                    Button {
                        composing = false
                        let trimmed = model.draft.trimmingCharacters(in: .whitespacesAndNewlines)
                        if showsStop {
                            sendTask = Task { await model.stop(session) }
                        } else if trimmed == "/", model.attachments.isEmpty {
                            openCommandMenu()
                        } else if model.attachments.isEmpty, AgentMenuChoice.menu(command: trimmed, source: model.target?.source ?? "") != nil {
                            // The agent would draw a menu in its terminal; the
                            // phone draws the same rows and walks it with keys.
                            menuCommand = ChatMenuCommand(command: trimmed)
                        } else if trimmed == "/model", model.attachments.isEmpty, AgentModelChoice.supportsPicker(source: model.target?.source ?? "") {
                            // The agent's own /model is a terminal menu; the
                            // phone offers the same choice as a sheet and sends
                            // the argument form, which applies without one.
                            showingModelPicker = true
                        } else {
                            suppressComposingPin = true
                            sendDraft()
                            sendScrollToken &+= 1
                        }
                    } label: {
                        Group {
                            if model.sending || model.stopping { ProgressView().tint(PhrenTheme.chatPanel) }
                            else { Image(systemName: showsStop ? "stop.fill" : showsQueue ? "text.append" : "arrow.up").font(.system(size: showsStop ? 13 : showsQueue ? 17 : 19, weight: .semibold)) }
                        }
                        .frame(width: 36, height: 36)
                        .foregroundStyle(primaryActionEnabled ? PhrenTheme.chatPanel : PhrenTheme.textDim)
                        .background(primaryActionEnabled ? PhrenTheme.cyan : PhrenTheme.borderStrong, in: Circle())
                        .frame(width: 40, height: 40).contentShape(Rectangle().inset(by: -2))
                    }
                    .disabled(!primaryActionEnabled)
                    .accessibilityLabel(showsStop ? "Stop" : showsQueue ? "Keep pending" : "Send message")
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
        .padding(.horizontal, 10).padding(.top, 6).padding(.bottom, PhrenDensity.composerBottom)
        .background(PhrenTheme.chatCanvas.ignoresSafeArea(.container, edges: .bottom))
    }

    private var answerTerminalLink: some View {
        NavigationLink { HerdrTerminalView(host: session.host, session: session, target: model.target) } label: {
            Label("Terminal", systemImage: "terminal")
                .font(PhrenTheme.Font.caption)
                .foregroundStyle(PhrenTheme.textMuted)
        }
        .accessibilityIdentifier("chat-answer-terminal")
    }

    /// A released question is answered in the agent's own terminal, so the
    /// card says so rather than promising an approval-style reply.
    private var terminalAnswerCaption: some View {
        Text("answered in the terminal")
            .font(PhrenTheme.Font.caption2)
            .foregroundStyle(PhrenTheme.textMuted)
            .lineLimit(1)
            .accessibilityIdentifier("chat-terminal-answer-caption")
    }

    private var quietAnswerKeys: [AgentAnswerKey] {
        [.enter, .up, .down, .tab, .escape, .yes, .no].filter { key in
            ![.yes, .no].contains(key) || model.terminalPrompt != nil || model.target?.source == "claude"
        }
    }

    /// Sends the draft. A slash command normally hands off to the terminal,
    /// where the agent draws its menu; a command with its answer already in
    /// it (`/model sonnet`) is answered in the transcript and stays here.
    private func sendDraft(handoffCommands: Bool = true) {
        cleanupTask?.cancel()
        dictationPreview = nil
        sendTask = Task {
            if dictating { dictation.updateDraft(model.draft) }
            let isCommand = AgentSlashCommand.isCommand(model.draft), pane = model.target?.paneID
            await model.send(session, consumeDraft: dictating ? { restartDictationSegment() } : nil)
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
    private var showsStop: Bool {
        model.target?.isStarting != true && model.isBusy && model.draft.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty && model.attachments.isEmpty
    }
    /// Pending means the harness cannot currently receive input.
    private var showsQueue: Bool {
        model.target != nil && model.pendingReason != nil && !showsStop
            && (!model.draft.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || !model.attachments.isEmpty)
    }

    /// Unsent readiness holds only. Harness queue items live in the transcript.
    private var queuedMessages: some View {
        VStack(alignment: .leading, spacing: 6) {
            ForEach(model.localPendingMessages) { item in
                HStack(alignment: .top, spacing: 8) {
                    VStack(alignment: .leading, spacing: 4) {
                        Text(model.pendingLabel(item)).font(PhrenTypography.caption)
                            .foregroundStyle(PhrenTheme.textMuted)
                            .accessibilityIdentifier("chat-pending-reason:\(item.id)")
                        if !item.text.isEmpty {
                            Text(item.text).font(.system(size: 14, design: .monospaced)).foregroundStyle(PhrenTheme.chatText)
                                .lineLimit(3).textSelection(.enabled)
                        }
                        if !item.attachments.isEmpty {
                            Text("\(item.attachments.count) attachment\(item.attachments.count == 1 ? "" : "s")")
                                .font(.caption2).foregroundStyle(PhrenTheme.chatNeutralDim)
                        }
                    }.frame(maxWidth: .infinity, alignment: .leading)

                    HStack(spacing: 0) {
                        PhrenIconButton(icon: "arrow.up", label: "Send now") {
                            sendTask = Task { await model.sendNow(item, session) }
                        }.accessibilityIdentifier("chat-queued-send:\(item.id)")
                            .disabled(!active || model.pendingReason != nil || model.sending)
                        PhrenIconButton(icon: "pencil", label: "Edit") { model.edit(item); composing = true }
                            .accessibilityIdentifier("chat-queued-edit:\(item.id)")
                        PhrenIconButton(icon: "xmark", label: "Remove pending message") { model.remove(item) }
                            .accessibilityIdentifier("chat-queued-remove:\(item.id)")
                    }.font(.system(size: 15)).foregroundStyle(PhrenTheme.chatNeutral).buttonStyle(.plain)
                }
                .padding(.leading, 12).padding(.trailing, 4).padding(.vertical, 6)
                .background(PhrenTheme.chatUserBubble, in: RoundedRectangle(cornerRadius: 16, style: .continuous))
                .opacity(0.5)
                .overlay(alignment: .topLeading) {
                    Color.clear.frame(width: 1, height: 1).accessibilityElement()
                        .accessibilityLabel("Pending message").accessibilityIdentifier("chat-queued-tag:\(item.id)")
                }
                .padding(.leading, 30)
                .accessibilityElement(children: .contain)
                .accessibilityIdentifier("chat-queued:\(item.id)")
            }
        }
        .accessibilityIdentifier("chat-queue")
    }
    private var primaryActionEnabled: Bool {
        showsStop ? active && model.connected && !model.sending && !model.stopping && !model.answering : canSend
    }
    /// The agent is waiting but the app has no card to answer with — a plain
    /// prompt, or a question type the Hook cannot structure. Then the
    /// composer is the answer, not just a link out to the terminal.
    private var answersInComposer: Bool {
        model.needsAnswer && model.approval == nil && model.question == nil
    }
    private var canSend: Bool {
        active && model.target != nil && !model.sending && !model.stopping && !model.answering
            && (!model.draft.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || !model.attachments.isEmpty)
    }
}

private struct ChatBottomPosition: PreferenceKey {
    static let defaultValue: CGFloat = 0
    static func reduce(value: inout CGFloat, nextValue: () -> CGFloat) { value = nextValue() }
}

private struct ChatContentHeight: PreferenceKey {
    static let defaultValue: CGFloat = 0
    static func reduce(value: inout CGFloat, nextValue: () -> CGFloat) { value = nextValue() }
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

#if DEBUG && targetEnvironment(simulator)
/// What the chat copied and selected, as a text tests can read.
private struct ChatFixtureReport: View {
    var body: some View {
        Text(AgentChatFixture.report.json).font(.system(size: 1)).frame(width: 1, height: 1)
            .accessibilityIdentifier("chat-fixture-copied")
    }
}
#endif

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

private enum ChatFollow {
    static let threshold: CGFloat = 60
}

private struct ChatPinRequest: Equatable {
    let id = UUID()
    let animated: Bool
}

private extension ChatScrollMetrics {
    @available(iOS 18.0, *)
    init(_ geometry: ScrollGeometry) {
        self.init(contentHeight: geometry.contentSize.height,
                  viewportHeight: geometry.containerSize.height,
                  offsetY: geometry.contentOffset.y)
    }
}

private struct ChatFollowScroll: ViewModifier {
    let viewport: CGFloat
    let contentHeight: CGFloat
    let following: Bool
    let pinRequest: ChatPinRequest?
    let changed: (ChatScrollMetrics, ChatScrollMetrics, Bool) -> Void

    @State private var userDriven = false
    @State private var legacyMetrics = ChatScrollMetrics(contentHeight: 0, viewportHeight: 0, offsetY: 0)
    @State private var legacyBottomPosition: CGFloat = 0

    func body(content: Content) -> some View {
        if #available(iOS 18.0, *) {
            ModernChatFollowScroll(content: content, following: following, pinRequest: pinRequest,
                                   userDriven: $userDriven, changed: changed)
        } else {
            content
                .simultaneousGesture(DragGesture(minimumDistance: 12).onChanged { value in
                    let driving = abs(value.translation.height) > 12
                    if driving != userDriven { userDriven = driving }
                }.onEnded { _ in userDriven = false })
                .onPreferenceChange(ChatBottomPosition.self) { position in
                    // Before ScrollGeometry, combine the measured stack with
                    // its end marker to recover the same real offset.
                    legacyBottomPosition = position
                    let new = ChatScrollMetrics(contentHeight: contentHeight,
                                                viewportHeight: viewport,
                                                offsetY: contentHeight - position)
                    changed(legacyMetrics, new, userDriven)
                    legacyMetrics = new
                }
                .onChange(of: contentHeight) { _, height in
                    let new = ChatScrollMetrics(contentHeight: height,
                                                viewportHeight: viewport,
                                                offsetY: height - legacyBottomPosition)
                    changed(legacyMetrics, new, userDriven)
                    legacyMetrics = new
                }
        }
    }
}

@available(iOS 18.0, *)
private struct ModernChatFollowScroll<Content: View>: View {
    let content: Content
    let following: Bool
    let pinRequest: ChatPinRequest?
    @Binding var userDriven: Bool
    let changed: (ChatScrollMetrics, ChatScrollMetrics, Bool) -> Void
    @State private var position = ScrollPosition()
    @State private var metrics = ChatScrollMetrics(contentHeight: 0, viewportHeight: 0, offsetY: 0)
    @State private var handledPinID: UUID?
    /// A pin keeps following the viewport for a moment after it is applied:
    /// the keyboard changes the container over several frames, and a pin
    /// resolved against the first of them lands short of, or past, the end.
    @State private var settlingUntil: Date?
    var body: some View {
        content
            .scrollPosition($position)
            .onScrollPhaseChange { _, phase in
                let driving = phase == .tracking || phase == .interacting || phase == .decelerating
                if driving != userDriven { userDriven = driving }
            }
            .onScrollGeometryChange(for: ChatScrollMetrics.self) { ChatScrollMetrics($0) } action: { old, new in
                metrics = new
                changed(old, new, userDriven)
                if !userDriven, let corrected = ChatScrollMetrics.correctiveOffset(new) {
                    position.scrollTo(y: corrected)
                    return
                }
                if let settlingUntil, settlingUntil > .now, !userDriven {
                    // An estimate that corrected downward (or content that
                    // shrank) leaves the offset past the new bottom; the
                    // corrective check above already scrolled to it. Here the
                    // only question is whether the bottom just moved because
                    // the transcript grew.
                    let target = ChatScrollMetrics.clamp(new.bottomOffset, in: new)
                    if target > 0.5, abs(new.offsetY - target) > 0.5 { position.scrollTo(y: target) }
                    return
                }
                guard following,
                      let target = ChatScrollMetrics.shouldRepin(old: old, new: new, userDriven: userDriven) else { return }
                position.scrollTo(y: ChatScrollMetrics.clamp(target, in: new))
            }
            .onChange(of: pinRequest) { _, request in
                guard let request else { return }
                apply(request, to: metrics)
            }
            .onChange(of: metrics) { _, metrics in
                guard let request = pinRequest else { return }
                apply(request, to: metrics)
            }
    }

    private func apply(_ request: ChatPinRequest, to metrics: ChatScrollMetrics) {
        guard handledPinID != request.id, metrics.viewportHeight > 0.5 else { return }
        handledPinID = request.id
        // Loaded rows and distant placeholders both have measured heights.
        // Clamp the numeric target to that real end as the viewport changes.
        let target = ChatScrollMetrics.clamp(metrics.bottomOffset, in: metrics)
        guard target > 0.5 else { return }
        settlingUntil = .now + (request.animated ? 0.6 : 0.3)
        if request.animated {
            withAnimation { position.scrollTo(y: target) }
        } else {
            position.scrollTo(y: target)
        }
    }
}
