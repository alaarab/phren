import AVFAudio

/// What talk mode speaks with; a fake stands in for it in tests.
@MainActor
protocol TalkSpeaking: AnyObject {
    /// Returns when the reply has played or `stop()` cut it off.
    func speak(_ text: String) async
    func stop()
}

/// Reads a reply aloud a sentence at a time, voicing the next sentence while
/// the current one plays. The computer's ElevenLabs voice comes first; when
/// the Hook can't (offline, no key, an older Hook) the rest of the reply uses
/// the best Apple voice on the phone.
///
/// Playback goes through the microphone's own audio engine when it is open,
/// so voice processing hears the reply and cancels it from the input: that
/// keeps the reply from barging in on itself.
@MainActor
final class TalkVoice: TalkSpeaking {
    /// One sentence as raw 16-bit little-endian mono PCM at 24 kHz.
    typealias Fetch = @MainActor (String) async throws -> Data

    static let format = AVAudioFormat(commonFormat: .pcmFormatFloat32, sampleRate: 24_000, channels: 1, interleaved: false)!

    private let fetch: Fetch?
    private weak var transcriber: SpeechTranscriber?
    private let player = AVAudioPlayerNode()
    private var ownEngine: AVAudioEngine?
    private var generation = 0
    private var remoteDown = false
    private let language: String
    /// Whether the last reply fell back to the phone's own voice.
    private(set) var usedAppleVoice = false

    init(fetch: Fetch?, transcriber: SpeechTranscriber?, language: String? = nil) {
        self.fetch = fetch
        self.transcriber = transcriber
        self.language = language ?? SpeechSettings.locale.identifier(.bcp47)
    }

    func speak(_ text: String) async {
        generation += 1
        let id = generation
        remoteDown = fetch == nil
        usedAppleVoice = false
        let sentences = SpokenReply.sentences(text)
        guard !sentences.isEmpty, prepareOutput() else { return }
        var next: Task<AVAudioPCMBuffer?, Never>? = voiced(sentences[0])
        for index in sentences.indices {
            guard let pending = next else { break }
            let buffer = await pending.value
            guard id == generation else { return }
            next = index + 1 < sentences.count ? voiced(sentences[index + 1]) : nil
            if let buffer { await play(buffer) }
            guard id == generation else { return }
        }
    }

    func stop() {
        generation += 1
        // Stopping calls every scheduled buffer's completion, which ends the
        // wait in `play`.
        if player.engine != nil { player.stop() }
    }

    // MARK: Voicing

    private func voiced(_ sentence: String) -> Task<AVAudioPCMBuffer?, Never> {
        Task { @MainActor in
            if !remoteDown, let fetch {
                do {
                    return Self.buffer(pcm16: try await fetch(sentence))
                } catch {
                    remoteDown = true
                }
            }
            usedAppleVoice = true
            return await Self.appleBuffer(sentence, language: language)
        }
    }

    /// 16-bit samples to the player's float format.
    static func buffer(pcm16 data: Data) -> AVAudioPCMBuffer? {
        let frames = data.count / 2
        guard frames > 0, let buffer = AVAudioPCMBuffer(pcmFormat: format, frameCapacity: AVAudioFrameCount(frames)),
              let channel = buffer.floatChannelData?[0] else { return nil }
        buffer.frameLength = AVAudioFrameCount(frames)
        data.withUnsafeBytes { raw in
            for index in 0..<frames {
                let sample = Int16(littleEndian: raw.loadUnaligned(fromByteOffset: index * 2, as: Int16.self))
                channel[index] = Float(sample) / 32_768
            }
        }
        return buffer
    }

    /// The phone's best installed voice for the language: premium, then
    /// enhanced, then default; never a novelty voice.
    static func bestVoice(for language: String, among voices: [AVSpeechSynthesisVoice] = AVSpeechSynthesisVoice.speechVoices()) -> AVSpeechSynthesisVoice? {
        let family = String(language.prefix(2))
        let candidates = voices.filter { !$0.voiceTraits.contains(.isNoveltyVoice) }
        let exact = candidates.filter { $0.language == language }
        let pool = exact.isEmpty ? candidates.filter { $0.language.hasPrefix(family) } : exact
        return pool.max { $0.quality.rawValue < $1.quality.rawValue } ?? AVSpeechSynthesisVoice(language: language)
    }

    private static func appleBuffer(_ sentence: String, language: String) async -> AVAudioPCMBuffer? {
        let utterance = AVSpeechUtterance(string: sentence)
        utterance.voice = bestVoice(for: language)
        let synthesizer = AVSpeechSynthesizer()
        let pieces: [AVAudioPCMBuffer] = await withCheckedContinuation { continuation in
            var collected: [AVAudioPCMBuffer] = []
            var finished = false
            synthesizer.write(utterance) { buffer in
                guard !finished else { return }
                guard let pcm = buffer as? AVAudioPCMBuffer, pcm.frameLength > 0 else {
                    finished = true
                    continuation.resume(returning: collected)
                    return
                }
                collected.append(pcm)
            }
        }
        _ = synthesizer // held until the last buffer arrives
        return concatenate(pieces)
    }

    /// Converts the synthesizer's buffers to the player's format as one buffer.
    static func concatenate(_ pieces: [AVAudioPCMBuffer]) -> AVAudioPCMBuffer? {
        guard let first = pieces.first, let converter = AVAudioConverter(from: first.format, to: format) else { return nil }
        let ratio = format.sampleRate / first.format.sampleRate
        let total = pieces.reduce(0) { $0 + Int(Double($1.frameLength) * ratio) + 64 }
        guard let output = AVAudioPCMBuffer(pcmFormat: format, frameCapacity: AVAudioFrameCount(total)) else { return nil }
        var queue = pieces[...]
        var error: NSError?
        _ = converter.convert(to: output, error: &error) { _, status in
            guard let next = queue.popFirst() else {
                status.pointee = .endOfStream
                return nil
            }
            status.pointee = .haveData
            return next
        }
        return error == nil && output.frameLength > 0 ? output : nil
    }

    // MARK: Playback

    private func prepareOutput() -> Bool {
        if let transcriber, transcriber.attach(player, format: Self.format) {
            ownEngine = nil
            return true
        }
        // Nothing is listening: play on an engine of our own.
        let engine = ownEngine ?? AVAudioEngine()
        if player.engine !== engine {
            player.engine?.detach(player)
            engine.attach(player)
        }
        engine.connect(player, to: engine.mainMixerNode, format: Self.format)
        do {
            if !engine.isRunning { try engine.start() }
        } catch {
            return false
        }
        ownEngine = engine
        return true
    }

    private func play(_ buffer: AVAudioPCMBuffer) async {
        // The microphone can close underneath a reply (an interruption).
        guard player.engine?.isRunning == true else { return }
        await withCheckedContinuation { (continuation: CheckedContinuation<Void, Never>) in
            player.scheduleBuffer(buffer, completionCallbackType: .dataPlayedBack) { _ in
                continuation.resume()
            }
            if !player.isPlaying { player.play() }
        }
    }
}
