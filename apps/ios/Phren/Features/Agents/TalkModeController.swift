import Foundation
import Observation

/// Hands-free turns with an agent, meant for the conductor: listen until you
/// stop talking, send the words through the chat's own send, read the reply
/// aloud, and listen again. Talking over a reply stops it.
///
/// `TalkTurnMachine` decides; this owns the microphone, the voice and the
/// timing, and talks to the chat through `Environment`.
@Observable @MainActor
final class TalkModeController {
    struct Environment {
        var makeRecognizer: @MainActor () -> any DictationRecognizing
        var makeVoice: @MainActor (_ recognizer: any DictationRecognizing) -> any TalkSpeaking
        var permissions: @MainActor () async -> Bool
        /// The transcript's last line before a send; the reply comes after it.
        var lastLine: @MainActor () -> Int
        /// Sends through the chat; false when it wasn't delivered.
        var send: @MainActor (String) async -> Bool
        /// The reply to the words sent after `line`, once the turn is over.
        var reply: @MainActor (_ after: Int) -> String?
        var now: @MainActor () -> TimeInterval = { ProcessInfo.processInfo.systemUptime }
        var tick: Duration = .milliseconds(200)
    }

    /// Input level that counts as someone talking.
    static let voiceLevel: Float = 0.08

    private(set) var phase = TalkTurnMachine.Phase.off
    /// The words of the utterance being heard.
    private(set) var heard = ""
    private(set) var failure: String?
    var isOn: Bool { phase != .off }

    @ObservationIgnored private var machine = TalkTurnMachine()
    @ObservationIgnored private var environment: Environment?
    @ObservationIgnored private var recognizer: (any DictationRecognizing)?
    @ObservationIgnored private var session: DictationSession?
    @ObservationIgnored private var voice: (any TalkSpeaking)?
    @ObservationIgnored private var ticker: Task<Void, Never>?
    @ObservationIgnored private var startTask: Task<Void, Never>?
    @ObservationIgnored private var sendTask: Task<Void, Never>?
    @ObservationIgnored private var speakTask: Task<Void, Never>?
    @ObservationIgnored private var sentAfterLine: Int?
    @ObservationIgnored private var replySeen: String?

    func start(_ environment: Environment) {
        guard !isOn, startTask == nil else { return }
        failure = nil
        startTask = Task {
            defer { startTask = nil }
            guard await environment.permissions() else {
                failure = "Allow microphone and speech recognition in iPhone Settings to talk."
                return
            }
            guard !Task.isCancelled else { return }
            self.environment = environment
            let recognizer = environment.makeRecognizer()
            let session = DictationSession(recognizer: recognizer, transform: SpeechSettings.apply)
            session.onDraftChange = { [weak self] words in self?.heardChanged(words) }
            session.onFailure = { [weak self] reason in self?.fail(reason) }
            self.recognizer = recognizer
            self.session = session
            voice = environment.makeVoice(recognizer)
            handle(.turnOn(at: environment.now()))
            let tick = environment.tick
            ticker = Task { [weak self] in
                while !Task.isCancelled {
                    try? await Task.sleep(for: tick)
                    guard let self else { return }
                    self.tick()
                }
            }
        }
    }

    func stop() {
        startTask?.cancel()
        startTask = nil
        guard isOn else { return }
        handle(.turnOff)
    }

    // MARK: Events

    private func heardChanged(_ words: String) {
        heard = words
        guard let environment else { return }
        handle(.heard(words, at: environment.now()))
    }

    private func tick() {
        guard let environment, isOn else { return }
        handle(.tick(at: environment.now(), voice: (recognizer?.audioLevel ?? 0) > Self.voiceLevel))
        guard phase == .thinking, let line = sentAfterLine, let reply = environment.reply(line) else {
            replySeen = nil
            return
        }
        // The same answer on two ticks in a row: a reply still being written
        // into the transcript keeps changing.
        guard replySeen == reply else {
            replySeen = reply
            return
        }
        replySeen = nil
        sentAfterLine = nil
        handle(.agentFinished(reply: SpokenReply.text(fromMarkdown: reply)))
    }

    private func fail(_ reason: String) {
        failure = reason
        stop()
    }

    private func handle(_ event: TalkTurnMachine.Event) {
        let actions = machine.handle(event)
        phase = machine.phase
        actions.forEach(perform)
    }

    // MARK: Actions

    private func perform(_ action: TalkTurnMachine.Action) {
        guard let environment, let session else { return }
        switch action {
        case .startListening:
            // A fresh utterance: whatever was heard so far is dropped.
            if session.isRecording { session.send() } else { session.start(draft: "") }
            heard = session.draft
        case .stopListening:
            ticker?.cancel()
            ticker = nil
            sendTask?.cancel()
            speakTask?.cancel()
            voice?.stop()
            session.stop()
            heard = ""
            sentAfterLine = nil
        case .send(let words):
            session.send()
            heard = ""
            sentAfterLine = environment.lastLine()
            replySeen = nil
            sendTask = Task { [weak self] in
                let delivered = await environment.send(words)
                guard let self, !Task.isCancelled, !delivered, self.phase == .thinking else { return }
                self.sentAfterLine = nil
                self.handle(.sendFailed)
            }
        case .speak(let text):
            speakTask = Task { [weak self] in
                guard let voice = self?.voice else { return }
                await voice.speak(text)
                guard let self, !Task.isCancelled, self.phase == .speaking else { return }
                self.handle(.playbackFinished)
            }
        case .stopSpeaking:
            speakTask?.cancel()
            voice?.stop()
        }
    }
}
