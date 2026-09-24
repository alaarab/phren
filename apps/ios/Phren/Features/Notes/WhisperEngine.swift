import Foundation
import Network
import Observation
@preconcurrency import WhisperKit

/// Whisper on the phone: large-v3 turbo, 4-bit compressed (632 MB). The turbo
/// decoder keeps up with speech on the Neural Engine and the compressed
/// weights keep large-v3's accuracy at under half the size. Nothing downloads
/// until the person picks Whisper, and only over Wi-Fi.
@Observable @MainActor
final class WhisperModelStore {
    static let shared = WhisperModelStore()
    static let variant = "large-v3-v20240930_turbo_632MB"
    static let sizeLabel = "632 MB"

    enum State: Equatable {
        case absent
        case downloading(Double)
        case ready
        case failed(String)
    }

    private(set) var state: State = .absent
    @ObservationIgnored private var downloadTask: Task<Void, Never>?
    @ObservationIgnored private var pipe: WhisperKit?
    @ObservationIgnored private var loading: Task<WhisperKit, Error>?

    private static var root: URL {
        URL.applicationSupportDirectory.appending(path: "whisper-models", directoryHint: .isDirectory)
    }
    private static let folderKey = "voice.whisper-folder.v1"

    /// The model's folder, once a download finished.
    private var folder: URL? {
        guard let path = AppRuntime.defaults.string(forKey: Self.folderKey) else { return nil }
        let url = URL(fileURLWithPath: path)
        return FileManager.default.fileExists(atPath: url.path) ? url : nil
    }

    init() { if folder != nil { state = .ready } }

    var isReady: Bool { state == .ready }

    /// Downloads over Wi-Fi only; on a cellular or expensive link it says so
    /// and waits for the person to try again.
    func download() {
        guard downloadTask == nil, state != .ready else { return }
        downloadTask = Task {
            defer { downloadTask = nil }
            guard await Self.onWiFi() else {
                state = .failed("Connect to Wi-Fi to download the \(Self.sizeLabel) model.")
                return
            }
            state = .downloading(0)
            do {
                let url = try await WhisperKit.download(variant: Self.variant, downloadBase: Self.root) { progress in
                    let fraction = progress.fractionCompleted
                    Task { @MainActor in
                        if case .downloading = WhisperModelStore.shared.state { WhisperModelStore.shared.state = .downloading(fraction) }
                    }
                }
                AppRuntime.defaults.set(url.path, forKey: Self.folderKey)
                state = .ready
            } catch is CancellationError {
                state = .absent
            } catch {
                state = .failed("The download stopped: \(error.localizedDescription)")
            }
        }
    }

    func cancelDownload() { downloadTask?.cancel() }

    /// Frees the space; the Apple engine takes over until it is downloaded again.
    func remove() {
        downloadTask?.cancel()
        pipe = nil; loading = nil
        AppRuntime.defaults.removeObject(forKey: Self.folderKey)
        try? FileManager.default.removeItem(at: Self.root)
        state = .absent
    }

    /// The loaded model, shared by every recogniser; loading takes a few
    /// seconds the first time after launch.
    func loadedPipe() async throws -> WhisperKit {
        if let pipe { return pipe }
        if let loading { return try await loading.value }
        guard let folder else { throw WhisperEngineError.notDownloaded }
        let task = Task { () throws -> WhisperKit in
            try await WhisperKit(WhisperKitConfig(modelFolder: folder.path, verbose: false, logLevel: .error,
                                                  prewarm: true, load: true, download: false))
        }
        loading = task
        do {
            let value = try await task.value
            pipe = value; loading = nil
            return value
        } catch {
            loading = nil
            throw error
        }
    }

    private static func onWiFi() async -> Bool {
        await withCheckedContinuation { continuation in
            let monitor = NWPathMonitor()
            monitor.pathUpdateHandler = { path in
                monitor.cancel()
                continuation.resume(returning: path.status == .satisfied && path.usesInterfaceType(.wifi) && !path.isExpensive)
            }
            monitor.start(queue: .global(qos: .utility))
        }
    }
}

enum WhisperEngineError: LocalizedError {
    case notDownloaded
    var errorDescription: String? { "The Whisper model isn't downloaded." }
}

/// Streams the microphone through Whisper. Confirmed segments plus the
/// latest guess make the partial text the session shows.
@MainActor
final class WhisperRecognizer: DictationRecognizing {
    private(set) var audioLevel: Float = 0
    var isRecognizerAvailable: Bool { WhisperModelStore.shared.isReady }

    private var transcriber: AudioStreamTranscriber?
    private var task: Task<Void, Never>?
    private var receive: (@MainActor (DictationRecognitionEvent) -> Void)?
    private var text = ""
    private let vocabulary: [String]

    init(vocabulary: [String] = SpeechSettings.vocabulary()) { self.vocabulary = vocabulary }

    func startSegment(id: UUID, receive: @escaping @MainActor (DictationRecognitionEvent) -> Void) throws {
        guard isRecognizerAvailable else { throw WhisperEngineError.notDownloaded }
        stopStream()
        self.receive = receive
        text = ""
        task = Task { [weak self] in
            do {
                let pipe = try await WhisperModelStore.shared.loadedPipe()
                guard let self, !Task.isCancelled, let tokenizer = pipe.tokenizer else { return }
                // The project names and replacements steer spelling, as the
                // Apple engine's contextual strings do.
                let prompt = self.vocabulary.prefix(40).joined(separator: ", ")
                let promptTokens = prompt.isEmpty ? nil
                    : tokenizer.encode(text: " " + prompt).filter { $0 < tokenizer.specialTokens.specialTokenBegin }
                let options = DecodingOptions(language: SpeechSettings.whisperLanguage, skipSpecialTokens: true,
                                              withoutTimestamps: false, promptTokens: promptTokens)
                let stream = AudioStreamTranscriber(
                    audioEncoder: pipe.audioEncoder, featureExtractor: pipe.featureExtractor, segmentSeeker: pipe.segmentSeeker,
                    textDecoder: pipe.textDecoder, tokenizer: tokenizer, audioProcessor: pipe.audioProcessor,
                    decodingOptions: options
                ) { _, state in
                    let words = (state.confirmedSegments.map(\.text) + [state.unconfirmedSegments.map(\.text).joined()])
                        .joined().trimmingCharacters(in: .whitespacesAndNewlines)
                    let level = state.bufferEnergy.last ?? 0
                    Task { @MainActor [weak self] in self?.update(words, level: level) }
                }
                self.transcriber = stream
                try await stream.startStreamTranscription()
            } catch is CancellationError {
            } catch {
                await MainActor.run { [weak self] in self?.receive?(.failed(error.localizedDescription)) }
            }
        }
    }

    /// The session already holds the last partial; like the Apple engine,
    /// stopping reports nothing more.
    func stopSegment(keepingAudioSession: Bool) {
        receive = nil
        stopStream()
    }

    private func update(_ words: String, level: Float) {
        audioLevel = min(1, level)
        guard receive != nil, words != text else { return }
        text = words
        receive?(.partial(words))
    }

    private func stopStream() {
        task?.cancel(); task = nil
        if let transcriber { Task { await transcriber.stopStreamTranscription() } }
        transcriber = nil
        audioLevel = 0
    }
}
