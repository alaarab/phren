import PhrenKit
import Foundation


struct ChatTimelineEntry: Identifiable, Equatable {
    enum Kind: Equatable { case message, activity, readRun }
    var messages: [AgentChatMessage]
    var kind: Kind = .message
    var phren: PhrenToolPresentation? = nil
    var id: String { messages[0].id }
    var isActivity: Bool { kind != .message }
    var isReadRun: Bool { kind == .readRun }

    static func group(_ messages: [AgentChatMessage], foldingReads: Bool = true) -> [Self] {
        var entries: [Self] = []
        var previousMessageID: String?
        var calls: [String: Int] = [:], ambiguous: Set<String> = []
        for message in messages {
            // Completion metadata feeds the pinned Background panel. It is
            // transport state, not another conversation card.
            if message.role == .tool, message.title == "Background notification" { continue }
            guard message.role == .tool else {
                entries.append(.init(messages: [message], kind: .message))
                // Phren's result may follow an assistant progress line. Keep
                // only its unanswered calls; ordinary tool grouping retains
                // the existing conversation barriers.
                calls = calls.filter { _, index in
                    PhrenToolPresentation.recognizes(entries[index].messages.first?.title)
                        && !entries[index].messages.contains(where: \.isToolResult)
                }
                ambiguous.formIntersection(calls.keys)
                previousMessageID = message.id
                continue
            }
            // A result — or what the call changed on disk — joins its call.
            if message.isToolResult || message.isChange {
                if let key = message.toolCallID, !key.isEmpty, !ambiguous.contains(key), let index = calls[key] {
                    entries[index].messages.append(message)
                    previousMessageID = message.id
                    continue
                }
                // Older transcripts lack IDs. Only pair an immediately adjacent,
                // unidentified call/result; never guess among parallel calls.
                if message.toolCallID == nil, let previous = entries.last,
                   previous.messages.count == 1, let call = previous.messages.first,
                   call.role == .tool, !call.isToolResult, call.toolCallID == nil,
                   call.id == previousMessageID {
                    entries[entries.count - 1].messages.append(message)
                    previousMessageID = message.id
                    continue
                }
            } else if let key = message.toolCallID, !key.isEmpty {
                if calls[key] != nil { ambiguous.insert(key) }
                else { calls[key] = entries.count }
            }
            entries.append(.init(messages: [message], kind: .activity))
            previousMessageID = message.id
        }
        for index in entries.indices {
            guard let call = entries[index].messages.first, PhrenToolPresentation.recognizes(call.title) else { continue }
            let result = entries[index].messages.first(where: \.isToolResult)
            entries[index].phren = PhrenToolPresentation(name: call.title ?? "", input: call.text, result: result?.text, isError: result?.isToolError == true)
        }
        return foldingReads ? foldReadRuns(entries) : entries
    }

    private static func foldReadRuns(_ entries: [Self]) -> [Self] {
        var result: [Self] = [], run: [Self] = []
        func flush() {
            if run.count >= 3 {
                result.append(.init(messages: run.flatMap(\.messages), kind: .readRun))
            } else { result.append(contentsOf: run) }
            run.removeAll(keepingCapacity: true)
        }
        for entry in entries {
            if entry.kind == .activity, ReadOnlyToolCall.isReadOnly(entry.messages) { run.append(entry) }
            else { flush(); result.append(entry) }
        }
        flush()
        return result
    }
}

/// Conservative classification: uncertain shell commands remain ordinary
/// cards. A call carrying a filesystem-change attachment can never be folded.
enum ReadOnlyToolCall {
    static func isReadOnly(_ messages: [AgentChatMessage]) -> Bool {
        guard !messages.contains(where: \.isChange), messages.contains(where: \.isToolResult),
              let call = messages.first(where: { $0.role == .tool && !$0.isToolResult }) else { return false }
        guard !PhrenToolPresentation.recognizes(call.title) else { return false }
        let presentation = ToolPresentationCache.value(call)
        switch presentation.title {
        case "Read", "Browse", "List": return true
        case "Shell": return shell(presentation.body)
        default:
            let raw = (call.title ?? "").split(separator: ".").last.map(String.init)?.lowercased() ?? ""
            return ["read", "glob", "grep", "ls"].contains(raw)
        }
    }

    static func shell(_ command: String) -> Bool {
        let source = command.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !source.isEmpty, !source.contains("\n"),
              source.range(of: #"(?:;|`|\$\(|>>?|<<|\b(?:rm|mv|cp|tee|touch|mkdir|ln|chmod|chown|install|xargs)\b|\bfind\b[^|]*(?:-delete|-exec)|\bgit\s+(?:commit|push|checkout|switch|restore|reset|clean|merge|rebase|pull|fetch|add|rm|mv|stash|apply)\b)"#,
                           options: [.regularExpression, .caseInsensitive]) == nil else { return false }
        let segments = source.components(separatedBy: "|").flatMap { $0.components(separatedBy: "&&") }
        return !segments.isEmpty && segments.allSatisfy { segment in
            let words = segment.trimmingCharacters(in: .whitespaces).split(whereSeparator: \.isWhitespace).map(String.init)
            guard let first = words.first?.lowercased() else { return false }
            if first == "git" { return words.count > 1 && ["diff", "log", "status", "show"].contains(words[1].lowercased()) }
            if first == "sed" { return words.dropFirst().contains { $0 == "-n" || ($0.hasPrefix("-") && $0.contains("n") && !$0.contains("i")) } }
            return ["cat", "head", "tail", "grep", "rg", "ls", "find", "wc", "echo", "pwd", "which", "type"].contains(first)
        }
    }
}

struct ChatBackgroundJob: Identifiable, Equatable {
    enum State: Equatable { case running, finished(exitCode: Int?) }
    let id: String
    let title: String
    let command: String
    let output: String
    let state: State
    let startedAt: Date
    let finishedAt: Date?
    /// Equality by what the row shows changing, not by the output text: the
    /// derived compare walked megabytes of Unicode on every SwiftUI update
    /// and iOS killed the app for hanging (watchdog, 2026-09-15 11:33).
    static func == (lhs: Self, rhs: Self) -> Bool {
        lhs.id == rhs.id && lhs.state == rhs.state && lhs.startedAt == rhs.startedAt && lhs.finishedAt == rhs.finishedAt
            && lhs.title == rhs.title && lhs.output.utf8.count == rhs.output.utf8.count && lhs.command.utf8.count == rhs.command.utf8.count
    }
}

enum ChatBackgroundJobs {
    /// How long a finished job stays in the row before it leaves.
    static let finishedLinger: TimeInterval = 120

    /// `firstSeen` / `finishedSeen`: when the phone first saw each job, and
    /// first saw it finished — the transcript carries no clock for either.
    static func parse(_ messages: [AgentChatMessage], firstSeen: [String: Date], finishedSeen: [String: Date] = [:], now: Date = .now, includeExpired: Bool = false) -> [ChatBackgroundJob] {
        var results: [String: AgentChatMessage] = [:]
        var notifications: [String: (summary: String, status: String, output: String, at: Date?)] = [:]
        for message in messages where message.role == .tool {
            if message.isToolResult, let id = message.toolCallID { results[id] = message }
            if message.title == "Background notification",
               let id = tag("tool-use-id", in: message.text) {
                notifications[id] = (tag("summary", in: message.text) ?? "Background command finished",
                                     tag("status", in: message.text) ?? "completed",
                                     tag("output", in: message.text) ?? "",
                                     message.timestamp)
            }
        }
        return messages.compactMap { message in
            guard message.role == .tool, !message.isToolResult, !message.isChange, let id = message.toolCallID else { return nil }
            let result = results[id]
            let resultText = result.map { ToolPresentationCache.value($0).body } ?? ""
            // A call flagged for the background, or one the agent moved there
            // after it outran its timeout.
            guard isBackground(message) || resultLooksBackgrounded(resultText) else { return nil }
            let presentation = ToolPresentationCache.value(message)
            let notification = notifications[id]
            let output = notification?.output.isEmpty == false ? notification!.output : resultText
            let summary = notification?.summary ?? presentation.preview
            let code = exitCode(notification?.summary) ?? exitCode(resultText)
            // The tool result of a background call arrives at once and only
            // says the job started; done means the task notification came,
            // or the result carried real output instead of that notice.
            let status = notification?.status.lowercased() ?? ""
            let finished = ["completed", "failed", "killed", "cancelled", "canceled", "stopped"].contains(status)
                || (result != nil && !resultText.isEmpty && !resultLooksBackgrounded(resultText))
            // The transcript's own clock first; the phone's first sighting
            // only when the source stamps nothing.
            let startedAt = message.timestamp ?? firstSeen[id] ?? now
            let finishedAt = finished ? (notification?.at ?? result?.timestamp ?? finishedSeen[id] ?? now) : nil
            // Finished jobs linger long enough to be read, then leave.
            if !includeExpired, let finishedAt, now.timeIntervalSince(finishedAt) > finishedLinger { return nil }
            return ChatBackgroundJob(id: id, title: summary.isEmpty ? "Background command" : summary,
                                     command: presentation.body, output: output,
                                     state: finished ? .finished(exitCode: code) : .running,
                                     startedAt: startedAt, finishedAt: finishedAt)
        }
    }

    /// Ids of jobs that are finished as of these messages, for the caller to
    /// stamp with the time it first saw them so.
    static func finishedIDs(_ messages: [AgentChatMessage], firstSeen: [String: Date]) -> Set<String> {
        Set(parse(messages, firstSeen: firstSeen, finishedSeen: [:], now: .now, includeExpired: true).filter { $0.state != .running }.map(\.id))
    }

    /// Claude Code's own notice, as the whole point of the result — not a
    /// command whose *output* merely mentions one (printing a task log, say).
    private static func resultLooksBackgrounded(_ text: String) -> Bool {
        let first = text.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
        return first.hasPrefix("command running in background with id")
            || first.range(of: #"^command did not complete within its \d+s timeout and was moved to the background"#, options: .regularExpression) != nil
    }

    static func backgroundIDs(_ messages: [AgentChatMessage]) -> Set<String> {
        Set(parse(messages, firstSeen: [:], finishedSeen: [:], now: .now, includeExpired: true).map(\.id))
    }
    /// Cheap first: a plain substring scan says no for almost every call
    /// before any regex runs. Four regexes over every tool call's text on
    /// each body evaluation hung the main thread for seconds on a big page
    /// (watchdog kills on 2026-09-15). Results are cached per message.
    private static let backgroundFlags = NSCache<NSString, NSNumber>()
    private static func isBackground(_ message: AgentChatMessage) -> Bool {
        let key = "\(message.id)|\(message.text.utf8.count)" as NSString
        if let cached = backgroundFlags.object(forKey: key) { return cached.boolValue }
        let value = computeIsBackground(message)
        backgroundFlags.setObject(NSNumber(value: value), forKey: key)
        return value
    }
    private static func computeIsBackground(_ message: AgentChatMessage) -> Bool {
        guard message.text.contains("background") || message.text.contains("yield_time") else { return false }
        guard ["shell", "tools"].contains(ToolPresentationCache.value(message).title.lowercased()) else { return false }
        let text = message.text.lowercased()
        return text.range(of: #"[\"']?run_in_background[\"']?\s*[:=]\s*true"#, options: .regularExpression) != nil
            || text.range(of: #"[\"']?background[\"']?\s*[:=]\s*true"#, options: .regularExpression) != nil
            || text.range(of: #"[\"']?yield_time-ms[\"']?\s*[:=]"#, options: .regularExpression) != nil
            || text.range(of: #"[\"']?yield_time_ms[\"']?\s*[:=]"#, options: .regularExpression) != nil
    }
    private static func tag(_ name: String, in text: String) -> String? {
        guard let open = text.range(of: "<\(name)>"), let close = text.range(of: "</\(name)>", range: open.upperBound..<text.endIndex) else { return nil }
        return String(text[open.upperBound..<close.lowerBound]).trimmingCharacters(in: .whitespacesAndNewlines)
    }
    private static func exitCode(_ text: String?) -> Int? {
        guard let text, let match = text.range(of: #"(?i)exit (?:code )?(-?\d+)"#, options: .regularExpression) else { return nil }
        return text[match].split(whereSeparator: { !$0.isNumber && $0 != "-" }).last.flatMap { Int($0) }
    }
}


struct ToolOutputPreview {
    let text: String
    let truncated: Bool
    init(_ output: String, lines maximumLines: Int = 6, characters: Int = 640) {
        let bounded = output.prefix(characters + 1)
        let prefix = String(bounded.prefix(characters))
        let lines = prefix.components(separatedBy: .newlines)
        let visible = lines.prefix(maximumLines).joined(separator: "\n")
        truncated = bounded.count > characters || lines.count > maximumLines
        text = visible + (truncated ? "…" : "")
    }
}

struct ChatToolSummary {
    let title: String
    let icon: String
    let preview: String
    let count: Int

    init(_ messages: [AgentChatMessage]) {
        // What a call changed on disk is listed under it, not counted as a call.
        let calls = messages.filter { $0.title != "Tool result" && !$0.isChange }
        let presentations = calls.map(ToolPresentationCache.value)
        let names = presentations.map(\.title)
        title = Set(names).count == 1 ? names[0] : calls.isEmpty ? "Tool results" : "Activity"
        icon = title == "Shell" ? "terminal" : title == "Browse" ? "globe" : title == "Patch" ? "pencil.line" : title == "Write" ? "doc.badge.plus" : "wrench.and.screwdriver"
        count = max(1, calls.isEmpty ? messages.count : calls.count)
        preview = presentations.last?.preview ?? messages.last.map { ToolPresentationCache.value($0).preview } ?? ""
    }
}
