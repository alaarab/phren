import Foundation
import Observation

enum DictationRecognitionEvent {
    case partial(String)
    case finished(String)
    case failed(String)
}

@MainActor
protocol DictationRecognizing: AnyObject {
    var audioLevel: Float { get }
    var isRecognizerAvailable: Bool { get }
    func startSegment(id: UUID, receive: @escaping @MainActor (DictationRecognitionEvent) -> Void) throws
    func stopSegment(keepingAudioSession: Bool)
}

/// Recognition callbacks, including cancellation callbacks, belong to one
/// segment. Only this owner can commit that segment or start its successor.
@MainActor
@Observable
final class DictationSession {
    private(set) var draft = ""
    private(set) var isRecording = false
    private(set) var failureReason: String?
    private(set) var committedText = ""
    private(set) var partial = ""

    @ObservationIgnored var readDraft: (() -> String)?
    @ObservationIgnored var onDraftChange: ((String) -> Void)?
    @ObservationIgnored var onFailure: ((String) -> Void)?
    @ObservationIgnored private let recognizer: any DictationRecognizing
    @ObservationIgnored private let transform: (String) -> String
    @ObservationIgnored private var segmentID: UUID?
    @ObservationIgnored private var errorRestarts = 0
    private let maximumErrorRestarts = 1

    init(recognizer: any DictationRecognizing, transform: @escaping (String) -> String = { $0 }) {
        self.recognizer = recognizer
        self.transform = transform
    }

    var audioLevel: Float { recognizer.audioLevel }
    var isRecognizerAvailable: Bool { recognizer.isRecognizerAvailable }

    func start(draft: String) {
        guard !isRecording else { return }
        committedText = draft
        partial = ""
        publishDraft()
        failureReason = nil
        errorRestarts = 0
        isRecording = true
        beginSegment()
    }

    /// Typed edits become committed text before another callback can replace
    /// them. A fresh request prevents the old partial from duplicating them.
    func updateDraft(_ value: String) {
        replaceDraft(value, restarting: true)
    }

    private func replaceDraft(_ value: String, restarting: Bool) {
        guard value != draft else { return }
        endSegment()
        committedText = value
        partial = ""
        publishDraft()
        if isRecording, restarting { beginSegment() }
    }

    func stop() {
        synchronizeDraft(restarting: false)
        endSegment()
        isRecording = false
        commitPartial()
        recognizer.stopSegment(keepingAudioSession: false)
    }

    /// Called only after the sender has captured and accepted the draft.
    /// Speech arriving during delivery belongs to the next message.
    @discardableResult
    func send() -> String {
        synchronizeDraft(restarting: false)
        endSegment()
        commitPartial()
        let submitted = draft
        committedText = ""
        publishDraft()
        if isRecording { beginSegment() }
        return submitted
    }

    private func synchronizeDraft(restarting: Bool = true) {
        if let value = readDraft?(), value != draft { replaceDraft(value, restarting: restarting) }
    }

    private func beginSegment() {
        let id = UUID()
        segmentID = id
        do {
            try recognizer.startSegment(id: id) { [weak self] event in
                self?.receive(event, from: id)
            }
        } catch {
            receive(.failed(error.localizedDescription), from: id)
        }
    }

    private func receive(_ event: DictationRecognitionEvent, from id: UUID) {
        guard isRecording, segmentID == id else { return }
        synchronizeDraft()
        guard segmentID == id else { return }
        switch event {
        case .partial(let text):
            keepTranscript(text)
            publishDraft()
        case .finished(let text):
            keepTranscript(text)
            endSegment()
            commitPartial()
            beginSegment()
        case .failed(let reason):
            endSegment()
            commitPartial()
            if errorRestarts < maximumErrorRestarts {
                errorRestarts += 1
                beginSegment()
            } else {
                isRecording = false
                recognizer.stopSegment(keepingAudioSession: false)
                let detail = reason.split(whereSeparator: { $0.isNewline }).joined(separator: " ")
                let message = detail.isEmpty ? "Dictation stopped. Tap the microphone to try again." : "Dictation stopped: \(detail)"
                failureReason = message
                onFailure?(message)
            }
        }
    }

    private func keepTranscript(_ text: String) {
        // Some requests finish with an empty or truncated final result.
        if text.count >= partial.count { partial = text }
    }

    private func endSegment() {
        segmentID = nil
        recognizer.stopSegment(keepingAudioSession: isRecording)
    }

    private func commitPartial() {
        committedText = Self.join(committedText, transform(partial))
        partial = ""
        publishDraft()
    }

    private func publishDraft() {
        draft = Self.join(committedText, transform(partial))
        onDraftChange?(draft)
    }

    static func join(_ base: String, _ addition: String) -> String {
        guard !addition.isEmpty else { return base }
        guard !base.isEmpty else { return addition }
        return base.last?.isWhitespace == true ? base + addition : base + " " + addition
    }
}
