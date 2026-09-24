import AVFAudio
import PhrenKit
import XCTest
@testable import Phren

final class TalkTurnMachineTests: XCTestCase {
    func testListenSendSpeakBargeInAndListenAgain() {
        var machine = TalkTurnMachine(silence: 1.2)
        XCTAssertEqual(machine.handle(.turnOn(at: 0)), [.startListening])
        XCTAssertEqual(machine.phase, .listening)

        // Words still changing: no send, however long the words have run.
        XCTAssertEqual(machine.handle(.heard("What changed", at: 1)), [])
        XCTAssertEqual(machine.handle(.tick(at: 2, voice: true)), [])
        XCTAssertEqual(machine.handle(.heard("What changed in atlas today", at: 2.1)), [])
        XCTAssertEqual(machine.handle(.tick(at: 3.2, voice: false)), [], "1.1 s of quiet is not the end of a turn")
        XCTAssertEqual(machine.handle(.tick(at: 3.4, voice: false)), [.send("What changed in atlas today")])
        XCTAssertEqual(machine.phase, .thinking)

        XCTAssertEqual(machine.handle(.agentFinished(reply: "Two commits landed. Both fix the parser.")),
                       [.speak("Two commits landed. Both fix the parser.")])
        XCTAssertEqual(machine.phase, .speaking)

        // One stray word (echo or a cough) doesn't stop the reply; two do.
        XCTAssertEqual(machine.handle(.heard("two", at: 5)), [])
        XCTAssertEqual(machine.phase, .speaking)
        XCTAssertEqual(machine.handle(.heard("wait stop", at: 5.5)), [.stopSpeaking])
        XCTAssertEqual(machine.phase, .listening)
        XCTAssertEqual(machine.utterance, "wait stop", "the barge-in's words start the next turn")

        XCTAssertEqual(machine.handle(.heard("wait stop and run the tests", at: 6)), [])
        XCTAssertEqual(machine.handle(.tick(at: 7.3, voice: false)), [.send("wait stop and run the tests")])
        XCTAssertEqual(machine.handle(.agentFinished(reply: "Running them.")), [.speak("Running them.")])
        XCTAssertEqual(machine.handle(.playbackFinished), [.startListening])
        XCTAssertEqual(machine.phase, .listening)
    }

    func testInputLevelHoldsTheTurnOpenBetweenRecognisedWords() {
        var machine = TalkTurnMachine(silence: 1.2)
        _ = machine.handle(.turnOn(at: 0))
        _ = machine.handle(.heard("Open the", at: 1))
        XCTAssertEqual(machine.handle(.tick(at: 2, voice: true)), [])
        XCTAssertEqual(machine.handle(.tick(at: 3, voice: false)), [])
        XCTAssertEqual(machine.handle(.tick(at: 3.2, voice: false)), [.send("Open the")])
    }

    func testSilenceWithoutWordsSendsNothing() {
        var machine = TalkTurnMachine(silence: 1.2)
        _ = machine.handle(.turnOn(at: 0))
        XCTAssertEqual(machine.handle(.tick(at: 30, voice: false)), [])
        XCTAssertEqual(machine.handle(.heard("   ", at: 31)), [])
        XCTAssertEqual(machine.handle(.tick(at: 60, voice: false)), [])
        XCTAssertEqual(machine.phase, .listening)
    }

    func testSpeechDuringThinkingSkipsTheReplyAndBecomesTheNextTurn() {
        var machine = TalkTurnMachine(silence: 1.2)
        _ = machine.handle(.turnOn(at: 0))
        _ = machine.handle(.heard("Summarize atlas", at: 1))
        XCTAssertEqual(machine.handle(.tick(at: 2.5, voice: false)), [.send("Summarize atlas")])
        XCTAssertEqual(machine.handle(.heard("and mina", at: 3)), [])
        XCTAssertEqual(machine.handle(.tick(at: 10, voice: false)), [], "nothing is sent while the agent works")
        XCTAssertEqual(machine.handle(.agentFinished(reply: "Atlas is quiet.")), [])
        XCTAssertEqual(machine.phase, .listening)
        XCTAssertEqual(machine.handle(.tick(at: 11, voice: false)), [.send("and mina")])
    }

    func testEmptyRepliesFailedSendsAndTurningOff() {
        var machine = TalkTurnMachine(silence: 1.2)
        _ = machine.handle(.turnOn(at: 0))
        _ = machine.handle(.heard("Run it", at: 1))
        _ = machine.handle(.tick(at: 3, voice: false))
        XCTAssertEqual(machine.handle(.agentFinished(reply: "  ")), [])
        XCTAssertEqual(machine.phase, .listening)

        _ = machine.handle(.heard("Again", at: 4))
        _ = machine.handle(.tick(at: 6, voice: false))
        XCTAssertEqual(machine.handle(.sendFailed), [])
        XCTAssertEqual(machine.phase, .listening)

        _ = machine.handle(.heard("Once more", at: 7))
        _ = machine.handle(.tick(at: 9, voice: false))
        _ = machine.handle(.agentFinished(reply: "Done."))
        XCTAssertEqual(machine.handle(.turnOff), [.stopSpeaking, .stopListening])
        XCTAssertEqual(machine.phase, .off)
        XCTAssertEqual(machine.handle(.heard("ignored words", at: 10)), [])
        XCTAssertEqual(machine.handle(.playbackFinished), [])
        XCTAssertEqual(machine.handle(.turnOff), [])
    }

    func testDefaultPauseIsThreeSecondsAndEachModeWaitsItsOwnTime() {
        XCTAssertEqual(TalkTurnMachine().silence, 3)
        for (pause, seconds) in [(TalkPause.quick, 1.5), (.normal, 3), (.relaxed, 5)] {
            var machine = TalkTurnMachine(silence: pause.seconds)
            _ = machine.handle(.turnOn(at: 0))
            _ = machine.handle(.heard("Check the build", at: 1))
            XCTAssertEqual(machine.handle(.tick(at: 1 + seconds - 0.1, voice: false)), [], "\(pause) waits its full pause")
            XCTAssertEqual(machine.handle(.tick(at: 1 + seconds, voice: false)), [.send("Check the build")], "\(pause)")
        }
    }

    func testManualNeverSendsUntilTapped() {
        var machine = TalkTurnMachine(silence: TalkPause.manual.seconds)
        _ = machine.handle(.turnOn(at: 0))
        _ = machine.handle(.heard("Draft the release notes", at: 1))
        XCTAssertEqual(machine.handle(.tick(at: 120, voice: false)), [])
        XCTAssertNil(machine.countdown(at: 120), "Manual has nothing to count down")
        XCTAssertEqual(machine.handle(.sendNow), [.send("Draft the release notes")])
        XCTAssertEqual(machine.phase, .thinking)
    }

    func testHoldKeepsThinkingUntilWordsOrASecondTap() {
        var machine = TalkTurnMachine(silence: 3)
        _ = machine.handle(.turnOn(at: 0))
        _ = machine.handle(.heard("Rename the", at: 1))
        XCTAssertNil(machine.countdown(at: 1.2), "a breath is not a pause")
        XCTAssertEqual(machine.countdown(at: 2.5), 0.5, "halfway through a 3 s pause")
        XCTAssertEqual(machine.handle(.hold), [])
        XCTAssertTrue(machine.held)
        XCTAssertNil(machine.countdown(at: 3))
        XCTAssertEqual(machine.handle(.tick(at: 30, voice: false)), [], "held: no send however long the quiet")
        // Talking again releases the hold and restarts the pause.
        _ = machine.handle(.heard("Rename the conductor card", at: 31))
        XCTAssertFalse(machine.held)
        XCTAssertEqual(machine.handle(.tick(at: 34, voice: false)), [.send("Rename the conductor card")])
        // A held turn sends at once on the next tap.
        _ = machine.handle(.agentFinished(reply: ""))
        _ = machine.handle(.heard("One more thing", at: 40))
        _ = machine.handle(.hold)
        XCTAssertEqual(machine.handle(.sendNow), [.send("One more thing")])
        XCTAssertFalse(machine.held)
    }

    func testWordsThatTrailOffWaitLonger() {
        XCTAssertTrue(TalkTurnMachine.endsMidThought("check the build and"))
        XCTAssertTrue(TalkTurnMachine.endsMidThought("the parser, um"))
        XCTAssertTrue(TalkTurnMachine.endsMidThought("first the tests,"))
        XCTAssertFalse(TalkTurnMachine.endsMidThought("check the brand"))
        XCTAssertFalse(TalkTurnMachine.endsMidThought("ship it"))
        var machine = TalkTurnMachine(silence: 3)
        _ = machine.handle(.turnOn(at: 0))
        _ = machine.handle(.heard("Look at the parser and", at: 1))
        XCTAssertEqual(machine.handle(.tick(at: 4.5, voice: false)), [], "a trailing 'and' waits past the normal pause")
        XCTAssertEqual(machine.handle(.tick(at: 6, voice: false)), [.send("Look at the parser and")])
    }

    func testMicButtonDefaultsToDictationThatNeverSends() {
        let defaults = UserDefaults(suiteName: "voice-\(UUID().uuidString)")!
        XCTAssertEqual(SpeechSettings.micButton(in: defaults), .dictate)
        XCTAssertEqual(SpeechSettings.replyVoice(in: defaults), .elevenLabs)
        XCTAssertEqual(TalkPause.current(in: defaults), .normal)
        defaults.set("talk", forKey: SpeechSettings.micButtonKey)
        XCTAssertEqual(SpeechSettings.micButton(in: defaults), .talk)
    }
}

final class SpokenReplyTests: XCTestCase {
    func testReadsProseAndSkipsCodeTablesAndMarkdown() {
        let reply = """
        ## Summary

        I fixed **two** bugs in `parser.swift`:

        - The [tokenizer](https://example.com/t) dropped quotes
        - `lex()` looped forever

        ```swift
        let x = 1
        ```

        | File | Lines |
        |------|-------|
        | a.swift | 3 |

        See https://github.com/alaarab/phren/pull/12 for details
        """
        XCTAssertEqual(SpokenReply.text(fromMarkdown: reply),
                       "Summary. I fixed two bugs in parser.swift: The tokenizer dropped quotes. lex() looped forever. See a link for details.")
    }

    func testSentencesGroupShortOnesTogether() {
        XCTAssertEqual(SpokenReply.sentences("Done. The tests pass on both machines now. Anything else?"),
                       ["Done. The tests pass on both machines now.", "Anything else?"])
        XCTAssertEqual(SpokenReply.sentences(""), [])
    }
}

final class TalkReplyTests: XCTestCase {
    /// A Codex transcript as the Hook sends it: rows by line.
    private func frame(_ rows: [(Int, [String: Any])]) throws -> AgentChatTranscript {
        let entries = rows.map { ["line": $0.0, "raw": $0.1] as [String: Any] }
        return try AgentChatTranscript.read(JSONSerialization.data(withJSONObject: [
            "type": "backlog", "source": "codex", "entries": entries, "totalLines": (rows.map(\.0).max() ?? 0) + 1, "hasMore": false,
        ]), source: "codex")
    }
    private func message(_ role: String, _ text: String) -> [String: Any] {
        ["type": "response_item", "payload": ["type": "message", "role": role, "content": text]]
    }
    private func event(_ type: String) -> [String: Any] { ["type": "event_msg", "payload": ["type": type]] }

    private func reply(_ rows: [(Int, [String: Any])], after line: Int, awaiting: Bool = false, activity: AgentChatProgress.Phase? = nil) throws -> String? {
        let transcript = try frame(rows)
        var history = AgentChatHistory(); history.receive(transcript)
        var progress = AgentChatProgress(); progress.receive(transcript)
        return TalkReply.finished(messages: history.messages, turns: progress.turns, activity: activity ?? progress.phase,
                                  awaitingReply: awaiting, after: line)
    }

    func testWaitsForTheTurnThenTakesItsLastReplyNotEarlierOnes() throws {
        let earlier: [(Int, [String: Any])] = [(0, message("user", "Old question")), (1, event("task_started")),
                                               (2, message("assistant", "Old answer")), (3, event("task_complete"))]
        // Sent after line 3; nothing has arrived for it yet.
        XCTAssertNil(try reply(earlier, after: 3))
        let working = earlier + [(4, message("user", "What changed?")), (5, event("task_started")), (6, message("assistant", "Looking."))]
        XCTAssertNil(try reply(working, after: 3), "the turn is still running")
        let done = working + [(7, message("assistant", "Two commits landed.")), (8, event("task_complete"))]
        XCTAssertEqual(try reply(done, after: 3), "Two commits landed.")
        XCTAssertNil(try reply(done, after: 3, awaiting: true), "the send hasn't been acknowledged")
        XCTAssertNil(try reply(done, after: 3, activity: .working), "the terminal says it is still working")
    }
}

@MainActor
final class TalkModeControllerTests: XCTestCase {
    final class FakeRecognizer: DictationRecognizing {
        var audioLevel: Float = 0
        var isRecognizerAvailable = true
        var receive: (@MainActor (DictationRecognitionEvent) -> Void)?
        func startSegment(id: UUID, receive: @escaping @MainActor (DictationRecognitionEvent) -> Void) throws { self.receive = receive }
        func stopSegment(keepingAudioSession: Bool) {}
        func say(_ words: String) { receive?(.partial(words)) }
    }

    final class FakeVoice: TalkSpeaking {
        var spoken: [String] = []
        var stops = 0
        private var finish: CheckedContinuation<Void, Never>?
        func speak(_ text: String) async {
            spoken.append(text)
            await withCheckedContinuation { finish = $0 }
        }
        func stop() { stops += 1; complete() }
        func complete() { finish?.resume(); finish = nil }
    }

    private func wait(_ what: String, timeout: TimeInterval = 5, _ condition: @MainActor () -> Bool) async throws {
        let deadline = Date.now.addingTimeInterval(timeout)
        while !condition() {
            guard Date.now < deadline else { return XCTFail("timed out waiting: \(what)") }
            try await Task.sleep(for: .milliseconds(20))
        }
    }

    /// Listen, send, speak, barge in, send again, speak to the end, listen.
    func testFixtureConversation() async throws {
        let recognizer = FakeRecognizer()
        let voice = FakeVoice()
        var clock: TimeInterval = 0
        var sent: [String] = []
        var line = 10
        var replies: [Int: String] = [:]
        let talk = TalkModeController()
        talk.start(.init(
            makeRecognizer: { recognizer }, makeVoice: { _ in voice }, permissions: { true },
            lastLine: { line },
            send: { words in sent.append(words); return true },
            reply: { after in replies[after] },
            now: { clock }, pause: .quick, tick: .milliseconds(10)))
        try await wait("listening") { talk.phase == .listening }

        recognizer.say("What changed in atlas")
        clock += 0.5
        recognizer.say("What changed in atlas today")
        XCTAssertEqual(talk.heard, "What changed in atlas today")
        clock += 1.6
        try await wait("sent") { talk.phase == .thinking }
        XCTAssertEqual(sent, ["What changed in atlas today"])
        XCTAssertEqual(talk.heard, "")

        replies[10] = "Two commits landed.\n\n```\nlet x = 1\n```\n\nBoth fix the parser."
        try await wait("speaking") { talk.phase == .speaking }
        XCTAssertEqual(voice.spoken, ["Two commits landed. Both fix the parser."])

        recognizer.say("wait")
        XCTAssertEqual(talk.phase, .speaking, "one word is not a barge-in")
        recognizer.say("wait stop")
        XCTAssertEqual(talk.phase, .listening)
        XCTAssertEqual(voice.stops, 1)

        line = 20
        recognizer.say("wait stop and run the tests")
        clock += 1.6
        try await wait("second send") { talk.phase == .thinking }
        XCTAssertEqual(sent.last, "wait stop and run the tests")
        replies[20] = "Running them."
        try await wait("second reply") { talk.phase == .speaking }
        voice.complete()
        try await wait("listening again") { talk.phase == .listening }
        XCTAssertEqual(voice.spoken.last, "Running them.")

        talk.stop()
        XCTAssertEqual(talk.phase, .off)
        XCTAssertFalse(talk.isOn)
    }

    func testFailedSendGoesBackToListeningAndDeniedPermissionExplains() async throws {
        let recognizer = FakeRecognizer()
        var clock: TimeInterval = 0
        let talk = TalkModeController()
        talk.start(.init(makeRecognizer: { recognizer }, makeVoice: { _ in FakeVoice() }, permissions: { true },
                         lastLine: { 0 }, send: { _ in false }, reply: { _ in nil }, now: { clock }, pause: .quick, tick: .milliseconds(10)))
        try await wait("listening") { talk.phase == .listening }
        recognizer.say("Run it")
        clock += 2
        try await wait("back to listening after a failed send") { talk.phase == .listening && talk.heard.isEmpty }
        talk.stop()

        let denied = TalkModeController()
        denied.start(.init(makeRecognizer: { recognizer }, makeVoice: { _ in FakeVoice() }, permissions: { false },
                           lastLine: { 0 }, send: { _ in true }, reply: { _ in nil }))
        try await wait("permission failure") { denied.failure != nil }
        XCTAssertFalse(denied.isOn)
    }
}

@MainActor
final class TalkVoiceTests: XCTestCase {
    func testPCMFromTheComputerBecomesFloatSamples() throws {
        var data = Data()
        for sample: Int16 in [0, 16_384, -32_768, 32_767] { withUnsafeBytes(of: sample.littleEndian) { data.append(contentsOf: $0) } }
        let buffer = try XCTUnwrap(TalkVoice.buffer(pcm16: data))
        XCTAssertEqual(buffer.format.sampleRate, 24_000)
        XCTAssertEqual(buffer.frameLength, 4)
        let samples = Array(UnsafeBufferPointer(start: buffer.floatChannelData![0], count: 4))
        XCTAssertEqual(samples[0], 0)
        XCTAssertEqual(samples[1], 0.5, accuracy: 0.0001)
        XCTAssertEqual(samples[2], -1)
        XCTAssertEqual(samples[3], 1, accuracy: 0.0001)
        XCTAssertNil(TalkVoice.buffer(pcm16: Data([1])))
    }

    func testTheAppleFallbackPicksAnInstalledVoiceForTheLanguage() throws {
        let voice = try XCTUnwrap(TalkVoice.bestVoice(for: "en-US"))
        XCTAssertTrue(voice.language.hasPrefix("en"))
        XCTAssertFalse(voice.voiceTraits.contains(.isNoveltyVoice))
        let best = AVSpeechSynthesisVoice.speechVoices().filter { $0.language == "en-US" && !$0.voiceTraits.contains(.isNoveltyVoice) }
            .map(\.quality.rawValue).max()
        if let best { XCTAssertEqual(voice.quality.rawValue, best) }
    }
}
