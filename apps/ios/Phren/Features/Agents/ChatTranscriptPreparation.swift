import Foundation
import PhrenKit

/// Work tied to transcript changes, never to scrolling, connection ticks, or
/// progressive text reveal. The model runs this value transform off-main.
struct ChatTranscriptPreparation {
    private(set) var entries: [ChatTimelineEntry] = []
    private(set) var jobs: [ChatBackgroundJob] = []
    private(set) var currentToolName: String?
    private(set) var currentToolDetail: String?
    private(set) var revision = 0
    private var keys: [Key] = []
    private var baseEntries: [ChatTimelineEntry] = []
    private var activityContext = ChatActivityContext()
    private var firstSeen: [String: Date] = [:]
    private var finishedSeen: [String: Date] = [:]
    /// Read-run rows are expensive to build (a second grouping pass plus a
    /// presentation read per call). They are keyed by the run's first message
    /// id and its last content revision, so an unchanged run is reused when a
    /// later message arrives.
    private var readRuns: [String: ChatReadRunPresentation] = [:]
    private struct Key: Equatable {
        let content: String; let timestamp: Date?; let failed: Bool; let queued: Bool; let queueKey: String?
        let images: [Int]; let results: [AgentChatMessage.ImageRef]; let call: String?
    }

    mutating func update(_ messages: [AgentChatMessage], activity: ChatActivityContext = .init(), at now: Date = .now) {
        let incoming = messages.map { Key(content: $0.renderKey, timestamp: $0.timestamp, failed: $0.isToolError, queued: $0.isQueued, queueKey: $0.queueKey, images: $0.imageBlocks, results: $0.resultImages, call: $0.toolCallID) }
        guard incoming != keys || activity != activityContext else { return }
        revision += 1
        activityContext = activity
        defer { entries = Self.attachingActivity(to: baseEntries, messages: messages, context: activity) }
        guard incoming != keys else { return }
        let started = ChatPerformance.begin()
        defer { ChatPerformance.end("transcript preparation", started) }
        keys = incoming
        entries = ChatTimelineEntry.group(messages)
        // Derived row work that must not run in a view body: the folded run's
        // inner cards, whether a folded patch needs the bounded accessibility
        // path, and the identifier and label a far-off screen placeholder keeps.
        for index in entries.indices {
            entries[index].hasLargeCollapsedChange = ChatTimelineEntry.largeCollapsedChange(entries[index].messages)
            if entries[index].isReadRun {
                let key = Self.readRunKey(entries[index].messages)
                let run = readRuns[key] ?? ChatReadRunPresentation(entries[index].messages)
                readRuns[key] = run
                entries[index].readRun = run
            }
        }
        let liveReadRuns = Set(entries.filter(\.isReadRun).map { Self.readRunKey($0.messages) })
        readRuns = readRuns.filter { liveReadRuns.contains($0.key) }
        for index in entries.indices {
            entries[index].placeholderIdentifier = Self.placeholderIdentifier(entries[index])
            entries[index].placeholderLabel = Self.placeholderLabel(entries[index])
        }
        for message in messages where message.role != .tool {
            let inline = !message.imageBlocks.isEmpty || !message.uploadImages.isEmpty
            let text = ChatMessageDisplayCache.text(for: message, imagePaths: [], hasImages: false, inlineImages: inline)
            let preview = ToolOutputPreview(text, lines: 40, characters: 6_000)
            _ = ChatRichTextDocumentCache.value(preview.text, key: "\(message.renderKey)|\(inline)|[]|-1")
        }
        // A card's markdown — an agent's report, a plan — parsed here, off-main.
        for entry in entries {
            if let preview = entry.card?.markdownPreview { _ = ChatRichTextDocumentCache.value(preview.text, key: entry.cardMarkdownKey) }
        }
        jobs = ChatBackgroundJobs.parse(messages, firstSeen: firstSeen, finishedSeen: finishedSeen,
                                        now: now, includeExpired: true)
        for job in jobs {
            firstSeen[job.id] = job.startedAt
            if let date = job.finishedAt { finishedSeen[job.id] = date }
        }
        let retained = Set(jobs.map(\.id))
        firstSeen = firstSeen.filter { retained.contains($0.key) }
        finishedSeen = finishedSeen.filter { retained.contains($0.key) }
        var completed: Set<String> = []
        currentToolName = nil; currentToolDetail = nil
        for message in messages.reversed() where message.role == .tool {
            if message.isToolResult { if let id = message.toolCallID { completed.insert(id) } }
            else if !message.isChange, !message.isCompaction, message.title != "Background notification",
                    message.toolCallID.map({ !completed.contains($0) }) ?? true {
                currentToolName = message.title
                // The card's own short read of the input: a command's first
                // line, or a file path. Cheap and off-main, same as the card.
                currentToolDetail = message.title.map { ToolPresentation(title: $0, text: message.text).preview }
                break
            }
        }
        baseEntries = entries
    }

    /// The content revision of a folded run: its first message id and the last
    /// renderKey change when any call inside it changed.
    static func readRunKey(_ messages: [AgentChatMessage]) -> String {
        "\(messages.first?.id ?? "")|\(messages.count)|\(messages.last?.renderKey ?? "")"
    }

    /// The identifier a far-off screen placeholder keeps — the same one the
    /// row's own container carries when it is drawn in full.
    static func placeholderIdentifier(_ entry: ChatTimelineEntry) -> String {
        if let first = entry.messages.first, first.isCompaction { return "chat-compaction" }
        if entry.phren != nil { return "chat-phren-card:\(entry.callID)" }
        if let card = entry.card {
            switch card {
            case .agent: return "chat-agent-card:\(entry.callID)"
            case .todos: return "chat-todo-card:\(entry.callID)"
            case .plan, .planMode: return "chat-plan-card:\(entry.callID)"
            case .web: return "chat-web-card:\(entry.callID)"
            case .skill: return "chat-skill-chip:\(entry.callID)"
            case .mcp: return "chat-mcp-card:\(entry.callID)"
            }
        }
        if entry.isReadRun { return "chat-read-run:\(entry.messages[0].id)" }
        if entry.isActivity { return "chat-tool-group:\(entry.messages[0].id)" }
        if let message = entry.messages.first {
            if message.localCommand != nil { return "chat-command:\(message.id)" }
            if message.isNarration { return "chat-narration:\(message.id)" }
            return "chat-message:\(message.id)"
        }
        return ""
    }

    /// The one-line label the placeholder reads as; no rich subtree, no
    /// paragraph, patch file or tool-output identifiers behind it.
    static func placeholderLabel(_ entry: ChatTimelineEntry) -> String {
        if let message = entry.messages.first, message.isCompaction {
            return message.text.isEmpty ? "Conversation compacted" : "Conversation compacted: \(message.text)"
        }
        if let phren = entry.phren {
            return [phren.verb, phren.project, phren.tag].compactMap { $0 }.joined(separator: ", ")
        }
        if let card = entry.card { return card.offScreenLabel(callID: entry.callID) }
        if entry.isReadRun, let run = entry.readRun {
            return run.spokenLabel
        }
        if entry.isActivity {
            let summary = ChatToolSummary(entry.messages)
            return "\(summary.title), \(summary.count) \(summary.count == 1 ? "operation" : "operations")"
        }
        if let message = entry.messages.first {
            if let command = message.localCommand {
                return command.kind == .output ? "Command output: \(command.text)" : "Command: \(command.text)"
            }
            if message.isNarration { return "Thinking: \(ToolOutputPreview(message.text, lines: 4, characters: 400).text)" }
            let role = message.role == .user ? "Your message" : "Agent reply"
            let body = ToolOutputPreview(message.text, lines: 40, characters: 6_000).text
            return body.isEmpty ? role : "\(role): \(body)"
        }
        return ""
    }
}
