import Foundation
import PhrenKit

/// Only source changes enter preparation. The view's one-second clock never does.
struct ChatActivityContext: Equatable {
    var turns: [AgentChatProgress.Turn] = []
    var harnessVerb: String?
    var submittedAt: Date?
    var submittedAfterLine = -1
    var busy = false
    var waiting = false
}

struct ChatTurnActivity: Equatable {
    let ownerID: String
    let startedAt: Date
    let finishedAt: Date?
    let phase: AgentChatProgress.Phase
    let verb: String
    var isLive: Bool { phase == .working }
    var identifier: String { isLive ? "chat-activity" : "chat-activity-done" }

    func label(at now: Date) -> String {
        let elapsed = AgentChatProgress.elapsed(startedAt: startedAt, finishedAt: finishedAt, phase: phase, at: now) ?? 0
        return "\(verb) \(Self.duration(elapsed))"
    }

    static func duration(_ elapsed: TimeInterval) -> String {
        let seconds = Int(max(0, elapsed).rounded(.down))
        return seconds < 60 ? "\(seconds)s" : "\(seconds / 60)m " + String(format: "%02ds", seconds % 60)
    }
}

extension ChatTranscriptPreparation {
    /// Own the row before SwiftUI sees it, including the placeholder's identity.
    static func attachingActivity(to entries: [ChatTimelineEntry], messages: [AgentChatMessage], context: ChatActivityContext) -> [ChatTimelineEntry] {
        let users = messages.filter { $0.role == .user && !$0.isQueued && $0.localCommand == nil && !$0.isCompaction }
        var insertions: [Int: [ChatTimelineEntry]] = [:]
        var live: ChatTurnActivity?
        for (index, turn) in context.turns.enumerated() {
            guard let start = turn.startedAt else { continue }
            let previousEnd = index > 0 ? (context.turns[index - 1].endLine ?? context.turns[index - 1].startLine) : -1
            let end = turn.endLine ?? (index + 1 < context.turns.count ? context.turns[index + 1].startLine - 1 : Int.max)
            guard let owner = users.last(where: { $0.line > previousEnd && $0.line <= turn.startLine })
                ?? users.first(where: { $0.line >= turn.startLine && $0.line <= end }) else { continue }
            let nextUser = users.first { $0.line > owner.line }?.line ?? Int.max
            let rows = messages.filter { $0.line > owner.line && $0.line < nextUser && $0.line <= end }
            let calls = rows.filter { $0.role == .tool && !$0.isToolResult && !$0.isChange && !$0.isCompaction && $0.title != "Background notification" }
            if turn.phase == .working {
                guard index == context.turns.count - 1, context.busy, !context.waiting else { continue }
                live = .init(ownerID: owner.id, startedAt: start, finishedAt: nil, phase: .working,
                             verb: context.harnessVerb ?? liveVerb(rows: rows, calls: calls))
            } else if turn.finishedAt != nil {
                let activity = ChatTurnActivity(ownerID: owner.id, startedAt: start, finishedAt: turn.finishedAt, phase: turn.phase,
                    verb: turn.phase == .stopped ? "Stopped after" : calls.isEmpty ? "Thought for" : "Worked for")
                // The final assistant text is the reply; earlier text can be tool commentary.
                let reply = rows.last { $0.role == .assistant && $0.localCommand == nil }
                let anchor = reply ?? users.first { $0.line > owner.line }
                let position = anchor.flatMap { anchor in entries.firstIndex { $0.messages.contains { $0.id == anchor.id } } } ?? entries.count
                insertions[position, default: []].append(activityEntry(activity))
            }
        }
        // Cover submit-to-acknowledgement latency without inventing a persisted start.
        if live == nil, context.busy, !context.waiting, let start = context.submittedAt,
           !context.turns.contains(where: { $0.startLine > context.submittedAfterLine }) {
            let owner = users.first { $0.line > context.submittedAfterLine }
            let rows = messages.filter { $0.line > (owner?.line ?? context.submittedAfterLine) }
            let calls = rows.filter { $0.role == .tool && !$0.isToolResult && !$0.isChange && !$0.isCompaction }
            live = .init(ownerID: owner?.id ?? "submission:\(start.timeIntervalSince1970)", startedAt: start,
                         finishedAt: nil, phase: .working, verb: context.harnessVerb ?? liveVerb(rows: rows, calls: calls))
        }
        var result: [ChatTimelineEntry] = []
        for index in 0...entries.count {
            result += insertions[index] ?? []
            if index < entries.count { result.append(entries[index]) }
        }
        if let live { result.append(activityEntry(live)) }
        return result
    }

    private static func liveVerb(rows: [AgentChatMessage], calls: [AgentChatMessage]) -> String {
        let completed = Set(rows.filter(\.isToolResult).compactMap(\.toolCallID))
        if let call = calls.last(where: { call in
            if let id = call.toolCallID { return !completed.contains(id) && !ChatBackgroundJobs.isBackground(call) }
            return !rows.contains { $0.isToolResult && $0.line > call.line }
        }) { return ToolPresentationCache.value(call).activityVerb }
        if rows.contains(where: { $0.role == .assistant && !$0.text.isEmpty }) { return "Responding" }
        return calls.isEmpty ? "Thinking" : "Working"
    }

    private static func activityEntry(_ activity: ChatTurnActivity) -> ChatTimelineEntry {
        var entry = ChatTimelineEntry(messages: [], turnActivity: activity)
        entry.placeholderIdentifier = activity.identifier
        entry.placeholderLabel = activity.label(at: activity.finishedAt ?? activity.startedAt)
        return entry
    }
}
