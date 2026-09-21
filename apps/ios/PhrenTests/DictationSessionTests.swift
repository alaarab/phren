import XCTest
@testable import Phren

@MainActor
final class DictationSessionTests: XCTestCase {
    final class FakeRecognizer: DictationRecognizing {
        var audioLevel: Float = 0
        var isRecognizerAvailable = true
        var startFailures = 0
        var onStop: (() -> Void)?
        private(set) var segments: [UUID] = []
        private(set) var stops: [Bool] = []
        private var callbacks: [UUID: @MainActor (DictationRecognitionEvent) -> Void] = [:]

        func startSegment(id: UUID, receive: @escaping @MainActor (DictationRecognitionEvent) -> Void) throws {
            segments.append(id)
            callbacks[id] = receive
            if startFailures > 0 {
                startFailures -= 1
                throw NSError(domain: "DictationTests", code: 1, userInfo: [NSLocalizedDescriptionKey: "Microphone unavailable."])
            }
        }

        func stopSegment(keepingAudioSession: Bool) {
            stops.append(keepingAudioSession)
            onStop?()
        }

        func emit(_ event: DictationRecognitionEvent, segment: UUID? = nil) {
            guard let id = segment ?? segments.last else { return }
            callbacks[id]?(event)
        }
    }

    func testPartialsAccumulateAfterCommittedTextWithoutDuplicatingTheSegment() {
        let recognizer = FakeRecognizer()
        let session = DictationSession(recognizer: recognizer)
        session.start(draft: "Please")
        recognizer.emit(.partial("run"))
        XCTAssertEqual(session.draft, "Please run")
        recognizer.emit(.partial("run the tests"))
        XCTAssertEqual(session.draft, "Please run the tests")
        XCTAssertEqual(session.committedText, "Please")
    }

    func testPauseCommitsWordsBeforeStartingTheNextSegment() {
        let recognizer = FakeRecognizer()
        let session = DictationSession(recognizer: recognizer)
        session.start(draft: "")
        recognizer.emit(.partial("Run the tests"))
        recognizer.emit(.finished(""))
        XCTAssertEqual(session.committedText, "Run the tests")
        XCTAssertTrue(session.isRecording)
        XCTAssertEqual(recognizer.segments.count, 2)
        XCTAssertEqual(recognizer.stops, [true])
        recognizer.emit(.partial("then review"))
        XCTAssertEqual(session.draft, "Run the tests then review")
        recognizer.emit(.finished("then"))
        XCTAssertEqual(session.draft, "Run the tests then review")
    }

    func testSendClearsTheBankAndKeepsListeningForANewMessage() {
        let recognizer = FakeRecognizer()
        let session = DictationSession(recognizer: recognizer)
        var composer = ""
        session.readDraft = { composer }
        session.onDraftChange = { composer = $0 }
        session.start(draft: "")
        recognizer.emit(.partial("First message"))
        recognizer.emit(.finished(""))
        recognizer.emit(.partial("with more words"))
        XCTAssertEqual(session.send(), "First message with more words")
        XCTAssertEqual(composer, "")
        XCTAssertEqual(session.committedText, "")
        XCTAssertTrue(session.isRecording)
        recognizer.emit(.partial("Next message"))
        XCTAssertEqual(composer, "Next message")
        XCTAssertEqual(session.send(), "Next message")
        recognizer.emit(.partial("Next message"))
        XCTAssertEqual(composer, "Next message")
    }

    func testOldPartialsFinalsAndErrorsCannotChangeTheNewSegment() throws {
        let recognizer = FakeRecognizer()
        let session = DictationSession(recognizer: recognizer)
        session.start(draft: "")
        let old = try XCTUnwrap(recognizer.segments.last)
        recognizer.emit(.partial("First"))
        recognizer.emit(.finished("First"))
        recognizer.emit(.partial("second"))
        recognizer.emit(.partial("Late old words"), segment: old)
        recognizer.emit(.finished("Late final"), segment: old)
        recognizer.emit(.failed("Cancelled."), segment: old)
        XCTAssertEqual(session.draft, "First second")
        XCTAssertEqual(recognizer.segments.count, 2)
        let sent = try XCTUnwrap(recognizer.segments.last)
        session.send()
        recognizer.emit(.partial("Late after send"), segment: sent)
        XCTAssertEqual(session.draft, "")
        XCTAssertNil(session.failureReason)
    }

    func testErrorRestartsOnceThenStopsWithPreservedTextAndOneLineReason() {
        let recognizer = FakeRecognizer()
        let session = DictationSession(recognizer: recognizer)
        var banner: String?
        session.onFailure = { banner = $0 }
        session.start(draft: "")
        recognizer.emit(.partial("Keep these words"))
        recognizer.emit(.failed("Recognition ended."))
        XCTAssertEqual(recognizer.segments.count, 2)
        XCTAssertTrue(session.isRecording)
        XCTAssertNil(banner)
        recognizer.emit(.partial("and these"))
        recognizer.emit(.failed("Recognition failed.\nTry again."))
        XCTAssertFalse(session.isRecording)
        XCTAssertEqual(recognizer.segments.count, 2)
        XCTAssertEqual(session.draft, "Keep these words and these")
        XCTAssertEqual(banner, "Dictation stopped: Recognition failed. Try again.")
        XCTAssertEqual(session.failureReason, banner)
        XCTAssertEqual(recognizer.stops.last, false)
    }

    func testStopPreservesTextAndIgnoresCallbacksEvenDuringCancellation() {
        let recognizer = FakeRecognizer()
        let session = DictationSession(recognizer: recognizer)
        session.start(draft: "Typed text")
        recognizer.emit(.partial("and spoken words"))
        recognizer.onStop = { [weak recognizer] in recognizer?.emit(.failed("Cancelled.")) }
        session.stop()
        recognizer.emit(.partial("Late words"))
        session.stop()
        XCTAssertEqual(session.draft, "Typed text and spoken words")
        XCTAssertFalse(session.isRecording)
        XCTAssertNil(session.failureReason)
        XCTAssertEqual(recognizer.segments.count, 1)
        XCTAssertEqual(recognizer.stops.last, false)
    }

    func testStartAndRestartFailuresAreBoundedAndReleaseAudio() {
        let recognizer = FakeRecognizer()
        recognizer.startFailures = 3
        let session = DictationSession(recognizer: recognizer)
        session.start(draft: "Keep this")
        XCTAssertEqual(recognizer.segments.count, 2)
        XCTAssertFalse(session.isRecording)
        XCTAssertEqual(session.draft, "Keep this")
        XCTAssertEqual(session.failureReason, "Dictation stopped: Microphone unavailable.")
        XCTAssertEqual(recognizer.stops.last, false)
        recognizer.startFailures = 0
        session.start(draft: session.draft)
        XCTAssertTrue(session.isRecording)
        XCTAssertNil(session.failureReason)
    }

    func testFailedRestartAfterSendLeavesAnEmptyDraftAndTurnsTheMicOff() {
        let recognizer = FakeRecognizer()
        let session = DictationSession(recognizer: recognizer)
        session.start(draft: "")
        recognizer.emit(.partial("Send these words"))
        recognizer.startFailures = 2
        XCTAssertEqual(session.send(), "Send these words")
        XCTAssertEqual(session.draft, "")
        XCTAssertFalse(session.isRecording)
        XCTAssertEqual(session.failureReason, "Dictation stopped: Microphone unavailable.")
        XCTAssertEqual(recognizer.segments.count, 3)
        XCTAssertEqual(recognizer.stops.last, false)
    }

    func testSuccessfulSegmentsAndSendsDoNotResetTheErrorBudget() {
        let recognizer = FakeRecognizer()
        let session = DictationSession(recognizer: recognizer)
        session.start(draft: "")
        recognizer.emit(.failed("Request ended."))
        recognizer.emit(.partial("A message"))
        recognizer.emit(.finished("A message"))
        session.send()
        recognizer.emit(.failed("Request ended again."))
        XCTAssertFalse(session.isRecording)
        XCTAssertEqual(recognizer.segments.count, 4)
        XCTAssertEqual(session.failureReason, "Dictation stopped: Request ended again.")
    }

    func testEditsAndRestoredFailedSendsAreBankedBeforeAnotherPartial() {
        let recognizer = FakeRecognizer()
        let session = DictationSession(recognizer: recognizer)
        var composer = ""
        session.readDraft = { composer }
        session.onDraftChange = { composer = $0 }
        session.start(draft: "")
        recognizer.emit(.partial("First message"))
        let submitted = session.send()
        recognizer.emit(.partial("Next message"))
        composer = DictationSession.join(submitted, composer)
        recognizer.emit(.partial("Next message with stale words"))
        XCTAssertEqual(composer, "First message Next message")
        recognizer.emit(.partial("and more"))
        XCTAssertEqual(composer, "First message Next message and more")
        composer = "Edited text"
        session.stop()
        XCTAssertEqual(session.draft, "Edited text")
        XCTAssertFalse(session.isRecording)
    }

    func testWordReplacementsCommitOnceAcrossPausesAndStop() {
        let recognizer = FakeRecognizer()
        let session = DictationSession(recognizer: recognizer) { $0.replacingOccurrences(of: "test", with: "test suite") }
        session.start(draft: "Typed prefix:")
        recognizer.emit(.partial("run the test"))
        recognizer.emit(.finished(""))
        recognizer.emit(.partial("then review"))
        session.stop()
        XCTAssertEqual(session.draft, "Typed prefix: run the test suite then review")
        XCTAssertEqual(session.committedText, session.draft)
    }
}
