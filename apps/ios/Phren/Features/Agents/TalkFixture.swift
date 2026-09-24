#if DEBUG && targetEnvironment(simulator)
import Foundation
import Observation
import PhrenKit

/// A scripted talk-mode conversation for UI tests, with no microphone or
/// speaker: a recogniser that "hears" two turns and a barge-in, and a voice
/// that takes a few seconds to "speak". The chat itself is the native chat
/// fixture, which answers each message with a finished Codex turn.
@MainActor enum TalkFixture {
    static var enabled: Bool { AppModel.isUITesting && ProcessInfo.processInfo.arguments.contains("--talk-fixture") }

    @Observable final class Log {
        var entries: [String] = []
    }
    static let log = Log()

    static func environment(model: AgentChatModel, session: LiveAgentSession) -> TalkModeController.Environment {
        let recognizer = ScriptedRecognizer()
        return TalkModeController.Environment(
            makeRecognizer: { recognizer },
            makeVoice: { _ in ScriptedVoice(recognizer: recognizer) },
            permissions: { true },
            lastLine: { model.history.totalLines - 1 },
            send: { text in
                log.entries.append("sent: \(text)")
                return await TalkModeController.send(text, model: model, session: session)
            },
            reply: { line in TalkModeController.reply(model: model, after: line) },
            pause: .quick)
    }

    /// Says the first question once listening starts, and the barge-in
    /// partway through the first reply.
    final class ScriptedRecognizer: DictationRecognizing {
        var audioLevel: Float = 0
        var isRecognizerAvailable: Bool { true }
        private var receive: (@MainActor (DictationRecognitionEvent) -> Void)?
        private var askedFirst = false

        func startSegment(id: UUID, receive: @escaping @MainActor (DictationRecognitionEvent) -> Void) throws {
            self.receive = receive
            guard !askedFirst else { return }
            askedFirst = true
            say(["What changed", "What changed in atlas today"], after: 0.6)
        }

        func stopSegment(keepingAudioSession: Bool) {
            if !keepingAudioSession { receive = nil }
        }

        func say(_ partials: [String], after delay: TimeInterval) {
            Task { @MainActor in
                try? await Task.sleep(for: .seconds(delay))
                for words in partials {
                    audioLevel = 0.3
                    receive?(.partial(words))
                    try? await Task.sleep(for: .milliseconds(400))
                }
                audioLevel = 0
            }
        }
    }

    /// "Speaks" for three seconds. During the first reply the recogniser
    /// barges in.
    final class ScriptedVoice: TalkSpeaking {
        private let recognizer: ScriptedRecognizer
        private var replies = 0
        private var stopped = false

        init(recognizer: ScriptedRecognizer) { self.recognizer = recognizer }

        func speak(_ text: String) async {
            replies += 1
            stopped = false
            log.entries.append("speaking: \(text)")
            if replies == 1 { recognizer.say(["wait stop", "wait stop and run the tests"], after: 1.2) }
            for _ in 0..<30 where !stopped { try? await Task.sleep(for: .milliseconds(100)) }
            log.entries.append(stopped ? "interrupted" : "spoke")
        }

        func stop() { stopped = true }
    }
}
#endif
