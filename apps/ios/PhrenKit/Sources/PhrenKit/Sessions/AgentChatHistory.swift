import Foundation

/// Merge reconnect snapshots, live appends, and older pages by absolute line.
public struct AgentChatHistory: Equatable, Sendable {
    public private(set) var messages: [AgentChatMessage] = []
    public private(set) var startLine: Int?
    public private(set) var totalLines = 0
    public private(set) var hasMore = false
    public private(set) var hasNewer = false
    private var consumedQueueEvents: Set<AgentQueueConsumption> = []
    private var assignedQueueEvents: Set<AgentQueueConsumption> = []
    private var consumedQueueMessages: Set<String> = []
    private var replacedQueueMessages: [String: String] = [:]
    private struct RetiredQueue: Equatable, Sendable {
        let id: String
        let line: Int
        let key: String
    }
    private var retiredQueue: [RetiredQueue] = []
    private var acknowledgementIDs: [String: String] = [:]
    public init() {}

    public func acknowledgementID(for messageID: String) -> String { acknowledgementIDs[messageID] ?? messageID }

    public mutating func receive(_ frame: AgentChatTranscript) {
        // A reconnect page can lag behind rows the phone already retained.
        // Conversation selection owns resets; a lower count cannot prove one.
        var merged = Dictionary(uniqueKeysWithValues: messages.map { ($0.id, $0) })
        for message in frame.messages where replacedQueueMessages[message.id] == nil {
            // Once browsing beyond the retained live window, incoming output
            // must not evict the older messages the user is reading.
            if !hasNewer || frame.kind == .older || merged[message.id] != nil { merged[message.id] = message }
        }
        messages = merged.values.sorted { ($0.line, $0.id) < ($1.line, $1.id) }
        consumedQueueEvents.formUnion(frame.queueEvents)
        // Repeated real turns are legitimate. Only pair pending handoffs.
        for index in messages.indices where messages[index].wasQueued {
            messages[index].isQueued = !consumedQueueMessages.contains(messages[index].id)
        }
        for event in consumedQueueEvents.sorted(by: { $0.line < $1.line }) where !assignedQueueEvents.contains(event) {
            let index = messages.firstIndex(where: { $0.isQueued && $0.queueKey == event.key && $0.line < event.line })
            let retired = retiredQueue.first { $0.key == event.key && $0.line < event.line && !consumedQueueMessages.contains($0.id) }
            if let retired, retired.line < (index.map { messages[$0].line } ?? Int.max) {
                assignedQueueEvents.insert(event); consumedQueueMessages.insert(retired.id)
            } else if let index {
                messages[index].isQueued = false
                assignedQueueEvents.insert(event)
                consumedQueueMessages.insert(messages[index].id)
            }
        }
        let pageIDs = Set((frame.kind == .append ? messages : frame.messages).map(\.id))
        let replacements = AgentQueuedMessages.replacements(in: messages, pageIDs: pageIDs, acknowledgedRealIDs: Set(acknowledgementIDs.keys))
        replacedQueueMessages.merge(replacements) { _, new in new }
        for message in messages {
            guard let realID = replacements[message.id] else { continue }
            acknowledgementIDs[realID] = message.id
            if let key = message.queueKey { retiredQueue.append(.init(id: message.id, line: message.line, key: key)) }
        }
        retiredQueue.sort { $0.line < $1.line }
        // Older Hooks cannot identify removals. Stop drawing an unkeyed row
        // as pending after the next real user turn, without inventing a twin.
        var hasRealTurn = false
        for index in messages.indices.reversed() {
            if messages[index].role == .user, !messages[index].wasQueued, messages[index].localCommand == nil { hasRealTurn = true }
            if hasRealTurn, messages[index].wasQueued, messages[index].queueKey == nil {
                messages[index].isQueued = false; consumedQueueMessages.insert(messages[index].id)
            }
        }
        messages.removeAll { replacedQueueMessages[$0.id] != nil }
        if replacedQueueMessages.count > 4_000 {
            let retained = Set(messages.map(\.id))
            replacedQueueMessages = replacedQueueMessages.filter { retained.contains($0.value) }
            acknowledgementIDs = acknowledgementIDs.filter { retained.contains($0.key) }
            retiredQueue = Array(retiredQueue.suffix(4_000))
        }
        totalLines = max(totalLines, frame.totalLines)
        if frame.kind != .append, let start = frame.startLine, start <= (startLine ?? Int.max) {
            startLine = start; hasMore = frame.hasMore
        }
        if frame.kind == .older && !frame.hasMore {
            // The beginning can contain only metadata/private events. An empty
            // final page must still finish pagination on older Hook versions.
            hasMore = false
        }
        if consumedQueueEvents.count > 4_000 {
            consumedQueueEvents = Set(consumedQueueEvents.sorted { $0.line > $1.line }.prefix(4_000))
            assignedQueueEvents.formIntersection(consumedQueueEvents)
            consumedQueueMessages.formIntersection(messages.map(\.id) + retiredQueue.map(\.id))
        }
        var bytes = 0, keep = 0
        let retainOlder = frame.kind == .older || hasNewer
        let ordered = retainOlder ? messages : Array(messages.reversed())
        for message in ordered {
            bytes += message.textByteCount
            if bytes > 12 * 1_024 * 1_024 || keep >= 4_000 { break }
            keep += 1
        }
        if keep < messages.count {
            if retainOlder {
                messages = Array(messages.prefix(keep)); hasNewer = true
            } else {
                messages = Array(messages.suffix(keep)); startLine = messages.first?.line
                hasMore = (startLine ?? 0) > 0
            }
        }
    }
}
