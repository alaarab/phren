import PhrenKit
import PhrenLive
import SwiftUI

struct ChatAttachmentDraft: Identifiable, Equatable {
    let attachment: AgentAttachment
    var path: String?
    var id: UUID { attachment.id }
}

/// A message typed while the agent was busy: held in the app, listed under
/// the transcript, delivered when the turn ends — or now, on request.
struct QueuedMessage: Identifiable, Equatable {
    let id = UUID()
    var text: String
    var attachments: [ChatAttachmentDraft]
    var submittedAfterLine: Int? = nil
    var submittedText: String? = nil
}

/// Queues survive switching agents within a chat, like drafts do.
@MainActor enum AgentChatQueues {
    static var items: [String: [QueuedMessage]] = [:]
    static var reconciledRows: [String: Set<String>] = [:]
}

@MainActor enum AgentChatDrafts {
    static var text: [String: String] = [:]
    static var attachments: [String: [ChatAttachmentDraft]] = [:]
    static var revision: UInt64 = 0
    static var pending: [String: UInt64] = [:]
    private static var saved: [String: UInt64] = [:]
    private static var readers: [String: Int] = [:]

    static func beginRead(_ target: String) { readers[target, default: 0] += 1 }
    static func endRead(_ target: String) {
        let count = (readers[target] ?? 1) - 1
        readers[target] = count > 0 ? count : nil
        releaseSaved(target)
    }
    static func didSave(_ target: String, revision: UInt64) {
        guard pending[target] == revision else { return }
        saved[target] = revision
        releaseSaved(target)
    }
    private static func releaseSaved(_ target: String) {
        // A loader may already hold an older disk snapshot. Keep the newest
        // in-memory draft until every such reader has consumed it. Failed or
        // superseded saves must never evict unsaved text or attachments.
        guard readers[target] == nil, let version = pending[target], saved[target] == version else { return }
        text.removeValue(forKey: target); attachments.removeValue(forKey: target)
        pending.removeValue(forKey: target); saved.removeValue(forKey: target)
    }
    static let store: AgentDraftRepository? = {
        #if DEBUG && targetEnvironment(simulator)
        if AppModel.isUITesting && !ProcessInfo.processInfo.arguments.contains("--chat-persistent-draft") { return nil }
        #endif
        let root = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0]
            .appendingPathComponent(AppModel.isUITesting ? "AgentDraftTests" : "AgentDrafts", isDirectory: true)
        #if DEBUG && targetEnvironment(simulator)
        if AppModel.isUITesting && ProcessInfo.processInfo.arguments.contains("--chat-clear-drafts") { try? FileManager.default.removeItem(at: root) }
        #endif
        return AgentDraftRepository(root: root)
    }()
}

@Observable @MainActor
final class AgentChatModel {
    var panes: [AgentChatPanes.Pane] = []
    var target: AgentChatTarget?
    var history = AgentChatHistory() {
        didSet {
            if history.messages != oldValue.messages { prepareTranscript() }
        }
    }
    private(set) var timeline: [ChatTimelineEntry] = []
    private(set) var timelineRevision = 0
    private(set) var backgroundJobs: [ChatBackgroundJob] = []
    private(set) var currentToolName: String?
    private(set) var imagesByMessage: [String: [ChatAttachmentDraft]] = [:]
    @ObservationIgnored private var preparation = ChatTranscriptPreparation()
    @ObservationIgnored private var preparationTask: Task<Void, Never>?
    @ObservationIgnored private var preparationID = UUID()

    private func prepareTranscript() {
        preparationTask?.cancel()
        let id = UUID(); preparationID = id
        let messages = history.messages
        if messages.isEmpty {
            preparation = .init(); timeline = []; backgroundJobs = []; currentToolName = nil
            timelineRevision += 1; imagesByMessage = [:]; return
        }
        let previous = preparation
        preparationTask = Task {
            let value = await Task.detached(priority: .userInitiated) {
                var value = previous; value.update(messages); return value
            }.value
            guard !Task.isCancelled, preparationID == id else { return }
            preparation = value; timeline = value.entries; backgroundJobs = value.jobs
            currentToolName = value.currentToolName; timelineRevision += 1
            matchSentImages()
        }
    }
    private func matchSentImages() {
        var matches: [String: [ChatAttachmentDraft]] = [:]
        if !sentImages.isEmpty {
            for message in messages where message.role == .user {
                let images = sentImages.filter { item in item.path.map { message.text.contains($0) } == true }
                if !images.isEmpty { matches[message.id] = images }
            }
        }
        imagesByMessage = matches
    }
    var progress = AgentChatProgress()
    let reveal = ChatTextReveal()
    var animateReplies = true
    private var hasTranscript = false
    private(set) var awaitingReply = false
    private(set) var sentAt: Date?
    private var submittedAfterLine = -1
    var liveActivity: String?
    private var preferProgressActivity = false
    var activityPhase: AgentChatProgress.Phase? {
        if preferProgressActivity { return progress.phase }
        switch liveActivity {
        case "working": return .working
        case "done": return .finished
        case "idle": return progress.phase == .stopped ? .stopped : nil
        case "blocked", "waiting", "unknown": return nil
        default: return progress.phase
        }
    }
    func acceptActivity(_ activity: String?) {
        guard let activity else { return }
        liveActivity = activity; preferProgressActivity = false
        scheduleDrain()
    }
    var modelName: String?
    /// The model and branch the transcript names, kept across status ticks;
    /// the live branch from Phren Hook wins over the transcript's stamp
    /// because it is read from git now rather than when the row was written.
    private var transcriptContext = AgentSessionContext()
    private var statusBranch: String?
    var branch: String? { statusBranch ?? transcriptContext.branch }
    var questionsSupported = true
    var progressUnavailable = false
    var messages: [AgentChatMessage] { history.messages }
    var hasMore: Bool { history.hasMore }
    var error: String?
    var deliveryError: String?
    var loading = true
    var connected = false
    var sending = false
    var loadingHistory = false
    var stopping = false
    var needsAnswer = false
    var approval: AgentApproval?
    var question: AgentQuestionPrompt?
    var interactionConnected = false
    var answering = false
    private var answeredQuestions: Set<String> = []
    private var statusTask: Task<Void, Never>?
    private var progressTask: Task<Void, Never>?
    private var progressConnected = false
    private var statusGeneration = UUID()
    var receivedAt: Date?
    var deliveryStatus: String?
    var draftStorageError: String?
    private(set) var restoringDraft = false
    private var draftSaveTask: Task<Void, Never>?
    private var draftSaveImmediate = false
    private var draftLoadTask: Task<Void, Never>?
    private var draftGeneration = UUID()
    private var draftRevision: UInt64 = 0
    var draft = "" { didSet { if !restoringDraft, let target { AgentChatDrafts.text[target.id] = draft; persistDraft() } } }
    var attachments: [ChatAttachmentDraft] = [] { didSet { if !restoringDraft, let target { AgentChatDrafts.attachments[target.id] = attachments; persistDraft() } } }
    var sentImages: [ChatAttachmentDraft] = [] { didSet { matchSentImages() } }
    /// Messages waiting for the agent to finish its turn; the first goes out
    /// the moment it does.
    var queue: [QueuedMessage] = [] { didSet { if let target, !restoringDraft { AgentChatQueues.items[target.id] = queue } } }
    /// True while a send would interrupt the agent: it is working, or a reply
    /// is still on its way, and nothing is waiting on the person.
    var isBusy: Bool { !needsAnswer && approval == nil && (awaitingReply || (target?.isStarting != true && activityPhase == .working)) }
    private var drainTask: Task<Void, Never>?
    private var lastSession: LiveAgentSession?
    private var generation = UUID()
    private var streamTask: Task<Void, Never>?
    private var streamTarget: AgentChatTarget?
    private var rejectedStreamTarget: AgentChatTarget?
    var automaticReconnectSuspended: Bool { target != nil && rejectedStreamTarget == target }

    func choose(_ pane: AgentChatPanes.Pane, session: LiveAgentSession) {
        do {
            let chosen = try pane.target(hostID: session.host.id, workspaceID: session.workspaceID, tabID: session.tab.id, muxID: session.host.muxID)
            persistDraft(immediately: true)
            draftLoadTask?.cancel()
            let draftRun = UUID(); draftGeneration = draftRun
            target = chosen
            rejectedStreamTarget = nil
            restoringDraft = true
            draft = ""; attachments = []
            draftStorageError = nil
            AgentChatDrafts.beginRead(chosen.id)
            draftLoadTask = Task {
                defer { AgentChatDrafts.endRead(chosen.id) }
                let saved: AgentDraftStore.Draft
                do { saved = try await AgentChatDrafts.store?.load(target: chosen.id) ?? .init() }
                catch {
                    guard !Task.isCancelled, draftGeneration == draftRun else { return }
                    draftStorageError = error.localizedDescription; saved = .init()
                }
                guard !Task.isCancelled, draftGeneration == draftRun else { return }
                draft = AgentChatDrafts.text[chosen.id] ?? saved.text
                attachments = AgentChatDrafts.attachments[chosen.id] ?? saved.attachments.map { .init(attachment: $0) }
                restoringDraft = false
            }
            history = .init(); progress = .init(); reveal.finish(); hasTranscript = false
            awaitingReply = false; sentAt = nil; liveActivity = nil; modelName = nil; preferProgressActivity = false
            transcriptContext = .init(); statusBranch = nil
            connected = false; error = nil; deliveryError = nil
            sentImages = []; needsAnswer = false; approval = nil; question = nil; answeredQuestions = []
            reconciledQueueRows = AgentChatQueues.reconciledRows[chosen.id] ?? []
            queue = AgentChatQueues.items[chosen.id] ?? []
        } catch { self.error = error.localizedDescription }
    }
    private func persistDraft(immediately: Bool = false) {
        guard !restoringDraft, let target else { return }
        if !draftSaveImmediate { draftSaveTask?.cancel() }
        draftSaveImmediate = immediately
        AgentChatDrafts.revision += 1
        let revision = AgentChatDrafts.revision; draftRevision = revision
        AgentChatDrafts.pending[target.id] = revision
        let saved = AgentDraftStore.Draft(text: draft, attachments: attachments.map(\.attachment))
        draftSaveTask = Task {
            do {
                // Coalesce edits from this UI update, then persist promptly.
                // A wall-clock debounce can lose the final edit on quick exit.
                if !immediately { await Task.yield() }
                try Task.checkCancellation()
                if let store = AgentChatDrafts.store {
                    try await store.save(saved, target: target.id, revision: revision)
                    AgentChatDrafts.didSave(target.id, revision: revision)
                }
                if self.target == target, draftRevision == revision { draftStorageError = nil }
            } catch is CancellationError { }
            catch { if self.target == target, draftRevision == revision { draftStorageError = error.localizedDescription } }
        }
    }
    func flushDrafts() {
        persistDraft(immediately: true)
        let save = draftSaveTask
        let lease = UIApplication.shared.beginBackgroundTask(withName: "Save agent draft")
        Task {
            await save?.value
            if lease != .invalid { UIApplication.shared.endBackgroundTask(lease) }
        }
    }
    func chooseAnother() {
        persistDraft(immediately: true)
        draftLoadTask?.cancel(); draftGeneration = UUID(); restoringDraft = false
        progressTask?.cancel(); progressTask = nil
        streamTask?.cancel(); streamTask = nil; streamTarget = nil
        statusTask?.cancel(); statusTask = nil; interactionConnected = false; approval = nil
        target = nil; history = .init(); connected = false; queue = []; drainTask?.cancel(); drainTask = nil
        rejectedStreamTarget = nil
        progress = .init(); reveal.finish(); hasTranscript = false; awaitingReply = false; sentAt = nil; liveActivity = nil; modelName = nil
        transcriptContext = .init(); statusBranch = nil
        draft = ""; attachments = []; sentImages = []; deliveryError = nil; needsAnswer = false
    }
    func add(_ attachment: AgentAttachment) {
        guard attachments.count < ChatAttachmentLimit.maximum else { deliveryError = "Attach up to \(ChatAttachmentLimit.maximum) files in one message."; return }
        attachments.append(.init(attachment: attachment)); deliveryError = nil
    }

    func run(_ session: LiveAgentSession) async {
        lastSession = session
        rejectedStreamTarget = nil
        let run = UUID(); generation = run; loading = true
        // A new appearance can start before the cancelled run unwinds. Its
        // streams carry the old generation and must not suppress new streams
        // merely because their pane identity is still the same.
        progressTask?.cancel(); progressTask = nil
        streamTask?.cancel(); streamTask = nil; streamTarget = nil
        statusTask?.cancel(); statusTask = nil; interactionConnected = false; approval = nil
        defer {
            if generation == run {
                progressTask?.cancel(); progressTask = nil
                streamTask?.cancel(); streamTask = nil; streamTarget = nil
                statusTask?.cancel(); statusTask = nil; interactionConnected = false; approval = nil
                connected = false; loading = false
                reveal.finish()
            }
        }
        while !Task.isCancelled {
            do {
                let list = try await Self.fetchPanes(session)
                try Task.checkCancellation()
                guard generation == run else { return }
                panes = list.panes
                if target == nil {
                    let supported = panes.filter { (try? $0.target(hostID: session.host.id, workspaceID: session.workspaceID, tabID: session.tab.id, muxID: session.host.muxID)) != nil }
                    if supported.count == 1 { choose(supported[0], session: session) }
                }
                var newlyAttached: AgentChatTarget?
                if let target, target.isStarting { newlyAttached = try list.attachedTarget(for: target) }
                if let newlyAttached, !sending { attachStartingTarget(newlyAttached) }
                if let target, newlyAttached == nil || !sending {
                    needsAnswer = try list.validate(target).needsAnswer || approval != nil
                    if !interactionConnected { acceptActivity(try list.validate(target).agentStatus) }
                    if needsAnswer { awaitingReply = false }
                    if target.isStarting { connected = true; error = nil }
                    else if shouldBeginStream(target) { beginStream(session, target: target, run: run) }
                }
                loading = false
            } catch {
                guard !Task.isCancelled, generation == run else { return }
                handleConnectionFailure(error)
            }
            do { try await Task.sleep(for: .seconds(target?.isStarting == true ? 2 : 3)) } catch { return }
        }
    }

    /// Preserve the first optimistic bubble and current composer when the
    /// transcript appears. `choose` would discard both and reload an empty draft.
    func attachStartingTarget(_ attached: AgentChatTarget) {
        guard let previous = target, previous.isStarting, !attached.isStarting,
              previous.hostID == attached.hostID, previous.muxID == attached.muxID,
              previous.workspaceID == attached.workspaceID, previous.tabID == attached.tabID,
              previous.paneID == attached.paneID, previous.source == attached.source else { return }
        persistDraft(immediately: true)
        draftLoadTask?.cancel(); draftGeneration = UUID(); restoringDraft = false
        target = attached
        AgentChatQueues.items[previous.id] = nil
        AgentChatQueues.items[attached.id] = queue
        AgentChatDrafts.text[attached.id] = draft
        AgentChatDrafts.attachments[attached.id] = attachments
        persistDraft(immediately: true)
        connected = false; error = nil
    }

    func shouldBeginStream(_ target: AgentChatTarget) -> Bool {
        !target.isStarting && streamTarget != target && rejectedStreamTarget != target
    }
    func handleConnectionFailure(_ error: Error) {
        progressTask?.cancel(); progressTask = nil
        streamTask?.cancel(); streamTask = nil; streamTarget = nil
        statusTask?.cancel(); statusTask = nil; interactionConnected = false; approval = nil
        connected = false; loading = false
        // Polling failures cannot remove a rejected-transcript latch and cause
        // the same oversized backlog to be decoded again after the host recovers.
        if !automaticReconnectSuspended { self.error = error.localizedDescription }
    }
    func handleStreamFailure(_ error: Error, target: AgentChatTarget) {
        connected = false
        if error is AgentChatTranscript.LimitError {
            rejectedStreamTarget = target
            self.error = error.localizedDescription
        } else {
            streamTarget = nil; self.error = "Reconnecting… \(error.localizedDescription)"
        }
    }

    private func beginStream(_ session: LiveAgentSession, target: AgentChatTarget, run: UUID) {
        streamTask?.cancel(); streamTarget = target
        beginStatus(session, target: target, run: run)
        beginProgress(session, target: target, run: run)
        streamTask = Task {
            do {
                #if DEBUG && targetEnvironment(simulator)
                if AgentChatFixture.enabled {
                    AgentChatFixture.beginStream(target)
                    while !Task.isCancelled {
                        guard self.target == target, generation == run else { return }
                        let frame = try AgentChatFixture.transcript(target)
                        if frame.kind != .append || !frame.messages.isEmpty || !frame.progressEvents.isEmpty || !frame.queueEvents.isEmpty { accept(frame) }
                        try await Task.sleep(for: .milliseconds(500))
                    }
                    return
                }
                #endif
                let updates = PhrenConnection.chatUpdates(host: session.host, privateKey: try DeviceSSHKey.load(session.host.id), target: target)
                for try await frame in updates {
                    try Task.checkCancellation()
                    guard self.target == target, generation == run else { return }
                    accept(frame)
                }
                throw LiveConnectionError.disconnected
            } catch {
                guard !Task.isCancelled, generation == run, self.target == target else { return }
                handleStreamFailure(error, target: target)
            }
        }
    }
    func accept(_ frame: AgentChatTranscript) {
        if frame.kind == .backlog { question = nil }
        for event in frame.questionEvents {
            switch event {
            case .question(let prompt): if !answeredQuestions.contains(prompt.id) { question = prompt }
            case .resolved(let id): if question?.id == id { question = nil }
            }
        }
        reveal.receive(frame, previous: messages, animated: animateReplies && hasTranscript)
        if frame.messages.contains(where: { $0.line > submittedAfterLine && $0.role != .user }) { awaitingReply = false }
        if !progressConnected, !frame.progressEvents.isEmpty { acceptProgress(frame) }
        acceptContext(frame)
        mergeHistory(frame); hasTranscript = true; connected = true; receivedAt = .now; error = nil; loading = false
        reconcileHandedOffQueue()
        scheduleDrain()
    }

    @ObservationIgnored private var reconciledQueueRows: Set<String> = []
    private func reconcileHandedOffQueue() {
        guard !queue.isEmpty else { return }
        var observed = messages.filter { $0.role == .user && $0.localCommand == nil
            && !reconciledQueueRows.contains($0.id) && !reconciledQueueRows.contains(history.acknowledgementID(for: $0.id)) }
        queue.removeAll { item in
            guard let after = item.submittedAfterLine, let text = item.submittedText else { return false }
            let wanted = AgentQueuedMessages.normalizedText(text)
            guard let index = observed.firstIndex(where: { row in
                guard row.line > after else { return false }
                if row.text == text { return true }
                let have = AgentQueuedMessages.normalizedText(row.text)
                if !wanted.isEmpty { return have == wanted }
                // Pictures with no words of their own: the landed turn is the
                // image blocks (or the placeholder the parser gives them).
                return !item.attachments.isEmpty && have.isEmpty && (!row.imageBlocks.isEmpty || !row.uploadImages.isEmpty || row.text == "[Image attachment]")
            }) else { return false }
            let id = observed.remove(at: index).id
            reconciledQueueRows.insert(id)
            reconciledQueueRows.insert(history.acknowledgementID(for: id))
            return true
        }
        if reconciledQueueRows.count > 4_000 { reconciledQueueRows.formIntersection(messages.flatMap { [$0.id, history.acknowledgementID(for: $0.id)] }) }
        if let target { AgentChatQueues.reconciledRows[target.id] = reconciledQueueRows }
    }

    /// A backlog replaces what the transcript said (the conversation was
    /// reopened or reset); an append or older page only adds to it.
    private func acceptContext(_ frame: AgentChatTranscript) {
        if frame.kind == .backlog { transcriptContext = frame.context } else { transcriptContext.merge(frame.context) }
        if let name = transcriptContext.modelName, modelName != name { modelName = name }
    }

    private func mergeHistory(_ frame: AgentChatTranscript) {
        var updated = history
        updated.receive(frame)
        if updated != history { history = updated }
    }

    func acceptProgress(_ frame: AgentChatTranscript) {
        let previous = progress.activityLine
        progress.receive(frame)
        if progress.activityLine != previous { preferProgressActivity = true }
        if frame.progressEvents.contains(where: { event in
            guard event.line > submittedAfterLine else { return false }
            switch event.value { case .started, .finished, .stopped: return true; default: return false }
        }) { awaitingReply = false }
    }

    private func beginProgress(_ session: LiveAgentSession, target: AgentChatTarget, run: UUID) {
        // Phren Hook includes real lifecycle and usage events in the chat stream.
        progressTask?.cancel(); progressTask = nil
        progressConnected = false; progressUnavailable = false
    }

    private func beginStatus(_ session: LiveAgentSession, target: AgentChatTarget, run: UUID) {
        statusTask?.cancel(); interactionConnected = false; approval = nil
        let statusRun = UUID(); statusGeneration = statusRun
        statusTask = Task {
            while !Task.isCancelled {
                do {
                    #if DEBUG && targetEnvironment(simulator)
                    if AgentChatFixture.enabled {
                        guard self.target == target, generation == run, statusGeneration == statusRun else { return }
                        approval = try AgentChatFixture.approval(target)
                        if !ProcessInfo.processInfo.arguments.contains("--chat-streaming") {
                            acceptActivity(try AgentChatFixture.panes(session).validate(target).agentStatus)
                        }
                        interactionConnected = true
                        await ApprovalActivityController.shared.sync(approval, session: session, target: target)
                        try await Task.sleep(for: .milliseconds(250))
                        continue
                    }
                    #endif
                    for try await status in PhrenConnection.interactionUpdates(host: session.host, privateKey: try DeviceSSHKey.load(session.host.id), target: target) {
                        try Task.checkCancellation()
                        guard self.target == target, generation == run, statusGeneration == statusRun else { return }
                        if awaitingReply, liveActivity != "working", status.activity == "working" { awaitingReply = false }
                        approval = status.approval.flatMap { ApprovalActivityController.shared.wasHandled($0, target: target) ? nil : $0 }
                        questionsSupported = status.questionsSupported; acceptActivity(status.activity); interactionConnected = true
                        if let name = status.modelName, modelName != name { modelName = name }
                        if statusBranch != status.branch { statusBranch = status.branch }
                        if approval != nil || ["waiting", "blocked"].contains(status.activity ?? "") { awaitingReply = false }
                        await ApprovalActivityController.shared.sync(approval, session: session, target: target)
                    }
                } catch {}
                guard !Task.isCancelled, self.target == target, generation == run, statusGeneration == statusRun else { return }
                approval = nil; interactionConnected = false
                do { try await Task.sleep(for: .seconds(3)) } catch { return }
            }
        }
    }

    /// `updatedInput` answers a Claude AskUserQuestion approval: its own input
    /// plus the chosen answers, sent with the approval.
    func answer(_ session: LiveAgentSession, approval expected: AgentApproval? = nil, approve: Bool = false, updatedInput: [String: Any]? = nil,
                question prompt: AgentQuestionPrompt? = nil, selections: [[Int]] = []) async {
        guard !answering, !sending, let target else { return }
        guard (expected != nil && expected == approval && interactionConnected)
            || (prompt != nil && prompt == question && needsAnswer && connected) else { return }
        answering = true; deliveryError = nil
        defer { answering = false }
        if let expected { await ApprovalActivityController.shared.answered(target: target, actionID: expected.id) }
        do {
            #if DEBUG && targetEnvironment(simulator)
            if AgentChatFixture.enabled {
                AgentChatFixture.answered = true; AgentChatFixture.denied = expected != nil && !approve
                AgentChatFixture.answeredInput = updatedInput
            } else { try await submitAnswer(session, target: target, approval: expected, approve: approve, updatedInput: updatedInput, question: prompt, selections: selections) }
            #else
            try await submitAnswer(session, target: target, approval: expected, approve: approve, updatedInput: updatedInput, question: prompt, selections: selections)
            #endif
            guard self.target == target else { return }
            if approval?.id == expected?.id { approval = nil }
            if let prompt { answeredQuestions.insert(prompt.id); if question?.id == prompt.id { question = nil } }
            deliveryStatus = "Answer sent"
        } catch {
            guard self.target == target else { return }
            if approval?.id == expected?.id { approval = nil }
            if question?.id == prompt?.id { question = nil }
            deliveryError = "Answer wasn't confirmed. Check the current prompt, then try again. Your answer hasn't been retried."
        }
    }
    private func submitAnswer(_ session: LiveAgentSession, target: AgentChatTarget, approval: AgentApproval?, approve: Bool, updatedInput: [String: Any]?,
                              question: AgentQuestionPrompt?, selections: [[Int]]) async throws {
        let key = try DeviceSSHKey.load(session.host.id)
        if let approval { try await PhrenConnection.answerApproval(host: session.host, privateKey: key, target: target, actionID: approval.actionId, approve: approve, updatedInput: updatedInput) }
        else if let question { try await PhrenConnection.answerQuestions(host: session.host, privateKey: key, target: target, prompt: question, selections: selections) }
    }

    var historyError: String?

    func showLatest() {
        history = .init(); reveal.finish(); hasTranscript = false
        streamTask?.cancel(); streamTask = nil; streamTarget = nil
        connected = false; loading = true; historyError = nil
    }

    func loadOlder(_ session: LiveAgentSession) async {
        guard !loadingHistory, let target, let before = history.startLine, before > 0 else { return }
        loadingHistory = true; historyError = nil
        defer { loadingHistory = false }
        do {
            let page: AgentChatTranscript
            #if DEBUG && targetEnvironment(simulator)
            if AgentChatFixture.enabled { page = try AgentChatFixture.older(target, beforeLine: before) }
            else { page = try await PhrenConnection.chatHistory(host: session.host, privateKey: DeviceSSHKey.load(session.host.id), target: target, beforeLine: before) }
            #else
            page = try await PhrenConnection.chatHistory(host: session.host, privateKey: DeviceSSHKey.load(session.host.id), target: target, beforeLine: before)
            #endif
            guard !Task.isCancelled, self.target == target else { return }
            mergeHistory(page)
            await preparationTask?.value
        } catch is CancellationError {
        } catch {
            guard !Task.isCancelled, self.target == target else { return }
            historyError = "Couldn't load earlier messages. Scroll up to retry."
        }
    }

    func stop(_ session: LiveAgentSession) async {
        guard !stopping, !sending, connected, !needsAnswer, let target else { return }
        stopping = true; deliveryError = nil
        defer { stopping = false }
        do {
            #if DEBUG && targetEnvironment(simulator)
            if AgentChatFixture.enabled { AgentChatFixture.stopped = true }
            else { try await PhrenConnection.stopChatTurn(host: session.host, privateKey: DeviceSSHKey.load(session.host.id), target: target) }
            #else
            try await PhrenConnection.stopChatTurn(host: session.host, privateKey: DeviceSSHKey.load(session.host.id), target: target)
            #endif
            deliveryStatus = "Stop requested"
        } catch { deliveryError = "Stop wasn't confirmed. \(error.localizedDescription)" }
        scheduleDrain()
    }

    // MARK: - Queue

    /// Delivers a queued message now, ahead of the agent finishing — the
    /// "steer" case. On failure the item stays queued with the error shown.
    func sendNow(_ item: QueuedMessage, _ session: LiveAgentSession) async {
        guard !sending, connected, let index = queue.firstIndex(where: { $0.id == item.id }), queue[index].submittedAfterLine == nil else { return }
        let sendingTarget = target
        let result = await deliver(item.text, attachments: queue[index].attachments, session: session) { text in
            if self.target == sendingTarget, let index = self.queue.firstIndex(where: { $0.id == item.id }) {
                self.queue[index].submittedAfterLine = self.history.totalLines - 1
                self.queue[index].submittedText = text
            }
        }
        guard target == sendingTarget, let index = queue.firstIndex(where: { $0.id == item.id }) else { return }
        queue[index].attachments = result.attachments
        if result.rejected { queue[index].submittedAfterLine = nil; queue[index].submittedText = nil }
        reconcileHandedOffQueue()
        scheduleDrain()
    }

    func remove(_ item: QueuedMessage) {
        queue.removeAll { $0.id == item.id && $0.submittedAfterLine == nil }
    }

    /// Pulls a queued message back into the composer to change it.
    func edit(_ item: QueuedMessage) {
        guard let index = queue.firstIndex(where: { $0.id == item.id }), queue[index].submittedAfterLine == nil else { return }
        let item = queue.remove(at: index)
        draft = draft.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty ? item.text : draft + "\n" + item.text
        attachments += item.attachments.filter { queued in !attachments.contains { $0.id == queued.id } }
    }

    /// Sends the next queued message once the agent is free. Debounced: the
    /// status stream and the transcript both report the turn ending, and a
    /// reply's last frames arrive a beat after the status flips.
    private func scheduleDrain() {
        guard let next = queue.first, next.submittedAfterLine == nil, !isBusy, !sending, connected, drainTask == nil, let session = lastSession else { return }
        drainTask = Task { @MainActor [weak self] in
            defer { self?.drainTask = nil }
            do { try await Task.sleep(for: .milliseconds(400)) } catch { return }
            guard let self, let next = queue.first, !isBusy, !sending, connected, lastSession == session else { return }
            await sendNow(next, session)
        }
    }

    /// Uploads can be reused after failure; prompt delivery is never replayed.
    func send(_ session: LiveAgentSession) async {
        guard !sending, connected, approval == nil, target != nil,
              !(needsAnswer && question != nil && questionsSupported),
              !draft.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || !attachments.isEmpty else { return }
        guard !AgentSlashCommand.isCommand(draft) || attachments.isEmpty else {
            deliveryError = "Remove attachments before running a slash command."; return
        }
        lastSession = session
        let submitted = draft, items = attachments
        // Claude Code owns its mid-turn queue through the normal prompt RPC.
        // Other harnesses keep an unsent local draft until they finish.
        if isBusy, target?.source != "claude", !AgentSlashCommand.isCommand(submitted) {
            queue.append(QueuedMessage(text: submitted, attachments: items))
            draft = ""; attachments = []; deliveryError = nil
            persistDraft(immediately: true)
            return
        }
        let optimistic = QueuedMessage(text: submitted, attachments: items)
        let sendingTarget = target
        let result = await deliver(submitted, attachments: items, session: session) { text in
            guard self.target == sendingTarget, !AgentSlashCommand.isCommand(submitted) else { return }
            var pending = optimistic
            pending.submittedAfterLine = self.history.totalLines - 1
            pending.submittedText = text
            self.queue.append(pending)
        }
        guard target == sendingTarget else { return }
        if result.rejected { queue.removeAll { $0.id == optimistic.id } }
        else if let index = queue.firstIndex(where: { $0.id == optimistic.id }) { queue[index].attachments = result.attachments }
        reconcileHandedOffQueue()
        for uploaded in result.attachments {
            if let index = attachments.firstIndex(where: { $0.id == uploaded.id }) { attachments[index].path = uploaded.path }
        }
        guard result.delivered else { return }
        if draft == submitted { draft = "" }
        attachments.removeAll { item in items.contains { $0.id == item.id } }
        persistDraft(immediately: true)
    }

    /// Uploads any attachments that still lack a path, then delivers the
    /// prompt. Returns the attachments with the paths that did upload, so a
    /// retry never re-uploads; prompt delivery itself is never replayed.
    private func deliver(_ submitted: String, attachments items: [ChatAttachmentDraft], session: LiveAgentSession,
                         submittedToAgent: (String) -> Void = { _ in }) async -> (delivered: Bool, attachments: [ChatAttachmentDraft], rejected: Bool) {
        guard let target else { return (false, items, true) }
        var sent = items
        sending = true; deliveryError = nil
        defer { sending = false; deliveryStatus = nil }
        do {
            for index in sent.indices where sent[index].path == nil {
                deliveryStatus = "Uploading \(index + 1) of \(sent.count)…"
                let path: String
                #if DEBUG && targetEnvironment(simulator)
                if AgentChatFixture.enabled { path = try AgentChatFixture.upload(sent[index].attachment) }
                else { path = try await PhrenConnection.uploadChatAttachment(host: session.host, privateKey: DeviceSSHKey.load(session.host.id), target: target, attachment: sent[index].attachment) }
                #else
                path = try await PhrenConnection.uploadChatAttachment(host: session.host, privateKey: DeviceSSHKey.load(session.host.id), target: target, attachment: sent[index].attachment)
                #endif
                try Task.checkCancellation()
                sent[index].path = path
            }
        } catch {
            deliveryError = "Attachment upload didn't finish. Your message hasn't been sent. \(error.localizedDescription)"
            return (false, sent, true)
        }
        let paths = sent.compactMap { $0.path }.joined(separator: "\n")
        let text = paths.isEmpty ? submitted : submitted + "\n\nAttached files on this computer:\n" + paths
        deliveryStatus = "Sending…"
        submittedAfterLine = max(0, history.totalLines) - 1
        sentAt = .now; awaitingReply = true
        submittedToAgent(text)
        do {
            #if DEBUG && targetEnvironment(simulator)
            if AgentChatFixture.enabled { try await AgentChatFixture.send(target, text: text) }
            else { try await PhrenConnection.sendChat(host: session.host, privateKey: DeviceSSHKey.load(session.host.id), target: target, text: text) }
            #else
            try await PhrenConnection.sendChat(host: session.host, privateKey: DeviceSSHKey.load(session.host.id), target: target, text: text)
            #endif
            if AgentSlashCommand.isCommand(submitted) { awaitingReply = false; sentAt = nil }
            // Keep small local previews, not full uploaded files, in the conversation.
            let previews = await Task.detached(priority: .userInitiated) {
                sent.filter { $0.attachment.isImage }.compactMap { item in
                    ChatAttachmentPreparation.preview(item.attachment).map { ChatAttachmentDraft(attachment: $0, path: item.path) }
                }
            }.value
            guard self.target == target else { return (true, sent, false) }
            sentImages += previews
            if sentImages.count > 16 { sentImages.removeFirst(sentImages.count - 16) }
            return (true, sent, false)
        } catch {
            awaitingReply = false
            deliveryError = "Delivery wasn't confirmed. Check the conversation before trying again. \(error.localizedDescription)"
            let rejected: Bool
            if case LiveConnectionError.gatewayRejection(let status, _) = error { rejected = (400..<500).contains(status) }
            else { rejected = error is PhrenKitError }
            return (false, sent, rejected)
        }
    }
    static func fetchPanes(_ session: LiveAgentSession) async throws -> AgentChatPanes {
        #if DEBUG && targetEnvironment(simulator)
        if AgentChatFixture.enabled {
            if ProcessInfo.processInfo.arguments.contains("--chat-opening-slow"), AgentChatFixture.reads == 0 {
                try await Task.sleep(for: .seconds(6))
            }
            return try AgentChatFixture.panes(session)
        }
        #endif
        return try await PhrenConnection.chatPanes(host: session.host, privateKey: DeviceSSHKey.load(session.host.id), workspaceID: session.workspaceID, tabID: session.tab.id)
    }
}
