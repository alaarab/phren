import Foundation

/// The words one dictation segment has heard from `SpeechAnalyzer`: its
/// finalized results in order, then the current volatile guess, which each
/// newer result replaces. The analyzer keeps running across segments, so
/// audio before `cutoff` (seconds on the analyzer's timeline) belongs to the
/// segment before this one and is dropped here.
struct AnalyzerTranscript: Equatable {
    /// A stretch of result text. `start` is its audio time when the engine
    /// attached one; spaces and punctuation usually have none.
    struct Run: Equatable {
        var text: String
        var start: Double?

        init(_ text: String, start: Double? = nil) {
            self.text = text
            self.start = start
        }
    }

    let cutoff: Double
    private(set) var finalized = ""
    private(set) var volatile = ""

    /// Timestamps are rounded to the model's frame, so allow a little slack.
    static let tolerance = 0.05

    init(cutoff: Double = 0) {
        self.cutoff = cutoff
    }

    var text: String { Self.join(finalized, volatile) }

    /// Returns whether the visible text changed.
    @discardableResult
    mutating func apply(runs: [Run], start: Double, end: Double, isFinal: Bool) -> Bool {
        let before = text
        let kept = end <= cutoff + Self.tolerance ? "" : Self.text(of: runs, from: start, after: cutoff)
        if isFinal {
            finalized = Self.join(finalized, kept)
            volatile = ""
        } else {
            volatile = kept
        }
        return text != before
    }

    /// A result that began before the cutoff still holds the old segment's
    /// words: keep only the runs from the first one timed after it.
    static func text(of runs: [Run], from start: Double, after cutoff: Double) -> String {
        guard start < cutoff - tolerance else { return runs.map(\.text).joined() }
        guard let first = runs.firstIndex(where: { ($0.start ?? -.infinity) >= cutoff - tolerance }) else {
            // Untimed text can't be split; one timed run before the cutoff
            // means the rest is old too.
            return runs.contains { $0.start != nil } ? "" : runs.map(\.text).joined()
        }
        return runs[first...].map(\.text).joined()
    }

    /// Results arrive as sentence pieces, some with their leading space and
    /// some without. Exactly one space between words, none before punctuation.
    static func join(_ base: String, _ addition: String) -> String {
        let trimmed = String(addition.drop(while: \.isWhitespace))
        guard !trimmed.isEmpty else { return base }
        if base.isEmpty || base.last?.isWhitespace == true { return base + trimmed }
        if let first = trimmed.first, ".,!?;:".contains(first) { return base + trimmed }
        return base + " " + trimmed
    }
}
