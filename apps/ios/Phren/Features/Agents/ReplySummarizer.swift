import Foundation
import FoundationModels
import PhrenKit

/// Turns an agent's reply into one or two plain sentences someone can hear:
/// Siri's answer from the conductor, a finished session's line on the Live
/// Activity, a long approval explanation. Talk mode can use the same one.
protocol ReplySummarizing: Sendable {
    /// Never throws and never returns an empty string for readable input:
    /// when the model is unavailable, slow or strays, the deterministic
    /// `ReplySummary.fallback` answers instead.
    func summarize(_ reply: String) async -> String?
}

/// Apple's on-device model when this phone has it, the deterministic
/// fallback otherwise. Short plain replies are returned as they are.
actor ReplySummarizer: ReplySummarizing {
    static let shared = ReplySummarizer()

    /// How long a caller waits for the model before the fallback answers.
    static let modelTimeout: Duration = .seconds(6)
    private let generator: (any ReplySummaryGenerating)?
    private var cache: [Int: String] = [:]

    init(generator: (any ReplySummaryGenerating)? = AppleReplySummaryGenerator()) { self.generator = generator }

    func summarize(_ reply: String) async -> String? {
        guard let fallback = ReplySummary.fallback(reply) else { return nil }
        guard ReplySummary.needsSummary(reply) else { return ReplySummary.plainText(reply) }
        let key = reply.hashValue
        if let cached = cache[key] { return cached }
        var result = fallback
        if let generator, await generator.isAvailable() {
            let bounded = String(reply.prefix(6_000))
            let generated = await Self.withTimeout(Self.modelTimeout) { try? await generator.summarize(bounded) }
            if let generated = generated.flatMap({ $0 }), let accepted = Self.accept(generated) { result = accepted }
        }
        cache[key] = result
        if cache.count > 64 { cache.removeAll() }
        return result
    }

    /// A model answer is used only when it is plain, short and nonempty.
    static func accept(_ generated: String) -> String? {
        let plain = ReplySummary.plainText(generated)
        guard !plain.isEmpty, plain.count <= ReplySummary.defaultLimit + 60 else { return nil }
        return plain
    }

    private static func withTimeout<T: Sendable>(_ timeout: Duration, _ work: @escaping @Sendable () async -> T) async -> T? {
        await withTaskGroup(of: T?.self) { group in
            group.addTask { await work() }
            group.addTask { try? await Task.sleep(for: timeout); return nil }
            let first = await group.next() ?? nil
            group.cancelAll()
            return first
        }
    }
}

protocol ReplySummaryGenerating: Sendable {
    func isAvailable() async -> Bool
    func summarize(_ reply: String) async throws -> String
}

@available(iOS 26.0, *)
@Generable
private struct GeneratedSpokenSummary {
    @Guide(description: "One or two short plain sentences, to be read aloud, saying what the agent did or needs")
    let spoken: String
}

struct AppleReplySummaryGenerator: ReplySummaryGenerating {
    func isAvailable() async -> Bool {
        guard #available(iOS 26.0, *) else { return false }
        return SystemLanguageModel.default.availability == .available
    }

    func summarize(_ reply: String) async throws -> String {
        guard #available(iOS 26.0, *), SystemLanguageModel.default.availability == .available else {
            throw OnDeviceGenerationError.unavailable
        }
        let session = LanguageModelSession(instructions: """
            Summarize a coding agent's reply so it can be spoken to its owner in one or two short sentences.
            Use only facts in the reply. Say what was done, what failed, or what the agent needs.
            No markdown, no code, no lists, no file paths unless the reply is about one file.
            """)
        return try await session.respond(to: "Reply:\n\(reply)", generating: GeneratedSpokenSummary.self)
            .content.spoken.trimmingCharacters(in: .whitespacesAndNewlines)
    }
}
