import Observation
import PhrenKit

/// Smooth only newly received assistant text. History, reconnect snapshots,
/// and accessibility modes reveal immediately; this does not generate tokens.
@Observable @MainActor
final class ChatTextReveal {
    private struct Pending {
        let id: String
        let text: String
        let ends: [String.Index]
        var next: Int
    }
    private var pending: [Pending] = []
    private var wordsPerTick = 1
    private(set) var visible: [String: String] = [:]
    private(set) var revision = 0
    var isRevealing: Bool { !pending.isEmpty }

    func receive(_ frame: AgentChatTranscript, previous: [AgentChatMessage], animated: Bool) {
        guard animated, frame.kind == .append else { finish(); return }
        let old = Dictionary(uniqueKeysWithValues: previous.map { ($0.id, $0.text) })
        for message in frame.messages where message.role == .assistant {
            guard old[message.id] != message.text else { continue }
            let start = visible[message.id] ?? old[message.id] ?? ""
            guard message.text.hasPrefix(start) else {
                pending.removeAll { $0.id == message.id }; visible.removeValue(forKey: message.id); continue
            }
            let ends = Self.boundaries(message.text)
            let startIndex = message.text.index(message.text.startIndex, offsetBy: start.count)
            let next = ends.firstIndex(where: { $0 > startIndex }) ?? ends.count
            let entry = Pending(id: message.id, text: message.text, ends: ends, next: next)
            if let index = pending.firstIndex(where: { $0.id == message.id }) { pending[index] = entry }
            else { pending.append(entry) }
            visible[message.id] = start
        }
        // Only a bounded burst is animated; large backfills remain immediately readable.
        if pending.count > 8 { finish() }
        let remaining = pending.reduce(0) { $0 + $1.ends.count - $1.next }
        wordsPerTick = max(wordsPerTick, (remaining + 74) / 75)
    }

    /// Called at 30 Hz only while text is pending. Long bursts catch up within
    /// a few seconds instead of delaying the next actionable result.
    func advance() {
        guard !pending.isEmpty else { return }
        var budget = wordsPerTick
        while budget > 0, !pending.isEmpty {
            var entry = pending.removeFirst()
            let count = min(budget, entry.ends.count - entry.next)
            entry.next += count; budget -= count
            if entry.next >= entry.ends.count { visible.removeValue(forKey: entry.id) }
            else {
                visible[entry.id] = String(entry.text[..<entry.ends[entry.next - 1]])
                pending.insert(entry, at: 0)
            }
        }
        revision &+= 1
        if pending.isEmpty { wordsPerTick = 1 }
    }

    func finish() {
        guard isRevealing || !visible.isEmpty else { return }
        pending = []; visible = [:]; wordsPerTick = 1; revision &+= 1
    }

    private static func boundaries(_ text: String) -> [String.Index] {
        var ends: [String.Index] = [], wordLength = 0
        for index in text.indices {
            let next = text.index(after: index)
            wordLength += 1
            if text[index].isWhitespace || wordLength >= 12 || next == text.endIndex {
                ends.append(next); wordLength = 0
            }
        }
        return ends
    }
}
