import SwiftUI
import Speech
import AVFAudio

/// RMS-based input level, sampled off the audio thread — kept as a free
/// function outside the actor so the tap callback (which fires on an
/// internal audio-render thread, never MainActor) can call it directly
/// without hopping first.
private enum AudioLevelMeter {
    static func level(from buffer: AVAudioPCMBuffer) -> Float {
        guard let channelData = buffer.floatChannelData?[0] else { return 0 }
        let frameLength = Int(buffer.frameLength)
        guard frameLength > 0 else { return 0 }
        var sum: Float = 0
        for i in 0..<frameLength {
            let sample = channelData[i]
            sum += sample * sample
        }
        let rms = (sum / Float(frameLength)).squareRoot()
        // Typical phone-mic speech RMS sits well under 1.0 — scale up so the
        // button's pulse actually reads as "listening" rather than flat.
        return min(1, max(0, rms * 12))
    }
}

/// Wraps `SFSpeechRecognizer` + `AVAudioEngine` for tap-to-toggle live
/// dictation. Prefers on-device recognition (`supportsOnDeviceRecognition`)
/// so a captured thought never depends on connectivity when the device
/// supports it; falls back to Apple's server-based recognition otherwise.
///
/// One instance == one recording *session* (a VoiceCaptureView owns it for
/// its lifetime), but `start()`/`stop()` can toggle multiple times within
/// that session — each `start()` begins a fresh segment and resets
/// `transcript`; the view is responsible for stitching segments together so
/// edits made between takes survive.
@MainActor
@Observable
final class SpeechTranscriber {
    enum PermissionState {
        case notDetermined
        case authorized
        case denied
    }

    enum TranscriberError: LocalizedError {
        case recognizerUnavailable

        var errorDescription: String? {
            switch self {
            case .recognizerUnavailable:
                return "Dictation isn't available in this language on this device."
            }
        }
    }

    /// Live partial (or final) transcript of the *current* segment only.
    private(set) var transcript = ""
    private(set) var isRecording = false
    /// Normalized 0...1 input level for the mic button's pulse.
    private(set) var audioLevel: Float = 0

    private let recognizer: SFSpeechRecognizer?
    private let audioEngine = AVAudioEngine()
    private var request: SFSpeechAudioBufferRecognitionRequest?
    private var task: SFSpeechRecognitionTask?

    init(locale: Locale = SpeechSettings.locale) {
        recognizer = SFSpeechRecognizer(locale: locale) ?? SFSpeechRecognizer()
    }

    /// False when the locale isn't supported at all, or recognition is
    /// temporarily down (e.g. no network and no on-device model for it).
    var isRecognizerAvailable: Bool {
        recognizer?.isAvailable ?? false
    }

    var supportsOnDeviceRecognition: Bool {
        recognizer?.supportsOnDeviceRecognition ?? false
    }

    static func currentPermissionState() -> PermissionState {
        let speech = SFSpeechRecognizer.authorizationStatus()
        let mic = AVAudioApplication.shared.recordPermission
        if speech == .notDetermined || mic == .undetermined { return .notDetermined }
        return (speech == .authorized && mic == .granted) ? .authorized : .denied
    }

    /// Requests speech-recognition authorization, then microphone permission.
    /// Both are needed before the first recording; asking for speech first
    /// mirrors Apple's own dictation-permission guidance.
    static func requestPermissions() async -> PermissionState {
        let speechStatus = await withCheckedContinuation { (continuation: CheckedContinuation<SFSpeechRecognizerAuthorizationStatus, Never>) in
            SFSpeechRecognizer.requestAuthorization { status in
                continuation.resume(returning: status)
            }
        }
        guard speechStatus == .authorized else { return .denied }

        let micGranted = await withCheckedContinuation { (continuation: CheckedContinuation<Bool, Never>) in
            AVAudioApplication.requestRecordPermission { granted in
                continuation.resume(returning: granted)
            }
        }
        return micGranted ? .authorized : .denied
    }

    /// Starts (or restarts) a recording segment. Throws `.recognizerUnavailable`
    /// when the locale isn't supported or recognition is momentarily down —
    /// callers should render that as guidance, not a silent no-op.
    func start() throws {
        guard let recognizer, recognizer.isAvailable else {
            throw TranscriberError.recognizerUnavailable
        }

        stopEngine(deactivateSession: false)

        let recognitionRequest = SFSpeechAudioBufferRecognitionRequest()
        recognitionRequest.shouldReportPartialResults = true
        if recognizer.supportsOnDeviceRecognition {
            recognitionRequest.requiresOnDeviceRecognition = true
        }
        request = recognitionRequest

        let session = AVAudioSession.sharedInstance()
        try session.setCategory(.record, mode: .measurement, options: [.duckOthers])
        try session.setActive(true, options: .notifyOthersOnDeactivation)

        let inputNode = audioEngine.inputNode
        let format = inputNode.outputFormat(forBus: 0)
        inputNode.removeTap(onBus: 0)
        inputNode.installTap(onBus: 0, bufferSize: 1024, format: format) { [weak self] buffer, _ in
            recognitionRequest.append(buffer)
            let level = AudioLevelMeter.level(from: buffer)
            Task { @MainActor in
                self?.audioLevel = level
            }
        }

        audioEngine.prepare()
        try audioEngine.start()

        transcript = ""
        isRecording = true

        task = recognizer.recognitionTask(with: recognitionRequest) { [weak self] result, error in
            Task { @MainActor in
                guard let self else { return }
                if let result {
                    self.transcript = result.bestTranscription.formattedString
                }
                // A final result or an error both end this segment; the
                // engine/session must not linger listening either way.
                if error != nil || (result?.isFinal ?? false) {
                    self.stopEngine(deactivateSession: true)
                }
            }
        }
    }

    /// Stops the current segment. Safe to call repeatedly (e.g. from
    /// `onDisappear`, which must never leave the mic session active once the
    /// sheet is gone — including when backgrounded mid-recording).
    func stop() {
        stopEngine(deactivateSession: true)
    }

    private func stopEngine(deactivateSession: Bool) {
        if audioEngine.isRunning {
            audioEngine.stop()
            audioEngine.inputNode.removeTap(onBus: 0)
        }
        request?.endAudio()
        request = nil
        task?.cancel()
        task = nil
        isRecording = false
        audioLevel = 0
        if deactivateSession {
            try? AVAudioSession.sharedInstance().setActive(false, options: .notifyOthersOnDeactivation)
        }
    }
}
