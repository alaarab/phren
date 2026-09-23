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

/// Hands microphone buffers from the audio thread to whichever recogniser
/// is listening, and counts them so a segment knows where it starts on the
/// analyzer's timeline.
private final class AudioRelay: @unchecked Sendable {
    private let lock = NSLock()
    private var continuation: AsyncStream<AVAudioPCMBuffer>.Continuation?
    private var legacyRequest: SFSpeechAudioBufferRecognitionRequest?
    private var frames: Int64 = 0
    private var sampleRate: Double = 0

    func begin(sampleRate: Double) -> AsyncStream<AVAudioPCMBuffer> {
        let (stream, continuation) = AsyncStream<AVAudioPCMBuffer>.makeStream()
        lock.withLock {
            self.continuation?.finish()
            self.continuation = continuation
            self.sampleRate = sampleRate
            frames = 0
        }
        return stream
    }

    func end() {
        lock.withLock {
            continuation?.finish()
            continuation = nil
            legacyRequest = nil
        }
    }

    /// The old recogniser takes buffers straight from the tap.
    func route(to request: SFSpeechAudioBufferRecognitionRequest?) {
        lock.withLock {
            continuation?.finish()
            continuation = nil
            legacyRequest = request
        }
    }

    func deliver(_ buffer: AVAudioPCMBuffer) {
        lock.withLock {
            frames += Int64(buffer.frameLength)
            continuation?.yield(buffer)
            legacyRequest?.append(buffer)
        }
    }

    /// Seconds of audio captured since `begin`.
    var seconds: Double {
        lock.withLock { sampleRate > 0 ? Double(frames) / sampleRate : 0 }
    }
}

/// Tap-to-toggle live dictation from the microphone. On iOS 26, with the
/// dictation model installed, one `SpeechAnalyzer` pipeline listens for as
/// long as the mic is open. Otherwise `SFSpeechRecognizer` does, restarted
/// every 55 seconds for its request limit, and the new model is downloaded
/// for next time.
///
/// The microphone runs through voice processing (echo cancellation, noise
/// suppression, automatic gain), and both recognisers are given the app's
/// vocabulary so "phren" and project names come through.
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
        case noMicrophone

        var errorDescription: String? {
            switch self {
            case .recognizerUnavailable:
                return "Dictation isn't available in this language on this device."
            case .noMicrophone:
                return "No microphone is available."
            }
        }
    }

    private enum Mode { case pending, analyzer, legacy }

    /// Normalized 0...1 input level for the mic button's pulse.
    private(set) var audioLevel: Float = 0
    /// Whether the long-form model is installed for this language.
    private(set) var usesAnalyzer = false

    @ObservationIgnored private let locale: Locale
    @ObservationIgnored private let legacyRecognizer: SFSpeechRecognizer?
    @ObservationIgnored private let audioEngine = AVAudioEngine()
    @ObservationIgnored private let relay = AudioRelay()
    @ObservationIgnored private var capturing = false
    @ObservationIgnored private var captureID = UUID()
    @ObservationIgnored private var audioSessionActive = false
    @ObservationIgnored private var observers: [NSObjectProtocol] = []
    @ObservationIgnored private var mode = Mode.pending
    @ObservationIgnored private var vocabulary: [String] = []
    @ObservationIgnored private var recognitionTask: Task<Void, Never>?
    @ObservationIgnored private var pipeline: AnyObject?

    @ObservationIgnored private var segmentID: UUID?
    @ObservationIgnored private var receive: (@MainActor (DictationRecognitionEvent) -> Void)?
    @ObservationIgnored private var transcript = AnalyzerTranscript()
    @ObservationIgnored private var legacyRequest: SFSpeechAudioBufferRecognitionRequest?
    @ObservationIgnored private var legacyTask: SFSpeechRecognitionTask?
    @ObservationIgnored private var segmentTimer: Task<Void, Never>?

    init(locale: Locale = SpeechSettings.locale) {
        self.locale = locale
        legacyRecognizer = SFSpeechRecognizer(locale: locale) ?? SFSpeechRecognizer()
        if #available(iOS 26.0, *) {
            Task { [weak self] in
                let installed = await AnalyzerPipeline.installedLocale(for: locale) != nil
                self?.usesAnalyzer = installed
            }
        }
    }

    /// False when the locale isn't supported at all, or recognition is
    /// temporarily down (e.g. no network and no on-device model for it).
    var isRecognizerAvailable: Bool {
        usesAnalyzer || (legacyRecognizer?.isAvailable ?? false)
    }

    var supportsOnDeviceRecognition: Bool {
        usesAnalyzer || (legacyRecognizer?.supportsOnDeviceRecognition ?? false)
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
        guard isRecognizerAvailable else { throw TranscriberError.recognizerUnavailable }
        do {
            if !capturing { try startCapture() }
        } catch {
            stopSegment(keepingAudioSession: false)
            throw error
        }
        segmentID = id
        self.receive = receive
        let cutoff = relay.seconds
        transcript = AnalyzerTranscript(cutoff: cutoff)
        switch mode {
        case .analyzer:
            if #available(iOS 26.0, *), cutoff > 0, let pipeline = pipeline as? AnalyzerPipeline {
                Task { await pipeline.finalize(through: cutoff) }
            }
        case .legacy:
            startLegacyRequest(id: id)
        case .pending:
            break // the recogniser picks the segment up once it is chosen
        }
    }

    func stopSegment(keepingAudioSession: Bool) {
        // Cancelled requests can still call back after the next one starts.
        segmentID = nil
        receive = nil
        stopLegacyRequest()
        audioLevel = 0
        if !keepingAudioSession { stopCapture() }
    }

    /// Plays `player` through the microphone's own engine, so voice
    /// processing hears what plays and cancels it from the input. False
    /// while the microphone is closed.
    func attach(_ player: AVAudioPlayerNode, format: AVAudioFormat) -> Bool {
        guard capturing, audioEngine.isRunning else { return false }
        if player.engine !== audioEngine {
            player.engine?.detach(player)
            audioEngine.attach(player)
            audioEngine.connect(player, to: audioEngine.mainMixerNode, format: format)
        }
        return true
    }

    // MARK: Microphone

    private func startCapture() throws {
        // Reassert the session on every capture. setActive(true) on an
        // already-active session is a no-op. voiceChat is the mode that
        // turns on the system's echo cancellation and noise suppression.
        let session = AVAudioSession.sharedInstance()
        try session.setCategory(.playAndRecord, mode: .voiceChat,
                                options: [.duckOthers, .defaultToSpeaker, .allowBluetoothHFP])
        try session.setActive(true, options: .notifyOthersOnDeactivation)
        audioSessionActive = true
        guard session.isInputAvailable else { throw TranscriberError.noMicrophone }

        let inputNode = audioEngine.inputNode
        if !inputNode.isVoiceProcessingEnabled {
            // Some routes (and the simulator) can't; dictation still works.
            try? inputNode.setVoiceProcessingEnabled(true)
        }
        if inputNode.isVoiceProcessingEnabled {
            inputNode.isVoiceProcessingAGCEnabled = true
            inputNode.voiceProcessingOtherAudioDuckingConfiguration = .init(enableAdvancedDucking: true, duckingLevel: .min)
            _ = audioEngine.mainMixerNode // voice processing needs the output side wired
        }
        let format = inputNode.outputFormat(forBus: 0)
        guard format.sampleRate > 0, format.channelCount > 0 else { throw TranscriberError.noMicrophone }
        let audio = relay.begin(sampleRate: format.sampleRate)
        let id = UUID()
        captureID = id
        inputNode.installTap(onBus: 0, bufferSize: 1024, format: format) { [weak self, relay] buffer, _ in
            relay.deliver(buffer)
            let level = AudioLevelMeter.level(from: buffer)
            Task { @MainActor in
                guard let self, self.captureID == id, self.segmentID != nil else { return }
                self.audioLevel = level
            }
        }
        audioEngine.prepare()
        do {
            try audioEngine.start()
        } catch {
            inputNode.removeTap(onBus: 0)
            relay.end()
            throw error
        }
        capturing = true
        vocabulary = SpeechSettings.vocabulary()
        observe(session: session, capture: id)
        recognitionTask = Task { [weak self] in
            await self?.runRecognition(audio: audio, format: format, capture: id)
        }
    }

    private func stopCapture() {
        captureID = UUID()
        recognitionTask?.cancel()
        recognitionTask = nil
        if #available(iOS 26.0, *), let pipeline = pipeline as? AnalyzerPipeline {
            Task { await pipeline.cancel() }
        }
        pipeline = nil
        mode = .pending
        observers.forEach(NotificationCenter.default.removeObserver)
        observers = []
        if audioEngine.isRunning { audioEngine.stop() }
        if capturing { audioEngine.inputNode.removeTap(onBus: 0) }
        capturing = false
        relay.end()
        if audioSessionActive {
            try? AVAudioSession.sharedInstance().setActive(false, options: .notifyOthersOnDeactivation)
            audioSessionActive = false
        }
    }

    private func observe(session: AVAudioSession, capture id: UUID) {
        observers.append(NotificationCenter.default.addObserver(
            forName: AVAudioSession.interruptionNotification, object: session, queue: .main
        ) { [weak self] notification in
            guard let type = notification.userInfo?[AVAudioSessionInterruptionTypeKey] as? UInt,
                  type == AVAudioSession.InterruptionType.began.rawValue else { return }
            Task { @MainActor in
                guard let self, self.captureID == id else { return }
                self.audioSessionActive = false
                self.fail("The microphone was interrupted.")
            }
        })
        // A route change (headphones, a call) stops the engine underneath us.
        observers.append(NotificationCenter.default.addObserver(
            forName: .AVAudioEngineConfigurationChange, object: audioEngine, queue: .main
        ) { [weak self] _ in
            Task { @MainActor in
                guard let self, self.captureID == id else { return }
                self.fail("The microphone changed.")
            }
        })
    }

    /// Tears the capture down and reports the failure to the listening
    /// segment, whose owner decides whether to start again.
    private func fail(_ reason: String) {
        let receive = self.receive
        stopSegment(keepingAudioSession: false)
        receive?(.failed(reason))
    }

    // MARK: Recognition

    private func runRecognition(audio: AsyncStream<AVAudioPCMBuffer>, format: AVAudioFormat, capture id: UUID) async {
        if #available(iOS 26.0, *) {
            if let modelLocale = await AnalyzerPipeline.installedLocale(for: locale) {
                guard captureID == id else { return }
                await runAnalyzer(AnalyzerPipeline(locale: modelLocale), audio: audio, format: format, capture: id)
                return
            }
            AnalyzerPipeline.requestInstall(for: locale)
        }
        guard captureID == id else { return }
        useLegacy()
    }

    private func useLegacy() {
        mode = .legacy
        relay.route(to: nil) // buffers go to each request from here on
        if let segmentID { startLegacyRequest(id: segmentID) }
    }

    @available(iOS 26.0, *)
    private func runAnalyzer(_ pipeline: AnalyzerPipeline, audio: AsyncStream<AVAudioPCMBuffer>, format: AVAudioFormat, capture id: UUID) async {
        self.pipeline = pipeline
        mode = .analyzer
        usesAnalyzer = true
        let pieces: AsyncThrowingStream<AnalyzerPipeline.Piece, Error>
        do {
            pieces = try await pipeline.start(audio: audio, format: format, vocabulary: vocabulary)
        } catch {
            guard captureID == id else { return }
            self.pipeline = nil
            usesAnalyzer = false
            useLegacy()
            return
        }
        do {
            for try await piece in pieces {
                guard captureID == id else { return }
                guard let receive, segmentID != nil else { continue }
                if transcript.apply(runs: piece.runs, start: piece.start, end: piece.end, isFinal: piece.isFinal) {
                    receive(.partial(transcript.text))
                }
            }
        } catch {
            guard captureID == id, !Task.isCancelled else { return }
            fail(error.localizedDescription)
        }
    }

    private func startLegacyRequest(id: UUID) {
        guard let recognizer = legacyRecognizer, let receive else { return }
        let request = SFSpeechAudioBufferRecognitionRequest()
        request.shouldReportPartialResults = true
        request.addsPunctuation = true
        request.contextualStrings = vocabulary
        if recognizer.supportsOnDeviceRecognition {
            request.requiresOnDeviceRecognition = true
        }
        legacyRequest = request
        relay.route(to: request)
        legacyTask = recognizer.recognitionTask(with: request) { [weak self] result, error in
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
    }

    private func stopLegacyRequest() {
        segmentTimer?.cancel()
        segmentTimer = nil
        guard legacyRequest != nil || legacyTask != nil else { return }
        relay.route(to: nil)
        legacyRequest?.endAudio()
        legacyRequest = nil
        legacyTask?.cancel()
        legacyTask = nil
    }
}
