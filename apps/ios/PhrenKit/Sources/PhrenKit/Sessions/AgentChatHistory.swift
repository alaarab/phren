import Foundation

/// Merge reconnect snapshots, live appends, and older pages by absolute line.
public struct AgentChatHistory: Equatable, Sendable {
    public private(set) var messages: [AgentChatMessage] = []
    public private(set) var startLine: Int?
    public private(set) var totalLines = 0
    public private(set) var hasMore = false
    public private(set) var hasNewer = false
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
        totalLines = max(totalLines, frame.totalLines)
        if frame.kind != .append, let start = frame.startLine, start <= (startLine ?? Int.max) {
            startLine = start; hasMore = frame.hasMore
        }
        if frame.kind == .older && !frame.hasMore {
            // The beginning can contain only metadata/private events. An empty
            // final page must still finish pagination on older Hook versions.
            hasMore = false
        }
        var bytes = 0, keep = 0
        let retainOlder = frame.kind == .older || hasNewer
        let ordered = retainOlder ? messages : Array(messages.reversed())
        for message in ordered {
            bytes += message.text.utf8.count
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
