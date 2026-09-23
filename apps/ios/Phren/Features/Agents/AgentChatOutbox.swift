import PhrenKit
import PhrenLive
import SwiftUI

/// The chat's held and handed-off messages. Owned by `AgentChatModel`, which
/// decides when a held message may go; this keeps the list, remembers which
/// transcript rows already acknowledged a receipt, and persists the list per
/// conversation through `onChange`.
@Observable @MainActor
final class AgentChatOutbox {
    /// Only readiness blockers hold messages locally. Submitted entries are receipts.
    var items: [QueuedMessage] = [] { didSet { onChange?(items) } }
    /// The held message whose last delivery was not confirmed.
    var failedItem: UUID?
    @ObservationIgnored var drainTask: Task<Void, Never>?
    @ObservationIgnored var reconciledRows: Set<String> = []
    @ObservationIgnored var onChange: (([QueuedMessage]) -> Void)?

    var localPending: [QueuedMessage] { items.filter { $0.submittedAfterLine == nil } }

    func remove(_ item: QueuedMessage) {
        items.removeAll { $0.id == item.id && $0.submittedAfterLine == nil }
    }

    /// Retires a receipt the transcript never showed, for Dismiss or Retry.
    func retire(_ id: UUID) -> QueuedMessage? {
        guard let index = items.firstIndex(where: { $0.id == id && $0.submittedAfterLine != nil }) else { return nil }
        return items.remove(at: index)
    }

    /// Takes a held message out of the list, if it has not been handed off.
    func take(_ item: QueuedMessage) -> QueuedMessage? {
        guard let index = items.firstIndex(where: { $0.id == item.id }), items[index].submittedAfterLine == nil else { return nil }
        return items.remove(at: index)
    }

    /// Retires each receipt once its own user row lands in the transcript.
    func reconcile(history: AgentChatHistory, targetID: String?) {
        guard !items.isEmpty else { return }
        let messages = history.messages
        var observed = messages.filter { $0.role == .user && $0.localCommand == nil
            && !reconciledRows.contains($0.id) && !reconciledRows.contains(history.acknowledgementID(for: $0.id)) }
        items.removeAll { item in
            guard let after = item.submittedAfterLine, let text = item.submittedText else { return false }
            let wanted = AgentQueuedMessages.normalizedText(text)
            guard let index = observed.firstIndex(where: { row in
                guard row.line > after else { return false }
                if row.text == text { return true }
                let have = AgentQueuedMessages.normalizedText(row.text)
                // Claude can join queued sends into one turn, so a message
                // long enough not to match by chance may land inside another.
                if !wanted.isEmpty { return have == wanted || (wanted.count >= 12 && have.contains(wanted)) }
                // Pictures with no words of their own: the landed turn is the
                // image blocks (or the placeholder the parser gives them).
                return !item.attachments.isEmpty && have.isEmpty && (!row.imageBlocks.isEmpty || !row.uploadImages.isEmpty || row.text == "[Image attachment]")
            }) else { return false }
            let id = observed.remove(at: index).id
            reconciledRows.insert(id)
            reconciledRows.insert(history.acknowledgementID(for: id))
            return true
        }
        if reconciledRows.count > 4_000 { reconciledRows.formIntersection(messages.flatMap { [$0.id, history.acknowledgementID(for: $0.id)] }) }
        if let targetID { AgentChatQueues.reconciledRows[targetID] = reconciledRows }
    }
}

extension AgentChatModel {
    // MARK: - Queue

    /// Delivers as soon as the harness can receive input, including mid turn.
    @discardableResult
    func sendNow(_ item: QueuedMessage, _ session: LiveAgentSession) async -> Bool {
        guard !sending, pendingReason == nil,
              let index = queue.firstIndex(where: { $0.id == item.id }), queue[index].submittedAfterLine == nil else { return false }
        let sendingTarget = target
        let result = await deliver(item.text, attachments: queue[index].attachments, session: session) { text in
            if self.target == sendingTarget, let index = self.queue.firstIndex(where: { $0.id == item.id }) {
                self.queue[index].submittedAfterLine = self.history.totalLines - 1
                self.queue[index].submittedText = text
                self.queue[index].submittedAt = .now
            }
        }
        guard target == sendingTarget else { return false }
        outbox.failedItem = result.delivered ? nil : item.id
        if let index = queue.firstIndex(where: { $0.id == item.id }) {
            queue[index].attachments = result.attachments
            if result.rejected { queue[index].submittedAfterLine = nil; queue[index].submittedText = nil; queue[index].submittedAt = nil }
        }
        reconcileHandedOffQueue()
        if result.delivered { scheduleDrain() }
        return result.delivered
    }

    /// A receipt the transcript never showed: Dismiss drops it; Retry puts
    /// its text and attachments back in the composer, since the message may
    /// have arrived after all and a blind resend could duplicate it.
    func resolvePendingEcho(_ id: UUID, retry: Bool) {
        guard let item = outbox.retire(id) else { return }
        if retry { draft = item.text; attachments = item.attachments }
    }

    func remove(_ item: QueuedMessage) {
        outbox.remove(item)
    }

    /// Pulls a queued message back into the composer to change it.
    func edit(_ item: QueuedMessage) {
        guard let item = outbox.take(item) else { return }
        draft = draft.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty ? item.text : draft + "\n" + item.text
        attachments += item.attachments.filter { queued in !attachments.contains { $0.id == queued.id } }
    }

    /// Flush readiness holds as soon as their blocker clears. A working turn
    /// is not a blocker. Receipts and uncertain deliveries never hold up a
    /// later unsent message, and never become eligible for automatic replay.
    func scheduleDrain() {
        guard let next = localPendingMessages.first, next.id != outbox.failedItem,
              pendingReason == nil, !sending, outbox.drainTask == nil, let session = connection.lastSession else { return }
        outbox.drainTask = Task { @MainActor [weak self] in
            var delivered = false
            defer {
                self?.outbox.drainTask = nil
                if delivered { self?.scheduleDrain() }
            }
            guard let self, let next = localPendingMessages.first, next.id != outbox.failedItem,
                  pendingReason == nil, !sending, connection.lastSession == session else { return }
            delivered = await sendNow(next, session)
        }
    }

    func reconcileHandedOffQueue() {
        outbox.reconcile(history: history, targetID: target?.id)
    }
}
