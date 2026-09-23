import AVFAudio
import XCTest
@testable import Phren

final class AnalyzerTranscriptTests: XCTestCase {
    typealias Run = AnalyzerTranscript.Run

    func testVolatileResultsReplaceEachOtherAndFinalsAccumulate() {
        var transcript = AnalyzerTranscript()
        transcript.apply(runs: [Run("Please open")], start: 0, end: 1, isFinal: false)
        transcript.apply(runs: [Run("Please open the tasks too")], start: 0, end: 2, isFinal: false)
        // The model revises its guess shorter as well as longer.
        transcript.apply(runs: [Run("Please open the task")], start: 0, end: 2, isFinal: false)
        XCTAssertEqual(transcript.text, "Please open the task")
        transcript.apply(runs: [Run("Please open the tasks.")], start: 0, end: 2.5, isFinal: true)
        transcript.apply(runs: [Run(" Then")], start: 2.5, end: 70, isFinal: false)
        XCTAssertEqual(transcript.text, "Please open the tasks. Then")
        transcript.apply(runs: [Run(" Then review them.")], start: 69, end: 72, isFinal: true)
        XCTAssertEqual(transcript.text, "Please open the tasks. Then review them.")
        XCTAssertEqual(transcript.volatile, "")
    }

    func testWordsBeforeTheCutoffBelongToTheEarlierSegment() {
        var transcript = AnalyzerTranscript(cutoff: 10)
        // Entirely before: the old segment's final.
        XCTAssertFalse(transcript.apply(runs: [Run("sent already", start: 8)], start: 8, end: 9.9, isFinal: true))
        // Straddling: keep the words timed after the cutoff.
        transcript.apply(runs: [Run("sent", start: 9), Run(" "), Run("next", start: 10.2), Run(" words", start: 10.5)],
                         start: 9, end: 11, isFinal: false)
        XCTAssertEqual(transcript.text, "next words")
        // Untimed text from before the cutoff can't be split, so it goes.
        transcript.apply(runs: [Run("sent", start: 9), Run(" and")], start: 9, end: 9.8, isFinal: false)
        XCTAssertEqual(transcript.text, "")
        transcript.apply(runs: [Run("next words")], start: 10, end: 11, isFinal: true)
        XCTAssertEqual(transcript.text, "next words")
    }

    func testJoinKeepsOneSpaceAndNoneBeforePunctuation() {
        XCTAssertEqual(AnalyzerTranscript.join("", "  Hello"), "Hello")
        XCTAssertEqual(AnalyzerTranscript.join("Hello", "world"), "Hello world")
        XCTAssertEqual(AnalyzerTranscript.join("Hello ", " world"), "Hello world")
        XCTAssertEqual(AnalyzerTranscript.join("Hello", "  world"), "Hello world")
        XCTAssertEqual(AnalyzerTranscript.join("Hello", ", world"), "Hello, world")
        XCTAssertEqual(AnalyzerTranscript.join("Hello", ""), "Hello")
    }

    func testVocabularyHasTheAppNameProjectsAndReplacementTargets() throws {
        let suite = "speech-vocabulary-\(UUID().uuidString)"
        let defaults = try XCTUnwrap(UserDefaults(suiteName: suite))
        defer { defaults.removePersistentDomain(forName: suite) }
        SpeechSettings.rememberProjects(["ogrid", "m4l", "object-studio", "ogrid", "Phren"], in: defaults)
        XCTAssertEqual(defaults.stringArray(forKey: SpeechSettings.projectsKey), ["Phren", "m4l", "object-studio", "ogrid"])
        let vocabulary = SpeechSettings.vocabulary(in: defaults)
        XCTAssertEqual(vocabulary.first, "phren")
        XCTAssertFalse(vocabulary.contains("Phren"), "one spelling per word")
        XCTAssertTrue(vocabulary.contains("object studio"))
        XCTAssertTrue(vocabulary.contains("ogrid"))
    }
}

/// Runs recorded speech through the real `SpeechAnalyzer` pipeline: two
/// sentences with 65 seconds of room noise between them, fed faster than
/// real time. Nothing may be dropped or repeated across the pause.
@available(iOS 26.0, *)
final class AnalyzerPipelineFixtureTests: XCTestCase {
    func testLongPauseKeepsEveryWordOnce() async throws {
        let locale = Locale(identifier: "en-US")
        var modelLocale = await AnalyzerPipeline.installedLocale(for: locale)
        #if targetEnvironment(simulator)
        // The simulator lists the model but offers it no audio format.
        guard modelLocale != nil else { throw XCTSkip("SpeechAnalyzer's dictation model doesn't run in the simulator") }
        #endif
        if modelLocale == nil {
            AnalyzerPipeline.requestInstall(for: locale)
            for _ in 0..<30 where modelLocale == nil {
                try await Task.sleep(for: .seconds(2))
                modelLocale = await AnalyzerPipeline.installedLocale(for: locale)
            }
        }
        let installed = try XCTUnwrap(modelLocale, "the dictation model didn't install")

        let first = try Self.read("dictation-a")
        let second = try Self.read("dictation-b")
        let format = first.format
        let buffers = Self.chunks(first) + Self.noise(format, seconds: 65) + Self.chunks(second) + Self.noise(format, seconds: 2)
        let (audio, feed) = AsyncStream<AVAudioPCMBuffer>.makeStream()
        buffers.forEach { feed.yield($0) }
        feed.finish()

        let pipeline = AnalyzerPipeline(locale: installed)
        var transcript = AnalyzerTranscript()
        var finals = 0
        for try await piece in try await pipeline.start(audio: audio, format: format, vocabulary: ["phren", "ogrid", "mina", "atlas"]) {
            transcript.apply(runs: piece.runs, start: piece.start, end: piece.end, isFinal: piece.isFinal)
            if piece.isFinal { finals += 1 }
        }
        let text = transcript.text
        print("fixture transcript: \(text)")
        let words = text.lowercased().split { !$0.isLetter }.map(String.init)
        let script = ("please open the phren project and review the open tasks in the ogrid repository before lunch "
            + "then ask the conductor to summarize what changed in atlas and mina today").split(separator: " ").map(String.init)
        // Word for word, so nothing is dropped or repeated across the pause.
        // Synthetic voices say "phren" like "front" or "friend"; that slot
        // may hold any one word.
        XCTAssertEqual(words.count, script.count, "dropped or repeated words in: \(text)")
        for (heard, said) in zip(words, script) where said != "phren" {
            XCTAssertEqual(heard, said, "in: \(text)")
        }
        XCTAssertGreaterThanOrEqual(finals, 2, "the pause should settle the first sentence")
    }

    private static func read(_ name: String) throws -> AVAudioPCMBuffer {
        let url = try XCTUnwrap(Bundle(for: Self.self).url(forResource: name, withExtension: "wav"))
        let file = try AVAudioFile(forReading: url)
        let buffer = try XCTUnwrap(AVAudioPCMBuffer(pcmFormat: file.processingFormat, frameCapacity: AVAudioFrameCount(file.length)))
        try file.read(into: buffer)
        return buffer
    }

    /// Mic-sized pieces, as the tap delivers them.
    private static func chunks(_ buffer: AVAudioPCMBuffer, size: Int = 1024) -> [AVAudioPCMBuffer] {
        stride(from: 0, to: Int(buffer.frameLength), by: size).compactMap { offset in
            let count = min(size, Int(buffer.frameLength) - offset)
            guard let chunk = AVAudioPCMBuffer(pcmFormat: buffer.format, frameCapacity: AVAudioFrameCount(count)) else { return nil }
            chunk.frameLength = AVAudioFrameCount(count)
            memcpy(chunk.floatChannelData![0], buffer.floatChannelData![0] + offset, count * MemoryLayout<Float>.size)
            return chunk
        }
    }

    /// Quiet, deterministic room noise rather than digital silence.
    private static func noise(_ format: AVAudioFormat, seconds: Double) -> [AVAudioPCMBuffer] {
        guard let buffer = AVAudioPCMBuffer(pcmFormat: format, frameCapacity: AVAudioFrameCount(seconds * format.sampleRate)) else { return [] }
        buffer.frameLength = buffer.frameCapacity
        var seed: UInt32 = 1
        for index in 0..<Int(buffer.frameLength) {
            seed = seed &* 1_664_525 &+ 1_013_904_223
            buffer.floatChannelData![0][index] = (Float(seed >> 8) / Float(1 << 24) - 0.5) * 0.002
        }
        return chunks(buffer)
    }
}
