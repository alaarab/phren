import CoreFoundation
import Foundation

/// Provider-reported usage for one model response, never inferred from words.
public struct AgentTokenUsage: Equatable, Sendable {
    public let input: Int
    public let output: Int
    public let cachedInput: Int?
    public let reasoningOutput: Int?
    public var uncachedInput: Int? { cachedInput.map { input - $0 } }

    static func read(_ value: [String: Any]?, inputIncludesCache: Bool = true) -> Self? {
        guard let value, let input = count(value["input_tokens"]), let output = count(value["output_tokens"]) else { return nil }
        let cached = count(value["cached_input_tokens"] ?? value["cache_read_input_tokens"])
        // Claude reports cache reads/writes separately; Codex includes them in input.
        let totalInput = inputIncludesCache ? input : input + (cached ?? 0) + (count(value["cache_creation_input_tokens"]) ?? 0)
        let reasoning = count(value["reasoning_output_tokens"])
        guard (cached ?? 0) <= totalInput, (reasoning ?? 0) <= output else { return nil }
        return .init(input: totalInput, output: output, cachedInput: cached, reasoningOutput: reasoning)
    }
    private static func count(_ value: Any?) -> Int? {
        guard let number = value as? NSNumber, CFGetTypeID(number) != CFBooleanGetTypeID(),
              number.doubleValue.isFinite, number.doubleValue >= 0, number.doubleValue <= 1_000_000_000_000,
              number.doubleValue.rounded(.down) == number.doubleValue else { return nil }
        return number.intValue
    }
}

public struct AgentChatProgressEvent: Equatable, Sendable {
    public enum Value: Equatable, Sendable {
        case started(Date?)
        case finished(Date?)
        case stopped
        case usage(AgentTokenUsage)
    }
    public let line: Int
    public let value: Value

    static func read(_ raw: [String: Any], source: String, line: Int) -> Self? {
        if source == "codex", raw["type"] as? String == "event_msg", let payload = raw["payload"] as? [String: Any] {
            switch payload["type"] as? String {
            case "task_started": return .init(line: line, value: .started(date(payload["started_at"], fallback: raw["timestamp"])))
            case "task_complete", "task_completed": return .init(line: line, value: .finished(date(payload["completed_at"], fallback: raw["timestamp"])))
            case "turn_aborted", "task_aborted": return .init(line: line, value: .stopped)
            case "token_count":
                let info = payload["info"] as? [String: Any]
                return AgentTokenUsage.read(info?["last_token_usage"] as? [String: Any]).map { .init(line: line, value: .usage($0)) }
            default: return nil
            }
        }
        if source == "claude", raw["isMeta"] as? Bool != true, raw["isSidechain"] as? Bool != true,
           let message = raw["message"] as? [String: Any], message["role"] as? String == "assistant" {
            return AgentTokenUsage.read(message["usage"] as? [String: Any], inputIncludesCache: false).map { .init(line: line, value: .usage($0)) }
        }
        if source == "copilot", raw["agentId"] == nil, let data = raw["data"] as? [String: Any] {
            switch raw["type"] as? String {
            case "assistant.turn_start": return .init(line: line, value: .started(date(nil, fallback: raw["timestamp"])))
            case "session.idle": return .init(line: line, value: data["aborted"] as? Bool == true ? .stopped : .finished(date(nil, fallback: raw["timestamp"])))
            case "abort": return .init(line: line, value: .stopped)
            case "assistant.usage":
                var counts: [String: Any] = [:]
                counts["input_tokens"] = data["inputTokens"]; counts["output_tokens"] = data["outputTokens"]
                counts["cached_input_tokens"] = data["cacheReadTokens"]
                return AgentTokenUsage.read(counts).map { .init(line: line, value: .usage($0)) }
            default: break
            }
        }
        return nil
    }
    private static func date(_ value: Any?, fallback: Any?) -> Date? {
        if let number = value as? Double, number.isFinite, number > 0, number < 100_000_000_000 { return Date(timeIntervalSince1970: number) }
        return ISO8601Dates.parse(fallback as? String)
    }
}

/// Absolute transcript lines prevent older pages/reconnects from replaying
/// turn starts or replacing current usage with an older response's counters.
public struct AgentChatProgress: Sendable {
    public enum Phase: Sendable { case working, finished, stopped }
    public private(set) var phase: Phase?
    public private(set) var startedAt: Date?
    public private(set) var finishedAt: Date?
    public private(set) var usage: AgentTokenUsage?
    public private(set) var activityLine = -1
    private var latestLine = -1
    private var totalLines = 0
    public init() {}

    public mutating func receive(_ frame: AgentChatTranscript) {
        guard frame.kind != .older else { return }
        if frame.kind == .backlog && frame.totalLines < totalLines { self = Self() }
        for event in frame.progressEvents.sorted(by: { $0.line < $1.line }) where event.line > latestLine {
            latestLine = event.line
            switch event.value {
            case .started(let date): phase = .working; startedAt = date; finishedAt = nil; usage = nil; activityLine = event.line
            case .finished(let date): phase = .finished; finishedAt = date; activityLine = event.line
            case .stopped: phase = .stopped; activityLine = event.line
            case .usage(let value): usage = value
            }
        }
        totalLines = max(totalLines, frame.totalLines)
    }
}
