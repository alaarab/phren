import AVFAudio
import CoreMedia
import Speech

/// iOS 26's long-form dictation model behind `SpeechAnalyzer`. One pipeline
/// runs for the whole time the microphone is open: pauses of any length and
/// sends mid-dictation don't restart it, so no words fall between requests.
@available(iOS 26.0, *)
final class AnalyzerPipeline: @unchecked Sendable {
    struct Piece: Sendable {
        var runs: [AnalyzerTranscript.Run]
        var start: Double
        var end: Double
        var isFinal: Bool
    }

    enum PipelineError: LocalizedError {
        case noAudioFormat
        var errorDescription: String? { "The dictation model can't read this microphone's audio." }
    }

    private let transcriber: DictationTranscriber
    private let analyzer: SpeechAnalyzer
    private var feedTask: Task<Void, Never>?
    private var resultsTask: Task<Void, Never>?

    init(locale: Locale) {
        transcriber = Self.makeTranscriber(locale: locale)
        analyzer = SpeechAnalyzer(modules: [transcriber],
                                  options: .init(priority: .userInitiated, modelRetention: .lingering))
    }

    private static func makeTranscriber(locale: Locale) -> DictationTranscriber {
        // No shortForm hint: this is long-form dictation.
        DictationTranscriber(locale: locale, contentHints: [], transcriptionOptions: [.punctuation],
                             reportingOptions: [.volatileResults, .frequentFinalization],
                             attributeOptions: [.audioTimeRange])
    }

    /// The model's locale for `locale`, or nil while its assets aren't on
    /// this device. The simulator reports the model installed but offers no
    /// audio format for it, so that counts as missing too.
    static func installedLocale(for locale: Locale) async -> Locale? {
        guard let supported = await DictationTranscriber.supportedLocale(equivalentTo: locale) else { return nil }
        let module = makeTranscriber(locale: supported)
        guard await AssetInventory.status(forModules: [module]) == .installed,
              await !module.availableCompatibleAudioFormats.isEmpty else { return nil }
        return supported
    }

    /// Downloads the model in the background so the next dictation uses it.
    static func requestInstall(for locale: Locale) {
        Task.detached(priority: .utility) {
            guard let supported = await DictationTranscriber.supportedLocale(equivalentTo: locale) else { return }
            try? await AssetInventory.assetInstallationRequest(supporting: [makeTranscriber(locale: supported)])?.downloadAndInstall()
        }
    }

    /// Starts analysing `audio` (buffers in `format`). The results end when
    /// the audio ends or `cancel()` is called.
    func start(audio: AsyncStream<AVAudioPCMBuffer>, format: AVAudioFormat, vocabulary: [String]) async throws -> AsyncThrowingStream<Piece, Error> {
        if !vocabulary.isEmpty {
            let context = AnalysisContext()
            context.contextualStrings[.general] = vocabulary
            try await analyzer.setContext(context)
        }
        guard let target = await SpeechAnalyzer.bestAvailableAudioFormat(compatibleWith: [transcriber], considering: format) else {
            throw PipelineError.noAudioFormat
        }
        try await analyzer.prepareToAnalyze(in: target)
        let (inputs, feed) = AsyncStream<AnalyzerInput>.makeStream()
        try await analyzer.start(inputSequence: inputs)

        let (pieces, output) = AsyncThrowingStream<Piece, Error>.makeStream()
        let transcriber = transcriber
        resultsTask = Task {
            do {
                for try await result in transcriber.results {
                    output.yield(Piece(runs: Self.runs(of: result.text), start: result.range.start.seconds,
                                       end: result.range.end.seconds, isFinal: result.isFinal))
                }
                output.finish()
            } catch {
                output.finish(throwing: error)
            }
        }
        let analyzer = analyzer
        feedTask = Task {
            let converter = format == target ? nil : AVAudioConverter(from: format, to: target)
            for await buffer in audio {
                guard !Task.isCancelled else { break }
                if let converted = Self.convert(buffer, with: converter, to: target) {
                    feed.yield(AnalyzerInput(buffer: converted))
                }
            }
            feed.finish()
            if Task.isCancelled { return }
            try? await analyzer.finalizeAndFinishThroughEndOfInput()
        }
        return pieces
    }

    /// Settles every word heard before `seconds`, so the next volatile
    /// result starts after it.
    func finalize(through seconds: Double) async {
        try? await analyzer.finalize(through: CMTime(seconds: seconds, preferredTimescale: 48_000))
    }

    func cancel() async {
        feedTask?.cancel()
        await analyzer.cancelAndFinishNow()
        resultsTask?.cancel()
    }

    static func runs(of text: AttributedString) -> [AnalyzerTranscript.Run] {
        text.runs.map { run in
            AnalyzerTranscript.Run(String(text[run.range].characters),
                                   start: run[AttributeScopes.SpeechAttributes.TimeRangeAttribute.self]?.start.seconds)
        }
    }

    private static func convert(_ buffer: AVAudioPCMBuffer, with converter: AVAudioConverter?, to format: AVAudioFormat) -> AVAudioPCMBuffer? {
        guard let converter else { return buffer }
        let capacity = AVAudioFrameCount((Double(buffer.frameLength) * format.sampleRate / buffer.format.sampleRate).rounded(.up)) + 16
        guard let output = AVAudioPCMBuffer(pcmFormat: format, frameCapacity: capacity) else { return nil }
        var consumed = false
        var error: NSError?
        let status = converter.convert(to: output, error: &error) { _, inputStatus in
            if consumed {
                inputStatus.pointee = .noDataNow
                return nil
            }
            consumed = true
            inputStatus.pointee = .haveData
            return buffer
        }
        return status == .error || output.frameLength == 0 ? nil : output
    }
}
