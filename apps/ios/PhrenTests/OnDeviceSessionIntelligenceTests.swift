import XCTest
@testable import Phren

final class OnDeviceSessionIntelligenceTests: XCTestCase {
    actor FakeGenerator: OnDeviceSessionGenerating {
        let available: Bool
        let summary: AwaySummary
        let cleanup: String
        private(set) var summaryPrompts: [String] = []
        private(set) var cleanupInputs: [String] = []

        init(available: Bool = true,
             summary: AwaySummary = .init(summary: "Tests passed.", currentState: "done", blockers: [], suggestedNextStep: "Review the diff."),
             cleanup: String = "Tell Mina to run the tests, then push.") {
            self.available = available
            self.summary = summary
            self.cleanup = cleanup
        }

        func isAvailable() async -> Bool { available }
        func summarize(prompt: String) async throws -> AwaySummary {
            summaryPrompts.append(prompt)
            return summary
        }
        func cleanDictation(_ raw: String) async throws -> String {
            cleanupInputs.append(raw)
            return cleanup
        }
        func summaryCallCount() -> Int { summaryPrompts.count }
        func cleanupCallCount() -> Int { cleanupInputs.count }
    }

    func testAwaySummaryDecodesAndFormatsAllFields() throws {
        let data = Data(#"{"summary":"The focused tests pass.","currentState":"waiting","blockers":["Push needs approval"],"suggestedNextStep":"Approve the push."}"#.utf8)
        let summary = try JSONDecoder().decode(AwaySummary.self, from: data)
        XCTAssertEqual(summary.summary, "The focused tests pass.")
        XCTAssertEqual(summary.blockers, ["Push needs approval"])
        XCTAssertEqual(summary.formatted,
                       "The focused tests pass. State: waiting. Blockers: Push needs approval. Next: Approve the push.")
        XCTAssertEqual(try JSONDecoder().decode(AwaySummary.self, from: JSONEncoder().encode(summary)), summary)
    }

    func testPromptUsesFortyMessageTailAndTruncatesToolOutput() {
        var messages = (0..<44).map {
            SessionTranscriptLine(role: "assistant", title: nil, text: "message-\($0)")
        }
        messages.append(.init(role: "tool", title: "Shell", text: String(repeating: "x", count: 2_000)))
        let prompt = SessionSummaryPrompt.make(project: "phren", computer: "Mini", state: "working", messages: messages)
        XCTAssertFalse(prompt.contains("assistant: message-0\n\n"))
        XCTAssertFalse(prompt.contains("assistant: message-4\n\n"))
        XCTAssertTrue(prompt.contains("assistant: message-5\n\n"))
        XCTAssertTrue(prompt.contains("tool (Shell): " + String(repeating: "x", count: SessionSummaryPrompt.maximumToolCharacters) + "…"))
        XCTAssertLessThanOrEqual(prompt.count, SessionSummaryPrompt.maximumPromptCharacters)
    }

    func testCacheIsPerSessionAndReusesFreshSummary() async throws {
        let fake = FakeGenerator()
        let cache = AwaySummaryCache(generator: fake)
        let now = Date(timeIntervalSince1970: 1_000)
        _ = try await cache.generate(for: "one", prompt: "first", now: now)
        _ = try await cache.generate(for: "one", prompt: "ignored", now: now.addingTimeInterval(30))
        _ = try await cache.generate(for: "two", prompt: "second", now: now.addingTimeInterval(30))
        let callCount = await fake.summaryCallCount()
        let first = await cache.cached(for: "one", now: now.addingTimeInterval(60))
        let expired = await cache.cached(for: "one", now: now.addingTimeInterval(AwaySummaryCache.freshness + 1))
        let second = await cache.cached(for: "two", now: now.addingTimeInterval(60))
        XCTAssertEqual(callCount, 2)
        XCTAssertNotNil(first)
        XCTAssertNil(expired)
        XCTAssertNotNil(second)
    }

    func testCleanupUsesInjectedGeneratorAndPreservesSequentialResult() async throws {
        let fake = FakeGenerator()
        let result = try await DictationCleanupService.clean("tell mina run tests then push", using: fake)
        let callCount = await fake.cleanupCallCount()
        XCTAssertEqual(result, "Tell Mina to run the tests, then push.")
        XCTAssertEqual(callCount, 1)
    }

    func testCleanupSettingDefaultsOff() {
        let suite = "OnDeviceSessionIntelligenceTests.\(UUID().uuidString)"
        let defaults = UserDefaults(suiteName: suite)!
        defer { defaults.removePersistentDomain(forName: suite) }
        XCTAssertFalse(SpeechSettings.cleanupEnabled(in: defaults))
        defaults.set(true, forKey: SpeechSettings.cleanupKey)
        XCTAssertTrue(SpeechSettings.cleanupEnabled(in: defaults))
    }
}
