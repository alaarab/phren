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
/// `DictationSession` owns text and segment transitions. This adapter owns
/// the audio resources and fences callbacks before cancellation can reenter.
@MainActor
@Observable
final class SpeechTranscriber: DictationRecognizing {
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

    /// Normalized 0...1 input level for the mic button's pulse.
    private(set) var audioLevel: Float = 0

    private let recognizer: SFSpeechRecognizer?
    private let audioEngine = AVAudioEngine()
    private var request: SFSpeechAudioBufferRecognitionRequest?
    private var task: SFSpeechRecognitionTask?
    private var segmentID: UUID?
    private var tapInstalled = false
    private var audioSessionActive = false
    private var segmentTimer: Task<Void, Never>?
    private var interruptionObserver: NSObjectProtocol?

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

    func startSegment(id: UUID, receive: @escaping @MainActor (DictationRecognitionEvent) -> Void) throws {
        stopSegment(keepingAudioSession: true)
        guard let recognizer, recognizer.isAvailable else {
            throw TranscriberError.recognizerUnavailable
        }
        segmentID = id

        do {
            let recognitionRequest = SFSpeechAudioBufferRecognitionRequest()
            recognitionRequest.shouldReportPartialResults = true
            if recognizer.supportsOnDeviceRecognition {
                recognitionRequest.requiresOnDeviceRecognition = true
            }
            request = recognitionRequest

            let session = AVAudioSession.sharedInstance()
            if !audioSessionActive {
                try session.setCategory(.record, mode: .measurement, options: [.duckOthers])
                try session.setActive(true, options: .notifyOthersOnDeactivation)
                audioSessionActive = true
            }

            let inputNode = audioEngine.inputNode
            let format = inputNode.outputFormat(forBus: 0)
            guard format.sampleRate > 0, format.channelCount > 0 else {
                throw TranscriberError.recognizerUnavailable
            }
            inputNode.installTap(onBus: 0, bufferSize: 1024, format: format) { [weak self] buffer, _ in
                recognitionRequest.append(buffer)
                let level = AudioLevelMeter.level(from: buffer)
                Task { @MainActor in
                    guard let self, self.segmentID == id else { return }
                    self.audioLevel = level
                }
            }
            tapInstalled = true
            audioEngine.prepare()
            try audioEngine.start()

            task = recognizer.recognitionTask(with: recognitionRequest) { [weak self] result, error in
                Task { @MainActor in
                    guard let self, self.segmentID == id else { return }
                    if let result {
                        receive(.partial(result.bestTranscription.formattedString))
                    }
                    guard self.segmentID == id else { return }
                    if let error {
                        receive(.failed(error.localizedDescription))
                    } else if let result, result.isFinal {
                        receive(.finished(result.bestTranscription.formattedString))
                    }
                }
            }
            // Roll over before the server's one-minute request limit, even
            // when it produces neither a final result nor an error.
            segmentTimer = Task { [weak self] in
                do { try await Task.sleep(for: .seconds(55)) } catch { return }
                guard let self, self.segmentID == id else { return }
                receive(.finished(""))
            }
            interruptionObserver = NotificationCenter.default.addObserver(
                forName: AVAudioSession.interruptionNotification, object: session, queue: .main
            ) { [weak self] notification in
                guard let type = notification.userInfo?[AVAudioSessionInterruptionTypeKey] as? UInt,
                      type == AVAudioSession.InterruptionType.began.rawValue else { return }
                Task { @MainActor in
                    guard let self, self.segmentID == id else { return }
                    self.audioSessionActive = false
                    receive(.failed("The microphone was interrupted."))
                }
            }
        } catch {
            stopSegment(keepingAudioSession: false)
            throw error
        }
    }

    func stopSegment(keepingAudioSession: Bool) {
        // Cancelled requests can still call back after the next one starts.
        segmentID = nil
        segmentTimer?.cancel()
        segmentTimer = nil
        if let interruptionObserver { NotificationCenter.default.removeObserver(interruptionObserver) }
        interruptionObserver = nil
        if audioEngine.isRunning { audioEngine.stop() }
        if tapInstalled {
            audioEngine.inputNode.removeTap(onBus: 0)
            tapInstalled = false
        }
        request?.endAudio()
        request = nil
        task?.cancel()
        task = nil
        audioLevel = 0
        if !keepingAudioSession, audioSessionActive {
            try? AVAudioSession.sharedInstance().setActive(false, options: .notifyOthersOnDeactivation)
            audioSessionActive = false
        }
    }
}
