import Foundation

public enum AgentQueuedMessages {
    private static let imageMarker = try! NSRegularExpression(pattern: #"\[Image #\d+\]|\[Image attachment\]"#)

    /// Compare the instruction, independent of Claude's pasted-image labels
    /// and attachment footer. This is used only for pending → real handoff,
    /// never to deduplicate two ordinary user turns.
    public static func normalizedText(_ text: String) -> String {
        var value = imageMarker.stringByReplacingMatches(in: text, range: NSRange(text.startIndex..., in: text), withTemplate: "")
        // Drop each footer and the file paths under it, but keep any text
        // after them: Claude joins queued messages into one turn, so a later
        // message can follow a footer directly ("…computer:Next message").
        while let footer = value.range(of: "Attached files on this computer:") {
            var rest = value[footer.upperBound...]
            while let line = rest.firstIndex(where: { !$0.isNewline }).map({ rest[$0...] }),
                  line.hasPrefix("/") || line.hasPrefix("~/") {
                rest = line.firstIndex(where: \.isNewline).map { line[$0...] } ?? ""
            }
            value = String(value[..<footer.lowerBound]) + "\n" + rest
        }
        return value.split(whereSeparator: \.isWhitespace).joined(separator: " ")
    }

    /// Pair one real turn with one earlier queue row, preferring its key.
    /// Text fallback is limited to the caller's current page (or live window).
    static func replacements(in messages: [AgentChatMessage], pageIDs: Set<String>, acknowledgedRealIDs: Set<String>) -> [String: String] {
        var pending: [AgentChatMessage] = [], normalized: [String: String] = [:]
        var replaced: [String: String] = [:]
        for message in messages where message.role == .user && message.localCommand == nil {
            if message.wasQueued {
                pending.append(message)
                if pageIDs.contains(message.id) { normalized[message.id] = normalizedText(message.text) }
            } else {
                guard !pending.isEmpty, !acknowledgedRealIDs.contains(message.id) else { continue }
                var index: Int?
                if let key = message.queueKey { index = pending.firstIndex { $0.queueKey == key } }
                if index == nil, pageIDs.contains(message.id) {
                    let text = normalizedText(message.text)
                    if !text.isEmpty {
                        index = pending.firstIndex { queued in
                            // Conflicting known keys always mean distinct sends.
                            (message.queueKey == nil || queued.queueKey == nil)
                                && normalized[queued.id] == text
                        }
                    }
                }
                if let index { replaced[pending.remove(at: index).id] = message.id }
            }
        }
        return replaced
    }
}
