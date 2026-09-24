import PhrenKit
import SwiftUI

/// What the transcript pane asks of the chat around it.
struct ChatTranscriptActions {
    /// Reconnect the conversation (a new run of the chat's loop).
    var reconnect: () -> Void
    var choosePane: (AgentChatPanes.Pane) -> Void
    var openTerminal: (AgentChatPanes.Pane) -> Void
    var preview: (ChatAttachmentDraft) -> Void
    var isAgent: (AgentChatPanes.Pane) -> Bool
}

/// The conversation: the scroll view, its history paging, the pins that keep
/// it following the latest reply, and the rows. It owns the scroll state, so
/// scrolling and paging redraw this pane and never the header or composer;
/// the rows themselves observe the timeline, so a new row redraws the rows.
struct ChatTranscriptPane: View {
    let session: LiveAgentSession
    let model: AgentChatModel
    let active: Bool
    /// This computer's saved connection still matches the session's.
    let hostMatches: Bool
    let project: SessionProject?
    let textSelection: ChatTextSelection
    @Binding var composing: Bool
    /// Set by a send so the composer's resignation does not also pin.
    @Binding var suppressComposingPin: Bool
    /// Moves once per send; the pin that follows a send waits for layout.
    let sendScrollToken: Int
    let childAgents: [AgentChild]
    let actions: ChatTranscriptActions

    @Environment(\.scenePhase) private var scenePhase
    @Environment(ChatMessageMenu.self) private var messageMenu: ChatMessageMenu?
    /// The model's, so a reopened conversation keeps its measured rows and
    /// draws the far ones as placeholders from its first frame.
    private var rowLayout: ChatRowLayout { model.rowLayout }
    /// Rows prepared before this screen opened (a prefetch) and never
    /// measured are laid out just after the push starts, so the screen
    /// answers the tap first. Measured rows fold far ones and need no wait.
    @State private var rowsReady = false
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
    @State private var sendScrollTask: Task<Void, Never>?

    /// Pages loaded back to back without a scroll in between. A page of
    /// nothing but lifecycle rows may need a second, but a chain past a few
    /// means the anchor scroll isn't taking and the top stays "near"; left
    /// alone that pulls the whole history and hangs the phone.
    private static let automaticHistoryPages = 3

    var body: some View {
        ScrollViewReader { proxy in
            transcriptScroll(proxy)
        }
        .environment(\.chatChildAgents, model.target.flatMap { target in
            childAgents.isEmpty ? nil : ChatChildAgents(session: session, target: target, agents: childAgents)
        })
        .onAppear { rowLayout.resumeAtEnd() }
        .task { rowsReady = true }
        .onDisappear { cancelHistory() }
        .onChange(of: scenePhase) { _, phase in if phase != .active { cancelHistory() } }
        .onChange(of: hostMatches) { _, _ in cancelHistory() }
    }

    private func cancelHistory() {
        historyTask?.cancel(); historyTask = nil
    }

    private func transcriptScroll(_ proxy: ScrollViewProxy) -> some View {
        ScrollView {
            VStack(spacing: 0) {
                transcriptRows(proxy)
                // The scroll marker is not a message: it must not add
                // another inter-message gap below the final reply.
                ChatBottomMarker().frame(height: 1).id("chat-bottom")
            }
            .coordinateSpace(.named(ChatRowLayout.coordinateSpace))
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
            textSelection.transcriptTapped()
            // A hold on a message ends in this tap too; that keeps the keyboard.
            if messageMenu?.tapEndsAHold() != true { composing = false }
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
        .onChange(of: model.timelineState.historyStartLine) { _, _ in loadHistoryIfNeeded(proxy, automatic: true) }
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
                                   selectionActive: textSelection.preventsTranscriptScrolling || messageMenu?.request != nil) { _, new, userDriven in
            if userDriven { messageMenu?.noteUserScroll() }
            scrollMetrics = new
            rowLayout.scrolled(offsetY: new.offsetY, viewport: new.viewportHeight)
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
        .overlay { ChatOpeningSpinner(model: model) }
        .overlay(alignment: .bottomTrailing) {
            if !atBottom || model.timelineState.hasNewer {
                Button {
                    if model.timelineState.hasNewer {
                        cancelHistory(); requestedHistoryLine = nil
                        model.showLatest(); actions.reconnect()
                    }
                    withAnimation { proxy.scrollTo("chat-bottom", anchor: .bottom) }
                } label: {
                    Image(systemName: "arrow.down").frame(width: 40, height: 40).background(PhrenTheme.surfaceRaised, in: Circle())
                }.accessibilityLabel("Latest messages").padding(12)
            }
        }
        .onChange(of: model.target?.id) { _, _ in
            cancelHistory(); requestedHistoryLine = nil
            textSelection.end()
            pinToBottom(proxy)
        }
        .modifier(ChatLegacyFollowPins(model: model) { animated in
            if atBottom && !model.loadingHistory { pinToBottom(proxy, animated: animated) }
        })
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
        .onChange(of: model.sentRevision) { _, _ in pinAfterSend(proxy) }
    }

    /// The rows inside the scroll view: pane choice, connection notices,
    /// history paging, the transcript itself and the status lines under it.
    private func transcriptRows(_ proxy: ScrollViewProxy) -> some View {
        VStack(alignment: .leading, spacing: 12) {
            ChatConnectionNotices(model: model, hostMatches: hostMatches, actions: actions)
            ChatHistoryHeader(model: model) {
                requestedHistoryLine = nil
                loadHistoryIfNeeded(proxy)
            }
            if rowsReady || rowLayout.measured {
                ChatLiveTranscriptRows(timeline: model.timelineState, reveal: model.reveal, layout: rowLayout,
                                       session: session, target: model.target, active: active,
                                       preview: actions.preview).equatable()
            }
            ChatTranscriptFooter(model: model, session: session, project: project)
        }
    }

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
    /// resolved then can target a row the stack has not laid out. Wait one
    /// run loop for the row, pin, then pin once more when the keyboard
    /// animation has finished. `pinToBottom` holds each target to the content
    /// end (the clamped numeric offset on iOS 18, the bottom marker before it).
    private func pinAfterSend(_ proxy: ScrollViewProxy) {
        sendScrollTask?.cancel()
        sendScrollTask = Task { @MainActor in
            await Task.yield()
            suppressComposingPin = false
            // A send always shows its own message, even from far up the
            // transcript or an older page of history.
            if model.timelineState.hasNewer {
                cancelHistory(); requestedHistoryLine = nil
                model.showLatest(); actions.reconnect()
            }
            atBottom = true
            guard !model.loadingHistory else { return }
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
}

/// The end of the transcript. Before iOS 18 its position is how the follow
/// logic recovers the scroll offset; from iOS 18 the scroll geometry gives it
/// directly, so the marker reports nothing while scrolling.
private struct ChatBottomMarker: View {
    var body: some View {
        if #available(iOS 18.0, *) {
            Color.clear
        } else {
            GeometryReader { geometry in
                Color.clear.preference(key: ChatBottomPosition.self, value: geometry.frame(in: .named("chat-scroll")).maxY)
            }
        }
    }
}

/// Before iOS 18 the transcript pins on content changes itself; the reads
/// live in this modifier so they redraw nothing but it.
private struct ChatLegacyFollowPins: ViewModifier {
    let model: AgentChatModel
    let pin: (_ animated: Bool) -> Void
    func body(content: Content) -> some View {
        if #available(iOS 18.0, *) {
            content
        } else {
            content
                .onChange(of: model.timeline.last?.id) { _, _ in pin(true) }
                .onChange(of: model.reveal.revision) { _, _ in pin(false) }
                .onChange(of: model.imagesByMessage) { _, _ in pin(false) }
        }
    }
}

/// The spinner over an opening conversation.
private struct ChatOpeningSpinner: View {
    let model: AgentChatModel
    var body: some View {
        let timeline = model.timelineState
        if (model.loading && !timeline.hasMessages) || (timeline.entries.isEmpty && timeline.hasMessages) {
            ProgressView()
                .tint(PhrenTheme.chatNeutral)
                .accessibilityLabel("Opening conversation")
                .accessibilityIdentifier("chat-opening-spinner")
        }
    }
}

/// Pane choice and connection notices above the transcript.
private struct ChatConnectionNotices: View {
    let model: AgentChatModel
    let hostMatches: Bool
    let actions: ChatTranscriptActions
    var body: some View {
        if model.target == nil && !model.loading {
            ChatPanePicker(panes: model.panes, isAgent: actions.isAgent,
                           choose: actions.choosePane, openTerminal: actions.openTerminal)
        }
        if let error = model.error { issue(error, retry: !model.connected && model.target != nil) }
        if !hostMatches {
            issue("This computer's connection changed. Reopen chat from the current session list.")
        }
    }

    private func issue(_ message: String, retry: Bool = false) -> some View {
        VStack(alignment: .leading, spacing: 8) {
            Label(message, systemImage: "wifi.exclamationmark")
            if retry {
                Button("Reconnect", systemImage: "arrow.clockwise") { actions.reconnect() }
                    .font(PhrenTypography.footnote.weight(.semibold)).foregroundStyle(PhrenTheme.cyan)
                    .accessibilityIdentifier("chat-reconnect")
            }
        }
        .font(PhrenTypography.footnote).foregroundStyle(PhrenTheme.warning).padding(12).phrenCard()
    }
}

/// Earlier-messages paging at the top of the transcript.
private struct ChatHistoryHeader: View {
    let model: AgentChatModel
    let retry: () -> Void
    var body: some View {
        if model.timelineState.hasMore {
            VStack(spacing: 8) {
                if model.loadingHistory { ProgressView().accessibilityLabel("Loading earlier messages") }
                else if model.historyError != nil {
                    Button("Retry loading earlier messages", action: retry).font(PhrenTypography.caption)
                }
            }
            .frame(maxWidth: .infinity, minHeight: 24)
            .background(ChatHistoryMarker())
            .accessibilityIdentifier("chat-history")
        }
    }
}

/// Before iOS 18 the history header's position tells the pane it is near the
/// top; from iOS 18 the scroll geometry does, and this reports nothing.
private struct ChatHistoryMarker: View {
    var body: some View {
        if #available(iOS 18.0, *) {
            Color.clear
        } else {
            GeometryReader { geometry in
                Color.clear.preference(key: ChatHistoryPosition.self, value: geometry.frame(in: .named("chat-scroll")).minY)
            }
        }
    }
}

/// The lines under the last row: a model switch, the reply being written and
/// the starting or ready note. Each reads only what it shows.
private struct ChatTranscriptFooter: View {
    let model: AgentChatModel
    let session: LiveAgentSession
    let project: SessionProject?
    var body: some View {
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
        ChatReplyPreviewSlot(timeline: model.timelineState)
        if model.target?.isStarting == true {
            Text(session.tab.isConductor
                 ? "Starting the conductor with \(model.target?.providerName ?? "agent")…"
                 : "Starting \(model.target?.providerName ?? "agent") in \(session.projectDisplayName(project?.name))…")
                .foregroundStyle(PhrenTheme.textMuted).padding(.top, 24)
                .accessibilityIdentifier("chat-starting")
        } else if model.connected && !model.timelineState.hasMessages {
            Text("Ready for your message.").foregroundStyle(PhrenTheme.textMuted).padding(.top, 24)
        }
    }
}

/// The reply as it is being written: preview frames redraw this row alone.
private struct ChatReplyPreviewSlot: View {
    let timeline: AgentChatTimelineState
    var body: some View {
        if let preview = timeline.replyPreview {
            ChatReplyPreviewRow(preview: preview)
        }
    }
}
