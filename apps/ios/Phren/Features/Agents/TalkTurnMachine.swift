import Foundation

/// Turn-taking for talk mode, free of audio and networking so it can be
/// tested on its own. The controller feeds it what the microphone heard, a
/// clock tick, and the agent's progress; it answers with what to do.
///
/// Listening ends when the words stop changing and the microphone has been
/// quiet for the chosen pause (longer when the words end mid-thought), unless
/// the pause is Manual or the person held it. While a reply plays, a few
/// recognised words are a barge-in: the reply stops and those words start the
/// next turn.
struct TalkTurnMachine: Equatable {
    enum Phase: Equatable { case off, listening, thinking, speaking }

    enum Event: Equatable {
        case turnOn(at: TimeInterval)
        case turnOff
        /// The words heard so far in the current utterance.
        case heard(String, at: TimeInterval)
        /// Periodic; `voice` is whether the input level says someone is talking.
        case tick(at: TimeInterval, voice: Bool)
        /// A tap on the countdown: keep the turn open while the person thinks.
        case hold
        /// Send what has been heard now, whatever the pause.
        case sendNow
        case sendFailed
        /// The agent's turn ended; `reply` is its final text, already
        /// reduced to what should be read aloud.
        case agentFinished(reply: String)
        case playbackFinished
    }

    enum Action: Equatable {
        /// Listen for a new utterance, dropping any words heard so far.
        case startListening
        case stopListening
        /// Send this utterance and start a fresh one.
        case send(String)
        case speak(String)
        case stopSpeaking
    }

    static let bargeInWords = 2
    /// Extra quiet allowed when the words so far end mid-thought.
    static let midThoughtExtra: TimeInterval = 2
    /// Quiet shorter than this is a breath, not the start of a pause.
    static let countdownDelay: TimeInterval = 0.4
    private static let midThoughtWords: Set<String> = ["and", "so", "but", "um", "uh", "like", "or", "because", "then"]

    /// Seconds of quiet that end a turn; nil never sends on its own (Manual).
    let silence: TimeInterval?
    private(set) var phase = Phase.off
    private(set) var utterance = ""
    /// The person tapped to keep thinking; words or another tap release it.
    private(set) var held = false
    private var lastSpeech: TimeInterval = 0

    init(silence: TimeInterval? = TalkPause.normal.seconds) { self.silence = silence }

    var isOn: Bool { phase != .off }

    /// The quiet this utterance needs before it sends.
    func silenceNeeded(for text: String) -> TimeInterval? {
        guard let silence else { return nil }
        return Self.endsMidThought(text) ? silence + Self.midThoughtExtra : silence
    }

    /// How far the pause has run, 0...1, once it has started and while it can
    /// still end the turn; nil when nothing is counting down.
    func countdown(at now: TimeInterval) -> Double? {
        guard phase == .listening, !held, !utterance.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty,
              let needed = silenceNeeded(for: utterance) else { return nil }
        let quiet = now - lastSpeech
        guard quiet >= Self.countdownDelay else { return nil }
        return min(1, quiet / needed)
    }

    static func endsMidThought(_ text: String) -> Bool {
        let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
        if trimmed.hasSuffix(",") { return true }
        guard let last = trimmed.split(whereSeparator: { !$0.isLetter && !$0.isNumber && $0 != "'" }).last else { return false }
        return midThoughtWords.contains(last.lowercased())
    }

    mutating func handle(_ event: Event) -> [Action] {
        switch (event, phase) {
        case (.turnOn(let now), .off):
            phase = .listening
            utterance = ""
            lastSpeech = now
            return [.startListening]
        case (.turnOn, _):
            return []
        case (.turnOff, .off):
            return []
        case (.turnOff, let current):
            phase = .off
            utterance = ""
            held = false
            return current == .speaking ? [.stopSpeaking, .stopListening] : [.stopListening]

        case (.heard(let text, let now), .listening), (.heard(let text, let now), .thinking):
            // Words spoken while the agent works wait for the next turn.
            if text != utterance {
                utterance = text
                lastSpeech = now
                held = false
            }
            return []
        case (.heard(let text, let now), .speaking):
            guard Self.wordCount(text) >= Self.bargeInWords else { return [] }
            phase = .listening
            utterance = text
            lastSpeech = now
            return [.stopSpeaking]
        case (.heard, .off):
            return []

        case (.tick(let now, let voice), .listening):
            if voice { lastSpeech = max(lastSpeech, now) }
            let words = utterance.trimmingCharacters(in: .whitespacesAndNewlines)
            guard !words.isEmpty, !held, let needed = silenceNeeded(for: utterance), now - lastSpeech >= needed else { return [] }
            return sendUtterance()
        case (.hold, .listening):
            guard !utterance.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else { return [] }
            held = true
            return []
        case (.hold, _):
            return []
        case (.sendNow, .listening):
            guard !utterance.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else { return [] }
            return sendUtterance()
        case (.sendNow, _):
            return []
        case (.tick(let now, let voice), .thinking):
            if voice { lastSpeech = max(lastSpeech, now) }
            return []
        case (.tick, _):
            return []

        case (.sendFailed, .thinking):
            phase = .listening
            return []
        case (.sendFailed, _):
            return []

        case (.agentFinished(let reply), .thinking):
            // Someone started talking again: their words matter more than
            // hearing the reply, which stays on screen.
            let reply = reply.trimmingCharacters(in: .whitespacesAndNewlines)
            guard utterance.isEmpty, !reply.isEmpty else {
                phase = .listening
                return []
            }
            phase = .speaking
            return [.speak(reply)]
        case (.agentFinished, _):
            return []

        case (.playbackFinished, .speaking):
            // Anything short of a barge-in while it played was the reply's
            // own echo or noise.
            phase = .listening
            utterance = ""
            return [.startListening]
        case (.playbackFinished, _):
            return []
        }
    }

    private mutating func sendUtterance() -> [Action] {
        let words = utterance.trimmingCharacters(in: .whitespacesAndNewlines)
        phase = .thinking
        utterance = ""
        held = false
        return [.send(words)]
    }

    static func wordCount(_ text: String) -> Int {
        text.split { !$0.isLetter && !$0.isNumber }.count
    }
}

/// How long a pause in talk mode waits before it sends.
enum TalkPause: String, CaseIterable, Identifiable, Sendable {
    case quick, normal, relaxed, manual
    static let key = "voice.talk-pause.v1"
    var id: String { rawValue }
    var seconds: TimeInterval? {
        switch self {
        case .quick: 1.5
        case .normal: 3
        case .relaxed: 5
        case .manual: nil
        }
    }
    var title: String {
        switch self {
        case .quick: "Quick · 1.5 s"
        case .normal: "Normal · 3 s"
        case .relaxed: "Relaxed · 5 s"
        case .manual: "Manual · tap to send"
        }
    }
    static func current(in defaults: UserDefaults = AppRuntime.defaults) -> TalkPause {
        defaults.string(forKey: key).flatMap(TalkPause.init(rawValue:)) ?? .normal
    }
}
