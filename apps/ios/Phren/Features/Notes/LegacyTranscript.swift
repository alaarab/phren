import Foundation

/// `SFSpeechRecognizer` on the phone can start its transcription over after a
/// pause without ending the request: the next partial holds only the words
/// said since. This keeps what it had, so a restart never erases words that
/// were already in the message.
struct LegacyTranscript: Equatable {
    /// A partial arriving at least this long after the last one may be a restart.
    static let pause: TimeInterval = 0.8

    private(set) var banked = ""
    private var last = ""
    private var lastAt = -TimeInterval.infinity

    var text: String { AnalyzerTranscript.join(banked, last) }

    mutating func accept(_ partial: String, at now: TimeInterval) -> String {
        if Self.isRestart(from: last, to: partial, gap: now - lastAt) {
            banked = AnalyzerTranscript.join(banked, last)
        }
        last = partial
        lastAt = now
        return text
    }

    /// A revision keeps about as many words and its opening; a restart has
    /// fewer words and, after a pause, no longer begins where the old one did.
    static func isRestart(from old: String, to new: String, gap: TimeInterval) -> Bool {
        let before = words(old), after = words(new)
        guard !before.isEmpty, !after.isEmpty, after.count < before.count else { return false }
        if after.first != before.first { return gap >= pause || after.count * 2 <= before.count }
        // Same first word: only a pause followed by far fewer words is a restart.
        return gap >= pause && after.count < before.count - 1 && !before.starts(with: after)
    }

    private static func words(_ text: String) -> [String] {
        text.lowercased().split { !$0.isLetter && !$0.isNumber }.map(String.init)
    }
}
