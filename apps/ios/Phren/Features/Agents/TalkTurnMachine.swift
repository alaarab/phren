import Foundation

/// Turn-taking for talk mode, free of audio and networking so it can be
/// tested on its own. The controller feeds it what the microphone heard, a
/// clock tick, and the agent's progress; it answers with what to do.
///
/// Listening ends when the words stop changing and the microphone has been
/// quiet for `endOfTurnSilence`. While a reply plays, a few recognised words
/// are a barge-in: the reply stops and those words start the next turn.
struct TalkTurnMachine: Equatable {
    enum Phase: Equatable { case off, listening, thinking, speaking }

    enum Event: Equatable {
        case turnOn(at: TimeInterval)
        case turnOff
        /// The words heard so far in the current utterance.
        case heard(String, at: TimeInterval)
        /// Periodic; `voice` is whether the input level says someone is talking.
        case tick(at: TimeInterval, voice: Bool)
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

    static let endOfTurnSilence: TimeInterval = 1.2
    static let bargeInWords = 2

    private(set) var phase = Phase.off
    private(set) var utterance = ""
    private var lastSpeech: TimeInterval = 0

    var isOn: Bool { phase != .off }

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
            return current == .speaking ? [.stopSpeaking, .stopListening] : [.stopListening]

        case (.heard(let text, let now), .listening), (.heard(let text, let now), .thinking):
            // Words spoken while the agent works wait for the next turn.
            if text != utterance {
                utterance = text
                lastSpeech = now
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
            guard !words.isEmpty, now - lastSpeech >= Self.endOfTurnSilence else { return [] }
            phase = .thinking
            utterance = ""
            return [.send(words)]
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

    static func wordCount(_ text: String) -> Int {
        text.split { !$0.isLetter && !$0.isNumber }.count
    }
}
