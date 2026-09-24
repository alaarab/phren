import AVFoundation
import Foundation
import PhrenKit
import PhrenLive

/// ElevenLabs Scribe v2 Realtime, through the computer's Hook so the key
/// stays there. The microphone's audio goes up as 16 kHz mono PCM in 100 ms
/// chunks; committed sentences build up and the live guess follows them.
@MainActor
final class ScribeRecognizer: DictationRecognizing {
    private(set) var audioLevel: Float = 0
    var isRecognizerAvailable: Bool { true }

    private let host: LiveHost
    private let vocabulary: [String]
    private let engine = AVAudioEngine()
    private var socket: SpeechStreamSocket?
    private var listen: Task<Void, Never>?
    private var receive: (@MainActor (DictationRecognitionEvent) -> Void)?
    private var committed = ""

    init(host: LiveHost, vocabulary: [String] = SpeechSettings.vocabulary()) {
        self.host = host; self.vocabulary = vocabulary
    }

    func startSegment(id: UUID, receive: @escaping @MainActor (DictationRecognitionEvent) -> Void) throws {
        stop()
        self.receive = receive
        committed = ""
        let session = AVAudioSession.sharedInstance()
        try session.setCategory(.playAndRecord, mode: .measurement, options: [.defaultToSpeaker, .allowBluetoothHFP, .duckOthers])
        try session.setActive(true, options: .notifyOthersOnDeactivation)
        let socket = SpeechStreamSocket()
        self.socket = socket
        let input = engine.inputNode
        let format = input.outputFormat(forBus: 0)
        let output = AVAudioFormat(commonFormat: .pcmFormatInt16, sampleRate: 16_000, channels: 1, interleaved: true)!
        guard let converter = AVAudioConverter(from: format, to: output) else { throw LiveConnectionError.disconnected }
        // The tap runs on the audio thread: it converts with its own converter
        // and hands only bytes to the main actor.
        nonisolated(unsafe) let tapConverter = converter
        input.installTap(onBus: 0, bufferSize: AVAudioFrameCount(format.sampleRate / 10), format: format) { [weak self] buffer, _ in
            let level = Self.level(buffer)
            guard let pcm = Self.convert(buffer, with: tapConverter, to: output) else { return }
            Task { @MainActor [weak self] in
                self?.audioLevel = level
                try? await socket.send(pcm)
            }
        }
        engine.prepare()
        try engine.start()
        let host = host, keyterms = Array(vocabulary.prefix(50))
        listen = Task { [weak self] in
            do {
                let key = try DeviceSSHKey.load(host.id)
                for try await event in PhrenConnection.speechTranscription(host: host, privateKey: key, socket: socket,
                                                                           language: SpeechSettings.whisperLanguage, keyterms: keyterms) {
                    self?.handle(event)
                }
            } catch is CancellationError {
            } catch {
                self?.receive?(.failed(error.localizedDescription))
            }
        }
    }

    func stopSegment(keepingAudioSession: Bool) {
        receive = nil
        stop()
    }

    private func stop() {
        if engine.isRunning { engine.stop() }
        engine.inputNode.removeTap(onBus: 0)
        if let socket { Task { await socket.commit(); socket.close() } }
        socket = nil
        listen?.cancel(); listen = nil
        audioLevel = 0
    }

    private func handle(_ event: SpeechTranscriptEvent) {
        switch event {
        case .partial(let text): receive?(.partial(Self.join(committed, text)))
        case .committed(let text):
            committed = Self.join(committed, text)
            receive?(.partial(committed))
        case .failed(_, let message): receive?(.failed(message))
        }
    }

    private static func join(_ a: String, _ b: String) -> String {
        let b = b.trimmingCharacters(in: .whitespaces)
        return a.isEmpty ? b : b.isEmpty ? a : a + " " + b
    }

    nonisolated private static func convert(_ buffer: AVAudioPCMBuffer, with converter: AVAudioConverter, to output: AVAudioFormat) -> Data? {
        let ratio = output.sampleRate / buffer.format.sampleRate
        guard let out = AVAudioPCMBuffer(pcmFormat: output, frameCapacity: AVAudioFrameCount(Double(buffer.frameLength) * ratio) + 16) else { return nil }
        var fed = false
        var error: NSError?
        converter.convert(to: out, error: &error) { _, status in
            if fed { status.pointee = .noDataNow; return nil }
            fed = true; status.pointee = .haveData; return buffer
        }
        guard error == nil, let samples = out.int16ChannelData, out.frameLength > 0 else { return nil }
        return Data(bytes: samples[0], count: Int(out.frameLength) * 2)
    }

    nonisolated private static func level(_ buffer: AVAudioPCMBuffer) -> Float {
        guard let data = buffer.floatChannelData, buffer.frameLength > 0 else { return 0 }
        var sum: Float = 0
        for index in 0..<Int(buffer.frameLength) { sum += data[0][index] * data[0][index] }
        return min(1, (sum / Float(buffer.frameLength)).squareRoot() * 8)
    }
}
