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
    public init() {}

    public mutating func receive(_ frame: AgentChatTranscript) {
        if frame.kind == .backlog && frame.totalLines < totalLines { self = Self() }
        var merged = Dictionary(uniqueKeysWithValues: messages.map { ($0.id, $0) })
        for message in frame.messages {
            // Once browsing beyond the retained live window, incoming output
            // must not evict the older messages the user is reading.
            if !hasNewer || frame.kind == .older || merged[message.id] != nil { merged[message.id] = message }
        }
        messages = merged.values.sorted { ($0.line, $0.id) < ($1.line, $1.id) }
        consumedQueueEvents.formUnion(frame.queueEvents)
        // Repeated text is legitimate. Pair removals FIFO with an earlier
        // enqueue; never deduplicate user bubbles by their content.
        for index in messages.indices where messages[index].wasQueued {
            messages[index].isQueued = !consumedQueueMessages.contains(messages[index].id)
        }
        for event in consumedQueueEvents.sorted(by: { $0.line < $1.line }) where !assignedQueueEvents.contains(event) {
            if let index = messages.firstIndex(where: { $0.isQueued && $0.queueKey == event.key && $0.line < event.line }) {
                messages[index].isQueued = false
                assignedQueueEvents.insert(event)
                consumedQueueMessages.insert(messages[index].id)
            }
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
            consumedQueueMessages.formIntersection(messages.map(\.id))
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
